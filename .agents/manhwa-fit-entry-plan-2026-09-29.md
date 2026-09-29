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

## Slice 3. Align first and last highlights on latch fit modes

**Status:** `[x]` Done 2026-09-29 in the working tree, user-confirmed in the running app. Expanded from width-family to all four latch modes (`width`, `width-if-larger`, `window`, `window-if-larger`) per user request. Reset (X) stayed out of scope.

Strictly conditional. Only when the first or last directory image is highlighted, primary or secondary. Primary outranks everything: a selected end clamps even with the whole column visible. When both ends are highlighted, ties resolve to whichever end is closer to the primary selection (no more 'both' return from `firstLastHighlight`). Otherwise keep position.

- [x] Pure helper `firstLastHighlight` in `viewerMath.js`: primary index, visible start and end, total in, first, last, or neither out. Both-visible ties break toward the closer end. Verified with a direct 9-case check. Formal mocha cases stay with slice 5.
- [x] `LATCH_FIT_MODES` constant (`src/js/viewer/manhwaStrip.js:1189`) covers `width`, `width-if-larger`, `window`, `window-if-larger`. `STRIP_TOP_ALIGN_FITS` stays width-only for entry/toggle anchor alignment.
- [x] Fit-key path for all four latch modes: edge evaluated before the fit zoom moves the visible window, `targetImgIdx` and `alignTop` resolved before `zoomTo`, `_anchorImgIdx` and `Core.selectIndex` updated synchronously when latching, `_syncAnchorToCore` called post-zoom so status bar and file panel follow immediately.
- [x] `_firstLastEdge` falls back to `_anchorImgIdx` when `Core.getState().index` has no image mapping, so the edge check works regardless of whether the primary selection is on an image row.
- [x] Entry and container reopen: same rule through a primary-only override for all four latch modes.
- [x] Edge-hold during zoom: viewport subscriber holds the anchor at the primary selection when it sits at a column edge (first or last) and is still visible, instead of re-deriving from viewport center. Prevents anchor drift from 0-12 to 4-16 during continuous zoom at an edge. (`src/js/viewer/manhwaStrip.js:750-762`).
- [x] Accept when first highlighted plus any latch fit pins the first row to the top, last highlighted pins the last row to the bottom, middle highlights keep position, and zooming with an edge selected holds position. Regression on M-key toggle fixed: `STRIP_TOP_ALIGN_FITS` reverted to width-only so window fits center the anchor on toggle/entry.

## Slice 4. Harden fit, reset, and toggle transitions against jumps

**Status:** `[x]` Done 2026-09-29 in the working tree. Reset (X) fixed with `resetZoom` export. Remaining items marked YAGNI after runtime confirmation: no layout jank, no anchor jumping, no file list drift, even under stress with heavy archives (large dims, zip/rar decode storms).

Re-triaged twice: the jump reproduces most often when switching Manhwa View on and off, and it also hits on zoom reset (X), so X joins as a trigger site with its zoom semantics untouched. Confirmed 2026-09-29 in the running app: spamming M on `window` or `window-if-larger` jumps to a random position, while spamming M on `height` or `height-if-larger` holds position. That split points at width-driven scale change plus top-align handling, not at the shared toggle path. Ranked suspects. First, `_syncAnchorToCore` clamps a holdover into the visible range on every settle and heartbeat even when the view never moved, so the anchor chases decode drift. Second, entry lays out before resolving the anchor, so the first window derives from the stale default. Third, reset (`Viewer.setZoom`, `src/js/viewer/viewer.js:89-93`) drives the raw viewport with no holdover, so the subscription re-derives the anchor from the viewport center at scale 1 against whatever layout is current. On cold estimates that lands anywhere. Fourth, a fit press can clear its own holdover: its internal `zoomTo` moves ty, the nested window update reads that as a manual pan outside any sequence guard, and the anchor re-derives from the transient center before the tail runs. Fifth, the one-shot entry refresh replays on first width resolve (`src/js/viewer/manhwaStrip.js:522,935-943`), which moves scaleX and therefore the `window` scale, while `height` scale never reads width. Agreed convention 2026-09-29: fit application centers the anchor for every fit except width, and top placement belongs to file-list selection only, so `STRIP_TOP_ALIGN_FITS` is width-only and window shares height centering exactly. Sixth, `_updateLayout` writes through `setDimensions` (`src/js/viewer/manhwaStrip.js:460`), which notifies synchronously, so the nested window update reads the hold correction itself as a manual pan, clears the holdover, and re-derives the anchor from the viewport center. Candidate fix is a programmatic-viewport guard around `_updateLayout` plus `_applyFitMode`, still to be confirmed against the trace at implementation time. Seventh, zoom-at-edge drift where the holdover expires on scale mismatch and the anchor re-derives from viewport center, fixed in slice 3 with the edge-hold check in the viewport subscriber.

- [~] YAGNI. Resolve the open anchor before the first `_updateLayout` in `_activate` and in the container-reload reopen. No reproducing jump on activate after the latching and edge-hold fixes.
- [~] YAGNI. Clamp a holdover into the visible range in `_syncAnchorToCore` only when the view moved since the last sync. Stress-tested with heavy archives (large dims, zip/rar) and found no layout jank or anchor drift.
- [x] Found cause, fixed 2026-09-29: the slice 1 clamp had overstepped onto toggling the view on, forcing a fit re-press to recover legacy behavior, and that re-press jumped. directory opens keep the clamp, toggles keep legacy fits, and the one-shot refresh replays whichever semantics armed it.
- [x] Hold the current anchor across reset when the strip is active. Added `resetZoom` export in `src/js/viewer/manhwaStrip.js:1462-1505`, called from `Viewer.setZoom` in `src/js/viewer/viewer.js:89-95` when the strip is active. Stamps the current anchor as holdover at the target scale, zooms under `_viewportProgram` guard, then re-pins the anchor at its layout offset so ty stays stable. Reset still lands at scale 1. Nothing else about X changes.
- [~] YAGNI. Fix M spam on `window` and `window-if-larger`. User confirmed M spamming no longer breaks anything after the upstream fixes (latching, edge-hold, STRIP_TOP_ALIGN_FITS revert, resetZoom).
- [x] Accept: toggling Manhwa View on lands consistently, fit spam plus X holds position, M spam on all fits holds position. Confirmed 2026-09-29 in the running app.

Validation note. Touches shared pan and zoom behavior, so this is the highest blast-radius slice. Prove with the replay trace plus `npm run mocha`, one mocha file for viewer math, and `cargo check --tests` (no Rust changes expected, compile check only if touched).

## Post-slice fix: mount queue race on rapid navigation

**Status:** `[x]` Done 2026-09-29, user-confirmed. Two fixes.

Images failed to mount ~15-25% of the time on directory open, requiring a zoom/pan/scroll to recover. Root cause traced with a temporary `window.__stripDebug` probe and `[MOUNT]` trace logs (both removed after diagnosis).

- [x] **Flight ownership in `drop()`.** `drop()` unconditionally reset `_mountInFlight = -1`, which clobbered a newer container's in-progress flight when a stale `await pre.decode()` from the previous container completed. Now `drop()` only resets `_mountInFlight` if it still matches `entry.imgIdx`. (`src/js/viewer/manhwaStrip.js:1013-1018`).
- [x] **Subscriber guard during programmatic viewport changes.** The viewport subscriber skips `_updateWindow()` and `_scheduleSettle()` while `_viewportProgram > 0`. Intermediate `zoomTo`/`panTo` ticks inside `_applyFitMode` were starting mount flights at transient ty values whose slots got evicted by the next tick's visible range shift. The caller's explicit `_updateWindow()` at the end handles mounting with the final ty. (`src/js/viewer/manhwaStrip.js:1927-1932`).

## Post-slice fix: first/last latch for fit none

**Status:** `[x]` Done 2026-09-29, user-confirmed.

In `none` (natural size) mode, navigating to the first or last image centered in Y instead of latching to top/bottom. Three sites fixed:

- [x] Added `'none'` to `LATCH_FIT_MODES` so entry and fit-key paths check first/last and latch to top/bottom. (`src/js/viewer/manhwaStrip.js:1198`).
- [x] `navigateManhwa` now calls `alignListItemBottom` for the last image instead of `alignListItemTop`. (`src/js/viewer/manhwaStrip.js:1522-1524`).
- [x] External index change in `_onStateChange` (panel click/keyboard) now bottom-aligns the last image. (`src/js/viewer/manhwaStrip.js:1907-1911`).

## Post-slice fix: fit-none anchor clobber on manhwa toggle-off

**Status:** `[x]` Done 2026-09-29, user-confirmed.

Toggling manhwa off after pressing R (fit none) jumped the page index to center (~62 of 126) instead of staying on the original page. Root cause traced with `[ANCHOR]` logs (removed after diagnosis).

When M toggles manhwa off, `Core.notify` fires. The single-image viewer (`viewerRender.js`) reacts first and calls `applyFitMode` on the shared viewport state, producing a massive ty delta (~75,000px). The manhwa strip's viewport subscriber was still active (`_active = true`, `_deactivate` hadn't run yet). It saw the delta, cleared the holdover, re-derived the anchor to center, and synced `Core.selectIndex(63)`.

- [x] **Subscriber Core-state gate.** The viewport subscriber now checks `Core.getState().manhwaEnabled` before running `_updateWindow` / `_scheduleSettle` when `_viewportProgram === 0`. When manhwa is already disabled in Core (but `_deactivate` hasn't run yet), the subscriber skips the update, preventing holdover clearing and anchor re-derivation. (`src/js/viewer/manhwaStrip.js:1942-1949`).

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
