# Image thumbnails and previews spec

This validation comparison was performed against `.agents/skills/validate-changes/SKILL.md` before presenting. Spec only, no code changed, no behavior changed.

Status: accepted. Definitions locked. References `.agents/additions.md:L57-L60`.

## Locked definitions

These hold for the whole spec. A change here needs explicit user signoff.

- **Formats in scope:** Animated WebP (`.webp`), SVG (`.svg`), APNG (`.apng`), AVIF (`.avif`), and ICO (`.ico`).
- **Thumbnail contract:** Windows Explorer thumbnail provider (`IThumbnailProvider`). Renders a static first-frame raster bitmap (`HBITMAP`) scaled proportionally within requested bounding dimension `cx` (e.g., 96, 256), preserving alpha (`WTSAT_ARGB` or `WTSAT_RGB`) for `webp`, `svg`, `apng`, and `avif`. Windows native `.ico` thumbnailing remains untouched.
- **SVG thumbnail rasterizer:** Uses lightweight, high-performance native Rust vector rasterization (`resvg` / `tiny-skia`) for instantaneous (<5ms) first-frame generation without browser cold-start latency or memory spikes.
- **Preview pane contract:** Windows Explorer preview handler (`IPreviewHandler`). Displays the full animated version of the image for animated formats (`webp`, `svg`, `apng`, `avif`), looping continuously and indefinitely regardless of any finite loop count limit in the file header.
- **ICO spritesheet preview:** For `.ico` files in the preview pane, all distinct embedded frames are parsed, deduplicated by dimensions, sorted largest to smallest, and stitched horizontally into a single spritesheet with vertical centering (reusing the legacy math from commit `a499611`). This showcases all available icon resolutions side-by-side in one view.
- **Silent SVG external program skip:** When an external tool (such as Microsoft PowerToys) is registered as the preview handler or thumbnail provider for `.svg`, QuiviT's registration logic silently skips registering QuiviT for `.svg`. QuiviT never overwrites a functioning third-party SVG shell handler, and does not add UI override complexity.
- **Single helper binary and command flags:** All out-of-process shell handlers (`IPreviewHandler` and `IThumbnailProvider`) run from the staged `%LOCALAPPDATA%\QuiviT\bin\quivit-previews.exe` helper using `--previews-pane` and `--previews-thumb` respectively. No separate `quivit-thumbs.exe` or second binary is shipped or staged.
- **Process isolation and CLSIDs:**
  - Archive preview handler CLSID stays `{331F9B3C-6B0C-4DC8-A0FB-B62D19E52C06}` (served via `--previews-pane`).
  - Image/ICO preview handler CLSID is dedicated (e.g., `{B75A51FA-2D58-45F2-9214-E48BD1A14282}`), served via `--previews-pane`.
  - Image thumbnail provider CLSID is dedicated (e.g., `{A6F7C8D1-4E2B-4A1C-8D93-7F6E5B4A3C21}`), served via `--previews-thumb`.
  - Shell category GUIDs: Preview Handlers use `{8895b1c6-b41f-4c1c-a562-0d564250836f}`; Thumbnail Providers use `{e357ffcd-a995-4576-b01f-234630154e96}`.
- **Low integrity opt-out:** Every preview and thumbnail CLSID under QuiviT registers `DisableLowILProcessIsolation = 1` so Explorer can host child windows and receive rendered bitmaps without integrity-level rejections.

## Deviation rules

- A cold agent picks this up from a dirty tree with no handoff. Work the checklists in order. Check an item only when its accept line passes.
- States are `[x]` done and verified, `[ ]` not started, `[~]` partial with a note.
- Do not introduce new external runtime dependencies, DLL sidecars, or background service daemons.
- Do not touch `.agents/architecture-state.md` or `README.md` during implementation until explicitly asked.

---

## Research: SVG previews and thumbnails on Windows

### 1. Programs that implement Windows SVG shell extensions

Windows does not natively render SVG thumbnails or preview pane content out of the box in File Explorer. Third-party utilities fill this gap:

1. **Microsoft PowerToys (most prevalent):**
   - Implements `SvgPreviewHandler` (`PowerToys.SvgPreviewHandler.comhost.dll`) for the Preview Pane.
   - Implements `SvgThumbnailProvider` (`PowerToys.SvgThumbnailProvider.comhost.dll`) for Explorer thumbnail grids.
   - Uses standard Windows Shell COM registration under `HKEY_CLASSES_ROOT\.svg\ShellEx`.
2. **SVG Explorer Extension (tibbe / svg-explorer-extension):**
   - Open-source C++ in-process shell extension (`svgthumbnailprovider.dll`) dating back to Windows Vista/7.
   - Uses Cairo / libxml2 or GDI+ to rasterize vector markup to an `HBITMAP`.
3. **SVG Explorer Preview (Microsoft Store / third-party):**
   - Packaged store application registering an `IThumbnailProvider` and `IPreviewHandler` for vector formats.

### 2. How PowerToys achieves SVG thumbnails and previews

PowerToys relies on **Microsoft Edge WebView2** (`Microsoft.Web.WebView2` runtime):

- **Preview Pane (`SvgPreviewHandler`):**
  - Implements `IPreviewHandler`, `IPreviewHandlerVisuals`, and `IInitializeWithStream`.
  - Hosts a WebView2 control inside the parent `HWND` provided by File Explorer.
  - Generates a lightweight HTML page with the SVG embedded in an `<img>` tag or raw inline XML, centering it with CSS flexbox.
  - Adapts to system dark/light themes and applies an optional checkered transparency grid.
- **Thumbnail Provider (`SvgThumbnailProvider`):**
  - Implements `IThumbnailProvider` and `IInitializeWithStream`.
  - Spawns a headless or off-screen WebView2 webview, passes the SVG markup, and calls WebView2's bitmap capture API (`CapturePreview`).
  - Converts the resulting image buffer into a Windows GDI `HBITMAP` sized to bounding box `cx`, setting `WTSAT_ARGB` for alpha transparency.
- **Trade-offs of the WebView2 approach:**
  - Complete compliance with SVG 1.1, SVG 2, CSS styling, SMIL animations, and embedded fonts.
  - Higher cold-start latency and memory overhead per thumbnail call if spinning up a full browser instance.

### 3. QuiviT implementation strategy for SVG and animated media

QuiviT can adopt a split, high-performance approach:

1. **Static First-Frame Thumbnails (`IThumbnailProvider`):**
   - **For Animated WebP, APNG, and AVIF:** Native decoding directly into a 32-bit GDI DIB section (`HBITMAP`) with alpha (`WTSAT_ARGB`).
     - WebP: First-frame decode via `image` crate (already present in `src-tauri/Cargo.toml`).
     - APNG: Standard PNG chunk parser reads the default `IDAT` frame 0.
     - AVIF: First-frame decode via lightweight decoder or native Windows WIC (`CLSID_WICAvifDecoder`).
   - **For SVG:**
     - Primary path: Render SVG DOM to GDI bitmap at target size `cx` using lightweight Rust vector rasterization (`resvg` / `tiny-skia`), keeping thumbnail generation instantaneous (under 5ms, no browser spin-up).
     - Fallback: Headless WebView2 snapshot if complex script-driven SVGs require a full DOM engine.
2. **Animated Preview Pane (`IPreviewHandler`):**
   - The preview pane is already an out-of-process COM server (`quivit-previews.exe --previews-pane`).
   - For animated media (WebP, APNG, AVIF, and animated SVG), the preview pane hosts a dedicated child window.
   - Using WebView2 inside `quivit-previews.exe`:
     - WebView2 natively renders animated WebP, APNG, AVIF, and SVG with hardware acceleration.
     - A minimal HTML template with `<img src="...">` handles infinite looping: JavaScript ensures finite-loop images (e.g. single-loop APNG/WebP) restart continuously.
     - Background color mirrors Explorer's theme via `IPreviewHandlerVisuals::SetBackgroundColor`.
3. **ICO Spritesheet Preview (`IPreviewHandler`):**
   - For `.ico` files, parse all embedded frames via manual ICO header traversal (reusing the legacy algorithm from commit `a499611`).
   - Deduplicate frames by resolution and sort largest to smallest.
   - Stitch all unique sizes horizontally side-by-side with vertical centering into a composite image (`total_width = sum(widths)`, `max_height = max(heights)`).
   - Display the horizontal spritesheet centered in the preview pane against Explorer's theme surface, showing every resolution supported by the icon file in one view.

---

## SVG program detection logic

To prevent clobbering Microsoft PowerToys or existing SVG tools:

1. **Detection points in Windows Registry:**
   - **Preview Handler check:**
     - Query `HKCU\Software\Classes\.svg\ShellEx\{8895b1c6-b41f-4c1c-a562-0d564250836f}` and `HKLM\SOFTWARE\Classes\.svg\ShellEx\{8895b1c6-b41f-4c1c-a562-0d564250836f}`.
     - Query the active ProgID for `.svg` (from `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.svg\UserChoice` or `HKCR\.svg`), then check that ProgID's `ShellEx\{8895b1c6-b41f-4c1c-a562-0d564250836f}`.
   - **Thumbnail Provider check:**
     - Query `HKCR\.svg\ShellEx\{e357ffcd-a995-4576-b01f-234630154e96}` and the ProgID's `ShellEx\{e357ffcd-a995-4576-b01f-234630154e96}`.
   - **Server identification:**
     - If the subkey exists, resolve its default CLSID under `Software\Classes\CLSID\{CLSID}`.
     - Inspect `InprocServer32` or `LocalServer32` value.
     - If the path contains `PowerToys`, `svgthumbnailprovider`, or belongs to a known third party (not QuiviT):
       - Flag `svg_preview_handled_externally = true`
       - Flag `svg_thumbnail_handled_externally = true`
2. **Behavior on association sync:**
   - When registering associations or running launch sync, if `.svg` has an active external handler, QuiviT silently skips writing `ShellEx` subkeys for `.svg`.
   - File Types UI in Options operates as normal without extra checkboxes or override switches.
   - If no external handler is registered, QuiviT registers its own SVG thumbnail and preview handlers.

---

## Architectural design

```text
File Explorer
    │
    ├── Thumbnail Grid ──> IThumbnailProvider (quivit-previews.exe --previews-thumb)
    │                         ├── Animated WebP : Frame 0 decode -> HBITMAP (WTSAT_ARGB)
    │                         ├── APNG          : Frame 0 decode -> HBITMAP (WTSAT_ARGB)
    │                         ├── AVIF          : Frame 0 decode -> HBITMAP (WTSAT_ARGB)
    │                         └── SVG           : Fast vector rasterize -> HBITMAP (WTSAT_ARGB)
    │                                             [Skipped if PowerToys detected]
    │
    └── Preview Pane   ──> IPreviewHandler (quivit-previews.exe --previews-pane)
                              ├── Archive files  : Win32 GDI Archive Tree (existing com_server.rs)
                              ├── ICO files      : Horizontal Spritesheet Preview (all sizes side-by-side)
                              └── Image media    : Win32 WebView2 Child Player
                                    ├── WebP / APNG / AVIF : Animated playback, infinite loop
                                    └── SVG                : Animated / scalable vector display
                                                             [Skipped if PowerToys detected]
```

---

## Detailed checklist

### Slice 1: SVG external handler detection

- [ ] Add `detect_svg_shell_handlers()` in `src-tauri/src/platform/previews/windows.rs`.
  - Accept: Correctly detects PowerToys `SvgPreviewHandler` and `SvgThumbnailProvider` under `HKCR\.svg\ShellEx` or ProgID subkeys without panicking on missing keys.
- [ ] Extend `PreviewDiagnostic` in `src-tauri/src/models.rs` with `external_preview_handler: Option<String>` and `external_thumbnail_provider: Option<String>`.
  - Accept: `get_preview_diagnostics` IPC command reports third-party SVG handlers accurately.
- [ ] Guard `register_for_extension_with_host` in `src-tauri/src/platform/previews/windows.rs` to skip `.svg` when an external handler is active.
  - Accept: Registering all file types does not overwrite PowerToys SVG preview or thumbnail registry keys.
- [ ] Add unit test in `src-tauri/src/tests/previews_tests.rs` for SVG detection logic with mock registry fixtures or simulated CLSIDs.
  - Accept: `cargo test previews_tests` passes.

### Slice 2: Out-of-process thumbnail provider (`--previews-thumb`)

- [ ] Define `IMAGE_THUMBNAIL_CLSID` in `src-tauri/src/platform/previews/windows.rs` and register CLI command `--previews-thumb` in `src-tauri/src/main.rs`.
  - Accept: Running `quivit-previews.exe --previews-thumb` enters the thumbnail COM server message loop and exits when idle.
- [ ] Implement `IThumbnailProvider` and `IInitializeWithFile` in `src-tauri/src/platform/previews/windows/thumb_server.rs`.
  - Accept: Implements `GetThumbnail(cx, phbmp, pdwalpha)` returning `WTSAT_ARGB` and a valid 32-bit GDI `HBITMAP`.
- [ ] Add first-frame raster decoders in `src-tauri/src/platform/previews/thumb_decoders.rs`:
  - `decode_webp_first_frame(path, cx) -> Result<(Vec<u8>, u32, u32), String>`
  - `decode_apng_first_frame(path, cx) -> Result<(Vec<u8>, u32, u32), String>`
  - `decode_avif_first_frame(path, cx) -> Result<(Vec<u8>, u32, u32), String>`
  - `render_svg_first_frame(path, cx) -> Result<(Vec<u8>, u32, u32), String>`
  - Accept: Each decoder returns premultiplied 32-bit ARGB pixels fitted within `cx` × `cx` with preserved aspect ratio.
- [ ] Add DIB section bitmap builder `create_dib_hbitmap(width, height, argb_pixels) -> HBITMAP`.
  - Accept: Generates valid GDI bitmap handles that Explorer paints cleanly in thumbnail grid views.
- [ ] Register `IThumbnailProvider` shell keys under `Software\Classes\QuiviT.<ext>\ShellEx\{e357ffcd-a995-4576-b01f-234630154e96}` for `webp`, `apng`, `avif`, and `svg` (conditional on detection).
  - Accept: Explorer displays static first-frame thumbnails for supported formats.

### Slice 3: Animated image and ICO preview pane player

- [ ] Extend `quivit-previews.exe --previews-pane` in `src-tauri/src/platform/previews/windows/com_server.rs` to support image formats and ICO spritesheets alongside archive files.
  - Accept: `Materialized` enum handles `AnimatedMedia(PathBuf, String)` and `IcoSpritesheet(PathBuf, String)`.
- [ ] Add ICO horizontal spritesheet generator in `src-tauri/src/platform/previews/windows/ico_preview.rs`:
  - Parses ICO header, decodes all embedded PNG/BMP frames, deduplicates by resolution, sorts largest-first, and stitches horizontally side-by-side with vertical centering per commit `a499611`.
  - Accept: Stitches all distinct icon sizes into an RGBA composite buffer with accurate dimensions.
- [ ] Render ICO spritesheet in preview pane:
  - Centers the stitched spritesheet horizontally and vertically against the theme background surface.
  - Accept: Selecting an `.ico` file in Explorer displays all available resolutions side-by-side in one view.
- [ ] Embed WebView2 child host window in `com_server.rs` when previewing an animated image format (`webp`, `apng`, `avif`, `svg`).
  - Accept: Child HWND attaches to Explorer's preview pane parent window via `SetParent` and resizes smoothly with `SetRect`.
- [ ] Implement continuous animation loop in preview player HTML/JS template:
  - Inject CSS for viewport fit (`object-fit: contain; width: 100%; height: 100%`).
  - Listen for WebCodecs / HTML video / image completion events or use timed resets so finite-loop images restart indefinitely.
  - Accept: Single-loop and multi-loop animated WebP/APNG/AVIF files play in an endless loop.
- [ ] Implement `IPreviewHandlerVisuals` background color sync in the image and ICO players:
  - Accept: Background color seamlessly matches Explorer's current theme (light or dark mode) without visual flashing.

### Slice 4: Association integration and unregistration

- [ ] Update `register_associations` and `unregister_associations` in `src-tauri/src/commands/registry.rs` to manage thumbnail and preview keys for image formats and `.ico`.
  - Accept: `register_associations` links `IThumbnailProvider` for `webp`, `apng`, `avif`, and conditionally `svg`; and links `IPreviewHandler` for `webp`, `apng`, `avif`, conditionally `svg`, and `ico`. `unregister_associations` cleanly removes both `{8895b1c6-...}` and `{e357ffcd-...}` shell extension entries.
- [ ] Ensure silent skip in launch sync: `spawn_launch_previews_sync()` in `src-tauri/src/commands/registry.rs` leaves existing external SVG handlers intact.
  - Accept: Launching QuiviT does not clobber PowerToys SVG registrations.

### Slice 5: Verification and safety

- [ ] `cargo check --tests --manifest-path src-tauri/Cargo.toml` green.
- [ ] Targeted tests for thumbnail decoders, ICO spritesheet stitching, and SVG detection pass.
- [ ] `node --check` on touched JS modules and `npm test` green.
- [ ] Manual runtime checklist verifying Explorer thumbnail paint, preview pane animation looping, ICO spritesheet display, and PowerToys non-interference.

---

## Decisions (locked)

1. **SVG rasterizer:** Use `resvg` / `tiny-skia` for SVG thumbnail rasterization. It gives QuiviT the performance edge with sub-5ms render times, pure Rust execution, and zero browser process spin-up.
2. **Infinite looping enforcement:** In the preview pane, all animated media (WebP, APNG, AVIF, and animated SVG) loop continuously and indefinitely. Finite header loop counts are ignored or reset on loop completion.
3. **Silent SVG external skip:** If Microsoft PowerToys or another third-party SVG handler is detected in the registry, QuiviT silently skips registering `.svg` for both thumbnails and the preview pane. No override toggles or extra UI options are added.
4. **Binary and flag naming:** Consolidated in `quivit-previews.exe` using `--previews-pane` for the preview handler and `--previews-thumb` for the thumbnail provider (singular target nouns matching `IPreviewHandler` and `IThumbnailProvider`). No separate `quivit-thumbs.exe` is created.
5. **ICO spritesheet preview:** `.ico` files in the Windows preview pane render a horizontal spritesheet containing all unique resolution frames sorted largest-first with vertical centering, reusing the legacy stitching math from commit `a499611`. Windows native thumbnail handling for `.ico` remains untouched.
