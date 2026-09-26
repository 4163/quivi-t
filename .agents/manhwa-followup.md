# Manhwa follow-up pass

Validation: this plan was compared against `.agents/skills/validate-changes/SKILL.md` before presenting. It changes no code itself. Module ownership stays intact, `Core` stays single-index, new DOM stays declared in HTML first, Rust surface untouched.

Parent doc is `.agents/manhwa-mode.md`. Slices 1 through 7 there are done. This doc covers the runtime issues found after that pass. It does not reopen the column model, the center anchor, or the primary plus secondary highlight scheme. Those stand.

## Non-goals

Lanczos and filters stay out. They get a separate doc pass later. Nothing below touches `viewerPipelines.js` filter paths or scaling menus.

## A. Column ends have no padding

The first slot top equals the column top and the last slot bottom equals the column end. When the column is shorter than the viewport it pins to the top instead of centering.

- [ ] Remove the top and bottom empty space in `src/js/viewer/manhwaStrip.js` (`_buildSlots`, `_updateLayout`) and `src/css/main.css`. Accept: the first image top edge sits at the column top with no gap, same at the bottom, and a short gallery pins top with empty space only below it.

## B. Buffer loads before the viewport edge

Images must finish loading before they enter view. The fixed pixel buffer misses at some zooms and pan speeds.

- [ ] Size the window buffer as a named multiple of viewport height on each side instead of the fixed `STRIP_BUFFER_PX` in `src/js/viewer/manhwaStrip.js:19-20`, and mount ahead in the pan direction in `_updateWindow`. Accept: steady panning in either direction never reveals an unloaded slot.

## C. Zoom refreshes the highlights

Anchor and visible set must recompute on zoom settle and on relayout, even when the anchor index did not change.

- [ ] Dispatch the settle update from `src/js/viewer/manhwaStrip.js` (`setViewportState` subscribe, `_updateWindow`, `_syncAnchorToCore`) on zoom settle as well as pan settle. Accept: zooming in or out updates the file list highlights with no pan needed.

## D. One visible image means one highlight

A single image in view must highlight exactly one row. The anchor and the visible set must share one range computation with exclusive boundaries.

- [ ] Unify `getVisibleImageIndices` and the anchor path in `src/js/viewer/manhwaStrip.js:265-283` on `computeWindowRange` in `src/js/services/viewerMath.js:103-125`, and add a mocha case for a single visible item. Accept: one image in view highlights one row, never two.

## E. Viewport click centers the image

Clicking an item in the strip pans the column to center that image vertically. Drags keep panning.

- [ ] Add a click path in `src/js/viewer/manhwaStrip.js` (or `src/js/viewer/viewerGestures.js`) with a small movement threshold separating click from drag, reusing `centerListItem`. Accept: a clean click centers the clicked image, a drag pans with no jump at release.

## F. Next, previous, Home, and End center images

Normal navigation returns. `cmd-next` and `cmd-prev` call `Core.navigate` and then center the result. Home goes to the first image entry, never `..`. End goes to the last image.

- [ ] Route `cmd-next` and `cmd-prev` in `src/js/services/actions.js:9-22` through `Core.navigate` followed by `centerListItem` in `src/js/viewer/manhwaStrip.js:310-322`. A non-image landing centers the nearest image in the direction of travel. Accept: `Shift`+arrows walk images and center each one, no wrap, no `..` stop.
- [ ] Point Home at the first image entry and End at the last one in `src/js/main/main.js:52-74`, replacing the giant pan deltas. Accept: Home always lands on the first image, End on the last.

## G. PageUp and PageDown come from the offsets

Paging must derive from column offsets and the clamp, not from index steps, so the extremes behave like the rest of the column.

- [ ] Page by viewport height through the existing clamp off the offset map in `src/js/main/main.js:64-73` and `src/js/viewer/manhwaStrip.js`, with targets clamped to the column ends. Accept: paging at the very top or bottom stops exactly at the end with no jitter or overshoot.

## H. Grill follows the visible width only

The opaque canvas hugs the widest image in view, not the widest in the chapter.

- [ ] Recompute the grill width on settle from the visible set in `src/js/main/main.js:196-203` and `src/js/viewer/manhwaStrip.js`, and hide it when nothing is visible. Accept: panning to a narrow page narrows the grill, off-screen wide pages never widen it.

## I. Fit modes work in the strip

Fit none, width, and width-if-larger return. Height and window modes map onto the visible set. Every mode applies once on selection and on viewport resize. Panning never re-fits, so the view never jumps under the user.

- [ ] Re-enable the none, width, and width-if-larger rows in `src/js/menubar.js:713-735`. Accept: the rows are selectable in the strip with no single-image-only note.
- [ ] Fit width sets zoom from the widest visible item, width-if-larger caps at 1. None sets zoom to 1. Accept: selecting each mode frames the visible page correctly and panning away keeps the zoom.
- [ ] Fit height sets zoom from the tallest visible item and height-if-larger caps at 1, both subject to the existing minimum zoom cap. Accept: a 1 to 3 image gallery frames like single image mode, long columns show a slice.
- [ ] Fit window sets zoom from the constraining dimension of the visible set and window-if-larger caps at 1, subject to the existing caps. Accept: small galleries frame like single image mode.

## J. Flips match the single raster model

Rotations stay off. Horizontal flip mirrors. Vertical flip flips the whole column, which reverses order and mirrors each image, exactly like mirroring one tall raster.

- [ ] Unguard flip horizontal and flip vertical in the strip in `src/js/services/actions.js` and `src/js/viewer/viewer.js`, keeping clockwise and counterclockwise guarded off. Vertical flip goes through the existing flip path so the column mirrors as one raster. Accept: horizontal mirrors, vertical flips the column top to bottom, rotations do nothing.

## K. ICO spritesheets and dimensionless SVGs

The strip bypasses both code paths. `_buildSrc` uses the sync builders, and `fsUtils.js:286-292` states outright that ICO needs the async path, so `.ico` files render raw instead of the `data:image/png;base64` spritesheet from `get_ico_frames` and `get_archive_ico_frames` (`src-tauri/src/ico.rs:103-104`). Sizeless SVGs report the browser-default 150x150 or 300x150 as natural size, so slots lay out wrong and the 2048 and 512 caps never apply.

- [ ] Route strip ICO entries through `get_ico_frames` and `get_archive_ico_frames` like `buildFileSrc` and `buildArchiveEntrySrc` in `src/js/fsUtils.js:260-292`, swapping the slot src when the invoke resolves and guarding against eviction races. Accept: `.ico` in the strip shows the identical spritesheet to single view, disk and archive.
- [ ] Detect non-intrinsic SVGs in the strip decode path with the same browser-default check as `src/js/viewer/viewerPipelines.js:470-472`, fall back to the 1000x1000 slot from `_applySvgBounds` in `src/js/viewer/viewerRender.js:264-296`, and cap static at 2048 and animated at 512 per edge. Accept: sizeless SVGs lay out at fallback size with no 150px slivers, caps hold.
