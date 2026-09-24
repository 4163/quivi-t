# Video bridging plan

Validation comparison performed: this plan was checked against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md` before presenting. It proposes no architecture drift. Details are in the compliance section at the end.

## Goal

Remove the blank checkerboard flash when navigating between video and image items. Three transitions must hold the outgoing frame until the incoming media is ready to paint: video to video, video to image, image to video.

Planning only. No code changes are included here.

## Factual pipeline

This is how the viewer works today, from navigation to pixels. All references are to the current working tree on `feature/provider-video`.

### Navigation produces a src

`core.js:168` `_selectEntry` resolves the new item, builds a src with `FsUtils.buildFileSrc` for disk files or `buildArchiveEntrySrc` for archive entries, writes `_state.src`, and notifies subscribers. Video files take the same path as images because `mp4` is in `SUPPORTED_IMAGES`. The state shape is unchanged by media type. No new state fields exist for readiness, and the plan keeps it that way.

### Image rendering bridges the old frame

`viewerRender.js:395` subscribes to state. For images the renderer keeps a pool of 4 `img` nodes in `#viewer-img-wrapper`, plus the retiring node mechanism:

- The outgoing image stays visible while the incoming one loads. When a bridge is available, the target load is deferred 45 ms by `TARGET_LOAD_DEBOUNCE_MS` at `viewerRender.js:560`.
- `_activatePoolNode` at `viewerRender.js:283` parks the outgoing image in `#viewer-bridge-layer` with its transform frozen in `--bridge-*` props, shows the decoded incoming image with `.active`, and releases the bridge after two animation frames.
- Neighbor preloads come from `FsUtils.neighborEntries` at `viewerRender.js:458`. That helper returns null for video entries at `fsUtils.js:317`, so videos never preload today.
- The pipeline callback in `viewer.js:21` sets the WebGL or Lanczos source on image activation and clears it when given null. The video branch calls it with null, so filters stay off for video.

### Video rendering cuts immediately

The video branch at `viewerRender.js:414` runs before the image path:

- `_hideImages` at `viewerRender.js:102` cancels the retiring node and strips `.active` from the image at once. The outgoing image vanishes before the video has any frame.
- `_hideVideo` at `viewerRender.js:92` pauses the video, strips `.active`, removes `src`, and calls `load()`. The outgoing video vanishes before the incoming image decodes.
- Video to video reuses one shared `#viewer-video` element declared at `index.html:254`. Setting a new `src` unloads the old stream at once, so the old motion disappears while the new stream buffers.
- Readiness is one sided. The branch calls `play()` right after setting `src` at `viewerRender.js:446` with no wait for `canplay` or first frame. Dims and fit apply only if `videoWidth` is already known, which is rarely true on first navigation. The `loadedmetadata` listener at `viewerRender.js:67` applies fit late, after the blank period.
- Audio runs on its own track. `viewerAudio.js:101` resets the `#viewer-audio` element per navigation and re-probes `hasSound` unless cached on the item. Visual and audio resets are independent.

### Markup and style facts

- `#viewer-img-wrapper` at `index.html:248` holds the image pool, `#viewer-video`, grill, and Lanczos canvas. The wrapper carries the pan and zoom transform, so anything parked inside it inherits geometry.
- `#viewer-bridge-layer` at `index.html:261` is the unscaled sibling where retiring images keep their pre-navigation transform.
- `.viewer-video.active` at `main.css:1554` mirrors the image display rule. No `.bridge` role exists for video, and the filter opacity rules at `main.css:1636` mention only `.viewer-img`.
- The telemetry probe at `e2e/replay-diagnostics/probes/viewerPipelineProbe.js:14` queries `.viewer-img.active` and `.viewer-img.bridge` only. Video states are invisible to it. The contract test at `mocha/diagnosticsContract.test.js:52` pins `#viewer-img-wrapper`, `#statusbar`, the `viewer-img` class, and the `active` and `bridge` roles.

## Gaps per transition

Video to video. One shared element means the old stream unloads the moment the new `src` is set. There is no second element to hold the old frame, no preload of the neighbor, and no gate on `canplay`. The viewer shows checkerboard until the new stream yields a frame.

Video to image. `_hideVideo` blanks the video synchronously at line 453 before the image branch even starts loading. The image then needs its normal decode path. The user sees checkerboard for the full image load.

Image to video. `_hideImages` blanks the image synchronously at line 417, then the video needs network fetch plus metadata plus first frame. The user sees checkerboard for the full video startup.

## Proposed slices

Each slice is independently reviewable and shippable. Do them in order.

### Slice 1: second video element with canplay gated swap

Goal: video to video holds the old motion until the new stream can paint.

Touched files:

- `src/index.html`. Declare a second static placeholder, `viewer-video-b`, next to `viewer-video` inside `#viewer-img-wrapper`. Two is the full set because only current and incoming streams ever coexist. This follows the HTML-first rule. No runtime node creation.
- `src/css/main.css`. Add `.viewer-video.bridge` mirroring `.viewer-img.bridge`, plus bridge-layer rules for parked video. Keep the change to class toggles. No inline visual values from JS.
- `src/js/viewer/viewerRender.js`. Own the two-element pool in the renderer, the same module that owns the image pool. Ping-pong between them. Load the incoming `src` into the hidden element with `preload="auto"`, wait for its `canplay` or first `loadeddata` event, then add `.active` to it and park the outgoing element in `#viewer-bridge-layer` paused with the frozen `--bridge-*` transform. Release the bridge after two animation frames, reusing the existing `_retireRaf` pattern. On timeout or error, fall back to the current immediate swap so a stalled stream can never hang navigation.

Acceptance: navigate video to video and the old motion stays until the new motion paints. No new Core state fields. Probe queries still resolve.

### Slice 2: cross-media hold

Goal: image to video keeps the image until the video can paint, and video to image keeps the video until the image decodes.

Touched files:

- `src/js/viewer/viewerRender.js` only.

Image to video: stop calling `_hideImages` up front. Leave the active image in place, load the hidden video element, and only park the image into the bridge once the video fires its ready event. Reuse the bridge release timing from slice 1.

Video to image: stop calling `_hideVideo` up front. Leave the active video playing muted while the image branch runs its normal load and decode path. Only pause and unload the video inside `_activatePoolNode` after the incoming image is active. If the image errors, keep the video visible and surface the statusbar error, matching the existing image error path.

Acceptance: both cross transitions show the outgoing frame continuously until the incoming frame paints. Rapid back and forth navigation never strands a hidden active element, because each navigation cancels the pending ready wait via the existing activation generation guard.

### Slice 3: neighbor video preload

Goal: cut the wait itself, not just cover it.

Touched files:

- `src/js/fsUtils.js`. Add a narrow helper that returns real file URLs for adjacent video entries only. Keep it out of `neighborEntries`, which feeds the `Image` preloader, since `Image` cannot preload video.
- `src/js/viewer/viewerRender.js`. Hold at most one offscreen preloader using the idle video element with `preload="auto"`, bounded to the existing `PRELOAD_HALF` of 1 each way. Evict on generation change, mirroring `_clearScheduledPreloads`.

This slice is optional if slices 1 and 2 already feel instant on local files. It matters most for large files and archive streams. Skip it under YAGNI if manual testing shows no perceptible wait.

Acceptance: stepping to an adjacent video starts painting from buffered data. Memory stays bounded to one spare stream.

### Slice 4 (optional): video-aware telemetry

Goal: let replay diagnostics see video states.

Touched files:

- `e2e/replay-diagnostics/probes/viewerPipelineProbe.js`. Also query `.viewer-video.active` and the video bridge role.
- `mocha/diagnosticsContract.test.js`. Extend the DOM contract assertions to the new selectors.

This slice exists because the probe is blind to video today. It is test machinery, so keep it separate from behavior slices and run the full `npm test` plus `npm run diagnose -- sample-navigation` for it.

## Non-goals

- Audio crossfade or gapless sound across video to video. `viewerAudio.js` stays untouched. The audio element resets per navigation by design, and bridging muted video visuals does not change that.
- Filters or Lanczos on video frames. Pipelines keep clearing for video through the existing null callback.
- Spread view for video. Dims flow through the existing `Core.setImageDimensions` call so status math keeps working, nothing more.
- New Core state. Readiness stays view-local in the renderer, which AGENTS.md permits without state machine involvement.

## Blast radius

- IPC, config schema, protocol URLs, and archive readers: untouched. The `video/mp4` archive mime already shipped on this branch.
- Action registry and scenarios: untouched. No action ids change.
- State machine shape: untouched. No new fields, no callback contract change.
- Viewer DOM: additive. Existing `.viewer-img.active` and `.viewer-img.bridge` selectors keep resolving, so the probe and the diagnostics contract keep passing. The one risk is CSS specificity if bridge rules for video interact with the filter opacity rules, so keep video selectors independent of the image filter rules.
- CSS tokens: untouched. Reuse existing custom props only.
- Performance: one spare video element plus at most one preload stream. Both pause when parked, so decode cost stays near current levels.

## Verification per slice

- `node --check` on each touched JS file.
- `npm test` on every slice. The diagnostics contract is the gate for DOM changes.
- `cargo check --tests --manifest-path src-tauri/Cargo.toml` only if a slice touches Rust. None of these slices do.
- Manual runtime checklist for the closing slice: step video to video, video to image, image to video, each in both directions, and confirm the outgoing frame stays until the incoming motion or image paints. Rapidly reverse direction mid-load and confirm no stuck blank and no stranded playing element. Resize and zoom during video hold and confirm the transform still applies.
- `npm run diagnose` only if slice 4 lands or flicker persists after slices 1 and 2, per the standing agreement.

## Compliance of this plan

Compared against validate-changes rules:

- Flat control flow, small slices, reuse of the existing bridge and generation guard patterns instead of new abstractions. No new helpers where one exists.
- HTML-first: static second placeholder, class toggles, node recycling. No `createElement` or `innerHTML` for stable chrome.
- CSS source of truth: all visual state through classes. JS writes only classes, `data-*` readiness, custom props, and the existing wrapper transform.
- Module ownership: renderer keeps owning pooled media. No DOM in `core.js` or `services`. No reach-in between `viewerAudio.js` and the renderer. No growth in `main.js` bootstrap.
- Telemetry integrity: probe selectors keep working. Contract test stays green. Probe extension is isolated in its own optional slice.
- No stale code introduced. The single-element immediate swap path becomes the timeout fallback, then is removed once the gated swap proves stable, in a follow-up cleanup rather than this plan.
