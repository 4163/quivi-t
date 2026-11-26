# Audit S02: main shell, chrome, overlays, and stylesheets

Split S02 covers 15 files across `src/index.html`, `src/css/global.css`, `src/css/main.css`, `src/js/main/`, and `src/js/menubar/`. All findings below were verified against live files, `themes/matcha-latte.css`, `themes/sage-mint.css`, `mocha/diagnosticsContract.test.js`, `e2e/replay-diagnostics/probes/viewerPipelineProbe.js`, `e2e/replay-diagnostics/probes/ipcProtocolProbe.js`, `e2e/replay-diagnostics/runner.e2e.js`, `e2e/helpers/recorder-shim.js`, `e2e/pageobjects/`, and `.agents/skills/publish-release/SKILL.md`.

Baseline check: `npm run mocha` passed 308 tests before edits. No source, test, or config files were modified.

## Consensus summary

- **Cohesive files, 4 of 15:** `src/js/main/workspaceBoot.js`, `src/js/main/lifecycle.js`, `src/js/main/dropzone.js`, and `src/js/main/passwordOverlay.js`.
- **Files with agreed findings, 11 of 15:** `src/index.html`, `src/css/global.css`, `src/css/main.css`, `src/js/main/main.js`, `src/js/main/workspace.js`, `src/js/main/fullscreen.js`, `src/js/main/metadataBadge.js`, `src/js/main/urlOverlay.js`, `src/js/menubar.js`, `src/js/menubar/chrome.js`, and `src/js/menubar/statusbar.js`.
- **Dropped or escalated findings:** None. All items reached unanimous `[Agreed]` consensus between `s02-html-css` and `s02-chrome-js`, and all cross-split seams passed Step 4 review.

## File inventory

| File | Lines | Status | Primary issues |
|---|---|---|---|
| `src/index.html` | 544 | `[Agreed]` | Blocking vendor scripts, duplicate `#custom-css`, dead `#viewer-loading-frame` |
| `src/css/global.css` | 278 | `[Agreed]` | Options dark-mode bug and leak, viewer placeholder leak, unused font tokens |
| `src/css/main.css` | 2,885 | `[Agreed]` | Six-owner monolith, universal state selectors, invalid `cursor: disabled`, `.menu-link.has-update` rule order, magic `2.453px` status-version offset |
| `src/js/main/workspaceBoot.js` | 4 | Cohesive | Minimal session gate before importing `main.js` |
| `src/js/main/main.js` | 446 | `[Agreed]` | Dual `#statusbar.hidden` writer, foreign DOM writes, un-gated detached init, direct `open_workspace_window` reach-in |
| `src/js/main/workspace.js` | 86 | `[Agreed]` | Unbounded `resolveClose` await in browser popup fallback |
| `src/js/main/lifecycle.js` | 64 | Cohesive | One nit: missing `.catch` on `single-instance-open` listener |
| `src/js/main/fullscreen.js` | 246 | `[Agreed]` | Foreign `#cmd-fullscreen` write, per-keypress config parsing, one-way sync |
| `src/js/main/dropzone.js` | 105 | Cohesive | One nit: duplicate `drop` listener registration in browser fallback |
| `src/js/main/metadataBadge.js` | 193 | `[Agreed]` | Eager full-res canvas cover generation on every directory and archive open |
| `src/js/main/passwordOverlay.js` | 150 | Cohesive | One nit: stale comment referencing nonexistent `quivit-password-required` |
| `src/js/main/urlOverlay.js` | 223 | `[Agreed]` | 14 hardcoded `#file-panel` selectors, uncached submit button, dead arg |
| `src/js/menubar.js` | 983 | `[Agreed]` | Five-concern monolith (includes update check), startup `fetch_text` contention, uncached update nodes, `mousemove` layout reads, hover IPC race, dead `FIT_LABELS` |
| `src/js/menubar/chrome.js` | 104 | `[Agreed]` | Direct `config.frontend_data` mutation, menu DOM reach-in, missing `Chrome` export |
| `src/js/menubar/statusbar.js` | 456 | `[Agreed]` | Imperative reach-in from 5 modules, forced `offsetWidth` reflow, DOM scraping, duplicate `app.getVersion()` IPC |

## Agreed findings

### S02-01 Blocking vendor scripts and startup waste in `src/index.html`

- **Location:** `src/index.html:538-539`
- **Severity:** `[Blocking]`
- **Status:** `[Agreed]`
- **Problem:** Classic `<script src="js/vendors/pica.js"></script>` and `<script src="js/vendors/purify.min.js"></script>` block parsing before module execution on every startup, including detached `?surface=fileList` windows that never render Lanczos canvases or viewer SVGs.
- **Fix:** Add `defer` or lazy-load `pica.js` inside `src/js/services/scaling/lanczos.js` and `purify.min.js` inside `src/js/shared/svgUtils.js` or `src/js/urlloader/networkClient.js`. Aligns with Sync B and Sync C.

### S02-02 Duplicate `#custom-css` element and markup cleanup in `src/index.html`

- **Location:** `src/index.html:14-15`, `src/index.html:96-105`, `src/index.html:122`, `src/index.html:126`, `src/index.html:184`, `src/index.html:190`, `src/index.html:207`, `src/index.html:271`, `src/index.html:278-309`, `src/index.html:400`, `src/index.html:419`, `src/index.html:426-488`, `src/index.html:528-533`
- **Severity:** `[Warning]`
- **Status:** `[Agreed]`
- **Problem:**
  1. `index.html:14-15` loads `/js/shared/themePrePaint.js` before `<style id="custom-css"></style>`. When `quivit-custom-css` exists in `localStorage`, `themePrePaint.js:7-10` creates and appends its own `<style id="custom-css">`, leaving two `#custom-css` nodes in `<head>`.
  2. `index.html:400` defines `#viewer-loading-frame.is-placeholder`, which has zero JS or CSS activations and exists only to be skipped in `viewerRender.js:21,299,567`.
  3. `index.html:271` places `<div class="scroll-spacer">` directly inside `<ul id="file-list">`, which is invalid `<ul>` child markup.
  4. `index.html:96-105, 122, 126` keep unused `data-checked="false"` attributes, `index.html:184, 190, 278-309, 426-484` repeat presentational `width`/`height` SVG attributes overridden by CSS, `index.html:436-456` and `468-488` duplicate the four volume `<svg>` icons, and `index.html:419` `#viewer-svg-pump` lacks `alt=""`.
- **Fix:**
  1. Declare `<style id="custom-css"></style>` before `<script src="/js/shared/themePrePaint.js"></script>` and update `themePrePaint.js` to populate the existing node. Apply the same order in `options.html` and `metadata.html`.
  2. Delete `#viewer-loading-frame` per Step 4 resolution R3, alongside S06's removal of `#viewer-audio` at `index.html:421` and expansion of `.viewer-img` pool nodes from 2 to 4 at `index.html:405-406`.
  3. Remove unused `data-checked="false"` attributes and redundant SVG `width`/`height` attributes, add `alt=""` to `#viewer-svg-pump`, convert `<div class="scroll-spacer">` to a valid list item in coordination with S04, and keep `#update-indicator` (`index.html:207`) plus `.status-version[aria-label]`, `.status-version-viewport`, `.status-version-codename`, and `.status-version-number` (`index.html:528-533`) intact for `statusbar.page.js:15` and `.agents/skills/publish-release/SKILL.md`.
  4. Reserve disjoint `<template>` slots in `index.html` for S04 (`#file-list-row-template`, `#saved-entry-row-template`, `#library-provider-template`) and S06 (`#manhwa-slot-template`, `#ico-container-template`, `#ico-size-template`).

### S02-03 Page-specific leaks and Light-mode bug in `src/css/global.css`

- **Location:** `src/css/global.css:43-53`, `src/css/global.css:69-80`, `src/css/global.css:127-130`, `src/css/global.css:134-169`, `src/css/global.css:239-240`, `src/css/global.css:274-278`
- **Severity:** `[Blocking]`
- **Status:** `[Agreed]`
- **Problem:**
  1. Lines `127-130` place `.assoc-mascot-svg, .assoc-mascot-box.is-active .assoc-format-icon` inside `@media (prefers-color-scheme: dark)` outside `:root:not([data-theme="light"])`, so Options mascots still receive dark-mode drop-shadow filters when the OS is dark and the user picks Light theme. Both `127-130` and `166-169` belong to Options, not shared globals.
  2. Lines `274-276` define `.viewer-img.is-placeholder { display: none; }` for the dead `#viewer-loading-frame` node.
  3. Lines `43-53` define main-window file-panel layout vars (`--panel-w`, `--panel-h`, `--panel-min-w`, `--panel-max-w`, `--resize-handle-w`, `--col-name-w`, `--col-ext-w`, `--col-date-w`, `--col-size-w`, `--col-dims-w`, `--file-grid-cols`) never used by `options.css` or `metadata.css`. Note that `--col-size-w` and `--col-dims-w` are read and written dynamically by `filePanel.js:141, 552, 556`.
  4. `:root[data-theme="dark"]` at `134-164` omits `--danger` present at `19` and `106`; `--fs-17`, `--fs-19`, `--fs-20`, `--fs-21`, `--fs-22`, `--fs-23`, and `--fs-50` at `69, 71-75, 80` have zero references in `src/`; line `278` has an orphaned empty comment; and `themes/matcha-latte.css:50-52, 78-80` overrides `#options-status` directly instead of `--text-status` as `themes/sage-mint.css:11, 38, 64` does.
- **Fix:** Move `.assoc-mascot-svg` and `.assoc-mascot-box.is-active .assoc-format-icon` to `src/css/options.css` wrapped in `:root:not([data-theme="light"])` inside the dark media query. Delete `.viewer-img.is-placeholder` per R3 and remove the empty comment at line `278`. Move `--panel-*`, `--resize-handle-w`, `--col-*-w`, and `--file-grid-cols` to `src/css/file-panel.css`. Keep `--fs-*` scale tokens and all 22 theme palette, `--checker-*`, and `--grill-*` tokens in `global.css` for `themes/*.css` and user custom CSS compatibility, and add `--danger` parity under `:root[data-theme="dark"]`.

### S02-04 Multi-surface CSS monolith, 3-tier scope violations, and invalid CSS in `src/css/main.css`

- **Location:** `src/css/main.css:1-2885`
- **Severity:** `[Blocking]`
- **Status:** `[Agreed]`
- **Problem:**
  1. `main.css` mixes six distinct UI owners in one 2,885-line stylesheet.
  2. Line `2320` writes `body.is-importing-url :is(#menubar, #file-panel) *` and line `1993` writes `#viewport.cursor-hidden *`, violating the 3-tier CSS scope rule against universal `*` descendant selectors under state toggles.
  3. Lines `2317, 2322, 2330` emit invalid `cursor: disabled;` declarations after `cursor: not-allowed;`.
  4. Lines `1408-1424` place `#statusbar.refreshing` in the middle of `#file-panel` rules.
  5. Duplicate selectors and rules: `.svg-pump-live` (`2450` and `2463`), `#file-list` (`1270` and `1304`), `#file-panel-header-top` (`559` and `1349`), 4 copies of the diagonal grill gradient (`1891`, `1922`, `2601`, `2680`), 2 copies of volume popover/slider CSS (`925-1051` and `1056-1161`), 7 identical `.status-*::before` separator blocks (`2832-2872`), and 3-way repeated deep thumbnail selectors (`1572-1752`).
  6. Hardcoded hex colors bypass theme tokens: `#f5c518` (`583`), `#999` (`663`), `#d83b01` (`2293-2294`), and `#fff` (`255, 278, 296, 2225`).
  7. Lines `72-74` declare `.menu-link.has-update` before `.menu-link` (`76-86`), relying on higher specificity `(0,2,0)` to override `.menu-link`'s `all: unset; color: var(--text-muted);` instead of cascade order. Lines `2767-2768` repeat magic `2.453px` negative vertical margin and padding on `.status-version` manually coupled to `#statusbar` padding (`2723`).
- **Fix:** Split `main.css` by UI owner and link in deterministic `<head>` order before `<style id="custom-css"></style>` and `themePrePaint.js`: `global.css` -> `main.css` (workspace shell, cursor modes, `#workspace` layout) -> `menubar.css` (`30-480`, including `.menubar-spacer`, `.update-indicator`, and `.menu-link.has-update` placed after `.menu-link` and before `.menu-link:hover, .menu-link:focus-visible`) -> `statusbar.css` (`1408-1424, 2335-2357, 2719-2885`, including `.status-version*` `2763-2819` with shared `--statusbar-pad-y` / `--statusbar-pad-x` tokens replacing the magic `2.453px` offset) -> `overlays.css` (`1997-2331`) -> `file-panel.css` (`541-921, 1172-1788`) -> `viewer.css` (`923-1170, 1790-1995, 2359-2717`). Remove `cursor: disabled;`, replace universal `*` cursor rules with host-scoped cursor classes, merge duplicate blocks, and move hardcoded hex colors to CSS custom properties in `global.css`.

### S02-05 Bootstrap bloat, dual `#statusbar.hidden` writer, and detached initialization in `src/js/main/main.js`

- **Location:** `src/js/main/main.js:65`, `src/js/main/main.js:79-100`, `src/js/main/main.js:116-127`, `src/js/main/main.js:158-159`, `src/js/main/main.js:162-171`, `src/js/main/main.js:199-249`, `src/js/main/main.js:257-316`, `src/js/main/main.js:327-436`
- **Severity:** `[Blocking]`
- **Status:** `[Agreed]`
- **Problem:**
  1. `main.js:207` toggles `#statusbar.hidden` directly inside `Core.onStateChange` and `main.js:224` calls `Chrome.applyStatusBarVisibility()`, while `Chrome.initChrome()` at `main.js:259` registers `chrome.js:20` on `Core.onStateChange` to run `applyStatusBarVisibility()` again. That creates dual writers on `#statusbar.hidden` and runs `applyStatusBarVisibility()` plus `Statusbar.syncSpreadIndicator()` / `syncManhwaIndicator()` multiple times per state update.
  2. `main.js:116-127, 248` write `#cmd-history-back` and `#cmd-history-forward`; `main.js:240-242` writes `#cmd-toggle-transparent`; `main.js:208-210, 228-239` query 5 uncached DOM nodes per state change and mutate `#img-grill`, `#img-grill-border`, `#viewer-img-wrapper.grill-active`, and `#manhwa-strip.grill-active`; and `main.js:206, 217-221` write `#viewport.empty`.
  3. `main.js:200` calls `updateMenuShortcuts(state.config)` on every `Core.onStateChange`, including zoom, pan, and page steps, instead of only when config changes.
  4. `main.js:79-100` and `258-315` unconditionally bind Manhwa capture `keydown` handlers and initialize `Statusbar.init()` (including `syncVersion()`), `initFullscreen()`, `initManhwaStrip()`, `initPasswordOverlay()`, `initUrlOverlay()`, `initDropZone()`, and `initViewerAudio()` in detached `?surface=fileList` windows where `#viewport` is hidden.
  5. `main.js:65` clears Options' `options-active-tab` `localStorage` key; `main.js:158-159` queries `#favorites-list` and `#file-panel-library, .library-provider-list` inside `filePanel`'s DOM; `main.js:327-347` embeds library relocation and watcher orchestration; and `main.js:425-432` duplicates `quivit-theme` and `quivit-custom-css` `localStorage` writes.
  6. `main.js:162-171` (`actionCtx.focusFileSearch`) invokes `window.__TAURI__.core.invoke('open_workspace_window', { surface: 'fileList' })` and `requestWorkspace('workspace-file-list', 'filePanel', 'focusSearch')` directly from `main.js`, bypassing `workspace.js` `reconcile()` and `workspaceControls`. When the detached File List window already exists, `src-tauri/src/windows.rs:130` calls `window.set_focus()` during `open_workspace_window`, and `workspaceControls.js:153` calls `setFocus()` a second time over IPC.
- **Fix:**
  1. Remove `#statusbar.hidden`, `Chrome.applyStatusBarVisibility()`, `#cmd-history-*`, `#cmd-toggle-transparent`, and `#img-grill*` / `#manhwa-strip.grill-active` writes from `main.js`. Keep `chrome.js` as sole `#statusbar.hidden` writer, `menubar` as sole `#cmd-*` writer, and `viewerRender.js` / `manhwaStrip.js` as grill owners.
  2. Gate `Statusbar.init()`, `initFullscreen()`, `initManhwaStrip()`, `initPasswordOverlay()`, `initUrlOverlay()`, `initViewerAudio()`, and strip capture `keydown` behind `if (!workspaceSurface)`, while keeping `window` `dragover` and `drop` `preventDefault()` active in detached `?surface=fileList` so drops never navigate the WebView.
  3. Update shortcuts only on `quivit-config-loaded` or `configVersion` change. Move `reloadConfigAndSyncLibrary` and config/theme listeners (`327-436`) to `lifecycle.js` or a `main/configSync.js` coordinator, call `shared/theme.js:syncThemeStorage()`, import `isFavoritesFocused`/`isLibraryFocused` from `filePanel.js`, and delete line `65` once S03 moves `options-active-tab` to `sessionStorage`.
  4. Move detached `focusFileSearch` orchestration out of `main.js:162-171` into `workspaceControls` (`S01-18`), using a single window-focus call so `main.js` only passes `focusFileSearch` from `filePanel.js` without direct `open_workspace_window` or `requestWorkspace` reach-ins.

### S02-06 Unbounded popup close wait in `src/js/main/workspace.js`

- **Location:** `src/js/main/workspace.js:38-41`, `src/js/main/workspace.js:51`
- **Severity:** `[Warning]`
- **Status:** `[Agreed]`
- **Problem:** In Tauri mode, `close_workspace_window` in `src-tauri/src/windows.rs:180-189` emits `workspace-detached-closed` in both branches, so `await closed` resolves. In the non-Tauri browser popup path, if `windowPopups.get(label)` is missing or fails to close, `await closed` hangs indefinitely with `running = true`. Line `51` also uses blocking `window.alert`.
- **Fix:** Add a bounded timeout fallback around `await closed` in `reconcile()` and replace `window.alert` with non-blocking status feedback.

### S02-07 Foreign DOM reach-in, per-keypress parsing, and one-way sync in `src/js/main/fullscreen.js`

- **Location:** `src/js/main/fullscreen.js:23-27`, `src/js/main/fullscreen.js:49-62`, `src/js/main/fullscreen.js:114`, `src/js/main/fullscreen.js:200-208`, `src/js/main/fullscreen.js:221`
- **Severity:** `[Blocking]`
- **Status:** `[Agreed]`
- **Problem:**
  1. Line `114` directly toggles `#cmd-fullscreen.checked` inside `#menubar`.
  2. Lines `23-27, 59-62` re-run `normalizeList` and `normalizeCombo().toLowerCase()` on every capture-phase `keydown` and `keyup` while fullscreen, and `49-57` duplicate combo formatting already implemented in `src/js/services/keyCombo.js`.
  3. `syncFullscreenState(isFullscreen)` at `200-208` only handles entering fullscreen, leaving `fullscreenActive = true` if the window exits fullscreen externally.
- **Fix:** Emit a `quivit-fullscreen-changed` state update or event for `menubar` to render `#cmd-fullscreen`, pre-parse exit bindings into a `Set` inside `syncKeyLabel()`, reuse `services/keyCombo.js`, and handle `isFullscreen === false` in `syncFullscreenState`.

### S02-08 Eager main-thread cover thumbnail generation in `src/js/main/metadataBadge.js`

- **Location:** `src/js/main/metadataBadge.js:44-139`
- **Severity:** `[Blocking]`
- **Status:** `[Agreed]`
- **Problem:** `_loadMetadataForArchive` and `_loadMetadataForDirectory` eagerly fetch, decode, canvas-resize, `toDataURL()`, and `JSON.stringify()` into `localStorage('quivit-metadata-current')` on every archive or folder open with metadata, even when the Metadata window is closed. Both paths also duplicate persistence and Tauri `metadata-data` emission, and clearing state (`27-31`) does not emit `{ meta: null, coverSrc: null }` for an open Metadata window.
- **Fix:** Split pure metadata coordination from `#status-metadata-badge` UI, extract a shared `_publishMetadata` helper, defer cover downscaling until `openMetadataWindow()` or when the Metadata window is open, reuse `quivit://thumb/` or `createImageBitmap` off-path, and emit explicit `{ meta: null, coverSrc: null }` on clear per Sync D with S03.

### S02-09 Hardcoded `#file-panel` selectors and dead argument in `src/js/main/urlOverlay.js`

- **Location:** `src/js/main/urlOverlay.js:26`, `src/js/main/urlOverlay.js:53`, `src/js/main/urlOverlay.js:92`, `src/js/main/urlOverlay.js:146`, `src/js/main/urlOverlay.js:163`, `src/js/main/urlOverlay.js:167-201`, `src/js/main/urlOverlay.js:213`
- **Severity:** `[Warning]`
- **Status:** `[Agreed]`
- **Problem:** `EXCLUDED_INTERACTION_SELECTOR` hardcodes 14 internal `#file-panel` selectors plus `body.resizing-*` classes and installs a capture-phase `pointerdown` listener on `_filePanel` to dismiss the overlay. `_show`, `_hide`, and `_handleSubmit` also re-query `button[type="submit"]`, and 4 callers pass an unused second reason argument to `_hide(opts)`.
- **Fix:** Replace the 14-selector listener with an `onItemPointerDown` dismiss callback injected from `filePanel.js`, cache the submit button during `initUrlOverlay`, and drop the dead second argument.

### S02-10 Multi-concern monolith, startup update fetch, forced layout, hover IPC race, and dead code in `src/js/menubar.js`

- **Location:** `src/js/menubar.js:41-102`, `src/js/menubar.js:104-527`, `src/js/menubar.js:128-129`, `src/js/menubar.js:217-228`, `src/js/menubar.js:248`, `src/js/menubar.js:277-331`, `src/js/menubar.js:529-706`, `src/js/menubar.js:708-839`, `src/js/menubar.js:841-982`
- **Severity:** `[Blocking]`
- **Status:** `[Agreed]`
- **Problem:**
  1. `menubar.js` combines 5 separate concerns: menu open/close and safe-triangle aim, GitHub release update checking (`41-102`), Favorites loadout CRUD (`529-706`), Imports provider async menu (`708-839`), and View/Windows/Columns sync (`841-982`).
  2. `isInSafeTriangle` (`128-129`) invokes `getBoundingClientRect()` twice on every `mousemove` event. `activateItem` (`217-228`) sets `.open` and `--submenu-*` custom properties and immediately reads `offsetWidth` (`224`), forcing synchronous reflow on every submenu transition.
  3. `renderImportsMenu` (`708-779`) calls `Promise.all([fetchLibraryTree(), fetchManifest()])` at init, on `quivit-config-loaded`, and on every hover or click (`277, 287, 299`) without a sequence guard, risking out-of-order overwrites and repeated disk scans.
  4. `FIT_LABELS` (`851-859`) and `document.getElementById('fit-current-label')` (`923-924`) are dead code because `#fit-current-label` does not exist in `src/index.html`. `FILTER_LABELS` (`861-866`) and `scalingLabels` (`926`) duplicate `FILTERS` and `SCALERS` in `services/registry.js`.
  5. `ArrowLeft`/`ArrowRight` menu switching (`324-329`) skips refreshing Favorites and Imports; dynamic favorite rows have no `ArrowLeft`/`ArrowRight` menu handoff; `syncViewMenu` performs around 30 uncached `getElementById` calls on every state change; and `564, 622, 696, 700` mutate `input.size` alongside CSS `field-sizing: content`.
  6. `initMenuBar()` (`53`) runs `checkForUpdates()` (`83-102`) immediately on startup in the main window, issuing a duplicate `app.getVersion()` IPC (`88-91`, alongside `statusbar.js:445-455`) and `invoke('fetch_text', ...)` (`93-96`) against `GITHUB_RELEASES_API_URL` under `commands/network.rs:11`'s 30s `NETWORK_TIMEOUT`. That competes with startup IPC, risks false-positive `'ipc-error'` anomalies in `e2e/replay-diagnostics/probes/ipcProtocolProbe.js:33` when offline or rate-limited during `diagnose` runs, and re-queries `#update-indicator` and `#cmd-github` uncached inside `applyUpdateNotice()` (`57-58`).
- **Fix:** Split `menubar.js` into pure `services/menuAim.js`, `menubar/updateNotice.js`, `menubar/favoritesMenu.js`, `menubar/importsMenu.js`, `menubar/viewMenu.js`, and a thin `menubar.js` shell. In `menubar/updateNotice.js`, cache `#update-indicator` and `#cmd-github` on init, share one cached `app.getVersion()` promise with `statusbar.js` (and inject the `fetch_text` adapter), defer `checkForUpdates()` past first paint (idle or post-startup timer) while preserving `getGithubTargetUrl()` for `main.js:152` and the `!workspaceSurface` gate. Cache `triggerRect` and `subRect` in `activateItem` so `mousemove` makes 0 layout reads, eliminate synchronous `offsetWidth` reflow, add `_importsRenderSeq` plus cached manifest/library tree reads in `importsMenu.js`, refresh Favorites/Imports on `ArrowLeft`/`ArrowRight`, cache view-menu elements with dirty checking, drop `FIT_LABELS` and duplicate label maps in favor of `registry.js`, and remove redundant `input.size` writes.

### S02-11 Direct config mutation, foreign menu writes, and missing `Chrome` export in `src/js/menubar/chrome.js`

- **Location:** `src/js/menubar/chrome.js:20`, `src/js/menubar/chrome.js:33-39`, `src/js/menubar/chrome.js:48-51`, `src/js/menubar/chrome.js:61-66`, `src/js/menubar/chrome.js:73-74`
- **Severity:** `[Blocking]`
- **Status:** `[Agreed]`
- **Problem:**
  1. `setStatusBarVisible` (`73-74`) mutates `Core.getState().config.frontend_data.status_visible` directly instead of calling a `Core` setter like `setWindowMenuVisible` (`53`).
  2. `48-51` and `61-64` query and mutate `#cmd-toggle-menubar` and `#cmd-toggle-statusbar` inside `#menubar`.
  3. `65-66` calls `Statusbar.syncSpreadIndicator` and `syncManhwaIndicator` on every `Core.onStateChange`, even when visibility did not change.
  4. `33-39` (`initImportActivity`) handles import-blocking class and events inside chrome visibility.
  5. `e2e/replay-diagnostics/runner.e2e.js:344` imports `{ Chrome }` from `/js/menubar/chrome.js`, which currently resolves to `undefined` because `chrome.js` only exports standalone functions.
- **Fix:** Add `Core.setStatusBarVisible(visible)` in `core.js` (Sync D), keep `chrome.js` as sole writer of `#statusbar.hidden` and `#menubar.hidden` while delegating `#cmd-*` checks to `menubar/viewMenu.js`, notify statusbar indicators only when visibility flips, extract `initImportActivity` from `chrome.js` (Sync C), and add `export const Chrome = { ... }` alongside named exports to satisfy `runner.e2e.js:344`.

### S02-12 Imperative reach-in, forced reflow, DOM scraping, and duplicate version IPC in `src/js/menubar/statusbar.js`

- **Location:** `src/js/menubar/statusbar.js:8-27`, `src/js/menubar/statusbar.js:68-71`, `src/js/menubar/statusbar.js:109-111`, `src/js/menubar/statusbar.js:217`, `src/js/menubar/statusbar.js:266`, `src/js/menubar/statusbar.js:322-368`, `src/js/menubar/statusbar.js:408-409`, `src/js/menubar/statusbar.js:435-455`
- **Severity:** `[Blocking]`
- **Status:** `[Agreed]`
- **Problem:**
  1. `viewerRender.js` (9 callsites), `manhwaStrip.js` (`1836`), `shortcuts.js` (`124, 263, 286`), `chrome.js` (`65-66`), and `main.js` (`246, 258`) call `Statusbar` imperatively, and `viewerRender.js` duplicates indicator syncs already executed inside `Statusbar.setImage` (`408-409`).
  2. Line `110` triggers a forced synchronous reflow (`void statusbar.offsetWidth`) on `quivit-refresh-start` to restart the CSS pulse animation.
  3. Lines `266, 324, 368` poll `document.body.classList.contains('is-importing-url')` instead of storing `e.detail.importing` from `quivit-import-status`, and `getCopyableStatusItem` (`322-363`) scrapes `statusName.textContent` and linear-scans `state.list`.
  4. `FIT_LABELS`, `FIT_TITLES`, and `SCALING_LABELS` (`8-27`) duplicate `services/registry.js`; line `217` hardcodes `\\` path joining.
  5. `syncVersion()` (`445-455`, called from `init()` at `71`) calls `window.__TAURI__.app.getVersion()` directly, duplicating the startup `app.getVersion()` IPC in `menubar.js:88-91` and running in detached `?surface=fileList` windows until `S02-05` gates `Statusbar.init()`.
- **Fix:** Make `Statusbar` subscribe directly to `Core.onStateChange`, scroll-indicator state, and media-status callbacks/events so external callers stop importing `Statusbar` (Sync B). Replace `void statusbar.offsetWidth` with `requestAnimationFrame` or `statusbar.getAnimations()`, track `importing` state from `quivit-import-status`, derive copyable item data directly from `state`, reuse `SCALER_BY_ID` from `services/registry.js`, and share one cached `app.getVersion()` promise/adapter with `menubar/updateNotice.js`. Preserve `#statusbar`, all `.status-*` classes (including `.status-version[aria-label]`, `.status-version-viewport`, `.status-version-codename`, and `.status-version-number`), `#spread-indicator`, and `#manhwa-indicator` (`viewerPipelineProbe.js:257`, `recorder-shim.js:22-33`, `statusbar.page.js:15`, `.agents/skills/publish-release/SKILL.md`).

## Cohesive files

- **`src/js/main/workspaceBoot.js` (4L):** Cohesive. Awaits `initWorkspaceSession()` before importing `./main.js`.
- **`src/js/main/lifecycle.js` (64L):** Cohesive. Cleanly gated by `!workspaceSurface` and deduplicates `set_workspace_title` via `_lastTitle`. Nit: `single-instance-open` listener at line `44` lacks `.catch(console.error)` matching line `42`.
- **`src/js/main/dropzone.js` (105L):** Cohesive. Clean single owner of `#drop-overlay`, zero inline `.style.` writes, and gates native `quivit-drop` via `listenWorkspaceEvent(..., { owner: 'main' })`. Nit: duplicate `window.addEventListener('drop', ...)` registration in the non-Tauri browser fallback (`76` and `98`).
- **`src/js/main/passwordOverlay.js` (150L):** Cohesive. Clean single owner of `#password-overlay` subscribing to `Core.onStateChange`. Nit: stale header comment at lines `4-5` mentions a nonexistent `quivit-password-required` event, and initialization in `main.js` should be skipped in detached `?surface=fileList`.

## Cross-split seams

- **Sync A (`index.html`, `global.css`, `main.css` with S01, S03, S04, S06, S07, S08):** Deterministic `<head>` CSS order ending with `<style id="custom-css"></style>` before `themePrePaint.js` (same in `options.html` and `metadata.html`); disjoint `<template>` additions for S04 and S06; deletion of `#viewer-loading-frame` and `.viewer-img.is-placeholder` (R3); relocation of `.assoc-mascot-*` to `options.css` with `:root:not([data-theme="light"])` and `--panel-*`/`--col-*`/`--file-grid-cols` to `file-panel.css`; 22 theme tokens preserved in `global.css`; `#update-indicator` (`index.html:207`) and `.status-version*` fallback markup (`index.html:528-533`) preserved for `statusbar.page.js:15` and `.agents/skills/publish-release/SKILL.md`; `defer` or lazy-loading for `pica.js` and `purify.min.js`.
- **Sync B (`viewerRender`, `manhwaStrip`, `shortcuts`, `registry` with S01, S06, S07):** Grill class ownership moved from `main.js` to `viewerRender.js` and `manhwaStrip.js`; imperative `Statusbar.*` calls removed across S01 and S06; `export const Chrome` added in `chrome.js` for `runner.e2e.js:344`; `SCALER_BY_ID` exported in `services/registry.js` to replace duplicate label tables.
- **Sync C (`urlLoader`, `urlOverlay`, `chrome`, `dropzone`, `network` with S04, S05, S07, S10):** `_urlOverlay` removed from `urlLoader.js`; `urlOverlay.js` 14-selector reach-in replaced by `filePanel` `onItemPointerDown` callback; `initImportActivity` separated from `chrome.js`; `quivit-drop` (`owner: 'main'`) preserved alongside detached `dragover`/`drop` `preventDefault()`; `fetchManifest()` cached for `menubar/importsMenu.js`; `menubar.js:93-96` (planned `menubar/updateNotice.js`) calls `fetch_text` (`src-tauri/src/commands/network.rs:71`) over Tauri IPC, keeping R2 CSP `connect-src` clean of `api.github.com`, while S10's planned `MAX_FETCH_TEXT_BYTES` cap (`#U03-08`) must fit GitHub `releases?per_page=30` JSON payloads (at least 2 MiB).
- **Sync D (Detached `?surface=fileList`, `Core`, `localStorage`, `appVersion` with S01, S03, S04, S08):** Viewport-only controllers gated in `main.js` (including `Statusbar.init()` and `syncVersion()`); `menubar.js:53` already gates `checkForUpdates()` behind `!workspaceSurface`, and `#cmd-github` clicks in detached `?surface=fileList` route to `'main'` via `workspaceControls.js:36` (`action.owner || 'main'`) so `main.js:152` `actionCtx.getGithubUrl()` returns `GITHUB_RELEASES_URL` for `actions.js:259-268` when an update is active; `Core.setStatusBarVisible` added; `main.js:65` `options-active-tab` reach-in deleted as S03 moves the key to `sessionStorage`; `main.js:162-171` detached `focusFileSearch` moves into `workspaceControls` while preserving the `filePanel.focusSearch` RPC (`workspaceControls.js:151-158`), `filePanel.js:focusFileSearch` export, and `#file-panel-search` (`index.html:273-274`); `shared/theme.js:syncThemeStorage` owns `quivit-theme` and `quivit-custom-css`; `metadataBadge.js` stays sole writer of `quivit-metadata-current` with lazy cover generation and explicit `{ meta: null, coverSrc: null }` clear.

## Telemetry A/B specification

- **Suites covering S02:**
  1. `npm run mocha` (baseline 308 passing).
  2. `npm run e2e -- --spec e2e/specs/01-startup.e2e.js`, `03-viewer.e2e.js`, `04-archives.e2e.js`, `06-configuration.e2e.js`, and `08-url-loader.e2e.js`.
  3. `npm run diagnose -- grill-desync` and `npm run diagnose -- sample-navigation`.
  4. `cargo test --manifest-path src-tauri/Cargo.toml`: N/A (frontend-only split).
- **Locked contracts:** `mocha/diagnosticsContract.test.js` (`#statusbar`, `#viewer-img-wrapper`, `#manhwa-strip`, `#viewer-ico-row`, `#manhwa-filter-canvas`, `#manhwa-svg-pump-layer`, `#manhwa-audio-overlay`), `e2e/replay-diagnostics/probes/viewerPipelineProbe.js:257` (`#statusbar .status-filename`), `e2e/replay-diagnostics/probes/ipcProtocolProbe.js:33` (`ipc-error` anomaly tracking on `fetch_text`), `e2e/helpers/recorder-shim.js:22-33`, `e2e/replay-diagnostics/runner.e2e.js:344` (`{ Chrome }` export), `e2e/pageobjects/menubar.page.js`, `e2e/pageobjects/statusbar.page.js:15` (`.status-version`), and `.agents/skills/publish-release/SKILL.md` (`.status-version[aria-label]`, `.status-version-codename`, `.status-version-number` parity with `appVersion.js` and release manifests).
- **Telemetry A pre-refactor additions (`#U06-TA`):**
  1. Add `mocha/chromeContract.test.js` testing pure safe-triangle aim geometry (`isPointInTriangle`, `isInSafeTriangle`), state-based `getCopyableStatusItem` derivation, fullscreen exit combo `Set` matching, `index.html` `<style id="custom-css">` ordering and single-ID invariant, `index.html` `.status-version` fallback markup (`aria-label`, `.status-version-codename`, `.status-version-number` matching `appVersion.js` `FALLBACK_APP_VERSION` and `MAJOR_VERSION_CODENAMES`) and `#update-indicator` hidden-by-default / `#cmd-github` contract, `global.css` vs `themes/*.css` 22-token parity, and `/js/menubar/chrome.js` exporting `Chrome`.
  2. Extend E2E specs for detached `?surface=fileList` chrome parity (`#menubar` visible, `#statusbar` hidden, `#cmd-toggle-statusbar` muted, `#viewport` hidden), `cmd-focus-file-search` parity (invoked from `main` via `filePanel.focusSearch` RPC, invoked locally inside detached `?surface=fileList`, and docked hidden-panel reveal plus `#file-panel-search` focus/select), fullscreen `#cmd-fullscreen.checked` sync, and statusbar click-to-copy.
  3. Capture pre-refactor baseline JSON for all matching Mocha, E2E, and Diagnose runs.
- **Telemetry B post-refactor checks:**
  1. Re-run `npm run mocha`, all 5 listed E2E specs, and both `npm run diagnose` scenarios with zero functional regressions, zero blackout frames, and zero `ipcProtocolProbe.js` `ipc-error` regressions from `fetch_text`.
  2. Verify structural and performance invariants: zero `void *.offsetWidth` calls in `statusbar.js`; zero `getBoundingClientRect()` calls inside `mousemove` during submenu aim; zero `cursor: disabled` or `body.* *` / `#viewport.* *` universal selectors in `src/css/*.css`; `.menu-link.has-update` ordered after `.menu-link` and no magic `2.453px` vertical margin/padding coupling in `statusbar.css`; single deduplicated `app.getVersion()` IPC call on startup shared between `statusbar.js` and `menubar/updateNotice.js`; deferred post-startup `checkForUpdates()` with cached `#update-indicator` and `#cmd-github` nodes; zero foreign `#cmd-*`, `#img-grill`, or `#statusbar` writes in `main.js`, `fullscreen.js`, or `chrome.js`; zero direct `open_workspace_window` or `requestWorkspace` reach-ins in `main.js` `actionCtx` and no duplicate `setFocus()` IPC on detached focus-search; zero eager `canvas.toDataURL` calls during navigation when the Metadata window is closed; and non-blocking `pica.js` / `purify.min.js` startup script loading.
