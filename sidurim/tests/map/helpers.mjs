// tests/map/helpers.mjs — WP-MAP test support.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntime, readMapPayload } from '../../tools/lib/report.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The shipped codec and anchors, through the classic loader when WP-CORE is present. */
export const runtime = () => loadRuntime(ROOT);

/** Decodes a written map file. */
export function decodeFile(TLV, file) {
  return TLV.mapCodec.decodeAll(readMapPayload(file));
}

/** A fresh temporary directory, removed by the caller through `t.after`. */
export function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlv-map-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Runs the importer as the command line does. Arguments stay an array, never a shell string. */
export function runImporter(args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/import.mjs'), ...args], { encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Parses a report file written by an isolated run. */
export function report(out, id, name) {
  return JSON.parse(fs.readFileSync(path.join(out, 'tools/reports', id, `${name}.json`), 'utf8'));
}

/** Rows of one table as plain objects, for readable assertions. */
export function rows(d, table) {
  const t = d.t[table];
  const names = Object.keys(t.col);
  const out = [];
  for (let i = 0; i < t.n; i++) {
    const row = { id: i };
    for (const k of names) row[k] = t.col[k][i];
    out.push(row);
  }
  return out;
}

/** Polyline of an edge in metres, as `[[x, y], ...]`. */
export function edgeLine(d, i) {
  const { ptOff } = d.t.edges.col;
  const out = [];
  for (let k = ptOff[i]; k < ptOff[i + 1]; k++) out.push([d.t.pts.col.x[k] * d.meta.unit, d.t.pts.col.y[k] * d.meta.unit]);
  return out;
}
