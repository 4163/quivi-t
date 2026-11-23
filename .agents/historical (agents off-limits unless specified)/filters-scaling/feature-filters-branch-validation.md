## Validation Report

**Target:** `feature/filters` vs `main` (HEAD `d64e34e`)
**Summary:** The branch adds mutually exclusive WebGL filters, still Lanczos via pica, a gated live pump for animated Lanczos/filters, header-only animation IPC, and the View-menu/config wiring that goes with that. `registry.js`, `commands/animation.rs`, `formats.rs`, and overlay ownership in `viewerPipelines.js` are in the right shape. It is not merge-ready.

I did not run the app. Line numbers are HEAD. Observable means UI, IPC, config/persistence, protocol, cross-window state, or performance.

---

### AGENTS.md violations

- [`src/js/core.js:166-172`](../src/js/core.js) [Observable change] Blast radius / measure twice. `_selectEntry` awaits `buildFileSrc` / `buildArchiveEntrySrc`, then writes `_state.src` with no stale-index guard. `main` had `if (_state.index !== index) return` after that await. Fast next/prev can apply a src from a navigation that is no longer current, and it revokes the live object URL on the way. Restore the guard before the write.

- [`src/js/core.js:176`](../src/js/core.js) vs [`src/js/core.js:183-185`](../src/js/core.js) and [`src/js/core.js:250-260`](../src/js/core.js) [Observable change] One owner per concern. `_animMemo` has two key shapes. `_selectEntry` looks up `archivePath::file.path`. `checkIsAnimated` stores `archivePath::file.name`. Archive hits in `_selectEntry` always miss, so `isAnimated` stays on the previous file until IPC returns. One function should mint the key. Use the same string the IPC helper stores.

- [`src/js/menubar.js:125`](../src/js/menubar.js) [Observable change] Communicate via state, not invented fields. `syncViewMenu` reads `state.currentFile`, which `core.js` never sets. `isSvg` is always false. Lanczos-on-SVG checkmarks in the View menu are wrong. Use `state.filename` or `state.src`.

- [`src/js/viewer/viewerPipelines.js:308-312`](../src/js/viewer/viewerPipelines.js) [Observable change] HTML-first. The SVG live pump does `document.createElement('img')` and `insertBefore` into `#viewport` on every pump start. That is extra DOM work and a possible first-frame hitch. Declare a placeholder in `index.html` (class `svg-pump-live`) and reuse it.

- [`src/js/filepanel/filePanel.js:24-27`](../src/js/filepanel/filePanel.js) [No observable change] CSS is the visual source of truth. `recalculateMinColWidths` sets inline `position`, `visibility`, `width`, and `minWidth` on a cloned header. The clone is hidden. Measure with a CSS class, or read computed style from the real header.

- [`src/js/services/scaling/lanczos.js:16-17`](../src/js/services/scaling/lanczos.js) [No observable change] Pure modules first. This file lives under `services/` and calls `document.createElement('canvas')` when `OffscreenCanvas` is missing. Domain/services have zero DOM. Keep the OffscreenCanvas path. If a DOM canvas is required, the overlay owner in `viewerPipelines.js` should pass it in.

- [`src/js/viewer/viewerPipelines.js:555-574`](../src/js/viewer/viewerPipelines.js) [Observable change] One owner. `setSource` no longer drops `#viewport[data-filter]` / `#viewer-filter-canvas[data-render-ready]` when the pool image changes. `_applyScaling` only removes `data-filter` when WebGL is off. With a filter still on, the last present stays visible across a source change. That is the ghost path this branch already tried to close in `f21b543`. Drop both attributes in `setSource` until the first present of the new source.

- [`src/js/viewer/viewerRender.js:126-140`](../src/js/viewer/viewerRender.js) [Observable change] Recycle existing nodes. `_recyclePoolNode` does not clear `data-played`. A free-list node that already played a GIF will look like re-entry on the next animated file ([`viewerRender.js:277`](../src/js/viewer/viewerRender.js)) and get `?_reset=` on first view. Clear `data-played` and `data-scaling` on recycle.

- [`src/js/viewer/viewerPipelines.js:104-106`](../src/js/viewer/viewerPipelines.js) [No observable change] Do not split a single owner. `dataset.scaling` is written on the pool `<img>`, which `viewerRender.js` owns. Pipelines own the overlay canvases. Either `viewerRender` paints `data-scaling` from `Core.scalingMode`, or pipelines only write scaling state on the canvas hosts.

- [`src/js/viewer/viewerPipelines.js:204-207`](../src/js/viewer/viewerPipelines.js) and [`viewerPipelines.js:536`](../src/js/viewer/viewerPipelines.js) [Observable change] `getEffectiveScaling` is called without `isSvg`. `_applyScaling` and `_syncLivePump` pass it. Lanczos-on-SVG can take the WebGL Lanczos branch in `_triggerRender`.

- [`src/js/viewer/viewerPipelines.js:32-39`](../src/js/viewer/viewerPipelines.js) [Observable change] `webglcontextrestored` rebuilds the still pipeline and never calls `_syncLivePump`. An animated overlay that lost the context stays dead until the next filter/src change. `_applyTransform` also bails when `_lastIsAnimated` is true, so pan will not recover it.

- [`src/js/viewer/viewerPipelines.js:270-274`](../src/js/viewer/viewerPipelines.js) [Observable change] SVG pump `createObjectURL` is never revoked in `_stopLivePump`. Only the early-return path revokes. Blob URLs accumulate for the session.

- [`src/js/services/pipelines/glRuntime.js:226-228`](../src/js/services/pipelines/glRuntime.js) [Observable change] Performance first. `render()` allocates a new `Map` for saved textures on every present, including pan. Reuse one map and `.clear()` it.

- [`src/js/keybinds.js:8`](../src/js/keybinds.js) [Observable change] Options imports `mergeConfig` from `keybinds.js`, which imports `registry.js`, which imports `filters/anime4k/chains.js`. The options window parses the Anime4K shader table on open. `activeFilterId` only needs the id list. Keep module objects out of the config merge graph.

- [`src-tauri/src/formats.rs:189-190`](../src-tauri/src/formats.rs) [Observable change] `check_svg` treats any 4-byte window equal to `<set` as animation. Tighten to a real tag, or static SVGs will take the live pump.

`canvas.width` / `canvas.height` in `glRuntime` and the staging canvas are drawing-buffer sizes, not CSS `width`. `--crop-*` and `--svg-base-*` custom properties are allowed writes. Overlay `data-filter` / `data-render-ready` are the right tokens. Filter modules under `services/filters/` do not touch `document`. `commands/animation.rs` + `formats.rs` + `ArchiveCache::read_entry_header` match the Rust ownership split. Protocol query-strip for `?_reset=` on `quivit://` is the right blast-radius fix for cache-bust URLs. The DOM bridge keep-alive now uses `dataset.poolSrc`. `_reset` is gated on re-entry.

---

### Stale code and references

- [`src/js/shared/blobImage.js:59-111`](../src/js/shared/blobImage.js) [No observable change] `getLiveImage` and `evictLiveBlobCache` have no callers. The pump uses `ImageDecoder` and a one-off SVG `<img>`. Slice 2 added this cache. Slice 3 never used it. Delete both, or wire the SVG path through `getLiveImage` and drop the `createElement`.

- [`src/js/shared/blobImage.js:8`](../src/js/shared/blobImage.js) [No observable change] `evictBlobCache` is exported and only called from inside this file.

- [`src/js/core.js:73`](../src/js/core.js) [No observable change] Comment still says `isAnimated` bypasses WebGL/Lanczos. The live pump exists to do the opposite.

- [`src/js/menubar.js:125`](../src/js/menubar.js) [Observable change] `state.currentFile` is a leftover name. Core never had that field. Same bug as the violation above. The reachable state is `filename` / `src`.

- [`src/js/services/registry.js:19-20`](../src/js/services/registry.js) [No observable change] `SCALERS[].css` (`pixelated`, `auto`) is never read. `data-scaling` is set to the scaler id (`none` / `bilinear` / `lanczos`). Dead catalog field.

- [`src/js/keybinds.js:60`](../src/js/keybinds.js) [Observable change] `mergeConfig` passes `fd.scaling_mode` through. The old id was `bicubic`. A saved `bicubic` value matches no `SCALERS` id, so the View menu shows no scaling checkmark and CSS `image-rendering` never applies. Remap `bicubic` to `bilinear` here, the same way `activeFilterId` drops unknown filter ids.

- [`src/options.html:197`](../src/options.html) [Observable change] Keybind row still says `Scale None`. The action label and the View menu say `Pixelated`.

- [`src/css/main.css:760-761`](../src/css/main.css) [No observable change] Comment says both the image and the overlay live inside `#viewer-img-wrapper`. Lanczos canvas does. `#viewer-filter-canvas` is a sibling of the wrapper, not a child.

- [`src-tauri/src/tests/format_tests.rs:66-67`](../src-tauri/src/tests/format_tests.rs) [No observable change] Comment says the NETSCAPE single-frame false positive is documented in `formats.rs`. It is not. The behaviour is still `frame_count > 1 || loop_count.is_some()`.

No leftover imports of `webglPipeline.js` / `scalingPipeline.js`. No leftover `cmd-scale-bicubic`, `zoom-held`, `#viewer-crt-canvas`, or `crt_filter` identifiers in `src/`. `quivit-panel-resized` has no remaining listeners after the file-panel dispatch was removed.

---

### Verdict

**Fail**

Fix the stale-src guard, the memo key, `state.currentFile`, the SVG placeholder, the `setSource` present fence, `data-played` on recycle, and the `bicubic` config remap before merge. Performance items that count as observable: the per-present `Map` alloc, Options loading Anime4K shaders, and the SVG blob-URL leak. The HTML-first / CSS / `document`-in-services items are the architectural bar, not optional cleanup. Dead `getLiveImage`, the `SCALERS.css` field, and the two stale comments can ride in the same slice if those files are already open.
