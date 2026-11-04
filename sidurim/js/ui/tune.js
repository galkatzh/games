// js/ui/tune.js — WP-UI
// Every number the HUD, cards and audio use. Names are private to this package.
(function (TLV) {
  'use strict';

  TLV.tune.ui = {
    // Storage keys. Each read and write is wrapped, because a private window can refuse them.
    keyDifficulty: 'sidurim.difficulty',
    keyLang: 'sidurim.lang',
    keyBest: 'sidurim.best',
    keyMute: 'sidurim.mute',

    // Displayed clock.
    clockTenthsBelowS: 10,

    // First-minute beats (GAME_DESIGN 19). They fire on route distance, not time.
    drivePromptMaxS: 7,
    drivePromptMoveV: 3,
    launchPromptS: 2.6,
    launchPromptMaxTravelM: 40,
    handbrakePromptAtM: 18,
    handbrakePromptS: 3.2,
    /** The SEARCH line shows inside this much route, on every errand, and only on a moving car. Overrides GAME_DESIGN 19 on purpose. */
    searchPromptLeftM: 60,
    searchPromptMoveV: 1,
    /** The arming speed, 7 m/s, shown as 25 km/h. */
    searchFlashV: 7,
    oneShotS: 4.2,
    /** Seconds of throttle or reverse held against something, with the car getting nowhere, before the tow is offered. */
    stuckPromptS: 2.5,
    stuckV: 1,
    /** A car still inside this many metres of where it started trying, having touched something in the last stuckTouchS, is getting nowhere. */
    stuckRoomM: 3,
    stuckTouchS: 2,
    stuckInput: 0.3,
    /** A let-go this long ends the attempt, so a brief change from W to S keeps the count. */
    stuckForgetS: 1.5,

    // Popups.
    popS: 1.5,
    popMax: 4,
    toastS: 3.6,
    toastLongS: 5,
    /** Reroutes come about every 2 s on a wrong-way run. The joke is good once. */
    recalcToastGapS: 30,
    moneyPopMin: 1,
    vignetteS: 0.55,
    barFlashS: 0.5,
    whiteFlashS: 0.28,

    // Chevrons on incident telegraphs.
    chevronS: 2,
    chevronMax: 4,
    /** Ring the chevrons sit on, as a share of the viewport, centred on the car. */
    chevronRx: 0.34,
    chevronRy: 0.30,
    chevronCy: 0.58,
    /** A chevron dead ahead stands this far to the side of the arrow. */
    chevronArrowClearEm: 8,

    // The bay line (hud.parkKey). BRAKE shows with this much time left to act, plus the braking distance, plus a spare gap. Obeying it stops
    // the car, and stopping locks the pose, so a line that comes early buys a crooked park: on 40 bays with a 0.3 s reaction, 0.6 and 0.5
    // left a careful driver GOOD or better on 32-45%. The owner's rule: an obedient driver at 1.4 and 2.2 m/s reaches 70%, then the fewest
    // contacts. 0.4 and 0.1 give 97.5% and 87.5%, and the same bays stay UGLY with no line at all. The time just covers the driver's own
    // reaction, the gap is small: slow cars hear it late, and at 3 m/s it still takes bays with a contact from 27 to 3.
    armReactS: 0.4,
    armRoomSpareM: 0.1,
    /** Added to each side of the car, for what it may hit. */
    armRoomSideM: 0.1,
    armRoomScanM: 16,

    // The way to the door on foot (hud.js). A cell is small enough that the 2 m between two parked cars, less a body, still holds a path.
    footCellM: 0.8,
    /** Ground kept round the runner and the door, enough to go round a long block. */
    footPadM: 100,
    /** Water is looked up on this coarser grid: reading the surface is the slow part of laying the ground out. */
    footWaterCells: 3,
    /** The field stops this far past the runner, which still covers a wrong turn. */
    footBeyondM: 40,
    /** Standing cars move on, so the field is refreshed this often. */
    footRefreshS: 1,
    footStillV: 1.5,
    /** Standing cars count against the straight line only this close to the runner. Further off they have time to go. */
    footCarsNearM: 14,
    footPathMaxCells: 900,
    /** The aim is the last point in clear sight along the way, read until this many cells in a row are not, and never closer than this. */
    footAimMisses: 6,
    footAimMinCells: 2,
    /** Standing cars further than this from the runner say nothing about the next corner, and are left out of the sight lines. */
    footBoxesM: 75,
    footTagZ: 1.4,
    /** The ring the tag stands on off screen, as a share of the viewport, and the band it keeps to on screen. */
    footRimX: 0.4,
    footRimY: 0.22,
    footRimCy: 0.5,
    footTagTop: 0.3,
    footTagBottom: 0.72,

    /** Seconds of lost WebGL context before the screen stops promising and suggests a reload. */
    lostReloadS: 8,

    /** Drawn frames after C before asking whether the view changed. */
    cameraCheckFrames: 2,

    // Screen-space tags.
    rivalTagZ: 2.3,
    bayTagZ: 1.2,
    doorTagZ: 3,
    doorTagMaxM: 320,
    /** The chase view shows the bay tag inside this much route. Beyond it the bay is a speck, and the tag only stacks on the arrow. */
    bayTagMaxM: 90,
    /** The space the arrow and its distance take in the chase view, for tags to stay out of. */
    arrowHalfWEm: 4.5,
    arrowTopEm: 9,
    arrowBottomEm: 19.5,
    /** The errand chip, and the half sizes of the tags, for the same sums. */
    chipHalfWEm: 13.7,
    bayHalfWEm: 1.6,
    bayPinHalfWEm: 2.3,
    bayPinHalfHEm: 1.2,
    doorHalfWEm: 4.5,
    doorHalfHEm: 1.2,
    /** Tags keep this gap between each other. */
    tagGapEm: 0.3,
    /** Where the bay tag pins, as the top of the tag: under the shrunk clock in the parking view, else under a two-line errand chip. */
    tagPinTopParkEm: 3.7,
    tagPinTopChipEm: 9,
    /** Height of the bay tag above its point. Higher than this and it pins, so it comes down onto the bay without a jump. */
    tagBayHeightEm: 2.9,
    /** A pinned tag stays this far from each side, clear of the money and the rear-view strip. */
    tagPinSideEm: 20,
    /** Half size of the rage gauge and its gap to the rival, for the parking view. */
    rageHalfWEm: 5,
    rageHalfHEm: 1.5,
    rageGapEm: 0.5,
    /** The gauge stops this far above the bottom of the screen, clear of the prompt. */
    rageFloorEm: 5,
    /** Pixels the bay must pass the middle of the screen by before the parking-view words change sides. */
    parkSideSlackPx: 40,
    /** The ground the prompt and bar take beside the car: its centre from the middle of the screen, half its width, and its height. */
    parkWordsOffEm: 15,
    parkWordsHalfWEm: 10,
    parkWordsHighEm: 7,

    // Bubbles.
    bubbleMax: 16,
    bubbleVehZ: 2.1,
    bubblePedZ: 2.2,
    bubbleTtlMaxS: 6,

    // Minimap.
    mapBasePxPerM: 0.5,
    mapRadiusSlowM: 170,
    mapRadiusFastM: 280,
    mapZoomSpeed: 20,
    mapRouteStepM: 6,
    mapRouteMaxM: 900,
    mapFootStepCells: 4,
    mapMarkerInset: 0.09,
    /** Road stroke in bitmap pixels, by edge class. */
    mapRoadPx: [5.5, 4.5, 3.6, 2.8, 2.8, 2.2, 1.8],

    // Debug overlay.
    debugLogMax: 8,
    debugRefreshS: 0.25,
    devRefreshS: 2,

    // Audio.
    masterGain: 0.8,
    voicesMax: 28,
    honksPerS: 2,
    honkRangeM: 130,
    engineIdleHz: 58,
    engineSpanHz: 150,
    engineGearStepHz: 0.13,
    /** Gear changes, m/s. The last is above top speed. */
    gears: [0, 7, 13, 19, 30],
    skidSlip: 2.6,
    skidFullSlip: 9,
    signalTickS: 1,
    clockTickS: 1,
    heartMinS: 0.42,
    heartMaxS: 0.95,
    heartNearM: 4,
    heartFarM: 16
  };
})(window.TLV);
