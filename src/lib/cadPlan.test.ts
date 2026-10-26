import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoxGeometry, CylinderGeometry, Vector3 } from 'three';
import {
  buildPlanContext,
  convertUnits,
  hasPhysicalUnits,
  measure,
  resolveMark,
  normalizeDirections,
  resolvePlan,
  type PlannedOp,
} from './cadPlan.ts';
import { buildTopology, describeItem, pointOnFaceNear } from './cadTopology.ts';

const topology = buildTopology(new BoxGeometry(20, 10, 4).toNonIndexed());
const origin = new Vector3(0, 0, 0);
const face = (axis: 'x' | 'y' | 'z', sign: number) =>
  topology.faces.find((f) => f.normal[axis] * sign > 0.99)!;
const horizontalEdge = (z: number) =>
  topology.edges.find(
    (e) =>
      e.kind === 'line' &&
      Math.abs(e.start!.z - z) < 1e-6 &&
      Math.abs(e.end!.z - z) < 1e-6 &&
      Math.abs(e.start!.x - e.end!.x) > 19,
  )!;

describe('resolvePlan', () => {
  it('cuts midway between two parallel faces', () => {
    const top = face('z', 1);
    const bottom = face('z', -1);
    const result = resolvePlan(
      [
        {
          op: 'cut',
          plane: { kind: 'parallel_to_face', face: `F${top.id}`, through: { midway: [`F${top.id}`, `F${bottom.id}`] } },
          keep: 'split',
        },
      ],
      topology,
      origin,
    );
    assert.ok(!('error' in result));
    if ('error' in result) return;
    const [op] = result.ops;
    assert.equal(op.type, 'cut');
    if (op.type !== 'cut') return;
    assert.ok(Math.abs(op.origin[2]) < 1e-9);
    assert.ok(Math.abs(Math.abs(op.normal[2]) - 1) < 1e-9);
    assert.equal(op.keep, 'split');
  });

  it('handles "parallel to a face, between an edge and that face"', () => {
    const side = face('y', 1);
    const edge = horizontalEdge(-2);
    const result = resolvePlan(
      [
        {
          op: 'cut',
          plane: { kind: 'parallel_to_face', face: `F${side.id}`, through: { midway: [`E${edge.id}`, `F${side.id}`] } },
        },
      ],
      topology,
      origin,
    );
    assert.ok(!('error' in result));
    if ('error' in result) return;
    const [op] = result.ops;
    if (op.type !== 'cut') return assert.fail('expected a cut');
    // Normal along Y; plane halfway (in y) between the edge and the +Y face centre.
    assert.ok(Math.abs(Math.abs(op.normal[1]) - 1) < 1e-9);
    const mid = (edge.start!.y + edge.end!.y) / 4 + side.center.y / 2;
    assert.ok(Math.abs(op.origin[1] - mid) < 1e-6);
  });

  it('keeps the side named by a direction or by a face', () => {
    const top = face('z', 1);
    const plane = { kind: 'axis', axis: 'z', at: 'center' } as const;
    const byDirection = resolvePlan([{ op: 'cut', plane, keep: '-Z' }], topology, origin);
    const byFace = resolvePlan([{ op: 'cut', plane, keep: `F${top.id}` }], topology, origin);
    assert.ok(!('error' in byDirection) && !('error' in byFace));
    if ('error' in byDirection || 'error' in byFace) return;
    assert.equal((byDirection.ops[0] as { keep: string }).keep, 'negative');
    assert.equal((byFace.ops[0] as { keep: string }).keep, 'positive');
  });

  it('adds the shape offset to every coordinate it emits', () => {
    const top = face('z', 1);
    const shift = new Vector3(5, 6, 7);
    const result = resolvePlan([{ op: 'hole', face: `F${top.id}`, diameter: 1, depth: null }], topology, shift);
    assert.ok(!('error' in result));
    if ('error' in result) return;
    const hole = result.ops[0];
    if (hole.type !== 'hole') return assert.fail('expected a hole');
    assert.ok(Math.abs(hole.origin[2] - (top.center.z + 7)) < 1e-9);
    assert.ok(Math.abs(hole.origin[0] - 5) < 1e-6);
  });

  it('resolves "the top face" by facing and rejects unknown references', () => {
    const ok = resolvePlan([{ op: 'hole', face: { facing: '+Z' }, diameter: 1, depth: 2 }], topology, origin);
    assert.ok(!('error' in ok));
    const bad = resolvePlan([{ op: 'hole', face: 'F999', diameter: 1, depth: null }], topology, origin);
    assert.ok('error' in bad);
    const wrongKind = resolvePlan([{ op: 'fillet', edges: ['F1'], radius: 0.1 }] as PlannedOp[], topology, origin);
    assert.ok('error' in wrongKind);
  });

  it('emits edge points for fillets and the part centre for scale', () => {
    const edge = horizontalEdge(2);
    const result = resolvePlan(
      [{ op: 'fillet', edges: [`E${edge.id}`], radius: 0.2 }, { op: 'scale', factor: 2 }],
      topology,
      new Vector3(1, 2, 3),
    );
    assert.ok(!('error' in result));
    if ('error' in result) return;
    const [fillet, scale] = result.ops;
    if (fillet.type !== 'fillet' || scale.type !== 'scale') return assert.fail('unexpected ops');
    assert.ok(Math.abs(fillet.points[0][2] - (2 + 3)) < 1e-6);
    assert.deepEqual(scale.origin, [1, 2, 3]);
  });
});

describe('planes across an edge', () => {
  it('bisects a straight edge with a plane perpendicular to it', () => {
    const top = horizontalEdge(2);
    const result = resolvePlan(
      [{ op: 'cut', plane: { kind: 'across_edge', edge: `E${top.id}` }, keep: 'split' }],
      topology,
      origin,
    );
    assert.ok(!('error' in result));
    if ('error' in result) return;
    const [op] = result.ops;
    assert.equal(op.type, 'cut');
    if (op.type !== 'cut') return;
    assert.ok(Math.abs(Math.abs(op.normal[0]) - 1) < 1e-9); // the edge runs along X
    assert.ok(Math.abs(op.origin[0]) < 1e-6); // through its midpoint
  });

  it('passes through a named face instead of the midpoint', () => {
    const top = horizontalEdge(2);
    const right = face('x', 1);
    const result = resolvePlan(
      [{ op: 'cut', plane: { kind: 'across_edge', edge: `E${top.id}`, through: { face: `F${right.id}` } } }],
      topology,
      origin,
    );
    assert.ok(!('error' in result));
    if ('error' in result || result.ops[0].type !== 'cut') return;
    assert.ok(Math.abs(result.ops[0].origin[0] - 10) < 1e-6);
  });
});

describe('corners and positions along edges', () => {
  it('finds the 8 corners of a box and describes them', () => {
    assert.equal(topology.vertices.length, 8);
    assert.match(describeItem(topology, { kind: 'vertex', id: 0 }), /^V0: corner at/);
  });

  it('cuts through the midpoint between two corners', () => {
    const top = face('z', 1);
    const [a, b] = topology.vertices.filter((v) => v.point.z > 1.9 && v.point.y > 4.9);
    const result = resolvePlan(
      [
        {
          op: 'cut',
          plane: { kind: 'parallel_to_face', face: `F${top.id}`, through: { midway: [`V${a.id}`, `V${b.id}`] } },
        },
      ],
      topology,
      origin,
    );
    assert.ok(!('error' in result));
    if ('error' in result || result.ops[0].type !== 'cut') return;
    assert.ok(Math.abs(result.ops[0].origin[0]) < 1e-6);
    assert.ok(Math.abs(result.ops[0].origin[2] - 2) < 1e-6);
  });

  it('puts a point a fraction or a distance along a straight edge', () => {
    const edge = horizontalEdge(2);
    const run = (through: object) =>
      resolvePlan(
        [{ op: 'cut', plane: { kind: 'across_edge', edge: `E${edge.id}`, through } }] as PlannedOp[],
        topology,
        origin,
      );
    const quarter = run({ along: `E${edge.id}`, fraction: 0.25, from: 'start' });
    assert.ok(!('error' in quarter));
    if ('error' in quarter || quarter.ops[0].type !== 'cut') return;
    const start = edge.start!.x;
    const end = edge.end!.x;
    assert.ok(Math.abs(quarter.ops[0].origin[0] - (start + (end - start) * 0.25)) < 1e-6);
    const beyond = run({ along: `E${edge.id}`, distance: 99, from: 'start' });
    assert.ok('error' in beyond);
  });

  it('takes the centre of a hole and sizes from an existing round edge', () => {
    const hole = buildTopology(new CylinderGeometry(4, 4, 10, 32).toNonIndexed());
    const round = hole.edges.find((e) => e.kind === 'circle')!;
    const planar = hole.faces.find((f) => f.planar)!;
    const result = resolvePlan(
      [
        {
          op: 'hole',
          face: `F${planar.id}`,
          diameter: { same_as: `E${round.id}`, what: 'diameter' },
          depth: null,
        },
      ],
      hole,
      origin,
    );
    assert.ok(!('error' in result));
    if ('error' in result || result.ops[0].type !== 'hole') return;
    assert.ok(Math.abs((result.ops[0].diameter ?? 0) - 8) < 1e-6);
    const wall = hole.faces.find((f) => !f.planar)!;
    const centred = resolvePlan(
      [{ op: 'cut', plane: { kind: 'across_edge', edge: `E${round.id}`, through: { center_of: `F${wall.id}` } } }] as PlannedOp[],
      hole,
      origin,
    );
    assert.ok(!('error' in centred));
  });
});

describe('more plane types', () => {
  const planeOfCut = (plane: object, topo = topology) => {
    const result = resolvePlan([{ op: 'cut', plane }] as PlannedOp[], topo, origin);
    assert.ok(!('error' in result), 'error' in result ? result.error : '');
    if ('error' in result || result.ops[0].type !== 'cut') throw new Error('no cut');
    return result.ops[0];
  };
  const corner = (x: number, y: number, z: number) =>
    topology.vertices.find(
      (v) => Math.abs(v.point.x - x) < 1e-6 && Math.abs(v.point.y - y) < 1e-6 && Math.abs(v.point.z - z) < 1e-6,
    )!;

  it('goes through three corners', () => {
    const cut = planeOfCut({
      kind: 'through_points',
      points: [{ vertex: `V${corner(10, 5, 2).id}` }, { vertex: `V${corner(-10, 5, 2).id}` }, { vertex: `V${corner(10, -5, 2).id}` }],
    });
    assert.ok(Math.abs(Math.abs(cut.normal[2]) - 1) < 1e-9);
    assert.ok(Math.abs(cut.origin[2] - 2) < 1e-9);
  });

  it('rejects three points on one line', () => {
    const line = [corner(10, 5, 2), corner(-10, 5, 2), corner(-10, 5, -2)].slice(0, 2);
    const result = resolvePlan(
      [{ op: 'cut', plane: { kind: 'through_points', points: [{ vertex: `V${line[0].id}` }, { vertex: `V${line[1].id}` }, { midway: [`V${line[0].id}`, `V${line[1].id}`] }] } }] as PlannedOp[],
      topology,
      origin,
    );
    assert.ok('error' in result);
  });

  it('contains an edge and a point', () => {
    const edge = horizontalEdge(2);
    const cut = planeOfCut({ kind: 'edge_and_point', edge: `E${edge.id}`, point: { vertex: `V${corner(-10, -5, -2).id}` } });
    assert.ok(Math.abs(cut.normal[0]) < 1e-9); // the edge runs along X
  });

  it('tilts a plane about an edge relative to a face', () => {
    const edge = horizontalEdge(2);
    const top = face('z', 1);
    const flat = planeOfCut({ kind: 'edge_at_angle', edge: `E${edge.id}`, face: `F${top.id}`, angle: 0 });
    assert.ok(Math.abs(Math.abs(flat.normal[2]) - 1) < 1e-9);
    const steep = planeOfCut({ kind: 'edge_at_angle', edge: `E${edge.id}`, face: `F${top.id}`, angle: 90 });
    assert.ok(Math.abs(steep.normal[2]) < 1e-9);
    const slanted = planeOfCut({ kind: 'edge_at_angle', edge: `E${edge.id}`, face: `F${top.id}`, angle: 45 });
    assert.ok(Math.abs(Math.abs(slanted.normal[2]) - Math.SQRT1_2) < 1e-9);
  });

  it('touches a round face and cuts through its axis', () => {
    const round = buildTopology(new CylinderGeometry(4, 4, 10, 32).toNonIndexed());
    const wall = round.faces.find((f) => !f.planar)!;
    const touching = planeOfCut({ kind: 'tangent_to_face', face: `F${wall.id}`, side: '+X' }, round);
    assert.ok(Math.abs(touching.origin[0] - 4) < 1e-6 && Math.abs(touching.normal[0] - 1) < 1e-9);
    const section = planeOfCut({ kind: 'through_axis', of: `F${wall.id}`, direction: '+Z' }, round);
    assert.ok(Math.abs(Math.abs(section.normal[0]) - 1) < 1e-9);
    const along = resolvePlan(
      [{ op: 'cut', plane: { kind: 'through_axis', of: `F${wall.id}`, direction: '+Y' } }] as PlannedOp[],
      round,
      origin,
    );
    assert.ok('error' in along); // the axis itself runs along Y
  });

  it('finds the middle across faces and rotates a plane', () => {
    const cut = planeOfCut({ kind: 'middle_of', of: [`F${face('x', 1).id}`, `F${face('x', -1).id}`], axis: 'x' });
    assert.ok(Math.abs(cut.origin[0]) < 1e-9 && Math.abs(cut.normal[0] - 1) < 1e-9);
    const turned = planeOfCut({ kind: 'rotated', base: { kind: 'axis', axis: 'x', at: 'center' }, about: 'z', angle: 90 });
    assert.ok(Math.abs(Math.abs(turned.normal[1]) - 1) < 1e-9);
  });
});

describe('feature operations', () => {
  const top = () => `F${face('z', 1).id}`;
  const run = (plan: object[], mm: number | null = null) =>
    resolvePlan(plan as PlannedOp[], topology, origin, mm);
  const ok = (plan: object[], mm: number | null = null) => {
    const result = run(plan, mm);
    assert.ok(!('error' in result), 'error' in result ? result.error : '');
    return result.ops;
  };

  it('turns a metric size into millimetres divided by the real scale', () => {
    const [clear] = ok([{ op: 'hole', face: top(), metric: 'M3', fit: 'clearance', depth: null }], 0.5);
    assert.equal(clear.type, 'hole');
    if (clear.type === 'hole') assert.ok(Math.abs(clear.diameter - 6.8) < 1e-9);
    const [sunk] = ok([{ op: 'hole', face: top(), metric: 'M3', style: 'countersink', depth: null }], 1);
    if (sunk.type === 'hole') {
      assert.equal(sunk.style, 'countersink');
      assert.ok(Math.abs((sunk.head_diameter ?? 0) - 6.3) < 1e-9);
    }
    const [bore] = ok([{ op: 'hole', face: top(), metric: 'M4', style: 'counterbore', fit: 'tap', depth: 5 }], 1);
    if (bore.type === 'hole') {
      assert.equal(bore.diameter, 3.3);
      assert.equal(bore.head_diameter, 7);
      assert.equal(bore.head_depth, 4);
    }
    assert.ok('error' in run([{ op: 'hole', face: top(), metric: 'M3', depth: null }]));
    assert.ok('error' in run([{ op: 'hole', face: top(), metric: 'M7', depth: null }], 1));
  });

  it('places pockets, bosses and text on a face at the centre or a given point', () => {
    const edge = horizontalEdge(2);
    const [pocket, boss, text] = ok([
      { op: 'pocket', face: top(), profile: { shape: 'rect', width: 6, height: 3 }, depth: 1, rotation: 30 },
      { op: 'boss', face: top(), at: { along: `E${edge.id}`, fraction: 0.25 }, profile: { shape: 'circle', diameter: 2 }, height: 3 },
      { op: 'text', face: top(), text: 'A1', size: 2, depth: 0.5, mode: 'engrave' },
    ]);
    assert.deepEqual(pocket.type === 'pocket' && pocket.profile, 'rect');
    if (pocket.type === 'pocket') {
      assert.equal(pocket.depth, 1);
      assert.equal(pocket.rotation, 30);
      assert.ok(Math.abs(pocket.origin[2] - 2) < 1e-9);
    }
    if (boss.type === 'boss') {
      assert.equal(boss.depth, 3);
      // A quarter along the edge, moved onto the top face plane.
      assert.ok(Math.abs(boss.origin[2] - 2) < 1e-9);
      assert.ok(Math.abs(boss.origin[0] - (edge.start!.x + (edge.end!.x - edge.start!.x) * 0.25)) < 1e-6);
    }
    if (text.type === 'text') assert.equal(text.distance, -0.5);
  });

  it('repeats a feature in a line or around an axis', () => {
    const hole = { op: 'hole', face: top(), diameter: 1, depth: null };
    const [line] = ok([{ op: 'pattern', of: hole, kind: 'linear', count: 3, spacing: 4, direction: '+X' }]);
    if (line.type === 'pattern' && line.kind === 'linear') {
      assert.equal(line.count, 3);
      assert.deepEqual(line.vector, [1, 0, 0]);
      assert.equal(line.distance, 4);
    }
    const [ring] = ok([{ op: 'pattern', of: hole, kind: 'circular', count: 6, around: 'z' }]);
    if (ring.type === 'pattern' && ring.kind === 'circular') assert.deepEqual(ring.normal, [0, 0, 1]);
    assert.ok('error' in run([{ op: 'pattern', of: hole, kind: 'linear', count: 3, direction: '+X' }]));
    assert.ok('error' in run([{ op: 'pattern', of: hole, kind: 'circular', count: 6 }]));
  });

  it('plans shells, face offsets, removals, ribs and drafts', () => {
    const edge = horizontalEdge(2);
    const side = face('x', 1);
    const [shell, offset, remove, rib, draft] = ok([
      { op: 'shell', thickness: 0.5, open: [top()] },
      { op: 'offset_face', face: top(), distance: -1 },
      { op: 'remove', targets: [top(), `E${edge.id}`] },
      { op: 'rib', edge: `E${edge.id}`, thickness: 1, size: 3 },
      { op: 'draft', faces: [`F${side.id}`], angle: 3, pull: '+Z' },
    ]);
    if (shell.type === 'shell') assert.equal(shell.points.length, 1);
    if (offset.type === 'offset_face') assert.equal(offset.distance, -1);
    if (remove.type === 'delete') assert.equal(remove.points.length, 2);
    if (rib.type === 'rib') {
      assert.deepEqual(rib.vector.map(Math.abs), [1, 0, 0]);
      assert.ok(Math.abs(rib.normal[0] * rib.normal2[0] + rib.normal[1] * rib.normal2[1] + rib.normal[2] * rib.normal2[2]) < 1e-9);
    }
    if (draft.type === 'draft') assert.ok(Math.abs(draft.origin[2] - -2) < 1e-9); // the face's lowest point along +Z
    assert.ok('error' in run([{ op: 'shell', thickness: 1, open: [] }]));
    assert.ok('error' in run([{ op: 'rib', edge: `E${edge.id}`, at: { along: `E${edge.id}`, fraction: 0.5 }, thickness: 1, size: 3 }].slice(0, 0).concat([{ op: 'rib', edge: 'F1', thickness: 1, size: 3 }] as never)));
  });
});

describe('combining versions', () => {
  const versions = ['m1', 'm2', 'm3'];
  const combine = (version: number) =>
    resolvePlan([{ op: 'combine', mode: 'subtract', version }] as PlannedOp[], topology, origin, null, versions);

  it('names the saved version by number and refuses the current or a missing one', () => {
    const result = combine(2);
    assert.ok(!('error' in result));
    if (!('error' in result)) assert.deepEqual(result.ops[0], { type: 'combine', mode: 'subtract', versionId: 'm2' });
    assert.ok('error' in combine(3)); // the version on screen
    assert.ok('error' in combine(9));
  });

  it('tells the planner how many versions exist', () => {
    assert.match(buildPlanContext(topology, [], null, 3), /Saved versions: 3/);
    assert.doesNotMatch(buildPlanContext(topology, [], null, 1), /Saved versions/);
  });
});

describe('anchoring on a face', () => {
  it('finds a surface point near the centre when the centre is in a hole', () => {
    const ring = buildTopology(new CylinderGeometry(4, 4, 2, 24, 1, true).toNonIndexed());
    const wall = ring.faces.find((f) => !f.planar)!;
    const near = pointOnFaceNear(wall, new Vector3(0, 0, 0));
    assert.ok(Math.abs(Math.hypot(near.x, near.z) - 4) < 0.5); // on the wall, not on the axis
  });
});

describe('buildPlanContext', () => {
  it('summarises size, selection and planar faces', () => {
    const top = face('z', 1);
    const text = buildPlanContext(topology, [{ kind: 'face', id: top.id }]);
    assert.match(text, /^Part size 20\./);
    assert.match(text, new RegExp(`Selected: F${top.id}: planar face facing \\+Z`));
    assert.match(text, /Faces: .*\+Z/);
  });
});

describe('offset planes', () => {
  it('moves a plane through two edges along a direction', () => {
    const edge = (z: number, y: number) =>
      topology.edges.find(
        (e) =>
          e.kind === 'line' &&
          Math.abs(e.start!.z - z) < 1e-6 &&
          Math.abs(e.end!.z - z) < 1e-6 &&
          Math.abs(e.start!.y - y) < 1e-6 &&
          Math.abs(e.start!.x - e.end!.x) > 19,
      )!;
    const a = edge(2, 5);
    const b = edge(-2, -5);
    const base = { kind: 'through_edges', edges: [`E${a.id}`, `E${b.id}`] } as const;
    const plain = resolvePlan([{ op: 'cut', plane: base }], topology, origin);
    const shifted = resolvePlan(
      [{ op: 'cut', plane: { kind: 'offset', base, distance: 3, direction: '-Y' } }],
      topology,
      origin,
    );
    assert.ok(!('error' in plain) && !('error' in shifted));
    if ('error' in plain || 'error' in shifted) return;
    const [p, q] = [plain.ops[0], shifted.ops[0]];
    if (p.type !== 'cut' || q.type !== 'cut') return assert.fail('expected cuts');
    assert.deepEqual(q.normal, p.normal);
    assert.ok(Math.abs(q.origin[1] - (p.origin[1] - 3)) < 1e-9);
  });

  it('rejects a direction that lies inside the plane', () => {
    const top = face('z', 1);
    const result = resolvePlan(
      [
        {
          op: 'cut',
          plane: { kind: 'offset', base: { kind: 'face', face: `F${top.id}` }, distance: 1, direction: '+X' },
        },
      ],
      topology,
      origin,
    );
    assert.ok('error' in result);
  });
});

describe('convertUnits', () => {
  it('converts real lengths to model units', () => {
    assert.equal(convertUnits('shift it 5mm to the left', 100), 'shift it 0.05 to the left');
    assert.equal(convertUnits('drill 2 cm deep', 100), 'drill 0.2 deep');
    assert.equal(convertUnits('make it 1 in wider', 25.4), 'make it 1 wider');
    assert.equal(convertUnits('twice as big', 100), 'twice as big');
  });

  it('detects physical units', () => {
    assert.ok(hasPhysicalUnits('a 5mm hole'));
    assert.ok(hasPhysicalUnits('2.5 cm'));
    assert.ok(!hasPhysicalUnits('a 0.05 hole'));
    assert.ok(!hasPhysicalUnits('1.5 times bigger'));
  });
});

describe('normalizeDirections', () => {
  it('rewrites distance plus direction words to axis tokens', () => {
    assert.equal(normalizeDirections('a plane 0.05 on the left of it'), 'a plane 0.05 toward -X');
    assert.equal(normalizeDirections('make it 0.2 in front of it'), 'make it 0.2 toward -Y');
    assert.equal(normalizeDirections('shift 3 to the right'), 'shift 3 toward +X');
    assert.equal(normalizeDirections('move 1.5 above'), 'move 1.5 toward +Z');
    assert.equal(normalizeDirections('0.5 down, then cut'), '0.5 toward -Z, then cut');
  });

  it('turns keep/remove a half into an explicit keep direction', () => {
    assert.equal(normalizeDirections('cut it in half along x and keep the left half'), 'cut it in half along x and keep -X');
    assert.equal(normalizeDirections('split across the middle, keep the top part'), 'split across the middle, keep +Z');
    assert.equal(normalizeDirections('remove the right half'), 'keep -X');
    assert.equal(normalizeDirections('cut the top half off'), 'cut the top half off');
    assert.equal(normalizeDirections('chop off the bottom piece'), 'keep +Z');
  });

  it('leaves face references alone', () => {
    assert.equal(normalizeDirections('drill the front face'), 'drill the front face');
    assert.equal(normalizeDirections('cut the left half off'), 'cut the left half off');
  });
});

describe('measure', () => {
  const cylinder = buildTopology(new CylinderGeometry(4, 4, 10, 32).toNonIndexed());
  const wall = cylinder.faces.find((f) => !f.planar)!;
  const circle = cylinder.edges.find((e) => e.kind === 'circle')!;

  it('answers the radius of a curved face from its circular edges', () => {
    const text = measure({ what: 'radius', of: [`F${wall.id}`] }, cylinder, null);
    assert.match(text, /radius 4 units/);
  });

  it('gives a diameter and adds millimetres when the size is known', () => {
    const text = measure({ what: 'diameter', of: [`E${circle.id}`] }, cylinder, 2);
    assert.match(text, /diameter 8 units \(16 mm\)/);
  });

  it('measures the distance between parallel faces and an edge length', () => {
    const box = buildTopology(new BoxGeometry(20, 10, 4).toNonIndexed());
    const top = box.faces.find((f) => f.normal.z > 0.99)!;
    const bottom = box.faces.find((f) => f.normal.z < -0.99)!;
    assert.match(measure({ what: 'distance', of: [`F${top.id}`, `F${bottom.id}`] }, box, null), /4 units apart/);
    const edge = box.edges.find((e) => e.kind === 'line' && Math.abs(e.length - 20) < 1e-3)!;
    assert.match(measure({ what: 'length', of: [`E${edge.id}`] }, box, null), /length 20 units/);
  });

  it('treats a length between two faces as a distance', () => {
    const box = buildTopology(new BoxGeometry(20, 10, 4).toNonIndexed());
    const top = box.faces.find((f) => f.normal.z > 0.99)!;
    const bottom = box.faces.find((f) => f.normal.z < -0.99)!;
    assert.match(measure({ what: 'length', of: [`F${top.id}`, `F${bottom.id}`] }, box, null), /4 units apart/);
  });

  it('says so when a face has no circle', () => {
    const box = buildTopology(new BoxGeometry(20, 10, 4).toNonIndexed());
    assert.match(measure({ what: 'radius', of: ['F0'] }, box, null), /no circular edge/);
  });
});

describe('resolveMark', () => {
  const top = face('z', 1);
  const mark = (at: Parameters<typeof resolveMark>[0]['at']) =>
    resolveMark({ face: `F${top.id}`, shape: 'circle', diameter: 1, at }, topology);

  it('puts the marker at the face centre by default', () => {
    const result = mark({ center: true });
    assert.ok(!('error' in result));
    if ('error' in result) return;
    assert.ok(result.marker.origin.distanceTo(new Vector3(0, 0, 2)) < 1e-6);
    assert.ok(result.marker.inside);
  });

  it('measures from the left and front sides of the face', () => {
    const result = mark({ offsets: [{ from: 'left', distance: 3 }, { from: 'front', distance: 2 }] });
    assert.ok(!('error' in result));
    if ('error' in result) return;
    // Box is 20 x 10: left edge at x = -10, front edge at y = -5.
    assert.ok(Math.abs(result.marker.origin.x - -7) < 1e-6);
    assert.ok(Math.abs(result.marker.origin.y - -3) < 1e-6);
    assert.ok(Math.abs(result.marker.origin.z - 2) < 1e-6);
  });

  it('measures from a selected straight edge, inward', () => {
    const edge = topology.edges.find(
      (e) =>
        e.kind === 'line' &&
        Math.abs(e.start!.z - 2) < 1e-6 &&
        Math.abs(e.end!.z - 2) < 1e-6 &&
        Math.abs(e.start!.y - -5) < 1e-6 &&
        Math.abs(e.start!.x - e.end!.x) > 19,
    )!;
    const result = mark({ offsets: [{ from: `E${edge.id}`, distance: 1 }] });
    assert.ok(!('error' in result));
    if ('error' in result) return;
    assert.ok(Math.abs(result.marker.origin.y - -4) < 1e-6);
    assert.ok(Math.abs(result.marker.origin.x) < 1e-6);
  });

  it('uses a default size for a dot and resolves shorter/longer selected edges', () => {
    const along = (axis: 'x' | 'y') =>
      topology.edges.find(
        (e) =>
          e.kind === 'line' &&
          Math.abs(e.start!.z - 2) < 1e-6 &&
          Math.abs(e.end!.z - 2) < 1e-6 &&
          Math.abs(e.start![axis] - e.end![axis]) > 5 &&
          Math.abs(e.start!.y) > 4.9 === (axis === 'x') &&
          (axis === 'y' || true),
      )!;
    const longer = along('x'); // 20 long, along x
    const shorter = topology.edges.find(
      (e) =>
        e.kind === 'line' &&
        Math.abs(e.start!.z - 2) < 1e-6 &&
        Math.abs(e.end!.z - 2) < 1e-6 &&
        Math.abs(e.start!.y - e.end!.y) > 9 &&
        e.start!.x < 0,
    )!; // 10 long, along y at the left
    const result = resolveMark(
      {
        face: `F${top.id}`,
        shape: 'circle',
        diameter: null,
        at: { offsets: [{ from: 'shorter_edge', distance: 1 }, { from: 'longer_edge', distance: 2 }] },
      },
      topology,
      [{ kind: 'edge', id: longer.id }, { kind: 'edge', id: shorter.id }],
    );
    assert.ok(!('error' in result));
    if ('error' in result) return;
    assert.ok(Math.abs(result.marker.diameter - 0.4) < 1e-9);
    // 1 inside the short (left, x=-10) edge and 2 inside the long (y=+/-5) edge.
    assert.ok(Math.abs(result.marker.origin.x - -9) < 1e-6);
    assert.ok(Math.abs(Math.abs(result.marker.origin.y) - 3) < 1e-6);
    const missing = resolveMark(
      { face: `F${top.id}`, shape: 'circle', diameter: null, at: { offsets: [{ from: 'shorter_edge', distance: 1 }] } },
      topology,
      [],
    );
    assert.ok('error' in missing);
  });

  it('flags a marker outside the face and rejects bad references', () => {
    const outside = mark({ offsets: [{ from: 'left', distance: 25 }] });
    assert.ok(!('error' in outside));
    if (!('error' in outside)) assert.equal(outside.marker.inside, false);
    assert.ok('error' in mark({ offsets: [{ from: 'top', distance: 1 }] }));
    assert.ok('error' in mark({ offsets: [{ from: 'left', distance: 1 }, { from: 'right', distance: 1 }] }));
  });
});

describe('stretch', () => {
  it('resolves a stretch between two parallel faces at their midpoint', () => {
    const top = face('z', 1);
    const bottom = face('z', -1);
    const result = resolvePlan(
      [{ op: 'stretch', between: [`F${bottom.id}`, `F${top.id}`], distance: 6 }],
      topology,
      origin,
    );
    assert.ok(!('error' in result));
    if ('error' in result) return;
    const [op] = result.ops;
    if (op.type !== 'stretch') return assert.fail('expected a stretch');
    assert.ok(Math.abs(op.origin[2]) < 1e-9);
    // Points from the first face (bottom) toward the second (top).
    assert.ok(op.normal[2] > 0.999);
    assert.equal(op.distance, 6);
  });

  it('rejects non-parallel faces and over-shrinking', () => {
    const top = face('z', 1);
    const side = face('x', 1);
    const bottom = face('z', -1);
    assert.ok('error' in resolvePlan([{ op: 'stretch', between: [`F${top.id}`, `F${side.id}`], distance: 1 }], topology, origin));
    assert.ok('error' in resolvePlan([{ op: 'stretch', between: [`F${top.id}`, `F${bottom.id}`], distance: -4 }], topology, origin));
    assert.ok(!('error' in resolvePlan([{ op: 'stretch', between: [`F${top.id}`, `F${bottom.id}`], distance: -3 }], topology, origin)));
  });
});

describe('fill', () => {
  it('sends a point on each selected face or edge, in the shape frame', () => {
    const top = face('z', 1);
    const edge = horizontalEdge(2);
    const shift = new Vector3(10, 20, 30);
    const result = resolvePlan(
      [{ op: 'fill', targets: [`F${top.id}`, `E${edge.id}`] }],
      topology,
      shift,
    );
    assert.ok(!('error' in result));
    if ('error' in result) return;
    const [op] = result.ops;
    if (op.type !== 'fill') return assert.fail('expected a fill');
    assert.equal(op.points.length, 2);
    // The face point lies on the top face (z = 2) once the offset is removed.
    assert.ok(Math.abs(op.points[0][2] - 30 - 2) < 1e-5);
    assert.ok(Math.abs(op.points[1][2] - 30 - 2) < 1e-5);
  });

  it('rejects an unknown target', () => {
    assert.ok('error' in resolvePlan([{ op: 'fill', targets: ['F999'] }], topology, origin));
  });
});
