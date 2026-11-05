# Slice 2: Viewer Engine Core (Transform Stability, Config Decoupling & Viewport Lifecycle) Plan

## Goal

Stabilize the core mathematics and lifecycle of the QuiviT viewer engine, preparing it for standalone Component Library (CL) extraction while eliminating user-facing bugs and performance bottlenecks. This slice implements Component Library (CL) Features from [.agents/cl-refactor-report.md](file:///E:/Projects/QuiviT/.agents/cl-refactor-report.md):
1. **Window & Panel Resize Transform Snap Fix**: Preserve relative zoom and pan during container resize.
2. **Options Save Resets Fit/Zoom (Bug)**: Decouple configuration loading from geometry state updates so saving options never resets active zoom or pan.
3. **Idle Cursor Auto-Hide**: Implement canvas-only interaction idle cursor timer with instant wake on movement or panning.
4. **Flickering Issue on Re-fetch**: Optimize browser image caching with a bounded 10-node LRU pool and seamless double-RAF layer retirement.
5. **Animated "Loading..." Feedback**: Provide animated visual feedback during slow image fetches while preserving the previous bridge image.

> [!IMPORTANT]
> ## User Review Required
> - **Idle Cursor Delay**: Default is set to 2 seconds (0 disables auto-hiding).
> - **Hover Preload Threshold**: Files exceeding 15 MB are not preloaded on hover. Hover debounce widened from 90ms to 150ms to ignore casual mouse sweeps.
> - **Archive Cache Default**: Lowered from 512 MB to 128 MB in `quivit_config.json` via `archive_cache_mb`.
> - **Preload Asymmetry**: Frontend DOM maintains 3 images (1 active, 1 ahead, 1 behind), while the Rust backend caches up to 14 entries in compressed memory.

> [!CAUTION]
> ## Execution Rules
> **Do not mark pending items as completed after writing the code.** Items must remain marked as `[PENDING]` until the user has explicitly approved that the implementation works correctly at runtime.

---

## Architectural Invariants & Validation Constraints

Every item in this plan is designed to follow [.agents/AGENTS.md](file:///E:/Projects/QuiviT/.agents/AGENTS.md) and the architectural review standards of [.agents/skills/validate-changes/SKILL.md](file:///E:/Projects/QuiviT/.agents/skills/validate-changes/SKILL.md):

1. **Frontend DOM & Architecture Boundaries:**
   - The state machine ([core.js](file:///E:/Projects/QuiviT/src/js/core.js)) and domain mathematics ([viewerMath.js](file:///E:/Projects/QuiviT/src/js/services/viewerMath.js)) maintain zero DOM imports and communicate via state callbacks.
   - CSS is the visual source of truth ([main.css](file:///E:/Projects/QuiviT/src/css/main.css), [options.css](file:///E:/Projects/QuiviT/src/css/options.css)). JS writes only class tokens (`.cursor-hidden`, `.bridge`), CSS variables, or transforms, never inline presentational layout styles.
   - Single owner per surface: [viewerGestures.js](file:///E:/Projects/QuiviT/src/js/viewer/viewerGestures.js) owns canvas interaction and idle cursor state, while [viewerRender.js](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js) owns image pool recycling and active/bridge layers.

2. **Performance First & Hot Path Invariants:**
   - **Bounded Image Cache (Zero Re-Fetch):** Bounded 10-node LRU DOM image pool prevents DOM bloat while making back-and-forth navigation instantaneous without IPC re-requests or re-decoding.
   - **Preload Distance & Memory Asymmetry:** Limit DOM preloads to 1 ahead / 1 behind to cut WebView2 GPU texture memory, while keeping backend archive entry prefetch in compressed memory.
   - **Hover Preload Gating (Zero Syscall Overhead):** Expose existing `size: u64` on `FileEntry` during directory and archive traversal with zero additional syscalls, gating hover preloads at 15 MB to eliminate decoder freezes.

3. **Blast Radius & Downstream Safety:**
   - **IPC Contract Backward Compatibility:** Adding `size: u64` with `#[serde(default)]` to [`FileEntry`](file:///E:/Projects/QuiviT/src-tauri/src/models.rs#L48) ensures existing frontend callers and IPC consumers continue serializing and deserializing without breakage.
   - **Config Schema Backward Compatibility:** `hide_cursor_delay_sec` is optional in `frontend_data` with a default of 2 seconds, preserving compatibility with existing config files.
   - **Protocol URL Stability:** `quivit://` asset URLs remain unchanged and compatible with cached and uncached entries.

4. **Stale Code Prevention:**
   - Remove redundant `window.addEventListener('resize', ...)` in [viewerRender.js](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js), letting the unified `ResizeObserver` in [viewer.js](file:///E:/Projects/QuiviT/src/js/viewer/viewer.js) handle container geometry changes.
   - Clean up previous image element references and bridge classes to prevent detached DOM node leaks.

---

## Proposed Changes

### 1. Shared Data Models & Backend Memory Budget
#### [MODIFY] [models.rs](file:///E:/Projects/QuiviT/src-tauri/src/models.rs)
- [COMPLETED] `[Observable change]` Add `size: u64` field with `#[serde(default)]` to [`FileEntry`](file:///E:/Projects/QuiviT/src-tauri/src/models.rs#L48).
- [COMPLETED] `[Observable change]` Update constructor helpers `new_file`, `new_directory`, and `new_archive_entry` to populate `size`.
- **Validation Notes:** Fully backward-compatible with frontend JS callers. Missing `size` field on legacy inputs deserializes to 0.

#### [MODIFY] [commands/directory.rs](file:///E:/Projects/QuiviT/src-tauri/src/commands/directory.rs)
- [COMPLETED] `[Observable change]` Extract file size from existing `metadata_res` without issuing extra system calls.
- **Validation Notes:** Reuses metadata already queried during directory reading. Zero additional I/O latency.

#### [MODIFY] [archives/zip.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/zip.rs), [archives/rar.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/rar.rs), [archives/sevenz.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/sevenz.rs), [archives/tar.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/tar.rs)
- [COMPLETED] `[Observable change]` Pass uncompressed entry sizes when building archive `FileEntry` records (`entry.size()`, `header.unpacked_size`, `header.size()`).
- **Validation Notes:** Populates entry byte sizes directly from parsed archive directory tables with zero extra disk seek or decompression operations.

#### [MODIFY] [lib.rs](file:///E:/Projects/QuiviT/src-tauri/src/lib.rs)
- [COMPLETED] `[Observable change]` Lower default archive memory cache budget from 512 MB to 128 MB (`config.archive_cache_mb.unwrap_or(128)`).
- **Validation Notes:** Reduces default memory footprint while allowing custom overrides via `quivit_config.json`.

---

### 2. Viewport Geometry & Container Resize Stability
#### [MODIFY] [services/viewerMath.js](file:///E:/Projects/QuiviT/src/js/services/viewerMath.js)
- [COMPLETED] `[Observable change]` Track user-initiated manual transforms via `_userTransformed` boolean flag in `createViewportState`.
- [COMPLETED] `[Observable change]` Mark `_userTransformed = true` on `zoomTo`, `panBy`, and `panTo`; reset on `resetGeometry` and explicit `applyFitMode`.
- [COMPLETED] `[Observable change]` Add `handleViewportResize(newVw, newVh)` to recalculate scales in fit mode or preserve exact zoom scale and re-clamp pan bounds when user transformed.
- [COMPLETED] `[Observable change]` Export `handleViewportResize` and `getUserTransformed`.
- **Validation Notes:** Pure domain math module with zero DOM dependencies. Verified via automated Node tests.

#### [MODIFY] [viewer/viewer.js](file:///E:/Projects/QuiviT/src/js/viewer/viewer.js)
- [COMPLETED] `[Observable change]` Route `#viewport` container `ResizeObserver` events through `viewportState.handleViewportResize(width, height)` followed by `forceRender()`.
- **Validation Notes:** Unifies container resizing under a single observer, covering both window resizes and sidebar panel handle dragging.

---

### 3. Application State & Config Decoupling
#### [MODIFY] [core.js](file:///E:/Projects/QuiviT/src/js/core.js)
- [COMPLETED] `[Observable change]` In `loadConfig()`, compare incoming `fit_mode` with active `_state.fitMode` before bumping `_state.fitModeGen`.
- **Validation Notes:** Prevents spurious canvas fit resets when saving unrelated options (keybinds, CSS, themes).

---

### 4. File Panel Hover Preloading & Gating
#### [MODIFY] [filepanel/filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- [COMPLETED] `[Observable change]` Gate hover preloading with `MAX_HOVER_PRELOAD_BYTES = 15 * 1024 * 1024` (15 MB), skipping oversized assets.
- [COMPLETED] `[Observable change]` Increase hover preloading debounce from 90ms to 150ms.
- **Validation Notes:** Eliminates UI freezing and decoder lag when moving the mouse across large files in the file panel.

---

### 5. Image Pool Lifecycle & Double-Buffering Layer Retirement
#### [MODIFY] [viewer/viewerRender.js](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js)
- [COMPLETED] `[Observable change]` Expand DOM image pool from 2 nodes to a bounded 10-node LRU cache (`POOL_SIZE = 10`).
- [COMPLETED] `[Observable change]` Bypass 45ms debounce buffer when switching to an image already present in the LRU cache.
- [COMPLETED] `[Observable change]` Set `PRELOAD_BEHIND = 1` and `PRELOAD_AHEAD = 1` to reduce memory consumption.
- [COMPLETED] `[Observable change]` Add animated loading text indicator (`Loading.` -> `Loading..` -> `Loading...`) when image fetch exceeds 100ms.
- [COMPLETED] `[Observable change]` Implement double-RAF layer retirement: outgoing active image becomes `.bridge` layer positioned underneath incoming image, retiring safely after the next frame paints.
- [COMPLETED] `[No observable change]` Remove redundant `window.addEventListener('resize', ...)` listener.
- **Validation Notes:** Eliminates blank screen flickers during rapid back-and-forth navigation and prevents compositor flashes.

#### [MODIFY] [css/main.css](file:///E:/Projects/QuiviT/src/css/main.css)
- [COMPLETED] `[Observable change]` Add styles for `.viewer-img.bridge` (`position: absolute; z-index: 0; pointer-events: none;`) and `.viewer-img:not(.bridge)` (`position: relative; z-index: 1;`).
- [COMPLETED] `[Observable change]` Add `#viewport.cursor-hidden, #viewport.cursor-hidden *` with `cursor: none !important;`.
- **Validation Notes:** Follows CSS source of truth. Presentation rules stay in CSS sheets rather than inline JS styles.

---

### 6. Idle Cursor Auto-Hide & Options UI
#### [MODIFY] [viewer/viewerGestures.js](file:///E:/Projects/QuiviT/src/js/viewer/viewerGestures.js)
- [COMPLETED] `[Observable change]` Implement idle cursor timer over `#viewport` triggering `.cursor-hidden` class after inactivity.
- [COMPLETED] `[Observable change]` Wake cursor immediately on `mousemove`, `pointermove`, or pan drag.
- [COMPLETED] `[Observable change]` Clear timer and reveal cursor on `mouseleave`.
- **Validation Notes:** Confines cursor hiding to canvas element without affecting menus, status bars, or sidebars.

#### [MODIFY] [services/actions.js](file:///E:/Projects/QuiviT/src/js/services/actions.js)
- [COMPLETED] `[Observable change]` Register `cmd-toggle-cursor-autohide` action in action registry.
- **Validation Notes:** Centralizes command definition in the shared actions registry.

#### [MODIFY] [keybinds.js](file:///E:/Projects/QuiviT/src/js/keybinds.js)
- [COMPLETED] `[Observable change]` Add `hide_cursor_delay_sec: 2` to `DEFAULT_CONFIG.frontend_data`.
- **Validation Notes:** Provides default fallback for fresh configurations.

#### [MODIFY] [options.html](file:///E:/Projects/QuiviT/src/options.html)
- [COMPLETED] `[Observable change]` Rename Pan & Zoom section to `Viewport Controls`.
- [COMPLETED] `[Observable change]` Add numeric input `#opt-hide-cursor-delay` with min 0, max 60, step 0.5.
- **Validation Notes:** HTML-first markup for new options controls.

#### [MODIFY] [options/options.js](file:///E:/Projects/QuiviT/src/js/options/options.js)
- [COMPLETED] `[Observable change]` Wire `hide_cursor_delay_sec` into options loader and saver.
- **Validation Notes:** Standard persistence pattern across options dialog.

#### [MODIFY] [css/options.css](file:///E:/Projects/QuiviT/src/css/options.css)
- [COMPLETED] `[Observable change]` Add `flex-wrap: wrap;` to `.pan-step-row` for responsive wrapping.
- **Validation Notes:** Prevents layout clipping when additional controls are present in the viewport settings row.

---

### 7. Automated Test Suite
#### [NEW] [src/js/tests/viewerMath.test.mjs](file:///E:/Projects/QuiviT/src/js/tests/viewerMath.test.mjs)
- [COMPLETED] `[No observable change]` Add unit tests verifying `applyFitMode('window')`, `zoomAt`, `_userTransformed` tracking, and container resize handling with and without manual transforms.
- **Validation Notes:** Runs via Node native test runner (`node:test`) without requiring extra dependencies.

#### [MODIFY] [package.json](file:///E:/Projects/QuiviT/package.json)
- [COMPLETED] `[No observable change]` Add `"test": "node --test src/js/tests/viewerMath.test.mjs"` script entry.
- **Validation Notes:** Standard test script invocation via `npm test`.

---

## Validation & Blast Radius Checklist

Following [.agents/skills/validate-changes/SKILL.md](file:///E:/Projects/QuiviT/.agents/skills/validate-changes/SKILL.md), the slice is audited against the following checklist:

| Category | Item to Validate | Expected Result |
|---|---|---|
| **Frontend Ownership** | [viewerMath.js](file:///E:/Projects/QuiviT/src/js/services/viewerMath.js) | Pure mathematics module with zero DOM references; exports pure coordinate transformation and resize calculations. |
| **Frontend Ownership** | [core.js](file:///E:/Projects/QuiviT/src/js/core.js) | State machine does not touch DOM; guards `fitModeGen` increments to decouple config reloads from viewport transforms. |
| **CSS Source of Truth** | [main.css](file:///E:/Projects/QuiviT/src/css/main.css), [options.css](file:///E:/Projects/QuiviT/src/css/options.css) | Cursor visibility and bridge image layering controlled by CSS classes (`.cursor-hidden`, `.bridge`); no inline visual overrides. |
| **Hot Path** | Bounded Image Pool | 10-node LRU cache provides instant back-and-forth navigation without IPC re-requests or re-decoding. |
| **Hot Path** | Hover Preload Gating | Files > 15 MB skipped during hover; zero cursor stutter when hovering large files in file list. |
| **Blast Radius** | [models.rs](file:///E:/Projects/QuiviT/src-tauri/src/models.rs) | `size: u64` defaults to 0 on legacy/unspecified deserialization; existing IPC callers remain intact. |
| **Blast Radius** | [keybinds.js](file:///E:/Projects/QuiviT/src/js/keybinds.js), [options.html](file:///E:/Projects/QuiviT/src/options.html) | Config schema cleanly incorporates `hide_cursor_delay_sec` with default fallback. |
| **Stale Code** | Window resize listeners | Redundant `window.addEventListener('resize')` removed from `viewerRender.js`; unified under `ResizeObserver` in `viewer.js`. |

---

## Verification Plan

### Automated Checks
Run the following commands from the repository root:
1. `npm test`
   - Runs native `node:test` suite in `src/js/tests/viewerMath.test.mjs`.
   - All 5 math and resize tests must pass.
2. `node --check <file>`
   - Syntax validation across all modified JS files (`viewerMath.js`, `viewer.js`, `viewerRender.js`, `viewerGestures.js`, `core.js`, `filePanel.js`, `actions.js`, `keybinds.js`, `options.js`).
   - Must exit cleanly with zero syntax errors.
3. `cargo check --manifest-path src-tauri/Cargo.toml --tests`
   - Must compile with zero errors and zero warnings.
4. `cargo test --manifest-path src-tauri/Cargo.toml --lib archive_tests`
   - All archive tests and format validation checks must pass.

### Manual Runtime Checklist
1. **Sidebar Drag & Window Resize Stability:**
   - Zoom in to 250% on an image. Drag `.panel-resize-handle` back and forth and resize the application window.
   - Confirm zoom level remains at 250% and image pan position does not snap back to fit mode defaults. *(Verified: PASS)*
2. **Options Save Transform Decoupling:**
   - Zoom and pan an image. Open Options (`Ctrl+,`), modify a keybinding or custom CSS, and click Save.
   - Confirm image zoom and pan coordinates remain unchanged. *(Verified: PASS)*
3. **test-files/ Hover Fluidity:**
   - Move cursor rapidly across rows in `test-files/` containing large assets like `BDレーベル.bmp` (31.4 MB).
   - Confirm zero cursor stutter or UI freezing due to the 15 MB gate and 150ms debounce. *(Verified: PASS)*
4. **Back-and-Forth Navigation & Double-Buffering:**
   - Step forward through 5 images, then step backward with Left Arrow.
   - Confirm instant image swap with zero blank-screen flicker or texture flashing. *(Verified: PASS)*
5. **Idle Cursor Auto-Hide:**
   - Rest cursor over canvas without movement.
   - Confirm cursor disappears after 2 seconds. Move mouse or drag pan; confirm cursor instantly reappears. *(Verified: PASS)*
