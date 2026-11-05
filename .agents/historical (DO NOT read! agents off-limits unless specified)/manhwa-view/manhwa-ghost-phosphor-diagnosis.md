# Manhwa ghost column diagnosis

Note: compared against `.agents/skills/validate-changes/SKILL.md` before presenting. No prod files were touched and no code changes are proposed here. Diagnostics only.

Scenario: `e2e/scenarios/manhwa-ghost-phosphor.json`. Probe: `manhwa-ghost` in `e2e/replay-diagnostics/investigation.js` (kept, not cleaned).

## Symptom

Manhwa view with WebGL (phosphor filter, fit height-if-larger). Switching directories leaves the previous directory column on screen for a few hundred ms. Clearest on the last step: ch. 75 back to test-files.

## Primary root cause

- **Failing component**: `src/js/viewer/viewerPipelines.js:888` (`Core.onStateChange` manhwa branch) with `src/js/viewer/manhwaStrip.js:2537` (container-change path).
- **Mechanism**: On a directory switch, the pipeline keeps the old composite on `#manhwa-filter-canvas` while the strip rebuilds. The manhwa branch only runs `_syncColumnPipeline` plus `_requestColumnRender`. When the filter is unchanged (phosphor to phosphor), `_syncColumnPipeline` (`viewerPipelines.js:1475`) reuses the existing pipeline and never clears the canvas or bumps `_columnGeneration`. Meanwhile `manhwaStrip.js:2586` removes all DOM slots at once, then waits behind the width gate (first dims, sweep report, or the 2000ms timeout at `manhwaStrip.js:73`) before remounting. `_renderColumnInner` returns without clearing when there is nothing to draw yet (`viewerPipelines.js:1606`, `viewerPipelines.js:1754`, `viewerPipelines.js:1982`). The new paint needs asset fetch plus texture upload first. Until that lands, the previous directory column stays on screen.
- **Why existing logic failed**: Keeping the last frame is intentional for pan and zoom (`viewerPipelines.js:932`). That path has no container check, so a directory switch gets treated like a scroll tick and the held frame belongs to a different folder. Height-if-larger makes it obvious because the two columns differ a lot in width (ch. 75 caps at 690px, test-files at 3300px).

## Timeline evidence

Step 4 of the scenario, `jump-to-index` 0, ch. 75 back to test-files, pause 1000ms run:

- `+0.2ms`: ch. 75, 9 decoded slots, phosphor canvas visible (old column).
- `+29.4ms` / `+54.6ms`: Core state-changes land in test-files (`listLength` 127 to 20), strip cleared.
- `+23ms` to `+564.8ms`: 40 `ghost-frame` anomalies. Canvas visible with `data-render-ready=true` while decoded strip images sit at zero.
- `+580.5ms`: first `canvas-ready-change`, new composite painted, with follow-ups at `+593ms` and `+705ms`.
- End of step: one decoded 3300px slot from test-files, canvas visible.

Ghost window is about 525ms. Baseline `base.js` reports zero anomalies here because a visible stale canvas counts as content, not a blackout.

## Non-specified anomalies flagged

- Step 2 (test-files into ch. 75) showed 6 blackout frames at the tail of one run. The directory state-change landed at `+681ms` after a 726ms asset fetch, so no new paint fit in the step.
- One run showed 46 blackout frames on step 3 (`cmd-fit-height-if-larger` inside ch. 75, idempotent). The canvas was blank from the prior slow step and nothing repainted it.
- 3 jank frames total on the 1000ms run. No IPC errors, no protocol failures, no unhandled rejections.

## Boundaries and open questions

- `viewerPipelines.js` owns the canvases, `manhwaStrip.js` owns the strip DOM, Core owns container state. The pipeline ignores container identity today.
- Per `.agents/AGENTS.md`: one owner per concern, state callbacks over reach-in, no per-frame polling in prod (the probe polls Core each frame and must not ship).
- Open: clear the canvas to transparent on container switch, or hold the old frame until the width gate opens and swap then? Clearing risks a brief blank on slow loads (step 2 blanked for that reason). Also untested whether lanczos-only direct-screen mode has the same gap, since it clears before each paint (`viewerPipelines.js:1871`).
