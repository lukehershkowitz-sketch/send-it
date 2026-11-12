import { CanvasTexture, ClampToEdgeWrapping, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';

/** Procedural canvas textures (browser only). Seeded so they look the same every load. */
export function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function make(size: number, draw: (g: CanvasRenderingContext2D, r: () => number) => void, seed: number, aniso = 4): Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, rng(seed));
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

function speckle(g: CanvasRenderingContext2D, r: () => number, n: number, size: number, color: () => string, max = 3) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = color();
    const s = 1 + r() * max;
    g.fillRect(r() * size, r() * size, s, s);
  }
}

export const textures = {
  grass: (aniso: number) => make(256, (g, r) => {
    g.fillStyle = '#8ea46a'; g.fillRect(0, 0, 256, 256);
    speckle(g, r, 2600, 256, () => `hsl(${78 + r() * 30}, ${25 + r() * 20}%, ${30 + r() * 22}%)`);
    g.strokeStyle = 'rgba(40,50,25,0.18)'; g.lineWidth = 2; g.strokeRect(1, 1, 254, 254);
  }, 3, aniso),

  forestFloor: (aniso: number) => make(256, (g, r) => {
    g.fillStyle = '#5d6b3c'; g.fillRect(0, 0, 256, 256);
    speckle(g, r, 2200, 256, () => `hsl(${60 + r() * 40}, ${20 + r() * 20}%, ${22 + r() * 18}%)`);
    speckle(g, r, 900, 256, () => `hsl(${28 + r() * 12}, ${35 + r() * 15}%, ${22 + r() * 12}%)`, 4); // needles / leaves
    g.strokeStyle = 'rgba(30,35,15,0.16)'; g.lineWidth = 2; g.strokeRect(1, 1, 254, 254);
  }, 5, aniso),

  /** Packed dirt for jump tops: u = across, v = along. Darker tyre ruts down the middle. */
  dirtTop: (aniso: number) => make(256, (g, r) => {
    g.fillStyle = '#b78350'; g.fillRect(0, 0, 256, 256);
    speckle(g, r, 2600, 256, () => `hsl(${26 + r() * 10}, ${38 + r() * 18}%, ${38 + r() * 18}%)`, 2);
    for (const x of [0, 38]) {
      const grd = g.createLinearGradient(x, 0, x + 26, 0);
      grd.addColorStop(0, 'rgba(70,40,20,0)'); grd.addColorStop(0.5, 'rgba(70,40,20,0.22)'); grd.addColorStop(1, 'rgba(70,40,20,0)');
      g.fillStyle = grd; g.fillRect(x, 0, 26, 256);
    }
    speckle(g, r, 140, 256, () => `rgba(255,240,210,${0.15 + r() * 0.2})`, 2); // pebbles
  }, 7, aniso),

  dirtSide: (aniso: number) => make(256, (g, r) => {
    g.fillStyle = '#9a6a42'; g.fillRect(0, 0, 256, 256);
    speckle(g, r, 3000, 256, () => `hsl(${24 + r() * 12}, ${30 + r() * 20}%, ${28 + r() * 18}%)`, 3);
    speckle(g, r, 300, 256, () => `hsl(${80 + r() * 30}, 35%, ${28 + r() * 14}%)`, 3); // weeds
  }, 11, aniso),

  /** Soft radial blob (dust, light pools, halos). */
  radial: () => {
    const t = make(64, (g) => {
      const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.45, 'rgba(255,255,255,0.45)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
    }, 1, 1);
    t.wrapS = t.wrapT = ClampToEdgeWrapping;
    return t;
  },
};
