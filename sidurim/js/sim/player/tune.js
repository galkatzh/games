// js/sim/player/tune.js — WP-PLAYER
// Handling, contact and on-foot numbers (GAME_DESIGN 4, 8 and 15.2), plus the package's own [T] values.
(function (TLV) {
  'use strict';

  TLV.tune.player = {
    // Shared keys (ARCHITECTURE 12.1.9).
    brake: 14,
    topSpeed: 26.4,
    footSpeed: 6.4,

    // Longitudinal (GAME_DESIGN 4).
    reverseSpeed: 6,
    accelBase: 7.5,
    accelFadeV: 29,
    coastDrag: 0.8,
    reverseAccel: 4,
    /** Brake held at a standstill this long before it turns into reverse, so stopping never shoots the car backward. */
    reverseDelayS: 0.25,
    /** Speed at which a held brake or handbrake counts as stopped. */
    restSpeed: 0.3,

    // Steering (GAME_DESIGN 4).
    steerMaxDeg: 34,
    steerMinDeg: 6,
    steerRefSpeed: 26,
    steerExp: 0.7,
    steerAttackS: 0.12,
    steerReturnS: 0.08,

    // Grip (GAME_DESIGN 4).
    gripLat: 11,
    velLerp: 9,
    velLerpHandbrake: 2.2,

    // Handbrake (GAME_DESIGN 4).
    handbrakeYaw: 2.2,
    handbrakeDrag: 2,
    handbrakeRecoveryS: 0.25,
    /** Full handbrake yaw is reached by this speed. Under it the rear has nothing to swing with. */
    handbrakeYawLowV: 1,
    handbrakeYawFullV: 5,

    // Green Launch (GAME_DESIGN 4 and 19). The first light is 40 m ahead of the spawn, and a queue reaches further.
    launchWindowS: 0.25,
    launchBoost: 0.3,
    launchS: 1.5,
    launchRangeM: 60,
    launchStopV: 1,
    launchThrottle: 0.5,

    // Surfaces and the map edge (GAME_DESIGN 4, ARCHITECTURE 12.4).
    capSidewalk: 14,
    capSand: 8,
    capEdge: 8,
    edgeBandM: 30,
    /** Over a cap the car sheds speed this fast. 12 m/s² takes top speed to 8 m/s inside the 30 m edge band. */
    capDecel: 12,
    /** A surface must hold this long to count: junctions have 1 m gaps in the road mask between connectors. */
    surfaceHoldS: 0.12,
    waterEventS: 5,
    /** How far back along the wall normal the water edge may step per tick, and in what steps. */
    waterBackM: 1.6,
    waterStepM: 0.1,

    // Lanes (ARCHITECTURE 10.5).
    laneReachM: 6,
    wrongWayOnDeg: 100,
    wrongWayOffDeg: 80,
    wrongWayMinV: 1.5,
    wrongWayHoldS: 0.4,
    /** The stop line watch arms this far before a lane's end. Top speed covers 0.44 m per tick. */
    stopLineWatchM: 8,
    stopLineLatPad: 1.5,
    stopLineArmDeg: 50,
    stopLineHoldS: 4,

    // Horn (ARCHITECTURE 11).
    hornRepeatS: 1,

    // Contact severity (GAME_DESIGN 8.1).
    contactMinVn: 0.5,
    bumpVn: 3,
    crashVn: 9,
    bodyGuardS: 0.5,
    /** A car back on a body inside this long, at a scrape's speed and inside this many metres of where it last touched, never left it. */
    pressRockS: 2.5,
    pressRoomM: 2.5,

    // Wall response (GAME_DESIGN 4).
    glanceDeg: 30,
    glanceKeep: 0.85,
    /** Tangential share kept by a square hit. Between the two it blends with the angle. */
    squareKeep: 0.6,
    restitution: 0.3,
    wallAlignRate: 4,
    wallPivotRate: 1.2,
    wallAlignMaxDeg: 75,
    yawKickPerVn: 0.012,
    yawKickMax: 0.3,
    /** Contact solver passes per tick. */
    solverIterations: 4,
    solverSkin: 0.001,
    /** Pad on the collider search radius. */
    searchPad: 0.7,
    /** A kerb is touched at this distance. */
    kerbTouchM: 0,

    // Car to car (GAME_DESIGN 8.1).
    carRestitution: 0.2,
    mass: { hatch: 1, sedan: 1.15, taxi: 1.15, van: 1.6, bus: 7, truck: 4.5 },
    rearDot: 0.6,
    rearSteerShare: 0.25,
    rearYawRate: 0.5,

    // Near miss (GAME_DESIGN 8.2).
    nearMissGap: 0.9,
    hairGap: 0.45,
    nearMissSpeed: 6,
    nearMissCooldownS: 2,
    /** Search radius: half a bus, half the car and the gap. */
    nearScanM: 10,

    // People.
    /** Under this the car is not moving, so a person meeting it brushes it. */
    hitMinSpeed: 0.5,
    /** One contact is one hit, however long it lasts. A new one needs this long apart. */
    pedClearS: 1,

    // On foot (GAME_DESIGN 15.2 and 16).
    footRadius: 0.35,
    footAccel: 60,
    footTurnRate: 16,
    sidestepM: 2,
    sidestepS: 0.3,
    sidestepCooldownS: 1,
    stumbleS: 0.5,
    invulnerableS: 1.5,
    brushSlowS: 0.4,
    brushSpeedScale: 0.5,
    brushGuardS: 1,
    /** Search for clear ground when a point is inside something, metres. */
    escapeStepM: 0.5,
    escapeMaxM: 30,
    escapeAngles: 16,

    // Bots.
    /** A car going less than pinnedShare of the speed it reports, over pinnedV, for pinnedS, is held fast. */
    pinnedV: 1,
    pinnedShare: 0.3,
    pinnedS: 0.4,

    bot: {
      lookBase: 2.5,
      lookPerV: 0.35,
      lookMin: 3.5,
      lookMax: 14,
      laneSpeedShare: 1,
      cornerLat: 3,
      cornerSpanM: 3.5,
      cornerBrake: 4,
      cornerFloor: 2.5,
      steerMargin: 0.85,
      wallClearM: 0.45,
      wallSpread: 3,
      tightClearM: 0.15,
      tightSpeed: 5,
      speedGain: 2.5,
      stopBrake: 5,
      stopMargin: 2.6,
      amberClearM: 1,
      followBrake: 6,
      followGap: 3,
      scanTicks: 3,
      scanMin: 20,
      scanPerV: 3,
      scanMax: 70,
      corridorPad: 0.3,
      personPad: 0.5,
      predictStepS: 0.6,
      predictSteps: 3,
      /** Cosine of the angle within which a car behind counts as going the same way. */
      behindSame: 0.5,
      arrivalWindowM: 9,
      personIntentV: 1.3,
      routeOffM: 10,
      replanM: 25,
      replanPerV: 2.5,
      targetMinM: 150,
      targetTries: 24,
      targetMinLen: 25,
      stuckMoveM: 1.5,
      stuckS: 4,
      queueStuckS: 45,
      queueGapM: 12,
      signalHoldM: 60,
      reverseS: 1.6,
      reversePerTry: 0.6,
      reverseMaxS: 3.5,
      escapeTries: 4,
      escapedM: 25,
      recoverStuckS: 75,
      recoverHoldS: 2,
      reactionS: 0.9,
      reactionHotS: 0.7,
      brakerPad: 3,
      brakerRange: 2,
      chaosHoldMinS: 0.4,
      chaosHoldMaxS: 2,
      chaosTeleportMinS: 12,
      chaosTeleportMaxS: 40,
      parkLookM: 3.5,
      parkApproachM: 24,
      parkApproachV: 5,
      parkDiveA: -3.2,
      parkDiveL: 0.8,
      parkStopA: 1.6,
      parkAlignRad: 0.6,
      parkAlignL: 7,
      parkArmedBrake: 1,
      parkRetryS: 14,
      doubleParkDoorM: 140,
      doubleParkFinaleM: 35,
      finaleIndex: 6,
      tugPressS: 1,
      footProbeM: 8,
      footStuckS: 1.2
    }
  };
})(window.TLV);
