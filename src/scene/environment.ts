// Lights, the local floor and the room's furniture (tables), built from the RoomConfig.

import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  EdgesGeometry,
  GridHelper,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  type BufferGeometry,
  type Scene,
} from 'three';
import type { EnvironmentSpec, RoomConfig, TableSpec } from '../../shared/roomConfig.ts';

export type ViewMode = 'desktop' | 'vr' | 'ar';

const TOP_THICKNESS = 0.03;

export class Environment {
  /** Device-local background (floor). Hidden in AR so passthrough shows. */
  readonly world = new Group();
  /** Furniture in the shared frame (child of sharedRoot). */
  readonly table = new Group();
  tableVisible = true;

  private readonly scene: Scene;
  private readonly hemi: HemisphereLight;
  private readonly sun: DirectionalLight;
  private readonly topMaterials: MeshStandardMaterial[] = [];
  private readonly legs: Group[] = [];
  private env: EnvironmentSpec = { background: '#dfe6ee', floor: 'grid', floorColor: '#d4d9df', light: 1 };
  private mode: ViewMode = 'desktop';

  constructor(scene: Scene) {
    this.scene = scene;
    this.hemi = new HemisphereLight('#ffffff', '#8a8f99', 2.2);
    this.sun = new DirectionalLight('#ffffff', 1.6);
    this.sun.position.set(1, 3, 2);
    scene.add(this.hemi, this.sun, this.world);
    this.table.name = 'furniture';
  }

  /** Rebuild furniture and the environment for a (new) room configuration. */
  applyConfig(config: RoomConfig): void {
    this.env = config.environment;
    this.hemi.intensity = 2.2 * config.environment.light;
    this.sun.intensity = 1.6 * config.environment.light;

    disposeChildren(this.world);
    if (config.environment.floor !== 'none') {
      const floor = new Mesh(new BoxGeometry(20, 0.01, 20), new MeshStandardMaterial({ color: config.environment.floorColor, roughness: 1 }));
      floor.position.y = -0.006;
      this.world.add(floor);
      if (config.environment.floor === 'grid') this.world.add(new GridHelper(20, 40, '#9aa3ad', '#c3cad2'));
    }

    disposeChildren(this.table);
    this.topMaterials.length = 0;
    this.legs.length = 0;
    for (const t of config.tables) this.table.add(this.buildTable(t, config.anchor.floorOffset));
    if (config.anchor.kind === 'table') {
      // Shared origin and +X direction markers (to check calibration).
      const axis = new Mesh(new BoxGeometry(0.12, 0.002, 0.006), new MeshStandardMaterial({ color: '#e63946' }));
      axis.position.set(0.06, 0.001, 0);
      const dot = new Mesh(new BoxGeometry(0.012, 0.003, 0.012), new MeshStandardMaterial({ color: '#ffffff' }));
      this.table.add(axis, dot);
    }
    this.setMode(this.mode);
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    const ar = mode === 'ar';
    this.world.visible = !ar;
    for (const l of this.legs) l.visible = !ar;
    this.scene.background = ar ? null : new Color(this.env.background);
    // In AR the virtual table top is overlaid on the real one, so make it translucent.
    for (const m of this.topMaterials) {
      m.opacity = ar ? 0.28 : 1;
      m.depthWrite = !ar;
    }
  }

  setTableVisible(v: boolean): void {
    this.tableVisible = v;
    this.table.visible = v;
  }

  private buildTable(t: TableSpec, floorOffset: number): Group {
    const g = new Group();
    g.name = `table:${t.id}`;
    const topY = t.height - floorOffset;
    g.position.set(t.x, topY, t.z);
    g.rotation.y = t.yaw;
    const topMat = new MeshStandardMaterial({ color: t.color, roughness: 0.7, transparent: true });
    this.topMaterials.push(topMat);
    const topGeo: BufferGeometry =
      t.shape === 'round'
        ? new CylinderGeometry(t.width / 2, t.width / 2, TOP_THICKNESS, 48)
        : new BoxGeometry(t.width, TOP_THICKNESS, t.depth);
    const top = new Mesh(topGeo, topMat);
    top.name = 'table-top';
    top.position.y = -TOP_THICKNESS / 2;
    const edges = new LineSegments(new EdgesGeometry(topGeo, 30), new LineBasicMaterial({ color: '#ffffff' }));
    edges.position.copy(top.position);
    const legs = new Group();
    const legMat = new MeshStandardMaterial({ color: '#6b5440', roughness: 0.8 });
    const legH = t.height - TOP_THICKNESS;
    if (t.shape === 'round') {
      const post = new Mesh(new CylinderGeometry(0.04, 0.04, legH, 16), legMat);
      post.position.y = -TOP_THICKNESS - legH / 2;
      const foot = new Mesh(new CylinderGeometry(0.3, 0.3, 0.02, 32), legMat);
      foot.position.y = -t.height + 0.01;
      legs.add(post, foot);
    } else {
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          const leg = new Mesh(new BoxGeometry(0.05, legH, 0.05), legMat);
          leg.position.set(sx * (t.width / 2 - 0.06), -TOP_THICKNESS - legH / 2, sz * (t.depth / 2 - 0.06));
          legs.add(leg);
        }
    }
    this.legs.push(legs);
    g.add(top, edges, legs);
    return g;
  }
}

function disposeChildren(group: Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
  }
}
