Validation comparison performed against .agents/AGENTS.md and .agents/skills/validate-changes/SKILL.md before presenting. Each slice below was checked for module ownership, pure module direction, CSS source of truth, HTML first rendering, blast radius with runnable checks, and docs discipline.

# ICO per-size backdrops plan

**Target:** working tree, replace single spritesheet ICO with per-size cells that share one DOM pattern in both viewers.

**Scope lock:** ICO files only. No change to strip count, anchors, column width tracking, width scan skip, neighbor preload exclusion, or transparent pref. No architecture-state or README edits during implementation. Backend keeps Rust decode, no JS ICO parser. Deviations go here with reason and file.
**Deviation 2026-10-08:** slices 5 and 7 fall back to DOM only for ICO rows. N-texture multi-quad in both pipelines needs a compositor rewrite, out of slice scope. `src/js/viewer/viewerPipelines.js` skips ICO nodes in single and column paths, teardown clears stale canvas output, DOM row plus backdrops stay visible. Filter parity for ICO rows is follow-up work.
**Deviation 2026-10-08:** slice 5 landed through one composite canvas per ICO file instead of N-texture multi-quad. `src/js/viewer/viewerPipelines.js:191-265,332-580,2237-2290` builds total by `sum(widths)` by `max(height)`, draws cells left to right with vertical centering, caches one texture per file key, and reuses the existing single image WebGL plus Lanczos CPU paths. Slice 7 column path stays DOM-only fallback.
**Deviation 2026-10-08:** ICO cells break HTML-first rendering on purpose. `#ico-size-template` is removed from `src/index.html`. Cells are per-file pipeline output, not stable chrome, so `src/js/viewer/icoCells.js` builds them dynamically. Both viewers import the one factory instead of cloning a static template.

**Definitions.** IcoSize is `{ width, height, data_url }`, sorted largest to smallest, same order as the current strip in `src-tauri/src/ico.rs:71-74`. Total row size is `sum(widths)` by `max(height)`. Row height equals tallest size, small sizes center vertically, tiny sizes stay tiny. Legacy view means the single image viewport owned by `src/js/viewer/viewerRender.js`. Strip means the vertical list owned by `src/js/viewer/manhwaStrip.js`, element `#manhwa-strip` in `src/index.html:336-340`. Shared pattern in both modes:

```
.ico-container, display flex, align-items center
  .ico-size, one per ICO size
    .ico-size-backdrop plus img
```

In manhwa, `div.manhwa-slot` holds `div.ico-container`, which holds one `div.ico-size` per size. In legacy, the viewer row holds the same `div.ico-container` with the same inner cells. For ICO slots the outer `manhwa-slot-backdrop` stays hidden and only inner `ico-size-backdrop` cells paint. Interior direction is left to right in both modes. Backdrop hue comes from `computeSlotHue` in `src/js/services/keybindDomain.js:32-47`, mirrored angle from `getGrillAngle` in `src/js/services/viewerMath.js:637-643`, same as `src/js/viewer/manhwaStrip.js:706-711`.

## Touched files

Ownership stays as listed in `.agents/architecture-state.md`. New work extends the layering.

- `src-tauri/src/ico.rs`. Owns ICO dir parse plus per-frame decode plus PNG encode.
- `src-tauri/src/models.rs`. Owns the IPC contract, new `IcoSize` struct lives here.
- `src-tauri/src/commands/archives.rs`. Owns `get_ico_frames` at line 9 and `get_archive_ico_frames` at line 64, shape change only.
- `src-tauri/src/lib.rs`. Owns command registration at lines 112-113, names unchanged.
- `src/js/fsUtils.js`. Owns `isIco` at line 157, `buildArchiveEntrySrc` at line 264, `buildFileSrc` at line 275, `neighborEntries` at line 352. New ICO source helpers live here.
- `src/js/core.js`. Owns state `src` at lines 223 and 227, consumes the new helpers.
- `src/js/viewer/viewerRender.js`. Owns the legacy image pool plus fit math, lines 17-40, 586, 757-764, 815-831. Owns ICO row mount at lines 466-517 plus `--ico-total-w` and `--ico-total-h` sizing props at lines 510-511, cleared at lines 471-472.
- `src/js/viewer/icoCells.js`. Owns `.ico-container` and `.ico-size` DOM factory for legacy and strip rows. Both viewers import it, neither clones static markup.
- `src/js/viewer/viewerPipelines.js`. Owns single-image WebGL plus the ICO composite cache at lines 191-265. ICO WebGL transform at lines 436-515 and ICO Lanczos branch at lines 526-580. `setSource` ICO path at lines 2237-2249 and `clear` at lines 2283-2290. Column ICO skip stays as DOM-only fallback.
- `src/js/viewer/manhwaStrip.js`. Owns `#manhwa-strip`, slots, anchors, layout. Owns `_icoCache` at line 334, `_resolveIco` at line 338, `_createSlotNode` at line 630, `_acquireSlotNode` at line 639, `_claimSlot` at line 1429, prefetch at line 1259, mount at line 1539, decode at line 790.
- `src/index.html`. Owns placeholders at lines 336-340 and 356-368. `#viewer-ico-row` stays as the mount point. No `#ico-size-template`, cells build dynamically in `icoCells.js`.
- `src/css/main.css`. Owns slot rules at lines 1674-1767 and grill rules at lines 2387-2426. New `.ico-container` rules go here. Owns ICO wrapper sizing at lines 2441-2442 through `--ico-total-w` and `--ico-total-h`, plus `.ico-size > img` in the filtered hide rule at line 2301 so backdrops stay visible.
- `src/css/global.css`. Owns grill tokens at lines 26-28 and 78-85, read only.
- `src/js/main/main.js`. Owns `grill-active` toggle at lines 210-212 and 231-240, read only.
- `src-tauri/src/commands/animation.rs`. Owns `skip_for_width_scan` at lines 63-67, read only, stays skipped.

## Blast radius

The risk centers on the IPC shape replacement plus the two WebGL expansions.

- IPC shape. Old callers expect a single data URL string. After replacement every `get_ico_frames` and `get_archive_ico_frames` caller must read an array. A missed caller shows a broken image or a type error at the invoke boundary. Grep both command names plus `isIco` before each slice lands.
- Fit math. Legacy `_syncActiveImage` and `applyFitMode` in `viewerRender.js:363-390,815-831` use whole spritesheet `naturalWidth` and `naturalHeight` today. After the change fit uses total dims while each cell keeps its own dims. A wrong total breaks zoom to fit for ICO only.
- Shared filter state. ICO rows share one composite texture per file, keyed as `ico:<mode>|<archivePath>|<path>` in `_singleTextureCache`. A wrong key leaks one file into another. Single texture per file means cells cannot bleed into each other. Wrapper sizing through `--ico-total-w` and `--ico-total-h` keeps the Lanczos canvas aligned with the DOM row.
- Column width. ICO totals equal old spritesheet dims, so `_trackedMaxWidth` exclusion at `manhwaStrip.js:62,91-105,821-836` keeps working. If inner cells feed width tracking, the column widens on small icons. Prove by opening a mixed folder and scrolling past the ICO.
- Probes and scenarios. `e2e/replay-diagnostics/probes/viewerPipelineProbe.js` matches viewer classes and ids. New `.ico-container` and `.ico-size` ids must not break its selectors. Saved scenarios dispatch action ids, unchanged here. Prove with `npm test` plus one viewer e2e spec.

Runnable checks per slice. `node --check` on each touched JS file. `cargo check --tests --manifest-path src-tauri/Cargo.toml` when Rust changes. `npm run mocha` for unit plus contract tests. One e2e viewer spec for slices that touch paint. Full `cargo test` only at final signoff. Use `.agents/skills/blast-radius/SKILL.md` to pick the nearest test.

## Slice 1. Backend returns parts

**Status:** `[x]` Done. `cargo check --tests` clean.

Goal is new IPC shape with same decode order, no frontend change yet so this slice does not land alone.

- [x] In `src-tauri/src/ico.rs:71-104`, split parse from encode so each deduped frame encodes to its own PNG data URL. Keep sort plus dedup at lines 71-74. Keep single frame fallback at lines 64-69 as a one element vec.
- [x] In `src-tauri/src/models.rs:149`, add `IcoSize` with `width`, `height`, `data_url`.
- [x] In `src-tauri/src/commands/archives.rs:9-12`, change `get_ico_frames` to return `Vec<IcoSize>`.
- [x] In `src-tauri/src/commands/archives.rs:64-75`, change `get_archive_ico_frames` to return `Vec<IcoSize>`.
- [x] Accept when `cargo check --tests --manifest-path src-tauri/Cargo.toml` passes and a disk ICO plus an archive ICO each return N entries largest first through both commands.

Validation note. One owner per concern. Decode stays in `ico.rs`, commands adapt only, contract lives in `models.rs`.

## Slice 2. Frontend source helpers

**Status:** `[x]` Done. `node --check` clean, mocha green.

Goal is array sources with all non ICO paths untouched.

- [x] In `src/js/fsUtils.js:264-288`, add `getIcoSources` plus `getArchiveIcoSources` returning the array with dims. Keep `buildFileSrc` and `buildArchiveEntrySrc` behavior for non ICO files.
- [x] In `src/js/core.js:223,227`, route ICO entries through the new helpers so state carries the array for ICO and a string otherwise.
- [x] In `src/js/viewer/viewerRender.js:586`, route the reload path through the same helper.
- [x] In `src/js/main/metadataBadge.js:74`, use the first array element for cover art.
- [x] In `src/js/fsUtils.js:352-365`, keep the disk ICO `null` neighbor exclusion, no N preload.
- [x] Accept when disk ICO, archive ICO, and cover badge load through helpers, `node --check` passes on touched files, and non ICO images behave as before.

Validation note. Shared helpers over inlined repeats. Callers derive from one helper instead of copying invoke blocks.

## Slice 3. Shared DOM plus style placeholders

**Status:** `[x]` Done. Row hidden until `data-ico` is set, no behavior change. Template later removed per deviation, `#viewer-ico-row` stays.

Goal is static markup plus paint rules with no logic change yet.

- [x] In `src/index.html:356-368`, add a static `#viewer-ico-row` placeholder next to `#viewer-img-wrapper`. In `src/index.html:336-340`, confirm no new strip root is needed since slots already exist.
- [x] In `src/css/main.css:1725-1754,2387-2426`, add `.ico-container` as flex row centered with align center, `.ico-size` as relative centered box sized from IPC dims, `.ico-size-backdrop` copying slot backdrop paint at 0.35 opacity with z-index 0 under img z-index 1. Consume grill tokens from `src/css/global.css:26-28,78-85`, no new tokens.
- [x] Accept when markup exists on first paint, ICO rows render unstyled boxes with no JS errors, and `grill-active` plus `data-ready` gating matches `main.css:1752-1754` behavior.
- [x] In `src/js/viewer/icoCells.js`, move cell structure out of static markup into one dynamic factory. `src/index.html` keeps `#viewer-ico-row` only. Both viewers import `createIcoContainer`, `createIcoCell`, and `mirroredGrillAngle`.

Validation note. HTML first rendering plus CSS source of truth. No `createElement` for stable chrome, no inline visual values from JS. The factory breaks the first half on purpose per the deviation rule, CSS truth still holds since JS writes only custom properties plus `src`, `classList`, and `data-*`.

## Slice 4. Legacy row render plus fit

**Status:** `[x]` Done. Runtime items 1, 2, and 4 pass in legacy. Fit repeat fix user-confirmed 2026-10-08.

Goal is same look as today with separate boxes and backdrops.

- [x] In `src/js/viewer/viewerRender.js:17-40,735-831`, build one `.ico-container` with N `.ico-size` cells for ICO state through `src/js/viewer/icoCells.js`. Fit plus zoom transform the row as one unit using total dims. Each cell keeps its own width and height from IPC.
- [x] In `src/js/viewer/viewerRender.js:757-764`, fix the dead `.ico` suffix check for array src so decode gating follows the same path as other raster images.
- [x] In `src/js/viewer/viewerRender.js:522-529,707-720`, gate ICO same-row refit on `fitModeGen` and skip `Core.setImageDimensions` when total dims match. Fit presses apply once and later notifies hold pan and zoom.
- [x] Accept when a 4 size ICO shows left to right largest first, vertically centered, each cell with its own backdrop tint and mirrored angle, fit modes frame the whole row, and tiny sizes stay tiny. Accept when a fit press on an ICO row applies once with no delayed re-apply.

Validation note. The file that paints the surface owns it. Bootstrap and state machine stay thin.

## Slice 5. Legacy WebGL per cell

**Status:** `[x]` Done. User-confirmed 2026-10-08 for filters plus Lanczos alignment fix.

Goal is filter parity for the whole row through one composite.

- [x] In `src/js/viewer/viewerPipelines.js:191-265`, build one composite canvas per ICO file in DOM order with vertical centering, cached by file key with promise dedup. Keep SVG bypass untouched.
- [x] In `src/js/viewer/viewerPipelines.js:332-515`, run the composite through the existing single image WebGL path with one `ico:<key>` texture entry. Set `data-render-ready` plus `data-filter` on paint. Bilinear with no filter keeps the DOM row.
- [x] In `src/js/viewer/viewerPipelines.js:526-580`, run the composite data URL through the existing Lanczos CPU pipeline with total dims. Keep the 80ms debounce plus generation guards.
- [x] In `src/js/viewer/viewerPipelines.js:2237-2290`, route ICO `setSource` through `_applyScaling`, `_scheduleTransform`, and `_triggerRender`. Clear the composite in `clear`.
- [x] In `src/js/viewer/viewerRender.js:466-517`, size the wrapper from total dims with `--ico-total-w` and `--ico-total-h`. In `src/css/main.css:2441-2442`, apply that size when `data-ico` is set. In `src/css/main.css:2301`, hide only `.ico-size > img` when the viewport has an active filter so per cell backdrops stay up. This fixed the Lanczos double render where the canvas sat offset at bottom left of a zero size wrapper.
- [x] Accept when bilinear, lanczos, and each active filter paint every cell, toggling filters does not leak one file into another, and the Lanczos layer overlaps the DOM row with no second copy. User confirmed filters plus Lanczos paint in place.

Validation note. The file that paints the surface owns it. No service changes, no column changes. CSS truth holds since JS writes only custom props plus `src`, `classList`, and `data-*`.

## Slice 6. Manhwa slot interior

**Status:** `[x]` Done. Runtime item 3 passes.

Goal is one slot per file with inner backdrops.

- [x] In `src/js/viewer/manhwaStrip.js:334-361`, store arrays in `_icoCache` keyed as today.
- [x] In `src/js/viewer/manhwaStrip.js:630-657,1429-1466`, build `div.manhwa-slot` holding `div.ico-container` holding N `.ico-size` cells through `src/js/viewer/icoCells.js` for ICO items. Hide the outer `manhwa-slot-backdrop` for ICO slots. Set per-cell hue plus mirrored angle on acquire, clear on release at lines 659-675.
- [x] In `src/js/viewer/manhwaStrip.js:790-884,1259-1278,1539-1659`, update decode, prefetch, and mount queue for arrays with the same in-flight guards. Keep width exclusion and `_fitRefreshPending` behavior for ICO.
- [x] Accept when an ICO in the strip stays one row, interior matches legacy order and centering, each cell shows its own backdrop, column width and anchors behave as before, and scroll past the ICO shows no kick.

Validation note. Slot owner stays `manhwaStrip.js`. No canvas and no WebGL code in this slice.

## Slice 7. Column WebGL per cell

**Status:** `[x]` Done as DOM-only fallback per the deviation rule. ICO slots skip the column composite and stay visible as DOM rows under filters.

Goal is filtered column parity for ICO rows.

- [x] In `src/js/viewer/viewerPipelines.js:1703-1706,1907-1960`, skip ICO slots in the column draw list so no stretched single-cell quad paints over the DOM row. Keep sampler rules per cell and SVG bypass at lines 1180-1182 untouched.
- [x] Accept when a filtered column leaves every ICO row to its DOM cells with no blank quads and no texture bleed. Full per-cell filtered paint stays follow-up work with slice 5.

Validation note. Same fallback rule as slice 5. Record any fallback here.

## Slice 8. Verification and handoff

**Status:** `[~]` Partial. Static checks green, runtime items 1-4 plus 6 pass, item 5 now passes per user 2026-10-08 for legacy filters plus Lanczos. Fit repeat fix still in. One viewer e2e spec still open.

Goal is proof before signoff, no docs edits in this slice.

- [x] Run `node --check` on each touched JS file, `cargo check --tests --manifest-path src-tauri/Cargo.toml`, `npm test`, plus `npm run mocha`. `npm run mocha` passes with 305 tests after the fit repeat fix.
- [ ] Run one viewer e2e spec through `npm run e2e -- --spec <file>`, de-elevated rerun only if it reports an elevated shell.
- [x] Confirm `e2e/replay-diagnostics/probes/viewerPipelineProbe.js` selectors still match and `e2e/scenarios/` contracts still dispatch.
- [x] Manual pass: disk ICO, archive ICO, transparent on and off, manhwa scroll plus resize. Legacy filters plus Lanczos pass per user 2026-10-08. Restart persistence plus one viewer e2e spec stay open.
- [ ] Accept when all checks pass and the runtime list is handed to the user for signoff per `.agents/skills/verify-implementation/SKILL.md`. Do not declare done without explicit user approval.
