> **NOTE:** This document is the original deep-dive analysis. For the actionable, slice-by-slice implementation roadmap, see [`animated-filters-plan.md`](file:///e:/Projects/QuiviT/.agents/animated-filters-plan.md).
>
# Animated images through Lanczos and WebGL

QuiviT already plays GIF, APNG, and animated WebP. It does it the cheap way: a pool `<img>` and the browser's decoder. Filters and Lanczos refuse to touch that path. SVG is lumped in with the same boolean, so a still vector file also skips the GPU. `additions.md` parked this as post-release.

The skip stays the default. Native `<img>` playback is still how animated files and SVGs render when no filter is on and scaling is not Lanczos. This work does not replace the still-image pipeline, does not change how PNG/JPEG/WebP upload to GL, and does not make a live-capture loop part of the normal architecture. The new path exists only for animated formats and SVGs, and only while a filter or Lanczos is actually active. Turn that off and the extra Image, staging canvas, and rAF pump go away.

I went looking for how other people feed an animated GIF into a CRT shader. The short version is they do not decode the GIF. They let the browser composite the current frame, blit that into a 2D canvas, and upload the canvas to WebGL every animation tick. That is the whole trick, and it is a gated overlay on what we already have, not a new default. The rest of this file is what that means in this repo, where `quivit://` taints canvases and `createImageBitmap` freezes frame 1.

## gingerbeardman/webgl-crt-shader

Repo: https://github.com/gingerbeardman/webgl-crt-shader
Demo: https://gingerbeardman.github.io/webgl-crt-shader/
Blog: https://blog.gingerbeardman.com/2026/01/04/webgl-crt-shader/
Licence: MIT

Matt Sephton released this in January 2026 as "Serenity Shader". It started as a LÖVE2D shader, then a Three.js port in `CRTShader.js`, then a no-framework WebGL2 demo in `crt-webgl.js`. The demo is the file that matters for us. The Three.js module is a fragment shader plus a uniform bag. It has no idea a GIF exists.

### What the demo actually draws

`index.html` puts one sentence on screen:

> GIF + shapes are composited on a 2D canvas, then go through the CRT shader pass.

That sentence is doing two jobs, and mixing them up is how you end up writing a GIF parser you do not need.

**Browser compositing.** `wormnomnom.gif` is a 256×256 Pico-8 capture. The demo loads it with `new Image(); gifImage.src = './wormnomnom.gif'`. The element is never inserted into the document. Chromium still advances the animation and applies GIF disposal, transparency, and loop. `drawImage(gifImage, ...)` copies the fully composited current frame. You never see a partial patch, a restore-to-background hole, or a restore-to-previous stack. The decoder already did that.

**Scene compositing.** Every `requestAnimationFrame`, `drawScene2D` clears an offscreen 2D canvas, paints a radial gradient, draws the GIF scaled to the canvas, then optionally draws three orbiting shapes on top. That canvas is the shader input. The GIF is one layer in a 2D scene. QuiviT does not need the gradient or the shapes. We need the first half: a live `Image` whose current pixels can be sampled.

### The WebGL upload

`crt-webgl.js` keeps a WebGL2 context on `#crt-canvas` with `{ alpha: false }`. It allocates one `TEXTURE_2D` at the scene canvas size with `texImage2D(..., null)`, then every frame:

```
gl.bindTexture(gl.TEXTURE_2D, texture);
gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, sceneCanvas);
```

`UNPACK_FLIP_Y_WEBGL` is on because a 2D canvas's origin is top-left and GL's is bottom-left. Filter is `LINEAR` or `NEAREST` from a "Smoothing" toggle that also sets `sceneCtx.imageSmoothingEnabled`. Wrap is `CLAMP_TO_EDGE`. The fragment shader samples `uTexture` and either runs the CRT body or bypasses to a straight `texture()` lookup.

There is no frame-index uniform. There is no atlas. There is no `ImageDecoder`. Time is a shader uniform for flicker, not for GIF timing. The GIF clock is the `Image` element's decoder, and the rAF loop is just "whatever the image looks like right now, upload it."

They resize the scene canvas with the window, then reallocate the GL texture. A 256×256 GIF stretched onto a full-window canvas is a deliberate look. QuiviT should capture at the image's natural size and let the existing inverse-transform shaders place it in the viewport. Do not copy their stretch.

### What this repo does not contain

No GIF block parser. No disposal-method table. No APNG/WebP handling, because the demo only ships a GIF and the browser path does not care. No SVG. No discussion of tainted canvases, because `wormnomnom.gif` is same-origin.

If you take one thing from the repo, take the upload loop. If you take a second, take the fact that they went through a 2D canvas instead of `texImage2D` from the `Image` directly. Direct upload from an animated `<img>` has a long history of sticking on frame 0 in some engines. The canvas blit is the path that is known to work.

## Other public approaches

I looked at the usual suspects so we do not rediscover them mid-slice.

**gifuct-js** (matt-way) and **omggif** (deanm). JS GIF parsers. You get per-frame patches, delays, and disposal 0–3. Then you own a compositing canvas: save `ImageData` before disposal 3, clear the frame rect for disposal 2, blit the patch with source-over because `putImageData` punches holes through binary transparency. This is correct and also GIF-only. We would still need a second decoder for APNG and a third for animated WebP. The browser already does all three. Do not take this on unless a later frame-timeline feature needs pause, seek, and a known frame index. That feature is a different backlog item.

**libgif-js / SuperGif.** Same family, older. Still GIF-only. Same no.

**ImageDecoder** (WebCodecs). Chromium, so WebView2 likely has it. You `decode({ frameIndex })` into `VideoFrame`s. Fine for full-frame WebP. Weak for GIF and APNG, because the API does not hand you disposal and blend the way a compositor needs, and `visibleRect` is often the patch, not the logical screen. You end up writing the same compositing canvas gifuct-js already forced, plus a second fetch of archive bytes we already paid for through `quivit://`. Skip it for this work.

**canvg / inline `<svg>`.** Heavy, and aimed at SVG that `<img>` will not animate. Chromium mostly does not run SMIL or CSS animation inside an SVG used as an `<img>` `src`. Rasterizing the current SVG snapshot with `drawImage` is the compromise. Animated SVG as a first-class timeline is a different product. I would not inline SVG into the image pool to chase SMIL.

**Pre-extract frames into an atlas.** Shader picks a tile with `mod(time, duration)`. Needs a decoder, a lot of VRAM, and a clock we own. Overkill for a viewer whose `<img>` is already ticking.

The public pattern that matches a multi-format viewer is the gingerbeardman one: live `Image`, 2D blit, `texSubImage2D`, existing shader. Everything else is for people who need to seek or who only support GIF.

## What QuiviT does today

Detection is header-only in `formats.rs` `is_animated`, first 8 KiB, exposed as `check_is_animated`. GIF looks for `NETSCAPE2.0` in the first 2 KiB. A single-frame looped GIF is a documented false positive. A multi-frame GIF with no NETSCAPE block is a false negative. WebP checks the VP8X ANIM bit. APNG checks `acTL` before `IDAT`. SVG is never sent to Rust. `core.js` `_selectEntry` and `fsUtils.js` force `isAnimated = true` on `.svg`. That is a policy hack sitting on a boolean named for a different fact. `architecture-state.md` and the decoupling writeup already say so.

`Core.isAnimated` starts false, then flips. `getEffectiveScaling` rewrites Lanczos to bilinear. `actions.js` no-ops Lanczos and every filter toggle. `menubar.js` `syncViewMenu` mutes those rows. `viewerPipelines._resolveActiveFilter` returns null. `_applyTransform` bails on `_lastIsAnimated`. Overlay canvases stay at `opacity: 0` without `data-render-ready`. The visible pixels are `.viewer-img.active` with CSS `image-rendering`. That is not a bilinear canvas. It is the native `<img>`, and GIF/APNG/WebP play because the pool keeps `el.src` set. Recycle does `removeAttribute('src')` and playback stops.

When a filter is on for a still, `#viewport[data-filter]` sets `.viewer-img { opacity: 0 !important }`. Opacity, not `display: none`. That matters. Chromium keeps decoding an `opacity: 0` image. `display: none` often pauses it. Do not "clean up" that rule into `display: none` as part of this work.

The still GPU path is the other half of the problem. `glRuntime.render` calls `getCleanImage(imgElement.src)`. `blobImage.js` fetches the src, makes a blob URL, then throws the URL away and keeps `createImageBitmap(blob)`. `createImageBitmap` of an animated file is frame 1. The blob URL they already create is the same-origin live source we need, and it is unused. Texture identity is `src + width + height`, so even if the bitmap magically advanced, `texImage2D` would not run again. Lanczos does the same `getCleanImage` then pica after an 80ms pan settle. pica is a worker resize of a still crop. It is not a 15 fps path.

`glRuntime` also requires `imgElement.src` and `naturalWidth`. A canvas is not a legal `render()` source today, even though `texImage2D` would accept one. The decoupling writeup already said the runtime should not call `getCleanImage` internally. This work is the reason to finally move that call out.

Anime4K Fast/Normal is a chain of image-space CNN passes plus a viewport draw. CRT, phosphor, and scanlines are one viewport pass each. A 30 fps 1080p APNG through Normal Anime4K will hurt. A 256×256 GIF through CRT will not. The plan has to treat those as different bills, not one "filters" switch.

## The approach

Still images do not change. `glRuntime.render` keeps calling `getCleanImage`. Texture identity stays `src + width + height`. Pan still redraws without a re-upload. `blobImage.js` still returns an `ImageBitmap` for that path. Do not move `getCleanImage` out of the runtime as a prerequisite. Do not add `pixelsChanged` to the still call sites.

Animated files and SVGs also do not change until the user turns a filter on or sets scaling to Lanczos. Pixelated and bilinear stay CSS `image-rendering` on the pool `<img>`. The decoder keeps the clock. No staging canvas, no second Image, no extra rAF.

The gate is:

```
wantsFilterOrLanczos = activeFilter !== null || scaling === 'lanczos'
useLivePump = isAnimated && wantsFilterOrLanczos
useStillGpuForSvg = isSvg && wantsFilterOrLanczos
```

`isSvg` is a local filename check, not a new Core flag. `isAnimated` stays the header fact from `check_is_animated`. SVG can keep being forced to `isAnimated = true` if that is the cheapest unmute, but then a still SVG would take the live pump, which is wasted rAF. I would rather drop the SVG force-flag so SVG + filter/Lanczos uses the existing still GPU path, and GIF/APNG/WebP use the pump. With filter and Lanczos both off, both kinds stay a pool `<img>`. The render path only diverges when the matching gate is true.

When `useLivePump` is true: keep the pool `<img>` playing under the existing `opacity: 0` rule, blit the current composited frame onto a staging 2D canvas, upload that canvas to the existing GL runtime every animation tick. Same shaders. Same overlay canvas. Same inverse-transform contract. When `useLivePump` flips false, tear the pump down, evict the live Image, hide the overlay, show the pool `<img>` again.

When `useStillGpuForSvg` is true: rasterize once through `getCleanImage` / the still GPU or Lanczos path at the pixel size `_applySvgBounds` already computed. No rAF pump. SMIL inside an `<img>` will not play in WebView2 in any way I would bet on. That is the compromise. Filter or Lanczos off, it is an `<img>` again.

The live blob Image is only for `useLivePump`. `quivit://` and `asset://` are cross-origin. Drawing the pool `<img>` onto a 2D canvas taints it. `blobImage.js` already fetches the bytes. Only while `useLivePump` is true, point a same-origin `Image` at `URL.createObjectURL(blob)` and keep it alive. Do not `createImageBitmap` on that live Image. Do not replace the still `ImageBitmap` cache with this. When `useLivePump` turns off or the source changes, revoke it.

Capture at `naturalWidth` × `naturalHeight`, allocate the staging canvas and the extra GL texture once per gated source, then `texSubImage2D`. Capture at image size, not viewport size. Direct `texImage2D` from the live `Image` skips a blit. Try it in WebView2 on a real GIF. If it sticks on frame 0, keep the staging canvas. Write the canvas path first. Do not ship both. Do not teach the still path this trick.

Lanczos on a still SVG is the existing pica crop. Lanczos on a GIF is not. pica-per-frame fights the performance rule. An 80ms settle on a 10 fps GIF is a stutter machine. If the user turns Lanczos on for an animated file, either keep CSS bilinear under the overlay and document that, or run a GPU scaler pass inside the gated pump. Do not call `createLanczosPipeline().render` from rAF. Do not change how still Lanczos works.

## Ownership

`viewerPipelines.js` already owns overlay canvases and the pan rAF. The playback rAF lives there. It starts when `useLivePump` becomes true and stops when it becomes false. Do not add a sibling that also writes `#viewer-filter-canvas`. Do not put rAF inside `glRuntime.js`. Do not fold the pump into the still pan path so every PNG pays for a branch that never runs work. A boolean at the top of `_applyTransform` is fine. Rewriting `_applyTransform` around live sources is not.

`blobImage.getLiveImage(src)` is an addition, used only by the gated path. `getCleanImage` stays the still owner and keeps returning `ImageBitmap`. Do not merge them. Do not make still renders go through a live `Image`.

`glRuntime` still renders stills the way it does today. The pump needs a way to upload a canvas every tick without going through `getCleanImage(img.src)`. Add a narrow method the overlay owner calls only while the gate is true, something like `updateSource(canvas)` plus the existing `render` for geometry, or a `render` overload that the still path never uses. Do not change the still `render(imgElement, geometry)` contract. Do not replace src-identity caching with a `pixelsChanged` flag on every caller. Still pan must keep skipping `texImage2D`.

`actions.js` and `menubar.js` unmute filter and Lanczos rows for animated files and SVGs so the user can turn the gate on. The mute was the skip. Unmuting is not a render-path change. Match the menu to the code. A muted row that now works is a lie. An unmuted row that still no-ops is also a lie.

Staging canvas: declare a hidden node in `index.html` if you want HTML-first, or keep it in `viewerPipelines.js`. It is idle, 1×1 or `hidden`, until `useLivePump` is true. Do not `createElement` from `services/`. Do not allocate it for still images or for SVG.

Filter modules do not change. CRT latch math stays in `crt.js`. Anime4K chains stay in `filters/anime4k/`. The runtime still does not know their names.

Rust `is_animated` stays in `formats.rs`. The IPC name stays `check_is_animated`. If we tighten GIF detection, that is a header heuristic change with tests in `format_tests.rs`. Do not widen visibility for tests.

## Work

Do this in small slices that boot. PNG, JPEG, and still WebP must take the same code path they take today, including `getCleanImage` inside `glRuntime.render`. If a slice needs to rewrite that to make the GIF path possible, the slice is wrong.

### 1. Ungate the menu, keep the cheap path

Stop no-oping filter toggles and Lanczos for `isAnimated` in `actions.js`. Stop muting those rows in `menubar.js`. `_resolveActiveFilter` and `_applyTransform` still skip GPU work until later slices wire the pump. Turning CRT on for a GIF may now set `active_filter` in config. The overlay must not appear until the pump exists, or you will hide the `<img>` with `data-filter` and show an empty canvas. Either keep the skip in `_resolveActiveFilter` until slice 3, or set `data-filter` only after a live frame has uploaded. I would keep the skip until the pump is real.

SVG: stop forcing `isAnimated = true` in `core.js` and `fsUtils.js` only if you are ready for SVG + Lanczos/filter to hit the still GPU path in the same slice. That path is already gated on Lanczos or a filter being on. With both off, SVG stays an `<img>`. Prove `getCleanImage` rasterizes a typical SVG at a usable size. Percentage SVGs already get `--svg-base-w/h`. If the bitmap comes back 300×150, pass the bounds size in. If SVG + still GPU is too much for one slice, leave the SVG force-flag and special-case the menu unmute. Do not invent `isSvg` on Core.

Manual check: still PNG with CRT and Lanczos unchanged. GIF with filters off still plays natively. GIF filter toggle is clickable but does not blank the image yet. SVG with filters off is still an `<img>`.

### 2. Live blob image, gated

`blobImage.getLiveImage(src)`: fetch, object URL, `new Image()`, `decode()`, cache until evict. Call it only from the gated path. Still `getCleanImage` is untouched. Do not revoke the URL while that Image is the active gated source. Evict when the gate turns off, on source change, and on pool recycle.

No still caller should import `getLiveImage`.

### 3. Frame pump, gated

In `viewerPipelines`, compute `useLivePump` from Core state. When it becomes true:

- Keep `_activeSource` as the pool img so playback continues under `opacity: 0`.
- Size the staging canvas to the live image's `naturalWidth`/`naturalHeight`.
- Start a rAF loop that `drawImage`s the live image onto the staging canvas, then uploads through the narrow runtime method and draws the existing passes.
- Stop the loop when `useLivePump` becomes false, on `clear`, on source change, and when `document.hidden`.
- When `useLivePump` is false, do not create the live Image, do not resize the staging canvas, do not call `updateSource`.

Still `_applyTransform` stays on `pipeline.render(_activeSource, geom)` with `getCleanImage` inside the runtime. Do not merge the two.

Generation counters already exist. Bump them on source change so an in-flight gated `render()` cannot stamp `data-render-ready` on a still PNG.

### 4. Cost control for Anime4K, gated only

This cap lives on the pump. Still Anime4K is unchanged.

CRT/phosphor/scanlines: one pass, run at display refresh, cheap enough.

Anime4K: if the previous gated `render()` has not resolved, skip the tick. Do not queue. If a 4K APNG still melts the machine, drop the capture resolution for Anime4K only, never for CRT, and never for stills. Measure before adding a knob.

Uploading every rAF of a 256×256 GIF is fine. Uploading every rAF of a 4000×4000 APNG is not. Cap the staging canvas's long edge. 2048 is a starting guess. Downscale with `drawImage` into that cap. Record the cap in one constant next to the pump, not in `glRuntime`.

### 5. GIF header honesty

`check_gif` only looks for NETSCAPE. Treat a second image descriptor in the 8 KiB header as animated even without a loop block. Keep the single-frame NETSCAPE false positive. Extend `format_tests.rs`. This is so a filter-on GIF without NETSCAPE does not fall into the still `createImageBitmap` path and freeze. False negatives become user-visible the moment the gate can turn on.

### 6. Lanczos on animated, still gated

Only after filters look right on GIF/APNG/WebP. The gate already includes `scaling === 'lanczos'`. Still Lanczos is still pica after 80ms. Animated Lanczos is either CSS bilinear under the filter overlay, or a GPU scaler inside the pump. Do not call `createLanczosPipeline().render` from the rAF loop. Do not change `lanczos.js` to accept a frame pump.

## What not to do

Do not make the live Image, staging canvas, or playback rAF part of the still-image architecture. Do not rewrite `glRuntime.render` for PNG/JPEG/WebP to get GIFs working. Do not replace `getCleanImage` with `getLiveImage` globally. Do not add `pixelsChanged` to still pan. Do not allocate the staging canvas or fetch a blob URL until the gate is true. Do not leave the pump running after the user turns the filter and Lanczos off.

Do not add gifuct-js, omggif, libgif, or a WASM WebP decoder. Do not parse disposal methods. Do not use `ImageDecoder` for v1. Do not convert animations to `<video>`. Do not put filter names in `glRuntime`. Do not grow `main.js` or `lib.rs`. Do not split overlay ownership. Do not `display: none` the pool img to hide it. Do not `createImageBitmap` on the live path. Do not fetch the archive entry twice. Do not run pica at 60 Hz. Do not inline SVG into the DOM. Do not invent an `isSvg` Core flag unless a slice creates a real second policy.

The frame timeline in `additions.md` wants play/pause and `cmd-next` as frame step. That needs a clock we own, which is when a decoder starts to make sense. Do not sneak timeline work into this. Leave the `<img>` as the clock.

## Risks I would actually test

WebView2 pausing an `Image` that is not in the document. The demo relies on that. Our pool img is in the document at opacity 0, which is safer. Use the pool img as the `drawImage` source if the blob-URL `Image` freezes, but only if that source is the blob-URL img, not the `quivit://` pool node. The pool node taints. So the live cache has to work. If `img.decode()` on a blob-URL GIF does not animate, we are stuck and need a different engine probe before writing more code.

`createImageBitmap` vs blob-URL `Image` memory. A long APNG will keep decoded frames in the decoder. Evict when the gate turns off, on source change, and on pool recycle. A GIF that had CRT on and then off must not keep a live Image ticking in the cache.

Premultiplied alpha. The GL context is `premultipliedAlpha: true`. GIF binary transparency through a 2D canvas can fringe. Phosphor and scanlines already had a bleed fix. Check a GIF with a transparent background under CRT before calling the slice done.

Y flip. The demo sets `UNPACK_FLIP_Y_WEBGL`. Our runtime uses `u_renderTargetFlipY` per pass instead. A canvas upload might come in upside down relative to an `ImageBitmap` upload. Prove it on a GIF with text in the first frame.

Archive entries. ZIP header reads are cheap. RAR/7Z/TAR still extract then slice. The live image fetch is `fetch(src)` on the `quivit://` URL, which is the full entry, not the 8 KiB header. Stills already pay that through `getCleanImage`. The gated path must not fetch a second copy of the same src, and must not fetch at all until the gate is true.

## Verify

Still PNG, JPEG, WebP: pixelated, bilinear, Lanczos, each filter, pan, zoom, filter off. Same path as before this work. No live Image, no staging blit, no extra rAF. No flicker on first activation. Anime4K Fast/Normal switch without reload.

SVG: CRT and Lanczos on. Percentage-sized SVG still has a box. Filter off returns to the `<img>`.

GIF with NETSCAPE, APNG, animated WebP, from disk and from a cbz: native playback with filters off. CRT on, motion continues, scanlines stay in screen space while the image pans. Phosphor, scanlines, Anime4K Fast. Filter off, native playback resumes without a hitch. Next/prev recycles and the previous file's pump is dead.

Single-frame GIF with NETSCAPE: may still report animated. CRT should at least not freeze on a black canvas.

Huge APNG if we have one in `test-files`: app stays interactive. If it does not, the long-edge cap is too high.

`cargo test` in `src-tauri` after the GIF heuristic change. `node --check` on touched JS.

Do not port this into `implemented.md` until the GIF/APNG/WebP filter path has been watched with human eyes. A screenshot of frame 1 proves nothing.
