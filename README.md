# SEND IT

Arcade BMX in the browser — Vite + TypeScript + Three.js, custom kinematic rider (no rigid-body physics).

```bash
npm install
npm run dev     # http://localhost:5173
npm run sim     # headless scripted rides through the real controller (feel regression check)
```

All feel/score numbers live in `src/tuning.ts`.

## Layout
| Path | What |
|---|---|
| `src/tuning.ts` | every tunable number |
| `src/core/loop.ts` | fixed 120 Hz sim + interpolated render, timeScale (slow-mo) |
| `src/core/input/` | action layer: keyboard + Gamepad API → `InputState`; bindings persist to localStorage |
| `src/rider/RiderController.ts` | kinematic state + transitions, landing check, bail, landing prediction |
| `src/rider/states/` | `Grounded`, `Airborne`, `Bailed` (Grinding / Manualing in Phase 2) |
| `src/rider/RiderRig.ts` | low-poly bike (frame & front-end pivot on the steering axis for whips/barspins) + IK rider |
| `src/world/` | `World` (collision raycasts w/ smooth normals), modular `pieces`, park JSON in `parks/` |
| `src/camera/ChaseCam.ts` | lagging chase cam, speed pull-back, air FOV, free-look |
| `src/ui/` | DOM HUD + debug overlay |
| `scripts/sim.ts` | headless ride tests |
