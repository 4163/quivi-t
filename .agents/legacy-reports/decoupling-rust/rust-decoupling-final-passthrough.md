# QuiviT Rust Backend Decoupling: Final Passthrough & Architecture Audit

> **Date:** August 20, 2026  
> **Status:** Final Architectural Review & Decoupling Passthrough  
> **Scope:** Full-codebase audit across all 18 Rust backend files in `src-tauri/src/`, Tauri IPC command handlers, custom URI protocols, platform bindings, memory/cache semantics, and performance paths.  
> **References:** [`.agents/AGENTS.md`](file:///E:/Projects/QuiviT/.agents/AGENTS.md), [`.agents/rust-decoupling-plan.md`](file:///E:/Projects/QuiviT/.agents/rust-decoupling-plan.md), [`.agents/rust-decoupling-analysis/*`](file:///E:/Projects/QuiviT/.agents/rust-decoupling-analysis/).

---

## Executive summary

Following the 8-slice Rust Backend Decoupling initiative outlined in [`.agents/rust-decoupling-plan.md`](file:///E:/Projects/QuiviT/.agents/rust-decoupling-plan.md), a comprehensive architectural audit was conducted across the entire Rust backend.

The refactoring successfully transitioned the codebase from flat, intertwined monoliths (`lib.rs` at 970 lines, `commands.rs` at 858 lines, `archives.rs` at 593 lines) into an encapsulated domain architecture:
- **`lib.rs` and `main.rs`** serve as a pure bootstrap entry point (~145 lines) with zero domain logic or stranded test suites.
- **`archives/`** encapsulates all archive format decoders (ZIP, RAR, 7Z, TAR), character encoding detection (Shift-JIS, GBK, EUC-KR), LRU cache accounting, and synchronization behind clean `ArchiveCache` facade methods (`prepare_archive`, `read_entry_bytes`).
- **`commands/`** partitions IPC command handlers by single domain ownership (directory browsing, archive adapters, Windows registry associations, notify watchers, and OS shell helpers).
- **`platform/`** isolates native Windows OS interactions (RAII-wrapped Win32 GDI shell icon extraction, file attributes, COM folder picker with Windows Library virtual folder resolution).
- **`windows.rs`** owns window construction, sizing constants, shell background synchronization, and monitor centering math.
- **`config.rs`** strictly manages configuration schemas, 5-file split roaming persistence, portable mode detection, and early pending setting promotions.
- **`protocol.rs`** provides asynchronous custom URI scheme decoding (`quivit://`) decoupled from application bootstrap.

This final passthrough report documents all verified decoupling milestones, identifies dead code and stale IPC commands, catalogs remaining architectural smells, and outlines high-impact performance opportunities (including wire-breaking optimizations).

---

## 1. Decoupling verification & module cohesion audit

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                MODULE SIZING & COHESION MAP                            │
├──────────────────────────┬────────────┬──────────┬─────────────────────────────────────┤
│ Module                   │ Size / LOC │ Status   │ Architectural Verdict               │
├──────────────────────────┼────────────┼──────────┼─────────────────────────────────────┤
│ `lib.rs`                 │ 4.7KB/145  │ Cohesive │ Pure application bootstrap          │
│ `main.rs`                │ 0.2KB/7    │ Cohesive │ Zero-logic OS entry trampoline      │
│ `models.rs`              │ 1.5KB/53   │ Cohesive │ Pure shared DTOs & IPC models       │
│ `formats.rs`             │ 3.5KB/69   │ Cohesive │ Zero-allocation format registry     │
│ `config.rs`              │ 9.8KB/278  │ Cohesive │ Configuration & split persistence   │
│ `windows.rs`             │ 6.1KB/180  │ Cohesive │ Window geometry & lifecycle owner   │
│ `protocol.rs`            │ 3.4KB/104  │ Cohesive │ Async `quivit://` scheme handler    │
│ `ico.rs`                 │ 4.2KB/108  │ Cohesive │ Byte-level ICO parsing & sprite     │
│ `utils.rs`               │ 1.1KB/36   │ Cohesive │ Base64, URL & string decoding       │
│ `archives/mod.rs`        │ 5.8KB/178  │ Cohesive │ `ArchiveCache` domain facade        │
│ `archives/cache.rs`      │ 8.5KB/265  │ Cohesive │ LRU byte budget & temp cleanup      │
│ `archives/zip.rs`        │ 3.8KB/117  │ Cohesive │ ZIP/CBZ reader & CJK fallback       │
│ `archives/rar.rs`        │ 3.0KB/108  │ Cohesive │ RAR/CBR unrar pipeline              │
│ `archives/sevenz.rs`     │ 2.0KB/69   │ Cohesive │ 7Z/CB7 atomic decompression         │
│ `archives/tar.rs`        │ 3.2KB/120  │ Cohesive │ TAR/CBT sequential stream reader    │
│ `archives/encoding.rs`   │ 0.8KB/26   │ Cohesive │ CJK charset auto-detection          │
│ `commands/mod.rs`        │ 0.2KB/12   │ Cohesive │ IPC command aggregation             │
│ `commands/directory.rs`  │ 10.2KB/330 │ Mixed    │ Needs pruning of stale commands     │
│ `commands/archives.rs`   │ 1.5KB/54   │ Cohesive │ IPC adapters for `ArchiveCache`     │
│ `commands/registry.rs`   │ 12.8KB/290 │ Cohesive │ Windows ProgID & icon dumping       │
│ `commands/watchers.rs`   │ 3.7KB/107  │ Cohesive │ Centralized notify watcher state    │
│ `commands/shell.rs`      │ 1.7KB/68   │ Cohesive │ Shell activation & system dialogs   │
│ `platform/icons.rs`      │ 10.3KB/316 │ Cohesive │ RAII Win32 GDI shell icon extractor │
│ `platform/attributes.rs` │ 2.1KB/72   │ Cohesive │ Win32 file attribute inspection     │
│ `platform/dialog.rs`     │ 3.4KB/79   │ Cohesive │ COM IFileOpenDialog & Libraries     │
└──────────────────────────┴────────────┴──────────┴─────────────────────────────────────┘
```

### Decoupling slice validation summary

1. **Slice 1 (Tests & Models):** Unit test suites relocated to [`src-tauri/src/tests/`](file:///E:/Projects/QuiviT/src-tauri/src/tests/) via `#[path]`. `models.rs` standard derives (`Debug`, `PartialEq`, `Serialize`, `Deserialize`) are present.
2. **Slice 2 (Zero-Allocation Formats):** `formats.rs` extension predicates use ASCII case-insensitive byte comparisons without string heap allocation.
3. **Slice 3 (Windows Subsystem):** Window sizing constants, builders, auto-fit algorithms, and shell background synchronization isolated in `windows.rs`. `config.rs` has no window or webview imports.
4. **Slice 4 (Archive Encapsulation):** All internal fields of `ArchiveCache` and `SingleArchiveCache` are private to the `archives/` module. Callers invoke `prepare_archive` and `read_entry_bytes`.
5. **Slice 5 (Custom Protocol):** `quivit://` scheme handling extracted to `protocol.rs`. Reduced `lib.rs` footprint.
6. **Slice 6 (Commands Dissolution):** `commands.rs` monolith dissolved into 5 domain modules under `commands/`.
7. **Slice 7 (Native Shell Icons):** Windows GDI handle allocation wrapped in RAII guards (`ScopedHicon`, `ScopedHgdiobj`, `ScopedMemDc`, `ScopedScreenDc`).
8. **Slice 8 (Watchers & Bootstrap):** `spawn_config_file_watcher` unified in `commands/watchers.rs`. `lib.rs` functions purely as application bootstrap.

---

## 2. Stale functions, dead code & inactive references

The audit revealed several dead functions, obsolete IPC commands, and redundant string operations across the codebase:

### 2.1 Obsolete IPC commands in `commands/directory.rs`

- **Dead Command: `open_sibling` ([`commands/directory.rs:L168-214`](file:///E:/Projects/QuiviT/src-tauri/src/commands/directory.rs#L168-L214))**  
  *Analysis:* The frontend implements sibling folder navigation completely in JavaScript ([`src/js/fsUtils.js:L523-575`](file:///E:/Projects/QuiviT/src/js/fsUtils.js#L523-L575)) via `read_directory` and `DirectoryPrefs.getSortPrefs()`. The Rust `open_sibling` command is never called by any frontend script. Furthermore, the Rust implementation used a hardcoded natural sort, ignoring per-directory sort preferences configured by the user.  
  *Action:* Remove `open_sibling` from `commands/directory.rs`, `commands/mod.rs`, and `lib.rs`.

- **Dead Command: `open_sibling_container` ([`commands/directory.rs:L217-295`](file:///E:/Projects/QuiviT/src-tauri/src/commands/directory.rs#L217-L295))**  
  *Analysis:* Like `open_sibling`, container-level sibling navigation (jumping between adjacent folders or archive files) is handled entirely in frontend domain logic in `fsUtils.js`. This 78-line command is completely uncalled.  
  *Action:* Remove `open_sibling_container` from `commands/directory.rs`, `commands/mod.rs`, and `lib.rs`.

- **Redundant Command: `open_parent` ([`commands/directory.rs:L149-166`](file:///E:/Projects/QuiviT/src-tauri/src/commands/directory.rs#L149-L166))**  
  *Analysis:* `open_parent` is merely a 17-line wrapper that extracts `path.parent()` and invokes `read_directory_impl`. In `fsUtils.js`, parent navigation for archives already calls `read_directory` directly. Folder parent navigation can call `read_directory` directly with `parentOf(directory)` and `target_name`, eliminating this redundant IPC command.  
  *Action:* Rehook the single frontend call site in `fsUtils.js:L508` to call `read_directory` and remove `open_parent` from Rust.

### ~~2.2 Dead helper functions in `archives/cache.rs`~~ (Correction)

> **Not dead code.** Both `write_temp_entry` and `notify_extracted` are actively called by all three disk-based extractors (`rar.rs`, `sevenz.rs`, `tar.rs`). The original audit searched only within the `cache.rs` file and missed the cross-file callers. Caller-site comments have been added to prevent this from recurring.


### 2.3 Redundant string allocations in hot paths

- **Unnecessary Allocation in `commands/archives.rs:L29`:**  
  `let ext = archive_path.rsplit('.').next().unwrap_or("").to_lowercase();`  
  *Analysis:* Allocates a new heap string on every prefetch request. `formats::is_archive_ext` or `eq_ignore_ascii_case` should be used instead.
- **Redundant `.to_lowercase()` in `commands/registry.rs:L21, L36, L49`:**  
  `fmt.ext.to_lowercase()` is called repeatedly in a loop over `SUPPORTED_FORMATS`. All extensions in `SUPPORTED_FORMATS` are already lowercased static string literals (`"jpg"`, `"zip"`, etc.).
- **Redundant `.to_lowercase()` in `platform/icons.rs:L120`:**  
  `let lower_ext = ext_key.to_lowercase();` is called on every native icon query, even though the frontend already passes normalized, lowercased extension keys.

---

## 3. Remaining architectural & safety smells

### 3.1 Unbounded OS thread spawning in `protocol.rs`

- **Current Implementation ([`protocol.rs:L56-80`](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs#L56-L80)):**  
  Every HTTP request received by `quivit://` spawns a new raw OS thread via `std::thread::spawn(move || { ... })`.
- **Problem:** When an archive with 100+ images is loaded and the frontend initiates thumbnail prefetching, dozens of OS threads are created and destroyed in rapid succession. This incurs OS thread creation overhead, memory churn, and heavy lock contention against the single `Mutex<ArchiveCache>`.
- **Recommendation:** Use a dedicated worker pool (e.g. `rayon`, `tokio::task::spawn_blocking`, or a bounded thread pool) or handle memory-cached entries synchronously on the request thread.

### 3.2 Granularity of `Mutex<ArchiveCache>` and Condvar lock starvation

- **Current Implementation ([`archives/mod.rs:L150-156`](file:///E:/Projects/QuiviT/src-tauri/src/archives/mod.rs#L150-L156), [`protocol.rs:L58-61`](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs#L58-L61), [`commands/archives.rs:L48-51`](file:///E:/Projects/QuiviT/src-tauri/src/commands/archives.rs#L48-L51)):**  
  A single global `std::sync::Mutex<ArchiveCache>` guards the entire archive subsystem. When `protocol.rs` or `commands/archives.rs` reads a disk-extracted entry, it locks `Mutex<ArchiveCache>` and calls `read_entry_bytes`. Inside `read_temp_entry_bytes`, if the file is still extracting, it calls `cvar.wait_timeout_while(set, Duration::from_secs(30), ...)`.
- **Problem:**
  1. **The global `Mutex<ArchiveCache>` is held during the entire 30-second Condvar wait.** Every other thread or IPC command attempting to use `ArchiveCache` (even for in-memory ZIPs or different archives) is completely serialized and blocked behind the waiting thread.
  2. `prefetch_archive_entries` ([`commands/archives.rs:L34-38`](file:///E:/Projects/QuiviT/src-tauri/src/commands/archives.rs#L34-L38)) acquires and releases the mutex inside a tight `for entry_name in entries` loop.
- **Recommendation:**
  1. Separate state lookup from extraction waiting. Retrieve `(temp_dir, notify)` under a brief cache lock, release `Mutex<ArchiveCache>`, then perform the Condvar wait and `fs::read` without holding the global cache lock.
  2. Batch lock acquisition in `prefetch_archive_entries` (acquire lock once outside the loop).
  3. Upgrade `ArchiveCache` to use `std::sync::RwLock` for concurrent cache reads, or assign per-archive mutexes within `SingleArchiveCache`.

### 3.3 Missing cancellation signal for background archive extractors

- **Current Implementation ([`archives/mod.rs:L163-175`](file:///E:/Projects/QuiviT/src-tauri/src/archives/mod.rs#L163-L175)):**  
  When an archive is prepared, a detached background thread is spawned to decompress files to temporary storage.
- **Problem:** If the user quickly navigates past several large archives, the old archives are evicted from `ArchiveCache` and their temporary directories may be queued for deletion (`SingleArchiveCache::drop`), while background extractor threads continue decompressing files into that directory. On Windows, writing to a directory being deleted causes file lock errors (`ERROR_SHARING_VIOLATION` / `ERROR_ACCESS_DENIED`).
- **Recommendation:** Introduce an `Arc<AtomicBool>` cancellation token inside `SingleArchiveCache` and pass it to extractor loops (`rar.rs`, `sevenz.rs`, `tar.rs`). When `SingleArchiveCache` drops, set the token to `true` to immediately terminate the background extraction thread.

### 3.4 Missing RAII COM guard in `platform/dialog.rs`

- **Current Implementation ([`platform/dialog.rs:L20-72`](file:///E:/Projects/QuiviT/src-tauri/src/platform/dialog.rs#L20-L72)):**  
  Calls `CoInitializeEx` and manually calls `CoUninitialize()` on success exit points. If `CoCreateInstance` or `SetOptions` returns early with an `Err`, `CoUninitialize()` is skipped.
- **Recommendation:** Wrap COM initialization in an RAII struct (`struct ScopedCoInit`) whose `Drop` implementation calls `CoUninitialize()`.

### 3.5 Missing metadata filter in 7z listing bug

- **Current Implementation ([`archives/sevenz.rs:L21`](file:///E:/Projects/QuiviT/src-tauri/src/archives/sevenz.rs#L21)):**  
  `list_7z_entries` checks `if !is_image_ext(ext) { continue; }`, omitting `!is_metadata_ext(ext)`.
- **Problem:** Unlike ZIP, RAR, and TAR listings, `ComicInfo.xml` or other metadata files inside `.7z` and `.cb7` archives are filtered out and cannot be displayed in the Metadata badge or metadata window.
- **Recommendation:** Add `&& !is_metadata_ext(ext)` to the filter.

### 3.6 Non-atomic configuration writes in `config.rs`

- **Current Implementation ([`config.rs:L221-271`](file:///E:/Projects/QuiviT/src-tauri/src/config.rs#L221-L271)):**  
  `save_config` executes direct `fs::write` calls. Truncating files in place risks 0-byte corrupted JSON if a crash or power cut occurs during the write.
- **Recommendation:** Write to temporary sibling files (`.tmp`) and perform atomic replacement (`fs::rename`).

---

## 4. Performance improvement opportunities (including wire-breaking changes)

The following optimizations provide significant throughput, LCP, and memory improvements:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              PERFORMANCE OPTIMIZATION MATRIX                           │
├────────────────────────────────┬──────────────┬─────────────┬──────────────────────────┤
│ Optimization                   │ Target Area  │ Wire Impact │ Estimated Benefit        │
├────────────────────────────────┼──────────────┼─────────────┼──────────────────────────┤
│ 1. Binary IPC / Custom URI     │ Icons & ICO  │ Breaking    │ -33% payload, 0 Base64   │
│ 2. Single-Pass ZIP Central Dir │ `zip.rs`     │ Compatible  │ -50% disk I/O on open    │
│ 3. Per-Archive RwLock Cache    │ `cache.rs`   │ Compatible  │ Lock-free parallel reads │
│ 4. Extractor Cancellation      │ `archives/`  │ Compatible  │ Eliminates zombie disk IO│
│ 5. Memory-Cache Sync Return    │ `protocol.rs`│ Compatible  │ 0ms thread hop for cache │
│ 6. Fast DIB Raw Buffer IPC     │ `icons.rs`   │ Breaking    │ Skips PNG compression    │
│ 7. Zero-Copy `bytes::Bytes`    │ `cache.rs`   │ Compatible  │ Eliminates 20MB+ clones  │
└────────────────────────────────┴──────────────┴─────────────┴──────────────────────────┘
```

### 4.1 Zero-allocation binary transfer for shell icons (wire-breaking opportunity)

- **Current State:**  
  [`platform/icons.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/icons.rs) rasterizes a Win32 shell icon into a 32-bit DIB section, converts BGRA to RGBA in a loop, compresses the pixel buffer into PNG format via `image::write_buffer_with_format`, encodes the PNG bytes into Base64 via `BASE64_STANDARD.encode`, and returns a `data:image/png;base64,...` string.
- **Overhead:**
  1. PNG compression of a 16x16 icon takes ~150-300 microseconds per icon.
  2. Base64 encoding inflates the payload by 33% and creates string allocations in both Rust and JavaScript V8 heap.
- **Optimization Strategy:**  
  Register a custom protocol endpoint `quivit-icon://<ext>` or return raw binary bytes via `tauri::ipc::Response`. In `protocol.rs` or an icon protocol handler, stream the cached PNG or raw BMP/DIB bytes directly. The frontend simply sets `<img src="quivit-icon://${ext}" />`, completely eliminating Base64 encoding, decoding, and JSON IPC serialization.

### 4.2 Single-pass central directory parsing in `zip.rs`

- **Current State:**  
  [`zip::list_zip_entries`](file:///E:/Projects/QuiviT/src-tauri/src/archives/zip.rs) opens the ZIP archive file, iterates through the central directory, and builds a `Vec<FileEntry>`. Immediately afterwards, [`prepare_archive_state`](file:///E:/Projects/QuiviT/src-tauri/src/archives/mod.rs#L97) calls `open_zip_archive`, opening the same physical file on disk a second time to initialize `SingleArchiveCache.zip_archive`.
- **Optimization:**  
  Pass the already opened `ZipArchive` instance from `list_zip_entries` directly into `SingleArchiveCache::with_zip_archive`, cutting disk open calls and central directory reads in half.

### 4.3 Fast synchronous return for memory-cached protocol requests

- **Current State:**  
  [`protocol.rs`](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs#L56) unconditionally spawns a background thread for every image request, even when the requested image is already decompressed in the `zip_entries` LRU memory cache.
- **Optimization:**  
  Attempt a quick, non-blocking lock on `ArchiveCache`. If the entry exists in memory, construct the HTTP 200 response and call `responder.respond()` immediately on the scheme callback thread. Only spawn a background thread when disk I/O or Condvar synchronization is required.

### 4.4 Zero-copy shared memory cache with `bytes::Bytes` or `Arc<[u8]>`

- **Current State:**  
  `get_zip_entry` clones the entire `Vec<u8>` on cache hit (`data.clone()`). For a 20MB high-resolution comic page, this copies 20MB in heap memory, followed by another copy into the response buffer.
- **Optimization:**  
  Store `bytes::Bytes` or `Arc<[u8]>` in `SingleArchiveCache.zip_entries`. Retrieving an image from cache becomes an atomic pointer increment (0-byte payload copy).

---

## 5. Prioritized action plan

### Phase 1: Dead code removal & hygiene (Immediate, low risk)

1. Delete `open_sibling` and `open_sibling_container` from [`src-tauri/src/commands/directory.rs`](file:///E:/Projects/QuiviT/src-tauri/src/commands/directory.rs), [`commands/mod.rs`](file:///E:/Projects/QuiviT/src-tauri/src/commands/mod.rs), and [`lib.rs`](file:///E:/Projects/QuiviT/src-tauri/src/lib.rs).
2. Rehook `openParent` in [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js) to call `read_directory` directly with the parent path and remove `open_parent` from Rust.
3. ~~Delete unused helpers `write_temp_entry` and `notify_extracted` from [`src-tauri/src/archives/cache.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs).~~ Not dead code; see corrected §2.2.
4. Remove redundant `.to_lowercase()` calls in `commands/archives.rs:L29`, `commands/registry.rs:L21, L36, L49`, and `platform/icons.rs:L120`.
5. Fix metadata inclusion in `src-tauri/src/archives/sevenz.rs:L21` (`|| is_metadata_ext(ext)`).

### Phase 2: Architectural & concurrency hardening (Medium risk)

1. Refactor `read_temp_entry_bytes` in `archives/mod.rs` to release `Mutex<ArchiveCache>` before waiting on the Condvar and reading the extracted file.
2. Add an `Arc<AtomicBool>` cancellation flag to `SingleArchiveCache` and background extraction workers (`rar.rs`, `sevenz.rs`, `tar.rs`) to prevent disk write collisions during rapid navigation.
3. Add an RAII `ScopedCoInit` guard in `platform/dialog.rs`.
4. Batch lock acquisition in `prefetch_archive_entries` outside the loop.
5. Pass the open `ZipArchive` handle from `list_zip_entries` to `SingleArchiveCache` to eliminate double file opens.
6. Adopt atomic file write and rename in `config.rs:save_config`.

### Phase 3: High-throughput performance upgrades (Optional / Wire-breaking)

1. Serve native shell icons via `quivit-icon://` custom protocol or binary IPC responses to bypass Base64 encoding and PNG re-compression.
2. Adopt `bytes::Bytes` or `Arc<[u8]>` in `SingleArchiveCache` for zero-copy memory cache hits.
3. Add synchronous fast-path response in `protocol.rs` for memory-cached ZIP entries.
4. Upgrade global `ArchiveCache` mutex to reader-writer lock or fine-grained per-archive locks.

---

## Conclusion

The Rust backend decoupling refactoring has achieved its primary goals: complete encapsulation of the archive cache, modularization of Tauri IPC commands, isolation of OS and GDI handles, purification of application bootstrap, and zero-allocation format detection. 

Addressing the dead code pruning in Phase 1 and the concurrency safeguards in Phase 2 will finalize the Rust backend into a production-hardened, performant foundation.
