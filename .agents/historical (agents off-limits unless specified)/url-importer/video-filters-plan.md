# Video filters and Lanczos scaling plan

Validation comparison performed: this plan was checked against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md` before presenting. It proposes zero architectural drift and strictly planning only.

## Goal

Enable WebGL post-processing filters (Anime4K Mode A Fast/HQ, Retro CRT, Phosphor dot-matrix, Scanlines) and WebGL Lanczos scaling for video playback.

The animated image pipeline already implements dynamic frame pumping, shader parameterization, and WebGL Lanczos scaling. This plan hooks video playback into that exact pipeline rather than creating a second rendering path.

## Factual pipeline

This is how media, scaling, filters, and rendering currently operate across the codebase.

### 1. Media activation and pipeline source coupling

- `viewer.js:20` instantiates `createViewerPipelines(viewportState)`.
- `viewer.js:21-24` connects the renderer to the pipeline:
  ```javascript
  createViewerRenderer(viewportState, (img) => {
    if (img) pipelines.setSource(img);
    else pipelines.clear();
  });
  ```
- For image items, `viewerRender.js:321` calls `onActiveImageChanged(el)` when an image loads or activates.
- For video items, `viewerRender.js:175` currently calls `onActiveImageChanged(null)`. `viewerRender.js:528` also clears the active image on video state entry. As a result, `pipelines.clear()` executes on every video navigation, disabling filters and WebGL pipelines completely.

### 2. Pipeline scaling and filter resolution

- `viewerPipelines.js:100-111` determines the active rendering technology in `_applyScaling`:
  ```javascript
  const live = Core.getState();
  const isAnimated = incomingIsAnimated !== undefined ? incomingIsAnimated : !!live?.isAnimated;
  const isSvg = isSvgSource(_activeSource?.src);
  const scaling = getEffectiveScaling(live?.scalingMode, isAnimated, isSvg);
  const activeFilter = incomingFilter !== undefined ? incomingFilter : _resolveActiveFilter(live);

  const useWebGlForLanczos = scaling === 'lanczos' && isAnimated && !isSvg && activeFilter === null;
  const usesWebgl = activeFilter !== null || useWebGlForLanczos;
  const usesLanczos = scaling === 'lanczos' && !usesWebgl;
  ```
- For static images, `usesLanczos` runs CPU-based Lanczos via `pica` on a 2D canvas (`createLanczosPipeline`).
- For animated images, `useWebGlForLanczos` routes Lanczos to the WebGL shader runtime (`lanczosWebGlModule`).
- Videos currently have `isAnimated: false` in `Core.getState()`. If video reached `_applyScaling`, it would erroneously select the static CPU Pica pipeline instead of the WebGL Lanczos shader.

### 3. WebGL shader runtime

- `glRuntime.js:3` creates and manages the WebGL2 context on `#viewer-filter-canvas`.
- `glRuntime.js:145-168` provides `updateSource(canvasOrImage)`. It creates or binds `_sourceTexture` and uploads pixels via:
  ```javascript
  _gl.texImage2D(_gl.TEXTURE_2D, 0, _gl.RGBA, _gl.RGBA, _gl.UNSIGNED_BYTE, canvasOrImage);
  ```
  WebGL2 specification explicitly accepts `HTMLVideoElement` for `texImage2D`. Uploading the `<video>` element directly requires zero intermediate canvas copy.
- `glRuntime.js:173-174` checks source dimensions:
  ```javascript
  const nw = imgElement.naturalWidth || imgElement.width;
  const nh = imgElement.naturalHeight || imgElement.height;
  ```
  `HTMLVideoElement` exposes `videoWidth` and `videoHeight`. It does not have `naturalWidth` or `naturalHeight`. Passing a video element today results in `nw = undefined`, corrupting uniform setup at lines 229 and 293.

### 4. Frame pumping architecture

- `viewerPipelines.js:295-306` evaluates whether a live pump loop is required:
  ```javascript
  const useLivePump = (isAnimated || isSvg) && (activeFilter !== null || scaling === 'lanczos');
  ```
- Two pumps exist today:
  1. SVG DOM fallback pump (`pumpTickSvg`, lines 345-401): renders the SVG image into `_liveStagingCanvas` and calls `pipeline.updateSource(_liveStagingCanvas)` on `requestAnimationFrame`.
  2. Raster WebCodecs pump (`pumpTick`, lines 459-551): decodes frame objects from `ImageDecoder`, manages frame delays, downscales over-sized frames for Anime4K (`ANIME4K_MAX_EDGE = 2048`), uploads to `pipeline.updateSource`, and calls `pipeline.render(_activeSource, geom, true)`.
- Videos do not have a pump branch. Videos manage their own playback timeline in the HTML5 media engine, but need a frame pump to upload new video frames to the WebGL texture and trigger shader passes.

### 5. CSS layer visibility

- `src/css/main.css:1647-1652` controls visibility when a WebGL filter or Lanczos canvas is active:
  ```css
  #viewport[data-filter] #viewer-img-wrapper .viewer-img,
  #viewer-img-wrapper:has(#viewer-lanczos-canvas[data-render-ready="true"]) .viewer-img,
  #viewport[data-filter] #viewer-bridge-layer .viewer-img,
  #viewport:has(#viewer-lanczos-canvas[data-render-ready="true"]) #viewer-bridge-layer .viewer-img {
    opacity: 0 !important;
  }
  ```
  This rule hides `.viewer-img`. It does not mention `.viewer-video`. When a filter is active, `#viewer-filter-canvas` renders on top with `opacity: 1`, but the underlying `.viewer-video` remains visible at `opacity: 1`, causing visual bleed or desynchronized double rendering if the canvas has transparency (such as CRT curvature margins or scanline gaps).

### 6. Telemetry probe contracts

- `e2e/replay-diagnostics/probes/viewerPipelineProbe.js:32-38` checks content visibility:
  ```javascript
  const hasActive = !!(activeImg && activeOpacity > 0 && activeImg.complete && activeImg.naturalWidth > 0);
  const hasBridge = !!(bridgeImg && bridgeOpacity > 0 && bridgeImg.naturalWidth > 0);
  const hasActiveVideo = !!(activeVideo && activeVideoOpacity > 0 && activeVideo.readyState >= 2 && activeVideo.videoWidth > 0);
  const hasBridgeVideo = !!(bridgeVideo && bridgeVideoOpacity > 0 && bridgeVideo.readyState >= 2);
  const hasCanvas = (lanczosReady && lanczosOpacity > 0) || (filterReady && filterOpacity > 0);

  return hasActive || hasBridge || hasActiveVideo || hasBridgeVideo || hasCanvas;
  ```
  When a filter or Lanczos canvas is active, `hasCanvas` evaluates to true once `data-render-ready="true"` is set. The telemetry system already supports canvas-mediated visibility.

## Gaps

1. Renderer disengagement: `viewerRender.js` passes `null` to `onActiveImageChanged` during video swap and video state entry, clearing the pipeline.
2. WebGL dimension resolution: `glRuntime.js` does not read `videoWidth` or `videoHeight`.
3. CSS layer suppression: `src/css/main.css` does not hide `.viewer-video` when `#viewport[data-filter]` or Lanczos render-ready is active.
4. Video live pump: `viewerPipelines.js` has no pump for video elements. It needs a tick loop that detects video frame updates and geometry changes, updates the texture, and renders through the shader chain.
5. Scaling mode routing: `viewerPipelines.js` treats video as static image when resolving Lanczos scaling, rather than routing it to `lanczosWebGL`.

## Proposed slices

Follow these slices in order. Each slice is small, self-contained, and directly testable.

### Slice 1: CSS layer suppression and WebGL runtime dimensions

Goal: prepare the layout and WebGL core to accept video elements without breaking existing image rendering.

Touched files:

- `src/css/main.css`. Extend `#viewport[data-filter]` and `#viewer-lanczos-canvas[data-render-ready="true"]` rules to suppress `.viewer-video` on `#viewer-img-wrapper` and `#viewer-bridge-layer`, matching the existing `.viewer-img` suppression.
- `src/js/services/pipelines/glRuntime.js`. In `render()`, resolve intrinsic dimensions with `imgElement.naturalWidth || imgElement.videoWidth || imgElement.width` and `imgElement.naturalHeight || imgElement.videoHeight || imgElement.height`.

Acceptance:
- Static checks pass (`node --check`).
- Unit tests pass (`npm test`).
- Existing image rendering and filter behavior remains completely unaffected.

### Slice 2: Renderer pipeline coupling

Goal: pass the active video element to the pipeline coordinator when video playback activates.

Touched files:

- `src/js/viewer/viewerRender.js`.
  - In `_swapInVideo(incoming, state)`: call `onActiveImageChanged(incoming)` instead of `onActiveImageChanged(null)`.
  - In `_onVideoMetadata(el)`: call `onActiveImageChanged(el)` so initial metadata resolution updates the pipeline with valid dimensions.
  - In `_hideVideo()`: call `onActiveImageChanged(null)` when video unloads.
  - In the video branch of `renderState()`: call `onActiveImageChanged(_activeVideoEl)` when state updates occur while the video element remains active.

Acceptance:
- `pipelines.setSource()` receives the active `<video>` element on video playback and `null` on video teardown.
- Video playback without filters continues functioning with zero regressions.

### Slice 3: Video live pump in `viewerPipelines.js`

Goal: pump video frames through WebGL filters and WebGL Lanczos scaling.

Touched files:

- `src/js/viewer/viewerPipelines.js`.
  - Add `isVideoSource(el)` helper: `el?.tagName === 'VIDEO'`.
  - In `_applyScaling()`: treat video as moving media alongside `isAnimated`:
    `const isMoving = isAnimated || isVideoSource(_activeSource);`
    Route `scaling === 'lanczos' && isMoving && activeFilter === null` to `useWebGlForLanczos`.
  - In `_applyTransform()`: return early if `isVideoSource(_activeSource)`, keeping transform handling in the live pump loop.
  - In `_syncLivePump()`: add a video pump branch when `isVideoSource(_activeSource) && useLivePump`:
    - Wait until `videoEl.readyState >= 2 && videoEl.videoWidth > 0`.
    - Tick loop using `requestAnimationFrame`. On each tick:
      - Compare `videoEl.currentTime` against `lastCurrentTime`, and `viewportState.getGeometry()` against `lastGeometryHash`.
      - If time or geometry changed, render:
        - For Anime4K with dimensions exceeding `ANIME4K_MAX_EDGE` (2048px), draw to `_liveStagingCanvas` at capped dimensions.
        - For standard resolutions, CRT, Phosphor, Scanlines, and Lanczos, upload `videoEl` directly via `pipeline.updateSource(videoEl)`.
        - Execute `pipeline.render(videoEl, geom, true)`.
        - Mark `filterCanvas.setAttribute('data-render-ready', 'true')` and `#viewport.setAttribute('data-filter', ...)`.
    - In `_stopLivePump()`: cancel video animation frame, detach any pending video ready listeners, and reset tracking variables.

Acceptance:
- Selecting any WebGL filter (Anime4K, CRT, Phosphor, Scanlines) applies the shader effect to the playing video.
- Selecting Lanczos scaling applies GPU-accelerated Lanczos shader scaling to the video.
- Selecting Filter Off and Bilinear scaling returns rendering to the native `<video>` element.
- Panning, zooming, rotating, and flipping apply in real time to the filtered video display.
- Pausing or seeking the video continues displaying the filtered frame without blanking.

### Slice 4: Telemetry verification and contract checks

Goal: confirm that replay diagnostics and unit test contracts pass with filtered video.

Touched files:

- `mocha/diagnosticsContract.test.js`. Validate that DOM selectors and probe requirements continue to pass.
- Run `npm test` and `npm run diagnose -- sample-navigation` to confirm zero regression across the diagnostic harness.

Acceptance:
- All 71 mocha unit tests pass.
- Diagnostic run reports zero blackout frames and zero pipeline anomalies.

## Non-goals

- CPU-based Pica Lanczos on video: CPU resizing cannot maintain video frame rates. Lanczos for video uses the existing `lanczosWebGL` shader only.
- Audio pipeline modifications: audio is managed independently by `viewerAudio.js` on `#viewer-audio`. Visual shader filtering does not touch audio playback or volume controls.
- Core state schema modifications: video detection remains view-local in the viewer modules. No new fields are added to `core.js`.
- Video encoding or transcode: strictly GPU shader post-processing of native playback frames.

## Blast radius

- IPC commands (`src-tauri/src/commands/`): untouched.
- Config schema (`src-tauri/src/config.rs`): untouched.
- Archive & format readers (`src-tauri/src/archives/`, `formats.rs`): untouched.
- Protocol URLs (`src-tauri/src/protocol.rs`): untouched.
- Action registry (`actions.js`): untouched. All filter and scaling action IDs remain identical.
- Telemetry probes (`viewerPipelineProbe.js`): untouched. Probe already checks `filterReady` and `lanczosReady`.
- Image rendering: static images continue using Pica Lanczos and static WebGL transforms. Animated images continue using WebCodecs ImageDecoder.
- Performance: direct `gl.texImage2D` upload of `HTMLVideoElement` avoids CPU intermediate buffers for all shaders except Anime4K on >2048px video. When filters are off and scaling is Bilinear, the WebGL pipeline is completely torn down and consumes zero GPU cycles.

## Verification plan

### Automated tests

- Static syntax validation:
  ```bash
  node --check src/css/main.css
  node --check src/js/services/pipelines/glRuntime.js
  node --check src/js/viewer/viewerRender.js
  node --check src/js/viewer/viewerPipelines.js
  ```
- Mocha unit test suite:
  ```bash
  npm test
  ```
- Replay diagnostics baseline:
  ```bash
  npm run diagnose -- sample-navigation
  ```

### Manual runtime checklist

1. Open an MP4 video file.
2. Select **Filter -> Retro CRT**. Confirm CRT scanlines, barrel curvature, and phosphor glow apply to the video in motion.
3. Select **Filter -> Scanlines**. Confirm horizontal scanlines overlay the video.
4. Select **Filter -> Phosphor**. Confirm dot-matrix phosphor shader applies.
5. Select **Filter -> Anime4K**. Confirm Anime4K sharpening applies.
6. Select **Filter -> Off**. Confirm the view cleanly reverts to native video rendering.
7. Select **Scaling -> Lanczos**. Confirm WebGL Lanczos scaling activates with `#viewport[data-filter="lanczos"]`.
8. Pan with mouse drag and zoom with Ctrl+wheel while a filter is active. Confirm transform matrices follow the viewport smoothly without stutter or desync.
9. Navigate between video and image files with a filter active. Confirm cross-media transitions remain flicker-free.
10. Confirm audio mute/unmute and volume slider continue functioning during filter playback.

## Compliance review

Compared against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md`:
- Flat control flow: early returns for non-video and non-active pipeline states.
- Performance first: direct hardware texture upload (`gl.texImage2D` from video element) without 2D canvas copies where possible; zero idle GPU usage when filters are off.
- One owner per concern: `viewerPipelines.js` remains the sole owner of `#viewer-filter-canvas` and shader dispatch; `viewerRender.js` owns the video elements.
- CSS source of truth: element visibility toggled through `#viewport[data-filter]` and classes, not JS inline style mutations.
- No stale code or references: builds directly on the active video pool and WebGL runtime.
