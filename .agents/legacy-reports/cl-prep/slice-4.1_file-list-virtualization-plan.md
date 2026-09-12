# Slice 4.1: File List Virtualization Optimization Plan

## Goal

Implement a high-performance virtualized file list in QuiviT combining the battle-tested mechanisms from **VS Code's `ListView` / `RowCache`** and **TanStack Virtual**, accelerated by modern Chromium rendering.

Key capabilities in this slice:
1. **Absolute Leaf-Node Positioning (`style.top = ${index * ROW_HEIGHT}px`)**: Position pooled rows with `position: absolute; left: 0; width: 100%;`. Coordinates update as leaf nodes without reflowing siblings, maintaining a single unified compositor layer and rock-solid subpixel font rendering.
2. **VS Code `RowCache` Pattern (Active Map + Free Pool)**: Maintain `activeRows = new Map<number, HTMLElement>()` and `freePool = []`. During scrolling, offscreen rows are reclaimed to the free pool, incoming rows are allocated from the free pool, and rows already visible in the viewport are completely skipped with zero CPU cycles.
3. **Single Static Scroll Sizer**: Use a single `.scroll-spacer` with `height: ${total * ROW_HEIGHT}px` set once on folder load. Eliminates scroll-anchoring collisions in Chromium, restoring reliable native mouse wheel and trackpad scrolling.
4. **Zero-Allocation Slot Recycling**: Pre-allocate permanent child references (`li._slots`) during pool creation. Recycling an entry mutates `textContent` and `src` in place with zero `innerHTML`, zero `createElement`, and zero `querySelector` lookups.
5. **State Notification Deduplication Guard**: Short-circuit `renderFilePanel` (0.001ms exit) when `Core.onStateChange` triggers for viewport image decodes (`setImageDimensions`), zoom, pan, or animation resolution where the directory list and selection have not changed.
6. **Surgical Selection Updates**: When moving selection between items already visible in the viewport, toggle `.selected` directly on the previous and new rows without looping the entire DOM slice.
7. **Synchronous Passive Scroll Handling with 10-Row Overscan**: Scroll listener runs directly with `{ passive: true }` and an expanded 10-row overscan buffer (~220px) to guarantee zero blank frames during fast mouse wheel scrolling.
8. **Strict $O(1)$ Scaling Preserved**: Opening huge directories (e.g. 14,321 items in Steam Screenshots) mounts only ~35–45 elements on initial load; the single spacer accurately represents all 14,321 items.

---

## Architectural Invariants & Validation Constraints

Every item in this plan follows [.agents/AGENTS.md](file:///E:/Projects/QuiviT/.agents/AGENTS.md) and [.agents/skills/validate-changes/SKILL.md](file:///E:/Projects/QuiviT/.agents/skills/validate-changes/SKILL.md):

1. **HTML-First Rendering & CSS Source of Truth:**
   - Single `.scroll-spacer` lives inside `#file-list` and sets scroll height.
   - `#file-list li` rows are styled with `position: absolute; left: 0; width: 100%; box-sizing: border-box;`.
2. **One Owner per Surface:**
   - [`filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js) is the sole owner of `#file-list` DOM elements, pool sizing, and row positions.
3. **Pure Modules & Decoupled State:**
   - [`core.js`](file:///E:/Projects/QuiviT/src/js/core.js) remains DOM-free; `filePanel.js` subscribes to state changes via `Core.onStateChange`.
4. **Zero-Allocation Hot Path:**
   - No `innerHTML`, `createElement`, or `querySelector` inside `updateEntry()` or scroll handlers.
   - Permanent slot references are cached directly on `li._slots`.

---

## Proposed Changes

### 1. Styling & CSS Layout
#### [MODIFY] [src/css/main.css](file:///E:/Projects/QuiviT/src/css/main.css)
- [COMPLETED] `[Observable change]` Ensure `#file-list .scroll-spacer` has `display: block; width: 1px; pointer-events: none;` and `#file-list li` has `position: absolute; left: 0; width: 100%; box-sizing: border-box;`.
- [COMPLETED] `[Observable change]` Add `.item-icon-svg` styling for clean SVG fallback dimensions and `currentColor` support.

---

### 2. File Panel Virtualization Engine
#### [MODIFY] [src/js/filepanel/filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- [COMPLETED] `[Observable change]` **Single Sizer**: Set `scrollSpacer.style.height = `${list.length * ROW_HEIGHT}px`` only when list or row height changes, never on scroll ticks.
- [COMPLETED] `[Observable change]` **VS Code `RowCache` Pattern**: Implement `activeRows` (`Map<number, HTMLElement>`) and `freePool` (`Array<HTMLElement>`).
- [COMPLETED] `[Observable change]` **Pre-Allocated Slot Caching (`li._slots`)**: Maintain cached references to `itemName`, `iconImg`, `iconSvg`, `label`, `ext`, `date`, `thumbWrapper`, `thumbImg`, `thumbTitle`, and `thumbMeta` on `li._slots`.
- [COMPLETED] `[Observable change]` **Zero-Allocation `updateEntry()`**: Mutate slot properties in place (`textContent`, `src`, class toggles) without `innerHTML`, `createElement`, or `querySelector`. Set `li.style.top = `${index * ROW_HEIGHT}px``.
- [COMPLETED] `[Observable change]` **2-Phase Reconciled `renderVisibleSlice()`**:
  - Phase 1: Reclaim offscreen rows from `activeRows` to `freePool`.
  - Phase 2: For each visible index, skip if already in `activeRows`; otherwise pull from `freePool`, update, and set coordinates.
- [COMPLETED] `[Observable change]` **State Notification Deduplication Guard**: Short-circuit `renderFilePanel` (0.001ms exit) when state notifications originate from image decodes, zoom, pan, or animation checks where the directory list and selection have not changed.
- [COMPLETED] `[Observable change]` **Surgical Selection Updates**: Directly toggle `.selected` on the two affected rows when navigation stays within the visible slice.
- [COMPLETED] `[Observable change]` **Passive Synchronous Scroll Handling**: Attach scroll handler with `{ passive: true }` and 10-row overscan buffer.

---

### 3. Verification & Safety
#### [MODIFY] [src/js/tests/fileListViewMode.test.mjs](file:///E:/Projects/QuiviT/src/js/tests/fileListViewMode.test.mjs)
- [COMPLETED] `[Observable change]` Add unit tests verifying `activeRows` lifecycle, slot mutation integrity, and sizer height invariance across massive lists.

---

## Verification Plan

### Automated Tests
```pwsh
npm test
node --check src/js/filepanel/filePanel.js src/js/fsUtils.js src/js/core.js
cargo check --tests --manifest-path src-tauri/Cargo.toml
```

### Manual Performance & Behavior Verification
1. **Mouse Wheel & Scrollbar Dragging (Steam Screenshots / 14,321 items)**:
   - Rapidly scroll with mouse wheel and drag scrollbar thumb from top to bottom.
   - Confirm immediate, uninterrupted 60fps scrolling with zero freezing or anchor stutter.
2. **Keyboard Selection Cycling**:
   - Hold <kbd>ArrowDown</kbd> / <kbd>ArrowRight</kbd> to rapidly cycle images.
   - Confirm selection updates smoothly without thrashing off-target rows.
3. **Mode Switching**:
   - Toggle between standard list mode and thumbnail mode via toggle button and menubar.
   - Confirm row heights and icons adapt cleanly across both modes.

---

## Deviations, Violations & Runtime Fixes

1. **`quivit-config-loaded` / `quivit-css-applied` Race Condition**:
   - Fixed an issue where `quivit-config-loaded` reset `ROW_HEIGHT = 0` and called `renderFilePanel()`, which returned early due to the deduplication guard, leaving `ROW_HEIGHT = 0` and muting the scroll event listener.
   - Updated event handlers to call `measureRowHeight()` directly and only re-initialize the pool if the row height actually changed.
2. **Scroll Listener Guarding**:
   - Removed `if (ROW_HEIGHT)` from the scroll and resize listeners so `renderVisibleSlice()` is never bypassed.
3. **Positioning Engine Alignment**:
   - Positioned rows via absolute `style.top` rather than `translate3d`, aligning with the VS Code `ListView` standard to avoid 40-layer compositor synchronization overhead in Chromium while maintaining crisp subpixel font rendering.
4. **Overscan Expansion**:
   - Increased `OVERSCAN` from 5 to 10 rows (~220px buffer) to eliminate visual blanks during fast mouse wheel scrolling.
