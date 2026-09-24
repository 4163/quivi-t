# Architecture state

Current module map.

### What belongs here

This section is a **structural map**, not a changelog and not a feature list.

Edit it only when a change does one of these:
- adds, deletes, moves, or repurposes a module, HTML page, or CSS sheet
- changes who owns a surface, a persistence tier, or a config key family
- changes a cross-module contract (state machine vs UI, IPC shape, config-file roles, window-sizing source of truth)

Do **not** add:
- features, bug fixes, or UX polish. If user-facing, put those in `README.md`
- implementation details (timers, cache sizes, function names, hot-path tricks) unless the detail *is* the contract
- line counts, commit hashes, slice history, or "we now..." narratives
- planned or target architecture. That stays in the work plan

If the tree looks the same and ownership did not change, leave this file alone.

### How to write an entry

- Present tense. Current fact only.
- One short line: `path: role. Boundary if it is not obvious.`
- Group by layer. Do not narrate how a feature works.
- Prefer deleting a stale line over adding a clarifying paragraph.

---

**Config & Persistence:**
- Roaming/portable files are the source of truth for durable app configuration. `localStorage` holds the pre-paint theme/CSS cache, native-icon cache (`icon:*`), metadata window payload, provider-collapse UI state, provider sort order (`quivit_library_provider_order`), and session-only `options-active-tab`.
- Roaming split: `quivit_config.json` (preferences), `quivit_state.json` (last-known runtime), `quivit_directory_sort.json`, `quivit_favorites.json`. Portable mode folds those into one `quivit_config.json` beside the exe.
- `AppConfig` uses `#[serde(default)]`; `frontend_data` is untyped JSON so unknown keys round-trip. `mergeConfig()` fills missing keys from defaults.
- User-chosen prefs → `quivit_config.json`. Last-known runtime → `quivit_state.json`. Restart-gated settings are staged as `pending_<key>` and promoted at startup.
- `default_sort` is config-file-only; the UI writes only per-directory sort prefs. Archive cache budget is config-file-only, no UI.
- Filter preference is stored as `active_filter` (id) and `filter_options` (bag), replacing individual booleans.
- Additional `frontend_data` preferences: `hide_cursor_delay_sec`, `file_list_view_mode`, `spread_enabled`, `spread_direction`, `spread_mode` (derived from enabled + direction).
- `frontend_data.library_path` is an optional absolute shared URL Library location. When absent, the Library is `%LOCALAPPDATA%\\QuiviT\\library`. `retired_library_paths` blocks writes to a prior root, never to the active one.
- Remote extractors live on the dedicated orphan `extractors` deployment branch. Manifest and site scripts are fetched from GitHub Raw at runtime; successful responses cache under `%LOCALAPPDATA%\QuiviT\extractor-cache\` for offline fallback.
- Bounded in-memory session caches include archive passwords and encryption state in `fsUtils.js`, file-panel and Library thumbnails, animation metadata in `core.js`, remote extractor modules and resolving/resuming gallery state in `urlLoader.js`, and per-file audio state and audio probe results in `viewerAudio.js`.
- Theme/CSS live previews are ephemeral until Options Apply. They must not persist to `localStorage` while previewing.

**CSS:**
- `global.css`: tokens, resets, shared rules. Loaded by every HTML page.
- `main.css` / `options.css` / `metadata.css`: that window's layout only. Consume tokens; do not redeclare them.
- `themes/`: bundled example themes (`matcha-latte.css`, `sage-mint.css`).
- Menubar flyout submenu positioning uses CSS custom properties (`--submenu-top`, `--submenu-left`, `--submenu-max-height`) on host elements, not inline style assignments.

**JavaScript:**
- `core.js`: state machine. No DOM. UI modules subscribe via `onStateChange`. Tracks `spreadEnabled`, `spreadDirection`, `spreadStep`, `fileListViewMode`, and `archiveEncryption` in addition to mode/index/list/config.
- `services/`: pure domain: `actions.js` (single `cmd-*` registry + dispatch), `cache.js` (`BoundedMap`, `BoundedSet`), `keyCombo.js`, `keybindDomain.js`, `metadataFiles.js` (metadata file priority and basename matching), `registry.js` (filter/scaler catalog), `filterModules.js` (filter module loader), `sorting.js`, `viewerMath.js` (spread ratio detection, half-width scaling, viewport resize pan retention). Filter/scaler methods live in `filters/` and `scaling/lanczos.js`; WebGL is orchestrated by `pipelines/glRuntime.js`. No `document` querying.
- `shared/`: cross-window: `theme.js` / `themePrePaint.js`, `configPreview.js`, `windowFit.js`, `blobImage.js`.
- `keybinds.js`: `mergeConfig` + pan/zoom defaults. `DEFAULT_KEYBINDS` is derived from `ACTION_REGISTRY`.
- `shortcuts.js`: keyboard / mouse / wheel dispatch. Does not write the statusbar.
- `viewer/`: `viewer.js` facade; `viewerRender.js` owns image and video pools and parks retiring bridge elements in `#viewer-bridge-layer` with pre-navigation transforms frozen in `--bridge-*` props; `viewerPipelines.js` owns overlay canvases and streams image and video frames through WebGL; `viewerAudio.js` owns `#viewer-audio`, per-file volume/mute state, and viewport audio controls; `viewerGestures.js` owns pan input; math is in `viewerMath.js`.
- `filepanel/filePanel.js`: sole `#file-panel` owner. Self-subscribes. List and thumbnail view modes with card grid virtualization. Renders the flat library tree from `libraryStore.js`; only gallery roots and raw images are removable. Exports `focusFileList()` and `isFileListFocused()`. `favoritesStore.js` and `libraryStore.js` are data-only (no DOM). `libraryStore.js` also owns provider sort order persistence.
- `fsUtils.js`: filesystem / archive navigation. No DOM.
- `directoryPrefs.js`: per-directory sort prefs. Sort math is in `services/sorting.js`.
- `navigationHistory.js`: session-only container Back/Forward.
- `urlLoader.js`: non-DOM URL import coordinator. Validates remote registry modules, detects provider-agnostic direct media, owns the gallery queue with display-ordered downloads, SVG sanitization (via DOMPurify in `vendors/purify.min.js`), and follows Library relocation. Returns paths immediately on import; background queue handles downloads.
- `metadata.js`: comic/archive metadata parsing. `parseMetadataText` handles both archive entries and Library directory metadata via `fetchDirectoryMetadata` (IPC to `find_directory_metadata`). `metadata-window.js`: that window's controller.
- `menubar.js`: dropdown interaction. `menubar/chrome.js`: menu/status visibility. `menubar/statusbar.js`: sole `#statusbar` writer. Dual spread indicator routing (`.status-spread` in statusbar, `#spread-indicator` viewport overlay).
- `keyboardNav.js`: generic list/tab navigation.
- `shellBackground.js`: mirrors `--surface` onto the native window.
- `main/main.js`: thin bootstrap + init + slim state fan-out. Does not render the file panel or write the statusbar.
- `main/fullscreen.js`, `dropzone.js`, `lifecycle.js`, `metadataBadge.js`, `passwordOverlay.js`, `urlOverlay.js`: those surfaces only. `urlOverlay.js` owns `#url-overlay`.
- `options/options.js`: Options orchestration. `keybindUi.js`: capture UI. `associationsUi.js`: file-type associations.

**Windows:**
- Three HTML entry points: `index.html`, `options.html`, `metadata.html`.
- Main window is built in Rust. Size constants live in `windows.rs`; JS caps in `shared/windowFit.js` must stay in sync.
- Options/metadata open hidden, measure, `fit_*_window`, then show.

**Rust:**
- `lib.rs` & `main.rs`: bootstrap, config watcher, and main-window build.
- `tests/`: in-tree testing for archives, config, formats, protocol, and temp archive origin.
- `config.rs`: `AppConfig` / persistence / portable / pending promotion.
- `commands/`: Tauri IPC surface. Each command file owns one family.
- `commands/library.rs`: live Library relocation and write guards. `commands/watchers.rs`: configured-Library watcher and `library-changed` events.
- `commands/network.rs`: remote text (`fetch_text`), raw bytes with header forwarding (`fetch_bytes`), extractor caching from the extractors branch, streamed download, cancellation, image magic-byte validation (`verify_image_magic`), and tile descramble with XOR decryption for provider-specific image protection. `commands/directory.rs`: flat `gallery.json`-backed Library tree (single-level, no recursive depth) and `find_directory_metadata` for Library directory metadata lookup.
- `commands/animation.rs`: `check_is_animated` and `check_media_audio` (ISOBMFF sound track detection).
- `commands/archives.rs`: `list_archive` accepts `password: Option<String>`; archive lifecycle commands are `drop_all_archives_cache` and `resolve_archive_temp_origin`.
- `archives/` & `formats.rs`: archive readers + `ArchiveCache` (two-archive sliding buffer, `MAX_OPEN_ARCHIVES = 2`), format/animation registry, and ISOBMFF box parser for MP4 audio detection.
- `protocol.rs`: `quivit://` handler. Routes: `/archive/` (entry data, `no-store`), `/thumb/` (96×96 shell thumbnails), `/icon/` (shell icons, `?size=large` for 32×32). `asset://` for direct file access.
- `platform/`: `icons.rs` (shell icons), `thumbnails.rs` (96×96 `IShellItemImageFactory`), `temp_archive.rs` (external archiver temp origin resolution), `attributes.rs` (dotfile visibility), `dialog.rs` (native folder picker with Library virtual folder resolution). `windows.rs`: window lifecycle and size constants.
- `ico.rs`: ICO spritesheets.
- `models.rs`: IPC structs. `FileEntry.size: u64`, `ArchiveEncryptionStatus`, `ArchiveReadResult.encryption`, `TempArchiveOrigin`, `LibraryNode`, `LibraryProviderEntry`, and `DirectoryMetadataResult`.
- `utils.rs`: Base64 and URL encoding helpers.

**Testing & Diagnostics:**
- Three-tier testing architecture matching execution speed and runtime dependencies.
- `mocha/`: standalone pure frontend unit tests (`actions`, `cache`, `core`, `diagnosticsContract`, `metadata`, `sorting`, `urlLoader`, `urlLoaderFlows`, `viewerMath`) outside `src/` to prevent bundling into `frontendDist: "../src"`. Runs via `npm test` in < 100ms.
- `e2e/`: WebdriverIO end-to-end suite (`specs/`, `pageobjects/`, `helpers/`) running against the live debug binary via `tauri-driver` and `msedgedriver` under portable mode isolation. Runs via `npm run test:e2e`.
- `e2e/replay-diagnostics/`: in-browser pipeline identity diagnostic engine (`base.js`), modular probes (`probes/`), CLI harness (`cli.js`), and scenario runner (`runner.e2e.js`). Evaluates blackout frames, image pool retirement races, WebGL readiness, and IPC latency. Supports `investigation.js` overrides for the automated self-diagnostic loop. Runs via `npm run diagnose` and `npm run replay`.
- `e2e/helpers/recorder-shim.js`: in-browser action recorder with floating control badge (`[Start/Pause]`, `[Stop]`, `[Reset]`), continuous Node trace buffering, and auto-finalization on window exit. Saves traces to `e2e/scenarios/<scenario>.json`. Runs via `npm run record`.
- `src-tauri/src/tests/`: in-tree Rust backend unit tests for archives, config parsing, format sniffing, protocol URLs, and temp archive origin matching. Runs via `cargo test` in < 1s.
