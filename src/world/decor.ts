import {
  CanvasTexture, Color, ConeGeometry, CylinderGeometry, DirectionalLight, Fog, HemisphereLight,
  IcosahedronGeometry, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, RepeatWrapping, Scene,
  SRGBColorSpace, Vector3, type Mesh, type WebGLRenderer,
} from 'three';
import { TUNING } from '../tuning';
import type { World } from './World';

const SKY = 0xa9d4ee;

/** Browser-only dressing: sky, fog, lights, textured ground, trees and rocks. */
export function decorate(scene: Scene, world: World, renderer: WebGLRenderer) {
  scene.background = new Color(SKY);
  scene.fog = new Fog(SKY, TUNING.render.fogNear, TUNING.render.fogFar);
  scene.add(new HemisphereLight(0xdff1ff, 0x5d4a35, 1.5));
  const sun = new DirectionalLight(0xfff0d6, 2.2);
  sun.position.set(-30, 60, -20);
  scene.add(sun);

  // ground texture: grassy dirt with a faint grid (helps read speed)
  const tex = new CanvasTexture(groundCanvas());
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  for (const c of world.colliders) {
    if (c.geometry.type === 'PlaneGeometry') (c as Mesh).material = new MeshLambertMaterial({ map: tex });
  }

  // trees (instanced), kept out of the riding area
  const rand = mulberry32(7);
  const spots: Vector3[] = [];
  while (spots.length < 260) {
    const x = (rand() - 0.5) * 420, z = (rand() - 0.5) * 420;
    if (Math.abs(x) < 26 && z > -70 && z < 60) continue;
    if (Math.hypot(x, z) < 34) continue;
    spots.push(new Vector3(x, 0, z));
  }
  const crown = new InstancedMesh(new ConeGeometry(1, 1, 6), new MeshLambertMaterial({ color: 0x3f7a4a, flatShading: true }), spots.length);
  const trunk = new InstancedMesh(new CylinderGeometry(0.18, 0.25, 1, 5), new MeshLambertMaterial({ color: 0x5b4030 }), spots.length);
  const m = new Matrix4(), q = new Quaternion(), s = new Vector3(), p = new Vector3();
  spots.forEach((v, i) => {
    const h = 5 + rand() * 7, w = 1.6 + rand() * 1.4;
    m.compose(p.set(v.x, 1.2 + h / 2, v.z), q.identity(), s.set(w, h, w));
    crown.setMatrixAt(i, m);
    m.compose(p.set(v.x, 0.9, v.z), q, s.set(1, 1.8, 1));
    trunk.setMatrixAt(i, m);
    crown.setColorAt(i, new Color().setHSL(0.33 + rand() * 0.06, 0.38, 0.27 + rand() * 0.1));
  });
  scene.add(crown, trunk);

  const rocks = new InstancedMesh(new IcosahedronGeometry(1, 0), new MeshLambertMaterial({ color: 0x8b8b84, flatShading: true }), 60);
  for (let i = 0; i < 60; i++) {
    const a = rand() * Math.PI * 2, d = 22 + rand() * 120;
    const sc = 0.3 + rand() * 0.9;
    m.compose(p.set(Math.cos(a) * d, sc * 0.3, Math.sin(a) * d), q.setFromAxisAngle(new Vector3(0, 1, 0), rand() * 6), s.set(sc, sc * 0.7, sc));
    rocks.setMatrixAt(i, m);
  }
  scene.add(rocks);
}

function groundCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8ea46a';
  g.fillRect(0, 0, 256, 256);
  const rand = mulberry32(3);
  for (let i = 0; i < 2600; i++) {
    const l = 30 + rand() * 22;
    g.fillStyle = `hsl(${78 + rand() * 30}, ${25 + rand() * 20}%, ${l}%)`;
    g.fillRect(rand() * 256, rand() * 256, 2 + rand() * 3, 2 + rand() * 3);
  }
  g.strokeStyle = 'rgba(40,50,25,0.22)';
  g.lineWidth = 2;
  g.strokeRect(1, 1, 254, 254);
  return c;
}

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
