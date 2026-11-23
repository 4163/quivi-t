# Slice 4.3.3: Dual-Tier Archive Thumbnail Downscaling Plan [SUPERSEDED / ABANDONED]

> [!WARNING]
> ## Status: Superseded / Abandoned Due to Performance Regression
> Runtime testing of the `/archive-thumb/` backend downscaling pipeline revealed a severe performance regression. On typical comic and manga archives containing 50 to 100+ images (2000×3000 to 3000×4000 resolution), thumbnail loading took up to **30 seconds**, worse than the pre-implementation state.
>
> ### Why Backend Downscaling Failed
> 1. **Gigapixel CPU Decoding**: Decoding 100 images through Rust's `image::load_from_memory` uncompressed 3.5 to 4.8 GB of raw pixel data on CPU threads.
> 2. **Software Resampling**: Software Lanczos/triangle resizing across millions of pixels consumed significant CPU time per page.
> 3. **PNG Deflate Re-Encoding**: Encoding 96×96 bitmaps into PNG via CPU deflate added heavy encoding overhead.
> 4. **Why Direct Streaming Is Faster**: The pre-4.3.3 architecture streamed raw compressed JPEG/PNG bytes via `quivit://archive/` directly to WebView2. Chromium decodes JPEGs with multi-threaded SIMD (libjpeg-turbo) and GPU acceleration, using DCT sub-sampling for small rendering sizes in milliseconds. Slice 4.3.1 DOM virtualization already keeps DOM node counts bounded to ~30 rows, preventing memory bloat.
>
> All code changes from this slice are reverted. Archive thumbnail and viewer caching optimizations continue under **Slice 4.4**.

## Original Goal (Historical Reference)

Implement high-performance, bounded on-demand archive thumbnail generation in the Rust backend, completely isolating thumbnail memory from the viewer's reading cache and eliminating full-resolution decompressed image floods across the IPC boundary.

Key capabilities in this slice:
1. **Dual-Tier Cache Isolation (`thumb_cache`)**:
   - Add a dedicated 200-entry in-memory LRU cache (`thumb_cache`) in [`ArchiveCache`](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs).
   - At ~10 KB per 96×96 PNG thumbnail, 200 thumbnails consume **only ~2 MB of RAM total**.
   - Browsing an entire comic book's thumbnails never displaces or evicts the viewer's 20-entry high-resolution viewport cache (`zip_entries` / `global_zip_lru`).
2. **On-Demand Background Downscaling**:
   - In [`src-tauri/src/archives/mod.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/mod.rs), implement `read_entry_thumbnail`:
     - Extracts raw entry bytes without calling `insert_zip_entry` (guaranteeing the viewer's reading cache is never evicted by thumbnail requests).
     - Handles ZIP, RAR, 7Z, and TAR uniformly.
     - For SVG: returns original vector bytes directly as `image/svg+xml`.
     - For raster formats: decodes via `image::load_from_memory`, downscales to 96×96 via `img.thumbnail(96, 96)`, and encodes to PNG via `write_to`.
     - Caches downscaled results in `thumb_cache`.
3. **Dedicated Protocol Route (`/archive-thumb/`)**:
   - Add `/archive-thumb/<base64_archive_path>/<encoded_entry_name>` route in [`src-tauri/src/protocol.rs`](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs).
   - Fast-path in-memory check: if the thumbnail is already cached, returns immediately under `try_read()` without spawning a blocking thread.
   - Cache-miss dispatch: runs extraction and downscaling inside `spawn_blocking`.
   - Dispatches before generic `/archive/` to prevent URL collision.
   - Serves responses with `Cache-Control: public, max-age=86400`.
4. **Frontend Archive Routing & Multi-Tier Fallback**:
   - In [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js), route archive images to `buildArchiveThumbnailSrc(...)` in thumbnail view.
   - In [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js), wire two-tier fallback on `onerror`: if `quivit://archive-thumb/...` fails, fall back to direct archive preview (`quivit://archive/...`), and finally to 32px native shell icon.

> [!IMPORTANT]
> ## User Review Required
> - **Unified Archive Handling**: Works identically across ZIP, CBZ, RAR, CBR, 7Z, CB7, TAR, and CBT via raw entry extraction.
> - **Zero Viewer Eviction**: The 20-image high-res viewer LRU (`zip_entries`) and the 200-image thumbnail LRU (`thumb_cache`) are completely decoupled.
> - **Thread Concurrency**: Raw extraction, image decoding, and downscaling run strictly on background threads (`spawn_blocking`). Memory cache hits return immediately on the protocol thread.
> - **Format Scope**: Raster images are downscaled to 96×96 PNG. SVGs pass through original vector bytes as `image/svg+xml`. ICO files continue to route to native shell icons.

> [!CAUTION]
> ## Execution Rules
> **Do not mark pending items as completed after writing the code.** Items must remain marked as `[PENDING]` until the user has explicitly verified and approved that the implementation functions properly at runtime.

---

## Architectural Invariants & Validation Constraints

Every item in this plan follows [.agents/AGENTS.md](file:///E:/Projects/QuiviT/.agents/AGENTS.md) and [.agents/skills/validate-changes/SKILL.md](file:///E:/Projects/QuiviT/.agents/skills/validate-changes/SKILL.md):

1. **Rust Module Ownership & Facade Encapsulation:**
   - Archive thumbnail extraction and caching live inside `archives/` domain modules (`cache.rs` and `mod.rs`).
   - `protocol.rs` calls facade methods on `ArchiveCache` without reaching into archive internals.
2. **Performance First & Hot Path Invariants:**
   - **Zero Viewer Cache Eviction**: Thumbnails never call `insert_zip_entry`.
   - **Fast-Path Memory Lookup**: Cached thumbnails bypass `spawn_blocking` entirely via `try_read()`.
   - **HTTP Caching**: `Cache-Control: public, max-age=86400` allows WebView2 to serve revisit requests directly from disk cache.
   - **Bound Memory**: Thumbnail cache capacity is capped at 200 entries (~2 MB RAM total).
3. **Blast Radius & Downstream Safety:**
   - Existing viewer protocol route (`quivit://archive/...`) remains untouched.
   - Checking `/archive-thumb/` before `/archive/` avoids route collision.
   - Non-image files in archives continue to route to native shell icons.

---

## Proposed Changes

### 1. Dedicated Thumbnail LRU Cache (Rust)

#### [MODIFY] [src-tauri/src/archives/cache.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs)
- [PENDING] Define `CachedThumbnail`:
  ```rust
  #[derive(Clone)]
  pub struct CachedThumbnail {
      pub data: Arc<[u8]>,
      pub mime: &'static str,
  }
  ```
- [PENDING] Implement `ThumbCacheState` with 200-entry bound:
  ```rust
  pub(crate) struct ThumbCacheState {
      pub(crate) entries: HashMap<(String, String), CachedThumbnail>,
      pub(crate) order: VecDeque<(String, String)>,
      pub(crate) capacity: usize,
  }

  impl ThumbCacheState {
      pub(crate) fn new(capacity: usize) -> Self {
          Self {
              entries: HashMap::new(),
              order: VecDeque::new(),
              capacity,
          }
      }

      pub(crate) fn get(&mut self, archive_path: &str, entry_name: &str) -> Option<CachedThumbnail> {
          let key = (archive_path.to_string(), entry_name.to_string());
          if self.entries.contains_key(&key) {
              self.order.retain(|k| k != &key);
              self.order.push_back(key.clone());
              return self.entries.get(&key).cloned();
          }
          None
      }

      pub(crate) fn insert(
          &mut self,
          archive_path: String,
          entry_name: String,
          thumb: CachedThumbnail,
      ) {
          let key = (archive_path, entry_name);
          if self.entries.contains_key(&key) {
              self.order.retain(|k| k != &key);
              self.order.push_back(key.clone());
              self.entries.insert(key, thumb);
              return;
          }

          if self.order.len() >= self.capacity {
              if let Some(old_key) = self.order.pop_front() {
                  self.entries.remove(&old_key);
              }
          }
          self.order.push_back(key.clone());
          self.entries.insert(key, thumb);
      }

      pub(crate) fn remove_archive(&mut self, archive_path: &str) {
          self.entries.retain(|(path, _), _| path != archive_path);
          self.order.retain(|(path, _)| path != archive_path);
      }
  }
  ```
- [PENDING] Add `thumb_cache: Mutex<ThumbCacheState>` to `ArchiveCache`:
  - Initialized in `ArchiveCache::new` with capacity 200.
  - Expose `get_cached_thumb(&self, archive_path: &str, entry_name: &str) -> Option<CachedThumbnail>`.
  - Expose `insert_cached_thumb(&self, archive_path: &str, entry_name: &str, data: Arc<[u8]>, mime: &'static str)`.
  - In `drop_archive(&mut self, archive_path: &str)`: call `self.thumb_cache.lock().unwrap().remove_archive(archive_path)`.
- [PENDING] Add test helpers in `cache.rs`:
  - `contains_thumb_entry(&self, archive_path: &str, entry_name: &str) -> bool`
  - `cached_thumb_count(&self) -> usize`

---

### 2. Archive Thumbnail Generation (Rust)

#### [MODIFY] [src-tauri/src/archives/mod.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/mod.rs)
- [PENDING] Implement raw entry bytes extraction without viewer LRU pollution:
  ```rust
  fn read_raw_entry_bytes_for_thumb(
      &mut self,
      archive_path: &str,
      entry_name: &str,
  ) -> Result<Vec<u8>, String> {
      if self.is_archive_password_required(archive_path) {
          return Err(format!("Archive is password-protected: {archive_path}"));
      }

      // 1. If viewer already has full image loaded in memory, reuse those bytes
      if let Some(cached) = self.get_zip_entry(archive_path, entry_name) {
          return Ok(cached.to_vec());
      }

      match ArchiveKind::from_path(archive_path)? {
          ArchiveKind::Zip => {
              // 2. Read from open zip archive or single extraction without calling insert_zip_entry
              if self.contains_archive(archive_path) {
                  if let Some(data) = self.read_from_open_zip(archive_path, entry_name) {
                      return Ok(data.to_vec());
                  }
              }
              zip::extract_zip_entry(archive_path, entry_name, None)
                  .map_err(|_| format!("Cannot find ZIP entry: {entry_name}"))
          }
          ArchiveKind::Rar | ArchiveKind::SevenZ | ArchiveKind::Tar => {
              let data = self.read_temp_entry_bytes(archive_path, entry_name)?;
              data.wait_for_data(entry_name)
          }
      }
  }
  ```
- [PENDING] Implement `generate_thumbnail(entry_name: &str, raw_bytes: &[u8]) -> Result<(Vec<u8>, &'static str), String>`:
  - Extension check: if `.svg` or `.svgz`, return `(raw_bytes.to_vec(), "image/svg+xml")`.
  - Raster decode: `image::load_from_memory(raw_bytes)`.
  - Downscale: `img.thumbnail(96, 96)`.
  - Encode to PNG: `thumb.write_to(&mut buf, image::ImageFormat::Png)`.
  - Return `(png_bytes, "image/png")`.
- [PENDING] Implement `pub fn read_entry_thumbnail(&mut self, archive_path: &str, entry_name: &str) -> Result<(Vec<u8>, &'static str), String>`:
  - If `get_cached_thumb` returns cached entry, return immediately.
  - Call `read_raw_entry_bytes_for_thumb`.
  - Call `generate_thumbnail`.
  - Call `insert_cached_thumb`.
  - Return `(bytes, mime)`.

---

### 3. Protocol Routing & HTTP Caching

#### [MODIFY] [src-tauri/src/protocol.rs](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs)
- [PENDING] Add `parse_archive_thumb_url`:
  ```rust
  fn parse_archive_thumb_url(url: &str) -> Result<(String, String), String> {
      let Some((_, archive_entry_path)) = url.split_once("/archive-thumb/") else {
          return Err(format!("Invalid quivit archive thumbnail URL: {url}"));
      };

      let Some((archive_path_encoded, entry_name_encoded)) = archive_entry_path.split_once('/') else {
          return Err("Missing archive path or entry name".to_string());
      };

      let archive_path = crate::utils::base64_decode(archive_path_encoded)
          .ok_or_else(|| "Invalid base64 archive path".to_string())?;

      let entry_clean = entry_name_encoded.split('?').next().unwrap_or(entry_name_encoded);
      let entry_name = crate::utils::url_decode(entry_clean);
      Ok((archive_path, entry_name))
  }
  ```
- [PENDING] Add `thumb_response(data: &[u8], mime: &str) -> Response<Vec<u8>>`:
  ```rust
  fn thumb_response(data: &[u8], mime: &str) -> Response<Vec<u8>> {
      Response::builder()
          .status(200)
          .header("Content-Type", mime)
          .header("Content-Length", data.len().to_string())
          .header("Cache-Control", "public, max-age=86400")
          .header("Access-Control-Allow-Origin", "*")
          .body(data.to_vec())
          .unwrap()
  }
  ```
- [PENDING] Add `try_cached_thumb_response`:
  ```rust
  fn try_cached_thumb_response<R: tauri::Runtime>(
      app_handle: &tauri::AppHandle<R>,
      archive_path: &str,
      entry_name: &str,
  ) -> Option<Response<Vec<u8>>> {
      let state = app_handle.state::<std::sync::RwLock<ArchiveCache>>();
      let cache = state.try_read().ok()?;
      let cached = cache.get_cached_thumb(archive_path, entry_name)?;
      Some(thumb_response(&cached.data, cached.mime))
  }
  ```
- [PENDING] Insert `/archive-thumb/` handler directly after `/thumb/` and before `/archive/`:
  ```rust
  if url.contains("/archive-thumb/") {
      let (archive_path, entry_name) = match parse_archive_thumb_url(&url) {
          Ok(parts) => parts,
          Err(message) => {
              let response = Response::builder()
                  .status(400)
                  .body(message.into_bytes())
                  .unwrap();
              responder.respond(response);
              return;
          }
      };

      let app_handle = ctx.app_handle().clone();
      if let Some(cached) = try_cached_thumb_response(&app_handle, &archive_path, &entry_name) {
          responder.respond(cached);
          return;
      }

      tauri::async_runtime::spawn_blocking(move || {
          let thumb_res = app_handle
              .state::<std::sync::RwLock<ArchiveCache>>()
              .write()
              .map_err(|e| e.to_string())
              .and_then(|mut cache| cache.read_entry_thumbnail(&archive_path, &entry_name));

          match thumb_res {
              Ok((bytes, mime)) => responder.respond(thumb_response(&bytes, mime)),
              Err(_) => {
                  let response = Response::builder()
                      .status(404)
                      .body(b"Archive thumbnail not found".to_vec())
                      .unwrap();
                  responder.respond(response);
              }
          }
      });
      return;
  }
  ```
- [PENDING] Add `parse_archive_thumb_url` to `protocol_tests.rs` test imports.

---

### 4. Frontend Archive Thumbnail Routing & Fallback

#### [MODIFY] [src/js/fsUtils.js](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
- [PENDING] Add `buildArchiveThumbnailSrc(archivePath, entryName)`:
  ```js
  buildArchiveThumbnailSrc(archivePath, entryName) {
    const encoded = _base64Encode(archivePath);
    const isWindows = typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent.includes('Windows') : true;
    const base = isWindows ? 'http://quivit.localhost' : 'quivit://localhost';
    return `${base}/archive-thumb/${encoded}/${encodeURIComponent(entryName)}`;
  },
  ```
- [PENDING] In `buildThumbnailSrc(item, state)`:
  - For pipe-delimited favorites: call `this.buildArchiveThumbnailSrc(archivePath, entryName)`.
  - For active archive images (`state?.mode === 'archive' && !this._isAbsolutePath(item.path)`): call `this.buildArchiveThumbnailSrc(state.archivePath, item.name)`.

#### [MODIFY] [src/js/filepanel/filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- [PENDING] In `updateEntry` (line 949), add `/archive-thumb/` branch to two-tier `slots.thumbImg.onerror`:
  ```js
  if (currentSrc.includes('/archive-thumb/')) {
    slots.thumbImg.onerror = () => {
      slots.thumbImg.onerror = null;
      const iconPath = FsUtils._isPathSpecificIcon(ext) ? item.path : '';
      const fallbackSrc = FsUtils.buildNativeIconSrc(iconPath, ext, 'large');
      thumbnailCache.set(targetSrc, fallbackSrc);
      slots.thumbImg.src = fallbackSrc;
    };
    let archivePath = '';
    let entryName = '';
    if (item.path && item.path.includes('|')) {
      const sep = item.path.indexOf('|');
      archivePath = item.path.slice(0, sep);
      entryName = item.path.slice(sep + 1);
    } else if (state?.mode === 'archive' && !FsUtils._isAbsolutePath(item.path)) {
      archivePath = state.archivePath;
      entryName = item.name;
    }
    const directSrc = archivePath && entryName
      ? FsUtils.buildArchiveSrc(archivePath, entryName)
      : (FsUtils._isPathSpecificIcon(ext) ? item.path : '');
    if (directSrc && directSrc.includes('/archive/')) {
      thumbnailCache.set(targetSrc, directSrc);
      slots.thumbImg.src = directSrc;
    } else {
      const fallbackSrc = FsUtils.buildNativeIconSrc(directSrc, ext, 'large');
      thumbnailCache.set(targetSrc, fallbackSrc);
      slots.thumbImg.src = fallbackSrc;
    }
  }
  ```
- [PENDING] In `buildFavoriteEntry` (line 429), apply identical `/archive-thumb/` fallback logic.

---

## Verification Plan

### Automated Tests

```pwsh
npm test
node --check src/js/filepanel/filePanel.js src/js/fsUtils.js
cargo check --tests --manifest-path src-tauri/Cargo.toml
cargo test protocol::tests --manifest-path src-tauri/Cargo.toml
cargo test archive_cache --manifest-path src-tauri/Cargo.toml
```

- **Protocol Tests (`src-tauri/src/tests/protocol_tests.rs`)**:
  - `parse_archive_thumb_url_decodes_path_and_entry_name`
  - `parse_archive_thumb_url_handles_query_params`
  - `parse_archive_thumb_url_rejects_malformed_urls`
- **Archive Cache Tests (`src-tauri/src/tests/archive_tests.rs`)**:
  - `archive_cache_thumb_lru_bounds_capacity_at_200` (inserting 201 entries evicts the first)
  - `archive_cache_thumb_lru_touch_promotes_entry` (accessing entry moves it to the back)
  - `archive_cache_thumb_lru_dropped_on_archive_drop` (`drop_archive` clears all thumbs for that archive)
  - `read_entry_thumbnail_does_not_pollute_viewer_zip_entries` (verifies `zip_entries` count is 0 after thumb extraction)
- **Frontend Tests (`src/js/tests/fileListViewMode.test.mjs`)**:
  - `buildThumbnailSrc` generates `quivit://archive-thumb/...` for archive image items.
  - `buildThumbnailSrc` generates `quivit://archive-thumb/...` for archive favorites (`archive.cbz|cover.jpg`).
  - Non-image files in archives continue to route to `buildNativeIconSrc`.
  - `buildArchiveThumbnailSrc` produces expected base64 archive path and encoded entry name.

### Manual Verification

1. Open a comic book archive with 50+ pages (CBZ, CBR, 7Z) in thumbnail view.
2. In DevTools Network tab, verify that thumbnail image requests are directed to `quivit://archive-thumb/...` instead of `quivit://archive/...`.
3. Confirm response sizes are ~5–15 KB PNGs instead of 2–10 MB full images.
4. Verify the image viewer viewport image does not evict or flicker while browsing thumbnails.
5. Scroll up and down rapidly: verify smooth scrolling and immediate cache reuse via HTTP 200 / browser cache.
6. Favorite an image inside an archive, switch to Favorites tab, and verify the thumbnail loads properly from `/archive-thumb/`.
7. Refresh with F5: verify thumbnails re-request cleanly and `drop_archive` cache invalidation works.

---

## Deviations, Violations & Runtime Fixes

- None recorded yet.
