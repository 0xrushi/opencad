"""Render native CAD source in a limited subprocess, returning STL/STEP bytes."""

import ast
import base64
import contextlib
import io
import json
import math
import resource
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # `-I` drops the script directory


def limits():
    resource.setrlimit(resource.RLIMIT_CPU, (45, 45))
    resource.setrlimit(resource.RLIMIT_AS, (4 * 1024**3, 4 * 1024**3))
    resource.setrlimit(resource.RLIMIT_FSIZE, (20 * 1024**2, 20 * 1024**2))


def cadquery_shape(source):
    import cadquery as cq

    tree = ast.parse(source)
    allowed = (
        ast.Module, ast.Assign, ast.Expr, ast.Import, ast.Name, ast.Load,
        ast.Store, ast.Call, ast.Attribute, ast.Constant, ast.List, ast.Tuple,
        ast.Dict, ast.keyword, ast.BinOp, ast.UnaryOp, ast.Add, ast.Sub,
        ast.Mult, ast.Div, ast.Pow, ast.USub, ast.UAdd, ast.Mod, ast.FloorDiv,
        ast.Subscript, ast.Slice, ast.alias,
    )
    for node in ast.walk(tree):
        if not isinstance(node, allowed):
            raise ValueError(f"unsupported CadQuery syntax: {type(node).__name__}")
        if isinstance(node, ast.Import):
            if any(alias.name != "cadquery" for alias in node.names):
                raise ValueError("only cadquery imports are supported")
        if isinstance(node, ast.Name) and (
            node.id.startswith("_") or node.id in {"open", "eval", "exec", "compile", "globals", "locals"}
        ):
            raise ValueError("unsafe CadQuery name")
        if isinstance(node, ast.Attribute) and (
            node.attr.startswith("_") or node.attr in {"exporters", "importers"}
        ):
            raise ValueError("unsafe CadQuery attribute")

    tree.body = [node for node in tree.body if not isinstance(node, ast.Import)]
    namespace = {"cq": cq, "cadquery": cq, "math": math, "__builtins__": {}}
    exec(compile(tree, "<cadquery>", "exec"), namespace, namespace)
    for name in ("solid", "result", "model", "part"):
        value = namespace.get(name)
        if isinstance(value, (cq.Workplane, cq.Shape)):
            return value
    for value in reversed(list(namespace.values())):
        if isinstance(value, (cq.Workplane, cq.Shape)):
            return value
    raise ValueError("CadQuery code did not create a shape")


def sequence_shape(source):
    import cadquery as cq
    sys.path.insert(0, "/opt/cad-editor/utils")
    from parse_seq2obj import CADparser

    with contextlib.redirect_stdout(io.StringIO()):
        stages = CADparser(bit=6).perform(source)
    if not stages:
        raise ValueError("CAD sequence could not be parsed")
    current = None
    for stage in stages:
        vertices = [
            tuple(map(float, line.split()[1:3]))
            for line in stage["vertex"].splitlines()
            if line.startswith("v ")
        ]
        extrude = stage["extrude"]
        rotation = list(map(float, extrude["R"]))
        origin = list(map(float, extrude["T"]))
        plane = cq.Plane(
            origin=tuple(origin),
            xDir=tuple(rotation[:3]),
            normal=tuple(rotation[6:9]),
        )
        start, end = map(float, extrude["value"])
        plane.origin = plane.origin + plane.zDir.multiply(start)
        drawing = cq.Workplane(plane)
        for raw in stage["curve"].splitlines():
            line = raw.strip()
            if not line or line in ("face", "out", "in"):
                if line in ("out", "in"):
                    drawing = drawing.close() if drawing.ctx.pendingEdges else drawing
                continue
            pieces = line.split()
            if pieces[0] == "l":
                first, last = vertices[int(pieces[1])], vertices[int(pieces[2])]
                if not drawing.ctx.pendingEdges:
                    drawing = drawing.moveTo(*first)
                drawing = drawing.lineTo(*last)
            elif pieces[0] == "a":
                first, middle, last = (
                    vertices[int(pieces[index])] for index in (1, 2, 4)
                )
                if not drawing.ctx.pendingEdges:
                    drawing = drawing.moveTo(*first)
                drawing = drawing.threePointArc(middle, last)
            elif pieces[0] == "c":
                center = vertices[int(pieces[1])]
                radius = vertices[int(pieces[2])][0]
                drawing = drawing.center(*center).circle(radius).center(-center[0], -center[1])
            else:
                raise ValueError("unsupported CAD curve")
        if drawing.ctx.pendingEdges:
            drawing = drawing.close()
        shape = drawing.extrude(end - start)
        operation = int(extrude["op"])
        if current is None or operation == 1:
            current = shape if current is None else current.union(shape)
        elif operation == 2:
            current = current.cut(shape)
        elif operation == 3:
            current = current.intersect(shape)
    if current is None:
        raise ValueError("CAD sequence produced no shape")
    return current


def solids_of(shape):
    values = shape.vals() if hasattr(shape, "vals") else [shape]
    return [solid for value in values for solid in value.Solids()]


def rebuild(solids):
    import cadquery as cq

    if not solids:
        raise ValueError("the operation removed the whole part")
    return cq.Workplane().add(solids)


def op_scale(shape, op):
    import cadquery as cq

    origin = cq.Vector(*op["origin"])
    factor = op.get("factor")
    if not factor or factor <= 0:
        raise ValueError("the scale factor must be positive")
    return rebuild(
        [s.translate(origin * -1).scale(factor).translate(origin) for s in solids_of(shape)]
    )


def op_translate(shape, op):
    import cadquery as cq

    vector = cq.Vector(*op["vector"])
    return rebuild([s.translate(vector) for s in solids_of(shape)])


def op_mirror(shape, op):
    import cadquery as cq

    solids = solids_of(shape)
    normal = cq.Vector(*op["normal"])
    origin = cq.Vector(*op["origin"])
    mirrored = [s.mirror(normal, origin) for s in solids]
    fused = cq.Compound.makeCompound(solids).fuse(*mirrored).clean()
    return cq.Workplane().add(fused)


def match_edges(solids, points):
    """Find the kernel edge nearest each requested point (a point lying on the edge)."""
    import cadquery as cq

    size = max(s.BoundingBox().DiagonalLength for s in solids)
    tolerance = size * 0.03
    chosen = []
    for raw in points:
        target = cq.Vector(*raw)
        best, best_distance = None, None
        for solid in solids:
            for edge in solid.Edges():
                distance = min(
                    (edge.positionAt(t / 12) - target).Length for t in range(13)
                )
                if best_distance is None or distance < best_distance:
                    best, best_distance = (solid, edge), distance
        if best is None or best_distance > tolerance:
            raise ValueError("a selected edge no longer exists on the part")
        chosen.append(best)
    return chosen


def op_edge_blend(shape, op):
    solids = solids_of(shape)
    amount = op.get("radius") if op["type"] == "fillet" else op.get("distance")
    if not amount or amount <= 0:
        raise ValueError(f"the {op['type']} size must be positive")
    chosen = match_edges(solids, op["points"])
    result = []
    for solid in solids:
        edges = [e for s, e in chosen if s.isSame(solid)]
        if not edges:
            result.append(solid)
            continue
        try:
            if op["type"] == "fillet":
                result.append(solid.fillet(amount, edges))
            else:
                result.append(solid.chamfer(amount, None, edges))
        except Exception as error:
            raise ValueError(
                f"the {op['type']} of {amount} does not fit these edges; try a smaller size"
            ) from error
    return rebuild(result)


def op_stretch(shape, op):
    """Change the distance between two parallel faces by `distance` along `normal`.

    The part is split at `origin`; the far side is moved and the gap is filled by
    extruding the cross-section (or, when shrinking, a slab is removed).
    """
    import cadquery as cq

    normal = cq.Vector(*op["normal"]).normalized()
    origin = cq.Vector(*op["origin"])
    amount = op.get("distance")
    if not amount:
        raise ValueError("the stretch distance must not be zero")
    solids = solids_of(shape)
    size = max(s.BoundingBox().DiagonalLength for s in solids)
    reach = size * 4 + 1
    whole = cq.Workplane().add(solids)

    def half(point, sign):
        plane = cq.Plane(origin=point, normal=normal)
        box = cq.Workplane(plane).rect(reach, reach).extrude(reach * sign)
        return solids_of(whole.intersect(box))

    if amount > 0:
        far, near = half(origin, 1), half(origin, -1)
        if not far or not near:
            raise ValueError("the stretch plane does not pass through the part")
        sections = [
            face
            for solid in far
            for face in solid.Faces()
            if abs((face.Center() - origin).dot(normal)) < size * 1e-6
            and abs(face.normalAt().dot(normal)) > 0.999
        ]
        bridge = [cq.Solid.extrudeLinear(face, normal * amount) for face in sections]
        moved = [solid.translate(normal * amount) for solid in far]
        fused = cq.Compound.makeCompound(near).fuse(*bridge, *moved).clean()
    else:
        gap = -amount
        low = origin - normal * (gap / 2)
        high = origin + normal * (gap / 2)
        near, far = half(low, -1), half(high, 1)
        if not far or not near:
            raise ValueError("the part is not thick enough to shrink by that much")
        moved = [solid.translate(normal * amount) for solid in far]
        fused = cq.Compound.makeCompound(near).fuse(*moved).clean()
    return rebuild(solids_of(cq.Workplane().add(fused)))


def _axis(face):
    """(point on axis, unit direction) of a cylindrical or conical face, else None."""
    import cadquery as cq
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Cone, GeomAbs_Cylinder

    surface = BRepAdaptor_Surface(face.wrapped)
    kind = surface.GetType()
    if kind == GeomAbs_Cylinder:
        axis = surface.Cylinder().Axis()
    elif kind == GeomAbs_Cone:
        axis = surface.Cone().Axis()
    else:
        return None
    location, direction = axis.Location(), axis.Direction()
    return (
        cq.Vector(location.X(), location.Y(), location.Z()),
        cq.Vector(direction.X(), direction.Y(), direction.Z()).normalized(),
    )


def _face_normal(face, point=None):
    if point is not None:
        try:
            return face.normalAt(point)
        except Exception:
            pass
    u0, u1, v0, v1 = face._uvBounds()
    return face.normalAt((u0 + u1) / 2, (v0 + v1) / 2)[0]


def _on_face(face, point):
    """Whether a point (almost on the surface) lies inside the trimmed face."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
    from OCP.TopAbs import TopAbs_IN
    from OCP.gp import gp_Pnt, gp_Pnt2d

    try:
        projected = GeomAPI_ProjectPointOnSurf(
            gp_Pnt(point.x, point.y, point.z), BRep_Tool.Surface_s(face.wrapped)
        )
        u, v = projected.LowerDistanceParameters()
        classifier = BRepClass_FaceClassifier()
        classifier.Perform(face.wrapped, gp_Pnt2d(u, v), 1e-6)
        return classifier.State() == TopAbs_IN
    except Exception:
        return False


def _dihedral(faces, i, edge, j, size):
    """Symmetric edge kind between faces i and j: >0 concave, ~0 tangent, <0 convex."""
    middle = edge.positionAt(0.5)
    tangent = edge.tangentAt(0.5).normalized()  # closed circles have equal end points
    n_i = _face_normal(faces[i], middle)
    n_j = _face_normal(faces[j], middle)
    side = n_j.cross(tangent)
    if side.Length < 1e-9:
        return 0.0
    side = side.normalized()
    delta = size * 1e-3
    for _ in range(4):
        plus = _on_face(faces[j], middle + side * delta)
        minus = _on_face(faces[j], middle - side * delta)
        if plus != minus:
            return (side if plus else side * -1).dot(n_i)
        delta /= 4
    return 0.0


def op_fill(shape, op, preview=False):
    """Fill cavities (holes, pockets, slots, undercuts) at the given points.

    Two ways of finding the cavity's faces, then the kernel removes them and
    heals the surrounding surfaces:
      * round holes: the coaxial cylindrical/conical wall faces (countersinks too);
      * anything else: every face reachable from the selection across concave or
        tangent edges, which stops at the convex rim where the cavity meets the
        outside of the part.
    """
    import cadquery as cq
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Defeaturing

    solids = solids_of(shape)
    if len(solids) != 1:
        raise ValueError("filling a cavity needs a single solid; undo the split first")
    solid = solids[0]
    faces = solid.Faces()
    size = solid.BoundingBox().DiagonalLength
    reach = size * 0.01

    owners = {}
    for index, face in enumerate(faces):
        for edge in face.Edges():
            owners.setdefault(edge.hashCode(), []).append(index)

    def hole_like(face):
        """A hole wall faces toward its axis; an outer round faces away from it."""
        axis = _axis(face)
        if axis is None:
            return False
        base, direction = axis
        u0, u1, v0, v1 = face._uvBounds()
        normal, position = face.normalAt((u0 + u1) / 2, (v0 + v1) / 2)
        offset = base - position
        radial = offset - direction * offset.dot(direction)
        return normal.dot(radial) > 0

    def coaxial_region(seeds):
        found = set()
        for seed in seeds:
            base, direction = _axis(faces[seed])
            queue = [seed]
            while queue:
                current = queue.pop()
                if current in found:
                    continue
                found.add(current)
                for edge in faces[current].Edges():
                    for neighbour in owners.get(edge.hashCode(), []):
                        other = _axis(faces[neighbour])
                        if neighbour in found or other is None:
                            continue
                        gap = other[0] - base
                        off_axis = (gap - direction * gap.dot(direction)).Length
                        if abs(other[1].dot(direction)) > 0.999 and off_axis < size * 1e-3:
                            queue.append(neighbour)
        return found

    def cavity_region(seeds):
        found = set(seeds)
        queue = list(seeds)
        while queue:
            current = queue.pop()
            for edge in faces[current].Edges():
                for neighbour in owners.get(edge.hashCode(), []):
                    if neighbour in found or neighbour == current:
                        continue
                    if _dihedral(faces, current, edge, neighbour, size) > -0.05:
                        found.add(neighbour)
                        queue.append(neighbour)
        return found

    def concave_neighbour(index):
        for edge in faces[index].Edges():
            for neighbour in owners.get(edge.hashCode(), []):
                if neighbour != index and _dihedral(faces, index, edge, neighbour, size) > 0.05:
                    return True
        return False

    def find_region():
        chosen = set()
        for raw in op["points"]:
            near = [
                i
                for i, face in enumerate(faces)
                if face.distance(cq.Vertex.makeVertex(*raw)) <= reach
            ]
            round_seeds = [i for i in near if _axis(faces[i]) is not None and hole_like(faces[i])]
            if round_seeds:
                chosen |= coaxial_region(round_seeds)
                continue
            cavity_seeds = [i for i in near if concave_neighbour(i)]
            if not cavity_seeds:
                raise ValueError("no cavity was found at the selected location")
            found = cavity_region(cavity_seeds)
            if len(found) > max(12, len(faces) * 0.6):
                raise ValueError("the selection does not enclose a cavity (it spreads over most of the part)")
            chosen |= found
        return chosen

    chosen = find_region()
    if preview:
        return solid, faces, chosen

    def leftovers(result):
        """Cavity faces whose surface is still part of the boundary of the result."""
        count = 0
        for index in chosen:
            u0, u1, v0, v1 = faces[index]._uvBounds()
            _, position = faces[index].normalAt((u0 + u1) / 2, (v0 + v1) / 2)
            point = cq.Vertex.makeVertex(position.x, position.y, position.z)
            if any(face.distance(point) < reach * 0.1 for face in result.Faces()):
                count += 1
        return count

    def defeatured():
        defeature = BRepAlgoAPI_Defeaturing()
        defeature.SetShape(solid.wrapped)
        for index in chosen:
            defeature.AddFaceToRemove(faces[index].wrapped)
        defeature.SetRunParallel(False)
        defeature.Build()
        if not defeature.IsDone():
            return None
        return cq.Shape.cast(defeature.Shape())

    def capped():
        """Fallback: close the cavity's opening with a cap and fuse the void solid in."""
        from OCP.ShapeAnalysis import ShapeAnalysis_FreeBounds
        from OCP.ShapeFix import ShapeFix_Solid
        from OCP.TopTools import TopTools_HSequenceOfShape
        from OCP.TopoDS import TopoDS

        rim = []
        for index in chosen:
            for edge in faces[index].Edges():
                if any(n not in chosen for n in owners.get(edge.hashCode(), [])):
                    rim.append(edge)
        if not rim:
            return None
        sequence = TopTools_HSequenceOfShape()
        for edge in rim:
            sequence.Append(edge.wrapped)
        wires = TopTools_HSequenceOfShape()
        ShapeAnalysis_FreeBounds.ConnectEdgesToWires_s(sequence, size * 1e-4, False, wires)
        caps = []
        for i in range(1, wires.Length() + 1):
            wire = cq.Wire(TopoDS.Wire_s(wires.Value(i)))
            try:
                cap = cq.Face.makeFromWires(wire)
                flat = cap.isValid() and cap.Area() > 0
            except Exception:
                flat = False
            if not flat:
                cap = cq.Face.makeNSidedSurface(wire.Edges(), [])
            caps.append(cap)
        shell = cq.Shell.makeShell([faces[i] for i in chosen] + caps)
        void = cq.Solid.makeSolid(shell)
        fixer = ShapeFix_Solid(void.wrapped)
        fixer.Perform()  # makes the shell's orientation consistent and outward
        void = cq.Solid(fixer.Solid())
        if void.Volume() < 0:
            void = cq.Solid(void.wrapped.Reversed())
        if not void.isValid() or void.Volume() < 1e-9:
            return None
        return solid.fuse(void).clean()

    attempts = []
    result = None
    for name, build in (("defeaturing", defeatured), ("capping", capped)):
        try:
            candidate = build()
        except Exception as error:
            attempts.append(f"{name}: {error}")
            continue
        if candidate is None or not candidate.isValid() or candidate.Volume() <= solid.Volume() + 1e-9:
            detail = "" if candidate is None else f", valid={candidate.isValid()}, volume={candidate.Volume():.1f}"
            attempts.append(f"{name}: no valid larger solid{detail}")
            continue
        left = leftovers(candidate)
        if left:
            attempts.append(f"{name}: {left} cavity face(s) still left")
            continue
        result = candidate
        break
    if result is None:
        raise ValueError("the cavity could not be filled completely (" + "; ".join(attempts) + ")")
    return rebuild(solids_of(result))


def op_remove(shape, op, preview=False):
    """Remove a feature that stands out of or blends into the part.

    A boss (faces that meet the rest of the part along a concave rim) is removed
    whole; a fillet, chamfer or other single blend face is removed on its own so
    the neighbouring faces extend to meet. The kernel heals the result."""
    import cadquery as cq
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Defeaturing

    solids = solids_of(shape)
    if len(solids) != 1:
        raise ValueError("removing a feature needs a single solid; undo the split first")
    solid = solids[0]
    faces = solid.Faces()
    size = solid.BoundingBox().DiagonalLength
    reach = size * 0.01
    owners = {}
    for index, face in enumerate(faces):
        for edge in face.Edges():
            owners.setdefault(edge.hashCode(), []).append(index)

    def concave(index):
        return any(
            neighbour != index and _dihedral(faces, index, edge, neighbour, size) > 0.05
            for edge in faces[index].Edges()
            for neighbour in owners.get(edge.hashCode(), [])
        )

    chosen = set()
    for raw in op["points"]:
        near = [i for i, face in enumerate(faces) if face.distance(cq.Vertex.makeVertex(*raw)) <= reach]
        if not near:
            raise ValueError("no face was found at the selected location")
        seed = min(near, key=lambda i: faces[i].distance(cq.Vertex.makeVertex(*raw)))
        if not concave(seed):
            chosen.add(seed)  # a lone blend face such as a fillet or chamfer
            continue
        found, queue = {seed}, [seed]
        while queue:
            current = queue.pop()
            for edge in faces[current].Edges():
                for neighbour in owners.get(edge.hashCode(), []):
                    if neighbour in found or neighbour == current:
                        continue
                    # Stay on the feature: stop at the concave rim where it meets the part.
                    if _dihedral(faces, current, edge, neighbour, size) <= 0.05:
                        found.add(neighbour)
                        queue.append(neighbour)
        if len(found) > max(12, len(faces) * 0.6):
            raise ValueError("the selection is not a separate feature (it spreads over most of the part)")
        chosen |= found
    if preview:
        return solid, faces, chosen
    defeature = BRepAlgoAPI_Defeaturing()
    defeature.SetShape(solid.wrapped)
    for index in chosen:
        defeature.AddFaceToRemove(faces[index].wrapped)
    defeature.SetRunParallel(False)
    defeature.Build()
    if not defeature.IsDone():
        raise ValueError("the feature could not be removed")
    result = cq.Shape.cast(defeature.Shape())
    if not result.isValid() or abs(result.Volume() - solid.Volume()) < 1e-9:
        raise ValueError("removing it made no change; the selection is not a removable feature")
    return rebuild(solids_of(result))


def _hole_like(face):
    """A hole wall faces toward its axis; an outer round faces away from it."""
    axis = _axis(face)
    if axis is None:
        return False
    base, direction = axis
    u0, u1, v0, v1 = face._uvBounds()
    normal, position = face.normalAt((u0 + u1) / 2, (v0 + v1) / 2)
    offset = base - position
    radial = offset - direction * offset.dot(direction)
    return normal.dot(radial) > 0


def _delete_kind(solid, raw):
    """What deleting the face at `raw` means: 'fill' a cavity or 'remove' a boss or blend."""
    import cadquery as cq

    faces = solid.Faces()
    size = solid.BoundingBox().DiagonalLength
    vertex = cq.Vertex.makeVertex(*raw)
    near = [i for i, face in enumerate(faces) if face.distance(vertex) <= size * 0.01]
    if not near:
        raise ValueError("no face was found at the selected location")
    seed = min(near, key=lambda i: faces[i].distance(vertex))
    if _axis(faces[seed]) is not None and _hole_like(faces[seed]):
        return "fill"
    owners = {}
    for index, face in enumerate(faces):
        for edge in face.Edges():
            owners.setdefault(edge.hashCode(), []).append(index)

    def neighbours(index):
        for edge in faces[index].Edges():
            for other in owners.get(edge.hashCode(), []):
                if other != index:
                    yield edge, other

    if not any(_dihedral(faces, seed, edge, other, size) > 0.05 for edge, other in neighbours(seed)):
        return "remove"  # a lone blend face such as a fillet or chamfer
    # A boss is bounded by a concave rim, so a walk that never crosses a concave edge stays small.
    found, queue = {seed}, [seed]
    while queue:
        current = queue.pop()
        for edge, other in neighbours(current):
            if other not in found and _dihedral(faces, current, edge, other, size) <= 0.05:
                found.add(other)
                queue.append(other)
    area = sum(faces[i].Area() for i in found)
    small = len(found) >= 2 and len(found) <= max(12, len(faces) * 0.6) and area < 0.5 * sum(f.Area() for f in faces)
    return "remove" if small else "fill"


def op_delete(shape, op, preview=False):
    """Delete the selected faces or edges: fill a cavity, remove a boss or a blend, as the geometry calls for."""
    solids = solids_of(shape)
    if len(solids) != 1:
        raise ValueError("deleting needs a single solid; undo the split first")
    kinds = {"fill": [], "remove": []}
    for raw in op["points"]:
        kinds[_delete_kind(solids[0], raw)].append(raw)
    if preview:
        chosen, faces, solid = set(), None, None
        for kind, points in kinds.items():
            if points:
                solid, faces, part = (op_fill if kind == "fill" else op_remove)(shape, {"points": points}, preview=True)
                chosen |= part
        return solid, faces, chosen
    if kinds["fill"]:
        shape = op_fill(shape, {"points": kinds["fill"]})
    if kinds["remove"]:
        shape = op_remove(shape, {"points": kinds["remove"]})
    return shape


SIMPLE_OPS = {
    "delete": op_delete,
    "remove": op_remove,
    "fill": op_fill,
    "stretch": op_stretch,
    "scale": op_scale,
    "translate": op_translate,
    "mirror": op_mirror,
    "fillet": op_edge_blend,
    "chamfer": op_edge_blend,
}


def drill(shape, solid, origin, normal, hole):
    """Drill a round hole into the part, against the face's outward normal."""
    import cadquery as cq

    diameter = hole.get("diameter")
    if not diameter:
        raise ValueError("the hole needs a diameter")
    size = solid.BoundingBox().DiagonalLength
    lift = size * 1e-3
    depth = (hole.get("depth") or size * 4) + lift
    unit = normal.normalized()
    plane = cq.Plane(origin=origin + unit * lift, normal=unit)
    drill_bit = cq.Workplane(plane).circle(diameter / 2).extrude(-depth)
    style = hole.get("style") or "simple"
    if style != "simple":
        head = hole.get("head_diameter")
        if not head or head <= diameter:
            raise ValueError(f"a {style} hole needs a head diameter larger than the hole")
        if style == "counterbore":
            head_depth = hole.get("head_depth")
            if not head_depth:
                raise ValueError("a counterbore needs a head depth")
            recess = cq.Workplane(plane).circle(head / 2).extrude(-(head_depth + lift))
        elif style == "countersink":
            half = math.radians((hole.get("angle") or 90.0) / 2)
            height = (head - diameter) / 2 / math.tan(half)
            # Start the cone a little above the surface so the cut opens cleanly.
            top_radius = head / 2 + lift * math.tan(half)
            recess = cq.Workplane().add(
                cq.Solid.makeCone(
                    top_radius,
                    diameter / 2,
                    height + lift,
                    pnt=origin + unit * lift,
                    dir=unit * -1,
                )
            )
        else:
            raise ValueError(f"unknown hole style {style!r}")
        drill_bit = drill_bit.union(recess)
    wp = shape if isinstance(shape, cq.Workplane) else cq.Workplane().add(shape)
    before = sum(v.Volume() for v in wp.vals())
    result = wp.cut(drill_bit)
    after = sum(v.Volume() for v in result.vals())
    if before - after < 1e-12:
        raise ValueError("the hole does not touch the part")
    return result


def FEATURES():
    import features

    return features.FEATURE_OPS


def apply_ops(shape, ops):
    """Apply cuts and drilled holes in order; `split` keeps both halves, moved apart."""
    import cadquery as cq

    for cut in ops:
        solid = shape.val() if hasattr(shape, "val") else shape
        if cut["type"] in SIMPLE_OPS:
            shape = SIMPLE_OPS[cut["type"]](shape, cut)
            continue
        if cut["type"] == "pattern":
            import features

            shape = features.op_pattern(shape, cut, apply_ops)
            continue
        if cut["type"] in FEATURES():
            shape = FEATURES()[cut["type"]](shape, cut)
            continue
        normal = cq.Vector(*cut["normal"])
        if normal.Length < 1e-9:
            raise ValueError("cut plane has no direction")
        origin = cq.Vector(*cut["origin"])
        if cut["type"] == "hole":
            shape = drill(shape, solid, origin, normal, cut)
            continue
        reach = solid.BoundingBox().DiagonalLength * 4 + 1
        plane = cq.Plane(origin=origin, normal=normal)
        above = cq.Workplane(plane).rect(reach, reach).extrude(reach)
        below = cq.Workplane(plane).rect(reach, reach).extrude(-reach)
        wp = shape if isinstance(shape, cq.Workplane) else cq.Workplane().add(shape)
        halves = {
            "positive": wp.intersect(above),
            "negative": wp.intersect(below),
        }
        present = {
            name: half
            for name, half in halves.items()
            if half.vals() and sum(v.Volume() for v in half.vals()) > 1e-12
        }
        if cut["keep"] == "split":
            if len(present) < 2:
                raise ValueError("the plane does not pass through the part")
            gap = normal.normalized() * (solid.BoundingBox().DiagonalLength * 0.04)
            shape = cq.Workplane().add(
                [
                    present["positive"].val().translate(gap),
                    present["negative"].val().translate(gap * -1),
                ]
            )
        elif cut["keep"] in present and len(present) == 2:
            shape = present[cut["keep"]]
        else:
            raise ValueError("the plane does not pass through the part")
    return shape


def imported_shape(request):
    """Load an uploaded STEP file as a CadQuery shape."""
    import base64

    import cadquery as cq

    data = base64.b64decode(request["sourceBase64"])
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "input.step"
        path.write_bytes(data)
        imported = cq.importers.importStep(str(path))
    solids = solids_of(imported)
    if not solids:
        raise ValueError("the STEP file contains no solid bodies")
    return cq.Workplane().add(solids)


def main():
    limits()
    import cadquery as cq

    request = json.load(sys.stdin)
    fmt = request["sourceFormat"]
    if fmt == "stl":
        # A mesh cannot be cut or drilled; show it as uploaded.
        if request.get("ops"):
            raise ValueError("an STL import is a mesh and cannot be edited; import a STEP file instead")
        print(json.dumps({"stlBase64": request["sourceBase64"], "stepBase64": ""}))
        return
    if fmt == "step":
        shape = imported_shape(request)
    elif fmt == "cad-sequence":
        shape = sequence_shape(request["source"])
    else:
        shape = cadquery_shape(request["source"])
    ops = request.get("ops") or []
    if request.get("preview"):
        # Show which faces the last fill would remove, without applying it.
        if not ops or ops[-1]["type"] not in ("fill", "remove", "delete"):
            raise ValueError("only a fill, removal or delete can be previewed")
        shape = apply_ops(shape, ops[:-1])
        previewer = {"fill": op_fill, "remove": op_remove, "delete": op_delete}[ops[-1]["type"]]
        solid, faces, chosen = previewer(shape, ops[-1], preview=True)
        shape = cq.Workplane().add(cq.Compound.makeCompound([faces[i] for i in sorted(chosen)]))
    else:
        shape = apply_ops(shape, ops)
    with tempfile.TemporaryDirectory() as directory:
        stl = Path(directory) / "part.stl"
        step = Path(directory) / "part.step"
        # Mesh fineness follows the part's size: fixed tolerances are far too
        # coarse for a small part measured in millimetres.
        diagonal = max(v.BoundingBox().DiagonalLength for v in shape.vals())
        cq.exporters.export(
            shape, str(stl), tolerance=max(diagonal * 5e-4, 1e-6), angularTolerance=0.1
        )
        if request.get("preview"):
            step.write_bytes(b"")
        else:
            cq.exporters.export(shape, str(step))
        payload = {
            "stlBase64": base64.b64encode(stl.read_bytes()).decode(),
            "stepBase64": base64.b64encode(step.read_bytes()).decode(),
        }
        if len(payload["stlBase64"]) > 24_000_000:
            raise ValueError("CAD mesh is too large")
        print(json.dumps(payload))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
