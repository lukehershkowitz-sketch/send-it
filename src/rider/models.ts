import type { BufferGeometry, Mesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** One single-material piece of a part: geometry + RiderRig material key. */
export interface ModelPiece { geometry: BufferGeometry; mat: string }
/** part name (frame, front, wheel, thigh, …) → its pieces. */
export type RigModels = Map<string, ModelPiece[]>;

let cache: RigModels | null = null;
let pending: Promise<RigModels | null> | null = null;

/**
 * Loads public/models/rider.glb (built by blender/build_rider.py). Objects are named
 * `<part>__<material>`; geometry is shared by every rig that uses it. Resolves null on failure
 * (the rig keeps its built-in procedural parts).
 */
export function loadRigModels(url = `${import.meta.env.BASE_URL}models/rider.glb`): Promise<RigModels | null> {
  if (cache) return Promise.resolve(cache);
  pending ??= new GLTFLoader().loadAsync(url).then((gltf) => {
    const parts: RigModels = new Map();
    gltf.scene.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const [part, mat] = m.name.split('__');
      if (!part || !mat) return;
      if (!parts.has(part)) parts.set(part, []);
      parts.get(part)!.push({ geometry: m.geometry, mat });
    });
    cache = parts;
    return parts;
  }).catch((e) => {
    console.warn('rider.glb failed to load, using built-in models', e);
    return null;
  });
  return pending;
}

export const rigModelsIfLoaded = () => cache;
