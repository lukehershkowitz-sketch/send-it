# SEND IT

Arcade BMX in the browser — Vite + TypeScript + Three.js, custom kinematic rider (no rigid-body physics).

```bash
npm install
npm run dev     # http://localhost:5173
npm run sim            # headless scripted rides through the real controller (feel regression check)
npm run ride:dirtline  # a bot rides the whole Dirt Line and must finish with 0 bails
npm run gen:dirtline   # regenerate the Dirt Line layout (gaps are sized by simulation)
```

All feel/score numbers live in `src/tuning.ts`.

## Layout
| Path | What |
|---|---|
| `src/tuning.ts` | every tunable number |
| `src/core/loop.ts` | fixed 120 Hz sim + interpolated render, timeScale (slow-mo) |
| `src/core/input/` | action layer: keyboard + Gamepad API → `InputState`; bindings persist to localStorage |
| `src/rider/RiderController.ts` | kinematic state + transitions, landing check, bail, landing prediction |
| `src/rider/states/` | `Grounded`, `Airborne`, `Grinding`, `Manualing`, `Bailed` |
| `src/rider/RiderRig.ts` | low-poly bike (frame & front-end pivot on the steering axis for whips/barspins) + IK rider |
| `src/world/` | `World` (collision raycasts w/ smooth normals), modular `pieces`, park JSON in `parks/` (+ `parks/index.ts` registry) |
| `src/world/decor.ts` | themes (meadow/forest), day/night lighting, lamps, trees, dirt track; `textures.ts` makes canvas textures |
| `src/audio/Sfx.ts` | procedural WebAudio: rolling, freewheel clicks, wind, skid, grind, landings, crash, chimes |
| `src/fx/Particles.ts` | pooled dust / spark particles (one draw call) |
| `src/ui/Menu.ts` | main / park select / pause / settings / control remapping (mouse, keyboard, gamepad) |
| `src/core/settings.ts` | persisted settings (volume, landing assist, render quality, debug, last park) |
| `src/camera/ChaseCam.ts` | lagging chase cam, speed pull-back, air FOV, free-look |
| `src/ui/` | DOM HUD + debug overlay |
| `src/tricks/scoring.ts` | trick naming, per-element points, repetition keys, multipliers |
| `src/tricks/Combo.ts` | the current line: accumulate, link multiplier, bank on clean ride-away, lose on bail |
| `src/tricks/Run.ts` | timed run, category totals, personal best per park (localStorage) |
| `scripts/sim.ts` | headless ride tests |

## Parks
A park is a JSON file: `spawn`, optional `checkpoints` (you respawn rolling at the last one you passed),
optional `finish` (reaching it banks the line and sends you back to the top), `decor`, and `pieces`
(`ground`, `kicker`, `landing`, `rail`, `ledge`). Add it to `src/world/parks/index.ts` to make it selectable.

## Scoring
- A line accumulates tricks (airs, grinds, manuals). It **banks** after you roll on the ground for
  `score.linkWindow` s without starting another trick; a **bail loses** the whole line.
- Line multiplier = 1 + 0.5 × (tricks in line − 1). Landing in a manual (hold B) or popping off a
  grind keeps the line going.
- Air multipliers: inverted (any flip) ×1.5, stomp ×1.25. Grabs count after 0.25 s and scale up to ×2 at 1 s.
- Repetition: an element seen in 1/2/3 of your last 3 airs pays 75/55/40 %. Spin direction and fakie
  take-offs are different keys, so switching them resets to full points.
