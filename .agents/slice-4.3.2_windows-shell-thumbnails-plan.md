# Slice 4.3.2: Windows Shell Native Thumbnail Service Plan

## Goal

Implement high-performance Windows Shell native thumbnail extraction in a decoupled Rust platform module for universal static image formats, eliminating full-resolution asset decoding for disk images.

Key capabilities in this slice:
1. **Decoupled Platform Module (`platform/thumbnails.rs`)**:
   - Create [`src-tauri/src/platform/thumbnails.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/thumbnails.rs) isolated from [`icons.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/icons.rs) to maintain clear module boundaries.
   - Leverage `IShellItemImageFactory` with `SIIGBF_THUMBNAILONLY` to extract pre-rendered 96×96 thumbnails directly from Windows `thumbcache_*.db` in ~0.2ms.
2. **Universal Format Scope (No OS-Extension Assumptions)**:
   - Target universal formats: **`jpg`, `jpeg`, `png`, `bmp`, `dib`, `gif`**.
   - Explicitly route self-contained formats (**`webp`, `avif`, `svg`, `apng`**) directly to WebView2, avoiding failed shell queries and wasted 404 roundtrips.
3. **Protocol Route with HTTP Caching**:
   - Add `/thumb/<base64_path>` route to `quivit://` protocol handler in [`src-tauri/src/protocol.rs`](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs).
   - Serve 96×96 PNG buffers with `Cache-Control: public, max-age=86400`.
   - Return instant HTTP 404 on cache miss / error to trigger frontend fallback.
4. **Multi-Tier Resilient Fallback**:
   - Update [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js) with `SHELL_THUMBNAIL_EXTS`.
   - If `quivit://thumb/...` fails, fall back to direct file preview (`buildFileSrcSync`), and finally to the 32px native shell icon.

> [!IMPORTANT]
> ## User Review Required
> - **Format Scope**: Only universal formats (`jpg`, `jpeg`, `png`, `bmp`, `dib`, `gif`) query the shell. All other formats load directly via WebView2.
> - **Threading**: Shell COM calls run strictly on background threads via `tauri::async_runtime::spawn_blocking`.
> - **Size & Quality**: 96×96 requested from Windows Shell, providing 2x crispness on high-DPI displays.

> [!CAUTION]
> ## Execution Rules
> **Do not mark pending items as completed after writing the code.** Items must remain marked as `[PENDING]` until the user has explicitly verified and approved that the implementation functions properly at runtime.

---

## Architectural Invariants & Validation Constraints

Every item in this plan follows [.agents/AGENTS.md](file:///E:/Projects/QuiviT/.agents/AGENTS.md) and [.agents/skills/validate-changes/SKILL.md](file:///E:/Projects/QuiviT/.agents/skills/validate-changes/SKILL.md):

1. **Rust Module Ownership & Anti-Monolith:**
   - Windows Shell thumbnail logic lives exclusively in [`src-tauri/src/platform/thumbnails.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/thumbnails.rs).
   - [`src-tauri/src/platform/icons.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/icons.rs) remains strictly for file/folder icons (`SHGetFileInfoW`).
   - [`src-tauri/src/platform/mod.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/mod.rs) exports the new module cleanly.
2. **Performance First & Hot Path Invariants:**
   - **Microsecond OS Cache Retrieval**: Retrieve pre-rendered thumbnails without touching or decoding full original files.
   - **Zero Overhead in List Mode**: List mode remains completely unaffected.
3. **Blast Radius & Downstream Safety:**
   - Existing protocol routes (`quivit://archive/...`, `quivit://icon/...`) remain untouched.

---

## Proposed Changes

### 1. Backend Windows Shell Thumbnail Module (Rust)

#### [NEW] [src-tauri/src/platform/thumbnails.rs](file:///E:/Projects/QuiviT/src-tauri/src/platform/thumbnails.rs)
- [PENDING] Implement `get_shell_thumbnail_png(path: &str, size: u32) -> Result<Option<Vec<u8>>, String>`:
  - Verify path exists and extension is in `['jpg', 'jpeg', 'png', 'bmp', 'dib', 'gif']`.
  - Initialize COM apartment on the blocking thread (`CoInitializeEx`).
  - Call `SHCreateItemFromParsingName` to obtain `IShellItemImageFactory`.
  - Call `GetImage(SIZE { cx: size, cy: size }, SIIGBF_BIGGERSIZEOK | SIIGBF_THUMBNAILONLY)`.
  - If `SIIGBF_THUMBNAILONLY` returns `ERROR_NOT_FOUND` / `0x8004B200`, return `Ok(None)`.
  - Read DIB bits, swap BGRA to RGBA, and encode to lightweight PNG buffer via `image::write_buffer_with_format`.
  - Clean up GDI objects and release COM interface via RAII guards.

#### [MODIFY] [src-tauri/src/platform/mod.rs](file:///E:/Projects/QuiviT/src-tauri/src/platform/mod.rs)
- [PENDING] Export `pub mod thumbnails;`.

---

### 2. Protocol Routing & HTTP Caching

#### [MODIFY] [src-tauri/src/protocol.rs](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs)
- [PENDING] Add `/thumb/` URL pattern to `register_quivit_protocol`:
  - Route format: `quivit://thumb/<base64_path>`.
  - Dispatch before generic `/archive/` pattern to maintain clean routing precedence.
  - Decode `base64_path` and spawn blocking task to call `platform::thumbnails::get_shell_thumbnail_png(&path, 96)`.
  - Return HTTP 200 with `Content-Type: image/png` and `Cache-Control: public, max-age=86400`.
  - If missing/error: return HTTP 404.

---

### 3. Frontend Thumbnail Routing & Fallback

#### [MODIFY] [src/js/fsUtils.js](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
- [PENDING] Define `SHELL_THUMBNAIL_EXTS = new Set(['jpg', 'jpeg', 'png', 'bmp', 'dib', 'gif'])`.
- [PENDING] Add `buildShellThumbnailSrc(path)` returning `http://quivit.localhost/thumb/${_base64Encode(path)}`.
- [PENDING] In `buildThumbnailSrc(item, state)`:
  - For standalone disk images in `SHELL_THUMBNAIL_EXTS`: return `buildShellThumbnailSrc(item.path)`.
  - For standalone disk images outside `SHELL_THUMBNAIL_EXTS`: return `buildFileSrcSync(item.path)`.

#### [MODIFY] [src/js/filepanel/filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- [PENDING] In `slots.thumbImg.onerror`:
  - If target was `quivit://thumb/...`: fall back to `FsUtils.buildFileSrcSync(item.path)`.
  - If direct preview fails: fall back to `FsUtils.buildNativeIconSrc(cleanPath, ext, 'large')`.

---

## Verification Plan

### Automated Tests
```pwsh
npm test
node --check src/js/filepanel/filePanel.js src/js/fsUtils.js
cargo check --tests --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```
- Unit test in `fsUtils.test.mjs` verifying URL routing for universal vs self-contained formats.
- Unit test in `protocol_tests.rs` verifying `/thumb/<base64>` routing and 404 behavior.

### Manual Verification
1. Open a folder of 10–50 MB JPEG/PNG camera photos in thumbnail view.
2. In DevTools Network tab, confirm requests are sent to `quivit://thumb/...`.
3. Confirm thumbnails load in milliseconds directly from Windows cache.
4. Verify WebP, AVIF, and SVG files continue to load directly via WebView2.

---

## Deviations, Violations & Runtime Fixes

- None recorded yet.
