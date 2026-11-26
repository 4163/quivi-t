# Split S05 audit: fe-urlloader

Stage 3 audit for `S05 fe-urlloader`, covering `src/js/urlLoader.js`, `src/js/services/importActions.js`, and `src/js/shared/svgUtils.js` (with `extractors/*` checked as read-only contract reference). All findings, remediations, cross-split seams, and Telemetry A and B specs below reached unanimous consensus between `s05-loader-arch` (#43, #73) and `s05-queue-perf` (#72), and passed cross-split seam ratification (#74, #116, #130, #138).

## File inventory and status

| File | Lines | Status | Summary |
|---|---|---|---|
| `src/js/urlLoader.js` | 3,094 | Remediate (`S05-01` through `S05-04`, `S05-06`) | Monolithic coordinator mixing 6 concerns, `libraryStore.js` and `_urlOverlay` reach-ins, duplicate detached status listener, `O(N^2)` queue snapshot (`784.20ms` at N=1500), cache-hit Blob URL leak, unbounded prefetch chains, serial BFS sidecar walks, and relocation races |
| `src/js/services/importActions.js` | 155 | Cohesive (scoped fixes `S05-05`) | Pure dependency-injected import orchestrator with zero DOM; needs `getActivity()` phase tracking, `svgText == null` check, clean invalid-URL error in `completeDrop`, and Mocha unit tests |
| `src/js/shared/svgUtils.js` | 114 | Cohesive (scoped fixes `S05-06`) | Pure SVG entity and dimension utility with zero DOM; needs case-insensitive tag/DOCTYPE matching, `<foregnObject` typo fix, static entity-lookup regex (`41%` faster), and root `<svg>` comma-tolerant `viewBox` scan |

Counts above were verified on disk. Two files are structurally cohesive: `importActions.js` and `svgUtils.js`. Zero candidate findings were dropped, and 0 items were escalated.

## Findings and agreed fixes

### `src/js/urlLoader.js`

- **`S05-01` [Blocking] [Agreed] Monolithic coordinator decomposition and `DownloadQueue` encapsulation (`L1-3094`).**
  `urlLoader.js` packs six distinct responsibilities into 3,094 lines: URL/extractor schema validation, dynamic Blob-URL module loading and caching, Tauri network/SVG sanitization proxies, the `DownloadQueue` scheduling state machine, library sidecar I/O and cleanup, and workspace session coordination. `DownloadQueue._refreshWhenComplete()` (`L719-728`) reaches out to module globals `_FsUtils`, `_Core`, and `_activeGalleryPath` instead of using constructor callbacks, while `_startGalleryQueue`, `getWorkspaceDownloadState`, and `UrlLoader.init` reach into 7 private `_activeQueue` fields (`_items`, `_ranksCoverAll`, `_displayRankOf`, `_userAnchorDest` at `L2362, L2378, L2381, L2408, L2410-2411, L3019, L3031, L3047`).
  **Agreed fix.** Split into focused sibling modules while preserving `src/js/urlLoader.js` as the thin coordinator and compatibility re-export facade for callers and `mocha/urlLoader*.test.js`:
  1. `src/js/services/downloadQueue.js`: pure `DownloadQueue` (`L344-739`) and `orderItemsBySort` (`L1723-1740`). Replace `_refreshWhenComplete` global reach-ins with an injected `onQueueComplete` callback, and expose public queue methods (`getStatusSnapshot()`, `hasCompleteDisplayRanks()`, `setUserAnchor()`, `getFirstPendingInDisplayOrder()`) so external callers stop touching private `_activeQueue` fields.
  2. `src/js/urlloader/extractorRegistry.js`: URL/stem helpers (`L185-211, L1088-1119`), manifest/result validators (`L90-181, L758-806, L956-1084`), and dynamic Blob-URL loader/cache (`L79-88, L743-756, L810-952`) preserving the `extractors/README.md` module contract.
  3. `src/js/urlloader/gallerySidecar.js`: pure match vocabulary (`L1247-1337, L1524-1533`) and sidecar read/write/cleanup/stub resolution (`L1135-1243, L1342-1679, L2251-2283, L2428-2640, L2870-2900`).
  4. `src/js/urlloader/networkClient.js`: Tauri network/file IPC proxies (`L215-255, L295-298, L897-906`) plus `sanitizeSvgText`, `downloadSanitizedSvg`, and `sanitizeSvgDocument` (`L259-293`) backed by an explicit DOMPurify adapter coordinated with S02's `defer`/lazy-load of `src/js/vendors/purify.min.js` (`src/index.html:539`).
  5. `src/js/urlLoader.js`: thin coordinator (`UrlLoader.init`, `getWorkspaceDownloadState`, `_loadUrlWithLibraryDir`, `_startGalleryQueue`, `handleLibraryRelocation`, detached `_workspaceStatuses` proxy, and named re-exports).

- **`S05-02` [Blocking] [Agreed] Cross-module reach-in and duplicate download status ownership (`L33`, `L51`, `L1812`, `L1993`, `L2129`, `L2234`, `L2657`, `L2791-2795`, `L2909`, `L2921-2928`).**
  1. `urlLoader.js:33` imports `activateImportProvider` from `./filepanel/libraryStore.js` (S04) and calls it at `L1812, L1993, L2129, L2234`, violating non-DOM coordinator independence when `importActions.js:38` already injects `activateMisc`.
  2. `urlLoader.js:51, L2909` holds `_urlOverlay` (S02) solely so `openPrompt()` (`L2791-2795`) can call `_urlOverlay.show(opts)` for `actions.js:278`.
  3. In detached `?surface=fileList`, `urlLoader.js:2921-2928` and `src/js/filepanel/filePanel.js:425-434` both listen to `quivit-download-status` and `quivit-download-complete` and call `syncWorkspaceDownloadStatus()`. On `quivit-download-complete`, each listener allocates a separate `{ destPath, status: 'completed' }` object, bypassing the `detail === _lastSyncedStatusDetail` check (`L2657`) and running the sync twice.
  **Agreed fix.** Inject `onProviderImported(providerDir)` into `UrlLoader.init` from `main.js` (removing `L33`). Remove `_urlOverlay` and `openPrompt` from `urlLoader.js`, routing `cmd-use-url` through `actionCtx.openUrlPrompt` directly to `urlOverlay.show(payload)`. Keep `urlLoader.js` as sole writer of `_workspaceStatuses`, drop `syncWorkspaceDownloadStatus` calls from `filePanel.js:427,434`, and delete `_lastSyncedStatusDetail`.

- **`S05-03` [Warning] [Agreed] Duplicated sidecar logic, redundant directory IPC, and dead code (`L70`, `L267-268`, `L1088-1104`, `L1150-2876`).**
  - Sidecar `images.map(...)` projection repeats 4 times (`L1936-1946, L2054-2064, L2161-2171, L2484-2494`).
  - `downloadItems` mapping repeats 3 times (`L2097-2110, L2204-2214, L2572-2586`).
  - `result.folders` metadata writes repeat 3 times (`L1902-1911` chunked vs serial `for...of` `await` loops at `L2076-2082, L2182-2188`) and are missing from `resolveUnresolvedGallery` (`L2428-2519`).
  - `read_text_file` plus `JSON.parse` on `gallery.json` repeats across 11 sites (`L1150, L1208, L1344, L1365, L1628, L1924, L2254, L2438, L2536, L2622, L2876`).
  - `cleanupMatchingProviderEntries` (`L1588` -> `L1674` -> `L1417`) calls `read_directory` on `providerPath` a second time through `cleanupMatchingRawFiles` even though `dirResult.files` is already in memory.
  - `extractUrlStem` (`L1088-1104`) duplicates identical path and extension slicing across `try` and `catch`.
  - `_activeGalleryItems` (`L70, L2231, L2304, L2831`) is write-only, `prepareGalleryDirectory(galleryPath, options = {})` (`L2870`) ignores `options`, and `L267-268` both re-export and import `expandSvgEntities` on adjacent lines.
  **Agreed fix.** Extract `serializeSidecarImage`, `buildDownloadItems`, chunked `writeFolderMetadata` (calling it in `resolveUnresolvedGallery` too), `readSidecar`, and single-path `extractUrlStem`. Call `cleanupRootFiles(providerPath, dirResult.files, buildMatchSets(allImages))` directly at `L1674`. Delete `_activeGalleryItems` and the unused `options` parameter, and clean up `L267-268`.

- **`S05-04` [Warning] [Agreed] Queue scheduling overhead, Blob URL leak, detached sync cap, and relocation races (`L56-57`, `L395-408`, `L511-577`, `L603-618`, `L781-799`, `L828-922`, `L1135-1243`, `L1700-1718`, `L1770-1837`, `L2362`, `L2655-2780`, `L2837-2868`, `L2986-3047`).**
  1. *`O(N^2)` lookup and snapshot (`L395-408, L2362, L3047`):* `_findItem` scans all items while normalizing path strings on every lookup. `queue_started` (`L2362`) and `getWorkspaceDownloadState` (`L3047`) call `getStatus(item.destPath)` for every item, measured in Node at `91.23ms` at `N=500` and `784.20ms` at `N=1500`. Pre-index `_itemsByPath` and `_itemsByFilename` `Map`s plus `lowerFilename` in `DownloadQueue`, and read `this._inFlightItems.has(item) ? 'downloading' : item.status` directly in snapshots.
  2. *Prefetch candidate scan (`L511-557, L570`):* Replace dual `.filter().sort()` with a single `O(N)` min-forward / max-backward pass, and replace `Array.from(this._inFlightItems.values()).find(...)` (`L570`) with direct iteration or a `requestId` index.
  3. *Unbounded concurrent prefetch chain (`L568-577, L603-618`):* Each 50% `quivit-download-threshold` admits one successor without capping `_inFlightItems.size`. Enforce an explicit constant `MAX_CONCURRENT_PREFETCHES` (2 or 3).
  4. *`Core.onStateChange` and `setVisibleRange` churn (`L2756-2780, L2986-3041`):* Unrelated `Core.setState` updates (zoom, pan, filter, metadata) inside the same gallery call `prioritize()` and `setVisibleRange()` unconditionally, and main-window `setVisibleRange` (`L2775-2779`) lacks the identical-range early return used in detached mode (`L2759`). Track `_lastSyncIndex` and skip same-index updates when `!listChanged`; deduplicate main-window `setVisibleRange`.
  5. *Cache-hit Blob URL leak and manifest regex churn (`L781, L799, L828-855, L908-922`):* `_resolveDepGraph` calls `URL.createObjectURL` (`L847`) before `_extractorCache.get(cacheKey)` (`L921`), and cache hits (`L922`) return without revoking those new Blob URLs. Create Blob URLs only on cache miss, parallelize independent `quivit-deps` fetches per level with `Promise.all`, and pre-compile `patterns` RegExps once in `validateManifest` (`L781`) instead of recompiling in `findExtractor` (`L799`).
  6. *Serial BFS sidecar scans (`L1135-1243, L1770, L1792, L2037`):* `findMatchingGalleryImage` and `findMatchingGalleryBySourceUrl` execute serial `read_text_file` plus `read_directory` IPCs per folder, and `_loadUrlWithLibraryDir` (`L1770, L1792`) can walk the full provider tree twice for direct URLs when `parseDirectUrl` resolves a new hash. Batch per-level BFS IPCs with `GALLERY_WRITE_CHUNK_SIZE` and reuse scanned sidecars, or skip the second walk when the first scan yields no candidate changes.
  7. *Detached `_workspaceStatuses` capacity and retry rollback (`L56-57, L2655-2689, L2722-2729`):* `BoundedMap(512)` silently evicts early entries in galleries above 512 items. Raise `WORKSPACE_STATUS_CACHE_CAPACITY` to `4096`, clear on gallery change, and roll back optimistic `'downloading'` status in `retryGalleryDownload` when `_workspaceRequest` rejects or returns `false`.
  8. *Relocation races and global download cancellation (`L1700-1718, L1823-1837, L2428-2434, L2837-2868`):* `handleLibraryRelocation` does not clear `_resolvingGalleries` or `_resumingGalleries`, while in-flight background raw downloads (`L1823-1837`) and background cleanups (`L1996, L2134, L2239`) keep stale `providerPath` values. `loadUrl` (`L1703-1706`) also immediately retries active `"relocation is in progress"` errors because `isLibraryLocationError` (`L1712`) groups them with retired-root rejections. Separate retired-root retry from active relocation locks, clear relocation state cleanly, and adopt S10's `cancel_scope` on `crate::network::DownloadCancelFlag` so queue cutovers stop aborting unrelated background raw downloads.

### `src/js/services/importActions.js`

- **Status: Cohesive (`S05-05` [Warning] [Agreed] scoped fixes, `L89-91`, `L136-141`).**
  Zero DOM dependencies, clean dependency injection for `invoke`, `FsUtils`, `loadUrl`, `cancelUrlImport`, `sanitizeSvg`, `activateMisc`, and `libraryUpdated`, and clean single-flight `active` locking.
  **Agreed fix.**
  1. Track `currentPhase` in closure state so `getActivity()` (`L89-91`) reports `'resolving'`, `'preparing'`, and `'opening'` accurately instead of hardcoding `'receiving'` whenever `active` is set, which breaks detached `?surface=fileList` initial sync in `workspaceControls.js:170`.
  2. Guard `payload.svgText == null` (`L141`) instead of strict `=== null`.
  3. Wrap `new URL(payload.url)` in `completeDrop` (`L136-138`) so scheme-less strings throw a clean validation error rather than a raw `TypeError: Invalid URL`.
  4. Add `mocha/importActions.test.js` to cover all exported paths, where unit tests are currently missing.

### `src/js/shared/svgUtils.js`

- **Status: Cohesive (`S05-06` [Warning] [Agreed] scoped fixes, `L23`, `L46-47`, `L66-70`, `L90-92`, plus `urlLoader.js:280-293`).**
  Pure module with zero DOM dependencies, explicit module-scope safety limits (`SVG_ENTITY_MAX_COUNT = 500`, `SVG_ENTITY_MAX_LITERAL = 4096`, `SVG_MAX_BYTES = 10 * 1024 * 1024`), and existing callers in `viewerPipelines.js` and `urlLoader.js`.
  **Agreed fix.**
  1. Fix the `<foregnObject` typo (`L66`) and case-sensitive `.includes('<foreignObject')` / `.includes('<i:pgf')` prechecks (`L66, L69`) before `/gi` regexes so uppercase tags are stripped.
  2. Make `<!DOCTYPE` matching case-insensitive (`L23`).
  3. Replace the dynamic alternation `new RegExp('&(' + names.join('|') + ');', 'g')` (`L46-47`) with static `/&([A-Za-z_][\w.-]*);/g` and `(hit, name) => (table.has(name) ? table.get(name) : hit)` so built-in XML entities stay intact. Live Node benchmark on a 632KB SVG with 400 entities improved from `10.54ms` to `6.22ms` (`41%` faster).
  4. Restrict `viewBox` scanning (`L90-92`) to the root `<svg ...>` opening tag and accept comma-separated coordinates.
  5. In `urlLoader.js:280-293` (`sanitizeSvgDocument`), strip leading UTF-8 BOM, check `SVG_MAX_BYTES` (`10 MiB`) before calling DOMPurify when `<!ENTITY` is absent, and validate the first non-prolog `<svg>` tag without allocating three full-document `.replace()` strings.

## Cross-split seams

- **Sync A (`index.html` and CSP <-> S02, S08):** Coordinate `defer`/lazy-loading of `src/js/vendors/purify.min.js` (`src/index.html:539`) with `urlloader/networkClient.js` SVG import sanitization. Under R2 (`src-tauri/tauri.conf.json:12`), `script-src` / `worker-src` retains `'self' blob: 'wasm-unsafe-eval'` so `loadExtractorModule` dynamic `Blob` URL `import()` keeps working.
- **Sync C (`libraryStore.js`, `filePanel.js`, `urlOverlay.js`, `menubar.js`, `actions.js`, `workspaceControls.js` <-> S01, S02, S04):**
  - Replace `urlLoader.js:33` `libraryStore.js` import with `onProviderImported(providerDir)` injected from `main.js`.
  - Remove `_urlOverlay` and `openPrompt` from `urlLoader.js`; route `cmd-use-url` via `actionCtx.openUrlPrompt` directly to `urlOverlay.show`.
  - Keep `urlLoader.js` as sole writer of `_workspaceStatuses` (cap `4096`, rollback on failed `retryGalleryDownload`); S04 drops duplicate `syncWorkspaceDownloadStatus` calls from `filePanel.js:427,434`.
  - Preserve `workspaceControls.js:167` whitelisted `UrlLoader` RPC methods, `getFileListViewportRange()`, `menubar.js` cached `fetchManifest()`, `importActions` <-> `main/dropzone.js` (`quivit-drop` `owner: 'main'`), and all `quivit-library-*` / `quivit-download-*` / `quivit-status-flash` events.
- **Sync C / Sync F (`shared/svgUtils.js` <-> S07 `viewerPipelines.js`):** Preserve exact DOM-free exports (`expandSvgEntities`, `prepareSvgForCanvas`, `resolveSvgDimensions`) for `viewerPipelines.js:11,94,109,770,1474,1516`.
- **Sync C / Sync E (`commands/{network,library}.rs` <-> S10, S08):** Preserve `fetch_text`, `fetch_bytes`, `fetch_extractor_text`, `download_to_file`, `cancel_download`, `verify_image_magic`, `get_library_dir`, `move_library`, `read_library_tree`, `library-relocated`, and `quivit-download-threshold` (`{ requestId, queueGeneration }`). Adopt S10's `cancel_scope: Option<String>` on `crate::network::DownloadCancelFlag` (`download_to_file` and `cancel_download`) so gallery cutovers never cancel background raw downloads (`urlLoader.js:1825`), and rely on S08's `.tmp` filter in `watchers.rs` for staging writes.

## Telemetry A and B specs

### Locked contracts

- `e2e/specs/08-url-loader.e2e.js`: `#cmd-use-url`, `#url-overlay`, `#url-input`, `.library-provider-header`, `.library-provider-list .item-label`, `fetch_extractor_text`, `fetch_text`, `download_to_file`, `verify_image_magic`, and `gallery.json` sidecar schema.
- `src/js/urlLoader.js` exported `UrlLoader` methods exposed via `src/js/shared/workspaceControls.js:167`, `Core.setPlaceholderCheck`, `FsUtils.setDirectoryPreparationHook`, and the `extractors/README.md` module contract.
- `e2e/scenarios/mangadex-chapters.json`: container stepping actions in `ACTION_REGISTRY`.

### Suite matrix

| Suite | Command | Role in S05 |
|---|---|---|
| Mocha | `npm run mocha` | Primary unit and contract suite (308 existing passing across `urlLoader.test.js`, `urlLoaderFlows.test.js`, `svgUtils.test.js`; 0 existing tests for `importActions.js`) |
| Desktop E2E | `npm run e2e -- --spec e2e/specs/08-url-loader.e2e.js` | Live URL overlay (`cmd-use-url`), manifest-only extractor import, nested gallery persistence, and detached `?surface=fileList` download sync |
| Replay diagnostics | `npm run diagnose -- mangadex-chapters` | Container navigation latency check when local MangaDex library fixture is present |
| Rust unit tests | `cargo test --manifest-path src-tauri/Cargo.toml` | Covered by S10 (`network_tests`, `library_tests`, `drop_tests`) for `crate::network::DownloadCancelFlag` and relocation locks |

### Telemetry A (pre-refactor baseline)

1. Add `mocha/importActions.test.js`: cover `parseLocalPath` (drive, UNC, `file://`, malformed URI), single-flight `active` rejection, `getActivity()` phase transitions (`idle`, `resolving`, `receiving`, `preparing`, `opening`), stale navigation intent triggering `cancelUrlImport`, `acceptDrop`/`failDrop`/`completeDrop` (`path`, `url`, invalid scheme-less `url`, `capture` with `sanitizeSvg` and `svgText === null`/`undefined`), and `release_drop` cleanup.
2. Expand `mocha/urlLoader.test.js`, `mocha/urlLoaderFlows.test.js`, and `mocha/svgUtils.test.js`:
   - `DownloadQueue` `N=1500` snapshot timing baseline, `MAX_CONCURRENT_PREFETCHES` cap enforcement, and `onQueueComplete` callback parity.
   - `loadExtractorModule` cache-hit Blob URL creation vs revocation count.
   - `_workspaceStatuses` tracking above `512` items (testing `513+` through `4096`) and `retryGalleryDownload` rollback on RPC rejection/`false`.
   - `Core.onStateChange` same-index no-op and `handleLibraryRelocation` clearing in-flight resolution maps plus separating retired-root retry from active relocation locks.
   - `svgUtils.js` uppercase `<FOREIGNOBJECT>`/`<I:PGF>`, lowercase `<!doctype`, comma `viewBox`, preserved `&lt;`/`&amp;` XML entities, and 400-entity `expandSvgEntities` timing baseline.
3. Capture baseline JSON for `npm run mocha`, `npm run e2e -- --spec e2e/specs/08-url-loader.e2e.js`, and `npm run diagnose -- mangadex-chapters` when the fixture is available.

### Telemetry B (post-refactor verification)

1. Re-run `npm run mocha` and `npm run e2e -- --spec e2e/specs/08-url-loader.e2e.js` (plus `npm run diagnose -- mangadex-chapters` when fixture is present), confirming 0 regressions, preserved `urlLoader.js` compatibility exports, `cmd-use-url` working after `_urlOverlay` removal, and detached `?surface=fileList` download-status and relocation parity.
2. Confirm zero `libraryStore.js`, `_urlOverlay`, or `globalThis.window?.DOMPurify` reach-ins inside `urlLoader.js` coordinator modules, and zero duplicate `syncWorkspaceDownloadStatus` calls across `filePanel.js` and `urlLoader.js`.
3. Confirm measured performance gains: `N=1500` `DownloadQueue` snapshot `<5ms` (down from `784.20ms` baseline), `0` unrevoked dep Blob URLs on `loadExtractorModule` cache hit, and `>=35%` faster multi-entity `expandSvgEntities` (`6.22ms` vs `10.54ms` baseline at 632KB / 400 entities).
