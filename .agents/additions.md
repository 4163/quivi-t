# QuiviT Implementation Plan

- `.agents/architecture-state.md`: current module map and verification checklist.

## Work Plan

*Easiest and least invasive first.*

## Post-Release Backlog (Future Considerations)

*Items deliberately deferred until after the initial release. Low priority by design: do not start without re-validating the need.*

### File List and Viewport Relocation & Detach
- Add menubar submenus under `View` for `File List >` and `Viewport >` with options `Left`, `Right`, `Top`, `Bottom`, and `Detached`.
- Positions default to `Left` (File List) and `Right` (Viewport).
- Positions are mutually exclusive: selecting a position for one element automatically updates the other to maintain a balanced layout.
- `Detached` mode opens a dedicated Tauri window for the selected element (falling back to the `window.open()` API for the planned web build), avoiding third-party docking or drag-and-drop JS libraries.

### Update Availability Indicator
- Add a lightweight GitHub releases check on startup that displays an update notice in the `.menubar-spacer` area (right-aligned, pointing toward the GitHub button).
- When an update is available: show a sentence like "Version X.Y.Z is available: you are X versions behind" inside the menubar spacer. Temporarily reroute the GitHub button to the releases page for that session.
- No auto-download or auto-install: this intentionally avoids an auto-update system, which is out of scope and conflicts with the portable-first goals.
- Fail silently when offline or rate-limited.
- **Important:** Must be implemented and tested after the first actual release is published on GitHub, otherwise there's nothing to compare against.

### PDF Document Support
- Treat PDF files as navigatable multi-page containers.
- Use a lightweight viewer overlay (matching existing overlay patterns like password and import) to indicate multi-page navigation and show the first page as a preview, keeping interaction clear without unnecessary complexity.

### Animated Frame Timeline
- **Note.** Impractical. Animated media spans multiple disparate pipelines in QuiviT: WebCodecs `ImageDecoder` under WebGL filters, native `<img>` decoding, HTML5 `<video>`, and continuous vertical Manhwa slots. A frame scrubber requires frame extraction, seeking synchronizers, and playback state tracking across all these paths, introducing extreme complexity and regression risk for an image viewer.
- Add a frame timeline bar at the bottom of the canvas viewer for animated formats (WebP, APNG, GIF, SVG, and other supported animated formats).
- **Reference:** https://sourceforge.net/projects/gifviewer/: match its visual style and interaction model.
- **Controls:**
  - Play/pause button.
  - Frame count indicator (`X / Y`).
  - Draggable scrubber bar to seek through frames.
  - Keyboard navigable via arrow keys and tab navigation.
  - Existing `cmd-next` / `cmd-prev` keybinds should tie into frame stepping when an animated file is active.
- **Layout:** Sits at the bottom of the canvas viewer (not full-width of the window). Height should always match `#file-panel-actions` via a shared CSS variable so it stays visually consistent.
- **Performance-first:** Snappy interaction with minimal delay, and only activate timeline logic when an animated format is active with zero overhead for static images.

### Documentation & GitHub (Project Health)
- **Contributing Guide:** Add a general contributing guide (`CONTRIBUTING.md`) based on the active architecture state and repository guidelines at the time of writing.

### Favorites List Reorder
- Allow manual reorder of items in each favorites loadout (Favorites, Bookmarks, and the rest) with a grip SVG handle and Sortable-based drag. Order persists through the existing `favoritesStore.js` save path with `filePanel.js` staying the sole list owner. Keep add, remove, and loadout switching as is, with a keyboard accessible fallback.

## Out of Scope

### Thumbnail Item Grid Mode
- Keep thumbnail view as a virtualized list. A true wrapped item grid stays out of scope. It adds too much complexity for the O(1) file list and thumbnail virtualization in `filePanel.js` for little practical gain.

### Native 7-Zip Sidecar Extraction (7Z/CB7 speed)
- The original UI-blocking bug was already solved in pure Rust. The speed gap does not manifest as a real UX problem, and the sidecar adds deployment complexity plus re-introduces partial-file race concerns.

### Windows Thumbnails / Previews (APNG/WebP/AVIF)
- Add working Windows thumbnails (including preview pane) for APNG, AVIF, and animated WebP.
- Thumbnails would just hide the cute mascots format icons.
- Conflicts with system shell extensions like Microsoft PowerToys.

### Other Platform Support
- Cross-platform desktop support is replaced by the planned QuiviT Web build (component library). Native desktop builds remain strictly focused on Windows APIs (`SHGetFileInfoW`, registry associations, portable configuration, explorer integration, and WebView2).
