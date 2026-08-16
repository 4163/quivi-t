# QuiviT Implementation Plan

- `.agents/architecture-state.md` — current module map and verification checklist.
- `.agents/implemented.md` — shipped, verified work. Port completed slices there when they leave this plan.

## Work Plan

*Easiest and least invasive first.*

### Animated "Loading..." Broken-Image Feedback on Image Load
- Re-introduce the animated `alt="Loading..."` broken-image visual whenever an image is in the loading state — i.e. when `.status-filename` shows `Loading...` (`viewerRender.js` already writes that on `activeChanged`).
- Currently `_setElementLoadingLabel` sets only a static `alt = 'Loading...'`, and the broken-image frame is only actually visible on the first-display placeholder; seamless swaps (previous image held as a bridge) show no loading feedback at all.
- Easy emulation: create an `img` element whose `src` purposefully points at a non-existent target (or a broken base64-encoded image) so the browser renders its built-in broken-image frame, and animate its `alt` text (`Loading. → Loading.. → Loading...`, reuse/restore the earlier `startLoadingAltAnimation`-style helper in `viewerRender.js`) while loading.

### Favorites & Bookmarks System (Medium Logic)
- **From clipboard notes (2026-08-13):**
  - Middle-click removes a favorite directly — intentionally NOT mappable to a keybind; just document it in the README Features section where favorites is covered.
  - Ordering: implement the advanced favorites next, but FIRST rename the current favorites names in JS/HTML/CSS (functions, classes, IDs) to "bookmark".
  - README: document the favorites system under Features; afterwards place the bookmark (legacy favorites) system entry under it, described simply as a bookmark that works similarly to favorites.
  - Favorites file-list remove-button (X) visibility: currently an active/highlighted item makes its X button visible; it should only be visible on hover, or when focused via Tab keyboard navigation — not merely because the item is the active selection.
- **Improve favorites system:** add a Favorites dropdown under the menu bar to load/save favorites. Consider an input for titles, only if the styling/intuitiveness of the dropdown interaction is good.
- **Separate bookmarks system (legacy favorites):** placed under the favorites section, acting like the old favorites. The JS names across both can be consolidated into the same thing — the only difference is saving/loading favorites as a favorites list.

### View, Rendering & Window Enhancements (Visuals/Features)
- **Fullscreen Focus & Shortcut Loss Fix:** Fix bug where shortcut keys (including `Escape` / `F11`) occasionally stop functioning while in fullscreen mode (e.g., when switching focus to another monitor or Alt-Tabbing away and back).
  - **Investigation Needed:** The exact trigger and root cause are unconfirmed. Candidates to test during implementation include `activeKeys` remaining latched due to missed `keyup` events during window focus switches, WebView2 losing document focus to window chrome, or Tauri fullscreen event listeners.
  - **Target Outcome:** Ensure keyboard shortcuts and `Escape` always work reliably in fullscreen mode across multi-monitor setups and focus changes.
- **Window & Panel Resize Transform Snap Fix:** Fix issue where dragging `.panel-resize-handle` or resizing the main app window causes active zoom level and pan position to unexpectedly snap/reset.
  - **Fix:** Preserve relative zoom scale and pan offset relative to container viewport bounds during panel and window resize events in `viewerMath.js` / `viewerRender.js`.
- **Idle Cursor Auto-Hide (Canvas Only):** Hide mouse cursor after `X` seconds of inactivity when hovering over the viewport/canvas.
  - **Configurable Delay:** Settable in Options under Interface (`hide_cursor_delay_sec`, e.g., default `2s` or `3s`).
  - **Semantics of `0`:** `0` = Disabled (cursor never auto-hides). This prevents cursor disappearance during active hover/use.
  - **Keybind Support (`cmd-toggle-cursor-autohide`):** Add a configurable keybind to toggle the auto-hide feature on/off or force-hide the cursor immediately until mouse movement. IMPORTANT: Discuss what is the most intuitive behaviour for best user experience.
  - **Edge Cases & Panning:** Panning or dragging triggers `mousemove` / input events which naturally reset the idle timer, keeping the cursor visible throughout active panning and hiding only after panning stops and the mouse remains still for `X` seconds. `mouseleave` or UI chrome hover restores standard cursor styling.
  - **Performance First (Zero-Overhead):** Bypassed entirely when `0` (Disabled). During active movement, use a lightweight debounced single-timer reset without dynamic allocations or garbage collection churn in the `mousemove` hot path.
- **Emergency Boss Key:** Add an "Emergency Button" to hide the application into the system tray, with a configurable keybind.
- **Initial HTML Loading (LCP):** Completely remove the blank page time on initial loading of both HTML pages before the main UI renders. It's currently acting this way because we are optimizing for LCP on the flickering of themes. Refer to the way LCP is handled on `E:\Projects\PixiJS Live2D Spine (Springfield)` for reference.
- **SVG Rendering & Bounds:** Audit SVG elements behavior of hitbox/dimensions going over the canvas edge. The calculations for SVG images that have a WxH of 100% compared to a set WxH act differently and break the border/edge calculations on the canvas and/or image.
  - *Key examples:* `test-files/gfl-spinner.svg` works as expected, while `icons/quivi-t_moe-2.svg` does not. 
  - *Visual insight on SVGs that have a WxH of 100%:* the bounds/edge of the image seems to visually be the **center of the image** instead of the **very edges**. 
  - "very edges" = `0x, 0y, widthX, heightY` (left, top, right, bottom) of the displayed image element. 
  - "center of the image" = `(widthX / 2)x, (heightY / 2)y, (widthX / 2)x, (heightY / 2)y` (left, top, right, bottom) of the displayed image element.
- **Scaling Modes (Bicubic vs Lanczos):** Implement a proper way to scale via Bicubic and Lanczos (using external API or JS library if CSS doesn't support Lanczos). Doing this should also provide us the initial entry for using more advanced custom scaling methods.
  - This also means we need to make each scaling method available as a settable keybind.
  - https://canvasui.dev/ esque. html in canvas?

### CSS, Styling & Code Structure (Refactoring)
- **Persistent Root Column Sizes:** Treat CSS root column sizes as persistent data saved via WebView2. Add a reset column sizes button in the options (under General).
- **Syntax Highlighting:** Add syntax highlighting to the Custom CSS field in Customization using an available font (fonts that have syntax highlighting) or a small library.
- **Custom CSS Persistence Bugs:** Fix custom CSS persistence. Fix the bug where it sometimes doesn't apply on restart, or applies even when it was removed. **Note: Unsure if this bug still exists, as it has not been encountered since the major syncing refactor.**

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

### Rust Decoupling (Refactoring)
- Planned. Backend is still a crate-root monolith.
- Implement `.agents/rust-decoupling-plan.md`.

### Instrumentation System: Decoupled Performance Benchmarking (AHK + Python)
- After all the HTML/CSS/JS and Rust refactors are done, implement a decoupled backend instrumentation system to debug and test performance benchmarks on archive/file back-end and front-end processing.
- Connected driving system via AutoHotkey (.ahk) and Python, where the JS and Rust files automatically log data in ms about processing timings and excessive function calls (hot spots / call counts) for benchmark analysis.

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

### Web Fetching (Manga/Manwha)
- Add a webfetch capability via a standalone JS script (maybe into their own dir to keep decoupled — but only if each website needs complex fetch parsing); manga/manwha websites, etc.
- If an API exists for the target site, use it.
- Entry point: goes into the menubar File dropdown.

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
