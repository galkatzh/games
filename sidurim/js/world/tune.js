// js/world/tune.js — WP-WORLD
// Every number that shapes the derived world. Names are private to this package, except spotLen and spotWid (ARCHITECTURE
// 12.1.9). A name ending Deg is degrees, which only tune files and content may use.
(function (TLV) {
  'use strict';

  TLV.tune.world = {
    // Shared keys.
    spotLen: 6.5,
    spotWid: 2.4,

    // Lanes (ARCHITECTURE 8.1). trim = clamp(0.5 * maxCarriagewayWidth + trimPad, trimMin, trimMax).
    trimPad: 1.5,
    trimMin: 3,
    trimMax: 14,
    trimMaxShare: 0.45,
    laneMinLen: 3,
    exclusiveCarLen: 4.4,
    exclusivePad: 8.5,
    /** Heading of a road at a junction is read over this much of it, so a tiny last segment cannot decide it. */
    headingSpan: 8,
    /**
     * Lanes of different roads end where their centres stand this far apart: a 1.8 m car beside a 1.8 m car, plus margin. A pair
     * is read this far along each lane from their shared junction, one sample per laneClearStep metres, and two stretches with
     * at most laneClearGap metres between them count as one.
     */
    laneClearM: 2.2,
    laneClearReach: 20,
    laneClearStep: 2,
    laneClearGap: 2,
    /** Arms of a junction further apart than this, read over headingSpan metres, are taken to diverge at once. */
    laneClearArmDeg: 80,

    // Connectors (ARCHITECTURE 8.2).
    ctrlShare: 0.4,
    connSpacing: 1.5,
    /** Connectors whose centres pass closer than this conflict, crossing or not: a 1.8 m car beside a 1.8 m car. */
    connClearM: 1.8,
    /** Two connectors from one lane count as one road until their centres stand this far apart: a bus beside a car. */
    siblingClearM: 2.6,
    /**
     * A queue waits clear of every other approach's connectors. The car tested is a van: the widest body on every street, since
     * buses and trucks keep to wide ones. Steps and limit of the pull-back, and the distance a nose keeps from the line.
     */
    waitBoxLen: 5.2,
    waitBoxWid: 2,
    waitBackStep: 0.5,
    waitBackMax: 9,
    waitPad: 0.6,
    waitSweepStep: 0.75,
    /** Connector samples closer than this, on this many sample pairs, mean two connectors cannot be driven at once. */
    connTouchM: 2.1,
    connTouchHits: 2,
    connShortChord: 0.5,
    connLatAccel: 3.0,
    connMinLen: 0.1,
    connRingScore: 10,
    connClassBase: 6,
    connTurnScore: { S: 2, R: 1, L: 0, U: 0 },
    /** Control lengths tried, as shares of the chord, when the plain cubic runs through a wall. */
    connRetryShares: [[0.6, 0.6], [0.8, 0.8], [0.25, 0.25], [0.8, 0.25], [0.25, 0.8], [1.1, 1.1]],
    /** Sideways bows tried after that, as shares of the chord, on a connector at least connBowMinChord long. */
    connBowShares: [0.1, 0.16, 0.24, 0.32, 0.42, 0.55],
    connBowMinChord: 8,
    /**
     * A chord under connShortChord means lanes that line up only if their headings agree too, read over connKinkSpan metres of
     * each. Two lanes can touch at the point of a V and still turn this many degrees: that is a real connector, not a joint.
     */
    connKinkDeg: 20,
    connKinkSpan: 2,
    /**
     * Where the roads double back by at least connKinkVeeDeg, the point of a V, that junction's lanes stand connKinkTrim metres
     * further back, if the two lanes have connKinkRoom metres between them to give. Ordinary turns pile up at 80 to 100 deg.
     */
    connKinkVeeDeg: 110,
    connKinkTrim: 8,
    connKinkRoom: 1,
    /** Where they cannot, this stands in for the chord when sizing the controls: a lobe of about 3 m past the V. */
    connKinkReach: 12,
    /** A vertex or lane joint that turns more than this makes a connector look for gentler control lengths. */
    connSharpDeg: 55,
    /**
     * The control lengths it tries, as shares of the chord at each end. Pairs of unequal length do most of the work: a long
     * control swings wide on the side that needs room, and a short one stays clear of the cusp the two would otherwise form.
     * Equal short pairs alone leave 47 connectors over 60 deg against 10 with this list, because a short control only moves
     * the kink from the middle of the curve to a lane joint.
     */
    connSmoothShares: [
      [0.35, 0.35], [0.25, 0.25], [0.15, 0.15], [1, 0.3], [0.3, 1], [0.4, 1.6], [1.6, 0.4], [0.1, 1.3], [1.3, 0.1], [0.15, 1],
      [1, 0.15], [0.6, 0.05], [0.05, 0.6], [0.05, 0.4], [0.4, 0.05], [0.8, 1.6], [1.6, 0.8], [1.3, 0.5], [0.5, 1.3], [0.6, 0.2],
      [0.2, 0.6], [1, 1.6], [0.6, 0.15], [1.3, 0.05], [1.6, 0.05], [0.35, 1.3], [0.1, 0.6], [0.05, 0.8], [0.1, 1], [0.6, 1.3],
      [1.3, 0.2], [0.2, 1.3], [0.6, 0.25], [0.3, 0.2]
    ],
    /**
     * Lanes that do not line up across a PASS junction, because the road bends there or changes lane count, are pulled back
     * so a real curve fits: passTrimPerChord metres for each metre of misfit, plus passTrimPad, within the two limits.
     */
    passTrimPerChord: 3,
    passTrimPad: 1,
    passTrimMin: 3,
    passTrimMax: 8,
    /** A turn of at least this at a PASS counts as a misfit, worth passBendPerRad metres per radian. */
    passBendDeg: 20,
    passBendPerRad: 1,

    // Signals (ARCHITECTURE 8.3), by number of vehicle slots.
    signalTimes: [
      null,
      { greenS: 22, amberS: 3, allRedS: 2, pedS: 12 },
      { greenS: 22, amberS: 3, allRedS: 2, pedS: 0 },
      { greenS: 14, amberS: 3, allRedS: 2, pedS: 0 },
      { greenS: 14, amberS: 3, allRedS: 2, pedS: 0 }
    ],
    slotToleranceDeg: 40,
    /** Slots at most, bearings and split crossings together. */
    maxSlots: 4,
    offsetSalt: 77,
    /** A signalled crossing further than this from its junction, by road, is too far to share the light. */
    xingCtrlRangeM: 60,
    /** A crossing must get at least this much walk per cycle, the pedestrian slot of a one-slot light. */
    xingWalkMinS: 12,

    // Zones (ARCHITECTURE 8.4).
    zoneHalf: 1.5,

    // Sidewalks (ARCHITECTURE 8.5).
    swLinkM: 30,
    /** A sidewalk moved off a wall may cross its parking strip, and stops this far from the edge of the lanes. */
    swLaneClear: 0.15,
    /** And it stands this far off the wall it moved from. More reaches further into the line of parked cars and clears no more walls. */
    swWallPad: 0.1,
    /** Steepest sideways move of a sidewalk, metres per metre. Steep, so a walker steps round a wall, past the car beside it. */
    swMaxDrift: 1,
    /** Spacing of the check that keeps a sidewalk off road and out of walls, and the shortest piece worth keeping. */
    swLaneCheckM: 2,
    swMinLen: 4,
    /** That check reads at least this far out from the centreline, and at least swOwnKerbClear past the road's own kerb. */
    swOuterCheck: 0.5,
    swOwnKerbClear: 0.9,
    /** Corner links at least this long are checked against road. */
    swLongLink: 6,

    // Props (ARCHITECTURE 8.6).
    treeResidentialM: 14,
    treeSeafrontM: 18,
    treeMajorM: 22,
    lampM: 30,
    seafrontM: 150,
    realTreeClearM: 6,
    treeRadius: 0.3,
    lampRadius: 0.15,
    /** Along a sidewalk, how far a prop may stray from its slot, as a share of half the spacing. */
    propJitter: 0.5,
    /** Prop distance from the kerb. */
    treeKerbM: 0.9,
    lampKerbM: 0.6,
    propClearXingM: 2.5,
    propClearDoorM: 2,
    propClearStopM: 3,

    // Surface (ARCHITECTURE 8.6). A raster cell holds a base class and a mask of its 4 x 4 sub-cells that are road.
    surfaceCell: 4,

    // Parking (ARCHITECTURE 8.8).
    spotInset: 1.2,
    /** A parked car stays this far from the edge of any lane or connector, its own road's included. */
    spotLaneClear: 0.1,
    /** And this far from a building's wall. */
    spotWallClear: 0.1,
    /** Cell of the grid over stall candidates. */
    spotGridM: 20,
    spotMaxTier: 3,
    spotsPerKerb: 1024,
    baselineOccupancy: 0.88,
    parkedCarLen: 4.4,
    parkedCarWid: 1.8,
    motoLen: 2.0,
    motoWid: 0.8,
    roadDistanceMax: 400,
    roadDistanceSnapM: 150,

    // Routing (ARCHITECTURE 12.3, 13.3). Weights by road class, primary first.
    routeSignalS: 12,
    routeLeftS: 3,
    /** Cost of a move that can only run through a wall: more than any route on the map, so a route takes it only if forced. */
    routeWalledS: 3600,
    routeSpacing: 3,
    routeSnapM: 40,
    /** Most a target can sit from its edge's polyline, sideways plus trim. It keeps the A* heuristic admissible. */
    routeTargetSlackM: 25,
    classWeights: [5, 4, 3, 1, 1, 0.3, 0.15]
  };
})(window.TLV);
