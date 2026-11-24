# Telemetry comparisons

Branch: `refactor/decoupling-and-perf`
Status: Initialized. All units `U01` through `U11` await Telemetry A baseline capture.

This ledger tracks pre-refactor (Telemetry A) and post-refactor (Telemetry B) measurements for every execution unit in [roadmap.md](file:///D:/Projects/QuiviT/.agents/major-refactor/roadmap.md). No unit moves past Telemetry B until baseline and post JSON files exist on disk, every parity gate passes, and every measured delta meets or beats its target with zero regressions.

## Four-suite commands and artifact convention

Every Telemetry A and B run maps to one or more of the four repository suites:

| Suite | Runnable command | Pre-refactor baseline note |
|---|---|---|
| Mocha unit tests | `npm run mocha` | 308 passing (`package.json` defines `npm run mocha`, no `npm test`) |
| Rust backend tests | `cargo test --manifest-path src-tauri/Cargo.toml` (with optional filter) | 111 passing crate lib tests |
| Desktop E2E tests | `npm run e2e -- --spec e2e/specs/<file>.e2e.js` | Re-run with `--agent` only if an elevated shell warning occurs |
| Replay diagnostics | `npm run diagnose -- <scenario>` | Runs `e2e/replay-diagnostics/` probes against `e2e/scenarios/<scenario>.json` |

Save every captured run under `.agents/major-refactor/telemetry/` with this naming rule:

- Telemetry A baseline: `.agents/major-refactor/telemetry/uXX-baseline-<suite>.json`
- Telemetry B post-refactor: `.agents/major-refactor/telemetry/uXX-post-<suite>.json`

Use exact `<suite>` tokens: `mocha`, `cargo`, `e2e-01-startup` through `e2e-08-url-loader`, and `diagnose-<scenario>`.

Commit gate rule per unit:

1. Telemetry A expands unit tests, E2E checks, or probe fixes against pre-refactor code, writes all unit baseline JSON files, fills the `Baseline (Telemetry A)` column below, and pauses for a commit before production code edits begin.
2. Production refactor commits land for the unit.
3. Telemetry B updates contract test imports for extracted files, adds post-refactor structural assertions, runs the exact same suite commands, writes all unit post JSON files, fills the `Post (Telemetry B)` and `Verdict` columns below, confirms 1:1 parity plus accepted gains with zero regressions, and pauses for a commit.

## Execution units and parallel tracks

| Unit | Slug | Stage 3 split | Findings | Depends on | Parallel with | Status |
|---|---|---|---|---|---|---|
| `U01` | `be-core-windows-config` | S08 | `S08-01` to `S08-21` | None | None | Pending |
| `U02` | `be-media-archives-protocol` | S09 | `S09-01` to `S09-10` | `U01` | None | Pending |
| `U03` | `be-fs-library-network-drop` | S10 | `S10-01` to `S10-14` | `U01`, `U02` | None | Pending |
| `U04` | `be-previews-registry` | S11 | `S11-01` to `S11-10` | `U02`, `U03` | `U05` | Pending |
| `U05` | `fe-core-fs-workspace` | S01 | `S01-01` to `S01-19` | `U01`, `U03` | `U04` | Pending |
| `U06` | `fe-shell-css-chrome` | S02 | `S02-01` to `S02-12` | `U04`, `U05` | None | Pending |
| `U07` | `fe-options-metadata` | S03 | `S03-01` to `S03-10` | `U05`, `U06` | `U08` to `U11` | Pending |
| `U08` | `fe-filepanel` | S04 | `S04-01` to `S04-17` | `U05`, `U06` | `U07` | Pending |
| `U09` | `fe-urlloader` | S05 | `S05-01` to `S05-06` | `U03`, `U06`, `U08` | `U07` | Pending |
| `U10` | `fe-viewer-strip` | S06 | `S06-01` to `S06-12` | `U02`, `U05`, `U06`, `U09` | `U07` | Pending |
| `U11` | `fe-viewer-webgl` | S07 | `S07-01` to `S07-11` | `U01`, `U06`, `U09`, `U10` | `U07` | Pending |

## Stage 1 coverage gap closure

All nine modules flagged with zero unit test coverage in Stage 1 close during Telemetry A of their owning unit:

| Stage 1 gap | Closing unit(s) | Telemetry A test additions | Status |
|---|---|---|---|
| `src/js/fsUtils.js` | `U05` | Mocha suites for `fsUtils` and extracted `services/{mediaFormats,mediaUrls,listNavigation}.js` plus E2E and `diagnose` | Pending |
| `src/js/shared/workspace*` | `U05`, `U06`, `U08`, `U10`, `U01` | Mocha suites for `workspaceLayout`, `workspaceHost`, `workspaceSession`, `workspaceControls` plus detached `?surface=fileList` E2E parity | Pending |
| `src/js/filepanel/libraryStore.js` and `favoritesStore.js` | `U08` | `mocha/libraryStore.test.js`, `mocha/favoritesStore.test.js`, `mocha/filePanelMath.test.js` plus `05-persistence` and `08-url-loader` E2E | Pending |
| `src-tauri/src/windows.rs` | `U01` | `src-tauri/src/tests/windows_tests.rs` via `#[path]` plus `01-startup`, `06-configuration`, `07-os-integration` E2E | Pending |
| `src-tauri/src/commands/watchers.rs` | `U01` | `src-tauri/src/tests/watchers_tests.rs` via `#[path]` plus coalesced `directory-changed` E2E | Pending |
| `src-tauri/src/commands/animation.rs` | `U02` | `src-tauri/src/tests/animation_tests.rs` via `#[path]` plus `03-viewer`, `04-archives` E2E and `diagnose -- manhwa-width-span` | Pending |
| `src-tauri/src/image_import.rs` | `U03` | `src-tauri/src/tests/image_import_tests.rs` via `#[path]` plus `07-os-integration` E2E | Pending |
| `src-tauri/src/commands/drop.rs` and `platform/drop.rs` | `U03` | `src-tauri/src/tests/drop_tests.rs` via `#[path]` plus `07-os-integration` E2E | Pending |
| `src-tauri/src/commands/registry.rs` | `U04` | `src-tauri/src/tests/registry_tests.rs` via `#[path]` (0 HKCU writes), `mocha/previewPlayer.test.js`, plus `06-configuration` and `07-os-integration` E2E | Pending |

## Global parity gates

Every unit must hold these invariants on Telemetry B:

- Zero regressions across all existing and Telemetry A tests in every applicable suite.
- Zero `blackout`, `ty-teleport`, `unknown-action`, `action-error`, or `ipc-error` anomalies in replay diagnostics.
- Zero console CSP violations after `U01` enables the explicit R2 CSP in `src-tauri/tauri.conf.json:12`.
- All 68 active IPC commands, 10 Rust-to-JS events, 4 `quivit://` routes, `quivit-preview://` scheme, 14 scenario actions, and locked E2E page-object selectors keep identical contracts.

---

## U01: `be-core-windows-config` (S08)

Scope: `S08-01` to `S08-21` (`Cargo.toml`, `tauri.conf.json`, `capabilities/default.json`, `main.rs`, `lib.rs`, `models.rs`, `utils.rs`, `config.rs` -> `commands/config.rs`, `windows.rs` -> `commands/windows.rs`, `commands/shell.rs` -> `platform/shell.rs`, `commands/watchers.rs`, `platform/{attributes,dialog,direct_open}.rs`, `tests/config_tests.rs`).
Depends on: None. Parallel with: None.

### Runnable commands

- Rust backend (primary): `cargo test --manifest-path src-tauri/Cargo.toml`
- Desktop E2E: `npm run e2e -- --spec e2e/specs/01-startup.e2e.js`, `npm run e2e -- --spec e2e/specs/05-persistence.e2e.js`, `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js`, `npm run e2e -- --spec e2e/specs/07-os-integration.e2e.js`, `npm run e2e -- --spec e2e/specs/08-url-loader.e2e.js`
- Replay diagnostics (read-only seam check): `npm run diagnose -- sample-navigation`
- Mocha (read-only contract check): `npm run mocha`

### Artifact paths

| Suite | Baseline (Telemetry A) | Post (Telemetry B) |
|---|---|---|
| Cargo | `.agents/major-refactor/telemetry/u01-baseline-cargo.json` | `.agents/major-refactor/telemetry/u01-post-cargo.json` |
| Mocha (read-only) | `.agents/major-refactor/telemetry/u01-baseline-mocha.json` | `.agents/major-refactor/telemetry/u01-post-mocha.json` |
| E2E `01-startup` | `.agents/major-refactor/telemetry/u01-baseline-e2e-01-startup.json` | `.agents/major-refactor/telemetry/u01-post-e2e-01-startup.json` |
| E2E `05-persistence` | `.agents/major-refactor/telemetry/u01-baseline-e2e-05-persistence.json` | `.agents/major-refactor/telemetry/u01-post-e2e-05-persistence.json` |
| E2E `06-configuration` | `.agents/major-refactor/telemetry/u01-baseline-e2e-06-configuration.json` | `.agents/major-refactor/telemetry/u01-post-e2e-06-configuration.json` |
| E2E `07-os-integration` | `.agents/major-refactor/telemetry/u01-baseline-e2e-07-os-integration.json` | `.agents/major-refactor/telemetry/u01-post-e2e-07-os-integration.json` |
| E2E `08-url-loader` | `.agents/major-refactor/telemetry/u01-baseline-e2e-08-url-loader.json` | `.agents/major-refactor/telemetry/u01-post-e2e-08-url-loader.json` |
| Diagnose `sample-navigation` | `.agents/major-refactor/telemetry/u01-baseline-diagnose-sample-navigation.json` | `.agents/major-refactor/telemetry/u01-post-diagnose-sample-navigation.json` |

### Telemetry A additions

- Wrap `src-tauri/src/tests/config_tests.rs:162-168` in `OVERRIDE_ENV_LOCK` and `OverrideEnvGuard`.
- Expand `config_tests.rs` with `normalize_library_location_paths`, `display_path`, `same_library_location`, roaming-to-portable non-recreation, and startup `pending_single_instance` promotion.
- Add `src-tauri/src/tests/windows_tests.rs` (theme encoding, workspace label validation, monitor clamp math, `400..=560` and `280..=600` bounds, tray-hidden tracking) and `src-tauri/src/tests/watchers_tests.rs` (event filter predicate, `.tmp` exclusion, 250ms trailing debounce coalescing).
- Add `src-tauri/src/tests/utils_tests.rs` (URL-safe unpadded and standard padded `base64_decode_bytes`, `url_decode` fast path), `src-tauri/src/tests/direct_open_tests.rs` (`has_file_open_arg`, `.quivit-open-dev`, skip-unchanged writes, error prefix strings), and `src-tauri/src/tests/dialog_tests.rs` (`ScopedCoInit` on `RPC_E_CHANGED_MODE`).
- Migrate `platform/attributes.rs:80-97` inline test into `src-tauri/src/tests/attributes_tests.rs` via `#[path]`.

### Comparison table

| Metric or invariant | Baseline (Telemetry A) | Post (Telemetry B) | Pass criterion | Verdict |
|---|---|---|---|---|
| Cargo tests (`config`, `windows`, `watchers`, `utils`, `direct_open`, `dialog`, `attributes`) | Pending | Pending | 100% pass, 0 inline `#[cfg(test)]` in S08 files | Pending |
| `base64_decode_bytes` temp `String` allocations per call | 4 (measured in audit) | Pending | 0 intermediate `String` allocations; 100% parity on URL-safe and standard inputs | Pending |
| Startup `quivit_config.json` reads before first paint | 3 to 5 reads | Pending | 1 read in `lib.rs::run()`; `cleanup_orphaned_temp_dirs` and watchers off main thread | Pending |
| `open_workspace_window` disk config reads and theme clobber | 5-file `load_config` read | Pending | 0 disk reads; inherits `active_tauri_theme()` without clobbering live preview | Pending |
| `watch_directory` multi-file burst events | 1 event per raw FS event | Pending | Coalesced with 250ms trailing debounce; 0 events for `.tmp` sibling files | Pending |
| `fit_options_window` / `fit_metadata_window` bounds | Unclamped | Pending | Enforced `400..=560` and `280..=600` in Rust; 0 hidden-window tray flash | Pending |
| R2 CSP console violations across E2E `01`, `05`, `06`, `07`, `08` and `sample-navigation` | Pending | Pending | 0 CSP errors across `quivit:`, `asset:`, `blob:`, `data:`, WASM workers, `#custom-css` | Pending |
| Dead IPC and dependency removal | `show_from_tray`, `encoding_rs`, 3 dialog perms present | Pending | All removed cleanly; `devtools` retained per R1; `diagnosticsContract.test.js` green | Pending |

---

## U02: `be-media-archives-protocol` (S09)

Scope: `S09-01` to `S09-10` (`protocol.rs`, `formats.rs` -> `formats/*`, `ico.rs`, `archives/*`, `commands/{archives,animation}.rs`, `platform/{gdi,icons,thumbnails}.rs`, `models.rs` `DimensionEntry`, `lib.rs` `drop_all_archives_cache` removal and test mounts, `tests/{archive,format,ico,protocol}_tests.rs`).
Depends on: `U01`. Parallel with: None.

### Runnable commands

- Rust backend (primary): `cargo test --manifest-path src-tauri/Cargo.toml`
- Desktop E2E: `npm run e2e -- --spec e2e/specs/03-viewer.e2e.js`, `npm run e2e -- --spec e2e/specs/04-archives.e2e.js`, `npm run e2e -- --spec e2e/specs/07-os-integration.e2e.js`
- Replay diagnostics: `npm run diagnose -- manhwa-width-span`, `npm run diagnose -- manhwa-buffer`, `npm run diagnose -- manhwa-directory-entry-fits`, `npm run diagnose -- manhwa-gif-bridge`, `npm run diagnose -- manhwa-video-bridge`
- Mocha (read-only contract check): `npm run mocha`

### Artifact paths

| Suite | Baseline (Telemetry A) | Post (Telemetry B) |
|---|---|---|
| Cargo | `.agents/major-refactor/telemetry/u02-baseline-cargo.json` | `.agents/major-refactor/telemetry/u02-post-cargo.json` |
| Mocha (read-only) | `.agents/major-refactor/telemetry/u02-baseline-mocha.json` | `.agents/major-refactor/telemetry/u02-post-mocha.json` |
| E2E `03-viewer` | `.agents/major-refactor/telemetry/u02-baseline-e2e-03-viewer.json` | `.agents/major-refactor/telemetry/u02-post-e2e-03-viewer.json` |
| E2E `04-archives` | `.agents/major-refactor/telemetry/u02-baseline-e2e-04-archives.json` | `.agents/major-refactor/telemetry/u02-post-e2e-04-archives.json` |
| E2E `07-os-integration` | `.agents/major-refactor/telemetry/u02-baseline-e2e-07-os-integration.json` | `.agents/major-refactor/telemetry/u02-post-e2e-07-os-integration.json` |
| Diagnose `manhwa-width-span` | `.agents/major-refactor/telemetry/u02-baseline-diagnose-manhwa-width-span.json` | `.agents/major-refactor/telemetry/u02-post-diagnose-manhwa-width-span.json` |
| Diagnose `manhwa-buffer` | `.agents/major-refactor/telemetry/u02-baseline-diagnose-manhwa-buffer.json` | `.agents/major-refactor/telemetry/u02-post-diagnose-manhwa-buffer.json` |
| Diagnose `manhwa-directory-entry-fits` | `.agents/major-refactor/telemetry/u02-baseline-diagnose-manhwa-directory-entry-fits.json` | `.agents/major-refactor/telemetry/u02-post-diagnose-manhwa-directory-entry-fits.json` |
| Diagnose `manhwa-gif-bridge` | `.agents/major-refactor/telemetry/u02-baseline-diagnose-manhwa-gif-bridge.json` | `.agents/major-refactor/telemetry/u02-post-diagnose-manhwa-gif-bridge.json` |
| Diagnose `manhwa-video-bridge` | `.agents/major-refactor/telemetry/u02-baseline-diagnose-manhwa-video-bridge.json` | `.agents/major-refactor/telemetry/u02-post-diagnose-manhwa-video-bridge.json` |

### Telemetry A additions

- Remove hardcoded `C:\Users\x4163\...` paths in `format_tests.rs:261,266`, assert fixture presence in `archive_tests.rs:192`, scope temp dirs per PID/test in `archive_tests.rs:221-319`, and update synthetic APNG slices in `format_tests.rs:126-147` to valid `IHDR`/`acTL`/`IDAT` chunk framing alongside `test-files/animated/*.apng`.
- Expand `format_tests.rs` (`read_mp4_dimensions`, `read_mp4_dimensions_stream` chunked `Read` + `size32 == 0` + `tkhd` v0/v1, JPEG >64 KiB EXIF, AVIF `ispe`+`irot`, ICO, SVG, path/stream media dims, SVG animation, TIFF orientation/limits).
- Expand `ico_tests.rs` (`ico_spritesheet_from_bytes`, BMP-masked frames, `ico_frames_from_path` limit, overlapping-offset DoS cap) and `protocol_tests.rs` (route collisions `/archive/<b64>/{icon,thumb,tiff}/1.png`, `?size=32`, invalid TIFF 422).
- Expand `archive_tests.rs` (`read_plain_zip_entry_shared` hit/miss/concurrent/CJK/password, non-blocking `read_entry_header`, `list_archive_names`, TAR `entries_with_seek` parity on `test-files/_archives/tar.tar`, `drop_archive` cleanup, `max_open_archives == 0` guard).
- Add `src-tauri/src/tests/animation_tests.rs`, `icons_tests.rs`, and `thumbnails_tests.rs` via `#[path]`.
- Expand E2E `03-viewer` / `04-archives` with TIFF (`test-files/50-51.tif`), animated APNG/AVIF/WebP/GIF (`test-files/animated/*`), and width/dims scan completion.

### Comparison table

| Metric or invariant | Baseline (Telemetry A) | Post (Telemetry B) | Pass criterion | Verdict |
|---|---|---|---|---|
| Cargo tests (`archives`, `formats`, `ico`, `protocol`, `animation`, `icons`, `thumbnails`) | Pending | Pending | 100% pass; `archive_tests` and `format_tests` mounted in `archives/mod.rs` and `formats/mod.rs` | Pending |
| `ArchiveCache` write-lock stall during RAR/7z `check_is_animated` or ZIP prefetch | Blocks concurrent `/archive/` | Pending | 0 blocking waits on concurrent `read_plain_zip_entry_shared` / `/archive/` calls | Pending |
| Unlocked ZIP CJK entry lookup and EOCD scan | O(N) `chardetng` scan + 128 KiB tail scan per miss | Pending | O(1) `Arc<HashMap>` `zip_index_map` hit; 4 KiB fast tail scan | Pending |
| `list_tar_entries` on `test-files/_archives/tar.tar` (92 MB) | Full sequential read (Pending ms) | Pending | Seek-based O(entries) listing; measurable latency drop with 1:1 entry parity | Pending |
| MP4 `moov` `size32 == 0` buffer allocation and chunked `ZipFile` read | 10 MiB upfront zero-alloc + short-read truncation | Pending | 0 upfront 10 MiB alloc (`min(64 KiB)` growth); full chunked stream read | Pending |
| `protocol.rs` route collisions (`/archive/.../{icon,thumb,tiff}/...`) | HTTP 400 mismatch | Pending | Prefix-routed to `/archive/`; cached `/icon/` skips `spawn_blocking` | Pending |
| `thumbnails.rs` non-matte disk reads and `NATIVE_ICON_CACHE` bound | Unconditional `source_has_transparency` open; unbounded `HashMap` | Pending | 0 disk opens when opaque/non-matte; `MAX_NATIVE_ICON_CACHE_ENTRIES` enforced; fast PNG encode | Pending |
| Replay `ipcProtocolProbe` p95 `/archive/` and `check_is_animated` latency (`manhwa-buffer`, `manhwa-width-span`) | Pending | Pending | Lower p95 under concurrent prefetch; 0 protocol/IPC errors; 0 blackout frames | Pending |
| Dead IPC `drop_all_archives_cache` removal and facade check | Present; `pub(crate) mod cache` | Pending | Removed from `commands/archives.rs` and `lib.rs`; `mod cache` private; all 13 active S09 IPCs intact | Pending |

---

## U03: `be-fs-library-network-drop` (S10)

Scope: `S10-01` to `S10-14` (`library.rs`, `network.rs`, `commands/{directory,library,network,drop,shell,config,archives:82}.rs`, `image_import.rs`, `platform/{shell,drop/*,temp_archive/*}.rs`, `models.rs` `LibraryMoveResult` + `has_gallery_sidecar`, `lib.rs` `DownloadCancelFlag` and `temp_archive_tests` mount, 22 inline test migrations).
Depends on: `U01`, `U02`. Parallel with: None.

### Runnable commands

- Rust backend (primary): `cargo test --manifest-path src-tauri/Cargo.toml`
- Desktop E2E: `npm run e2e -- --spec e2e/specs/01-startup.e2e.js`, `npm run e2e -- --spec e2e/specs/02-navigation.e2e.js`, `npm run e2e -- --spec e2e/specs/05-persistence.e2e.js`, `npm run e2e -- --spec e2e/specs/07-os-integration.e2e.js`, `npm run e2e -- --spec e2e/specs/08-url-loader.e2e.js`
- Replay diagnostics (read-only contract check): `npm run diagnose -- sample-navigation`
- Mocha (read-only contract check): `npm run mocha`

### Artifact paths

| Suite | Baseline (Telemetry A) | Post (Telemetry B) |
|---|---|---|
| Cargo | `.agents/major-refactor/telemetry/u03-baseline-cargo.json` | `.agents/major-refactor/telemetry/u03-post-cargo.json` |
| Mocha (read-only) | `.agents/major-refactor/telemetry/u03-baseline-mocha.json` | `.agents/major-refactor/telemetry/u03-post-mocha.json` |
| E2E `01-startup` | `.agents/major-refactor/telemetry/u03-baseline-e2e-01-startup.json` | `.agents/major-refactor/telemetry/u03-post-e2e-01-startup.json` |
| E2E `02-navigation` | `.agents/major-refactor/telemetry/u03-baseline-e2e-02-navigation.json` | `.agents/major-refactor/telemetry/u03-post-e2e-02-navigation.json` |
| E2E `05-persistence` | `.agents/major-refactor/telemetry/u03-baseline-e2e-05-persistence.json` | `.agents/major-refactor/telemetry/u03-post-e2e-05-persistence.json` |
| E2E `07-os-integration` | `.agents/major-refactor/telemetry/u03-baseline-e2e-07-os-integration.json` | `.agents/major-refactor/telemetry/u03-post-e2e-07-os-integration.json` |
| E2E `08-url-loader` | `.agents/major-refactor/telemetry/u03-baseline-e2e-08-url-loader.json` | `.agents/major-refactor/telemetry/u03-post-e2e-08-url-loader.json` |
| Diagnose `sample-navigation` | `.agents/major-refactor/telemetry/u03-baseline-diagnose-sample-navigation.json` | `.agents/major-refactor/telemetry/u03-post-diagnose-sample-navigation.json` |

### Telemetry A additions

- Migrate all 22 inline `#[cfg(test)]` tests (`directory` 5, `library` 1, `network` 16) into `src-tauri/src/tests/{directory_tests,library_tests,network_tests}.rs` via `#[path]` using isolated RAII temp dirs and deterministic in-repo fixtures (removing CWD, live-config, and `opencode/kmanga-page1.jpg` dependencies).
- Expand `directory_tests` (`has_gallery_sidecar`, `get_path_kind`, `find_directory_metadata` priority, minimal `read_gallery_metadata`, placeholder traversal rejection), `library_tests` (lock contention, retired-path rejection, `remap_path` casing and `|` archive entries, capture dedup/conflict, reparse rejection), and `network_tests` (scoped `DownloadCancelFlag`, fetch size caps, 1600x2182 descramble timing baseline).
- Add `src-tauri/src/tests/image_import_tests.rs` (headers, SVG limits, DIB V3/V4/V5 bitfields, dimensions, `PreparedImage.hash`) and `src-tauri/src/tests/drop_tests.rs` (`parse_local_path`, `commands::drop` `workspace_only` + retryable publish, `Capture::drop`, `Registry` lease/cancel/timeout).
- Expand `temp_archive_tests.rs` (`WinZip`/`PeaZip` matching, `WindowsExplorer` filename pre-filter, `scan_folder_archives` dir dedup, `resolve_temp_origin_with_cache`, explicit fixture assertion).

### Comparison table

| Metric or invariant | Baseline (Telemetry A) | Post (Telemetry B) | Pass criterion | Verdict |
|---|---|---|---|---|
| Cargo tests (`directory`, `library`, `network`, `image_import`, `drop`, `temp_archive`) | Pending (39 pre-existing) | Pending | 100% pass; 0 inline `#[cfg(test)]` in S10 files; `temp_archive_tests` mounted in `platform/temp_archive/mod.rs` | Pending |
| `read_directory_impl` `input_path` stats and `quivit_config.json` reads | 3 stats + 1 disk config read per call | Pending | 1 `fs::metadata` call; 0 disk config reads on cached `configured_library_dir`; populates `has_gallery_sidecar` | Pending |
| `find_directory_metadata` directory scan allocations | Full `Vec<DirEntry>` + up to 6 scans | Pending | O(1) candidate probe (or single pass), 0 `Vec<DirEntry>` alloc | Pending |
| `download_to_file` per-32 KiB-chunk lock stats and staging copy | ~640 stats per 10 MiB + cross-volume `EXDEV` copy | Pending | 0 per-chunk lock stats; same-volume `.tmp` staging; scoped `cancel_scope` isolates raw downloads | Pending |
| `apply_tile_descramble` on 1600x2182 fixture | 2x RAM clone + per-tile alloc (Pending ms) | Pending | `>= 2x` speedup; 0 full-image clone; 0 per-tile heap alloc; pixel-identical output | Pending |
| `platform/drop` lock contention and watchdog idle wakeups | Lock held across 8 MiB `svg_text`; 1 Hz forever loop | Pending | 0 mutex hold during `svg_text`; `Condvar` 0 idle wakeups and clean `shutdown()` exit; zero-copy `HGLOBAL` stream | Pending |
| `platform/temp_archive` UIA spawns, WindowStation mutation, and folder scan dedup | `SetProcessWindowStation` mutation; UIA per window for all engines; up to 10x dir rescans | Pending | 0 `SetProcessWindowStation` calls; 0 UIA spawns for non-7z engines; 0 duplicate folder scans; no `tauri::State` in `platform/` | Pending |
| Live E2E parity across all 23 active S10 IPCs and 3 Rust-to-JS events | Pending | Pending | 100% pass across `01`, `02`, `05`, `07`, `08`; `quivit-drop` targets `"main"` and Recycle Bin fallback intact | Pending |

---

## U04: `be-previews-registry` (S11)

Scope: `S11-01` to `S11-10` (`commands/registry.rs`, `commands/icons.rs`, `commands/mod.rs`, `platform/mod.rs`, `platform/associations.rs`, `platform/previews/{host,thumb_decoders,windows}.rs`, `platform/previews/windows/{bitmap,com_server->7 modules,image_pane+media_loader,registration,thumb_proxy,thumb_server,preview_player.js}`, `models.rs` `PreviewDiagnostic` removal, `lib.rs` dead IPC and final wildcard removal, `tests/{previews,registry}_tests.rs`, `mocha/previewPlayer.test.js`).
Depends on: `U02`, `U03`. Parallel with: `U05`.

### Runnable commands

- Rust backend (primary): `cargo test --manifest-path src-tauri/Cargo.toml`
- Mocha frontend (`preview_player.js` + read-only `diagnosticsContract`): `npm run mocha`
- Desktop E2E: `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js`, `npm run e2e -- --spec e2e/specs/07-os-integration.e2e.js`
- Replay diagnostics: N/A (out-of-proc Explorer COM preview/thumbnail handlers and Windows registry commands)

### Artifact paths

| Suite | Baseline (Telemetry A) | Post (Telemetry B) |
|---|---|---|
| Cargo | `.agents/major-refactor/telemetry/u04-baseline-cargo.json` | `.agents/major-refactor/telemetry/u04-post-cargo.json` |
| Mocha | `.agents/major-refactor/telemetry/u04-baseline-mocha.json` | `.agents/major-refactor/telemetry/u04-post-mocha.json` |
| E2E `06-configuration` | `.agents/major-refactor/telemetry/u04-baseline-e2e-06-configuration.json` | `.agents/major-refactor/telemetry/u04-post-e2e-06-configuration.json` |
| E2E `07-os-integration` | `.agents/major-refactor/telemetry/u04-baseline-e2e-07-os-integration.json` | `.agents/major-refactor/telemetry/u04-post-e2e-07-os-integration.json` |

### Telemetry A additions

- Wrap `unique_dir` in `src-tauri/src/tests/previews_tests.rs:4-17` with an RAII `TempDir` guard deleting `%TEMP%\quivit-previews-test-*` on `Drop`.
- Expand `previews_tests.rs` for `avif_sequence::{is_avif, first_frame}`, `thumb_decoders::{decode_first_frame, webp_frame_input, render_svg, check_dimensions}` (>16 MiB non-image fast reject), `archive_tree`, `icon_cache::parse_icon_path`, `media_loader::MediaKind::for_path`, `theme` luminance, streaming SHA-256 + skip-copy + `.tmp` rename-failure cleanup, and `windows::registration` pure helpers.
- Add `src-tauri/src/tests/registry_tests.rs` via `#[path]` (0 production HKCU writes) covering ProgId/command formatting, icon-stamp fast path, and exact locked error prefix strings.
- Add `mocha/previewPlayer.test.js` testing `preview_player.js` (SVG length parsing, frame duration/`MIN_REPLAY_HOLD_MS`, single `/media` fetch, `ImageDecoder` fallback to `showNative`, specific error surfacing, `Blob` URL revocation, classic `<script defer>` WebView2 compatibility).
- Expand `07-os-integration.e2e.js` to verify all 22 `SUPPORTED_FORMATS`, `get_native_icon`, and `invalidate_native_icon_cache`; expand `06-configuration.e2e.js` File Types tab `sync_preview_associations` no-op under `QUIVIT_E2E_SUITE`.

### Comparison table

| Metric or invariant | Baseline (Telemetry A) | Post (Telemetry B) | Pass criterion | Verdict |
|---|---|---|---|---|
| Cargo tests (`previews`, `registry`) and `build.rs` proxy DLL build | Pending (12 pre-existing) | Pending | 100% pass; 0 leaked `%TEMP%\quivit-previews-test-*` dirs; `quivit-thumbnail-proxy.dll` compiles cleanly | Pending |
| Mocha `previewPlayer.test.js` `/media` fetches per static raster or SVG | 2 fetches (double `media.to_vec()`) | Pending | 1 `/media` fetch; 0 unrevoked `Blob` URLs on reload/close; fallback to `showNative` works | Pending |
| Release `QuiviT-preview.log` trace writes per thumbnail/preview call | 3 to 10 sync file opens per call | Pending | 0 trace writes when release-gated and `QUIVIT_PREVIEW_LOG` unset; error log capped at 1 MiB | Pending |
| `archive_render.rs` per-frame `CreateSolidBrush`/`CreatePen` calls | 10 to 15 GDI allocs/frame + double `WM_ERASEBKGND` paint | Pending | 0 `CreateSolidBrush`/`CreatePen` in `archive_render.rs`; `WM_ERASEBKGND` returns `LRESULT(1)` | Pending |
| `thumb_decoders` SVG premultiply roundtrip and `rgba_from_pixels` allocs | Divide-then-multiply + geometric `Flatten` realloc | Pending | Premultiplied direct R/B swap (0 division); single `Vec::with_capacity` in `rgba_from_pixels` | Pending |
| `thumb_server` concurrency and `thumb_proxy` unsupported-IID gating | STA + global `DECODE_LOCK`; spawns server before IID check | Pending | MTA + bounded semaphore (2 to 4); `E_NOINTERFACE` before `CoCreateInstance`; `IStream::Stat` pre-size | Pending |
| Startup `host.rs` and `provision_format_icons` disk I/O | Full EXE heap read + unconditional rewrite + 22 `.ico` byte reads | Pending | 64 KiB streaming hash; skip-copy on matching EXE; 0 duplicate `proxy.dll` hash; stamp-gated `.ico` fast path | Pending |
| COM safety and dead IPC removal | 5 `.lock().unwrap()` in COM; `get_preview_diagnostics`, `register_associations`, `PreviewDiagnostic` present | Pending | 0 `.lock().unwrap()` across COM; `WM_NCDESTROY` clears `GWLP_USERDATA`; dead IPCs/struct removed; all 6 active S11 IPCs pass E2E | Pending |

---

## U05: `fe-core-fs-workspace` (S01)

Scope: `S01-01` to `S01-19` (`core.js`, `fsUtils.js` -> `services/{mediaFormats,mediaUrls,listNavigation}.js`, `directoryPrefs.js`, `navigationHistory.js`, `keybinds.js` -> `services/configSchema.js`, `keyboardNav.js`, `shortcuts.js`, `services/{actions,archiveImageCache,keybindDomain,keyCombo,sorting,cache,workspaceLayout}.js`, `shared/{theme,themePrePaint,configPreview,workspaceControls,workspaceHost,workspaceSession}.js`). Retains guarded `typeof window !== 'undefined'` browser-runtime DI fallbacks (removed across `U06`, `U08`, `U09`), `export let previewing` alongside `isPreviewing()` until `U07`, `FsUtils.buildAudioSrc` until `U10` removes `#viewer-audio` (R4), and `themePrePaint.js` fallback until `U07` finishes `options.html`/`metadata.html` `<head>` order.
Depends on: `U01`, `U03`. Parallel with: `U04`.

### Runnable commands

- Mocha unit tests (primary): `npm run mocha`
- Desktop E2E: `npm run e2e -- --spec e2e/specs/01-startup.e2e.js`, `npm run e2e -- --spec e2e/specs/02-navigation.e2e.js`, `npm run e2e -- --spec e2e/specs/03-viewer.e2e.js`, `npm run e2e -- --spec e2e/specs/04-archives.e2e.js`, `npm run e2e -- --spec e2e/specs/05-persistence.e2e.js`, `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js`, `npm run e2e -- --spec e2e/specs/07-os-integration.e2e.js`
- Replay diagnostics: `npm run diagnose -- sample-navigation`, `npm run diagnose -- filter-navigation`, `npm run diagnose -- manhwa-buffer`
- Rust backend (read-only seam check): `cargo test --manifest-path src-tauri/Cargo.toml config::tests`, `cargo test --manifest-path src-tauri/Cargo.toml directory`, `cargo test --manifest-path src-tauri/Cargo.toml windows::tests`

### Artifact paths

| Suite | Baseline (Telemetry A) | Post (Telemetry B) |
|---|---|---|
| Mocha | `.agents/major-refactor/telemetry/u05-baseline-mocha.json` | `.agents/major-refactor/telemetry/u05-post-mocha.json` |
| Cargo (read-only) | `.agents/major-refactor/telemetry/u05-baseline-cargo.json` | `.agents/major-refactor/telemetry/u05-post-cargo.json` |
| E2E `01-startup` | `.agents/major-refactor/telemetry/u05-baseline-e2e-01-startup.json` | `.agents/major-refactor/telemetry/u05-post-e2e-01-startup.json` |
| E2E `02-navigation` | `.agents/major-refactor/telemetry/u05-baseline-e2e-02-navigation.json` | `.agents/major-refactor/telemetry/u05-post-e2e-02-navigation.json` |
| E2E `03-viewer` | `.agents/major-refactor/telemetry/u05-baseline-e2e-03-viewer.json` | `.agents/major-refactor/telemetry/u05-post-e2e-03-viewer.json` |
| E2E `04-archives` | `.agents/major-refactor/telemetry/u05-baseline-e2e-04-archives.json` | `.agents/major-refactor/telemetry/u05-post-e2e-04-archives.json` |
| E2E `05-persistence` | `.agents/major-refactor/telemetry/u05-baseline-e2e-05-persistence.json` | `.agents/major-refactor/telemetry/u05-post-e2e-05-persistence.json` |
| E2E `06-configuration` | `.agents/major-refactor/telemetry/u05-baseline-e2e-06-configuration.json` | `.agents/major-refactor/telemetry/u05-post-e2e-06-configuration.json` |
| E2E `07-os-integration` | `.agents/major-refactor/telemetry/u05-baseline-e2e-07-os-integration.json` | `.agents/major-refactor/telemetry/u05-post-e2e-07-os-integration.json` |
| Diagnose `sample-navigation` | `.agents/major-refactor/telemetry/u05-baseline-diagnose-sample-navigation.json` | `.agents/major-refactor/telemetry/u05-post-diagnose-sample-navigation.json` |
| Diagnose `filter-navigation` | `.agents/major-refactor/telemetry/u05-baseline-diagnose-filter-navigation.json` | `.agents/major-refactor/telemetry/u05-post-diagnose-filter-navigation.json` |
| Diagnose `manhwa-buffer` | `.agents/major-refactor/telemetry/u05-baseline-diagnose-manhwa-buffer.json` | `.agents/major-refactor/telemetry/u05-post-diagnose-manhwa-buffer.json` |

### Telemetry A additions

- Expand `core.test.js` (`setStatusBarVisible`, `setScrollZoomLatched`, `applyDirectorySort`, `configVersion`, `mergeConfig({})`, single `_notify()` on spread/manhwa toggles, `_selectEntry` error rollback, O(1) `navigate` edge-wrap), `sorting.test.js` (natural-sort edge cases + 2,000-entry baseline timing, `directoryPrefs` cap 100 / read immutability / bounded reconcile), `cache.test.js` (`BoundedSet`), and `actions.test.js` (injected `ctx` capabilities).
- Add Mocha suites for `fsUtils` / `mediaFormats` / `mediaUrls` / `listNavigation` (2,000-entry baseline timings for `naturalPagePosition` and `_formatDate`, `applyDirectoryResult` await order, `has_gallery_sidecar` gating, O(N + M) `findNearestSurvivingIndex`), `navigationHistory`, `archiveImageCache` (`!r.ok`, single revoke, LRU, active blob), `keybindDomain`, `keyCombo`, `configSchema`, `workspaceLayout`, `workspaceHost`, `workspaceSession` (`configVersion`, `forgetWorkspacePeer` immediate reject, bounded `ready` retry), `workspaceControls` (`UrlLoader` allowlist, `publishStripInfo` dedup), `configPreview`, and `theme`.
- Expand `e2e/specs/02-navigation.e2e.js` and `05-persistence.e2e.js` (keeping `06-configuration.e2e.js` and `07-os-integration.e2e.js` edits exclusive to `U04`/`U07`) for detached `?surface=fileList` (snapshot, column sort RPC, focus restore, clean close), toggle-mode scroll-zoom latch persistence + statusbar indicator, and Manhwa key-hold commit.

### Comparison table

| Metric or invariant | Baseline (Telemetry A) | Post (Telemetry B) | Pass criterion | Verdict |
|---|---|---|---|---|
| Mocha unit tests (including `diagnosticsContract.test.js`) | Pending (308 pre-existing) | Pending | 100% pass; pure `core`, `sorting`, `fsUtils` services import in Node with 0 `globalThis.window.__TAURI__` stubs | Pending |
| `applySort` on 2,000 filenames (`sorting.js`) | `21.82ms` (audit benchmark) | Pending | `>= 5x` speedup (`<= 4.3ms`, target `~2.23ms`) with 100% edge-case order parity | Pending |
| `naturalPagePosition` repeat lookup on 2,000 filenames | `21.82ms` per call | Pending | O(1) `WeakMap` cache hit (`< 0.1ms`) | Pending |
| `_formatDate` on 2,000 timestamps | `77.93ms` (audit benchmark) | Pending | `>= 10x` speedup (`<= 7.8ms`, target `~2.58ms`) with identical output | Pending |
| `gallery.json` failing `read_text_file` IPCs on non-gallery folders (`sample-navigation`) | >= 1 `ipc-error` per folder | Pending | 0 failing `gallery.json` `read_text_file` IPCs (`has_gallery_sidecar` gated) | Pending |
| `archiveImageCache` Blob revokes per eviction/clear and `!r.ok` caching | 2x revoke per entry; caches 404/500 blobs | Pending | Exactly 1 `revokeObjectURL` per entry; 0 cached `!r.ok` blobs | Pending |
| `workspaceSession` `publish` serialization and peer close timeout | Full `JSON.stringify(config)` per notify; 30s hang on close | Pending | O(1) `configVersion` integer check; immediate pending RPC reject on `forgetWorkspacePeer` | Pending |
| Circular imports (`core` <-> `fsUtils` <-> `directoryPrefs`) and `shortcuts.js` reach-in | 3-way cycle; imports `Statusbar`/`menubar` | Pending | 0 circular imports; 0 `menubar`/`statusbar` imports in `shortcuts.js`; 1 `findAction` per keydown | Pending |
| E2E `01` to `07` + Replay `sample-navigation`, `filter-navigation`, `manhwa-buffer` | Pending | Pending | 100% pass; 0 `unknown-action`/`action-error`/`ipc-error`; lower startup and swap latency | Pending |

---

## U06: `fe-shell-css-chrome` (S02)

Scope: `S02-01` to `S02-12` (`src/index.html` Sync A templates + `#custom-css` order + dead `#viewer-loading-frame` + `pica`/`purify` defer/lazy, `src/css/global.css` R3/Sync A moves including atomic `.assoc-mascot-*` move to `options.css` and `:root` file-panel vars kept in `file-panel.css` until `U08`, `src/css/main.css` 6-sheet split, `src/js/main/{main,workspace,fullscreen,metadataBadge,urlOverlay,lifecycle,dropzone,passwordOverlay}.js`, atomic `options-active-tab` `sessionStorage` switch in `options.js:236,245` with `main.js:64` removal, `src/js/menubar.js` -> `services/menuAim.js` + `menubar/{favoritesMenu,importsMenu,viewMenu}.js`, `src/js/menubar/{chrome,statusbar}.js` retaining `Statusbar` compatibility methods until `U10`).
Depends on: `U04`, `U05`. Parallel with: None.

### Runnable commands

- Mocha unit tests: `npm run mocha`
- Desktop E2E: `npm run e2e -- --spec e2e/specs/01-startup.e2e.js`, `npm run e2e -- --spec e2e/specs/03-viewer.e2e.js`, `npm run e2e -- --spec e2e/specs/04-archives.e2e.js`, `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js`, `npm run e2e -- --spec e2e/specs/08-url-loader.e2e.js`
- Replay diagnostics: `npm run diagnose -- grill-desync`, `npm run diagnose -- sample-navigation`
- Rust backend: N/A (frontend-only unit)

### Artifact paths

| Suite | Baseline (Telemetry A) | Post (Telemetry B) |
|---|---|---|
| Mocha | `.agents/major-refactor/telemetry/u06-baseline-mocha.json` | `.agents/major-refactor/telemetry/u06-post-mocha.json` |
| E2E `01-startup` | `.agents/major-refactor/telemetry/u06-baseline-e2e-01-startup.json` | `.agents/major-refactor/telemetry/u06-post-e2e-01-startup.json` |
| E2E `03-viewer` | `.agents/major-refactor/telemetry/u06-baseline-e2e-03-viewer.json` | `.agents/major-refactor/telemetry/u06-post-e2e-03-viewer.json` |
| E2E `04-archives` | `.agents/major-refactor/telemetry/u06-baseline-e2e-04-archives.json` | `.agents/major-refactor/telemetry/u06-post-e2e-04-archives.json` |
| E2E `06-configuration` | `.agents/major-refactor/telemetry/u06-baseline-e2e-06-configuration.json` | `.agents/major-refactor/telemetry/u06-post-e2e-06-configuration.json` |
| E2E `08-url-loader` | `.agents/major-refactor/telemetry/u06-baseline-e2e-08-url-loader.json` | `.agents/major-refactor/telemetry/u06-post-e2e-08-url-loader.json` |
| Diagnose `grill-desync` | `.agents/major-refactor/telemetry/u06-baseline-diagnose-grill-desync.json` | `.agents/major-refactor/telemetry/u06-post-diagnose-grill-desync.json` |
| Diagnose `sample-navigation` | `.agents/major-refactor/telemetry/u06-baseline-diagnose-sample-navigation.json` | `.agents/major-refactor/telemetry/u06-post-diagnose-sample-navigation.json` |

### Telemetry A additions

- Add `mocha/chromeContract.test.js` covering pure safe-triangle aim (`isPointInTriangle`, `isInSafeTriangle`), state-based `getCopyableStatusItem`, fullscreen exit combo `Set` matching, `index.html` `<style id="custom-css">` ordering and single-ID invariant, `global.css` vs `themes/*.css` 22-token parity + `--danger`, and `/js/menubar/chrome.js` exporting `Chrome`.
- Expand E2E specs for detached `?surface=fileList` chrome parity (`#menubar` visible, `#statusbar` hidden, `#cmd-toggle-statusbar` muted, `#viewport` hidden), fullscreen `#cmd-fullscreen.checked` sync, statusbar click-to-copy, and single `#custom-css` node (`document.querySelectorAll('#custom-css').length === 1` when custom CSS is saved in `06-configuration.e2e.js`).

### Comparison table

| Metric or invariant | Baseline (Telemetry A) | Post (Telemetry B) | Pass criterion | Verdict |
|---|---|---|---|---|
| Mocha `chromeContract.test.js` and `diagnosticsContract.test.js` | Pending | Pending | 100% pass; `Chrome` export non-undefined for `runner.e2e.js:344` | Pending |
| `statusbar.js` forced reflow (`void *.offsetWidth`) and `menubar` `mousemove` layout reads | 1 `offsetWidth` reflow on refresh; 2 `getBoundingClientRect()` per `mousemove` | Pending | 0 `void *.offsetWidth` in `statusbar.js`; 0 `getBoundingClientRect()` in `mousemove` aim | Pending |
| CSS 3-tier scope and validity across `src/css/*.css` | `cursor: disabled` (3x), `body.* *` and `#viewport.* *` rules present | Pending | 0 `cursor: disabled`; 0 universal `*` descendant rules under state toggles; 6 owner sheets linked in Sync A order | Pending |
| Single-writer DOM boundaries in `main.js`, `fullscreen.js`, `chrome.js` | Dual `#statusbar.hidden` writer; foreign `#cmd-*` and `#img-grill*` writes | Pending | 0 foreign `#cmd-*`, `#img-grill*`, or `#statusbar` writes in `main.js`, `fullscreen.js`, `chrome.js` | Pending |
| Eager `canvas.toDataURL` in `metadataBadge.js` while Metadata window is closed | Runs on every metadata folder/archive open | Pending | 0 `canvas.toDataURL` calls while Metadata window is closed; emits `{ meta: null, coverSrc: null }` on clear | Pending |
| Startup script blocking (`index.html:531-532`) and `#custom-css` node count | Parser-blocking `pica.js`/`purify.min.js`; 2 `#custom-css` nodes | Pending | `defer` or lazy-loaded vendors; `document.querySelectorAll('#custom-css').length === 1` | Pending |
| E2E `01`, `03`, `04`, `06`, `08` + Replay `grill-desync`, `sample-navigation` | Pending | Pending | 100% pass; 0 blackout frames; 0 grill desync anomalies | Pending |

---

## U07: `fe-options-metadata` (S03)

Scope: `S03-01` to `S03-10` plus `S01-17` (`windowFit.js` `.is-measuring-width`) and final `S01-15` (`themePrePaint.js` fallback removal once `options.html` and `metadata.html` move `<style id="custom-css">` before it): `src/options.html`, `src/metadata.html`, `src/css/options.css`, `src/js/options/{options,keybindUi,associationsUi}.js`, `src/js/services/{optionsForm,metadataParser}.js`, `src/js/metadata.js`, `src/js/metadata-window.js`, `src/js/shared/{windowFit,themePrePaint}.js`.
Depends on: `U05`, `U06`. Parallel with: `U08` -> `U09` -> `U10` -> `U11`.

### Runnable commands

- Mocha unit tests: `npm run mocha`
- Desktop E2E: `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js`
- Rust backend (read-only seam check): `cargo test --manifest-path src-tauri/Cargo.toml config::tests`, `cargo test --manifest-path src-tauri/Cargo.toml formats::tests`, `cargo test --manifest-path src-tauri/Cargo.toml windows::tests`
- Replay diagnostics: N/A (0 probes or scenarios target `options.html` or `metadata.html`)

### Artifact paths

| Suite | Baseline (Telemetry A) | Post (Telemetry B) |
|---|---|---|
| Mocha | `.agents/major-refactor/telemetry/u07-baseline-mocha.json` | `.agents/major-refactor/telemetry/u07-post-mocha.json` |
| Cargo (read-only) | `.agents/major-refactor/telemetry/u07-baseline-cargo.json` | `.agents/major-refactor/telemetry/u07-post-cargo.json` |
| E2E `06-configuration` | `.agents/major-refactor/telemetry/u07-baseline-e2e-06-configuration.json` | `.agents/major-refactor/telemetry/u07-post-e2e-06-configuration.json` |

### Telemetry A additions

- Add `mocha/optionsForm.test.js` covering extracted pure `services/optionsForm.js` helpers and `saveOptions` failure atomicity (no `config`/`localStorage` mutation when `move_library` or `save_config` rejects).
- Add static HTML/asset/registry parity checks: 0 duplicate HTML IDs in `options.html`/`metadata.html`, `<style id="custom-css">` preceding `themePrePaint.js` across all 3 HTML documents, 22 PNG icons matching `options.html` and `EXT_TO_GROUP`, and every `options.html` `data-action` slot present in `ACTION_REGISTRY`.
- Expand `mocha/metadata.test.js` for pure `services/metadataParser.js` (`parseComicInfo` XML, `parseOpf`, `comet.xml`) without `globalThis.window.__TAURI__` stubs.
- Expand `e2e/specs/06-configuration.e2e.js` for keybind conflict styling (`--conflict-color`/`.is-conflict`) and reset, custom CSS preview + revert-on-close, associations mascot hover in Light theme under dark OS, `options-active-tab` `sessionStorage` reset across launches, and `metadata.html` open/cover-orientation/null-clear + single `fit_metadata_window`.

### Comparison table

| Metric or invariant | Baseline (Telemetry A) | Post (Telemetry B) | Pass criterion | Verdict |
|---|---|---|---|---|
| Mocha (`optionsForm`, `metadata`, HTML/22-asset/`ACTION_REGISTRY` parity) | Pending | Pending | 100% pass; 0 `window.__TAURI__` stubs in pure `metadataParser` tests | Pending |
| `getConflictColors` calls per `renderKeybinds()` (`keybindUi.js`) | ~64 calls (`5.885ms` in audit) | Pending | 1 call per render (`<= 0.15ms`, target `~0.073ms`) | Pending |
| Inline style and global leak compliance (`keybindUi.js`, `windowFit.js`, `options.js`, `themePrePaint.js`) | Inline `.style.color`/`.borderColor`/`.width`; `window.syncCustomCssHighlight`; `createElement('style')` | Pending | 0 inline `.style.color`/`.borderColor`/`.width`; 0 `window.syncCustomCssHighlight`; 0 `createElement` in `themePrePaint.js` | Pending |
| Options startup IPC waterfall and File Types sync | 7 sequential awaits + eager `sync_preview_associations` | Pending | Independent invokes batched via `Promise.all`; `sync_preview_associations` deferred to File Types tab | Pending |
| Prism CSS editor input latency | Sync `Prism.highlight` (`7.60ms` to `23.54ms` per keystroke) + missing `data-manual` | Pending | `data-manual` / lazy load; rAF-coalesced highlight; `syncScroll()` synced on `input`/`Tab` | Pending |
| `metadata-window.js` cover load fit count and null-clear parity | 2 `fitContentHeight()` calls; stale DOM on `!meta`; duplicate `localStorage` write | Pending | 1 `fitContentHeight()` on cover load; clean clear on `{ meta: null, coverSrc: null }`; 0 `localStorage` writes | Pending |
| E2E `06-configuration.e2e.js` and Cargo read-only seam checks | Pending | Pending | 100% pass; 22-format parity and `400..=560` / `280..=600` bounds intact | Pending |

---

## U08: `fe-filepanel` (S04)

Scope: `S04-01` to `S04-17` (`src/js/filepanel/filePanel.js` 6-way split into `services/filePanelMath.js` + `filepanel/{nativeIconCache,thumbnailPipeline,favoritesPanel,libraryPanel,filePanel}.js`, `src/js/filepanel/favoritesStore.js`, `src/js/filepanel/libraryStore.js`, `src/css/file-panel.css`, `src/js/main/main.js` `initFilePanel(deps)` wiring).
Depends on: `U05`, `U06`. Parallel with: `U07`.

### Runnable commands

- Mocha unit tests: `npm run mocha`
- Desktop E2E: `npm run e2e -- --spec e2e/specs/02-navigation.e2e.js`, `npm run e2e -- --spec e2e/specs/04-archives.e2e.js`, `npm run e2e -- --spec e2e/specs/05-persistence.e2e.js`, `npm run e2e -- --spec e2e/specs/08-url-loader.e2e.js`
- Replay diagnostics: N/A (0 probes touch `#file-panel`)
- Rust backend: N/A (frontend-only unit)

### Artifact paths

| Suite | Baseline (Telemetry A) | Post (Telemetry B) |
|---|---|---|
| Mocha | `.agents/major-refactor/telemetry/u08-baseline-mocha.json` | `.agents/major-refactor/telemetry/u08-post-mocha.json` |
| E2E `02-navigation` | `.agents/major-refactor/telemetry/u08-baseline-e2e-02-navigation.json` | `.agents/major-refactor/telemetry/u08-post-e2e-02-navigation.json` |
| E2E `04-archives` | `.agents/major-refactor/telemetry/u08-baseline-e2e-04-archives.json` | `.agents/major-refactor/telemetry/u08-post-e2e-04-archives.json` |
| E2E `05-persistence` | `.agents/major-refactor/telemetry/u08-baseline-e2e-05-persistence.json` | `.agents/major-refactor/telemetry/u08-post-e2e-05-persistence.json` |
| E2E `08-url-loader` | `.agents/major-refactor/telemetry/u08-baseline-e2e-08-url-loader.json` | `.agents/major-refactor/telemetry/u08-post-e2e-08-url-loader.json` |

### Telemetry A additions

- Add `mocha/favoritesStore.test.js` (loadout normalization, unique naming, CRUD, `getFavoriteTargetPath` `archive|entry`, single `persistConfig` flush check, case-insensitive Windows `reconcileFavorites`).
- Add `mocha/libraryStore.test.js` (`hasLibraryEntries`/`hasProviderNodes`, `orderProviders`, `resolveActiveProvider`, `activateImportProvider`, `syncActiveProvider`, 0 dead `quivit_library_collapsed` writes).
- Add `mocha/filePanelMath.test.js` (`computeVisibleSlice`, `computeColumnWidths`, `computeSelectionScrollTop`, formatters, `pathsEqual`, `computeNextSearchMatch`, `resolveLibraryProviderRoot`, `findDeepestLibraryAncestor`).
- Expand `05-persistence.e2e.js` (and/or `02-navigation.e2e.js`) for detached `?surface=fileList` selection, favorite toggle, and view-mode toggle parity.

### Comparison table

| Metric or invariant | Baseline (Telemetry A) | Post (Telemetry B) | Pass criterion | Verdict |
|---|---|---|---|---|
| Mocha (`favoritesStore`, `libraryStore`, `filePanelMath`) | Pending (0 pre-existing S04 tests) | Pending | 100% pass in Node without browser globals | Pending |
| Imperative DOM and inline style count across `src/js/filepanel/*.js` | 46 `createElement`, 13 `innerHTML`, 1 `outerHTML`, 23 `.style.` writes, 2 `svg.setAttribute('fill')` | Pending | 0 `createElement`, 0 `innerHTML`, 0 `outerHTML`, 0 `.style.{display,top,height}`, 0 `svg.setAttribute('fill')` | Pending |
| `icon:*` persistence across `window.focus` and `iconCache` capacity | Wiped on every focus; unbounded `Map` | Pending | 100% `icon:*` entries retained on `window.focus`; `iconCache` bounded to `ICON_CACHE_CAPACITY` (512) | Pending |
| `/archive/` thumbnail scroll-away and scroll-back cache hit | Always misses `thumbnailCache` and re-decodes | Pending | `thumbnailCache` hit on scroll-back; 0 redundant archive thumbnail re-decodes | Pending |
| `renderFilePanel` DOM queries on unrelated `Core` updates (zoom/pan/filter) | Runs column, dims, and sort scans pre-guard | Pending | 0 DOM queries when unrelated `Core` fields change | Pending |
| Detached `?surface=fileList` duplicate work and `dims` sort RPC | Both windows run panel renders and ship full `sortedList` | Pending | Non-hosting window skips renders/listeners; `dims` re-sort uses `Core.applyDirectorySort(path, col, desc)` | Pending |
| Dead code and duplicate sync removal | `getLibraryCollapsed`, `saveLibraryCollapsed`, `lastScrolledIndex`, `lastRenderedVisible`, duplicate `syncWorkspaceDownloadStatus` | Pending | 0 references across `src/`; `urlLoader.js` stays sole `_workspaceStatuses` writer | Pending |
| E2E `02-navigation`, `04-archives`, `05-persistence`, `08-url-loader` | Pending | Pending | 100% pass; all locked `filepanel.page.js` and `08-url-loader` selectors intact | Pending |

---

## U09: `fe-urlloader` (S05)

Scope: `S05-01` to `S05-06` (`src/js/urlLoader.js` 5-way split into `services/downloadQueue.js`, `urlloader/{extractorRegistry,gallerySidecar,networkClient}.js`, thin `urlLoader.js`, plus scoped fixes in `src/js/services/importActions.js` and `src/js/shared/svgUtils.js`, `main.js` `onProviderImported` DI, adopting `U03` `cancel_scope`).
Depends on: `U03`, `U06`, `U08`. Parallel with: `U07`.

### Runnable commands

- Mocha unit tests (primary): `npm run mocha`
- Desktop E2E: `npm run e2e -- --spec e2e/specs/08-url-loader.e2e.js`
- Replay diagnostics (conditional on local MangaDex fixture): `npm run diagnose -- mangadex-chapters`
- Rust backend: Covered by `U03` (`network_tests`, `library_tests`, `drop_tests`)

### Artifact paths

| Suite | Baseline (Telemetry A) | Post (Telemetry B) |
|---|---|---|
| Mocha | `.agents/major-refactor/telemetry/u09-baseline-mocha.json` | `.agents/major-refactor/telemetry/u09-post-mocha.json` |
| E2E `08-url-loader` | `.agents/major-refactor/telemetry/u09-baseline-e2e-08-url-loader.json` | `.agents/major-refactor/telemetry/u09-post-e2e-08-url-loader.json` |
| Diagnose `mangadex-chapters` (if fixture present) | `.agents/major-refactor/telemetry/u09-baseline-diagnose-mangadex-chapters.json` | `.agents/major-refactor/telemetry/u09-post-diagnose-mangadex-chapters.json` |

### Telemetry A additions

- Add `mocha/importActions.test.js` (`parseLocalPath`, single-flight `active` rejection, `getActivity()` phase transitions, stale nav intent -> `cancelUrlImport`, `acceptDrop`/`failDrop`/`completeDrop` including scheme-less URL error and `svgText == null`, `release_drop` cleanup).
- Expand `mocha/urlLoader.test.js` and `mocha/urlLoaderFlows.test.js` (`DownloadQueue` N=1500 snapshot timing baseline, `MAX_CONCURRENT_PREFETCHES` cap, `onQueueComplete` callback, `loadExtractorModule` cache-hit Blob URL creation vs revocation count, `_workspaceStatuses` tracking `513..4096`, `retryGalleryDownload` rollback, same-index `Core.onStateChange` no-op, `handleLibraryRelocation` clearing in-flight maps and separating retired-root vs active relocation lock).
- Expand `mocha/svgUtils.test.js` (uppercase `<FOREIGNOBJECT>`/`<I:PGF>`, lowercase `<!doctype`, comma `viewBox`, preserved XML entities, 632 KB / 400-entity `expandSvgEntities` timing baseline).

### Comparison table

| Metric or invariant | Baseline (Telemetry A) | Post (Telemetry B) | Pass criterion | Verdict |
|---|---|---|---|---|
| Mocha (`importActions`, `urlLoader`, `urlLoaderFlows`, `svgUtils`) | Pending | Pending | 100% pass; `urlLoader.js` compatibility exports and `svgUtils.js` exact API preserved | Pending |
| `DownloadQueue` N=1500 status snapshot latency | `784.20ms` (audit benchmark) | Pending | `< 5ms` (`O(N)` indexed snapshot) | Pending |
| `loadExtractorModule` cache-hit unrevoked dep Blob URLs | > 0 leaked per cache hit | Pending | 0 unrevoked dep Blob URLs on cache hit | Pending |
| `expandSvgEntities` on 632 KB / 400-entity SVG | `10.54ms` (audit benchmark) | Pending | `>= 35%` speedup (`<= 6.85ms`, target `~6.22ms`) with built-in XML entities intact | Pending |
| `_workspaceStatuses` capacity and concurrent prefetch bound | Cap 512; unbounded prefetch chain | Pending | Cap 4096 with gallery-change clear and retry rollback; `MAX_CONCURRENT_PREFETCHES` (2 or 3) enforced | Pending |
| Cross-module coupling in `urlLoader.js` and `urlloader/*` | Imports `libraryStore.js`, holds `_urlOverlay`, reaches `window.DOMPurify` | Pending | 0 `libraryStore.js`, `_urlOverlay`, or direct `window.DOMPurify` reach-ins; 0 duplicate `syncWorkspaceDownloadStatus` | Pending |
| E2E `08-url-loader.e2e.js` (and `diagnose -- mangadex-chapters` when fixture present) | Pending | Pending | 100% pass; `cmd-use-url`, detached status sync, and relocation teardown intact | Pending |

---

## U10: `fe-viewer-strip` (S06)

Scope: `S06-01` to `S06-12` (`viewerRender.js` + `viewerBridge.js`, `manhwaStrip.js` + `manhwa/{stripPool,stripDecodeQueue,stripLayout}.js`, `viewerAudio.js` + `manhwaAudio.js` + `services/mediaAudioState.js`, `viewerGestures.js`, `services/viewerMath.js` + `services/keybindDomain.js:68` `computeSlotHue` import, `icoCells.js`, `viewer.js`, `fsUtils.js` `onManhwaMaxWidth`/`cancelWidthScan`, `e2e/replay-diagnostics/probes/viewerPipelineProbe.js:19-20` R4 fix in Telemetry A, atomic R4 removal of `index.html:419` `#viewer-audio` + `fsUtils.js:429-432` `buildAudioSrc` + `actions.js:25,42` `centerListItem` + `mocha/actions.test.js:171-184`, `main.js` `initViewer()` + grill ownership handoff).
Depends on: `U02`, `U05`, `U06`, `U09`. Parallel with: `U07`.

### Runnable commands

- Mocha unit tests: `npm run mocha`
- Desktop E2E: `npm run e2e -- --spec e2e/specs/02-navigation.e2e.js`, `npm run e2e -- --spec e2e/specs/03-viewer.e2e.js`, `npm run e2e -- --spec e2e/specs/04-archives.e2e.js`
- Replay diagnostics (10 scenarios): `npm run diagnose -- sample-navigation`, `npm run diagnose -- zoom-bridge-stale-size`, `npm run diagnose -- grill-desync`, `npm run diagnose -- manhwa-buffer`, `npm run diagnose -- manhwa-directory-entry-fits`, `npm run diagnose -- manhwa-first-last-align`, `npm run diagnose -- manhwa-fit-cycle`, `npm run diagnose -- manhwa-gif-bridge`, `npm run diagnose -- manhwa-video-bridge`, `npm run diagnose -- manhwa-width-span`
- Rust backend (read-only Sync F check): `cargo test --manifest-path src-tauri/Cargo.toml formats::tests`, `cargo test --manifest-path src-tauri/Cargo.toml ico::tests`

### Artifact paths

| Suite | Baseline (Telemetry A) | Post (Telemetry B) |
|---|---|---|
| Mocha | `.agents/major-refactor/telemetry/u10-baseline-mocha.json` | `.agents/major-refactor/telemetry/u10-post-mocha.json` |
| Cargo (read-only) | `.agents/major-refactor/telemetry/u10-baseline-cargo.json` | `.agents/major-refactor/telemetry/u10-post-cargo.json` |
| E2E `02-navigation` | `.agents/major-refactor/telemetry/u10-baseline-e2e-02-navigation.json` | `.agents/major-refactor/telemetry/u10-post-e2e-02-navigation.json` |
| E2E `03-viewer` | `.agents/major-refactor/telemetry/u10-baseline-e2e-03-viewer.json` | `.agents/major-refactor/telemetry/u10-post-e2e-03-viewer.json` |
| E2E `04-archives` | `.agents/major-refactor/telemetry/u10-baseline-e2e-04-archives.json` | `.agents/major-refactor/telemetry/u10-post-e2e-04-archives.json` |
| Diagnose `sample-navigation` | `.agents/major-refactor/telemetry/u10-baseline-diagnose-sample-navigation.json` | `.agents/major-refactor/telemetry/u10-post-diagnose-sample-navigation.json` |
| Diagnose `zoom-bridge-stale-size` | `.agents/major-refactor/telemetry/u10-baseline-diagnose-zoom-bridge-stale-size.json` | `.agents/major-refactor/telemetry/u10-post-diagnose-zoom-bridge-stale-size.json` |
| Diagnose `grill-desync` | `.agents/major-refactor/telemetry/u10-baseline-diagnose-grill-desync.json` | `.agents/major-refactor/telemetry/u10-post-diagnose-grill-desync.json` |
| Diagnose `manhwa-buffer` | `.agents/major-refactor/telemetry/u10-baseline-diagnose-manhwa-buffer.json` | `.agents/major-refactor/telemetry/u10-post-diagnose-manhwa-buffer.json` |
| Diagnose `manhwa-directory-entry-fits` | `.agents/major-refactor/telemetry/u10-baseline-diagnose-manhwa-directory-entry-fits.json` | `.agents/major-refactor/telemetry/u10-post-diagnose-manhwa-directory-entry-fits.json` |
| Diagnose `manhwa-first-last-align` | `.agents/major-refactor/telemetry/u10-baseline-diagnose-manhwa-first-last-align.json` | `.agents/major-refactor/telemetry/u10-post-diagnose-manhwa-first-last-align.json` |
| Diagnose `manhwa-fit-cycle` | `.agents/major-refactor/telemetry/u10-baseline-diagnose-manhwa-fit-cycle.json` | `.agents/major-refactor/telemetry/u10-post-diagnose-manhwa-fit-cycle.json` |
| Diagnose `manhwa-gif-bridge` | `.agents/major-refactor/telemetry/u10-baseline-diagnose-manhwa-gif-bridge.json` | `.agents/major-refactor/telemetry/u10-post-diagnose-manhwa-gif-bridge.json` |
| Diagnose `manhwa-video-bridge` | `.agents/major-refactor/telemetry/u10-baseline-diagnose-manhwa-video-bridge.json` | `.agents/major-refactor/telemetry/u10-post-diagnose-manhwa-video-bridge.json` |
| Diagnose `manhwa-width-span` | `.agents/major-refactor/telemetry/u10-baseline-diagnose-manhwa-width-span.json` | `.agents/major-refactor/telemetry/u10-post-diagnose-manhwa-width-span.json` |

### Telemetry A additions

- Fix `e2e/replay-diagnostics/probes/viewerPipelineProbe.js:19-20` first (R4) so `calc(-50% + <num>px)` parses cleanly and `ty-teleport` runs live during baseline capture (keeping `viewerMath.js:699` transform unchanged).
- Add `mocha/mediaAudioState.test.js` (disk and archive keys, single-to-manhwa state persistence, silent-slot toggle guard, volume clamping/stepping, manhwa-active reset), `mocha/viewerBridge.test.js` (A -> B -> A reclamation, async ICO decode gating, video-to-image parking, cancellable double-rAF), and `mocha/viewerStripLogic.test.js` (adaptive debounce cadence, `_admitCompleted` `_mountInFlight` remapping above/below, single-pass zoom-out dims, reflow-free pill coordinates, outside-window-only gesture cursor polling).
- Expand `mocha/viewerMath.test.js` (`DEFAULT_FIT_MODE` seam, `computeSlotHue`, `mirroredGrillAngle`, `subscribe()` unsubscribe, `viewerPipelineProbe.js` `calc(-50% + <num>px)` parser check).
- Expand E2E `02-navigation`, `03-viewer`, `04-archives` for detached `?surface=fileList` zero-viewer-init, disk + archive MP4 unmute/persistence/manhwa silence, and rapid A -> B -> A and video -> image transitions with empty `#viewer-bridge-layer`.

### Comparison table

| Metric or invariant | Baseline (Telemetry A) | Post (Telemetry B) | Pass criterion | Verdict |
|---|---|---|---|---|
| Mocha (`mediaAudioState`, `viewerBridge`, `viewerStripLogic`, `viewerMath`, `actions`, `diagnosticsContract`) | Pending | Pending | 100% pass; Telemetry B updates `diagnosticsContract.test.js:68-98` for `manhwa/*` + `viewerBridge.js` and `actions.test.js:171-184` per R4 | Pending |
| Single-step preloaded swap latency (`image-decode-end` to `img-role-change` `active`, `sample-navigation`) | Flat `+45ms` debounce + redundant fetch/decode (Pending ms) | Pending | `~45ms` latency drop on preloaded next/prev steps; 0 throwaway `new Image()` allocations on warm pool | Pending |
| `manhwaStrip` pool reuse, `decode()` calls, and pool segregation | `_acquireNode` dead (0 callers); 2x `pre.decode()`; video contaminates `_freePool` | Pending | 0 fresh `new Image()` when `_freePool` warm; 1 `decode()` per prefetched image; strict `IMG` vs `VIDEO` pools | Pending |
| `manhwaAudio.syncPills` forced layout calls per frame | 2 `getBoundingClientRect()` per video x 2 calls/tick | Pending | 0 `getBoundingClientRect()` calls in `syncPills`; bounded pill pool reuse | Pending |
| `viewerPipelineProbe` `spacerTop`/`spacerBottom` and `ty-teleport` across 7 manhwa scenarios | `spacerTop`/`spacerBottom` always `0`; `ty-teleport` inert (`NaN`) | Pending | Non-zero real spacer heights; 0 `ty-teleport` anomalies; 0 blackout frames across all 10 scenarios | Pending |
| Coupling and dead code compliance in `src/js/viewer/` | 15 `Statusbar` calls, `#quivit-recorder-badge`, 60 Hz in-window cursor IPC, `#viewer-audio`, `buildAudioSrc`, `centerListItem` | Pending | 0 `Statusbar` imports in `src/js/viewer/`; 0 `#quivit-recorder-badge`; 0 in-window cursor IPC; `#viewer-audio`, `buildAudioSrc`, `centerListItem` deleted | Pending |
| E2E `02-navigation`, `03-viewer`, `04-archives` + detached zero-init + archive MP4 audio | Pending | Pending | 100% pass; archive MP4 audio plays; manhwa silences single-view video; `Viewer` export intact for `runner.e2e.js:342` | Pending |

---

## U11: `fe-viewer-webgl` (S07)

Scope: `S07-01` to `S07-11` (`viewerPipelines.js` + `services/pipelines/{webcodecsAnimSession,svgRasterPump,icoCompositeCache,columnPipeline}.js`, `glRuntime.js`, `textureCache.js`, `quadCompositor.js`, `lanczosWebGL.js`, `lanczos.js`, `blobImage.js`, `anime4k.js`, `anime4k/chains.js`, `registry.js`, `filterModules.js`, `glCommon.js`, `crt.js`, `phosphor.js`, `scanlines.js`), plus atomic R4 `computeColumnComposite` `{ x, y, width, height }` + `drawList` cleanup across `viewerMath.js`, `viewerPipelines.js:38-52,2000-2001`, `quadCompositor.js`, `mocha/quadCompositor.test.js:194-201,342`, and `mocha/viewerMath.test.js:836-937`, plus S02 `SCALER_BY_ID` label dedup in `menubar/viewMenu.js` and `menubar/statusbar.js`.
Depends on: `U01`, `U06`, `U09`, `U10`. Parallel with: `U07`.

### Runnable commands

- Mocha unit tests: `npm run mocha`
- Desktop E2E: `npm run e2e -- --spec e2e/specs/03-viewer.e2e.js`
- Replay diagnostics (4 scenarios): `npm run diagnose -- filter-navigation`, `npm run diagnose -- manhwa-ghost-phosphor`, `npm run diagnose -- manhwa-gif-bridge`, `npm run diagnose -- manhwa-video-bridge`
- Rust backend: N/A (frontend-only unit)

### Artifact paths

| Suite | Baseline (Telemetry A) | Post (Telemetry B) |
|---|---|---|
| Mocha | `.agents/major-refactor/telemetry/u11-baseline-mocha.json` | `.agents/major-refactor/telemetry/u11-post-mocha.json` |
| E2E `03-viewer` | `.agents/major-refactor/telemetry/u11-baseline-e2e-03-viewer.json` | `.agents/major-refactor/telemetry/u11-post-e2e-03-viewer.json` |
| Diagnose `filter-navigation` | `.agents/major-refactor/telemetry/u11-baseline-diagnose-filter-navigation.json` | `.agents/major-refactor/telemetry/u11-post-diagnose-filter-navigation.json` |
| Diagnose `manhwa-ghost-phosphor` | `.agents/major-refactor/telemetry/u11-baseline-diagnose-manhwa-ghost-phosphor.json` | `.agents/major-refactor/telemetry/u11-post-diagnose-manhwa-ghost-phosphor.json` |
| Diagnose `manhwa-gif-bridge` | `.agents/major-refactor/telemetry/u11-baseline-diagnose-manhwa-gif-bridge.json` | `.agents/major-refactor/telemetry/u11-post-diagnose-manhwa-gif-bridge.json` |
| Diagnose `manhwa-video-bridge` | `.agents/major-refactor/telemetry/u11-baseline-diagnose-manhwa-video-bridge.json` | `.agents/major-refactor/telemetry/u11-post-diagnose-manhwa-video-bridge.json` |

### Telemetry A additions

- Add `mocha/glRuntime.test.js` (shader compile/link/delete lifecycle, `setFilter` uniform caching, multi-pass FBO reuse, `renderFromTexture`, `updateSource` `texSubImage2D`, WebGL2 fallback stub, `dispose` `FRAMEBUFFER` null bind).
- Add `mocha/lanczos.test.js` (viewport crop projection math, `1e-4` scale bypass, generation cancel, pure injected resampler/crop-loader), `mocha/blobImage.test.js` (crop cache hit, `!resp.ok`, concurrent URLs, `AbortSignal`), `mocha/registry.test.js`, and `mocha/filterModules.test.js` (`FILTERS`/`SCALERS`/`ACTION_REGISTRY` parity, `chains.js` pass reachability and naming, `crt.js` uniforms).
- Expand `mocha/textureCache.test.js` (`setPinnedKeys`, `clear`/`dispose` vs in-flight `getOrCreate`, `!resp.ok`, `MAX_TEXTURE_SIZE` reject).
- Expand `e2e/specs/03-viewer.e2e.js` with single-image CRT/Scanlines/Phosphor/Anime4K (`#viewer-filter-canvas[data-render-ready="true"]`), static Lanczos (`#viewer-lanczos-canvas[data-render-ready="true"]`), and simulated `webglcontextlost`/`webglcontextrestored` recovery on `#manhwa-filter-canvas`.

### Comparison table

| Metric or invariant | Baseline (Telemetry A) | Post (Telemetry B) | Pass criterion | Verdict |
|---|---|---|---|---|
| Mocha (`glRuntime`, `lanczos`, `blobImage`, `registry`, `filterModules`, `textureCache`, `quadCompositor`, `viewerMath`, `diagnosticsContract`) | Pending | Pending | 100% pass; Telemetry B updates `quadCompositor.test.js:194-201,260-262,342,353` (lazy Lanczos + canonical rects) and `viewerMath.test.js:836-937` (R4 canonical rects); `diagnosticsContract.test.js:86-93` untouched | Pending |
| `glRuntime._executePasses` `getUniformLocation` calls, shader leaks, and Anime4K pan/zoom passes | 47 `getUniformLocation`/frame; 42 leaked shaders (`vs` + `fs` across 21 passes); 12 to 21 passes on pan/zoom | Pending | 0 `getUniformLocation` in `_executePasses`; 0 leaked shaders; 1 pass (`DrawToViewport`) on cached single-image Anime4K pan/zoom | Pending |
| Anime4K dead De-Ring passes and 4K FBO VRAM | `FAST_CHAIN` 11 image passes, `NORMAL_CHAIN` 20 image passes; ~663 MB 4K FBOs | Pending | `FAST_CHAIN` 8 (-27%), `NORMAL_CHAIN` 17 (-15%); 0 unreachable passes; ~100 MB less 4K FBO VRAM + liveness FBO pooling; pixel-identical RGBA8 output | Pending |
| Idle GPU context creation and cross-canvas manhwa clears | `clear()` allocates hidden WebGL2/2D contexts; manhwa clears `#viewer-filter-canvas` every frame | Pending | 0 `getContext('webgl2'|'2d')` on unused `clear()`; 0 `#viewer-filter-canvas` clears on steady-state manhwa scroll | Pending |
| Legacy live pumps (10 fps GIF, paused video, static SVG) | 13 redundant `ImageDecoder.decode()` per frame; double video uploads; 60 to 144 Hz static SVG rAF | Pending | <= 1 `ImageDecoder.decode()` per animation frame; 0 idle rAF on paused video/finished GIF/static SVG | Pending |
| Static Lanczos pan/zoom repeat IPC `fetch()` (`blobImage.js`) | Full IPC fetch + CPU decode on every 80ms settle | Pending | 0 repeat `fetch()` calls on cached image crops; deferred `pica.js` clean under R2 CSP | Pending |
| `QuadCompositor` eager compile and Lanczos fragment kernel math | Compiles 2 programs eagerly; 42 `lanczos3()` calls/pixel | Pending | 1 program for non-Lanczos filters; 12 `lanczos3()` calls/pixel (precomputed `wx[6]`); 6 fewer trig calls/pixel via `u_rotCS` | Pending |
| `viewerPipelines.js` hot-loop DOM/style hygiene and Anime4K lazy parse | 17 `getElementById('viewport')` sites; 2 `.style.removeProperty`; eager 202 KB `chains.js` parse | Pending | 0 `getElementById('viewport')` in hot loops; 0 `.style.removeProperty`; 0 ICO `toDataURL`; `chains.js` lazy-loaded on demand | Pending |
| E2E `03-viewer.e2e.js` + Replay `filter-navigation`, `manhwa-ghost-phosphor`, `manhwa-gif-bridge`, `manhwa-video-bridge` | Pending | Pending | 100% pass; 0 blackout frames; 0 `canvas-ready-change` regressions; context-restore recovers cleanly | Pending |
