# QuiviT

> *Pronounced similarly to the word 'pivot' lol*

<p align="center">
  <img src="icons/quivi-t_moe-2.svg" alt="QuiviT mascot" width="25%" />
</p>

A lightweight standalone (performance-first*) port of Quivi, built with Tauri and Vanilla HTML/CSS/JS. View static images and animated formats like WebP, APNG, AVIF, and GIF, including direct support for archive files (ZIP/CBZ, RAR/CBR, etc.).

## Quivi

Quivi is an image viewer specialized for comic and manga reading, with fast file browsing and compressed archive support.

- Original project: [Quivi](http://quivi.sourceforge.net/)
- Later continuation/fork: [qazmlpok/quivi](https://github.com/qazmlpok/quivi) (used as reference)

## Features

- **Formats**: Open images (`jpg`, `jpeg`, `png`, `gif`, `webp`, `apng`, `avif`, `svg`, `bmp`, `ico`) and archives (`zip`, `cbz`, `rar`, `cbr`, `7z`, `cb7`, `cbt`, `tar`).
- **Archives**: Read compressed files directly as folders, including image navigation and archive metadata.
- **Navigation**: Browse images, folders, archives, and drives with keyboard or mouse, including parent-folder and session-only Back/Forward history.
- **Viewer Controls**: Zoom, pan, rotate, flip, change fit modes, pan with the scroll wheel, and zoom with `Ctrl`+wheel.
- **Scaling**: Choose from Pixelated, Bilinear, and Lanczos scaling.
- **Filters**: WebGL filters for Anime4K (Mode A Fast/HQ), CRT (scanlines, barrel distortion, chromatic aberration), Phosphor (dot-matrix), or Scanlines.
- **Shortcuts**: Customize keyboard combos, mouse buttons, double-click gestures, and scroll-wheel actions.
- **Persistent State**: Persists favorites, single-instance handoff, optional auto-open behavior, and the last opened image.
- **Windows Integration**: Use native file/folder icons and register file associations per-user for Windows Default Apps.
- **Configuration**: Choose roaming user config or portable config stored next to the executable.
- **Custom Theming**: Inject and live-reload custom CSS rules, with native light/dark mode support.
- **ICO Spritesheets**: Render multi-frame `.ico` files as generated spritesheets.
- **Archive Resilience**: Skip corrupted or unsupported entries without freezing. Legacy CJK filename encodings (like Shift-JIS) are automatically decoded for ZIP and TAR archives.
- **Performance**: Fast O(1) virtualized rendering handles folders and archives with thousands of items instantly. Native shell icons are cached to eliminate UI pop-in.

## Shortcuts & Controls

The shortcut engine supports simultaneous multi-key combinations (e.g. `A + B`), native mouse inputs (`MouseMiddle`, `MouseForward`), double-click gestures (`DoubleClick`), and scroll-wheel capture with modifiers (`Ctrl+ScrollUp`). All keybinds can be configured dynamically in the Options menu with built-in conflict highlighting.

> Table lists only mapped defaults. You can assign keybinds to unmapped actions in **Options**.

| Action | Default Shortcut(s) |
|---|---|
| **Navigation** | |
| Next item | `Shift+D` / `Shift+ArrowRight` / `Shift+S` / `Shift+ArrowDown` |
| Previous item | `Shift+A` / `Shift+ArrowLeft` / `Shift+W` / `Shift+ArrowUp` |
| History back | `Alt+A` / `Alt+W` / `Alt+ArrowLeft` / `Alt+ArrowUp` / `MouseBack` |
| History forward | `Alt+D` / `Alt+S` / `Alt+ArrowRight` / `Alt+ArrowDown` / `MouseForward` |
| Parent directory | `Backspace` |
| Open next / previous directory | `Ctrl+X` / `Ctrl+Z` |
| **View** | |
| Fit none | `R` / `DoubleClick` |
| Fit width / height | `Shift+Q` / `Shift+E` |
| Fit window | `Shift+F` |
| Fit width / height if larger | `Q` / `E` |
| Fit window if larger | `F` |
| **Scaling Method** | |
| Scale: Previous / Next | `[` / `]` |
| **Zoom** | |
| Zoom in / out | `C` / `Z` |
| Zoom in / out (Scroll) | `Ctrl+ScrollUp` / `Ctrl+ScrollDown` |
| Zoom 100% | `X` |
| **Pan** | |
| Pan (Drag) | `MouseLeft` / `MouseMiddle` / `Space` |
| Pan up / left / down / right | `W` / `A` / `S` / `D` / `ArrowUp` / `ArrowLeft` / `ArrowDown` / `ArrowRight` |
| Pan up / down (Scroll) | `ScrollUp` / `ScrollDown` |
| Pan left / right (Scroll) | `Shift+ScrollUp` / `Shift+ScrollDown` |
| **Rotation** | |
| Rotate counter-clockwise / clockwise | `G` / `H` |
| Flip horizontal / vertical | `V` / `B` |
| **Window & UI** | |
| Options | `5` |
| Toggle file list | `1` |
| Toggle menu bar | `2` |
| Toggle status bar | `3` |
| Full screen | `4` / `Alt+Enter` |
| Exit full screen (Hold) | `Escape` |
| **Files & Folders** | |
| Open directory... | `Ctrl+O` |
| Open file/archive... | `Ctrl+Shift+O` |
| Refresh | `6` / `Ctrl+R` |

## Custom CSS

QuiviT supports injecting custom CSS rules to fully theme the application via **Options → Customization → Custom CSS**. Changes can be previewed by clicking `Apply` or pressing `Ctrl+S` while editing.

**Example:**
```css
html {
  font-size: 20px;
}
:root {
  --bg:           #f4ecdc;
  --surface:      #faf5e9;
  --text:         #4a3826;
  --accent:       #7a5c3e;
  --accent-hover: #634a32;
  --selected-bg:  #e6d9bd;
  --hover-bg:     #eee2c9;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg:           #241e17;
    --surface:      #2e261c;
    --text:         #e8dcc4;
    --accent:       #c9a870;
    --accent-hover: #d9bc88;
    --selected-bg:  #3d3322;
    --hover-bg:     #332b1f;
  }
}
:root[data-theme="dark"] {
  --bg:           #241e17;
  --surface:      #2e261c;
  --text:         #e8dcc4;
  --accent:       #c9a870;
  --accent-hover: #d9bc88;
  --selected-bg:  #3d3322;
  --hover-bg:     #332b1f;
}

 ̶/̶*̶ ̶b̶r̶i̶c̶k̶s̶ ̶t̶h̶e̶ ̶U̶I̶ ̶d̶o̶n̶'̶t̶ ̶d̶o̶ ̶t̶h̶i̶s̶ ̶l̶o̶l̶ ̶*̶/̶
̶*̶ ̶{̶
̶ ̶ ̶d̶i̶s̶p̶l̶a̶y̶:̶ ̶n̶o̶n̶e̶ ̶!̶i̶m̶p̶o̶r̶t̶a̶n̶t̶;̶
̶}̶
```

**Developer Tools:** Inspect Element is intentionally left enabled to help users create and debug custom CSS.

**Example themes:** Try the included `matcha-latte.css` and `sage-mint.css` example themes: import them from **Options → Customization** to restyle the app.

> If a broken CSS rule makes the user interface unusable, press `Ctrl+Shift+Alt+C` in any QuiviT window. This emergency reset instantly removes the custom CSS and reloads the interface safely.

## Changelog

See the [Releases](../../releases) page for version history and release notes.

## Documentation

### System Defaults

The following system defaults are used:

- **Fit Mode:** `height-if-larger`. All fit modes align tall pages to the top rather than the center while keeping smaller images centered, depending on the mode/image size. This makes page-to-page navigation more intuitive.
- **Scaling Mode:** `bilinear`
- **Filters:** Defaults to none active, only one filter can be active at a time. SVGs are rasterized at a capped resolution (2048px static, 512px animated); Anime4K and Lanczos fall back to Bilinear for SVGs.
- **Filter: Anime4K** Defaults to `fast` (upstream Mode A Fast). Configurable in **Options → General → Filters**.
- **Pan Steps:** Keyboard panning defaults to 72px per step, and wheel panning defaults to 120px per step. Both are configurable in **Options → General → Panning**.
- **Scroll-wheel Modifier:** Defaults to `hold` (hold `Ctrl` while scrolling to zoom). Can be switched to `toggle` (sticky `Ctrl`). A status-bar badge shows whether scroll zoom is latched or which bound modifier keys are currently held.
- **Window Title:** The OS title bar shows the current image: `filename.ext (current/total) ◦ container ◦ QuiviT` for archive pages and `filename.ext (current/total) ◦ QuiviT` for folder pages. Page count is image-only and natural-ascending, independent of the active sort.
- **Secondary Windows:** Options and Archive Info windows size to their content and open centered over the main window.
- **Shell Background:** The native window background mirrors the page's `--surface` color, so overriding it in custom CSS also updates the shell behind the webview.
- **History Trail:** Menu bar **Folder → Back / Forward** (`Alt`+arrow / `Alt+A/W` / `Alt+D/S`, plus `MouseBack` / `MouseForward`) tracks container-level navigation only: opening folders, archives, and drives. Selecting images or pages *within* a container and refreshing never create entries. The trail is session-only and capped at 100 entries.
- **Missing Path Recovery:** When the last-opened path no longer exists at startup, or the active folder/archive is deleted or moved while browsing, QuiviT falls back to the nearest existing ancestor, or the Drives view at the root.
- **Single Instance:** Enabled by default. External file opens are handed off to the active session. Toggling this setting on or off requires an app restart to take effect.
- **Default Sort:** `name` ascending. Per-directory preferences are cached for up to 100 directories, with the oldest dropped first. The global default is configurable in `quivit_config.json` under `frontend_data` as `default_sort` (`col`: `name`, `ext`, or `date`; `desc`: `false` = ascending, `true` = descending). Directories without a saved preference in `quivit_directory_sort.json` fall back to it.
- **Image Swap Buffer:** The DOM viewer keeps a decoded previous image visible while the next target image loads, then waits for a short 45ms settled-navigation window before committing the swap. This is an intentional WebView2/HTML `<img>` tradeoff: it slightly delays final activation during rapid navigation, but prevents visible blank-frame flicker that can occur when very large images are decoded, uploaded, or repainted by the browser.

### Configuration & Persistence

QuiviT manages data across three distinct tiers depending on lifecycle and scope:

**Roaming files (source of truth)**: stored in Tauri's app config directory:
`C:\Users\<user>\AppData\Roaming\com.x4163.quivit`

Data is split across five files:
- `quivit_config.json`: User preferences (theme, keybinds, fit/scaling, scroll-wheel modifier, default sort, options)
- `quivit_state.json`: Runtime state (`last_opened_path`, `last_active_image`, `scroll_zoom_latched`)
- `quivit_directory_sort.json`: Per-directory sort column/direction
- `quivit_favorites.json`: Favorited folders/files and collapsed state
- `custom_css.css`: Custom CSS source text

**WebView2 localStorage**: never the source of truth; used only as a fast cache layer:
- `quivit-theme` / `quivit-custom-css`: Pre-paint mirrors so the theme and custom CSS apply before first render (prevents flicker)
- `options-active-tab`: Session-only; cleared on each app start

**In-memory state**: session-only; reset on app exit:
- `navigationHistory`: Container-level Back/Forward history trail (capped at 100 entries)
- `ArchiveCache`: Recent archive working set. ZIP/CBZ entries use a byte-budgeted in-memory image cache (default 512 MB) and background prefetch queue; RAR/CBR, 7Z/CB7, and TAR/CBT archives keep temporary extraction state for up to 8 recently opened archives.
- `#viewer-img-wrapper` image bridge: Two reusable DOM images for the current target and decoded previous image; nearby pages warm through off-DOM preloaders after navigation settles behind the 45ms image swap buffer
- `previewTheme` / `previewCss`: Options window live theme and custom CSS previews (persisting across config reloads until Apply or Close)

**Portable Mode** can be enabled via **Options → Save config data locally**. QuiviT uses one config shape at a time: roaming mode uses the four split files above, while portable mode folds those values into a single self-contained `quivit_config.json` next to the executable. Switching modes migrates the active values into the destination shape so stale files are not treated as competing sources of truth. In portable mode, the top-level `hidden` flag controls the Windows hidden attribute on that local `quivit_config.json`: `true` hides it, and `false` leaves it visible. The attribute is synced on every app launch and on each config save; edits made to the JSON while QuiviT is running are overwritten by the in-memory state on the next save.

### Architecture

The frontend is split into a state machine, pure services, and single-owner UI modules that talk through `Core.onStateChange` instead of writing each other's DOM:

- `core.js`: App state and configuration. No DOM.
- `services/`: Pure domain: `actions.js` (`ACTION_REGISTRY` / `dispatch`), key combos, keybind rules, sorting, viewer math. Filter logic lives in `filters/`, scaling in `scaling/`, and the WebGL runtime/catalog in `pipelines/`.
- `shared/`: Cross-window theme/CSS apply, pre-paint injector, config preview / emergency reset, window fit.
- `viewer/`: Facade plus render pool, overlay canvas owner (`viewerPipelines.js`), and pan gestures. Zoom/pan/fit math lives in `services/viewerMath.js`.
- `filepanel/`: File list (virtualized), columns, breadcrumb, resize. Favorites persistence is `favoritesStore.js`.
- `menubar/`: Chrome visibility and the sole `#statusbar` writer. `menubar.js` owns dropdown interaction.
- `main/`: Thin bootstrap (`main.js`) plus fullscreen, dropzone, lifecycle, metadata badge.
- `options/`: Options window, keybind capture UI, file-association UI.
- `fsUtils.js`: Filesystem and archive navigation (no DOM).
- `shortcuts.js` / `keybinds.js`: Input dispatch and config merge. Action ids come from `ACTION_REGISTRY`.

CSS follows the same split: `global.css` holds tokens and shared rules; `main.css`, `options.css`, and `metadata.css` are page-only.

The Rust backend is split into domain-specific modules:

- `lib.rs` & `main.rs`: Bootstrap, config watcher, and main-window build.
- `config.rs`: `AppConfig`, persistence, portable mode, and pending promotion.
- `commands/`: Tauri command surface (directory, archives, watcher, associations, shell).
- `archives/` & `formats.rs`: Archive readers, `ArchiveCache`, and format registry.
- `platform/` & `windows.rs`: OS-level integrations, dialogs, and window lifecycle.
- `tests/`: In-tree testing for archives, config, formats, and protocol.
- `protocol.rs`: `quivit://` and `asset://` handler logic.
- `ico.rs`: ICO spritesheets.
- `models.rs`: IPC structs and data models.
- `utils.rs`: Base64 and encoding helpers.

> **Design Principle:** New DOM belongs in the module that already owns that surface. New domain logic belongs in `core.js` or `services/`. Do not grow `main.js` back into a god file.

### File Associations (Windows)

**Options → File Types** registers image and archive formats with QuiviT. Registration is per-user (no admin rights required): it writes `HKCU\Software\Classes` ProgIDs, dumps format icons to the roaming config directory, and registers QuiviT as an app in **Windows Settings → Default Apps**. The "Open Windows Default Apps Settings" button deep-links straight to QuiviT's entry.

Checkboxes reflect whether QuiviT is the active default handler for each format, reading the `UserChoice` registry key first and falling back to the `Classes` registration.

> **Note on Windows 10/11 defaults:** A format's active default handler lives in the `UserChoice` registry key, which is hash-protected and cannot be written programmatically. A format with no existing `UserChoice` becomes QuiviT's once registered: double-click opens it directly. For formats already claimed by another program, registering only adds QuiviT as an *available* handler; Windows surfaces it automatically via the "How do you want to open this file?" picker when such a file is opened, OR the default can be changed permanently there, via "Open with", or in Windows Settings.

### Command-Line Interface

QuiviT accepts paths passed via the command line. When single-instance mode is enabled (default), secondary launches hand off their arguments to the primary instance. Toggling single-instance in Options requires a restart to take effect.

```bash
quivit.exe "C:\Path\To\Archive.cbz"
```

## Development & Installation

**Prerequisites:**
- [Node.js](https://nodejs.org/) (for `npm`)
- [Rust](https://www.rust-lang.org/) (Cargo)

Install dependencies and run the Tauri development build:
```bash
npm install
npm run tauri dev
```

Run backend and frontend syntax checks:
```bash
cd src-tauri && cargo check
node --check src/js/main/main.js
node --check src/js/options/options.js
# etc.
```

## Stack

| Component | Technology | Purpose |
|---|---|---|
| **Runtime** | Tauri 2 | Desktop application framework |
| **Backend** | Rust | Core logic and filesystem operations |
| **Frontend** | Vanilla HTML/CSS/JS | ES modules-based user interface |
| **Desktop Webview** | WebView2 | Native Windows web rendering |
| **Lanczos Scaling** | `pica` | Off-thread still-image Lanczos resize |
| **WebGL Filters** | WebGL2 | Anime4K, CRT, Phosphor, Scanlines, and per-frame Lanczos on animated images |
| **Animated Decode** | WebCodecs `ImageDecoder` | Frame-accurate GIF/WebP/APNG/AVIF playback under filters and Lanczos |
| **Archives (ZIP/CBZ)** | `zip` | Fast on-demand extraction |
| **Archives (RAR/CBR)** | `unrar` | Legacy archive support |
| **Archives (7Z/CB7)** | `sevenz-rust2` | Solid LZMA archive support |
| **Archives (TAR/CBT)** | `tar` | Uncompressed archive reading |
| **Character Encoding** | `encoding_rs` | Shift-JIS/CP932 decoding for legacy ZIP filenames |
| **Sorting** | `natord` | Natural alphanumeric sorting |
| **Config** | `serde` / `serde_json` | Configuration serialization |
| **File Watching** | `notify` | Directory watcher for auto-refresh |
| **ICO Extraction** | `image` | Multi-frame ICO spritesheet generation |
| **Hashing** | `md5` | Deterministic temp directory naming |
| **Data URIs** | `base64` | Base64 encoding for generated image payloads |
| **Windows APIs** | `windows` / `winreg` | Native icons, file attributes, shell notifications, and per-user file associations |
| **Tauri Plugins** | `opener`, `dialog`, `single-instance` | System integration (explorer, pickers, handoff) |
| **Frontend Tauri API** | `@tauri-apps/api` / `@tauri-apps/plugin-dialog` | Browser-side IPC, asset URLs, and native file dialogs |

## Project Structure

```text
QuiviT/
├─ src/
│  ├─ index.html                 # Main viewer window
│  ├─ options.html               # Options window
│  ├─ metadata.html              # Archive metadata window
│  ├─ css/
│  │  ├─ global.css              # Tokens, resets, rules shared by every page
│  │  ├─ main.css                # Viewer / file-panel layout
│  │  ├─ options.css             # Options window layout
│  │  └─ metadata.css            # Metadata window layout
│  └─ js/
│     ├─ core.js                 # State machine (no DOM)
│     ├─ directoryPrefs.js       # Per-directory sort prefs
│     ├─ fsUtils.js              # Filesystem / archive navigation
│     ├─ keybinds.js             # Config merge + pan/zoom defaults
│     ├─ keyboardNav.js          # List / tab keyboard navigation
│     ├─ menubar.js              # Menu bar dropdown interaction
│     ├─ metadata.js             # ComicInfo / CoMet / OPF parsing
│     ├─ metadata-window.js      # Metadata window controller
│     ├─ navigationHistory.js    # Session-only Back/Forward
│     ├─ shellBackground.js      # Mirrors --surface into the native window
│     ├─ shortcuts.js            # Keyboard / mouse / wheel dispatch
│     ├─ filepanel/
│     │  ├─ filePanel.js         # File list, columns, breadcrumb, resize
│     │  └─ favoritesStore.js    # Favorites persistence (no DOM)
│     ├─ main/
│     │  ├─ main.js              # Bootstrap + slim state fan-out
│     │  ├─ fullscreen.js        # Fullscreen UX
│     │  ├─ dropzone.js          # Drag-and-drop
│     │  ├─ lifecycle.js         # Title, flush-on-close, single-instance
│     │  └─ metadataBadge.js     # Archive-info badge
│     ├─ menubar/
│     │  ├─ chrome.js            # Menu / status visibility
│     │  └─ statusbar.js         # Sole #statusbar writer
│     ├─ options/
│     │  ├─ options.js           # Options window orchestration
│     │  ├─ keybindUi.js         # Keybind capture / conflicts
│     │  └─ associationsUi.js    # File-type association UI
│     ├─ services/
│     │  ├─ actions.js           # ACTION_REGISTRY + dispatch
│     │  ├─ filterModules.js     # Filter module resolution
│     │  ├─ keyCombo.js          # Combo normalize / format
│     │  ├─ keybindDomain.js     # Locked binds, conflicts, categories
│     │  ├─ registry.js          # Filter and scaling definitions
│     │  ├─ sorting.js           # naturalCompare / applySort
│     │  ├─ viewerMath.js        # Zoom / pan / fit math
│     │  ├─ filters/
│     │  │  ├─ anime4k.js        # Anime4K filter definition
│     │  │  ├─ crt.js            # Retro CRT filter definition
│     │  │  ├─ phosphor.js       # Phosphor dot-matrix filter definition
│     │  │  ├─ scanlines.js      # Simple scanlines filter definition
│     │  │  └─ anime4k/          # Anime4K WebGL shader chains
│     │  ├─ pipelines/
│     │  │  ├─ glCommon.js       # WebGL utility and shader compilation functions
│     │  │  └─ glRuntime.js      # Filter pipeline orchestrator and quad renderer
│     │  └─ scaling/
│     │     ├─ lanczos.js        # Off-thread Pica/Canvas2D Lanczos scaling
│     │     └─ lanczosWebGL.js   # Real-time WebGL Lanczos for animated images
│     ├─ shared/
│     │  ├─ theme.js             # applyTheme / applyCustomCss
│     │  ├─ themePrePaint.js     # Synchronous pre-paint injector
│     │  ├─ blobImage.js         # Shared ImageBitmap cache for origins
│     │  ├─ configPreview.js     # Live preview + emergency CSS reset
│     │  └─ windowFit.js         # Options / metadata content fit
│     ├─ vendors/
│     │  └─ pica.js              # High quality image resizing
│     └─ viewer/
│        ├─ viewer.js            # Facade
│        ├─ viewerRender.js      # Image pool + transforms
│        ├─ viewerPipelines.js   # Overlay canvas and WebGL owner
│        └─ viewerGestures.js    # Pan input
├─ src-tauri/
│  ├─ capabilities/
│  │  └─ default.json            # Tauri permissions for main/options/metadata windows
│  ├─ icons/                     # Application icons
│  ├─ src/
│  │  ├─ archives/               # Archive readers, caching, and extraction
│  │  ├─ commands/               # Tauri command surface and watchers
│  │  ├─ platform/               # OS-level integrations, dialogs, and shell icons
│  │  ├─ tests/                  # In-tree tests (archives, formats, protocol, config)
│  │  ├─ config.rs               # Configuration state, persistence, and portable mode
│  │  ├─ formats.rs              # Supported format registry
│  │  ├─ ico.rs                  # ICO frame extraction and spritesheet
│  │  ├─ lib.rs                  # Bootstrap, config watcher, and main-window build
│  │  ├─ main.rs                 # Native executable entry point
│  │  ├─ models.rs               # IPC structs and data models
│  │  ├─ protocol.rs             # quivit:// and asset:// handler logic
│  │  ├─ utils.rs                # Base64 and encoding helpers
│  │  └─ windows.rs              # Window lifecycle and size constants
│  ├─ Cargo.toml
│  └─ tauri.conf.json
├─ matcha-latte.css              # Example theme (bundled with the release)
├─ sage-mint.css                 # Example theme (bundled with the release)
├─ package.json
└─ README.md                     # Project overview & architecture documentation
```

## Attributions

- UI Icons: [Feather](https://feathericons.com) / [Lucide](https://lucide.dev)
- Format Icons Font: [andrew-paglinawan/QuicksandFamily](https://github.com/andrew-paglinawan/QuicksandFamily)
- Language Flags: [jdecked/Twemoji](https://github.com/jdecked/twemoji)
- WebGL Shaders: [Bloc97/Anime4K](https://github.com/bloc97/Anime4K) / [stefanlegg/crt-fx](https://github.com/stefanlegg/crt-fx) / [TheMarco/RetroZone](https://github.com/TheMarco/RetroZone) (Custom phosphor WebGL implementation) / [cgwg CRT-Geom](https://github.com/libretro/common-shaders) (Geom-inspired beam, custom WebGL implementation)
- Agent Skills: Adapted from [poteto - pstack](https://github.com/cursor/plugins/tree/main/pstack) and [mattpocock/skills](https://github.com/mattpocock/skills)
