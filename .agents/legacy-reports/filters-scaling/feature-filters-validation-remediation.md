# Feature/Filters Validation — Remediation Plan

> **Target:** `feature/filters` (`f164275`) vs `main` (`ccb91ef`) — 31 files, `+2898/-53` (`git diff main...feature/filters --stat`).
> **Scope:** `src/js/services/webglPipeline.js`, `scalingPipeline.js`, `viewer/viewerRender.js`, `viewerMath.js`, `core.js`, `main/main.js`, `services/actions.js`, `animation.rs` + `commands/animation.rs`, `index.html`, `main.css`.
> **Vendored constraint:** Keep `src/js/vendors/pica.js` vendored, no `npm:pica` dep. Practical fix is lazy `window.pica()` inside factory, not an ESM wrapper (YAGNI — see 4.2).
> **How to use:** Work in slices 1→5. Each slice is deployable and verifiable. No behavior change except where noted.

---

## 1. Summary

Adds three surfaces on top of `main`:

* Lanczos via `pica` WASM (`scalingPipeline.js:1`, `viewerRender.js:115`)
* WebGL filters CRT + Anime4K (`webglPipeline.js:1`, `viewerRender.js:48`)
* Animated detection `animation::is_animated` (`src-tauri/src/animation.rs:1`, `commands/animation.rs:1`) with `core.js:166` `check_is_animated` fallback to bilinear and menu mute in `main.js:177`

Renames `bicubic→bilinear` (`keybinds.js:22`, `actions.js:63`), adds `Viewer.setScaling` (`viewerMath.js:162`).

---

## 2. Blocking — Fix First (Fail → Pass)

### 2.1 `index.html:222-224` — `shellBackground.js` dropped

**State:** `index.html:222` added `<script src="js/vendors/pica.js">` + `<script type="module" src="js/viewer/viewer.js">` and removed `<script type="module" src="/js/shellBackground.js">`.

`architecture-state.md:57` says `shellBackground.js` mirrors `--surface` onto the native window (`lib.rs:69` `apply_shell_background`). Without the script the shell stays at Rust fallback `#252526`/`#ffffff`, not live `--surface`. Theme toggles no longer repaint the native backdrop.

**Rule:** `AGENTS.md:31` one owner per concern, `AGENTS.md:58` shared cross-window helpers stay out of state machine/UI files.

**Fix (Slice 1, ~3 lines):**
* Remove `index.html:223` viewer script tag (viewer is already `import { Viewer }` in `main.js:7` — double load, see 5.4).
* Re-add shell background as import in `main.js:1`, not HTML:
  ```js
  import "../shared/shellBackground.js";
  ```
  or keep `index.html` tag but as `type="module" src="/js/shared/shellBackground.js"`. Prefer import — matches `AGENTS.md:59` thin bootstrap.
* Verify: toggle theme light/dark, change `--surface` in custom CSS, confirm native window border repaints (compare `windows.rs` constant).

### 2.2 `commands/animation.rs:17` — Full decompress per navigation

**State:** Archive path builds `cache.read_entry_bytes(&arc_path, &path)?.wait_for_data(&path)?` full entry, then `animation::is_animated(&bytes)` scans whole buffer. 10 MiB JPEG inside CBZ decompressed just to read 8-byte header. Called from `core.js:168` on *every* image nav.

**Rule:** `AGENTS.md:19` aggressive I/O caching, header-only reads; `AGENTS.md:15` cache hot path.

**Fix (Slice 1, backend):**
* Add `ArchiveCache::read_entry_header(arc, entry, 8192)` that returns first 8 KiB (reuse `zip::read` header or `seek`+`read_exact`). For FS path already does 8 KiB (`commands/animation.rs:23`).
* `check_is_animated` becomes:
  ```rust
  let header = cache.read_entry_header(&arc_path, &path, 8192)?;
  Ok(is_animated(&header))
  ```
* Pass `src-tauri/src/animation.rs:5` whole-buffer scans limited to `&bytes[..8192]` — prevents `O(n)` on large files.

**Check:** `cargo test` add `animation_header_only` vectors (GIF with NETSCAPE past 8K — still detected because NETSCAPE is within 1K; WEBP VP8X at `pos+8` within header). Bench: nav 100 images in 500 MiB CBZ, no spike.

### 2.3 `core.js:166-185` — Navigation blocked on IPC

**State:** `_selectEntry` awaits `invoke('check_is_animated')` before setting `_state.isAnimated` and `notify()`. `viewerRender.js` can't show `src` until IPC returns. Feels sluggish even for static PNGs.

**Rule:** State machine has no DOM but shouldn't block fan-out.

**Fix (Slice 3):**
* Build `newSrc` first, set `_state.src` optimistically, `notify()` immediate.
* Then `check_is_animated` async; on return if `index` still current, set `isAnimated` and `notify()` again. Memoize:
  ```js
  const _animMemo = new Map(); // key `${archivePath}::${path}` → bool
  ```
  `viewerRender.js:48` already subscribes to filter change, so second notify repaints fallback.
* Keeps `if (_state.index !== index) return` guard already at `core.js:183`.

---

## 3. Code Guidelines

### 3.1 Duplicate blob cache `scalingPipeline.js:11` / `webglPipeline.js:4`

**Rule:** `AGENTS.md:21` search before duplicate; extract helper.

**Fix (Slice 2):** New `src/js/shared/blobImage.js`:
```js
let _src=null,_url=null,_img=null;
export async function getCleanImage(src){ if(_src===src&&_img) return _img; ... fetch → blob → createObjectURL → decode ... }
export function evictBlobCache(){ ... }
```
Both pipelines `import { getCleanImage }`. Remove local `_cachedSrc/_getCleanImage`. Single `URL.revokeObjectURL` owner.

### 3.2 `window.pica` global `scalingPipeline.js:5`

**State:** `const resampler = window.pica()` at top-level races vendor `<script>` order; pollutes global.

**Decision:** Keep vendored (`src/js/vendors/pica.js` stays, no dep). Practical `AGENTS.md` fix is **lazy inside factory** (Slice 2a), not wrapper file (YAGNI).

**Fix:**
```js
let _resampler = null;
function getResampler(){ return _resampler ||= window.pica(); }
export function createScalingPipeline(mode){
  if(mode==='none'||mode==='bilinear') return {render:()=>Promise.resolve(null),cancel(){},dispose(){}};
  return { render: async (img,geom)=>{
    const resampler = getResampler();
    ...
  }}
}
```
*Future:* If pica is rebuilt as ESM, add `pica-wrapper.js` that re-exports without `window`.

### 3.3 Shared canvas singletons `scalingPipeline.js:15`

`const _destCanvas = document.createElement('canvas')` shared across concurrent `render()` calls. `cancel()` only nulls promise, not canvas size.

**Fix:** Make per-pipeline instance:
```js
export function createScalingPipeline(mode){
  const _srcCanvas = document.createElement('canvas');
  const _destCanvas = document.createElement('canvas');
  ...
}
```

### 3.4 Debug scaffolding `scalingPipeline.js:151`

Commit left `// ctx.fillStyle = 'rgba(255,0,0,0.5)'`. Remove before merge (self-documenting code `AGENTS.md:13`).

### 3.5 `animation.rs:20,23` O(n) full scan

Covered in 2.2 header-only. Also add early exit: `check_gif` should bound search to first 2 KiB (NETSCAPE lives in header). Document false-positive note (single-frame GIF with NETSCAPE loop ext → treated as animated, acceptable per spec; alternative is frame-count parse).

---

## 4. JS Ownership / Coupling

### 4.1 `window._lastAnimated` `main.js:183`

Global mutable coordination breaks `AGENTS.md:34` state callbacks.

**Fix:** `let _lastAnimated = false;` in module scope, compare as `if (state.scalingMode !== activeScaling || _lastAnimated !== isAnimated)`.

### 4.2 Duplicated fallback `main.js:179` + `viewerRender.js:117`

Both do `if(isAnimated && scaling==='lanczos') scaling='bilinear'`.

**Fix:** Single helper `src/js/services/viewerMath.js:getEffectiveScaling(scaling, isAnimated)` or `core.js:getEffectiveScaling()`. Both call it. Removes drift when logic changes.

### 4.3 `actions.js:63` direct mutation

```js
state.config.frontend_data.crt_filter = next; // reach-in
Core.persistConfig(); Core.setState({}); // empty-object hack
```

**Rule:** Actions are pure registry (`AGENTS.md:58` no DOM), Core owns writes.

**Fix:** Add `core.js` method:
```js
setFilter(next){ const fd=_state.config.frontend_data; fd.anime4k_filter=!!next.anime4k; fd.crt_filter=!!next.crt; if(next.crt) fd.anime4k_filter=false; ... _scheduleConfigFlush(); _notify(); }
```
Actions become:
```js
run:(ctx)=> ctx.Core.setFilter({anime4k: !ctx.Core.getState().config.frontend_data.anime4k_filter})
```

### 4.4 `pipeline.type = 'lanczos'` `viewerRender.js:204`

External mutation of service discriminator.

**Fix:** Factory returns typed object: `createScalingPipeline` → `{type:'lanczos', render, cancel, dispose}`. Caller keeps as `pipeline.type` read-only.

### 4.5 Double load `viewer.js` `index.html:223`

`index.html` has `<script type="module" src="js/viewer/viewer.js">` *and* `main.js:7` imports `Viewer`. ES modules dedupe by URL, but `viewer.js:19` side-effects `createViewerRenderer` run via HTML-tag order, violating thin bootstrap. Remove HTML tag, rely on import.

### 4.6 Duplicated inverse-project `scalingPipeline.js:78` vs `webglPipeline.js:65`

Both map screen→texture with `cos/sin/unscale/unflip`. Extract `viewerMath.js:screenToImg(px,py, geom, nw,nh)` or `invertViewport(geom)`. Keep shader GLSL `inverseTransformGLSL` string in one place (`webglPipeline.js:57`) — JS helper for Lanczos crop only.

---

## 5. Rust Ownership

### 5.1 `animation.rs:1` at crate root

`AGENTS.md:65` domain lives in `archives/` + `formats.rs` + `ico.rs`. New `pub mod animation` should be `src-tauri/src/formats.rs: is_animated` (format registry) or `src-tauri/src/archives/animation.rs`. Prefer `formats.rs` — it's already the supported-format registry and has tests.

**Fix:** Move `is_animated`, `check_gif/webp/apng` into `formats.rs`, delete `animation.rs`. Update `commands/animation.rs:5` → `use crate::formats::is_animated;`.

### 5.2 Preamble at offset 0 `animation.rs:6`

`bytes.starts_with(b"GIF8")` at 0 breaks SFX `.exe` ZIP preamble (zip EOCD scan already handles). Not fatal for GIF/WEBP, but keep header-window scan (search first 512 B for magic) or document as header-only and note SFX false-negative is acceptable.

### 5.3 Duplicate `animation` mod name

`lib.rs:1` `pub mod animation` + `commands/mod.rs:1` `pub mod animation` → `crate::animation` vs `crate::commands::animation` confusion. After 5.1, rename to `commands/animation_check.rs` or `commands/image_meta.rs`.

---

## 6. CSS

`main.css:820` `:has([data-render-ready])` wide invalidation but `max` allowed; no JS inline `width/color/display` violation — `viewerRender.js:139` uses `style.setProperty('--crop-*')` correctly (allowed per `AGENTS.md:50`). Keep. Optionally scope to `#viewport[data-crt]` via JS `dataset` to avoid `:has`, marked `nit`.

---

## 7. Slice Plan

| Slice | Files | Risk | Do |
|-------|-------|------|-----|
| **1 — Hotfix** | `index.html`, `main.js`, `commands/animation.rs`, `animation.rs`/`formats.rs` | Low | Restore shellBackground (2a), header-only 8 KiB + move to `formats.rs`. Run `cargo check`, nav 100-image CBZ. |
| **2 — Shared helper** | `shared/blobImage.js` (new), `scalingPipeline.js`, `webglPipeline.js` | Low | Dedupe blob cache, lazy `window.pica` (2a), per-pipeline canvases. Remove debug. |
| **3 — Core non-blocking** | `core.js`, `viewerRender.js`, `viewerMath.js` | Medium | Optimistic `notify` + memo, `getEffectiveScaling`, `invertViewport`. |
| **4 — Ownership** | `actions.js`, `core.js`, `main.js`, `viewerRender.js`, `index.html` | Medium | `Core.setFilter`, `let _lastAnimated`, `pipeline.type` read-only, remove viewer `<script>`. |
| **5 — Cleanup & Docs** | `README.md`, `architecture-state.md`, `implemented.md` | Low | Document filter/bilinear fallback, `blobImage.js` map, Lanczos 80 ms + viewport tiling. |

Each slice: `node --check src/js/**/*.js`, `cargo check`, `cargo test` (add 11 `is_animated` header vectors: gif anim/static, webp anim/static, apng anim/static, png static, jpg static, svg skip, truncated <8 B).

---

## 8. Blast Radius

* IPC `check_is_animated {path, archivePath→bool}` unchanged, JSON shape stable.
* `quivit://` / `asset://` untouched.
* Config keys `crt_filter`, `anime4k_filter` already in `keybinds.js:59` `mergeConfig`; persist via `core.js` debouncer (1500 ms). No new config file.
* Window `windows.rs` constants untouched; `shared/windowFit.js` caps still mirrored.

---

## 9. Verification

* `cargo check` clean, `cargo test` 14/14 + new `format_tests::is_animated_header` (11 ok).
* `node --check` on `core.js`, `viewerRender.js`, `scalingPipeline.js`, `webglPipeline.js`, `actions.js`, `main.js`.
* Manual smoke: open `test-files/single-frame.gif` vs animated GIF, WEBP, APNG — Lanczos/CRT badges `.muted` when animated, Lanczos check flips to Bilinear visually, returns on static. Zoom 400% + rotate 90° tiling correct. Theme toggle repaints native shell. Rapid next/prev (hold) no lag.
* Update `README.md` Features (Scalings/Filters), `architecture-state.md` (add `shared/blobImage.js`, `formats.rs:is_animated`, remove `animation.rs`).

---

## 10. Deferred (YAGNI)

* `pica-wrapper.js` ESM shim — only if pica rebuilt as ESM.
* Full animated Lanczos/WebGL support — tracked in `additions.md` Post-Release Backlog "Animated Images Support for Lanczos & WebGL".

