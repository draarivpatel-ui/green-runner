/*
 * GreenRunner UI controller. The model and the agent live in engine.js; this file renders
 * results, draws the carbon canvas and binds events. createController accepts any
 * document-like object so the tests can drive it without a browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GreenRunnerApp = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var REGION_COLORS = { 'us-central1': '#ffd166', 'europe-north1': '#6bb5ff', 'us-west1': '#c792ea', 'europe-west4': '#ff9f68', 'asia-southeast1': '#ff6b6b', 'southamerica-east1': '#8cf26b' };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function short(tag) { return String(tag).replace(/^saas-linux-/, '').replace(/-amd64$/, ''); }

  /* ---------- pure canvas drawing ---------- */

  function drawCarbon(ctx, engine, model, w, h) {
    ctx.clearRect(0, 0, w, h);
    var padL = 52, padR = 14, padT = 14, laneH = 26;
    var lanes = model.moves.length;
    var padB = 58 + lanes * laneH;
    var pw = w - padL - padR, ph = h - padT - padB;
    var maxI = 0;
    engine.REGIONS.forEach(function (r) { engine.regionCurve(r.id).forEach(function (v) { if (v > maxI) maxI = v; }); });
    maxI = Math.ceil(maxI / 100) * 100;
    function X(hour) { return padL + (hour / 24) * pw; }
    function Y(v) { return padT + ph - (v / maxI) * ph; }

    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#8fb09b';
    ctx.strokeStyle = 'rgba(143, 176, 155, 0.18)';
    ctx.lineWidth = 1;
    ctx.textAlign = 'center';
    for (var hr = 0; hr <= 24; hr += 4) {
      ctx.beginPath(); ctx.moveTo(X(hr), padT); ctx.lineTo(X(hr), padT + ph); ctx.stroke();
      ctx.fillText(('0' + (hr % 24)).slice(-2) + ':00', X(hr), padT + ph + 14);
    }
    ctx.textAlign = 'right';
    for (var v = 0; v <= maxI; v += 100) {
      ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(padL + pw, Y(v)); ctx.stroke();
      ctx.fillText(String(v), padL - 6, Y(v) + 4);
    }
    ctx.textAlign = 'left';
    ctx.fillText('gCO2eq per kWh, UTC hour', padL, padT + ph + 32);

    engine.REGIONS.forEach(function (r) {
      var c = engine.regionCurve(r.id);
      ctx.beginPath();
      for (var i = 0; i <= 24; i += 1) {
        var px = X(i), py = Y(c[i % 24]);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = REGION_COLORS[r.id];
      ctx.lineWidth = r.id === model.baseRegion ? 3.5 : 1.6;
      ctx.stroke();
    });

    if (model.startHour !== null) {
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(X(model.startHour), padT); ctx.lineTo(X(model.startHour), padT + ph);
      ctx.strokeStyle = '#fc6d26'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fc6d26';
      ctx.textAlign = 'left';
      ctx.fillText('pipeline start', X(model.startHour) + 4, padT + 12);
    }

    model.moves.forEach(function (m, i) {
      var y = padT + ph + 58 + i * laneH;
      function box(startHour, durHours, style, color) {
        var s = ((startHour % 24) + 24) % 24;
        var parts = s + durHours > 24 ? [[s, 24], [0, s + durHours - 24]] : [[s, s + durHours]];
        parts.forEach(function (p) {
          ctx.beginPath();
          ctx.moveTo(X(p[0]), y); ctx.lineTo(X(Math.max(p[1], p[0] + 0.15)), y);
          ctx.lineWidth = 9;
          ctx.strokeStyle = color;
          ctx.setLineDash(style === 'dash' ? [3, 3] : []);
          ctx.stroke();
        });
        ctx.setLineDash([]);
      }
      box(m.fromHour, m.durHours, 'dash', 'rgba(143, 176, 155, 0.7)');
      box(m.toHour, m.durHours, 'solid', REGION_COLORS[m.toRegion] || '#8cf26b');
      ctx.fillStyle = '#e6f5ea';
      ctx.textAlign = 'left';
      ctx.fillText(m.job + ' (' + m.toRegion + ')', padL + 4, y - 8);
    });

    if (!model.moves.length) {
      ctx.fillStyle = '#8fb09b';
      ctx.textAlign = 'center';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText(model.ran ? 'No job was moved in this run' : 'Run the agent to see deferred jobs move into greener windows', padL + pw / 2, padT + 22);
    }
  }

  /* ---------- controller ---------- */

  function createController(engine, doc) {
    var els = {};
    function $(id) { if (!els[id]) els[id] = doc.getElementById(id); return els[id]; }
    function setHTML(id, html) { var e = $(id); if (e) e.innerHTML = html; }
    function setText(id, text) { var e = $(id); if (e) e.textContent = text; }

    var ctl = {
      engine: engine,
      presetId: null,
      yaml: '',
      telemetryText: '{}',
      telemetryError: null,
      parseError: null,
      opts: { region: engine.DEFAULT_OPTS.region, startHour: engine.DEFAULT_OPTS.startHour, maxDelayHours: engine.DEFAULT_OPTS.maxDelayHours, allowRegionShift: false },
      result: null,
      applied: 0
    };

    function checkInputs() {
      ctl.parseError = null;
      try { engine.parseGitlabCI(ctl.yaml); } catch (e) { ctl.parseError = e.message; }
      ctl.telemetryError = null;
      try { JSON.parse(ctl.telemetryText || '{}'); } catch (e) { ctl.telemetryError = e.message; }
    }

    ctl.loadPreset = function (id) {
      var p = engine.getPreset(id);
      if (!p) return false;
      ctl.presetId = id;
      ctl.yaml = p.yaml;
      ctl.telemetryText = JSON.stringify(p.telemetry, null, 2);
      ctl.result = null;
      ctl.applied = 0;
      var ci = $('ci-editor'), te = $('telemetry-editor'), ps = $('preset-select');
      if (ci) ci.value = ctl.yaml;
      if (te) te.value = ctl.telemetryText;
      if (ps) ps.value = id;
      checkInputs();
      ctl.render();
      return true;
    };

    ctl.setYaml = function (text) { ctl.yaml = String(text); checkInputs(); ctl.renderStatus(); };
    ctl.setTelemetry = function (text) { ctl.telemetryText = String(text); checkInputs(); ctl.renderStatus(); };

    ctl.setOption = function (key, value) {
      if (key === 'startHour') ctl.opts.startHour = Math.max(0, Math.min(23, Number(value) || 0));
      else if (key === 'maxDelayHours') ctl.opts.maxDelayHours = Math.max(0, Math.min(23, Number(value) || 0));
      else if (key === 'allowRegionShift') ctl.opts.allowRegionShift = !!value;
      else if (key === 'region' && engine.REGIONS.some(function (r) { return r.id === value; })) ctl.opts.region = value;
      else return false;
      ctl.renderCanvas();
      return true;
    };

    ctl.runAgent = function (overrides) {
      checkInputs();
      if (ctl.parseError || ctl.telemetryError) { ctl.result = null; ctl.render(); return null; }
      var o = Object.assign({}, ctl.opts, overrides || {});
      var checkbox = $('opt-region-shift');
      if (overrides && overrides.allowRegionShift !== undefined) { ctl.opts.allowRegionShift = overrides.allowRegionShift; if (checkbox) checkbox.checked = overrides.allowRegionShift; }
      ctl.result = engine.runGreenAgent(ctl.yaml, JSON.parse(ctl.telemetryText || '{}'), o);
      ctl.render();
      return ctl.result;
    };

    ctl.applyPatch = function () {
      if (!ctl.result || !ctl.result.ok) return false;
      ctl.yaml = ctl.result.patchedYaml;
      ctl.telemetryText = JSON.stringify(ctl.result.effectiveTelemetry, null, 2);
      var ci = $('ci-editor'), te = $('telemetry-editor');
      if (ci) ci.value = ctl.yaml;
      if (te) te.value = ctl.telemetryText;
      ctl.applied += 1;
      ctl.result = null;
      checkInputs();
      ctl.render();
      return true;
    };

    /* ----- rendering ----- */

    ctl.renderStatus = function () {
      var el = $('parse-status');
      if (!el) return;
      if (ctl.parseError) { el.textContent = 'YAML problem: ' + ctl.parseError; el.className = 'status bad'; }
      else if (ctl.telemetryError) { el.textContent = 'Telemetry JSON problem: ' + ctl.telemetryError; el.className = 'status bad'; }
      else {
        var doc = engine.parseGitlabCI(ctl.yaml);
        el.textContent = 'Parsed ' + engine.jobsOf(doc).length + ' jobs in ' + engine.stageOrder(doc).length + ' stages.' + (ctl.applied ? ' Patch applied ' + ctl.applied + ' time(s).' : '');
        el.className = 'status';
      }
    };

    ctl.moveModel = function () {
      var r = ctl.result;
      var moves = [];
      if (r && r.ok) {
        r.changes.forEach(function (c) {
          if (c.type !== 'shift-time' && c.type !== 'shift-region') return;
          var base = r.baseline.rows.filter(function (x) { return x.job === c.job; })[0];
          var after = r.after.rows.filter(function (x) { return x.job === c.job; })[0];
          moves.push({ job: c.job, fromHour: base.startHour, toHour: after.startHour, durHours: after.durationMin / 60, toRegion: after.region });
        });
      }
      return { baseRegion: ctl.opts.region, startHour: ctl.opts.startHour, moves: moves, ran: !!(r && r.ok) };
    };

    ctl.renderCanvas = function () {
      var canvas = $('carbon-canvas');
      var model = ctl.moveModel();
      if (canvas && typeof canvas.getContext === 'function') {
        var ctx = canvas.getContext('2d');
        if (ctx) drawCarbon(ctx, engine, model, canvas.width, canvas.height);
        if (canvas.setAttribute) canvas.setAttribute('aria-label', 'Grid carbon intensity curves for ' + engine.REGIONS.length + ' regions. ' + (model.ran ? model.moves.length + ' jobs moved to greener windows.' : 'No run yet.'));
      }
      setHTML('legend', engine.REGIONS.map(function (r) {
        return '<li><i class="swatch" style="background:' + REGION_COLORS[r.id] + '"></i>' + esc(r.id) + ' (' + esc(r.name) + ')</li>';
      }).join(''));
    };

    ctl.renderSummary = function () {
      var r = ctl.result;
      if (!r || !r.ok) { setHTML('summary', '<p class="empty">' + (r && r.error ? esc(r.error) : 'No run yet.') + '</p>'); return; }
      var s = r.savings;
      function stat(label, big, small, warn) { return '<div class="stat' + (warn ? ' warn' : '') + '"><span>' + esc(label) + '</span><strong>' + esc(big) + '</strong><small>' + esc(small) + '</small></div>'; }
      setHTML('summary',
        stat('Carbon saved', s.gco2Pct + '%', r.baseline.totalGco2 + ' to ' + r.after.totalGco2 + ' gCO2eq') +
        stat('Energy saved', s.whPct + '%', r.baseline.totalWh + ' to ' + r.after.totalWh + ' Wh') +
        stat('Critical path', s.criticalPathAfterMin + ' min', 'was ' + s.criticalPathBeforeMin + ' min', s.criticalPathAfterMin > s.criticalPathBeforeMin) +
        stat('Jobs changed', String(r.changes.filter(function (c) { return /^(rightsize|shift)/.test(c.type); }).length), r.schedules.length + ' schedule(s) to create'));
    };

    ctl.renderDiff = function () {
      var r = ctl.result;
      if (!r || !r.ok) { setHTML('diff-view', '<caption class="empty">Run the agent to see the patch.</caption>'); return; }
      setHTML('diff-view', '<caption class="empty">Left: original, right: patched</caption><tbody>' + r.diffRows.map(function (d) {
        return '<tr class="' + d.type + '"><td>' + esc(d.left) + '</td><td>' + esc(d.right) + '</td></tr>';
      }).join('') + '</tbody>');
    };

    ctl.renderJobs = function () {
      var r = ctl.result;
      if (!r || !r.ok) { setHTML('job-table', '<caption class="empty">No run yet.</caption>'); return; }
      var rows = r.baseline.rows.map(function (b) {
        var a = r.after.rows.filter(function (x) { return x.job === b.job; })[0];
        var change = r.changes.filter(function (c) { return c.job === b.job; });
        var tags = [];
        change.forEach(function (c) {
          if (c.type === 'rightsize') tags.push('<span class="pill moved">resized</span>');
          if (c.type === 'shift-time') tags.push('<span class="pill moved">shifted ' + c.delayHours + ' h</span>');
          if (c.type === 'shift-region') tags.push('<span class="pill moved">moved ' + esc(c.region) + '</span>');
          if (c.type === 'skipped') tags.push('<span class="pill pinned">pinned</span>');
        });
        return '<tr><th scope="row">' + esc(b.job) + '</th><td>' + esc(short(b.tag)) + (a.tag !== b.tag ? ' to ' + esc(short(a.tag)) : '') + '</td><td class="num">' + engine.round(b.wh, 2) + ' to ' + engine.round(a.wh, 2) + '</td><td class="num">' + engine.round(b.gco2, 2) + ' to ' + engine.round(a.gco2, 2) + '</td><td>' + (tags.join(' ') || '') + '</td></tr>';
      });
      setHTML('job-table', '<thead><tr><th scope="col">Job</th><th scope="col">Runner</th><th scope="col" class="num">Wh</th><th scope="col" class="num">gCO2eq</th><th scope="col">Action</th></tr></thead><tbody>' + rows.join('') + '</tbody>');
    };

    ctl.renderTrace = function () {
      var r = ctl.result;
      if (!r) { setHTML('trace-log', '<li class="empty">The agent is idle. Press Run Hands-Off Duo Agent.</li>'); return; }
      setHTML('trace-log', r.trace.map(function (t) {
        return '<li class="tr"><div class="tr-head"><span class="tr-tool">' + esc(t.tool) + '</span><span class="tr-seq">#' + t.seq + '</span></div><pre>' + esc(JSON.stringify(t.input)) + '\n' + esc(JSON.stringify(t.output).slice(0, 360)) + '</pre></li>';
      }).join(''));
    };

    ctl.renderReport = function () {
      var r = ctl.result;
      setText('mr-report', r && r.ok ? r.report : 'The merge request report appears here after a run.');
      setHTML('schedule-list', r && r.ok && r.schedules.length
        ? r.schedules.map(function (s) { return '<li>' + esc(s.cron) + ' UTC, GREEN_WINDOW=' + esc(s.id) + '</li>'; }).join('')
        : '<li>None</li>');
    };

    ctl.renderOptions = function () {
      var sel = $('opt-region');
      if (sel && !sel.innerHTML) sel.innerHTML = engine.REGIONS.map(function (r) { return '<option value="' + r.id + '">' + esc(r.id + ' (' + r.name + ')') + '</option>'; }).join('');
      if (sel) sel.value = ctl.opts.region;
      var apply = $('btn-apply');
      if (apply) apply.disabled = !(ctl.result && ctl.result.ok);
    };

    ctl.render = function () {
      var ps = $('preset-select');
      if (ps && !ps.innerHTML) ps.innerHTML = engine.PRESETS.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join('');
      if (ps && ctl.presetId) ps.value = ctl.presetId;
      ctl.renderOptions();
      ctl.renderStatus();
      ctl.renderCanvas();
      ctl.renderSummary();
      ctl.renderDiff();
      ctl.renderJobs();
      ctl.renderTrace();
      ctl.renderReport();
    };

    ctl.bind = function () {
      function on(id, type, fn) { var e = $(id); if (e && e.addEventListener) e.addEventListener(type, fn); }
      on('preset-select', 'change', function (e) { ctl.loadPreset(e.target.value); });
      on('ci-editor', 'input', function (e) { ctl.setYaml(e.target.value); });
      on('telemetry-editor', 'input', function (e) { ctl.setTelemetry(e.target.value); });
      on('btn-run', 'click', function () { ctl.runAgent(); });
      on('btn-run-region', 'click', function () { ctl.runAgent({ allowRegionShift: true }); });
      on('btn-apply', 'click', function () { ctl.applyPatch(); });
      on('opt-region', 'change', function (e) { ctl.setOption('region', e.target.value); });
      on('opt-hour', 'input', function (e) { ctl.setOption('startHour', e.target.value); });
      on('opt-delay', 'input', function (e) { ctl.setOption('maxDelayHours', e.target.value); });
      on('opt-region-shift', 'change', function (e) { ctl.setOption('allowRegionShift', e.target.checked); });
    };

    ctl.init = function () {
      ctl.bind();
      ctl.loadPreset(engine.PRESETS[0].id);
      return ctl;
    };

    return ctl;
  }

  var api = { createController: createController, drawCarbon: drawCarbon, esc: esc, REGION_COLORS: REGION_COLORS };

  if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.GreenRunner) {
    api.app = createController(window.GreenRunner, document).init();
  }
  return api;
}));
