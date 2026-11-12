import type { BufferGeometry, Mesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** One single-material piece of a part: geometry + material key. */
export interface ModelPiece { geometry: BufferGeometry; mat: string }
/** part / kind name (frame, wheel, pine_a, …) → its pieces. */
export type ModelKit = Map<string, ModelPiece[]>;
export type RigModels = ModelKit;

const cache = new Map<string, ModelKit>();
const pending = new Map<string, Promise<ModelKit | null>>();

/**
 * Load a Blender-built kit (blender/*.py). Objects are named `<part>__<material>`; geometry is
 * shared by everything that uses it. Resolves null on failure (callers keep built-in shapes).
 */
export function loadKit(file: string): Promise<ModelKit | null> {
  const hit = cache.get(file);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(file);
  if (!p) {
    p = new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}models/${file}`).then((gltf) => {
      const parts: ModelKit = new Map();
      gltf.scene.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        const [part, mat] = m.name.split('__');
        if (!part || !mat) return;
        if (!parts.has(part)) parts.set(part, []);
        parts.get(part)!.push({ geometry: m.geometry, mat });
      });
      cache.set(file, parts);
      return parts;
    }).catch((e) => {
      console.warn(`${file} failed to load, using built-in shapes`, e);
      return null;
    });
    pending.set(file, p);
  }
  return p;
}

export const loadRigModels = () => loadKit('rider.glb');
export const rigModelsIfLoaded = () => cache.get('rider.glb') ?? null;
export const loadSceneryKit = () => loadKit('scenery.glb');
