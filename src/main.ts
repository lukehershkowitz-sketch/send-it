import { PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { TUNING } from './tuning';
import { Emitter } from './core/events';
import { GameLoop } from './core/loop';
import { Input } from './core/input/Input';
import { emptyInput } from './core/input/actions';
import { saveBindings } from './core/input/bindings';
import { applyTuningSettings, loadSettings, saveSettings, type Settings } from './core/settings';
import { World } from './world/World';
import { decorate, type Decor, type Lighting } from './world/decor';
import { parkById } from './world/parks';
import { textures } from './world/textures';
import { RiderController } from './rider/RiderController';
import { RiderRig, makeSnapshot, snapshot } from './rider/RiderRig';
import { loadRigModels, loadSceneryKit, type ModelKit } from './rider/models';
import { Recorder, ReplayPlayer } from './replay/Replay';
import { TouchControls, isTouchDevice } from './ui/Touch';
import type { RunSummary } from './tricks/Run';
import { Net, defaultServerUrl } from './net/Net';
import { Ghosts } from './net/Ghosts';
import { encodeSnapshot } from './net/protocol';
import type { RiderEvents } from './rider/types';
import { ChaseCam, type CamTarget } from './camera/ChaseCam';
import { Hud } from './ui/Hud';
import { DebugOverlay } from './ui/DebugOverlay';
import { Menu } from './ui/Menu';
import { ComboTracker } from './tricks/Combo';
import { Run } from './tricks/Run';
import { Particles } from './fx/Particles';
import { Graphics, defaultQuality, type Quality } from './gfx/Graphics';
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
const graphics = new Graphics(renderer, scene, camera);
const qualityFor = (s: Settings): Quality => (s.graphics === 'auto' ? defaultQuality(isTouchDevice()) : s.graphics);

const events = new Emitter<RiderEvents>();
const rider = new RiderController(world, events);
const rig = new RiderRig();
rig.setColors(settings.colors);
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
let run = new Run(world.def.name, world.def.runSeconds);
let summaryOpen = false;
let slowMo = 0;
let restartHeld = 0;
let pendingFinish = false;
const camTarget: CamTarget = { pos: rig.root.position, speed: 0, motionYaw: 0, airborne: false, bailed: false };
const vignette = document.getElementById('vignette')!;
const replayBar = document.getElementById('replay-bar')!;
const recorder = new Recorder();
const recSnap = makeSnapshot();
const replay = new ReplayPlayer(camera, chase);
let replayFrom: 'pause' | 'summary' = 'pause';
let lastSummary: RunSummary | null = null;
const touch = isTouchDevice() ? new TouchControls(document.body) : null;
graphics.setSun(decor.sun, lighting === 'night');
graphics.setQuality(qualityFor(settings));
applyHemi();
// Blender scenery kit: used on Medium/High; Low keeps the simple built-in shapes
let sceneryKit: ModelKit | null = null;
const kitForQuality = () => (graphics.quality === 'low' ? null : sceneryKit);
let decorHasKit = false;
function rebuildDecor() {
  decor.dispose();
  const kit = kitForQuality();
  decor = decorate(scene, world, renderer, lighting, kit);
  decorHasKit = !!kit;
  graphics.setSun(decor.sun, lighting === 'night');
  graphics.refresh(scene);
  applyHemi();
}
void loadSceneryKit().then((kit) => { sceneryKit = kit; if (kit && kitForQuality() && !decorHasKit) rebuildDecor(); });

// Blender-built rider + bike (falls back to the built-in parts if the file can't load)
void loadRigModels().then((parts) => {
  if (!parts) return;
  rig.useModels(parts);
  ghosts.useModels(parts);
  graphics.refresh(scene);
});
const net = new Net();
const ghosts = new Ghosts(scene);
const sendSnap = makeSnapshot();
let sendAcc = 0;
let inviteFrom: string | null = null;
/** Active 1v1 in our room (we may be a player or a spectator). */
let duel: { a: number; b: number; startAt: number; endAt: number; scores: Record<number, number>; me: boolean; started: boolean } | null = null;
if (touch) { input.touch = touch.values; document.body.classList.add('touch'); }

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
  replay: () => startReplay('pause'),
  colorsChanged: () => { rig.setColors(settings.colors); graphics.refresh(rig.root); if (net.online) net.hello(playerName(), settings.colors); },
  mpJoin: () => void mpJoin(),
  mpLeave: () => { net.leave(); net.disconnect(); ghosts.clear(); duel = null; menu.refresh(); hud.duelBanner(null); hud.roster(null); },
  mpChallenge: () => { net.duelRequest(); },
  duelReply: (accept) => { net.duelReply(accept); inviteFrom = null; if (!accept) closeMenu(); else menu.show('pause'); },
});

// --------------------------------------------------------------------------- multiplayer
const playerName = () => settings.playerName.trim() || 'Rider';
const nameOf = (id: number) => (id === net.id ? 'You' : net.players.get(id)?.name ?? 'Rider');
const fmtPts = (n: number) => Math.round(n).toLocaleString('en-US');

async function mpJoin() {
  try {
    if (!net.online) await net.connect(defaultServerUrl(settings.mpServer));
  } catch { menu.refresh(); return; }
  net.hello(playerName(), settings.colors);
  net.join(park.id, settings.mpCode);
}

menu.mpView = () => ({
  status: net.status === 'online' ? (net.room ? `Connected · ${net.players.size + 1} rider${net.players.size ? 's' : ''}` : 'Connected') : net.status === 'connecting' ? 'Connecting…' : 'Not connected',
  error: net.error,
  room: net.room ? `${park.name} / ${net.room.code}` : null,
  players: [
    { id: net.id, name: `${playerName()}`, color: settings.colors.jersey, you: true, score: duel && (duel.a === net.id || duel.b === net.id) ? duel.scores[net.id] ?? 0 : undefined },
    ...[...net.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.colors.jersey, you: false, score: duel && (duel.a === p.id || duel.b === p.id) ? duel.scores[p.id] ?? 0 : undefined })),
  ],
  duel: duel ? `1v1 live: ${nameOf(duel.a)} vs ${nameOf(duel.b)}` : null,
  invite: inviteFrom,
});

function updateRoster() {
  if (!net.room) { hud.roster(null); return; }
  const rows = [`<b>${park.name}</b> · ${net.room.code}`, `<span style="color:${settings.colors.jersey}">●</span> ${playerName()} (you)`,
    ...[...net.players.values()].map((p) => `<span style="color:${p.colors.jersey}">●</span> ${p.name}`)];
  hud.roster(rows);
}

net.events.on('status', () => { menu.refresh(); updateRoster(); });
net.events.on('message', (m) => {
  switch (m.type) {
    case 'welcome':
      ghosts.clear();
      ghosts.sync(net.players);
      graphics.refresh(scene);
      hud.feed(`Joined ${park.name} · room ${m.code}${m.players.length ? ` · ${m.players.length} other rider${m.players.length > 1 ? 's' : ''}` : ''}`, 'sys');
      duel = m.duel ? { ...m.duel, me: false, started: true } : null;
      break;
    case 'join':
      ghosts.sync(net.players);
      graphics.refresh(scene);
      hud.feed(`${m.player.name} joined`, 'sys');
      break;
    case 'leave':
      ghosts.sync(net.players);
      hud.feed('A rider left', 'sys');
      break;
    case 'states':
      for (const [id, st] of m.p) if (id !== net.id) ghosts.push(id, m.t, st);
      return; // hot path: skip the menu refresh
    case 'event':
      hud.feed(`${nameOf(m.id)}: ${m.text}${m.points ? ` +${fmtPts(m.points)}` : ''}`, m.kind);
      return;
    case 'duel_invite':
      inviteFrom = m.name;
      if (!menu.open) { loop.paused = true; menu.syncPad(); }
      menu.show('invite');
      break;
    case 'duel_pending':
      hud.feed(`Challenge sent. Waiting for ${m.name}…`, 'sys');
      break;
    case 'duel_cancel':
      hud.feed(`1v1 off: ${m.reason}`, 'sys');
      inviteFrom = null;
      if (menu.open && menu.screen === 'invite') closeMenu();
      break;
    case 'duel_start': {
      const me = m.a === net.id || m.b === net.id;
      duel = { a: m.a, b: m.b, startAt: m.startAt, endAt: m.endAt, scores: { ...m.scores }, me, started: false };
      if (me) {
        // get everyone to the start line, frozen until the server's start time
        if (replay.active) { replay.stop(); document.body.classList.remove('replaying'); }
        menu.hide();
        hud.hideSummary();
        summaryOpen = false;
        combo.reset();
        rider.respawnAtStart();
        recorder.clear();
        snapCamera();
        loop.paused = true;
      } else hud.feed(`1v1 started: ${nameOf(m.a)} vs ${nameOf(m.b)}`, 'sys');
      break;
    }
    case 'duel_score':
      if (duel) duel.scores[m.id] = m.best;
      break;
    case 'duel_end': {
      const wasMe = m.a === net.id || m.b === net.id;
      const result = { you: net.id, a: { name: nameOf(m.a), id: m.a, best: m.scores[m.a] ?? 0 }, b: { name: nameOf(m.b), id: m.b, best: m.scores[m.b] ?? 0 }, winner: m.winner, reason: m.reason };
      duel = null;
      hud.duelBanner(null);
      if (wasMe) {
        if (!summaryOpen) { combo.bank(); summaryOpen = true; loop.paused = true; }
        hud.showDuelResult(result);
        sfx.bank(m.winner === net.id ? 6000 : 500);
      } else hud.feed(`1v1: ${m.winner === null ? 'draw' : `${nameOf(m.winner)} wins`} (${fmtPts(result.a.best)} – ${fmtPts(result.b.best)})`, 'sys');
      break;
    }
    case 'error':
      hud.feed(m.message, 'bail');
      break;
  }
  menu.refresh();
  updateRoster();
});

/** Per frame: send our state, run the duel clock. */
function netFrame(realDt: number) {
  if (net.room) {
    sendAcc += realDt;
    if (sendAcc >= 1 / 15) { sendAcc = 0; net.sendState(encodeSnapshot(snapshot(rider, 1, sendSnap))); }
  }
  if (!duel) return;
  const now = net.serverNow();
  if (duel.me && !duel.started) {
    if (now >= duel.startAt) {
      duel.started = true;
      newRun((duel.endAt - duel.startAt) / 1000);
      hud.flash('SEND IT!', 'best single line wins');
    }
  }
  const other = duel.me ? (duel.a === net.id ? duel.b : duel.a) : null;
  const left = Math.max(0, (now < duel.startAt ? duel.endAt - duel.startAt : duel.endAt - now) / 1000);
  const count = now < duel.startAt ? Math.ceil((duel.startAt - now) / 1000) : 0;
  const line = duel.me
    ? `You <b>${fmtPts(duel.scores[net.id] ?? 0)}</b> · ${nameOf(other!)} <b>${fmtPts(duel.scores[other!] ?? 0)}</b>`
    : `${nameOf(duel.a)} <b>${fmtPts(duel.scores[duel.a] ?? 0)}</b> · ${nameOf(duel.b)} <b>${fmtPts(duel.scores[duel.b] ?? 0)}</b>`;
  hud.duelBanner(`1v1 · BEST LINE · ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}<br>${line}${now > duel.endAt ? '<br><small>time! finishing lines…</small>' : ''}`, count);
}

// summary buttons (touch)
document.getElementById('summary')!.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).dataset.sum;
  if (act === 'again') newRun();
  else if (act === 'replay') startReplay('summary');
  else if (act === 'menu') { endRunSilently(); menu.show('main'); }
});

// --------------------------------------------------------------------------- replays
function startReplay(from: 'pause' | 'summary') {
  if (recorder.frames.length < 30) { hud.flash('NO REPLAY YET', 'ride a bit first'); return; }
  replayFrom = from;
  menu.hide();
  hud.hideSummary();
  loop.paused = true;
  replay.start(recorder, world);
  document.body.classList.add('replaying');
}

function exitReplay() {
  replay.stop();
  document.body.classList.remove('replaying');
  input.flush();
  if (replayFrom === 'summary' && lastSummary) hud.showSummary(lastSummary);
  else openPause();
  snapCamera();
}

function replayControls(realDt: number) {
  if (input.justPressed('camera')) replay.cycleCamera();
  if (input.justPressed('pop')) replay.playing = !replay.playing;
  if (input.justPressed('brake')) replay.speed = replay.speed === 1 ? 0.35 : 1;
  const scrub = input.values.steerRight - input.values.steerLeft;
  if (Math.abs(scrub) > 0.1) replay.seek(scrub * realDt * 4);
  if (input.justPressed('pause') || input.justPressed('endRun') || input.justPressed('restart')) exitReplay();
}

function openPause() { loop.paused = true; menu.syncPad(); menu.show('pause'); }
function closeMenu() { menu.hide(); loop.paused = summaryOpen; input.flush(); }

/** Physical materials also get light from the sky environment, so the hemisphere fill is lowered. */
function applyHemi() {
  decor.hemi.intensity = (decor.hemi.userData.base as number) * (graphics.preset.pbr ? 0.45 : 1);
}

function applySettings(s: Settings) {
  saveSettings(s);
  if (qualityFor(s) !== graphics.quality) {
    graphics.setQuality(qualityFor(s));
    applyHemi();
    if (!!kitForQuality() !== decorHasKit) rebuildDecor(); // Low ↔ Medium/High swaps the scenery set
  }
  applyTuningSettings(s);
  sfx.setVolume(s.volume);
  sfx.setMuted(s.muted);
  if (debug.visible !== s.showDebug) debug.toggle();
  resize();
}

// --------------------------------------------------------------------------- park switching
function loadPark(id: string, light: Lighting) {
  if (id === park.id && light === lighting) return;
  if (duel?.me) return; // finish the 1v1 first
  park = parkById(id);
  lighting = light;
  decor.dispose();
  scene.remove(world.root);
  world.root.traverse((o) => { const m = o as { geometry?: { dispose(): void } }; m.geometry?.dispose(); });
  world = new World(park.def);
  scene.add(world.root);
  decor = decorate(scene, world, renderer, lighting, kitForQuality());
  decorHasKit = !!kitForQuality();
  graphics.setSun(decor.sun, lighting === 'night');
  graphics.refresh(scene);
  applyHemi();
  rider.setWorld(world);
  chase.world = world;
  particles.setNight(lighting === 'night');
  recorder.clear();
  if (net.room) { ghosts.clear(); net.join(park.id, settings.mpCode); }
}

// --------------------------------------------------------------------------- events
events.on('landed', (l) => {
  hud.landed(l);
  if (l.air.airTime > 0.35) recorder.event(l.stomped ? 'STOMPED' : 'CLEAN', l.trick, l.stomped ? 'stomp' : 'clean');
  if (l.air.airTime > 0.5 && !/^(FAKIE )?(AIR|HOP)$/.test(l.trick)) net.sendEvent('trick', l.trick);
  combo.addAir(l.air, l.stomped);
  sfx.land(l.impact, l.stomped);
  chase.kick(l.impact * (l.stomped ? 0.6 : 1) * (l.air.airTime > 0.35 ? 1 : 0.4));
  particles.dust(rider.pos, Math.min(1.5, l.impact / 9));
});
events.on('pop', (p) => { hud.pop(p); sfx.pop(p.factor); particles.dust(rider.pos, 0.15); });
events.on('grindStart', () => sfx.grindStart());
events.on('grindEnd', (g) => combo.addGrind(g.type, g.time));
events.on('manualEnd', (m) => combo.addManual(m.nose, m.time));
events.on('bail', (b) => {
  hud.bail(b.reason);
  recorder.event('BAIL', b.reason, 'bail');
  net.sendEvent('bail', `bailed: ${b.reason}`);
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
combo.events.on('banked', (b) => {
  run.bank(b); hud.banked(b); sfx.bank(b.total);
  recorder.event(`+${b.total.toLocaleString('en-US')}`, 'LINE BANKED', 'clean');
  net.sendEvent('bank', `${b.entries.length}-trick line`, b.total);
  if (duel?.me && duel.started) net.duelLine(b.total);
});
combo.events.on('lost', (l) => { run.lost(l.total); if (l.total > 0) { hud.lost(l.total); sfx.lost(); } });

/** End the run: bank a line you're rolling away from, drop one you're mid-trick in. */
function endRun() {
  if (summaryOpen) return;
  if (rider.state === 'GROUNDED' || rider.state === 'MANUALING') combo.bank();
  else combo.entries = [];
  lastSummary = run.finish();
  hud.showSummary(lastSummary);
  summaryOpen = true;
  loop.paused = true;
}
function endRunSilently() { summaryOpen = false; hud.hideSummary(); combo.reset(); }

function newRun(duration?: number) {
  summaryOpen = false;
  hud.hideSummary();
  loop.paused = false;
  combo.reset();
  run = new Run(world.def.name, duration ?? world.def.runSeconds);
  pendingFinish = false;
  rider.respawnAtStart();
  recorder.clear();
  snapCamera();
}


// --------------------------------------------------------------------------- loop
const _back = new Vector3(), _peg = new Vector3();
const loop = new GameLoop(
  // once per frame, real time
  (realDt) => {
    input.poll(realDt);
    netFrame(realDt);
    touch?.setVisible(!menu.open);
    if (replay.active) { replayControls(realDt); return; }
    if (menu.open) { menu.update(); return; }
    if (input.values.pop > 0.5 || input.padConnected) sfx.unlock();
    if (summaryOpen) {
      if (input.justPressed('camera')) startReplay('summary');
      else if (duel?.me) { /* waiting for the 1v1 result */ }
      else if (input.justPressed('pop') || input.justPressed('endRun')) newRun();
      else if (input.justPressed('pause')) { endRunSilently(); menu.syncPad(); menu.show('main'); }
      return;
    }
    if (input.justPressed('pause')) { openPause(); return; }
    if (input.justPressed('endRun')) { endRun(); return; }
    if (input.justPressed('debug')) { debug.toggle(); settings.showDebug = debug.visible; saveSettings(settings); }
    if (input.justPressed('help')) hud.toggleHelp();
    if (input.held('restart') && !duel?.me) {
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
    recorder.step(dt, snapshot(rider, 1, recSnap));
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
    if (replay.active) {
      const { snap, fired } = replay.update(realDt);
      rig.apply(snap);
      updateShadow();
      for (const e of fired) hud.message(e.title, e.sub, e.cls);
      const t = (x: number) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
      replayBar.innerHTML = `<b>REPLAY</b> · ${replay.mode.toUpperCase()} CAM <kbd>C</kbd> · ${t(replay.time)} / ${t(replay.duration)}${replay.playing ? '' : ' · PAUSED'}${replay.speed < 1 ? ' · SLOW-MO' : ''}
        <span class="ctl"><kbd>Space</kbd> play/pause · <kbd>A</kbd><kbd>D</kbd> scrub · <kbd>S</kbd> slow-mo · <kbd>Esc</kbd> exit</span>
        <div class="prog"><div style="width:${(replay.time / Math.max(0.01, replay.duration)) * 100}%"></div></div>`;
      decor.update(rig.root.position);
      sfx.update(realDt, rider, true);
      graphics.follow(rig.riderBody.parent === rig.root ? rig.root.position : rig.riderBody.position);
      graphics.render();
      return;
    }
    const simDt = loop.paused ? 0 : realDt * loop.timeScale;
    rig.sync(rider, alpha);
    updateShadow();
    camTarget.pos = rider.state === 'BAILED' ? rig.riderBody.position : rig.root.position;
    camTarget.speed = rider.state === 'GROUNDED' ? rider.speed : rider.vel.length();
    camTarget.motionYaw = rider.motionYaw();
    camTarget.airborne = rider.state === 'AIRBORNE';
    camTarget.bailed = rider.state === 'BAILED';
    if (menu.open && menu.screen === 'rider') orbitPreview(realDt);
    else chase.update(loop.paused ? 0 : realDt, camTarget, input.look);
    decor.update(rig.root.position);
    ghosts.blobShadows = graphics.preset.shadows === 0;
    ghosts.update(net.serverNow() - 150, world);
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
      balance: rider.state === 'MANUALING' ? rider.balance : null,
      balanceLabel: 'BALANCE · W / S',
      score: run.score,
      timeLeft: run.timeLeft,
      personalBest: run.personalBest,
    });
    debug.update(realDt, rider);
    graphics.follow(rider.state === 'BAILED' ? rig.riderBody.position : rig.root.position);
    graphics.render();
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

/** Slow orbit around the rider while picking colours. */
let previewAngle = 0;
function orbitPreview(dt: number) {
  previewAngle += dt * 0.5;
  const p = rig.root.position;
  camera.position.set(p.x + Math.sin(previewAngle) * 3.2, p.y + 1.4, p.z + Math.cos(previewAngle) * 3.2);
  camera.lookAt(p.x, p.y + 0.8, p.z);
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
  if (graphics.preset.shadows > 0) { rig.shadow.visible = false; return; }
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
  graphics.resize(w, h, settings.renderScale);
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
/** Dev/test hook: advance the simulation n fixed steps with the given inputs (the loop is expected to be paused). */
function debugStep(n: number, patch: Record<string, unknown> = {}) {
  const dt = 1 / TUNING.physics.stepHz;
  for (let k = 0; k < n; k++) {
    rider.step(dt, { ...emptyInput(), ...patch });
    combo.update(dt, rider.state);
  }
  rig.sync(rider, 1);
  camTarget.pos = rider.state === 'BAILED' ? rig.riderBody.position : rig.root.position;
  camTarget.speed = rider.state === 'GROUNDED' ? rider.speed : rider.vel.length();
  camTarget.motionYaw = rider.motionYaw();
  camTarget.airborne = rider.state === 'AIRBORNE';
  camTarget.bailed = rider.state === 'BAILED';
}

(window as unknown as { sendit: unknown }).sendit = {
  debugStep, snapCamera: () => chase.snap(camTarget), camTarget, camera,
  rider, rig, tuning: TUNING, loop, combo, chase, menu, sfx, recorder, replay, startReplay, exitReplay, net, ghosts, graphics, settings, applySettings,
  get world() { return world; }, get run() { return run; }, loadPark, newRun, closeMenu,
};
