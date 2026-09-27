# Manhwa follow-up pass

Validation: this plan was compared against `.agents/skills/validate-changes/SKILL.md` before presenting. It changes no code itself. Module ownership stays intact, `Core` stays single-index, new DOM stays declared in HTML first, Rust surface untouched.

Parent doc is `.agents/manhwa-mode.md`. Slices 1 through 7 there are done. This doc covers the runtime issues found after that pass. It does not reopen the column model, the center anchor, or the primary plus secondary highlight scheme. Those stand.

## Non-goals

Lanczos and filters stay out. They get a separate doc pass later. Nothing below touches `viewerPipelines.js` filter paths or scaling menus.

## A. Column ends have no padding

The first slot top equals the column top and the last slot bottom equals the column end. When the column is shorter than the viewport it pins to the top instead of centering.

- [x] Remove the top and bottom empty space in `src/js/viewer/manhwaStrip.js` (`_buildSlots`, `_updateLayout`) and `src/css/main.css`. Short columns rest top-pinned but keep the symmetric clamp so 1 to 3 image galleries still pan with viewport edges as bounds. Relayout re-pins an end-pinned view instead of holding the anchor. Offsets subtract the seam overlap per boundary via `seamOverlapForScale`, which mirrors the CSS `min(-1px, -1px/zoom)` rule, and the layout rebuilds on zoom change. Accept: the first image top edge sits at the column top with no gap, same at the bottom, and a short gallery pins top with empty space only below it.

## B. Buffer loads before the viewport edge

Images must finish loading before they enter view. The fixed pixel buffer misses at some zooms and pan speeds.

- [x] Size the window buffer as a named multiple of viewport height on each side instead of the fixed `STRIP_BUFFER_PX` in `src/js/viewer/manhwaStrip.js`, and mount ahead in the pan direction in `_updateWindow`. A prefetch ring decodes items past the window edge ahead of time and records real dims through `_onItemDecoded`, both sides on zoom-in, so pins and anchors use real numbers before mount. Accept: steady panning in either direction never reveals an unloaded slot.

## C. Zoom refreshes the highlights

Anchor and visible set must recompute on zoom settle and on relayout, even when the anchor index did not change.

- [x] Dispatch the settle update from `src/js/viewer/manhwaStrip.js` (`setViewportState` subscribe, `_updateWindow`, `_syncAnchorToCore`) on zoom settle as well as pan settle. Accept: zooming in or out updates the file list highlights with no pan needed.

## D. One visible image means one highlight

A single image in view must highlight exactly one row. The anchor and the visible set must share one range computation with exclusive boundaries.

- [x] Unify `getVisibleImageIndices` and the anchor path in `src/js/viewer/manhwaStrip.js` on `computeWindowRange` in `src/js/services/viewerMath.js:103-125`, and add a mocha case for a single visible item. The anchor recomputes only when the view moves, and explicit centers hold through decode corrections. Accept: one image in view highlights one row, never two.

## E. Viewport click stays a plain click (removed)

Click-to-center behaved zoned and added nothing over drag panning plus file list selection, so it was stripped out per YAGNI. A viewport click now does nothing in the strip. Drags pan as before.

- [x] Remove the click branch in `src/js/viewer/viewerGestures.js` and the `handleViewportClick` export in `src/js/viewer/manhwaStrip.js`. Accept: clicking the viewport moves nothing, drag pans with no jump at release.

## F. Next, previous, Home, and End center images

Normal navigation returns. `cmd-next` and `cmd-prev` call `Core.navigate` and then center the result. Home goes to the first image entry, never `..`. End goes to the last image.

- [x] Route `cmd-next` and `cmd-prev` in `src/js/services/actions.js:9-22` through `Core.navigate` followed by `centerListItem` in `src/js/viewer/manhwaStrip.js`. A non-image landing centers the nearest image in the direction of travel. Centering goes through `_centerColumnY`, which scales the offset by zoom. Accept: `Shift`+arrows walk through normal navigation and center each landing image at any zoom.
- [x] Point Home at the first image entry and End at the last one via a capture-phase listener in `src/js/main/main.js` that owns these keys at any focus, replacing the giant pan deltas. Accept: Home always lands on the first image, End on the last, never `..`.

## G. PageUp and PageDown come from the offsets

Paging must derive from column offsets and the clamp, not from index steps, so the extremes behave like the rest of the column.

- [x] Page by viewport height through the existing clamp off the offset map in `src/js/viewer/manhwaStrip.js` (`pageStrip`), driven by a capture-phase listener in `src/js/main/main.js` at any focus, with targets clamped to the column ends. Accept: paging at the very top or bottom stops exactly at the end with no jitter or overshoot.

## H. Grill uses widest image in directory

The opaque canvas covers the strip box with no width variable and no updater. Slots carry explicit widths from known dimensions, so the strip box equals the widest known image and evicting the widest mounted image never shrinks the column or clips the outline.

- [x] Size slots explicitly in `src/js/viewer/manhwaStrip.js` (`_buildSlots`, `_onItemDecoded`), render the grill as a full-box `::before` in `src/css/main.css`, and delete `_updateGrillWidth`, `--grill-width`, and `grill-hidden`. Accept: grill never resizes from scrolling, zoom, selection, fit, or eviction; outline stays intact.

## I. Fit modes work in the strip

Width basis is the widest image in the directory (widest known, converging on decode), never the visible set. Explicit selection sets zoom and centers X (0) without touching Y across all fit modes (including none, width, height, and window). Per-navigation application keeps item Y from the navigation centering. Panning never re-fits, so the view never jumps under the user.

- [x] Re-enable the none, width, and width-if-larger rows in `src/js/menubar.js:713-735`. Accept: the rows are selectable in the strip with no single-image-only note.
- [x] Fit none sets zoom to 1, centers X (0), and keeps Y position untouched on explicit selection instead of centering the column. Per-navigation keeps item Y from the navigation centering. Accept: selecting none frames 1:1, reading position holds, navigating keeps the target item.
- [x] Fit width sets zoom from the widest image in the directory, width-if-larger caps at 1. Pan X resets to center (0), pan Y untouched on explicit selection. Accept: selecting width frames the widest page, reading position holds, panning away keeps the zoom.
- [x] Fit height sets zoom from the total column height (active image height is ignored) and height-if-larger caps at 1. If the column cannot fit further, zoom clamps to the minimum zoom level (0.05). Pan X resets to center. Accept: 1 to 3 image galleries frame within viewport height, long columns clamp to minimum zoom.
- [x] Fit window sets zoom from the directory width basis and total column height (whichever constrains) and window-if-larger caps at 1, subject to the minimum zoom cap. Pan X resets to center (0), pan Y untouched on explicit selection. Accept: wide or few-image galleries fit without clipping, reading position holds.

## J. Flips match the single raster model

Rotations stay off. Horizontal flip mirrors. Vertical flip flips the whole column, which reverses order and mirrors each image, exactly like mirroring one tall raster.

- [x] Unguard flip horizontal and flip vertical in the strip in `src/js/services/actions.js` and `src/js/viewer/viewer.js`, keeping clockwise and counterclockwise guarded off. Vertical flip goes through the existing flip path so the column mirrors as one raster. Accept: horizontal mirrors, vertical flips the column top to bottom, rotations do nothing.

## K. ICO spritesheets and dimensionless SVGs

The strip bypasses both code paths. `_buildSrc` uses the sync builders, and `fsUtils.js:286-292` states outright that ICO needs the async path, so `.ico` files render raw instead of the `data:image/png;base64` spritesheet from `get_ico_frames` and `get_archive_ico_frames` (`src-tauri/src/ico.rs:103-104`). Sizeless SVGs report the browser-default 150x150 or 300x150 as natural size, so slots lay out wrong and the 2048 and 512 caps never apply.

- [x] Route strip ICO entries through `get_ico_frames` and `get_archive_ico_frames` like `buildFileSrc` and `buildArchiveEntrySrc` in `src/js/fsUtils.js:260-292`, swapping the slot src when the invoke resolves and guarding against eviction races. Accept: `.ico` in the strip shows the identical spritesheet to single view, disk and archive.
- [x] Detect non-intrinsic SVGs in the strip decode path with the same browser-default check as `src/js/viewer/viewerPipelines.js:470-472`, fall back to the 1000x1000 slot from `_applySvgBounds` in `src/js/viewer/viewerRender.js:264-296`, and cap static at 2048 and animated at 512 per edge. Accept: sizeless SVGs lay out at fallback size with no 150px slivers, caps hold.

## L. Zoom readout and settle loop

The statusbar zoom indicator stayed frozen because the single-image `setImage` path is guarded off in the strip. Separately, every settle re-fired `Core.selectIndex` unconditionally, which re-notified and re-armed the next settle in a perpetual 100ms loop.

- [x] Report filename, dims, and zoom from the strip settle path in `src/js/viewer/manhwaStrip.js` (`_syncAnchorToCore` via `Statusbar.setImage`). Scale 1 reads 100%. Accept: zooming in the strip moves the statusbar percentage live with no pan needed.
- [x] Push selection only when the anchor changed and the settle event when selection or visible range changed in `_syncAnchorToCore`. Accept: an idle strip fires no `selectIndex` traffic.
