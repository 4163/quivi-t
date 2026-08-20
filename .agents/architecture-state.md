# Architecture state

Current module map.

### What belongs here

This section is a **structural map**, not a changelog and not a feature list.

Edit it only when a change does one of these:
- adds, deletes, moves, or repurposes a module, HTML page, or CSS sheet
- changes who owns a surface, a persistence tier, or a config key family
- changes a cross-module contract (state machine vs UI, IPC shape, config-file roles, window-sizing source of truth)

Do **not** add:
- features, bug fixes, or UX polish. Put those in `implemented.md` and, if user-facing, `README.md`
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
- Roaming/portable files are the source of truth. `localStorage` is only a pre-paint cache (`quivit-theme`, `quivit-custom-css`) plus session-only `options-active-tab`.
- Roaming split: `quivit_config.json` (preferences), `quivit_state.json` (last-known runtime), `quivit_directory_sort.json`, `quivit_favorites.json`. Portable mode folds those into one `quivit_config.json` beside the exe.
- `AppConfig` uses `#[serde(default)]`; `frontend_data` is untyped JSON so unknown keys round-trip. `mergeConfig()` fills missing keys from defaults.
- User-chosen prefs → `quivit_config.json`. Last-known runtime → `quivit_state.json`. Restart-gated settings are staged as `pending_<key>` and promoted at startup.
- `default_sort` is config-file-only; the UI writes only per-directory sort prefs. Archive cache budget is config-file-only, no UI.
- Theme/CSS live previews are ephemeral until Options Apply. They must not persist to `localStorage` while previewing.

**CSS:**
- `global.css`: tokens, resets, shared rules. Loaded by every HTML page.
- `main.css` / `options.css` / `metadata.css`: that window's layout only. Consume tokens; do not redeclare them.

**JavaScript:**
- `core.js`: state machine. No DOM. UI modules subscribe via `onStateChange`.
- `services/`: pure domain: `actions.js` (single `cmd-*` registry + dispatch), `keyCombo.js`, `keybindDomain.js`, `sorting.js`, `viewerMath.js`. No `document`.
- `shared/`: cross-window: `theme.js` / `themePrePaint.js`, `configPreview.js`, `windowFit.js`.
- `keybinds.js`: `mergeConfig` + pan/zoom defaults. `DEFAULT_KEYBINDS` is derived from `ACTION_REGISTRY`.
- `shortcuts.js`: keyboard / mouse / wheel dispatch. Does not write the statusbar.
- `viewer/`: `viewer.js` facade; `viewerRender.js` owns the image pool; `viewerGestures.js` owns pan input; math is in `viewerMath.js`.
- `filepanel/filePanel.js`: sole `#file-panel` owner. Self-subscribes. `favoritesStore.js` is persistence only (no DOM).
- `fsUtils.js`: filesystem / archive navigation. No DOM.
- `directoryPrefs.js`: per-directory sort prefs. Sort math is in `services/sorting.js`.
- `navigationHistory.js`: session-only container Back/Forward.
- `metadata.js`: comic/archive metadata parsing. `metadata-window.js`: that window's controller.
- `menubar.js`: dropdown interaction. `menubar/chrome.js`: menu/status visibility. `menubar/statusbar.js`: sole `#statusbar` writer.
- `keyboardNav.js`: generic list/tab navigation.
- `shellBackground.js`: mirrors `--surface` onto the native window.
- `main/main.js`: thin bootstrap + init + slim state fan-out. Does not render the file panel or write the statusbar.
- `main/fullscreen.js`, `dropzone.js`, `lifecycle.js`, `metadataBadge.js`: those surfaces only.
- `options/options.js`: Options orchestration. `keybindUi.js`: capture UI. `associationsUi.js`: file-type associations.

**Windows:**
- Three HTML entry points: `index.html`, `options.html`, `metadata.html`.
- Main window is built in Rust. Size constants live in `windows.rs`; JS caps in `shared/windowFit.js` must stay in sync.
- Options/metadata open hidden, measure, `fit_*_window`, then show.

**Rust:**
- `lib.rs` & `main.rs`: bootstrap, config watcher, and main-window build.
- `tests/`: in-tree testing for archives, config, formats, and protocol.
- `config.rs`: `AppConfig` / persistence / portable / pending promotion.
- `commands/`: Tauri command surface (directory, archives, watcher, associations, shell).
- `archives/` & `formats.rs`: archive readers + `ArchiveCache` and format registry.
- `protocol.rs`: `quivit://` and `asset://` handler logic.
- `platform/` & `windows.rs`: OS-level integrations (including shell icons and hidden-path logic), window lifecycle (including size constants).
- `ico.rs`: ICO spritesheets.
- `models.rs`: IPC structs (cross-module contracts).
- `utils.rs`: Base64 and URL encoding helpers.
