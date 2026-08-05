# QuiviT Implementation Plan

Date: 2026-08-01

This plan covers the current requested changes. No application code should be changed until this plan is reviewed.

## Non-Goals For This Pass

- Full localization implementation beyond adding a Language tab placeholder with English only.
- Full implementation user feedback sound effects.
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

### Shell Resize Background

- Investigate whether the black flash comes from Tauri/WebView2 window background, document background, or first paint.
- Set shell/webview/background color to match system theme as closely as possible.
- Candidate areas:
  - `tauri.conf.json` window/background settings if supported.
  - CSS `html`, `body`, `#viewport`, and initial root background.
  - Tauri window builder options if required.
- Verify by resizing the app in light and dark system themes if practical.

### Scaling Modes: Bicubic vs Lanczos

- Audit current implementation of `Viewer.setScaling()`.
- Confirm whether `bicubic` and `lanczos` differ visually or are currently both `image-rendering: auto`.
- If no real difference exists:
  - Either document that only `none` versus smoothed scaling is currently meaningful, or
  - Implement real mode-specific rendering if feasible.
- Avoid pretending Lanczos exists if the browser/WebView cannot actually expose it directly.

### Viewer Rendering

- Audit SVG elements behavior of hitbox/dimensions going over the canvas edge.
- The calculations for SVG images that have a WxH of 100% compared to a set WxH, acts different / breaks the border/edge calculations on the canvas and/or image. Key examples: test-files/gfl-spinner.svg works as expected, while icons/quivi-t_moe-2.svg does not.
- Visual insight on SVGs that have a WxH of 100%; the bounds/edge of the image seems to visually be the center of the image. instead of the very edges.
  "very edges" = 0x, 0y, widthX, heightY (left, top, right, bottom) of the displayed image element.
  "center of the image" = (widthX / 2)x, (heightY / 2)y, (widthX / 2)x, (heightY / 2)y (left, top, right, bottom) of the displayed image element.

### General Rendering

- Review rendering quality and artifacts.


### Archive Performance

- Performance note: opening large or slow archives can make `quivit.exe` stop responding briefly; after this, Windows may show the generic executable icon on the taskbar.
- Treat this as archive-processing/UI-blocking debt.
- Prefer optimizing archive load/extraction so expensive work does not block the app window, rather than patching only the icon symptom.

### Drag-and-Drop Folder Opening

- Rework the drag-and-drop overlay: folder opening already works, so update the wording, refine the drop cursor affordance, and make the overlay itself clickable so it opens a folder picker (broad .drop-overlay query, no need to mess around with css pointers, pointers are already set as intended).
- Prevent panning on the canvas element behind the overlay — at the momment .drop-overlay is just on top and panning interaction still leaks.
- Verify: dropping a folder/image/archive opens it; clicking the overlay opens a folder picker; no canvas drag interaction leaks through. drop. dropping an unsupported file should show a file type not supported warning instead of opening the directory.

### Responsive Keyboard Panning

- W/A/S/D and arrow-key panning is less responsive than the original Python Quivi viewer, which pans instantly and handles rapid multi-directional spam; the current build has a perceived delay/debounce before panning.
- Audit the keyboard pan pipeline (viewer pan handling and dispatch timing) for debounce or re-trigger delay.
- Make panning apply immediately per key press and support fast direction changes.
- Verify: hold and rapidly alternate directions; panning responds instantly per press.

### Scroll-Wheel Zoom vs Pan (Manga Reading) ✅ DONE

- Add scroll-wheel behavior suited to manga reading: plain wheel scrolls/pans the image up and down, while `Ctrl` + wheel zooms in/out.
- Add scroll-wheel actions to the Options Keys tab keybinds, with defaults of `Ctrl+ScrollUp` = zoom in, `Ctrl+ScrollDown` = zoom out, and `ScrollUp` / `ScrollDown` = pan.
- Verify: wheel pans, Ctrl+wheel zooms, and the scroll actions are remappable in Options.
- **Implemented 2026-08-03** — wheel routes through the keybind table (`ScrollUp`/`ScrollDown` on `cmd-pan-up`/`cmd-pan-down`, `Ctrl+ScrollUp`/`Ctrl+ScrollDown` on `cmd-zoom-in`/`cmd-zoom-out`); cursor-anchored zoom; `VIEWER_WHEEL_PAN_STEP`; UI-scroll passthrough; Options Keys "Scroll Wheel" section with a Hold Ctrl / Toggle Ctrl (sticky) switch (`scroll_zoom_modifier`); status-bar latch badge; wheel-combo capture in `keybindUi.js`.

### Update Availability Indicator

- Full auto-update is likely out of scope for a single-executable app, but add a lightweight check that surfaces when a newer release exists on the GitHub page (the menu bar already links to it).
- Fail silently when offline or rate-limited; show an unobtrusive indicator/link when an update is available.
- Verify: with no network the app behaves normally; with an update available the indicator appears.

### File Associations (Options > File Associations)

**Goal.** Register image/archive extensions so they open with QuiviT. Each registered format should pick up the per-format icon from the app's icon set; formats without a dedicated icon fall back to the default QuiviT icon. Registration also unlocks real single-instance testing: double-clicking an associated file launches the exe with the file path as an argument, which the single-instance plugin forwards to the running instance.

**Notes on icon files.** The per-format icons exist as identical copies in two places:
- `icons/` (repo root) — the icon sources.
- `src/assets/icons/` — the copies the file list already uses (referenced by `filePanel.js` as `/assets/icons/<name>.ico`).

Current format icons present: `apng.ico`, `cbz.ico`, `gif.ico`, `svg.ico`, `webp.ico` (with `cbr` mapping to `cbz.ico` in `filePanel.js`). Formats like `jpg`, `jpeg`, `png`, `bmp`, `ico`, `avif`, `zip`, `rar` have no dedicated icon yet and should use a default/generic icon.

**Requirements (implementation details to be worked out by codex/antigravity):**

- **13.1 Backend (Rust):** register/unregister per-user file associations on Windows (no admin), with `DefaultIcon` and open-with command per extension; track which extensions QuiviT itself registered so unregister only removes QuiviT-owned keys. Windows-guarded; non-Windows returns a friendly "not supported" message. Shared format catalog consolidating the existing `SUPPORTED_IMAGES` / `SUPPORTED_ARCHIVES` lists (in `lib.rs`), each entry carrying ext, display name, optional icon file name, and category. Formats are NOT limited to the ones with icons.
- **13.2 Options UI:** replace the stub `#tab-associations` with a format list grouped by Images / Archives — each row has a checkbox, a per-format icon preview (reuse the `/assets/icons/<name>.ico` pipeline from `filePanel.js`), and the extension/display name; plus "Select all", "Register selected", "Unregister selected", and a status line. On open, reflect actual registry state. Persist the enabled set in config so it survives restarts and is silently re-asserted on startup (so a moved exe path updates the command target).
- **13.3 First-instance open-with handling:** the *second* instance path already works (single-instance callback → `single-instance-open` → `FsUtils.loadFile`). The *first* instance launched via "Open with" must also load its argument on startup.
- **13.4 Icons:** Explorer renders `DefaultIcon`, which must point to a real on-disk icon file — the `.ico` files are currently embedded assets, not shipped loose. Decide how the icon files reach disk (and whether to trigger a shell refresh so Explorer updates its cache).
- **13.5 Verification:**
  - Cold start: double-click a registered `.webp`/`.png`/`.cbz` → QuiviT opens the file.
  - Warm start: with an instance running, double-click another file → it opens in the existing window (tests the "Allow only one instance" option).
  - Unregister: extensions return to their previous default program; no other apps' associations are touched.
  - Formats without a dedicated icon still register and open correctly (default icon).
  - Checkbox state reflects actual registry state on Options open.
- **13.6 Fallback:** if a built-in file-type association selector turns out not to be possible, open the Windows Settings app for associating files with QuiviT instead (`ms-settings:defaultapps`), similarly to how NanaZip handles it.

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
- Confirm drag-and-drop opens a folder, the overlay is clickable with a proper cursor, and the canvas behind it cannot be dragged.
- Confirm keyboard panning is instant and spam-friendly across all four directions.
- Confirm plain wheel pans and Ctrl+wheel zooms, with scroll actions remappable in Options.
- Confirm the update indicator appears when a new GitHub release exists and stays silent offline.
- Confirm file associations register/unregister in HKCU, Explorer icons reflect the per-format icons, and double-clicking an associated file opens it (cold start) or forwards to the running instance (warm start).

## Post-Release Backlog (Future Considerations)

Items that are deliberately deferred until after the initial release. Low priority by design — do not start without re-validating the need.

### Native 7-Zip Sidecar Extraction (7Z/CB7 speed)
- Replace the pure-Rust `sevenz-rust2` extraction with the native 7-Zip engine (`7zr.exe` bundled as a Tauri sidecar) for 2-5x faster LZMA2 extraction.
- Full plan: `.agents/7z_implementation.md` (retained for future reference; has a `Status: Shelved` note).
- **Why shelved:** the original UI-blocking bug was already solved in pure Rust — background-thread extraction with atomic `.tmp`+`fs::rename` writes, `Condvar` wait replacing the 3s poll, `Content-Length` header, thread-offloaded protocol handler. The ~10MB/s vs ~50MB/s speed gap for typical image archives does not manifest as a real UX problem, and the sidecar adds deployment complexity (LGPL binary per platform, `tauri-plugin-shell`, capability config) plus re-introduces partial-file race concerns unless the plan's filesystem-watcher design is updated to match the current atomic-rename approach.
- If picked up later: re-read `.agents/7z_implementation.md`, keep the pure-Rust path as a fallback, and prefer single-entry `7zr` extraction over the full-extraction + watcher design in the current plan.
- 7z only — RAR already uses the native `unrar` crate; no consistency concern.

### File List Relocation, Detach & Drag-and-Drop
- Add a way to change the location of the file list (left default, top, bottom, right). Detached as well? Maybe drag-and-droppable — how practical would the implementation be?
- Using a JS library sounds ideal; this has been done before on a smaller scale at `E:\Projects\x4163-apps\dither-app` (not sure if it's the best/most-used library — performance-first). Prioritize clean user interaction with no jank.
- **Double page view** (manga spread) — same low priority.
- Partial implementation via UI buttons (detach + move location) is acceptable; drag-and-drop capabilities should be implemented after release.

### UI Sound Design (Low/Last Priority)
- Add custom SFX for UI interactions (e.g. button clicks, menu toggles, opening folders, error bumps).
- Needs a toggle in the Options menu to disable sounds for users who prefer a silent experience.
- Provide a volume slider or rely on system volume.
- Audio assets should be small and fast-loading.

## User Verification Gates

After each slice:

- Summarize changed files.
- State what was verified.
- Ask for user verification before moving to the next larger behavioral slice when needed.

## Verification Steps

Scope:
every/all changes made after the last remote push. The last remote push is the most recent commit present on `origin/master`;
everything in the working tree on top of it is what this pass must verify before the manual `make push` pipeline —
unless the user states otherwise (e.g., they request to emulate and go through the `make push` pipeline instead, since the active session already has most of the context).

1. Confirm the change set. `git status` must show only the intended files;
   reconcile anything unexpected before continuing.
2. Static checks. `node --check` on every touched JS module and `cargo check` in
   `src-tauri`.
3. Runtime-verify each change made after the last remote push: exercise the new
   behavior in the app and confirm it works as intended.
4. Manually review that the project remains coherently decoupled, with features
   in their own JS files where warranted.
5. Verify every config-backed feature meets both global and portable-mode
   requirements.
6. Port the completed items from this file into `.agents/implemented.md`,
   including any additions and fixes made during the pass that were not
   originally listed here.
7. Update `README.md` with new shortcuts, config behavior, archive behavior,
   module structure, and any relevant changes.
8. Add a new entry to `.agents/sessions-index.md`.
9. Repeat static and runtime verifications as needed.
10. Leave the repository ready for the user to run the push pipeline: final
    `git diff` matches the verified change set, nothing extra staged, no secrets.