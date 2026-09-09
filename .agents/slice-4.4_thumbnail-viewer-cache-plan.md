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

### 2. Transparent Thumbnails with Black Matte (PNG and GIF)
- **Issue**: Some Windows Shell thumbnails for transparent PNGs and transparent static GIFs composite against an opaque black matte background (RGB 0,0,0 with alpha 255) instead of preserving transparency. However, many transparent images produce healthy transparent thumbnails from Windows Shell with valid alpha channels. We must only fall back for broken thumbnails, preserving shell thumbnail performance for healthy ones.
- **Change**:
  - In `src-tauri/src/platform/thumbnails.rs`, after extracting the thumbnail bitmap from Windows Shell:
    - Check if the source image has transparency:
      - For PNG: check for color type 4 or 6 in `IHDR`, or a `tRNS` palette chunk.
      - For GIF: check if the Graphic Control Extension has the transparent color flag set (`flags & 0x01 != 0`).
    - If the source image is transparent, inspect the extracted thumbnail pixel buffer.
    - If the extracted thumbnail contains valid transparent pixels (any pixel with `alpha < 255`), the thumbnail is healthy: serve the shell thumbnail directly.
    - If the source image has transparency but the extracted thumbnail has zero transparent pixels (every pixel has `alpha == 255` and the background was flattened to black matte), the thumbnail is broken: return `Ok(None)`.
  - When `Ok(None)` is returned for a broken thumbnail, the frontend two-tier `onerror` handler in `filePanel.js` automatically falls back to `buildFileSrcSync(item.path)`, letting Chromium render the original image with true alpha transparency.

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

### 5. Direct 1:1 Archive Thumbnail Sharing
- **Issue**: In archive mode, the file panel loads 1:1 compressed images via `quivit://archive/<archive>/<entry>`. When the user navigates to an archive entry, the main viewer issues a duplicate request for the same URL.
- **Change**:
  - Export `getLoadedThumbnail(src)` from `filePanel.js` or query the shared cache in `services/cache.js`.
  - When `viewerRender.js` loads an archive image (`state.mode === 'archive'`), check if the 1:1 image is already present in `thumbnailCache`.
  - If present, reuse the loaded image and its dimensions immediately, making page flips in archives instant.

---

## Status Matrix

| Item | Focus Area | Primary Files | Status |
| :--- | :--- | :--- | :--- |
| **1. Animated GIFs** | Bypass shell thumbnail for GIFs | `fsUtils.js`, `thumbnails.rs`, `thumbnails_tests.rs` | `[PENDING]` |
| **2. Transparent PNGs** | Detect alpha and fall back to full file | `thumbnails.rs`, `thumbnails_tests.rs`, `filePanel.js` | `[PENDING]` |
| **3. SVG Rasterization** | Canvas rasterizer, clean up c69bbb7 | `services/rasterizeSvg.js`, `filePanel.js` | `[PENDING]` |
| **4. Viewer Cache** | BoundedMap image caching in main viewer | `viewerRender.js`, `services/cache.js` | `[PENDING]` |
| **5. Archive 1:1 Sharing** | Reuse thumbnail cache in main viewer | `viewerRender.js`, `filePanel.js` | `[PENDING]` |

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
- `cargo test thumbnails_tests`: Verify GIF and PNG transparency handling.
- `cargo test protocol::tests`: Verify protocol routes pass.

### Manual Verification
1. Open `test-files\gif` in thumbnail view; confirm animated GIFs play.
2. View transparent PNG files; confirm transparent backgrounds without black borders.
3. View SVG files in thumbnail view; verify rapid scrolling without SMIL freeze.
4. Flip back and forth between images in main viewer; confirm instant re-render.
5. In an archive, open thumbnail view and click images; confirm immediate viewer display.
