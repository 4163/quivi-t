# QuiviT

> *Pronounced similarly to the word 'pivot' lol*

<p align="center">
  <img src="icons/quivi-t_moe-mascot.svg" alt="QuiviT mascot" width="25%" />
</p>

A lightweight standalone (performance-first*) port of Quivi, built with Tauri and Vanilla HTML/CSS/JS. View static images and animated formats like WebP, APNG, and GIF, including direct support for archive files (ZIP/CBZ, RAR/CBR, etc.).

## Quivi

Quivi is an image viewer specialized for comic and manga reading, with fast file browsing and compressed archive support.

- Original project: [Quivi](http://quivi.sourceforge.net/)
- Later continuation/fork: [qazmlpok/quivi](https://github.com/qazmlpok/quivi) (used as reference)

## Features

- **Formats**: Open images (`jpg`, `jpeg`, `png`, `gif`, `webp`, `apng`, `svg`, `bmp`, `ico`, `avif`) and archives (`zip`, `cbz`, `rar`, `cbr`, `7z`, `cb7`, `cbt`, `tar`).
- **Archives**: Read compressed files directly as folders, including image navigation and archive metadata.
- **Navigation**: Browse images, folders, archives, and drives with keyboard or mouse, including parent-folder and session-only Back/Forward history.
- **Viewer Controls**: Zoom, pan, rotate, flip, change fit modes, pan with the scroll wheel, and zoom with `Ctrl`+wheel.
- **Shortcuts**: Customize keyboard combos, mouse buttons, double-click gestures, and scroll-wheel actions.
- **Persistent State**: Persists favorites, single-instance handoff, optional auto-open behavior, and the last opened image.
- **Windows Integration**: Use native file/folder icons and register file associations per-user for Windows Default Apps.
- **Configuration**: Choose roaming user config or portable config stored next to the executable.
- **Custom Theming**: Inject and live-reload custom CSS rules.
- **ICO Spritesheets**: Render multi-frame `.ico` files as generated spritesheets.

## Shortcuts & Controls

The shortcut engine supports simultaneous multi-key combinations (e.g. `A + B`), native mouse inputs (`MouseMiddle`, `MouseForward`), double-click gestures (`DoubleClick`), and scroll-wheel capture with modifiers (`Ctrl+ScrollUp`). All keybinds can be configured dynamically in the Options menu with built-in conflict highlighting.

| Action | Default Shortcut |
|---|---|
| Toggle file list | `1` |
| Toggle menu bar | `2` |
| Toggle status bar | `3` |
| Full screen | `4` / `Alt+Enter` |
| Options | `5` |
| Refresh | `6` / `Ctrl+R` |
| Parent directory | `Backspace` |
| Open directory... | `Ctrl+O` |
| Open file/archive... | `Ctrl+Shift+O` |
| Open next/previous directory | `Ctrl+X` / `Ctrl+Z` |
| History back | `Alt+A` / `Alt+W` / `Alt+ArrowLeft` / `Alt+ArrowUp` / `MouseBack` |
| History forward | `Alt+D` / `Alt+S` / `Alt+ArrowRight` / `Alt+ArrowDown` / `MouseForward` |
| Next item | `Shift+D` / `Shift+ArrowRight` / `Shift+S` / `Shift+ArrowDown` |
| Previous item | `Shift+A` / `Shift+ArrowLeft` / `Shift+W` / `Shift+ArrowUp` |
| Zoom in / out | `C` / `Z` |
| Zoom in / out (Scroll) | `Ctrl+ScrollUp` / `Ctrl+ScrollDown` |
| Zoom 100% | `X` |
| Fit width / height if larger | `Q` / `E` |
| Pan (Drag) | `MouseLeft` / `MouseMiddle` / `Space` |
| Pan (Up / Left / Down / Right) | `W` / `A` / `S` / `D` / `ArrowUp` / `ArrowLeft` / `ArrowDown` / `ArrowRight` |
| Pan up / down | `ScrollUp` / `ScrollDown` |
| Pan left / right | `Shift+ScrollUp` / `Shift+ScrollDown` |
| Rotate counter-clockwise / clockwise | `G` / `H` |
| Flip horizontal / vertical | `V` / `B` |
| Fit none | `R` / `DoubleClick` |
| Fit width / height | `T` / `Y` |
| Auto fit | `F` |
| Cycle scaling mode | `[` / `]` |

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

**Example themes:** Try the included `matcha-latte.css` and `sage-mint.css` example themes — import them from **Options → Customization** to restyle the app without writing any CSS.

> If a broken CSS rule makes the user interface unusable, press `Ctrl+Shift+Alt+C` in any QuiviT window. This emergency reset instantly removes the custom CSS and reloads the interface safely.

## Changelog

See the [Releases](../../releases) page for version history and release notes.

## Documentation

### System Defaults

The following system defaults are used:

- **Fit Mode:** `height-if-larger`. All fit modes align tall pages to the top rather than the center while keeping smaller images centered, depending on the mode/image size. This makes page-to-page navigation more intuitive.
- **Scaling Mode:** `bicubic`
- **Pan Steps:** Keyboard panning defaults to 72px per step, and wheel panning defaults to 120px per step. Both are configurable in Options → General → Panning.
- **Scroll-wheel Modifier:** Defaults to `hold` (hold `Ctrl` while scrolling to zoom). Can be switched to `toggle` (sticky `Ctrl`). A status-bar badge reflects the active state — `Scroll Zoom — Toggled` while latched in toggle mode, or the bound modifier(s) you're holding (`Ctrl — Held`, `Shift — Held`, `Ctrl+Shift — Held`) when they change scroll behavior.
- **Window Title:** The OS title bar shows the current image: `filename.ext (current/total) ◦ container ◦ QuiviT` for archive pages and `filename.ext (current/total) ◦ QuiviT` for folder pages. Page count is image-only and natural-ascending, independent of the active sort.
- **Default Sort:** `name` ascending. Per-directory preferences are cached for up to 100 directories, with the oldest dropped first. The global default is configurable in `quivit_config.json` under `frontend_data` as `default_sort` (`col`: `name`, `ext`, or `date`; `desc`: `false` = ascending, `true` = descending). Directories without a saved preference in `quivit_directory_sort.json` fall back to it.
- **History Trail:** Menu bar **Folder → Back / Forward** (`Alt`+arrow / `Alt+A/W` / `Alt+D/S`, plus `MouseBack` / `MouseForward`) tracks container-level navigation only — opening folders, archives, and drives. Selecting images or pages *within* a container and refreshing never create entries. The trail is session-only and capped at 100 entries.
- **Shell Background:** The native window background mirrors the page's `--surface` color, so overriding it in custom CSS also updates the shell behind the webview.
- **Secondary Windows:** Options and Archive Info windows size to their content and open centered over the main window.
- **Missing Path Recovery:** When the last-opened path no longer exists at startup, or the active folder/archive is deleted or moved while browsing, QuiviT falls back to the nearest existing ancestor — or the Drives view at the root.
- **Single Instance:** Enabled by default. External file opens are handed off to the active session. Toggling this setting on or off requires an app restart to take effect.
- **Image Swap Buffer:** The DOM viewer keeps a decoded previous image visible while the next target image loads, then waits for a short 45ms settled-navigation window before committing the swap. This is an intentional WebView2/HTML `<img>` tradeoff: it slightly delays final activation during rapid navigation, but prevents visible blank-frame flicker that can occur when very large images are decoded, uploaded, or repainted by the browser.
- **Archive Resilience:** Corrupted or inaccessible archives are reported without freezing the viewer, and navigation skips unsupported archive entries when they cannot be opened. Legacy ZIP filename encodings are decoded for regional archives, including Shift-JIS (CP932) and other CJK code pages.

### Configuration & Persistence

QuiviT manages data across three distinct tiers depending on lifecycle and scope:

**Roaming files (source of truth)** — stored in Tauri's app config directory:
`C:\Users\<user>\AppData\Roaming\com.x4163.quivit`

Data is split across five files:
- `quivit_config.json` — User preferences (theme, keybinds, fit/scaling, scroll-wheel modifier, default sort, options)
- `quivit_state.json` — Runtime state (`last_opened_path`, `last_active_image`, `scroll_zoom_latched`)
- `quivit_directory_sort.json` — Per-directory sort column/direction
- `quivit_favorites.json` — Favorited folders/files and collapsed state
- `custom_css.css` — Custom CSS source text

**WebView2 localStorage** — never the source of truth; used only as a fast cache layer:
- `quivit-theme` / `quivit-custom-css` — Pre-paint mirrors so the theme and custom CSS apply before first render (prevents flicker)
- `options-active-tab` — Session-only; cleared on each app start

**In-memory state** — session-only; reset on app exit:
- `navigationHistory` — Container-level Back/Forward history trail (capped at 100 entries)
- `ArchiveCache` — Recent archive working set. ZIP/CBZ entries use a byte-budgeted in-memory image cache (default 512 MB) and background prefetch queue; RAR/CBR, 7Z/CB7, and TAR/CBT archives keep temporary extraction state for up to 8 recently opened archives.
- `#viewer-img-wrapper` image bridge — Two reusable DOM images for the current target and decoded previous image; nearby pages warm through off-DOM preloaders after navigation settles behind the 45ms image swap buffer
- `previewTheme` / `previewCss` — Options window live theme and custom CSS previews (persisting across config reloads until Apply or Close)

**Portable Mode** can be enabled via **Options → Save config data locally**. QuiviT uses one config shape at a time: roaming mode uses the four split files above, while portable mode folds those values into a single self-contained `quivit_config.json` next to the executable. Switching modes migrates the active values into the destination shape so stale files are not treated as competing sources of truth. In portable mode, the top-level `hidden` flag controls the Windows hidden attribute on that local `quivit_config.json`: `true` hides it, and `false` leaves it visible.

### Architecture

The frontend is intentionally split into small, decoupled ES modules:
- `core.js` — Single source of truth for app state and configuration
- `fsUtils.js` — Filesystem and backend interaction
- `navigationHistory.js` — Session-only container Back/Forward history
- `viewer.js` — Image viewport logic (zoom, pan, fit, rotation, flips)
- `shortcuts.js` / `keybinds.js` — Input normalization and action dispatch
- `filePanel.js` / `menubar.js` / `options.js` — UI component wiring

> **Design Principle:** When behavior starts to grow inside `main.js`, prefer moving the domain logic into a focused module and leaving `main.js` as the bridge between DOM events and state/actions.

### File Associations (Windows)

**Options → File Types** registers image and archive formats with QuiviT. Registration is per-user (no admin rights required): it writes `HKCU\Software\Classes` ProgIDs, dumps format icons to the roaming config directory, and registers QuiviT as an app in Windows Settings → Default Apps. The "Open Windows Default Apps Settings" button deep-links straight to QuiviT's entry.

Checkboxes reflect whether QuiviT is the active default handler for each format, reading the `UserChoice` registry key first and falling back to the `Classes` registration.

> **Note on Windows 10/11 defaults:** A format's active default handler lives in the `UserChoice` registry key, which is hash-protected and cannot be written programmatically. A format with no existing `UserChoice` becomes QuiviT's once registered — double-click opens it directly. For formats already claimed by another program, registering only adds QuiviT as an *available* handler; Windows surfaces it automatically via the "How do you want to open this file?" picker when such a file is opened, OR the default can be changed permanently there, via "Open with", or in Windows Settings.

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
node --check src/js/main.js
node --check src/js/options.js
# etc.
```

## Stack

| Component | Technology | Purpose |
|---|---|---|
| **Runtime** | Tauri 2 | Desktop application framework |
| **Backend** | Rust | Core logic and filesystem operations |
| **Frontend** | Vanilla HTML/CSS/JS | ES modules-based user interface |
| **Desktop Webview** | WebView2 | Native Windows web rendering |
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
│  ├─ index.html              # Main viewer window
│  ├─ options.html            # Options window
│  ├─ metadata.html           # Archive metadata window
│  ├─ css/
│  │  ├─ main.css             # Viewer layout and shared theme tokens
│  │  ├─ options.css          # Options window layout
│  │  └─ metadata.css         # Metadata window layout
│  └─ js/
│     ├─ associationsUi.js    # File-type association UI (Options)
│     ├─ core.js              # Central app state and config management
│     ├─ directoryPrefs.js    # Persistent per-directory grouping and sorting
│     ├─ filePanel.js         # File list rendering, sorting UI, resizing, favorites
│     ├─ fsUtils.js           # Filesystem and Rust backend interaction
│     ├─ keyboardNav.js       # Accessible keyboard navigation (Tab/Home/End)
│     ├─ keybindUi.js         # Keybind configuration grid and conflicts
│     ├─ keybinds.js          # Default shortcuts and config merge helpers
│     ├─ main.js              # DOM wiring for the main window
│     ├─ menubar.js           # Main window menu bar DOM wiring
│     ├─ metadata-window.js   # Metadata window live-sync controller
│     ├─ navigationHistory.js # Session-only container Back/Forward stacks
│     ├─ options.js           # Options window DOM wiring and width auto-fit
│     ├─ shellBackground.js   # Mirrors --surface into the native window background
│     ├─ shortcuts.js         # Shortcut matching and keyboard dispatch
│     └─ viewer.js            # Image viewport, zoom, fit, pan, rotation, flips
├─ src-tauri/
│  ├─ capabilities/
│  │  └─ default.json         # Tauri permissions for main/options/metadata windows
│  ├─ icons/                  # Application icons
│  ├─ src/
│  │  ├─ archives.rs          # Archive extraction and caching
│  │  ├─ commands.rs          # Tauri commands and directory watcher
│  │  ├─ config.rs            # Configuration state, window sizes, window fit/center commands
│  │  ├─ ico.rs               # ICO frame extraction and spritesheet
│  │  ├─ lib.rs               # Module definitions, app entry, main-window construction
│  │  ├─ main.rs              # Native executable entry point
│  │  ├─ models.rs            # Data structures and structs
│  │  └─ utils.rs             # Supported formats and helpers
│  ├─ Cargo.toml
│  └─ tauri.conf.json
├─ matcha-latte.css           # Example theme (bundled with the release)
├─ sage-mint.css              # Example theme (bundled with the release)
├─ package.json
└─ README.md                  # Project overview & architecture documentation
```

## Attributions

- Icons: [Flaticon (Cosplayer, Webp, Gif, Cbz, Cbr, Svg)](https://www.flaticon.com)
- Language Flags: [jdecked/Twemoji](https://github.com/jdecked/twemoji)
