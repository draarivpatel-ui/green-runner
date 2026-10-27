#!/usr/bin/env node
'use strict';
/*
 * GreenRunner command line: reads a .gitlab-ci.yml and optional telemetry JSON, runs the
 * hands-off agent and prints the merge request report. No network access, no dependencies.
 */
const fs = require('node:fs');
const G = require('./engine.js');

function parseArgs(argv) {
  const a = { file: null, telemetry: null, region: null, hour: null, regionShift: false, write: null, report: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === '--telemetry') a.telemetry = argv[++i];
    else if (v === '--region') a.region = argv[++i];
    else if (v === '--hour') a.hour = Number(argv[++i]);
    else if (v === '--region-shift') a.regionShift = true;
    else if (v === '--write') a.write = argv[++i];
    else if (v === '--report') a.report = argv[++i];
    else if (v === '--json') a.json = true;
    else if (v === '--help' || v === '-h') a.help = true;
    else if (!a.file) a.file = v;
    else throw new Error('unexpected argument: ' + v);
  }
  return a;
}

const USAGE = [
  'Usage: node cli.js <ci.yml> [options]',
  '  --telemetry <file.json>   per-job durationMin, peakRssMb, avgCpuPct, peakCpuPct',
  '  --region <id>             baseline region (default us-central1)',
  '  --hour <0-23>             pipeline start hour in UTC (default 19)',
  '  --region-shift            allow moving deferrable jobs to a lower-carbon region',
  '  --write <file>            write the patched .gitlab-ci.yml',
  '  --report <file>           write the markdown report instead of printing it',
  '  --json                    print the full result as JSON'
].join('\n');

function main(argv, io) {
  const out = io || { log: (s) => process.stdout.write(s + '\n'), err: (s) => process.stderr.write(s + '\n') };
  let args;
  try { args = parseArgs(argv); } catch (e) { out.err(e.message); return 2; }
  if (args.help || !args.file) { out.log(USAGE); return args.help ? 0 : 2; }
  let yaml, telemetry = {};
  try { yaml = fs.readFileSync(args.file, 'utf8'); } catch (e) { out.err('cannot read ' + args.file + ': ' + e.message); return 2; }
  if (args.telemetry) {
    try { telemetry = JSON.parse(fs.readFileSync(args.telemetry, 'utf8')); } catch (e) { out.err('bad telemetry file: ' + e.message); return 2; }
  }
  const opts = { allowRegionShift: args.regionShift };
  if (args.region) opts.region = args.region;
  if (args.hour !== null && !Number.isNaN(args.hour)) opts.startHour = args.hour;
  if (opts.region && !G.REGIONS.some((r) => r.id === opts.region)) { out.err('unknown region ' + opts.region); return 2; }
  const result = G.runGreenAgent(yaml, telemetry, opts);
  if (!result.ok) { out.err('parse error: ' + result.error); return 1; }
  if (args.write) fs.writeFileSync(args.write, result.patchedYaml);
  if (args.report) fs.writeFileSync(args.report, result.report);
  if (args.json) out.log(JSON.stringify({ savings: result.savings, changes: result.changes, schedules: result.schedules, trace: result.trace }, null, 2));
  else if (!args.report) out.log(result.report);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs };
