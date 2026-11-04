// tests/core/soak.test.mjs — WP-CORE
// Proves the harness on stubs. It must fail when a spawner underdelivers, and it must not fail when one does not, or the
// proof means nothing. The stubs stand in for WP-TRAFFIC, so these tests hold before and after it lands.
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluate, parseArgs, planJobs, readResult } from '../../tools/soak.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOAK = path.resolve(HERE, '../../tools/soak.mjs');
const stub = (name) => path.join(HERE, 'stubs', name);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlv-soak-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

let runs = 0;

/**
 * Runs the real CLI, through argv only.
 * @param {string[]} args Arguments.
 * @param {object} [options] What soak_options.js passes to the spawner.
 * @param {number} [minutes] Sim minutes.
 * @returns {{code:number, out:string, report:?object, gate:function}} Result.
 */
function soak(args, options = {}, minutes = 0.1) {
  const reportPath = path.join(temp, `report-${runs++}.json`);
  const full = [SOAK, '--minutes', String(minutes), '--warmup-s', '1', '--jobs', '4', '--out', reportPath, ...args];
  const env = { ...process.env, SOAK_STUB: JSON.stringify(options) };
  const r = spawnSync(process.execPath, full, { encoding: 'utf8', shell: false, env });
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
  return {
    code: r.status,
    out: r.stdout + r.stderr,
    report,
    gate: (name) => report.gates.find((g) => g.name === name)
  };
}

const MATRIX = ['--seeds', '1-2', '--bots', 'patrol,idle', '--n', '100', '--allow-skip'];

/** The stand-in sim, taking soak()'s options. */
const SIM = ['--stub', stub('soak_options.js'), '--stub', stub('soak_spawner.js')];

/** The second matrix in ARCHITECTURE 17.2, in strict mode: no --n, so the sim names its own target. */
const DEFAULT_MATRIX = ['--seeds', '1-2', '--bots', 'errands,braker', ...SIM];

/** @returns {string[]} The gates that failed. */
const failures = (r) => r.report.gates.filter((g) => g.status === 'FAIL').map((g) => g.name);

test('a healthy spawner passes the density gate', () => {
  const r = soak([...MATRIX, '--stub', stub('soak_spawner.js')]);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.gate('Realised density').status, 'PASS');
  assert.strictEqual(r.report.pass, true);
  assert.match(r.out, /SOAK PASS/);
});

test('a broken spawner fails soak: realised N under 90% of target', () => {
  const r = soak([...MATRIX, '--stub', stub('soak_broken_fill.js'), '--stub', stub('soak_spawner.js')]);
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual(r.gate('Realised density').status, 'FAIL');
  assert.match(r.gate('Realised density').detail, /under 90% of target/);
  assert.strictEqual(r.report.pass, false);
  assert.match(r.out, /SOAK FAIL/);
});

test('the 90% line is sharp: 89% fails', () => {
  const r = soak([...MATRIX, '--stub', stub('soak_short_fill.js'), '--stub', stub('soak_spawner.js')]);
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual(r.gate('Realised density').status, 'FAIL');
});

test('--allow-skip never excuses a low density', () => {
  const r = soak([...MATRIX, '--stub', stub('soak_broken_fill.js'), '--stub', stub('soak_spawner.js')]);
  assert.ok(r.report.config.allowSkip);
  assert.strictEqual(r.report.pass, false);
});

test('realised config and realised density are printed for every job', () => {
  const r = soak(['--seeds', '3', '--bots', 'patrol', '--n', '80', '--allow-skip', '--stub', stub('soak_spawner.js')]);
  assert.match(r.out, /^config: seeds=3 bots=patrol n=80 /m);
  assert.match(r.out, /realised seed=3 bot=patrol density=80 notitle=1 immortal=1/);
  assert.match(r.out, /realised N mean=80\.0 min=80 target=80\.0/);
});

test('a sim that dies fails soak, and is not dropped from the matrix', () => {
  const r = soak([...MATRIX, '--stub', stub('soak_throw.js'), '--stub', stub('soak_spawner.js')]);
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual(r.gate('Jobs ran').status, 'FAIL');
  assert.match(r.gate('Jobs ran').detail, /stub sim failure/);
  assert.strictEqual(r.report.jobs.length, r.report.planned);
});

test('hidden nondeterminism fails the determinism gate', () => {
  const r = soak([...MATRIX, '--stub', stub('soak_drift.js'), '--stub', stub('soak_spawner.js')]);
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual(r.gate('Determinism').status, 'FAIL');
});

test('the same stub without drift passes the determinism gate', () => {
  const r = soak([...MATRIX, '--stub', stub('soak_spawner.js')]);
  assert.strictEqual(r.gate('Determinism').status, 'PASS');
});

test('a gate with no data is a failure unless --allow-skip says otherwise', () => {
  const strict = soak(['--seeds', '1', '--bots', 'patrol', '--n', '100', '--stub', stub('soak_spawner.js')]);
  assert.strictEqual(strict.code, 1, strict.out);
  assert.match(strict.gate('Invariants (lane bound, overlap, colliders, ordering, conservation, stuck, people)').detail, /no data/);
  const lax = soak(['--seeds', '1', '--bots', 'patrol', '--n', '100', '--allow-skip', '--stub', stub('soak_spawner.js')]);
  assert.strictEqual(lax.code, 0, lax.out);
  assert.strictEqual(lax.gate('Invariants (lane bound, overlap, colliders, ordering, conservation, stuck, people)').status, 'SKIP');
});

test('a default-density matrix takes its target from the sim', () => {
  const r = soak(['--seeds', '1', '--bots', 'patrol', '--allow-skip', '--stub', stub('soak_spawner.js')]);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.report.jobs[0].realised.density, null);
  assert.strictEqual(r.report.jobs[0].density.target, 100);
});

test('a healthy sim passes the default-density matrix in strict mode, so the tests below fail for their stated reason', () => {
  const r = soak(DEFAULT_MATRIX, { game: true });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.gate('Contest').status, 'NOT JUDGED');
  assert.match(r.gate('Contest').detail, /n=20, under the 300 it takes to judge: of 20 started, with 0 open at run end/);
  assert.strictEqual(r.gate('Fairness').status, 'PASS');
  assert.match(r.out, /SOAK PASS/);
});

for (const cap of [0, 3]) {
  test(`a sim that reports cap ${cap} and then meets it fails the default-density matrix`, () => {
    const r = soak(DEFAULT_MATRIX, { game: true, cap });
    assert.strictEqual(r.code, 1, r.out);
    assert.deepStrictEqual(failures(r), ['Realised density'], r.out);
    assert.match(r.out, /SOAK FAIL/);
  });

  test(`--allow-skip does not excuse cap ${cap}`, () => {
    const r = soak([...DEFAULT_MATRIX, '--allow-skip'], { cap });
    assert.strictEqual(r.code, 1, r.out);
    assert.deepStrictEqual(failures(r), ['Realised density'], r.out);
  });
}

test('a sim that drops its cap to 0 and loses every car halfway fails, though its mean would clear the floor', () => {
  const r = soak(DEFAULT_MATRIX, { game: true, collapseAt: 200 });
  assert.strictEqual(r.code, 1, r.out);
  assert.deepStrictEqual(failures(r), ['Realised density'], r.out);
  assert.match(r.gate('Realised density').detail, /stats\.cap unusable on 3 of 6 samples/);
  assert.strictEqual(r.report.jobs[0].density.meanN, 50);
});

// 180 samples. The last 60 start at tick 7260, and the 7 from tick 10440 on find no cars: 96% of the mean, 88% of the window.
const LATE_RUN = 3;
const LATE_TICK = 10400;
const ASKED = ['--seeds', '1', '--bots', 'patrol', '--n', '120', ...SIM];

test('a late run with no collapse passes the density gate, so the tests below fail for their stated reason', () => {
  const r = soak(ASKED, { game: true }, LATE_RUN);
  assert.strictEqual(r.gate('Realised density').status, 'PASS', r.out);
  assert.deepStrictEqual(r.gate('Realised density').detail, 'lowest job at 100.0% of target');
  assert.match(r.out, /last 60 s mean=120\.0 target=120\.0/);
});

test('a spawner that collapses late fails at an asked-for density, though the mean clears 90%', () => {
  const r = soak(ASKED, { game: true, dropAt: LATE_TICK }, LATE_RUN);
  assert.strictEqual(r.code, 1, r.out);
  assert.deepStrictEqual(failures(r), ['Realised density'], r.out);
  const { density } = r.report.jobs[0];
  assert.ok(density.meanN > 0.9 * 120, `mean ${density.meanN}`);
  assert.strictEqual(density.trailN, 106);
  assert.strictEqual(density.trailTarget, 120);
  assert.strictEqual(density.trailSamples, 60);
  assert.match(r.gate('Realised density').detail, /last 60 s realised N 106\.0 is under 90% of target 120\.0/);
  assert.doesNotMatch(r.gate('Realised density').detail, /whole run/);
});

test('a spawner that collapses late fails at default density, while the sim goes on naming a healthy cap', () => {
  const r = soak(DEFAULT_MATRIX, { game: true, dropAt: LATE_TICK }, LATE_RUN);
  assert.strictEqual(r.code, 1, r.out);
  const { density } = r.report.jobs[0];
  assert.strictEqual(density.badTargets, 0);
  assert.strictEqual(density.target, 100);
  assert.strictEqual(density.trailTarget, 100);
  assert.match(r.gate('Realised density').detail, /last 60 s realised N 88\.3 is under 90% of target 100\.0/);
  assert.doesNotMatch(r.gate('Realised density').detail, /whole run/);
});

test('a window is held to its own target: a sim that ends on a thin road, and meets the lower cap there, passes', () => {
  const r = soak(DEFAULT_MATRIX, { game: true, thinAt: 7000, thinCap: 70 }, LATE_RUN);
  assert.strictEqual(r.gate('Realised density').status, 'PASS', r.gate('Realised density').detail);
  const { density } = r.report.jobs[0];
  assert.strictEqual(density.trailTarget, 70);
  assert.ok(0.9 * density.target > density.trailN, 'against the whole-run target this window would fail');
});

test('at an asked-for density the window is held to that N, whatever the sim reports as its cap', () => {
  const r = soak(ASKED, { game: true, capReported: 'NaN' });
  assert.strictEqual(r.gate('Realised density').status, 'PASS', r.gate('Realised density').detail);
  assert.strictEqual(r.report.jobs[0].density.trailTarget, 120);
});

test('a sim cannot excuse a late collapse by lowering its cap to match: the window has the contract floor too', () => {
  const r = soak(DEFAULT_MATRIX, { game: true, thinAt: 7000, thinCap: 3 }, LATE_RUN);
  assert.strictEqual(r.gate('Realised density').status, 'FAIL', r.out);
  assert.match(r.gate('Realised density').detail, /last 60 s target 3\.0 is under the contract floor of 41\.8/);
  assert.doesNotMatch(r.gate('Realised density').detail, /whole run/);
});

// These runs hold 20 or 30 contests, under the 300 the gate judges on, so they pin the arithmetic and evaluate's own tests pin the verdict.
for (const [why, dropped, blink, expected] of [
  ['one contest still open at run end is not counted', 1, false, /of 20 started, with 2 open at run end, BLINK in view on 100\.0%, bot lost 30\.0%/],
  ['an open contest adds nothing, even after it has blinked', 1, true, /of 20 started, with 2 open at run end, BLINK in view on 100\.0%/],
  ['contests that vanish count against the gate', 6, false, /of 30 started, with 2 open at run end, BLINK in view on 66\.7%, bot lost 20\.0%/],
  ['a contest with no result keeps the BLINK it earned', 6, true, /of 30 started, with 2 open at run end, BLINK in view on 100\.0%/]
]) {
  test(`Contest, from the real listeners: ${why}`, () => {
    const r = soak(DEFAULT_MATRIX, { game: true, contestsDropped: dropped, contestBlink: blink });
    assert.strictEqual(r.gate('Contest').status, 'NOT JUDGED', r.gate('Contest').detail);
    assert.match(r.gate('Contest').detail, expected);
  });
}

test('one NaN sample cannot hide a jam from the flow gate', () => {
  const r = soak(['--seeds', '1', '--bots', 'patrol', '--n', '100', ...SIM],
    { game: true, stationary: 0.9, nanField: 'stationaryShare', nanAt: 120 });
  assert.strictEqual(r.code, 1, r.out);
  assert.deepStrictEqual(failures(r), ['Flow'], r.out);
  assert.match(r.gate('Flow').detail, /stationary 0\.900/);
  assert.match(r.gate('Flow').detail, /not finite/);
});

test('one NaN sample fails the flow gate on an otherwise healthy run', () => {
  const r = soak(['--seeds', '1', '--bots', 'patrol', '--n', '100', ...SIM], { game: true, nanField: 'meanSpeed', nanAt: 120 });
  assert.strictEqual(r.code, 1, r.out);
  assert.deepStrictEqual(failures(r), ['Flow'], r.out);
  assert.strictEqual(r.report.jobs[0].traffic.nonFinite, 1);
});

for (const option of ['meanSpeed', 'stationary']) {
  test(`${option} NaN on every sample fails the flow gate and still ends in a verdict and a report`, () => {
    const r = soak(['--seeds', '1', '--bots', 'patrol', '--n', '100', ...SIM], { game: true, [option]: 'NaN' });
    assert.strictEqual(r.code, 1, r.out);
    assert.deepStrictEqual(failures(r), ['Flow'], r.out);
    assert.match(r.out, /SOAK FAIL/);
    assert.strictEqual(r.report.jobs.length, 2);
  });
}

test('a broken line printed mid-run does not cost the job', () => {
  const r = soak(['--seeds', '1', '--bots', 'patrol', '--n', '80', '--allow-skip', ...SIM], { strayResult: true });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.gate('Jobs ran').status, 'PASS');
});

test('results the gates cannot read still end in a verdict and a report with every job', () => {
  const r = soak(['--seeds', '1', '--bots', 'patrol', '--n', '100', ...SIM], { unreadable: true });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /SOAK FAIL/);
  assert.deepStrictEqual(failures(r), ['Evaluate']);
  assert.strictEqual(r.report.pass, false);
  assert.strictEqual(r.report.jobs.length, 2);
});

test('arguments reach a child through argv alone: a shell would split this path and expand $HOME', () => {
  const dir = fs.mkdtempSync(path.join(temp, 'two words $HOME '));
  const file = path.join(dir, 'stub.js');
  fs.copyFileSync(stub('soak_spawner.js'), file);
  const r = soak(['--seeds', '1', '--bots', 'patrol', '--n', '80', '--allow-skip', '--stub', file]);
  assert.strictEqual(r.gate('Jobs ran').status, 'PASS', r.out);
  assert.strictEqual(r.code, 0, r.out);
});

test('readResult takes the last result line, and any other output is no result', () => {
  const good = Object.fromEntries(['realised', 'density', 'traffic', 'near', 'hashes', 'heap', 'tick', 'invariants', 'tally'].map((k) => [k, null]));
  const line = `SOAK_RESULT ${JSON.stringify(good)}`;
  assert.deepStrictEqual(readResult(`noise\n${line}\n`).data, good);
  assert.deepStrictEqual(readResult(`SOAK_RESULT {not json\n${line}\n`).data, good);
  assert.match(readResult('noise\n').error, /no result/);
  assert.match(readResult(`${line}\nSOAK_RESULT {not json\n`).error, /bad result/);
  assert.match(readResult('SOAK_RESULT {}\n').error, /lacks realised/);
  assert.match(readResult('SOAK_RESULT null\n').error, /lacks realised/);
  assert.match(readResult('SOAK_RESULT 5\n').error, /lacks realised/);
});

test('gates and verdict print before the report is written', () => {
  const r = soak([...MATRIX, '--stub', stub('soak_spawner.js')]);
  assert.ok(r.out.indexOf('Realised density:') < r.out.indexOf('SOAK PASS'), r.out);
  assert.ok(r.out.indexOf('SOAK PASS') < r.out.indexOf('report: '), r.out);
});

/**
 * Runs a small matrix against a report path, one job at a time.
 * @param {string} out Report path.
 * @param {object} [env] What soak_child_preload.cjs reads. Without it, the preload is not loaded.
 * @param {number} [timeout] Milliseconds before the run is killed, for a path that could hang it.
 * @returns {object} The spawnSync result.
 */
function withOut(out, env, timeout) {
  return spawnSync(process.execPath, [SOAK, '--seeds', '1', '--bots', 'patrol', '--n', '80', '--minutes', '0.1', '--warmup-s', '1', '--jobs', '1',
    '--allow-skip', '--stub', stub('soak_spawner.js'), '--out', out], {
    encoding: 'utf8',
    shell: false,
    timeout,
    env: { ...process.env, ...(env && { NODE_OPTIONS: `--require "${stub('soak_child_preload.cjs')}"`, ...env }) }
  });
}

test('a report that can no longer be written costs the file, not the verdict', () => {
  const dir = fs.mkdtempSync(path.join(temp, 'going-'));
  const r = withOut(path.join(dir, 'report.json'), { SOAK_BREAK_OUT: dir });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS {2}Realised density/);
  assert.match(r.stdout, /SOAK PASS/);
  assert.match(r.stderr, /soak: the report was not written/);
  assert.doesNotMatch(r.stdout, /report: /);
});

test('a report path that cannot be written stops the run before any job starts', (t) => {
  const file = path.join(temp, 'a-file');
  fs.writeFileSync(file, '');
  const dir = fs.mkdtempSync(path.join(temp, 'taken-'));
  const locked = fs.mkdtempSync(path.join(temp, 'locked-'));
  const readOnly = path.join(temp, 'read-only.json');
  fs.writeFileSync(readOnly, '');
  fs.chmodSync(locked, 0o555);
  fs.chmodSync(readOnly, 0o444);
  t.after(() => fs.chmodSync(locked, 0o755));
  const cases = [['under a file', path.join(file, 'report.json')], ['a directory', dir], ['under /proc, where recursive mkdir hangs', '/proc/tlv-soak/report.json']];
  // Root ignores file modes.
  if (process.getuid() !== 0) cases.push(['a read-only directory', path.join(locked, 'report.json')], ['a read-only file', readOnly]);
  for (const [why, out] of cases) {
    const r = withOut(out, undefined, 20000);
    assert.strictEqual(r.status, 2, `${why}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /soak: cannot write the report to/, why);
    assert.doesNotMatch(r.stdout, /running/, `${why}: no job may start`);
  }
});

test('checking the report path makes its directory, and leaves nothing else behind', () => {
  const out = path.join(temp, 'new', 'dirs', 'report.json');
  const r = withOut(out);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(out)), ['report.json']);
  assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).pass, true);
});

test('checking the report path leaves a report already there as it was, until the run replaces it', () => {
  const out = path.join(temp, 'kept.json');
  fs.writeFileSync(out, 'old');
  const r = withOut(out, { SOAK_OLD_REPORT: out });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(out, 'utf8')).pass, true);
});

test('the report defaults to tools/reports/soak and carries the whole run', () => {
  const r = soak([...MATRIX, '--stub', stub('soak_spawner.js')]);
  assert.strictEqual(r.report.planned, 6);
  assert.deepStrictEqual(Object.keys(r.report).sort(), ['config', 'gates', 'jobs', 'pass', 'planned']);
  assert.ok(r.report.jobs.every((j) => j.hashes.length && j.tick.meanMs >= 0));
});

// Arguments: the failure this harness exists for. Zsh does not split "$VAR", so a list can arrive as one word.
for (const [why, args] of [
  ['a space-joined seed list', ['--seeds', '1 2 3', '--bots', 'patrol']],
  ['a space-joined bot list', ['--seeds', '1', '--bots', 'patrol idle']],
  ['an unknown bot', ['--seeds', '1', '--bots', 'patroll']],
  ['a space-joined density list', ['--seeds', '1', '--bots', 'patrol', '--n', '100 120']],
  ['an unknown flag', ['--seeds', '1', '--bots', 'patrol', '--nope']],
  ['a flag with no value', ['--seeds', '1', '--bots', 'patrol', '--n']],
  ['a stray word', ['--seeds', '1', '--bots', 'patrol', 'extra']],
  ['no seeds', ['--bots', 'patrol']],
  ['no bots', ['--seeds', '1']],
  ['a zero density', ['--seeds', '1', '--bots', 'patrol', '--n', '0']],
  ['a bad inject', ['--seeds', '1', '--bots', 'idle', '--inject', 'trapp']],
  ['a trap with no idle bot to teleport', ['--seeds', '1', '--bots', 'patrol,chaos', '--inject', 'trap']],
  ['bad minutes', ['--seeds', '1', '--bots', 'patrol', '--minutes', 'soon']],
  ['a stub that does not exist', ['--seeds', '1', '--bots', 'patrol', '--stub', '/no/such/stub.js']],
  ['one good stub and one missing', ['--seeds', '1', '--bots', 'patrol', '--stub', stub('soak_spawner.js'), '--stub', 'tests/core/stubs/nope.js']],
  ['a stub that is a directory', ['--seeds', '1', '--bots', 'patrol', '--stub', HERE]],
  ['--seeds twice', ['--seeds', '1', '--seeds', '2', '--bots', 'patrol']],
  ['--bots twice', ['--seeds', '1', '--bots', 'patrol', '--bots', 'idle']],
  ['--n twice', ['--seeds', '1', '--bots', 'patrol', '--n', '100', '--n', '120']],
  ['--minutes twice', ['--seeds', '1', '--bots', 'patrol', '--minutes', '1', '--minutes', '15']],
  ['--jobs twice', ['--seeds', '1', '--bots', 'patrol', '--jobs', '1', '--jobs', '2']],
  ['--map twice', ['--seeds', '1', '--bots', 'patrol', '--map', 'a', '--map', 'b']],
  ['--inject twice', ['--seeds', '1', '--bots', 'idle', '--inject', 'trap', '--inject', 'trap']],
  ['--out twice', ['--seeds', '1', '--bots', 'patrol', '--out', 'a.json', '--out', 'b.json']],
  ['--warmup-s twice', ['--seeds', '1', '--bots', 'patrol', '--warmup-s', '1', '--warmup-s', '2']],
  ['--timeout-s twice', ['--seeds', '1', '--bots', 'patrol', '--timeout-s', '1', '--timeout-s', '2']],
  ['--allow-skip twice', ['--seeds', '1', '--bots', 'patrol', '--allow-skip', '--allow-skip']]
]) {
  test(`${why} stops the run before it starts`, () => {
    const r = spawnSync(process.execPath, [SOAK, ...args], { encoding: 'utf8', shell: false });
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /SOAK PASS/);
  });
}

test('--stub is the flag that repeats, and every one is kept', () => {
  const cfg = parseArgs(['--seeds', '1', '--bots', 'patrol', ...SIM]);
  assert.deepStrictEqual(cfg.stubs, [stub('soak_options.js'), stub('soak_spawner.js')]);
});

test('a repeated flag is named in the refusal', () => {
  assert.throws(() => parseArgs(['--n', '100', '--n', '120']), /--n was given twice\. Only --stub repeats\./);
});

test('parseArgs reads the documented matrix', () => {
  const cfg = parseArgs('--seeds 1-20 --bots patrol,idle,chaos --n 100,120 --minutes 15 --jobs 14 --map tlv_center --inject trap'.split(' '));
  assert.strictEqual(cfg.seeds.length, 20);
  assert.deepStrictEqual(cfg.bots, ['patrol', 'idle', 'chaos']);
  assert.deepStrictEqual(cfg.n, [100, 120]);
  assert.strictEqual(cfg.minutes, 15);
  assert.strictEqual(cfg.jobs, 14);
  assert.strictEqual(cfg.inject, 'trap');
});

test('a trap needs an idle bot, not only idle bots', () => {
  assert.strictEqual(parseArgs('--seeds 1 --bots idle --inject trap'.split(' ')).inject, 'trap');
  assert.strictEqual(parseArgs('--seeds 1 --bots patrol,idle --inject trap'.split(' ')).inject, 'trap');
});

test('planJobs gives the full matrix, one repeat and one memory probe per bot and density', () => {
  const cfg = parseArgs('--seeds 1-3 --bots patrol,idle --n 100,120'.split(' '));
  const jobs = planJobs(cfg);
  assert.strictEqual(jobs.length, 3 * 2 * 2 + 4 + 4);
  assert.strictEqual(jobs.filter((j) => j.run === 1).length, 4);
  assert.ok(jobs.filter((j) => j.run === 1).every((j) => j.seed === 1));
  const probes = jobs.filter((j) => j.run === 2);
  assert.strictEqual(probes.length, 4);
  assert.ok(probes.every((j) => j.seed === 1 && j.minutes === 60 && j.settleMin === 30));
  assert.strictEqual(planJobs(parseArgs('--seeds 1-3 --bots patrol --minutes 1'.split(' '))).filter((j) => j.run === 2).length, 0, 'too short for a Memory gate');
});

/** A finished job with healthy numbers, for evaluate. */
function job(over = {}) {
  return {
    seed: 1, bot: 'patrol', n: 100, run: 0, wallS: 1, error: null,
    realised: { seed: 1, bot: 'patrol', density: 100, notitle: 1, immortal: 1, invariants: 1, map: 'x', ticks: 54000, inject: null },
    density: { target: 100, meanN: 100, minN: 100, samples: 840, trailN: 100, trailTarget: 100, trailSamples: 60 },
    traffic: { meanSpeed: 5.5, stationaryShare: 0.25 },
    near: { samples: 840, hits: 800 },
    hashes: [1, 2, 3],
    heap: { minutes: 14, slopeMBPer10Min: 0.1, peakMB: 80 },
    tick: { meanMs: 1, p99Ms: 3 },
    invariants: { registered: ['core.numeric', 'core.slots', 'traffic.lanes'], total: 0, byName: {}, first: [] },
    tally: {
      behaviours: {}, honks: 0, redRuns: 0,
      incidents: { AVOIDED: 0, HIT: 0, ABORTED: 0 },
      contests: { started: 0, resolved: 0, open: 0, blinkInView: 0, lost: 0 }
    },
    problems: 0,
    diagnostics: null,
    ...over
  };
}

function matrix(rows, over = {}) {
  const cfg = { bots: ['patrol'], minutes: 15, allowSkip: false, inject: null, ...over };
  const planned = rows.map((r) => ({ seed: r.seed, bot: r.bot, n: r.n, run: r.run }));
  const gates = evaluate(cfg, rows, planned);
  return (name) => gates.find((g) => g.name.startsWith(name));
}

const pair = (over = {}) => [job(over), job({ run: 1, ...over })];

test('evaluate: a clean matrix passes the gates it can judge', () => {
  const gate = matrix(pair());
  for (const name of ['Jobs ran', 'Realised config', 'Realised density', 'Numeric', 'Invariants', 'Flow', 'Determinism', 'Memory',
    'Nearby traffic', 'Tick budget']) {
    assert.strictEqual(gate(name).status, 'PASS', `${name}: ${gate(name).detail}`);
  }
  assert.strictEqual(gate('Fairness').status, 'N/A');
  assert.strictEqual(gate('Contest').status, 'N/A');
});

test('evaluate: a job that ran something else is caught', () => {
  const wrong = job({ realised: { ...job().realised, density: 60 } });
  assert.strictEqual(matrix([wrong, job({ run: 1 })])('Realised config').status, 'FAIL');
  const short = job({ realised: { ...job().realised, ticks: 100 } });
  assert.strictEqual(matrix([short, job({ run: 1 })])('Realised config').status, 'FAIL');
  const noParam = job({ realised: { ...job().realised, immortal: 0 } });
  assert.strictEqual(matrix([noParam, job({ run: 1 })])('Realised config').status, 'FAIL');
});

test('evaluate: no finished job can pass anything, even with allowSkip', () => {
  const dead = job({ error: 'spawn failed: ENOENT' });
  const gates = evaluate({ bots: ['patrol'], minutes: 15, allowSkip: true, inject: null }, [dead], [dead]);
  assert.ok(gates.every((g) => g.status === 'FAIL'), JSON.stringify(gates));
  assert.ok(gates.some((g) => g.name === 'Realised density'));
});

test('evaluate: an empty plan is a failure', () => {
  const gates = evaluate({ bots: [], minutes: 15, allowSkip: true, inject: null }, [], []);
  assert.strictEqual(gates[0].status, 'FAIL');
});

/** A finished job at default density, where the target comes from the sim. */
const defaultJob = (target, meanN, over = {}) => job({
  n: null,
  realised: { ...job().realised, density: null },
  density: { target, badTargets: 0, meanN, minN: meanN, samples: 840, trailN: meanN, trailTarget: target, trailSamples: 60, ...over }
});

/** A finished job at an asked-for density. */
const askedJob = (n, meanN, over = {}) => job({
  n,
  realised: { ...job().realised, density: n },
  density: { target: n, badTargets: 0, meanN, minN: meanN, samples: 840, trailN: meanN, trailTarget: n, trailSamples: 60, ...over }
});

const densityStatus = (row) => matrix([row, { ...row, run: 1 }])('Realised density').status;

test('evaluate: at default density the target must clear the contract floor of 11 x 3.8 lane-km', () => {
  assert.strictEqual(densityStatus(defaultJob(100, 100)), 'PASS');
  assert.strictEqual(densityStatus(defaultJob(70, 63)), 'PASS');
  assert.strictEqual(densityStatus(defaultJob(41.8, 41.8)), 'PASS');
  assert.strictEqual(densityStatus(defaultJob(41.7, 41.7)), 'FAIL');
  assert.strictEqual(densityStatus(defaultJob(3, 3)), 'FAIL');
  assert.match(matrix(pair(defaultJob(3, 3)))('Realised density').detail, /target 3\.0 is under the contract floor of 41\.8/);
});

test('evaluate: the floor is for a target the sim names, not one that was asked for', () => {
  assert.strictEqual(densityStatus(askedJob(30, 30)), 'PASS');
  assert.strictEqual(densityStatus(askedJob(30, 26)), 'FAIL');
});

test('evaluate: the 90% rule still holds above the floor', () => {
  assert.strictEqual(densityStatus(defaultJob(70, 62.9)), 'FAIL');
});

test('evaluate: no job can pass density with no cars or no target', () => {
  for (const row of [defaultJob(0, 0), defaultJob(100, 0), defaultJob(null, 100), defaultJob(NaN, 100), defaultJob(-5, 100),
    defaultJob(100, NaN), defaultJob(100, null), defaultJob(100, Infinity), askedJob(100, 0), askedJob(100, null),
    askedJob(100, 100, { target: 0 }), askedJob(100, 100, { target: null }), askedJob(100, 100, { target: -5 })]) {
    assert.strictEqual(densityStatus(row), 'FAIL', JSON.stringify(row.density));
  }
});

test('evaluate: the 90% line holds for the window, against the window\'s own target', () => {
  assert.strictEqual(densityStatus(askedJob(100, 100, { trailN: 90 })), 'PASS');
  assert.strictEqual(densityStatus(askedJob(100, 100, { trailN: 89.9 })), 'FAIL');
  assert.strictEqual(densityStatus(defaultJob(100, 100, { trailN: 63, trailTarget: 70 })), 'PASS');
  assert.strictEqual(densityStatus(defaultJob(100, 100, { trailN: 62.9, trailTarget: 70 })), 'FAIL');
  assert.match(matrix(pair(askedJob(100, 100, { trailN: 95 })))('Realised density').detail, /lowest job at 95\.0% of target/);
});

test('evaluate: the contract floor holds for the window at default density, and not at an asked-for one', () => {
  assert.strictEqual(densityStatus(defaultJob(100, 100, { trailN: 41.8, trailTarget: 41.8 })), 'PASS');
  assert.strictEqual(densityStatus(defaultJob(100, 100, { trailN: 41.7, trailTarget: 41.7 })), 'FAIL');
  assert.strictEqual(densityStatus(askedJob(30, 30)), 'PASS');
});

test('evaluate: a window with no cars or no target cannot pass', () => {
  for (const over of [{ trailN: 0 }, { trailN: null }, { trailN: NaN }, { trailN: undefined }, { trailN: Infinity }, { trailTarget: 0 },
    { trailTarget: null }, { trailTarget: NaN }, { trailTarget: undefined }, { trailTarget: -5 }]) {
    assert.strictEqual(densityStatus(defaultJob(100, 100, over)), 'FAIL', JSON.stringify(over));
    assert.strictEqual(densityStatus(askedJob(100, 100, over)), 'FAIL', JSON.stringify(over));
  }
});

test('evaluate: a cap that was unusable on any sample fails default density, and is ignored at an asked-for one', () => {
  assert.strictEqual(densityStatus(defaultJob(100, 100, { badTargets: 1 })), 'FAIL');
  assert.strictEqual(densityStatus(askedJob(100, 100, { badTargets: 1 })), 'PASS');
});

test('evaluate: traffic flow limits', () => {
  assert.strictEqual(matrix(pair({ traffic: { meanSpeed: 4.4, stationaryShare: 0.2 } }))('Flow').status, 'FAIL');
  assert.strictEqual(matrix(pair({ traffic: { meanSpeed: 6, stationaryShare: 0.46 } }))('Flow').status, 'FAIL');
});

test('evaluate: a number that is not finite fails its gate and never throws', () => {
  const healthy = job();
  const cases = [
    ['Flow', { traffic: { ...healthy.traffic, meanSpeed: null } }],
    ['Flow', { traffic: { ...healthy.traffic, meanSpeed: NaN } }],
    ['Flow', { traffic: { ...healthy.traffic, meanSpeed: Infinity } }],
    ['Flow', { traffic: { ...healthy.traffic, stationaryShare: null } }],
    ['Flow', { traffic: { ...healthy.traffic, stationaryShare: NaN } }],
    ['Flow', { traffic: { ...healthy.traffic, stationaryShare: -Infinity } }],
    ['Flow', { traffic: { ...healthy.traffic, nonFinite: 1 } }],
    ['Memory', { heap: { ...healthy.heap, slopeMBPer10Min: NaN } }],
    ['Memory', { heap: { ...healthy.heap, peakMB: null } }],
    ['Tick budget', { tick: { ...healthy.tick, meanMs: null } }],
    ['Tick budget', { tick: { ...healthy.tick, meanMs: NaN } }],
    ['Tick budget', { tick: { ...healthy.tick, p99Ms: null } }]
  ];
  for (const [name, over] of cases) assert.strictEqual(matrix(pair(over))(name).status, 'FAIL', `${name}: ${JSON.stringify(over)}`);
});

test('evaluate: invariant failures name the check', () => {
  const bad = job({ invariants: { ...job().invariants, total: 3, byName: { 'traffic.lanes': 3 } } });
  const gate = matrix([bad, job({ run: 1 })])('Invariants');
  assert.strictEqual(gate.status, 'FAIL');
  assert.match(gate.detail, /traffic\.lanes x 3/);
  const nan = job({ invariants: { ...job().invariants, total: 1, byName: { 'core.numeric': 1 } } });
  assert.strictEqual(matrix([nan, job({ run: 1 })])('Numeric').status, 'FAIL');
});

test('evaluate: memory limits', () => {
  assert.strictEqual(matrix(pair({ heap: { minutes: 14, slopeMBPer10Min: 1.5, peakMB: 80 } }))('Memory').status, 'FAIL');
  assert.strictEqual(matrix(pair({ heap: { minutes: 14, slopeMBPer10Min: 0.1, peakMB: 300 } }))('Memory').status, 'FAIL');
  assert.strictEqual(matrix(pair(), { minutes: 1 })('Memory').status, 'N/A');
});

// The measurement changed by decision: 80 sim-min runs show the 15 sim-min slope is V8 settling, so a probe's settled post-gc slope is what
// the gate reads when there is one. The limit is still 1 MB per 10 sim-min, and a matrix with no probe is judged as before, above.
test('evaluate: with a memory probe, the gate reads its settled slope, and a leak there still fails', () => {
  const settling = { heap: { minutes: 14, slopeMBPer10Min: 1.5, peakMB: 80 } };
  const probe = (slope, peak = 80) => job({ run: 2, heap: { minutes: 30, slopeMBPer10Min: slope, peakMB: peak }, realised: { ...job().realised, ticks: 216000 }, minutes: 60 });
  const gate = matrix([...pair(settling), probe(0.2)])('Memory');
  assert.strictEqual(gate.status, 'PASS');
  assert.match(gate.detail, /0\.20 MB per 10 sim-min, settled, over 30 sim-min of 1 probes/);
  assert.strictEqual(matrix([...pair(), probe(1)])('Memory').status, 'FAIL', 'the limit is under 1 MB');
  assert.strictEqual(matrix([...pair(), probe(0.2, 300)])('Memory').status, 'FAIL', 'the peak limit covers every job');
  assert.strictEqual(matrix([...pair({ heap: { minutes: 14, slopeMBPer10Min: 0.1, peakMB: 300 } }), probe(0.2)])('Memory').status, 'FAIL');
  assert.strictEqual(matrix([...pair(), probe(NaN)])('Memory').status, 'FAIL');
});

test('evaluate: tick budget applies at N=100', () => {
  assert.strictEqual(matrix(pair({ tick: { meanMs: 3.5, p99Ms: 4 } }))('Tick budget').status, 'FAIL');
  assert.strictEqual(matrix(pair({ tick: { meanMs: 1, p99Ms: 7 } }))('Tick budget').status, 'FAIL');
  const at120 = { n: 120, realised: { ...job().realised, density: 120 }, density: { target: 120, meanN: 120, minN: 120, samples: 1, trailN: 120, trailTarget: 120, trailSamples: 1 } };
  assert.strictEqual(matrix(pair({ ...at120, tick: { meanMs: 9, p99Ms: 9 } }))('Tick budget').status, 'N/A');
});

test('evaluate: a p99 needs a run long enough to mean something', () => {
  const over = { tick: { meanMs: 1, p99Ms: 7 } };
  assert.strictEqual(matrix(pair(over), { minutes: 0.9 })('Tick budget').status, 'N/A');
  assert.strictEqual(matrix(pair(over), { minutes: 1 })('Tick budget').status, 'FAIL');
});

test('evaluate: nearby traffic over all patrol samples', () => {
  assert.strictEqual(matrix(pair({ near: { samples: 100, hits: 79 } }))('Nearby traffic').status, 'FAIL');
  assert.strictEqual(matrix(pair({ near: { samples: 100, hits: 80 } }))('Nearby traffic').status, 'PASS');
});

test('evaluate: behaviours fire once per 15 sim-min, over all seeds', () => {
  const all = ['RED_RUN', 'TAILGATE', 'NOSE_IN', 'OVERTAKE_OUT', 'OVERTAKE_PASS', 'CUT_IN', 'PHANTOM_STOP', 'DROP_APPROACH',
    'DROPPED', 'PULLOUT', 'BUS_STOPPED', 'BUS_PULLOUT', 'DOUBLE_PARK'];
  const fired = Object.fromEntries(all.map((b) => [b, 1]));
  const tally = (behaviours, honks) => ({ ...job().tally, behaviours, honks });
  assert.strictEqual(matrix(pair({ tally: tally(fired, 1) }))('Behaviours').status, 'PASS');
  const { TAILGATE, ...missing } = fired;
  const gate = matrix(pair({ tally: tally(missing, 1) }))('Behaviours');
  assert.strictEqual(gate.status, 'FAIL');
  assert.match(gate.detail, /TAILGATE fired 0/);
  assert.match(matrix(pair({ tally: tally(fired, 0) }))('Behaviours').detail, /HONK fired 0/);
  assert.strictEqual(matrix(pair(), { minutes: 1 })('Behaviours').status, 'N/A');
});

test('evaluate: a red run seen only as traffic.redRun counts, and is not counted twice', () => {
  const all = ['TAILGATE', 'NOSE_IN', 'OVERTAKE_OUT', 'OVERTAKE_PASS', 'CUT_IN', 'PHANTOM_STOP', 'DROP_APPROACH',
    'DROPPED', 'PULLOUT', 'BUS_STOPPED', 'BUS_PULLOUT', 'DOUBLE_PARK'];
  const fired = Object.fromEntries(all.map((b) => [b, 2]));
  const viaEvent = { ...job().tally, behaviours: fired, honks: 2, redRuns: 2 };
  assert.strictEqual(matrix(pair({ tally: viaEvent }), { minutes: 30 })('Behaviours').status, 'PASS');
  const once = { ...job().tally, behaviours: { ...fired, RED_RUN: 1 }, honks: 2, redRuns: 1 };
  assert.strictEqual(matrix([job({ tally: once }), job({ run: 1 })], { minutes: 30 })('Behaviours').status, 'FAIL');
});

test('evaluate: fairness on the braker bot', () => {
  const braker = (avoided, hit) => {
    const realised = { ...job().realised, bot: 'braker' };
    return pair({ bot: 'braker', realised, tally: { ...job().tally, incidents: { AVOIDED: avoided, HIT: hit, ABORTED: 5 } } });
  };
  assert.strictEqual(matrix(braker(95, 5), { bots: ['braker'] })('Fairness').status, 'PASS');
  assert.strictEqual(matrix(braker(94, 6), { bots: ['braker'] })('Fairness').status, 'FAIL');
  assert.strictEqual(matrix(braker(0, 0), { bots: ['braker'] })('Fairness').status, 'FAIL');
});

test('evaluate: contests on the errands bot', () => {
  const errands = (resolved, blinkInView, lost) => {
    const realised = { ...job().realised, bot: 'errands' };
    return pair({ bot: 'errands', realised, tally: { ...job().tally, contests: { started: resolved, resolved, open: 0, blinkInView, lost } } });
  };
  // The limits, at the very size that is judged.
  assert.strictEqual(matrix(errands(300, 240, 90), { bots: ['errands'] })('Contest').status, 'PASS');
  assert.strictEqual(matrix(errands(300, 239, 90), { bots: ['errands'] })('Contest').status, 'FAIL', 'under 80% in view');
  assert.strictEqual(matrix(errands(300, 270, 59), { bots: ['errands'] })('Contest').status, 'FAIL', 'lost under 20%');
  assert.strictEqual(matrix(errands(300, 270, 136), { bots: ['errands'] })('Contest').status, 'FAIL', 'lost over 45%');
  assert.match(matrix(errands(300, 240, 90), { bots: ['errands'] })('Contest').detail, /^n=300: of 300 started/);
});

test('evaluate: under 300 contests the gate is not judged, whatever the rates, and the verdict does not hang on it', () => {
  const errands = (resolved, blinkInView, lost) => {
    const realised = { ...job().realised, bot: 'errands' };
    return pair({ bot: 'errands', realised, tally: { ...job().tally, contests: { started: resolved, resolved, open: 0, blinkInView, lost } } });
  };
  const contest = (row) => matrix(row, { bots: ['errands'] })('Contest');
  assert.strictEqual(contest(errands(299, 299, 90)).status, 'NOT JUDGED', 'one short of 300, in limits');
  assert.strictEqual(contest(errands(299, 0, 280)).status, 'NOT JUDGED', 'one short of 300, far out of limits');
  assert.match(contest(errands(92, 72, 40)).detail, /^n=92, under the 300 it takes to judge: of 92 started, with 0 open at run end, BLINK in view on 78\.3%, bot lost 43\.5%/);
  assert.strictEqual(contest(errands(0, 0, 0)).status, 'FAIL', 'no contest at all is still no data');
});

/** Two errands jobs and a repeat, each with these contest counts. */
const errandRows = (contests) => {
  const realised = { ...job().realised, bot: 'errands' };
  const row = (run) => job({ run, bot: 'errands', realised, tally: { ...job().tally, contests } });
  return [row(0), { ...row(0), seed: 2, realised: { ...realised, seed: 2 } }, row(1)];
};
const contestGate = (contests) => matrix(errandRows(contests), { bots: ['errands'] })('Contest');

test('evaluate: Contest divides by contests started, less the one each job ended inside', () => {
  // 160 of 176 started, in each of two jobs, with 16 open: 320 judged, not 288 resolved.
  const open = contestGate({ started: 176, resolved: 144, open: 16, blinkInView: 128, lost: 64 });
  assert.strictEqual(open.status, 'PASS', open.detail);
  assert.match(open.detail, /of 320 started, with 32 open at run end, BLINK in view on 80\.0%, bot lost 40\.0%/);
  // Started and never resolved, none open: the same counts over 352 fall under the line.
  const vanished = contestGate({ started: 176, resolved: 144, open: 0, blinkInView: 128, lost: 64 });
  assert.strictEqual(vanished.status, 'FAIL', vanished.detail);
  assert.match(vanished.detail, /BLINK in view on 72\.7%/);
});

test('evaluate: Contest loss share is over contests started too', () => {
  const low = contestGate({ started: 200, resolved: 100, open: 0, blinkInView: 200, lost: 30 });
  assert.strictEqual(low.status, 'FAIL', low.detail);
  assert.match(low.detail, /bot lost outside 20-45%/);
  const fine = contestGate({ started: 200, resolved: 100, open: 0, blinkInView: 200, lost: 40 });
  assert.strictEqual(fine.status, 'PASS', fine.detail);
});

test('evaluate: contests that all vanished are a failure, not missing data', () => {
  const gate = contestGate({ started: 150, resolved: 0, open: 0, blinkInView: 0, lost: 0 });
  assert.strictEqual(gate.status, 'FAIL');
  assert.doesNotMatch(gate.detail, /no data/);
  const skipped = matrix(errandRows({ started: 150, resolved: 0, open: 0, blinkInView: 0, lost: 0 }), { bots: ['errands'], allowSkip: true })('Contest');
  assert.strictEqual(skipped.status, 'FAIL');
});

test('evaluate: a matrix with nothing but open contests has no data', () => {
  for (const started of [0, 1]) {
    const gate = contestGate({ started, resolved: 0, open: started, blinkInView: 0, lost: 0 });
    assert.strictEqual(gate.status, 'FAIL');
    assert.match(gate.detail, /no data/);
  }
});

test('evaluate: the repeat run must match hash for hash', () => {
  const rows = [job({ hashes: [1, 2, 3] }), job({ run: 1, hashes: [1, 9, 3] })];
  assert.strictEqual(matrix(rows)('Determinism').status, 'FAIL');
  assert.strictEqual(matrix([job({ hashes: [1, 2, 3] }), job({ run: 1, hashes: [1, 2] })])('Determinism').status, 'FAIL');
});
