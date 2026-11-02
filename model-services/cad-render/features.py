"""Feature operations for the CAD renderer: pockets, bosses, patterns, shells,
offset faces, text, ribs and drafts. Each takes (shape, op) and returns a new
CadQuery Workplane, or raises ValueError with a reason fit to show a user.

All coordinates are in the shape's own frame, like the other operations."""

import math


def _single(shape):
    import cadquery as cq

    values = shape.vals() if hasattr(shape, "vals") else [shape]
    solids = [solid for value in values for solid in value.Solids()]
    if len(solids) != 1:
        raise ValueError("this operation needs a single solid; undo the split first")
    return solids[0], cq


def _volume(shape):
    values = shape.vals() if hasattr(shape, "vals") else [shape]
    return sum(solid.Volume() for value in values for solid in value.Solids())


def _require_on_part(solid, cq, point, what):
    """The operation's anchor must lie on the part's surface, or it would act on empty space."""
    reach = solid.BoundingBox().DiagonalLength * 0.01
    if solid.distance(cq.Vertex.makeVertex(*point)) > reach:
        raise ValueError(f"the {what} does not touch the part; place it on a face")


def _vec(cq, values):
    return cq.Vector(*values)


def plane_at(cq, origin, normal, rotation=0.0):
    """A workplane at `origin` facing `normal`, turned by `rotation` degrees about it."""
    unit = normal.normalized()
    # The width of a sketch runs along X on a flat (top or bottom) face, and
    # horizontally along the face on a side wall.
    x_dir = cq.Vector(1, 0, 0) if abs(unit.z) > 0.9 else cq.Vector(0, 0, 1).cross(unit).normalized()
    if rotation:
        angle = math.radians(rotation)
        x_dir = (
            x_dir * math.cos(angle)
            + unit.cross(x_dir) * math.sin(angle)
            + unit * (unit.dot(x_dir)) * (1 - math.cos(angle))
        )
    return cq.Plane(origin=origin, xDir=x_dir, normal=unit)


def _profile(cq, plane, op):
    """The 2D outline of a pocket or boss on `plane`."""
    kind = op.get("profile") or "circle"
    wp = cq.Workplane(plane)
    if kind == "polygon":
        # `width` is the distance across the flats; `sides` is the number of sides.
        sides = op.get("sides")
        if not isinstance(sides, int) or not 3 <= sides <= 64:
            raise ValueError("a polygon needs a whole number of sides from 3 to 64")
        if not op.get("width"):
            raise ValueError("a polygon needs a width (across the flats)")
        return wp.polygon(sides, op["width"], circumscribed=True)
    if kind == "star":
        # `width` is the outer diameter; `sides` is the number of points.
        points = op.get("sides")
        if not isinstance(points, int) or not 3 <= points <= 64:
            raise ValueError("a star needs a whole number of points from 3 to 64")
        if not op.get("width"):
            raise ValueError("a star needs a width (outer diameter)")
        outer = op["width"] / 2
        inner = outer * 0.45
        outline = []
        for i in range(points * 2):
            radius = outer if i % 2 == 0 else inner
            angle = math.pi / 2 + i * math.pi / points
            outline.append((radius * math.cos(angle), radius * math.sin(angle)))
        return wp.polyline(outline).close()
    if kind == "circle":
        if not op.get("diameter"):
            raise ValueError("a round pocket or boss needs a diameter")
        return wp.circle(op["diameter"] / 2)
    width = op.get("width")
    if not width:
        raise ValueError(f"a {kind} needs a width")
    height = op.get("height") or width
    if kind == "rect":
        return wp.rect(width, height)
    if kind == "ellipse":
        return wp.ellipse(width / 2, height / 2)
    if kind == "rounded_rect":
        radius = op.get("radius")
        if not radius:
            raise ValueError("a rounded rectangle needs a corner radius")
        if radius * 2 >= min(width, height):
            raise ValueError("the corner radius must be less than half the shorter side")
        return wp.sketch().rect(width, height).vertices().fillet(radius).finalize()
    if kind == "slot":
        # `width` is the slot's overall length, `height` its width.
        if height > width:
            raise ValueError("a slot cannot be wider than it is long")
        return wp.slot2D(width, height, 0)
    raise ValueError(f"unknown profile {kind!r}")


def op_pocket(shape, op):
    """Cut a rectangle, circle, slot, polygon, ellipse, rounded rectangle or star into a face, down against its outward normal."""
    solid, cq = _single(shape)
    _require_on_part(solid, cq, op["origin"], "pocket")
    size = solid.BoundingBox().DiagonalLength
    lift = size * 1e-3
    unit = _vec(cq, op["normal"]).normalized()
    plane = plane_at(cq, _vec(cq, op["origin"]) + unit * lift, unit, op.get("rotation") or 0.0)
    depth = (op.get("depth") or size * 4) + lift
    tool = _profile(cq, plane, op).extrude(-depth)
    result = cq.Workplane().add(solid).cut(tool)
    if solid.Volume() - _volume(result) < 1e-9:
        raise ValueError("the pocket does not touch the part; place it on the face")
    return result


def op_boss(shape, op):
    """Add a rectangle, circle, slot, polygon, ellipse, rounded rectangle or star standing out of a face along its outward normal."""
    solid, cq = _single(shape)
    _require_on_part(solid, cq, op["origin"], "boss")
    size = solid.BoundingBox().DiagonalLength
    unit = _vec(cq, op["normal"]).normalized()
    height = op.get("depth")
    if not height:
        raise ValueError("a boss needs a height")
    sink = size * 1e-3  # overlap the part slightly so the union is one solid
    plane = plane_at(cq, _vec(cq, op["origin"]) - unit * sink, unit, op.get("rotation") or 0.0)
    tool = _profile(cq, plane, op).extrude(height + sink)
    result = cq.Workplane().add(solid).union(tool).clean()
    if _volume(result) - solid.Volume() < 1e-9:
        raise ValueError("the boss does not touch the part; place it on the face")
    if len(result.val().Solids()) != 1:
        raise ValueError("the boss is not attached to the part; place it on the face")
    return result


def op_text(shape, op):
    """Emboss (positive depth) or engrave (negative depth) text on a planar face."""
    solid, cq = _single(shape)
    _require_on_part(solid, cq, op["origin"], "text")
    text = (op.get("text") or "").strip()
    if not text:
        raise ValueError("there is no text to add")
    depth = op.get("distance")
    if not depth:
        raise ValueError("the text needs a depth (positive raises it, negative engraves it)")
    size = op.get("size") or solid.BoundingBox().DiagonalLength * 0.1
    unit = _vec(cq, op["normal"]).normalized()
    sink = solid.BoundingBox().DiagonalLength * 1e-3
    plane = plane_at(cq, _vec(cq, op["origin"]), unit, op.get("rotation") or 0.0)
    wp = cq.Workplane().add(solid)
    if depth > 0:
        letters = cq.Workplane(plane).workplane(offset=-sink).text(text, size, depth + sink, combine=False)
        result = wp.union(letters).clean()
        if _volume(result) - solid.Volume() < 1e-9:
            raise ValueError("the text does not touch the part")
    else:
        letters = cq.Workplane(plane).workplane(offset=sink).text(text, size, depth - sink, combine=False)
        result = wp.cut(letters)
        if solid.Volume() - _volume(result) < 1e-9:
            raise ValueError("the text does not reach the part")
    return result


def op_shell(shape, op):
    """Hollow the part with walls of `thickness`, opening the faces at `points`."""
    solid, cq = _single(shape)
    thickness = op.get("thickness")
    if not thickness:
        raise ValueError("the shell needs a wall thickness")
    reach = solid.BoundingBox().DiagonalLength * 0.01
    openings = []
    for point in op.get("points") or []:
        vertex = cq.Vertex.makeVertex(*point)
        near = [face for face in solid.Faces() if face.distance(vertex) <= reach]
        if not near:
            raise ValueError("no face was found at one of the faces to leave open")
        openings.append(min(near, key=lambda face: face.distance(vertex)))
    if not openings:
        raise ValueError("select at least one face to leave open")
    from OCP.BRepOffsetAPI import BRepOffsetAPI_MakeThickSolid
    from OCP.TopTools import TopTools_ListOfShape

    faces = TopTools_ListOfShape()
    for opening in openings:
        faces.Append(opening.wrapped)
    try:
        maker = BRepOffsetAPI_MakeThickSolid()
        maker.MakeThickSolidByJoin(solid.wrapped, faces, -thickness, 1e-4)
        maker.Build()
        result = cq.Shape.cast(maker.Shape())
    except Exception as error:
        raise ValueError(f"the kernel could not hollow this shape with {thickness} walls; parts with cones, undercuts or tiny features often cannot be offset, so try filling or removing those features first. A face that sits in a corner (like a floor beside a taller wall) cannot be left open; choose an outer face such as the bottom or the top of the tallest part") from error
    if not result.isValid() or result.Volume() >= solid.Volume() - 1e-9:
        raise ValueError(
            f"the part cannot be hollowed with {thickness} walls here. A face that sits in a corner "
            "(like a floor beside a taller wall) cannot be left open; choose an outer face such as the bottom or the top of the tallest part"
        )
    return cq.Workplane().add(result)


def op_offset_face(shape, op):
    """Move a planar face along its normal: outward adds material, inward removes it."""
    solid, cq = _single(shape)
    distance = op.get("distance")
    if not distance:
        raise ValueError("the offset needs a nonzero distance")
    point = op["points"][0] if op.get("points") else op.get("origin")
    if point is None:
        raise ValueError("no face was given")
    vertex = cq.Vertex.makeVertex(*point)
    reach = solid.BoundingBox().DiagonalLength * 0.01
    near = [face for face in solid.Faces() if face.distance(vertex) <= reach]
    if not near:
        raise ValueError("no face was found at the selected location")
    target = min(near, key=lambda face: face.distance(vertex))
    if target.geomType() != "PLANE":
        raise ValueError("only a planar face can be moved; select a flat face")
    normal = target.normalAt()
    prism = cq.Solid.extrudeLinear(target, normal * distance)
    wp = cq.Workplane().add(solid)
    if distance > 0:
        result = wp.union(cq.Workplane().add(prism)).clean()
        if _volume(result) - solid.Volume() < 1e-9:
            raise ValueError("moving the face made no change")
    else:
        result = wp.cut(cq.Workplane().add(prism))
        if solid.Volume() - _volume(result) < 1e-9:
            raise ValueError("moving the face made no change")
        if _volume(result) < 1e-9:
            raise ValueError("the part is not thick enough to move the face that far")
    return result


def op_rib(shape, op):
    """A triangular gusset in the corner where two faces meet, centred on `origin`."""
    solid, cq = _single(shape)
    thickness, length = op.get("thickness"), op.get("size")
    if not thickness or not length:
        raise ValueError("the rib needs a thickness and a size")
    edge_direction = _vec(cq, op["vector"]).normalized()
    n1 = _vec(cq, op["normal"]).normalized()
    n2 = _vec(cq, op["normal2"]).normalized()
    if abs(n1.dot(n2)) > 0.999:
        raise ValueError("the two faces are parallel, so there is no corner to brace")
    a = (n2 - n1 * n1.dot(n2)).normalized()  # along face 1, away from the corner
    b = (n1 - n2 * n1.dot(n2)).normalized()  # along face 2, away from the corner
    origin = _vec(cq, op["origin"]) - edge_direction * (thickness / 2)
    sink = length * 0.02
    corner = [
        origin - n1 * sink - n2 * sink,
        origin + a * length - n1 * sink,
        origin + b * length - n2 * sink,
    ]
    face = cq.Face.makeFromWires(cq.Wire.makePolygon(corner + [corner[0]]))
    tool = cq.Solid.extrudeLinear(face, edge_direction * thickness)
    wp = cq.Workplane().add(solid)
    result = wp.union(cq.Workplane().add(tool)).clean()
    if _volume(result) - solid.Volume() < 1e-9:
        raise ValueError("the rib does not touch the part; place it on the corner edge")
    if len(result.val().Solids()) != 1:
        raise ValueError("the rib is not attached to the part")
    return result


def op_draft(shape, op):
    """Tilt side faces by `angle` degrees about a pull direction (for moulding)."""
    solid, cq = _single(shape)
    from OCP.BRepOffsetAPI import BRepOffsetAPI_DraftAngle
    from OCP.gp import gp_Dir, gp_Pln, gp_Pnt

    angle = op.get("angle")
    if not angle:
        raise ValueError("the draft needs an angle in degrees")
    pull = _vec(cq, op["normal"]).normalized()
    neutral = _vec(cq, op["origin"])
    plane = gp_Pln(gp_Pnt(neutral.x, neutral.y, neutral.z), gp_Dir(pull.x, pull.y, pull.z))
    reach = solid.BoundingBox().DiagonalLength * 0.01
    draft = BRepOffsetAPI_DraftAngle(solid.wrapped)
    chosen = 0
    for point in op.get("points") or []:
        vertex = cq.Vertex.makeVertex(*point)
        near = [face for face in solid.Faces() if face.distance(vertex) <= reach]
        if not near:
            raise ValueError("no face was found at one of the faces to draft")
        face = min(near, key=lambda candidate: candidate.distance(vertex))
        if abs(face.normalAt().dot(pull)) > 0.999:
            raise ValueError("a face square to the pull direction cannot be drafted; select a side wall")
        draft.Add(face.wrapped, gp_Dir(pull.x, pull.y, pull.z), math.radians(angle), plane)
        if not draft.AddDone():
            raise ValueError("this face cannot be drafted by that angle")
        chosen += 1
    if chosen == 0:
        raise ValueError("select the faces to draft")
    draft.Build()
    if not draft.IsDone():
        raise ValueError("the draft could not be built; try a smaller angle or fewer faces")
    result = cq.Shape.cast(draft.Shape())
    if not result.isValid():
        raise ValueError("the draft produced an invalid shape; try a smaller angle")
    return cq.Workplane().add(result)


def op_pattern(shape, op, apply):
    """Repeat a hole, pocket, boss or text `count` times, in a line or around an axis.

    Linear: `vector` is the direction and `distance` the spacing. Circular:
    `origin` is a point on the axis, `normal` its direction and `angle` the
    total sweep in degrees (360 spreads the copies evenly around)."""
    import cadquery as cq

    inner = op.get("of")
    if not inner or inner.get("type") not in ("hole", "pocket", "boss", "text"):
        raise ValueError("only a hole, pocket, boss or text can be repeated")
    count = op.get("count") or 0
    if count < 2 or count > 64:
        raise ValueError("a pattern needs between 2 and 64 copies")
    kind = op.get("kind") or "linear"
    for index in range(count):
        copy = dict(inner)
        origin = _vec(cq, inner["origin"])
        normal = _vec(cq, inner["normal"])
        if kind == "linear":
            direction = _vec(cq, op["vector"]).normalized()
            spacing = op.get("distance")
            if not spacing:
                raise ValueError("a linear pattern needs a spacing")
            origin = origin + direction * (spacing * index)
        elif kind == "circular":
            axis = _vec(cq, op["normal"]).normalized()
            center = _vec(cq, op["origin"])
            total = op.get("angle") or 360.0
            step = total / count if abs(total) >= 360 else total / (count - 1)
            degrees = step * index
            origin = center + _turn(cq, origin - center, axis, degrees)
            normal = _turn(cq, normal, axis, degrees)
            copy["rotation"] = (inner.get("rotation") or 0.0) + degrees * (1 if axis.dot(normal) >= 0 else -1)
        else:
            raise ValueError(f"unknown pattern {kind!r}")
        copy["origin"] = [origin.x, origin.y, origin.z]
        copy["normal"] = [normal.x, normal.y, normal.z]
        try:
            shape = apply(shape, [copy])
        except ValueError:
            # The first copy sits on the feature the user pointed at, which already
            # exists; cutting it again changes nothing, so it is not an error.
            if index != 0 or kind != "linear" and kind != "circular":
                raise
    return shape


def op_combine(shape, op):
    """Union, subtract or intersect with another version of the part (sent as STEP)."""
    import base64
    import tempfile
    from pathlib import Path

    solid, cq = _single(shape)
    mode = op.get("mode")
    if mode not in ("union", "subtract", "intersect") or not op.get("other_step"):
        raise ValueError("combine needs a mode and another version to combine with")
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "other.step"
        path.write_bytes(base64.b64decode(op["other_step"]))
        other = cq.importers.importStep(str(path))
    base = cq.Workplane().add(solid)
    if mode == "union":
        result = base.union(other)
    elif mode == "subtract":
        result = base.cut(other)
    else:
        result = base.intersect(other)
    solids = [piece for value in result.vals() for piece in value.Solids()]
    if not solids or sum(piece.Volume() for piece in solids) < 1e-9:
        raise ValueError(f"the {mode} left nothing; the two versions do not overlap that way")
    return cq.Workplane().add(solids)


def _turn(cq, vector, axis, degrees):
    """Rotate a vector about a unit axis through the origin (Rodrigues' formula)."""
    angle = math.radians(degrees)
    return (
        vector * math.cos(angle)
        + axis.cross(vector) * math.sin(angle)
        + axis * (axis.dot(vector)) * (1 - math.cos(angle))
    )


FEATURE_OPS = {
    "pocket": op_pocket,
    "boss": op_boss,
    "text": op_text,
    "shell": op_shell,
    "offset_face": op_offset_face,
    "rib": op_rib,
    "draft": op_draft,
    "combine": op_combine,
}
