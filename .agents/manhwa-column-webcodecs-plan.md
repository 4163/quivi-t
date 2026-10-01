Validation comparison against .agents/skills/validate-changes/SKILL.md rules was performed. Each slice below was checked for module ownership, pure module direction, CSS source of truth, HTML-first rendering, memory lifecycle bounds, blast radius with runnable checks, and docs discipline.

# Manhwa column WebCodecs and animated SVG plan

**Target:** working tree, animated raster and animated SVG formats supported under manhwa lanczos and filters.

**Scope lock:** Add WebCodecs `ImageDecoder` and animated SVG live pump support to manhwa column view so animated rasters (GIF, animated WebP, APNG, animated AVIF) and animated SVGs keep moving under lanczos and WebGL post-processing shaders. Decoders run inside `src/js/viewer/viewerPipelines.js` on the visible window only. Bounded to a maximum of 3 concurrent live decoders. Out-of-bounds animated slots fall back to their static frame from `_columnTextureCache`. Single `_columnLiveTexture` is replaced with a bounded per-slot texture map updated via `texSubImage2D`. No per-slot canvas elements in DOM. No architecture-state or README edits during implementation. Deviations go here with reason and file.

**Definitions.**
- Raster animation: Multi-frame image format decoded via WebCodecs `ImageDecoder` (`image/gif`, `image/webp`, `image/png` for APNG, `image/avif`).
- SVG animation: Vector graphic with SMIL elements (`<animate>`, `<set>`, `<animateTransform>`, `<animateMotion>`) or CSS keyframe animations.
- Live slot: A slot requiring continuous per-frame texture sampling in the column compositor (videos, animated rasters, animated SVGs).
- Session: An active decode session for an in-viewport animated slot tracking its decoder, clock, frame index, and WebGL texture.
- Window composite: The single WebGL output rendered into `#manhwa-filter-canvas`.

## Pipeline map

Current state:
1. Videos: Marked in `_liveSlots` in `src/js/viewer/manhwaStrip.js:1194`. Slices 4A/4B implemented video uploads to `_columnLiveTexture` in `src/js/viewer/viewerPipelines.js:1238-1264`.
2. Animated rasters: Detected by `Core.checkIsAnimated` in `src/js/core.js:364` through Rust `check_is_animated` in `src-tauri/src/commands/animation.rs:9`. In manhwa, rasters are treated as still images, uploaded once to `_columnTextureCache` in `viewerPipelines.js:1184-1235`, and freeze on frame 0 because slot DOM nodes are hidden by `#viewport.manhwa-active[data-filter] #manhwa-strip .manhwa-slot>img` in `src/css/main.css:2251-2254`.
3. Animated SVGs: Identified in Rust `src-tauri/src/formats.rs:476-483`. In manhwa, rendered once via `loadSvgCanvas` in `viewerPipelines.js:73-136` into `_columnTextureCache`. Motion freezes under filters.

Target state:
1. `manhwaStrip.js` queries `Core.checkIsAnimated` for mounted slots. Animated entries join `_liveSlots` alongside videos and pass `liveTypes` in the column snapshot.
2. `viewerPipelines.js` partitions draws. Still images read from `_columnTextureCache`. Live draws (videos, animated rasters, animated SVGs) read from per-slot live textures in `_columnLiveTextures`.
3. Visible animated rasters decode on-demand through bounded `ImageDecoder` sessions synchronized to the column rAF loop, upload to their dedicated texture with `gl.texSubImage2D`, and immediately close `VideoFrame` handles.
4. Visible animated SVGs pump sanitized blob image frames through an off-DOM 2D staging canvas capped at `SVG_ANIMATED_MAX_EDGE = 1080` and upload via `gl.texSubImage2D`.
5. Slots scrolling out of view or evicted from `_mounted` dispose their `ImageDecoder`, revoke blob URLs, and release GPU textures.

## Touched files

- `src/js/viewer/manhwaStrip.js`: Extends slot mounting and prefetch to query animation status and populate `_liveSlots` and `liveTypes` for animated rasters and SVGs.
- `src/js/viewer/viewerPipelines.js`: Replaces single `_columnLiveTexture` with per-slot live texture map. Implements WebCodecs column pump, animated SVG pump, and session lifecycle.
- `src/js/viewer/viewer.js`: Passes snapshot updates and coordinates handoff cleanup.
- `src/js/viewer/viewerRender.js`: Validates bridge handoff preserves animation restart parameters.
- `mocha/viewerMath.test.js`: Validates draw list calculations remain consistent for mixed live and cached slots.
- `mocha/diagnosticsContract.test.js`: Confirms probe contract for `#manhwa-filter-canvas` data attributes.

## Blast radius

- GPU memory and texture leaks: Unclosed `VideoFrame` handles or orphaned `WebGLTexture` allocations crash WebView2. Proof: Every `VideoFrame` is closed in a `try/finally` block. Every slot eviction deletes its live texture from `_columnLiveTextures`.
- Demuxer thread exhaustion: Creating an unbounded number of `ImageDecoder` instances stalls the browser thread. Proof: Hard limit of 3 concurrent active decoders (`MAX_CONCURRENT_LIVE_ANIMATED = 3`). Lower priority slots fall back to static cache.
- Custom protocol canvas tainting: Direct `drawImage` from `quivit://` taints 2D staging canvases. Proof: SVGs are fetched, sanitized, converted to blob URLs (`blob:http://...`), and drawn without tainting, matching the proven pattern in `viewerPipelines.js:600-605`.
- Legacy single-image view regression: Legacy view uses its own variables (`_livePumpImg`, `_livePumpRaf`). Column logic is isolated to `_columnAnimSessions` and only runs when `Core.getState().manhwaEnabled` is true.
- Bridge transitions (l to m, m to l): Deactivating manhwa must close column decoders without destroying the anchor DOM element borrowed by the bridge layer in `manhwaStrip.js:2108`.

---

## Slice 4A. Per-slot live texture management and video optimization

Goal is replacing the single global `_columnLiveTexture` with a bounded per-slot texture map to eliminate GPU texture reallocations every frame.

- [ ] In `src/js/viewer/viewerPipelines.js:916`, replace `let _columnLiveTexture = null;` with `const _columnLiveTextures = new Map();` storing `{ texture, width, height }` per `imgIdx`.
- [ ] In `src/js/viewer/viewerPipelines.js:984`, update `_teardownColumn` to iterate through `_columnLiveTextures`, call `gl.deleteTexture(entry.texture)` for each, and clear the map.
- [ ] In `src/js/viewer/viewerPipelines.js:1238-1264`, update the live draw loop:
  - If a texture for `draw.imgIdx` does not exist or dimensions changed (`entry.width !== nodeW || entry.height !== nodeH`), allocate with `gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, nodeW, nodeH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)` and store new dimensions.
  - Upload pixels using `gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, node)`.
  - Draw quad using that slot's specific texture.
- [ ] In `src/js/viewer/viewerPipelines.js:1160`, prune entries in `_columnLiveTextures` whose `imgIdx` is no longer present in `snap.liveSlots`.
- [ ] Accept when playing two videos of different resolutions in manhwa simultaneously under Lanczos and Anime4K runs smoothly without texture reallocation stalls, and memory remains constant.

---

## Slice 4B. Animation classification and live slot registration in manhwa strip

Goal is identifying animated rasters and animated SVGs in the manhwa strip and registering them in `_liveSlots` and the column snapshot.

- [ ] In `src/js/viewer/manhwaStrip.js:96`, add `const _liveTypes = new Map();` mapping `imgIdx` to `'video' | 'raster' | 'svg'`.
- [ ] In `src/js/viewer/manhwaStrip.js:1175`, in `_claimSlot`:
  - When `item.kind === 'video'`, set `_liveTypes.set(imgIdx, 'video')` and `_liveSlots.add(imgIdx)`.
  - When `item.kind === 'svg'`, check `Core.checkIsAnimated(item.entry.name || item.entry.path, state.archivePath)`. If animated, set `_liveTypes.set(imgIdx, 'svg')` and `_liveSlots.add(imgIdx)`.
  - When `item.kind === 'image'`, check if extension is `gif`, `webp`, `png`, `apng`, or `avif`. Query `Core.checkIsAnimated`. If `animStatus.is_animated` is true, set `_liveTypes.set(imgIdx, 'raster')` and `_liveSlots.add(imgIdx)`.
- [ ] In `src/js/viewer/manhwaStrip.js:745`, on slot eviction, clean both `_liveSlots.delete(imgIdx)` and `_liveTypes.delete(imgIdx)`.
- [ ] In `src/js/viewer/manhwaStrip.js:2035`, in `_deactivate`, clear `_liveTypes.clear()`.
- [ ] In `src/js/viewer/manhwaStrip.js:2405`, in `_admitCompleted`, remap `_liveTypes` alongside `_liveSlots`.
- [ ] In `src/js/viewer/manhwaStrip.js:2500`, include `liveTypes: _liveTypes` in the return object of `getManhwaColumnSnapshot()`.
- [ ] Accept when inspecting `snap.liveSlots` and `snap.liveTypes` in a mixed chapter containing GIF, APNG, animated SVG, and video correctly marks all moving slots as live.

---

## Slice 4C. WebCodecs ImageDecoder column pump for animated rasters

Goal is continuous frame decoding and rendering for visible animated rasters in the manhwa column WebGL pipeline.

- [ ] In `src/js/viewer/viewerPipelines.js`, define constants and state:
  - `const MAX_CONCURRENT_LIVE_ANIMATED = 3;`
  - `const _columnAnimSessions = new Map();`
- [ ] In `src/js/viewer/viewerPipelines.js`, create helper `_getOrCreateAnimSession(imgIdx, item, src)`:
  - Detect MIME type: `.webp` -> `image/webp`, `.png`/`.apng` -> `image/png`, `.avif` -> `image/avif`, default `image/gif`.
  - Fetch `src`, instantiate `new ImageDecoder({ data: resp.body, type: contentType })`, await `decoder.completed`.
  - Guard against slot eviction while awaiting. If discarded, call `decoder.close()`.
  - Extract `track = decoder.tracks.selectedTrack`, check `track.frameCount > 1`.
  - Return session object `{ decoder, frameCount, loopCount, currentLoop: 1, frameIndex: 0, frameDurationMs: 100, lastTime: performance.now(), currentVf: null }`.
- [ ] In `src/js/viewer/viewerPipelines.js:1163`, during `_renderColumnInner`:
  - Calculate distance from `draw.imgIdx` to anchor `_anchorImgIdx`. Sort live animated candidates by proximity.
  - Active sessions are maintained for the top 3 visible animated slots. Excess visible animated slots fall back to `_cachedDrawsScratch` using their static frame.
  - For each active session, advance `frameIndex` based on `performance.now() - session.lastTime` and `session.frameDurationMs`.
  - If `frameIndex` changed, call `const { image: vf } = await session.decoder.decode({ frameIndex })`.
  - Update `session.frameDurationMs = Math.max(10, (vf.duration || 100000) / 1000)`.
  - Upload `vf` to that slot's texture in `_columnLiveTextures` via `gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, vf)`.
  - Call `vf.close()` immediately in a `finally` block.
- [ ] In `src/js/viewer/viewerPipelines.js:984`, in `_teardownColumn`, close all active decoders via `session.decoder.close()` and clear `_columnAnimSessions`.
- [ ] In `src/js/viewer/viewerPipelines.js:1160`, clean up sessions for slots that scrolled out of view.
- [ ] Accept when an animated GIF, animated WebP, and APNG scroll through the manhwa column under Anime4K and Lanczos, animating smoothly at their native frame rates without freezing.

---

## Slice 4D. Animated SVG pump in the manhwa column

Goal is supporting moving SMIL and animated SVG entries under manhwa column filters.

- [ ] In `src/js/viewer/viewerPipelines.js`, add an SVG pump session handler for live SVG slots:
  - Fetch SVG text, sanitize with `prepareSvgForCanvas`, create Blob URL.
  - Instantiate off-DOM `new Image()`, set `crossOrigin = 'anonymous'`, assign blob URL.
  - Await image load.
  - Maintain an off-DOM 2D staging canvas capped at `SVG_ANIMATED_MAX_EDGE = 1080`.
- [ ] In `src/js/viewer/viewerPipelines.js:1238`, during the live draw pass:
  - For `liveTypes.get(imgIdx) === 'svg'`:
  - Draw current image state into the staging canvas: `ctx.drawImage(pumpImg, 0, 0, sw, sh)`.
  - Upload canvas to slot texture via `gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, stagingCanvas)`.
  - Draw slot quad with `_columnQuadCompositor`.
- [ ] On slot eviction or teardown:
  - Revoke blob URL via `URL.revokeObjectURL(session.blobUrl)`.
  - Reset staging canvas dimensions (`width = 0, height = 0`).
- [ ] Accept when an animated SVG with SMIL animations plays continuously in the manhwa column under CRT, Phosphor, and Lanczos filters without canvas tainting errors.

---

## Slice 4E. Handoff, test updates, and diagnostic verification

Goal is locking contracts, verifying zero-flicker transitions, and confirming probe stability.

- [ ] In `src/js/viewer/viewerRender.js:198`, in `_parkHandoff`, confirm that when an animated slot is handed off from manhwa to legacy (`m to l`), single view properly restarts its live pump with `_syncLivePump()`.
- [ ] In `src/js/viewer/viewer.js:41`, confirm that when toggling `l to m`, the bridge layer holds the legacy retiring frame until the column WebGL pipeline paints its first ready frame.
- [ ] In `mocha/viewerMath.test.js`, add test cases asserting `computeColumnComposite` produces expected draw list partitions and continuous offsets for mixed still and animated chapters.
- [ ] In `mocha/diagnosticsContract.test.js`, assert that `#manhwa-filter-canvas` data attributes and classes meet the contract.
- [ ] Run runnable static checks:
  - `node --check src/js/viewer/manhwaStrip.js`
  - `node --check src/js/viewer/viewerPipelines.js`
  - `npm test`
- [ ] Manual runtime verification in running app:
  1. Open a folder with mixed content (still JPEG, animated GIF, animated WebP, APNG, animated SVG, MP4 video) in manhwa mode.
  2. Enable Lanczos scaling: confirm rasters sharpen and all animations play simultaneously.
  3. Enable Anime4K, CRT, Phosphor, and Scanlines: confirm shaders apply across all moving and still slots with seam continuity.
  4. Scroll rapidly top-to-bottom and bottom-to-top: confirm decoders initialize and dispose cleanly with no memory growth in DevTools.
  5. Toggle manhwa on and off while viewing an animated image: confirm no blackout frame and no animation stutter during bridge handoff.
- [ ] Accept when all automated checks pass and manual runtime verification confirms smooth animation with no GPU or memory leaks.
