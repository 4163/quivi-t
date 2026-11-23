# Viewer Pipeline Telemetry: Full Lifecycle Map

> Source files read verbatim:
> - `src/js/viewer/viewer.js` (67 lines)
> - `src/js/viewer/viewerRender.js` (485 lines)
> - `src/js/viewer/viewerPipelines.js` (641 lines)
> - `src/js/services/pipelines/glRuntime.js` (345 lines). **Note:** the requested path `src/js/viewer/pipelines/glRuntime.js` does not exist; the actual module is `src/js/services/pipelines/glRuntime.js`, imported by `viewerPipelines.js:5` as `createGlRuntime`
> - `src/js/shared/blobImage.js` (52 lines)
>
> Purpose: exact function names, sequencing, promises, and surgical hook points for diagnostic telemetry covering image loading → active/bridge handoff → canvas resize → texture upload → WebGL shader execution → paint completion.

---

## 0. Architecture overview

```
Core.onStateChange(state)
  │
  ├─► viewerRender.js: createViewerRenderer()
  │     pool of <img> (.viewer-img) → active (.active) + retiring (.bridge)
  │     decode → _activatePoolNode() → _syncActiveImage() → onActiveImageChanged(el)
  │
  ├─► viewer.js:21-24 callback
  │     onActiveImageChanged(el) → pipelines.setSource(img) | pipelines.clear()
  │
  └─► viewerPipelines.js: createViewerPipelines(viewportState)
        _applyScaling() → createGlRuntime() | createLanczosPipeline() | null (plain <img>)
        _scheduleTransform() → _applyTransform() → glRuntime.render()
        _triggerRender()     → lanczosPipeline.render() (delayed 80ms)
        _syncLivePump()      → SVG DOM pump | WebCodecs ImageDecoder pump (animated/SVG + filter/lanczos)
        glRuntime.render() → blobImage.getCleanImage() → texImage2D → multi-pass drawArrays → return true

viewer.js:29-38 ResizeObserver ─► viewportState.handleViewportResize() + pipelines.forceRender()
viewportState.subscribe() ─► (a) viewerRender.js:476-484 CSS transform sync, (b) viewerPipelines.js:593-597 re-render
```

Three independent subscription domains:

| Domain | Subscriber | Trigger | File:line |
|---|---|---|---|
| State → DOM images | `Core.onStateChange` in renderer | new `state.src`, archive change, fit/spread change | `viewerRender.js:315` |
| State → pipelines | `Core.onStateChange` in pipelines | filter / `isAnimated` / scaling / anime4k variant change | `viewerPipelines.js:576` |
| Geometry → paint | `viewportState.subscribe` ×2 | pan / zoom / rotate / flip / resize | `viewerRender.js:476`, `viewerPipelines.js:593` |
| Resize → geometry+render | `ResizeObserver` | `#viewport` contentRect change | `viewer.js:29-38` |
| Context recovery | `webglcontextlost/restored` | GPU context loss | `viewerPipelines.js:34-46` |

---

## 1. Bootstrap wiring in `viewer.js`

| Step | Code | Notes |
|---|---|---|
| 1 | `createViewportState({getViewport})` (`viewer.js:6-18`) | `getViewport` reads `#viewport.getBoundingClientRect()`; fallback 1000×1000 |
| 2 | `createViewerPipelines(viewportState)` (`viewer.js:20`) | Owns `lanczosCanvas`, `filterCanvas`, `pipeline`, live pump; returns `{setSource, forceRender, clear}` |
| 3 | `createViewerRenderer(viewportState, cb)` (`viewer.js:21-24`) | `cb = (img) => img ? pipelines.setSource(img) : pipelines.clear()`. This is **the single active/bridge → pipeline handoff**. Telemetry hook: wrap this callback |
| 4 | `createViewerGestures(viewportState)` (`viewer.js:25`) | Cursor auto-hide only; not in paint path |
| 5 | `ResizeObserver` (`viewer.js:29-38`) | On `width>0 && height>0`: `viewportState.handleViewportResize(w,h)` then `pipelines.forceRender()`. No debounce here, as it fires per RO entry |
| 6 | `Viewer` facade (`viewer.js:48-67`) | `applyFitMode`, `handleViewportResize`, `zoomAt/zoomCenter`, `panBy`, `rotate`, `flip`, `setZoom`, `toggleCursorAutoHide` |

Ordering guarantee: pipelines instance exists before renderer callback can fire, so `setSource` never runs on an uninitialized pipeline.

---

## 2. Image loading lifecycle in `viewerRender.js`

### 2.1 Pool init (once, `createViewerRenderer:11-36`)

- `_activeNodes: Map<poolSrc, HTMLImageElement>`, `_freeNodes: []`, capacity `VIEWER_IMAGE_POOL_CAPACITY = 4` (`viewerRender.js:7`).
- Reuses existing `.viewer-img:not(.is-placeholder)` nodes, caps at 4, creates missing `<img decoding=async crossorigin=anonymous draggable=false>`.

### 2.2 `Core.onStateChange` state machine (`viewerRender.js:315-474`)

Exact sequence per state emission:

1. **Archive guard** (`318-324`): `isArchive = state.mode==='archive'`; `archiveChanged || exitedArchive` → `clearDisplayedImage()` (full pool recycle + `onActiveImageChanged(null)`). Updates `_lastRenderedArchivePath`.
2. **Generation bump** (`326`): `generation = ++_poolGeneration`; `_clearScheduledPreloads()` cancels pending neighbor `setTimeout`s and nulls `onload/onerror` on in-flight `new Image()` preloaders.
3. **Empty guard** (`329-332`): `mode==='empty' || !state.src || !list.length` → `clearDisplayedImage(); return`.
4. **Desired-set computation** (`334-338`):
   ```js
   desiredSrcs = { state.src, [img.dataset.poolSrc if visible], ...neighborEntries(state, index, PRELOAD_HALF=1) }
   ```
   `FsUtils.neighborEntries` = prev + next.
5. **Pool reconcile** (`340-344`): `_trimActiveNodes(desiredSrcs)` recycles anything outside set; `_getPoolNode(src)` for each desired src (pop free list or create; `removeAttribute('src')`; attach `load` handler once via `data-load-attached`).
6. **Change detection** (`346-350`):
   ```js
   activeEl = _activeNodes.get(state.src)
   isReload = _forceReloadTarget   // set by 'quivit-refresh-start' event, 307-313
   activeChanged = state.src !== _activeTargetSrc || isReload
   hasPreviousBridge = !isReload && img && img !== activeEl && _isVisibleImage(img)
   ```

### 2.3 Active-change branch (`352-444`), the load path

| Sub-step | Lines | Detail |
|---|---|---|
| a. Bookkeeping | `353-358` | `_activeTargetSrc = state.src`; `_forceReloadTarget=false`; `_clearTargetLoadTimer()`; `activation = ++_activationGeneration`; `Statusbar.setImage({isLoading:true})`; `activeEl.alt='Loading...'` |
| b. Fast-path probes | `360-364` | `isAlreadyLoaded = !isReload && activeEl.complete && naturalWidth>0`; `isCacheWarm = !isAlreadyLoaded && thumbnailCache.has(src)`. Loading animation (`_startLoadingAnimation`, 250 ms dot timer) only if **neither** |
| c. No-bridge pre-attach | `366-374` | If `!hasPreviousBridge`: strip `.active` from old `img`, assign `img=activeEl`, add `.active` immediately (avoids blank flash when there is nothing to bridge over) |
| d. Debounce decision | `440-444` | If `hasPreviousBridge && !isAlreadyLoaded && !isCacheWarm` → `setTimeout(loadTarget, TARGET_LOAD_DEBOUNCE_MS=45)`; else `loadTarget()` synchronously |
| e. `loadTarget()` guard | `377-380` | `if (activation !== _activationGeneration \|\| Core.getState().src !== state.src) { _stopLoadingAnimation(); return; }`. Stale navigation bails |
| f. URL resolution + assign | `383-396` | `isReload` → cache-bust `?_t=ts`; `state.isAnimated` → `?_reset=Date.now()` (forces GIF restart); else reuse `thumbnailCache.get(src)` blob URL if `blob:`; then `_loadPoolNode(activeEl, newSrc, state.src)` (`210-215`, no-op if `src` already equal) |
| g. Decode wait | `398-418` | `skipDecode` for `.ico`/`.svg` (extension or query match). `ready = !isReload && complete && (naturalWidth>0 \|\| skipDecode)`. Promise branches: `ready\|\|!activeEl` → `Promise.resolve()`; `!decode\|\|skipDecode` → manual `load/error` listener promise; else `activeEl.decode()` |
| h. Resolve | `420-427` | `.then`: re-check `activation`/current src → `_stopLoadingAnimation()` → `_activatePoolNode(activeEl, filename, state)` → `_schedulePoolPreloads(neighborSrcs, generation)` |
| i. Reject | `428-437` | `.catch`: same guards → `_activatePoolNode(...'Failed to load...')` → `Statusbar.setImage({isError:true})` → schedule preloads |

### 2.4 No-change branch (`445-447`)

Only `_schedulePoolPreloads(neighborSrcs, generation)`; neighbor prefetch still refreshes.

### 2.5 Fit/spread sync (every state, `449-473`)

- `fitModeGen` change → `_applySvgBounds(img)` + `viewportState.applyFitMode(...)`.
- `spreadEnabled/Direction` change → `viewportState.setSpread*` + re-`applyFitMode` if `img.src`.
- `spreadStep` change → `viewportState.setSpreadStep`.

### 2.6 Neighbor preloads (`_schedulePoolPreloads:265-292`)

- Per neighbor: `setTimeout(100 + index*45ms)`, generation-guarded.
- Blob reuse: `thumbnailCache.get(src)` if `blob:` → avoids redundant `quivit://` fetch.
- `new Image(); decoding=async; crossorigin=anonymous; onload/onerror` → splice out of `_preloadImages`, `removeAttribute('src')`; `preloader.decode().catch(()=>{})` fire-and-forget.

### 2.7 Sync-to-pipeline (`_syncActiveImage:120-147`)

Called from two places: `_attachLoadHandler`'s `load` event (`149-157`, only if `el===img`) and `_activatePoolNode` (`247`).

1. `_applySvgBounds(el)` (`86-118`), see §2.8.
2. `Core.setImageDimensions(natW, natH)`.
3. Spread snapshot → `viewportState.setSpreadEnabled/Direction/Step`.
4. `viewportState.applyFitMode(fitMode, natW, natH, clientW, clientH)`.
5. `Statusbar.setImage({filename, dims, zoom})` + `syncSpreadIndicator`.
6. **`onActiveImageChanged(el)`** → `viewer.js:21-24` → `pipelines.setSource(img)`. This is the exact DOM→pipeline handoff. Null path (`_recyclePoolNode:195`, `clearDisplayedImage:304`) calls `onActiveImageChanged(null)` → `pipelines.clear()`.

### 2.8 SVG bounds special case (`_applySvgBounds:86-118`)

- Strips prior `--svg-base-w/h`, `data-svg-bounds`.
- `naturalWidth<=0` → synthesize 1000×1000 + set CSS vars + attribute.
- Dimensionless SVG (`clientWidth===0 && src includes .svg`) → scale to 50% viewport, set CSS vars, re-read `clientWidth/Height`.
- Returns `{natW, natH, clientW, clientH}`.

---

## 3. Active / bridge image handoffs in `viewerRender.js:221-248, 58-67, 184-202, 217-219`

### 3.1 `_activatePoolNode(el, filename, state)`

```js
// viewerRender.js:221-248
if (img && img !== el) {
  _cancelRetiringNode();            // kill any prior bridge
  outgoing = img;
  outgoing.classList.remove('active');
  outgoing.classList.add('bridge'); // old frame stays painted underneath
  _retiringNode = outgoing;
  _retireRaf = requestAnimationFrame(() => {
    _retireRaf = requestAnimationFrame(() => {
      if (_retiringNode === outgoing) { outgoing.classList.remove('bridge'); _retiringNode = null; }
      _retireRaf = null;
    });
  });                               // double-rAF ≈ 2 frames of crossfade coverage
}
img = el;
img.dataset.played = 'true';
img.classList.remove('bridge');
img.classList.add('active');
img.alt / img.title = filename;
viewportState.resetGeometry();
_syncActiveImage(img, filename, state);  // → pipelines.setSource(img)
```

### 3.2 Helpers

| Function | Lines | Behavior |
|---|---|---|
| `_cancelRetiringNode` | `58-67` | `cancelAnimationFrame(_retireRaf)`; strip `.bridge`; null `_retiringNode` |
| `_isVisibleImage` | `217-219` | `el && el.src && classList.contains('active')`, used for `hasPreviousBridge` |
| `_recyclePoolNode` | `184-202` | Cancels retire if recycling the bridge node; `removeAttribute('src/data-pool-src/data-played/data-scaling')`; strip `.active/.bridge`; if `el===img` → `img=null` + `onActiveImageChanged(null)`; delete from map, push to free list, `FsUtils.revokeIfObjectURL(src)`, enforce cap 4 |
| `_attachLoadHandler` | `149-157` | `load` → `if (el!==img) return; if (!el.src) return; _stopLoadingAnimation(); add .active; _syncActiveImage(...)`. This is the late-load path when `loadTarget` assigned src but decode raced ahead |

### 3.3 Bridge matrix

| Situation | `hasPreviousBridge` | Visual behavior |
|---|---|---|
| Fast nav, old image visible, new not cached | `true`, debounce 45 ms | Old keeps `.active`→`.bridge` only after decode resolves; 45 ms window lets rapid key-holds skip intermediate loads |
| Same-src state update | `false` (img===activeEl) | No bridge; in-place |
| Reload (`_forceReloadTarget`) | forced `false` | Old `.active` stripped immediately, no bridge |
| First image / empty→image | `false` (`img` null) | Direct `.active` attach (`366-374`) |

---

## 4. Canvas resize across three layers

### 4.1 Viewport resize (`viewer.js:29-38`)

```
ResizeObserver(#viewport) → viewportState.handleViewportResize(w,h) → pipelines.forceRender()
```

- Guards `width>0 && height>0`. Iterates all RO entries.
- `forceRender` (`viewerPipelines.js:619-627`): `_cancelRender()` (bump `_renderGeneration`, `pipeline.cancel()`, clear lanczos canvas 0×0) → if webgl `_applyTransform()` immediately else `_scheduleTransform()` → `_triggerRender()`.

### 4.2 WebGL canvas resize (`glRuntime.js:211-219`)

Inside every `render()` after texture upload:

```js
vpW = geometry.viewport.clientWidth; vpH = geometry.viewport.clientHeight;
if (canvas.width !== vpW || canvas.height !== vpH) {
  canvas.width = vpW; canvas.height = vpH;   // reallocates drawing buffer, clears it
  canvas.style.removeProperty('width'); canvas.style.removeProperty('height');
}
```

Drawing-buffer size always tracks CSS viewport size at draw time. Resize is implicit, with no separate resize API.

### 4.3 Lanczos canvas resize (`viewerPipelines.js:232-264`)

- Render deferred `setTimeout(80ms)`, generation-guarded.
- On `pipeline.render` result: `lanczosCanvas.width/height = res.width/height`; `2d.clearRect`; `drawImage(res.canvas)`; set/remove `--crop-left/top/w/h`; `setAttribute('data-render-ready','true')`.
- `_cancelRender:69-85` zeroes lanczos canvas (`width=0;height=0`, clearRect, remove crop vars + `data-render-ready`) on every new navigation/transform.

### 4.4 Live-pump staging resize

- Shared off-DOM `_liveStagingCanvas` (`viewerPipelines.js:29`): resized per tick (`372-373` SVG, `544-545` raster) to frame size; zeroed on `_stopLivePump:291-292` to release pixel buffer.
- SVG pump also sets `liveImg.width/height = sw/sh` (`376-377`) before `drawImage` to staging.

### 4.5 CSS transform sync (`viewerRender.js:476-484`)

`viewportState.subscribe`: `imgWrapper.style.transform = getTransform()`; `--zoom-scale = getScale()`; `Statusbar.setZoom(scale)` if `img.src`. Pure compositor path, with no re-upload.

---

## 5. Texture upload via `blobImage.js` and `glRuntime.js:170-209, 145-168`

### 5.1 `getCleanImage(src)` (`blobImage.js:18-46`)

Why: `quivit://` / `asset://` custom-protocol images are cross-origin and would taint canvas/WebGL. Fetch→blob→`createImageBitmap` yields a same-origin bitmap safe for `texImage2D`.

```js
cached = _textureCache.get(src)          // BoundedMap cap TEXTURE_CACHE_CAPACITY=1
if (cached) return cached.cleanImg       // sync-ish hit (async fn, resolved microtask)
if (_pendingSrc === src && _pendingPromise) return _pendingPromise  // in-flight dedup
_pendingSrc = src;
_pendingPromise = (async () => {
  resp = await fetch(src);
  blob = await resp.blob();
  cleanImg = await createImageBitmap(blob);
  if (_pendingSrc !== src) { cleanImg.close(); return null; }  // superseded
  _textureCache.set(src, { cleanImg });   // evicts prior via _evictEntry → cleanImg.close()
  return cleanImg;
})();
```

- `getCleanImageCrop(src,sx,sy,sw,sh)` (`48-52`): uncached `fetch→blob→createImageBitmap(blob,sx,sy,sw,sh)`. Currently no callers exist in the five files (reserved for tiled/crop uploads).

### 5.2 Static upload in `glRuntime.render(imgElement, geometry, skipUpload=false)` (`170-209`)

1. `nw = naturalWidth||width; nh = naturalHeight||height`; bail `null` if ≤0.
2. `token = _cancelToken`.
3. `cleanImg = await getCleanImage(imgElement.src)`. This is **the only await in the static path**; `catch → return null`.
4. Stale check: `!_active || token!==_cancelToken || !cleanImg → null`.
5. Dimension check on bitmap (`naturalWidth||width`).
6. `sourceIdentity = src|nw|nh`; if changed or no texture: delete old GL texture, `createTexture`, set `LINEAR/LINEAR/CLAMP`, `texImage2D(..., cleanImg)` (allocation + upload), store `_texSrc`. If identity matches, **skip re-upload** (critical for pan/zoom perf).
7. `catch texImage2D → warn + return null`.

### 5.3 Live-pump upload `updateSource(canvasOrImage)` (`145-168`)

- Identity fixed `'live_pump'`; creates texture once, then `texImage2D` **every frame** from `_liveStagingCanvas`. No `getCleanImage`, no CORS issue (2D canvas is clean).
- Called per pump tick before `render(..., skipUpload=true)` which bypasses §5.2 entirely.

---

## 6. WebGL shader execution in `glRuntime.js` and `viewerPipelines.js:100-211`

### 6.1 Runtime creation (`createGlRuntime(canvas):3-68`)

- `canvas.getContext('webgl2', {antialias:false, preserveDrawingBuffer:false, alpha:true, premultipliedAlpha:true})`. Null → warn + stub `{render:()=>Promise.resolve(null), ...}` (telemetry: stub path means all filter renders silently no-op).
- Fullscreen-triangle `posBuffer` (2 tris, 6 verts). `_programs=[]`, `_fbos: Map`, `_savedTextures: Map`.

### 6.2 Filter install (`setFilter(filterModule):103-143`)

From `viewerPipelines._applyScaling:157-165,170-178` with `getFilterModule(activeFilter, frontend_data)` or `lanczosWebGlModule`.

1. Delete old programs, `clearFbos()`.
2. Per `pass in filterModule.passes`: `linkProgram(pass.fsSource)` (`compileShader` vertex+fragment → attach → link; errors to console, null-skipped) → capture `a_position`, `u_renderTargetFlipY`, standard uniforms (`u_texture/viewport/imageSize/inputSize/scale/translate/rotation/flip`), `pass.init(gl, prog, customLocs)` → push `{program, name, space, outputScale, save, input, ...}`.

### 6.3 Scaling→pipeline decision (`_applyScaling:100-185`)

```js
scaling = getEffectiveScaling(mode, isAnimated, isSvg)
activeFilter = _resolveActiveFilter(live)   // null if none; anime4k+SVG → null fallback
useWebGlForLanczos = scaling==='lanczos' && isAnimated && !isSvg && activeFilter===null
usesWebgl   = activeFilter!==null || useWebGlForLanczos
usesLanczos = scaling==='lanczos' && !usesWebgl
```

- Sets `_activeSource.dataset.scaling`; clears `#viewport[data-filter]` if `!usesWebgl`; clears lanczos canvas if `!usesLanczos`.
- Rebuild cases: type mismatch (`webgl`↔`lanczos`), none→some; dispose + `_teardownWebglCanvas` when dropping to plain.
- Filter/variant/scaling change on existing webgl pipeline → `setFilter` in place; resets `_livePumpLastDrawnFrameIndex`.

### 6.4 Frame render (`glRuntime.render:170-321`)

Post-upload (or `skipUpload`):

1. Canvas sync (§4.2).
2. `geomExt = {nw,nh,scale,tx,ty,rotation,flipX/Y}`, `vpExt = {width:vpW,height:vpH}`; bind `posBuffer`; `currentInputTex=_sourceTexture`, `_savedTextures.clear()`.
3. Per program `i`:
   - Resolve inputs (`source`/`previous`/saved name; missing → warn + `return null`).
   - `outW/H`: viewport size, or `inW/H*outputScale` when `space==='image'`.
   - Last pass → default framebuffer (`bindFramebuffer(null)`, `viewport(vpW,vpH)`); else `getFbo(pass_i_*, outW, outH)` (realloc only on size change; `RGBA/UNSIGNED_BYTE`, `LINEAR/CLAMP`).
   - Clear transparent, `useProgram`, bind textures (`u_tex{j}` for multi-input else `u_texture=0`), set all standard uniforms + `u_renderTargetFlipY` (1.0 last, −1.0 intermediate) + `pass.applyUniforms(...)`.
   - `enableVertexAttribArray/vertexAttribPointer/drawArrays(TRIANGLES,0,6)`.
   - Non-last: stash `{tex,w,h}` as `currentInputTex`, plus `_savedTextures` if `pass.save`.
4. `return true` (sync tail after async upload; caller `.then` marks ready).

### 6.5 Static-path invocation

- `_applyTransform:187-202` guards: webgl only, non-animated, source `complete && naturalWidth>0`. `pipeline.render(src, geom).then(ok => gen match && ok → filterCanvas[data-render-ready], viewport[data-filter])`. Stale generations dropped.
- `_scheduleTransform:204-211`: `_rafPending` coalescing; single rAF → `_applyTransform`.
- Triggers: `setSource` (`615`), `forceRender` (`621-622` direct `_applyTransform`), `Core.onStateChange` filter change (`586`), `viewportState.subscribe` pan/zoom (`595`), `webglcontextrestored` (`42`).

### 6.6 Lanczos (CPU) path (`_triggerRender:213-265`)

Only when `usesLanczos && _activeSource`: 80 ms `setTimeout` → `await pipeline.render(src, geom)` (`createLanczosPipeline`) → blit to `#viewer-lanczos-canvas` + crop CSS vars + `data-render-ready`. No WebGL, no `getCleanImage`.

---

## 7. Paint completion

| Path | Completion signal | Where |
|---|---|---|
| Plain `<img>` (no filter, no lanczos) | `.active` class + compositor transform; no canvas marker | `viewerRender.js:242, 371-372` |
| WebGL static | `filterCanvas[data-render-ready='true']` + `#viewport[data-filter=<id\|'lanczos'>]` | `viewerPipelines.js:197-199` |
| WebGL live pump (first frame) | Same attributes on first pumped frame (`pumpVisible` latch) | `viewerPipelines.js:391-395` (SVG), `560-565` (raster) |
| Lanczos CPU | `lanczosCanvas[data-render-ready='true']` + `--crop-*` vars | `viewerPipelines.js:260` |
| Teardown/reset | `removeAttribute('data-render-ready')`, `removeAttribute('data-filter')`, zero canvas | `_cancelRender:74`, `_teardownWebglCanvas:89`, `clear:637-638` |
| Loading/error chrome | `Statusbar.setImage({isLoading})` / `{isError:true}` | `viewerRender.js:357, 435` |

`render()` resolves `true` on drawn, `null` on any bail (inactive, no programs, bad dims, stale token, fetch/bitmap/tex failure, missing input). Callers treat `null` as silent no-paint with no retry, because the next geometry/state change re-triggers.

---

## 8. Promise / async inventory (exact)

| # | Promise | Producer | Consumer | Stale guard |
|---|---|---|---|---|
| P1 | `activeEl.decode()` or manual load/error promise or `Promise.resolve()` | `viewerRender.js:402-418` | `.then → _activatePoolNode` (`420-427`); `.catch → error activate` (`428-437`) | `activation!==_activationGeneration || Core.getState().src!==state.src` checked in both continuations + at `loadTarget` entry |
| P2 | `preloader.decode().catch(()=>{})` | `viewerRender.js:288` | Fire-and-forget warmup | Generation check before creating preloader (`269`) |
| P3 | `pipeline.render(src, geom)` (webgl static), async only due to `await getCleanImage` | `glRuntime.js:170` | `_applyTransform().then(ok=>...)` (`viewerPipelines.js:194-201`) | `gen!==_renderGeneration` drop; internal `token!==_cancelToken` drop |
| P4 | `await pipeline.render(src, geom)` (lanczos, inside 80 ms timeout) | `viewerPipelines.js:234,240` | Blit to lanczos canvas | `gen!==_renderGeneration` checked before and after await |
| P5 | `fetch(src)→blob()→createImageBitmap()` inside `getCleanImage` | `blobImage.js:24-43` | `glRuntime.render` static upload | `_pendingSrc!==src` → close bitmap, return null; `_cancelToken` re-check after await |
| P6 | `fetch(currentSrc)→blob()` SVG pump setup + `new Promise(onload/onerror)` on `#viewer-svg-pump` | `viewerPipelines.js:319-334` | Enters `pumpTickSvg` rAF loop | `_livePumpSrc!==currentSrc` after each await; early return hides pump img |
| P7 | `decoder.completed` + per-tick `decoder.decode({frameIndex})` | `viewerPipelines.js:430,511` | `pumpTick` staging draw → `updateSource` + `render(skipUpload)` | `_livePumpSrc!==currentSrc` after `completed` and after each `decode`; `try/catch → return` (stop pump) |

No `async/await` on `_activatePoolNode`, `_syncActiveImage`, `setSource`, `_applyTransform` body (it chains `.then`), `updateSource` (sync `texImage2D`), `setFilter`/`compileShader`/`linkProgram` (sync GL).

---

## 9. Generation / cancellation tokens (must log all five)

| Token | Bumped in | Checked in | Meaning |
|---|---|---|---|
| `_poolGeneration` | `viewerRender.js:298` (clear), `326` (every state) | `_schedulePoolPreloads` timer body (`269`) | Pool membership epoch |
| `_activationGeneration` | `299`, `356` | `loadTarget` entry (`377`), P1 continuations (`421,429`) | Target-image activation epoch |
| `_renderGeneration` | `_cancelRender` (`viewerPipelines.js:70`), called from `setSource`, `forceRender`, `clear`, state change, geometry change, context-restored | `_applyTransform` continuation (`195`), `_triggerRender` timeout + post-await (`235,241`) | Render epoch |
| `_cancelToken` (+`_texSrc=null`) | `glRuntime.cancel()` (`328-331`) ← `_cancelRender:71` | `render` post-`getCleanImage` (`184`) | In-flight GL upload epoch |
| `_livePumpSrc` (+`_livePumpRaf`, decoder close) | `_syncLivePump` / `_stopLivePump` (`269-313`) | Every pump await/tick (`320,322,335,420,445,481,517`) | Live-pump session identity |

---

## 10. Surgical hook points for diagnostic telemetry (H1 through H16)

Conventions: `t0 = performance.now()` at entry; log `{evt, src, gen, ms}`; prefer `performance.mark/measure` + a single `debugLog` funnel so hooks add ~0 overhead when disabled. All hooks are additive, with no behavior change.

**H1: State entry (renderer).** `viewerRender.js:315` top of `Core.onStateChange`: mark `state-received {src, mode, index, fitModeGen, isAnimated}`. Pair with H5 to get load-to-activate latency. Also log early-return paths (`330` empty, `322` archive-clear).

**H2: Pool reconcile.** `viewerRender.js:340-344` around `_trimActiveNodes`/`_getPoolNode`: count `{desired, activeNodes.size, freeNodes.length, recycled}`. Detects pool thrash (cap-4 evictions via `_recyclePoolNode:200`).

**H3: Debounce + URL resolution.** `viewerRender.js:360-364` (`isAlreadyLoaded/isCacheWarm/hasPreviousBridge`) and `383-396` (`newSrc` choice: `_t` vs `_reset` vs thumbnail blob vs raw): log `{isAlreadyLoaded, isCacheWarm, hasPreviousBridge, debounced:bool, newSrcKind}`. This is where "why did navigation wait 45 ms / refetch" is answered.

**H4: DOM assign → decode.** Wrap `_loadPoolNode` (`210-215`) with `assign-t0`; wrap P1 creation (`402-418`) with `decode-start {strategy: ready|listener|decode()|skip}` and both continuations (`420`, `428`) with `decode-end {ms, ok}`. Add `el.addEventListener('error')` counter alongside `_attachLoadHandler:150`.

**H5: Activate / bridge handoff.** `_activatePoolNode:221-248`: log `{outgoing:!!, bridgeMs}`, recording timestamp at `.bridge` add, second timestamp in double-rAF body (`229-235`); log `_cancelRetiringNode:58` hits (interrupted bridges = fast nav). Pair H1→H5 = **state-to-active latency**; H4→H5 = **decode-to-paint-ready (DOM)**.

**H6: DOM→pipeline handoff.** `_syncActiveImage:146` (`onActiveImageChanged(el)`) and `viewer.js:21-24` callback: log `{el.src, naturalWidth/Height, dataset.scaling}`; null path (`_recyclePoolNode:195`, `clearDisplayedImage:304`) logs `pipeline-clear`. Wrap `pipelines.setSource` entry (`viewerPipelines.js:600`): log `same-img-refresh` (`601-607`) vs full switch (`609-617`).

**H7: Resize.** `viewer.js:29-38` RO body: log `{w,h, entries:n}` + `forceRender` entry/exit; `viewerPipelines.js:619-627` branch taken (`_applyTransform` direct vs `_scheduleTransform`). Pair with H12 to catch buffer-realloc cost per resize.

**H8: Scaling decision.** `_applyScaling:100-185`: log `{scaling, activeFilter, useWebGlForLanczos, usesWebgl, usesLanczos, needsNewPipeline, filterChanged, variantChanged, scalingChanged, pipeline.type}`. Single most valuable hook for "why is there no GL output" (e.g. anime4k+SVG→null at `_resolveActiveFilter:65`).

**H9: Transform coalescing.** `_scheduleTransform:204-211` (`coalesced` when `_rafPending`) + `_applyTransform:187-202` guard exits (`!webgl`, animated, `!complete`, `naturalWidth<=0`) with distinct reasons; continuation (`194-201`) logs `{ok, gen-match, ms}`. Measures static-GL frame latency.

**H10: Texture cache.** `blobImage.js:18-46`: `cache-hit` (`19-20`), `pending-dedup-hit` (`21`), `fetch-start/end`, `bitmap-start/end`, `stale-discard` (`30-33`), `evict` (`_evictEntry:8-11`, note cap=1 → every src change evicts). High evict rate + slow `fetch→bitmap` = upload-bound.

**H11: GL upload.** `glRuntime.js:179-209`: log `upload-start`, `upload-end {ms, reusedTexture:bool, cleanW/H}`; `texImage2D` catch (`203-206`) with error; `updateSource:145-168` per-frame `texImage2D` duration in pump path (sample 1/N frames to avoid spam).

**H12: Canvas realloc.** `glRuntime.js:214-219` branch taken (`{vpW,vpH, reallocated}`); lanczos blit (`viewerPipelines.js:242-261`) `{w,h, crop?}`; `_cancelRender:74-84` resets. Realloc clears the buffer; back-to-back reallocs explain flicker.

**H13: Shader build.** `compileShader:31-41` (`{name, type, ms, ok}` + info log on fail), `linkProgram:43-56`, `setFilter:103-143` (`{passes, skippedNull}`), `pass.init` duration, `getFbo:78-101` reallocs. Hook once per filter change, not per frame.

**H14: Draw.** `glRuntime.js:242-318` per-`render`: `{programs:n, space/outputScale per pass, outW/H, isLast, missing-input-abort (239-240), ms}`; `return true` vs `return null` with reason code (map each `return null`: no-programs, bad-dims, stale-token, bitmap-fail, tex-fail, missing-input). This is **shader-execution completion**.

**H15: Paint markers.** Observe `data-render-ready` sets (`viewerPipelines.js:197,393,562,260`) and removals (`75,89,122,229,611,408,436,453`) + `data-filter` sets/removals via `MutationObserver` in dev harness, or direct log lines. H1→H15 = **state-to-paint (all paths)**; H9/H14→H15 = **render-to-paint**.

**H16: Live pump.** `_syncLivePump:295-313` (`useLivePump`, early-out reasons), SVG setup (`319-338`), `pumpTickSvg:345-399` (sampled: `{sw,sh, ms-draw, ms-render}`), raster setup (`419-464`: `decoder.completed` ms, `frameCount<2` fallback), `pumpTick:480-573` (`{frameIndex, frameChanged, frameDurationMs, geomHash-changed, skipped-render (522-527), ms-decode/draw/render}`). Also `_stopLivePump:269` reason (src change vs `useLivePump=false` vs `clear`).

**Error-only hooks (cheap, always on):** `decode .catch (428)`, `texImage2D warns (166,204)`, `ImageDecoder fail (432)`, `decode-per-tick fail (513-516)`, `missing-input warn (238)`, `compile/link errors (36,52)`, `webglcontextlost (34)` / `restored (37)`, `Statusbar isError (435)`.

### Minimal event schema (suggested)

```js
{ t: performance.now(), evt: 'state→active|render|paint|...', src, gen:{pool, act, render}, ms, detail:{...} }
// Correlate by src + activation generation; render epoch links H9/H14/H15; live frames link by _livePumpSrc + frameIndex.
```

### Smallest useful first slice

If instrumenting incrementally: H1 + H5 + H8 + H10 + H14 + H15. Those six points alone yield state→active latency, pipeline-type decision, cache/upload cost, shader result, and end-to-end paint, enough to attribute any "image stuck / black canvas / slow switch" report to DOM-load vs decision vs upload vs shader vs present.

---

## 11. Function index (per file)

- `viewer.js`: `createViewportState.getViewport`, `pipelines.setSource/clear` (via callback), `ResizeObserver` callback, `_getViewportCenter`, `Viewer.{applyFitMode,handleViewportResize,zoomAt,zoomCenter,panBy,rotate,flipHorizontal,flipVertical,setZoom,toggleCursorAutoHide}`
- `viewerRender.js`: `createViewerRenderer`, `_cancelRetiringNode`, `_startLoadingAnimation`, `_stopLoadingAnimation`, `_applySvgBounds`, `_syncActiveImage`, `_attachLoadHandler`, `_getPoolNode`, `_recyclePoolNode`, `_trimActiveNodes`, `_loadPoolNode`, `_isVisibleImage`, `_activatePoolNode`, `_clearTargetLoadTimer`, `_clearScheduledPreloads`, `_schedulePoolPreloads`, `clearDisplayedImage`, `quivit-refresh-start` listener, `Core.onStateChange` callback, `loadTarget` closure, `viewportState.subscribe` callback
- `viewerPipelines.js`: `createViewerPipelines`, `isSvgSource`, `_resolveActiveFilter`, `_cancelRender`, `_teardownWebglCanvas`, `_applyScaling`, `_applyTransform`, `_scheduleTransform`, `_triggerRender`, `_stopLivePump`, `_syncLivePump`, `pumpTickSvg`, `pumpTick`, `Core.onStateChange` callback, `viewportState.subscribe` callback, `setSource`, `forceRender`, `clear`
- `glRuntime.js`: `createGlRuntime`, `compileShader`, `linkProgram`, `clearFbos`, `getFbo`, `setFilter`, `updateSource`, `render`, `resolveInput` (nested), `cancel`, `dispose`
- `blobImage.js`: `_evictEntry`, `getCleanImage`, `getCleanImageCrop`
