# Split S03 audit: Options, Metadata, and static assets

Split S03 (`fe-options-metadata`) covers 44 files: 2 HTML documents, 2 stylesheets, 6 JS modules, and 34 static assets under `src/assets/`. All findings, seam updates, and Telemetry A/B specifications below reflect unanimous consensus between `s03-options-perf` and `s03-windows-validate` (`#65`, `#116`, `#123`), with `npm run mocha` passing 308 baseline tests in 4s.

## File inventory and status ledger

All 44 owned files are accounted for across 36 cohesive files and 8 files requiring changes.

| Group | Files | Count | Status | Notes |
|---|---|---:|---|---|
| Stylesheets | `src/css/metadata.css` | 1 | Cohesive | Uses `global.css` tokens and `[data-orientation]` component rules cleanly. |
| Pure services | `src/js/services/metadataFiles.js` | 1 | Cohesive | 24L pure module with zero DOM; optional export of `metadataBareName` for `metadata.js:19`. |
| Mascot SVGs | `src/assets/icons/_mascot-formats.svg`, `_moe-1-formats.svg`, `_moe-3-formats.svg`, `_stoic-formats.svg` | 4 | Cohesive | Zero orphans; referenced at `src/options.html:460,464,468,472`. |
| Format PNGs | `src/assets/icons/{7z,apng,avif,bmp,cb7,cbr,cbt,cbz,dib,gif,ico,jfif,jpeg,jpg,png,rar,svg,tar,tif,tiff,webp,zip}.png` | 22 | Cohesive | Zero orphans; 1:1 parity across `options.html`, `associationsUi.js:11-17`, `src-tauri/src/formats.rs:35-170`, and `icons/formats/*.ico`. |
| Language flag SVG | `src/assets/lang-flags/twemoji-us.svg` | 1 | Cohesive | Zero orphans; referenced at `src/options.html:699`. |
| Metadata credit SVGs | `src/assets/metadata-icons/{colorist,cover-artist,editor,inker,letterer,penciller,writer}.svg` | 7 | Cohesive | Zero orphans; referenced at `src/js/metadata-window.js:100,124-136`. |
| HTML documents | `src/options.html`, `src/metadata.html` | 2 | Findings | Duplicate `#custom-css`, orphaned viewport keybind slots, duplicate ID, missing `<template>` slots. |
| Options CSS | `src/css/options.css` | 1 | Findings | Hover rule typo, hardcoded colors, dead selectors, Sync A mascot filter migration, R3 `.is-measuring-width`. |
| Options JS | `src/js/options/options.js`, `keybindUi.js`, `associationsUi.js` | 3 | Findings | Save atomicity bug, cross-module DOM reach-in, IPC waterfall, Prism keystroke lag, inline styles, O(N^2) conflict scan. |
| Metadata JS | `src/js/metadata.js`, `src/js/metadata-window.js` | 2 | Findings | Mixed pure parsers/IPC fetchers, `createElement` credit churn, double `fitContentHeight()`, stale null-clear bug. |

## Agreed findings and remediations

### S03-01 `[Blocking]` Duplicate `#custom-css` element on startup (`src/options.html:13-14`, `src/metadata.html:9-10`)

Both pages load `src/js/shared/themePrePaint.js` before `<style id="custom-css"></style>`. When `localStorage` contains `quivit-custom-css`, `themePrePaint.js:7-10` appends a `<style id="custom-css">` element to `<head>`, and the HTML parser immediately creates a second `#custom-css` element on the next line.

**Fix (Sync A/D with S01 and S02).** Place `<style id="custom-css"></style>` before `<script src="/js/shared/themePrePaint.js"></script>` in both `src/options.html` and `src/metadata.html`, matching `src/index.html` while `themePrePaint.js` reuses the existing `#custom-css` node.

### S03-02 `[Blocking]` Keybind slot drift, duplicate ID, and markup errors (`src/options.html:157-441,449,642,722,724`)

Live comparison of `src/options.html` against `ACTION_REGISTRY` in `src/js/services/actions.js` found three defects in the keybinds tab plus three markup defects elsewhere in the page.

1. `src/options.html:365,387` declares `id="workspace-keybind-note"` twice.
2. `src/options.html:386-407` renders a stale "Viewport position" section containing 5 dead `data-action` slots (`cmd-window-viewport-left`, `cmd-window-viewport-right`, `cmd-window-viewport-top`, `cmd-window-viewport-bottom`, `cmd-window-viewport-detached`). `actions.js:198` only generates `fileList` position actions, so those 5 slots have zero entries in `ACTION_REGISTRY`.
3. Out of the remaining categorized actions in `ACTION_REGISTRY`, 8 actions lack keybind slots in `src/options.html`: `cmd-filter-off` (`View`), `cmd-spread-off` (`Spread View`), `cmd-col-ext`, `cmd-col-dims`, `cmd-col-date`, `cmd-col-size`, `cmd-toggle-cursor-autohide`, and `cmd-quit` (`Window & UI`). `options.html` also splits `Scale Method` (`L243`) and `Filters` (`L256`) out of `View` and lists `cmd-refresh` (`L188`) under `Navigation` instead of `File Operations`.
4. `src/options.html:449` and `L642` contain literal markdown backticks around `<i>` tags (`\`<i>Open with</i>\`` and `\`<i>Ctrl+Shift+Alt+C</i>\``).
5. `src/options.html:724` places `<div id="measure-probe">` between `<script>` tags (`L723` and `L725`).
6. `src/options.html:722` loads `/js/vendors/prism.min.js` without `data-manual`. Without `data-manual`, Prism schedules an automatic `highlightAll()` pass on `DOMContentLoaded`/`requestAnimationFrame` across the document even though `options.js` invokes `Prism.highlight()` manually.

**Fix.** Remove the 5 dead `cmd-window-viewport-*` slots and replace `id="workspace-keybind-note"` with a class or single note. Keep static category/action rows in `src/options.html` reconciled with `ACTION_REGISTRY` (preserving HTML-first layout, instant first paint, and explicit `Scale Method`/`Filters`/`Wheel Behaviour` grouping), and document any intentional exclusions such as `cmd-quit` in the Mocha parity test. Add a `<template id="keybind-tag-template">` for tag pills and `+` buttons in `src/options.html`. Remove the stray backticks at `L449` and `L642`, move `#measure-probe` above the `<script>` block, and add `data-manual` on `prism.min.js` or lazy-load Prism when the Customization tab opens.

### S03-03 `[Blocking]` Keybind UI inline styles, DOM wipe, and O(N^2) conflict scan (`src/js/options/keybindUi.js:3,12,129-132,279-304,312,317-387`)

`renderKeybinds()` violates both HTML-first rendering and CSS source-of-truth rules while repeating work on every render.

- **CSS source-of-truth break (`L330-331`).** Sets `tag.style.color` and `tag.style.borderColor` directly instead of setting `--conflict-color` and toggling an `.is-conflict` class styled in `src/css/options.css`.
- **DOM wipe and imperative rebuild (`L321-387`).** Clears `tagsContainer.innerHTML = ''` and calls `document.createElement` for every binding and `+` button across all slots on every rebind, removal, or reset.
- **Repeated conflict scan (`L317-319`).** Calls `getConflictColors(config.frontend_data.keybinds)` inside `slots.forEach(...)` (~64 times per render). In Node benchmarks against `DEFAULT_KEYBINDS`, 64 calls take `5.885ms` versus `0.073ms` for a single call.
- **Global capture delay and config mutation (`L129-132,279-304`).** `cleanup()` uses a 100ms `setTimeout` that holds `isCapturing = true` and suppresses `contextmenu` across the whole Options window after capture finishes. `initScrollModeToggle` and `syncScrollModeToggle` query global `document` instead of `container` and mutate `config.frontend_data.scroll_zoom_modifier` directly rather than notifying an `onChange` callback.
- **Dead symbols (`L3,12,312`).** `CATEGORIES` is imported at `L3` and never used. `validateKeybindSafety` is re-exported at `L12` with zero callers because `options.js:6` imports it directly from `../services/keybindDomain.js`. The comment at `L312` cites `CATEGORIES in actions.js` despite static HTML slots.

**Fix.** Compute `getConflictColors` once before `slots.forEach`, clone and recycle `.keybind-tag` nodes from `<template>` (or re-render only changed slots), replace inline color writes with `tag.style.setProperty('--conflict-color', conflictColor)` plus `.is-conflict`, scope scroll-mode controls to `container`, detach capture listeners immediately on completion, and drop unused `CATEGORIES` and `validateKeybindSafety` exports.

### S03-04 `[Blocking]` Premature state mutation in `saveOptions()` (`src/js/options/options.js:556-609`)

`saveOptions()` mutates Windows associations, `localStorage`, and in-memory `config` before persistence succeeds.

1. `L556` runs `await applyAssociations(showStatus)` before `L593` (`invoke('move_library')`) or `L603` (`invoke('save_config')`).
2. `L578-584` writes `quivit-theme` and `quivit-custom-css` to `localStorage`.
3. `L587` overwrites `config` via `Object.assign(config, merged)`.

If `move_library` fails (for example, non-empty target directory) or `save_config` rejects, the function jumps to `catch` at `L621`. In-memory `config`, `localStorage` pre-paint keys, and registry associations are already altered, while `setPreviewing(false)` at `L606` is skipped.

**Fix.** Run `await invoke('move_library' | 'save_config')` before mutating `config`, `localStorage`, or calling `setPreviewing(false)`. Run `applyAssociations` after config persistence succeeds or keep independent error reporting cleanly scoped without corrupting `config`/`localStorage` on save failure.

### S03-05 `[Blocking]` Cross-module DOM reach-in and global ID coupling (`src/js/options/options.js:632-643`, `src/js/options/associationsUi.js:109-175`)

`options.js:632-643` reaches into the File Types tab to disable `#btn-assoc-remove` during save, while `associationsUi.js:133-155` reaches back into the footer to disable `#btn-save-options` during removal. `associationsUi.js:109-175` also queries seven global IDs (`btn-assoc-recommended`, `btn-assoc-select-all`, `btn-assoc-deselect-all`, `btn-assoc-remove`, `assoc-remove-dialog`, `btn-assoc-settings`, `assoc-mascots`) instead of receiving a root `#tab-associations` element and callbacks.

**Fix.** Pass the `#tab-associations` root container and a `setBusy(busy)` callback from `options.js` into `initAssociationsUi`, making `options.js` the sole owner of `#btn-save-options` and footer busy state.

### S03-06 `[Warning]` Options pure form extraction, startup IPC waterfall, and Prism editor perf (`src/js/options/options.js:48-96,129-188,208,236,245,359-367,386-431,444,471,488-544`)

- **Pure helper extraction (`L48-96,488-544`).** `saveErrorMessage`, `relocationWarningMessage`, `pathsMatch`, `mergeFilterOptions`, and `buildConfigFromForm` have zero DOM coupling (except DOM reads inside `buildConfigFromForm`). Extract pure form/config/error transforms into `src/js/services/optionsForm.js` for direct Mocha coverage.
- **Triplicated `localStorage` theme/CSS sync and preview flag (`L8,137,140-143,359-367,373,578-584`).** Replace the three duplicate `quivit-theme`/`quivit-custom-css` sync blocks with S01's `shared/theme.js:syncThemeStorage` (Sync D), and adopt `isPreviewing()` from `shared/configPreview.js`.
- **`options-active-tab` ownership (`L236,245`).** Drop `src/js/main/main.js:64` reach-in (Sync D with S02) and move `options-active-tab` from `localStorage` to `sessionStorage` inside `options.js`, keeping `options.js` as sole owner so every new Options session opens on General.
- **Startup IPC waterfall (`L146-148,161-188`).** `init()` awaits 7 `invoke(...)` calls sequentially (`load_config`, `get_config_dir`, `get_local_data_dir`, `get_active_config_info`, `get_default_dir`, `get_default_library_dir`, `get_library_dir`) while the window is hidden (`visible(false)` in `windows.rs:250`), delaying `fitContentWidth().then(showOptionsWindow)`. `refreshLiveConfigState()` (`L146-148`) also re-invokes static `get_config_dir` and `get_local_data_dir` on every `config-changed` event even when override mode immediately overwrites both labels. Batch independent startup invokes with `Promise.all` and skip static dir re-fetches on `config-changed`.
- **Prism CSS editor responsiveness (`L208,386-431,444,471`).** Every `input` event synchronously runs `Prism.highlight(...)` and assigns `highlightCode.innerHTML`. Measured in Node on CSS inputs of realistic sizes: `7.60ms` for `global.css` (6.8 KB), `8.59ms` for `options.css` (14.8 KB), and `23.54ms` for `main.css` (66.5 KB) before `innerHTML` parsing and layout. `syncScroll()` is not called after `input` or `Tab` insertion (`L417`), `window.syncCustomCssHighlight` leaks onto `window` (`L427`), and `localPreviewCss` (`L471`) is marked `async` without any `await`. Return `syncHighlight` locally, coalesce highlighting with `requestAnimationFrame`, sync scroll after `input` and `Tab` edits, and drop `async` on `localPreviewCss`.
- **Minor repetition (`L200-203,213-216,319-322,337-340`).** Extract a small helper for `.primary`/`.secondary` toggle groups (theme buttons and Anime4K variant buttons).

### S03-07 `[Warning]` Associations UI launch overhead, DOM re-queries, and format/error coupling (`src/js/options/associationsUi.js:11-17,33,44,74-81,96-103,111-169`)

- **Unconditional startup `sync_preview_associations` (`L96-103`).** Calls `invoke('sync_preview_associations')` on every Options window open whenever at least one format is registered, even though `spawn_launch_previews_sync` (`registry.rs:294`) already runs at app launch and General/Keys/Customization edits never touch File Types. Defer `sync_preview_associations` until the File Types tab opens.
- **Repeated DOM scans (`L33,44,112,119,122,140`).** Re-queries `document.querySelectorAll('.assoc-checkbox')` six times instead of caching the 22 checkboxes from `container` at init.
- **Duplicated format list and Rust error string coupling (`L11-17,74-81`).** `EXT_TO_GROUP` duplicates the 22 extensions already returned by `get_format_status()` (`SUPPORTED_FORMATS`). `L74-81` relies on exact Rust error prefixes (`"The release build"`, `"Close the preview pane and Explorer windows, then retry:"`, `"Preview helper update is pending."` from `platform/previews/windows.rs:303,328`, `platform/previews/host.rs:145`, and `platform/direct_open.rs`). Keep those prefixes locked across Sync F (S08/S11) or return structured error codes from Rust.
- **Event handler hygiene (`L111,119,122,127,161,169`).** Replace mixed `.onclick` property assignments with `addEventListener`, and guard `statusCallback?.(...)` at `L169`.

### S03-08 `[Blocking]` Options CSS violations and Sync A token/rule moves (`src/css/options.css:97-101,133-141,222-241,463,468,520-522,530,541-544,569,579,589`; `src/css/global.css:127-130,166-169`)

- **Move mascot filter rules from `global.css` to `options.css` (Sync A).** `src/css/global.css:127-130` and `L166-169` define Options-only `.assoc-mascot-svg` and `.assoc-mascot-box.is-active .assoc-format-icon` drop-shadow filters. Furthermore, `global.css:127-130` sits inside `@media (prefers-color-scheme: dark)` without `:root:not([data-theme="light"])`, leaking dark-mode icon outlines onto explicit Light theme under dark OS. Move both blocks into `src/css/options.css` with the `:root:not([data-theme="light"])` guard.
- **R3 `.tabs.is-measuring-width` (`src/css/options.css:14`).** Add `.tabs.is-measuring-width { width: fit-content; }` in `options.css` so S01's `src/js/shared/windowFit.js:15-18` removes inline `tabs.style.width = 'fit-content'`.
- **Link hover typo (`L133-141`).** `#link-supported-sites` at `L138` lacks `:hover`, unconditionally overriding `L133` with `--accent-hover`. Fix selector to `#link-supported-sites:hover`.
- **Hardcoded colors (`L463,468,569,579,589`).** Replace `#999` (`L463`) with `var(--text-dim)`, `#e53935` (`L468`) with `var(--danger)`, and `#fff` (`L569,579,589`) with a contrast-safe token (or `var(--inverse-text)` if added to `global.css` tokens).
- **Dead, duplicate, and unstyled rules.** Remove duplicate `.theme-group` (`L97-101` vs `L520-522`; `.flex-row` is already in HTML), dead `.scroll-mode-label` (`L541-544`, HTML uses `.keybind-name`), stale comment at `L530` ("under Pan", actually under "Wheel Behaviour"), and bare `textarea` (`L222-241`) overridden by `.custom-css-editor textarea`. Style `.segmented-control`/`.segmented-btn` (`options.html:103-108`) and `.is-error` (`associationsUi.js:106`).

### S03-09 `[Warning]` Metadata parser vs IPC/DOM boundary and CoMet XML gap (`src/js/metadata.js:5-6,12,19,21-47,58-101,278-317`)

`metadata.js` mixes pure string parsers (`parseMetadataText`, `parseComicInfoJson`, `parseGalleryMetaJson`, `parseComicInfo`, `parseOpf`, `findMetadataEntry`) with `FsUtils`/`fetch` archive loading (`L58-73`), `window.__TAURI__.core.invoke('find_directory_metadata')` (`L81-101`), and browser `DOMParser` (`L35`). Because of those globals, `mocha/metadata.test.js:4-58` has to stub `globalThis.window` and regex-mock `DOMParser`. `L19` also duplicates `metadataBareName` from `services/metadataFiles.js:10`, and `L42` routes `comet.xml` to `parseComicInfo`, which ignores CoMet-specific tags (`<pages>`, `<date>`, `<readingDirection>`).

**Fix.** Extract pure parsers (plus `metadataBareName` reuse from `services/metadataFiles.js` and an injectable XML parser or pure XML reader) into `src/js/services/metadataParser.js`, keeping `metadata.js` (or compatibility re-exports for `mocha/metadata.test.js` and `src/js/main/metadataBadge.js`) for archive/directory fetching. Address `comet.xml` `<pages>`/`<date>`/`<readingDirection>` parsing separately or document as a pure parser extension.

### S03-10 `[Warning]` Metadata window DOM churn, double fit, dual writer, and null-clear bug (`src/js/metadata-window.js:39,47,49,56,73-113,181,197,199`, `src/metadata.html:16,25`)

- **DOM rebuild and selector churn (`metadata-window.js:73-76,95-113`, `metadata.html:25`).** `applyValue` runs 20 `gridEl.querySelector(...)` calls per render, and credits create `<span>`/`<img>` nodes via `document.createElement` + `replaceChildren` on every archive update. Cache the `[data-key]` label/value `Map` once at init, and declare static 7-role credit slots (or `<template id="meta-credit-template">`) in `src/metadata.html`.
- **Stale DOM on null metadata (`L39`).** `if (!meta) return;` leaves the previous archive's title, cover, and grid visible when navigating to a folder/archive with no metadata (`metadataBadge.js:_clearMetadataState` currently deletes `quivit-metadata-current` without emitting `metadata-data`). Define `{ meta: null, coverSrc: null }` on `metadata-data` (Sync D with S02 `metadataBadge.js`) and clear fields + hide cover when `!meta`.
- **Double `fitContentHeight()` on cover updates (`L47,197`).** When `metadata-data` arrives with `coverSrc`, `L197` calls `fitContentHeight()` immediately before the image decodes, and `coverImg.onload` at `L47` queues a second `fit_metadata_window` IPC through `fitHeightTail`. Only call `fitContentHeight()` at `L197` when `!coverSrc` (matching startup `L172`).
- **Dual writer to `quivit-metadata-current` (`L199`).** `metadataBadge.js:93,132` already serializes and writes `{ meta, coverSrc }` to `localStorage` before emitting `metadata-data`. `metadata-window.js:199` redundantly calls `JSON.stringify(e.payload)` (including the base64 cover DataURL) and writes the same key. Keep `metadataBadge.js` as the sole writer (Sync D).
- **Empty `src=""` self-fetch risk (`L49,56`, `metadata.html:16`).** Clearing `coverImg.src = ''` resolves to `metadata.html` in WebViews and can re-trigger `onerror`. Use `coverImg.removeAttribute('src')` in JS and omit `src=""` in `src/metadata.html:16`.
- **Stale comment (`L181`).** `(config.rs)` should reference `windows.rs:294`.

## Cross-split seam summary (Sync A, D, and F)

- **Sync A (Main/Secondary HTML and CSS, S01/S02/S03).** `<style id="custom-css"></style>` lands before `themePrePaint.js` in `options.html:13-14` and `metadata.html:9-10`. `.assoc-mascot-svg` and `.assoc-mascot-box.is-active .assoc-format-icon` move from `global.css:127-130,166-169` into `options.css` with `:root:not([data-theme="light"])`. `options.css` adds `.tabs.is-measuring-width { width: fit-content; }` (R3). `options.html` adds a `<template>` for `.keybind-tag`/`.add-btn`, removes 5 dead `cmd-window-viewport-*` slots and duplicate `id="workspace-keybind-note"`, adds `data-manual`/lazy-load on `prism.min.js`, and preserves all selectors in `e2e/pageobjects/options.page.js`. `metadata.html` adds static 7-role credit slots or `<template>`.
- **Sync D (Multi-Window, Persistence, and Config, S01/S02/S03/S08).** `options.js` adopts `shared/theme.js:syncThemeStorage` and `shared/configPreview.js:isPreviewing()`. `options-active-tab` moves to `sessionStorage` owned solely by `options.js` (dropping `main.js:64`). `metadataBadge.js` stays sole writer of `quivit-metadata-current` and emits `{ meta: null, coverSrc: null }` on `metadata-data` clear. `windowFit.js` (`400..=560`, `280..=600`) stays aligned with `windows.rs:51,61,376-407`, while `metadata-window.js` eliminates the duplicate `fitContentHeight()` call. `requestWorkspace('main', 'core', 'flushConfig')`, `e2e_suite` locks (`options.js:190-194`), and roaming/portable/override `config.rs` flows remain intact.
- **Sync F (Formats, Registry, and Directory Metadata, S03/S08/S09/S10/S11).** 22-format parity stays 1:1 across `options.html`, `associationsUi.js`, `src/assets/icons/*.png`, `icons/formats/*.ico`, and `formats.rs:SUPPORTED_FORMATS`. IPC contracts `get_format_status`, `apply_associations`, `unregister_associations`, `sync_preview_associations` (`commands/registry.rs`), `find_directory_metadata` (`commands/directory.rs:530`), and the three Rust error prefixes matched at `associationsUi.js:74-81` remain locked.

## Telemetry A and B specifications

| Suite | Command | Existing coverage | Telemetry A (pre-refactor additions) | Telemetry B (post-refactor proof) |
|---|---|---|---|---|
| Mocha unit tests | `npm run mocha` | 308 passing (`mocha/metadata.test.js` 14 tests with `window.__TAURI__`/`DOMParser` mocks; 0 tests for `options/*` or HTML/asset parity). | Add `mocha/optionsForm.test.js` (extracted pure `services/optionsForm.js` + `saveOptions` failure-atomicity); add static parity checks (0 duplicate HTML IDs, single `#custom-css`, 22 PNGs == `options.html` == `EXT_TO_GROUP`, all `options.html` `data-action` slots in `ACTION_REGISTRY` + categorized actions covered minus documented exclusions); expand pure `metadataParser` tests without `window.__TAURI__` mock (including `parseComicInfo` XML, `parseOpf`, `comet.xml`). | Re-run `npm run mocha` with 0 regressions; add assertions proving zero inline `.style.color`/`.borderColor` or `tabs.style.width` writes in `keybindUi.js`/`windowFit.js`, zero `window.syncCustomCssHighlight` global leak, `getConflictColors` called once per `renderKeybinds()`, and `metadata-window` null-clear + single `fitContentHeight` on cover load. |
| WebdriverIO E2E | `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js` | Tests tab switching (`tab-general`..`tab-language`) and light/dark theme save + main window sync (`e2e/pageobjects/options.page.js`). | Keep all selectors in `options.page.js` intact. Extend `06-configuration.e2e.js` (and/or metadata spec) to cover keybind conflict styling (`--conflict-color`/`.is-conflict`) and reset, custom CSS preview + revert-on-close, associations mascot hover, `options-active-tab` session reset across launches, and `metadata.html` open/render/cover-orientation/null-clear + single `fit_metadata_window`. | Re-run `06-configuration.e2e.js` proving 1:1 UX parity, faster Options initial show (batched startup IPCs, deferred `sync_preview_associations`), responsive Prism CSS input (rAF-coalesced highlighting), and clean `metadata.html` clear on empty folders. |
| Replay diagnostics | `npm run diagnose -- <scenario>` | N/A (0 probes or scenarios target `options.html` or `metadata.html`). | N/A | N/A |
| Rust backend tests | `cargo test --manifest-path src-tauri/Cargo.toml` | `config_tests` (roaming/portable/`e2e_suite`), `format_tests` (`SUPPORTED_FORMATS`), `windows` (`open_options`, `open_metadata_window`, `fit_*`). | Read-only seam check for `formats.rs` (`SUPPORTED_FORMATS` 22 exts) and `config_tests`/`windows`. | Read-only seam check confirming `OPTIONS_MAX_INITIAL_W`/`META_MAX_INITIAL_H` and `formats.rs` 22-format parity remain intact. |
