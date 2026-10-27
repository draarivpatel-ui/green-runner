'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const G = require('../engine.js');
const cli = require('../cli.js');

const root = path.resolve(__dirname, '..');
const preset = (id) => G.getPreset(id);
const run = (id, opts, tel) => G.runGreenAgent(preset(id).yaml, tel || preset(id).telemetry, opts);

/* ---------- YAML reader and writer ---------- */

test('Engine 01: a block map with plain scalars parses', () => {
  assert.deepEqual(G.parseYaml('a: 1\nb: hello world\nc:\n  d: x\n'), { a: 1, b: 'hello world', c: { d: 'x' } });
});

test('Engine 02: numbers, booleans and null are typed, version-like strings stay strings', () => {
  assert.deepEqual(G.parseYaml('n: 3\nf: 2.5\nt: true\nx: false\nz: null\nv: 1.10\n'), { n: 3, f: 2.5, t: true, x: false, z: null, v: '1.10' });
});

test('Engine 03: quoted strings keep their content and escapes', () => {
  assert.deepEqual(G.parseYaml('a: "x: y # not a comment"\nb: \'it\'\'s\'\nc: "line\\nbreak"\n'), { a: 'x: y # not a comment', b: "it's", c: 'line\nbreak' });
});

test('Engine 04: inline lists and maps parse', () => {
  assert.deepEqual(G.parseYaml('tags: [a, "b c", 3]\nvars: {X: 1, Y: two}\n'), { tags: ['a', 'b c', 3], vars: { X: 1, Y: 'two' } });
});

test('Engine 05: block lists work both indented and at the key indent', () => {
  assert.deepEqual(G.parseYaml('a:\n  - 1\n  - 2\nb:\n- x\n- y\n'), { a: [1, 2], b: ['x', 'y'] });
});

test('Engine 06: lists of maps parse, including the rules shape', () => {
  const y = 'rules:\n  - if: $CI_PIPELINE_SOURCE == "schedule"\n    when: always\n  - when: never\n';
  assert.deepEqual(G.parseYaml(y), { rules: [{ if: '$CI_PIPELINE_SOURCE == "schedule"', when: 'always' }, { when: 'never' }] });
});

test('Engine 07: a script line with a colon inside stays a plain string', () => {
  const d = G.parseYaml('script:\n  - echo "a: b"\n  - curl http://x.test/a\n');
  assert.deepEqual(d.script, ['echo "a: b"', 'curl http://x.test/a']);
});

test('Engine 08: comments are stripped outside quotes only', () => {
  assert.deepEqual(G.parseYaml('# top\na: 1 # trailing\nb: "x # y"\n'), { a: 1, b: 'x # y' });
});

test('Engine 09: literal block scalars keep their lines', () => {
  assert.deepEqual(G.parseYaml('s: |\n  one\n  two\nk: v\n'), { s: 'one\ntwo', k: 'v' });
});

test('Engine 10: tabs, anchors, aliases and merge keys are rejected with a clear error', () => {
  assert.throws(() => G.parseYaml('a:\n\tb: 1\n'), /tabs/);
  assert.throws(() => G.parseYaml('a: &x 1\n'), /unsupported/);
  assert.throws(() => G.parseYaml('a: *x\n'), /unsupported/);
  assert.throws(() => G.parseYaml('<<: base\n'), /expected|unsupported/);
});

test('Engine 11: malformed structure raises errors that name the line', () => {
  assert.throws(() => G.parseYaml('a: 1\n  b: 2\n'), /line 2|indent/);
  assert.throws(() => G.parseYaml('just a line\n'), /line 1/);
});

test('Engine 12: parseGitlabCI requires a top-level mapping', () => {
  assert.throws(() => G.parseGitlabCI('- a\n- b\n'), /mapping/);
  assert.deepEqual(G.parseGitlabCI(''), {});
});

test('Engine 13: dumpYaml quotes only what needs quoting', () => {
  const out = G.dumpYaml({ a: 'plain text', b: '12', c: 'x: y', d: 'true', e: '', f: 5, g: false, h: '$CI_X == "y"' });
  assert.match(out, /^a: plain text$/m);
  assert.match(out, /^b: "12"$/m);
  assert.match(out, /^c: "x: y"$/m);
  assert.match(out, /^d: "true"$/m);
  assert.match(out, /^e: ""$/m);
  assert.match(out, /^f: 5$/m);
  assert.match(out, /^h: \$CI_X == "y"$/m);
});

test('Engine 14: dumpYaml writes lists of maps with the dash on the first key', () => {
  const out = G.dumpYaml({ rules: [{ if: '$A == "b"', when: 'always' }, { when: 'never' }] });
  assert.equal(out, 'rules:\n  - if: $A == "b"\n    when: always\n  - when: never\n');
});

test('Engine 15: empty collections round trip', () => {
  const d = { a: [], b: {}, c: { d: [] } };
  assert.deepEqual(G.parseYaml(G.dumpYaml(d)), d);
});

test('Engine 16: every preset survives parse, dump, parse unchanged', () => {
  G.PRESETS.forEach((p) => {
    const d = G.parseGitlabCI(p.yaml);
    assert.deepEqual(G.parseGitlabCI(G.dumpYaml(d)), d, p.id);
  });
});

test('Engine 17: the repository root .gitlab-ci.yml parses and round trips', () => {
  const text = fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8');
  const d = G.parseGitlabCI(text);
  assert.deepEqual(G.jobsOf(d), ['test', 'green-agent']);
  assert.deepEqual(G.parseGitlabCI(G.dumpYaml(d)), d);
  assert.equal(d['green-agent'].rules[0].if, '$CI_PIPELINE_SOURCE == "merge_request_event"');
});

/* ---------- pipeline model ---------- */

test('Engine 18: jobsOf skips reserved keys and hidden jobs', () => {
  const d = G.parseGitlabCI('stages: [a]\nvariables:\n  X: 1\n.hidden:\n  script: [x]\nreal:\n  script: [x]\ndefault:\n  image: y\n');
  assert.deepEqual(G.jobsOf(d), ['real']);
});

test('Engine 19: stageOrder falls back to the GitLab defaults', () => {
  assert.deepEqual(G.stageOrder({}), ['.pre', 'build', 'test', 'deploy', '.post']);
  assert.deepEqual(G.stageOrder({ stages: ['x', 'y'] }), ['x', 'y']);
});

test('Engine 20: runner tags map to the documented machine sizes', () => {
  assert.deepEqual([G.RUNNERS['saas-linux-small-amd64'].vcpu, G.RUNNERS['saas-linux-small-amd64'].memGb], [2, 8]);
  assert.deepEqual([G.RUNNERS['saas-linux-medium-amd64'].vcpu, G.RUNNERS['saas-linux-medium-amd64'].memGb], [4, 16]);
  assert.deepEqual([G.RUNNERS['saas-linux-large-amd64'].vcpu, G.RUNNERS['saas-linux-large-amd64'].memGb], [8, 32]);
  assert.deepEqual([G.RUNNERS['saas-linux-xlarge-amd64'].vcpu, G.RUNNERS['saas-linux-xlarge-amd64'].memGb], [16, 64]);
  assert.deepEqual([G.RUNNERS['saas-linux-2xlarge-amd64'].vcpu, G.RUNNERS['saas-linux-2xlarge-amd64'].memGb], [32, 128]);
  assert.deepEqual(G.RUNNER_ORDER[0], 'saas-linux-small-amd64');
});

test('Engine 21: runnerTagOf defaults to small, skips unknown tags and understands green tags', () => {
  assert.equal(G.runnerTagOf({}), 'saas-linux-small-amd64');
  assert.equal(G.runnerTagOf({ tags: ['docker', 'saas-linux-large-amd64'] }), 'saas-linux-large-amd64');
  assert.equal(G.runnerTagOf({ tags: ['green-europe-north1-xlarge'] }), 'saas-linux-xlarge-amd64');
});

test('Engine 22: classify marks scans, fuzzing, benchmarks and nightly pages as deferrable', () => {
  const d = G.parseGitlabCI(preset('go-service').yaml);
  const c = G.classify(d);
  assert.equal(c['bench-http'].deferrable, true);
  assert.equal(c['pages-nightly'].deferrable, true);
  assert.equal(c['go-build'].deferrable, false);
  const n = G.classify(G.parseGitlabCI(preset('node-webapp').yaml));
  assert.equal(n['fuzz-api'].deferrable, true);
  assert.equal(n.container_scanning.deferrable, true);
  assert.equal(n['deploy-staging'].deferrable, false);
});

test('Engine 23: deploy and release jobs are never deferrable even if named like a scan', () => {
  const d = G.parseGitlabCI('stages: [release]\ndast-release:\n  stage: release\n  script: [x]\n');
  assert.equal(G.classify(d)['dast-release'].deferrable, false);
});

test('Engine 24: a job needed by a critical job is pinned with the reason', () => {
  const c = G.classify(G.parseGitlabCI(preset('java-monorepo').yaml));
  assert.equal(c['dast-scan'].deferrable, false);
  assert.match(c['dast-scan'].reason, /required by release/);
});

test('Engine 25: six regions with 24 positive hourly values and deterministic curves', () => {
  assert.equal(G.REGIONS.length, 6);
  G.REGIONS.forEach((r) => {
    const c = G.regionCurve(r.id);
    assert.equal(c.length, 24);
    assert.ok(c.every((v) => v > 20 && v < 700), r.id);
    assert.deepEqual(c, G.regionCurve(r.id));
  });
  assert.equal(G.regionCurve('nowhere'), null);
});

test('Engine 26: intensityAt interpolates between hours and wraps past 24', () => {
  const c = G.regionCurve('us-west1');
  assert.equal(G.intensityAt('us-west1', 3), c[3]);
  assert.ok(Math.abs(G.intensityAt('us-west1', 3.5) - (c[3] + c[4]) / 2) < 1e-9);
  assert.equal(G.intensityAt('us-west1', 27), c[3]);
  assert.equal(G.intensityAt('us-west1', -21), c[3]);
  assert.throws(() => G.intensityAt('nowhere', 1));
});

test('Engine 27: average intensity over a window lies between the curve extremes', () => {
  G.REGIONS.forEach((r) => {
    const c = G.regionCurve(r.id);
    const a = G.avgIntensity(r.id, 22, 180);
    assert.ok(a >= Math.min(...c) - 1e-9 && a <= Math.max(...c) + 1e-9);
  });
});

test('Engine 28: job energy follows the stated formula for a known case', () => {
  const tag = 'saas-linux-small-amd64';
  const r = G.RUNNERS[tag];
  const tel = { durationMin: 60, peakRssMb: 4096, avgCpuPct: 50, peakCpuPct: 80 };
  const watts = r.idleW + (r.tdpW - r.idleW) * 0.5 + G.MODEL.memWattsPerGb * r.memGb * 0.5;
  assert.ok(Math.abs(G.jobEnergyWh(tag, tel) - watts * G.MODEL.pue) < 1e-9);
});

test('Engine 29: energy rises with CPU use, duration and runner size', () => {
  const t = { durationMin: 10, peakRssMb: 1000, avgCpuPct: 30, peakCpuPct: 50 };
  const small = G.jobEnergyWh('saas-linux-small-amd64', t);
  assert.ok(G.jobEnergyWh('saas-linux-small-amd64', Object.assign({}, t, { avgCpuPct: 60 })) > small);
  assert.ok(G.jobEnergyWh('saas-linux-small-amd64', Object.assign({}, t, { durationMin: 20 })) > small);
  assert.ok(G.jobEnergyWh('saas-linux-large-amd64', t) > small);
});

test('Engine 30: normalizeTelemetry flags missing jobs as estimates and clamps percentages', () => {
  const d = G.parseGitlabCI('a:\n  script: [x]\nb:\n  script: [x]\n');
  const t = G.normalizeTelemetry(d, { a: { durationMin: 4, peakRssMb: 100, avgCpuPct: 150, peakCpuPct: 200 } });
  assert.equal(t.a.estimated, false);
  assert.equal(t.a.avgCpuPct, 100);
  assert.equal(t.b.estimated, true);
});

test('Engine 31: simulation totals add up and the critical path is the sum of stage maxima', () => {
  const p = preset('node-webapp');
  const d = G.parseGitlabCI(p.yaml);
  const sim = G.simulatePipeline(d, G.normalizeTelemetry(d, p.telemetry), { region: 'us-central1', startHour: 19 });
  assert.ok(Math.abs(sim.rows.reduce((a, r) => a + r.wh, 0) - sim.totalWh) < 0.01);
  assert.equal(sim.criticalPathMin, 6 + 7 + 8 + 30 + 2);
  assert.ok(sim.totalGco2 > 0);
});

test('Engine 32: a deferred job leaves the critical path but still counts toward totals', () => {
  const p = preset('node-webapp');
  const d = G.parseGitlabCI(p.yaml);
  const tel = G.normalizeTelemetry(d, p.telemetry);
  const base = G.simulatePipeline(d, tel, { region: 'us-central1', startHour: 19 });
  const moved = G.simulatePipeline(d, tel, { region: 'us-central1', startHour: 19, deferred: { 'fuzz-api': { region: 'us-central1', startHour: 19 } } });
  assert.equal(base.criticalPathMin - moved.criticalPathMin, 30);
  assert.ok(Math.abs(base.totalWh - moved.totalWh) < 0.01);
  assert.equal(moved.rows.filter((r) => r.deferred).length, 1);
});

test('Engine 33: rightsize shrinks an over-provisioned job to the smallest tag that fits', () => {
  const r = G.rightsize('saas-linux-large-amd64', { durationMin: 7, peakRssMb: 3200, avgCpuPct: 22, peakCpuPct: 41, estimated: false });
  assert.equal(r.change, true);
  assert.equal(r.to, 'saas-linux-medium-amd64');
  assert.ok(r.needCores <= 4);
});

test('Engine 34: rightsize keeps headroom for memory and CPU peaks', () => {
  const mem = G.rightsize('saas-linux-xlarge-amd64', { durationMin: 5, peakRssMb: 20000, avgCpuPct: 5, peakCpuPct: 10, estimated: false });
  assert.equal(mem.to, 'saas-linux-large-amd64');
  const cpu = G.rightsize('saas-linux-xlarge-amd64', { durationMin: 5, peakRssMb: 500, avgCpuPct: 70, peakCpuPct: 95, estimated: false });
  assert.equal(cpu.change, false);
});

test('Engine 35: rightsize never acts without telemetry or below the smallest tag', () => {
  assert.equal(G.rightsize('saas-linux-large-amd64', { durationMin: 5, peakRssMb: 1, avgCpuPct: 1, peakCpuPct: 1, estimated: true }).change, false);
  assert.equal(G.rightsize('saas-linux-small-amd64', { durationMin: 5, peakRssMb: 100, avgCpuPct: 5, peakCpuPct: 5, estimated: false }).change, false);
});

test('Engine 36: rightsize respects the slowdown limit', () => {
  const tel = { durationMin: 10, peakRssMb: 500, avgCpuPct: 3, peakCpuPct: 6, estimated: false };
  assert.equal(G.rightsize('saas-linux-2xlarge-amd64', tel, { maxSlowdown: 1.05 }).change, false);
  assert.equal(G.rightsize('saas-linux-2xlarge-amd64', tel, { maxSlowdown: 1.5 }).change, true);
});

test('Engine 37: findGreenWindow never does worse than the baseline and counts candidates', () => {
  const w = G.findGreenWindow({ wh: 100, durationMin: 30, baseRegion: 'us-central1', baseStart: 19, maxDelayHours: 10, regions: ['us-central1'] });
  assert.ok(w.g <= w.baseG + 1e-9);
  assert.ok(w.gainPct >= 0);
  assert.equal(w.evaluated, 21);
  const none = G.findGreenWindow({ wh: 100, durationMin: 30, baseRegion: 'us-central1', baseStart: 19, maxDelayHours: 0, regions: ['us-central1'] });
  assert.equal(none.gainPct, 0);
  assert.equal(none.delayHours, 0);
});

test('Engine 38: allowing every region finds a window at least as good as staying put', () => {
  const only = G.findGreenWindow({ wh: 100, durationMin: 30, baseRegion: 'us-central1', baseStart: 19, maxDelayHours: 14, regions: ['us-central1'] });
  const all = G.findGreenWindow({ wh: 100, durationMin: 30, baseRegion: 'us-central1', baseStart: 19, maxDelayHours: 14, regions: G.REGIONS.map((r) => r.id) });
  assert.ok(all.g <= only.g + 1e-9);
});

test('Engine 39: windowId and cronFor format hours and wrap past midnight', () => {
  assert.equal(G.windowId('europe-north1', 3), 'europe-north1-03');
  assert.equal(G.windowId('us-west1', 27.5), 'us-west1-03');
  assert.equal(G.cronFor(3), '0 3 * * *');
  assert.equal(G.cronFor(27.5), '30 3 * * *');
});

test('Engine 40: sideBySide marks equal, changed, added and removed lines', () => {
  assert.ok(G.sideBySide('a\nb\n', 'a\nb\n').every((r) => r.type === 'same'));
  const rows = G.sideBySide('a\nb\nc\n', 'a\nB\nc\nd\n');
  assert.deepEqual(rows.map((r) => r.type), ['same', 'change', 'same', 'add']);
  assert.equal(G.sideBySide('a\nb\n', 'a\n').filter((r) => r.type === 'remove').length, 1);
});

test('Engine 41: unifiedDiff lists removals and additions with a header', () => {
  const d = G.unifiedDiff('a\nb\n', 'a\nc\n');
  assert.match(d, /^--- a\/\.gitlab-ci\.yml\n\+\+\+ b\/\.gitlab-ci\.yml\n/);
  assert.match(d, /\n-b\n\+c\n/);
});

/* ---------- the hands-off agent ---------- */

test('Engine 42: bad YAML returns a clean error instead of throwing', () => {
  const r = G.runGreenAgent('a:\n\tb: 1\n', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /tabs/);
  assert.equal(r.trace.length, 1);
});

test('Engine 43: every preset runs and never increases carbon or energy', () => {
  G.PRESETS.forEach((p) => {
    const r = run(p.id);
    assert.equal(r.ok, true, p.id);
    assert.ok(r.after.totalGco2 <= r.baseline.totalGco2 + 1e-9, p.id);
    assert.ok(r.after.totalWh <= r.baseline.totalWh + 1e-9, p.id);
  });
});

test('Engine 44: deploy and release jobs are byte-identical after patching', () => {
  G.PRESETS.forEach((p) => {
    const r = run(p.id, { allowRegionShift: true });
    G.jobsOf(r.doc).filter((j) => /deploy|release/.test(j)).forEach((j) => assert.deepEqual(r.patched[j], r.doc[j], p.id + ' ' + j));
  });
});

test('Engine 45: the job that a release needs is never moved', () => {
  const r = run('java-monorepo', { allowRegionShift: true });
  assert.deepEqual(r.patched['dast-scan'].rules, undefined);
  assert.equal(r.deferred['dast-scan'], undefined);
  assert.ok(r.changes.some((c) => c.job === 'dast-scan' && c.type === 'skipped'));
});

test('Engine 46: region shift saves at least as much carbon as time shift alone, with identical energy', () => {
  G.PRESETS.forEach((p) => {
    const t = run(p.id, { allowRegionShift: false });
    const g = run(p.id, { allowRegionShift: true });
    assert.ok(g.after.totalGco2 <= t.after.totalGco2 + 1e-9, p.id);
    assert.equal(g.after.totalWh, t.after.totalWh, p.id);
  });
});

test('Engine 47: shifted jobs get a schedule rule whose window has a matching schedule', () => {
  const r = run('node-webapp', {});
  const shifted = r.changes.filter((c) => c.type === 'shift-time');
  assert.ok(shifted.length >= 1);
  shifted.forEach((c) => {
    assert.equal(r.patched[c.job].rules.length, 1);
    assert.ok(r.patched[c.job].rules[0].if.includes('$GREEN_WINDOW == "' + c.window + '"'));
    assert.ok(r.schedules.some((s) => s.id === c.window && s.variables.GREEN_WINDOW === c.window));
  });
});

test('Engine 48: region moves rewrite the tag to a green runner tag of the same size', () => {
  const r = run('node-webapp', { allowRegionShift: true });
  const moved = r.changes.filter((c) => c.type === 'shift-region');
  assert.ok(moved.length >= 1);
  moved.forEach((c) => assert.match(r.patched[c.job].tags[0], /^green-[a-z0-9-]+-(small|medium|large|xlarge|2xlarge)$/));
});

test('Engine 49: right-sized tags are real runner tags and untouched jobs keep their tags', () => {
  const r = run('node-webapp', {});
  G.jobsOf(r.doc).forEach((j) => {
    const changed = r.changes.some((c) => c.job === j && c.type === 'rightsize');
    if (changed) assert.ok(G.RUNNERS[r.patched[j].tags[0]], j);
    else assert.deepEqual(r.patched[j].tags, r.doc[j].tags, j);
  });
});

test('Engine 50: the patched YAML is valid and parses back to the patched object', () => {
  G.PRESETS.forEach((p) => {
    const r = run(p.id, { allowRegionShift: true });
    assert.deepEqual(G.parseGitlabCI(r.patchedYaml), r.patched, p.id);
  });
});

test('Engine 51: the agent is deterministic', () => {
  assert.deepEqual(run('python-ml', {}), run('python-ml', {}));
});

test('Engine 52: critical path grows by at most the slowdown limit when only time shifting', () => {
  G.PRESETS.forEach((p) => {
    const r = run(p.id, {});
    assert.ok(r.after.criticalPathMin <= r.baseline.criticalPathMin * 1.05, p.id);
  });
});

test('Engine 53: moving fuzz and scans off the pipeline shortens the critical path', () => {
  const r = run('node-webapp', {});
  assert.ok(r.savings.criticalPathAfterMin < r.savings.criticalPathBeforeMin);
});

test('Engine 54: the trace follows the documented tool order', () => {
  const r = run('docs-site', {});
  const tools = r.trace.map((t) => t.tool);
  assert.deepEqual(tools.slice(0, 3), ['parse_ci', 'classify_lifecycle', 'simulate_pipeline']);
  assert.equal(tools[tools.length - 1], 'write_mr_report');
  assert.ok(tools.includes('rightsize_runner') && tools.includes('find_green_window') && tools.includes('generate_patch'));
  r.trace.forEach((t, i) => assert.equal(t.seq, i + 1));
});

test('Engine 55: the report has the savings table, changes and the honesty lines', () => {
  const r = run('node-webapp', {});
  assert.match(r.report, /\| Carbon \(gCO2eq\) \| [\d.]+ \| [\d.]+ \| -[\d.]+% \|/);
  assert.match(r.report, /### Changes/);
  assert.match(r.report, /### Pipeline schedules to create/);
  assert.match(r.report, /estimates, not measurements/);
  assert.match(r.report, /no longer gate/);
});

test('Engine 56: applying the patch and its effective telemetry makes a second run a no-op', () => {
  const first = run('node-webapp', { allowRegionShift: true });
  const second = G.runGreenAgent(first.patchedYaml, first.effectiveTelemetry, { allowRegionShift: true });
  assert.equal(second.patchedYaml, first.patchedYaml);
  assert.equal(second.changes.filter((c) => c.type === 'rightsize').length, 0);
});

test('Engine 57: a high minimum gain keeps every job where it is', () => {
  const r = run('node-webapp', { minGainPct: 99 });
  assert.equal(Object.keys(r.deferred).length, 0);
  assert.ok(r.changes.some((c) => c.type === 'kept'));
});

test('Engine 58: zero allowed delay and one region means nothing can shift', () => {
  const r = run('node-webapp', { maxDelayHours: 0 });
  assert.equal(Object.keys(r.deferred).length, 0);
});

test('Engine 59: jobs without telemetry are never resized and are reported', () => {
  const tel = Object.assign({}, preset('node-webapp').telemetry);
  delete tel['unit-test'];
  const r = run('node-webapp', {}, tel);
  assert.deepEqual(r.estimatedJobs, ['unit-test']);
  assert.ok(!r.changes.some((c) => c.job === 'unit-test' && c.type === 'rightsize'));
  assert.match(r.report, /No telemetry for: unit-test/);
});

test('Engine 60: compare computes percentage savings from totals', () => {
  const s = G.compare({ totalWh: 100, totalGco2: 50, criticalPathMin: 10 }, { totalWh: 75, totalGco2: 20, criticalPathMin: 12 });
  assert.deepEqual(s, { savedWh: 25, savedGco2: 30, whPct: 25, gco2Pct: 60, criticalPathBeforeMin: 10, criticalPathAfterMin: 12 });
});

test('Engine 61: the repository own pipeline needs no changes', () => {
  const text = fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8');
  const r = G.runGreenAgent(text, {}, {});
  assert.equal(r.ok, true);
  assert.equal(r.changes.filter((c) => /^(rightsize|shift)/.test(c.type)).length, 0);
});

/* ---------- command line ---------- */

function capture() {
  const out = { lines: [], errs: [] };
  out.log = (s) => out.lines.push(s);
  out.err = (s) => out.errs.push(s);
  return out;
}
const example = path.join(root, 'examples', 'node-webapp.gitlab-ci.yml');
const exampleTel = path.join(root, 'examples', 'node-webapp.telemetry.json');

test('Engine 62: the CLI prints usage for --help and fails with no file', () => {
  const a = capture();
  assert.equal(cli.main(['--help'], a), 0);
  assert.match(a.lines[0], /Usage: node cli\.js/);
  assert.equal(cli.main([], capture()), 2);
});

test('Engine 63: the CLI reports unreadable files and bad options', () => {
  const a = capture();
  assert.equal(cli.main(['/no/such/file.yml'], a), 2);
  assert.match(a.errs[0], /cannot read/);
  assert.equal(cli.main([example, '--region', 'mars-1'], capture()), 2);
  assert.equal(cli.main([example, 'extra'], capture()), 2);
});

test('Engine 64: the CLI prints the merge request report for the example pipeline', () => {
  const a = capture();
  assert.equal(cli.main([example, '--telemetry', exampleTel], a), 0);
  assert.match(a.lines[0], /GreenRunner: carbon-aware pipeline plan/);
});

test('Engine 65: the CLI can write the patched YAML and the report to files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'green-runner-'));
  try {
    const yml = path.join(dir, 'patched.yml'), md = path.join(dir, 'report.md');
    assert.equal(cli.main([example, '--telemetry', exampleTel, '--region-shift', '--write', yml, '--report', md], capture()), 0);
    assert.deepEqual(G.parseGitlabCI(fs.readFileSync(yml, 'utf8'))['unit-test'].tags, ['saas-linux-medium-amd64']);
    assert.match(fs.readFileSync(md, 'utf8'), /Pipeline schedules to create/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Engine 66: the CLI json mode prints parseable output with the savings', () => {
  const a = capture();
  assert.equal(cli.main([example, '--telemetry', exampleTel, '--json'], a), 0);
  const j = JSON.parse(a.lines.join('\n'));
  assert.ok(j.savings.gco2Pct > 0);
  assert.ok(Array.isArray(j.trace));
});

test('Engine 67: the CLI fails cleanly on broken YAML and broken telemetry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'green-runner-'));
  try {
    const bad = path.join(dir, 'bad.yml'); fs.writeFileSync(bad, 'a:\n\tb: 1\n');
    const badTel = path.join(dir, 'bad.json'); fs.writeFileSync(badTel, '{nope');
    assert.equal(cli.main([bad], capture()), 1);
    assert.equal(cli.main([example, '--telemetry', badTel], capture()), 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
