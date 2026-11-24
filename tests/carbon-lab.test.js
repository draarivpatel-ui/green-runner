'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const G = require('../engine.js');
const L = require('../carbon-lab.js');
const App = require('../app.js');
const { createFakeDocument } = require('./helpers/fake-dom.js');

const root = path.resolve(__dirname, '..');
const PRESET_IDS = G.PRESETS.map((p) => p.id);
const POLICY_IDS = L.LAB_POLICIES.map((p) => p.id);
const REGION_IDS = G.REGIONS.map((r) => r.id);

function mountLab() {
  const doc = createFakeDocument();
  const ctl = App.createController(G, doc, L).init();
  return { doc, ctl, el: (id) => doc.els[id] };
}

/* ---------- SHA-256 ---------- */

test('Lab SHA-256 01: empty string KAT', () => {
  assert.equal(L.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('Lab SHA-256 02: abc KAT', () => {
  assert.equal(L.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('Lab SHA-256 03: 448-bit boundary KAT', () => {
  assert.equal(L.sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('Lab SHA-256 04: quick brown fox KAT', () => {
  assert.equal(L.sha256Hex('The quick brown fox jumps over the lazy dog'),
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
});

test('Lab SHA-256 05: million-a KAT', () => {
  assert.equal(L.sha256Hex('a'.repeat(1000000)),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('Lab SHA-256 06: utf-8 input hashes deterministically', () => {
  const a = L.sha256Hex('carbon \u00e9\u4e2d\ud83d\udc4d');
  assert.equal(a, L.sha256Hex('carbon \u00e9\u4e2d\ud83d\udc4d'));
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('Lab SHA-256 07: different messages give different digests', () => {
  assert.notEqual(L.sha256Hex('a'), L.sha256Hex('b'));
  assert.notEqual(L.sha256Hex(''), L.sha256Hex(' '));
});

test('Lab SHA-256 08: digest length and hex alphabet', () => {
  ['x', 'green-runner', '{}', '\n'].forEach((m) => assert.match(L.sha256Hex(m), /^[0-9a-f]{64}$/, m));
});

/* ---------- canonical JSON ---------- */

test('Lab Canon 01: object keys sort recursively', () => {
  assert.equal(L.canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test('Lab Canon 02: arrays keep order', () => {
  assert.equal(L.canonicalJson([3, 1, 2]), '[3,1,2]');
});

test('Lab Canon 03: -0 normalizes to 0', () => {
  assert.equal(L.canonicalJson(-0), '0');
  assert.equal(L.canonicalJson({ x: -0 }), '{"x":0}');
});

test('Lab Canon 04: non-finite numbers become null', () => {
  assert.equal(L.canonicalJson(Infinity), 'null');
  assert.equal(L.canonicalJson(-Infinity), 'null');
  assert.equal(L.canonicalJson(NaN), 'null');
  assert.equal(L.canonicalJson({ a: NaN, b: Infinity }), '{"a":null,"b":null}');
});

test('Lab Canon 05: undefined and functions are skipped', () => {
  assert.equal(L.canonicalJson({ a: undefined, b: () => 1, c: 2 }), '{"c":2}');
});

test('Lab Canon 06: null, booleans and strings serialize exactly', () => {
  assert.equal(L.canonicalJson(null), 'null');
  assert.equal(L.canonicalJson(true), 'true');
  assert.equal(L.canonicalJson('a"b'), '"a\\"b"');
});

test('Lab Canon 07: number inputs are coerced safely', () => {
  assert.equal(L.canonicalJson(1.234567890123), '1.2345678901');
});

test('Lab Canon 08: same logical payload serializes identically', () => {
  const a = L.canonicalJson({ x: [1, { y: 2 }], z: 'w' });
  const b = L.canonicalJson({ z: 'w', x: [1, { y: 2 }] });
  assert.equal(a, b);
});

/* ---------- CSV escaping ---------- */

test('Lab CSV 01: formula prefixes get a leading quote', () => {
  ['=CMD()', '+SUM(1)', '-2+3', '@A1', '  =x'].forEach((v) => assert.equal(L.csvEscape(v)[0], "'", v));
});

test('Lab CSV 02: tab and newline starts are quoted too', () => {
  assert.equal(L.csvEscape('\tcmd')[0], "'");
  // a newline cell is formula-prefixed inside its quoting: "'\nx" -> "\"'\nx\""
  assert.equal(L.csvEscape('\nx'), '"\'\nx"');
  assert.ok(L.csvEscape('\nx').includes("'"), 'the quote prefix survives inside quoting');
});

test('Lab CSV 03: commas and quotes escape cleanly', () => {
  assert.equal(L.csvEscape('a,b'), '"a,b"');
  assert.equal(L.csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(L.csvEscape('plain, "text"'), '"plain, ""text"""');
});

test('Lab CSV 04: ordinary values pass through', () => {
  assert.equal(L.csvEscape('node-webapp'), 'node-webapp');
  assert.equal(L.csvEscape(42), '42');
  assert.equal(L.csvEscape(0), '0');
});

test('Lab CSV 05: null and undefined become empty cells', () => {
  assert.equal(L.csvEscape(null), '');
  assert.equal(L.csvEscape(undefined), '');
});

/* ---------- normalizeLabState ---------- */

test('Lab Norm 01: empty input gives the documented defaults', () => {
  assert.deepEqual(L.normalizeLabState({}), {
    presetId: 'node-webapp', policyId: 'hands-off-local', regionId: 'us-central1',
    maxDelayHours: 14, maxSlowdownPct: 15, startHour: 19
  });
});

test('Lab Norm 02: null, undefined, numbers and arrays give defaults', () => {
  [null, undefined, 5, 'x', [], [1]].forEach((v) => {
    assert.equal(L.normalizeLabState(v).policyId, 'hands-off-local');
  });
});

test('Lab Norm 03: unknown ids fall back to defaults', () => {
  const s = L.normalizeLabState({ presetId: 'nope', policyId: 'nope', regionId: 'mars' });
  assert.equal(s.presetId, 'node-webapp');
  assert.equal(s.policyId, 'hands-off-local');
  assert.equal(s.regionId, 'us-central1');
});

test('Lab Norm 04: hostile numbers fall back instead of propagating', () => {
  [NaN, Infinity, -Infinity, 'abc', {}].forEach((v) => {
    const s = L.normalizeLabState({ maxDelayHours: v, maxSlowdownPct: v, startHour: v });
    assert.equal(s.maxDelayHours, 14, String(v));
    assert.equal(s.maxSlowdownPct, 15, String(v));
    assert.equal(s.startHour, 19, String(v));
  });
});

test('Lab Norm 04b: null and [] coerce to 0 through Number()', () => {
  [null, []].forEach((v) => {
    const s = L.normalizeLabState({ maxDelayHours: v, maxSlowdownPct: v, startHour: v });
    assert.equal(s.maxDelayHours, 0, String(v));
    assert.equal(s.maxSlowdownPct, 0, String(v));
    assert.equal(s.startHour, 0, String(v));
  });
});

test('Lab Norm 05: delay clamps to 0..24 and rounds to half hours', () => {
  assert.equal(L.normalizeLabState({ maxDelayHours: -5 }).maxDelayHours, 0);
  assert.equal(L.normalizeLabState({ maxDelayHours: 99 }).maxDelayHours, 24);
  assert.equal(L.normalizeLabState({ maxDelayHours: 7.3 }).maxDelayHours, 7.5);
  assert.equal(L.normalizeLabState({ maxDelayHours: 7.26 }).maxDelayHours, 7.5);
});

test('Lab Norm 06: slowdown clamps to 0..50 as an integer', () => {
  assert.equal(L.normalizeLabState({ maxSlowdownPct: -2 }).maxSlowdownPct, 0);
  assert.equal(L.normalizeLabState({ maxSlowdownPct: 500 }).maxSlowdownPct, 50);
  assert.equal(L.normalizeLabState({ maxSlowdownPct: 22.6 }).maxSlowdownPct, 23);
});

test('Lab Norm 07: start hour clamps to 0..23 as an integer', () => {
  assert.equal(L.normalizeLabState({ startHour: -1 }).startHour, 0);
  assert.equal(L.normalizeLabState({ startHour: 25 }).startHour, 23);
  assert.equal(L.normalizeLabState({ startHour: 7.9 }).startHour, 8);
});

test('Lab Norm 08: -0 delay and hour become real zero', () => {
  const s = L.normalizeLabState({ maxDelayHours: -0, startHour: -0, maxSlowdownPct: -0 });
  assert.equal(Object.is(s.maxDelayHours, -0), false);
  assert.equal(s.maxDelayHours, 0);
  assert.equal(s.startHour, 0);
  assert.equal(s.maxSlowdownPct, 0);
});

test('Lab Norm 09: numeric strings are coerced', () => {
  const s = L.normalizeLabState({ maxDelayHours: '6', maxSlowdownPct: '20', startHour: '3' });
  assert.equal(s.maxDelayHours, 6);
  assert.equal(s.maxSlowdownPct, 20);
  assert.equal(s.startHour, 3);
});

test('Lab Norm 10: every real preset, policy and region id is accepted', () => {
  PRESET_IDS.forEach((p) => assert.equal(L.normalizeLabState({ presetId: p }).presetId, p));
  POLICY_IDS.forEach((p) => assert.equal(L.normalizeLabState({ policyId: p }).policyId, p));
  REGION_IDS.forEach((r) => assert.equal(L.normalizeLabState({ regionId: r }).regionId, r));
});

/* ---------- #gr= codec ---------- */

test('Lab Codec 01: full round trip on a distinctive state', () => {
  const st = { presetId: 'java-monorepo', policyId: 'region-plus-time', regionId: 'asia-southeast1', maxDelayHours: 8.5, maxSlowdownPct: 30, startHour: 2 };
  assert.deepEqual(L.decodeLabHash(L.encodeLabHash(st)), L.normalizeLabState(st));
});

PRESET_IDS.forEach((presetId) => {
  POLICY_IDS.forEach((policyId) => {
    test(`Lab Codec rt ${presetId} ${policyId}`, () => {
      const decoded = L.decodeLabHash(L.encodeLabHash({ presetId, policyId }));
      assert.equal(decoded.presetId, presetId);
      assert.equal(decoded.policyId, policyId);
    });
  });
});

REGION_IDS.forEach((regionId) => {
  test(`Lab Codec rt region ${regionId}`, () => {
    assert.equal(L.decodeLabHash(L.encodeLabHash({ regionId })).regionId, regionId);
  });
});

test('Lab Codec 02: encoded hash has the strict field shape', () => {
  const h = L.encodeLabHash({});
  assert.match(h, /^#gr=v1\|p=[a-z0-9-]+\|o=[a-z-]+\|r=[a-z0-9-]+\|d=\d+(\.\d+)?\|s=\d+\|h=\d+$/);
});

test('Lab Codec 03: out-of-range numbers normalize instead of failing', () => {
  const d = L.decodeLabHash('#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=99|s=200|h=30');
  assert.deepEqual(d, L.normalizeLabState({ presetId: 'node-webapp', policyId: 'baseline', regionId: 'us-central1', maxDelayHours: 99, maxSlowdownPct: 200, startHour: 30 }));
});

test('Lab Codec 04: wrong version, field count and empty body rejected', () => {
  ['#gr=', '#gr=v2|p=node-webapp|o=baseline|r=us-central1|d=4|s=15|h=19',
    '#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=4|s=15|h=19|x=1',
    '#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=4|s=15',
    '#gr=v1', 'gr=', 'no-hash', '', '   '].forEach((h) => {
    assert.equal(L.decodeLabHash(h), null, JSON.stringify(h));
  });
});

test('Lab Codec 05: unknown catalog ids are rejected', () => {
  ['#gr=v1|p=nope|o=baseline|r=us-central1|d=4|s=15|h=19',
    '#gr=v1|p=node-webapp|o=nope|r=us-central1|d=4|s=15|h=19',
    '#gr=v1|p=node-webapp|o=baseline|r=mars-1|d=4|s=15|h=19'].forEach((h) => {
    assert.equal(L.decodeLabHash(h), null, h);
  });
});

test('Lab Codec 06: prototype-pollution and hostile keys rejected', () => {
  ['#gr=v1|p=__proto__|o=baseline|r=us-central1|d=4|s=15|h=19',
    '#gr=v1|p=node-webapp|o=constructor|r=us-central1|d=4|s=15|h=19',
    '#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=4|s=15|h=19|p=x',
    '#gr=v1|__proto__=x|o=baseline|r=us-central1|d=4|s=15|h=19',
    '#gr=v1|constructor=node-webapp|o=baseline|r=us-central1|d=4|s=15|h=19',
    '#gr=v1|hasOwnProperty=node-webapp|o=baseline|r=us-central1|d=4|s=15|h=19'].forEach((h) => {
    assert.equal(L.decodeLabHash(h), null, h);
  });
  assert.equal({}.polluted, undefined);
});

test('Lab Codec 07: non-numeric and signed values rejected', () => {
  ['#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=abc|s=15|h=19',
    '#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=4|s=-15|h=19',
    '#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=4|s=15|h=+3',
    '#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=4|s=1e2|h=19',
    '#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=4|s=NaN|h=19',
    '#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=4|s=Infinity|h=19'].forEach((h) => {
    assert.equal(L.decodeLabHash(h), null, h);
  });
});

test('Lab Codec 08: markup and illegal characters rejected', () => {
  ['#gr=v1|p=<script>|o=baseline|r=us-central1|d=4|s=15|h=19',
    '#gr=v1|p=node%20web|o=baseline|r=us-central1|d=4|s=15|h=19',
    '#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=4|s=15|h=19|',
    '#gr=v1||p=node-webapp|o=baseline|r=us-central1|d=4|s=15|h=19',
    '#gr=v1|p=|o=baseline|r=us-central1|d=4|s=15|h=19',
    '#gr=v1|p=node webapp|o=baseline|r=us-central1|d=4|s=15|h=19'].forEach((h) => {
    assert.equal(L.decodeLabHash(h), null, h);
  });
});

test('Lab Codec 09: missing separators and equals rejected', () => {
  ['#gr=v1|p|o=baseline|r=us-central1|d=4|s=15|h=19',
    '#gr=v1|=node-webapp|o=baseline|r=us-central1|d=4|s=15|h=19',
    '#gr=v1|p=node-webapp,o=baseline,r=us-central1,d=4,s=15,h=19'].forEach((h) => {
    assert.equal(L.decodeLabHash(h), null, h);
  });
});

test('Lab Codec 10: decode reads a hash embedded in a full URL', () => {
  const h = 'https://aariv.me/green-runner/#gr=v1|p=python-ml|o=baseline|r=us-west1|d=2|s=5|h=8';
  const d = L.decodeLabHash(h);
  assert.equal(d.presetId, 'python-ml');
  assert.equal(d.regionId, 'us-west1');
  assert.equal(d.startHour, 8);
});

test('Lab Codec 11: non-string input is safe', () => {
  [null, undefined, 5, {}, [], NaN].forEach((v) => assert.equal(L.decodeLabHash(v), null));
});

test('Lab Codec 12: encode then decode is an identity over normalize', () => {
  const raw = { presetId: 'docs-site', policyId: 'time-shift-only', regionId: 'europe-west4', maxDelayHours: 3.3, maxSlowdownPct: 12.7, startHour: 21.4 };
  const once = L.decodeLabHash(L.encodeLabHash(raw));
  const twice = L.decodeLabHash(L.encodeLabHash(once));
  assert.deepEqual(once, twice);
});

/* ---------- comparator cells ---------- */

test('Lab Cells 01: matrix covers 5 policies x 6 presets = 30 cells', () => {
  const m = L.compareAll({});
  assert.equal(m.presets.length, 6);
  m.presets.forEach((row) => assert.equal(row.cells.length, 5, row.presetId));
  assert.equal(m.checkedCells, 30);
});

test('Lab Cells 02: matrix invariants all hold on the default state', () => {
  const m = L.compareAll({});
  assert.equal(m.allPinnedProtected, true);
  assert.equal(m.allIdempotent, true);
  assert.equal(m.allGatesCleared, true);
});

PRESET_IDS.forEach((presetId) => {
  POLICY_IDS.forEach((policyId) => {
    test(`Lab Cell ${presetId} ${policyId}`, () => {
      const c = L.runPolicyCell(presetId, policyId, {});
      assert.equal(c.ok, true);
      assert.ok(Number.isFinite(c.totalWh) && c.totalWh >= 0);
      assert.ok(Number.isFinite(c.totalGco2) && c.totalGco2 >= 0);
      assert.ok(c.gco2Pct >= -1e-9 && c.gco2Pct <= 100.0001, 'gco2Pct ' + c.gco2Pct);
      assert.ok(c.maxJobSlowdownPct >= 0 && c.maxJobSlowdownPct <= 50.0001);
      assert.equal(c.pinnedSafe, true, `${presetId}/${policyId}: ${c.pinnedViolations}`);
      assert.equal(c.gatesCleared, true, `${presetId}/${policyId}: ${c.gateViolations}`);
      assert.equal(c.idempotent, true, `${presetId}/${policyId}: second pass diverged`);
    });
  });
});

PRESET_IDS.forEach((presetId) => {
  test(`Lab Cell ${presetId}: baseline changes nothing`, () => {
    const c = L.runPolicyCell(presetId, 'baseline', {});
    assert.equal(c.changedJobs, 0);
    assert.equal(c.gco2Pct, 0);
    assert.equal(c.whPct, 0);
    assert.equal(c.maxJobSlowdownPct, 0);
  });
});

PRESET_IDS.forEach((presetId) => {
  test(`Lab Cell ${presetId}: right-size-only never moves a job off the pipeline`, () => {
    const c = L.runPolicyCell(presetId, 'right-size-only', {});
    assert.equal(c.movedJobs, 0);
    assert.equal(c.schedules, 0);
  });
});

PRESET_IDS.forEach((presetId) => {
  test(`Lab Cell ${presetId}: time-shift-only never resizes`, () => {
    const c = L.runPolicyCell(presetId, 'time-shift-only', {});
    assert.equal(c.resizedJobs, 0);
    assert.equal(c.maxJobSlowdownPct, 0);
  });
});

PRESET_IDS.forEach((presetId) => {
  test(`Lab Cell ${presetId}: region-plus-time saves at least as much as hands-off`, () => {
    const local = L.runPolicyCell(presetId, 'hands-off-local', {});
    const region = L.runPolicyCell(presetId, 'region-plus-time', {});
    assert.ok(region.gco2Pct >= local.gco2Pct - 1e-9, `${region.gco2Pct} vs ${local.gco2Pct}`);
  });
});

PRESET_IDS.forEach((presetId) => {
  test(`Lab Cell ${presetId}: hands-off saves at least as much as right-size or time alone`, () => {
    const both = L.runPolicyCell(presetId, 'hands-off-local', {});
    const rs = L.runPolicyCell(presetId, 'right-size-only', {});
    const ts = L.runPolicyCell(presetId, 'time-shift-only', {});
    assert.ok(both.gco2Pct >= rs.gco2Pct - 1e-9, `${both.gco2Pct} vs rs ${rs.gco2Pct}`);
    assert.ok(both.gco2Pct >= ts.gco2Pct - 1e-9, `${both.gco2Pct} vs ts ${ts.gco2Pct}`);
  });
});

PRESET_IDS.forEach((presetId) => {
  test(`Lab Cell ${presetId}: every policy saves at least nothing`, () => {
    POLICY_IDS.forEach((policyId) => {
      const c = L.runPolicyCell(presetId, policyId, {});
      assert.ok(c.savedGco2 >= -1e-9, `${policyId} ${c.savedGco2}`);
      assert.ok(c.savedWh >= -1e-9, `${policyId} wh ${c.savedWh}`);
    });
  });
});

test('Lab Cells 03: cell slowdown never exceeds the budget', () => {
  [0, 10, 25, 50].forEach((pct) => {
    const c = L.runPolicyCell('node-webapp', 'region-plus-time', { maxSlowdownPct: pct });
    assert.ok(c.maxJobSlowdownPct <= pct + 1e-9, `budget ${pct}: ${c.maxJobSlowdownPct}`);
  });
});

test('Lab Cells 04: zero slowdown budget means zero resizing', () => {
  ['right-size-only', 'hands-off-local', 'region-plus-time'].forEach((policyId) => {
    const c = L.runPolicyCell('python-ml', policyId, { maxSlowdownPct: 0 });
    assert.equal(c.resizedJobs, 0, policyId);
    assert.equal(c.maxJobSlowdownPct, 0, policyId);
  });
});

test('Lab Cells 05: hostile state fields still produce valid cells', () => {
  [NaN, -5, 999, 'x', null].forEach((v) => {
    const c = L.runPolicyCell('node-webapp', 'hands-off-local', { maxSlowdownPct: v, maxDelayHours: v, startHour: v });
    assert.equal(c.ok, true, String(v));
    assert.ok(Number.isFinite(c.totalGco2));
  });
});

test('Lab Cells 06: unknown preset and policy ids fall back safely', () => {
  const c = L.runPolicyCell('not-a-preset', 'not-a-policy', {});
  assert.equal(c.ok, true);
  assert.equal(c.presetId, 'node-webapp');
  assert.equal(c.policyId, 'baseline');
});

/* ---------- pinned-job safety ---------- */

PRESET_IDS.forEach((presetId) => {
  test(`Lab Pinned ${presetId}: no pinned job is deferred or re-ruled`, () => {
    const run = G.runGreenAgent(G.getPreset(presetId).yaml, G.getPreset(presetId).telemetry,
      { allowRegionShift: true, minGainPct: 0, maxDelayHours: 24 });
    G.jobsOf(run.doc).forEach((name) => {
      if (run.classification[name].deferrable) return;
      assert.equal(run.deferred[name], undefined, `${presetId}:${name} deferred`);
      assert.deepEqual(run.patched[name].rules, run.doc[name].rules, `${presetId}:${name} rules rewritten`);
      assert.ok(!run.changes.some((c) => c.job === name && /^shift/.test(c.type)), `${presetId}:${name} shifted`);
    });
  });
});

test('Lab Pinned 01: deploy and release never move even under max delay and region shift', () => {
  PRESET_IDS.forEach((presetId) => {
    const c = L.runPolicyCell(presetId, 'region-plus-time', { maxDelayHours: 24, maxSlowdownPct: 50 });
    assert.equal(c.pinnedSafe, true, `${presetId}: ${c.pinnedViolations}`);
  });
});

test('Lab Pinned 02: a release in the needs chain keeps its supplier pinned', () => {
  const c = L.runPolicyCell('java-monorepo', 'region-plus-time', { maxDelayHours: 24 });
  assert.equal(c.pinnedSafe, true);
  const run = G.runGreenAgent(G.getPreset('java-monorepo').yaml, G.getPreset('java-monorepo').telemetry, { allowRegionShift: true, minGainPct: 0 });
  assert.equal(run.deferred['dast-scan'], undefined);
});

/* ---------- slowdown frontier ---------- */

test('Lab Frontier 01: sweep shape is 6 regions x 11 budgets', () => {
  const s = L.sweepSlowdownFrontier('node-webapp', {});
  assert.equal(s.perRegion.length, 6);
  s.perRegion.forEach((pr) => assert.equal(pr.points.length, 11, pr.regionId));
  assert.equal(s.frontier.length, 11);
  assert.deepEqual(s.budgets, L.SLOWDOWN_SWEEP_PCTS);
});

test('Lab Frontier 02: frontier ties or beats every region line', () => {
  const s = L.sweepSlowdownFrontier('node-webapp', {});
  s.perRegion.forEach((pr) => {
    pr.points.forEach((p, i) => {
      assert.ok(s.frontier[i].gco2Pct >= p.gco2Pct - 1e-9, `${pr.regionId}@${p.budgetPct}: ${p.gco2Pct} vs frontier ${s.frontier[i].gco2Pct}`);
    });
  });
});

test('Lab Frontier 03: frontier names a real winning region per point', () => {
  const s = L.sweepSlowdownFrontier('node-webapp', {});
  s.frontier.forEach((p) => {
    assert.ok(REGION_IDS.includes(p.regionId), p.regionId);
    const line = s.perRegion.find((r) => r.regionId === p.regionId);
    assert.equal(line.points[p.budgetPct / 5].gco2Pct, p.gco2Pct);
  });
});

PRESET_IDS.forEach((presetId) => {
  test(`Lab Frontier ${presetId}: frontier is monotone nondecreasing`, () => {
    const s = L.sweepSlowdownFrontier(presetId, {});
    for (let i = 1; i < s.frontier.length; i += 1) {
      assert.ok(s.frontier[i].gco2Pct >= s.frontier[i - 1].gco2Pct - 1e-9,
        `${presetId}: ${s.frontier[i - 1].budgetPct}%->${s.frontier[i].budgetPct}%`);
    }
  });
});

PRESET_IDS.forEach((presetId) => {
  test(`Lab Frontier ${presetId}: every region line is monotone nondecreasing`, () => {
    const s = L.sweepSlowdownFrontier(presetId, {});
    s.perRegion.forEach((pr) => {
      for (let i = 1; i < pr.points.length; i += 1) {
        assert.ok(pr.points[i].gco2Pct >= pr.points[i - 1].gco2Pct - 1e-9,
          `${presetId}/${pr.regionId}: ${pr.points[i - 1].budgetPct}%->${pr.points[i].budgetPct}%`);
      }
    });
  });
});

test('Lab Frontier 04: all sweep values are bounded percents', () => {
  const s = L.sweepSlowdownFrontier('java-monorepo', {});
  s.perRegion.forEach((pr) => pr.points.forEach((p) => {
    assert.ok(Number.isFinite(p.gco2Pct) && p.gco2Pct >= -1e-9 && p.gco2Pct <= 100.0001, `${pr.regionId}@${p.budgetPct}: ${p.gco2Pct}`);
  }));
});

test('Lab Frontier 05: frontier honors the lab delay and hour knobs', () => {
  const a = L.sweepSlowdownFrontier('node-webapp', { maxDelayHours: 0 });
  const b = L.sweepSlowdownFrontier('node-webapp', { maxDelayHours: 24 });
  b.frontier.forEach((p, i) => assert.ok(p.gco2Pct >= a.frontier[i].gco2Pct - 1e-9, `budget ${p.budgetPct}`));
});

/* ---------- delay sweep ---------- */

test('Lab Delay 01: sweep shape is 15 windows for the selected region', () => {
  const s = L.sweepDelay('node-webapp', {});
  assert.equal(s.points.length, 15);
  assert.equal(s.regionId, 'us-central1');
  assert.deepEqual(s.points.map((p) => p.delayHours), L.DELAY_SWEEP_HOURS);
});

REGION_IDS.forEach((regionId) => {
  test(`Lab Delay ${regionId}: sweep is monotone nondecreasing`, () => {
    const s = L.sweepDelay('go-service', { regionId });
    for (let i = 1; i < s.points.length; i += 1) {
      assert.ok(s.points[i].gco2Pct >= s.points[i - 1].gco2Pct - 1e-9,
        `${regionId}: ${s.points[i - 1].delayHours}h->${s.points[i].delayHours}h`);
    }
  });
});

test('Lab Delay 02: zero delay still saves through right-sizing', () => {
  const s = L.sweepDelay('node-webapp', { regionId: 'us-central1', maxSlowdownPct: 50 });
  const rs = L.runPolicyCell('node-webapp', 'right-size-only', { maxSlowdownPct: 50 });
  assert.ok(s.points[0].gco2Pct >= rs.gco2Pct - 0.15,
    `delay0 ${s.points[0].gco2Pct} vs right-size ${rs.gco2Pct}`);
});

test('Lab Delay 03: sweep respects the chosen region', () => {
  const s = L.sweepDelay('python-ml', { regionId: 'asia-southeast1' });
  assert.equal(s.regionId, 'asia-southeast1');
  s.points.forEach((p) => assert.ok(p.gco2Pct <= 100.0001 && p.gco2Pct >= -1e-9));
});

/* ---------- greenest launch ---------- */

test('Lab Green 01: six regions each report a valid hour', () => {
  const g = L.greenestLaunch('node-webapp', {});
  assert.equal(g.length, 6);
  g.forEach((x) => {
    assert.ok(REGION_IDS.includes(x.regionId));
    assert.ok(Number.isInteger(x.hour) && x.hour >= 0 && x.hour <= 23, `${x.regionId} ${x.hour}`);
    assert.ok(Number.isFinite(x.gco2) && x.gco2 > 0);
  });
});

REGION_IDS.forEach((regionId) => {
  test(`Lab Green ${regionId}: greenest hour is a true minimum across the day`, () => {
    const p = G.getPreset('go-service');
    const doc = G.parseGitlabCI(p.yaml);
    const tel = G.normalizeTelemetry(doc, p.telemetry);
    const entry = L.greenestLaunch('go-service', {}).find((g) => g.regionId === regionId);
    for (let h = 0; h < 24; h += 1) {
      const sim = G.simulatePipeline(doc, tel, { region: regionId, startHour: h });
      assert.ok(sim.totalGco2 >= entry.gco2 - 1e-9, `${regionId}@${h}: ${sim.totalGco2} vs ${entry.gco2}`);
    }
  });
});

test('Lab Green 02: greenest never worse than the lab launch hour', () => {
  L.greenestLaunch('python-ml', { startHour: 7 }).forEach((g) => {
    assert.ok(g.gco2 <= g.gco2AtStart + 1e-9, g.regionId);
  });
});

test('Lab Green 03: greenest hour respects the chosen preset', () => {
  const a = L.greenestLaunch('docs-site', {});
  const b = L.greenestLaunch('mobile-app', {});
  assert.notDeepEqual(a.map((g) => g.gco2), b.map((g) => g.gco2));
});

test('Lab Green 04: saving percent is honest when launch is already optimal', () => {
  const best = L.greenestLaunch('node-webapp', {}).find((x) => x.regionId === 'us-central1').hour;
  const g = L.greenestLaunch('node-webapp', { startHour: best });
  const iowa = g.find((x) => x.regionId === 'us-central1');
  assert.equal(iowa.hour, best);
  assert.equal(iowa.savingPct, 0);
});

/* ---------- stamped report ---------- */

test('Lab Digest 01: stamped report carries schema, inputs, matrix, sweeps, greenest and disclosure', () => {
  const s = L.getStampedReport({});
  assert.equal(s.payload.schema, 'greenrunner-carbon-brief/v1');
  assert.equal(s.payload.kind, 'greenrunner-carbon-brief');
  assert.equal(s.payload.comparator.length, 6);
  assert.equal(s.payload.slowdownFrontier.frontier.length, 11);
  assert.equal(s.payload.delaySweep.points.length, 15);
  assert.equal(s.payload.greenestLaunch.length, 6);
  assert.match(s.payload.disclosure, /estimates/i);
  assert.match(s.payload.disclosure, /synthetic/i);
});

test('Lab Digest 02: digest is a stable sha256 hex for a state', () => {
  const a = L.getStampedReport({});
  const b = L.getStampedReport({});
  assert.equal(a.digestHex, b.digestHex);
  assert.match(a.digestHex, /^[0-9a-f]{64}$/);
  assert.ok(a === b, 'stamped object is cached per state key');
});

test('Lab Digest 03: different states give different digests', () => {
  const base = L.getStampedReport({});
  const other = L.getStampedReport({ presetId: 'python-ml' });
  assert.notEqual(base.digestHex, other.digestHex);
});

test('Lab Digest 04: verify accepts the stamped payload', () => {
  const s = L.getStampedReport({});
  const v = L.verifyStampedReport(s);
  assert.equal(v.ok, true);
  assert.equal(v.expected, s.digestHex);
  assert.equal(v.actual, s.digestHex);
});

test('Lab Digest 05: tampering with inputs flips the verdict', () => {
  const s = L.getStampedReport({});
  const tampered = Object.assign({}, s.payload, { inputs: Object.assign({}, s.payload.inputs, { maxSlowdownPct: 50 }) });
  const v = L.verifyStampedReport({ payload: tampered, digestHex: s.digestHex });
  assert.equal(v.ok, false);
  assert.equal(v.expected, s.digestHex);
  assert.notEqual(v.actual, s.digestHex);
});

test('Lab Digest 06: tampering with a comparator cell flips the verdict', () => {
  const s = L.getStampedReport({});
  const tampered = JSON.parse(JSON.stringify(s.payload));
  tampered.comparator[0].cells[0].gco2Pct = 99.9;
  assert.equal(L.verifyStampedReport({ payload: tampered, digestHex: s.digestHex }).ok, false);
});

test('Lab Digest 07: tampering with the disclosure flips the verdict', () => {
  const s = L.getStampedReport({});
  const tampered = Object.assign({}, s.payload, { disclosure: s.payload.disclosure + ' (not really)' });
  assert.equal(L.verifyStampedReport({ payload: tampered, digestHex: s.digestHex }).ok, false);
});

test('Lab Digest 08: verify on a bare exported payload uses its integritySha256', () => {
  const parsed = JSON.parse(L.exportReportJson({}));
  const v = L.verifyStampedReport(parsed);
  assert.equal(v.ok, true);
  assert.equal(v.expected, parsed.integritySha256);
});

test('Lab Digest 09: empty and hostile inputs verify cleanly false', () => {
  assert.equal(L.verifyStampedReport(null).ok, false);
  assert.equal(L.verifyStampedReport({}).ok, false);
  assert.equal(L.verifyStampedReport({ payload: {}, digestHex: 'zzz' }).ok, false);
});

test('Lab Digest 10: added and removed fields both break the digest', () => {
  const s = L.getStampedReport({});
  const added = Object.assign({}, s.payload, { extra: 1 });
  assert.equal(L.verifyStampedReport({ payload: added, digestHex: s.digestHex }).ok, false);
  const removed = Object.assign({}, s.payload);
  delete removed.greenestLaunch;
  assert.equal(L.verifyStampedReport({ payload: removed, digestHex: s.digestHex }).ok, false);
});

/* ---------- exports ---------- */

test('Lab Export 01: JSON parses and carries the stamped digest', () => {
  const s = L.getStampedReport({});
  const parsed = JSON.parse(L.exportReportJson({}));
  assert.equal(parsed.integritySha256, s.digestHex);
  assert.equal(parsed.schema, L.LAB_SCHEMA_VERSION);
});

test('Lab Export 02: CSV header carries the same digest', () => {
  const s = L.getStampedReport({});
  const csv = L.exportReportCsv({});
  assert.match(csv, new RegExp('^# greenrunner-carbon-brief '));
  assert.ok(csv.includes('# sha256:' + s.digestHex));
});

test('Lab Export 03: Markdown footer carries the same digest', () => {
  const s = L.getStampedReport({});
  const md = L.exportReportMarkdown({});
  assert.ok(md.includes('sha256:' + s.digestHex));
});

test('Lab Export 04: JSON, CSV, MD and the stamped object share one digest', () => {
  const s = L.getStampedReport({ presetId: 'go-service' });
  const j = JSON.parse(L.exportReportJson({ presetId: 'go-service' }));
  const c = L.exportReportCsv({ presetId: 'go-service' });
  const m = L.exportReportMarkdown({ presetId: 'go-service' });
  [j.integritySha256, s.digestHex].forEach((d) => {
    assert.ok(c.includes(d));
    assert.ok(m.includes(d));
  });
});

test('Lab Export 05: CSV has a row per comparator cell plus headers', () => {
  const csv = L.exportReportCsv({});
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 4 + 1 + 30);
  assert.equal(lines[4].split(',').length, 18);
});

test('Lab Export 06: CSV marks all cells protected, clean and idempotent', () => {
  const csv = L.exportReportCsv({});
  const rows = csv.trim().split('\n').slice(5);
  rows.forEach((r) => assert.match(r, /,yes,yes,yes$/, r));
});

test('Lab Export 07: CSV formula safety survives a hostile-looking policy id', () => {
  const csv = L.exportReportCsv({});
  assert.ok(!/^[=+\-@]/m.test(csv.split('\n').slice(5).join('\n')));
});

test('Lab Export 08: Markdown carries the comparator table and frontier', () => {
  const md = L.exportReportMarkdown({});
  assert.match(md, /## Policy comparator across all six presets/);
  assert.match(md, /## Carbon saved vs slowdown budget/);
  assert.match(md, /## Greenest launch hour per region/);
  assert.match(md, /\| Budget % \| Best saving % \| Region \|/);
});

test('Lab Export 09: disclosures state estimates and synthetic curves', () => {
  const md = L.exportReportMarkdown({});
  const csv = L.exportReportCsv({});
  const payload = L.getStampedReport({}).payload;
  assert.match(csv, /deterministic model estimates/i);
  assert.match(payload.disclosure, /estimates/i);
  assert.match(md, /synthetic/i);
  assert.match(md, /not a measurement/i);
  assert.match(md, /stated energy model/i);
});

test('Lab Export 10: exports reflect the selected state, not defaults', () => {
  const csv = L.exportReportCsv({ presetId: 'mobile-app', maxSlowdownPct: 40 });
  assert.ok(csv.includes('preset=mobile-app'));
  assert.ok(csv.includes('max_slowdown_pct=40'));
});

test('Lab Export 11: exports on hostile state input still work', () => {
  [null, 5, { presetId: NaN }, { maxDelayHours: Infinity }].forEach((v) => {
    assert.doesNotThrow(() => L.exportReportJson(v), String(v));
    assert.doesNotThrow(() => L.exportReportCsv(v), String(v));
    assert.doesNotThrow(() => L.exportReportMarkdown(v), String(v));
  });
});

test('Lab Export 12: Markdown pipes in names cannot break the table', () => {
  const md = L.exportReportMarkdown({});
  md.split('\n').filter((l) => l.startsWith('|')).forEach((l) => {
    assert.ok(l.trim().endsWith('|'), l);
  });
});

/* ---------- renderer markup ---------- */

test('Lab Markup 01: comparator rows render 5 policies with selected class', () => {
  const html = L.renderComparatorRowsHtml({ policyId: 'region-plus-time' });
  assert.equal((html.match(/<tr/g) || []).length, 5);
  assert.equal((html.match(/is-selected/g) || []).length, 1);
  assert.ok(html.includes('data-policy-id="region-plus-time"'));
  POLICY_IDS.forEach((p) => assert.ok(html.includes(`data-policy-id="${p}"`), p));
});

test('Lab Markup 02: every comparator row carries the three verdict pills', () => {
  const html = L.renderComparatorRowsHtml({});
  assert.equal((html.match(/lab-pill-ok/g) || []).length, 15);
  assert.ok(!html.includes('lab-pill-bad'));
});

test('Lab Markup 03: matrix renders 6 preset rows x 5 policy cells', () => {
  const html = L.renderPresetMatrixRowsHtml({});
  assert.equal((html.match(/lab-preset-row/g) || []).length, 6);
  assert.equal((html.match(/data-gr-pick-policy/g) || []).length, 30);
  assert.equal((html.match(/is-selected/g) || []).length, 1, 'one selected preset row');
  assert.equal((html.match(/lab-cell-sel/g) || []).length, 6, 'selected policy column on all six rows');
});

test('Lab Markup 04: curves svg draws six polylines and six focusable markers', () => {
  const svg = L.renderCurvesSvg({});
  assert.equal((svg.match(/<polyline/g) || []).length, 6);
  assert.equal((svg.match(/data-gr-region/g) || []).length, 6);
  assert.equal((svg.match(/tabindex="0"/g) || []).length, 6);
  assert.ok(svg.includes('launch 19:00'));
  assert.ok(svg.startsWith('<svg'));
});

test('Lab Markup 05: pareto svg draws 6 region lines, a frontier line and 11 markers', () => {
  const svg = L.renderParetoSvg({});
  assert.equal((svg.match(/stroke-opacity="0\.55"/g) || []).length, 6);
  assert.equal((svg.match(/data-gr-frontier/g) || []).length, 11);
  assert.ok(svg.includes('max job slowdown budget %'));
});

test('Lab Markup 06: delay table renders both header and value rows', () => {
  const html = L.renderDelaySweepTableHtml({});
  assert.ok(html.includes('Max delay h'));
  assert.ok(html.includes('Saved %'));
  assert.equal((html.match(/<td/g) || []).length, 30);
});

test('Lab Markup 07: greenest table renders six region rows', () => {
  const html = L.renderGreenestRowsHtml({});
  assert.equal((html.match(/lab-region-row/g) || []).length, 6);
  assert.ok(html.includes(':00'));
  REGION_IDS.forEach((r) => assert.ok(html.includes(r), r));
});

test('Lab Markup 08: option renderers cover all presets and regions', () => {
  const p = L.renderPresetOptionsHtml();
  const r = L.renderRegionOptionsHtml();
  assert.equal((p.match(/<option/g) || []).length, 6);
  assert.equal((r.match(/<option/g) || []).length, 6);
});

test('Lab Markup 09: markup escapes hostile content', () => {
  assert.equal(L.escapeXml('<img src=x onerror=alert(1)>&"'), '&lt;img src=x onerror=alert(1)&gt;&amp;&quot;');
  const html = L.renderCurvesSvg({ regionId: '<svg>' });
  assert.ok(!html.includes('region="<svg>"'), html);
});

test('Lab Markup 10: renderers work on hostile state input', () => {
  [{ presetId: 42 }, { regionId: {} }, { maxSlowdownPct: 'x' }].forEach((v) => {
    assert.doesNotThrow(() => L.renderComparatorRowsHtml(v));
    assert.doesNotThrow(() => L.renderCurvesSvg(v));
    assert.doesNotThrow(() => L.renderParetoSvg(v));
  });
});

/* ---------- in-page self-tests ---------- */

test('Lab SelfTest 01: every in-page check passes on the default state', () => {
  const results = L.runLabSelfTests({});
  assert.ok(results.length >= 16, results.length + ' checks');
  results.forEach((r) => assert.equal(r.pass, true, `${r.name}: ${r.detail}`));
});

test('Lab SelfTest 02: every check has a unique name and a detail string', () => {
  const results = L.runLabSelfTests({});
  const names = results.map((r) => r.name);
  assert.equal(new Set(names).size, names.length);
  results.forEach((r) => assert.equal(typeof r.detail, 'string'));
});

test('Lab SelfTest 03: checks pass on a non-default state too', () => {
  const results = L.runLabSelfTests({ presetId: 'mobile-app', policyId: 'region-plus-time', regionId: 'asia-southeast1', maxDelayHours: 24, maxSlowdownPct: 50, startHour: 2 });
  results.forEach((r) => assert.equal(r.pass, true, `${r.name}: ${r.detail}`));
});

/* ---------- lab DOM integration ---------- */

test('Lab DOM 01: lab section unhides and fills every region on init', () => {
  const { el } = mountLab();
  assert.equal(el('gr-lab-section').hidden, false);
  assert.equal((el('gr-preset').innerHTML.match(/<option/g) || []).length, 6);
  assert.equal((el('gr-region').innerHTML.match(/<option/g) || []).length, 6);
  assert.equal((el('gr-comparator-body').innerHTML.match(/<tr/g) || []).length, 5);
  assert.equal((el('gr-matrix-body').innerHTML.match(/lab-preset-row/g) || []).length, 6);
  assert.ok(el('gr-curves-chart').innerHTML.includes('<svg'));
  assert.ok(el('gr-pareto-chart').innerHTML.includes('<svg'));
  assert.equal((el('gr-greenest-body').innerHTML.match(/lab-region-row/g) || []).length, 6);
  assert.match(el('gr-digest-line').textContent, /^sha256:[0-9a-f]{64}$/);
});

test('Lab DOM 02: without the lab module the section stays hidden and nothing throws', () => {
  const doc = createFakeDocument();
  doc.els['gr-lab-section'].hidden = true;
  const ctl = App.createController(G, doc).init();
  assert.equal(doc.els['gr-lab-section'].hidden, true);
  assert.equal(ctl.lab, null);
  assert.equal(doc.els['gr-comparator-body'].innerHTML, '');
  doc.els['btn-run'].dispatch('click');
  assert.equal(ctl.result.ok, true);
});

test('Lab DOM 03: policy radios reflect and drive the lab state', () => {
  const { ctl, el } = mountLab();
  assert.equal(el('gr-policy-hands-off-local').checked, true);
  el('gr-policy-region-plus-time').checked = true;
  el('gr-policy-region-plus-time').dispatch('change', { target: { checked: true, value: 'region-plus-time' } });
  assert.equal(ctl.labState.policyId, 'region-plus-time');
  assert.equal(el('gr-policy-region-plus-time').checked, true);
});

test('Lab DOM 04: lab controls write normalized state and readouts', () => {
  const { ctl, el } = mountLab();
  el('gr-delay').dispatch('input', { target: { value: '99' } });
  assert.equal(ctl.labState.maxDelayHours, 24);
  assert.equal(el('gr-delay-out').textContent, '24 h');
  el('gr-slowdown').dispatch('input', { target: { value: '33.7' } });
  assert.equal(ctl.labState.maxSlowdownPct, 34);
  assert.equal(el('gr-slowdown-out').textContent, '34%');
  el('gr-start').dispatch('input', { target: { value: '30' } });
  assert.equal(ctl.labState.startHour, 23);
  assert.equal(el('gr-start-out').textContent, '23:00');
});

test('Lab DOM 05: lab preset and region selects drive the state', () => {
  const { ctl, el } = mountLab();
  el('gr-preset').dispatch('change', { target: { value: 'python-ml' } });
  assert.equal(ctl.labState.presetId, 'python-ml');
  assert.equal(el('gr-comparator-preset').textContent, 'Python ML service');
  el('gr-region').dispatch('change', { target: { value: 'europe-west4' } });
  assert.equal(ctl.labState.regionId, 'europe-west4');
});

test('Lab DOM 06: unknown lab option keys are refused', () => {
  const { ctl } = mountLab();
  assert.equal(ctl.setLabOption('hack', 'x'), false);
  assert.equal(ctl.setLabOption('__proto__', 'x'), false);
  assert.equal(ctl.setLabOption('constructor', 'x'), false);
});

test('Lab DOM 07: comparator row click selects the policy through delegation', () => {
  const { ctl, el } = mountLab();
  const row = { getAttribute: (k) => (k === 'data-policy-id' ? 'time-shift-only' : null), closest() { return this; } };
  el('gr-lab-section').dispatch('click', { target: { closest: (sel) => (sel === 'tr[data-policy-id]' ? row : null), getAttribute: () => null } });
  assert.equal(ctl.labState.policyId, 'time-shift-only');
  assert.ok(el('gr-comparator-body').innerHTML.includes('data-policy-id="time-shift-only"'));
});

test('Lab DOM 08: preset matrix row click selects the preset', () => {
  const { ctl, el } = mountLab();
  const cell = {
    getAttribute: (k) => ({ 'data-gr-pick-policy': 'baseline', 'data-gr-pick-preset': 'docs-site' }[k] || null),
    closest() { return this; }
  };
  el('gr-lab-section').dispatch('click', { target: { closest: (sel) => (sel === '[data-gr-pick-policy]' ? cell : null), getAttribute: () => null } });
  assert.equal(ctl.labState.presetId, 'docs-site');
  assert.equal(ctl.labState.policyId, 'baseline');
});

test('Lab DOM 09: greenest row click selects the region', () => {
  const { ctl, el } = mountLab();
  const row = { getAttribute: (k) => (k === 'data-region-id' ? 'southamerica-east1' : null), closest() { return this; } };
  el('gr-lab-section').dispatch('click', { target: { closest: (sel) => (sel === 'tr[data-region-id]' ? row : null), getAttribute: () => null } });
  assert.equal(ctl.labState.regionId, 'southamerica-east1');
});

test('Lab DOM 10: curves marker click selects the region', () => {
  const { ctl, el } = mountLab();
  const pt = { getAttribute: (k) => (k === 'data-gr-region' ? 'us-west1' : null), closest() { return this; } };
  el('gr-lab-section').dispatch('click', { target: { closest: (sel) => (sel === '[data-gr-region]' ? pt : null), getAttribute: () => null } });
  assert.equal(ctl.labState.regionId, 'us-west1');
});

test('Lab DOM 11: load preset into editor writes the YAML and telemetry', () => {
  const { ctl, el } = mountLab();
  el('gr-preset').dispatch('change', { target: { value: 'java-monorepo' } });
  el('gr-load-preset').dispatch('click');
  assert.equal(ctl.presetId, 'java-monorepo');
  assert.match(el('ci-editor').value, /maven-build:/);
  assert.match(el('telemetry-editor').value, /"dast-scan"/);
});

test('Lab DOM 12: share link carries a strict #gr= hash', () => {
  const { el } = mountLab();
  el('gr-copy-share').dispatch('click');
  assert.match(el('gr-share-url').value, /#gr=v1\|p=node-webapp\|o=hands-off-local\|r=us-central1\|d=14\|s=15\|h=19$/);
});

test('Lab DOM 13: verify digest reports VERIFIED', () => {
  const { el } = mountLab();
  el('gr-verify').dispatch('click');
  assert.match(el('gr-verify-status').textContent, /^VERIFIED [0-9a-f]{20}$/);
});

test('Lab DOM 14: tamper demo reports TAMPER DETECTED', () => {
  const { el } = mountLab();
  el('gr-tamper').dispatch('click');
  assert.match(el('gr-verify-status').textContent, /^TAMPER DETECTED: slowdown 15% rewritten to 50%$/);
});

test('Lab DOM 15: export buttons fill the preview with digest-stamped bodies', () => {
  const { el } = mountLab();
  const stamped = L.getStampedReport(L.normalizeLabState({}));
  el('gr-export-json').dispatch('click');
  assert.ok(el('gr-export-preview').textContent.includes(stamped.digestHex));
  assert.equal(JSON.parse(el('gr-export-preview').textContent).integritySha256, stamped.digestHex);
  el('gr-export-csv').dispatch('click');
  assert.ok(el('gr-export-preview').textContent.includes('# sha256:' + stamped.digestHex));
  el('gr-export-md').dispatch('click');
  assert.ok(el('gr-export-preview').textContent.includes('sha256:' + stamped.digestHex));
  assert.equal(el('gr-export-preview').hidden, false);
});

test('Lab DOM 16: run-tests lists every check green', () => {
  const { el } = mountLab();
  el('gr-run-tests').dispatch('click');
  const m = /^(\d+)\/(\d+) in-page checks passing\.$/.exec(el('gr-selftest-summary').textContent);
  assert.ok(m && m[1] === m[2] && Number(m[1]) >= 16, el('gr-selftest-summary').textContent);
  assert.equal((el('gr-selftest-list').innerHTML.match(/lab-test-fail/g) || []).length, 0);
  assert.ok((el('gr-selftest-list').innerHTML.match(/lab-test-pass/g) || []).length >= 16);
});

test('Lab DOM 17: page digest line equals the stamped report digest', () => {
  const { ctl, el } = mountLab();
  const stamped = L.getStampedReport(ctl.labState);
  assert.equal(el('gr-digest-line').textContent, 'sha256:' + stamped.digestHex);
});

test('Lab DOM 18: digest parity across page, JSON, CSV and Markdown', () => {
  const { ctl, el } = mountLab();
  const stamped = L.getStampedReport(ctl.labState);
  el('gr-export-json').dispatch('click');
  const j = JSON.parse(el('gr-export-preview').textContent);
  el('gr-export-csv').dispatch('click');
  const c = el('gr-export-preview').textContent;
  el('gr-export-md').dispatch('click');
  const m = el('gr-export-preview').textContent;
  const page = el('gr-digest-line').textContent.slice(7);
  [j.integritySha256, stamped.digestHex].forEach((d) => assert.equal(d, page));
  assert.ok(c.includes(page));
  assert.ok(m.includes(page));
});

test('Lab DOM 19: bookmark restores every lab field and loads the preset', () => {
  const { ctl, el } = mountLab();
  const ok = ctl.applyLabBookmark('#gr=v1|p=python-ml|o=region-plus-time|r=europe-north1|d=8|s=25|h=3');
  assert.equal(ok, true);
  assert.equal(ctl.labState.presetId, 'python-ml');
  assert.equal(ctl.labState.policyId, 'region-plus-time');
  assert.equal(ctl.labState.regionId, 'europe-north1');
  assert.equal(ctl.labState.maxDelayHours, 8);
  assert.equal(ctl.labState.maxSlowdownPct, 25);
  assert.equal(ctl.labState.startHour, 3);
  assert.equal(el('gr-preset').value, 'python-ml');
  assert.equal(el('gr-region').value, 'europe-north1');
  assert.equal(el('gr-delay').value, '8');
  assert.equal(el('gr-slowdown').value, '25');
  assert.equal(el('gr-start').value, '3');
  assert.equal(el('gr-policy-region-plus-time').checked, true);
  assert.match(el('ci-editor').value, /prepare-data:/);
  assert.equal(el('gr-preset').innerHTML.includes('Python ML service'), true);
});

test('Lab DOM 20: hostile bookmark keeps the defaults and never throws', () => {
  const { ctl, el } = mountLab();
  const before = JSON.stringify(ctl.labState);
  const ok = ctl.applyLabBookmark('#gr=v1|p=__proto__|o=constructor|r=mars|d=-4|s=zzz|h=99');
  assert.equal(ok, false);
  assert.equal(JSON.stringify(ctl.labState), before);
  assert.equal(el('gr-preset').value, 'node-webapp');
  assert.equal(el('gr-region').value, 'us-central1');
});

test('Lab DOM 21: state changes regenerate the digest line', () => {
  const { ctl, el } = mountLab();
  const first = el('gr-digest-line').textContent;
  ctl.setLabOption('maxSlowdownPct', 40);
  assert.notEqual(el('gr-digest-line').textContent, first);
});

test('Lab DOM 22: the judge buttons still work next to the lab', () => {
  const { ctl, el } = mountLab();
  el('btn-run').dispatch('click');
  assert.equal(ctl.result.ok, true);
  assert.match(el('summary').innerHTML, /Carbon saved/);
  el('btn-apply').dispatch('click');
  assert.match(el('ci-editor').value, /GREEN_WINDOW/);
  assert.equal(el('gr-comparator-body').innerHTML.includes('lab-pill-ok'), true);
});

test('Lab DOM 23: lab state survives an agent run and preset swap', () => {
  const { ctl, el } = mountLab();
  ctl.setLabOption('policyId', 'region-plus-time');
  ctl.setLabOption('regionId', 'europe-north1');
  el('btn-run').dispatch('click');
  el('preset-select').dispatch('change', { target: { value: 'docs-site' } });
  assert.equal(ctl.labState.policyId, 'region-plus-time');
  assert.equal(ctl.labState.regionId, 'europe-north1');
  assert.equal(el('gr-policy-region-plus-time').checked, true);
});

test('Lab DOM 24: delay table shows saved percent per window', () => {
  const { el } = mountLab();
  const html = el('gr-delay-table').innerHTML;
  assert.ok(html.includes('Max delay h'));
  assert.ok((html.match(/<td/g) || []).length === 30);
});

test('Lab DOM 25: hostile lab state cannot inject markup into tables', () => {
  const { el } = mountLab();
  assert.ok(!/<script/i.test(el('gr-comparator-body').innerHTML));
  assert.ok(!/<script/i.test(el('gr-greenest-body').innerHTML));
  assert.ok(!/<script/i.test(el('gr-curves-chart').innerHTML));
});

/* ---------- lab hostile probing ---------- */

test('Lab Hostile 01: every public function survives garbage input', () => {
  const junk = [null, undefined, NaN, Infinity, -0, 'x', {}, [], Symbol ? 'sym' : 0];
  const fns = ['normalizeLabState', 'compareAll', 'sweepDelay', 'greenestLaunch',
    'buildLabReportPayload', 'getStampedReport', 'exportReportJson', 'exportReportCsv', 'exportReportMarkdown',
    'encodeLabHash', 'renderComparatorRowsHtml', 'renderCurvesSvg', 'renderParetoSvg',
    'renderDelaySweepTableHtml', 'renderGreenestRowsHtml', 'runLabSelfTests'];
  fns.forEach((name) => {
    junk.forEach((v) => {
      assert.doesNotThrow(() => L[name](v), `${name}(${String(v)})`);
    });
  });
});

test('Lab Hostile 01b: engineOptionsFor falls back to baseline for bad ids', () => {
  const st = L.normalizeLabState({});
  const opts = L.engineOptionsFor('not-a-policy', st);
  assert.equal(opts.maxDelayHours, 0);
  assert.equal(opts.minGainPct, 101);
  assert.equal(opts.maxSlowdown, 1);
});

test('Lab Hostile 02: codec never pollutes Object.prototype', () => {
  ['#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=4|s=15|h=19&__proto__[x]=1',
    '#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=4|s=15|h=19|__proto__=x'].forEach((h) => {
    L.decodeLabHash(h);
    assert.equal({}.polluted, undefined);
    assert.equal(({}).x, undefined);
  });
});

test('Lab Hostile 03: huge delay and slowdown bounds stay bounded', () => {
  const s = L.normalizeLabState({ maxDelayHours: 1e9, maxSlowdownPct: 1e12, startHour: 1e9 });
  assert.equal(s.maxDelayHours, 24);
  assert.equal(s.maxSlowdownPct, 50);
  assert.equal(s.startHour, 23);
});

test('Lab Hostile 04: stamped report on a hostile state still verifies', () => {
  const s = L.getStampedReport({ presetId: NaN, policyId: {}, regionId: -1, maxDelayHours: Infinity, maxSlowdownPct: -Infinity, startHour: 'x' });
  assert.equal(L.verifyStampedReport(s).ok, true);
  assert.match(s.digestHex, /^[0-9a-f]{64}$/);
});

test('Lab Hostile 05: eval-shaped strings in ids never reach markup', () => {
  const svg = L.renderCurvesSvg({ regionId: 'us-central1"><script>alert(1)</script>' });
  assert.ok(!svg.includes('<script>'));
});

/* ---------- extra coverage ---------- */

[0, 0.5, 1, 7.5, 14, 23.5, 24].forEach((d) => {
  test(`Lab Codec rt delay ${d}h`, () => {
    const decoded = L.decodeLabHash(L.encodeLabHash({ maxDelayHours: d }));
    assert.equal(decoded.maxDelayHours, d);
  });
});

[0, 1, 15, 33, 49, 50].forEach((s) => {
  test(`Lab Codec rt slowdown ${s}%`, () => {
    const decoded = L.decodeLabHash(L.encodeLabHash({ maxSlowdownPct: s }));
    assert.equal(decoded.maxSlowdownPct, s);
  });
});

[0, 1, 5, 12, 19, 23].forEach((h) => {
  test(`Lab Codec rt hour ${h}`, () => {
    const decoded = L.decodeLabHash(L.encodeLabHash({ startHour: h }));
    assert.equal(decoded.startHour, h);
  });
});

PRESET_IDS.forEach((presetId) => {
  test(`Lab Cell ${presetId}: region-plus-time changes at least one job`, () => {
    const c = L.runPolicyCell(presetId, 'region-plus-time', {});
    assert.ok(c.changedJobs >= 1, `${presetId} changed ${c.changedJobs}`);
  });
});

test('Lab Markup 11: selected comparator row gets is-selected class', () => {
  const html = L.renderComparatorRowsHtml({ policyId: 'baseline' });
  const rows = html.split('\n');
  const sel = rows.filter((r) => r.includes('is-selected'));
  assert.equal(sel.length, 1);
  assert.ok(sel[0].includes('data-policy-id="baseline"'));
});

test('Lab Markup 12: selected region draws a thicker curve', () => {
  const svg = L.renderCurvesSvg({ regionId: 'us-west1' });
  const color = L.LAB_REGION_COLORS['us-west1'];
  assert.ok(svg.includes(`stroke="${color}" stroke-width="3.4"`), 'selected curve is bold');
});

test('Lab Markup 13: pareto frontier has its own polyline plus region lines', () => {
  const svg = L.renderParetoSvg({});
  assert.ok(svg.includes('stroke="#e6f5ea"'), 'frontier polyline');
  assert.equal((svg.match(/<polyline/g) || []).length, 7, '6 region lines plus 1 frontier');
});

test('Lab Markup 14: delay sweep table values are all finite numbers', () => {
  const html = L.renderDelaySweepTableHtml({});
  const cells = html.match(/<td class="num">([^<]+)<\/td>/g) || [];
  assert.equal(cells.length, 30);
  cells.forEach((c) => {
    const n = Number(c.replace(/<\/?td[^>]*>/g, ''));
    assert.ok(Number.isFinite(n), c);
  });
});

test('Lab Green 05: saving percent is never negative', () => {
  L.greenestLaunch('node-webapp', {}).forEach((g) => assert.ok(g.savingPct >= 0, g.regionId));
});

test('Lab Export 13: JSON export ends with a newline', () => {
  assert.ok(L.exportReportJson({}).endsWith('\n'));
});

test('Lab Export 14: CSV export ends with a newline', () => {
  assert.ok(L.exportReportCsv({}).endsWith('\n'));
});

test('Lab Export 15: Markdown names the selected preset', () => {
  const md = L.exportReportMarkdown({ presetId: 'java-monorepo' });
  assert.ok(md.includes('Java monorepo') || md.includes('java-monorepo'), 'preset identified in brief');
});

test('Lab Export 16: every preset contributes exactly 5 CSV rows', () => {
  const rows = L.exportReportCsv({}).trim().split('\n').slice(5);
  PRESET_IDS.forEach((pid) => {
    assert.equal(rows.filter((r) => r.startsWith(pid + ',')).length, 5, pid);
  });
});

test('Lab Digest 11: canonical digest excludes the integritySha256 field itself', () => {
  const stamped = L.getStampedReport({});
  const withField = Object.assign({}, stamped.payload, { integritySha256: 'f'.repeat(64) });
  const v = L.verifyStampedReport({ payload: withField, digestHex: stamped.digestHex });
  assert.equal(v.ok, true, 'the field carrying the digest is exempt from the digest');
});

test('Lab Digest 12: stamped reports for different regions differ', () => {
  const a = L.getStampedReport({ regionId: 'us-central1' });
  const b = L.getStampedReport({ regionId: 'asia-southeast1' });
  assert.notEqual(a.digestHex, b.digestHex);
});

test('Lab DOM 26: share URL rewrites on every state change', () => {
  const { ctl, el } = mountLab();
  const first = el('gr-share-url').value;
  ctl.setLabOption('policyId', 'baseline');
  const second = el('gr-share-url').value;
  assert.notEqual(second, first);
  assert.ok(second.includes('o=baseline'));
});

test('Lab DOM 27: lab survives a hostile YAML pasted into the editor', () => {
  const { ctl, el } = mountLab();
  ctl.setYaml('a: &anchor 1\nb: *anchor\n');
  assert.ok(ctl.parseError !== null, 'anchor/alias YAML reports a parse error');
  assert.equal((el('gr-comparator-body').innerHTML.match(/<tr/g) || []).length, 5);
});

/* ---------- engine hardening ---------- */

test('Lab Guard 01: UMD modules load under a lexical self binding', () => {
  const src = fs.readFileSync(path.join(root, 'engine.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const lab = fs.readFileSync(path.join(root, 'carbon-lab.js'), 'utf8');
  [src, app, lab].forEach((t) => assert.ok(t.includes('globalThis'), 'UMD resolves globalThis first'));
});

test('Lab Guard 02: runGreenAgent tolerates hostile numbers and fails closed on bad ids', () => {
  const p = G.getPreset('node-webapp');
  [{ maxDelayHours: NaN }, { maxSlowdown: NaN }, { startHour: 99 }].forEach((o) => {
    const r = G.runGreenAgent(p.yaml, p.telemetry, o);
    assert.ok(r !== null && typeof r === 'object', JSON.stringify(o));
  });
  assert.throws(() => G.runGreenAgent(p.yaml, p.telemetry, { region: 'mars' }), /unknown region/i);
});

test('Lab A11y regression: interactive SVG charts use group semantics around focusable buttons', () => {
  for (const svg of [L.renderCurvesSvg({}), L.renderParetoSvg({})]) {
    assert.equal(svg.includes('role="img"'), false);
    assert.ok(svg.includes('role="group"'));
    assert.ok(svg.includes('role="button"'));
  }
});
