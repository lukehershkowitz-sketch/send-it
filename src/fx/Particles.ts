import {
  BufferAttribute, BufferGeometry, Color, NormalBlending, Points, ShaderMaterial, type Texture, Vector3,
} from 'three';

const MAX = 400;

/**
 * One pooled particle system (single draw call). Dust is soft brown puffs that grow and
 * fade; sparks are small additive dots. Simulated on the CPU, cheap at a few hundred particles.
 */
export class Particles {
  readonly points: Points;
  private pos = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private col = new Float32Array(MAX * 3);
  private size = new Float32Array(MAX);
  private alpha = new Float32Array(MAX);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private grow = new Float32Array(MAX);
  private next = 0;
  private geo = new BufferGeometry();
  private c = new Color();
  dustColor = new Color(0xc79a6b);

  constructor(tex: Texture) {
    const g = this.geo;
    g.setAttribute('position', new BufferAttribute(this.pos, 3));
    g.setAttribute('color', new BufferAttribute(this.col, 3));
    g.setAttribute('size', new BufferAttribute(this.size, 1));
    g.setAttribute('alpha', new BufferAttribute(this.alpha, 1));
    const mat = new ShaderMaterial({
      uniforms: { map: { value: tex }, scale: { value: 300 } },
      vertexShader: `
        attribute float size; attribute float alpha; attribute vec3 color;
        varying float vA; varying vec3 vC; uniform float scale;
        void main() {
          vA = alpha; vC = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * scale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map; varying float vA; varying vec3 vC;
        void main() {
          float a = texture2D(map, gl_PointCoord).a * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vC, a);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
    });
    this.points = new Points(g, mat);
    this.points.frustumCulled = false;
  }

  setViewportHeight(h: number) { (this.points.material as ShaderMaterial).uniforms.scale.value = h * 0.55; }
  setNight(night: boolean) { this.dustColor.set(night ? 0x6a5a4c : 0xc79a6b); }

  private spawn(p: Vector3, v: Vector3, color: Color, size: number, life: number, grow: number) {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grow[i] = grow;
  }

  /** Burst of dust, e.g. landings (strength 0..1+). */
  dust(at: Vector3, strength: number, dir?: Vector3) {
    const n = Math.round(6 + strength * 22);
    const v = new Vector3();
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, sp = (0.6 + Math.random() * 2.2) * (0.5 + strength);
      v.set(Math.cos(a) * sp, 0.4 + Math.random() * 1.4 * (0.5 + strength), Math.sin(a) * sp);
      if (dir) v.addScaledVector(dir, 0.35);
      this.c.copy(this.dustColor).multiplyScalar(0.85 + Math.random() * 0.3);
      this.spawn(at, v, this.c, 0.35 + Math.random() * 0.35, 0.7 + Math.random() * 0.7, 1.4);
    }
  }

  /** A trickle of dust behind the rear wheel (skids / hard carves); call per frame. */
  trail(at: Vector3, back: Vector3, rate: number, dt: number) {
    if (Math.random() > rate * dt * 30) return;
    const v = new Vector3().copy(back).multiplyScalar(0.8 + Math.random()).add(new Vector3((Math.random() - 0.5) * 0.6, 0.3 + Math.random() * 0.5, (Math.random() - 0.5) * 0.6));
    this.c.copy(this.dustColor);
    this.spawn(at, v, this.c, 0.25 + Math.random() * 0.2, 0.5 + Math.random() * 0.4, 1.8);
  }

  /** Grind sparks. */
  sparks(at: Vector3, dir: Vector3) {
    const v = new Vector3();
    for (let k = 0; k < 3; k++) {
      v.copy(dir).multiplyScalar(-1.5 - Math.random() * 2).add(new Vector3((Math.random() - 0.5) * 2, 0.5 + Math.random() * 1.5, (Math.random() - 0.5) * 2));
      this.c.setRGB(1, 0.75 + Math.random() * 0.2, 0.4);
      this.spawn(at, v, this.c, 0.06, 0.25 + Math.random() * 0.2, 0);
    }
  }

  update(dt: number) {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const k = i * 3;
      const spark = this.grow[i] === 0;
      this.vel[k + 1] -= (spark ? 9 : 1.2) * dt;
      const drag = Math.exp(-(spark ? 0.5 : 2.2) * dt);
      this.vel[k] *= drag; this.vel[k + 1] *= drag; this.vel[k + 2] *= drag;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = spark ? t : Math.min(1, t * 1.6) * 0.55;
    }
    for (const n of ['position', 'size', 'alpha', 'color']) this.geo.getAttribute(n).needsUpdate = true;
  }

  dispose() { this.geo.dispose(); (this.points.material as ShaderMaterial).dispose(); }
}

