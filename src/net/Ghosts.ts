import { CanvasTexture, Scene, Sprite, SpriteMaterial } from 'three';
import { RiderRig, lerpSnapshot, makeSnapshot, type RigSnapshot } from '../rider/RiderRig';
import { decodeSnapshot, type PlayerInfo } from './protocol';
import type { World } from '../world/World';

interface Sample { t: number; snap: RigSnapshot }

class Ghost {
  rig: RiderRig;
  label: Sprite;
  buf: Sample[] = [];
  out = makeSnapshot();
  lastT = 0;
  constructor(public info: PlayerInfo, scene: Scene) {
    this.rig = new RiderRig();
    this.rig.setColors(info.colors);
    this.rig.setGhost(0.72);
    this.label = nameTag(info.name, info.colors.jersey);
    scene.add(this.rig.root, this.rig.shadow, this.label);
    this.rig.root.visible = this.label.visible = this.rig.shadow.visible = false;
  }
  dispose(scene: Scene) {
    scene.remove(this.rig.root, this.rig.shadow, this.label, this.rig.bikeBody, this.rig.riderBody);
    (this.label.material as SpriteMaterial).map?.dispose();
    this.label.material.dispose();
  }
}

/** Other riders in the room, drawn ~150 ms in the past and interpolated between server updates. */
export class Ghosts {
  private ghosts = new Map<number, Ghost>();
  /** Draw blob shadows (when real shadows are off). */
  blobShadows = true;
  constructor(private scene: Scene) {}

  get count() { return this.ghosts.size; }

  sync(players: Map<number, PlayerInfo>) {
    for (const [id, g] of this.ghosts) if (!players.has(id)) { g.dispose(this.scene); this.ghosts.delete(id); }
    for (const [id, p] of players) {
      const g = this.ghosts.get(id);
      if (!g) this.ghosts.set(id, new Ghost(p, this.scene));
      else if (g.info.name !== p.name || JSON.stringify(g.info.colors) !== JSON.stringify(p.colors)) {
        g.dispose(this.scene);
        this.ghosts.set(id, new Ghost(p, this.scene));
      }
    }
  }

  clear() { for (const g of this.ghosts.values()) g.dispose(this.scene); this.ghosts.clear(); }

  push(id: number, t: number, data: number[]) {
    const g = this.ghosts.get(id);
    if (!g || t <= g.lastT) return;
    g.lastT = t;
    const snap = decodeSnapshot(data, g.buf.length >= 40 ? g.buf.shift()!.snap : makeSnapshot());
    g.buf.push({ t, snap });
  }

  /** `renderT` = server time to show (now − interpolation delay). */
  update(renderT: number, world: World) {
    for (const g of this.ghosts.values()) {
      const b = g.buf;
      const visible = b.length > 0 && renderT - b[b.length - 1].t < 3000;
      g.rig.root.visible = g.label.visible = visible;
      g.rig.shadow.visible = visible && this.blobShadows;
      g.rig.bikeBody.visible = g.rig.riderBody.visible = visible;
      if (!visible) continue;
      // find the pair around renderT (hold the newest if we've run past it)
      let i = b.length - 1;
      while (i > 0 && b[i - 1].t > renderT) i--;
      const a = b[Math.max(0, i - 1)], c = b[i];
      const k = c.t === a.t ? 1 : (renderT - a.t) / (c.t - a.t);
      const s = lerpSnapshot(a.snap, c.snap, k, g.out);
      g.rig.apply(s);
      const head = s.bailed ? s.riderPos : s.pos;
      g.label.position.set(head.x, head.y + (s.bailed ? 1.1 : 2.15), head.z);
      const ground = world.groundBelow(s.bailed ? s.bikePos : s.pos);
      g.rig.shadow.visible = !!ground && this.blobShadows;
      if (ground) {
        g.rig.shadow.position.copy(ground.point).addScaledVector(ground.normal, 0.02);
        g.rig.shadow.quaternion.setFromUnitVectors(g.rig.shadow.up, ground.normal);
      }
    }
  }
}

function nameTag(name: string, color: string): Sprite {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d')!;
  g.font = '800 30px system-ui, sans-serif';
  const w = Math.min(240, g.measureText(name).width + 34);
  g.fillStyle = 'rgba(10,14,20,0.7)';
  g.beginPath(); g.roundRect((256 - w) / 2, 10, w, 44, 22); g.fill();
  g.fillStyle = color; g.beginPath(); g.arc((256 - w) / 2 + 18, 32, 7, 0, 7); g.fill();
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(name, 128 + 8, 33);
  const tex = new CanvasTexture(c);
  const s = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(1.6, 0.4, 1);
  s.renderOrder = 5;
  return s;
}
