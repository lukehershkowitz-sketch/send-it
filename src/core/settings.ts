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
  colors: RiderColors;
  playerName: string;
  mpCode: string;      // room code ('' = public)
  mpServer: string;    // '' = default (VITE_MP_URL or this site's /ws)
  graphics: 'auto' | 'low' | 'medium' | 'high';
}

export interface RiderColors { frame: string; jersey: string; pants: string; helmet: string }
export const PALETTES: Record<keyof RiderColors, string[]> = {
  frame: ['#26292e', '#ff5a1f', '#e8e8e8', '#1d1d1f', '#2f7bff', '#14c38e', '#ffd23f', '#d6245a', '#8f5bff'],
  jersey: ['#58626d', '#1fb5a6', '#ff5a1f', '#f4f4f4', '#24262b', '#2f7bff', '#ffd23f', '#d6245a', '#6fbf3a'],
  pants: ['#2b2f3a', '#4a5568', '#1d1d1f', '#7c5a36', '#3a5a40', '#e8e8e8', '#2f4a7b', '#8a2f2f'],
  helmet: ['#1b1d21', '#f4f4f4', '#1d1d1f', '#ff5a1f', '#2f7bff', '#ffd23f', '#14c38e', '#d6245a', '#c0c6cc'],
};

const KEY = 'sendit.settings.v1';
export const DEFAULT_SETTINGS: Settings = {
  volume: 0.8, muted: false, landingAssist: TUNING.air.autoLevel, renderScale: 1, showDebug: false,
  park: 'dirtline', lighting: 'day',
  colors: { frame: '#26292e', jersey: '#58626d', pants: '#2b3038', helmet: '#1b1d21' },
  playerName: '', mpCode: '', mpServer: '', graphics: 'auto',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>;
      // the old toy-bright default look was replaced by a muted one: don't keep it for anyone who never picked colours
      if (saved.colors && saved.colors.jersey === '#1fb5a6' && saved.colors.frame === '#ff5a1f' && saved.colors.helmet === '#f4f4f4') delete saved.colors;
      return { ...DEFAULT_SETTINGS, ...saved, colors: { ...DEFAULT_SETTINGS.colors, ...saved.colors } };
    }
  } catch { /* blocked or corrupt */ }
  return { ...DEFAULT_SETTINGS, colors: { ...DEFAULT_SETTINGS.colors } };
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

/** Settings that live in TUNING (it's `as const` for editor hints, but plain objects at runtime). */
export function applyTuningSettings(s: Settings) {
  (TUNING.air as { autoLevel: number }).autoLevel = s.landingAssist;
}
