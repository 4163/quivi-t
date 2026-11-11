This report was compared against .agents/skills/validate-changes/SKILL.md and .agents/AGENTS.md before presentation.

# Audit 06: Rust platform, window management, and Windows Explorer previews

Zone 6 audit covering Rust window lifecycle, file association registry IPC, Windows platform integration, native OLE drag-and-drop, temp archive origin matching, and the Explorer COM preview and thumbnail subsystem.

## Validate-changes compliance findings

### Rust module ownership and boundary enforcement

- `src-tauri/src/commands/registry.rs:48-647` [Blocking]. `commands/registry.rs` contains 600 lines of raw Win32 registry manipulation, ProgID creation, shell association state, format icon disk provisioning, and Explorer diagnostic queries. The file violates the AGENTS.md rule that command files must act strictly as thin IPC adapters that adapt domain modules. The entire registry domain logic belongs in `src-tauri/src/platform/registry.rs` or `src-tauri/src/platform/associations.rs`.
- `src-tauri/src/commands/drop.rs:38-45` [Warning]. `commands/drop.rs` calls directly into `crate::commands::library::publish_captured_image`. Modules in `commands/` must not call into sibling command modules. They should delegate to domain modules. In addition, line 43 executes `std::thread::sleep(LIBRARY_RETRY_DELAY)` inside an async command thread, blocking worker execution.
- `src-tauri/src/windows.rs:152` [Blocking]. `windows.rs` reaches directly across module boundaries into `crate::config::load_config(app.clone())` during secondary workspace window creation, cloning the app handle and reading configuration from disk. This violates the AGENTS.md rule that windows, platform, protocol, and config must stay out of bootstrap and out of each other.
- `src-tauri/src/windows.rs:166, 173` [Warning]. `windows.rs` reaches directly into `crate::platform::drop::install` and `crate::platform::drop::uninstall`. Window construction should not directly orchestrate platform OLE drop target wiring without a facade boundary.
- `src-tauri/src/platform/direct_open.rs:44`, `src-tauri/src/platform/previews/host.rs:304`, `src-tauri/src/platform/previews/windows.rs:281, 410`, and `src-tauri/src/commands/registry.rs:268, 297, 340, 386, 439, 567` [Warning]. Five distinct platform and command files reach into `crate::config::is_e2e_suite()` and `crate::config::roaming_dir_path()`. Configuration checking should be passed through arguments or managed via a shared environment check rather than reaching directly into `config.rs`.

### HTML-first and CSS source-of-truth rules

- `src-tauri/src/platform/previews/windows/preview_player.html` [Nit]. The file adheres to HTML-first rendering. It uses static markup with placeholder elements for image, canvas, and status, and toggles visibility via the `.hidden` class rather than creating elements at runtime.
- `src-tauri/src/platform/previews/windows/preview_player.css` [Warning]. Uses static template tokens `__BACKGROUND__` and `__FOREGROUND__` at lines 2 and 3 that require string replacement in Rust before serving. It does not load `global.css`, which is justified because it runs in an isolated out-of-process WebView2 preview pane, but the template tokens bypass normal CSS property declarations.
- `src-tauri/src/platform/previews/windows/preview_player.js` [Nit]. Follows CSS source-of-truth rules. Lines 66-67 write CSS variables `--svg-width` and `--svg-height` to the element rather than setting inline width and height styles. Lines 81-82 mutate `canvas.width` and `canvas.height` as HTML canvas pixel dimensions, not CSS styles. Line 20 sets `event.dataTransfer.dropEffect = 'none'` to block drag-and-drop within the preview pane. Line 609 of `src-tauri/src/platform/previews/windows/image_pane.rs` runs inline script evaluation via `view.evaluate_script` to update documentElement CSS custom properties at runtime.

### Test visibility and file placement

- `src-tauri/src/platform/attributes.rs:81-97` [Warning]. An inline `#[cfg(test)] mod tests` block is placed directly in `attributes.rs`. AGENTS.md requires tests to live under `tests/` via `#[path]`.
- `src-tauri/src/lib.rs:217-218` and `src-tauri/src/tests/temp_archive_tests.rs:1-6` [Blocking]. `temp_archive_tests.rs` is mounted in `lib.rs` instead of being scoped inside `platform/temp_archive.rs`. Because the test file lives at crate root, 14 internal functions and helpers in `platform/temp_archive.rs` were forced to become `pub`: `sevenzip_creator_pid_low12` at line 181, `select_sevenzip_live_candidates` at line 193, `enumerate_top_level_windows` at line 269, `get_winrar_address_bar` at line 371, `get_7z_address_bar` at line 447, `get_nanazip_address_bar` at line 498, `collect_candidates` at line 687, `deduplicate_candidate_archives` at line 962, `parse_winrar_window_title` at line 1117, `parse_7z_folder_history` at line 1151, `parse_7z_window_title` at line 1194, `parse_bandizip_window_title` at line 1231, `parse_bandizip_archive_name` at line 1241, `parse_peazip_window_title` at line 1253, and `match_candidate_origin` at line 1333. AGENTS.md explicitly states: "Tests live under `tests/` via `#[path]`; do not widen visibility for tests." Mounting `temp_archive_tests.rs` directly within `platform/temp_archive.rs` eliminates the need for any of these functions to be public.
- `src-tauri/src/platform/previews/host.rs:148, 231, 328-330` [Nit]. `previews_tests.rs` is correctly mounted inside `host.rs` via `#[path = "../../tests/previews_tests.rs"] mod tests;`, but `host.rs` still marked `ensure_previews_host_from` and `decide_host_action` as `pub(crate)` rather than keeping them private to the module.

## Monolithic file decoupling and ownership plan

### `platform/previews/windows/com_server.rs` decomposition

`com_server.rs` contains 2,848 lines. It combines five distinct architectural responsibilities into a single file.

#### Responsibility map

1. COM class factory and message pump lifecycle (`src-tauri/src/platform/previews/windows/com_server.rs:1-344, 446-459`). Implements `run()`, `run_initialized()`, `run_pump()`, `pump_proc()`, and the hidden message pump window `QuiviTPreviewPump`. Manages COM initialization, idle shutdown timers, `IClassFactory_Impl` (`CreateInstance`, `LockServer`), and task dispatching.
2. COM preview handler interface boilerplate (`src-tauri/src/platform/previews/windows/com_server.rs:346-444, 481-707`). Implements `IInitializeWithFile`, `IInitializeWithItem`, `IObjectWithSite`, `IOleWindow`, `IPreviewHandlerVisuals`, and `IPreviewHandler`. Manages `PreviewState`, parameters, job tracking, and deferred pump task scheduling.
3. Pump task orchestration and child window hosting (`src-tauri/src/platform/previews/windows/com_server.rs:709-933, 1722-1820`). Dispatches pump tasks (`TASK_CREATE`, `TASK_POSITION`, `TASK_TEARDOWN`, `TASK_BACKGROUND`, `TASK_FOCUS`). Implements `create_preview_child()`, `register_preview_class()`, `spawn_preview_worker()`, and links `ImagePane` with `PreviewPane`.
4. Theme detection and color models (`src-tauri/src/platform/previews/windows/com_server.rs:935-1022`). Defines the `Theme` struct, parses registry key `AppsUseLightTheme` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, and computes color luminance.
5. Archive tree data structure and virtualization (`src-tauri/src/platform/previews/windows/com_server.rs:1024-1200`). Defines `TreeNode`, `ArchivePreview`, `build_tree()`, natural order sorting via `natord`, visible row calculation, and node expansion state.
6. Shell icon resolution and caching (`src-tauri/src/platform/previews/windows/com_server.rs:1201-1505`). Defines `IconCache`, inspects registry for ProgID DefaultIcon values, loads icons from file via `LoadImageW`, and extracts icons from the Windows Shell Image List using `SHGetFileInfoW` and `SHGetImageList`.
7. Hit-testing, scrollbar math, and user input handling (`src-tauri/src/platform/previews/windows/com_server.rs:1527-1712, 1822-2166`). Computes scrollbar geometry, tracks mouse dragging, implements `preview_window_proc()`, handles left click, double click, mouse move, mouse leave, mouse wheel, and keyboard navigation.
8. Application executable discovery and archive entry launch (`src-tauri/src/platform/previews/windows/com_server.rs:2168-2263`). Locates the main QuiviT binary via `direct_open::selected_exe()`, sidecar paths, or the registry open command, and spawns the app with `archive_path|entry_name` arguments.
9. GDI double-buffered painting (`src-tauri/src/platform/previews/windows/com_server.rs:2265-2848`). Implements `paint_preview()`, `paint_now()`, `paint_double_buffered()`, `render_content()`, `draw_header()`, `draw_archive()`, `draw_scroll_arrow()`, `draw_chevron()`, `draw_border()`, and `draw_text()`.

#### Proposed decomposition

Decompose `src-tauri/src/platform/previews/windows/com_server.rs` into focused submodules under `src-tauri/src/platform/previews/windows/`:

1. `mod.rs`: exports the public interface (`run()`, `log_event()`).
2. `com_server/host.rs`: COM class factory, hidden pump window (`QuiviTPreviewPump`), `pump_proc`, message pump loop, and idle shutdown timers.
3. `com_server/handler.rs`: implementations of `IPreviewHandler`, `IPreviewHandlerVisuals`, `IObjectWithSite`, `IOleWindow`, `IInitializeWithFile`, and `IInitializeWithItem`. Manages state and posts tasks to the pump.
4. `com_server/tree.rs`: `TreeNode`, `ArchivePreview`, natural sorting, and row virtualization.
5. `com_server/icons.rs`: `IconCache`, high-resolution icon resolution, and Shell image list integration.
6. `com_server/window.rs`: Win32 child window procedure, scrollbar geometry, hit-testing, and keyboard and mouse input handling.
7. `com_server/paint.rs`: GDI double-buffered painting, header rendering, tree row rendering, chevron and scroll arrow drawing, and text formatting.
8. `com_server/launcher.rs`: `find_quivit_app_exe` and `open_item_in_app`.

### `platform/temp_archive.rs` decomposition

`temp_archive.rs` contains 1,478 lines. It combines archive engine heuristic detection, low-level Win32 window and desktop enumeration, UI Automation COM calls, archiver history inspection, and entry matching.

#### Responsibility map

1. Archiver engine detection (`src-tauri/src/platform/temp_archive.rs:9-162`). Parses temp path patterns for Explorer, PeaZip, WinZip, WinRAR, 7-Zip, NanaZip, and Bandizip.
2. Win32 desktop and window enumeration (`src-tauri/src/platform/temp_archive.rs:164-363`). Enumerates window stations (`WinSta0`), desktops, and top-level windows using `EnumWindows`, `EnumDesktopsW`, and `EnumDesktopWindows`.
3. Window child control inspection (`src-tauri/src/platform/temp_archive.rs:370-685`). Inspects Edit controls via `SendMessageTimeoutW` (WM_GETTEXT) for WinRAR and 7-Zip, invokes `CUIAutomation8` via COM on a background thread for NanaZip, and inspects `SysTreeView32` controls for Bandizip.
4. Archiver configuration and history collection (`src-tauri/src/platform/temp_archive.rs:687-819, 1058-1115`). Reads registry MRUs for WinRAR, Bandizip, 7-Zip, WinZip, reads PeaZip `conf.txt`, reads NanaZip UWP package `User.dat`, and scans Explorer folders.
5. Candidate archive deduplication and title parsing (`src-tauri/src/platform/temp_archive.rs:821-1017, 1117-1266`). Deduplicates candidates case-insensitively, handles 7-Zip conflicting subfolders, and parses window title strings.
6. Archive origin matching (`src-tauri/src/platform/temp_archive.rs:1268-1478`). Coordinates requests, opens candidate archives using `ArchiveCache`, and matches entries by relative path and uncompressed byte size.

#### Proposed decomposition

Decompose `src-tauri/src/platform/temp_archive.rs` into submodules under `src-tauri/src/platform/temp_archive/`:

1. `mod.rs`: exports `resolve_temp_origin()` and `resolve_temp_origin_with_cache()`.
2. `engines.rs`: `TempEngine` definition and path heuristic parsers.
3. `window_inspect.rs`: Win32 window station enumeration, child window message queries, NanaZip UI Automation, and Bandizip tree inspection.
4. `history.rs`: registry history readers, PeaZip configuration reader, and NanaZip package data reader.
5. `matcher.rs`: candidate deduplication, candidate archive scoring, and `match_candidate_origin()`.

### `commands/registry.rs` and `platform/drop.rs` decoupling

#### commands/registry.rs

All registry manipulation and icon provisioning must move to a domain module:

- Move lines 48-109 (`get_format_status`), lines 112-242 (`get_preview_diagnostics`), lines 244-290 (`sync_image_thumbnail_overlay`, `sync_preview_associations_impl`), lines 292-332 (`spawn_launch_previews_sync`), lines 360-376 (`provision_format_icons`), lines 435-552 (`register_associations_impl`), and lines 563-647 (`unregister_associations_impl`) into `src-tauri/src/platform/registry.rs` or `src-tauri/src/platform/associations.rs`.
- `commands/registry.rs` should contain only thin IPC command handlers that accept arguments, call the domain facade, and return results.

#### platform/drop.rs

`platform/drop.rs` currently mixes COM `IDropTarget` window registration, clipboard format negotiation, data extraction, lease tracking, and image staging.

- Separate into:
  1. `platform/drop/target.rs`: `NativeTarget`, `IDropTarget_Impl` (`DragEnter`, `DragOver`, `DragLeave`, `Drop`), `IDataObjectAsyncCapability` handoff, and `RegisterDragDrop` / `RevokeDragDrop`.
  2. `platform/drop/formats.rs`: `Formats` registry, clipboard format queries, HDROP file queries, and FileGroupDescriptorW extraction.
  3. `platform/drop/staging.rs`: `Registry`, `Pending`, `Capture`, `CaptureLease`, background watchdog thread, and abandoned capture cleanup.

### Undocumented files missing from `.agents/architecture-state.md`

The following files are actively maintained but completely absent from `.agents/architecture-state.md`:

1. `src-tauri/src/platform/previews/contract.rs`: defines CLSIDs, category GUIDs, and the thumbnail proxy DLL name.
2. `src-tauri/src/platform/previews/windows/bitmap.rs`: implements `Bitmap` RAII wrapper for 32-bit top-down DIB sections and `paint_buffered` double-buffering.
3. `src-tauri/src/platform/previews/windows/preview_player.html`: HTML structure for WebView2 preview playback.
4. `src-tauri/src/platform/previews/windows/preview_player.css`: style sheet for the preview player.
5. `src-tauri/src/platform/previews/windows/preview_player.js`: WebCodecs ImageDecoder player and SVG dimension coordinator.

In addition, `.agents/architecture-state.md` uses underscore naming (`quivit_previews_host.exe` and `quivit_thumbnail_proxy.dll`) whereas the codebase defines hyphenated constants: `quivit-previews.exe` (`host.rs:14`) and `quivit-thumbnail-proxy.dll` (`contract.rs:4`).

## Performance, Win32 and COM resource lifecycle, and concurrency

### Handle leaks, memory overhead, and resource lifecycles

- `src-tauri/src/platform/previews/windows/bitmap.rs:14-39`. `paint_buffered` creates a compatible DC and compatible bitmap via GDI on every single call. During window sizing or continuous mouse hovering in the archive tree, this function allocates and deletes GDI bitmaps on every frame. If allocation fails, it falls back to unbuffered painting without a persistent buffer.
- `src-tauri/src/platform/previews/windows/image_pane.rs:450`. The custom protocol handler serves `/media` by calling `Cow::Owned(media.to_vec())`. `media` is an `Arc<[u8]>` that can hold up to 128 MB (`MAX_MEDIA_BYTES`). Invoking `media.to_vec()` creates a complete, heap-allocated copy of the entire raw image file on every fetch. Serving directly from the existing `Arc<[u8]>` slice without reallocating would prevent severe memory spikes.
- `src-tauri/src/platform/previews/windows/image_pane.rs:388-396`. Every call to `create_webview` resolves the local low app data directory by calling `SHGetKnownFolderPath` and freeing the path with `CoTaskMemFree`. This path is invariant and should be computed once and cached.
- `src-tauri/src/platform/thumbnails.rs:117-121` versus `src-tauri/src/platform/dialog.rs:18-35`. Inconsistent COM apartment initialization semantics. `thumbnails.rs` checks if `CoInitializeEx` returned `S_OK` (0) before arming `ComGuard` to call `CoUninitialize`. In contrast, `dialog.rs` wraps `CoInitializeEx` in `ScopedCoInit`, ignores the return value, and unconditionally calls `CoUninitialize` on drop. If `dialog.rs` runs on a thread already configured for multithreading (MTA), `CoInitializeEx` returns `RPC_E_CHANGED_MODE`, and the unconditional `CoUninitialize` corrupts the thread COM apartment state.
- `src-tauri/src/platform/previews/windows/com_server.rs:1201-1266`. `IconCache` never purges cached `HICON` handles during the lifetime of a preview pane. When navigating between deep archive folders, icons accumulate in memory until the pane window is destroyed.

### Icon caching, thumbnail generation, and mutex contention

- `src-tauri/src/platform/icons.rs:33`. `static NATIVE_ICON_CACHE: Mutex<Option<HashMap<String, Vec<u8>>>>` has no size limit or eviction policy. Over extended sessions browsing directories with numerous distinct file extensions, this cache grows without bound, violating the AGENTS.md rule requiring named constants for cache capacities.
- `src-tauri/src/platform/previews/windows/thumb_server.rs:42, 254`. A single process-wide mutex `static DECODE_LOCK: Mutex<()>` guards every call to `decode_first_frame`. When Explorer requests thumbnails for a directory containing dozens of images simultaneously across multiple threads, all decoding threads serialize behind this single lock, completely eliminating multithreaded decoding concurrency.
- `src-tauri/src/platform/thumbnails.rs:84-263`. `get_shell_thumbnail_png` contains no in-memory thumbnail cache. Every request from the frontend causes a full round-trip through `IShellItemImageFactory.GetImage`, creating temporary GDI DCs, allocating a DIB section, executing `BitBlt`, converting BGRA pixels to RGBA, and compressing the result into PNG bytes.
- `src-tauri/src/platform/thumbnails.rs:106-113, 308-322`. Redundant filesystem I/O. When evaluating a GIF, lines 106-113 open the file and read 256 KB to check animation status. Later, lines 242-247 invoke `source_has_transparency`, which opens the same file a second time and reads 1,024 bytes to check for transparency. Both checks should share a single initial header buffer.

### Temp archive filesystem and process scan startup latency

- `src-tauri/src/platform/temp_archive.rs:687-950, 1268-1331`. When opening any file extracted to `%TEMP%`, `resolve_temp_origin` runs synchronously. It performs an exhaustive series of blocking operations:
  1. Inspects registry histories across four separate archivers.
  2. Enumerates all top-level windows and opens secondary desktop handles.
  3. Spawns a background thread that invokes UI Automation via `CUIAutomation8` for NanaZip windows.
  4. Sends synchronous `SendMessageTimeoutW` messages to child windows.
  5. Scans `%USERPROFILE%\Downloads`, `%USERPROFILE%\Desktop`, `%USERPROFILE%\Documents`, and `%LOCALAPPDATA%\Packages`.
  6. Reads headers of every candidate archive from disk using `ArchiveCache::prepare_archive`.
  If called on the main or command thread during startup or navigation, this process causes visible freezing and UI stutter.

### Native drop capture lease retention deadlock

- `src-tauri/src/platform/drop.rs:99-106, 176-200, 345`. When a drag-and-drop operation is received, a `Pending` lease is created in `registry().pending`. When the frontend receives the `quivit-drop` event, it calls `describe_drop()`.
- Line 198 inside `describe()` marks `pending.acknowledged = true`.
- If the drop is subsequently aborted, cancelled by the user, or encounters an error before the frontend calls `claim()` or `release()`, the watchdog expiration check in lines 100-106 fails:
  ```rust
  fn expired(&self, worker_running: bool) -> bool {
      if worker_running {
          self.created.elapsed() > SOURCE_TIMEOUT
      } else {
          !self.acknowledged && self.created.elapsed() > CAPTURE_LIFETIME
      }
  }
  ```
- Because `self.acknowledged` is `true`, `!self.acknowledged` evaluates to `false`. The pending drop never expires.
- Line 345 in `DragEnter` requires `state.pending.is_none()`:
  ```rust
  let available = {
      let state = registry().lock().unwrap();
      state.enabled && !state.worker_running && state.pending.is_none()
  };
  ```
- Because `state.pending` is never cleared, all subsequent drag-and-drop operations into QuiviT are rejected permanently until the application is restarted. This is a severe state leak and operational deadlock.

## Multi-window lifecycle and DPI or sizing parity

### Size constants and contract synchronization

- Rust size definitions in `src-tauri/src/windows.rs`:
  - Main window: initial 1280x720, minimum 640x400 (lines 28-31).
  - Options window: initial 560x620, minimum 400x360, maximum width cap 560.0 (lines 45-51).
  - Metadata window: initial 400x600, minimum 320x280, maximum height cap 600.0 (lines 55-61).
  - File list detached window: initial width 440.0, height 720.0, minimum 320x400 (lines 37, 142-143).
- JavaScript size definitions in `src/js/shared/windowFit.js`:
  - `OPTIONS_MAX_INITIAL_W = 560` (line 4).
  - `META_MAX_INITIAL_H = 600` (line 5).
- Sizing contracts are in parity between Rust and JavaScript. However, `OPTIONS_MAX_W` and `META_MAX_H` in `windows.rs` are marked `#[allow(dead_code)]` because they are only enforced on the JavaScript side.

### DPI scaling and window centering race conditions

- `src-tauri/src/windows.rs:328-373`. `center_window_over_main` calculates centering geometry by taking the scale factor of `main`:
  ```rust
  let target_w = (target_width * scale) as i32;
  let target_h = (target_height * scale) as i32;
  ```
  It then calls `window.set_size(LogicalSize::new(target_width, target_height))` followed by `window.set_position(PhysicalPosition::new(x, y))`.
  In a multi-monitor environment with heterogeneous DPI scaling (such as a 100% laptop display and a 175% external monitor), a newly built hidden window is created on whichever monitor the OS defaults to. Calling `set_size` using logical coordinates converts using the child window's current monitor scale. Moving the window to `main`'s monitor changes its DPI, causing Windows to resize the window a second time and producing incorrect layout geometry or off-center positioning.

### Detached workspace window and tray restore races

- `src-tauri/src/windows.rs:152-164`. Redundant background application. In `open_workspace_window`, line 152 calls `apply_shell_background(&window, ...)`. Three lines later, lines 155-164 query `main.theme()` and immediately overwrite the background color with a second call to `window.set_background_color(Some(color))`.
- `src-tauri/src/windows.rs:170-176, 180-190`. When a detached file list window is closed, line 174 emits `workspace-detached-closed` from the `WindowEvent::Destroyed` handler. In `close_workspace_window`, if the window was already destroyed, line 186 emits a duplicate `workspace-detached-closed` event. If the user clicks the title bar close button while a docking command is in progress from the UI, two events fire in rapid succession, racing against workspace layout reconciliation in `src/js/main/workspace.js`.
- `src-tauri/src/windows.rs:457-471`. Tray restore state resurrection. `SECONDARY_WINDOWS` contains `["options", "metadata", "workspace-file-list"]`. In `hide_to_tray`, all open secondary windows are hidden. When `restore_from_tray` runs:
  ```rust
  for label in SECONDARY_WINDOWS {
      if let Some(window) = app.get_webview_window(label) {
          let _ = window.show();
          let _ = window.unminimize();
      }
  }
  ```
  If `options` or `metadata` existed in memory but were hidden by the user before QuiviT was sent to the tray, restoring from the tray unconditionally shows them, resurrecting windows the user had previously closed.

## Redundant code, shared helpers, and stale references

### Duplicated Win32 wide string conversion helpers

Ten distinct callsites manually allocate and iterate wide null-terminated UTF-16 vectors instead of using a shared helper:

1. `src-tauri/src/platform/attributes.rs:16-19`: `OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect()`
2. `src-tauri/src/platform/icons.rs:107-110`: `OsStr::new("warmup.txt").encode_wide().chain(std::iter::once(0)).collect()`
3. `src-tauri/src/platform/icons.rs:205-208`: `OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect()`
4. `src-tauri/src/platform/icons.rs:211-214`: `OsStr::new("dummy").encode_wide().chain(std::iter::once(0)).collect()`
5. `src-tauri/src/platform/icons.rs:222-225`: `OsStr::new(&name).encode_wide().chain(std::iter::once(0)).collect()`
6. `src-tauri/src/platform/thumbnails.rs:123-126`: `OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect()`
7. `src-tauri/src/platform/previews/windows/com_server.rs:1388-1391`: `OsStr::new(path.as_os_str()).encode_wide().chain(std::iter::once(0)).collect()`
8. `src-tauri/src/platform/previews/windows/com_server.rs:1435-1438`: `OsStr::new(&name).encode_wide().chain(std::iter::once(0)).collect()`
9. `src-tauri/src/platform/previews/windows/com_server.rs:1471-1474`: `OsStr::new("dummy").encode_wide().chain(std::iter::once(0)).collect()`
10. `src-tauri/src/platform/previews/windows/com_server.rs:1482-1485`: `OsStr::new(&name).encode_wide().chain(std::iter::once(0)).collect()`

These should be consolidated into a single helper in `src-tauri/src/platform/mod.rs` or `src-tauri/src/utils.rs`.

### Duplicated GDI RAII handle guards

`src-tauri/src/platform/icons.rs:62-98` and `src-tauri/src/platform/thumbnails.rs:30-66` declare duplicate RAII structs:
- `ScopedHgdiobj(HGDIOBJ)` with `DeleteObject` in `Drop`
- `ScopedMemDc(HDC)` with `DeleteDC` in `Drop`
- `ScopedScreenDc(HDC)` with `ReleaseDC` in `Drop`

These guards should be declared once in a shared GDI helper module under `platform/`.

### Duplicated DIB and pixel conversion logic

Four modules implement separate manual byte-swapping or premultiplication loops for pixel buffers:

1. `src-tauri/src/platform/previews/windows/bitmap.rs:73-83`: iterates RGBA chunks and computes premultiplied BGRA bytes for DIB section creation.
2. `src-tauri/src/platform/icons.rs:356-362`: iterates chunks and swaps bytes 0 and 2 to convert BGRA to RGBA.
3. `src-tauri/src/platform/thumbnails.rs:229-234`: iterates chunks and swaps bytes 0 and 2 to convert BGRA to RGBA.
4. `src-tauri/src/platform/previews/thumb_decoders.rs:169-177`: iterates tiny_skia premultiplied pixels and un-premultiplies color channels.

These operations should be unified into shared pixel conversion utilities.

### Repeated archive extension literals

`src-tauri/src/platform/temp_archive.rs` repeats the string array `[".zip", ".cbz", ".rar", ".cbr", ".7z", ".cb7", ".tar", ".cbt"]` and its slash/backslash variants across 11 separate callsites:
- Lines 412-415 and 425-427 in `get_winrar_address_bar`
- Lines 842-845 and 857-859 in `collect_candidates`
- Lines 1027-1029 in `is_supported_archive`
- Lines 1121-1124 and 1136-1139 in `parse_winrar_window_title`
- Lines 1164-1167 and 1179-1182 in `parse_7z_folder_history`
- Lines 1198-1201 and 1215-1217 in `parse_7z_window_title`

All of these should delegate to `crate::formats::is_archive_ext()`. Similarly, `src-tauri/src/platform/thumbnails.rs:25` hardcodes `SHELL_THUMB_EXTS = &["jpg", "jpeg", "png", "bmp", "dib", "gif", "ico", "mp4"]` rather than referencing `crate::formats`.

### Dead functions, unused constants, and stale references

1. `src-tauri/src/windows.rs:50-51`. `OPTIONS_MAX_W: f64 = 560.0;` is marked `#[allow(dead_code)]`.
2. `src-tauri/src/windows.rs:60-61`. `META_MAX_H: f64 = 600.0;` is marked `#[allow(dead_code)]`.
3. `src-tauri/build.rs:1-3`. `#[allow(dead_code)] mod preview_contract;` suppresses warnings because only `THUMBNAIL_PROXY_NAME` is used.
4. `src-tauri/src/platform/previews/windows/thumb_proxy.rs:9-11`. `#[allow(dead_code)] mod contract;` suppresses dead code warnings because only `IMAGE_THUMBNAIL_CLSID` is referenced.
5. `src-tauri/src/platform/previews/windows/image_pane.rs:60`. `const ORIGIN: &str = "https://quivit-preview.localhost/";` is required by wry's Windows WebView2 custom protocol workaround (wry rewrites custom protocols with https scheme to `https://<protocol>.localhost/`).
6. `src-tauri/src/platform/previews/windows/com_server.rs:66-68`. `const PREVIEW_CLASS_NAME: &[u16] = &[81, 117, ...];` defines `"QuiviTPreviewPane"` as a manual raw numeric slice instead of using the standard `windows::core::w!("QuiviTPreviewPane")` macro.
7. `src-tauri/src/platform/previews/windows/com_server.rs:82-92`. Declares a manual `TRACKMOUSEEVENT` struct and raw `extern "system" fn TrackMouseEvent` despite `windows::Win32::UI::WindowsAndMessaging::TrackMouseEvent` already being present in the `windows` crate dependencies.
8. `src-tauri/src/platform/temp_archive.rs:220-266`. Declares raw `extern "system"` bindings for 11 Win32 APIs (`OpenWindowStationW`, `SetProcessWindowStation`, `EnumDesktopsW`, `OpenDesktopW`, `EnumDesktopWindows`, `EnumWindows`, `EnumChildWindows`, `GetWindowTextW`, `GetClassNameW`, `GetWindowThreadProcessId`, `SendMessageTimeoutW`) instead of using standard types from the `windows` crate.
9. `src-tauri/src/platform/previews/windows/com_server.rs:1354-1367`. Emergency fallback icon provisioning writes format icons to disk directly from `FORMAT_ICONS` if missing, duplicating the logic in `commands/registry.rs:provision_format_icons`.
