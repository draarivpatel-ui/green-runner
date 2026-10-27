'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const G = require('../engine.js');
const App = require('../app.js');
const { createFakeDocument } = require('./helpers/fake-dom.js');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

function mount() {
  const doc = createFakeDocument();
  const ctl = App.createController(G, doc).init();
  return { doc, ctl, el: (id) => doc.els[id] };
}

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
    if (d.name === '.git' || d.name === 'node_modules') return;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out); else out.push(p);
  });
  return out;
}

/* ---------- static markup ---------- */

test('DOM 01: doctype, lang, charset and viewport are present', () => {
  assert.match(html.trimStart(), /^<!DOCTYPE html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta charset="utf-8">/i);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
});

test('DOM 02: title, description and social tags are descriptive', () => {
  assert.match(html, /<title>GreenRunner[^<]{20,}<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]{80,}">/);
  assert.match(html, /property="og:url" content="https:\/\/aariv\.me\/green-runner\/"/);
  assert.match(html, /name="twitter:card"/);
});

test('DOM 03: exactly one h1 and no skipped heading levels', () => {
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
  for (let i = 1; i < levels.length; i += 1) assert.ok(levels[i] <= levels[i - 1] + 1);
});

test('DOM 04: the three judge shortcuts exist with their labels', () => {
  assert.match(html, /id="btn-run"[^>]*>Run Hands-Off Duo Agent</);
  assert.match(html, /id="btn-run-region"[^>]*>Run With Region Shift</);
  assert.match(html, /id="btn-apply"[^>]*>Apply Patch To Editor</);
});

test('DOM 05: the page is zero-dependency with only local scripts and styles', () => {
  const srcs = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ['engine.js', 'app.js']);
  assert.ok(!/<link[^>]+href="https?:/.test(html));
  assert.ok(!/@import|url\(http/.test(css));
});

test('DOM 06: every input has a label and the canvas has a text alternative', () => {
  ['preset-select', 'ci-editor', 'telemetry-editor', 'opt-region', 'opt-hour', 'opt-delay', 'opt-region-shift'].forEach((id) => {
    assert.match(html, new RegExp('<label[^>]*for="' + id + '"'), id);
  });
  assert.match(html, /<canvas id="carbon-canvas"[^>]*role="img"[^>]*aria-label="[^"]+"/);
});

test('DOM 07: live regions announce parse status, summary and trace', () => {
  ['parse-status', 'summary', 'trace-log'].forEach((id) => assert.match(html, new RegExp('id="' + id + '"[^>]*aria-live="polite"'), id));
});

test('DOM 08: the diff and job tables are labelled', () => {
  assert.match(html, /id="diff-view"[^>]*aria-label="Side by side YAML patch"/);
  assert.match(html, /id="job-table"[^>]*aria-label="Per job energy and carbon"/);
});

test('DOM 09: stylesheet honours reduced motion and focus, with 44px targets', () => {
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /\.btn\s*\{[^}]*min-height: 44px/);
});

/* ---------- repository hygiene ---------- */

const textFiles = () => walk(root, []).filter((f) => !/\.(png|jpg|jpeg|gif|ico|woff2?)$/i.test(f));

test('DOM 10: no em dashes or en dashes anywhere, including docs and CI files', () => {
  const re = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
  const files = textFiles();
  assert.ok(files.some((f) => f.endsWith('agents.md')));
  assert.ok(files.some((f) => f.endsWith('.gitlab-ci.yml')));
  files.forEach((f) => assert.ok(!re.test(fs.readFileSync(f, 'utf8')), path.relative(root, f)));
});

test('DOM 11: no emoji or pictographs anywhere', () => {
  textFiles().forEach((f) => assert.ok(!/\p{Extended_Pictographic}/u.test(fs.readFileSync(f, 'utf8')), path.relative(root, f)));
});

test('DOM 12: no personal contact details, school names or city locators', () => {
  const banned = [['draarivpatel', '@gm', 'ail'], ['pro', 'roblox'], ['Dul', 'les'], ['Fort Set', 'tlement'], ['Sugar', ' Land'], ['Tany', 'ard'], ['@ya', 'hoo\\.']]
    .map((parts) => new RegExp(parts.join(''), 'i'));
  textFiles().forEach((f) => {
    const t = fs.readFileSync(f, 'utf8');
    banned.forEach((re) => assert.ok(!re.test(t), re + ' in ' + path.relative(root, f)));
  });
});

test('DOM 13: no uppercase kicker styling and no vendor-shaped credentials', () => {
  assert.ok(!/text-transform:\s*uppercase/i.test(css));
  textFiles().forEach((f) => {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!/\b(glpat-|sk-|ghp_|github_pat_|AKIA|xox[bp]-)[A-Za-z0-9]/.test(t), path.relative(root, f));
  });
});

test('DOM 14: required deliverables exist', () => {
  ['LICENSE', 'README.md', 'NOTES.md', '.nojekyll', '.gitlab-ci.yml', 'docs/agents.md', '.gitlab/duo/agent-config.yml', 'cli.js'].forEach((f) => assert.ok(fs.existsSync(path.join(root, f)), f));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test');
  assert.deepEqual(pkg.dependencies || {}, {});
});

test('DOM 15: README and agent docs state what was and was not run', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const agents = fs.readFileSync(path.join(root, 'docs/agents.md'), 'utf8');
  assert.match(readme, /AI disclosure/i);
  assert.match(readme, /not been executed on the GitLab Duo Agent Platform/i);
  assert.match(readme, /synthetic/i);
  assert.match(agents, /Not tested/);
  assert.match(agents, /GitLab Duo Agent Platform/);
});

test('DOM 16: the root .gitlab-ci.yml defines a test job and a merge request agent job', () => {
  const d = G.parseGitlabCI(fs.readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8'));
  assert.equal(d.test.script[0], 'npm test');
  assert.match(d['green-agent'].script[0], /^node cli\.js /);
  assert.deepEqual(d['green-agent'].artifacts.paths, ['green-report.md']);
});

/* ---------- controller behaviour on the fake DOM ---------- */

test('DOM 17: init fills the preset list, the editors and the region options', () => {
  const { el } = mount();
  assert.equal((el('preset-select').innerHTML.match(/<option/g) || []).length, 6);
  assert.match(el('ci-editor').value, /install-build:/);
  assert.match(el('telemetry-editor').value, /"unit-test"/);
  assert.equal((el('opt-region').innerHTML.match(/<option/g) || []).length, 6);
  assert.match(el('parse-status').textContent, /Parsed 7 jobs in 5 stages/);
});

test('DOM 18: before a run the canvas shows the curves, a prompt and all six legend entries', () => {
  const { el } = mount();
  const texts = el('carbon-canvas').ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.ok(texts.some((t) => /Run the agent/.test(t)));
  assert.equal((el('legend').innerHTML.match(/<li>/g) || []).length, 6);
  assert.match(el('trace-log').innerHTML, /agent is idle/);
});

test('DOM 19: Run Hands-Off Duo Agent fills summary, diff, jobs, trace and report', () => {
  const { ctl, el } = mount();
  el('btn-run').dispatch('click');
  assert.equal(ctl.result.ok, true);
  assert.match(el('summary').innerHTML, /Carbon saved/);
  assert.match(el('diff-view').innerHTML, /class="change"/);
  assert.match(el('job-table').innerHTML, /fuzz-api/);
  assert.match(el('trace-log').innerHTML, /rightsize_runner/);
  assert.match(el('mr-report').textContent, /GreenRunner: carbon-aware pipeline plan/);
  assert.match(el('schedule-list').innerHTML, /GREEN_WINDOW=us-central1-/);
});

test('DOM 20: the run draws a lane for every moved job and updates the canvas label', () => {
  const { ctl, el } = mount();
  el('btn-run').dispatch('click');
  const moved = ctl.result.changes.filter((c) => /^shift/.test(c.type)).length;
  assert.ok(moved >= 1);
  assert.match(el('carbon-canvas').attrs['aria-label'], new RegExp(moved + ' jobs moved'));
  const texts = el('carbon-canvas').ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.ok(texts.some((t) => /^fuzz-api \(/.test(t)));
});

test('DOM 21: Run With Region Shift ticks the checkbox state and saves more carbon', () => {
  const { ctl, el } = mount();
  el('btn-run').dispatch('click');
  const timeOnly = ctl.result.savings.gco2Pct;
  el('btn-run-region').dispatch('click');
  assert.equal(ctl.opts.allowRegionShift, true);
  assert.equal(el('opt-region-shift').checked, true);
  assert.ok(ctl.result.savings.gco2Pct > timeOnly);
  assert.match(el('job-table').innerHTML, /moved europe-north1/);
});

test('DOM 22: Apply Patch To Editor replaces the YAML and telemetry and disables itself', () => {
  const { ctl, el } = mount();
  assert.equal(el('btn-apply').disabled, true);
  el('btn-run').dispatch('click');
  assert.equal(el('btn-apply').disabled, false);
  const before = el('ci-editor').value;
  el('btn-apply').dispatch('click');
  assert.notEqual(el('ci-editor').value, before);
  assert.match(el('ci-editor').value, /GREEN_WINDOW/);
  assert.equal(el('btn-apply').disabled, true);
  assert.match(el('parse-status').textContent, /Patch applied 1 time/);
  assert.equal(ctl.result, null);
});

test('DOM 23: running again after applying finds nothing further to change', () => {
  const { ctl, el } = mount();
  el('btn-run').dispatch('click');
  el('btn-apply').dispatch('click');
  const applied = ctl.yaml;
  el('btn-run').dispatch('click');
  assert.equal(ctl.result.patchedYaml, G.dumpYaml(G.parseGitlabCI(applied)));
  assert.equal(ctl.result.changes.filter((c) => c.type === 'rightsize').length, 0);
});

test('DOM 24: invalid YAML shows an error, blocks the run and leaves the report empty', () => {
  const { ctl, el } = mount();
  el('ci-editor').dispatch('input', { target: { value: 'a:\n\tb: 1\n' } });
  assert.match(el('parse-status').textContent, /YAML problem/);
  assert.equal(el('parse-status').className, 'status bad');
  el('btn-run').dispatch('click');
  assert.equal(ctl.result, null);
  assert.match(el('mr-report').textContent, /appears here after a run/);
});

test('DOM 25: invalid telemetry JSON shows its own error and blocks the run', () => {
  const { ctl, el } = mount();
  el('telemetry-editor').dispatch('input', { target: { value: '{nope' } });
  assert.match(el('parse-status').textContent, /Telemetry JSON problem/);
  el('btn-run').dispatch('click');
  assert.equal(ctl.result, null);
});

test('DOM 26: fixing the YAML clears the error and a run works again', () => {
  const { ctl, el } = mount();
  el('ci-editor').dispatch('input', { target: { value: 'a:\n\tb: 1\n' } });
  el('ci-editor').dispatch('input', { target: { value: G.PRESETS[1].yaml } });
  assert.match(el('parse-status').textContent, /Parsed 5 jobs/);
  el('btn-run').dispatch('click');
  assert.equal(ctl.result.ok, true);
});

test('DOM 27: choosing a preset loads its YAML and telemetry and clears the last result', () => {
  const { ctl, el } = mount();
  el('btn-run').dispatch('click');
  el('preset-select').dispatch('change', { target: { value: 'java-monorepo' } });
  assert.equal(ctl.presetId, 'java-monorepo');
  assert.match(el('ci-editor').value, /maven-build:/);
  assert.equal(ctl.result, null);
  assert.match(el('summary').innerHTML, /No run yet/);
});

test('DOM 28: the pinned job shows a pinned badge in the job table', () => {
  const { el } = mount();
  el('preset-select').dispatch('change', { target: { value: 'java-monorepo' } });
  el('btn-run').dispatch('click');
  assert.match(el('job-table').innerHTML, /pill pinned/);
  assert.match(el('mr-report').textContent, /not moved, required by release/);
});

test('DOM 29: option inputs are clamped and the region select only accepts known regions', () => {
  const { ctl, el } = mount();
  el('opt-hour').dispatch('input', { target: { value: '99' } });
  assert.equal(ctl.opts.startHour, 23);
  el('opt-delay').dispatch('input', { target: { value: '-4' } });
  assert.equal(ctl.opts.maxDelayHours, 0);
  assert.equal(ctl.setOption('region', 'mars-1'), false);
  el('opt-region').dispatch('change', { target: { value: 'us-west1' } });
  assert.equal(ctl.opts.region, 'us-west1');
});

test('DOM 30: changing the baseline region redraws the canvas and changes the result', () => {
  const { ctl, el } = mount();
  el('btn-run').dispatch('click');
  const a = ctl.result.baseline.totalGco2;
  const callsBefore = el('carbon-canvas').ctx.calls.length;
  el('opt-region').dispatch('change', { target: { value: 'asia-southeast1' } });
  assert.ok(el('carbon-canvas').ctx.calls.length > callsBefore);
  el('btn-run').dispatch('click');
  assert.ok(ctl.result.baseline.totalGco2 > a);
});

test('DOM 31: the checkbox toggles region shifting for the next run', () => {
  const { ctl, el } = mount();
  el('opt-region-shift').dispatch('change', { target: { checked: true } });
  el('btn-run').dispatch('click');
  assert.ok(ctl.result.changes.some((c) => c.type === 'shift-region'));
});

test('DOM 32: drawCarbon stays inside the canvas and draws one curve per region', () => {
  const rec = [];
  const ctx = new Proxy({}, { get: (_, k) => (...a) => rec.push([k, ...a]), set: () => true });
  App.drawCarbon(ctx, G, { baseRegion: 'us-central1', startHour: 19, moves: [{ job: 'j', fromHour: 19, toHour: 3, durHours: 0.5, toRegion: 'europe-north1' }], ran: true }, 860, 480);
  rec.filter((r) => r[0] === 'moveTo' || r[0] === 'lineTo').forEach((r) => {
    assert.ok(r[1] >= 0 && r[1] <= 860, 'x ' + r[1]);
    assert.ok(r[2] >= 0 && r[2] <= 480, 'y ' + r[2]);
  });
  assert.ok(rec.filter((r) => r[0] === 'stroke').length >= 6 + 1);
});

test('DOM 33: esc neutralises markup in YAML shown in the diff', () => {
  assert.equal(App.esc('<script>"x" & \'y\'</script>'), '&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;');
  const { el } = mount();
  el('ci-editor').dispatch('input', { target: { value: 'stages: [test]\n"<b>x</b>":\n  stage: test\n  script: [x]\n' } });
  el('btn-run').dispatch('click');
  assert.ok(!/<b>x<\/b>/.test(el('job-table').innerHTML));
});

test('DOM 34: every preset runs end to end through the controller', () => {
  const { ctl, el } = mount();
  G.PRESETS.forEach((p) => {
    el('preset-select').dispatch('change', { target: { value: p.id } });
    el('btn-run').dispatch('click');
    assert.equal(ctl.result.ok, true, p.id);
    assert.match(el('summary').innerHTML, /Jobs changed/);
  });
});
