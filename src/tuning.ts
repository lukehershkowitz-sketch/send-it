/**
 * SEND IT — every feel / scoring number lives here.
 * Units: metres, seconds, degrees (unless a name says otherwise).
 * Rates named "...Rate" are exponential smoothing rates (1/s): higher = snappier.
 */
export const TUNING = {
  physics: {
    stepHz: 120,               // fixed simulation rate
    gravity: 20,               // air gravity (real = 9.8). Heavier = snappier, less floaty airs
    groundGravityScale: 0.5,   // fraction of gravity that acts along slopes while rolling (keeps momentum up ramps)
    probeHeight: 0.6,          // ground probe starts this far above the wheels
    groundSnapDist: 0.25,      // max gap below wheels that still counts as "on the ground"
    convexStick: 1.6,          // >1 = stickier over crests before the bike gets light and leaves the ground
    maxSlopeChangeDeg: 55,     // a sudden surface change bigger than this = wall
    minGroundNormalY: 0.35,    // surfaces steeper than ~70° can't be ridden in Phase 1
    wallProbeHeights: [0.25, 0.75], // forward collision rays (wheel height, bars/knee height)
    wallProbeAhead: 0.55,      // ~front wheel reach
    bikeCapsuleHeight: 0.4,    // bike body vs rails: capsule centre height…
    bikeCapsuleRadius: 0.32,   // …and radius (covers wheels to bars)
    wallCrashSpeed: 3.5,       // hitting a wall faster than this = bail, slower = stop
    killY: -30,                // fall below this → respawn
  },

  ride: {
    pedalAccel: 6.5,           // m/s² at low speed (tapers toward max)
    maxPedalSpeed: 12,         // can't pedal faster than this (gravity/pumping can exceed it)
    maxSpeed: 24,              // hard cap
    brakeDecel: 11,
    rollingResistance: 0.12,   // m/s² constant drag
    airDrag: 0.0035,           // × speed²
    turnRateSlow: 150,         // °/s steering at standstill
    turnRateFast: 70,          // °/s steering at max pedal speed
    steerResponse: 9,          // keyboard steer smoothing rate
    gripSlow: 14,              // how fast travel direction follows the bars (carve tightness)
    gripFast: 7,               //   …at speed (lower = more drift/carve feel)
    carveScrub: 0.9,           // speed lost while the bike is sliding sideways
    pumpGain: 2.6,             // m/s gained per radian of transition when holding pedal (pumping)
    maxLeanDeg: 24,            // visual lean into carves
    fakieTurnSpeed: 3.5,       // below this speed, pedalling while fakie pivots you back to forward
  },

  pop: {
    compressTime: 0.22,        // time to fully load the suspension
    minCompression: 0.12,      // tap shorter than this = no pop
    popSpeed: 5.2,             // m/s added on a perfect, fully loaded pop
    baseFraction: 0.45,        // pop strength with zero compression (fraction of full)
    popUpBias: 0.85,           // 0 = pop along ramp normal, 1 = straight up
    flatHopScale: 0.85,        // bunnyhop on flat ground
    perfectWindow: 1.5,        // release within this many metres before the lip = PERFECT
    earlyMinFactor: 0.55,      // strength when released at the very bottom of the kicker
    lateWindow: 0.12,          // seconds after leaving the lip where a release still pops (LATE)
    lateFactor: 0.6,
  },

  air: {
    spinRate: 540,             // °/s while A/D held
    flipRate: 430,             // °/s while W/S held
    rotAccelRate: 14,          // spin-up rate when a key is pressed
    rotStopRate: 22,           // how fast rotation stops on release (∞ = instant)
    autoLevel: 1,              // 0 = bike keeps its takeoff pitch (sim-like), 1 = full landing assist
    pitchFollowRate: 4,      // how fast the takeoff pitch blends into the auto-level target
    alignTime: 0.75,           // in the last this-many seconds before touchdown, the nose lines up with the predicted landing surface
    groundAlignMin: 0.25,      // minimum landing-alignment weight early in the air (rest follows the trajectory)
    groundSampleRate: 10,      // smoothing of the predicted landing-surface normal
    spinSnapMin: 150,          // only assist spins once you've rotated at least this much
    spinSnapWindow: 30,        // ...and are within this many degrees of a 180 multiple
    spinSnapRate: 6,
    flipSnapMin: 300,          // same idea for flips (multiples of 360)
    flipSnapWindow: 35,
    flipSnapRate: 4,
    latchPedalAtTakeoff: true, // W held through the lip doesn't start a frontflip until re-pressed
    airDrag: 0.0015,
  },

  landing: {
    yawTolerance: 25,          // ° between wheels and travel direction (fakie = 180 ± this)
    pitchTolerance: 20,        // ° between wheels and the landing surface
    stompYaw: 8,               // inside these = STOMPED
    stompPitch: 8,
    requireInputsReleased: true,
    smallAirTime: 0.3,         // airs shorter than this get extra tolerance (rolling off small drops)
    smallAirToleranceScale: 1.8,
    maxImpactSpeed: 17,        // m/s into the surface; harder than this = bail even if aligned
    casedSlope: 0.45,          // landing on a face this steep pointing back at you (sin of slope)…
    casedImpact: 5,            // …with at least this much impact = cased it
    cleanSpeedKeep: 0.93,      // speed kept on a clean landing
    stompSpeedKeep: 1.0,       // speed kept on a stomp
    minAirTime: 0.04,
  },

  bail: {
    slowMoScale: 0.3,
    slowMoDuration: 0.8,       // real seconds
    respawnDelay: 1.7,         // sim seconds after the crash
    bounce: 0.3,
    groundFriction: 0.8,
    throwUp: 3,
    tumbleSpin: 9,             // rad/s max random tumble
  },

  camera: {
    baseFov: 62,
    speedFovBoost: 6,
    airFovBoost: 7,
    distMin: 4.8,
    distMax: 6.6,
    heightMin: 2.5,
    heightMax: 3.0,
    airPullBack: 1.2,
    airRaise: 1.0,
    yawLagRate: 3.5,           // lower = lazier swing on turns
    posLagRate: 9,
    verticalLagRate: 7,
    lookAhead: 4.0,
    lookHeight: 1.1,
    freeLookSensitivity: 0.005, // mouse
    freeLookStickSpeed: 3,      // rad/s on right stick
    freeLookReturnRate: 4,
  },

  input: {
    stickDeadzone: 0.2,
    triggerDeadzone: 0.08,
    restartHoldTime: 2.0,
  },

  render: {
    maxPixelRatio: 1.75,
    fogNear: 45,
    fogFar: 230,
  },
} as const;

export type Tuning = typeof TUNING;
