// js/ui/audio.js — WP-UI
// All sound, synthesized with WebAudio. No file is loaded or shipped. No AudioContext exists until unlock(), which only a user gesture
// calls, so the page is silent until then. Everything is a short one-shot voice, except the engine, the skid and the surface rumble.
// WP-TRAFFIC measured 80 honks a minute reaching the bubble, so honks pass a rate cap and a range check.
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

  /**
   * Prepares audio, with no AudioContext: that waits for unlock.
   * @param {object} S Sim state.
   */
  audio.init = function (S) {
    var saved = TLV.ui.load(TLV.tune.ui.keyMute);
    muted = !!(S && S.params.mute) || saved === '1';
    if (ctx) audio.setMuted(muted);
  };

  /** Starts audio. Called from a user gesture. Safe to call on every key. */
  audio.unlock = function () {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    if (ctx) {
      if (ctx.state === 'suspended' && !paused) ctx.resume();
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
  };

  /** @param {boolean} on True to mute. */
  audio.setMuted = function (on) {
    muted = !!on;
    if (master) master.gain.setTargetAtTime(muted ? 0 : TLV.tune.ui.masterGain, ctx.currentTime, 0.02);
  };

  /** @returns {boolean} True when muted. */
  audio.isMuted = function () {
    return muted;
  };

  /** Stops the world's sound while paused. @param {boolean} on True to pause. */
  audio.setPaused = function (on) {
    paused = !!on;
    if (!ctx) return;
    if (paused) ctx.suspend();
    else ctx.resume();
  };

  /** @returns {object} State, for tests. */
  audio.info = function () {
    return { unlocked: !!ctx, muted: muted, state: ctx ? ctx.state : 'none', masterGain: master ? master.gain.value : 0, voices: voices, started: started };
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
    var base = 300 + (seed % 7) * 34;
    var dur = 0.16 + ((seed >>> 8) % 4) * 0.08;
    var gain = (p.atPlayer ? 0.24 : 0.12) * (0.25 + near * 0.75);
    var pan = -Math.sin(rel) * 0.8;
    tone(base, dur, { type: 'square', gain: gain, pan: pan });
    tone(base * 1.26, dur, { type: 'square', gain: gain * 0.8, pan: pan });
    if (seed % 3 === 0) {
      tone(base, dur, { type: 'square', gain: gain, pan: pan, at: dur + 0.09 });
      tone(base * 1.26, dur, { type: 'square', gain: gain * 0.8, pan: pan, at: dur + 0.09 });
    }
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
      case 'traffic.redRun':
        tone(420, 0.6, { type: 'square', gain: 0.06 });
        break;
      case 'traffic.honk':
        honkAt(S, p);
        break;
      case 'traffic.wreck':
        burst(0.3, { type: 'lowpass', freq: 1400, to: 200, gain: 0.14 });
        break;
      case 'traffic.door':
        tone(p.open ? 220 : 160, 0.09, { type: 'triangle', gain: 0.1 });
        break;
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

    horn.gain.gain.setTargetAtTime(live && veh.horn ? 0.16 : 0, now, 0.012);
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
    if (!ready() || muted) return;
    honkBudget = Math.min(2, honkBudget + dt * TLV.tune.ui.honksPerS);
    frameEngine(S);
    frameSignal(S, dt);
    frameTicks(S, dt);
  };
})(window.TLV);
