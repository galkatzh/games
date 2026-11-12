// js/render/tune.js — WP-RENDER
// City rendering numbers. Actor constants stay at the top of their own actor files.
(function (TLV) {
  'use strict';

  TLV.ns('render');

  TLV.tune.render = {
    // Section 1.5 and 15.3
    chunkM: 400,
    l0M: 150,            // balconies, boilers, AC, tanks, awnings, signs
    l1M: 700,            // chunk shells
    treeM: 350,
    parkedM: 250,
    lampM: 300,
    lodM: 110,           // Nearer cars use the plain mesh
    parkedCastM: 72,     // Nearer ones cast. Facades stop taking shadows here too, and a car this far off has a ground shadow of a few pixels
    rearCarM: 60,        // The rear strip draws parked cars nearer than this. Further back one is 4 pixels wide
    rearAheadM: 15,      // And none further than this ahead of the lens. The list is a few frames old, and the car may be turning
    ficusLodM: 40,       // Nearer trees use the full canopy and cast, from a crown of fewer leaves: 25 of them were 10k triangles at Rothschild
    ficusFarM: 130,      // Beyond this a tree is one lump
    roofM: 110,          // Boilers and tanks: past this no street can see a roof, and they were 17k triangles at Rothschild
    parkedBodyM: 36,     // Nearer parked cars borrow the live body shells
    parkedBodyCap: 12,   // Per body kind. The rest stay plain boxes
    canopyFadeNearM: 1.5,  // Leaves are gone this close to the lens
    canopyFadeFarM: 4.5,   // and whole from here
    barrierM: 300,
    signM: 200,
    skylineMinH: 30,
    residentExtraM: 500, // Chunks this far past L1 drop their vertex buffers
    fineDetailM: 300,    // Chunks past this skip curbs, stall ticks and garden walls: all under a pixel there

    // Budgets
    sliceMs: 4,          // Phase 3, per frame
    sliceGuardMs: 1.2,   // No step starts this close to the end of the slice
    sliceHeavyMs: 2,     // Nor does one a build marks as big, this close: a stall query, a mesh
    bakesPerFrame: 4,
    detailPoolsPerFrame: 2,
    assetInFlight: 2,
    storefrontLoadM: 250,
    landmarkLoadM: 1000,

    // Pool caps, section 15.3
    pools: {
      balcony: 6000, ac: 3000, boiler: 1500, tank: 400, awning: 512,
      ficus: 2500, palm: 800, parked: 1500, lamp: 800, sign: 256, photo: 32, barrier: 96, shelter: 64, kiosk: 24, bench: 96,
      umbrella: 220, lounger: 440, parkedRear: 256
    },

    // Camera requirement. camera.js owns the object; the scene needs this much range.
    cameraFar: 9000,
    cameraNear: 0.3,

    // Atlas, section 15.3
    atlasSize: 2048,
    signSlotW: 256,
    signSlotH: 64,
    photoSlotW: 512,
    photoSlotH: 256,

    // Facade array, section 15.3
    facadeSize: 256,
    facadeLayers: 32,

    // Sun mask
    maskMPerPx: 2.5,
    maskBatch: 240,

    // Quality presets. With no quality asked for, a software GPU starts on low and any other on high, and the ladder takes over.
    quality: {
      low: { pixelRatio: 0.75, shadow: 0, l1M: 500, antialias: false },
      med: { pixelRatio: 1, shadow: 1024, l1M: 600, antialias: true },
      high: { pixelRatio: 1, shadow: 1024, l1M: 700, antialias: true }
    },
    softwareGpu: /swiftshader|llvmpipe|softpipe|software|basic render/i,

    // The ladder: dynamic resolution. Frame times are read in windows, so one long frame moves nothing.
    dynResMs: 26,        // A window's mean above this goes down a rung
    dynResHoldS: 2,      // Length of a window
    dynResGraceS: 4,     // Shader compiles and first uploads are not the player's frame rate
    dynResClampS: 0.25,  // The most one frame counts for, so a tab coming back is not a slow spell
    dynResMin: 0.6,      // Bottom rung, as a pixel ratio
    dynResStep: 0.85,    // The most one rung may take off the pixel ratio
    dynResRoom: 0.95,    // Going up, the predicted frame must fit this share of dynResMs
    dynResUpWaitS: 8,    // Calm for this long before going up a rung
    dynResUpWaitMaxS: 240,
    dynResFailS: 12,     // A rung down this soon after a rung up means the rung up failed, and doubles the wait
    dynResDropWindows: 3, // Slow windows on the bottom rung before shadows and range go too
    dynResFlat: 0.04,    // Two windows this close are the same frame time
    dynResFlatRungs: 3,  // The same across this many rungs, half the pixels, and pixels are not the problem

    // Sun: late afternoon over the sea. Azimuth is a heading, section 1.2: 180 is due west.
    sunAzimuthDeg: 202,
    sunElevationDeg: 28,
    sunIntensity: 3.6,
    sunColor: '#ffcf96',
    hemiSky: '#d9dfe6',
    hemiGround: '#c9ad8c',
    hemiIntensity: 1.7,
    ambient: '#ffe6cc',
    ambientIntensity: 0.45,
    exposure: 1.0,
    shadowHalfM: 62,     // Half extent of the shadow frustum, so it covers 80-100 m along a diagonal
    shadowDepthM: 420,
    shadowFadeM: 72,     // Facade shadows fade out from here to shadowHalfM + 20

    // Display-space colours: three applies fog after tone mapping and sRGB (r159 meshlambert_frag)
    skyZenith: '#74aede',
    skyMid: '#bcd5e8',
    hazeSun: '#f4cf9e',
    hazeAway: '#d8dde0',
    fogNearM: 320,
    fogFarM: 1800,
    fogMax: 0.88,
    seaFogFarM: 7000,
    skylineFogNearM: 900,
    skylineFogFarM: 11000,
    skylineFogMax: 0.62,

    // Ground, sRGB
    colors: {
      base: '#cfc6b4',
      paving: '#cdc3b2',
      pedestrian: '#dfd3bf',
      promenade: '#d6c19c',
      footway: '#c8bda9',
      cycleway: '#a86a5a',
      asphalt: ['#6b6b6f', '#6e6e72', '#717174', '#757578', '#777779', '#7f7d7c', '#7a7879'],
      lot: '#6b6866',
      park: '#7c9a55',
      garden: '#86a35c',
      pitch: '#6c9a4e',
      water: '#3e8aa8',
      seaShallow: '#2fb6b4',
      seaDeep: '#1570ad',
      beach: '#ecd9ae',
      sand: '#e6d2a4',
      plaza: '#e3dccd',
      paint: '#f1efe8',
      kerbGrey: '#b9b4aa',
      outerLand: '#bcae97',
      foam: '#f6f4ec',
      roof: '#d6d0c6',
      soffit: '#8f8a82',
      post: '#d9d3c8',
      canopy: '#efece6'
    },
    curbColours: {
      red_white: ['#ecebe4', '#d3322b'],
      red_yellow: ['#ecc22c', '#d3322b'],
      blue_white: ['#ecebe4', '#2b63ad']
    },
    curbHeightM: 0.14,
    curbTopM: 0.22,
    curbStripeM: 1.0,
    curbFaceShade: 0.62,
    curbTopFall: 0.85,   // Height of the back of a curb's top, as a share of its front
    // A kerb stops where it would lie on another road
    kerbCut: {
      stepM: 0.5,        // Sample spacing along the kerb
      marginM: 0.5,      // A kerb this far inside a road's edge is on that road. Two roads may touch without cutting each other
      minRunM: 1.5       // A shorter piece left between two cuts is dropped
    },
    // The Ayalon, when the content has it. Scenery in the ground pass: see ground.js
    motorway: {
      asphalt: '#5e5e62',
      concrete: '#cbc6ba',
      laneM: 3.5,
      shoulderM: 1.8,
      linkShoulderM: 0.7,
      paintM: 0.16,
      dashM: 12,           // Period; a quarter of it is paint
      barrierM: 0.95,      // High enough to read from the driver's seat, low enough not to fight the camera
      barrierHalfM: 0.25,
      sampleM: 2,          // Spacing of the look for roads that bridge it
      walkM: 4,            // A wall stays this far off a road's kerb, to clear its sidewalk
      parapetSamples: 5,   // Points across a carriageway, so a parapet follows a road at an angle
      bridgeMaxM: 90       // Longer than this is a road alongside, not a road across
    },
    laneLineM: 0.13,
    centreLineM: 0.14,
    stopLineM: 0.5,
    dashM: 6,            // Period; half of it is paint
    stallMarkM: 0.1,
    connectorTolM: 0.35, // Ribbon simplification. Asphalt under asphalt, so the shape can be loose
    // Two buildings walling one plane: one owner per stretch
    sharedWall: {
      dot: 0.9994,       // Cosine: same facing, within 2 degrees
      offM: 0.12,        // Further apart than this, the front one simply wins, even at the far end of a chunk
      minM: 0.3,         // Shorter overlaps are not a wall
      sliverM: 0.25      // What a cut would leave at a wall's end, or between two cuts, goes with it
    },
    // Between sidewalk and building
    frontage: {
      reachM: 20,        // A wall further than this from any sidewalk has no forecourt
      wallMinM: 3,       // Shorter walls get nothing
      overlapM: 1.2,     // A forecourt runs this far past each end of its wall, so neighbours join up
      gardenMinM: 0.8,   // Less room than this is left bare
      gardenMaxM: 5,
      pathM: 1.6,        // The way in, across a front garden
      pathMinLenM: 10,
      lowWallM: 0.55,
      lowWallTopM: 0.2,
      lowWallStepM: 1.5, // A garden wall is read in steps this long. A sidewalk corner can hide between longer ones
      lowWallMinM: 3,    // A shorter piece is a stub, and stands alone
      bedProbeM: 0.6     // A step needs a bed this far behind the wall's line
    },
    // Street clutter. Drawn as one batch. Nothing here is solid and nothing goes to the sim
    clutter: {
      rangeM: 95,        // Radius of the batch
      moveM: 6,          // It is rewritten when the focus has moved this far
      overhangM: 70,     // How far a record can stand from the chunk of its building
      capVerts: 21000,   // 7,000 triangles
      minWallM: 4,
      slotM: 5.5,        // A candidate along a shop wall every so often
      spaceM: 2.2,       // Clear of a cafe table
      rowM: 0.95,        // Between scooters in a row
      walkPadM: 0.1,     // Past the walkers' own width
      kerbPadM: 0.3,     // Off the road, past the item's radius
      propPadM: 0.4,     // Off a tree or a lamp
      xingWideM: 3.5,    // Half the width kept clear along the road at a crossing
      xingReachM: 2.5,   // The approach to a crossing, past the sidewalk
      cafeDepthM: 1.45,
      cafePitchM: 2.6,
      cafeTwoM: 5,       // A shop this wide gets two tables
      cornerBackM: 3.4,  // Stood back from a junction along the row
      cornerReachM: 34,
      signOffM: 1.0,
      signsPerJunction: 2,
      cornerBinEvery: 3,
      beachStepM: 13,
      beachKeep: 96,     // Of 255: the share of beach lattice points with a set
      beachClearM: 9,
      beachM: 240,       // Pool range
      foodKinds: ['cafe', 'restaurant', 'fast_food', 'bar', 'pub', 'ice_cream', 'bakery'],
      mix: [['none', 3], ['scooter', 3], ['e_scooter', 2], ['bike_rack', 2], ['bin', 2], ['elec_box', 1]],
      radius: { cafe_set: 1.0, cafe_shade: 0.1, bin: 0.42, bike_rack: 0.85, scooter: 0.85, e_scooter: 0.55, elec_box: 0.5, street_sign: 0.08 },
      depth: { bin: 0.55, bike_rack: 1.1, scooter: 1.05, e_scooter: 0.8, elec_box: 0.33 },
      height: { cafe_set: 0.8, cafe_shade: 0, bin: 1.0, bike_rack: 0.9, scooter: 1.1, e_scooter: 1.0, elec_box: 1.4, street_sign: 0 },
      binTints: [0x4d524e, 0x4d524e, 0xd7762e, 0x56606b],
      scooterTints: [0xd8d3c7, 0x3f4650, 0xb5362c, 0x2f5a88],
      shadeTints: [0xf2ece0, 0xb5362c, 0x2f5a88, 0xd99a2b],
      shadow: 0xa39a8a
    },
    // Gaps between parallel carriageways
    median: {
      stepM: 5,          // Samples along the road
      maxGapM: 10,       // Wider gaps stay as they are
      asphaltM: 1.5,     // Narrower gaps close with asphalt and a painted divider
      settleM: 20,       // That choice averages the gap over this far either way
      bedM: 1.6,         // A median with this much clear of its sidewalks gets a planted middle
      kerbM: 0.5,        // Paving left either side of the planting
      dividerM: 0.3,
      parallel: 0.92     // Cosine: two roads this close to parallel face each other
    },
    // Long lawns between two carriageways, the Rothschild form
    strip: {
      minGapM: 6,
      maxGapM: 34,
      minRunM: 60,       // Shorter stretches keep their lawn
      walkShare: 0.38,   // Of the strip's width
      walkMinM: 2.4,
      walkMaxM: 5,
      treeM: 9,          // Spacing along each row
      treeOffM: 1.1,     // Row, from the walkway's edge
      treeScale: 1.18,
      benchM: 22,
      benchOffM: 0.4,
      kioskEndM: 11,     // From the cross street
      kioskOffM: 1.7,
      kioskClearM: 4.5
    },
    pathWidthM: [16, 2.6, 2.2],   // By PathLine.cls
    shoreBandM: 150,
    foamM: 3,

    // Buildings
    groundM: 3.6,
    corniceM: 0.5,
    tintMin: 0.9,        // Lightness of one building against its palette entry
    tintMax: 1.03,
    tintWarm: 0.14,      // How far its blue moves, either way
    bayMinFraction: 0.6,
    defaultFloorsMin: 3,
    defaultFloorsSpan: 3,
    liftBaseM: 5.5,      // Raised base of a NO_COLLIDER row with a lane through it
    liftDeckM: 3.1,      // A lifted row with no height of its own is one storey of deck
    liftPostM: 0.28,     // Half width of a post
    liftPostSpacingM: 11,
    laneClearM: 2.4,     // A post stands this far from any lane centre
    canopyZM: 5.0,
    canopyMaxZM: 12.4,
    canopySlabM: 0.32,
    canopyPostSpacingM: 9,

    // Road closed. PORTAL junctions only (section 15.3)
    closedText: { he: 'הכביש סגור מאז ומעולם', en: 'Road closed since forever.' },
    portalInsetM: 6,

    // Kind labels, the fourth rung of the storefront ladder (section 14.3)
    kindLabels: {
      convenience: ['מכולת', 'Mini market'],
      supermarket: ['סופרמרקט', 'Supermarket'],
      laundry: ['מכבסה', 'Laundry'],
      dry_cleaning: ['ניקוי יבש', 'Dry cleaning'],
      bank: ['בנק', 'Bank'],
      pharmacy: ['בית מרקחת', 'Pharmacy'],
      bakery: ['מאפייה', 'Bakery'],
      hairdresser: ['מספרה', 'Hairdresser'],
      greengrocer: ['ירקן', 'Greengrocer'],
      butcher: ['אטליז', 'Butcher'],
      ice_cream: ['גלידרייה', 'Ice cream'],
      post_office: ['דואר', 'Post office'],
      fuel: ['תחנת דלק', 'Fuel'],
      restaurant: ['מסעדה', 'Restaurant'],
      cafe: ['בית קפה', 'Café'],
      fast_food: ['אוכל מהיר', 'Fast food'],
      bar: ['בר', 'Bar'],
      pub: ['פאב', 'Pub'],
      clothes: ['בגדים', 'Clothes'],
      hotel: ['מלון', 'Hotel'],
      kiosk: ['קיוסק', 'Kiosk'],
      shop: ['חנות', 'Shop'],
      atm: ['כספומט', 'ATM'],
      clinic: ['מרפאה', 'Clinic'],
      dentist: ['רופא שיניים', 'Dentist'],
      museum: ['מוזיאון', 'Museum'],
      theatre: ['תיאטרון', 'Theatre'],
      cinema: ['קולנוע', 'Cinema'],
      gallery: ['גלריה', 'Gallery'],
      library: ['ספרייה', 'Library'],
      mall: ['קניון', 'Mall'],
      marketplace: ['שוק', 'Market'],
      office: ['משרדים', 'Offices']
    },

    // Packed 0xRRGGBB
    treeTints: [0xffffff, 0xf4fbe8, 0xe9f3da, 0xfff6d8, 0xdfeecf, 0xf8f0d0, 0xe4f0e0, 0xfdf8e4],
    parkedPalette: [0xf0eee9, 0x4a4d54, 0xb5b9be, 0x4f6d96, 0xb0403a, 0xe2ddd0, 0x7a8894, 0xd0d4d8],
    // Paint by the body a stall's car comes alive as, so it keeps its colour when it pulls out. Same order as the live palettes.
    parkedPaint: {
      sedan: [0xf0eee9, 0x4a4d54, 0xb5b9be, 0x4f6d96, 0xb0403a, 0xe2ddd0, 0x7a8894, 0xd0d4d8],
      hatch: [0xb23a2e, 0x2b5a9e, 0xd8b13a, 0x4b7d4e, 0x8a8f96, 0x3a3f4a, 0xc7632b, 0x6a4a8c],
      taxi: [0xf4f0e4, 0xf4f0e4, 0xf4f0e4, 0xf2cf3a, 0xf2cf3a, 0xeae6da, 0xf4f0e4, 0xf2cf3a]
    },

    awningTints: [0xb5362c, 0x2c6e5a, 0xd99a2b, 0x2f5a88, 0x7a4a2c, 0xe8e2d4],
    awningChance: 0.45,

    // Board colours for signs: background, text
    signBoards: [
      ['#fbf6ea', '#1f2a44'], ['#1f3f6b', '#ffffff'], ['#b22f2a', '#ffffff'], ['#f3c33c', '#26231e'],
      ['#17705a', '#ffffff'], ['#23242a', '#f4e7c8'], ['#e8582a', '#ffffff'], ['#f7f7f7', '#c0241d']
    ]
  };
})(window.TLV);
