# Viewer pipeline analysis

Validation comparison performed against `.agents/skills/validate-changes/SKILL.md`. This doc is analysis only. It changes no code, no contracts, no ownership.

## Definitions lock

- Viewer is single image mode. Strip is manhwa continuous scroll mode.
- Hold pan is Space or mouse drag held down through `viewerGestures.js`. Discrete pan is one keyboard or wheel step through `actions.js` to `Viewer.panBy`.
- Navigation is any index or container change. That includes next, previous, file panel click, panel keyboard nav, Home, End, PageUp, PageDown, parent, sibling, refresh, history, and manhwa toggle.
- Bridge is keep old pixels up until new pixels decode. Legacy viewer has it. Strip handles bridging case-by-case per edge case.
- Deviation rule. If a fix changes who owns a surface, stop and update this doc first. Do not split one owner across sibling files.

## Pipeline map

- `src/js/viewer/viewer.js:1-80` is the facade. It owns viewport state plus renderer, pipelines, gestures, strip wiring.
- `src/js/services/viewerMath.js:180-489` owns transform math. It holds scale, tx, ty, rotation, flip, fit, spread. `panTo` at 344 and `panBy` at 336 both call clamp plus notify. `getTransform` at 449 emits full float px. No rounding exists on this path.
- `src/js/viewer/viewerRender.js:6-39,337-466,747-756` owns the 4 node single image pool, `PRELOAD_HALF=1`, 45 ms target debounce, 2x rAF bridge retire. It paints transform sync on notify. It returns early in manhwa mode at 508-513.
- `src/js/viewer/viewerPipelines.js:32-273,315-670,697-702` owns `#viewer-lanczos-canvas` and `#viewer-filter-canvas`. Base image moves sync. WebGL defers to rAF. Lanczos defers 80 ms. Comment at 696 says pan path is render, not rebuild.
- `src/js/viewer/manhwaStrip.js:17-39,250-304,408-600` owns `#manhwa-strip`. Strict item-count buffer `STRIP_BEHIND_COUNT=1` / `STRIP_AHEAD_COUNT=1` around the anchor, unioned with the visible range, evict outside. One-deep off-DOM prefetch ring with `decode()` gate, lead-edge Rust zip warm of 2 past the window, parallel unlocked ZIP extraction. Estimated slot 1200 by 800. No native scroll is used. `#viewport` has `overflow:hidden`. Pan writes state and moves the strip with transform. Mount and evict run inside state subscribe at `manhwaStrip.js:1221-1238`.
- `src/js/core.js:93-119,485-502,575-597` owns index, list, mode, manhwa flag, fit, spread, view mode. `selectIndex` and `navigate` notify all subscribers.
- `src/js/services/actions.js:9-42,138-140,155-198` plus `src/js/shortcuts.js:204-325,465-493` own dispatch. Next and previous call `pageStrip` or `navigateManhwa` in strip mode, `Core.navigate` otherwise. Pan actions call `Viewer.panBy`. Toggle manhwa calls `Core.toggleManhwaMode`.
- `src/js/filepanel/filePanel.js:1921-2214,2268-2374,2422-2433,2446` owns list paint. It toggles `li.selected` and `in-view`. It subscribes with `Core.onStateChange`. Scroll over the panel paints sync.
- `src/index.html:267,273,276` defines filter canvases and `#viewer-bridge-layer`.
- `src/css/main.css:1419-1461,1601-1612,1979-2043,2103-2112` defines viewport overflow, strip show rules, bridge frozen transform rules, filter opacity rules. Strip active hides `#viewer-img-wrapper` and `#viewer-bridge-layer`.

## Issue 1. Hold pan jitters as buffer images decode and layout corrects

Prior analysis blamed cursor poll versus mousemove. That was wrong. Your read fits the code. Buffer decodes rewrite layout mid drag and the anchor correction fights the live pan.

How the shift happens.

- Slots start at 1200 px estimated height in `manhwaStrip.js:152-194`. Real pages run 2000 to 5000 px tall. The window math in `computeColumnOffsets` at `viewerMath.js:38-74` uses those estimates until decode.
- When a buffer item decodes, `_onItemDecoded` at `manhwaStrip.js:264-321` writes real width and height into the item and slot, then calls `_updateLayout` with the current anchor plus old anchor top.
- `_updateLayout` at `manhwaStrip.js:206-262` rebuilds every offset, then pans to hold the anchor with `targetTy = oldTy + deltaTotalH * scale / 2 - deltaAnchorTop * scale` at 252-255. It writes the strip transform at 258.
- That `panTo` runs on top of the live hold pan from `viewerGestures.js:239-272` to `viewerMath.js:344-350`. The user moves ty one way. The correction moves ty back to keep the old anchor fixed on screen. The visible image kicks up or down by the correction delta.
- Direction tracks scroll direction because it depends on whether the decoded item sits above or below the anchor. Panning down decodes items below first. Panning up decodes items above first. The sign of `deltaAnchorTop` flips with that.
- Prefetch makes it worse. `_prefetchAhead` at `manhwaStrip.js:501-548` decodes ahead off DOM and calls the same `_onItemDecoded` path. So layout can shift even before the new slot mounts. Mount at `manhwaStrip.js:401-455` then appends into an already moved column.
- Anchor can be stale mid hold. `_updateWindow` at `manhwaStrip.js:461-491` keeps the old anchor when only decode changed layout and ty did not move that tick. During a fast hold the next mousemove has already moved ty, but the pending decode still corrects against the old anchor top. The correction holds the wrong item still for one frame.
- Width rewrite adds a second kick. First raster decode rewrites all undecided slot widths at `manhwaStrip.js:296-309`. That changes `widestWidth` and `setDimensions` at `manhwaStrip.js:217-220`, which feeds clamp in `viewerMath.js:214-228`. Small tx and clamp changes read as extra jitter during the same drag.

Why discrete pan looks clean. One key step moves, one correction settles, then quiet. No overlap. Hold keeps the pointer moving while decodes land, so every decode lands mid drag and stacks. Wheel looks cleaner for the same reason. Notches are sparse, so corrections settle between steps.

Status: partly fixed in code, needs a confirm pass. End-pin re-pins in `_updateLayout` now gate on 150 ms pan quiet via `_lastPanAt`, so a decode landing mid-scroll rebuilds offsets without snapping `ty`. Delta-anchor correction is unchanged. Confirm by holding pan through fresh decodes and watching for kicks.

Confirm by logging `imgIdx`, `oldH`, `newH`, `anchorImgIdx`, `oldAnchorTop`, `newAnchorTop`, `oldTy`, `targetTy` around `_onItemDecoded` during a hold. Expect targetTy jumps aligned with decode events, sign correlated with pan direction, no jump when all items in window are already decoded.

## Issue 2. Buffer pop-in on scroll

Status: resolved and user-confirmed in the running app.

As-built behavior in `manhwaStrip.js:408-600`. The window is anchor minus 1 to anchor plus 1, unioned with the visible range, computed from item indexes so height estimates never misalign it. Everything outside unmounts on every update. Items outside the visible range mount only from decoded prefetched nodes. Prefetch runs from the first build, covers non-visible window items first with an off-DOM `decode()` gate, and retains one ready node. Backend warms 2 entries past the window from the strip lead edge. Protocol serves plain zips through an unlocked parallel extraction path with short-lock cache check plus insert. First-build backend warm waits one update to protect cold-open CPU.

## Issue 4. File list stays static during key hold

Status: resolved and user-confirmed in the running app.

Paint path works. `filePanel.js:2035,2140-2214,2825-2829` paints selected and in view sync. Panel subscribes at 2446. Scroll over panel paints sync at 2422-2433.

Hold pan never writes `Core` until settle. Path is `shortcuts.js:311-320` to `main.js:132-135 Viewer.panBy` to `viewerMath.js:336-342 notify` to `manhwaStrip.js:1066-1078`, which calls `_updateWindow` plus `_scheduleSettle` at 551-557. Settle waits 100 ms quiet, then calls `Core.selectIndex` at 563-597 only if center anchor changed.

OS repeat fires about every 30 to 50 ms. Each repeat resets the 100 ms timer. Settle starves until key up. Single taps update. Sparse wheel notches update. Mouse scroll over panel updates. Non strip `Core.navigate` at `core.js:524-566` updates because it notifies at once.

Secondary trap is `filePanel.js:2627-2629` diverts viewport hovered arrows and Space away from immediate panel nav into shortcuts pan path. `viewerGestures.js:312-313` ignores repeat for Space poll setup, but pan dispatch still repeats and still resets settle.

Status: implemented. Heartbeat sync in `manhwaStrip.js`: while pan ticks keep arriving, the anchor commits through `Core.selectIndex` at most every 150 ms and the panel follows through the settle event. Trailing settle still owns the final commit. External index echoes stay gated on 150 ms pan quiet, so stale async notifies from heartbeat selects never yank the strip mid-hold. No panel changes; `Core` notify stays the only channel.

## Issue 5. Identical per-image work that belongs on the container

Status: done. Shared mount handlers, slot-driven sizing, and container scaling are in code. Single-viewer pan path keeps the canvas up instead of cancelling. Strip mounts only with known dims and batches layout per frame. Per-slot backdrops gate on decoded dims.

The big transform already sits in one place. Every pan, zoom, align, and layout path writes one container transform at `manhwaStrip.js:304,829,848,867,895,981,1003,1022,1035,1231` through `getTransform` at `viewerMath.js:456`. Rotation, flip, and scale ride that single write. No per-image geometry transform exists in code.

What still runs once per image with identical content.

- Mount builds fresh onload plus onerror closures per node at `manhwaStrip.js:511-523`, plus dataset writes at 499-500.
- Decode writes slot width and height at 362-366 and fans the width estimate out to every undecided slot at 349-360.
- SVG sizing writes inline width and height on the img at 337-340 and again at 503-509.
- `_buildSlots` at 197-239 writes per-slot width, height, backdrop node, `--slot-backdrop-bg` tint, and video placeholder divs.
- `--zoom-scale`, `--grill-angle`, `--slot-backdrop-angle`, and `data-scaling` already live on the strip at 241-246, 830, 1063, 1155, 1232. CSS still targets `.manhwa-slot>img[data-scaling]` at `main.css:1589-1599`, so confirm no per-img scaling write exists before touching that selector.

Fix direction is dedupe inside the same owner. Share one onload and one onerror handler across mounts, keyed by imgIdx from the dataset. Size the slot, not the img, wherever the img only mirrors the slot. Keep the per-slot tint, that one is intentionally per slot. `manhwaStrip.js` stays the sole strip owner. No state, CSS token, or IPC change.

## Issue 6. Strip ignores open_first_image and centers width-fit opens

Status: implemented. Opens resolve through `_resolveOpenAnchor`: an index with no image mapping and `open_first_image` off holds no anchor, so the drop overlay stays up and nothing mounts or syncs until the user picks an image. Width-family fits (`width`, `width-if-larger`, `window`, `window-if-larger`) top-align on open; other fits keep centering. Single-image open behavior untouched.

Off means blank elsewhere. `fsUtils.js:526-537` for folders and `700-704` for archives resolve index 0 (`..`, empty src) when `open_first_image` is off. Single-image view then shows the drop overlay.

The strip overrides that. `_buildImageIndex` at `manhwaStrip.js:136-156` keeps image and video entries only, so `..` never maps. `_activate` at 1070-1071 and the rebuild path at 1190-1191 fall back to anchor 0 when the map misses. Off still lands on the first image, and `_scheduleSettle` then pushes that selection into Core.

Width-family fits open centered. `_activate` at 1075 calls `_applyFitMode(mode, anchor)` with alignTop false. That runs the center path at 819-826 (`_centerColumnY`, last-item end-pin at 820-821). Same for the rebuild path at 1195. Opening a folder in manhwa mode with fit width, width-if-larger, window, or window-if-larger puts the viewport at the first image center instead of the column top.

Fix direction. When the resolved index has no image mapping and the setting is off, hold no anchor, force no selection, and leave the viewport on the drop overlay instead of falling back to anchor 0. First open in a width-family fit top-aligns through `computeTopAlignTy` at `viewerMath.js:153-162` rather than centering. Keep single-image open behavior as is. `manhwaStrip.js` stays the sole strip owner.

## Issue 7. Strip decodes in parallel where thumbnails queue in order

Status: implemented. Sequential decode queue in `manhwaStrip.js`. Fresh items decode off-DOM one at a time in scroll order and mount only with known dims. Queue sorts top-first, bottom-first while scrolling up. Quiet passes with no pan delta no longer re-sort, so a scroll-up queue keeps its direction through decode flushes. Prefetched items still mount instantly. Queue resets on deactivation and cache clear.

Thumbnail view serializes heavy work. `filePanel.js:282-293` bounds the viewport queue with a 1-row margin, parks uncached thumbs on `TRANSPARENT_PIXEL` with `pendingSrc` at 1853-1867, commits on scroll settle at 2428-2437 through `commitPendingThumbnails` at 2059-2130, exempts the viewer-active index at 1860-1862 and 1873-1881, and dedupes archive bytes through `ensureArchiveBlob` at 109 behind `isConstrainedThumbnailSrc` at `fsUtils.js:222`.

The strip runs hot. Prefetch allows 2 concurrent decodes at `manhwaStrip.js:39`, backend warm fires 2 past the window at 683-706, and the mount loop at 470-548 mounts every visible item raw the same tick. Parallel unlocked ZIP extraction piles onto first scroll. Completion order, not scroll order, decides what lands first.

Fix direction is a sequential queue in scroll order for strip mounts and prefetches, mirroring the thumbnail settle and commit pattern, with the anchor-visible item exempt the way the viewer-active thumb is. Keep the 1-image buffer and the decode gate. No new owner. The strip owns the queue inline; no shared queue module unless a second caller appears.

## Issue 8. Video rows hold layout instead of skipping

Status: resolved and user-confirmed in the running app. The strip index and layout exclude videos entirely: no rows, no offsets, no anchor landings. mp4 counts as both image and video upstream, so the video check wins at the strip gate and the highlight rule. Selecting a video paints the row and raises the drop overlay while the strip and its anchor stay put; `navigateManhwa` landings are highlight-only and settle never drags `Core` back onto a nearby image while an unmapped row stays selected. Single-image playback untouched.

Today videos are layout members. `_buildImageIndex` at `manhwaStrip.js:136-156` includes them, `_buildSlots` at 214,229-234 reserves a 400 px row with a text label, offsets and totalHeight count them, and the anchor can land on one. Mount at 474, prefetch at 624, decode at 312, and backend warm at 690,697 skip video, so each row stays a dead placeholder that shifts every image below it.

Requested behavior treats a video as a file-list highlight only. The strip index and layout exclude videos entirely. Selecting one paints the row, shows the drop overlay in the viewport, and mounts nothing. Single-image view keeps its player at `viewerRender.js:533-586`. The audio pill is already hidden in strip mode.

Watch the landings. `navigateManhwa` at 910-929 and the external-index branch at 1212-1218 must route video selections to highlight-only without moving the strip or pushing a bogus anchor through settle at 719-753. Settle must not drag Core back onto a nearby image while a video row stays highlighted.

## Issue 9. Imported-but-downloading slots render as errors

Status: open, no code changes yet. From clipboard handoff.

The importer writes 0-byte placeholders first and returns before bytes arrive (`urlLoader.js:1829,1912,1994,2108,2213,2519`), then swaps on `quivit-download-complete` at 2353-2370. Single-image view rides that swap at `viewerRender.js:493-505` and the statusbar reads `Downloading...` at `statusbar.js:191-207`.

The strip has no downloading state. `_buildSrc` at `manhwaStrip.js:121-134` hands the 0-byte path to an img, the load fails, and onerror at 514-523 stamps the slot `error` plus a `.manhwa-error-placeholder` div. `_acquireNode` at 158-165 sets `alt` to empty, so nothing names the state.

Requested behavior leaves the slot blank with `alt="Downloading..."` on the img and fills it when the bytes land. No error class, no error div, no decoded flag, no prefetch-cache poisoning from the failed attempt. The download-complete event remounts or retries that slot the way the single-image swap does.

## Issue 10. Secondary highlights survive manhwa toggle-off

Status: open, no code changes yet. From clipboard handoff.

Secondary highlight is the `in-view` class on file rows, painted only in strip mode. Both paint paths gate it on `isManhwa = state.manhwaEnabled && isManhwaStripActive()` and remove it otherwise: `renderVisibleSlice` at `filePanel.js:2036-2040`, `updateSelection` at 2215-2219.

Toggle-off never reaches either path. `renderFilePanel` dedups at `filePanel.js:2318-2327` on list identity, index, view mode, panel visibility, and directory only. Toggling manhwa changes none of those, so it returns early with stale `in-view` classes still on the rows. `_deactivate` at `manhwaStrip.js:1107-1137` dispatches no event and cancels the settle timer at 1125-1128, so no later pass repaints the panel.

Toggle-on self-heals by accident. `_activate` schedules a settle that fires `quivit-manhwa-settle`, and the panel listener at `filePanel.js:2825-2829` repaints while the strip is active. Toggle-off has no such trailing event, so the stale highlight sits until the next selection change.

Fix direction is a manhwa token in the dedup guard. Record last rendered manhwa-active state next to `lastRenderedIndex` at 305 and include it in the early-return comparison, so toggle on and off both force a repaint through the existing remove path. Do not let the strip reach into panel rows to clear classes; the panel stays the sole owner and the Core notify stays the only channel.

## Confirm checklist

- [x] Log decode corrections during hold with imgIdx, oldH, newH, anchor, oldAnchorTop, newAnchorTop, oldTy, targetTy. Accept when jumps align with decodes and sign tracks direction.
- [x] Repro hold through a fully decoded chapter versus an unread chapter. Accept when jitter vanishes once no first decodes remain.
- [x] Log strip window versus visible range per update. Accept when edge mounts with zero lead time are counted.
- [x] Time src set versus onload versus first paint by archive versus disk. Accept when blank duration is split by cache hit and miss.
- [x] Count prefetch start versus skip and duplicate URL fetch. Accept when double fetch rate is known.
- [x] Count evict to remount of same index within 2 seconds. Accept when thrash rate is known.

- [ ] Log key repeat, panBy, scheduleSettle, selectIndex, settle event times during hold. Accept when starvation gap is measured.
- [x] Count shared versus per-mount handlers and style writes over one chapter scroll. Accept when one onload/onerror pair serves all mounts.
- [ ] Open a folder in manhwa mode with open_first_image off and fit width. Accept when the overlay shows and no selection is forced. Repeat with the setting on. Accept when the first image pins top.
- [x] Log strip mount start order and concurrent fetches on a cold archive scroll. Accept when starts follow scroll order through a sequential queue.
- [ ] Step through a mixed image and video folder in strip mode. Accept when videos highlight only, the overlay shows, and layout ignores them.
- [ ] Import a gallery URL in strip mode before downloads finish. Accept when pending slots read Downloading, stay blank, and fill on arrival.
- [ ] Toggle manhwa on, scroll, then toggle off. Accept when no row keeps in-view after toggle-off.
