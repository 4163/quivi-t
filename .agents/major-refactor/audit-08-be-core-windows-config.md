# Audit 08: backend core, windows, configuration, and platform (`be-core-windows-config`)

Split S08 covers 19 backend and configuration files totaling 2,802 lines across Tauri manifests, capabilities, app bootstrap, IPC data contracts, encoding utilities, configuration persistence, secondary window lifecycle, directory and config watchers, shell commands, Win32 platform helpers, and configuration unit tests.

Both S08 workers, `s08-config-windows` and `s08-boot-validate`, ran independent passes across all 19 files, cross-verified every `file:line` target and caller in live code, reached unanimous `[Agree]` on 21 findings (`S08-01` to `S08-21`) and 4 cohesive files, and ratified the cross-split seam matrix in `cross-split-seams.md` (`R1`, `R2`, `R5`, `R6`, `R7`, Sync A, Sync D, Sync E, and Sync F). Baseline `cargo test --manifest-path src-tauri/Cargo.toml` passed 14 of 14 tests in `config::tests` and 1 of 1 test in `platform::attributes::tests`.

## File coverage ledger

| File | Lines | Status | Findings |
|---|---|---|---|
| `src-tauri/Cargo.toml` | 52 | `[Agreed]` | `S08-18` |
| `src-tauri/tauri.conf.json` | 36 | `[Agreed]` | `S08-16` |
| `src-tauri/tauri.dev.conf.json` | 3 | `Cohesive` | None |
| `src-tauri/capabilities/default.json` | 25 | `[Agreed]` | `S08-17` |
| `src-tauri/src/main.rs` | 61 | `[Agreed]` | `S08-10` |
| `src-tauri/src/lib.rs` | 218 | `[Agreed]` | `S08-09` |
| `src-tauri/src/models.rs` | 220 | `[Agreed]` | `S08-11` |
| `src-tauri/src/utils.rs` | 35 | `[Agreed]` | `S08-12` |
| `src-tauri/src/config.rs` | 655 | `[Agreed]` | `S08-01`, `S08-02`, `S08-03`, `S08-04` |
| `src-tauri/src/windows.rs` | 494 | `[Agreed]` | `S08-05`, `S08-06`, `S08-07`, `S08-08` |
| `src-tauri/src/commands/mod.rs` | 21 | `Cohesive` | None, adds `config`, `windows`, `icons` in Sync E |
| `src-tauri/src/commands/shell.rs` | 82 | `[Agreed]` | `S08-13` |
| `src-tauri/src/commands/watchers.rs` | 193 | `[Agreed]` | `S08-14` |
| `src-tauri/src/platform/mod.rs` | 12 | `Cohesive` | None, adds `gdi`, `associations`, `shell` in Sync E/F |
| `src-tauri/src/platform/attributes.rs` | 97 | `[Agreed]` | `S08-15` |
| `src-tauri/src/platform/dialog.rs` | 97 | `[Agreed]` | `S08-19` |
| `src-tauri/src/platform/direct_open.rs` | 129 | `[Agreed]` | `S08-20` |
| `src-tauri/src/platform/process.rs` | 44 | `Cohesive` | None |
| `src-tauri/src/tests/config_tests.rs` | 328 | `[Agreed]` | `S08-21` |

All 19 owned files are accounted for: 15 files carry findings, 4 files are cohesive, 0 findings were dropped, and 0 were escalated.

## Agreed findings

### S08-01 `[Blocking]` `src-tauri/src/config.rs`: extract eight IPC commands and Tauri UI imports

- **Targets:** `src-tauri/src/config.rs:5-6,435-530,637-651`
- **Problem:** `config.rs` imports `tauri::Manager` and `tauri_plugin_opener::OpenerExt` and defines eight `#[tauri::command]` handlers inline: `load_config`, `get_config_dir`, `open_active_config_dir`, `get_active_config_info`, `open_config_dir`, `get_local_data_dir`, `open_local_data_dir`, and `save_config`. This mixes domain persistence with Tauri IPC and shell-opener calls.
- **Agreed fix:** Move all eight `#[tauri::command]` handlers into a new `src-tauri/src/commands/config.rs` module registered via `commands/mod.rs` per R5. Keep `config.rs` as pure configuration persistence taking `&Path` parameters such as the resolved `app_config_dir` rather than `&tauri::AppHandle`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml config::tests` and `npm run e2e -- --spec e2e/specs/05-persistence.e2e.js`, `06-configuration.e2e.js` confirm exact IPC names and JSON payloads after command extraction.

### S08-02 `[Blocking]` `src-tauri/src/config.rs`: remove `commands::library` circular reach-in

- **Targets:** `src-tauri/src/config.rs:639`, `src-tauri/src/commands/library.rs:150-157`
- **Problem:** `save_config` calls `crate::commands::library::library_move_in_progress()?`, reaching up from configuration persistence into a sibling command module while `commands/library.rs` calls back into `config`.
- **Agreed fix:** Move the pure move-lock check into the new crate-root `library` domain module defined in R5 (`src-tauri/src/library.rs`), or guard inside `commands/config.rs` against that domain predicate, so `config.rs` never imports `crate::commands::*`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml` covering move-lock rejection on `save_config`, plus `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js`.

### S08-03 `[Warning]` `src-tauri/src/config.rs`: portable migration bug, duplicated split-file metadata, and stale identifier

- **Targets:** `src-tauri/src/config.rs:94-107,137-143,161-164,457-459,485-506,545,577-584,617-621`
- **Problem:**
  1. During portable migration at `L617-621`, `remove_roaming_files` already deletes `custom_css.css` because it is listed in `ROAMING_FILES` at `L142`. `L620` deletes `custom_css.css` a second time via `roaming_dir(&app_handle)`, which calls `fs::create_dir_all` and re-creates the roaming folder immediately after clearing it.
  2. `save_override` (`L577-584`) hardcodes the four split filenames instead of deriving them from `&ROAMING_FILES[1..]`.
  3. `describe_config_source` (`L94-107`) duplicates the override, portable, and roaming layout branching in `get_active_config_info` (`L485-506`).
  4. `get_config_path` (`L161-164`) hardcodes `"com.x4163.quivit"`, diverging from `tauri.dev.conf.json`'s `com.x4163.quivit.dev` when `QUIVIT_CONFIG_DIR` is unset.
  5. `L545` calls `fd.as_object_mut().map(...)` solely for its side effect, and `L457-459` still claims `get_config_dir` and `get_local_data_dir` repoint at override folders when `options.js:114-123` actually routes through `get_active_config_info` and `open_active_config_dir`.
- **Agreed fix:** Delete `L620` so `remove_roaming_files(&roaming_dir_path(&app_handle))` cleans all roaming files without re-creating the folder. Share a single split-file list from `ROAMING_FILES`, share one config-source descriptor helper, align the non-override dev roaming identifier with `tauri.dev.conf.json` (`cfg!(debug_assertions)`), replace `L545` `.map(...)` with `if let Some(obj)`, and update the stale comment at `L457-459`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml config::tests` adding a roaming-to-portable migration test asserting the roaming directory is not re-created after `remove_roaming_files`, plus `npm run e2e -- --spec e2e/specs/05-persistence.e2e.js`.

### S08-04 `[Warning]` `src-tauri/src/config.rs`: pending promotion timing, synchronous command I/O, and redundant reads

- **Targets:** `src-tauri/src/config.rs:327-362,435-455,637-651`, `src-tauri/src/lib.rs:24,197`
- **Problem:**
  1. Comments at `config.rs:329-330` and `355` state that pending startup values and manual `hidden` attribute edits are promoted before startup logic reads them on the next launch, but `lib.rs` invokes `apply_pending_config_to_disk()` only at `RunEvent::Exit` (`lib.rs:197`). A crash or forced exit leaves `pending_single_instance` unpromoted on next launch. `L357` also hardcodes `get_exe_dir()`, ignoring `override_config_dir()`.
  2. `load_config`, `save_config`, `open_active_config_dir`, `open_config_dir`, and `open_local_data_dir` are synchronous Tauri commands performing multi-file disk I/O on the main thread. `save_config` (`L645`) reads all five config files and runs `normalize_library_location_paths` over every favorite and directory sort preference solely to check `same_library_location` (`LIBRARY_PATH_KEY`).
  3. Repeated calls to `configured_library_dir()` and `load_config_early()` re-read `quivit_config.json` from disk across `read_directory`, `watch_directory`, and `move_library`.
- **Agreed fix:** Run `apply_pending_config_to_disk()` at startup in `lib.rs::run()` before `load_config_early()` (resolving override vs portable path properly), and update the comment. Make config and directory-open commands `#[tauri::command(async)]` with `spawn_blocking` if needed. In `save_config`, compare `LIBRARY_PATH_KEY` directly from `load_config_early()` (`quivit_config.json`) without loading split files, and add an in-memory cache for `configured_library_dir()` and `retired_library_paths` invalidated on `save_config` and `move_library` (Sync D and Sync E with S10). Also share the path-walker logic between `normalize_library_location_paths` (`config.rs:243-325`) and `remap_library_paths` (`commands/library.rs:538-629`).
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml config::tests` adding crash-recovery pending promotion, `normalize_library_location_paths`, `display_path`, and `same_library_location` tests, plus `npm run e2e -- --spec e2e/specs/05-persistence.e2e.js`, `06-configuration.e2e.js`.

### S08-05 `[Blocking]` `src-tauri/src/windows.rs`: extract eleven IPC commands out of window domain module

- **Targets:** `src-tauri/src/windows.rs:100,123,180,192,219,263,375,392,409,473,487`
- **Problem:** `windows.rs` defines eleven `#[tauri::command]` handlers inline alongside window sizing constants, monitor clamping, theme tracking, and tray icon setup.
- **Agreed fix:** Extract the ten active IPC handlers (`update_theme`, `open_workspace_window`, `close_workspace_window`, `set_workspace_title`, `open_options`, `open_metadata_window`, `fit_options_window`, `fit_metadata_window`, `show_window`, `hide_to_tray`) into `src-tauri/src/commands/windows.rs` per R5, leaving `windows.rs` as the pure window lifecycle and sizing module. Keep `update_theme(app, theme)` IPC signature stable while S01 gates redundant secondary-window JS calls.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml windows_tests` and `npm run e2e -- --spec e2e/specs/01-startup.e2e.js`, `06-configuration.e2e.js`.

### S08-06 `[Warning]` `src-tauri/src/windows.rs`: remove dead IPC `show_from_tray`

- **Targets:** `src-tauri/src/windows.rs:487-494`, `src-tauri/src/lib.rs:147`
- **Problem:** `show_from_tray` is registered in `lib.rs:147` but has zero callers across `src/`, `mocha/`, `e2e/`, and `src-tauri/`. Internal restore flows call `restore_from_tray(&app)` directly (`lib.rs:45`, `windows.rs:437,447`).
- **Agreed fix:** Delete `show_from_tray` and remove it from `tauri::generate_handler!` in `lib.rs:147` per R6, keeping `restore_from_tray` internal.
- **Telemetry A/B:** `cargo check --tests --manifest-path src-tauri/Cargo.toml` and `npm run e2e -- --spec e2e/specs/01-startup.e2e.js`, `07-os-integration.e2e.js` confirming zero regressions.

### S08-07 `[Warning]` `src-tauri/src/windows.rs`: eliminate 5-file config read and theme clobber in `open_workspace_window` and deduplicate builders

- **Targets:** `src-tauri/src/windows.rs:67-98,152-164,219-305,375-407`
- **Problem:**
  1. `open_workspace_window` (`L152-164`) calls `crate::config::load_config(app.clone())`, parsing five files from disk just to call `apply_shell_background`, which overwrites `ACTIVE_THEME` and clobbers ephemeral live theme previews. It then immediately overwrites `set_theme(active_tauri_theme())` and recomputes `set_background_color` from `main.theme()` with duplicated `Color(37, 37, 38, 255)` / `Color(255, 255, 255, 255)` literals.
  2. `open_options` (`L220-261`) and `open_metadata_window` (`L264-305`) duplicate identical `raise_main`, visibility check, show, unminimize, focus, and `WebviewWindowBuilder` code.
  3. `fit_options_window` (`L376-390`) and `fit_metadata_window` (`L393-407`) duplicate identical visible-resize versus hidden-center logic.
- **Agreed fix:** Extract a `shell_background_color(dark: bool) -> Color` helper and derive `open_workspace_window`'s initial theme and background color directly from `active_tauri_theme()` and `main.theme()` with zero disk I/O. Extract shared `open_auxiliary_window` and `fit_auxiliary_window` helpers for Options and Metadata.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml windows_tests` and `npm run e2e -- --spec e2e/specs/01-startup.e2e.js`, `06-configuration.e2e.js` verifying detached `?surface=fileList` inherits active theme without disk reads.

### S08-08 `[Warning]` `src-tauri/src/windows.rs`: align `windowFit.js` caps, fix `restore_from_tray` flash, and retain DevTools per README

- **Targets:** `src-tauri/src/windows.rs:49-61,143,147,251,295,376-407,459-471`, `src/js/shared/windowFit.js:4-5`
- **Problem:**
  1. `OPTIONS_MAX_W = 560.0` (`L51`) and `META_MAX_H = 600.0` (`L61`) carry `#[allow(dead_code)]` claiming Rust is the single source of truth while JS enforces them in `shared/windowFit.js:4-5`. `fit_options_window` and `fit_metadata_window` pass raw `width` and `height` through unclamped.
  2. `open_workspace_window` (`L143`) reuses `META_MIN_W` (`320.0`) for the detached File List minimum width.
  3. `restore_from_tray` (`L459-471`) calls `window.show()` on every existing `SECONDARY_WINDOWS` label. If `options` or `metadata` is still hidden mid-init waiting for `fitContentWidth` or `fitContentHeight`, restoring from tray exposes an unfitted flash.
  4. `lib.rs:80` and `windows.rs:147,251,295` enable `.devtools(true)` in all builds. Per R1 and `README.md:150`, Developer Tools stays intentionally enabled in release builds to help users debug custom CSS.
- **Agreed fix:** Clamp `fit_options_window` to `width.clamp(OPTIONS_MIN_W, OPTIONS_MAX_W)` (`400..=560`) and `fit_metadata_window` to `height.clamp(META_MIN_H, META_MAX_H)` (`280..=600`), removing `#[allow(dead_code)]` and matching `shared/windowFit.js`. Define a dedicated `FILE_LIST_MIN_W` constant. Track which windows `hide_to_tray` actually hid so `restore_from_tray` skips mid-init hidden windows. Keep `.devtools(true)` enabled across app windows per R1.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml windows_tests` asserting `400..=560` and `280..=600` clamping and tray-hidden tracking, plus `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js`.

### S08-09 `[Warning]` `src-tauri/src/lib.rs`: startup blocking I/O, repeated config reads, wildcards, and test mounts

- **Targets:** `src-tauri/src/lib.rs:17-20,24,38,64,80,89-99,109,136-147,185-191,197,200,203,208-218`
- **Problem:**
  1. `setup()` runs `spawn_config_file_watcher` (`L96`), `spawn_library_watcher` (`L97`, recursive `notify::watch` and `create_dir_all`), `acquire_temp_lock()` (`L98`), and `cleanup_orphaned_temp_dirs()` (`L99`, synchronous `fs::remove_dir_all` over crashed archive temp folders) on the main setup thread before first paint.
  2. `load_config_early()` (`L24`), `describe_config_source()` (`L38`), `spawn_config_file_watcher` (`L96`), and `spawn_library_watcher` (`L97`) re-read and re-parse `quivit_config.json` three to five times during startup.
  3. `L17-20` uses wildcard `use archives::*; use commands::*; use config::*; use windows::*;`, obscuring command origins in `tauri::generate_handler!`.
  4. `L185-191` checks `window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed)` twice in adjacent blocks.
  5. `L208-218` mounts `archive_tests.rs`, `format_tests.rs`, and `temp_archive_tests.rs` at crate root instead of in their owner modules.
- **Agreed fix:** Keep `acquire_temp_lock()` fast and synchronous at startup, then offload `cleanup_orphaned_temp_dirs()`, `cleanup_abandoned_captures()`, `spawn_config_file_watcher()`, and `spawn_library_watcher()` off the main setup thread using resolved paths from the single startup `AppConfig` read. Run `apply_pending_config_to_disk()` before `load_config_early()` (`L24`) per `S08-04`. Remove `L17-20` wildcard imports, list explicit `commands::...::...` paths in `generate_handler!`, unregister the four dead IPCs (`show_from_tray`, `drop_all_archives_cache`, `get_preview_diagnostics`, `register_associations`) per R6, adopt `crate::archives::*` temp-lock re-exports and `crate::network::DownloadCancelFlag` per R5 and R7, merge `L185-191` into one `Destroyed` block, and move `L208-218` `#[path]` test mounts into `archives/mod.rs`, `formats/mod.rs`, and `platform/temp_archive.rs` per R7. Keep `.devtools(true)` at `L80` per R1.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml` verifying all relocated `#[path]` suites compile and pass, plus `npm run e2e -- --spec e2e/specs/01-startup.e2e.js`.

### S08-10 `[Warning]` `src-tauri/src/main.rs`: debug config override leaks across `direct_open` forwarding

- **Targets:** `src-tauri/src/main.rs:5,33-58`
- **Problem:** In debug builds, `main.rs:33-38` sets `QUIVIT_CONFIG_DIR` to `<repo>/.dev-config` before `direct_open::forward_file_open(&args_os)` (`L44`). When `.quivit-open-dev` is `false`, `forward_file_open` spawns the release executable with `QUIVIT_CONFIG_DIR=.dev-config` inherited from the parent environment, causing the release binary to read `.dev-config` instead of roaming user settings. `L5` and `L43` also collect args twice (`env::args()` then `env::args_os()`).
- **Agreed fix:** Move `QUIVIT_CONFIG_DIR` `.dev-config` setup (`L33-38`) after `forward_file_open` returns `Ok(false)` so forwarded release launches never inherit `.dev-config`. Preserve `--previews-thumb` (`L6-12`) and `--previews-pane` / `--preview-handler` (`L16-31`) entrypoints for S11.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml direct_open_tests` and manual verification of `forward_file_open` child environment behavior.

### S08-11 `[Warning]` `src-tauri/src/models.rs`: align IPC DTOs across Sync E and F

- **Targets:** `src-tauri/src/models.rs:1-220`
- **Problem:** `models.rs` cleanly isolates pure serde IPC structs, except `PreviewDiagnostic` (`L111-148`) belongs only to dead IPC `get_preview_diagnostics` (R6), `LibraryMoveResult` (`commands/library.rs:18-25`, S10) and `DimensionEntry` (`commands/animation.rs:326`, S09) sit inside command files instead of `models.rs`, and `DirectoryReadResult` (`L70-76`) lacks `has_gallery_sidecar: bool` already computed in `commands/directory.rs:35` (forcing failing `read_text_file` IPCs in `fsUtils.js:580-607`).
- **Agreed fix:** Remove `PreviewDiagnostic` in lockstep with S11 removing `get_preview_diagnostics` (R6). Relocate `LibraryMoveResult` (S10) and `DimensionEntry` (S09) into `models.rs`. Add `pub has_gallery_sidecar: bool` to `DirectoryReadResult` (Sync E with S01 and S10).
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml` (`directory`, `library`, `animation`) and `npm run diagnose -- sample-navigation` confirming zero failing `gallery.json` IPC errors.

### S08-12 `[Warning]` `src-tauri/src/utils.rs`: eliminate hot-path `String` allocations in base64 and URL decoding

- **Targets:** `src-tauri/src/utils.rs:11-35`
- **Problem:** `base64_decode_bytes` (`L11-16`) is called on every `quivit://` `/archive/`, `/thumb/`, `/icon/`, and `/tiff/` request (`protocol.rs:208,210,220,228,241`). It allocates four temporary heap strings per call: two `.replace(...)` buffers, `"=".repeat(padding)`, and `format!`. Callers pass both unpadded URL-safe base64 (`src/js/fsUtils.js:100`) and standard padded base64 (`ico_tests.rs:55`, `protocol_tests.rs`, `platform/drop.rs:822`). `url_decode` (`L18-35`) allocates a `Vec<u8>` even when no `%` escape is present.
- **Agreed fix:** Strip trailing `'='` and dispatch `BASE64_URL_SAFE_NO_PAD` when `input` contains `'-'` or `'_'`, and `BASE64_STANDARD_NO_PAD` otherwise, eliminating all intermediate `String` allocations while preserving 100% compatibility with both caller encodings. Add an early `if !input.contains('%') { return input.to_string(); }` fast path in `url_decode`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml utils_tests protocol_tests ico_tests archive_tests` asserting parity across URL-safe unpadded, standard padded, and mixed inputs plus zero intermediate string copies.

### S08-13 `[Blocking]` `src-tauri/src/commands/shell.rs`: move Win32 FFI to `platform/shell.rs` and relocate library commands

- **Targets:** `src-tauri/src/commands/shell.rs:18-45,48-56,70-82`
- **Problem:**
  1. `get_library_dir` (`L70-75`) and `get_default_library_dir` (`L78-82`) belong to the Library domain rather than `shell.rs`. `commands/directory.rs:235,493`, `commands/library.rs:706`, and `commands/watchers.rs:140` all reach across sibling commands into `commands::shell::get_library_dir()`, which re-reads `quivit_config.json` and calls `fs::create_dir_all` on every directory read.
  2. `open_uri` (`L18-45`) embeds raw Win32 `ShellExecuteW` and `wide_null` FFI directly inside `commands/shell.rs`.
  3. `get_default_dir` (`L48-56`) constructs `USERPROFILE\Pictures` manually rather than querying Windows `FOLDERID_Pictures` when redirected, though `07-os-integration.e2e.js:27` expects a non-empty string path.
- **Agreed fix:** Move `get_library_dir` and `get_default_library_dir` IPC commands into `commands/library.rs` (S10) backed by S08's cached `config::configured_library_dir()` and `default_library_dir()`, eliminating sibling command reach-ins. Relocate `open_uri` into `src-tauri/src/platform/shell.rs` alongside S10's `move_to_recycle_bin` (R5). Keep `get_default_dir` IPC contract intact, optionally falling back from known-folder resolution to `USERPROFILE\Pictures`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml` and `npm run e2e -- --spec e2e/specs/07-os-integration.e2e.js`, `08-url-loader.e2e.js`.

### S08-14 `[Blocking]` `src-tauri/src/commands/watchers.rs`: event storms, blocking mutex locks, `.tmp` filtering, and config watcher gaps

- **Targets:** `src-tauri/src/commands/watchers.rs:10-26,29-80,82-128,139-147,155-193`
- **Problem:**
  1. `watch_directory` (`L45`) emits `"directory-changed"` synchronously on every raw `Create`, `Remove`, and `Modify` event with zero debouncing, flooding the frontend with `read_directory` IPCs during multi-file writes or downloads.
  2. The parent watcher (`L67-71`) runs `child_path.exists()` on every event in the parent folder, including unrelated sibling activity and `Access` events, and keeps firing after deletion.
  3. `watch_directory` and `create_library_watcher` do not filter `.tmp` staging files, which blocks S10 from staging downloads in same-volume `.tmp` files (`R5`).
  4. `spawn_config_file_watcher` (`L168`) checks only `EventKind::Modify(_)` on `quivit_config.json`, missing `Create` events from `atomic_write` renames on Windows, ignoring split files such as `custom_css.css`, and never rebinding after a portable/roaming mode switch.
  5. `WatcherState` (`L10-15`) exposes four `pub` fields instead of private fields behind facade methods, four `.lock().unwrap()` calls (`L31,144,157,174`) panic on poison, and `L31-78` holds the mutex lock across `notify::recommended_watcher` and `.watch(...)` OS calls. `L140` also reaches into `commands::shell::get_library_dir()`.
- **Agreed fix:** Add a 250 ms trailing debounce loop to `watch_directory` matching `create_library_watcher`, filter parent watcher events to `Remove` or `Modify(Name)` affecting `child_path` and emit once, ignore `.tmp` sibling files in both `watch_directory` and `create_library_watcher` (R5), broaden `spawn_config_file_watcher` to handle rename-over `Create` events and split config files (plus rebind on mode switch), replace `commands::shell::get_library_dir()` at `L140` with cached `config::configured_library_dir()`, encapsulate `WatcherState` behind private fields and facade methods, construct watchers before acquiring the mutex lock, and handle lock poison without panicking.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml watchers_tests` testing event predicates, `.tmp` exclusion, and debounce coalescing, plus `npm run e2e -- --spec e2e/specs/02-navigation.e2e.js`, `05-persistence.e2e.js`.

### S08-15 `[Warning]` `src-tauri/src/platform/attributes.rs`: relocate inline test and skip redundant attribute write

- **Targets:** `src-tauri/src/platform/attributes.rs:32-47,80-97`
- **Problem:** `L80-97` embeds an inline `#[cfg(test)] mod tests` block instead of placing tests under `src-tauri/src/tests/` via `#[path]`. Also `set_hidden_attribute` (`L32-47`) calls `SetFileAttributesW` even when the file's `FILE_ATTRIBUTE_HIDDEN` bit already matches `hidden`.
- **Agreed fix:** Move `mod tests` to `src-tauri/src/tests/attributes_tests.rs` mounted via `#[path = "../tests/attributes_tests.rs"]` (R7), and return `Ok(())` early when `new_attrs == attrs`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml attributes_tests` (1 passing test preserved plus no-op `new_attrs == attrs` verification).

### S08-16 `[Warning]` `src-tauri/tauri.conf.json`: replace `"csp": null` with explicit runtime-verified CSP

- **Targets:** `src-tauri/tauri.conf.json:12-16`
- **Problem:** `"csp": null` (`L12`) disables Content Security Policy in every Tauri webview.
- **Agreed fix:** Keep `assetProtocol` enabled (`L13-16`, required by `src/js/fsUtils.js:426` and `e2e/replay-diagnostics/probes/ipcProtocolProbe.js:49`) and replace `"csp": null` with explicit directives per R2:
  - `default-src 'self'`
  - `script-src 'self' blob: 'wasm-unsafe-eval'` (`urlLoader.js` dynamic `Blob` extractors and `src/js/vendors/pica.js` WASM compilation)
  - `worker-src 'self' blob:` (`pica.js` inline Blob worker)
  - `style-src 'self' 'unsafe-inline'` (`#custom-css` style tag)
  - `img-src` and `media-src`: `'self' quivit: http://quivit.localhost asset: http://asset.localhost https://asset.localhost blob: data:`
  - `connect-src 'self' ipc: http://ipc.localhost quivit: http://quivit.localhost asset: http://asset.localhost https://asset.localhost blob: data:`
- **Telemetry A/B:** `npm run e2e -- --spec e2e/specs/01-startup.e2e.js`, `05-persistence.e2e.js`, `06-configuration.e2e.js`, `07-os-integration.e2e.js`, `08-url-loader.e2e.js` and `npm run diagnose -- sample-navigation` verifying zero CSP console errors across `http://quivit.localhost`, `http://asset.localhost`, `blob:`, `data:`, WebGL, Lanczos, and `#custom-css`.

### S08-17 `[Nit]` `src-tauri/capabilities/default.json`: prune unused dialog permissions

- **Targets:** `src-tauri/capabilities/default.json:12,16,21-23`
- **Problem:** `dialog:allow-confirm` (`L21`), `dialog:allow-message` (`L22`), and `dialog:allow-ask` (`L23`) have zero callers in `src/`. By contrast, `core:window:allow-set-background-color` (`L12`, invoked by `src/js/shellBackground.js:57`) and `core:window:allow-start-dragging` (`L16`, used by `src/index.html:206` `data-tauri-drag-region`) are actively used.
- **Agreed fix:** Remove `dialog:allow-confirm`, `dialog:allow-message`, and `dialog:allow-ask`; keep `core:window:allow-set-background-color`, `core:window:allow-start-dragging`, `dialog:allow-open`, and `dialog:allow-save` (R2).
- **Telemetry A/B:** `npm run e2e -- --spec e2e/specs/01-startup.e2e.js`, `06-configuration.e2e.js` confirming window background sync, drag region, and file/save dialogs continue working.

### S08-18 `[Nit]` `src-tauri/Cargo.toml`: remove unused direct `encoding_rs` dependency

- **Targets:** `src-tauri/Cargo.toml:25,44`
- **Problem:** `encoding_rs = "0.8"` (`L44`) has zero direct references in `src-tauri/src/` (`archives/encoding.rs` calls `chardetng::EncodingDetector` only). Meanwhile, `"devtools"` (`L25`) must remain enabled per `README.md:150` and R1.
- **Agreed fix:** Remove `encoding_rs = "0.8"` from `Cargo.toml:44` and keep `"devtools"` at `L25`.
- **Telemetry A/B:** `cargo check --tests --manifest-path src-tauri/Cargo.toml` and `cargo test --manifest-path src-tauri/Cargo.toml encoding` verifying clean compilation and archive encoding tests.

### S08-19 `[Blocking]` `src-tauri/src/platform/dialog.rs`: COM `CoUninitialize` imbalance and `PWSTR` memory leak

- **Targets:** `src-tauri/src/platform/dialog.rs:18-35,59-88`
- **Problem:**
  1. `ScopedCoInit::drop` (`L27-33`) calls `CoUninitialize()` unconditionally even when `CoInitializeEx` returns `RPC_E_CHANGED_MODE` (`hr.is_err()`), corrupting the caller thread's COM apartment count.
  2. `item.GetDisplayName(...)` (`L59,73,83`) allocates a `CoTaskMemAlloc` `PWSTR`, and calling `path_pwstr.to_string()` copies the string without freeing it via `CoTaskMemFree` (unlike `com_server.rs:508` and `image_pane.rs:391`).
- **Agreed fix:** Record whether `CoInitializeEx` succeeded (`S_OK` or `S_FALSE`) inside `ScopedCoInit` and only invoke `CoUninitialize()` on drop when initialized. Wrap `PWSTR` conversion in a helper that calls `CoTaskMemFree(Some(pwstr.0.cast()))` before returning.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml dialog_tests` testing `ScopedCoInit` behavior when `CoInitializeEx` encounters `RPC_E_CHANGED_MODE` and helper `CoTaskMemFree` lifecycle.

### S08-20 `[Nit]` `src-tauri/src/platform/direct_open.rs`: skip redundant startup writes while preserving error prefixes

- **Targets:** `src-tauri/src/platform/direct_open.rs:24-37,43-68`
- **Problem:** `record_current_exe()` (`L43-68`) unconditionally overwrites `debug.path`, `release.path`, and `project-root.path` on every non-E2E startup even when the recorded path has not changed.
- **Agreed fix:** Read-compare the existing launch file before writing so unchanged paths skip disk writes at startup. Preserve all public exports (`release_exe`, `selected_exe`, `has_file_open_arg`, `record_current_exe`, `forward_file_open`) and exact `"The {name} build..."` error message prefixes at `L27,32` required by `src/js/options/associationsUi.js:74` and S11 (`Sync F`).
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml direct_open_tests` testing `has_file_open_arg`, `.quivit-open-dev` parsing, skip-unchanged writes, and exact error prefix strings.

### S08-21 `[Warning]` `src-tauri/src/tests/config_tests.rs`: env-var race and S08 unit test gaps

- **Targets:** `src-tauri/src/tests/config_tests.rs:162-168,187-218`
- **Problem:** `test_e2e_suite_non_persistence_and_detection` (`L162-168`) mutates `QUIVIT_E2E_SUITE` without acquiring `OVERRIDE_ENV_LOCK` (`L187`) or using `OverrideEnvGuard` (`L189`), creating a race under parallel `cargo test` execution. In addition, `windows.rs`, `commands/watchers.rs`, `commands/shell.rs`, `utils.rs`, `platform/direct_open.rs`, `platform/dialog.rs`, and `normalize_library_location_paths` have zero unit test coverage.
- **Agreed fix:** Wrap `L162-168` in `OVERRIDE_ENV_LOCK` and `OverrideEnvGuard`, and close the Stage 1 backend test gaps in Telemetry A before production code changes.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml` running all expanded `config_tests` and new `windows_tests`, `watchers_tests`, `utils_tests`, `direct_open_tests`, `dialog_tests`, and `attributes_tests`.

## Cross-split seams

- **Sync A (CSP and capabilities with S01 to S07, S09):** Replace `"csp": null` (`tauri.conf.json:12`) with the R2 directives covering `http://quivit.localhost`, `http://asset.localhost`, `blob:`, `'wasm-unsafe-eval'`, `'unsafe-inline'`, and `ipc: http://ipc.localhost`. Keep `core:window:allow-set-background-color` and `core:window:allow-start-dragging` in `capabilities/default.json`; remove only `dialog:allow-{confirm,message,ask}`. Keep `"devtools"` enabled in `Cargo.toml:25`, `lib.rs:80`, and `windows.rs:147,251,295` per `README.md:150` and R1.
- **Sync D (Multi-window sizing, tray, and persistence with S01, S02, S03, S04, S10):** Clamp `fit_options_window` to `400..=560` and `fit_metadata_window` to `280..=600` (`windows.rs` aligned with `shared/windowFit.js`). Drop the 5-file `load_config` read and `ACTIVE_THEME` clobber from `open_workspace_window`; track tray-hidden windows in `restore_from_tray`; keep `update_theme` IPC stable while S01 gates secondary-window calls. Promote `pending_single_instance` before `load_config_early()`, fix `config.rs:620` roaming-dir re-creation, move `.dev-config` after `direct_open::forward_file_open` (`main.rs`), and share `configured_library_dir` caching and path normalization with S10.
- **Sync E (Rust bootstrap, `models.rs`, `commands/`, and dead IPCs with S09, S10, S11):** Extract `commands/config.rs` (8 cmds) and `commands/windows.rs` (10 active cmds) and declare `commands/icons.rs` (`commands/mod.rs`) per R5. Move `get_library_dir` and `get_default_library_dir` out of `commands/shell.rs` to S10 `commands/library.rs`. Declare `platform/{gdi,associations,shell}.rs` in `platform/mod.rs`. Update `models.rs` with `DirectoryReadResult.has_gallery_sidecar: bool`, `LibraryMoveResult` (S10), and `DimensionEntry` (S09), and drop `PreviewDiagnostic` per R6. Unregister the four dead IPCs (`show_from_tray`, `drop_all_archives_cache`, `get_preview_diagnostics`, `register_associations`, reducing 72 commands to 68 active), remove `lib.rs:17-20` wildcard imports, adopt `crate::network::DownloadCancelFlag` (`S10`) and `crate::archives::*` (`S09`), move `lib.rs:208-218` `#[path]` test mounts into owner modules, migrate `attributes.rs:80-97` to `tests/attributes_tests.rs`, and filter `.tmp` files in `commands/watchers.rs`.
- **Sync F (`direct_open`, `utils`, and `main.rs` with S03, S09, S10, S11):** Preserve `--previews-thumb` and `--previews-pane` / `--preview-handler` entrypoints in `main.rs` (`S11`). Preserve `platform/direct_open.rs` exports and `"The {name} build..."` error prefixes (`S11`, `S03`). Keep `utils::base64_decode_bytes` compatible with both unpadded URL-safe (`fsUtils.js`) and padded standard (`protocol_tests`, `ico_tests`, `drop.rs`) inputs (`S09`, `S10`).

## Telemetry A/B specification

- **`cargo test --manifest-path src-tauri/Cargo.toml` (primary suite):**
  - *Baseline:* `config::tests` (14 passing) and `platform::attributes::tests` (1 passing).
  - *Telemetry A additions:* Fix `config_tests.rs:162-168` `OVERRIDE_ENV_LOCK` + `OverrideEnvGuard`; move `attributes` test to `src-tauri/src/tests/attributes_tests.rs`; expand `config_tests` (`normalize_library_location_paths`, `display_path`, `same_library_location`, roaming-to-portable non-recreation, startup `pending_single_instance` promotion); add `tests/windows_tests.rs` (theme encoding, workspace label validation, monitor clamp math, `400..=560` and `280..=600` clamping, tray-hidden window tracking); add `tests/watchers_tests.rs` (event filter predicate, `.tmp` exclusion, 250 ms debounce coalescing); add `tests/utils_tests.rs` (URL-safe unpadded and standard padded `base64_decode_bytes`, `url_decode` fast path); add `tests/direct_open_tests.rs` (`has_file_open_arg`, `.quivit-open-dev` parsing, skip-unchanged write, error prefix contract); add `tests/dialog_tests.rs` (`ScopedCoInit` on `RPC_E_CHANGED_MODE`).
  - *Telemetry B checks:* All Cargo tests pass with zero inline `#[cfg(test)]` modules remaining in S08 files, zero temp-string allocations in `base64_decode_bytes`, single-read startup config resolution, and cached `configured_library_dir` lookups.
- **`npm run e2e -- --spec <file>` (integration suite):**
  - *Specs:* `e2e/specs/01-startup.e2e.js`, `05-persistence.e2e.js`, `06-configuration.e2e.js`, `07-os-integration.e2e.js`, and `08-url-loader.e2e.js`.
  - *Telemetry A/B checks:* Confirm tightened R2 CSP permits `http://quivit.localhost`, `http://asset.localhost`, `blob:` extractors, `pica.js` WASM worker, `data:`, and `#custom-css` with zero console CSP violations; verify `workspace-file-list` detach/close/theme sync, `hide_to_tray`/restore without flashing hidden windows, coalesced `directory-changed` reloads, `shellBackground.js` background sync, `data-tauri-drag-region`, and 1:1 parity after removing `show_from_tray`.
- **`npm run diagnose -- sample-navigation` (read-only seam check):**
  - Confirm `ipcProtocolProbe.js` records zero protocol or IPC errors under the new CSP and `DirectoryReadResult.has_gallery_sidecar` update.
- **`npm run mocha` (read-only contract check):**
  - Confirm `diagnosticsContract.test.js` passes unchanged.
