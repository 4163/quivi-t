# QuiviT Implementation Plan

- `.agents/architecture-state.md`: current module map and verification checklist.
- `.agents/implemented.md`: shipped, verified work. Port completed slices there when they leave this plan.

## Work Plan

*Easiest and least invasive first.*

### Favorites & Bookmarks System (Medium Logic)
- **From clipboard notes (2026-08-13):**
  - Middle-click removes a favorite directly: intentionally NOT mappable to a keybind; just document it in the README Features section where favorites is covered.
  - Ordering: implement the advanced favorites next, but FIRST rename the current favorites names in JS/HTML/CSS (functions, classes, IDs) to "bookmark".
  - README: document the favorites system under Features; afterwards place the bookmark (legacy favorites) system entry under it, described simply as a bookmark that works similarly to favorites.
  - Favorites file-list remove-button (X) visibility: currently an active/highlighted item makes its X button visible; it should only be visible on hover, or when focused via Tab keyboard navigation: not merely because the item is the active selection.
- **Improve favorites system:** add a Favorites dropdown under the menu bar to load/save favorites. Consider an input for titles, only if the styling/intuitiveness of the dropdown interaction is good.
- **Separate bookmarks system (legacy favorites):** placed under the favorites section, acting like the old favorites. The JS names across both can be consolidated into the same thing: the only difference is saving/loading favorites as a favorites list.

### View, Rendering & Window Enhancements (Visuals/Features)
- **Fullscreen Focus & Shortcut Loss Fix:** Fix bug where shortcut keys (including `Escape` / `F11`) occasionally stop functioning while in fullscreen mode (e.g., when switching focus to another monitor or Alt-Tabbing away and back).
  - **Investigation Needed:** The exact trigger and root cause are unconfirmed. Candidates to test during implementation include `activeKeys` remaining latched due to missed `keyup` events during window focus switches, WebView2 losing document focus to window chrome, or Tauri fullscreen event listeners.
  - **Target Outcome:** Ensure keyboard shortcuts and `Escape` always work reliably in fullscreen mode across multi-monitor setups and focus changes.
- **Emergency Boss Key:** Add an "Emergency Button" to hide the application into the system tray, with a configurable keybind.
- **Synchronous Canvas Double-Buffer for Zero-Flicker Viewport Transitions (Future Consideration):** Evaluate replacing DOM-element image swapping with an offscreen or double-buffered WebGL / 2D canvas flip when transitioning images or rendering complex multi-image layouts. This eliminates any remaining compositor texture-upload latency at the cost of managing a unified canvas rendering pipeline. Revisit during or after Double Page View and Manga Spread implementation in the Component Library.
- **Initial HTML Loading (LCP):** Completely remove the blank page time on initial loading of both HTML pages before the main UI renders. It's currently acting this way because we are optimizing for LCP on the flickering of themes. Refer to the way LCP is handled on `E:\Projects\PixiJS Live2D Spine (Springfield)` for reference.

### CSS, Styling & Code Structure (Refactoring)
- **Persistent Root Column Sizes:** Treat CSS root column sizes as persistent data saved via WebView2. Add a reset column sizes button in the options (under General).
- **Syntax Highlighting:** Add syntax highlighting to the Custom CSS field in Customization using an available font (fonts that have syntax highlighting) or a small library.
- **Custom CSS Persistence Bugs:** Fix custom CSS persistence. Fix the bug where it sometimes doesn't apply on restart, or applies even when it was removed. **Note: Unsure if this bug still exists, as it has not been encountered since the major syncing refactor.**

### Supported Formats & Advanced Icons (Complex)
- **File Association Prompt:** Add a prompt notification at the center of the screen pointing users to the File Associations tab (reminding them that they can and should set file associations). On-boarding experinece.
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

### Documentation & GitHub (Project Health)
- **Contributing Section:** Add a contributing section to the github page, for general contributions to the project, but more on documenting how new languages should be created for the language settings.

## Post-Release Backlog (Future Considerations)

*Items deliberately deferred until after the initial release. Low priority by design: do not start without re-validating the need.*

### File List Relocation, Detach & Drag-and-Drop
- Add a way to change the location of the file list (left default, top, bottom, right). Detached as well? Maybe drag-and-droppable: how practical would the implementation be?
- Using a JS library sounds ideal; this has been done before on a smaller scale at `E:\Projects\x4163-apps\dither-app` (not sure if it's the best/most-used library: performance-first). Prioritize clean/snappy user interaction with no jank.
- Partial implementation via UI buttons (detach + move location) is acceptable pre-release; drag-and-drop capabilities should be implemented after release.

### File List Thumbnail View
- Add a thumbnail/medium view mode to the file list: image files show a medium-size preview thumbnail, non-image items (folders, archives, `..`) show a medium-size icon.
- Medium icons have a partial backend already: `get_native_icon` fetches 16×16 shell icons via `SHGFI_SMALLICON`. A medium variant would need `SHGFI_LARGEICON`/32×32: mind the documented Windows shell scaling bug that returns open-folder variants when requesting large icons downscaled (`ico.rs` already works around this).
- Image previews: reuse the existing `asset://` / `quivit://` src pipeline (`fsUtils.js` `buildArchiveSrc`) to generate thumbnails on demand; lean on the existing off-screen preloader / caching patterns.
- **Placement TBD:** the toggle-button location is unresolved: `.file-panel-actions` (the bottom action strip holding Open Explorer / Open Folder / Favorite / metadata badge) feels iffy. Alternatives to explore: a view-mode control in the file-panel header (above the column-header row), a View-menu item, or a `cmd-*` keybind like the existing view toggles.
- **Performance-first:** only load thumbnails for visible rows (lazy/virtualized), never decode full-size images for the preview, and no overhead in the normal list mode.


### Manhwa Mode (Continuous Vertical Strip)
- Automatically append pages together vertically on the same canvas page.
- Build on the preloading and image caching infrastructure, but treat continuous Manhwa rendering as its own post-release slice.
- **Active Item Synchronization:** As the user scrolls vertically through the continuous strip, dynamically track the currently visible image and keep the active item selection in the file list and status bar perfectly in sync.

### Web Fetching (Manga/Manwha)
- Add a webfetch capability via a standalone JS script (maybe into their own dir to keep decoupled: but only if each website needs complex fetch parsing); manga/manwha websites, etc.
- If an API exists for the target site, use it.
- Entry point: goes into the menubar File dropdown.

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

### UI Sound Design (Low/Last Priority)
- Add custom SFX for UI interactions (e.g. button clicks, menu toggles, opening folders, error bumps).
- Needs a toggle in the Options menu to disable sounds for users who prefer a silent experience.
- Provide a volume slider or rely on system volume.
- Audio assets should be small and fast-loading, or even script-generated (e.g. 8-bit style SFX).

### Native 7-Zip Sidecar Extraction (7Z/CB7 speed)
- **Note.** Out of scope. The original UI-blocking bug was already solved in pure Rust. The speed gap does not manifest as a real UX problem, and the sidecar adds deployment complexity plus re-introduces partial-file race concerns.

### Windows Thumbnails (APNG/WebP/AVIF)
- **Note.** Out of scope. Thumbnails would just hide the cute mascots on the icons. Thus value is really, really low.
- Add working Windows thumbnails (including preview pane) for APNG, AVIF, and animated WebP.
  - Antigravity IDE actually adds multiple things that Windows doesn't natively have, SVG thumbnails, code and MD files for the preview pane/animated thumbnail/icons. It would be great if we can support APNG/WebP files in a similar way that's practical to the project scope.

### Additional Metadata Formats
- Add support for parsing `comicinfo.json` and reading embedded EXIF/Acme tags directly from image binaries.
- Currently deferred because `ComicInfo.xml` and `metadata.opf` cover 99.9% of use-cases. If requested by users, this can be easily slotted in thanks to the decoupled metadata architecture.

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

### Instrumentation System: Test Harness
- Main job after the HTML/CSS/JS and Rust refactors: rewrite and decouple functions that have no honest test seam, then write a proper test harness covering a decent portion of QuiviT's functions.
- For each behavior worth keeping, write a targeted cargo test (or extend an existing one) that exercises the real code path and fails loud if the behavior is wrong.
- Focus on: functions, commands, and public APIs; config schema (defaults, key renames, type shifts); archive entry parsing, sort order, and cache-key logic; state machine transitions and callback contracts.
- Do not write tests for pure presentation (CSS, layout, visual rendering). Those stay on the manual verify checklist.
- Place new tests alongside existing test infrastructure (`src-tauri/src/tests/`, in-tree `#[path]` tests). If a seam has no home yet, discuss placement before inventing a new tree. Throwaway scripts are fine for fixture generation, environment probes, or one-off coverage sweeps. They are not the harness.
- Run `cargo test` in `src-tauri`. Fix the implementation or the test. Do not proceed with failing tests.
- **Skill allocation.** The harness work belongs on the next branch inside `diagnose`. One explicit skill. Same lock style as `update-architecture-state`.
- **Scope boundary.** `blast-radius` stays "prove this change did not break a consumer." It does not build the harness.
- **Deferred, after the harness exists.** Do not start Python instrumentation in the same slice as the rewrite. Once the cargo tests cover a decent portion of the app, add JS and Rust timing and call-count logs (processing time in ms, hot spots / call counts). Python then drives the benches and collects the output. `diagnose` still owns that later slice. Trigger on "it's slow," "it's flaky," or "measure X."
