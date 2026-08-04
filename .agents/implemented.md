# QuiviT Implemented Work

Date started: 2026-08-01

This file tracks items that are fully implemented and verified, separate from the active implementation plan.

## Fully Implemented

### Options Window Recovery

- Fixed the Windows/Tauri Options-window deadlock by making `open_options` an async Tauri command.
- Reused a stable `options` window label instead of creating dynamic duplicate windows.
- Added the `options` window to Tauri capabilities.
- Verified Options opens from the `3` shortcut in `npm run tauri dev`.

### Options Close Permission

- Added `core:window:allow-close`.
- `Cancel` and `Apply & Close` now use the Tauri window close path.
- Verified Tauri capability validation by launching the dev app.

### Config Folder Link

- Added backend commands to resolve and open the active config directory.
- Options displays the resolved config folder and opens it through the backend.
- Config path respects normal mode versus portable mode.

### Shortcut Defaults Source

- Added `src/js/keybinds.js` as the shared source of default shortcuts and config merging.
- Added legacy migration for old defaults such as `F4`, `Alt+Enter`, and `F5`.
- Main window and Options use the shared keybind defaults.

### Shortcut Dispatch Extraction

- Added `src/js/shortcuts.js`.
- Moved keyboard combo normalization and action lookup out of `main.js`.
- Verified `3` opens Options after extraction.

### File Panel Extraction

- Added `src/js/filePanel.js`.
- Moved file list rendering, sorting UI, panel resizing, and column resizing out of `main.js`.
- Fixed fixed-width folder SVG sizing in file rows.

### Startup Ordering

- Moved `Core.init()` after DOM subscriptions and bindings so startup state/config changes are observed.

### Small-Image Panning

- Updated viewer pan clamping so images smaller than the viewport can still move within intuitive edge bounds.
- Added `VIEWER_KEYBOARD_PAN_STEP` in `src/js/keybinds.js` so W/A/S/D and arrow-key pan distance can be tuned from one place.

### Default Fit Mode

- Changed the startup fit mode to `height-if-larger`.
- Added `DEFAULT_FIT_MODE` in `src/js/keybinds.js`.
- Persisted explicit View-menu fit changes to `frontend_data.fit_mode` so a user's chosen fit mode survives reloads after the first change.

### Scaling Mode Persistence

- Added `DEFAULT_SCALING_MODE` in `src/js/keybinds.js` with `bicubic` as the default.
- Persisted explicit View-menu scaling changes to `frontend_data.scaling_mode`.
- Routed scaling state through `core.js` so `main.js` only mirrors state into the viewer and menu UI.

### Folder/Archive Traversal Shortcuts

- Added `Ctrl+X` for opening the next sibling folder/archive from the current directory or archive.
- Added `Ctrl+Z` for opening the previous sibling folder/archive from the current directory or archive.
- Added a backend sibling-container resolver so traversal is anchored to the current container instead of the selected image inside the visible list.

### Archive Parent And Continue-Last

- Added a `..` entry inside archive file lists.
- Backspace/`..` from an archive now returns to the containing directory and highlights the archive.
- Continue-last persistence is gated by the Options `continue_last` setting and now supports archive paths.
- Disabling continue-last removes stale last-opened path fields from saved config.

### File-Type Semantics

- Parent entries, folders, and archives no longer render as images when selected.
- Double-clicking folders, archives, and `..` activates navigation through the same core path as keyboard/container navigation.
- Archive entries are treated as directory-like containers for open/navigation flows.
- Added a direct File-menu picker for opening image/archive files, since the native directory picker only selects directories.

### File Panel Breadcrumb

- Added a display-only breadcrumb strip above the file-list header.
- Shows the current directory path in folder mode and the current archive path in archive mode.
- Wraps long paths so deeply nested locations remain visible.

### Options Layout And Wording

- Moved "Continue from last opened directory" below the default directory input.
- Renamed the portable-config checkbox to "Save config data locally".
- Added explanatory text that default settings live under `%APPDATA%` and portable settings live beside the app executable.
- Kept the config-directory hint clickable.
- Confirmed Cancel and Apply & Close use the Tauri close path.

### Menu And Shortcut Polish

- Updated default shortcuts to `1` menu bar, `2` file list, `3` full screen, `4` Options, and `5` Refresh.
- Added View-menu commands and keybind defaults for clockwise rotation (`H`), horizontal flip (`V`), and vertical flip (`B`).
- Added a File-menu command for opening an image/archive directly through a file picker.
- Added a GitHub link with a compact GitHub icon in the menu bar.
- Added the English-only Language tab with a visible flag marker.

### Config Privacy Guardrails

- Updated root `.gitignore` to keep executable-adjacent `.portable` and `quivit_config.json` out of Git.
- Added tracked exceptions for the active `.agents` planning/implemented docs while keeping other local agent files ignored.

### README Refresh

- Restored the fuller QuiviT description.
- Moved Quivi credits near the top.
- Added stack, project structure, architecture, config, shortcut, and backend-command documentation.
- Updated shortcut docs to match current `src/js/keybinds.js`.
- Added direct file/archive opening, breadcrumb, flips, full frontend syntax-check list, and backend helper command notes.

### Session Recovery Notes

- Added a newest-first Codex continuation entry to `.agents/sessions.md`.
- Replaced the superseded `.agents/implementation-plan.md` with `.agents/implementation-plan - additions.md` as the single active implementation plan.

### Fit Mode Refactor

- Renamed and remapped fit-mode shortcuts: `Q` fit width, `E` fit height, `R` fit width if larger, `T` fit height if larger.
- Added new **Auto fit** mode (`F`) mapped to `cmd-fit-best` → viewer `window` fit mode, which scales up or down to fill the viewport (unlike the `if-larger` variants).
- Auto fit selects `Math.min(scaleX, scaleY)` so the image always fits entirely on screen without scrolling. On 1:1 aspect ratio images the result equals fit width.
- Added `cmd-fit-best` menu item and click listener in `main.js` and `index.html`.
- Added Auto fit entry to the Options Keys tab `ACTIONS` list.

### Keybind System Cleanup

- Added `cmd-open-dir` (`Ctrl+O`) and `cmd-open-file` (`Ctrl+Shift+O`) to `DEFAULT_KEYBINDS` so both are fully configurable.
- Removed hardcoded `Ctrl+o`, `1–5` fallback checks from `shortcuts.js`; all shortcuts now live exclusively in `DEFAULT_KEYBINDS`.
- Removed `LEGACY_DEFAULT_KEYBINDS` migration block; simplified `mergeConfig` — saved user config is now merged directly over defaults.

### Options: Reset to Defaults Button

- Added a **Reset to Defaults** button in the Options Keys tab header.
- Clicking it replaces `config.frontend_data.keybinds` with a fresh copy of `DEFAULT_KEYBINDS` and re-renders the keybind list in-place.
- Styled via `.keybinds-header` and `#btn-reset-keybinds` in `options.css` — no inline styles.

### Twemoji Flag (Language Tab)

- Downloaded the official Twemoji US flag SVG (`1f1fa-1f1f8.svg`) and placed it at `src/assets/twemoji-us.svg`.
- Replaced the native `🇺🇸` OS emoji in `options.html` with a Twemoji `<img class="flag-icon">` for consistent cross-platform rendering.
- Added developer comment pointing to `https://github.com/jdecked/twemoji` for future localization work.
- Styled via `.flag-icon` and `.language-name` in `options.css`.
- Added Twemoji to the README attribution list.

### Resize & Zoom Snapping Polish

- Refactored viewer resize handling to accurately respect the current `fitMode` (auto-fit, fit-width, fit-height, etc.) on window resize, preventing sudden intuitive snap-backs.
- Disabled reverting `fitMode` to `none` during standard zooming operations. The user can now zoom in/out freely without losing their underlying fit preference, and the app recalculates appropriately during the next resize event.

### UI Defaults & Tooltips

- Set the `menubar` and `statusbar` to be visible by default for new users.
- Set the `file-panel` to be hidden by default.
- Added `title` attributes (tooltips) to all items in the file list (except `..`) so users can hover to read long, truncated filenames.
- Added `title` attributes to the View menu scaling options indicating their cycle shortcut `]`.

### Categorized Keybinds UI

- Replaced the flat keybind list in Options with categorized sections: Navigation, View, Zoom, Pan, Rotation, Window & UI, Files & Folders.
- Replaced basic text inputs with click-to-bind interactive tags and a persistent `+` button for alternative bindings.
- Added a circular `×` remove button inside tags that appears on hover and turns red to easily delete bindings.

### Options Tab Session Persistence

- Implemented `localStorage` memory for the active Options tab, persisting tab selection across Options window opens within the same app session.
- Added a `localStorage.removeItem` cleanup hook in `main.js` so the Options window naturally defaults to the General tab on a fresh program restart.

### Advanced Shortcut System: Multi-Key & Mouse Support

- Rewrote `options.js` and `shortcuts.js` capture logic to accumulate simultaneous keys in a `Set`.
- Combinations are now formed dynamically by recording the maximum key-press state and finalizing only on `keyup` when all keys are released (enabling arbitrary combos like `A + B`).
- Added native Mouse binding support (`MouseLeft`, `MouseMiddle`, `MouseRight`, `MouseBack`, `MouseForward`).
- Updated defaults to include `MouseForward` and `MouseBack` for Next/Previous item navigation.

### Options Conflict Highlighting

- Implemented dynamic, auto-generated color highlighting in the Options menu for keybind conflicts.
- `getConflictColors()` generates distinct, golden-ratio based hues evenly spread across the non-blue spectrum (skipping 190°-240°), assigning the exact same color to all tags sharing a conflicted combination.

### Keybind Failsafe & Deep Copy Fix

- Blocked removal of the final uncontested binding for the Menu Bar Toggle to prevent UI softlocks. (If the last binding is shared with another action, removal is permitted).
- Fixed a bug where saving or resetting keybinds unintentionally mutated the underlying `DEFAULT_KEYBINDS` by explicitly wrapping assignments in a deep copy (`JSON.parse(JSON.stringify())`).

### Managed-Config Favorites

- Moved favorites out of WebView2 `localStorage` into managed config (`frontend_data.favorites` and `frontend_data.favorites_collapsed`) so they persist through the normal config/portable machinery. (The one-time legacy `localStorage` migration was later removed since the app has not shipped — see "Favorites LocalStorage Migration Removal".)
- Collapsed/expanded favorites state is persisted and restored; empty lists auto-collapse and persist that state.
- Favorite items now support single-click highlight and double-click open for folders/archives, with the current folder/archive taking priority over the selected entry so a favorited location stays highlighted.

### Split Config Storage

- Roaming config is now split into separate files: `quivit_config.json` (preferences), `quivit_state.json` (last-opened/remembered-image state), `quivit_directory_sort.json` (per-directory sort), and `quivit_favorites.json` (favorites).
- Portable mode still writes a single self-contained `quivit_config.json` beside the executable; disabling portable mode removes portable leftovers.
- Legacy single-file config layouts load unchanged and are re-split on next save.

### Last-Active-Image Rewrite

- Replaced the per-folder `last_active_images` map with a single `last_active_image = { container, path }` pair.
- Restoration now runs only at program startup (via `restoreLastImage` from `Core.init()`), never during ordinary navigation, and always wins over the first-image/position logic when the container matches.
- The legacy `last_active_images` map key is dropped on config load.

### Open-First-Image Option

- Added the `open_first_image` config option (default OFF) with an Options checkbox "Open first image automatically".
- When ON, entering a directory or archive highlights the first image; when OFF, the target entry is highlighted instead.

### Sort-Aware Sibling Navigation

- Rewrote `openSibling` (`Ctrl+X`/`Ctrl+Z` next/previous directory or archive) to compute siblings client-side instead of via the Rust `open_sibling_container` command.
- Sibling order now follows the parent directory's current sort prefs (column + direction) through the same `DirectoryPrefs.applySort` used for the visible listing, so traversal matches the file panel order.
- Drive-root stepping (wrapping between physical drives) is retained, and `formatEntry` is applied so date sorting works.

### Archive Parent Navigation Fixes

- `..`/Backspace from a deleted or moved archive now falls back to the containing folder (via the new `parentOf` helper), then to the drives list if unreachable.
- `..` from an archive that is not listed (e.g. hidden with "show hidden" off) falls back to the first image, else the first item.

### Static Config-Folder Pointers

- Options now shows static "Global config folder (Roaming)" (`%APPDATA%\com.x4163.quivit`) and "Local config folder (portable)" (executable directory) pointers; they no longer track the "Save config data locally" state.
- Added backend commands `get_local_data_dir` / `open_local_data_dir` alongside the existing global folder commands.

### Toggle Favorite Keybind

- Added the `cmd-toggle-favorite` action (unbound by default) under the File Operations category in the Options keybind UI.
- `toggleFavoriteCurrent()` toggles the current folder/archive/image favorite and expands the favorites section when adding; wired through `dispatchAction` in `main.js`.

### Keybind Canonicalization

- Added `formatKeyName()` / `normalizeCombo()` in `shortcuts.js` with a `SPECIAL_KEY_MAP` so named keys are captured and stored with canonical casing (`Backspace`, `ArrowLeft`, `Delete`, `F5`, ...) instead of lowercase forms.
- `mergeConfig` normalizes all default and user keybinds on load, so previously stored lowercase combos display and persist consistently.

### Scroll-Wheel Pan vs Zoom (Manga Reading)

- Wheel input now routes through the keybind table instead of the viewer's hardcoded zoom handler, so scroll actions are fully remappable in Options → Keys.
- Defaults: `ScrollUp` / `ScrollDown` = Pan Up / Down (`cmd-pan-up` / `cmd-pan-down`) and `Ctrl+ScrollUp` / `Ctrl+ScrollDown` = Zoom In / Out (`cmd-zoom-in` / `cmd-zoom-out`).
- Wheel zoom zooms toward the cursor position (`Viewer.zoomAt` is now exported; `dispatchAction` accepts a wheel payload with `clientX`/`clientY`).
- Wheel pan uses a dedicated `VIEWER_WHEEL_PAN_STEP` (120px per notch), independent of the keyboard `VIEWER_KEYBOARD_PAN_STEP` (72px).
- Wheel events over the file panel, menu bar, dropdowns, or status bar are never hijacked so those UIs keep native scrolling (`isWheelOverUI`).
- Added a **Scroll Wheel** section to the Options Keys tab with a Hold Ctrl / Toggle Ctrl (sticky) modifier switch, persisted as `frontend_data.scroll_zoom_modifier` (`'hold'` default / `'toggle'`).
- In toggle mode, a standalone `Ctrl` tap latches zoom mode (synthesizing the `Ctrl` modifier in wheel combos) until `Ctrl` is tapped again; a `Ctrl+Scroll Zoom` badge appears in the status bar while latched. Ordinary `Ctrl` shortcuts (e.g. `Ctrl+X`) do not trip the latch.
- The keybind capture UI in `keybindUi.js` now supports binding wheel combos (`ScrollUp`, `Ctrl+ScrollDown`, ...) by scrolling while holding the desired modifiers.
- Added `ScrollUp` / `ScrollDown` to `SPECIAL_KEY_MAP` so wheel combos persist with canonical casing.

### Status Bar Class-Only Selectors & Non-Image Placeholders

- Deduplicated the status bar spans in `index.html`: each span now carries only its class (`.status-filename`, `.status-dims`, `.status-zoom`, ...), removing the redundant matching `id="status-*"` attributes.
- Updated `main.js` and `viewer.js` to query those spans via `document.querySelector('.status-*')` instead of `getElementById`.
- Non-image entries (folders, archives, `..`, drives) now render `N/A` in the dims and zoom status fields instead of stale metrics from a previously displayed image.

### Favorites Keyboard Navigation & Archive-Entry Favorites

- Added full keyboard navigation to the Favorites list: ArrowUp/Down, Home, End, Enter, Space, Escape with a tracked highlight (`highlightedFavoritePath`) mirroring the file-list selection model; single-click highlights, double-click opens directories/archives.
- Exported `getHighlightedFavorite()` and `navigateHighlightedFavorite(delta)` in `filePanel.js` for external consumers (main.js action buttons).
- Favorites for images inside archives now store composite "archive|entry" paths; added `loadArchive()` in `fsUtils.js` to handle these and restored `remember_last_image` / `open_first_image` logic there.
- Updated "Open in Explorer" and "Open Folder" action buttons in `main.js` to resolve real archive paths and container paths for both favorites and main-list archive entries.
- Added `.hidden` utility class in CSS; favorites header uses `classList.toggle('hidden', favs.length === 0)` instead of inline `style.display`.
- Favorites composite widget: focus ring on container (`#favorites-list:focus-visible`), remove-button focus visibility, ArrowUp/Down/Home/End/Enter/Space/Escape keydown handler on `#favorites-list`.

### Space/Arrow Key Hijacking Fix

- Fixed Space/Arrow key hijacking in `shortcuts.js` so they no longer prevent default when a button/input/textarea/select has focus (allows native button activation via Space).

### Persistent Scroll-Zoom Toggle Latch

- The scroll-wheel toggle latch (`ctrlLatched`, Options → Keys → Scroll Wheel → Toggle Ctrl) now persists across restarts as `frontend_data.scroll_zoom_latched`.
- Split into `quivit_state.json` in roaming mode via the new `STATE_KEYS` entry in `lib.rs`; portable mode keeps it inline in the single self-contained config file.
- `shortcuts.js` persists the latch whenever a clean Ctrl tap toggles it, and exports `syncScrollLatch(config)` which restores it after config load; `main.js` calls it on `quivit-config-loaded` (startup and Options Apply & Close).
- `syncScrollLatch` only applies the latch when the modifier is `'toggle'` — in `'hold'` mode a stale latch never shows the badge or latches zoom.

### Favorites LocalStorage Migration Removal

- Removed `migrateFavorites()` and the one-time `quivit-favorites` / `quivit-favorites-collapsed` WebView2-localStorage import from `filePanel.js`; the app has not shipped, so no legacy users exist and the migration was dead code.
- The `quivit-config-loaded` handler in `filePanel.js` now only marks config loaded and re-renders favorites.

### Persistence Policy Documentation

- Added a canonical persistence-policy comment block to the `core.js` header: which data belongs in `quivit_config.json` (preferences) vs `quivit_state.json` (last-known runtime state, `STATE_KEYS` in `lib.rs`) vs WebView2 `localStorage` (pre-paint caches and session-only state only — never a source of truth).
- Added `// persistence:` pointer comments in `keybinds.js` (`mergeConfig`), `shortcuts.js` (latch), and `filePanel.js` (favorites).

## Verified Commands Used

```powershell
node --check src\js\main.js
node --check src\js\filePanel.js
node --check src\js\shortcuts.js
node --check src\js\options.js
node --check src\js\viewer.js
node --check src\js\keybinds.js
cd src-tauri
cargo check
```

## Runtime Smoke Tests Completed

- Launched `npm run tauri dev`.
- Pressed `3`; Options opened.
- Confirmed Tauri capability validation passed after Options close permission was added.

## Not Yet Fully Implemented

See `.agents/implementation-plan - additions.md` for the active backlog and sequencing.

### UI Module Decoupling
- Decoupled \menubar.js\ logic and DOM bindings.
- Decoupled \keybindUi.js\ from the options window, isolating configuration rendering and conflict tracking.
- Decoupled \keyboardNav.js\ to manage accessible tab navigation across menus and options uniformly.

### Options Tab Accessibility (Tab Navigation)
- Implemented accessible keyboard navigation flows (\Tab\/\Shift+Tab\) across all Options tabs.
- Added global \Home\ and \End\ shortcut jumps for immediately focusing the first and last tabbable elements within active scopes.
- Fixed \Enter\/\Space\ activation for dropdowns in the main menubar.

### Customization Tab & Custom CSS
- Added Theme selection (System / Light / Dark) that applies instantly and auto-saves to config to prevent state drift on window close.
- Added a Custom CSS textarea to inject raw styles into both windows dynamically.
- Implemented \Ctrl+S\ auto-save-and-apply shortcut while editing the CSS text area.
- Implemented a robust \Ctrl+Shift+Alt+C\ global emergency CSS reset that clears broken styles, broadcasts immediately across main and options windows, and persists to backend storage.

### File Panel Actions
- Added 'Reveal in File Explorer' and 'Open Folder in Explorer' actions.
- Bound these to clickable UI elements in the file panel header.
- Safely integrated Rust-backend explorer triggers across Windows platforms.

### Core Architecture Decoupling
- Extracted filesystem interaction logic from `core.js` into `fsUtils.js`.
- Extracted file list grouping and sorting logic into `directoryPrefs.js`.
- Refactored `main.js` shortcut dispatching to directly route commands via a switch statement, bypassing DOM programmatic click bugs.
- Fixed shortcut case-insensitivity matching and preserved multi-key combo accuracy.

### File-Type Semantics
- Ensure `..`, folders, and archives are not treated as image files.
- Ensure selecting these entries does not attempt to display them in the viewer.
- Archives are treated like folders in the file list (Enter/Space opens them, double-click opens them, archive scope includes `..` navigation).

### Persistent Directory Sorting
- Implemented per-directory sorting and grouping that separates drives, folders, and files before applying the sort.
- Persisted sorting order globally or in portable config depending on portable mode.
- Sorting gracefully falls back to default settings per-directory, allowing independent sort states.

### Drive Jumping
- Modified `open_sibling_container` to detect when the user is at the root of a drive (e.g., `C:\`) and jump to the next/previous physical drive (e.g., `D:\`) upon container traversal (`Ctrl+X` / `Ctrl+Z`).
- Added sibling container jump shortcuts to the File dropdown menu.

### SVG Viewer Fixes
- Added `MAX_SCALE` and fixed intrinsic dimension fallback in `viewer.js` to prevent indefinite zoom on certain SVG files without defined widths.

### Transparent Background
- Added `opaque-bg` class and toggle logic for transparent background visualization against dark/light backdrops.
- Added `cmd-toggle-transparent` keybind and wired it to the Options and View menu.

### File Panel Favorites & Icons
- Added inline SVG icons for Image, Folder, and Archive files in the file list.
- Implemented Favorites UI header section in `filePanel.js` and `index.html`.
- Implemented star/favorite logic and persistence using `localStorage`.

### Single Instance Option
- Added `tauri-plugin-single-instance`.
- Wired file arguments to `FsUtils.loadFile()` upon secondary launch.
- Enabled focus transfer to the primary window.
- Added "Allow only one QuiviT instance" toggle in the Options menu.

### ICO Spritesheets
- Added `image` crate with `ico` feature.
- Implemented `get_ico_frames` Rust command to parse ICO files, arrange frames horizontally, and serve them securely as a base64 PNG data-url.
- Updated frontend to await `get_ico_frames` dynamically for `.ico` files.

### Options & State Persistence
- Added "Remember last active image" Options checkbox.
- Implemented logic in `fsUtils.js` and `core.js` to remember and automatically jump to the last active image when entering a directory.

### Archive Performance Overhaul

- **Instant archive listing**: Added \list_archive\ Tauri command that reads only archive headers (central directory) for ZIP/CBZ/RAR/CBR, returning file lists instantly without extracting images.
- **Hybrid caching strategy**:
  - ZIP/CBZ: On-demand in-memory LRU cache (20 images) with \prefetch_archive_entries\ command for background prefetching (7 ahead / 3 behind).
  - RAR/CBR: Background sequential extraction to OS temp directory (\%TEMP%\\QuiviT\\<hash>\\) via spawned thread; \quivit://\ protocol polls temp disk with 3-second timeout.
- **Unified protocol handler**: \quivit://archive/<base64_path>/<entry>\ now routes seamlessly — serves from LRU cache (ZIP) or temp disk (RAR), with on-demand extraction fallback for ZIP cache misses.
- **Seamless image swapping**: \iewer.js\ uses off-screen \Image\ preloader — retains previous image on screen until new image fully loads, eliminating flicker/black frames during navigation.
- **Prefetch integration**: \core.js\ triggers \prefetchAhead\ on navigation; \sUtils.js\ triggers initial prefetch on archive load.
- **Dependencies**: Added \md5\ crate for deterministic temp directory naming.
- **Cleanup**: Old RAR temp directories cleaned up on new archive load; ZIP LRU evicts oldest entries at capacity.
