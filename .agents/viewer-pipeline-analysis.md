# Viewer pipeline analysis

Validation comparison performed against `.agents/skills/validate-changes/SKILL.md`. This doc is analysis only. It changes no code, no contracts, no ownership.

## Definitions lock

- Viewer is single image mode. Strip is manhwa continuous scroll mode.
- Hold pan is Space or mouse drag held down through `viewerGestures.js`. Discrete pan is one keyboard or wheel step through `actions.js` to `Viewer.panBy`.
- Navigation is any index or container change. That includes next, previous, file panel click, panel keyboard nav, Home, End, PageUp, PageDown, parent, sibling, refresh, history, and manhwa toggle.
- Bridge is keep old pixels up until new pixels decode. Legacy viewer has it. Strip has none today.
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

## Issue 3. Any navigation in strip mode blanks instead of bridging

Status: open, no code changes yet. Next issue to work.

Scope covers all navigation, not only file select or mode toggle. Verified paths all land in destructive teardown with no holdover.

Legacy viewer behavior.

- `viewerRender.js:137-161` parks outgoing node and freezes geometry into bridge props.
- `viewerRender.js:400-422,611-615,711-715` shows incoming node only after decode and holds 45 ms on cold cache.
- `viewerRender.js:163-203` bridges image to video swaps.
- `core.js:226-232` keeps old src on empty placeholder checks so active change stays false.

Strip behavior today.

- `viewerRender.js:508-513` returns early in manhwa mode through `clearDisplayedImage` at `viewerRender.js:468-480`. That call cancels the retiring bridge node and recycles pool nodes. It parks nothing.
- `manhwaStrip.js` has zero bridge refs. `_activate` at 1038 builds empty estimated slots. Rebuild on list or container change at 1139 removes all mounted images and clears slots and prefetch maps. `_deactivate` at 1107 removes everything. `_updateWindow` at 408 evicts outside the 1-item window. Video slots are text placeholders.
- CSS hides the old layer in strip mode at `main.css:1601-1608`.

Navigation paths that hit this.

- Next and previous through `actions.js:9-42` to `pageStrip` at `manhwaStrip.js:931` or `navigateManhwa` at 910.
- File panel click through `filePanel.js:1594-1625` to `alignListItemTop` plus `Core.selectIndex`.
- Panel keyboard nav through `filePanel.js:2622-2740`.
- Home, End, PageUp, PageDown through `main.js:68-97`.
- Container change through open parent, sibling, refresh, history load, all landing in `_onStateChange` rebuild at `manhwaStrip.js:1139`.
- Mode toggle through `actions.js:138-140` to `core.js:485-502`.

Root cause is missing holdover owner. Fan out through `Core._notify` tears down old pixels before new pixels decode. Estimated slots still guarantee blank first paint on rebuilds. The 1-deep prefetched node only covers scroll-adjacent mounts, not navigation jumps or rebuilds.

Fix direction has to pick one holdover owner. Keep old strip nodes mounted until replacements for the same scroll anchor decode, or snapshot viewport into the bridge layer across navigation and release after first decoded mount. Decode before append matters more than buffer size here.

## Issue 4. File list stays static during key hold

Paint path works. `filePanel.js:2035,2140-2214,2825-2829` paints selected and in view sync. Panel subscribes at 2446. Scroll over panel paints sync at 2422-2433.

Hold pan never writes `Core` until settle. Path is `shortcuts.js:311-320` to `main.js:132-135 Viewer.panBy` to `viewerMath.js:336-342 notify` to `manhwaStrip.js:1066-1078`, which calls `_updateWindow` plus `_scheduleSettle` at 551-557. Settle waits 100 ms quiet, then calls `Core.selectIndex` at 563-597 only if center anchor changed.

OS repeat fires about every 30 to 50 ms. Each repeat resets the 100 ms timer. Settle starves until key up. Single taps update. Sparse wheel notches update. Mouse scroll over panel updates. Non strip `Core.navigate` at `core.js:524-566` updates because it notifies at once.

Secondary trap is `filePanel.js:2627-2629` diverts viewport hovered arrows and Space away from immediate panel nav into shortcuts pan path. `viewerGestures.js:312-313` ignores repeat for Space poll setup, but pan dispatch still repeats and still resets settle.

Fix direction is throttled anchor sync during hold, for example every 100 to 150 ms while repeat continues, or direct visible paint without waiting for `Core.selectIndex`, with `Core.selectIndex` kept as trailing commit.

## Confirm checklist

- [x] Log decode corrections during hold with imgIdx, oldH, newH, anchor, oldAnchorTop, newAnchorTop, oldTy, targetTy. Accept when jumps align with decodes and sign tracks direction.
- [x] Repro hold through a fully decoded chapter versus an unread chapter. Accept when jitter vanishes once no first decodes remain.
- [x] Log strip window versus visible range per update. Accept when edge mounts with zero lead time are counted.
- [x] Time src set versus onload versus first paint by archive versus disk. Accept when blank duration is split by cache hit and miss.
- [x] Count prefetch start versus skip and duplicate URL fetch. Accept when double fetch rate is known.
- [x] Count evict to remount of same index within 2 seconds. Accept when thrash rate is known.
- [ ] Record blank frames across next, previous, panel click, container change, mode toggle on and off. Accept when all six are measured with current code.
- [ ] Log key repeat, panBy, scheduleSettle, selectIndex, settle event times during hold. Accept when starvation gap is measured.
