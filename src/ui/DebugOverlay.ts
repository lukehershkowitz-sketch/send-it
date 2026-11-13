import { TUNING } from '../tuning';
import { DEG } from '../core/math';
import type { RiderController } from '../rider/RiderController';

const ok = (b: boolean) => (b ? 'ok' : 'bad');
const f = (n: number, d = 1) => n.toFixed(d);

/** Live numbers for tuning feel. Toggle with ` or F3. */
export class DebugOverlay {
  private el = document.getElementById('debug')!;
  visible = true;
  private acc = 0;
  private frames = 0;
  private fps = 0;

  toggle() {
    this.visible = !this.visible;
    this.el.classList.toggle('hidden', !this.visible);
  }

  update(realDt: number, r: RiderController) {
    this.frames++;
    this.acc += realDt;
    if (this.acc < 0.1 || !this.visible) return;
    this.fps = this.frames / this.acc;
    this.frames = 0;
    this.acc = 0;

    const spd = r.state === 'GROUNDED' ? r.speed : r.vel.length();
    const lines: string[] = [];
    lines.push(`<b>${f(this.fps, 0)} fps</b>  state <b>${r.state}</b>${r.fakie ? ' <i>FAKIE</i>' : ''}`);
    lines.push(`speed ${f(spd)} m/s (${f(spd * 3.6, 0)} km/h)  y ${f(r.pos.y, 2)}`);
    lines.push(`compression ${f(r.compression, 2)}  last pop ${r.lastPop ? `${r.lastPop.label} ×${f(r.lastPop.factor, 2)} (${f(r.lastPop.strength, 2)} m/s)` : '—'}`);
    if (r.state === 'AIRBORNE') {
      lines.push(`airtime ${f(r.airTime, 2)} s   lands in ${r.predicted.valid ? f(r.predicted.time, 2) + ' s' : '—'}`);
      const w = r.rot.omegaB;
      lines.push(`spin ${f(r.spinAngle / DEG, 0)}°  flip ${f(r.flipAngle / DEG, 0)}°  roll ${f(r.rollAngle / DEG, 0)}°  tilt max ${f(r.rot.maxTilt / DEG, 0)}°`);
      lines.push(`ω pitch ${f(-w.x, 1)}  yaw ${f(w.y, 1)}  roll ${f(w.z, 1)} rad/s  inertia ×${f(r.rot.inertia, 2)}  assist ${f(r.assistCalm, 2)}`);
      lines.push(`whip ${f(r.whipAngle / DEG, 0)}°  bars ${f(r.barAngle / DEG, 0)}°  grab ${f(Math.max(r.varBlend.tuck, r.varBlend.superman, r.varBlend.cancan), 2)}  chain ${r.chain.join('→') || '—'}`);
      if (r.predicted.valid) {
        const c = r.checkLanding(r.predicted.normal, r.input);
        lines.push('<u>landing check (if you touched down now)</u>');
        lines.push(`<span class="${ok(c.yawErr <= c.yawTol)}">yaw err ${f(c.yawErr)}° / ±${f(c.yawTol, 0)}${c.fakie ? ' (fakie)' : ''}</span>`);
        lines.push(`<span class="${ok(c.pitchErr <= c.pitchTol)}">pitch err ${f(c.pitchErr)}° / ±${f(c.pitchTol, 0)}</span>`);
        lines.push(`<span class="${ok(c.whipErr <= TUNING.landing.whipTolerance)}">frame ${f(c.whipErr, 0)}°</span>  <span class="${ok(c.barErr <= TUNING.landing.barTolerance)}">bars ${f(c.barErr, 0)}°</span>  <span class="${ok(c.variation <= TUNING.landing.variationMaxBlend)}">grab ${f(c.variation, 2)}</span>`);
        lines.push(`<span class="${ok(!c.holding)}">inputs ${c.holding ? 'HELD' : 'released'}</span>  <span class="${ok(!c.inverted)}">${c.inverted ? 'INVERTED' : 'upright'}</span>`);
        lines.push(`→ <b class="${ok(c.ok)}">${c.ok ? (c.stomped ? 'STOMP' : 'CLEAN') : 'BAIL: ' + c.reason}</b>`);
      }
    } else if (r.state === 'GRINDING') {
      lines.push(`grind <b>${r.grindType}</b>${r.grindFakie ? ' (fakie)' : ''}  ${f(r.grindTime, 2)} s  rail t ${f(r.railT, 2)}`);
      lines.push(`speed ${f(r.speed)}`);
    } else if (r.state === 'MANUALING') {
      lines.push(`${r.manualNose ? 'nose manual' : 'manual'} ${f(r.manualTime, 2)} s  <span class="${ok(Math.abs(r.balance) < 0.7)}">balance ${f(r.balance, 2)}</span>`);
    } else {
      lines.push(`heading ${f(r.heading / DEG, 0)}°  travel ${f(r.travelYaw / DEG, 0)}°  lean ${f(r.lean / DEG, 0)}°`);
    }
    const l = r.lastLanding;
    if (l) {
      lines.push(`<u>last landing</u> <b class="${ok(l.ok)}">${l.ok ? (l.stomped ? 'STOMPED' : 'CLEAN') : 'BAIL'}</b> ${l.trick}`);
      lines.push(`air ${f(l.air.airTime, 2)}s  yaw ${f(l.yawErr)}°  pitch ${f(l.pitchErr)}°  impact ${f(l.impact)} m/s${l.reason ? '  — ' + l.reason : ''}`);
    }
    lines.push(`<span class="dim">tolerance ±${TUNING.landing.yawTolerance}° yaw / ±${TUNING.landing.pitchTolerance}° pitch · stomp ±${TUNING.landing.stompYaw}°</span>`);
    this.el.innerHTML = lines.join('<br>');
  }
}
