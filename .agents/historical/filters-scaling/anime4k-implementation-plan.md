# Anime4K implementation plan

Generated: 2026-08-29

## Goal

Replace QuiviT's current Anime4K placeholder with a real Anime4K GLSL pipeline and add an Options control for the Anime4K variant.

The current filter in `src/js/services/filters/anime4k.js` is a custom single-pass edge sharpen. It is useful as a proof that WebGL filters work, but it is not Anime4K. The next slice should remove that pretend implementation and wire Anime4K through the filter runtime without weakening the module boundaries we just cleaned up.

## Product behavior

Add an Anime4K variant selector in Options under General.

- Label: `Anime4K`
- Choices: `Fast`, `Normal`
- Default: `Fast`
- Persisted value: `filter_options.anime4k.variant`
- Allowed values: `fast`, `normal`
- Invalid or missing value falls back to `fast`
- The existing `Filter: Anime4K` menu item and keybind keep enabling or disabling Anime4K. The new selector only changes which Anime4K shader chain runs when Anime4K is active.

Do not add Mode A, Mode B, or Mode C to the UI in this slice. The user asked for `normal` and `fast`, and the current Options page already has plenty going on. Keep the extra Anime4K modes as a later expansion if we still want them after the real renderer lands.

## Upstream source

Use the official `bloc97/Anime4K` GLSL v4.x shaders as the source of truth.

Reference links:

- Advanced mode guide: https://github.com/bloc97/Anime4K/blob/master/md/GLSL_Instructions_Advanced.md
- Windows MPV instructions: https://github.com/bloc97/Anime4K/blob/master/md/GLSL_Instructions_Windows_MPV.md
- Windows low-end template: https://github.com/bloc97/Anime4K/blob/master/md/Template/GLSL_Windows_Low-end/input.conf
- Windows high-end template: https://github.com/bloc97/Anime4K/blob/master/md/Template/GLSL_Windows_High-end/input.conf
- Shader repository: https://github.com/bloc97/Anime4K/tree/master/glsl
- Example shader file: https://github.com/bloc97/Anime4K/blob/master/glsl/Upscale/Anime4K_Upscale_CNN_x2_S.glsl
- License: https://github.com/bloc97/Anime4K/blob/master/LICENSE

The term the user was trying to remember is most likely Anime4K v4.x `Mode A`. The Windows low-end template defines `Mode A (Fast)`, and the Windows high-end template defines `Mode A (HQ)`. QuiviT should expose those as `Fast` and `Normal`.

### Fast chain

Map QuiviT `fast` to upstream `Mode A (Fast)`:

1. `Anime4K_Clamp_Highlights.glsl`
2. `Anime4K_Restore_CNN_M.glsl`
3. `Anime4K_Upscale_CNN_x2_M.glsl`
4. `Anime4K_AutoDownscalePre_x2.glsl`
5. `Anime4K_AutoDownscalePre_x4.glsl`
6. `Anime4K_Upscale_CNN_x2_S.glsl`

### Normal chain

Map QuiviT `normal` to upstream `Mode A (HQ)`:

1. `Anime4K_Clamp_Highlights.glsl`
2. `Anime4K_Restore_CNN_VL.glsl`
3. `Anime4K_Upscale_CNN_x2_VL.glsl`
4. `Anime4K_AutoDownscalePre_x2.glsl`
5. `Anime4K_AutoDownscalePre_x4.glsl`
6. `Anime4K_Upscale_CNN_x2_M.glsl`

### Notes on the shader names

The v4.x file names use `AutoDownscalePre`, without the older underscores from some v3 examples. Keep the names exactly as upstream v4.x uses them.

`Normal` is a QuiviT label. In source code, keep the upstream meaning visible by naming constants around `modeAFast` and `modeAHq`, then mapping UI values to those constants.

## Current repo state

Relevant files:

- `src/js/services/filters/anime4k.js`
- `src/js/services/registry.js`
- `src/js/services/pipelines/glRuntime.js`
- `src/js/services/pipelines/glCommon.js`
- `src/js/viewer/viewerPipelines.js`
- `src/js/keybinds.js`
- `src/js/core.js`
- `src/options.html`
- `src/js/options/options.js`
- `src/css/options.css`
- `README.md`
- `.agents/architecture-state.md`

Current behavior:

- `registry.js` exposes `anime4k` as a filter id.
- `active_filter` stores the selected filter id.
- `filter_options` already exists in `frontend_data`.
- `viewerPipelines.js` chooses WebGL when `active_filter` is not null.
- `glRuntime.js` compiles a list of `passes` and ping-pongs through two framebuffer textures.
- Current WebGL filters render at viewport size and use `screenToTexUV()` to sample the transformed source image.

That last point matters. Real Anime4K is not a viewport-space visual overlay. It is an image-processing pipeline with intermediate textures whose size can change. Treating it like the scanline or CRT filters will make it compile at best and behave incorrectly at worst.

## Architecture target

Keep the ownership boundaries intact.

- `keybinds.js` owns default config merging.
- `options.html`, `options.css`, and `options/options.js` own the Options UI.
- `registry.js` owns filter catalog lookup.
- `filters/anime4k.js` owns Anime4K chain selection and shader descriptors.
- `glRuntime.js` owns generic WebGL compilation, framebuffer allocation, uniforms, and render execution.
- `viewerPipelines.js` owns choosing whether to rebuild or re-render a pipeline when filter id, filter options, scaling, animation state, source, or viewport geometry changes.
- Do not put Anime4K-specific shader logic into `viewerPipelines.js`.
- Do not add DOM reads to filter modules or services.
- Do not add a Rust config field. `frontend_data` is untyped JSON and already round-trips unknown keys.

## Implementation slices

### Slice 1: Add config and Options control

Files:

- `src/js/keybinds.js`
- `src/options.html`
- `src/js/options/options.js`
- `src/css/options.css`

Tasks:

1. Add a small normalizer near `mergeConfig()`:

```js
export const DEFAULT_ANIME4K_VARIANT = 'fast';

export function normalizeAnime4kVariant(value) {
  return value === 'normal' ? 'normal' : DEFAULT_ANIME4K_VARIANT;
}
```

2. In `mergeConfig()`, normalize `frontend_data.filter_options.anime4k.variant` without dropping unrelated filter options.

Expected shape:

```json
{
  "frontend_data": {
    "filter_options": {
      "anime4k": {
        "variant": "fast"
      }
    }
  }
}
```

3. Add an `Anime4K` option group under General. Place it near Interface or near any future image-rendering controls, not under Keys. Use the existing button style or add a compact segmented control.

Suggested markup shape:

```html
<div class="options-section">
  <h3>Anime4K</h3>
  <div class="segmented-control" id="anime4k-variant-controls" role="group" aria-label="Anime4K variant">
    <button type="button" data-anime4k-variant="fast">Fast</button>
    <button type="button" data-anime4k-variant="normal">Normal</button>
  </div>
</div>
```

4. In `options/options.js`, read the saved variant on init and update button state.

5. On click, mutate `config.frontend_data.filter_options.anime4k.variant` in memory and update the segmented control. Do not persist until `Apply`, matching the rest of Options.

6. In `buildConfigFromForm()`, copy the current normalized Anime4K option into `newConfig.frontend_data.filter_options`.

7. Resetting keybinds must not reset Anime4K. That button is for input bindings and scroll zoom mode only.

Acceptance checks:

- Fresh config loads with `fast`.
- Existing configs with no `filter_options` load with `fast`.
- Existing configs with unrelated `filter_options` keep those values.
- Invalid values, including `hq`, `slow`, `true`, and `null`, normalize to `fast`.
- Apply persists the selected variant.

### Slice 2: Pass filter options into the WebGL filter module

Files:

- `src/js/services/registry.js`
- `src/js/viewer/viewerPipelines.js`
- `src/js/services/pipelines/glRuntime.js`

Tasks:

1. Change filter lookup so callers can request a configured filter module.

Possible API:

```js
export function getFilterModule(id, frontendData = {}) {
  const f = FILTER_BY_ID.get(id);
  return f ? f.module.resolve?.(frontendData.filter_options) ?? f.module : null;
}
```

2. Keep existing filters working. `scanlines`, `phosphor`, and `crt` can remain plain modules with `passes`.

3. In `viewerPipelines.js`, include a stable filter-options key when deciding whether to rebuild the WebGL program.

Suggested scope:

- Track only the active filter's relevant options.
- For Anime4K, key on `filter_options.anime4k.variant`.
- Avoid serializing the whole config on every state update.

4. Rebuild the WebGL pipeline when the active Anime4K variant changes.

5. Keep animated-image behavior unchanged. Anime4K remains disabled for animated images.

Acceptance checks:

- Switching from `fast` to `normal` while Anime4K is active rebuilds shaders.
- Switching options while another filter is active does not rebuild that other filter.
- Other filters keep their current output.

### Slice 3: Split viewport filters from image-space filters

Files:

- `src/js/services/pipelines/glRuntime.js`
- `src/js/services/pipelines/glCommon.js`
- `src/js/viewer/viewerPipelines.js`
- `src/js/services/filters/anime4k.js`

Why this slice exists:

The current runtime assumes every pass renders to the viewport. That works for CRT and scanlines because they are visual effects. Anime4K needs source-sized and upscaled intermediate textures. The runtime must support both kinds without making every filter pay the Anime4K complexity cost.

Design:

- Add a filter-module property such as `space: 'viewport' | 'image'`.
- Existing filters default to `viewport`.
- Anime4K uses `image`.
- `viewport` filters keep the current `screenToTexUV()` path.
- `image` filters render the source through Anime4K into an intermediate image texture, then draw that result through the normal viewport transform.

Implementation outline:

1. Keep `createGlRuntime(canvas)` as the single WebGL owner.

2. Add pass descriptors that can declare:

```js
{
  name: 'Anime4K_Restore_CNN_M',
  fsSource,
  input: 'source' | 'previous' | '<named-save>',
  save: '<named-save>' | null,
  outputScale: 1 | 2,
  when: ({ source, output }) => true
}
```

3. For image-space filters, allocate intermediate textures using image dimensions, not viewport dimensions.

4. Support more than two intermediate textures if named saves require it. The current two-FBO ping-pong path is probably not enough once upstream `SAVE` and `BIND` directives are translated.

5. Add a final draw pass that samples the Anime4K output texture with the same geometry controls that the current viewport renderer uses.

6. Do not set inline visual styles from JS while doing this. Canvas intrinsic width and height are still okay. Presentation belongs in CSS.

7. Keep texture cleanup boring and complete. Delete source, intermediate, and saved textures when source identity, filter variant, or runtime changes.

Acceptance checks:

- Viewport filters still render in screen space.
- Anime4K output follows pan, zoom, rotation, and flip.
- Anime4K does not smear transparent borders.
- Disabling Anime4K clears the filter canvas.
- Switching images deletes stale Anime4K intermediate textures.

### Slice 4: Bring in the real Anime4K shaders

Files:

- `src/js/services/filters/anime4k.js`
- New files under `src/js/services/filters/anime4k/`

Recommended file layout:

```text
src/js/services/filters/anime4k/
├─ chains.js
├─ common.js
├─ mode-a-fast.js
├─ mode-a-hq.js
└─ upstream-license.js
```

Alternative:

Store one module per upstream GLSL file if that is easier to review:

```text
src/js/services/filters/anime4k/shaders/
├─ Anime4K_Clamp_Highlights.js
├─ Anime4K_Restore_CNN_M.js
├─ Anime4K_Restore_CNN_VL.js
├─ Anime4K_Upscale_CNN_x2_M.js
├─ Anime4K_Upscale_CNN_x2_S.js
├─ Anime4K_Upscale_CNN_x2_VL.js
├─ Anime4K_AutoDownscalePre_x2.js
└─ Anime4K_AutoDownscalePre_x4.js
```

Tasks:

1. Pull shader contents from the official v4.x release or current `master` only after confirming file names match the v4.x instructions.

2. Preserve Anime4K's MIT license notice in the shader modules or in a neighboring license file that the modules reference.

3. Translate mpv shader directives to QuiviT pass descriptors.

Relevant mpv concepts to translate:

- `HOOK`
- `BIND`
- `SAVE`
- `WIDTH`
- `HEIGHT`
- `WHEN`
- texture offset helpers
- named intermediate textures

4. Avoid hand-writing CNN weights. Copy them from upstream and keep the copied shader text as intact as the WebGL compiler allows.

5. Convert mpv helper names to WebGL2 equivalents. Examples:

- `MAIN_tex` and `MAIN_texOff` become functions around `texture()` and texel offsets.
- mpv texture size macros become uniforms.
- mpv output-size directives become descriptor functions.

6. Prefer a small translation helper over editing every shader body by hand. Manual edits to shader math are where mistakes hide.

7. Remove the current laplacian placeholder.

Acceptance checks:

- The browser console shows no shader compile or link errors for `fast`.
- The browser console shows no shader compile or link errors for `normal`.
- The shader names in error logs include the Anime4K pass name.
- A visual smoke test shows a real super-resolution effect, not only edge sharpening.

### Slice 5: Handle scaling interaction

Files:

- `src/js/viewer/viewerPipelines.js`
- `src/js/services/viewerMath.js`
- `src/js/services/registry.js`

Decision:

Anime4K should take priority over Lanczos while it is active. The current pipeline already makes WebGL filters take priority over Lanczos. Keep that behavior.

Rules:

- `active_filter === 'anime4k'` uses Anime4K output and ignores Lanczos.
- `active_filter !== null` and not Anime4K keeps the existing viewport-filter behavior.
- Animated images bypass Anime4K and Lanczos as they do now.
- The source image element keeps `data-scaling` in sync with the effective fallback scaling so CSS does not fight the filter canvas.

Open implementation detail:

If Anime4K produces a 2x or 4x texture, the final viewport transform should treat that texture as an image with larger natural dimensions while preserving the user's requested visual zoom. The cleanest implementation may be to render Anime4K into an image-space texture and then sample it using source-image logical coordinates. In that model, viewport math still uses original image dimensions, and the final pass maps original UVs into upscaled texture UVs.

Acceptance checks:

- At `100%`, Anime4K does not accidentally double the displayed page size unless the fit math asks for it.
- Fit width, fit height, and fit window keep the same framing before and after enabling Anime4K.
- Zooming in shows the Anime4K result instead of browser bilinear interpolation.

### Slice 6: Verification and docs

Files:

- `README.md`
- `.agents/architecture-state.md`
- possibly `.agents/implemented.md`

Tasks:

1. Update README feature text if the behavior changes from "Anime4K-like" to real Anime4K. Keep it honest.

2. Update README system defaults with the Anime4K variant default if this becomes user-facing.

3. Update `.agents/architecture-state.md` only if module ownership changes. Adding shader files under the existing filter owner probably needs a short line under JavaScript because the filter module map changes.

4. Run the verify implementation skill when the slice is complete.

Minimum checks:

- `node --check` on changed JS files.
- `cargo check` from `src-tauri` if Rust files changed. This plan should avoid Rust changes.
- Manual app smoke test with:
  - Anime4K disabled
  - Anime4K Fast
  - Anime4K Normal
  - another WebGL filter
  - Lanczos
  - animated GIF or APNG
  - transparent PNG or ICO spritesheet
  - rotation and flip
  - fit width and fit height

Visual checks:

- Use a manga/comic test image with thin line art.
- Compare current placeholder output against Fast and Normal.
- Confirm Fast is visibly sharper than bilinear and less expensive than Normal.
- Confirm Normal does not blank the canvas on a large page.

## Risks

### Upstream GLSL is not browser GLSL

Anime4K's official GLSL files target mpv/libplacebo-style shader directives. They are not drop-in WebGL2 fragment shaders. The implementation must translate the pass metadata and texture helpers.

Mitigation:

- Translate one simple upstream shader first, probably `Anime4K_Clamp_Highlights.glsl`.
- Add pass names to shader compile logs.
- Only after that, port the CNN passes.

### The runtime may need named textures

The current `glRuntime.js` only has source texture plus two framebuffer textures. Anime4K uses named intermediate saves. A simple ping-pong chain may break if a later pass binds an earlier saved result.

Mitigation:

- Model Anime4K passes with explicit inputs and saves.
- Keep named texture storage private to `glRuntime.js`.
- Delete named textures on source or filter rebuild.

### Output size can change mid-chain

Upscale passes double dimensions. Auto-downscale passes may conditionally reduce work based on output size. If the runtime treats every pass as viewport-sized, it will be wrong.

Mitigation:

- Make each image-space pass declare output dimensions.
- Allocate textures from descriptor results.
- Keep viewport rendering as a final separate pass.

### Performance may be rough on large static images

Anime4K is designed for real-time video, but QuiviT users may open very large comic pages. A 4x intermediate on a huge image can exceed texture limits or memory.

Mitigation:

- Query `MAX_TEXTURE_SIZE`.
- Cap intermediate dimensions with a graceful fallback and a console warning.
- Prefer Fast by default.
- Skip unnecessary second upscales when the final screen scale does not need them, but only after the fixed upstream chain works.

### Alpha handling can regress

The current placeholder premultiplies RGB by alpha to avoid sharpening invisible color. Upstream video shaders assume opaque frames more often than image viewers can.

Mitigation:

- Test transparent PNG and ICO output.
- Premultiply or alpha-guard at texture upload/final output if needed.
- Do not alter source image alpha for other filters.

## Proposed code contracts

### Filter module contract

Keep plain filters valid:

```js
export const filter = {
  passes: [...]
};
```

Allow configured filters:

```js
export const filter = {
  resolve(filterOptions) {
    const variant = normalizeAnime4kVariant(filterOptions?.anime4k?.variant);
    return variant === 'normal' ? modeAHqFilter : modeAFastFilter;
  }
};
```

### Runtime pass contract

Extend pass descriptors without breaking existing ones:

```js
{
  name: 'Anime4K_Upscale_CNN_x2_M',
  space: 'image',
  fsSource,
  input: 'previous',
  save: null,
  outputScale: 2,
  applyUniforms(gl, loc, geometry, viewport, passState) {}
}
```

Existing viewport passes can omit `space`, `input`, `save`, and `outputScale`.

### Options config contract

Keep the config shape narrow:

```js
filter_options: {
  ...existingOptions,
  anime4k: {
    ...existingAnime4kOptions,
    variant: normalizeAnime4kVariant(existingAnime4kOptions?.variant)
  }
}
```

Do not replace the whole `filter_options` object when saving the form.

## Suggested implementation order

1. Add config normalizer and Options UI.
2. Thread `filter_options` into filter resolution and rebuild keys.
3. Add image-space pipeline support with a tiny test filter first.
4. Port `Anime4K_Clamp_Highlights.glsl`.
5. Port the Fast chain.
6. Smoke test Fast thoroughly.
7. Port the Normal chain.
8. Smoke test Normal and large images.
9. Remove the placeholder shader.
10. Update docs and run verification.

## Definition of done

- Anime4K Fast and Normal are selectable from Options under General.
- Fast is the default for new and old configs.
- The existing Anime4K toggle uses the selected variant.
- The old custom laplacian pass is gone.
- Anime4K uses official v4.x shader logic, translated to WebGL2 without changing CNN weights by hand.
- Other filters still work.
- Lanczos still works when no WebGL filter is active.
- Animated images still bypass WebGL/Lanczos filtering.
- No shader compile errors appear in normal use.
- README and architecture docs are current.
- Verification has been run and recorded in the final implementation summary.


