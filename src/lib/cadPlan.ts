import { Vector3 } from 'three';
import type { CadOp } from '../../shared/chatAi.ts';
import { EXTRA_MEASURES, measureExtra, type ExtraMeasure } from './cadMeasure.ts';
import {
  axisName,
  edgePoint,
  planeFromEdges,
  pointOnEdge,
  pointOnFace,
  pointOnFaceNear,
  type CadEdge,
  type CadFace,
  type CadSelection,
  type CadTopology,
  describeItem,
  faceContains,
  faceExtent,
} from './cadTopology.ts';

// The planner names faces and edges and geometric relations; this turns them
// into numbers using the topology recovered from the rendered mesh. Everything
// here is deterministic, so a plan either resolves exactly or fails with a
// readable reason.

type Ref = string | { facing: string };
/** A size written as a number, or taken from an existing round feature. */
type Quantity = number | { same_as: Ref; what: 'diameter' | 'radius' };
type Point =
  | { vertex: Ref }
  | { along: Ref; fraction: number; from?: string }
  | { along: Ref; distance: number; from: string }
  | { center_of: Ref }
  | { edge: Ref }
  | { face: Ref }
  | { midway: [Ref, Ref] }
  | { center: true };
type PlanePlan =
  | { kind: 'through_points'; points: [Point, Point, Point] }
  | { kind: 'edge_and_point'; edge: Ref; point: Point }
  | { kind: 'edge_at_angle'; edge: Ref; face: Ref; angle: number }
  | { kind: 'tangent_to_face'; face: Ref; side: string }
  | { kind: 'through_axis'; of: Ref; direction: string }
  | { kind: 'middle_of'; of: Ref[]; axis: 'x' | 'y' | 'z' }
  | { kind: 'rotated'; base: PlanePlan; about: 'x' | 'y' | 'z' | Ref; angle: number }
  | { kind: 'face'; face: Ref }
  | { kind: 'through_edges'; edges: [Ref, Ref] }
  | { kind: 'parallel_to_face'; face: Ref; through: Point }
  | { kind: 'axis'; axis: 'x' | 'y' | 'z'; at?: 'center' | number }
  | { kind: 'across_edge'; edge: Ref; through?: Point }
  | { kind: 'offset'; base: PlanePlan; distance: number; direction: string };

type SketchProfile = {
  shape: 'rect' | 'circle' | 'slot';
  width?: number;
  height?: number;
  diameter?: number;
};

type HolePlan = {
  op: 'hole';
  face: Ref;
  diameter?: Quantity;
  depth: number | null;
  at?: Point;
  style?: 'simple' | 'counterbore' | 'countersink';
  head_diameter?: number;
  head_depth?: number;
  angle?: number;
  /** A metric screw size such as "M3"; sets the diameters from standard tables. */
  metric?: string;
  fit?: 'clearance' | 'tap';
};
type PocketPlan = { op: 'pocket'; face: Ref; at?: Point; profile: SketchProfile; depth: number | null; rotation?: number };
type BossPlan = { op: 'boss'; face: Ref; at?: Point; profile: SketchProfile; height: number; rotation?: number };
type TextPlan = {
  op: 'text';
  face: Ref;
  at?: Point;
  text: string;
  size?: number;
  depth: number;
  mode: 'emboss' | 'engrave';
  rotation?: number;
};
type Repeatable = HolePlan | PocketPlan | BossPlan | TextPlan;

export type PlannedOp =
  | { op: 'cut'; plane: PlanePlan; keep?: string }
  | HolePlan
  | PocketPlan
  | BossPlan
  | TextPlan
  | { op: 'shell'; thickness: number; open: Ref[] }
  | { op: 'offset_face'; face: Ref; distance: number }
  | { op: 'remove'; targets: Ref[] }
  | { op: 'rib'; edge: Ref; at?: Point; thickness: number; size: number }
  | { op: 'draft'; faces: Ref[]; angle: number; pull: string }
  /** `version` counts saved versions in this conversation from 1 (the oldest). */
  | { op: 'combine'; mode: 'union' | 'subtract' | 'intersect'; version: number }
  | {
      op: 'pattern';
      of: Repeatable;
      count: number;
      kind: 'linear' | 'circular';
      spacing?: number;
      direction?: string | { edge: Ref };
      around?: 'x' | 'y' | 'z' | Ref;
      angle?: number;
    }
  | { op: 'fillet'; edges: Ref[]; radius: Quantity }
  | { op: 'chamfer'; edges: Ref[]; distance: Quantity }
  | { op: 'stretch'; between: [Ref, Ref]; distance: number }
  | { op: 'fill'; targets: Ref[] }
  | { op: 'scale'; factor: number }
  | { op: 'translate'; vector: [number, number, number] }
  | { op: 'mirror'; plane: PlanePlan };

export type MeasureRequest = {
  what: 'radius' | 'diameter' | 'length' | 'area' | 'distance' | 'center' | ExtraMeasure['what'];
  of: Ref[];
  material?: string | null;
  threshold?: number | null;
};

export type MarkRequest = {
  face: Ref;
  shape: 'circle';
  /** Null for "a dot" with no size given; a small default is used. */
  diameter: number | null;
  at:
    | { center: true }
    | { offsets: { from: string; distance: number }[] };
};

export type MarkerAction = { action: 'drill' | 'clear'; depth: number | null };

/** A non-destructive preview patch on a planar face, in the topology's frame. */
export type Marker = {
  faceId: number;
  origin: Vector3;
  normal: Vector3;
  diameter: number;
  /** False when the centre falls outside the face's outline. */
  inside: boolean;
};

export type CadPlan =
  | { intent: 'mark'; ops: []; mark: MarkRequest; message?: string }
  | { intent: 'marker'; ops: []; marker: MarkerAction; message?: string }
  | { intent: 'measure'; ops: []; measure: MeasureRequest; message?: string }
  | { intent: 'ops'; ops: PlannedOp[]; message?: string }
  | { intent: 'model'; ops: []; message?: string }
  | { intent: 'clarify'; ops: []; message: string };

type Resolved = { ops: CadOp[] } | { error: string };

// Standard metric screw sizes in millimetres: [clearance hole, tap drill,
// socket-head diameter, socket-head height, flat-head (countersunk) diameter].
const METRIC: Record<string, [number, number, number, number, number]> = {
  M2: [2.4, 1.6, 3.8, 2, 4.4],
  'M2.5': [2.9, 2.05, 4.5, 2.5, 5.5],
  M3: [3.4, 2.5, 5.5, 3, 6.3],
  M4: [4.5, 3.3, 7, 4, 8.4],
  M5: [5.5, 4.2, 8.5, 5, 10.4],
  M6: [6.6, 5, 10, 6, 12.6],
  M8: [9, 6.8, 13, 8, 17.3],
  M10: [11, 8.5, 16, 10, 20],
  M12: [13.5, 10.2, 18, 12, 24],
};

class PlanError extends Error {}

const AXES: Record<string, Vector3> = {
  '+X': new Vector3(1, 0, 0),
  '-X': new Vector3(-1, 0, 0),
  '+Y': new Vector3(0, 1, 0),
  '-Y': new Vector3(0, -1, 0),
  '+Z': new Vector3(0, 0, 1),
  '-Z': new Vector3(0, 0, -1),
};

function tuple(vector: Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z];
}

/** Context handed to the planner: size, the selection, and the planar faces. */
export function buildPlanContext(
  topology: CadTopology,
  selection: CadSelection[],
  marker: Marker | null = null,
  /** How many saved versions this conversation has, so "version 2" can be checked. */
  versionCount = 0,
): string {
  const selected =
    selection.length > 0
      ? selection.map((item) => describeItem(topology, item)).join('; ')
      : 'none';
  const faces = [...topology.faces]
    .filter((face) => face.planar)
    .sort((a, b) => b.area - a.area)
    .slice(0, 40)
    .map((face) => `F${face.id} ${axisName(face.normal) ?? 'angled'}`)
    .join(', ');
  const markerText = marker
    ? `A marker is currently placed: circle diameter ${Number(marker.diameter.toPrecision(3))} on F${marker.faceId}.\n`
    : '';
  const versions = versionCount > 1 ? `Saved versions: ${versionCount} (1 is the oldest).\n` : '';
  return `Part size ${Number(topology.size.toPrecision(3))}. Selected: ${selected}.\nFaces: ${faces}.\n${markerText}${versions}`;
}

const MM_PER: Record<string, number> = {
  mm: 1,
  millimeter: 1,
  millimeters: 1,
  cm: 10,
  centimeter: 10,
  centimeters: 10,
  m: 1000,
  in: 25.4,
  inch: 25.4,
  inches: 25.4,
};
const UNIT_TOKEN = /(\d+(?:\.\d+)?)\s*(millimeters?|centimeters?|inches|inch|mm|cm|in|m)\b/gi;

/** True when the text gives a length in real units such as "5mm". */
export function hasPhysicalUnits(text: string): boolean {
  return new RegExp(UNIT_TOKEN.source, 'i').test(text);
}

/**
 * Rewrite lengths such as "5mm" into model units before planning, so the
 * language model never does unit arithmetic. `mmPerUnit` is the real size of
 * one model unit.
 */
export function convertUnits(text: string, mmPerUnit: number): string {
  return text.replace(UNIT_TOKEN, (_match, value: string, unit: string) => {
    const millimetres = Number(value) * (MM_PER[unit.toLowerCase()] ?? 1);
    return String(Number((millimetres / mmPerUnit).toPrecision(4)));
  });
}

const DIRECTIONS: Record<string, string> = {
  left: '-X',
  right: '+X',
  front: '-Y',
  back: '+Y',
  behind: '+Y',
  above: '+Z',
  up: '+Z',
  upward: '+Z',
  upwards: '+Z',
  below: '-Z',
  down: '-Z',
  downward: '-Z',
  downwards: '-Z',
};
const OFFSET_DIRECTION =
  /(\d+(?:\.\d+)?)\s*(?:units?\s+)?(?:(?:to|on|towards?)\s+the\s+|in\s+)?(left|right|front|back|behind|above|below|upwards?|downwards?|up|down)\b(?:\s+of(?:\s+(?:it|that|this|the\s+plane))?)?/gi;

const HALF_WORDS: Record<string, string> = { ...DIRECTIONS, upper: '+Z', lower: '-Z', top: '+Z', bottom: '-Z' };
const OPPOSITE: Record<string, string> = { '+X': '-X', '-X': '+X', '+Y': '-Y', '-Y': '+Y', '+Z': '-Z', '-Z': '+Z' };
const KEEP_HALF =
  /\bkeep\s+(?:only\s+)?(?:the\s+)?(left|right|front|back|top|bottom|upper|lower)\s+(?:half|part|piece|side|portion)\b/gi;
const REMOVE_HALF =
  /\b(?:remove|delete|discard|cut\s+off|chop\s+off|get\s+rid\s+of)\s+(?:the\s+)?(left|right|front|back|top|bottom|upper|lower)\s+(?:half|part|piece|side|portion)\b/gi;

/**
 * Turn "0.05 to the left of it" into "0.05 toward -X" so the planner copies an
 * axis instead of interpreting a direction word. "Keep the left half" and
 * "remove the top half" become "keep -X" and "keep -Z" the same way.
 */
export function normalizeDirections(text: string): string {
  return text
    .replace(KEEP_HALF, (_match, word: string) => `keep ${HALF_WORDS[word.toLowerCase()]}`)
    .replace(
      REMOVE_HALF,
      (_match, word: string) => `keep ${OPPOSITE[HALF_WORDS[word.toLowerCase()]]}`,
    )
    .replace(
    OFFSET_DIRECTION,
    (_match, distance: string, word: string) =>
      `${distance} toward ${DIRECTIONS[word.toLowerCase()]}`,
  );
}

export function resolvePlan(
  plan: PlannedOp[],
  topology: CadTopology,
  /** Offset from the centred preview frame back to the CAD shape's own frame. */
  shapeCenter: Vector3,
  /** Millimetres per model unit; needed only for metric screw sizes. */
  mmPerUnit: number | null = null,
  /** Message ids of the saved versions on this branch, oldest first, for `combine`. */
  versionIds: string[] = [],
): Resolved {
  const toShape = (point: Vector3) => tuple(point.clone().add(shapeCenter));

  const face = (ref: Ref): CadFace => {
    if (typeof ref === 'string') {
      const found = /^F(\d+)$/.exec(ref) && topology.faces[Number(ref.slice(1))];
      if (!found) throw new PlanError(`There is no face ${ref}.`);
      return found;
    }
    const candidates = topology.faces
      .filter((candidate) => candidate.planar && axisName(candidate.normal) === ref.facing)
      .sort((a, b) => b.area - a.area);
    if (candidates.length === 0) throw new PlanError(`No planar face points ${ref.facing}.`);
    return candidates[0];
  };

  const edge = (ref: Ref): CadEdge => {
    const found = typeof ref === 'string' && /^E(\d+)$/.exec(ref) && topology.edges[Number(ref.slice(1))];
    if (!found) throw new PlanError(`There is no edge ${String(ref)}.`);
    return found;
  };

  const vertex = (ref: Ref): Vector3 => {
    const found = typeof ref === 'string' && /^V(\d+)$/.exec(ref) && topology.vertices[Number(ref.slice(1))];
    if (!found) throw new PlanError(`There is no corner ${String(ref)}.`);
    return found.point.clone();
  };

  const anyPoint = (ref: Ref): Vector3 => {
    if (typeof ref === 'string' && ref.startsWith('V')) return vertex(ref);
    return typeof ref === 'string' && ref.startsWith('E') ? edgePoint(edge(ref)) : face(ref).center.clone();
  };

  /** The circular edges of a hole: the edge itself, or those bounding a curved face. */
  const roundEdges = (ref: Ref): CadEdge[] => {
    if (typeof ref === 'string' && ref.startsWith('E')) {
      const found = edge(ref);
      return found.kind === 'circle' || found.kind === 'arc' ? [found] : [];
    }
    const target = face(ref);
    return topology.edges.filter(
      (candidate) =>
        (candidate.kind === 'circle' || candidate.kind === 'arc') &&
        candidate.faces.includes(target.id),
    );
  };

  const centerOf = (ref: Ref): Vector3 => {
    const rounds = roundEdges(ref).filter((round) => round.center);
    if (rounds.length === 0) {
      throw new PlanError(`${String(ref)} is not round, so it has no centre.`);
    }
    return rounds
      .reduce((sum, round) => sum.add(round.center as Vector3), new Vector3())
      .divideScalar(rounds.length);
  };

  const quantity = (value: Quantity): number => {
    if (typeof value === 'number') return value;
    const radius = roundEdges(value.same_as).find((round) => round.radius)?.radius;
    if (!radius) throw new PlanError(`${String(value.same_as)} is not round, so it has no ${value.what}.`);
    return value.what === 'diameter' ? radius * 2 : radius;
  };

  const alongEdge = (spec: { along: Ref; fraction?: number; distance?: number; from?: string }): Vector3 => {
    const target = edge(spec.along);
    if (target.kind !== 'line' || !target.start || !target.end) {
      throw new PlanError(`E${target.id} is not a straight edge, so a position along it is not defined.`);
    }
    let from = target.start;
    let to = target.end;
    if (typeof spec.from === 'string' && spec.from.startsWith('V')) {
      const corner = vertex(spec.from);
      if (corner.distanceTo(target.end) < corner.distanceTo(target.start)) [from, to] = [to, from];
    } else if (spec.from === 'end') {
      [from, to] = [to, from];
    }
    const fraction =
      spec.fraction !== undefined ? spec.fraction : (spec.distance ?? 0) / (target.length || 1);
    if (fraction < 0 || fraction > 1) {
      throw new PlanError(`That is outside E${target.id}, which is ${Number(target.length.toPrecision(4))} long.`);
    }
    return from.clone().lerp(to, fraction);
  };

  const point = (spec: Point): Vector3 => {
    if ('vertex' in spec) return vertex(spec.vertex);
    if ('along' in spec) return alongEdge(spec);
    if ('center_of' in spec) return centerOf(spec.center_of);
    if ('edge' in spec) return edgePoint(edge(spec.edge));
    if ('face' in spec) return face(spec.face).center.clone();
    if ('midway' in spec) {
      return anyPoint(spec.midway[0]).add(anyPoint(spec.midway[1])).multiplyScalar(0.5);
    }
    return new Vector3(0, 0, 0); // the preview frame is centred on the part
  };

  /** Axis of a round feature (a hole, boss or round edge), from its circular edges. */
  const axisOf = (ref: Ref): { point: Vector3; direction: Vector3; radius: number } => {
    const rounds = roundEdges(ref).filter((round) => round.center && round.radius);
    if (rounds.length === 0) throw new PlanError(`${String(ref)} is not round, so it has no axis.`);
    const [first] = rounds;
    const center = first.center as Vector3;
    const quarter = Math.floor(first.segments.length / 4) * 2;
    const direction = first.segments[0]
      .clone()
      .sub(center)
      .cross(first.segments[quarter].clone().sub(center));
    const other = rounds.find((round) => round.center && round.center.distanceTo(center) > topology.size * 1e-3);
    if (other?.center) direction.copy(other.center.clone().sub(center));
    if (direction.lengthSq() < 1e-18) throw new PlanError(`The axis of ${String(ref)} could not be found.`);
    return { point: center, direction: direction.normalize(), radius: first.radius as number };
  };

  const straight = (ref: Ref): { start: Vector3; direction: Vector3 } => {
    const found = edge(ref);
    if (found.kind !== 'line' || !found.start || !found.end) {
      throw new PlanError(`E${found.id} is not a straight edge.`);
    }
    return { start: found.start.clone(), direction: found.end.clone().sub(found.start).normalize() };
  };

  const bounds = (ref: Ref, axis: Vector3): { min: number; max: number } => {
    if (typeof ref === 'string' && ref.startsWith('E')) {
      const values = edge(ref).segments.map((end) => end.dot(axis));
      return { min: Math.min(...values), max: Math.max(...values) };
    }
    if (typeof ref === 'string' && ref.startsWith('V')) {
      const value = vertex(ref).dot(axis);
      return { min: value, max: value };
    }
    return faceExtent(face(ref), axis);
  };

  const planeOf = (spec: PlanePlan): { origin: Vector3; normal: Vector3 } => {
    if (spec.kind === 'through_points') {
      const [a, b, c] = spec.points.map(point);
      const normal = b.clone().sub(a).cross(c.clone().sub(a));
      if (normal.lengthSq() < topology.size ** 2 * 1e-12) {
        throw new PlanError('The three points are on one line, so they do not define a plane.');
      }
      return { origin: a, normal: normal.normalize() };
    }
    if (spec.kind === 'edge_and_point') {
      const line = straight(spec.edge);
      const target = point(spec.point);
      const normal = line.direction.clone().cross(target.clone().sub(line.start));
      if (normal.lengthSq() < topology.size ** 2 * 1e-12) {
        throw new PlanError('The point lies on the edge, so the plane is not defined; name another point.');
      }
      return { origin: line.start, normal: normal.normalize() };
    }
    if (spec.kind === 'edge_at_angle') {
      const line = straight(spec.edge);
      const target = face(spec.face);
      if (!target.planar) throw new PlanError(`F${target.id} is not planar.`);
      const flat = target.normal.clone().addScaledVector(line.direction, -target.normal.dot(line.direction));
      if (flat.lengthSq() < 1e-12) throw new PlanError(`E${edge(spec.edge).id} is perpendicular to F${target.id}, so an angle to it is not defined.`);
      const normal = flat.normalize().applyAxisAngle(line.direction, (spec.angle * Math.PI) / 180);
      return { origin: line.start, normal };
    }
    if (spec.kind === 'tangent_to_face') {
      const axis = axisOf(spec.face);
      const wanted = AXES[spec.side];
      if (!wanted) throw new PlanError(`Say which side to touch (left, right, front, back, top or bottom), not "${spec.side}".`);
      const radial = wanted.clone().addScaledVector(axis.direction, -wanted.dot(axis.direction));
      if (radial.lengthSq() < 1e-6) {
        throw new PlanError(`${spec.side} runs along the axis of ${String(spec.face)}, so no side of it faces that way.`);
      }
      radial.normalize();
      return { origin: axis.point.clone().addScaledVector(radial, axis.radius), normal: radial };
    }
    if (spec.kind === 'through_axis') {
      const axis = axisOf(spec.of);
      const along = AXES[spec.direction];
      if (!along) throw new PlanError(`Unknown direction ${spec.direction}.`);
      const normal = axis.direction.clone().cross(along);
      if (normal.lengthSq() < 1e-6) {
        throw new PlanError(`${spec.direction} is parallel to the axis of ${String(spec.of)}; pick another direction for the section.`);
      }
      return { origin: axis.point, normal: normal.normalize() };
    }
    if (spec.kind === 'middle_of') {
      const direction = AXES[`+${spec.axis.toUpperCase()}`];
      const extents = spec.of.map((ref) => bounds(ref, direction));
      const low = Math.min(...extents.map((extent) => extent.min));
      const high = Math.max(...extents.map((extent) => extent.max));
      return { origin: direction.clone().multiplyScalar((low + high) / 2), normal: direction.clone() };
    }
    if (spec.kind === 'rotated') {
      const base = planeOf(spec.base);
      let pivot: Vector3;
      let direction: Vector3;
      if (typeof spec.about === 'string' && spec.about.startsWith('E')) {
        const line = straight(spec.about);
        pivot = line.start;
        direction = line.direction;
      } else {
        pivot = base.origin.clone();
        direction = AXES[`+${String(spec.about).toUpperCase()}`];
        if (!direction) throw new PlanError(`Cannot rotate about ${String(spec.about)}.`);
      }
      const radians = (spec.angle * Math.PI) / 180;
      return {
        origin: pivot.clone().add(base.origin.clone().sub(pivot).applyAxisAngle(direction, radians)),
        normal: base.normal.clone().applyAxisAngle(direction, radians),
      };
    }
    if (spec.kind === 'face') {
      const target = face(spec.face);
      if (!target.planar) throw new PlanError(`F${target.id} is not planar.`);
      return { origin: target.center.clone(), normal: target.normal.clone() };
    }
    if (spec.kind === 'through_edges') {
      const plane = planeFromEdges(topology, edge(spec.edges[0]), edge(spec.edges[1]));
      if ('error' in plane) throw new PlanError(plane.error);
      return { origin: plane.origin, normal: plane.normal };
    }
    if (spec.kind === 'parallel_to_face') {
      const target = face(spec.face);
      if (!target.planar) throw new PlanError(`F${target.id} is not planar.`);
      return { origin: point(spec.through), normal: target.normal.clone() };
    }
    if (spec.kind === 'across_edge') {
      // Perpendicular to the edge's direction at its middle; through a given
      // point when one is named, otherwise through the edge's midpoint.
      const target = edge(spec.edge);
      const index = Math.floor(target.segments.length / 4) * 2;
      const normal =
        target.kind === 'line' && target.start && target.end
          ? target.end.clone().sub(target.start)
          : target.segments[index + 1].clone().sub(target.segments[index]);
      if (normal.lengthSq() < 1e-18) throw new PlanError(`E${target.id} has no direction to cross.`);
      return {
        origin: spec.through ? point(spec.through) : pointOnEdge(target),
        normal: normal.normalize(),
      };
    }
    if (spec.kind === 'offset') {
      const base = planeOf(spec.base);
      const direction = AXES[spec.direction];
      if (!direction) throw new PlanError(`Unknown direction ${spec.direction}.`);
      if (Math.abs(base.normal.clone().normalize().dot(direction)) < 0.1) {
        throw new PlanError(
          `Moving the plane ${spec.direction} would not change it, because that direction lies in the plane.`,
        );
      }
      return {
        origin: base.origin.clone().addScaledVector(direction, spec.distance),
        normal: base.normal,
      };
    }
    const normal = AXES[`+${spec.axis.toUpperCase()}`].clone();
    return {
      origin: normal.clone().multiplyScalar(typeof spec.at === 'number' ? spec.at : 0),
      normal,
    };
  };

  /** Where a feature goes on a planar face: the named point projected onto it, or its centre. */
  const anchorOn = (target: CadFace, at: Point | undefined): Vector3 => {
    // The centre of a face with a pocket or hole in it can lie in the empty space.
    if (!at) {
      return faceContains(target, target.center, topology.size * 1e-3)
        ? target.center.clone()
        : pointOnFaceNear(target, target.center);
    }
    const wanted = point(at);
    const normal = target.normal.clone().normalize();
    return wanted.clone().addScaledVector(normal, -normal.dot(wanted.clone().sub(target.center)));
  };

  const planarFace = (ref: Ref, what: string): CadFace => {
    const target = face(ref);
    if (!target.planar) throw new PlanError(`F${target.id} is not planar, so ${what} cannot go there.`);
    return target;
  };

  const profileOf = (shape: SketchProfile) => {
    if (shape.shape === 'circle') return { profile: 'circle' as const, diameter: shape.diameter };
    return { profile: shape.shape, width: shape.width, height: shape.height };
  };

  const holeOp = (step: HolePlan): Extract<CadOp, { type: 'hole' }> => {
    const target = planarFace(step.face, 'a hole');
    let diameter = step.diameter === undefined ? undefined : quantity(step.diameter);
    const style = step.style;
    let headDiameter = step.head_diameter;
    let headDepth = step.head_depth;
    if (step.metric) {
      const row = METRIC[step.metric];
      if (!row) throw new PlanError(`${step.metric} is not a supported screw size (M2 to M12).`);
      if (!mmPerUnit) {
        throw new PlanError(
          'Set the real length of the part\'s longest side (above the preview) so metric sizes like M3 can be converted.',
        );
      }
      diameter = (step.fit === 'tap' ? row[1] : row[0]) / mmPerUnit;
      if (style === 'counterbore') {
        headDiameter = row[2] / mmPerUnit;
        headDepth = row[3] / mmPerUnit;
      } else if (style === 'countersink') {
        headDiameter = row[4] / mmPerUnit;
      }
    }
    if (diameter === undefined) throw new PlanError('The hole needs a diameter or a metric size such as M3.');
    return {
      type: 'hole',
      origin: toShape(anchorOn(target, step.at)),
      normal: tuple(target.normal),
      diameter,
      depth: step.depth,
      ...(style && style !== 'simple'
        ? { style, head_diameter: headDiameter, head_depth: headDepth, angle: step.angle }
        : {}),
    };
  };

  const sketchOp = (step: PocketPlan | BossPlan | TextPlan) => {
    const target = planarFace(step.face, step.op === 'text' ? 'text' : `a ${step.op}`);
    return { target, origin: toShape(anchorOn(target, step.at)), normal: tuple(target.normal) };
  };

  const repeatable = (step: Repeatable): Extract<CadOp, { type: 'pattern' }>['of'] => {
    if (step.op === 'hole') return holeOp(step);
    const { origin, normal } = sketchOp(step);
    if (step.op === 'pocket') {
      return { type: 'pocket', origin, normal, ...profileOf(step.profile), depth: step.depth, rotation: step.rotation };
    }
    if (step.op === 'boss') {
      return { type: 'boss', origin, normal, ...profileOf(step.profile), depth: step.height, rotation: step.rotation };
    }
    return {
      type: 'text',
      origin,
      normal,
      text: step.text,
      size: step.size,
      distance: step.mode === 'engrave' ? -step.depth : step.depth,
      rotation: step.rotation,
    };
  };

  const keepOf = (keep: string | undefined, plane: { origin: Vector3; normal: Vector3 }) => {
    if (!keep || keep === 'split') return 'split' as const;
    const direction = AXES[keep]
      ? AXES[keep]
      : face(keep).center.clone().sub(plane.origin);
    return plane.normal.dot(direction) >= 0 ? ('positive' as const) : ('negative' as const);
  };

  try {
    const ops: CadOp[] = [];
    for (const step of plan) {
      if (step.op === 'cut') {
        const plane = planeOf(step.plane);
        ops.push({
          type: 'cut',
          origin: toShape(plane.origin),
          normal: tuple(plane.normal.clone().normalize()),
          keep: keepOf(step.keep, plane),
        });
      } else if (step.op === 'mirror') {
        const plane = planeOf(step.plane);
        ops.push({
          type: 'mirror',
          origin: toShape(plane.origin),
          normal: tuple(plane.normal.clone().normalize()),
        });
      } else if (step.op === 'hole') {
        ops.push(holeOp(step));
      } else if (step.op === 'pocket' || step.op === 'boss' || step.op === 'text') {
        ops.push(repeatable(step));
      } else if (step.op === 'pattern') {
        if (step.count < 2 || step.count > 64) throw new PlanError('A pattern needs between 2 and 64 copies.');
        const of = repeatable(step.of);
        if (step.kind === 'linear') {
          const direction =
            typeof step.direction === 'object' && step.direction
              ? straight(step.direction.edge).direction
              : AXES[String(step.direction)]?.clone();
          if (!direction) throw new PlanError('Say which way the copies go, for example "+X" or along an edge.');
          if (!step.spacing) throw new PlanError('A linear pattern needs the spacing between copies.');
          ops.push({
            type: 'pattern', of, count: step.count, kind: 'linear',
            vector: tuple(direction), distance: step.spacing,
          });
        } else {
          let center: Vector3;
          let axis: Vector3;
          if (step.around === 'x' || step.around === 'y' || step.around === 'z') {
            axis = AXES[`+${step.around.toUpperCase()}`].clone();
            center = new Vector3(0, 0, 0);
          } else if (step.around) {
            const found = axisOf(step.around);
            axis = found.direction;
            center = found.point;
          } else {
            throw new PlanError('Say what to go around: an axis (x, y, z) or a round hole or boss.');
          }
          ops.push({
            type: 'pattern', of, count: step.count, kind: 'circular',
            origin: toShape(center), normal: tuple(axis), angle: step.angle,
          });
        }
      } else if (step.op === 'shell') {
        if (step.open.length === 0) throw new PlanError('Say which face(s) to leave open.');
        ops.push({
          type: 'shell',
          thickness: step.thickness,
          points: step.open.map((ref) => toShape(pointOnFace(face(ref)))),
        });
      } else if (step.op === 'offset_face') {
        const target = planarFace(step.face, 'moving it');
        ops.push({ type: 'offset_face', points: [toShape(pointOnFace(target))], distance: step.distance });
      } else if (step.op === 'remove') {
        ops.push({
          type: 'delete',
          points: step.targets.map((ref) =>
            typeof ref === 'string' && ref.startsWith('E')
              ? toShape(pointOnEdge(edge(ref)))
              : toShape(pointOnFace(face(ref))),
          ),
        });
      } else if (step.op === 'rib') {
        const corner = edge(step.edge);
        const line = straight(step.edge);
        const [a, b] = corner.faces.map((id) => topology.faces[id]);
        if (!a?.planar || !b?.planar) throw new PlanError(`E${corner.id} must be the corner between two flat faces.`);
        const wanted = step.at ? point(step.at) : edgePoint(corner);
        const along = wanted.clone().sub(line.start).dot(line.direction);
        if (along < 0 || along > corner.length) {
          throw new PlanError(`That position is outside E${corner.id}, which is ${Number(corner.length.toPrecision(4))} long.`);
        }
        ops.push({
          type: 'rib',
          origin: toShape(line.start.clone().addScaledVector(line.direction, along)),
          vector: tuple(line.direction),
          normal: tuple(a.normal),
          normal2: tuple(b.normal),
          thickness: step.thickness,
          size: step.size,
        });
      } else if (step.op === 'combine') {
        const id = versionIds[step.version - 1];
        if (!id) throw new PlanError(`There is no version ${step.version}; this conversation has ${versionIds.length}.`);
        if (step.version === versionIds.length) {
          throw new PlanError('That is the version you are looking at; name an earlier one to combine with.');
        }
        ops.push({ type: 'combine', mode: step.mode, versionId: id });
      } else if (step.op === 'draft') {
        const pull = AXES[step.pull];
        if (!pull) throw new PlanError('Say the pull direction, for example +Z.');
        if (step.faces.length === 0) throw new PlanError('Select the faces to draft.');
        // Each face tapers about its own lowest edge along the pull direction.
        const base = Math.min(...step.faces.map((ref) => faceExtent(face(ref), pull).min));
        ops.push({
          type: 'draft',
          origin: toShape(pull.clone().multiplyScalar(base)),
          normal: tuple(pull),
          angle: step.angle,
          points: step.faces.map((ref) => toShape(pointOnFace(face(ref)))),
        });
      } else if (step.op === 'fillet' || step.op === 'chamfer') {
        const points = step.edges.map((ref) => tuple(pointOnEdge(edge(ref)).add(shapeCenter)));
        ops.push(
          step.op === 'fillet'
            ? { type: 'fillet', points, radius: quantity(step.radius) }
            : { type: 'chamfer', points, distance: quantity(step.distance) },
        );
      } else if (step.op === 'fill') {
        const points = step.targets.map((ref) =>
          typeof ref === 'string' && ref.startsWith('E')
            ? tuple(pointOnEdge(edge(ref)).add(shapeCenter))
            : tuple(pointOnFace(face(ref)).add(shapeCenter)),
        );
        ops.push({ type: 'fill', points });
      } else if (step.op === 'stretch') {
        const [a, b] = [face(step.between[0]), face(step.between[1])];
        if (!a.planar || !b.planar || Math.abs(a.normal.dot(b.normal)) < 0.999) {
          throw new PlanError('Stretching needs two parallel planar faces.');
        }
        const axis = a.normal.clone().normalize();
        const gap = axis.dot(b.center.clone().sub(a.center));
        // Point from the first face toward the second, so "extend" widens the gap.
        const normal = gap >= 0 ? axis : axis.clone().negate();
        const separation = Math.abs(gap);
        if (separation < topology.size * 1e-6) throw new PlanError('The two faces are in the same plane.');
        if (step.distance < 0 && -step.distance >= separation) {
          throw new PlanError(`The faces are only ${Number(separation.toPrecision(4))} apart, so they cannot be brought closer by ${-step.distance}.`);
        }
        ops.push({
          type: 'stretch',
          origin: toShape(a.center.clone().add(b.center).multiplyScalar(0.5)),
          normal: tuple(normal),
          distance: step.distance,
        });
      } else if (step.op === 'scale') {
        ops.push({ type: 'scale', factor: step.factor, origin: tuple(shapeCenter) });
      } else {
        ops.push({ type: 'translate', vector: step.vector });
      }
    }
    return { ops };
  } catch (error) {
    if (error instanceof PlanError) return { error: error.message };
    throw error;
  }
}

/** One readable line describing what a plan will do. */
function sizeText(value: Quantity | undefined): string {
  if (value === undefined) return 'metric';
  return typeof value === 'number' ? String(value) : `the ${value.what} of ${String(value.same_as)}`;
}

export function describePlan(plan: PlannedOp[]): string {
  return plan
    .map((step) => {
      switch (step.op) {
        case 'cut':
          return step.keep && step.keep !== 'split' ? `cut (keep ${step.keep})` : 'cut and split';
        case 'hole':
          return `drill a ${step.metric ?? sizeText(step.diameter)} ${step.style && step.style !== 'simple' ? `${step.style} ` : ''}hole${step.depth === null ? ' through' : ''}`;
        case 'fillet':
          return `fillet ${step.edges.length} edge(s) by ${sizeText(step.radius)}`;
        case 'chamfer':
          return `chamfer ${step.edges.length} edge(s) by ${sizeText(step.distance)}`;
        case 'fill':
          return `fill ${step.targets.length} hole(s)`;
        case 'stretch':
          return `${step.distance >= 0 ? 'extend' : 'shrink'} the distance by ${Math.abs(step.distance)}`;
        case 'scale':
          return `scale by ${step.factor}`;
        case 'translate':
          return `move by (${step.vector.join(', ')})`;
        case 'pocket':
          return `cut a ${step.profile.shape} pocket${step.depth === null ? ' through' : ''}`;
        case 'boss':
          return `add a ${step.profile.shape} boss ${step.height} tall`;
        case 'text':
          return `${step.mode === 'engrave' ? 'engrave' : 'emboss'} "${step.text}"`;
        case 'shell':
          return `hollow out with ${step.thickness} walls`;
        case 'offset_face':
          return `move a face ${step.distance >= 0 ? 'out' : 'in'} by ${Math.abs(step.distance)}`;
        case 'remove':
          return `remove ${step.targets.length} feature face(s)`;
        case 'rib':
          return `add a rib ${step.thickness} thick`;
        case 'draft':
          return `draft ${step.faces.length} face(s) by ${step.angle} degrees`;
        case 'combine':
          return `${step.mode} with version ${step.version}`;
        case 'pattern':
          return `repeat ${step.count} times (${step.kind})`;
        default:
          return 'mirror';
      }
    })
    .join(', then ');
}

const fmt = (value: number) => Number(value.toPrecision(4));

/**
 * Answer a geometry question from the recovered topology. Lengths are in model
 * units, with millimetres added when the real part size is known.
 */
export function measure(
  input: MeasureRequest,
  topology: CadTopology,
  mmPerUnit: number | null,
): string {
  if ((EXTRA_MEASURES as string[]).includes(input.what)) {
    return measureExtra(input as ExtraMeasure, topology, mmPerUnit);
  }
  // "How thick between these two faces" arrives as a length of two faces.
  const request: MeasureRequest =
    input.what === 'length' &&
    input.of.length === 2 &&
    input.of.every((ref) => typeof ref === 'string' && ref.startsWith('F'))
      ? { ...input, what: 'distance' }
      : input;
  const length = (value: number) =>
    mmPerUnit ? `${fmt(value)} units (${fmt(value * mmPerUnit)} mm)` : `${fmt(value)} units`;
  const areaText = (value: number) =>
    mmPerUnit
      ? `${fmt(value)} units² (${fmt(value * mmPerUnit * mmPerUnit)} mm²)`
      : `${fmt(value)} units²`;
  const point = (vector: Vector3) =>
    `(${fmt(vector.x)}, ${fmt(vector.y)}, ${fmt(vector.z)})`;

  const faceOf = (ref: Ref): CadFace => {
    const found = typeof ref === 'string' && /^F(\d+)$/.exec(ref) && topology.faces[Number(ref.slice(1))];
    if (!found) throw new PlanError(`There is no face ${String(ref)}.`);
    return found;
  };
  const edgeOf = (ref: Ref): CadEdge => {
    const found = typeof ref === 'string' && /^E(\d+)$/.exec(ref) && topology.edges[Number(ref.slice(1))];
    if (!found) throw new PlanError(`There is no edge ${String(ref)}.`);
    return found;
  };
  const isEdge = (ref: Ref) => typeof ref === 'string' && ref.startsWith('E');
  const centreOf = (ref: Ref) => (isEdge(ref) ? edgePoint(edgeOf(ref)) : faceOf(ref).center.clone());

  try {
    const lines: string[] = [];
    for (const ref of request.of) {
      const name = String(ref);
      if (request.what === 'radius' || request.what === 'diameter') {
        const factor = request.what === 'diameter' ? 2 : 1;
        const circles = isEdge(ref)
          ? [edgeOf(ref)].filter((edge) => edge.kind === 'circle' || edge.kind === 'arc')
          : topology.edges.filter(
              (edge) =>
                (edge.kind === 'circle' || edge.kind === 'arc') &&
                edge.faces.includes(faceOf(ref).id),
            );
        if (circles.length === 0) {
          lines.push(`${name} has no circular edge, so it has no ${request.what}.`);
          continue;
        }
        const radii = [...new Set(circles.map((edge) => fmt(edge.radius ?? 0)))];
        lines.push(
          radii.length === 1
            ? `${name}: ${request.what} ${length(radii[0] * factor)}${circles.length > 1 ? ` (${circles.length} circular edges)` : ''}`
            : `${name}: ${request.what}s ${radii.map((r) => length(r * factor)).join(', ')}`,
        );
      } else if (request.what === 'length') {
        if (!isEdge(ref)) {
          lines.push(`${name} is a face; ask for its area instead.`);
          continue;
        }
        lines.push(`${name}: length ${length(edgeOf(ref).length)}`);
      } else if (request.what === 'area') {
        if (isEdge(ref)) {
          lines.push(`${name} is an edge; ask for its length instead.`);
          continue;
        }
        lines.push(`${name}: area ${areaText(faceOf(ref).area)}`);
      } else if (request.what === 'center') {
        lines.push(`${name}: ${isEdge(ref) && edgeOf(ref).center ? 'centre' : 'midpoint'} ${point(centreOf(ref))} (model units)`);
      }
    }
    if (request.what === 'distance') {
      if (request.of.length !== 2) return 'Select exactly two faces or edges to measure a distance.';
      const [a, b] = request.of;
      if (!isEdge(a) && !isEdge(b)) {
        const fa = faceOf(a);
        const fb = faceOf(b);
        if (fa.planar && fb.planar && Math.abs(fa.normal.dot(fb.normal)) > 0.999) {
          return `${String(a)} to ${String(b)}: ${length(Math.abs(fb.normal.dot(fb.center.clone().sub(fa.center))))} apart (parallel faces)`;
        }
      }
      return `${String(a)} to ${String(b)}: ${length(centreOf(a).distanceTo(centreOf(b)))} between their centres`;
    }
    return lines.join('\n') || 'Nothing to measure.';
  } catch (error) {
    if (error instanceof PlanError) return error.message;
    throw error;
  }
}

const SIDE_WORDS: Record<string, string> = {
  left: '-X',
  right: '+X',
  front: '-Y',
  back: '+Y',
  top: '+Z',
  bottom: '-Z',
};

/**
 * Place a marker on a planar face: at its centre, or at distances measured in
 * the face plane from its left/right/front/back/top/bottom boundary or from a
 * selected straight edge.
 */
export function resolveMark(
  request: MarkRequest,
  topology: CadTopology,
  /** The currently selected items, used for "shorter edge" / "longer edge". */
  selection: CadSelection[] = [],
): { marker: Marker } | { error: string } {
  try {
    const found =
      typeof request.face === 'string' &&
      /^F(\d+)$/.exec(request.face) &&
      topology.faces[Number(request.face.slice(1))];
    if (!found) throw new PlanError(`There is no face ${String(request.face)}.`);
    if (!found.planar) throw new PlanError(`F${found.id} is not flat, so a marker cannot be placed on it.`);
    const normal = found.normal.clone().normalize();
    const origin = found.center.clone();

    if ('offsets' in request.at) {
      const directions: Vector3[] = [];
      for (const offset of request.at.offsets.slice(0, 2)) {
        let inward: Vector3;
        let reference: number;
        let from = offset.from;
        if (from === 'shorter_edge' || from === 'longer_edge') {
          const chosen = selection
            .flatMap((item) => (item.kind === 'edge' ? [topology.edges[item.id]] : []))
            .filter((edge) => edge?.kind === 'line')
            .sort((a, b) => a.length - b.length);
          if (chosen.length < 2 || Math.abs(chosen[0].length - chosen[chosen.length - 1].length) < topology.size * 1e-3) {
            throw new PlanError(`Select two straight edges of different lengths to use "${from.replace('_', ' ')}".`);
          }
          from = `E${(from === 'shorter_edge' ? chosen[0] : chosen[chosen.length - 1]).id}`;
        }
        const side = SIDE_WORDS[from.toLowerCase()];
        if (side) {
          const projected = AXES[side].clone().addScaledVector(normal, -AXES[side].dot(normal));
          if (projected.length() < 0.1) {
            throw new PlanError(`"${offset.from}" is not a direction within F${found.id}.`);
          }
          inward = projected.normalize().negate();
          reference = faceExtent(found, inward).min;
        } else {
          const ref = /^E(\d+)$/.exec(from) && topology.edges[Number(from.slice(1))];
          if (!ref || ref.kind !== 'line' || !ref.start || !ref.end) {
            throw new PlanError(`${offset.from} is not a straight edge or a side such as "left".`);
          }
          const along = ref.end.clone().sub(ref.start).normalize();
          inward = normal.clone().cross(along).normalize();
          if (inward.dot(found.center.clone().sub(ref.start)) < 0) inward.negate();
          reference = inward.dot(ref.start);
        }
        if (directions.some((other) => Math.abs(other.dot(inward)) > 0.2)) {
          throw new PlanError('Choose two perpendicular references, such as the left edge and the front edge.');
        }
        directions.push(inward);
        origin.addScaledVector(inward, reference + offset.distance - inward.dot(origin));
      }
    }

    const inside = faceContains(found, origin, topology.size * 1e-4);
    // A dot with no stated size gets a small default relative to the part.
    const diameter = request.diameter ?? Number((topology.size * 0.02).toPrecision(3));
    return { marker: { faceId: found.id, origin, normal, diameter, inside } };
  } catch (error) {
    if (error instanceof PlanError) return { error: error.message };
    throw error;
  }
}

export function describeMarker(marker: Marker, mmPerUnit: number | null): string {
  const size = mmPerUnit
    ? `${fmt(marker.diameter)} units (${fmt(marker.diameter * mmPerUnit)} mm)`
    : `${fmt(marker.diameter)} units`;
  return `circle, diameter ${size}, on F${marker.faceId}`;
}
