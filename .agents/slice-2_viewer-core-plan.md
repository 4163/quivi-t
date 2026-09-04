# Slice 2: Viewer Engine Core - Transform Stability, Config Decoupling & Viewport Lifecycle Plan

## Goal

Stabilize the core viewer engine mathematics, decouple configuration updates from active viewport state, reduce memory footprint, and optimize image caching and preloading. This slice addresses the primary Component Library (CL) foundational items from [.agents/cl-refactor-report.md](file:///E:/Projects/QuiviT/.agents/cl-refactor-report.md), user notes from [.agents/user-notes](file:///E:/Projects/QuiviT/.agents/user-notes), and clipboard performance directives:

1. **Window & Panel Resize Transform Snap Fix**: Eliminate sudden zoom and pan resets when resizing the sidebar file panel or main window. Anchor relative zoom level and image center coordinates during container boundary updates.
2. **Options Save Resets Fit/Zoom Fix**: Prevent configuration saving from triggering destructive geometry resets. Ensure `Core.loadConfig` and viewer config updates preserve active transforms unless fit mode was explicitly altered.
3. **Idle Cursor Auto-Hide**: Automatically hide the mouse cursor over the canvas viewport after a configurable inactivity delay (`hide_cursor_delay_sec`, default 2s), wake instantly on mouse movement or panning, and support a toggle keybind (`cmd-toggle-cursor-autohide`).
4. **Image Cache Lifecycle, Re-fetch Flicker Prevention & Loading Feedback**: Introduce an in-memory cache for recent image nodes and object URLs. Eliminate redundant backend re-fetches and visible blank flickering during back-and-forth navigation, remove the artificial 45ms debounce delay for cached images, and provide animated loading feedback for uncached entries.
5. **Memory Budget Reduction & Asymmetric Preload Architecture**:
   - Reduce backend archive memory budget from 512 MB to 128 MB to maintain lightweight memory standards.
   - Shift preload burden from frontend DOM to backend memory: reduce frontend DOM preloads from 7 to 2 (1 behind, 1 in front), while maintaining 14 prefetch entries (7 ahead, 7 behind) in the backend Rust cache.
   - Expose `size` on `FileEntry` and remove hover preloading for extremely large files (> 25 MB) to eliminate lag spikes when browsing heavy folders like `test-files/`.

> [!IMPORTANT]
> ## User Review Required
> - **Default idle cursor delay**: Recommended default is `2` seconds. Setting `0` disables auto-hiding completely.
> - **Archive memory budget**: Reduced default from `512 MB` to `128 MB`. Configurable via `archive_cache_mb` in `quivit_config.json`.
> - **Preload asymmetry**:
>   - Frontend DOM preloads: `1` ahead, `1` behind (total 3 images in WebView2 DOM).
>   - Backend archive cache: `7` ahead, `7` behind (total 14 entries in Rust memory as raw compressed bytes).
> - **Hover preload threshold**: Skip hover preloading in the file panel for any item with `size > 25 MB` (excluding extreme outliers like `BDレーベル.bmp` at 31.4 MB while permitting high-res 10-25 MB scans), and increase hover debounce from 90ms to 150ms.

> [!CAUTION]
> ## Execution Rules
> **Do not mark pending items as completed after writing the code.** Items must remain marked as `[PENDING]` until the user has explicitly verified and approved that the implementation works correctly at runtime.

---

## Architectural Invariants & Validation Constraints

Every item in this plan adheres to [.agents/AGENTS.md](file:///E:/Projects/QuiviT/.agents/AGENTS.md) and [.agents/skills/validate-changes/SKILL.md](file:///E:/Projects/QuiviT/.agents/skills/validate-changes/SKILL.md):

1. **Component Library Decoupling & Ownership Boundaries:**
   - [viewerMath.js](file:///E:/Projects/QuiviT/src/js/services/viewerMath.js) remains a pure mathematics and transform domain module with zero DOM references. It calculates scales, offsets, rotations, flips, and coordinate projections.
   - [viewer.js](file:///E:/Projects/QuiviT/src/js/viewer/viewer.js) serves as the unified facade managing container lifecycle, hosting the single `ResizeObserver`, and exposing methods (`mount`, `setConfig`, `setImage`, `applyFitMode`, `zoomAt`, `panBy`, `destroy`).
   - [viewerRender.js](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js) owns the image element pool and memory cache. It reports status updates via callbacks rather than direct status bar element manipulation.
   - [viewerGestures.js](file:///E:/Projects/QuiviT/src/js/viewer/viewerGestures.js) owns viewport pointer input, pan gestures, and idle cursor timing.
   - State machine ([core.js](file:///E:/Projects/QuiviT/src/js/core.js)) maintains application state without DOM or canvas references.

2. **CSS Source of Truth & HTML-First Invariants:**
   - Cursor auto-hiding must not inject inline styles into DOM nodes (`element.style.cursor = 'none'`). It must toggle a `.cursor-hidden` class on the `#viewport` container.
   - `#viewport.cursor-hidden` and `#viewport.cursor-hidden *` specify `cursor: none !important;` in [main.css](file:///E:/Projects/QuiviT/src/css/main.css).
   - Transform coordinates are applied via CSS custom properties or standard `transform` matrices on `#viewer-img-wrapper`.

3. **Performance First & Hot Path Invariants:**
   - **Zero allocation on pointer events**: `mousemove`, `pointermove`, and `wheel` listeners must not allocate closures, arrays, or objects on every tick.
   - **Single idle timer**: Idle cursor management uses a single reusable timer handle. Active mouse movement resets this timer using a primitive timestamp check.
   - **Zero redundant fetches**: Navigating back to an immediately preceding image reuses the cached image node or decoded buffer without issuing IPC commands or generating new `quivit://` network requests.
   - **Elimination of DOM texture bloat**: Frontend DOM holds at most 3 images (1 active, 1 ahead, 1 behind) instead of 15 images. Large raw RGBA bitmap memory in WebView2 drops from ~500 MB to ~80 MB.
   - **Zero-cost file size extraction**: File sizes are retrieved from existing `fs::Metadata` handles in `directory.rs` and header records in archive readers without triggering additional file system syscalls.

4. **Blast Radius & Downstream Safety:**
   - `FileEntry` adds `#[serde(default)] pub size: u64`. Fully backward-compatible with any callers that omit the field.
   - Existing keybinding schemas and action IDs remain fully compatible.
   - Options window UI additions (`hide_cursor_delay_sec`) persist safely through `quivit_config.json` via serde untyped `frontend_data`.

5. **Stale Code Prevention:**
   - Remove the redundant `window.addEventListener('resize')` in [viewerRender.js](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js).
   - Consolidate container dimension tracking into the single `ResizeObserver` within [viewer.js](file:///E:/Projects/QuiviT/src/js/viewer/viewer.js).

---

## Proposed Changes

### 1. Backend Data Contracts & Memory Budget

#### [MODIFY] [models.rs](file:///E:/Projects/QuiviT/src-tauri/src/models.rs)
- [PENDING] `[Observable change]` Add `pub size: u64` decorated with `#[serde(default)]` to [`FileEntry`](file:///E:/Projects/QuiviT/src-tauri/src/models.rs#L4).
- [PENDING] `[No observable change]` Update constructor helpers `new_file`, `new_directory` (size: 0), and `new_archive_entry` to populate `size`.

#### [MODIFY] [commands/directory.rs](file:///E:/Projects/QuiviT/src-tauri/src/commands/directory.rs)
- [PENDING] `[Observable change]` Extract `metadata_res.as_ref().map(|m| m.len()).unwrap_or(0)` into `FileEntry.size` during directory enumeration.

#### [MODIFY] [archives/zip.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/zip.rs), [rar.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/rar.rs), [sevenz.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/sevenz.rs), [tar.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/tar.rs)
- [PENDING] `[Observable change]` Forward uncompressed entry size into `FileEntry.size` during archive listing.

#### [MODIFY] [lib.rs](file:///E:/Projects/QuiviT/src-tauri/src/lib.rs)
- [PENDING] `[Observable change]` Change default archive memory budget from 512 MB to 128 MB: `let cache_mb = config.archive_cache_mb.unwrap_or(128);`.

---

### 2. Pure Mathematics & Transform Engine

#### [MODIFY] [viewerMath.js](file:///E:/Projects/QuiviT/src/js/services/viewerMath.js)
- [PENDING] `[Observable change]` Add `_userTransformed` boolean flag to `createViewportState`. Set to `true` whenever `zoomTo`, `zoomAt`, `panBy`, or `panTo` executes. Reset to `false` when explicit `applyFitMode(mode)` or `resetGeometry()` executes.
- [PENDING] `[Observable change]` Implement `handleViewportResize(vw, vh)`:
  - Records previous viewport dimensions `_prevVw` and `_prevVh`.
  - If `!_userTransformed`: dynamically recalculates `_scale` and centering for the new viewport dimensions according to `_currentFitMode`.
  - If `_userTransformed`: maintains current `_scale`, recalculates `_tx` and `_ty` to keep the visual center of the viewport mapped to the identical coordinate on the image, and applies `_clampPan()`.
- [PENDING] `[No observable change]` Refactor `applyFitMode` parameter handling so container resize events route exclusively through `handleViewportResize` rather than resetting manual transforms.
- [PENDING] `[No observable change]` Export coordinate conversion helper functions for headless testing.

---

### 3. Viewer Facade & Resize Coordination

#### [MODIFY] [viewer.js](file:///E:/Projects/QuiviT/src/js/viewer/viewer.js)
- [PENDING] `[Observable change]` Update `ResizeObserver` callback on `#viewport`:
  - Extract container width and height from `ResizeObserverEntry.contentRect`.
  - Call `viewportState.handleViewportResize(width, height)`.
  - Call `pipelines.forceRender()`.
- [PENDING] `[No observable change]` Add `setConfig(config)` facade method to update viewer settings without re-triggering geometry resets.

---

### 4. Image Cache Lifecycle & Preload Asymmetry

#### [MODIFY] [viewerRender.js](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js)
- [PENDING] `[Observable change]` Remove duplicate `window.addEventListener('resize')` listener (lines 346-351) that caused double transform recalculations.
- [PENDING] `[Observable change]` Reduce frontend DOM preload distance from 7 to 2 (`const PRELOAD_BEHIND = 1; const PRELOAD_AHEAD = 1;`).
- [PENDING] `[Observable change]` Implement bounded LRU node/bitmap cache for loaded images:
  - Cache up to 10 recently viewed `HTMLImageElement` nodes keyed by `src`.
  - When navigating to an entry already in cache, swap immediately without dispatching new network requests or triggering the 45ms debounce delay.
  - Revoke object URLs only when an item is evicted from the bounded LRU cache.
- [PENDING] `[Observable change]` Re-introduce animated `Loading...` feedback:
  - When an uncached image load is initiated, activate a loading label cycle (`Loading.` -> `Loading..` -> `Loading...`).
  - Maintain the existing bridge image during fetch while showing the loading state, preventing blank white or black flickers.

#### [MODIFY] [filepanel/filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- [PENDING] `[Observable change]` Gate hover preloading on file size:
  - Skip hover preloading entirely if `item.size > 25 * 1024 * 1024` (25 MB).
  - Increase hover preloading debounce from 90ms to 150ms to prevent rapid mouse sweeps from creating wasted image decodes.

#### [MODIFY] [fsUtils.js](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
- [PENDING] `[No observable change]` Confirm `prefetchAhead` retains the 14-entry window (7 ahead, 7 behind) targeting `prefetch_archive_entries` in Rust memory, keeping compressed bytes cached in the backend while the frontend maintains a lean 3-image DOM footprint.

---

### 5. Idle Cursor Auto-Hide & Viewport Gestures

#### [MODIFY] [viewerGestures.js](file:///E:/Projects/QuiviT/src/js/viewer/viewerGestures.js)
- [PENDING] `[Observable change]` Implement idle cursor timer on the `#viewport` container:
  - Read `hide_cursor_delay_sec` from configuration (default `2` seconds; `0` disables).
  - Add lightweight, non-allocating `pointermove` / `mousemove` handler resetting the idle timer.
  - When the timer expires and no mouse buttons or pan keys are held, add class `cursor-hidden` to `#viewport`.
  - On any mouse movement, button press, or wheel action, remove class `cursor-hidden` and re-arm the timer.
  - On `mouseleave` from `#viewport` or hover over chrome elements, immediately remove `cursor-hidden` and cancel the timer.
- [PENDING] `[Observable change]` Support manual toggle command (`cmd-toggle-cursor-autohide`):
  - Inverts auto-hide state or immediately hides the cursor until the next mouse motion.

---

### 6. Application State & Options Save Decoupling

#### [MODIFY] [core.js](file:///E:/Projects/QuiviT/src/js/core.js)
- [PENDING] `[Observable change]` In `loadConfig()`:
  - Compare incoming `loaded.frontend_data.fit_mode` with active `_state.fitMode`.
  - Only increment `_state.fitModeGen` if the persisted fit mode actually changed.
  - Avoid triggering viewer geometry recalculation when unrelated settings (custom CSS, keybinds, theme) are saved.

#### [MODIFY] [services/actions.js](file:///E:/Projects/QuiviT/src/js/services/actions.js)
- [PENDING] `[Observable change]` Register action `cmd-toggle-cursor-autohide` with category `view` and human-readable label `Toggle Cursor Auto-Hide`.

#### [MODIFY] [keybinds.js](file:///E:/Projects/QuiviT/src/js/keybinds.js)
- [PENDING] `[Observable change]` Add default configuration values:
  - `hide_cursor_delay_sec: 2` in `DEFAULT_CONFIG.frontend_data`.
  - Default keybinding for `cmd-toggle-cursor-autohide` (e.g. `c`).

#### [MODIFY] [options/options.js](file:///E:/Projects/QuiviT/src/js/options/options.js) & [options.html](file:///E:/Projects/QuiviT/src/options.html)
- [PENDING] `[Observable change]` Add number input for `hide_cursor_delay_sec` (range `0` to `30` seconds) under the Interface tab in `options.html`.
- [PENDING] `[Observable change]` Populate and serialize `hide_cursor_delay_sec` in `initOptionsUi` and `buildConfigFromForm`.

---

### 7. Styling

#### [MODIFY] [css/main.css](file:///E:/Projects/QuiviT/src/css/main.css)
- [PENDING] `[Observable change]` Add rules:
  ```css
  #viewport.cursor-hidden,
  #viewport.cursor-hidden * {
    cursor: none !important;
  }
  ```

---

### 8. Automated Unit Tests

#### [NEW] [src/js/tests/viewerMath.test.mjs](file:///E:/Projects/QuiviT/src/js/tests/viewerMath.test.mjs)
- [PENDING] Automated unit tests verifying:
  - Default fit mode recalculates scale when viewport resizes.
  - Manual zoom (`zoomAt`) sets `_userTransformed = true`.
  - Viewport resize while `_userTransformed` is true preserves exact scale and re-centers pan coordinates.
  - Pan clamping stays bounded within visual limits.
  - Explicit `applyFitMode` resets `_userTransformed` and applies target fit geometry.

---

## Verification Plan

### Automated Tests
- Run Node test runner on mathematics suite:
  ```bash
  node --test src/js/tests/viewerMath.test.mjs
  ```
- Run syntax verification on all touched JS files:
  ```bash
  node --check src/js/services/viewerMath.js
  node --check src/js/viewer/viewer.js
  node --check src/js/viewer/viewerRender.js
  node --check src/js/viewer/viewerGestures.js
  node --check src/js/core.js
  node --check src/js/filepanel/filePanel.js
  node --check src/js/options/options.js
  ```
- Run targeted Rust unit tests:
  ```bash
  cargo test archive_tests
  cargo check --tests
  ```

### Manual Verification
1. **Container Resize Zoom/Pan Retention**:
   - Open an image. Zoom in to 300% and pan to the bottom-right corner.
   - Drag the sidebar resize handle back and forth. Confirm zoom remains at 300% and focused region stays pinned.
   - Resize the main application window. Confirm identical stability.
2. **Options Save Fit/Zoom Stability**:
   - Zoom in on an image. Open Options (`Ctrl+,`), modify custom CSS or keybinds, and click Save.
   - Confirm canvas zoom level and pan position do not reset.
3. **Idle Cursor Auto-Hide**:
   - Stop mouse movement over canvas. Confirm cursor disappears after 2 seconds.
   - Move mouse or pan. Confirm cursor reappears immediately.
   - Move mouse over sidebar or chrome. Confirm cursor stays visible.
4. **test-files/ Responsiveness & Large File Hover Prevention**:
   - Open `test-files/`. Move cursor across rows including `BDレーベル.bmp` (31.4 MB).
   - Confirm UI remains fluid without lag or stutter.
   - Open `BDレーベル.bmp` directly. Confirm animated loading feedback displays until render completes.
5. **Rapid Navigation & Zero Re-fetch Flicker**:
   - Navigate forward across 5 images, then navigate backward using Left Arrow.
   - Confirm cached images swap immediately with no blank flicker.
