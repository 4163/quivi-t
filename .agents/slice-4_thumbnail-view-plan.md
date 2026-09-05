# Slice 4: High-Resolution Shell Icons & File List Thumbnail View Plan

## Goal

Implement a **Thumbnail View Mode** for the file list panel alongside the existing standard list view, while introducing high-resolution 32×32 Windows shell icon extraction in the Rust backend.

Key capabilities in this slice:
1. **Preserved Small Icons in List Mode (Default)**: Normal list view continues using 16×16 small icons (`SHGFI_SMALLICON`) with zero visual disruption and zero performance overhead.
2. **High-Resolution Shell Icon Extraction (`SHGFI_LARGEICON` / 32px)**:
   - Extend the Rust backend ([`icons.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/icons.rs)) to fetch 32×32 shell icons for files, folders, drives, and special directories.
   - Address the Windows shell folder quirk to ensure closed-folder variants are retrieved when requesting large icons.
   - Maintain independent in-memory caches for small and large icons so neither invalidates or competes with the other.
3. **Protocol & IPC Size Discrimination**:
   - Update [`protocol.rs`](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs) (`quivit://icon/...`) to accept an optional size parameter (e.g., `?size=large` or `?size=small`), returning the appropriate PNG buffer on demand.
   - Update [`registry.rs`](file:///E:/Projects/QuiviT/src-tauri/src/commands/registry.rs) command `get_native_icon` with an optional `size` argument, defaulting to `"small"` for full backward compatibility.
4. **File List Thumbnail View Mode**:
   - Add a view mode toggle (`'list'` | `'thumbnail'`) stored in application state and persisted to `quivit_config.json`.
   - In thumbnail mode, render medium-height rows (~52px to 56px) in the virtualized file panel.
   - **Image Entries**: Display the actual image as a preview thumbnail via the existing `quivit://` and `asset://` pipelines, loading lazily with asynchronous decoding. Fall back to the 32px shell icon if decoding fails.
   - **Non-Image Entries**: Folders, archives, parent directories (`..`), drives, and non-image files render the crisp 32×32 shell icon.
5. **Virtualized Pool Geometry & Ergonomics**:
   - Dynamically re-measure row height and update the bounded DOM pool on view mode transition without breaking O(1) recycling.
   - Preserve keyboard navigation, arrow selection, scroll synchronization, double-click to open, and breadcrumb tracking across both view modes.
   - Provide a toggle button on the very left side of .file-panel-actions as the first item, alongside an entry in the menubar **View** menu.

> [!IMPORTANT]
> ## User Review Required
> - **Default View Mode**: Defaults to `'list'` mode to preserve existing performance and visual layout.
> - **Small Icons Preserved**: List mode strictly uses small 16px icons (`SHGFI_SMALLICON`). Large icons are fetched exclusively for the thumbnail view and high-res contexts.
> - **Thumbnail Aspect Ratio**: Previews inside thumbnail cards use `object-fit: contain` with a subtle centered frame to accommodate both portrait and landscape scans.
> - **Fallback Strategy**: If an image thumbnail fails to load or decode, it gracefully displays the 32px native shell icon for its extension.

> [!CAUTION]
> ## Execution Rules
> **Do not mark pending items as completed after writing the code.** Items must remain marked as `[PENDING]` until the user has explicitly approved that the implementation works correctly at runtime.

---

## Architectural Invariants & Validation Constraints

Every item in this plan follows [.agents/AGENTS.md](file:///E:/Projects/QuiviT/.agents/AGENTS.md) and the architectural review standards of [.agents/skills/validate-changes/SKILL.md](file:///E:/Projects/QuiviT/.agents/skills/validate-changes/SKILL.md):

1. **Frontend DOM & Architecture Boundaries:**
   - The state machine ([`core.js`](file:///E:/Projects/QuiviT/src/js/core.js)) maintains zero DOM imports and communicates view mode changes via `Core.onStateChange`.
   - Single owner per surface: [`filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js) is the sole owner of `#file-panel` and `#file-list`. It self-subscribes to view mode changes.
   - HTML-first rendering: Declares view mode toggle buttons and sentinel templates statically in [`index.html`](file:///E:/Projects/QuiviT/src/index.html).
   - CSS source of truth: All row dimensions, thumbnail wrapper styles, and column visibility toggles are declared in [`main.css`](file:///E:/Projects/QuiviT/src/css/main.css). JS only sets `.view-mode-thumbnail` or `.view-mode-list` class tokens on host containers and updates `translateY` transforms.

2. **Performance First & Hot Path Invariants:**
   - **Zero Overhead in List Mode**: List mode bypasses thumbnail image pipeline queries, retaining its lightweight 16px icon lookups and fast 22px row virtualization.
   - **Lazy Thumbnail Decoding**: Image previews use `loading="lazy"` and `decoding="async"`, preventing off-screen decoding stalls during fast scrolling.
   - **Bounded Virtualization Recycling**: The DOM pool size adjusts cleanly (`POOL_SIZE = Math.ceil(panelHeight / rowHeight) + buffer`), recycling existing elements without rebuilding the DOM tree on scroll.
   - **Isolated Icon Caching**: Small and large shell icons are cached independently in the Rust backend, preventing cache evictions or redundant Win32 shell queries.

3. **Blast Radius & Downstream Safety:**
   - **IPC Contract Backward Compatibility**: The `get_native_icon` command accepts `size: Option<String>`, defaulting to `"small"` so existing callers never fail.
   - **Protocol Backward Compatibility**: Requests to `quivit://icon/...` without a size parameter continue serving 16px icons.
   - **Config Persistence Compatibility**: `file_list_view_mode` defaults safely to `'list'` in `frontend_data`.

4. **Stale Code Prevention:**
   - Share thumbnail resolution logic between standalone files and archive entries via [`fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js) rather than duplicating URL generation in [`filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js).

---

## Proposed Changes

### 1. Backend Shell Icon Resolution & Caching
#### [MODIFY] [platform/icons.rs](file:///E:/Projects/QuiviT/src-tauri/src/platform/icons.rs)
- [ ] `[PENDING]` `[Observable change]` Define an `IconSize` enum (`Small = 16`, `Large = 32`).
- [ ] `[PENDING]` `[Observable change]` Update `get_cached_native_icon_png` to accept `size: IconSize`.
- [ ] `[PENDING]` `[Observable change]` Use `SHGFI_LARGEICON` when `IconSize::Large` is requested, and ensure `FILE_ATTRIBUTE_DIRECTORY` retrieves the closed folder icon without `SHGFI_OPENICON`.
- [ ] `[PENDING]` `[Observable change]` Partition `NATIVE_ICON_CACHE` by size (composite keys `format!("{}:{}", size, ext_key)`) so small and large icons are cached separately without collisions.
- [ ] `[PENDING]` `[Observable change]` Keep default `get_cached_native_icon` behavior returning small icons.

#### [MODIFY] [commands/registry.rs](file:///E:/Projects/QuiviT/src-tauri/src/commands/registry.rs)
- [ ] `[PENDING]` `[Observable change]` Update `get_native_icon(path: String, ext_key: String, size: Option<String>)` to pass the parsed size to the icon cache facade.

#### [MODIFY] [protocol.rs](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs)
- [ ] `[PENDING]` `[Observable change]` Parse query parameter `size` in `parse_icon_url` (`quivit://icon/...?...&size=large`).
- [ ] `[PENDING]` `[Observable change]` Request `IconSize::Large` from `get_cached_native_icon_png` when `size=large` is present in the icon URL.

---

### 2. Frontend Services & State Machine
#### [MODIFY] [services/actions.js](file:///E:/Projects/QuiviT/src/js/services/actions.js)
- [ ] `[PENDING]` `[Observable change]` Register action `cmd-toggle-file-list-view-mode` with label `Toggle Thumbnail / List View` in category `View`.

#### [MODIFY] [core.js](file:///E:/Projects/QuiviT/src/js/core.js)
- [ ] `[PENDING]` `[Observable change]` Add `fileListViewMode: 'list' | 'thumbnail'` to default state.
- [ ] `[PENDING]` `[Observable change]` Add `Core.setFileListViewMode(mode)` and `Core.toggleFileListViewMode()`.
- [ ] `[PENDING]` `[Observable change]` In `loadConfig()` and `buildConfigFromState()`, read and persist `file_list_view_mode` under `frontend_data`.

#### [MODIFY] [fsUtils.js](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
- [ ] `[PENDING]` `[Observable change]` Update `buildNativeIconSrc(path, extKey, size = 'small')` to include `?size=large` when requested.
- [ ] `[PENDING]` `[Observable change]` Add `buildThumbnailSrc(item, state)` helper that returns the image preview URL for image files or the large shell icon for non-images.

---

### 3. File Panel Markup & Menu Chrome
#### [MODIFY] [index.html](file:///E:/Projects/QuiviT/src/index.html)
- [ ] `[PENDING]` `[Observable change]` Add view mode toggle button on the very left side of `.file-panel-actions` as the first item (`#btn-toggle-view-mode`), positioned before `#cmd-open-explorer`.
- [ ] `[PENDING]` `[Observable change]` Add View Mode toggle menuitem in menubar **View** dropdown.
- [ ] `[PENDING]` `[Observable change]` Add sentinel element `#file-list-thumbnail-sentinel` for measuring thumbnail row height.

#### [MODIFY] [menubar.js](file:///E:/Projects/QuiviT/src/js/menubar.js)
- [ ] `[PENDING]` `[Observable change]` Wire `cmd-toggle-file-list-view-mode` in the View menu and synchronize checkmark state based on `state.fileListViewMode`.

---

### 4. Virtualized File Panel Rendering & Layout
#### [MODIFY] [filepanel/filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- [ ] `[PENDING]` `[Observable change]` Measure `ROW_HEIGHT` dynamically based on active view mode (using `#file-list-sentinel` in list mode and `#file-list-thumbnail-sentinel` in thumbnail mode).
- [ ] `[PENDING]` `[Observable change]` When `fileListViewMode` changes, toggle `.view-mode-thumbnail` on `#file-panel`, recalculate pool size, re-measure `ROW_HEIGHT`, and re-render the visible slice.
- [ ] `[PENDING]` `[Observable change]` In thumbnail mode:
  - For image entries, render a dedicated thumbnail preview container with `loading="lazy"`, `decoding="async"`, and an `onerror` fallback to the 32px shell icon.
  - For non-image entries (folders, archives, `..`, text files, drives), render the crisp 32×32 shell icon.
  - Layout file name and metadata in a multi-line format beside the thumbnail preview.
- [ ] `[PENDING]` `[Observable change]` In list mode, keep existing 16px icon rendering and 3-column grid layout completely unchanged.
- [ ] `[PENDING]` `[Observable change]` Preserve keyboard arrow navigation, selection scroll, double-click entry, and breadcrumb updating across mode transitions.

#### [MODIFY] [css/main.css](file:///E:/Projects/QuiviT/src/css/main.css)
- [ ] `[PENDING]` `[Observable change]` Add styles for `#file-panel.view-mode-thumbnail`:
  - Hide column headers (`#file-list-header`).
  - Style thumbnail rows with fixed height (~52px to 56px), flexbox row layout, and smooth hover/selected states.
  - Style `.item-thumbnail-wrapper` with a square centered container and `object-fit: contain`.
  - Style `.item-thumbnail-info` with title on top and extension/date metadata beneath.

---

### 5. Documentation & Backlog Tracking
#### [MODIFY] [.agents/cl-refactor-report.md](file:///E:/Projects/QuiviT/.agents/cl-refactor-report.md) & [.agents/implemented.md](file:///E:/Projects/QuiviT/.agents/implemented.md)
- [ ] `[PENDING]` `[Observable change]` Mark High-Resolution Shell Icons and Thumbnail View Mode as implemented in `cl-refactor-report.md` upon completion.
- [ ] `[PENDING]` `[Observable change]` Document the new view mode in `implemented.md`.

---

## Verification Plan

### Automated Tests
1. **Node Unit Tests**:
   - Run: `npm test`
   - Verify all existing tests pass ([`viewerMath.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/viewerMath.test.mjs), [`coreSpread.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/coreSpread.test.mjs), [`boundedMap.test.mjs`](file:///E:/Projects/QuiviT/src/js/tests/boundedMap.test.mjs)).
2. **Backend Icon & Protocol Unit Tests**:
   - Test `get_cached_native_icon_png` with both `IconSize::Small` and `IconSize::Large`.
   - Run: `cargo test --manifest-path src-tauri/Cargo.toml test_icon` (or targeted test filter).
3. **Rust Compilation & Syntax Checks**:
   - Run: `cargo check --tests --manifest-path src-tauri/Cargo.toml`
   - Run: `node --check src/js/filepanel/filePanel.js src/js/fsUtils.js src/js/core.js src/js/menubar.js`

### Manual Verification Hand-off
1. **List Mode Parity**:
   - Open QuiviT in default list mode.
   - Confirm file list displays with original 16px shell icons and 3-column headers (`Name`, `Ext`, `Date`).
   - Confirm row height and selection behavior match previous behavior.
2. **Thumbnail View Mode Toggle**:
   - Click the view mode toggle button on the far left of `.file-panel-actions` (or select **View → Thumbnail View** in the menubar).
   - Confirm the file panel switches to thumbnail mode and the column header row hides.
   - Confirm pressing the shortcut or toggle button again switches back to list mode seamlessly.
3. **Image Preview Thumbnails**:
   - In thumbnail mode, navigate to a directory containing image files (`jpg`, `png`, `webp`, `gif`, etc.).
   - Confirm each image row displays a centered preview of the actual image.
   - Confirm scrolling through the list remains smooth without UI hitching or decoding lag.
4. **Non-Image High-Resolution Shell Icons**:
   - In thumbnail mode, observe folders, archives, `..`, and non-image files.
   - Confirm each displays a crisp, unpixelated 32×32 Windows shell icon.
   - Confirm folders display standard closed-folder icons rather than open-folder variants.
5. **Archive Navigation in Thumbnail View**:
   - Open an archive (`.zip`, `.cbz`, `.rar`, etc.) while in thumbnail mode.
   - Confirm images inside the archive display their entry thumbnails.
   - Confirm `..` displays the large folder/return icon and returns to the parent directory.
6. **Keyboard Navigation & Selection**:
   - In thumbnail mode, navigate up and down with <kbd>ArrowUp</kbd> and <kbd>ArrowDown</kbd>.
   - Confirm the selected row updates and scrolls into view properly.
   - Press <kbd>Enter</kbd> to open files and folders. Confirm navigation works identically to list mode.
7. **Config Persistence**:
   - Set view mode to Thumbnail View.
   - Restart the application.
   - Confirm QuiviT re-opens with Thumbnail View active if configured, or preserves state properly across sessions.

---

## Deviations, Violations & Runtime Fixes

*(Reserved for tracking issues, scope adjustments, or AGENTS.md compliance audits during implementation.)*
