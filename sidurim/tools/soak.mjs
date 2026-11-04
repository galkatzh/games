#!/usr/bin/env node
// tools/soak.mjs — WP-CORE
// Headless soak matrix (ARCHITECTURE 17.2, 17.3): one sim per child process, no browser.
//
//   node tools/soak.mjs --seeds 1-20 --bots patrol,idle,chaos --n 100,120 --minutes 15 --jobs 14 [--map tlv_center] [--inject trap]
//   node tools/soak.mjs --seeds 1-20 --bots errands,braker --minutes 15 --jobs 14
//   node tools/soak.mjs --seeds 1-96 --bots errands --minutes 15 --jobs 14      (the run that judges the Contest gate)
//
// The rule behind this file: a soak that did not really run must never look like a pass. Zsh does not word-split $VAR, and
// that silently produced invalid runs in both design phases: spawning failed and results looked plausible. So arguments only
// ever travel through argv, with no shell. Every value is checked and bad flags stop the run. Each child reports the config
// it really ran, and the parent compares that with what it asked for. A job that dies is a failure. Realised density under
// 90% of target is a failure, over the whole run or over its last 60 sim-seconds. A gate that has no data is a failure too,
// unless --allow-skip says otherwise.
//
// The sim is the thing under test, so its numbers prove nothing by themselves. Cars are counted here, not taken from stats. With
// no --n the target has to come from the sim, so it must also clear a floor from the contract. A number that is not finite is
// counted and fails its gate, because every comparison with NaN is false and JSON turns it into null.
//
// Extra flags, for tests and partial trees:
//   --stub <file>     Classic script loaded after js/core only, replacing every other package. Must exist. The only flag that
//                     repeats: any other given twice is refused, because a silent last-one-wins runs something else.
//   --out <file>      Report path, instead of tools/reports/soak/<timestamp>.json. Checked before any job starts.
//   --allow-skip      A gate with no data is SKIP, not FAIL. Use it only while a package is missing.
//   --warmup-s <n>    Sim seconds before sampling starts. Default 60.
//   --timeout-s <n>   Wall-clock limit per job. Default 1800.
//   --heap-minutes <n>  Length of the memory probe. Default 60. See below.
//
// Memory. Every heap sample is taken straight after a gc(), so it is what is still reachable. Over a job's first 15 sim-min the post-gc
// heap climbs 1.2-2.2 MB per 10 sim-min, and that climb is V8 settling, not the sim: on 80 sim-min runs with a census of everything
// reachable from S, the census is flat from minute 40 (110,558 to 110,575 objects) while the heap's growth is code and metadata, and the
// slope falls to 0.10-0.26. So the 15 sim-min slope is reported, and the gate reads a probe: one more job per bot and density, on the
// first seed, --heap-minutes long, with its slope fitted after the first half. A real leak grows through the whole of that window, and
// the limit stays 1 MB per 10 sim-min. A matrix with no probe is judged on its own 15 sim-min slopes, as it was.
//
// Contest. The rates are a share of contests, and a gate on about 90 of them has a standard error of about 4%, so one line that only
// moved trajectories took seeds 1-20 from 88.9% to 77.4% while 322 held-out contests read 87.6%. Owner's decision: the limits stand, and
// they are judged on at least 300 contests. Under that the gate says NOT JUDGED with its n, which fails nothing and passes nothing.
//
// Exit codes: 0 all gates pass, 1 a gate failed or the report could not be written, 2 bad arguments.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(SELF), '..');

const BOTS = ['idle', 'patrol', 'chaos', 'braker', 'errands'];
const MIN_REALISED = 0.9;
const RESULT_PREFIX = 'SOAK_RESULT ';

/** Behaviours with an ambient trigger (GAME_DESIGN 9). HONK is an action, counted from traffic.honk. */
const AMBIENT_BEHAVIOURS = [
  'RED_RUN', 'HONK', 'TAILGATE', 'NOSE_IN', 'OVERTAKE_OUT', 'OVERTAKE_PASS', 'CUT_IN', 'PHANTOM_STOP',
  'DROP_APPROACH', 'DROPPED', 'PULLOUT', 'BUS_STOPPED', 'BUS_PULLOUT', 'DOUBLE_PARK'
];

/** Soak gate thresholds (ARCHITECTURE 17.3 and 18). */
const LIMITS = {
  minMeanSpeed: 4.5,
  maxStationaryShare: 0.45,
  maxHeapSlopeMB: 1,
  minHeapRunMinutes: 7,
  // Share of a memory probe left out of the fit, for V8 to settle.
  heapSettleShare: 0.5,
  maxHeapMB: 250,
  minFairness: 0.95,
  nearCars: 6,
  nearRadius: 100,
  minNearShare: 0.8,
  minBlinkInView: 0.8,
  minLossShare: 0.2,
  maxLossShare: 0.45,
  minContestsJudged: 300,
  maxTickMeanMs: 3,
  maxTickP99Ms: 6,
  budgetDensity: 100,
  minBudgetRunMinutes: 1,
  // The run's last stretch, in once-per-second samples. A collapse in the last few minutes of 15 barely moves the mean.
  trailSamples: 60,
  // The lowest target ARCHITECTURE 12.5 allows: 11 cars per lane-km, over the thinnest measured bubble of 3.8 lane-km.
  minDefaultTarget: 41.8
};

/** The known one-way ring to park the idle player beside (ARCHITECTURE 12.5). */
const TRAP = { x: 470, y: -600 };

/** Keys every child result carries. The parent reads all of them. */
const RUN_MAIN = 0;
const RUN_REPEAT = 1;
const RUN_PROBE = 2;
const RESULT_KEYS = ['realised', 'density', 'traffic', 'near', 'hashes', 'heap', 'tick', 'invariants', 'tally'];

class UsageError extends Error {}

/** Parses '1-20', '1,2,5' or '1-3,7' into integers, refusing anything else. */
function parseIntList(text, flag) {
  const out = [];
  for (const part of String(text).split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new UsageError(`${flag}: bad value ${JSON.stringify(text)}. Use forms like 1-20 or 1,2,5, as one argument.`);
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (hi < lo) throw new UsageError(`${flag}: bad range ${part}`);
    for (let i = lo; i <= hi; i++) out.push(i);
  }
  return out;
}

/** @returns {number} A finite number greater than 0. */
function positive(text, flag) {
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag}: expected a positive number, got ${JSON.stringify(text)}`);
  return n;
}

/** @returns {string} The absolute path of a file that exists. Node skips an absent stub, so a typo would run the wrong sim. */
function existingFile(text, flag) {
  const file = path.resolve(text);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new UsageError(`${flag}: no such file: ${file}`);
  return file;
}

/**
 * Parses and checks the command line, strictly. Unknown flags and malformed values throw UsageError.
 * @param {string[]} argv Arguments after the script name.
 * @returns {object} Config.
 */
export function parseArgs(argv) {
  const cfg = {
    child: false, seed: null, bot: null, run: 0, settleMin: 0,
    seeds: [], bots: [], n: [], minutes: 15, jobs: 14, map: 'tlv_center', inject: null,
    stubs: [], out: null, allowSkip: false, warmupS: 60, timeoutS: 1800, heapMinutes: 60
  };
  const valued = new Set(['--seeds', '--bots', '--n', '--minutes', '--jobs', '--map', '--inject', '--stub', '--out',
    '--warmup-s', '--timeout-s', '--heap-minutes', '--settle-min', '--seed', '--bot', '--run']);
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--stub' && seen.has(flag)) throw new UsageError(`${flag} was given twice. Only --stub repeats.`);
    seen.add(flag);
    if (flag === '--child') { cfg.child = true; continue; }
    if (flag === '--allow-skip') { cfg.allowSkip = true; continue; }
    if (!valued.has(flag)) throw new UsageError(`Unknown argument ${JSON.stringify(flag)}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    switch (flag) {
      case '--seeds': cfg.seeds = parseIntList(value, flag); break;
      case '--bots': cfg.bots = value.split(','); break;
      case '--n': cfg.n = parseIntList(value, flag); break;
      case '--minutes': cfg.minutes = positive(value, flag); break;
      case '--jobs': cfg.jobs = Math.floor(positive(value, flag)); break;
      case '--map': cfg.map = value; break;
      case '--inject': cfg.inject = value; break;
      case '--stub': cfg.stubs.push(existingFile(value, flag)); break;
      case '--out': cfg.out = path.resolve(value); break;
      case '--warmup-s': cfg.warmupS = Number(value); break;
      case '--timeout-s': cfg.timeoutS = positive(value, flag); break;
      case '--heap-minutes': cfg.heapMinutes = positive(value, flag); break;
      case '--settle-min': cfg.settleMin = Number(value); break;
      case '--seed': cfg.seed = parseIntList(value, flag)[0]; break;
      case '--bot': cfg.bot = value; break;
      default: cfg.run = Number(value);
    }
  }
  if (!Number.isFinite(cfg.warmupS) || cfg.warmupS < 0) throw new UsageError('--warmup-s: expected a number >= 0');
  if (cfg.inject !== null && cfg.inject !== 'trap') throw new UsageError(`--inject: only trap exists, got ${cfg.inject}`);
  if (cfg.n.includes(0)) throw new UsageError('--n: a density of 0 proves nothing');
  if (!cfg.child) {
    if (!cfg.seeds.length) throw new UsageError('--seeds is required');
    if (!cfg.bots.length) throw new UsageError('--bots is required');
    for (const bot of cfg.bots) {
      if (!BOTS.includes(bot)) throw new UsageError(`--bots: unknown bot ${JSON.stringify(bot)}. Bots: ${BOTS.join(', ')}`);
    }
    if (cfg.inject === 'trap' && !cfg.bots.includes('idle')) {
      throw new UsageError('--inject trap teleports the idle player, and --bots has no idle bot, so it would do nothing');
    }
  }
  return cfg;
}

/**
 * Lists every job: the matrix, plus one repeat of the first seed per bot and density for the determinism gate, and on a run long enough
 * to have a Memory gate, one memory probe per bot and density.
 * @param {object} cfg Config.
 * @returns {object[]} Jobs.
 */
export function planJobs(cfg) {
  const densities = cfg.n.length ? cfg.n : [null];
  const probes = cfg.minutes >= LIMITS.minHeapRunMinutes;
  const jobs = [];
  for (const bot of cfg.bots) {
    for (const n of densities) {
      for (const seed of cfg.seeds) jobs.push({ seed, bot, n, run: RUN_MAIN });
      jobs.push({ seed: cfg.seeds[0], bot, n, run: RUN_REPEAT });
      if (probes) jobs.push({ seed: cfg.seeds[0], bot, n, run: RUN_PROBE, minutes: cfg.heapMinutes, settleMin: cfg.heapMinutes * LIMITS.heapSettleShare });
    }
  }
  return jobs;
}

// ---- Child: one sim. -------------------------------------------------------------------------------------------------

/** Keeps diagnostics in the report readable. */
function summarise(value) {
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  return text.length > 4000 ? `${text.slice(0, 4000)}...` : JSON.parse(text);
}

/** @returns {{tally:object}} Read-only bus listeners. They may subscribe after create because they change nothing. */
function listen(TLV, S) {
  const tally = {
    behaviours: {}, honks: 0, redRuns: 0,
    incidents: { AVOIDED: 0, HIT: 0, ABORTED: 0 },
    contests: { started: 0, resolved: 0, open: 0, blinkInView: 0, lost: 0 }
  };
  let contest = null;
  // Credit comes when a contest ends, so one still open at run end adds to neither side of the gate's fraction.
  const closeContest = () => {
    if (contest && contest.blinkInView) tally.contests.blinkInView++;
    contest = null;
    tally.contests.open = 0;
  };
  S.bus.on('traffic.behaviour', (e) => { tally.behaviours[e.beh] = (tally.behaviours[e.beh] || 0) + 1; });
  S.bus.on('traffic.redRun', () => { tally.redRuns++; });
  S.bus.on('traffic.honk', () => { tally.honks++; });
  S.bus.on('incident.end', (e) => { if (e.outcome in tally.incidents) tally.incidents[e.outcome]++; });
  S.bus.on('contest.start', (e) => {
    closeContest();
    tally.contests.started++;
    tally.contests.open = 1;
    contest = { rivalId: e.rivalId, blinkInView: false, captured: false };
  });
  S.bus.on('contest.state', (e) => {
    if (!contest) return;
    if (e.state === 'DENIED' || e.state === 'WON') contest.captured = true;
    if (e.state === 'BLINK' && !contest.captured) {
      const veh = TLV.traffic.byId(S, contest.rivalId);
      if (veh && TLV.traffic.visibleToPlayer(S, veh.x, veh.y)) contest.blinkInView = true;
    }
  });
  S.bus.on('contest.result', (e) => {
    if (!contest) return;
    tally.contests.resolved++;
    if (e.winner === 'rival') tally.contests.lost++;
    closeContest();
  });
  return { tally };
}

/** @returns {{sum:number, n:number, bad:number}} A running mean that also counts the samples it could not use. */
function newMeter() {
  return { sum: 0, n: 0, bad: 0 };
}

/** Adds a sample, or counts it as bad. One NaN can then neither poison the mean nor pass unseen. */
function addSample(meter, value, usable = Number.isFinite(value)) {
  if (usable) {
    meter.sum += value;
    meter.n++;
  } else {
    meter.bad++;
  }
}

/** @returns {?number} The mean, or null with no usable sample. */
function meanOf(meter) {
  return meter.n ? meter.sum / meter.n : null;
}

/** Least-squares slope of heap samples, in MB per 10 sim-minutes. */
function heapSlope(samples) {
  const n = samples.length;
  if (n < 2) return null;
  const mx = samples.reduce((a, s) => a + s[0], 0) / n;
  const my = samples.reduce((a, s) => a + s[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of samples) {
    num += (x - mx) * (y - my);
    den += (x - mx) * (x - mx);
  }
  return den > 0 ? (num / den) * 600 / (1024 * 1024) : null;
}

/** @returns {{count:number, near:number}} Active cars, and those near the player. Counted here, never taken from stats. */
function countCars(S) {
  const fx = S.player ? S.player.fx : 0;
  const fy = S.player ? S.player.fy : 0;
  const r2 = LIMITS.nearRadius * LIMITS.nearRadius;
  let count = 0;
  let near = 0;
  for (const veh of S.vehicles) {
    if (!veh.active || veh.isPlayer) continue;
    count++;
    const dx = veh.x - fx;
    const dy = veh.y - fy;
    if (dx * dx + dy * dy <= r2) near++;
  }
  return { count, near };
}

/** Places the player beside the known ring, on a lane if one is near. */
function injectTrap(TLV, S) {
  const lane = TLV.world.lanes.project(S.world, TRAP.x, TRAP.y, null, 60, {});
  if (!lane) throw new Error('--inject trap: no lane near the ring on this map');
  const at = TLV.world.lanes.pointAt(S.world, lane.laneId, lane.s, {});
  TLV.player.setPose(S, at.x, at.y, at.h, 0);
}

/**
 * Runs one sim and prints its result as one line of JSON on stdout.
 * @param {object} cfg Child config.
 */
async function runChild(cfg) {
  const { createTLV, createSim } = await import('./lib/classic.mjs');
  const params = { seed: cfg.seed, notitle: 1, immortal: 1, invariants: 1, autoplay: cfg.bot };
  if (cfg.n.length) params.density = cfg.n[0];

  let TLV;
  if (cfg.stubs.length) {
    const core = createTLV({ files: [] }).manifest.sim.filter((f) => f.startsWith('js/core/'));
    TLV = createTLV({ files: [...core, ...cfg.stubs], params });
  } else {
    TLV = createTLV({ map: cfg.map, params });
  }
  const S = createSim(TLV, { seed: cfg.seed, map: cfg.map });
  const { tally } = listen(TLV, S);

  const ticks = Math.round(cfg.minutes * 60 * TLV.const.TICK_HZ);
  const warmup = Math.min(Math.round(cfg.warmupS * TLV.const.TICK_HZ), Math.floor(ticks / 2));
  const times = new Float32Array(ticks);
  const hashes = [];
  const heap = [];
  const sum = { n: 0, samples: 0, min: Infinity, near: 0, playerSpeed: 0, playerSamples: 0 };
  const cap = newMeter();
  const speed = newMeter();
  const stationary = newMeter();
  const trail = [];
  let peakHeap = 0;

  TLV.sim.step(S);
  if (cfg.inject === 'trap' && cfg.bot === 'idle') injectTrap(TLV, S);

  for (let tick = 1; tick < ticks; tick++) {
    const t0 = performance.now();
    TLV.sim.step(S);
    times[tick] = performance.now() - t0;

    if (S.tick % 1000 === 0) hashes.push(TLV.sim.hash(S));
    if (S.tick < warmup) continue;
    if (S.tick % TLV.const.TICK_HZ === 0) {
      const cars = countCars(S);
      sum.samples++;
      sum.n += cars.count;
      if (cars.count < sum.min) sum.min = cars.count;
      if (cars.near >= LIMITS.nearCars) sum.near++;
      if (S.game.phase === 'DRIVE' || S.game.phase === 'SEARCH') {
        sum.playerSpeed += Math.abs(S.vehicles[0].v);
        sum.playerSamples++;
      }
      const stats = S.traffic && S.traffic.stats;
      if (stats) {
        addSample(cap, stats.cap, Number.isFinite(stats.cap) && stats.cap > 0);
        addSample(speed, stats.meanSpeed);
        addSample(stationary, stats.stationaryShare);
      }
      trail.push({ cars: cars.count, cap: stats ? stats.cap : NaN });
      if (trail.length > LIMITS.trailSamples) trail.shift();
    }
    if (S.tick % (30 * TLV.const.TICK_HZ) === 0) {
      global.gc();
      const used = process.memoryUsage().heapUsed;
      heap.push([S.tick / TLV.const.TICK_HZ, used]);
      if (used > peakHeap) peakHeap = used;
    }
  }

  // The final hash means even a run too short for the 1000-tick cadence is compared.
  hashes.push(TLV.sim.hash(S));
  const measured = times.slice(warmup).sort();
  const settled = heap.filter((sample) => sample[0] >= cfg.settleMin * 60);
  const trailN = newMeter();
  const trailCap = newMeter();
  for (const sample of trail) {
    addSample(trailN, sample.cars);
    addSample(trailCap, sample.cap);
  }
  const result = {
    realised: {
      seed: S.seed,
      bot: S.params.autoplay,
      density: S.params.density,
      notitle: S.params.notitle,
      immortal: S.params.immortal,
      invariants: S.params.invariants,
      map: S.world ? S.world.id : null,
      ticks: S.tick,
      inject: cfg.inject === 'trap' && cfg.bot === 'idle' ? 'trap' : null
    },
    density: {
      target: cfg.n.length ? cfg.n[0] : meanOf(cap),
      badTargets: cap.bad,
      meanN: sum.samples ? sum.n / sum.samples : 0,
      minN: sum.samples ? sum.min : 0,
      samples: sum.samples,
      // The sim's target moves with the road at default density, so the window has to be held to its own target.
      trailN: meanOf(trailN),
      trailTarget: cfg.n.length ? cfg.n[0] : meanOf(trailCap),
      trailSamples: trail.length
    },
    traffic: speed.n + speed.bad ? {
      meanSpeed: meanOf(speed),
      stationaryShare: meanOf(stationary),
      nonFinite: speed.bad + stationary.bad
    } : null,
    near: { samples: sum.samples, hits: sum.near },
    playerMeanSpeed: sum.playerSamples ? sum.playerSpeed / sum.playerSamples : null,
    hashes,
    heap: {
      minutes: settled.length ? (settled[settled.length - 1][0] - settled[0][0]) / 60 : 0,
      slopeMBPer10Min: heapSlope(settled),
      peakMB: peakHeap / (1024 * 1024)
    },
    tick: {
      meanMs: measured.reduce((a, b) => a + b, 0) / Math.max(1, measured.length),
      p99Ms: measured[Math.floor(measured.length * 0.99)] || 0
    },
    invariants: {
      registered: TLV.invariants._names(),
      total: S._invariantTotal,
      byName: S._invariantCounts,
      first: S.invariantFailures.slice(0, 10)
    },
    tally,
    problems: TLV.registry.problems().length,
    diagnostics: TLV.traffic && TLV.traffic.diagnostics ? summarise(TLV.traffic.diagnostics(S)) : null
  };
  process.stdout.write(`\n${RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

// ---- Parent: the matrix. ---------------------------------------------------------------------------------------------

/** @returns {string[]} Child argv. Plain array elements: no shell ever sees these. */
function childArgs(cfg, job) {
  const args = ['--expose-gc', SELF, '--child',
    '--seed', String(job.seed), '--bot', job.bot, '--run', String(job.run),
    '--minutes', String(job.minutes || cfg.minutes), '--map', cfg.map, '--warmup-s', String(cfg.warmupS)];
  if (job.settleMin) args.push('--settle-min', String(job.settleMin));
  if (job.n !== null) args.push('--n', String(job.n));
  if (cfg.inject) args.push('--inject', cfg.inject);
  for (const stub of cfg.stubs) args.push('--stub', stub);
  return args;
}

/** @returns {string} The thrown message from a child's stderr, without its stack or warnings. */
function firstError(stderr) {
  const lines = stderr.split('\n');
  const at = lines.findIndex((l) => /^\w*Error\b/.test(l.trim()));
  return at < 0 ? lines.slice(-4).join(' ').trim() : lines.slice(at, at + 3).join(' ').trim();
}

/**
 * Reads a child's result from its stdout. The child prints it last, so the last line wins whatever the sim logged before it.
 * @param {string} out Child stdout.
 * @returns {{error:(string|undefined), data:(object|undefined)}} The result, or why there is none.
 */
export function readResult(out) {
  const lines = out.split('\n').filter((l) => l.startsWith(RESULT_PREFIX));
  if (!lines.length) return { error: 'child printed no result' };
  let data;
  try {
    data = JSON.parse(lines[lines.length - 1].slice(RESULT_PREFIX.length));
  } catch (e) {
    return { error: `child printed a bad result: ${e.message}` };
  }
  const absent = RESULT_KEYS.filter((key) => !(key in Object(data)));
  return absent.length ? { error: `child result lacks ${absent.join(', ')}` } : { data };
}

/** Runs one job. Any way it can fail ends up as job.error, never as a missing row. */
function runJob(cfg, job) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, childArgs(cfg, job), { shell: false, stdio: ['ignore', 'pipe', 'pipe'], cwd: PROJECT_ROOT });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, cfg.timeoutS * 1000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
    const finish = (error, data) => {
      clearTimeout(timer);
      resolve({ ...job, wallS: (Date.now() - started) / 1000, error, ...data });
    };
    child.on('error', (e) => finish(`spawn failed: ${e.message}`));
    child.on('close', (code, signal) => {
      if (timedOut) return finish(`timed out after ${cfg.timeoutS} s`);
      if (code !== 0) return finish(`exit ${code === null ? signal : code}: ${firstError(err)}`);
      const { error, data } = readResult(out);
      return finish(error || null, data);
    });
  });
}

/** Runs jobs with a concurrency limit, keeping plan order in the result. */
async function runPool(cfg, jobs, onDone) {
  const results = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await runJob(cfg, jobs[index]);
      onDone(results[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cfg.jobs, jobs.length) }, worker));
  return results;
}

/** @returns {string} A short job name. */
function jobName(job) {
  return `seed=${job.seed} bot=${job.bot} n=${job.n === null ? 'default' : job.n}${job.run === RUN_PROBE ? ' memory probe' : (job.run ? ' repeat' : '')}`;
}

/** @returns {boolean} True for a finite number at or above limit. A comparison alone would pass NaN or null somewhere. */
function atLeast(value, limit) {
  return Number.isFinite(value) && value >= limit;
}

/** @returns {boolean} True for a finite number at or below limit. Note that null <= 0.45 is true in JavaScript. */
function atMost(value, limit) {
  return Number.isFinite(value) && value <= limit;
}

/** @returns {string} A number for a report line, or what stood in its place. Never throws. */
function fmt(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : String(value);
}

/** @returns {string} What a job's child reports it really ran. */
function realisedLine(job) {
  if (job.error) return `FAILED ${jobName(job)}: ${job.error}`;
  const r = job.realised;
  const d = job.density;
  const target = d.target === null ? 'unknown' : fmt(d.target, 1);
  return `ran ${jobName(job)}: realised seed=${r.seed} bot=${r.bot} density=${r.density} notitle=${r.notitle} immortal=${r.immortal} ` +
    `map=${r.map} ticks=${r.ticks} inject=${r.inject}; realised N mean=${fmt(d.meanN, 1)} min=${d.minN} target=${target}; ` +
    `last ${d.trailSamples} s mean=${fmt(d.trailN, 1)} target=${fmt(d.trailTarget, 1)}; ${job.wallS.toFixed(1)} s`;
}

/**
 * Judges one job's density.
 * @param {object} job Finished job.
 * @returns {string[]} Why the job fails the gate.
 */
function densityFailures(job) {
  const { target, meanN, badTargets, samples, trailN, trailTarget, trailSamples } = job.density;
  const name = jobName(job);
  const defaultDensity = job.n === null;
  const out = [];
  if (defaultDensity && badTargets) out.push(`${name}: stats.cap unusable on ${badTargets} of ${samples} samples`);
  const judge = (label, realised, goal) => {
    if (!(Number.isFinite(goal) && goal > 0)) {
      out.push(`${name}: ${label} has no usable target (${goal}), realised N ${fmt(realised, 1)}`);
      return;
    }
    if (defaultDensity && !atLeast(goal, LIMITS.minDefaultTarget)) {
      out.push(`${name}: ${label} target ${fmt(goal, 1)} is under the contract floor of ${LIMITS.minDefaultTarget}`);
    }
    if (!atLeast(realised, MIN_REALISED * goal)) out.push(`${name}: ${label} realised N ${fmt(realised, 1)} is under 90% of target ${fmt(goal, 1)}`);
  };
  judge('whole run', meanN, target);
  judge(`last ${trailSamples} s`, trailN, trailTarget);
  return out;
}

/** @returns {?string} How a job's realised config differs from the request, or null. */
function configMismatch(cfg, job) {
  const r = job.realised;
  const wrong = [];
  if (r.seed !== job.seed) wrong.push(`seed ${r.seed}`);
  if (r.bot !== job.bot) wrong.push(`bot ${r.bot}`);
  if (r.density !== job.n) wrong.push(`density ${r.density}`);
  if (r.notitle !== 1) wrong.push(`notitle ${r.notitle}`);
  if (r.immortal !== 1) wrong.push(`immortal ${r.immortal}`);
  if (r.invariants !== 1) wrong.push(`invariants ${r.invariants}`);
  const wantTicks = Math.round((job.minutes || cfg.minutes) * 3600);
  if (r.ticks !== wantTicks) wrong.push(`ticks ${r.ticks}, wanted ${wantTicks}`);
  if (cfg.inject === 'trap' && job.bot === 'idle' && r.inject !== 'trap') wrong.push('trap not injected');
  return wrong.length ? `${jobName(job)}: ${wrong.join(', ')}` : null;
}

/**
 * Evaluates the gates in ARCHITECTURE 17.3 and the automated budgets in 18.
 * @param {object} cfg Config.
 * @param {object[]} results One row per planned job.
 * @param {object[]} planned The plan.
 * @returns {Array<{name:string,status:string,detail:string}>} Gates. status is PASS, FAIL, SKIP, N/A or NOT JUDGED.
 */
export function evaluate(cfg, results, planned) {
  const gates = [];
  const ok = results.filter((j) => !j.error);
  const main = ok.filter((j) => j.run === RUN_MAIN);
  const probes = ok.filter((j) => j.run === RUN_PROBE);
  const hasBot = (bot) => cfg.bots.includes(bot);

  const gate = (name, failures, detail) => {
    gates.push({ name, status: failures.length ? 'FAIL' : 'PASS', detail: failures.length ? failures.slice(0, 8).join('; ') : detail });
  };
  const noData = (name, detail) => gates.push({ name, status: cfg.allowSkip ? 'SKIP' : 'FAIL', detail: `no data: ${detail}` });
  const notApplicable = (name, detail) => gates.push({ name, status: 'N/A', detail });
  const notJudged = (name, detail) => gates.push({ name, status: 'NOT JUDGED', detail });

  const failed = results.filter((j) => j.error).map((j) => `${jobName(j)}: ${j.error}`);
  if (results.length !== planned.length || planned.length === 0) failed.push(`planned ${planned.length} jobs, got ${results.length}`);
  gate('Jobs ran', failed, `${results.length} of ${planned.length}`);

  // Nothing ran, so nothing below can pass. This is a failure even with --allow-skip.
  if (!main.length) {
    gates.push({ name: 'Realised density', status: 'FAIL', detail: 'no job produced a realised N' });
    return gates;
  }

  gate('Realised config', ok.map((j) => configMismatch(cfg, j)).filter(Boolean), 'every job ran what was asked');

  const low = ok.flatMap(densityFailures);
  const shares = ok.flatMap(({ density: d }) => [d.meanN / d.target, d.trailN / d.trailTarget]);
  gate('Realised density', low, `lowest job at ${fmt(Math.min(...shares) * 100, 1)}% of target`);

  const failing = {};
  let otherChecks = 0;
  for (const j of ok) {
    otherChecks = Math.max(otherChecks, j.invariants.registered.filter((n) => !n.startsWith('core.')).length);
    for (const [name, count] of Object.entries(j.invariants.byName)) failing[name] = (failing[name] || 0) + count;
  }
  const failingRows = (core) => Object.entries(failing).filter(([n]) => n.startsWith('core.') === core).map(([n, c]) => `${n} x ${c}`);
  gate('Numeric and pools', failingRows(true), 'no failures');
  if (otherChecks === 0) noData('Invariants (lane bound, overlap, colliders, ordering, conservation, stuck, people)', 'no package registered one');
  else gate('Invariants (lane bound, overlap, colliders, ordering, conservation, stuck, people)', failingRows(false), `${otherChecks} checks, no failures`);

  const withTraffic = main.filter((j) => j.traffic);
  if (!withTraffic.length) noData('Flow', 'S.traffic.stats never appeared');
  else {
    const slow = [];
    for (const j of withTraffic) {
      const { meanSpeed, stationaryShare, nonFinite } = j.traffic;
      if (nonFinite) slow.push(`${jobName(j)}: ${nonFinite} stats samples were not finite numbers`);
      if (!atLeast(meanSpeed, LIMITS.minMeanSpeed)) slow.push(`${jobName(j)}: mean speed ${fmt(meanSpeed)}`);
      if (!atMost(stationaryShare, LIMITS.maxStationaryShare)) slow.push(`${jobName(j)}: stationary ${fmt(stationaryShare, 3)}`);
    }
    gate('Flow', slow, `lowest mean speed ${fmt(Math.min(...withTraffic.map((j) => j.traffic.meanSpeed)))} m/s`);
  }

  const pairs = [];
  for (const repeat of ok.filter((j) => j.run === RUN_REPEAT)) {
    const first = main.find((j) => j.seed === repeat.seed && j.bot === repeat.bot && j.n === repeat.n);
    if (first) pairs.push([first, repeat]);
  }
  if (!pairs.length) noData('Determinism', 'no repeated run finished');
  else {
    const diverged = [];
    for (const [a, b] of pairs) {
      const at = a.hashes.findIndex((h, i) => h !== b.hashes[i]);
      if (at >= 0) diverged.push(`${jobName(a)}: hash ${at + 1} of ${a.hashes.length} differs, near tick ${(at + 1) * 1000}`);
      else if (!a.hashes.length || a.hashes.length !== b.hashes.length) diverged.push(`${jobName(a)}: hash counts ${a.hashes.length} and ${b.hashes.length}`);
    }
    gate('Determinism', diverged, `${pairs.length} seeds repeated, ${pairs[0][0].hashes.length} hashes each`);
  }

  if (cfg.minutes < LIMITS.minHeapRunMinutes) notApplicable('Memory', `runs under ${LIMITS.minHeapRunMinutes} sim-min are too short to fit a slope`);
  else {
    const sloped = probes.length ? probes : main;
    const heapJobs = sloped.filter((j) => j.heap.slopeMBPer10Min !== null);
    const leaks = [];
    for (const j of heapJobs) {
      if (!(j.heap.slopeMBPer10Min < LIMITS.maxHeapSlopeMB)) leaks.push(`${jobName(j)}: post-gc heap slope ${fmt(j.heap.slopeMBPer10Min)} MB per 10 sim-min`);
    }
    for (const j of ok) {
      if (!atMost(j.heap.peakMB, LIMITS.maxHeapMB)) leaks.push(`${jobName(j)}: peak heap ${fmt(j.heap.peakMB, 0)} MB`);
    }
    const reach = probes.length ? `, settled, over ${fmt(Math.min(...heapJobs.map((j) => j.heap.minutes)), 0)} sim-min of ${probes.length} probes` : '';
    if (!heapJobs.length) noData('Memory', 'no heap samples');
    else gate('Memory', leaks, `worst post-gc slope ${fmt(Math.max(...heapJobs.map((j) => j.heap.slopeMBPer10Min)))} MB per 10 sim-min${reach}`);
  }

  const simMinutes = main.length * cfg.minutes;
  const required = Math.floor(simMinutes / 15);
  if (required < 1) notApplicable('Behaviours', `${simMinutes} sim-min is under the 15 the rule needs`);
  else if (!main.some((j) => Object.keys(j.tally.behaviours).length)) noData('Behaviours', 'no traffic.behaviour event seen');
  else {
    const fired = {};
    for (const name of AMBIENT_BEHAVIOURS) fired[name] = 0;
    let redRuns = 0;
    for (const j of main) {
      for (const [name, count] of Object.entries(j.tally.behaviours)) if (name in fired) fired[name] += count;
      fired.HONK += j.tally.honks;
      redRuns += j.tally.redRuns;
    }
    fired.RED_RUN = Math.max(fired.RED_RUN, redRuns);
    const silent = AMBIENT_BEHAVIOURS.filter((name) => fired[name] < required).map((name) => `${name} fired ${fired[name]}, needs ${required}`);
    gate('Behaviours', silent, `each of ${AMBIENT_BEHAVIOURS.length} fired ${required} times or more`);
  }

  if (!hasBot('braker')) notApplicable('Fairness', 'no braker bot in this matrix');
  else {
    const brakers = main.filter((j) => j.bot === 'braker');
    const avoided = brakers.reduce((a, j) => a + j.tally.incidents.AVOIDED, 0);
    const hit = brakers.reduce((a, j) => a + j.tally.incidents.HIT, 0);
    if (avoided + hit === 0) noData('Fairness', 'no incident ended');
    else {
      const share = avoided / (avoided + hit);
      gate('Fairness', share >= LIMITS.minFairness ? [] : [`braker avoided ${(share * 100).toFixed(1)}% of ${avoided + hit}`], `avoided ${(share * 100).toFixed(1)}% of ${avoided + hit}`);
    }
  }

  if (!hasBot('patrol')) notApplicable('Nearby traffic', 'no patrol bot in this matrix');
  else {
    const patrols = main.filter((j) => j.bot === 'patrol');
    const samples = patrols.reduce((a, j) => a + j.near.samples, 0);
    const hits = patrols.reduce((a, j) => a + j.near.hits, 0);
    if (!samples) noData('Nearby traffic', 'no samples');
    else {
      const share = hits / samples;
      gate('Nearby traffic', share >= LIMITS.minNearShare ? [] : [`${(share * 100).toFixed(1)}% of samples have ${LIMITS.nearCars} cars within ${LIMITS.nearRadius} m`], `${(share * 100).toFixed(1)}% of ${samples} samples`);
    }
  }

  if (!hasBot('errands')) notApplicable('Contest', 'no errands bot in this matrix');
  else {
    const total = (key) => main.filter((j) => j.bot === 'errands').reduce((a, j) => a + j.tally.contests[key], 0);
    // Every contest counts, so one that vanishes cannot flatter the rates. Only the one a job ended inside has no outcome yet.
    const contests = total('started') - total('open');
    if (!(contests > 0)) noData('Contest', 'no contest finished');
    else {
      const inView = total('blinkInView') / contests;
      const lost = total('lost') / contests;
      const shares = `of ${contests} started, with ${total('open')} open at run end, BLINK in view on ${(inView * 100).toFixed(1)}%, bot lost ${(lost * 100).toFixed(1)}%`;
      if (contests < LIMITS.minContestsJudged) notJudged('Contest', `n=${contests}, under the ${LIMITS.minContestsJudged} it takes to judge: ${shares}`);
      else {
        const bad = [];
        if (inView < LIMITS.minBlinkInView) bad.push(`BLINK in view too rarely ${shares}`);
        if (lost < LIMITS.minLossShare || lost > LIMITS.maxLossShare) bad.push(`bot lost outside 20-45% ${shares}`);
        gate('Contest', bad, `n=${contests}: ${shares}`);
      }
    }
  }

  // A p99 over a few seconds is a handful of ticks, so it measures the machine's load and the JIT warming up, not the sim.
  const budgeted = main.filter((j) => j.n === LIMITS.budgetDensity || j.n === null);
  if (!budgeted.length) notApplicable('Tick budget', `no run at N=${LIMITS.budgetDensity}`);
  else if (cfg.minutes < LIMITS.minBudgetRunMinutes) notApplicable('Tick budget', `runs under ${LIMITS.minBudgetRunMinutes} sim-min are too short for a p99`);
  else {
    const over = [];
    for (const j of budgeted) {
      if (!atMost(j.tick.meanMs, LIMITS.maxTickMeanMs)) over.push(`${jobName(j)}: mean ${fmt(j.tick.meanMs)} ms`);
      if (!atMost(j.tick.p99Ms, LIMITS.maxTickP99Ms)) over.push(`${jobName(j)}: p99 ${fmt(j.tick.p99Ms)} ms`);
    }
    gate('Tick budget', over, `worst mean ${fmt(Math.max(...budgeted.map((j) => j.tick.meanMs)), 3)} ms, worst p99 ${fmt(Math.max(...budgeted.map((j) => j.tick.p99Ms)), 3)} ms`);
  }

  return gates;
}

/** @returns {?string} The 15 sim-min heap slopes, which the gate no longer reads when it has a probe. Report-only. */
function memoryLine(results) {
  const slopes = results.filter((j) => !j.error && j.run === RUN_MAIN && Number.isFinite(j.heap.slopeMBPer10Min)).map((j) => j.heap.slopeMBPer10Min).sort((a, b) => a - b);
  if (!slopes.length) return null;
  return `INFO  post-gc heap over the whole run, V8 settling included: median ${slopes[Math.floor(slopes.length / 2)].toFixed(2)}, worst ${slopes[slopes.length - 1].toFixed(2)} MB per 10 sim-min, ${slopes.length} jobs`;
}

/** @returns {?string} The errands bot's real speed, for balance review. Report-only (ARCHITECTURE 17.4). */
function balanceLine(results) {
  const speeds = results.filter((j) => !j.error && j.run === RUN_MAIN && j.bot === 'errands' && j.playerMeanSpeed !== null).map((j) => j.playerMeanSpeed);
  if (!speeds.length) return null;
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  return `INFO  errands bot mean speed in DRIVE and SEARCH: ${mean.toFixed(2)} m/s over ${speeds.length} runs`;
}

/** Makes a directory and its parents. fs.mkdirSync with recursive never returns where a parent refuses, as /proc does. */
function makeDirs(dir) {
  if (fs.existsSync(dir)) return;
  makeDirs(path.dirname(dir));
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

/**
 * Proves the report can be written, so hours of runs are not spent on a path that cannot take them. Opening to append leaves a
 * report already there untouched, and refuses a directory, a read-only file and a read-only parent alike.
 * @param {string} out Report path.
 */
function checkReportPath(out) {
  try {
    makeDirs(path.dirname(out));
    const existed = fs.existsSync(out);
    fs.closeSync(fs.openSync(out, 'a'));
    if (!existed) fs.rmSync(out);
  } catch (e) {
    throw new UsageError(`cannot write the report to ${out}: ${e.message}`);
  }
}

/** Writes the report. */
function writeReport(cfg, out, planned, results, gates, pass) {
  makeDirs(path.dirname(out));
  const { child, seed, bot, run, ...config } = cfg;
  fs.writeFileSync(out, `${JSON.stringify({ config, planned: planned.length, pass, gates, jobs: results }, null, 1)}\n`);
}

/** Runs the matrix. */
async function runMatrix(cfg) {
  const out = cfg.out || path.join(PROJECT_ROOT, 'tools/reports/soak', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  checkReportPath(out);
  const planned = planJobs(cfg);
  console.log(`config: seeds=${cfg.seeds.join(',')} bots=${cfg.bots.join(',')} n=${cfg.n.length ? cfg.n.join(',') : 'default'} ` +
    `minutes=${cfg.minutes} jobs=${cfg.jobs} map=${cfg.map} inject=${cfg.inject || 'none'} warmup=${cfg.warmupS}s ` +
    `stubs=${cfg.stubs.length} allowSkip=${cfg.allowSkip}`);
  console.log(`running ${planned.length} jobs`);

  const results = await runPool(cfg, planned, (job) => console.log(realisedLine(job)));
  // Hours of runs must not be lost to a result nobody foresaw, so this ends in a verdict and a report whatever evaluate does.
  let gates;
  try {
    gates = evaluate(cfg, results, planned);
  } catch (e) {
    gates = [{ name: 'Evaluate', status: 'FAIL', detail: `the gates could not read these results: ${e.stack || e}` }];
  }
  const pass = gates.every((g) => g.status !== 'FAIL');

  console.log('');
  for (const g of gates) console.log(`${g.status.padEnd(4)}  ${g.name}: ${g.detail}`);
  const balance = balanceLine(results);
  if (balance) console.log(balance);
  const memory = memoryLine(results);
  if (memory) console.log(memory);
  console.log('');
  console.log(pass ? 'SOAK PASS' : 'SOAK FAIL');
  process.exitCode = pass ? 0 : 1;
  // Last, because the path was good when the run began and may not be now. That must cost the file and not the verdict.
  try {
    writeReport(cfg, out, planned, results, gates, pass);
    console.log(`report: ${out}`);
  } catch (e) {
    console.error(`soak: the report was not written to ${out}: ${e.message}`);
    process.exitCode = 1;
  }
}

/** Entry point. */
async function main() {
  try {
    const cfg = parseArgs(process.argv.slice(2));
    if (cfg.child) await runChild(cfg);
    else await runMatrix(cfg);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`soak: ${e.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
