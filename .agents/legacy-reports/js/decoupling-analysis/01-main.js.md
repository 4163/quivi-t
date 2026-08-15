# main.js — Decoupling Analysis

> File: `src/js/main.js` — ~1006 lines (reported; actual may be slightly higher)
> Role: Window bootstrap / DOM wiring entry module. Imports every subsystem, exports **nothing**. It is the only module that composes the app.

## 1. Exports

None. `main.js` is a pure side-effect/entry module. All functionality is consumed by other modules through callbacks and injected dependencies.

## 2. Imports

| Module | Symbols used | Purpose |
|---|---|---|
| `./core.js` | `Core` | getState, onStateChange, navigate, jumpToIndex, setFitMode, setScalingMode, setFileListVisible, toggleTransparentBg, persistConfig, flushConfig, loadConfig, init |
| `./fsUtils.js` | `FsUtils` | openDirectoryDialog/FileDialog, refresh, openParent, openSibling, loadHistoryEntry, loadFile, buildArchiveSrc, isImage, isArchive, isImageEntry, naturalPagePosition, formatStatusIndex |
| `./viewer.js` | `Viewer` | panBy, zoomAt, zoomCenter, setZoom, applyFitMode, rotate, flipHorizontal, flipVertical, setScaling |
| `./navigationHistory.js` | `NavigationHistory` (ns) | goBack, goForward, canGoBack, canGoForward |
| `./filePanel.js` | initFilePanel, renderFilePanel, toggleFavoriteCurrent, getHighlightedFavorite, navigateHighlightedFavorite | panel init, render-on-state-change, action dispatch |
| `./shortcuts.js` | bindKeyboardShortcuts, updateMenuShortcuts, resetScrollLatch, syncScrollLatch, normalizeCombo, formatKeyName | keyboard bridge, shortcut-label sync, scroll latch resync |
| `./keybinds.js` | DEFAULT_KEYBOARD_PAN_STEP, DEFAULT_WHEEL_PAN_STEP | pan-step fallbacks |
| `./menubar.js` | initMenuBar, closeMenus *(dead)*, toggleMenuBar, menuBarVisible, setMenuBarVisible, getPreFullscreenState, setPreFullscreenState | menubar init, fullscreen chrome orchestration |
| `./metadata.js` | fetchMetadata, findMetadataEntry *(dead)* | metadata badge fetch |

**Dead imports confirmed:** `closeMenus` (never called) and `findMetadataEntry` (never called). The `menubar` element ref is declared but never used.

## 3. DOM access

~180 direct touchpoints: `getElementById` (62), `addEventListener` (~55 DOM + 9 Tauri `listen`), `classList` (37), `querySelector/All` (9), `textContent` (9), `setAttribute/toggleAttribute` (4), `createElement` (3), `.style` (1). Zero `innerHTML`.

**Element groups touched:**
1. Menubar command buttons — `#menubar`, ~40 `#cmd-*` items, `[data-scaling]` radio items (heaviest group: `bindMenuCommands` + `updateScalingMenu`/`updateViewToggleMenu`/`setMenuItemMuted`).
2. Statusbar — `#statusbar`, `.status-filename`, `.status-dims`, `.status-index`, `.status-zoom`, `.status-fit`, `#status-metadata-badge`.
3. File panel — `#file-panel`, `#file-panel-breadcrumb`, `#file-list`, `#panel-resize-handle`, `#cmd-open-explorer`, `#cmd-open-folder`.
4. Viewer wrapper / grill — `#viewport`, `.viewer-img.active[data-decoded]`, `#img-grill`, `#img-grill-border`.
5. Drop overlay — `#drop-overlay`, `.drop-hint p`.
6. Fullscreen exit UI — `#fullscreen-exit-hint/-key/-region/-btn`, `document.body` classes.
7. Head/global — `document.head` (`<style id="custom-css">`), `document.documentElement` (`data-theme`), `document.body` (hide-probe div).

## 4. Responsibility clusters

| # | Cluster | Lines | Functions |
|---|---|---|---|
| A | Global keydown (emergency reset + Home/End tab jump) | 27–67 | top-level anonymous handler |
| B | Metadata badge + cover thumbnail | 112–176 | `_loadMetadataForArchive`, `_generateCoverThumbnail`, `openMetadataWindow` |
| C | Menu state sync | 178–205 | `updateScalingMenu`, `setMenuItemMuted`, `updateHistoryMenu`, `updateViewToggleMenu`, `setScaling` |
| D | Custom CSS + pan-step cache + pan bridge | 207–226 | `applyCustomCss`, `updatePanSteps`, `dispatchKeyboardPan` |
| E | Fullscreen exit key UI (hold-to-exit) | 228–366 | `getFullscreenExitBindings`, `formatFullscreenExitKeyLabel`, `updateFullscreenExitKeyLabel`, `initFullscreenExitHideProbe`, `keyEventCombo`, `isFullscreenExitKey`, `cancelFullscreenExitKeyHold`, `hide/showFullscreenExitHint`, `hide/showFullscreenExitButton`, `setFullscreenUiActive`, `startFullscreenExitKeyHold`, `handleFullscreenExitKeyDown/Up/MouseMove` |
| F | Chrome visibility + fullscreen toggle | 368–436 | `setStatusBarVisible`, `setFileListVisible`, `toggleFileList`, `setFullscreenChromeVisible`, `restorePreFullscreenChrome`, `toggleFullscreen`, `toggleStatusBar` |
| G | GitHub + basename helpers | 438–449 | `openGithub`, `pathBasename` |
| H | Drop messages + dropped-path loading | 451–492 | `showDropMessage`, `resetDropMessage`, `loadDroppedPath` |
| I | Action dispatch (keybind → command bridge) | 494–652 | `dispatchAction` (~150-line switch) |
| J | Menu click binding | 654–808 | `bindMenuCommands`, nested `archiveEntryRealPath`/`archiveEntryContainerPath`, explorer/folder button handlers |
| K | Drag-drop + config previews + single-instance + fullscreen resync | 810–940 | `bindDragDrop`, `applyPreviewTheme`, config-updated/changed listeners, `syncFullscreenUi` |
| L | Window title | 942–974 | `updateWindowTitle`, `_basename` |
| M | Core state-change handler | 976–1068 | big `Core.onStateChange` callback (drop overlay, statusbar, grill, status text, scaling, history/toggle menus, renderFilePanel, metadata fetch) |
| N | Lifecycle / init | 1070–1118 | history/fullscreen/pointer/key/blur listeners, initFilePanel, initMenuBar, bindMenuCommands, bindDragDrop, bindKeyboardShortcuts, directory-changed watcher, onCloseRequested flush, Core.init() |

## 5. Coupling / overlap

- **Pan steps vs keybinds/shortcuts** — `updatePanSteps` re-parses the same config keys that `keybinds.js` normalizes and `shortcuts.js` already pre-parses on the same event. Two independent passes feeding the pan hot path.
- **Fullscreen chrome vs menubar.js** — main.js orchestrates fullscreen while menubar.js stores `_preFullscreenState`. Split across modules; `setStatusBarVisible` reimplements persistence inline instead of a shared helper.
- **Scroll indicator vs shortcuts.js** — main.js calls reset/syncScrollLatch, but the statusbar DOM writer lives in shortcuts.js. `#statusbar` is written by three modules: main.js (status text), viewer.js (dims/zoom/index), shortcuts.js (scroll indicator).
- **Statusbar text: main.js ↔ viewer.js** — both write `.status-*` elements; main.js guards with a fragile `data-decoded`/`poolSrc`/`complete` heuristic into viewer-owned DOM.
- **`applyCustomCss` triplicated** — identical injector in main.js, options.js, metadata-window.js (plus the inline head scripts = 4th copy). Theme `data-theme` application also duplicated across core.js/options.js/main.js/metadata-window.js.
- **Tab-nav (Home/End) duplicated** — identical block in main.js and options.js, even though keyboardNav.js exists.
- **`dispatchAction` vs `bindMenuCommands`** — every menu item has both a click handler and a dispatchAction case that usually do the same thing.
- **Basename duplication** — `pathBasename` and `_basename` both in main.js; fsUtils has its own.
- **Core state callbacks scattered** — `quivit-config-loaded` listened to by main.js, shortcuts.js, filePanel.js, viewer.js independently; `quivit-refresh-start/end`, `quivit-load-file`, `quivit-history-changed` are ad-hoc event channels.

## 6. Code smells

- Dead code/imports/vars: `closeMenus`, `findMetadataEntry`, `menubar` const, no-op `btn` lookup block in dispatchAction.
- Long functions: `dispatchAction` (~160), `bindMenuCommands` (~155), `bindDragDrop` (~130), `onStateChange` callback (~90).
- Mixed concerns: `bindDragDrop` bundles drag-drop + preview state + config-reload listeners + single-instance + fullscreen resync.
- Event listener sprawl: ~55 DOM + 9 Tauri listeners, two competing window keydown handlers.
- Manual timer management: 7 hand-tracked timers.
- Implicit shared state: module vars (`activeScaling`, `statusBarVisible`, `fullscreenActive`, etc.) mutated across many functions with no encapsulation.
- Magic strings: ~40 `cmd-*` action IDs duplicated across dispatchAction, bindMenuCommands, keybinds.js, index.html.
- Top-level global keydown runs emergency-reset logic before init — a whole feature at module scope.

## 7. Decoupling recommendations

Per `.agents/additions.md` JS DOM Decoupling (state-callbacks model):

1. **`statusbar.js`** — single owner of all `#statusbar` elements (clusters C + parts of M). Subscribes to Core.onStateChange; viewer.js emits an `onImageMetrics` callback/event instead of writing `.status-*` directly; absorbs the scroll-indicator write from shortcuts.js via `setScrollIndicatorState()`. Kills the 3-writer problem.
2. **`fullscreen.js`** — clusters E + F + the fullscreenchange/pointer/key/blur listeners. Owns `fullscreenActive`, exit-key hold, hide-probe, body classes, chrome snapshot. Consumes visibility through `setMenuBarVisible`/`setStatusBarVisible` APIs. Pre-fullscreen snapshot moves here from menubar.js.
3. **`dropzone.js`** — drag-drop portion of cluster K + cluster H. API `initDropZone({ onOpenPath })`.
4. **`configPreview.js`** — previewTheme/previewCss/applyCustomCss/applyPreviewTheme/emergency-reset. Consolidates the triplicated applyCustomCss into one shared helper.
5. **`actions.js` / `commandActions.js`** — cluster I as a pure action→command map + shared `ACTIONS` registry so `cmd-*` ids stop being magic strings. `bindMenuCommands` shrinks to `getElementById(id).addEventListener('click', () => dispatch(id))`.
6. **`lifecycle.js`** — window title, GitHub open, onCloseRequested flush, directory-changed debounce, single-instance-open.
7. **`metadataBadge.js`** — cluster B + metadata branch in cluster M, subscribing to Core when `mode === 'archive'`.
8. **`globalKeyHandlers.js`** — cluster A. Tab-jump moves to keyboardNav.js; emergency reset moves to configPreview.js.

**What stays in main.js:** thin bootstrap — module imports, element refs passed into `init*` functions (existing `initFilePanel({...deps})` DI pattern is correct), slim `Core.onStateChange` dispatcher that fans out to module callbacks, and the init sequence.

**State contracts / callbacks needed:**
- Pan: `PanController` module (`setSteps({keyboard, wheel})` + `apply(dx, dy, {wheel})`), or move step parsing fully into shortcuts.js.
- Statusbar: `Statusbar.update(state)` subscribes to Core.onStateChange; `Statusbar.setImage({filename, index, dims, zoom})` from viewer callbacks.
- View-toggle checked state: `MenuState.sync(state)` subscriber.
- Config-loaded: each new module subscribes for its slice instead of one mega-listener.
- Fullscreen: `Fullscreen` reads `hide_chrome_on_fullscreen` from Core config; chrome toggles become a single `setChromeVisible()` API.

**Priority order (lowest-risk first):** (1) statusbar.js; (2) fullscreen.js; (3) collapse bindMenuCommands onto dispatchAction + actions registry; (4) dropzone.js; (5) configPreview.js; (6) metadata + global-key clusters; (7) thin main.js to bootstrap + init.
