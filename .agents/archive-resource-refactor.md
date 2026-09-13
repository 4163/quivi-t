# Archive Resource Refactor

Implementation tracker for archive lifecycle management, memory safety, and file panel thumbnail streaming.

---

## Status Matrix

| # | Item | Focus Area | Primary Files | Status |
| :--- | :--- | :--- | :--- | :--- |
| **1** | **Blob URL Revocation & Active Viewer Protection** | Object URL lifecycle, active blob retention | `cache.js`, `filePanel.js` | `[DONE]` (`f551d84`) |
| **2** | **Four-Node DOM Viewer Pool & Bridge Retention** | Double buffering, zero-flicker transitions | `viewerRender.js`, `main.css` | `[DONE]` (`c209bf7`) |
| **3** | **Texture Cache Bounding & Crop-First Lanczos** | Limit to 1 bitmap in VRAM, crop before resize | `blobImage.js`, `lanczos.js` | `[DONE]` (`f551d84`) |
| **4** | **Streaming Animation Header Sniffing** | Stream up to 256 KiB via `take()` | `archives/mod.rs`, `animation.rs` | `[DONE]` (`f1335c3`) |
| **5** | **Bounded Metadata Caches & Canvas Reset** | 512-entry bounds, `0×0` staging canvas | `cache.js`, `viewerPipelines.js` | `[DONE]` (`f1335c3`) |
| **6** | **Favorites Thumbnail Cache Policy** | Remove off-DOM `Image` retainers | `filePanel.js` | `[DONE]` (`f551d84`) |
| **7** | **Protocol `Cache-Control: no-store`** | Prevent full archive pages caching in WebView | `protocol.rs` | `[DONE]` (`9a779ca`) |
| **8** | **Hover Previews Removal** | Eliminate speculative background decodes | `filePanel.js` | `[DONE]` (`8e0ea5a`) |
| **9** | **Backend 2-Archive Sliding Buffer & Temp Cleanup** | `max_open_archives = 2`, exit & startup cleanup | `cache.rs`, `lib.rs`, `archives.rs` | `[DONE]` |
| **10** | **Frontend Viewport Archive Thumbnail Queue** | Directional `+1`/`-1` queue, off-viewport clear | `filePanel.js`, `fsUtils.js` | `[PENDING]` |
| **11** | **Temp-Origin Resolver Probing** | Slice 5 `d131378` candidate ranking preserved | `temp_archive.rs` | `[OUT OF SCOPE]` |
| **12** | **Protocol Zero-Copy Streaming** | Negligible gain (<1ms copy vs 50ms decode; IPC copies anyway) | `protocol.rs` | `[CLOSED / NOT NEEDED]` |

---

## 1. Already Implemented

These changes are landed in commits `f551d84` through `f1335c3`, plus viewer stabilization in `c209bf7`:

### [x] Blob URL Revocation & Active Viewer Protection (Commit `f551d84`, Suspect 1)
- **Files:** `src/js/services/cache.js`, `src/js/filepanel/filePanel.js`
- `BoundedMap` triggers `onEvict(key, value)` callback on eviction, key replacement, `delete()`, and `clear()`, revoking object URLs via `URL.revokeObjectURL()`.
- Active viewer blob is protected across rerenders until `state.src` changes.
- `AbortController` and generation counters cancel in-flight fetches on refresh and rapid navigation.
- Verified: `Default\blob_storage` verified at 0 MB on launch and stable after refresh.

### [x] Four-Node DOM Viewer Pool & Bridge Retention (Commits `f551d84`, `c209bf7`, Suspect 3)
- **Files:** `src/js/viewer/viewerRender.js`, `src/css/main.css`, `src/js/fsUtils.js`
- DOM image pool capped at 4 pre-allocated, recycled nodes (`VIEWER_IMAGE_POOL_CAPACITY = 4`).
- Retains immediate neighbors and outgoing bridge node in `desiredSrcs` during transitions, eliminating WebGL/Anime4K filter canvas flickering.
- Separated animation detection from active image changes, preventing frame-zero reload jitter.
- Initial archive animation status check (`check_is_animated`) runs asynchronously without delaying first image display.

### [x] Texture Cache Bounding & Crop-First Lanczos (Commit `f551d84`, Suspect 4)
- **Files:** `src/js/shared/blobImage.js`, `src/js/services/scaling/lanczos.js`
- `TEXTURE_CACHE_CAPACITY = 1`: caches only the active image's `ImageBitmap` in VRAM (zero visual difference, drops 5 idle past bitmaps from memory).
- `getCleanImageCrop(src, sx, sy, sw, sh)` creates caller-owned cropped bitmaps directly; Lanczos resizes from the visible crop and closes the bitmap immediately.
- Generation guards prevent stale async renders from winning after rapid navigation.

### [x] Streaming Animation Header Sniffing (Commit `f1335c3`, Suspect 8)
- **Files:** `src-tauri/src/archives/mod.rs`, `src-tauri/src/commands/animation.rs`
- `read_temp_entry_header()` reads bounded slices (up to 256 KiB) via `reader.take(max_len as u64).read_to_end(&mut buf)`.
- Eliminates whole-file allocations for non-ZIP animation inspection.

### [x] Bounded Metadata Caches & Canvas Surface Teardown (Commit `f1335c3`, Suspect 10)
- **Files:** `src/js/services/cache.js`, `src/js/core.js`, `src/js/filepanel/filePanel.js`, `src/js/viewer/viewerPipelines.js`
- `BoundedSet` and `BoundedMap` cap `_animMemo` and `animatedSvgSrcs` at 512 entries with FIFO eviction.
- `_stopLivePump()` resets `_liveStagingCanvas` dimensions to `0×0` on animation exit to release backing GPU memory.

### [x] Favorites Thumbnail Cache Policy (Commit `f551d84`, Suspect 9)
- **File:** `src/js/filepanel/filePanel.js`
- Stops storing off-DOM `new Image()` instances in `favoritesThumbnailCache`.

### [x] Protocol Cache-Control: no-store on Full Pages (Commit `9a779ca`)
- **File:** `src-tauri/src/protocol.rs`
- Full `/archive/` protocol responses use `Cache-Control: no-store` so WebView2 does not cache decompressed full pages on disk.

### [x] Removed Hover Previews in File Panel (Commit `8e0ea5a`)
- **File:** `src/js/filepanel/filePanel.js`
- Removed hover preview triggers to stop speculative decode and fetch overhead.

### [x] Backend Two-Archive Sliding Buffer & Temp Cleanup (Task 1, Suspect 6)
- **Files:** `src-tauri/src/archives/cache.rs`, `src-tauri/src/commands/archives.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/tests/archive_tests.rs`
- Capped `max_open_archives` at 2 (`MAX_OPEN_ARCHIVES = 2`) for active archive + immediately preceding archive sliding buffer.
- Scoped extraction directories to process ID: `%TEMP%\QuiviT\pid-<PID>\<archive-hash>\...`.
- Implemented process file lock (`%TEMP%\QuiviT\pid-<PID>.lock`) held with `FILE_SHARE_READ` (`share_mode(1)`), preventing multi-instance collisions.
- In `RunEvent::Exit`, drops cache via `drop_all_archives()`, drops the lock file handle, and deletes both `pid-<PID>` directory and `pid-<PID>.lock`.
- Added `cleanup_orphaned_temp_dirs()` to startup in `lib.rs` to detect and sweep dead PID directories and lock files left behind by crashes.
- Added `drop_all_archives_cache` IPC command in `commands/archives.rs`.
- Added test `temp_lock_lifecycle_cleans_on_exit` in `archive_tests.rs` verifying lock exclusivity and exit deletion.

---

## 2. Pending Implementation

### [ ] Task 2: Frontend Viewport-Bound Archive Thumbnail Queue (Suspect 2)
- **Target files:**
  - `src/js/filepanel/filePanel.js`
  - `src/js/fsUtils.js`
- **Work items:**
  - [ ] **Replace Static 3-Item Window:** Replace the temporary `ARCHIVE_THUMBNAIL_WINDOW_HALF = 1` limitation that turned distant rows into generic file icons.
  - [ ] **Viewport-Bound Queue:** Confine archive thumbnail loading strictly to rows currently inside the visible file panel viewport, plus a **1-item safety margin** above and below the viewport edge for smooth scrolling.
  - [ ] **Directional One-by-One Loading (`+1` / `-1`):** Load visible rows sequentially one-by-one in the active scroll direction, prioritizing the currently selected row first.
  - [ ] **Off-Viewport Immediate Cleanup:** Clear and release thumbnail images as rows scroll out of the viewport (beyond the 1-item safety buffer), keeping decoded image memory strictly capped to the viewport display.
  - [ ] **Fast-Scroll Cancellation:** Cancel queued or in-flight decodes for rows that leave the viewport before loading completes.

---

## 3. Marked Out of Scope / Closed

### [OUT OF SCOPE] Temp-Origin Resolver Probing (Suspect 7)
- **File:** `src-tauri/src/platform/temp_archive.rs`
- **Rationale:** Slice 5 (`d131378`) established strict candidate ranking where candidates with live archiver window context (known subfolder or explicit root) are sorted to index 0 (`deduped.sort_by_key(...)`). Modifying probe ordering or logic risks breaking external archiver window detection across the 7 supported archivers (Explorer, 7-Zip, NanaZip, WinRAR, Bandizip, WinZip, PeaZip). The 2-archive buffer policy naturally evicts and cleans any unexpected candidate state.

### [CLOSED] Protocol Response Zero-Copy Streaming (Suspect 5)
- **File:** `src-tauri/src/protocol.rs`
- **Resolution:** Closed as unnecessary (negligible gain, zero sustained leak).
- **Rationale:**
  - **Negligible latency impact:** Duplicating a 2 to 5 MB image buffer in CPU memory (`memcpy`) takes under 1 millisecond. By comparison, archive decompression takes 10 to 50 milliseconds and browser image decoding takes 15 to 30 milliseconds.
  - **IPC process boundary:** Because WebView2 runs in a separate process from Rust, Windows copies the payload across the process boundary regardless of whether Rust duplicates the buffer beforehand.
  - **Zero sustained leak:** Live memory probing showed Rust RSS remained steady around ~135 MB throughout browsing. The temporary buffer is freed as soon as the response is dispatched.

---

## 4. Verification & Battle-Test Checklist

Once Task 1 and Task 2 land, run the full verification plan:

### Automated Tests
- [x] `npm test`: Verify all JS unit tests pass (79/79 passed).
- [x] `cargo check --tests`: Clean build with zero warnings or errors.
- [x] `cargo test archive_tests`: All archive cache, streaming header, and extraction tests pass.

### Manual & Runtime Verification
- [x] **Two-Archive Sliding Buffer:** Browse across 3+ RAR/7Z/TAR archives in `%TEMP%\QuiviT`; verify that at most 2 extraction folders exist simultaneously and the oldest is deleted on opening the 3rd.
- [x] **ZIP/CBZ Memory:** Browse through 3+ ZIP/CBZ archives; verify memory stays lean (~20–30 MB) and oldest ZIP entries are dropped on the 3rd archive without creating temp files on disk.
- [x] **Folder Exit Cleanup:** Navigate out of an archive to a normal disk folder; verify all `%TEMP%\QuiviT` directories are deleted and ZIP memory drops to 0 MB.
- [x] **Startup Sweep:** Verify that launching the app automatically purges any orphaned `%TEMP%\QuiviT` directories left behind from a previous run.
- [ ] **Archive Thumbnail Viewport Streaming:** In thumbnail view, scroll through an archive file list; verify visible rows load sequentially (`+1` / `-1`), off-screen thumbnails are cleared (with 1-item safety buffer), and memory remains strictly capped.
- [ ] **Viewer Stability:** Rapidly flip through images with arrow keys and WebGL filters (Anime4K/Lanczos) enabled; verify zero canvas flicker, no black/white flashes, and smooth bridge transitions.
- [ ] **Idle Memory Settling:** Leave the app idle for 10–15 minutes after heavy browsing; verify WebView2 renderer/GPU memory settles stably rather than climbing.

