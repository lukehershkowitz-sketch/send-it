# SEND IT

Arcade BMX in the browser — Vite + TypeScript + Three.js, custom kinematic rider (no rigid-body physics).

```bash
npm install
npm run dev     # http://localhost:5173
npm run sim            # headless scripted rides through the real controller (feel regression check)
npm run ride:dirtline  # a bot rides the whole Dirt Line and must finish with 0 bails
npm run gen:dirtline   # regenerate the Dirt Line layout (gaps are sized by simulation)
npm run gen:parks      # regenerate Skatepark / Street Plaza / Mega Ramp / Vert layouts
npm run sim:vert       # vert/halfpipe physics checks
npm run ride:parks     # bot smoke-rides of every Phase 4 park (exits non-zero on failure)
npm run server         # multiplayer server on :8787 (the dev server proxies /ws to it)
npm run test:server    # protocol test: rooms, state relay, events, a full 1v1
```

## Multiplayer
`server/index.mjs` is a small Node + `ws` server (no build step). Riders on the same park with the
same room code share a room (up to 8; blank code = public room). Each client sends its rider
pose at 15 Hz; the server relays the latest states at 15 Hz and clients draw other riders as
see-through ghosts ~150 ms in the past, interpolated between updates. Tricks, banked lines and
bails show in a feed.

**1v1 "best line in 60 s":** from the Multiplayer screen, challenge the room. The server picks the
opponent, runs a synced 3-2-1 countdown, takes each rider's banked lines during the window
(+5 s grace for a line that's still rolling) and announces the higher best line.

**Running it**
- Local: `npm run server` in one terminal, `npm run dev` in another; open the dev URL in two
  windows → Multiplayer → Join room.
- Production: the game is static (Vercel is fine). The server needs an always-on Node host
  (e.g. Render, Fly.io, Railway; `Dockerfile` included, or just `node server/index.mjs`, `PORT`
  env supported, health check at `/health`). Then either set `VITE_MP_URL=wss://your-host/ws`
  in the Vercel project's environment variables and redeploy, or type the server address in the
  Multiplayer screen.

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
| `src/replay/Replay.ts` | 30 Hz recorder of rig snapshots + player with follow / orbit / fixed-tripod cameras |
| `src/gfx/Graphics.ts` | Low / Medium / High: physical materials (from Lambert + per-material hints), sun shadows following the rider, post (bloom, grade, vignette, MSAA) |
| `src/net/` | multiplayer client: `Net` (socket, roster, clock sync), `Ghosts` (interpolated remote riders), `protocol` (35-number pose packing) |
| `server/index.mjs` | multiplayer server: rooms, state relay, 1v1 duels, validation + rate limits |
| `src/ui/Touch.ts` | on-screen stick + trick buttons (auto on touch devices, or add `?touch=1`) |
| `scripts/sim.ts` | headless ride tests |

## Parks
A park is a JSON file: `spawn`, optional `checkpoints` (you respawn rolling at the last one you passed),
optional `finish` (reaching it banks the line and sends you back to the top), `decor`, and `pieces`
(`ground`, `kicker`, `landing`, `rail`, `ledge`, `quarter`, `corner`, `funbox`, `wedge`, `stairs`, `block`;
rails and ledges take a `drop` for handrails/hubbas). Add it to `src/world/parks/index.ts` to make it selectable.

**Transitions / vert:** riding direction is `normal × heading-right`, so you can ride straight up a wall.
Leaving a surface steeper than ~75° (`air.vertNormalY`) going up is a *vert air*: spins and flips happen in
the wall's frame and you come back down the transition (fakie with no spin, forwards after a 180).

## Scoring
- A line accumulates tricks (airs, grinds, manuals). It **banks** after you roll on the ground for
  `score.linkWindow` s without starting another trick; a **bail loses** the whole line.
- Line multiplier = 1 + 0.5 × (tricks in line − 1). Landing in a manual (hold B) or popping off a
  grind keeps the line going.
- Air multipliers: inverted (any flip) ×1.5, stomp ×1.25. Grabs count after 0.25 s and scale up to ×2 at 1 s.
- Repetition: an element seen in 1/2/3 of your last 3 airs pays 75/55/40 %. Spin direction and fakie
  take-offs are different keys, so switching them resets to full points.
