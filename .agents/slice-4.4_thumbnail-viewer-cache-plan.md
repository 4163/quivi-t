# Slice 4.4: Thumbnail Polish and Main Viewer Cache Integration

## Goal

Polish thumbnail edge cases from Slice 4.3 and connect the main image viewer to the shared cache architecture to eliminate redundant network fetches and accelerate archive navigation.

## Review of Preceding Work

Slice 4.3 delivered virtualized thumbnail row recycling (Slice 4.3.1) and Windows Shell native thumbnail extraction (Slice 4.3.2).

Slice 4.3.3 attempted backend CPU downscaling for archive entries via `/archive-thumb/`. Runtime testing showed a severe regression where loading 50 to 100 comic pages took up to 30 seconds due to CPU-bound decoding and PNG re-encoding. Slice 4.3.3 was abandoned and reverted. Direct compressed streaming via `quivit://archive/` to WebView2 remains the primary delivery path, with GPU-accelerated SIMD decoding handled by Chromium.

Slice 4.4 builds on these lessons with targeted optimizations.

---

## Scope of Work

### 1. Animated vs Static GIF Thumbnails
- **Issue**: Windows Shell `IShellItemImageFactory::GetImage` extracts only a static first frame as a 96×96 PNG. Animated GIFs under `test-files\gif` show frozen previews in the file panel. However, static (single-frame) GIFs do not need to serve full files; they should continue using the fast, pre-rendered shell thumbnail.
- **Change**:
  - In `src-tauri/src/platform/thumbnails.rs`, when processing a `.gif` file:
    - Call `crate::formats::check_animation_status` on the file header.
    - If `is_animated` is true: return `Ok(None)`.
    - If static: proceed with shell thumbnail extraction and return the cached 96×96 PNG.
  - When `Ok(None)` is returned for an animated GIF, the frontend two-tier `onerror` handler in `filePanel.js` automatically falls back to `buildFileSrcSync(item.path)` (`asset://`), playing animations natively.
  - `SHELL_THUMBNAIL_EXTS` retains `'gif'` so static GIFs benefit from shell caching while animated GIFs fall back to full animation.

### 2. Transparent Thumbnails with Black Matte (PNG, GIF, and ICO)
- **Issue**: Some Windows Shell thumbnails for transparent PNGs, transparent static GIFs, and 32bpp ICOs composite against an opaque black matte background (RGB 0,0,0 with alpha 255) instead of preserving transparency. However, many transparent images produce healthy transparent thumbnails from Windows Shell with valid alpha channels. We must only fall back for broken thumbnails, preserving shell thumbnail performance for healthy ones.
- **Change**:
  - In `src-tauri/src/platform/thumbnails.rs`, after extracting the thumbnail bitmap from Windows Shell:
    - Check if the source image has transparency:
      - For PNG: check for color type 4 or 6 in `IHDR`, or a `tRNS` palette chunk.
      - For GIF: check if the Graphic Control Extension has the transparent color flag set (`flags & 0x01 != 0`).
      - For ICO: check directory entry `bpp==32` (e.g. `test-files/endfield.ico` 6×32bpp) via `ico_has_alpha`.
    - If the source image is transparent, inspect the extracted thumbnail pixel buffer.
    - If the extracted thumbnail contains valid transparent pixels (any pixel with `alpha < 255`), the thumbnail is healthy: serve the shell thumbnail directly.
    - If the source image has transparency but the extracted thumbnail has zero transparent pixels (every pixel has `alpha == 255` and the background was flattened to black matte), the thumbnail is broken: return `Ok(None)`.
  - When `Ok(None)` is returned for a broken thumbnail, the frontend two-tier `onerror` handler in `filePanel.js` automatically falls back to full file (`buildFileSrcSync` `asset://` for disk `ico`/`png`, `quivit://archive/` for archive `ico`), letting Chromium render the original image with true alpha transparency. Disk `ico` shell thumb is `http://quivit.localhost/thumb/` 96px; archive `ico` never uses shell thumb — it serves `quivit://archive/...` full file directly.

### 3. Animated vs Static SVG Handling and Cleanup of Commit c69bbb7
- **Issue**: Static SVGs render cleanly, scale losslessly, and have no SMIL timeline to freeze. Only animated SVGs suffer from Chromium's SMIL timeline freeze bug when rows unmount or scroll out under `loading="lazy"`. Commit `c69bbb7` introduced fragile hacks (`isDiskSvgTarget`, branching `loading="eager"`, loading attribute manipulation on recycling, DOM display reordering) across all disk SVGs.
- **Change**:
  - Detect animated SVGs using our existing detection system (`check_animation_status` / `Core.checkIsAnimated`).
  - Static SVGs: served directly via vector URL without rasterization.
  - Animated SVGs: rasterized to thumbnail dimensions (48×48 or 96×96) via an offscreen canvas/image helper (`src/js/services/rasterizeSvg.js`), avoiding the frozen SMIL timeline in recycled rows.
  - Clean up the SMIL freeze workaround hacks (`isDiskSvgTarget`, `isSvgSrc`, and eager-loading branches) in `src/js/filepanel/filePanel.js`.
  - Document commit `c69bbb7` in code comments for reference.

### 4. Main Viewer Cache Integration (Eliminating Redundant Network Requests)
- **Issue**: Navigating backward by even a single image triggers duplicate network requests over custom schemes (`asset://localhost/...` or `quivit://archive/...`). For standalone disk files that are already sitting on the filesystem, redundant protocol round-trips occur on every keystroke.
  - **Root Causes**:
    1. **Preloader Garbage Collection**: `_schedulePoolPreloads` in `viewerRender.js` discards `Image` references immediately in `onload` (`_preloadImages.splice`), and `_clearScheduledPreloads()` revokes `src` on every navigation step.
    2. **Single-Item Texture Cache in `blobImage.js`**: When scaling or filters are active (Lanczos, WebGL, Anime4K), `getCleanImage(src)` is called for texture uploads. `blobImage.js` maintains a cache size of only 1 (`_cachedSrc`). Navigating to the next image calls `evictBlobCache()`, immediately closing the `ImageBitmap` and revoking the blob URL. Stepping back 1 image forces a duplicate `fetch(src)` network call.
    3. **Missing Cache-Control Headers**: `entry_response` in `src-tauri/src/protocol.rs` serves `quivit://archive/` entries without `Cache-Control` headers, preventing WebView2 from satisfying repeated requests from memory or disk cache.
    4. **DOM Pool Src Stripping**: `_getPoolNode` calls `el.removeAttribute('src')` on recycled nodes, forcing a fresh load cycle upon reassignment.
- **Change**:
  - **Viewer Image Cache (`viewerRender.js`)**:
    - Import `BoundedMap` from `src/js/services/cache.js`.
    - Define explicit named constant `const VIEWER_IMAGE_CACHE_CAPACITY = 12;`.
    - Sizing rationale: at 2000×3000 resolution (6 megapixels = 24 MB uncompressed RGBA per image), 12 images consume ~288 MB RAM. A capacity of 50 would consume 1.2 GB, risking memory bloat. 12 covers 5 to 6 steps in either direction for instant scrubbing.
    - Preloaders in `_schedulePoolPreloads` populate `viewerImageCache`. Completed preloaders remain retained in the cache rather than being spliced out.
    - When `_loadPoolNode` runs, if `viewerImageCache.has(actualSrc)`, the image is already decoded in memory and can be used immediately without firing a new network request.
  - **Bounded Clean Image Cache (`blobImage.js`)**:
    - Define explicit named constant `const TEXTURE_CACHE_CAPACITY = 6;`.
    - Sizing rationale: 6 full-resolution `ImageBitmap` GPU textures consume ~144 MB of VRAM, covering immediate back/forth navigation without exhausting GPU memory.
    - Upgrade `blobImage.js` from a single-item cache to `BoundedMap(TEXTURE_CACHE_CAPACITY)` of `ImageBitmap` textures.
    - Navigating back and forth between images finds existing textures in cache, completely eliminating redundant `fetch(src)` calls.
  - **HTTP Cache Headers for Archive Protocol (`protocol.rs`)**:
    - Add `.header("Cache-Control", "public, max-age=86400")` to `entry_response` in `src-tauri/src/protocol.rs`, matching `png_response`.
    - Enables WebView2's internal HTTP cache to fulfill repeat archive requests without IPC overhead.

### 5. Direct 1:1 Archive Thumbnail Sharing — **archive only**

> **Scope**: This item applies **only to archive mode**. Only archive thumbs are `1:1` (`quivit://archive/...` via `FsUtils.buildArchiveSrc:144` equals `buildThumbnailSrc:188` in archive mode). Disk thumbs are `http://quivit.localhost/thumb/...` shell 96px or `asset://` full-file via `buildFileSrcSync:243` with different URLs, so blob reuse does not apply. Hover, viewer active, and neighbor preload reuse all gate on `src.includes('/archive/')`.

**Problem**: In archive mode, the file panel loads 1:1 compressed images via `quivit://archive/<base64>/<entry>`. When the user navigates to an entry, the viewer issues a request for the same URL. With Item 4's `Cache-Control: public, max-age=86400` on archive responses, the browser now serves repeated requests from its HTTP cache -- the duplicate network round-trip is already eliminated.

**Remaining gap**: The viewer's pool `<img>` node still needs to decode the image from browser cache. For large images (4000x6000 manga scans), this decode step can take 50-200ms. The file panel's `thumbnailCache` already holds a `new Image()` retain object with that URL decoded. If the viewer could detect a cache hit, it could treat the image as "warm" and skip the loading animation and debounce, making the transition feel instant. WebView2 custom `quivit://` also ignores HTTP `Cache-Control`, so the gap remained as `2.5MB` re-fetches even after Item 4. Scrolling exacerbated this: `filePanel.js:1021` deferred all thumbs during `isScrolling`, so clicking an unloaded thumb waited for the whole `commitPendingThumbnails` batch.

**Approach**: When the viewer activates an archive image, check if `thumbnailCache.has(state.src)`. If found, the browser cache is guaranteed warm (the thumbnail loaded successfully), so skip the 45ms bridge debounce and treat the image as if `isAlreadyLoaded` were true for the loading animation path. The actual decode still happens in the pool node (we can't share DOM elements across modules), but the perceived latency drops because the loading skeleton never appears. For fetches, reuse the `blob:` URL already created by the file panel thumb (see `filePanel.js:851` below) via shared `ensureArchiveBlob` dedupe — one `fetch→blob` per src for viewer, hover and thumb. Disk mode falls through to original `quivit://`/`asset://` unchanged. Viewer priority is enforced by `filePanel.js:1021` active-exception and `commitPendingThumbnails` active-first + deferred non-active with `viewerBlobPending` gate.

#### [MODIFY] [viewerRender.js](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js)

**Step A: Import thumbnailCache and check for warm cache**

- [COMPLETED] Import `thumbnailCache` from `../filepanel/filePanel.js`. (`viewerRender.js:3`)
- [COMPLETED] In the `activeChanged` branch (line 331), after computing `isAlreadyLoaded`, add a second warm-cache check:
  ```js
  const isCacheWarm = !isAlreadyLoaded && thumbnailCache.has(state.src);
  ```
  (`viewerRender.js:341`)
- [COMPLETED] Use `isCacheWarm` alongside `isAlreadyLoaded` to skip the loading animation:
  ```js
  if (!isAlreadyLoaded && !isCacheWarm) {
    _startLoadingAnimation(activeEl);
  }
  ```
  (`viewerRender.js:342`)
- [COMPLETED] Use `isCacheWarm` to skip the bridge debounce:
  ```js
  if (hasPreviousBridge && !isAlreadyLoaded && !isCacheWarm) {
    _targetLoadTimer = setTimeout(loadTarget, TARGET_LOAD_DEBOUNCE_MS);
  } else {
    loadTarget();
  }
  ```
  (`viewerRender.js:419`)

#### [MODIFY] [filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js) — blob URL sharing (archive only, evolved from warm-cache check)

WebView2 custom `quivit://` does not participate in HTTP cache, so `Cache-Control` at `protocol.rs:216` alone did not prevent `2.5MB` re-fetches observed in network tab. Evolved to frontend blob sharing, archive only:

- [COMPLETED] `filePanel.js:22` — `thumbnailCache.set` wrapper revokes `blob:` on eviction (`URL.revokeObjectURL`) to prevent leak. Applies to any `blob:` entry, but only archive creates them.
- [COMPLETED] `filePanel.js:32` — `ensureArchiveBlob(src)` shared dedupe: `thumbnailCache` `blob:` hit or `_archiveBlobPromises` dedupe to one `fetch(src) → blob() → createObjectURL` per `quivit://archive/...`. Archive only. Caller-agnostic: `filePanel.js:851`, `viewerRender.js:371`, `filePanel.js:810` all share promise.
- [COMPLETED] `filePanel.js:851` — `createPoolRow` `thumbImg.onload` gates `if (src.includes('/archive/'))`: `ensureArchiveBlob(src)` (hits Rust `ArchiveCache`, no re-extraction). Disk thumbs keep `isSvgSrc → true` or `new Image()` retain — no `blob:`.
- [COMPLETED] `filePanel.js:810` — `wireRowListeners:mouseenter` hover preload reuses `blob:` for archive via `ensureArchiveBlob(src)` dedupe; original `asset://`/`quivit://` fallback for disk. Verified 2026-09-09 hover no longer re-fetches archive thumb from backend.
- [COMPLETED] `viewerRender.js:371` — `loadTarget` resolves `thumbnailCache.get(state.src)`; if `blob:` use `newSrc = cached` for `_loadPoolNode`, else if archive `ensureArchiveBlob(state.src).then(blobUrl→_loadPoolNode)` deduped with thumb (viewer prioritized, no duplicate `quivit://` fetch). `poolSrc` stays original `state.src` (`_activeNodes` keyed by original). Disk stays `asset://`.
- [COMPLETED] `viewerRender.js:257` — `_schedulePoolPreloads` resolves `blob:` for neighbor preloads (next/prev) to eliminate redundant `quivit://` fetches; fallback to original if cache miss. Archive only.
- [COMPLETED] `filePanel.js:1021` — `updateEntry` viewer priority: `else if (isScrolling && index !== Core.getState().index)` so active item thumbnail does not defer to `pendingSrc`/`TRANSPARENT_PIXEL` during scroll. `commitPendingThumbnails:1130` sorts active index first. Fixes viewer waiting for all thumbnails when clicking an unloaded thumb.
- Runtime verified 2026-09-09: archive active, neighbor preloads, and hover no longer re-fetch (network shows `blob:` from memory, `2.5MB` quivit fetches eliminated); viewer no longer waits for `commitPendingThumbnails` batch — confirmed; disk mode unchanged by design.

#### Blast radius

- **Scope archive only**: All `blob:` paths gate on `src.includes('/archive/')` or `typeof cached==='string' && cached.startsWith('blob:')`. Disk `asset://` and `/thumb/` paths never produce or consume `blob:`, so no behavior change for disk mode.
- **Import direction**: `viewerRender.js` imports from `filePanel.js`. Read-only import of already-exported `BoundedMap`. No circular dependency (filePanel does not import from viewer modules).
- **Shared blob lifecycle**: `filePanel.js` owns creation/revocation (`filePanel.js:22`); `viewerRender.js` and hover only read. Viewer `_recyclePoolNode` revokes only its own `poolSrc` (original `quivit://`), not the shared `blob:` (owned by `thumbnailCache`), so no use-after-revoke for active item. Eviction revokes oldest `blob:`; viewer/hover will fallback to `quivit://` if that entry is later needed — safe, just one re-fetch.
- **No changes to `protocol.rs`** beyond Item 4 `Cache-Control` (already present).
- **Behavior additive**: Fallback to original `quivit://`/`asset://` on cache miss or after eviction; disk mode unchanged by design.

---

## Status Matrix

| Item | Focus Area | Primary Files | Status |
| :--- | :--- | :--- | :--- |
| **1. Animated GIFs** | Bypass shell thumbnail for animated GIFs | `thumbnails.rs`, `thumbnails_tests.rs` | `[COMPLETED]` |
| **2. Transparent PNGs / GIFs / ICOs** | Detect source alpha, reject black matte thumbnails | `thumbnails.rs`, `thumbnails_tests.rs` | `[COMPLETED]` |
| **3. SVG Handling** | Targeted eager loading for animated SVGs, clean up c69bbb7 | `filePanel.js` | `[COMPLETED]` |
| **4. Viewer Cache** | Cache-Control headers, texture cache | `protocol.rs`, `blobImage.js` | `[COMPLETED]` |
| **5. Archive 1:1 Sharing** | Reuse thumbnail cache in viewer/hover (archive only, warm check + blob sharing) | `viewerRender.js`, `filePanel.js` | `[COMPLETED]` |
| **6. ICO Shell Thumbnails** | Disk `ico` via `quivit://thumb/` 96px shell, black matte → full file; archive `ico` → full file `quivit://archive/` | `fsUtils.js`, `thumbnails.rs`, `filePanel.js` | `[COMPLETED]` |

---

## Architectural Invariants

1. **One owner per concern**: `filePanel.js` owns file panel DOM; `viewerRender.js` owns viewer image elements; pure cache logic lives in `services/cache.js`.
2. **CSS source of truth**: Inline visual overrides remain forbidden; sizing and layout use CSS tokens and classes.
3. **No em dashes**: Documentation and comments use periods and commas only, per unslop guidelines.
4. **Targeted testing**: Run targeted tests derived from blast radius during development; full suite at final verification.

---

## Verification Plan

### Automated Tests
- `npm test`: Verify 58 existing unit tests plus new tests for GIF bypass, SVG rasterization, and viewer cache.
- `cargo check --tests --manifest-path src-tauri/Cargo.toml`: Clean build with zero warnings.
- `cargo test thumbnails_tests`: Verify GIF, PNG, and ICO transparency handling (include `test-files/endfield.ico` 32bpp).
- `cargo test protocol::tests`: Verify protocol routes pass.

### Manual Verification
1. Open `test-files\gif` in thumbnail view; confirm animated GIFs play.
2. View transparent PNG/ICO files; confirm transparent backgrounds without black borders (disk `test-files/endfield.ico` should show 96px shell thumb via `quivit://thumb/`, not 32px `icon`).
3. View SVG files in thumbnail view; verify rapid scrolling without SMIL freeze.
4. Flip back and forth between images in main viewer; confirm instant re-render.
5. In an archive (archive only), open thumbnail view, hover and click images — including an image whose thumb has not yet loaded while scrolling; viewer should update immediately and not wait for `commitPendingThumbnails` batch. Network tab should show `blob:` from memory, no `2.5MB` `quivit://archive/...` re-fetch for active, neighbors, or hover. Disk mode should still fetch `asset://`/`/thumb/` normally.
6. Archive containing `*.ico` (e.g. `zip` with `icon.ico`): thumbnail should be full file `quivit://archive/...` (shell cannot read inside archive), verify no `icon` fallback and viewer spritesheet still works for `ico`.
