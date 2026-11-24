# Audit 09: backend media, archives, and protocol (`be-media-archives-protocol`)

Split S09 covers 18 backend files totaling 5,925 lines across the `quivit://` async protocol handler, media format and header parsers, ICO frame extraction, the `ArchiveCache` and format readers (`zip`, `rar`, `sevenz`, `tar`, `encoding`), archive and animation/scanning IPC commands, Windows native shell icon and thumbnail extractors, and their Rust unit test suites. Read-only reference `icons/formats/*` was checked and all 22 `.ico` assets match `SUPPORTED_FORMATS` and `FORMAT_ICONS` 1:1.

Both S09 workers, `s09-protocol-perf` and `s09-media-arch`, ran independent passes across all 18 files, cross-verified every `file:line` target and caller in live code, reached unanimous `[Agree]` on 10 findings (`S09-01` to `S09-10`) and 3 cohesive files (`#94`, `#96` to `#99`), and ratified the cross-split seam matrix in `cross-split-seams.md` (`R5`, `R6`, `R7`, Sync E, and Sync F, `#120`). Baseline `cargo test --manifest-path src-tauri/Cargo.toml --lib` passed all 111 tests (including 10 in `archive_tests`, 15 in `format_tests`, 3 in `ico_tests`, and 11 in `protocol_tests`).

## File coverage ledger

| File | Lines | Status | Findings |
|---|---|---|---|
| `src-tauri/src/protocol.rs` | 415 | `[Agreed]` | `S09-01`, `S09-03` |
| `src-tauri/src/formats.rs` | 1,148 | `[Agreed]` | `S09-06`, `S09-08` |
| `src-tauri/src/ico.rs` | 107 | `[Agreed]` | `S09-08` |
| `src-tauri/src/archives/mod.rs` | 482 | `[Agreed]` | `S09-01`, `S09-02`, `S09-04`, `S09-07` |
| `src-tauri/src/archives/cache.rs` | 542 | `[Agreed]` | `S09-01`, `S09-04`, `S09-07` |
| `src-tauri/src/archives/encoding.rs` | 20 | `Cohesive` | None |
| `src-tauri/src/archives/zip.rs` | 318 | `[Agreed]` | `S09-02` |
| `src-tauri/src/archives/rar.rs` | 191 | `[Agreed]` | `S09-05` |
| `src-tauri/src/archives/sevenz.rs` | 182 | `[Agreed]` | `S09-05` |
| `src-tauri/src/archives/tar.rs` | 145 | `[Agreed]` | `S09-05` |
| `src-tauri/src/commands/archives.rs` | 83 | `[Agreed]` | `S09-01`, `S09-08`, `S09-09` |
| `src-tauri/src/commands/animation.rs` | 554 | `[Agreed]` | `S09-01`, `S09-07` |
| `src-tauri/src/platform/icons.rs` | 388 | `[Agreed]` | `S09-03`, `S09-10` |
| `src-tauri/src/platform/thumbnails.rs` | 476 | `[Agreed]` | `S09-08`, `S09-10` |
| `src-tauri/src/tests/archive_tests.rs` | 340 | `[Agreed]` | `S09-04` |
| `src-tauri/src/tests/format_tests.rs` | 294 | `[Agreed]` | `S09-06` |
| `src-tauri/src/tests/ico_tests.rs` | 70 | `Cohesive` | None, expanded in Telemetry A |
| `src-tauri/src/tests/protocol_tests.rs` | 170 | `Cohesive` | None, expanded in Telemetry A |

All 18 owned files are accounted for: 15 files carry findings, 3 files are cohesive, 0 findings were dropped, and 0 were escalated.

## Agreed findings

### S09-01 `[Blocking]` Eliminate global `RwLock<ArchiveCache>` write-lock stalls and temp-directory drop race

- **Targets:** `src-tauri/src/commands/animation.rs:41-44,63-66`, `src-tauri/src/commands/archives.rs:15-22,44-61,64-75`, `src-tauri/src/archives/mod.rs:84-121,259-316,395-418`, `src-tauri/src/archives/cache.rs:86-94,394-409`, `src-tauri/src/protocol.rs:162-168`
- **Problem:**
  1. `check_is_animated` (`commands/animation.rs:41-44`) and `check_media_audio` (`:63-66`) hold `RwLock<ArchiveCache>::write()` across `cache.read_entry_header(...)`. For RAR, 7z, and TAR archives, `read_temp_entry_header` (`archives/mod.rs:259-316`) blocks on `Condvar::wait_timeout` for up to 30 seconds and then runs `fs::File::open` and `read` while holding the global write lock. That stalls every concurrent `quivit://archive/`, `list_archive`, `drop_archive_cache`, and `prefetch_archive_entries` call across the app.
  2. `prefetch_archive_entries` (`commands/archives.rs:44-61`) loops `cache.read_entry_bytes` under `state.write()`, blocking foreground `quivit://archive/` fetches during background ZIP decompression.
  3. `list_archive` (`commands/archives.rs:15-22`) holds `state.write()` across full archive open, header validation, entry listing, and password decompression tests (`sevenz.rs:114-127`, `rar.rs:96`).
  4. `get_archive_ico_frames` (`commands/archives.rs:64-75`) holds `state.write()` across ZIP inflation or temp-file `fs::read`.
  5. `read_temp_entry_bytes` (`archives/mod.rs:413`, reached from `protocol.rs:162-166`) runs `fs::read(&file_path)` under `state.write()`.
  6. `SingleArchiveCache::drop` (`archives/cache.rs:86-94`) sets `extract_cancel` with `Ordering::Relaxed` and runs `fs::remove_dir_all(dir)` synchronously under `state.write()` during `drop_archive` and `evict_idle_archives`. A live `spawn_temp_extractor` thread inside `write_temp_entry` (`cache.rs:394-409`) can recreate `temp_dir` via `fs::create_dir_all(parent)` after the drop ran and leave orphaned files.
  7. `read_temp_entry_header` (`archives/mod.rs:275-303`) duplicates the 25-line `Condvar` wait loop in `ArchiveEntryData::wait_for_data` (`:87-119`).
- **Agreed fix:**
  1. Extract a shared unlocked `wait_for_extracted_path(file_path, notify, entry_name) -> Result<PathBuf, String>` helper and add `ArchiveEntryData::ReadyPath(PathBuf)` so `fs::read` runs after dropping the `ArchiveCache` lock.
  2. Add an unlocked `read_entry_header_shared(state, archive_path, entry_name, limit)` facade method for `check_is_animated` and `check_media_audio` so header inspection never holds `state.write()` across `Condvar` waits, ZIP inflation, or file reads.
  3. Route `prefetch_archive_entries` and ZIP `get_archive_ico_frames` through the unlocked `read_plain_zip_entry_shared` path (dropping the duplicated extension check at `commands/archives.rs:49-52`).
  4. Split `prepare_archive` into unlocked disk listing (`open_and_list_archive`) followed by a short-locked registration step (`register_prepared_archive`).
  5. Use `Release`/`Acquire` ordering on `extract_cancel`, have `spawn_temp_extractor` re-check `cancel_flag` before creating or writing `temp_dir` and clean up `temp_dir` on cancelled exit, and return evicted temp `PathBuf`s from `drop_archive` / `evict_idle_archives` to delete on a background thread outside `state.write()` (keeping synchronous cleanup on `RunEvent::Exit`).
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml archive_tests` and new `animation_tests` proving concurrent `quivit://archive/` / `read_plain_zip_entry_shared` calls do not block while `check_is_animated` waits on a pending RAR/7z/TAR extraction or `prefetch_archive_entries` runs; `npm run diagnose -- manhwa-buffer` and `manhwa-width-span` confirming lower p95 `/archive/` and `check_is_animated` latency under concurrent prefetch.

### S09-02 `[Blocking]` Fix unlocked ZIP hot path Central Directory re-parse, 128 KiB tail scan, and O(N) CJK fallback

- **Targets:** `src-tauri/src/archives/mod.rs:427-459`, `src-tauri/src/archives/zip.rs:10-67,134-189,233-318`
- **Problem:**
  1. `read_plain_zip_entry_shared` (`archives/mod.rs:427-459`) acquires `state.write()` even for already-registered archives (`:437`), calls `prepare_archive_state` redundantly (`:445`), and never passes `SingleArchiveCache.zip_index_map` into `zip::extract_zip_entry` (`zip.rs:271-278`).
  2. `zip::extract_zip_entry` calls `open_zip_archive` on every single cache miss, opening a new `File`, reading and scanning up to 128 KiB from the tail twice (`validate_zip_header` at `zip.rs:28-42`), re-parsing the entire Central Directory, and then passing `index_map = None` into `read_zip_entry_by_decoded_name`. For CJK (Shift-JIS, GBK, EUC-KR) or backslash entry names, `by_name` misses and triggers an O(N) loop over all entries calling `by_index` plus `chardetng::EncodingDetector` on every page fetch.
  3. `list_zip_entries` (`zip.rs:134-189`) repeats the same 15-line `index_map` insert and `FileEntry::new_archive_entry` fallback across three `Err` arms. `read_zip_entry_by_decoded_name` (`:233-269`) and `read_zip_entry_header` (`:280-318`) duplicate the same three-tier lookup (`index_map`, `by_name`, O(N) CJK scan).
- **Agreed fix:**
  1. Store `zip_index_map` as `Arc<HashMap<String, usize>>`. In `read_plain_zip_entry_shared`, take `state.read()` first to check cache hits, password status, stored password, and `Arc::clone` of `zip_index_map`, upgrading to `state.write()` only when the archive is not yet registered.
  2. Forward the cached `zip_index_map` into unlocked extraction and avoid re-running the 128 KiB EOCD validation and Central Directory parse on every entry (using a small bounded per-archive `ZipArchive` handle pool or skipping `validate_zip_header` on already-validated open archives while keeping extraction unlocked across concurrent threads).
  3. In `validate_zip_header` (`zip.rs:28-42`), scan the final 4 KiB backwards first before falling back to `MAX_TAIL_SCAN` (128 KiB) in a single pass.
  4. Extract a shared `push_fallback_entry` helper for `zip.rs:134-189` and a shared ZIP entry locator for `zip.rs:233-318`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml archive_tests` adding `read_plain_zip_entry_shared` tests for cache hit/miss, concurrent fetches, unlocked encrypted ZIP password forwarding, and O(1) CJK entry lookup via `zip_index_map`; `npm run e2e -- --spec e2e/specs/04-archives.e2e.js`.

### S09-03 `[Blocking]` Fix `protocol.rs` substring route collisions, repeated builders, and `/icon/` plus `/tiff/` latency

- **Targets:** `src-tauri/src/protocol.rs:8,20-185,289-304,381-411`, `src-tauri/src/platform/icons.rs:165-190`
- **Problem:**
  1. `register_quivit_protocol` dispatches routes with `url.contains("/icon/")` (`:20`), `url.contains("/thumb/")` (`:48`), and `url.contains("/tiff/")` (`:75`) before falling through to `parse_archive_url` (`:111`). An archive entry inside a subfolder named `icon/`, `thumb/`, or `tiff/` (for example `http://quivit.localhost/archive/<b64>/thumb/01.png` when unencoded or slash-bearing) matches the wrong branch and fails with HTTP 400.
  2. The doc comment at `protocol.rs:8` lists `quivit://archive/...` instead of the live host+path format (`http://quivit.localhost/archive/...` and `quivit://localhost/archive/...`).
  3. Eleven response paths (`:24-28,38-41,52-56,65-68,79-83,89-92,101-104,114-117,152-155,177-180,297-300`) repeat inline `Response::builder().status(...).body(...).unwrap()` blocks.
  4. `guess_mime` (`:381-411`) duplicates the image/media extension list outside `formats`.
  5. Every `/icon/` request schedules a `spawn_blocking` task (`:33`) even when the PNG is already resident in `NATIVE_ICON_CACHE`.
  6. `/tiff/` (`:75-109`) and archive TIFF entries (`:124,294-302`) re-decode and re-encode the entire TIFF to PNG on every fetch because `try_cached_entry_response` skips TIFF and no bounded decoded-PNG cache exists.
- **Agreed fix:**
  1. Match routes on `request.uri().path()` prefixes (`starts_with("/icon/")`, `"/thumb/"`, `"/tiff/"`, `"/archive/"`) through a single route parser, and update the stale doc comment at `:8`.
  2. Extract an `error_response(status, msg)` helper and move `guess_mime` into `formats` (re-exported by `formats/mod.rs`).
  3. Add a `try_get_cached_native_icon_png_with_size` fast path using `try_lock` so cached `/icon/` hits respond immediately without `spawn_blocking` (matching `try_cached_entry_response`).
  4. Add an optional bounded transcoded-PNG LRU for TIFF responses keyed by `(path_or_archive_entry, file_len_or_mtime)` and cleared on `drop_archive` so stale bytes are never served, while keeping `Cache-Control: no-store` and `Access-Control-Allow-Origin: *` intact.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml protocol::tests` adding route-collision cases (`/archive/<b64>/icon/1.png`, `/archive/<b64>/thumb/1.png`, `/archive/<b64>/tiff/1.png`), `?size=32`, and invalid TIFF 422 responses; `npm run e2e -- --spec e2e/specs/03-viewer.e2e.js` (TIFF `test-files/50-51.tif`); `npm run diagnose -- manhwa-buffer`.

### S09-04 `[Warning]` Fix `ArchiveCache` O(N) LRU, poison panics, `max_open_archives == 0` loop, and facade encapsulation

- **Targets:** `src-tauri/src/archives/cache.rs:96-358`, `src-tauri/src/archives/mod.rs:1,16-22,481-482`, `src-tauri/src/lib.rs:17,98-99,203,208-210`, `src-tauri/src/tests/archive_tests.rs:192,221-319`
- **Problem:**
  1. On every ZIP cache hit (`cache.rs:181-189,283-296`), including synchronous WebView protocol hits via `try_cached_entry_response`, `touch_zip_entry` locks `self.lru.lock().unwrap()` twice (once directly and once via `touch_archive` at `:128`), allocates three `String`s, and performs O(N) `VecDeque::retain` scans over `global_zip_lru` and `archive_lru`.
  2. Ten `self.lru.lock().unwrap()` calls (`:128,184,198,206,224,241,256,266,321,348`) panic on mutex poison instead of recovering like `notify_extracted`.
  3. `evict_idle_archives` (`:204-218`) enters an infinite loop if `max_open_archives == 0` while `archive_lru` holds `keep_path`.
  4. `archives/mod.rs:1` declares `pub(crate) mod cache;` solely so `lib.rs:98-99,203` can call `crate::archives::cache::{acquire_temp_lock, cleanup_orphaned_temp_dirs, cleanup_current_temp_dir}`. `archives/mod.rs:19-22` re-exports internal `list_*_entries` and `cache.rs:333-357` exposes four `#[cfg(test)] pub(crate)` helpers because `tests/archive_tests.rs` is mounted at `lib.rs:209` (depending on wildcard `use archives::*;` at `lib.rs:17`, which S08 removes per R7).
  5. `archive_tests.rs:192` silently returns if `corrupt_local_header.zip` is missing (verified present in `test-files/_archives/encrypted_tests/`), and five tests (`:221,245,261,285,319`) reuse fixed temp directory names under `%TEMP%`.
- **Agreed fix:**
  1. Combine `touch_zip_entry` and `touch_archive` into a single poison-safe mutex acquisition with O(1) recency tracking (generation counter / slot index or intrusive LRU map) and shared `Arc<str>` keys. Guard `evict_idle_archives` against `max_open_archives == 0` when only `keep_path` remains.
  2. Re-export `acquire_temp_lock`, `cleanup_orphaned_temp_dirs`, and `cleanup_current_temp_dir` from `archives/mod.rs`, make `mod cache;` private, and update `lib.rs:98-99,203` to call `crate::archives::*` (R7).
  3. Move `#[cfg(test)] #[path = "../tests/archive_tests.rs"] mod tests;` into `archives/mod.rs` (removing `lib.rs:208-210`), narrowing `list_*_entries` and test-only cache helpers to `archives`-module visibility.
  4. Assert fixture presence in `archive_tests.rs:192` and use unique PID/test-scoped temp directories at `:221-319`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml archives::tests` verifying relocated mount compiles after S08 removes `lib.rs:17` wildcard, plus new assertions for `max_open_archives == 0`, `list_archive_names`, and `drop_archive` temp cleanup.

### S09-05 `[Warning]` Eliminate full-file TAR listing reads, duplicate 7z opens, and RAR RAM buffering

- **Targets:** `src-tauri/src/archives/tar.rs:70-145`, `src-tauri/src/archives/sevenz.rs:60,110-136,171-175`, `src-tauri/src/archives/rar.rs:48-63,96-130,168-170`
- **Problem:**
  1. `list_tar_entries` (`tar.rs:70-77`) wraps an unbuffered `fs::File` in `tar::Archive::new(file)` and calls `archive.entries()`, which sequentially reads every payload byte of the archive (92 MB for `test-files/_archives/tar.tar`, 88 MB for `cbt.cbt`) just to list entry names. `extract_tar_to_temp` (`:113,136`) also uses unbuffered `File` reads and writes.
  2. `list_7z_entries` (`sevenz.rs:60,114-127`) opens `sevenz_rust2::ArchiveReader::open(archive_path, pwd)` a second time when verifying a password, instead of reusing the already-open reader. `extract_7z_to_temp` (`:172`) writes through an unbuffered `fs::File`.
  3. `extract_rar_to_temp` (`rar.rs:168-170`) buffers the entire uncompressed entry into a `Vec<u8>` via `header.read()` before calling `fs::write`. `list_rar_entries` repeats the same password-error substring check at `:51-53`, `:101-103`, and `:119-121`.
- **Agreed fix:**
  1. Switch `list_tar_entries` to `archive.entries_with_seek()` (supported by `tar = "0.4"` on `fs::File`) so listing jumps directly between 512-byte headers in O(entries), and wrap `extract_tar_to_temp` I/O in `BufReader`/`BufWriter`.
  2. Reuse the already-open `mut reader` in `list_7z_entries` after releasing the borrow of `archive`, and wrap `fs::File::create` in `BufWriter` in `extract_7z_to_temp`.
  3. Extract a `is_password_error` helper in `rar.rs`, and switch `extract_rar_to_temp` to streaming extraction (`extract_to`) if `unrar 0.5.8` preserves atomic `.tmp` rename and encrypted-archive parity during implementation.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml archive_tests` adding TAR `entries_with_seek` parity and listing-time comparison on `test-files/_archives/tar.tar`, plus `npm run e2e -- --spec e2e/specs/04-archives.e2e.js` (CBR, CB7, TAR/CBT).

### S09-06 `[Blocking]` Decompose `formats.rs` (1,148L), fix MP4 short-read and 10 MiB alloc bugs, and speed up header probes

- **Targets:** `src-tauri/src/formats.rs:1-1148`, `src-tauri/src/lib.rs:212-214`, `src-tauri/src/tests/format_tests.rs:126-147,260-270`
- **Problem:**
  1. `formats.rs` packs five distinct domains into 1,148 lines: format/icon registry (`:6-244`), TIFF decode/transcode (`:246-335`), animation sniffing (`:337-653`), ISOBMFF/MP4 parsing (`:529-556,658-848`), and header-only dimension probing (`:698-708,850-1148`).
  2. Top-level ISOBMFF `moov` scanning is duplicated three times (`check_mp4_has_audio` `:658-696`, `read_mp4_dimensions` `:712-750`, `read_mp4_dimensions_stream` `:812-848`). All three allocate `vec![0u8; read_len]` upfront (allocating and zeroing 10 MiB whenever `size32 == 0`) and call a single `reader.read(&mut moov_buf)`, which silently truncates on chunked `Read` streams such as `ZipFile` (`:835`).
  3. `read_media_dimensions_from_path` (`:1081-1097`) and `read_media_dimensions_from_stream` (`:1134-1147`) duplicate the same six-branch slice dispatch.
  4. `read_jpeg_dimensions_from_reader` (`:852-898`) calls `read_exact` one byte at a time directly on an unbuffered `&mut file` from `read_media_dimensions_from_path:1103` (one OS syscall per byte).
  5. `read_media_dimensions_from_path` (`:1077-1110`) allocates a 64 KiB heap `Vec` on every file scanned, discards that 64 KiB buffer for TIFF (`:1090-1094`), and opens the file a second time via `ImageReader::open(path)` (`:1105`) on fallback instead of rewinding `file`.
  6. `read_avif_dimensions` (`:901-932`) scans byte-by-byte over 64 KiB instead of walking ISOBMFF boxes via `isobmff_box`, risking false `ispe`/`irot` matches in `mdat`.
  7. `read_svg_dimensions` and helpers (`:989-1065`) allocate `to_ascii_lowercase()` four times per header.
  8. `check_animation_status` (`:353`) runs `bytes.windows(4).any(|w| w == b"<svg")` across 256 KiB of raw bytes for every JPEG, BMP, ICO, and TIFF; `check_svg` (`:646-653`) scans up to three more times; `check_webp` (`:468-473`) and `check_apng` (`:502-503`) scan the whole 256 KiB buffer twice instead of walking RIFF and PNG chunks.
  9. `tests/format_tests.rs` is mounted in `lib.rs:212-214` and hardcodes developer machine paths `C:\Users\x4163\AppData\Local\QuiviT\library\Imgur\...mp4` at `:261,266`.
- **Agreed fix:**
  1. Split `formats.rs` into `src-tauri/src/formats/{mod,registry,tiff,animation,isobmff,dimensions}.rs` with `formats/mod.rs` re-exporting 100% of existing public and `pub(crate)` items (plus relocated `guess_mime` from `protocol.rs` and pure header alpha helpers from `platform/thumbnails.rs`). Mount `#[cfg(test)] #[path = "../tests/format_tests.rs"] mod tests;` in `formats/mod.rs` (removing `lib.rs:212-214` per R7).
  2. Unify all three `moov` readers behind a single bounded helper using `reader.take(read_len as u64).read_to_end(&mut buf)` with `Vec::with_capacity(read_len.min(64 * 1024))` (fixes chunked `ZipFile` short reads and eliminates 10 MiB upfront allocations).
  3. Extract `read_header_dimensions_from_slice` shared by path and stream probers. Probe disk headers with a stack `[u8; 8192]` buffer first (escalating to 64 KiB only for formats that need it), wrap `read_jpeg_dimensions_from_reader` in `BufReader`, and seek the open `File` back to 0 on fallback instead of re-opening `path`.
  4. Walk ISOBMFF boxes via `isobmff_box` in `read_avif_dimensions`. Lowercase the `<svg ...>` tag once in `read_svg_dimensions`.
  5. Gate the `<svg` check in `check_animation_status` on leading ASCII whitespace plus `<` (skipping binary JPEG/BMP/TIFF/ICO payloads), merge `check_svg` into one pass, walk RIFF chunks in `check_webp`, and walk PNG chunks in `check_apng` (updating the two synthetic non-chunk-framed APNG test slices in `format_tests.rs:126-147` to valid `IHDR`/`acTL`/`IDAT` chunk framing in Telemetry A while keeping `test_is_animated_truncated` and testing real `test-files/animated/*.apng` fixtures).
  6. Remove the hardcoded `C:\Users\x4163\...` paths from `format_tests.rs:261-270`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml formats::tests` expanding coverage to `read_mp4_dimensions`, `read_mp4_dimensions_stream` (chunked `Read` + `size32 == 0` + `tkhd` v0/v1), `read_jpeg_dimensions_from_reader` (>64 KiB EXIF), `read_avif_dimensions` (`ispe` + `irot`), `read_ico_dimensions`, `read_svg_dimensions`, `read_media_dimensions_from_{path,stream}`, SVG animation, and TIFF orientation swap; `npm run e2e -- --spec e2e/specs/03-viewer.e2e.js` (animated APNG/AVIF/WebP/GIF in `test-files/animated/*`).

### S09-07 `[Blocking]` Extract domain scanner from `commands/animation.rs` (554L), fix O(N^2) temp scan and syscall waste

- **Targets:** `src-tauri/src/commands/animation.rs:12-73,85-554`, `src-tauri/src/archives/cache.rs:8-12`, `src-tauri/src/archives/mod.rs:481-482`, `src-tauri/src/models.rs`
- **Problem:**
  1. `commands/animation.rs` mixes thin IPC adapters with ~470 lines of directory, ZIP, and temp-archive scanning logic that reaches directly into `archives::open_zip_archive`, `archive.by_index_decrypt`, `archives::decode_cjk_name`, `archives::archive_entry_temp_path`, `ArchiveCache::temp_extraction_state`, and `Condvar` loops.
  2. `scan_container_max_width` (`:85-323`) and `scan_container_dimensions` (`:353-554`) duplicate all three traversal paths (~250 lines duplicated).
  3. `scan_temp_archive_widths` (`:272-284`) and `scan_temp_archive_dimensions` (`:498-510`) scan the entire `guard.extracted: HashSet<String>` on every wakeup, causing O(N^2) hashing and string cloning across large RAR/7z archives.
  4. `scan_directory_widths` (`:135`) and `scan_directory_dimensions` (`:388`) call `path.is_file()` (an extra `GetFileAttributesW` syscall per file) instead of `entry.file_type().map(|t| t.is_file())` (free from `FindNextFileW` on Windows).
  5. `scan_temp_archive_*` (`:241-254,466-479`) polls `temp_extraction_state` with `sleep(50ms) * 10` (500 ms cap) and silently emits `done: true` with empty results if `list_archive` takes longer than 500 ms. Both scan commands spawn unbounded OS threads (`std::thread::spawn` at `:92,360`).
  6. `check_is_animated` (`:48`) unconditionally allocates a 256 KiB heap buffer even for tiny files or 8-byte non-animated headers. `check_media_audio` (`:65`) caps archived MP4 reads at 512 KiB, silently returning `false` when `moov` is at EOF (non-faststart MP4), and passes an unbuffered `File` at `:71`.
  7. `DimensionEntry` (`:326`) is defined in `commands/animation.rs` instead of `models.rs` (Sync E).
- **Agreed fix:**
  1. Extract a shared container-scanning engine into `archives/` and `formats/` so `commands/animation.rs` becomes a thin IPC adapter emitting the exact `manhwa-max-width` (`{ container, max_width, done? }`) and `container-dimensions` (`{ container, entries, done? }`) events without reaching into ZIP or `Condvar` internals (allowing `archives/mod.rs:481-482` to tighten visibility).
  2. Add `extracted_order: Vec<String>` alongside `extracted: HashSet<String>` in `ExtractState` (`archives/cache.rs:8-12`) so temp scanners advance an O(1) cursor slice instead of rescanning the full `HashSet`.
  3. Switch directory scans to `entry.file_type()` and replace unbounded `std::thread::spawn` with bounded blocking execution (retaining `SCAN_GENERATION` and `DIMS_SCAN_GENERATION` cancellation). Replace the 500 ms `sleep` poll with bounded wait/notification when archive preparation registers temp extraction.
  4. Read a small stack buffer first in `check_is_animated` before escalating to 256 KiB; wrap `check_media_audio` disk reads in `BufReader` and stream-walk `isobmff` boxes for archived MP4s so trailing `moov` boxes beyond 512 KiB are detected.
  5. Move `DimensionEntry` into `src-tauri/src/models.rs` (Sync E with S08).
- **Telemetry A/B:** New `src-tauri/src/tests/animation_tests.rs` via `#[path]` covering directory/ZIP/temp width and dimension scans, generation cancellation, O(1) cursor progression, and non-blocking `check_is_animated`/`check_media_audio`; `npm run e2e -- --spec e2e/specs/{03-viewer,04-archives}.e2e.js`; `npm run diagnose -- manhwa-width-span` and `manhwa-directory-entry-fits`.

### S09-08 `[Warning]` Harden `ico.rs` pre-read limits and overlapping-entry DoS, speed up PNG output, and share ICO header parsing

- **Targets:** `src-tauri/src/ico.rs:21-103`, `src-tauri/src/commands/archives.rs:8-12`, `src-tauri/src/formats.rs:936-987`, `src-tauri/src/platform/thumbnails.rs:401-430`
- **Problem:**
  1. `get_ico_frames` (`commands/archives.rs:10`) calls `fs::read(&path)` before `ico_frames_from_bytes` checks `MAX_ICO_BYTES` (64 MiB), allowing a corrupted or renamed multi-gigabyte `.ico` file to blow RAM before validation runs.
  2. In `decoded_ico_frames` (`ico.rs:33-58`), up to `MAX_ICO_ENTRIES` (1,024) directory entries can point to overlapping 64 MiB non-PNG slices, causing up to 1,024 x 64 MiB temporary `synthetic` buffer allocations (`:44`) before failing.
  3. `ico_frames_from_bytes` (`ico.rs:88-95`) re-encodes every frame with default slow `PngEncoder::new`, even when the source entry inside the ICO was already PNG bytes.
  4. ICO directory parsing is hand-rolled in three places: `ico.rs:25-39`, `formats.rs:936-987`, and `platform/thumbnails.rs:401-430`.
- **Agreed fix:**
  1. Add `ico::ico_frames_from_path(path: &Path)` checking file metadata length against `MAX_ICO_BYTES` before reading, and call it from `commands/archives.rs:9-12`.
  2. Deduplicate `(offset, size)` directory entries and cap total BMP payload bytes scanned in `decoded_ico_frames`.
  3. Use `PngEncoder::new_with_quality(..., CompressionType::Fast, FilterType::NoFilter)` in `ico_frames_from_bytes` (or pass validated original PNG entry bytes through directly).
  4. Extract a shared ICO directory entry iterator used by `ico.rs`, `formats/dimensions.rs`, and header alpha detection. Keep `ico_spritesheet_from_bytes` (`ico.rs:66`) intact for S11 `image_pane.rs:336`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml ico::tests` adding `ico_spritesheet_from_bytes` (width/height/limit checks), BMP-masked frame decoding, `ico_frames_from_path` size rejection, and overlapping-offset DoS bounds; `npm run e2e -- --spec e2e/specs/03-viewer.e2e.js` (ICO legacy + manhwa).

### S09-09 `[Warning]` Remove dead IPC `drop_all_archives_cache`

- **Targets:** `src-tauri/src/commands/archives.rs:34-41`, `src-tauri/src/lib.rs:109`
- **Problem:** `drop_all_archives_cache` is registered in `tauri::generate_handler!` (`lib.rs:109`) but has zero callers across `src/`, `mocha/`, and `e2e/`. Exit cleanup at `lib.rs:200` calls `ArchiveCache::drop_all_archives()` directly in Rust.
- **Agreed fix:** Remove the `drop_all_archives_cache` IPC command and its `lib.rs:109` registration per R6 while retaining internal `ArchiveCache::drop_all_archives()` for `lib.rs:200` `RunEvent::Exit`.
- **Telemetry A/B:** `cargo check --tests --manifest-path src-tauri/Cargo.toml` and `npm run e2e -- --spec e2e/specs/04-archives.e2e.js` confirming zero regressions.

### S09-10 `[Warning]` Deduplicate Win32 GDI/PNG/COM code across `platform/icons.rs` and `platform/thumbnails.rs`, bound icon cache, and skip matte disk I/O

- **Targets:** `src-tauri/src/platform/icons.rs:2,33,61-98,153,161-190,204-242,294-376`, `src-tauri/src/platform/thumbnails.rs:29-68,102-123,163-263,310-476`, `src-tauri/src/platform/mod.rs:1-12`
- **Problem:**
  1. `thumbnails.rs:29-68,163-263` duplicates `icons.rs:61-98,294-376` Win32 RAII guards (`ScopedHgdiobj`, `ScopedMemDc`, `ScopedScreenDc`), `CreateDIBSection` readout, BGRA-to-RGBA swap, and PNG encoding.
  2. Both `icons.rs:366` and `thumbnails.rs:253` use default slow `image::write_buffer_with_format(..., ImageFormat::Png)` instead of `PngEncoder::new_with_quality(..., CompressionType::Fast, FilterType::NoFilter)`.
  3. `thumbnails.rs:244-249` calls `source_has_transparency(path, ext_str)` (opening the file on disk and reading 1 KiB) *before* checking in-memory `!has_alpha && has_black_matte_border(&pixels, width, height)`, paying disk I/O on every PNG/GIF/ICO/TIFF thumbnail even when opaque without black borders or already transparent.
  4. `icons.rs:33` defines `NATIVE_ICON_CACHE` as an unbounded `HashMap<String, Vec<u8>>` with no named cap (real-path keys grow without bound, breaking `AGENTS.md` Named Cache Limits). `icons.rs:175` binds `let lower_ext = ext_key.to_string();` without lowercasing, splitting cache entries on case (`JPG` vs `jpg`). `icons.rs:161-163` (`get_cached_native_icon_png`) is dead public code with zero callers. `icons.rs:204-242` calls `SHGetFileInfoW` for real paths without `CoInitializeEx`. `icons.rs:2,153` imports `base64::prelude::BASE64_STANDARD` instead of reusing `crate::utils::base64_encode`.
  5. `thumbnails.rs:119-123` initializes and tears down STA COM (`CoInitializeEx`/`CoUninitialize`) on every unbounded `spawn_blocking` call and fails with `RPC_E_CHANGED_MODE` if a worker thread was MTA-initialized. `thumbnails.rs:102` runs a redundant `Path::exists()` syscall before Shell/File open. `thumbnails.rs:108-115` allocates a 256 KiB heap buffer on every `.gif` thumbnail. `thumbnails.rs:415-427` reads `wBitCount` as `u8` (`hdr[off + 6]`) instead of `u16` and leaves a dead `bytes_in_res` variable with an empty `if` body. `source_has_transparency` (`:310`) is marked `pub(crate)` with zero external callers, and its pure header alpha checks (`:330-476`) live inside Win32-only `thumbnails.rs` with zero unit tests.
- **Agreed fix:**
  1. Extract `src-tauri/src/platform/gdi.rs` (`#[cfg(windows)] pub(crate) mod gdi;` in `platform/mod.rs` per R5) holding shared Win32 GDI RAII guards, DIB readout with fused BGRA-to-RGBA copy, fast PNG encoding (`CompressionType::Fast` + `FilterType::NoFilter`), and a `RPC_E_CHANGED_MODE`-safe COM guard.
  2. In `icons.rs`, cap `NATIVE_ICON_CACHE` with a named `MAX_NATIVE_ICON_CACHE_ENTRIES` constant (for example `512`), store `Arc<[u8]>`, ASCII-lowercase cache keys, remove unused `get_cached_native_icon_png`, initialize COM for real-path `SHGetFileInfoW` lookups, and switch `:153` to `crate::utils::base64_encode`.
  3. In `thumbnails.rs`, check in-memory `!has_alpha && has_black_matte_border(&pixels, width, height)` *before* calling `source_has_transparency`, cap the GIF header read by file size (probing a small stack buffer first), remove redundant `Path::exists()`, bound or reuse STA worker threads for Shell thumbnail calls, fix `ico_has_alpha` (`u16` `wBitCount` + remove dead `if` block), drop `pub(crate)` on `source_has_transparency`, and relocate the pure header alpha checks (`png_has_alpha`, `gif_has_transparency`, `ico_has_alpha`, `tiff_has_alpha`) into `formats/` so they are cross-platform unit-testable.
- **Telemetry A/B:** New `src-tauri/src/tests/icons_tests.rs` (`NATIVE_ICON_CACHE` cap, case-insensitive key folding, `clear_cached_native_icons`) and `src-tauri/src/tests/thumbnails_tests.rs` (`has_black_matte_border`, `png/gif/ico/tiff_has_alpha`, fast-PNG roundtrip timing, verifying `source_has_transparency` is skipped on non-matte images); `npm run e2e -- --spec e2e/specs/07-os-integration.e2e.js`.

## Cross-split seams and locked contracts

All cross-split contracts align with `cross-split-seams.md` (`R5`, `R6`, `R7`, Sync E, and Sync F):

- **Sync E (`lib.rs`, `models.rs`, `commands/` <-> S08, S10, S11):**
  - Remove dead IPC `drop_all_archives_cache` (`commands/archives.rs:35`, `lib.rs:109`, R6); keep internal `ArchiveCache::drop_all_archives()` (`lib.rs:200`).
  - Move `DimensionEntry` (`commands/animation.rs:326`) into `src-tauri/src/models.rs`.
  - Move `tests/archive_tests.rs` into `archives/mod.rs` and `tests/format_tests.rs` into `formats/mod.rs`, and re-export `archives::{acquire_temp_lock, cleanup_orphaned_temp_dirs, cleanup_current_temp_dir}` (making `mod cache;` private) so S08 removes `use archives::*;` at `lib.rs:17` (R7).
  - Keep all 13 active S09 IPC commands locked with exact names and JSON shapes: `list_archive`, `drop_archive_cache`, `prefetch_archive_entries`, `get_ico_frames`, `get_archive_ico_frames`, `resolve_archive_temp_origin`, `check_is_animated`, `check_media_audio`, `scan_container_max_width`, `cancel_width_scan`, `scan_container_dimensions`, `cancel_dims_scan`, `probe_media_dimensions`.
- **Sync F (`formats/`, `ico`, `archives/`, `platform/`, `protocol.rs` <-> S01, S03, S04, S06, S07, S08, S10, S11):**
  - `resolve_archive_temp_origin` (`commands/archives.rs:82` <-> S10 `platform/temp_archive.rs:1268-1291`): pass `&*state` (`&RwLock<ArchiveCache>`) to `temp_archive::resolve_temp_origin(path: &str, cache: &RwLock<ArchiveCache>)` so `tauri::State` leaves `platform/` while Win32 UIA/registry lookup (`resolve_temp_request`) stays outside the `ArchiveCache` write lock.
  - `formats/` facade (`formats/{mod,registry,tiff,animation,isobmff,dimensions}.rs`) re-exports 100% of existing `crate::formats::*` symbols for S10 (`is_archive_ext`, `read_mp4_dimensions`) and S11 (`SUPPORTED_FORMATS`, `FORMAT_ICONS`, `isobmff_box`, `check_animation_status`, `is_archive_ext`).
  - Preserve `archives::list_archive_names` (`com_server.rs:1735` -> S11 `archive_pane.rs`), `ico::ico_spritesheet_from_bytes` (`image_pane.rs:336` -> S11 `media_loader.rs`), and `platform::icons::{warmup, get_cached_native_icon, clear_cached_native_icons, get_cached_native_icon_png_with_size, IconSize}` (S11 `commands/icons.rs`, `protocol.rs`, `lib.rs:94`). Export `#[cfg(windows)] pub(crate) mod gdi;` in `platform/mod.rs` (R5).
  - Preserve all four `quivit://` routes (`/archive/<b64>/<entry>`, `/thumb/<b64>`, `/icon/<b64>/<ext_b64>[?size=large|32]`, `/tiff/<b64>`), Range `206` plus invalid-range `200` fallback (`protocol_tests.rs:132-140`), `Cache-Control: no-store` on `/archive/` and `/tiff/`, `Access-Control-Allow-Origin: *` (S07), `ipcProtocolProbe.js` routing, and exact `manhwa-max-width` and `container-dimensions` event payloads (S04, S06).

## Telemetry A/B plan

1. **Rust backend unit tests (`cargo test --manifest-path src-tauri/Cargo.toml`):**
   - *Baseline:* 111 passing across crate (`archive_tests` 10, `format_tests` 15, `ico_tests` 3, `protocol_tests` 11).
   - *Telemetry A (pre-refactor additions):*
     - Clean up `format_tests.rs:261,266` hardcoded `C:\Users\x4163\...` paths, `archive_tests.rs:192` silent early return, and `archive_tests.rs:221-319` fixed temp dir names. Update synthetic APNG bytes in `format_tests.rs:126-147` to valid PNG chunk framing alongside real `test-files/animated/*.apng` fixtures.
     - Expand `format_tests.rs`: `read_mp4_dimensions`, `read_mp4_dimensions_stream` (chunked `Read`, `size32 == 0`, `tkhd` v0/v1), `read_jpeg_dimensions_from_reader` (>64 KiB EXIF), `read_avif_dimensions` (`ispe` + `irot`), `read_ico_dimensions`, `read_svg_dimensions`, `read_media_dimensions_from_{path,stream}`, SVG animation, TIFF orientation swap and decode limits.
     - Expand `ico_tests.rs`: `ico_spritesheet_from_bytes`, BMP-masked ICO frames, `ico_frames_from_path` size-limit check, overlapping-offset DoS cap.
     - Expand `protocol_tests.rs`: route-collision URLs (`/archive/<b64>/icon/1.png`, `/thumb/`, `/tiff/`), `?size=32`, invalid TIFF 422 response.
     - Expand `archive_tests.rs`: `read_plain_zip_entry_shared` (hit/miss, concurrent fetches, CJK names, unlocked password forwarding), `read_entry_header` (ZIP and non-blocking temp wait), `list_archive_names`, TAR `entries_with_seek` parity on `test-files/_archives/tar.tar`, `drop_archive` temp cleanup, `max_open_archives == 0` guard.
     - Add three missing test suites via `#[path]`: `src-tauri/src/tests/animation_tests.rs` (directory/ZIP/temp width and dimension scans, generation cancel, non-blocking `check_is_animated`/`check_media_audio`), `src-tauri/src/tests/icons_tests.rs` (`NATIVE_ICON_CACHE` cap, case-insensitive keys, `clear_cached_native_icons`), and `src-tauri/src/tests/thumbnails_tests.rs` (`has_black_matte_border`, `png_has_alpha`, `gif_has_transparency`, `ico_has_alpha`, `tiff_has_alpha`).
   - *Telemetry B (post-refactor parity and gains):* All relocated and expanded tests pass with zero regressions, proving zero `ArchiveCache` write-lock blocking during RAR/7z `check_is_animated` or ZIP `prefetch_archive_entries`, O(1) CJK ZIP lookups without `chardetng` rescans, seek-based TAR listing speedup on `tar.tar`, zero 10 MiB upfront allocations on `size32 == 0` MP4 streams, skipped `source_has_transparency` file opens on non-matte thumbnails, and faster PNG roundtrips in `icons`/`thumbnails`/`ico`.
2. **WebdriverIO desktop E2E (`npm run e2e -- --spec e2e/specs/{03-viewer,04-archives,07-os-integration}.e2e.js`):**
   - *Telemetry A/B:* Preserve CBZ/CBR/CB7/TAR loading, Shift-JIS/GBK/EUC-KR ZIP decoding, encrypted ZIP unlock, ICO legacy and manhwa rendering, and `resolve_archive_temp_origin`. Add TIFF viewing (`test-files/50-51.tif`), animated APNG/AVIF/WebP/GIF detection (`test-files/animated/*`), manhwa width and dimension scan completion, and confirm `drop_all_archives_cache` removal breaks zero flows.
3. **Replay diagnostics (`npm run diagnose -- manhwa-width-span`, `manhwa-buffer`, `manhwa-directory-entry-fits`, `manhwa-gif-bridge`, `manhwa-video-bridge`):**
   - *Telemetry A/B:* `ipcProtocolProbe.js` verifies zero protocol or IPC status errors across `/archive/`, `/thumb/`, `/icon/`, `list_archive`, `scan_container_*`, `check_is_animated`, and `prefetch_archive_entries`, and Telemetry B measures lower p95 `/archive/` and `check_is_animated` latency under concurrent prefetch.
4. **Mocha frontend unit tests (`npm run mocha`):**
   - *Telemetry A/B:* Read-only verification of `mocha/diagnosticsContract.test.js` and `fsUtils` Sync F parity.
