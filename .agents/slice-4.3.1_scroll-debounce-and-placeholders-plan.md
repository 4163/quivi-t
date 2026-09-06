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
- [PENDING] Add styles for `.item-thumbnail-placeholder`:
```css
#file-panel.view-mode-thumbnail #file-list li .item-thumbnail-wrapper,
#file-panel.view-mode-thumbnail #favorites-list li .item-thumbnail-wrapper {
  position: relative;
}

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

#file-panel.view-mode-thumbnail #file-list li .item-thumbnail-img.is-loaded + .item-thumbnail-placeholder,
#file-panel.view-mode-thumbnail #favorites-list li .item-thumbnail-img.is-loaded + .item-thumbnail-placeholder {
  display: none;
}
```

---

### 2. Virtualization Engine & Debouncer

#### [MODIFY] [src/js/filepanel/filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- [PENDING] **Slot Pre-Allocation in `createPoolRow`**:
  - Create `thumbPlaceholder` element (24×24 SVG picture icon).
  - Append to `thumbWrapper` after `thumbImg` and store reference on `li._slots.thumbPlaceholder`.
- [PENDING] **Scroll Settle State Tracking**:
  - Add module variables: `let isScrolling = false; let scrollDebounceTimer = null; const THUMB_SCROLL_DEBOUNCE_MS = 100;`.
  - In `fileListUl` scroll listener:
    - Set `isScrolling = true`.
    - Clear `scrollDebounceTimer`.
    - Set timer to call `onScrollSettle()` after 100ms.
    - Attach `scrollend` listener on `fileListUl` (where supported) to trigger `onScrollSettle()` immediately.
- [PENDING] **Directory Change Reset in `renderFilePanel`**:
  - When rendering a new list (`lastRenderedList !== state.list`), clear `scrollDebounceTimer`, set `scrollDebounceTimer = null`, and reset `isScrolling = false` so initial visible rows render immediately without delay.
- [PENDING] **`onScrollSettle()` Implementation**:
  - Reset `isScrolling = false`.
  - Clear `scrollDebounceTimer = null`.
  - Call `commitPendingThumbnails()` to assign `src` to all currently active visible rows in `activeRows`.
- [PENDING] **Two-Phase `updateEntry()`**:
  - If `isThumbnail`:
    - Synchronously set `slots.thumbTitle` and `slots.thumbMeta`.
    - For non-images: update shell icon immediately.
    - For images:
      - If `isScrolling`: store `targetSrc` on `slots.thumbImg.dataset.pendingSrc`, reset `slots.thumbImg.src = TRANSPARENT_PIXEL`, remove `.is-loaded`, and show placeholder.
      - If not `isScrolling`: assign `slots.thumbImg.src = targetSrc` immediately.
      - On `slots.thumbImg.onload`: add class `is-loaded` to reveal image and hide placeholder.
- [PENDING] **Off-Screen Request Cancellation in `renderVisibleSlice()` Phase 1**:
  - When reclaiming offscreen rows to `freePool`:
    - Remove `dataset.pendingSrc`.
    - Set `slots.thumbImg.src = TRANSPARENT_PIXEL`.
    - Remove `.is-loaded`.

---

## Verification Plan

### Automated Tests
```pwsh
npm test
node --check src/js/filepanel/filePanel.js
```
- Add unit test in `src/js/tests/fileListViewMode.test.mjs` verifying:
  - Scrolling sets `isScrolling` and queues `dataset.pendingSrc` without assigning `src`.
  - Settle fires `commitPendingThumbnails` and assigns `src` to visible rows.
  - Reclaimed rows drop pending state and reset `src`.

### Manual Verification
1. Open a directory with 1,000+ images in thumbnail view.
2. Rapidly drag the scrollbar thumb from top to bottom.
3. Verify the list glides at 60fps+ with placeholder icons visible during movement.
4. Verify thumbnails for the landing rows load cleanly upon stopping without UI freeze.

---

## Deviations, Violations & Runtime Fixes

- None recorded yet.
