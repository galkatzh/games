// js/render/people.js — WP-RENDER (RENDER-ACTORS)
// Everyone on foot or on two wheels, in one instanced mesh. A person is a rigid doll with five joints posed in the vertex shader, and
// every silhouette (dog, stroller, cane, bike, knife) is an accessory group switched per instance, so a full street is one draw call.
// No character carries any iconography, and the attacker differs from anyone else only by shirt colour (GAME_DESIGN 15.3, BRIEF).
// Reads only the fields of ARCHITECTURE 15.1. Writes nothing to S.
(function (TLV) {
  'use strict';

  var people = TLV.ns('render.people');

  // -- Numbers ------------------------------------------------------------------------------------------------------------------------
  var Q = {
    strideM: 1.25,        // metres per full leg cycle, walking
    strideRunM: 2.5,
    walkAmp: 0.5,
    runAmp: 1.0,
    fadeS: 0.35,
    blobLift: 0.03,
    tugHz: 2.6,
    glareHz: 2.2,
    wobbleHz: 1.4,
    slowVariants: [9, 10, 11],   // walkers: stooped, with a stick
    dogVariants: [12, 13, 14],   // walkers: with a dog
    runV: 2.4,
    fullM: 72             // past this a person is a three-box stand-in: no shadow, no props, not in the rear-view strip
  };

  /** Doll joints. */
  var PART = { TORSO: 0, HEAD: 1, ARM_L: 2, ARM_R: 3, LEG_L: 4, LEG_R: 5, GROUND: 6, DOG_A: 7, DOG_B: 8 };

  /** Colour slots: fixed, or read per instance. */
  var SLOT = { FIXED: 0, SHIRT: 1, PANTS: 2, SKIN: 3, HAIR: 4 };

  /** Accessory bits. BODY is a bit too, so a prop can be drawn with nobody holding it. */
  var ACC = {
    BODY: 0, HAIR_SHORT: 1, HAIR_LONG: 2, HAIR_TIED: 3, PHONE: 4, KNIFE: 5, CANE: 6, BAG: 7, STROLLER: 8, TROLLEY: 9, DOG: 10,
    SCOOTER: 11, BIKE: 12, DELIVERY: 13, CLIPBOARD: 14, INTENT: 15, CHAIRS: 16, FALLEN: 17, BACKPACK: 18, DIZZY: 19
  };

  /** Colour table, indexed from iStyle. Skins first, then hair, then trousers. */
  var SKINS = ['#f1cfae', '#e0b08a', '#c68c5e', '#a26a42', '#7c4d30', '#5a3724'];
  var HAIRS = ['#1f1a17', '#3d2a1e', '#6a4526', '#a97a3f', '#8d8d8d', '#d9d4c8'];
  var PANTS = ['#2e3a55', '#3d3f45', '#59616b', '#7b6a4e', '#a9987a', '#28303a', '#514a63', '#6e7f6d'];
  var SHIRTS = ['#e8dfcf', '#d9a441', '#4f8fa8', '#c8694a', '#7fa36b', '#e8e8e8', '#b88fb5', '#546a8c', '#d4ca7a', '#8c5a44', '#5c8f88', '#c7c1b4'];

  var ATTACKER_SHIRT = '#8c2fd6';
  var PLAYER_SHIRT = '#18b6a8';
  var SAVER_SHIRT = '#f2b632';
  var INSPECTOR_SHIRT = '#28406b';
  var DELIVERY_SHIRT = '#e8602c';

  // -- Geometry -----------------------------------------------------------------------------------------------------------------------

  /** Sets what the next vertices belong to. */
  function rigged(g, part, slot, acc, pivot) {
    g.with({ aRig: [part, slot, acc, 0], aPiv: pivot || [0, 0, 0] });
  }

  /**
   * Builds the doll with what it carries, and the props that stand beside it. Two meshes, so that a street of plain walkers does not
   * pay for a stroller each: three counts every triangle of an instance, drawn or collapsed. Units are metres, chunky cartoon proportions.
   * @returns {{doll:THREE.BufferGeometry, props:THREE.BufferGeometry}} Geometries.
   */
  function buildGeometry() {
    var G = TLV.render.vehicles._Geo, rgb = TLV.render.vehicles._rgb;
    var g = new G({ aRig: 4, aPiv: 3 });
    var doll = g;
    var propsGeo = new G({ aRig: 4, aPiv: 3 });
    var w = [1, 1, 1];
    var dark = rgb('#16171a'), steel = rgb('#c9d2d8'), steelHi = rgb('#eef3f6'), wood = rgb('#6a4326'), grey = rgb('#5a5f66');
    var chrome = rgb('#aab2b8'), pram = rgb('#34506e'), canopy = rgb('#c75a48'), wire = rgb('#8f9ca8'), box = rgb('#e8602c');
    var dog = rgb('#a9743f'), dogDk = rgb('#6d4a28'), vest = rgb('#d7e23a'), amber = rgb('#ffc62e'), paper = rgb('#efece0');
    var star = rgb('#ffe066'), helmet = rgb('#f1efe7'), bag = rgb('#7a4a2c'), pack = rgb('#2f4858');

    var HIP = [0, 0.88, 0], NECK = [0, 1.5, 0];
    var SHOULDER_L = [0, 1.42, -0.29], SHOULDER_R = [0, 1.42, 0.29];
    var HIP_L = [0, 0.88, -0.115], HIP_R = [0, 0.88, 0.115];

    // Legs and shoes.
    [[PART.LEG_L, HIP_L], [PART.LEG_R, HIP_R]].forEach(function (leg) {
      var z = leg[1][2];
      rigged(g, leg[0], SLOT.PANTS, ACC.BODY, leg[1]);
      g.box(0, 0.5, z, 0.17, 0.78, 0.17, w);
      rigged(g, leg[0], SLOT.FIXED, ACC.BODY, leg[1]);
      g.box(0.05, 0.055, z, 0.29, 0.11, 0.18, dark);
    });

    // Torso: a tapered shirt, wider at the shoulder.
    rigged(g, PART.TORSO, SLOT.SHIRT, ACC.BODY, HIP);
    g.loft([[0.13, 0.84, 1.5, 0.2, 0.24], [-0.13, 0.84, 1.5, 0.2, 0.24]], w);
    rigged(g, PART.TORSO, SLOT.PANTS, ACC.BODY, HIP);
    g.box(0, 0.86, 0, 0.27, 0.1, 0.41, w);

    // Head: neck, a big box of a head, two dot eyes.
    rigged(g, PART.HEAD, SLOT.SKIN, ACC.BODY, NECK);
    g.box(0, 1.54, 0, 0.13, 0.1, 0.14, w);
    g.box(0.01, 1.71, 0, 0.29, 0.31, 0.27, w);
    rigged(g, PART.HEAD, SLOT.FIXED, ACC.BODY, NECK);
    [-0.07, 0.07].forEach(function (z) {
      g.quad([0.158, 1.715, z - 0.02], [0.158, 1.765, z - 0.02], [0.158, 1.765, z + 0.02], [0.158, 1.715, z + 0.02], dark, [1, 0, 0]);
    });

    // Arms: sleeve, then bare forearm.
    [[PART.ARM_L, SHOULDER_L], [PART.ARM_R, SHOULDER_R]].forEach(function (arm) {
      var z = arm[1][2];
      rigged(g, arm[0], SLOT.SHIRT, ACC.BODY, arm[1]);
      g.box(0, 1.2, z, 0.14, 0.46, 0.14, w);
      rigged(g, arm[0], SLOT.SKIN, ACC.BODY, arm[1]);
      g.box(0, 0.86, z, 0.125, 0.25, 0.125, w);
    });

    // Hair. Plain, bare-headed shapes only: nobody wears anything on their head except a delivery rider's helmet.
    rigged(g, PART.HEAD, SLOT.HAIR, ACC.HAIR_SHORT, NECK);
    g.box(-0.02, 1.885, 0, 0.3, 0.06, 0.29, w);
    g.box(-0.13, 1.78, 0, 0.07, 0.16, 0.29, w);
    rigged(g, PART.HEAD, SLOT.HAIR, ACC.HAIR_LONG, NECK);
    g.box(-0.03, 1.885, 0, 0.32, 0.07, 0.3, w);
    g.box(-0.14, 1.64, 0, 0.09, 0.46, 0.32, w);
    rigged(g, PART.HEAD, SLOT.HAIR, ACC.HAIR_TIED, NECK);
    g.box(-0.02, 1.885, 0, 0.3, 0.06, 0.29, w);
    g.box(-0.2, 1.84, 0, 0.14, 0.14, 0.14, w);

    // Phone, in the right hand, lit toward the face.
    rigged(g, PART.ARM_R, SLOT.FIXED, ACC.PHONE, SHOULDER_R);
    g.box(0.02, 0.7, 0.26, 0.03, 0.2, 0.11, dark);
    g.quad([0.0, 0.625, 0.22], [0.0, 0.775, 0.22], [0.0, 0.775, 0.3], [0.0, 0.625, 0.3], rgb('#9ad4ff'), [-1, 0, 0]);

    // The knife: oversized and blunt-tipped, a cartoon prop, and thick enough to read end-on, as a slab and not a hairline, when he comes at the lens or walks away
    // from it. It points forward from the fist.
    var kx = 0.06, ky = 0.76, kz = 0.29;
    rigged(g, PART.ARM_R, SLOT.FIXED, ACC.KNIFE, SHOULDER_R);
    g.box(kx - 0.02, ky, kz, 0.2, 0.1, 0.1, wood);
    g.box(kx + 0.09, ky, kz, 0.05, 0.24, 0.15, grey);
    var bladeFrom = g.pos.length / 3;
    g.loft([[kx + 0.78, ky - 0.03, ky + 0.06, 0.03, 0.03], [kx + 0.64, ky - 0.12, ky + 0.12, 0.05, 0.05], [kx + 0.11, ky - 0.12, ky + 0.12, 0.055, 0.055]], steel);
    shiftFrom(g, bladeFrom, kz);    // lofts centre on z = 0, and the blade lives in the fist
    g.box(kx + 0.38, ky + 0.11, kz, 0.5, 0.03, 0.11, steelHi);

    // Walking stick for the slow walker.
    rigged(g, PART.ARM_R, SLOT.FIXED, ACC.CANE, SHOULDER_R);
    g.box(0.06, 0.42, 0.29, 0.04, 0.86, 0.04, wood);

    // A shoulder bag on some walkers.
    rigged(g, PART.TORSO, SLOT.FIXED, ACC.BAG, HIP);
    g.box(0, 0.96, 0.27, 0.27, 0.24, 0.09, bag);

    // Backpack.
    rigged(g, PART.TORSO, SLOT.FIXED, ACC.BACKPACK, HIP);
    g.box(-0.2, 1.22, 0, 0.17, 0.44, 0.32, pack);

    // Parking inspector: clipboard and a high-visibility vest.
    rigged(g, PART.ARM_L, SLOT.FIXED, ACC.CLIPBOARD, SHOULDER_L);
    g.box(0.05, 0.8, -0.26, 0.03, 0.32, 0.25, paper);
    rigged(g, PART.TORSO, SLOT.FIXED, ACC.CLIPBOARD, HIP);
    g.box(0, 1.18, 0, 0.285, 0.52, 0.42, vest);

    // Delivery rider: the huge square bag and a helmet.
    rigged(g, PART.TORSO, SLOT.FIXED, ACC.DELIVERY, HIP);
    g.box(-0.42, 1.28, 0, 0.56, 0.62, 0.6, box);
    rigged(g, PART.HEAD, SLOT.FIXED, ACC.DELIVERY, NECK);
    g.loft([[0.17, 1.82, 1.95, 0.17, 0.11], [0.0, 1.82, 2.0, 0.18, 0.13], [-0.17, 1.82, 1.92, 0.16, 0.1]], helmet);

    // The intent flag: a small amber diamond over someone about to step out.
    rigged(g, PART.HEAD, SLOT.FIXED, ACC.INTENT, NECK);
    g.loft([[0.12, 2.3, 2.3, 0.0, 0.0], [0.0, 2.14, 2.46, 0.08, 0.08], [-0.12, 2.3, 2.3, 0.0, 0.0]], amber);

    // Dizzy stars around the head, for the chase, where nobody is hurt: a lunge landing on the player, or the attacker's own stumble.
    rigged(g, PART.HEAD, SLOT.FIXED, ACC.DIZZY, NECK);
    for (var st = 0; st < 5; st++) {
      var a = st / 5 * Math.PI * 2;
      var sx = Math.cos(a) * 0.34, sz = Math.sin(a) * 0.34, sy = 2.03 + (st % 2) * 0.05;
      g.box(sx, sy, sz, 0.14, 0.14, 0.05, star);
    }

    g = propsGeo;

    // Stroller, pushed ahead: chassis, bassinet, canopy, four wheels and a tall handle.
    rigged(g, PART.GROUND, SLOT.FIXED, ACC.STROLLER, [0, 0, 0]);
    g.box(1.0, 0.62, 0, 0.66, 0.32, 0.44, pram);
    g.loft([[1.34, 0.76, 1.08, 0.2, 0.17], [0.95, 0.76, 1.2, 0.22, 0.2], [0.72, 0.76, 0.98, 0.22, 0.2]], canopy);
    g.box(0.62, 0.72, -0.17, 0.5, 0.03, 0.03, chrome);
    g.box(0.62, 0.72, 0.17, 0.5, 0.03, 0.03, chrome);
    g.box(0.46, 0.92, -0.17, 0.03, 0.4, 0.03, chrome);
    g.box(0.46, 0.92, 0.17, 0.03, 0.4, 0.03, chrome);
    g.box(0.46, 1.1, 0, 0.04, 0.04, 0.4, chrome);
    [[0.76, -0.2], [0.76, 0.2], [1.26, -0.2], [1.26, 0.2]].forEach(function (p) {
      g.box(p[0], 0.3, p[1], 0.03, 0.56, 0.03, chrome);
      g.cyl(p[0], 0.1, p[1], 0.1, 0.05, 6, dark);
    });

    // Shopping trolley: an open wire basket, read through its bars.
    rigged(g, PART.GROUND, SLOT.FIXED, ACC.TROLLEY, [0, 0, 0]);
    for (var bar = 0; bar < 4; bar++) {
      g.box(0.62 + bar * 0.24, 0.82, -0.25, 0.022, 0.36, 0.022, wire);
      g.box(0.62 + bar * 0.24, 0.82, 0.25, 0.022, 0.36, 0.022, wire);
    }
    g.box(0.98, 1.0, -0.25, 0.8, 0.03, 0.03, wire);
    g.box(0.98, 1.0, 0.25, 0.8, 0.03, 0.03, wire);
    g.box(0.98, 0.66, 0, 0.8, 0.03, 0.54, wire);
    g.box(1.36, 0.82, 0, 0.03, 0.36, 0.5, wire);
    g.box(0.54, 1.02, 0, 0.04, 0.04, 0.54, canopy);
    g.box(0.98, 0.26, -0.22, 0.03, 0.42, 0.03, wire);
    g.box(0.98, 0.26, 0.22, 0.03, 0.42, 0.03, wire);
    g.box(0.98, 0.09, 0, 0.74, 0.04, 0.46, dark);
    g.box(0.98, 0.8, 0.04, 0.4, 0.24, 0.3, rgb('#d9a441'));    // the shopping

    // A dog on a lead, trotting ahead. Its legs swing with the owner's gait.
    rigged(g, PART.GROUND, SLOT.FIXED, ACC.DOG, [0, 0, 0]);
    var dx = 1.2, dz = -0.52;
    g.box(dx, 0.36, dz, 0.56, 0.2, 0.19, dog);
    g.box(dx + 0.34, 0.5, dz, 0.2, 0.2, 0.17, dog);
    g.box(dx + 0.47, 0.45, dz, 0.1, 0.08, 0.1, dogDk);
    g.box(dx + 0.3, 0.63, dz - 0.06, 0.06, 0.1, 0.05, dogDk);
    g.box(dx + 0.3, 0.63, dz + 0.06, 0.06, 0.1, 0.05, dogDk);
    g.box(dx - 0.33, 0.47, dz, 0.16, 0.05, 0.05, dogDk);
    // The lead, from the left hand to the collar.
    var hand = [0.42, 0.98, -0.29], collar = [dx + 0.26, 0.52, dz];
    g.quad([hand[0], hand[1] + 0.012, hand[2]], [collar[0], collar[1] + 0.012, collar[2]], [collar[0], collar[1] - 0.012, collar[2]],
      [hand[0], hand[1] - 0.012, hand[2]], dark, [0, 0, 1]);
    g.quad([hand[0], hand[1] + 0.012, hand[2]], [collar[0], collar[1] + 0.012, collar[2]], [collar[0], collar[1] - 0.012, collar[2]],
      [hand[0], hand[1] - 0.012, hand[2]], dark, [0, 0, -1]);
    [[0.22, -1, PART.DOG_A], [0.22, 1, PART.DOG_B], [-0.2, -1, PART.DOG_B], [-0.2, 1, PART.DOG_A]].forEach(function (leg) {
      var px = dx + leg[0], pz = dz + leg[1] * 0.07;
      rigged(g, leg[2], SLOT.FIXED, ACC.DOG, [px, 0.3, pz]);
      g.box(px, 0.15, pz, 0.07, 0.3, 0.07, dogDk);
    });

    // E-scooter: thin deck, tall stem, T bar. Tall and narrow, nothing else is shaped like it.
    rigged(g, PART.GROUND, SLOT.FIXED, ACC.SCOOTER, [0, 0, 0]);
    var teal = rgb('#2fb7a0');
    g.box(0.05, 0.12, 0, 0.92, 0.05, 0.17, teal);
    g.box(0.54, 0.62, 0, 0.05, 1.0, 0.05, grey);
    g.box(0.56, 1.13, 0, 0.05, 0.05, 0.56, dark);
    g.cyl(0.58, 0.11, 0, 0.11, 0.06, 8, dark);
    g.cyl(-0.42, 0.1, 0, 0.1, 0.06, 8, dark);
    g.box(0.58, 0.24, 0, 0.16, 0.03, 0.08, teal);

    // Delivery bike: two big wheels, a frame, a seat and bars.
    rigged(g, PART.GROUND, SLOT.FIXED, ACC.BIKE, [0, 0, 0]);
    g.cyl(0.64, 0.34, 0, 0.34, 0.05, 10, dark, grey);
    g.cyl(-0.56, 0.34, 0, 0.34, 0.05, 10, dark, grey);
    g.box(0.05, 0.66, 0, 1.02, 0.05, 0.05, grey);
    g.box(0.46, 0.68, 0, 0.05, 0.64, 0.05, grey);
    g.box(0.48, 1.04, 0, 0.05, 0.05, 0.56, dark);
    g.box(-0.1, 0.8, 0, 0.3, 0.06, 0.16, dark);

    // Chase blockers, drawn with nobody there: cafe chairs and a table, and a scooter on its side.
    rigged(g, PART.GROUND, SLOT.FIXED, ACC.CHAIRS, [0, 0, 0]);
    var chair = rgb('#c9b28a'), top = rgb('#e6e1d3');
    g.box(0, 0.74, 0, 0.72, 0.04, 0.72, top);
    g.box(0, 0.37, 0, 0.06, 0.74, 0.06, grey);
    g.box(0, 0.02, 0, 0.5, 0.04, 0.5, grey);
    [[0.72, 0], [-0.72, 0.1], [0.05, 0.72], [0.1, -0.72]].forEach(function (p) {
      g.box(p[0], 0.46, p[1], 0.4, 0.04, 0.4, chair);
      g.box(p[0] + (p[0] > 0.5 ? 0.18 : p[0] < -0.5 ? -0.18 : 0), 0.7, p[1] + (p[1] > 0.5 ? 0.18 : p[1] < -0.5 ? -0.18 : 0),
        Math.abs(p[0]) > 0.5 ? 0.04 : 0.4, 0.46, Math.abs(p[1]) > 0.5 ? 0.04 : 0.4, chair);
      [[-0.16, -0.16], [0.16, -0.16], [-0.16, 0.16], [0.16, 0.16]].forEach(function (l) {
        g.box(p[0] + l[0], 0.22, p[1] + l[1], 0.035, 0.46, 0.035, chair);
      });
    });
    rigged(g, PART.GROUND, SLOT.FIXED, ACC.FALLEN, [0, 0, 0]);
    g.box(0.05, 0.1, 0, 0.92, 0.17, 0.05, teal);
    g.box(0.6, 0.12, 0.45, 0.05, 0.05, 0.96, grey);
    g.box(0.62, 0.3, 0.92, 0.05, 0.56, 0.05, dark);
    g.cyl(0.6, 0.11, -0.12, 0.11, 0.06, 8, dark);
    g.cyl(-0.42, 0.11, -0.12, 0.1, 0.06, 8, dark);

    // The far stand-in: shirt, trousers, head. At this range a person is a dozen pixels, and most of a street's people are this far.
    var lite = new G({ aRig: 4, aPiv: 3 });
    rigged(lite, PART.TORSO, SLOT.SHIRT, ACC.BODY, HIP);
    lite.box(0, 1.17, 0, 0.26, 0.66, 0.46, w);
    rigged(lite, PART.TORSO, SLOT.PANTS, ACC.BODY, HIP);
    lite.box(0, 0.42, 0, 0.2, 0.84, 0.34, w);
    rigged(lite, PART.TORSO, SLOT.SKIN, ACC.BODY, HIP);
    lite.box(0, 1.68, 0, 0.27, 0.34, 0.26, w);

    return { doll: doll.build(), props: propsGeo.build(), lite: lite.build() };
  }

  /**
   * Moves every vertex from one index on along z.
   * @param {object} g Builder.
   * @param {number} first First vertex.
   * @param {number} dz Offset.
   */
  function shiftFrom(g, first, dz) {
    for (var i = first * 3; i < g.pos.length; i += 3) g.pos[i + 2] += dz;
  }

  // -- Material -----------------------------------------------------------------------------------------------------------------------

  var VERT_HEAD = [
    'attribute vec4 aRig;',      // part, colour slot, accessory bit
    'attribute vec3 aPiv;',
    'attribute vec4 iA;',        // leg L, leg R, arm L, arm R (radians forward)
    'attribute vec4 iB;',        // lean forward, head pitch, head yaw, alpha
    'attribute vec4 iC;',        // crouch, side tilt, arm spread, dog gait
    'attribute vec4 iS;',        // pants colour, skin colour, hair colour, accessory mask
    'uniform vec3 uPal[32];',
    'varying float vAlpha;',
    'vec3 pplRotZ(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x - s * v.y, s * v.x + c * v.y, v.z); }',
    'vec3 pplRotX(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, c * v.y - s * v.z, s * v.y + c * v.z); }',
    'vec3 pplRotY(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }',
    // Takes a point or a direction through the doll. `piv` is zero for directions.
    'vec3 pplPose(vec3 p, float solid) {',
    '  float part = aRig.x;',
    '  vec3 piv = aPiv * solid;',
    '  vec3 hip = vec3(0.0, 0.88, 0.0) * solid;',
    '  if (part > 5.5) {',
    '    if (part > 6.5) {',
    '      float gait = part < 7.5 ? iC.w : -iC.w;',
    '      p = pplRotZ(p - piv, gait) + piv;',
    '    }',
    '    return p;',
    '  }',
    '  if (part > 3.5) {',
    '    float a = part < 4.5 ? iA.x : iA.y;',
    '    p = pplRotZ(p - piv, a) + piv;',
    '  } else {',
    '    if (part > 1.5) {',
    '      float a = part < 2.5 ? iA.z : iA.w;',
    '      float sp = part < 2.5 ? iC.z : -iC.z;',
    '      p = pplRotX(pplRotZ(p - piv, a), sp) + piv;',
    '    } else if (part > 0.5) {',
    '      p = pplRotY(pplRotZ(p - piv, -iB.y), iB.z) + piv;',
    '    }',
    '    p = pplRotZ(p - hip, -iB.x) + hip;',
    '  }',
    '  p = pplRotX(p, iC.y);',
    '  p.y -= iC.x * solid;',
    '  return p;',
    '}'
  ].join('\n');

  var VERT_COLOR = [
    'vColor = color;',
    'if (aRig.y > 3.5) vColor *= uPal[int(iS.z + 0.5)];',
    'else if (aRig.y > 2.5) vColor *= uPal[int(iS.y + 0.5)];',
    'else if (aRig.y > 1.5) vColor *= uPal[int(iS.x + 0.5)];',
    'else if (aRig.y > 0.5) vColor *= instanceColor.xyz;',
    'vAlpha = iB.w;'
  ].join('\n');

  var VERT_NORMAL = 'vec3 objectNormal = pplPose(vec3(normal), 0.0);';

  var VERT_POS = [
    'vec3 transformed = pplPose(vec3(position), 1.0);',
    'if (((int(iS.w + 0.5) >> int(aRig.z + 0.5)) & 1) == 0) transformed = vec3(0.0, -50.0, 0.0);'
  ].join('\n');

  var FRAG_DITHER = [
    '#include <clipping_planes_fragment>',
    'if (vAlpha < 0.995) {',
    '  float pplN = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));',
    '  if (pplN >= vAlpha) discard;',
    '}'
  ].join('\n');

  // -- Runtime ------------------------------------------------------------------------------------------------------------------------

  var R = null;

  var _m, _q, _up, _p, _s;   // scratch, made at init

  function scratch() {
    _m = new THREE.Matrix4();
    _q = new THREE.Quaternion();
    _up = new THREE.Vector3(0, 1, 0);
    _p = new THREE.Vector3();
    _s = new THREE.Vector3(1, 1, 1);
  }

  var SKIN0 = 0, HAIR0 = SKINS.length, PANTS0 = HAIR0 + HAIRS.length;

  /** Bits that live in the prop mesh. */
  var PROP_BITS = (1 << ACC.STROLLER) | (1 << ACC.TROLLEY) | (1 << ACC.DOG) | (1 << ACC.SCOOTER) | (1 << ACC.BIKE) | (1 << ACC.CHAIRS) | (1 << ACC.FALLEN);

  /**
   * Builds one instanced mesh of the shared material.
   * @param {THREE.BufferGeometry} geo Geometry.
   * @param {number} cap Instances.
   * @param {THREE.Material} mat Material.
   * @param {THREE.Scene} scene Target.
   * @returns {object} Pool.
   */
  function makePool(geo, cap, mat, scene) {
    function attr(name) {
      var a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    }
    var data = { a: attr('iA'), b: attr('iB'), c: attr('iC'), s: attr('iS') };
    var mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = geo.attributes.position.count > 200;
    mesh.renderOrder = TLV.render.vehicles._ACTOR_ORDER;
    mesh.count = 0;
    scene.add(mesh);
    return { mesh: mesh, data: data, geo: geo, cap: cap, n: 0 };
  }

  /** Builds the meshes and pools. See the seam in the WP-RENDER split. */
  people.init = function (scene, S) {
    scratch();
    var geos = buildGeometry();
    var cap = TLV.const.MAX_PEDS + 8;       // the player, plus chase blockers
    var pal = [];
    SKINS.concat(HAIRS).concat(PANTS).forEach(function (hex) { pal.push(new THREE.Color(hex)); });
    while (pal.length < 32) pal.push(new THREE.Color(1, 1, 1));
    var mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    mat.onBeforeCompile = function (shader) {
      shader.uniforms.uPal = { value: pal };
      shader.vertexShader = VERT_HEAD + '\n' + shader.vertexShader
        .replace('#include <color_vertex>', VERT_COLOR)
        .replace('#include <beginnormal_vertex>', VERT_NORMAL)
        .replace('#include <begin_vertex>', VERT_POS);
      shader.fragmentShader = 'varying float vAlpha;\n' + shader.fragmentShader
        .replace('#include <clipping_planes_fragment>', FRAG_DITHER);
    };
    mat.customProgramCacheKey = function () { return 'tlv-person'; };

    var bgeo = new THREE.CircleGeometry(0.5, 10);
    bgeo.rotateX(-Math.PI / 2);
    var bmat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
    var blobs = new THREE.InstancedMesh(bgeo, bmat, cap);
    blobs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    blobs.frustumCulled = false;
    blobs.renderOrder = 1;
    blobs.count = 0;
    scene.add(blobs);

    var n = TLV.const.MAX_PEDS;
    R = {
      scene: scene, mat: mat, blobs: blobs, bgeo: bgeo, bmat: bmat, blobN: 0,
      doll: makePool(geos.doll, cap, mat, scene), props: makePool(geos.props, 48, mat, scene), lite: makePool(geos.lite, cap, mat, scene),
      ids: new Int32Array(n).fill(-1), phase: new Float32Array(n), fade: new Float32Array(n), look: [],
      footPhase: 0, shirts: SHIRTS.map(function (h) { return new THREE.Color(h); }),
      attacker: new THREE.Color(ATTACKER_SHIRT), player: new THREE.Color(PLAYER_SHIRT), saver: new THREE.Color(SAVER_SHIRT),
      inspector: new THREE.Color(INSPECTOR_SHIRT), delivery: new THREE.Color(DELIVERY_SHIRT)
    };
  };

  var pose = { legL: 0, legR: 0, armL: 0, armR: 0, lean: 0, headPitch: 0, headYaw: 0, crouch: 0, side: 0, spread: 0, dog: 0, bob: 0 };

  /** Zeroes the pose. */
  function rest() {
    pose.legL = pose.legR = pose.armL = pose.armR = pose.lean = pose.headPitch = pose.headYaw = 0;
    pose.crouch = pose.side = pose.spread = pose.dog = pose.bob = 0;
    pose.armL = pose.armR = 0.03;
  }

  /** Bit mask for an accessory list. */
  function mask() {
    var m = 0;
    for (var i = 0; i < arguments.length; i++) m |= 1 << arguments[i];
    return m;
  }

  /**
   * Picks the stable look of one person from ID and variant. The same person keeps the same look for their whole life.
   * @param {object} p Pedestrian.
   * @returns {object} { mask, shirt, pants, skin, hair, slow, dog, pushing }.
   */
  function lookOf(p) {
    var h = TLV.rng.hash32(p.id, 41);
    var look = {
      mask: mask(ACC.BODY),
      shirt: R.shirts[h % SHIRTS.length],
      pants: PANTS0 + ((h >>> 5) % PANTS.length),
      skin: SKIN0 + ((h >>> 9) % SKINS.length),
      hair: HAIR0 + ((h >>> 12) % HAIRS.length),
      slow: false, dog: false, pushing: false, rider: false, kind: p.kind
    };
    var style = (h >>> 16) % 4;
    if (style === 0) look.mask |= mask(ACC.HAIR_SHORT);
    else if (style === 1) look.mask |= mask(ACC.HAIR_LONG);
    else if (style === 2) look.mask |= mask(ACC.HAIR_TIED);
    else look.mask |= mask(ACC.HAIR_SHORT);
    var extra = (h >>> 20) % 5;
    var v = p.variant & 15;
    switch (p.kind) {
      case 'walker':
        if (Q.slowVariants.indexOf(v) >= 0) {
          look.slow = true;
          look.mask |= mask(ACC.CANE);
          look.hair = HAIR0 + 4 + (h & 1);
        } else if (Q.dogVariants.indexOf(v) >= 0) {
          look.dog = true;
          look.mask |= mask(ACC.DOG);
        } else if (extra === 0) look.mask |= mask(ACC.BAG);
        else if (extra === 1) look.mask |= mask(ACC.BACKPACK);
        break;
      case 'phone':
        look.mask |= mask(ACC.PHONE);
        break;
      case 'trolley':
        look.pushing = true;
        look.mask |= v & 1 ? mask(ACC.TROLLEY) : mask(ACC.STROLLER);
        break;
      case 'scooter':
        look.rider = true;
        look.mask |= mask(ACC.SCOOTER);
        break;
      case 'delivery':
        look.rider = true;
        look.shirt = R.delivery;
        look.mask = mask(ACC.BODY, ACC.BIKE, ACC.DELIVERY);
        break;
      case 'inspector':
        look.shirt = R.inspector;
        look.mask |= mask(ACC.CLIPBOARD);
        break;
      case 'saver':
        look.shirt = R.saver;
        break;
      case 'passenger':
        look.mask |= mask(ACC.BAG);
        break;
      case 'attacker':
        look.shirt = R.attacker;
        break;
      default:
        break;
    }
    return look;
  }

  /** A walking or running cycle. */
  function gait(phase, amp, run) {
    var s = Math.sin(phase);
    pose.legL = s * amp;
    pose.legR = -s * amp;
    pose.armL = -s * amp * (run ? 0.95 : 0.7);
    pose.armR = s * amp * (run ? 0.95 : 0.7);
    pose.bob = Math.abs(Math.cos(phase)) * (run ? 0.09 : 0.03);
    if (run) {
      pose.lean = 0.22;
      pose.armL += 0.5;
      pose.armR += 0.5;
    }
  }

  /**
   * Poses a person for this frame.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {object} look From lookOf.
   * @param {number} phase Gait phase.
   * @param {number} t Seconds, for idle motion.
   */
  function poseFor(S, p, look, phase, t) {
    rest();
    var anim = p.anim;
    var v = p.v;
    if (look.rider) {
      if (p.kind === 'scooter') {
        pose.legL = 0.05;
        pose.legR = -0.08;
        pose.armL = pose.armR = 1.02;
        pose.lean = 0.12 + Math.min(v, 8) * 0.012;
      } else {
        pose.crouch = 0.08;
        pose.legL = 0.3 + Math.sin(phase * 1.4) * 0.5;
        pose.legR = 0.3 - Math.sin(phase * 1.4) * 0.5;
        pose.armL = pose.armR = 1.15;
        pose.lean = 0.34;
      }
    } else if (look.pushing) {
      gait(phase, Q.walkAmp * Math.min(1, v / 0.8), false);
      pose.armL = pose.armR = 1.05;
      pose.lean = 0.1;
    } else {
      switch (anim) {
        case 'walk':
          gait(phase, Math.min(1, v / 1.2) * (look.slow ? Q.walkAmp * 0.55 : Q.walkAmp), false);
          if (look.slow) {
            pose.lean = 0.3;
            pose.headPitch = -0.2;
            pose.armR = 0.28;
          }
          if (look.dog) pose.armL = 0.3;
          break;
        case 'run':
          gait(phase, Q.runAmp, true);
          break;
        case 'phone':
          gait(phase, Math.min(1, v / 1.2) * Q.walkAmp * 0.8, false);
          break;
        case 'glare':
          pose.spread = 0.32;
          pose.headPitch = 0.05;
          pose.armR = 2.4 + Math.sin(t * Q.glareHz * 6.28) * 0.28;
          pose.armL = 0.25;
          break;
        case 'tug':
          pose.lean = -0.22 + Math.sin(t * Q.tugHz * 6.28) * 0.1;
          pose.legL = 0.32;
          pose.legR = -0.26;
          pose.armL = 1.5 + Math.sin(t * Q.tugHz * 6.28) * 0.24;
          pose.armR = 2.2;
          break;
        case 'lunge':
          lungePose(S);
          break;
        case 'stumble':
          pose.side = Math.sin(t * Q.wobbleHz * 6.28) * 0.24;
          pose.lean = -0.16;
          pose.spread = 0.9;
          pose.armL = 0.3;
          pose.armR = -0.3;
          pose.headYaw = Math.sin(t * 9) * 0.5;
          break;
        case 'sit':
          pose.crouch = 0.62;
          pose.legL = 1.45;
          pose.legR = 1.38;
          pose.lean = -0.2;
          pose.armL = -0.5;
          pose.armR = -0.5;
          pose.spread = 0.25;
          pose.headYaw = Math.sin(t * 7) * 0.45;
          break;
        default:
          pose.armL = pose.armR = 0.03 + Math.sin(t * 1.3 + p.id) * 0.03;
          if (look.slow) {
            pose.lean = 0.3;
            pose.armR = 0.28;
          }
          if (look.dog) pose.armL = 0.3;
          break;
      }
    }
    if (p.kind === 'phone' || (p.kind === 'inspector' && anim === 'phone')) {
      if (anim !== 'glare' && anim !== 'stumble' && anim !== 'sit') {
        pose.headPitch = 0.42;
        if (p.kind === 'phone') pose.armR = 1.75;
        else pose.armL = 1.1;
      }
    }
    if (p.hasKnife && anim !== 'lunge' && anim !== 'tug') {
      // He always shows the knife: arm up and forward, blade high.
      if (anim === 'run') pose.armR = 1.85 + Math.sin(phase) * 0.14;
      else if (anim === 'glare') pose.armR = 2.3;
      else pose.armR = 1.7;
    }
    if (p.intent) {
      // Fairness: a person about to step out looks up the road, leans out and lifts a foot off the kerb.
      pose.headYaw = Math.sin(t * 5.5) * 0.85;
      pose.headPitch = 0;
      pose.lean = Math.max(pose.lean, 0.2);
      pose.legR = 0.55;
      if (p.kind === 'phone') pose.armR = 0.2;
    }
  }

  /** The three beats of a lunge, read from the encounter. */
  function lungePose(S) {
    var k = S.game && S.game.knife;
    var beat = k ? k.lunge : 'NONE';
    pose.legL = 0.5;
    pose.legR = -0.4;
    if (beat === 'WINDUP') {
      pose.armR = 2.9;
      pose.armL = 0.6;
      pose.lean = -0.2;
    } else if (beat === 'STRIKE') {
      pose.armR = 1.2;
      pose.armL = -0.5;
      pose.lean = 0.5;
      pose.legL = 0.9;
      pose.legR = -0.7;
    } else {
      pose.armR = 0.5;
      pose.armL = 0.2;
      pose.lean = 0.1;
    }
  }

  /** Sets the instance pose. */
  function place(x, y, h) {
    TLV.render.coords.toThree(x, y, pose.bob, _p);
    _q.setFromAxisAngle(_up, h);
    _m.compose(_p, _q, _s);
  }

  /** Copies the pose into one pool. */
  function write(pool, shirt, pants, skin, hair, bits, alpha) {
    var i = pool.n;
    if (i >= pool.cap) return;
    _m.toArray(pool.mesh.instanceMatrix.array, i * 16);
    pool.mesh.instanceColor.setXYZ(i, shirt.r, shirt.g, shirt.b);
    pool.data.a.setXYZW(i, pose.legL, pose.legR, pose.armL, pose.armR);
    pool.data.b.setXYZW(i, pose.lean, pose.headPitch, pose.headYaw, alpha);
    pool.data.c.setXYZW(i, pose.crouch, pose.side, pose.spread, pose.dog);
    pool.data.s.setXYZW(i, pants, skin, hair, bits);
    pool.n = i + 1;
  }

  /**
   * Writes one person, into the doll pool, the prop pool or both, by what they have with them.
   * @param {number} x World x.
   * @param {number} y World y.
   * @param {number} h Heading.
   * @param {THREE.Color} shirt Shirt.
   * @param {number} pants Palette index.
   * @param {number} skin Palette index.
   * @param {number} hair Palette index.
   * @param {number} bits Accessory mask.
   * @param {number} alpha Fade.
   */
  function put(x, y, h, shirt, pants, skin, hair, bits, alpha) {
    place(x, y, h);
    if (bits & ~PROP_BITS) write(R.doll, shirt, pants, skin, hair, bits, alpha);
    if (bits & PROP_BITS) write(R.props, shirt, pants, skin, hair, bits, alpha);
    TLV.render.coords.toThree(x, y, Q.blobLift, _p);
    _m.compose(_p, _q, _s);
    _m.toArray(R.blobs.instanceMatrix.array, R.blobN * 16);
    R.blobN++;
  }

  /** Draws the active chase blockers (ARCHITECTURE 15.3). Chatters are two people, the lead is a dog with nobody on the other end. */
  function drawObstacles(S, t) {
    var list = S.game && S.game.obstacles;
    if (!list) return;
    var white = R.shirts[5];
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (!o.active) continue;
      rest();
      var kind = o.kind;
      var look = (o.id * 37) % 6;
      if (kind === 'CHAIRS') {
        put(o.x, o.y, o.id, white, PANTS0, SKIN0, HAIR0, mask(ACC.CHAIRS), 1);
      } else if (kind === 'FALLEN_SCOOTER') {
        put(o.x, o.y, o.id * 2, white, PANTS0, SKIN0, HAIR0, mask(ACC.FALLEN), 1);
      } else if (kind === 'LEASH') {
        pose.armL = 0.3;
        put(o.x - 0.6, o.y, 0.3, R.shirts[o.id % 12], PANTS0 + 1, SKIN0 + look, HAIR0 + 1, mask(ACC.BODY, ACC.HAIR_SHORT, ACC.DOG), 1);
      } else {
        pose.spread = 0.14;
        pose.armR = 0.6 + Math.sin(t * 2.2) * 0.3;
        put(o.x - 0.4, o.y, 0, R.shirts[(o.id + 3) % 12], PANTS0 + 2, SKIN0 + look, HAIR0 + 2, mask(ACC.BODY, ACC.HAIR_LONG), 1);
        pose.armR = 0.03;
        pose.armL = 0.7 + Math.sin(t * 1.7) * 0.3;
        put(o.x + 0.4, o.y, Math.PI, R.shirts[(o.id + 7) % 12], PANTS0 + 3, SKIN0 + (look + 2) % 6, HAIR0, mask(ACC.BODY, ACC.HAIR_SHORT), 1);
      }
    }
  }

  /** Draws the player on foot. */
  function drawFoot(S, alpha, dt, t) {
    var P = S.player;
    if (!P || P.mode !== 'FOOT' || !P.foot || !P.foot.active) return;
    var f = P.foot;
    var x = f.px + (f.x - f.px) * alpha;
    var y = f.py + (f.y - f.py) * alpha;
    var h = f.ph + TLV.math.wrapPi(f.h - f.ph) * alpha;
    R.footPhase = (R.footPhase + Math.abs(f.v) * dt / Q.strideRunM * 6.283) % 6.283;
    rest();
    var bits = mask(ACC.BODY, ACC.HAIR_SHORT);
    if (f.anim === 'run') gait(R.footPhase, Q.runAmp, true);
    else if (f.anim === 'sidestep') {
      pose.side = 0.3;
      pose.legL = 0.5;
      pose.legR = -0.5;
      pose.spread = 0.5;
    } else if (f.anim === 'stumble') {
      pose.side = Math.sin(t * Q.wobbleHz * 6.28) * 0.28;
      pose.lean = -0.18;
      pose.spread = 0.9;
      pose.headYaw = Math.sin(t * 9) * 0.5;
      bits |= mask(ACC.DIZZY);
    }
    put(x, y, h, R.player, PANTS0, SKIN0 + 1, HAIR0 + 1, bits, 1);
  }

  /** Writes one pedestrian. */
  function drawPed(S, p, i, alpha, dt, t) {
    if (R.ids[i] !== p.id) {
      R.ids[i] = p.id;
      R.fade[i] = p.kind === 'attacker' ? 1 : 0;      // he gets out of a car in plain view, and the shot of it is short
      R.phase[i] = (p.id * 1.7) % 6.283;
      R.look[i] = lookOf(p);
    }
    // A SLOW_CROSS command can turn a walker into a trolley mid-life.
    var look = R.look[i].kind === p.kind ? R.look[i] : (R.look[i] = lookOf(p));
    R.fade[i] = Math.min(1, R.fade[i] + dt / Q.fadeS);
    var stride = p.anim === 'run' ? Q.strideRunM : (look.slow ? Q.strideM * 0.64 : Q.strideM);
    R.phase[i] = (R.phase[i] + Math.abs(p.v) * dt / stride * 6.283) % 6.283;
    poseFor(S, p, look, R.phase[i], t + i * 0.37);
    if (look.dog) pose.dog = Math.sin(R.phase[i] * 2.1) * Math.min(1, p.v) * 0.7;
    var bits = look.mask;
    if (p.hasKnife) bits |= mask(ACC.KNIFE);
    if (p.intent) bits |= mask(ACC.INTENT);
    // Only the attacker's own stumble gets stars. Everyone else stumbles because a car hit them, and that is played straight (GAME_DESIGN 8.3).
    if (p.anim === 'stumble' && p.kind === 'attacker') bits |= mask(ACC.DIZZY);
    var x = p.px + (p.x - p.px) * alpha;
    var y = p.py + (p.y - p.py) * alpha;
    var h = p.ph + TLV.math.wrapPi(p.h - p.ph) * alpha;
    var dx = x - S.player.fx, dy = y - S.player.fy;
    if (dx * dx + dy * dy < Q.fullM * Q.fullM) put(x, y, h, look.shirt, look.pants, look.skin, look.hair, bits, R.fade[i]);
    else {
      place(x, y, h);
      write(R.lite, look.shirt, look.pants, look.skin, look.hair, 1, R.fade[i]);
    }
  }

  /** Publishes one pool. */
  function flush(pool) {
    pool.mesh.count = pool.n;
    pool.mesh.instanceMatrix.needsUpdate = true;
    pool.mesh.instanceColor.needsUpdate = true;
    pool.data.a.needsUpdate = true;
    pool.data.b.needsUpdate = true;
    pool.data.c.needsUpdate = true;
    pool.data.s.needsUpdate = true;
  }

  /**
   * Updates every person.
   * @param {object} S Sim state.
   * @param {number} alpha Tick interpolation.
   * @param {number} dtReal Seconds since the last frame.
   */
  people.frame = function (S, alpha, dtReal) {
    if (!R) return;
    var dt = Math.min(dtReal, 0.1);
    var t = S.t;
    R.doll.n = R.props.n = R.lite.n = 0;
    R.blobN = 0;
    for (var i = 0; i < S.peds.length; i++) {
      var p = S.peds[i];
      if (p.active) drawPed(S, p, i, alpha, dt, t);
      else R.ids[i] = -1;
    }
    drawFoot(S, alpha, dt, t);
    drawObstacles(S, t);
    flush(R.doll);
    flush(R.props);
    flush(R.lite);
    R.blobs.count = R.blobN;
    R.blobs.instanceMatrix.needsUpdate = true;
  };

  /**
   * Drops the far stand-ins from the rear-view pass.
   * @param {boolean} on True while that pass draws.
   */
  people.solidPass = function (on) {
    if (R) R.lite.mesh.visible = !on;
  };

  /**
   * @param {string} kind Pedestrian kind.
   * @param {number} id Pedestrian ID.
   * @param {number} variant Variant.
   * @returns {object} The look that record would get, for tests: colours as strings, accessory bits by name.
   */
  people._look = function (kind, id, variant) {
    var look = lookOf({ kind: kind, id: id, variant: variant });
    var names = [];
    for (var name in ACC) if (look.mask & (1 << ACC[name])) names.push(name);
    return { shirt: '#' + look.shirt.getHexString(), pants: look.pants, skin: look.skin, hair: look.hair, acc: names };
  };

  /** @returns {object} Instances and triangles. Test only. */
  people._counts = function () {
    var tris = function (pool) { return pool.mesh.geometry.attributes.position.count / 3; };
    var sum = function (pool) { return pool.n * tris(pool); };
    return { doll: R.doll.n, props: R.props.n, lite: R.lite.n, dollTris: tris(R.doll), propTris: tris(R.props), liteTris: tris(R.lite), triangles: sum(R.doll) + sum(R.props) + sum(R.lite) };
  };

  /** @returns {number} Dolls drawn this frame that wear this accessory. */
  function wearing(acc) {
    var n = 0, bit = 1 << acc;
    for (var i = 0; i < R.doll.n; i++) if (R.doll.data.s.getW(i) & bit) n++;
    return n;
  }

  /** @returns {number} People drawn with the knife out this frame. Test only. */
  people._knivesDrawn = function () { return wearing(ACC.KNIFE); };

  /** @returns {number} People drawn with stars round the head this frame. Test only. */
  people._dizzyDrawn = function () { return wearing(ACC.DIZZY); };

  /** Events carry nothing people need. Present for the seam. */
  people.onEvent = function () {};

  /** @returns {string} A colour a test can look for: the attacker's shirt. Test only. */
  people._attackerShirt = function () { return ATTACKER_SHIRT; };

  /** Frees everything this module made. */
  people.dispose = function () {
    if (!R) return;
    [R.doll, R.props, R.lite].forEach(function (pool) {
      R.scene.remove(pool.mesh);
      pool.mesh.dispose();
      pool.geo.dispose();
    });
    R.scene.remove(R.blobs);
    R.blobs.dispose();
    R.bgeo.dispose();
    R.mat.dispose();
    R.bmat.dispose();
    R = null;
  };
})(window.TLV);
