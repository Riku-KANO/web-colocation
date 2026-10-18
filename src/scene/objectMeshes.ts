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
  type Object3D,
} from 'three';
import type { ObjectKind } from '../../shared/protocol.ts';

/** ペンの長さ方向は -Z。ペン先 (ローカル座標)。 */
export const PEN_TIP = new Vector3(0, 0, -0.078);

export interface BuiltObject {
  root: Object3D;
  /** 所有者ハイライト用に emissive を変えるマテリアル。 */
  materials: MeshStandardMaterial[];
  /** 近接グラブの判定半径 (メートル)。 */
  grabRadius: number;
}

export function buildObjectMesh(kind: ObjectKind, color: string): BuiltObject {
  const mat = new MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.05 });
  switch (kind) {
    case 'cube':
      return single(new Mesh(new BoxGeometry(0.1, 0.1, 0.1), mat), mat, 0.08);
    case 'sphere':
      return single(new Mesh(new SphereGeometry(0.06, 32, 16), mat), mat, 0.075);
    case 'cone':
      return single(new Mesh(new ConeGeometry(0.055, 0.12, 32), mat), mat, 0.075);
    case 'torus':
      return single(new Mesh(new TorusGeometry(0.045, 0.017, 16, 48), mat), mat, 0.07);
    case 'pen':
      return buildPen(mat);
  }
}

function single(mesh: Mesh, mat: MeshStandardMaterial, grabRadius: number): BuiltObject {
  mesh.castShadow = true;
  return { root: mesh, materials: [mat], grabRadius };
}

function buildPen(inkMat: MeshStandardMaterial): BuiltObject {
  const g = new Group();
  const bodyMat = new MeshStandardMaterial({ color: '#f4f4f4', roughness: 0.35 });
  const body = new Mesh(new CylinderGeometry(0.008, 0.008, 0.12, 20), bodyMat);
  body.rotation.x = Math.PI / 2; // Y 軸の円柱を Z 軸方向へ
  const cap = new Mesh(new CylinderGeometry(0.0085, 0.0085, 0.03, 20), inkMat);
  cap.rotation.x = Math.PI / 2;
  cap.position.z = 0.05;
  const tip = new Mesh(new ConeGeometry(0.008, 0.018, 20), inkMat);
  tip.rotation.x = -Math.PI / 2; // 先端を -Z へ
  tip.position.z = -0.069;
  g.add(body, cap, tip);
  return { root: g, materials: [bodyMat, inkMat], grabRadius: 0.08 };
}
