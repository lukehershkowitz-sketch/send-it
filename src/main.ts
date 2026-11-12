import { PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { TUNING } from './tuning';
import { Emitter } from './core/events';
import { GameLoop } from './core/loop';
import { Input } from './core/input/Input';
import { saveBindings } from './core/input/bindings';
import { applyTuningSettings, loadSettings, saveSettings, type Settings } from './core/settings';
import { World } from './world/World';
import { decorate, type Decor, type Lighting } from './world/decor';
import { parkById } from './world/parks';
import { textures } from './world/textures';
import { RiderController } from './rider/RiderController';
import { RiderRig } from './rider/RiderRig';
import type { RiderEvents } from './rider/types';
import { ChaseCam, type CamTarget } from './camera/ChaseCam';
import { Hud } from './ui/Hud';
import { DebugOverlay } from './ui/DebugOverlay';
import { Menu } from './ui/Menu';
import { ComboTracker } from './tricks/Combo';
import { Run } from './tricks/Run';
import { Particles } from './fx/Particles';
import { Sfx } from './audio/Sfx';

// --------------------------------------------------------------------------- setup
const settings = loadSettings();
applyTuningSettings(settings);

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
const scene = new Scene();
const camera = new PerspectiveCamera(TUNING.camera.baseFov, 1, 0.1, 600);

let park = parkById(settings.park);
let lighting: Lighting = settings.lighting;
let world = new World(park.def);
scene.add(world.root);
let decor: Decor = decorate(scene, world, renderer, lighting);

const events = new Emitter<RiderEvents>();
const rider = new RiderController(world, events);
const rig = new RiderRig();
scene.add(rig.root, rig.shadow);
const particles = new Particles(textures.radial());
particles.setNight(lighting === 'night');
scene.add(particles.points);
const sfx = new Sfx();
sfx.volume = settings.volume;
sfx.muted = settings.muted;

const input = new Input(canvas);
const chase = new ChaseCam(camera, world);
const hud = new Hud();
const debug = new DebugOverlay();
if (debug.visible !== settings.showDebug) debug.toggle();

const combo = new ComboTracker();
let run = new Run(world.def.name);
let summaryOpen = false;
let slowMo = 0;
let restartHeld = 0;
let pendingFinish = false;
const camTarget: CamTarget = { pos: rig.root.position, speed: 0, motionYaw: 0, airborne: false, bailed: false };
const vignette = document.getElementById('vignette')!;

// unlock audio on the first gesture (capture phase, before the menu can swallow the event)
for (const ev of ['keydown', 'pointerdown', 'touchstart'] as const) window.addEventListener(ev, () => sfx.unlock(), true);

// --------------------------------------------------------------------------- menus
const menu = new Menu(document.getElementById('menu')!, settings, input.bindings, {
  ride: (id, light) => { loadPark(id, light); closeMenu(); newRun(); },
  resume: () => closeMenu(),
  restart: () => { closeMenu(); newRun(); },
  mainMenu: () => { endRunSilently(); menu.show('main'); },
  settingsChanged: (s) => applySettings(s),
  bindingsChanged: (b) => { input.bindings = b; saveBindings(b); },
  sound: () => { sfx.unlock(); sfx.ui(); },
});

function openPause() { loop.paused = true; menu.syncPad(); menu.show('pause'); }
function closeMenu() { menu.hide(); loop.paused = summaryOpen; input.flush(); }

function applySettings(s: Settings) {
  saveSettings(s);
  applyTuningSettings(s);
  sfx.setVolume(s.volume);
  sfx.setMuted(s.muted);
  if (debug.visible !== s.showDebug) debug.toggle();
  resize();
}

// --------------------------------------------------------------------------- park switching
function loadPark(id: string, light: Lighting) {
  if (id === park.id && light === lighting) return;
  park = parkById(id);
  lighting = light;
  decor.dispose();
  scene.remove(world.root);
  world.root.traverse((o) => { const m = o as { geometry?: { dispose(): void } }; m.geometry?.dispose(); });
  world = new World(park.def);
  scene.add(world.root);
  decor = decorate(scene, world, renderer, lighting);
  rider.setWorld(world);
  chase.world = world;
  particles.setNight(lighting === 'night');
}

// --------------------------------------------------------------------------- events
events.on('landed', (l) => {
  hud.landed(l);
  combo.addAir(l.air, l.stomped);
  sfx.land(l.impact, l.stomped);
  particles.dust(rider.pos, Math.min(1.5, l.impact / 9));
});
events.on('pop', (p) => { hud.pop(p); sfx.pop(p.factor); particles.dust(rider.pos, 0.15); });
events.on('grindStart', () => sfx.grindStart());
events.on('grindEnd', (g) => combo.addGrind(g.type, g.time));
events.on('manualEnd', (m) => combo.addManual(m.nose, m.time));
events.on('bail', (b) => {
  hud.bail(b.reason);
  slowMo = TUNING.bail.slowMoDuration;
  combo.lose();
  run.bail();
  sfx.crash();
  particles.dust(rider.pos, 1.4);
  pendingFinish = false;
});
events.on('respawn', () => { slowMo = 0; });
events.on('finish', () => { pendingFinish = true; });
combo.events.on('changed', (c) => hud.comboChanged(c));
combo.events.on('banked', (b) => { run.bank(b); hud.banked(b); sfx.bank(b.total); });
combo.events.on('lost', (l) => { run.lost(l.total); if (l.total > 0) { hud.lost(l.total); sfx.lost(); } });

/** End the run: bank a line you're rolling away from, drop one you're mid-trick in. */
function endRun() {
  if (summaryOpen) return;
  if (rider.state === 'GROUNDED' || rider.state === 'MANUALING') combo.bank();
  else combo.entries = [];
  hud.showSummary(run.finish());
  summaryOpen = true;
  loop.paused = true;
}
function endRunSilently() { summaryOpen = false; hud.hideSummary(); combo.reset(); }

function newRun() {
  summaryOpen = false;
  hud.hideSummary();
  loop.paused = false;
  combo.reset();
  run = new Run(world.def.name);
  pendingFinish = false;
  rider.respawnAtStart();
  snapCamera();
}


// --------------------------------------------------------------------------- loop
const _back = new Vector3(), _peg = new Vector3();
const loop = new GameLoop(
  // once per frame, real time
  (realDt) => {
    input.poll(realDt);
    if (menu.open) { menu.update(); return; }
    if (input.values.pop > 0.5 || input.padConnected) sfx.unlock();
    if (summaryOpen) {
      if (input.justPressed('pop') || input.justPressed('endRun')) newRun();
      else if (input.justPressed('pause')) { endRunSilently(); menu.syncPad(); menu.show('main'); }
      return;
    }
    if (input.justPressed('pause')) { openPause(); return; }
    if (input.justPressed('endRun')) { endRun(); return; }
    if (input.justPressed('debug')) { debug.toggle(); settings.showDebug = debug.visible; saveSettings(settings); }
    if (input.justPressed('help')) hud.toggleHelp();
    if (input.held('restart')) {
      restartHeld += realDt;
      if (restartHeld >= TUNING.input.restartHoldTime) { restartHeld = 0; newRun(); }
    } else restartHeld = 0;
    // bail slow-mo: hold, then ease back to full speed
    slowMo = Math.max(0, slowMo - realDt);
    const k = slowMo / TUNING.bail.slowMoDuration; // 1 → 0
    const S = TUNING.bail.slowMoScale;
    loop.timeScale = k > 0.4 ? S : S + (1 - S) * (1 - k / 0.4) ** 2;
    vignette.classList.toggle('on', slowMo > 0 || rider.state === 'BAILED');
  },
  // fixed sim step
  (dt) => {
    const wasBailed = rider.state === 'BAILED';
    rider.step(dt, input.state);
    combo.update(dt, rider.state);
    if (wasBailed && rider.state !== 'BAILED') snapCamera();
    // finished the line: once the line has banked, roll back to the start
    if (pendingFinish && !combo.active && rider.state === 'GROUNDED') {
      pendingFinish = false;
      hud.flash('LINE COMPLETE', 'back to the top');
      rider.respawnAtStart();
      snapCamera();
    }
    run.timeLeft -= dt;
    // time's up: finish once you're not mid-trick (a line in progress gets to resolve)
    if (run.timeLeft <= 0 && (rider.state === 'GROUNDED' || rider.state === 'BAILED') && !combo.active) endRun();
    else if (run.timeLeft <= -6) endRun();
  },
  // render
  (alpha, realDt) => {
    const simDt = loop.paused ? 0 : realDt * loop.timeScale;
    rig.sync(rider, alpha);
    updateShadow();
    camTarget.pos = rider.state === 'BAILED' ? rig.riderBody.position : rig.root.position;
    camTarget.speed = rider.state === 'GROUNDED' ? rider.speed : rider.vel.length();
    camTarget.motionYaw = rider.motionYaw();
    camTarget.airborne = rider.state === 'AIRBORNE';
    camTarget.bailed = rider.state === 'BAILED';
    chase.update(loop.paused ? 0 : realDt, camTarget, input.look);
    decor.update(rig.root.position);
    effects(simDt);
    particles.update(simDt);
    sfx.update(realDt, rider, loop.paused || menu.open);
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

/** Continuous particle effects: skid dust, grind sparks. */
function effects(dt: number) {
  if (dt <= 0) return;
  const st = rider.state;
  if (st === 'GROUNDED' || st === 'MANUALING') {
    const slip = Math.abs(Math.sin(rider.heading - rider.travelYaw));
    const skid = rider.speed > 3 ? Math.max(rider.input.brake, slip * 3) : 0;
    if (skid > 0.2) {
      _back.set(-Math.sin(rider.travelYaw), 0, -Math.cos(rider.travelYaw));
      _peg.copy(rider.pos).addScaledVector(_back, 0.45);
      particles.trail(_peg, _back, skid * Math.min(1, rider.speed / 10), dt);
    }
  } else if (st === 'GRINDING') {
    _peg.copy(rider.vel).normalize();
    particles.sparks(rider.pos.clone().add(new Vector3(0, 0.3, 0)), _peg);
  }
}

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
  renderer.setPixelRatio(Math.min(devicePixelRatio, TUNING.render.maxPixelRatio) * settings.renderScale);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  particles.setViewportHeight(h);
}
window.addEventListener('resize', resize);
resize();
snapCamera();
loop.paused = true;
menu.show('main');
loop.start();

// handy in the console while tuning: window.sendit.rider, .tuning …
(window as unknown as { sendit: unknown }).sendit = {
  rider, tuning: TUNING, loop, combo, chase, menu, sfx,
  get world() { return world; }, get run() { return run; }, loadPark, newRun, closeMenu,
};
