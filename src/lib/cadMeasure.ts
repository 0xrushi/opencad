import { Vector3 } from 'three';
import { pointOnFace, type CadEdge, type CadFace, type CadTopology } from './cadTopology.ts';

// Answers about the part computed from the recovered mesh: angles, wall
// thickness, volume, mass, size, round holes and printability. Nothing here
// changes the model.

type Ref = string | { facing: string };

export type ExtraMeasure = {
  what: 'angle' | 'thickness' | 'volume' | 'surface_area' | 'bbox' | 'mass' | 'holes' | 'printability';
  of: Ref[];
  /** A material word such as "pla" or "aluminum", for mass. */
  material?: string | null;
  /** Wall thickness below which printability complains, in model units. */
  threshold?: number | null;
};

export const EXTRA_MEASURES: ExtraMeasure['what'][] = [
  'angle', 'thickness', 'volume', 'surface_area', 'bbox', 'mass', 'holes', 'printability',
];

/** Densities in grams per cubic centimetre. */
export const DENSITY: Record<string, number> = {
  pla: 1.24, abs: 1.04, petg: 1.27, nylon: 1.15, resin: 1.1, wood: 0.6, plastic: 1.2,
  aluminum: 2.7, aluminium: 2.7, steel: 7.85, stainless: 8.0, brass: 8.5, copper: 8.96,
  titanium: 4.5, iron: 7.87, bronze: 8.8,
};

const fmt = (value: number) => Number(value.toPrecision(4));

function triangles(topology: CadTopology) {
  const list: { a: Vector3; b: Vector3; c: Vector3 }[] = [];
  for (const face of topology.faces) {
    const k = face.corners;
    for (let i = 0; i + 8 < k.length; i += 9) {
      list.push({
        a: new Vector3(k[i], k[i + 1], k[i + 2]),
        b: new Vector3(k[i + 3], k[i + 4], k[i + 5]),
        c: new Vector3(k[i + 6], k[i + 7], k[i + 8]),
      });
    }
  }
  return list;
}

/** Volume of the closed mesh, from signed tetrahedra against the origin. */
export function meshVolume(topology: CadTopology): number {
  let total = 0;
  for (const { a, b, c } of triangles(topology)) total += a.dot(b.clone().cross(c)) / 6;
  return Math.abs(total);
}

/** Distance along `direction` from `origin` to the first triangle hit, or null. */
function rayDistance(
  tris: { a: Vector3; b: Vector3; c: Vector3 }[],
  origin: Vector3,
  direction: Vector3,
): number | null {
  let best: number | null = null;
  const edge1 = new Vector3();
  const edge2 = new Vector3();
  const p = new Vector3();
  const t = new Vector3();
  const q = new Vector3();
  for (const { a, b, c } of tris) {
    edge1.subVectors(b, a);
    edge2.subVectors(c, a);
    p.crossVectors(direction, edge2);
    const det = edge1.dot(p);
    if (Math.abs(det) < 1e-14) continue;
    t.subVectors(origin, a);
    const u = t.dot(p) / det;
    if (u < 0 || u > 1) continue;
    q.crossVectors(t, edge1);
    const v = direction.dot(q) / det;
    if (v < 0 || u + v > 1) continue;
    const distance = edge2.dot(q) / det;
    if (distance > 1e-9 && (best === null || distance < best)) best = distance;
  }
  return best;
}

/** Sample points on a face (triangle centroids), at most `limit` of them. */
function sampleFace(face: CadFace, limit: number): Vector3[] {
  const k = face.corners;
  const count = Math.floor(k.length / 9);
  const step = Math.max(1, Math.floor(count / limit));
  const out: Vector3[] = [];
  for (let i = 0; i < count; i += step) {
    const o = i * 9;
    out.push(
      new Vector3(
        (k[o] + k[o + 3] + k[o + 6]) / 3,
        (k[o + 1] + k[o + 4] + k[o + 7]) / 3,
        (k[o + 2] + k[o + 5] + k[o + 8]) / 3,
      ),
    );
  }
  return out;
}

/** Wall thickness across a face: ray from the surface inward to the far side. */
function thicknessOf(face: CadFace, tris: ReturnType<typeof triangles>, size: number, limit: number) {
  const inward = face.normal.clone().normalize().negate();
  const nudge = size * 1e-5;
  const values: number[] = [];
  const points = face.planar ? sampleFace(face, limit) : [pointOnFace(face), ...sampleFace(face, limit)];
  for (const point of points) {
    const hit = rayDistance(tris, point.clone().addScaledVector(inward, nudge), inward);
    if (hit !== null) values.push(hit + nudge);
  }
  return values;
}

function faceOf(topology: CadTopology, ref: Ref): CadFace | null {
  const match = typeof ref === 'string' ? /^F(\d+)$/.exec(ref) : null;
  return match ? (topology.faces[Number(match[1])] ?? null) : null;
}

function edgeOf(topology: CadTopology, ref: Ref): CadEdge | null {
  const match = typeof ref === 'string' ? /^E(\d+)$/.exec(ref) : null;
  return match ? (topology.edges[Number(match[1])] ?? null) : null;
}

export function measureExtra(
  request: ExtraMeasure,
  topology: CadTopology,
  mmPerUnit: number | null,
): string {
  const length = (value: number) =>
    mmPerUnit ? `${fmt(value)} units (${fmt(value * mmPerUnit)} mm)` : `${fmt(value)} units`;
  const refs = request.of;

  if (request.what === 'angle') {
    if (refs.length !== 2) return 'Select exactly two faces or edges to measure the angle between them.';
    const direction = (ref: Ref): { kind: 'plane' | 'line'; vector: Vector3 } | null => {
      const face = faceOf(topology, ref);
      if (face) return face.planar ? { kind: 'plane', vector: face.normal.clone().normalize() } : null;
      const edge = edgeOf(topology, ref);
      if (edge?.kind === 'line' && edge.start && edge.end) {
        return { kind: 'line', vector: edge.end.clone().sub(edge.start).normalize() };
      }
      return null;
    };
    const [a, b] = [direction(refs[0]), direction(refs[1])];
    if (!a || !b) return 'Angles need flat faces or straight edges.';
    const dot = Math.min(1, Math.abs(a.vector.dot(b.vector)));
    let degrees: number;
    if (a.kind === 'plane' && b.kind === 'plane') {
      degrees = (Math.acos(dot) * 180) / Math.PI;
      return `${String(refs[0])} and ${String(refs[1])}: ${fmt(degrees)}° between the planes (${fmt(180 - degrees)}° on the other side)`;
    }
    if (a.kind === 'line' && b.kind === 'line') {
      degrees = (Math.acos(dot) * 180) / Math.PI;
      return `${String(refs[0])} and ${String(refs[1])}: ${fmt(degrees)}° between the edges`;
    }
    degrees = (Math.asin(dot) * 180) / Math.PI;
    return `${String(refs[0])} and ${String(refs[1])}: ${fmt(degrees)}° between the edge and the face`;
  }

  if (request.what === 'volume' || request.what === 'mass') {
    const volume = meshVolume(topology);
    if (request.what === 'volume') {
      return mmPerUnit
        ? `Volume ${fmt(volume)} units³ (${fmt(volume * mmPerUnit ** 3)} mm³ = ${fmt((volume * mmPerUnit ** 3) / 1000)} cm³)`
        : `Volume ${fmt(volume)} units³. Set the real size above to get it in mm³.`;
    }
    if (!mmPerUnit) return 'Set the real length of the longest side (above the preview) to get a mass.';
    const word = (request.material ?? '').toLowerCase();
    const density = DENSITY[word];
    if (!density) {
      return `Which material? I know ${Object.keys(DENSITY).join(', ')}. For example: "mass in aluminum".`;
    }
    const cubic = (volume * mmPerUnit ** 3) / 1000;
    return `${word}: ${fmt(cubic * density)} g (${fmt(cubic)} cm³ at ${density} g/cm³)`;
  }

  if (request.what === 'surface_area') {
    const area = topology.faces.reduce((sum, face) => sum + face.area, 0);
    return mmPerUnit
      ? `Surface area ${fmt(area)} units² (${fmt(area * mmPerUnit ** 2)} mm²)`
      : `Surface area ${fmt(area)} units²`;
  }

  if (request.what === 'bbox') {
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const { a, b, c } of triangles(topology)) {
      for (const point of [a, b, c]) {
        min.min(point);
        max.max(point);
      }
    }
    const size = max.clone().sub(min);
    return `Bounding box: ${length(size.x)} (X) × ${length(size.y)} (Y) × ${length(size.z)} (Z)`;
  }

  if (request.what === 'holes') {
    const found = new Map<string, { radius: number; center: Vector3; count: number }>();
    for (const edge of topology.edges) {
      if (edge.kind !== 'circle' || !edge.radius || !edge.center) continue;
      const key = `${fmt(edge.radius)}|${edge.center.toArray().map((v) => Math.round(v / (topology.size * 1e-3))).join(',')}`;
      const entry = found.get(key);
      if (entry) entry.count += 1;
      else found.set(key, { radius: edge.radius, center: edge.center, count: 1 });
    }
    const rows = [...found.values()].sort((a, b) => a.radius - b.radius);
    if (rows.length === 0) return 'There are no round holes or circular edges.';
    const lines = rows
      .slice(0, 20)
      .map(
        (row) =>
          `Ø ${length(row.radius * 2)} at (${fmt(row.center.x)}, ${fmt(row.center.y)}, ${fmt(row.center.z)})`,
      );
    return `${rows.length} circular edge${rows.length === 1 ? '' : 's'}:\n${lines.join('\n')}${rows.length > 20 ? '\n…' : ''}`;
  }

  const tris = triangles(topology);

  if (request.what === 'thickness') {
    const lines: string[] = [];
    for (const ref of refs) {
      const face = faceOf(topology, ref);
      if (!face) {
        lines.push(`${String(ref)} is not a face; thickness is measured across a face.`);
        continue;
      }
      const values = thicknessOf(face, tris, topology.size, 40);
      if (values.length === 0) {
        lines.push(`${String(ref)}: no material found behind this face.`);
        continue;
      }
      const lo = Math.min(...values);
      const hi = Math.max(...values);
      lines.push(
        Math.abs(hi - lo) < topology.size * 1e-4
          ? `${String(ref)}: ${length(lo)} thick`
          : `${String(ref)}: ${length(lo)} to ${length(hi)} thick`,
      );
    }
    return lines.join('\n') || 'Select a face to measure the wall thickness behind it.';
  }

  // Printability: thin walls and overhangs, for building with +Z up.
  const threshold = request.threshold ?? (mmPerUnit ? 0.8 / mmPerUnit : topology.size * 0.01);
  const thin: { id: number; value: number }[] = [];
  let overhang = 0;
  const floor = Math.min(...topology.faces.map((face) => face.center.z));
  for (const face of topology.faces) {
    const values = thicknessOf(face, tris, topology.size, 12);
    const lowest = values.length ? Math.min(...values) : Infinity;
    if (lowest < threshold) thin.push({ id: face.id, value: lowest });
    if (face.planar && face.normal.z < -0.7071 && face.center.z > floor + topology.size * 1e-3) {
      overhang += face.area;
    }
  }
  const lines: string[] = [];
  lines.push(
    thin.length === 0
      ? `No walls thinner than ${length(threshold)}.`
      : `Thin walls (under ${length(threshold)}): ${thin
          .slice(0, 8)
          .map((item) => `F${item.id} (${fmt(item.value)})`)
          .join(', ')}${thin.length > 8 ? ', …' : ''}`,
  );
  lines.push(
    overhang === 0
      ? 'No overhangs steeper than 45° when printed with +Z up.'
      : `Overhangs beyond 45° (printed +Z up): ${fmt(overhang)} units² of downward-facing surface above the bed.`,
  );
  if (!mmPerUnit) lines.push('(No real size set, so the wall limit is 1% of the part size.)');
  return lines.join('\n');
}

