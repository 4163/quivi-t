# Animated filter/Lanczos jank

Report for the next `feature/filters` slice. Two user-facing bugs, both only when a WebGL filter or WebGL Lanczos is on and the current file is (or just was) animated.

I did not reproduce them in the running app. Every claim below is from reading the current tree and checking it against the reported symptoms. I marked a cause **validated** only when the code must behave that way. Intuition about backgrounding and "performance" is treated as a hint, not evidence.

Related reading: [`animated-filters.md`](animated-filters.md), [`animated-filters-plan.md`](animated-filters-plan.md). Slices 1–5 of that plan are already on the branch. This is leftover correctness in the pump, not a new feature.

---

## What the user reported

**Playback hitch.** With Lanczos or a filter on an animated file, frames skip or the overlay flickers. Rare. Trigger unknown. Guess was "app in the background" or "the machine is busy." No proof.

**Ghost on switch.** Switching the active image leaves one stale overlay frame. A pan or zoom clears it. Rare in general. Happens consistently when going from a looping GIF to a single-frame GIF. That trigger is confirmed, not claimed to be the only one.

They look related because they share the live pump and the filter canvas. They are not the same bug.

---

## How this path works today

Still images do not use the pump. `glRuntime.render()` fetches a same-origin `ImageBitmap` via `getCleanImage` and uploads once per `src|width|height`. Pan skips the upload.

Animated files with a filter, or with Lanczos, take a different path in `viewerPipelines.js`:

1. `useLivePump = isAnimated && (activeFilter !== null || scaling === 'lanczos')`.
2. Raster GIF/APNG/WebP: fetch the `src`, construct `ImageDecoder`, walk `frameIndex` on `requestAnimationFrame`, blit each `VideoFrame` into an off-DOM staging canvas, `updateSource` + `render(..., skipUpload=true)`.
3. SVG: a nearly invisible `<img>` in `#viewport`, same blit loop.
4. `#viewport[data-filter]` sets `.viewer-img { opacity: 0 !important }`. The pixels you see are `#viewer-filter-canvas`, which lives *outside* `#viewer-img-wrapper`. The pool `<img>` keeps playing underneath so Chromium does not pause it.

The original plan said "no decoders, blit the browser's `<img>`." Slice 3 shipped `ImageDecoder` instead. That is why we own the clock, and why a stalled `rAF` skips frames the native image would have kept.

`getLiveImage` in `blobImage.js` is unused. The pump never calls it.

---

## Bug 1: ghost frame on image switch

**Validated.** Matches the confirmed trigger. Pan/zoom clearing it also matches. Other switches can hit the same race. They will look random.

### What you actually see

`data-filter` stays on across a source change. The real image is invisible. The filter canvas is not cleared. Until a draw for the *new* source sticks, the compositor keeps showing the last WebGL present. That present is the previous GIF.

Pan/zoom runs `_applyTransform`. For a destination that is *not* animated, that path uploads the current still via `getCleanImage` and replaces the leftover pixels. The ghost goes away. That recovery is accidental. It is not a designed present fence.

### Cause 1: `isAnimated` is lied about on every select

**Validated.** [`core.js`](../src/js/core.js) `_selectEntry`:

```javascript
_state.isAnimated = false;
_state.noLoop = false;
_notify();
```

Then either the memo or `checkIsAnimated` writes the real flags and notifies again.

`viewerPipelines` only rebuilds the pump when `isAnimated`, filter, scaling, or Anime4K variant change. It does **not** watch `state.src`. So this false flash is the thing that stops the pump, *before* `setSource` has the new `<img>`.

Looping GIF → single-frame GIF with no `NETSCAPE2.0` block:

1. Destination is honestly not animated (`formats.rs`: `is_animated = frame_count > 1 || loop_count.is_some()`).
2. First notify already set `isAnimated = false`, so the pump stops immediately.
3. `_applyTransform` is allowed to run because `_lastIsAnimated` is now false.
4. `_activeSource` is still the **old** looping GIF. `setSource` has not run. The 45ms image-swap buffer in `viewerRender.js` has not fired.
5. `pipeline.render(oldGif)` starts an async `getCleanImage(oldGif.src)`.

That still render of the previous file is the leftover frame waiting to land on the canvas.

### Cause 2: two `render()` calls, last draw wins, no generation check inside GL

**Validated.** `glRuntime.render` awaits `getCleanImage`, then uploads and draws. The only generation check is in `viewerPipelines._applyTransform`'s `.then()`, *after* the draw. A cancelled render still paints.

`getCleanImage` makes it worse. A new `src` calls `evictBlobCache()` and starts a second fetch, but the first async function keeps going and writes `_cachedCleanImg` / `_cachedSrc` when it finishes. Whichever `render()` completes last owns the canvas.

Looping GIF → small static GIF is the ugly case:

- The looping GIF was only ever on the pump, so `getCleanImage` has no cache for it. `createImageBitmap` of a multi-frame GIF is slow.
- The static GIF is small. Its `getCleanImage` is fast.
- `setSource(new)` starts render B. Render A (old GIF), started ~16ms after the false `isAnimated` notify, often finishes *after* B.

Result: the new still draws, then the old GIF draws on top and stays there. Pan starts render C of the current source. Cache hit. Ghost gone.

That is why the confirmed trigger is consistent, and why "rarely, on other switches" is also true. You need the slow leftover render to finish last. Animated → smaller still, with a filter on, is the wide window. Animated → animated usually starts a new pump that overwrites the leftover in a few frames, so you might not notice.

### Cause 3: source change never drops the overlay

**Validated.** Slice 6 already made still-path `data-filter` atomic with `data-render-ready`. The pump sets both on the first tick and never clears them on `setSource`. CSS therefore keeps hiding the pool image and showing the stale canvas for the whole 45ms bridge plus any in-flight GL work.

The right overlay handoff is the one stills already use: hide the canvas (and show the bridged `<img>`) until the first present of the *new* source, then set both attributes together.

### Cause 4: `frameCount < 2` leaves the canvas stuck

**Validated as a second dead end. Does not match the pan-clears-it symptom.**

If the destination is flagged animated (single-frame GIF *with* a NETSCAPE block, the documented false positive) the pump starts, then:

```javascript
if (frameCount < 2) { decoder.close(); return; }
```

No draw. No still fallback. `_applyTransform` bails on `_lastIsAnimated`. Pan also bails. This ghost would **not** clear on pan/zoom.

The user's confirmed files are the other kind (no NETSCAPE, `isAnimated` false, pan works). Keep this branch in the fix anyway. It is a trap for the false-positive GIFs `formats.rs` still classifies as animated.

### Not the ghost cause

In-flight `pumpTick` after `_stopLivePump` is mostly safe. The post-`await decode` check is `_livePumpSrc !== currentSrc`, and the upload after that check is synchronous. I could not construct a single-threaded interleave that paints a stopped pump over a later still present. The still-path race above does not need the pump to be the last writer.

---

## Bug 2: frame skip and flicker during playback

Several **validated** mechanisms. None of them need the app to be in the background, but backgrounding would trip them. I cannot mark "background is *the* trigger" as proven. The code would misbehave there. That is all we know.

### Cause 5: the pump clock only advances one frame per tick

**Validated.** [`viewerPipelines.js`](../src/js/viewer/viewerPipelines.js) `pumpTick`:

```javascript
if (elapsed >= frameDurationMs) {
  if (frameIndex < frameCount - 1) {
    frameIndex++;
    lastFrameTime = now;
  } else if (!live.noLoop) {
    frameIndex = 0;
    lastFrameTime = now;
  }
}
```

If one tick takes 50ms and the GIF frame is 10ms, we should advance several frames. We advance one and throw away the rest (`lastFrameTime = now`, not `+= duration`).

The tick is `await decoder.decode` plus a staging blit plus `texImage2D` plus the full filter pass, then `requestAnimationFrame` for the next tick. It is not a 60Hz sampler of a running clock. It is a serial loop whose period is `max(rAF, decode+GL)`. Anime4K on a large APNG will skip. A 10ms GIF will skip even when the machine is fine, because we cap at one frame per completed tick.

Native `<img>` playback does not work this way. Chromium keeps disposal time while we are busy. We replaced that with a clock we stall.

### Cause 6: no visibility or context-lost handling

**Validated that the handlers do not exist.** Not validated as the field trigger.

There is no `visibilitychange` listener, no `document.hidden` check, no `webglcontextlost` / `webglcontextrestored` handler anywhere in `src/js`. Chromium throttles or pauses `rAF` for a background window. On resume, `elapsed` is huge, cause 5 advances one frame, and the overlay jumps. `preserveDrawingBuffer: false` plus a lost context can also present a blank or stale swap until the next successful `render()`.

This is the "app in the background" guess, written down as code. It is a real defect. It is not proof of what the user hit.

### Cause 7: Lanczos-only navigation tears the pipeline down

**Validated.** Filters keep `usesWebgl` true when `isAnimated` flickers false, so the GL pipeline stays. Lanczos-on-animated does not:

`useWebGlForLanczos = scaling === 'lanczos' && isAnimated && !isSvg && activeFilter === null`

The optimistic `isAnimated = false` makes that false. `_applyScaling` then treats it as still Lanczos (pica), calls `_teardownWebglCanvas()`, removes `data-filter`, and the unfiltered `<img>` becomes visible. When the memo or IPC sets `isAnimated` back to true, WebGL Lanczos is built again and the image is hidden.

That is a one-frame (or several-frame) flash of the raw image. It happens on every next/prev while Lanczos is the scaler and no filter is on, including memo hits, because `_selectEntry` always notifies false first.

If the rare "flicker" was seen with Lanczos and not with CRT, this is the reason. If it was seen mid-playback with no navigation, this is not it.

### Cause 8: staging canvas is in the software path

**Validated as a cost, not as a unique trigger.**

```javascript
stagingCtx = _liveStagingCanvas.getContext('2d', { willReadFrequently: true });
```

The canvas is only used as a WebGL `texImage2D` source. `willReadFrequently: true` asks for a CPU bitmap. That is the slow upload path, every frame. It makes cause 5 more likely. It does not skip frames by itself.

Resizing `_liveStagingCanvas` or the visible filter canvas (`canvas.width = vpW` inside `render`) clears that canvas. Filter-canvas resize is a real one-frame blank if the viewport size changed. Staging is off-DOM, so its clear is invisible.

### Cause 9: `ImageDecoder` type comes from the HTTP header

**Validated as a failure path. Not tied to a user report.**

```javascript
const contentType = resp.headers.get('content-type') || 'image/gif';
```

`quivit://` sets MIME from the extension, so archive entries are fine. A missing or wrong header becomes `image/gif`. A failed constructor hits `console.warn` and returns. Same stuck-canvas outcome as cause 4. Folder files go through `asset://`; I did not verify that header. Derive the type from the path, not the header.

### What I am not marking

"Performance issues" as a root cause. Heavy Anime4K plus a software staging canvas plus a full tex upload every tick (even when `frameIndex` did not change) will stall the loop. That is cause 5 showing up. It is not a separate bug.

Overlapping `pumpTick` calls. The next `rAF` is scheduled after the `await`, so ticks do not overlap. They just run late.

---

## AGENTS.md notes for the fix

- Overlay canvases and the pump stay in `viewerPipelines.js`. Do not add a sibling module. The original plan already forbade that.
- `glRuntime.js` owns the GL context and the source texture. A generation token belongs in the `render` / `updateSource` path so a cancelled still upload cannot present. Do not have `viewerPipelines` reach into `_gl`.
- `core.js` owns `isAnimated` / `noLoop`. The false notify is a state-machine bug. Fix it there. UI should not paper over a lie.
- `data-filter` and `data-render-ready` stay `data-*` writes. Do not hide the overlay with inline `opacity`.
- Do not change the still `getCleanImage` / `createImageBitmap` path to "support" animation. If the pump is off, stills stay stills.
- `#viewport[data-filter] .viewer-img { opacity: 0 }` must not become `display: none`. That pauses GIF playback.
- `check_is_animated` JSON shape stays `{ is_animated, no_loop }`.
- The SVG pump's `liveImg.style.cssText = '...'` is already an inline-style violation. Do not copy that pattern. Leave it unless the slice already touches that function, in which case move the rules into `main.css`.

---

## Hardening plan

Two slices. Ghost first. It is the confirmed, user-reproducible one, and the present fence also removes the Lanczos teardown flash. Clock second. Do not mix them.

### Slice 1: present fence and honest `isAnimated`

**Files:** `core.js`, `viewerPipelines.js`, `glRuntime.js`, `blobImage.js` (only if the in-flight `getCleanImage` clobber is still reachable after the generation token).

1. **`core.js`.** Stop notifying `isAnimated = false` as a placeholder. If `_animMemo` has the key, write the cached flags *before* the first `_notify` for that select. If it does not, leave the previous flags alone until `checkIsAnimated` returns, and ignore the result if `index` (and `src`) no longer match. Never publish a known-wrong false.

2. **`viewerPipelines.setSource`.** Bump a pump/present generation. Stop the pump. Drop `data-render-ready` on the filter canvas and drop `data-filter` on `#viewport` so the two-image bridge is visible until the new overlay has a frame. Do not still-render the previous `_activeSource`.

3. **`glRuntime.render`.** Take the generation (or compare a token the caller already bumped). After `await getCleanImage`, if the token is stale, return without `texImage2D` and without `drawArrays`. `updateSource` should refuse uploads from a stopped pump. `_texSrc = 'live_pump'` must not survive into a still present of a new file; reset it on source change.

4. **Pump start.** If `ImageDecoder` is missing, throws, or `frameCount < 2`, do not return leaving the last present. Fall through to the still path (`_lastIsAnimated` effective false for overlay purposes, `_applyTransform` allowed once). Close the decoder.

5. **Manual check.** Looping GIF → static GIF with CRT on, no pan. The static file must replace the overlay, or the bridged `<img>` must show, never the previous GIF. Then pan to confirm nothing was only "stuck until input." Repeat GIF → GIF, GIF → JPEG, Lanczos-only next/prev.

Commit on `feature/filters`. New session for slice 2.

### Slice 2: pump clock

**Files:** `viewerPipelines.js`, maybe `glRuntime.js` if context restore needs `updateSource` again.

1. Catch up: while `elapsed >= frameDurationMs`, advance `frameIndex` (wrap unless `noLoop`), subtract duration. Clamp so a long pause does not decode hundreds of frames on one tick; skip to the frame that matches remaining time.
2. On `document.visibilityState === 'visible'`, reset `lastFrameTime` to `now` so a background gap does not dump a huge `elapsed` into one advance. Do not try to "replay" the hidden period.
3. Listen for `webglcontextlost` / `webglcontextrestored` on the filter canvas. On restore, `setFilter` again and force an upload.
4. Drop `{ willReadFrequently: true }`.
5. Pass `ImageDecoder` type from the file extension, not `Content-Type`.
6. Decode+upload when `frameIndex` changed, or when geometry changed. CRT/Phosphor/Scanlines/Anime4K have no time uniform, so repeating the same frame at 60fps is wasted work. If a later filter needs a clock, add it then.

**Manual check.** Fast GIF (10ms) with CRT, hold on the image. Playback should not look like every other frame. Alt-tab away for a few seconds and back: one hitch at most, then steady. Anime4K on a large APNG should degrade to a lower frame rate without tearing the overlay. Lanczos-only GIF should not flash the raw image on next/prev (that is slice 1, re-check it).

---

## Suggested runtime tests (slice 1)

Use `test-files/` plus any looping GIF you already know. Filter on (CRT is enough). Also once with Lanczos and no filter.

1. Open a looping GIF. Next onto a single-frame GIF that has no NETSCAPE block. Do not touch the mouse. The overlay must show the static GIF, or the unfiltered static GIF as a bridge. It must not keep the looping GIF's last (or first) frame.
2. Same switch, then pan. Nothing should "pop" into the correct image. If it does, the fence failed and pan is still the cleaner.
3. Looping GIF → looping GIF. No stuck frame. Playback of the second file starts at frame 0.
4. Looping GIF → JPEG/PNG. Same as (1).
5. Static GIF → looping GIF. Pump starts. No blank canvas.
6. With Lanczos only, next/prev across two GIFs. No flash of the unfiltered image.
7. `no_loop.gif` with a filter: plays once and holds the last frame. Re-entering the file restarts.

---

## Out of scope

- Rewriting the pump back to `getLiveImage` / native `<img>` blit. That was the original plan. Slice 2 can be done on `ImageDecoder`. A decoder removal is a different discussion.
- Changing GIF NETSCAPE false-positive policy in `formats.rs`. Slice 1 already has to survive `frameCount < 2`.
- Deleting unused `getLiveImage` unless `blobImage.js` is already open.
- The SVG `style.cssText` pump, except if slice 1 touches that function.
