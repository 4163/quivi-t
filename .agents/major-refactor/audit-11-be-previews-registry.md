# Audit 11: Windows Explorer previews, thumbnails, and file associations (`be-previews-registry`)

Split S11 covers 17 files totaling 6,677 lines across the thumbnail proxy build script, file-association IPC commands, Windows Explorer preview and thumbnail COM servers, WebView2 preview player assets, native thumbnail decoders, staged host management, and preview host unit tests.

Both S11 workers, `s11-com-systems` and `s11-registry-player`, audited all 17 files independently, cross-verified every `file:line` target, caller, and error contract against live code (`#108` to `#112`), reached unanimous `[Agree]` on 10 findings (`S11-01` to `S11-10`) and 6 cohesive files, and ratified `cross-split-seams.md` (`R1`, `R5`, `R6`, Sync E, and Sync F in `#121`). Baseline `cargo test --manifest-path src-tauri/Cargo.toml previews` passed 12 of 12 tests in `platform::previews::host::tests`, and all 22 `icons/formats/*.ico` assets match `SUPPORTED_FORMATS` and `FORMAT_ICONS` 1:1.

## File coverage ledger

| File | Lines | Status | Findings |
|---|---|---|---|
| `src-tauri/build.rs` | 50 | `Cohesive` | None (optional `-C strip=symbols` nit) |
| `src-tauri/src/commands/registry.rs` | 647 | `[Agreed]` | `S11-08`, `S11-09` |
| `src-tauri/src/platform/previews.rs` | 45 | `Cohesive` | None |
| `src-tauri/src/platform/previews/contract.rs` | 6 | `Cohesive` | None (optional CLSID centralization) |
| `src-tauri/src/platform/previews/host.rs` | 330 | `[Agreed]` | `S11-07`, `S11-09` |
| `src-tauri/src/platform/previews/avif_sequence.rs` | 154 | `Cohesive` | None (add Telemetry A unit tests) |
| `src-tauri/src/platform/previews/thumb_decoders.rs` | 299 | `[Agreed]` | `S11-06` |
| `src-tauri/src/platform/previews/windows.rs` | 460 | `[Agreed]` | `S11-08` |
| `src-tauri/src/platform/previews/windows/bitmap.rs` | 140 | `[Agreed]` | `S11-06` |
| `src-tauri/src/platform/previews/windows/com_server.rs` | 2,848 | `[Agreed]` | `S11-01`, `S11-02`, `S11-03` |
| `src-tauri/src/platform/previews/windows/image_pane.rs` | 650 | `[Agreed]` | `S11-04` |
| `src-tauri/src/platform/previews/windows/thumb_proxy.rs` | 344 | `[Agreed]` | `S11-05` |
| `src-tauri/src/platform/previews/windows/thumb_server.rs` | 273 | `[Agreed]` | `S11-05` |
| `src-tauri/src/platform/previews/windows/preview_player.html` | 15 | `Cohesive` | None |
| `src-tauri/src/platform/previews/windows/preview_player.css` | 25 | `Cohesive` | None |
| `src-tauri/src/platform/previews/windows/preview_player.js` | 179 | `[Agreed]` | `S11-04` |
| `src-tauri/src/tests/previews_tests.rs` | 212 | `[Agreed]` | `S11-10` |

All 17 owned files are accounted for: 11 files carry findings, 6 files are cohesive, 0 findings were dropped, and 0 were escalated.

## Agreed findings

### S11-01 `[Blocking]` `src-tauri/src/platform/previews/windows/com_server.rs`: decompose 2,848-line monolith and fix COM and Win32 safety bugs

- **Targets:** `src-tauri/src/platform/previews/windows/com_server.rs:1-2848` (specific safety bugs at `L359,381,492,518,527,538,548,555-564,1328-1367,1724-1770,1822-1963,2148,2265-2278`)
- **Problem:**
  1. `com_server.rs` fuses seven unrelated concerns into 2,848 lines: file logging, theme and color utilities, pure archive tree and scrollbar math, shell and `.ico` icon caching, GDI archive rendering, archive child window input and app launch, and the COM local server and pump loop. `thumb_server.rs`, `image_pane.rs`, and `windows.rs` reach into `com_server::log_event` only because logging lives inside the archive server file.
  2. Five COM interface methods (`IInitializeWithFile::Initialize:492`, `IInitializeWithItem::Initialize:518`, `IObjectWithSite::SetSite:527`, `IOleWindow::GetWindow:538`, `IPreviewHandlerVisuals::SetBackgroundColor:548`) call `self.state.lock().unwrap()` instead of `lock_state(&self.state)` (`L143-147`). A poisoned mutex panics across `extern "system"` COM boundaries.
  3. `IPreviewHandlerVisuals::SetFont` (`L555-564`) calls `pane.update_font(lf)` and `InvalidateRect` directly on the COM call thread while holding the state mutex instead of posting a pump task like `SetBackgroundColor` and `SetTextColor`.
  4. `preview_window_proc` (`L1822-1963`) handles no `WM_NCDESTROY` message to zero `GWLP_USERDATA`. If Explorer destroys the parent window before `destroy_pane` runs, subsequent messages dereference a dangling `*mut PreviewPane` (contrast `image_pane.rs:643-647`).
  5. `spawn_preview_worker` (`L1724-1770`) spawns a fresh OS thread per archive preview with no cancellation flag or queue cap. Rapid arrow-key navigation across large archives spawns dozens of concurrent `list_archive_names` threads fighting over disk I/O even when only the latest epoch can render.
  6. `PREVIEW_EPOCH` (`L381`) starts at `0`, colliding with `PreviewState::default().epoch` (`L359`) on the first `DoPreview`. `handle_key` (`L2148`) indexes `archive.nodes[selected]` directly instead of using `.get(selected)` (`L2136`). `paint_preview` (`L2272`) returns early when `hdc.0.is_null()` without calling `EndPaint(hwnd, &paint)`.
  7. `resolve_ico_path_for_ext` (`L1328-1367`) hardcodes `com.x4163.quivit.dev` and `com.x4163.quivit` paths and duplicates `FORMAT_ICONS` extraction from `commands/registry.rs:366` using non-atomic `fs::write`.
- **Agreed fix:**
  1. Split `com_server.rs` into seven single-owner modules under `src-tauri/src/platform/previews/windows/`:
     - `log.rs` (~40L): shared preview logger consumed by `com_server`, `thumb_server`, `image_pane`, and `windows.rs`.
     - `theme.rs` (~100L): `Theme` and shared luminance and color helpers (`is_dark_color`, `css_color`, `rgba`, `foreground`), eliminating the three duplicated luminance checks (`com_server.rs:1016-1018`, `image_pane.rs:374,561`).
     - `archive_tree.rs` (~300L): pure `TreeNode`, `ArchivePreview`, `build_tree`, `sort_tree`, `ScrollbarGeometry`, `ArchiveHit`, `compute_scrollbar`, and `hit_test_archive` with zero HWND or GDI dependencies.
     - `icon_cache.rs` (~320L): `IconCache`, `parse_icon_path`, native `HICON` shell and `.ico` loaders, and `create_default_ui_font`. Keep native `HICON` loading here rather than roundtripping through `platform::icons` PNG encoding, and drop hardcoded app-identifier paths and duplicate `FORMAT_ICONS` disk extraction in favor of a shared helper with `platform/associations.rs`.
     - `archive_render.rs` (~480L): GDI painting (`paint_preview`, `paint_now`, `render_content`, `draw_header`, `draw_archive`, `draw_chevron`, `draw_scroll_arrow`, `draw_border`, `draw_text`).
     - `archive_pane.rs` (~450L): `PreviewPane`, window class and proc, input handlers, bounded latest-wins listing worker, and `find_quivit_app_exe` / `open_item_in_app` (preserving `platform::direct_open::selected_exe` and `archives::list_archive_names`).
     - `com_server.rs` (~550L): COM local server bootstrap, `PreviewClassFactory`, `PreviewHandler`, and message-pump task queue.
  2. Replace all five `.lock().unwrap()` calls with `lock_state(&self.state)`. Route `SetFont` updates through a pump task. Add `WM_NCDESTROY` clearing `GWLP_USERDATA = 0`. Start `PREVIEW_EPOCH` at `1`. Replace `archive.nodes[selected]` with `.get(selected)`. Pair `BeginPaint` with `EndPaint` even when `hdc.0.is_null()`. Replace per-preview thread spawning with a single latest-wins worker queue that skips superseded epochs before opening the archive.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml` adding unit tests for extracted `archive_tree` (`build_tree`, `sort_tree`, expand/collapse, `compute_scrollbar`, `hit_test_archive`) and `icon_cache::parse_icon_path`, plus verifying `cargo check --tests` across all seven extracted modules.

### S11-02 `[Blocking]` `src-tauri/src/platform/previews/windows/com_server.rs`: gate and cap unbounded synchronous release logging

- **Targets:** `src-tauri/src/platform/previews/windows/com_server.rs:120-141`, `src-tauri/src/platform/previews/windows/thumb_server.rs:61,84,105,144,234,257,261`, `src-tauri/src/platform/previews/windows/image_pane.rs:518,521`
- **Problem:** `preview_log` (`com_server.rs:120-137`, re-exported as `log_event`) runs `OpenOptions::new().create(true).append(true).open(&path)` and `write_all` on `%TEMP%\QuiviT-preview.log` unconditionally in release builds with no size limit or rotation. Every thumbnail call triggers three separate file open, write, and close cycles, and every preview triggers six to ten cycles on the hot COM path.
- **Agreed fix:** Move logging into `windows/log.rs` (`S11-01`). Gate trace-level events (`log_event`) behind `cfg!(debug_assertions)` or an explicit `QUIVIT_PREVIEW_LOG=1` environment check, expose `log_error` for actual failures in release builds, and truncate or cap the log file at 1 MiB.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml` verifying zero file writes from `log_event` when release-gated and `QUIVIT_PREVIEW_LOG` is unset, plus truncation at the 1 MiB cap when logging errors.

### S11-03 `[Warning]` `src-tauri/src/platform/previews/windows/com_server.rs`: remove per-frame GDI churn, double paints, and allocations

- **Targets:** `src-tauri/src/platform/previews/windows/com_server.rs:1166-1180,1212-1255,1805-1811,1843-1848,1876-1881,2620-2752,2810-2848`
- **Problem:**
  1. `fill()` (`L2844-2848`) calls `CreateSolidBrush` and `DeleteObject` 10 to 15 times per paint (including 4 calls per `draw_border` at `L2754-2795`), and `draw_chevron` (`L2693`) plus `draw_scroll_arrow` (`L2627`) call `CreatePen` and `DeleteObject` for every visible folder chevron and scrollbar arrow on every frame. Both arrow functions also duplicate identical pen setup and double-polyline boilerplate.
  2. `WM_ERASEBKGND` (`L1843-1848`) runs a full `paint_double_buffered` repaint immediately before Windows delivers `WM_PAINT`, rendering the entire pane twice on every OS resize or expose cycle.
  3. `WM_MOUSEMOVE` (`L1876-1881`) calls `LoadCursorW` and `SetCursor` on every pixel of pointer movement even though `WM_SETCURSOR` (`L1868-1875`) already sets `IDC_ARROW` and `WNDCLASSW.hCursor` can be set once in `register_preview_class` (`L1805-1811`).
  4. `IconCache::get_or_load` and `get_or_load_large` (`L1212-1255`) do not cache negative lookups (`None`), re-running `SHGetFileInfoW`, registry lookups, and filesystem probes on every paint when an icon fails to load, and allocate a fresh `String` key per row per paint.
  5. `sort_tree` (`L1166-1180`) clones `nodes[node_id].children` twice per folder node (`L1167` and `L1176`). `draw_text` (`L2816`) and `draw_text_centered` (`L2833`) allocate a fresh UTF-16 `Vec<u16>` on every paint for every visible row.
- **Agreed fix:**
  1. Switch `fill()` to stock `DC_BRUSH` with `SetDCBrushColor` (matching `image_pane.rs:548-549`) and switch chevron and scrollbar arrow drawing to stock `DC_PEN` with `SetDCPenColor`, sharing one polyline helper (zero per-frame GDI brush or pen allocations; optionally reuse S09 `platform::gdi` RAII helpers per R5).
  2. Return `LRESULT(1)` from `WM_ERASEBKGND` without painting (keeping `paint_now` on initial create and resize).
  3. Set `hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default()` once in `register_preview_class` and remove the per-pixel `WM_MOUSEMOVE` cursor call.
  4. Store `Option<HICON>` in `IconCache` to cache misses and look up borrowed `&str` keys without per-row allocations.
  5. Use `std::mem::take(&mut nodes[node_id].children)` in `sort_tree`, and pre-encode `label_wide: Vec<u16>` on `TreeNode` (or reuse a scratch buffer in `PreviewPane`).
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml` covering `sort_tree` and `archive_tree` behavior plus verifying zero `CreateSolidBrush`/`CreatePen` calls in `archive_render.rs`.

### S11-04 `[Blocking]` `src-tauri/src/platform/previews/windows/image_pane.rs` and `preview_player.js`: decouple loader, reuse warm WebView2 controller, eliminate double `/media` fetch, and fix timer and safety bugs

- **Targets:** `src-tauri/src/platform/previews/windows/image_pane.rs:77-181,314-340,370-379,381-541,561,591-597,623-628`, `src-tauri/src/platform/previews/windows/preview_player.js:43-51,133-177`
- **Problem:**
  1. `image_pane.rs` (650L) mixes pure file I/O and background worker queue management (`MediaKind`, `Payload`, `LoadJob`, `LoadQueue`, `load_media`) with Win32 child window lifecycle, GDI painting, and WebView2 controller setup.
  2. Every Explorer file switch tears down the existing `WebView` controller and Win32 child `HWND` (`com_server.rs:785-812`) and cold-builds a new `WebContext` plus `WebView` (`image_pane.rs:381-474`), paying 150 to 400ms of controller bootstrap latency plus 50ms `READY_TIMER` retries during rapid arrow-key browsing and calling `SHGetKnownFolderPath(FOLDERID_LocalAppDataLow)` on every click (`L388-395`).
  3. `preview_player.js` fetches `/media` twice for every SVG (`L135-144` `.text()` then `showNative()` setting `image.src = '/media'`) and twice for every static WebP, AVIF, APNG, or GIF (`L135-169` `.arrayBuffer()` + `ImageDecoder` discovering `frameCount < 2`, then `showNative()` setting `image.src = '/media'`). Because `wry`'s `with_custom_protocol` requires `Cow<'static, [u8]>`, every `/media` request runs `media.to_vec()` (`image_pane.rs:450`), doubling up-to-128 MiB heap copies and decoding static images twice.
  4. `preview_player.js:145-148` shows an error instead of falling back to `showNative()` when `ImageDecoder` is unavailable or unsupported for a format, and `L173-175` swallows specific errors thrown at `L84`, `L136`, and `L163`.
  5. `media_ready` (`image_pane.rs:477-484`) returns early when `cancelled` is true before calling `KillTimer(Some(hwnd), READY_TIMER)`, leaving the 50ms timer firing until `DestroyWindow`.
  6. `load_media` (`L316-319`) reads file length via `metadata()` then allocates `Vec::new()` instead of `Vec::with_capacity(len)`. `WM_MEDIA_READY` (`L173-178,591-597`) omits `state.id` validation in `LPARAM`. `L505` assigns `*state.webview.borrow_mut() = Some(...)` while holding the mutable borrow across any dropped prior `WebView` (re-entrant `RefCell` panic hazard). `WM_ERASEBKGND` (`L623-628`) full-paints right before `WM_PAINT`. `wry::Rect` bounds construction duplicates at `L408-412` and `L535-539`, and `background` atomic loads twice in the CSS handler (`L436,440`).
- **Agreed fix:**
  1. Extract `MediaKind`, `Payload`, `LoadJob`, `LoadQueue`, `queue_media`, `complete_request`, and `load_media` into `src-tauri/src/platform/previews/windows/media_loader.rs`. Share color and luminance helpers from `windows/theme.rs` (`S11-01`). Keep `.with_devtools(cfg!(debug_assertions))` (`L415`) per R1.
  2. Reuse one warm WebView2 controller per `PreviewHandler` by storing the active `(Arc<[u8]>, &'static str, bool, u64)` payload in a shared slot read dynamically by the `quivit-preview` protocol handler (preserving dynamic `SVG_CSP` on SVG `/media` requests at `L459`). Trigger reloads via a `preview_player.js` reset entrypoint that revokes prior `Blob` URLs, strips `.vector` and `--svg-*`, hides elements, and loads `/media?v=<epoch>`.
  3. Compute the static-vs-animated hint in `media_loader.rs` via `crate::formats::check_animation_status(&bytes)` (`formats.rs:337`, Sync F) and pass it to `preview_player.js`. Static rasters load directly via `image.src = '/media?v=...'` with zero JS `ArrayBuffer` copy or `ImageDecoder` allocation. SVGs and animated fallbacks (`frameCount < 2` or unsupported `ImageDecoder`) render from `URL.createObjectURL(new Blob(...))` (permitted by existing `img-src 'self' blob: data:` CSP at `L61`) and revoke the URL on `close()` or reload. Surface specific error messages from `L84,136,163` in `catch (err)`.
  4. Call `KillTimer(Some(hwnd), READY_TIMER)` before returning on `cancelled` (and on `WM_CANCEL`). Pre-allocate `Vec::with_capacity(len.min(MAX_MEDIA_BYTES) as usize)` in `load_media`. Cache `FOLDERID_LocalAppDataLow` in a `OnceLock`. Pass and check `state.id` on `WM_MEDIA_READY`. Drop replaced webviews outside `borrow_mut()` (`let prev = state.webview.borrow_mut().replace(...); drop(prev);`). Return `LRESULT(1)` from `WM_ERASEBKGND`. Extract `webview_bounds(area)` and load `background` once in the CSS response.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml` covering `media_loader::MediaKind::for_path`, `load_media` limits, and `theme` luminance helpers, plus new `mocha/previewPlayer.test.js` (`npm run mocha`) verifying SVG dimension parsing, frame duration and `MIN_REPLAY_HOLD_MS` clamping, single `/media` fetch for static rasters and SVGs, `ImageDecoder` fallback to `showNative`, and `Blob` URL revocation while preserving classic `<script defer>` WebView2 compatibility.

### S11-05 `[Blocking]` `src-tauri/src/platform/previews/windows/thumb_server.rs` and `thumb_proxy.rs`: migrate thumbnail server to bounded MTA, pre-size streams, and gate proxy activation

- **Targets:** `src-tauri/src/platform/previews/windows/thumb_server.rs:42,60-120,201-272`, `src-tauri/src/platform/previews/windows/thumb_proxy.rs:243-289`
- **Problem:**
  1. `thumb_server.rs:62` initializes COM as `COINIT_APARTMENTTHREADED` (STA) and wraps `decode_first_frame` in a global `DECODE_LOCK: Mutex<()>` (`L42,254`). Explorer's thumbnail thread pool dispatches concurrent requests across a folder, yet STA serializes all `CreateInstance`, `IStream::Read`, and 100 to 500ms AVIF or SVG decodes onto one pump thread, stalling new `IStream` reads and idle timer checks. `thumb_server.rs` owns no HWND and calls only thread-safe `decode_first_frame` and `CreateDIBSection(None, ...)`.
  2. `read_stream` (`L201-239`) never queries `IStream::Stat(STATFLAG_NONAME)` to reject files over `MAX_ENCODED_BYTES` before cross-process RPC reads or to pre-allocate `Vec::with_capacity`, causing repeated reallocations on multi-megabyte files. It also runs `STORED_BYTES.fetch_update` (`L222-228`) before checking `if read == 0 { break; }` (`L230`).
  3. `thumb_proxy.rs:256-288` (`create`) invokes `CoCreateInstance(&CLASS_ID, ptr::null_mut(), 4, &IID_THUMBNAIL, &mut remote)` and a second cross-process `QueryInterface(IID_STREAM_INIT)` before checking whether the requested `iid` is supported (`IID_UNKNOWN`, `IID_THUMBNAIL`, or `IID_STREAM_INIT`), spawning `quivit-previews.exe` needlessly when Explorer probes unsupported interfaces. It also omits null guards on returned `remote` and `remote_initialize` pointers and inlines magic constant `4` for `CLSCTX_LOCAL_SERVER`.
- **Agreed fix:**
  1. Switch `thumb_server.rs` to `COINIT_MULTITHREADED` (MTA) with a `Condvar` idle-shutdown waiter (no Win32 message loop needed), store `Arc<EncodedImage>` so `ThumbnailProvider.bytes` lock is released before decode, and replace `DECODE_LOCK` with a bounded counting semaphore (2 to 4 concurrent workers, passing `threads: 1` to `aom_decode` under concurrency to avoid CPU oversubscription while keeping `MAX_STORED_BYTES` memory bounds intact).
  2. Query `stream.Stat(&mut stat, STATFLAG_NONAME)` best-effort in `read_stream` to reject `> MAX_ENCODED_BYTES` upfront and call `Vec::with_capacity`, and move `if read == 0 { break; }` ahead of `STORED_BYTES.fetch_update`.
  3. In `thumb_proxy.rs:256-288`, return `E_NOINTERFACE` before `CoCreateInstance` if `*iid` is not `IID_UNKNOWN`, `IID_THUMBNAIL`, or `IID_STREAM_INIT`, check `remote.is_null()` and `remote_initialize.is_null()`, and define `const CLSCTX_LOCAL_SERVER: u32 = 4;`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml` covering bounded semaphore concurrency, `read_stream` upfront size rejection and pre-allocation, plus `cargo check --tests` verifying `build.rs` compiles `quivit-thumbnail-proxy.dll` cleanly.

### S11-06 `[Warning]` `src-tauri/src/platform/previews/thumb_decoders.rs` and `windows/bitmap.rs`: eliminate SVG premultiplication roundtrip and allocation waste

- **Targets:** `src-tauri/src/platform/previews/thumb_decoders.rs:31-41,112-179,226-299`, `src-tauri/src/platform/previews/windows/bitmap.rs:48-85`
- **Problem:**
  1. `render_svg` (`thumb_decoders.rs:169-178`) receives premultiplied RGBA from `tiny_skia::Pixmap`, divides every semi-transparent pixel by alpha to produce straight RGBA, and immediately hands that `RgbaImage` to `Bitmap::new` (`bitmap.rs:73-83`), which multiplies every pixel by alpha again for `CreateDIBSection`. This wastes integer division per channel and adds rounding error on anti-aliased edges.
  2. `rgba_from_pixels` (`thumb_decoders.rs:39`) collects `pixels.flatten().collect()`, whose `Flatten` iterator has no exact upper `size_hint`, triggering geometric reallocations and ~128 MiB of copies on large 4096x4096 AVIF decodes.
  3. `decode_first_frame` (`thumb_decoders.rs:241-244`) runs `std::str::from_utf8(bytes)` on up to 128 MiB of unrecognized binary input before checking `bytes.len() <= MAX_SVG_BYTES` (16 MiB).
  4. `PngDecoder::with_limits` (`L253`) is immediately followed by a duplicate `decoder.set_limits(decode_limits())` (`L255-257`). Non-text SVGs allocate a fresh empty `Arc<usvg::fontdb::Database>` on every call (`L129`). `Bitmap::new` (`bitmap.rs:52-53`) casts `width`/`height` to `i32` without a `> 0 && <= i32::MAX` check.
- **Agreed fix:**
  1. Return `DecodedThumbnail::{Straight(RgbaImage), Premultiplied { width: u32, height: u32, rgba: Vec<u8> }}` from `decode_first_frame` and add `Bitmap::from_premultiplied_rgba` in `bitmap.rs` doing a single R/B channel swap with zero division. Add `width > 0 && height > 0 && <= i32::MAX` validation in `Bitmap` constructors (and optional `platform::gdi` RAII reuse per R5).
  2. Pre-allocate `Vec::with_capacity(width * height * 4)` in `rgba_from_pixels` (and copy contiguous bytes directly for `Image::RGBA8`).
  3. Gate the UTF-8 SVG fallback check on `bytes.len() <= MAX_SVG_BYTES`. Remove the duplicate `PngDecoder::set_limits` call and cache the empty `Arc<fontdb::Database>` in a `OnceLock`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml` adding unit tests for `decode_first_frame` (PNG/APNG, WebP + ANMF padding in `webp_frame_input`, AVIF via `avif_sequence`, SVG premultiplied pixels and size/dimension limits, and fast rejection of >16 MiB non-image inputs).

### S11-07 `[Warning]` `src-tauri/src/platform/previews/host.rs`: stream-hash staged binaries, skip identical EXE rewrites, and remove dead helpers

- **Targets:** `src-tauri/src/platform/previews/host.rs:53-72,80-86,126-146,177-199,231-299,318-326`
- **Problem:**
  1. On every startup (`lib.rs:95` -> `spawn_launch_previews_sync`), `ensure_previews_host_from` reads the entire multi-megabyte `quivit-previews.exe` into a single heap `Vec<u8>` via `std::fs::read` (`L190` in debug, `L265` in release) to compute SHA-256. `compute_sha256_hex` (`L132-134`) also makes 32 `format!` heap allocations per digest.
  2. `stage_copy` (`L188-199`) lacks the skip-if-hash-matches fast path that `stage_proxy` (`L58-60`) already has. In debug launches, it rewrites the entire EXE on every startup even when unchanged; in release repairs where only `quivit-thumbnail-proxy.dll` or the sidecar needs fixing while Explorer holds `quivit-previews.exe` open, `stage_copy` fails unnecessarily with a locked-file error.
  3. Failed `fs::rename(&tmp, &path)` calls (`L64,184,197`) leave `.tmp` files behind on disk.
  4. `embedded_profile` (`L80-86`) has zero callers anywhere in the repository, and `staged_host_info` (`L318-326`) is called only by dead `get_preview_diagnostics` (`S11-09`).
- **Agreed fix:**
  1. Hash files via a streaming 64 KiB `BufReader` helper and format hex digests with `std::fmt::Write` (zero per-byte `String` allocations).
  2. Compare the streaming SHA-256 of `host_path` against `source_exe` inside `stage_copy` and skip rewriting `host_path` when hashes already match.
  3. Remove the `.tmp` file if `fs::rename` returns an error.
  4. Delete dead `embedded_profile` (`L80`) and `staged_host_info` (`L318`, per R6). Preserve the exact locked-retry prefix `"Close the preview pane and Explorer windows, then retry:"` with `(os error ...)` (`L145`) parsed by `src/js/options/associationsUi.js:77-78`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml previews::host::tests` expanding tests to assert streaming hash parity, skip-copy on matching EXE bytes, `.tmp` cleanup after rename failure, and locked-retry prefix preservation.

### S11-08 `[Blocking]` `src-tauri/src/commands/registry.rs` and `src-tauri/src/platform/previews/windows.rs`: extract icon commands, associations domain, and shell registration module

- **Targets:** `src-tauri/src/commands/registry.rs:1-647`, `src-tauri/src/platform/previews/windows.rs:1-460`, `src-tauri/src/commands/mod.rs:1-21`, `src-tauri/src/platform/mod.rs:1-12`
- **Problem:**
  1. `commands/registry.rs:33-45` hosts `get_native_icon` and `invalidate_native_icon_cache`, which adapt `platform::icons` rather than Windows registry file associations.
  2. `commands/registry.rs:48-647` embeds ~550 lines of raw `winreg` HKCU/HKLM ProgID, `UserChoice`, `Capabilities`, `RegisteredApplications`, `TypeOverlay`, `SHChangeNotify`, icon provisioning, and `ASSOCIATIONS_LOCK` mechanics inside `commands/`, breaking `AGENTS.md` Rust module ownership.
  3. `previews/windows.rs:1-445` mixes 445 lines of COM CLSID and SVG shell-handler registration with module wiring (`L447-460`). It also duplicates the previewable image extension list against `image_pane.rs:85-95`, duplicates archive-vs-image CLSID mapping (`L363-367,419-423`), repeats `writable_hklm()` lookups (`L260-275`), uses magic constant `3` (`L321`) next to `GIF_PREVIEW_MIN_HOST_VERSION` (`L15`), scans all 22 `SUPPORTED_FORMATS` three times in `any_link_remains` (`L384-390`) without filtering by `supports_extension`/`has_thumbnail`, and hashes `quivit-thumbnail-proxy.dll` via `proxy_is_healthy` (`L326`) even when `has_thumbnails` is false or `ensure_previews_host()` just verified it (`registry.rs:315,325`).
- **Agreed fix:**
  1. Per R5, relocate `get_native_icon` and `invalidate_native_icon_cache` into `src-tauri/src/commands/icons.rs` (mounted via `pub mod icons;` in `commands/mod.rs`, keeping exact IPC names in `lib.rs:136-137` for `filePanel.js:731,787`).
  2. Per R5, extract the Windows file-association, registry, and icon-provisioning domain from `commands/registry.rs` into `src-tauri/src/platform/associations.rs` (mounted via `#[cfg(windows)] pub(crate) mod associations;` in `platform/mod.rs`), leaving `commands/registry.rs` as a thin IPC adapter plus `spawn_launch_previews_sync` (`lib.rs:95`).
  3. Extract `previews/windows.rs:1-445` and `sync_image_thumbnail_overlay` (`registry.rs:245-264`) into `src-tauri/src/platform/previews/windows/registration.rs`, leaving `windows.rs` as a thin facade. Share one extension-capability helper between `registration.rs` and `media_loader.rs`, extract `clsid_for_ext`, name `IMAGE_PREVIEW_MIN_HOST_VERSION = 3`, filter `any_link_remains` by `supports_extension`/`has_thumbnail`, gate `proxy_is_healthy` on `has_thumbnails`, and skip re-hashing `proxy.dll` immediately after `ensure_previews_host()` verified it. Preserve the exact `"Preview helper update is pending."` prefix (`L303,328`, parsed by `associationsUi.js:79`).
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml` adding `tests/registry_tests.rs` (via `#[path]`, zero production HKCU writes) for pure `associations` and `windows::registration` helpers plus verifying zero duplicate `proxy.dll` hashing during launch sync; `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js` and `07-os-integration.e2e.js` verifying all 6 active IPCs.

### S11-09 `[Blocking]` `src-tauri/src/commands/registry.rs`: remove dead IPCs, speed up startup icon provisioning, and fix write and cfg bugs

- **Targets:** `src-tauri/src/commands/registry.rs:48-109,113-242,274,314,361-376,427-432,445,475-548,562-647`, `src-tauri/src/lib.rs:139,142`, `src-tauri/src/models.rs:111-148`, `src-tauri/src/platform/previews/host.rs:318`
- **Problem:**
  1. `get_preview_diagnostics` (`registry.rs:113-242`, `lib.rs:139`) and `register_associations` (`registry.rs:427-432`, `lib.rs:142`) have zero callers across `src/`, `mocha/`, and `e2e/` (`associationsUi.js:60` uses `apply_associations` and `:139` uses `unregister_associations`). `models::PreviewDiagnostic` (`models.rs:111-148`) and `previews::host::staged_host_info` (`host.rs:318`) exist solely for `get_preview_diagnostics`.
  2. `provision_format_icons` (`L308,361-376`) runs on every startup and reads all 22 `.ico` files (~1.3 MB) from disk to compare full byte arrays. It also calls `config::roaming_dir` (`L362`) while `register_associations_impl` calls `config::roaming_dir_path` (`L445`).
  3. `spawn_launch_previews_sync` (`L314`) skips `ensure_previews_host()` whenever `has_file_open_arg(&args) && host.is_file()` without checking sidecar version or proxy presence, marking `PreviewPreparation::Ready` even when the staged helper is stale.
  4. `get_format_status` (`L48-109`) is synchronous (`#[tauri::command]`) across ~66 registry opens, and `sync_preview_associations_impl` (`L274`) calls it just to collect registered extension names (allocating and discarding 22 `FormatStatus` structs).
  5. `register_associations_impl` (`L475-548`) propagates `create_subkey` errors with `?` but discards every `set_value` error with `let _ = ...`.
  6. `unregister_associations_impl` (`L562-647`) is already gated by `#[cfg(windows)]` at `L562`, yet contains a redundant nested `#[cfg(windows)]` block (`L564`) and an unreachable `#[cfg(not(windows))]` return (`L645-646`).
- **Agreed fix:**
  1. Per R6, delete `get_preview_diagnostics`, `models::PreviewDiagnostic`, `previews::host::staged_host_info`, and `register_associations` (removing `lib.rs:139,142` while keeping internal `register_associations_impl` inside `platform/associations.rs`).
  2. In `provision_format_icons`, unify on `config::roaming_dir_path` plus `create_dir_all(&icon_dir)` and skip full `.ico` byte reads when a version stamp matches and all 22 files exist with matching byte lengths.
  3. On file-open launches (`L314`), read the small sidecar JSON and check `preview_version >= PREVIEW_HOST_VERSION` plus `proxy_path.is_file()` before deciding whether to skip `ensure_previews_host()`.
  4. Make `get_format_status` `#[tauri::command(async)]` with identical `Vec<FormatStatus>` JSON shape, and expose a lightweight `registered_extensions()` helper for `sync_preview_associations_impl`.
  5. Propagate critical `set_value` failures (`ProgId`, `DefaultIcon`, `shell\open\command`, `Capabilities`, `RegisteredApplications`) in `register_associations_impl`, and delete the nested `#[cfg(windows)]` and unreachable `#[cfg(not(windows))]` lines in `unregister_associations_impl`.
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml` covering icon-stamp fast path and pure ProgId/command helpers; `npm run e2e -- --spec e2e/specs/06-configuration.e2e.js` and `07-os-integration.e2e.js` confirming all 22 `SUPPORTED_FORMATS` in `get_format_status`, `sync_preview_associations` under `QUIVIT_E2E_SUITE`, and zero breakage after dead-IPC removal.

### S11-10 `[Warning]` `src-tauri/src/tests/previews_tests.rs`: fix leaked temp directories and close S11 test gaps

- **Targets:** `src-tauri/src/tests/previews_tests.rs:4-17`
- **Problem:** `unique_dir` creates directories under `%TEMP%\quivit-previews-test-*` (each staging a 200 KiB `quivit-thumbnail-proxy.dll`, fake EXE, lock file, and sidecar) and never deletes them, leaking nine folders per `cargo test` run. Coverage across S11 is also limited strictly to `host.rs`, leaving `avif_sequence.rs`, `thumb_decoders.rs`, `com_server.rs` archive tree and scrollbar math, `windows.rs` registration helpers, `image_pane.rs`/`preview_player.js`, and `commands/registry.rs` untested.
- **Agreed fix:** Wrap `unique_dir` in an RAII `TempDir` guard that calls `fs::remove_dir_all` on `Drop`, and add pure unit coverage across `tests/previews_tests.rs`, `tests/registry_tests.rs`, and `mocha/previewPlayer.test.js` (per Telemetry A/B below).
- **Telemetry A/B:** `cargo test --manifest-path src-tauri/Cargo.toml` confirming zero leftover `quivit-previews-test-*` directories after test runs and 100% pass across all new S11 unit tests.

## Cohesive files (6 of 17)

- `src-tauri/build.rs` (50L): Single-purpose build script compiling zero-dependency `thumb_proxy.rs` into `OUT_DIR/quivit-thumbnail-proxy.dll` with proper `rerun-if-changed` directives before `tauri_build::build()`. Optional nit: pass `-C strip=symbols` to trim the embedded 200 KiB DLL.
- `src-tauri/src/platform/previews/contract.rs` (6L): Pure shared constants (`IMAGE_THUMBNAIL_CLSID`, `IMAGE_PREVIEW_CLSID`, `THUMBNAIL_CATEGORY`, `THUMBNAIL_PROXY_NAME`) shared across `build.rs`, `thumb_proxy.rs`, `host.rs`, and `windows.rs`. Optional cleanup: move `PREVIEW_HANDLER_CLSID` and `PREVIEW_HANDLER_CATEGORY` from `windows.rs:9-11` here as plain `u128`/`&str` constants.
- `src-tauri/src/platform/previews.rs` (45L): Clean platform-gated facade re-exporting `host::*` and `windows::*` with non-Windows stubs.
- `src-tauri/src/platform/previews/avif_sequence.rs` (154L): Focused pure ISOBMFF parser extracting the first AV1 color and alpha frame via `crate::formats::isobmff_box` (`S09`). Structurally clean; add unit tests in Telemetry A (`S11-10`).
- `src-tauri/src/platform/previews/windows/preview_player.html` (15L): Static HTML-first markup (`<img>`, `<canvas>`, `<p role="status">`) with zero inline scripts or styles and stylesheet before deferred script.
- `src-tauri/src/platform/previews/windows/preview_player.css` (25L): Clean `:root` custom properties, `.hidden` visibility toggle, and `--svg-width`/`--svg-height` sizing rules matching `AGENTS.md` CSS source-of-truth rules.

## Cross-split seams and locked contracts

All S11 seams are ratified in `.agents/major-refactor/cross-split-seams.md`:

- **Sync E (`S08`, `S09`, `S10`, `S11`):**
  - R5 module additions: `commands/icons.rs` (`get_native_icon`, `invalidate_native_icon_cache` via `commands/mod.rs`), `platform/associations.rs` (via `platform/mod.rs`), and optional `platform/gdi.rs` reuse in `bitmap.rs`/`archive_render.rs`.
  - R6 dead IPC removals: `get_preview_diagnostics` (`lib.rs:139`, `models.rs:111-148` `PreviewDiagnostic`, `host.rs:318` `staged_host_info`) and `register_associations` (`lib.rs:142`).
  - Locked S11 IPCs (6 active): `get_native_icon`, `invalidate_native_icon_cache`, `get_format_status` (upgraded to `async`, identical `Vec<FormatStatus>`), `sync_preview_associations`, `apply_associations`, `unregister_associations`.
  - `main.rs` entrypoints preserved: `--previews-thumb` (`L6-12`) and `--previews-pane` / `--preview-handler` (`L16-31`) calling `platform::previews::{run_thumbnail_server, run_server, log_event}`. `lib.rs:95` keeps `spawn_launch_previews_sync`.
  - R1 DevTools boundary: `image_pane.rs:415` remains `cfg!(debug_assertions)` while main/auxiliary app windows keep `.devtools(true)` per `README.md:150`.
- **Sync F (`S03`, `S08`, `S09`, `S11`):**
  - `associationsUi.js` (`S03`): preserve 4 association IPCs, 22-format parity (`SUPPORTED_FORMATS` and `FORMAT_ICONS`), and exact frontend-parsed error prefixes (`"The release build"`, `"Close the preview pane and Explorer windows, then retry:"` with `(os error 5|32|33)`, and `"Preview helper update is pending."`).
  - `platform/direct_open.rs` (`S08`): preserve `has_file_open_arg`, `release_exe`, and `selected_exe` calls from `platform/associations.rs` and `windows/archive_pane.rs`.
  - `formats/`, `archives/`, `ico.rs`, `platform/icons.rs` (`S09`): preserve `isobmff_box`, `SUPPORTED_FORMATS`, `FORMAT_ICONS`, `is_archive_ext`, `is_image_ext`, `archives::list_archive_names`, `ico::ico_spritesheet_from_bytes`, and `platform::icons::{get_cached_native_icon, clear_cached_native_icons}`. Adopt `crate::formats::check_animation_status` (`formats.rs:337`) in `windows/media_loader.rs`.
  - `quivit-preview://` scheme (`image_pane.rs`): keep `CSP` and dynamic `SVG_CSP` headers intact across warm WebView2 controller reuse.

## Telemetry A/B specification

1. **Rust backend unit tests (`cargo test --manifest-path src-tauri/Cargo.toml`)**
   - *Baseline:* 12/12 passing in `platform::previews::host::tests`.
   - *Telemetry A (pre-refactor additions):* Add RAII `TempDir` cleanup to `src-tauri/src/tests/previews_tests.rs`, expand `previews_tests.rs` with unit tests for `avif_sequence::{is_avif, first_frame}` (valid, malformed, alpha track, `stz2`, `co64`), `thumb_decoders::{decode_first_frame, webp_frame_input, render_svg, check_dimensions}` (size/dimension caps and >16 MiB non-image rejection), `archive_tree::{build_tree, sort_tree, ArchivePreview, compute_scrollbar, hit_test_archive}`, `icon_cache::parse_icon_path`, `media_loader::MediaKind::for_path` + `theme` luminance, and `windows::registration` pure helpers (`supports_extension`, `has_thumbnail`, `is_quivit_class`, CLSID mapping). Add `src-tauri/src/tests/registry_tests.rs` (via `#[path]`, zero production HKCU writes) covering ProgId/command formatting, icon-stamp checks, and locked error prefix invariants.
   - *Telemetry B (post-refactor parity and proofs):* All expanded tests pass with zero inline `#[cfg(test)]` blocks, zero leaked `%TEMP%\quivit-previews-test-*` directories, zero `QuiviT-preview.log` trace writes under release gating, verified skip-copy on identical EXE bytes, zero duplicate `proxy.dll` hashing on startup sync, single-allocation `rgba_from_pixels`/`load_media`, premultiplied SVG `Bitmap` conversion, and concurrent MTA `thumb_server` decode execution.
2. **Mocha frontend unit tests (`npm run mocha`)**
   - *Baseline:* 308 passing (`diagnosticsContract.test.js` read-only contract check).
   - *Telemetry A/B:* Add `mocha/previewPlayer.test.js` testing pure `preview_player.js` SVG length parsing, frame duration and `MIN_REPLAY_HOLD_MS` clamping, single `/media` fetch for static rasters and SVGs (mocked `fetch`, `ImageDecoder`, and `URL.createObjectURL`), `ImageDecoder` fallback to `showNative`, specific error message surfacing, and `Blob` URL revocation on `close()` and warm reload, keeping classic `<script defer>` WebView2 custom-protocol compatibility via Node `vm` or verified module load.
3. **Desktop E2E tests (`npm run e2e -- --spec e2e/specs/06-configuration.e2e.js` and `07-os-integration.e2e.js`)**
   - *Baseline:* `07-os-integration.e2e.js:14-24` asserts `get_format_status` returns >5 formats containing `png`, `jpg`, `cbz`, `zip`.
   - *Telemetry A:* Expand `07-os-integration.e2e.js` to assert all 22 `SUPPORTED_FORMATS` entries plus `get_native_icon` and `invalidate_native_icon_cache` IPC parity, and expand `06-configuration.e2e.js` to open the File Types tab and confirm `sync_preview_associations` succeeds as a no-op under `QUIVIT_E2E_SUITE`.
   - *Telemetry B:* Confirm 1:1 parity across all 6 active S11 IPC commands after relocating `commands/icons.rs`, extracting `platform/associations.rs`, and removing dead `get_preview_diagnostics` and `register_associations`.
4. **Replay diagnostics (`npm run diagnose -- <scenario>`)**
   - *Applicability:* Not applicable to out-of-proc Explorer COM preview/thumbnail handlers and Windows registry commands (no main-viewer or `quivit://` protocol edits in S11; `diagnosticsContract.test.js` remains untouched and passing via `npm run mocha`).
