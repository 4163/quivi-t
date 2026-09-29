Validation comparison performed against .agents/AGENTS.md and .agents/skills/validate-changes/SKILL.md before presenting. Each slice below was checked for module ownership, pure-module direction, CSS source of truth, HTML-first rendering, blast radius with runnable checks, and docs discipline. Findings are inline in the slice notes.

# Manhwa image bridge implementation plan

**Target:** `feature/manhwa-view`, working tree clean.

**Scope lock:** Implement seamless image bridging between legacy single-image view and manhwa strip view in both directions (Legacy to Manhwa and Manhwa to Legacy) across all fit modes (`none`, `width`, `height`, `window`, and their `-if-larger` variants). No blank flicker, no blackout frames, and no delayed position jumps during view toggles. Existing legacy-to-legacy image bridging stays intact. No new modules, no architecture-state or README edits during implementation. `viewerRender.js` retains sole ownership of `#viewer-bridge-layer` and single-image pool nodes. `manhwaStrip.js` retains sole ownership of `#manhwa-strip` and `.manhwa-active`. `viewer.js` coordinates lifecycle handoffs. Deviations go here with reason and file.

**Definitions.** Legacy view means the single-image viewport managed by `src/js/viewer/viewerRender.js`. Manhwa view means the continuous vertical strip managed by `src/js/viewer/manhwaStrip.js`. Bridge layer means `#viewer-bridge-layer` in `src/index.html`. Anchor image means the primary active image selected in `Core.getState().index` and mapped to `_anchorImgIdx` in manhwa view. Target geometry means the `{ tx, ty, scale, rotation, flipX, flipY }` transform computed for the destination view's fit mode by `viewportState`.

## Pipeline map

- Legacy viewer renders active image in `#viewer-img-wrapper .viewer-img.active`. Transitions between images inside legacy view park the retiring node in `#viewer-bridge-layer` with frozen `--bridge-*` custom properties (`src/js/viewer/viewerRender.js:137-161`).
- CSS rule `#viewport.manhwa-active #viewer-bridge-layer` currently forces `display: none` (`src/css/main.css:1579`), suppressing any bridge element when entering manhwa view.
- When toggling Manhwa ON (`state.manhwaEnabled = true`), `viewerRender.js:509-512` currently runs `clearDisplayedImage()`, recycling all pool nodes and stripping `active` classes immediately. Concurrently, `manhwaStrip.js:1653-1703` activates and queues asynchronous decode through `_advanceMountQueue()`. During decode latency (200ms to 350ms), both views are empty, producing 20+ blackout frames.
- When toggling Manhwa OFF (`state.manhwaEnabled = false`), `manhwaStrip.js:1740-1773` removes `.manhwa-active` and calls `_clearCaches()`, destroying all slot images immediately. `viewerRender.js` starts an asynchronous decode (`activeEl.decode()`) with no bridge node present, causing another 180ms to 260ms blackout.
- Multiple fit modes (`none`, `width`, `height`, `window`, and `-if-larger` variants) define different target geometries in legacy view. Computing the target fit geometry before parking the bridge image allows the bridge to paint immediately at the destination layout, eliminating both blackouts and delayed position jumps.

## Slice 1. Un-hide bridge layer and generalize bridge park contract

**Status:** `[x]` Done 2026-09-29. `#viewer-bridge-layer` un-hidden under `.manhwa-active` in `main.css`. `_parkNodeInBridge` in `viewerRender.js` generalized with explicit target geometry, autoRetire flag, and safety fallback timer (1200ms). `Viewer` in `viewer.js` exports `parkInBridge`, `releaseBridge`, and `isBridgeActive`. `node --check` passed, `npm run mocha` passed (253 tests), `git diff --check` clean.

Un-hide `#viewer-bridge-layer` during manhwa mode in CSS and generalize `viewerRender.js` bridge methods so callers can park an image with explicit target geometry.

- [x] In `src/css/main.css:1578-1585`, remove `#viewer-bridge-layer` from the `#viewport.manhwa-active` display-none list. Ensure `#viewer-bridge-layer` remains `position: absolute; inset: 0; pointer-events: none;` regardless of manhwa state.
- [x] In `src/js/viewer/viewerRender.js:137-161`, update `_parkNodeInBridge(node, explicitGeometry = null)` to accept an optional target geometry object (`{ tx, ty, scale, rotation, flipX, flipY }`). When provided, use `explicitGeometry` values for `--bridge-*` custom properties instead of reading live `viewportState.getGeometry()`.
- [x] In `src/js/viewer/viewerRender.js`, export clean bridge lifecycle controls: `parkInBridge(node, explicitGeometry)`, `releaseBridge()`, and `isBridgeActive()`.
- [x] Add a safety fallback timer (1200ms) on parked bridge nodes so a node never gets stranded if an incoming decode fails or is cancelled.
- [x] Accept when `#viewer-bridge-layer` elements remain visible with `.manhwa-active` on `#viewport`, and `node --check` plus `npm run mocha` pass with zero regressions.

Validation note. Keeps single-image pool and bridge layer ownership strictly in `viewerRender.js`. CSS remains the visual source of truth via custom properties.

## Slice 2. Bridge legacy image into manhwa view on toggle

**Status:** `[x]` Done 2026-09-29. Confirmed working at runtime and verified via replay diagnostics (12/12 steps pass, 0 blackout frames, 0 anomalies).

Hold the active legacy image in `#viewer-bridge-layer` across the transition into manhwa view until the manhwa anchor slot finishes decode and mounts.

- [x] In `src/js/viewer/viewerRender.js:553-561`, when `state.manhwaEnabled` becomes true in `onStateChange`, check if `img && img.src && img.classList.contains('active')`.
- [x] If an active image exists, park it in `#viewer-bridge-layer` with its current geometry before recycling the rest of the pool, and hold it without a 2-frame auto-release (`autoRetire = false`).
- [x] In `src/js/viewer/viewerRender.js:557`, guard the `else` branch with `else if (!_retiringNode) { clearDisplayedImage(false); }`. Synchronous double notifications from `Core.setManhwaMode()` (`setSpreadEnabled(false)` notification 1 followed by `setManhwaMode()` notification 2) must not cancel an active in-flight bridge node when `img` was already nulled by notification 1.
- [x] In `src/js/viewer/manhwaStrip.js:1683-1698`, seed known active dimensions into `_imageIndex[_anchorImgIdx]` before `_initEstimatedDimensions()` and `_updateLayout()`.
- [x] In `src/js/viewer/manhwaStrip.js:986`, update `_claimSlot` to emit `_onSlotMounted` when a slot image mounts into DOM. Export `setOnSlotMounted`.
- [x] In `src/js/viewer/viewer.js:36-44`, wire `setOnSlotMounted` to release the bridge layer after double `requestAnimationFrame` compositor paints.
- [x] Accept when toggling Manhwa ON while an image is displayed shows no blank flicker, and telemetry records 0 blackout frames for Legacy to Manhwa steps (Step 0 and Step 4 in `manhwa-fit-entry`).

Diagnostic report note (2026-09-29). Replay diagnostics on `manhwa-fit-entry` isolated a synchronous notification race. `setSpreadEnabled(false)` inside `setManhwaMode` triggers notification 1, parking `img` and setting `img = null`. `setManhwaMode` then triggers notification 2, where `img` is null. The unguarded `else` called `clearDisplayedImage(false)`, invoking `_cancelRetiringNode()` and unmounting the bridge node at +595.8ms before any compositor frame could paint. Guarding the `else` branch allows the bridge node to persist until `setOnSlotMounted` releases it.

Validation note. Keeps single-image pool and bridge layer ownership strictly in `viewerRender.js`. CSS remains the visual source of truth via custom properties. Reuses the already decoded legacy image element with no redundant decodes or duplicate network requests. Pure module boundary between strip and renderer coordinated via `viewer.js`.

## Slice 3. Bridge manhwa slot image into legacy view across all fit modes

**Status:** `[ ]` Ready for implementation.

When toggling Manhwa OFF, take the active mounted anchor image from `#manhwa-strip`, compute the target legacy fit geometry for the active fit mode, and park it in `#viewer-bridge-layer` until legacy `_activatePoolNode` completes.

- [ ] In `src/js/viewer/manhwaStrip.js:1740-1768`, in `_deactivate()`, locate the mounted anchor image `_mounted.get(_anchorImgIdx)` before `_clearCaches()` tears down the slots.
- [ ] Extract the anchor image element and its natural dimensions (`naturalWidth`, `naturalHeight`), and pass it to `viewerRender.parkInBridge` or hand off via `viewer.js`.
- [ ] In `src/js/viewer/viewerRender.js`, calculate target legacy fit geometry for the incoming image and `state.fitMode` using `viewportState.applyFitMode(state.fitMode, natW, natH)`.
- [ ] Park the bridge node at the calculated target geometry (`--bridge-tx`, `--bridge-ty`, `--bridge-sx`, `--bridge-sy`).
- [ ] Handle fit mode edge cases:
  - `none`: target scale 1, centered.
  - `width` / `width-if-larger`: target scale `scaleX`, top-aligned if taller than viewport (`_ty = (height - vh) / 2`).
  - `height` / `height-if-larger`: target scale `scaleY`, centered (`_tx = 0, _ty = 0`).
  - `window` / `window-if-larger`: target scale `min(scaleX, scaleY)`, centered.
  - Cold anchor fallback: if no mounted anchor element exists in manhwa strip, proceed without bridge.
- [ ] In `src/js/viewer/viewerRender.js:695`, when `_activatePoolNode()` executes after legacy decode resolves, release the bridge node.
- [ ] Accept when toggling Manhwa OFF across all fit modes displays the image immediately at target fit geometry with zero blackout frames and zero position jump.

Validation note. `viewportState.applyFitMode` owns fit math, keeping formulas centralized in `viewerMath.js` without duplicating geometry math in UI files.

## Slice 4. Telemetry probe persistence and full replay verification

**Status:** `[ ]` Ready for implementation.

Update baseline diagnostic probes to prevent multi-step blackout blindness, verify scenario passes, and confirm contract tests.

- [ ] In `e2e/replay-diagnostics/base.js` and `e2e/replay-diagnostics/probes/viewerPipelineProbe.js`, persist the session-level rendered content tracking proven during investigation (`_sessionHadRenderedContent`) so steps following a blackout are never blinded.
- [ ] In `e2e/scenarios/manhwa-fit-entry.json`, verify initial image selection index 1.
- [ ] Run `npm run diagnose -- manhwa-fit-entry` and confirm 0 blackout frames across all 12 steps.
- [ ] Run `npm run mocha` to verify unit and contract tests pass (253+ tests).
- [ ] Remove temporary investigation workspace via `npm run diagnose -- --clean`.
- [ ] Accept when replay diagnostics report PASS with 0 blackout frames, 0 anomalies, and mocha test suite is clean.

## Verification

Per slice:
- `node --check <file>` on every touched JS file.
- `npm run mocha` for pure frontend unit tests.
- Replay verification: `npm run diagnose -- manhwa-fit-entry`.
- Git diff hygiene check: `git diff --check`.
- Manual runtime checklist provided to the user before final signoff.
