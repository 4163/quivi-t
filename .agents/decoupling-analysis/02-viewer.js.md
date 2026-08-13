# viewer.js — Decoupling Analysis

> File: `src/js/viewer.js` — ~781 lines (reported 678; actual higher)
> Role: Viewport rendering — fit/zoom/pan over a 2-node sliding `<img>` pool inside `#viewer-img-wrapper`, subscribed to Core state.

## 1. Exports

Only one export: `const Viewer = { ... }` (L764). Nine methods:

| Export | Defined | Purpose | Consumers |
|---|---|---|---|
| `applyFitMode` | L185 | Recompute scale/pan from fit mode + viewport/natural dims; resets pan per fit mode; schedules transform | main.js, filePanel.js, resize listener |
| `zoomAt(delta, cx, cy)` | L283 | Wheel/keybind zoom around a viewport anchor; does **not** switch fit mode | main.js |
| `zoomCenter(delta)` | L289 | Zoom anchored at center | main.js |
| `panBy(dx, dy)` | L498 | Relative pan | main.js |
| `rotate(deltaDegrees)` | L295 | Rotation | main.js |
| `flipHorizontal()` | L301 | Flip X | main.js |
| `flipVertical()` | L306 | Flip Y | main.js |
| `setScaling(mode)` | L505 | Sets scaling dataset + imageRendering | main.js |
| `setZoom(exactScale)` | L773 | Exact scale + forces fit mode 'none'; duplicates zoomCenter math | main.js |

Module-internal (not exported): `zoomTo`, `clearDisplayedImage`, all `_`-prefixed pool/pan/preload internals.

## 2. Imports

| Module | Symbols | Notes |
|---|---|---|
| `./core.js` | Core — getState, onStateChange | Pure state read only |
| `./fsUtils.js` | revokeIfObjectURL, isImageEntry, isIco, buildArchiveSrc, buildFileSrcSync, formatStatusIndex | Own sync URL building for neighbors |
| `./shortcuts.js` | activeKeys, MOUSE_BUTTON_NAMES | activeKeys for keyboard-pan hold; MOUSE_BUTTON_NAMES for pan-button table |
| `./keybinds.js` | DEFAULT_FIT_MODE, DEFAULT_SCALING_MODE | Module defaults mirroring Core's |

Note: `menubar.js` imports `Viewer` but never uses it (dead import).

## 3. DOM access

**Heavy.** ~50+ DOM statements.

Reads at module init (side-effectful module body): `getElementById('viewer-img-wrapper')` L21, `getElementById('viewer-img')` L23, `querySelectorAll('.viewer-img')` L26, `createElement('img')` L34/L52, `getElementById('img-grill')`/`img-grill-border` L108-109 (**dead — never used again**), `querySelector` status elements L110-113, `getElementById('viewport')` L751.

**Repeated hot-path lookups:** `document.getElementById('viewport')` at L150, 186, 264, 290, 776 — 5 sites.

**Element groups owned:**
1. Image pool (`.viewer-img` in `#viewer-img-wrapper`) — full lifecycle (L26-105, 516-568, 683-739).
2. `#viewer-img-wrapper` — the only transformed element: `style.transform` + `setProperty('--zoom-scale', _scale)`.
3. `#viewport` — event target + geometry source.
4. Statusbar readouts `.status-zoom/.status-dims/.status-filename/.status-index` — written by viewer **and** main.js.
5. `document.body.style.cursor` — pan grab cursor.
6. `#img-grill` / `#img-grill-border` — declared but not touched; `.active` toggled by main.js.
7. Off-DOM `new Image()` preloaders + Tauri window cursor polling.

**Event listeners:** resize, viewport mousedown/contextmenu, window mousemove/mouseup, window keyup/blur, `quivit-config-loaded`, per-node `load`.

## 4. Responsibility clusters

| Cluster | Lines | Functions |
|---|---|---|
| Pool bootstrap / DOM setup | 14–42 | module body (side effects at import time) |
| Pool lifecycle | 44–105 | `_getPoolNode`, `_recyclePoolNode`, `_dropExtraPoolNodes`, `_loadPoolNode`, `_setElementLoadingLabel`, `_isVisibleImage` |
| Viewer state + element refs | 107–125 | module vars + status/grill refs |
| Scaling / fit math | 127–251 | `_applyScaling`, `_visualSize`, `_clampPan`, `_applyTransform`, `_scheduleTransform`, `applyFitMode` (L185-251, 66 lines — pure math embedded with DOM reads) |
| Zoom / rotate / flip | 253–309 | `zoomTo`, `zoomAt`, `zoomCenter`, `rotate`, `flipHorizontal`, `flipVertical` |
| Pan gestures (mouse + keyboard + Tauri poll) | 311–508 | `_updatePanKeysCache`, `_keyPanHeld`, `_isMousePanKey`, `_panActive`, `_startPan`, `_stopPan`, `_cursorToClient`, `_startCursorPoll`, `_stopCursorPoll`, `_pollCursor`, `_updatePan`, `_onMouseDown/Move/Up`, `panBy` (largest cluster) |
| Scaling setter | 505–508 | `setScaling` |
| Image load / activation | 510–568 | `_activatePoolNode`, `_attachLoadHandler` |
| State subscription + preloading | 570–745 | `_clearTargetLoadTimer`, `_clearScheduledPreloads`, `_schedulePoolPreloads`, `clearDisplayedImage`, `Core.onStateChange` (L630-745, giant 115-line callback) |
| Event wiring + export | 747–781 | resize, mouse listeners, `Viewer` object |

## 5. Coupling / overlap

1. **Status readout contention (viewer ↔ main.js).** Both query/write the same 4 elements; main.js guards via a DOM probe into viewer's pool (`document.querySelector('.viewer-img.active[data-decoded="true"]')`). Two writers, one coordination hack.
2. **`img-grill`/`img-grill-border` split ownership.** Live in viewer's wrapper; viewer declares but never uses (dead refs); main.js toggles `.active`. `--zoom-scale` CSS var is the coupling channel.
3. **Object URL revocation.** `FsUtils.revokeIfObjectURL` called from core.js, fsUtils, and viewer `_recyclePoolNode` — same src can be revoked twice.
4. **Preloading parallelism.** viewer `_schedulePoolPreloads` (browser `Image`, ±7 window) vs fsUtils `prefetchAhead` (backend archive prefetch, ±7 window) — two independent neighbor-window systems. `entrySrcAt` re-implements entry filtering already in core.js/fsUtils.
5. **Pan keybind default duplicated.** `_updatePanKeysCache` fallback `['MouseLeft','MouseMiddle','Space']` duplicates `DEFAULT_KEYBINDS['cmd-pan-drag']`.
6. **UI-chrome selector lists duplicated 3 ways.** viewer L476, shortcuts `isWheelOverUI`, shortcuts mousedown — same concept, three slightly different strings.
7. **Double `applyFitMode`.** Every fit command calls `Core.setFitMode(...)` then `Viewer.applyFitMode()`, while Core.setFitMode → notify → viewer state handler also calls applyFitMode. Two refits per command.
8. **Statusbar fit/zoom split.** `statusFit` formatted in main.js only; `statusZoom` % in viewer only; formatting scattered across two modules.

## 6. Code smells

- Dead code: `imgGrill`/`grillBorder` refs, `padding = 0` constant, unused `Viewer` import in menubar.js.
- Long functions: `Core.onStateChange` handler (~115 lines, five concerns), `applyFitMode` (~66 lines, four concerns).
- Mixed concerns: pan cluster mixes DOM + shared activeKeys + Tauri polling + cursor styling.
- Comment debt: stale/odd comments, mixed `// ──` and `// ---` section headers.
- Hot-path inefficiencies: `_applyTransform` rewrites statusZoom on every RAF even when unchanged; 5× viewport getElementById; double applyFitMode; status written in both `_activatePoolNode` and `_attachLoadHandler`.
- Duplicated helpers: `_activatePoolNode` vs `_attachLoadHandler` (near-identical status/dims/fit logic); `setZoom` re-implements `zoomCenter` math; `entrySrcAt` duplicates Core/fsUtils filtering.
- DOM expando property: `el._quivitLoadAttached` custom flag on DOM nodes.
- Import-time side effects: pool bootstrap + event registration run on module load; untestable outside DOM.
- Double completion path in preloading: `preloader.onload` + `preloader.decode().catch()` both fire.

## 7. Decoupling recommendations

**A. `viewportState.js` (pure zoom/pan/fit math, no DOM).** Move `_scale/_tx/_ty/_naturalW/H/_rotation/_flipX/Y/_scaling/_currentFitMode`, `_visualSize`, `_clampPan`, `applyFitMode` computation, `zoomTo`/`zoomAt`/`zoomCenter` math, rotate/flip, panBy. Viewport size is *injected* (a `getViewport()` callback or passed `{w,h}` args). Contract: `createViewportState()` returning `{ subscribe(fn), getTransform(), setViewportSize(w,h), applyFitMode(mode, naturalW, naturalH), zoomAt(delta, anchor), panBy(dx,dy), rotate(d), flip(axis), setScaling(m) }`.

**B. `viewerRender.js` (DOM rendering + pool).** Move pool bootstrap + lifecycle, `_applyTransform`, `_scheduleTransform`, `_applyScaling`, `_activatePoolNode`, `_attachLoadHandler`, `clearDisplayedImage`. Owns `#viewer-img-wrapper`, `.viewer-img`, `#viewport` resize listener, and the status readouts it writes. Subscribes to Core + viewportState.

**C. `viewerGestures.js` (pan gestures, DOM + Tauri).** Move pan state/buttons, `_onMouseDown/Move/Up`, cursor poll, body-cursor styling. Talks only to viewportState.panBy/startPan.

**D. `viewerPreload.js` (optional)** — DOM-Image neighbor warm-up, so the state callback shrinks. Combine with viewerRender if 2-file split preferred.

**What stays in `viewer.js`:** thin facade re-exporting `Viewer` API from the new modules so main.js/filePanel.js call sites don't churn.

### Contracts / state additions
- **Decoded-image state in Core (kills the DOM probe).** Add `state.decodedSrc` (set by viewerRender after `_activatePoolNode`) so main.js tests `state.decodedSrc === state.src`. Removes the `data-decoded` coordination channel.
- **Statusbar single-writer.** Centralize status writes in one statusbar module (or a Core `onImageDecoded` callback).
- **Fit command contract.** Remove explicit `Viewer.applyFitMode()` calls in main.js fit cases; let the state callback be the single re-fit path.
- **Pan-bindings source of truth.** Have shortcuts.js export `getPanDragBindings(config)`; delete viewer's duplicate fallback.
- **Shared chrome selector.** Export one `isViewportChrome(e)` helper used by viewer, shortcuts, and main.js.

### Other cleanup
- The ±7 neighbor window + entry filtering is conceptually one operation; a shared `FsUtils.neighborEntries(state, index, half)` could feed both viewer preload and fsUtils prefetchAhead.
- `_recyclePoolNode`'s revoke should be the sole revoke owner for pool srcs; document the division with Core/fsUtils.
- Replace `el._quivitLoadAttached` with attaching load handler inside `_getPoolNode`.
- Cache viewport element once; write statusZoom only when % changes.

**Net result:** the only true *pure* extraction is the zoom/pan/fit math (~200 lines); the render module should own all pool/wrapper/transform writes; gestures are a clean second extraction; the state callback is the prime decomposition target via `decodedSrc` + a preload module.
