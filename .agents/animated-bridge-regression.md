# Animated image bridge regression

Report for the next `feature/filters` slice. The two-image bridge is supposed to hold the last decoded page on screen until the next one has actually decoded. No blank frame. That contract is in the README and in `viewerRender.js`. It regressed for animated files in `f21b543` ("Fixed animated pipeline jank and ghost frames").

I did not run the app. Every **validated** mark is from the current tree. Stills are the control: the same pool, the same 45ms debounce, no cache-bust query string.

Related: [`animated-pipeline-jank.md`](animated-pipeline-jank.md), [`implemented.md`](implemented.md) Slice 1/2 of the jank fix.

---

## What bridging is

`POOL_SIZE = 2`. One node is `.active` (`display: block`). The other is `display: none`. There are never two visible images. The bridge is: keep the old node `.active` with its `src` intact until the new node has decoded, then swap in one turn.

`hasPreviousBridge` is that test. If it is true, load of the new `src` waits 45ms so held-key scrubbing does not thrash. If it is false, the new node is made `.active` immediately, even when it still has no `src`. That path is a blank frame. It exists for first open and for clear. It must not run between two images.

`onActiveImageChanged(null)` is `pipelines.clear()`. Overlay gone, pump gone, `data-filter` gone. That is also a blank if it happens in the middle of a navigation.

---

## What changed

Before `f21b543`, frame-0 restart lived in `_activatePoolNode` and only for `state.noLoop === true` GIFs. It replaced the *incoming* node after decode, then assigned `src`. The outgoing node was already not that element. The bridge did not care.

`f21b543` removed that and added, on every `activeChanged && state.isAnimated`:

1. `_recyclePoolNode(state.src)` then `_getPoolNode(state.src)`
2. Load with `?_reset=${Date.now()}` (or `&_reset=`)

The commit message says "on re-entry". The condition is not re-entry. It is "the next file is animated." Next/prev from GIF A to GIF B hits it. So does GIF → APNG, WebP, animated SVG.

That is the regression. Frame-0 restart for Chromium's GIF timeline is a same-`src` problem. A different file already starts at frame 0. The old no-loop remount was narrow. This one is wide, and it breaks identity.

---

## Cause 1: pool keys and `img.src` are different strings after `_reset`

**Validated.** This is the blank.

`_activeNodes` is keyed by canonical `state.src` (`convertFileSrc` / `quivit://`, no query). `_loadPoolNode` stores that in `dataset.poolSrc` and puts the cache-bust URL on the element.

Keep-alive for the visible node:

```javascript
const desiredSrcs = new Set([state.src]);
if (_isVisibleImage(img)) desiredSrcs.add(img.src);
```

`img.src` is the browser-resolved URL, including `?_reset=…`. It is never equal to the map key.

Then:

```javascript
for (const src of _activeNodes.keys()) {
  if (!desiredSrcs.has(src)) _recyclePoolNode(src);
}
```

The previous GIF's key is the canonical src. That string is not in `desiredSrcs`. Recycle runs. Recycle does all of this:

- `removeAttribute('src')` (GIF decoder stops, pixels gone)
- `classList.remove('active')` (`display: none`)
- if that node was `img`, `img = null` and `onActiveImageChanged(null)` → `pipelines.clear()`

`hasPreviousBridge` is computed after that loop, from `img`. `img` is null. Bridge is false.

The empty incoming node is made `.active` with no `src`. One paint of a blank viewport. Then `loadTarget` assigns the cache-busted URL and we wait on decode.

Stills do not append `_reset`, so `img.src` often equals the map key and the key stays in `desiredSrcs`. That is why this looks like an animated-only regression.

Once any animated file has been shown with `_reset`, the next navigation off it hits this. Animated → animated, animated → JPEG, animated → a static GIF. First open of a GIF in a session has no previous animated node, so it may look fine until the second file.

---

## Cause 2: recycle of `img` clears the overlay in the same turn

**Validated.** Follow-on from cause 1.

`viewer.js` wires `onActiveImageChanged(null)` to `pipelines.clear()`. That disposes the GL pipeline and drops `data-filter`. Even if you wanted the filter canvas to stand in as a visual bridge, it is gone before the new image decodes.

`setSource` on a real new element now drops `data-filter` until the overlay has a new frame. That is the ghost fix and it is fine *at swap time*, when the new `<img>` is already decoded. It is not a substitute for the DOM bridge during the wait. `clear()` during the wait is the opposite.

---

## Cause 3: leftover `isAnimated` makes a still look animated

**Validated as a second way to take the same path.**

`core.js` no longer notifies `isAnimated = false` as a placeholder. Cache miss leaves the previous flags until IPC returns. Good for the pump. Bad here.

GIF (animated, memoized or not) → JPEG, cache miss on the JPEG:

1. First `_notify` still has `isAnimated === true`.
2. `activeChanged && state.isAnimated` recycles the JPEG's pool node and will load it with `_reset`.
3. Cause 1 may already have recycled the GIF.
4. Later IPC sets `isAnimated` false and notifies again.

So a still destination can take the animated recycle path for one notify. The trailing `_notify()` in `_selectEntry` (the one after `remember_last_image`) always fires a second renderer pass in the same function. That bumps `_activationGeneration` and cancels the first `decode().then`. The `load` listener can still activate if `el === img`. Do not rely on that. The empty `.active` node from pass one already painted.

---

## Cause 4: frame-0 work runs on the wrong event

**Validated.** Chromium keeps a GIF timeline if you set the same `src` again. That is why no-loop GIFs stuck on the last frame on re-entry. The fix belongs on *re-entry of the same canonical src*, or on no-loop activate, which is where it used to live.

A new `state.src` is a new URL. The decoder starts at frame 0. Recycling the incoming node and cache-busting every animated next/prev does not buy a restart. It only changes the element's URL so the keep-alive set can no longer see it.

`implemented.md` calls this "unconditionally replace the DOM node for all animated files on re-entry." The code does not check re-entry. `activeChanged` is `activeEl !== img`, which is true for any different file.

---

## What I am not marking

Filter-on vs filter-off as two bridge implementations. The DOM bridge is the same. With `data-filter` set, you cannot *see* the pool image, so a working DOM bridge is still invisible until `data-filter` drops. After `f21b543`, `setSource` drops it when the new image activates. If the DOM bridge survived, you would see the old image for 45ms+decode only when the overlay was already off, or you would see the old overlay until swap. The blank the user is talking about is the DOM path killing the previous node. Overlay is collateral via `clear()`.

`display: none` on inactive nodes. That is the old contract, not a regression. Do not switch it to opacity stacking as a workaround. Fix identity.

The 45ms timer itself. It still does the right thing when `hasPreviousBridge` is true.

---

## AGENTS.md notes for the fix

- The pool and the bridge have one owner: `viewerRender.js`. Do not teach `viewerPipelines.js` about `_reset` or pool keys.
- `pipelines.clear()` is for empty viewer, not for "we recycled a node." Recycle of the current `img` must not be the way we restart a GIF.
- Canonical `state.src` is the identity. Query strings used to poke Chromium are not keys. `data-*` for pool src is already there. Use it.
- Do not add a third pool node to "make bridging work." Two is the architecture.
- Do not set inline `display` / `opacity` to fake a bridge. `.active` is the visibility token.
- Keep `#viewport[data-filter] .viewer-img { opacity: 0 }`. Do not change it to `display: none`.

---

## Hardening plan

One slice. This is identity and lifecycle, not a new pump.

**Files:** `viewerRender.js`. Maybe `core.js` if the extra `_notify()` is still cancelling the first activation. Leave `viewerPipelines.js` alone unless recycle-of-`img` is still calling `clear()` after the renderer fix.

1. **Keep-alive set uses pool identity.** `desiredSrcs.add(img.dataset.poolSrc || map key)`. Stop adding `img.src`. Recycle only keys that are not the new `state.src` and not the current pool src.

2. **Do not recycle the visible node.** `_recyclePoolNode` on `state.src` is allowed only when that node is not `img`. If the incoming src already has a node, strip and cache-bust *that* node without going through recycle-of-`img`. Never `removeAttribute('src')` on the bridge.

3. **Frame-0 restart is re-entry.** Same canonical src becoming active again, or `noLoop` on activate, which is the old bug. Different `state.src` does not get `_reset`. If Chromium still needs a poke on re-entry, keep `poolSrc` canonical and put `_reset` only on the element `src`.

4. **Empty node is not `.active`.** `hasPreviousBridge` false is first-open and clear only. If `img` is a decoded image, it stays `.active` until `_activatePoolNode` of a decoded successor.

5. **Optional, same slice if you touch `core.js`:** the second `_notify()` at the end of `_selectEntry` should not fire when `src` / index / anim flags did not change. It currently forces a second renderer pass every select.

**Manual check.** No filter, then again with CRT on. Held-key next/prev, and single steps.

1. JPEG → JPEG. Bridge unchanged. Control.
2. JPEG → looping GIF. Old JPEG stays until the GIF's first frame is decoded. No blank.
3. Looping GIF → looping GIF. Same. The first GIF must not vanish the instant you press next.
4. Looping GIF → JPEG. Same.
5. Looping GIF → `single-frame.gif`. Same. This is also the ghost-trigger pair from the other report. Bridge and overlay fence are different layers. Both must hold.
6. Re-enter `no_loop.gif` after visiting another file. Playback starts at frame 0, not the last frame. This is the only case that earned a remount.
7. Held Shift+D through a mixed folder. No flashing empty viewport. Overlay, if on, may hide the raw images, but it must not clear to empty between pages.

---

## Out of scope

- Rewriting the two-node pool into a sliding window.
- Showing two `.active` images at once.
- Pump clock, `ImageDecoder`, Lanczos. That is the other report.
- Deleting `_reset` support in `_loadPoolNode`. The split of `actualSrc` / `poolSrc` can stay. The keep-alive set has to use `poolSrc`.
