> **Architecture and Implementation Validation**
> This audit was reviewed against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md`. All line references and structural findings reflect the current working tree after Slices 0.1, 0.2, 1.1, 1.2, 2.1, 2.2, and upstream bug fix 9449c59 integration.

# Zone 2 architectural and performance audit: media viewer, continuous manhwa strip, viewer math, and WebGL scaling pipelines

This audit inspects Zone 2 of the QuiviT codebase prior to the planned refactoring and decoupling branch. The audit covers twenty-two runtime modules and two contract probe files across the media viewer, continuous manhwa strip, coordinate math, WebGL runtime, filters, and scalers.

## Validate-changes compliance findings

Every assigned file was evaluated against the rules in `.agents/AGENTS.md` and the checklist in `.agents/skills/validate-changes/SKILL.md`. Findings are classified by severity.

### CSS source of truth

`.agents/AGENTS.md` mandates that CSS remains the visual source of truth. JavaScript must not set intrinsic visual properties like width, height, display, cursor, or color through inline style assignments. Allowed writes are limited to CSS custom properties on host nodes or root, viewport and virtualization transform matrices, classList tokens, and dataset attributes.

- `src/js/viewer/viewerRender.js:170-174` `[Nit]`
  `node.style.setProperty` writes `--bridge-tx`, `--bridge-ty`, `--bridge-rot`, `--bridge-sx`, and `--bridge-sy` to freeze geometry on `#viewer-bridge-layer`. Lines 287-291 clean them up with `removeProperty`. No intrinsic visual properties are mutated inline.

- `src/js/viewer/viewerRender.js:353-354` and `366-367` `[Nit]`
  SVG dimensions write `--svg-base-w` and `--svg-base-h` via `setProperty`, and lines 344-345 clean them via `removeProperty`. No inline visual width or height is written.

- `src/js/viewer/viewerRender.js:535-536` and `542-543` `[Nit]`
  ICO row totals write `--ico-total-w`, `--ico-total-h`, `--grill-angle`, and `--slot-backdrop-angle` via `setProperty`. Line 978 writes `imgWrapper.style.transform` with the viewport matrix, and line 979 writes `--zoom-scale`. All assignments strictly follow the CSS custom property and transform matrix exception.

- `src/js/viewer/viewerPipelines.js:291-294` and `570-578` `[Nit]`
  Lanczos canvas positioning writes `--crop-left`, `--crop-top`, `--crop-w`, and `--crop-h` as CSS custom properties. Line 1878-1879 calls `_columnCanvas.style.removeProperty('width')` and `removeProperty('height')` after setting buffer dimensions on canvas attributes. No intrinsic CSS style properties are assigned.

- `src/js/viewer/manhwaStrip.js:499-500` `[Nit]`
  Per-slot dimensions are set via `--slot-width` and `--slot-height`. Lines 655-670 set `--strip-width`, `--strip-spacer-top`, and `--strip-spacer-bottom`. Lines 712 and 2949 set `--slot-backdrop-bg`. Lines 773-774 set `--grill-angle` and `--slot-backdrop-angle`. Lines 999-1004 set `--slot-grill-top` and `--slot-grill-height`. Strip positioning at lines 855, 2128, 2163, 2196, 2246, 2290, 2340, 2462, 2493, 2520, 2535, and 2881 mutates `_strip.style.transform` only. No intrinsic CSS styles are assigned.

- `src/js/viewer/manhwaAudio.js:173` `[Nit]`
  Audio pill positioning sets `rec.pill.style.transform` using virtualization transforms.

- `src/js/viewer/icoCells.js:29-32` `[Nit]`
  Per-size cells set `--ico-w`, `--ico-h`, and `--slot-backdrop-bg` through `setProperty`.

- `src/js/viewer/viewerAudio.js:54-82` `[Nit]`
  Audio state writes `aria-label`, `data-state`, and class tokens on `#btn-audio-toggle` and `#audio-volume-popover`. No inline style writes exist in this module.

### HTML-first rendering and DOM recycling

`.agents/AGENTS.md` requires static markup over runtime DOM creation for stable chrome and virtualization pools. Nodes must be recycled from pools instead of wiping and rebuilding containers.

- `src/js/viewer/manhwaStrip.js:688-694` and `380-385` `[Warning]`
  While `_acquireSlotNode` at line 697 recycles outer `.manhwa-slot` elements from `_freeSlotPool`, lines 380-385 create new `.ico-container` and `.ico-size` DOM trees on every mount of an ICO file using `createIcoContainer` and `createIcoCell` from `icoCells.js`. Line 553 explicitly notes that ICO containers detach instead of pooling. Every time an ICO slot scrolls into view, four to eight DOM elements are created with `document.createElement`, and upon scrolling out line 730 detaches and drops them to garbage collection.

- `src/js/viewer/manhwaStrip.js:192` and `201` `[Warning]`
  `_probeNeighborDimensions` creates unpooled ephemeral elements via `document.createElement('video')` and `new Image` for every unprobed neighbor during container entry. These elements attach load handlers and initiate decoding, but are not recycled or explicitly pooled.

- `src/js/viewer/manhwaStrip.js:641` and `647` `[Nit]`
  `_ensureStripSpacers` creates `#manhwa-strip-spacer-top` and `#manhwa-strip-spacer-bottom` with `document.createElement('div')` at runtime if missing. These two layout elements should be declared statically in `index.html` inside `#manhwa-strip`.

- `src/js/viewer/viewerRender.js:493-507` `[Warning]`
  `_renderIcoRow` destroys and reconstructs the legacy ICO row on every ICO file navigation. It calls `createIcoContainer` and `createIcoCell`, adds child nodes, and calls `row.replaceChildren` at line 520, dropping previous cells without recycling them.

- `src/js/viewer/viewerRender.js:610` `[Nit]`
  `_schedulePoolPreloads` instantiates a new `Image` object for every preloaded neighbor on every navigation step. Preloaders are pushed to `_preloadImages` and discarded on load rather than recycling a fixed preloader pool.

- `src/js/viewer/manhwaAudio.js:126` and `230` `[Warning]`
  `_buildPill` clones the `#manhwa-volume-template` DOM node for every visible video slot in the strip. When a video slot is scrolled out, line 230 executes `rec.pill?.remove`. As the reader scrolls through a long strip with multiple animated video panels, audio pills are repeatedly cloned and discarded rather than pooled in a bounded pill pool.

- `src/js/viewer/viewerPipelines.js:119`, `1522` `[Nit]`
  `loadSvgCanvas` and `_launchColumnSvgSession` allocate `document.createElement('canvas')` instances dynamically for rasterizing SVGs to textures rather than recycling a shared offscreen staging canvas.

### Module ownership and encapsulation

`.agents/AGENTS.md` establishes strict ownership boundaries. Domain logic and state machines must not query `document`. UI modules must not reach into private DOM structures of sibling modules.

- `src/js/services/pipelines/glRuntime.js:3-399` `[Nit]`
  `glRuntime.js` is clean. It does not query `document`, does not reference any UI modules, and receives its canvas instance via parameter. It contains no filter names or hardcoded shader catalog references. It receives filter passes as data objects.

- `src/js/services/pipelines/textureCache.js:1-276` `[Nit]`
  `textureCache.js` is clean. It does not query `document` or reference UI state. It manages WebGL textures by byte budgets and LRU order.

- `src/js/services/pipelines/quadCompositor.js:151-201` and `308` `[Warning]`
  `quadCompositor.js` does not query `document`. However, it breaks renderer agnosticism by hardcoding the `lanczos` scaler filter. Lines 151-201 embed `LANCZOS_FS_SOURCE` directly into the compositor source code, lines 277-285 compile `_lanczosProgram`, and line 308 contains `sampler === 'lanczos'`. A generic quad compositor must take shaders or programs from pipeline descriptors rather than hardcoding specific filter implementations.

- `src/js/viewer/manhwaStrip.js:2706` `[Blocking]`
  `manhwaStrip.js` directly reaches into `#manhwa-audio-overlay` with `document.getElementById('manhwa-audio-overlay')?.replaceChildren`. `manhwaAudio.js` is the sole owner of `#manhwa-audio-overlay`. The strip must inform `ManhwaAudio.clear` through its exported API instead of mutating the private overlay DOM container directly.

- `src/js/viewer/viewerPipelines.js:1052`, `1065`, `1080`, `1098`, `1696`, `1711`, `2402`, `2482` `[Warning]`
  `viewerPipelines.js` mutates `#viewport` classes `manhwa-warmup` and `manhwa-exit-warmup` and sets or removes the `data-filter` attribute on `#viewport`. `manhwaStrip.js` owns `#viewport.manhwa-active` mode, and `viewerRender.js` coordinates single image presentation. Having the WebGL pipeline reach into `#viewport` to write state tokens creates multiple writers for the root viewer surface.

- `src/js/viewer/viewerAudio.js:227-234` `[Warning]`
  `viewerAudio.js` queries `document.getElementById('viewer-video')` and `document.getElementById('viewer-video-b')` directly, attaching event listeners for `play` and `seeked`. Those video elements are owned by `viewerRender.js`. The renderer should notify audio state via callbacks or state changes rather than having audio reach into the renderer's DOM elements.

- `src/js/viewer/viewerRender.js:176`, `292-298` `[Warning]`
  `viewerRender.js` parks borrowed strip nodes inside `#viewer-bridge-layer`, and upon bridge retirement calls `node.remove` or returns it to the pool based on `node.dataset.borrowedBridge`. Cross-module ownership of physical DOM elements during transition creates shared mutation over nodes created in `manhwaStrip.js`.

---

## Monolithic file decoupling and ownership plan

The four largest files in Zone 2 span 7,446 total lines: `manhwaStrip.js` at 3,142 lines, `viewerPipelines.js` at 2,491 lines, `viewerRender.js` at 993 lines, and `viewerMath.js` at 820 lines.

Applying the single-owner split gate from `.agents/AGENTS.md`, files must not be split into sibling files that mutate the same DOM container. Instead, pure calculations, layout state machines, schedulers, and separate canvas owners must be extracted into dedicated modules.

```
       Current Architecture of Zone 2
+-------------------------------------------------------+
| viewer.js Facade                                      |
+-------------------------------------------------------+
    |                   |                   |
    v                   v                   v
+----------------+ +----------------+ +-----------------+
| viewerRender   | | viewerPipelines| | manhwaStrip.js  |
| 993 lines      | | 2,491 lines    | | 3,142 lines     |
| Pool, Video,   | | Single WebGL,  | | Strip DOM,      |
| Bridge, ICO    | | Multi-quad GL, | | Width Gate,     |
|                | | Pica Lanczos,  | | Prefetcher,     |
|                | | SVG/Video Pump | | Mount Queue     |
+----------------+ +----------------+ +-----------------+
         \              |              /
          v             v             v
+-------------------------------------------------------+
| viewerMath.js, 820 lines: Math and Viewport Store     |
+-------------------------------------------------------+
```

```
       Decoupled Target Architecture of Zone 2
+-------------------------------------------------------------------+
| viewer.js Thin Facade and Event Router                            |
+-------------------------------------------------------------------+
      |                   |                     |
      v                   v                     v
+----------------+ +-------------------+ +--------------------------+
| viewerRender.js| | Single Pipeline   | | manhwaStrip.js           |
| Single View    | | #viewer-filter-   | | Sole writer of           |
|                | | canvas            | | #manhwa-strip            |
+----------------+ +-------------------+ +--------------------------+
      |                   |                     |
      v                   v                     v
+----------------+ +-------------------+ +--------------------------+
| viewerBridge.js| | Column Pipeline   | | services/                |
| Sole writer of | | #manhwa-filter-   | | manhwaWidthGate.js       |
| #viewer-       | | canvas, multi-    | | services/                |
| bridge-layer   | | quad WebGL        | | manhwaMountScheduler.js  |
+----------------+ +-------------------+ +--------------------------+
         \                 |                 /
          v                v                v
+-------------------------------------------------------------------+
| services/viewportState.js Store: Scale, Pan, Fit, Spread          |
+-------------------------------------------------------------------+
| services/columnMath.js Pure Column Offsets, Windowing, Composite  |
+-------------------------------------------------------------------+
| services/audioDomain.js Shared Volume, Mute, and Probe Data Store |
+-------------------------------------------------------------------+
```

### Breakdown of responsibilities and extraction targets

#### 1. `src/js/viewer/manhwaStrip.js`, 3,142 lines

- `lines 66-170`, 105 lines: Width scan and width gate state machine.
  Owns container width estimations, IPC triggers `scan_container_max_width`, gate opening thresholds, and timeout fallbacks.
  *Target:* Move to `src/js/services/manhwaWidthGate.js`. Pure state machine with zero DOM writes. Emits callbacks when the gate opens or layout width updates.

- `lines 404-474` and `475-496`, 93 lines: Media classification, URL synthesis, and image index construction, including `_buildSrc`, `_isSvgEntry`, `_isAnimCandidateExt`, `_animArgsFor`, `_classifyAnimatedSlot`, and `_buildImageIndex`.
  *Target:* Move to `src/js/services/mediaClassification.js` or `src/js/services/stripDomain.js`. Pure functions that map file entry lists to typed slot metadata.

- `lines 1261-1445`, 185 lines: Prefetch engine and background warming, including `_prefetchVideo`, `_prefetchAhead`, `_warmBackendAhead`, and `_sortMountQueue`.
  *Target:* Move to `src/js/services/manhwaMountScheduler.js`. Pure scheduling logic calculating priority queues based on scroll direction and anchor proximity.

- `lines 1891-2155` and `2260-2536`, 462 lines: Scale calculations, fit mode resolutions, alignment transforms, and navigation commands, including `_resolveStripFitScale`, `_applyFitMode`, `alignListItemTop`, `alignListItemBottom`, `centerListItem`, `resetZoom`, `jumpManhwa`, `navigateManhwa`, and `pageStrip`.
  *Target:* Extract geometry and navigation math to `src/js/services/columnMath.js`. Post-zoom settled column height recomputation (`settledColH` / `settledColFits`) and sub-viewport centering routing with `targetTx` in alignment helpers belong in `columnMath.js`. Viewport focal centering remains cleanly delegated to `viewportState.js`.

- `lines 497-754`, `974-1260`, `1507-1862`, and `2538-2867`, 1,800 lines: Strip DOM pool, window virtualization, slot mounting, spacer management, and Core subscription.
  *Target:* Retain in `src/js/viewer/manhwaStrip.js` as the sole writer for `#manhwa-strip`.

#### 2. `src/js/viewer/viewerPipelines.js`, 2,491 lines

`viewerPipelines.js` combines two independent rendering engines into one file: single-image WebGL and continuous manhwa multi-quad WebGL. They write to entirely different canvases `#viewer-filter-canvas` and `#manhwa-filter-canvas`.

- `lines 33-133`, 101 lines: Multi-quad slot drawing math and SVG canvas rasterization, including `_drawSlotQuad` and `loadSvgCanvas`.
  *Target:* Move `_drawSlotQuad` to `src/js/services/pipelines/quadCompositor.js` or `src/js/services/pipelines/columnCompositor.js`.

- `lines 134-652` and `653-1184`, 1,051 lines: Single-image WebGL rendering, Lanczos scaling coordination, live video, SVG, and raster pump loops, plus the legacy ICO composite canvas.
  *Target:* Retain in `src/js/viewer/viewerPipelines.js` as the sole writer of `#viewer-filter-canvas` and `#viewer-lanczos-canvas`.

- `lines 1185-1780` and `1781-2408`, 1,224 lines: Continuous column WebGL rendering, column FBO allocation, ImageDecoder animated raster sessions, SVG pump sessions, live video texture updates, texture pinning, and composite multi-quad passes.
  *Target:* Extract into `src/js/viewer/manhwaColumnPipeline.js` as the sole writer of `#manhwa-filter-canvas`. It receives the column snapshot via callback and manages its own WebGL2 runtime and texture cache without touching single-image state.

#### 3. `src/js/viewer/viewerRender.js`, 993 lines

- `lines 156-218`, `284-324`, and `681-700`, 145 lines: Bridge layer management, including `#viewer-bridge-layer`, `_parkNodeInBridge`, `_parkHandoff`, `_releaseBridgeNode`, and `_cancelRetiringNode`.
  *Target:* Extract into `src/js/viewer/viewerBridge.js`. This creates a single dedicated owner for `#viewer-bridge-layer`, handling transition freezes, CSS custom properties, and fallback timers cleanly.

- `lines 478-550`, 73 lines: Legacy ICO row rendering, including `_renderIcoRow` and `_clearIcoRow`.
  *Target:* Consolidate ICO rendering with `icoCells.js` so both legacy single view and strip view use unified DOM pooling and canvas composite helpers.

- `lines 15-155`, `220-282`, `342-477`, `551-650`, and `681-974`, 775 lines: Image pool, video pool with `#viewer-video` and `#viewer-video-b`, SVG bounds, active image synchronization to Core and statusbar.
  *Target:* Retain in `src/js/viewer/viewerRender.js` as the sole owner of `#viewer-img-wrapper`.

#### 4. `src/js/services/viewerMath.js`, 820 lines

- `lines 403-741`, 339 lines: `createViewportState`.
  This is a stateful store managing scale, pan translation, rotation, flip, spread step, user transform locks, and observer subscriptions. It is not pure math.
  *Target:* Extract into `src/js/services/viewportState.js`. Focal coordinate defaulting to `(vp.left + vw / 2, vp.top + vh / 2)` belongs in `viewportState.js` to preserve zero horizontal translation drift when docked without layout thrashing.

- `lines 1-402` and `743-820`, 481 lines: Pure layout and coordinate calculations, including `checkIsSpread`, `icoSizesTotal`, `computeStripWidth`, `computeColumnOffsets`, `seamOverlapForScale`, `columnCenterY`, `columnCenterTy`, `findAnchorIndex`, `computeWindowRange`, `firstLastHighlight`, `computeTopAlignTy`, `computeBottomAlignTy`, `computeColumnComposite`, `invertViewport`, and `computeStripFitScale`.
  *Target:* Retain in `src/js/services/viewerMath.js` as purely functional, stateless calculation utilities.

#### 5. Audio logic unification between `viewerAudio.js` and `manhwaAudio.js`

`viewerAudio.js` at 288 lines and `manhwaAudio.js` at 281 lines currently duplicate:
- Volume and mute caching via `BoundedMap` with capacity 500
- Audio track probing and revision key cache via `BoundedMap` with capacity 500
- ISOBMFF probing via `_FsUtils.checkMediaAudio`
- Volume stepping arithmetic with two-decimal precision via `Math.round`
- `data-state` attribute mapping for muted, zero, low, high
- Accessibility label generation for Unmute Audio and Mute Audio

*Target:* Extract all shared data, probe caching, and state calculation into `src/js/services/audioDomain.js` with zero DOM dependencies.
`src/js/viewer/viewerAudio.js` imports `audioDomain.js` and exclusively owns `#viewer-audio` and viewport audio controls.
`src/js/viewer/manhwaAudio.js` imports `audioDomain.js` and exclusively owns `#manhwa-audio-overlay` and slot audio pills.
Neither module reaches into the other's DOM.

---

## Performance, layout thrashing, and GPU frame hot paths

### Forced synchronous layouts and layout thrashing

Layout reads interleaved with DOM or style writes force the browser to synchronously recalculate layout, stalling the main rendering thread.

1. `src/js/viewer/manhwaAudio.js:165-173`
   `_positionPill` performs:
   ```javascript
   const rect = targetEl.getBoundingClientRect();
   const vpRect = vp.getBoundingClientRect();
   rec.pill.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale}) translateY(-100%)`;
   ```
   `syncPills` iterates over `_attached.values` on window resize and slot movements, calling `_positionPill` sequentially. Each iteration reads element geometry and immediately writes `rec.pill.style.transform`. With multiple active video slots in view, this causes synchronous layout thrashing.
   *Remediation:* Batch all `getBoundingClientRect` reads first, compute target coordinates, then apply style transforms in a separate write phase.

2. `src/js/viewer/manhwaStrip.js:794`, `971`, `1007`
   Inside `_updateWindow` from line 1008 to 1250 and `_updateLayout` from line 798 to 874, the strip reads `_viewport.clientHeight` and `_viewport.clientWidth` while simultaneously mutating slot datasets, appending or removing slot children, and setting CSS variables on `_strip`.
   *Remediation:* `viewer.js` already maintains `_cachedViewport` updated via ResizeObserver at lines 65-76. `manhwaStrip.js` should read cached dimensions from `viewportState.getViewport` instead of querying `_viewport.clientHeight` on every pan, scroll, and layout tick.

3. `src/js/viewer/viewerRender.js:359-371`
   `_applySvgBounds` reads `el.clientWidth` and `el.clientHeight` at lines 359-360. If dimensions are zero, it writes `--svg-base-w` and `--svg-base-h` at lines 366-367, sets attribute `data-svg-bounds` at line 368, and immediately reads `el.clientWidth` and `el.clientHeight` again at lines 369-370. This write-read sequence triggers an immediate synchronous style and layout flush.
   *Remediation:* Compute dimensions directly from natural width and viewport bounding scale without reading `el.clientWidth` after writing CSS properties.

4. `src/js/viewer/viewerGestures.js:62-66`
   `_isMouseOverViewportNow` calls `document.elementFromPoint` on pointer movements. `elementFromPoint` forces a synchronous layout calculation if DOM mutations or style updates are pending.
   *Remediation:* Track mouse containment using pointerenter and pointerleave listeners on the viewport element, avoiding repeated calls to `elementFromPoint`.

5. `src/js/viewer/viewerGestures.js:220` and `236-264`
   `_startCursorPoll` schedules `setInterval(_pollCursor, 16)`. During keyboard panning, this fires a Tauri IPC request `window.__TAURI__.window.cursorPosition` every 16ms across the webview boundary. This introduces continuous IPC serialization overhead on the animation hot path.
   *Remediation:* Rely on standard window `pointermove` and `mousemove` capture when the pointer is inside the window, reserving IPC polling only when the pointer leaves window client bounds.

### GPU and frame hot paths in WebGL and scaling pipelines

1. **Object allocation in multi-quad composite draw list:**
   In `src/js/services/viewerMath.js:325-389` in `computeColumnComposite`, called every frame during strip scrolling from `viewerPipelines.js:1903`, the function allocates a new `drawList` array containing fresh heap objects for every visible slot. At 60-120fps, these repeated object allocations create continuous garbage collection pressure.
   *Remediation:* Recycle a bounded scratch pool of draw descriptor objects, similar to `_cachedDrawsScratch` in `viewerPipelines.js`.

2. **Per-frame video texture uploads:**
   In `src/js/viewer/viewerPipelines.js:2284-2300`:
   During manhwa strip playback of video slots, every frame calls `gl.texSubImage2D` on the main thread for every visible video element. Similarly, single view `pumpTickVideo` at lines 711-740 calls `glRuntime.updateSource(vEl)` every rAF tick. When video elements are paused or have not decoded a new frame, uploading textures across the WebGL bus wastes GPU memory bandwidth.
   *Remediation:* Track `video.currentTime` and upload only when the frame presentation timestamp actually advances.

3. **Await inside visible render loop during ImageDecoder decoding:**
   In `src/js/viewer/viewerPipelines.js:2129`:
   `const result = await s.decoder.decode({ frameIndex: target });`
   This `await` runs directly inside `_renderColumnInner` after determining visible draw slots. In direct-screen mode with lanczos, clearing the canvas prior to this `await` can cause the browser to composite a blank frame if decoding exceeds the frame budget. Lines 2077-2080 acknowledge this hazard in comments.
   *Remediation:* Decouple frame decoding from the WebGL draw pass. Decode upcoming animation frames ahead of time into a double-buffered queue so the render pass uploads already-decoded frames synchronously without awaiting.

4. **Redundant uniform and VBO updates in QuadCompositor:**
   In `src/js/services/pipelines/quadCompositor.js:317-346`:
   For every quad rendered via `drawQuad`, the compositor rebinds `_vbo`, executes `gl.bufferSubData`, re-enables vertex attributes, and calls `gl.uniform2f` and `gl.uniform1f`. In a manhwa strip with 10 visible slots, this performs 10 separate draw calls with individual buffer updates per frame.
   *Remediation:* Batch all quad vertices for the visible window into a single VBO upload, executing a single batched `gl.drawArrays` call for all quads sharing the same texture atlas or sampler program.

5. **CPU-bound Pica Lanczos jobs on pan:**
   In `src/js/services/scaling/lanczos.js:85-96`:
   Every transform update invokes `getCleanImageCrop`, which fetches, creates a blob, and calls `createImageBitmap`, then runs `resampler.resize` on a worker. When the user pans continuously, `cancel` increments `_generation` to discard stale results, but background workers continue executing intensive CPU resizing for canceled frames.
   *Remediation:* Debounce Lanczos resizing during continuous user pan gestures, rendering fast bilinear preview transforms until pan gestures settle.

---

## Memory lifecycle, VRAM disposal, and async races

### Lifecycle cleanup and disposal tracing

1. **WebGL texture and framebuffer disposal in `glRuntime.js`:**
   In `src/js/services/pipelines/glRuntime.js:72-78`, `clearFbos` iterates over `_fbos.values` and deletes textures and framebuffers via `gl.deleteTexture` and `gl.deleteFramebuffer`. When `dispose` is called at line 385, all programs, FBOs, and source textures are deleted.
   *Status:* Deterministic cleanup is implemented in `glRuntime.js`.

2. **Texture pool byte budgets in `textureCache.js`:**
   In `src/js/services/pipelines/textureCache.js:148-166`:
   When cache size exceeds `maxBytes`, with default 128 MB, LRU textures are deleted with `gl.deleteTexture`. Textures in `_pinnedKeys` are protected from eviction.
   *Hazard:* In `viewerPipelines.js:1551-1576`, `_columnLiveTextures` creates textures for live video and animated slots directly with `gl.createTexture` outside `textureCache.js`. These textures bypass the 128 MB VRAM budget tracking. While `_teardownColumn` at lines 1744-1748 cleans them up upon column teardown, rapid navigation inside long strips with many videos can temporarily inflate unmetered VRAM usage.

3. **ImageBitmap disposal in `blobImage.js`:**
   In `src/js/shared/blobImage.js:8-13`:
   `_textureCache` uses `BoundedMap` with capacity 4 and an eviction hook that calls `cleanImg.close`.
   *Hazard:* In `blobImage.js:48-52`, `getCleanImageCrop` creates an `ImageBitmap` from a blob without caching or tracking. It relies on the caller at `lanczos.js:115` to invoke `cleanImg.close` in a finally block. If any future callsite fails to close the bitmap, the underlying GPU texture memory leaks until garbage collection runs.

4. **Object URL lifecycles:**
   - In `src/js/services/archiveImageCache.js:41-55`:
     `_archiveBlobCache` uses `BoundedMap` with capacity 8 and limit 24 MB. When an entry is evicted, `_revokeBlobEntry` calls `URL.revokeObjectURL(value)`.
   - In `src/js/viewer/viewerPipelines.js:1380-1385`:
     `_closeColumnSvgSession` revokes `session.blobUrl` when the SVG slot exits view.
   - In `src/js/viewer/viewerPipelines.js:641-643`:
     `_stopLivePump` revokes `_livePumpBlobUrl`.

### Async race conditions

1. **45ms bridge swap timer versus double-rAF release race:**
   In `src/js/viewer/viewerRender.js:940-944`:
   When navigating while a bridge element is present, image loading is debounced by 45ms:
   `_targetLoadTimer = setTimeout(loadTarget, TARGET_LOAD_DEBOUNCE_MS);`
   However, in `viewerRender.js:187-193`, `_parkNodeInBridge` defaults to `autoRetire = true`, which schedules `_scheduleRetireRaf`, running a double `requestAnimationFrame`.
   At 60Hz, two rAF frames elapse in approximately 33ms.
   *Race condition:* The bridge element is removed from the DOM after ~33ms, but the debounced image loading has not executed its `loadTarget` callback yet at 45ms. This leaves a gap of ~12ms where neither the retiring bridge element nor the incoming image is active, producing a visible blackout frame. This directly triggers the blackout anomaly detector in `viewerPipelineProbe.js:267-283`.
   *Remediation:* Bridge retirement must be gated on the incoming image completing its decode, rather than an uncoordinated double rAF timer.

2. **Async neighbor dimension probe layout jitter:**
   In `src/js/viewer/manhwaStrip.js:185-207`:
   `_probeNeighborDimensions` launches parallel asynchronous dimension probes via `new Image` and `document.createElement('video')`. As each probe loads, line 189 calls `_onItemDecoded`, which triggers `_updateLayout` at line 798.
   *Race condition:* If multiple probes for items located above the viewport complete in arbitrary order while the user is actively scrolling or panning, each callback mutates `_layout.offsets` and recalculates slot positions. If `_anchorImgIdx` shifts between frames, slot tops jump, causing vertical jitter matching the ty-teleport anomaly in `viewerPipelineProbe.js:246`.
   *Remediation:* Accumulate decoded probe dimensions in a batch and apply layout recalculation once per animation frame via the scheduled layout rAF through `_requestLayout`.

3. **Shared destination canvas mutation in Lanczos worker:**
   In `src/js/services/scaling/lanczos.js:16`, `80-81`:
   `_destCanvas` is a single module-level `OffscreenCanvas` instance sized 1 by 1. When a render begins, lines 80-81 resize this canvas:
   ```javascript
   _destCanvas.width = destW;
   _destCanvas.height = destH;
   ```
   `resampler.resize` runs asynchronously in a web worker.
   *Race condition:* If the user zooms or resizes the viewport while a Lanczos resize job is in flight, the next render call immediately mutates `_destCanvas.width` and `_destCanvas.height` while the previous worker job is still writing into `_destCanvas`. Even though `generation !== _generation` prevents the old result from returning, resizing the destination canvas during an active worker transfer can cause worker errors or corrupted frames.
   *Remediation:* Create a new destination canvas per resize job, or allocate destination canvases from a pool only after prior worker jobs terminate.

---

## Redundant code, shared helpers, and diagnostic contracts

### Duplicated logic across Zone 2 modules

1. **Audio state management and probing:**
   `viewerAudio.js:25-82` and `manhwaAudio.js:33-62` duplicate identical logic for:
   - `_getFileAudioState` and `_saveFileAudioState`
   - Bounded cache instantiation
   - `_audioTrackCache` key formatting
   - `data-state` mapping for muted, zero, low, high
   - `aria-label` text strings for Unmute Audio and Mute Audio
   - Volume delta stepping with two-decimal rounding
   *Recommended shared helper:* `src/js/services/audioDomain.js`.

2. **ICO total dimensions calculation:**
   - `src/js/services/viewerMath.js:11-20`: `icoSizesTotal`
   - `src/js/fsUtils.js:350-357`: `icoSourcesTotal`
   Both functions compute the bounding width sum and maximum height across an array of `{ width, height }` objects.
   *Recommended shared helper:* Keep a single `icoSizesTotal` in `viewerMath.js` and eliminate the duplicate in `fsUtils.js`.

3. **Lanczos WebGL shader source code:**
   - `src/js/services/scaling/lanczosWebGL.js:6-73`
   - `src/js/services/pipelines/quadCompositor.js:151-201`: `LANCZOS_FS_SOURCE`
   Both files define identical 36-lookup Lanczos3 GLSL fragment shader code, including the `lanczos3` filter function and dual-loop convolution.
   *Recommended shared helper:* Extract the Lanczos GLSL string into `src/js/services/pipelines/glCommon.js` or a shared shader asset.

4. **Media type and animated format sniffing:**
   - `src/js/viewer/viewerRender.js:113-121`: `_isVideoState`
   - `src/js/viewer/viewerAudio.js:147`: `_FsUtils.isVideo`
   - `src/js/viewer/manhwaStrip.js:433-441`: `_isSvgEntry`, `_isAnimCandidateExt`
   - `src/js/viewer/viewerPipelines.js:75-87`: `isSvgSource`, line 256 `isVideoSource`
   Different variations of file extension checks and entry inspection are duplicated across five files.
   *Recommended shared helper:* Consolidate entry format testing into `src/js/services/mediaClassification.js`.

5. **Transform string formatting:**
   - `src/js/services/viewerMath.js:699`
   - `src/js/viewer/viewerRender.js:170-174`
   - `src/js/viewer/manhwaStrip.js:855`, `2128`, `2290`, `2340`
   Transform strings with `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) rotate(...) scale(...)` are formatted manually in multiple callsites.
   *Recommended shared helper:* Centralize transform string generation in `viewerMath.js`.

### Unused variables, dead code paths, and undocumented files

1. **Undocumented files in `.agents/architecture-state.md`:**
   - `src/js/services/pipelines/glCommon.js`: Contains `inverseTransformGLSL` consumed by Anime4K, CRT, Phosphor, Scanlines, and Lanczos shaders. Missing from `architecture-state.md`.
   - `src/js/services/scaling/lanczosWebGL.js`: Contains WebGL Lanczos3 shader for live pump scaling. Missing from `architecture-state.md`.

2. **Unused function parameters:**
   - `src/js/services/viewerMath.js:743`:
     `getEffectiveScaling(scalingMode, isAnimated, isSvg = false)`
     The `isAnimated` parameter is never read in the function body:
     ```javascript
     export function getEffectiveScaling(scalingMode, isAnimated, isSvg = false) {
       if (isSvg && scalingMode === 'lanczos') return 'bilinear';
       return scalingMode;
     }
     ```

3. **Dead debugging flags:**
   - `src/js/services/filters/anime4k.js:4`:
     `export const DEBUG_TINT = false;`
     Testing flag used during QA to tint shaders blue or yellow. Unreferenced in production.

4. **Redundant cleanup calls:**
   - `src/js/viewer/viewerPipelines.js:349-352`:
     `lanczosCanvas.style.removeProperty('--crop-*')` is called identically in both `_cancelRender` and `_teardownWebglCanvas`.

### Diagnostic telemetry contracts

The replay diagnostics engine in `e2e/replay-diagnostics/` in `viewerPipelineProbe.js` and `base.js` instruments the rendering pipeline to detect blackout frames, texture preparation delays, and transform teleports. Refactoring Zone 2 must preserve all queried DOM selectors, classes, dataset attributes, and global hooks.

#### 1. DOM selectors and IDs

| Selector / Element ID | Queried In | Invariants and Contract Expectations |
|---|---|---|
| `#viewport` | `viewerPipelineProbe.js:39`, `base.js:362` | Must maintain `.manhwa-active` class when strip is mounted. Must expose attribute `data-filter` matching active filter ID. |
| `#manhwa-strip` | `viewerPipelineProbe.js:15`, `base.js:338` | Must expose inline `style.transform` containing `translate(..., ty)` and `--zoom-scale` custom property. |
| `#manhwa-strip-spacer-top` | `viewerPipelineProbe.js:24`, `base.js:347` | Must expose CSS custom property `--strip-spacer-top`. |
| `#manhwa-strip-spacer-bottom` | `viewerPipelineProbe.js:25`, `base.js:348` | Must expose CSS custom property `--strip-spacer-bottom`. |
| `#viewer-img-wrapper` | `viewerPipelineProbe.js:72`, `base.js:395` | Parent container for active and retiring single-view images and videos. |
| `#viewer-bridge-layer` | `viewerPipelineProbe.js:74`, `base.js:397` | Container holding bridge elements during navigation transitions. |
| `#viewer-ico-row` | `viewerPipelineProbe.js:77`, `base.js:400` | Legacy ICO container queried for `.ico-container .ico-size[data-ready] > img`. |
| `#viewer-lanczos-canvas` | `viewerPipelineProbe.js:79`, `base.js:402` | Must set `data-render-ready="true"` attribute when Lanczos canvas output is valid. Computed opacity is checked for visibility. |
| `#viewer-filter-canvas` | `viewerPipelineProbe.js:80`, `base.js:403` | Must set `data-render-ready="true"` attribute when WebGL single filter canvas output is valid. Computed opacity is checked for visibility. |
| `#manhwa-filter-canvas` | `viewerPipelineProbe.js:41`, `81`, `base.js:364` | Must set `data-render-ready="true"` attribute when WebGL manhwa column canvas output is valid. Computed opacity is checked for visibility. |
| `#statusbar .status-filename` | `viewerPipelineProbe.js:257`, `base.js:174` | Queried to filter out directory navigation steps with `..` or trailing slashes from blackout evaluation. |

#### 2. CSS classes

| Class Name | Queried In | Purpose |
|---|---|---|
| `.manhwa-active` | `viewerPipelineProbe.js:40`, `base.js:363` | Indicates continuous manhwa strip mode is active on `#viewport`. |
| `.viewer-img` | `viewerPipelineProbe.js:73`, `base.js:396` | Marks viewer image elements. Probed for role transitions between `.active` and `.bridge`. |
| `.viewer-video` | `viewerPipelineProbe.js:75`, `base.js:398` | Marks viewer video elements. Probed for role transitions between `.active` and `.bridge`. |
| `.active` | `viewerPipelineProbe.js:73`, `179`, `base.js:396` | Identifies the currently active visible media node. |
| `.bridge` | `viewerPipelineProbe.js:74`, `180`, `base.js:397` | Identifies the parked retiring media node preserving continuity during navigation. |
| `.ico-container` | `viewerPipelineProbe.js:77`, `178`, `base.js:400` | Identifies ICO container groups. |
| `.ico-size` | `viewerPipelineProbe.js:77`, `base.js:400` | Identifies individual ICO dimension cells. |
| `.manhwa-slot` | `viewerPipelineProbe.js:23`, `50`, `base.js:346` | Marks virtualized slot containers in `#manhwa-strip`. |

#### 3. Dataset attributes

| Attribute Name | Target Element | Contract Purpose |
|---|---|---|
| `data-render-ready` | `#viewer-lanczos-canvas`, `#viewer-filter-canvas`, `#manhwa-filter-canvas` | Evaluated as `"true"` to determine canvas readiness during frame checks. |
| `data-filter` | `#viewport` | Monitored by MutationObserver in `viewerPipelineProbe.js:200` to track filter activation events. |
| `data-ready` | `.ico-size` | Confirms that an individual ICO cell image has finished decoding. |
| `data-ico` | `.manhwa-slot` | Flagged as `"true"` when a manhwa slot contains an ICO multi-size row. |
| `data-vid-src` | `.viewer-video` | Tracked by probes to identify the source URL of active or bridge video elements. |
| `data-img-idx` | `.manhwa-slot` | Index attribute mapped to trace telemetry events. |

#### 4. Global runtime hooks and monkeypatches

| Hook / Prototype | File and Line | Interception Mechanism |
|---|---|---|
| `HTMLImageElement.prototype.decode` | `viewerPipelineProbe.js:116-146`, `base.js:435-467` | Wrapped to record `image-decode-start`, `image-decode-end`, and `image-decode-fail` events with elapsed durations, source URLs, and natural dimensions into `window.__QUIVIT_DIAGNOSTICS__`. |
| `window.createImageBitmap` | `viewerPipelineProbe.js:149-171`, `base.js:470-482` | Wrapped to log `bitmap-create-end` and `bitmap-create-fail` timings for WebGL texture uploads. |
| `MutationObserver` on `#viewport` | `viewerPipelineProbe.js:174-217`, `base.js:485-528` | Listens to subtree attribute mutations on `class`, `data-render-ready`, and `data-filter` to record microtask-level role transitions such as `img-role-change`, `video-role-change`, `canvas-ready-change`, and `viewport-filter-change`. |
| `window.__QUIVIT_DIAGNOSTICS__` | `viewerPipelineProbe.js:112`, `base.js:8` | Global diagnostic controller recording timeline anomalies like `blackout`, `ty-teleport`, and `uncaught-error`. |

---

## Remediation checklist for Zone 2 decoupling branch

Prior to implementing changes in Zone 2, use the following checklist to ensure architectural compliance:

- [ ] Split `viewerPipelines.js` into `singlePipeline.js` for `#viewer-filter-canvas` and `#viewer-lanczos-canvas`, and `manhwaColumnPipeline.js` for `#manhwa-filter-canvas`.
- [ ] Remove hardcoded `lanczos` shader code from `quadCompositor.js` and pass scaler programs dynamically from pipeline configurations.
- [ ] Extract width scan state machine from `manhwaStrip.js` into `services/manhwaWidthGate.js`.
- [ ] Extract prefetch queue calculation from `manhwaStrip.js` into `services/manhwaMountScheduler.js`.
- [ ] Extract `createViewportState` store from `viewerMath.js` into `services/viewportState.js`, keeping `viewerMath.js` purely functional.
- [ ] Extract shared audio caching, probing, and stepping arithmetic from `viewerAudio.js` and `manhwaAudio.js` into `services/audioDomain.js`.
- [ ] Implement DOM pooling for ICO cells in `icoCells.js` and audio pills in `manhwaAudio.js` to eliminate `createElement` allocations during strip scrolling.
- [ ] Replace `manhwaStrip.js` reach-in at line 2706 with `ManhwaAudio.clear` API call.
- [ ] Decouple `_positionPill` layout reads and writes in `manhwaAudio.js` to prevent forced synchronous layouts.
- [ ] Coordinate bridge retirement in `viewerRender.js` with image decode resolution instead of the uncoordinated 45ms debounce and double-rAF timer.
- [ ] Preserve all diagnostic DOM IDs, classes, dataset attributes, and prototype wrappers listed in the telemetry contract.
