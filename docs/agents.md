# GreenRunner as a GitLab Duo agent

This document describes how GreenRunner is meant to run as a hands-off agent on the GitLab Duo Agent Platform, and states exactly what has and has not been tested.

## Status

- Tested: the engine (`engine.js`) and the command line (`cli.js`) run locally under Node, and the repository's own `.gitlab-ci.yml` parses with the engine's YAML reader.
- Not tested: nothing here has been run on GitLab.com or inside the Duo Agent Platform. No agent was registered, no flow was executed and no merge request was opened by the agent. The setup below is a plan based on GitLab's public documentation.
- Not written: a flow definition file. GitLab documents flow definitions (the Flow Registry framework) as a Beta single-file YAML schema, and the author did not verify that schema against a live project, so no flow file is included rather than a guessed one.

## What the agent does

The agent targets the stages that follow code merge (scans, fuzzing, benchmarks, nightly builds) and the runners that execute them.

1. Parse the project's `.gitlab-ci.yml` with the zero-dependency reader in `engine.js`.
2. Classify every job. Names or stages containing `fuzz`, `container_scanning`, `dast`, `benchmark` or `pages-nightly` are deferrable. Deploy and release jobs, and any job another job lists in `needs`, never move.
3. Estimate energy per job from runner size, duration, CPU and memory use, then convert to grams of CO2 equivalent with an hourly grid intensity curve.
4. Right-size runner tags from peak CPU and memory telemetry, for example `saas-linux-large-amd64` to `saas-linux-small-amd64`, keeping 20% CPU headroom and 30% memory headroom.
5. Move each deferrable job to the lowest-carbon window within a delay limit, or to a lower-carbon region when the project allows it, by replacing its `rules` with a scheduled-pipeline rule and listing the schedules to create.
6. Emit a patched `.gitlab-ci.yml`, a side-by-side diff and a Markdown merge request report with a savings table and a review checklist.

All grid curves in this repository are synthetic and illustrative. Wire real data in before trusting any number.

## Setup plan

1. Commit `engine.js`, `cli.js` and the telemetry file for your pipeline to the project (or vendor them into a CI template).
2. Add `.gitlab/duo/agent-config.yml` to the default branch. The file in this repository uses the keys `image`, `setup_script` and `network_policy`, which the GitLab documentation lists for agent execution configuration. Its value formats were not verified. GitLab reads this file from the default branch only.
3. In the project, create the agent or flow in the Duo Agent Platform UI and paste the instructions from the next section. Menu names change between GitLab releases, so follow the current documentation.
4. Trigger it on merge requests that touch `.gitlab-ci.yml`, or on a nightly schedule.
5. Require a human to review and merge the merge request the agent opens. The agent never merges.

### Agent instructions to paste

```
You are GreenRunner, a CI/CD sustainability agent.
Goal: reduce the estimated energy and carbon of this project's pipelines without slowing
the critical path or weakening any gate.
Steps:
1. Read .gitlab-ci.yml and the telemetry file named in the merge request description.
2. Run: node cli.js .gitlab-ci.yml --telemetry <telemetry file> --write .gitlab-ci.green.yml --report green-report.md
3. Review green-report.md. Do not apply a change that removes a deploy or release job,
   a job another job needs, or a job without telemetry.
4. Open a merge request that replaces .gitlab-ci.yml with the patched file and paste the
   report as the description. List the pipeline schedules a maintainer must create.
Never merge. Never change runner tags for jobs that have no telemetry. State clearly that
all figures are estimates.
```

## Guardrails built into the engine

- Deploy and release jobs are never deferred.
- A job that another non-deferrable job needs through `needs` is pinned in place, with the reason logged.
- A job is only moved when the estimated gain is at least 10% (configurable).
- Right-sizing stops if the predicted slowdown exceeds 15%.
- Jobs without telemetry are never resized and are listed in the report.
- Region moves rewrite tags to `green-<region>-<size>`, which only works if you operate self-managed runners with those tags. The report warns about data residency.

## References

- [Hosted runners on Linux](https://docs.gitlab.com/ci/runners/hosted_runners/linux/) for the machine sizes behind the `saas-linux-*` tags
- [Customize GitLab Duo Agent Platform](https://docs.gitlab.com/user/duo_agent_platform/customize/)
- [Agent configuration file syntax](https://docs.gitlab.com/user/duo_agent_platform/flows/agent_config_yml/)
- [Flow Registry Framework v1 (Beta)](https://docs.gitlab.com/user/duo_agent_platform/flows/claude-edit-v1-flow-registry/)
