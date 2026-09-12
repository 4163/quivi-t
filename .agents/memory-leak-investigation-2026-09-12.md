# Memory leak investigation

Date: 2026-09-12

Status: pending fixes and battle-test verification.

Latest synthesis: the primary leak candidate is frontend-created Blob/object URL retention from full archive images. WebView2 `Default\blob_storage` held about 607 MB in one directory with 94 files, while the normal HTTP `Cache` directory was only about 9 MB. That makes `ensureArchiveBlob()` and missing blob revocation the first fix target.

## Context

During normal app use, QuiviT climbed to roughly 900 MB to 1 GB and stayed there after browsing between folders and archives while toggling thumbnail view. The intended steady-state budget is much lower: Rust archive cache default is 128 MB, with roughly another 50 MB expected for normal frontend/runtime overhead.

This report consolidates the main-agent live probes plus the two read-only subagent investigations:

- Frontend investigation: `01a0946f-9a89-7d70-8a94-217572410fed`
- Backend investigation: `01a0946f-b042-77e2-ba9a-43694a3ff60e`

## Live evidence

The leak is mostly in WebView2 processes, not the Rust host.

Observed process memory while the already-running app was idle:

- `tauri-app.exe`: about 135 MB private, 158 MB working set.
- WebView2 browser process: about 815 MB private.
- WebView2 GPU process: peaked around 930 MB private, working set over 1 GB.
- WebView2 renderer process: about 545-632 MB private, working set around 1.4-1.6 GB.
- WebView2 profile folder: about 696 MB on disk.
- WebView2 `Default\blob_storage`: about 607 MB across 94 files, newest writes during the active session.
- WebView2 normal HTTP `Cache`: about 9 MB.
- `%TEMP%\QuiviT`: several stale temp archive directories, including six current-day folders around 84 MB each.

Interpretation: the sustained 1 GB-class memory pressure is almost certainly dominated by frontend/WebView decoded images, GPU textures, and blob URLs. Rust still has real pressure points, especially temp extraction and protocol cloning, but it was not the largest live owner in this run. The disk evidence points much more strongly at Blob storage than ordinary protocol HTTP caching.

## Consolidated suspects

### 1. Archive thumbnail/viewer blob cache stores full archive pages

Status: pending fix.

Files:

- `src/js/filepanel/filePanel.js`
- `src/js/viewer/viewerRender.js`
- `src/js/fsUtils.js`
- `src-tauri/src/protocol.rs`

Mechanism:

- `ensureArchiveBlob()` fetches a full `/archive/` image response and stores an object URL in `thumbnailCache`.
- The same cache is shared by thumbnail view, hover preload, and viewer reuse.
- Eviction revokes blob URLs in the custom `set()` wrapper, but `thumbnailCache.clear()` bypasses that revocation.
- Archive thumbnail mode currently uses full image bytes, not resized thumbnails.
- WebView2 persisted about 607 MB in `Default\blob_storage`, which is exactly the storage class used by Blob/object URLs.

Why this matches the report:

- User action included jumping between archives and toggling thumbnail view.
- Live WebView2 profile data showed 94 blob-storage files totaling about 607 MB.
- Live memory sits in WebView2 renderer/GPU/browser processes, not primarily Rust.

Conflict/consolidation:

- Frontend report treats this as a high-confidence frontend leak.
- Backend report also flags it because each blob fetch pressures Rust protocol response cloning.
- These are the same issue from two sides: full archive images are fetched, cloned, cached, decoded, and sometimes not revoked.

Runtime confirmation:

- Monkey-patch `URL.createObjectURL` and `URL.revokeObjectURL`; created archive blob URLs should exceed revoked URLs after refreshes and archive browsing.
- Network panel should show `/archive/...` requests for visible thumbnails.
- Memory should correlate with `thumbnailCache.size` and unique archive pages touched.
- The WebView2 `blob_storage` folder should stop growing after revocation and cache policy fixes.

Likely fix direction:

- Add a cache clear helper that revokes all blob URLs before clearing.
- Stop using the general thumbnail cache as the owner for viewer archive blobs.
- Keep archive blob reuse tightly scoped and byte-limited.
- Build archive thumbnails as thumbnails, not full image blobs.

### 2. Thumbnail cache retains full-resolution images

Status: pending fix.

Files:

- `src/js/filepanel/filePanel.js`
- `src/js/fsUtils.js`

Mechanism:

- `thumbnailCache` is bounded by item count (`250`), not by bytes.
- Disk WebP, AVIF, APNG, SVG, and archive thumbnail paths can use original image URLs instead of a resized thumbnail route.
- `filePanel.js` can store retained `new Image()` objects in `thumbnailCache` for loaded thumbnails.
- A 250-item cache is small for icon URLs but huge for decoded full-resolution pages.
- One nuance from the main pass: `thumbImg.onload` is overwritten in the non-image branch and not restored for later image reuse. That bug may make the decoded-image retainer inconsistent rather than universal, but when it does run, it retains exactly the wrong thing.

Why this matches the report:

- User action included enabling/disabling thumbnail view.
- Live memory sits in WebView2 renderer/GPU processes.
- The code retains decoded browser image objects beyond visible rows.

Runtime confirmation:

- Heap snapshot should show many `HTMLImageElement` objects retained by `thumbnailCache`.
- Cache keys should include `asset://` or `/archive/` full image URLs, not only `/thumb/`.
- Clearing `thumbnailCache`, blanking visible thumbnail `src`s, and forcing GC should reduce renderer/GPU memory if this is active.

Likely fix direction:

- Stop storing `new Image()` objects in thumbnail caches.
- Cache only lightweight warm flags or explicit thumbnail-sized blob URLs.
- Add a byte-aware or mode-aware thumbnail cache policy.
- Prefer a real resized thumbnail route for archive/disk thumbnails instead of original image URLs.

### 3. Viewer image pool can retain too many decoded images

Status: secondary, bounded-retention proof needed.

File:

- `src/js/viewer/viewerRender.js`

Mechanism:

- `_activeNodes` maps image source to pooled `<img>` nodes.
- Recycle logic runs before adding newly desired nodes and only when `_activeNodes.size > POOL_SIZE`.
- The map can briefly exceed the pool limit after adding current/neighbor entries, then gets trimmed on the next state change.
- This is probably not unbounded, but 10 to 13 decoded full-resolution pages plus WebView backing stores can still be too much.

Runtime confirmation:

- DevTools heap should show `.viewer-img` elements retained by `_activeNodes`.
- Source keys should include images that are no longer current, bridged, or neighbors.
- Memory should stop climbing if stale active nodes are recycled to the desired set on each navigation.

Likely fix direction:

- Recycle any `_activeNodes` entry not in `desiredSrcs`, while preserving the active image and current bridge.
- Keep the count cap as a secondary guard.
- Make sure recycling removes `src` and revokes blob URLs when applicable.

### 4. WebGL/Lanczos clean image cache is count-bound, not byte-bound

Status: pending proof.

Files:

- `src/js/shared/blobImage.js`
- `src/js/services/pipelines/glRuntime.js`
- `src/js/services/scaling/lanczos.js`
- `src/js/viewer/viewerPipelines.js`

Mechanism:

- `blobImage.js` keeps up to six `ImageBitmap`s plus blob URLs.
- Eviction closes `ImageBitmap`s and revokes blob URLs, which is good.
- Six large decoded pages can still cost hundreds of MB.
- Pipeline clearing does not clear this module cache.

Runtime confirmation:

- Memory growth should be much worse when filters or Lanczos are active.
- Heap/native memory should show `ImageBitmap` retention.
- A temporary debug clear of the texture cache should drop memory if this is a major owner.

Likely fix direction:

- Make the texture cache byte-aware.
- Expose a narrow clear/trim method and call it on source churn, mode changes, or memory-pressure-safe points.
- Consider capacity 1-2 for very large images.

### 5. Protocol responses clone full ZIP entries

Status: pending optimization, not the primary sustained leak in current evidence.

Files:

- `src-tauri/src/protocol.rs`
- `src-tauri/src/archives/mod.rs`
- `src-tauri/src/archives/cache.rs`

Mechanism:

- Cached ZIP entries are `Arc<[u8]>`.
- The protocol path clones them into `Vec<u8>` and then clones again for the HTTP response body.
- Cold paths can briefly hold extracted bytes, cached bytes, wait bytes, and response bytes.
- This likely causes allocator high-water RSS, but the live process evidence did not show Rust as the main sustained owner.
- Earlier suspicion around `Cache-Control: public, max-age=86400` is lower priority after the profile breakdown: the normal WebView HTTP cache was about 9 MB, while Blob storage was about 607 MB.

Runtime confirmation:

- Instrument response body sizes and Rust private bytes during a large page load.
- Rust memory should spike by roughly 2x-3x page size during concurrent requests if this is active.

Likely fix direction:

- Reduce full-entry cloning in protocol responses where Tauri response types allow it.
- Avoid duplicate conversions between `Arc<[u8]>` and `Vec<u8>`.
- Keep this below frontend cache fixes unless Rust memory starts dominating.

### 6. Non-ZIP temp extraction keeps extracted archive trees

Status: pending cleanup policy.

Files:

- `src-tauri/src/archives/cache.rs`
- `src-tauri/src/archives/mod.rs`
- `src-tauri/src/platform/temp_archive.rs`

Mechanism:

- RAR/7Z/TAR extraction uses `%TEMP%\QuiviT\<md5>`.
- Temp dirs are cleaned when `SingleArchiveCache` drops.
- The cache keeps up to 8 open archives.
- Stale dirs were observed across older runs, so app startup or shutdown cleanup is incomplete for abandoned temp dirs.

Runtime confirmation:

- Watch `%TEMP%\QuiviT` while opening RAR/7Z/TAR archives and then navigating away.
- If dirs remain until app exit or cache eviction, this is expected but still may be too permissive.
- If dirs remain after clean app shutdown, this is a real disk-temp leak.

Likely fix direction:

- Clean stale `%TEMP%\QuiviT` directories on startup.
- Drop non-current temp archive state more aggressively if memory/disk pressure matters more than instant back-navigation.
- Keep extraction cancellation reliable when archive cache entries are dropped.

### 7. Temp-origin resolver can prepare too many candidate archives

Status: pending proof.

File:

- `src-tauri/src/platform/temp_archive.rs`

Mechanism:

- Temp-origin resolution can scan candidates from registry/history/open windows/folders.
- It may call `cache.prepare_archive()` for several candidates before it knows which one matches.
- For non-ZIP candidates, that can start extraction work and create temp dirs for wrong candidates.

Runtime confirmation:

- Log candidate count, `prepare_archive` path, extraction starts, and temp-dir creation when opening temp-extracted files from archive tools.
- A burst of unrelated temp dirs confirms it.

Likely fix direction:

- Add a cheaper candidate validation path before `prepare_archive()`.
- Avoid starting extraction during origin probing unless the candidate is highly likely.

### 8. Non-ZIP animation header checks can read full extracted files

Status: pending optimization.

Files:

- `src-tauri/src/archives/mod.rs`
- `src-tauri/src/commands/animation.rs`

Mechanism:

- `check_is_animated` asks for a bounded header.
- For RAR/7Z/TAR, header reads can wait for and read a whole extracted entry, then slice.
- This is transient memory pressure, not the main sustained WebView leak.

Runtime confirmation:

- Trace `check_is_animated` on large non-ZIP images.
- Rust RSS should spike by full image size instead of the requested header size.

Likely fix direction:

- Read only the requested header bytes from extracted temp files.
- Avoid whole-file `fs::read` for header paths.

### 9. Favorites thumbnail cache has the same decoded-image pattern

Status: pending lower-priority fix.

File:

- `src/js/filepanel/filePanel.js`

Mechanism:

- `favoritesThumbnailCache` can retain `new Image()` objects.
- `renderFavorites()` rebuilds DOM with `innerHTML = ''`, while the cache keeps decoded image retainers.
- Usually smaller than the main thumbnail cache unless many favorites are large images or archive entries.

Runtime confirmation:

- Heap snapshot should show images retained by `favoritesThumbnailCache`.
- Memory grows when expanding/collapsing or rebuilding favorites in thumbnail mode.

Likely fix direction:

- Apply the same thumbnail cache policy as the main file list.
- Avoid decoded-image retainers.

### 10. Small unbounded metadata caches

Status: low priority.

Files:

- `src/js/core.js`
- `src/js/filepanel/filePanel.js`

Mechanism:

- `_animMemo` and `animatedSvgSrcs` grow across unique source checks.
- Entries are small strings/results, so this is unlikely to explain 1 GB.

Runtime confirmation:

- Heap dominated by strings/maps rather than images/blobs would raise priority, but that is not expected.

Likely fix direction:

- Add simple size bounds if touching nearby code.

## Fix priority

1. Fix `ensureArchiveBlob()` ownership and revocation. This is the strongest match to live evidence.
2. Stop retaining decoded `Image` objects in thumbnail caches.
3. Add byte-aware limits or trimming to `blobImage.js`.
4. Tighten viewer pool recycling if DevTools confirms stale decoded viewer images are retained.
5. Clean stale temp archive directories on startup and reduce non-ZIP temp retention where practical.
6. Optimize protocol/header clone paths after the frontend leak is controlled.

## Battle-test checklist

After fixes land, test with normal use rather than a tiny synthetic run:

- Browse several folders with large WebP/AVIF/APNG/SVG images.
- Toggle thumbnail view on and off repeatedly.
- Browse CBZ/ZIP archives in thumbnail view.
- Browse RAR/7Z/TAR archives if available.
- Enable and disable filters and Lanczos during browsing.
- Leave the app idle for 10-30 minutes after browsing.
- Confirm WebView2 renderer/GPU/browser private memory settles instead of climbing.
- Confirm `%TEMP%\QuiviT` does not grow without cleanup across app restarts.
- Confirm thumbnail view still feels instant when scrolling back through recently visible rows.

## Pending verification result

Unverified. This report records likely causes and live evidence before fixes. Update this section after the next memory-leak slice and after battle testing.
