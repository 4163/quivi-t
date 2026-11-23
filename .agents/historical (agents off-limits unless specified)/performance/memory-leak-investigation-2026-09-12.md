# Memory leak investigation

Date: 2026-09-12

Status: investigation completed and finalized (2026-09-13). Follow-up implementation is tracked in [archive-resource-refactor.md](../../archive-resource-refactor.md).

> [!NOTE]
> This investigation is finalized. Active implementation and pending tasks are tracked in [archive-resource-refactor.md](../../archive-resource-refactor.md).

Latest synthesis: the first leak cause was frontend-created Blob/object URL retention from full archive images. WebView2 `Default\blob_storage` held about 607 MB in one directory with 94 files, while the normal HTTP `Cache` directory was only about 9 MB. Suspect 1 resolves stale blob retention by revoking blob URLs on eviction, deletion, and refresh clears, protecting the active viewer blob, and cancelling in-flight requests. A later limit test showed the next problem: even with blob storage controlled, WebView2 renderer/GPU memory can stay high from decoded full-page images. Suspects 2 and 3 mitigate thumbnail/viewer image retention. A later dev-run probe with thumbnail view off showed `blob_storage` stayed small, while renderer/GPU memory still climbed with Lanczos active; Suspect 4 is now mitigated in code by eliminating archive neighbor preloads, avoiding viewer-side archive blob warmup, shrinking the clean image cache, and cropping before Lanczos resize. Suspects 8 and 10 are resolved: header sniffing uses streaming reads, metadata caches are bounded, and staging canvas allocations are released on exit.

## Context

During normal app use, QuiviT climbed to roughly 900 MB to 1 GB and stayed there after browsing between folders and archives while toggling thumbnail view. The intended steady-state budget is much lower: Rust archive cache default is 128 MB, with roughly another 50 MB expected for normal frontend/runtime overhead.

This report consolidates the main-agent live probes plus the two read-only subagent investigations:

- Frontend investigation: `01a0946f-9a89-7d70-8a94-217572410fed`
- Backend investigation: `01a0946f-b042-77e2-ba9a-43694a3ff60e`

## Agreed refactor target

- **Two-Archive Sliding Buffer Lifecycle (`max_open_archives = 2`):**
  - While reading archives: Maintain a lean 2-archive sliding buffer (current archive + immediately preceding archive). This guarantees zero 404 race conditions for in-flight requests, preserves outgoing bridge frames, and enables instant back-navigation without re-extraction. Opening a third archive immediately purges the oldest archive.
  - **RAR, 7Z, and TAR:** Strictly at most 2 temporary extraction directories exist in `%TEMP%\QuiviT` during archive reading (down from 8). When the oldest archive is evicted, its worker cancels and its temp folder is deleted immediately.
  - **ZIP and CBZ:** In-memory entry bytes are strictly tied to the 2-archive buffer (`max_open_archives = 2`). When navigating to a third archive, all in-memory entry bytes and handles of the oldest archive are purged immediately via `remove_archive_zip_entries()`. The cache only holds pages from the active + previous ZIP (e.g. ~20–30 MB total during normal reading) rather than hovering at 128 MB. The 128 MB cap is solely a hard ceiling safety net for huge/4K scans. Zero disk temporary materialization is used for ZIP/CBZ.
  - **Exit Cleanup:** When navigating out of archives completely (mode changes to `'directory'` or `'empty'`), drop all idle archive caches, deleting all `%TEMP%\QuiviT` extraction directories and freeing all ZIP memory to 0 MB.
  - **Startup Sweep:** Purge any orphaned `%TEMP%\QuiviT` directories left behind from force-closes or system crashes during app initialization.
- **Archive Navigation & In-Flight Safety:**
  - The 2-archive buffer naturally absorbs in-flight protocol requests during transition handoffs, eliminating 404 errors.
- **Frontend Viewer Bridge:**
  - Retain the 4-node DOM image pool (`VIEWER_IMAGE_POOL_CAPACITY = 4`) and neighbor bridge retention in `desiredSrcs`. This preserves smooth transitions and prevents WebGL filter canvas flickering.
- **Non-blocking Archive Initialization:**
  - Archive entry animation status checks (`check_is_animated`) run asynchronously without blocking the initial `src` assignment and display of the first image.
- **Archive Thumbnail Viewport Pipeline (Target Agreed):**
  - Archive thumbnail loading is strictly bound to the visible viewport (plus a 1-item safety buffer above and below the viewport edge).
  - Visible rows load sequentially one-by-one in the active scroll direction (`+1` if scrolling down, `-1` if scrolling up), prioritizing the selected item.
  - Rows that leave the viewport (beyond the 1-item buffer) clear and release their thumbnail image immediately, bounding memory strictly to the viewport display.
  - Fast scrolling cancels in-flight/queued decodes for rows that leave the viewport before loading.
  - Replaces the blunt 3-item static active-only window with dynamic viewport-bound loading, giving real thumbnails as the user browses while keeping decoded image memory strictly capped to the viewport size.
- **WebView2 Blob Storage & Metadata Bounding (Resolved):**
  - Revoke object URLs on cache eviction and clear in `BoundedMap` (Suspect 1, resolved).
  - Stream animation header reads via `take()` to avoid reading full files (Suspect 8, resolved).
  - Bounded metadata sets and maps (512 entries for `_animMemo` and `animatedSvgSrcs`).
  - Zero staging canvas dimensions on animation exit.
  - Mark full archive-page responses `no-store`; retain the existing long-lived policy only for small icons and true thumbnails.
  - Remove hover preview from file panel rows (completed 2026-09-13).

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

Follow-up dev-run evidence after the blob and thumbnail mitigations:

- Thumbnail view was off (`file_list_view_mode = list`) and Lanczos scaling was active.
- Rust host stayed around the same size as previous probes, roughly 135 MB private.
- WebView2 `Default\blob_storage` stayed small: 3 files, about 11.45 MB. Normal HTTP `Cache` stayed flat at about 9.40 MB.
- The large owners were WebView2 renderer and GPU private memory, with renderer samples reaching roughly 700 MB to 1 GB private and GPU samples reaching roughly 660 MB to 870 MB private.

Interpretation: the later 1 GB-class run was not the old thumbnail blob-storage issue. It points at decoded current-page image memory and the Lanczos processing path.

## Consolidated suspects

### 1. Archive thumbnail/viewer blob cache stores full archive pages

Status: resolved (2026-09-13).

Files:

- `src/js/services/cache.js`
- `src/js/filepanel/filePanel.js`
- `src/js/shared/blobImage.js`
- `src/js/services/scaling/lanczos.js`
- `src/js/services/pipelines/glRuntime.js`
- `src-tauri/src/protocol.rs`

Resolution:

- `BoundedMap` now takes an `onEvict(key, value)` callback called on `delete()`, `clear()`, capacity overflow, and key replacement.
- `thumbnailCache` and `favoritesThumbnailCache` pass `_revokeBlobEntry` to revoke `blob:` URLs via `URL.revokeObjectURL()`.
- Active viewer blob protection tracks `_activeViewerKey` and `_activeViewerBlob`, retaining the current image blob across rerenders and evictions until navigation changes `state.src`.
- Generation counters and `AbortController` in `ensureArchiveBlob()` cancel in-flight fetches and ignore stale responses on refresh.
- `blobImage.js` returns `null` on cancelled fetch, and null guards in `lanczos.js` and `glRuntime.js` prevent detached image draw calls.
- Verified with unit tests (`boundedMap.test.mjs`, `fileListViewMode.test.mjs`) and Playwright tests (`playwright/tests/test-thumbnail-flow.spec.js`).

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

Status: target agreed (viewport-bound directional queue with off-screen clear; temporary 3-item window currently active).

Files:

- `src/js/filepanel/filePanel.js`
- `src/js/fsUtils.js`

Current working-tree mitigation:

- Archive thumbnail view temporarily loads full `/archive/` image URLs only for the active entry and its immediate previous/next image entries (`ARCHIVE_THUMBNAIL_WINDOW_HALF = 1`).
- Archive thumbnail rows outside that moving three-item window use lightweight extension icons.
- `ensureArchiveBlob()` refuses oversized blob entries and trims cached archive blobs by both count and compressed-byte budget.
- Hover preload follows the same archive thumbnail window and no longer starts archive blob fetches on hover. It only reuses an already-cached nearby blob.
- Thumbnail caches no longer store off-DOM `new Image()` retainers for ordinary image thumbnails or favorites.
- The viewer still loads full archive images through the normal reader path.

Agreed target implementation:

- Replace the rigid 3-item static window with a **viewport-bound directional decode queue**:
  - Only rows currently inside the visible viewport (plus a 1-item margin above and below) are eligible for thumbnail loading.
  - Rows load sequentially one-by-one in the direction of scrolling (`+1` or `-1`), with the selected row prioritized first.
  - Rows that leave the viewport (beyond the 1-item margin) clear and release their thumbnail image immediately, bounding memory strictly to the screen height.
  - Fast-scrolling past rows cancels queued/in-flight decodes for rows that leave the viewport before loading.

### 3. Viewer image pool can retain too many decoded images

Status: mitigated in code, pending battle-test verification.

File:

- `src/js/viewer/viewerRender.js`

Mechanism:

- `_activeNodes` maps image source to pooled `<img>` nodes.
- Earlier recycle logic ran before adding newly desired nodes and only when `_activeNodes.size > POOL_SIZE`.
- The DOM image pool is now capped by `VIEWER_IMAGE_POOL_CAPACITY = 4`: active image, previous/next preloaded images, and one short-lived bridge image.
- `_activeNodes` now recycles anything outside the desired set on every state change instead of waiting for the old count cap to overflow.

Runtime confirmation:

- DevTools heap should show `.viewer-img` elements retained by `_activeNodes`.
- Source keys should be limited to the current image, immediate neighbors, and at most the transition bridge.
- Memory should stop climbing from stale viewer nodes if this path was active.

Likely fix direction:

- Recycle any `_activeNodes` entry not in `desiredSrcs`, while preserving the active image and current bridge.
- Keep the count cap as a secondary guard.
- Make sure recycling removes `src` and revokes blob URLs when applicable.

### 4. WebGL/Lanczos clean image cache is count-bound, not byte-bound

Status: mitigated in code, pending battle-test verification.

Files:

- `src/js/shared/blobImage.js`
- `src/js/services/pipelines/glRuntime.js`
- `src/js/services/scaling/lanczos.js`
- `src/js/viewer/viewerPipelines.js`

Mechanism:

- Before mitigation, `blobImage.js` kept up to six full-page `ImageBitmap`s plus blob URLs.
- Eviction closed `ImageBitmap`s and revoked blob URLs, which was correct but still count-bound rather than byte-bound.
- Six very large decoded pages could cost hundreds of MB even with perfect eviction.
- `lanczos.js` drew from a full clean source bitmap into an intermediate crop canvas before resizing, so each render could temporarily hold a full clean image, crop canvas, destination canvas, native image decode, and browser/GPU resources.
- Archive viewer rendering also preloaded previous/next archive images and tried to create archive blob warmups even when thumbnail view was off.

Resolution:

- Archive viewer rendering no longer neighbor-preloads archive images. Disk/folder viewer preloading still uses the existing previous/next behavior.
- Viewer rendering no longer creates archive blob warmups for the active image; it only reuses an already-cached thumbnail blob if one exists.
- `TEXTURE_CACHE_CAPACITY` is now 1.
- The clean image cache no longer creates Blob/object URLs.
- `getCleanImageCrop(src, sx, sy, sw, sh)` fetches the source and creates a caller-owned cropped `ImageBitmap` directly.
- Lanczos resize now uses the visible crop bitmap directly and closes it after each resize completes.
- Lanczos render cancellation now uses a generation guard so an older async crop cannot overwrite or return after a newer render starts.

Runtime confirmation:

- With thumbnail view off and Lanczos active, memory should no longer grow with every page touched.
- WebView2 `Default\blob_storage` should stay small during this run.
- Renderer/GPU memory may still spike on extremely large pages, but should settle after navigation and idle instead of tracking cumulative page count.
- Switching from Lanczos to Bilinear/Pixelated should lower peak renderer/GPU memory for the same page if the remaining pressure is the Lanczos processing path.

Likely fix direction:

- If the current mitigation is insufficient, make the Lanczos path tile-based or bypass Lanczos for images whose decoded crop exceeds a memory threshold.
- Add explicit runtime memory instrumentation around the Lanczos render lifecycle.
- Treat remaining high memory with `blob_storage` flat as current-frame decode/GPU pressure, not stale blob retention.

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

Status: target agreed (2-archive sliding buffer + folder exit cleanup + startup sweep).

Files:

- `src-tauri/src/archives/cache.rs`
- `src-tauri/src/archives/mod.rs`
- `src-tauri/src/platform/temp_archive.rs`

Mechanism:

- RAR/7Z/TAR extraction uses `%TEMP%\QuiviT\<md5>`.
- Temp dirs are cleaned when `SingleArchiveCache` drops.
- The previous cache kept up to 8 open archives.
- Opening 8 large RARs could leave 8 uncompressed trees in `%TEMP%` until the 9th evicted the oldest.
- Interrupted runs can leave temp dirs behind permanently.

Agreed fix direction:

- Cap open archives to `max_open_archives = 2` (active + previous archive). This cuts disk accumulation by 75% while maintaining the buffer needed to prevent in-flight 404s and enable instant back-navigation.
- When navigating away from archives to a normal folder or empty state, drop all idle archive caches so 0 temp directories remain.
- Clean stale `%TEMP%\QuiviT` directories on app startup.
- Keep extraction cancellation reliable when archive cache entries are dropped.

### 7. Temp-origin resolver can prepare too many candidate archives

Status: closed / out of scope (no code changes needed).

File:

- `src-tauri/src/platform/temp_archive.rs`

Rationale:

- Slice 5 (`d131378`) established strict candidate ranking where candidates with live archiver window context (known subfolder or explicit root) are sorted to index 0 (`deduped.sort_by_key(...)`). Candidate 0 matches on the first attempt during normal archiver launches, avoiding scans across lower-ranked candidates.
- The 2-archive buffer policy (`max_open_archives = 2`) naturally evicts and deletes any transient candidate state if an unexpected mismatch occurs.
- Modifying `temp_archive.rs` risks regressing the delicate window-detection and subfolder-matching balance established across the 7 supported archivers (Explorer, 7-Zip, NanaZip, WinRAR, Bandizip, WinZip, PeaZip) and verified by `temp_archive_tests.rs`.

### 8. Non-ZIP animation header checks can read full extracted files

Status: resolved (2026-09-13).

Files:

- `src-tauri/src/archives/mod.rs`
- `src-tauri/src/commands/animation.rs`

Resolution:

- `read_temp_entry_header()` opens the materialized file and reads up to `max_len` bytes with `std::io::Read::take()`.
- Header sniffing avoids reading whole multi-megabyte non-ZIP files into memory.
- Preserves the wait loop for in-flight extraction without holding full-entry byte buffers.

Mechanism:

- `check_is_animated` asks for a bounded header.
- Before the fix, non-ZIP paths waited for and read a whole extracted entry before slicing.
- This was transient memory pressure rather than the main sustained WebView leak.

Runtime confirmation:

- Streamed header reads succeed on non-ZIP animations without whole-file allocations.
- Verified in `cargo test archive_tests` and runtime app checks.

### 9. Favorites thumbnail cache had the same decoded-image pattern

Status: mitigated in code, pending battle-test verification.

File:

- `src/js/filepanel/filePanel.js`

Mechanism:

- Before the 2026-09-13 mitigation, `favoritesThumbnailCache` could retain `new Image()` objects.
- `renderFavorites()` rebuilds DOM with `innerHTML = ''`, while the cache keeps decoded image retainers.
- Usually smaller than the main thumbnail cache unless many favorites are large images or archive entries.

Runtime confirmation:

- Heap snapshot should show images retained by `favoritesThumbnailCache`.
- Memory grows when expanding/collapsing or rebuilding favorites in thumbnail mode.

Likely fix direction:

- Apply the same lightweight cache policy as the main file list.
- Avoid decoded-image retainers.

### 10. Small unbounded metadata caches

Status: resolved (2026-09-13).

Files:

- `src/js/core.js`
- `src/js/filepanel/filePanel.js`
- `src/js/services/cache.js`

Resolution:

- Added `BoundedSet` to `src/js/services/cache.js`.
- Bounded `_animMemo` in `src/js/core.js` to 512 entries with `BoundedMap`.
- Bounded `animatedSvgSrcs` in `src/js/filepanel/filePanel.js` to 512 entries with `BoundedSet`.

Mechanism:

- `_animMemo` and `animatedSvgSrcs` grew across unique source checks.
- Entries are small strings and booleans, so they were unlikely to explain 1 GB alone, but capping them prevents slow growth during long sessions.

Runtime confirmation:

- Unit tests verify capacity limits and FIFO eviction for both structures.
- Verified in runtime app checks.

## Baseline fix priority

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

For the agreed refactor, also confirm:

- At most two archive sessions exist while browsing across archives (active + previous).
- Navigating out of archives to a folder drops archive caches and clears `%TEMP%\QuiviT`.
- ZIP/CBZ in-memory entry bytes are strictly tied to the two-archive sliding buffer (`max_open_archives = 2`), evicting the oldest archive on the third archive, bounded by the shared 128 MB hard ceiling without disk temporary files.
- Rapid reader navigation preserves the four-node bridge transition without blank frames or filter canvas flicker.
- Archive thumbnail scrolling loads visible rows sequentially one-by-one (+1/-1 in scroll direction) and clears thumbnails as rows leave the viewport (with 1-item safety buffer).
- Leaving an animated SVG, GIF, WebP, or similar file releases its active staging and decoding resources without changing its displayed quality.

## Verification results

### Suspect 1 (2026-09-13)
- Status: resolved and verified.
- Unit tests: 74/74 passing (`npm test`), including `BoundedMap` onEvict callback and `thumbnailCache` blob revocation lifecycle tests.
- Static checks: `cargo check --tests` clean (0 warnings, 0 errors).
- Local browser tests: 6/6 passing in Chromium (`playwright/tests/test-thumbnail-flow.spec.js`), confirming rapid navigation cancellation in Lanczos, active viewer blob preservation through normal rerenders, and in-flight fetch cancellation on refresh.
- Runtime probe: fresh launch baseline recorded clean `Default\blob_storage` (0 files, 0 MB). In-flight cancellation and generation tracking successfully prevent stale blob URLs from refilling the cache on visual refresh.

### Suspect 2 (2026-09-13)
- Status: mitigated in code, not yet runtime-verified.
- Code checks: `node --check` clean for `src/js/fsUtils.js`, `src/js/filepanel/filePanel.js`, `src/js/viewer/viewerRender.js`, and `src/js/tests/fileListViewMode.test.mjs`.
- Unit tests: 77/77 passing (`npm test`), including active/neighbor archive thumbnail URLs, non-neighbor icon fallback, and archive blob cache budget tests.
- Local browser tests: 9/9 passing in Chromium, Firefox, and WebKit (`playwright/tests/test-thumbnail-flow.spec.js`).
- Runtime note: a limit test with very large archives previously settled near 1 GB because 67 full-page archive images still fit inside the old 250-item thumbnail cache. The latest mitigation keeps archive thumbnail image URLs to the active image plus its two neighbors and removes hover-created archive blob fetches.

### Suspect 3 (2026-09-13)
- Status: mitigated in code, not yet runtime-verified.
- Code checks: `node --check` clean for `src/js/viewer/viewerRender.js`.
- Unit/browser coverage: covered indirectly by the full JS test run and local Playwright thumbnail-flow harness.
- Runtime note: viewer DOM image retention is now limited to the current source, immediate neighbors, and at most one bridge image. A manual stress run still needs to confirm whether WebView2 renderer/GPU memory now settles.

### Suspect 4 (2026-09-13)
- Status: mitigated in code, not yet runtime-verified.
- Probe result: with thumbnail view off, `blob_storage` stayed near 11.45 MB and HTTP `Cache` stayed near 9.40 MB, while WebView2 renderer/GPU memory remained the main high-water owner under Lanczos.
- Code checks: `node --check` clean for `src/js/shared/blobImage.js`, `src/js/services/scaling/lanczos.js`, `src/js/viewer/viewerRender.js`, and `src/js/tests/blobImage.test.mjs`.
- Unit tests: 79/79 passing (`npm test`), including clean image cache capacity/eviction and crop-bitmap behavior.
- Local browser tests: 9/9 passing in Chromium, Firefox, and WebKit (`playwright/tests/test-thumbnail-flow.spec.js`).
- Runtime note: the code now avoids archive viewer neighbor preloads, avoids viewer-created archive blob warmups, keeps only one cached clean full image, and closes per-render cropped bitmaps after Lanczos resize.
- Cancellation note: the Lanczos path also guards async crop/resize completion by generation so stale renders do not win after rapid navigation.

### Suspect 8 (2026-09-13)
- Status: resolved and runtime-verified.
- Code checks: `cargo check --tests` clean.
- Unit tests: `cargo test archive_tests` passing (18/18).
- Implementation: `read_temp_entry_header` streams `max_len` bytes via `std::io::Read::take()`.
- Runtime note: verified in running app with `npm run tauri dev`.

### Suspect 10 and animation cleanup (2026-09-13)
- Status: resolved and runtime-verified.
- Code checks: `node --check` clean for `src/js/services/cache.js`, `src/js/core.js`, `src/js/filepanel/filePanel.js`, and `src/js/viewer/viewerPipelines.js`.
- Unit tests: 85/85 passing (`npm test`), including `BoundedSet` capacity and eviction tests.
- Implementation: `_animMemo` and `animatedSvgSrcs` capped at 512 items; `_stopLivePump` resets `_liveStagingCanvas` dimensions to 0 on exit.
- Runtime note: verified in running app with `npm run tauri dev`.
