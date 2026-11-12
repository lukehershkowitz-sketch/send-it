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
| `src/rider/models.ts` + `blender/build_rider.py` | Blender-built rider/bike (`public/models/rider.glb`), loaded once and shared by your rig and every ghost |
| `src/gfx/Graphics.ts` | Low / Medium / High: physical materials (from Lambert + per-material hints), sun shadows following the rider, post (bloom, grade, vignette, MSAA) |
| `src/net/` | multiplayer client: `Net` (socket, roster, clock sync), `Ghosts` (interpolated remote riders), `protocol` (35-number pose packing) |
| `server/index.mjs` | multiplayer server: rooms, state relay, 1v1 duels, validation + rate limits |
| `src/ui/Touch.ts` | on-screen stick + trick buttons (auto on touch devices, or add `?touch=1`) |
| `scripts/sim.ts` | headless ride tests |

## Jumping & aerial physics
Jumps are a physics simulation, not canned animations. The pieces (all numbers in `src/tuning.ts`):

**Takeoff** (`states/Grounded.ts`)
- Hold **Space** to preload (suspension + rider compress). Release and the rider *extends* over `pop.extendTime`
  (~0.13 s) while still on the ramp; nothing is added to your velocity instantly. Let go too early and the ramp
  ahead rises above you; too late and the lip cuts the push short. The push stays coiled for up to `coilSlack`
  metres so the timing window is fair. Labels (PERFECT / EARLY / LATE) come from how much of the push was delivered.
- Preload quality: depth of compression, minus energy lost if you sit on it (`fatigueHold`). A tap pushes less.
- The ramp provides the height: you keep the tangent velocity of whatever surface you leave, plus the rotation it
  was giving the bike (speed × curvature). Different ramps give different trajectories. Curved ramps load the
  suspension (g-load); the bike's pitch follows both wheels.
- While loaded, W/S/A/D shift your weight and change the rotation you leave with. A flat-ground pop is a bunny hop
  (front wheel lifts first, then the rear).

**Rotation** (`rider/aero.ts`): the bike has a real orientation quaternion and angular velocity. Inputs are
*torques* (pitch, yaw, roll), so rotations build up, carry on when released, and need counter-input to stop.
Euler's equations couple the axes; tucking (F) or bracing (Space in the air) changes the moment of inertia and
angular momentum is conserved. A light stabiliser (`air.autoLevel`, Settings → landing assist) follows the flight
path and nudges toward the landing in the last half second. It only acts on pitch and roll, never on spin, and
never drags a half-finished flip back.

| Keys | Result |
|---|---|
| A/D | flat spin (stays level however the nose is pitched) |
| W / S | frontflip / backflip |
| Shift + A/D | roll sideways |
| T | tabletop (physics-driven roll to ~78°) |
| ↑ | flair (backflip with a little spin) |
| ↑ + A/D | **cork**: spin about an axis tilted sideways |
| ↑ + A/D + S | **rodeo**: axis tipped back |
| ↑ + A/D + W | **misty**: axis tipped forward |

Trick names come from how the bike actually rotated (`classifyRotation`), so a cork is whatever rotated like one.
Flips are counted against the bike's natural attitude change (a kicker launches nose-up and the landing wants
nose-down, so a clean backflip is ~300° of raw rotation but counts as 360°).

**Landing** (`states/Airborne.ts`): wheels and the rider's head/bars are swept through each step (no tunnelling at
high spin rates). The check covers pitch, roll and yaw against the landing surface; the leftover misalignment becomes
a spring *wobble* that settles out instead of snapping. Crooked and front-wheel-first landings scrub speed, the rider
body takes the impact, and the camera dips.

**Rider body** (`rider/RiderBody.ts`): spring-damper masses for crouch/lean/fore-aft, driven by preload, extension,
rotation rates (curl in flips, lean in spins), the predicted landing (reaching for the ground) and impacts.

Tests: `npm run test:aero` (rotation model in isolation), `npm run sim:air` (31 behaviour checks: height vs speed /
ramp / preload, bunny hop vs big air, momentum, off-axis naming, tunnelling, determinism), `npm run test:all`.

## Rider & bike models (Blender)
`public/models/rider.glb` is generated by a Blender script, no Blender UI needed:

```bash
python3.11 -m venv .blenv && .blenv/bin/pip install bpy
.blenv/bin/python blender/build_rider.py
```

The script authors everything in game coordinates and names objects `<part>__<material>`
(e.g. `frame__chrome`, `thigh__pants`), where `<material>` is a key of `RiderRig.mats`, so the
game recolours and re-shades them like any other part. Parts: `frame` / `front` / `wheel`
(bike space, pivoting for whips/barspins), unit-space `thigh`, `shin`, `upper`, `fore`, `torso`,
`pelvis`, `shoe` (stretched by the IK every frame), and `helmet` / `glove` in metres. If the file
is missing the rig keeps its built-in procedural parts. You can also open the exported `.glb`
in Blender, edit it, and re-export with the same object names.

### Scenery kit
`public/models/scenery.glb` comes from `blender/build_scenery.py` (same venv): pines, oak, birch,
bushes, grass, stumps, rocks, three buildings, bench, bin, railing and a street lamp, each named
`<kind>__<material>` with its base at the origin. `src/world/decor.ts` instances them (one draw
call per kind × material) with per-instance tints for leaves, walls, rocks and grass. Graphics:
Low keeps the simple built-in cones/boxes.

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
