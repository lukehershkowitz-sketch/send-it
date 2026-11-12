import type { RiderController } from '../rider/RiderController';

/**
 * Procedural sound (no asset files): continuous layers whose gains follow the rider, plus
 * one-shots for events. The AudioContext starts on the first user gesture (browser rule).
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private layers: Record<'roll' | 'wind' | 'skid' | 'grind' | 'whirr' | 'ring', { gain: GainNode; filter?: BiquadFilterNode }> = {} as never;
  private clickPhase = 0;
  volume = 0.8;
  muted = false;

  /** Call from any user gesture; safe to call repeatedly. */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);
    // 2 s of white noise, looped by every noise layer at different offsets
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    const layer = (type: BiquadFilterType, freq: number, q: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise; src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master);
      src.start(0, Math.random() * 2);
      return { gain, filter };
    };
    this.layers.roll = layer('lowpass', 400, 0.7);
    this.layers.wind = layer('bandpass', 900, 0.7);
    this.layers.skid = layer('bandpass', 1900, 1.4);
    this.layers.grind = layer('bandpass', 3400, 5);
    this.layers.whirr = layer('bandpass', 1100, 4);
    // metallic ring under the grind scrape
    const ringGain = ctx.createGain(); ringGain.gain.value = 0;
    for (const f of [687, 1129, 1876]) {
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = 0.25;
      o.connect(g).connect(ringGain); o.start();
    }
    ringGain.connect(this.master);
    this.layers.ring = { gain: ringGain };
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.05);
  }
  setMuted(m: boolean) { this.muted = m; this.setVolume(this.volume); }

  private set(name: keyof Sfx['layers'], value: number, tc = 0.06) {
    this.layers[name].gain.gain.setTargetAtTime(value, this.ctx!.currentTime, tc);
  }

  /** Per frame (real time). `paused` silences the continuous layers. */
  update(dt: number, r: RiderController, paused: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (paused) { for (const k of Object.keys(this.layers) as (keyof Sfx['layers'])[]) this.set(k, 0, 0.03); return; }
    const st = r.state;
    const onGround = st === 'GROUNDED' || st === 'MANUALING';
    const speed = onGround ? r.speed : r.vel.length();
    const sp = Math.min(1, speed / 14);
    const inp = r.input;

    this.set('roll', onGround ? 0.05 + sp * 0.32 : 0);
    this.layers.roll.filter!.frequency.setTargetAtTime(250 + sp * 900, t, 0.1);
    const air = st === 'AIRBORNE' ? Math.min(1, r.vel.length() / 15) * Math.min(1, r.airTime * 3) : 0;
    this.set('wind', air * 0.45 + (onGround ? sp * sp * 0.08 : 0), 0.15);
    this.layers.wind.filter!.frequency.setTargetAtTime(600 + air * 900, t, 0.2);
    const slip = onGround ? Math.abs(Math.sin(r.heading - r.travelYaw)) : 0;
    const skid = onGround && speed > 2.5 ? Math.max(inp.brake * 0.9, slip * 3) * sp : 0;
    this.set('skid', Math.min(0.5, skid * 0.5), 0.04);
    const grinding = st === 'GRINDING';
    this.set('grind', grinding ? 0.28 + sp * 0.2 : 0, 0.03);
    this.set('ring', grinding ? 0.04 + Math.random() * 0.03 : 0, 0.02);
    this.set('whirr', onGround && inp.pedal > 0.1 && !r.fakie ? 0.05 * inp.pedal : 0, 0.05);

    // freewheel ratchet: clicks while coasting, rate follows wheel speed
    if (onGround && inp.pedal < 0.1 && speed > 0.3) {
      const rate = Math.min(90, (speed / (2 * Math.PI * 0.255)) * 9);
      this.clickPhase += rate * dt;
      const vol = 0.09 * (1 - Math.min(1, rate / 110));
      while (this.clickPhase >= 1) {
        this.clickPhase -= 1;
        this.click(t + Math.random() * dt, vol);
      }
    } else this.clickPhase = 0;
  }

  private burst(at: number, dur: number, type: BiquadFilterType, freq: number, q: number, vol: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(at, Math.random() * 1.5, dur + 0.05);
  }

  private tone(at: number, dur: number, type: OscillatorType, f0: number, f1: number, vol: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, at);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(this.master);
    o.start(at); o.stop(at + dur + 0.05);
  }

  private click(at: number, vol: number) { this.burst(at, 0.012, 'highpass', 3500, 0.8, vol); }
  private now() { return this.ctx ? this.ctx.currentTime : -1; }

  pop(strength: number) {
    const t = this.now(); if (t < 0) return;
    this.tone(t, 0.12, 'sine', 140, 60, 0.25 * strength);
    this.burst(t, 0.1, 'lowpass', 900, 0.7, 0.2);
  }

  land(impact: number, stomped: boolean) {
    const t = this.now(); if (t < 0) return;
    const k = Math.min(1, impact / 12);
    this.tone(t, 0.22, 'sine', 110, 38, 0.35 + k * 0.5);
    this.burst(t, 0.18 + k * 0.15, 'lowpass', 700 + k * 600, 0.8, 0.25 + k * 0.4);
    if (stomped) this.burst(t + 0.02, 0.08, 'bandpass', 2500, 2, 0.12); // chain slap
  }

  crash() {
    const t = this.now(); if (t < 0) return;
    this.tone(t, 0.35, 'sine', 90, 30, 0.9);
    this.burst(t, 0.6, 'lowpass', 1200, 0.6, 0.7);
    for (const [f, d] of [[420, 0.5], [1130, 0.35], [2210, 0.25], [3150, 0.2]] as const)
      this.tone(t + 0.04 + Math.random() * 0.05, d, 'triangle', f, f * 0.98, 0.1);
  }

  grindStart() {
    const t = this.now(); if (t < 0) return;
    for (const f of [960, 1520]) this.tone(t, 0.25, 'triangle', f, f, 0.12);
    this.burst(t, 0.08, 'highpass', 2500, 1, 0.25);
  }

  bank(points: number) {
    const t = this.now(); if (t < 0) return;
    const notes = points > 5000 ? [523, 659, 784, 1047] : points > 1500 ? [523, 659, 784] : [523, 784];
    notes.forEach((f, i) => this.tone(t + i * 0.07, 0.35, 'triangle', f, f, 0.16));
  }

  lost() {
    const t = this.now(); if (t < 0) return;
    this.tone(t, 0.45, 'sawtooth', 220, 90, 0.08);
  }

  ui() {
    const t = this.now(); if (t < 0) return;
    this.tone(t, 0.05, 'square', 880, 880, 0.04);
  }
}
