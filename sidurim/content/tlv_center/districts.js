// content/tlv_center/districts.js — WP-RENDER
// Style weights by neighbourhood, first match wins. Polygons are lat/lon (section 1.1) and need not be precise.
TLV.q.push(['district', {
  id: 'neve_tzedek',
  poly: [[32.0585, 34.7605], [32.0655, 34.7620], [32.0650, 34.7700], [32.0590, 34.7715]],
  weights: { eclectic_wood: 8, bauhaus_shutter: 1, jaffa_stone: 1 }
}]);
TLV.q.push(['district', {
  id: 'florentin',
  poly: [[32.0505, 34.7660], [32.0590, 34.7655], [32.0605, 34.7790], [32.0505, 34.7790]],
  weights: { concrete_block: 5, eclectic_wood: 3, bauhaus_shutter: 2 }
}]);
TLV.q.push(['district', {
  id: 'jaffa',
  poly: [[32.0480, 34.7500], [32.0575, 34.7500], [32.0575, 34.7620], [32.0480, 34.7640]],
  weights: { jaffa_stone: 8, concrete_block: 2 }
}]);
TLV.q.push(['district', {
  id: 'seafront',
  poly: [[32.0610, 34.7590], [32.0800, 34.7640], [32.0960, 34.7710], [32.0960, 34.7750], [32.0800, 34.7685], [32.0610, 34.7640]],
  weights: { hotel_sea: 5, modern_white: 3, bauhaus_shutter: 2 }
}]);
TLV.q.push(['district', {
  id: 'white_city',
  poly: [[32.0640, 34.7660], [32.0680, 34.7640], [32.0900, 34.7720], [32.0900, 34.7860], [32.0640, 34.7830]],
  weights: { bauhaus_ribbon: 5, bauhaus_shutter: 5, concrete_block: 2, modern_white: 1 }
}]);
TLV.q.push(['district', {
  id: 'city', default: true,
  weights: { concrete_block: 5, bauhaus_shutter: 3, modern_white: 2, bauhaus_ribbon: 1 }
}]);
