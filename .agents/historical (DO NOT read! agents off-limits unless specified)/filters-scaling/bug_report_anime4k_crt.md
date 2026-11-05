# Bug Report & Root-Cause Analysis: Render Pipeline Toggling Issues

Investigation of recent scaling and filter commits, specifically [508b790](file:///e:/Projects/QuiviT/src/js/services/scalingPipeline.js) (Lanczos scaling pipeline) and [f0625cf](file:///e:/Projects/QuiviT/src/js/services/webglPipeline.js) (WebGL CRT filter and Anime4K mode).

---

## Bug 1: CRT Filter Fails to Initialize When Toggled From Anime4K

### Description
When active scaling is set to **Anime4K**, toggling the **CRT Filter** ON does not immediately apply the CRT distortion, chromatic aberration, or scanline effects. The viewport continues displaying Anime4K scaling. The CRT filter only appears after cycling to another scaling mode (such as Bilinear or Lanczos) and back.

### Primary Mechanism: State Check Short-Circuit in `_applyScaling`
In [viewerRender.js](file:///e:/Projects/QuiviT/src/js/viewer/viewerRender.js#L53-L61), `Core.onStateChange` listens for CRT filter toggles:

```javascript
Core.onStateChange((state) => {
  if (state.config.frontend_data.crt_filter !== _lastCrtFilter) {
    _lastCrtFilter = state.config.frontend_data.crt_filter;
    _cancelRender();
    _applyScaling();
    _scheduleTransform();
    _triggerRender();
  }
});
```

Tracing `_applyScaling()` in [viewerRender.js](file:///e:/Projects/QuiviT/src/js/viewer/viewerRender.js#L149-L193):
1. `_lastCrtFilter` is updated on line 55 **before** `_applyScaling()` is called.
2. Inside `_applyScaling()`, line 152 reads `const crtFilter = _lastCrtFilter;`.
3. Line 176 attempts to detect changes:
   ```javascript
   if (needsNewPipeline || (usesWebgl && (scaling !== _lastScalingMode || crtFilter !== _lastCrtFilter)))
   ```
4. Because `_lastCrtFilter` was already overwritten in the listener, `crtFilter !== _lastCrtFilter` evaluates to `_lastCrtFilter !== _lastCrtFilter`, which is always **false**.
5. Because both Anime4K and CRT share `pipeline.type === 'webgl'`, `needsNewPipeline` evaluates to **false**.
6. Because `scaling` has not changed (`'anime4k' === 'anime4k'`), `scaling !== _lastScalingMode` is **false**.
7. Result: The pipeline recreation branch is skipped entirely. The existing WebGL pipeline instance (compiled with `animeFsSource`) is kept active and continues rendering without recompiling or linking `crtFsSource`.

### Why Mode Cycling Recovers the Filter
When the user presses `[` or `]` to switch scaling to Bilinear or Lanczos, `scaling !== _lastScalingMode` becomes true, or `usesWebgl` becomes false. This forces `pipeline.dispose()` and subsequent recreation. When Anime4K is selected again with `crt_filter: true`, `createWebglPipeline()` is called with the active CRT state, compiling `crtFsSource`.

---

## Bug 2: WebGL "Ghost Image" Left Behind on Toggle or Navigation

### Description
When switching scaling modes, navigating images, or disabling the CRT filter during pan and zoom interactions, a stale frame of the WebGL canvas can remain frozen on screen, overlaying the active base image.

### Contributing Factors & Hypotheses

#### 1. In-Flight Render Promise Race Condition
WebGL frame rendering is asynchronous because texture preparation queries [webglPipeline.js](file:///e:/Projects/QuiviT/src/js/services/webglPipeline.js#L15-L26) (`_getCleanImage` and `blob.decode()`).

In [viewerRender.js](file:///e:/Projects/QuiviT/src/js/viewer/viewerRender.js#L82-L91):
```javascript
if (pipeline && pipeline.type === 'webgl') {
  const geom = viewportState.getGeometry();
  pipeline.render(img, geom).then((ok) => {
    if (ok && webglCanvas) {
      webglCanvas.setAttribute('data-render-ready', 'true');
      if (_lastCrtFilter) webglCanvas.setAttribute('data-crt', 'true');
      else webglCanvas.removeAttribute('data-crt');
    }
  });
}
```

- When panning or zooming, `_applyTransform` fires on every animation frame, launching `pipeline.render(img, geom)`.
- If the user turns off the CRT filter or switches to a non-WebGL mode while a render promise is awaiting image decoding, `_applyScaling()` immediately calls `pipeline.dispose()` and removes `data-render-ready`.
- When the earlier render promise resolves, its `.then()` callback executes without checking if the originating pipeline or generation is still current.
- The callback unconditionally re-applies `data-render-ready="true"` to `#viewer-webgl-canvas`.
- In [main.css](file:///e:/Projects/QuiviT/src/css/main.css#L820-L822), `#viewer-webgl-canvas[data-render-ready="true"]` sets `opacity: 1`, bringing the canvas back into view. Because the pipeline is now disposed, no further render calls occur to clear or update it, leaving the canvas stuck.

#### 2. Framebuffer Retention via `preserveDrawingBuffer`
In [webglPipeline.js](file:///e:/Projects/QuiviT/src/js/services/webglPipeline.js#L30-L35), the WebGL2 context is created with:
```javascript
let _gl = canvas.getContext('webgl2', {
  antialias: false,
  preserveDrawingBuffer: true,
  alpha: true,
  premultipliedAlpha: false,
});
```
- `preserveDrawingBuffer: true` directs the browser not to wipe the drawing buffer between frames.
- When `pipeline.dispose()` runs, it deletes shader programs and textures, but does not clear the canvas drawing buffer (`gl.clear(gl.COLOR_BUFFER_BIT)` or `canvas.width = 0`).
- If any DOM attribute keeps the canvas visible (or re-enables `data-render-ready`), the last painted frame remains visible in full detail.

#### 3. Incomplete Cleanup in `_clearViewer()` and `_cancelRender()`
- In [viewerRender.js](file:///e:/Projects/QuiviT/src/js/viewer/viewerRender.js#L63-L69), `_cancelRender()` explicitly skips WebGL canvas teardown to prevent flickering during continuous pan/zoom:
  ```javascript
  function _cancelRender() {
    if (pipeline && pipeline.type !== 'webgl') pipeline.cancel();
    if (_renderTimeout) clearTimeout(_renderTimeout);
    _renderTimeout = null;
    if (lanczosCanvas) lanczosCanvas.removeAttribute('data-render-ready');
    // WebGL canvas maintains its state during pan/zoom
  }
  ```
- In [viewerRender.js](file:///e:/Projects/QuiviT/src/js/viewer/viewerRender.js#L368-L374) (`_clearViewer`), Lanczos canvas is wiped and has its readiness attribute removed, but `#viewer-webgl-canvas` is neither cleared nor stripped of `data-render-ready` and `data-crt`.
- If an image is unloaded or replaced, stale WebGL content can persist across navigations.

#### 4. CSS Visibility Mismatch Between Base Image and Overlay
In [main.css](file:///e:/Projects/QuiviT/src/css/main.css#L813-L826):
```css
#viewer-webgl-canvas {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0;
}

#viewer-webgl-canvas[data-render-ready="true"] {
  opacity: 1;
}

#viewport:has(#viewer-webgl-canvas[data-render-ready="true"][data-crt="true"]) #viewer-img-wrapper .viewer-img {
  opacity: 0 !important;
}
```
- When CRT mode is active, the base `.viewer-img` element is hidden (`opacity: 0 !important`) because CRT distortion renders its own frame and borders.
- When CRT mode is turned OFF, `data-crt` is removed, immediately making the base `.viewer-img` visible at `opacity: 1`.
- If `#viewer-webgl-canvas` still has `data-render-ready="true"` (due to the promise race condition or missing cleanup), both the WebGL canvas and the base image are rendered at `opacity: 1`.
- The WebGL canvas contains transparent areas outside the curved CRT barrel. The base uncurved image shows through these transparent regions while the curved frame sits on top, creating a visible double/ghost image.

#### 5. Module-Level Blob Cache Concurrency
In [webglPipeline.js](file:///e:/Projects/QuiviT/src/js/services/webglPipeline.js#L4-L13):
- `_cachedSrc`, `_cachedBlobUrl`, and `_cachedCleanImg` are module-level singletons.
- Rapid image navigation while texture fetches or decodes are in flight can cause `_evictBlobCache()` to revoke a blob URL that is still being decoded by an earlier render step, causing texture upload failures or silent promise rejections.

---

## Summary of Potential Areas for Review

1. **State transition detection:** Revisit how `_lastCrtFilter` and `_lastScalingMode` are captured and compared in `viewerRender.js`. State variables should not be updated before comparison logic runs.
2. **Render token / generation tracking:** Guard the `.then()` completion handler of `pipeline.render()` with an incrementing generation counter or active pipeline instance check to ignore stale async resolutions.
3. **Canvas lifecycle and buffer clearing:** Explicitly clear the WebGL context / canvas pixels and reset DOM attributes on `dispose()`, mode switches, and image unloads.
4. **Shader switching architecture:** Consider whether `webglPipeline.js` should support hot shader swapping or whether the renderer should cleanly destroy and recreate pipelines on any mode or filter alteration.
