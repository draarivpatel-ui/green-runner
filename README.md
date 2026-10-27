# GreenRunner

A hands-off, carbon-aware optimizer for GitLab CI/CD pipelines. Paste a `.gitlab-ci.yml`, add per-job telemetry, and an agent estimates the energy and carbon of one pipeline run, moves deferrable jobs into low-carbon windows (or regions), right-sizes over-provisioned runner tags, and writes the YAML patch plus a merge request report.

Live demo: https://aariv.me/green-runner/

This is a second entry for GitLab Transcend: Life After Code. It is aimed at Path A (a fresh hands-off agent for the stages after code is written) and the Most Environmentally Impactful category. That is the intent, not a claim about any outcome.

## What it does

1. Reads the pipeline with a small zero-dependency YAML reader (and writer) built for the `.gitlab-ci.yml` subset: maps, lists, lists of maps, inline lists, quoted strings, block scalars, comments.
2. Classifies jobs. Names or stages containing `fuzz`, `container_scanning`, `dast`, `benchmark` or `pages-nightly` are deferrable. Deploy and release jobs, and any job another job lists under `needs`, are pinned.
3. Simulates energy in watt-hours from runner size, duration, CPU and memory, then carbon in grams of CO2 equivalent from a 24-hour grid intensity curve for 6 regions.
4. Right-sizes runner tags such as `saas-linux-large-amd64` to `saas-linux-small-amd64` from peak CPU and memory telemetry, with 20% CPU and 30% memory headroom and a slowdown guard.
5. Replaces the `rules` of deferrable jobs with a scheduled-pipeline rule for the greenest window within a delay limit, optionally in a lower-carbon region, and lists the pipeline schedules to create.
6. Shows a side-by-side YAML patch, a per-job table, an agent trace, and a Markdown merge request report.

The same engine runs in the page and from the command line:

```
node cli.js examples/node-webapp.gitlab-ci.yml --telemetry examples/node-webapp.telemetry.json --region-shift --report green-report.md
```

## Judge shortcuts

"Run Hands-Off Duo Agent" runs time shifting and right-sizing. "Run With Region Shift" also lets jobs move to a lower-carbon region. "Apply Patch To Editor" writes the patch and the post-patch telemetry into the editors, and a second run then finds nothing further to change.

## Repository map

| Path | Purpose |
| --- | --- |
| `engine.js` | YAML reader and writer, energy and carbon model, agent, diff, report, six presets |
| `app.js`, `index.html`, `styles.css` | The page, with a canvas of the 24-hour curves and job moves |
| `cli.js` | Command line over the same engine |
| `.gitlab-ci.yml` | This project's own pipeline: tests, plus a merge request job that runs the agent and keeps its report as an artifact |
| `docs/agents.md` | How this is meant to run as a GitLab Duo agent, with what is and is not tested |
| `.gitlab/duo/agent-config.yml` | Execution settings for the agent, using the keys GitLab documents |
| `examples/` | A sample pipeline and telemetry file |

## Honest limits

- Every figure is an estimate from a stated model: 12 W per vCPU at full load, a 30% idle floor, 0.3 W per GB of memory in use and a PUE of 1.2. These coefficients are assumptions, not measurements of any real runner.
- The grid intensity curves are synthetic and illustrative. They are shaped like typical day and night patterns and are not real-time or historical data for any grid. Replace them with a real source before trusting the carbon numbers.
- Runner sizes (vCPU and memory per `saas-linux-*` tag) follow GitLab's hosted runner documentation as read on the build date.
- The agent logic runs locally in this page and in Node. It has not been executed on the GitLab Duo Agent Platform: no agent was registered, no flow ran and no merge request was opened by it. `docs/agents.md` is a plan, and it says why no flow definition file is included.
- Deferred jobs stop gating the pipeline. Region moves rely on self-managed runners tagged `green-<region>-<size>` and need a data residency check.
- The YAML reader covers the subset above. It rejects anchors, aliases and merge keys on purpose rather than guessing, so pipelines that use them need to be expanded first.

## Tests

```
npm test
```

This runs `node --test` with no installs. `tests/engine.test.js` covers the YAML reader and writer (including round trips of every preset and this repository's own pipeline), the energy model, right-sizing, window search, the agent's guardrails, the report and the command line. `tests/dom-smoke.test.js` checks the markup, drives the controller on a small fake DOM, and scans every file for dashes, emoji, uppercase kickers, credential-shaped strings and private details.

## AI disclosure

This project was designed and written with an AI coding assistant (Claude), then run and tested locally. The model, presets, telemetry values and documents were written by the assistant. Aariv Patel directed the project and owns the repository. No human reviewed the numbers against a real pipeline.

## License

MIT, see `LICENSE`.
