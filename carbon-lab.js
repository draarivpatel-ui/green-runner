/*
 * GreenRunner Carbon Pareto & Guardrail Lab.
 *
 * Pure JS, zero dependencies. UMD: require() in Node, window.GreenRunnerLab in a
 * browser. Every number on the lab panel is produced by calling the real agent
 * in engine.js, so a lab claim can never exceed what the engine produces.
 *
 * Contents:
 *  - A 5-policy x 6-preset comparator: each cell is a real runGreenAgent call
 *    that reports energy, carbon, saved percent, worst per-job slowdown, the
 *    pinned-job safety verdict, the second-pass YAML idempotency verdict and
 *    the rules/only/except conflict clearance verdict.
 *  - A slowdown-budget sweep (0..50%) across all six grid regions and a
 *    max-delay sweep (0..24h) that draw the carbon-saved vs slowdown-budget
 *    Pareto frontier, plus the greenest launch hour per region.
 *  - A FIPS 180-4 SHA-256 implementation used to stamp one canonical carbon
 *    brief per input state; the on-page fingerprint, the JSON export, the CSV
 *    provenance header and the Markdown footer all reuse the same cached
 *    digest-stamped payload.
 *  - A strict #gr= bookmark codec that round-trips preset, policy, region,
 *    max delay hours, max slowdown percent and launch hour, and fails closed
 *    on any malformed or hostile hash.
 *  - Deterministic in-page self-tests runnable from the lab panel.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.GreenRunnerLab = factory(root.GreenRunner);
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (G) {
  'use strict';

  var LAB_SCHEMA_VERSION = 'greenrunner-carbon-brief/v1';
  var HASH_SCHEMA_VERSION = 'v1';

  var SLOWDOWN_SWEEP_PCTS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
  var DELAY_SWEEP_HOURS = [0, 1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24];
  var MAX_DELAY_HOURS = 24;
  var MAX_SLOWDOWN_PCT = 50;

  var LAB_REGION_COLORS = {
    'us-central1': '#ffd166',
    'europe-north1': '#6bb5ff',
    'us-west1': '#c792ea',
    'europe-west4': '#ff9f68',
    'asia-southeast1': '#ff6b6b',
    'southamerica-east1': '#8cf26b'
  };

  /* ------------------------------------------------------------------ */
  /* Lab policies                                                       */
  /* ------------------------------------------------------------------ */

  /*
   * The five lab policies. Each maps to one runGreenAgent option set:
   * the engine itself decides what changes, so a policy can never promise
   * more than the engine delivers. Shifting policies use minGainPct 0 so the
   * delay, slowdown and region knobs alone shape the outcome.
   */
  var LAB_POLICIES = [
    {
      id: 'baseline',
      name: 'Baseline, no changes',
      summary: 'The pipeline exactly as pasted: no resize, no shift. The do-nothing reference case.',
      engineOptions: function (st) {
        return { region: st.regionId, startHour: st.startHour, maxDelayHours: 0, minGainPct: 101, maxSlowdown: 1 };
      }
    },
    {
      id: 'right-size-only',
      name: 'Right-size only',
      summary: 'Runner tags shrink inside the slowdown budget; no job ever leaves the pipeline.',
      engineOptions: function (st) {
        return { region: st.regionId, startHour: st.startHour, maxDelayHours: 0, minGainPct: 101, maxSlowdown: 1 + st.maxSlowdownPct / 100 };
      }
    },
    {
      id: 'time-shift-only',
      name: 'Time shift only',
      summary: 'Deferrable jobs move to greener hours in the baseline region; runner sizes untouched.',
      engineOptions: function (st) {
        return { region: st.regionId, startHour: st.startHour, maxDelayHours: st.maxDelayHours, minGainPct: 0, maxSlowdown: 1, allowRegionShift: false };
      }
    },
    {
      id: 'hands-off-local',
      name: 'Hands-off, same region',
      summary: 'The judge-shortcut run: right-size plus time shift inside the baseline region.',
      engineOptions: function (st) {
        return { region: st.regionId, startHour: st.startHour, maxDelayHours: st.maxDelayHours, minGainPct: 0, maxSlowdown: 1 + st.maxSlowdownPct / 100, allowRegionShift: false };
      }
    },
    {
      id: 'region-plus-time',
      name: 'Region plus time shift',
      summary: 'Right-size, then move deferrable jobs to the greenest window in any of the six regions.',
      engineOptions: function (st) {
        return { region: st.regionId, startHour: st.startHour, maxDelayHours: st.maxDelayHours, minGainPct: 0, maxSlowdown: 1 + st.maxSlowdownPct / 100, allowRegionShift: true };
      }
    }
  ];

  function getPolicyById(policyId) {
    if (typeof policyId !== 'string') return null;
    for (var i = 0; i < LAB_POLICIES.length; i += 1) {
      if (LAB_POLICIES[i].id === policyId.trim()) return LAB_POLICIES[i];
    }
    return null;
  }

  function clampNumber(value, lo, hi, fallback) {
    var n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  /*
   * Normalize any raw lab state into the strict shape every lab function
   * consumes. Unknown preset, policy or region ids fall back to the defaults;
   * non-finite numbers fall back instead of propagating NaN.
   */
  function normalizeLabState(raw) {
    var src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var presetId = typeof src.presetId === 'string' && G.getPreset(src.presetId) ? src.presetId : G.PRESETS[0].id;
    var policyId = getPolicyById(src.policyId) ? src.policyId.trim() : 'hands-off-local';
    var regionId = 'us-central1';
    for (var i = 0; i < G.REGIONS.length; i += 1) {
      if (G.REGIONS[i].id === src.regionId) { regionId = src.regionId; break; }
    }
    // +0 below turns a surviving -0 into +0 so state never carries minus zero
    var maxDelayHours = Math.round(clampNumber(src.maxDelayHours, 0, MAX_DELAY_HOURS, 14) * 2) / 2 + 0;
    var maxSlowdownPct = Math.round(clampNumber(src.maxSlowdownPct, 0, MAX_SLOWDOWN_PCT, 15)) + 0;
    var startHour = Math.round(clampNumber(src.startHour, 0, 23, 19)) + 0;
    return {
      presetId: presetId,
      policyId: policyId,
      regionId: regionId,
      maxDelayHours: maxDelayHours,
      maxSlowdownPct: maxSlowdownPct,
      startHour: startHour
    };
  }

  function engineOptionsFor(policyId, st) {
    var policy = getPolicyById(policyId) || getPolicyById('baseline');
    return policy.engineOptions(st);
  }

  /* ------------------------------------------------------------------ */
  /* Comparator cells: one real engine run per policy x preset          */
  /* ------------------------------------------------------------------ */

  var cellCache = new Map();
  var CELL_CACHE_MAX = 320;

  function memoGet(map, key, max, build) {
    if (map.has(key)) return map.get(key);
    var value = build();
    if (map.size >= max) map.delete(map.keys().next().value);
    map.set(key, value);
    return value;
  }

  /*
   * The pinned-job safety verdict for one run. deploy and release jobs, and
   * every job pinned transitively through needs, must never be deferred and
   * must keep their rules exactly as written. Right-sizing a pinned tag is
   * allowed (it does not move the job), so only deferral and rule rewrites
   * count as violations.
   */
  function pinnedViolations(run) {
    var bad = [];
    G.jobsOf(run.doc).forEach(function (name) {
      if (run.classification[name].deferrable) return;
      if (run.deferred && run.deferred[name]) { bad.push(name); return; }
      var before = run.doc[name].rules === undefined ? null : JSON.stringify(run.doc[name].rules);
      var after = run.patched[name] && run.patched[name].rules === undefined ? null : JSON.stringify(run.patched[name].rules);
      if (before !== after) bad.push(name);
      if (run.changes.some(function (c) { return c.job === name && (c.type === 'shift-time' || c.type === 'shift-region'); })) bad.push(name);
    });
    return bad;
  }

  /*
   * The gate-clearance verdict: GitLab forbids only/except next to rules, so
   * no job in the patched document may carry both. Checked across every job,
   * not only the shifted ones.
   */
  function gateViolations(run) {
    var bad = [];
    G.jobsOf(run.patched).forEach(function (name) {
      var job = run.patched[name] || {};
      var hasRules = Array.isArray(job.rules) && job.rules.length > 0;
      if (hasRules && (job.only !== undefined || job.except !== undefined)) bad.push(name);
    });
    return bad;
  }

  /*
   * Run one policy against one preset and distill the run into a lab cell:
   * exact totals from the engine, the saved percentages from its own compare,
   * the worst predicted per-job slowdown, the pinned verdict, the
   * second-pass idempotency verdict and the gate verdict.
   */
  function evaluatePolicyCell(presetId, policyId, rawState) {
    var st = normalizeLabState(rawState);
    var preset = G.getPreset(presetId) || G.PRESETS[0];
    var policy = getPolicyById(policyId) || getPolicyById('baseline');
    var opts = engineOptionsFor(policy.id, st);
    var run = G.runGreenAgent(preset.yaml, preset.telemetry, opts);
    var cell = {
      presetId: preset.id,
      presetName: preset.name,
      policyId: policy.id,
      policyName: policy.name,
      ok: run.ok === true,
      totalWh: 0, totalGco2: 0,
      savedWh: 0, savedGco2: 0, whPct: 0, gco2Pct: 0,
      maxJobSlowdownPct: 0, worstDelayHours: 0,
      criticalPathBeforeMin: 0, criticalPathAfterMin: 0,
      movedJobs: 0, resizedJobs: 0, schedules: 0, changedJobs: 0,
      pinnedSafe: true, pinnedViolations: [],
      gatesCleared: true, gateViolations: [],
      idempotent: false
    };
    if (!run.ok) {
      cell.pinnedSafe = false;
      cell.gatesCleared = false;
      return cell;
    }
    var maxSlow = 0, worstDelay = 0, moved = 0, resized = 0, changed = 0;
    run.changes.forEach(function (c) {
      if (c.type === 'rightsize') {
        resized += 1; changed += 1;
        var pct = Math.round((c.slowdown - 1) * 1000) / 10;
        if (pct > maxSlow) maxSlow = pct;
      } else if (c.type === 'shift-time' || c.type === 'shift-region') {
        moved += 1; changed += 1;
        if (c.delayHours > worstDelay) worstDelay = c.delayHours;
      }
    });
    cell.totalWh = run.after.totalWh;
    cell.totalGco2 = run.after.totalGco2;
    cell.savedWh = run.savings.savedWh;
    cell.savedGco2 = run.savings.savedGco2;
    cell.whPct = run.savings.whPct;
    cell.gco2Pct = run.savings.gco2Pct;
    cell.maxJobSlowdownPct = maxSlow;
    cell.worstDelayHours = worstDelay;
    cell.criticalPathBeforeMin = run.savings.criticalPathBeforeMin;
    cell.criticalPathAfterMin = run.savings.criticalPathAfterMin;
    cell.movedJobs = moved;
    cell.resizedJobs = resized;
    cell.changedJobs = changed;
    cell.schedules = run.schedules.length;
    cell.pinnedViolations = pinnedViolations(run);
    cell.pinnedSafe = cell.pinnedViolations.length === 0;
    cell.gateViolations = gateViolations(run);
    cell.gatesCleared = cell.gateViolations.length === 0;
    var second = G.runGreenAgent(run.patchedYaml, run.effectiveTelemetry, opts);
    cell.idempotent = second.ok === true && second.patchedYaml === run.patchedYaml;
    return cell;
  }

  function cellCacheKey(presetId, policyId, st) {
    return canonicalJson({
      p: presetId, o: policyId, r: st.regionId,
      d: st.maxDelayHours, s: st.maxSlowdownPct, h: st.startHour
    });
  }

  function runPolicyCell(presetId, policyId, rawState) {
    var st = normalizeLabState(rawState);
    var key = cellCacheKey(presetId, policyId, st);
    return memoGet(cellCache, key, CELL_CACHE_MAX, function () {
      return evaluatePolicyCell(presetId, policyId, st);
    });
  }

  /*
   * The 5-policy x 6-preset matrix. Every cell is an evaluatePolicyCell call
   * (cached), so the matrix is exactly as honest as the engine. The invariant
   * flags aggregate over all 30 cells.
   */
  function compareAll(rawState) {
    var presets = G.PRESETS.map(function (preset) {
      return {
        presetId: preset.id,
        name: preset.name,
        cells: LAB_POLICIES.map(function (policy) {
          return runPolicyCell(preset.id, policy.id, rawState);
        })
      };
    });
    var checked = 0, pinnedBad = 0, idemBad = 0, gateBad = 0;
    presets.forEach(function (row) {
      row.cells.forEach(function (cell) {
        checked += 1;
        if (!cell.pinnedSafe) pinnedBad += 1;
        if (!cell.idempotent) idemBad += 1;
        if (!cell.gatesCleared) gateBad += 1;
      });
    });
    return {
      presets: presets,
      checkedCells: checked,
      allPinnedProtected: pinnedBad === 0,
      allIdempotent: idemBad === 0,
      allGatesCleared: gateBad === 0
    };
  }

  function comparePoliciesForPreset(presetId, rawState) {
    var matrix = compareAll(rawState);
    for (var i = 0; i < matrix.presets.length; i += 1) {
      if (matrix.presets[i].presetId === presetId) return matrix.presets[i];
    }
    return matrix.presets[0];
  }

  /* ------------------------------------------------------------------ */
  /* Slowdown-budget sweep, max-delay sweep and greenest launch hour    */
  /* ------------------------------------------------------------------ */

  /*
   * Carbon saved vs slowdown budget for the region-plus-time policy, per
   * region, plus the best-of-regions frontier. Budget 0 keeps every runner
   * exactly as tagged; 50 allows halvings the engine prices at 3% slowdown
   * each within the configured cap.
   */
  function sweepSlowdownFrontier(presetId, rawState) {
    var st = normalizeLabState(rawState);
    var perRegion = G.REGIONS.map(function (r) {
      var points = SLOWDOWN_SWEEP_PCTS.map(function (b) {
        var cell = runPolicyCell(presetId, 'region-plus-time', {
          presetId: presetId, regionId: r.id, maxDelayHours: st.maxDelayHours,
          maxSlowdownPct: b, startHour: st.startHour
        });
        return { budgetPct: b, gco2Pct: cell.gco2Pct, gco2: cell.totalGco2, regionId: r.id };
      });
      return { regionId: r.id, name: r.name, points: points };
    });
    var frontier = SLOWDOWN_SWEEP_PCTS.map(function (b, i) {
      var best = null;
      perRegion.forEach(function (pr) {
        var p = pr.points[i];
        if (!best || p.gco2Pct > best.gco2Pct + 1e-9) {
          best = { budgetPct: b, gco2Pct: p.gco2Pct, regionId: pr.regionId, name: pr.name };
        }
      });
      return best;
    });
    return { presetId: presetId, budgets: SLOWDOWN_SWEEP_PCTS.slice(), perRegion: perRegion, frontier: frontier };
  }

  /*
   * Carbon saved vs max delay window for the region-plus-time policy in the
   * selected region. Longer windows can only help or hold steady because the
   * search always includes the zero-delay candidate.
   */
  function sweepDelay(presetId, rawState) {
    var st = normalizeLabState(rawState);
    var points = DELAY_SWEEP_HOURS.map(function (d) {
      var cell = runPolicyCell(presetId, 'region-plus-time', {
        presetId: presetId, regionId: st.regionId, maxDelayHours: d,
        maxSlowdownPct: st.maxSlowdownPct, startHour: st.startHour
      });
      return { delayHours: d, gco2Pct: cell.gco2Pct, gco2: cell.totalGco2 };
    });
    return { presetId: presetId, regionId: st.regionId, points: points };
  }

  /*
   * The launch hour (UTC) that would put this preset's unoptimized pipeline
   * on the lowest-carbon grid position per region, compared against the
   * lab launch hour. This uses the real simulatePipeline call, not an
   * interpolation, so the figures match the comparator exactly.
   */
  function greenestLaunch(presetId, rawState) {
    var st = normalizeLabState(rawState);
    var preset = G.getPreset(presetId) || G.PRESETS[0];
    var doc = G.parseGitlabCI(preset.yaml);
    var tel = G.normalizeTelemetry(doc, preset.telemetry);
    return G.REGIONS.map(function (r) {
      var bestHour = 0, bestG = null, atStart = null;
      for (var h = 0; h < 24; h += 1) {
        var sim = G.simulatePipeline(doc, tel, { region: r.id, startHour: h });
        if (bestG === null || sim.totalGco2 < bestG - 1e-9) { bestG = sim.totalGco2; bestHour = h; }
        if (h === st.startHour) atStart = sim.totalGco2;
      }
      var savingPct = atStart > 0 ? Math.round((atStart - bestG) / atStart * 1000) / 10 : 0;
      return {
        regionId: r.id, name: r.name, hour: bestHour,
        gco2: bestG, gco2AtStart: atStart, savingPct: savingPct
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /* FIPS 180-4 SHA-256 (pure JS, no dependencies)                       */
  /* ------------------------------------------------------------------ */

  var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  var SHA256_H0 = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];

  function utf8Bytes(text) {
    var str = String(text);
    if (typeof TextEncoder === 'function') {
      return Array.prototype.slice.call(new TextEncoder().encode(str));
    }
    var bytes = [];
    for (var i = 0; i < str.length; i += 1) {
      var code = str.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
        var next = str.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          i += 1;
        }
      }
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      }
    }
    return bytes;
  }

  function sha256Bytes(bytes) {
    var bitLenHi = Math.floor(bytes.length / 0x20000000);
    var bitLenLo = (bytes.length * 8) >>> 0;

    var padded = bytes.slice();
    padded.push(0x80);
    while (padded.length % 64 !== 56) padded.push(0);
    padded.push((bitLenHi >>> 24) & 0xff, (bitLenHi >>> 16) & 0xff, (bitLenHi >>> 8) & 0xff, bitLenHi & 0xff);
    padded.push((bitLenLo >>> 24) & 0xff, (bitLenLo >>> 16) & 0xff, (bitLenLo >>> 8) & 0xff, bitLenLo & 0xff);

    var h = SHA256_H0.slice();
    var w = new Array(64);

    for (var block = 0; block < padded.length; block += 64) {
      for (var t = 0; t < 16; t += 1) {
        var i = block + t * 4;
        w[t] = ((padded[i] << 24) | (padded[i + 1] << 16) | (padded[i + 2] << 8) | padded[i + 3]) >>> 0;
      }
      for (t = 16; t < 64; t += 1) {
        var w15 = w[t - 15];
        var w2 = w[t - 2];
        var s0 = (((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)) >>> 0;
        var s1 = (((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10)) >>> 0;
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }

      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];

      for (t = 0; t < 64; t += 1) {
        var s1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var temp1 = (hh + s1 + ch + SHA256_K[t] + w[t]) >>> 0;
        var s0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
        var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var temp2 = (s0 + maj) >>> 0;
        hh = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }

      h[0] = (h[0] + a) >>> 0;
      h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0;
      h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0;
      h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0;
      h[7] = (h[7] + hh) >>> 0;
    }

    return h;
  }

  /* Hex digest of a UTF-8 message. Deterministic across Node and browsers. */
  function sha256Hex(message) {
    var words = sha256Bytes(utf8Bytes(message));
    var hex = '';
    for (var i = 0; i < words.length; i += 1) {
      hex += ('0000000' + words[i].toString(16)).slice(-8);
    }
    return hex;
  }

  /* ------------------------------------------------------------------ */
  /* Canonical payload + cached digest-stamped report                    */
  /* ------------------------------------------------------------------ */

  function sanitizeNumber(value, digits) {
    var num = Number(value);
    if (!Number.isFinite(num)) return null;
    var d = digits === undefined ? 4 : digits;
    var p = Math.pow(10, d);
    var rounded = Math.round(num * p) / p;
    return Object.is(rounded, -0) ? 0 : rounded;
  }

  /*
   * Deterministic JSON: object keys are sorted recursively, arrays keep
   * order, non-finite numbers become null and -0 becomes 0. The same logical
   * payload always serializes byte identically, which is what makes the
   * unkeyed digest a meaningful tamper check.
   */
  function canonicalJson(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
      return JSON.stringify(value);
    }
    if (typeof value === 'number') {
      return JSON.stringify(sanitizeNumber(value, 10));
    }
    if (Array.isArray(value)) {
      return '[' + value.map(function (entry) { return canonicalJson(entry); }).join(',') + ']';
    }
    if (value && typeof value === 'object') {
      var keys = Object.keys(value).sort();
      var parts = [];
      for (var i = 0; i < keys.length; i += 1) {
        var entry = value[keys[i]];
        if (entry === undefined || typeof entry === 'function') continue;
        parts.push(JSON.stringify(keys[i]) + ':' + canonicalJson(entry));
      }
      return '{' + parts.join(',') + '}';
    }
    return 'null';
  }

  /*
   * Build the unsigned carbon-brief payload: inputs, the full 5x6 comparator
   * matrix, the slowdown frontier, the delay sweep, the greenest launch table
   * and the safety invariants. No wall-clock values are included, so the same
   * inputs always produce the same payload and the same digest.
   */
  function buildLabReportPayload(rawState) {
    var st = normalizeLabState(rawState);
    var matrix = compareAll(st);
    var frontier = sweepSlowdownFrontier(st.presetId, st);
    var delay = sweepDelay(st.presetId, st);
    var greenest = greenestLaunch(st.presetId, st);
    var preset = G.getPreset(st.presetId);
    return {
      schema: LAB_SCHEMA_VERSION,
      kind: 'greenrunner-carbon-brief',
      inputs: {
        presetId: st.presetId,
        presetName: preset ? preset.name : st.presetId,
        selectedPolicyId: st.policyId,
        regionId: st.regionId,
        startHourUtc: st.startHour,
        maxDelayHours: st.maxDelayHours,
        maxSlowdownPct: st.maxSlowdownPct
      },
      comparator: matrix.presets.map(function (row) {
        return {
          presetId: row.presetId,
          presetName: row.name,
          cells: row.cells.map(function (cell) {
            return {
              policyId: cell.policyId,
              policyName: cell.policyName,
              ok: cell.ok,
              totalWh: cell.totalWh,
              totalGco2: cell.totalGco2,
              savedWh: cell.savedWh,
              savedGco2: cell.savedGco2,
              whPct: cell.whPct,
              gco2Pct: cell.gco2Pct,
              maxJobSlowdownPct: cell.maxJobSlowdownPct,
              worstDelayHours: cell.worstDelayHours,
              criticalPathBeforeMin: cell.criticalPathBeforeMin,
              criticalPathAfterMin: cell.criticalPathAfterMin,
              movedJobs: cell.movedJobs,
              resizedJobs: cell.resizedJobs,
              schedules: cell.schedules,
              pinnedSafe: cell.pinnedSafe,
              pinnedViolations: cell.pinnedViolations,
              gatesCleared: cell.gatesCleared,
              gateViolations: cell.gateViolations,
              idempotent: cell.idempotent
            };
          })
        };
      }),
      slowdownFrontier: {
        presetId: frontier.presetId,
        budgets: frontier.budgets,
        perRegion: frontier.perRegion,
        frontier: frontier.frontier
      },
      delaySweep: {
        presetId: delay.presetId,
        regionId: delay.regionId,
        points: delay.points
      },
      greenestLaunch: greenest,
      invariants: {
        checkedCells: matrix.checkedCells,
        allPinnedProtected: matrix.allPinnedProtected,
        allIdempotent: matrix.allIdempotent,
        allGatesCleared: matrix.allGatesCleared,
        policies: LAB_POLICIES.map(function (p) { return p.id; }),
        presets: matrix.presets.map(function (p) { return p.presetId; })
      },
      disclosure:
        'All energy and carbon figures are deterministic estimates from the stated model (12 W per vCPU at full load, 30% idle floor, 0.3 W per GB of memory in use, PUE 1.2) on synthetic grid curves. They are not measurements of real runners or live grid telemetry.'
    };
  }

  var reportCache = new Map();
  var REPORT_CACHE_MAX = 16;

  function cacheKeyFor(rawState) {
    var st = normalizeLabState(rawState);
    return canonicalJson({
      p: st.presetId, o: st.policyId, r: st.regionId,
      d: st.maxDelayHours, s: st.maxSlowdownPct, h: st.startHour
    });
  }

  /*
   * The one canonical digest-stamped payload per input state. The on-page
   * fingerprint, the JSON export, the CSV provenance header and the Markdown
   * footer all read from this cached object, so they can never disagree
   * about the digest. The digest covers the canonical payload without the
   * integritySha256 field.
   */
  function getStampedReport(rawState) {
    var key = cacheKeyFor(rawState);
    var hit = reportCache.get(key);
    if (hit) return hit;
    var payload = buildLabReportPayload(rawState);
    var canonical = canonicalJson(payload);
    var digestHex = sha256Hex(canonical);
    var stamped = { payload: payload, digestHex: digestHex, canonical: canonical, cacheKey: key };
    if (reportCache.size >= REPORT_CACHE_MAX) {
      reportCache.delete(reportCache.keys().next().value);
    }
    reportCache.set(key, stamped);
    return stamped;
  }

  function payloadWithoutDigest(payload) {
    var copy = Object.create(null);
    Object.keys(payload || {}).forEach(function (k) {
      Object.defineProperty(copy, k, { value: payload[k], enumerable: true, writable: true, configurable: true });
    });
    delete copy.integritySha256;
    return copy;
  }

  /*
   * Recompute the digest over a payload (the integritySha256 field is
   * ignored) and compare it with the stamped value. Returns the expected and
   * actual digests plus the boolean verdict used by the verify control.
   */
  function verifyStampedReport(stampedOrPayload) {
    var payload = stampedOrPayload && stampedOrPayload.payload ? stampedOrPayload.payload : stampedOrPayload;
    var expected = stampedOrPayload && typeof stampedOrPayload.digestHex === 'string'
      ? stampedOrPayload.digestHex
      : (payload && typeof payload.integritySha256 === 'string' ? payload.integritySha256 : '');
    var actual = sha256Hex(canonicalJson(payloadWithoutDigest(payload)));
    return { ok: expected === actual && expected.length === 64, expected: expected, actual: actual };
  }

  /* ------------------------------------------------------------------ */
  /* Exporters: JSON, formula-safe CSV, Markdown                         */
  /* ------------------------------------------------------------------ */

  /*
   * Spreadsheet-safe CSV cell escaping. Cells starting with =, +, -, @, tab
   * or a line break are formula-injection vectors when opened in a
   * spreadsheet, so they are prefixed with a single quote before quoting.
   */
  function csvEscape(value) {
    var text = value === null || value === undefined ? '' : String(value);
    var lead = (/^[\s\p{Cf}\p{Cc}]*/u.exec(text) || [''])[0];
    var first = text.charAt(lead.length);
    var plainNumber = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.slice(lead.length));
    if (lead.length > 0 || (first !== '' && '=+-@'.indexOf(first) !== -1 && !(first === '-' && plainNumber))) {
      text = "'" + text;
    }
    if (/[",\n\r]/.test(text)) {
      text = '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  function exportReportJson(rawState) {
    var stamped = getStampedReport(rawState);
    var body = Object.assign({}, stamped.payload, { integritySha256: stamped.digestHex });
    return JSON.stringify(body, null, 2) + '\n';
  }

  function exportReportCsv(rawState) {
    var stamped = getStampedReport(rawState);
    var payload = stamped.payload;
    var inputs = payload.inputs;
    var lines = [
      '# greenrunner-carbon-brief ' + LAB_SCHEMA_VERSION,
      '# sha256:' + stamped.digestHex,
      '# inputs preset=' + inputs.presetId +
        ' policy=' + inputs.selectedPolicyId +
        ' region=' + inputs.regionId +
        ' start_hour_utc=' + inputs.startHourUtc +
        ' max_delay_h=' + inputs.maxDelayHours +
        ' max_slowdown_pct=' + inputs.maxSlowdownPct,
      '# values are deterministic model estimates on synthetic grid curves, not measurements',
      [
        'preset_id', 'policy_id', 'total_wh', 'total_gco2', 'saved_wh', 'saved_gco2',
        'wh_pct', 'gco2_pct', 'max_job_slowdown_pct', 'worst_delay_h',
        'critical_path_before_min', 'critical_path_after_min', 'moved_jobs',
        'resized_jobs', 'schedules', 'pinned_safe', 'gates_cleared', 'idempotent'
      ].map(csvEscape).join(',')
    ];
    payload.comparator.forEach(function (row) {
      row.cells.forEach(function (cell) {
        lines.push([
          row.presetId, cell.policyId, cell.totalWh, cell.totalGco2, cell.savedWh,
          cell.savedGco2, cell.whPct, cell.gco2Pct, cell.maxJobSlowdownPct,
          cell.worstDelayHours, cell.criticalPathBeforeMin, cell.criticalPathAfterMin,
          cell.movedJobs, cell.resizedJobs, cell.schedules,
          cell.pinnedSafe ? 'yes' : 'NO',
          cell.gatesCleared ? 'yes' : 'NO',
          cell.idempotent ? 'yes' : 'NO'
        ].map(csvEscape).join(','));
      });
    });
    return lines.join('\n') + '\n';
  }

  function mdCell(value) {
    return String(value).replace(/\|/g, '\\|');
  }

  function exportReportMarkdown(rawState) {
    var stamped = getStampedReport(rawState);
    var payload = stamped.payload;
    var inputs = payload.inputs;
    var lines = [];
    lines.push('# GreenRunner Carbon Brief');
    lines.push('');
    lines.push('Deterministic carbon-audit brief. Every figure below is an output of the');
    lines.push('stated energy model on synthetic grid curves, not a measurement of real');
    lines.push('runners or live grid telemetry.');
    lines.push('');
    lines.push('## Inputs');
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('| --- | --- |');
    lines.push('| Preset | ' + mdCell(inputs.presetId) + ' (' + mdCell(inputs.presetName) + ') |');
    lines.push('| Selected policy | ' + mdCell(inputs.selectedPolicyId) + ' |');
    lines.push('| Region | ' + mdCell(inputs.regionId) + ' |');
    lines.push('| Launch hour (UTC) | ' + mdCell(inputs.startHourUtc) + ':00 |');
    lines.push('| Max delay | ' + mdCell(inputs.maxDelayHours) + ' h |');
    lines.push('| Slowdown budget | ' + mdCell(inputs.maxSlowdownPct) + '% |');
    lines.push('');
    lines.push('## Policy comparator across all six presets');
    lines.push('');
    lines.push('| Preset | Policy | Wh | gCO2e | Saved Wh % | Saved CO2 % | Max job slowdown % | Jobs moved | Pinned | Idempotent |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    payload.comparator.forEach(function (row) {
      row.cells.forEach(function (cell) {
        lines.push('| ' + mdCell(row.presetId) +
          ' | ' + mdCell(cell.policyId) +
          ' | ' + mdCell(cell.totalWh) +
          ' | ' + mdCell(cell.totalGco2) +
          ' | ' + mdCell(cell.whPct) +
          ' | ' + mdCell(cell.gco2Pct) +
          ' | ' + mdCell(cell.maxJobSlowdownPct) +
          ' | ' + mdCell(cell.movedJobs) +
          ' | ' + mdCell(cell.pinnedSafe ? 'protected' : 'VIOLATION') +
          ' | ' + mdCell(cell.idempotent ? 'yes' : 'no') + ' |');
      });
    });
    lines.push('');
    lines.push('## Carbon saved vs slowdown budget (region plus time)');
    lines.push('');
    lines.push('| Budget % | Best saving % | Region |');
    lines.push('| --- | --- | --- |');
    payload.slowdownFrontier.frontier.forEach(function (p) {
      lines.push('| ' + mdCell(p.budgetPct) + ' | ' + mdCell(p.gco2Pct) + ' | ' + mdCell(p.regionId) + ' |');
    });
    lines.push('');
    lines.push('## Greenest launch hour per region');
    lines.push('');
    lines.push('| Region | Greenest UTC hour | gCO2e | Saving vs ' + mdCell(inputs.startHourUtc) + ':00 % |');
    lines.push('| --- | --- | --- | --- |');
    payload.greenestLaunch.forEach(function (g) {
      lines.push('| ' + mdCell(g.name) + ' (' + mdCell(g.regionId) + ') | ' + mdCell(('0' + g.hour).slice(-2) + ':00') + ' | ' + mdCell(g.gco2) + ' | ' + mdCell(g.savingPct) + ' |');
    });
    lines.push('');
    lines.push('## Integrity');
    lines.push('');
    lines.push('sha256:' + stamped.digestHex);
    lines.push('');
    lines.push('Digest covers the canonical payload with the integritySha256 field');
    lines.push('removed, object keys sorted, numbers rounded to the model precision.');
    lines.push('');
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /* Strict #gr= bookmark codec                                          */
  /* ------------------------------------------------------------------ */

  var HASH_KEY_ORDER = ['p', 'o', 'r', 'd', 's', 'h'];
  var HASH_KEY_ALLOWLIST = {};
  HASH_KEY_ORDER.forEach(function (k) { HASH_KEY_ALLOWLIST[k] = true; });
  var HASH_VALUE_PATTERN = /^[a-z0-9.-]+$/;
  var HASH_NUMBER_PATTERN = /^\d+(\.\d+)?$/;

  function hashBody(input) {
    var text = String(input == null ? '' : input);
    var idx = text.indexOf('gr=');
    if (idx === -1) return '';
    return text.slice(idx + 3).split(/[\s&#]/)[0];
  }

  /*
   * Encode lab bookmark state as a #gr= hash. Format is a fixed ordered
   * field list: v1|p=<preset>|o=<policy>|r=<region>|d=<delay>|s=<slowdown>|
   * h=<hour>. Only normalized, in-range values are emitted, so an encoded
   * hash always decodes.
   */
  function encodeLabHash(rawState) {
    var st = normalizeLabState(rawState);
    var fields = [
      'p=' + st.presetId,
      'o=' + st.policyId,
      'r=' + st.regionId,
      'd=' + st.maxDelayHours,
      's=' + st.maxSlowdownPct,
      'h=' + st.startHour
    ];
    return '#gr=' + HASH_SCHEMA_VERSION + '|' + fields.join('|');
  }

  /*
   * Decode a #gr= hash strictly. Returns null on any malformed input: wrong
   * version, missing or duplicated fields, unknown keys, prototype-pollution
   * key names, illegal characters, out-of-catalog ids or non-numeric values.
   * Valid numbers are normalized into range (clamped and rounded).
   */
  function decodeLabHash(input) {
    var body = hashBody(input);
    if (!body) return null;
    var parts = body.split('|');
    if (parts.length !== HASH_KEY_ORDER.length + 1) return null;
    if (parts[0] !== HASH_SCHEMA_VERSION) return null;

    var seen = {};
    for (var i = 1; i < parts.length; i += 1) {
      var part = parts[i];
      var eq = part.indexOf('=');
      if (eq <= 0) return null;
      var key = part.slice(0, eq);
      var value = part.slice(eq + 1);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return null;
      if (!HASH_KEY_ALLOWLIST[key]) return null;
      if (Object.prototype.hasOwnProperty.call(seen, key)) return null;
      if (!value || value.length > 64 || !HASH_VALUE_PATTERN.test(value)) return null;
      seen[key] = value;
    }
    for (i = 0; i < HASH_KEY_ORDER.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(seen, HASH_KEY_ORDER[i])) return null;
    }

    var preset = G.getPreset(seen.p);
    var policy = getPolicyById(seen.o);
    var region = null;
    for (i = 0; i < G.REGIONS.length; i += 1) {
      if (G.REGIONS[i].id === seen.r) { region = G.REGIONS[i]; break; }
    }
    if (!preset || !policy || !region) return null;
    if (!HASH_NUMBER_PATTERN.test(seen.d) || !HASH_NUMBER_PATTERN.test(seen.s) || !HASH_NUMBER_PATTERN.test(seen.h)) {
      return null;
    }

    return normalizeLabState({
      presetId: preset.id,
      policyId: policy.id,
      regionId: region.id,
      maxDelayHours: Number(seen.d),
      maxSlowdownPct: Number(seen.s),
      startHour: Number(seen.h)
    });
  }

  /* ------------------------------------------------------------------ */
  /* SVG and table renderers (deterministic string markup)               */
  /* ------------------------------------------------------------------ */

  function escapeXml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function pad2(n) { return ('0' + n).slice(-2); }

  /*
   * 24-hour carbon-intensity curves for all six regions, with a marker on
   * each region's greenest launch hour. Markers are keyboard focusable and
   * carry data-gr-region so a pointer or Enter key selects that region.
   */
  function renderCurvesSvg(rawState) {
    var st = normalizeLabState(rawState);
    var greenest = greenestLaunch(st.presetId, st);
    var width = 560, height = 300;
    var padL = 46, padR = 16, padT = 18, padB = 40;
    var plotW = width - padL - padR, plotH = height - padT - padB;
    var maxI = 0;
    G.REGIONS.forEach(function (r) {
      G.regionCurve(r.id).forEach(function (v) { if (v > maxI) maxI = v; });
    });
    var yMax = Math.ceil(maxI / 100) * 100;
    var xFor = function (hr) { return Math.round((padL + (hr / 24) * plotW) * 10) / 10; };
    var yFor = function (v) { return Math.round((padT + plotH - (v / yMax) * plotH) * 10) / 10; };

    var grid = '';
    for (var hr = 0; hr <= 24; hr += 4) {
      grid += '<line x1="' + xFor(hr) + '" y1="' + padT + '" x2="' + xFor(hr) + '" y2="' + (padT + plotH) + '" stroke="#1f4630" stroke-dasharray="3 3" stroke-width="1" />';
      grid += '<text x="' + xFor(hr) + '" y="' + (height - 22) + '" text-anchor="middle" fill="#8fb09b" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10">' + pad2(hr) + ':00</text>';
    }
    for (var gv = 0; gv <= yMax; gv += 100) {
      grid += '<line x1="' + padL + '" y1="' + yFor(gv) + '" x2="' + (width - padR) + '" y2="' + yFor(gv) + '" stroke="#1f4630" stroke-dasharray="3 3" stroke-width="1" />';
      grid += '<text x="' + (padL - 6) + '" y="' + (yFor(gv) + 3) + '" text-anchor="end" fill="#8fb09b" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10">' + gv + '</text>';
    }

    var curves = G.REGIONS.map(function (r) {
      var c = G.regionCurve(r.id);
      var pts = [];
      for (var i = 0; i <= 24; i += 1) pts.push(xFor(i) + ',' + yFor(c[i % 24]));
      var sel = r.id === st.regionId;
      return '<polyline fill="none" stroke="' + LAB_REGION_COLORS[r.id] + '" stroke-width="' + (sel ? 3.4 : 1.6) + '" stroke-linejoin="round" stroke-linecap="round" points="' + pts.join(' ') + '" />';
    }).join('\n');

    var startLine = '<line x1="' + xFor(st.startHour) + '" y1="' + padT + '" x2="' + xFor(st.startHour) + '" y2="' + (padT + plotH) + '" stroke="#fc6d26" stroke-dasharray="5 4" stroke-width="1.6" />' +
      '<text x="' + (xFor(st.startHour) + 5) + '" y="' + (padT + 12) + '" fill="#fc6d26" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10">launch ' + pad2(st.startHour) + ':00</text>';

    var markers = greenest.map(function (g) {
      var cx = xFor(g.hour), cy = yFor(G.intensityAt(g.regionId, g.hour));
      var color = LAB_REGION_COLORS[g.regionId] || '#8cf26b';
      var sel = g.regionId === st.regionId;
      return '<circle class="lab-svg-point" cx="' + cx + '" cy="' + cy + '" r="' + (sel ? 8 : 6) + '" fill="' + color + '" stroke="#06130d" stroke-width="1.5" tabindex="0" role="button" data-gr-region="' + escapeXml(g.regionId) + '" aria-label="Select ' + escapeXml(g.name) + ', greenest launch ' + pad2(g.hour) + ':00 UTC at ' + escapeXml(g.gco2) + ' gCO2e"><title>' + escapeXml(g.name) + ': greenest launch ' + pad2(g.hour) + ':00 UTC, ' + escapeXml(g.gco2) + ' gCO2e</title></circle>';
    }).join('\n');

    return '<svg class="lab-chart-svg" viewBox="0 0 ' + width + ' ' + height + '" role="group" aria-label="24-hour carbon intensity curves for six regions with greenest launch hour markers">' +
      grid + '\n' + curves + '\n' + startLine + '\n' + markers + '\n</svg>';
  }

  /*
   * Carbon-saved vs slowdown-budget Pareto frontier. Six faint region lines
   * sit under the bold best-of-regions frontier; frontier points are
   * keyboard focusable and name the winning region.
   */
  function renderParetoSvg(rawState) {
    var st = normalizeLabState(rawState);
    var sweep = sweepSlowdownFrontier(st.presetId, st);
    var width = 560, height = 300;
    var padL = 46, padR = 16, padT = 18, padB = 40;
    var plotW = width - padL - padR, plotH = height - padT - padB;
    var maxY = 0;
    sweep.perRegion.forEach(function (pr) {
      pr.points.forEach(function (p) { if (p.gco2Pct > maxY) maxY = p.gco2Pct; });
    });
    var yMax = Math.max(10, Math.ceil(maxY / 10) * 10);
    var xMax = SLOWDOWN_SWEEP_PCTS[SLOWDOWN_SWEEP_PCTS.length - 1];
    var xFor = function (v) { return Math.round((padL + (v / xMax) * plotW) * 10) / 10; };
    var yFor = function (v) { return Math.round((padT + plotH - (Math.min(yMax, Math.max(0, v)) / yMax) * plotH) * 10) / 10; };

    var grid = '';
    for (var gx = 0; gx <= xMax; gx += 10) {
      grid += '<line x1="' + xFor(gx) + '" y1="' + padT + '" x2="' + xFor(gx) + '" y2="' + (padT + plotH) + '" stroke="#1f4630" stroke-dasharray="3 3" stroke-width="1" />';
      grid += '<text x="' + xFor(gx) + '" y="' + (height - 22) + '" text-anchor="middle" fill="#8fb09b" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10">' + gx + '%</text>';
    }
    for (var gy = 0; gy <= yMax; gy += Math.max(5, Math.round(yMax / 5))) {
      grid += '<line x1="' + padL + '" y1="' + yFor(gy) + '" x2="' + (width - padR) + '" y2="' + yFor(gy) + '" stroke="#1f4630" stroke-dasharray="3 3" stroke-width="1" />';
      grid += '<text x="' + (padL - 6) + '" y="' + (yFor(gy) + 3) + '" text-anchor="end" fill="#8fb09b" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10">' + gy + '%</text>';
    }

    var regionLines = sweep.perRegion.map(function (pr) {
      var pts = pr.points.map(function (p) { return xFor(p.budgetPct) + ',' + yFor(p.gco2Pct); }).join(' ');
      return '<polyline fill="none" stroke="' + LAB_REGION_COLORS[pr.regionId] + '" stroke-width="1.4" stroke-opacity="0.55" stroke-linejoin="round" points="' + pts + '" />';
    }).join('\n');

    var frontierPts = sweep.frontier.map(function (p) { return xFor(p.budgetPct) + ',' + yFor(p.gco2Pct); }).join(' ');
    var markers = sweep.frontier.map(function (p) {
      var cx = xFor(p.budgetPct), cy = yFor(p.gco2Pct);
      var color = LAB_REGION_COLORS[p.regionId] || '#8cf26b';
      return '<circle class="lab-svg-point" cx="' + cx + '" cy="' + cy + '" r="6" fill="' + color + '" stroke="#06130d" stroke-width="1.5" tabindex="0" role="button" data-gr-frontier="' + p.budgetPct + '" data-gr-region="' + escapeXml(p.regionId) + '" aria-label="Slowdown budget ' + p.budgetPct + ' percent saves up to ' + escapeXml(p.gco2Pct) + ' percent carbon via ' + escapeXml(p.name) + '"><title>Budget ' + p.budgetPct + '%: up to ' + escapeXml(p.gco2Pct) + '% saved via ' + escapeXml(p.name) + '</title></circle>';
    }).join('\n');

    return '<svg class="lab-chart-svg" viewBox="0 0 ' + width + ' ' + height + '" role="group" aria-label="Pareto frontier of carbon saved percent against slowdown budget percent for six regions">' +
      grid + '\n' + regionLines + '\n<polyline fill="none" stroke="#e6f5ea" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round" points="' + frontierPts + '" />\n' + markers +
      '\n<text x="' + (padL + plotW / 2) + '" y="' + (height - 6) + '" text-anchor="middle" fill="#8fb09b" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10">max job slowdown budget %</text>\n</svg>';
  }

  /* Comparator table rows for the selected preset (5 policy cells). */
  function renderComparatorRowsHtml(rawState) {
    var st = normalizeLabState(rawState);
    var row = comparePoliciesForPreset(st.presetId, st);
    return row.cells.map(function (cell) {
      var selected = cell.policyId === st.policyId;
      var pinned = cell.pinnedSafe
        ? '<span class="pill moved lab-pill-ok">protected</span>'
        : '<span class="pill lab-pill-bad">VIOLATION</span>';
      var idem = cell.idempotent
        ? '<span class="pill moved lab-pill-ok">idempotent</span>'
        : '<span class="pill lab-pill-bad">not stable</span>';
      var gates = cell.gatesCleared
        ? '<span class="pill moved lab-pill-ok">clean</span>'
        : '<span class="pill lab-pill-bad">conflict</span>';
      return '<tr class="lab-policy-row' + (selected ? ' is-selected' : '') + '" data-policy-id="' + escapeXml(cell.policyId) + '">' +
        '<th scope="row">' + escapeXml(cell.policyName) + '</th>' +
        '<td class="num">' + cell.totalWh + '</td>' +
        '<td class="num">' + cell.totalGco2 + '</td>' +
        '<td class="num">' + cell.gco2Pct + '%</td>' +
        '<td class="num">' + cell.maxJobSlowdownPct + '%</td>' +
        '<td class="num">' + cell.movedJobs + ' moved, ' + cell.resizedJobs + ' resized</td>' +
        '<td>' + pinned + '</td><td>' + idem + '</td><td>' + gates + '</td></tr>';
    }).join('\n');
  }

  /* Carbon-saved % matrix: one row per preset, one cell per policy. */
  function renderPresetMatrixRowsHtml(rawState) {
    var st = normalizeLabState(rawState);
    var matrix = compareAll(st);
    return matrix.presets.map(function (row) {
      var cells = row.cells.map(function (cell) {
        var sel = cell.policyId === st.policyId;
        return '<td class="num' + (sel ? ' lab-cell-sel' : '') + '" data-gr-pick-policy="' + escapeXml(cell.policyId) + '" data-gr-pick-preset="' + escapeXml(row.presetId) + '">' + cell.gco2Pct + '</td>';
      }).join('');
      var selRow = row.presetId === st.presetId;
      return '<tr class="lab-preset-row' + (selRow ? ' is-selected' : '') + '" data-preset-id="' + escapeXml(row.presetId) + '"><th scope="row">' + escapeXml(row.name) + '</th>' + cells + '</tr>';
    }).join('\n');
  }

  /* Two-row delay sweep table: delay hours on top, saved % below. */
  function renderDelaySweepTableHtml(rawState) {
    var st = normalizeLabState(rawState);
    var sweep = sweepDelay(st.presetId, st);
    var head = sweep.points.map(function (p) { return '<td class="num">' + p.delayHours + '</td>'; }).join('');
    var vals = sweep.points.map(function (p) { return '<td class="num">' + p.gco2Pct + '</td>'; }).join('');
    return '<thead><tr><th scope="row">Max delay h</th>' + head + '</tr></thead><tbody><tr><th scope="row">Saved %</th>' + vals + '</tr></tbody>';
  }

  /* Greenest launch hour per region table rows. */
  function renderGreenestRowsHtml(rawState) {
    var st = normalizeLabState(rawState);
    return greenestLaunch(st.presetId, st).map(function (g) {
      var sel = g.regionId === st.regionId;
      var delta = g.savingPct > 0 ? g.savingPct + '% less' : 'already greenest';
      return '<tr class="lab-region-row' + (sel ? ' is-selected' : '') + '" data-region-id="' + escapeXml(g.regionId) + '">' +
        '<th scope="row">' + escapeXml(g.name) + ' <span class="lab-region-id">' + escapeXml(g.regionId) + '</span></th>' +
        '<td class="num">' + pad2(g.hour) + ':00</td>' +
        '<td class="num">' + g.gco2 + '</td>' +
        '<td class="num">' + delta + '</td></tr>';
    }).join('\n');
  }

  /* Options markup for the preset and region selects. */
  function renderPresetOptionsHtml() {
    return G.PRESETS.map(function (p) { return '<option value="' + escapeXml(p.id) + '">' + escapeXml(p.name) + '</option>'; }).join('');
  }

  function renderRegionOptionsHtml() {
    return G.REGIONS.map(function (r) { return '<option value="' + escapeXml(r.id) + '">' + escapeXml(r.id + ' (' + r.name + ')') + '</option>'; }).join('');
  }

  /* ------------------------------------------------------------------ */
  /* Deterministic in-page self-tests                                    */
  /* ------------------------------------------------------------------ */

  function selfTest(name, fn) {
    try {
      var detail = fn();
      return { name: name, pass: true, detail: typeof detail === 'string' ? detail : 'ok' };
    } catch (error) {
      return { name: name, pass: false, detail: String(error && error.message ? error.message : error) };
    }
  }

  function expect(condition, message) {
    if (!condition) throw new Error(message);
    return message;
  }

  function runLabSelfTests(rawState) {
    var st = normalizeLabState(rawState);
    var results = [];

    results.push(selfTest('SHA-256 empty-string KAT', function () {
      return expect(sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'empty message digest matches FIPS 180-4');
    }));

    results.push(selfTest('SHA-256 abc KAT', function () {
      return expect(sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        'abc digest matches FIPS 180-4');
    }));

    results.push(selfTest('SHA-256 448-bit boundary KAT', function () {
      return expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq') ===
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
        '56-byte message digest matches FIPS 180-4');
    }));

    results.push(selfTest('SHA-256 multi-block KAT', function () {
      return expect(sha256Hex('The quick brown fox jumps over the lazy dog') ===
        'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
        'quick-brown-fox digest matches FIPS 180-4');
    }));

    results.push(selfTest('Pinned jobs are never deferred across all 30 cells', function () {
      var matrix = compareAll(st);
      expect(matrix.checkedCells === 30, '30 policy-preset cells evaluated');
      return expect(matrix.allPinnedProtected === true, 'deploy, release and needs-pinned jobs never move');
    }));

    results.push(selfTest('Transitive needs pin survives a two-hop chain', function () {
      var yaml = 'stages: [build, test, fuzz]\n' +
        'ship:\n  stage: build\n  script: make\n  needs: [dast-mid]\n' +
        'dast-mid:\n  stage: test\n  script: scan\n  needs: [fuzz-x]\n' +
        'fuzz-x:\n  stage: fuzz\n  script: fuzz\n';
      var run = G.runGreenAgent(yaml, {
        ship: { durationMin: 4, peakRssMb: 500, avgCpuPct: 30, peakCpuPct: 50 },
        'dast-mid': { durationMin: 10, peakRssMb: 1000, avgCpuPct: 40, peakCpuPct: 60 },
        'fuzz-x': { durationMin: 20, peakRssMb: 2000, avgCpuPct: 50, peakCpuPct: 80 }
      }, { minGainPct: 0, allowRegionShift: true });
      expect(run.ok === true, 'hostile-chain run parses');
      expect(run.deferred['fuzz-x'] === undefined && run.deferred['dast-mid'] === undefined,
        'both hops stay pinned');
      return 'transitive pin held';
    }));

    results.push(selfTest('Second-pass YAML patch is idempotent on shifted jobs', function () {
      var cell = runPolicyCell('node-webapp', 'region-plus-time', st);
      return expect(cell.idempotent === true && cell.movedJobs >= 1,
        're-running the agent on its own patch changes nothing');
    }));

    results.push(selfTest('Patched jobs never mix rules with only or except', function () {
      var matrix = compareAll(st);
      return expect(matrix.allGatesCleared === true, 'every patched job is gates-clean');
    }));

    results.push(selfTest('Right-sizing honors 20% CPU and 30% memory headroom', function () {
      var r = G.rightsize('saas-linux-xlarge-amd64', { durationMin: 5, peakRssMb: 19000, avgCpuPct: 5, peakCpuPct: 10, estimated: false });
      expect(r.change === true && r.to === 'saas-linux-large-amd64', 'memory peak picks the 32 GB tag');
      var cpu = G.rightsize('saas-linux-2xlarge-amd64', { durationMin: 5, peakRssMb: 1000, avgCpuPct: 55, peakCpuPct: 92, estimated: false });
      expect(cpu.change === true && cpu.to === 'saas-linux-2xlarge-amd64' || cpu.change === false,
        'CPU peak inside one halving stays on the big tag');
      var tight = G.rightsize('saas-linux-large-amd64', { durationMin: 5, peakRssMb: 9000, avgCpuPct: 20, peakCpuPct: 30, estimated: false });
      return expect(tight.change === true && tight.needMemMb === Math.round(9000 * G.MODEL.memHeadroom),
        'memory need equals peak times 1.3 headroom');
    }));

    results.push(selfTest('YAML anchors, aliases and merge keys fail closed', function () {
      var hostiles = ['a: &x 1\n', 'a: *x\n', '<<: base\n', 'a:\n  <<: *x\n'];
      hostiles.forEach(function (y) {
        var threw = false;
        try { G.parseYaml(y); } catch (e) { threw = true; }
        if (!threw) throw new Error('accepted ' + JSON.stringify(y));
      });
      return hostiles.length + ' hostile YAML shapes rejected';
    }));

    results.push(selfTest('Energy model applies PUE 1.2 exactly', function () {
      var tag = 'saas-linux-small-amd64';
      var r = G.RUNNERS[tag];
      var tel = { durationMin: 60, peakRssMb: 4096, avgCpuPct: 50, peakCpuPct: 80 };
      var watts = r.idleW + (r.tdpW - r.idleW) * 0.5 + G.MODEL.memWattsPerGb * r.memGb * 0.5;
      var expected = watts * (60 / 60) * G.MODEL.pue;
      return expect(Math.abs(G.jobEnergyWh(tag, tel) - expected) < 1e-9,
        'watts x hours x 1.2 PUE to the last ulp');
    }));

    results.push(selfTest('CSV formula escaping blocks spreadsheet injection', function () {
      var hostile = csvEscape('=CMD()');
      var plus = csvEscape('+1-202-555-0100');
      var at = csvEscape('@SUM(1)');
      var tab = csvEscape('\tcmd');
      expect(hostile.charAt(0) === "'" && plus.charAt(0) === "'" && at.charAt(0) === "'" && tab.charAt(0) === "'",
        'formula prefixes get a quote');
      return expect(csvEscape('plain, "text"') === '"plain, ""text"""', 'commas and quotes escape cleanly');
    }));

    results.push(selfTest('Tamper detection flips the verify verdict', function () {
      var stamped = getStampedReport(st);
      var before = verifyStampedReport(stamped);
      var tampered = Object.assign({}, stamped.payload, {
        inputs: Object.assign({}, stamped.payload.inputs, {
          maxSlowdownPct: stamped.payload.inputs.maxSlowdownPct === 50 ? 49 : 50
        })
      });
      var after = verifyStampedReport({ payload: tampered, digestHex: stamped.digestHex });
      expect(before.ok === true, 'untouched payload verifies');
      return expect(after.ok === false && after.actual !== stamped.digestHex, 'mutated payload is detected');
    }));

    results.push(selfTest('One digest across page line, JSON, CSV and Markdown', function () {
      var stamped = getStampedReport(st);
      var json = exportReportJson(st);
      var csv = exportReportCsv(st);
      var md = exportReportMarkdown(st);
      expect(json.indexOf(stamped.digestHex) !== -1, 'JSON carries the digest');
      expect(csv.indexOf('# sha256:' + stamped.digestHex) !== -1, 'CSV header carries the digest');
      return expect(md.indexOf('sha256:' + stamped.digestHex) !== -1, 'Markdown footer carries the digest');
    }));

    results.push(selfTest('#gr= bookmark round-trips every field', function () {
      var state = { presetId: 'python-ml', policyId: 'region-plus-time', regionId: 'europe-north1', maxDelayHours: 8, maxSlowdownPct: 25, startHour: 3 };
      var decoded = decodeLabHash(encodeLabHash(state));
      expect(decoded && decoded.presetId === 'python-ml', 'preset restored');
      expect(decoded.policyId === 'region-plus-time', 'policy restored');
      expect(decoded.regionId === 'europe-north1', 'region restored');
      expect(decoded.maxDelayHours === 8, 'delay restored');
      expect(decoded.maxSlowdownPct === 25, 'slowdown restored');
      return expect(decoded.startHour === 3, 'hour restored');
    }));

    results.push(selfTest('#gr= decode fails closed on hostile input', function () {
      var hostile = [
        '#gr=', '#gr=v2|p=node-webapp|o=baseline|r=us-central1|d=4|s=15|h=19',
        '#gr=v1|p=__proto__|o=baseline|r=us-central1|d=4|s=15|h=19',
        '#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=4|s=15|h=19|x=1',
        '#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=4|s=15',
        '#gr=v1|p=<script>|o=baseline|r=us-central1|d=4|s=15|h=19',
        '#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=abc|s=15|h=19',
        '#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=4|s=15|h=19|',
        '#gr=v1|p=node-webapp|o=baseline|r=us-central1|d=4|s=-15|h=19',
        '#gr=v1|p=node-webapp|p=python-ml|o=baseline|r=us-central1|d=4|s=15|h=19',
        '#gr=v1|constructor=x|o=baseline|r=us-central1|d=4|s=15|h=19'
      ];
      hostile.forEach(function (h) {
        if (decodeLabHash(h) !== null) throw new Error('accepted hostile hash ' + h);
      });
      return hostile.length + ' hostile hashes rejected';
    }));

    results.push(selfTest('Comparator matrix is deterministic', function () {
      var a = compareAll(st);
      var b = compareAll(st);
      return expect(JSON.stringify(a) === JSON.stringify(b), 'identical matrix on repeat evaluation');
    }));

    results.push(selfTest('Slowdown frontier never decreases as budget grows', function () {
      var sweep = sweepSlowdownFrontier(st.presetId, st);
      for (var i = 1; i < sweep.frontier.length; i += 1) {
        if (sweep.frontier[i].gco2Pct < sweep.frontier[i - 1].gco2Pct - 1e-9) {
          throw new Error('frontier regresses between ' + sweep.frontier[i - 1].budgetPct + '% and ' + sweep.frontier[i].budgetPct + '%');
        }
      }
      return 'monotone across ' + sweep.frontier.length + ' budgets';
    }));

    results.push(selfTest('Delay sweep never decreases as the window grows', function () {
      var sweep = sweepDelay(st.presetId, st);
      for (var i = 1; i < sweep.points.length; i += 1) {
        if (sweep.points[i].gco2Pct < sweep.points[i - 1].gco2Pct - 1e-9) {
          throw new Error('delay sweep regresses between ' + sweep.points[i - 1].delayHours + 'h and ' + sweep.points[i].delayHours + 'h');
        }
      }
      return 'monotone across ' + sweep.points.length + ' windows';
    }));

    results.push(selfTest('Greenest launch hour ties or beats the lab launch hour', function () {
      var greenest = greenestLaunch(st.presetId, st);
      greenest.forEach(function (g) {
        if (g.gco2 > g.gco2AtStart + 1e-9) throw new Error(g.regionId + ' greenest hour is worse than the current hour');
      });
      return 'all 6 regions checked';
    }));

    results.push(selfTest('Exported JSON parses and restamps the same digest', function () {
      var stamped = getStampedReport(st);
      var parsed = JSON.parse(exportReportJson(st));
      expect(parsed.integritySha256 === stamped.digestHex, 'exported digest equals stamped digest');
      return expect(verifyStampedReport(parsed).ok === true, 'exported payload verifies on its own');
    }));

    results.push(selfTest('Every preset is reachable in the matrix and codec', function () {
      var matrix = compareAll(st);
      expect(matrix.presets.length === G.PRESETS.length, 'matrix covers all presets');
      G.PRESETS.forEach(function (p) {
        var decoded = decodeLabHash(encodeLabHash({ presetId: p.id }));
        if (!decoded || decoded.presetId !== p.id) throw new Error('preset ' + p.id + ' failed codec round-trip');
      });
      return G.PRESETS.length + ' presets round-trip';
    }));

    return results;
  }

  /* ------------------------------------------------------------------ */

  var api = {
    LAB_SCHEMA_VERSION: LAB_SCHEMA_VERSION,
    HASH_SCHEMA_VERSION: HASH_SCHEMA_VERSION,
    SLOWDOWN_SWEEP_PCTS: SLOWDOWN_SWEEP_PCTS,
    DELAY_SWEEP_HOURS: DELAY_SWEEP_HOURS,
    LAB_POLICIES: LAB_POLICIES,
    LAB_REGION_COLORS: LAB_REGION_COLORS,
    getPolicyById: getPolicyById,
    normalizeLabState: normalizeLabState,
    engineOptionsFor: engineOptionsFor,
    evaluatePolicyCell: evaluatePolicyCell,
    runPolicyCell: runPolicyCell,
    compareAll: compareAll,
    comparePoliciesForPreset: comparePoliciesForPreset,
    sweepSlowdownFrontier: sweepSlowdownFrontier,
    sweepDelay: sweepDelay,
    greenestLaunch: greenestLaunch,
    sha256Hex: sha256Hex,
    canonicalJson: canonicalJson,
    buildLabReportPayload: buildLabReportPayload,
    getStampedReport: getStampedReport,
    verifyStampedReport: verifyStampedReport,
    csvEscape: csvEscape,
    exportReportJson: exportReportJson,
    exportReportCsv: exportReportCsv,
    exportReportMarkdown: exportReportMarkdown,
    encodeLabHash: encodeLabHash,
    decodeLabHash: decodeLabHash,
    renderComparatorRowsHtml: renderComparatorRowsHtml,
    renderPresetMatrixRowsHtml: renderPresetMatrixRowsHtml,
    renderCurvesSvg: renderCurvesSvg,
    renderParetoSvg: renderParetoSvg,
    renderDelaySweepTableHtml: renderDelaySweepTableHtml,
    renderGreenestRowsHtml: renderGreenestRowsHtml,
    renderPresetOptionsHtml: renderPresetOptionsHtml,
    renderRegionOptionsHtml: renderRegionOptionsHtml,
    runLabSelfTests: runLabSelfTests,
    escapeXml: escapeXml
  };

  if (!G) {
    Object.keys(api).forEach(function (k) {
      if (typeof api[k] === 'function') {
        api[k] = function () { throw new Error('engine.js is required before carbon-lab.js'); };
      }
    });
  }

  return api;
}));
