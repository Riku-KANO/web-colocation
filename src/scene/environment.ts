import {
  BoxGeometry,
  Color,
  DirectionalLight,
  EdgesGeometry,
  GridHelper,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  type Scene,
} from 'three';
import { TABLE } from '../../shared/protocol.ts';

export type ViewMode = 'desktop' | 'vr' | 'ar';

const SKY = new Color('#dfe6ee');

export class Environment {
  /** 端末ローカル (床基準) の背景。AR では隠してパススルーを見せる。 */
  readonly world = new Group();
  /** 共有座標系に置くテーブル。原点 = 天板中心。 */
  readonly table = new Group();
  private readonly legs = new Group();
  private readonly topMat: MeshStandardMaterial;
  private readonly scene: Scene;
  tableVisible = true;

  constructor(scene: Scene) {
    this.scene = scene;
    scene.add(new HemisphereLight('#ffffff', '#8a8f99', 2.2));
    const sun = new DirectionalLight('#ffffff', 1.6);
    sun.position.set(1, 3, 2);
    scene.add(sun);

    const grid = new GridHelper(20, 40, '#9aa3ad', '#c3cad2');
    this.world.add(grid);
    const floor = new Mesh(new BoxGeometry(20, 0.01, 20), new MeshStandardMaterial({ color: '#d4d9df', roughness: 1 }));
    floor.position.y = -0.006;
    this.world.add(floor);
    scene.add(this.world);

    this.topMat = new MeshStandardMaterial({ color: '#b08d6a', roughness: 0.7, transparent: true });
    const top = new Mesh(new BoxGeometry(TABLE.width, 0.03, TABLE.depth), this.topMat);
    top.name = 'table-top';
    top.position.y = -0.015;
    const edges = new LineSegments(new EdgesGeometry(top.geometry), new LineBasicMaterial({ color: '#ffffff' }));
    edges.position.copy(top.position);
    const legMat = new MeshStandardMaterial({ color: '#6b5440', roughness: 0.8 });
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const leg = new Mesh(new BoxGeometry(0.05, TABLE.height, 0.05), legMat);
        leg.position.set(sx * (TABLE.width / 2 - 0.06), -TABLE.height / 2, sz * (TABLE.depth / 2 - 0.06));
        this.legs.add(leg);
      }
    // 共有原点と +X 方向 (ボード側) の目印。キャリブレーションのズレ確認用。
    const axis = new Mesh(new BoxGeometry(0.12, 0.002, 0.006), new MeshStandardMaterial({ color: '#e63946' }));
    axis.position.set(0.06, 0.001, 0);
    const dot = new Mesh(new BoxGeometry(0.012, 0.003, 0.012), new MeshStandardMaterial({ color: '#ffffff' }));
    this.table.add(top, edges, this.legs, axis, dot);
    this.table.name = 'table';
  }

  setMode(mode: ViewMode): void {
    const ar = mode === 'ar';
    this.world.visible = !ar;
    this.legs.visible = !ar;
    this.scene.background = ar ? null : SKY;
    // AR では実物の机に重ねるので天板を半透明に
    this.topMat.opacity = ar ? 0.28 : 1;
    this.topMat.depthWrite = !ar;
  }

  setTableVisible(v: boolean): void {
    this.tableVisible = v;
    this.table.visible = v;
  }
}
