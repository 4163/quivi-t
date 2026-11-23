# Legacy to manhwa bridge diagnosis

Note: compared against `.agents/skills/validate-changes/SKILL.md` before presenting. No prod files were touched and no code changes are proposed here. Diagnostics only.

Scenario: `e2e/scenarios/manhwa-to-legacy-crt.json` (inner name `legacy-to-manhwa-crt`). Probe: `ml-bridge` in `e2e/replay-diagnostics/investigation.js`.

## Symptom

Toggling legacy view into manhwa view with a WebGL filter (retro CRT) shows a blank flicker: legacy, blank frame, manhwa column. The reverse direction is clean.

## Primary root cause

- **Failing component**: `src/js/viewer/viewerPipelines.js:888` (manhwa-entry branch of `Core.onStateChange`) combined with `src/css/main.css:2224` (`#viewport[data-filter]` hide rule).
- **Mechanism**: On entry the viewport keeps the legacy `data-filter` marker (still `crt`) and nothing removes it until the first column paint. That one marker hides every fallback layer at once: the parked bridge image is forced to opacity 0 (`main.css:2224`), new strip slots are forced hidden (`main.css:2275`), legacy canvases are display-none under `manhwa-active` (`main.css:1715`), and the column canvas stays display-none until it reports ready (`main.css:2245`). The column needs asset fetch, texture upload, and composite before first paint, so the viewport sits fully blank for that load window.
- **Why existing logic failed**: Entry parks the legacy frame correctly (`viewerRender.js:599`, image already decoded) and clears legacy GL state, but neither side touches the marker. The column sets it only when a paint completes (`viewerPipelines.js:2017`). The bridge that should cover the swap is present and decoded the whole time, yet CSS keeps it invisible. Not a loading race. It blanks on every toggle.

## Timeline evidence

Step 3 of the scenario (`cmd-toggle-manhwa`, legacy 63.jpg into manhwa, crt, width-if-larger):

- Toggle notify lands around `+15ms`. First blank at `+17.3ms`, last at `+197.9ms`.
- First column paint (`manhwa-filter-canvas` ready plus `data-filter=crt`) at `+208.9ms`. Blank window is roughly 190ms.
- All 8 blank frames show the bridge decoded (`complete:true`, 690x1600) with opacity 0, no active image, column not ready, manhwa active.
- No `viewport-filter-change` fires between toggle and `+208.9ms`, proving the stale legacy marker covered the gap.
- Fetch, bitmap, and first paint (`+177.9` / `+189.4` / `+200.9` / `+208.9`) all behave normally. Nothing is slow. The frame is ready and hidden.

## Non-specified anomalies flagged

- 1 jank frame on the toggle step.
- The column canvas re-sets `data-render-ready=true` about every 14ms continuously on a static JPG column. The column repaints every frame. Not part of this issue, flagged separately.
- The reverse direction (manhwa to legacy) showed zero blanks across 4 runs. The bridge covers it because the image is cached. That direction needs nothing.

## Boundaries and open questions

- `viewerPipelines.js` owns the canvases and the marker, `viewerRender.js` owns the bridge pool, `manhwaStrip.js` owns strip DOM, `main.css` is the visual source of truth. No owner clears the marker on manhwa entry.
- Per `.agents/AGENTS.md`: one owner per concern, CSS as visual source of truth, no per-frame polling in prod (the probe polls Core each frame and must not ship).
- Open: clearing the marker on entry lets the parked bridge show until first column paint, then the paint re-sets it. That mirrors the clean reverse direction. Untested whether any same-notify path depends on the marker surviving entry.
