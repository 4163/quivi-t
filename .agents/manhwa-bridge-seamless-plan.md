Validation comparison performed against .agents/AGENTS.md and .agents/skills/validate-changes/SKILL.md before presenting. Each slice below was checked for module ownership, pure-module direction, CSS source of truth, HTML-first rendering, blast radius with runnable checks, and docs discipline. Findings are inline in the slice notes.

# Manhwa bridge seamless transition implementation plan

**Target:** `feature/manhwa-view`, working tree clean.

**Scope lock:** Eliminate visual flicker, blank blackout frames, premature bridge retirement, and coordinate jumping during viewer mode toggles between legacy single-image (`l`) and manhwa strip (`m`) across all fit modes (`none`, `width`, `width-if-larger`, and height/window variants). Existing single-image bridging stays intact. No new modules, no architecture-state or README edits during implementation. `viewerRender.js` retains sole ownership of `#viewer-bridge-layer` and single-image pool nodes. `manhwaStrip.js` retains sole ownership of `#manhwa-strip` and `.manhwa-active`. `viewer.js` coordinates lifecycle handoffs. Deviations go here with reason and file.

**Definitions.** Legacy view means the single-image viewport managed by `src/js/viewer/viewerRender.js`. Manhwa view means the continuous vertical strip managed by `src/js/viewer/manhwaStrip.js`. Bridge layer means `#viewer-bridge-layer` in `src/index.html`. Anchor image means the primary active image selected in `Core.getState().index` and mapped to `_anchorImgIdx` in manhwa view. Target geometry means the `{ tx, ty, scale, rotation, flipX, flipY }` transform computed for the destination view by `viewportState`.

---

## Pipeline map

- In `src/js/viewer/manhwaStrip.js:773-884`, `_updateWindow()` computes `startIndex = Math.max(0, anchor - STRIP_BEHIND_COUNT)`. For any `anchor > 0`, `startIndex` is `anchor - 1`.
- When first activating manhwa from legacy, `prefetchDir === 0`. The sort condition `if (prefetchDir !== 0) _sortMountQueue(anchor, prefetchDir)` is skipped, leaving `_mountQueue` in ascending index order: `[anchor - 1, anchor, anchor + 1]`.
- Slot `anchor - 1` (positioned off-screen above the viewport) decodes off-DOM in `_mountInFlight` ahead of the visible `anchor` slot.
- In `src/js/viewer/viewer.js:41-50`, `setOnSlotMounted` ignores `imgIdx`. As soon as off-screen slot `anchor - 1` mounts, `viewer.js` schedules `_doubleRaf(() => renderer.releaseBridge())`, destroying `#viewer-bridge-layer` before `anchor` finishes decoding off-DOM, causing a blank frame / blackout.
- In `src/js/viewer/manhwaStrip.js:2118-2160`, `_deactivate()` attempts to hand off `anchorNode` on `m -> l` toggle. If `anchor` has not yet mounted, it falls back to `_mounted.values().next()?.value` (the wrong file) or fails handoff completely, producing 7 consecutive blackout frames (83.3ms) in legacy view.
- In `src/js/viewer/manhwaStrip.js:1541, 2304`, `STRIP_TOP_ALIGN_FITS = ['width', 'width-if-larger']` forces `alignTop = true` on `l -> m` entry. Single-image mode centers `width` fits (`top: 73px`), while manhwa strip top-aligns (`top: 22px`), producing an abrupt 51px vertical jump when the bridge retires.

---

## Deviations and UX refinements

1. **Visible anchor retention during zoom and mode toggles (`src/js/viewer/manhwaStrip.js:910-935`)**
   - *Problem:* `_updateWindow()` dropped `_anchorHoldover` on float scale delta and only held the primary selection if it was at index 0 or `total - 1`. If `centerColY` was at column center (when `ty` was near 0), it drifted to center index.
   - *Resolution:* Allowed holding any visible `primaryImgIdx` in `[visStart, visEnd]` across zoom/toggle, using float tolerance `Math.abs(scale - _anchorHoldoverScale) < 1e-4`. Eliminates anchor jump to folder center during rapid toggling.

2. **Hold-to-flicker key repeat UX (`src/js/shortcuts.js:242-290, 360-375`)**
   - *Problem:* Holding down `Ctrl+M` fired key-repeat toggle events, thrashing layout and re-anchoring rapidly.
   - *Resolution:* Initial keydown toggles the viewer once. Subsequent key-repeats (`e.repeat === true`) keep the viewer image static at the first change state, flickers the indicator via `Statusbar.syncManhwaIndicator(mockState, { preserveSpace: true })` and `syncViewMenu(mockState)`, and commits the landed state on `keyup` or `clearHeldKeys()`.

3. **Status bar indicator ordering and flex gap cleanup (`src/index.html`, `src/css/main.css`, `src/js/menubar/statusbar.js`)**
   - *Problem:* Inactive empty spans `.status-spread` and `.status-manhwa` produced extra 12px flex gaps between the held/latched scroll modifier indicator and the dimensions readout. Scaling and filter states were not displayed in the status bar.
   - *Resolution:* Added `.status-spread:empty, .status-manhwa:empty { display: none; }` and `.status-manhwa.hold-flicker-hidden { visibility: hidden; }` to maintain fixed layout width during hold without creating phantom gaps when inactive. Added `status-scaling` and `status-filter` elements in the required order: `status-zoom` · `status-fit` · `status-scaling` · `status-filter`. Gated `#manhwa-indicator` overlay in `syncManhwaIndicator` strictly to `isStatusBarHidden` so it does not flicker in viewport when the status bar is visible in windowed mode.

---

## Slice 1. Anchor-first mount queue ordering in `manhwaStrip.js`

**Status:** `[x]` Done 2026-10-02. When `prefetchDir === 0`, `_updateWindow` and `_sortMountQueue` sort entries by distance to `anchor`. Runtime telemetry confirmed slot 64 mounts alone ahead of buffer slots (Step 1 frame 9, Step 6 frame 11), resolving the initial 7-frame blackout. 303 mocha tests passing, `node --check` clean.

Prioritize the visible anchor slot in `_mountQueue` when activating or updating the window while idle (`prefetchDir === 0`), ensuring the visible image decodes and mounts before off-screen buffer slots.

- [x] In `src/js/viewer/manhwaStrip.js:880-884`, update queue sorting so that when `prefetchDir === 0`, entries are sorted by distance to `anchor`: `Math.abs(a.imgIdx - anchor) - Math.abs(b.imgIdx - anchor)`.
- [x] Ensure that for any `anchor > 0`, `anchor` is always placed at index 0 of `_mountQueue`, ahead of `anchor - 1` and `anchor + 1`.
- [x] Verify that scrolling (`prefetchDir !== 0`) retains travel-direction sorting (`direction < 0 ? b.imgIdx - a.imgIdx : a.imgIdx - b.imgIdx`).
- [x] Accept when `_mountQueue.shift()` in `_advanceMountQueue()` always processes `anchor` first on initial activation.

Validation note. Keeps sequential worker off-DOM decode intact without blocking the main UI thread. Reuses existing `_sortMountQueue` helper.

---

## Slice 2. Anchor-guarded bridge release in `viewer.js`

**Status:** `[x]` Done 2026-10-02. `_claimSlot()` passes `(imgIdx, imgIdx === _anchorImgIdx)` to `_onSlotMounted`. `viewer.js` validates `if (!isAnchor) return;` before scheduling bridge retirement via `_doubleRaf`. 14-step replay telemetry confirmed 0 blackout frames, 0 anomalies, 0 jank. 303 mocha tests passing, `node --check` and `git diff --check` clean.

Guard bridge retirement so that `#viewer-bridge-layer` only releases when the target anchor slot itself mounts into the DOM, ignoring off-screen buffer slots.

- [x] In `src/js/viewer/manhwaStrip.js`, export a helper or pass the active anchor column index with `_onSlotMounted(imgIdx, isAnchor)`.
- [x] In `src/js/viewer/viewer.js:41-50`, update `setOnSlotMounted((imgIdx, isAnchor) => ...)` to verify whether the mounted slot matches the active anchor:
  ```javascript
  setOnSlotMounted((imgIdx, isAnchor) => {
    pipelines.notifyColumnChanged();
    if (!isManhwaStripActive() || !renderer.isBridgeActive()) return;
    if (!isAnchor) return;
    _doubleRaf(() => {
      if (!isManhwaStripActive()) return;
      renderer.releaseBridge();
    });
  });
  ```
- [x] Accept when off-screen buffer slots (`anchor - 1`, `anchor + 1`) mounting do not trigger `renderer.releaseBridge()`. The bridge stays visible until the anchor slot is mounted.

Validation note. Preserves single-concern ownership: `viewer.js` coordinates lifecycle handoffs; `manhwaStrip.js` notifies via callback without reach-in.

---

## Slice 3. Reliable anchor handoff on `m -> l` deactivation

**Status:** `[x]` Done 2026-10-02. `_deactivate()` strictly resolves `anchorIdx` without fallback to arbitrary mounted slots, providing valid raster dimensions to `_parkHandoff`. `viewerRender.js` syncs `_lastRenderedArchivePath` and preserves borrowed handoff bridge in `clearDisplayedImage` until `_activatePoolNode` completes. Manual runtime verification confirmed 0 blackout frames on deactivation, fast toggling, and archives. 303 mocha tests passing, `node --check` and `git diff --check` clean.

Guarantee that toggling from manhwa back to legacy single-image mode always hands off the correct anchor image to `#viewer-bridge-layer`, eliminating the 7-frame blackout.

- [x] In `src/js/viewer/manhwaStrip.js:2128-2165`, ensure `_deactivate()` only hands off an element if it matches `anchorIdx`. Never fall back to an arbitrary off-screen slot (`_mounted.values().next()?.value`) that displays a different file.
- [x] If `_mounted.get(anchorIdx)` is not yet attached, check `_prefetchedImages.get(anchorIdx)` or completed `_prefetching.get(anchorIdx)`.
- [x] Ensure `_onBridgeHandoff(anchorNode, natW, natH, targetFit)` is called with valid raster dimensions so `_parkHandoff` in `viewerRender.js` computes exact legacy fit geometry.
- [x] In `src/js/viewer/viewerRender.js:542-616`, ensure that when entering legacy mode from manhwa, any parked handoff bridge is preserved until legacy `_activatePoolNode` completes.
- [x] Accept when toggling `m -> l` immediately after startup or fast toggle displays the bridge continuously with 0 blackout frames.

Validation note. Keeps single-image pool and bridge layer ownership strictly in `viewerRender.js`.

---

## Slice 4. Positional stability on `l -> m` toggle

**Status:** `[ ]` Pending.

Eliminate the 51px coordinate jump in `width` and `width-if-larger` fit modes by preserving the centered vertical coordinate during mode toggles.

- [ ] In `src/js/viewer/manhwaStrip.js:2304`, distinguish between a mode toggle on an existing active image vs a fresh chapter/first-image open.
- [ ] When toggling from single-image view into manhwa view, center the anchor slot vertically in the viewport (matching single-image centering) instead of forcing a top-align snap. Top-alignment applies only when opening at chapter start (`primary === 0`).
- [ ] In `src/js/viewer/manhwaStrip.js:1649-1660`, pre-seed `_imageIndex[_anchorImgIdx]` with known raster dimensions from Core before initial layout calculation, eliminating post-mount height recalculations and layout staircase jitter.
- [ ] Accept when toggling `l -> m` under `width` and `width-if-larger` shows zero pixel displacement between the bridge image and the mounted manhwa slot.

Validation note. `viewportState` and `viewerMath.js` remain the single source of truth for fit and pan math. No duplicate geometry calculations in UI files.

---

## Slice 5. Tooling cleanup, regression testing, and verification

**Status:** `[ ]` Pending.

Verify full pipeline cleanliness, clean up temporary diagnostic files, and confirm zero blackouts across all fit modes.

- [ ] In `e2e/replay-diagnostics/base.js`, incorporate the viewport bounding-box overlap check so baseline diagnostics accurately detect off-screen slot masking.
- [ ] Run `npm run diagnose -- --clean` to remove `e2e/replay-diagnostics/investigation.js`.
- [ ] Run `npm run diagnose -- manhwa-bridge-l2m` on both `vlcsnap-2026-09-09-00h25m15s806.png` and `vlcsnap-2026-09-09-00h18m51s698.png`.
- [ ] Verify telemetry report:
  - Total blackout frames: 0
  - Total anomalies: 0
  - Total jank frames: 0
- [ ] Run targeted tests: `npm run mocha` (all 253+ unit tests passing).
- [ ] Run git diff hygiene check: `git diff --check`.

---

## Verification checklist

- [ ] `node --check src/js/viewer/manhwaStrip.js`
- [ ] `node --check src/js/viewer/viewer.js`
- [ ] `node --check src/js/viewer/viewerRender.js`
- [ ] `npm run mocha`
- [ ] `npm run diagnose -- manhwa-bridge-l2m`
- [ ] `git diff --check`
