# Memory leak investigation

Date: 2026-09-12

Status: investigation completed (2026-09-13). The next archive/resource refactor is agreed but not implemented.

Latest synthesis: the first leak cause was frontend-created Blob/object URL retention from full archive images. WebView2 `Default\blob_storage` held about 607 MB in one directory with 94 files, while the normal HTTP `Cache` directory was only about 9 MB. Suspect 1 resolves stale blob retention by revoking blob URLs on eviction, deletion, and refresh clears, protecting the active viewer blob, and cancelling in-flight requests. A later limit test showed the next problem: even with blob storage controlled, WebView2 renderer/GPU memory can stay high from decoded full-page images. Suspects 2 and 3 mitigate thumbnail/viewer image retention. A later dev-run probe with thumbnail view off showed `blob_storage` stayed small, while renderer/GPU memory still climbed with Lanczos active; Suspect 4 is now mitigated in code by eliminating archive neighbor preloads, avoiding viewer-side archive blob warmup, shrinking the clean image cache, and cropping before Lanczos resize.

## Context

During normal app use, QuiviT climbed to roughly 900 MB to 1 GB and stayed there after browsing between folders and archives while toggling thumbnail view. The intended steady-state budget is much lower: Rust archive cache default is 128 MB, with roughly another 50 MB expected for normal frontend/runtime overhead.

This report consolidates the main-agent live probes plus the two read-only subagent investigations:

- Frontend investigation: `01a0946f-9a89-7d70-8a94-217572410fed`
- Backend investigation: `01a0946f-b042-77e2-ba9a-43694a3ff60e`

## Agreed refactor target

This section records the accepted follow-up design. It does not alter the historical evidence below. The detailed contract lives in `.agents/memory-leak-technical-facts-2026-09-12.md` under "Agreed refactor target, 2026-09-13".

- Keep one active archive session across ZIP, CBZ, RAR, 7Z, and TAR. Remove the eight-session archive retention policy and the 128 MiB ZIP/CBZ entry-byte LRU.
- Materialize the selected archive entry and one directionally adjacent entry into the active session's temporary directory. Do not decode every page when an archive opens.
- Replace symmetric archive prefetch with one direction-aware item: `+1` while moving forward and `-1` while moving backward. Cancel stale queued work.
- Mark full archive-page responses `no-store`; retain the existing long-lived policy only for small icons and true thumbnails (completed 2026-09-13).
- Decode archive thumbnail rows only while visible, through a one-at-a-time queue. Do not retain full-page blobs after a row leaves the viewport. Remove hover preview (completed 2026-09-13).
- Reduce the viewer bridge to two DOM image nodes. Preserve the current one-entry filter source cache and crop-first Lanczos behavior.
- Keep animated-file quality unchanged. Make exit cleanup explicit for its frame loop, decoder, staging canvas, object URL, and GL source.
- Bound or clear animation-result metadata on archive and folder changes. Keep shell thumbnails and native icons unchanged.

The refactor does not update `.agents/architecture-state.md`. That document will be updated separately after implementation.

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

Status: mitigated in code, pending battle-test verification.

Files:

- `src/js/filepanel/filePanel.js`
- `src/js/fsUtils.js`

Resolution:

- Archive thumbnail view now loads full `/archive/` image URLs only for the active entry and its immediate previous/next image entries.
- Archive thumbnail rows outside that moving three-item window use lightweight extension icons.
- `ensureArchiveBlob()` refuses oversized blob entries and trims cached archive blobs by both count and compressed-byte budget.
- Hover preload follows the same archive thumbnail window and no longer starts archive blob fetches on hover. It only reuses an already-cached nearby blob.
- Thumbnail caches no longer store off-DOM `new Image()` retainers for ordinary image thumbnails or favorites.
- The viewer still loads full archive images through the normal reader path. This fix targets the side-panel thumbnail cache, not image fidelity in the reader.

Mechanism:

- `thumbnailCache` is bounded by item count (`250`), not by bytes.
- Disk WebP, AVIF, APNG, SVG, and archive thumbnail paths can use original image URLs instead of a resized thumbnail route.
- Before the 2026-09-13 mitigation, `filePanel.js` could store retained `new Image()` objects in `thumbnailCache` for loaded thumbnails.
- A 250-item cache is small for icon URLs but huge for decoded full-resolution pages.
- One nuance from the main pass: `thumbImg.onload` is overwritten in the non-image branch and not restored for later image reuse. That bug may make the decoded-image retainer inconsistent rather than universal, but when it does run, it retains exactly the wrong thing.

Why this matches the report:

- User action included enabling/disabling thumbnail view.
- Live memory sits in WebView2 renderer/GPU processes.
- The earlier code could retain decoded browser image objects beyond visible rows.

Runtime confirmation:

- Heap snapshot should no longer show many `HTMLImageElement` objects retained by `thumbnailCache`.
- In archive thumbnail view, `/archive/` thumbnail URLs should appear only for the active item and its two neighbors. Other archive image rows should use icon URLs.
- Moving through an archive should not steadily increase decoded thumbnail count beyond the active/neighbor window.

Likely fix direction:

- Stop storing `new Image()` objects in thumbnail caches.
- Cache only lightweight warm flags or explicit thumbnail-sized blob URLs.
- Add a byte-aware or mode-aware thumbnail cache policy.
- Prefer a real resized thumbnail route for archive/disk thumbnails instead of original image URLs.

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

- Only one archive session and one materialization directory exist while browsing across archive formats.
- ZIP/CBZ entry bytes do not remain in a Rust byte LRU after a protocol response completes.
- Navigation produces only the selected entry plus one directionally adjacent materialization request.
- Archive thumbnail scrolling starts one decode at a time and cancels rows that leave the viewport before decoding.
- Archive-page responses do not accumulate in the WebView HTTP cache, while icons and true thumbnails still load from their intended cache path.
- Rapid reader navigation preserves the two-node transition without blank frames or a visible bridge glitch.
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
