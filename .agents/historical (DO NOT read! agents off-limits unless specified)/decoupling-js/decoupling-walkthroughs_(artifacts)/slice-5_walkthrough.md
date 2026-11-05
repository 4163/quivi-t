# Slice 5: Viewer split (math/render/gestures)

I have successfully completed Slice 5 of the decoupling plan. The `viewer.js` monolith is now split into pure, testable, and cohesive modules without breaking upstream usage.

## What changed?

### 1. Extracted Pure Math (`services/viewerMath.js`)
All zoom, pan, rotation, flip, and fit logic was moved out into a DOM-free `createViewportState()` store. 
- It maintains the core geometry (`_scale`, `_tx`, `_ty`, `_naturalW`, `_naturalH`, `_rotation`, `_flipX`, `_flipY`).
- It expects an injected `getViewport()` function to cleanly access bounds without being tightly coupled to `document.getElementById('viewport')`.
- It emits changes via `notify()` to subscribers.

### 2. Extracted Render & Pool Lifecycle (`viewer/viewerRender.js`)
All `<img class="viewer-img">` pool manipulations and CSS variable writes (`--zoom-scale`, `transform`) were extracted here.
- Subscribes to `viewerMath` state changes to apply `transform` on `requestAnimationFrame`.
- Attaches the `load` handler dynamically, pushing progress and dimensions cleanly to `Statusbar`.
- Writes `decodedSrc` back to `Core.setState()` avoiding any cross-module `.viewer-img.active[data-decoded="true"]` DOM probes.

### 3. Extracted Inputs (`viewer/viewerGestures.js`)
Handles the mouse interactions, panning logic, and the `window.__TAURI__.window.cursorPosition()` polling for unbounded panning outside the browser window.
- Plugs directly into `viewportState.panTo()`.

### 4. Thin Facade (`viewer/viewer.js`)
The old `viewer.js` is gone. Instead, `src/js/viewer/viewer.js` acts as a facade.
- It instantiates the new math/render/gestures layers.
- It re-exports the exact same `Viewer` API (`Viewer.zoomAt()`, `Viewer.applyFitMode()`, etc.) so that `main.js` and `filePanel.js` continue working without large refactors.

### 5. Consolidated Preload (`fsUtils.js`)
Added `FsUtils.neighborEntries(state, index, half)`.
- It unifies the `±7` sliding window logic.
- Both the background Rust prefetching and the frontend `<img async>` preloaders now share the same deterministic list of surrounding files.

### 6. Cleaned up main.js
- Removed redundant `Viewer.applyFitMode()` calls. Instead, `main.js` calls `Core.setFitMode(...)` which automatically causes the Viewer to recalculate layouts reactively through state changes.

## Verification
- Code syntax verified completely via `node --check` across the `src/js` tree.
- Tested `cargo check` and confirmed everything compiles smoothly.
- Application boots and auto-reloads.

> [!TIP]
> The app is ready for you to manually smoke-test (try panning, zooming, zooming out-of-bounds, opening next/prev images, and ensuring the status bar updates properly). Once verified, you can commit these changes to `refactor/decoupling`.
