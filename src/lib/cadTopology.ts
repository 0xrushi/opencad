import { Vector3, type BufferGeometry } from 'three';

// Rendered CAD arrives as a triangle mesh with no face or edge identity, so
// recover it: triangles joined across smooth creases form a "face", and mesh
// edges between two different faces form a feature "edge". All coordinates stay
// in the model's own units (the viewer scales the preview separately).

const CREASE_COS = Math.cos((35 * Math.PI) / 180);
const PLANAR_COS = 0.9995;

export type CadFace = {
  id: number;
  triangles: number[];
  /** Triangle corners, 9 floats per triangle, in the model's own units. */
  corners: Float32Array;
  area: number;
  normal: Vector3;
  center: Vector3;
  planar: boolean;
};

export type CadEdge = {
  id: number;
  /** Flat segment endpoints: [a0, b0, a1, b1, ...]. */
  segments: Vector3[];
  faces: [number, number];
  length: number;
  kind: 'line' | 'circle' | 'arc' | 'curve';
  start?: Vector3;
  end?: Vector3;
  center?: Vector3;
  radius?: number;
};

/** A corner where two or more feature edges meet. */
export type CadVertex = {
  id: number;
  point: Vector3;
  edges: number[];
};

export type CadTopology = {
  faces: CadFace[];
  edges: CadEdge[];
  vertices: CadVertex[];
  /** Face id per triangle, or -1 for degenerate triangles. */
  triFace: Int32Array;
  size: number;
};

export type CadSelection = { kind: 'face' | 'edge' | 'vertex'; id: number };

const SELECTION_PREFIX = { face: 'F', edge: 'E', vertex: 'V' } as const;

export function selectionKey(item: CadSelection) {
  return `${SELECTION_PREFIX[item.kind]}${item.id}`;
}

export function buildTopology(geometry: BufferGeometry): CadTopology {
  const position = geometry.getAttribute('position');
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  const extent = bounds ? bounds.getSize(new Vector3()) : new Vector3();
  const size = Math.max(extent.x, extent.y, extent.z) || 1;

  // Weld coincident vertices so triangles can find their neighbours.
  const quantum = size * 1e-5;
  const welded = new Map<string, number>();
  const points: Vector3[] = [];
  const vertexOf = new Int32Array(position.count);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const key = `${Math.round(x / quantum)},${Math.round(y / quantum)},${Math.round(z / quantum)}`;
    let index = welded.get(key);
    if (index === undefined) {
      index = points.length;
      points.push(new Vector3(x, y, z));
      welded.set(key, index);
    }
    vertexOf[i] = index;
  }

  const triCount = Math.floor(position.count / 3);
  const normals: Vector3[] = [];
  const areas = new Float64Array(triCount);
  const centroids: Vector3[] = [];
  const edgeTris = new Map<number, number[]>();
  const stride = points.length + 1;
  for (let t = 0; t < triCount; t++) {
    const a = vertexOf[t * 3];
    const b = vertexOf[t * 3 + 1];
    const c = vertexOf[t * 3 + 2];
    const cross = new Vector3()
      .subVectors(points[b], points[a])
      .cross(new Vector3().subVectors(points[c], points[a]));
    areas[t] = cross.length() / 2;
    normals.push(areas[t] > 1e-12 * size * size ? cross.normalize() : new Vector3());
    centroids.push(
      new Vector3().add(points[a]).add(points[b]).add(points[c]).divideScalar(3),
    );
    if (areas[t] <= 1e-12 * size * size || a === b || b === c || a === c) {
      areas[t] = 0;
      continue;
    }
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = Math.min(u, v) * stride + Math.max(u, v);
      const list = edgeTris.get(key);
      if (list) list.push(t);
      else edgeTris.set(key, [t]);
    }
  }

  // Flood-fill faces across edges whose neighbouring normals barely change.
  const triFace = new Int32Array(triCount).fill(-1);
  const neighbours: number[][] = Array.from({ length: triCount }, () => []);
  for (const list of edgeTris.values()) {
    if (list.length !== 2) continue;
    neighbours[list[0]].push(list[1]);
    neighbours[list[1]].push(list[0]);
  }
  const faces: CadFace[] = [];
  for (let seed = 0; seed < triCount; seed++) {
    if (triFace[seed] !== -1 || areas[seed] === 0) continue;
    const id = faces.length;
    const triangles = [seed];
    triFace[seed] = id;
    for (let head = 0; head < triangles.length; head++) {
      const current = triangles[head];
      for (const next of neighbours[current]) {
        if (triFace[next] !== -1) continue;
        if (normals[current].dot(normals[next]) < CREASE_COS) continue;
        triFace[next] = id;
        triangles.push(next);
      }
    }
    const normal = new Vector3();
    const center = new Vector3();
    let area = 0;
    for (const t of triangles) {
      normal.addScaledVector(normals[t], areas[t]);
      center.addScaledVector(centroids[t], areas[t]);
      area += areas[t];
    }
    normal.normalize();
    center.divideScalar(area);
    const corners = new Float32Array(triangles.length * 9);
    triangles.forEach((t, row) => {
      for (let corner = 0; corner < 3; corner++) {
        const index = t * 3 + corner;
        corners[row * 9 + corner * 3] = position.getX(index);
        corners[row * 9 + corner * 3 + 1] = position.getY(index);
        corners[row * 9 + corner * 3 + 2] = position.getZ(index);
      }
    });
    faces.push({
      id,
      triangles,
      corners,
      area,
      normal,
      center,
      planar: triangles.every((t) => normals[t].dot(normal) > PLANAR_COS),
    });
  }

  // Feature edges: mesh edges shared by two different faces, grouped per face
  // pair and split into connected chains.
  const groups = new Map<string, [number, number][]>();
  for (const [key, list] of edgeTris.entries()) {
    if (list.length !== 2) continue;
    const fa = triFace[list[0]];
    const fb = triFace[list[1]];
    if (fa === fb || fa < 0 || fb < 0) continue;
    const u = Math.floor(key / stride);
    const v = key % stride;
    const pair = `${Math.min(fa, fb)}:${Math.max(fa, fb)}`;
    const bucket = groups.get(pair);
    if (bucket) bucket.push([u, v]);
    else groups.set(pair, [[u, v]]);
  }

  const edges: CadEdge[] = [];
  for (const [pair, segs] of groups.entries()) {
    const [fa, fb] = pair.split(':').map(Number) as [number, number];
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      let root = x;
      while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
      parent.set(x, root);
      return root;
    };
    for (const [u, v] of segs) {
      if (!parent.has(u)) parent.set(u, u);
      if (!parent.has(v)) parent.set(v, v);
      parent.set(find(u), find(v));
    }
    const chains = new Map<number, [number, number][]>();
    for (const seg of segs) {
      const root = find(seg[0]);
      const chain = chains.get(root);
      if (chain) chain.push(seg);
      else chains.set(root, [seg]);
    }
    for (const chain of chains.values()) {
      edges.push(describeEdge(edges.length, chain, points, [fa, fb], size));
    }
  }

  return { faces, edges, vertices: findVertices(edges, size), triFace, size };
}

/** Corners: points where the ends of at least two different feature edges meet. */
function findVertices(edges: CadEdge[], size: number): CadVertex[] {
  const quantum = size * 1e-5;
  const found = new Map<string, { point: Vector3; edges: Set<number> }>();
  for (const edge of edges) {
    for (const point of edge.segments) {
      const key = `${Math.round(point.x / quantum)},${Math.round(point.y / quantum)},${Math.round(point.z / quantum)}`;
      const entry = found.get(key);
      if (entry) entry.edges.add(edge.id);
      else found.set(key, { point, edges: new Set([edge.id]) });
    }
  }
  const vertices: CadVertex[] = [];
  for (const { point, edges: touching } of found.values()) {
    if (touching.size >= 2) vertices.push({ id: vertices.length, point, edges: [...touching] });
  }
  return vertices;
}

function describeEdge(
  id: number,
  chain: [number, number][],
  points: Vector3[],
  faces: [number, number],
  size: number,
): CadEdge {
  const segments: Vector3[] = [];
  const degree = new Map<number, number>();
  let length = 0;
  for (const [u, v] of chain) {
    segments.push(points[u], points[v]);
    length += points[u].distanceTo(points[v]);
    degree.set(u, (degree.get(u) ?? 0) + 1);
    degree.set(v, (degree.get(v) ?? 0) + 1);
  }
  const vertices = [...degree.keys()].map((index) => points[index]);
  const base: CadEdge = { id, segments, faces, length, kind: 'curve' };

  // Straight: every vertex sits on the line through the two extreme points.
  const first = vertices[0];
  const a = vertices.reduce((best, p) => (p.distanceTo(first) > best.distanceTo(first) ? p : best), first);
  const b = vertices.reduce((best, p) => (p.distanceTo(a) > best.distanceTo(a) ? p : best), a);
  const direction = new Vector3().subVectors(b, a);
  const span = direction.length();
  if (span > 0) {
    direction.divideScalar(span);
    const straight = vertices.every(
      (p) =>
        new Vector3().subVectors(p, a).cross(direction).length() <
        Math.max(size * 1e-4, span * 1e-3),
    );
    if (straight) return { ...base, kind: 'line', start: a, end: b, length: span };
  }

  // Circular: a closed loop of points equidistant from their centroid.
  const closed = [...degree.values()].every((count) => count === 2);
  if (closed && vertices.length >= 6) {
    const center = vertices.reduce((sum, p) => sum.add(p), new Vector3()).divideScalar(vertices.length);
    const radii = vertices.map((p) => p.distanceTo(center));
    const radius = radii.reduce((sum, r) => sum + r, 0) / radii.length;
    if (radius > 0 && radii.every((r) => Math.abs(r - radius) / radius < 0.03)) {
      return { ...base, kind: 'circle', center, radius };
    }
  }
  // Arc: an open chain whose points all lie on one circle through its ends.
  const ends = [...degree.entries()].filter(([, count]) => count === 1).map(([index]) => points[index]);
  if (!closed && ends.length === 2 && vertices.length >= 4) {
    const [first, last] = ends;
    const chord = new Vector3().subVectors(last, first);
    const middle = vertices.reduce(
      (best, p) => {
        const off = new Vector3().subVectors(p, first).cross(chord).length();
        return off > best.off ? { p, off } : best;
      },
      { p: first, off: -1 },
    ).p;
    const a = new Vector3().subVectors(middle, first);
    const b = new Vector3().subVectors(last, first);
    const normal = a.clone().cross(b);
    if (normal.lengthSq() > 1e-18) {
      const center = first
        .clone()
        .add(
          normal
            .clone()
            .cross(a)
            .multiplyScalar(b.lengthSq())
            .add(b.clone().cross(normal).multiplyScalar(a.lengthSq()))
            .divideScalar(2 * normal.lengthSq()),
        );
      const radius = center.distanceTo(first);
      const unit = normal.clone().normalize();
      const onCircle = vertices.every(
        (p) =>
          Math.abs(p.distanceTo(center) - radius) / radius < 0.03 &&
          Math.abs(new Vector3().subVectors(p, center).dot(unit)) < radius * 0.03,
      );
      if (radius > 0 && onCircle) return { ...base, kind: 'arc', center, radius };
    }
  }
  return base;
}

function fmt(value: number) {
  return Number(value.toPrecision(4));
}

function fmtPoint(p: Vector3) {
  return `(${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)})`;
}

export function axisName(normal: Vector3) {
  const abs = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)];
  const index = abs.indexOf(Math.max(...abs));
  const value = [normal.x, normal.y, normal.z][index];
  if (abs[index] < 0.98) return null;
  return `${value < 0 ? '-' : '+'}${'XYZ'[index]}`;
}

export function describeItem(topology: CadTopology, item: CadSelection): string {
  const label = selectionKey(item);
  if (item.kind === 'face') {
    const face = topology.faces[item.id];
    if (!face) return label;
    const axis = face.planar ? axisName(face.normal) : null;
    const shape = face.planar
      ? `planar face${axis ? ` facing ${axis}` : ` with normal ${fmtPoint(face.normal)}`}`
      : 'curved face';
    return `${label}: ${shape}, centre ${fmtPoint(face.center)}, area ${fmt(face.area)}`;
  }
  if (item.kind === 'vertex') {
    const vertex = topology.vertices[item.id];
    if (!vertex) return label;
    return `${label}: corner at ${fmtPoint(vertex.point)}, where ${vertex.edges.map((id) => `E${id}`).join(', ')} meet`;
  }
  const edge = topology.edges[item.id];
  if (!edge) return label;
  const between = `between F${edge.faces[0]} and F${edge.faces[1]}`;
  if (edge.kind === 'line' && edge.start && edge.end) {
    return `${label}: straight edge from ${fmtPoint(edge.start)} to ${fmtPoint(edge.end)}, length ${fmt(edge.length)}, ${between}`;
  }
  if (edge.kind === 'circle' && edge.center && edge.radius) {
    return `${label}: circular edge, centre ${fmtPoint(edge.center)}, radius ${fmt(edge.radius)}, ${between}`;
  }
  if (edge.kind === 'arc' && edge.center && edge.radius) {
    return `${label}: circular arc, centre ${fmtPoint(edge.center)}, radius ${fmt(edge.radius)}, ${between}`;
  }
  return `${label}: curved edge, length ${fmt(edge.length)}, ${between}`;
}

export function describeSelection(
  topology: CadTopology,
  selection: CadSelection[],
): string {
  if (selection.length === 0) return '';
  return `Selected geometry (model units):\n${selection
    .map((item) => `- ${describeItem(topology, item)}`)
    .join('\n')}`;
}

/** Distance from a point to the closest segment of one feature edge. */
export function distanceToEdge(edge: CadEdge, point: Vector3): number {
  const ab = new Vector3();
  const ap = new Vector3();
  const closest = new Vector3();
  let best = Infinity;
  for (let i = 0; i < edge.segments.length; i += 2) {
    const a = edge.segments[i];
    const b = edge.segments[i + 1];
    ab.subVectors(b, a);
    ap.subVectors(point, a);
    const t = Math.min(1, Math.max(0, ap.dot(ab) / (ab.lengthSq() || 1)));
    closest.copy(a).addScaledVector(ab, t);
    best = Math.min(best, closest.distanceTo(point));
  }
  return best;
}

export type CutPlane = {
  origin: Vector3;
  normal: Vector3;
  /** Human description of how the plane was derived. */
  label: string;
  positiveName: string;
  negativeName: string;
};

function sideName(normal: Vector3) {
  const aligned = axisName(normal);
  if (aligned) return aligned;
  const parts = [normal.x, normal.y, normal.z];
  const index = parts.map(Math.abs).indexOf(Math.max(...parts.map(Math.abs)));
  return `${parts[index] < 0 ? '-' : '+'}${'XYZ'[index]}-ish`;
}

function flip(name: string) {
  return name.startsWith('+')
    ? `-${name.slice(1)}`
    : name.startsWith('-')
      ? `+${name.slice(1)}`
      : name;
}

/**
 * Derive a cutting plane from the selection: one planar face (its own plane),
 * two parallel faces (the plane midway between them), or two straight edges
 * that lie in a common plane. Coordinates are in the topology's own space.
 */
export function planeFromSelection(
  topology: CadTopology,
  selection: CadSelection[],
): CutPlane | { error: string } {
  const faces = selection.flatMap((item) =>
    item.kind === 'face' ? [topology.faces[item.id]] : [],
  );
  const edges = selection.flatMap((item) =>
    item.kind === 'edge' ? [topology.edges[item.id]] : [],
  );
  const make = (origin: Vector3, normal: Vector3, label: string): CutPlane => {
    const unit = normal.clone().normalize();
    const positiveName = sideName(unit);
    return { origin, normal: unit, label, positiveName, negativeName: flip(positiveName) };
  };

  if (faces.length === 1 && edges.length === 0) {
    const [face] = faces;
    if (!face.planar) return { error: 'Select a planar face.' };
    return make(face.center.clone(), face.normal, `the plane of F${face.id}`);
  }
  if (faces.length === 2 && edges.length === 0) {
    const [a, b] = faces;
    if (!a.planar || !b.planar) return { error: 'Select planar faces.' };
    if (Math.abs(a.normal.dot(b.normal)) < 0.999) {
      // Non-parallel faces: the plane through their common line that bisects
      // the wedge between them (normal along n1 - n2 for outward normals).
      const axis = a.normal.clone().cross(b.normal);
      const da = a.normal.dot(a.center);
      const db = b.normal.dot(b.center);
      const onLine = b.normal
        .clone()
        .cross(axis)
        .multiplyScalar(da)
        .add(axis.clone().cross(a.normal).multiplyScalar(db))
        .divideScalar(axis.lengthSq());
      return make(
        onLine,
        a.normal.clone().sub(b.normal),
        `the plane bisecting F${a.id} and F${b.id}`,
      );
    }
    return make(
      a.center.clone().add(b.center).multiplyScalar(0.5),
      a.normal,
      `the middle plane between F${a.id} and F${b.id}`,
    );
  }
  if (faces.length === 1 && edges.length === 1) {
    // A plane parallel to the face that passes through the edge.
    const [face] = faces;
    const [edge] = edges;
    if (!face.planar) return { error: 'Select a planar face.' };
    const through = edge.segments[0];
    if (!through) return { error: 'The selected edge has no geometry.' };
    return make(
      through.clone(),
      face.normal,
      `the plane parallel to F${face.id} through E${edge.id}`,
    );
  }
  if (edges.length === 2 && faces.length === 0) {
    return planeFromEdges(topology, edges[0], edges[1]);
  }
  return {
    error:
      'Select one planar face, two faces, two straight edges in one plane, or a face and an edge.',
  };
}

/** Plane containing two straight edges (parallel, or intersecting). */
export function planeFromEdges(
  topology: CadTopology,
  a: CadEdge,
  b: CadEdge,
): CutPlane | { error: string } {
  if (a.kind !== 'line' || b.kind !== 'line' || !a.start || !a.end || !b.start || !b.end) {
    return { error: 'Select two straight edges.' };
  }
  const d1 = new Vector3().subVectors(a.end, a.start).normalize();
  const d2 = new Vector3().subVectors(b.end, b.start).normalize();
  const link = new Vector3().subVectors(b.start, a.start);
  const parallel = d1.clone().cross(d2).length() < 1e-3;
  const normal = parallel ? d1.clone().cross(link) : d1.clone().cross(d2);
  if (normal.length() < 1e-9) return { error: 'The two edges are on the same line.' };
  normal.normalize();
  if (Math.abs(link.dot(normal)) > topology.size * 1e-3) {
    return { error: 'The two edges do not lie in one plane.' };
  }
  const positiveName = sideName(normal);
  return {
    origin: a.start.clone(),
    normal,
    label: `the plane through E${a.id} and E${b.id}`,
    positiveName,
    negativeName: flip(positiveName),
  };
}

/** A representative point on an edge: its middle, or the centre of a circle. */
export function edgePoint(edge: CadEdge): Vector3 {
  if (edge.kind === 'circle' && edge.center) return edge.center.clone();
  if (edge.kind === 'line' && edge.start && edge.end) {
    return edge.start.clone().add(edge.end).multiplyScalar(0.5);
  }
  const index = Math.floor(edge.segments.length / 4) * 2;
  return edge.segments[index].clone().add(edge.segments[index + 1]).multiplyScalar(0.5);
}

/** A point that lies on the edge itself, for matching it in the CAD kernel. */
export function pointOnEdge(edge: CadEdge): Vector3 {
  const index = Math.floor(edge.segments.length / 4) * 2;
  return edge.segments[index].clone().add(edge.segments[index + 1]).multiplyScalar(0.5);
}

/** Smallest and largest value of `direction . point` over a face's corners. */
export function faceExtent(face: CadFace, direction: Vector3): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < face.corners.length; i += 3) {
    const value =
      face.corners[i] * direction.x +
      face.corners[i + 1] * direction.y +
      face.corners[i + 2] * direction.z;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

/** Whether a point on a planar face's plane lies within the face's triangles. */
export function faceContains(face: CadFace, point: Vector3, tolerance: number): boolean {
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const v0 = new Vector3();
  const v1 = new Vector3();
  const v2 = new Vector3();
  for (let i = 0; i < face.corners.length; i += 9) {
    a.fromArray(face.corners, i);
    b.fromArray(face.corners, i + 3);
    c.fromArray(face.corners, i + 6);
    v0.subVectors(c, a);
    v1.subVectors(b, a);
    v2.subVectors(point, a);
    const d00 = v0.dot(v0);
    const d01 = v0.dot(v1);
    const d02 = v0.dot(v2);
    const d11 = v1.dot(v1);
    const d12 = v1.dot(v2);
    const denominator = d00 * d11 - d01 * d01;
    if (Math.abs(denominator) < 1e-18) continue;
    const u = (d11 * d02 - d01 * d12) / denominator;
    const v = (d00 * d12 - d01 * d02) / denominator;
    const slack = tolerance / Math.sqrt(Math.max(d00, d11));
    if (u >= -slack && v >= -slack && u + v <= 1 + slack) return true;
  }
  return false;
}

/** The point on a face's surface (a triangle middle) closest to `near`. */
export function pointOnFaceNear(face: CadFace, near: Vector3): Vector3 {
  const centroid = new Vector3();
  const corner = new Vector3();
  let best = pointOnFace(face);
  let bestDistance = Infinity;
  for (let i = 0; i + 8 < face.corners.length; i += 9) {
    centroid.set(0, 0, 0);
    for (let k = 0; k < 9; k += 3) centroid.add(corner.fromArray(face.corners, i + k));
    centroid.divideScalar(3);
    const distance = centroid.distanceToSquared(near);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = centroid.clone();
    }
  }
  return best;
}

/** A point that lies on the face's surface: the middle of one of its triangles. */
export function pointOnFace(face: CadFace): Vector3 {
  const row = Math.floor(face.corners.length / 18) * 9;
  const a = new Vector3().fromArray(face.corners, row);
  const b = new Vector3().fromArray(face.corners, row + 3);
  const c = new Vector3().fromArray(face.corners, row + 6);
  return a.add(b).add(c).divideScalar(3);
}
