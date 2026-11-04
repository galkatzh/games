// tests/render/ayalon.test.mjs — WP-RENDER
// The Ayalon is scenery: a data file the ground pass reads, which the sim never sees. A missing file and a new area both need nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTLV } from '../../tools/lib/classic.mjs';
import { boxOf, loadSources, makeProjection, projectNodes } from '../../tools/lib/osm.mjs';
import { ayalonScript, motorwayLines } from '../../tools/ayalon.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILE = 'content/tlv_center/ayalon.js';
const area = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/areas/tlv_center.json'), 'utf8'));

/** @returns {Array<object>} The queued lines of a loaded game. */
function queued(TLV) {
  const rows = TLV.q.filter((item) => item[0] === 'motorway');
  assert.equal(rows.length, 1);
  return rows[0][1].lines;
}

test('the file is what the tool writes from the extract', { skip: !fs.existsSync(path.join(ROOT, 'tools/cache/tlv_center.osm.json')) }, () => {
  const proj = makeProjection(area.origin);
  const osm = loadSources(path.join(ROOT, 'tools/cache'), area.sources);
  projectNodes(osm.nodes, proj);
  const lines = motorwayLines(osm, boxOf(area.bbox, proj), proj);
  assert.equal(ayalonScript(lines), fs.readFileSync(path.join(ROOT, FILE), 'utf8'));
  const ways = [...osm.ways.values()].filter((w) => w.tags && /^motorway(_link)?$/.test(w.tags.highway) && w.tags.tunnel !== 'yes');
  const drawn = new Set(lines.map((l) => l.osm));
  const inside = ways.filter((w) => w.nodes.some((id) => {
    const n = osm.nodes.get(id);
    return n && n.lat >= area.bbox[0] && n.lat <= area.bbox[2] && n.lon >= area.bbox[1] && n.lon <= area.bbox[3];
  }));
  assert.ok(inside.length > 100);
  for (const w of inside) assert.ok(drawn.has(w.id), `way ${w.id} is in the box and not drawn`);
  assert.ok(lines.every((l) => l.osm !== 119550291), 'a tunnel cannot show in the ground pass');
});

test('every line is inside the area, with lanes and a direction of travel', () => {
  const lines = queued(createTLV({}));
  const [south, west, north, east] = area.bbox;
  assert.ok(lines.length > 100);
  assert.ok(lines.some((l) => !l.link) && lines.some((l) => l.link));
  for (const l of lines) {
    assert.ok(l.lanes >= 1 && l.lanes <= 6, `way ${l.osm}`);
    assert.ok(l.pts.length >= 4 && l.pts.length % 2 === 0, `way ${l.osm}`);
    for (let i = 0; i < l.pts.length; i += 2) {
      assert.ok(l.pts[i] >= south - 1e-5 && l.pts[i] <= north + 1e-5 && l.pts[i + 1] >= west - 1e-5 && l.pts[i + 1] <= east + 1e-5, `way ${l.osm}`);
    }
  }
});

test('the sim never sees it: same content hash and map with and without the file', () => {
  const withFile = createTLV({});
  queued(withFile);
  assert.equal(withFile._missing.length, 0);
  // A scratch content index that drops only this file, on the real tree's other files.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayalon-'));
  try {
    fs.cpSync(path.join(ROOT, 'js'), path.join(dir, 'js'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'content'), path.join(dir, 'content'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'data/maps/tlv_center'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'data/maps/index.js'), path.join(dir, 'data/maps/index.js'));
    fs.copyFileSync(path.join(ROOT, 'data/maps/tlv_center/map.js'), path.join(dir, 'data/maps/tlv_center/map.js'));
    fs.rmSync(path.join(dir, FILE));
    const without = createTLV({ root: dir, allowMissing: true });
    assert.deepEqual(without._missing, [FILE]);
    assert.equal(without.q.filter((item) => item[0] === 'motorway').length, 0);
    assert.equal(without.registry.contentHash(), withFile.registry.contentHash());
    assert.equal(without.world.get('tlv_center').meta.overlayHash, withFile.world.get('tlv_center').meta.overlayHash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a new area needs nothing: the default list does not name it, and the map that has it adds it to that list', () => {
  const TLV = createTLV({ files: [], content: true, allowMissing: true });
  assert.ok(!TLV.contentFiles.default.includes(FILE));
  assert.deepEqual(TLV.contentFiles.tlv_center, TLV.contentFiles.default.concat([FILE]));
  const mini = createTLV({ map: 'tests/fixtures/mini_map.js' });
  assert.equal(mini.q.filter((item) => item[0] === 'motorway').length, 0);
  assert.deepEqual(mini._missing, []);
});
