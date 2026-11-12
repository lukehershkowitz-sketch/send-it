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
    minGroundNormalY: -0.05,   // allow riding up to (just past) vertical on transitions; walls are caught by maxSlopeChangeDeg
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
    pumpGain: 1.5,             // m/s gained per radian of transition when holding pedal (pumping)
    pumpMaxSpeed: 14,          // pumping stops adding speed above this
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
    vertNormalY: 0.25,         // leaving a surface steeper than ~75° going up = vert air (spins turn you in the wall's plane); spines (~70°) let you transfer
    vertOutSpeed: 0.5,         // in vert air, speed away from the wall is set to this so you come back down the transition
    whipRate: 760,             // °/s tailwhip
    barRate: 900,              // °/s barspin
    flairSpinRatio: 0.5,       // flair button: spin speed as a fraction of flip speed (360 flip ↔ 180 spin)
    catchWindow: 80,           // releasing a whip/barspin within this many ° of a full turn auto-catches it…
    catchRate: 16,             // …this fast. Outside the window it stops where it is (= bail if you land)
    completeWithin: 20,        // a whip/barspin counts as done once it's this close to the full turn
    variationBlendIn: 9,       // how fast the rider moves into a grab/variation pose
    variationBlendOut: 7,      // …and back out of it (must be mostly out before landing)
    airDrag: 0.0015,
  },

  landing: {
    yawTolerance: 25,          // ° between wheels and travel direction (fakie = 180 ± this)
    pitchTolerance: 20,        // ° between wheels and the landing surface
    stompYaw: 8,               // inside these = STOMPED
    stompPitch: 8,
    requireInputsReleased: true,
    whipTolerance: 25,         // frame must be within this many ° of straight
    barTolerance: 30,          // bars must be within this many ° of centre
    variationMaxBlend: 0.35,   // rider must be at least this far back from a grab pose
    smallAirTime: 0.3,         // airs shorter than this get extra tolerance (rolling off small drops)
    smallAirToleranceScale: 1.8,
    maxImpactSpeed: 17,        // m/s into the surface; harder than this = bail even if aligned
    casedSlope: 0.45,          // landing on a face this steep pointing back at you (sin of slope)…
    casedImpact: 5,            // …with at least this much impact = cased it
    cleanSpeedKeep: 0.93,      // speed kept on a clean landing
    stompSpeedKeep: 1.0,       // speed kept on a stomp
    minAirTime: 0.04,
  },

  grind: {
    snapRadius: 0.34,          // pegs within this of a rail (coming down onto it) = lock on
    maxEntryAngle: 55,         // ° between travel and rail; steeper = clip it and bail
    friction: 0.7,             // m/s² lost while grinding
    gravityScale: 0.6,         // slope gravity on sloped rails
    minSpeed: 0.8,             // slower than this and you fall off the end
    doublePegAngle: 14,        // |bike yaw vs rail| under this = double peg, else feeble/smith
    icepickPitch: 20,          // nose-up ° at entry for an icepick
    feebleSmithYaw: 26,        // visual yaw of the bike in feeble/smith
    icepickNoseUp: 34,
    popScale: 0.85,            // pop strength off a rail (× normal pop)
    balanceInstability: 2.2,   // how fast an off-centre balance falls further (grows with time)
    instabilityGrowth: 0.5,
    balanceNoise: 1.8,         // random wobble
    balanceControl: 5.5,       // how hard A/D push the balance
    balanceDamping: 1.6,
  },

  manual: {
    minSpeed: 1.5,
    pitch: 22,                 // ° nose up in a manual (nose-down for nose manuals)
    nosePitch: 16,
    pitchPerBalance: 12,       // extra ° from the balance needle
    steerScale: 0.6,
    friction: 0.35,            // extra m/s² drag while manualling
    balanceInstability: 1.8,
    instabilityGrowth: 0.35,
    balanceNoise: 1.0,
    balanceControl: 4.5,       // W/S push the balance
    balanceDamping: 1.6,
  },

  score: {
    spinPer180: 150,
    flipPer360: 500,
    flairBonus: 300,           // on top of the backflip + 180 it contains
    whipPer360: 350,
    barPer360: 250,
    airtimePerSec: 120,
    minAirForAirtime: 0.5,
    variations: { tuck: 250, superman: 400, cancan: 300 },
    varMinHold: 0.25,          // grabs count after this hold…
    varMaxHold: 1.0,           // …and their bonus scales up to here
    varMaxMult: 2.0,           // bonus at max hold
    invertedMult: 1.5,         // any flip
    stompMult: 1.25,           // stomped landing (extra goes to the Stomps category)
    grindBase: { 'DOUBLE PEG': 100, FEEBLE: 150, SMITH: 150, ICEPICK: 200 } as Record<string, number>,
    grindPerSec: 200,
    manualBase: 75,
    manualPerSec: 160,
    minManualTime: 0.4,
    linkStep: 0.5,             // line multiplier = 1 + linkStep × (tricks in line − 1)
    linkWindow: 0.9,           // seconds you can roll on the ground before the line banks
    repetition: [1, 0.75, 0.55, 0.4], // pay-out for a trick seen in 0/1/2/3 of the last airs
    repetitionMemory: 3,
    varietyPerKind: 75,        // bank bonus per distinct trick in the line beyond the 2nd
  },

  run: {
    duration: 120,             // seconds per run
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
