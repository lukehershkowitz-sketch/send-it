import { TUNING } from '../tuning';
import type { Lighting } from '../world/decor';

export interface Settings {
  volume: number;        // 0..1
  muted: boolean;
  landingAssist: number; // 0..1 → TUNING.air.autoLevel
  renderScale: number;   // multiplier on device pixel ratio
  showDebug: boolean;
  park: string;
  lighting: Lighting;
}

const KEY = 'sendit.settings.v1';
export const DEFAULT_SETTINGS: Settings = {
  volume: 0.8, muted: false, landingAssist: TUNING.air.autoLevel, renderScale: 1, showDebug: false,
  park: 'dirtline', lighting: 'day',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch { /* blocked or corrupt */ }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

/** Settings that live in TUNING (it's `as const` for editor hints, but plain objects at runtime). */
export function applyTuningSettings(s: Settings) {
  (TUNING.air as { autoLevel: number }).autoLevel = s.landingAssist;
}
