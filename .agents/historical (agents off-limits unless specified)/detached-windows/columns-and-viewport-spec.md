# File List Columns and Viewport Menu Specification

Validation comparison against `.agents/skills/validate-changes/SKILL.md` was performed before presenting this document.

## Locked Definitions and Deviation Rules

- **Scope lock.** This plan covers four connected slices:
  1. Convert `Windows -> Viewport` into a permanently muted visual indicator with no submenu and no keybind actions.
  2. Add the `Windows -> Columns` submenu with `Name`, `Ext`, `Modified`, `Size`, and `Dims` toggles, persisted in `frontend_data.file_list_columns` and exposed in `Options -> Keys`.
  3. Add dynamic column visibility, grid width normalization, sort fallback when an active sort column is disabled, and `Size` + `Dims` comparators.
  4. Implement lazy header-only `Dims` probing on a background thread with bounded frontend caching, batched IPC streaming, and format edge-case coverage.
- **Zero-overhead invariant for `Dims`.** Dimension scanning must never run when `file_list_columns.dims` is `false`. Enabling `Dims` while a directory or archive is open starts the scan immediately for the active container. Disabling `Dims` or switching containers cancels any in-flight scan via an atomic generation counter.
- **Sort fallback invariant.** Each directory or archive resolves its sort order from `directory_sorts[path]` first, then `default_sort`. If the resolved column is currently disabled in `file_list_columns`, it falls back to `default_sort` when `default_sort.col` is enabled, or `{ col: 'name', desc: false }` when `default_sort.col` is also disabled. Toggling off the active sort column immediately re-sorts the current list to the fallback order while preserving the selected entry.
- **Architecture boundaries.**
  - State machine in `src/js/core.js` and pure comparators in `src/js/services/sorting.js` have zero DOM imports.
  - Visual visibility of columns is driven by CSS custom properties and `#file-panel` classes in `src/css/global.css` and `src/css/main.css`, not inline style mutations on row cells.
  - Virtualized rows in `src/js/filepanel/filePanel.js` allocate fixed `.item-size` and `.item-dims` spans in `createPoolRow()` and update via `textContent`.
- **Deviation rule.** Do not add unrequested columns, do not persist per-file dimensions to `config.json`, and do not create new test suites during implementation.

---

## 1. `Windows -> Viewport` Visual Indicator

### Specification
- `#menu-window-viewport` in `src/index.html` retains `#viewport-position-label`, adds `.muted` and `aria-disabled="true"`, and removes `.has-submenu`, `<span class="submenu-arrow">›</span>`, and its child `<ul class="menu-dropdown submenu">`.
- `src/js/menubar.js` continues updating `#viewport-position-label` on state change to `Right`, `Left`, `Bottom`, `Top`, or `Window`, while ignoring `.muted` or submenu-less `.has-submenu` items during hover, click, and keyboard submenu expansion so `#menu-window-viewport` never gains `.open` or `aria-expanded="true"`.
- `src/js/services/actions.js` stops generating `cmd-window-viewport-*` entries in `ACTION_REGISTRY` so viewport placement commands no longer appear under `Options -> Keys`.

### Implementation Checklist
- [x] **1.1 Strip Viewport submenu markup** at `src/index.html:162-171`.
  - Change `<li id="menu-window-viewport" class="has-submenu" role="menuitem" aria-haspopup="true" aria-expanded="false">` to `<li id="menu-window-viewport" class="muted" role="menuitem" aria-disabled="true">` and remove `<span class="submenu-arrow">›</span>` and the nested `<ul class="menu-dropdown submenu" role="menu">...</ul>`.
  - *Accept:* `#menu-window-viewport` has no `.submenu` child, no `.submenu-arrow`, retains `#viewport-position-label`, and renders muted.
- [x] **1.2 Guard submenu activation on muted or childless items** at `src/js/menubar.js:139-145`, `src/js/menubar.js:307-318`, and `src/js/menubar.js:417-425`.
  - In `activateItem` and the `ArrowRight`, `Enter`, and ` ` handlers, require `!item.classList.contains('muted')`, `item.getAttribute('aria-disabled') !== 'true'`, and `item.querySelector(':scope > .submenu')` before adding `.open` or setting `aria-expanded="true"`.
  - *Accept:* Hovering or navigating over `Viewport: <Position>` does not highlight the row in accent blue or throw when pressing `ArrowRight`.
- [x] **1.3 Keep muted submenu arrow dimmed on hover** at `src/css/main.css:221-225`.
  - Scope `.menu-dropdown li.has-submenu:hover > .submenu-arrow` to `:not(.muted)` so muted rows keep `opacity: 0.6`.
  - *Accept:* Hovering `#menu-window-viewport` does not brighten its arrow.
- [x] **1.4 Drop `cmd-window-viewport-*` from `ACTION_REGISTRY`** at `src/js/services/actions.js:198-204`.
  - Filter `WORKSPACE_SURFACES` to `surface.id === 'fileList'` when building window placement actions, leaving `WORKSPACE_SURFACES` intact in `src/js/services/workspaceLayout.js` for layout normalization and `#viewport-position-label` sync at `src/js/menubar.js:818-824`.
  - *Accept:* `Options -> Keys` lists `File list: Left/Right/Top/Bottom/Window` and contains zero `Viewport:` entries.

---

## 2. `Windows -> Columns` Submenu, Config, and Keybinds

### Specification
- **Canonical column order:** `Name` as `name`, `Ext` as `ext`, `Dims` as `dims`, `Modified` as `date`, and `Size` as `size`.
- **Default state:** `Name` is always on and non-interactive with `class="checked muted"` and `aria-disabled="true"`. Toggleable defaults in `frontend_data.file_list_columns`:
  ```json
  { "ext": true, "dims": false, "date": true, "size": false }
  ```
- **Menu behavior:** Clicking a column item in `Windows -> Columns` toggles that column's visibility on the file list without sorting by that column.
- **Keybinds:** Register 4 toggle actions in `ACTION_REGISTRY` under `src/js/services/actions.js` with `defaultBinds: []`:
  - `cmd-col-ext`: `Column: Ext`
  - `cmd-col-dims`: `Column: Dims`
  - `cmd-col-date`: `Column: Modified`
  - `cmd-col-size`: `Column: Size`

### Implementation Checklist
- [x] **2.1 Add `Windows -> Columns` submenu markup** at `src/index.html:150-173`.
  - Insert `<li id="menu-window-columns" class="has-submenu" role="menuitem" aria-haspopup="true" aria-expanded="false"><span>Columns</span><span class="submenu-arrow">›</span><ul class="menu-dropdown submenu" role="menu">...</ul></li>` under `#menu-windows`.
  - Include:
    - `<li id="cmd-col-name" class="checked muted" role="menuitemcheckbox" aria-checked="true" aria-disabled="true"><span>Name</span><span class="shortcut"></span></li>`
    - `<li id="cmd-col-ext" class="checked" role="menuitemcheckbox" aria-checked="true"><span>Ext</span><span class="shortcut"></span></li>`
    - `<li id="cmd-col-dims" role="menuitemcheckbox" aria-checked="false"><span>Dims</span><span class="shortcut"></span></li>`
    - `<li id="cmd-col-date" class="checked" role="menuitemcheckbox" aria-checked="true"><span>Modified</span><span class="shortcut"></span></li>`
    - `<li id="cmd-col-size" role="menuitemcheckbox" aria-checked="false"><span>Size</span><span class="shortcut"></span></li>`
  - *Accept:* `Windows -> Columns` opens on hover and keyboard navigation and displays all five columns with checkmarks on `Name`, `Ext`, and `Modified` by default.
- [x] **2.2 Normalize `file_list_columns` in config merge and state** at `src/js/keybinds.js:35-93` and `src/js/core.js:24-136`.
  - Define `DEFAULT_FILE_LIST_COLUMNS = { ext: true, dims: false, date: true, size: false }` and a shared normalizer `normalizeFileListColumns` that coerces `ext`, `dims`, `date`, and `size` to booleans with defaults `{ ext: true, dims: false, date: true, size: false }`.
  - Add `file_list_columns` to `state.config.frontend_data` in `src/js/core.js:34-61`, `mergeConfig` in `src/js/keybinds.js:55-90`, and `CORE_SESSION_METHODS` in `src/js/core.js:116-123` with `toggleFileListColumn`.
  - *Accept:* Missing or partial `file_list_columns` in `config.json` normalizes cleanly without losing existing `ext` or `date` visibility.
- [x] **2.3 Register column toggle actions** at `src/js/services/actions.js:198-215`.
  - Add `cmd-col-ext`, `cmd-col-dims`, `cmd-col-date`, and `cmd-col-size` in `ACTION_REGISTRY` with category `'Window & UI'`, `defaultBinds: []`, and `handler: ({ Core }) => Core.toggleFileListColumn('<col>')`.
  - *Accept:* All four actions appear in `Options -> Keys`, can be bound to custom shortcuts, and display their assigned shortcut labels inside `Windows -> Columns`.
- [x] **2.4 Sync `Windows -> Columns` checkmarks** at `src/js/menubar.js:805-846`.
  - In `syncViewMenu`, read `state.config?.frontend_data?.file_list_columns` and toggle `.checked` and `aria-checked` on `#cmd-col-ext`, `#cmd-col-dims`, `#cmd-col-date`, and `#cmd-col-size`.
  - *Accept:* Toggling any column via menu click or shortcut updates the menu checkmark in both `main` and `workspace-file-list`.

---

## 3. File Panel Dynamic Columns, Grid Layout, and Sort Fallback

### Specification
- **Static DOM structure:**
  - `#file-panel-header` at `src/index.html:228-241` and `#file-list-sentinel` at `src/index.html:244-248` declare all five columns in canonical order: `name`, `ext`, `dims`, `date`, `size`.
  - `createPoolRow` at `src/js/filepanel/filePanel.js:1761-1859` creates `.item-size` and `.item-dims` spans once per pooled row and stores them in `li._slots.size` and `li._slots.dims`.
- **CSS-driven visibility and grid tracks:**
  - `:root` in `src/css/global.css:62-65` defines `--col-size-w: 68px;`, `--col-dims-w: 84px;`, and `--file-grid-cols: var(--col-name-w) var(--col-ext-w) var(--col-date-w);`.
  - `#file-panel-header` at `src/css/main.css:1148` and `#file-list li` at `src/css/main.css:1278` use `grid-template-columns: var(--file-grid-cols);`.
  - `#file-panel` toggles classes `col-hide-ext`, `col-hide-date`, `col-hide-size`, and `col-hide-dims`. CSS rules hide disabled header cells and row spans with `display: none`.
  - `normalizeColumnWidths` at `src/js/filepanel/filePanel.js:439-482` computes widths only across enabled columns and writes `--file-grid-cols` on `document.documentElement`.
- **Sort fallback on column disable:**
  - `DirectoryPrefs.isColumnEnabled` returns `true` for `'name'` and checks `Core.getState().config?.frontend_data?.file_list_columns?.[col]` for `'ext'`, `'date'`, `'size'`, and `'dims'`.
  - `DirectoryPrefs.getSortPrefs` at `src/js/directoryPrefs.js:24-39` validates the candidate `col`. If `col` is disabled, it checks `default_sort.col`; if enabled, it returns `{ col: default_sort.col, desc: !!default_sort.desc }`, otherwise `{ col: 'name', desc: false }`.
  - When `Core.toggleFileListColumn` disables `col`, if the active container is currently sorted by `col`, `DirectoryPrefs.reconcileActiveSort` re-sorts `state.list` using the fallback prefs and updates the sort arrow.
- **`Size` formatting and comparator:**
  - Display format in `filePanel.js`: empty string `""` for `is_dir`, `is_parent`, `is_drive`, or pending 0-byte gallery downloads. For files: under `1024` formats as `${bytes} B`, under `1048576` formats as `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`, under `1073741824` formats as `${(bytes / 1048576).toFixed(1)} MB`, and larger sizes format as `${(bytes / 1073741824).toFixed(2)} GB`.
  - Sort comparator in `src/js/services/sorting.js`: compare numeric `a.size || 0` vs `b.size || 0`, tie-breaking by `compareNames(a, b)`.
- **`Dims` formatting and comparator:**
  - Display format in `filePanel.js`: `${item.width}x${item.height}` when `item.width > 0 && item.height > 0` and not a folder, parent, or pending download; otherwise `""`.
  - Sort comparator in `src/js/services/sorting.js`:
    - Unprobed or zero-dimension entries where `!(width > 0 && height > 0)` always sort after entries with known dimensions in both ascending and descending modes so files without dimensions never bury known resolutions at the top of a sort. Among two zero-dimension entries, tie-break by `compareNames(a, b)`.
    - For two entries with known dimensions:
      1. Compare pixel area `a.width * a.height` vs `b.width * b.height`.
      2. Tie-break by `a.width` vs `b.width`.
      3. Tie-break by `a.height` vs `b.height`.
      4. Tie-break by `compareNames(a, b)`.

### Implementation Checklist
- [x] **3.1 Expand header and sentinel markup** at `src/index.html:228-248`.
  - Add `.header-cell.col-size[data-sort="size"]` for `Size` and `.header-cell.col-dims[data-sort="dims"]` for `Dims` with `.sort-icon` and `.col-resizer` to `#file-panel-header`.
  - Add `<span class="item-size">999.9 MB</span>` and `<span class="item-dims">9999x9999</span>` to `#file-list-sentinel`.
  - *Accept:* Header and sentinel contain all five columns in canonical order.
- [x] **3.2 Update CSS tokens and column visibility rules** at `src/css/global.css:62-65` and `src/css/main.css:1145-1335`.
  - Add `--col-size-w`, `--col-dims-w`, and `--file-grid-cols` to `:root` in `src/css/global.css`.
  - Switch `#file-panel-header` at `src/css/main.css:1148` and `#file-list li` at `src/css/main.css:1278` `grid-template-columns` to `var(--file-grid-cols)`.
  - Style `#file-list .item-size` and `#file-list .item-dims` matching `.item-ext` and `.item-date` typography with `tabular-nums`, ellipsis, and right-padded cell alignment.
  - Add `#file-panel.col-hide-<col>` rules that set `display: none` on `.header-cell.col-<col>` and `#file-list .item-<col>`.
  - *Accept:* Toggling `col-hide-*` classes on `#file-panel` cleanly hides or reveals columns with zero inline style mutations on rows.
- [x] **3.3 Update `sorting.js` and `directoryPrefs.js`** at `src/js/services/sorting.js:40-90` and `src/js/directoryPrefs.js:24-110`.
  - Add `'size'` and `'dims'` branches to `applySort` in `src/js/services/sorting.js`.
  - Update `getSortPrefs` in `src/js/directoryPrefs.js` to validate that the chosen column is enabled in `Core.getState().config?.frontend_data?.file_list_columns`, falling back to `default_sort` when enabled or `{ col: 'name', desc: false }`.
  - *Accept:* Sorting by `size` or `dims` orders items deterministically, and disabling an active sort column falls back immediately while keeping the current selection highlighted.
- [x] **3.4 Update `filePanel.js` row pool, widths, and resizers** at `src/js/filepanel/filePanel.js:126-142`, `src/js/filepanel/filePanel.js:429-505`, `src/js/filepanel/filePanel.js:1761-1859`, `src/js/filepanel/filePanel.js:1921-2074`, and `src/js/filepanel/filePanel.js:3100-3112`.
  - Measure all 5 columns in `recalculateMinColWidths`.
  - Update `normalizeColumnWidths` and `initializeColumns` to read enabled columns, compute widths across active columns only, and set `--file-grid-cols`.
  - Extend `createPoolRow` and `updateEntry` with `size` and `dims` slots, and append size and dims metadata in thumbnail view `.item-thumbnail-meta` when enabled.
  - Extend the `mousemove` column resizer handler at `src/js/filepanel/filePanel.js:3104-3110` to handle `col-size` and `col-dims`.
  - *Accept:* Enabling or disabling columns in any combination resizes remaining columns smoothly to fit `#file-panel`, and dragging any column resizer adjusts widths without overflow.

---

## 4. On-Demand `Dims` Probing, Caching, and Edge Cases

### Specification
- **Trigger conditions:**
  - A container dimension scan runs only when `file_list_columns.dims === true` and `state.list` has media entries lacking cached dimensions.
  - If `file_list_columns.dims === false`, zero backend dimension commands are invoked.
  - If `file_list_columns.dims` is toggled from `false` to `true`, `filePanel.js` immediately starts a scan for the currently open directory or archive.
  - If `file_list_columns.dims` is toggled to `false` or the user navigates to another container, `cancel_dims_scan` increments `DIMS_SCAN_GENERATION` to abort the running worker loop immediately.
- **Frontend bounded cache:**
  - `DIMS_CACHE_CAPACITY = 10000` in `src/js/filepanel/filePanel.js` using `BoundedMap(DIMS_CACHE_CAPACITY)`, where each entry is `{ w, h }` at ~32 bytes, under 320 KB worst-case.
  - Cache key incorporates container path, entry name or path, file size, raw modification timestamp, and `mediaRevision` so modified or replaced files invalidate automatically while revisiting a 5,000-image folder or archive resolves in `O(1)` from memory with zero IPC calls.
  - When the active viewer loads an image and reports `Core.setImageDimensions`, opportunistically populate the cache and update the active entry's `width` and `height`.
- **Backend background scanner in `src-tauri/src/commands/animation.rs` and `src-tauri/src/formats.rs`:**
  - Tauri commands: `scan_container_dimensions(app, state, container, is_archive, password)` and `cancel_dims_scan()`.
  - Uses a dedicated `DIMS_SCAN_GENERATION: AtomicU64` so dimension scans and animation scans never cancel each other.
  - Runs on a background `std::thread::spawn` worker. Iterates container entries, probes header-only dimensions, and emits batched `container-dimensions` events with `{ container, entries: Vec<{ name, width, height }>, done: bool }` every 64 items or 40 ms.
  - Batching prevents flooding the Tauri event bridge on 10,000-file folders while updating visible rows progressively.
  - When a batch or completion event arrives and the active sort column is `'dims'`, `filePanel.js` re-sorts the list while preserving the selected item.
- **Format and container edge cases in `src-tauri/src/formats.rs`:**
  1. **Standard raster formats `jpg`, `jpeg`, `png`, `apng`, `gif`, `webp`, `bmp`, and `dib`:**
     - Local files and temp-extracted archive entries: use a buffered `File` reader with `image::ImageReader::new(BufReader::new(file)).with_guessed_format()?.into_dimensions()`. Using `with_guessed_format()` handles `.dib` files and files with mismatched extensions via magic bytes without reading full payloads.
     - ZIP and CBZ archive entries: read up to 64 KB from the ZIP stream into a buffer and call `read_dimensions_from_bytes(&buf)`, falling back to a streaming JPEG marker walker or full entry bytes only when a header exceeds 64 KB.
  2. **JPEG with oversized EXIF or ICC headers over 64 KB:**
     - A lightweight JPEG marker walker over `Read` skips `APPn` and `COM` segments by their 16-bit big-endian length until reaching a `SOF` frame marker in `0xFFC0..=0xFFCF`, excluding `0xFFC4`, `0xFFC8`, and `0xFFCC`, then reads height at offset `+5` and width at offset `+7` as big-endian `u16`. This keeps header reads fast even on JPEGs with multi-megabyte embedded ICC profiles or thumbnails.
  3. **AVIF `avif`:**
     - Parse the ISOBMFF `meta` -> `iprp` -> `ipco` -> `ispe` box from the first 64 KB: the `ispe` full-box has 4 bytes of version and flags followed by `image_width: u32` and `image_height: u32` in big-endian order. If an `irot` property box specifies a 90 or 270 degree rotation where `angle & 1 == 1`, swap width and height so reported dimensions match rendered orientation.
  4. **MP4 `mp4`:**
     - Reuse existing `formats::read_mp4_dimensions` at `src-tauri/src/formats.rs:582-624`, which parses `moov` -> `trak` -> `tkhd` width and height without decoding video frames.
  5. **ICO `ico`:**
     - Parse the 6-byte ICO header and `16 * count` directory entries at `src-tauri/src/ico.rs:21-60` to deduplicate `width, height` pairs where byte `0` means `256` or read embedded PNG `IHDR` when `w == 0 || h == 0`, then compute total stitched width as sum of unique frame widths plus `10 * (unique_count - 1)` gap and height as max unique frame height, matching `icoSizesTotal` at `src/js/services/viewerMath.js:23-37` and the viewer statusbar readout.
  6. **SVG `svg`:**
     - Read up to the first 16 KB of UTF-8 text, locate the opening `<svg ...>` tag, and parse numeric `width` and `height` attributes; if either is missing or percentage-based, fall back to the 3rd and 4th numbers of `viewBox="minX minY width height"`. Round positive floats to the nearest `u32`.
  7. **0-byte pending gallery downloads, folders, `..`, archives, and corrupted files:**
     - Skip entries where `is_dir`, `is_parent`, `size == 0`, or the extension is an archive format `zip`, `cbz`, `7z`, `cb7`, `rar`, `cbr`, or `tar`.
     - When a gallery download finishes via `quivit-download-complete` at `src/js/filepanel/filePanel.js:304-309`, if `Dims` is enabled, probe the newly downloaded file and update its row and sort position.

### Implementation Checklist
- [x] **4.1 Add unified header-only dimension prober in `src-tauri/src/formats.rs`** at `src-tauri/src/formats.rs:575-626`.
  - Implement `read_media_dimensions_from_path(path: &Path, ext: &str) -> Option<(u32, u32)>` and `read_media_dimensions_from_reader<R: Read>(reader: R, ext: &str) -> Option<(u32, u32)>` covering raster `png`, `apng`, `gif`, `webp`, `bmp`, and `dib`, JPEG marker scan for `jpg` and `jpeg`, AVIF `ispe` and `irot` parser for `avif`, MP4 `tkhd` parser for `mp4`, ICO header calculator for `ico`, and SVG `<svg>` attribute and `viewBox` parser for `svg`.
  - *Accept:* Unit tests in `src-tauri/src/tests/format_tests.rs` pass for PNG, JPEG, GIF, WebP, BMP/DIB, AVIF, MP4, ICO, and SVG headers.
- [x] **4.2 Add `scan_container_dimensions` and `cancel_dims_scan` commands** at `src-tauri/src/commands/animation.rs:215-332` and register in `src-tauri/src/lib.rs:140-185`.
  - Add `DIMS_SCAN_GENERATION: AtomicU64`, `DimensionBatchEvent` payload struct with `container`, `entries: Vec<DimensionEntry>`, and `done: bool`, `scan_container_dimensions`, and `cancel_dims_scan`.
  - Support local directories, ZIP and CBZ archives, and cached or temp-extracted 7z, RAR, and TAR archives via `state.archive_cache`.
  - *Accept:* `cargo check --tests` succeeds with zero warnings; cancelling or starting a new scan aborts any prior scan within one entry iteration.
- [x] **4.3 Wire frontend dimension cache, event listener, and lazy scan trigger** at `src/js/filepanel/filePanel.js` and `src/js/fsUtils.js`.
  - Add `DIMS_CACHE_CAPACITY = 10000` `BoundedMap` in `src/js/filepanel/filePanel.js`.
  - Listen to `container-dimensions` Tauri event in `initFilePanel`. Apply incoming `width, height` batches to `dimsCache`, patch matching items in `Core.getState().list`, update visible active rows in place via `li._slots.dims.textContent`, and trigger `DirectoryPrefs.sortCurrentState` when `prefs.col === 'dims'`.
  - Trigger `scanContainerDimensions` when a container loads with `dims` enabled, when `dims` is toggled on, or when `quivit-download-complete` fires for a file while `dims` is enabled.
  - *Accept:* With `Dims` disabled, `scan_container_dimensions` is never called. With `Dims` enabled, dimensions populate progressively without UI jank, cache hits on revisit are instant, and sorting by `Dims` orders items by pixel area.

---

## 5. Verification Plan

- [x] **5.1 Frontend unit tests:** Run `npm test` for `mocha/actions.test.js`, `mocha/sorting.test.js`, and `mocha/diagnosticsContract.test.js`, updating existing tests if action count or sorting expectations are affected.
- [x] **5.2 Backend targeted tests:** Run `cargo check --tests` and `cargo test format_tests` to verify header-only dimension parsers across all media formats.
- [~] **5.3 Static and architecture validation:** Run `.agents/skills/verify-implementation/SKILL.md` and `.agents/skills/validate-changes/SKILL.md` checks once implementation is complete.
