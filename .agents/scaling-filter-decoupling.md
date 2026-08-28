# Scaling and filter decoupling

`feature/filters` added Lanczos, four WebGL filters, and header-only animation detection. The features work. The files they landed in will not survive a fifth filter, a real Anime4K port, or another scaler without turning into the same kind of god-file this repo already spent a decoupling pass getting rid of.

This split keeps behavior. The overlay still sits on the viewport and inverts the CSS transform itself. Lanczos still crops to the visible region and settles after pan. Filters stay mutually exclusive. Animated images still skip GPU paths for now. Shaders are not retuned. What changes is who owns a shader, who owns a GL context, and how a later agent touches one method without reading the other three.

UI work here is structure, then presentation, then behavior. Each commit boots. Folders appear when a commit creates a sibling, not as a rename-only pass. Domain modules do not query the DOM. Overlay canvases have one UI writer. `ACTION_REGISTRY` stays the only `cmd-*` list. Config-key changes prove their consumers. The pan path does not allocate, walk flags, or rebuild pipelines.

The old JS and Rust decoupling writeups show which ownership rules already landed. They are not a template. Those docs were a slice machine. This one is a map of the current mess and a target an agent can implement without a ritual.

---

## What "done" looks like

One JS file per scaling method that actually has a pipeline. One JS file per filter. A small GL runtime that does not know filter names. A method catalog that Core and `actions.js` derive from. One overlay canvas with one UI writer. Config stores one active filter id, not four booleans. View-menu checked/muted has one writer in `menubar.js`. Animation IPC has one caller on Core.

After that, replacing Anime4K means editing `filters/anime4k.js` and maybe its GLSL helpers. Not `webglPipeline.js`. Not CRT. Not `viewerRender.js`. The runtime already has to support more than one pass, because the current Anime4K shader is a 4-neighbor laplacian and the real algorithm is a chain of passes with ping-pong framebuffers. If the runtime can only compile one fragment shader, the next Anime4K rewrite will blow the split back open.

---

## Files this branch actually touched

`git diff main...HEAD --name-only` is 39 files. Not all of them are this work. The list below is the scaling/filter/animation set. Everything else is noted at the end as coincidental.

### The monoliths

`src/js/services/webglPipeline.js` is the problem. ~477 lines. Vertex shader, inverse-transform GLSL, four fragment shaders, compile/link, uniform cache, texture upload, CRT latch math, draw. `createWebglPipeline(canvas, scalingMode, activeFilter)` takes a scaling mode it never uses. Unknown filter ids silently fall back to the Anime4K shader. Switching CRT to Scanlines disposes one canvas's program and builds a second WebGL2 context on the other canvas. CRT latch math lives in `render()`, so the runtime knows a filter by name. Overlay pixels are written from here (`canvas.width`, `style.removeProperty`) and again from `viewerRender`. Two writers on one surface.

`src/js/viewer/viewerRender.js` is the other problem. The image pool, the 45ms swap buffer, SVG bounds, neighbor preload, *and* pipeline create/dispose/rAF/80ms settle all live here. `_resolveActiveFilter` reimplements Core's four booleans, a second owner for the same fact. `_applyScaling` runs on every `viewportState` notify, which is every pan and zoom. A mode switch on a geometry hot path. `_lastScalingMode` is written and never read. Teardown still clears `data-crt`, an attribute nothing sets anymore.

### State, actions, chrome

`src/js/core.js` owns `setFilter` as a four-boolean mutex and `isAnimated` as a GPU-skip flag. SVG files are marked animated so they skip Lanczos and WebGL. That is a policy hack sitting on a boolean named for a different fact.

`src/js/services/actions.js` has four nearly identical toggle handlers plus cycle-scaling that special-cases `isAnimated`. The ids are handwritten here, in `index.html`, in `options.html`, and in `mergeConfig`.

`src/js/main/main.js` copies the same four toggles again to set `.checked` and `.muted`. Bootstrap is painting the View menu. `chrome.js` already owns menubar/statusbar checkmarks. Fullscreen owns its own. `shortcuts.js` owns the `.shortcut` labels inside those rows. Scaling and filter checked/muted belong in `menubar.js` with the dropdowns. Do not teach `actions.js` to `getElementById` for this. It already does that for the file-list checkmark. Do not spread the pattern.

`src/js/keybinds.js` `mergeConfig` lists `crt_filter`, `anime4k_filter`, `phosphor_filter`, `scanlines_filter` as separate defaults.

`src/js/services/viewerMath.js` holds viewport math, which is fine, plus `getEffectiveScaling` and a `setScaling` that just stores a string. Scaling mode currently lives in three places: `Core.scalingMode`, `viewportState._scaling`, and `main.js` `activeScaling`. Core is the owner. The other two are mirrors.

### Pipelines and helpers

`src/js/services/scalingPipeline.js` is Lanczos via vendored pica. Dummy `{type, render: null}` objects for `none` and `bilinear` that `viewerRender` never constructs. Creates two DOM canvases with `document.createElement` from a folder that is supposed to have no document access. Pixelated and bilinear are CSS `image-rendering` on the `<img>`. They are not pipelines.

`src/js/shared/blobImage.js` is the same-origin fetch/decode cache. Custom protocol URLs taint canvas and WebGL without it. Single slot. Coalesces in-flight fetches for the same src. This stays. The GL runtime should not call it internally. The second decode is a taint workaround, not a thumbnail. Do not add a third copy.

`src/js/viewer/viewer.js` is a thin facade. It already is. Leave it.

### Markup and CSS

`src/index.html` has three canvases. `#viewer-lanczos-canvas` inside `#viewer-img-wrapper` so it follows the CSS transform. `#viewer-crt-canvas` and `#viewer-anime4k-canvas` as viewport siblings so the shaders can invert the transform themselves. The second overlay is named for one filter and used by three. Menu rows for the four filters and three scaling modes are static, which is the right call. Do not generate that menu.

`src/css/main.css` styles both overlay canvases the same way, then hides the base `<img>` with `:has([data-render-ready])`. Visibility is already a token, not inline opacity. Still has `data-scaling="bicubic"` from the rename to bilinear. `:has()` from a sibling canvas back to the wrapper invalidates more than it needs to. Filter-on is viewport state. Put `data-filter` on `#viewport` and hide `.viewer-img` from that host. Not `body.crt *`. Not `:has()`.

`src/options.html` has a Filters heading and four keybind rows. Those rows stay static. They must keep matching action ids.

### Backend, animation skip

`src-tauri/src/formats.rs` `is_animated` on an 8 KiB header. GIF NETSCAPE scan bounded to 2 KiB. WebP VP8X animation bit. APNG `acTL` before `IDAT`. No tests. Domain stays here. Do not move it into `lib.rs` or the command file.

`src-tauri/src/commands/animation.rs` is a thin IPC adapter. Fine. The command name and JSON stay `check_is_animated`.

`src-tauri/src/archives/mod.rs`, `cache.rs`, `zip.rs` add `read_entry_header` on the `ArchiveCache` facade. ZIP is a real limited read. RAR/7Z/TAR still wait for full temp extraction, then slice. That is a performance lie for those formats, not a module-shape problem. Callers already go through the facade. Leave it there.

`src-tauri/src/lib.rs` and `commands/mod.rs` just register the command. No new commands in this work. Tests stay under `tests/` via `#[path]`.

`src/js/fsUtils.js` calls `check_is_animated` on `loadFile` / `loadArchive`. `core.js` `_selectEntry` calls it again on every later selection. Two owners for one IPC.

`test-files/single-frame.gif` is a fixture for the GIF false-positive. Keep it.

### Docs that describe this work

`README.md` features line, `.agents/implemented.md`, `.agents/architecture-state.md` still names `webglPipeline.js` as "the" WebGL pipeline, `.agents/additions.md` still defers animated Lanczos/WebGL. `legacy-reports/scaling_research.md` called Anime4K "implemented" when the shader is a laplacian. `legacy-reports/bug_report_anime4k_crt.md` and `feature-filters-validation-remediation.md` are historical. Do not treat them as the current spec. Several of those bugs are already fixed.

### Not this work

Makefile, commit-pipeline, validate/verify skills, `keybindUi.js` scroll-zoom reset, `options.js` modifier persist, `options.css` `.scroll-mode-controls`. Leave them alone. `src/js/vendors/pica.js` stays vendored. Do not wrap it as ESM. Do not also import the npm `pica` package at runtime. The script tag in `index.html` is the load path. pica stays on workers.

---

## What is actually wrong

**Five writers for one filter choice.** Filters are mutually exclusive. `core.js` `setFilter`, `viewerRender._resolveActiveFilter`, `actions.js` toggles, `main.js` checkmarks, and `keybinds.js` `mergeConfig` all re-encode that fact. A fifth filter is six files. A knob that belongs to one filter has nowhere to live except another Core flag. Store `active_filter` as `null` or an id. Give each filter an options object that `mergeConfig` round-trips and otherwise ignores. Methods that need knobs later read their own bag. Methods that do not never look. Core is the writer. Everyone else reads the id.

**One file, four shaders, one pass.** Real Anime4K is denoise / gradient / push / refine, with intermediate textures. The current runtime compiles one fragment shader and draws a quad. If an agent ports the actual algorithm into this file, CRT and Scanlines eat the blast radius. Split first. Four filter files do not share a surface. They share a runtime. That is not splitting one owner. Putting CRT latch math in `render()` is. It moves into `crt.js`.

**Two overlay canvases, two GL contexts.** Both canvases are viewport-sized, same CSS, same inverse-transform contract. The split is leftover from an earlier CRT sizing experiment. `getContext('webgl2')` on a second canvas is a second GPU context. Filter toggles feel like a mode switch. They should be `useProgram`. One HTML node. Delete `#viewer-crt-canvas`. Do not keep a zombie canvas for compatibility.

The surviving node's id is a custom-CSS blast radius. Users already target `#viewer-anime4k-canvas` from `custom_css.css`. Slice 2 discusses keep-id vs rename. In-repo CSS moves hide-the-base-image to `#viewport[data-filter]`. Keep `data-render-ready` on the canvas so old `:has([data-render-ready])` custom CSS still has a hook.

**`viewerRender` orchestrates GPU on the pan hot path.** `viewportState.subscribe` calls `_cancelRender`, `_applyScaling`, `_scheduleTransform`, `_triggerRender` on every geometry change. `_applyScaling` is a mode switch. Pan is not a mode switch. WebGL should render from the rAF transform path. Lanczos should keep its 80ms settle. Neither should rebuild a pipeline because the user moved the image two pixels. The rAF path reads a module pointer captured on config change. It does not walk four booleans or `Array.find`.

**Pool and overlay are one file.** The image pool is one owner. The overlay canvases are another. Cutting them apart is the split. Cutting the pool further is not. The overlay owner does not `querySelector('.viewer-img.active')`. That is reach-in. The pool pushes a `TexImageSource`.

`index.html` already declares two `.viewer-img` nodes for the pool of 2. HTML-first: reuse those. `createElement` only if the pool ever grows. Do not throw the static nodes away and rebuild them, which `viewerRender` still does a bit of on boot.

Pool and overlay are two surfaces. The pool keeps swap, preload, SVG bounds. Overlay `data-*` has one writer. `glRuntime` does not `getElementById`. The pool does not compile shaders. Pan does not rebuild a pipeline. Whether that overlay writer is a new `viewerPipelines.js` or a thin block left in `viewerRender` after the shaders leave is slice 4. Do not extract a file to satisfy the tree in this doc.

**Source upload is "fetch this `<img>.src` again."** `pipeline.render(imgElement, geometry)` always goes through `getCleanImage(imgElement.src)`. That is right for a still `quivit://` image. It is the wrong type for the runtime. The runtime should upload a `TexImageSource`. Image, canvas, ImageBitmap. The still-image path produces one of those via `blobImage.js`. Callers that already have pixels should not mint a blob URL to please the GL layer.

**`isAnimated` means three things.** True animation. SVG, so skip GPU. "Mute the menu." Backend `is_animated` is honest. Frontend overloads it. Do not rename the flag in this work. Skip policy lives in the overlay owner. The runtime renders what it is given. SVG skip stays, with a one-line comment that SVG is GPU-ineligible, not animated.

**Bootstrap paints the View menu.** Four copy-pasted checkmark blocks in `main.js`, plus `updateScalingMenu`. Thin bootstrap does not render another module's surface. One `syncViewMenu` in `menubar.js`, looping the catalog, writing `.checked` and `.muted` only. Leave `.shortcut` spans to `shortcuts.js`.

**Stale names and dead writes.** `#viewer-anime4k-canvas`, `data-crt`, `data-scaling="bicubic"`, unused `scalingMode` argument, unused `_lastScalingMode`, `FILTER_SHADERS[id] || animeFsSource`, Scanlines shader comments that still say "Opus hue edit zone", empty line runs in that shader, dummy `none`/`bilinear` pipelines. None of this is load-bearing. Delete it while the files are open. Do not replace it with "this is the CRT shader" narration. Keep *why*: CRT latch, GIF NETSCAPE false-positive, taint workaround.

**`preserveDrawingBuffer: true`.** Nothing reads the buffer. The old ghost frames came from stale promises applying `data-render-ready` after dispose, which `viewerRender` already generation-guards. Preserving the drawing buffer costs a copy every frame. Turn it off. That is a performance win, not a look change.

**`canvas.width = vpW` every frame.** Assigning `width` or `height` resets the drawing buffer. Only resize when the viewport size actually changed. Drawing buffer is not a CSS `width`/`height` write. CSS already has `width: 100%; height: 100%` on the overlay. Do not also set `canvas.style.width`. Lanczos crop uses `--crop-left` and friends on the host, which is an allowed custom-property write. `img.dataset.scaling` stays. The stylesheet maps it to `image-rendering`.

---

## Target shape

```
src/js/services/pipelines/
  glRuntime.js      WebGL2 context, compile, fullscreen quad, texture, pass runner
  glCommon.js       shared GLSL: inverse transform only
  registry.js       FILTERS and SCALERS catalogs

src/js/services/filters/
  anime4k.js
  crt.js
  phosphor.js
  scanlines.js

src/js/services/scaling/
  lanczos.js        today's scalingPipeline.js, minus dummy modes

src/js/viewer/
  viewer.js         facade
  viewerRender.js   image pool
  viewerPipelines.js overlay owner, if slice 4 extracts it
  viewerGestures.js pan input
```

`filters/` and `scaling/` appear in the commit that creates the second file. `webglPipeline.js` and `scalingPipeline.js` go away once the last caller moves. Do not leave re-export shims.

The overlay owner constructs the runtime, holds the Lanczos factory, sets `data-render-ready` on the canvas and `data-filter` on `#viewport`, generation-guards async renders. The pool keeps swap buffer, SVG bounds, preload, and pushes the active source. It does not compile shaders. `glRuntime` does not `getElementById`. Slice 4 names the overlay owner file.

Filter and scaler modules are strings, numbers, and GL calls on an injected context. `glRuntime.js` takes a canvas. It does not `getElementById`. Domain does not import UI.

HTML keeps one overlay, already in the page. Slice 2 names its id. Lanczos canvas stays inside the wrapper. Filter canvas stays a viewport sibling. Overlay ready is `data-render-ready` on the canvas. Filter-on is `data-filter` on `#viewport`, the component host. In-repo CSS hides `.viewer-img` from that host, not via `:has()`. Never inline opacity. Keep `data-render-ready` so existing custom CSS that uses `:has([data-render-ready])` still has a hook.

When the files exist, `architecture-state.md` drops the `webglPipeline.js` line for runtime + `filters/` + `scaling/lanczos.js` and names whichever file owns the overlay canvases. Record `active_filter` as the preference.

---

## Contracts

### Filter module

A filter file exports one object.

```js
export const anime4k = {
  id: 'anime4k',
  label: 'Anime4K',
  actionId: 'cmd-toggle-anime4k-filter',
  passes: [
    { fragment: `...`, name: 'push' },
  ],
  uniforms: ['u_strength'],
  setup(gl, programs) {},
  setUniforms(gl, locations, geometry, options) {},
  dispose(gl) {},
};
```

`options` is `config.frontend_data.filter_options[id]` or `{}`. The module may ignore it. The runtime always passes it. That is the expansion joint. Do not put method-specific keys on `frontend_data` as siblings of `active_filter`.

Shared uniforms the runtime sets for every pass, every filter:

- `u_texture`, `u_viewport`, `u_imageSize`, `u_scale`, `u_translate`, `u_rotation`, `u_flip`

CRT's `u_clamp` and `u_visualRect` are CRT uniforms. They move into `crt.js` `setUniforms`. The runtime does not know what latching is. If you need `if (id === 'anime4k')` in `glRuntime.js`, the contract is wrong.

A one-pass filter is `passes: [{ fragment }]`. Multi-pass is a list. Intermediates default to viewport-sized FBOs. Multi-pass is in the runtime because the Anime4K port cannot land on a one-shader runner. Texture-sized intermediates are a pass field added when the first filter that needs them lands, not a vacant key on today's objects. An empty `filter_options` bag is cheap and stops the next knob from becoming a Core flag.

Vertex shader stays in the runtime. One fullscreen quad, CSS-style screen coords, same as today. Filters do not ship a vertex shader.

### Scaler module

Pixelated and bilinear are CSS. They live in the catalog as `{ id, css: 'pixelated' | 'auto' }` with no pipeline. Do not give them files that pretend to render.

Lanczos exports a factory:

```js
export function createLanczosPipeline() {
  return {
    id: 'lanczos',
    type: 'crop',
    async render(source, geometry) { /* { canvas, width, height, cssLeft, cssTop, cssWidth, cssHeight } | null */ },
    cancel() {},
    dispose() {},
  };
}
```

`source` is already a decoded Image or ImageBitmap, not a URL. `getCleanImage` stays in the overlay owner, once per src, shared with WebGL so a filter toggle does not refetch.

Lanczos uses `OffscreenCanvas` for pica's src/dest. Fall back to `document.createElement('canvas')` only if `OffscreenCanvas` is missing. That keeps the method file from depending on the page's DOM tree.

### GL runtime

```js
createGlRuntime(canvas) -> {
  setFilter(filterModule, options),
  render(source, geometry) -> Promise<boolean>,
  resize(width, height),   // no-op if unchanged
  dispose(),               // context + programs + textures
}
```

One context for the life of the overlay canvas. `setFilter` compiles programs the first time a module is seen, caches them, `useProgram`s. Do not `loseContext` to change filters.

`render` accepts `TexImageSource`. If the source identity changed, `texImage2D`. If not, skip the upload and draw. Identity is the object reference plus `naturalWidth` or `width`, not `img.src`. A canvas that is redrawn in place must be able to force an upload. Pass `dirty` when the same object got new pixels. `resize` is the drawing buffer. It is not a CSS write.

`preserveDrawingBuffer: false`. `antialias: false`. `alpha: true`. Premultiply matching today's shaders. If a filter needs unpremultiplied sampling, that is that filter's problem to document, not a second context.

Compile errors stay `console.error` and a no-op runtime, same as today. Do not throw through rAF.

Create the context lazily on first filter toggle. Boot with no filter must not pay for CRT compile.

### Catalog and actions

`registry.js` is the method catalog. Domain only. Ids, modules, CSS mode, labels for humans. It is not a second action list.

```js
export const FILTERS = [anime4k, scanlines, phosphor, crt];
export const SCALERS = [
  { id: 'none', label: 'Pixelated', css: 'pixelated', actionId: 'cmd-scale-none' },
  { id: 'bilinear', label: 'Bilinear', css: 'auto', actionId: 'cmd-scale-bilinear' },
  { id: 'lanczos', label: 'Lanczos', pipeline: 'lanczos', actionId: 'cmd-scale-lanczos' },
];

export const FILTER_BY_ID = new Map(FILTERS.map(f => [f.id, f]));
export function activeFilterId(frontendData) { ... } // reads new key, falls back to old booleans
```

`ACTION_REGISTRY` remains the only `cmd-*` source. `actions.js` maps `FILTERS` into toggle rows so the id is not handwritten in two arrays, the same way `DEFAULT_KEYBINDS` is already derived from the registry. Search the registry before adding another `cmd-toggle-*-filter` by hand. `mergeConfig` uses catalog ids. The overlay owner looks up `FILTER_BY_ID.get(id)` once when the id changes, then holds the module pointer.

View-menu checked/muted is `menubar.js`, looping the catalog. Not `main.js`. Not `actions.js`.

HTML menu rows stay handwritten. Adding a filter is still a new `<li>` in `index.html` and a keybind row in `options.html`. The ids must match `actionId`. Do not `createElement` the View menu.

### Viewer overlay owner

One module holds the overlay canvases, constructs `createGlRuntime` once, constructs Lanczos once, sets `data-render-ready` on the canvas and `data-filter` on `#viewport`, generation-guards async renders, and skips GPU when `isAnimated` or the pool says the source is ineligible.

That module does not query the image pool. The pool pushes the active `TexImageSource` through an owner API when a node activates. Geometry-only updates call `runtime.render` or schedule Lanczos. They do not call `setFilter`. They do not rebuild a pipeline. Slice 4 decides whether this module is `viewerPipelines.js` or `viewerRender.js`.

---

## Config

Today:

```json
"crt_filter": false,
"anime4k_filter": true,
"phosphor_filter": false,
"scanlines_filter": false
```

Target:

```json
"active_filter": "anime4k",
"filter_options": {}
```

`active_filter` is `null` or a catalog id. `filter_options` is `{ [id]: object }`. Empty is fine. `mergeConfig`:

1. If `active_filter` is a known id or `null`, use it.
2. Else walk the old booleans in the same order `viewerRender` does now, CRT first, then Anime4K, Phosphor, Scanlines, and pick the first true one.
3. Stop writing the four booleans on save. Reading them forever is cheap. Writing both is how they drift.
4. Pass `filter_options` through as a plain object. Do not validate keys you do not know. `frontend_data` already round-trips unknowns in Rust. JS `mergeConfig` is the thing that currently enumerates every flag and would drop a future knob if someone adds it next to the booleans instead of inside this bag.

`Core.setFilter({ anime4k: true })` becomes `Core.setActiveFilter('anime4k' | null)`. Toggle in actions is "if current === id then null else id."

This is a config-key-family change. The commit that migrates it updates `architecture-state.md` and runs blast-radius on every reader of `crt_filter`, `anime4k_filter`, `phosphor_filter`, `scanlines_filter`, plus `mergeConfig`, Options, and saved roaming profiles. Not a grep writeup. IPC stays `check_is_animated` with the same JSON. Do not rename the command.

The canvas-id commit is the other blast-radius. Grep `#viewer-crt-canvas` and `#viewer-anime4k-canvas` in-repo. Custom CSS in roaming `custom_css.css` is user-owned and will not show up in git. Mention the rename where custom CSS is documented, or users keep styling a node that is gone.

---

## Replacing Anime4K later

This is the point of the split.

Current `animeFsSource` samples four screen-space neighbors, builds a luminance laplacian, and pushes color along it if the edge is above 0.05. That is unsharp masking. It is not [Bloc97/Anime4K](https://github.com/bloc97/Anime4K). `scaling_research.md` saying "Implemented" is how this got confusing. The menu label is a promise the shader does not keep.

After this refactor, an agent should be able to:

1. Open `src/js/services/filters/anime4k.js` and the GLSL it imports.
2. Replace `passes` with the real chain. Each pass is a fragment string plus a name.
3. Add intermediate textures through the pass descriptor, not by editing `glRuntime.js`, unless the runtime is missing a capability the descriptor already documents.
4. Read any knobs from `options`, not from new Core flags.
5. Leave `crt.js` and `viewerRender.js` unopened.

Do not port Anime4K in the same commits as the split. The split has to land with the laplacian still in `anime4k.js` so you can prove CRT, Phosphor, and Scanlines still match. Then the port is a filter-file change with a visual smoke of manga pages at 100% and at fit-width.

---

## Adding a method later

Filter:

1. New file under `filters/`. Export the object above.
2. Append it to `FILTERS` in `registry.js`. `actions.js` picks up the toggle from the catalog.
3. Static `<li id="cmd-toggle-...">` in `index.html`.
4. Static keybind row in `options.html`.
5. CSS only if the overlay needs a new token. Default CSS already covers a viewport-sized canvas.

Scaler with a real pipeline:

1. New file under `scaling/`.
2. Append to `SCALERS`.
3. Static menu row.
4. The overlay owner already looks up `pipeline` on the scaler entry. If the new scaler is crop-style like Lanczos, reuse that draw path. If it is another fullscreen GL pass, it is a filter, not a scaler. Do not invent a third overlay.

I would push back on putting Anime4K-style upscaling in the scaler list. It is a filter. Scaling in this app means how the base `<img>` is resampled. Filters are a pass over the displayed pixels.

---

## Work order

Commits that boot. Do not land a catalog that nothing reads. Structure, then presentation, then the performance wins that are not look changes.

### 1. Catalog, config, one menu writer

Add `registry.js` with ids, labels, action ids. Point `Core.setActiveFilter`, `mergeConfig`, and `actions.js` at it. `actions.js` derives the four toggle rows from the catalog. Migrate the four booleans on load. Keep `webglPipeline.js` working behind `activeFilterId()`.

Move scaling/filter checked and muted into `menubar.js` `syncViewMenu`, looping the catalog. Delete the four copy-pasted blocks and `updateScalingMenu` from `main.js`. Do not touch `.shortcut` nodes. Do not leave a fifth copy in bootstrap. Leave `activeScaling` until slice 5.

This is the config-key-family change. Update `architecture-state.md` here. Blast-radius the old boolean keys before calling it done.

Confirm: toggle each filter, restart, same filter comes back. An old `quivit_config.json` with `scanlines_filter: true` still enables Scanlines. Saving rewrites `active_filter` and drops the booleans.

### 2. One canvas, one GL context

Delete `#viewer-crt-canvas`. Point every filter at the surviving node. Stop creating a second context. Kill `data-crt`. Canvas keeps `data-render-ready`. `#viewport` gets `data-filter`. In-repo CSS hides the base image from the viewport host. Shaders stay inline. Presentation only.

Discussion, before this commit: keep the surviving id as `#viewer-anime4k-canvas`, or rename to `#viewer-filter-canvas`. Keep-id does not break user `custom_css.css` that already targets the Anime4K canvas. Rename tells the truth and breaks those selectors. `#viewer-crt-canvas` goes away either way. Pick the path, then blast-radius the chosen id. Do not ship both nodes.

Confirm: CRT bezel still goes black outside the tube. Other filters still show checkerboard outside the image. Switching Anime4K → CRT → Scanlines does not leave a frozen frame. DevTools shows one WebGL context.

### 3. `glRuntime.js` + one file per filter

Move inverse-transform GLSL to `glCommon.js`. Move each fragment shader and its extra uniforms into `filters/*.js`. `webglPipeline.js` disappears in the same commit. No shim.

Runtime gains `passes[]` and FBO ping-pong even though every current filter is one pass. `node --check` plus a manual toggle. There is no test harness for GL yet. Do not invent one here. `additions.md` already parked that under Instrumentation.

Confirm: visual match with the previous commit on a tall manga page, a small icon, a transparent PNG, and a 90° rotate, for each filter. CRT axis latch still transfers when the image fills the window. Laplacian Anime4K is unchanged.

### 4. Overlay owner, pan path, ImageBitmap

Stop calling `_applyScaling` from `viewportState.subscribe`. The pan path is render, not rebuild. Reuse the two static `.viewer-img` nodes already in `index.html`. Lanczos 80ms settle stays. WebGL is rAF only. Drop the leftover CRT 80ms path. `getCleanImage` once per src, shared. `preserveDrawingBuffer: false`. `canvas.width` only on real resize. `createImageBitmap` after the blob decode in `blobImage.js`. Close the bitmap on evict.

Discussion, before this commit: extract `viewerPipelines.js`, or keep overlay orchestration in `viewerRender.js` now that shaders live in filter files. Extract is the one-owner path, pool vs overlay. Keep is the surgical path if what remains is a thin rAF plus Lanczos timer. Look at `viewerRender.js` after slice 3. If GPU lifecycle still drowns the pool, extract. If it is a short call into `glRuntime`, keep. Do not extract to match a tree in this doc. The overlay writer, whichever file it is, does not `querySelector` the pool. The pool pushes a `TexImageSource`.

Confirm: rapid pan with CRT on does not hitch more than today. Lanczos overlay still appears after settle and tracks crop CSS variables. Image swap buffer still holds the previous page. Filter toggle during a 45ms bridge still waits, same as the current `willBridge` early return.

### 5. Lanczos file, CSS modes, nits

Move `scalingPipeline.js` to `scaling/lanczos.js`. Delete dummy modes. Use `OffscreenCanvas`, with `document.createElement('canvas')` only if it is missing. Drop `bicubic` CSS. Delete `viewportState.setScaling` / `getScaling` and `main.js` `activeScaling`. Overlay and menu read `Core.getState().scalingMode`. `getEffectiveScaling` stays as a pure function.

### 6. Animation IPC and backend tests

One helper on Core for `check_is_animated`. `fsUtils` `loadFile` / `loadArchive` call that helper. They do not invoke the command themselves. Memo stays in Core.

Add `format_tests.rs` cases for GIF with NETSCAPE, GIF without, WebP VP8X animation bit, APNG acTL/IDAT order, short buffers, and `test-files/single-frame.gif` as the documented NETSCAPE false-positive. Do not change that false-positive behavior.

Comment `read_temp_entry_header` so it matches the code: RAR/7Z/TAR wait for full extract, then slice. Do not change the extract path.

End of the work: `verify-implementation`. Do not run `validate-changes` unless asked.

---

## File by file

**`webglPipeline.js`**  
Split until gone. Do not organize it with more comments.

**`filters/anime4k.js`**  
Today's laplacian, moved verbatim. No improvements. The port is a later change.

**`filters/crt.js`**  
Barrel, aberration, scanlines, vignette, `u_clamp` / `u_visualRect` math that currently sits in `render()`. That JS block is CRT, not runtime.

**`filters/phosphor.js`**  
Triad mask, scan, bleed. Keep constants as named consts at the top of the file, same as Scanlines.

**`filters/scanlines.js`**  
Geom Gaussian beam. Delete the "Opus hue edit zone" comment and the extra blank lines. Keep the numeric consts. They are the look.

**`pipelines/glCommon.js`**  
`inverseTransformGLSL` only, until a second shared helper exists. Do not pre-create a utilities dumping ground.

**`pipelines/glRuntime.js`**  
Context, compile, link, quad, texture, pass loop, resize. No filter ids.

**`pipelines/registry.js`**  
Catalog. Imports filter modules. That is the one place a new filter is listed in JS. Not a second `cmd-*` list.

**`scaling/lanczos.js`**  
Pica crop path. Shared `getCleanImage` result as input.

**`scalingPipeline.js`**  
Delete after the move.

**`blobImage.js`**  
Keep. `createImageBitmap` after decode for `texImage2D`. Same cache keys. Evict revokes the object URL and closes the bitmap.

**`viewerRender.js`**  
Lose shader compile, `_resolveActiveFilter`, the CRT 80ms path, pan-path pipeline rebuild. Keep pool of 2 on the static HTML nodes, 45ms debounce, preload, SVG bounds, statusbar image metrics. Overlay canvases stay here unless slice 4 extracts them.

**`viewer/viewerPipelines.js`**  
Created only if slice 4 extracts. Overlay owner. Self-subscribes. Does not query `.viewer-img.active`.

**`viewer.js`**  
If slice 4 extracts, construct the overlay owner next to the renderer and pass it in. One place.

**`viewerMath.js`**  
Keep invert/fit/zoom/pan. `getEffectiveScaling` stays as a pure function. Delete scaling storage on the viewport object.

**`core.js`**  
`setActiveFilter`. `filter_options` untouched by Core except pass-through. Animation memo and IPC stay. SVG skip stays, documented as GPU-ineligible.

**`actions.js`**  
Map `FILTERS` into `ACTION_REGISTRY` toggle rows. Do not keep a parallel handwritten cmd list. Lanczos action still no-ops when `isAnimated`. Cycle scaling still uses `getEffectiveScaling`.

**`main.js`**  
Delete the four filter checkmark blocks and `updateScalingMenu`. Bootstrap stays thin.

**`menubar.js`**  
`syncViewMenu`: scaling and filter `.checked` / `.muted` from the catalog. Do not write `.shortcut`.

**`keybinds.js`**  
`active_filter` + `filter_options` in `mergeConfig`. Old booleans as read-only migration.

**`fsUtils.js`**  
Stop invoking `check_is_animated`. Call the Core helper. Do not duplicate invoke options.

**`index.html`**  
One filter canvas. Menu ids unchanged. Static rows.

**`main.css`**  
One overlay selector. Drop bicubic. Lanczos rules unchanged. `#viewport[data-filter] .viewer-img` to hide the base image. No `:has()`. No `body` descendants.

**`options.html`**  
No structural change unless a label is wrong. Rows already match action ids.

**`formats.rs` / `commands/animation.rs` / archive header reads**  
Stay. Add tests. Comment the temp-extract "header" path.

**`lib.rs`**  
No new commands.

**`architecture-state.md`**  
Replace the `webglPipeline.js` line with runtime + `filters/` + `scaling/lanczos.js` and the overlay owner slice 4 named. Config line for `active_filter`. Only when the files exist.

**`AGENTS.md`**  
One sentence under JS Module Ownership when this lands: filter and scaler methods live under `services/filters` and `services/scaling`; the GL runtime does not know their names; overlay canvases have one UI owner.

**`implemented.md` / README**  
Not this refactor's job unless a user-facing name changes. They should not.

---

## Performance, in one place

Hot path is pan/zoom with a filter on. Today that path: notify viewportState → cancel generation → `_applyScaling` → rAF → `getCleanImage` cache hit → `texImage2D` if src changed → set `canvas.width` → draw. `_resolveActiveFilter` walks four booleans on the way.

After:

- Pan does not call setFilter or rebuild programs.
- Active filter is a module pointer captured on config change. rAF does not walk flags or `Array.find`.
- `canvas.width` only when the viewport size changes. Drawing buffer, not CSS.
- `texImage2D` only when the source identity changes, or when the caller marks dirty.
- `preserveDrawingBuffer: false`.
- One GL context.
- Programs cached per filter id.
- Blob fetch still once per src, shared.

Lanczos stays off the pan hot path. 80ms after the last geometry change is intentional. Do not rAF Lanczos. pica is a resize of a crop. It is too expensive to be a per-frame overlay. It stays on workers.

Do not decode full-size images to make the overlay. The `<img>` is already decoded. `getCleanImage` exists because of taint. ImageBitmap from that blob is the cheaper GPU upload. Keep the cache at one entry. Neighbor preload should not populate it.

Filter compile happens on first use of that filter in the session, not at app boot. First toggle paying compile is better than every user paying for a CRT they never enable.

---

## Agent workflow

The failure mode I care about is an agent opening `webglPipeline.js` to "tweak scanlines" and rewriting CRT by accident. After this, `rg scanlines` should die in `filters/scanlines.js`, the catalog line, and the HTML label.

- New DOM for the overlay goes in the overlay owner slice 4 named.
- New shader goes in a filter file.
- New resample algorithm goes in `scaling/`.
- New Core flags for filter look are a smell. Use `filter_options[id]`.
- Do not add a second overlay canvas.
- Do not compile GLSL in `viewerRender.js`.
- Do not teach `glRuntime.js` the name of a filter.
- Do not `querySelector` the image pool from the overlay owner.

---

## What not to do

Do not introduce a bundler so shaders can be `.glsl` imports. The frontend is static files. Template strings in JS are the module system we have.

Do not generate the View menu from JS.

Do not split `viewerRender.js` pool code in this pass. Pool vs overlay is the cut. Pool vs gestures is already done.

Do not move inverse-transform math out of GLSL into JS for WebGL. The whole point of the overlay is that CSS transform and the shader agree because the shader inverts the same numbers. Lanczos inverts in JS because it crops on CPU. Two inverters is ugly and still cheaper than sharing a wrong one.

Do not unify Lanczos onto the GL canvas. Different owner, different timing, different coordinate system.

Do not vendor Anime4K.js as a blob and call it a day. That library wants its own context and pass graph. The point of `glRuntime` is that CRT and Anime4K share a context. A port copies shaders and pass order into `anime4k.js`.

Do not treat `legacy-reports/js` or `legacy-reports/rust` as templates for the commits.

---

## Verification

Per commit: `node --check` on every touched JS file. `cargo check` if Rust moved. `cargo test` once animation tests exist. Config commit: blast-radius on the old `*_filter` keys. Canvas commit: blast-radius on `#viewer-crt-canvas` and on the surviving overlay id slice 2 chose, including the custom CSS docs. End of the work: `verify-implementation`. Do not run `validate-changes` unless asked.

Manual, once at the end of 2 and once at the end of 4:

- Each scaler on a still PNG. Pixelated stays sharp. Bilinear is the browser. Lanczos overlay lines up with the image, including after zoom.
- Each filter on a tall page, a wide page, a small image, a transparent PNG, 90° rotate, flip.
- Filter toggle spam. No ghost canvas. Base image returns when filter is off.
- Animated GIF/WebP/APNG: menu muted, bilinear fallback, no GL overlay. SVG: same skip.
- Theme toggle and custom CSS while CRT is on. Shell background still follows `--surface`. Overlay must not tint the native frame.
- Options keybind rows still capture for the four filter actions.

If a commit changes config shape, test a roaming profile that still has the old booleans.

---

## When it is done

Working tree on `feature/filters` or a follow-up branch, app boots, four filters and Lanczos look like they do today, `webglPipeline.js` gone, one overlay canvas, `active_filter` in saved JSON, Anime4K still the laplacian in its own file waiting for a real port.

That last part is on purpose. A decoupling that also "fixes" Anime4K is two jobs, and the second one has no visual baseline if you change the shader in the same diff as the move.
