# Slice 4.3.1: Scroll Debouncing, Request Cancellation & Skeleton Placeholders Plan

## Goal

Implement client-side scroll throttling, request cancellation, and skeleton placeholder states for the virtualized file panel in thumbnail mode, preventing transient off-screen rows from dispatching wasteful image decodes during rapid scrolling.

Key capabilities in this slice:
1. **100ms Scroll Settle Debouncing**:
   - Add `THUMB_SCROLL_DEBOUNCE_MS = 100` constant in [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js).
   - Track active scrolling state using native `scrollend` event with a 100ms debounce timer fallback.
   - Defer image assignments while scrolling rapidly; assign image sources only when scrolling settles.
2. **Two-Phase Row Update Pipeline**:
   - Split row updating: coordinates, text metadata, selection, and cached shell icons update immediately on every scroll tick.
   - Only media thumbnail loading is deferred until scroll settle.
3. **Pre-Allocated Skeleton Placeholder (`thumbPlaceholder`)**:
   - Pre-allocate a 24×24 muted SVG picture placeholder on `li._slots` inside each 44×44 thumbnail slot during bounded pool creation.
   - Display placeholder while scrolling or while the image is loading; cleanly hide once `thumbImg.onload` fires.
4. **Off-Screen Request Cancellation**:
   - In Phase 1 of `renderVisibleSlice`, when a row is reclaimed into `freePool`, clear its pending thumbnail state and reset `src = TRANSPARENT_PIXEL` to cancel browser and backend decode pipelines.
5. **Immediate Initial Render**:
   - Initial folder open, directory change, or selection jumps bypass the debounce timer so visible thumbnails load immediately without an artificial delay.

> [!IMPORTANT]
> ## User Review Required
> - **Debounce Timing**: 100ms settle window. Fast enough to feel responsive when stopping, but long enough to filter out 60Hz/144Hz scroll frames and fast scrollbar dragging.
> - **Zero DOM Allocation Invariant**: Placeholders are pre-allocated during `initDomPool()` / `createPoolRow()` on `li._slots.thumbPlaceholder`, maintaining $O(1)$ recycling with zero runtime DOM creation.

> [!CAUTION]
> ## Execution Rules
> **Do not mark pending items as completed after writing the code.** Items must remain marked as `[PENDING]` until the user has explicitly verified and approved that the implementation functions properly at runtime.

---

## Architectural Invariants & Validation Constraints

Every item in this plan follows [.agents/AGENTS.md](file:///E:/Projects/QuiviT/.agents/AGENTS.md) and [.agents/skills/validate-changes/SKILL.md](file:///E:/Projects/QuiviT/.agents/skills/validate-changes/SKILL.md):

1. **Frontend DOM & Architecture Boundaries:**
   - [`core.js`](file:///E:/Projects/QuiviT/src/js/core.js) remains pure domain with zero DOM dependencies.
   - [`filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js) remains the sole owner of `#file-panel` and `#file-list` rendering.
   - CSS remains the visual source of truth in [`main.css`](file:///E:/Projects/QuiviT/src/css/main.css).
2. **Zero-Allocation Hot Path Invariant:**
   - No `innerHTML`, `createElement`, or DOM queries on scroll ticks or row recycling.
   - Child element references are strictly accessed via `li._slots`.
3. **Zero Overhead in Standard List Mode:**
   - List mode remains completely unaffected, continuing to use its lightweight 22px row recycling and 16px icon lookups.

---

## Proposed Changes

### 1. Styling & CSS Layout

#### [MODIFY] [src/css/main.css](file:///E:/Projects/QuiviT/src/css/main.css)
- [COMPLETED] Add styles for `.item-thumbnail-placeholder` with type-based switching:
```css
#file-panel.view-mode-thumbnail #file-list li .item-thumbnail-placeholder,
#file-panel.view-mode-thumbnail #favorites-list li .item-thumbnail-placeholder {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--text-dim);
  opacity: 0.35;
  pointer-events: none;
}

#file-panel.view-mode-thumbnail #file-list li .item-thumbnail-placeholder .placeholder-icon,
#file-panel.view-mode-thumbnail #favorites-list li .item-thumbnail-placeholder .placeholder-icon {
  display: none;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
}

#file-panel.view-mode-thumbnail #file-list li .item-thumbnail-placeholder:not([data-type]) .icon-image,
#file-panel.view-mode-thumbnail #file-list li .item-thumbnail-placeholder[data-type="image"] .icon-image,
#file-panel.view-mode-thumbnail #file-list li .item-thumbnail-placeholder[data-type="folder"] .icon-folder,
#file-panel.view-mode-thumbnail #file-list li .item-thumbnail-placeholder[data-type="archive"] .icon-archive,
#file-panel.view-mode-thumbnail #file-list li .item-thumbnail-placeholder[data-type="file"] .icon-file,
#file-panel.view-mode-thumbnail #favorites-list li .item-thumbnail-placeholder:not([data-type]) .icon-image,
#file-panel.view-mode-thumbnail #favorites-list li .item-thumbnail-placeholder[data-type="image"] .icon-image,
#file-panel.view-mode-thumbnail #favorites-list li .item-thumbnail-placeholder[data-type="folder"] .icon-folder,
#file-panel.view-mode-thumbnail #favorites-list li .item-thumbnail-placeholder[data-type="archive"] .icon-archive,
#file-panel.view-mode-thumbnail #favorites-list li .item-thumbnail-placeholder[data-type="file"] .icon-file {
  display: block;
}

#file-panel.view-mode-thumbnail #file-list li .item-thumbnail-img.is-loaded + .item-thumbnail-placeholder,
#file-panel.view-mode-thumbnail #favorites-list li .item-thumbnail-img.is-loaded + .item-thumbnail-placeholder {
  display: none;
}
```

---

### 2. Virtualization Engine & Debouncer

#### [MODIFY] [src/js/filepanel/filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- [COMPLETED] **Slot Pre-Allocation in `createPoolRow`**:
  - Pre-allocate 24×24 SVG picture, folder, archive, and file icons inside `thumbPlaceholder`.
  - Append to `thumbWrapper` after `thumbImg` and store reference on `li._slots.thumbPlaceholder`.
  - In `updateEntry()`, update `slots.thumbPlaceholder.dataset.type` via pure helper `getPlaceholderType(item)` with zero DOM allocation on scroll ticks.
- [COMPLETED] **Scroll Settle State Tracking**:
  - Add module variables: `let isScrolling = false; let scrollDebounceTimer = null; const THUMB_SCROLL_DEBOUNCE_MS = 100;`.
  - In `fileListUl` scroll listener:
    - Set `isScrolling = true`.
    - Clear `scrollDebounceTimer`.
    - Set timer to call `onScrollSettle()` after 100ms.
    - Attach `scrollend` listener on `fileListUl` (where supported) to trigger `onScrollSettle()` immediately.
- [COMPLETED] **Directory Change Reset in `renderFilePanel`**:
  - When rendering a new list (`lastRenderedList !== state.list`), clear `scrollDebounceTimer`, set `scrollDebounceTimer = null`, and reset `isScrolling = false` so initial visible rows render immediately without delay.
- [COMPLETED] **`onScrollSettle()` Implementation**:
  - Reset `isScrolling = false`.
  - Clear `scrollDebounceTimer = null`.
  - Call `commitPendingThumbnails()` to assign `src` to all currently active visible rows in `activeRows`.
- [COMPLETED] **Two-Phase `updateEntry()`**:
  - If `isThumbnail`:
    - Synchronously set `slots.thumbTitle` and `slots.thumbMeta`.
    - For non-images: update shell icon immediately.
    - For images:
      - If `isScrolling`: store `targetSrc` on `slots.thumbImg.dataset.pendingSrc`, reset `slots.thumbImg.src = TRANSPARENT_PIXEL`, remove `.is-loaded`, and show placeholder.
      - If not `isScrolling`: assign `slots.thumbImg.src = targetSrc` immediately.
      - On `slots.thumbImg.onload`: add class `is-loaded` to reveal image and hide placeholder.
- [COMPLETED] **Off-Screen Request Cancellation in `renderVisibleSlice()` Phase 1**:
  - When reclaiming offscreen rows to `freePool`:
    - Remove `dataset.pendingSrc`.
    - Set `slots.thumbImg.src = TRANSPARENT_PIXEL`.
    - Remove `.is-loaded`.

---

### 3. In-Memory Frontend Thumbnail Caching

#### [MODIFY] [src/js/filepanel/filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- [COMPLETED] **Bounded Map LRU Cache**: Export named constant `THUMB_CACHE_CAPACITY = 250` and `thumbnailCache = new BoundedMap(THUMB_CACHE_CAPACITY)` to retain verified loaded thumbnail sources (~14 screens on 1080p, covering entire manga volumes under ~10 MB RAM).
- [COMPLETED] **Immediate Cached Source Assignment**: In `updateEntry()`, if an item's thumbnail URL is already in `thumbnailCache`, assign `slots.thumbImg.src` and add `.is-loaded` immediately on the same frame, even while scrolling, eliminating skeleton flicker on revisit.
- [COMPLETED] **Error Fallback Caching**: On thumbnail decode failure (`onerror`), cache the native icon fallback in `thumbnailCache` to prevent repeated failed decode attempts.
- [COMPLETED] **Cache Invalidation on Refresh**: Clear `thumbnailCache` in `setRefreshingVisual(active)` so manual refreshes (`F5` / `Ctrl+R`) pull fresh images.

---

### 4. Container Open Default Selection Fix

#### [MODIFY] [src/js/fsUtils.js](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
- [COMPLETED] **Scope Index Preservation to Refresh**: Restricted `findNearestSurvivingIndex` exclusively to `options.isRefresh`.
- [COMPLETED] **Legacy Default Selection on Initial Open**: In `loadArchive` and `applyDirectoryResult`, when navigating into a container without an explicit target:
  - If `open_first_image` is enabled: select first image entry via `this.firstImageIndex(files, 1)`.
  - If `open_first_image` is disabled: select entry 0 (`..`), setting `src = ''` and `filename = '..'`.

---

### 5. Cache module extraction

#### [NEW] [src/js/services/cache.js](file:///E:/Projects/QuiviT/src/js/services/cache.js)
- [COMPLETED] Extract `BoundedMap` from `fsUtils.js` into a standalone pure service module with zero DOM dependencies, enabling reuse by the image viewer.

#### [MODIFY] [src/js/fsUtils.js](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
- [COMPLETED] Import `BoundedMap` from `services/cache.js` and re-export for backward compatibility.

#### [MODIFY] [src/js/filepanel/filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- [COMPLETED] Import `BoundedMap` from `services/cache.js` directly instead of from `fsUtils.js`.

#### [MODIFY] [src/js/tests/boundedMap.test.mjs](file:///E:/Projects/QuiviT/src/js/tests/boundedMap.test.mjs)
- [COMPLETED] Update import path to `services/cache.js`.

---

### 6. Canonical icon URLs and HTTP caching

#### [MODIFY] [src-tauri/src/protocol.rs](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs)
- [COMPLETED] Add `Cache-Control: public, max-age=86400` to `png_response` so WebView2 caches icon PNGs across navigations.

#### [MODIFY] [src/js/fsUtils.js](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
- [COMPLETED] **Fix favorite routing in archive mode**: When `item.path` is an absolute system path, resolve via `buildFileSrcSync` instead of falling into `state.mode === 'archive'`.
- [COMPLETED] **Canonicalize non-image icon URLs**: Pass empty path `''` to `buildNativeIconSrc` for generic folders and standard extensions. Only drives and special shell folders keep their real path.
- [COMPLETED] Add `_isAbsolutePath(p)` and `_isPathSpecificIcon(extKey)` helpers.

#### [MODIFY] [src/js/filepanel/filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- [COMPLETED] **Canonicalize list mode icon probe URLs**: Pass canonical empty path to `fetchNativeIcon` in `getIconHtml` and `updateRowIcon` for generic types.
- [COMPLETED] **Canonicalize thumbnail fallback URLs**: Use canonical path in `updateEntry` onerror handler.

---

### 7. Favorites cache isolation

#### [MODIFY] [src/js/filepanel/filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- [COMPLETED] Add `FAVORITES_CACHE_CAPACITY = 250` and `favoritesThumbnailCache = new BoundedMap(FAVORITES_CACHE_CAPACITY)` isolated from the main virtualized list cache.
- [COMPLETED] Add `staticIconCache = new Map()` for canonical large format/folder icons (~20 entries), preventing image scrolling from evicting shared icons.
- [COMPLETED] Update `buildFavoriteEntry` to use `favoritesThumbnailCache` and pass `null` state to `buildThumbnailSrc` so favorites never inherit the viewer's archive context.
- [COMPLETED] Route non-image thumbnail URLs in `updateEntry` through `staticIconCache` so they survive scrolling past 250 images.
- [COMPLETED] `favoritesThumbnailCache` and `staticIconCache` are not cleared on refresh.

---

## Verification Plan

### Automated Tests
```pwsh
npm test
node --check src/js/filepanel/filePanel.js src/js/fsUtils.js src/js/services/cache.js
cargo check --tests --manifest-path src-tauri/Cargo.toml
```
- Added unit tests in `src/js/tests/fileListViewMode.test.mjs` verifying:
  - Scrolling sets `isScrolling` and queues `dataset.pendingSrc` without assigning `src`.
  - Settle fires `commitPendingThumbnails` and assigns `src` to visible rows.
  - Reclaimed rows drop pending state and reset `src`.
  - Loaded thumbnails are retained in `thumbnailCache` and synchronously reused during scrolling.
- Added unit tests in `src/js/tests/refresh.test.mjs` verifying:
  - Initial directory open selects `..` (index 0) when `open_first_image` is disabled.
  - Initial directory open selects first image when `open_first_image` is enabled.
  - Initial archive open selects `..` (index 0) when `open_first_image` is disabled.
  - Initial archive open selects first image when `open_first_image` is enabled.
- Tests for canonical URL generation, favorites cache isolation, and `_isAbsolutePath` helper.

### Manual Verification
1. Open a directory with 1,000+ images in thumbnail view.
2. Rapidly drag the scrollbar thumb from top to bottom: list glides at 60fps+ with placeholder icons visible during movement without image decode thrashing.
3. Release the scrollbar thumb: thumbnails for the landing rows load promptly.
4. Scroll back up or down: previously loaded items render instantly without placeholder skeletons.
5. Open an archive or folder: selection defaults cleanly to `..` or first image according to preferences.
6. Add several favorites (folders, archives, image files), open a large archive, verify favorites render without skeleton flicker or broken icons.
7. Navigate across directories. Verify folder/archive icons render instantly after the first visit. Confirm canonical URL deduplication in DevTools Network tab.

---

## Deviations, Violations & Runtime Fixes

- **Container Open Selection Default Fix (`src/js/fsUtils.js`)**: Fixed UX regression where opening an archive or folder defaulted selection to the previous directory index. Restricted `findNearestSurvivingIndex` strictly to `options.isRefresh`. Initial navigation into a container now correctly defaults to `..` (index 0) with blank image when `open_first_image` is off, or the first image entry when `open_first_image` is enabled.
- **In-Memory Frontend Thumbnail Cache (`src/js/filepanel/filePanel.js`)**: Exported `THUMB_CACHE_CAPACITY = 250` and `thumbnailCache = new BoundedMap(THUMB_CACHE_CAPACITY)` to retain loaded thumbnail URLs (~14 full screens on 1080p, covering entire manga volumes under ~10 MB RAM). Revisiting previously loaded rows assigns `.src` and `.is-loaded` synchronously on the same frame, eliminating debounce delays and skeleton placeholder flashing during bidirectional scrolling. Cache is cleared on manual `F5` refresh.
- **Distinct Skeleton Placeholders for Folders and Archives (`src/js/filepanel/filePanel.js`, `src/css/main.css`)**: Pre-allocated SVG icons for image, folder, archive, and file types inside `thumbPlaceholder`. Added `getPlaceholderType(item)` and CSS `data-type` switching to display dedicated folder and archive box skeletons instead of generic image icons while rows are loading or during scrolling, preserving zero runtime DOM allocation on scroll ticks.
