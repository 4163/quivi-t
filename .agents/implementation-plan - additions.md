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

- Audit SVG behavior if indefinite zoom issues remain in some edge cases.

### 4. General Rendering

- Review rendering quality and artifacts.


### 6. Archive Performance

- Performance note: opening large or slow archives can make `quivit.exe` stop responding briefly; after this, Windows may show the generic executable icon on the taskbar.
- Treat this as archive-processing/UI-blocking debt.
- Prefer optimizing archive load/extraction so expensive work does not block the app window, rather than patching only the icon symptom.

### 8. UI Sound Design (Low Priority)

- Add custom SFX for UI interactions (e.g. button clicks, menu toggles, opening folders, error bumps).
- Needs a toggle in the Options menu to disable sounds for users who prefer a silent experience.
- Provide a volume slider or rely on system volume.
- Audio assets should be small and fast-loading.

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
