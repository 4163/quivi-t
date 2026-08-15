# filePanel.js & fsUtils.js — Decoupling Analysis

> Files: `src/js/filePanel.js` (~874 lines, reported 771) and `src/js/fsUtils.js` (~674 lines, reported 590).

## Part 1 — filePanel.js

### Exports (5)
| Export | Line | Purpose |
|---|---|---|
| `toggleFavoriteCurrent()` | 182 | Star/unstar current entry |
| `getHighlightedFavorite()` | 419 | Currently highlighted favorite or null (main.js action buttons) |
| `navigateHighlightedFavorite(delta)` | 426 | Arrow nav within favorites list |
| `renderFilePanel(state)` | 571 | Full panel render (called by main.js) |
| `initFilePanel(deps)` | 623 | Wires everything; receives `{filePanel, breadcrumbEl, fileListUl, resizeHandle, Core, Viewer, FsUtils}` |

Imports (1): `DirectoryPrefs` from `./directoryPrefs.js`. Everything else is injected at init into module singletons.

**DOM access: Extremely heavy** — getElementById, querySelectorAll, createElement, `documentElement.style.setProperty`, getComputedStyle, document.activeElement, document.body.style, requestAnimationFrame, innerHTML string building.

### Responsibility clusters
| Cluster | Lines | Functions |
|---|---|---|
| Column width management | 46–111 | `setColumnWidth`, `getColumnWidth`, `normalizeColumnWidths`, `initializeColumns` |
| Sort icons + breadcrumb | 113–131 | `updateSortIcons`, `formatBreadcrumbPath` (pure), `renderBreadcrumb` |
| Favorites persistence/state | 133–171 | `getFavorites`, `saveFavorites`, `getFavoritesCollapsed`, `saveFavoritesCollapsed`, `isFavorite`, `toggleFavorite` |
| Favorite star button | 173–196 | `updateFavoriteBtn`, `toggleFavoriteCurrent` |
| Icon cache + native icons | 198–257 | `fetchNativeIcon`, `getIconHtml`, `iconCache` Map |
| Favorites list DOM | 259–353 | `openFavorite`, `buildFavoriteEntry` |
| Favorites render/selection | 355–438 | `renderFavorites`, `toggleFavoritesExpanded`, `updateFavoritesSelection`, `highlightFavoriteByPath`, `getHighlightedFavorite`, `navigateHighlightedFavorite` |
| Main list row rendering + hover preload | 440–533 | `renderEntry` |
| Selection + refresh visual | 535–569 | `updateSelection`, `setRefreshingVisual` |
| Main public render | 571–621 | `renderFilePanel` |
| Wiring (init) | 623–874 | favorites wiring, keyboard nav, click/focus handlers, sort header clicks, panel + column resize, event listeners |

### Coupling / overlap
- Does **not** self-subscribe to Core.onStateChange; invoked externally from main.js (onStateChange handler + setFileListVisible). Render cadence tied to main.js subscription order.
- Hover preload reaches into FsUtils (isImageEntry, isIco, buildArchiveSrc, buildFileSrcSync) — a second, independent preload path alongside viewer.js.
- Favorites read/write `Core.getState().config.frontend_data.favorites` + `Core.persistConfig()`.
- Viewer used **once** — `Viewer.applyFitMode()` in panel-resize mousemove (L844).
- Dispatches `quivit-load-file` **and** listens to it (self-communication); also listens to `quivit-config-loaded`, `quivit-refresh-start/end`.
- Double-click detection duplicated internally (main list vs favorites list).

### Code smells
- 874-line monolith mixing rendering, persistence, keyboard nav, resize drag, icon fetching.
- Singleton module globals set in initFilePanel — hidden state coupling, hard to test.
- `Viewer` dependency used once — should be an event/callback.
- `innerHTML` icon string building; racy async native-icon patching after re-render.
- Self-dispatch + self-listen of `quivit-load-file` (redundant).
- Duplicate click/keyboard semantics for favorites and main list (composite widget nav vs file list nav).
- Direct mutation of `documentElement` CSS custom properties for column widths.

### Decoupling recommendations
1. Split into `filePanelList.js` (render/selection), `favoritesPanel.js` (favorites state + DOM), `filePanelIcons.js` (icon HTML), `filePanelColumns.js` (widths/sort/resize).
2. Replace `Viewer.applyFitMode()` with a dispatched event (e.g. `quivit-panel-resized`), dropping `Viewer` from deps.
3. Self-subscribe to `Core.onStateChange` inside the module (or standardize the single render entry point).
4. Extract pure favorites data layer into `favoritesStore.js` (testable without DOM).
5. Move hover preload into a shared preload helper (or let viewer.js own all image preloading).
6. Replace innerHTML icon templates with createElement/textContent or an escaping helper.
7. De-duplicate double-click + the two keyboard-nav blocks into one reusable helper (keyboardNav.js already exists but is unused by filePanel — dead utility).
8. Remove the redundant `quivit-load-file` self-listener.

## Part 2 — fsUtils.js

### Exports (3)
- `FsUtils` object (L57-673) — 25 methods
- `SUPPORTED_IMAGES` Set (L7)
- `SUPPORTED_ARCHIVES` Set (L11)

Imports: `Core` (core.js), `DirectoryPrefs` (directoryPrefs.js), `createHistoryEntry`, `recordNavigation` (navigationHistory.js).

**DOM access: None.** Closest touches: `navigator.userAgent`, `window.__TAURI__.core` destructured at module top (L5), `window.dispatchEvent` for `quivit-refresh-start/end`, Tauri `dialog.open`, `URL.revokeObjectURL`. **The "mostly non-DOM" property holds** — it is a service/navigation layer.

### Responsibility clusters
| Cluster | Lines | Functions |
|---|---|---|
| Format detection | 7–15, 57–62 | SUPPORTED_IMAGES, SUPPORTED_ARCHIVES, `_ext`, isArchive, isImage, isIco, isArchiveEntry, isImageEntry |
| Path helpers | 31–55 | `parentOf`, `_basename`, `_base64Encode` |
| Object URL lifecycle | 64–66 | `revokeIfObjectURL` |
| Src builders | 68–103 | buildArchiveSrc, buildArchiveEntrySrc, buildFileSrc, buildFileSrcSync |
| Entry/list formatting | 39–44, 105–143 | `_formatDate`, formatEntry, buildDirectoryList, buildArchiveList |
| Index/position helpers | 145–174 | firstImageIndex, naturalPagePosition, formatStatusIndex |
| Config proxy | 176–186 | showHidden, persistLastOpened |
| Directory result → state | 188–264 | applyDirectoryResult |
| Navigation loaders | 266–491 | loadFallbackAncestor, loadArchive, loadFile, openContainer, openParent, openSibling |
| Dialogs | 555–593 | openDirectoryDialog, openFileDialog |
| Refresh | 595–613 | refresh (dispatches window events) |
| History replay | 615–631 | loadHistoryEntry |
| Archive prefetch | 633–673 | prefetchAhead |

### Coupling / overlap
- `buildFileSrc`/`buildArchiveSrc` NOT duplicated — single source used by core, viewer, filePanel, main, metadata. Good.
- `isImage`/`isArchive` centralized — no duplication in keybinds/shortcuts.
- Duplicated inside fsUtils: drive-entry map built twice (loadFile + openSibling).
- Overlap with core.js: `applyDirectoryResult`/`loadArchive` do "find index → build src → revoke old URL → setState → recordNavigation", same pattern as core.js `_selectEntry`.
- Overlap with viewer.js: `prefetchAhead` (backend, ±7) parallels viewer `_schedulePoolPreloads` (browser Image, ±7).
- Composite `"archive|entry"` path parsing reimplemented in main.js (`archiveEntryRealPath`/`archiveEntryContainerPath`).
- Basename helpers duplicated: fsUtils `_basename` private; main.js reimplements twice; metadata.js has its own.
- Image-set subset re-derived in main.js L124 instead of from `SUPPORTED_IMAGES`.

### Code smells
- **Misleading name**: it's a navigation/state-transition service, not just "fs utils".
- **Un-guarded module-top Tauri access** (L5): throws at import if `__TAURI__` undefined — blocks browser testing.
- Heavy `this.` internal calls — extraction fragile.
- Async race handling (`_navigationGeneration`) interleaved through every loader.
- Error/UI state set inside service: `loadArchive` catch writes `Core.setState({ filename: 'Failed to open archive: …' })`.
- `refresh()` couples service to DOM events instead of a callback.
- `buildArchiveSrc` derives Windows-ness from navigator.userAgent (platform sniffing).
- `_formatDate`/`_basename`/`parentOf` private though reimplemented elsewhere — under-exported shared utilities.

### Decoupling recommendations
1. Split into a **format/extension module**, a **path module** (`parentOf`, `_basename`, composite split/join, `_base64Encode`), a **srcBuilder module** (buildFileSrc/Sync, buildArchiveSrc/EntrySrc, revokeIfObjectURL), and a **navigation service** (loaders, applyDirectoryResult, prefetchAhead).
2. Guard `window.__TAURI__` at module scope (or inject invoke/convertFileSrc via an adapter) so pure parts are testable.
3. Replace `this.`-chained calls with direct named-function references.
4. Extract the shared "select src → revoke old → setState → recordNav" sequence into one core service helper.
5. Replace `refresh()`'s `window.dispatchEvent` with the event bus/callback pattern.
6. Export `_basename`/`parentOf`/composite-path helpers so main.js/metadata.js stop reimplementing.
7. Unify the two archive-prefetch strategies under one preload module.

## Part 3 — Cross-file overlap

| Concern | Where | Verdict |
|---|---|---|
| is_image / is_archive | Centralized in FsUtils | ✅ No duplication |
| buildFileSrc / buildArchiveSrc | Centralized in FsUtils | ✅ No duplication |
| Object URL lifecycle | Centralized in FsUtils | ✅ No duplication |
| Basename of path | fsUtils private + main.js (2) + metadata.js | ⚠️ 4 implementations |
| Composite archive\|entry parsing | fsUtils + main.js | ⚠️ 2 implementations |
| Folder-of / parent normalization | fsUtils `parentOf` + main.js regex | ⚠️ Partial |
| Image-set subset for metadata first-image | main.js regex vs SUPPORTED_IMAGES | ⚠️ Duplicated by hand |
| Drive-entry list builder | fsUtils loadFile + openSibling | ⚠️ Internal |
| Archive preload window (±7) | fsUtils prefetchAhead + viewer preload | ⚠️ Two mechanisms |
| Refresh event protocol | fsUtils dispatch; filePanel + main listen | ⚠️ Spans 3 modules |
| Keyboard list navigation | filePanel inline blocks; keyboardNav.js unused | ⚠️ Dead utility + duplication |

**Good patterns to preserve:** extension detection, src building, and object-URL revocation are already centralized in FsUtils — don't duplicate them.

## Part 4 — Pure vs UI-coupled

**filePanel.js:** ~85% UI-coupled. Realistic pure extract: `formatBreadcrumbPath` + a favorites store (~70 lines).

**fsUtils.js:** ~90% pure of DOM. Only 2 methods + `refresh`'s event dispatch couple it to the UI layer. Natural home for the bulk of testable logic.

**Key takeaway:** core.js is a pure state machine, fsUtils.js is a pure-ish service layer with centralized format/URL helpers, filePanel.js is the main DOM sink. Highest-value moves: (1) split filePanel into favorites/list/icons/columns + self-subscribe; (2) promote fsUtils private path helpers to exported shared utilities; (3) drop the one-shot `Viewer` dependency in filePanel; (4) unify the two archive-preload strategies; (5) guard the Tauri import in fsUtils.
