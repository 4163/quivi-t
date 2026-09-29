Validation comparison performed against `.agents/AGENTS.md` and `.agents/skills/validate-changes/SKILL.md` before presenting. Each slice below was checked for module ownership, pure-module direction, CSS source of truth, HTML-first rendering, blast radius with runnable checks, and docs discipline. Findings are inline in the slice notes.

# Manhwa fit entry plan

**Target:** `feature/manhwa-view` at `bcef61e`, working tree clean.

**Scope lock:** Four fit behaviors on the manhwa strip plus test and replay loop coverage for them. Entry clamp for height-family fits. Width-span accuracy on entry. First and last highlight alignment for width-family fits. Jump hardening for fit changes, zoom reset, and Manhwa View on and off toggles, where the jump reproduces most often. Reset (X) zoom semantics stay untouched; only its jump path is in scope. No new modules, no ownership moves, no architecture-state or README edits. New pure helpers live in `viewerMath.js`. Strip keeps owning its view. Deviations go here with reason and file.

**Definitions.** Entry means `_activate` in `src/js/viewer/manhwaStrip.js:1472`. Fit key means a fit change with no explicit target (`_applyFitMode(mode)` with `targetImgIdx === null`, `src/js/viewer/manhwaStrip.js:1188`). Reset means `Viewer.setZoom` in `src/js/viewer/viewer.js:89`. Highlight means primary (`Core.index` mapped through `_listToImgIdx`) or secondary (a list index inside `getVisibleImageIndices`, `src/js/viewer/manhwaStrip.js:1150`).

## Pipeline map

- Entry builds the index from estimates, lays out with the leftover single-image scale, then fits (`_activate`, `src/js/viewer/manhwaStrip.js:1472-1519`). Width-family fits top-align on entry (`STRIP_TOP_ALIGN_FITS`, `src/js/viewer/manhwaStrip.js:1163`). Everything else centers on the anchor.
- Fit scale comes from the whole column (`computeStripFitScale`, `src/js/services/viewerMath.js:546`, called at `src/js/viewer/manhwaStrip.js:1202` with full-column `rawSumH` and estimate-based `maxW`).
- Fit key keeps position (`src/js/viewer/manhwaStrip.js:1219-1228`). Reset bypasses the strip (`src/js/viewer/viewer.js:89-93`, plain `applyFitMode('none')` plus `zoomTo`, no holdover).
- Column width flows through `--strip-width` from `_layout.widestWidth` (`src/js/viewer/manhwaStrip.js:456`, consumed at `src/css/main.css:1453`). Slots size through `--slot-width` (`src/css/main.css:1492`).
- Fit scale is computed once from estimates and never recomputed when real dims land, except the ICO one-shot (`_fitRefreshPending`, `src/js/viewer/manhwaStrip.js:125,537,918`).
- Anchor writers are `zoomTo` cursor math, `panTo`, `_updateLayout` hold and end-pin branches (`src/js/viewer/manhwaStrip.js:400-460`), and the align helpers. All notifies are synchronous. Only `requestAnimationFrame` in `_requestLayout` (`src/js/viewer/manhwaStrip.js:902`) is async.
- Settle and heartbeat clamp a holdover into the visible range and write it back to `_anchorImgIdx`. When the view never moved and only layout shifted under it, that clamp chases a moving window. Entry lays out before resolving the anchor, so the first window derives from the stale default anchor. Both feed the toggle jump in slice 4.
- `_updateLayout` now tracks post-clamp ty instead of requested ty, so clamping can no longer phantom-trip a manual pan that clears the holdover.
- Probes read single-image DOM only (`e2e/replay-diagnostics/probes/viewerPipelineProbe.js:14-20,142-178`). Nothing asserts `#manhwa-strip`. The contract test pins single-image IDs (`mocha/diagnosticsContract.test.js`). A `manhwa-buffer.json` scenario exists. Recorder captures dispatched commands and snapshots fit mode (`e2e/helpers/recorder-shim.js:330-353`).

## Slice 1. Clamp height-family fits to the active image on entry

**Status:** `[x]` Done 2026-09-29 in the working tree, user-confirmed in the running app. Entry flag threads through the container-reload reopen into `_applyFitMode`, which runs `computeStripFitScale` against active-image dims with item count 1 for height-family fits. Scoped back out of `_activate` after it overstepped: toggling the view keeps legacy whole-column fits, the clamp is directory-open only. Toggle scoping user-confirmed in the running app. Width fits, `none`, later fit presses, same-container reloads, and the single-image viewer are unchanged. `node --check` passes, `git diff --check` clean, `npm run mocha` passes with 247 tests.

Fit on entry uses whole-column math, so a height fit shrinks the active page until the full chapter fits the viewport. On entry the user looks at one image, so the fit should use that image.

- [x] Add an entry flag to the fit path so entry behaves differently from later fit presses without changing current callsites. Thread it from `_activate` (`src/js/viewer/manhwaStrip.js:1515`) into `_applyFitMode` (`src/js/viewer/manhwaStrip.js:1188`).
- [x] On entry with `height`, `height-if-larger`, `window`, or `window-if-larger`, call `computeStripFitScale` with the active item dims (`maxW` is active width, `rawSumH` is active height, `itemCount` is 1) instead of column totals. No new math helper. Estimates are fine here because the slot is not decoded yet.
- [x] Keep width-family and `none` entry behavior exactly as now.
- [x] Accept when enabling Manhwa View on a height fit shows the active image fitted to the viewport and centered, with the rest of the column reachable by scroll. Width fit entry is unchanged.

Validation note. Reuses the tested helper instead of new formulas, so no duplicated logic. Pure module direction holds. No CSS or DOM contract change, probes unaffected.

## Slice 2. Make width fit span the viewport on entry

**Status:** `[x]` Done 2026-09-29 in the working tree, user-confirmed in the running app. One-shot entry refit armed on entry for non-`none` fits. The first resolved raster width replays the entry fit once against real dims in the decode flush, holding the current anchor. It stands down on any pan, zoom, fit change, reload, or deactivation, and same-container reloads never arm it. ICO refresh keeps priority. `node --check` passes, `git diff --check` clean, `npm run mocha` passes with 247 tests.

Likely mechanism, still a hypothesis. Entry scale derives from estimate widths, then real dims land through `_onItemDecoded` and `_updateLayout` rebuilds geometry without ever recomputing fit scale. The column keeps estimate scale forever. The `_estWidth` propagation (`src/js/viewer/manhwaStrip.js:494-507`) updates slot widths but not scale, which matches the reported narrow column. Needs one runtime confirmation before building.

- [x] Confirm with a probe or manual read whether entry scale uses fallback dims (`_viewport.clientWidth` zero or estimate `maxW`) versus resolved dims. Check `_viewport.clientWidth` right after the `manhwa-active` class lands and log `maxW` source at `src/js/viewer/manhwaStrip.js:1192-1193`.
- [x] Add a one-shot estimate-resolution refit. Generalize the ICO `_fitRefreshPending` pattern (`src/js/viewer/manhwaStrip.js:125,537,918`) to width-family fits. When the first estimate resolves after entry, recompute scale from resolved widths through the same column-fit call and reapply once per container, holding the current anchor. Skip when the user already panned or zoomed after entry so nothing yanks the view.
- [x] Accept when entering Manhwa View on width fit spans the column to the viewport width once images resolve, with no position jump and no repeated refits.

Validation note. One-shot flag scoped to the container keeps this out of the per-decode hot path. Reuses `_applyFitMode` and `computeStripFitScale`. Blast radius is entry plus first decode. Prove with the width-span probe below and `npm run mocha`.

## Slice 3. Align first and last highlights on width-family fits

**Status:** `[x]` Done 2026-09-29 in the working tree, user-confirmed in the running app. Reset (X) stayed out of scope.

Strictly conditional. Only when the first or last directory image is highlighted, primary or secondary. Otherwise keep position.

- [x] Pure helper `firstLastHighlight` in `viewerMath.js`: primary index, visible start and end, total in, first, last, both, or neither out. Verified with a direct 9-case check. Formal mocha cases stay with slice 5.
- [x] Fit-key path for `none`, `width`, and `width-if-larger`: a settle sync runs first so panel and strip decide on the same live state, the edge is evaluated before the fit zoom moves the visible window, then first top-aligns and last bottom-aligns. Both highlighted keeps position.
- [x] Entry and container reopen: same rule through a primary-only override, since there is no meaningful visible range before the first fit. TEMP-log round proved the edge itself correct; the misses were decided on drifted middle state, which the pre-sync and the ty read-back above close.
- [x] Accept when first highlighted plus width fit pins the first row to the top, last highlighted plus `none` pins the last row to the bottom, and middle highlights keep position. Test by pressing fit keys on an open strip and by opening folders with the fit already set.

## Slice 4. Harden fit, reset, and toggle transitions against jumps

**Status:** `[ ]`

Re-triaged twice: the jump reproduces most often when switching Manhwa View on and off, and it also hits on zoom reset (X), so X joins as a trigger site with its zoom semantics untouched. Confirmed 2026-09-29 in the running app: spamming M on `window` or `window-if-larger` jumps to a random position, while spamming M on `height` or `height-if-larger` holds position. That split points at width-driven scale change plus top-align handling, not at the shared toggle path. Ranked suspects. First, `_syncAnchorToCore` clamps a holdover into the visible range on every settle and heartbeat even when the view never moved, so the anchor chases decode drift. Second, entry lays out before resolving the anchor, so the first window derives from the stale default. Third, reset (`Viewer.setZoom`, `src/js/viewer/viewer.js:89-93`) drives the raw viewport with no holdover, so the subscription re-derives the anchor from the viewport center at scale 1 against whatever layout is current. On cold estimates that lands anywhere. Fourth, a fit press can clear its own holdover: its internal `zoomTo` moves ty, the nested window update reads that as a manual pan outside any sequence guard, and the anchor re-derives from the transient center before the tail runs. Fifth, the one-shot entry refresh replays on first width resolve (`src/js/viewer/manhwaStrip.js:522,935-943`), which moves scaleX and therefore the `window` scale, while `height` scale never reads width. Agreed convention 2026-09-29: fit application centers the anchor for every fit except width, and top placement belongs to file-list selection only, so `STRIP_TOP_ALIGN_FITS` is width-only and window shares height centering exactly. Sixth, `_updateLayout` writes through `setDimensions` (`src/js/viewer/manhwaStrip.js:460`), which notifies synchronously, so the nested window update reads the hold correction itself as a manual pan, clears the holdover, and re-derives the anchor from the viewport center. Candidate fix is a programmatic-viewport guard around `_updateLayout` plus `_applyFitMode`, still to be confirmed against the trace at implementation time.

- [ ] Resolve the open anchor before the first `_updateLayout` in `_activate` and in the container-reload reopen. Hold the resolved anchor through the first layout instead of the stale default.
- [ ] Clamp a holdover into the visible range in `_syncAnchorToCore` only when the view moved since the last sync. Snapshot ty, scale, and viewport height per sync. Layout-only drift keeps the anchor untouched.
- [x] Found cause, fixed 2026-09-29: the slice 1 clamp had overstepped onto toggling the view on, forcing a fit re-press to recover legacy behavior, and that re-press jumped. directory opens keep the clamp, toggles keep legacy fits, and the one-shot refresh replays whichever semantics armed it.
- [ ] Hold the current anchor across reset when the strip is active, through a tiny strip export called from `Viewer.setZoom` before it touches the viewport. Reset still lands at scale 1 through the same viewport calls. Nothing else about X changes.
- [ ] Fix M spam on `window` and `window-if-larger`. Repro is toggling Manhwa View off and on repeatedly with a window fit active. The strip must keep the pre-toggle anchor and its top alignment across the deactivate plus activate pair and across the width-driven one-shot replay that follows. Scope is `src/js/viewer/manhwaStrip.js:522,935-943,1250-1361,1577-1627`. Accept when ten rapid M toggles on a mixed-size folder never move the anchor or ty on window fits, and height fits stay put as today.
- [ ] Accept when toggling Manhwa View on lands on the active image across repeated trials with cold estimates, fit spam plus X across a mixed-size folder never jumps, M spam on window fits holds position across ten toggles, and the scripted fit cycle from slice 5 shows no anchor or ty teleport.

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
