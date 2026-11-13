// js/manifest.js — WP-CORE
// The single source of load order for the browser and for Node (ARCHITECTURE 4.3). Do not add files here.
(function (TLV) {
  'use strict';

  TLV.manifest = {
    sim: [
      'js/core/constants.js', 'js/core/math.js', 'js/core/rng.js', 'js/core/events.js', 'js/core/config.js',
      'js/core/registry.js', 'js/core/invariants.js', 'js/core/replay.js', 'js/core/debug.js', 'js/core/sim.js', 'js/core/loop.js',
      'js/world/map_codec.js', 'js/world/anchors.js', 'js/world/tune.js', 'js/world/geom.js', 'js/world/map.js',
      'js/world/lanes.js', 'js/world/junctions.js', 'js/world/signals.js', 'js/world/spatial.js', 'js/world/surface.js',
      'js/world/sidewalks.js', 'js/world/props.js', 'js/world/parking.js', 'js/world/routing.js', 'js/world/world.js',
      'js/sim/player/tune.js', 'js/sim/player/vehicle.js', 'js/sim/player/collide.js', 'js/sim/player/foot.js', 'js/sim/player/bots.js',
      'js/sim/traffic/tune.js', 'js/sim/traffic/pool.js', 'js/sim/traffic/idm.js', 'js/sim/traffic/gate.js',
      'js/sim/traffic/lanechange.js', 'js/sim/traffic/behaviours.js', 'js/sim/traffic/spawner.js',
      'js/sim/traffic/deadlock.js', 'js/sim/traffic/diagnostics.js', 'js/sim/traffic/traffic.js',
      'js/sim/peds/tune.js', 'js/sim/peds/pool.js', 'js/sim/peds/walk.js', 'js/sim/peds/cross.js', 'js/sim/peds/riders.js', 'js/sim/peds/peds.js',
      'js/sim/game/tune.js', 'js/sim/game/nav.js', 'js/sim/game/errands.js', 'js/sim/game/score.js', 'js/sim/game/rage.js',
      'js/sim/game/rival.js', 'js/sim/game/parking.js', 'js/sim/game/attacker.js', 'js/sim/game/knife.js',
      'js/sim/game/fairness.js', 'js/sim/game/incidents.js', 'js/sim/game/director.js', 'js/sim/game/versus.js',
      'js/sim/game/flow.js'
    ],
    browser: [
      'js/input/input.js', 'js/net/net.js',
      'js/render/tune.js', 'js/render/coords.js', 'js/render/atlas.js', 'js/render/assets.js', 'js/render/mesh_format.js',
      'js/render/sky.js', 'js/render/ground.js', 'js/render/roads.js',
      'js/render/city/recipes.js', 'js/render/city/styles.js', 'js/render/city/facades.js', 'js/render/city/shells.js',
      'js/render/city/details.js', 'js/render/city/skyline.js', 'js/render/city/chunks.js',
      'js/render/signs.js', 'js/render/storefronts.js', 'js/render/landmarks.js', 'js/render/vehicles.js', 'js/render/people.js',
      'js/render/signal_heads.js', 'js/render/effects.js', 'js/render/camera.js', 'js/render/rearview.js', 'js/render/renderer.js',
      'js/ui/tune.js', 'js/ui/strings.js', 'js/ui/hud.js', 'js/ui/minimap.js', 'js/ui/cards.js', 'js/ui/versus.js', 'js/ui/menus.js',
      'js/ui/bubbles.js', 'js/ui/audio.js', 'js/ui/debug_overlay.js', 'js/ui/ui.js',
      'js/app/main.js'
    ]
  };
})(window.TLV);
