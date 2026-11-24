# Cross-split seams and telemetry matrix

This document records the ratified Stage 3 Step 4 consensus across all 11 splits (`S01` through `S11`) on branch `refactor/decoupling-and-perf`. Every split lead verified the live code targets and voted `[Agree]` on the consolidated matrix (`#116`, ratified in `#118` to `#121`, `#123` to `#126`, `#128`, `#130`, `#131`).

## Ratification ledger

| Split | Lead | Seam proposal | Step 4 vote | Audit file |
|---|---|---|---|---|
| S01 `fe-core-fs-workspace` | `s01-state-arch` | `#59` | `[Agree]` `#126` | `audit-01-fe-core-fs-workspace.md` |
| S02 `fe-main-chrome-css` | `s02-html-css` | `#54` | `[Agree]` `#125` | `audit-02-fe-main-chrome-css.md` |
| S03 `fe-options-metadata` | `s03-options-perf` | `#66` | `[Agree]` `#123` | `audit-03-fe-options-metadata.md` |
| S04 `fe-filepanel` | `s04-panel-perf` | `#68` | `[Agree]` `#124` | `audit-04-fe-filepanel.md` |
| S05 `fe-urlloader` | `s05-loader-arch` | `#74` | `[Agree]` `#130` | `audit-05-fe-urlloader.md` |
| S06 `fe-viewer-strip` | `s06-strip-perf` | `#78` | `[Agree]` `#131` | `audit-06-fe-viewer-strip.md` |
| S07 `fe-viewer-webgl` | `s07-gpu-perf` | `#91` | `[Agree]` `#128` | `audit-07-fe-viewer-webgl.md` |
| S08 `be-core-windows-config` | `s08-config-windows` | `#88` | `[Agree]` `#118` | `audit-08-be-core-windows-config.md` |
| S09 `be-media-archives-protocol` | `s09-protocol-perf` | `#101` | `[Agree]` `#120` | `audit-09-be-media-archives-protocol.md` |
| S10 `be-fs-library-network-drop` | `s10-io-arch` | `#105` | `[Agree]` `#119` | `audit-10-be-fs-library-network-drop.md` |
| S11 `be-previews-registry` | `s11-com-systems` | `#113` | `[Agree]` `#121` | `audit-11-be-previews-registry.md` |

## Ratified cross-split resolutions (R1 to R7)

**R1. Keep DevTools enabled in release builds (`S08`, `S11`).**
`README.md:150` states that Developer Tools stays enabled so users can inspect elements and debug custom CSS. S08 keeps `"devtools"` in `src-tauri/Cargo.toml:25` and `.devtools(true)` on app windows in `src-tauri/src/lib.rs:80` and `src-tauri/src/windows.rs:147,251,295`. Only the Windows Explorer preview pane at `src-tauri/src/platform/previews/windows/image_pane.rs:415` stays gated on `cfg!(debug_assertions)`. S08 still removes the unused `encoding_rs = "0.8"` direct dependency at `src-tauri/Cargo.toml:44`.

**R2. Complete CSP directives in `tauri.conf.json` (`S08`, `S01` to `S07`, `S09`).**
Replacing `"csp": null` at `src-tauri/tauri.conf.json:12` requires explicit directives that cover every runtime fetch, media load, dynamic extractor, and WASM worker:
- `connect-src`: `'self' ipc: http://ipc.localhost quivit: http://quivit.localhost asset: http://asset.localhost https://asset.localhost blob: data:` (required by `textureCache.js`, `blobImage.js`, and `fsUtils.js` `fetch()` calls).
- `img-src` and `media-src`: `'self' quivit: http://quivit.localhost asset: http://asset.localhost https://asset.localhost blob: data:`.
- `style-src`: `'self' 'unsafe-inline'` (required by `#custom-css`).
- `script-src` and `worker-src`: `'self' blob: 'wasm-unsafe-eval'` (required by `urlLoader.js` dynamic `Blob` URL extractors and `src/js/vendors/pica.js` WASM workers).
- Keep `assetProtocol` enabled (`src-tauri/tauri.conf.json:13-16`, `src-tauri/Cargo.toml:25`). In `src-tauri/capabilities/default.json`, keep `core:window:allow-set-background-color` (`:12`, called by `shellBackground.js:57`) and `core:window:allow-start-dragging` (`:16`, used by `index.html:206` `data-tauri-drag-region`), and prune only unused `dialog:allow-confirm`, `dialog:allow-message`, and `dialog:allow-ask` (`:21-23`).

**R3. Dead viewer placeholder removal and Options tab measurement class (`S01`, `S02`, `S03`, `S06`).**
- Delete dead `#viewer-loading-frame` (`src/index.html:398`) and dead `.viewer-img.is-placeholder` (`src/css/global.css:274-276`) instead of moving `.viewer-img.is-placeholder` into `viewer.css`. Live grep confirms zero activations across `src/`; `viewerRender.js:21,299,567` only skips it.
- S03 adds `.tabs.is-measuring-width { width: fit-content; }` to `src/css/options.css` so S01's `src/js/shared/windowFit.js:15-18` stops setting inline `tabs.style.width = 'fit-content'`.

**R4. Viewer, shortcut, and diagnostic probe alignment (`S01`, `S06`, `S07`).**
- S01 removes the `centerListItem` fallback at `src/js/services/actions.js:25,42`, updates `mocha/actions.test.js:171-184` to test `alignListItemTop`, deletes dead `FsUtils.buildAudioSrc` (`src/js/fsUtils.js:429-432`, sole caller `viewerAudio.js:157`) once S06 removes `<audio id="viewer-audio">`, and updates the `options-active-tab` persistence note at `src/js/core.js:25` to `sessionStorage`.
- S01 keeps `activeKeys` (or a read-only `hasActiveShortcutKeys()` helper) compatible while S06 migrates `src/js/viewer/viewerGestures.js:2,137` away from the `activeKeys` + `setTimeout(0)` race to injected callbacks and `[data-ui]`.
- S06 and S07 execute the `computeColumnComposite` rect cleanup atomically: standardize on `{ x, y, width, height }` and `drawList`, dropping `sx/sy/sw/sh`, `dx/dy/dw/dh`, and `draws` aliases across `src/js/services/viewerMath.js` (S06), `src/js/viewer/viewerPipelines.js:38-52` and `src/js/services/pipelines/quadCompositor.js:39-42,66-76,105-108` (S07), and `mocha/viewerMath.test.js:836-937` (Telemetry B).
- S06 owns three diagnostic probe actions:
  1. In Telemetry A, update `e2e/replay-diagnostics/probes/viewerPipelineProbe.js:19-20` to parse `calc(-50% + <num>px)` in addition to raw pixel values. Keep `viewerMath.js:699` transform formatting unchanged so `ty-teleport` (`:244`) stops evaluating `NaN`.
  2. Fix `src/js/viewer/manhwaStrip.js:657-670` to write `--strip-spacer-top` and `--strip-spacer-bottom` directly on `#manhwa-strip-spacer-top` and `#manhwa-strip-spacer-bottom` so `viewerPipelineProbe.js:26-27` reads real spacer heights without modifying the probe.
  3. In Telemetry B, update `mocha/diagnosticsContract.test.js:68-98` so its literal source checks cover extracted `src/js/viewer/manhwa/{stripPool,stripDecodeQueue,stripLayout}.js` and `src/js/viewer/viewerBridge.js` alongside `manhwaStrip.js` and `viewerRender.js`.

**R5. Disjoint Rust module layout and watcher `.tmp` filter (`S08`, `S09`, `S10`, `S11`).**
- `src-tauri/src/commands/mod.rs` adds three disjoint modules: `commands/config.rs` (S08, 8 commands from `config.rs`), `commands/windows.rs` (S08, 11 active commands from `windows.rs`), and `commands/icons.rs` (S11/S09, `get_native_icon` and `invalidate_native_icon_cache` relocated from `commands/registry.rs:33-45`).
- `src-tauri/src/commands/library.rs` (S10) receives `get_library_dir` and `get_default_library_dir` relocated out of `commands/shell.rs:69-82` (S08), calling pure `config::configured_library_dir` and `config::default_library_dir`.
- `src-tauri/src/platform/mod.rs` adds three disjoint `#[cfg(windows)]` modules: `platform/gdi.rs` (S09, shared Win32 GDI RAII and DIB/PNG helpers, optionally reused by S11 `bitmap.rs`/`archive_render.rs`), `platform/associations.rs` (S11, ~550 lines of registry/association logic from `commands/registry.rs`), and `platform/shell.rs` (S08 `open_uri` from `commands/shell.rs:18-45` plus S10 `move_to_recycle_bin` from `commands/directory.rs:440-474`, upgraded to `IFileOperation` with permanent-delete fallback kept).
- S10 adds two domain modules at crate root: `src-tauri/src/library.rs` (library locks, write guards, capture publish, tree scan, and relocation, removing `config.rs:639`, `lib.rs:90`, and sibling `commands/*` reach-ins) and `src-tauri/src/network.rs` hosting `crate::network::DownloadCancelFlag` (`cancel_all()`, `cancel_scope(scope)`, `token(scope)`) alongside extracted network/descramble/magic domain logic (confirmed in `#119`, removing `lib.rs:64` and `library.rs:741` reach-ins into `commands::network`).
- S08 updates `src-tauri/src/commands/watchers.rs` (`watch_directory` and `create_library_watcher`) to ignore `.tmp` sibling files so S10's same-volume `.tmp` staging in `download_to_file` never emits premature `directory-changed` or `library-changed` events.

**R6. Dead IPC removals (72 total to 68 active, 4 removed) (`S08`, `S09`, `S11`).**
Verified zero callers across `src/`, `mocha/`, and `e2e/` for four registered commands:
1. `show_from_tray` (`src-tauri/src/windows.rs:488`, `lib.rs:147`, S08): remove command and registration.
2. `drop_all_archives_cache` (`src-tauri/src/commands/archives.rs:35`, `lib.rs:109`, S09): remove command and registration; keep `ArchiveCache::drop_all_archives()` for `lib.rs:200` `RunEvent::Exit`.
3. `get_preview_diagnostics` (`src-tauri/src/commands/registry.rs:113`, `lib.rs:139`, S11): remove command, registration, unused `models::PreviewDiagnostic` (`models.rs:111-148`, S08), and `previews::host::staged_host_info` (`host.rs:318`, S11).
4. `register_associations` (`src-tauri/src/commands/registry.rs:427`, `lib.rs:142`, S11): remove IPC command and registration; keep internal `register_associations_impl` inside `platform/associations.rs` (`associationsUi.js:60` calls `apply_associations`).

All 68 remaining IPC commands keep exact names and JSON shapes, with two backward-compatible additions: `DirectoryReadResult.has_gallery_sidecar: bool` (`models.rs`, S01/S08/S10) and optional `cancel_scope: Option<String>` on `download_to_file` and `cancel_download` (S05/S10).

**R7. `lib.rs` wildcard removal and `#[path]` test mounts (`S08`, `S09`, `S10`).**
- Move `lib.rs:208-218` test mounts into their owner modules: `tests/archive_tests.rs` into `archives/mod.rs`, `tests/format_tests.rs` into `formats/mod.rs`, and `tests/temp_archive_tests.rs` into `platform/temp_archive.rs` (`#[path = "../tests/temp_archive_tests.rs"]`, dropping ~18 widened `pub` symbols).
- Re-export `acquire_temp_lock`, `cleanup_orphaned_temp_dirs`, and `cleanup_current_temp_dir` from `archives/mod.rs` and make `mod cache;` private (`lib.rs:98-99,203` switches from `crate::archives::cache::*` to `crate::archives::*`).
- Remove wildcard `use archives::*; use commands::*; use config::*; use windows::*;` at `lib.rs:17-20` in favor of explicit command paths inside `tauri::generate_handler!`.
- Migrate all 23 inline `#[cfg(test)]` tests (`platform/attributes.rs` 1, `commands/directory.rs` 5, `commands/library.rs` 1, `commands/network.rs` 16) into `src-tauri/src/tests/*.rs` via `#[path]`.

## Sync gates A to F

### Sync A: main HTML, CSS, templates, and CSP

Owners: S02 (host) with S01, S03, S04, S06, S07, S08.

- **`<head>` cascade order and single `#custom-css`.** `src/index.html` links CSS in this order: `global.css`, `main.css` (workspace/shell), `menubar.css`, `statusbar.css`, `overlays.css`, `file-panel.css` (S04), `viewer.css` (S06/S07), then static `<style id="custom-css"></style>`, then `<script src="/js/shared/themePrePaint.js"></script>`. `src/options.html:13-14` and `src/metadata.html:9-10` also place `<style id="custom-css"></style>` before `themePrePaint.js`. `themePrePaint.js` (S01) writes directly to `document.getElementById('custom-css').textContent`, ending duplicate `#custom-css` element injection.
- **Global CSS relocations.** `src/css/global.css` retains the `--fs-*` typography scale and all 22 theme tokens matching `themes/*.css` (adding `--danger` parity to `:root[data-theme="dark"]`). Move `.assoc-mascot-svg` and `.assoc-mascot-box.is-active .assoc-format-icon` (`global.css:127-130,166-169`) into `src/css/options.css` (S03) with the missing `:root:not([data-theme="light"])` dark-mode guard. Move `--panel-*`, `--resize-handle-w`, `--col-*`, and `--file-grid-cols` (`global.css:43-53`) into `src/css/file-panel.css` (S04), scoping `--col-*-w` and `--file-grid-cols` to `#file-panel` and keeping `--panel-w`/`--panel-h` on `#workspace`. Delete `.viewer-img.is-placeholder` (`global.css:274-276`) per R3.
- **Static markup and `<template>` additions.**
  - `src/index.html` (S04): add `#file-list-row-template`, `#saved-entry-row-template`, and `#library-provider-template`; keep `.scroll-spacer` (`:269`) and `#file-panel-favorites-header` (`:226`).
  - `src/index.html` (S06): add `#manhwa-slot-template` and `#ico-container-template` / `#ico-size-template`; expand static `.viewer-img` pool from 2 (`:403-404`) to 4; delete dead `#viewer-loading-frame` (`:398`) and `<audio id="viewer-audio">` (`:419`).
  - `src/index.html` (S07): zero new templates; preserve `#viewer-lanczos-canvas`, `#viewer-svg-pump`, `#viewer-filter-canvas`, `#manhwa-filter-canvas`, `#manhwa-svg-pump-layer`.
  - `src/options.html` (S03): add `<template>` for `.keybind-tag`/`.add-btn`, delete 5 orphaned `cmd-window-viewport-*` slots (`:390-406`) and duplicate `id="workspace-keybind-note"` (`:365,387`), move `#measure-probe` (`:724`) out from between `<script>` tags, and add `data-manual` or lazy load for `prism.min.js` (`:722`).
  - `src/metadata.html` (S03): add static 7-role credit slots or `<template>` for `metadata-window.js`.
- **Vendor script loading.** Defer or lazy-load `src/js/vendors/pica.js` (`index.html:531`, coordinated with S07 `lanczos.js`) and `src/js/vendors/purify.min.js` (`index.html:532`, coordinated with S05 `urlloader/networkClient.js`).
- **CSP and capabilities.** Apply R2 in `src-tauri/tauri.conf.json:12` and `src-tauri/capabilities/default.json:21-23`.

### Sync B: viewer, WebGL, probes, statusbar, and keybinds

Owners: S06 and S07 with S02 and S01.

- **Pure-layer boundary.** S01 extracts config defaults (`DEFAULT_FIT_MODE`, `DEFAULT_SCALING_MODE`, etc.) and `mergeConfig` into `src/js/services/configSchema.js` so `src/js/services/viewerMath.js:1` (S06) drops its reverse-layer import `../keybinds.js`. S01/S06 relocate `computeSlotHue` (`keybindDomain.js:32-47`) and `mirroredGrillAngle` (`icoCells.js:10-12`, compat re-export for `mocha/viewerMath.test.js:997`) into `viewerMath.js`.
- **Single-writer Statusbar and grill ownership.** `src/js/menubar/statusbar.js` (S02) becomes self-subscribing to `Core` and media/scroll state, removing imperative `Statusbar.*` calls from `viewerRender.js` (S06, 15 callsites), `manhwaStrip.js:1836` (S06), and `shortcuts.js:124,263,286` (S01). `#img-grill`, `#img-grill-border`, `#viewer-img-wrapper.grill-active`, and `#manhwa-strip.grill-active` ownership moves from `main.js:195-197,215-226` (S02) into `viewerRender.js` and `manhwaStrip.js` (S06).
- **Bootstrap and replay runner parity.** S06 exposes explicit `initViewer()` gated by `hostsWorkspaceSurface('viewport')` (removing eager import side effects in detached `?surface=fileList` and duplicate `main.js:262` `initManhwaStrip()`) while preserving `Viewer` named export for `e2e/replay-diagnostics/runner.e2e.js:342`. S02 adds `export const Chrome = { ... }` in `src/js/menubar/chrome.js`, fixing `runner.e2e.js:344` where `Chrome` currently imports as `undefined`.
- **Viewer to WebGL pipeline contract.** S07 preserves `createViewerPipelines(viewportState)` (`setSource`, `clear`, `forceRender`, `setColumnSource`, `notifyColumnChanged`), `getManhwaColumnSnapshot()` (`offsets`, `totalHeight`, `columnWidth`, `items`, `nodes`, `liveSlots`, `liveTypes`, `ico`), `buildIcoCompositeCanvas`, `getEffectiveScaling`, `icoSizesTotal`, and `invertViewport`. S07 keeps all three canvases and `data-render-ready`/`data-filter` markers inside `src/js/viewer/viewerPipelines.js` (preserving `diagnosticsContract.test.js:86-93`) while extracting non-DOM GL/media modules under `src/js/services/pipelines/` (`webcodecsAnimSession.js`, `svgRasterPump.js`, `icoCompositeCache.js`, `columnPipeline.js`).
- **Filter/scaler registry dedup.** S07 exports `SCALER_BY_ID` alongside `FILTERS`, `SCALERS`, `FILTER_BY_ID`, and null-safe `activeFilterId` in `src/js/services/registry.js` (dropping dead `pipeline: 'lanczos'`), letting S02 delete duplicated `FILTER_LABELS`, `scalingLabels`, and `SCALING_LABELS` maps in `menubar.js` and `statusbar.js`.
- **Cleanups and probe fixes.** Execute R4 (`centerListItem`, `FsUtils.buildAudioSrc`, `activeKeys` transition, atomic `computeColumnComposite` `{ x, y, width, height }` + `drawList`, `viewerPipelineProbe.js:19-20`, spacer CSS vars, and Telemetry B `diagnosticsContract.test.js:68-98`). Note for later follow-up: `protocol.rs:273,284,317,328` already sends `Access-Control-Allow-Origin: *`, so adding `crossOrigin="anonymous"` to S06 viewer `<img>` pool nodes can remove `TextureCache`'s second `fetch()` in a future slice.

### Sync C: URL loader, library, overlays, `quivit-drop`, and network IPC

Owners: S05 with S04, S02, S01, S07, S10.

- **Library store and download status ownership.** S05 removes the hard import of `activateImportProvider` (`urlLoader.js:33`) and accepts an `onProviderImported(providerDir)` callback injected from `main.js`. `urlLoader.js` remains sole writer of `_workspaceStatuses` (capacity raised from `512` to `4096`, cleared on gallery change, optimistic rollback on failed `retryGalleryDownload`); S04 removes duplicate `syncWorkspaceDownloadStatus` calls at `filePanel.js:427,434`, and S05 removes `_lastSyncedStatusDetail` (`urlLoader.js:2657`). S04 removes dead `getLibraryCollapsed`, `saveLibraryCollapsed`, and `quivit_library_collapsed` (`libraryStore.js:51-63`), and shares cached `_libraryTreeCache` between `libraryPanel` and `menubar.js:645-775`.
- **Overlays, menubar, and workspace RPC.** S05 removes `_urlOverlay` and `openPrompt` (`urlLoader.js:51,2791-2795,2909`); `actions.js:277` (`cmd-use-url`) routes through `actionCtx.openUrlPrompt` directly to `urlOverlay.show(payload)`. S04 provides an `onItemPointerDown` callback replacing `urlOverlay.js:167-201`'s 14-selector `#file-panel` reach-in. S02 splits `initImportActivity` out of `menubar/chrome.js:33-39`, caches `fetchManifest()`, and guards `renderImportsMenu()` with `_importsRenderSeq`. S01's `workspaceControls.js:159` restricts the `url` RPC bridge to whitelisted `UrlLoader` coordinator methods.
- **SVG utilities.** `src/js/shared/svgUtils.js` (S05) keeps its exact DOM-free exports (`expandSvgEntities`, `prepareSvgForCanvas`, `resolveSvgDimensions`) with zero signature changes for `viewerPipelines.js:11,94,109,770,1474,1516` (S07).
- **`quivit-drop` end-to-end contract.** `src-tauri/src/platform/drop.rs:150` (S10) keeps `emit_to("main", "quivit-drop", DropEvent { phase, dropId, message })` because `dropzone.js` runs only in `"main"` while `windows.rs:166` installs native drop targets on detached `workspace-file-list` windows too. `dropzone.js:80` (S02) preserves `owner: 'main'` and `importActions` (`acceptDrop`/`failDrop`/`completeDrop`, S05), and detached `?surface=fileList` keeps window-level `dragover`/`drop` `preventDefault()`.
- **Scoped download cancel and `.tmp` staging.** S10 moves `DownloadCancelFlag` into `crate::network::DownloadCancelFlag` (`src-tauri/src/network.rs`) with `cancel_all()`, `cancel_scope(scope)`, and `token(scope)`, adding optional `cancel_scope: Option<String>` to `download_to_file` and `cancel_download` so gallery queue cancellation stops aborting unrelated background raw downloads (`urlLoader.js:1825`). Zero-arg `cancel_download` and `quivit-download-threshold` (`{ requestId, queueGeneration }`) remain unchanged. S08 filters `.tmp` files in `watchers.rs` per R5.

### Sync D: multi-window, detached `?surface=fileList`, `windowFit`, `localStorage`, and config

Owners: S01 with S02, S03, S04, S08, S10.

- **Detached `?surface=fileList` parity and gating.**
  - `main.js` (S02) gates viewport-only controllers (`Statusbar.init`, `initFullscreen`, `initManhwaStrip`, `initPasswordOverlay`, `initUrlOverlay`, `initViewerAudio`, strip `keydown`) behind `hostsWorkspaceSurface('viewport')` / `!workspaceSurface`.
  - `viewer.js` (S06) gates `initViewer()` behind `hostsWorkspaceSurface('viewport')`.
  - `filePanel.js` (S04) gates listeners, timers, `renderFavorites()`, `renderLibrary()`, `refreshFilesystemState()`, and `container-dimensions` handling behind `hostsWorkspaceSurface('fileList')`, re-hydrating on re-dock, and routes viewport focus (`filePanel.js:3292`) through `workspaceControls.restoreFocus('main')`.
  - `core.js` (S01) adds `Core.applyDirectorySort(path, col, desc)` to `CORE_SESSION_METHODS` (eliminating `sortedList` RPC copies on S04 `dims` re-sorts), `Core.setStatusBarVisible(visible)` (for S02 `chrome.js:73-74`), `Core.setScrollZoomLatched(latched)` (for S01 `shortcuts.js:394`), and monotonic `configVersion` (replacing per-notify `JSON.stringify(state.config)` in `workspaceSession.js:160`).
  - `workspaceSession.js` (S01) rejects pending peer RPCs on `workspace-detached-closed` and adds bounded `ready` retry. `windows.rs` (S08) removes the 5-file `load_config` read and `ACTIVE_THEME` clobber from `open_workspace_window` and tracks tray-hidden windows so `restore_from_tray` never shows mid-init hidden `options`/`metadata` windows.
- **`windowFit.js` and `windows.rs` size caps.** S01, S03, and S08 lock matching bounds: `fit_options_window` clamps to `400..=560` (`OPTIONS_MIN_W..=OPTIONS_MAX_W`), and `fit_metadata_window` clamps to `280..=600` (`META_MIN_H..=META_MAX_H`). `metadata-window.js` (S03) eliminates the duplicate `fitContentHeight()` call when `coverSrc` triggers `coverImg.onload:47`.
- **Single-owner `localStorage` and `sessionStorage` ledger.**

| Key | Storage | Sole writer | Readers | Policy / change |
|---|---|---|---|---|
| `quivit-theme` | `localStorage` | `shared/theme.js:syncThemeStorage` (S01) | `themePrePaint.js` (S01) | Remove duplicate writes in `main.js:412-419` (S02), `options.js:140-143,359-367,578-584` (S03), `configPreview.js:39` (S01). Never write during live preview (`configPreview.isPreviewing()`). |
| `quivit-custom-css` | `localStorage` | `shared/theme.js:syncThemeStorage` (S01) | `themePrePaint.js` (S01) | Same single-owner rule as `quivit-theme`. |
| `options-active-tab` | `sessionStorage` | `options.js` (S03) | `options.js` (S03) | Move from `localStorage` to `sessionStorage`; remove `main.js:64` reach-in (S02) and update `core.js:25` comment (S01). |
| `quivit-metadata-current` | `localStorage` | `metadataBadge.js` (S02) | `metadata-window.js` (S03) | Defer cover generation until Metadata opens; emit explicit `{ meta: null, coverSrc: null }` on `metadata-data`; remove redundant write at `metadata-window.js:199`. |
| `icon:*` | `localStorage` | `filepanel/nativeIconCache.js` (S04) | `filePanel.js` (S04) | Stop clearing on `window.focus` (`filePanel.js:3131`) per `AGENTS.md` Example #2. |
| `quivit_library_collapsed` | Removed | None | None | Delete dead key and helpers (`libraryStore.js:51-63`, S04). |
| `quivit_library_providers_collapsed`, `quivit_library_provider_order`, `quivit_library_active_*` | `localStorage` | `libraryStore.js` (S04) | `libraryStore.js` (S04) | Cache parsed state in memory; document alongside `core.js:20-37` persistence policy. |

- **Roaming vs portable config and library path sync.** S08 promotes `pending_single_instance` at startup before `load_config_early()`, fixes portable migration re-creating the roaming directory (`config.rs:618-620`), moves debug `QUIVIT_CONFIG_DIR=.dev-config` setup after `direct_open::forward_file_open` (`main.rs:33-58`), and shares `normalize_library_location_paths` / `remap_library_paths` and cached `configured_library_dir` / `retired_library_paths` with S10. S01 gates `update_theme` IPC to the originating window so secondary windows stop redundant N-window fan-out (`windows.rs:109-111`).

### Sync E: Rust bootstrap, `models.rs`, `commands/`, and dead IPCs

Owners: S08 (host) with S09, S10, S11.

- **`src-tauri/src/models.rs` changes.**
  - Add `DirectoryReadResult.has_gallery_sidecar: bool` (already computed in `commands/directory.rs:35`; eliminates failing `read_text_file(...\gallery.json)` IPCs from `fsUtils.js:580-607`).
  - Move `LibraryMoveResult` from `commands/library.rs:18-25` (S10) into `models.rs`.
  - Move `DimensionEntry` from `commands/animation.rs:326` (S09) into `models.rs`.
  - Remove unused `PreviewDiagnostic` (`models.rs:111-148`, S08/S11) per R6.
- **Bootstrap and module layout.** Apply R1 (`devtools` kept), R5 (`commands/{config,windows,icons}.rs`, `platform/{gdi,associations,shell}.rs`, `library.rs`, `network.rs`, watcher `.tmp` filter), R6 (4 dead IPCs removed), and R7 (`lib.rs` wildcard removal, `archives` facade re-exports, and `#[path]` test mounts).
- **`main.rs` entrypoints.** S08 preserves `--previews-thumb` (`main.rs:6-12`) and `--previews-pane` / `--preview-handler` (`:16-31`) entrypoints calling `platform::previews::{run_thumbnail_server, run_server, log_event}` (S11). S08 also offloads `setup()` watchers and `cleanup_orphaned_temp_dirs` off the main startup thread and adds a 250ms trailing debounce plus parent-event filtering to `watch_directory`.

### Sync F: media, protocol, previews, direct open, and shell

Owners: S09 with S10, S11, S08, S01, S03, S04, S06, S07.

- **Temp archive origin seam (`S09` <-> `S10`).** `platform/temp_archive.rs:1268-1291` changes `resolve_temp_origin(path: &str, cache: &RwLock<ArchiveCache>)` to take `&RwLock<ArchiveCache>` instead of `tauri::State`, and `commands/archives.rs:82` passes `&*state`. This removes `tauri::State` from `platform/` while keeping Win32 UIA/registry lookup outside the `ArchiveCache` write lock.
- **`formats/` facade (`S09` <-> `S03`, `S10`, `S11`).** S09 splits `src-tauri/src/formats.rs` (1,148L) into `formats/{mod,registry,tiff,animation,isobmff,dimensions}.rs` and re-exports 100% of existing public and `pub(crate)` items at `crate::formats::*` (`SUPPORTED_FORMATS`, `FORMAT_ICONS`, `is_archive_ext`, `is_image_ext`, `is_metadata_ext`, `is_tiff_ext`, `is_tiff_name`, `isobmff_box`, `read_mp4_dimensions`, `decode_tiff_*`, `check_animation_status`, `check_mp4_has_audio`, `read_media_dimensions_*`, plus relocated `guess_mime`). S10 reuses `formats::is_archive_ext` (dropping duplicate `is_supported_archive` in `temp_archive.rs:1019`) and `formats::read_mp4_dimensions` (`image_import.rs:211`). S11 calls `formats::check_animation_status` (`formats.rs:337`) in `media_loader.rs` to pass a static-vs-animated hint to `preview_player.js`. All 22 formats stay 1:1 across `options.html`, `associationsUi.js`, `src/assets/icons/*.png`, `icons/formats/*.ico`, and `SUPPORTED_FORMATS` / `FORMAT_ICONS`.
- **Archives, ICO, and native icons (`S09` <-> `S11`).** S09 preserves `archives::list_archive_names` (`com_server.rs:1735` -> `archive_pane.rs`), `ico::ico_spritesheet_from_bytes` (`image_pane.rs:336` -> `media_loader.rs`), and `platform::icons::{warmup, get_cached_native_icon, clear_cached_native_icons, get_cached_native_icon_png_with_size, IconSize}` (dropping unused `get_cached_native_icon_png` at `icons.rs:161-163`). `commands/icons.rs` wraps `platform::icons`.
- **Direct open and associations error prefixes (`S08` <-> `S11` <-> `S03`).** S08 preserves `platform::direct_open::{has_file_open_arg, release_exe, selected_exe}` (called by `platform/associations.rs` and `archive_pane.rs`) and adds read-compare-before-write in `record_current_exe`. S08 and S11 preserve exact error prefixes parsed by `associationsUi.js:74-81` (`"The release build"`, `"Close the preview pane and Explorer windows, then retry:"` with `(os error 5|32|33)`, and `"Preview helper update is pending."`). S03 defers `sync_preview_associations` (`associationsUi.js:99`) until the File Types tab opens.
- **Shared encoding utilities (`S08` <-> `S09`, `S10`).** `utils.rs` dispatches `BASE64_URL_SAFE_NO_PAD` vs `BASE64_STANDARD_NO_PAD` after `trim_end_matches('=')` with zero temp `String` allocations and adds a `!input.contains('%')` fast path in `url_decode`. `platform/icons.rs:153` switches to `crate::utils::base64_encode`.
- **`quivit://` protocol and width/dims scan events (`S09` <-> `S01`, `S04`, `S06`, `S07`).** Preserve all four `quivit://` routes (`/archive/<b64>/<entry>`, `/thumb/<b64>`, `/icon/<b64>/<ext_b64>[?size=large|32]`, `/tiff/<b64>`), Range `206` plus invalid-range `200` fallback, `Cache-Control: no-store` on `/archive/` and `/tiff/`, `Access-Control-Allow-Origin: *`, and exact `manhwa-max-width` and `container-dimensions` payloads. S09 fixes `protocol.rs:20,48,75` route collisions using URI path prefix matching (`starts_with("/icon/")`, etc.). S06 routes `manhwaStrip.js:2726,3077` `cancel_width_scan` and `manhwa-max-width` through S01's `FsUtils` facade.

## Locked contracts inventory

### IPC commands (72 existing: 68 active locked, 4 dead removed)

- **S08 (26 active locked, 1 dead removed):**
  - Config (8 -> `commands/config.rs`): `load_config`, `get_config_dir`, `get_active_config_info`, `open_active_config_dir`, `open_config_dir`, `get_local_data_dir`, `open_local_data_dir`, `save_config`.
  - Windows (11 active -> `commands/windows.rs`): `open_options`, `open_workspace_window`, `close_workspace_window`, `set_workspace_title`, `fit_options_window`, `open_metadata_window`, `fit_metadata_window`, `show_window`, `hide_to_tray`, `update_theme`, plus `get_initial_args` (`commands/shell.rs:59`).
  - Watchers and shell (7 active): `watch_directory`, `rebind_library_watcher`, `open_in_explorer`, `get_default_dir`, `pick_folder`, plus `get_library_dir` and `get_default_library_dir` (relocated to S10 `commands/library.rs` per R5).
  - Dead removed (1): `show_from_tray` (`windows.rs:488`, `lib.rs:147`).
- **S09 (13 active locked, 1 dead removed):**
  - Archives (6 active): `list_archive`, `drop_archive_cache`, `prefetch_archive_entries`, `get_ico_frames`, `get_archive_ico_frames`, `resolve_archive_temp_origin`.
  - Animation and scanning (7 active): `check_is_animated`, `check_media_audio`, `scan_container_max_width`, `cancel_width_scan`, `scan_container_dimensions`, `cancel_dims_scan`, `probe_media_dimensions`.
  - Dead removed (1): `drop_all_archives_cache` (`commands/archives.rs:35`, `lib.rs:109`).
- **S10 (23 active locked, 0 dead):**
  - Directory and filesystem (11 active): `read_directory` (adds `has_gallery_sidecar: bool`), `find_directory_metadata`, `get_drives`, `get_path_kind`, `get_file_sizes`, `read_text_file`, `write_text_file`, `create_placeholder_files`, `remove_file`, `remove_directory`, `read_library_tree`.
  - Library relocation (2 active): `move_library`, `library_move_in_progress`.
  - Network (6 active): `fetch_text`, `fetch_extractor_text`, `fetch_bytes`, `download_to_file` (optional `cancel_scope`), `cancel_download` (optional `cancel_scope`), `verify_image_magic`.
  - Native drop (4 active, Windows): `enable_native_drop`, `describe_drop`, `release_drop`, `save_dropped_image`.
- **S11 (6 active locked, 2 dead removed):**
  - Icons (2 active -> `commands/icons.rs`): `get_native_icon`, `invalidate_native_icon_cache`.
  - Registry and previews (4 active): `get_format_status` (async, same `Vec<FormatStatus>`), `sync_preview_associations`, `apply_associations`, `unregister_associations`.
  - Dead removed (2): `get_preview_diagnostics` (`commands/registry.rs:113`, `lib.rs:139`) and `register_associations` (`commands/registry.rs:427`, `lib.rs:142`).

### Rust-to-JS events (10 locked)

| Event | Emitter | Payload / target contract |
|---|---|---|
| `single-instance-open` | `lib.rs:55` | Pipe-joined path argument string to `"main"` |
| `workspace-detached-closed` | `windows.rs` | Detached workspace window close notification |
| `directory-changed` | `commands/watchers.rs:45,69` | `()`, 250ms trailing debounce, `.tmp` ignored |
| `library-changed` | `commands/watchers.rs:123` | `()`, `.tmp` ignored |
| `config-changed` | `commands/watchers.rs:177` | `()` |
| `manhwa-max-width` | `commands/animation.rs:103,116` | `{ container, max_width, done? }` |
| `container-dimensions` | `commands/animation.rs:342` | `{ container, entries, done? }` |
| `library-relocated` | `commands/library.rs:795` | `{ oldPath, newPath, ... }` |
| `quivit-download-threshold` | `commands/network.rs:378` | `{ requestId, queueGeneration }` |
| `quivit-drop` | `platform/drop.rs:150` | `emit_to("main", "quivit-drop", DropEvent { phase, dropId, message })` |

Cross-window JS events also remain locked: `metadata-data`, `config-updated`, `theme-preview`, `css-preview`, `preview-cleared`, `quivit-workspace-closed`, `quivit-config-loaded`, `quivit-library-updated`, `quivit-library-relocated`, `quivit-download-status`, `quivit-download-complete`, `quivit-status-flash`, `quivit-import-status`.

### Protocol routes, probes, scenarios, and E2E selectors

- **`quivit://` (`src-tauri/src/protocol.rs`):** `/archive/<b64>/<entry>`, `/thumb/<b64>`, `/icon/<b64>/<ext_b64>[?size=large|32]`, `/tiff/<b64>`.
- **`quivit-preview://` (`src-tauri/src/platform/previews/windows/image_pane.rs`):** Explorer preview pane WebView2 scheme (`preview_player.{html,css,js}`).
- **`mocha/diagnosticsContract.test.js`:** All 14 `e2e/scenarios/*.json` actions remain valid in `ACTION_MAP` or `TRACE_STEPS` (`select-index`, `jump-to-index`, `open-favorite`); DOM/class/dataset checks at `L58-98` stay satisfied (updated in S06 Telemetry B per R4).
- **`e2e/replay-diagnostics/probes/corePipelineProbe.js`:** Preserves `actions.js` `ACTION_MAP` + `dispatch`, `core.js` `Core.{getState,onStateChange,navigate,persistConfig}`, and all 13 `trackedKeys`.
- **`e2e/replay-diagnostics/probes/ipcProtocolProbe.js`:** Preserves `window.__TAURI__.core.invoke` and `quivit://` / `asset://` `window.fetch` routing (`/archive/`, `/thumb/`, `/icon/`, `asset`).
- **`e2e/replay-diagnostics/probes/viewerPipelineProbe.js`:** Preserves `#viewport`, `#manhwa-strip`, `#manhwa-strip-spacer-top/bottom`, `.manhwa-slot`, `#viewer-img-wrapper`, `#viewer-bridge-layer`, `#viewer-ico-row`, `.ico-container`, `.ico-size[data-ready]`, `.viewer-img.{active,bridge}`, `.viewer-video.{active,bridge}`, `#viewer-lanczos-canvas`, `#viewer-filter-canvas`, `#manhwa-filter-canvas`, `[data-render-ready]`, `[data-filter]`, and `#statusbar .status-filename`. Telemetry A updates `L19-20` transform parser per R4.
- **`e2e/replay-diagnostics/runner.e2e.js:330-355`:** Preserves `dispatch`, `Core`, `FsUtils`, `Viewer`, `NavigationHistory`, `Chrome` (fixed by S02 export), and `manhwaStrip` module exports.
- **E2E page objects (`e2e/pageobjects/*.page.js` and `e2e/specs/01` to `08`):** Preserve all locked selectors across `menubar.page.js`, `statusbar.page.js`, `filepanel.page.js`, `options.page.js`, and `08-url-loader.e2e.js`.

## Four-suite Telemetry A/B matrix

Every execution unit in Stage 4 starts with Telemetry A (adding missing pre-refactor assertions and capturing baseline JSON) and ends with Telemetry B (re-running the same suites, updating contract imports where files split, and proving parity plus measured improvements).

### Stage 1 coverage gap closure ledger

| Stage 1 gap | Closing split | Telemetry A additions |
|---|---|---|
| `src/js/fsUtils.js` | S01 | New Mocha suites for `fsUtils` and extracted `services/{mediaFormats,mediaUrls,listNavigation}.js` + E2E + `diagnose` |
| `src/js/shared/workspace*` | S01, S02, S04, S06, S08 | New Mocha suites for `workspaceLayout`, `workspaceHost`, `workspaceSession`, `workspaceControls` + detached `?surface=fileList` E2E parity |
| `src/js/filepanel/libraryStore.js` (and `favoritesStore.js`) | S04 | New `mocha/libraryStore.test.js`, `mocha/favoritesStore.test.js`, `mocha/filePanelMath.test.js` + `05-persistence` and `08-url-loader` E2E |
| `src-tauri/src/windows.rs` | S08 | New `src-tauri/src/tests/windows_tests.rs` via `#[path]` + `01-startup`, `06-configuration`, `07-os-integration` E2E |
| `src-tauri/src/commands/watchers.rs` | S08 | New `src-tauri/src/tests/watchers_tests.rs` via `#[path]` + E2E coalesced `directory-changed` |
| `src-tauri/src/commands/animation.rs` | S09 | New `src-tauri/src/tests/animation_tests.rs` via `#[path]` + `03-viewer`/`04-archives` E2E + `diagnose -- manhwa-width-span` |
| `src-tauri/src/image_import.rs` | S10 | New `src-tauri/src/tests/image_import_tests.rs` via `#[path]` + E2E |
| `src-tauri/src/commands/drop.rs` and `platform/drop.rs` | S10 | New `src-tauri/src/tests/drop_tests.rs` via `#[path]` + `07-os-integration` E2E |
| `src-tauri/src/commands/registry.rs` | S11 | New `src-tauri/src/tests/registry_tests.rs` via `#[path]` (zero HKCU writes) + `mocha/previewPlayer.test.js` + `06-configuration`/`07-os-integration` E2E |

### Suite pairing by split

| Split | `npm run mocha` | `cargo test --manifest-path src-tauri/Cargo.toml` | `npm run e2e -- --spec <file>` | `npm run diagnose -- <scenario>` |
|---|---|---|---|---|
| **S01** | Expand `core`, `actions`, `sorting`, `cache`; add `fsUtils`/extracted services, `navigationHistory`, `directoryPrefs`, `archiveImageCache`, `keybindDomain`, `keyCombo`, `workspace*`, `configPreview` | Read-only seam check (`config_tests`, `directory`, `windows`) | `01-startup`, `02-navigation`, `03-viewer`, `04-archives`, `05-persistence`, `06-configuration`, `07-os-integration` (+ detached `?surface=fileList`) | `sample-navigation`, `filter-navigation`, `manhwa-buffer` |
| **S02** | Add `mocha/chromeContract.test.js` (safe-triangle geometry, `getCopyableStatusItem`, fullscreen exit `Set`, `#custom-css` order, 22-token parity, `Chrome` export) | N/A | `01-startup`, `03-viewer`, `04-archives`, `06-configuration`, `08-url-loader` (+ detached chrome check) | `grill-desync`, `sample-navigation` |
| **S03** | Expand `metadata.test.js`; add `mocha/optionsForm.test.js`, static HTML/22-asset/`ACTION_REGISTRY` parity, pure `metadataParser` | Read-only seam check (`config_tests`, `format_tests`, `windows`) | `06-configuration` (+ `metadata.html` open/cover/null-clear/single-fit) | N/A |
| **S04** | Add `mocha/favoritesStore.test.js`, `mocha/libraryStore.test.js`, `mocha/filePanelMath.test.js` (+ static DOM/style/scroll-perf checks) | N/A | `02-navigation`, `04-archives`, `05-persistence`, `08-url-loader` (+ detached `?surface=fileList`) | N/A |
| **S05** | Expand `urlLoader*.test.js`, `svgUtils.test.js`; add `mocha/importActions.test.js` (+ N=1500 queue snapshot `<5ms`, 0 leaked Blob URLs) | Covered by S10 (`network`, `library`) | `08-url-loader` (cmd-use-url, detached status sync, relocation teardown) | `mangadex-chapters` (when fixture present) |
| **S06** | Expand `viewerMath.test.js`, `diagnosticsContract.test.js` (Telemetry B); add `mediaAudioState`, `viewerBridge` FSM, debounce cadence, `_admitCompleted` | Read-only seam check (`format_tests`, `ico`, `check_mp4_has_audio`) | `02-navigation`, `03-viewer`, `04-archives` (+ detached zero-viewer-init, audio/manhwa silence, rapid swaps) | `sample-navigation`, `zoom-bridge-stale-size`, `grill-desync`, `manhwa-buffer`, `manhwa-directory-entry-fits`, `manhwa-first-last-align`, `manhwa-fit-cycle`, `manhwa-gif-bridge`, `manhwa-video-bridge`, `manhwa-width-span` |
| **S07** | Expand `quadCompositor.test.js` (Telemetry B lazy compile), `textureCache.test.js`; add `glRuntime`, `lanczos`, `registry`, `filterModules`, `blobImage` | N/A | `03-viewer` (+ single-image filters, static Lanczos, WebGL context restore) | `filter-navigation`, `manhwa-ghost-phosphor`, `manhwa-gif-bridge`, `manhwa-video-bridge` |
| **S08** | Read-only `diagnosticsContract.test.js` | Expand `config_tests` (fix env lock); migrate `attributes_tests`; add `windows_tests`, `watchers_tests`, `utils_tests`, `direct_open_tests`, `dialog_tests` | `01-startup`, `05-persistence`, `06-configuration`, `07-os-integration`, `08-url-loader` (CSP, tray, `workspace-file-list`) | `sample-navigation` (read-only `ipcProtocolProbe.js`) |
| **S09** | Read-only `diagnosticsContract.test.js` | Fix hardcoded paths in `format_tests.rs:261,266` and `archive_tests.rs:192`; expand `archive`/`format`/`ico`/`protocol` tests; add `animation_tests`, `icons_tests`, `thumbnails_tests` | `03-viewer`, `04-archives`, `07-os-integration` (+ TIFF, animated APNG/AVIF/WebP/GIF, width/dims scans) | `manhwa-width-span`, `manhwa-buffer`, `manhwa-directory-entry-fits`, `manhwa-gif-bridge`, `manhwa-video-bridge` |
| **S10** | Read-only `diagnosticsContract.test.js` | Migrate 22 inline tests (`directory_tests`, `library_tests`, `network_tests`); expand `temp_archive_tests`; add `image_import_tests`, `drop_tests` | `01-startup`, `02-navigation`, `05-persistence`, `07-os-integration`, `08-url-loader` | `sample-navigation` (read-only `ipcProtocolProbe.js`) |
| **S11** | Add `mocha/previewPlayer.test.js` (classic `<script defer>` WebView2 compat via Node `vm` or verified module load) + read-only `diagnosticsContract.test.js` | Fix leaked `%TEMP%\quivit-previews-test-*` in `previews_tests.rs`; expand `previews_tests`; add `registry_tests` (0 HKCU writes) | `06-configuration`, `07-os-integration` (all 22 `SUPPORTED_FORMATS` + native icons) | N/A |
