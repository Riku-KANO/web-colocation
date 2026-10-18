// Visuals for shared objects. Every object is a Group (so a model can be swapped in later).

import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
} from 'three';
import type { ObjectSpec } from '../../shared/roomConfig.ts';

/** Pens point along -Z. Pen tip in local coordinates. */
export const PEN_TIP = new Vector3(0, 0, -0.078);

export interface BuiltObject {
  root: Group;
  /** Materials whose emissive colour shows who is holding the object. */
  materials: MeshStandardMaterial[];
  /** Near-grab radius (m). */
  grabRadius: number;
  dispose(): void;
}

export function objectSignature(spec: Pick<ObjectSpec, 'kind' | 'color' | 'scale' | 'model'>): string {
  return JSON.stringify([spec.kind, spec.color, spec.scale ?? 1, spec.model?.src ?? null, spec.model?.scale ?? null]);
}

export function buildObjectMesh(spec: Pick<ObjectSpec, 'kind' | 'color' | 'scale' | 'model'>): BuiltObject {
  const mat = new MeshStandardMaterial({ color: spec.color, roughness: 0.45, metalness: 0.05 });
  const scale = spec.scale ?? 1;
  let built: BuiltObject;
  switch (spec.kind) {
    case 'cube':
      built = single(new BoxGeometry(0.1, 0.1, 0.1), mat, 0.08);
      break;
    case 'sphere':
      built = single(new SphereGeometry(0.06, 32, 16), mat, 0.075);
      break;
    case 'cone':
      built = single(new ConeGeometry(0.055, 0.12, 32), mat, 0.075);
      break;
    case 'torus':
      built = single(new TorusGeometry(0.045, 0.017, 16, 48), mat, 0.07);
      break;
    case 'pen':
      built = buildPen(mat);
      break;
    case 'model':
      // Placeholder until the glTF is loaded (see scene/modelLoader.ts).
      mat.transparent = true;
      mat.opacity = 0.35;
      built = single(new BoxGeometry(0.12, 0.12, 0.12), mat, spec.model?.grabRadius ?? 0.1);
      break;
  }
  if (scale !== 1) {
    built.root.scale.setScalar(scale);
    built.grabRadius *= scale;
  }
  return built;
}

function disposeGroup(g: Group): void {
  g.traverse((o) => {
    const m = o as Mesh;
    m.geometry?.dispose();
    (m.material as MeshStandardMaterial | undefined)?.dispose?.();
  });
}

function single(geo: BufferGeometry, mat: MeshStandardMaterial, grabRadius: number): BuiltObject {
  const root = new Group();
  const mesh = new Mesh(geo, mat);
  mesh.castShadow = true;
  root.add(mesh);
  return { root, materials: [mat], grabRadius, dispose: () => disposeGroup(root) };
}

function buildPen(inkMat: MeshStandardMaterial): BuiltObject {
  const g = new Group();
  const bodyMat = new MeshStandardMaterial({ color: '#f4f4f4', roughness: 0.35 });
  const body = new Mesh(new CylinderGeometry(0.008, 0.008, 0.12, 20), bodyMat);
  body.rotation.x = Math.PI / 2; // Y-axis cylinder → along Z
  const cap = new Mesh(new CylinderGeometry(0.0085, 0.0085, 0.03, 20), inkMat);
  cap.rotation.x = Math.PI / 2;
  cap.position.z = 0.05;
  const tip = new Mesh(new ConeGeometry(0.008, 0.018, 20), inkMat);
  tip.rotation.x = -Math.PI / 2; // point the tip towards -Z
  tip.position.z = -0.069;
  g.add(body, cap, tip);
  return { root: g, materials: [bodyMat, inkMat], grabRadius: 0.08, dispose: () => disposeGroup(g) };
}
