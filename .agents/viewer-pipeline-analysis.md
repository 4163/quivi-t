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
- `src/js/viewer/manhwaStrip.js:18-30,206-262,357-549,1063-1079` owns `#manhwa-strip`. Constants are `STRIP_POOL_CAP=10`, `STRIP_BUFFER_VIEWPORTS=2`, `STRIP_AHEAD_BUFFER_VIEWPORTS=1`, `PREFETCH_AHEAD_COUNT=4`, `PREFETCH_CONCURRENT_MAX=3`, estimated slot 1200 by 800. No native scroll is used. `#viewport` has `overflow:hidden`. Pan writes state and moves the strip with transform. Mount and evict run inside state subscribe.
- `src/js/core.js:93-119,485-502,575-597` owns index, list, mode, manhwa flag, fit, spread, view mode. `selectIndex` and `navigate` notify all subscribers.
- `src/js/services/actions.js:9-42,138-140,155-198` plus `src/js/shortcuts.js:204-325,465-493` own dispatch. Next and previous call `pageStrip` or `navigateManhwa` in strip mode, `Core.navigate` otherwise. Pan actions call `Viewer.panBy`. Toggle manhwa calls `Core.toggleManhwaMode`.
- `src/js/filepanel/filePanel.js:1921-2214,2268-2374,2422-2433,2446` owns list paint. It toggles `li.selected` and `in-view`. It subscribes with `Core.onStateChange`. Scroll over the panel paints sync.
- `src/index.html:267,273,276` defines filter canvases and `#viewer-bridge-layer`.
- `src/css/main.css:1419-1461,1601-1612,1979-2043,2103-2112` defines viewport overflow, strip show rules, bridge frozen transform rules, filter opacity rules. Strip active hides `#viewer-img-wrapper` and `#viewer-bridge-layer`.

## Issue 1. Hold pan shifts the active image a tiny amount

Discrete path is clean. It runs `shortcuts.js:311-321` to `main.js:132-135` to `viewer.js:60` to `viewerMath.js:336-342`. One integer step, one notify, no cursor poll.

Hold path is different. `viewerGestures.js:247-328` stores pan origin on mouse down or Space hold, then calls `viewerMath.js:344-350 panTo` on every mousemove at 260-272 and on every 16 ms Tauri cursor poll at 185-234. Poll coords come from `innerPosition/scaleFactor` conversion at 178-195.

Causes, ranked.

1. Two writers fight during Space hold. Mousemove gives CSS client coords. Poll gives window coords divided by scale factor. Any origin or scale error quantizes to a fraction of a CSS px. Sign flips with direction, so up pan reads high and down pan reads low. Fix probe is gate poll when mousemove is fresh, or rebase pan start in the same coord space as poll.
2. Clamp feedback runs every tick. `viewerMath.js:214-228` reads viewport from `getBoundingClientRect` in `viewer.js:7-19`. Values are fractional. `viewer.js:31-40` observer plus `manhwaStrip.js:1066-1078` subscribe call layout, window update, and settle on each notify. Discrete steps stay mid range. Hold values sit near clamp edges where a 0.25 px viewport wobble changes the result.
3. Base image moves sync while filter layers lag one frame or more. `viewerRender.js:747-756` writes transform sync. `viewerPipelines.js:194-242,697-702` defers WebGL and Lanczos. During hold the stale layer shows through. This reads as vertical shimmer. Repro with Filter Off plus Bilinear isolates it. If jank vanishes there, this path dominates.
4. Subpixel output with no rounding. `getTransform` at `viewerMath.js:449` emits float px in calc. Discrete steps are integers. Hold deltas are fractional. This does not cause shift alone. It makes cause 1 and cause 2 visible.

Confirm with logs of both coord streams during hold on 100, 125, and 150 percent scaling, plus ty before and after clamp, plus filter on versus off.

## Issue 2. Buffer exists but next image still pops from blank

Mount logic is `manhwaStrip.js:357-455`. It computes window from the already updated ty, finds start and end with `viewerMath.js:121-146`, evicts outside, sets `img.src` at 414, appends slot at 453. Decode callback is at 439. Fetch starts the same frame the user expects pixels. Slot paints empty first.

Causes, ranked.

1. Load triggers after the move. No idle filler exists. No observer with margin exists. No scroll listener exists. Subscribe at `manhwaStrip.js:1066-1078` is the only hook.
2. Estimated heights misalign the window. `_buildSlots` at `manhwaStrip.js:152-194` reserves 1200 px height. Real pages run 2000 to 5000 px tall. Each `_onItemDecoded` at `manhwaStrip.js:264-321` shifts later offsets and mounts newly covered items blank.
3. Prefetch warms size only. `_prefetchAhead` at `manhwaStrip.js:501-548` uses off DOM images, learns natural size, then drops the bitmap. Later mount refetches the same URL. Cap is 4 items and 3 concurrent, direction gated. Fast scroll jumps past it.
4. Archive blob sharing misses. `_buildSrc` at `manhwaStrip.js:96-109` reuses `thumbnailCache` only if file panel already fetched the same URL. Strip never calls `ensureArchiveBlob` at `filePanel.js:100-164`. Bounds are 8 entries, 24 MB total, 4 MB per entry at `filePanel.js:50-52`. Large chapters churn through it. Disk suffers less. Archives pop worst.
5. Eviction is instant and destructive at `manhwaStrip.js:391-398`. It clears handlers, removes the node, strips src and style. Scroll back redecodes from scratch. Pool cap 10 bounds node reuse, not decoded pixels.
6. Backend prefetch lags the leading edge. `core.js:310-312` plus `fsUtils.js:1100-1140` debounce 75 ms and key off current index. Strip settle adds 100 ms at `manhwaStrip.js:551-597` and keys off center anchor, not scroll edge.

Confirm with per update logs of ty, scale, window top and bottom, start and end, visible range, plus src set time versus onload time, plus hit rate in `_buildSrc`, plus evict to remount churn during a wheel burst.

## Issue 3. Any navigation in strip mode blanks instead of bridging

Scope covers all navigation, not only file select or mode toggle. Verified paths all land in destructive teardown with no holdover.

Legacy viewer behavior.

- `viewerRender.js:137-161` parks outgoing node and freezes geometry into bridge props.
- `viewerRender.js:400-422,611-615,711-715` shows incoming node only after decode and holds 45 ms on cold cache.
- `viewerRender.js:163-203` bridges image to video swaps.
- `core.js:226-232` keeps old src on empty placeholder checks so active change stays false.

Strip behavior today.

- `viewerRender.js:508-513` returns early in manhwa mode through `clearDisplayedImage` at `viewerRender.js:468-480`. That call cancels the retiring bridge node and recycles pool nodes. It parks nothing.
- `manhwaStrip.js` has zero bridge refs. `_activate` at 886-929 builds empty estimated slots. Rebuild on list or container change at 999-1043 removes all mounted images and clears slots and prefetch maps. `_deactivate` at 931-970 removes everything. `_updateWindow` at 357-493 evicts then sets src on empty slots. Video slots are text placeholders at 184-189.
- CSS hides the old layer in strip mode at `main.css:1601-1608`.

Navigation paths that hit this.

- Next and previous through `actions.js:9-42` to `pageStrip` at `manhwaStrip.js:779-833` or `navigateManhwa` at 758-777.
- File panel click through `filePanel.js:1594-1625` to `alignListItemTop` plus `Core.selectIndex`.
- Panel keyboard nav through `filePanel.js:2622-2740`.
- Home, End, PageUp, PageDown through `main.js:68-97`.
- Container change through open parent, sibling, refresh, history load, all landing in `_onStateChange` rebuild at `manhwaStrip.js:972-1043`.
- Mode toggle through `actions.js:138-140` to `core.js:485-502`.

Root cause is missing holdover owner. Fan out through `Core._notify` tears down old pixels before new pixels decode. Estimated slots guarantee blank first paint. Prefetch cannot supply a bitmap because it discards it.

Fix direction has to pick one holdover owner. Keep old strip nodes mounted until replacements for the same scroll anchor decode, or snapshot viewport into the bridge layer across navigation and release after first decoded mount. Decode before append matters more than buffer size here.

## Issue 4. File list stays static during key hold

Paint path works. `filePanel.js:2035,2140-2214,2825-2829` paints selected and in view sync. Panel subscribes at 2446. Scroll over panel paints sync at 2422-2433.

Hold pan never writes `Core` until settle. Path is `shortcuts.js:311-320` to `main.js:132-135 Viewer.panBy` to `viewerMath.js:336-342 notify` to `manhwaStrip.js:1066-1078`, which calls `_updateWindow` plus `_scheduleSettle` at 551-557. Settle waits 100 ms quiet, then calls `Core.selectIndex` at 563-597 only if center anchor changed.

OS repeat fires about every 30 to 50 ms. Each repeat resets the 100 ms timer. Settle starves until key up. Single taps update. Sparse wheel notches update. Mouse scroll over panel updates. Non strip `Core.navigate` at `core.js:524-566` updates because it notifies at once.

Secondary trap is `filePanel.js:2627-2629` diverts viewport hovered arrows and Space away from immediate panel nav into shortcuts pan path. `viewerGestures.js:312-313` ignores repeat for Space poll setup, but pan dispatch still repeats and still resets settle.

Fix direction is throttled anchor sync during hold, for example every 100 to 150 ms while repeat continues, or direct visible paint without waiting for `Core.selectIndex`, with `Core.selectIndex` kept as trailing commit.

## Confirm checklist

- [ ] Log hold coords versus poll coords on 100, 125, 150 percent scaling. Accept when jank source is tied to one stream or clamp.
- [ ] Log ty before and after clamp plus rect versus contentRect height during hold. Accept when edge clamp wobble is measured or ruled out.
- [ ] Repro hold jank with filters off and on. Accept when filter lag is measured or ruled out.
- [ ] Log strip window versus visible range per update. Accept when edge mounts with zero lead time are counted.
- [ ] Time src set versus onload versus first paint by archive versus disk. Accept when blank duration is split by cache hit and miss.
- [ ] Count prefetch start versus skip and duplicate URL fetch. Accept when double fetch rate is known.
- [ ] Count evict to remount of same index within 2 seconds. Accept when thrash rate is known.
- [ ] Record blank frames across next, previous, panel click, container change, mode toggle on and off. Accept when all six are measured with current code.
- [ ] Log key repeat, panBy, scheduleSettle, selectIndex, settle event times during hold. Accept when starvation gap is measured.
