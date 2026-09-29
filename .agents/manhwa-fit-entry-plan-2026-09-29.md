Validation comparison performed against `.agents/AGENTS.md` and `.agents/skills/validate-changes/SKILL.md` before presenting. Each slice below was checked for module ownership, pure-module direction, CSS source of truth, HTML-first rendering, blast radius with runnable checks, and docs discipline. Findings are inline in the slice notes.

# Manhwa fit entry plan

**Target:** `feature/manhwa-view` at `bcef61e`, working tree clean.

**Scope lock:** Four fit behaviors on the manhwa strip plus test and replay loop coverage for them. Entry clamp for height-family fits. Width-span accuracy on entry. First and last highlight alignment for width-family fits and reset. Fit-change jump hardening. No new modules, no ownership moves, no architecture-state or README edits. New pure helpers live in `viewerMath.js`. Strip keeps owning its view. Deviations go here with reason and file.

**Definitions.** Entry means `_activate` in `src/js/viewer/manhwaStrip.js:1472`. Fit key means a fit change with no explicit target (`_applyFitMode(mode)` with `targetImgIdx === null`, `src/js/viewer/manhwaStrip.js:1188`). Reset means `Viewer.setZoom` in `src/js/viewer/viewer.js:89`. Highlight means primary (`Core.index` mapped through `_listToImgIdx`) or secondary (a list index inside `getVisibleImageIndices`, `src/js/viewer/manhwaStrip.js:1150`).

## Pipeline map

- Entry builds the index from estimates, lays out with the leftover single-image scale, then fits (`_activate`, `src/js/viewer/manhwaStrip.js:1472-1519`). Width-family fits top-align on entry (`STRIP_TOP_ALIGN_FITS`, `src/js/viewer/manhwaStrip.js:1163`). Everything else centers on the anchor.
- Fit scale comes from the whole column (`computeStripFitScale`, `src/js/services/viewerMath.js:546`, called at `src/js/viewer/manhwaStrip.js:1202` with full-column `rawSumH` and estimate-based `maxW`).
- Fit key keeps position (`src/js/viewer/manhwaStrip.js:1219-1228`). Reset bypasses the strip (`src/js/viewer/viewer.js:89-93`, plain `applyFitMode('none')` plus `zoomTo`, no holdover).
- Column width flows through `--strip-width` from `_layout.widestWidth` (`src/js/viewer/manhwaStrip.js:456`, consumed at `src/css/main.css:1453`). Slots size through `--slot-width` (`src/css/main.css:1492`).
- Fit scale is computed once from estimates and never recomputed when real dims land, except the ICO one-shot (`_fitRefreshPending`, `src/js/viewer/manhwaStrip.js:125,537,918`).
- Anchor writers are `zoomTo` cursor math, `panTo`, `_updateLayout` hold and end-pin branches (`src/js/viewer/manhwaStrip.js:400-460`), and the align helpers. All notifies are synchronous. Only `requestAnimationFrame` in `_requestLayout` (`src/js/viewer/manhwaStrip.js:902`) is async.
- Probes read single-image DOM only (`e2e/replay-diagnostics/probes/viewerPipelineProbe.js:14-20,142-178`). Nothing asserts `#manhwa-strip`. The contract test pins single-image IDs (`mocha/diagnosticsContract.test.js`). A `manhwa-buffer.json` scenario exists. Recorder captures dispatched commands and snapshots fit mode (`e2e/helpers/recorder-shim.js:330-353`).

## Slice 1. Clamp height-family fits to the active image on entry

**Status:** `[x]` Done 2026-09-29 in the working tree, user-confirmed in the running app. Entry flag threads through `_activate` and the container-reload reopen into `_applyFitMode`, which runs `computeStripFitScale` against active-image dims with item count 1 for height-family fits. Width fits, `none`, later fit presses, same-container reloads, and the single-image viewer are unchanged. `node --check` passes, `git diff --check` clean, `npm run mocha` passes with 247 tests.

Fit on entry uses whole-column math, so a height fit shrinks the active page until the full chapter fits the viewport. On entry the user looks at one image, so the fit should use that image.

- [ ] Add an entry flag to the fit path so entry behaves differently from later fit presses without changing current callsites. Thread it from `_activate` (`src/js/viewer/manhwaStrip.js:1515`) into `_applyFitMode` (`src/js/viewer/manhwaStrip.js:1188`).
- [ ] On entry with `height`, `height-if-larger`, `window`, or `window-if-larger`, call `computeStripFitScale` with the active item dims (`maxW` is active width, `rawSumH` is active height, `itemCount` is 1) instead of column totals. No new math helper. Estimates are fine here because the slot is not decoded yet.
- [ ] Keep width-family and `none` entry behavior exactly as now.
- [ ] Accept when enabling Manhwa View on a height fit shows the active image fitted to the viewport and centered, with the rest of the column reachable by scroll. Width fit entry is unchanged.

Validation note. Reuses the tested helper instead of new formulas, so no duplicated logic. Pure module direction holds. No CSS or DOM contract change, probes unaffected.

## Slice 2. Make width fit span the viewport on entry

**Status:** `[ ]`

Likely mechanism, still a hypothesis. Entry scale derives from estimate widths, then real dims land through `_onItemDecoded` and `_updateLayout` rebuilds geometry without ever recomputing fit scale. The column keeps estimate scale forever. The `_estWidth` propagation (`src/js/viewer/manhwaStrip.js:494-507`) updates slot widths but not scale, which matches the reported narrow column. Needs one runtime confirmation before building.

- [ ] Confirm with a probe or manual read whether entry scale uses fallback dims (`_viewport.clientWidth` zero or estimate `maxW`) versus resolved dims. Check `_viewport.clientWidth` right after the `manhwa-active` class lands and log `maxW` source at `src/js/viewer/manhwaStrip.js:1192-1193`.
- [ ] Add a one-shot estimate-resolution refit. Generalize the ICO `_fitRefreshPending` pattern (`src/js/viewer/manhwaStrip.js:125,537,918`) to width-family fits. When the first estimate resolves after entry, recompute scale from resolved widths through the same column-fit call and reapply once per container, holding the current anchor. Skip when the user already panned or zoomed after entry so nothing yanks the view.
- [ ] Accept when entering Manhwa View on width fit spans the column to the viewport width once images resolve, with no position jump and no repeated refits.

Validation note. One-shot flag scoped to the container keeps this out of the per-decode hot path. Reuses `_applyFitMode` and `computeStripFitScale`. Blast radius is entry plus first decode. Prove with the width-span probe below and `npm run mocha`.

## Slice 3. Align first and last highlights on width-family fits and reset

**Status:** `[ ]`

Strictly conditional. Only when the first or last directory image is highlighted, primary or secondary. Otherwise keep position.

- [ ] Add a pure helper in `viewerMath.js` that takes anchor index, visible start and end, and total, and answers first, last, both, or neither. Unit-testable, no DOM. Callers pass `_anchorImgIdx`, the already-computed visible range in `_updateWindow`, and `_imageIndex.length`.
- [ ] In the fit-key path (`src/js/viewer/manhwaStrip.js:1219-1228`) for `none`, `width`, and `width-if-larger`, top-align the first image when it is highlighted and bottom-align the last image when it is highlighted. When both are highlighted (short strip, everything visible), keep position.
- [ ] Route reset through the strip when active. `Viewer.setZoom` (`src/js/viewer/viewer.js:89-93`) calls the viewport directly today. Expose a strip reset that sets the same holdover a fit press would, then delegates to the shared viewport. Single-image behavior when the strip is inactive stays untouched.
- [ ] Accept when first highlighted plus width fit pins the first row to the top, last highlighted plus `none` pins the last row to the bottom, middle highlights keep position, and X matches the fit-key behavior in each case.

Validation note. New logic is pure and tested in `mocha/`. Strip keeps owning its view, `viewer.js` stays a thin facade that delegates. No probe DOM change.

## Slice 4. Harden fit and reset transitions against jumps

**Status:** `[ ]`

Ranked suspects. First, intermediate notifies inside `_applyFitMode` run `_updateLayout` with transient scale and ty, and its holdover and end-pin branches (`src/js/viewer/manhwaStrip.js:418-450`) can move ty before `panTo` targets offsets from that intermediate state. Second, reset sets no holdover, so its two notifies re-derive the anchor from the viewport center at scale 1 with whatever layout is current. Third, the `_fitRefreshPending` re-entry (`src/js/viewer/manhwaStrip.js:918-921`) reapplies fit mid-burst. Sync notifies cannot interleave with `requestAnimationFrame`, so decode flushes cannot land between `zoomTo` and `panTo`. They can land right after, reading post-sequence state, which is already handled.

- [ ] Record a fit-cycle scenario first (slice 5) and read the probe trace for ty and anchor teleports before changing logic. Fix from evidence, not speculation.
- [ ] Route reset through the strip holdover from slice 3, which removes the second suspect by construction.
- [ ] Gate the end-pin re-pin branches during fit sequences or make the re-entry preserve holdover and align-top, whichever the trace implicates. Smallest change that removes the teleport wins. No new abstractions.
- [ ] Accept when the scripted fit cycle shows no anchor or ty teleport in the probe trace and manual fit spam across a mixed-size folder never jumps.

Validation note. Touches shared pan and zoom behavior, so this is the highest blast-radius slice. Prove with the replay trace plus `npm run mocha`, one mocha file for viewer math, and `cargo check --tests` (no Rust changes expected, compile check only if touched).

## Slice 5. Keep the test suites and replay loop current

**Status:** `[ ]`

Extend the existing loop. No new harnesses.

- [ ] Mocha (`mocha/`, outside `src/`). Entry-scale cases for `computeStripFitScale` with `itemCount` 1. Cases for the slice 3 highlight helper. Cases pinning binary `computeWindowRange` behavior used by first and last detection.
- [ ] Contract (`mocha/diagnosticsContract.test.js`). Assert `#manhwa-strip` and spacer IDs from `src/index.html` and `src/js/viewer/manhwaStrip.js` so future DOM moves fail loud.
- [ ] Probes (`e2e/replay-diagnostics/probes/viewerPipelineProbe.js`). Add strip reads: strip transform ty, `--zoom-scale`, mounted slot count, spacer heights. No changes to existing single-image assertions.
- [ ] Scenarios (`e2e/scenarios/`). Record `manhwa-fit-entry.json` (enter on each fit), `manhwa-width-span.json`, `manhwa-first-last-align.json`, and `manhwa-fit-cycle.json` (fit spam plus X). All action IDs must already exist in `ACTION_MAP` or the contract test fails.
- [ ] Reports stay in `e2e/replay-diagnostics/reports/`. `investigation.js` is committed and intentional; leave it unless a slice needs it, then clean up per the verify skill.
- [ ] Accept when `npm run mocha` passes, `npm run diagnose -- manhwa-fit-cycle` reports no ty teleport, and the contract test passes.

## Verification

Per slice: `node --check` on touched JS, `npm run mocha`, nearest existing test, `git diff --check`. Full `cargo test` only if Rust is touched, which is not planned. Manual runtime list after all slices, plus the standing zoom-heartbeat verification. No commits unless asked. No architecture-state or README edits.
