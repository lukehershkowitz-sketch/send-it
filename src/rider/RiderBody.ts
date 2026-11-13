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
  twist: number;   // torso yaw against the bike (rad): lags the spin
  head: number;    // head yaw against the torso (rad): spots the landing ahead of the spin
}

export class RiderBody {
  crouch = 0; crouchV = 0;
  shiftX = 0; shiftXV = 0;
  shiftZ = 0; shiftZV = 0;
  table = 0;
  twist = 0; twistV = 0;
  head = 0; headV = 0;

  reset() {
    this.crouch = this.crouchV = this.shiftX = this.shiftXV = this.shiftZ = this.shiftZV = this.table = 0;
    this.twist = this.twistV = this.head = this.headV = 0;
  }

  /** Impulse the springs (velocity units: crouch/s, m/s). */
  kick(crouchV: number, shiftZV = 0, shiftXV = 0) {
    this.crouchV += crouchV;
    this.shiftZV += shiftZV;
    this.shiftXV += shiftXV;
  }

  update(dt: number, t: BodyTargets) {
    // semi-implicit spring-dampers; slightly underdamped so the body overshoots and settles
    this.crouchV += (110 * (t.crouch - this.crouch) - 16 * this.crouchV) * dt;
    this.crouch = Math.max(-0.35, Math.min(1.05, this.crouch + this.crouchV * dt));
    this.shiftXV += (85 * (t.shiftX - this.shiftX) - 10 * this.shiftXV) * dt;
    this.shiftX = Math.max(-0.22, Math.min(0.22, this.shiftX + this.shiftXV * dt));
    this.shiftZV += (85 * (t.shiftZ - this.shiftZ) - 10 * this.shiftZV) * dt;
    this.shiftZ = Math.max(-0.22, Math.min(0.22, this.shiftZ + this.shiftZV * dt));
    this.table += (t.table - this.table) * (1 - Math.exp(-9 * dt));
    // upper body twists against the bike (soft, slightly underdamped); the head is quicker and leads
    this.twistV += (46 * (t.twist - this.twist) - 9 * this.twistV) * dt;
    this.twist = Math.max(-1.1, Math.min(1.1, this.twist + this.twistV * dt));
    this.headV += (95 * (t.head - this.head) - 13 * this.headV) * dt;
    this.head = Math.max(-1.2, Math.min(1.2, this.head + this.headV * dt));
  }
}
