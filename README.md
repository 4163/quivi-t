# QuiviT

> *Pronounced similarly to the word 'pivot' lol*

<p align="center">
  <img src="icons/quivi-t_moe-mascot.svg" alt="QuiviT mascot" width="25%" />
</p>

A modern standalone (performance-first) port of Quivi, built with Tauri and Vanilla HTML/CSS/JS. View static images and animated formats like WebP, APNG, and GIF, including direct support for archive files (ZIP/CBZ, RAR/CBR, etc.).

## Quivi

Quivi is an image viewer specialized for comic and manga reading, with fast file browsing and compressed archive support.

- Original project: [Quivi](http://quivi.sourceforge.net/)
- Later continuation/fork: [qazmlpok/quivi](https://github.com/qazmlpok/quivi) (used as reference)

## Features

- **Broad Format Support**: Open images (`jpg`, `jpeg`, `png`, `gif`, `webp`, `apng`, `svg`, `bmp`, `ico`, `avif`) and archives (`zip`, `cbz`, `rar`, `cbr`, `7z`, `cb7`, `cbt`, `tar`).
- **Archive Integration**: Reads compressed files directly, treating them as standard folders. Supports seamless image navigation within and across archives.
- **High-Performance Caching**: Instant archive listing via header-only reads. Hybrid caching strategy uses an in-memory LRU cache with background prefetch for ZIP/CBZ, and non-blocking asynchronous disk extraction for solid archives (7Z/RAR).
- **Advanced Navigation**: Browse siblings with keyboard or mouse. Jump seamlessly to previous/next directories, archives, and root drives following the active sort order. Parent directory navigation (`..`) and session-only Back/Forward history are natively supported.
- **Customizable Controls**: High-quality zooming, panning, rotation, and flipping. Includes scroll-wheel panning with `Ctrl`+wheel zoom (manga-friendly), plus a sticky-Ctrl toggle mode.
- **Advanced Shortcuts**: Fully customizable keybindings supporting multi-key combos, native mouse inputs, double-click gestures, and scroll-wheel capture with conflict highlighting.
- **Persistent States**: Configurable favorites system, single-instance handoff, optional auto-open first image, and restoration of the last active image.
- **System Integration**: Uses native Windows file/folder icons (with opacity for hidden items). Registers file associations per-user, appearing natively in Windows Default Apps.
- **Configuration Modes**: Supports global (least-privileged user) or portable (single config) configuration storage.
- **Custom Theming**: Inject and live-reload custom CSS rules to fully theme the application.

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
| Next item | `Shift+D` / `Shift+Right` / `Shift+S` / `Shift+Down` |
| Previous item | `Shift+A` / `Shift+Left` / `Shift+W` / `Shift+Up` |
| Pan up / down | `ScrollUp` / `ScrollDown` |
| Zoom in / out | `Ctrl+ScrollUp` / `Ctrl+ScrollDown` |
| Zoom in / out (Keys) | `C` / `Z` |
| Zoom 100% | `X` |
| Fit width / height if larger | `Q` / `E` |
| Pan (Up/Left/Down/Right) | `W` / `A` / `S` / `D` or Arrow Keys |
| Rotate counter-clockwise/clockwise | `G` / `H` |
| Flip horizontal/vertical | `V` / `B` |
| Fit none | `R` / `DoubleClick` |
| Fit width / height | `T` / `Y` |
| Auto fit | `F` |
| Cycle scaling mode | `[` / `]` |

## Custom CSS

QuiviT supports injecting custom CSS rules to fully theme the application (available in the Options menu under Customization). You can instantly save and apply these rules using `Ctrl+S` while editing.

**Example:**
```css
:root {
  --surface: #dfe0df !important;
  --accent: #00ad95 !important;
  --accent-hover: #007662 !important;
}

html {
  font-size: 20px !important;
}

 ̶/̶*̶ ̶b̶r̶i̶c̶k̶s̶ ̶t̶h̶e̶ ̶U̶I̶ ̶d̶o̶n̶'̶t̶ ̶d̶o̶ ̶t̶h̶i̶s̶ ̶l̶o̶l̶ ̶*̶/̶
̶*̶ ̶{̶
̶ ̶ ̶d̶i̶s̶p̶l̶a̶y̶:̶ ̶n̶o̶n̶e̶ ̶!̶i̶m̶p̶o̶r̶t̶a̶n̶t̶;̶
̶}̶
```

**Developer Tools:** Inspect Element is intentionally left enabled in release builds to help create and debug custom CSS.

> Since the shell behind the webview mirrors `--surface`, overriding it also updates the native window background to match.

> [!TIP]
> If a broken CSS rule makes the user interface unusable, press `Ctrl+Shift+Alt+C` in any QuiviT window. This emergency reset instantly removes the custom CSS and reloads the interface safely.

## Documentation

### System Defaults

The following system defaults are used:

- **Fit Mode:** `height-if-larger`. All fit modes align tall pages to the top rather than the center while keeping smaller images centered, depending on the mode/image size. This makes page-to-page navigation more intuitive.
- **Scaling Mode:** `bicubic`
- **Keyboard Pan Step:** `VIEWER_KEYBOARD_PAN_STEP` (100px).
- **Scroll-wheel Modifier:** Defaults to `hold` (hold `Ctrl` while scrolling to zoom). Can be switched to `toggle` (sticky `Ctrl`) in Options.
- **Archive Caching (ZIP/CBZ):** In-memory LRU cache holds up to 20 images. Background prefetch loads 7 images ahead and 3 images behind the current position.
- **Per-Directory Sort Cache:** Sort column/direction preferences are kept for up to 100 directories (oldest dropped first).
- **History Trail:** Folder menu **Back/Forward** (and `Alt`+arrow / `Alt+A/W` / `Alt+D/S`, plus `MouseBack` / `MouseForward`) tracks container-level navigation only — opening folders, archives, and drives. Selecting images or pages *within* a container and refreshing never create entries. The trail is session-only and capped at 100 entries.
- **Single Instance:** Enabled by default. External file opens are handed off to the active session.

### Configuration & Persistence

QuiviT persists data through two separate mechanisms:

**Roaming files (source of truth)** — stored in Tauri's app config directory:
`C:\Users\<user>\AppData\Roaming\com.x4163.quivit`

Data is split across four files:
- `quivit_config.json` — User preferences (theme, keybinds, fit/scaling, scroll-wheel modifier, custom CSS, options)
- `quivit_state.json` — Runtime state (`last_opened_path`, `last_active_image`, `scroll_zoom_latched`)
- `quivit_directory_sort.json` — Per-directory sort column/direction
- `quivit_favorites.json` — Favorited folders/files and collapsed state

**WebView2 localStorage** — never the source of truth; used only as a fast cache layer:
- `quivit-theme` / `quivit-custom-css` — Pre-paint mirrors of config so the theme and custom CSS apply before first render (prevents flicker)
- `options-active-tab` — Session-only; cleared on each app start

**Portable Mode** can be enabled via **Options → Save config data locally**. QuiviT uses one config shape at a time: roaming mode uses the four split files above, while portable mode folds those values into a single self-contained `quivit_config.json` next to the executable. Switching modes migrates the active values into the destination shape so stale files are not treated as competing sources of truth.

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

Options → File Types registers image and archive formats with QuiviT. Registration is per-user (no admin rights required): it writes `HKCU\Software\Classes` ProgIDs, dumps format icons to the roaming config directory, and registers QuiviT as an app in Windows Settings → Default Apps. The "Open Windows Default Apps Settings" button deep-links straight to QuiviT's entry.

Checkboxes reflect whether QuiviT is the active default handler for each format, reading the `UserChoice` registry key first and falling back to the `Classes` registration.

> **Note on Windows 10/11 defaults:** A format's active default handler lives in the `UserChoice` registry key, which is hash-protected and cannot be written programmatically. A format with no existing `UserChoice` becomes QuiviT's once registered — double-click opens it directly. For formats already claimed by another program, registering only adds QuiviT as an *available* handler; Windows surfaces it automatically via the "How do you want to open this file?" picker when such a file is opened, and the default can be changed permanently there, via "Open with", or in Windows Settings.

### Command-Line Interface

QuiviT accepts paths passed via the command line. When single-instance mode is enabled (default), secondary launches hand off their arguments to the primary instance.

```bash
quivit.exe "C:\Path\To\Archive.cbz"
```

## Changelog
See the [Releases](../../releases) page for version history and release notes.

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
| **Sorting** | `natord` | Natural alphanumeric sorting |
| **Config** | `serde` / `serde_json` | Configuration serialization |
| **File Watching** | `notify` | Directory watcher for auto-refresh |
| **ICO Extraction** | `image` | Multi-frame ICO spritesheet generation |
| **Hashing** | `md5` | Deterministic temp directory naming |
| **Tauri Plugins** | `opener`, `dialog`, `single-instance` | System integration (explorer, pickers, handoff) |

## Project Structure

```text
QuiviT/
├─ src/
│  ├─ index.html              # Main viewer window
│  ├─ options.html            # Options window
│  ├─ css/
│  │  ├─ main.css             # Viewer layout and shared theme tokens
│  │  └─ options.css          # Options window layout
│  └─ js/
│     ├─ core.js              # Central app state and config management
│     ├─ directoryPrefs.js    # Persistent per-directory grouping and sorting
│     ├─ filePanel.js         # File list rendering, sorting UI, resizing, favorites
│     ├─ fsUtils.js           # Filesystem and Rust backend interaction
│     ├─ keyboardNav.js       # Accessible keyboard navigation (Tab/Home/End)
│     ├─ keybinds.js          # Default shortcuts and config merge helpers
│     ├─ keybindUi.js         # Keybind configuration grid and conflicts
│     ├─ main.js              # DOM wiring for the main window
│     ├─ menubar.js           # Main window menu bar DOM wiring
│     ├─ navigationHistory.js # Session-only container Back/Forward stacks
│     ├─ options.js           # Options window DOM wiring
│     ├─ shortcuts.js         # Shortcut matching and keyboard dispatch
│     └─ viewer.js            # Image viewport, zoom, fit, pan, rotation, flips
├─ src-tauri/
│  ├─ capabilities/
│  │  └─ default.json         # Tauri permissions for main/options windows
│  ├─ icons/                  # Application icons
│  ├─ src/
│  │  ├─ archives.rs          # Archive extraction and caching
│  │  ├─ commands.rs          # Tauri commands and directory watcher
│  │  ├─ config.rs            # Configuration state and app settings
│  │  ├─ ico.rs               # ICO frame extraction and spritesheet
│  │  ├─ lib.rs               # Module definitions and app entry point
│  │  ├─ main.rs              # Native executable entry point
│  │  ├─ models.rs            # Data structures and structs
│  │  └─ utils.rs             # Supported formats and helpers
│  ├─ Cargo.toml
│  └─ tauri.conf.json
├─ package.json
└─ README.md
```

## Attributions

- Icons: [Flaticon (Cosplayer, Webp, Gif, Cbz, Cbr, Svg)](https://www.flaticon.com)
- Language Flags: [jdecked/Twemoji](https://github.com/jdecked/twemoji)
