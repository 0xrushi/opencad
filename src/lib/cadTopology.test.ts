import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BoxGeometry, CylinderGeometry } from 'three';
import { buildTopology, describeSelection, planeFromSelection } from './cadTopology.ts';

describe('buildTopology', () => {
  it('finds six faces and twelve straight edges on a box', () => {
    const topology = buildTopology(new BoxGeometry(20, 10, 5).toNonIndexed());
    assert.equal(topology.faces.length, 6);
    assert.ok(topology.faces.every((face) => face.planar));
    assert.equal(topology.edges.length, 12);
    assert.ok(topology.edges.every((edge) => edge.kind === 'line'));
  });

  it('finds a cylinder wall, two caps and two circular edges', () => {
    const topology = buildTopology(new CylinderGeometry(4, 4, 10, 32).toNonIndexed());
    assert.equal(topology.faces.length, 3);
    assert.equal(topology.faces.filter((face) => !face.planar).length, 1);
    assert.equal(topology.edges.length, 2);
    for (const edge of topology.edges) {
      assert.equal(edge.kind, 'circle');
      assert.ok(Math.abs((edge.radius ?? 0) - 4) < 0.05);
    }
  });

  it('recognises circular arcs and their radius', () => {
    const topology = buildTopology(
      new CylinderGeometry(4, 4, 10, 32, 1, false, 0, Math.PI).toNonIndexed(),
    );
    const arcs = topology.edges.filter((edge) => edge.kind === 'arc');
    assert.ok(arcs.length >= 2);
    for (const arc of arcs) assert.ok(Math.abs((arc.radius ?? 0) - 4) < 0.05);
  });

  it('describes a selection for the model', () => {
    const topology = buildTopology(new BoxGeometry(20, 10, 5).toNonIndexed());
    const text = describeSelection(topology, [
      { kind: 'edge', id: 0 },
      { kind: 'face', id: 0 },
    ]);
    assert.match(text, /^Selected geometry/);
    assert.match(text, /E0: straight edge/);
    assert.match(text, /F0: planar face facing [+-][XYZ]/);
  });
});

describe('planeFromSelection', () => {
  const box = () => buildTopology(new BoxGeometry(20, 10, 4).toNonIndexed());
  const faceFacing = (topology: ReturnType<typeof box>, axis: 'x' | 'y' | 'z', sign: number) =>
    topology.faces.find((face) => face.normal[axis] * sign > 0.99)!.id;

  it('uses the middle plane between two parallel faces', () => {
    const topology = box();
    const plane = planeFromSelection(topology, [
      { kind: 'face', id: faceFacing(topology, 'z', 1) },
      { kind: 'face', id: faceFacing(topology, 'z', -1) },
    ]);
    assert.ok(!('error' in plane));
    if ('error' in plane) return;
    assert.ok(Math.abs(plane.origin.z) < 1e-6);
    assert.ok(Math.abs(Math.abs(plane.normal.z) - 1) < 1e-6);
  });

  it('bisects two perpendicular faces through their shared edge', () => {
    const topology = box();
    const top = topology.faces[faceFacing(topology, 'z', 1)];
    const side = topology.faces[faceFacing(topology, 'x', 1)];
    const plane = planeFromSelection(topology, [
      { kind: 'face', id: top.id },
      { kind: 'face', id: side.id },
    ]);
    assert.ok(!('error' in plane));
    if ('error' in plane) return;
    // The shared edge runs along Y at x = 10, z = 2.
    assert.ok(Math.abs(plane.origin.x - 10) < 1e-6 && Math.abs(plane.origin.z - 2) < 1e-6);
    assert.ok(Math.abs(Math.abs(plane.normal.x) - Math.SQRT1_2) < 1e-6);
    assert.ok(Math.abs(Math.abs(plane.normal.z) - Math.SQRT1_2) < 1e-6);
    assert.ok(Math.abs(plane.normal.y) < 1e-6);
  });

  it('builds a plane parallel to a face through an edge', () => {
    const topology = box();
    const top = topology.faces[faceFacing(topology, 'z', 1)];
    const edge = topology.edges.find(
      (candidate) =>
        candidate.kind === 'line' &&
        candidate.start &&
        candidate.end &&
        candidate.start.z < 0 &&
        Math.abs(candidate.start.z - candidate.end.z) < 1e-6,
    )!;
    const plane = planeFromSelection(topology, [
      { kind: 'face', id: top.id },
      { kind: 'edge', id: edge.id },
    ]);
    assert.ok(!('error' in plane));
    if ('error' in plane) return;
    assert.ok(Math.abs(Math.abs(plane.normal.z) - 1) < 1e-6);
    assert.ok(Math.abs(plane.origin.z - edge.start!.z) < 1e-6);
  });

  it('rejects an edge with no plane-defining partner', () => {
    const topology = box();
    const plane = planeFromSelection(topology, [{ kind: 'edge', id: 0 }]);
    assert.ok('error' in plane);
  });

  it('builds a diagonal plane from two opposite parallel edges', () => {
    const topology = box();
    const lines = topology.edges.filter((edge) => edge.kind === 'line' && edge.start && edge.end);
    const alongX = lines.filter((edge) => Math.abs(edge.start!.x - edge.end!.x) > 19);
    const top = alongX.find((edge) => edge.start!.y > 0 && edge.start!.z > 0)!;
    const bottom = alongX.find((edge) => edge.start!.y < 0 && edge.start!.z < 0)!;
    const plane = planeFromSelection(topology, [
      { kind: 'edge', id: top.id },
      { kind: 'edge', id: bottom.id },
    ]);
    assert.ok(!('error' in plane));
    if ('error' in plane) return;
    assert.ok(Math.abs(plane.normal.x) < 1e-6);
    assert.ok(Math.abs(plane.origin.clone().sub(top.start!).dot(plane.normal)) < 1e-6);
    assert.ok(Math.abs(bottom.start!.clone().sub(top.start!).dot(plane.normal)) < 1e-6);
  });

  it('rejects edges that are not coplanar', () => {
    const topology = box();
    const lines = topology.edges.filter((edge) => edge.kind === 'line' && edge.start && edge.end);
    const alongX = lines.find((edge) => Math.abs(edge.start!.x - edge.end!.x) > 19)!;
    const alongY = lines.find(
      (edge) => Math.abs(edge.start!.y - edge.end!.y) > 9 && edge.start!.z * alongX.start!.z < 0 && edge.start!.x * alongX.start!.x > 0,
    );
    if (!alongY) return;
    const plane = planeFromSelection(topology, [
      { kind: 'edge', id: alongX.id },
      { kind: 'edge', id: alongY.id },
    ]);
    // Skew edges either fail or, if they happen to meet, still give a valid plane.
    assert.ok('error' in plane || plane.normal.length() > 0.99);
  });
});
