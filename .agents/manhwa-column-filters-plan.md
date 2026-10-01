Validation comparison performed against .agents/AGENTS.md and .agents/skills/validate-changes/SKILL.md before presenting. Each slice below was checked for module ownership, pure module direction, CSS source of truth, HTML first rendering, blast radius with runnable checks, and docs discipline. Findings are inline in the slice notes.

# Manhwa column lanczos and filters plan

**Target:** working tree, manhwa column treated as one raster for scaling and filtering.

**Scope lock:** Add lanczos and filter support to manhwa view by compositing the visible column window to one staging canvas and running the existing WebGL runtime once over that composite. No per slot canvas. No per slot WebGL runtime. No pica in manhwa. Bilinear and none stay on CSS with no compositor. Rotation stays blocked in manhwa. Spread stays mutually exclusive with manhwa through `Core.setManhwaMode`. No architecture-state or README edits during implementation. Deviations go here with reason and file.

**Definitions.** Legacy view means the single image viewport owned by `src/js/viewer/viewerRender.js`. Column means the vertical strip owned by `src/js/viewer/manhwaStrip.js`, element `#manhwa-strip` in `src/index.html:313`. Column raster means one staging canvas that holds the visible window composite drawn at column offsets, filtered once. Anchor means the active image mapped from `Core.getState().index` to `_anchorImgIdx` in `manhwaStrip.js`. Bridge means `#viewer-bridge-layer` in `src/index.html:339`, owned by `viewerRender.js`. l to m means toggling manhwa on. m to l means toggling manhwa off.

## Pipeline map

Legacy still path. `Core` in `src/js/core.js:401` stores `scalingMode` and in `src/js/core.js:410` stores `active_filter`. `registry.js:13` lists scalers and `registry.js:6` lists filters. `filterModules.js:7` resolves the active filter module. `viewerPipelines.js:115` picks the pipeline in `_applyScaling`. Still lanczos uses pica through `scaling/lanczos.js:15`. Moving lanczos with no filter uses the WebGL lanczos shader in `scaling/lanczosWebGL.js:3`. Any active filter uses `pipelines/glRuntime.js:3` through `render` in `glRuntime.js:172`. Still frames upload with `getCleanImage` in `glRuntime.js:181`. Live frames use `updateSource` plus `skipUpload` in `glRuntime.js:147`.

Legacy live path. Animated images pump `ImageDecoder` frames to `_liveStagingCanvas` in `viewerPipelines.js:538`. Video pumps the video element in `viewerPipelines.js:347`. SVG rasterizes through `#viewer-svg-pump` in `viewerPipelines.js:442` with caps 512 animated and 2048 static in `viewerPipelines.js:9`.

Manhwa current path. `manhwaStrip.js:1949` activates the strip and `manhwaStrip.js:2047` deactivates it. `_buildSrc` in `manhwaStrip.js:168` returns raw file or archive URLs with no canvas step. `_strip.dataset.scaling` syncs in `manhwaStrip.js:1974` and `manhwaStrip.js:2142`. CSS in `src/css/main.css:1701` maps that token to `image-rendering` only. Lanczos renders the same as bilinear. Filters never run because `viewerPipelines.js:683` returns early, `viewerPipelines.js:709` skips viewport updates, `setSource` in `viewerPipelines.js:716` ignores input, and `forceRender` in `viewerPipelines.js:737` ignores input. `actions.js:93` blocks lanczos and `actions.js:100` plus `actions.js:108` block filters when `manhwaEnabled` is true. `menubar.js:719` disables the same menu items with a 1 to 1 column note.

Bridging current path. l to m parks the active legacy node in the bridge and clears the single pipeline in `viewerRender.js:588` and `viewerPipelines.js:681`. m to l picks an anchor node from mounted, prefetched, or prefetching maps in `manhwaStrip.js:2052`, hands it off through `_onBridgeHandoff` in `manhwaStrip.js:2093`, parks it with target fit geometry in `viewerRender.js:198`, and releases it after a double rAF in `viewer.js:40` once a slot mounts.

## Touched files

Ownership stays as listed in `.agents/architecture-state.md`. New work extends the layering instead of moving it.

- `src/js/services/viewerMath.js`. Pure math. Add column composite helpers. No DOM.
- `src/js/services/filterModules.js` and `src/js/services/registry.js`. Read only unless a new catalog entry is needed. No change expected.
- `src/js/services/pipelines/glRuntime.js` and `src/js/services/scaling/lanczosWebGL.js`. Reuse as is. No change expected.
- `src/js/viewer/viewerPipelines.js`. Owns overlay canvases and the WebGL runtime. Owns the new column compositor and its render loop.
- `src/js/viewer/manhwaStrip.js`. Owns `#manhwa-strip`, slots, anchors, and layout. Exposes mounted node access for the compositor. Owns no canvas and no WebGL code.
- `src/js/viewer/viewerRender.js`. Owns `#viewer-bridge-layer` and the single image pool. Small bridge changes for filter aware handoff.
- `src/js/viewer/viewer.js`. Coordinates strip, renderer, and pipelines. Wires callbacks only.
- `src/js/services/actions.js`. Removes manhwa guards for lanczos and filters. Keeps rotation blocked.
- `src/js/menubar.js`. Removes manhwa disable for lanczos and filters. Keeps rotation disabled.
- `src/index.html`. Adds one `manhwa-filter-canvas` placeholder next to the strip. No dynamic node creation for stable chrome.
- `src/css/main.css`. Adds tokens and visibility rules for the column canvas. No inline visual values from JS except custom properties, transform, class, and data attributes.
- `mocha/actions.test.js`, `mocha/diagnosticsContract.test.js`. Update contracts that assert bilinear only and probe element lists.
- `e2e/specs/03-viewer.e2e.js`, `e2e/pageobjects/viewer.page.js`, `e2e/replay-diagnostics/probes/viewerPipelineProbe.js`. Update selectors and scenario contracts for the column canvas.

## Blast radius

The risk centers on shared pipeline state, menu contracts, recorded scenarios, and the bridge lifecycle.

- Shared filter state. `active_filter`, `filter_options`, and `scaling_mode` in `frontend_data` already persist and already drive legacy. Enabling them in manhwa changes what those same keys paint. A wrong mapping paints the column with the wrong shader or leaves `data-filter` set after toggle off. Check by reading `viewport.dataset` and `#manhwa-strip` dataset after each toggle in the running app.
- glRuntime reuse. The column render must not disturb the single image texture cache `_texSrc` in `glRuntime.js:195`. Safest path is one runtime per canvas, never shared. A shared runtime would leak single image textures into the column and back. Prove with separate `createGlRuntime` calls per canvas.
- Texture and canvas limits. A full chapter column can exceed max texture size and browser canvas height. The plan composites only the visible window plus a small overscan, sized to the viewport. Full column stitching is out of scope. A wrong size causes blank output or context loss. Prove with a long chapter open at fit width and a scroll from top to bottom.
- Video and animated slots. Slot video elements keep playing while mounted in `manhwaStrip.js:1179`. The compositor must draw the current video frame each rAF instead of caching one frame. Animated raster through `ImageDecoder` needs the same per frame path or motion freezes under a filter. Prove with one video gallery and one animated WebP gallery in manhwa with a filter on.
- SVG and ICO slots. SVG caps exist in `manhwaStrip.js:580` and `viewerPipelines.js:9`. ICO resolves through `_icoCache` in `manhwaStrip.js:158`. The compositor must draw the mounted node, not refetch the source, so these caps keep working.
- Bridge lifecycle. l to m must keep the parked legacy node until the first filtered column frame paints. m to l must park the anchor node with a clean target fit before legacy resumes its own pipeline. A premature release returns the blackout the bridge plan removed. A missing teardown leaves `data-render-ready` or `data-filter` set on the wrong view. Prove with rapid toggle on and off under lanczos and under each filter.
- Menu and shortcut contracts. `actions.js:115` and `actions.js:125` cycle scaling with a manhwa specific list. `keybinds.js` persists the mode. Saved scenarios in `e2e/scenarios/manhwa-*.json` dispatch action ids. Changing the cycle list or action guard changes recorded replay behavior. Prove with `npm run mocha` and one manhwa e2e spec.
- Probes. `viewerPipelineProbe.js` matches viewer classes and ids. A new canvas id and new data attributes can break the probe contract test. Prove with `npm test`.

Runnable checks per slice. `node --check` on each touched JS file. `npm run mocha` for pure unit tests. `cargo check --tests` only if Rust changes, none expected. One e2e spec for manhwa toggle, one `npm run diagnose` replay with filters on. Full `cargo test` is not needed for this frontend only change.

## Slice 1. Ungate selection and tokens with no render change

Goal is selection that persists and menus that stay enabled, while manhwa still paints exactly as today.

- [x] In `src/js/services/actions.js:93`, remove the `manhwaEnabled` guard from `cmd-scale-lanczos` so the mode saves through `Core.setScalingMode`. Keep the guard in `src/js/services/actions.js:205` for rotation.
- [x] In `src/js/services/actions.js:100` and `src/js/services/actions.js:108`, remove the `manhwaEnabled` early return for filter off and filter toggles.
- [x] In `src/js/services/actions.js:115` and `src/js/services/actions.js:125`, cycle through `none`, `bilinear`, and `lanczos` in manhwa. Remove the two entry manhwa list.
- [x] In `src/js/menubar.js:719`, stop disabling `cmd-scale-lanczos`, `cmd-filter-off`, and each entry in `FILTERS` when manhwa is on. Keep rotation disabled in `src/js/menubar.js:727`.
- [x] In `src/js/viewer/manhwaStrip.js:1974` and `src/js/viewer/manhwaStrip.js:2142`, keep syncing `_strip.dataset.scaling` so CSS keeps working during this slice.
- [x] Accept when lanczos and each filter can be selected in manhwa, the choice persists across restart through `frontend_data`, manhwa still paints raw slots, and legacy bridging behaves as before.

Validation note. Keeps one owner per concern. Actions own dispatch, Core owns state, strip owns slots. No render path changes in this slice, so probe and replay contracts stay intact.

## Slice 2. Column composite math as a pure module

Goal is tested geometry for a window composite whose filter space stays continuous down the column.

- [x] In `src/js/services/viewerMath.js`, add a helper that maps visible strip offsets to a viewport sized composite. Inputs are layout offsets from `computeColumnOffsets` in `src/js/services/viewerMath.js:38`, viewport size, scale, ty, and overscan. Output is a draw list of imgIdx, source rect, and dest rect plus a column Y origin for shader UVs.
- [x] In the same file, add a helper that maps a composite pixel back to column Y so scanline, phosphor, and CRT uniforms use column continuous coordinates instead of restarting per slot. Seam overlap from `seamOverlapForScale` in `src/js/services/viewerMath.js:81` must be included so pins do not drift below 100 percent zoom.
- [x] Cover still, tall, and zoomed out layouts. Cover a window that spans a slot boundary. Cover scale below 1 where seam overlap grows.
- [x] Accept when `npm run mocha` passes with new cases for window spanning, seam aware offsets, and column Y continuity, and no DOM import appears in the new code.

Validation note. Pure modules first. Math lives in `viewerMath.js` with zero DOM imports. UI files consume it and never reverse the direction.

## Slice 3. Column WebGL pipeline for still images

**Status:** `[x]` Done. Column compositor plus second WebGL runtime behind `#manhwa-filter-canvas`. Stills only. Video rows skipped for slice 4. `node --check` clean, `npm run mocha` 267 passing, `git diff --check` clean. Runtime verification pending user signoff.

Goal is one filtered column canvas for the common still image case. Video and animated slots follow in slice 4.

- [x] In `src/index.html:313`, add a `manhwa-filter-canvas` placeholder beside `#manhwa-strip`. Declare it in markup first instead of creating it at runtime.
- [x] In `src/css/main.css:1562`, add visibility rules. Show the column canvas only when manhwa is active and a WebGL path is in use. Hide slot `img` paint under the canvas through a class or data attribute on the strip. Hide `#viewer-filter-canvas` and `#viewer-lanczos-canvas` under `.manhwa-active` as today in `src/css/main.css:1713`. Slots hide with `visibility`, never `display`, so scroll layout stays valid.
- [x] In `src/js/viewer/viewerPipelines.js`, create a column pipeline owner next to the single image pipeline. Use a second `createGlRuntime` instance bound to the new canvas. Never share one runtime between the two canvases. Reuse `getFilterModule` from `src/js/services/filterModules.js:7` and `lanczosWebGL.js:3` for the lanczos case. No pica in manhwa.
- [x] In `src/js/viewer/manhwaStrip.js`, expose a read only accessor for mounted still nodes and their layout rects for the current window. Keep slot creation, pooling, and eviction in this file. The pipeline file must not query or mutate slots directly. Wired through `setColumnSource` injection in `viewer.js` so the pipeline never imports the strip.
- [x] In `src/js/viewer/viewerPipelines.js`, drive the column render from viewport updates and strip window changes. Composite the draw list from slice 2 to an off DOM staging canvas, then call `render` with `skipUpload` semantics for live staging rather than `getCleanImage` per slot. Size the output canvas to the viewport like `glRuntime.js:216`. Deviation: staging reads through `getCleanImageCrop` per visible draw instead of drawing slot nodes directly. Direct draws taint because `quivit://` sources are cross origin (see `shared/blobImage.js:1`). Crops are bounded by a named 12 entry bitmap cache.
- [x] In `src/js/viewer/viewerPipelines.js`, define the off path. Filter off plus bilinear or none tears down the column WebGL canvas, clears `data-filter` state, and returns to raw slot paint. Lanczos with no filter uses the lanczos WebGL module. Any active filter uses its module. Leaving manhwa with a column frame up forces one legacy repaint since markers hold pre-manhwa values.
- [x] Accept when a still image chapter in manhwa shows continuous scanlines and phosphor mask across slot seams, lanczos sharpens the column without per slot edge halos, pan and zoom keep the filter aligned, and turning the filter off returns to raw slot paint with no stranded canvas. Needs eyes in the running app. See runtime list in the slice 3 report.

Validation note. Keeps canvas ownership in `viewerPipelines.js` and slot ownership in `manhwaStrip.js`. CSS stays the visual source of truth. JS writes only custom properties, transform, class, and data attributes.

## Slice 4. Moving slots under the column filter

Goal is video, animated raster, and SVG slots that keep moving while the column filter is on.

- [ ] In `src/js/viewer/manhwaStrip.js`, extend the window change path so the column pipeline tracks live slots (`video`). Video slots are added to `_liveSlots` on mount in `_claimSlot` and remapped across list growth in `admitPendingEntry`. Static SVGs and rasters are cached in `_columnTextureCache` using direct element uploads. Raster animations under the column filter remain deferred until a WebCodecs decoder path lands.
- [x] In `src/js/viewer/viewerPipelines.js:998`, `_renderColumn` partitions draws into cached (still raster/SVG via texture cache) and live (video via reusable `_columnLiveTexture`). Extracted `_drawSlotQuad` helper shared by both paths with scratch buffers.
- [x] In `src/js/viewer/viewerPipelines.js:958`, `_syncColumnLiveLoop` gates a continuous rAF loop. Runs only when `_columnHasLive` is true (set by `_renderColumn` each frame from `snap.liveSlots`). Stops itself when no live draws remain or when manhwa/filter is off. Teardown cancels the loop and deletes the live texture.
- [ ] Accept when a video gallery plays under each filter in manhwa with audio pill intact, an SVG gallery paints within its cap, and CPU and memory stay flat while scrolling a mixed chapter.

Validation note. Heavy per frame work stays in the pipeline owner. Strip stays a DOM and layout owner. No archive, protocol, or config internals move files.

## Slice 5. Filter aware l to m and m to l bridging

Goal is no blackout and no position jump when toggling with lanczos or any filter active.

- [ ] In `src/js/viewer/viewerRender.js:588`, keep parking the active legacy node on l to m. Carry its current filter state so the bridge paints what the user saw. Do not clear the bridge until the column pipeline signals its first ready frame, reusing the `setOnSlotMounted` double rAF pattern in `src/js/viewer/viewer.js:40`.
- [ ] In `src/js/viewer/viewerPipelines.js:681`, replace the blind early return with an ordered handoff. On l to m, tear down the single image pipeline after the park, then start the column pipeline. On m to l, stop the column loop and teardown its canvas before legacy resumes.
- [ ] In `src/js/viewer/manhwaStrip.js:2047`, keep the anchor handoff in `_deactivate` through `_onBridgeHandoff` in `manhwaStrip.js:2093`. Include the anchor natural size and target fit so `_parkHandoff` in `src/js/viewer/viewerRender.js:198` can reset geometry and apply fit before legacy reapplies its filter.
- [ ] In `src/js/viewer/viewerRender.js:198`, ensure `_parkHandoff` resets geometry before `applyFitMode`, then lets the single image pipeline reapply the stored filter and scaling on the parked node. Clear column `data-filter` state on m to l so legacy becomes the sole filter writer again.
- [ ] Accept when rapid toggle on and off under lanczos, Anime4K, CRT, Phosphor, and Scanlines shows no blank frame, ends on the same anchor image and fit, and neither canvas keeps `data-render-ready` after the other view takes over.

Validation note. Bridge ownership stays in `viewerRender.js`. Strip never touches the bridge layer directly and talks through `viewer.js` callbacks. State callbacks carry the handoff instead of cross file reach in.

## Slice 6. Contracts, probes, and replay

Goal is updated tests and probes that lock the new behavior.

- [ ] In `mocha/actions.test.js:66`, update manhwa routing cases. Lanczos and filters now apply in manhwa. Rotation stays blocked.
- [ ] In `mocha/diagnosticsContract.test.js:44`, extend the contract for the new canvas id and strip data attributes.
- [ ] In `e2e/pageobjects/viewer.page.js` and `e2e/specs/03-viewer.e2e.js:139`, cover filter on in manhwa, toggle on and off, and scroll continuity.
- [ ] In `e2e/replay-diagnostics/probes/viewerPipelineProbe.js:15`, teach the probe the column canvas and its ready signal without breaking legacy assertions.
- [ ] Accept when `node --check` passes on each touched file, `npm run mocha` passes, one manhwa e2e spec passes, and `npm run diagnose` on a manhwa scenario with a filter on reports no blackout frames.

## Verification

Run per slice before handoff. Stop and report failures instead of proceeding.

- `node --check` on each modified JS file.
- `npm run mocha` for pure frontend unit tests and contract integrity.
- One manhwa e2e spec through `npm run e2e -- --spec <file>`, with `--agent` in a non elevated shell when process cleanup is needed.
- `npm run diagnose` for a manhwa scenario with lanczos and with each filter on.
- `git diff --check` for whitespace hygiene.

Manual runtime handoff for the user.

1. Open a still image chapter in manhwa at fit width, turn on each filter in turn, and confirm the pattern looks continuous across page joins.
2. Scroll top to bottom with Lanczos on and confirm sharpness holds and no tearing appears at seams.
3. Open a video gallery in manhwa with a filter on and confirm motion plays and mute control still works.
4. Toggle manhwa on and off rapidly with a filter on and confirm the same page returns with no blank flash.
