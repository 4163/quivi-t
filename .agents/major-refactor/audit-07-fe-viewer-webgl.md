# Split S07 audit: frontend viewer WebGL and scaling pipelines

Audit scope: 15 JavaScript files in split S07 (`fe-viewer-webgl`), covering single-image WebGL filtering, CPU and WebGL Lanczos scaling, manhwa multi-quad GPU compositing, live media texture pumps, shader chains, and the filter/scaler registry.

Consensus record: unanimously `[Agreed]` by `s07-gpu-perf` and `s07-pipeline-arch` across board messages `#44`, `#85`, `#90`, and `#91`, and ratified against Cross-Split Seam Matrix `#116` (`#128`, `.agents/major-refactor/cross-split-seams.md`). Baseline check: `npm run mocha` passes 308 tests with zero failures.

Status summary: 15 of 15 owned files audited. 11 files carry agreed remediation items (`S07-01` through `S07-10`). 4 files are marked **Cohesive** with optional low-risk shader optimizations tracked under `S07-11`. Zero findings were dropped or escalated.

## File inventory

| File | Lines | Verdict | Findings |
| --- | --- | --- | --- |
| `src/js/viewer/viewerPipelines.js` | 2,491 | Remediate | `S07-01`, `S07-02`, `S07-03`, `S07-04` |
| `src/js/services/pipelines/glRuntime.js` | 399 | Remediate | `S07-05` |
| `src/js/services/pipelines/textureCache.js` | 276 | Remediate | `S07-06` |
| `src/js/services/pipelines/quadCompositor.js` | 370 | Remediate | `S07-07` |
| `src/js/services/scaling/lanczosWebGL.js` | 76 | Remediate | `S07-07` |
| `src/js/services/scaling/lanczos.js` | 121 | Remediate | `S07-08` |
| `src/js/shared/blobImage.js` | 52 | Remediate | `S07-08` |
| `src/js/services/filters/anime4k.js` | 36 | Remediate | `S07-09` |
| `src/js/services/filters/anime4k/chains.js` | 1,588 | Remediate | `S07-09` |
| `src/js/services/registry.js` | 37 | Remediate | `S07-10` |
| `src/js/services/filterModules.js` | 21 | Remediate | `S07-10` |
| `src/js/services/pipelines/glCommon.js` | 19 | Cohesive | `S07-11` (shared helper target) |
| `src/js/services/filters/crt.js` | 115 | Cohesive | `S07-11` (minor guard) |
| `src/js/services/filters/phosphor.js` | 50 | Cohesive | `S07-11` (`u_rotCS` consumer) |
| `src/js/services/filters/scanlines.js` | 137 | Cohesive | `S07-11` (Oklab branch gate) |

## Agreed findings

### S07-01 [Blocking] Manhwa context-restore breakage and eager hidden WebGL2/2D context creation

**Status:** `[Agreed]`
**Files:** `src/js/viewer/viewerPipelines.js:285-309, 343-353, 1105, 1268-1285, 1301-1312, 1755, 2400-2406, 2471`

**Problem.** Three GPU lifecycle bugs sit inside canvas teardown and recovery paths:
1. The `webglcontextrestored` handler on `#manhwa-filter-canvas` at `viewerPipelines.js:1268-1285` disposes `_columnPipeline` but leaves `_columnQuadCompositor`, `_columnTextureCache`, and `_columnCompositeFbo` intact. When `_syncColumnPipeline()` runs at line `1283`, its null checks at lines `1800` and `1803` skip recreation, leaving the compositor, texture pool, and FBO bound to the dead WebGL2 context. Manhwa filtering renders black until the user toggles manhwa mode off and on.
2. `_teardownWebglCanvas()` at line `301` and `_teardownColumnCanvas()` at line `1304` unconditionally call `canvas.getContext('webgl2')`. Calling `clear()` at line `2471` invokes `_teardownColumn()` at line `1755`, which allocates a full WebGL2 context on `#manhwa-filter-canvas` even when manhwa mode and filters were never used. Worse, `_renderColumnInner()` calls `_teardownWebglCanvas()` at line `2404` on every manhwa render frame, triggering a cross-canvas WebGL2 context switch and clear on hidden `#viewer-filter-canvas` at 60 to 144 Hz.
3. `_cancelRender()` at line `287` and `_applyScaling()` at line `345` call `lanczosCanvas.getContext('2d')` unconditionally even when `lanczosCanvas.width === 0` and Lanczos mode was never active.

**Fix.**
- Route the `#manhwa-filter-canvas` `webglcontextrestored` listener at `viewerPipelines.js:1268-1285` through `_teardownColumn()` before calling `_syncColumnPipeline(Core.getState())` and `_requestColumnRender()`.
- Remove unconditional `.getContext('webgl2')` calls from `_teardownWebglCanvas()` and `_teardownColumnCanvas()`. Clear only through an existing `pipeline?.gl` or `_columnPipeline?.gl` reference when non-null, and short-circuit `_teardownColumn()` when no column pipeline, canvas readiness, timer, or active session exists.
- Call `_teardownWebglCanvas()` in `_renderColumnInner()` only once when retiring `manhwa-warmup` or when `filterCanvas` still carries `data-render-ready="true"`.
- Guard `lanczosCanvas.getContext('2d')` behind `lanczosCanvas.width > 0 || lanczosCanvas.height > 0 || lanczosCanvas.hasAttribute('data-render-ready')`.

**Acceptance criteria.**
- After a simulated `webglcontextlost` and `webglcontextrestored` on `#manhwa-filter-canvas`, `_columnQuadCompositor`, `_columnTextureCache`, and `_columnCompositeFbo` are recreated against the new context and the column repaints with `data-render-ready="true"`.
- Calling `clear()` without prior manhwa or filter usage performs zero `getContext('webgl2')` or `getContext('2d')` calls.
- Steady-state manhwa scroll frames trigger zero clears on `#viewer-filter-canvas`.

---

### S07-02 [Blocking] Manhwa dropped scroll frames, idle 60-144 Hz GPU spin, and unused Lanczos shader compile

**Status:** `[Agreed]`
**Files:** `src/js/viewer/viewerPipelines.js:1795-1818, 1836-1864, 2119, 2234-2397`

**Problem.** Manhwa GPU scheduling has three defects:
1. `_renderColumn()` at `viewerPipelines.js:1856-1864` returns immediately if `_columnRenderInFlight` is true. During fast scrolling or zooming while `_renderColumnInner()` awaits texture decoding at line `2180`, subsequent viewport ticks are dropped and never replayed after the await resolves, leaving the filtered column painted at a stale scroll offset.
2. `_syncColumnLiveLoop()` at `viewerPipelines.js:1836-1854` runs an unconditional `requestAnimationFrame` loop whenever `_columnHasLive` is true. For paused or 24 fps videos, 10 fps animated GIFs where `pendingVf === null`, or finite-loop GIFs that finished playing (`advanced === 0` at line `2119`), the loop still re-uploads video frames, re-draws every visible quad, and re-executes the entire post-processing filter chain (up to 18 or 21 passes for Anime4K) at display refresh rate.
3. `_syncColumnPipeline()` at `viewerPipelines.js:1808-1809` calls `_columnPipeline.setFilter(lanczosWebGlModule)` in manhwa Lanczos-only mode, compiling and linking `lanczosWebGL.js` even though `isDirectScreen` at lines `2234` and `2369-2370` draws solely through `QuadCompositor` and never invokes `_columnPipeline.renderFromTexture()`.

**Fix.**
- Add a `_columnRenderDirty` flag to `_renderColumn()`. When called while `_columnRenderInFlight` is true, set `_columnRenderDirty = true`. In the `finally` block, clear the flag and call `_requestColumnRender()` if dirty.
- Add dirty gating in `_renderColumnInner()` so GL compositing and filter passes execute only when at least one input changed: `viewportMoved`, first paint (`!_columnVisible`), filter/scaling/source revision change, newly uploaded static or ICO textures, a live video whose `currentTime` changed since its last upload, a raster animation with a non-null `pendingVf`, or an active SVG pump. Exclude finished finite-loop raster sessions from keeping `_columnHasLive` true so the rAF loop stops when all finite animations finish.
- Skip `_columnPipeline.setFilter(lanczosWebGlModule)` when `wantFilter === 'lanczos'` in manhwa direct-screen mode.

**Acceptance criteria.**
- Rapid scroll/zoom bursts during async texture decode always settle on the final viewport geometry with zero stale offset frames.
- Idle manhwa columns with paused video, finished play-once GIFs, or unchanged 10 fps GIF frames perform zero redundant `texSubImage2D`, `drawQuad`, or `renderFromTexture` passes between real frame advances.
- Manhwa Lanczos-only mode compiles zero unused `lanczosWebGL.js` programs on `_columnPipeline`.

---

### S07-03 [Blocking] Legacy live pump redundant decodes, double video uploads, and static SVG rAF spin

**Status:** `[Agreed]`
**Files:** `src/js/viewer/viewerPipelines.js:676-1039`

**Problem.** All three legacy single-image live pumps waste CPU and GPU work:
1. **Raster WebCodecs pump (`viewerPipelines.js:953-1038`).** Line `987` awaits `decoder.decode({ frameIndex })` on every 60 to 144 Hz rAF tick before checking `needsRender` at line `1005`. On a 10 fps GIF at 144 Hz, it decodes and immediately closes 13 identical `VideoFrame` instances for every displayed frame. In addition, `geomHash` at line `1003` omits `viewport.clientWidth`, `viewport.clientHeight`, and `pipeline.filter` (breaking resize and filter updates between frames), and the rAF loop keeps spinning forever after a finite `loopCount` completes at line `975`.
2. **Video pump (`viewerPipelines.js:677-752`).** Attaches both an infinite rAF loop (`738`) and a `timeupdate` listener (`734`). `timeupdate` calls `renderFrame()` without updating `lastCurrentTime`, causing the next rAF tick to see `currentTime !== lastCurrentTime` and upload and render the exact same video frame twice. The rAF loop also spins continuously while the video is paused.
3. **SVG DOM pump (`viewerPipelines.js:755-878`).** Line `874` schedules `requestAnimationFrame(pumpTickSvg)` forever even when `isAnimated === false`, polling `document.getElementById('viewport')`, layout dimensions, and string `geomHash` at 60 to 144 Hz on static SVGs.

**Fix.**
- In the WebCodecs raster pump, evaluate `frameChanged` and geometry/viewport/filter dirtiness before calling `decoder.decode()`. Only decode and call `pipeline.updateSource(vf)` when `frameIndex !== _livePumpLastDrawnFrameIndex`; when only geometry, viewport size, or filter changed, call `pipeline.render()` directly against the existing `_sourceTexture`. Stop scheduling rAF once a finite `loopCount` finishes (re-rendering on demand via `_scheduleTransform()` if the user pans, zooms, or resizes).
- In the video pump, drive frame updates via `videoEl.requestVideoFrameCallback` (falling back to rAF only when playing if unavailable), `seeked`, and viewport transform notifications. Drop the redundant `timeupdate` render call and avoid polling while `videoEl.paused` is true.
- In the SVG pump, run the rAF loop only when `isAnimated` is true. For static SVGs, rasterize and upload once on load, then re-render on viewport resize, transform, or filter changes.

**Acceptance criteria.**
- A 10 fps animated GIF/WebP/APNG/AVIF calls `ImageDecoder.decode()` at most once per animation frame, not once per display refresh.
- A finished play-once GIF and a static SVG schedule zero idle `requestAnimationFrame` callbacks.
- A paused video triggers zero `texImage2D` or `texSubImage2D` uploads and zero idle rAF spins; playing video uploads once per presented video frame.

---

### S07-04 [Blocking] Decompose `viewerPipelines.js` monolith while keeping single DOM ownership

**Status:** `[Agreed]`
**Files:** `src/js/viewer/viewerPipelines.js:1-2491`

**Problem.** `viewerPipelines.js` mixes six distinct concerns across 2,491 lines: single-image WebGL/Lanczos orchestration, three legacy live pumps, manhwa column FBO/quad compositing (`_renderColumnInner` alone is 542 lines at `1866-2407`), column raster/SVG session management, single and column ICO composite caching, and `#viewport` attribute ownership. It also carries hot-path hygiene violations:
- Calls `document.getElementById('viewport')` 17 times (`335, 458, 500, 700, 807, 867, 1027, 1051, 1060, 1080, 1085, 1097, 1695, 1709, 1770, 1870, 2481`) instead of caching once at init.
- Writes `_columnCanvas.style.removeProperty('width'|'height')` at `1878-1879` (CSS source-of-truth violation; nothing sets inline canvas sizes).
- Repeats scaling/filter resolution logic 3 times (`321-333`, `518-528`, `654-661`), hardcodes `128 * 1024 * 1024` at 3 sites (`395, 442, 480`) instead of using `DEFAULT_TEXTURE_CACHE_BYTES`, shadows `const item` 3 times inside `1950-1992`, and allocates a `.filter()` array on every column render at line `2177` even when all textures are cached.
- Runs synchronous PNG encoding `canvas.toDataURL('image/png')` at line `231` in `_ensureIcoComposite()` even when WebGL only consumes `composite.canvas` (and Lanczos can crop the canvas directly).
- Allocates temporary 2D `<canvas>` instances in `loadSvgCanvas()` (`119`) without releasing their backing store after `TextureCache` uploads them, and skips `_columnIcoComposites` pruning (`2218-2231`) whenever `_icoDrawsScratch.length === 0`.

**Fix.**
- Keep `src/js/viewer/viewerPipelines.js` as the single UI and DOM owner of `#viewer-lanczos-canvas`, `#viewer-filter-canvas`, `#manhwa-filter-canvas`, `#viewer-svg-pump`, `#manhwa-svg-pump-layer`, and `#viewport` attributes (`data-filter`, `data-scaling`, `manhwa-warmup`, `manhwa-exit-warmup`). This satisfies `AGENTS.md` single-owner rules and keeps `mocha/diagnosticsContract.test.js:86-93` literal checks intact.
- Extract four cohesive non-DOM coordinators under `src/js/services/pipelines/`:
  1. `webcodecsAnimSession.js`: shared `ImageDecoder` MIME detection, frame stepping, and `loopCount` logic used by both single-image and manhwa raster animations.
  2. `svgRasterPump.js`: shared SVG fetch, sanitization via `shared/svgUtils.js`, dimension resolution, and staging canvas cleanup (zeroing temp canvas width/height after static texture upload).
  3. `icoCompositeCache.js`: unified bounded ICO composite cache for single-image and manhwa views, dropping the synchronous `toDataURL('image/png')` roundtrip and running LRU pruning even when `_icoDrawsScratch.length === 0`.
  4. `columnPipeline.js`: manhwa composite FBO, `QuadCompositor`, `TextureCache` pinning, live slot texture pool, and slot quad drawing decoupled from `#viewport` DOM attributes.
- Cache `viewportEl` once in `createViewerPipelines()`, remove lines `1878-1879`, import `DEFAULT_TEXTURE_CACHE_BYTES` from `textureCache.js`, remove shadowed `item` declarations, replace `2177` `.filter()` with a zero-allocation loop on cache hit, and align `_drawSlotQuad` (`38-52`) with S06's canonical `{ x, y, width, height }` rect contract (Resolution R4).

**Acceptance criteria.**
- `createViewerPipelines(viewportState)` keeps its exact public API (`setSource`, `clear`, `forceRender`, `setColumnSource`, `notifyColumnChanged`).
- `mocha/diagnosticsContract.test.js` passes without modifying S07 assertions at lines `86-93`, and `viewerPipelineProbe.js` requires zero changes.
- Zero `document.getElementById('viewport')` calls remain inside hot render loops, zero `.style.removeProperty('width'|'height')` calls remain, and zero synchronous `toDataURL` calls occur on ICO WebGL or Lanczos renders.

---

### S07-05 [Blocking] `glRuntime.js` GPU/VRAM lifecycle, hot-path uniform lookup, Anime4K caching, and DOM leakage

**Status:** `[Agreed]`
**Files:** `src/js/services/pipelines/glRuntime.js:1-399`

**Problem.** `glRuntime.js` carries six performance, VRAM, and architecture defects:
1. **Shader object leaks (`45-58`).** `linkProgram()` compiles a fresh copy of identical `vsSource` for every pass (21 times for Anime4K normal) and never calls `_gl.deleteShader(vs)`, `_gl.deleteShader(fs)`, or `_gl.deleteProgram(prog)` on link failure.
2. **Per-frame `getUniformLocation()` in hot loop (`231-240`).** `_executePasses()` calls `_gl.getUniformLocation(p.program, 'u_tex' + j)` on every frame for every multi-input pass. Anime4K normal executes 47 synchronous uniform queries and template string allocations per frame. Lines `200-202` also allocate `requestedInputs` and `resolvedInputs` arrays per pass per frame.
3. **Unbounded FBO allocation and redundant full-CNN re-execution on pan/zoom (`69-103, 175-276`).** `_fbos` keys every pass as `pass_${i}_${p.save || 'tmp'}` with no liveness reuse and no `gl.MAX_TEXTURE_SIZE` guard. At 4K (3840x2160 RGBA8 = 33.2 MB), Anime4K normal allocates 20 full-resolution FBOs (663 MB VRAM) for one image. Furthermore, `_executePasses()` re-runs all `space: 'image'` CNN passes on every pan and zoom frame even though only the final `space: 'viewport'` pass (`DrawToViewport`) depends on pan, zoom, rotation, flip, or viewport size.
4. **Synchronous program teardown on filter toggle (`105-145`).** `setFilter()` deletes all compiled programs on every switch, causing 50 to 300 ms ANGLE/D3D11 main-thread shader recompile hitches when toggling filters.
5. **Suboptimal GL calls and missing guards (`14, 169, 219-226, 263-264, 320-321, 385-397`).** The WebGL2-unsupported fallback stub at line `14` omits `renderFromTexture` and `gl: null` (would throw `TypeError` at `viewerPipelines.js:454, 496`). `updateSource()` at line `169` reallocates storage via `texImage2D` every frame instead of `texSubImage2D` when dimensions match. `_executePasses()` clears full-screen opaque FBO quads (`219-220, 225-226`) and rebinds vertex attributes without a WebGL2 VAO or `posLoc >= 0` guard. `render()` omits `vpW <= 0 || vpH <= 0` guards, and `dispose()` (`388`) clears without binding `FRAMEBUFFER` to `null`.
6. **Pure-service boundary and dead code (`1, 278-318, 326-327, 350-351`).** Calls `canvas.style.removeProperty('width'|'height')` inside `services/pipelines/`, reads `geometry.viewport.clientWidth/Height` from DOM nodes, and keeps dead `render(..., skipUpload = false)` (`290` `getCleanImage`) which has zero callers in the repo.

**Fix.**
- Move shared `compileShader`, `linkProgram` (deleting shaders immediately after link and deleting programs on link failure), `createRgbaTexture`, and `createFbo` into `glCommon.js`. Compile shared `vsSource` once per runtime.
- Pre-resolve `texLocs` (`u_tex0..N`) and normalized `inputs` arrays inside `setFilter()` so `_executePasses()` executes zero `getUniformLocation()` calls and zero per-pass array allocations.
- Add a monotonic `_sourceVersion` counter incremented in `updateSource()` (`149-173`, because `updateSource` mutates `_sourceTexture` in place). Cache the final `space: 'image'` output texture keyed by `(sourceTexture, sourceVersion, nw, nh, filterKey)` so single-image pan, zoom, rotate, flip, and resize under Anime4K run only the trailing `DrawToViewport` pass (1 pass instead of 9 to 18 passes). Pool intermediate FBOs by pass liveness so dead intermediate tensors are recycled immediately, and clamp or guard FBO dimensions against `gl.getParameter(gl.MAX_TEXTURE_SIZE)`.
- Cache compiled pass programs per `filterKey` across filter switches within the same WebGL2 context (disposed on `dispose()`).
- Use `texSubImage2D` in `updateSource()` when dimensions match, use a WebGL2 VAO for the fullscreen quad, bind `FRAMEBUFFER` to `null` before clearing in `dispose()`, drop redundant clears on full-screen opaque passes, and complete the WebGL2-unsupported fallback stub with `gl: null` and `renderFromTexture: () => null`.
- Remove `.style.removeProperty('width'|'height')`, accept plain `{ width, height }` viewport dimensions instead of a DOM node, and remove the dead `skipUpload = false` / `getCleanImage` import path.

**Acceptance criteria.**
- Mock GL2 tests in `mocha/glRuntime.test.js` prove zero leaked shaders, zero `getUniformLocation()` calls during `_executePasses()`, 1-pass pan/zoom on cached image-space filters, `_sourceVersion` cache invalidation after `updateSource()`, FBO liveness reuse, cached program reuse across filter switches, `texSubImage2D` reuse on same-size `updateSource()`, safe WebGL2 fallback stub, and `bindFramebuffer(FRAMEBUFFER, null)` on `dispose()`.
- `glRuntime.js` contains zero `.style.` mutations and zero `blobImage.js` imports.

---

### S07-06 [Blocking] `textureCache.js` dispose/clear async race, missing `resp.ok`, and `MAX_TEXTURE_SIZE` guard

**Status:** `[Agreed]`
**Files:** `src/js/services/pipelines/textureCache.js:29-56, 182-227, 251-271`

**Problem.** Three resource-safety bugs exist in `TextureCache`:
1. **Async race across `clear()` and `dispose()` (`182-227, 251-271`).** If `clear()` runs while `getOrCreate(src)` awaits image decode, the resolving promise still uploads and inserts the stale texture into the cleared pool. Worse, if `dispose()` runs and sets `this.gl = null`, line `217` (`if (this.gl && !texture)`) evaluates false and line `219` inserts `{ texture: null }` into the disposed cache while inflating `_totalBytes`. In both cases, `finally` at line `221` calls `this._pending.delete(src)` unconditionally, which can delete a newer request's in-flight entry.
2. **Missing HTTP status check (`49-56`).** `defaultImageLoader()` does not check `resp.ok` before calling `resp.blob()` and `createImageBitmap(blob)`.
3. **No `MAX_TEXTURE_SIZE` guard (`29-47`).** `uploadTexture()` passes oversized tall webtoon bitmaps (exceeding GPU `MAX_TEXTURE_SIZE`, commonly 16,384 px) straight to `gl.texImage2D()`. WebGL2 fails silently with `GL_INVALID_VALUE` without throwing, causing `TextureCache.put()` to cache a blank black texture and charge full VRAM bytes against the 128 MB budget.

**Fix.**
- Add a monotonic `_epoch` counter incremented in `clear()` and `dispose()`, plus a `_disposed` boolean. Capture `epoch` at `getOrCreate()` start; after `await`, if `this._disposed || epoch !== this._epoch`, close `imageSource` and return `null`. In `finally`, delete `_pending` only if `this._pending.get(src) === promise`.
- Check `if (!resp.ok) return null` in `defaultImageLoader()`.
- Cache `gl.getParameter(gl.MAX_TEXTURE_SIZE)` per GL context (using a `WeakMap`) and reject or fail cleanly in `uploadTexture()` before `texImage2D` if `width > maxTexSize || height > maxTexSize`.

**Acceptance criteria.**
- `mocha/textureCache.test.js` proves in-flight `getOrCreate()` resolving after `clear()` or `dispose()` closes its bitmap, performs zero `uploadTexture()` or `put()` calls, keeps `size === 0` and `totalBytes === 0`, and never evicts a newer `_pending` entry.
- `!resp.ok` responses return `null` cleanly, and oversized dimensions exceeding `MAX_TEXTURE_SIZE` return `null` without caching a black texture.

---

### S07-07 [Warning] `quadCompositor.js` and `lanczosWebGL.js` duplicated shader, inner-loop trig work, eager compile, and per-quad GL churn

**Status:** `[Agreed]`
**Files:** `src/js/services/pipelines/quadCompositor.js:22-53, 66-76, 101-121, 151-234, 266-348`, `src/js/services/scaling/lanczosWebGL.js:6-73`

**Problem.**
1. **Duplicated Lanczos-3 shader with 3.5x wasted trig calls.** `quadCompositor.js:151-201` duplicates the 6x6 `lanczos3` GLSL kernel from `lanczosWebGL.js:21-73`. Both compute `lanczos3(dx)` inside the inner `x` loop (36 calls per pixel instead of precomputing 6 `wx[6]` weights once before the `y` loop: 42 `lanczos3()` evaluations per pixel reduced to 12).
2. **Duplicate shader compiler helpers.** `quadCompositor.js:203-234` duplicates `compileShader` and `linkProgram` from `glRuntime.js:33-58`.
3. **Eager unused `_lanczosProgram` compilation (`266-286`).** `QuadCompositor._init()` compiles and links `_lanczosProgram` even when manhwa mode uses CRT, Phosphor, Scanlines, or Anime4K (which only draw bilinear quads).
4. **Per-quad GL state churn (`304-348`).** `drawQuad()` calls `useProgram`, `bindBuffer`, `bufferSubData` on the same 96-byte VBO, `enableVertexAttribArray` x2, `vertexAttribPointer` x2, `uniform2f(u_viewport)`, `uniform1f(u_flipY)`, `activeTexture(TEXTURE0)`, and `uniform1i(u_texture, 0)` on every quad in a manhwa frame.
5. **Legacy rect aliases and test-only helpers.** Lines `39-42`, `66-76`, and `105-108` maintain legacy `dx/dy/dw/dh` and `sx/sy/sw/sh` aliases (to align with S06 Resolution R4), and `screenToNdc` (`22-28`), `destRectToNdc` (`38-53`), and `fillQuadNdcBuffer` (`101-121`) have zero `src/` callers (only `mocha/quadCompositor.test.js`).

**Fix.**
- Move shared `compileShader`/`linkProgram` and a single `lanczos3KernelGLSL` (with precomputed `float wx[6]` outside the `y` loop) into `glCommon.js`, imported by both `quadCompositor.js` and `lanczosWebGL.js`.
- Lazily compile `_lanczosProgram` on first `drawQuad(..., 'lanczos', ...)` call (updating `mocha/quadCompositor.test.js:260-262, 353` in Telemetry B).
- Add a WebGL2 VAO and frame-level state tracking (`beginFrame(vpW, vpH, flipY)` / `endFrame()`, or cached active program + frame uniforms) so multi-quad manhwa draws avoid redundant program binds, attribute setup, and frame-invariant uniform writes while keeping standalone `drawQuad()` compatible.
- Align rect field parsing with S06's canonical `{ x, y, width, height }` contract during the coordinated R4 slice; keep or trim test-only NDC helpers in sync with `mocha/quadCompositor.test.js`.

**Acceptance criteria.**
- Both Lanczos shaders evaluate `lanczos3()` 12 times per fragment instead of 42 with bit-identical output.
- Constructing `QuadCompositor` for non-Lanczos manhwa filters compiles only the bilinear program (1 program instead of 2).
- Multi-quad frames issue one `useProgram` and one set of viewport/flipY uniform writes per sampler switch instead of once per quad.

---

### S07-08 [Blocking] Static Lanczos IPC re-fetch per pan/zoom settle, `window.pica()` reach-in, and `blobImage.js` race

**Status:** `[Agreed]`
**Files:** `src/js/services/scaling/lanczos.js:1-121`, `src/js/shared/blobImage.js:1-52`

**Problem.**
1. **Architecture verdict on CPU (`pica.js`) vs WebGL Lanczos.** Static single-image Lanczos must stay on `pica.js` for visual parity: `pica.js` applies adaptive downscale filter radius plus unsharp masking (`unsharpAmount: 80, unsharpRadius: 0.6, unsharpThreshold: 2`), whereas `lanczosWebGL.js` uses a fixed 6x6 source-texel kernel that aliases at `scale < 0.5`.
2. **Full IPC re-fetch and re-decode on every pan/zoom settle (`blobImage.js:48-52`, `lanczos.js:85`).** `getCleanImageCrop()` bypasses `_textureCache`, omits `resp.ok` and `AbortSignal`, and re-fetches the entire source file over `quivit://` and re-decodes it on CPU after every 80 ms pan/zoom settle.
3. **Dead `getCleanImage()` and single-slot race (`blobImage.js:15-46`).** `getCleanImage()` has zero active production callers (only the dead `glRuntime.js:290` branch) and uses a single module-level `_pendingSrc` string that cancels and closes valid bitmaps if two URLs load concurrently.
4. **Pure-service boundary and precision issues (`lanczos.js:4-7, 32, 42-43, 72`).** `lanczos.js` calls `window.pica()` directly (blocking Node Mocha tests and parser-blocking `index.html:531`), reads DOM `viewport.clientWidth/Height`, destructures 5 unused local variables (`tx, ty, rotation, flipX, flipY` at line `32`), and checks exact float equality `scale === 1` at line `72` instead of an epsilon (`Math.abs(scale - 1) < 1e-4`).

**Fix.**
- Refactor `blobImage.js` to cache decoded `ImageBitmap` instances in its `BoundedMap(TEXTURE_CACHE_CAPACITY)` with per-URL `_pending` deduplication `Map` (eliminating the single-slot `_pendingSrc` race), `resp.ok` checking, and `AbortSignal` support. Have `getCleanImageCrop(src, sx, sy, sw, sh, { signal })` crop directly from the cached `ImageBitmap` via `createImageBitmap(cachedBitmap, sx, sy, sw, sh)` (or accept an `HTMLCanvasElement` directly for ICO composites, eliminating `viewerPipelines.js:231` `toDataURL`).
- Decouple `lanczos.js` from `window` and DOM nodes: accept an injected or lazy `pica` loader (coordinating with S02 `#54` `defer`/lazy-load of `src/js/vendors/pica.js` at `index.html:531`) and plain `{ width, height }` viewport dimensions, pass an `AbortController` signal cancelled by `cancel()`, remove unused destructured variables at line `32`, and replace `scale === 1` at line `72` with `Math.abs(scale - 1) < 1e-4`.

**Acceptance criteria.**
- Repeated pan/zoom settles on the same image in static Lanczos mode trigger zero repeat `fetch()` calls (100% cache hit in `blobImage.js`).
- `mocha/lanczos.test.js` and `mocha/blobImage.test.js` run cleanly in Node with zero `window` or DOM globals.
- `index.html:531` `pica.js` loads deferred or on first static Lanczos render without blocking startup or detached `?surface=fileList`.

---

### S07-09 [Blocking] Anime4K 3 dead full-resolution De-Ring passes and unnamed passes

**Status:** `[Agreed]`
**Files:** `src/js/services/filters/anime4k/chains.js:4-104, 390, 449-549, 1497`, `src/js/services/filters/anime4k.js:1-36`

**Problem.**
1. **3 dead full-resolution GPU passes in both chains.** In both `FAST_CHAIN` (`chains.js:4-104`) and `NORMAL_CHAIN` (`chains.js:449-549`), passes 0, 1, and 2 (`De-Ring-Compute-Statistics`, `De-Ring-Clamp`, and the unnamed clamp pass) write to `STATSMAX` and an unnamed FBO (`save: null`). Pass 3 (`lines 108, 553`), Pass 4 (`line 585`), and the final residual pass (`lines 392, 1499`) all explicitly bind `input: "source"`. No subsequent pass ever reads `STATSMAX` or pass 2's output. Every Anime4K frame wastes 3 full-resolution shader passes and 3 full-resolution FBOs (roughly 100 MB VRAM at 4K) on unreachable output.
2. **Pass counts and empty names.** `FAST_CHAIN` runs 11 image passes (12 with `DrawToViewport`) and `NORMAL_CHAIN` runs 20 image passes (21 with `DrawToViewport`). Four passes have `name: ""` (`lines 76, 390, 521, 1497`), two of which remain live (`390` and `1497`).
3. **Per-call wrapper allocation (`anime4k.js:7-35`).** `resolve()` rebuilds `drawPass` and spreads `[...chain, drawPass]` on every call; `export const DEBUG_TINT = false` (`line 4`) has zero external importers.
4. **Parity lock note on RGBA8 CReLU.** Intermediate CNN shaders evaluate `go_1 = max(-texture(...), 0.0)` (`chains.js:152-153`), which `glRuntime.js:93`'s `RGBA8` (`UNSIGNED_BYTE`) FBO clamps to `0.0`. Do **not** switch FBOs to `RGBA16F` during this refactor: doing so doubles FBO VRAM, requires `EXT_color_buffer_float`, and alters rendered pixels (breaking Telemetry B visual parity).

**Fix.**
- Remove unreachable passes 0, 1, and 2 from both `FAST_CHAIN` (11 -> 8 image passes, 12 -> 9 total, -27% image passes) and `NORMAL_CHAIN` (20 -> 17 image passes, 21 -> 18 total, -15% image passes). This preserves bit-identical visual output while saving 3 full-resolution FBOs per render.
- Assign descriptive names to the remaining unnamed residual passes at `chains.js:390` (`Anime4K-v4.0-Restore-CNN-(M)-Residual`) and `chains.js:1497` (`Anime4K-v4.0-Restore-CNN-(VL)-Residual`).
- Memoize resolved `'fast'` and `'normal'` filter modules in `anime4k.js` with stable `cacheKey` values (`'anime4k:fast'`, `'anime4k:normal'`) so `glRuntime` can cache compiled programs, and unexport `DEBUG_TINT` (keeping it module-local or removing it).

**Acceptance criteria.**
- `mocha/filterModules.test.js` validates that every pass in `FAST_CHAIN` and `NORMAL_CHAIN` has a non-empty `name` and that every pass output is reachable from the final `DrawToViewport` pass (zero dead passes).
- Rendered Anime4K output is pixel-identical before and after removing passes 0 to 2 while cutting `FAST_CHAIN` by 27% and `NORMAL_CHAIN` by 15% in image passes and eliminating ~100 MB of 4K FBO VRAM.

---

### S07-10 [Warning] Registry label single source of truth and eager 202 KB Anime4K shader parse

**Status:** `[Agreed]`
**Files:** `src/js/services/registry.js:1-37`, `src/js/services/filterModules.js:1-21`

**Problem.**
1. **Duplicated scaler and filter labels (`registry.js:6-23`).** `menubar.js:798-803` (`FILTER_LABELS`), `menubar.js:863` (`scalingLabels`), and `menubar/statusbar.js:22-26` (`SCALING_LABELS`) duplicate labels already declared in `registry.js` because `registry.js` exports `FILTER_BY_ID` but not `SCALER_BY_ID`.
2. **Null safety and dead property (`registry.js:16, 22`).** `SCALERS[2]` carries an unread `pipeline: 'lanczos'` property, and `activeFilterId(frontendData)` throws if `frontendData` is null or undefined.
3. **Eager static parse of `anime4k/chains.js` (`filterModules.js:1-4`).** `filterModules.js` statically imports `anime4k.js` -> `anime4k/chains.js` (1,588 lines, ~202 KB) at startup even when no filter is active or in detached `?surface=fileList`. Its `switch (id)` (`12-17`) can also be a plain lookup map.

**Fix.**
- Export `SCALER_BY_ID = new Map(SCALERS.map(s => [s.id, s]))` from `registry.js` so S02 (`menubar.js`, `statusbar.js`) deletes its duplicate label maps. Guard `activeFilterId(frontendData)` with `frontendData?.active_filter` and remove unread `pipeline: 'lanczos'` from `SCALERS[2]`.
- Replace the `switch` in `filterModules.js` with a static map for lightweight filters (`crt`, `phosphor`, `scanlines` stay synchronous) and add an async loader (`loadFilterModule(id, frontendData)`) using dynamic `import('./filters/anime4k.js')` with generation guards in `viewerPipelines.js` so the 202 KB Anime4K chains module parses only when Anime4K is selected.

**Acceptance criteria.**
- `mocha/registry.test.js` confirms `FILTERS`/`SCALERS`/`FILTER_BY_ID`/`SCALER_BY_ID` match `ACTION_REGISTRY` action IDs and `activeFilterId(null)` returns `null`.
- Startup without Anime4K enabled does not fetch or parse `src/js/services/filters/anime4k/chains.js`.

---

### S07-11 [Nit] Cohesive shader modules (`glCommon.js`, `crt.js`, `phosphor.js`, `scanlines.js`) and low-risk ALU wins

**Status:** `[Agreed]`
**Files:** `src/js/services/pipelines/glCommon.js:1-19`, `src/js/services/filters/crt.js:1-115`, `src/js/services/filters/phosphor.js:1-50`, `src/js/services/filters/scanlines.js:1-137`

**Assessment.** All four files are **Cohesive** pure modules with zero DOM imports and clean responsibilities. Three low-risk GPU ALU improvements fit naturally alongside `S07-05` and `S07-07`:
1. **`glCommon.js:12-13` (`screenToTexUV`).** Computes `cos(-u_rotation)` and `sin(-u_rotation)` inside every `screenToTexUV()` call. `crt.js`, `phosphor.js`, and `scanlines.js` each call `screenToTexUV()` 3 times per fragment (6 trig calls per pixel, or 12.4 million redundant trig evaluations per 1080p frame). Precompute `uniform vec2 u_rotCS` once on CPU in `glRuntime.js` and read `u_rotCS.x`/`u_rotCS.y` in `glCommon.js`.
2. **`scanlines.js:107-128`.** Runs the full Oklab color-space conversion (9 `pow()` calls per fragment) even on bright beam centers where `gapAmount === 0.0`. Wrap lines `107-128` in `if (gapAmount > 0.001)` to skip 9 `pow()` calls on roughly half of all fragments with identical output.
3. **`crt.js:18-19, 70`.** Replace `pow(abs(uv.y) / 5.0, 2.0)` and `pow(abs(uv.x) / 4.0, 2.0)` with simple squaring and guard `pow(max(vig, 0.0), 0.3)` against undefined `pow(0.0, y)` edge behavior on strict GLSL ES 3.00 drivers.

**Acceptance criteria.**
- `crt`, `phosphor`, and `scanlines` render bit-identical frames under rotated and unrotated views while eliminating 6 trig calls per pixel and gating Oklab math on scanline gaps.

## Cross-split seams (Sync A, B, and C)

Verified against `.agents/major-refactor/cross-split-seams.md` (`#116`, ratified in `#128`):

- **Sync A (Main HTML, CSS, and CSP with S02 and S08).**
  - `src/index.html`: Zero new `<template>` elements required by S07. Locked IDs preserved: `#viewer-lanczos-canvas` (`L409`), `#viewer-svg-pump` (`L417`), `#viewer-filter-canvas` (`L418`), `#manhwa-filter-canvas` (`L385`), `#manhwa-svg-pump-layer` (`L389`). Coordinate `defer` or lazy loading of `src/js/vendors/pica.js` (`L531`) with `lanczos.js` (`S07-08`).
  - `src/css/main.css` -> `viewer.css` (S02): All S07 canvas, SVG-pump, `[data-filter]`, and `.manhwa-warmup`/`.manhwa-exit-warmup` rules move intact into `viewer.css`. S07 removes dead `.style.removeProperty('width'|'height')` calls in `glRuntime.js` and `viewerPipelines.js` while keeping `--crop-left/top/w/h` CSS custom properties on `#viewer-lanczos-canvas`.
  - `src-tauri/tauri.conf.json:12` CSP (S08 R2): Confirmed explicit CSP (`connect-src` with `quivit:`, `http://quivit.localhost`, `asset:`, `blob:`, `data:`; `script-src`/`worker-src` with `'self' blob: 'wasm-unsafe-eval'`) covers `textureCache.js`/`blobImage.js` fetches, SVG blob pumps, and `pica.js` WASM/Blob workers.
- **Sync B (Viewer, Registry, and Probes with S06, S02, and S01).**
  - `viewerPipelines.js` preserves `createViewerPipelines(viewportState)` API (`setSource`, `clear`, `forceRender`, `setColumnSource`, `notifyColumnChanged`), `getManhwaColumnSnapshot()` shape, `buildIcoCompositeCanvas`, `getEffectiveScaling`, `icoSizesTotal`, and `invertViewport`.
  - Resolution R4 atomic rect cleanup: align `viewerPipelines.js:38-52` and `quadCompositor.js:39-42, 66-76, 105-108` to canonical `{ x, y, width, height }` + `drawList` alongside S06 (`viewerMath.js`) and `mocha/viewerMath.test.js:836-937`.
  - Locked contracts preserved: `mocha/diagnosticsContract.test.js:86-93` literal checks inside `viewerPipelines.js` and all `e2e/replay-diagnostics/probes/viewerPipelineProbe.js` selectors/attributes (`#viewer-lanczos-canvas`, `#viewer-filter-canvas`, `#manhwa-filter-canvas`, `data-render-ready`, `data-filter`).
  - `services/registry.js` exports `SCALER_BY_ID` so S02 (`menubar.js`, `statusbar.js`) deletes duplicate label maps.
  - Non-blocking follow-up noted: `src-tauri/src/protocol.rs:273, 284, 317, 328` already sends `Access-Control-Allow-Origin: *`. Adding `crossOrigin="anonymous"` to S06 viewer `<img>` pool elements could eliminate the double `fetch()` + `createImageBitmap()` in `TextureCache` in a future pass.
- **Sync C (`shared/svgUtils.js` with S05).**
  - `viewerPipelines.js:11, 94, 109, 770, 1474, 1516` consumes `prepareSvgForCanvas` and `resolveSvgDimensions` with zero signature changes needed.

## Telemetry A and B plan

Three of the four repository test suites apply to S07 (`cargo test` is N/A because S07 edits no Rust files).

### 1. Mocha unit tests (`npm run mocha`)

- **Existing coverage:** `mocha/quadCompositor.test.js` (11 tests), `mocha/textureCache.test.js` (11 tests), `mocha/diagnosticsContract.test.js` (5 tests).
- **Telemetry A additions (before production edits):**
  - `mocha/glRuntime.test.js`: mock WebGL2 tests for shader compile/link/delete lifecycle, `setFilter()` uniform lookup caching, multi-pass FBO allocation/reuse, `renderFromTexture()`, `updateSource()` `texSubImage2D` path, WebGL2-unsupported fallback stub, and `dispose()` cleanup.
  - `mocha/lanczos.test.js`: viewport crop projection math, 1:1 bypass, generation cancellation, injected resampler/crop-loader purity.
  - `mocha/registry.test.js` and `mocha/filterModules.test.js`: `FILTERS`/`SCALERS`/`FILTER_BY_ID` parity with `ACTION_REGISTRY`, `normalizeFilterOptions`, `getFilterModule` fast/normal resolution, `chains.js` pass-graph reachability and pass naming, and `crt.js` `applyUniforms` (`subjectRect` and rotation).
  - `mocha/blobImage.test.js`: `getCleanImageCrop` behavior, error handling, and concurrent request handling.
  - Expand `mocha/textureCache.test.js`: `setPinnedKeys()`, `clear()`/`dispose()` vs in-flight `getOrCreate()`, `!resp.ok` handling, and `MAX_TEXTURE_SIZE` rejection.
- **Telemetry B updates and assertions (after production edits):**
  - Update `mocha/quadCompositor.test.js:260-262, 353` for lazy `_lanczosProgram` compilation and add assertions for VAO/frame-state batching and canonical `{ x, y, width, height }` rect inputs (R4).
  - Assert zero `getUniformLocation()` calls during `glRuntime._executePasses()`, zero leaked WebGLShader objects, 1-pass pan/zoom on cached Anime4K image-space output with `_sourceVersion` invalidation on `updateSource()`, zero dead passes in `FAST_CHAIN` (8 image passes) and `NORMAL_CHAIN` (17 image passes), `SCALER_BY_ID` export + null-safe `activeFilterId(null)`, and 0 repeat `fetch()` calls in `blobImage.js` on repeated crops of the same URL.

### 2. WebdriverIO desktop E2E tests (`npm run e2e -- --spec e2e/specs/03-viewer.e2e.js`)

- **Existing coverage:** Manhwa `scanlines` filter activation, `#manhwa-filter-canvas[data-render-ready="true"]`, scroll continuity, filter teardown, and ICO manhwa continuity (`03-viewer.e2e.js:165-285`).
- **Telemetry A additions:** Single-image filter toggles (CRT, Scanlines, Phosphor, Anime4K fast and normal verifying `#viewer-filter-canvas[data-render-ready="true"]`), static Lanczos scaling readiness (`#viewer-lanczos-canvas[data-render-ready="true"]`), and a simulated `webglcontextlost`/`webglcontextrestored` recovery check on `#manhwa-filter-canvas`.
- **Telemetry B verification:** 1:1 functional parity across all existing and new viewer filter/scaling specs, clean `pica.js` deferred load under the tightened S08 CSP, and zero console errors on detached `?surface=fileList`.

### 3. Replay diagnostics (`npm run diagnose -- <scenario>`)

- **Target scenarios:** `filter-navigation`, `manhwa-ghost-phosphor`, `manhwa-gif-bridge`, and `manhwa-video-bridge`.
- **Telemetry A baseline:** Record frame pacing, `blackout` count (must be 0), `canvas-ready-change` / `viewport-filter-change` sequences, and `bitmap-create-end` counts across all four scenarios.
- **Telemetry B verification:** Confirm zero blackout frames and zero `canvas-ready-change` regressions alongside measurable improvements:
  - Zero `ImageDecoder.decode()` calls on unchanged animated raster frames.
  - Zero idle WebGL2 context creation on `clear()` without prior filter/manhwa use and zero cross-canvas clears on `#viewer-filter-canvas` during manhwa scroll frames.
  - Zero repeat IPC `fetch()`/`createImageBitmap()` work on static Lanczos pan/zoom settles.
  - 3 fewer full-resolution passes per Anime4K render (roughly 100 MB less FBO VRAM at 4K) and 1-pass single-image Anime4K pan/zoom.
