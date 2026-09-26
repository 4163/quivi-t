# Manhwa mode plan

Validation: this plan was compared against `.agents/skills/validate-changes/SKILL.md` before presenting. It proposes no code changes itself, so the check covered plan shape and architecture fit. Details sit at the bottom.

## Locked definitions

These hold for the whole slice set. A cold agent picks up from a dirty tree with these alone. Any change to this section needs user signoff first.

- Manhwa view means one vertical column inside `#manhwa-strip`. It appends every image in the current `Core` list top down at natural 1:1 size, acting as one vertically long raster image. It never replaces the list.
- Items are never stretched or shrunk. Column width fits the widest item times zoom, narrower items center horizontally. Fit modes do not apply in the strip.
- Zoom scales the whole column through the existing `viewportState` path, cursor-anchored, exactly like single image zoom. Keyboard, wheel, and hold-key zoom work unchanged.
- Pan moves over the column through the existing transform path. No native scrollbar. Ends clamp through the existing clamp with no wrap.
- The anchor is the item containing the viewport center. The anchor is the primary highlight and drives `Core.selectIndex`, the statusbar, and the file panel highlight. Every other visible item gets a secondary in-view highlight that is highlight-only. The visible set is derived view data owned by the strip, recomputed on settle, and never enters `Core` state.
- Loading is windowed off the visible column range plus a buffer. Placeholders hold layout for unloaded items. Slots reserve estimated heights before decode and correct after without jumping the view.
- The single-image pipeline (`viewerRender.js`, `viewerPipelines.js`) is guarded off when the strip is active. The strip owns its own image loading. CSS hides the single-image DOM, and JS guards prevent decode, pool swap, bridge, and filter churn.
- Ends clamp. The strip never wraps to the start, never opens `..`, and never opens a sibling container on anchor step. `Backspace`, `Ctrl+X`, and `Ctrl+Z` keep their current behavior.
- The bridge stays unused in the strip. Enter cancels pending parks. Exit returns to the single image path with the anchor as index.
- Video rows never play in the strip. Each video entry renders as a fixed height placeholder so list indexes stay aligned.
- V1 treats filters, Lanczos, and the grill as strip-wide concerns by turning per-image pipelines off. One continuous grill backdrop sits behind the strip. A later slice can composite the strip to a single canvas. No per-image filter pass in v1.
- Spread and manhwa never run together. Entering one leaves the other.
- Anchor sync uses `Core.selectIndex` only. Anchor changes never call `Core.jumpToIndex` and never activate dirs or archives.
- State key is `manhwaEnabled` on the state machine plus `manhwa_enabled` under `config.frontend_data`. Default is off. It persists across restart in both roaming and portable layouts.

## Deviation rules

- Keep slices in order. Do not start windowing before the toggle and container land.
- Keep changes surgical. Do not refactor `viewerRender.js`, `viewerPipelines.js`, or `core.js` beyond what the active checklist item names.
- Reuse `FsUtils` src builders and the archive blob path. No second copy of URL building or thumbnail fetching.
- If a checklist item needs a new shared helper, put it where the architecture map says it belongs and note the path in the item.
- If any locked definition blocks progress, stop and ask. Do not silently reinterpret it.

## Slice 1. Toggle, menu, state

Goal: user can turn the mode on and off from the View menu. Nothing visual yet beyond the checkmark.

- [x] Add `manhwaEnabled` default false plus `manhwa_enabled` in `frontend_data` in `src/js/core.js:52-132`. Accept: fresh state reports off, persisted config round-trips.
- [x] Add `setManhwaMode` and `toggleManhwaMode` next to `setSpreadStep` in `src/js/core.js:422-473`. Persist on change, notify listeners, clear spread when turning on. Accept: toggling notifies once and spread ends up off.
- [x] Register `cmd-toggle-manhwa` in the View section of `src/js/services/actions.js:45-67`. Category View, empty default binds so Options picks it up as configurable. Accept: dispatch flips state, keybinds merge keeps user binds.
- [x] Insert the menu row directly under Fullscreen in `src/index.html:96`. Keep the existing order otherwise. Accept: View shows Fullscreen, then Manhwa mode, then Opaque Canvas.
- [x] Sync the checkmark in `src/js/menubar.js:656-717` from `manhwaEnabled`. Accept: checkmark follows state after toggle and after restart.
- [x] Wire the row through the existing fan-out in `src/js/main/main.js:114-127` with no bespoke click handler. Accept: click dispatches through `ACTION_REGISTRY`, no direct `Core` call from menu code.

## Slice 2. Strip container and layout

Goal: a strip container coexists with the single image path. Single image behavior stays untouched when the mode is off.

- [x] Add `#manhwa-strip` inside `#viewport` in `src/index.html:201-306`. Declare it as static markup, hidden by default with a class on `#viewport`. Accept: markup exists before any JS runs, no runtime `createElement` for the container.
- [ ] Add layout rules in `src/css/main.css` near `#viewport` at `src/css/main.css:1315-1331`. Strip gets `overflow: hidden` (no scrollbar), items stack top down at natural size and center horizontally. Accept: the widest image sets the column width, narrow images center, old wrapper stays hidden when the mode class is set.
- [x] Keep visual tokens in `src/css/global.css`. No new color or spacing tokens in the page sheet. Accept: page sheet consumes tokens only.
- [ ] Size the column from natural item dimensions in a pure helper, likely `src/js/services/viewerMath.js:8-308`. Column width fits the widest known item times zoom, per-item offsets derive from heights at that width. Accept: helper has mocha coverage for offsets, widest width, and zoom scaling.
- [x] Hide `#viewer-img-wrapper`, `#viewer-bridge-layer`, `#viewer-lanczos-canvas`, and `#viewer-filter-canvas` in `src/index.html:253-270` while the strip is active. Use classes only. Accept: no inline style writes from JS.
- [x] Hide the audio pill owned by `src/js/viewer/viewerAudio.js:212-276` while the strip is active. Accept: no audio controls visible even when the anchor is a video placeholder.

## Slice 3. Column layout and loader

Goal: one continuous column at 1:1 with loading windowed off the visible range. Anything far outside unloads, placeholders hold layout.

- [x] Build the image index list from `Core.getState().list` in `src/js/core.js:318-320`, keeping only entries where `FsUtils.isImageEntry` passes in `src/js/fsUtils.js:158-160`. Keep original list indexes alongside with a reverse map (`_listToImgIdx`) so anchor sync stays aligned. Accept: `..`, dirs, and archives never create strip items.
- [x] Reuse `buildFileSrc`, `buildArchiveEntrySrc`, and the archive blob path in `src/js/fsUtils.js:260-292` for strip item URLs. Accept: disk and archive items load through the same builders, no duplicated URL logic.
- [ ] Compute column offsets from per-item heights at current zoom in `src/js/viewer/manhwaStrip.js`. Rebuild on decode and on zoom, adjusting the pan offset so the anchor item holds still. Accept: decode and zoom never jump the view.
- [ ] Size the window from the visible column range plus a buffer of named height. Mount the window, evict outside into the bounded `STRIP_POOL_CAP` pool. Accept: large archives never grow node count past cap plus window.
- [x] Guard the single-image pipeline. `viewerRender.js` and `viewerPipelines.js` state handlers bail early when `state.manhwaEnabled` is set. Accept: no decode, pool swap, bridge, or filter churn on hidden elements.
- [ ] Reserve layout height for unloaded items so re-anchor does not shift layout on first decode. Carried forward: decode caching was removed as dead code, first-visit pop-in stays visible until this lands. Accept: stepping through a chapter shows no layout jump on first decode.
- [x] Reuse the thumbnail blob shortcut in `src/js/viewer/viewerRender.js:647-651` for archive items already thumbnailed. Accept: archive strip reuses cached blobs instead of refetching.

## Slice 4. Anchor sync

Goal: file list, statusbar, and badge follow the most visible image.

- [ ] Anchor is the item containing the viewport center, synced via `Core.selectIndex` on settle. Accept: selection changes only when the center crosses an item boundary.
- [x] Confirm `selectIndex` stays preview only. It must never open dirs or archives the way `jumpToIndex` does in `src/js/core.js:542-544`. Accept: stepping past a dir entry never navigates away.
- [ ] Let `renderFilePanel` in `src/js/filepanel/filePanel.js:2200-2329` show the anchor with the existing selected style through `updateSelection` at `src/js/filepanel/filePanel.js:2118-2158`, plus a secondary in-view style for the visible set read from the strip. Membership is any-pixel-visible. Accept: primary scrolls minimally, secondary marks orientation only, favorites and library highlights stay consistent.
- [ ] Compute the visible set in the strip from column offsets on settle and expose it for the panel. Throttle to settle, never per frame. Accept: panning causes no highlight churn mid-gesture.
- [x] Update `Statusbar.update` and `setImage` in `src/js/menubar/statusbar.js:130-232` from the anchor entry. Filename, index, and dims show the anchor. Accept: statusbar matches the anchor image.
- [ ] Panel clicks while the strip is active pan the column to center the matching item via `_listToImgIdx`, and the center anchor follows. Only `Enter` or double click on a dir or archive opens it through the existing `jumpToIndex` path at `src/js/filepanel/filePanel.js:1598-1619`. Accept: single click centers the item, container open still works.
- [x] Panel keyboard in `src/js/filepanel/filePanel.js:2553-2646` keeps working. Arrows move the panel highlight and re-anchor the strip to match. Accept: focus stays where the user put it.

## Slice 5. Keyboard, wheel, and gestures

Goal: the strip pans and zooms exactly like a single image. No strip-specific input code beyond item jumps.

- [ ] Revert the `stepAnchor` pan routing in `src/js/services/actions.js`. Pan keys call `Viewer.panBy` as in single mode, which moves over the column. Accept: arrows, WASD, and wheel move pixels, selection follows through the center anchor.
- [ ] Re-enable `Viewer` zoom and pan plus gesture drag in the strip in `src/js/viewer/viewer.js:48-67` and `src/js/viewer/viewerGestures.js:151-246`. Keep rotate and flip guarded off. Accept: `C`, `Z`, and `Ctrl`+wheel zoom cursor-anchored, drag pans, rotate and flip do nothing.
- [ ] Route `cmd-next` and `cmd-prev` in `src/js/services/actions.js:9-22` to pan to the adjacent item in the strip. Accept: `Shift`+arrows move one image, no wrap, no `..` activation.
- [ ] Route Home and End to the column top and bottom and PageUp and PageDown to a viewport-height pan in `src/js/main/main.js`. Accept: extremes clamp through the existing clamp, no wrap.
- [ ] Update `mocha/actions.test.js` to the reverted routing. Accept: `npm run mocha` passes.
- [ ] Keep history, parent, and sibling commands working. `cmd-history-back`, `cmd-history-forward`, `cmd-parent`, `cmd-open-next-container`, and `cmd-open-prev-container` in `src/js/services/actions.js:23-43` behave as today. Accept: leaving the strip via history restores single image state cleanly.

## Slice 6. Zoom, grill, filters, and scaling

Goal: V1 looks correct with plain rendering. Retro seams never appear because per-image effects stay off.

- [ ] Apply zoom through `viewportState` over the column dims. Rescale widths and heights together, hold the anchor item stable. Accept: zoom in and out keeps the anchor roughly stable.
- [ ] Render one continuous grill backdrop behind the strip instead of per-image `#img-grill` handling from `src/js/main/main.js:168-179`. Accept: gaps between pages show one unbroken backdrop.
- [ ] Force per-image Lanczos and WebGL filters off in the strip. Bypass `_applyScaling` in `src/js/viewer/viewerPipelines.js:105-192` and the live pump in `src/js/viewer/viewerPipelines.js:315-670`. Plain `img` scaling plus CSS `image-rendering` applies. Accept: `none` maps to pixelated, lanczos selection has no effect in the strip.
- [ ] Disable the filter, Lanczos, and fit menu rows while the strip is active, with a note that they apply to single image view. The strip is always 1:1 plus zoom. Keep Opaque Canvas available since it now controls the strip backdrop. Accept: user cannot enter a half filtered state.
- [ ] Document the deferred composite as a follow-up. Single canvas compositing across N decoded bitmaps stays out of V1 for memory reasons. Accept: plan names it explicitly so nobody builds it by accident here.

## Slice 7. Content edge cases

Goal: archives, odd files, and short lists behave.

- [ ] Show the password overlay from `src/index.html:219-232` when `archiveEncryption` in `src/js/core.js:78` is set. Render no strip items until unlock. Accept: locked archives show the prompt, not an empty strip.
- [ ] Render video entries from `src/js/fsUtils.js:156-160` as fixed height placeholders with a short label. No `video` element, no dual pool from `src/js/viewer/viewerRender.js:68-71`, no audio probe. Accept: mp4 keeps its list position, never plays.
- [ ] Cap animated formats. Decoded GIF, WebP, APNG, and AVIF items animate only while inside the window, and pause or unload outside it to bound the `ImageDecoder` cost from `src/js/viewer/viewerPipelines.js:521-669`. Accept: a chapter of GIFs does not run N decoders at once.
- [ ] Treat ICO entries through the existing spritesheet path only as single images. Do not expand per-size rows in the strip in V1. Accept: ICO shows one row per file.
- [ ] Handle short lists. Fewer images than one viewport renders fully with no eviction and no empty window logic. Accept: single image strip works.
- [ ] Handle broken or zero-byte entries with the same error tile pattern as `src/js/viewer/viewerRender.js:699`. Keep the row so indexes stay aligned. Accept: one bad file does not shift later anchors.
- [ ] Keep SVG sanitization on the `urlLoader.js` import path. Strip rendering adds no new SVG handling. Accept: no unsanitized SVG reaches the strip.
- [ ] Keep drag and drop, empty state, and `drop-overlay` in `src/index.html:206-216` working. Empty strip shows the same prompt as today. Accept: no-image behavior unchanged.

## Slice 8. Config, windows, and tests

Goal: the mode survives restart and leaves no trace in diagnostics contracts.

- [ ] Persist `manhwa_enabled` through the same `frontend_data` path as spread keys in `src/js/core.js:119-131`. Verify roaming layout and portable single file layout plus `QUIVIT_CONFIG_DIR` overrides. Accept: toggle survives restart in both layouts.
- [ ] Confirm the mode is main window only. Options and metadata windows gain nothing. Window sizes in `src-tauri/src/windows.rs` stay untouched. Accept: no Rust changes in V1.
- [ ] Add mocha coverage outside `src/` for column offsets, window range math, and center anchor picking. Follow the existing files in `mocha/`. Accept: `npm run mocha` passes.
- [ ] Add one e2e spec for enter, scroll anchor sync, end clamp, and exit. Keep probes and recorder contracts intact per `mocha/diagnosticsContract.test.js`. Accept: `npm run e2e` passes for the new spec, no probe selector breakage.
- [ ] Run `node --check` on touched JS and `cargo check --tests --manifest-path src-tauri/Cargo.toml` if any Rust was touched. V1 expects no Rust touch. Accept: static checks clean before handoff.
- [ ] Produce a short manual runtime list at handoff. Cover enter and exit, anchor stepping, zoom relayout, archive chapter, locked archive, video placeholder, panel click sync, and restart persistence. Accept: each item names where to go, what to do, and what to see.

## Validation note

Compared this plan against `.agents/skills/validate-changes/SKILL.md`. No diff exists yet so the check was structural. Module ownership stays intact. State machine keeps DOM out. UI keeps subscribing instead of reaching in. New DOM was declared in HTML first. New CSS tokens were not invented. JS avoids inline visual writes. Rust surface stays stable with no IPC or protocol change. The one deliberate tension is filters and Lanczos staying off in V1, which the locked definitions call out so it reads as a scoped cut and not drift. Stale code risk sits in bridge and pipeline bypasses, so slices 2 and 6 hide rather than delete those paths. Column rewrite: index-step windowing and `stepAnchor` pan routing are superseded. The strip is one virtual image under `viewportState`. Slice 5 tree changes predate this rewrite and get reverted where the slices say so.
