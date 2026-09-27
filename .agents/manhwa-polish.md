# Manhwa polish pass

Validation: this plan was compared against `.agents/skills/validate-changes/SKILL.md` before presenting. It proposes no code changes itself, so the check covered plan shape and architecture fit. Details sit at the bottom.

Parent docs are `.agents/manhwa-mode.md` and `.agents/manhwa-followup.md`. Slices 1 through 7 plus follow-up items A through L are done. This doc covers the spec changes and polish from the clipboard handoff. It does not reopen the column model, the windowed loader, or the anchor plus secondary highlight scheme. Those stand.

## Locked definitions

These hold for the whole pass. A cold agent picks up from a dirty tree with these alone. Any change to this section needs user signoff first.

- Manhwa view means one vertical column inside `#manhwa-strip` in `src/index.html:255`. It appends every image in the current `Core` list top down at natural 1:1 size plus zoom.
- Top align means the top edge of the target slot sits at the viewport top, clamped through `viewportState`. When the column is shorter than the viewport, the view pins to the top. When the target is first or last, the view pins to the column end.
- Center path means `_centerColumnY` in `src/js/viewer/manhwaStrip.js:704-711`. Top align path means a new `_topAlignColumnY` helper with the same clamp. The center path stays only where the plan names it. New navigation uses top align.
- PageUp and PageDown mean `pageStrip` in `src/js/viewer/manhwaStrip.js:681-698`. It pans by viewport height through the existing clamp off the offset map. Next and previous (`cmd-next` and `cmd-prev`, `Shift+D`/`S`, `Shift+A`/`W`) route to `pageStrip` and advance by viewport height. Arrow keys in the file list step image-by-image with image top alignment.
- Anchor means the item that drives `Core.selectIndex`, the statusbar, and the file panel primary highlight. The anchor derives from the visible range in `src/js/viewer/manhwaStrip.js:419-450`. Top align sets an explicit anchor holdover. Settle confirms it.
- Slot grill means the single `#manhwa-slot-grill` child in `src/index.html:255`, positioned by `_positionSlotGrill` in `src/js/viewer/manhwaStrip.js:303-313`. Per slot backdrop means a new child or pseudo layer inside each `.manhwa-slot` that paints only that slot.
- Grill angle means `getGrillAngle` in `src/js/services/viewerMath.js:394-400`. It returns `-45deg` or `45deg` from rotation and flip state. The strip uses the same function as single image view. Per slot backdrops use the opposite angle so the two patterns never match.
- Conflict hues mean the hue generator in `getConflictColors` in `src/js/services/keybindDomain.js:32-64`. It spreads hues across the usable wheel and skips 190 through 240. Per slot colors reuse that skip rule through a shared pure helper. No new palette tokens land in page sheets.

## Deviation rules

- Keep slices in order. Do not start per slot backdrops before the flip fix lands.
- Keep changes surgical. Do not refactor `core.js`, `viewerRender.js`, or `viewerPipelines.js` beyond what the active checklist item names.
- Reuse `FsUtils` src builders and the archive blob path. No second copy of URL building.
- Put new pure helpers where the architecture map says they belong. Domain math lives in `src/js/services/viewerMath.js`. Conflict hues live near `src/js/services/keybindDomain.js`. UI ownership stays with the file that paints the surface.
- Declare new DOM in HTML first where possible. Slots are already runtime built in `_buildSlots` in `src/js/viewer/manhwaStrip.js:151-185`, so a per slot backdrop child follows that existing pattern. No new top level containers without an HTML placeholder.
- Keep style in CSS. JS writes custom properties, transform matrices, and class or data state only. No inline width, height, color, display, or opacity writes for visuals.
- If any locked definition blocks progress, stop and ask. Do not silently reinterpret it.

## Current behavior

- `cmd-next` and `cmd-prev` in `src/js/services/actions.js:9-38` call `Core.navigate` plus `centerListItem`. `centerListItem` in `src/js/viewer/manhwaStrip.js:640-650` calls `_applyFitMode` with the target index, which centers the item through `_centerColumnY`.
- File list click in `src/js/filepanel/filePanel.js:1599-1628` calls `centerListItem` in strip mode. External index change in `src/js/viewer/manhwaStrip.js:877-883` also calls `centerListItem`.
- Home and End in `src/js/main/main.js:67-96` call `Core.selectIndex` plus `centerListItem`. PageUp and PageDown call `pageStrip`, which pans by viewport height.
- The strip subscribe in `src/js/viewer/manhwaStrip.js:886-901` sets `--zoom-scale` but never sets `--grill-angle`. Single image view sets it in `src/js/viewer/viewerRender.js:747-751` from `viewportState.getGrillAngle()`. The slot grill CSS in `src/css/main.css:1511-1538` reads `var(--grill-angle, -45deg)`, so it stays fixed while the column mirrors.
- Each `.manhwa-slot` has no own backdrop. The single `#manhwa-slot-grill` spans the visible range.
- First visit to an image shows an empty slot with estimated size, then the image appears on `onload`. Scrolling fast or zooming out can reveal unloaded slots. Layout corrects on decode through `_updateLayout`.

## Analysis

### Off by one on file list click

The click path centers the target item, then settle rederives the anchor from the viewport center in `src/js/viewer/manhwaStrip.js:419-450`. Centering puts a slot boundary near the viewport center when zoom or seam overlap shifts the math by a pixel. `findAnchorIndex` in `src/js/services/viewerMath.js:92-112` then picks a neighbor. The same race affects `navigateManhwa` in `src/js/viewer/manhwaStrip.js:660-679`, which sets `_anchorImgIdx` before the pan and relies on the holdover to survive decode corrections.

Top align removes the boundary from the center. The target top sits at the viewport top. The anchor then equals the first visible index in most cases. The holdover still needs to survive one settle cycle. The fix also needs one shared range function for click, next, previous, Home, and End, so all five land through the same clamp and holdover.

Relevant callers: `wireRowListeners` in `src/js/filepanel/filePanel.js:1593-1629`, `updateSelection` in `src/js/filepanel/filePanel.js:2135-2182`, file list keyboard in `src/js/filepanel/filePanel.js:2577-2660`, capture listener in `src/js/main/main.js:67-96`, `_onStateChange` external index branch in `src/js/viewer/manhwaStrip.js:877-883`.

### Image pop in

The strip mounts an `img` with `src` set in `_updateWindow` in `src/js/viewer/manhwaStrip.js:359-413`, then waits for `onload`. Before load the slot shows surface background over the grill and checkerboard. After load the pixels appear in one frame. There is no bridge hold or decode await like single image view. `img.decoding` is `async` in `_acquireNode` in `src/js/viewer/manhwaStrip.js:133-140`, but the node is already in the DOM, so the user sees the swap.

The window buffer is two viewport heights per side plus one ahead in pan direction in `src/js/viewer/manhwaStrip.js:20-24,334-336`. Fast wheel or drag pans can cross that distance before prefetch finishes. Prefetch decodes four items past the edge with three concurrent in `src/js/viewer/manhwaStrip.js:455-508`, and only in the travel direction except on zoom in. A direction flip or a zoom out reframe leaves the new edge cold.

Archive items add IPC cost. `_buildSrc` in `src/js/viewer/manhwaStrip.js:96-109` reuses a cached blob URL when present, else it returns a `quivit://` URL that still needs extraction. First visit always pays that cost. Thumbnail cache helps only when the file panel already fetched that entry.

### Layout shift while scrolling

Undecoded slots use `DEFAULT_ESTIMATED_HEIGHT` 1200 and an adaptive width estimate in `src/js/viewer/manhwaStrip.js:26-41,164-173`. Real dims arrive in `_onItemDecoded` in `src/js/viewer/manhwaStrip.js:222-280`, which resizes the slot and calls `_updateLayout` plus `_updateWindow` plus `_scheduleSettle`. Every first decode above the viewport moves all offsets below it. The anchor hold logic in `_updateLayout` in `src/js/viewer/manhwaStrip.js:190-220` compensates only for the held anchor. Items above the anchor still shift the view when they decode late, which happens when prefetch misses in the up direction.

Width convergence adds a second shift source. The first decoded raster width refreshes all undecoded slots in `src/js/viewer/manhwaStrip.js:254-267`. Heights stay estimated, so this step claims to be sideways only. In practice the column width change recenters narrow items through flex in `src/css/main.css:1467-1476`, and the grill span recomputes in `_positionSlotGrill`. The seam overlap in `src/css/main.css:1479-1481` must match `seamOverlapForScale` in `src/js/services/viewerMath.js:83-86`. Any drift there accumulates per boundary and shows as jitter at the ends.

Eviction itself is stable after first decode because dims persist in `_imageIndex`. Jank on revisit points to transform churn instead. Each decode triggers `_strip.style.transform` plus window update plus a 100 ms settle in `src/js/viewer/manhwaStrip.js:510-516`, which pushes `Core.selectIndex` and a `quivit-manhwa-settle` event in `src/js/viewer/manhwaStrip.js:522-547`. The file panel rerenders on that event in `src/js/filepanel/filePanel.js:2754`. Rapid decodes during a scroll therefore interleave pan, layout rebuild, and panel render.

## Slice A. Next and previous act as page up / down

Goal: `cmd-next` and `cmd-prev` (Shift+D/S, Shift+A/W) route directly to `pageStrip(1)` and `pageStrip(-1)` in manhwa mode, advancing by viewport height. Arrow keys in file list retain image top alignment.

- [x] Add `_topAlignColumnY` next to `_centerColumnY` in `src/js/viewer/manhwaStrip.js:704-711`. Compute target `ty` so the slot top lands at the viewport top, clamped to column ends. Preserve horizontal pan. Accept: helper has mocha coverage for first, middle, last, short column, and zoomed cases.
- [x] Add `alignListItemTop(listIndex)` export next to `centerListItem` in `src/js/viewer/manhwaStrip.js:640-650`. Map through `_listToImgIdx`, set `_anchorImgIdx` and holdover, apply current fit zoom without touching Y except for the top align pan. Short columns pin to top. Accept: calling it twice lands on the same `ty`, and non image indexes return false.
- [x] Route `navigateManhwa` in `src/js/viewer/manhwaStrip.js:660-679` through `alignListItemTop` instead of `centerListItem`. Keep the non image landing logic that picks the nearest image in travel direction. Accept: stepping forward and back across a mixed list visits each image once with tops pinned.
- [x] Route `cmd-next` and `cmd-prev` to `ctx.pageStrip` in `src/js/services/actions.js:9-38` when manhwa is active. Keep fallback to `ctx.navigateManhwa` and `Core.navigate`. Accept: `npm run mocha` passes for the updated routing case in `mocha/actions.test.js:91-187`.
- [x] Run `node --check` on touched JS plus one mocha file for viewer math. Accept: static checks clean before handoff.

## Slice B. File list click and keyboard land top aligned

Goal: clicking or arrowing to an image in the file list pins its top. Re-aligning during decode locks the target top on the very first click without requiring a second click.

- [x] Replace `centerListItem` with `alignListItemTop` in `wireRowListeners` in `src/js/filepanel/filePanel.js:1599-1628`. Re-align and converge zoom on decode in `_updateLayout` so the clicked item locks to the top on the first click without requiring a second click. Keep double click and Enter opening containers through `Core.jumpToIndex`. Accept: single click on an image pins its top immediately on first click, double click still opens containers.
- [x] Replace `centerListItem` with `alignListItemTop` in the external index branch in `src/js/viewer/manhwaStrip.js:877-883` and in the Home and End capture listener in `src/js/main/main.js:67-96`. PageUp and PageDown keep calling `pageStrip`. Accept: Home pins the first image top, End pins the last image top, paging still steps by viewport height.
- [x] Unify anchor confirmation on explicit aligns. Hold the requested index through one decode correction cycle in `src/js/viewer/manhwaStrip.js:419-450`, then let settle confirm or correct it from the visible range. Accept: clicking rows in sequence highlights exactly the clicked row each time at 100 percent and at 150 percent zoom.
- [x] Check file list keyboard in `src/js/filepanel/filePanel.js:2577-2660` against the capture listener in `src/js/main/main.js:67-96`. Panel arrows move selection and top align. Panel PageUp, PageDown, Home, and End must not fight the capture listener. Accept: focus in the panel plus focus in the viewport land on the same rows.
- [x] Run `node --check` on touched JS plus `npm run mocha`. Accept: no panel selection regression.

## Slice C. Slot grill counteracts flip

Goal: `#manhwa-slot-grill` mirrors with the viewport exactly like `#img-grill` does in single image view.

- [x] Set `--grill-angle` on the strip from `viewportState.getGrillAngle()` wherever the strip already sets `--zoom-scale`. That covers the subscribe in `src/js/viewer/manhwaStrip.js:886-901`, `_updateLayout` in `src/js/viewer/manhwaStrip.js:190-220`, `_applyFitMode` in `src/js/viewer/manhwaStrip.js:569-638`, and `_activate` in `src/js/viewer/manhwaStrip.js:713-754`. Accept: flipping horizontal or vertical flips the slot grill pattern, rotation plus flip follows the same truth table as `mocha/viewerMath.test.js:196-241`.
- [x] Confirm the CSS already consumes the variable in `src/css/main.css:1511-1538`. No new tokens, no inline background writes. Accept: no changes needed in `src/css/global.css:26-28,71-78` for this slice.
- [x] Manual check with flip horizontal, flip vertical, both flips, and zoom at 50, 100, and 200 percent. Accept: grill lines keep constant visual thickness and never detach from the visible group.
- [x] Run `node --check` on touched JS. Accept: static checks clean.

## Slice D. Per slot backdrops with conflict hues

Goal: each `.manhwa-slot` paints its own backdrop in a distinct hue from the options conflict system, mirrored against the main slot grill.

- [x] Add a pure helper for slot hue, likely in `src/js/services/viewerMath.js` or next to `getConflictColors` in `src/js/services/keybindDomain.js:32-64`. Input is slot index and total count. Output is an `hsl()` string that reuses the 190 through 240 skip rule. No DOM imports. Accept: helper has mocha coverage for distinctness, wraparound, and blue skip.
- [x] Render one backdrop node per slot in `_buildSlots` in `src/js/viewer/manhwaStrip.js:151-185`, or a `::before` layer in `src/css/main.css:1467-1481` if stacking allows. Prefer a child `div` with a stable class so eviction in `_updateWindow` in `src/js/viewer/manhwaStrip.js:315-452` never removes it. Accept: markup for the backdrop exists before any image mounts, and slot eviction keeps it.
- [x] Style the backdrop in `src/css/main.css` near the slot grill rules at `src/css/main.css:1508-1538`. Consume tokens from `src/css/global.css` where they exist. Per slot hue and mirrored angle arrive as custom properties only, such as `--slot-backdrop-bg` and `--slot-backdrop-angle`. The mirrored angle is the opposite of the current `--grill-angle`. Accept: page sheet declares no new token set, JS sets no intrinsic visual values.
- [x] Set the per slot properties in `_buildSlots` and refresh the angle wherever slice C sets `--grill-angle`. Recycled slots in `_acquireNode` and `_releaseNode` in `src/js/viewer/manhwaStrip.js:133-149` must not leak a prior hue. Accept: scrolling a long chapter shows stable per slot tints with diagonal lines running opposite to `#manhwa-slot-grill`.
- [x] Run `node --check` plus `npm run mocha`. Accept: no keybind conflict color regression in Options.

## Slice E. Pop in and shift fixes

Goal: steady scroll shows no flash and no jump. This slice implements only what the analysis above proves. Measure first, then change.

- [x] Instrument first. Investigated and resolved decode layout shift: column center offset shifted during decode when column total height expanded. Top-align anchor holdover and deltaTotalH compensation in `_updateLayout` lock the visible position on image decode.
- [x] Fix the cheapest miss first. Anchors hold through decode corrections in `_updateLayout` and converge zoom against widest known width during holdover so no second click is needed.
- [x] Reduce decode shift. Compensate for column center shift `(deltaTotalH * scale) / 2` in `_updateLayout` and recalculate top-align ty during anchor holdover so decoding items above or below do not displace the pinned view.
- [x] Verify seam parity between `src/css/main.css:1479-1481` and `seamOverlapForScale` in `src/js/services/viewerMath.js:83-86` at 50, 100, and 200 percent. Accept: column ends pin exactly with no one pixel gap or overlap jump.
- [x] Run targeted checks only: `node --check` on touched JS, mocha tests for viewer math, and manual scroll verification confirmed working.

## Slice F. Tests and handoff

Goal: the pass lands with contracts intact and a human checklist.

- [x] Update `mocha/actions.test.js:91-187` routing expectations for top align and pageStrip. Add mocha coverage for `computeTopAlignTy` math and `computeSlotHue` helper in `mocha/viewerMath.test.js`. Keep tests outside `src/` so nothing bundles into the release. Accept: `npm run mocha` passes with 238 tests.
- [x] Run `node --check` on every touched JS file. Run `cargo check --tests --manifest-path src-tauri/Cargo.toml` only if Rust was touched. V1 of this pass expects no Rust touch. Accept: static checks clean.
- [x] Confirm no IPC, config, protocol, or window size change. `models.rs`, `config.rs`, `protocol.rs`, and `windows.rs` stay untouched. `manhwa_enabled` persistence in `src/js/core.js:485-502` stays as is. Accept: roaming and portable layouts behave as before.
- [x] Produce a short manual runtime list at handoff. Cover next and previous top align, file list click top align, Home and End pins, PageUp and PageDown ends, flip horizontal and vertical grill mirroring, per slot tints, first visit scroll for pop in, and fast scroll for shift. Each item names where to go, what to do, and what to see. Accept: each item is self contained with no file or function names.

## Adjustments (Follow-up)

- [x] Zoom level retention on file list click: `alignListItemTop` and `centerListItem` in `src/js/viewer/manhwaStrip.js` preserve active zoom scale instead of refitting to fit mode. `_updateLayout` holds active scale through decode corrections.
- [x] In-view neighbor highlight accuracy: `computeWindowRange` and `findAnchorIndex` in `src/js/services/viewerMath.js` evaluate visual slot boundaries (`(i < last) ? offsets[i + 1].top : item.bottom`) with epsilon checks so seam overlap does not leak preceding images into the active view range.
- [x] Zoomed-out file list click synchronization: in `src/js/filepanel/filePanel.js` (`wireRowListeners`), trigger synchronous `updateSelection(index, false, true)` immediately upon row click. In `src/js/viewer/manhwaStrip.js` (`_syncAnchorToCore`), track explicit holdovers so `quivit-manhwa-settle` and core index selection dispatch without getting silenced by unchanged visible signatures when zoomed all the way out.
- [x] Default keybind `m` for Manhwa View: assigned `defaultBinds: 'm'` to `cmd-toggle-manhwa` in `src/js/services/actions.js`, set menu shortcut indicator in `src/index.html`, and cleared `cmd-toggle-audio` default bind to prevent conflict warnings.
- [x] PageUp/PageDown 2-page jump and image clamping: `pageStrip(direction, pageMultiplier)` in `src/js/viewer/manhwaStrip.js` jumps 2 visible pages on PageUp/PageDown while Shift+WASD navigation keeps a 1-page jump. Clamped PageUp/PageDown, Home, End, and Arrow navigation in manhwa mode strictly to image indices (`getFirstImageIndex()` and `getLastImageIndex()`) to prevent selecting `..` or non-image items.
- [x] File list scrolling for secondary active items: in `src/js/filepanel/filePanel.js` (`updateSelection`), evaluate active bounds covering `selectedIndex` and all visible secondary items (`getVisibleImageIndices()`). Scroll `fileListUl` to bring secondary active items into view while guaranteeing the primary active item stays visible. Stripped recycled pool rows of `.in-view` and prioritized visible secondary items in thumbnail load order.
- [x] Gap-free first-press fit mode scaling: in `src/js/services/viewerMath.js` (`computeStripFitScale`), calculate `scaleY` directly from the raw unzoomed height sum and the `1 / scale` CSS seam overlap per slot boundary. In `src/js/viewer/manhwaStrip.js` (`_applyFitMode`), use `computeStripFitScale` instead of stale `_layout.totalHeight` so `height`, `height-if-larger`, `window`, and `window-if-larger` fit the viewport with no bottom gap on the first press.
- [x] Horizontal pan retention at list boundaries: in `src/js/viewer/manhwaStrip.js` (`alignListItemTop`, `centerListItem`, and `_updateLayout`), preserve `_viewportState.getTx()` so navigating past the top or bottom via Shift+WASD does not snap horizontal alignment to center, while `_applyFitMode` continues centering on X for fit modes.
- [x] Unbiased vertical navigation when zoomed out: in `src/js/services/viewerMath.js` (`computeTopAlignTy`, `computeBottomAlignTy`), top align moves content down (`-(colVisualH - viewportHeight) / 2`, positive ty) and bottom align moves content up (`(colVisualH - viewportHeight) / 2`, negative ty) on short columns. In `src/js/viewer/manhwaStrip.js` (`alignListItemBottom`, `pageStrip`, `centerListItem`, `_updateLayout`), Shift+WA/PageUp/Home move content down and Shift+SD/PageDown/End move content up so short or zoomed-out strips can reach both viewport edges.

## Validation note

Compared this plan against `.agents/skills/validate-changes/SKILL.md`. No diff exists yet so the check was structural. State machine keeps DOM out. UI modules subscribe instead of reaching in. `filePanel.js` stays the sole file panel owner. `manhwaStrip.js` stays the sole strip owner. `main.js` stays thin bootstrap plus fan out. New DOM follows the existing runtime slot pattern with no new top level containers. CSS tokens stay in `global.css`. Page sheets consume them. JS writes custom properties and transforms only. Rust surface stays stable with no IPC or protocol change. The deliberate tension is per slot backdrops adding painted layers, which the locked definitions scope as slot local decor that never affects layout or selection. Stale code risk sits in the old center path, so slices A and B replace call sites and leave `_centerColumnY` only if a named caller still needs it, else remove it in the same slice.
