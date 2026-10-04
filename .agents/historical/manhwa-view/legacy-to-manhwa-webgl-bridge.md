# Legacy to manhwa WebGL bridge analysis

Note: compared against `.agents/skills/validate-changes/SKILL.md` before presenting. No prod files were touched for this analysis and no code changes are proposed here. Diagnostics only.

Scenario: `e2e/scenarios/manhwa-to-legacy-crt.json` (inner name `legacy-to-manhwa-crt`). Probe: `ml-bridge` in `e2e/replay-diagnostics/investigation.js`, extended with per-canvas display tracking and a `gl-gap` signal.

## Symptom

Toggling legacy view into manhwa view with a WebGL filter no longer blanks (previous fix, verified clean), but the handoff drops through unfiltered DOM content: filtered legacy frame, raw bridge and mounting slots, filtered column. The filter pops off and back on across the transition.

## Findings

- The legacy filter canvas bitmap is never cleared on manhwa entry. `_cancelRender` (`viewerPipelines.js:192`) only bumps generation and clears the 2D lanczos canvas. `_teardownWebglCanvas` is not called on this path. The filtered frame survives in the buffer.
- The canvas disappears purely through CSS: `manhwa-active` sets `#viewer-filter-canvas` to display none (`main.css:1715`). Telemetry shows it display none with ready still true for the whole gap.
- Measured gap on the scenario run: `gl-gap` from `+16.7ms` to `+225.1ms`, span `208.4ms`, ending at the first column paint (`+229.6ms`). 0 blackout frames. 1 anomaly total.
- During the gap the bridge is decoded and mounting slots appear, all unfiltered. Nothing is broken. The filtered present is simply hidden while intact.

## Boundaries and open questions

- Both canvases and the marker are owned by `viewerPipelines.js`. CSS owns visibility. A WebGL-to-WebGL handoff keeps ownership in one file: retain the legacy frame on screen until first column paint instead of hiding it at the class flip.
- Per `.agents/AGENTS.md`: one owner per concern, CSS as visual source of truth (keep-visible state must travel through display or class state, never inline style), and the ghost fix proved teardown timing is load-bearing (a keep-alive must not resurrect the ghost on container switches, and must have a defined end if the column never paints, such as an empty strip with no anchor).
- Open: exact end condition for the keep-alive (first successful column paint is the natural candidate, with teardown paths as backstop), and stacking order so the legacy frame covers the bridge and raw slots while it is up.
