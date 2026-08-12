# QuiviT Implementation Plan

## Current Architecture State

> **Keep this section updated after every structural change.** Stale information here CAN result in duplicated work, broken patterns, regressions, and clutter debt that compounds.

**Config & Persistence (Verified):**
- Rust `AppConfig` uses `#[serde(default)]` — missing top-level fields won't brick the config file.
- `frontend_data` is an untyped `JsonValue` — unknown/future keys round-trip safely without being dropped.
- `mergeConfig()` in `keybinds.js` spreads saved data over defaults — missing keys get filled in, extra keys pass through.
- Persistence policy is documented in `core.js` header and `keybinds.js`. Roaming files are the source of truth; `localStorage` is only a pre-paint cache, and an explicit third tier exists for ephemeral in-memory state.
- Split files: `quivit_config.json` (preferences), `quivit_state.json` (runtime state), `quivit_directory_sort.json`, `quivit_favorites.json`. Portable mode folds all into one file.
- Top-level `archive_cache_mb` (`usize`, default 512) sets the ZIP/CBZ byte budget for the in-memory archive cache; config-file-only, no UI.
- Theme/CSS previews are ephemeral: `options.js` tracks a `previewing` flag and `main.js` keeps `previewTheme`/`previewCss` so in-progress previews survive config reloads (file watcher), clearing only on Options Apply. Closing Options without Apply reverts the preview and resyncs the `quivit-theme` / `quivit-custom-css` pre-paint caches (prevents a flash on next open).
- The global `default_sort` lives in `quivit_config.json` (`frontend_data`) and is config-file-only; the UI writes only per-directory sort prefs (`quivit_directory_sort.json`).
- Restart-gated settings (`single_instance`) are staged as `pending_<key>` by the UI and promoted at startup by `apply_pending_config()` (`config.rs`) — never written live.

**JS Module Structure:**
- `core.js` — state machine, no DOM access. Communicates via callbacks.
- `keybinds.js` — default bindings, `mergeConfig()`, pan/zoom constants.
- `shortcuts.js` — keyboard/mouse/scroll dispatch, combo normalization. Exports `MOUSE_BUTTON_NAMES` as the single source of truth for all button mapping.
- `viewer.js` — image rendering, zoom, pan, fit modes. Uses a two-image DOM bridge inside `#viewer-img-wrapper` (current target + decoded previous image) while nearby pages warm through cancellable off-DOM `Image()` preloaders after navigation settles. `_updateScrollIndicator`'s idempotent sibling lives in `shortcuts.js`. Implements strict `quivit-config-loaded` caching for hot-path config access (e.g., pan keys) instead of dynamic evaluations.
- `filePanel.js` — file list, favorites, sorting UI, column resizing. Debounces/cancels hovered image source preloads so list clicks feel instant without keeping stale decodes alive.
- `fsUtils.js` — filesystem interactions, archive loading, sibling navigation, statusbar index / page-position formatting. Exposes `buildFileSrcSync` (sync `convertFileSrc` for off-DOM/bridge preloads; ICO sources stay async), `buildArchiveEntrySrc` (async archive entry source builder so archived ICO files can use spritesheet extraction), and a symmetric 7-ahead/7-behind prefetch window.
- `navigationHistory.js` — session-only container Back/Forward history.
- `directoryPrefs.js` — per-directory sort/grouping logic; exports `naturalCompare` (consumed by `fsUtils`).
- `metadata.js` — XML parsing logic for `ComicInfo.xml`, `CoMet.xml`, and `metadata.opf`.
- `metadata-window.js` — UI controller for the standalone metadata window (live sync, DOM).
- `menubar.js` — menu bar open/close, state, fullscreen chrome handling.
- `keyboardNav.js` — generic list/tab keyboard navigation (arrow keys, Home/End).
- `shellBackground.js` — leaf module (included on both pages) mirroring `--surface` into the native window background; re-syncs on theme/custom-CSS changes.
- `main.js` — DOM wiring, action dispatch, event listeners.
- `options.js` — Options window logic (theme/CSS previews, revert on close, width auto-fit).
- `keybindUi.js` — keybind capture/conflict UI (Options).
- `associationsUi.js` — file-type association UI (Options).

**Window Sizing:**
- Main window is built in Rust (`lib.rs` setup) so all windows share one construction path. Size constants live in `config.rs` (single source of truth), mirrored by JS caps (`OPTIONS_MAX_INITIAL_W`, `META_MAX_INITIAL_H`).
- Options/metadata windows open hidden, then JS measures content and calls `fit_*_window` (size + re-center) before `.show()` — no size flicker.

**Rust Module Structure:**
- `lib.rs` — app entry, main-window construction, `quivit://` archive-entry protocol routing, event setup, shell background sync at startup.
- `config.rs` — `AppConfig`, load/save, split-file helpers, portable detection, window size constants, options/metadata window lifecycle + fit/center commands.
- `commands.rs` — Tauri commands (directory listing, file ops, sibling nav, directory watcher, `get_path_kind`, `get_archive_ico_frames`). Utilizes `#[tauri::command(async)]` for heavy I/O (`list_archive`, `read_directory`, archive ICO frame extraction) to offload to background threads.
- `archives.rs` — archive listing/extraction (ZIP, RAR, 7Z, TAR + comic variants), safe temp-path mapping for extracted entries, and archive cache state. `ArchiveCache` holds a bounded recent set of per-archive `SingleArchiveCache` state plus a global byte-budgeted LRU (default 512 MB via `archive_cache_mb`) so decoded ZIP/CBZ entries across recent archives share one eviction pool; RAR/CBR, 7Z/CB7, and TAR/CBT keep temporary image/metadata extraction state for the recent archive working set.
- `ico.rs` — ICO spritesheet processing shared by loose-file `get_ico_frames` and archived-entry `get_archive_ico_frames` via `ico_frames_from_bytes`.
- `models.rs` — shared structs (`FileEntry`, etc.).
- `utils.rs` — path helpers, hidden-file detection.

## Work Plan

*The easiest and least invasive fixes are at the top to allow rapid checking off. Slices progress into more complex logical and visual changes.*

### File Navigation & Core Behavior Fixes (Medium Logic)
- **Large Directory / Archive DOM Rendering Performance:** Optimize file list rendering in `filePanel.js` when opening folders or archives containing thousands of files (e.g. `C:\Users\x4163\Pictures\Steam Screenshots`) (User note: I approve of this personal path appearing in our docs, it's fine).
  - **Root Cause:** Currently `renderFilePanel()` synchronously creates and appends tens of thousands of `<li>` DOM nodes and event listeners at once, freezing the main thread during DOM construction, styling, and layout reflow. (Backend processing may also be another cause for this, validate and see what costs performance dip and proceed from there)
  - **Proposed Solutions & Comparison:**
    1. *Incremental Batching (`CONFIG.batchSize` pattern from `E:\Projects\snap\snap - multi-page_json\html\snap-script.js`):* Renders the first 50–100 items instantly and schedules remaining items in background batches (`requestAnimationFrame` / `setTimeout`). Keeps the initial UI interactive, but eventually populates all DOM nodes, leaving layout/scroll performance degraded for huge lists.
    2. *DOM Virtualization / Windowing (Recommended - Performance-First):* Only render the visible rows (~30–50 `<li>` elements) plus a small buffer padding based on `scrollTop` and row height. Total DOM elements remain constant (~50 nodes) whether a directory has 10 files or 100,000 files. Delivers instant load times, zero scroll lag, and virtually zero memory growth.
    3. Discuss other available paths and options, aligning with the project's performance-first approach.

### View, Rendering & Window Enhancements (Visuals/Features)
- **Fullscreen Focus & Shortcut Loss Fix:** Fix bug where shortcut keys (including `Escape` / `F11`) occasionally stop functioning while in fullscreen mode (e.g., when switching focus to another monitor or Alt-Tabbing away and back).
  - **Investigation Needed:** The exact trigger and root cause are unconfirmed. Candidates to test during implementation include `activeKeys` remaining latched due to missed `keyup` events during window focus switches, WebView2 losing document focus to window chrome, or Tauri fullscreen event listeners.
  - **Target Outcome:** Ensure keyboard shortcuts and `Escape` always work reliably in fullscreen mode across multi-monitor setups and focus changes.
- **Window & Panel Resize Transform Snap Fix:** Fix issue where dragging `.panel-resize-handle` or resizing the main app window causes active zoom level and pan position to unexpectedly snap/reset.
  - **Fix:** Preserve relative zoom scale and pan offset relative to container viewport bounds during panel and window resize events in `viewer.js`.
- **Idle Cursor Auto-Hide (Canvas Only):** Hide mouse cursor after `X` seconds of inactivity when hovering over the viewport/canvas.
  - **Configurable Delay:** Settable in Options under Interface (`hide_cursor_delay_sec`, e.g., default `2s` or `3s`).
  - **Semantics of `0`:** `0` = Disabled (cursor never auto-hides). This prevents cursor disappearance during active hover/use.
  - **Keybind Support (`cmd-toggle-cursor-autohide`):** Add a configurable keybind to toggle the auto-hide feature on/off or force-hide the cursor immediately until mouse movement. IMPORTANT: Discuss what is the most intuitive behaviour for best user experience.
  - **Edge Cases & Panning:** Panning or dragging triggers `mousemove` / input events which naturally reset the idle timer, keeping the cursor visible throughout active panning and hiding only after panning stops and the mouse remains still for `X` seconds. `mouseleave` or UI chrome hover restores standard cursor styling.
  - **Performance First (Zero-Overhead):** Bypassed entirely when `0` (Disabled). During active movement, use a lightweight debounced single-timer reset without dynamic allocations or garbage collection churn in the `mousemove` hot path.
- **Emergency Boss Key:** Add an "Emergency Button" to hide the application into the system tray, with a configurable keybind.
- **Helium Exit-Fullscreen:** Copy Helium browser's exit-fullscreen functionality (hold to exit, and a top exit button offscreen that slides down via hover). (https://github.com/imputnet/helium) 
- **Pan Lengths & Smooth Panning:** Add individual pan lengths for scroll vs shortcuts (copying original Quivi defaults). Try implementing a smooth panning option and test to see if that feels nice and responsive, if not just revert.
- **Zoom Smoothing:** Same as the above, try out -> decide.
- **Responsive Keyboard Panning:** Audit the keyboard pan pipeline (debounce/delay). Make panning apply immediately per key press and support fast multi-directional spam. Currently the performance is just not up to par with the original Quivi application.
- **HTML Flickering & Image Navigation:** Optimize image navigation to prevent HTML flickering. 
  - *Context:* Whilst the processing has already been improved to be identical to the original Quivi behavior (show previous image until new one is ready), there's still inherent flickering caused by the presentation: `click/active > load image > present image`. This can easily be fixed by improving the html/js functions (caching/preloading).
  - This additionally fixes the lag when holding down a key and switching images really fast.
  - Fix the issue where the opaque canvas appears first and then the image; they should always appear at the same time.
  - Consider keeping a session cache of files inside archives, prevents decompressing them again in the same session. Discuss adding a cache limit in the options (though leaning towards being against putting it in options).
- **Initial HTML Loading (LCP):** Completely remove the blank page time on initial loading of both HTML pages before the main UI renders. It's currently acting this way because we are optimizing for LCP on the flickering of themes. Refer to the way LCP is handled on `E:\Projects\PixiJS Live2D Spine (Springfield)` for reference.
- **SVG Rendering & Bounds:** Audit SVG elements behavior of hitbox/dimensions going over the canvas edge. The calculations for SVG images that have a WxH of 100% compared to a set WxH act differently and break the border/edge calculations on the canvas and/or image.
  - *Key examples:* `test-files/gfl-spinner.svg` works as expected, while `icons/quivi-t_moe-2.svg` does not. 
  - *Visual insight on SVGs that have a WxH of 100%:* the bounds/edge of the image seems to visually be the **center of the image** instead of the **very edges**. 
  - "very edges" = `0x, 0y, widthX, heightY` (left, top, right, bottom) of the displayed image element. 
  - "center of the image" = `(widthX / 2)x, (heightY / 2)y, (widthX / 2)x, (heightY / 2)y` (left, top, right, bottom) of the displayed image element.
- **Scaling Modes (Bicubic vs Lanczos):** Implement a proper way to scale via Bicubic and Lanczos (using external API or JS library if CSS doesn't support Lanczos). Doing this should also provide us the initial entry for using more advanced custom scaling methods.
  - This also means we need to make each scaling method available as a settable keybind.

### CSS, Styling & Code Structure (Refactoring)
- **Persistent Root Column Sizes:** Treat CSS root column sizes as persistent data saved via WebView2. Add a reset column sizes button in the options (under General).
- **Syntax Highlighting:** Add syntax highlighting to the Custom CSS field in Customization using an available font (fonts that have syntax highlighting) or a small library.
- **Custom CSS Persistence Bugs:** Fix custom CSS persistence. Fix the bug where it sometimes doesn't apply on restart, or applies even when it was removed. **Note: Unsure if this bug still exists, as it has not been encountered since the major syncing refactor.**
- **Tab Navigation Extraction:** Move a huge portion of the tab navigation logic into its own JS file (e.g., `keyboardNav.js`) using state callbacks to decouple and reduce clutter. Manually style active tab navigation items into their own CSS file.
- **CSS Decoupling:** Clean up CSS. Create a `global.css` for root vars, global resets, and general rules. Allow individual HTML pages to have specific CSS files to reduce clutter.
- **JS DOM Decoupling:** Move DOM interaction/manipulation to its own file and communicate between files via state callbacks. Refer to the `E:\Projects\PixiJS Live2D Spine (Springfield)` project structure.

### Supported Formats & Advanced Icons (Complex)
- **File Association Prompt:** Add a prompt notification at the center of the screen pointing users to the File Associations tab (reminding them that they can and should set file associations).
- **Missing .ico Spritesheets:** Fix bug where certain ICO files (like `test-files/endfield.ico`) do not get the spritesheet treatment.
- **Advanced .ico Processing:** Improve .ico processing (performance-first). Change the .ico processing and rendering spec:
  1. Add a 'ICO Spritesheet' to the view dropdown under 'opaque canvas' (make sure this is configurable in the keybinds option). Default: ON.
  2. OFF: .ico files should not be processed at all and should just act as a legacy image file. ON: .ico files should be processed.
  3. Process each .ico size as an individual image file instead of a single spritesheet.
  4. Render out each size individually in the canvas.
  5. The largest ico size is the single source of truth; this element should be the only element that has canvas bounding calculations.
  6. The remaining smaller sizes are just a shadow of the main ico element, layed out (with space between them) in the spritesheet order. This means that it follows the main ico file whilst not having any hitbox/bounding calculations.
  7. Render out the 'opaque canvas' option for every ico element.
- **Extended Format Support:** Support PSD, XCF, and PDF files (decide whether to process via JS or backend, performance-first).
- **Password-Protected Archives:** Add support for password-protected archives.

### Documentation & GitHub (Project Health)
- **Contributing Section:** Add a contributing section to the github page, for general contributions to the project, but more on documenting how new languages should be created for the language settings.

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
5. Manually review that the project remains coherently decoupled, with features in their own JS/Rust files where warranted. Keep or improve the current split on both sides (`core.js`, `viewer.js`, `filePanel.js`, `shortcuts.js`, `keybinds.js`, `options.js`, `main.js` for the frontend; `lib.rs`, `config.rs`, `commands.rs`, `archives.rs`, `models.rs`, `utils.rs` for the backend).
6. Update the **"Current Architecture State"** section at the top of this file to accurately document any new, deleted, or repurposed JS/Rust modules and configuration behavior.
7. Verify every config-backed or persistent feature meets both global and portable-mode requirements.
8. Port the completed items from this file into `.agents/implemented.md`, including any additions and fixes made during the pass that were not originally listed here.
9. Update `README.md` with new shortcuts, config behavior, archive behavior, module structure, and any relevant changes. Especially look out for things that should be inlcuded in the **"Documentation"** section.
10. Add a new entry to `.agents/sessions-index.md`.
11. Repeat static and runtime verifications as needed.
12. Leave the repository ready for the user to run the push pipeline: final `git diff` matches the verified change set, nothing extra staged, no secrets, no private paths.

---

## Post-Release Backlog (Future Considerations)

*Items deliberately deferred until after the initial release. Low priority by design — do not start without re-validating the need.*

### File List Relocation, Detach & Drag-and-Drop
- Add a way to change the location of the file list (left default, top, bottom, right). Detached as well? Maybe drag-and-droppable — how practical would the implementation be?
- Using a JS library sounds ideal; this has been done before on a smaller scale at `E:\Projects\x4163-apps\dither-app` (not sure if it's the best/most-used library — performance-first). Prioritize clean/snappy user interaction with no jank.
- Partial implementation via UI buttons (detach + move location) is acceptable pre-release; drag-and-drop capabilities should be implemented after release.

### File List Thumbnail View
- Add a thumbnail/medium view mode to the file list: image files show a medium-size preview thumbnail, non-image items (folders, archives, `..`) show a medium-size icon.
- Medium icons have a partial backend already: `get_native_icon` fetches 16×16 shell icons via `SHGFI_SMALLICON`. A medium variant would need `SHGFI_LARGEICON`/32×32 — mind the documented Windows shell scaling bug that returns open-folder variants when requesting large icons downscaled (`ico.rs` already works around this).
- Image previews: reuse the existing `asset://` / `quivit://` src pipeline (`fsUtils.js` `buildArchiveSrc`) to generate thumbnails on demand; lean on the existing off-screen preloader / caching patterns.
- **Placement TBD:** the toggle-button location is unresolved — `.file-panel-actions` (the bottom action strip holding Open Explorer / Open Folder / Favorite / metadata badge) feels iffy. Alternatives to explore: a view-mode control in the file-panel header (above the column-header row), a View-menu item, or a `cmd-*` keybind like the existing view toggles.
- **Performance-first:** only load thumbnails for visible rows (lazy/virtualized), never decode full-size images for the preview, and no overhead in the normal list mode.

### Double Page View & Manga Spread Mode
- **Reading Orientation (LTR / RTL):**
  - Ability to set reading mode to Left-to-Right (LTR) or Right-to-Left (RTL).
  - Alignment control for `Fit None` (currently defaults to top-center; support top-left or top-right positioning based on reading direction for manga/comics).
- **Spread Page Viewing (Half-Width Fit-to-Width):**
  - When enabled and an image is wider than it is tall (`width > height`), calculate Fit-to-Width using half of the image width (`width / 2`) instead of full width. This maintains a consistent zoom level across single pages and 2-page spread images.
- **Implementation Challenges & Considerations:**
  1. **Reading Direction Sync:** Must align with the active LTR / RTL setting to determine which side of the spread to display first (e.g. top-right start for RTL manga spread, top-left start for LTR comic spread).
  2. **Visual Spread Indicator:** Provide a clear visual indicator/badge (both in the status bar and in fullscreen overlay) showing that the active image is a spread page rendered in half-width mode, so the user knows they are viewing a zoomed-in spread section.

### Manhwa Mode (Continuous Vertical Strip)
- Automatically append pages together vertically on the same canvas page.
- Build on the preloading and image caching infrastructure, but treat continuous Manhwa rendering as its own post-release slice.
- **Active Item Synchronization:** As the user scrolls vertically through the continuous strip, dynamically track the currently visible image and keep the active item selection in the file list and status bar perfectly in sync.

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

### Additional Metadata Formats
- Add support for parsing `comicinfo.json` and reading embedded EXIF/Acme tags directly from image binaries.
- Currently deferred because `ComicInfo.xml` and `metadata.opf` cover 99.9% of use-cases. If requested by users, this can be easily slotted in thanks to the decoupled metadata architecture.

### Update Availability Indicator
- Add a lightweight GitHub releases check on startup that displays an update notice in the `.menubar-spacer` area (right-aligned, pointing toward the GitHub button).
- When an update is available: show a sentence like "Version X.Y.Z is available — you are X versions behind" inside the menubar spacer. Temporarily reroute the GitHub button to the releases page for that session.
- No auto-download or auto-install — this intentionally avoids an auto-update system, which is out of scope and conflicts with the portable-first goals.
- Fail silently when offline or rate-limited.
- **Important:** Must be implemented and tested after the first actual release is published on GitHub, otherwise there's nothing to compare against.

### Other Platform Support
- Currently impractical: this is a Windows-only codebase and there's no access to other devices (or OSes) for testing. A huge portion of the backend relies on Windows APIs — `SHGetFileInfoW` native icons (`ico.rs`), registry-based file associations with `UserChoice` semantics and `ms-settings:defaultapps` deep links (`commands.rs`), `SHChangeNotify`, explorer integration, the `.exe`-adjacent portable config — plus Windows-specific assumptions in the frontend (drive-root `C:\` paths, `quivit://localhost` protocol routing differences, WebView2 as the only runtime).
- **Best path forward — undecided, open question.** Candidate directions:
  - **(a) Multiple projects:** fork/split each platform into its own codebase/project. Pros: native behavior per platform, no abstraction tax. Cons: duplicated frontend/UI, double maintenance burden.
  - **(b) OS-abstraction pipeline in this codebase:** put a structure/system/pipeline in place so OS-specific API/function calls sit behind platform layers where Windows APIs are currently used directly — e.g. a Rust `platform` module/trait behind the Tauri commands (Windows impl today, stub/fallback impls for other targets) plus a JS-side capability switch, so other targets at least compile and degrade gracefully.
  - **(c) Hybrid:** abstract only where the seam is cheap (path handling, protocol routing, config locations), and keep separate projects where the gap is too large (file associations, native icons).
- Do not start this without first securing at least one non-Windows test device or CI runner — verification is impossible otherwise.
