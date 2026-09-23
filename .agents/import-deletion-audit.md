# Import and deletion delay audit

> Validation comparison performed: every finding below was checked against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md` before writing. This skill is reporting-only. No code was changed during the audit.

**Target:** branch `refactor/extractor-polish` at `3842f6b`, plus the uncommitted `extractors/` worktree edit (covers `fallbackUrl` removal, `mangadex` v7 to v8).
**Scope source:** clipboard audit brief (import delay, deletion delay, viewport download direction vs column ordering, current-image priority, spinner vs blocking jumps, folder-exit teardown, optimistic deletion).
**Summary:** Import and deletion both hold the UI behind serial IPC chains that can go optimistic or background. The viewport download window has a real domain bug (sorted display indexes compared against extractor-order `galleryIndex`). Folder-exit teardown is already non-blocking. Deletion is not snappy yet, so the clipboard prerequisite applies: optimize deletion first.

## Findings, by clipboard item

### 1. Import delay

Import completion and first navigation both wait for bytes in seven places. All in `src/js/urlLoader.js` unless noted.

- I1. Direct-match jump awaits 0-byte placeholder re-download before returning `galleryPath` (`:1645-1667`, `:1681-1702`). Chain: `loadUrl:1598` to `_loadUrlWithLibraryDir:1634` to `downloadFile` `:1656/:1691` to `main.js:195-196 await UrlLoader.loadUrl()` to `await FsUtils.loadFile()` to `urlOverlay.js:87 await _onSubmit()`, overlay hides at `:88`. [Observable change] Fix: return path first, fire-and-forget eager fetch, existing `quivit-download-complete` swap already handles arrival (`viewerRender.js:493-505`).
- I2. New direct raw download awaits `downloadFile` `:1709` plus `recordRootMediaDownload` `:1712` before return `:1723`. [Observable change] Fix: 0-byte placeholder plus return, background queue.
- I3. Series import awaits cover download `:1742`, per-chapter stub-cover downloads `:1834-1840` inside 25-chunk `Promise.all`, and `cleanupMatchingProviderEntries` `:1879` before returning `:1885`. [Observable change] Fix: write sidecars, return, download covers in background.
- I4. Existing-gallery update and new-gallery import both await eager target/first download (`:1991-2018`, `:2113-2140`) before `_startGalleryQueue` and return (`:2031`, `:2161`). [Observable change] Fix: same return-first shape.
- I5. `resolveUnresolvedGallery` (`:2289-2401`) awaits manifest `:2315/2317`, extractor load `:2320`, page fetch `:2325`, extract `:2329`, sidecar writes `:2356-2367`, and eager `downloadFile` `:2382/2387` before `true`. Callers await it (`:2403/2425`, `:2615/2635`). [Observable change] Fix: resolve sidecar plus placeholders, return, move eager fetch into queue `prioritize()`.
- I6. Directory-enter hook blocks paint: `fsUtils.js:831-841 await _directoryPreparationHook` (`= prepareGalleryDirectory:2714`), which awaits resolve `:2635`, file-size scan `:2656`, and target download `:2668/2673` before `read_directory` `:839` and `applyDirectoryResult`. Entering an unresolved stub chapter holds the old folder or an empty list. [Observable change] Fix: hook does sidecar read only, resolve plus eager run fire-and-forget then `FsUtils.refresh()`.
- I7. Overlay serial chain: `main.js:194-197`, `urlOverlay.js:70-95` holds `.loading` until submit resolves. [Observable change] Fix: navigate plus hide optimistically, background remainder with error toast.
- I8. Eager-download-with-fallback is copy-pasted four times (`:1991-2012`, `:2113-2134`, `:2376-2395`, `:2661-2680`, plus `:1651-1661`/`:1686-1696`). Not a delay itself, but every delay fix above touches all copies. [No observable change] Fix: extract one `downloadWithFallback()` helper first.
- I9. `FOLDER_CHUNK_SIZE = 25` (`:1783`) and `CHUNK_SIZE = 25` (`:1796`) are duplicated function-local literals. [No observable change] Fix: one module-scope `GALLERY_WRITE_CHUNK_SIZE` next to the existing caps (`:32-44`).

### 2. Deletion delay

Two real paths. There is no Delete key or delete action in the main file list (`filePanel.js:2365-2458`, `services/actions.js:237-344`), so this covers Library `lib-remove` rows and background shape-cleanup prunes.

- D1. Backend `remove_directory` runs synchronously on the IPC thread (`src-tauri/src/commands/directory.rs:460-493`): two `canonicalize` calls, blocking `SHFileOperationW` on Windows (`:424-458`), else 10-try retry with `sleep(50ms)` per level (`:365-384`, `:409-421`). A large gallery pins a Tauri async worker. `move_library` in `library.rs:626-635` already uses `spawn_blocking`; delete does not. [Observable change] Fix: `spawn_blocking` for the recycle plus fallback delete.
- D2. Frontend awaits the delete before touching the row (`filePanel.js:1056-1100`, IPC `libraryStore.js:37-46`). Row stays painted through the whole recycle. [Observable change] Fix: detach the `li` on second click after `disarm()` (`:1063`), reconcile in `renderLibrary()`, re-insert plus toast on failure. This is the clipboard optimistic-deletion item.
- D3. `await FsUtils.openParent()` (`:1069-1076`) runs before the recycle IPC: full `read_directory` plus render, then delete, then re-render. Two sequential spinners. [Observable change] Fix: fire delete first or concurrently; ordering is only required when the viewer sits inside the deleted dir.
- D4. Thumbnail-cache substring sweep on the click path (`:1078-1085`, cap `THUMB_CACHE_CAPACITY = 250` at `:94`). Bounded but main-thread, ahead of every await. [No observable change] Fix: move after optimistic detach.
- D5. `forgetDeletedLibraryEntry` costs 2 serial IPCs (`urlLoader.js:2493-2521`: read then write) between recycle and re-render, even for directory deletes where the sidecar goes with the folder (`:2490-2492`, `:2504-2507`). [Observable change] Fix: fire-and-forget, and skip when `item.is_dir`.
- D6. `renderLibrary()` (`:1160-1251`) is a full rebuild behind 2 serial IPCs (`read_library_tree` `:1162`, `fetchManifest` `:1170`), then `innerHTML = ''` (`:1177`) and full row recreation. One deleted row rebuilds every provider. [Observable change] Fix: single `li.remove()` plus provider-empty check for paint, full render as reconciliation; `Promise.all` the two fetches. Violates AGENTS.md HTML-first node recycling (`AGENTS.md:52`); the main list already has a RowCache (`:229-267`), Library and Favorites do not (`renderFavorites:789` same pattern).
- D7. Delete triggers up to 8 sequential backend round trips plus watcher echoes: openParent read, `remove_directory`, forget read/write, `read_library_tree`, `fetchManifest`, conditional `refresh()` read (`:1102-1105`, which also clears the whole `thumbnailCache` at `:1973-2002`), then `library-changed` re-render (`:2299-2304`, 250 ms debounce) and `directory-changed` refresh (`lifecycle.js:35-44`, 500 ms). [Observable change] Fix: skip `refresh()` when `!isInside`, rely on the watcher event instead of both.
- D8. `cleanupMatching*` runs per-file serial IPC in a loop (`urlLoader.js:1539-1568`, `:1315-1334`, `:1292-1313`) and callers await it inside the import path (`:1879`, `:2028`, `:2143`), so shape cleanup adds to import latency. No cancellation integration. [Observable change] Fix: collect matches, one batched command or capped `Promise.allSettled`; move behind the `return` / `quivit-library-updated` dispatch.
- D9. Download cancellation on delete is already non-blocking (`cancel()` flips flags sync, `cancel_download` fire-and-forget at `:454-464`; `filePanel.js:1065-1067` does not block). Gap is coverage, not delay: exact-path match only (`:2569`), so deleting a parent provider folder, sibling chapter, or single file inside the active gallery does not cancel. `_isPathWithin` (`:345-350`) exists but is unused here. [Observable change if fixed] Fix: prefix/within check.

Per the clipboard prerequisite: deletion is not snappy yet (D1-D3, D6-D8). Do D1-D3 plus D6 before the spinner work, or defer the spinner work.

### 3. Viewport download vs column ordering

Confirmed bug, not a risk. Every range producer emits sorted display-row indexes; every consumer compares them against extractor-order `galleryIndex`. No display-to-gallery mapping exists (all 11 `galleryIndex` hits are inside `urlLoader.js`).

- V1. Scroll producers (`filePanel.js:1790-1793`, `:2553-2565`) push display windows; `_isInViewport` (`urlLoader.js:466-475`) tests `galleryIndex`. Any non-default sort slides prefetch onto the wrong images: on-screen placeholders linger while off-screen bytes download. [Observable change] Fix: translate the visible range to a `galleryIndex` set via filename lookup at the boundary.
- V2. Same mismatch in the queue-start and panel-hidden fallbacks (`urlLoader.js:2211-2229`, `:2755-2760`): `state.index` is a sorted-list index stored directly as `_visibleStart/_visibleEnd`. [Observable change] Fix: resolve `state.list[state.index]` to filename to `galleryIndex`, center the window there.
- V3. New-gallery import can point `active` at the wrong item (`:2136-2150`): when the eager target fetch fails, `initialTarget` falls to first-pending instead of the failed target, and the prefetch gate (`:546`, unlock `:638-639`) serializes everything behind it. Viewer shows image 50, queue downloads image 0. [Observable change] Fix: if `targetItem.status` is still `pending` after eager, keep `initialTarget = targetItem.destPath`.
- V4. Existing-gallery reimport computes `initialTarget` after the status it tests has flipped (`:1997-1998` sets `completed`, `:2022-2024` tests `pending`), so the success path always prefetches from gallery start instead of outward from the current image (`:482-483` pivot, `:521-543` cutover). No blank viewer, but wasted first bytes mid-gallery. [Observable change] Fix: capture the target path before the eager await.
- V5. The `active` kind bypasses the gate (`:432-452`, `:521-543`), so the current image does start even outside the viewport, provided `prioritize` receives the right item (broken only by V3). Prefetch otherwise admits one in-flight item chained on 50% threshold events (`PREFETCH_START_THRESHOLD_PERCENT = 50` at `:36`). The `±1 galleryIndex` neighbor backstop (`:470-473`) is the only sort-proof part of the window. [No observable change] Fix direction for stalls: fix V1/V2, optionally re-arm admission on sort-change events.

### 4. Spinner vs blocking jumps

- S1. No visible spinner exists. `#viewer-loading-frame.viewer-img.is-placeholder {display:none}` (`index.html:249`, `global.css:219-221`). `viewerRender.js:611-623` has a loading path (status-bar label plus alt-dots interval), but `core.js:222-228` bridges 0-byte placeholders to the old `src` or `''`, so `activeChanged` stays false and the spinner path is skipped; empty `src` hits `clearDisplayedImage()` (blackout). Downloading state also suppresses the filename label (`statusbar.js:130-138`, `:161-163`). [Observable change if fixed] Fix: unhide or repurpose `#viewer-loading-frame` as a `viewerRender`-owned class or `data-*` state with a `main.css`/`global.css` token. Do not rename queried viewer DOM (probe contract in `e2e/replay-diagnostics/probes/viewerPipelineProbe.js:14-18`).
- S2. Swap-on-arrival already exists (`viewerRender.js:493-505` on `quivit-download-complete`, `:2239-2252` `onItemStatusChanged` to `setState({src})`). The spinner work is therefore return-first plus paint, no new plumbing. [No observable change]

### 5. Folder-exit teardown

Already non-blocking, no change needed. `DownloadQueue.cancel()` is sync plus fire-and-forget IPC (`:454-464`); `_teardownActiveQueue` is sync (`:2574-2584`); `onStateChange` tears down on directory change without awaiting (`:2727-2732`); navigation callers are fire-and-forget (`filePanel.js:591-599`, `:890-895`, `actions.js:25-33`, generation guards `fsUtils.js:31-38`). One leak, not a hold: direct eager `downloadFile` calls (`:1645-1709`, `:2382`, `:2668`) carry no `requestId`/`queueGeneration`, so leaving mid-eager finishes the IPC in the background while the UI has moved on. [Observable change if fixed] Fix: route eager fetches through queue `prioritize()` or tag them with generation.

## AGENTS.md violations (recent changes)

Target: `d512a68` (README Supported sites), `3842f6b` (Options Library link plus opener handler), extractor worktree edit (ignored, uncommitted).

- README section plus anchor link: docs only. Sentence-case heading, no em dashes, bold-lead-period list style per unslop. [No observable change] None.
- Options hint link (`src/options.html:112`, handler `src/js/options/options.js:252-261`): opens the README section via `opener.openUrl` with `window.open` fallback, same pattern as `cmd-github` (`services/actions.js:226-235`); `opener:default` covers the options window (`capabilities/default.json:16`). Handler lives in the options-window owner, no inline styles, no state-machine reach-in. [Observable change] None.
- Extractor covers fix: removes a dead-identical `fallbackUrl`, bumps `mangadex` v7 to v8 per the extractor cache-bust contract. Ships as an `extractors`-branch commit, not this branch; currently uncommitted in the ignored worktree. [Observable change on re-import: key omitted] None.
- Pre-existing dirty file `.agents/skills/update-readme-features/SKILL.md` was already modified before this session. Untouched here, out of scope.

## Stale code and references

- The three `fallback !== primary` guards (`urlLoader.js:616`, `:1658`, `:1693`) plus the four eager-fallback blocks are still required by MangaDex chapter fallback (distinct hosts). Not stale. [No observable change]
- Old `gallery.json` files on disk keep the identical covers `fallbackUrl` until re-import; readers treat present-identical and absent identically. Self-heals on re-import via the update path (`:1929-1939`). [No observable change]
- `GENERIC_COVER_FILENAMES` Set rebuilt per call (`urlLoader.js:1537`); hoist if nearby code is touched. [No observable change]

## Verdict

Fail on V1/V2 (wrong-images-prefetched under any non-default sort) as the correctness item. Nits on I9, V4, D4. Everything else is accepted technical debt with the fix directions above.

Suggested slice order, honoring the clipboard deletion-first prerequisite:

- [x] Slice 1, deletion paint path: D1 (`spawn_blocking`), D2 (optimistic row detach), D3 (delete before or concurrent with `openParent`). Accept: single Library delete paints in one frame; IPC completes in background; failure re-inserts plus toast. Done on `refactor/extractor-polish`: `directory.rs` command over `spawn_blocking` (test via `block_on`), handler sync with background IIFE, `quivit-status-flash` in `statusbar.js`. Follow-ups included: optimistic provider-section prune plus `is-empty` toggle with surgical restore, boot-out to provider root instead of immediate parent. Verified: `cargo test commands::directory::tests` 5 passed, `npm test` 189 passing. Runtime retest items 1, 2, 7 outstanding.
- [x] Slice 2, deletion reconciliation: D5 (fire-and-forget prune, skip when `is_dir`), D6 (single-row removal plus `Promise.all` fetches), D7 (conditional refresh). Accept: one delete costs at most `remove_directory` plus one tree read; no watcher double-render. Done on `refactor/extractor-polish`, all in `filePanel.js`: forget skipped for dirs (sanctioned by its header comment) and unawaited for files; `renderLibrary` fetches tree plus manifest in one `Promise.all`; explicit `refresh()` skipped after provider-root boot-out unless the target is downloading (watcher echo covers the rest, proven via `fsUtils.js:558` plus `lifecycle.js:35-44`). Verified: `node --check`, `npm test` 189 passing. Runtime retest: boot-out settle, provider-level file prune, delete-while-downloading.
- [ ] Slice 3, viewport domain fix: V1, V2 (display-to-`galleryIndex` translation), V3, V4 (target capture). Accept: name-desc sort downloads on-screen images first; failed eager target stays `active`.
- [ ] Slice 4, return-first imports plus spinner: I8 (extract helper), I1-I7 (return before bytes), S1 (unhide loading frame). Accept: paste-to-gallery-open never awaits bytes; placeholder shows spinner; swap on arrival. Do not rename probe-queried viewer DOM or action ids.
- [ ] Slice 5, coverage: D9 (within-path cancel), folder-exit eager leak (generation-tagged eager fetch), D8 (batched or deferred cleanup). Accept: deleting a parent cancels descendants; exiting mid-eager cancels IPC; import returns before prune.
