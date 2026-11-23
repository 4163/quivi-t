Validation comparison performed against .agents/AGENTS.md and .agents/skills/validate-changes/SKILL.md before presenting. Each slice below was checked for module ownership, pure-module direction, CSS source of truth, HTML-first rendering, blast radius with runnable checks, and docs discipline.

# Manhwa zoom reset and width fit position preservation plan

**Target:** Working tree in `src/js/viewer/manhwaStrip.js` with directory entry fit behaviors (Slices 1-3) completed.

**Scope lock:** Fix zoom reset (`x`) and width/1:1 fit modes (`width`, `width-if-larger`, `none`) so that under normal reading circumstances (not column edge cases or directory entry), view positions and reading progress are preserved. Do not touch legacy single-image rendering or viewer layout tokens. Keep existing edge latching intact when the column ends are legitimately active.

**Definitions.**
- **Normal circumstances:** The user is actively reading anywhere in the strip where neither the first image nor the last image requires edge latching (`_firstLastEdge() === 'neither'`), and the strip is not performing directory entry (`entry === false`).
- **Edge cases:** Column end boundary states (`_firstLastEdge() === 'first'` or `'last'`), or fresh directory entry (`entry === true`).
- **Zoom reset (`x`):** Restores zoom scale to 1:1 (`exactScale`) while keeping the column content under the viewport center fixed (content-anchored, never slot re-centering or edge latching).
- **Width and 1:1 fits (`width`, `width-if-larger`, `none`):** Sets zoom scale to the computed fit scale and resets horizontal offset (`tx = 0`), while keeping the column content under the viewport center fixed (content-anchored, no latching onto arbitrary image slots).

---

## Root causes and code analysis

1. **Unconditional slot re-centering in `resetZoom` (`src/js/viewer/manhwaStrip.js:1970-1985`):**
   When `resetZoom(exactScale)` is called:
   - Even when `edge === 'neither'`, `_anchorHoldover` is assigned to `_anchorImgIdx`.
   - In lines 1970-1985, if `_anchorHoldover !== null`, it unconditionally executes:
     ```javascript
     _centerColumnY(_layout.offsets[_anchorHoldover].top + _layout.offsets[_anchorHoldover].height / 2, 0);
     ```
   - This forcefully re-centers the nearby anchor slot in the viewport and resets `tx` to 0, completely breaking the user's reading position.
   - Under normal circumstances (`edge === 'neither'`), it should only reset zoom (`_viewportState.resetZoomOnly(exactScale)` or `zoomTo` without panning), preserving `tx` and `ty`.

2. **False edge latching on fit mode keys (`src/js/viewer/manhwaStrip.js:1728-1737`):**
   In `_applyFitMode`:
   - `LATCH_FIT_MODES` includes all fit modes (`['none', 'width', 'width-if-larger', ...]`).
   - When pressing `1` (`width`), `2` (`width-if-larger`), or `3` (`none`), `targetImgIdx` starts as `null`.
   - `_firstLastEdge()` calls `firstLastHighlight()`. If `primary === 0` (or `visStart <= 0`), `firstLastHighlight()` reports `'first'`.
   - This erroneously marks normal mid-column reading as an edge case, latching `targetImgIdx = 0` and jumping all the way to the top of the column via `_topAlignColumnY`.

3. **Vertical offset drift during width/none fits (`src/js/viewer/manhwaStrip.js:1796-1827`):**
   - Under normal circumstances, width fits and 1:1 fits should reset `tx = 0` (horizontal centering) but leave vertical offset `ty` untouched.
   - Calling `_viewportState.zoomTo(targetScale, vw / 2, vh / 2)` scales `_ty` relative to viewport center instead of maintaining the current column reading offset.
   - Setting `_anchorHoldover = _anchorImgIdx` triggers `_updateLayout` to subsequently shift `targetTy` toward slot centers.

---

## Behavioral specification

1. **Zoom reset (`x`):**
   - **Normal reading (`edge === 'neither'`):**
     - Only reset zoom scale to `exactScale` (1:1).
     - Keep the column content under the viewport center fixed (capture `centerColY` before, re-derive `ty` after; raw `ty` is scale-relative and clamps wildly on far jumps).
     - Never latch to an image or center an anchor slot.
     - `_anchorHoldover` must remain `null`.
   - **Edge cases (`edge === 'first'` or `'last'`):**
     - `edge === 'first'`: latch to top (`targetImgIdx = 0`, `alignTop = true`, `_topAlignColumnY`).
     - `edge === 'last'`: latch to bottom (`targetImgIdx = last`, `alignTop = false`, `_bottomAlignColumnY`).

2. **Fit width, width-if-larger, and none (`1`, `2`, `3`):**
   - **Normal reading (`edge === 'neither'`, `!entry`):**
     - Reset zoom scale to computed `targetScale`.
     - Reset horizontal position to 0 (`tx = 0`).
     - Keep the column content under the viewport center fixed (capture `centerColY` before `zoomTo`, then `panTo(0, anchoredTy)`).
     - Never latch onto images (do not set `targetImgIdx`, do not set `_anchorHoldover`).
   - **Edge cases (`edge === 'first'` or `'last'`, or `entry === true`):**
     - If `entry`: follow Behavior 1 or Behavior 2 entry specification.
     - If `edge === 'first'`: latch to top (`_topAlignColumnY`).
     - If `edge === 'last'`: latch to bottom (`_bottomAlignColumnY`).

---

## Ordered implementation slices

### Slice 1. Fix `resetZoom` in `manhwaStrip.js`
**Status:** `[x]` Done

Update `resetZoom(exactScale)` in `src/js/viewer/manhwaStrip.js:1935-1999`:
- [x] Evaluate `const edge = _firstLastEdge()`.
- [x] If `edge === 'first'` or `edge === 'last'`:
  - Preserve existing edge latching behavior (`targetImgIdx = 0` or `total - 1`, setting `_anchorHoldover` and re-pinning top/bottom).
- [x] If `edge === 'neither'` (normal circumstances):
  - Do NOT set `_anchorHoldover` (keep `_anchorHoldover = null`).
  - Do NOT select or update index in Core (`_anchorUpdateInProgress = false`).
  - Call `_viewportState.resetZoomOnly(exactScale)`, then re-derive `ty` from the pre-zoom `centerColY` so viewport content stays fixed (raw `ty` is scale-relative).
  - Do NOT call `_topAlignColumnY`, `_bottomAlignColumnY`, or `_centerColumnY`.
  - Maintain current transform: `_strip.style.transform = _viewportState.getTransform()`.
  - Update layout scale, grill angles, window, and settle schedule.

### Slice 2. Fix normal circumstances handling for width and none fits in `_applyFitMode`
**Status:** `[x]` Done

Update `_applyFitMode` in `src/js/viewer/manhwaStrip.js:1719-1840`:
- [x] Check if `!entry` and `['width', 'width-if-larger', 'none'].includes(fitMode)`:
  - If `_firstLastEdge() === 'neither'`:
    - Ensure `targetImgIdx` stays `null`.
    - Do NOT set `_anchorHoldover` (keep `_anchorHoldover = null`).
    - Capture `centerColY` (column content under viewport center) before zooming.
    - Apply the new zoom scale first via `_viewportState.zoomTo(targetScale, vw / 2, vh / 2)`, then restore content position and center horizontally via `_viewportState.panTo(0, anchoredTy)` where `anchoredTy` re-derives `ty` from `centerColY` (panTo sets position only, so zoom must land first).
    - Do NOT re-center column or slots vertically.
- [x] Preserve existing entry handling (`entry === true`) and boundary latching (`edge === 'first'` or `'last'`).

### Slice 3. Verification and regression check
**Status:** `[x]` Done (static checks green, runtime confirmed by user, no regression)

- [x] Run syntax check: `node --check src/js/viewer/manhwaStrip.js`.
- [x] Run mocha test suite: `npm run mocha`.
- [x] Run manual runtime tests:
  1. Scroll into middle of a manhwa chapter, zoom in/out, press `x` -> zoom resets to 1:1, reading content stays fixed (content-anchored, including far zoom jumps).
  2. Scroll into middle of chapter, pan horizontally, press `1` or `2` or `3` -> zoom updates, horizontal pan centers (`tx = 0`), reading content stays fixed.
  3. Scroll to absolute top (slot 0 visible), press `1` -> pins to top.
  4. Scroll to absolute bottom (last slot visible), press `1` -> pins to bottom.
