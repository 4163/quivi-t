# QuiviT Implementation Plan

Date: 2026-08-01

This plan covers the current requested changes. No application code should be changed until this plan is reviewed.

## Goals

- Improve shell/window polish during resize.
- Correct viewer behavior for folders, archives, ICO files, and keyboard activation.
- Make file-list navigation and sorting persistent and intuitive.
- Improve Options layout, shortcut organization, shortcut capabilities, and wording.
- Add planned single-instance behavior for file-open workflows.
- Keep the frontend coherently decoupled: domain behavior should live in focused modules, while `main.js` remains main-window wiring.
- Update documentation and session recovery notes after implementation and verification.

## Non-Goals For This Pass

- Full localization implementation beyond adding a Language tab placeholder with English only.
- Rewriting the entire viewer or file-list architecture if a focused extraction is enough.
- Committing or pushing changes from this agent. The user will run the push pipeline.

## Safety Notes

- Do not disturb the user's Git workflow.
- Do not commit private paths into the public repository.
- Do not track generated runtime config, portable config, build output, or personal directory-sort metadata.
- Keep `.gitignore` / `src-tauri/.gitignore` coverage current for:
  - `src-tauri/target/`
  - executable-adjacent `.portable`
  - executable-adjacent `quivit_config.json`
  - any future per-directory sort/settings data if stored outside `quivit_config.json`
- If portable mode writes personal paths next to the executable during development, confirm those files are ignored before any push.

## Architecture Plan

Keep or improve the current split:

- `core.js`: app state, config, directory/archive loading, navigation semantics.
- `viewer.js`: image rendering, fit/zoom/pan/rotation, ICO spritesheet display if implemented in viewer scope.
- `filePanel.js`: file list rendering, sorting UI, resizing UI, keyboard activation hooks if local to the list.
- `shortcuts.js`: keyboard and mouse shortcut normalization, matching, and dispatch.
- `keybinds.js`: default keybind definitions and config merge/migration.
- `options.js`: Options window DOM wiring and save/load interaction.
- `main.js`: main-window wiring only.

New modules may be warranted:

- `ico.js` or `icoSpritesheet.js`: parse ICO container data and produce an ordered spritesheet source.
- `directoryPrefs.js` or config helpers in `core.js`: normalize persistent per-directory sort settings.
- `language.js`: only if the Language tab needs structure beyond static English placeholder UI.
- `fileIcons.js` or icon-mapping helpers: map image/archive/file-type entries to icon assets under `icons/` for entries without a natural preview, and define a fallback representation for types with no dedicated icon.
- `drives.js` or drive-list helpers: enumerate available drives so root-level navigation does not dead-end, including drive icon handling distinct from folder icons.
- `favorites.js` or favorites persistence helpers: store/load favorited files and folders for a shortcut list in the file panel (navigation shortcut only, not a parallel file-list source of truth).

## Work Plan

### 1. Shell Resize Background

- Investigate whether the black flash comes from Tauri/WebView2 window background, document background, or first paint.
- Set shell/webview/background color to match system theme as closely as possible.
- Candidate areas:
  - `tauri.conf.json` window/background settings if supported.
  - CSS `html`, `body`, `#viewport`, and initial root background.
  - Tauri window builder options if required.
- Verify by resizing the app in light and dark system themes if practical.

### 2. Scaling Modes: Bicubic vs Lanczos

- Audit current implementation of `Viewer.setScaling()`.
- Confirm whether `bicubic` and `lanczos` differ visually or are currently both `image-rendering: auto`.
- If no real difference exists:
  - Either document that only `none` versus smoothed scaling is currently meaningful, or
  - Implement real mode-specific rendering if feasible.
- Avoid pretending Lanczos exists if the browser/WebView cannot actually expose it directly.

### 3. Viewer Rendering

- Transparent image background:
  - Transparent images currently make it impossible to visually gauge the canvas/image element's actual width/height.
  - Add an opaque backdrop behind the image element, colored black/white (or theme-appropriate) depending on the active theme, so transparency is visible against a bounded reference area rather than the app background.
  - Add it as a toggle in the View menu of the menu bar, defaulting to on, and keep the choice persistent like other settings.
- SVG indefinite-zoom bug:
  - Some SVG files (not all — condition not yet identified, e.g. `quivi-t_moe_original.svg`) can be zoomed in indefinitely.
  - Panning does not scale with this unbounded zoom, so at high zoom levels the edges of the SVG become unreachable.
  - Investigate why only certain SVGs trigger this (likely related to intrinsic viewBox/dimension parsing) and clamp zoom and/or correct pan bounds so the full image remains reachable at any zoom level.

### 4. ICO Handling

- Treat `.ico` as a special multi-image container when valid ICO data exists.
- Parse ICO directory entries.
- Extract embedded images.
- Order frames from largest to smallest horizontally.
- Display as a spritesheet in the viewer.
- If an ICO has only one valid entry, display it normally through the same path.
- Decide whether this belongs in:
  - Rust backend extraction command, preferred if binary parsing and image bytes are cleaner there.
  - Frontend parser, only if simple and reliable.
- Make sure invalid or unsupported ICO data fails gracefully.

### 5. File-Type Semantics

- Ensure `..`, folders, and archives are not treated as image files.
- Ensure selecting these entries does not attempt to display them in the viewer.
- Archives should be treated like folders in the file list:
  - folder-like icon/entry behavior,
  - Enter/Space opens them,
  - double-click opens them,
  - archive scope includes `..` navigation.
- Add or refine predicates:
  - `isImageEntry`
  - `isDirectoryLikeEntry`
  - `isArchiveEntry`
  - `isParentEntry`
- File-list icons:
  - Add icons to image and archive entries in the file list.
  - For file types that already have an icon under `icons/`, use those.
  - For types without a dedicated icon, decide on a practical fallback representation (open for discussion).

### 6. Keyboard Activation In File List

- Pressing `Enter` or `Space` on `..`, folders, and archives should open/navigate into them.
- Pressing `Enter` or `Space` on image files can select/open the image consistently with click behavior.
- Ensure list items can receive focus or the active selection handles the key even when the file list itself is not focused.
- Preserve global Space binding behavior if it is later assigned as a shortcut.

### 7. Archive Performance

- Performance note: opening large or slow archives can make `quivit.exe` stop responding briefly; after this, Windows may show the generic executable icon on the taskbar.
- Treat this as archive-processing/UI-blocking debt.
- Prefer optimizing archive load/extraction so expensive work does not block the app window, rather than patching only the icon symptom.

### 8. Parent Navigation Selection

- When navigating back through folders via `..`, the highlighted entry should be the directory/archive just exited.
- When entering a regular directory, the first image in the directory should be selected according to the active sorting order.
- Folders and archives should remain visible, but not steal initial image selection unless explicitly selected by the user.
- Verify with:
  - entering a folder,
  - pressing Backspace,
  - opening `..`,
  - entering an archive,
  - leaving an archive.

### 9. Persistent Directory Sorting

- Persist sorting order globally or in portable config depending on portable mode.
- Store personal paths only in runtime config, never committed repo files.
- Proposed config structure:

```json
{
  "frontend_data": {
    "default_sort": { "col": "name", "desc": false },
    "directory_sort": {
      "<normalized absolute path>": { "col": "name", "desc": false }
    }
  }
}
```

- Use the existing config path behavior:
  - normal mode: user app config directory,
  - portable mode: executable-adjacent config.
- Confirm `quivit_config.json` remains ignored when executable-adjacent.
- Consider limiting stored directory-sort entries to avoid unbounded config growth.
- Sorting behavior:
  - default order remains File ascending unless saved otherwise,
  - per-directory setting overrides default,
  - archive path can be treated as a directory key.

### 10. Options Layout and Wording

- Add a Theme selection under the General tab (default to system theme; keep the choice persistent like other settings).
- Bug: Cancel / Apply & Close buttons are not currently bottom-aligned in the Options window. If their container is a flex container, self-align them (e.g. `align-self: flex-end` or an equivalent end-aligned layout) so they sit at the bottom as intended.
- When "show hidden folders" is toggled on, automatically refresh the current file list immediately rather than requiring a manual refresh.

### 12. Single Instance Option

- Add an Options setting:
  - "Allow only one QuiviT instance"
- This can be implemented later, but the intended behavior should be documented now.
- When enabled:
  - launching QuiviT normally from the executable should still be allowed to open another app instance for now, especially during unreleased/dev builds;
  - opening an image/archive file directly through file association or command-line file path should route that file to the first already-open QuiviT instance instead of creating a second viewer instance;
  - the first instance should load/focus the directly opened file/archive;
  - the second process should hand off the file path and exit cleanly after the handoff succeeds.
- When disabled:
  - every launch/file-open can create an independent QuiviT instance.
- Implementation notes:
  - use a Tauri single-instance plugin or equivalent OS-level lock when ready;
  - distinguish "plain executable launch" from "launch with file/archive path argument";
  - make file handoff use the same `Core.loadFile()` path as normal open/drop flows;
  - ensure activation/focus works after handoff;
  - verify this with built executable behavior once release builds/file associations exist.



### 17. File List Function Buttons and Favorites

- Add function buttons under the breadcrumb in the file panel, e.g.:
  - open the current folder directly,
  - reveal the selected file in the system file explorer,
  - other similar actions as identified.
- Each button should have an `title=""` attribute describing what it does on hover.
- Add a Favorites button/feature:
  - favoriting a file or folder adds it to a new file-panel-header section shown under the function buttons.
  - This favorites section is a shortcut list only — it does not function as an independent file-navigation source. Selecting a favorited item jumps the main file-panel/file structure to that item rather than browsing within the favorites list itself.

### 18. Drive Navigation At Filesystem Root

- Currently, reaching the root of a filesystem directory leaves the user stuck since there's no way to change drives from the file list.
- Add drive entries so navigation doesn't dead-end at a drive root.
- Give drives their own icon treatment, distinct from folder icons.

## Verification Plan

Run after each coherent implementation slice:

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

Runtime/manual verification:

- Resize the app window and check shell/background flash.
- Open Options with `4`; confirm close/cancel/apply paths.
- Confirm config folder link opens the resolved config directory.
- Confirm Refresh is `5`.
- Confirm `1` toggles the menu bar.
- Confirm `2` toggles the file list.
- Confirm fullscreen command works from key and menu.
- Confirm keyboard pan distance is larger and can be adjusted from the chosen config/constants file.
- Confirm folders, archives, and `..` do not attempt to render as images.
- Confirm Enter/Space opens folders, archives, and `..`.
- Confirm archive file lists include `..`.
- Confirm back navigation highlights the folder/archive just exited.
- Confirm first image selection follows sorting order when entering a directory.
- Confirm per-directory sort persists after app restart.
- Confirm mouse shortcut capture works in Options.
- Confirm ICO spritesheet rendering with multi-entry ICO files.

## User Verification Gates

Implement slowly in reviewable slices:

1. Shell/background and Options wording/layout.
2. Remaining file-type semantics and Enter/Space activation.
3. Archive performance work.
4. Sorting persistence and privacy/ignore verification.
5. Single-instance option UI/documentation placeholder.
6. Remaining shortcut work, mouse bindings, and menu-toggle softlock prevention.
7. ICO spritesheet support.
8. Keybind categorization.
9. Final architecture review and README/session updates.

After each slice:

- Summarize changed files.
- State what was verified.
- Ask for user verification before moving to the next larger behavioral slice when needed.

## Finalization Plan

After all implementation slices:

1. Manually review that the project remains coherently decoupled.
2. Move features into their own JS files where warranted.
3. Update `README.md` with new shortcuts, config behavior, ICO behavior, archive behavior, and module structure.
   - Optionally include the project logo (`quivi-t_moe-1.svg`) as a small, tasteful addition — it should not dominate or distract from the main README content.
4. Verify every config-backed feature meets both global and portable-mode requirements:
   - normal mode writes user settings to the app config directory only;
   - portable mode writes user settings beside the executable only;
   - switching modes does not leak private paths into tracked repository files;
   - defaults, keybinds, fit/scaling mode, hidden-folder visibility, start/continue directory, and directory-sort data persist in the correct location.
5. Add a new entry to `.agents/sessions.md`.
6. Repeat static and runtime verifications as needed.
7. Leave the repository ready for the user to run the push pipeline.
