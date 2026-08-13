# JS DOM Decoupling — Implementation Plan

Scope: the `.agents/additions.md` **JS DOM Decoupling (Refactoring)** item — move DOM interaction/manipulation into cohesive modules communicating via state callbacks, and remove clutter debt across the frontend. Based on the per-file analysis in `.agents/decoupling-analysis/` (7 subagent reports).

This branch (`refactor/decoupling`) already carries the CSS Decoupling slice (global.css). This plan is the JS follow-up.

---

## Ground rules

- **Work in logical slices.** Each slice is an independent commit on `refactor/decoupling`, leaves the app functional, and is verified (`node --check` + manual smoke) before moving on (per `AGENTS.md` "Work in logical slices" and additions.md User Verification Gates).
- **Folders as a byproduct of splitting, not a separate pass.** A file moves into a feature folder *only when* a slice creates a sibling for it. Single-file features stay flat in `src/js/`. No pure reorganization commits.
- **Pure modules first.** Extract DOM-free logic into `services/` (no DOM, unit-testable). UI modules import pure modules; never the reverse.
- **core.js stays the state machine.** UI modules import Core; Core must import no UI modules and gain no DOM. Restore its purity.
- **One owner per concern.** Statusbar writes, chrome visibility, fullscreen state, and keybind formatting each get exactly one owner.
- **No behavior change.** Refactors only. Verifications per slice.

---

## Target module map

Feature folders are created only where a slice produces multiple files. New modules are marked **NEW**.

```
src/js/
  core.js                     (state machine — remove theme DOM block, delete dead saveConfig)
  keybinds.js                 (defaults + mergeConfig — redirect normalizeCombo import)
  keyboardNav.js              (generic list nav — leave as-is, reuse in options + filePanel)
  fsUtils.js                  (navigation service — guard Tauri import, export path helpers)
  directoryPrefs.js           (tighten: delete dead branch, extract sorting.js, route via Core)
  navigationHistory.js        (implement-or-remove 'replace'; optional subscriber pattern)
  metadata.js                 (leave as-is; share emptyMeta template)

  services/                   (pure, no DOM)
    keyCombo.js       NEW     (SPECIAL_KEY_MAP, MOUSE_BUTTON_NAMES, formatKeyName,
                               normalizeCombo, formatKeysCombo, findAction, PASSIVE_ACTIONS)
    keybindDomain.js  NEW     (keybindList, comboUsedByOtherAction, hasUsableMenubarBind,
                               canUseMenubarBinds, isLockedBinding, getConflictColors,
                               validateMenubarSafety, LOCKED_BINDINGS, CATEGORIES)
    actions.js        NEW     (ACTIONS registry + dispatch(actionId, ctx))
    viewerMath.js     NEW     (viewport state: zoom/pan/fit/rotate math, injected viewport size)
    sorting.js        NEW     (naturalCompare, applySort — from directoryPrefs)

  viewer/                     (created in Slice 5)
    viewer.js                 (thin facade re-exporting Viewer API)
    viewerRender.js   NEW     (pool lifecycle, transform, --zoom-scale, load/activate, preload)
    viewerGestures.js NEW     (pan gestures: mouse + keyboard + Tauri cursor poll)

  shortcuts/
    shortcuts.js              (input dispatch only; imports keyCombo)
    scrollLatch.js   NEW      (pure latch state machine + persistence via Core API)

  filepanel/                  (created in Slice 6)
    filePanel.js              (self-subscribes to Core; list + columns + breadcrumb + icons)
    favoritesStore.js NEW     (pure favorites data layer: get/save/isFavorite/toggle/collapsed)

  menubar/                    (created in Slice 3)
    menubar.js                (dropdown interaction only)
    chrome.js         NEW     (menu/status visibility flags + .hidden + saveChromeState + restore)
    statusbar.js      NEW     (single writer: filename/dims/index/zoom/fit + scroll indicator)

  main/                       (created in Slice 9)
    main.js                   (thin bootstrap + init + slim onStateChange fan-out)
    fullscreen.js     NEW     (toggle, hold-to-exit, hide-probe, pre-fullscreen snapshot)
    dropzone.js       NEW     (drag-drop wiring + dropped-path loading)
    lifecycle.js      NEW     (window title, GitHub, onCloseRequested flush, watcher, single-instance)
    metadataBadge.js  NEW     (metadata fetch + cover thumbnail + badge)
    configPreview.js  NEW     (previewTheme/previewCss/revert state machine + emergency reset)

  options/
    options.js                (window orchestration; imports theme.js/configPreview.js/keybindDomain)
    keybindUi.js              (capture/render only; imports keybindDomain.js)
    associationsUi.js         (renderer; pure delta moved to services or inline)
    windowFit.js      NEW     (fitContentWidth + OPTIONS_MAX_INITIAL_W, shared with metadata)

  metadata/                   (created in Slice 9)
    metadata-window.js        (keep single file; imports theme.js; shared windowFit)
    (no render/fit sub-split — 212-line file, render-side split is low value)

  shared/
    themePrePaint.js  NEW     (classic IIFE; canonical pre-paint theme/CSS injector)
    theme.js          NEW     (applyTheme, applyCustomCss — single shared implementation)
    shellBackground.js        (wire existing theme-preview/css-preview events; drop dead hook)
```

Flat files stay put until a slice gives them a sibling. `metadata/` folder created in Slice 9 only if `metadata-window.js` gains a sibling; otherwise it stays flat.

---

## Cross-cutting duplication to eliminate

| # | Duplication | Slices |
|---|---|---|
| 1 | `applyTheme`/`applyCustomCss` in main.js, options.js, metadata-window.js + 3 inline head scripts + core.js loadConfig | 1 |
| 2 | Combo formatting/normalization: shortcuts.js, keybinds.js (import), keybindUi.js, main.js `keyEventCombo` | 1, 7 |
| 3 | Modifier key set + double-click gesture + wheel-direction: shortcuts.js × keybindUi.js | 1, 7 |
| 4 | List-normalization idiom (string-or-array → array) — 7+ sites across 4 files | 1 |
| 5 | Basename/path helpers — 4 implementations (fsUtils, main.js ×2, metadata.js) | 1 |
| 6 | Statusbar written by 3 modules (main, viewer, shortcuts) | 2 |
| 7 | Menu/status visibility + pre-fullscreen state split across menubar.js/main.js | 3 |
| 8 | Fullscreen chrome/exit UX in main.js | 4 |
| 9 | Zoom/pan/fit math mixed with DOM in viewer.js; double applyFitMode; DOM probe into pool | 5 |
| 10 | filePanel monolith + unused keyboardNav.js + self-dispatch/self-listen + one-shot Viewer dep | 6 |
| 11 | Options save flow + preview protocol + emergency reset + Home/End vs main.js | 7 |
| 12 | ~40 magic `cmd-*` ids + bindMenuCommands ≈ dispatchAction | 8 |
| 13 | Inline head theme/CSS injector (3 copies) | 1 |
| 14 | `META_MAX_INITIAL_H`/`OPTIONS_MAX_INITIAL_W` cross-language drift (JS vs config.rs) | 7, 9 |
| 15 | Dead code: core.js `saveConfig`, menubar `Viewer` import, main.js dead imports, `bindingMatches`, `formatKeyCombo(e)`, `history:'replace'`, unreachable `default_sort`, `quivit:shell-sync` | 1 |

---

## State contracts to add

- **`state.decodedSrc`** — set by viewerRender after `_activatePoolNode`; lets main.js/statusbar test `state.decodedSrc === state.src` instead of querying `.viewer-img.active[data-decoded="true"]`. Removes the DOM probe and the `data-decoded` coordination channel.
- **`Core.setScrollZoomLatched(value)`** — replaces direct `config.frontend_data.scroll_zoom_latched` mutation + `persistConfig` from shortcuts.js.
- **`Core.setDirectorySortPref(path, col, desc)`** — replaces directoryPrefs mutation of the Core snapshot.
- **`Core.setChromeState({menu, status})`** or a `chrome.js` accessor — single home for visibility flags so main/menubar stop sharing a mutable `let`.
- **`theme-changed` / shared `theme.js`** — the single applyTheme/applyCustomCss used by main, options, metadata-window; core.js `loadConfig` dispatches it instead of writing DOM.
- **`configPreview` state machine** — `previewing`/theme/CSS/revert shared by options.js and main.js.
- **Single action source** — `actions.js` ACTIONS registry; keybinds.js defaults, keybindUi CATEGORIES, bindMenuCommands, and index.html ids all derive from it.
- **Single preload window** — one shared `FsUtils.neighborEntries(state, index, half)` feeding both viewer preload and fsUtils prefetchAhead (or one preload owner).
- **Shared chrome selector** — one `isViewportChrome(e)` helper used by viewer, shortcuts, main.js.

---

## Slices

### Slice 1 — Foundation (shared pure modules + dead code)

**Files touched:** new `services/keyCombo.js`, `shared/themePrePaint.js`, `shared/theme.js`; `keybinds.js`, `shortcuts.js`, `main.js`, `options.js`, `metadata-window.js`, `core.js`, `fsUtils.js`, `metadata.js`, `navigationHistory.js`, `directoryPrefs.js`, `shellBackground.js`; `index.html`, `options.html`, `metadata.html`.

**Tasks:**
1. Extract `services/keyCombo.js` (SPECIAL_KEY_MAP, MOUSE_BUTTON_NAMES, formatKeyName, normalizeCombo, formatKeysCombo, findAction, PASSIVE_ACTIONS). Point keybinds.js/shortcuts.js/keybindUi.js/main.js imports at it. Delete dead `bindingMatches`, `formatKeyCombo(e)` param. Add `isModifierKey()` + shared list-normalization helper; replace the 7+ inlined idioms. Route main.js `keyEventCombo` through `formatKeysCombo`.
2. Extract `shared/themePrePaint.js` (classic IIFE, no imports/exports) with the exact localStorage + `data-theme` + `#custom-css` logic; replace the 3 inline `<head>` blocks with `<script src="/js/shared/themePrePaint.js"></script>`. **Classic scripts (non-module, no defer) block parsing exactly like inline JS, so pre-paint behavior is preserved — verified by shellBackground.js loading the same way.**
3. Extract `shared/theme.js` with `applyTheme`/`applyCustomCss`; import from main.js, options.js, metadata-window.js (3 copies collapse to 1). Remove the theme DOM block from `core.js loadConfig` (dispatch `theme-changed` or delegate via callback) — restores core.js purity. Standardize metadata-window's applyTheme to mirror options.js (localStorage 'system' removal path).
4. Export fsUtils path helpers (`_basename` → `basename`, `parentOf`, composite `"archive|entry"` split/join); replace main.js `pathBasename`/`_basename` and metadata.js basename copies.
5. Delete dead code: core.js `saveConfig`; menubar `Viewer` import; main.js `closeMenus`/`findMetadataEntry` imports + unused `menubar` const; navigationHistory `'replace'` branch (or implement it); directoryPrefs unreachable `default_sort` branch; shellBackground `quivit:shell-sync` listener; associationsUi `btn-assoc-apply` workaround (move button visibility to options.js).
6. Guard `window.__TAURI__` at fsUtils module top so pure parts import outside Tauri.

**Outcome:** every file's imports resolve; core.js is pure again; 3 inline scripts + applyTheme/applyCustomCss consolidated; all dead code removed. App boots unchanged.

**Verify:** `node --check` on all touched JS; app boots in Tauri dev; theme/CSS still applied pre-paint on all 3 windows.

---

### Slice 2 — Statusbar single-owner

**Files touched:** new `menubar/statusbar.js`; `main.js`, `viewer.js`, `shortcuts.js`.

**Tasks:**
1. Create `statusbar.js` as the **only** writer of `#statusbar` readouts (`.status-filename`, `.status-dims`, `.status-index`, `.status-zoom`, `.status-fit`, `.status-scroll-zoom`, classes). API: `Statusbar.update(state)` subscribing to `Core.onStateChange`, and `Statusbar.setImage({filename, index, dims, zoom})` for decoded-image metrics.
2. Absorb the scroll-indicator write (`_updateScrollIndicator`) from shortcuts.js via `setScrollIndicatorState()`; shortcuts.js keeps only input logic.
3. Remove main.js's status writes in the `onStateChange` handler (the fragile `data-decoded`/`poolSrc`/`complete` heuristic) and viewer.js's direct writes in `_activatePoolNode`/`_attachLoadHandler`/`_applyTransform`.
4. Cache viewport element once; write statusZoom only when the % changes.

**Outcome:** one writer for all statusbar content; no module reaches into viewer-owned DOM for status.

**Verify:** status readouts correct across load/error/resize/zoom; scroll-latch indicator still updates; `node --check`.

---

### Slice 3 — Chrome/visibility consolidation

**Files touched:** new `menubar/chrome.js`; `menubar.js`, `main.js`, `core.js` (optional `setChromeState`).

**Tasks:**
1. Create `chrome.js` owning `menuBarVisible` + `statusBarVisible`, `.hidden` toggles, `saveChromeState()` (single debounced persist of `menu_visible` + `status_visible`), and config-restore.
2. Move the `_preFullscreenState` box out of menubar.js into chrome.js (it is chrome state, not menubar state).
3. Replace menubar.js `menuBarVisible` mutable export with an accessor (`isMenuBarVisible()`/`setMenuBarVisible(visible, {persist})`); main.js stops reading/writing the `let` directly.
4. Remove main.js `setStatusBarVisible` inline persistence + `toggleStatusBar`; route through chrome.js. Consolidate the two competing debounce timers into one saveChromeState.
5. Move `cmd-toggle-menubar`/`cmd-toggle-statusbar` checkmark sync (`updateViewToggleMenu`) into chrome.js or menubar.js.

**Outcome:** menu/status visibility, persistence, and fullscreen snapshot owned by one module; no parallel implementations.

**Verify:** toggling menu/status bars persists once and restores on reload; `node --check`.

---

### Slice 4 — Fullscreen extraction

**Files touched:** new `main/fullscreen.js`; `main.js`, `menubar/chrome.js`.

**Tasks:**
1. Move clusters E + F + the fullscreenchange/pointer/key/blur listeners from main.js into `fullscreen.js`: `toggleFullscreen`, `setFullscreenUiActive`, hold-to-exit, hide-probe, exit-button/hint, `syncWithOsState()` (reload-in-fullscreen resync).
2. Fullscreen reads `hide_chrome_on_fullscreen` from Core config; chrome hide/restore goes through `chrome.js`'s single API.
3. main.js keeps only the init call.

**Outcome:** fullscreen UX logic self-contained; main.js loses ~200 lines.

**Verify:** toggle/hold-to-exit/hover-exit all work, including Ctrl+Shift+R while fullscreen; `node --check`.

---

### Slice 5 — Viewer split

**Files touched:** new `services/viewerMath.js`, `viewer/viewerRender.js`, `viewer/viewerGestures.js`; `viewer.js` (→ facade), `core.js` (`state.decodedSrc`), `main.js`, `fsUtils.js` (shared neighbor helper).

**Tasks:**
1. Extract `services/viewerMath.js` — pure zoom/pan/fit/rotate state with injected viewport size (`getViewport()` callback or `{w,h}` args). No DOM. Contract: `createViewportState()` returning `{ subscribe(fn), getTransform(), setViewportSize(w,h), applyFitMode(mode, naturalW, naturalH), zoomAt(delta, anchor), panBy(dx,dy), rotate(d), flip(axis), setScaling(m) }`.
2. Extract `viewer/viewerRender.js` — pool bootstrap/lifecycle, `_applyTransform`/`_scheduleTransform`, `_applyScaling`, `_activatePoolNode`, `_attachLoadHandler`, `clearDisplayedImage`, neighbor preload. Owns `#viewer-img-wrapper`, `.viewer-img`, `#viewport` resize listener, `--zoom-scale`. Sets `state.decodedSrc`; reports image metrics to `statusbar.js`. Remove `el._quivitLoadAttached` (attach in `_getPoolNode`).
3. Extract `viewer/viewerGestures.js` — pan state/buttons, mousedown/move/up, cursor poll, body-cursor styling. Talks only to viewerMath.
4. Move `viewer.js` into `viewer/` as a thin facade re-exporting the `Viewer` API from the new modules (main.js/filePanel.js call sites unchanged). Delete dead `imgGrill`/`grillBorder` refs + `padding = 0`.
5. Add `state.decodedSrc` to core.js `_state`; main.js status logic uses it instead of the DOM probe.
6. **Single re-fit path:** remove explicit `Viewer.applyFitMode()` in main.js fit cases; let the state callback be the single path (fixes double applyFitMode).
7. Unified preload: add `FsUtils.neighborEntries(state, index, half)`; use in viewer preload + fsUtils prefetchAhead (single ±7 window + entry filter).

**Outcome:** viewer.js becomes a facade; zoom/pan/fit math is pure and testable; pool/render/gestures owned by dedicated modules; no DOM probe; one re-fit + one preload path.

**Verify:** navigation, zoom, pan, rotate/flip, fit modes, preloading all work; `node --check`; `state.decodedSrc` present in DevTools.

---

### Slice 6 — filePanel split

**Files touched:** new `filepanel/favoritesStore.js`; `filepanel/filePanel.js` (moved), `main.js`, `keyboardNav.js` (reuse).

**Tasks:**
1. Extract `filepanel/favoritesStore.js` — pure favorites data layer (`getFavorites`, `saveFavorites`, `getFavoritesCollapsed`, `saveFavoritesCollapsed`, `isFavorite`, `toggleFavorite`) with a `Core`-interface seam.
2. Move `filePanel.js` into `filepanel/`; it keeps its DOM render (list, columns, icons, breadcrumb, resize) in one file — **no render-side sub-split** (splitting a DOM monolith into sibling DOM files relocates coupling without removing it).
3. Self-subscribe to `Core.onStateChange` inside filePanel so main.js drops its explicit `renderFilePanel` call (or standardize the single render entry point).
4. Replace the one-shot `Viewer.applyFitMode()` (panel-resize) with a dispatched `quivit-panel-resized` event subscribed by viewer.
5. Reuse `keyboardNav.js` for the composite favorites + file-list navigation; delete the two inline duplicate keyboard-nav blocks and the redundant `quivit-load-file` self-listener.
6. De-duplicate double-click detection (main list vs favorites).
7. Move inline icon `innerHTML` templates to createElement/textContent (or an escaping helper) — defer if it complicates the slice; note as follow-up.

**Outcome:** filePanel.js is smaller, self-subscribed, favorites are pure; no Viewer dependency; keyboardNav.js finally used.

**Verify:** panel renders, favorites star/persist/collapse work, panel + column resize work; `node --check`.

---

### Slice 7 — Keybind UI + Options decouple

**Files touched:** new `services/keybindDomain.js`, `options/configPreview.js`, `options/windowFit.js`; `keybindUi.js` (moved to `options/`), `options.js`, `main.js`, `associationsUi.js`.

**Tasks:**
1. Extract `services/keybindDomain.js` — keybindList, comboUsedByOtherAction, hasUsableMenubarBind, canUseMenubarBinds, isLockedBinding, getConflictColors, validateMenubarSafety (single copy of the menubar-rule), LOCKED_BINDINGS, CATEGORIES (derived from DEFAULT_KEYBINDS). keybindUi.js's triplicated rule collapses to it. Reuse shortcuts.js gesture primitives (double-click, wheel direction, modifier set) for capture.
2. Extract `options/configPreview.js` — `previewing`/theme/CSS/revert state machine + the event protocol (`theme-preview`/`css-preview`); shared by options.js and main.js.
3. Extract `options/windowFit.js` — `fitContentWidth`/`fitContentHeight` + `OPTIONS_MAX_INITIAL_W`/`META_MAX_INITIAL_H` from a shared constants module (single source; note cross-language drift with config.rs).
4. Route options save through a shared config-save helper (or a Core-style API) instead of duplicating merge+invoke+emit. Split the 45-line save handler into pure form→config mapping + thin IPC glue.
5. Move the emergency CSS reset + Home/End tab-jump into shared helpers (keyboardNav.js for tab-jump; configPreview for the reset); delete the main.js/options.js verbatim copies.
6. `associationsUi.js`: pure `computeAssociationsDelta(checkboxes)`; move inline styles to CSS classes; options.js drives the apply-button visibility.
7. keybindUi: replace `innerHTML=''` full rebuilds with row-scoped updates to preserve focus (defer if risky; note as follow-up).

**Outcome:** keybind domain logic pure and single-sourced; preview state shared; options.js slimmed; no duplicated reset/tab-jump/save flow.

**Verify:** Options save/cancel/revert/preview work; keybind capture + conflict colors work; CSS/theme previews live-update in main window; `node --check`.

---

### Slice 8 — Actions registry + menu collapse

**Files touched:** new `services/actions.js`; `main.js`, `keybinds.js`, `keybindUi.js` (CATEGORIES), `index.html` (optionally generate ids).

**Tasks:**
1. Create `services/actions.js` — a pure `ACTIONS` registry mapping each `cmd-*` id to its command (a function of `{ Core, FsUtils, Viewer, ... }`), plus a `dispatch(actionId, ctx)` that looks it up. This becomes the single source of truth; keybinds.js defaults, keybindUi CATEGORIES, and index.html ids derive from it.
2. Collapse `bindMenuCommands` in main.js: each menu item becomes `getElementById(id).addEventListener('click', () => dispatch(id))`. The action bodies move out of main.js into actions.js.
3. `dispatchAction`'s ~160-line switch is replaced by registry lookup (the switch cases become the registry entries).
4. Delete the no-op `btn` lookup block; drop the duplicated `archiveEntryRealPath`/`archiveEntryContainerPath` helpers (use fsUtils composite-path helpers from Slice 1).

**Outcome:** action ids are data, not magic strings; menu wiring is ~10 lines; dispatch is a lookup.

**Verify:** every menu item + keybind + scroll/mouse action still works; `node --check`.

---

### Slice 9 — Final thinning + small-module polish

**Files touched:** new `main/lifecycle.js`, `main/metadataBadge.js`, `main/dropzone.js`; `main.js` (→ `main/`), `metadata-window.js`, `shellBackground.js`, `associationsUi.js` (if not done), `navigationHistory.js`, `directoryPrefs.js`.

**Tasks:**
1. Extract `main/lifecycle.js` — window title, openGithub, onCloseRequested flush, directory-changed debounce, single-instance-open.
2. Extract `main/metadataBadge.js` — `_loadMetadataForArchive`, `_generateCoverThumbnail`, `openMetadataWindow`, subscribing to Core when `mode === 'archive'`; removes `_lastMetadataArchive`/`_currentMeta` from main.js.
3. Extract `main/dropzone.js` — drag-drop wiring + `showDropMessage`/`loadDroppedPath` (validation folded into fsUtils).
4. Move `main.js` into `main/` as thin bootstrap + init + slim `Core.onStateChange` fan-out.
5. metadata-window.js: keep one file; import shared `theme.js` + `windowFit.js`; consolidate on one live-update mechanism (event **or** storage, not both).
6. shellBackground.js: wire existing `theme-preview`/`css-preview`/storage events instead of the raw head MutationObserver; drop the dead `quivit:shell-sync` listener.
7. directoryPrefs.js: extract `services/sorting.js` (naturalCompare, applySort); delete dead branch; route writes through a Core API.
8. navigationHistory.js: implement `'replace'` or remove the branch.
9. Final sweep for dead code/comment debt across all files; re-run `node --check` on every module and a full app smoke test.

**Outcome:** main.js is a bootstrap; every feature owns its DOM; no cross-module probes; the repo is ready for the push pipeline.

**Verify:** full app smoke test (open dirs/archives, navigate, fullscreen, options, metadata window, favorites, associations, quit-with-pending-config); `node --check` all modules; `git diff --check`.

---

## Commit sequence (one per slice on `refactor/decoupling`)

1. `slice1: Foundation — shared pure modules, theme consolidation, dead code`
2. `slice2: Single statusbar owner`
3. `slice3: Chrome/visibility consolidation`
4. `slice4: Fullscreen module`
5. `slice5: Viewer split (math/render/gestures)`
6. `slice6: filePanel decouple + favorites store`
7. `slice7: Keybind domain + options decouple`
8. `slice8: Actions registry + menu collapse`
9. `slice9: main.js thinning + polish`

After each slice: commit + summary of changed files + note what was verified; ask for user verification before the next slice per additions.md User Verification Gates.

---

## References

- Per-file analysis: `.agents/decoupling-analysis/` (01-main.js, 02-viewer.js, 03-filePanel-fsUtils, 04-keybindUi-options, 05-shortcuts-keybinds-keyboardNav, 06-core-menubar, 07-small-modules)
- Source of scope: `.agents/additions.md` → **JS DOM Decoupling (Refactoring)**
- Style rules: `.agents/AGENTS.md` (Measure twice cut once, Work in logical slices, Performance first, YAGNI, Self-documenting code)