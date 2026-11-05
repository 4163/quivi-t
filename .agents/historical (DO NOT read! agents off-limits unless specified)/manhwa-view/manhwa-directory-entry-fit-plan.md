Validation comparison performed against .agents/AGENTS.md and .agents/skills/validate-changes/SKILL.md before presenting. Each slice below was checked for module ownership, pure-module direction, CSS source of truth, HTML-first rendering, blast radius with runnable checks, and docs discipline.

# Manhwa directory entry fit refactor implementation plan

**Target:** Working tree with active background width scanner in `src-tauri/` and `src/js/viewer/manhwaStrip.js`.

**Scope lock:** Centralize and refactor directory entry fit behaviors in manhwa strip mode (`#manhwa-strip`). Cleanly separate and centralize the two distinct fit behaviors (Behavior 1: Whole-Column/Default, and Behavior 2: First-Image Entry) to prevent edge-case pipeline regressions. Do not touch legacy single-image rendering or viewer layout tokens. Keep existing UX refinements intact: edge latching via `_firstLastEdge()`, 5% zoom floor on full column height fits, slot centering when `slotH <= vh`, and chapter-start top alignment.

**Definitions.**
- **Behavior 1 (Whole-Column / Default):** Applied when entering a directory with `open_first_image` disabled, clicking an item in the file panel, or pressing fit shortcut keys (`1`-`7`). Sizing evaluates against the entire column dimensions (`widestWidth`, total column height with seam compensations, and total item count).
- **Behavior 2 (First-Image Entry):** Applied when entering a directory with `open_first_image` enabled (`openFirst && anchor === 0`). Sizing evaluates against the first image in the directory for height and window fit families, while inheriting Behavior 1 column sizing for width and 1:1 fits.
- **Entry refresh:** The deferred one-shot refit triggered when real image dimensions arrive from decode or when backend width sweep completes, reconciling preliminary estimated dimensions without jarring the user viewport.

---

## Pipeline map and identified issues

1. **Premature return on unselected entry (`src/js/viewer/manhwaStrip.js:2428-2433`):**
   When `open_first_image` is false, `_resolveOpenAnchor` returns `-1`. The container-change block executed `if (_anchorImgIdx < 0) { _applyFitMode(_lastFitMode); return; }`. This skipped `_fireScan()` (so background width sweep never ran), skipped `_updateWindow()` (so initial visible slots were not prepared), and skipped `_scheduleSettle()`.

2. **Inline dimension resolution mixing (`src/js/viewer/manhwaStrip.js:1695-1734`):**
   `_applyFitMode` interweaves dimension extraction, fallback estimates, latching, top-alignment, anchor selection, and `ENTRY_ACTIVE_FITS` ternaries across 80 lines. This tightly couples scale calculation to viewport manipulation.

3. **Decode refresh gating (`src/js/viewer/manhwaStrip.js:1160-1200`):**
   When the first raster image finishes decoding in `_onItemDecoded`, `_entryRefreshEntry` was only evaluated if `_anchorImgIdx >= 0`. For unselected entries or delayed container scans, the layout was updated but the entry fit scale was not cleanly refreshed against exact dimensions.

---

## Behavioral specification

### Behavior 1: Entering a directory with `open_first_image` disabled (Default / Whole-column)
Occurs when opening a directory with `open_first_image` turned off, clicking an item in the file list, or pressing individual fit keys (default behavior):
- **width**: Takes up 100% of the `#viewport` width (`vw / maxW`).
- **width if larger**: 1:1 scale, but if the widest image in the column is wider than `#viewport`, sizes to 100% of `#viewport` width.
- **none**: Always 1:1 scale.
- **height**: Takes up 100% of the `#viewport` height relative to the column height; if the column height exceeds `#viewport` height, zoom is capped at a 5% floor (`max(0.05, vh / colH)`).
- **height if larger**: 1:1 scale, but if column height is taller than `#viewport` height, sizes to 100% of `#viewport` height capped at 5% zoom.
- **window**: 1:1 scale based on the column, but fits either width or height to 100% depending on whichever reaches viewport edges first (`min(scaleX, scaleY)`).
- **window if larger**: 1:1 scale based on the column, but if either hits viewport edges, sizes to 100% based on whichever reaches edges first (`min(1, scaleX, scaleY)`).

### Behavior 2: Entering a directory with `open_first_image` enabled (First-image entry)
Occurs when opening a directory with `open_first_image` turned on, where the user opens the first image and then scrolls through subsequent images:
- **height**: Takes up 100% of the `#viewport` height relative to the first image of the directory (`vh / firstImageH`).
- **height if larger**: 1:1 scale, but if the first image is taller than `#viewport`, sizes to 100% of `#viewport` height.
- **window**: 1:1 scale based on the first image, but fits either width or height to 100% depending on whichever reaches viewport edges first.
- **window if larger**: 1:1 scale based on the first image, but if either reaches viewport edges, sizes to 100% based on whichever reaches edges first.
- **width**: Inherits Behavior 1 (whole-column width fit).
- **width if larger**: Inherits Behavior 1 (whole-column width if larger fit).
- **none**: Inherits Behavior 1 (1:1 fit).

### Specification matrix

| Fit Mode | Behavior 1 (Whole-Column / Default) | Behavior 2 (First-Image Entry: `open_first_image: true`) |
| :--- | :--- | :--- |
| `width` | 100% of `#viewport` width (`vw / maxW`) | Inherits Behavior 1 (`vw / maxW`) |
| `width-if-larger` | 1:1, but if column widest width > `vw`, 100% of `#viewport` width (`min(1, vw / maxW)`) | Inherits Behavior 1 (`min(1, vw / maxW)`) |
| `none` | Always 1:1 (`scale = 1`) | Inherits Behavior 1 (`scale = 1`) |
| `height` | 100% of `#viewport` height relative to whole column height, capped at min 5% zoom | 100% of `#viewport` height relative to first image (`vh / firstH`) |
| `height-if-larger` | 1:1, but if whole column height > `vh`, 100% of `#viewport` height capped at min 5% zoom | 1:1, but if first image > `vh`, 100% of `#viewport` height |
| `window` | 1:1 based on column, scaling to 100% of whichever hits viewport edges first (`min(scaleX, scaleY)`) | 1:1 based on first image, scaling to 100% of whichever hits viewport edges first |
| `window-if-larger` | 1:1 based on column, but if either hits viewport edges, 100% of whichever hits first (`min(1, scaleX, scaleY)`) | 1:1 based on first image, but if either hits viewport edges, 100% of whichever hits first |


---

## Ordered implementation slices

### Slice 1. Centralize fit scale resolution helper
**Status:** `[x]` Done

Extract fit scale derivation out of `_applyFitMode` into a pure, testable helper `_resolveStripFitScale(fitMode, isEntryFirstImage, anchorIdx)` in `src/js/viewer/manhwaStrip.js`.

- [x] Define `_resolveStripFitScale(fitMode, isEntryFirstImage, anchorIdx)` before `_applyFitMode`.
- [x] If `isEntryFirstImage` is true and `ENTRY_ACTIVE_FITS.includes(fitMode)`:
  - Retrieve target item at `anchorIdx` (default index 0).
  - Target `itemCount = 1`, `maxW = item.naturalWidth || _widthEstimate()`, `rawSumH = item.naturalHeight || DEFAULT_ESTIMATED_HEIGHT`.
- [x] Otherwise (Behavior 1, or `width`/`none` in Behavior 2):
  - Target whole column: `itemCount = _imageIndex.length`, `maxW = _layout.widestWidth || _widthEstimate()`, `rawSumH = columnHeightSum`.
- [x] Call `computeStripFitScale` from `services/viewerMath.js` with computed dimensions and return `targetScale`.
- [x] Simplify `_applyFitMode` to call `_resolveStripFitScale` for scale resolution, keeping viewport pan and alignment cleanly separated.

### Slice 2. Fix container change entry pipeline in `_onStateChange`
**Status:** `[x]` Done

Eliminate the premature return in `_onStateChange` so unselected container opens (`open_first_image: false`) still initiate background scans, arm entry refresh, and populate initial slot geometry.

- [x] In `src/js/viewer/manhwaStrip.js:2428-2442`, remove early `return;` when `_anchorImgIdx < 0`.
- [x] Branch clean entry handling:
  - If `_anchorImgIdx < 0` (Behavior 1 entry):
    - Run `_applyFitMode(_lastFitMode, null, false, false)`.
    - Arm entry refresh for column mode: `_armEntryRefresh(false)`.
  - If `_anchorImgIdx >= 0` (Behavior 2 entry when `openAtStart`, or keyed item entry):
    - Determine `isFirstImageEntry = openAtStart && openFirst`.
    - Run `_applyFitMode(_lastFitMode, _anchorImgIdx, STRIP_TOP_ALIGN_FITS.includes(_lastFitMode) && openAtStart, isFirstImageEntry)`.
    - Arm entry refresh: `_armEntryRefresh(isFirstImageEntry)`.
- [x] Call `_fireScan()`, `_updateWindow()`, and `_scheduleSettle()` unconditionally for both paths.
- [x] Mirror the same clean flow in `_activate(state)` (`src/js/viewer/manhwaStrip.js:2176-2190`).

### Slice 3. Reconcile entry refresh on decode and scan arrival
**Status:** `[x]` Done, plus replay-driven follow-ups (stale hydration removed, entry re-arm until target decoded, ICO refit replays sticky entry intent)

Ensure that when first image raster dimensions decode or when the backend width sweep reports a new max width, entry scale updates smoothly without disrupting active user panning.

- [x] In `_onItemDecoded` (`src/js/viewer/manhwaStrip.js`):
  - Allow pending entry refresh to execute if the decoded item affects the active entry target (the first image for Behavior 2, or any image expanding `_layout.widestWidth` for Behavior 1).
  - Respect the quiet guard: do not apply if user has actively panned (`now - _lastPanAt < 150`).
- [x] In `_onMaxWidthReport` (`src/js/viewer/manhwaStrip.js`):
  - Re-evaluate fit scale via `_resolveStripFitScale` if width modes (`width`, `width-if-larger`, `window`, `window-if-larger`) are active.

### Slice 4. Verification and blast radius validation
**Status:** `[x]` Done (`node --check`, mocha 303 passing, replay `manhwa-directory-entry-fits` with zero entry mismatches)

Verify all targeted test suites and validate changes against AGENTS.md rules.

- [x] Run syntax check: `node --check src/js/viewer/manhwaStrip.js`.
- [x] Run unit test suite: `npm run mocha` (must pass 303/303 tests).
- [x] Run Rust compilation check: `cargo check --tests`.
- [x] Run backend format tests: `cargo test format_tests`.
- [x] Perform manual runtime scenario checks:
  1. Open directory with `open_first_image: false` in `width`, `height`, and `window` fits.
  2. Open directory with `open_first_image: true` in `height` and `window` fits (verifying first image fits viewport exactly).
  3. Press fit keys `1`-`7` in both modes (verifying whole column scaling behavior).
- [x] Run validation review against `.agents/skills/validate-changes/SKILL.md`.
