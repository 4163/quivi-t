# QuiviT

> *Pronounced similarly to the word 'pivot' lol*

<p align="center">
  <img src="icons/quivi-t_moe-2.svg" alt="QuiviT mascot" width="25%" />
</p>

A lightweight standalone (performance-first*) port of Quivi, built with Tauri using vanilla web technologies. View raster images, vectors, and animated formats, including direct support for archive files.

## Quivi

Quivi is an image viewer specialized for comic and manga reading, with fast file browsing and compressed archive support.

- Original project: [Quivi](http://quivi.sourceforge.net/)
- Later continuation/fork: [qazmlpok/quivi](https://github.com/qazmlpok/quivi) (used as reference)

## Features

- **Formats**: Open raster, vector, and animated images, as well as common archive formats.
- **Archives**: Read compressed files directly as folders, including password-protected archives and archive metadata.
- **Navigation**: Browse images, folders, archives, and drives with keyboard or mouse, including parent-folder and session-only Back/Forward history.
- **Web Import**: Import manga and galleries from supported sites for offline reading (see [Supported sites](#supported-sites)).
- **Viewer Controls**: Zoom, pan, rotate, flip, change fit modes, pan with the scroll wheel, and zoom with `Mod`+wheel. Cursor auto-hides after inactivity over the viewport.
- **Manga Spread Mode**: Two-page reading mode for landscape scans with RTL/LTR reading order and half-width fit.
- **Scaling**: Choose from Pixelated, Bilinear, and Lanczos scaling.
- **Filters**: WebGL filters for Anime4K (Mode A Fast/HQ), CRT (scanlines, barrel distortion, chromatic aberration), Phosphor (dot-matrix), or Scanlines.
- **Shortcuts**: Customize keyboard combos, mouse buttons, double-click gestures, and scroll-wheel actions.
- **Persistent State**: Persists favorites, URL Library content and location, single-instance handoff, optional auto-open behavior, and the last opened image.
- **Windows Integration**: Drag and drop supported files to open them. Register file associations per-user for Windows Default Apps. Native window dragging supports PowerToys FancyZones snapping.
- **Configuration**: Choose roaming user config or portable config stored next to the executable, and move the shared URL Library to an existing empty folder.
- **Custom Theming**: Inject and live-reload custom CSS rules, with native light/dark mode support.
- **ICO Spritesheets**: Render multi-frame `.ico` files as generated spritesheets.
- **File Panel**: Switchable list and thumbnail view modes with virtualized card grid layout, Favorites, and provider-organized URL Library galleries.
- **Performance**: Fast O(1) virtualized rendering handles folders and archives with thousands of items instantly. Caching native shell icons and thumbnails eliminates UI pop-in.

> QuiviT is strictly an image/manga reader for the time being. Zero-flicker navigation, WebGL shader filtering (including Lanczos) are already implemented and optimized for video formats, but general local video playback is intentionally deferred. Video playback is currently only enabled for galleries from provider-specific sites.

## Supported sites

Import a URL via **File → Open URL...**.

- **Direct images.** Any direct image links.
- **Imgur.** Supports MP4 videos, galleries, direct image/video links.
- **MangaDex.** Series, chapters, art, direct cover links.
- **MANGA Plus.** Series, chapters, direct cover/thumbnail links.
- **K MANGA.** Series, chapters, direct thumbnail links.

[Contribute](#web-imports) to add support for other sites.

## Shortcuts & Controls

The shortcut engine supports simultaneous multi-key combinations (e.g. `A + B`), native mouse inputs (`MouseMiddle`, `MouseForward`), double-click gestures (`DoubleClick`), and scroll-wheel capture with modifiers (`Ctrl+ScrollUp`). All keybinds can be configured dynamically in the Options menu with built-in conflict highlighting.

> Table lists only mapped defaults. You can assign keybinds to unmapped actions in **Options → Keys**.

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
| Mute viewer audio | `M` |
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
| Rotate counterclockwise / clockwise | `G` / `H` |
| Flip horizontal / vertical | `V` / `B` |
| **Window & UI** | |
| Options | `5` |
| Toggle file list | `1` |
| Toggle menu bar | `2` |
| Toggle status bar | `3` |
| Fullscreen | `4` / `Alt+Enter` |
| Exit fullscreen (Hold) | `Escape` |
| **File Operations** | |
| Open directory | `Ctrl+O` |
| Open File / Archive | `Ctrl+Shift+O` |
| Open URL | `Ctrl+I` |
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

Developer Tools (inspect element) is intentionally left enabled to help users create and debug custom CSS.

Try the included `matcha-latte.css` and `sage-mint.css` themes under [`themes/`](themes/). Import them from **Options → Customization** to restyle the app.

> If a broken CSS rule makes the user interface unusable, press `Ctrl+Shift+Alt+C` in any QuiviT window. This emergency reset instantly removes the custom CSS and reloads the interface safely.

## Changelog

See the [Releases](../../releases) page for version history and release notes.

## Documentation

### System Defaults

What QuiviT ships with. The id in backticks is the value stored in config.

- **Fit mode.** `height-if-larger`. Portrait pages always starts at the top of the viewport, to preserve top-down manga reading. Smaller images stays centered.
- **Scaling.** `bilinear`. Scaling is ignored for vector images. `Lanczos` uses the `pica` vendor for still images, and WebGL for videos and animated images.
- **Filters.** `Off`. Filters are also ignored for vector images. Vectors (SVG) are drawn as a bitmap, static ones capped at 2048px, while animated ones are capped at 512px.
- **Anime4K.** `fast` (upstream Mode A Fast). The visual difference between Mode A and HQ is insignificant, but can still be configured. **Options → General → Filters**.
- **Scroll-wheel modifier.** `hold`. Hold `Ctrl` and scroll to zoom. `toggle` latches `Ctrl`. The status bar shows the latch, or which modifier keys are held.
- **Pan steps.** Keyboard `72px` per step, wheel `120px` per step. **Options → General → Panning**.
- **Cursor auto-hide.** `2` seconds with no movement over the viewport. `0` disables auto-hide. **Options → General → Viewport**.
- **Window title.** `filename.ext (current/total) ◦ container ◦ QuiviT` for archive pages. While folder pages omit the container. The count is images only, natural ascending, and ignores the active file list sort.
- **Secondary windows.** Options and Archive Info size to their content and open centered on the main window.
- **Shell background.** The native window shell background copies CSS var `--surface`.
- **History.** **Folder → Back / Forward** (`Alt+arrow`, `Alt+A`, `Alt+W`, `Alt+D`, `Alt+S`, `MouseBack`, `MouseForward`) navigation tracks folders, archives, or drives. Session only, capped at 100.
- **Library location.** `%LOCALAPPDATA%\QuiviT\library`. **Options → General → Library location** dynamically moves the imported folders in session.
- **Library deletion.** Deleting a Library folder or image from the file panel sends it to the Recycle Bin rather than permanently deleting them.
- **Missing path.** A  missing path, folder or archive, or deleted directories while the app is open, falls the user back to the nearest existing ancestor, or the Drives view at the root.
- **Single instance.** `Enabled`. Files opened are handed to the active window session. Requires an app restart for changes to take effect.
- **Default sort.** `name`, ascending. Per-directory sort is kept for 100 folders, oldest dropped first. The global default is configurable in `quivit_config.json` under `frontend_data` as `default_sort`.
- **Video audio.** A video with audio starts muted at 50% volume. Volume and unmute states are session only.
- **Thumbnails.** <abbr title="JPG, JPEG, PNG, BMP, ICO, MP4, static GIF">`SHELL_THUMBNAIL_EXTS`</abbr> files load together from the 96x96 OS thumbnail cache. While archive thumbnails, and non-shell images decode at full-size, one at a time for the visible rows, plus one buffer row. The file list performance drops significantly for such cases, so maybe don't use Thumbnail View if the performance hinders navigation.
- **Image swap.** The previous image stays up while the next loads, then the swap waits `45ms` after navigation settles. That avoids a blank frame when WebView2 decodes a large `<img>`. The delay is a Tauri and WebView2 tradeoff, for the time being it stays but hopefully it can be cut down further in the future.

### Configuration & Persistence

QuiviT keeps its own data in three places. Imported galleries sit in a fourth folder, under local app data.

**Config files.** By default these live in `C:\Users\<user>\AppData\Roaming\com.x4163.quivit`:

- `quivit_config.json`: preferences. theme, keybinds, fit and scaling, sort, spread, library location, and the rest of options.
- `quivit_state.json`: last opened path, last image, and whether scroll-zoom is latched.
- `quivit_directory_sort.json`: sort column and direction for each folder.
- `quivit_favorites.json`: favorites.
- `custom_css.css`: custom CSS.

**Options → Save config data locally** turns on portable mode. QuiviT writes one `quivit_config.json` beside the exe, which moves the current roaming settings into it. In the portable file, the `hidden` flag hides the file using the Windows hidden attribute: `true`. QuiviT applies that attribute on every launch, so it should only be edited while the app is not running.

**WebView2 localStorage.** A mirror of the theme and custom CSS, so the first paint can use them before the config files load to prevent LCP issues. It also holds Library collapse and provider order, cached file icons, the active Options tab, and the short-lived Archive Info handoff. The Options tab (and similar none persistent items) should be cleared on each launch.

**In memory, until quit.** The Back/Forward list, unlocked archive passwords, per-file mute and volume, and the archive pages currently held open. A theme or CSS preview in Options stays on screen until you **Apply**.

**Imports.** **File → Open URL** saves galleries under `%LOCALAPPDATA%\QuiviT\library`. **Options → General → Library location** moves that folder. Pick an empty writable folder and QuiviT copies the current library into it.

### Architecture

Module map: [`.agents/architecture-state.md`](.agents/architecture-state.md).
Development guidelines: [`.agents/AGENTS.md`](.agents/AGENTS.md).

### Web Imports

Imports galleries and images from supported websites directly into the local Library.

QuiviT checks the [`extractors`](https://github.com/4163/quivi-t/tree/extractors) branch for website support at runtime, caching modules under `%LOCALAPPDATA%\QuiviT\extractor-cache` for offline use. That registry lists supported sites and authoring documentation.

### File Associations (Windows)

**Options → File Types** lists the image and archive formats QuiviT can open. Check the ones you want and apply.

Clicking **Apply** registers QuiviT for the formats you selected. If changes does not reflect on Windows, right-click the specific file and choose **Open with**, and pick QuiviT. Or use the **Windows Defaults Settings** button, and choose specific file formats via **Choose default apps by file type**.

### Command-Line Interface

QuiviT accepts paths passed via the command line. When single-instance mode is enabled (default), secondary launches hand off their arguments to the primary instance. Toggling single-instance in Options requires a restart to take effect.

```bash
quivit.exe "C:\Path\To\Archive.cbz"
```

## Development & Installation

**Prerequisites:** [Node.js](https://nodejs.org/) and [Rust](https://www.rust-lang.org/) (Cargo).

```bash
npm install
npm run tauri dev     # Historical; bypasses isolation and touches roaming data
npm run dev           # Launch with isolated settings (.dev-config)
npm run dev:portable  # Forces portable mode (single-file layout) in .dev-config, regardless of frontend config state
```

Tests and syntax checks:

```bash
npm run mocha                                    # Frontend unit tests
npm run e2e                                      # Desktop end-to-end tests (portable layout)
npm run e2e:split                                # Desktop end-to-end tests (split layout)
cargo test --manifest-path src-tauri/Cargo.toml  # Rust tests
cd src-tauri && cargo check                      # Rust compile check
node --check src/js/main/main.js                 # Syntax-check a JS file
```

### Action recorder and replay diagnostics

Record a user interaction trace to `e2e/scenarios/<scenario>.json` (defaults to `last-recording.json`):

```bash
npm run record
npm run record -- --scenario flicker-bmp --path test-files/webp
```

Click **Start** on the floating badge, reproduce the behavior, then click **Stop**, press `Escape`, or close the window.

Replay the trace to evaluate blank frames, image pool races, WebGL readiness, and IPC timing:

```bash
npm run diagnose
npm run diagnose -- flicker-bmp --pause 300
npm run diagnose -- --inspect
```

`npm run replay` is an alias for `npm run diagnose`. Diagnostic reports are written to `e2e/replay-diagnostics/reports/`. Replay settings persist in `e2e/.debug-config` and can be reset with `npm run record -- --fresh`.

For automated iterative probing, see [`.agents/skills/replay-debugging/SKILL.md`](.agents/skills/replay-debugging/SKILL.md).

## Stack

| Component | Technology | Purpose |
|---|---|---|
| **Runtime** | [Tauri 2](https://tauri.app) | Desktop app shell |
| **Backend** | [Rust](https://www.rust-lang.org) | Files, archives, and settings |
| **Frontend** | Vanilla HTML/CSS/JS | The windows |
| **Desktop Webview** | [WebView2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/) | Renders those windows on Windows |
| **Frontend Tauri API** | [`@tauri-apps/api`](https://www.npmjs.com/package/@tauri-apps/api) / [`@tauri-apps/plugin-dialog`](https://www.npmjs.com/package/@tauri-apps/plugin-dialog) | Calls into Rust, file URLs, and the native open dialog |
| **Tauri Plugins** | [`opener`](https://crates.io/crates/tauri-plugin-opener), [`dialog`](https://crates.io/crates/tauri-plugin-dialog), [`single-instance`](https://crates.io/crates/tauri-plugin-single-instance) | Explorer, folder pickers, and single-instance handoff |
| **Unit Testing** | [`mocha`](https://mochajs.org) | Frontend unit tests |
| **E2E Testing** | [WebdriverIO](https://webdriver.io) ([`@wdio/tauri-service`](https://www.npmjs.com/package/@wdio/tauri-service)) | Tests against the running app |
| **Replay Diagnostics** | [WebdriverIO](https://webdriver.io) / In-Browser Probes | Replays a recording and checks frames, WebGL, and IPC timing |
| **Animated Decode** | WebCodecs [`ImageDecoder`](https://developer.mozilla.org/en-US/docs/Web/API/ImageDecoder) | GIF, WebP, APNG, and AVIF playback under filters |
| **Video Playback** | HTML5 [`<video>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video) / [`<audio>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/audio) | MP4 playback, filters, and soundtrack detection |
| **Lanczos Scaling** | [`pica`](https://www.npmjs.com/package/pica) | Lanczos resize for still images, off the UI thread |
| **WebGL Filters** | [WebGL2](https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext) | Anime4K, CRT, Phosphor, Scanlines, and animated Lanczos |
| **Archives (ZIP/CBZ)** | [`zip`](https://crates.io/crates/zip) | Read ZIP entries, including passwords |
| **Archives (RAR/CBR)** | [`unrar`](https://crates.io/crates/unrar) | Read RAR entries, including passwords |
| **Archives (7Z/CB7)** | [`sevenz-rust2`](https://crates.io/crates/sevenz-rust2) | Read 7Z entries, including passwords |
| **Archives (TAR/CBT)** | [`tar`](https://crates.io/crates/tar) | Read TAR archives |
| **Character Encoding** | [`chardetng`](https://crates.io/crates/chardetng) / [`encoding_rs`](https://crates.io/crates/encoding_rs) | Shift-JIS, GBK, EUC-KR, and Big5 names in ZIP and TAR |
| **Image Processing** | [`image`](https://crates.io/crates/image) | ICO spritesheets, and descrambling for protected gallery images |
| **SVG Sanitization** | [DOMPurify](https://github.com/cure53/DOMPurify) | Cleans an imported SVG before saving it |
| **Windows APIs** | [`windows`](https://crates.io/crates/windows) / [`winreg`](https://crates.io/crates/winreg) | Icons, thumbnails, file attributes, associations, and matching a temp extract back to its archive |
| **Sorting** | [`natord`](https://crates.io/crates/natord) | Natural sort, so 2 comes before 10 |
| **File Watching** | [`notify`](https://crates.io/crates/notify) | Refresh when a folder changes |
| **Network** | [`ureq`](https://crates.io/crates/ureq) | Gallery downloads and extractor fetches |
| **Config** | [`serde`](https://serde.rs) / [`serde_json`](https://crates.io/crates/serde_json) | Reads and writes the config files |
| **Hashing** | [`md5`](https://crates.io/crates/md5) | Stable names for temporary extract folders |
| **Data URIs** | [`base64`](https://crates.io/crates/base64) | Encodes generated images for the UI |

## Project Structure

```text
QuiviT/
├─ e2e/                           # Desktop tests and recorded replays
│  ├─ helpers/                    # Shared test setup
│  ├─ pageobjects/                # How a test finds each window
│  ├─ replay-diagnostics/         # Replay a recording and time it
│  │  ├─ base.js                  # Checks that run inside the window
│  │  ├─ cli.js                   # npm run diagnose
│  │  ├─ runner.e2e.js            # Plays one scenario
│  │  ├─ probes/                  # Frame, viewer, and IPC checks
│  │  └─ reports/                 # Diagnose output
│  ├─ scenarios/                  # Saved recordings
│  └─ specs/                      # End-to-end test scripts
├─ mocha/                         # Frontend unit tests, outside src/
│  ├─ actions.test.js             # Shortcuts and commands
│  ├─ cache.test.js               # Size-capped caches
│  ├─ core.test.js                # App state changes
│  ├─ diagnosticsContract.test.js # Recording and probe contracts
│  ├─ metadata.test.js            # Comic and gallery metadata
│  ├─ sorting.test.js             # Archive sort order
│  ├─ urlLoader.test.js           # URL import rules
│  ├─ urlLoaderFlows.test.js      # URL import flows
│  └─ viewerMath.test.js          # Zoom, pan, fit, and spread
├─ scripts/                       # Dev and test runner scripts
│  ├─ dev.js                      # npm run dev with isolated config
│  └─ e2e.js                      # npm run e2e with layout selection
├─ extractors/ (orphan branch)    # Site support, fetched while the app runs
├─ src/
│  ├─ index.html                  # Main window
│  ├─ options.html                # Options
│  ├─ metadata.html               # Archive Info
│  ├─ assets/                     # Format icons, flags, metadata icons
│  ├─ css/
│  │  ├─ global.css               # Shared colors and type
│  │  ├─ main.css                 # Main window layout
│  │  ├─ options.css              # Options layout
│  │  └─ metadata.css             # Archive Info layout
│  └─ js/
│     ├─ core.js                  # App state
│     ├─ directoryPrefs.js        # Per-folder sort
│     ├─ fsUtils.js               # Folders and archives
│     ├─ keybinds.js              # Default shortcuts and saved config
│     ├─ keyboardNav.js           # List and tab keys
│     ├─ menubar.js               # Menu open and close
│     ├─ metadata.js              # ComicInfo and gallery metadata
│     ├─ metadata-window.js       # Archive Info window
│     ├─ navigationHistory.js     # Back and Forward
│     ├─ shellBackground.js       # Window background follows the theme
│     ├─ shortcuts.js             # Key, mouse, and wheel input
│     ├─ urlLoader.js             # Download an imported gallery
│     ├─ filepanel/
│     │  ├─ filePanel.js          # File list and thumbnails
│     │  ├─ favoritesStore.js     # Favorites
│     │  └─ libraryStore.js       # Imported library
│     ├─ main/
│     │  ├─ main.js               # Startup
│     │  ├─ fullscreen.js         # Fullscreen
│     │  ├─ dropzone.js           # Drag and drop
│     │  ├─ lifecycle.js          # Title bar and single-instance handoff
│     │  ├─ metadataBadge.js      # Archive Info button
│     │  ├─ passwordOverlay.js    # Archive password prompt
│     │  └─ urlOverlay.js         # Open URL prompt
│     ├─ menubar/
│     │  ├─ chrome.js             # Show or hide the menu and status bar
│     │  └─ statusbar.js          # Status bar text
│     ├─ options/
│     │  ├─ options.js            # Options window
│     │  ├─ keybindUi.js          # Shortcut capture
│     │  └─ associationsUi.js     # File type checkboxes
│     ├─ services/
│     │  ├─ actions.js            # Named commands
│     │  ├─ cache.js              # Size-capped maps
│     │  ├─ filterModules.js      # Loads a filter
│     │  ├─ keyCombo.js           # Shortcut parsing
│     │  ├─ keybindDomain.js      # Shortcut conflicts
│     │  ├─ metadataFiles.js      # Which metadata file wins
│     │  ├─ registry.js           # Filter and scaling choices
│     │  ├─ sorting.js            # Sort comparison
│     │  ├─ viewerMath.js         # Zoom, pan, and fit math
│     │  ├─ filters/              # Filter definitions
│     │  ├─ pipelines/            # WebGL
│     │  └─ scaling/              # Lanczos
│     ├─ shared/
│     │  ├─ theme.js              # Apply theme and custom CSS
│     │  ├─ themePrePaint.js      # Theme before the first paint
│     │  ├─ blobImage.js          # Shared decoded images
│     │  ├─ configPreview.js      # Options preview and the CSS emergency reset
│     │  └─ windowFit.js          # Size Options and Archive Info to their content
│     ├─ vendors/
│     │  ├─ pica.js               # Lanczos resizer
│     │  └─ purify.min.js         # SVG cleanup
│     └─ viewer/
│        ├─ viewer.js             # Viewer entry
│        ├─ viewerRender.js       # Image and video elements
│        ├─ viewerPipelines.js    # Filters on the viewer
│        ├─ viewerGestures.js     # Pan drag
│        └─ viewerAudio.js        # Mute and volume
├─ src-tauri/
│  ├─ capabilities/
│  │  └─ default.json             # What each window is allowed to do
│  ├─ icons/                      # App icon
│  ├─ src/
│  │  ├─ archives/                # Archive reading and the open-archive cache
│  │  ├─ commands/                # Calls the UI can make into Rust
│  │  ├─ platform/                # Shell icons, thumbnails, dialogs, file attributes
│  │  ├─ tests/                   # Rust tests
│  │  ├─ config.rs                # Load and save settings
│  │  ├─ formats.rs               # Which extensions open
│  │  ├─ ico.rs                   # ICO spritesheets
│  │  ├─ lib.rs                   # App startup
│  │  ├─ main.rs                  # Executable entry
│  │  ├─ models.rs                # Data passed across to the UI
│  │  ├─ protocol.rs              # quivit:// pages, thumbnails, and icons
│  │  ├─ utils.rs                 # Encoding helpers
│  │  └─ windows.rs               # Window sizes
│  ├─ Cargo.toml
│  └─ tauri.conf.json
├─ themes/                        # Example themes shipped with the app
├─ package.json
└─ README.md
```

## Attributions

- UI Icons: [Lucide](https://lucide.dev)
- Metadata Icons: [Fluent Emoji](https://github.com/microsoft/fluentui-emoji)
- Format Icons Font: [andrew-paglinawan/QuicksandFamily](https://github.com/andrew-paglinawan/QuicksandFamily)
- Language Flags: [jdecked/Twemoji](https://github.com/jdecked/twemoji)
- WebGL Shaders: [Bloc97/Anime4K](https://github.com/bloc97/Anime4K) / [stefanlegg/crt-fx](https://github.com/stefanlegg/crt-fx) / [TheMarco/RetroZone](https://github.com/TheMarco/RetroZone) (Custom phosphor WebGL implementation) / [cgwg CRT-Geom](https://github.com/libretro/common-shaders) (Geom-inspired beam, custom WebGL implementation)
- Agent Skills: Adapted from [poteto - pstack](https://github.com/cursor/plugins/tree/main/pstack) and [mattpocock/skills](https://github.com/mattpocock/skills)
