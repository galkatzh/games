// content/tlv_center/styles.js — WP-RENDER
// The city's building styles. Tiles and providers are in kit.js; which style stands where is in districts.js.
TLV.q.push(['style', {
  id: 'bauhaus_ribbon',
  tiles: { wall: 'ribbon_a', ground: 'pilotis_a', shop: 'shop_a', side: 'plain_a' },
  palette: ['#f4efe6', '#efe3d0', '#f6f1e4', '#ece0c9', '#f2e8d8', '#fbf7ee'],
  bayM: 3.4, floorM: 3.1, balconyEvery: 2, shopChance: 0.35,
  slots: { 'bld.balcony': 'curved', 'bld.rooftop': ['boiler_row'] }
}]);
TLV.q.push(['style', {
  id: 'bauhaus_shutter',
  tiles: { wall: 'shutter_a', ground: 'pilotis_a', shop: 'shop_a', side: 'plain_a' },
  palette: ['#f5efe2', '#ede2cd', '#f1e7d4', '#e9dec9', '#f7f3ea', '#e8d9bd'],
  bayM: 3.3, floorM: 3.1, balconyEvery: 2, shopChance: 0.4,
  slots: { 'bld.balcony': 'strip', 'bld.rooftop': ['boiler_row'] }
}]);
TLV.q.push(['style', {
  id: 'concrete_block',
  tiles: { wall: 'block_a', ground: 'pilotis_a', shop: 'shop_a', side: 'plain_a' },
  palette: ['#ddd6c8', '#d4ccbb', '#e3dccd', '#cfc8ba', '#e8e0cf', '#d9cdb6'],
  bayM: 3.6, floorM: 3.0, balconyEvery: 2, shopChance: 0.5,
  slots: { 'bld.balcony': 'strip', 'bld.rooftop': ['boiler_row', 'tank_pair'] }
}]);
TLV.q.push(['style', {
  id: 'eclectic_wood',
  tiles: { wall: 'wood_a', ground: 'plain_a', shop: 'shop_a', side: 'plain_a' },
  palette: ['#e8c9a0', '#e3b98f', '#efd7b4', '#dcc3a6', '#d9a98a', '#ead9bb'],
  bayM: 3.1, floorM: 3.5, balconyEvery: 0, shopChance: 0.3, roof: 1, roofColour: '#b5694a',
  slots: { 'bld.balcony': 'ac_only' }
}]);
TLV.q.push(['style', {
  id: 'jaffa_stone',
  tiles: { wall: 'arch_a', ground: 'plain_a', shop: 'shop_a', side: 'arch_a' },
  palette: ['#d9c49d', '#cdb68c', '#e0cda8', '#c9b18a', '#dbc8a4'],
  bayM: 3.6, floorM: 3.6, balconyEvery: 0, shopChance: 0.3,
  slots: { 'bld.balcony': 'ac_only' }
}]);
TLV.q.push(['style', {
  id: 'modern_white',
  tiles: { wall: 'grid_a', ground: 'pilotis_a', shop: 'shop_a', side: 'plain_a' },
  palette: ['#f3f1ec', '#ebe8e0', '#f7f6f2'],
  bayM: 3.4, floorM: 3.2, balconyEvery: 3, shopChance: 0.4,
  slots: { 'bld.balcony': 'strip', 'bld.rooftop': ['ac_cluster'] }
}]);
TLV.q.push(['style', {
  id: 'hotel_sea',
  tiles: { wall: 'grid_a', ground: 'shop_bank', shop: 'shop_a', side: 'plain_a' },
  palette: ['#f4f1ea', '#ece6d8', '#f0ece4'],
  bayM: 3.6, floorM: 3.1, balconyEvery: 1,
  slots: { 'bld.balcony': 'strip', 'bld.rooftop': ['ac_cluster'] }
}]);
TLV.q.push(['style', {
  id: 'tower_glass', tags: ['glass', 'tower'],
  tiles: { wall: 'curtain_blue', ground: 'shop_bank', shop: 'shop_a', side: 'curtain_blue' },
  palette: ['#ffffff'], bayM: 3.0, floorM: 3.8, balconyEvery: 0, slots: {}
}]);
TLV.q.push(['style', {
  id: 'tower_grid', tags: ['tower'], weight: 2,
  tiles: { wall: 'grid_a', ground: 'shop_bank', shop: 'shop_a', side: 'grid_a' },
  palette: ['#e9e6df', '#dcd9d2', '#ece4d4'], bayM: 3.2, floorM: 3.3, balconyEvery: 0, slots: {}
}]);
TLV.q.push(['style', {
  id: 'office_steel', tags: ['office'],
  tiles: { wall: 'curtain_steel', ground: 'shop_bank', shop: 'shop_a', side: 'curtain_steel' },
  palette: ['#ffffff'], bayM: 3.0, floorM: 3.6, balconyEvery: 0, slots: {}
}]);
TLV.q.push(['style', {
  id: 'civic_stone', tags: ['civic'],
  tiles: { wall: 'shutter_a', ground: 'plain_a', shop: 'plain_a', side: 'plain_a' },
  palette: ['#e8dfcc', '#ded3bd', '#efe7d6'], bayM: 3.8, floorM: 3.6, balconyEvery: 0, shopChance: 0,
  slots: { 'bld.balcony': 'ac_only', 'bld.rooftop': ['ac_cluster'] }
}]);
TLV.q.push(['style', {
  id: 'industrial', tags: ['industrial'],
  tiles: { wall: 'block_a', ground: 'plain_a', shop: 'plain_a', side: 'plain_a' },
  palette: ['#bdb6a8', '#c7c0b1', '#ada79a'], bayM: 4.6, floorM: 3.8, balconyEvery: 0, shopChance: 0,
  slots: { 'bld.balcony': 'ac_only' }
}]);

// Landmarks
TLV.q.push(['style', {
  id: 'glass_blue',
  tiles: { wall: 'curtain_blue', ground: 'shop_bank', shop: 'shop_a', side: 'curtain_blue' },
  palette: ['#ffffff'], bayM: 3.0, floorM: 3.8, balconyEvery: 0, shopChance: 1, slots: {}
}]);
TLV.q.push(['style', {
  id: 'glass_steel',
  tiles: { wall: 'curtain_steel', ground: 'shop_bank', shop: 'shop_a', side: 'curtain_steel' },
  palette: ['#ffffff'], bayM: 3.0, floorM: 3.8, balconyEvery: 0, shopChance: 1, slots: {}
}]);
TLV.q.push(['style', {
  id: 'mall_concrete',
  tiles: { wall: 'plain_a', ground: 'shop_a', shop: 'shop_a', side: 'plain_a' },
  palette: ['#d8d0c0', '#cfc6b4'], bayM: 5, floorM: 4.5, balconyEvery: 0, shopChance: 0.8, slots: {}
}]);
TLV.q.push(['style', {
  id: 'civic_white',
  tiles: { wall: 'plain_a', ground: 'plain_a', shop: 'plain_a', side: 'plain_a' },
  palette: ['#f2efe7'], bayM: 5, floorM: 4, balconyEvery: 0, shopChance: 0, slots: {}
}]);
TLV.q.push(['style', {
  id: 'sarona_stone',
  tiles: { wall: 'wood_a', ground: 'plain_a', shop: 'shop_a', side: 'plain_a' },
  palette: ['#e9dcc0'], bayM: 3.4, floorM: 4, balconyEvery: 0, roof: 1, roofColour: '#b5694a', slots: {}
}]);
TLV.q.push(['style', {
  id: 'clock_stone',
  tiles: { wall: 'arch_a', ground: 'arch_a', shop: 'arch_a', side: 'arch_a' },
  palette: ['#dcc9a2'], bayM: 3.2, floorM: 4.5, balconyEvery: 0, shopChance: 0, slots: {}
}]);
TLV.q.push(['style', {
  id: 'fountain_agam',
  tiles: { wall: 'agam_a', ground: 'agam_a', shop: 'agam_a', side: 'agam_a' },
  palette: ['#ffffff'], bayM: 1.3, floorM: 3.6, balconyEvery: 0, shopChance: 0, roofColour: '#d8402f',
  slots: { 'bld.rooftop': 'none', 'bld.balcony': 'none' }
}]);

// building=roof rows, which draw as thin slabs on posts. The map schema carries no such flag, so they are listed here,
// generated from the extract with: elements where tags.building === 'roof'. See the WP-RENDER report.
TLV.q.push(['style', {
  id: 'canopy', form: 'canopy',
  tiles: { wall: 'plain_a', ground: 'plain_a', shop: 'plain_a', side: 'plain_a' },
  palette: ['#efece6'], bayM: 5, floorM: 4, balconyEvery: 0, slots: {},
  osm: [
    'r15690215', 'w100946479', 'w1123196577', 'w1123196578', 'w1123196579', 'w1160230372', 'w1181513826',
    'w1182713660', 'w1185598188', 'w1185598189', 'w1185598190', 'w1186078069', 'w1186078072', 'w1186644502',
    'w1271301616', 'w1271301618', 'w183397867', 'w198665681', 'w200596810', 'w200596841', 'w200835030',
    'w238342869', 'w253482687', 'w265984729', 'w367142263', 'w496096187', 'w505904756', 'w507192589',
    'w507234138', 'w509870911', 'w510009732', 'w512050136', 'w564618573', 'w564622269', 'w659598297',
    'w691011961', 'w704700813', 'w860931334', 'w943958731', 'w943958732'
  ]
}]);
