// js/ui/audio.js — WP-UI
// All sound. Horns are recordings: tools/pack_sounds.mjs packs them from assets_src/sounds into data/sounds/sounds.js as data URIs,
// because a sibling audio file on file:// cannot be fetched into WebAudio, and that script is injected only at unlock. Everything
// else is synthesized, and so are the horns until the recordings decode, or if they never do. No AudioContext exists until unlock(),
// which only a user gesture calls, so the page is silent until then. WP-TRAFFIC measured 80 honks a minute reaching the bubble, so
// honks pass a rate cap and a range check, and a far one is quieter and duller.
//
// The car radio plays a live stream from a random Israeli station, through a plain <audio> element: a stream from another origin has
// no CORS headers, and WebAudio would play it as silence. The station list is the built-in one below, joined by what the public
// radio-browser.info directory lists for Israel. Any station that fails is skipped for another. Offline, the radio stays quiet and
// the game does not notice.
(function (TLV) {
  'use strict';

  var audio = TLV.ns('audio');

  var ctx = null;
  var master = null;
  var fxBus = null;
  var noise = null;
  var engine = null;
  var skid = null;
  var rumble = null;
  var horn = null;
  var sampleHorn = null;
  var buffers = {};
  var soundsAsked = false;
  var muted = false;
  var paused = false;
  var voices = 0;
  var started = 0;
  var honkBudget = 2;
  var signalT = 0;
  var lightWas = null;
  var clockT = 0;
  var blinkT = 0;
  var heartT = 0;
  var surface = 0;

  /** @returns {boolean} True when sound can be made now. */
  function ready() {
    return !!ctx && !paused;
  }

  function makeNoise() {
    var seconds = 2;
    var buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    var data = buffer.getChannelData(0);
    for (var i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** A looped noise source through a filter, at gain 0. */
  function noiseLoop(type, freq, q) {
    var source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    var filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    var gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start();
    return { source: source, filter: filter, gain: gain };
  }

  function buildEngine() {
    var low = ctx.createOscillator();
    low.type = 'sawtooth';
    var high = ctx.createOscillator();
    high.type = 'square';
    var lowGain = ctx.createGain();
    lowGain.gain.value = 0.7;
    var highGain = ctx.createGain();
    highGain.gain.value = 0.22;
    var filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500;
    filter.Q.value = 2;
    var gain = ctx.createGain();
    gain.gain.value = 0;
    low.connect(lowGain);
    high.connect(highGain);
    lowGain.connect(filter);
    highGain.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    low.start();
    high.start();
    return { low: low, high: high, filter: filter, gain: gain };
  }

  function buildHorn() {
    var a = ctx.createOscillator();
    var b = ctx.createOscillator();
    a.type = 'square';
    b.type = 'square';
    a.frequency.value = 415;
    b.frequency.value = 523;
    var filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.7;
    var gain = ctx.createGain();
    gain.gain.value = 0;
    a.connect(filter);
    b.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    a.start();
    b.start();
    return { gain: gain };
  }

  /** The player's horn as a recording: a seamless loop of a real horn's steady tone, at gain 0 until H is held. */
  function buildSampleHorn() {
    if (sampleHorn || !buffers.car_hold) return;
    var source = ctx.createBufferSource();
    source.buffer = buffers.car_hold;
    source.loop = true;
    var gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(master);
    source.start();
    sampleHorn = { source: source, gain: gain };
  }

  /** @returns {?Uint8Array} The bytes of a base64 data URI. */
  function bytesOf(uri) {
    if (typeof uri !== 'string') return null;
    var comma = uri.indexOf(',');
    if (uri.slice(0, 5) !== 'data:' || comma < 0) return null;
    var bin;
    try {
      bin = window.atob(uri.slice(comma + 1));
    } catch (e) {
      return null;
    }
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Decodes every packed sound into an AudioBuffer, then lets the base64 go. A sound that will not decode stays synthesized. */
  function decodeSounds() {
    var all = TLV.sounds;
    TLV.sounds = null;
    if (!all || !ctx) return;
    Object.keys(all).forEach(function (id) {
      var bytes = bytesOf(all[id]);
      if (!bytes) return;
      var done = function (buf) {
        buffers[id] = buf;
        if (id === 'car_hold') buildSampleHorn();
      };
      try {
        // Old Safari only has the callback form, and a newer browser also returns a promise that must not reject unheard.
        var p = ctx.decodeAudioData(bytes.buffer, done, function () {});
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) {
        // Left to the synthesizer.
      }
    });
  }

  /** Injects data/sounds/sounds.js once. If it is missing, every horn stays synthesized. */
  function loadSounds() {
    if (soundsAsked) return;
    soundsAsked = true;
    if (TLV.sounds) {
      decodeSounds();
      return;
    }
    var index = TLV.soundIndex;
    if (!index || typeof index.src !== 'string' || typeof document === 'undefined') return;
    var script = document.createElement('script');
    script.src = index.src;
    script.async = true;
    script.onload = decodeSounds;
    script.onerror = function () {};
    document.head.appendChild(script);
  }

  /**
   * Prepares audio, with no AudioContext: that waits for unlock.
   * @param {object} S Sim state.
   */
  audio.init = function (S) {
    var saved = TLV.ui.load(TLV.tune.ui.keyMute);
    muted = !!(S && S.params.mute) || saved === '1';
    radioInit(S);
    if (ctx) audio.setMuted(muted);
  };

  /** Starts audio. Called from a user gesture. Safe to call on every key. */
  audio.unlock = function () {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    if (ctx) {
      if (ctx.state === 'suspended' && !paused) ctx.resume();
      radioGesture();
      return;
    }
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : TLV.tune.ui.masterGain;
    var limiter = ctx.createDynamicsCompressor();
    master.connect(limiter);
    limiter.connect(ctx.destination);
    fxBus = master;
    noise = makeNoise();
    engine = buildEngine();
    horn = buildHorn();
    skid = noiseLoop('bandpass', 1900, 3.5);
    rumble = noiseLoop('lowpass', 220, 0.5);
    if (ctx.state === 'suspended') ctx.resume();
    loadSounds();
    radioGesture();
  };

  /** @param {boolean} on True to mute. */
  audio.setMuted = function (on) {
    muted = !!on;
    if (master) master.gain.setTargetAtTime(muted ? 0 : TLV.tune.ui.masterGain, ctx.currentTime, 0.02);
    radioSync();
  };

  /** @returns {boolean} True when muted. */
  audio.isMuted = function () {
    return muted;
  };

  /** Stops the world's sound while paused. @param {boolean} on True to pause. */
  audio.setPaused = function (on) {
    paused = !!on;
    radioSync();
    if (!ctx) return;
    if (paused) ctx.suspend();
    else ctx.resume();
  };

  /** @returns {object} State, for tests. */
  audio.info = function () {
    return { unlocked: !!ctx, muted: muted, state: ctx ? ctx.state : 'none', masterGain: master ? master.gain.value : 0, voices: voices, started: started,
      samples: Object.keys(buffers).sort(), radio: audio.radioInfo() };
  };

  function pannerTo(gain, pan) {
    if (pan === undefined || pan === 0 || !ctx.createStereoPanner) {
      gain.connect(fxBus);
      return;
    }
    var panner = ctx.createStereoPanner();
    panner.pan.value = TLV.math.clamp(pan, -1, 1);
    gain.connect(panner);
    panner.connect(fxBus);
  }

  /** Counts a voice, and refuses when too many ring at once. */
  function claim(node) {
    if (voices >= TLV.tune.ui.voicesMax) return false;
    voices++;
    started++;
    node.onended = function () {
      voices--;
    };
    return true;
  }

  /**
   * One tone with an envelope.
   * @param {number} freq Hz.
   * @param {number} dur Seconds.
   * @param {object} [o] { type, gain, at, to, pan, attack }: `at` is a delay, `to` a frequency to slide to.
   */
  function tone(freq, dur, o) {
    if (!ready()) return;
    var opt = o || {};
    var t0 = ctx.currentTime + (opt.at || 0);
    var osc = ctx.createOscillator();
    if (!claim(osc)) return;
    osc.type = opt.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (opt.to) osc.frequency.exponentialRampToValueAtTime(opt.to, t0 + dur);
    var gain = ctx.createGain();
    var peak = opt.gain === undefined ? 0.2 : opt.gain;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + (opt.attack || 0.006));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    pannerTo(gain, opt.pan);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /**
   * One burst of filtered noise.
   * @param {number} dur Seconds.
   * @param {object} [o] { type, freq, to, q, gain, at, pan }.
   */
  function burst(dur, o) {
    if (!ready()) return;
    var opt = o || {};
    var t0 = ctx.currentTime + (opt.at || 0);
    var source = ctx.createBufferSource();
    if (!claim(source)) return;
    source.buffer = noise;
    var filter = ctx.createBiquadFilter();
    filter.type = opt.type || 'lowpass';
    filter.frequency.setValueAtTime(opt.freq || 800, t0);
    if (opt.to) filter.frequency.exponentialRampToValueAtTime(opt.to, t0 + dur);
    filter.Q.value = opt.q || 1;
    var gain = ctx.createGain();
    var peak = opt.gain === undefined ? 0.3 : opt.gain;
    gain.gain.setValueAtTime(peak, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    source.connect(filter);
    filter.connect(gain);
    pannerTo(gain, opt.pan);
    source.start(t0, Math.random() * 1.5, dur + 0.05);
  }

  /** Impact by severity: a body thump, and metal or glass on top of the bigger ones. */
  function impact(severity) {
    var big = severity === 'crash' ? 1 : (severity === 'bump' ? 0.65 : 0.3);
    tone(120 * (1 + big * 0.2), 0.18 + big * 0.22, { to: 40, gain: 0.5 * big + 0.1, type: 'triangle' });
    burst(0.08 + big * 0.25, { type: 'lowpass', freq: 2400, to: 300, gain: 0.5 * big + 0.12 });
    if (severity === 'scrape') burst(0.22, { type: 'bandpass', freq: 3200, q: 6, gain: 0.2 });
    if (severity === 'crash') burst(0.35, { type: 'highpass', freq: 3800, gain: 0.16, at: 0.04 });
  }

  /**
   * One recorded sound.
   * @param {string} id Packed sound ID.
   * @param {object} o { rate, gain, pan, at, cutoff, hold }: `cutoff` is a lowpass in Hz, `hold` plays a loop for that many seconds.
   * @returns {boolean} True when the recording is there, whether or not a voice was free for it.
   */
  function sample(id, o) {
    var buf = buffers[id];
    if (!buf) return false;
    if (!ready()) return true;
    var source = ctx.createBufferSource();
    if (!claim(source)) return true;
    source.buffer = buf;
    source.playbackRate.value = o.rate || 1;
    var t0 = ctx.currentTime + (o.at || 0);
    var gain = ctx.createGain();
    var node = source;
    if (o.cutoff) {
      var filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = o.cutoff;
      source.connect(filter);
      node = filter;
    }
    node.connect(gain);
    pannerTo(gain, o.pan);
    if (o.hold) {
      source.loop = true;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(o.gain, t0 + 0.012);
      gain.gain.setValueAtTime(o.gain, t0 + o.hold);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + o.hold + 0.07);
      source.start(t0);
      source.stop(t0 + o.hold + 0.09);
    } else {
      gain.gain.value = o.gain;
      source.start(t0);
    }
    return true;
  }

  /**
   * A car keeps one horn for its life. Small cars get the car horn, up or down a little, or the bus horn pitched up into a car's range.
   * Buses and trucks get the bus horn near its own pitch.
   * @returns {{family: string, rate: number, short: string}} The voice.
   */
  function hornVoice(S, p, seed) {
    var veh = TLV.ui.hud && TLV.ui.hud.findVehicle ? TLV.ui.hud.findVehicle(S, p.vehId) : null;
    var kind = veh ? veh.kind : null;
    if (kind === 'bus' || kind === 'truck') return { family: 'bus', rate: 0.93 + (seed % 5) * 0.03, short: 'bus_toot' };
    if (seed % 5 < 2) return { family: 'bus', rate: 1.3 + ((seed >>> 3) % 6) * 0.06, short: 'bus_toot' };
    return { family: 'car', rate: 0.84 + ((seed >>> 3) % 8) * 0.045, short: seed % 2 ? 'car_a' : 'car_b' };
  }

  /** A recorded honk. @returns {boolean} False when the recordings are not in. */
  function honkSample(S, p, seed, gain, pan, cutoff) {
    var voice = hornVoice(S, p, seed);
    var o = { rate: voice.rate, gain: gain, pan: pan, cutoff: cutoff };
    var roll = Math.random();
    // At the player it is meant: more of them come in twos and threes, and some lean on it.
    var pattern = p.atPlayer ? (roll < 0.15 ? 'one' : roll < 0.55 ? 'two' : roll < 0.8 ? 'three' : 'lean') :
      (roll < 0.6 ? 'one' : roll < 0.9 ? 'two' : 'lean');
    if (voice.family === 'bus') {
      var id = { one: 'bus_toot', two: 'bus_double', three: 'bus_triple', lean: 'bus_long' }[pattern];
      if (pattern === 'lean' && !p.atPlayer) id = 'bus_double';
      return sample(id, o);
    }
    if (!buffers[voice.short]) return false;
    if (pattern === 'lean' && buffers.car_hold) {
      o.hold = 0.6 + Math.random() * 0.8;
      return sample('car_hold', o);
    }
    var hits = pattern === 'three' ? 3 : pattern === 'two' ? 2 : 1;
    var gap = 0.2 / voice.rate;
    for (var i = 0; i < hits; i++) {
      o.at = i * gap;
      sample(voice.short, o);
    }
    return true;
  }

  /** A car horn from somewhere else in the street. */
  function honkAt(S, p) {
    var T = TLV.tune.ui;
    if (!ready() || honkBudget < 1) return;
    var player = S.player;
    var dx = p.x - player.fx;
    var dy = p.y - player.fy;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d > T.honkRangeM) return;
    honkBudget -= 1;
    var rel = TLV.math.wrapPi(Math.atan2(dy, dx) - TLV.ui.viewYaw(S));
    var near = 1 - d / T.honkRangeM;
    var seed = (p.vehId * 2654435761) >>> 0;
    var pan = -Math.sin(rel) * 0.8;
    var level = (p.atPlayer ? T.honkSampleGainAt : T.honkSampleGain) * (0.12 + 0.88 * near * near);
    if (honkSample(S, p, seed, level, pan, T.honkDullHz + (T.honkClearHz - T.honkDullHz) * near)) return;
    var base = 300 + (seed % 7) * 34;
    var dur = 0.16 + ((seed >>> 8) % 4) * 0.08;
    var gain = (p.atPlayer ? 0.24 : 0.12) * (0.25 + near * 0.75);
    tone(base, dur, { type: 'square', gain: gain, pan: pan });
    tone(base * 1.26, dur, { type: 'square', gain: gain * 0.8, pan: pan });
    if (seed % 3 === 0) {
      tone(base, dur, { type: 'square', gain: gain, pan: pan, at: dur + 0.09 });
      tone(base * 1.26, dur, { type: 'square', gain: gain * 0.8, pan: pan, at: dur + 0.09 });
    }
  }

  /** @returns {number} 0 to 1: how near a point is, for the sounds that carry a place. Without one, as near as can be. */
  function nearness(S, p, rangeM) {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || !S || !S.player) return 1;
    var dx = p.x - S.player.fx;
    var dy = p.y - S.player.fy;
    return TLV.math.clamp(1 - Math.sqrt(dx * dx + dy * dy) / rangeM, 0, 1);
  }

  function ding(freq, at, gain) {
    tone(freq, 0.5, { type: 'sine', gain: gain, at: at });
    tone(freq * 2.76, 0.22, { type: 'sine', gain: gain * 0.35, at: at });
  }

  function arpeggio(list, gap, gain, type) {
    list.forEach(function (f, i) {
      tone(f, 0.24, { type: type || 'triangle', gain: gain, at: i * gap });
    });
  }

  function whistle(at) {
    for (var i = 0; i < 5; i++) tone(2600 + (i % 2) * 280, 0.07, { type: 'sine', gain: 0.1, at: at + i * 0.07 });
  }

  /**
   * Plays a UI sound.
   * @param {string} name 'click', 'tick', 'phone', 'cash', 'warn', 'win' or 'lose'.
   */
  audio.ui = function (name) {
    switch (name) {
      case 'click': tone(660, 0.07, { type: 'triangle', gain: 0.14 }); break;
      case 'tick': tone(980, 0.05, { type: 'square', gain: 0.07 }); break;
      case 'phone':
        tone(1320, 0.1, { gain: 0.16 });
        tone(1760, 0.14, { gain: 0.16, at: 0.11 });
        break;
      case 'cash': arpeggio([988, 1319, 1760], 0.07, 0.14, 'square'); break;
      case 'warn':
        tone(880, 0.12, { type: 'square', gain: 0.12 });
        tone(880, 0.12, { type: 'square', gain: 0.12, at: 0.16 });
        break;
      case 'win': arpeggio([523, 659, 784, 1047, 1319], 0.1, 0.18); break;
      case 'lose': arpeggio([392, 330, 262, 196], 0.14, 0.18); break;
      default: break;
    }
  };

  function resultSound(p) {
    if (p.winner === 'player') {
      if (p.tier === 'CURSE') tone(190, 0.3, { type: 'sawtooth', gain: 0.14, to: 120 });
      else if (p.tier === 'BLOCK') tone(150, 0.5, { type: 'sawtooth', gain: 0.16, to: 110 });
      else if (p.tier === 'KNIFE') tone(110, 0.8, { type: 'sawtooth', gain: 0.22, to: 60 });
    } else if (p.winner === 'rival') {
      arpeggio([294, 262], 0.16, 0.14);
    }
  }

  function exitSound(p) {
    if (p.exit === 'CAUGHT') audio.ui('lose');
    else if (p.exit === 'WHISTLE') whistle(0);
    else audio.ui('cash');
  }

  /**
   * Reacts to one event. Each row of ui.EVENTS that names audio lands here.
   * @param {object} S Sim state.
   * @param {string} name Event name.
   * @param {object} p Payload.
   */
  audio.onEvent = function (S, name, p) {
    if (!ctx) return;
    switch (name) {
      case 'player.contact': impact(p.severity); break;
      case 'player.hitPed':
        tone(90, 0.5, { type: 'sine', gain: 0.5, to: 45 });
        break;
      case 'player.nearMiss':
        burst(0.32, { type: 'bandpass', freq: 500, to: 3200, q: 1.2, gain: p.tier === 2 ? 0.34 : 0.24 });
        break;
      case 'player.surface': surface = p.surface; break;
      case 'player.brushPed': tone(520, 0.08, { type: 'triangle', gain: 0.1, to: 360 }); break;
      case 'player.horn': break;
      case 'player.launch': burst(0.5, { type: 'bandpass', freq: 400, to: 2200, q: 2, gain: 0.26 }); break;
      case 'traffic.redRun': {
        // A run nobody nearby could see is a rumour, not a sound.
        var seen = nearness(S, p, TLV.tune.ui.redRunRangeM);
        if (seen > 0) tone(420, 0.6, { type: 'square', gain: 0.06 * (0.3 + 0.7 * seen) });
        break;
      }
      case 'traffic.honk':
        honkAt(S, p);
        break;
      case 'traffic.wreck':
        burst(0.3, { type: 'lowpass', freq: 1400, to: 200, gain: 0.14 });
        break;
      case 'traffic.door': {
        var close = nearness(S, p, TLV.tune.ui.doorRangeM);
        if (close > 0) tone(p.open ? 220 : 160, 0.09, { type: 'triangle', gain: 0.1 * close });
        break;
      }
      case 'ped.bell': ding(2300, 0, 0.11); ding(2300, 0.16, 0.09); break;
      case 'errand.start': audio.ui('phone'); break;
      case 'errand.parked':
        burst(0.18, { type: 'bandpass', freq: 1200, q: 8, gain: 0.14 });
        if (p.pay) audio.ui('cash');
        break;
      case 'inspector.ticket': whistle(0); break;
      case 'contest.start': arpeggio([440, 554], 0.1, 0.1, 'square'); break;
      case 'contest.result': resultSound(p); break;
      case 'knife.stage':
        if (p.stage === 'STANDOFF') tone(380, 1.3, { type: 'square', gain: 0.16 });
        else if (p.stage === 'DOOR_TUG') burst(0.14, { type: 'lowpass', freq: 700, gain: 0.3 });
        else if (p.stage === 'BAIL' || p.stage === 'DRAGGED') burst(0.2, { type: 'lowpass', freq: 1000, gain: 0.26 });
        break;
      case 'knife.lunge':
        if (p.phase === 'WINDUP') tone(300, 0.5, { type: 'sawtooth', gain: 0.1, to: 900 });
        else if (p.phase === 'STRIKE') burst(0.16, { type: 'bandpass', freq: 3000, to: 900, q: 2, gain: 0.26 });
        break;
      case 'knife.strike':
        tone(700, 0.24, { type: 'triangle', gain: 0.3, to: 160 });
        break;
      case 'knife.exit': exitSound(p); break;
      case 'incident.telegraph': tone(740, 0.1, { type: 'square', gain: 0.07 }); break;
      case 'score.bonus': arpeggio([1175, 1568], 0.06, 0.12, 'square'); break;
      case 'clock.warn': audio.ui('warn'); break;
      case 'run.start': arpeggio([523, 659, 784], 0.08, 0.14); break;
      case 'run.end': audio.ui(p.reason === 'WIN' ? 'win' : 'lose'); break;
      default: break;
    }
  };

  function frameEngine(S) {
    var T = TLV.tune.ui;
    var veh = S.vehicles[0];
    var g = S.game;
    var now = ctx.currentTime;
    var onFoot = S.player.mode === 'FOOT';
    var live = g && g.phase !== 'TITLE' && g.phase !== 'RUN_END' && !onFoot;
    var v = Math.abs(veh.v);
    var gear = 0;
    while (gear < T.gears.length - 2 && v >= T.gears[gear + 1]) gear++;
    var span = T.gears[gear + 1] - T.gears[gear];
    var rev = TLV.math.clamp((v - T.gears[gear]) / span, 0, 1);
    var hz = T.engineIdleHz + (gear === 0 && v < 0.5 ? 0 : (0.25 + 0.75 * rev) * T.engineSpanHz * (1 + gear * T.engineGearStepHz));
    engine.low.frequency.setTargetAtTime(hz, now, 0.04);
    engine.high.frequency.setTargetAtTime(hz * 1.5, now, 0.04);
    engine.filter.frequency.setTargetAtTime(260 + hz * 4, now, 0.05);
    var push = TLV.math.clamp(Math.max(0, veh.accel || 0) / 6, 0, 1);
    engine.gain.gain.setTargetAtTime(live ? 0.05 + 0.05 * rev + 0.07 * push : 0, now, 0.06);

    var slip = Math.abs(-Math.sin(veh.h) * veh.vx + Math.cos(veh.h) * veh.vy);
    var skidLevel = live ? TLV.math.clamp((slip - T.skidSlip) / (T.skidFullSlip - T.skidSlip), 0, 1) : 0;
    skid.gain.gain.setTargetAtTime(skidLevel * 0.24, now, 0.03);

    var bumpy = surface !== TLV.const.SURF.ROAD && live;
    rumble.gain.gain.setTargetAtTime(bumpy ? TLV.math.clamp(v / 14, 0, 1) * 0.3 : 0, now, 0.08);

    var pressed = live && veh.horn;
    if (sampleHorn) {
      sampleHorn.gain.gain.setTargetAtTime(pressed ? T.hornSampleGain : 0, now, pressed ? 0.004 : 0.025);
      horn.gain.gain.setTargetAtTime(0, now, 0.012);
    } else {
      horn.gain.gain.setTargetAtTime(pressed ? 0.16 : 0, now, 0.012);
    }
  }

  /** Ticks for the player's light: a slow tick at red, and a chime on green, so an ear can launch too. */
  function frameSignal(S, dt) {
    var T = TLV.tune.ui;
    var signals = TLV.world.signals;
    var lane = S.player.laneId;
    var g = S.game;
    var driving = g && (g.phase === 'DRIVE' || g.phase === 'CARD' || g.phase === 'SEARCH');
    if (!driving || lane === undefined || lane < 0 || !signals.laneState) {
      lightWas = null;
      return;
    }
    var state = signals.laneState(S, lane);
    var red = state === TLV.const.SIG.RED;
    var stopped = Math.abs(S.vehicles[0].v) < 1;
    if (red && stopped) {
      signalT -= dt;
      if (signalT <= 0) {
        signalT = T.signalTickS;
        tone(1500, 0.03, { type: 'square', gain: 0.045 });
      }
    }
    if (lightWas === TLV.const.SIG.RED && state === TLV.const.SIG.GREEN && stopped) tone(1760, 0.16, { gain: 0.14 });
    lightWas = state;
  }

  /** The clock tick in the last ten seconds, the hazard relay, and the heartbeat of the chase. */
  function frameTicks(S, dt) {
    var T = TLV.tune.ui;
    var g = S.game;
    if (!g) return;
    var running = g.phase === 'DRIVE' || g.phase === 'SEARCH' || g.phase === 'HOLD';
    if (running && g.clock <= TLV.tune.game.clockWarn2) {
      clockT -= dt;
      if (clockT <= 0) {
        clockT = T.clockTickS;
        tone(1200, 0.05, { type: 'square', gain: 0.1 });
      }
    }
    var lights = S.vehicles[0].lights || 0;
    if (lights & (TLV.const.VL.HAZARD | TLV.const.VL.BLINK_L | TLV.const.VL.BLINK_R)) {
      blinkT -= dt;
      if (blinkT <= 0) {
        blinkT = 0.36;
        tone(2200, 0.018, { type: 'square', gain: 0.05 });
      }
    }
    var k = g.knife;
    if (k && k.stage === 'CHASE') {
      heartT -= dt;
      if (heartT <= 0) {
        var near = TLV.math.clamp((k.gap - T.heartNearM) / (T.heartFarM - T.heartNearM), 0, 1);
        heartT = TLV.math.lerp(T.heartMinS, T.heartMaxS, near);
        tone(62, 0.13, { gain: 0.5 });
        tone(52, 0.15, { gain: 0.36, at: 0.17 });
      }
    }
  }

  /**
   * Updates the continuous sounds.
   * @param {object} S Sim state.
   * @param {number} dt Seconds, 0 while paused.
   */
  audio.frame = function (S, dt) {
    radioFrame(S);
    if (!ready() || muted) return;
    honkBudget = Math.min(2, honkBudget + dt * TLV.tune.ui.honksPerS);
    frameEngine(S);
    frameSignal(S, dt);
    frameTicks(S, dt);
  };

  // ---- The car radio. ---------------------------------------------------------------------------------------------------

  /**
   * Stations that were live when this list was written (2026-11), HTTPS MP3 or AAC, none of them HLS. Some refuse listeners outside
   * Israel. radio-browser.info adds more at run time.
   */
  var STATIONS = [
    { name: 'Galgalatz', he: 'גלגלצ', url: 'https://glzwizzlv.bynetcdn.com/glglz_mp3' },
    { name: 'Galei Tzahal', he: 'גלי צה"ל', url: 'https://glzwizzlv.bynetcdn.com/glz_mp3' },
    { name: 'Kan Gimel', he: 'כאן גימל', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/KAN_GIMMEL.mp3' },
    { name: 'Kan Bet', he: 'כאן ב', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/KAN_BET.mp3' },
    { name: 'Kan 88', he: 'כאן 88', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/KAN_88.mp3' },
    { name: 'Kan Tarbut', he: 'כאן תרבות', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/KAN_TARBUT.mp3' },
    { name: '103FM', he: '103FM', url: 'https://cdn.cybercdn.live/103FM/Live/icecast.audio' },
    { name: 'Eco 99FM', he: 'אקו 99', url: 'https://eco-live.mediacast.co.il/99fm_aac' },
    { name: '102FM Radio Tel Aviv', he: '102FM רדיו תל אביב', url: 'https://102.livecdn.biz/102fm_aac' },
    { name: 'Radios 100FM', he: 'רדיוס 100FM', url: 'https://cdn.cybercdn.live/Radios_100FM/Audio/icecast.audio' },
    { name: 'Radios Nostalgia 96.3', he: 'רדיוס נוסטלגי 96.3', url: 'https://cdna.streamgates.net/radios-audio/Nostalgia_963fm/icecast.audio' },
    { name: 'Galey Israel', he: 'גלי ישראל', url: 'https://cdn.cybercdn.live/Galei_Israel/Live/icecast.audio' },
    { name: 'Radio Darom 101.5', he: 'רדיו דרום 101.5', url: 'https://cdn.cybercdn.live/Darom_1015FM/Live/icecast.audio' },
    { name: 'Kol Rega', he: 'קול רגע', url: 'https://cdn.cybercdn.live/Kol_Rega/Live_Audio/icecast.audio' },
    { name: 'Radio Haifa', he: 'רדיו חיפה', url: 'https://1075.livecdn.biz/radiohaifa' },
    { name: 'Kol Chai', he: 'קול חי', url: 'https://media2.93fm.co.il/live-new' }
  ];

  /** The public station directory. Each mirror is tried in turn. */
  var RADIO_API = ['https://de1.api.radio-browser.info', 'https://de2.api.radio-browser.info', 'https://all.api.radio-browser.info'];
  var RADIO_QUERY = '/json/stations/search?countrycode=IL&hidebroken=true&is_https=true&order=votes&reverse=true&limit=120';

  var radio = {
    allowed: false,   // the page may play it: ?radio, and not a driven browser on auto
    on: true,         // the player's choice, B
    el: null,
    pool: STATIONS.slice(),
    asked: false,
    station: null,
    state: 'off',     // off, tuning, playing, blocked, failed
    since: 0,
    fails: 0,
    tried: {},
    announced: false,
    haltedAt: 0
  };

  function nowS() {
    return (window.performance && window.performance.now ? window.performance.now() : Date.now()) / 1000;
  }

  /** @returns {boolean} True when the radio should be sounding now. */
  function radioWanted() {
    return radio.allowed && radio.on && !muted && !paused && !!ctx;
  }

  function radioInit(S) {
    var mode = S && S.params ? S.params.radio : 'auto';
    var driven = !!(window.navigator && window.navigator.webdriver);
    radio.allowed = mode === 'on' || (mode !== 'off' && !driven && typeof window.Audio === 'function');
    radio.on = TLV.ui.load(TLV.tune.ui.keyRadio) !== '0';
  }

  /** @returns {boolean} True when the line was shown: the HUD is up. */
  function say(key, vars) {
    var ui = TLV.ui;
    if (!ui || !ui.hud || !ui.hud.isLive || !ui.hud.isLive()) return false;
    ui.hud.toast(ui.strings.t(key, vars));
    return true;
  }

  /** @returns {string} A station's name in the language on screen. */
  function stationName(st) {
    return TLV.ui.strings.lang() === 'he' && st.he ? st.he : st.name;
  }

  /** Joins the directory's Israeli stations to the built-in list, once. A failed lookup leaves the built-in list. */
  function askDirectory() {
    if (radio.asked || typeof window.fetch !== 'function') return;
    radio.asked = true;
    var i = 0;
    var next = function () {
      if (i >= RADIO_API.length) return;
      window.fetch(RADIO_API[i++] + RADIO_QUERY).then(function (r) {
        if (!r.ok) throw new Error('status ' + r.status);
        return r.json();
      }).then(addStations, next);
    };
    next();
  }

  function addStations(list) {
    if (!Array.isArray(list)) return;
    var known = {};
    radio.pool.forEach(function (st) { known[st.url] = true; });
    list.forEach(function (s) {
      if (!s || typeof s.url_resolved !== 'string' || typeof s.name !== 'string') return;
      var url = s.url_resolved.trim();
      var codec = String(s.codec || '').toUpperCase();
      if (url.slice(0, 8) !== 'https://' || s.hls || s.lastcheckok !== 1 || known[url]) return;
      if (codec !== 'MP3' && codec !== 'AAC' && codec !== 'AAC+') return;
      var name = s.name.replace(/\s+/g, ' ').trim().slice(0, 48);
      if (!name) return;
      known[url] = true;
      radio.pool.push({ name: name, he: name, url: url });
    });
  }

  function element() {
    if (radio.el) return radio.el;
    var el = radio.el = new window.Audio();
    el.preload = 'none';
    el.volume = 0;
    el.addEventListener('playing', function () {
      radio.state = 'playing';
      radio.fails = 0;
    });
    el.addEventListener('error', function () {
      if (radio.state === 'tuning' || radio.state === 'playing') radioSkip();
    });
    return el;
  }

  /** @returns {object} A station at random, one not tried this round if there is one. */
  function pickStation() {
    var fresh = radio.pool.filter(function (st) { return !radio.tried[st.url] && st !== radio.station; });
    if (!fresh.length) {
      radio.tried = {};
      fresh = radio.pool.filter(function (st) { return st !== radio.station; });
    }
    return fresh[Math.floor(Math.random() * fresh.length)] || radio.pool[0];
  }

  /** Plays a station from its live edge. */
  function tune(st) {
    var el = element();
    radio.station = st;
    radio.tried[st.url] = true;
    radio.state = 'tuning';
    radio.since = nowS();
    radio.announced = false;
    el.src = st.url;
    var played = el.play();
    if (played && typeof played.catch === 'function') {
      played.catch(function (e) {
        // A halt or another station cut this one off, which is no fault of the station.
        if (radio.station !== st || radio.state !== 'tuning' || (e && e.name === 'AbortError')) return;
        // No gesture yet: wait for the next key. Anything else is a dead station.
        if (e && e.name === 'NotAllowedError') radio.state = 'blocked';
        else radioSkip();
      });
    }
  }

  /** The station failed or went quiet: another one, until too many in a row have. */
  function radioSkip() {
    if (!radioWanted()) {
      radioHalt();
      return;
    }
    radio.fails++;
    if (radio.fails > TLV.tune.ui.radioMaxFails) {
      radio.state = 'failed';
      if (radio.el) radio.el.removeAttribute('src');
      say('radio.none');
      return;
    }
    tune(pickStation());
  }

  /** Stops the sound and the download. A live stream picked up again starts from now, not from where it stopped. */
  function radioHalt() {
    if (!radio.el || radio.state === 'off') return;
    radio.el.pause();
    radio.el.removeAttribute('src');
    radio.el.load();
    radio.state = 'off';
    radio.haltedAt = nowS();
  }

  /** Brings the radio in line with mute, pause and the player's choice. */
  function radioSync() {
    if (!radio.allowed) return;
    if (!radioWanted()) {
      radioHalt();
      return;
    }
    if (radio.state === 'off' || radio.state === 'blocked') {
      askDirectory();
      tune(radio.station || pickStation());
    }
  }

  /** A key or click: the moment a browser lets a page start sound. */
  function radioGesture() {
    if (radio.state === 'failed') return;
    radioSync();
  }

  /** Volume follows where the player is: full in the car, faint through the door on foot, low behind the menus. */
  function radioFrame(S) {
    if (!radio.el || radio.state === 'off' || radio.state === 'failed') return;
    var T = TLV.tune.ui;
    if (radio.state === 'tuning' && nowS() - radio.since > T.radioTuneS) {
      radioSkip();
      return;
    }
    var g = S && S.game;
    var phase = g ? g.phase : 'TITLE';
    var onFoot = S && S.player && S.player.mode === 'FOOT';
    var level = T.radioGain * (phase === 'TITLE' || phase === 'RUN_END' ? T.radioMenuShare : onFoot ? T.radioFootShare : 1);
    var v = radio.el.volume;
    radio.el.volume = TLV.math.clamp(v + (level - v) * 0.15, 0, 1);
    // A station found behind the title card is named once the HUD is up.
    if (radio.state === 'playing' && !radio.announced && radio.station) radio.announced = say('radio.on', { name: stationName(radio.station) });
  }

  /** N: another station. Turns the radio on if it was off. */
  audio.radioNext = function () {
    if (!radio.allowed) return;
    if (!radio.on) {
      audio.radioToggle();
      return;
    }
    radio.fails = 0;
    if (!radioWanted()) return;
    askDirectory();
    say('radio.tuning');
    tune(pickStation());
  };

  /** B: radio on or off, remembered. */
  audio.radioToggle = function () {
    if (!radio.allowed) return;
    radio.on = !radio.on;
    TLV.ui.save(TLV.tune.ui.keyRadio, radio.on ? '1' : '0');
    if (!radio.on) {
      radioHalt();
      say('radio.off');
      return;
    }
    radio.fails = 0;
    if (radio.state === 'failed') radio.state = 'off';
    say('radio.tuning');
    radioSync();
  };

  /** @returns {object} The radio's state, for tests and the debug overlay. */
  audio.radioInfo = function () {
    return { allowed: radio.allowed, on: radio.on, state: radio.state, station: radio.station ? radio.station.name : null,
      stations: radio.pool.length, volume: radio.el ? radio.el.volume : 0 };
  };
})(window.TLV);
