# Use URL feature roadmap

Design discussion captured 2026-09-17. This is the agreed direction, not an implementation plan. Details marked TBD will be resolved during implementation slices.

---

## What the feature does

Ctrl+U opens an input for a URL. The app fetches the page, identifies the site, runs a matching extractor to pull out image URLs, and builds a navigable folder structure in the file panel. Images download to a persistent local directory and display through the existing viewer. The user browses remote galleries the same way they browse local folders and archives.

## Terminology

- **Extractors**: per-site JS modules that parse a page and return image URLs. Named after the convention in yt-dlp and gallery-dl. Not "vendors" (that directory holds third-party libraries like pica.js), not "providers" or "adapters."
- **Manifest**: `manifest.json` inside the `extractors/` directory at the repo root. Lists available extractors, their site-matching patterns, remote download URLs, and version numbers. Just `manifest.json` because the directory name already scopes it. The app fetches it at runtime from the GitHub raw URL.
- **Library**: the persistent on-disk directory where downloaded images live. `%LOCALAPPDATA%/QuiviT/library/`. Named by analogy with Calibre, Komga, and other media managers. Not "downloads" (too generic, doesn't convey persistence) or "temp" (this data survives restarts).
- **Orchestrator**: the main JS module that owns the Ctrl+U flow, manifest fetching, extractor loading, and download queue lifecycle. Separate from extractors, which are pure data transformers.

## Architecture

### Why extractors are JS, not JSON

A JSON schema (CSS selectors, regex patterns) breaks the moment a site has pagination, lazy-loaded content, API authentication, or non-standard markup. JS gives each extractor full flexibility. Some sites expose APIs; the extractor can call those instead of scraping HTML. The contract stays the same either way: given a URL and response data, return a list of image URLs and metadata.

### Remote extractor loading

Extractors are not shipped with the executable. A remote `manifest.json` lives at a fixed trusted URL (the project's GitHub repository). The app fetches the manifest, finds the extractor matching the user's URL by pattern, downloads that extractor's JS source via the Rust backend, and loads it in the frontend.

Loading mechanism: Rust fetches the JS source as text, returns it to the frontend, frontend wraps it in a Blob URL and uses dynamic `import()`. No `eval()`. ES module `import()` from blob URLs works in WebView2/Chromium.

Trust model: the manifest URL is hardcoded to the project's own repository. Same trust model as browser extensions auto-updating.

Extractor caching (persist to disk between sessions vs memory-only) is TBD.

### Extractor contract

Each extractor exports two functions:

- `match(url)` returns whether this extractor handles the given URL.
- `extract(html, url)` receives fetched page content and returns image URLs, titles, folder structure hints, and pagination info. No app imports, no DOM access, no side effects.

The exact return shape will be defined during implementation. The principle is that extractors are pure: data in, data out. The orchestrator handles everything else.

### CORS and the Rust HTTP proxy

The frontend runs on `https://tauri.localhost`. WebView2 enforces CORS regardless of CSP settings. Fetching arbitrary websites from the frontend is blocked.

All HTTP fetching goes through the Rust backend. Two Tauri commands:

- `fetch_text(url)` for HTML pages, the manifest, and extractor JS sources. Returns the response body as a string.
- `download_to_file(url, dest_path)` for images. Streams directly to disk on a background thread without shuttling bytes through IPC. Can report progress (bytes written) if a progress indicator is added later.

### HTTP client crate: ureq

The archive extractors already use `std::thread::spawn` for blocking work. No async runtime is used directly in the project's own code (Tauri uses tokio internally and it's in the dependency tree, but the app's commands are all synchronous). `ureq` fits this pattern: lightweight, blocking, minimal transitive dependencies. `reqwest` would pull in hyper, h2, tower, and others for no practical gain since the download queue is sequential by design.

### Module ownership

Follows AGENTS.md rules: state machine has no DOM, UI modules self-subscribe, pure domain logic lives in services, new work extends the existing layering.

| Module | Location | Responsibility |
|---|---|---|
| Orchestrator | `src/js/urlLoader.js` | Ctrl+U flow, manifest fetch, extractor selection and loading, download queue lifecycle, temp directory coordination with Rust |
| Per-site extractors | Remote, loaded on demand | Pure `{ match, extract }` functions with no app imports |
| Network commands | `src-tauri/src/commands/network.rs` | `fetch_text` and `download_to_file` Tauri commands |
| Action entry | `src/js/services/actions.js` | `cmd-use-url` with default bind `Ctrl+U`, category File Operations |
| Menu entry | `src/index.html` | Item under File dropdown, between Open file/archive and the separator before Options |

The orchestrator is a service-level module. It coordinates Rust commands, state, and extractor execution. It does not own DOM. A separate UI module (or the file panel itself) handles rendering the library section.

### Repository layout

Two categories: app code that ships in the executable, and extractor files that live at repo root for remote fetching at runtime.

**Ships with the app** (inside `src/` and `src-tauri/`, bundled via `frontendDist: "../src"` and Cargo):

- `src/js/urlLoader.js` — orchestrator: Ctrl+U flow, manifest fetching, extractor loading via blob URL import, download queue, library directory coordination
- `src-tauri/src/commands/network.rs` — `fetch_text` and `download_to_file` Tauri commands, compiled into the Rust binary
- `src/js/services/actions.js` — `cmd-use-url` action registry entry
- `src/index.html` — File menu item
- File panel library section rendering (in `filePanel.js` or a new sibling module)

**Does not ship** (repo root, fetched at runtime from GitHub raw URL):

```
extractors/
  manifest.json        <- registry listing available extractors
  danbooru.js          <- per-site extractor modules
  mangadex.js
  ...
```

Same pattern as `mocha/` and `e2e/`: lives in the repo for development, excluded from the executable because `frontendDist` only includes `src/` and `bundle.resources` only maps `themes/`. No `.taurignore` entry needed.

## Download strategy

### How it maps to existing patterns

The archive system has two extraction models:

- RAR, 7Z, TAR: extract all entries to temp on a background thread, sequentially. Entries become available as they land. Frontend waits (via condvar notification) if it requests an entry that hasn't been extracted yet.
- ZIP: on-demand. Individual entries are extracted only when requested.

URL downloading is closest to the RAR model: sequential background work where entries become available progressively. But the trigger for what to download next comes from what's visible in the file panel, not from walking the archive sequentially.

### Viewport-driven queue

Modeled after the existing thumbnail system in `filePanel.js`. The thumbnail system (`commitPendingThumbnails`) works like this:

1. Only processes rows within the viewport bounds (visible rows + `VIEWPORT_MARGIN` of 1).
2. Sorts pending items: active image first, then in scroll direction order.
3. Staggers them so the viewer's active image wins connection priority.

The URL download queue follows the same pattern:

1. The extractor runs once and returns the full image URL list. The file panel shows all entries immediately with placeholders.
2. The download queue processes images visible in the file panel + 1 buffer row on each side.
3. Downloads happen sequentially (one at a time) through the Rust backend. Each completed download writes to the library directory. The file panel row updates from placeholder to loaded.
4. The active viewer image always gets top priority regardless of file panel scroll position.
5. On jump (user navigates from image A to image G): the queue reorders. New priority is G forward (G, H, I... Z), then wrap back (F, E, D... A). But the queue still only contains entries visible in the file panel + buffer, not the entire gallery.

### Pagination

Multi-page galleries: the extractor fetches all page URLs during the initial probe, building the complete image list. That's a few KB of HTML per page, fast enough to do upfront. The heavy part (image downloads) stays viewport-driven.

## Storage

### Library directory

`%LOCALAPPDATA%/QuiviT/library/`

Shared across all QuiviT instances. No per-PID isolation (unlike the archive temp system which uses `%TEMP%/QuiviT/pid-<PID>/`). Multiple instances read from and write to the same directory.

Cross-instance sync: the existing file watcher system (`notify` crate, already used for config file watching) can watch the library directory so all open instances see new files appear dynamically.

No auto-cleanup. Downloaded content persists across restarts. The user manages their library manually via a delete button in the file panel (same pattern as the favorites remove button, `.fav-remove`).

### Folder structure

The library directory mirrors the logical structure the extractor provides:

```
library/
  <provider>/
    <gallery-title>/
      <volume>/
        <chapter>/
          001.jpg
          002.jpg
          ...
```

The exact depth and naming depends on what the extractor returns. A flat gallery (like a booru page) might be just `provider/gallery-title/001.jpg`. A manga series with volumes and chapters gets the full tree. The orchestrator builds the folder structure; the extractor describes it.

### Configurable location (later)

The Options page will have a section between Filters and Configuration Persistence. Uses the existing `.input-group` pattern (text input + Browse button) for the library path. When changed, the backend moves existing files from the old location to the new one. This is not part of the initial implementation scope.

## UX/UI

### File panel integration

The file panel gets a new collapsible section below Favorites. Structurally identical to `#file-panel-favorites`: a header with a toggle icon, a list underneath, collapse/expand on click.

Each provider is its own collapsible dropdown. Underneath, the folder tree the extractor built: gallery titles, volumes, chapters, images. Clicking a gallery entry navigates the main file list into that folder, same as clicking a favorited folder. Ordered by first-added (oldest at top, newest at bottom, within each provider section).

The existing CSS for `.file-panel-favorites`, `#file-panel-favorites-header`, and `#favorites-list` provides the styling foundation. The new section reuses the same visual language: muted uppercase header text, hover highlight, toggle arrow, border separator.

Each entry has a delete button styled after `.fav-remove` (X icon, hidden by default, visible on hover/focus, danger color on hover). Delete removes both the file panel entry and the on-disk folder.

### Ctrl+U input

The input overlay/dialog for entering a URL is TBD. Options discussed but not decided:

- Modal overlay (like the password overlay pattern)
- Inline input in the file panel header
- Small popup dialog

### State machine

`core.js` currently has modes `'empty' | 'image' | 'archive'`. A URL gallery maps to `'image'` mode with the library subfolder as the directory. The file panel needs to know it's in "library mode" to show the gallery's display names (from the extractor) instead of raw temp filenames. How this flag is tracked is TBD.

### Display names

Images on disk are numbered files (`001.jpg`, etc.) or have whatever names the source site uses. The file panel should show meaningful names from the extractor (page numbers, chapter names, original filenames from the site). This requires a display-name mapping from the orchestrator. The exact mechanism (a sidecar JSON in each folder, or an in-memory map) is TBD.

## Error handling

Handled during implementation iteration, not pre-designed. The known error states:

- No internet (can't fetch manifest or page)
- URL doesn't match any extractor
- Extractor runs but returns 0 images (site changed its structure)
- Individual image download fails mid-gallery

Each needs a user-visible response in the UI. The specifics will be decided as the UI takes shape.

## Open items

These are decisions explicitly deferred, not forgotten:

- Extractor caching: persist to disk between sessions, or memory-only?
- Ctrl+U input surface: modal, inline, or popup?
- State machine integration: new mode, flag on existing mode, or derived from directory path?
- Display name mechanism: sidecar JSON or in-memory map?
- Options page section for library path (later, not initial scope)
- Manifest hosting URL (GitHub raw, CDN, or self-hosted)
- Registry/manifest versioning and update checking frequency
