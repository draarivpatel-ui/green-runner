# Security policy

## Reporting a vulnerability

Use the private GitHub Security Advisory form at [Report a vulnerability](https://github.com/draarivpatel-ui/green-runner/security/advisories/new). Do not open a public issue, pull request or discussion with exploit details.

Never include a live secret, token, cookie, private key, victim hostname or proprietary payload in a report. Use synthetic values and redacted transcripts.

## Supported versions

| Version | Status |
| --- | --- |
| latest `main` | Supported |

Security fixes are applied to the latest state of the default branch.

## Scope

This policy covers the GreenRunner browser application, command line interface and Node tests, including GitLab CI YAML parsing, telemetry imports, carbon-aware schedule optimization, patched pipeline generation, reports, digest verification and CSV or Markdown output.

In scope:

- A cross-site scripting or HTML injection path through pipeline text, job names, telemetry fields, report content or rendered output.
- A YAML parser, telemetry decoder or validation flaw that bypasses bounds, corrupts another analysis state or executes attacker-controlled code.
- A generated pipeline patch flaw that inserts attacker-controlled commands, credentials, external downloads or unexpected job behavior.
- A generated CSV, JSON, Markdown or report export flaw that makes generated output execute a formula or script when opened.
- A checksum, digest or tamper-evidence bypass that makes altered output validate as untampered.

Out of scope:

- Browser vulnerabilities, operating system compromise or physical access to the machine.
- Damage caused by modified copies of the static application that do not come from this repository.
- Carbon estimates, scheduling quality or engineering accuracy without a security impact.
- Denial of service that only affects the attacker's own browser tab.

## Coordinated disclosure

- Acknowledgment: within 3 business days.
- Initial triage: within 14 calendar days.
- Fix or mitigation target: within 90 calendar days for confirmed reports.
- Coordinated public disclosure: up to 90 days by default, adjusted by mutual agreement when exploitation or user risk requires a different date.
