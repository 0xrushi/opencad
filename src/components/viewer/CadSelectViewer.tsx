import { Canvas, useThree } from '@react-three/fiber';
import {
  Environment,
  Line,
  OrbitControls,
  OrthographicCamera,
  Stage,
} from '@react-three/drei';
import * as THREE from 'three';
import { Suspense, useEffect, useMemo, useRef } from 'react';
import type { Marker } from '@/lib/cadPlan';
import { ViewGizmo } from '@/components/viewer/ViewGizmo';
import {
  distanceToEdge,
  selectionKey,
  type CadSelection,
  type CadTopology,
  type CutPlane,
} from '@/lib/cadTopology';

const PREVIEW_SIZE = 40;
const DRAG_TOLERANCE_PX = 5;

interface CadSelectViewerProps {
  geometry: THREE.BufferGeometry;
  topology: CadTopology;
  selection: CadSelection[];
  plane?: CutPlane | null;
  marker?: Marker | null;
  /** Faces about to be removed, drawn in red over the part. */
  highlight?: THREE.BufferGeometry | null;
  color: string;
  onPick: (item: CadSelection | null, additive: boolean) => void;
}

const EDGE_PICK_PX = 8;
const VERTEX_PICK_PX = 10;

/** Edges whose projection passes within a few pixels of the pointer. */
function edgesNearPointer(
  topology: CadTopology,
  mesh: THREE.Mesh,
  camera: THREE.Camera,
  x: number,
  y: number,
  width: number,
  height: number,
): { id: number; pixels: number }[] {
  const project = (point: THREE.Vector3) => {
    const projected = mesh.localToWorld(point.clone()).project(camera);
    return new THREE.Vector2(
      ((projected.x + 1) / 2) * width,
      ((1 - projected.y) / 2) * height,
    );
  };
  const target = new THREE.Vector2(x, y);
  const closest = new THREE.Vector2();
  const near: { id: number; pixels: number }[] = [];
  for (const edge of topology.edges) {
    let best = Infinity;
    for (let i = 0; i < edge.segments.length; i += 2) {
      const a = project(edge.segments[i]);
      const b = project(edge.segments[i + 1]);
      const ab = b.clone().sub(a);
      const t = Math.min(
        1,
        Math.max(0, target.clone().sub(a).dot(ab) / (ab.lengthSq() || 1)),
      );
      closest.copy(a).addScaledVector(ab, t);
      best = Math.min(best, closest.distanceTo(target));
    }
    if (best <= EDGE_PICK_PX) near.push({ id: edge.id, pixels: best });
  }
  return near;
}

/** Corners whose projection lies within a few pixels of the pointer. */
function verticesNearPointer(
  topology: CadTopology,
  mesh: THREE.Mesh,
  camera: THREE.Camera,
  x: number,
  y: number,
  width: number,
  height: number,
): { id: number; pixels: number }[] {
  const near: { id: number; pixels: number }[] = [];
  for (const vertex of topology.vertices) {
    const projected = mesh.localToWorld(vertex.point.clone()).project(camera);
    const pixels = Math.hypot(
      ((projected.x + 1) / 2) * width - x,
      ((1 - projected.y) / 2) * height - y,
    );
    if (pixels <= VERTEX_PICK_PX) near.push({ id: vertex.id, pixels });
  }
  return near;
}

/**
 * Click picking: a hit on the surface selects the nearest feature edge when
 * one is close to the hit point, otherwise the face. Orbit drags are ignored.
 */
function Picker({
  meshRef,
  topology,
  onPick,
}: {
  meshRef: React.RefObject<THREE.Mesh | null>;
  topology: CadTopology;
  onPick: CadSelectViewerProps['onPick'];
}) {
  const { camera, gl } = useThree();
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    const element = gl.domElement;
    const raycaster = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;

    const handleDown = (event: PointerEvent) => {
      down = { x: event.clientX, y: event.clientY };
    };
    const handleUp = (event: PointerEvent) => {
      if (!down) return;
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      down = null;
      if (moved > DRAG_TOLERANCE_PX || event.button !== 0) return;
      const mesh = meshRef.current;
      if (!mesh) return;
      const additive = event.ctrlKey || event.metaKey || event.shiftKey;
      const rect = element.getBoundingClientRect();
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          -((event.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
      mesh.updateWorldMatrix(true, false);
      const hit = raycaster.intersectObject(mesh, false)[0];
      if (!hit || hit.faceIndex == null) {
        // Silhouette edges have no surface under the cursor, so fall back to
        // the nearest projected edge within a few pixels.
        const near = edgesNearPointer(
          topology,
          mesh,
          camera,
          event.clientX - rect.left,
          event.clientY - rect.top,
          rect.width,
          rect.height,
        ).sort((a, b) => a.pixels - b.pixels)[0];
        const edge = near?.id;
        onPickRef.current(
          edge !== undefined ? { kind: 'edge', id: edge } : null,
          additive,
        );
        return;
      }
      // Back into the model's own units, where the topology lives.
      const local = mesh.worldToLocal(hit.point.clone());
      // Corners win over edges: they sit on the surface under the cursor.
      const corner = verticesNearPointer(
        topology,
        mesh,
        camera,
        event.clientX - rect.left,
        event.clientY - rect.top,
        rect.width,
        rect.height,
      )
        .map((candidate) => ({
          id: candidate.id,
          world: topology.vertices[candidate.id].point.distanceTo(local),
          pixels: candidate.pixels,
        }))
        .filter((candidate) => candidate.world < topology.size * 0.03)
        .sort((a, b) => a.pixels - b.pixels)[0];
      if (corner) {
        onPickRef.current({ kind: 'vertex', id: corner.id }, additive);
        return;
      }
      // Snap to an edge only when it is close on screen AND lies on the
      // surface under the cursor, not on a hidden part of the model.
      const snapped = edgesNearPointer(
        topology,
        mesh,
        camera,
        event.clientX - rect.left,
        event.clientY - rect.top,
        rect.width,
        rect.height,
      )
        .map((candidate) => ({
          id: candidate.id,
          world: distanceToEdge(topology.edges[candidate.id], local),
        }))
        .filter((candidate) => candidate.world < topology.size * 0.03)
        .sort((a, b) => a.world - b.world)[0];
      if (snapped) {
        onPickRef.current({ kind: 'edge', id: snapped.id }, additive);
        return;
      }
      const face = topology.triFace[hit.faceIndex];
      onPickRef.current(face >= 0 ? { kind: 'face', id: face } : null, additive);
    };

    element.addEventListener('pointerdown', handleDown);
    element.addEventListener('pointerup', handleUp);
    return () => {
      element.removeEventListener('pointerdown', handleDown);
      element.removeEventListener('pointerup', handleUp);
    };
  }, [camera, gl, meshRef, topology]);

  return null;
}

export function CadSelectViewer({
  geometry,
  topology,
  selection,
  plane = null,
  marker = null,
  highlight = null,
  color,
  onPick,
}: CadSelectViewerProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const scale = PREVIEW_SIZE / topology.size;

  const allEdges = useMemo(() => {
    const positions: number[] = [];
    for (const edge of topology.edges) {
      for (const point of edge.segments) positions.push(point.x, point.y, point.z);
    }
    const lines = new THREE.BufferGeometry();
    lines.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return lines;
  }, [topology]);

  const selectedFaces = useMemo(() => {
    const source = geometry.getAttribute('position');
    const positions: number[] = [];
    for (const item of selection) {
      if (item.kind !== 'face') continue;
      for (const triangle of topology.faces[item.id]?.triangles ?? []) {
        for (let corner = 0; corner < 3; corner++) {
          const index = triangle * 3 + corner;
          positions.push(source.getX(index), source.getY(index), source.getZ(index));
        }
      }
    }
    if (positions.length === 0) return null;
    const overlay = new THREE.BufferGeometry();
    overlay.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return overlay;
  }, [geometry, selection, topology]);

  const planeQuaternion = useMemo(
    () =>
      plane
        ? new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 0, 1),
            plane.normal,
          )
        : null,
    [plane],
  );

  const markerQuaternion = useMemo(
    () =>
      marker
        ? new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), marker.normal)
        : null,
    [marker],
  );

  const selectedEdges = useMemo(
    () =>
      selection.flatMap((item) =>
        item.kind === 'edge' && topology.edges[item.id]
          ? [
              {
                key: selectionKey(item),
                points: topology.edges[item.id].segments.map(
                  (point) => point.toArray() as [number, number, number],
                ),
              },
            ]
          : [],
      ),
    [selection, topology],
  );

  const selectedVertices = useMemo(
    () =>
      selection.flatMap((item) =>
        item.kind === 'vertex' && topology.vertices[item.id]
          ? [{ key: selectionKey(item), point: topology.vertices[item.id].point }]
          : [],
      ),
    [selection, topology],
  );

  return (
    <div className="relative h-full w-full overflow-hidden">
      <Suspense fallback={<div className="h-full w-full bg-[#3B3B3B]" />}>
        <Canvas className="block h-full w-full">
          <color attach="background" args={['#3B3B3B']} />
          <OrthographicCamera
            makeDefault
            position={[-100, 100, 100]}
            zoom={40}
            near={0.1}
            far={1000}
          />
          <Stage environment={null} intensity={0.6} position={[0, 0, 0]}>
            <Environment files={`${import.meta.env.BASE_URL}/city.hdr`} />
            <ambientLight intensity={0.8} />
            <directionalLight position={[5, 5, 5]} intensity={1.2} />
            <directionalLight position={[-5, 5, 5]} intensity={0.2} />
            <directionalLight position={[-5, -5, -5]} intensity={0.6} />
            {/* CAD is Z-up; the scene is Y-up. Scale only the preview. */}
            <group rotation={[-Math.PI / 2, 0, 0]} scale={scale}>
              <mesh ref={meshRef} geometry={geometry}>
                <meshStandardMaterial
                  color={color}
                  metalness={0.6}
                  roughness={0.3}
                  envMapIntensity={0.3}
                  side={THREE.DoubleSide}
                />
              </mesh>
              <lineSegments geometry={allEdges}>
                <lineBasicMaterial color="#0b1b2b" />
              </lineSegments>
              {selectedFaces && (
                <mesh geometry={selectedFaces}>
                  <meshBasicMaterial
                    color="#ff9f1c"
                    transparent
                    opacity={0.8}
                    side={THREE.DoubleSide}
                    depthWrite={false}
                    polygonOffset
                    polygonOffsetFactor={-2}
                    polygonOffsetUnits={-2}
                  />
                </mesh>
              )}
              {highlight && (
                <mesh geometry={highlight}>
                  <meshBasicMaterial
                    color="#e11d1d"
                    transparent
                    opacity={0.75}
                    side={THREE.DoubleSide}
                    depthWrite={false}
                    polygonOffset
                    polygonOffsetFactor={-4}
                    polygonOffsetUnits={-4}
                  />
                </mesh>
              )}
              {marker && markerQuaternion && (
                <mesh
                  position={marker.origin.clone().addScaledVector(marker.normal, topology.size * 0.003)}
                  quaternion={markerQuaternion}
                >
                  {/* Empty bounds keep the marker out of Stage's framing. */}
                  <circleGeometry
                    args={[marker.diameter / 2, 48]}
                    onUpdate={(geometry) => {
                      geometry.boundingBox = new THREE.Box3();
                    }}
                  />
                  <meshBasicMaterial
                    color="#e11d1d"
                    transparent
                    opacity={0.85}
                    side={THREE.DoubleSide}
                    depthWrite={false}
                    polygonOffset
                    polygonOffsetFactor={-4}
                    polygonOffsetUnits={-4}
                  />
                </mesh>
              )}
              {plane && planeQuaternion && (
                <mesh position={plane.origin} quaternion={planeQuaternion}>
                  {/* An empty bounding box keeps this guide out of Stage's
                      auto-framing, so selecting never moves the camera. */}
                  <planeGeometry
                    args={[topology.size * 1.4, topology.size * 1.4]}
                    onUpdate={(geometry) => {
                      geometry.boundingBox = new THREE.Box3();
                    }}
                  />
                  <meshBasicMaterial
                    color="#ff9f1c"
                    transparent
                    opacity={0.18}
                    side={THREE.DoubleSide}
                    depthWrite={false}
                  />
                </mesh>
              )}
              {selectedVertices.map((vertex) => (
                <mesh key={vertex.key} position={vertex.point}>
                  <sphereGeometry
                    args={[topology.size * 0.014, 16, 12]}
                    onUpdate={(geometry) => {
                      geometry.boundingBox = new THREE.Box3();
                    }}
                  />
                  <meshBasicMaterial color="#ffd23f" depthTest={false} />
                </mesh>
              ))}
              {selectedEdges.map((edge) => (
                <Line
                  key={edge.key}
                  points={edge.points}
                  segments
                  color="#ffd23f"
                  lineWidth={4}
                  depthTest={false}
                />
              ))}
            </group>
          </Stage>
          <Picker meshRef={meshRef} topology={topology} onPick={onPick} />
          <OrbitControls makeDefault enableDamping dampingFactor={0.05} />
          <ViewGizmo />
        </Canvas>
      </Suspense>
      <p className="pointer-events-none absolute bottom-2 left-3 text-xs text-white/70">
        Click a face, edge or corner · Ctrl/⌘-click to select several
      </p>
    </div>
  );
}
