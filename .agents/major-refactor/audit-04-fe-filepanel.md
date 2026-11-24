# Split S04 audit: fe-filepanel

Stage 3 audit for `S04 fe-filepanel`, covering `src/js/filepanel/filePanel.js`, `src/js/filepanel/favoritesStore.js`, and `src/js/filepanel/libraryStore.js`. All findings, remediations, cross-split seams, and Telemetry A and B specs below reached unanimous consensus between `s04-panel-perf` (#62) and `s04-panel-arch` (#46, #64), and passed cross-split seam ratification (#68, #116, #124, #132).

## File inventory and status

| File | Lines | Status | Summary |
|---|---|---|---|
| `src/js/filepanel/filePanel.js` | 3,478 | Remediate (`S04-01` through `S04-12`) | Mixed DOM owner (46 `createElement`, 13 `innerHTML`, 1 `outerHTML`, 23 `.style.` writes), virtual-scroll and resize reflows, `/archive/` thumbnail re-decode loop, `window.focus` wiping `icon:*`, and detached `?surface=fileList` double execution |
| `src/js/filepanel/favoritesStore.js` | 272 | Remediate (`S04-13`, `S04-14`) | Top-level `window` and `__TAURI__` coupling, per-read re-normalization, double immediate config flush, and case-sensitive Windows path reconciliation |
| `src/js/filepanel/libraryStore.js` | 232 | Remediate (`S04-15` through `S04-17`) | Unguarded `window.__TAURI__`, per-provider `localStorage` JSON parsing, side-effecting `orderProviders`, and dead `getLibraryCollapsed` / `saveLibraryCollapsed` exports |

Counts above were verified directly on disk. Zero files in S04 are cohesive as written, 0 candidate findings were dropped, and 0 items were escalated.

## Findings and agreed fixes

### `src/js/filepanel/filePanel.js`

- **`S04-01` [Blocking] [Agreed] HTML-first `<template>` and `innerHTML` violations (`L464`, `L774-777`, `L801-833`, `L895-1003`, `L1078-1094`, `L1248-1592`, `L1640-1704`, `L1812`, `L1860-1870`, `L1907-2015`).**
  `createPoolRow()` runs 13 `createElement` calls and parses 5 inline SVGs via `PLACEHOLDER_HTML` (`L464,1981`). `buildSavedEntry()` (`L895-1003`) and `buildLibraryEntry()` (`L1248-1592`) duplicate row construction (~27 `createElement` calls plus `innerHTML` at `L909,935,963,1260,1287,1317,1323,1340`). `renderFavorites()` (`L1094`) and `renderLibrary()` (`L1640`) wipe containers with `innerHTML = ''` on every update. `fetchNativeIcon()` (`L777`) replaces saved-row `<img>` nodes via `img.outerHTML = svgContent`, and `L1080,1087,1863` duplicate elements already declared in `src/index.html:226,269`.
  **Agreed fix.** Add 3 static `<template>` elements to `src/index.html`: `#file-list-row-template`, `#saved-entry-row-template`, and `#library-provider-template`. Pre-place both `<img class="item-icon-img">` and static `<span class="item-icon-svg">` plus the 5 `.placeholder-icon` SVGs inside those templates, and pre-place both confirm/disarm SVGs on `.lib-remove` toggled by `.is-confirming`. Reconcile Favorites and Library lists by `data-path` instead of clearing with `innerHTML = ''`, remove `PLACEHOLDER_HTML`, `getIconHtml()`, `outerHTML` replacement, and the redundant `L1080,1087,1863` `createElement` fallbacks.

- **`S04-02` [Blocking] [Agreed] CSS source-of-truth and variable scoping (`L140-143`, `L551-553`, `L670`, `L772-775`, `L1807-1819`, `L1909-1922`, `L2053-2054`, `L2255-2256`, `L2269`, `L2290-2291`, `L2327-2328`, `L2748`, `L3399`).**
  `filePanel.js` sets inline `.style.display` across pooled rows and icon slots (`L772,775,1807,1810,1818,1819,1909,1918,1922,2054,2255,2327`), writes inline `.style.top` on virtualized `<li>` nodes (`L2053,2256,2328`) and `.style.height` on `.scroll-spacer` (`L2269,2291`), sets `svg.setAttribute('fill', ...)` (`L670,2748`), and writes `--file-grid-cols` and `--col-*-w` on `document.documentElement` (`L142,552`) even though `src/css/main.css:1148,1292` only consume them inside `#file-panel`.
  **Agreed fix.** Move file-panel, favorites, library, and thumbnail rules from `src/css/main.css` into `src/css/file-panel.css` (linked after `main.css`), and move `--panel-*`, `--resize-handle-w`, `--col-*`, and `--file-grid-cols` from `src/css/global.css:43-53` into `file-panel.css`. Scope `--col-*-w` and `--file-grid-cols` onto `#file-panel` (keep `--panel-w`/`--panel-h` on `#workspace`). Replace `.style.display` with `.is-pooled-hidden` and `data-icon-mode` / `data-fallback-type` rules, replace `.style.top` with `transform: translateY(...)`, set `--scroll-spacer-h` on `.scroll-spacer`, and style `#btn-favorite-current.active svg { fill: currentColor; }` in CSS.

- **`S04-03` [Blocking] [Agreed] Cross-panel DOM reach-in and broken detached viewport focus (`L2821-2836`, `L3292`).**
  `isPointerOverActiveViewport()` (`L2821-2836`) queries `#drop-overlay`, `#password-overlay`, and `#viewport` directly. Line `L3292` calls `document.getElementById('viewport')?.focus()`, which silently fails in detached `?surface=fileList` where `#viewport` is `display: none`. Outside `filePanel.js`, `src/js/main/main.js:156-157` queries `#favorites-list` and `#file-panel-library`, and `src/js/main/urlOverlay.js:167-201` attaches a 14-selector listener to `#file-panel`.
  **Agreed fix.** Inject `isPointerOverActiveViewport` and `focusViewport` via `initFilePanel(deps)` (routing `focusViewport` through `workspaceControls.restoreFocus('main')` when detached), export `isFavoritesFocused()` and `isLibraryFocused()` for `main.js`, and emit/invoke an `onItemPointerDown` callback so `urlOverlay.js` drops its 14-selector reach-in.

- **`S04-04` [Blocking] [Agreed] Monolithic file decomposition (`L1-3478`).**
  `filePanel.js` mixes pure math, native shell icon caching, thumbnail scheduling, container dimensions caching, Favorites DOM, Library DOM, column resizing, and `#file-list` virtualization in 3,478 lines.
  **Agreed fix.** Split by single owner with zero circular imports and zero shared DOM writes:
  1. `src/js/services/filePanelMath.js` (zero DOM): `pathsEqual`, `formatByteSize`, `formatDimsText`, `formatBreadcrumbPath`, `formatLibraryDate`, `getPlaceholderType`, `isPendingDownload`, `computeColumnWidths`, `computeVisibleSlice`, `computeSelectionScrollTop`, `computeNextSearchMatch`, `resolveLibraryProviderRoot`, `findDeepestLibraryAncestor`.
  2. `src/js/filepanel/nativeIconCache.js`: bounded `iconCache`, `NATIVE_ICON_STORAGE_VERSION`, migration, `get_native_icon` / `invalidate_native_icon_cache`, and shared icon-slot rendering.
  3. `src/js/filepanel/thumbnailPipeline.js`: `thumbnailCache`, `staticIconCache`, `animatedSvgSrcs`, `dimsCache`, `container-dimensions` hydration, saved-row thumbnail wiring, and the bounded thumbnail decode queue.
  4. `src/js/filepanel/favoritesPanel.js`: sole writer for `#file-panel-favorites`, `#favorites-list`, and `#btn-favorite-current`.
  5. `src/js/filepanel/libraryPanel.js`: sole writer for `#file-panel-library`, provider foldouts, and optimistic recycle-bin delete with rollback.
  6. `src/js/filepanel/filePanel.js`: sole owner of `#file-panel` shell, breadcrumb, columns/sort, `#file-list` virtual pool, search input, and resize handle.

- **`S04-05` [Blocking] [Agreed] Archive thumbnails never marked cached, causing repeated re-decodes (`L1966-1971`, `L2147`, `L2349-2353`, `L2419`).**
  In `createPoolRow()`, `thumbImg.onload` calls `ensureArchiveBlob(src)` for `/archive/` URLs without calling `thumbnailCache.set(src, true)` (unlike `initSavedThumbnail` at `L313`). When a row scrolls 2 items past the viewport, Phase 1b (`L2349-2353`) clears `img.src = TRANSPARENT_PIXEL` because `/archive/` passes `FsUtils.isConstrainedThumbnailSrc(src)`. Scrolling back always misses `thumbnailCache.get(targetSrc)` (`L2147`), forcing another scroll-debounce wait, timer stagger, and decode.
  **Agreed fix.** Record `thumbnailCache.set(src, true)` in the shared list-row `onload` path for `/archive/` entries, and skip Phase 1b blanking while an entry remains cached and within decoded budget.

- **`S04-06` [Blocking] [Agreed] `window.focus` wipes all `icon:*` caches on every focus switch (`L3129-3132`, `L727-743`).**
  `window.addEventListener('focus', ...)` calls `refreshNativeIcons()` (`L727-743`), which invokes `invalidate_native_icon_cache` in Rust, clears `iconCache`, deletes every `icon:*` key from `localStorage`, and runs `redrawNativeIcons()` plus `renderLibrary()` (a full `read_library_tree` disk walk). Every Alt+Tab or window click destroys the persistent icon cache described in `AGENTS.md` Example #2.
  **Agreed fix.** Remove `refreshNativeIcons()` from the `window.focus` listener, keep `refreshNativeIcons()` only for explicit user refresh or file-association updates, and gate `refreshFilesystemState()` on `hostsWorkspaceSurface('fileList')`.

- **`S04-07` [Blocking] [Agreed] Detached `?surface=fileList` duplicate work and double `dims` RPC (`L2665`, `L2949-3164`, `L3079-3126`, `L3117-3125`).**
  `main.js:248` calls `initFilePanel` in both windows. Although `renderFilePanel` returns early at `L2665` when `!hostsWorkspaceSurface('fileList')`, `main` still executes `renderFavorites()`, `renderLibrary()` (`fetchLibraryTree` plus `get_file_sizes` plus hidden thumbnail loads), `refreshFilesystemState()`, `refreshNativeIcons()`, and `container-dimensions`. On `dims` sort, `L3117-3125` fires `Core.setListAndIndex(sortedList, ...)` from both windows, shipping the entire `sortedList` array back over `workspaceSession` RPC.
  **Agreed fix.** Gate all file-panel event listeners, timers, `renderFavorites`, `renderLibrary`, `refreshFilesystemState`, and `container-dimensions` handling on `hostsWorkspaceSurface('fileList')`, re-hydrating when re-docked. Route `dims` re-sorts through `Core.applyDirectorySort(path, col, desc)` (`CORE_SESSION_METHODS`).

- **`S04-08` [Warning] [Agreed] Sequential `setTimeout` thumbnail queue, SVG `checkIsAnimated` IPC spam, and repeated `setThumbnailIcon` (`L196-202`, `L271-277`, `L2176-2236`, `L2384-2474`).**
  `commitPendingThumbnails()` schedules an untracked `setTimeout(..., 10 + orderIdx * 15)` per row (`L2469`) that cannot be cancelled on fast scroll and polls `viewerBlobPending` with blind `120ms` timers (`L2228,2461`) instead of awaiting `ensureArchiveBlob()`. It pairs `loading="lazy"` (`L2207,2442`) with manual viewport deferral, fires uncached `Core.checkIsAnimated` IPCs per SVG after `src` assignment (`L2200,2226,2232,2436,2458,2467`), and calls `setThumbnailIcon` (`L275` CSS property write) even when the extension is unchanged.
  **Agreed fix.** Replace timer staggers with a generation-cancelled concurrency-limited queue (1 to 2 constrained images in scroll direction, awaiting `ensureArchiveBlob` when viewer fetch is active), remove `loading="lazy"` on pooled visible thumbnails, move `markIfAnimatedSvg` gating ahead of/memoized against `Core`, and guard `setThumbnailIcon` with the previous `iconSrc`.

- **`S04-09` [Warning] [Agreed] Pre-guard work in `renderFilePanel` and synchronous layout thrash (`L211-232`, `L551-638`, `L2057-2089`, `L2248-2376`, `L2699-2730`, `L2937-2947`, `L3388-3419`).**
  1. `renderFilePanel()` runs `applyColumnVisibilityClasses`, `syncContainerDimensions` (scanning all items in `hydrateCachedDimensions`), and `updateSortIcons` (`querySelectorAll`) before the deduplication guard at `L2721-2730`, firing on every zoom, pan, or filter state change.
  2. `recalculateMinColWidths()` (`L211-232`) appends clones to `document.body` and calls `getBoundingClientRect()` twice per column (up to 10 synchronous reflows).
  3. `getColumnWidth()` (`L556`) reads `getComputedStyle(document.documentElement)` on every `mousemove` during drag (`L3400`), while `mousemove` / `mouseup` stay attached to `window` permanently instead of drag-scoped with `requestAnimationFrame`.
  4. `updateEntry()` calls `Core.getState()` up to 4 times (`L2057,2176,2183,2196`) and `normalizeFileListColumns` (`L2089`) per row.
  5. `window.resize` (`L2937`) and `ResizeObserver(filePanel)` (`L2942`) both call `renderVisibleSlice()` and `commitPendingThumbnails()` (even in list mode).
  **Agreed fix.** Gate column visibility, `syncContainerDimensions`, and `updateSortIcons` behind `colsSig`, `list`, `naturalWidth`/`naturalHeight`, and `mediaRevision` changes; cache measured min column widths per CSS revision and batch offscreen reads before writes; store column widths in JS state and flush panel/col drag updates in `requestAnimationFrame` only while dragging; pass `state`, `cols`, and `visibleIndices` into `updateEntry`; consolidate resize handling into `ResizeObserver` and run `commitPendingThumbnails()` only in thumbnail view.

- **`S04-10` [Warning] [Agreed] Redundant `read_library_tree` IPCs and duplicate download status sync (`L425-444`, `L1598-1600`, `L3062-3065`).**
  `quivit-library-active-changed` triggers `renderLibrary()` (`L3062-3065`) and `menubar.js:765-768` (`renderImportsMenu()`), each running a fresh `fetchLibraryTree()` (`read_library_tree` directory walk in Rust) plus `fetchManifest()` even though `_libraryTreeCache` already holds the tree. Also, `filePanel.js:427,434` calls `syncWorkspaceDownloadStatus()` right alongside `urlLoader.js:2921-2928`, creating duplicate `{ destPath, status: 'completed' }` objects that bypass `urlLoader.js:2657`.
  **Agreed fix.** Reuse cached `_libraryTreeCache` (and cached manifest) on provider-filter-only switches in `libraryPanel` and `menubar.js`, and remove `syncWorkspaceDownloadStatus` calls from `filePanel.js:427,434`.

- **`S04-11` [Warning] [Agreed] Unbounded `iconCache`, redundant `Image` probe, and `setThumbnailIcon` cache bypass (`L271-277`, `L691`, `L757`, `L792-798`).**
  `iconCache` (`L691`) is an unbounded `Map` (violating `AGENTS.md` Example #6), `fetchNativeIcon()` (`L794-797`) creates a `new Image()` probe before assigning `protocolSrc` to visible `<img>` elements, and `setThumbnailIcon()` (`L271-277`) bypasses `iconCache` and `localStorage`.
  **Agreed fix.** Cap `iconCache` with `BoundedMap(ICON_CACHE_CAPACITY)` (512), eliminate the redundant `Image()` probe by wiring fallback `onerror` directly on icon slots (or caching resolved URIs), and route `setThumbnailIcon` through the shared icon cache.

- **`S04-12` [Warning/Nit] [Agreed] Duplication and dead code (`L251`, `L478`, `L979-994`, `L1011-1018`, `L1024`, `L1165`, `L1177`, `L1364-1365`, `L1388`, `L1523`, `L1556-1570`, `L1578`, `L1723`, `L1732`, `L1890`, `L2514`, `L2725`, `L2800`, `L2803`, `L2839`).**
  `lastScrolledIndex` (`L251,2514,2803`) is written and never read. `lastRenderedVisible` (`L478,2725,2800`) is dead past the `L2669` early return. `main.js:253-254` passes `Core` and `FsUtils` in `deps`, which `filePanel.js:2839` ignores. Double-click 400ms logic repeats at `L1024,1578,1890`, roving `tabIndex` loops repeat at `L979-994` and `L1556-1570`, inline path normalization repeats at `L1165,1177,1364-1365,1388,1523,1723,1732` instead of `pathsEqual()`, and `buildFavoriteEntry` (`L1011-1018`) mutates `loadouts` inline.
  **Agreed fix.** Delete `lastScrolledIndex` and `lastRenderedVisible`, align `initFilePanel(deps)` with `main.js`, extract shared dblclick and roving-`tabIndex` helpers, use `pathsEqual()`, and call `favoritesStore.removeFavorite(path)`.

### `src/js/filepanel/favoritesStore.js`

- **`S04-13` [Blocking] [Agreed] Pure-module boundary violations and case-sensitive Windows path reconciliation (`L12-14`, `L120`, `L232-272`).**
  Top-level `window.addEventListener('quivit-config-loaded', ...)` (`L12-14`) throws `ReferenceError` when imported in Node/Mocha without a DOM mock. `saveFavorites` (`L120`) calls `window.dispatchEvent` unguarded, and `reconcileFavorites` (`L235-243`) invokes `window.__TAURI__.core.invoke('get_path_kind')` directly, firing N individual IPCs and filtering with case-sensitive `missingSet.has(getFavoriteTargetPath(item))` (`L256`).
  **Agreed fix.** Extract pure loadout transforms (`normalizeFavorites`, `getNextLoadoutName`, `makeUniqueLoadoutName`, `getFavoriteTargetPath`, pure create/rename/delete/toggle/remove) or guard `window` listeners and inject `invoke`/`onConfigLoaded`; normalize Windows path comparisons in `reconcileFavorites` using `pathsEqual`/lowercased slash-normalized keys.

- **`S04-14` [Warning] [Agreed] Per-read re-normalization, double immediate persist, and duplication (`L95-111`, `L127-128`, `L155-159`, `L180-183`, `L187-189`).**
  `getFavoritesState()` (`L95-98`) executes `normalizeFavorites()` (deep map plus `groupSavedItems` sort) on every call to `isFavorite`, `getActiveFavorites`, `getActiveLoadoutName`, and `renderFavorites`. `setActiveLoadout` (`L127-128`) and `deleteLoadout` (`L180-183`) call `saveFavoritesCollapsed(false)` and then `saveFavorites(...)`, issuing two immediate `Core.persistConfig({ immediate: true })` writes/RPCs. `renameLoadout()` (`L155-159`) duplicates `collectLowerNames(state, oldName)` (`L20-27`).
  **Agreed fix.** Memoize normalized favorites against the raw `fd?.favorites` object reference, batch collapse state update with `saveFavorites` into one `Core.persistConfig({ immediate: true })`, reuse `collectLowerNames`, and export `removeFavorite(path)`.

### `src/js/filepanel/libraryStore.js`

- **`S04-15` [Blocking] [Agreed] Unguarded `window.__TAURI__` and `window.dispatchEvent` (`L13-24`, `L40-49`, `L141-143`).**
  `fetchLibraryTree` (`L13`) and `deleteLibraryEntry` (`L40`) touch `window.__TAURI__` directly (throwing in Node if `window` is undefined), and `setActiveProvider` (`L141-143`) dispatches directly on `window`.
  **Agreed fix.** Inject `invoke` / `dispatchEvent` adapters (or a pure store core paired with a Tauri adapter) so `libraryStore.js` runs directly in Mocha without browser globals.

- **`S04-16` [Warning] [Agreed] `localStorage` JSON churn, side-effecting sort, and O(n^2) loops (`L65-84`, `L194-232`).**
  `getProviderCollapsed()` (`L65-74`) parses `localStorage.getItem('quivit_library_providers_collapsed')` on every provider inside `renderLibrary()`, and `orderProviders()` (`L217-232`) reads, parses, mutates, and writes `quivit_library_provider_order` on every render even when order is unchanged, using `kept.includes(...)` and `present.some(...)`. Note that `quivit_library_*` keys store UI-view state in `localStorage` rather than roaming/portable config (`core.js:20-37`).
  **Agreed fix.** Cache parsed provider-collapsed and provider-order structures in memory (skipping `localStorage.setItem` when unchanged), split pure `computeOrderedProviders(tree, storedOrder)` and `resolveNextActiveProvider(...)` using `Set` lookups, and keep `quivit_library_*` explicitly scoped to `libraryStore.js`.

- **`S04-17` [Nit] [Agreed] Dead exports and formatting (`L51-63`, `L65`).**
  `getLibraryCollapsed` (`L51-57`), `saveLibraryCollapsed` (`L59-63`), and `localStorage` key `'quivit_library_collapsed'` have 0 callers across `src/`, `mocha/`, and `e2e/`. Line `L65` is missing a newline after `{`.
  **Agreed fix.** Delete `getLibraryCollapsed`, `saveLibraryCollapsed`, and `'quivit_library_collapsed'`; fix `L65` formatting.

## Cross-split seams

- **Sync A (`index.html`, `global.css`, `main.css` <-> S02):** Add `#file-list-row-template`, `#saved-entry-row-template`, and `#library-provider-template` in `src/index.html` (disjoint from S06 templates), reuse `index.html:226,269`, extract `src/css/file-panel.css` linked after `main.css`, and move `--panel-*`, `--resize-handle-w`, `--col-*`, and `--file-grid-cols` out of `src/css/global.css:43-53`. Preserve all locked `filepanel.page.js` and `08-url-loader.e2e.js` selectors.
- **Sync C (`urlLoader`, `menubar`, `urlOverlay` <-> S05, S02):** Drop duplicate `syncWorkspaceDownloadStatus` calls (`filePanel.js:427,434`) so `urlLoader.js` stays sole writer of `_workspaceStatuses`. Support `onProviderImported` DI for `urlLoader.js:33` (`libraryStore.js` import removal). Share cached `_libraryTreeCache` across `libraryPanel` and `menubar.js:645-775`. Expose `onItemPointerDown` to replace `urlOverlay.js:167-201`. Preserve `getFileListViewportRange()` for `UrlLoader.init`.
- **Sync D (Detached `?surface=fileList`, `Core`, `localStorage` <-> S01, S02, S08):** Gate panel listeners, timers, renders, and `container-dimensions` handling on `hostsWorkspaceSurface('fileList')`; route `L3292` viewport focus via `workspaceControls.restoreFocus('main')`; adopt `Core.applyDirectorySort(path, col, desc)` (`CORE_SESSION_METHODS`) for `dims` re-sorts (`L414,2649,3123`); preserve roaming `quivit_favorites.json` / portable `frontend_data.favorites` persistence; keep `icon:*` across `window.focus`; document `quivit_library_*` `localStorage` keys.
- **Sync F (Media, Protocol, Directory/Library <-> S09, S10, S01):** Preserve `quivit://thumb/`, `quivit://icon/`, `quivit://archive/`, `get_native_icon`, `invalidate_native_icon_cache`, `get_file_sizes`, `get_path_kind`, `read_library_tree`, `remove_directory`, `scan_container_dimensions`, `cancel_dims_scan`, `probe_media_dimensions`, `container-dimensions` (`{ container, entries, done }`), and `archiveImageCache.js` (`ensureArchiveBlob`, `hasCachedArchiveBlob`, `clearArchiveBlobCache`) contracts.

## Telemetry A and B specs

### Locked selectors and contracts

- `e2e/pageobjects/filepanel.page.js`: `#file-panel`, `#file-panel-breadcrumb`, `#file-list`, `#file-list li:not([aria-hidden="true"])`, `#file-list li.selected`, `#btn-toggle-view-mode`, `#cmd-open-explorer`, `#cmd-open-folder`, `#btn-favorite-current`, `#status-metadata-badge`, `#favorites-list`, `#file-panel-favorites-header`, `#favorites-list li`, `.view-mode-thumbnail`, `.item-label`, `.item-thumbnail-title`.
- `e2e/specs/08-url-loader.e2e.js:198-200`: `.library-provider-header`, `.library-provider-list .item-label`.
- `e2e/specs/05-persistence.e2e.js`: `quivit_favorites.json` / `frontend_data.favorites` and `file_list_view_mode`.
- `src/js/shared/workspaceControls.js` (`revealListTop`, `focus`, `setFileListAtTop`) and `src/js/shared/workspaceSession.js` events.

### Suite matrix

| Suite | Command | Role in S04 |
|---|---|---|
| Mocha | `npm run mocha` | Primary pure-module and contract suite (308 existing passing, 0 current tests for S04) |
| Desktop E2E | `npm run e2e -- --spec e2e/specs/02-navigation.e2e.js` (plus `04-archives`, `05-persistence`, `08-url-loader`) | Live UI, archive, favorites disk persistence, library tree, and detached `?surface=fileList` parity |
| Replay diagnostics | `npm run diagnose -- <scenario>` | N/A (0 probes touch `#file-panel`) |
| Rust unit tests | `cargo test --manifest-path src-tauri/Cargo.toml` | N/A (frontend-only split; backend IPCs owned by S09/S10/S11) |

### Telemetry A (pre-refactor baseline)

1. Add `mocha/favoritesStore.test.js`: loadout normalization, unique naming, create/rename/delete/setActive/toggle/remove, `getFavoriteTargetPath` (`archive|entry`), single `persistConfig` flush check, and `reconcileFavorites` case-insensitive Windows path pruning with mocked `invoke`.
2. Add `mocha/libraryStore.test.js`: `hasLibraryEntries`/`hasProviderNodes`, `orderProviders` (first-seen rank and emptied-provider pruning), `resolveActiveProvider` (neighbor healing), `activateImportProvider`/`explicit` latch, `syncActiveProvider`, and absence of dead `quivit_library_collapsed` writes.
3. Add `mocha/filePanelMath.test.js`: `computeVisibleSlice`, `computeColumnWidths`, `computeSelectionScrollTop` (single and manhwa `in-view`), `formatByteSize`, `formatDimsText`, `formatBreadcrumbPath`, `formatLibraryDate`, `isPendingDownload`, `getPlaceholderType`, `pathsEqual`, `computeNextSearchMatch`, `resolveLibraryProviderRoot`, and `findDeepestLibraryAncestor`.
4. Expand `e2e/specs/05-persistence.e2e.js` (or navigation parity check) to verify detached `?surface=fileList` selection, favorite toggle, and view-mode toggle parity, then capture baseline JSON for `npm run mocha` and `npm run e2e -- --spec e2e/specs/{02-navigation,04-archives,05-persistence,08-url-loader}.e2e.js`.

### Telemetry B (post-refactor verification)

1. Re-run `npm run mocha` and `npm run e2e -- --spec e2e/specs/{02-navigation,04-archives,05-persistence,08-url-loader}.e2e.js` with 0 regressions and 100% locked selector parity.
2. Add static compliance assertions confirming 0 `createElement`, `innerHTML`, `outerHTML`, `.style.display`, `.style.top`, `.style.height`, and `svg.setAttribute('fill', ...)` calls across `src/js/filepanel/*.js`, plus 0 dead `getLibraryCollapsed` / `saveLibraryCollapsed` references.
3. Verify measurable perf and parity invariants: `renderFilePanel` executes 0 DOM queries when unrelated `Core` fields change; `window.focus` preserves `icon:*` `localStorage` entries; `/archive/` thumbnail scroll-away and scroll-back hits `thumbnailCache` without re-decoding; 5,000-row virtual slice calculation and scroll frame pacing stay bounded with bounded `iconCache` and `thumbnailCache` sizes.
