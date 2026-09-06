# Slice 4.3.3: Dual-Tier Archive Thumbnail Downscaling Plan

## Goal

Implement high-performance, bounded on-demand archive thumbnail generation in the Rust backend, completely isolating thumbnail memory from the viewer's reading cache and eliminating full-resolution decompressed image floods across the IPC boundary.

Key capabilities in this slice:
1. **Dual-Tier Cache Isolation (`thumb_lru`)**:
   - Add a dedicated 200-entry in-memory `thumb_lru` in [`ArchiveCache`](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs).
   - At ~10 KB per 96×96 PNG thumbnail, 200 thumbnails consume **only ~2 MB of RAM total**.
   - Browsing an entire comic book's thumbnails never displaces or evicts the viewer's 20-entry high-resolution viewport cache (`zip_lru`).
2. **On-Demand Background Downscaling**:
   - In [`src-tauri/src/archives/mod.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/mod.rs), implement `read_entry_thumbnail_png`:
     - Calls existing unified `read_entry_bytes(archive_path, entry_name)` (handles ZIP, RAR, 7Z, and TAR identically).
     - For SVG: returns original vector bytes directly as `image/svg+xml`.
     - For raster formats: decodes via `image::load_from_memory`, downscales to 96×96 via `image::imageops::thumbnail(&img, 96, 96)`, and encodes to PNG.
     - Caches result in `thumb_lru`.
3. **Dedicated Protocol Route (`/archive-thumb/`)**:
   - Add `quivit://archive-thumb/<base64_archive_path>/<encoded_entry_name>` route in [`src-tauri/src/protocol.rs`](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs).
   - Serve 96×96 PNG buffers with `Cache-Control: public, max-age=86400`.
4. **Frontend Archive Routing**:
   - In [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js), route archive images to `buildArchiveThumbnailSrc(...)`.
   - On error: fall back to direct archive stream (`quivit://archive/...`), then to 32px shell icon.

> [!IMPORTANT]
> ## User Review Required
> - **Unified Archive Handling**: Works identically across ZIP, CBZ, RAR, CBR, 7Z, CB7, TAR, and CBT via `read_entry_bytes`.
> - **Zero Viewer Eviction**: The 20-image high-res viewer LRU and the 200-image thumbnail LRU are completely decoupled.

> [!CAUTION]
> ## Execution Rules
> **Do not mark pending items as completed after writing the code.** Items must remain marked as `[PENDING]` until the user has explicitly verified and approved that the implementation functions properly at runtime.

---

## Architectural Invariants & Validation Constraints

Every item in this plan follows [.agents/AGENTS.md](file:///E:/Projects/QuiviT/.agents/AGENTS.md) and [.agents/skills/validate-changes/SKILL.md](file:///E:/Projects/QuiviT/.agents/skills/validate-changes/SKILL.md):

1. **Rust Module Ownership & Facade Encapsulation:**
   - Archive thumbnail extraction and caching live inside `archives/` domain modules.
   - `protocol.rs` calls facade methods on `ArchiveCache` without reaching into archive internals.
2. **Performance First & Thread Concurrency:**
   - Heavy image downscaling runs strictly on background threads (`spawn_blocking`).
   - Browser HTTP caching (`Cache-Control: max-age=86400`) eliminates repeated IPC calls on scroll.

---

## Proposed Changes

### 1. Dedicated Thumbnail LRU Cache (Rust)

#### [MODIFY] [src-tauri/src/archives/cache.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs)
- [PENDING] Add bounded thumbnail cache to `ArchiveCache`:
  - `thumb_cache: Mutex<std::collections::VecDeque<(String, Arc<[u8]>)>>` or `HashMap` with 200-item bound.
  - Methods: `get_cached_thumb(&self, key: &str) -> Option<Arc<[u8]>>` and `insert_cached_thumb(&mut self, key: String, data: Arc<[u8]>)`.

---

### 2. Archive Thumbnail Generation (Rust)

#### [MODIFY] [src-tauri/src/archives/mod.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/mod.rs)
- [PENDING] Implement `pub fn read_entry_thumbnail_png(&mut self, archive_path: &str, entry_name: &str) -> Result<(Vec<u8>, &'static str), String>`:
  - Check `get_cached_thumb` first; return immediately if cached in `thumb_cache`.
  - For extraction: read raw entry bytes directly from open archive or temp file without calling `insert_zip_entry` (guaranteeing the viewer's `zip_lru` is never evicted by thumbnail requests).
  - Check extension: if `.svg`, return raw bytes with `image/svg+xml`.
  - Decode raster image via `image::load_from_memory`.
  - Downscale via `image::imageops::thumbnail(&img, 96, 96)`.
  - Encode to PNG buffer, store in `thumb_cache`, and return `(png_bytes, "image/png")`.

---

### 3. Protocol Routing & HTTP Caching

#### [MODIFY] [src-tauri/src/protocol.rs](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs)
- [PENDING] Add `/archive-thumb/` URL pattern to `register_quivit_protocol`:
  - Route format: `quivit://archive-thumb/<base64_archive_path>/<encoded_entry_name>`.
  - Dispatch before generic `/archive/` pattern to avoid URL matching collision.
  - Spawns blocking task calling `read_entry_thumbnail_png`.
  - Return HTTP 200 with appropriate mime and `Cache-Control: public, max-age=86400`.
  - If error: return HTTP 404.

---

### 4. Frontend Archive Thumbnail Routing

#### [MODIFY] [src/js/fsUtils.js](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
- [PENDING] Add `buildArchiveThumbnailSrc(archivePath, entryName)`:
  - Returns `http://quivit.localhost/archive-thumb/${_base64Encode(archivePath)}/${encodeURIComponent(entryName)}`.
- [PENDING] In `buildThumbnailSrc(item, state)`:
  - For image entries inside archives: return `buildArchiveThumbnailSrc(archivePath, entryName)`.

#### [MODIFY] [src/js/filepanel/filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- [PENDING] In `slots.thumbImg.onerror`:
  - If target was `quivit://archive-thumb/...`: fall back to `FsUtils.buildArchiveSrc(archivePath, entryName)`.
  - If direct preview fails: fall back to 32px native shell icon.

---

## Verification Plan

### Automated Tests
```pwsh
npm test
cargo check --tests --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```
- Unit test in `fsUtils.test.mjs` verifying archive thumbnail URL generation.
- Unit test in `src-tauri/src/archives/` verifying `read_entry_thumbnail_png` returns valid 96×96 PNGs and populates `thumb_lru`.

### Manual Verification
1. Open a 100+ page comic book (CBZ and CBR) in thumbnail view.
2. In DevTools Network tab, confirm `/archive-thumb/` requests return ~10 KB PNGs.
3. Verify reader viewport image at index 0 stays loaded and does not flicker or evict.
4. Scroll back and forth: confirm instant loads from WebView2 cache.

---

## Deviations, Violations & Runtime Fixes

- None recorded yet.
