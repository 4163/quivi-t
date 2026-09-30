# Manhwa video support plan

Validation comparison performed. This plan was compared against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md` before presenting. It proposes no JS inline visual writes, no new DOM in bootstrap, no domain logic in UI files, no Rust facade bypass, and no IPC shape change.

## Locked definitions

- l means legacy single image viewer. m means manhwa strip.
- l to m means toggling strip on while legacy shows an image or video. m to l means toggling strip off with the strip anchor handed back to legacy.
- Treat like images means video entries get rows in the strip index, mount into slots, take part in layout, fit, anchor sync, and file panel selection. It does not mean WebGL filters or Lanczos canvas apply to strip video. Strip images today render as plain img nodes with no filter canvas, and strip video stays the same.
- Ignore implementation means the current strip behavior that drops video entries from the index and forces the drop overlay when one is selected.
- Per slot volume means a small mute button with slider pill anchored bottom left inside that slot. One pill per video slot with sound. Image slots get none.
- Mutually exclusive means at most one strip video is unmuted at a time. Unmuting one mutes the rest.
- Scope means provider gallery videos only. The backend lists mp4 solely in Library dirs and dirs holding a `gallery.json` (`src-tauri/src/commands/directory.rs:35-36,60`). Archives never list mp4 since it is absent from `SUPPORTED_FORMATS` (`src-tauri/src/formats.rs`). A dragged in local mp4 passes the drop filter but `loadFile` opens the parent through `read_directory` (`src/js/fsUtils.js:878`), which strips it, so it never becomes an entry. The strip only indexes `state.list`, so it mirrors legacy support entry for entry and unlocks no general video.

## Deviation rules

- If a checklist item needs an IPC, config key, or protocol URL change, stop and run the blast radius workflow first. The current plan assumes none.
- If per slot video with sound cannot reuse `FsUtils.checkMediaAudio`, stop and report. Do not invent a second probe path.
- If bridge handoff cannot carry a video node with the existing `parkHandoff` contract, stop and report. Do not invent a parallel bridge layer.
- Keep legacy single view behavior byte for byte unless an item lists it as touched. The global audio pill, pool, and sync stay as is.

## Spec from clipboard

Videos get treated as how other image formats are treated, rather than the ignore implementation currently set up. l to m and m to l bridging works without issues. Volume sits bottom left of the specific manhwa slot. Volume hides after 2 seconds, not configurable to the frontend. On hover it transitions in. If multiple videos with audio are present, volume is mutually exclusive. One on, the rest off.

## Current state

Strip index drops video entries in `_buildImageIndex` at `src/js/viewer/manhwaStrip.js:186-205`, filter at line 191. The header comment at `src/js/viewer/manhwaStrip.js:72-75` states videos are excluded entirely. Open anchor maps video to -1 at `src/js/viewer/manhwaStrip.js:1247-1256`. Anchor sync refuses to drag Core onto video at `src/js/viewer/manhwaStrip.js:1164-1171`. `src/js/main/main.js:211-222` forces the drop overlay when a video is selected in strip mode. Renderer bails to strip ownership at `src/js/viewer/viewerRender.js:585-598` and parks img or video into the bridge. Pipelines bail at `src/js/viewer/viewerPipelines.js:681-687`.

Legacy video lives in a two node pool defined in `src/index.html:328-331` and driven from `src/js/viewer/viewerRender.js:86-97,112-153,213-272,618-670`. Video stays muted. Sound goes through a separate global `<audio>` element at `src/index.html:342` with the pill at `src/index.html:344-382`, owned by `src/js/viewer/viewerAudio.js:1-282`. Strip hides that pill with `src/css/main.css:1590-1592`. Probe path is `FsUtils.checkMediaAudio` at `src/js/fsUtils.js:299-306` into Rust `check_media_audio` in `src-tauri/src/commands/animation.rs:31-47`. Type predicates live at `src/js/fsUtils.js:154-160`.

Bridge wiring lives in `src/js/viewer/viewer.js:40-49`. Slot mount releases the bridge. Handoff parks the node. Deactivate picks an img anchor from mounted, prefetched, or prefetching maps at `src/js/viewer/manhwaStrip.js:1757-1774` and hands it off at `src/js/viewer/manhwaStrip.js:1780-1795`. There is no video anchor path today.

## Blast radius

Read the diff shape first. The change reaches the strip index, slot pools, mount queue, layout and fit, anchor sync, overlay gating, bridge handoff both ways, per slot audio UI, and strip CSS. It stays clear of Rust, IPC shapes, protocol URLs, config files, and cross window helpers.

- Strip index consumers. `manhwaStrip.js:191` feeds `_listToImgIdx`, `_resolveOpenAnchor`, `_syncAnchorToCore`, navigation in `manhwaStrip.js:1517-1531`, file panel selection through `quivit-manhwa-settle` at `manhwaStrip.js:1172`, and `_admitCompleted` at `manhwaStrip.js:2007-2120`. Failure if wrong. Rows shift, anchor maps to the wrong list index, or downloads never join the column.
- Mount and pool consumers. `_acquireNode` and `_releaseNode` at `manhwaStrip.js:213-232`, slot create and acquire at `manhwaStrip.js:327-367`, claim at `manhwaStrip.js:973-988`, queue at `manhwaStrip.js:1001-1126`. These assume img nodes with `onload`, `naturalWidth`, and `decode()`. Failure if wrong. Video nodes leak into the img free pool, handlers never fire, or the queue stalls with `_mountInFlight` stuck.
- Layout and fit consumers. `_onItemDecoded` at `manhwaStrip.js:478-558`, `_updateLayout` at `manhwaStrip.js:408-476`, `_applyFitMode` at `manhwaStrip.js:1271-1391`, plus `computeStripFitScale` and column offsets in `src/js/services/viewerMath.js:38-84,569-616`. Failure if wrong. Estimated heights never correct, the column jumps, or width family fits measure the wrong widest width.
- Overlay and status consumers. `src/js/main/main.js:211-222`, `Statusbar.setImage` from `manhwaStrip.js:1153-1157`. Failure if wrong. Overlay covers real video rows, or dims stay blank for video anchors.
- Bridge consumers. `viewerRender.js:155-196` park, `viewerRender.js:274-307` release, `viewer.js:40-49` wiring, `manhwaStrip.js:1752-1796` deactivate. Probes in `e2e/replay-diagnostics/probes/viewerPipelineProbe.js` match viewer classes. Failure if wrong. Toggle leaves a frozen bridge node on screen, drops the anchor image, or breaks replay checks that match `.bridge` nodes.
- Audio consumers. Global pill at `src/index.html:344-382` and styles at `src/css/main.css:765-892` stay legacy owned. The strip rule at `main.css:1590-1592` must narrow, not vanish. Failure if wrong. Legacy pill appears inside the strip, or per slot pills inherit viewport level stacking and sit in the wrong corner.
- Neighbor and preload split. `neighborEntries` at `src/js/fsUtils.js:348-372` excludes video, `neighborVideoEntries` at `src/js/fsUtils.js:374-394` serves single view. Strip has its own prefetch at `manhwaStrip.js:789-911`. Failure if wrong. Strip prefetch double fetches what single view preloads, or archive blob cache keys collide.
- Actions. `cmd-toggle-manhwa` and `cmd-toggle-audio` in `src/js/services/actions.js` stay unchanged. No new action id is planned. Failure if wrong. Saved scenarios or keybinds dispatch an id that does not exist.

Confidence. Items above stop at step 2 until implementation runs code. Step 4 proof comes from one mocha file for math and state, one filtered cargo check which should be a no-op, and one e2e viewer spec with a mixed image and video folder. Flag anything that cannot reach step 4 in the final report.

## Implementation checklist

### 1. Index video entries as first class rows

- [x] Include video in `_buildImageIndex` at `src/js/viewer/manhwaStrip.js:186-205`. Keep `_isPendingEntry` at `manhwaStrip.js:175-184` as the only skip. Tag each row with a kind, image or video, and keep `listIndex`, `entry`, `imgIdx`, `naturalWidth`, `naturalHeight`, `decoded` shape so layout code keeps working.
- [x] Update `_resolveOpenAnchor` at `manhwaStrip.js:1247-1256` so a video selection resolves to its row instead of -1. Keep the `open_first_image` behavior for the no anchor case.
- [x] Update `_syncAnchorToCore` guard at `manhwaStrip.js:1164-1171` so anchor changes to video rows call `Core.selectIndex`. Keep the holdover path at `manhwaStrip.js:1142-1146` intact.
- [x] Update `navigateManhwa` unmapped path at `manhwaStrip.js:1517-1531` and `_activate` overlay path at `manhwaStrip.js:1702-1707` so video rows move and paint like image rows.
- [x] Update `_admitCompleted` filter at `manhwaStrip.js:2016` so late downloads join the index for video too.
- [x] Drop the stale video exclusion in `stripVisibleIndices` at `src/js/filepanel/filePanel.js:2055-2060` so secondary highlights follow the viewport when a video row is selected. Runtime confirmed.
- Accept. A gallery with images and mp4 mixed shows one continuous column with no gaps where videos sit. Selecting a video row highlights it in the file panel and status bar. No drop overlay while a mapped row is selected. No frontend video gate is added. The backend listing gate already limits video entries to Library and gallery dirs.

### 2. Slot nodes carry video as well as img

- [x] Add a video node pool next to `_acquireNode` and `_releaseNode` at `manhwaStrip.js:213-232`. Video nodes are `video` elements with `loop`, `muted`, `playsinline`, `preload="metadata"`. Never push a video node into the img `_freePool`. Name caps at module scope.
- [x] Extend `_createSlotNode`, `_acquireSlotNode`, `_releaseSlotNode`, `_insertSlotOrdered` at `manhwaStrip.js:327-367` so a slot hosts one img or one video. Slot keeps `position: relative` from `src/css/main.css:1487-1497` so the per slot pill has an anchor.
- [x] Extend `_claimSlot` at `manhwaStrip.js:973-988` to stamp `dataset.imgIdx` and `dataset.listIndex` on video nodes and attach `loadedmetadata` and `error` handlers that feed `_onItemDecoded` with `videoWidth` and `videoHeight`.
- [x] Pause, remove src, and load on `_releaseSlotNode` and evict paths at `manhwaStrip.js:626-654` so off window videos stop and free their element. No blob revoke. The archive blob cache owns those URLs and revokes on its own eviction. Slot sizing rules for video landed early in `main.css`. Runtime confirmed.
- Accept. Rapid scroll through mixed rows mounts and evicts without stalled slots. Paused off window videos use no CPU. No img handler fires for a video node and back.

### 3. Mount queue, prefetch, and src building understand video

- [x] Keep `_buildSrc` at `manhwaStrip.js:158-171` as the single src builder. Confirm it returns archive and file URLs for mp4 the same way it does for images. `getCachedArchiveBlob` stays the read path.
- [x] Split `_advanceMountQueue` at `manhwaStrip.js:1001-1117` by row kind. Images keep `new Image` plus `decode`. Videos set `src`, wait `loadedmetadata` or `canplay`, then mount. Keep `_mountInFlight`, `_sortMountQueue` at `manhwaStrip.js:915-919`, and `_resetMountQueue` at `manhwaStrip.js:1119-1126` shared.
- [x] Extend `_prefetchAhead` at `manhwaStrip.js:789-881` and `_warmBackendAhead` at `manhwaStrip.js:888-911` to cover video rows with the same strict counts at `manhwaStrip.js:21-40`. No new cache cap without a named constant. Mounted videos play muted. Out of window videos eject like images, with pause plus src drop on release. Runtime confirmed.
- Accept. A three row window mounts the anchor plus one behind and one ahead regardless of kind. Prefetch never exceeds the named caps. Fast toggle on and off leaves no in flight decode.

### 4. Layout, fit, and status treat video dims like image dims

- [x] Feed `videoWidth` and `videoHeight` into `_onItemDecoded` at `manhwaStrip.js:478-558` so `ready`, slot dims, and `_requestLayout` behave the same. SVG caps at `manhwaStrip.js:489-506` stay image only.
- [x] Confirm `_updateLayout` at `manhwaStrip.js:408-476` and `_applyFitMode` at `manhwaStrip.js:1271-1391` need no kind branch beyond dims. Width family top latch and height family active clamp from `manhwaStrip.js:1200-1205` apply to video rows.
- [x] Keep status dims in `_syncAnchorToCore` at `manhwaStrip.js:1153-1157` working for video anchors. Show `videoWidth x videoHeight` once decoded, blank before. Verified zero diff slice. Runtime confirmed.
- Accept. Mixed column measures one widest width and one total height. Fit width, fit height family, and fit none align video rows the same as images. Zoom keeps the anchor.

### 5. Overlay gating stops hiding video rows

- [x] Narrow `stripVideoSelected` at `src/js/main/main.js:211-222` so the overlay only covers truly unmapped selections. Mapped video rows clear the overlay and the `empty` viewport class. Landed early with slice 1 via `isListIndexMapped`. Runtime confirmed.
- [ ] Keep grill toggle at `src/js/main/main.js:231-237` working for mixed rows.
- Accept. Opening a folder on a video row with strip on paints the column. Opening on an unmapped row keeps the old overlay behavior.

### 6. l to m bridge carries video

- [ ] Keep renderer bail at `src/js/viewer/viewerRender.js:585-598` as the l to m owner. It already parks img and video. Confirm the parked video pauses at `viewerRender.js:155-196`.
- [ ] Confirm strip mount releases the bridge through `setOnSlotMounted` at `src/js/viewer/viewer.js:40-46`. Video slot mount must emit the same mounted callback as img at `manhwaStrip.js:987`. No second release path.
- [ ] Confirm target fit geometry passes through the existing handoff. Strip video mount must not call `viewportState.applyFitMode` a second time for the same toggle.
- Accept. Toggling strip on while legacy shows an image keeps a frozen bridge frame until the strip row mounts, then retires it. Same holds while legacy shows a playing video. No blank flash and no stuck bridge node after double raf.

### 7. m to l bridge hands back a video anchor

- [ ] Extend `_deactivate` at `src/js/viewer/manhwaStrip.js:1752-1796` to pick a video anchor from `_mounted`, `_prefetchedImages`, or completed `_prefetching`, mirroring `manhwaStrip.js:1757-1774`. Read dims from `videoWidth` and `videoHeight`.
- [ ] Pass the video node through `_onBridgeHandoff` at `manhwaStrip.js:1794` with `borrowedBridge` set, same as img. Confirm `parkHandoff` at `src/js/viewer/viewer.js:47-49` into `viewerRender.js:198-211` parks video nodes and legacy resumes playback through its existing swap path at `viewerRender.js:618-670`.
- [ ] Clear strip caches and index after handoff exactly as today at `manhwaStrip.js:1814-1826`.
- Accept. Toggling strip off on a video anchor returns to legacy with that video current, sized, and playing muted per legacy rules. Toggling off on an image anchor behaves as before. Fast toggle off before decode still finds an anchor or exits clean with no throw.

### 8. Per slot volume pill, bottom left, auto hide, mutually exclusive

- [ ] Add a slot level volume template. Follow HTML first. Declare a `<template>` placeholder in `src/index.html:320-384` near the bridge and audio markup. Clone it per video slot in `_createSlotNode` at `manhwaStrip.js:327-334`. Do not build the pill with raw `innerHTML` per row.
- [ ] Own pill state in a new pure strip audio coordinator next to the strip, not inside `viewerAudio.js` and not in bootstrap `src/js/main/main.js`. It owns per file muted and volume, the audible slot id, and the 2 second hide timer. It reads sound presence from `FsUtils.checkMediaAudio` at `src/js/fsUtils.js:299-306` with the same bounded cache shape as `viewerAudio.js:7-8`. Legacy `viewerAudio.js:24-48,138-191` stays untouched.
- [ ] Mute with the video element itself. Slot video `muted` and `volume` reflect coordinator state. Keep legacy separate `<audio>` element out of the strip path. Rationale. One global audio element cannot serve N slots, and sync drift code at `viewerAudio.js:193-203` assumes one active video.
- [ ] Enforce mutual exclusion in the coordinator. Unmuting a slot mutes the audible slot first, updates both pills, and persists session only state in the same shape as legacy entries. Muting the audible slot leaves all muted.
- [ ] Hide after 2000 ms with a hardcoded `SLOT_VOLUME_HIDE_MS` constant in the strip audio module. Not a config key, not `frontend_data`. Any pill interaction, hover, focus, click, slider input, or mute toggle restarts the timer. Hover reopens through CSS class only.
- [ ] Style with CSS as source of truth. Add slot pill rules near `src/css/main.css:765-892` and `src/css/main.css:1487-1566`. JS only toggles `is-visible` and `data-state` on the pill host. Pill sits absolute bottom left inside `.manhwa-slot`. Fade uses `opacity` transition, same durations as the legacy pill. Narrow the global hide at `main.css:1590-1592` so it hides only the viewport level `.audio-control-container`, never `.manhwa-slot` pills.
- Accept. Only video slots with sound show a pill. Pill sits bottom left of its own slot. It fades out 2 seconds after last interaction and fades back on hover. Unmuting one slot mutes the previous one. Legacy single view pill looks and behaves as before.

### 9. Probes, unit tests, and e2e

- [ ] Extend `mocha/viewerMath.test.js` column and fit cases for mixed rows with video dims. Extend `mocha/actions.test.js` only if navigation mapping changes action dispatch. Run `npm run mocha`.
- [ ] Add or extend one e2e viewer spec for a mixed folder. Cover scroll across an image to video boundary, toggle l to m on a video, toggle m to l on a video anchor, unmute one of two sounding videos, and pill auto hide. Run the single spec through MCP, not raw wdio subprocesses.
- [ ] Confirm replay probes that match `.bridge`, viewer classes, or action ids still pass. Run `npm test` for contract integrity.
- Accept. Targeted mocha file passes. Single e2e spec passes. Contract tests pass. Full `cargo test` is not needed since no Rust changes are planned. `cargo check --tests` only if a Rust touch appears.

## Files to touch

Frontend. `src/index.html`, `src/css/main.css`, `src/js/viewer/manhwaStrip.js`, one new strip audio coordinator next to the strip, `src/js/main/main.js`, `src/js/viewer/viewer.js` only if handoff wiring needs a video branch.

Untouched unless proven otherwise. `src/js/viewer/viewerAudio.js`, `src/js/viewer/viewerRender.js`, `src/js/viewer/viewerPipelines.js`, `src/js/services/viewerMath.js`, `src/js/core.js`, `src/js/fsUtils.js`, `src-tauri/`, config files, protocol URLs. The mp4 listing gate in `directory.rs` and the archive format registry stay as is. Lifting them is future full video work, and the kind tagged index carries it with no strip rework.

## Manual runtime list for later verification

- Open a provider gallery with images and two mp4 files with sound. Scroll top to bottom. Each video plays when mounted and pauses when evicted.
- Click unmute on the first video pill. Click unmute on the second. First mutes itself.
- Hover off the pill. It fades out after about 2 seconds. Hover the slot corner. It fades back.
- With legacy on a video, toggle strip on. Column appears with no long blank frame. Toggle off. Legacy resumes that video.
- With strip on a video anchor, toggle off. Legacy shows that video.
