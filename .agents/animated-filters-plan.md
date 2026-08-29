```text
refer to '.agents/animated-filters-plan.md' and begin planning plus discussion for the next refactor/implementation slice.
```

# Animated Filters & WebGL Lanczos: Implementation Plan

Scope: Render WebGL filters (CRT, Anime4K, etc.) and Lanczos scaling over animated images (GIF, APNG, WebP, and SVG) without losing native playback performance.

This plan defines the architectural additions necessary to support high-performance filters on animated formats by copying the browser's native composited frame into a WebGL texture at 60fps, but *only* when a filter is active.

**Reference Material:** See [`animated-filters.md`](file:///e:/Projects/QuiviT/.agents/animated-filters.md) for the original deep-dive analysis. Specific line ranges are linked in the slices below to provide necessary context without requiring agents to read the entire document.

---

## Ground Rules

- **Work in logical slices.** Each slice is an independent commit, leaves the app functional, and is verified (`node --check` + manual smoke) before moving on.
- **Still images do not change.** The existing, highly optimized `getCleanImage` path for PNG/JPEG/WebP remains exactly as is. We do not rewrite the still path to support the animated path. ([animated-filters.md:L83-L84](file:///e:/Projects/QuiviT/.agents/animated-filters.md#L83-L84))
- **No Decoders.** We rely purely on the browser's native `<img>` element for playback and disposal math. ([animated-filters.md:L26-L27](file:///e:/Projects/QuiviT/.agents/animated-filters.md#L26-L27))

---

## Target Architecture Additions

```
src/js/
  shared/
    blobImage.js              (NEW: getLiveImage(src) - creates and caches a same-origin live Image)
  
  services/
    scaling/
      lanczosWebGL.js         (NEW: A custom WebGL shader for Lanczos scaling on the live pump)

  viewer/
    viewerPipelines.js        (MODIFIED: Owns the new requestAnimationFrame pump and staging canvas)

src-tauri/src/
  formats.rs                  (MODIFIED: Custom byte-scanner for GIF 0x2C descriptor blocks & SVG animation detection)
```

---

## Cost Controls & SVG Strategy

1. **Anime4K Cap:** Anime4K compute is too heavy for 30fps+ 4K APNGs. The staging canvas inside the live pump must be capped via a named constant `ANIME4K_MAX_EDGE = 2048`. If the live image is larger, downscale it via `drawImage` into the staging canvas before WebGL upload. CRT and stills remain uncapped. ([animated-filters.md:L157-L164](file:///e:/Projects/QuiviT/.agents/animated-filters.md#L157-L164))
2. **SVG Animation Strategy:** To avoid freezing animated SVGs, we will route them through the same 60fps live pump as GIFs. 
   - **Detection:** We will scan the SVG contents in Rust for `<animate`, `<set>`, or `@keyframes` so static SVGs aren't needlessly pumped at 60fps. ([animated-filters.md:L95-L99](file:///e:/Projects/QuiviT/.agents/animated-filters.md#L95-L99))
   - **Rendering:** We rely on Chromium's native `drawImage` to capture the playing SVG. If WebView2 fails to capture SMIL/CSS animations (freezing on frame 1), we will introduce `canvg` in a subsequent slice.

---

## Slices

### Slice 1: SVG Policy & Menu Ungating

**Files touched:** `formats.rs`, `core.js`, `fsUtils.js`, `actions.js`, `menubar.js`.

**Tasks:**
1. `formats.rs`: Add a string scanner for `.svg` files checking for `<animate`, `<set`, or `animateTransform` tags to accurately flag animated SVGs.
2. `core.js` & `fsUtils.js`: Remove the hardcoded `isAnimated = true` force for all SVGs, allowing the backend's accurate detection to dictate the flag. Do not invent an `isSvg` Core flag.
3. `actions.js` & `menubar.js`: Remove the `state.isAnimated` skips that block Lanczos and filters. Match the menu to the code (unmute the rows).

**Nuance:** ([animated-filters.md:L69-L71](file:///e:/Projects/QuiviT/.agents/animated-filters.md#L69-L71), [L128-L132](file:///e:/Projects/QuiviT/.agents/animated-filters.md#L128-L132)) The overlay must not appear yet, or the image will go blank. Leave the skip in `_resolveActiveFilter` until the pump is wired in Slice 3.

### Slice 2: Live Blob Cache

**Files touched:** `blobImage.js`.

**Tasks:**
1. Implement `getLiveImage(src)`: fetches the file as a Blob, generates `URL.createObjectURL(blob)`, constructs a `new Image()`, and calls `.decode()`.
2. Add explicit cache invalidation (revoke URL, close Image) when the gate turns off, the source changes, or the pool recycles.

**Nuance:** ([animated-filters.md:L101-L102](file:///e:/Projects/QuiviT/.agents/animated-filters.md#L101-L102), [L137-L139](file:///e:/Projects/QuiviT/.agents/animated-filters.md#L137-L139)) `quivit://` and `asset://` URLs are cross-origin and taint canvases. `blobImage` already fetches bytes; this same-origin blob URL bypasses the taint. Do NOT use `createImageBitmap` on the live path (it freezes on frame 1). Do NOT touch the existing still `getCleanImage` path. No still caller should import `getLiveImage`.

### Slice 3: The Frame Pump & WebGL Upload

**Files touched:** `glRuntime.js`, `viewerPipelines.js`.

**Tasks:**
1. `glRuntime.js`: Add a narrow method `updateSource(canvasOrImage)` allowing direct texture upload, bypassing `getCleanImage`. `render(img, geom)` remains completely unchanged for stills.
2. `viewerPipelines.js`: Compute `useLivePump = isAnimated && (activeFilter !== null || scaling === 'lanczos')`.
3. When `useLivePump` becomes true:
   - Size the internal staging 2D canvas (HTML-first or in-memory) applying the `ANIME4K_MAX_EDGE = 2048` cap if Anime4K is active.
   - Start a `requestAnimationFrame` loop for playback. Each tick: `drawImage` the live `Image` onto the staging canvas, call `glRuntime.updateSource(stagingCanvas)`, then run standard `render()` geometry.
4. Stop the loop and evict the live image when `useLivePump` becomes false or the image changes.

**Nuance:** 
- ([animated-filters.md:L108-L111](file:///e:/Projects/QuiviT/.agents/animated-filters.md#L108-L111)) `viewerPipelines.js` already owns overlay canvases and the pan rAF. The playback rAF lives there. Do NOT add a sibling module to split the render orchestration.
- ([animated-filters.md:L73-L74](file:///e:/Projects/QuiviT/.agents/animated-filters.md#L73-L74)) Keep the pool `<img>` playing under the existing `opacity: 0` rule. Do NOT change it to `display: none` (which pauses animations in Chromium).
- ([animated-filters.md:L103-L104](file:///e:/Projects/QuiviT/.agents/animated-filters.md#L103-L104)) Try direct `texImage2D` from the live `Image` first to skip the blit. If it sticks on frame 0 in WebView2, fall back to the staging canvas blit.
- ([animated-filters.md:L113-L114](file:///e:/Projects/QuiviT/.agents/animated-filters.md#L113-L114)) Do NOT add `pixelsChanged` to the still call sites. Still pan must keep skipping `texImage2D`.
- ([animated-filters.md:L153-L154](file:///e:/Projects/QuiviT/.agents/animated-filters.md#L153-L154)) Bump generation counters on source change so an in-flight gated `render()` cannot stamp `data-render-ready` on a still PNG.

### Slice 4: WebGL Lanczos

**Files touched:** `lanczosWebGL.js` (NEW), `viewerPipelines.js`.

**Tasks:**
1. Create `services/scaling/lanczosWebGL.js` implementing a custom Lanczos 2/3 shader compatible with `glRuntime.setFilter()`.
2. In `viewerPipelines.js`, if the frame pump is active (`useLivePump === true`), `scaling === 'lanczos'`, and no other filter is overriding it, pass the WebGL Lanczos shader into `glRuntime.setFilter()`.

**Nuance:** ([animated-filters.md:L171-L172](file:///e:/Projects/QuiviT/.agents/animated-filters.md#L171-L172)) WebGL Lanczos is strictly for the animated pump. Do NOT call `createLanczosPipeline().render` (pica) from the rAF loop, and do NOT change how still Lanczos works.

### Slice 5: GIF Header Honesty

**Files touched:** `formats.rs`, `format_tests.rs`.

**Tasks:**
1. `formats.rs`: Replace the simple `NETSCAPE2.0` check with a custom byte scanner. Walk the GIF chunk structure within the first 8 KiB to count `0x2C` (Image Descriptor) blocks. 
2. If more than one `0x2C` block is found, classify it as animated even if `NETSCAPE2.0` is missing.
3. Add test coverage in `format_tests.rs` for a multi-frame GIF without the NETSCAPE block.

**Nuance:** ([animated-filters.md:L166-L168](file:///e:/Projects/QuiviT/.agents/animated-filters.md#L166-L168)) Keep the single-frame NETSCAPE false positive. Expanding the heuristic avoids false negatives for looping GIFs that lack the extension.

---

## Commit sequence (one per slice on `feature/filters`)

1. `slice1: SVG policy shift and menu ungating`
2. `slice2: Live blob cache for same-origin WebGL upload`
3. `slice3: RequestAnimationFrame pump and WebGL canvas injection`
4. `slice4: WebGL Lanczos shader for animated formats`
5. `slice5: Custom GIF byte scanner for accurate animation detection`

After each slice, the active agent MUST follow this handoff protocol:
1. Append a brief summary to the **Completed Slices Log** at the bottom of this file, detailing key architectural choices and any quirks.
2. Provide a comprehensive summary of the changed files and the automated verification steps taken in the chat.
3. Present a numbered manual runtime tests list for the user to confirm. Each item must be a concrete instruction (where to go, what to do, what to observe) with the expected result in plain language. Only include items relevant to the current slice.
4. Tell the user to commit the slice to the `feature/filters` branch.
5. Explicitly instruct the user to **start a new agent session** for the next slice to maintain context hygiene.

---

## Completed Slices Log

- **Slice 1: SVG Policy & Menu Ungating:** Moved SVG animation detection to a fast byte scanner (`check_svg`) in `formats.rs` targeting `<animate`, `<set`, and `animateTransform` up to 8 KiB deep. Removed frontend UI logic that muted scaling/filter options for animated files. Removed hardcoded SVG `.endsWith` overrides in `core.js` and `fsUtils.js`, routing them into `Core.checkIsAnimated`. Note: `viewerPipelines.js` currently enforces bilinear down-sampling for Lanczos if the target is animated, intentionally preserving a stable fallback until the frame pump is wired in Slice 3.
  - **Runtime test notes (expected intermediate states):**
    - Selecting Lanczos on animated formats saves the preference but `getEffectiveScaling` in `viewerMath.js` downgrades it to bilinear. The menu checkmark lands on bilinear, not lanczos. Resolves when the pump makes lanczos work (Slices 3-4).
    - Selecting a filter on animated formats saves to config but `_resolveActiveFilter` in `viewerPipelines.js` still returns `null` when `isAnimated` is true, so the overlay does not render. Resolves in Slice 3.
    - Static SVGs can now receive filters, but `getCleanImage` does not feed SVG sources into WebGL properly (ghost of last image with SVG dimensions). Previously hidden because all SVGs were forced to `isAnimated = true`. The live blob cache in Slice 2 addresses this.
