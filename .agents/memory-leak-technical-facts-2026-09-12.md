# Memory leak technical facts

Date: 2026-09-12

Purpose: preserve the raw technical findings from the memory leak investigation. This is an agent-facing facts ledger, not a user-facing report and not a priority list.

Related summary report: `.agents/memory-leak-investigation-2026-09-12.md`

## Current working-tree mitigations, 2026-09-13 continuation

These facts describe the latest code state after the user confirmed `npm run tauri dev` still reached about 1.5 GB in the stress run.

- `src/js/fsUtils.js` now exports `ARCHIVE_THUMBNAIL_WINDOW_HALF = 1`.
- `FsUtils.shouldUseArchiveImageThumbnail(item, state, itemIndex)` returns `true` for archive image thumbnails only when `state.mode === 'archive'`, `state.list` exists, `state.index` is finite, and `Math.abs(itemIndex - state.index) <= 1`.
- `FsUtils.buildThumbnailSrc(item, state, itemIndex)` returns a large native icon URL for archive image entries outside that active/neighbor window.
- Composite archive favorites use icon thumbnails when no active archive window exists.
- `filePanel.updateEntry(li, item, index)` passes the visible row index into `buildThumbnailSrc()`.
- `filePanel.updateSelection()` re-renders visible archive thumbnail rows when selection changes without scrolling, so the three-item thumbnail window moves with the active entry.
- `filePanel` no longer stores off-DOM `new Image()` values in `thumbnailCache` or `favoritesThumbnailCache`; thumbnail loads now store warm flags, explicit fallback URLs, or archive blob URLs.
- Archive hover preloading no longer calls `ensureArchiveBlob()` on hover. It only creates a transient `Image()` if the archive blob was already cached by the active/neighbor thumbnail path.
- `viewerRender.js` now uses `VIEWER_IMAGE_POOL_CAPACITY = 4` instead of the previous 10-node pool.
- `viewerRender._trimActiveNodes(allowedSrcs)` recycles any pooled viewer image whose source is outside the current desired set on every state change.
- Viewer desired sources remain: current `state.src`, immediate previous/next image entries from `FsUtils.neighborEntries(..., PRELOAD_HALF = 1)`, and the currently visible outgoing image while the bridge transition exists.
- Viewer transient preload `Image()` objects remove handlers and clear `src` after load or error.
- `ensureArchiveBlob()` still has the small compressed-byte and count budget from the prior mitigation. That guard protects `blob_storage`; it does not cap decoded WebView2 renderer/GPU memory by itself.

## Agreed refactor target, 2026-09-13

This is the accepted design for the next refactor. It is not a description of the current code. The investigation measurements and the working-tree mitigation facts above remain historical evidence until the implementation lands.

### Archive lifetime and materialization

- All archive formats use one active archive session. The current eight-session policy goes away.
- ZIP and CBZ stop retaining extracted entry bytes in the 128 MiB Rust LRU. The archive index remains available for the active session, and no Rust-memory entry-byte cache survives a completed response.
- The active session owns one temporary materialization directory. ZIP, CBZ, RAR, 7Z, and TAR use that directory for requested entries and prefetch output.
- Opening an archive does not decode every page into pixels or extract every entry. The reader serves the selected entry first, then materializes only the next directional entry.
- Switching archives or closing the active archive cancels work, drops the session, and removes its temporary directory. Startup cleanup removes stale QuiviT archive directories left by interrupted runs.
- Temp-origin probing must validate a candidate before it prepares or materializes an archive. It must not create extraction work for every candidate it inspects.
- Header-only animation checks for materialized non-ZIP files must read only the requested header bytes, not the whole entry.

### Directional archive prefetch

- Archive navigation has one speculative work item, not a symmetric window.
- Moving toward later entries queues `+1`. Moving toward earlier entries queues `-1`.
- The selected entry always wins over the speculative item. A direction change or an item leaving the relevant viewport cancels queued speculative work.
- The directional entry writes to the active materialization directory. Without that destination, prefetch would only decompress data and discard it.

### Protocol and archive thumbnails

- Full archive-page protocol responses use `Cache-Control: no-store` (completed 2026-09-13). WebView must not become a second, unbounded archive byte cache after the Rust byte LRU is removed.
- Small native icons and true thumbnail responses retain their existing cache policy.
- The normal file list stays virtualized and keeps its lightweight warm-marker and icon behavior. This remains the large-folder path.
- Archive thumbnail rows are eligible for decoding only while they are visible. A single decode queue prioritizes the selected row, then the nearest visible rows in the active scroll direction.
- The queue starts one decode at a time. Rows that leave the viewport before their turn lose their queued work. Recycled rows release their source and any temporary URL.
- Archive thumbnails do not retain a full-page blob cache after their row leaves the viewport. The queue is a display-lifetime policy, not an offscreen image cache.
- Hover preview is removed (completed 2026-09-13). It must not start or retain speculative image decode work.

### Viewer, filters, and animation

- The viewer pool has two DOM image nodes: the outgoing image and the incoming image during a bridge transition. It does not retain adjacent sources in that pool (completed 2026-09-13).
- The one-entry clean `ImageBitmap` cache, WebGL resource lifetime, and crop-first Lanczos path remain unchanged.
- Animation rendering keeps its existing visual resolution. On exit it stops the frame loop, closes the active frame and decoder, clears the staging canvas, revokes the temporary URL, and releases the related GL source. This changes cleanup only, not image quality.
- Animation-result metadata remains small, but its memo is bounded or cleared on archive and folder changes.
- Native icon and shell thumbnail behavior remains unchanged.

## Reproduction context

The app was already running from normal user activity.

Reported user flow:

- Browse folders.
- Browse archives.
- Jump between folders and archives.
- Toggle thumbnail view on and off.
- Leave the program open afterward.

Observed symptom:

- App memory climbed to roughly 900 MB to 1 GB.
- Memory stayed high while idle.
- Expected budget was roughly 128 MB archive cache plus about 50 MB of normal overhead.

## Process snapshot

The running app process was `tauri-app.exe` launched from:

```text
C:\Users\x4163\Desktop\tauri-app.exe
```

Observed process tree included:

```text
tauri-app.exe
  msedgewebview2.exe browser/root
    msedgewebview2.exe gpu-process
    msedgewebview2.exe renderer
    msedgewebview2.exe utility: network service
    msedgewebview2.exe utility: storage service
    msedgewebview2.exe crashpad handler
```

Private memory observations from the live process:

```text
tauri-app.exe                 ~135.5 MB private, ~158.4 MB working set
msedgewebview2 browser/root   ~815-816 MB private
msedgewebview2 gpu-process    ~621-930 MB private, ~992-1149 MB working set
msedgewebview2 renderer       ~545-632 MB private, ~1140-1641 MB working set
network utility               ~11-12 MB private
storage utility               ~8-9 MB private
```

Interpretation recorded during investigation:

- The Rust host was not the dominant sustained memory owner in this run.
- WebView2 browser/GPU/renderer processes held the large private and working-set memory.
- The process split fits frontend image/blob/decode/GPU retention better than a pure Rust `ArchiveCache` leak.

## WebView2 profile storage snapshot

Profile root:

```text
C:\Users\x4163\AppData\Local\com.x4163.quivit\EBWebView
```

Total measured profile size:

```text
~696.1 MB
```

Top-level profile folder sizes:

```text
Default                      ~645.6 MB
component_crx_cache           ~21.3 MB
Subresource Filter            ~11.3 MB
GrShaderCache                 ~10.0 MB
Speech Recognition             ~2.6 MB
hyphen-data                    ~1.7 MB
BrowserMetrics                 ~1.2 MB
ShaderCache                    ~0.5 MB
```

Important `Default` subfolder breakdown:

```text
blob_storage      ~607.13 MB, 94 files
Code Cache         ~18.35 MB
Cache               ~9.40 MB
GPUCache            ~5.57 MB
Local Storage       ~0.14 MB
IndexedDB           ~0 MB
Session Storage     ~0 MB
```

Blob storage was concentrated in one directory:

```text
Default\blob_storage\a2898860-cc9b-427c-a910-a4eced44e719
~607.13 MB, 94 files
newest write observed at 2026-09-12 2:54:40 PM local time
```

Interpretation recorded during investigation:

- The normal HTTP cache was too small to explain the observed disk profile growth.
- `blob_storage` was large enough to explain most of the WebView profile growth.
- This fact specifically supports object URL / Blob retention as a concrete owner.

## Temp archive storage snapshot

Temp archive root:

```text
%TEMP%\QuiviT
```

Observed temp directories included:

```text
aac2ce516463d46eabf8bd12e5d91ed7  2026-09-12 12:53:43 PM  ~84.1 MB
ca48a0f62bd551f43fc84feacfb67a13  2026-09-12 12:53:42 PM  ~84.1 MB
451a7efb269089c94a3f97cab91813da  2026-09-12 12:53:38 PM  ~84.1 MB
fc3f3ac440efcaae970bbe41a2ad5d94  2026-09-12 12:53:38 PM  ~84.1 MB
458c3845e643034c78d5a0bdda078e91  2026-09-12 12:53:38 PM  ~84.1 MB
4d788de3da313ef90efac2cda6e42973  2026-09-12 12:53:28 PM  ~84.1 MB
46d47ba1134b06327a8b89b97ef98173  2026-09-06 10:31:27 PM   ~2.5 MB
ef35dd1075bc4c556c4a63ca59b18473  2026-09-06 9:21:29 PM    ~2.5 MB
```

Interpretation recorded during investigation:

- Temp extraction state is a real disk-retention issue.
- It did not match the dominant live process memory owner in this run.
- Some temp directories predated the current process lifetime, so stale startup/shutdown cleanup is incomplete or absent.

## Frontend subagent facts

These are pre-mitigation static findings from the first investigation pass. They describe the code as it existed when the leak was first traced.

Agent:

```text
01a0946f-9a89-7d70-8a94-217572410fed
```

Scope:

- Read-only frontend investigation.
- Focused on JS/CSS/HTML ownership boundaries from `.agents/AGENTS.md`.
- Checked DOM nodes, Blob/object URLs, ImageBitmap/WebGL texture/frame-pump lifetimes, thumbnail caches, timers, listeners, and local state growth.

Reported high-confidence facts:

- `src/js/filepanel/filePanel.js:19` exports `THUMB_CACHE_CAPACITY = 250`.
- `src/js/filepanel/filePanel.js:20` creates `thumbnailCache = new BoundedMap(THUMB_CACHE_CAPACITY)`.
- `src/js/services/cache.js:11-16` evicts by entry count only. It has no size, byte, decoded-pixel, or destructor hook.
- `src/js/filepanel/filePanel.js:23-29` monkey-patches `thumbnailCache.set()` to revoke blob URL values only when eviction happens through `set()`.
- `src/js/filepanel/filePanel.js:1327` calls `thumbnailCache.clear()`, bypassing that revocation path.
- `src/js/filepanel/filePanel.js:34` creates `_archiveBlobPromises = new Map()` for in-flight archive blob fetch dedupe.
- `src/js/filepanel/filePanel.js:35-61` `ensureArchiveBlob(src)` fetches `src`, calls `resp.blob()`, creates `URL.createObjectURL(blob)`, and stores the blob URL in `thumbnailCache`.
- `src/js/fsUtils.js:181-203` `buildThumbnailSrc(item, state)` returns `/archive/` URLs for archive images and original `asset://` URLs for disk images that are not in `SHELL_THUMBNAIL_EXTS`.
- `src/js/fsUtils.js:195-198` uses `/thumb/` only for `SHELL_THUMBNAIL_EXTS`; otherwise it falls back to `buildFileSrcSync(item.path)`.
- `src/js/fsUtils.js:240-242` `buildFileSrcSync()` delegates to `window.__TAURI__.core.convertFileSrc(filePath)`.
- `src/js/filepanel/filePanel.js:898-917` thumbnail row `thumbImg.onload` can create a retaining `new Image()` and store it in `thumbnailCache`.
- `src/js/filepanel/filePanel.js:905-907` archive thumbnail loads call `ensureArchiveBlob(src)` instead of storing a `new Image()` retainer.
- `src/js/filepanel/filePanel.js:1088` active thumbnail rows call `ensureArchiveBlob(targetSrc)` for archive entries.
- `src/js/filepanel/filePanel.js:1244` `commitPendingThumbnails()` also calls `ensureArchiveBlob(targetSrc)` for active archive thumbnails.
- `src/js/filepanel/filePanel.js:829-838` hover preload calls `ensureArchiveBlob(src)` and then creates a separate `Image()` from the returned blob URL if the hover is still relevant.
- `src/js/viewer/viewerRender.js:3` imports `thumbnailCache` and `ensureArchiveBlob()` from `filePanel.js`.
- `src/js/viewer/viewerRender.js:378-389` viewer activation uses cached blob URLs from `thumbnailCache` and calls `ensureArchiveBlob(state.src)` for archive sources.
- `src/js/viewer/viewerRender.js:258-278` neighbor preloads use `thumbnailCache` blob URLs when present, then create transient `Image()` preloaders.
- `src/js/filepanel/filePanel.js:958-969` `initDomPool()` removes active/free rows on view-mode changes without first clearing thumbnail image `src`s.
- `src/js/filepanel/filePanel.js:65` creates `favoritesThumbnailCache`, also count-bound.
- `src/js/filepanel/filePanel.js:498-508` favorites thumbnail load can retain `new Image()` values in `favoritesThumbnailCache`.
- Before the 2026-09-13 Lanczos mitigation, `src/js/shared/blobImage.js:6-7` created a separate `TEXTURE_CACHE_CAPACITY = 6` `BoundedMap`.
- `src/js/shared/blobImage.js:12-14` evicts `blobUrl` and `cleanImg.close()` correctly when `_textureCache.set()` evicts.
- `src/js/shared/blobImage.js:27-48` `getCleanImage()` fetches source bytes, creates an object URL, creates an `ImageBitmap`, and caches `{ blobUrl, cleanImg }`.
- `src/js/shared/blobImage.js` has no exported debug/trim/clear method.
- `src/js/viewer/viewerPipelines.js:320` creates a blob URL for SVG live pump.
- `src/js/viewer/viewerPipelines.js:280`, `441`, `446`, `513`, `520`, and `551` contain cleanup paths for live pump images, decoders, and frames.
- `core.js` `_animMemo` and `filePanel.js:77` `animatedSvgSrcs` are unbounded, but entries are expected to be small.

Suggested frontend confirmations:

- Heap snapshot showing `HTMLImageElement` values retained by `thumbnailCache`.
- Blob URL create/revoke monkey patch showing created URLs exceed revoked URLs.
- Network panel showing `/archive/...` requests for thumbnail rows.
- Memory drop after clearing `thumbnailCache`, blanking thumbnail `src`s, and forcing GC.
- Memory growth only when filters or Lanczos are active would implicate `blobImage.js`.

## Backend subagent facts

Agent:

```text
01a0946f-b042-77e2-ba9a-43694a3ff60e
```

Scope:

- Read-only backend investigation.
- Focused on `src-tauri`, especially archives, protocol, temp extraction, config, and platform code.

Reported backend facts:

- Local config has `archive_cache_mb: null`.
- `src-tauri/src/lib.rs:29` therefore uses the code default archive cache size of `128 MB`.
- `src-tauri/src/archives/cache.rs:14` defines ZIP entry bytes as `SharedEntryBytes = Arc<[u8]>`.
- `src-tauri/src/archives/mod.rs:87-89` `ArchiveEntryData::wait_for_data()` converts ready `Arc<[u8]>` to `Vec<u8>`.
- `src-tauri/src/protocol.rs:177-187` cached ZIP protocol responses call `entry_response(entry_name, &data, range_header)`.
- `src-tauri/src/protocol.rs:203-226` `entry_response()` clones full response bodies with `data.to_vec()` for non-range responses.
- `src-tauri/src/protocol.rs:205-214` range responses clone the requested byte range into a new `Vec<u8>`.
- Cold ZIP paths can temporarily hold extracted bytes, cached bytes, wait bytes, and response bytes.
- `src-tauri/src/archives/cache.rs:97` tracks `current_zip_bytes`.
- `src-tauri/src/archives/cache.rs:103` stores `global_zip_capacity_bytes`.
- `src-tauri/src/archives/cache.rs:104` stores `max_open_archives`.
- `src-tauri/src/archives/cache.rs:117` sets `max_open_archives: 8`.
- `ArchiveCache` byte accounting covers ZIP entry bytes, not all archive metadata, open handles, passwords, index maps, or temp extraction state.
- Oversized ZIP entries can exceed the configured budget after evicting everything else. Existing tests lock in that behavior.
- `src-tauri/src/archives/cache.rs:219-242` evicts ZIP entries until `current_zip_bytes + incoming_bytes <= global_zip_capacity_bytes`, but stops if the LRU is empty.
- `src-tauri/src/archives/cache.rs:280-312` inserts ZIP entry bytes and increments `current_zip_bytes`.
- `src-tauri/src/archives/cache.rs:347-349` computes temp archive dirs as `%TEMP%\QuiviT\<md5(archive_path)>`.
- `src-tauri/src/archives/cache.rs:84-90` removes temp dirs in `Drop for SingleArchiveCache`.
- Ordinary archive navigation may keep non-current temp extraction state until cache eviction or explicit drop.
- `src-tauri/src/platform/temp_archive.rs:1318` calls `cache.prepare_archive(&cand_str, None)` while resolving temp origins.
- `src-tauri/src/archives/mod.rs:263-276` non-ZIP `read_temp_entry_header()` calls `read_temp_entry_bytes()` and then `data.wait_for_data(entry_name)?`, so it can read the full extracted file before slicing.
- `src-tauri/src/commands/animation.rs` uses archive header reads for `check_is_animated`.
- Native icon cache is static and probably too small to explain 1 GB.
- Config/state and watcher paths appeared bounded.

Suggested backend confirmations:

- Instrument `entry_response()` body sizes and compare Rust private memory during large page loads.
- Log current ZIP bytes, archive count, and oversized entry behavior.
- Watch `%TEMP%\QuiviT` while opening and leaving RAR/7Z/TAR archives.
- Log temp-origin resolver candidate count and `prepare_archive()` calls.
- Trace non-ZIP animation header checks on large files to confirm whether full entries are read.

## Main-agent code facts

Files inspected directly during the main pass:

```text
src/js/filepanel/filePanel.js
src/js/fsUtils.js
src/js/viewer/viewerRender.js
src/js/viewer/viewerPipelines.js
src/js/shared/blobImage.js
src/js/services/pipelines/glRuntime.js
src/js/services/scaling/lanczos.js
src/js/services/cache.js
src-tauri/src/lib.rs
src-tauri/src/protocol.rs
src-tauri/src/archives/mod.rs
src-tauri/src/archives/cache.rs
src-tauri/src/config.rs
src-tauri/src/models.rs
```

Confirmed code facts:

These facts are pre-mitigation unless explicitly marked as a 2026-09-13 implementation fact.

- `src/js/services/cache.js` `BoundedMap` only evicts by entry count.
- `filePanel.js` wraps `thumbnailCache.set()` to revoke blob URL values on eviction.
- `thumbnailCache.clear()` is called in `setRefreshingVisual(true)` and does not revoke blob URLs.
- `ensureArchiveBlob()` stores blob URLs in `thumbnailCache` under the original archive URL key.
- `ensureArchiveBlob()` returns an existing cached blob URL if one exists.
- `ensureArchiveBlob()` uses `_archiveBlobPromises` to deduplicate in-flight fetches.
- `_archiveBlobPromises` deletes entries on success and catch paths.
- `viewerRender.js` imports `thumbnailCache` and `ensureArchiveBlob()` from `filePanel.js`.
- `viewerRender.js` calls `ensureArchiveBlob(state.src)` for archive viewer sources even when painting the original `/archive/` URL immediately.
- `viewerRender.js` uses cached blob URLs from `thumbnailCache` for later viewer loads.
- `viewerRender.js` keeps a DOM image pool with `POOL_SIZE = 10`.
- `viewerRender.js` recycles `_activeNodes` only when `_activeNodes.size > POOL_SIZE`.
- Main pass refinement: because recycling happens before adding desired sources, `_activeNodes` can exceed the cap until the next state change, but this looks bounded rather than runaway.
- Before the 2026-09-13 Lanczos mitigation, `blobImage.js` kept a `TEXTURE_CACHE_CAPACITY = 6` `BoundedMap`.
- `blobImage.js` revokes blob URLs and closes `ImageBitmap`s when evicting entries.
- `blobImage.js` has no exported clear/trim method.
- `protocol.rs` sets `Cache-Control: public, max-age=86400` on PNG icon/thumbnail responses and archive entry responses.
- Main pass refinement: after the WebView2 profile breakdown, normal HTTP cache was only about 9 MB, so protocol cache headers were not the main observed disk owner.

## Object URL ownership model observed in pre-mitigation code

Owner map from the first source inspection:

```text
filePanel.thumbnailCache
  key: original src, often /archive/<encodedArchive>/<entry> or asset://...
  value shapes:
    true                       lightweight warm flag
    string blob:...            full archive Blob object URL from ensureArchiveBlob()
    string asset/quivit URL    fallback URL for icons/direct src
    HTMLImageElement           decoded retainer created with new Image()

filePanel.favoritesThumbnailCache
  key/value shapes mirror thumbnailCache for favorites

blobImage._textureCache
  key: source URL passed to getCleanImage()
  value: { blobUrl, cleanImg: ImageBitmap }
  capacity: 6 entries
  destructor on set-eviction: URL.revokeObjectURL(blobUrl), cleanImg.close()

viewerRender._activeNodes
  key: logical pool src
  value: live or pooled .viewer-img HTMLImageElement
  nominal pool size: 10
  actual count can exceed 10 until the next state change because recycle runs before adding desired sources
```

Known destructor gaps:

```text
thumbnailCache.clear()
  Called at filePanel.js:1327.
  Does not call URL.revokeObjectURL() for blob string values.
  Does not clear HTMLImageElement.src for retained Image objects.

favoritesThumbnailCache
  No custom eviction destructor was observed during this pass.
  Retained Image values can be evicted by BoundedMap.delete without clearing src.

initDomPool()
  Removes pooled row elements during view-mode changes.
  Does not clear row thumbImg.src before remove().
```

Potential false lead corrected during main pass:

```text
protocol.rs Cache-Control
  Static scan: archive responses are cacheable for one day.
  Live profile: Default\Cache was only ~9.40 MB.
  Current conclusion: not the observed 607 MB profile owner. Blob storage is.
```

## Full archive thumbnail path

Observed path for archive thumbnails and active archive image warmup:

```text
FsUtils.buildThumbnailSrc(item, state)
  state.mode === 'archive'
  item.path is not absolute
  returns FsUtils.buildArchiveSrc(state.archivePath, item.name)

filePanel.updateEntry()
  targetSrc is /archive/...
  active row sets thumbImg.src = targetSrc
  active row calls ensureArchiveBlob(targetSrc)

filePanel.thumbImg.onload()
  sees src includes /archive/
  calls ensureArchiveBlob(src)

viewerRender loadTarget()
  state.src includes /archive/
  calls ensureArchiveBlob(state.src)
  still paints original /archive/ immediately unless a cached blob URL already exists

ensureArchiveBlob(src)
  fetch(src)
  resp.blob()
  URL.createObjectURL(blob)
  thumbnailCache.set(src, blobUrl)
```

Rust side of the same path:

```text
protocol.rs custom protocol handler
  parse_archive_url()
  try_cached_entry_response()
  if cache hit: entry_response(entry_name, &Arc<[u8]>, range)
  if miss: spawn_blocking, cache.read_entry_bytes(), wait_for_data(), entry_response()

entry_response()
  non-range response body is data.to_vec()
  range response body is data[range].to_vec()
```

This path can create all of these for one archive page:

```text
Rust cached Arc<[u8]> or extracted temp bytes
Rust response Vec<u8>
WebView response body/blob bytes
Blob storage file under Default\blob_storage
blob: object URL
HTMLImageElement decoded image for thumbnail/viewer/preload
GPU texture/backing memory for renderer/compositor
```

## Disk image thumbnail path

Observed path for disk images:

```text
FsUtils.buildThumbnailSrc(item, state)
  if extension in SHELL_THUMBNAIL_EXTS:
    returns /thumb/<encodedPath>
  else:
    returns convertFileSrc(item.path)
```

`SHELL_THUMBNAIL_EXTS` from `fsUtils.js`:

```text
jpg, jpeg, png, bmp, dib, gif, ico
```

Formats that can bypass shell thumbnails and use the original file as thumbnail:

```text
webp, apng, avif, svg
```

Technical implication:

- Thumbnail view for those disk formats can decode full originals.
- This does not explain the measured `blob_storage` by itself unless another path converts them to Blob/object URLs, but it can explain renderer/GPU decoded image pressure.

## WebGL/Lanczos memory path

Observed path:

```text
viewerPipelines._triggerRender()
  uses createLanczosPipeline() for still Lanczos
  uses createGlRuntime() for filters and animated Lanczos

glRuntime.render()
  getCleanImage(imgElement.src)
  upload ImageBitmap/element to WebGL texture via texImage2D()

lanczos.render()
  getCleanImage(sourceImg.src)
  draws crop into _srcCanvas
  pica.resize(_srcCanvas, _destCanvas)
```

Cache facts:

```text
blobImage.TEXTURE_CACHE_CAPACITY = 6 at the time of the first investigation
_textureCache values include an object URL and an ImageBitmap
eviction closes ImageBitmap and revokes object URL
cache is count-bound, not byte-bound
there is no exported clear method
```

Technical implication:

- Six large images can exceed the intended memory envelope even without a leak.
- This path is more likely if the user had filters or Lanczos active during the reproduction.
- It is not the best explanation for the 607 MB `blob_storage` unless `getCleanImage()` source churn produced retained blob URLs that had not yet been evicted or GC'd.

## Viewer pool memory path

Observed path:

```text
viewerRender._activeNodes = new Map()
POOL_SIZE = 10

on Core state change:
  desiredSrcs = current state.src
  desiredSrcs += current visible img.dataset.poolSrc
  desiredSrcs += neighborEntries(..., PRELOAD_HALF = 1)

  if _activeNodes.size > POOL_SIZE:
    recycle entries not in desiredSrcs until size <= POOL_SIZE

  for desiredSrcs:
    _getPoolNode(src)
```

Main-agent refinement:

- Static scan made this look unbounded.
- Full pass shows it is more likely bounded but loose.
- Since recycling happens before adding new desired nodes, `_activeNodes` can exceed `POOL_SIZE` after additions and remain high until another state change.
- It should not grow without bound if navigation continues, but 10-plus decoded pages is still too large for a strict memory budget.

Technical implication:

- Treat as a bounded decoded-image pressure source.
- Do not treat it as the primary explanation for 94 blob files in `Default\blob_storage`.

## Backend temp extraction path

Observed path:

```text
ArchiveCache::prepare_archive()
  RAR/7Z/TAR create or reuse temp extraction state
  archive_temp_dir(archive_path) = %TEMP%\QuiviT\<md5>

SingleArchiveCache::drop()
  sets extract_cancel
  remove_dir_all(extract_temp_dir)

ArchiveCache::register_archive()
  archives.insert()
  touch_archive()
  evict_idle_archives()

evict_idle_archives()
  while archives.len() > max_open_archives
  removes old archive, which triggers SingleArchiveCache::drop()
```

Technical implication:

- Up to eight non-ZIP temp extraction trees can be retained by design.
- Stale dirs across sessions indicate missing startup cleanup, shutdown cleanup failure, or previous crashes.
- This is a disk leak / disk pressure issue first. It becomes memory pressure only through active extraction, file reads, and WebView loading extracted files.

## Recommended instrumentation points

Frontend console patch for Blob lifecycle:

```js
(() => {
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  const live = new Set();
  URL.createObjectURL = (blob) => {
    const url = create(blob);
    live.add(url);
    console.log('[blob:create]', live.size, blob?.size, url);
    return url;
  };
  URL.revokeObjectURL = (url) => {
    live.delete(url);
    console.log('[blob:revoke]', live.size, url);
    return revoke(url);
  };
  window.__quivitBlobDebug = { live };
})();
```

Frontend cache shape probe:

```js
import('/js/filepanel/filePanel.js').then((m) => {
  const entries = [...m.thumbnailCache.entries()].map(([key, value]) => ({
    key,
    valueType: value?.constructor?.name || typeof value,
    isBlobUrl: typeof value === 'string' && value.startsWith('blob:'),
    isArchiveKey: key.includes('/archive/'),
  }));
  console.table(entries);
});
```

WebView profile probe:

```powershell
$default = Join-Path $env:LOCALAPPDATA 'com.x4163.quivit\EBWebView\Default'
foreach ($name in @('blob_storage','Cache','Code Cache','GPUCache','Local Storage','IndexedDB','Session Storage')) {
  $p = Join-Path $default $name
  if (Test-Path $p) {
    $files = @(Get-ChildItem -Force -Recurse -LiteralPath $p -File -ErrorAction SilentlyContinue)
    $sum = ($files | Measure-Object Length -Sum).Sum
    [pscustomobject]@{ Name=$name; MB=[math]::Round($sum/1MB,2); Files=$files.Count }
  }
}
```

Process memory probe:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match 'tauri-app|msedgewebview2' -or $_.CommandLine -match 'com.x4163.quivit' } |
  Select-Object ProcessId,ParentProcessId,Name,
    @{n='PrivateMB';e={[math]::Round($_.PrivatePageCount/1MB,1)}},
    @{n='WorkingSetMB';e={[math]::Round($_.WorkingSetSize/1MB,1)}},
    CommandLine
```

Backend instrumentation points for a future debug slice:

```text
protocol.rs
  entry_response(): log entry_name, data.len(), range header, response status.
  try_cached_entry_response(): log cache hit/miss and entry len.

archives/cache.rs
  insert_zip_entry(): log incoming len, current_zip_bytes before/after, global_zip_capacity_bytes.
  evict_until_within_budget(): log each evicted (archive, entry, bytes).
  register_archive(): log archives.len(), archive path, kind if available.
  drop_archive(): log explicit drops.
  SingleArchiveCache::drop(): log temp dir removal success/failure.

platform/temp_archive.rs
  temp-origin resolver around cache.prepare_archive(&cand_str, None): log candidate count and chosen match.
```

## Agent implementation constraints inferred from facts

- Fixing `thumbnailCache.clear()` must revoke blob URLs before clearing.
- If retaining `HTMLImageElement` values is removed, tests that expect warm thumbnail reuse may need to assert warm flags or URL reuse instead of decoded retainers.
- If archive thumbnails stop using full `/archive/` URLs, `fsUtils.buildThumbnailSrc()` will need a new backend route or frontend thumbnail generation path.
- A new archive thumbnail route should not reuse the full archive image protocol response shape if the goal is memory reduction.
- Any byte-aware cache should count Blob sizes and estimated decoded pixel bytes separately. Compressed bytes alone are not enough.
- Viewer/filepanel ownership is currently crossed by `viewerRender.js` importing from `filePanel.js`. A fix may need a small shared cache/service module to avoid deepening that coupling.
- Changes to protocol URL shape, archive IPC, cache accounting, or cross-window state trigger blast-radius review per `.agents/AGENTS.md`.

## Consolidated interpretation facts

Facts that agree across sources:

- Archive thumbnails currently use full image bytes.
- Full archive image blob URLs are retained in frontend state.
- The observed live memory sits mainly in WebView2, not Rust.
- The WebView2 profile contains a large `blob_storage` directory.
- Rust protocol cloning can amplify transient memory pressure during blob creation.
- Non-ZIP temp extraction creates real disk retention and cleanup work.

Facts from the 2026-09-13 thumbnail-off follow-up probe:

- Thumbnail view was off and Lanczos scaling was active.
- `Default\blob_storage` was small at about 11.45 MB across 3 files.
- Normal HTTP `Cache` stayed flat at about 9.40 MB.
- The large live owners were still WebView2 renderer and GPU private memory.
- The Rust host stayed near the previous baseline and was not the owner of the 1 GB-class memory in that run.
- This separates the later 1 GB-class memory pressure from the earlier blob-storage leak.
- The active lead for that run is decoded current-page image memory plus Lanczos intermediate/native/GPU allocations.

Facts that changed priority after live probing:

- Protocol `Cache-Control` looked suspicious from static code, but normal HTTP cache was only about 9 MB in the observed profile.
- Blob/object URL storage became the concrete lead after measuring `Default\blob_storage` at about 607 MB.
- Viewer DOM pool looked suspicious from static code, but main-agent review suggests bounded retention rather than unbounded leak.
- Rust archive cache was expected at 128 MB, and the live Rust host stayed around 135 MB private, so it was not the main sustained 1 GB owner in this run.
- After the thumbnail-off follow-up probe, Lanczos moved from a secondary/static suspect to an active mitigation target because blob storage was no longer large.

Implementation facts from the 2026-09-13 mitigation pass:

- `viewerRender.js` no longer preloads archive neighbors. The previous/next preload path still applies outside archive mode.
- `viewerRender.js` no longer calls `ensureArchiveBlob()` for the active viewer archive image. It only reuses an existing cached thumbnail blob if one is already present.
- `blobImage.js` exports `TEXTURE_CACHE_CAPACITY = 1`.
- `blobImage.js` no longer creates object URLs for the clean image cache.
- `blobImage.js` exposes `getCleanImageCrop(src, sx, sy, sw, sh)`, which returns a caller-owned cropped `ImageBitmap`.
- `lanczos.js` uses `getCleanImageCrop()` for the visible crop and closes that cropped bitmap after the resize path completes.
- `lanczos.js` tracks render generation so an older async crop/resize cannot return after a newer render starts.
- `blobImage.test.mjs` covers the reduced clean image cache capacity, eviction close behavior, cache reuse, and crop-bitmap ownership.

## Open factual questions

- How many object URLs are created and revoked during a thumbnail/archive browsing session?
- Does `thumbnailCache.clear()` account for most unreclaimed Blob storage, or are active cache entries themselves too large even when revocation works?
- Does WebView2 release `blob_storage` files promptly after `URL.revokeObjectURL`, or only after GC/navigation/process exit?
- How much memory drops after clearing thumbnail cache, blanking visible thumbnail images, and forcing GC?
- How much memory is retained by `ImageBitmap`s when filters or Lanczos are active?
- After the cropped Lanczos mitigation, how much renderer/GPU memory remains attributable to the current visible page itself?
- Do stale `%TEMP%\QuiviT` directories survive a clean app shutdown?
- Does temp-origin resolution create extraction dirs for wrong candidates in ordinary external-open flows?
- Are full archive thumbnails acceptable at all, or does the app need a real resized thumbnail protocol to meet the release memory budget?

## Commands run during investigation

Representative commands and probes:

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'QuiviT|tauri-app|msedgewebview2|WebView2' -or $_.CommandLine -match 'QuiviT|tauri-app|quivit|src-tauri' }
Get-Process -Id 29368,13504,15356,25540,7256,24448
Get-ChildItem -Force -Recurse -LiteralPath "$env:LOCALAPPDATA\com.x4163.quivit\EBWebView"
Get-ChildItem -Force -Directory -LiteralPath "$env:TEMP\QuiviT"
rg -n "createObjectURL|revokeObjectURL|ImageBitmap|createImageBitmap|new Image\(|Map\(|BoundedMap|canvas|getContext\(|texImage2D|createTexture|deleteTexture|requestAnimationFrame|setInterval|setTimeout|Cache-Control" src src-tauri/src
```

No implementation changes were made during this investigation. The only files added were investigation documents under `.agents/`.
