# Audit 10: backend filesystem, library, network, and drop (`be-fs-library-network-drop`)

Split S10 covers 8 Rust source and test files totaling 5,796 lines across filesystem and library tree commands, Library relocation and capture publishing, HTTP downloads and tile descrambling, dropped-image preparation, Windows OLE drag-and-drop, and external archiver temp-origin resolution.

Both S10 workers, `s10-io-arch` and `s10-io-perf`, completed independent passes across all 8 files, verified every `file:line` target and caller in live code, reached unanimous `[Agree]` on 14 findings (`S10-01` to `S10-14`), 2 cohesive files, and 2 dropped items, and ratified `cross-split-seams.md` (`R5`, `R6`, `R7`, Sync C, Sync D, Sync E, and Sync F). Baseline `cargo test --manifest-path src-tauri/Cargo.toml` passed 39 of 39 existing S10 tests: 5 in `commands::directory::tests`, 1 in `commands::library::tests`, 16 in `commands::network::tests`, and 17 in `temp_archive_tests`. `image_import.rs`, `commands/drop.rs`, and `platform/drop.rs` currently have zero unit tests.

## File coverage ledger

| File | Lines | Status | Findings |
|---|---|---|---|
| `src-tauri/src/commands/directory.rs` | 693 | `[Agreed]` | `S10-01`, `S10-02`, `S10-03` |
| `src-tauri/src/commands/library.rs` | 843 | `[Agreed]` | `S10-04`, `S10-05`, `S10-06` |
| `src-tauri/src/commands/network.rs` | 881 | `[Agreed]` | `S10-07`, `S10-08`, `S10-09` |
| `src-tauri/src/commands/drop.rs` | 47 | `Cohesive` | None, needs unit tests in `tests/drop_tests.rs` |
| `src-tauri/src/image_import.rs` | 282 | `[Agreed]` | `S10-10` |
| `src-tauri/src/platform/drop.rs` | 834 | `[Agreed]` | `S10-11`, `S10-12` |
| `src-tauri/src/platform/temp_archive.rs` | 1,478 | `[Agreed]` | `S10-13`, `S10-14` |
| `src-tauri/src/tests/temp_archive_tests.rs` | 738 | `Cohesive` | None, needs `WinZip`/`PeaZip` and fixture assertions |

All 8 owned files are accounted for: 6 files carry findings, 2 files are cohesive, 2 candidate items were dropped, and 0 were escalated.

## Agreed findings

### S10-01 `[Blocking]` `src-tauri/src/commands/directory.rs`: extract domain logic, platform trash FFI, and cross-command reach-ins

- **Targets:** `src-tauri/src/commands/directory.rs:8-146,36,200,210,226,234-518,542`, `src-tauri/src/commands/shell.rs:69-82`
- **Problem:**
  1. `commands/directory.rs` embeds pure directory scanning, library-tree traversal (`read_library_nodes`, `read_gallery_metadata`), retry deletion (`remove_file_robust`, `remove_dir_contents_and_self`, `remove_dir_all_robust`), and Win32 `SHFileOperationW` Recycle Bin FFI (`move_to_recycle_bin` at `L440-474`) directly inside the Tauri IPC layer. `SHFileOperationW` strips the `\\?\` prefix at `L448` and fails on paths exceeding `MAX_PATH`.
  2. Six sites reach into sibling `commands::library` (`L36,200,210,226,488,542`), and `L235` and `L493` reach into `commands::shell::get_library_dir()`, which calls `fs::create_dir_all` as a side effect even during read or delete validation.
- **Agreed fix:** Move pure library-tree scanning and write-guard checks into the new crate-root `src-tauri/src/library.rs` domain module per `R5`, and move `move_to_recycle_bin` plus retry deletion into `src-tauri/src/platform/shell.rs` per `R5`. Upgrade `move_to_recycle_bin` to `IFileOperation` for long-path support while preserving the permanent-delete fallback at `L510-516` for drives and network shares without a Recycle Bin. Read the library root from S08's cached `config::configured_library_dir()` instead of `commands::shell::get_library_dir()`, and keep `commands/directory.rs` as thin IPC adapters.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml directory_tests` and `npm run e2e -- --spec e2e/specs/02-navigation.e2e.js`, `08-url-loader.e2e.js` confirm zero `create_dir_all` side effects on missing library paths and exact directory/library IPC parity.

### S10-02 `[Blocking]` `src-tauri/src/commands/directory.rs`: synchronous UI-thread IPCs, per-entry allocations, and config/JSON thrash

- **Targets:** `src-tauri/src/commands/directory.rs:14-116,158-231,356-379,392-435,505-516,530-567`
- **Problem:**
  1. `get_drives` (`L158-167`), `get_path_kind` (`L170-179`), `read_text_file` (`L193-195`), `write_text_file` (`L198-205`), and `remove_file` (`L224-231`) lack `#[tauri::command(async)]` and execute synchronous filesystem I/O on the main thread. `get_drives` also probes 26 `A:\` through `Z:\` paths via `Path::exists()`, which stalls on optical or disconnected drives.
  2. `read_directory_impl` performs 3 `stat` calls on `input_path` (`exists()` at `L14`, `is_file()` at `L18` and `L26`), reads and parses `quivit_config.json` from disk via `is_within_library` -> `config::load_config_early()` on every directory scan, allocates `entry.path()` at `L42` before filtering by `file_type`, extension, or hidden status, and redundantly clones owned `name` at `L98` and `L105`.
  3. `read_directory_impl` already checks `dir.join("gallery.json").is_file()` at `L35`, yet `DirectoryReadResult` omits that boolean, forcing `src/js/fsUtils.js:580-607` to issue failing `read_text_file` IPC calls on normal folders.
  4. `read_gallery_metadata` (`L356-379`) parses every `gallery.json` into a full `serde_json::Value` DOM just to read `title` and `images.len()`.
  5. `find_directory_metadata` (`L546-564`) collects the entire directory into a `Vec<DirEntry>` and scans linearly up to 6 times (`O(6N)`).
  6. `create_placeholder_files` (`L214-219`) performs a TOCTOU `exists()` check, ignores `File::create` errors, and lacks a filename traversal check; `get_path_kind` (`L172-175`) runs two `stat` calls; `remove_dir_all_robust` (`L429-435`) calls `remove_file_robust` (`L392-398`), creating a 10x10 retry loop of up to 5 seconds per locked file; `remove_dir_contents_and_self` (`L409`) skips entries whose `entry.metadata()` fails on dangling symlinks.
- **Agreed fix:**
  1. Mark `get_drives`, `get_path_kind`, `read_text_file`, `write_text_file`, and `remove_file` `#[tauri::command(async)]`, and implement Windows `get_drives` with `GetLogicalDrives()` bitmask checking in 1 kernel call.
  2. Use a single `fs::metadata` call in `read_directory_impl` and `get_path_kind`, read cached `configured_library_dir()`, filter by `entry.file_name()` before allocating `PathBuf`, drop `name.clone()` at `L98,105`, and populate additive `DirectoryReadResult.has_gallery_sidecar: bool` (`models.rs`, Sync E).
  3. Replace `serde_json::Value` in `read_gallery_metadata` with a minimal `#[derive(Deserialize)]` struct using `Vec<serde::de::IgnoredAny>`.
  4. Replace `find_directory_metadata`'s `Vec` collection with direct candidate probing on Windows or a single-pass priority scan (`O(N)` with zero `Vec` allocation).
  5. Validate relative placeholder filenames and use `OpenOptions::new().write(true).create_new(true)` handling `ErrorKind::AlreadyExists`, handle `ErrorKind::NotFound` in `remove_file`, flatten retry deletion to one bounded retry loop, and inspect `entry.symlink_metadata()` at `L409`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml directory_tests`, `npm run e2e -- --spec e2e/specs/02-navigation.e2e.js`, `08-url-loader.e2e.js`, and `npm run diagnose -- sample-navigation` confirming `has_gallery_sidecar`, single `stat` on `input_path`, zero `config.json` reads per cached scan, and `O(1)` direct probe in `find_directory_metadata`.

### S10-03 `[Blocking]` `src-tauri/src/commands/directory.rs`: migrate five inline `#[cfg(test)]` tests to `tests/`

- **Targets:** `src-tauri/src/commands/directory.rs:569-693`
- **Problem:** `commands/directory.rs` embeds 5 inline `#[cfg(test)]` tests contrary to `.agents/AGENTS.md`. `L650`, `L665`, and `L681` also use PID-only temp paths without a unique nonce, and `L687` passes `std::env::temp_dir()` to `remove_directory`, coupling the test to live user config.
- **Agreed fix:** Move all 5 tests to `src-tauri/src/tests/directory_tests.rs` mounted via `#[path]` per `R7`, give every test an isolated RAII temp directory with unique nonce, remove live-config dependence, and add coverage for `has_gallery_sidecar`, `get_path_kind`, `find_directory_metadata` priority order, minimal `read_gallery_metadata`, and placeholder traversal rejection.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml directory_tests` confirming all 5 migrated tests plus new edge-case tests pass with zero inline `#[cfg(test)]` blocks remaining.

### S10-04 `[Blocking]` `src-tauri/src/commands/library.rs`: extract library domain module and remove circular reach-ins

- **Targets:** `src-tauri/src/commands/library.rs:18-25,27-843`, `src-tauri/src/config.rs:639`, `src-tauri/src/lib.rs:90`, `src-tauri/src/commands/shell.rs:69-82`
- **Problem:** `commands/library.rs` mixes two IPC handlers (`library_move_in_progress`, `move_library`) with cross-cutting domain logic: write guards and move locks called by `config.rs:639`, `commands/directory.rs`, and `commands/network.rs`; capture publication called by `commands/drop.rs:38,44` and `lib.rs:90`; and Library relocation (`move_library_impl`) reaching into `commands::shell::get_library_dir` (`L706`), `commands::watchers` (`L737,794`), and `commands::network::DownloadCancelFlag` (`L741`). It also defines `LibraryMoveResult` (`L18-25`) outside `models.rs`.
- **Agreed fix:** Extract write-guard locks, capture publication, tree scanning, and relocation into `src-tauri/src/library.rs` per `R5`, move `LibraryMoveResult` into `src-tauri/src/models.rs` per `R5` and Sync E, move `get_library_dir` and `get_default_library_dir` from `commands/shell.rs:69-82` into `commands/library.rs` per `R5`, and switch `L741` to `crate::network::DownloadCancelFlag` (`#119`). Keep `commands/library.rs` as thin IPC commands with exact existing command names and `library-relocated` event payload.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml library_tests` and `npm run e2e -- --spec e2e/specs/05-persistence.e2e.js`, `08-url-loader.e2e.js` confirming zero cross-command reach-ins and intact relocation IPC/event contracts.

### S10-05 `[Warning]` `src-tauri/src/commands/library.rs`: repeated config reads, duplicate path remapping, redundant hashing, and fixed sleep

- **Targets:** `src-tauri/src/commands/library.rs:60,190-219,259,265,290-291,460,472-475,538-629,803`
- **Problem:**
  1. `ensure_library_write_allowed` (`L199`) calls `config::load_config_early()` from disk on every write check outside the active Library root, `publish_captured_image` resolves `configured_library_dir()` twice (`L259` and `L265`) while holding `PUBLICATION_MUTEX`, and `path_is_within` (`L60`) allocates `format!("{root}\\")` on every check.
  2. `remap_library_paths` (`L538-629`) duplicates the JSON key traversal of `config.rs:243-325` (`normalize_library_location_paths`), and `remap_path` (`L545`) slices `input_text` using `source_text.len()`, which breaks if trailing separators or case-folding byte lengths differ.
  3. `publish_captured_image` (`L290-291`) re-computes `image_import::file_hash(&image.path)` even though `image_import::prepare` already computed the SHA-256 digest for `image.filename`.
  4. `copy_library_tree` (`L472-475`) calls `fs::create_dir_all(parent)` for every file even though `L460` already creates each directory during recursion.
  5. `move_library_impl` (`L803`) unconditionally sleeps 750 ms before `fs::remove_dir_all(&source)` even when no file handles are open.
- **Agreed fix:** Use S08's cached `configured_library_dir()` and `retired_library_paths` invalidated on `save_config` and `move_library`, resolve the root once in `publish_captured_image`, check trailing-separator boundary without `format!` allocation in `path_is_within`, share the JSON path-walker helper with `config.rs` using path-component prefix stripping in `remap_path`, store `pub hash: String` on `PreparedImage` so `publish_captured_image` hashes only `dest` on collision, remove redundant `L472-475` `create_dir_all`, and replace the fixed 750 ms sleep with bounded retry-backoff on `remove_dir_all(&source)`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml library_tests` asserting path-prefix edge cases, duplicate-capture hash reuse, and single `configured_library_dir` lookup, plus `npm run e2e -- --spec e2e/specs/05-persistence.e2e.js`.

### S10-06 `[Blocking]` `src-tauri/src/commands/library.rs`: migrate inline `#[cfg(test)]` test to `tests/`

- **Targets:** `src-tauri/src/commands/library.rs:831-843`
- **Problem:** `commands/library.rs` embeds 1 inline `#[cfg(test)]` test that reads live user config via `configured_library_dir()`, and leaves lock acquisition, retired-path rejection, `remap_library_paths`, `publish_captured_image`, and `copy_library_tree` reparse-point rejection untested.
- **Agreed fix:** Migrate the inline test to `src-tauri/src/tests/library_tests.rs` via `#[path]` per `R7`, isolate config/root paths with temp directories, and add unit tests for lock contention, retired-path rejection, `remap_path` casing/archive-`|` entries, capture dedup/conflict, and reparse rejection.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml library_tests` confirming all migrated and new tests pass with zero inline `#[cfg(test)]` remaining.

### S10-07 `[Blocking]` `src-tauri/src/commands/network.rs`: extract network domain and scope `DownloadCancelFlag`

- **Targets:** `src-tauri/src/commands/network.rs:38,244-254,281,423-429`, `src-tauri/src/lib.rs:64`, `src-tauri/src/commands/library.rs:741`
- **Problem:**
  1. `commands/network.rs` mixes HTTP requests, extractor caching, header sanitization, magic verification, and tile descrambling inside `commands/`, and defines `DownloadCancelFlag` (`L38`), forcing `lib.rs:64` and `commands/library.rs:741` to reach into `commands::network`.
  2. `DownloadCancelFlag` uses one global `AtomicU64` generation (`L281,426-428`). Calling `cancel_download` when a gallery queue cancels aborts unrelated background raw downloads in `src/js/urlLoader.js:1825` (Sync C `#74`).
- **Agreed fix:** Extract pure and platform network logic into `src-tauri/src/network.rs` hosting `crate::network::DownloadCancelFlag` per `R5` and `#119`. Encapsulate `DownloadCancelFlag` behind `cancel_all()`, `cancel_scope(scope)`, and `token(scope)`, and add optional `cancel_scope: Option<String>` to `download_to_file` and `cancel_download` while keeping zero-arg `cancel_download()` (`cancel_all`) and `quivit-download-threshold` (`{ requestId, queueGeneration }`) backward-compatible.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml network_tests` asserting scoped cancel isolates independent download scopes while zero-arg `cancel_all` cancels all active scopes, plus `npm run e2e -- --spec e2e/specs/08-url-loader.e2e.js`.

### S10-08 `[Warning]` `src-tauri/src/commands/network.rs`: per-chunk lock stats, cross-volume copy, and 2x RAM descramble

- **Targets:** `src-tauri/src/commands/network.rs:70-147,258-262,303-312,326-387,412-418,436-565`
- **Problem:**
  1. `download_to_file` calls `ensure_library_write_allowed` (`L258`) and `library_write_scope` (`L259`), reading config twice before the request, then calls `ensure_library_root_writable` on every 32 KiB network chunk (`L332-338`, 2 `PathBuf` allocations and 2 `stat` syscalls per chunk, roughly 640 syscalls per 10 MiB), writes unbuffered chunks to `File`, and stages in `std::env::temp_dir()` (`L303-312`), which always triggers cross-volume `EXDEV` `fs::copy` (`L412-418`, 2x disk writes) when the Library sits on another drive.
  2. `apply_tile_descramble` (`L481-565`) decodes without `image::Limits`, allocates a `HashSet` (`L494`), clones the entire `DynamicImage` (`L531`, 2x uncompressed pixel RAM), calls `src.crop_imm` + `imageops::replace` per tile (per-tile heap allocation and blending dispatch), wraps `Cursor<&mut Vec<u8>>` in a redundant `BufWriter` (`L556-557`), and writes `output_bytes` via `fs::write` (`L562`).
  3. `fetch_extractor_text` (`L126-147`) walks all ancestors of `current_dir` and `current_exe` on every call even in release builds; `fetch_bytes` (`L111-117`) and `fetch_text` (`L88-90`, now called by both `src/js/urlLoader.js` and `src/js/menubar.js:93-96`) have no response size caps; `L75-86`, `L98-109`, and `L283-294` repeat request/header setup; `read_head` (`L447`) heap-allocates `vec![0u8; 16]`.
- **Agreed fix:**
  1. Resolve library write scope once in `download_to_file`, check an in-process relocation `AtomicBool` in the chunk loop (running disk lock checks only at start and before publish), wrap writes in `BufWriter`, and stage in a hidden `.tmp` sibling on the destination volume (enabled by S08's `.tmp` watcher filter in `R5`).
  2. In `apply_tile_descramble`, enforce `image::Limits`, replace `HashSet` with `vec![false; total]`, allocate one output buffer copying tiles with `GenericImageView::view` + `copy_from` (copying only remainder strips when needed, zero full-image clone), and stream the encoder directly into `BufWriter<File>`.
  3. Share a `build_get_request` helper, gate ancestor `extractors/` probing behind `cfg!(debug_assertions)` or a cached `OnceLock`, enforce named `MAX_FETCH_TEXT_BYTES` (sized to fit GitHub `releases?per_page=30` JSON payloads from `menubar.js:93-96`, for example `>= 2 MiB`) and `MAX_FETCH_BYTES` caps, and use a stack `[u8; 16]` in `read_head` while preserving `verify_image_magic` IPC.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml network_tests` asserting zero per-chunk lock `stat`s, size caps, alignment/remainder descramble parity, and `>= 2x` descramble speedup with zero per-tile heap allocations on a 1600x2182 fixture, plus `npm run e2e -- --spec e2e/specs/08-url-loader.e2e.js`.

### S10-09 `[Blocking]` `src-tauri/src/commands/network.rs`: migrate sixteen inline `#[cfg(test)]` tests to `tests/`

- **Targets:** `src-tauri/src/commands/network.rs:567-881`
- **Problem:** `commands/network.rs` embeds 16 inline `#[cfg(test)]` tests. `test_fetch_extractor_text_finds_local_manifest` (`L572`) depends on process CWD containing `extractors/manifest.json`, and `tile_descramble_fixture_if_present` (`L859`) references a machine-local `opencode/kmanga-page1.jpg` path that silently returns if absent.
- **Agreed fix:** Move all 16 tests to `src-tauri/src/tests/network_tests.rs` mounted via `#[path]` per `R7`, replace CWD/machine-local dependencies with deterministic in-repo fixtures or generated temp fixtures, and add tests for scoped `DownloadCancelFlag`, fetch size caps, and zero-clone descramble parity.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml network_tests` confirming all migrated and new tests pass deterministically with zero inline `#[cfg(test)]` remaining.

### S10-10 `[Warning]` `src-tauri/src/image_import.rs`: duplicate file opens, 8 MiB SVG read in `prepare`, slow DIB PNG save, and zero tests

- **Targets:** `src-tauri/src/image_import.rs:53-182,209-224`
- **Problem:**
  1. `has_image_header` (`L58-68`) and `svg_text` (`L70-85`) duplicate file-open, 1 KiB header read, `image::guess_format`, and BOM-trimmed `<` detection.
  2. `prepare` (`L135`) calls `svg_text(path)`, which opens the file, reads 1 KiB, re-stats, and reads up to 8 MiB into a `String` solely to check `!text.is_empty()` (`L137`, already proven by `size == 0` at `L105`), discarding the string. Raster captures then open `path` a third time (`L145`), and AVIF files open a fourth time in `avif_dimensions` (`L209-224`) and read up to 128 MiB with `fs::read`.
  3. `dib` conversion (`L131-133`) encodes up to 256 MiB bitmaps using default slow PNG compression, `PreparedImage` (`L53-56`) omits the computed SHA-256 hash so `library::publish_captured_image` hashes the file again, and `image_import.rs` has zero unit tests.
- **Agreed fix:** Extract one `sniff_capture_head` helper, inspect header bytes once in `prepare` without allocating an 8 MiB `String` for `sanitized_svg`, expose `pub hash: String` on `PreparedImage`, encode DIB-to-PNG via `PngEncoder::new_with_quality(..., CompressionType::Fast, FilterType::Sub)`, reuse `formats::read_mp4_dimensions` (`Sync F`), and mount `src-tauri/src/tests/image_import_tests.rs` via `#[path]` covering headers, SVG limits, DIB V3/V4/V5 bitfields, dimensions, and `PreparedImage.hash`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml image_import_tests` and `npm run e2e -- --spec e2e/specs/07-os-integration.e2e.js`.

### S10-11 `[Blocking]` `src-tauri/src/platform/drop.rs`: lock held across 8 MiB file read, poisoned panics, monolith structure, and zero tests

- **Targets:** `src-tauri/src/platform/drop.rs:1-834` (specifically `L161,169,176-200,202,242,285,294,344,399,426,451`)
- **Problem:** `describe` (`L176-200`) holds `registry().lock()` while calling `crate::image_import::svg_text(&capture.path)` (`L194`), performing up to 8 MiB of blocking disk I/O while blocking UI-thread `DragEnter`/`Drop` (`L344,399`) and the watchdog (`L242`). All 11 `.lock().unwrap()` calls also panic on poison. The 834-line file packs four separate concerns, lacks unit tests, and duplicates `parse_local_path` (`L658-694`) with `src/js/services/importActions.js:1-29`.
- **Agreed fix:** Release `registry()` before calling `image_import::svg_text` in `describe` (holding only a cloned capture path/lease check under the lock), handle lock poison gracefully, split `platform/drop.rs` into cohesive submodules (`registry`, `target`, `ole_receive`, `local_path`), and add `src-tauri/src/tests/drop_tests.rs` via `#[path]` testing `parse_local_path`, `Registry` lease/cancel/timeout transitions, `Capture::drop` cleanup, and `commands::drop` (`workspace_only` + retryable publish).
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml drop_tests` confirming zero mutex hold during `svg_text` and state-transition/path-parsing parity, plus `npm run e2e -- --spec e2e/specs/07-os-integration.e2e.js`.

### S10-12 `[Warning]` `src-tauri/src/platform/drop.rs`: 1 Hz idle watchdog, 256 MiB `HGLOBAL` copy, unbounded inline decode, and temp scan churn

- **Targets:** `src-tauri/src/platform/drop.rs:239-264,273,517-529,542-571,630-633,709,790-827`
- **Problem:**
  1. The watchdog thread (`L239-264`) wakes every 1 second forever to lock `registry()`, even when idle, and never exits on `shutdown()` (`L293-301`).
  2. `Formats::new()` (`L273`) re-registers 9 clipboard formats on every installed window; `global_bytes` (`L517-529, 630-633`) allocates and copies up to 256 MiB into a `Vec<u8>` before writing to disk; `receive` (`L790-800`) calls both `offers_global` (`QueryGetData`) and unconditional `get` (`GetData`).
  3. The browser-temp copy loop (`L802-812`) uses `std::io::copy` without checking `cancelled`; `data:image/;base64` (`L817-826`) does not enforce `MAX_CAPTURE_BYTES` directly (while `text_value` at `L709` truncates/rejects `HGLOBAL` at `MAX_SVG_BYTES` = 8 MiB); `cleanup_abandoned_captures` (`L542-571`) allocates `entry.path()` for every unrelated `%TEMP%` entry before checking filename prefix and suffix.
- **Agreed fix:** Replace the 1 Hz polling watchdog with a `Condvar` that blocks indefinitely when `pending.is_none()`, waits with timeout only when active, and exits cleanly on `shutdown()`. Cache `Formats` in `OnceLock<Formats>`, stream locked `HGLOBAL` slices via an RAII `GlobalLockGuard` without `to_vec()`, drop redundant `offers_global` calls where `GetData` runs unconditionally, share a chunked cancel-aware copy helper for `L802-812`, enforce `MAX_CAPTURE_BYTES` on decoded `data:image/` payloads, and check filename extension string suffixes before allocating `PathBuf` in `cleanup_abandoned_captures`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml drop_tests` asserting `Condvar` idle block and shutdown exit, zero-copy `HGLOBAL` stream helper, and cancel-aware copy bounds, plus `npm run e2e -- --spec e2e/specs/07-os-integration.e2e.js`.

### S10-13 `[Blocking]` `src-tauri/src/platform/temp_archive.rs`: decompose monolith, drop `tauri::State`, and fix test mount visibility

- **Targets:** `src-tauri/src/platform/temp_archive.rs:4,1268-1291`, `src-tauri/src/commands/archives.rs:82`, `src-tauri/src/lib.rs:217`
- **Problem:** `platform/temp_archive.rs` (1,478 lines) mixes pure temp-path/window-title parsers, Win32/UIA/registry window discovery, archive entry matching, and a `tauri::State<'_, RwLock<ArchiveCache>>` adapter (`L4, L1268-1279`). Mounting `tests/temp_archive_tests.rs` in `lib.rs:217` instead of inside `temp_archive` also forces ~18 internal symbols (`CandidateArchive`, `TempEngine`, `parse_temp_engine`, `match_candidate_origin`, etc.) to be `pub`.
- **Agreed fix:** Decompose `platform/temp_archive.rs` into cohesive submodules (`mod.rs`, `parsers.rs`, `discovery.rs`, `matcher.rs`), change `resolve_temp_origin(path: &str, cache: &RwLock<ArchiveCache>)` to accept `&RwLock<ArchiveCache>` called with `&*state` from `commands/archives.rs:82` (removing `tauri::State` from `platform/`, Sync F with S09), and move `#[path = "../tests/temp_archive_tests.rs"]` from `lib.rs:217` into `platform/temp_archive/mod.rs` per `R7` so internal helpers tighten to `pub(crate)` or private.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml temp_archive_tests` and `npm run e2e -- --spec e2e/specs/07-os-integration.e2e.js` confirming exact `resolve_archive_temp_origin` IPC parity.

### S10-14 `[Blocking]` `src-tauri/src/platform/temp_archive.rs`: process-wide WindowStation mutation, unconditional UIA scans, and duplicate archiver lookups

- **Targets:** `src-tauri/src/platform/temp_archive.rs:219-358,410-434,498-557,687-949,976,1019-1041,1117-1229,1277,1312`
- **Problem:**
  1. `enumerate_top_level_windows` (`L269-358`) calls `SetProcessWindowStation(hwinsta)` (`L330`), mutating process-wide state without restoring the prior handle, and runs `enum_proc` across both `EnumWindows` (`L325`) and `EnumDesktopsW`/`EnumDesktopWindows` (`L344`), invoking `get_nanazip_address_bar` (`L498-557`) twice per NanaZip window even when `engine` is WinRAR, Bandizip, WinZip, or Windows Explorer.
  2. `get_nanazip_address_bar` spawns an OS thread per window, calls `CoInitializeEx` without `CoUninitialize`, and walks the full UIA subtree via `CreateTrueCondition()` + `FindAll(TreeScope_Descendants)` (`L520-526`).
  3. `collect_candidates` (`L687-949`) queries all 5 archivers' registry, AppData, and UWP histories plus Explorer folders regardless of `TempEngine`, `scan_folder_archives` (`L708,724,739,768,1032-1041`) re-scans duplicate directories such as `Downloads` up to 10 times, `WindowsExplorer` candidates are not pre-filtered by `archive_filename` before `resolve_temp_origin_from_candidates` (`L1312`) calls `ArchiveCache::prepare_archive` under the `RwLock` write lock (`L1277`), and raw `extern "system"` FFI (`L219-266`), 4x hardcoded extension lists (`L412,842,1121,1164,1198`), `is_supported_archive` (`L1019`), WinRAR title parsing (`L410` vs `L1117`), 24x `trimmed.to_lowercase()` (`L1168,1182`), and `O(N^2)` dedup (`L976`) add unnecessary overhead and duplication.
- **Agreed fix:**
  1. Replace raw FFI with `windows` crate bindings, remove `SetProcessWindowStation` mutation and duplicate `EnumWindows`+`EnumDesktopWindows` scan, and skip `enumerate_top_level_windows` entirely for `WinZip` and `WindowsExplorer` (unless Explorer `CabinetWClass` is needed).
  2. Scope `collect_candidates` and live window inspection strictly to the parsed `TempEngine`; in `get_nanazip_address_bar`, use `CreatePropertyCondition(UIA_AutomationIdPropertyId, "TextBoxElement")` + `FindFirst` with an RAII `CoUninitialize` guard only when `TempEngine::SevenZip` matches.
  3. Deduplicate `scan_folder_archives` with a `scanned_dirs: HashSet<PathBuf>`, pre-filter `WindowsExplorer` candidates by `archive_filename` before acquiring `RwLock<ArchiveCache>` write lock, reuse `crate::formats::is_archive_ext` (`Sync F`), share one WinRAR title/address-bar parser, compute `to_lowercase()` once per item in `parse_7z_folder_history`, and deduplicate with a `HashMap<String, usize>` index.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml temp_archive_tests` adding `WinZip`/`PeaZip` `match_candidate_origin`, `WindowsExplorer` filename pre-filter, `scan_folder_archives` dir dedup, `resolve_temp_origin_with_cache`, and explicit fixture assertion, plus `npm run e2e -- --spec e2e/specs/07-os-integration.e2e.js` verifying zero UIA spawns for non-7z engines and zero duplicate folder scans.

## Dropped items

1. **Retarget `platform/drop.rs:150` `emit_to("main", "quivit-drop", ...)` to broadcast or source window:** Dropped. `src/js/main/dropzone.js` and `importActions.js` run only in `"main"`, while `windows.rs:166` installs native drop targets on detached `workspace-file-list` windows too. Changing the target would break drops on detached windows.
2. **Remove permanent-delete fallback on Recycle Bin failure (`commands/directory.rs:505-516`):** Dropped. Drives and network shares without a Windows Recycle Bin rely on the fallback. Keep the fallback intact while fixing `entry.symlink_metadata()` at `L409` and moving `move_to_recycle_bin` to `platform/shell.rs`.

## Cross-split seams

- **Sync C (`urlLoader.js`, `menubar.js`, `dropzone.js`, `importActions.js` with S02, S04, S05):** S10 moves `DownloadCancelFlag` to `src-tauri/src/network.rs` (`crate::network::DownloadCancelFlag`) with `cancel_all()`, `cancel_scope(scope)`, and `token(scope)`, and adds optional `cancel_scope: Option<String>` on `download_to_file` and `cancel_download` so gallery queue cancellation stops aborting unrelated raw downloads (`#74`). `menubar.js:93-96` is now a second caller of `fetch_text` (`commands/network.rs:71`), so `#U03-08`'s `MAX_FETCH_TEXT_BYTES` cap must accommodate GitHub `releases?per_page=30` JSON payloads (for example `>= 2 MiB`). `quivit-download-threshold` (`{ requestId, queueGeneration }`) and `emit_to("main", "quivit-drop", DropEvent)` remain unchanged. Same-volume `.tmp` staging in `download_to_file` pairs with S08's `.tmp` filter in `watchers.rs` (`R5`).
- **Sync D (Config cache, path remapping, and `has_gallery_sidecar` with S01, S08):** S10 consumes S08's cached `config::configured_library_dir()` and `retired_library_paths`, shares the JSON path-walker helper between `config.rs:243-325` and `library.rs:538-629`, and populates `DirectoryReadResult.has_gallery_sidecar: bool` (`commands/directory.rs:35`) so `fsUtils.js:580-607` skips failing `read_text_file` IPCs.
- **Sync E (Rust module layout, `models.rs`, and `#[path]` test mounts with S08, S09, S11):** Per `R5`, `R6`, and `R7`, S10 extracts `src-tauri/src/library.rs` and `src-tauri/src/network.rs`, receives `get_library_dir` and `get_default_library_dir` into `commands/library.rs`, places `move_to_recycle_bin` into shared `platform/shell.rs`, moves `LibraryMoveResult` into `models.rs`, preserves all 23 active S10 IPC commands and 3 events (`quivit-drop`, `quivit-download-threshold`, `library-relocated`), migrates all 22 inline `#[cfg(test)]` tests (`directory` 5, `library` 1, `network` 16) into `src-tauri/src/tests/`, adds `tests/{image_import,drop}_tests.rs`, and moves `tests/temp_archive_tests.rs` mount from `lib.rs:217` into `platform/temp_archive/mod.rs`.
- **Sync F (`temp_archive`, `formats`, and `utils` with S08, S09):** `platform/temp_archive.rs:1268-1291` changes `resolve_temp_origin(path: &str, cache: &RwLock<ArchiveCache>)` to accept `&RwLock<ArchiveCache>` called with `&*state` from `commands/archives.rs:82` (`S09`). S10 reuses `crate::formats::{is_archive_ext, read_mp4_dimensions}` (`S09`) and `crate::utils::{base64_decode_bytes, url_decode}` (`S08`).

## Telemetry A/B specification

- **`cargo test --manifest-path src-tauri/Cargo.toml` (primary suite):**
  - *Baseline:* 39 passing tests: `commands::directory::tests` (5), `commands::library::tests` (1), `commands::network::tests` (16), and `temp_archive_tests` (17).
  - *Telemetry A additions:* Migrate the 22 inline tests into `src-tauri/src/tests/{directory_tests,library_tests,network_tests}.rs` via `#[path]` without CWD, live-config, or machine-local fixture dependencies. Add `src-tauri/src/tests/image_import_tests.rs` (`has_image_header`, `svg_text`, `prepare` across PNG/JPEG/AVIF/SVG/DIB V3+V4+V5, pixel/byte limits, `PreparedImage.hash`, `bmp_header_from_dib` edge cases) and `src-tauri/src/tests/drop_tests.rs` (`parse_local_path`, `commands::drop` `workspace_only` + retryable publish, `Capture::drop`, `Registry` lease/cancel/timeout). Expand `directory_tests`, `library_tests`, `network_tests`, and `temp_archive_tests` (`WinZip`/`PeaZip` matching, `WindowsExplorer` filename pre-filter, `scan_folder_archives` dir dedup, `resolve_temp_origin_with_cache`, non-silent fixture check).
  - *Telemetry B checks:* All migrated, expanded, and new tests pass with zero inline `#[cfg(test)]` blocks remaining in S10 files, single `stat` on `input_path` plus zero `config.json` reads per cached `read_directory_impl`, `O(1)` probe in `find_directory_metadata`, zero per-chunk lock `stat`s in `download_to_file`, `>= 2x` faster zero-clone `apply_tile_descramble` on 1600x2182, zero idle watchdog wakeups and zero mutex hold across `svg_text` in `platform/drop`, and zero non-7z UIA spawns or duplicate folder scans in `temp_archive`.
- **`npm run e2e -- --spec <file>` (integration suite):**
  - *Specs:* `e2e/specs/01-startup.e2e.js`, `02-navigation.e2e.js`, `05-persistence.e2e.js`, `07-os-integration.e2e.js`, and `08-url-loader.e2e.js`.
  - *Telemetry A/B checks:* Verify live IPC parity across `read_directory` (`has_gallery_sidecar`), `get_drives`, `get_file_sizes`, `get_path_kind`, `move_library`, `library_move_in_progress`, `library-relocated`, `resolve_archive_temp_origin`, native drop, `fetch_extractor_text`, `fetch_text`, `download_to_file`, `verify_image_magic`, `cancel_download`, `quivit-download-threshold`, `read_library_tree`, `remove_directory`, `write_text_file`, and `remove_file`.
- **`npm run mocha` and `npm run diagnose -- sample-navigation` (read-only contract checks):**
  - Confirm `mocha/diagnosticsContract.test.js` and `ipcProtocolProbe.js` remain green across all 23 active S10 IPC commands and 3 Rust-to-JS events.
