import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoxGeometry, CylinderGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { measure } from './cadPlan.ts';
import { meshVolume } from './cadMeasure.ts';
import { buildTopology } from './cadTopology.ts';

const box = buildTopology(new BoxGeometry(20, 10, 4).toNonIndexed());
const face = (topology: typeof box, axis: 'x' | 'y' | 'z', sign: number) =>
  topology.faces.find((f) => f.normal[axis] * sign > 0.99)!;
const ask = (what: string, of: string[], extra: object = {}, mm: number | null = null, topology = box) =>
  measure({ what, of, ...extra } as never, topology, mm);

describe('measurements from the mesh', () => {
  it('computes volume, size, area and mass', () => {
    assert.ok(Math.abs(meshVolume(box) - 800) < 1e-6);
    assert.match(ask('volume', [], {}, 2), /800 units³ \(6400 mm³ = 6\.4 cm³\)/);
    assert.match(ask('bbox', []), /20 units \(X\) × 10 units \(Y\) × 4 units \(Z\)/);
    assert.match(ask('surface_area', []), /Surface area 640 units²/);
    assert.match(ask('mass', [], { material: 'aluminum' }, 10), /aluminum: .* g/);
    assert.match(ask('mass', [], { material: null }, 10), /Which material/);
    assert.match(ask('mass', [], { material: 'aluminum' }), /Set the real length/);
    // 800 units³ at 2 mm per unit = 6.4 cm³ of aluminium (2.7 g/cm³).
    assert.match(ask('mass', [], { material: 'aluminum' }, 2), /17\.28 g/);
  });

  it('measures angles between faces and edges', () => {
    const angle = ask('angle', [`F${face(box, 'z', 1).id}`, `F${face(box, 'x', 1).id}`]);
    assert.match(angle, /90° between the planes/);
    assert.match(ask('angle', [`F${face(box, 'z', 1).id}`]), /exactly two/);
  });

  it('finds wall thickness behind a face', () => {
    const top = face(box, 'z', 1);
    assert.match(ask('thickness', [`F${top.id}`]), /4 units thick/);
    const side = face(box, 'x', 1);
    assert.match(ask('thickness', [`F${side.id}`]), /20 units thick/);
  });

  it('lists round edges', () => {
    const round = buildTopology(new CylinderGeometry(4, 4, 10, 32).toNonIndexed());
    assert.match(ask('holes', [], {}, null, round), /2 circular edges:\nØ 8 units/);
    assert.match(ask('holes', []), /no round holes/);
  });

  it('flags thin walls and overhangs', () => {
    assert.match(ask('printability', []), /No walls thinner/);
    const plate = buildTopology(new BoxGeometry(20, 10, 0.1).toNonIndexed());
    assert.match(ask('printability', [], {}, 1, plate), /Thin walls/);
    const post = new BoxGeometry(4, 4, 6).toNonIndexed();
    const shelf = new BoxGeometry(20, 20, 2).translate(0, 0, 4).toNonIndexed();
    const mushroom = buildTopology(mergeGeometries([post, shelf])!);
    assert.match(ask('printability', [], {}, null, mushroom), /Overhangs beyond 45°/);
  });
});
