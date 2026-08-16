# QuiviT Implemented Work

Date started: 2026-08-01

Shipped, verified work (features / fixes / reports / optimizations).

## Fully Implemented

### CSS / JS Decoupling & HTML-First Specs (landed on `refactor/decoupling`)
- **CSS decoupling:** `src/css/global.css` holds tokens, resets, and shared rules. `main.css`, `options.css`, and `metadata.css` are page-only. Every HTML page loads `global.css` first.
- **JS DOM decoupling (9 slices):** frontend split into `core.js` (no DOM), `services/` (pure), `shared/` (theme / preview / window fit), `viewer/`, `filepanel/`, `menubar/`, `main/`, and `options/`. UI modules self-subscribe to `Core.onStateChange`. `ACTION_REGISTRY` is the single `cmd-*` source. Statusbar and chrome each have one writer. File panel self-renders; `main.js` is bootstrap only.
- **HTML-first (incremental):** static probes/skeletons where they help (e.g. `#file-list-sentinel`), CSS classes for presentation state (`.is-hidden-entry`, body resize/cursor classes), `--panel-w` / `--col-*-w` instead of inline widths. File-panel row pool stays JS-allocated and sized to the viewport — a hardcoded static skeleton is not required.

### Tab Navigation Extraction
- List and tab keyboard navigation live in `keyboardNav.js` (`makeContainerNavigable`, Home/End tab jump). File panel and favorites reuse it; Options tabs use the same helper. No inline `switch (e.key)` blocks remain in those UIs.

### Lazy Config Save, Exit Flush & Fullscreen State Sync on Reload (2026-08-13)
- **Lazy Config Save (Performance):** Replaced all immediate `_persistConfig()` calls for UI preference mutations with a centralized dirty-flag debouncer (`_scheduleConfigFlush(1500)`). Preference toggles (transparent background, fit mode, scaling mode, scroll zoom latch, menu/status bar visibility) now mark config as dirty in memory, update the UI immediately, and schedule a single debounced disk write 1500 ms after the last interaction. Eliminates frame drops and `save_config` IPC thrash during rapid UI toggling.
- **Exit Flush:** `Core.flushConfig()` is exposed on the public API. The main window's `onCloseRequested` event is intercepted to await `Core.flushConfig()` before closing (using the prevent/re-close guard pattern to handle async work correctly). The `cmd-quit` action and its menu button listener also await `Core.flushConfig()` before invoking `plugin:process|exit`, ensuring lazy changes are persisted on all graceful exit paths.
- **Fullscreen State Sync on Reload:** `main.js` now queries the actual OS window fullscreen state on `quivit-config-loaded` (startup / Ctrl+R reload). If the native window is already fullscreen but the JS environment has reset, it re-activates `setFullscreenUiActive(true)` and hides chrome, fixing the bug where Ctrl+Shift+R in fullscreen left the hover-exit button and hold-to-exit shortcut non-functional.
- **Bug Fix (syntax):** Restored missing closing `}` for the `if (previewTheme !== null)` block in `main.js` that was accidentally removed during a prior indentation fix.

### Fullscreen Exit UX & Keybind Safety Validation (2026-08-13)
- **Hold-to-Exit Fullscreen:** Pressing and holding `Escape` (or the configured `cmd-exit-fullscreen-hold` key) for 1.5 seconds exits fullscreen mode. Includes a top-center hint bar that appears on enter and when starting a hold, guiding the user.
- **Fullscreen Exit Hover Button:** Moving the mouse to the top edge (y ≤ 4px) of the screen while in fullscreen reveals a persistent exit button that slides down. It hides once the mouse moves far enough away (y > 50px).
- **Keybind Safety Guards:** `validateKeybindSafety` runs on Options Save to prevent soft-locks. `cmd-toggle-menubar` cannot have its last non-conflicting binding removed. `cmd-exit-fullscreen-hold` strictly requires `Escape` to always be bound; `mergeConfig` injects it if missing, and `LOCKED_BINDINGS` prevents the UI from removing it while badging it as "Required binding".
- **Config Debouncing:** Rapid toggling of UI chrome (like the status bar) no longer spams the disk; `Core.persistConfig({ debounceMs: 300 })` schedules saves using a single shared timer, preventing `save_config` IPC thrash.
- **Dead Code Removal:** Replaced the orphaned `Core.toggleFileList()` with local `toggleFileList()` mapped to `Core.setFileListVisible`.
- **Status Bar Index Fix:** Fixed `.status-index` rendering `-1/X` when nothing is highlighted; now correctly clamps to `0/X` via `Math.max(0, ...)`.

### Responsive Keyboard Panning & Individual Pan Lengths (2026-08-13)
- **Separate pan lengths (scroll vs keyboard):** `frontend_data.keyboard_pan_step` (default 72) and `frontend_data.wheel_pan_step` (default 120), configurable via Options → General → Panning number inputs (`opt-keyboard-pan-step` / `opt-wheel-pan-step`). Defaults live in `DEFAULT_KEYBOARD_PAN_STEP` / `DEFAULT_WHEEL_PAN_STEP` in `keybinds.js` (matching original Quivi defaults).
- **`mergeConfig` pan-step normalization (`keybinds.js`):** the raw `keyboard_pan_step`/`wheel_pan_step` values are stripped from the incoming `frontend_data` spread (`fdBase`) and re-added number-guarded with the `DEFAULT_*` fallbacks, so junk/non-number values in saved config can never produce a broken pan step.
- **Pan-step hot-path caching:** `main.js` pre-parses both steps into module-level constants once via `updatePanSteps()` on `quivit-config-loaded` (`Number.isFinite`-guarded fallback to defaults) instead of re-reading `config.frontend_data.keyboard_pan_step || 72` inside every dispatch; `dispatchAction` picks `keyboardPanStep`/`wheelPanStep` through the `payload?.wheel` flag.
- **Responsive keyboard panning:** `shortcuts.js` pre-parses pan keybinds into the `KEYBOARD_PAN_VECTORS` table (actionId → x/y vector) on boot and on `quivit-config-loaded`. `keydown` aggregates the currently held pan keys (`readKeyboardPanVector`) and dispatches **immediately per key press** through a new `dispatchKeyboardPan` callback, so panning starts with zero debounce/delay and supports fast multi-directional spam (e.g. holding W+A pans diagonally). Native key-repeat drives speed; pan keys bypass the generic `handleShortcut` path so each keydown pans exactly once. Stops on `keyup` and on window `blur` (which also clears `activeKeys`/`activeButtons` — fixes stuck keys after focus loss). `isInteractiveKeyTarget` extracted so Space/arrows still activate buttons natively.
- **Smooth panning — tried, rejected:** evaluated an animated/smoothed pan; reverted — stepped panning feels more responsive. No easing/lerp path remains in `viewer.js` (only rAF-batched transform application).
- **Zoom smoothing — tried, rejected:** same decision — instant zoom kept.

### HTML Flickering & Image Navigation Overhaul (Closed, 2026-08-12/13)
- **Closed from `additions.md`:** the flicker overhaul shipped via the `feature/preloading` branch (merged `c5442cd`) plus the image-pool loading semantics entry above (two-image DOM bridge, decode-gated swap that holds the previous image, first-display placeholder with animated "Loading…" alt, cancellable off-DOM preloads, symmetric 7/7 prefetch).
- **Opaque canvas + image appear together:** the grill/opaque canvas is a persistent CSS backdrop (`#img-grill`/`#img-grill-border`, `inset: 0`, `--zoom-scale` counter-scaling) that stays constant behind the pool nodes, so it no longer appears as a flash ahead of the image; navigation swaps only on `decode()`.
- **Session cache of archive entries:** retained in-session decompression cache resolved by the global byte-budgeted `ArchiveCache` (default 512 MB `archive_cache_mb`, LRU eviction) from the Multi-Archive cache entry — the "cache limit in Options" discussion was decided against; the budget stays config-file-only.

### Multi-Archive Byte-Budgeted Archive Cache & Pool-Driven Prefetch (2026-08-12)
- **`ArchiveCache` refactored into bounded per-archive state + one global budget:** `archives.rs` now keeps a recent-set `HashMap<String, SingleArchiveCache>` (each with its own ZIP entry map, `zip_archive`, temp-extract dir, and notify pair) alongside a global LRU of `(archive_path, entry_name)` pairs and a total byte budget. The old single-active-archive, 20-entry count-based `zip_entries`/`zip_lru` is gone; `commands.rs` `list_archive`/`prefetch_archive_entries` and the `lib.rs` protocol handler all route through the per-archive state.
- **`archive_cache_mb` config (default 512 MB):** new top-level `usize` field in `config.rs` `AppConfig` (config-file-only, no UI). `lib.rs` builds the cache with `ArchiveCache::new(cache_mb)`.
- **Shared byte-budget helper:** eviction/insert/read-touch logic consolidated into `ArchiveCache::insert_zip_entry`, `get_zip_entry`, and `evict_until_within_budget` in `archives.rs` (was duplicated in `commands.rs` and `lib.rs`) — evicts least-recently-used `(archive, entry)` pairs until the incoming entry fits, and always allows a single entry larger than the whole budget. Removed the write-only `active_path` field (the per-archive map superseded it).
- **Symmetric prefetch window:** `fsUtils.js` prefetch is now 7 ahead + 7 behind (was 7 ahead / 3 behind), warming decoded ZIP/CBZ entries around the settled image while the viewer keeps a smaller two-image DOM bridge.
- **`buildFileSrcSync` helper:** synchronous `convertFileSrc` variant in `fsUtils.js` for the DOM pool (ICO stays async — spritesheets are fetched via the existing async path).
- **Archive ICO spritesheets:** archived `.ico` entries now use the same frame extraction/spritesheet pipeline as loose ICO files via `get_archive_ico_frames`, instead of being handed to the archive protocol as raw `image/x-icon` bytes. Sync hover/neighbor preloads skip archive ICO entries so the active async decode path remains the single source of truth.
- **Validation-pass fixes:** follow-up verification corrected the docs from 500 MB to the actual 512 MB default, split Manhwa Mode back into its own future backlog slice (the HTML flicker work did not implement continuous-strip rendering), added README coverage for ICO spritesheets, and removed the unused `mut` from the new archive-cache test helper closure.
- **Verification:** `node --check` and `cargo check` clean, `cargo test` 13/13 archive tests + new `archive_cache_byte_budget_evicts_globally` (cross-archive LRU eviction order, budget enforcement, oversized-entry insert, duplicate-insert no-op) = 14/14 total.

### Image-Pool Loading Semantics & Scroll-Zoom Indicator Idempotency (2026-08-12)
- **Window title never shows "Loading..."** — reverted the interrupted session's `Loading... ◦ QuiviT` branch in `updateWindowTitle` (main.js) entirely; the title only ever renders `filename (current/total) ◦ container ◦ QuiviT` like the legacy master. Removed the now-unused `quivit-image-loaded` title listener and the `export` keyword.
- **Loading feedback lives on the img element, not the window title:** `startLoadingAltAnimation(el)` in `viewer.js` now targets the actual loading pool node (previously it wrote to the stale module-level `img` — the old visible image, or `null` on the first load, so the animation never appeared). It animates both `alt` and `title` through `Loading. → Loading.. → Loading...` (320 ms).
- **Placeholder only when nothing is on screen** (per user): first display (no previous image — entering an archive, after clear) shows the pool node with its src stripped so the browser renders the default broken-image frame with the animated "Loading..." alt/title, fetched via a hidden legacy-style preloader; the real src + `alt`/`title` = filename attach on load, `Failed to load X` on error. When a previous image is visible (navigation), the old image is held and the swap happens on `decode()` with no loading feedback at all.
- **Status bar untouched beyond filename:** the static `Loading...` filename write stays (restored by `_activatePoolNode`), but the interrupted session's `.status-filename-container` title hack is gone.
- **`_updateScrollIndicator` is now idempotent** (shortcuts.js): computes the target text + `zoom-held`/`zoom-latched` classes, compares against the current DOM, and writes nothing when unchanged. `resetScrollLatch` no longer writes the indicator at all — it always runs right before `Core.loadConfig()`, and `syncScrollLatch` (via `quivit-config-loaded`) is the single writer. This kills the per-navigation latch-badge churn that `_persistConfig()` → `config-changed` → reload caused (root cause of "scroll-zoom is being touched" during every image navigation).
- **Pool load handler guard:** `_attachLoadHandler` skips src-less placeholder nodes so a placeholder's inert "error" state can't stamp bogus dims.
- **Verification:** `node --check` on all touched JS, `cargo check` clean, 13/13 Node harness checks for indicator idempotency (hold-mode repeat no-ops, toggle latched/unlatched sync dedupe, `resetScrollLatch` zero writes) and 18/18 viewer harness checks (first-display placeholder alt/title/animation + preloader restore, seamless no-feedback swap, src-less placeholder load-handler guard).

### Zero-Freeze Archive Loading & Recursive Skipping
- **Non-Blocking Background Offload:** Migrated `read_directory` and `list_archive` in `commands.rs` to Tauri's internal `tokio::spawn_blocking` async runtime via `#[tauri::command(async)]`. This prevents UI freezes and dropped frames by offloading the heavy synchronous I/O parsing of huge or corrupted archives.
- **O(1) `BufReader` ZIP Optimization:** Wrapped `fs::File` with `std::io::BufReader::new(file)` when passing files to `zip::ZipArchive::new()`. This buffers the tiny backward-seeking syscalls it performs when looking for the End of Central Directory (EOCD), drastically accelerating `O(1)` file corruption detection for ZIPs.
- **Recursive Container Skipping:** Enhanced `openSibling()` in `fsUtils.js` with a recursive `while` loop that automatically intercepts rejected file promises. If the user navigates into a folder or archive that throws an unreadable error, it silently logs a warning and recursively skips forward to the *next* available sibling without throwing them back to the drives view.
- **Options UI CSS Fix:** Corrected `.flex-row` wrappers on pan step settings in `options.html` so `input[type="number"]` properly adopts the standard UI widths and spacing.
- **Git Tracking Fix:** Fixed `.gitignore` which was incorrectly ignoring newly created `.agents` documentation (like `.agents/sessions-index.md`). Added explicit exceptions so agent workflow logs are correctly tracked by version control.

### Easy-Win Features (Shift-JIS ZIPs, Hidden Config)
- **Shift-JIS ZIP Support (2026-08-11):** Fixed legacy ZIP archives created on Japanese Windows systems that use Shift-JIS (CP932) encoding for filenames without the UTF-8 flag. Added `decode_zip_entry_name()` helper in `archives.rs` that detects mojibake (replacement character `` / U+FFFD) in entry names and re-decodes the raw bytes as Shift-JIS using the `encoding_rs` crate. Updated `list_zip_entries()` and `extract_zip_entry()` to use the decoder, fixing 404 errors for archives with Japanese characters in filenames/folder names (e.g., `無` was appearing as `û│`). The fix is transparent and automatic - no user configuration needed.
- **Hidden File Config (2026-08-11):** Added `hidden: true/false` top-level config option (config-file-only, no UI exposure). When set to `true` in the portable `quivit_config.json` file (beside the executable), applies the Windows `FILE_ATTRIBUTE_HIDDEN` flag to the config file on save. The file remains accessible to the app but hidden from Explorer unless "Show hidden files" is enabled. Only applies in portable mode - roaming config files are never hidden. Implemented via `set_hidden_attribute()` helper in `utils.rs` using Windows `SetFileAttributesW` API. Defaults to `false`. The hidden attribute automatically syncs whenever config is saved.

### Verification & Performance Polish
- **Pan Key Hot-Path Optimization:** Removed dynamic string allocation from `_isMousePanKey` and `_keyPanHeld` in `viewer.js`. Pan keys are now parsed into `O(1)` memory Sets (`_panMouseButtons`, `_panKeyboardKeys`) once during the `quivit-config-loaded` event instead of dynamically mapping strings per `mousemove`.
- **Persistence Policy Documentation:** Explicitly documented the third persistence tier, "In-memory state", in `core.js` to match the exact behavior detailed in `README.md`.
- **Agent Rules Expansion (`AGENTS.md`):** Added explicit guidelines for "Performance first" (including practical caching examples) and "Self-documenting code" (avoiding multi-layer nesting, keeping comments concise but explicitly allowing structural comments like `// ── Persistence policy ──`). Upgraded "Measure twice, cut once" to strictly mandate reusing or extracting helpers before writing new logic to avoid code duplication.

### Configurable Pan Key
- **Implemented as a normal keybind:** the pan key is the `cmd-pan-drag` action in `DEFAULT_KEYBINDS` (`keybinds.js`, default `['MouseLeft', 'MouseMiddle', 'Space']`), stored in `frontend_data.keybinds` and persisted/canonicalized exactly like every other keybind via `mergeConfig` → `normalizeCombo`. No separate `pan_key` config field or `normalizePanKey` helper — the shortcut keybind system is the single source of truth.
- **Capture restrictions (per user spec):** only single inputs — no modifier keys, no key combinations, no wheel or double-click gestures. The Pan (Hold & Drag) entry in Options → Keys (Pan category) reuses the existing tag UI and `captureKeybind` machinery via a `singleOnly` capture mode: a lone key or mouse button is held (and shown) until the user releases it, committing on keyup/mouseup just like every other keybind; a second input while one is held is ignored; modifiers are ignored; Escape cancels; Delete removes the highlighted entry.
- **Hold & drag behavior (`viewer.js`):** `_panKeys()` reads `frontend_data.keybinds['cmd-pan-drag']`. Mouse-button pan keys pan while pressed and dragged; keyboard pan keys support two modes — hold the key and move the mouse (grab mode, starts only over the viewport, never over UI chrome), or hold the key + left-button drag. Panning state is driven by `_panActive()` (held pan buttons + held keyboard keys); releasing the held key or button stops it. When `MouseRight` is a configured pan key, the viewer's `contextmenu` is suppressed so right-drag pans instead of popping the menu.
- **Outside-window tracking:** keyboard grab-pan polls the OS cursor position via Tauri (`cursorPosition()` / `innerPosition()` / `scaleFactor()`, refreshed on window move) while the pan key is held, so panning continues when the pointer leaves the window exactly like a mouse-button drag (which tracks via implicit pointer capture). Polling starts only for keyboard pan keys, stops on key release, and a `blur` handler ends the grab so it can't pan from wherever the pointer happens to be when focus is lost.
- **Shared mouse-button mapping:** `MOUSE_BUTTON_NAMES` (`shortcuts.js`) is the single source for mouse button number ↔ name — used by `formatKeysCombo`, keybind capture (`keybindUi.js`), and the viewer pan-key lookup. No duplicated button tables.
- **Verification:** `node --check` on all touched modules, `cargo check` clean.

### Single-Instance Restart Gating
- **Behavior made symmetric:** "Allow only one QuiviT instance" now requires a restart in *both* directions, so the Options hint "Takes effect after restarting QuiviT." is accurate. Previously, disabling took effect immediately (each new process reads the live config at its own startup) while enabling required a restart — an inconsistency.
- **Mechanism (staged/pending value, plugin untouched):** Options Save writes the checkbox to `pending_single_instance` and never writes the effective `single_instance`. On the next launch, `apply_pending_config()` in `config.rs` (used by `lib.rs` `run()` before the plugin gate) promotes the pending value into `single_instance`, deletes the pending key, and persists `quivit_config.json` (only when a pending value exists — no file churn otherwise). The stock `tauri-plugin-single-instance` registration logic is unchanged.
- **Verification:** 4 new unit tests in `config.rs` (`test_apply_pending_config_{disable,enable,non_bool_dropped,noop_without_pending}`) — 13/13 `cargo test` pass; `cargo check` and `node --check src/js/options.js` clean.

### Window Title & Statusbar Index
- **Dynamic window title:** The OS title bar reflects the currently displayed image via `updateWindowTitle()` in `main.js`: `filename.ext (current/total) ◦ container ◦ QuiviT` for archive pages and `filename.ext (current/total) ◦ QuiviT` for folder pages (separator is `◦` U+25E6, per user preference). Non-image selections (`..`, folders, archives, drives) fall back to just `QuiviT`. `setTitle` only fires on actual change (`_lastTitle` guard); requires the `core:window:allow-set-title` capability.
- **Image-only page count:** `FsUtils.naturalPagePosition(list, filename)` counts only image entries in natural ascending filename order (via `DirectoryPrefs.naturalCompare`), independent of the active sort column/direction. The `(current/total)` suffix appears only when `total > 1`.
- **Statusbar index fix:** `FsUtils.formatStatusIndex(state)` replaces the inline `index+1 / length` math in `main.js`/`viewer.js` — the `..` parent row is excluded from both numerator and denominator (it is always `list[0]` when present). Single-entry lists render nothing.
- **Verification:** 20/20 Node harness checks pass for `formatStatusIndex`, `naturalPagePosition`, and `naturalCompare`; runtime-confirmed in-app (title format for archive/folder pages, page count independent of sort).

### Global Default Sort Guard
- Root-caused the "sort suddenly descending" bug: an empty-state column-header click was persisting `default_sort: { col, desc: true }` into the global `quivit_config.json`. The comparator was never broken.
- `sortCurrentState` and `setSortPrefs` in `directoryPrefs.js` now early-return when `directoryPath` is falsy, so header clicks outside a real directory can no longer write the global default. The global default remains config-file-only (documented in the README System Defaults and `additions.md`); per-directory overrides still go to `quivit_directory_sort.json`.
- `_naturalCompare` renamed to the exported `naturalCompare` so `fsUtils.js` can reuse it.

### Metadata Window Keybind & Spam-Flicker Fix
- Added `cmd-open-metadata` ("Open Archive Info") to `DEFAULT_KEYBINDS` (unbound by default, like `cmd-open-explorer`/`cmd-open-folder`), to the Options Keys → File Operations list in `keybindUi.js`, and to the `dispatchAction` switch in `main.js`.
- `open_options` and `open_metadata_window` in `config.rs` now only `set_focus()` when the window is already visible. A hidden (mid auto-fit) window is revealed by the JS side once the fit settles, so spam-clicking the Archive Info badge or the Options button can no longer paint a pre-fit width/height (flicker).

### Shift+Scroll Pan Defaults
- `cmd-pan-left` defaults to `['a', 'ArrowLeft', 'Shift+ScrollUp']` and `cmd-pan-right` to `['d', 'ArrowRight', 'Shift+ScrollDown']`, so Shift+scroll pans horizontally for manga reading. Both remain fully remappable through the keybind table.

### Scroll-Modifier Status Indicator
- Replaced the toggle-only `_updateLatchIndicator` with `_updateScrollIndicator(config)` in `shortcuts.js`, backed by `getScrollModifierKeys(config, ids)` which derives bound modifiers from the zoom (`cmd-zoom-in`/`cmd-zoom-out`) and pan (`cmd-pan-*`) groups so rebinding to Alt/Meta updates the badge.
- **Hold mode:** shows any physically held bound scroll modifier — `Ctrl — Held`, `Shift — Held`, `Ctrl+Shift — Held` — updated on modifier keydown/keyup.
- **Toggle mode:** while latched shows `Scroll Zoom — Toggled`; when unlatched it shows held **pan** modifiers only (`Shift — Held`), because Ctrl is the toggle key and does nothing to the wheel unlatched (it is stripped from the combo). Ctrl never renders as a held badge in toggle mode.
- Indicator cleared on reset; both states are mutually exclusive and gated on the configured modifier mode. CSS: `#statusbar.zoom-held .status-scroll-zoom` alongside the existing `zoom-latched` rule; the statusbar span is now JS-owned (empty in `index.html`).

### Example Theme Bundling
- `tauri.conf.json` now bundles `matcha-latte.css` and `sage-mint.css` as release resources so the shipped app can import the example themes from Options → Customization.
- Metadata window padding/gap polish (`metadata.css`) and portable-mode warning wording (`options.html`).

### Documentation & Verification Pass
- README reorganized: Auto-Fit Windows moved from Features to System Defaults, added the Default Sort bullet, Changelog section, example-theme wording, and theme files in the project tree.
- Full additions.md verification pass executed: change set confirmed (15 files vs last push `515edb4`), `.gitignore` coverage confirmed, `node --check` on all 7 touched JS modules + `cargo check` clean, 20/20 Node harness checks, and 8/8 runtime checks user-confirmed (window title, page count vs sort, metadata keybind, spam flicker, Shift+scroll pan, hold/toggle indicator, sort guard).

### Window Auto-Fit & Sizing
- **Centralized size constants:** Main/options/metadata initial + min window sizes moved to `config.rs` (`MAIN_INITIAL_W/H`, `OPTIONS_INITIAL_W/H`, `META_INITIAL_W/H`, etc.), with JS caps mirrored (`OPTIONS_MAX_INITIAL_W` in `options.js`, `META_MAX_INITIAL_H` in `metadata-window.js`).
- **Main window built in Rust:** The main window is now constructed in `lib.rs` setup (was declared in `tauri.conf.json`) so all windows share one construction path and the shell background applies before first paint. Initial 1280×720, min 640×400.
- **Options window auto-fit width:** Opens hidden, JS measures the `.tabs` bar at `fit-content` (unreliable to measure tab content — the Customization textarea's long placeholder lines inflate max-content past the clamp), adds the body's horizontal padding read from computed CSS, and calls `fit_options_window` (size + re-center over the main window) before showing. No size flicker.
- **Metadata window auto-fit height:** Opens hidden, JS measures the content root's `scrollHeight` (not `documentElement.scrollHeight`, which is clamped to viewport and would never shrink), capped at 600, and calls `fit_metadata_window` before showing. Re-fits live on `metadata-data` updates and cover decode.
- **Subpixel rounding:** `getBoundingClientRect()` returns fractional widths (font metrics), so the options width is `Math.ceil`'d — rounding down could size the window 1px too narrow and clip content. No hardcoded +1.
- **Serialized fits:** Both windows serialize fits through a promise chain so out-of-order IPC invokes (initial render, cover decode, live updates) can't leave a stale short measurement as the final size.
- **Version statusbar:** Added a `v1.0.0` version badge (`.status-version`) to the statusbar; app version bumped to 1.0.0 across `package.json`, `package-lock.json`, `Cargo.toml`, and `tauri.conf.json`. Added `core:window:allow-show` capability for the JS-side `.show()` calls.

### Archive Metadata Window
- **Dedicated UI:** Extracted comic/archive metadata (`ComicInfo.xml`, `CoMet.xml`, `metadata.opf`) into a standalone window (`metadata.html`), decoupled from the main UI, accessed via a new status-bar badge / `ⓘ` button in `file-panel-actions`.
- **Isolated File List:** Filtered `*.xml` and `*.opf` metadata files from the archive listing in `fsUtils.js` (`archiveMetadataFiles`) so they no longer appear as broken images in the main viewer.
- **Progressive JPEG Flicker Fix:** The main window now pre-generates a compact base64 thumbnail of the cover image and caches it in `localStorage`, allowing the metadata window to render the cover instantly upon opening without a slow protocol fetch or scanline rendering.
- **Cross-Window Synchronization:** The metadata window mirrors live theme/CSS previews (via Tauri events), syncs permanently applied settings (via native JS `storage` events), and utilizes `shellBackground.js` to avoid resize flashes. The window is also explicitly closed when the main viewer closes via `on_window_event`.
- **Optimized Test Data:** Modified `generate_cbz.py` to create a `metadata-test.cbz` fixture with authentic Bakemonogatari metadata and dynamically downscaled secondary pages to minimize repository bloat.

### File Navigation & Core Behavior Fixes
- **Image Navigation Clamping:** Navigating past the first or last image in the file list clamps the selection to that image (preserving it on the preview canvas) instead of booting out to the drag-and-drop screen. The actual file list highlight continues wrapping to `..` or folders normally. This logic is ignored if there is only a single image in the directory (legacy wrap).
- **File Deletion Fallbacks:** When an active archive or folder is deleted while viewing, the user is properly booted back. Deleting a directory falls back to its parent; deleting an archive falls back to its parent directory. Ensure "Continue from last opened directory/image" falls back gracefully by recursively walking up the directory tree using `parentOf()` if the target doesn't exist at startup, until it stabilizes at the root and ultimately falls back to the Drives view.
  - **Archive Interruption Fix:** Prevent active image interruptions inside an archive. Directory-change events on the background archive no longer boot the user back to the first image; the viewer preserves the active image page while silently refreshing the underlying file list.
- **Folder CUT Handling:** Improved the file watcher by adding a parent directory watcher. This ensures that folder CUT (move) operations, which previously bypassed the internal watcher silently, correctly boot the user back to the parent directory just like a folder deletion.
- **'This PC' Dialog Limitation:** Investigated and verified that the native Windows folder picker in Tauri cannot return a path for the virtual "This PC" shell folder, as it simply cancels the dialog. This is documented as a native OS limitation.

### Viewer & UI Enhancements (Grill, Menubar, Options)
- **Opaque Canvas Precision:** Refactored `#img-grill` and `#img-grill-border` out of JavaScript subpixel measurement. Using CSS `inset: 0`, CSS variables (`--zoom-scale`), and `box-shadow`, the grill mathematically resists parent `scale()` transforms and achieves perfect visual thickness across zoom levels.
- **Grill Customization:** Added `--grill-spacing-px` and `--grill-thickness-px` to CSS `:root` for subpixel precision control, adjusted default colors for high contrast across dark and light themes, and updated the external `matcha-latte.css` with an earthy olive-green grill palette. Defaulted `transparent_bg` to `false` (opaque grill ON by default).
- **Menubar Overflow:** Fixed menubar and statusbar overflow issues ensuring layout doesn't break on narrow window widths. Restored menu items hover hitboxes.
- **Options Window Polish:** Removed the disruptive "Are you sure?" confirmation dialog when closing Options. Clarified button wording ("Apply" vs "Save").
- **License Update:** Removed obsolete `pyfreeimage` and FreeImage license text from the legacy Python/C++ Quivi days.

### Documentation & Developer Polish
- **README Overhaul:** Updated the README to document every stack/functionality elegantly.
  - Added a features section modeled after the original Quivi page but cleaner.
  - Omitted the roadmap and added a simplified Changelog pointing to the Releases page to reduce maintainability burden.
- **Inspect Element:** Kept Inspect Element exposed in the release build for Custom CSS debugging and documented this in the README.

### Rust Backend Decoupling
- Decoupled the monolithic `src/lib.rs` backend file into distinct logical modules: `archives.rs`, `commands.rs`, `config.rs`, `ico.rs`, `models.rs`, and `utils.rs`.
- `lib.rs` is now restricted to module aggregation and the Tauri app initialization flow.
- Reduced overall complexity and merge conflicts by segmenting code by domain without losing any logic (verified via exact line porting and unit testing).

### Native Windows File Icons

- Replaced custom static icons in the file list with the exact native system icons fetched directly from the OS.
- Implemented `SHGetFileInfoW` backend calls with `SHGFI_SMALLICON` to fetch sharp 16x16 standard system icons for files and folders (including the `__folder__` abstraction).
- Rewrote the frontend to use a DOM-rendered placeholder `<img>` tagged with `data-ext` while asynchronously loading icons without UI freezing, caching them via Base64 PNGs natively supported by the browser.
- Deleted legacy custom icons (`icons/` and `src/assets/icons/`).
- Added a fallback SVG for unknown files or fetch failures.

### Hidden Folders Handling

- Added `is_hidden: bool` directly to `FileEntry` struct.
- Checked via `is_hidden_path()` to align Windows's native `FILE_ATTRIBUTE_HIDDEN` flag and dot-prefix paths.
- Frontend translates this to a cleaner UI by rendering hidden items (and their icons) at 65% opacity.

### 7Z/CB7 Performance

- Resolved UI blocking and freezing during large 7z/cb7 archive extraction by adopting an atomic extraction pipeline (`.tmp` to `.ext` renaming).
- Removed the rigid 3-second sleep polling mechanism, replacing it with a robust pure-Rust `Condvar` notification wait and atomic read triggers.
- This stabilizes thread-offloaded protocol serving, keeping the app entirely responsive even during long background extractions.

### Options Window Recovery

- Fixed the Windows/Tauri Options-window deadlock by making `open_options` an async Tauri command.
- Reused a stable `options` window label instead of creating dynamic duplicate windows.
- Added the `options` window to Tauri capabilities.
- Verified Options opens from the `3` shortcut in `npm run tauri dev`.

### Options Close Permission

- Added `core:window:allow-close`.
- `Cancel` and `Apply & Close` now use the Tauri window close path.
- Verified Tauri capability validation by launching the dev app.

### Config Folder Link

- Added backend commands to resolve and open the active config directory.
- Options displays the resolved config folder and opens it through the backend.
- Config path respects normal mode versus portable mode.

### Shortcut Defaults Source

- Added `src/js/keybinds.js` as the shared source of default shortcuts and config merging.
- Added legacy migration for old defaults such as `F4`, `Alt+Enter`, and `F5`.
- Main window and Options use the shared keybind defaults.

### Shortcut Dispatch Extraction

- Added `src/js/shortcuts.js`.
- Moved keyboard combo normalization and action lookup out of `main.js`.
- Verified `3` opens Options after extraction.

### File Panel Extraction

- Added `src/js/filePanel.js`.
- Moved file list rendering, sorting UI, panel resizing, and column resizing out of `main.js`.
- Fixed fixed-width folder SVG sizing in file rows.

### Startup Ordering

- Moved `Core.init()` after DOM subscriptions and bindings so startup state/config changes are observed.

### Small-Image Panning

- Updated viewer pan clamping so images smaller than the viewport can still move within intuitive edge bounds.
- Added `VIEWER_KEYBOARD_PAN_STEP` in `src/js/keybinds.js` so W/A/S/D and arrow-key pan distance can be tuned from one place.

### Default Fit Mode

- Changed the startup fit mode to `height-if-larger`.
- Added `DEFAULT_FIT_MODE` in `src/js/keybinds.js`.
- Persisted explicit View-menu fit changes to `frontend_data.fit_mode` so a user's chosen fit mode survives reloads after the first change.

### Scaling Mode Persistence

- Added `DEFAULT_SCALING_MODE` in `src/js/keybinds.js` with `bicubic` as the default.
- Persisted explicit View-menu scaling changes to `frontend_data.scaling_mode`.
- Routed scaling state through `core.js` so `main.js` only mirrors state into the viewer and menu UI.

### Folder/Archive Traversal Shortcuts

- Added `Ctrl+X` for opening the next sibling folder/archive from the current directory or archive.
- Added `Ctrl+Z` for opening the previous sibling folder/archive from the current directory or archive.
- Added a backend sibling-container resolver so traversal is anchored to the current container instead of the selected image inside the visible list.

### Archive Parent And Continue-Last

- Added a `..` entry inside archive file lists.
- Backspace/`..` from an archive now returns to the containing directory and highlights the archive.
- Continue-last persistence is gated by the Options `continue_last` setting and now supports archive paths.
- Disabling continue-last removes stale last-opened path fields from saved config.

### File-Type Semantics

- Parent entries, folders, and archives no longer render as images when selected.
- Double-clicking folders, archives, and `..` activates navigation through the same core path as keyboard/container navigation.
- Archive entries are treated as directory-like containers for open/navigation flows.
- Added a direct File-menu picker for opening image/archive files, since the native directory picker only selects directories.

### File Panel Breadcrumb

- Added a display-only breadcrumb strip above the file-list header.
- Shows the current directory path in folder mode and the current archive path in archive mode.
- Wraps long paths so deeply nested locations remain visible.

### Options Layout And Wording

- Moved "Continue from last opened directory" below the default directory input.
- Renamed the portable-config checkbox to "Save config data locally".
- Added explanatory text that default settings live under `%APPDATA%` and portable settings live beside the app executable.
- Kept the config-directory hint clickable.
- Confirmed Cancel and Apply & Close use the Tauri close path.

### Menu And Shortcut Polish

- Updated default shortcuts to `1` menu bar, `2` file list, `3` full screen, `4` Options, and `5` Refresh.
- Added View-menu commands and keybind defaults for clockwise rotation (`H`), horizontal flip (`V`), and vertical flip (`B`).
- Added a File-menu command for opening an image/archive directly through a file picker.
- Added a GitHub link with a compact GitHub icon in the menu bar.
- Added the English-only Language tab with a visible flag marker.

### Config Privacy Guardrails

- Updated root `.gitignore` to keep executable-adjacent `.portable` and `quivit_config.json` out of Git.
- Added tracked exceptions for the active `.agents` planning/implemented docs while keeping other local agent files ignored.

### README Refresh

- Restored the fuller QuiviT description.
- Moved Quivi credits near the top.
- Added stack, project structure, architecture, config, shortcut, and backend-command documentation.
- Updated shortcut docs to match current `src/js/keybinds.js`.
- Added direct file/archive opening, breadcrumb, flips, full frontend syntax-check list, and backend helper command notes.

### Session Recovery Notes

- Added a newest-first Codex continuation entry to `.agents/sessions.md`.
- Replaced the superseded `.agents/implementation-plan.md` with `.agents/implementation-plan - additions.md` as the single active implementation plan.

### Fit Mode Refactor

- Renamed and remapped fit-mode shortcuts: `Q` fit width, `E` fit height, `R` fit width if larger, `T` fit height if larger.
- Added new **Auto fit** mode (`F`) mapped to `cmd-fit-best` → viewer `window` fit mode, which scales up or down to fill the viewport (unlike the `if-larger` variants).
- Auto fit selects `Math.min(scaleX, scaleY)` so the image always fits entirely on screen without scrolling. On 1:1 aspect ratio images the result equals fit width.
- Added `cmd-fit-best` menu item and click listener in `main.js` and `index.html`.
- Added Auto fit entry to the Options Keys tab `ACTIONS` list.

### Keybind System Cleanup

- Added `cmd-open-dir` (`Ctrl+O`) and `cmd-open-file` (`Ctrl+Shift+O`) to `DEFAULT_KEYBINDS` so both are fully configurable.
- Removed hardcoded `Ctrl+o`, `1–5` fallback checks from `shortcuts.js`; all shortcuts now live exclusively in `DEFAULT_KEYBINDS`.
- Removed `LEGACY_DEFAULT_KEYBINDS` migration block; simplified `mergeConfig` — saved user config is now merged directly over defaults.

### Options: Reset to Defaults Button

- Added a **Reset to Defaults** button in the Options Keys tab header.
- Clicking it replaces `config.frontend_data.keybinds` with a fresh copy of `DEFAULT_KEYBINDS` and re-renders the keybind list in-place.
- Styled via `.keybinds-header` and `#btn-reset-keybinds` in `options.css` — no inline styles.

### Twemoji Flag (Language Tab)

- Downloaded the official Twemoji US flag SVG (`1f1fa-1f1f8.svg`) and placed it at `src/assets/twemoji-us.svg`.
- Replaced the native `🇺🇸` OS emoji in `options.html` with a Twemoji `<img class="flag-icon">` for consistent cross-platform rendering.
- Added developer comment pointing to `https://github.com/jdecked/twemoji` for future localization work.
- Styled via `.flag-icon` and `.language-name` in `options.css`.
- Added Twemoji to the README attribution list.

### Resize & Zoom Snapping Polish

- Refactored viewer resize handling to accurately respect the current `fitMode` (auto-fit, fit-width, fit-height, etc.) on window resize, preventing sudden intuitive snap-backs.
- Disabled reverting `fitMode` to `none` during standard zooming operations. The user can now zoom in/out freely without losing their underlying fit preference, and the app recalculates appropriately during the next resize event.

### UI Defaults & Tooltips

- Set the `menubar` and `statusbar` to be visible by default for new users.
- Set the `file-panel` to be hidden by default.
- Added `title` attributes (tooltips) to all items in the file list (except `..`) so users can hover to read long, truncated filenames.
- Added `title` attributes to the View menu scaling options indicating their cycle shortcut `]` / `[`.

### Categorized Keybinds UI

- Replaced the flat keybind list in Options with categorized sections: Navigation, View, Zoom, Pan, Rotation, Window & UI, Files & Folders.
- Replaced basic text inputs with click-to-bind interactive tags and a persistent `+` button for alternative bindings.
- Added a circular `×` remove button inside tags that appears on hover and turns red to easily delete bindings.

### Options Tab Session Persistence

- Implemented `localStorage` memory for the active Options tab, persisting tab selection across Options window opens within the same app session.
- Added a `localStorage.removeItem` cleanup hook in `main.js` so the Options window naturally defaults to the General tab on a fresh program restart.

### Advanced Shortcut System: Multi-Key & Mouse Support

- Rewrote `options.js` and `shortcuts.js` capture logic to accumulate simultaneous keys in a `Set`.
- Combinations are now formed dynamically by recording the maximum key-press state and finalizing only on `keyup` when all keys are released (enabling arbitrary combos like `A + B`).
- Added native Mouse binding support (`MouseLeft`, `MouseMiddle`, `MouseRight`, `MouseBack`, `MouseForward`).
- Updated defaults to include `MouseForward` and `MouseBack` for Next/Previous item navigation.

### Options Conflict Highlighting

- Implemented dynamic, auto-generated color highlighting in the Options menu for keybind conflicts.
- `getConflictColors()` generates distinct, golden-ratio based hues evenly spread across the non-blue spectrum (skipping 190°-240°), assigning the exact same color to all tags sharing a conflicted combination.

### Keybind Failsafe & Deep Copy Fix

- Blocked removal of the final uncontested binding for the Menu Bar Toggle to prevent UI softlocks. (If the last binding is shared with another action, removal is permitted).
- Fixed a bug where saving or resetting keybinds unintentionally mutated the underlying `DEFAULT_KEYBINDS` by explicitly wrapping assignments in a deep copy (`JSON.parse(JSON.stringify())`).

### Managed-Config Favorites

- Moved favorites out of WebView2 `localStorage` into managed config (`frontend_data.favorites` and `frontend_data.favorites_collapsed`) so they persist through the normal config/portable machinery. (The one-time legacy `localStorage` migration was later removed since the app has not shipped — see "Favorites LocalStorage Migration Removal".)
- Collapsed/expanded favorites state is persisted and restored; empty lists auto-collapse and persist that state.
- Favorite items now support single-click highlight and double-click open for folders/archives, with the current folder/archive taking priority over the selected entry so a favorited location stays highlighted.

### Split Config Storage

- Roaming config is now split into separate files: `quivit_config.json` (preferences), `quivit_state.json` (last-opened/remembered-image state), `quivit_directory_sort.json` (per-directory sort), and `quivit_favorites.json` (favorites).
- Portable mode still writes a single self-contained `quivit_config.json` beside the executable; disabling portable mode removes portable leftovers.
- Legacy single-file config layouts load unchanged and are re-split on next save.
- **Data Resiliency & Unknown Fields:** Added `#[serde(default)]` to the Rust `AppConfig` struct. This prevents strict parsing failures if top-level fields (like `portable_mode`) are ever missing from the JSON file, while the underlying `frontend_data: JsonValue` securely round-trips all unknown or future frontend settings without dropping them. Verified via `cargo test`.

### Last-Active-Image Rewrite

- Replaced the per-folder `last_active_images` map with a single `last_active_image = { container, path }` pair.
- Restoration now runs only at program startup (via `restoreLastImage` from `Core.init()`), never during ordinary navigation, and always wins over the first-image/position logic when the container matches.
- The legacy `last_active_images` map key is dropped on config load.

### Open-First-Image Option

- Added the `open_first_image` config option (default OFF) with an Options checkbox "Open first image automatically".
- When ON, entering a directory or archive highlights the first image; when OFF, the target entry is highlighted instead.

### Sort-Aware Sibling Navigation

- Rewrote `openSibling` (`Ctrl+X`/`Ctrl+Z` next/previous directory or archive) to compute siblings client-side instead of via the Rust `open_sibling_container` command.
- Sibling order now follows the parent directory's current sort prefs (column + direction) through the same `DirectoryPrefs.applySort` used for the visible listing, so traversal matches the file panel order.
- Drive-root stepping (wrapping between physical drives) is retained, and `formatEntry` is applied so date sorting works.

### Archive Parent Navigation Fixes

- `..`/Backspace from a deleted or moved archive now falls back to the containing folder (via the new `parentOf` helper), then to the drives list if unreachable.
- `..` from an archive that is not listed (e.g. hidden with "show hidden" off) falls back to the first image, else the first item.

### Static Config-Folder Pointers

- Options now shows static "Global config folder (Roaming)" (`%APPDATA%\com.x4163.quivit`) and "Local config folder (portable)" (executable directory) pointers; they no longer track the "Save config data locally" state.
- Added backend commands `get_local_data_dir` / `open_local_data_dir` alongside the existing global folder commands.

### Toggle Favorite Keybind

- Added the `cmd-toggle-favorite` action (unbound by default) under the File Operations category in the Options keybind UI.
- `toggleFavoriteCurrent()` toggles the current folder/archive/image favorite and expands the favorites section when adding; wired through `dispatchAction` in `main.js`.

### Keybind Canonicalization

- Added `formatKeyName()` / `normalizeCombo()` in `shortcuts.js` with a `SPECIAL_KEY_MAP` so named keys are captured and stored with canonical casing (`Backspace`, `ArrowLeft`, `Delete`, `F5`, ...) instead of lowercase forms.
- `mergeConfig` normalizes all default and user keybinds on load, so previously stored lowercase combos display and persist consistently.

### Scroll-Wheel Pan vs Zoom (Manga Reading)

- Wheel input now routes through the keybind table instead of the viewer's hardcoded zoom handler, so scroll actions are fully remappable in Options → Keys.
- Defaults: `ScrollUp` / `ScrollDown` = Pan Up / Down (`cmd-pan-up` / `cmd-pan-down`) and `Ctrl+ScrollUp` / `Ctrl+ScrollDown` = Zoom In / Out (`cmd-zoom-in` / `cmd-zoom-out`).
- Wheel zoom zooms toward the cursor position (`Viewer.zoomAt` is now exported; `dispatchAction` accepts a wheel payload with `clientX`/`clientY`).
- Wheel pan uses a dedicated `VIEWER_WHEEL_PAN_STEP` (120px per notch), independent of the keyboard `VIEWER_KEYBOARD_PAN_STEP` (72px).
- Wheel events over the file panel, menu bar, dropdowns, or status bar are never hijacked so those UIs keep native scrolling (`isWheelOverUI`).
- Added a **Scroll Wheel** section to the Options Keys tab with a Hold Ctrl / Toggle Ctrl (sticky) modifier switch, persisted as `frontend_data.scroll_zoom_modifier` (`'hold'` default / `'toggle'`).
- In toggle mode, a standalone `Ctrl` tap latches zoom mode (synthesizing the `Ctrl` modifier in wheel combos) until `Ctrl` is tapped again; a `Ctrl+Scroll Zoom` badge appears in the status bar while latched. Ordinary `Ctrl` shortcuts (e.g. `Ctrl+X`) do not trip the latch.
- The keybind capture UI in `keybindUi.js` now supports binding wheel combos (`ScrollUp`, `Ctrl+ScrollDown`, ...) by scrolling while holding the desired modifiers.
- Added `ScrollUp` / `ScrollDown` to `SPECIAL_KEY_MAP` so wheel combos persist with canonical casing.

### Status Bar Class-Only Selectors & Non-Image Placeholders

- Deduplicated the status bar spans in `index.html`: each span now carries only its class (`.status-filename`, `.status-dims`, `.status-zoom`, ...), removing the redundant matching `id="status-*"` attributes.
- Updated `main.js` and `viewer.js` to query those spans via `document.querySelector('.status-*')` instead of `getElementById`.
- Non-image entries (folders, archives, `..`, drives) now render `N/A` in the dims and zoom status fields instead of stale metrics from a previously displayed image.

### File Association And Explicit-Open Bug Fixes

- Explicit file opens now bypass remembered-image restoration: first-instance CLI/file-association paths, warm `single-instance-open` handoffs, drag/drop opens, and the direct file/archive picker all pass `restoreLastImage: false` with target-preserving selection.
- Added async navigation generation guards in `fsUtils.js` so stale directory/archive/parent/refresh/sibling results are discarded instead of overwriting a newer fast navigation.
- Main-window config reload now reapplies persisted Custom CSS via the existing `quivit-config-loaded` event, matching the live CSS preview path without moving DOM work into `core.js`.
- Options Apply now saves without closing the window; Close exits the Options window.
- Options `config-changed` handling now refreshes live presentation state (theme, custom CSS, config-folder labels) without forcing a full window reload.
- Added Options notes explaining that "Continue from last active image" depends on "Continue from last opened directory", and that the single-instance setting requires restart.
- Clarified File Types UI wording: checkboxes mean QuiviT is registered for a format, while Windows Settings controls the active Windows 10/11 default handler.

### Options Apply/Preview Behavior & Window Lifecycle

- Theme and Custom CSS changes in Options are now **local previews only** — they apply instantly to both windows (`theme-preview` / `css-preview` events) but are no longer auto-saved on click. Clicking **Apply** persists them to config and emits `config-updated`; **Close/Cancel** re-fetches the saved config and reverts the live previews (theme + CSS) before closing.
- The Apply status message is no longer clobbered by association results: after `applyAssociations` runs, Apply preserves any "failed/error" status from the associations step instead of overwriting it with a generic success message.
- Added an `on_window_event` hook in `lib.rs` so closing the main window also closes the Options window (if open).

### File Association: Windows Default-Apps Registration

- **Registration now follows the VLC/qBittorrent/SumatraPDF pattern.** `register_associations` additionally writes `HKCU\Software\QuiviT\Capabilities` (ApplicationName / ApplicationDescription), `HKCU\Software\QuiviT\Capabilities\FileAssociations` (`.ext` → `QuiviT.<ext>`), and `HKCU\Software\RegisteredApplications\QuiviT` so QuiviT shows up in Windows Settings → Default Apps.
- **`get_format_status` now reads `UserChoice` first** (the real active default handler on Win10/11). If `UserChoice` exists and points at another program, the checkbox correctly stays unticked; it only falls back to the `Classes` default value when no `UserChoice` exists yet (fresh installs / unclaimed formats).
- `unregister_associations` now also removes extensions from `Capabilities\FileAssociations`, and when the last format is removed it deletes `Software\QuiviT` and drops the `RegisteredApplications` entry.
- The "Open Windows Default Apps Settings" button deep-links via `ms-settings:defaultapps?registeredAppUser=QuiviT` (Win11 23H2+), falling back to the generic page.
- Options → File Types wording updated: checking a box registers QuiviT as an *available* handler; on Windows 10/11 a format with no existing default (no `UserChoice`) gets QuiviT as its handler directly, while a format whose `UserChoice` points at another program can only be changed by the user — but Windows offers QuiviT in the automatic "How do you want to open this file?" picker that appears when opening such a file, as well as via "Open with" and Windows Settings.
- Select All / Deselect All buttons in the File Types tab work again (restored in the verification pass — their `onclick` handlers had been dropped in the dirty-tracking refactor).
- Added `.taurignore` so `npm run tauri dev` does not hot-reload when `quivit_config.json`, `.portable`, or `DEBUG_REG` change; `DEBUG_REG` added to `.gitignore`.

### Favorites Keyboard Navigation & Archive-Entry Favorites

- Added full keyboard navigation to the Favorites list: ArrowUp/Down, Home, End, Enter, Space, Escape with a tracked highlight (`highlightedFavoritePath`) mirroring the file-list selection model; single-click highlights, double-click opens directories/archives.
- Exported `getHighlightedFavorite()` and `navigateHighlightedFavorite(delta)` in `filePanel.js` for external consumers (main.js action buttons).
- Favorites for images inside archives now store composite "archive|entry" paths; added `loadArchive()` in `fsUtils.js` to handle these and restored `remember_last_image` / `open_first_image` logic there.
- Updated "Open in Explorer" and "Open Folder" action buttons in `main.js` to resolve real archive paths and container paths for both favorites and main-list archive entries.
- Added `.hidden` utility class in CSS; favorites header uses `classList.toggle('hidden', favs.length === 0)` instead of inline `style.display`.
- Favorites composite widget: focus ring on container (`#favorites-list:focus-visible`), remove-button focus visibility, ArrowUp/Down/Home/End/Enter/Space/Escape keydown handler on `#favorites-list`.

### Space/Arrow Key Hijacking Fix

- Fixed Space/Arrow key hijacking in `shortcuts.js` so they no longer prevent default when a button/input/textarea/select has focus (allows native button activation via Space).

### Persistent Scroll-Zoom Toggle Latch

- The scroll-wheel toggle latch (`ctrlLatched`, Options → Keys → Scroll Wheel → Toggle Ctrl) now persists across restarts as `frontend_data.scroll_zoom_latched`.
- Split into `quivit_state.json` in roaming mode via the new `STATE_KEYS` entry in `lib.rs`; portable mode keeps it inline in the single self-contained config file.
- `shortcuts.js` persists the latch whenever a clean Ctrl tap toggles it, and exports `syncScrollLatch(config)` which restores it after config load; `main.js` calls it on `quivit-config-loaded` (startup and Options Apply & Close).
- `syncScrollLatch` only applies the latch when the modifier is `'toggle'` — in `'hold'` mode a stale latch never shows the badge or latches zoom.

### Favorites LocalStorage Migration Removal

- Removed `migrateFavorites()` and the one-time `quivit-favorites` / `quivit-favorites-collapsed` WebView2-localStorage import from `filePanel.js`; the app has not shipped, so no legacy users exist and the migration was dead code.
- The `quivit-config-loaded` handler in `filePanel.js` now only marks config loaded and re-renders favorites.

### Persistence Policy Documentation

- Added a canonical persistence-policy comment block to the `core.js` header: which data belongs in `quivit_config.json` (preferences) vs `quivit_state.json` (last-known runtime state, `STATE_KEYS` in `lib.rs`) vs WebView2 `localStorage` (pre-paint caches and session-only state only — never a source of truth).
- Added `// persistence:` pointer comments in `keybinds.js` (`mergeConfig`), `shortcuts.js` (latch), and `filePanel.js` (favorites).

### Scaling Mode Backward Cycle

- Added a `cmd-cycle-scaling-back` keybind defaulting to `[` (mirror of the forward `]` cycle), so the three scaling modes can be cycled backward.
- `main.js` shares one switch case for both directions (`delta = actionId === 'cmd-cycle-scaling-back' ? -1 : 1`).
- Added the "Cycle Scaling Mode (Backward)" row to the Options Keys → View actions list in `keybindUi.js`.
- Updated the View-menu scaling tooltips to show the cycle shortcut as `] / [`.

### Fit None + Mouse Double-Click Keybinds

- Added `cmd-fit-none` ("Fit: None") to the View menu, `main.js` dispatch/menu wiring, and the Options Keys → View list; default binding is `['DoubleClick', 'r']`. `mergeConfig` adds it to existing configs.
- Removed the hardcoded viewport `dblclick` toggle in `viewer.js`; double-click now goes through the keybind table like any other gesture.
- Added `DoubleClick` / `DoubleRightClick` as bindable gestures in `shortcuts.js`: the mouse dispatch for left/right buttons waits out a 350 ms window so a rapid second press becomes the double gesture instead of two single `MouseLeft`/`MouseRight` dispatches. Dispatches are scoped to the viewport (excluded from `#file-panel`, `.menubar`, `.dropdown-menu`, `#statusbar`) so the file list's own double-click-to-open still works.
- Capture in `keybindUi.js` now recognizes both double-click gestures (same debounce window + position threshold) and fixed a bug where plain mouse-button bindings (`MouseLeft`/`MouseRight`) were discarded — `hasNonModifier` now also counts `maxButtons`, so a bare mouse gesture finalizes correctly.
- Middle-click (button 1) on a keybind tag removes that binding (alternative to the × button): the tag's middle `mousedown` is `preventDefault()`ed to block the browser's native autoscroll, and removal fires on the tag's `mouseup`, reusing the same removal path.
- The browser right-click context menu stays enabled in the options window generally but is suppressed during keybind capture (`onContextMenu`), so right-click / double right-click can be captured cleanly.
- Auto fit menu item now has `title=""`.

### Viewer: Top-Aligned Fit Modes + Focal Zoom 100%

- `applyFitMode` now top-aligns `none`, `width`, and `width-if-larger` (`_ty = (visualHeight - vh) / 2` when the image is taller than the viewport, `0` otherwise), so tall pages start at the top edge and scroll down; vertically-fitting images stay centered. The offset equals `_clampPan`'s `maxY` bound, so the clamp keeps it pinned.
- Refactored the wheel zoom math into a shared `zoomTo(exactScale, cx, cy)` helper (focal-point preserving) that both `zoomAt` and the new `setZoom` use.
- `setZoom` (Zoom 100%) now zooms to true size anchored on the viewport center: the content under the middle of the screen stays put instead of the image re-centering, and pressing `X` at 100% while panned no longer resets the pan.

### Keybind Capture Fixes

- **Middle-click removal works again.** Each keybind tag's `mousedown` handler now `preventDefault()`s button 1, blocking the browser's native autoscroll (which previously swallowed the click and suppressed `auxclick`); removal fires on the tag's `mouseup` for button 1 instead of relying on `auxclick`.
- **Middle mouse stays bindable.** During capture the window capture-phase listener `stopPropagation`s the tag events and already blocks autoscroll, and the tag's removal handler is additionally guarded by `isCapturing`, so `MouseMiddle` can be bound cleanly and middle-click removal is disabled while listening.
- **Context menu suppression covers the finalizing press.** `cleanup()` now keeps the capture's `onContextMenu` listener attached until the 100ms `isCapturing` reset instead of removing it synchronously — the `contextmenu` event that trails a finalizing right-click press (`mousedown → contextmenu`) used to escape suppression and pop the native menu on the second click of a `DoubleRightClick` capture.
- **Wheel capture no longer scrolls the page.** Wheel finalization is debounced (`WHEEL_SETTLE_MS = 300`): `onWheel` keeps `preventDefault`ing, shows the live combo (`ScrollUp` / `Ctrl+ScrollDown`, ...) on the element, and only `finish()`es once the gesture settles — a longer scroll no longer bleeds past the capture and scrolls the options page. The settle timer is cleared in `cleanup()`.
- **Initiating click counts as the first press of a double-click.** `captureKeybind` now receives the initiating click event and seeds `mousePress` from it, so clicking a tag/`+` then clicking once more within the window captures `DoubleClick` (2 presses) instead of requiring a triple-click. Right-click sequences and distant/delayed second presses are unaffected.

### Keybind Capture Consistency

- **Non-double mouse buttons commit instantly.** The capture debounce (waiting for a potential second press) now applies only to buttons 0/2 (`MouseLeft`/`MouseRight`), which have double-click gestures; `MouseMiddle`, `MouseBack`, and `MouseForward` finalize immediately on `mouseup` since they have no double state. This matches dispatch, which already treats buttons 1/3/4 as immediate.
- **Scroll capture is modifier-only.** `onWheel` builds the combo from held modifier keys (`Ctrl`/`Shift`/`Alt`/`Meta`) plus the scroll direction, ignoring non-modifier keys and mouse buttons — so `ScrollUp`, `Ctrl+ScrollUp`, and `Ctrl+Shift+ScrollUp` are bindable while `A+ScrollUp` is not, mirroring the double-click gestures (no key/button + gesture).
- **Scroll combos always read `Modifiers+Scroll`.** `formatKeysCombo` now pushes `scrollDir` last (after `others.sort()`), so a captured combo can never appear as `ScrollUp+a`; ordering is consistent on both capture and dispatch.
- **Lone modifier presses no longer get stuck.** When everything is released but the captured state is modifier-only (no real key/button/double), `updateState` resets `maxKeys`/`maxButtons` and shows `Listening...`, ignoring the press instead of leaving the stale modifier displayed. The next input captures normally. (Dispatch has always ignored bare modifiers — `shortcuts.js` returns early for `Control`/`Shift`/`Alt`/`Meta` keydowns — so this was purely a capture-UX fix.)

### Navigation Trail History

- Added `src/js/navigationHistory.js` as a leaf module (no DOM access, no imports) providing session-only container Back/Forward history: a 100-entry cap, `createHistoryEntry` (directory/archive/drives kinds with `selectedPath`/`selectedName` restoration), `recordNavigation` (`skip`/`replace` options), `goBack`/`goForward`, `canGoBack`/`canGoForward`, and a `quivit-history-changed` CustomEvent.
- Added Folder-menu Back/Forward commands (`cmd-history-back` / `cmd-history-forward`) defaulting to `Alt+W`/`Alt+A`, `Alt+S`/`Alt+D`, Arrow keys, and `MouseBack`/`MouseForward`; the side buttons were removed from Next/Previous so Back/Forward stay dedicated.
- `main.js` mutes the Back/Forward menu items (`aria-disabled`) when the corresponding stack is empty; no-op on empty.
- `recordNavigation` skips same-container navigation (image/page selection within one container never creates history entries) and refresh, so Back/Forward only record real folder/archive/drive changes. `loadHistoryEntry` restores the previously selected entry via sort-aware target paths.

### Refresh & Loading Polish

- Refresh now dispatches `quivit-refresh-start` / `quivit-refresh-end` window events; `filePanel.js` (`setRefreshingVisual`) pulses file-list and favorites rows (`.refreshing` class, `refresh-pulse` keyframes) during refresh.
- `#viewer-img` now animates its loading `alt` text (`Loading.` / `Loading..` / `Loading...`, ~320 ms cycle) while a new image preloads, then restores the loaded filename or error text once settled; `_currentPreloadSrc` guards stale preloads from overwriting a newer selection.

### Drag-and-Drop Overlay Refinements

- Overlay wording updated (`DEFAULT_DROP_MESSAGE` = "Drop files here, or click to open a folder"); clicking the drop overlay opens the folder picker.
- Overlay mouse events no longer start viewer panning (mousedown is stopped on the overlay).
- Unsupported dropped files now show an inline warning ("File type not supported" / "Path not found") for ~1.8 s instead of silently opening their parent directory; path kind validated via the new Rust `get_path_kind` command (directory/file/missing).

### UI Wording, Polish & Simple Toggles

- Portable-mode README wording clarified; Options labels shortened with `title` tooltips; language flag enlarged; View dropdown checkmarks track state (`cmd-toggle-filelist`, `cmd-toggle-menubar`, `cmd-toggle-statusbar`, `cmd-fullscreen`).
- Opaque Canvas (`cmd-toggle-transparent`) exposed in the Options Keys list.

### No-Image Flicker Fix

- `clearDisplayedImage()` in `viewer.js` clears the displayed image (`#viewer-img.src` removed, `_currentPreloadSrc` nulled) when entering the drag/drop screen or selecting folders/`..`, preventing stale-image flash before the next viewed image loads.

### Shell/Window Polish

- The main Tauri window background is set at startup from the saved theme (`apply_shell_background` in `lib.rs`): `frontend_data.theme` dark/light → `Color(37,37,38,255)` / `Color(255,255,255,255)` — the `--surface` values from `main.css`, since the shell mirrors the dominant visible page background (not the `--bg` backdrop) — with "system" resolved from the native window theme. `tauri.conf.json` sets the main window `backgroundColor`.
- Options window initial/min sizes already implemented.

### Directory Sort Limit

- Per-directory sort preferences are capped at 100 entries in `directoryPrefs.js`; the oldest key is dropped (FIFO) once the cap is reached.

### Dynamic Shell Background Sync

- Added `src/js/shellBackground.js`, a self-contained leaf module (IIFE, no deps) included on every page (`index.html`, `options.html`) that keeps the native window background in sync with the page's `--surface` color (the dominant visible page background — not the `--bg` backdrop). Reads the computed `--surface` via a hidden probe element (robust to hex/rgb/named colors and `var()` indirection), debounced, and re-syncs automatically through a MutationObserver on the `data-theme` attribute and `document.head` (catches `#custom-css` style changes), plus a `quivit:shell-sync` event for manual triggers. No-ops outside Tauri. Any new page that includes it gets shell sync for free.
- **Upstream API bug worked around**: the official `@tauri-apps/api` `Window#setBackgroundColor` wrapper invokes `plugin:window|set_background_color` with `{ color }`, but the backend command parameter is named `value` (an `Option<Color>`). Tauri's IPC silently deserializes a missing key to `None` (`deserialize_option`), so the wrapper actually *reset* the background to default (black) with no error. `shellBackground.js` bypasses the wrapper with `window.__TAURI__.core.invoke('plugin:window|set_background_color', { value: {...} })`; the mismatch is documented in both `shellBackground.js` and `lib.rs`.
- Added `core:window:allow-set-background-color` to `src-tauri/capabilities/default.json`.
- Debug scaffolding removed after verification: `SHELL_SYNC_ENABLED` flag, `syncShellBackground()` call sites in `main.js`, and the DEBUG-ONLY `transform: scale(0.95)` page-shrink rule in `main.css`.

### Custom CSS Cascade Priority

- The inline theme/custom-CSS head script in `index.html` and `options.html` now sits below the `<link rel="stylesheet">` tags, so the injected `#custom-css` `<style>` lands last in the head and wins the cascade. Because the script is still inline in the head (blocks parsing), it executes before first paint — no theme flicker.

### CSS Token Decoupling (`--bg` → `--field-bg`)

- `--bg` was overloaded: it served as both the page backdrop *and* component surfaces (menubar, inputs, tags, buttons), so customizing the backdrop unintentionally recolored controls. Decoupled:
  - Added a general `--field-bg` control-surface token to all three theme blocks of `main.css` (light `#f0f0f0` / dark `#1e1e1e` ×2) and to `matcha-latte.css` (`#f2ede4` / `#241c15` ×2), seeded with the old `--bg` values so the default look is preserved.
  - Moved `.flex-row input[type="text"]`, `.keybind-tag`, `.scroll-mode-btn`, and `textarea` onto `--field-bg`. The `textarea` previously referenced an undefined `--input-bg` (flicker/unstyled); fixed. `#menubar` uses the dedicated `--menu-bg`.
  - `--bg` now covers only real backdrops: `html/body`, `#viewport.empty`, and `#drop-overlay` (incl. the drag-over tint).
- `matcha-latte.css` ships at the repo root as the custom-CSS example.

### Theme/CSS Preview Persistence

- Previewing a theme or custom CSS in Options was silently wiped by the config file watcher: any main-window state persistence (`last_active_image`, statusbar/menubar toggles) rewrites `quivit_config.json`, the Rust watcher (`lib.rs`, 500ms debounce) emits `config-changed`, and both windows reload the *saved* theme/CSS — discarding the preview.
- `main.js` now tracks `previewTheme`/`previewCss` from the `theme-preview`/`css-preview` events and re-applies them on every config reload (`quivit-config-loaded`); they are cleared only on Options Apply (`config-updated`). Plain `config-changed` reloads keep the preview.
- `options.js` tracks a `previewing` flag (set on theme click / CSS preview; cleared on Apply, Close, and the emergency reset) that gates `refreshLiveConfigState()` so reloads don't revert the preview. Previews now persist until Apply or close-without-Apply.

## Verified Commands Used

```powershell
node --check src\js\main.js
node --check src\js\filePanel.js
node --check src\js\shortcuts.js
node --check src\js\options.js
node --check src\js\viewer.js
node --check src\js\keybinds.js
cd src-tauri
cargo check
```

## Runtime Smoke Tests Completed

- Launched `npm run tauri dev`.
- Pressed `3`; Options opened.
- Confirmed Tauri capability validation passed after Options close permission was added.

## Not Yet Fully Implemented

See `.agents/implementation-plan - additions.md` for the active backlog and sequencing.

### UI Module Decoupling
- Decoupled \menubar.js\ logic and DOM bindings.
- Decoupled \keybindUi.js\ from the options window, isolating configuration rendering and conflict tracking.
- Decoupled \keyboardNav.js\ to manage accessible tab navigation across menus and options uniformly.

### Options Tab Accessibility (Tab Navigation)
- Implemented accessible keyboard navigation flows (\Tab\/\Shift+Tab\) across all Options tabs.
- Added global \Home\ and \End\ shortcut jumps for immediately focusing the first and last tabbable elements within active scopes.
- Fixed \Enter\/\Space\ activation for dropdowns in the main menubar.

### Customization Tab & Custom CSS
- Added Theme selection (System / Light / Dark) that applies instantly and auto-saves to config to prevent state drift on window close.
- Added a Custom CSS textarea to inject raw styles into both windows dynamically.
- Implemented \Ctrl+S\ auto-save-and-apply shortcut while editing the CSS text area.
- Implemented a robust \Ctrl+Shift+Alt+C\ global emergency CSS reset that clears broken styles, broadcasts immediately across main and options windows, and persists to backend storage.

### File Panel Actions
- Added 'Reveal in File Explorer' and 'Open Folder in Explorer' actions.
- Bound these to clickable UI elements in the file panel header.
- Safely integrated Rust-backend explorer triggers across Windows platforms.

### Core Architecture Decoupling
- Extracted filesystem interaction logic from `core.js` into `fsUtils.js`.
- Extracted file list grouping and sorting logic into `directoryPrefs.js`.
- Refactored `main.js` shortcut dispatching to directly route commands via a switch statement, bypassing DOM programmatic click bugs.
- Fixed shortcut case-insensitivity matching and preserved multi-key combo accuracy.

### File-Type Semantics
- Ensure `..`, folders, and archives are not treated as image files.
- Ensure selecting these entries does not attempt to display them in the viewer.
- Archives are treated like folders in the file list (Enter/Space opens them, double-click opens them, archive scope includes `..` navigation).

### Persistent Directory Sorting
- Implemented per-directory sorting and grouping that separates drives, folders, and files before applying the sort.
- Persisted sorting order globally or in portable config depending on portable mode.
- Sorting gracefully falls back to default settings per-directory, allowing independent sort states.

### Drive Jumping
- Modified `open_sibling_container` to detect when the user is at the root of a drive (e.g., `C:\`) and jump to the next/previous physical drive (e.g., `D:\`) upon container traversal (`Ctrl+X` / `Ctrl+Z`).
- Added sibling container jump shortcuts to the File dropdown menu.

### SVG Viewer Fixes
- Added `MAX_SCALE` and fixed intrinsic dimension fallback in `viewer.js` to prevent indefinite zoom on certain SVG files without defined widths.

### Transparent Background
- Added `opaque-bg` class and toggle logic for transparent background visualization against dark/light backdrops.
- Added `cmd-toggle-transparent` keybind and wired it to the Options and View menu.

### File Panel Favorites & Icons
- Added inline SVG icons for Image, Folder, and Archive files in the file list.
- Implemented Favorites UI header section in `filePanel.js` and `index.html`.
- Implemented star/favorite logic and persistence using `localStorage`.

### Single Instance Option
- Added `tauri-plugin-single-instance`.
- Wired file arguments to `FsUtils.loadFile()` upon secondary launch.
- Enabled focus transfer to the primary window.
- Added "Allow only one QuiviT instance" toggle in the Options menu.

### ICO Spritesheets
- Added `image` crate with `ico` feature.
- Implemented `get_ico_frames` Rust command to parse ICO files, arrange frames horizontally, and serve them securely as a base64 PNG data-url.
- Updated frontend to await `get_ico_frames` dynamically for `.ico` files.

### Options & State Persistence
- Added "Remember last active image" Options checkbox.
- Implemented logic in `fsUtils.js` and `core.js` to remember and automatically jump to the last active image when entering a directory.

### Archive Performance Overhaul

- **Instant archive listing**: Added \list_archive\ Tauri command that reads only archive headers (central directory) for ZIP/CBZ/RAR/CBR, returning file lists instantly without extracting images.
- **Hybrid caching strategy**:
  - ZIP/CBZ: On-demand in-memory LRU cache (20 images) with \prefetch_archive_entries\ command for background prefetching (7 ahead / 3 behind).
  - RAR/CBR: Background sequential extraction to OS temp directory (\%TEMP%\\QuiviT\\<hash>\\) via spawned thread; \quivit://\ protocol polls temp disk with 3-second timeout.
- **Unified protocol handler**: \quivit://archive/<base64_path>/<entry>\ now routes seamlessly — serves from LRU cache (ZIP) or temp disk (RAR), with on-demand extraction fallback for ZIP cache misses.
- **Seamless image swapping**: \iewer.js\ uses off-screen \Image\ preloader — retains previous image on screen until new image fully loads, eliminating flicker/black frames during navigation.
- **Prefetch integration**: \core.js\ triggers \prefetchAhead\ on navigation; \sUtils.js\ triggers initial prefetch on archive load.
- **Dependencies**: Added \md5\ crate for deterministic temp directory naming.
- **Cleanup**: Old RAR temp directories cleaned up on new archive load; ZIP LRU evicts oldest entries at capacity.

### 7Z/CB7 and TAR/CBT Archive Support

- **New formats**: `list_archive` now handles 7z, cb7, cbt, and tar in addition to zip/cbz/rar/cbr; `SUPPORTED_ARCHIVES` updated in Rust and `fsUtils.js`; file panel icons map 7z/cb7/cbt/tar to the cbz archive icon.
- **7Z/CB7 (7z, cb7)**: Added \list_7z_entries\ (header-only via `sevenz-rust2` file metadata — instant, no decompression) and \extract_7z_to_temp\. Solid 7z archives are single-block and not seekable, so they use the same background sequential extraction to the deterministic md5 temp dir as RAR (no ZIP-style random access). Background extraction runs in a spawned thread; protocol handler serves from temp disk with a 3-second poll, then on-demand extraction fallback for cache misses.
- **TAR/CBT (tar, cbt)**: TAR is uncompressed and seekable, so \list_tar_entries\ lists on demand and \extract_tar_entry\ seeks + reads individual entries directly — no temp copy, no full extraction.
- **Dependencies**: Added \sevenz-rust2 = "0.21"\ and \tar = "0.4"\.
- **ArchiveCache**: \rar_temp_dir\ generalized to \extract_temp_dir\ for the 7z/RAR shared temp-disk path.
- **Tests**: Added \archive_tests\ module (6 tests) covering solid 7z listing + nested extraction to temp, cb7 alias routing, tar listing + entry extraction, RAR5/CBR listing, and supported-format registration. Verified \cargo test\ (6/6 pass), \cargo check\, and \node --check\ on frontend files.
- **Test fixtures**: \test-files/archives/7z.7z\ (solid LZMA2, 14 files incl. `New folder/` nesting) and \test-files/archives/cbr.cbr\ (non-solid RAR5). The \test-files/archives/cbt.cbt\ fixture is self-provisioned by the \ensure_cbt()\ test helper, which rebuilds it (validating 3 entries) from images re-packed out of the 7z fixture via the \tar\ builder — no external 7z/7za tool needed in tests.

### Non-Blocking Archive Protocol & Loading States

- **Threaded Protocol Handler**: Wrapped the `quivit://` URI scheme protocol handler in a background `std::thread::spawn` on Windows, preventing the WebView I/O threads from blocking during heavy solid-archive extraction. This fixes the application icon reverting to a generic executable and keeps the UI responsive.
- **Frontend Loading Feedback**: `viewer.js` now immediately writes "Loading..." into the statusbar fields (filename, dimensions, zoom) when a new image fetch begins. Once the fetch completes successfully (or errors out), the actual filename and metrics are restored. `main.js` was updated to only eagerly write filename on state change if the image has already successfully loaded.

### File Navigation DOM Virtualization (O(1) Rendering)
- **Large Directory DOM Rendering Performance**: Completely refactored `filePanel.js` list rendering by introducing a virtualized DOM pool. The file panel now strictly maintains a fixed array of pre-allocated `<li>` elements (e.g. ~50 nodes matching the current viewport space). These elements are recycled via `position: absolute` transforms hooked into the `scroll` event. `ROW_HEIGHT` is measured dynamically using a hidden probe on initialization to accommodate custom CSS font-sizes. This guarantees $O(1)$ initial UI responsiveness and eliminates layout freezing for large folders and archives holding thousands of items.
