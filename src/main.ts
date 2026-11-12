import { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { TUNING } from './tuning';
import { Emitter } from './core/events';
import { GameLoop } from './core/loop';
import { Input } from './core/input/Input';
import { World, type ParkDef } from './world/World';
import { decorate } from './world/decor';
import { RiderController } from './rider/RiderController';
import { RiderRig } from './rider/RiderRig';
import type { RiderEvents } from './rider/types';
import { ChaseCam, type CamTarget } from './camera/ChaseCam';
import { Hud } from './ui/Hud';
import { DebugOverlay } from './ui/DebugOverlay';
import { ComboTracker } from './tricks/Combo';
import { Run } from './tricks/Run';
import protoPark from './world/parks/proto.json';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, TUNING.render.maxPixelRatio));

const scene = new Scene();
const camera = new PerspectiveCamera(TUNING.camera.baseFov, 1, 0.1, 600);

const world = new World(protoPark as ParkDef);
scene.add(world.root);
decorate(scene, world, renderer);

const events = new Emitter<RiderEvents>();
const rider = new RiderController(world, events);
const rig = new RiderRig();
scene.add(rig.root, rig.shadow);

const input = new Input(canvas);
const chase = new ChaseCam(camera, world);
const hud = new Hud();
const debug = new DebugOverlay();

const combo = new ComboTracker();
let run = new Run(world.def.name);
let summaryOpen = false;
let slowMo = 0;
let restartHeld = 0;
const camTarget: CamTarget = { pos: rig.root.position, speed: 0, motionYaw: 0, airborne: false, bailed: false };

events.on('landed', (l) => { hud.landed(l); combo.addAir(l.air, l.stomped); });
events.on('pop', (p) => hud.pop(p));
events.on('grindEnd', (g) => combo.addGrind(g.type, g.time));
events.on('manualEnd', (m) => combo.addManual(m.nose, m.time));
events.on('bail', (b) => {
  hud.bail(b.reason);
  slowMo = TUNING.bail.slowMoDuration;
  combo.lose();
  run.bail();
});
events.on('respawn', () => { slowMo = 0; });
combo.events.on('changed', (c) => hud.comboChanged(c));
combo.events.on('banked', (b) => { run.bank(b); hud.banked(b); });
combo.events.on('lost', (l) => { run.lost(l.total); if (l.total > 0) hud.lost(l.total); });

/** End the run: bank a line you're rolling away from, drop one you're mid-trick in. */
function endRun() {
  if (summaryOpen) return;
  if (rider.state === 'GROUNDED' || rider.state === 'MANUALING') combo.bank();
  else combo.entries = [];
  hud.showSummary(run.finish());
  summaryOpen = true;
  loop.paused = true;
}

function newRun() {
  summaryOpen = false;
  hud.hideSummary();
  loop.paused = false;
  hud.setPaused(false);
  combo.reset();
  run = new Run(world.def.name);
  rider.respawn();
  snapCamera();
}

const loop = new GameLoop(
  // once per frame, real time
  (realDt) => {
    input.poll(realDt);
    if (summaryOpen) {
      if (input.justPressed('pop') || input.justPressed('endRun')) newRun();
      return;
    }
    if (input.justPressed('pause')) { loop.paused = !loop.paused; hud.setPaused(loop.paused); }
    if (input.justPressed('endRun')) { endRun(); return; }
    if (input.justPressed('debug')) debug.toggle();
    if (input.justPressed('help')) hud.toggleHelp();
    if (input.held('restart') && !loop.paused) {
      restartHeld += realDt;
      if (restartHeld >= TUNING.input.restartHoldTime) {
        restartHeld = 0;
        newRun();
      }
    } else restartHeld = 0;
    slowMo = Math.max(0, slowMo - realDt);
    loop.timeScale = slowMo > 0 ? TUNING.bail.slowMoScale : 1;
  },
  // fixed sim step
  (dt) => {
    const wasBailed = rider.state === 'BAILED';
    rider.step(dt, input.state);
    combo.update(dt, rider.state);
    if (wasBailed && rider.state !== 'BAILED') snapCamera();
    run.timeLeft -= dt;
    // time's up: finish once you're not mid-trick (a line in progress gets to resolve)
    if (run.timeLeft <= 0 && (rider.state === 'GROUNDED' || rider.state === 'BAILED') && !combo.active) endRun();
    else if (run.timeLeft <= -6) endRun();
  },
  // render
  (alpha, realDt) => {
    rig.sync(rider, alpha);
    updateShadow();
    camTarget.pos = rider.state === 'BAILED' ? rig.riderBody.position : rig.root.position;
    camTarget.speed = rider.state === 'GROUNDED' ? rider.speed : rider.vel.length();
    camTarget.motionYaw = rider.motionYaw();
    camTarget.airborne = rider.state === 'AIRBORNE';
    camTarget.bailed = rider.state === 'BAILED';
    chase.update(loop.paused ? 0 : realDt, camTarget, input.look);
    hud.frame({
      compression: rider.compression,
      restartT: restartHeld / TUNING.input.restartHoldTime,
      speed: camTarget.speed,
      padConnected: input.padConnected,
      live: liveTrick(),
      bankProgress: combo.active && rider.state === 'GROUNDED' ? combo.bankProgress : 0,
      balance: rider.state === 'GRINDING' || rider.state === 'MANUALING' ? rider.balance : null,
      balanceLabel: rider.state === 'GRINDING' ? 'BALANCE · A / D' : 'BALANCE · W / S',
      score: run.score,
      timeLeft: run.timeLeft,
      personalBest: run.personalBest,
    });
    debug.update(realDt, rider);
    renderer.render(scene, camera);
  },
);

function liveTrick(): string {
  switch (rider.state) {
    case 'AIRBORNE': return rider.airTime > 0.15 ? rider.describeAir() : '';
    case 'GRINDING': return `${rider.grindType} ${rider.grindTime.toFixed(1)}s`;
    case 'MANUALING': return `${rider.manualNose ? 'NOSE MANUAL' : 'MANUAL'} ${rider.manualTime.toFixed(1)}s`;
    default: return '';
  }
}

function snapCamera() {
  rig.sync(rider, 1);
  camTarget.pos = rig.root.position;
  camTarget.speed = 0;
  camTarget.motionYaw = rider.motionYaw();
  camTarget.airborne = camTarget.bailed = false;
  chase.snap(camTarget);
}

function updateShadow() {
  const src = rider.state === 'BAILED' ? rig.bikeBody.position : rig.root.position;
  const g = world.groundBelow(src);
  rig.shadow.visible = !!g;
  if (!g) return;
  const h = Math.max(0, src.y - g.point.y);
  rig.shadow.position.copy(g.point).addScaledVector(g.normal, 0.02);
  rig.shadow.quaternion.setFromUnitVectors(rig.shadow.up, g.normal);
  rig.shadow.rotateY(rider.visualYaw());
  const s = 1 + h * 0.15;
  rig.shadow.scale.set(0.55 * s, 1, 1.15 * s);
  (rig.shadow.material as { opacity: number }).opacity = Math.max(0.08, 0.34 - h * 0.05);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();
snapCamera();
loop.start();

// handy in the console while tuning: window.sendit.rider, .tuning …
(window as unknown as { sendit: unknown }).sendit = { rider, world, tuning: TUNING, loop, combo, chase, get run() { return run; } };
