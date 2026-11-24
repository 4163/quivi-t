# Audit S02: main shell, chrome, overlays, and stylesheets

Split S02 covers 15 files across `src/index.html`, `src/css/global.css`, `src/css/main.css`, `src/js/main/`, and `src/js/menubar/`. All findings below were verified against live files, `themes/matcha-latte.css`, `themes/sage-mint.css`, `mocha/diagnosticsContract.test.js`, `e2e/replay-diagnostics/probes/viewerPipelineProbe.js`, `e2e/replay-diagnostics/runner.e2e.js`, `e2e/helpers/recorder-shim.js`, and `e2e/pageobjects/`.

Baseline check: `npm run mocha` passed 308 tests before edits. No source, test, or config files were modified.

## Consensus summary

- **Cohesive files, 4 of 15:** `src/js/main/workspaceBoot.js`, `src/js/main/lifecycle.js`, `src/js/main/dropzone.js`, and `src/js/main/passwordOverlay.js`.
- **Files with agreed findings, 11 of 15:** `src/index.html`, `src/css/global.css`, `src/css/main.css`, `src/js/main/main.js`, `src/js/main/workspace.js`, `src/js/main/fullscreen.js`, `src/js/main/metadataBadge.js`, `src/js/main/urlOverlay.js`, `src/js/menubar.js`, `src/js/menubar/chrome.js`, and `src/js/menubar/statusbar.js`.
- **Dropped or escalated findings:** None. All items reached unanimous `[Agreed]` consensus between `s02-html-css` and `s02-chrome-js`, and all cross-split seams passed Step 4 review.

## File inventory

| File | Lines | Status | Primary issues |
|---|---|---|---|
| `src/index.html` | 537 | `[Agreed]` | Blocking vendor scripts, duplicate `#custom-css`, dead `#viewer-loading-frame` |
| `src/css/global.css` | 278 | `[Agreed]` | Options dark-mode bug and leak, viewer placeholder leak, unused font tokens |
| `src/css/main.css` | 2,805 | `[Agreed]` | Six-owner monolith, universal state selectors, invalid `cursor: disabled` |
| `src/js/main/workspaceBoot.js` | 4 | Cohesive | Minimal session gate before importing `main.js` |
| `src/js/main/main.js` | 433 | `[Agreed]` | Dual `#statusbar.hidden` writer, foreign DOM writes, un-gated detached init |
| `src/js/main/workspace.js` | 86 | `[Agreed]` | Unbounded `resolveClose` await in browser popup fallback |
| `src/js/main/lifecycle.js` | 64 | Cohesive | One nit: missing `.catch` on `single-instance-open` listener |
| `src/js/main/fullscreen.js` | 246 | `[Agreed]` | Foreign `#cmd-fullscreen` write, per-keypress config parsing, one-way sync |
| `src/js/main/dropzone.js` | 105 | Cohesive | One nit: duplicate `drop` listener registration in browser fallback |
| `src/js/main/metadataBadge.js` | 193 | `[Agreed]` | Eager full-res canvas cover generation on every directory and archive open |
| `src/js/main/passwordOverlay.js` | 150 | Cohesive | One nit: stale comment referencing nonexistent `quivit-password-required` |
| `src/js/main/urlOverlay.js` | 223 | `[Agreed]` | 14 hardcoded `#file-panel` selectors, uncached submit button, dead arg |
| `src/js/menubar.js` | 920 | `[Agreed]` | Four-concern monolith, `mousemove` layout reads, hover IPC race, dead `FIT_LABELS` |
| `src/js/menubar/chrome.js` | 104 | `[Agreed]` | Direct `config.frontend_data` mutation, menu DOM reach-in, missing `Chrome` export |
| `src/js/menubar/statusbar.js` | 426 | `[Agreed]` | Imperative reach-in from 5 modules, forced `offsetWidth` reflow, DOM scraping |

## Agreed findings

### S02-01 Blocking vendor scripts and startup waste in `src/index.html`

- **Location:** `src/index.html:531-532`
- **Severity:** `[Blocking]`
- **Status:** `[Agreed]`
- **Problem:** Classic `<script src="js/vendors/pica.js"></script>` and `<script src="js/vendors/purify.min.js"></script>` block parsing before module execution on every startup, including detached `?surface=fileList` windows that never render Lanczos canvases or viewer SVGs.
- **Fix:** Add `defer` or lazy-load `pica.js` inside `src/js/services/scaling/lanczos.js` and `purify.min.js` inside `src/js/shared/svgUtils.js` or `src/js/urlloader/networkClient.js`. Aligns with Sync B and Sync C.

### S02-02 Duplicate `#custom-css` element and markup cleanup in `src/index.html`

- **Location:** `src/index.html:14-15`, `src/index.html:96-105`, `src/index.html:122`, `src/index.html:126`, `src/index.html:184`, `src/index.html:190`, `src/index.html:269`, `src/index.html:276-307`, `src/index.html:398`, `src/index.html:417`, `src/index.html:424-486`, `src/index.html:526`
- **Severity:** `[Warning]`
- **Status:** `[Agreed]`
- **Problem:**
  1. `index.html:14-15` loads `/js/shared/themePrePaint.js` before `<style id="custom-css"></style>`. When `quivit-custom-css` exists in `localStorage`, `themePrePaint.js:7-10` creates and appends its own `<style id="custom-css">`, leaving two `#custom-css` nodes in `<head>`.
  2. `index.html:398` defines `#viewer-loading-frame.is-placeholder`, which has zero JS or CSS activations and exists only to be skipped in `viewerRender.js:21,299,567`.
  3. `index.html:269` places `<div class="scroll-spacer">` directly inside `<ul id="file-list">`, which is invalid `<ul>` child markup.
  4. `index.html:96-105, 122, 126` keep unused `data-checked="false"` attributes, `index.html:184, 190, 276-307, 424-482` repeat presentational `width`/`height` SVG attributes overridden by CSS, `index.html:434-454` and `466-486` duplicate the four volume `<svg>` icons, and `index.html:417` `#viewer-svg-pump` lacks `alt=""`.
- **Fix:**
  1. Declare `<style id="custom-css"></style>` before `<script src="/js/shared/themePrePaint.js"></script>` and update `themePrePaint.js` to populate the existing node. Apply the same order in `options.html` and `metadata.html`.
  2. Delete `#viewer-loading-frame` per Step 4 resolution R3, alongside S06's removal of `#viewer-audio` at `index.html:419` and expansion of `.viewer-img` pool nodes from 2 to 4 at `index.html:403-404`.
  3. Remove unused `data-checked="false"` attributes and redundant SVG `width`/`height` attributes, add `alt=""` to `#viewer-svg-pump`, convert `<div class="scroll-spacer">` to a valid list item in coordination with S04, and keep `<span class="status-version">v1.0.0</span>` intact for `statusbar.page.js`.
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

- **Location:** `src/css/main.css:1-2805`
- **Severity:** `[Blocking]`
- **Status:** `[Agreed]`
- **Problem:**
  1. `main.css` mixes six distinct UI owners in one 2,805-line stylesheet.
  2. Line `2294` writes `body.is-importing-url :is(#menubar, #file-panel) *` and line `1967` writes `#viewport.cursor-hidden *`, violating the 3-tier CSS scope rule against universal `*` descendant selectors under state toggles.
  3. Lines `2291, 2296, 2304` emit invalid `cursor: disabled;` declarations after `cursor: not-allowed;`.
  4. Line `1382-1398` places `#statusbar.refreshing` in the middle of `#file-panel` rules.
  5. Duplicate selectors and rules: `.svg-pump-live` (`2424` and `2437`), `#file-list` (`1244` and `1278`), `#file-panel-header-top` (`533` and `1323`), 4 copies of the diagonal grill gradient (`1865`, `1896`, `2575`, `2654`), 2 copies of volume popover/slider CSS (`899-1025` and `1030-1135`), 7 identical `.status-*::before` separator blocks (`2752-2792`), and 3-way repeated deep thumbnail selectors (`1546-1726`).
  6. Hardcoded hex colors bypass theme tokens: `#f5c518` (`557`), `#999` (`637`), `#d83b01` (`2267-2268`), and `#fff` (`229, 252, 270, 2199`).
- **Fix:** Split `main.css` by UI owner and link in deterministic `<head>` order before `<style id="custom-css"></style>` and `themePrePaint.js`: `global.css` -> `main.css` (workspace shell, cursor modes, `#workspace` layout) -> `menubar.css` (`30-454`) -> `statusbar.css` (`1382-1398, 2309-2331, 2693-2805`) -> `overlays.css` (`1971-2305`) -> `file-panel.css` (`515-895, 1146-1762`) -> `viewer.css` (`897-1144, 1764-1969, 2333-2691`). Remove `cursor: disabled;`, replace universal `*` cursor rules with host-scoped cursor classes, merge duplicate blocks, and move hardcoded hex colors to CSS custom properties in `global.css`.

### S02-05 Bootstrap bloat, dual `#statusbar.hidden` writer, and detached initialization in `src/js/main/main.js`

- **Location:** `src/js/main/main.js:64`, `src/js/main/main.js:78-99`, `src/js/main/main.js:115-126`, `src/js/main/main.js:156-157`, `src/js/main/main.js:186-236`, `src/js/main/main.js:244-303`, `src/js/main/main.js:314-423`
- **Severity:** `[Blocking]`
- **Status:** `[Agreed]`
- **Problem:**
  1. `main.js:194` toggles `#statusbar.hidden` directly inside `Core.onStateChange` and `main.js:211` calls `Chrome.applyStatusBarVisibility()`, while `Chrome.initChrome()` at `main.js:246` registers `chrome.js:20` on `Core.onStateChange` to run `applyStatusBarVisibility()` again. That creates dual writers on `#statusbar.hidden` and runs `applyStatusBarVisibility()` plus `Statusbar.syncSpreadIndicator()` / `syncManhwaIndicator()` multiple times per state update.
  2. `main.js:115-126, 235` write `#cmd-history-back` and `#cmd-history-forward`; `main.js:227-229` writes `#cmd-toggle-transparent`; `main.js:195-197, 215-226` query 5 uncached DOM nodes per state change and mutate `#img-grill`, `#img-grill-border`, `#viewer-img-wrapper.grill-active`, and `#manhwa-strip.grill-active`; and `main.js:193, 204-208` write `#viewport.empty`.
  3. `main.js:187` calls `updateMenuShortcuts(state.config)` on every `Core.onStateChange`, including zoom, pan, and page steps, instead of only when config changes.
  4. `main.js:78-99` and `245-302` unconditionally bind Manhwa capture `keydown` handlers and initialize `Statusbar.init()`, `initFullscreen()`, `initManhwaStrip()`, `initPasswordOverlay()`, `initUrlOverlay()`, `initDropZone()`, and `initViewerAudio()` in detached `?surface=fileList` windows where `#viewport` is hidden.
  5. `main.js:64` clears Options' `options-active-tab` `localStorage` key; `main.js:156-157` queries `#favorites-list` and `#file-panel-library, .library-provider-list` inside `filePanel`'s DOM; `main.js:314-334` embeds library relocation and watcher orchestration; and `main.js:412-419` duplicates `quivit-theme` and `quivit-custom-css` `localStorage` writes.
- **Fix:**
  1. Remove `#statusbar.hidden`, `Chrome.applyStatusBarVisibility()`, `#cmd-history-*`, `#cmd-toggle-transparent`, and `#img-grill*` / `#manhwa-strip.grill-active` writes from `main.js`. Keep `chrome.js` as sole `#statusbar.hidden` writer, `menubar` as sole `#cmd-*` writer, and `viewerRender.js` / `manhwaStrip.js` as grill owners.
  2. Gate `Statusbar.init()`, `initFullscreen()`, `initManhwaStrip()`, `initPasswordOverlay()`, `initUrlOverlay()`, `initViewerAudio()`, and strip capture `keydown` behind `if (!workspaceSurface)`, while keeping `window` `dragover` and `drop` `preventDefault()` active in detached `?surface=fileList` so drops never navigate the WebView.
  3. Update shortcuts only on `quivit-config-loaded` or `configVersion` change. Move `reloadConfigAndSyncLibrary` and config/theme listeners (`314-423`) to `lifecycle.js` or a `main/configSync.js` coordinator, call `shared/theme.js:syncThemeStorage()`, import `isFavoritesFocused`/`isLibraryFocused` from `filePanel.js`, and delete line `64` once S03 moves `options-active-tab` to `sessionStorage`.

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

### S02-10 Multi-concern monolith, forced layout, hover IPC race, and dead code in `src/js/menubar.js`

- **Location:** `src/js/menubar.js:41-464`, `src/js/menubar.js:65-66`, `src/js/menubar.js:154-165`, `src/js/menubar.js:185`, `src/js/menubar.js:214-268`, `src/js/menubar.js:466-643`, `src/js/menubar.js:645-776`, `src/js/menubar.js:778-919`
- **Severity:** `[Blocking]`
- **Status:** `[Agreed]`
- **Problem:**
  1. `menubar.js` combines 4 separate concerns: menu open/close and safe-triangle aim, Favorites loadout CRUD, Imports provider async menu, and View/Windows/Columns sync.
  2. `isInSafeTriangle` (`65-66`) invokes `getBoundingClientRect()` twice on every `mousemove` event. `activateItem` (`154-165`) sets `.open` and `--submenu-*` custom properties and immediately reads `offsetWidth` (`161`), forcing synchronous reflow on every submenu transition.
  3. `renderImportsMenu` (`645-716`) calls `Promise.all([fetchLibraryTree(), fetchManifest()])` at init, on `quivit-config-loaded`, and on every hover or click (`214, 224, 236`) without a sequence guard, risking out-of-order overwrites and repeated disk scans.
  4. `FIT_LABELS` (`788-796`) and `document.getElementById('fit-current-label')` (`860-861`) are dead code because `#fit-current-label` does not exist in `src/index.html`. `FILTER_LABELS` (`798-803`) and `scalingLabels` (`863`) duplicate `FILTERS` and `SCALERS` in `services/registry.js`.
  5. `ArrowLeft`/`ArrowRight` menu switching (`261-266`) skips refreshing Favorites and Imports; dynamic favorite rows have no `ArrowLeft`/`ArrowRight` menu handoff; `syncViewMenu` performs around 30 uncached `getElementById` calls on every state change; and `501, 559, 633, 637` mutate `input.size` alongside CSS `field-sizing: content`.
- **Fix:** Split `menubar.js` into pure `services/menuAim.js`, `menubar/favoritesMenu.js`, `menubar/importsMenu.js`, `menubar/viewMenu.js`, and a thin `menubar.js` shell. Cache `triggerRect` and `subRect` in `activateItem` so `mousemove` makes 0 layout reads, eliminate synchronous `offsetWidth` reflow, add `_importsRenderSeq` plus cached manifest/library tree reads in `importsMenu.js`, refresh Favorites/Imports on `ArrowLeft`/`ArrowRight`, cache view-menu elements with dirty checking, drop `FIT_LABELS` and duplicate label maps in favor of `registry.js`, and remove redundant `input.size` writes.

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

### S02-12 Imperative reach-in, forced reflow, and DOM scraping in `src/js/menubar/statusbar.js`

- **Location:** `src/js/menubar/statusbar.js:7-26`, `src/js/menubar/statusbar.js:101-103`, `src/js/menubar/statusbar.js:209`, `src/js/menubar/statusbar.js:258`, `src/js/menubar/statusbar.js:314-360`, `src/js/menubar/statusbar.js:400-401`
- **Severity:** `[Blocking]`
- **Status:** `[Agreed]`
- **Problem:**
  1. `viewerRender.js` (9 callsites), `manhwaStrip.js` (`1836`), `shortcuts.js` (`124, 263, 286`), `chrome.js` (`65-66`), and `main.js` (`233, 245`) call `Statusbar` imperatively, and `viewerRender.js` duplicates indicator syncs already executed inside `Statusbar.setImage` (`400-401`).
  2. Line `102` triggers a forced synchronous reflow (`void statusbar.offsetWidth`) on `quivit-refresh-start` to restart the CSS pulse animation.
  3. Lines `258, 316, 360` poll `document.body.classList.contains('is-importing-url')` instead of storing `e.detail.importing` from `quivit-import-status`, and `getCopyableStatusItem` (`314-355`) scrapes `statusName.textContent` and linear-scans `state.list`.
  4. `FIT_LABELS`, `FIT_TITLES`, and `SCALING_LABELS` (`7-26`) duplicate `services/registry.js`; line `209` hardcodes `\\` path joining.
- **Fix:** Make `Statusbar` subscribe directly to `Core.onStateChange`, scroll-indicator state, and media-status callbacks/events so external callers stop importing `Statusbar` (Sync B). Replace `void statusbar.offsetWidth` with `requestAnimationFrame` or `statusbar.getAnimations()`, track `importing` state from `quivit-import-status`, derive copyable item data directly from `state`, and reuse `SCALER_BY_ID` from `services/registry.js`. Preserve `#statusbar`, all `.status-*` classes, `#spread-indicator`, and `#manhwa-indicator` (`viewerPipelineProbe.js:257`, `recorder-shim.js:22-33`, `statusbar.page.js`).

## Cohesive files

- **`src/js/main/workspaceBoot.js` (4L):** Cohesive. Awaits `initWorkspaceSession()` before importing `./main.js`.
- **`src/js/main/lifecycle.js` (64L):** Cohesive. Cleanly gated by `!workspaceSurface` and deduplicates `set_workspace_title` via `_lastTitle`. Nit: `single-instance-open` listener at line `44` lacks `.catch(console.error)` matching line `42`.
- **`src/js/main/dropzone.js` (105L):** Cohesive. Clean single owner of `#drop-overlay`, zero inline `.style.` writes, and gates native `quivit-drop` via `listenWorkspaceEvent(..., { owner: 'main' })`. Nit: duplicate `window.addEventListener('drop', ...)` registration in the non-Tauri browser fallback (`76` and `98`).
- **`src/js/main/passwordOverlay.js` (150L):** Cohesive. Clean single owner of `#password-overlay` subscribing to `Core.onStateChange`. Nit: stale header comment at lines `4-5` mentions a nonexistent `quivit-password-required` event, and initialization in `main.js` should be skipped in detached `?surface=fileList`.

## Cross-split seams

- **Sync A (`index.html`, `global.css`, `main.css` with S01, S03, S04, S06, S07, S08):** Deterministic `<head>` CSS order ending with `<style id="custom-css"></style>` before `themePrePaint.js` (same in `options.html` and `metadata.html`); disjoint `<template>` additions for S04 and S06; deletion of `#viewer-loading-frame` and `.viewer-img.is-placeholder` (R3); relocation of `.assoc-mascot-*` to `options.css` with `:root:not([data-theme="light"])` and `--panel-*`/`--col-*`/`--file-grid-cols` to `file-panel.css`; 22 theme tokens preserved in `global.css`; `defer` or lazy-loading for `pica.js` and `purify.min.js`.
- **Sync B (`viewerRender`, `manhwaStrip`, `shortcuts`, `registry` with S01, S06, S07):** Grill class ownership moved from `main.js` to `viewerRender.js` and `manhwaStrip.js`; imperative `Statusbar.*` calls removed across S01 and S06; `export const Chrome` added in `chrome.js` for `runner.e2e.js:344`; `SCALER_BY_ID` exported in `services/registry.js` to replace duplicate label tables.
- **Sync C (`urlLoader`, `urlOverlay`, `chrome`, `dropzone` with S04, S05, S07, S10):** `_urlOverlay` removed from `urlLoader.js`; `urlOverlay.js` 14-selector reach-in replaced by `filePanel` `onItemPointerDown` callback; `initImportActivity` separated from `chrome.js`; `quivit-drop` (`owner: 'main'`) preserved alongside detached `dragover`/`drop` `preventDefault()`; `fetchManifest()` cached for `menubar/importsMenu.js`.
- **Sync D (Detached `?surface=fileList`, `Core`, `localStorage` with S01, S03, S04, S08):** Viewport-only controllers gated in `main.js`; `Core.setStatusBarVisible` added; `main.js:64` `options-active-tab` reach-in deleted as S03 moves the key to `sessionStorage`; `shared/theme.js:syncThemeStorage` owns `quivit-theme` and `quivit-custom-css`; `metadataBadge.js` stays sole writer of `quivit-metadata-current` with lazy cover generation and explicit `{ meta: null, coverSrc: null }` clear.

## Telemetry A/B specification

- **Suites covering S02:**
  1. `npm run mocha` (baseline 308 passing).
  2. `npm run e2e -- --spec e2e/specs/01-startup.e2e.js`, `03-viewer.e2e.js`, `04-archives.e2e.js`, `06-configuration.e2e.js`, and `08-url-loader.e2e.js`.
  3. `npm run diagnose -- grill-desync` and `npm run diagnose -- sample-navigation`.
  4. `cargo test --manifest-path src-tauri/Cargo.toml`: N/A (frontend-only split).
- **Locked contracts:** `mocha/diagnosticsContract.test.js` (`#statusbar`, `#viewer-img-wrapper`, `#manhwa-strip`, `#viewer-ico-row`, `#manhwa-filter-canvas`, `#manhwa-svg-pump-layer`, `#manhwa-audio-overlay`), `e2e/replay-diagnostics/probes/viewerPipelineProbe.js:257` (`#statusbar .status-filename`), `e2e/helpers/recorder-shim.js:22-33`, `e2e/replay-diagnostics/runner.e2e.js:344` (`{ Chrome }` export), `e2e/pageobjects/menubar.page.js`, and `e2e/pageobjects/statusbar.page.js`.
- **Telemetry A pre-refactor additions:**
  1. Add `mocha/chromeContract.test.js` testing pure safe-triangle aim geometry (`isPointInTriangle`, `isInSafeTriangle`), state-based `getCopyableStatusItem` derivation, fullscreen exit combo `Set` matching, `index.html` `<style id="custom-css">` ordering and single-ID invariant, `global.css` vs `themes/*.css` 22-token parity, and `/js/menubar/chrome.js` exporting `Chrome`.
  2. Extend E2E specs for detached `?surface=fileList` chrome parity (`#menubar` visible, `#statusbar` hidden, `#cmd-toggle-statusbar` muted, `#viewport` hidden), fullscreen `#cmd-fullscreen.checked` sync, and statusbar click-to-copy.
  3. Capture pre-refactor baseline JSON for all matching Mocha, E2E, and Diagnose runs.
- **Telemetry B post-refactor checks:**
  1. Re-run `npm run mocha`, all 5 listed E2E specs, and both `npm run diagnose` scenarios with zero functional regressions or blackout frames.
  2. Verify structural and performance invariants: zero `void *.offsetWidth` calls in `statusbar.js`; zero `getBoundingClientRect()` calls inside `mousemove` during submenu aim; zero `cursor: disabled` or `body.* *` / `#viewport.* *` universal selectors in `src/css/*.css`; zero foreign `#cmd-*`, `#img-grill`, or `#statusbar` writes in `main.js`, `fullscreen.js`, or `chrome.js`; zero eager `canvas.toDataURL` calls during navigation when the Metadata window is closed; and non-blocking `pica.js` / `purify.min.js` startup script loading.
