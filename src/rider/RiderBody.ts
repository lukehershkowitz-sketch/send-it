/**
 * The rider's body as a few spring-damper masses attached to the bike (not rigidly bolted to it).
 *  crouch  – hips/torso height: + compressed (preload, landing, tuck), − extended (push-off, landing prep)
 *  shiftX  – torso sideways relative to the bike (leans into spins, counters rolls)
 *  shiftZ  – torso fore/aft (weight shift, lag in flips)
 * Targets come from what the bike is doing (rotation rates, preload, predicted landing), and
 * impacts kick the springs, so everything overshoots and settles instead of snapping.
 */
export interface BodyTargets {
  crouch: number;
  shiftX: number;
  shiftZ: number;
  table: number;   // 0..1 tabletop pose blend (legs and arms pushed out)
}

export class RiderBody {
  crouch = 0; crouchV = 0;
  shiftX = 0; shiftXV = 0;
  shiftZ = 0; shiftZV = 0;
  table = 0;

  reset() {
    this.crouch = this.crouchV = this.shiftX = this.shiftXV = this.shiftZ = this.shiftZV = this.table = 0;
  }

  /** Impulse the springs (velocity units: crouch/s, m/s). */
  kick(crouchV: number, shiftZV = 0, shiftXV = 0) {
    this.crouchV += crouchV;
    this.shiftZV += shiftZV;
    this.shiftXV += shiftXV;
  }

  update(dt: number, t: BodyTargets) {
    // semi-implicit spring-dampers; slightly underdamped so the body overshoots and settles
    this.crouchV += (130 * (t.crouch - this.crouch) - 15 * this.crouchV) * dt;
    this.crouch = Math.max(-0.35, Math.min(1.05, this.crouch + this.crouchV * dt));
    this.shiftXV += (85 * (t.shiftX - this.shiftX) - 10 * this.shiftXV) * dt;
    this.shiftX = Math.max(-0.22, Math.min(0.22, this.shiftX + this.shiftXV * dt));
    this.shiftZV += (85 * (t.shiftZ - this.shiftZ) - 10 * this.shiftZV) * dt;
    this.shiftZ = Math.max(-0.22, Math.min(0.22, this.shiftZ + this.shiftZV * dt));
    this.table += (t.table - this.table) * (1 - Math.exp(-9 * dt));
  }
}
