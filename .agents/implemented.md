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
