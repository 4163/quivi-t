# Audit 01: frontend core, filesystem, input, and workspace (`fe-core-fs-workspace`)

Split S01 covers 23 JavaScript files (5,057 lines) across the state machine, filesystem and archive client, sorting and directory preferences, history, shortcuts, action registry, caches, theme and window sizing helpers, and multi-window workspace RPC.

Both S01 workers (`s01-state-arch` and `s01-validate-input`) completed independent passes, cross-verified every `file:line` reference and caller against live code, reached unanimous `[Agree]` on 19 findings (`S01-01` to `S01-19`) and 5 `Cohesive` files, and ratified the cross-split seam matrix (Sync A through F, R3, R4). Baseline `npm run mocha` passed 308 of 308 tests.

## File coverage ledger

| File | Lines | Status | Findings |
|---|---|---|---|
| `src/js/core.js` | 801 | `[Agreed]` | `S01-01`, `S01-02` |
| `src/js/fsUtils.js` | 1,310 | `[Agreed]` | `S01-03`, `S01-04` |
| `src/js/directoryPrefs.js` | 189 | `[Agreed]` | `S01-05` |
| `src/js/navigationHistory.js` | 127 | `[Agreed]` | `S01-06` |
| `src/js/keybinds.js` | 111 | `[Agreed]` | `S01-07` |
| `src/js/keyboardNav.js` | 185 | `[Agreed]` | `S01-08` |
| `src/js/shortcuts.js` | 545 | `[Agreed]` | `S01-09` |
| `src/js/services/actions.js` | 403 | `[Agreed]` | `S01-10` |
| `src/js/services/archiveImageCache.js` | 194 | `[Agreed]` | `S01-11` |
| `src/js/services/cache.js` | 51 | `Cohesive` | None (add `BoundedSet` tests) |
| `src/js/services/keybindDomain.js` | 77 | `[Agreed]` | `S01-12` |
| `src/js/services/keyCombo.js` | 108 | `[Agreed]` | `S01-13` |
| `src/js/services/sorting.js` | 144 | `[Agreed]` | `S01-14` |
| `src/js/services/workspaceLayout.js` | 52 | `Cohesive` | None (drop unused param, add tests) |
| `src/js/shared/clipboard.js` | 25 | `Cohesive` | None |
| `src/js/shared/configPreview.js` | 53 | `[Agreed]` | `S01-16` |
| `src/js/shared/theme.js` | 32 | `[Agreed]` | `S01-15` |
| `src/js/shared/themePrePaint.js` | 13 | `[Agreed]` | `S01-15` |
| `src/js/shared/windowFit.js` | 40 | `[Agreed]` | `S01-17` |
| `src/js/shared/workspaceControls.js` | 182 | `[Agreed]` | `S01-18` |
| `src/js/shared/workspaceHost.js` | 28 | `Cohesive` | None (guard `location.search`, add tests) |
| `src/js/shared/workspaceSession.js` | 306 | `[Agreed]` | `S01-19` |
| `src/js/shellBackground.js` | 81 | `Cohesive` | None |

All 23 owned files are accounted for (18 files with findings, 5 cohesive files, 0 dropped, 0 escalated).

## Agreed findings

### S01-01 `[Blocking]` `src/js/core.js`: state machine purity, circular dependencies, and direct config mutations

- **Targets:** `src/js/core.js:25,34,40-41,45,140-154,166,185,401,429-435,447,503,709,738,747-780`
- **Problem:**
  1. `core.js:40-41` imports `FsUtils` and `DirectoryPrefs`, while `fsUtils.js:1` and `directoryPrefs.js:1` import `Core`. This creates a three-way circular dependency.
  2. `core.js` invokes `window.__TAURI__.core.invoke` directly at `L45,185,447,709,755,762,777` and dispatches `window.dispatchEvent(new CustomEvent('quivit-config-loaded'))` at `L738`. `Core.init()` at `L747-780` mixes startup CLI resolution, file loading, and window showing into the state machine.
  3. Initial `_state.config` at `L140-154` hardcodes a partial object instead of running `mergeConfig({})`.
  4. `getState()` (`L401`) and `_notify()` (`L166`) return shallow copies (`{ ..._state }`), so external callers (`fsUtils.js:568`, `shortcuts.js:394`, `menubar/chrome.js:73`, `directoryPrefs.js:50-51,73-74,87`) mutate `_state.config.frontend_data` in place instead of going through `Core` mutators.
  5. `L503` duplicates the `1.2` spread threshold from `src/js/services/viewerMath.js:8` (`checkIsSpread`). `L429-435` defines identical aliases `isDownloading` and `isPlaceholder`. `L34` still points to `STATE_KEYS in lib.rs` even though `STATE_KEYS` lives at `src-tauri/src/config.rs:368`. `L25` still lists `options-active-tab` under `localStorage` even though S03 moves it to `sessionStorage` (R4).
- **Agreed fix:**
  1. Break the circular imports by injecting filesystem, sort, IPC, and config-loaded callbacks into `Core` (or configuring adapters during bootstrap) so `core.js` has zero `window.__TAURI__`, `window.dispatchEvent`, `FsUtils`, or `DirectoryPrefs` top-level dependencies.
  2. Move `Core.init()` startup orchestration out of `core.js` into main bootstrap (`src/js/main/main.js`, Sync D) while keeping `resolveStartupTarget` as a pure exported function.
  3. Initialize `_state.config` with `mergeConfig({})`.
  4. Add explicit mutators `Core.setStatusBarVisible(visible, options)` (for `chrome.js:73-74`, Sync D), `Core.setScrollZoomLatched(latched, options)` (for `shortcuts.js:394`), `Core.applyDirectorySort(path, col, desc)` (added to `CORE_SESSION_METHODS`), and a monotonic `configVersion` counter incremented on every config mutation or load.
  5. Reuse `checkIsSpread` from `services/viewerMath.js`, delegate `isDownloading` to `isPlaceholder` (or keep one canonical method with thin alias if callers need both), update `L34` to `config.rs`, and update `L25` to `sessionStorage` (R4).
- **Telemetry A/B:** `npm run mocha` (`mocha/core.test.js` without `globalThis.window` mock after refactor; add tests for `setStatusBarVisible`, `setScrollZoomLatched`, `applyDirectorySort`, `configVersion`, `mergeConfig({})` initial state), `npm run e2e -- --spec e2e/specs/01-startup.e2e.js`, `05-persistence.e2e.js`, `npm run diagnose -- sample-navigation` (preserve `corePipelineProbe.js` hooks on `Core.{getState,onStateChange,navigate,persistConfig}`).

### S01-02 `[Warning]` `src/js/core.js`: startup waterfall, navigation swap latency, and double notifications

- **Targets:** `src/js/core.js:244-290,555-589,662-682,747-779`
- **Problem:**
  1. Startup at `L748-779` awaits `loadConfig()`, then awaits `get_initial_args`, then sleeps a fixed 50 ms `setTimeout` before invoking `show_window`. `load_config` and `get_initial_args` are independent, and detached boot (`main.js:428-429`) already awaits `syncShellBackground()` instead of sleeping 50 ms.
  2. `_selectEntry` (`L244-290`) mutates `_state.index`, `_state.filename`, `_state.spreadStep`, and `_state.naturalWidth/Height` before awaiting async `buildArchiveEntrySrc`, `buildFileSrc`, or `checkArchiveEncryption`, with no rollback if an IPC throws. Non-ICO files still pay an async microtask hop through `await buildFileSrc(...)` instead of calling the synchronous URL builder directly, and selecting an archive row blocks `_notify()` on `list_archive` (`checkArchiveEncryption`).
  3. `setSpreadMode` (`L559-560`), `toggleSpreadMode` (`L570-571`), and `setManhwaMode(true)` (`L582-588`) each call two state mutators back to back, firing `_notify()` twice and scheduling config flush twice per user toggle.
  4. `navigate(delta)` (`L663-670`) scans `firstImageIndex` from the start and `lastImgIdx` from the end of `_state.list` on every page step (O(N) per arrow press).
- **Agreed fix:**
  1. Run `load_config` and `get_initial_args` concurrently with `Promise.all` in main bootstrap, and await `syncShellBackground()` before `show_window` instead of sleeping 50 ms.
  2. In `_selectEntry`, use synchronous URL resolution for non-ICO entries, keep `_state` unchanged if an async ICO or encryption lookup rejects, and resolve `checkArchiveEncryption` asynchronously with generation/selection guards (matching `checkIsAnimated` at `L330-341`).
  3. Coalesce spread and manhwa mode transitions into single atomic updates that fire `_notify()` once and schedule one config flush.
  4. Cache first and last image indices per `_state.list` reference (or check only when wrapping near list edges) so `navigate(delta)` runs in O(1).
- **Telemetry A/B:** `npm run mocha` (add tests asserting single `_notify()` call for `setSpreadMode`/`toggleSpreadMode`/`setManhwaMode`, rollback on `_selectEntry` error, and O(1) `navigate` edge-wrap parity), `npm run e2e -- --spec e2e/specs/01-startup.e2e.js`, `02-navigation.e2e.js`, `03-viewer.e2e.js`, `04-archives.e2e.js`, `npm run diagnose -- sample-navigation`, `manhwa-buffer` (measure startup and swap latency delta via `corePipelineProbe` and `ipcProtocolProbe`).

### S01-03 `[Blocking]` `src/js/fsUtils.js`: decompose 1,310-line god-module and remove top-level Tauri crash

- **Targets:** `src/js/fsUtils.js:1-1310` (notably `L8,15-21,29-30,76-180,277-311,429-432,483-529,1071,1080,1160,1211,1239`)
- **Problem:**
  1. `fsUtils.js:8` executes `const { invoke } = window.__TAURI__.core;` at module evaluation time, crashing Node/Mocha imports unless callers fake `globalThis.window.__TAURI__` (`mocha/viewerMath.test.js:1004-1007`).
  2. One 1,310-line file combines seven concerns: format sets and path helpers, custom-protocol URL builders and ICO facades, list shaping and index resolution, archive password/encryption caches and prefetching, pending deletion tracking, directory/container navigation orchestration, and native file dialogs.
  3. `L29-30` places `import { BoundedMap }` mid-file and re-exports `BoundedMap` with zero importers.
  4. `L279,287,301,308` recompute `navigator.userAgent.includes('Windows')` and the `quivit` origin four times inside hot URL builders. `L97` allocates a new `TextEncoder()` on every `_base64Encode()` call.
  5. `L483-529` duplicates the neighbor-scanning loop between `neighborEntries` and `neighborVideoEntries`. `L1071,1080` throws the string `'Already at root'` for normal control flow. `L1160,1211,1239` dispatches DOM `CustomEvent`s directly on `window`.
  6. `L429-432` (`buildAudioSrc`) has only one caller (`src/js/viewer/viewerAudio.js:157`) and becomes dead once S06 retires `#viewer-audio` (R4). `manhwaStrip.js` still calls `cancel_width_scan` outside `FsUtils` (Sync F).
- **Agreed fix:**
  1. Split `fsUtils.js` into three pure modules plus a thin Tauri coordinator facade (keeping `FsUtils` and `FS_SESSION_METHODS` intact for existing callers):
     - `src/js/services/mediaFormats.js`: `SUPPORTED_IMAGES`, `SUPPORTED_ARCHIVES`, `SHELL_THUMBNAIL_EXTS`, extension and entry predicates, `parentOf`, `basename`, `normalizePathKey`, `cleanEntryName`, `normalizeArchiveEntryPath`, `getIconExtKey`.
     - `src/js/services/mediaUrls.js`: hoisted `QUIVIT_ORIGIN` and `TEXT_ENCODER`, `_base64Encode`, `versionMediaSrc`, `buildArchiveSrc`, `buildNativeIconSrc`, `buildShellThumbnailSrc`, `buildTiffSrc`, `buildThumbnailSrc`, `buildFileSrcSync`, `isConstrainedThumbnailSrc`, `isIcoSources`, `firstIcoSrc`, `icoSourcesTotal`, unified `neighborMediaEntries`.
     - `src/js/services/listNavigation.js`: cached `Intl.DateTimeFormat`, `formatEntry`, `buildDirectoryList`, `buildArchiveList`, `findArchiveTargetIndex`, O(N + M) `findNearestSurvivingIndex`, `firstImageIndex`, memoized `naturalPagePosition`, `formatStatusIndex`.
     - `src/js/fsUtils.js`: thin IPC/dialog/archive-session coordinator with lazy guarded `getInvoke()`, injected event callbacks instead of `window.dispatchEvent`, and `cancelWidthScan()` wrapper for S06 (Sync F).
  2. Drop the dead `BoundedMap` re-export (`L29-30`), replace `throw 'Already at root'` (`L1071`) with an explicit branch, and delete `buildAudioSrc` (`L429-432`) in sync with S06 removing `#viewer-audio` (R4).
- **Telemetry A/B:** `npm run mocha` (add unit suites for `mediaFormats`, `mediaUrls`, `listNavigation`, and `fsUtils` without mocking `window.__TAURI__`; remove `globalThis.window` stub from `mocha/viewerMath.test.js:1004-1007,1023-1025`), `npm run e2e -- --spec e2e/specs/02-navigation.e2e.js`, `04-archives.e2e.js`, `npm run diagnose -- sample-navigation` (confirm `ipcProtocolProbe.js` sees identical `quivit://` and `asset://` routes).

### S01-04 `[Blocking]` `src/js/fsUtils.js`: un-awaited `applyDirectoryResult` races and hot-path directory/navigation stalls

- **Targets:** `src/js/fsUtils.js:89-94,139-180,540-548,580-609,693-712,974,1029-1030,1054-1058,1077-1078`
- **Problem:**
  1. `applyDirectoryResult` (`L572`) is `async`, yet `loadFile` (`L974,1029`) and `openParent` (`L1054,1056,1077`) invoke it without `await`. `persistLastOpened` (`L1030,1058,1078`) runs before `applyDirectoryResult` finishes generation checks and state updates, and callers (`openSibling`, E2E runners) observe `loadFile` resolving before `Core` state updates.
  2. `naturalPagePosition(list, filename)` (`L540-548`) is called on every `Core.onStateChange` via `src/js/main/lifecycle.js:8`. It filters and re-sorts all image entries from scratch on every state notification. Benchmarked in Node on 2,000 filenames, one call takes **21.82 ms** of synchronous main-thread work per navigation, dimension update, or mode toggle.
  3. `_formatDate` (`L89-94`) calls `new Date(ms).toLocaleDateString()` per file on every directory or archive load. Benchmarked in Node on 2,000 timestamps, it takes **77.93 ms** compared to **2.58 ms** with a cached `Intl.DateTimeFormat()` (30.1x faster).
  4. `applyDirectoryResult` (`L693-698`) awaits `Core.checkIsAnimated(selectedEntry.path, null)` before calling `Core.setState()` for every image extension (including `.jpg`, `.bmp`, `.ico`, `.tif`), stalling first-frame paint by a full Rust file-open IPC. `L703-712` likewise blocks `Core.setState()` on `checkArchiveEncryption`.
  5. `L580-609` invokes `read_text_file` on `gallery.json` on every directory open, even though `src-tauri/src/commands/directory.rs:35,57-65` already checks `dir.join("gallery.json").is_file()` and never includes `.json` files in `result.files`. `L608` (`files.filter(f => f.name.toLowerCase() !== 'gallery.json')`) is dead work.
  6. `findNearestSurvivingIndex` (`L139-180`) runs nested `newFiles.findIndex(...)` loops (O(N * M)) on refresh after deletions.
- **Agreed fix:**
  1. `await this.applyDirectoryResult(...)` at `L974,1029,1054,1056,1077` so `persistLastOpened` and upstream callers run strictly after generation checks and `Core.setState()`.
  2. Cache `naturalPagePosition` per `list` array reference in a `WeakMap<Array, { positions: Map<string, number>, total: number }>` (verified zero in-place `state.list` mutations across `src/`), dropping repeat lookups from ~22 ms to O(1).
  3. Hoist a module-scope `const DATE_FORMATTER = new Intl.DateTimeFormat()` in `listNavigation.js` (30.1x speedup on 2,000 items).
  4. Match `core.js:307-341` and `loadArchive` (`L857-897`) in `applyDirectoryResult`: commit `Core.setState()` immediately with extension-guessed `isAnimated`, run `checkIsAnimated` asynchronously only for animatable formats (`gif`, `webp`, `apng`, `png`, `avif`, `svg`), and resolve `checkArchiveEncryption` asynchronously with generation guards.
  5. Consume additive `result.has_gallery_sidecar: bool` from `DirectoryReadResult` (`src-tauri/src/models.rs` S08, `commands/directory.rs:35` S10, Sync E/F), skipping `read_text_file` on non-gallery directories and deleting the dead `L608` filter.
  6. Build a `Map<string, number>` over `newFiles` in `findNearestSurvivingIndex` for O(N + M) lookup.
- **Telemetry A/B:** `npm run mocha` (add tests for `applyDirectoryResult` await ordering, `naturalPagePosition` `WeakMap` cache hit, `has_gallery_sidecar` gating, `findNearestSurvivingIndex` O(N + M), and `_formatDate` output parity + timing), `npm run e2e -- --spec e2e/specs/02-navigation.e2e.js`, `04-archives.e2e.js`, `npm run diagnose -- sample-navigation`, `filter-navigation` (confirm 0 `ipc-error` events on `gallery.json` and reduced folder-open IPC latency), `cargo test --manifest-path src-tauri/Cargo.toml directory` (verify `has_gallery_sidecar`).

### S01-05 `[Warning]` `src/js/directoryPrefs.js`: circular dependency, read-time mutation, and detached full-list RPC

- **Targets:** `src/js/directoryPrefs.js:1,6-8,12,50-51,58-62,73-81,87-95,111-116,127-152,179-188`
- **Problem:**
  1. Circular import with `core.js` (`L1`).
  2. `getSortPrefs` (`L50-51`) mutates `fd.default_sort` and `fd.directory_sort` during a read. `setSortPrefs`, `removeSortPrefs`, and `reconcileDirectorySort` mutate shallow `Core.getState().config.frontend_data` in place.
  3. In detached `?surface=fileList`, `sortCurrentState` (`L179-188`) ships the entire `sortedList` array (potentially thousands of entries) across IPC via `Core.setListAndIndex(sortedList, newIdx)` alongside an unsequenced `Core.persistConfig()` RPC.
  4. `L58-62,77-81,111-116` linearly scan and re-normalize every key in `directory_sort` on every read/write/delete. `L90` hardcodes magic cap `100` without a named module constant. `L12` duplicates `['ext', 'date', 'size', 'dims']` from `core.js:614,636`.
  5. `reconcileDirectorySort` (`L127-152`) binds `invoke` at `L127` then ignores it at `L133`, calls `window.__TAURI__.core.invoke` directly, and fires up to 100 concurrent `get_path_kind` IPCs in `Promise.all`.
- **Agreed fix:**
  1. Separate pure sort-preference resolution from `Core` and Tauri IPC via injected state/persist/path-kind adapters, breaking the circular import.
  2. Remove read-time mutations in `getSortPrefs`; route writes through `Core.patchFrontendConfig`.
  3. Replace detached `sortCurrentState` full-list RPC with `Core.applyDirectorySort(path, col, desc)` (`CORE_SESSION_METHODS`, Sync D), so only three scalar arguments cross IPC and `main` sorts once atomically.
  4. Normalize keys on write (with one-time normalization on `mergeConfig`) for O(1) lookup, define `const DIRECTORY_SORT_CAPACITY = 100`, reuse shared `FILE_LIST_COLUMNS`, and cap `reconcileDirectorySort` concurrency (e.g. batch of 8).
- **Telemetry A/B:** `npm run mocha` (expand `mocha/sorting.test.js` for capacity 100 eviction, read immutability, column-disable fallback, O(1) normalized keys, and bounded reconcile concurrency), `npm run e2e -- --spec e2e/specs/02-navigation.e2e.js`, `05-persistence.e2e.js` (including detached `?surface=fileList` sort).

### S01-06 `[Warning]` `src/js/navigationHistory.js`: direct `window.dispatchEvent` and duplicated path normalization

- **Targets:** `src/js/navigationHistory.js:6-8,14-32`
- **Problem:** `emitChange()` (`L6-8`) calls `window.dispatchEvent(new CustomEvent('quivit-history-changed'))` directly, preventing pure Node/Mocha execution without mocking `window`. `entryKey` (`L14-16`) skips Windows path normalization (case/slash variants look like distinct containers), and `remapPath` (`L22-32`) duplicates path normalization from `directoryPrefs.js` and `fsUtils.js`.
- **Agreed fix:** Replace `window.dispatchEvent` with a subscriber callback (`onHistoryChange(fn)`) subscribed by main bootstrap (`main.js` bridges to the DOM event or updates menu state), and reuse `normalizePathKey` from `services/mediaFormats.js` in `entryKey` and `remapPath`.
- **Telemetry A/B:** `npm run mocha` (add `mocha/navigationHistory.test.js` covering `HISTORY_LIMIT = 100`, back/forward stacks, `history: 'skip'`, slash/case normalization in `sameContainer`, and `remapLibraryPaths`), `npm run e2e -- --spec e2e/specs/02-navigation.e2e.js`.

### S01-07 `[Warning]` `src/js/keybinds.js`: inverted layer placement, dead deletes, and JSON clone overhead

- **Targets:** `src/js/keybinds.js:1-111` (notably `L24-35,56-59,82-84,96,102-104`)
- **Problem:** `keybinds.js` holds the full app configuration schema and `mergeConfig`, not just keybinds. Placing it at `src/js/keybinds.js` forces pure `src/js/services/viewerMath.js:1` into a reverse-layer import (`../keybinds.js`). `L56-59` deletes three keys from `fdBase` that are immediately overwritten at `L82-84`. `L82-84` accepts `NaN` or negative numbers (`typeof === 'number'`). `L96` clones `DEFAULT_KEYBINDS` via `JSON.parse(JSON.stringify(...))`. `L102-104` hardcodes `Escape` instead of importing `LOCKED_BINDINGS` from `services/keybindDomain.js:8-10`.
- **Agreed fix:** Move config defaults, `normalizeFileListColumns`, `FILE_LIST_COLUMNS`, and `mergeConfig` to `src/js/services/configSchema.js` (keeping thin re-exports in `keybinds.js` only if external callers need a transition step; update `services/viewerMath.js:1` in Sync B). Delete `L56-59`, validate numeric fields with `Number.isFinite` and non-negative bounds, clone `DEFAULT_KEYBINDS` arrays with `.slice()`, and derive locked bindings from `LOCKED_BINDINGS`.
- **Telemetry A/B:** `npm run mocha` (`mocha/core.test.js` and new `mocha/configSchema.test.js` covering `NaN`/negative pan and cursor delay defaults, locked `Escape` enforcement, and `viewerMath.js` zero reverse imports), `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js`.

### S01-08 `[Warning]` `src/js/keyboardNav.js`: unnecessary DOM scans and forced reflows

- **Targets:** `src/js/keyboardNav.js:94-103,171-185`
- **Problem:** `makeContainerNavigable` (`L96`) runs `Array.from(containerEl.querySelectorAll(itemSelector))` on every `keydown` inside the container before checking whether `e.key` is even a navigation key. `handleTabJump` (`L171-185`) omits `SELECT` from the excluded tag list (`L172`) and triggers synchronous layout reflows (`offsetWidth`, `offsetHeight`, `getComputedStyle`) across every tabbable control on the page on `Home`/`End`.
- **Agreed fix:** In `makeContainerNavigable`, check `e.key` against handled keys before querying `itemSelector`. In `handleTabJump`, exclude `SELECT` and prefer `el.checkVisibility?.({ checkVisibilityCSS: true })` (native in WebView2/Chromium) with a single fallback when unavailable.
- **Telemetry A/B:** `npm run mocha` (add pure helper tests for `findNextNavigableIndex` / `findInitialNavigableIndex` and key filtering), `npm run e2e -- --spec e2e/specs/02-navigation.e2e.js`, `06-configuration.e2e.js`.

### S01-09 `[Blocking]` `src/js/shortcuts.js`: menubar/statusbar reach-in, per-navigation DOM writes, and input bugs

- **Targets:** `src/js/shortcuts.js:5-17,62-76,97-134,145-151,199,220-230,254-368,394-395,422-456,472-509,514-544`
- **Problem:**
  1. Direct cross-module reach-in: imports `Statusbar` (`L6`) and `closeMenus, syncViewMenu` (`L7`). `L285-287` fabricates a fake `mockState` to mutate `Statusbar.syncManhwaIndicator` and `syncViewMenu` during Manhwa key-hold repeat.
  2. Foreign DOM ownership: `updateMenuShortcuts` (`L11-17`) writes `#${id} .shortcut` owned by `menubar.js`, and `src/js/main/main.js:187` invokes it on every `Core.onStateChange` (~55 `document.querySelector` calls per navigation step even though keybinds only change on `quivit-config-loaded`). `L318-329` focuses `#file-list` and dispatches a synthetic `KeyboardEvent('keydown', { key: 'Enter' })`. `L129-133,274,422-435,452,514,517` hardcode foreign overlay/panel/menubar/statusbar selectors.
  3. Direct config mutation at `L394-395` writes `config.frontend_data.scroll_zoom_latched` in place.
  4. Hot-path waste and bugs: `keydown` (`L347` -> `L366` -> `L278`) calls `formatKeysCombo` and `findAction` twice per non-pan key. `_updateScrollIndicator` (`L109`) rescans `getScrollModifierKeys` with regex on every modifier key event instead of reading `_cachedToggleKeys`. `handleMouseButton` (`L472-509`) schedules a 350 ms timer on every left click because `cmd-pan-drag` is bound to `MouseLeft`, firing `closeMenus()` 350 ms later (which can close a menu opened right after clicking the viewport).
  5. Dead code: `formatKeyName` (`L5`) is imported and unused; `activeButtons` (`L9`) is exported with zero external importers (`viewerGestures.js:2` imports only `activeKeys`).
- **Agreed fix:**
  1. Remove `menubar.js` and `statusbar.js` imports (`L6-7`). Move `updateMenuShortcuts` into `menubar.js` running only on `quivit-config-loaded` (Sync A/B with S02). Replace `Statusbar.setScrollIndicatorState`, `Statusbar.syncManhwaIndicator`, `syncViewMenu`, `closeMenus`, `#file-list` Enter forwarding, and UI-target checks with injected callbacks or reactive `Core` state (Sync B).
  2. Route `scroll_zoom_latched` through `Core.setScrollZoomLatched(_toggleLatched, { persist: true })`.
  3. Compute `actionId` once per `keydown`, reuse cached toggle tokens in `_updateScrollIndicator`, skip the 350 ms click timer when the single-click binding is gesture-only (`cmd-pan-drag`) or when no double-click action is bound for that button, move `keybindTokenToActiveKey` and `getScrollModifierKeys` to `services/keyCombo.js`, delete unused `formatKeyName` import, unexport `activeButtons`, and keep `activeKeys` (or read-only `hasActiveShortcutKeys()`) compatible while S06 migrates `viewerGestures.js:2,137` (R4).
- **Telemetry A/B:** `npm run mocha` (add pure tests for scroll-latch state machine, toggle-key chord breaking, single-vs-double-click timer skipping, and single `findAction` per keydown), `npm run e2e -- --spec e2e/specs/02-navigation.e2e.js`, `03-viewer.e2e.js`, `05-persistence.e2e.js`, `06-configuration.e2e.js` (add toggle-mode scroll-zoom latch persistence + statusbar indicator and Manhwa key-hold commit tests).

### S01-10 `[Blocking]` `src/js/services/actions.js`: Tauri/window leaks in pure service and duplicated handlers

- **Targets:** `src/js/services/actions.js:14-47,218-220,246-266,276-278,285-367`
- **Problem:**
  1. Pure `services/actions.js` accesses `window.__TAURI__`, `window.open`, and `window.close` directly inside `cmd-options` (`L219`), `cmd-hide-to-tray` (`L247`), `cmd-quit` (`L252-255`), `cmd-github` (`L261-265`), `cmd-open-explorer` (`L288-325`), and `cmd-open-folder` (`L331-365`).
  2. `cmd-next` (`L14-29`) and `cmd-prev` (`L31-46`) duplicate identical navigation branching and retain the dead `ctx.centerListItem` fallback (`L25,42`, R4).
  3. `cmd-open-explorer` and `cmd-open-folder` duplicate archive `|` pipe stripping and parent-directory regexes (`L295-296,319-320,339-341,353-356`, duplicating `parentOf` in `fsUtils.js:76-82`).
  4. `cmd-use-url` (`L276-278`) calls `ctx.UrlLoader?.openPrompt(payload)`, coupling `urlLoader.js` to `urlOverlay.js` (Sync C with S02/S05).
- **Agreed fix:**
  1. Inject shell and window capabilities through `ctx` (`openOptions`, `hideToTray`, `quitWindow`, `openExternalUrl`, `revealInExplorer`, `openFolderInExplorer`, `openUrlPrompt`) wired in `main.js`.
  2. Extract shared `navigateItem(ctx, payload, delta)` for `cmd-next`/`cmd-prev`, drop the dead `centerListItem` fallback (`L25,42`, updating `mocha/actions.test.js:171-184`, R4), and reuse `parentOf` / archive-pipe helper from `services/mediaFormats.js` in the explorer shell adapter.
  3. Preserve every `cmd-*` ID, `ACTION_REGISTRY`, `ACTION_MAP`, `CATEGORIES`, `DEFAULT_KEYBINDS`, and `dispatch(actionId, payload, ctx)` signature (locked by `mocha/diagnosticsContract.test.js`, `corePipelineProbe.js:19`, and `e2e/helpers/recorder-shim.js:350`).
- **Telemetry A/B:** `npm run mocha` (`mocha/actions.test.js` updated per R4 plus unit tests for injected `ctx` shell/explorer/URL actions; `mocha/diagnosticsContract.test.js` 100% green), `npm run diagnose -- sample-navigation` (confirm 0 `unknown-action` or `action-error` anomalies).

### S01-11 `[Blocking]` `src/js/services/archiveImageCache.js`: impure top-level side effects, corrupt-response caching, and double Blob revoke

- **Targets:** `src/js/services/archiveImageCache.js:2,27-57,76-105,132-194`
- **Problem:**
  1. Pure `services/` module imports `Core` (`L2`), reads `Core.getState().src` (`L44,143,152`), and registers top-level `Core.onStateChange` (`L164-188`) and `window.addEventListener('quivit-refresh-start')` (`L190-194`) on module import.
  2. `ensureArchiveBlob` (`L76`) runs `fetch(src).then(r => r.blob())` without checking `r.ok`, so HTTP 404/500 responses from `quivit://archive/` get cached as broken `blob:` URLs.
  3. `clearArchiveBlobCache()` (`L141-150`) manually revokes every Blob URL in a loop and then calls `_archiveBlobCache.clear()`, which invokes `_revokeBlobEntry` via `BoundedMap.clear()` (`cache.js:31-33`), revoking every Blob URL twice.
  4. `_archiveBlobCache` uses FIFO `BoundedMap` without recency promotion on `get()`, so flipping back and forth between hot archive pages can evict recently viewed entries.
- **Agreed fix:**
  1. Remove the `Core` import and module-load listeners; expose an explicit `initArchiveImageCache({ getActiveSrc, subscribeState, onRefresh })` (or factory) wired during bootstrap (Sync B with S02/S04/S06).
  2. Guard `if (!r.ok) return null;` in `ensureArchiveBlob`.
  3. Let `_archiveBlobCache.clear()` own revocation via `_revokeBlobEntry` (removing the duplicate manual revoke loop at `L141-149`), keeping `_activeViewerBlob` protected inside `_revokeBlobEntry`.
  4. Promote accessed keys on hit (LRU refresh) while enforcing both `ARCHIVE_BLOB_CACHE_CAPACITY` and `ARCHIVE_BLOB_CACHE_MAX_BYTES`.
- **Telemetry A/B:** `npm run mocha` (add `mocha/archiveImageCache.test.js` testing `!r.ok` rejection, single `URL.revokeObjectURL` per evicted/cleared entry, `_activeViewerBlob` retention, LRU recency, byte/entry limits, and generation abort), `npm run e2e -- --spec e2e/specs/04-archives.e2e.js`.

### S01-12 `[Warning]` `src/js/services/keybindDomain.js`: misplaced UI color math and unnormalized conflict map

- **Targets:** `src/js/services/keybindDomain.js:32-47,49-58`
- **Problem:** `computeSlotHue` (`L32-47`) is UI/strip color math re-exported by `src/js/services/viewerMath.js:2` and unrelated to keybind validation. `getConflictColors` (`L53-56`) keys `comboToActions` by raw `combo` without `normalizeCombo(combo)`, inconsistent with `comboUsedByOtherAction` (`L14-16`).
- **Agreed fix:** Move `computeSlotHue` into `services/viewerMath.js` (or a shared neutral helper imported by both `keybindDomain.js` and `viewerMath.js`, Sync B with S06) and normalize every combo in `getConflictColors` via `normalizeCombo`.
- **Telemetry A/B:** `npm run mocha` (add `mocha/keybindDomain.test.js` covering `validateKeybindSafety`, `hasUsableMenubarBind`, `isLockedBinding`, and case/alias normalization in `getConflictColors`; preserve `computeSlotHue` assertions in `mocha/viewerMath.test.js`).

### S01-13 `[Warning]` `src/js/services/keyCombo.js`: ignored `config` parameter and hot-path allocations

- **Targets:** `src/js/services/keyCombo.js:61-108`
- **Problem:** `findAction(config, combo)` (`L104-108`) takes `config` and ignores it, reading only module-global `_bindMap` (silent `null` if `rebuildBindMap` was not called first). `rebuildBindMap` (`L95-100`) lowercases without `normalizeCombo`. `formatKeysCombo` (`L61-87`) allocates a fresh `modifiers` array and maps `keysSet` on every keydown, wheel, and mousedown event.
- **Agreed fix:** Cache bind maps per `config.frontend_data.keybinds` reference via `WeakMap` inside `findAction` (keeping `rebuildBindMap` compatible for explicit invalidation), hoist `MODIFIER_KEYS` to a module-scope `Set`, consolidate `keybindTokenToActiveKey` and `getScrollModifierKeys` from `shortcuts.js`, and preserve the locked `normalizeCombo` token-order contract (`mocha/actions.test.js:58-59`).
- **Telemetry A/B:** `npm run mocha` (add `mocha/keyCombo.test.js` covering `findAction` with fresh configs, `rebuildBindMap`, `formatKeysCombo`, `getScrollModifierKeys`, and `mocha/actions.test.js` locked `normalizeCombo` assertions).

### S01-14 `[Warning]` `src/js/services/sorting.js`: regex allocations in `naturalCompare` and duplicated archive extensions

- **Targets:** `src/js/services/sorting.js:1-31,104-106`
- **Problem:** `naturalCompare(a, b)` (`L1-11`) allocates two arrays (`ax`, `bx`), runs two `.replace(/(\d+)|(\D+)/g, ...)` passes, and calls `localeCompare` on every pairwise comparison (`O(N log N)` per sort). Benchmarked in Node on 2,000 filenames, `applySort` takes **21.82 ms** vs **2.23 ms** with a module-scoped `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })` (9.8x faster). `compareNames` (`L24-31`) also recomputes `hasArchiveEntryPath`, `isNestedArchiveEntry`, and `.toLowerCase()` inside every comparison. `SAVED_ARCHIVE_EXTS` (`L104-106`) duplicates `SUPPORTED_ARCHIVES` from `fsUtils.js:19`.
- **Agreed fix:** Replace per-comparison regex parsing with precomputed per-item sort keys (Schwartzian transform) backed by either a cached `Intl.Collator` or pre-tokenized numeric/text chunks once Telemetry A edge-case parity tests (leading zeros `01` vs `1`, underscores/hyphens, mixed CJK/ASCII, archive root-before-nested) confirm exact ordering. Replace `SAVED_ARCHIVE_EXTS` with `SUPPORTED_ARCHIVES` from `services/mediaFormats.js`.
- **Telemetry A/B:** `npm run mocha` (expand `mocha/sorting.test.js` with edge-case natural-sort parity fixtures plus a 2,000-entry sort timing check targeting >= 5x speedup).

### S01-15 `[Blocking]` `src/js/shared/themePrePaint.js` and `src/js/shared/theme.js`: duplicate `#custom-css` node, scattered `localStorage` writes, and N-window IPC fan-out

- **Targets:** `src/js/shared/themePrePaint.js:1-13`, `src/js/shared/theme.js:1-32` (coordinated with `src/index.html:14-15`, `src/options.html:13-14`, `src/metadata.html:9-10`)
- **Problem:**
  1. All three HTML pages load `<script src="/js/shared/themePrePaint.js"></script>` before `<style id="custom-css"></style>`. When `quivit-custom-css` exists in `localStorage`, `themePrePaint.js:7-10` creates `<style id="custom-css">` in `<head>`, and the HTML parser immediately creates a second `<style id="custom-css">` after it, producing duplicate IDs on every page and breaking HTML-first rendering.
  2. `quivit-theme` and `quivit-custom-css` `localStorage` cache writes are duplicated across `main.js:414-417` (S02), `options.js:141-142,360-366,580-583` (S03), and `configPreview.js:39` (S01).
  3. `applyTheme` (`theme.js:12-15`) invokes `update_theme` from every window, even though `src-tauri/src/windows.rs:109-111` already applies the native theme to all webviews. When `storage` fires on theme save, each secondary window triggers a redundant `update_theme` IPC fan-out.
- **Agreed fix:**
  1. Place static `<style id="custom-css"></style>` before `<script src="/js/shared/themePrePaint.js"></script>` in `index.html` (S02), `options.html` (S03), and `metadata.html` (S03) (R3, Sync A). Update `themePrePaint.js` to populate `document.getElementById('custom-css').textContent = c` with zero `createElement`.
  2. Add `syncThemeStorage(theme, customCss)` in `shared/theme.js` as the sole writer for `quivit-theme` and `quivit-custom-css` (never called during live `theme-preview` or `css-preview`, Sync D).
  3. Add `{ syncNative = true }` (or owner-window gating) to `applyTheme(theme, options)` so secondary windows reacting to `storage` or `theme-preview` skip redundant `update_theme` IPCs.
- **Telemetry A/B:** `npm run mocha` (add static HTML contract check verifying `<style id="custom-css">` precedes `themePrePaint.js` in all three HTML files, plus unit tests for `syncThemeStorage` and `applyTheme({ syncNative: false })`), `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js` (assert `document.querySelectorAll('#custom-css').length === 1` when custom CSS is saved).

### S01-16 `[Warning]` `src/js/shared/configPreview.js`: `emergencyCssReset` state/IPC races and mutable export

- **Targets:** `src/js/shared/configPreview.js:4-8,32-53`
- **Problem:**
  1. `emergencyCssReset` (`L37-53`) sets `previewing = false` (`L38`), then calls `resetPreviewCss()` (`L40`), which sets `previewing = true` and emits `css-preview: ''` without emitting `preview-cleared`, leaving peer windows stuck in preview mode until `config-updated` arrives.
  2. `L46` calls `emit('config-updated')` without `await` immediately before `window.location.reload()` (`L52`), risking context teardown before the IPC event is sent.
  3. `L45` saves the caller's `config` object directly. Triggered from Options (`options.js:36`), this can persist unsaved edits alongside clearing `custom_css`.
  4. `resetPreviewCss` (`L32`) is exported with zero external callers, and `export let previewing` (`L4`) exposes mutable module state.
- **Agreed fix:** Load the latest saved config (or patch only `custom_css = ''` before saving), clear `quivit-custom-css` via `shared/theme.js:syncThemeStorage`, emit `preview-cleared`, `await` all Tauri `emit(...)` calls before `window.location.reload()`, unexport `resetPreviewCss`, and expose `isPreviewing()` instead of mutable `export let previewing` (Sync D with S03 `options.js`).
- **Telemetry A/B:** `npm run mocha` (add `mocha/configPreview.test.js` testing `isPreviewing()`, `revertPreviewChanges`, and `emergencyCssReset` await ordering and CSS-only patch), `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js`.

### S01-17 `[Warning]` `src/js/shared/windowFit.js`: inline `.style.width` violation and unguarded backend fit caps

- **Targets:** `src/js/shared/windowFit.js:4-5,14-23,35-38`
- **Problem:** `fitContentWidth` (`L15-18`) writes `tabs.style.width = 'fit-content'` inline, breaking the `AGENTS.md` CSS source-of-truth rule. `OPTIONS_MAX_INITIAL_W = 560` and `META_MAX_INITIAL_H = 600` mirror dead `#[allow(dead_code)]` constants in `src-tauri/src/windows.rs:51,61`, while Rust accepts arbitrary width/height values without clamping.
- **Agreed fix:** Replace `tabs.style.width` manipulation with `tabs.classList.add('is-measuring-width')` / `remove('is-measuring-width')` backed by `.tabs.is-measuring-width { width: fit-content; }` in `src/css/options.css` (R3, Sync A/D with S03). Keep locked caps aligned with S08 `windows.rs` server-side clamps (`400..=560` for Options, `280..=600` for Metadata, Sync D).
- **Telemetry A/B:** `npm run mocha` (verify zero `.style.` writes in `windowFit.js`), `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js` (Options and Metadata initial fit dimensions), `cargo test --manifest-path src-tauri/Cargo.toml windows` (clamping unit tests via S08).

### S01-18 `[Warning]` `src/js/shared/workspaceControls.js`: DOM/Tauri reach-in, per-state strip-info IPC chatter, and remote return race

- **Targets:** `src/js/shared/workspaceControls.js:47-68,91-105,136,144-145,159,169-178`
- **Problem:**
  1. `restoreFocus` (`L96`) reaches into `#viewport` via `document.getElementById('viewport')?.focus()` instead of using an injected `focusViewport` callback (contrast `focusFileList` at `L14`), and `L101,136,144-145` invoke `window.__TAURI__` focus APIs directly.
  2. `Core.onStateChange` (`L169-178`) calls `publishStripInfo()` on every state change, dispatching `quivit-workspace-strip-info` (and forwarding over IPC via `workspaceSession.js:295-298`) even when Manhwa mode is off or visible indices have not changed.
  3. `handleRevealListTop` (`L62-64`) unconditionally sets `remoteFileListAtTop = true` when the RPC resolves, ignoring the remote boolean return value.
  4. `L159` exposes every function property on `UrlLoader` via `Object.entries(UrlLoader)` instead of an explicit RPC allowlist.
- **Agreed fix:** Inject `focusViewport` and window-focus adapters from `main.js`; gate `publishStripInfo` on `manhwaEnabled`, active peer presence, and shallow array equality with the previous indices; assign `remoteFileListAtTop = result === true` in `handleRevealListTop`; and replace `Object.entries(UrlLoader)` with an explicit method allowlist (`Sync C` with S05).
- **Telemetry A/B:** `npm run mocha` (add `mocha/workspaceControls.test.js` covering owner routing, `publishStripInfo` deduplication, `handleRevealListTop` remote boolean handling, and `UrlLoader` allowlist), `npm run e2e -- --spec e2e/specs/02-navigation.e2e.js` (detached `?surface=fileList` focus and strip sync).

### S01-19 `[Warning]` `src/js/shared/workspaceSession.js`: per-notification `JSON.stringify(config)`, leaked pending RPCs on close, and ready-handshake hang

- **Targets:** `src/js/shared/workspaceSession.js:96-106,146-152,157-173,232-234,253-256,281-287,293-295`
- **Problem:**
  1. `publish` (`L160`) runs `JSON.stringify(state.config)` across the entire config object (keybinds, favorites, directory sort, custom CSS) on every `Core.onStateChange` whenever a detached window is open. `rememberConfig` / `configPatch` (`L96-106`) also re-serializes every `frontend_data` key on every snapshot and persist.
  2. When the detached File List closes (`workspace-detached-closed`), `forgetWorkspacePeer(label)` (`L232-234`) removes the peer from `peers` without rejecting in-flight `pending` RPCs targeting `label`, leaving callers blocked for up to 30 seconds (`REQUEST_TIMEOUT_MS`).
  3. `initWorkspaceSession` (`L281-286`) sends one `ready` message and waits 30 seconds with no retry if the host listener mounts late.
  4. `execute` for `config.persist` (`L146-152`) forces an immediate `Core.flushConfig()` regardless of `args[0]` debounce options and dispatches `quivit-favorites-changed` directly inside the RPC layer.
- **Agreed fix:**
  1. Compare `state.configVersion` (integer from `S01-01`) in `publish` instead of `JSON.stringify(state.config)` (O(1) change check).
  2. Track `target` on each `pending` entry and reject all entries targeting `label` immediately inside `forgetWorkspacePeer(label)`.
  3. Add bounded `ready` retries (for example every 250 ms up to a 5 s cap) before failing open in `initWorkspaceSession`.
  4. Respect `args[0]` (`{ immediate, debounceMs }`) in `config.persist` instead of forcing an unconditional flush, centralize the forwarded event list as a named constant, and keep `quivit-favorites-changed` notification owned by the favorites store or config subscriber.
- **Telemetry A/B:** `npm run mocha` (add `mocha/workspaceSession.test.js` testing `configVersion` delta skipping, `forgetWorkspacePeer` immediate rejection of peer-targeted pending requests, bounded `ready` retries, `MAX_PENDING_REQUESTS`, and `config.persist` debounce forwarding), `npm run e2e -- --spec e2e/specs/05-persistence.e2e.js` (detached `?surface=fileList` open, sort, persist, close lifecycle).

## Cohesive files

Five S01 files are clean under `AGENTS.md` and `validate-changes` rules and require no structural refactoring:

1. **`src/js/services/cache.js` (51L):** Pure `BoundedMap` and `BoundedSet` classes with zero DOM or Tauri dependencies. Add missing `BoundedSet` unit tests to `mocha/cache.test.js`, and optionally add a small LRU touch helper if `S01-11` (`archiveImageCache.js`) reuses it.
2. **`src/js/services/workspaceLayout.js` (52L):** Pure layout normalization and dock/detach transitions. Minor hygiene: remove the unused `surface` parameter from `dockWorkspaceSurface(layout, surface)` at `L48`, and add unit tests in `mocha/workspaceLayout.test.js`.
3. **`src/js/shared/clipboard.js` (25L):** Isolated async clipboard wrapper with safe error fallback.
4. **`src/js/shared/workspaceHost.js` (28L):** Focused `hostsWorkspaceSurface` helper and `ViewportCore` proxy for detached `?surface=fileList`. Minor hygiene: guard `window.location.search` at `L4` for Node/Mocha imports and add tests in `mocha/workspaceHost.test.js`.
5. **`src/js/shellBackground.js` (81L):** Focused native window background mirror. Verified `#measure-probe` exists in `src/index.html:530`, `src/options.html:724`, and `src/metadata.html:39`.

## Cross-split seams and locked contracts

All S01 boundary touches were ratified in the cross-split seam matrix (`#116`, `#126`, `#132`):

- **Sync A (`index.html`, `options.html`, `metadata.html`, `options.css`):** `<style id="custom-css"></style>` moves before `<script src="/js/shared/themePrePaint.js"></script>` across all three HTML documents (R3, S02/S03). `options.css` adds `.tabs.is-measuring-width { width: fit-content; }` for `windowFit.js` (R3, S03).
- **Sync B (`viewerMath.js`, `viewerGestures.js`, `viewerAudio.js`, `menubar.js`, `statusbar.js`):** `services/configSchema.js` eliminates `viewerMath.js:1 -> ../keybinds.js`. `computeSlotHue` moves to `viewerMath.js` (S06). `shortcuts.js` drops `menubar.js`/`statusbar.js` reach-in (S02) and preserves `activeKeys` compatibility while S06 migrates `viewerGestures.js`. `actions.js:25,42` removes `centerListItem` and `fsUtils.js:429-432` removes `buildAudioSrc` in lockstep with S06 (R4). `archiveImageCache.js` exposes explicit bootstrap wiring (S02/S04/S06).
- **Sync C (`urlLoader.js`, `urlOverlay.js`):** `actions.js:277` routes `cmd-use-url` via `ctx.openUrlPrompt`, and `workspaceControls.js:159` whitelists explicit `UrlLoader` RPC methods (S02/S05).
- **Sync D (multi-window, `localStorage`, config, `windows.rs`):** `Core` adds `setStatusBarVisible`, `setScrollZoomLatched`, `applyDirectorySort` (`CORE_SESSION_METHODS`), and `configVersion`. `shared/theme.js:syncThemeStorage` becomes sole writer of `quivit-theme` and `quivit-custom-css` (never written during preview). `core.js:25` updates `options-active-tab` to `sessionStorage` owned by `options.js` (R4). `configPreview.js` exposes `isPreviewing()`. `windowFit.js` locks `400..=560` and `280..=600` clamps with `src-tauri/src/windows.rs` (S08). `services/keyCombo.js` is reused by `main/fullscreen.js:49-57` (S02). Roaming vs portable `STATE_KEYS` (`src-tauri/src/config.rs:368`) stay untouched.
- **Sync E/F (`models.rs`, `commands/directory.rs`, `quivit://`, `manhwaStrip.js`):** `DirectoryReadResult` adds backward-compatible `has_gallery_sidecar: bool` (S08/S10). `mediaUrls.js` preserves exact `quivit://` and `http://quivit.localhost` `/archive/`, `/thumb/`, `/icon/`, and `/tiff/` URL shapes. `FsUtils` adds `cancelWidthScan()` wrapper for S06.
- **Locked contracts:** All `cmd-*` IDs, `ACTION_REGISTRY`, `ACTION_MAP`, `CATEGORIES`, `DEFAULT_KEYBINDS`, `dispatch` (`mocha/diagnosticsContract.test.js`, `e2e/replay-diagnostics/probes/corePipelineProbe.js:19`, `e2e/helpers/recorder-shim.js:350`), `Core.{getState,onStateChange,navigate,persistConfig}` (`corePipelineProbe.js:57`, `recorder-shim.js:345`), `normalizeCombo` token-order behavior (`mocha/actions.test.js:58-59`), and `CORE_SESSION_METHODS` / `FS_SESSION_METHODS`.

## Telemetry A and B plan

| Suite | Command | Existing coverage | Telemetry A additions (pre-refactor baseline) | Telemetry B assertions (post-refactor proof) |
|---|---|---|---|---|
| **Mocha** | `npm run mocha` | `actions.test.js`, `cache.test.js`, `core.test.js`, `sorting.test.js`, `diagnosticsContract.test.js`, `viewerMath.test.js` (308 passing) | Add unit suites for pure `fsUtils` helpers (`mediaFormats`, `mediaUrls`, `listNavigation`), `navigationHistory`, `directoryPrefs` (cap 100, immutability, bounded reconcile), `archiveImageCache` (`!r.ok`, single revoke, LRU, active blob), `keybindDomain`, `keyCombo`, `cache.BoundedSet`, `workspaceLayout`, `workspaceHost`, `workspaceSession` (`configVersion`, `forgetWorkspacePeer`, `ready` retry), `workspaceControls`, `configPreview`, `theme` (`#custom-css` order + `syncThemeStorage`), plus `sorting.js` edge-case parity fixtures and 2,000-entry baseline timings for `applySort`, `naturalPagePosition`, and `_formatDate`. | Remove `globalThis.window` / `__TAURI__` stubs from pure Mocha tests (`viewerMath.test.js`, `core.test.js`, `sorting.test.js`), update `mocha/actions.test.js:171-184` per R4, verify 0 `diagnosticsContract.test.js` regressions, verify >= 5x `applySort` speedup, O(1) `naturalPagePosition` repeat lookups, and >= 10x `_formatDate` speedup. |
| **Desktop E2E** | `npm run e2e -- --spec e2e/specs/<spec>.e2e.js` | `01-startup`, `02-navigation`, `03-viewer`, `04-archives`, `05-persistence`, `06-configuration`, `07-os-integration` | Add specs covering detached `?surface=fileList` (snapshot, column sort RPC, focus restore, clean close), `scroll_zoom_modifier = 'toggle'` latch persistence + statusbar indicator, Manhwa key-hold commit, Options/Metadata `windowFit` initial bounds, and single `#custom-css` element when custom CSS is configured. | 100% pass across `01` through `07` plus new detached, latch, `windowFit`, and `#custom-css` parity checks. |
| **Replay diagnostics** | `npm run diagnose -- <scenario>` | `sample-navigation`, `filter-navigation`, `manhwa-buffer` (`corePipelineProbe.js`, `ipcProtocolProbe.js`) | Capture baseline JSON on `sample-navigation`, `filter-navigation`, and `manhwa-buffer` recording startup/folder-open IPC counts, `gallery.json` error counts, and navigation swap latency. | Zero `unknown-action`, `action-error`, or `ipc-error` anomalies (`gallery.json` read errors drop to 0 on non-gallery folders), lower folder-open and navigation-swap latency, and intact `corePipelineProbe` state diffs. |
| **Rust cargo tests** | `cargo test --manifest-path src-tauri/Cargo.toml <filter>` | `config_tests` (roaming vs portable `STATE_KEYS`), `directory` tests | Read-only seam check before S08/S10 edits; verify `has_gallery_sidecar` and `windows.rs` fit clamps once added by S08/S10. | Zero regressions on roaming/portable `STATE_KEYS`, `DirectoryReadResult.has_gallery_sidecar`, and `fit_options_window` / `fit_metadata_window` clamps. |
