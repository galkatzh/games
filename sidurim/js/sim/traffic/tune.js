// js/sim/traffic/tune.js — WP-TRAFFIC
// Every number that shapes the AI drivers (GAME_DESIGN 9, ARCHITECTURE 12.5). Names are private to this package, except the
// shared keys in ARCHITECTURE 12.1.9.
(function (TLV) {
  'use strict';

  TLV.tune.traffic = {
    // Shared keys.
    bubbleSpawnMin: 140,
    bubbleSpawnMax: 300,
    bubbleDespawn: 390,
    hardBrake: 8,
    visibleM: 170,
    visibleDeg: 75,
    parkBlinkM: 30,
    parkCommitM: 10,

    // Drivers, as base + slope * ag (GAME_DESIGN 9).
    speedBase: 1.05,
    speedAg: 0.35,
    headwayBase: 1.5,
    headwayAg: -0.9,
    gapBase: 2.2,
    gapAg: -1.2,
    accelBase: 1.4,
    accelAg: 1.0,
    brakeBase: 2.2,
    brakeAg: 0.8,
    politeBase: 0.5,
    threshBase: 0.2,
    threshAg: -0.15,
    safeBrakeBase: 3,
    safeBrakeAg: 4,
    /** IDM exponent (ARCHITECTURE 12.5). */
    delta: 4,
    /** Curve speed, as a multiple of a connector's own vmax (base + slope * ag). A straight connector still keeps to the lane limit. */
    curveBase: 1.35,
    curveAg: 0.5,
    /** Slowing down to a lower limit ahead, m/s2. */
    curveBrake: 3.0,
    /** A bus or truck keeps to lanes at least this wide, so that two of them can pass. */
    heavyLaneW: 2.9,
    /** Longer than this, a body rides this share of the way from the path to the line between its axles (see idm.axlePose). */
    longBody: 6,
    longChord: 0.25,
    /** How fast that share changes, per metre driven. */
    longEase: 0.05,
    longLook: 6,
    /** A centre that would stand in a footprint comes back toward its lane by this much share at a time. */
    longWallStep: 0.02,
    /** Spawn mix in percent, in the order of spawnKinds (ARCHITECTURE 10.2). */
    spawnKinds: ['sedan', 'hatch', 'taxi', 'van', 'bus', 'truck'],
    spawnMix: [54, 22, 10, 8, 4, 2],

    // Cadence, ticks. FSM 5 Hz and gate 10 Hz, each staggered by slot (ARCHITECTURE 12.5).
    fsmTicks: 12,
    gateTicks: 6,
    nearTicks: 6,
    maintainTicks: 15,

    // Following.
    /** Leaders are looked for this far, plus the stopping distance. */
    lookBase: 30,
    lookMax: 110,
    /** A leader beside the car by this much more than the two half widths does not obstruct it. */
    latClear: 0.1,
    /** A stop line is held this far short, nose to line. */
    stopPad: 0.6,
    /** A line ahead counts this many seconds of travel before the grant distance, and is braked for at this share over a plain stop. */
    lineMargin: 0.2,
    lineBrakeShare: 1.25,
    /** Hard brake for a person at TTC under max(pedTtcMin, v / pedTtcDiv + pedTtcAdd) (ARCHITECTURE 12.5). */
    pedTtcMin: 0.8,
    pedTtcDiv: 16,
    pedTtcAdd: 0.25,
    /** Reach of the look for people along the path, past the stopping distance, and the half width of the corridor past the body. */
    pedLook: 6,
    pedCorridor: 0.7,
    pedBodyClear: 0.15,
    /** A new car keeps this far from anyone, and looks this many seconds of travel past its stopping room. */
    spawnPersonM: 0.5,
    spawnPersonS: 0.5,
    /** The last net: people this close to the body are read every tick, and a car's move never brings it inside a person's radius plus this. */
    personNetM: 2,
    personNetClear: 0.02,
    /** The net's radius less this is what the people package reads as touching: its own 0.02 m and personNetClear. */
    personNetInside: 0.04,
    /** The player on foot, as the People gate reads him. */
    personNetFootR: 0.35,
    pedSampleM: 2.5,
    /** Further behind the nose than this, a person is beside the car, or under what it has already passed, and not in its way. */
    pedBehindNose: 0.5,
    /** The body read this far ahead for someone it would sweep, seconds of travel plus metres, above this speed. */
    pedSweepS: 0.5,
    pedSweepPad: 0.6,
    pedSweepV: 0.5,
    /** Corridor beside the body for ag above pedSqueezeAg, who may squeeze past (GAME_DESIGN 9). */
    pedSqueezeAg: 0.7,
    pedSqueezeCorridor: 0.25,
    /** The player: 40 m sensor cone at 10 Hz while off-lane (ARCHITECTURE 12.5), half angle in degrees, and side clearance. */
    sensorM: 40,
    sensorDeg: 35,
    sensorLat: 0.4,
    /** Faster than this across the car's path, the player is not yielded to (GAME_DESIGN 4). */
    sensorCrossV: 3,
    /** Horn cone (GAME_DESIGN 4). */
    hornM: 12,
    hornDeg: 45,
    hornBoost: 1.3,
    hornBoostS: 2,

    // Contact net. Nothing moves to within this of another AI body, on any tick.
    contactClear: 0.06,
    /** Between bodies within this of parallel, as the sine of the angle, the limit is contactMin. */
    contactParallel: 0.2,
    contactMin: 0.01,
    /** The net's early eye: braking it asks for, seconds of lag between looks, metres past the stop. Under softMinV a look reads softHoldS ahead. */
    softBrake: 5,
    softLagS: 0.1,
    softPad: 0.4,
    softMinV: 0.2,
    softHoldS: 2,
    /** A neighbour list reaches a bus's half diagonal, plus how far two cars can close between refreshes. */
    nearBody: 6.5,
    nearReach: 4,
    nearLookMax: 14,

    // Junction gate (ARCHITECTURE 12.5).
    grantBase: 12,
    grantPerV2: 0.2,
    grantPad: 6,
    /** A car further than this off its lane's centre asks for nothing. */
    grantLat: 0.6,
    exitPad: 2.5,
    /** A moving tail counts as this many seconds further on when judging room on an exit lane. */
    roomLookS: 3,
    /** A walk draws again, this many times, for an exit lane whose rear car is under exitBusyV inside exitBusyShare of its length. */
    exitRedraws: 2,
    exitBusyV: 1,
    exitBusyShare: 0.6,
    /** Priority requests stay alive this many ticks: one gate period and a margin. */
    reqTtl: 8,
    /** Impatience overrides priority after this long, never occupancy (ARCHITECTURE 12.5). */
    impatientS: 10,
    /** An impatient car takes a grant from a car at least this far away, in seconds. */
    impatientTta: 2,
    /** A waiting head of queue may go on amber after this long, to clear its turn. */
    sneakS: 3,
    sneakNose: 4,
    /** A grant is given up when its holder stands this long short of the line. */
    grantStaleS: 4,
    /** A car stops for amber if it can at this share of a hard stop, using its comfort brake. */
    stopBrakeShare: 1.3,

    // Lane change (ARCHITECTURE 12.5).
    laneChangeMin: 1.5,
    laneChangeMax: 2.5,
    /** Metres of lane left, past the lane change itself, below which no change starts. */
    laneEndClear: 15,
    /** Gap kept to both neighbours, bumper to bumper, on top of the MOBIL checks. */
    laneGapMin: 2.5,
    laneCoolS: 5,
    /** A change the contact net holds this long turns round. */
    laneRefuseS: 0.6,
    /** No change or pass crosses a lane vertex sharper than this, nor starts within laneBendClear metres of one. */
    laneBendDeg: 25,
    laneBendClear: 6,
    /** A lane this short leaves no room to change off it, so a lane beside it is no way out. */
    laneEscapeM: 45,
    /** Mandatory changes start this far from the lane end (ARCHITECTURE 12.5). */
    mandatoryM: 60,

    // Where the player will feel it (a tuning of GAME_DESIGN 9). Each car is in a sight tier: on the player's route ahead going the
    // same way, beside the route ahead (cross traffic, the oncoming lane, side roads), in the view cone, or far. Nothing counts nearer
    // than spotMinM + spotMinS per m/s of the player's speed: a car that brakes in front of the player brakes over its own stopping
    // distance too, so that much is room enough.
    // Red runs: routeBoost beside the route, nearBoost elsewhere in the half of the street ahead, within spotM, and farShare beyond,
    // up to redBoostMax. A run is a crossing, and cross traffic at the next junction is wide of any cone. Nearer than
    // redFairM + redFairS per m/s + v^2 / redFairDecel, which is fairness rule 1 of the staged incidents, a run keeps the design's rate.
    // Where a run is boosted, it also needs nearBolder less aggression.
    // Overtakes and nose-ins: routeBolder less aggression needed on or beside the route, nearBolder in the cone or behind the player.
    // Lane blockers: their clocks run at routeRate on the player's road, viewRate elsewhere in sight, blockerAway out of it. Out of
    // sight a clock that has gone off waits farHoldS for the car to come into view before it acts anyway. Their caps count only the
    // blockers ahead of the player and in reach, with a bubble-wide ceiling of the cap plus spotCapExtra.
    spotM: 160,
    spotMinM: 6,
    spotMinS: 0.6,
    spotDeg: 60,
    redFairM: 3,
    redFairS: 0.9,
    redFairDecel: 28,
    spotLatM: 14,
    spotStepM: 10,
    spotSameCos: 0.7,
    spotBehindM: 25,
    spotCapExtra: 2,
    sightTicks: 6,
    blockerAway: 0.25,
    routeRate: 4,
    viewRate: 1.5,
    farHoldS: 90,
    farShare: 0.25,
    nearBoost: 3,
    routeBoost: 4,
    nearBolder: 0.15,
    routeBolder: 0.25,
    redBoostMax: 0.6,

    // Red runs (GAME_DESIGN 9).
    redLateAg: 0.5,
    redLateP: 0.15,
    redLateS: 1.5,
    redJumpAg: 0.7,
    redJumpP: 0.25,
    redJumpS: 3,

    // Honk (GAME_DESIGN 9, 22).
    honkGreenDelay: 0.2,
    honkBlockedS: 2,
    honkBlockedAg: 0.4,
    honkCoolS: 2,
    honkS: 0.4,

    // Tailgate.
    tailM: 40,
    tailAg: 0.6,
    tailMax: 2,
    tailMinS: 8,
    tailMaxS: 20,
    tailT: 0.1,
    tailS0: 1.4,
    /** Metres past s0 that T may ask for, so that the gap stays in 1.4-3 m at any speed (GAME_DESIGN 24, row 13). */
    tailHeadM: 0.9,
    /** How far over the target's speed a tailgater drives, and how hard it pulls. An ordinary driver's 2 m/s2 never catches a moving car. */
    tailPush: 9,
    tailA: 6,
    tailB: 7,
    /** The episode's clock runs once the gap is under tailCloseM, and only while the target moves faster than tailRunV. */
    tailCloseM: 5,
    tailRunV: 3,
    /** Gives up if it has not closed in this long. No episode outlasts tailMaxS, however long a red holds it. */
    tailCloseMaxS: 14,
    tailEpisodeS: 45,
    /** The target can drop off the car's lists this long, through a junction. Further than tailLostM it has gone. */
    tailLostS: 2.5,
    tailLostM: 70,
    /** A target this far outside the car's own width, sideways, is not in its way. */
    tailSide: 0.5,
    tailHornS: 3,
    tailCoolS: 15,
    /** With this little left of its clock, a car on the player's bumper goes past him the first time the road lets it. */
    tailDiveLastS: 2.5,

    // Nose in.
    noseMax: 4,
    noseGapMin: 0.8,
    noseGapMax: 1.5,
    noseMinM: 4,
    noseFollowBrake: 5,
    noseWaitS: 0.6,
    noseAg: 0.35,
    noseTimeoutS: 12,

    // Overtake.
    overAg: 0.55,
    overMax: 3,
    overSlowShare: 0.6,
    overSlowS: 3,
    overLatGap: 0.6,
    overCutMin: 0.5,
    overCutMax: 0.8,
    overAbortTtc: 2,
    overLatRate: 1.6,
    overCutRate: 1.8,
    overSpeed: 1.2,
    /** Road needed past the car, on top of the pass itself, and past the leader for a gap to return to. */
    overRoomPad: 14,
    overFrontGap: 8,
    /** A pass in the opposite lane gives up when this little road is left, plus the stopping distance. */
    overEndClear: 16,
    /** Passing the player: this far over his speed, this hard, and it cuts in with this little road left. A car only 20% over a limit he already drives never gets past. */
    overRel: 8,
    overA: 4,
    /** Past the player the gap to come back to is the car and this, not overFrontGap: he has a car on his nose, and that is the point. */
    overPlayerFront: 4,
    overPlayerPad: 6,
    overPlayerEndClear: 6,
    overPlayerStop: 12,
    /** Most a car passing the player may go, as a multiple of its road speed. */
    overPlayerMax: 1.8,
    /** Road ahead of the oncoming car that a pass of the player leaves it, past the pass itself. */
    overOncomingPad: 12,
    /** A car that passed over its limit comes back to it this gently: a pass ends right in front of the player, and is not a brake check. */
    overEase: 2.5,
    /** A car this close behind the player goes round him if the road lets it, however fast he is going, at most once in overPlayerCoolS. */
    overPlayerM: 30,
    overPlayerCoolS: 8,
    /** How far up the player's route a pass of him reads where he is heading. */
    overHeadsM: 30,
    /** A slower car on the passing lane closer than this share of the pass ends it before it starts. */
    overLaneShare: 0.8,
    /** Cutting in, it comes down to this much over the player. */
    overCutRel: 2,
    /** A car passing the player stays on the throttle to the last of the road, and leaves the bend this much braking. */
    overBrake: 6,
    /** Metres of lane its cut-in needs past the change itself. */
    overCutClear: 4,
    overTimeoutS: 14,

    // Brake lights: two thresholds, m/s2, so a car easing along a queue does not flicker. Under stationaryV it stands on the pedal.
    brakeLightOn: 1,
    brakeLightOff: 0.3,

    // Phantom stop, double park, drop-off (GAME_DESIGN 9). Rates are per car per minute.
    phantomRate: 0.02,
    phantomMax: 2,
    phantomBrakeMin: 4,
    phantomBrakeMax: 7,
    phantomMinS: 5,
    phantomMaxS: 25,
    junctionClear: 15,
    doubleRate: 0.01,
    doubleMax: 2,
    doubleMinS: 20,
    doubleMaxS: 40,
    doubleBrake: 3,
    dropRate: 0.02,
    dropMax: 3,
    dropMinS: 8,
    dropMaxS: 20,
    dropAheadM: 20,
    dropHazardS: 0.5,
    dropDoorS: 1,
    dropStillV: 0.1,
    /** A door opens only with nothing passing on its side, within this plus the car's stopping room. */
    doorClearM: 6,
    doorMovingV: 1,
    pullWaitS: 5,

    // Bus (GAME_DESIGN 9).
    busStopMinS: 10,
    busStopMaxS: 15,
    busLookM: 35,
    busCoolS: 30,

    // Blockers with no way round (ARCHITECTURE 12.5).
    blockerS: 6,
    blockerNearM: 30,

    // Commands (ARCHITECTURE 13.1).
    aimOverspeed: 1.3,
    reverseSpeed: 3.5,
    reverseAccel: 2.5,
    reverseClear: 1.2,
    reverseMaxS: 20,
    towSpeed: 3,
    towS: 5,
    /** The longest a tow waits for the player's car to clear its way. A car that never moves must not hold a wreck in the lane for ever. */
    towWaitS: 12,
    standoffMaxS: 60,
    parkRaceMaxS: 60,
    creepV: 6,
    blinkV: 8,
    creepLat: 0.5,
    commitS: 2.4,
    parkHoldStop: 6,
    routeEveryS: 0.5,
    pullOutS: 1.6,
    doorMinS: 2,
    doorMaxS: 3,

    /** Room round a parked car being made live, and how far off a body has to be to be left out of the look. */
    stallClear: 0.3,
    stallReach: 12,

    // Impact (ARCHITECTURE 10.2).
    dynamicMinS: 2,
    dynamicMaxS: 4,
    dynamicFriction: 6,
    dynamicSpin: 0.9,
    rejoinS: 1.5,
    rejoinLat: 1.5,
    rejoinDeg: 25,
    rejoinV: 2,
    wreckS: 6,
    impactDynamic: 1.5,

    // Spawn and density (GAME_DESIGN 9, ARCHITECTURE 12.5).
    densityDefault: 100,
    densityMin: 70,
    densityMax: 120,
    densityPerKm: 11,
    adaptS: 30,
    adaptHigh: 0.45,
    adaptLow: 0.25,
    adaptStep: 0.1,
    laneKmEveryS: 5,
    laneKmMoveM: 60,
    spawnGap: 12,
    spawnEnd: 15,
    spawnStart: 4,
    /** Under this share of the target, the ring and the gap give way, out of sight and inside the despawn line, so that a bubble on thin road fills at all. */
    strandedShare: 0.92,
    strandedMin: 60,
    strandedMax: 375,
    strandedGap: 8,
    spawnPerCall: 12,
    spawnTries: 60,
    spawnGridR: 60,
    /** Share of the ring's width at which a spawn lands, u to this power: 1 is uniform in radius, 0.5 uniform in area. */
    spawnRingPow: 1.6,
    /** No car appears this close behind a stopped one. */
    spawnQueueM: 60,
    /** Above this stationary share, cars appear heading away from the player, and the jam at the centre of the bubble drains. */
    spawnOutShare: 0.22,
    /** Short of this share of the target, that rule gives way to filling the bubble. */
    spawnShort: 0.92,
    /** With the bubble full, this many unseen cars a call leave the shell past bubbleSpawnMax for the ring. */
    spawnRecycle: 2,
    /** Only a player moving faster than this leaves cars behind. */
    spawnRecycleV: 3,
    /** Share of tries spent on the road ahead of the player. */
    spawnAhead: 0.35,
    spawnAheadWalk: 12,
    prewarmMin: 20,
    prewarmTicks: 300,
    prewarmTries: 6000,
    /** The tutorial's road (WP-TRAFFIC report): cars ahead on it stand this far apart at the start, and a walk redraws this often rather than turn onto it. */
    calmGapM: 30,
    calmRedraws: 3,
    stationaryV: 0.5,

    // Deadlock ladder (ARCHITECTURE 12.5).
    stuckV: 0.3,
    deadEndS: 3,
    l2S: 5,
    watchdogS: 60,
    /** A car the early eye has held this long, not at a red, is locked against another body. */
    softLockS: 10,
    watchdogCycles: 1.3,
    l4Share: 0.3,
    l4StuckS: 30,
    l4Clear: 6,
    /** Over tidyShare stationary, this many cars a call that have stood tidyS out of sight give way to ones that drive. */
    tidyShare: 0.27,
    tidyS: 12,
    tidyClear: 1,
    pullOverS: 1.2,
    pullOverMaxS: 14,
    /** A car that cannot leave the lane's width stands aside this long before it goes, in view or not. */
    pullOverStuckS: 6,
    pullOverPad: 0.2,

    // Soak invariants.
    orderSlack: 0.1,
    /** A car further than this off its lane's centre is beside the queue, not in it. */
    lineLat: 0.4,
    laneBoundPad: 1,
    stuckPad: 5
  };
})(window.TLV);
