// content/tlv_center/kit.js — WP-RENDER
// Tiles and pieces. Painters are named in js/render/city/facades.js and take parameters here. Providers run through slots,
// each with its own stream, so swapping one changes nothing else (section 14.7).
TLV.q.push(['kit', { slot: 'facade.tile', id: 'ribbon_a', paint: 'ribbon', params: { shutter: '#d8d2c6', frame: '#ece9e1' }, variants: 2 }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'shutter_a', paint: 'shutter', params: { shutter: '#d7d1c3' }, variants: 2 }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'wood_a', paint: 'wood', params: { leaf: '#55776a' }, variants: 2 }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'block_a', paint: 'block', params: { shutter: '#cfc9bc' }, variants: 2 }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'arch_a', paint: 'arch', params: { leaf: '#4f6f7a' }, variants: 2 }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'curtain_blue', paint: 'curtain', params: { top: '#86b3d6', bottom: '#3c6f96', spandrel: '#29506f', mullion: '#c3d2dc' }, variants: 1 }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'curtain_steel', paint: 'curtain', params: { top: '#a9b9c4', bottom: '#5f7482', spandrel: '#46565f', mullion: '#d3d8db' }, variants: 1 }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'grid_a', paint: 'grid', params: { shutter: '#d4cfc4' }, variants: 2 }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'pilotis_a', paint: 'pilotis', params: {}, variants: 3 }]);
// A POI takes the tile that lists its kind. Unmapped shops draw from the `filler` weights, so no street repeats one window.
TLV.q.push(['kit', { slot: 'facade.tile', id: 'shop_a', paint: 'shop', params: {}, variants: 2, filler: 3 }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'shop_shut', paint: 'shop_shut', params: {}, variants: 1, filler: 2 }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'shop_cafe', paint: 'cafe', params: {}, variants: 2, filler: 2, kinds: ['cafe', 'restaurant', 'fast_food', 'bar', 'pub', 'ice_cream'] }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'shop_grocery', paint: 'grocery', params: {}, variants: 1, filler: 1, kinds: ['supermarket', 'convenience', 'greengrocer', 'butcher', 'bakery', 'kiosk', 'marketplace'] }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'shop_bank', paint: 'bank', params: {}, variants: 1, kinds: ['bank', 'atm', 'post_office', 'office', 'hotel', 'mall', 'cinema', 'theatre', 'museum', 'library'] }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'shop_pharmacy', paint: 'pharmacy', params: {}, variants: 1, kinds: ['pharmacy', 'clinic', 'dentist', 'hairdresser', 'laundry', 'dry_cleaning'] }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'shop_clothes', paint: 'clothes', params: {}, variants: 1, filler: 2, kinds: ['clothes', 'gallery'] }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'agam_a', paint: 'bands', params: {}, variants: 1 }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'plain_a', paint: 'plain', params: {}, variants: 1 }]);
TLV.q.push(['kit', { slot: 'facade.tile', id: 'lobby_a', paint: 'lobby', params: {}, variants: 1 }]);

// A sculpture carries nothing on its roof or its walls.
TLV.q.push(['kit', { slot: 'bld.rooftop', id: 'none', priority: 1, emit: function () {} }]);
TLV.q.push(['kit', { slot: 'bld.balcony', id: 'none', priority: 1, emit: function () {} }]);

// Solar boilers in a row, as on nearly every flat roof, facing south. A tank joins the larger roofs.
TLV.q.push(['kit', {
  slot: 'bld.rooftop', id: 'boiler_row', priority: 10, when: { roof: 'flat' },
  emit: function (ctx, out) {
    var R = TLV.render.city.recipes;
    var yaw = -Math.PI / 2;
    var rows = Math.min(5, 1 + Math.floor(ctx.area / 130));
    for (var i = 0; i < rows; i++) {
      var p = R.roofPoint(ctx.b, ctx.rng, 1.4);
      if (!p) continue;
      var n = 1 + ctx.rng.int(3);
      for (var k = 0; k < n; k++) out.instance('boiler', p.x + k * 2.1, p.y, ctx.roofZ, yaw, 1);
    }
    if (ctx.area > 260 && ctx.rng.next() < 0.4) {
      var t = R.roofPoint(ctx.b, ctx.rng, 1.2);
      if (t) out.instance('tank', t.x, t.y, ctx.roofZ, 0, 1);
    }
    if (ctx.rng.next() < 0.5) {
      var a = R.roofPoint(ctx.b, ctx.rng, 0.8);
      if (a) out.instance('ac', a.x, a.y, ctx.roofZ + 0.3, ctx.rng.next() * 6.28, 1);
    }
  }
}]);
TLV.q.push(['kit', {
  slot: 'bld.rooftop', id: 'tank_pair', priority: 5, when: { roof: 'flat' },
  emit: function (ctx, out) {
    var R = TLV.render.city.recipes;
    for (var i = 0; i < 2; i++) {
      var p = R.roofPoint(ctx.b, ctx.rng, 1.2);
      if (p) out.instance('tank', p.x, p.y, ctx.roofZ, 0, 0.9 + ctx.rng.next() * 0.3);
    }
  }
}]);
TLV.q.push(['kit', {
  slot: 'bld.rooftop', id: 'ac_cluster', priority: 5, when: { roof: 'flat' },
  emit: function (ctx, out) {
    var R = TLV.render.city.recipes;
    var n = Math.min(8, 2 + Math.floor(ctx.area / 120));
    for (var i = 0; i < n; i++) {
      var p = R.roofPoint(ctx.b, ctx.rng, 0.8);
      if (p) out.instance('ac', p.x, p.y, ctx.roofZ + 0.3, ctx.rng.int(4) * Math.PI / 2, 1.3);
    }
  }
}]);

/** Walks a wall's bays and floors. The first floor keeps clear above a shop, so a balcony never covers its sign. */
function tlvEachBalcony(ctx, every, fn) {
  var w = ctx.wall;
  var yaw = Math.atan2(w.ny, w.nx);
  var first = w.groundTile === ctx.style.tiles.shop ? 1 : 0;
  for (var bay = 0; bay < w.bays; bay++) {
    if (bay % every !== 0) continue;
    var t = (bay + 0.5) / w.bays;
    var x = w.ax + (w.bx - w.ax) * t;
    var y = w.ay + (w.by - w.ay) * t;
    for (var f = first; f < ctx.upperFloors; f++) fn(x, y, ctx.groundTop + f * ctx.floorM, yaw);
  }
}

/** Air conditioners hung on a side wall. */
function tlvWallAc(ctx, out) {
  var w = ctx.wall;
  if (w.front || w.ring !== 0 || w.bays < 1 || ctx.rng.next() > 0.65) return;
  var yaw = Math.atan2(w.ny, w.nx);
  var cnt = 1 + ctx.rng.int(Math.min(4, w.bays + 1));
  for (var i = 0; i < cnt; i++) {
    var q = 0.1 + ctx.rng.next() * 0.8;
    var fl = ctx.rng.int(Math.max(1, ctx.upperFloors));
    out.instance('ac', w.ax + (w.bx - w.ax) * q, w.ay + (w.by - w.ay) * q, ctx.groundTop + fl * ctx.floorM + 0.45, yaw, 1);
  }
}

TLV.q.push(['kit', {
  slot: 'bld.balcony', id: 'strip', priority: 10,
  emit: function (ctx, out) {
    var every = ctx.style.balconyEvery || 0;
    if (ctx.wall.front && every > 0 && ctx.wall.bays >= 2) {
      tlvEachBalcony(ctx, every, function (x, y, z, yaw) { out.instance('balcony', x, y, z, yaw, 1); });
    } else {
      tlvWallAc(ctx, out);
    }
  }
}]);
TLV.q.push(['kit', {
  slot: 'bld.balcony', id: 'curved', priority: 10,
  emit: function (ctx, out) {
    var every = ctx.style.balconyEvery || 0;
    if (ctx.wall.front && every > 0 && ctx.wall.bays >= 2) {
      tlvEachBalcony(ctx, every, function (x, y, z, yaw) { out.instance('balcony_round', x, y, z, yaw, 1); });
    } else {
      tlvWallAc(ctx, out);
    }
  }
}]);
TLV.q.push(['kit', { slot: 'bld.balcony', id: 'ac_only', priority: 5, emit: tlvWallAc }]);

// Pool caps, and the seam a packed mesh would fill. No mesh asset ships in v1, so these fall back to the procedural forms.
TLV.q.push(['mesh', { id: 'boiler', fallback: 'proc:boiler', max: 1500 }]);
TLV.q.push(['mesh', { id: 'tank', fallback: 'proc:tank', max: 400 }]);
TLV.q.push(['mesh', { id: 'ac', fallback: 'proc:ac', max: 3000 }]);
TLV.q.push(['mesh', { id: 'balcony', fallback: 'proc:balcony', max: 6000 }]);
