/*
 * GreenRunner engine: a small YAML subset parser and writer for .gitlab-ci.yml, a pipeline
 * energy and carbon simulator, and a hands-off agent that shifts deferrable jobs into
 * low-carbon windows or regions and right-sizes over-provisioned runner tags.
 * Zero dependencies. UMD: require() in Node, window.GreenRunner in a browser.
 *
 * Every number the model produces is an estimate from stated assumptions (see MODEL and
 * REGIONS). It is not a measurement of any real runner or grid.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GreenRunner = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function round(n, d) {
    var p = Math.pow(10, d === undefined ? 3 : d);
    return Math.round(n * p) / p;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------- YAML subset: parse ---------- */
  // Supported: block maps, block lists, lists of maps, inline [a, b] and {a: b}, quoted strings,
  // numbers, booleans, null, literal block scalars (| and >), comments. Not supported: anchors,
  // aliases, merge keys, multi-document files, flow collections that span lines, tabs.

  function stripComment(line) {
    var inS = false, inD = false;
    for (var i = 0; i < line.length; i += 1) {
      var c = line[i];
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
    }
    return line;
  }

  function splitTop(s) {
    var parts = [], cur = '', depth = 0, inS = false, inD = false;
    for (var i = 0; i < s.length; i += 1) {
      var c = s[i];
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      else if (!inS && !inD && (c === '[' || c === '{')) depth += 1;
      else if (!inS && !inD && (c === ']' || c === '}')) depth -= 1;
      if (c === ',' && depth === 0 && !inS && !inD) { parts.push(cur); cur = ''; } else cur += c;
    }
    if (cur.trim() !== '') parts.push(cur);
    return parts;
  }

  function unquote(s) {
    if (s[0] === '"') {
      return s.slice(1, -1).replace(/\\(["\\nt])/g, function (m, c) { return c === 'n' ? '\n' : (c === 't' ? '\t' : c); });
    }
    return s.slice(1, -1).replace(/''/g, "'");
  }

  function parseScalar(raw) {
    var s = raw.trim();
    if (s === '') return null;
    var first = s[0], last = s[s.length - 1];
    if ((first === '"' && last === '"' && s.length > 1) || (first === "'" && last === "'" && s.length > 1)) return unquote(s);
    if (first === '[' && last === ']') return splitTop(s.slice(1, -1)).map(parseScalar);
    if (first === '{' && last === '}') {
      var o = {};
      splitTop(s.slice(1, -1)).forEach(function (p) {
        var kv = splitKey(p.trim());
        if (!kv) throw new Error('bad inline map entry: ' + p.trim());
        o[kv.key] = parseScalar(kv.rest);
      });
      return o;
    }
    if (/^[&*][\w-]/.test(s) || s.indexOf('<<') === 0) throw new Error('unsupported YAML feature (anchor, alias or merge key): ' + s);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null' || s === '~') return null;
    if (/^-?\d+(\.\d+)?$/.test(s) && String(Number(s)) === s) return Number(s);
    return s;
  }

  function splitKey(text) {
    var inS = false, inD = false;
    for (var i = 0; i < text.length; i += 1) {
      var c = text[i];
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      else if (c === ':' && !inS && !inD && (i === text.length - 1 || text[i + 1] === ' ')) {
        var k = text.slice(0, i).trim();
        if (!k) return null;
        if ((k[0] === '"' || k[0] === "'") && k.length > 1) k = unquote(k);
        return { key: k, rest: text.slice(i + 1).trim() };
      }
    }
    return null;
  }

  function parseYaml(text) {
    var raw = String(text).replace(/\r\n/g, '\n').split('\n');
    var lines = [];
    raw.forEach(function (line, i) {
      var lead = line.match(/^\s*/)[0];
      if (lead.indexOf('\t') !== -1) { if (line.trim() && line.trim()[0] !== '#') throw new Error('tabs are not allowed (line ' + (i + 1) + ')'); }
      var s = stripComment(line);
      if (!s.trim()) return;
      lines.push({ indent: s.match(/^ */)[0].length, text: s.trim(), no: i + 1 });
    });
    if (!lines.length) return {};
    var pos = 0;
    var n = lines.length;

    function isItem(l) { return l.text === '-' || l.text.indexOf('- ') === 0; }

    function block(parentIndent, style) {
      var out = [];
      while (pos < n && lines[pos].indent > parentIndent) { out.push(lines[pos].text); pos += 1; }
      return style === '>' ? out.join(' ') : out.join('\n');
    }

    function parseNode(indent) { return isItem(lines[pos]) ? parseList(indent) : parseMap(indent); }

    function parseMap(indent) {
      var obj = {};
      while (pos < n && lines[pos].indent === indent && !isItem(lines[pos])) {
        var l = lines[pos];
        var kv = splitKey(l.text);
        if (!kv) throw new Error('expected "key: value" at line ' + l.no + ': ' + l.text);
        if (kv.key === '<<') throw new Error('unsupported YAML feature (merge key) at line ' + l.no);
        pos += 1;
        if (kv.rest === '') {
          var nx = lines[pos];
          if (nx && nx.indent > indent) obj[kv.key] = parseNode(nx.indent);
          else if (nx && nx.indent === indent && isItem(nx)) obj[kv.key] = parseList(indent);
          else obj[kv.key] = null;
        } else if (kv.rest === '|' || kv.rest === '>') {
          obj[kv.key] = block(indent, kv.rest);
        } else {
          obj[kv.key] = parseScalar(kv.rest);
        }
      }
      if (pos < n && lines[pos].indent > indent) throw new Error('unexpected indentation at line ' + lines[pos].no);
      return obj;
    }

    function parseList(indent) {
      var arr = [];
      while (pos < n && lines[pos].indent === indent && isItem(lines[pos])) {
        var l = lines[pos];
        var rest = l.text.slice(1).trim();
        var offset = l.text.length - l.text.slice(1).replace(/^\s+/, '').length;
        if (rest === '') {
          pos += 1;
          var nx = lines[pos];
          arr.push(nx && nx.indent > indent ? parseNode(nx.indent) : null);
        } else if (rest === '|' || rest === '>') {
          pos += 1;
          arr.push(block(indent, rest));
        } else if (/^([A-Za-z_$][\w.$\/-]*|"[^"]*"|'[^']*'):(\s|$)/.test(rest)) {
          lines[pos] = { indent: indent + offset, text: rest, no: l.no };
          arr.push(parseMap(indent + offset));
        } else {
          arr.push(parseScalar(rest));
          pos += 1;
        }
      }
      return arr;
    }

    var result = parseNode(lines[0].indent);
    if (pos < n) throw new Error('unexpected content at line ' + lines[pos].no + ': ' + lines[pos].text);
    return result;
  }

  /* ---------- YAML subset: dump ---------- */

  function needsQuote(s) {
    return s === '' || /^\s|\s$/.test(s) || /^[-?:,\[\]{}#&*!|>'"%@`]/.test(s) || /: |:$| #/.test(s) ||
      /^(true|false|null|~|yes|no|on|off)$/i.test(s) || /^-?\d+(\.\d+)?$/.test(s);
  }

  function dumpScalar(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    var s = String(v);
    if (needsQuote(s)) return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
    return s;
  }

  function dumpKey(k) { return /^[A-Za-z_.$][\w.$\/-]*$/.test(k) ? k : '"' + k.replace(/"/g, '\\"') + '"'; }

  function dumpMapLines(obj, indent) {
    var pad = new Array(indent + 1).join(' ');
    var out = [];
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      var key = pad + dumpKey(k) + ':';
      if (Array.isArray(v)) {
        if (!v.length) out.push(key + ' []');
        else { out.push(key); dumpListLines(v, indent + 2).forEach(function (l) { out.push(l); }); }
      } else if (v && typeof v === 'object') {
        if (!Object.keys(v).length) out.push(key + ' {}');
        else { out.push(key); dumpMapLines(v, indent + 2).forEach(function (l) { out.push(l); }); }
      } else if (typeof v === 'string' && v.indexOf('\n') !== -1) {
        out.push(key + ' |');
        v.split('\n').forEach(function (l) { out.push(pad + '  ' + l); });
      } else out.push(key + ' ' + dumpScalar(v));
    });
    return out;
  }

  function dumpListLines(arr, indent) {
    var pad = new Array(indent + 1).join(' ');
    var out = [];
    arr.forEach(function (item) {
      if (Array.isArray(item)) throw new Error('nested lists are not supported by the writer');
      if (item && typeof item === 'object') {
        var inner = dumpMapLines(item, indent + 2);
        if (!inner.length) out.push(pad + '- {}');
        else { inner[0] = pad + '- ' + inner[0].slice(indent + 2); inner.forEach(function (l) { out.push(l); }); }
      } else if (typeof item === 'string' && item.indexOf('\n') !== -1) {
        out.push(pad + '- |');
        item.split('\n').forEach(function (l) { out.push(pad + '  ' + l); });
      } else out.push(pad + '- ' + dumpScalar(item));
    });
    return out;
  }

  function dumpYaml(obj) { return dumpMapLines(obj, 0).join('\n') + '\n'; }

  /* ---------- GitLab CI model ---------- */

  var RESERVED = ['stages', 'variables', 'default', 'include', 'workflow', 'image', 'services', 'cache', 'before_script', 'after_script'];
  var DEFAULT_STAGES = ['.pre', 'build', 'test', 'deploy', '.post'];

  // Machine sizes as listed in GitLab's hosted runner documentation. The watt figures are assumptions.
  var MODEL = { wattsPerVcpu: 12, idleFraction: 0.3, memWattsPerGb: 0.3, pue: 1.2, cpuHeadroom: 1.2, memHeadroom: 1.3, slowdownPerHalving: 0.03 };
  var RUNNERS = {
    'saas-linux-small-amd64': { vcpu: 2, memGb: 8, rank: 0 },
    'saas-linux-medium-amd64': { vcpu: 4, memGb: 16, rank: 1 },
    'saas-linux-large-amd64': { vcpu: 8, memGb: 32, rank: 2 },
    'saas-linux-xlarge-amd64': { vcpu: 16, memGb: 64, rank: 3 },
    'saas-linux-2xlarge-amd64': { vcpu: 32, memGb: 128, rank: 4 }
  };
  var RUNNER_ORDER = Object.keys(RUNNERS).sort(function (a, b) { return RUNNERS[a].rank - RUNNERS[b].rank; });
  Object.keys(RUNNERS).forEach(function (t) {
    var r = RUNNERS[t];
    r.tdpW = r.vcpu * MODEL.wattsPerVcpu;
    r.idleW = r.tdpW * MODEL.idleFraction;
  });
  var DEFAULT_TAG = 'saas-linux-small-amd64';

  var DEFER_TOKENS = ['fuzz', 'container_scanning', 'dast', 'benchmark', 'pages-nightly'];

  function parseGitlabCI(text) {
    var doc = parseYaml(text);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('a .gitlab-ci.yml must be a mapping at the top level');
    return doc;
  }

  function jobsOf(doc) {
    return Object.keys(doc).filter(function (k) {
      return RESERVED.indexOf(k) === -1 && k[0] !== '.' && doc[k] && typeof doc[k] === 'object' && !Array.isArray(doc[k]);
    });
  }

  function stageOrder(doc) { return Array.isArray(doc.stages) && doc.stages.length ? doc.stages.slice() : DEFAULT_STAGES.slice(); }
  function stageOf(job) { return (job && job.stage) || 'test'; }

  function runnerTagOf(job) {
    var tags = Array.isArray(job.tags) ? job.tags : [];
    for (var i = 0; i < tags.length; i += 1) {
      if (RUNNERS[tags[i]]) return tags[i];
      var m = /^green-.+-(small|medium|large|xlarge|2xlarge)$/.exec(tags[i]);
      if (m && RUNNERS['saas-linux-' + m[1] + '-amd64']) return 'saas-linux-' + m[1] + '-amd64';
    }
    return DEFAULT_TAG;
  }

  function normToken(s) { return String(s).toLowerCase().replace(/[-_\s]+/g, '_'); }

  function matchesDeferToken(s) {
    var n = normToken(s);
    return DEFER_TOKENS.some(function (t) { return n.indexOf(normToken(t)) !== -1; });
  }

  function classify(doc) {
    var jobs = jobsOf(doc);
    var result = {};
    jobs.forEach(function (name) {
      var j = doc[name];
      var stage = stageOf(j);
      var deferrable = matchesDeferToken(name) || matchesDeferToken(stage);
      var reason = deferrable ? 'name or stage matches a deferrable lifecycle step' : 'critical path';
      if (/deploy|release/i.test(name) || /deploy|release/i.test(stage)) { deferrable = false; reason = 'deploy and release jobs stay on the critical path'; }
      result[name] = { deferrable: deferrable, reason: reason, stage: stage };
    });
    // a job that another non-deferrable job needs cannot move out of the pipeline
    jobs.forEach(function (name) {
      var needs = doc[name].needs;
      if (!Array.isArray(needs)) return;
      needs.forEach(function (n) {
        var target = typeof n === 'string' ? n : (n && n.job);
        if (target && result[target] && result[target].deferrable && !result[name].deferrable) {
          result[target].deferrable = false;
          result[target].reason = 'required by ' + name + ' through needs';
        }
      });
    });
    return result;
  }

  /* ---------- grid carbon intensity (illustrative curves) ---------- */

  var REGIONS = [
    { id: 'us-central1', name: 'Iowa', base: 400, amp: 0.2, peakHour: 17, utcOffset: -5, solar: 0.03 },
    { id: 'europe-north1', name: 'Finland', base: 70, amp: 0.12, peakHour: 17, utcOffset: 2, solar: 0.05 },
    { id: 'us-west1', name: 'Oregon', base: 150, amp: 0.3, peakHour: 20, utcOffset: -7, solar: 0.18 },
    { id: 'europe-west4', name: 'Netherlands', base: 340, amp: 0.22, peakHour: 18, utcOffset: 1, solar: 0.14 },
    { id: 'asia-southeast1', name: 'Singapore', base: 470, amp: 0.08, peakHour: 19, utcOffset: 8, solar: 0.03 },
    { id: 'southamerica-east1', name: 'Sao Paulo', base: 100, amp: 0.28, peakHour: 20, utcOffset: -3, solar: 0.08 }
  ];
  var REGION_INDEX = {};
  var CURVES = {};
  REGIONS.forEach(function (r) {
    REGION_INDEX[r.id] = r;
    var rng = mulberry32(hashString(r.id));
    var arr = [];
    for (var h = 0; h < 24; h += 1) {
      var local = ((h + r.utcOffset) % 24 + 24) % 24;
      var evening = 1 + r.amp * Math.cos(2 * Math.PI * (local - r.peakHour) / 24);
      var solarDip = 1 - r.solar * 2 * Math.exp(-Math.pow((local - 13) / 3, 2));
      var noise = 1 + (rng() - 0.5) * 0.04;
      arr.push(round(r.base * evening * solarDip * noise, 1));
    }
    CURVES[r.id] = arr;
  });

  function regionCurve(id) { return CURVES[id] ? CURVES[id].slice() : null; }

  function intensityAt(regionId, tHours) {
    var c = CURVES[regionId];
    if (!c) throw new Error('unknown region ' + regionId);
    var t = ((tHours % 24) + 24) % 24;
    var i = Math.floor(t), f = t - i;
    return c[i] * (1 - f) + c[(i + 1) % 24] * f;
  }

  function avgIntensity(regionId, startHour, durMin) {
    var steps = Math.max(1, Math.round(durMin));
    var sum = 0;
    for (var s = 0; s < steps; s += 1) sum += intensityAt(regionId, startHour + (s + 0.5) / 60);
    return sum / steps;
  }

  /* ---------- energy model ---------- */

  function defaultTelemetry(tag) {
    var r = RUNNERS[tag];
    return { durationMin: 5, peakRssMb: Math.round(r.memGb * 1024 * 0.4), avgCpuPct: 50, peakCpuPct: 80, estimated: true };
  }

  function normalizeTelemetry(doc, input) {
    var out = {};
    var src = input || {};
    jobsOf(doc).forEach(function (name) {
      var tag = runnerTagOf(doc[name]);
      var t = src[name];
      if (t && typeof t === 'object') {
        out[name] = {
          durationMin: Number(t.durationMin) || 1,
          peakRssMb: Number(t.peakRssMb) || 0,
          avgCpuPct: Math.min(100, Math.max(0, Number(t.avgCpuPct) || 0)),
          peakCpuPct: Math.min(100, Math.max(0, Number(t.peakCpuPct) || Number(t.avgCpuPct) || 0)),
          estimated: false
        };
      } else out[name] = defaultTelemetry(tag);
    });
    return out;
  }

  function jobEnergyWh(tag, tel) {
    var r = RUNNERS[tag];
    var cpu = tel.avgCpuPct / 100;
    var memUtil = Math.min(1, tel.peakRssMb / (r.memGb * 1024));
    var watts = r.idleW + (r.tdpW - r.idleW) * cpu + MODEL.memWattsPerGb * r.memGb * memUtil;
    return watts * (tel.durationMin / 60) * MODEL.pue;
  }

  function simulatePipeline(doc, telemetry, opts) {
    var o = opts || {};
    var region = o.region || 'us-central1';
    var startHour = o.startHour === undefined ? 19 : o.startHour;
    var deferred = o.deferred || {};
    var stages = stageOrder(doc);
    var jobs = jobsOf(doc);
    var rows = [];
    var cursorMin = 0;
    stages.forEach(function (stage) {
      var inStage = jobs.filter(function (j) { return stageOf(doc[j]) === stage && !deferred[j]; });
      var stageDur = 0;
      inStage.forEach(function (name) {
        var tag = runnerTagOf(doc[name]);
        var tel = telemetry[name];
        var wh = jobEnergyWh(tag, tel);
        var s = startHour + cursorMin / 60;
        var avg = avgIntensity(region, s, tel.durationMin);
        rows.push({ job: name, stage: stage, tag: tag, region: region, startHour: s, durationMin: tel.durationMin, wh: wh, gco2: wh / 1000 * avg, intensity: avg, deferred: false });
        stageDur = Math.max(stageDur, tel.durationMin);
      });
      cursorMin += stageDur;
    });
    Object.keys(deferred).forEach(function (name) {
      if (!doc[name]) return;
      var d = deferred[name];
      var tag = runnerTagOf(doc[name]);
      var tel = telemetry[name];
      var wh = jobEnergyWh(tag, tel);
      var avg = avgIntensity(d.region, d.startHour, tel.durationMin);
      rows.push({ job: name, stage: stageOf(doc[name]), tag: tag, region: d.region, startHour: d.startHour, durationMin: tel.durationMin, wh: wh, gco2: wh / 1000 * avg, intensity: avg, deferred: true });
    });
    var totalWh = rows.reduce(function (a, r) { return a + r.wh; }, 0);
    var totalG = rows.reduce(function (a, r) { return a + r.gco2; }, 0);
    return { rows: rows, totalWh: round(totalWh, 2), totalGco2: round(totalG, 2), criticalPathMin: round(cursorMin, 2) };
  }

  /* ---------- optimization steps ---------- */

  function rightsize(tag, tel, opts) {
    var o = opts || {};
    var cur = RUNNERS[tag];
    if (tel.estimated) return { change: false, reason: 'no telemetry for this job, left unchanged' };
    var peakCores = tel.peakCpuPct / 100 * cur.vcpu;
    var needCores = Math.ceil(peakCores * MODEL.cpuHeadroom);
    var needMemMb = tel.peakRssMb * MODEL.memHeadroom;
    var pick = null;
    for (var i = 0; i < RUNNER_ORDER.length; i += 1) {
      var t = RUNNER_ORDER[i], r = RUNNERS[t];
      if (r.vcpu >= needCores && r.memGb * 1024 >= needMemMb) { pick = t; break; }
    }
    if (!pick || RUNNERS[pick].rank >= cur.rank) return { change: false, reason: 'current size is already the smallest that fits the measured peaks' };
    var np = RUNNERS[pick];
    var halvings = Math.log(cur.vcpu / np.vcpu) / Math.log(2);
    var slowdown = 1 + MODEL.slowdownPerHalving * halvings;
    if (slowdown > (o.maxSlowdown || 1.15)) return { change: false, reason: 'predicted slowdown ' + round(slowdown, 3) + ' exceeds the limit' };
    var avgCores = tel.avgCpuPct / 100 * cur.vcpu;
    var newTel = {
      durationMin: round(tel.durationMin * slowdown, 2),
      peakRssMb: tel.peakRssMb,
      avgCpuPct: Math.min(100, round(avgCores / np.vcpu * 100, 2)),
      peakCpuPct: Math.min(100, round(peakCores / np.vcpu * 100, 2)),
      estimated: false
    };
    return { change: true, from: tag, to: pick, slowdown: round(slowdown, 3), telemetry: newTel, needCores: needCores, needMemMb: Math.round(needMemMb) };
  }

  function findGreenWindow(args) {
    var wh = args.wh, dur = args.durationMin, baseRegion = args.baseRegion, baseStart = args.baseStart;
    var maxDelay = args.maxDelayHours, regions = args.regions;
    var baseG = wh / 1000 * avgIntensity(baseRegion, baseStart, dur);
    var best = { region: baseRegion, startHour: baseStart, delayHours: 0, g: baseG };
    var evaluated = 0;
    var s0 = Math.ceil(baseStart * 2) / 2;   // windows start on the hour or half hour so cron stays readable
    regions.forEach(function (rid) {
      for (var d = 0; d <= maxDelay + 1e-9; d += 0.5) {
        evaluated += 1;
        var start = s0 + d;
        var delay = start - baseStart;
        var g = wh / 1000 * avgIntensity(rid, start, dur);
        var better = g < best.g - 1e-9 || (Math.abs(g - best.g) <= 1e-9 && delay < best.delayHours);
        if (better) best = { region: rid, startHour: start, delayHours: delay, g: g };
      }
    });
    return { region: best.region, startHour: best.startHour, delayHours: round(best.delayHours, 2), g: best.g, baseG: baseG, gainPct: baseG ? round((baseG - best.g) / baseG * 100, 2) : 0, evaluated: evaluated };
  }

  function windowId(region, startHour) {
    var h = Math.floor(((startHour % 24) + 24) % 24);
    return region + '-' + ('0' + h).slice(-2);
  }

  function cronFor(startHour) {
    var h = Math.floor(((startHour % 24) + 24) % 24);
    var m = Math.round((startHour - Math.floor(startHour)) * 60);
    return m + ' ' + h + ' * * *';
  }

  /* ---------- diff ---------- */

  function lcsTable(a, b) {
    var n = a.length, m = b.length;
    var t = [];
    for (var i = 0; i <= n; i += 1) t.push(new Array(m + 1).fill(0));
    for (var x = n - 1; x >= 0; x -= 1) for (var y = m - 1; y >= 0; y -= 1) t[x][y] = a[x] === b[y] ? t[x + 1][y + 1] + 1 : Math.max(t[x + 1][y], t[x][y + 1]);
    return t;
  }

  function sideBySide(aText, bText) {
    var a = aText.replace(/\n$/, '').split('\n'), b = bText.replace(/\n$/, '').split('\n');
    var t = lcsTable(a, b);
    var rows = [], i = 0, j = 0;
    var dels = [], adds = [];
    function flush() {
      var k = Math.max(dels.length, adds.length);
      for (var q = 0; q < k; q += 1) {
        var l = dels[q], r = adds[q];
        rows.push({ type: l !== undefined && r !== undefined ? 'change' : (l !== undefined ? 'remove' : 'add'), left: l === undefined ? '' : l, right: r === undefined ? '' : r });
      }
      dels = []; adds = [];
    }
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { flush(); rows.push({ type: 'same', left: a[i], right: b[j] }); i += 1; j += 1; }
      else if (j < b.length && (i === a.length || t[i][j + 1] >= t[i + 1][j])) { adds.push(b[j]); j += 1; }
      else { dels.push(a[i]); i += 1; }
    }
    flush();
    return rows;
  }

  function unifiedDiff(aText, bText, nameA, nameB) {
    var rows = sideBySide(aText, bText);
    var out = ['--- ' + (nameA || 'a/.gitlab-ci.yml'), '+++ ' + (nameB || 'b/.gitlab-ci.yml')];
    rows.forEach(function (r) {
      if (r.type === 'same') out.push(' ' + r.left);
      else { if (r.left !== '') out.push('-' + r.left); if (r.right !== '') out.push('+' + r.right); }
    });
    return out.join('\n') + '\n';
  }

  /* ---------- the hands-off agent ---------- */

  var DEFAULT_OPTS = { region: 'us-central1', startHour: 19, maxDelayHours: 14, allowRegionShift: false, minGainPct: 10, maxSlowdown: 1.15 };

  function runGreenAgent(yamlText, telemetryInput, options) {
    var o = Object.assign({}, DEFAULT_OPTS, options || {});
    var trace = [];
    function log(tool, input, output) { trace.push({ seq: trace.length + 1, agent: 'GreenRunner Duo Agent', tool: tool, input: input, output: output }); }

    var doc;
    try { doc = parseGitlabCI(yamlText); } catch (e) {
      log('parse_ci', { bytes: String(yamlText).length }, { error: e.message });
      return { ok: false, error: e.message, trace: trace };
    }
    var jobNames = jobsOf(doc);
    log('parse_ci', { bytes: String(yamlText).length }, { jobs: jobNames.length, stages: stageOrder(doc) });

    var tel = normalizeTelemetry(doc, telemetryInput);
    var estimatedJobs = jobNames.filter(function (j) { return tel[j].estimated; });
    var cls = classify(doc);
    log('classify_lifecycle', { jobs: jobNames.length }, {
      deferrable: jobNames.filter(function (j) { return cls[j].deferrable; }),
      critical: jobNames.filter(function (j) { return !cls[j].deferrable; }),
      pinnedByNeeds: jobNames.filter(function (j) { return /needs/.test(cls[j].reason); })
    });

    var baseline = simulatePipeline(doc, tel, { region: o.region, startHour: o.startHour });
    log('simulate_pipeline', { region: o.region, startHour: o.startHour, label: 'baseline' }, { totalWh: baseline.totalWh, totalGco2: baseline.totalGco2, criticalPathMin: baseline.criticalPathMin });

    var patched = clone(doc);
    var effTel = clone(tel);
    var changes = [];

    jobNames.forEach(function (name) {
      var tag = runnerTagOf(doc[name]);
      var rs = rightsize(tag, tel[name], { maxSlowdown: o.maxSlowdown });
      log('rightsize_runner', { job: name, tag: tag, peakCpuPct: tel[name].peakCpuPct, peakRssMb: tel[name].peakRssMb }, rs.change ? { from: rs.from, to: rs.to, slowdown: rs.slowdown } : { unchanged: true, reason: rs.reason });
      if (!rs.change) return;
      var tags = Array.isArray(patched[name].tags) ? patched[name].tags.slice() : [];
      var idx = tags.indexOf(rs.from);
      if (idx === -1) tags.push(rs.to); else tags[idx] = rs.to;
      patched[name].tags = tags;
      effTel[name] = rs.telemetry;
      changes.push({ job: name, type: 'rightsize', from: rs.from, to: rs.to, slowdown: rs.slowdown });
    });

    var deferred = {};
    var schedules = {};
    var regions = o.allowRegionShift ? REGIONS.map(function (r) { return r.id; }) : [o.region];
    var preShift = simulatePipeline(patched, effTel, { region: o.region, startHour: o.startHour });
    jobNames.forEach(function (name) {
      if (!cls[name].deferrable) {
        if (/needs/.test(cls[name].reason)) changes.push({ job: name, type: 'skipped', reason: cls[name].reason });
        return;
      }
      var row = preShift.rows.filter(function (r) { return r.job === name; })[0];
      var w = findGreenWindow({ wh: row.wh, durationMin: effTel[name].durationMin, baseRegion: o.region, baseStart: row.startHour, maxDelayHours: o.maxDelayHours, regions: regions });
      log('find_green_window', { job: name, baseStartHour: round(row.startHour, 2), regions: regions.length, maxDelayHours: o.maxDelayHours }, { region: w.region, startHour: round(w.startHour, 2), gainPct: w.gainPct, evaluated: w.evaluated });
      if (w.gainPct < o.minGainPct) {
        changes.push({ job: name, type: 'kept', reason: 'best window saves only ' + w.gainPct + '% (limit ' + o.minGainPct + '%)' });
        return;
      }
      var wid = windowId(w.region, w.startHour);
      deferred[name] = { region: w.region, startHour: w.startHour };
      var job = patched[name];
      job.rules = [{ if: '$CI_PIPELINE_SOURCE == "schedule" && $GREEN_WINDOW == "' + wid + '"' }];
      var moved = w.region !== o.region;
      if (moved) {
        var tag = runnerTagOf(patched[name]);
        var size = tag.replace(/^saas-linux-/, '').replace(/-amd64$/, '');
        job.tags = ['green-' + w.region + '-' + size];
      }
      schedules[wid] = { id: wid, cron: cronFor(w.startHour), timezone: 'UTC', variables: { GREEN_WINDOW: wid }, region: w.region };
      changes.push({ job: name, type: moved ? 'shift-region' : 'shift-time', window: wid, region: w.region, startHour: round(w.startHour, 2), delayHours: w.delayHours, gainPct: w.gainPct, originalRules: doc[name].rules || null });
    });

    var after = simulatePipeline(patched, effTel, { region: o.region, startHour: o.startHour, deferred: deferred });
    log('simulate_pipeline', { label: 'after patch' }, { totalWh: after.totalWh, totalGco2: after.totalGco2, criticalPathMin: after.criticalPathMin });

    var patchedYaml = dumpYaml(patched);
    var originalYaml = dumpYaml(doc);
    var diffRows = sideBySide(originalYaml, patchedYaml);
    log('generate_patch', { changes: changes.filter(function (c) { return c.type !== 'kept' && c.type !== 'skipped'; }).length }, { changedLines: diffRows.filter(function (r) { return r.type !== 'same'; }).length });

    var result = {
      ok: true,
      options: o,
      doc: doc,
      patched: patched,
      telemetry: tel,
      effectiveTelemetry: effTel,
      estimatedJobs: estimatedJobs,
      classification: cls,
      baseline: baseline,
      after: after,
      deferred: deferred,
      schedules: Object.keys(schedules).map(function (k) { return schedules[k]; }),
      changes: changes,
      originalYaml: originalYaml,
      patchedYaml: patchedYaml,
      diffRows: diffRows,
      diff: unifiedDiff(originalYaml, patchedYaml),
      savings: compare(baseline, after),
      trace: trace
    };
    result.report = buildMrReport(result);
    log('write_mr_report', { format: 'markdown' }, { bytes: result.report.length });
    return result;
  }

  function compare(before, after) {
    return {
      savedWh: round(before.totalWh - after.totalWh, 2),
      savedGco2: round(before.totalGco2 - after.totalGco2, 2),
      whPct: before.totalWh ? round((before.totalWh - after.totalWh) / before.totalWh * 100, 1) : 0,
      gco2Pct: before.totalGco2 ? round((before.totalGco2 - after.totalGco2) / before.totalGco2 * 100, 1) : 0,
      criticalPathBeforeMin: before.criticalPathMin,
      criticalPathAfterMin: after.criticalPathMin
    };
  }

  function signed(saved, pct) {
    if (saved === 0 || pct === 0) return '0%';
    return (saved > 0 ? '-' : '+') + Math.abs(pct) + '%';
  }

  function buildMrReport(r) {
    var s = r.savings;
    var L = [];
    L.push('## GreenRunner: carbon-aware pipeline plan');
    L.push('');
    L.push('Estimated per pipeline run, from the stated model assumptions. These are estimates, not measurements.');
    L.push('');
    L.push('| Metric | Before | After | Change |');
    L.push('| --- | --- | --- | --- |');
    L.push('| Energy (Wh) | ' + r.baseline.totalWh + ' | ' + r.after.totalWh + ' | ' + signed(s.savedWh, s.whPct) + ' |');
    L.push('| Carbon (gCO2eq) | ' + r.baseline.totalGco2 + ' | ' + r.after.totalGco2 + ' | ' + signed(s.savedGco2, s.gco2Pct) + ' |');
    L.push('| Critical path (min) | ' + s.criticalPathBeforeMin + ' | ' + s.criticalPathAfterMin + ' | ' + (s.criticalPathAfterMin - s.criticalPathBeforeMin) + ' |');
    L.push('');
    L.push('### Changes');
    var any = false;
    r.changes.forEach(function (c) {
      if (c.type === 'rightsize') { any = true; L.push('- `' + c.job + '`: runner `' + c.from + '` to `' + c.to + '` (predicted slowdown x' + c.slowdown + ')'); }
      else if (c.type === 'shift-time') { any = true; L.push('- `' + c.job + '`: runs on a schedule at window `' + c.window + '` (' + c.delayHours + ' h later), estimated ' + c.gainPct + '% less carbon for this job'); }
      else if (c.type === 'shift-region') { any = true; L.push('- `' + c.job + '`: moved to region `' + c.region + '` (window `' + c.window + '`), estimated ' + c.gainPct + '% less carbon for this job'); }
      else if (c.type === 'kept') L.push('- `' + c.job + '`: left as is, ' + c.reason);
      else if (c.type === 'skipped') L.push('- `' + c.job + '`: not moved, ' + c.reason);
    });
    if (!any) L.push('- No beneficial change found.');
    if (r.schedules.length) {
      L.push('');
      L.push('### Pipeline schedules to create');
      r.schedules.forEach(function (sc) { L.push('- cron `' + sc.cron + '` (' + sc.timezone + '), variable `GREEN_WINDOW=' + sc.id + '`'); });
    }
    L.push('');
    L.push('### Review before merging');
    L.push('- Deferred jobs no longer gate this pipeline. If a scan must block merges, keep it in the pipeline.');
    if (r.changes.some(function (c) { return c.type === 'shift-region'; })) L.push('- Region moves use tags such as `green-europe-north1-small`, which need self-managed runners in that region. Check data residency rules first.');
    if (r.estimatedJobs.length) L.push('- No telemetry for: ' + r.estimatedJobs.join(', ') + '. Those jobs were never resized and use a default estimate.');
    L.push('- Rollback: revert this merge request. The original file is preserved in git history.');
    L.push('');
    L.push('Model: ' + MODEL.wattsPerVcpu + ' W per vCPU at full load, ' + Math.round(MODEL.idleFraction * 100) + '% idle floor, PUE ' + MODEL.pue + ', synthetic grid curves.');
    return L.join('\n') + '\n';
  }

  /* ---------- presets ---------- */

  var PRESETS = [
    {
      id: 'node-webapp', name: 'Node web app',
      yaml: [
        'stages:', '  - build', '  - test', '  - security', '  - fuzz', '  - deploy', '',
        'install-build:', '  stage: build', '  tags:', '    - saas-linux-large-amd64', '  script:', '    - npm ci', '    - npm run build', '',
        'unit-test:', '  stage: test', '  tags:', '    - saas-linux-large-amd64', '  script:', '    - npm test', '',
        'lint:', '  stage: test', '  tags:', '    - saas-linux-medium-amd64', '  script:', '    - npm run lint', '',
        'sast:', '  stage: security', '  tags:', '    - saas-linux-medium-amd64', '  script:', '    - echo run sast', '',
        'container_scanning:', '  stage: security', '  tags:', '    - saas-linux-large-amd64', '  script:', '    - echo scan image', '',
        'fuzz-api:', '  stage: fuzz', '  tags:', '    - saas-linux-xlarge-amd64', '  script:', '    - echo fuzz the api for 30 minutes', '',
        'deploy-staging:', '  stage: deploy', '  tags:', '    - saas-linux-small-amd64', '  script:', '    - echo deploy to staging', ''
      ].join('\n'),
      telemetry: {
        'install-build': { durationMin: 6, peakRssMb: 2800, avgCpuPct: 38, peakCpuPct: 70 },
        'unit-test': { durationMin: 7, peakRssMb: 3200, avgCpuPct: 22, peakCpuPct: 41 },
        lint: { durationMin: 3, peakRssMb: 900, avgCpuPct: 18, peakCpuPct: 30 },
        sast: { durationMin: 5, peakRssMb: 2100, avgCpuPct: 30, peakCpuPct: 45 },
        container_scanning: { durationMin: 8, peakRssMb: 3500, avgCpuPct: 20, peakCpuPct: 35 },
        'fuzz-api': { durationMin: 30, peakRssMb: 5000, avgCpuPct: 55, peakCpuPct: 75 },
        'deploy-staging': { durationMin: 2, peakRssMb: 600, avgCpuPct: 20, peakCpuPct: 40 }
      }
    },
    {
      id: 'python-ml', name: 'Python ML service',
      yaml: [
        'stages:', '  - prepare', '  - test', '  - benchmark', '  - deploy', '',
        'prepare-data:', '  stage: prepare', '  tags:', '    - saas-linux-large-amd64', '  script:', '    - python prep.py', '',
        'unit-tests:', '  stage: test', '  tags:', '    - saas-linux-xlarge-amd64', '  script:', '    - pytest -q', '',
        'type-check:', '  stage: test', '  tags:', '    - saas-linux-large-amd64', '  script:', '    - mypy src', '',
        'benchmark-inference:', '  stage: benchmark', '  tags:', '    - saas-linux-xlarge-amd64', '  script:', '    - python bench.py --runs 200', '',
        'deploy-model:', '  stage: deploy', '  tags:', '    - saas-linux-medium-amd64', '  script:', '    - echo publish model', ''
      ].join('\n'),
      telemetry: {
        'prepare-data': { durationMin: 9, peakRssMb: 9000, avgCpuPct: 35, peakCpuPct: 60 },
        'unit-tests': { durationMin: 12, peakRssMb: 6000, avgCpuPct: 15, peakCpuPct: 30 },
        'type-check': { durationMin: 4, peakRssMb: 1800, avgCpuPct: 14, peakCpuPct: 25 },
        'benchmark-inference': { durationMin: 25, peakRssMb: 14000, avgCpuPct: 70, peakCpuPct: 92 },
        'deploy-model': { durationMin: 3, peakRssMb: 1200, avgCpuPct: 25, peakCpuPct: 50 }
      }
    },
    {
      id: 'java-monorepo', name: 'Java monorepo (a release needs the scan)',
      yaml: [
        'stages:', '  - build', '  - test', '  - dast', '  - release', '',
        'maven-build:', '  stage: build', '  tags:', '    - saas-linux-2xlarge-amd64', '  script:', '    - mvn -B package -DskipTests', '',
        'test-services:', '  stage: test', '  tags:', '    - saas-linux-xlarge-amd64', '  script:', '    - mvn -B verify', '',
        'integration:', '  stage: test', '  tags:', '    - saas-linux-large-amd64', '  script:', '    - mvn -B verify -Pintegration', '',
        'dast-scan:', '  stage: dast', '  tags:', '    - saas-linux-large-amd64', '  script:', '    - echo run dast against review app', '',
        'release:', '  stage: release', '  needs:', '    - dast-scan', '  tags:', '    - saas-linux-small-amd64', '  script:', '    - echo tag and publish', ''
      ].join('\n'),
      telemetry: {
        'maven-build': { durationMin: 11, peakRssMb: 12000, avgCpuPct: 12, peakCpuPct: 28 },
        'test-services': { durationMin: 15, peakRssMb: 14000, avgCpuPct: 20, peakCpuPct: 38 },
        integration: { durationMin: 10, peakRssMb: 6000, avgCpuPct: 30, peakCpuPct: 50 },
        'dast-scan': { durationMin: 20, peakRssMb: 5000, avgCpuPct: 25, peakCpuPct: 40 },
        release: { durationMin: 2, peakRssMb: 500, avgCpuPct: 30, peakCpuPct: 60 }
      }
    },
    {
      id: 'go-service', name: 'Go service with nightly docs',
      yaml: [
        'stages:', '  - build', '  - test', '  - benchmark', '  - docs', '',
        'go-build:', '  stage: build', '  tags:', '    - saas-linux-medium-amd64', '  script:', '    - go build ./...', '',
        'go-test:', '  stage: test', '  tags:', '    - saas-linux-large-amd64', '  script:', '    - go test ./...', '',
        'bench-http:', '  stage: benchmark', '  tags:', '    - saas-linux-xlarge-amd64', '  script:', '    - go test -bench . ./http', '',
        'pages-nightly:', '  stage: docs', '  tags:', '    - saas-linux-large-amd64', '  script:', '    - echo build full docs site', ''
      ].join('\n'),
      telemetry: {
        'go-build': { durationMin: 3, peakRssMb: 2500, avgCpuPct: 40, peakCpuPct: 85 },
        'go-test': { durationMin: 6, peakRssMb: 2000, avgCpuPct: 25, peakCpuPct: 45 },
        'bench-http': { durationMin: 18, peakRssMb: 4000, avgCpuPct: 35, peakCpuPct: 55 },
        'pages-nightly': { durationMin: 9, peakRssMb: 3000, avgCpuPct: 22, peakCpuPct: 38 }
      }
    },
    {
      id: 'mobile-app', name: 'Mobile app with parser fuzzing',
      yaml: [
        'stages:', '  - build', '  - test', '  - fuzz', '  - security', '',
        'android-build:', '  stage: build', '  tags:', '    - saas-linux-large-amd64', '  script:', '    - ./gradlew assembleDebug', '',
        'ui-tests:', '  stage: test', '  tags:', '    - saas-linux-xlarge-amd64', '  script:', '    - ./gradlew connectedCheck', '',
        'fuzz-parser:', '  stage: fuzz', '  tags:', '    - saas-linux-large-amd64', '  script:', '    - echo fuzz the file parser', '',
        'container_scanning:', '  stage: security', '  tags:', '    - saas-linux-medium-amd64', '  script:', '    - echo scan builder image', ''
      ].join('\n'),
      telemetry: {
        'android-build': { durationMin: 14, peakRssMb: 9000, avgCpuPct: 45, peakCpuPct: 80 },
        'ui-tests': { durationMin: 16, peakRssMb: 9500, avgCpuPct: 28, peakCpuPct: 50 },
        'fuzz-parser': { durationMin: 40, peakRssMb: 3000, avgCpuPct: 60, peakCpuPct: 85 },
        container_scanning: { durationMin: 6, peakRssMb: 2500, avgCpuPct: 20, peakCpuPct: 35 }
      }
    },
    {
      id: 'docs-site', name: 'Docs site',
      yaml: [
        'stages:', '  - build', '  - test', '  - docs', '',
        'build-docs:', '  stage: build', '  tags:', '    - saas-linux-medium-amd64', '  script:', '    - npm ci', '    - npm run build', '',
        'link-check:', '  stage: test', '  tags:', '    - saas-linux-medium-amd64', '  script:', '    - npm run links', '',
        'pages-nightly:', '  stage: docs', '  tags:', '    - saas-linux-xlarge-amd64', '  script:', '    - npm run build:full', ''
      ].join('\n'),
      telemetry: {
        'build-docs': { durationMin: 4, peakRssMb: 3000, avgCpuPct: 40, peakCpuPct: 70 },
        'link-check': { durationMin: 5, peakRssMb: 800, avgCpuPct: 10, peakCpuPct: 20 },
        'pages-nightly': { durationMin: 15, peakRssMb: 6000, avgCpuPct: 18, peakCpuPct: 35 }
      }
    }
  ];

  function getPreset(id) {
    for (var i = 0; i < PRESETS.length; i += 1) if (PRESETS[i].id === id) return PRESETS[i];
    return null;
  }

  return {
    MODEL: MODEL, RUNNERS: RUNNERS, RUNNER_ORDER: RUNNER_ORDER, REGIONS: REGIONS, PRESETS: PRESETS, DEFER_TOKENS: DEFER_TOKENS, DEFAULT_OPTS: DEFAULT_OPTS,
    mulberry32: mulberry32, hashString: hashString, round: round,
    parseYaml: parseYaml, dumpYaml: dumpYaml, parseGitlabCI: parseGitlabCI,
    jobsOf: jobsOf, stageOrder: stageOrder, runnerTagOf: runnerTagOf, classify: classify,
    regionCurve: regionCurve, intensityAt: intensityAt, avgIntensity: avgIntensity,
    normalizeTelemetry: normalizeTelemetry, jobEnergyWh: jobEnergyWh, simulatePipeline: simulatePipeline,
    rightsize: rightsize, findGreenWindow: findGreenWindow, windowId: windowId, cronFor: cronFor,
    sideBySide: sideBySide, unifiedDiff: unifiedDiff, runGreenAgent: runGreenAgent, compare: compare, buildMrReport: buildMrReport,
    getPreset: getPreset
  };
}));
