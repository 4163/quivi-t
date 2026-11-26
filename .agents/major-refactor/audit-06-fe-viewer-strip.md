# Split S06 audit: viewer and manhwa strip

This audit covers Split S06 (`fe-viewer-strip`), audited jointly by `s06-strip-perf` (Worker A) and `s06-viewer-arch` (Worker B). All findings, decompositions, cross-split seams (Sync A, Sync B, Sync F, and Resolutions R3 and R4), and Telemetry A and B specifications reached unanimous `[Agreed]` status in board messages `#45`, `#76`, `#77`, `#78`, `#116`, and `#131`.

Baseline checks run during Stage 3: `npm run mocha` passed with 308 passing tests. Zero production files were edited.

## File coverage ledger

All 8 owned files (5,886 lines total) are accounted for. Zero files are purely Cohesive because every file carries at least one verified compliance, decoupling, or performance issue.

| File | Lines | Status | Finding IDs |
| --- | ---: | --- | --- |
| `src/js/viewer/viewerRender.js` | 993 | Findings | `S06-01`, `S06-02`, `S06-03` |
| `src/js/viewer/manhwaStrip.js` | 3,153 | Findings | `S06-04`, `S06-05`, `S06-06` |
| `src/js/viewer/viewerAudio.js` | 288 | Findings | `S06-07` |
| `src/js/viewer/manhwaAudio.js` | 281 | Findings | `S06-08` |
| `src/js/viewer/viewerGestures.js` | 375 | Findings | `S06-09` |
| `src/js/services/viewerMath.js` | 820 | Findings | `S06-10` |
| `src/js/viewer/icoCells.js` | 57 | Findings | `S06-11` |
| `src/js/viewer/viewer.js` | 119 | Findings | `S06-12` |

## Agreed findings

### S06-01 [Blocking] [Agreed] Broken neighbor preloading and mandatory 45ms swap penalty in `viewerRender.js`

**Location:** `src/js/viewer/viewerRender.js:8-9, 600-627, 829-833, 853, 879-880, 940-944`

**Evidence.** `_trimActiveNodes(desiredSrcs)` and `_getPoolNode(src)` at lines 829 to 833 reserve pooled `<img class="viewer-img">` nodes inside `_activeNodes` for adjacent neighbor entries (`PRELOAD_HALF = 1`). However, `_schedulePoolPreloads` at lines 610 to 623 ignores those pool nodes, constructs a throwaway `new Image()`, decodes it, and strips `src` inside `preloader.onload`. When the user navigates to the preloaded neighbor, `_activeNodes.get(effectiveSrc)` has no `src`, so `isAlreadyLoaded` at line 853 is always `false`. Every single-step navigation therefore hits `setTimeout(loadTarget, TARGET_LOAD_DEBOUNCE_MS)` at line 941, paying a flat 45ms delay before starting a redundant fetch and decode (especially costly for `quivit://archive/` URLs served with `no-store`).

**Fix.** Preload neighbor URLs directly into the pooled `<img class="viewer-img">` elements already stored in `_activeNodes`, removing throwaway `new Image()` allocations. Keep `state.isAnimated` at lines 879 to 880 appending `?_reset=` so animated GIF, WebP, and APNG loops restart cleanly on revisit. Gate `TARGET_LOAD_DEBOUNCE_MS` on rapid repeat navigation cadence (for example, `performance.now() - _lastNavAt < 80`) so single-step next and previous presses swap immediately (0ms debounce, 1-frame activation when preloaded) while sustained key-hold scrubbing still debounces.

**Telemetry A and B.** Mocha unit tests for adaptive debounce cadence and pool preload hit state. Replay diagnostics on `sample-navigation` and `zoom-bridge-stale-size` verify 0 blackout frames and measure the ~45ms drop between `image-decode-end` and `img-role-change` (`active`) on preloaded next and previous steps.

---

### S06-02 [Blocking] [Agreed] Bridge retirement races and `viewerBridge.js` extraction in `viewerRender.js`

**Location:** `src/js/viewer/viewerRender.js:58-76, 156-203, 287-291, 522-531, 551-583, 742-753, 841, 919-925`

**Evidence.** Three race bugs exist in the retiring-node lifecycle, alongside three copy-pasted double-rAF retirement blocks (`:522-531`, `:555-564`, `:744-753`) and duplicated 5-property `--bridge-*` cleanup (`:287-291`, `:572-576`):

1. **Premature ICO bridge retirement (`:742-753`).** When navigating to a new ICO file (`!sameRow`), line 742 invokes async `_renderIcoRow(state.src, state)` (which awaits `Promise.all(decode)`), and lines 744 to 753 immediately schedule bridge retirement in 2 rAFs before ICO cells finish decoding, risking blackout frames whenever ICO decode exceeds 2 frames.
2. **Rapid A to B to A bridge clobber (`:551-583`).** If the user navigates back to a node that is still `_retiringNode` inside `#viewer-bridge-layer` (`el === _retiringNode`), `_activatePoolNode` moves `el` back to `#viewer-img-wrapper` and adds `.active` without clearing `_retiringNode`, `_retireRaf`, or `_bridgeFallbackTimer`. Two frames later, `_releaseBridgeNode(node)` runs on the active image and removes it if `borrowedBridge === 'true'`.
3. **Unbridged video to image transition (`:919-925`).** Switching from video to image pauses and hides `_activeVideoEl` before calling `_activatePoolNode`, skipping `_parkNodeInBridge` even though `hasPreviousBridge` at line 841 counted `_activeVideoEl` and delayed the incoming image by 45ms.

**Fix.** Extract `src/js/viewer/viewerBridge.js` as the single owner of `#viewer-bridge-layer`, `--bridge-*` CSS custom properties, and a cancellable bridge retirement state machine. Keep image, dual-video, and ICO row coordination inside `viewerRender.js` (do not create a separate `viewerVideo.js` writing to `#viewer-img-wrapper`, honoring the single-owner DOM rule). Fix all three races: let `_renderIcoRow` own retirement after decode completes, cancel active bridge state when reclaiming `_retiringNode` in `_activatePoolNode`, and park outgoing `_activeVideoEl` in the bridge on video to image swaps.

**Telemetry A and B.** Mocha unit tests for `viewerBridge.js` covering rapid A to B to A reclamation, async ICO decode gating, and video to image handoff. E2E `03-viewer.e2e.js` adds rapid back-and-forth image and video to image assertions. Replay diagnostics on `zoom-bridge-stale-size`, `manhwa-gif-bridge`, and `manhwa-video-bridge` confirm 0 blackout frames and empty `#viewer-bridge-layer` after settle. Telemetry B updates `mocha/diagnosticsContract.test.js:73-82` so literal checks span `viewerRender.js` and `viewerBridge.js` (R4).

---

### S06-03 [Blocking] [Agreed] `Statusbar` reach-in, grill ownership, static pool mismatch, and dead code in `viewerRender.js`

**Location:** `src/js/viewer/viewerRender.js:5, 8, 12, 21, 33, 77, 108-109, 250-254, 299, 325-340, 399-400, 422, 544-545, 567, 762, 780-782, 801, 838, 850, 935, 984`

**Evidence.**

- **Foreign UI reach-in.** Line 5 imports `Statusbar` from `../menubar/statusbar.js` and invokes `Statusbar.setImage`, `Statusbar.syncSpreadIndicator`, and `Statusbar.setZoom` across 15 lines (`:108, 109, 250, 252, 254, 399, 400, 544, 545, 780, 782, 801, 850, 935, 984`), breaking single-writer UI boundaries and duplicating `syncSpreadIndicator` work already done by `Statusbar.update`.
- **Split grill ownership.** `src/js/main/main.js:208-209, 228-238` toggles `#img-grill`, `#img-grill-border`, and `#viewer-img-wrapper.grill-active` from bootstrap instead of `viewerRender.js` owning its own DOM (Sync B with S02).
- **HTML-first pool mismatch and dead placeholder markup.** `src/index.html:405-406` declares 2 static `<img class="viewer-img">` elements while `VIEWER_IMAGE_POOL_CAPACITY = 4` (`:8`), forcing imperative `document.createElement('img')` at lines 33 and 422. Meanwhile `#viewer-loading-frame` (`src/index.html:400`) and `.viewer-img.is-placeholder` (`src/css/global.css:274-276`) have 0 activations anywhere in `src/` and only exist to be excluded by `:not(.is-placeholder)` at lines 21, 299, and 567 (R3).
- **Dead state and invisible timer churn.** `_lastRenderedIsAnimated` (`:77, 838`) is write-only. `_startLoadingAnimation` (`:325-340`) runs a 250ms `setInterval` mutating `el.alt` (`Loading...`) on a `display: none` non-active image. Video reload at line 762 calls `Date.now()` instead of using `_reloadTimestamp`.
- **`.style.` compliance check.** All 32 `.style.` writes in `viewerRender.js` set or remove CSS custom properties (`--bridge-*`, `--svg-base-w/h`, `--ico-total-w/h`, `--grill-angle`, `--slot-backdrop-angle`, `--zoom-scale`) or `imgWrapper.style.transform` (`:978`). Zero intrinsic visual properties are written inline.

**Fix.** Remove the `Statusbar` import and publish viewer media status and zoom updates through reactive `Core` state or an injected status callback owned by `statusbar.js` (Sync B with S02). Move `#img-grill`, `#img-grill-border`, and `#viewer-img-wrapper.grill-active` class toggling from `main.js` into `viewerRender.js`. Expand static `.viewer-img` nodes in `index.html` from 2 to 4 (Sync A), delete dead `#viewer-loading-frame` and `.viewer-img.is-placeholder` (R3), and remove `_lastRenderedIsAnimated`, `_startLoadingAnimation`, and unused `LOADING_LABEL`. Use `_reloadTimestamp` consistently on video reloads.

**Telemetry A and B.** Static grep or Mocha contract check confirming 0 `Statusbar` imports in `src/js/viewer/`, 4 static `.viewer-img` nodes, and 0 `#viewer-loading-frame` references. E2E `03-viewer.e2e.js` verifies statusbar filename, dims, zoom, and spread indicator parity; `npm run diagnose -- grill-desync` confirms grill parity.

---

### S06-04 [Blocking] [Agreed] Dead image pool, double `decode()`, video pool contamination, probe leak, and `_admitCompleted` index bug in `manhwaStrip.js`

**Location:** `src/js/viewer/manhwaStrip.js:191-207, 305, 503-523, 1088-1095, 1328, 1342, 1378-1387, 1667, 2620-2625, 2936, 3017, 3029-3035`

**Evidence.**

1. **Dead image pool (`:503-523, 1328, 1667`).** `_acquireNode()` has 0 callers in the repository. Both `_prefetchAhead` (`:1328`) and `_advanceMountQueue` (`:1667`) allocate fresh `new Image()` nodes while `_releaseNode` pushes evicted nodes into `_freePool`, which is never drained.
2. **Double `pre.decode()` (`:1342, 1378, 1383, 1387`).** `_prefetchAhead` calls `pre.decode()` immediately after setting `pre.src` and then calls `await pre.decode()` a second time inside `pre.onload`.
3. **Video pool contamination and leaks (`:191-207, 1088-1095, 2620-2625, 3017`).** `_admitCompleted` (`:3017`) releases evicted `_prefetchedImages` via `_releaseNode(img)` even when the node is a `<video>`, contaminating `_freePool` and breaking the invariant at line 305. Evicting `_prefetching` entries (`:1088-1095`, `:2620-2625`) never clears `onloadedmetadata`, never calls `pause()` or `load()`, and drops video nodes instead of returning them to `_freeVideoPool`. `_probeGateDims` (`:191-207`) constructs throwaway `<video>` and `<img>` elements without clearing `src` or handlers on completion or container change.
4. **Wrong `_mountInFlight` remap (`:2936, 3029-3035`).** `_admitCompleted` rebuilds `_imageIndex` at line 2936 and then indexes into the new `_imageIndex[_mountInFlight]` using the old `_mountInFlight` index at line 3030. Whenever a download completes above the in-flight item, `_mountInFlight` remaps to the wrong entry.

**Fix.** Acquire strip images through `_acquireNode()` in both `_prefetchAhead` and `_advanceMountQueue` so `_freePool` recycles bounded nodes. Remove the redundant eager `pre.decode()` calls at lines 1378, 1383, and 1387 and rely on the single off-DOM `await pre.decode()` inside `pre.onload`. Replace `_releaseNode(img)` with `_releaseStripNode(img)` at line 3017, release evicted `_prefetching` nodes through `_releaseStripNode`, and clear `src` and event handlers on `_probeGateDims` elements once resolved or invalidated. Capture `const inFlightListIndex = _mountInFlight !== -1 ? _imageIndex[_mountInFlight]?.listIndex : undefined` before line 2936 and remap from that saved `listIndex`.

**Telemetry A and B.** Mocha unit tests for `_admitCompleted` index remapping (inserting above and below `_mountInFlight`), pool reuse assertions (0 fresh `new Image()` allocations once `_freePool` is warm), single `decode()` per prefetched image, and strict `IMG` versus `VIDEO` pool segregation. Replay diagnostics on `manhwa-buffer` and `manhwa-video-bridge` confirm 0 regressions.

---

### S06-05 [Blocking] [Agreed] Hot-path layout thrashing, zoom-out re-entrancy, redundant scans, spacer probe bug, and duplicate `ResizeObserver` in `manhwaStrip.js`

**Location:** `src/js/viewer/manhwaStrip.js:94-102, 657-670, 738-753, 803-804, 858, 914-935, 980, 1016, 1047-1050, 1254-1255, 1428, 1820, 1867, 2036-2037, 2094, 2328, 2882-2912, 3087-3095`

**Evidence.**

1. **Forced layout thrash on every pan and zoom tick.** `viewportState.subscribe` writes `_strip.style.transform` and custom properties (`:2892-2894`), calls `ManhwaAudio.syncPills()` (`:2895`, forcing `getBoundingClientRect()` reflow per video), runs `_updateWindow()` (`:2909`, writing spacers and slot DOM), and calls `ManhwaAudio.syncPills()` a second time (`:1255`). Across the hot path, `manhwaStrip.js` also reads `_viewport.clientHeight`, `clientWidth`, and `getBoundingClientRect()` repeatedly (`:803-804, 980, 1016, 1428, 1867, 2036-2037, 2094, 2328`) instead of reading the cached viewport rect from `viewportState.getGeometry().viewport`.
2. **Re-entrant zoom-out rebuilds below 100%.** At `scale < 1`, `seamOverlapForScale(scale)` returns `1 / scale`, changing on every wheel step. Line 2890 calls `_updateLayout()`, which runs O(N) `computeColumnOffsets` and calls `_viewportState.setDimensions()` (`:858`) synchronously inside `viewportState.subscribe`. That re-invokes all subscribers (`viewerRender`, `viewerPipelines`, and `manhwaStrip`) twice per zoom-out wheel tick.
3. **Redundant range searches and O(N) regex scans.** `_updateWindow` calls `_computeVisibleRange()` (`:1047`), then `_positionSlotGrill()` (`:1254`) and `_syncAnchorToCore()` (`:1820`) call `_computeVisibleRange()` again. `_insertSlotOrdered` (`:740`) runs `_strip.querySelectorAll('.manhwa-slot')` on every slot insert. `_onMaxWidthReport` (`:94-102`) and `_onItemDecoded` (`:914-935`) re-run `/\.svg($|[?#])/i` and `FsUtils.isIco` across all N items on every width growth even though `item.kind` is already computed in `_buildImageIndex`.
4. **Locked probe spacer mismatch (R4).** `_updateSpacers` (`:657-670`) writes `--strip-spacer-top` and `--strip-spacer-bottom` on `#manhwa-strip` (`_strip`), whereas locked `e2e/replay-diagnostics/probes/viewerPipelineProbe.js:26-27` reads them on `#manhwa-strip-spacer-top` and `#manhwa-strip-spacer-bottom`. As a result, `spacerTop` and `spacerBottom` always log `0` in diagnostics.
5. **Duplicate `#viewport` `ResizeObserver`.** `manhwaStrip.js:3087-3095` attaches a second `ResizeObserver` to `#viewport` alongside `viewer.js:66-76`. Resizing in manhwa mode triggers both `viewportState.handleViewportResize` and `_applyFitMode`.

**Fix.** Remove the duplicate `ManhwaAudio.syncPills()` call and compute pill coordinates from strip layout geometry (see `S06-08`). Read cached viewport dimensions from `viewportState.getGeometry().viewport`. Pass the computed `{ startIndex, endIndex }` visible range to `_positionSlotGrill` instead of recomputing. Add a silent dimension-update path or defer re-notification when updating `viewportState` dimensions from inside `subscribe` so zoom-out triggers one subscriber pass per tick. Cache `item.isIco` in `_buildImageIndex` to eliminate O(N) regex scans, and find insertion predecessors from `_slots` instead of `querySelectorAll`. Write `--strip-spacer-top` and `--strip-spacer-bottom` directly on `_topSpacer` and `_bottomSpacer` so `viewerPipelineProbe.js:26-27` reports real spacer heights with zero probe edits (R4). Remove the duplicate `ResizeObserver` in `manhwaStrip.js` and route viewport resize notifications from `viewer.js`'s single observer.

**Telemetry A and B.** Mocha unit tests verifying single subscriber notification during zoom-out seam transitions and spacer property placement. Replay diagnostics across `manhwa-buffer`, `manhwa-directory-entry-fits`, `manhwa-first-last-align`, `manhwa-fit-cycle`, `manhwa-width-span` verify non-zero `spacerTop`/`spacerBottom`, 0 blackouts, 0 `ty-teleport` anomalies, and reduced frame-time variance during pan and zoom-out.

---

### S06-06 [Blocking] [Agreed] Monolith decomposition, cross-surface reach-ins, direct IPC, templates, and dead code in `manhwaStrip.js`

**Location:** `src/js/viewer/manhwaStrip.js:17, 27, 376, 519, 547, 637-651, 687-694, 730, 804, 1552, 1616-1625, 1836, 2217-2265, 2717, 2726, 3077`

**Evidence.**

- **3,153-line multi-concern monolith.** Mixes ~55 module-level mutable globals across container width-gating, DOM slot/node pooling, sequential decode and prefetch scheduling, layout/fit/anchor/navigation state, download admission, and Tauri IPC/event listeners.
- **Cross-surface reach-ins.** Imports `Statusbar` (`:17, 1836`) instead of publishing anchor status via state/callbacks (Sync B). Wipes `manhwaAudio`'s DOM directly at line 2717 (`document.getElementById('manhwa-audio-overlay')?.replaceChildren()`). `main.js:210, 239` toggles `#manhwa-strip.grill-active` externally instead of `manhwaStrip.js` owning it (Sync B).
- **Direct Tauri IPC and event bypass.** Calls `window.__TAURI__?.core?.invoke('cancel_width_scan')` (`:2726`) and `window.__TAURI__.event.listen('manhwa-max-width', ...)` (`:3077`) directly even though `FsUtils` owns `scanContainerMaxWidth` (`fsUtils.js:240`) and `cancelDimsScan` (`fsUtils.js:257`) (Sync F).
- **HTML-first violations and duplication.** `_createSlotNode` (`:687-694`) builds `.manhwa-slot` and `.manhwa-slot-backdrop` imperatively instead of cloning a `<template>` in `index.html` (Sync A). Selector `:scope > img, :scope > video, :scope > .ico-container` is duplicated 3 times (`:376, 730, 1552`). `_strip.style.transform` is written redundantly across 12 functions.
- **Dead and redundant code.** `centerListItem` (`:2217-2265`, 49 lines) has 0 production callers (`actions.js:26, 43` only checks `ctx.alignListItemTop || ctx.centerListItem`; `main.js` does not import or pass it; align removal with S01 `actions.js` and `mocha/actions.test.js:178, 181` per R4). Unused `vw` (`:804`), duplicate `STRIP_DEFAULT_VOLUME = 0.5` (`:27`), duplicate `cur !== item` check (`:1616-1625`), and redundant `removeAttribute('style')` (`:519, 547`).
- **`.style.` compliance check.** All 43 `.style.` calls write CSS custom properties or `_strip.style.transform`. Zero intrinsic visual properties are written inline.

**Fix.** Keep `src/js/viewer/manhwaStrip.js` as the thin facade and lifecycle owner preserving exported functions (`initManhwaStrip`, `isManhwaStripActive`, `alignListItemTop`, `alignListItemBottom`, `jumpManhwa`, `navigateManhwa`, `pageStrip`, `resetZoom`, `isStripAtTop`, `getVisibleImageIndices`, `isListIndexMapped`, `getAnchorImgIdx`, `getFirstImageIndex`, `getLastImageIndex`, `getManhwaColumnSnapshot`, `setRevealListTop`, `triggerRevealListTop`, `setOnSlotMounted`, `setOnBridgeHandoff`) and extract three focused siblings under `src/js/viewer/manhwa/`:

1. `stripPool.js`: slot, image, video, and ICO DOM pools, `#manhwa-slot-template` cloning, spacer updates, and `:scope > ...` child cleanup helper.
2. `stripDecodeQueue.js`: sequential off-DOM mount queue, prefetch scheduler, backend archive warm-ahead, and animation probe classification.
3. `stripLayout.js`: width-gate and backend scan coordination, column layout, anchor/fit/navigation state machine, and live download admission.

Route `cancel_width_scan` and `manhwa-max-width` through `FsUtils` (Sync F), remove the `Statusbar` import (Sync B), take ownership of `#manhwa-strip.grill-active` from `main.js` (Sync B), call `ManhwaAudio.detachAll()` instead of clearing `#manhwa-audio-overlay` directly, delete dead `centerListItem` (R4) and nits, and consolidate `_strip.style.transform` writes into one helper.

**Telemetry A and B.** Update `mocha/diagnosticsContract.test.js:68-98` in Telemetry B so literal checks (`manhwa-strip-spacer-top`, `manhwa-strip-spacer-bottom`, `manhwa-slot`, `ico-container`, `dataset.scaling`, `dataset.ready`, `dataset.imgIdx`) scan `manhwaStrip.js` plus `manhwa/{stripPool,stripDecodeQueue,stripLayout}.js` (R4). Run all 7 manhwa replay scenarios plus `03-viewer.e2e.js` and `04-archives.e2e.js`.

---

### S06-07 [Blocking] [Agreed] Broken archive MP4 audio, manhwa ghost audio, duplicate `<audio>` stream, and Core mutation in `viewerAudio.js`

**Location:** `src/js/viewer/viewerAudio.js:46-47, 96-111, 140, 157, 178, 199, 231-234`

**Evidence.**

1. **Archive MP4 audio is broken (`:157`).** In archive mode, `item.path` is the archive-relative entry name. `FsUtils.buildAudioSrc(filePath)` (`fsUtils.js:429-432`) calls `convertFileSrc(entryName)`, generating a 404 asset URL instead of the `quivit://archive/` URL already loaded by `<video>`.
2. **Ghost audio on manhwa toggle (`:140, 231-234`).** `_syncAudioState` never checks `state.manhwaEnabled`, and video event listeners only bind `play` and `seeked` (omitting `pause`). Toggling manhwa view while a single-view video is unmuted pauses `<video>` (`viewerRender.js:694`) and hides `.audio-control-container` (`main.css:1988`), but `<audio id="viewer-audio">` keeps playing invisibly.
3. **Duplicate MP4 fetch, decode, and A/V drift (`:189-207`).** Maintaining a separate `<audio id="viewer-audio">` fetches and demuxes every MP4 twice while `viewerRender.js:237` hard-mutes `<video>`, then chases sync with a 150ms drift window (`:199`) and misses `pause`, loop wrap, and buffering stalls. Repo-wide search confirmed 0 references to `#viewer-audio` in `src/css/`, `mocha/`, `e2e/`, or replay probes.
4. **Core list item mutation and idle reset churn (`:46-47, 96-111, 178`).** `_saveFileAudioState` and `_syncAudioState` mutate Core's `state.list[i]` items (`item._audioMuted`, `item._audioVolume`, `item.hasSound`). `_resetAudio()` calls `_audioEl.removeAttribute('src')`, `_audioEl.load()`, and `_updateUI()` on every image-to-image navigation even when already idle.

**Fix.** Retire `<audio id="viewer-audio">` (`src/index.html:421`, Sync A) and bind `viewerAudio.js` directly to the active `<video>` element's `.muted` and `.volume` (matching `manhwaAudio.js`), coordinated through `ViewerAudio.bindVideo(videoEl)` or a `viewerRender.js` callback. This resolves archive MP4 audio, double fetch and decode, A/V sync drift, and manhwa ghost audio together, and allows S01 to delete dead `FsUtils.buildAudioSrc` (R4). Move per-file mute, volume, `checkMediaAudio` track caching, volume stepping, and `data-state` mapping into a shared pure store `src/js/services/mediaAudioState.js` (zero DOM) consumed by both `viewerAudio.js` and `manhwaAudio.js`. Stop mutating `state.list` items, guard `_syncAudioState` on `state.manhwaEnabled`, and early-return in `_resetAudio()` when already idle.

**Telemetry A and B.** Mocha unit tests for `services/mediaAudioState.js` (disk and archive cache keys, single to manhwa state persistence, state label mapping, manhwa-enabled reset). E2E `03-viewer.e2e.js` and `04-archives.e2e.js` verify single-view and archive MP4 audio unmute, mute state persistence across manhwa toggle, and immediate silence on manhwa entry.

---

### S06-08 [Blocking] [Agreed] Forced layout per frame, unpooled pill churn, and silent-video toggle bug in `manhwaAudio.js`

**Location:** `src/js/viewer/manhwaAudio.js:12-19, 101-114, 124-180, 196-199, 230, 240-262`

**Evidence.**

1. **Per-frame forced synchronous layout (`:159-180`).** `_positionPill` re-queries `document.getElementById('manhwa-audio-overlay')` and `document.getElementById('viewport')`, then reads `targetEl.getBoundingClientRect()` and `vp.getBoundingClientRect()` on every pan and zoom tick right after `manhwaStrip.js` writes `_strip.style.transform` (and runs twice per tick due to `manhwaStrip.js:2895, 1255`).
2. **Unpooled pill clone and remove churn (`:124-157, 212-218, 230`).** Every `attachSlotAudio` clones `#manhwa-volume-template` and appends it to `#manhwa-audio-overlay` before `_probeTrack` knows whether the video has sound, then calls `pill.remove()` if `!hasAudio` or on every `detachSlotAudio`.
3. **Silent-video unmute bug (`:196-199, 240-262`).** When `_probeTrack` sees `!hasAudio`, it removes `live.pill` and sets `live.pill = null`, but leaves `rec` inside `_attached`. Pressing the mute toggle (`toggleStripMute`) on a silent anchor video still sets `muted: false` and marks `_audibleImgIdx` to that silent video. `setSlotVolume(imgIdx, 0)` (`:101-114`) also fails to clear `_audibleImgIdx`.
4. **Duplicated audio store (`:12-46`).** Duplicates `BoundedMap` caches and volume logic from `viewerAudio.js`, losing volume state and re-invoking `check_media_audio` IPC when toggling between single view and manhwa view.

**Fix.** Cache `#manhwa-audio-overlay` and `#viewport` once in `initManhwaAudio`, and compute pill `(x, y)` directly from strip layout offsets and `viewportState.getGeometry()` (zero `getBoundingClientRect()` calls, invoked once per frame). Consume shared `src/js/services/mediaAudioState.js`. Probe audio availability (hitting the shared cache first) before acquiring a pill node from a bounded free pool (`STRIP_VIDEO_POOL_CAP = 4`, toggling `.is-visible` instead of cloning and removing). Remove silent entries from `_attached` (or guard on `rec.hasAudio`) so `toggleStripMute` skips silent slots, clear `_audibleImgIdx` when volume reaches 0, and export `detachAll()` so `manhwaStrip.js:2717` drops its foreign DOM wipe.

**Telemetry A and B.** Mocha unit tests covering reflow-free pill coordinate math, shared `mediaAudioState.js` cache reuse across single and manhwa modes, silent-slot `toggleStripMute` exclusion, and bounded pill pool reuse (0 `getBoundingClientRect` calls in `syncPills`). Replay diagnostics on `manhwa-video-bridge` verify 0 layout regressions.

---

### S06-09 [Blocking] [Agreed] Foreign DOM reach-in, E2E test-ID leak, `activeKeys` race, and 60Hz in-window IPC polling in `viewerGestures.js`

**Location:** `src/js/viewer/viewerGestures.js:2, 6-9, 45-70, 87, 96, 157-160, 192-264, 278, 310, 328-333, 350, 372-373`

**Evidence.**

1. **Cross-module and foreign DOM reach-in plus E2E ID leak (`:2, 49-66, 278, 350`).** Imports mutable `activeKeys` from `../shortcuts.js` and relies on `setTimeout(..., 0)` (`:350`) to race `shortcuts.js`'s `keydown` listener. Queries `#drop-overlay`, `#password-overlay`, `#menubar .menu-item.open`, `#file-panel`, `#statusbar`, and `#quivit-recorder-badge` (leaking an E2E recorder shim ID into production `src/`), while omitting `#url-overlay` so cursor auto-hide and pan remain active when the URL prompt is open.
2. **60Hz IPC cursor polling while inside the window (`:192-264`).** Holding a keyboard pan key runs `setInterval(_pollCursor, 16)` calling Tauri `window.cursorPosition()` 60 times per second even while the cursor is inside the window, where DOM `mousemove` is authoritative and lines 248 to 250 discard the IPC result.
3. **Hot-path timer, state, and DOM churn (`:58, 87, 96, 328-333`).** Every `pointermove` pixel resets `setTimeout` and calls `Core.getState()` twice (`_isAutoHideEnabled` and `_getDelayMs`). `#viewport` is re-queried by ID inside `_isMouseOverViewportNow`, `_showCursor`, and `_hideCursor`. Global `window` listeners (`:132, 345-368`) have no teardown and stay active in detached `?surface=fileList`.
4. **Dead variables and exports (`:6-9, 157-160, 372-373`).** `_panStartX`, `_panStartY`, `_panOriginTx`, and `_panOriginTy` are write-only. Returned `showCursor` and `hideCursor` have 0 callers.

**Fix.** Inject `isViewportInteractive(x, y)`, `isMenuOpen()`, and pan-key query callbacks from `viewer.js` / `main.js` (checking `[data-ui]` and covering `#url-overlay` alongside other overlays, removing `#quivit-recorder-badge` and the `setTimeout(..., 0)` race while staying compatible with S01 `shortcuts.js` `activeKeys` under R4). Cache the `#viewport` element and `hide_cursor_delay_sec` on config load. Start Tauri `cursorPosition()` polling only when the cursor leaves the window during active key-pan and stop on `mouseenter`. Add a `dispose()` teardown (and skip initialization in `?surface=fileList` via `initViewer()`), and delete the dead variables and exports.

**Telemetry A and B.** Mocha unit tests for gesture pan state, cursor auto-hide timer caching, and outside-window-only cursor polling. E2E `03-viewer.e2e.js` verifies viewport pan and cursor auto-hide behavior plus detached `?surface=fileList` listener isolation.

---

### S06-10 [Blocking] [Agreed] Reverse layer import, per-frame composite allocations, dead exports, and probe `NaN` quirk in `viewerMath.js`

**Location:** `src/js/services/viewerMath.js:1, 4, 28-42, 86, 263, 270, 355-394, 400, 434, 491, 575, 698-699`

**Evidence.**

1. **Pure-service reverse import (`:1`).** `viewerMath.js` imports `DEFAULT_FIT_MODE` from `../keybinds.js`, pulling the higher-level `keybinds.js -> actions.js / registry.js / workspaceLayout.js` graph into a leaf pure math module.
2. **Per-frame object allocations and duplicated alias keys (`:355-394, 434, 491`).** `computeColumnComposite` runs on every WebGL manhwa frame and allocates `sourceRect`, `destRect`, and `unclippedDestRect` with duplicated keys (`x/sx`, `y/sy`, `width/sw`, `height/sh`, `dx/dy/dw/dh`) plus duplicated `drawList` and `draws` return keys. `isSpreadActive` (`:434`) and `applyFitMode` (`:491`) allocate a fresh `['width', 'width-if-larger']` array on every call.
3. **Dead code and broken `subscribe` return (`:4, 28-42, 86, 263, 270, 400, 575, 698`).** `computeStripWidth` (`:28-42`) and `computeColumnLayout` (`:86`) have 0 production callers (only `mocha/viewerMath.test.js`); `computeColumnDrawList` (`:400`) has 0 callers anywhere; `SPREAD_PAN_RETURN_TO_TOP = true` (`:4, 575`) is a constant flag; `widestWidth` (`:263, 270`) is unused. `subscribe(fn)` (`:698`) returns `listeners.push(fn)` (the array length) instead of an unsubscribe function.
4. **Locked `viewerPipelineProbe.js` `ty-teleport` bug (R4).** `viewerMath.js:699` formats `translate(calc(-50% + ${_tx}px), calc(-50% + ${_ty}px))`. `e2e/replay-diagnostics/probes/viewerPipelineProbe.js:19-20` runs `parseFloat("calc(-50% + 123px)")`, which evaluates to `NaN`, leaving the `ty-teleport` detector (`:244`) inert on every replay run.

**Fix.** Consume `DEFAULT_FIT_MODE` from S01's `src/js/services/configSchema.js` (or an injected `defaultFitMode` option on `createViewportState`), eliminating the `../keybinds.js` import (Sync B). Relocate `computeSlotHue` from `src/js/services/keybindDomain.js:32-47` (S01) and `mirroredGrillAngle` from `src/js/viewer/icoCells.js:10-12` into `viewerMath.js`. Standardize `computeColumnComposite` on canonical `{ x, y, width, height }` and `drawList` atomically with S07 (`viewerPipelines.js:38-52`, `quadCompositor.js`) and `mocha/viewerMath.test.js:836-937` (R4). Use a module-scope `Set` for width-fit checks, return an unsubscribe function from `subscribe`, and delete dead `computeStripWidth`, `computeColumnLayout`, `computeColumnDrawList`, `widestWidth`, and `SPREAD_PAN_RETURN_TO_TOP`. Keep `viewerMath.js:699` CSS transform syntax unchanged and fix `viewerPipelineProbe.js:19-20` in Telemetry A to parse `calc(-50% + <num>px)` (R4).

**Telemetry A and B.** Expand `mocha/viewerMath.test.js` in Telemetry A for `DEFAULT_FIT_MODE` seam, `computeSlotHue`, `mirroredGrillAngle`, `subscribe()` unsubscribe, and `viewerPipelineProbe.js` `calc(-50% + <num>px)` parsing. Update `mocha/viewerMath.test.js` in Telemetry B when removing dead exports and duplicate rect aliases.

---

### S06-11 [Warning] [Agreed] Imperative DOM creation, serial composite decode, and duplicated ICO loop in `icoCells.js`

**Location:** `src/js/viewer/icoCells.js:10-57`

**Evidence.** `createIcoContainer()` (`:14-18`) and `createIcoCell()` (`:20-34`) use `document.createElement` instead of cloning static `<template>` markup in `index.html`. `mirroredGrillAngle` (`:10-12`) is pure math living inside a DOM factory (`mocha/viewerMath.test.js:997` imports it). `buildIcoCompositeCanvas` (`:46-55`, consumed by S07 `viewerPipelines.js:3`) awaits `loadImage(s.data_url)` serially inside a `for` loop instead of decoding frames in parallel. In addition, `viewerRender.js:495-507` and `manhwaStrip.js:384-396` duplicate the same ICO cell attribute setup and append loop.

**Fix.** Move `mirroredGrillAngle` to `viewerMath.js` (keeping a compatibility re-export if needed until Telemetry B updates `mocha/viewerMath.test.js:997`). Clone `#ico-container-template` and `#ico-size-template` declared in `index.html` (Sync A). Decode all valid ICO frames in parallel via `Promise.all` inside `buildIcoCompositeCanvas` before drawing them left to right. Extract a shared `populateIcoContainer(sizes, opts)` helper used by both `viewerRender.js` and `manhwaStrip.js`.

**Telemetry A and B.** Mocha unit test for parallel `buildIcoCompositeCanvas` draw order and `mirroredGrillAngle`. E2E `03-viewer.e2e.js` ICO row and legacy-to-manhwa-to-legacy continuity test.

---

### S06-12 [Warning] [Agreed] Eager top-level initialization, detached window waste, duplicate `ResizeObserver`, and uncancellable `_doubleRaf` in `viewer.js`

**Location:** `src/js/viewer/viewer.js:23-78, 92`

**Evidence.** Importing `Viewer` from `viewer.js` (`src/js/main/main.js:7`) immediately executes `_updateCachedViewport()`, `createViewerPipelines`, `createViewerRenderer`, `createViewerGestures`, `initManhwaStrip`, `new ResizeObserver`, and `window.addEventListener('resize', ...)` at module load time, even inside the detached `?surface=fileList` window where `#viewport` is `display: none`. `main.js:275` also calls `initManhwaStrip()` redundantly (no-op via `_initialized`). `_doubleRaf` inside `setOnSlotMounted` (`:45-59`) is uncancellable, so rapid manhwa on -> off -> on toggling within 2 frames can fire `renderer.releaseBridge()` against a fresh bridge. `Viewer.handleViewportResize` (`:92`) has 0 external callers in `src/`.

**Fix.** Replace module-top-level initialization with an explicit `initViewer()` called by `main.js` only when `hostsWorkspaceSurface('viewport')` is true (preserving the `Viewer` export object for `e2e/replay-diagnostics/runner.e2e.js:342`). Remove the redundant `initManhwaStrip()` call at `main.js:275`. Make `setOnSlotMounted`'s `_doubleRaf` cancellable (tracked generation or `cancelAnimationFrame`). Have `viewer.js`'s single `#viewport` `ResizeObserver` notify `manhwaStrip` when active (removing `manhwaStrip.js:3087-3095`). Delete unused `Viewer.handleViewportResize`.

**Telemetry A and B.** E2E test confirming detached `?surface=fileList` does not initialize viewer pools, gestures, or strip listeners, and re-docking or main-window startup initializes once. Replay diagnostics on `manhwa-gif-bridge` and `manhwa-video-bridge` verify rapid manhwa toggles leave 0 stuck bridges and 0 blackouts.

---

## Decomposition summary

- `src/js/viewer/manhwaStrip.js` (3,153 lines) splits into facade `manhwaStrip.js` plus `src/js/viewer/manhwa/{stripPool,stripDecodeQueue,stripLayout}.js`.
- `src/js/viewer/viewerRender.js` (993 lines) splits out `src/js/viewer/viewerBridge.js` (sole `#viewer-bridge-layer` owner) while keeping single-image, dual-video, and ICO coordination inside `viewerRender.js` (sole `#viewer-img-wrapper` owner).
- `src/js/services/mediaAudioState.js` (new pure module, 0 DOM imports) unifies volume/mute state and `check_media_audio` caching for both `viewerAudio.js` and `manhwaAudio.js`.
- `src/js/viewer/viewer.js`, `viewerGestures.js`, `icoCells.js`, and `services/viewerMath.js` stay in place with clean boundaries and zero reverse imports.

## Cross-split seams

All seams align with `.agents/major-refactor/cross-split-seams.md` (`#116` and `#131`).

### Sync A (Main HTML and CSS with S02 and S07)
- `src/index.html`: Expand static `.viewer-img` pool from 2 (`:405-406`) to 4; delete dead `#viewer-loading-frame` (`:400`) and `<audio id="viewer-audio">` (`:421`); add `<template id="manhwa-slot-template">`, `<template id="ico-container-template">`, and `<template id="ico-size-template">`. Preserve all locked IDs (`#viewport`, `#viewer-img-wrapper`, `#viewer-bridge-layer`, `#viewer-ico-row`, `#viewer-video`, `#viewer-video-b`, `#manhwa-strip`, `#manhwa-slot-grill`, `#manhwa-strip-spacer-top`, `#manhwa-strip-spacer-bottom`, `#manhwa-audio-overlay`, `#manhwa-volume-template`, `.audio-control-container`, `#btn-audio-toggle`, `#audio-volume-popover`, `#audio-volume-slider`).
- `src/css/global.css` and `src/css/main.css` -> `src/css/viewer.css`: Delete dead `.viewer-img.is-placeholder` (`global.css:274-276`, R3); migrate viewport, single-viewer, bridge, ICO, manhwa strip, audio pill, and cursor-hidden rules into `viewer.css` while deduplicating grill/volume CSS and fixing `#viewport.cursor-hidden *`.

### Sync B (Viewer, WebGL, Probes, Statusbar, and Keybinds with S01, S02, and S07)
- **S01:** Consume `DEFAULT_FIT_MODE` from `services/configSchema.js` (dropping `viewerMath.js:1 -> ../keybinds.js`); move `computeSlotHue` out of `services/keybindDomain.js:32-47` into `viewerMath.js`; align removal of `centerListItem` (`actions.js:26, 43`, `mocha/actions.test.js:178, 181`) and `FsUtils.buildAudioSrc` (`fsUtils.js:429-432`) per R4; maintain `shortcuts.js` `activeKeys` compatibility during `viewerGestures.js` callback migration.
- **S02:** Remove all imperative `Statusbar` calls from `viewerRender.js` (15 sites) and `manhwaStrip.js:1836`; move `#img-grill`, `#img-grill-border`, `#viewer-img-wrapper.grill-active`, and `#manhwa-strip.grill-active` writes out of `main.js:208-210, 228-239` into `viewerRender.js` and `manhwaStrip.js`; call explicit `initViewer()` gated by `hostsWorkspaceSurface('viewport')` and drop redundant `main.js:275` `initManhwaStrip()`.
- **S07:** Preserve `createViewerPipelines(viewportState)` API (`setSource`, `clear`, `forceRender`, `setColumnSource`, `notifyColumnChanged`), `getManhwaColumnSnapshot()` shape, `buildIcoCompositeCanvas`, `getEffectiveScaling`, `icoSizesTotal`, and `invertViewport`. Coordinate atomic `computeColumnComposite` `{ x, y, width, height }` and `drawList` cleanup across `viewerMath.js`, `viewerPipelines.js:38-52`, `quadCompositor.js`, and `mocha/viewerMath.test.js:836-937` (R4).
- **Locked probes and contracts (R4):** Fix `e2e/replay-diagnostics/probes/viewerPipelineProbe.js:19-20` in Telemetry A to parse `calc(-50% + <num>px)` without altering `viewerMath.js:699`; write `--strip-spacer-top/bottom` directly on `#manhwa-strip-spacer-top/bottom` so `viewerPipelineProbe.js:26-27` works with zero probe edit; update `mocha/diagnosticsContract.test.js:68-98` in Telemetry B to cover `manhwa/{stripPool,stripDecodeQueue,stripLayout}.js` and `viewerBridge.js`. Preserve `Viewer` export for `e2e/replay-diagnostics/runner.e2e.js:342`.

### Sync F (Media, Protocol, Width Scan, and ICO with S01 and S09)
- Route `manhwaStrip.js:2726` `cancel_width_scan` and `:3077` `manhwa-max-width` listener through `FsUtils` facade (preserving `manhwa-max-width` `{ container, max_width, done }` event and `cancel_width_scan` IPC in `src-tauri/src/commands/animation.rs`).
- Preserve `quivit://archive/`, `quivit://tiff/`, `get_ico_frames`, `get_archive_ico_frames` (`src-tauri/src/ico.rs`), and `check_media_audio` (`src-tauri/src/commands/animation.rs`).

## Telemetry A and B plan

### 1. Mocha unit tests (`npm run mocha`)
- **Existing coverage:** `mocha/viewerMath.test.js` (including `icoCells.js:mirroredGrillAngle`), `mocha/diagnosticsContract.test.js`, `mocha/actions.test.js`.
- **Telemetry A additions (before production edits):**
  - `mocha/mediaAudioState.test.js`: disk and archive track cache keys, single-to-manhwa preference persistence, silent-slot toggle guard, volume clamping/stepping, and manhwa-active audio reset.
  - `mocha/viewerBridge.test.js`: pure bridge retirement state machine covering rapid A to B to A reclamation, async ICO decode gating, video to image parking, and cancellable double-rAF release.
  - `mocha/viewerStripLogic.test.js`: adaptive 45ms debounce cadence, `_admitCompleted` `_mountInFlight` index remapping (insert above and below), zoom-out single-pass dimension update, reflow-free pill coordinate math, and outside-window-only gesture cursor polling.
  - Expand `mocha/viewerMath.test.js`: `DEFAULT_FIT_MODE` seam, `computeSlotHue`, `subscribe()` unsubscribe, and `viewerPipelineProbe.js:19-20` `calc(-50% + <num>px)` parser unit check (R4).
- **Telemetry B updates and assertions (after production edits):**
  - Update `mocha/diagnosticsContract.test.js:68-98` to scan extracted `manhwa/{stripPool,stripDecodeQueue,stripLayout}.js` and `viewerBridge.js` (R4).
  - Update `mocha/viewerMath.test.js` for canonical `computeColumnComposite` `{ x, y, width, height }` / `drawList` and removed dead exports (`computeStripWidth`, `computeColumnLayout`, `computeColumnDrawList`).
  - Verify static/perf invariants: 0 `Statusbar` imports in `src/js/viewer/`, 0 `getBoundingClientRect` calls in `manhwaAudio.syncPills`, 0 throwaway `new Image()` allocations on warm pool preload, 0 double `decode()` calls in strip prefetch, and strict `IMG`/`VIDEO` pool segregation.

### 2. Desktop E2E tests (`npm run e2e -- --spec <file>`)
- **Specs:** `e2e/specs/02-navigation.e2e.js`, `e2e/specs/03-viewer.e2e.js`, `e2e/specs/04-archives.e2e.js`.
- **Existing coverage:** Fit modes, zoom/pan, spread view, manhwa toggle, manhwa filters, legacy-to-manhwa-to-legacy ICO row and bridge continuity.
- **Telemetry A additions:**
  - Detached `?surface=fileList` parity confirming viewer pools, strip, and gesture listeners do not initialize in the detached file list window.
  - Single-view disk and archive MP4 audio unmute, volume persistence across manhwa toggle, and immediate silence on manhwa entry.
  - Rapid A to B to A image navigation and video to image transitions with 0 missing images and empty `#viewer-bridge-layer`.
- **Telemetry B verification:** Re-run all 3 specs confirming 1:1 UX parity and zero regressions.

### 3. Replay diagnostics (`npm run diagnose -- <scenario>`)
- **Scenarios (10):** `sample-navigation`, `zoom-bridge-stale-size`, `grill-desync`, `manhwa-buffer`, `manhwa-directory-entry-fits`, `manhwa-first-last-align`, `manhwa-fit-cycle`, `manhwa-gif-bridge`, `manhwa-video-bridge`, `manhwa-width-span`.
- **Telemetry A baseline:** Fix `viewerPipelineProbe.js:19-20` `calc(-50% + ...)` parsing first (R4), then capture baseline JSON for blackout frames, `ty-teleport` anomalies, `spacerTop`/`spacerBottom`, `jankFrameCount`, and swap latency (`image-decode-end` to `img-role-change` `active`).
- **Telemetry B proof:** 0 blackout frames, 0 `ty-teleport` anomalies, valid non-zero `spacerTop`/`spacerBottom` in manhwa scenarios, and measurable ~45ms single-step swap latency reduction on preloaded next and previous steps in `sample-navigation`.

### 4. Rust backend tests (`cargo test --manifest-path src-tauri/Cargo.toml`)
- **Scope (read-only Sync F verification):** Run `cargo test --manifest-path src-tauri/Cargo.toml format_tests` and `ico` checks to verify `check_mp4_has_audio`, ICO extraction, and `manhwa-max-width` contracts remain untouched and passing.
