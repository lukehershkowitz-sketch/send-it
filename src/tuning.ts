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
    // --- preload: hold Space to compress, release to push off. Nothing is added instantly:
    //     the push is spread over `extendTime` while the bike is still on the ramp, so the ramp
    //     (speed + shape) provides most of the height and the push is a bounded extra.
    compressTime: 0.28,        // time to fully load the suspension
    minCompression: 0.12,      // tap shorter than this = no pop
    popSpeed: 3.8,             // m/s push-off on a ramp at full quality (the ramp adds the rest)
    coilSlack: 0.7,            // m: if the push finishes this close to the lip the rider stays loaded until it arrives (a fair timing window)
    coilMax: 0.25,             // s the push can stay coiled
    hopSpeed: 4.0,             // m/s push-off for a flat-ground bunny hop
    baseFraction: 0.35,        // push with the lightest preload (fraction of full)
    extendTime: 0.13,          // s to extend from compressed to fully extended (release → full push)
    sweetHold: 0.22,           // holding this long (s) gives a full-quality preload…
    fatigueHold: 0.8,          // …but holding past this loses the stored energy
    fatigueRate: 1.6,          // 1/s decay of quality past fatigueHold
    popUpBias: 0.7,            // 0 = push along the surface normal, 1 = straight up
    rampNormalY: 0.985,        // surface flatter than this counts as flat ground (bunny hop)
    hopFrontLift: 3.0,         // rad/s nose-up rate at the start of a bunny hop (front wheel leaves first)
    hopLiftTime: 0.12,         // s the front-lift lasts before the rear wheel follows
    shiftRate: 1.5,            // rad/s of pitch/roll added at takeoff per unit of body-weight shift (W/S/A/D while loaded)
    loadCompress: 0.4,         // suspension compression per extra g of ramp load
    loadMaxCompress: 0.75,
    pitchRateKeep: 0.8,        // fraction of the ramp's rotation (v·curvature) the bike keeps when it leaves
    lateWindow: 0.12,          // seconds after leaving the lip where a release still pops (LATE)
    lateFactor: 0.6,
  },

  air: {
    autoLevel: 0.85,           // 0 = no help, 1 = full: the light landing assist described below
    latchPedalAtTakeoff: true, // W held through the lip doesn't start a frontflip until re-pressed
    airDrag: 0.0008,           // × speed²: speed is kept in the air
    vertNormalY: 0.25,         // leaving a surface steeper than ~75° going up = vert air (spins turn you in the wall's plane); spines (~70°) let you transfer
    vertOutSpeed: 0.5,         // in vert air, speed away from the wall is set to this so you come back down the transition
    whipRate: 600,             // °/s tailwhip
    barRate: 700,              // °/s barspin
    rotAccelRate: 14,          // spin-up smoothing of whips/barspins
    rotStopRate: 22,
    catchWindow: 80,           // releasing a whip/barspin within this many ° of a full turn auto-catches it…
    catchRate: 16,             // …this fast. Outside the window it stops where it is (= bail if you land)
    completeWithin: 20,        // a whip/barspin counts as done once it's this close to the full turn
    variationBlendIn: 9,       // how fast the rider moves into a grab/variation pose
    variationBlendOut: 7,      // …and back out of it (must be mostly out before landing)
    // --- stabiliser (all scaled by autoLevel). Only ever acts on pitch and roll, never on spin.
    followGain: 18,            // rad/s² per rad: nose follows the flight path while you aren't rotating
    followDamp: 8,
    followGainRoll: 55,        // roll is brought back level harder and faster than pitch is followed (a rider rights the bike quickly)
    followDampRoll: 7.5,
    followEngage: 12,          // 1/s: how fast the stabiliser re-engages once you stop driving the rotation
    followMaxFlip: 105,        // ° of flip (vs the flight path) beyond which following switches off: that's a flip trick, not nose lag
    followMaxPitchRate: 2.4,   // rad/s: …or while pitching faster than this
    followMaxRoll: 110,        // ° of accumulated roll beyond which following switches off…
    followMaxRollRate: 4.5,    // …or while rolling faster than this (rad/s): a barrel roll in progress         // ° of accumulated flip/roll beyond which following switches off (you're doing a trick)
    blendTime: 0.9,            // s before touchdown the target nose angle starts easing from the flight path onto the landing slope
    alignTime: 0.7,           // in the last this-many seconds the landing nudge fades in
    alignGain: 120,             // rad/s² per rad toward the predicted landing surface
    alignDamp: 14,
    alignWindow: 80,           // ° — only nudges when within this of a clean landing (never drags a half-done flip back)
    alignMax: 38,              // rad/s² cap on the nudge
    yawNudge: 36,              // rad/s² per rad: eases a near-clean spin onto the travel direction (or fakie)
    yawWindow: 110,
    yawDamp: 3.5,              // rad/s² per rad/s: settles a near-clean spin while the landing nudge is on
    prepTime: 0.3,             // s before touchdown the rider starts reaching for the ground (spreading out slows rotation)
    groundSampleRate: 10,      // smoothing of the predicted landing-surface normal
  },

  /**
   * Rotational physics of rider + bike in the air. Inputs are torques; the bike has angular
   * momentum, so rotations build up, carry on when you let go, and need counter-input (or a
   * brace) to stop. Per-axis terminal rates come from quadratic air drag.
   */
  rot: {
    torque: { pitch: 21, yaw: 22, roll: 26 },   // rad/s² at full input (neutral posture)
    maxRate: { pitch: 7.2, yaw: 9.5, roll: 8.2 }, // rad/s: the most the rider can drive each axis to
    inertia: { pitch: 1.0, yaw: 0.7, roll: 0.45 }, // relative moments (drive gyroscopic coupling between axes)
    gyro: 0.4,                 // 0..1 how strongly the axes interact (Euler's equations)
    linearDrag: 0.28,          // 1/s: untouched spins decay slowly
    tuckInertia: 0.74,         // posture: tuck (no-hander key) → spins faster (angular momentum is conserved)
    braceInertia: 1.45,        // brace (hold Space in the air) → spreads out, slows rotation
    braceDamping: 2.4,         // 1/s extra damping while bracing
    inertiaRate: 10,           // how fast posture changes
    // off-axis mixes: ratio of each axis torque to the spin torque
    flairYaw: 0.45,            // ↑ alone: backflip with this much spin
    corkRoll: 0.44,            // ↑ + A/D: spin with the axis tilted sideways → cork
    corkPitch: 0.3,
    rodeoPitch: 0.95,          // ↑ + A/D + S: spin with the axis tipped back → rodeo
    rodeoRoll: 0.19,
    mistyPitch: 0.95,          // ↑ + A/D + W: tipped forward → misty
    mistyRoll: 0.15,
    tabletopAngle: 78,         // ° the tabletop key rolls the bike toward
    tabletopGain: 70,
    tabletopDamp: 9,
    // classification thresholds (°) — names come from how you actually rotated
    spinMin: 150,
    axisTiltMin: 18,           // ° the rotation axis must lean from vertical for a spin to count as off-axis…
    axisTiltMax: 72,           // …but not so far it's really a flip
    offAxisTilt: 55,           // body must tip this far from level while spinning to count as off-axis
    offAxisMin: 60,            // …and have rotated this much about a second axis
    fullFlip: 330,
    tabletopMinRoll: 55,
    tabletopHold: 0.18,        // s
  },

  landing: {
    yawTolerance: 48,          // ° between wheels and travel direction (fakie = 180 ± this)
    pitchTolerance: 34,        // ° between wheels and the landing surface
    stompYaw: 8,               // inside these = STOMPED
    stompPitch: 8,
    requireInputsReleased: false, // holding keys into the landing just makes it sketchy, never a bail
    bailSeverity: 2.6,         // only landings this many × past tolerance (or upside down / on your head) crash
    sketchyAt: 1.0,            // past tolerance = a sketchy save: speed scrub + wobble, no bail
    saveYawRate: 9,            // how fast a crooked landing straightens out (1/s)
    whipTolerance: 25,         // frame must be within this many ° of straight
    barTolerance: 30,          // bars must be within this many ° of centre
    variationMaxBlend: 0.35,   // rider must be at least this far back from a grab pose
    smallAirTime: 0.3,         // airs shorter than this get extra tolerance (rolling off small drops)
    smallAirToleranceScale: 1.8,
    steepToleranceScale: 1.3,  // landing on a wall steeper than ~40°
    maxImpactSpeed: 24,        // m/s into the surface; harder than this = bail even if aligned
    casedSlope: 0.45,          // landing on a face this steep pointing back at you (sin of slope)…
    casedImpact: 5,            // …with at least this much impact = cased it
    cleanSpeedKeep: 0.93,      // speed kept on a clean landing
    stompSpeedKeep: 1.0,       // speed kept on a stomp
    minAirTime: 0.04,
    contactMinAir: 0.07,       // s before wheel/body contact tests start (the bike is still clearing the lip)
    rollTolerance: 42,         // ° sideways lean allowed at touchdown
    wobbleStiffness: 120,      // landing wobble spring (rotation of the bike relative to the ground)
    wobbleDamping: 11,
    wobbleCarry: 0.3,          // fraction of the air angular velocity carried into the wobble
    wobbleMax: 30,             // ° cap on the initial wobble
    severitySpeedLoss: 0.2,    // speed lost at the edge of tolerance (scaled by how crooked it was)
    frontWheelLoss: 0.05,      // extra speed lost landing on the front wheel first
    headRadius: 0.2,           // rider's head/bars test points for crashes (see Airborne)
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
    corkPer180: 190,           // horizontal spin of a cork (per 180°) — on top of the bonus
    corkBonus: 380,
    rodeoBonus: 520,           // rodeo: backward off-axis (spin + flip share)
    mistyBonus: 520,           // misty: forward off-axis
    offAxisFlipShare: 0.6,     // fraction of a flip's value an off-axis rodeo/misty earns for its flip part
    rollPer360: 450,           // barrel roll
    tabletopBase: 300,
    tabletopPerSec: 260,
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
    speedFovBoost: 7,
    airFovBoost: 3,
    distMin: 4.8,
    distMax: 6.6,
    heightMin: 2.5,
    heightMax: 3.0,
    airPullBack: 1.2,
    airRaise: 1.0,
    yawLagRate: 4.5,           // lower = lazier swing on turns
    posLagRate: 9,
    verticalLagRate: 7,
    lookAhead: 4.0,
    lookHeight: 1.1,
    bigAirHeight: 5,           // m above the ground at which the framing has fully widened for a big jump
    bigAirPull: 2.2,           // extra distance behind the rider at that height
    bigAirRaise: 0.9,
    bigAirFov: 3,              // extra field of view at that height
    landKick: 0.05,           // m of vertical camera dip per m/s of landing impact
    landKickMax: 0.4,
    landKickFov: 0.55,         // ° of FOV punch per m/s of impact
    landStiffness: 150,
    landDamping: 14,
    airLookAhead: 0.5,         // extra look-ahead (× horizontal speed fraction) so the landing stays in frame
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
