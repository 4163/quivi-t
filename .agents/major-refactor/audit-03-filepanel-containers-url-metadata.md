# Zone 3 architectural and performance audit: file panel, container navigation, URL importer, and metadata

This audit report was compared against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md`. It covers Zone 3 of QuiviT, analyzing file panel presentation, filesystem and archive navigation, favorites and library stores, URL gallery importer, and comic or directory metadata.

## Validate-changes compliance findings

### Pure module boundaries

- [src/js/fsUtils.js:8] [Warning] Top-level destructuring `const { invoke } = window.__TAURI__.core;` assumes Tauri IPC exists at module evaluation time. If loaded in isolated unit tests or headless contexts, this statement throws immediately. Other locations in the file guard this access defensively.
- [src/js/fsUtils.js:1151,1202,1230] [Nit] Direct `window.dispatchEvent` calls fire `quivit-status-flash`, `quivit-refresh-start`, and `quivit-refresh-end`. The module maintains zero DOM element queries, but coupling to window event dispatching bypasses pure state subscriptions.
- [src/js/urlLoader.js:51,2791-2795] [Nit] `_urlOverlay` reference is stored at module scope and invoked directly in `openPrompt`. The module avoids DOM imports, but UI dialog presentation is wired through an imperative service hook rather than an action or state event.
- [src/js/urlLoader.js:260] [Nit] Accesses `globalThis.window?.DOMPurify` directly inside `sanitizeSvgText`. This parser boundary isolates SVG cleanup cleanly and operates on string inputs without querying the host document.
- [src/js/favoritesStore.js:12,120,235] [Nit] Uses `window.addEventListener`, `window.dispatchEvent`, and `window.__TAURI__.core.invoke`. The module contains zero DOM imports or element queries, maintaining clean data store isolation.
- [src/js/libraryStore.js:17,42,142] [Nit] Direct `localStorage` access and `window.dispatchEvent` for `quivit-library-active-changed`. Contains zero DOM element queries.
- [src/js/directoryPrefs.js:127,133] [Nit] Uses `window.__TAURI__.core.invoke` for path kind validation. Contains zero DOM imports and zero document queries.
- [src/js/metadata.js:35-43] [Nit] Instantiates `new DOMParser().parseFromString(text, 'text/xml')` for ComicInfo and OPF parsing. Document queries occur exclusively on the detached XML document instance, keeping host document boundaries intact.
- [src/js/services/archiveImageCache.js:190-194] [Nit] Direct `window.addEventListener('quivit-refresh-start')` inside a pure service module. The cache should receive clear signals via Core state subscriptions or explicit cache facade methods rather than direct window listeners.
- [src/js/services/sorting.js:1-144] [Nit] Pure domain calculation with zero DOM imports, zero window references, and zero document queries.
- [src/js/services/metadataFiles.js:1-24] [Nit] Pure string matching with zero DOM imports and zero document queries.
- [src/js/shared/svgUtils.js:21-114] [Nit] Pure string transformations and regex parsing with zero DOM imports and zero document queries.

### HTML-first rendering and node recycling

- [src/js/filepanel/filePanel.js:2017-2029] [Blocking] `initDomPool` discards every allocated list row on directory, sort, or view mode transitions via `li.remove()` and wipes `activeRows` and `freePool`. Instead of recycling existing DOM nodes across folder changes, it destroys them and reallocates fresh `li` trees on the next render.
- [src/js/filepanel/filePanel.js:1094] [Blocking] `favoritesListUl.innerHTML = '';` wipes the entire favorites list container on every render. Every favorite item is rebuilt from scratch via `document.createElement` rather than recycling pooled nodes.
- [src/js/filepanel/filePanel.js:896-1003] [Warning] `buildSavedEntry` constructs nine separate DOM nodes per favorite item using `document.createElement` and injects raw SVG markup via `innerHTML` at lines 909, 935, and 963. Static templates or recycled elements are absent.
- [src/js/filepanel/filePanel.js:1640] [Blocking] `libraryPanelEl.innerHTML = '';` wipes the entire library container on every render. Provider headers and directory rows are destroyed and reconstructed on every library update.
- [src/js/filepanel/filePanel.js:1656-1704,1248-1592] [Warning] `buildLibraryEntry` and provider headers instantiate nodes repeatedly using `document.createElement` and inject markup via `innerHTML` at lines 1260, 1287, 1317, 1340, and 1668.
- [src/js/metadata-window.js:78-79,95-107,109-113] [Warning] `createCredit` and `createSeparator` allocate DOM nodes via `document.createElement('span')` and `document.createElement('img')` on every update, replacing children via `val.replaceChildren(...credits)`. Static HTML template placeholders with text recycling should be used instead.

### CSS source of truth

- [src/js/filepanel/filePanel.js:772,775] [Blocking] Sets `img.style.display = 'none'` and `svgSlot.style.display = ''` inline in `fetchNativeIcon` when falling back to SVG icons. Violates the rule against intrinsic visual display writes in JavaScript.
- [src/js/filepanel/filePanel.js:1807,1810,1818,1819] [Blocking] Sets `slots.iconImg.style.display` and `slots.iconSvg.style.display` directly to `'none'` or `''` in `updateRowIcon`. Classes or custom properties must control icon visibility.
- [src/js/filepanel/filePanel.js:1909,1918,1922] [Blocking] Sets `li.style.display = 'none'`, `iconImg.style.display = 'none'`, and `iconSvg.style.display = 'none'` inline inside `createPoolRow`.
- [src/js/filepanel/filePanel.js:2054,2255,2327] [Blocking] Toggles row display directly via `li.style.display = ''` and `li.style.display = 'none'`. Virtualization hiding must use classes or host custom properties.
- [src/js/filepanel/filePanel.js:2256,2328] [Warning] Clears virtualization position via `li.style.top = ''`. Transform matrices or CSS custom properties should control row positioning.
- [src/js/filepanel/filePanel.js:2269,2291] [Blocking] Sets `scrollSpacer.style.height = '0px'` and `scrollSpacer.style.height = totalHeight` inline. A CSS custom property such as `--file-list-total-height` on the list host element should drive spacer height.

## Monolithic file decoupling and ownership plan

### File panel single-owner decoupling

`filePanel.js` spans 3,478 lines and acts as the sole writer for `#file-panel`. Splitting its DOM mutations across multiple sibling files would violate the single-owner rule. The file must remain the sole writer for `#file-panel`, but non-DOM domain logic, virtualization math, layout calculations, and schedulers must be extracted into pure supporting modules:

1. `src/js/filepanel/columnLayout.js`: Pure column sizing and distribution math. Extract `MIN_COL_SAMPLE_TEXT`, `normalizeColumnWidths`, `fitColumnsToPanel`, and `syncGridTemplateColumns` calculations from lines 204-232 and 551-638. Keeps layout constraints and column proportion math pure, while `filePanel.js` applies the resulting custom property strings.
2. `src/js/filepanel/virtualListMath.js`: Pure virtualization calculations. Extract row window slicing, overscan clamping, scroll offset calculations, nearest surviving index tracking, and secondary highlight calculations from lines 2286-2322 and 2489-2572.
3. `src/js/filepanel/thumbnailScheduler.js`: Decoding priority queue. Extract `commitPendingThumbnails`, viewport margin checking, scroll settling debounce timers, and directional priority sorting from lines 2176-2236 and 2378-2474.
4. `src/js/filepanel/iconStore.js`: Native shell icon resolution and storage migrations. Extract `iconCache`, `staticIconCache`, `clearPersistedNativeIcons`, `migrateNativeIconStorage`, and IPC retrieval from lines 691-834.
5. `src/js/services/containerDims.js`: Dimension cache management. Extract `dimsCache`, `activeDimsScanKey`, `_dimsCacheKey`, `hydrateCachedDimensions`, and `syncContainerDimensions` from lines 118-121, 165-194, and 2614-2661.

### URL loader internal subsystems and proposed decomposition

`urlLoader.js` spans 3,094 lines. Its internal subsystems break down across the following line ranges:

- Constants, device filters, and Windows name validation: lines 35-181
- URL validation, normalization, and classification: lines 183-211 and 1088-1120
- Network and file IPC proxies: lines 213-255, 295-318, and 897-906
- Vector SVG sanitization via DOMPurify: lines 257-293
- Path comparison, containment, and rebasing: lines 320-341
- Staggered download queue and scheduler: lines 344-739
- Remote manifest retrieval, validation, and pattern matching: lines 743-806
- Extractor dependency resolution, import rewriting, dynamic blob imports, and caching: lines 808-953
- Gallery extraction orchestration, pagination, and result validation: lines 954-1085 and 2013-2032
- Duplicate matching, jump ranking, and standalone file cleanup: lines 1121-1426
- Sidecar records, stub generation, tier markers, and provider cleanup: lines 1428-1679
- URL import orchestrator across direct media, series, and chapters: lines 1681-2283
- Active queue initialization and viewport synchronization: lines 2287-2426
- Unresolved gallery stub resolution and download auto-resumption: lines 2428-2604
- Deleted file sidecar pruning: lines 2608-2640
- Multi-window workspace status cache and range synchronization: lines 2642-2788
- Prompts, cancellation, and Library relocation: lines 2790-2868
- Directory preparation hook: lines 2870-2900
- Facade initialization, event listeners, and lifecycle bindings: lines 2902-3094

Decomposition plan under `src/js/url/`:
- `src/js/url/urlValidation.js`: Windows name safety, URL normalization, stem extraction, and direct media classification.
- `src/js/url/extractorRegistry.js`: Manifest fetching, schema validation, dependency graph resolution, import specifier rewriting, and dynamic blob module compilation.
- `src/js/url/downloadQueue.js`: Pure `DownloadQueue` class, priority cutovers, retry loops, and threshold notifications.
- `src/js/url/gallerySidecar.js`: `gallery.json` schema builders, intermediate tier markers, chapter stub records, and deleted file sidecar pruning.
- `src/js/url/galleryMatcher.js`: Jump rank scoring, duplicate image detection, root file linking, and provider cleanup sweeps.
- `src/js/url/workspaceQueueSync.js`: Inter-window download status tracking, range batching, and placeholder checks.
- `src/js/url/urlLoader.js`: Slim coordinator that manages `loadUrl`, resume workflows, and Core state subscriptions.

### Filesystem utilities subsystems and proposed decomposition

`fsUtils.js` spans 1,301 lines across multiple mixed responsibilities:

- Session forwarding and replica configuration: lines 8-14 and 183-191
- Format classifications and extension sniffing: lines 15-27 and 209-216
- Navigation generations and intent tracking: lines 32, 66-73, and 192-198
- Pending deletion tombstone registry: lines 39-64 and 200-205
- Path string utilities: lines 76-110, 350-357, and parent or basename resolution
- Archive entry targeting and index survival: lines 112-180
- Archive encryption and unlocked passwords: lines 35-36, 217-237, and 764-770
- Container dimension scanning IPC facade: lines 239-265
- Media source URL builders: lines 266-358 and 392-424
- ICO source extraction facade: lines 359-390
- Entry list transformation and formatting: lines 434-472
- Neighbor preloading calculations: lines 474-520
- Status and page position formatters: lines 522-550
- Container navigation orchestrator: lines 563-1250
- Background archive prefetcher: lines 1252-1300

Decomposition plan:
- `src/js/services/mediaUrls.js`: Pure media URL construction for archives, shell thumbnails, icons, and asset protocols, with base64 encoding.
- `src/js/services/archivePasswords.js`: In-memory unlocked password cache and archive encryption checks.
- `src/js/services/containerScanner.js`: Facade for max width and dimension scanning IPC.
- `src/js/services/archiveIndex.js`: Archive entry targeting, survival heuristics, and composite `|` path parsing.
- `src/js/fsUtils.js`: Retains directory and archive navigation workflows, generation tracking, and session forwarding.

## Performance, virtualization, caching, and I/O efficiency

### Virtualization and layout performance

- [src/js/filepanel/filePanel.js:2590] [Warning] Forced synchronous layout: `void filePanel.offsetWidth;` is invoked in `setRefreshingVisual` to force CSS animation restarts. In large folders, this halts the main thread during navigation refresh.
- [src/js/filepanel/filePanel.js:556] [Nit] Reads `getComputedStyle(document.documentElement).getPropertyValue` inside `getColumnWidth` during column normalization.
- [src/js/filepanel/filePanel.js:223,226] [Nit] Measures DOM clones with `clone.getBoundingClientRect().width` inside `recalculateMinColWidths`.
- [src/js/filepanel/filePanel.js:2645-2651,3117-3125] [Warning] Unthrottled sort execution: on every `container-dimensions` scan update, if the sort column is `dims`, `DirectoryPrefs.sortList` runs over the entire file list on the main JS thread. In a 10,000 item directory, repeated full array sorts during background dimension sweeps stall scrolling and UI input.
- [src/js/filepanel/filePanel.js:1099-1103] [Warning] Unbatched DOM mutations: `renderFavorites` appends rows into `favoritesListUl` one at a time without a `DocumentFragment`.
- [src/js/filepanel/filePanel.js:1698-1704] [Warning] Unbatched DOM mutations: `renderLibrary` appends headers and item lists directly into the active container without a `DocumentFragment`.

### Thumbnail decoding order and cache budgets

- [src/js/filepanel/filePanel.js:2211,2223,2444,2452] [Warning] Unbounded timer chains: deferred thumbnail loads register chained `setTimeout` calls, with delays scaling like `10 + orderIdx * 15ms`. During fast fling scrolling over hundreds of items, dozens of stale timer callbacks queue up and execute after scroll settling even if rows have already moved out of view.
- [src/js/filepanel/filePanel.js:757,822] [Warning] Synchronous `localStorage` reads: `getIconHtml` and `fetchNativeIcon` read and write `localStorage` with `icon:${ext}` keys during row layout. In folders containing numerous varied extensions or application files, repeated synchronous storage access adds main thread latency.
- [src/js/filepanel/filePanel.js:63,95,118,533] [Nit] Named cache capacities are maintained: `THUMB_CACHE_CAPACITY = 250`, `FAVORITES_CACHE_CAPACITY = 250`, `DIMS_CACHE_CAPACITY = 10000`, `LIBRARY_CACHE_CAPACITY = 250`.
- [src/js/services/archiveImageCache.js:141-150] [Warning] Redundant URL revoking: `clearArchiveBlobCache` iterates `_archiveBlobCache.entries()` and calls `URL.revokeObjectURL(val)`. Immediately afterward, it calls `_archiveBlobCache.clear()`. Because `_archiveBlobCache` is a `BoundedMap` configured with `onEvict: _revokeBlobEntry`, the clear call runs `URL.revokeObjectURL` a second time on every previously revoked blob URL.
- [src/js/services/archiveImageCache.js:27-39] [Nit] Inefficient eviction loop: `_trimArchiveBlobCache` repeatedly executes a `while` loop that re-iterates `_archiveBlobCache.keys()` from the beginning on every eviction step.

### IPC overhead and payload parsing

- [src/js/fsUtils.js:572-598] [Warning] Blocking sidecar check: `applyDirectoryResult` awaits `read_text_file` for `gallery.json` on every directory entry. When present, `JSON.parse` and multiple Map iterations run synchronously on the main thread before setting Core state, adding latency to directory transitions.
- [src/js/fsUtils.js:1123-1143] [Warning] Serial sibling container probing: `openSibling` sequentially tests containers in a while loop, invoking `read_directory` or `list_archive` one by one until a valid container opens.
- [src/js/urlLoader.js:1145-1189,1204-1238] [Blocking] Deep sequential directory traversal: `findMatchingGalleryImage` and `findMatchingGalleryBySourceUrl` crawl directories up to depth 8 using sequential IPC calls to `read_text_file` and `read_directory`. In a provider root containing 50 galleries, a single direct media drop triggers dozens of sequential IPC round trips on the main thread.
- [src/js/metadata.js:35] [Warning] Synchronous XML parsing: `parseMetadataText` parses ComicInfo XML via `DOMParser` on the main thread. Multi-megabyte XML files in large archives block the UI thread during metadata loading.

## Async cancellation, stale generations, and multi-window parity

### Cancellation and stale generations

- [src/js/fsUtils.js:66-73,564,680,688,696,756,846,868,874,899,914,958,1016,1019,1040,1118,1137,1149] [Nit] Container loading rigorously checks `_isCurrentGeneration(generation)` across `loadFile`, `loadArchive`, `openParent`, `openSibling`, and `applyDirectoryResult`. Stale navigations are aborted before applying state changes.
- [src/js/fsUtils.js:247-254] [Warning] Unversioned dimension scanning: `scanContainerDimensions` initiates a background dimension sweep without passing a generation token. While `cancelDimsScan` is called on directory changes at line 258, the listener in `filePanel.js:3079-3126` verifies only container path equality. Rapid navigation back and forth between identical folders can allow late-arriving dimension events from an earlier load to mutate the list.
- [src/js/urlLoader.js:2889-2895] [Blocking] Unchecked refresh after async stub resolution: `prepareGalleryDirectory` calls `resolveUnresolvedGallery(galleryPath).then(ok => { if (ok) _FsUtils?.refresh?.(); })`. If the user leaves the gallery before resolution completes, the callback fires `refresh()` on whatever directory is currently loaded in Core, triggering a spurious refresh on an unrelated folder.
- [src/js/urlLoader.js:2428-2519] [Warning] Uncancellable stub resolution: `resolveUnresolvedGallery` tracks in-flight galleries with a Set but does not cancel network fetches or sidecar writes if the user navigates away or deletes the directory during resolution.

### Multi-window parity and detached replica behavior

- [src/js/fsUtils.js:9-12,183-191] [Blocking] Incomplete replica session forwarding: `FS_SESSION_METHODS` excludes `getUnlockedPassword`, `prefetchAhead`, and `prefetchArchiveEntries`. In a detached replica window, `_unlockedArchivePasswords` is empty, preventing password-protected archives from reading unlocked status from the main window.
- [src/js/urlLoader.js:56-57] [Warning] Bounded workspace status cache limit: `_workspaceStatuses` is capped at 512 entries via `WORKSPACE_STATUS_CACHE_CAPACITY`. In galleries exceeding 512 images, download statuses for early items are evicted from the replica window's cache, causing completed or downloading items to lose visual status.
- [src/js/filepanel/filePanel.js:3068-3074] [Warning] Redundant multi-window disk reads: both main and replica windows independently listen to Tauri's `library-changed` event and invoke `fetchLibraryTree` and `fetchManifest`, doubling backend file reads on every filesystem change.
- [src/js/filepanel/filePanel.js:1458-1473] [Warning] Uncoordinated replica deletion: `deleteLibraryEntry` in a replica window invokes `remove_directory` directly over Tauri IPC instead of dispatching through the workspace session forwarder. While `FsUtils.registerPendingDeletion` forwards optimistically, the boot-out navigation `FsUtils.loadFile(providerRoot)` must round-trip through session RPC.

## Redundant code, shared helpers, and stale references

### Repeated path normalization and string parsing

- [src/js/directoryPrefs.js:6-8] Repeated path normalization: `normalizePathKey(p)` duplicates lowercase conversion, backslash replacement, and trailing slash stripping.
- [src/js/fsUtils.js:41-44] Repeated deletion path normalization: `_normalizeDeletionPath(path)` re-implements lowercase conversion and slash normalization.
- [src/js/fsUtils.js:108-110] Repeated archive path normalization: `normalizeArchiveEntryPath(path)` re-implements slash and prefix normalization.
- [src/js/urlLoader.js:322-325] Repeated path equality: `_pathsEqual(a, b)` duplicates forward slash conversion and lowercase comparison.
- [src/js/urlLoader.js:327-332] Repeated path containment: `_isPathWithin(path, root)` re-implements trailing slash trimming and prefix matching.
- [src/js/urlLoader.js:2642-2653] Repeated status key normalization: `_normalizeStatusKey(filePath, galleryPath)` re-implements slash normalization.
- [src/js/filepanel/filePanel.js:835-838] Repeated path equality: duplicate `_pathsEqual(a, b)` declaration inside `filePanel.js`.
- [src/js/filepanel/filePanel.js:1165,1177,1365] Repeated inline path normalization across selection and deletion handlers.
- [src/js/services/pathUtils.js] Recommended shared helper: consolidate path equality, case-insensitive forward-slash normalization, and directory containment into a unified service.

### Repeated composite archive separator parsing

- [src/js/services/sorting.js:21,115] Checks `path.includes('|')` to detect archive entries.
- [src/js/filepanel/favoritesStore.js:228-230] `getFavoriteTargetPath` splits composite path: `path.indexOf('|')` and `path.slice(0, separator)`.
- [src/js/directoryPrefs.js:144] Splits composite path: `path.indexOf('|')` and `path.slice(0, path.indexOf('|'))`.
- [src/js/fsUtils.js:330-334] Splits composite path: `path.indexOf('|')`, extracting `archivePath` and `entryName`.
- [src/js/fsUtils.js:974-978] Splits composite path in `loadFile`: `path.indexOf('|')`, extracting `archivePath` and `innerEntry`.
- [src/js/filepanel/filePanel.js:851] Splits composite path in `findOpenFavoriteIndex`: `path.indexOf('|')`.
- [src/js/filepanel/filePanel.js:898] Replaces pipe separator: `item.path.replace('|', '\nEntry: ')`.
- [src/js/services/archivePath.js] Recommended shared helper: create `splitArchivePath(path)` returning `{ isArchiveEntry, archivePath, entryName }`.

### Repeated extension extraction

- [src/js/fsUtils.js:25-27] `_ext(name)` uses `name.split('.').pop().toLowerCase()`.
- [src/js/services/sorting.js:118] Extracts extension via `name.split('.').pop()` or `path.split('.').pop()`.
- [src/js/urlLoader.js:148] Extracts extension via `filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()`.
- [src/js/urlLoader.js:1729] Extracts extension via `name.lastIndexOf('.')` and slice.
- [src/js/services/metadataFiles.js:11] Extracts bare name via `split('/').pop().toLowerCase()`.
- [src/js/filepanel/filePanel.js:918,1269] Extracts extension via `item.name.split('.').pop().toUpperCase()`.
- Recommended shared helper: standard extension extractor in `src/js/services/pathUtils.js`.

### Dead functions and unused exports

- [src/js/fsUtils.js:30] [Nit] Dead re-export: `export { BoundedMap };` in `fsUtils.js` is never imported by any other module in the codebase. All consumers import directly from `services/cache.js`.
- [src/js/urlLoader.js:267-268] [Nit] Redundant export and import: `export { expandSvgEntities } from './shared/svgUtils.js';` followed immediately by `import { expandSvgEntities } from './shared/svgUtils.js';`. No module imports this from `urlLoader.js`.
- [src/js/filepanel/filePanel.js:1762-1766] [Nit] Orphaned export: `getHighlightedLibrary()` is exported from `filePanel.js` and wrapped as a getter in `main.js`, but is never invoked by any command, action handler, or test.
- [src/js/filepanel/filePanel.js:464,840-843] [Nit] Inline raw SVG constants: `PLACEHOLDER_HTML`, `MARU_O_SVG`, `EMPTY_BOX_HTML`, `CLOSE_X_SVG`, and `FAVORITE_REMOVE_X_SVG` hardcode complex SVG strings directly in JavaScript.

### Probe and testing contract dependencies

Refactoring Zone 3 must preserve the following contracts required by diagnostics and end-to-end tests:

1. `e2e/replay-diagnostics/probes/ipcProtocolProbe.js`:
   - Wraps `window.__TAURI__.core.invoke` recording `cmd` and argument keys. IPC command names such as `read_directory`, `list_archive`, `fetch_text`, `download_to_file`, `verify_image_magic`, `get_native_icon`, and `read_library_tree` must not change.
   - Wraps `window.fetch` checking routes containing `quivit://`, `asset://`, `/archive/`, `/thumb/`, and `/icon/`. URL route structures and query arguments must remain unchanged.

2. `e2e/pageobjects/filepanel.page.js`:
   - Required DOM selectors:
     - `#file-panel` and class `.view-mode-thumbnail`
     - `#file-panel-breadcrumb`
     - `#file-list`, `#file-list li:not([aria-hidden="true"])`, `#file-list li.selected`
     - `#btn-toggle-view-mode`
     - `#cmd-open-explorer`, `#cmd-open-folder`
     - `#btn-favorite-current` and class `.active`
     - `#status-metadata-badge`
     - `#favorites-list`, `#file-panel-favorites-header`, `#favorites-list li`
     - `.item-label`, `.item-thumbnail-title`
   - Keyboard and interaction flows: Enter key opens selected items, double-click jumps, and selection by name or index.
