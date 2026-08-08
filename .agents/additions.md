# QuiviT Implementation Plan

## Current Architecture State

> **Keep this section updated after every structural change.** Stale information here CAN result in duplicated work, broken patterns, regressions, and clutter debt that compounds.

**Config & Persistence (Verified):**
- Rust `AppConfig` uses `#[serde(default)]` — missing top-level fields won't brick the config file.
- `frontend_data` is an untyped `JsonValue` — unknown/future keys round-trip safely without being dropped.
- `mergeConfig()` in `keybinds.js` spreads saved data over defaults — missing keys get filled in, extra keys pass through.
- Persistence policy is documented in `core.js` header and `keybinds.js`. Roaming files are the source of truth; `localStorage` is only a pre-paint cache.
- Split files: `quivit_config.json` (preferences), `quivit_state.json` (runtime state), `quivit_directory_sort.json`, `quivit_favorites.json`. Portable mode folds all into one file.
- Theme/CSS previews are ephemeral: `options.js` tracks a `previewing` flag and `main.js` keeps `previewTheme`/`previewCss` so in-progress previews survive config reloads (file watcher), clearing only on Options Apply. Closing Options without Apply reverts the preview and resyncs the `quivit-theme` / `quivit-custom-css` pre-paint caches (prevents a flash on next open).

**JS Module Structure:**
- `core.js` — state machine, no DOM access. Communicates via callbacks.
- `keybinds.js` — default bindings, `mergeConfig()`, pan/zoom constants.
- `shortcuts.js` — keyboard/mouse/scroll dispatch, combo normalization.
- `viewer.js` — image rendering, zoom, pan, fit modes.
- `filePanel.js` — file list, favorites, sorting UI, column resizing.
- `fsUtils.js` — filesystem interactions, archive loading, sibling navigation.
- `navigationHistory.js` — session-only container Back/Forward history.
- `directoryPrefs.js` — per-directory sort/grouping logic.
- `menubar.js` — menu bar open/close, state, fullscreen chrome handling.
- `keyboardNav.js` — generic list/tab keyboard navigation (arrow keys, Home/End).
- `shellBackground.js` — leaf module (included on both pages) mirroring `--surface` into the native window background; re-syncs on theme/custom-CSS changes.
- `main.js` — DOM wiring, action dispatch, event listeners.
- `options.js` — Options window logic (theme/CSS previews, revert on close).
- `keybindUi.js` — keybind capture/conflict UI (Options).
- `associationsUi.js` — file-type association UI (Options).

**Rust Module Structure:**
- `lib.rs` — app entry, window/event setup, shell background sync at startup.
- `config.rs` — `AppConfig`, load/save, split-file helpers, portable detection, `open_options` window management.
- `commands.rs` — Tauri commands (directory listing, file ops, sibling nav, `get_path_kind`).
- `archives.rs` — archive listing/extraction (ZIP, RAR, 7Z, TAR + comic variants).
- `ico.rs` — ICO spritesheet processing.
- `models.rs` — shared structs (`FileEntry`, etc.).
- `utils.rs` — path helpers, hidden-file detection.

## Work Plan

*The easiest and least invasive fixes are at the top to allow rapid checking off. Slices progress into more complex logical and visual changes.*

### File Navigation & Core Behavior Fixes (Medium Logic)
- **Image Navigation Clamping:** If the first or last item in the file list is an image (or if there is only a single image file and no other folders/archives), navigating past them should clamp the selection to that image instead of booting out to the empty drag-and-drop screen.
- **File Deletion Fallbacks:** When an active archive or folder is deleted while viewing, boot the user back appropriately. For images, go to the previous file (or none if empty). Ensure "Continue from last opened directory/image" falls back gracefully if the target doesn't exist at startup.
- **Archive Interruption Fix:** Prevent active image interruptions inside an archive. Currently, when new files are created in the archive's working directory, the user is booted back to the first image. Whilst folders don't have any image data to be viewed, still make sure the selection is not interrupted when new files are added.
- **'This PC' Directory Bug:** Fix open directory behavior where selecting 'This PC' does not work. See if Tauri can route this to drive selection for the filelist.
- **Character Encoding Compatibility:** Support full character encoding file paths (emojis, JP, CN, KR, etc.) so no filenames or paths crash or present a 404 displayed image.
- **Hidden File Config:** Add a hidden true/false config inside the portable config file. Dynamically change and listen to the Windows/System hidden state of the file and appropriate sync.

### View, Rendering & Window Enhancements (Visuals/Features)
- **Initial Window Sizes:** Adjust the initial and minimum window sizes of the Tauri windows. Explore and see if auto-fit to tabs for width, and auto-fit to Options page for height feels intuitive.
- **HTML Flickering & Image Navigation:** Optimize image navigation to prevent HTML flickering. 
  - *Context:* Whilst the processing has already been improved to be identical to the original Quivi behavior (show previous image until new one is ready), there's still inherent flickering caused by the presentation: `click/active > load image > present image`. This can easily be fixed by improving the html/js functions (caching/preloading).
  - This additionally fixes the lag when holding down a key and switching images really fast.
  - Fix the issue where the opaque canvas appears first and then the image; they should always appear at the same time.
  - Consider keeping a session cache of files inside archives, prevents decompressing them again in the same session. Discuss adding a cache limit in the options (though leaning towards being against putting it in options).
- **Initial HTML Loading (LCP):** Completely remove the blank page time on initial loading of both HTML pages before the main UI renders. It's currently acting this way because we are optimizing for LCP on the flickering of themes. Refer to the way LCP is handled on `E:\Projects\PixiJS Live2D Spine (Springfield)` for reference.
- **Responsive Keyboard Panning:** Audit the keyboard pan pipeline (debounce/delay). Make panning apply immediately per key press and support fast multi-directional spam. Currently the performance is just not up to par with the original Quivi application.
- **Pan Lengths & Smooth Panning:** Add individual pan lengths for scroll vs shortcuts (copying original Quivi defaults). Try implementing a smooth panning option and test to see if that feels nice and responsive, if not just revert.
- ** Zoom Smoothing** Same as the above, try out -> decide.
- **Scaling Modes (Bicubic vs Lanczos):** Implement a proper way to scale via Bicubic and Lanczos (using external API or JS library if CSS doesn't support Lanczos). Doing this should also  provide us the initial entry for using more advanced custom scaling methods.
  - This also means we need to make each scaling methods available as a settable keybinbd.
- **SVG Rendering & Bounds:** Audit SVG elements behavior of hitbox/dimensions going over the canvas edge. The calculations for SVG images that have a WxH of 100% compared to a set WxH act differently and break the border/edge calculations on the canvas and/or image.
  - *Key examples:* `test-files/gfl-spinner.svg` works as expected, while `icons/quivi-t_moe-2.svg` does not. 
  - *Visual insight on SVGs that have a WxH of 100%:* the bounds/edge of the image seems to visually be the **center of the image** instead of the **very edges**. 
  - "very edges" = `0x, 0y, widthX, heightY` (left, top, right, bottom) of the displayed image element. 
  - "center of the image" = `(widthX / 2)x, (heightY / 2)y, (widthX / 2)x, (heightY / 2)y` (left, top, right, bottom) of the displayed image element.
- **Emergency Boss Key:** Add an "Emergency Button" to hide the application into the system tray, with a configurable keybind.
- **Helium Exit-Fullscreen:** Copy Helium browser's exit-fullscreen functionality (hold to exit, and a top exit button offscreen that slides down via hover). (https://github.com/imputnet/helium) 

### CSS, Styling & Code Structure (Refactoring)
- **CSS Decoupling:** Clean up CSS. Create a `global.css` for root vars, global resets, and general rules. Allow individual HTML pages to have specific CSS files to reduce clutter.
- **JS DOM Decoupling:** Move DOM interaction/manipulation to its own file and communicate between files via state callbacks. Refer to the `E:\Projects\PixiJS Live2D Spine (Springfield)` project structure.
- **Tab Navigation Extraction:** Move a huge portion of the tab navigation logic into its own JS file (e.g., `keyboardNav.js`) using state callbacks to decouple and reduce clutter. Manually style active tab navigation items into their own CSS file.
- **Persistent Root Column Sizes:** Treat CSS root column sizes as persistent data saved via WebView2. Add a reset column sizes button in the options (under General).
- **Custom CSS Persistence Bugs:** Fix custom CSS persistence. Fix the bug where it sometimes doesn't apply on restart, or applies even when it was removed. **Note: Unsure if this bug still exists, as it has not been encountered since the major syncing refactor.**
- **Syntax Highlighting:** Add syntax highlighting to the Custom CSS field in Customization using an available font (fonts that have syntax highlighting) or a small library.

### Supported Formats & Advanced Icons (Complex)
- **Advanced .ico Processing:** Improve .ico processing (performance-first). Change the .ico processing and rendering spec:
  1. Add a 'ICO Spritesheet' to the view dropdown under 'opaque canvas' (make sure this is configurable in the keybinds option). Default: ON.
  2. OFF: .ico files should not be processed at all and should just act as a legacy image file. ON: .ico files should be processed.
  3. Process each .ico size as an individual image file instead of a single spritesheet.
  4. Render out each size individually in the canvas.
  5. The largest ico size is the single source of truth; this element should be the only element that has canvas bounding calculations.
  6. The remaining smaller sizes are just a shadow of the main ico element, layed out (with space between them) in the spritesheet order. This means that it follows the main ico file whilst not having any hitbox/bounding calculations.
  7. Render out the 'opaque canvas' option for every ico element.
- **Missing .ico Spritesheets:** Fix bug where certain ICO files (like `test-files/endfield.ico`) do not get the spritesheet treatment.
- **Extended Format Support:** Support PSD, XCF, and PDF files (decide whether to process via JS or backend, performance-first).
- **Password-Protected Archives:** Add support for password-protected archives.
- **File Association Prompt:** Add a prompt notification at the center of the screen pointing users to the File Associations tab (reminding them that they can and should and can set file associations).

### Documentation & GitHub (Project Health)

- **Contributing Section:** Add a contributing section to the github page, for general contributions to the project, but more on documenting how new languages should be created for the language settings.
- **Update Availability Indicator:** Add a lightweight GitHub releases check that surfaces an unobtrusive notice on the menubar's existing GitHub button when a newer version is available. No auto-download or auto-install — this intentionally avoids an auto-update system, which is out of scope and conflicts with the portable-first goals. Fail silently when offline or rate-limited.

---

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

1. Confirm the change set. `git status` must show only the intended files; reconcile anything unexpected before continuing.
2. Confirm `.gitignore` coverage (do not track generated runtime config, portable config, build output, or personal directory-sort metadata). If portable mode writes personal paths next to the executable, ensure those files are ignored.
3. Static checks. `node --check` on every touched JS module and `cargo check` in `src-tauri`.
4. Runtime-verify each change made after the last remote push: exercise the new behavior in the app and confirm it works as intended.
5. Manually review that the project remains coherently decoupled, with features in their own JS files where warranted. Keep or improve the current split (`core.js`, `viewer.js`, `filePanel.js`, `shortcuts.js`, `keybinds.js`, `options.js`, `main.js`).
6. Update the **"Current Architecture State"** section at the top of this file to accurately document any new, deleted, or repurposed JS/Rust modules and configuration behavior.
7. Verify every config-backed feature meets both global and portable-mode requirements.
8. Port the completed items from this file into `.agents/implemented.md`, including any additions and fixes made during the pass that were not originally listed here.
9. Update `README.md` with new shortcuts, config behavior, archive behavior, module structure, and any relevant changes.
10. Add a new entry to `.agents/sessions-index.md`.
11. Repeat static and runtime verifications as needed.
12. Leave the repository ready for the user to run the push pipeline: final `git diff` matches the verified change set, nothing extra staged, no secrets, no private paths.

---

## Post-Release Backlog (Future Considerations)

*Items deliberately deferred until after the initial release. Low priority by design — do not start without re-validating the need.*

### File List Relocation, Detach & Drag-and-Drop
- Add a way to change the location of the file list (left default, top, bottom, right). Detached as well? Maybe drag-and-droppable — how practical would the implementation be?
- Using a JS library sounds ideal; this has been done before on a smaller scale at `E:\Projects\x4163-apps\dither-app` (not sure if it's the best/most-used library — performance-first). Prioritize clean user interaction with no jank.
- Partial implementation via UI buttons (detach + move location) is acceptable pre-release; drag-and-drop capabilities should be implemented after release.

### Double Page View (Manga Spread)
- Low priority, implement after initial release. Imagine split window esque.

### Detach Image Window
- Add the ability to pop the currently viewed image out into its own standalone window, separate from the main QuiviT UI.
- Relevant alongside Double Page View and File List Detach/Drag-and-Drop as they share the same "detach" interaction paradigm.

### Animated Frame Timeline
- Add a frame timeline bar at the bottom of the canvas viewer for animated formats (WebP, APNG, GIF, SVG? (if that's even possible, discuss practical options), and any other animated image formats supported).
- **Reference:** https://sourceforge.net/projects/gifviewer/ — match its visual style and interaction model.
- **Controls:**
  - Play/pause button.
  - Frame count indicator (`X / Y`).
  - Draggable scrubber bar to seek through frames.
  - Keyboard navigatable via arrow keys and tab navigation.
  - The existing `cmd-next` / `cmd-prev` keybinds should tie into frame stepping when an animated file is active.
- **Layout:** Sits at the bottom of the canvas viewer (not full-width of the window). Height should always match `#file-panel-actions` via a shared CSS variable so it stays visually consistent. Exact width behavior TBD — full width feels off for files with few frames, so consider a constrained or content-aware width.
- **Performance-first**: snappy (not sluggish) interaction with little to no visual delays/jank (delayed responses/unresponsiveness, flickering etc.), and only activate timeline logic when an animated format is detected; no overhead for static images.

### UI Sound Design (Low/Last Priority)
- Add custom SFX for UI interactions (e.g. button clicks, menu toggles, opening folders, error bumps).
- Needs a toggle in the Options menu to disable sounds for users who prefer a silent experience.
- Provide a volume slider or rely on system volume.
- Audio assets should be small and fast-loading, or even script-generated (e.g. 8-bit style SFX).

### Advanced Favorites System
- Improve favorites system: add a Favorites dropdown under the menu bar to load/save favorites. Consider an input for titles, only if the styling/intuitiveness of the dropdown interaction is good.
- Consider a separate bookmarks thing acting like legacy favorites, placed under favorites.
- The JS names can just be consolidated and changed into the same thing; the only difference for favorites is saving and loading it as a favorites list.

### Native 7-Zip Sidecar Extraction (7Z/CB7 speed)
- Replace the pure-Rust `sevenz-rust2` extraction with the native 7-Zip engine (`7zr.exe` bundled as a Tauri sidecar) for 2-5x faster LZMA2 extraction.
- Full plan: `.agents/7z_implementation.md` (retained for future reference; has a `Status: Shelved` note).
- **Why shelved:** the original UI-blocking bug was already solved in pure Rust. The speed gap does not manifest as a real UX problem, and the sidecar adds deployment complexity plus re-introduces partial-file race concerns.
- If picked up later: keep the pure-Rust path as a fallback, and prefer single-entry `7zr` extraction over the full-extraction + watcher design in the current plan.
- **Optional single-file engine:** Ship the 7z/cb7 DLL as a drop-in sidecar — if it's present next to the exe, use it; otherwise fall back to the optimized pure-Rust path. Keeps the app portable for users who don't use 7z/cb7.
- **Placement (leaning):** require the DLL to be either next to the exe or in the roaming folder to take effect. Not storing it as a portable-mode config item.
- Future optional dependencies could follow the same drop-in pattern — they act like non-required modules.
- Document this on the README under documentation after it is implemented.

### Custom QuiviT Icons
- Create custom QuiviT icons for each file type (incorporating the mascot) rather than using generic ones.

### Windows Thumbnails (APNG/WebP)
- Add working Windows thumbnails (including preview pane) for APNG and animated WebP.
  - Antigravity IDE actually adds multiple things that Windows doesn't natively have, SVG thumbnails, code and MD files for the preview pane/animated thumbnail/icons. It would be great if we can support APNG/WebP files in a similar way that's practical to the project scope.
