# Build notes

Written 2026-10-26 (local clock, checked with `date`).

## Decisions

- Own YAML reader and writer instead of a library, so the page and the CLI stay dependency-free. The reader is deliberately strict: anchors, aliases, merge keys and tabs are errors.
- A list item is treated as a map entry only when it starts with a bare key and a colon, so a script line such as `echo "a: b"` stays a string.
- Deferral rewrites `rules` to a scheduled-pipeline condition on a `GREEN_WINDOW` variable and lists the schedules. One schedule serves every job that lands in the same window.
- Jobs that another critical job needs, and all deploy or release jobs, are pinned. Without the first rule the agent moved a scan that a release depended on.
- The default start hour is 19 UTC. With the first draft of the curves, Iowa was already at its low at the start hour, so nothing shifted in time; the curve shape for that region was revised so the default is not trivially optimal. The curves are synthetic either way.
- A region move rewrote the tag to a `green-<region>-<size>` tag, which the energy model initially did not recognise and so priced as a small runner. That produced a false 73% energy saving. Fixed, and covered by a test that energy is identical with and without region shift.
- Applying the patch also writes the post-patch telemetry (percentages are relative to the new runner size). Without that, a second run would shrink the same runners again.

## What was verified

- 67 engine tests and 34 DOM and controller tests pass (`npm test`).
- Round trip (parse, write, parse) is exact for all six presets and for this repository's own `.gitlab-ci.yml`.
- Every preset runs through the agent without raising carbon or energy; region shifting never saves less carbon than time shifting and never changes energy.
- The `saas-linux-*` machine sizes were checked against GitLab's hosted runner documentation through a web search on the build date. The Duo Agent Platform configuration keys named in `docs/agents.md` come from search results describing GitLab's documentation, not from a live project.

## What is not verified

- Any behaviour on GitLab.com or the Duo Agent Platform.
- The accuracy of any watt or carbon figure against real hardware or a real grid.
- Narrow phone layouts and browsers other than headless Chrome.
- Visual state beyond one headless Chrome screenshot at 1400px wide (throwaway profile): the Node web app preset after a region-shift run, showing the canvas, summary cards, trace, report and start of the patch. The other five presets, the job table after the first rows and the apply-patch state were checked only through the controller tests, not by eye. The first screenshot showed the job lanes colliding with the axis text, which was fixed and re-checked.
