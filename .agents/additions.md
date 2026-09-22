# QuiviT Implementation Plan

- `.agents/architecture-state.md`: current module map and verification checklist.

## Work Plan

*Easiest and least invasive first.*

### Favorites & Bookmarks System (Medium Logic)
- **From clipboard notes (2026-08-13):**
  - Middle-click removes a favorite directly: intentionally NOT mappable to a keybind; just document it in the README Features section where favorites is covered.
  - Ordering: implement the advanced favorites next, but FIRST rename the current favorites names in JS/HTML/CSS (functions, classes, IDs) to "bookmark".
  - README: document the favorites system under Features; afterwards place the bookmark (legacy favorites) system entry under it, described simply as a bookmark that works similarly to favorites.
- **Improve favorites system:** add a Favorites dropdown under the menu bar to load/save favorites. Consider an input for titles, only if the styling/intuitiveness of the dropdown interaction is good.
- **Separate bookmarks system (legacy favorites):** placed under the favorites section, acting like the old favorites. The JS names across both can be consolidated into the same thing: the only difference is saving/loading favorites as a favorites list.

### View, Rendering & Window Enhancements (Visuals/Features)
- **Fullscreen Focus & Shortcut Loss Fix:** Fix bug where shortcut keys (including `Escape` / `F11`) occasionally stop functioning while in fullscreen mode (e.g., when switching focus to another monitor or Alt-Tabbing away and back).
  - **Investigation Needed:** The exact trigger and root cause are unconfirmed. Candidates to test during implementation include `activeKeys` remaining latched due to missed `keyup` events during window focus switches, WebView2 losing document focus to window chrome, or Tauri fullscreen event listeners.
  - **Target Outcome:** Ensure keyboard shortcuts and `Escape` always work reliably in fullscreen mode across multi-monitor setups and focus changes.
- **Emergency Boss Key:** Add an "Emergency Button" to hide the application into the system tray, with a configurable keybind.
- **Initial HTML Loading (LCP):** Completely remove the blank page time on initial loading of both HTML pages before the main UI renders. It's currently acting this way because we are optimizing for LCP on the flickering of themes. Refer to the way LCP is handled on `E:\Projects\PixiJS Live2D Spine (Springfield)` for reference.

### CSS, Styling & Code Structure (Refactoring)
- **Persistent Root Column Sizes:** Treat CSS root column sizes as persistent data saved via WebView2. Add a reset column sizes button in the options (under General).
- **Syntax Highlighting:** Add syntax highlighting to the Custom CSS field in Customization using an available font (fonts that have syntax highlighting) or a small library.

### Supported Formats & Advanced Icons (Complex)
- **File Association Prompt:** Add a prompt notification at the center of the screen pointing users to the File Associations tab (reminding them that they can and should set file associations). On-boarding experinece.
- **Advanced .ico Processing:** Improve .ico processing (performance-first). Change the .ico processing and rendering spec:
  1. Add a 'ICO Spritesheet' to the view dropdown under 'opaque canvas' (make sure this is configurable in the keybinds option). Default: ON.
  2. OFF: .ico files should not be processed at all and should just act as a legacy image file. ON: .ico files should be processed.
  3. Process each .ico size as an individual image file instead of a single spritesheet.
  4. Render out each size individually in the canvas.
  5. The largest ico size is the single source of truth; this element should be the only element that has canvas bounding calculations.
  6. The remaining smaller sizes are just a shadow of the main ico element, layed out (with space between them) in the spritesheet order. This means that it follows the main ico file whilst not having any hitbox/bounding calculations.
  7. Render out the 'opaque canvas' option for every ico element.
- **Extended Format Support:** Support PSD, XCF, and PDF files (decide whether to process via JS or backend, performance-first).

### Documentation & GitHub (Project Health)
- **Contributing Section:** Add a contributing section to the github page, for general contributions to the project, but more on documenting how new languages should be created for the language settings.

## Post-Release Backlog (Future Considerations)

*Items deliberately deferred until after the initial release. Low priority by design: do not start without re-validating the need.*

### Manhwa Mode (Continuous Vertical Strip)
- Automatically append pages together vertically on the same canvas page.
- Build on the preloading and image caching infrastructure, but treat continuous Manhwa rendering as its own post-release slice.
- **Active Item Synchronization:** As the user scrolls vertically through the continuous strip, dynamically track the currently visible image and keep the active item selection in the file list and status bar perfectly in sync.

### File List Relocation, Detach & Drag-and-Drop
- Add a way to change the location of the file list (left default, top, bottom, right). Detached as well? Maybe drag-and-droppable: how practical would the implementation be?
- Using a JS library sounds ideal; this has been done before on a smaller scale at `E:\Projects\x4163-apps\dither-app` (not sure if it's the best/most-used library: performance-first). Prioritize clean/snappy user interaction with no jank.
- Partial implementation via UI buttons (detach + move location) is acceptable pre-release; drag-and-drop capabilities should be implemented after release.

### Detach Image Window
- Add the ability to pop the currently viewed image out into its own standalone window, separate from the main QuiviT UI.
- Relevant alongside Double Page View and File List Detach/Drag-and-Drop as they share the same "detach" interaction paradigm.

### Animated Frame Timeline
- Add a frame timeline bar at the bottom of the canvas viewer for animated formats (WebP, APNG, GIF, SVG? (if that's even possible, discuss practical options), and any other animated image formats supported).
- **Reference:** https://sourceforge.net/projects/gifviewer/: match its visual style and interaction model.
- **Controls:**
  - Play/pause button.
  - Frame count indicator (`X / Y`).
  - Draggable scrubber bar to seek through frames.
  - Keyboard navigatable via arrow keys and tab navigation.
  - The existing `cmd-next` / `cmd-prev` keybinds should tie into frame stepping when an animated file is active.
- **Layout:** Sits at the bottom of the canvas viewer (not full-width of the window). Height should always match `#file-panel-actions` via a shared CSS variable so it stays visually consistent. Exact width behavior TBD: full width feels off for files with few frames, so consider a constrained or content-aware width.
- **Performance-first**: snappy (not sluggish) interaction with little to no visual delays/jank (delayed responses/unresponsiveness, flickering etc.), and only activate timeline logic when an animated format is detected; no overhead for static images.

### Native 7-Zip Sidecar Extraction (7Z/CB7 speed)
- **Note.** Out of scope. The original UI-blocking bug was already solved in pure Rust. The speed gap does not manifest as a real UX problem, and the sidecar adds deployment complexity plus re-introduces partial-file race concerns.

### Windows Thumbnails (APNG/WebP/AVIF)
- **Note.** Out of scope. Thumbnails would just hide the cute mascots on the icons. Thus value is really, really low.
- Add working Windows thumbnails (including preview pane) for APNG, AVIF, and animated WebP.
  - Antigravity IDE actually adds multiple things that Windows doesn't natively have, SVG thumbnails, code and MD files for the preview pane/animated thumbnail/icons. It would be great if we can support APNG/WebP files in a similar way that's practical to the project scope.

### Embedded Image Metadata
- Add support for reading embedded EXIF/Acme tags directly from image binaries.
- JSON sidecar metadata is completed in Slice 5. This backlog item is only for metadata stored inside image files.

### Update Availability Indicator
- Add a lightweight GitHub releases check on startup that displays an update notice in the `.menubar-spacer` area (right-aligned, pointing toward the GitHub button).
- When an update is available: show a sentence like "Version X.Y.Z is available: you are X versions behind" inside the menubar spacer. Temporarily reroute the GitHub button to the releases page for that session.
- No auto-download or auto-install: this intentionally avoids an auto-update system, which is out of scope and conflicts with the portable-first goals.
- Fail silently when offline or rate-limited.
- **Important:** Must be implemented and tested after the first actual release is published on GitHub, otherwise there's nothing to compare against.

### Other Platform Support
- Currently impractical: this is a Windows-only codebase and there's no access to other devices (or OSes) for testing. A huge portion of the backend relies on Windows APIs: `SHGetFileInfoW` native icons (`ico.rs`), registry-based file associations with `UserChoice` semantics and `ms-settings:defaultapps` deep links (`commands.rs`), `SHChangeNotify`, explorer integration, the `.exe`-adjacent portable config: plus Windows-specific assumptions in the frontend (drive-root `C:\` paths, `quivit://localhost` protocol routing differences, WebView2 as the only runtime).
- **Best path forward: undecided, open question.** Candidate directions:
  - **(a) Multiple projects:** fork/split each platform into its own codebase/project. Pros: native behavior per platform, no abstraction tax. Cons: duplicated frontend/UI, double maintenance burden.
  - **(b) OS-abstraction pipeline in this codebase:** put a structure/system/pipeline in place so OS-specific API/function calls sit behind platform layers where Windows APIs are currently used directly: e.g. a Rust `platform` module/trait behind the Tauri commands (Windows impl today, stub/fallback impls for other targets) plus a JS-side capability switch, so other targets at least compile and degrade gracefully.
  - **(c) Hybrid:** abstract only where the seam is cheap (path handling, protocol routing, config locations), and keep separate projects where the gap is too large (file associations, native icons).
- Do not start this without first securing at least one non-Windows test device or CI runner: verification is impossible otherwise.
