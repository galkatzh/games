// js/sim/peds/tune.js — WP-PEDS
// Every number in the pedestrian package. Values from GAME_DESIGN 10 and ARCHITECTURE 12.6 keep the design's names where it
// has them. The rest are this package's own, and are private to it, except intentS (ARCHITECTURE 12.1.9).
(function (TLV) {
  'use strict';

  TLV.tune.peds = {
    /** Shared key. A person shows intent at least this long before stepping out. */
    intentS: 0.8,

    // Population: 40-60 active within bubbleM of the player.
    bubbleM: 120,
    bubbleMin: 40,
    bubbleMax: 60,
    /** The disc is steered to this count, a little inside the band so a turn into a thin street stays in it. */
    bubbleAim: 50,
    /** The ring beyond the disc, kept filled so people are already there when the player drives toward them. */
    outerAim: 30,
    /** Below this, someone new may appear in view, far off, if nowhere hidden is left. */
    bubbleLow: 47,
    /** Above this, unseen people inside the disc are recycled. */
    bubbleTrim: 57,
    /** Slots the ambient crowd leaves free, for staged actors, passengers and savers. */
    ambientCap: 86,
    spawnOuterM: 160,
    despawnM: 178,
    /** Nobody appears nearer than this, and nobody in view nearer than spawnSeenM. */
    spawnMinM: 62,
    spawnSeenM: 100,
    /** Short of people with nowhere hidden to put them, someone may appear this far off, in view. */
    spawnFarM: 85,
    spawnFarTries: 3,
    /** Filling the bubble from nothing, after a start or a teleport, may place people this close. */
    fillMinM: 14,
    /** Focus moving this far between two maintain calls is a teleport. */
    jumpM: 45,
    spawnPerCall: 4,
    spawnTries: 10,
    /** A random point must land this close to a sidewalk. */
    spawnSnapM: 30,
    /** Maintain runs every this many ticks, in its own bucket (ARCHITECTURE 9.2). */
    maintainTicks: 15,
    maintainPhase: 7,
    /** Stalls, rows and crossing lines read ahead of need, each tick, until the map is done. About 25 sim-seconds on tlv_center. */
    warmPerTick: 10,
    warmKerbsPerTick: 100,
    /** A link this near a lane's edge counts as on the lane: a body and its mirrors reach past the line a car follows (WP-PEDS report). */
    linkLanePadM: 0.6,
    /** Nobody steps out on a road further than this from the player, and anyone unseen still on one past roadKeepM goes. Traffic spawns from 140 m. */
    roadOutM: 125,
    roadKeepM: 136,
    /** A free run of sidewalk shorter than this is not a place to put someone. */
    spawnRunM: 8,

    // Who the crowd is: kind, weight.
    mix: [['walker', 64], ['phone', 17], ['trolley', 4], ['scooter', 8], ['delivery', 7]],

    // Speeds, m/s (GAME_DESIGN 10).
    walkMin: 1.1,
    walkMax: 1.5,
    phoneScale: 0.85,
    trolleyScale: 0.75,
    crossLegal: 1.3,
    crossSlow: 0.6,
    /** Slow crossers on a wide road speed up just enough to be off it in time. */
    slowCrossMaxS: 18,
    redCross: 1.5,
    hurry: 2.2,
    hop: 2.6,
    flee: 2.8,
    approach: 1.8,
    inspector: 1.7,
    scooterMin: 6,
    scooterMax: 7,
    deliveryMin: 6,
    deliveryMax: 9,
    /** Riders go to the kerb and back to a sidewalk at this speed. */
    riderApproach: 4,

    // Radii (ARCHITECTURE 10.4).
    walkerR: 0.35,
    riderR: 0.6,

    // Row walking.
    /** Sideways spread on a ribbon, metres either side. Kept small: ribbons run close to walls and kerbs. */
    latMax: 0.4,
    /** A sample every this many metres when a row is read against walls, stalls and lanes. */
    rowStepM: 1,
    /** Walkers turn this far before something blocking their row. */
    spanBackM: 0.5,
    /** A body may brush a parked car's side by r minus this before the row counts as blocked. */
    stallClearM: 0.1,
    /** Stalls are looked up along a row at this spacing and radius. */
    stallQueryM: 10,
    /** Turning round this many times inside flipWindowS marks someone to recycle when unseen. */
    flipMax: 3,
    flipWindowS: 40,
    /** A corner link's detour may add at most this much. */
    linkDetourM: 25,
    /** A link this close to a connector's centreline stands where a truck turns, and is walked as a crossing. */
    linkConnM: 1.6,
    /** Conflict points are read this far apart along such a link. */
    linkStepM: 3,
    /** Walkers wait for such a link up to this far back along the row, out of the way of turning cars. */
    linkBackM: 8,
    /** A car turning end for end at a dead end sweeps a circle this far round its connector: half a sedan, its corner, and a body. */
    uTurnSweepM: 3.4,
    /** A lane turning more than this at one vertex is a car turning end for end. */
    kinkRad: 1.9,
    /** Someone at such a link turns back if no gap comes in this long. */
    linkWaitS: 8,

    // Crossings.
    /** A walker reaching a crossing uses it with this chance. */
    crossP: 0.85,
    /** No new crossing decision for this long after one. */
    crossCoolS: 8,
    /** GAME_DESIGN 10. */
    slowP: 0.12,
    redP: 0.15,
    waitMaxS: 25,
    /** After waitMaxS at a red, this share cross on the red and the rest walk on. */
    redAfterWaitP: 0.5,
    /** A waiter rolled to cross on red goes between these, once there is a gap. */
    redDelayMin: 1,
    redDelayMax: 7,
    /** A staged or jaywalking person gives up if no gap comes in this long. */
    cmdWaitS: 6,
    jayWaitS: 5,
    /** Waiting spots keep this far from a connector's centreline, to stay out of the sweep of a turning car and of a rider's reach. */
    waitClearM: 1.85,
    /** How far from the kerb a crowd of waiters spreads back, and along it. */
    queueBackM: 1.1,
    queueSideM: 0.9,
    /** Gate re-checks per second for someone waiting. */
    gatePeriodS: 0.25,
    /** The zone is the crossing, so a lane this close before its stop line has a queued car standing on the zone. */
    stopShiftM: 4.6,
    /** The walking line stands this far past such a stop line, clear of the nose of a waiting car. */
    lineClearM: 0.7,
    /** Inside a zone, a person keeps this far from its long edges. */
    zoneInsetM: 0.5,
    /** Landing point on a sidewalk, at most this far from the kerb point. */
    landMaxM: 12,
    /** A crossing path longer than this is not a crossing. */
    pathMaxM: 44,
    /** A carriageway one side of a median looks for the other carriageway's crossing within this distance, kerb to kerb. */
    medianM: 16,

    // Fairness gate (GAME_DESIGN 10, ARCHITECTURE 12.6).
    /** Player TTC to the conflict point, seconds. */
    ttcStartS: 1.5,
    /** AI: no step-out within v * v / gateDecel + gateBaseM of the conflict point. */
    gateDecel: 16,
    gateBaseM: 3,
    /** A vehicle slower than this counts as stopped. */
    stoppedV: 0.3,
    /** A moving vehicle further than this to the side of its own line is not coming to the point, unless its lane leads there. */
    gateLateralM: 3.5,
    /** Vehicles are looked for this far past the conflict points. Reach at top speed plus some. */
    gateRangeM: 48,
    /** Hop-back, ambient walkers only. */
    hopTtcS: 1,
    /** TTC is also read where the person will be this soon. */
    hopLookS: 0.6,
    /** A vehicle this far off to the side of the body is passing, not coming. */
    hopLateralM: 0.25,
    /** Vehicle scan radius on a walk and on the road, metres. A bus's body reaches 6 m from the centre the scan reads. */
    scanWalkM: 8.5,
    scanRoadM: 22,
    /** People keep this clear of a vehicle's body. */
    bodyClearM: 0.12,
    /** Nobody appears nearer than this to a vehicle's body. */
    spawnClearM: 1.5,
    /** Whatever else moves them, a body stays this far off a vehicle's. */
    bodyEaseM: 0.04,
    /** And this much more for a moving one, or what it has moved by the next think. */
    bodyLeadM: 0.7,
    /** Vehicles are read this far ahead, and someone where one is about to be steps aside at flee speed. */
    bodyLookS: 0.6,
    /** Back to the row after that, m/s, and never further from it than this: stepping aside must not walk anyone out into the road. */
    easeBack: 1,
    strayMaxM: 1.5,
    /** Someone moved this far off their row by a vehicle counts as in the road, so that car brakes for them. */
    pushedM: 0.2,

    // Zone dwell (ARCHITECTURE 12.6).
    dwellMaxS: 25,
    /** A zone held this long admits nobody new, and stays shut for dwellHoldS after. */
    dwellGateS: 14,
    dwellHoldS: 6,
    /** A zone held this long makes everyone on it hurry. */
    dwellHurryS: 18,
    /** A zone held this long makes anyone on it stop giving way to stationary bodies. */
    dwellForceS: 22.5,
    /** Whoever is still to clear a zone does both of those earlier, once the walk off at hurry speed would end this long before dwellMaxS. */
    dwellSpareS: 0.5,

    // Jaywalking, per walker near a road (GAME_DESIGN 10).
    jayPerMin: 0.03,
    /** Mid-block means this far from a row's ends and from any crossing. */
    jayEndM: 12,
    jayXingM: 8,
    /** Tried along the kerb, for a gap between parked cars. */
    jayShifts: [0, 1.5, -1.5, 3, -3, 4.5, -4.5],

    // Strolling down the road (GAME_DESIGN 10).
    strollP: 0.02,
    strollMinM: 14,
    strollMaxM: 34,
    /** Keeps this far inside the lane's edge. */
    strollEdgeM: 0.55,
    /** A vehicle this close on the lane makes a stroller move aside. */
    strollWarnM: 15,
    asideSpeed: 0.5,
    strollSpeed: 0.8,

    // Getting out of a car on the traffic side.
    /** A car slower than this may be the one someone just got out of. */
    doorV: 0.5,
    /** Until they step out they are still half in the car, this far inside the line of its side, so an overtaker's 0.6 m clears them. */
    doorHugM: -0.1,
    /** The car has gone once it is this far from where it stopped. */
    homeLeftM: 1.5,

    // Flee, stumble, horn (GAME_DESIGN 6, 10).
    fleeS: 3,
    /** Everyone this close to a crash runs. */
    crashScareM: 25,
    stumbleS: 4,
    stumbleFallS: 0.6,
    stumbleSitS: 3.2,
    knockM: 1.2,
    knockS: 0.35,
    hornFreezeS: 1.5,
    hornM: 16,
    hornDeg: 60,
    brushS: 0.6,
    bubbleS: 1.5,

    // Two-wheelers.
    bellEveryS: 5,
    bellNearM: 30,
    /** Ambient riders pop off the kerb at a crossing with this chance. */
    popP: 0.3,
    salmonLeadM: 16,
    salmonMaxS: 14,
    /** A wrong-way rider brakes for an AI vehicle closing inside this. */
    salmonTtcS: 2.4,
    riderBrake: 6,
    /** Keeps to its own right, this far inside the lane's edge. */
    salmonEdgeM: 0.7,

    // Staged actors.
    aimMinWalker: 0.6,
    aimMaxWalker: 2.4,
    aimMinRider: 3,
    /** A commanded person further than this from the place cannot comply. */
    commandReachM: 40,
    /** The longest a staged walker stands in intent waiting for the aim's moment. */
    aimHoldMaxS: 6,
    inspectWriteS: 3,
    /** A free walk that stops getting closer gives up after this long. */
    freeStuckS: 4,
    /** Margin past a lane's half width in which a person off the walk reports as on that lane. */
    laneReachM: 0.2,
    /** Half the length a person blocks on a lane, beyond the body. */
    laneHalfM: 0.3,
    /** A person within this of a junction's connectors reports on the lanes they join. */
    connReachM: 1.4,
    /** Search for junctions this far from a person off the walk, by their lanes, and by the junction's centre. */
    connSearchM: 18,
    connJuncM: 40
  };
})(window.TLV);
