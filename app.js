/*
 * GreenRunner UI controller. The model and the agent live in engine.js; this file renders
 * results, draws the carbon canvas and binds events. createController accepts any
 * document-like object so the tests can drive it without a browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GreenRunnerApp = factory();
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
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

  function shareBase() {
    return typeof location !== 'undefined' && location && location.href ? location.href.split('#')[0] : '';
  }

  function createController(engine, doc, lab) {
    var els = {};
    function $(id) { if (!els[id]) els[id] = doc.getElementById(id); return els[id]; }
    function setHTML(id, html) { var e = $(id); if (e) e.innerHTML = html; }
    function setText(id, text) { var e = $(id); if (e) e.textContent = text; }
    function setTone(id, tone) { var e = $(id); if (e && e.setAttribute) e.setAttribute('data-tone', tone); }

    var ctl = {
      engine: engine,
      lab: lab || null,
      labState: lab ? lab.normalizeLabState({}) : null,
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

    /* ----- Carbon Pareto & Guardrail Lab ----- */

    var LAB_KEYS = { presetId: true, policyId: true, regionId: true, maxDelayHours: true, maxSlowdownPct: true, startHour: true };

    ctl.renderLab = function () {
      var lab = ctl.lab;
      if (!lab) return;
      var section = $('gr-lab-section');
      if (section) section.hidden = false;
      var st = ctl.labState;
      var ps = $('gr-preset'), rg = $('gr-region');
      if (ps && !ps.innerHTML) ps.innerHTML = lab.renderPresetOptionsHtml();
      if (rg && !rg.innerHTML) rg.innerHTML = lab.renderRegionOptionsHtml();
      if (ps) ps.value = st.presetId;
      if (rg) rg.value = st.regionId;
      var start = $('gr-start'), delay = $('gr-delay'), slow = $('gr-slowdown');
      if (start) start.value = String(st.startHour);
      if (delay) delay.value = String(st.maxDelayHours);
      if (slow) slow.value = String(st.maxSlowdownPct);
      setText('gr-start-out', ('0' + st.startHour).slice(-2) + ':00');
      setText('gr-delay-out', st.maxDelayHours + ' h');
      setText('gr-slowdown-out', st.maxSlowdownPct + '%');
      lab.LAB_POLICIES.forEach(function (p) {
        var radio = $('gr-policy-' + p.id);
        if (radio) radio.checked = p.id === st.policyId;
      });
      var preset = engine.getPreset(st.presetId);
      setText('gr-comparator-preset', preset ? preset.name : st.presetId);
      setHTML('gr-comparator-body', lab.renderComparatorRowsHtml(st));
      setHTML('gr-matrix-body', lab.renderPresetMatrixRowsHtml(st));
      setHTML('gr-curves-chart', lab.renderCurvesSvg(st));
      setHTML('gr-pareto-chart', lab.renderParetoSvg(st));
      setHTML('gr-delay-table', lab.renderDelaySweepTableHtml(st));
      setHTML('gr-greenest-body', lab.renderGreenestRowsHtml(st));
      var stamped = lab.getStampedReport(st);
      setText('gr-digest-line', 'sha256:' + stamped.digestHex);
      var share = $('gr-share-url');
      if (share) share.value = shareBase() + lab.encodeLabHash(st);
    };

    ctl.setLabOption = function (key, value) {
      if (!ctl.lab || !Object.prototype.hasOwnProperty.call(LAB_KEYS, key)) return false;
      var next = {};
      Object.keys(ctl.labState).forEach(function (k) { next[k] = ctl.labState[k]; });
      next[key] = value;
      ctl.labState = ctl.lab.normalizeLabState(next);
      ctl.renderLab();
      return true;
    };

    function labDelegate(e) {
      if (!ctl.lab) return;
      var t = e && e.target;
      if (!t || typeof t.closest !== 'function' || typeof t.getAttribute !== 'function') return;
      var pick = t.closest('[data-gr-pick-policy]');
      if (pick) {
        var pid = pick.getAttribute('data-gr-pick-policy');
        var prid = pick.getAttribute('data-gr-pick-preset');
        if (prid) ctl.setLabOption('presetId', prid);
        if (pid) ctl.setLabOption('policyId', pid);
        return;
      }
      var policyRow = t.closest('tr[data-policy-id]');
      if (policyRow) { ctl.setLabOption('policyId', policyRow.getAttribute('data-policy-id')); return; }
      var presetRow = t.closest('tr[data-preset-id]');
      if (presetRow) { ctl.setLabOption('presetId', presetRow.getAttribute('data-preset-id')); return; }
      var regionRow = t.closest('tr[data-region-id]');
      if (regionRow) { ctl.setLabOption('regionId', regionRow.getAttribute('data-region-id')); return; }
      var regionPoint = t.closest('[data-gr-region]');
      if (regionPoint) { ctl.setLabOption('regionId', regionPoint.getAttribute('data-gr-region')); }
    }

    function labDownload(name, text) {
      if (typeof document === 'undefined' || !document.createElement || !document.body) return;
      if (typeof URL === 'undefined' || !URL.createObjectURL || typeof Blob === 'undefined') return;
      try {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 500);
      } catch (e) { /* download is best effort; the preview still carries the export */ }
    }

    ctl.labAction = function (action) {
      var lab = ctl.lab;
      if (!lab) return false;
      var st = ctl.labState;
      if (action === 'load-preset') return ctl.loadPreset(st.presetId);
      if (action === 'export-json' || action === 'export-csv' || action === 'export-md') {
        var names = { 'export-json': 'greenrunner-brief.json', 'export-csv': 'greenrunner-brief.csv', 'export-md': 'greenrunner-brief.md' };
        var body = action === 'export-json' ? lab.exportReportJson(st) : (action === 'export-csv' ? lab.exportReportCsv(st) : lab.exportReportMarkdown(st));
        var prev = $('gr-export-preview');
        if (prev) { prev.hidden = false; prev.textContent = body; }
        setText('gr-verify-status', 'Exported ' + names[action] + ' (' + body.length + ' chars).');
        setTone('gr-verify-status', 'ok');
        labDownload(names[action], body);
        return true;
      }
      if (action === 'copy-share') {
        var url = shareBase() + lab.encodeLabHash(st);
        var field = $('gr-share-url');
        if (field) { field.value = url; if (field.select) field.select(); }
        var done = function () { setText('gr-verify-status', 'Share link copied to clipboard.'); };
        var fail = function () { setText('gr-verify-status', 'Share link shown in the field; clipboard unavailable.'); };
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, fail);
        else fail();
        setTone('gr-verify-status', 'ok');
        return true;
      }
      if (action === 'verify') {
        var v = lab.verifyStampedReport(lab.getStampedReport(st));
        setText('gr-verify-status', v.ok ? 'VERIFIED ' + v.actual.slice(0, 20) : 'DIGEST MISMATCH ' + v.actual.slice(0, 20));
        setTone('gr-verify-status', v.ok ? 'ok' : 'bad');
        return v.ok;
      }
      if (action === 'tamper') {
        var stamped = lab.getStampedReport(st);
        var tampered = JSON.parse(JSON.stringify(stamped.payload));
        tampered.inputs.maxSlowdownPct = tampered.inputs.maxSlowdownPct === 50 ? 49 : 50;
        var verdict = lab.verifyStampedReport({ payload: tampered, digestHex: stamped.digestHex });
        setText('gr-verify-status', verdict.ok ? 'TAMPER MISSED' : 'TAMPER DETECTED: slowdown ' + stamped.payload.inputs.maxSlowdownPct + '% rewritten to ' + tampered.inputs.maxSlowdownPct + '%');
        setTone('gr-verify-status', 'bad');
        return true;
      }
      if (action === 'run-tests') {
        var results = lab.runLabSelfTests(st);
        var passed = results.filter(function (r) { return r.pass; }).length;
        var sum = $('gr-selftest-summary');
        if (sum) {
          sum.textContent = passed + '/' + results.length + ' in-page checks passing.';
          if (sum.setAttribute) sum.setAttribute('data-tone', passed === results.length ? 'ok' : 'bad');
        }
        setHTML('gr-selftest-list', results.map(function (r) {
          return '<li class="' + (r.pass ? 'lab-test-pass' : 'lab-test-fail') + '"><b>' + (r.pass ? 'PASS' : 'FAIL') + '</b> ' + esc(r.name) + '. ' + esc(r.detail) + '</li>';
        }).join(''));
        return results;
      }
      return false;
    };

    ctl.applyLabBookmark = function (hash) {
      if (!ctl.lab) return false;
      var decoded = ctl.lab.decodeLabHash(hash);
      if (!decoded) { ctl.renderLab(); return false; }
      ctl.labState = decoded;
      ctl.loadPreset(decoded.presetId);
      return true;
    };

    ctl.restoreLabBookmark = function () {
      if (!ctl.lab) return;
      if (typeof location === 'undefined' || !location.hash) return;
      ctl.applyLabBookmark(location.hash);
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
      ctl.renderLab();
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
      if (ctl.lab) {
        on('gr-preset', 'change', function (e) { ctl.setLabOption('presetId', e.target.value); });
        on('gr-region', 'change', function (e) { ctl.setLabOption('regionId', e.target.value); });
        on('gr-start', 'input', function (e) { ctl.setLabOption('startHour', e.target.value); });
        on('gr-delay', 'input', function (e) { ctl.setLabOption('maxDelayHours', e.target.value); });
        on('gr-slowdown', 'input', function (e) { ctl.setLabOption('maxSlowdownPct', e.target.value); });
        on('gr-lab-section', 'click', labDelegate);
        on('gr-lab-section', 'keydown', function (e) { if (e && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); labDelegate(e); } });
        ctl.lab.LAB_POLICIES.forEach(function (p) {
          on('gr-policy-' + p.id, 'change', function (e) { if (e.target.checked) ctl.setLabOption('policyId', p.id); });
        });
        on('gr-load-preset', 'click', function () { ctl.labAction('load-preset'); });
        on('gr-export-json', 'click', function () { ctl.labAction('export-json'); });
        on('gr-export-csv', 'click', function () { ctl.labAction('export-csv'); });
        on('gr-export-md', 'click', function () { ctl.labAction('export-md'); });
        on('gr-copy-share', 'click', function () { ctl.labAction('copy-share'); });
        on('gr-verify', 'click', function () { ctl.labAction('verify'); });
        on('gr-tamper', 'click', function () { ctl.labAction('tamper'); });
        on('gr-run-tests', 'click', function () { ctl.labAction('run-tests'); });
      }
    };

    ctl.init = function () {
      ctl.bind();
      ctl.loadPreset(engine.PRESETS[0].id);
      ctl.restoreLabBookmark();
      return ctl;
    };

    return ctl;
  }

  var api = { createController: createController, drawCarbon: drawCarbon, esc: esc, REGION_COLORS: REGION_COLORS };

  if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.GreenRunner) {
    api.app = createController(window.GreenRunner, document, window.GreenRunnerLab || null).init();
  }
  return api;
}));
