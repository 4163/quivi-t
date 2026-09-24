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
   - Serve 96×96 PNG buffers via existing `png_response()` helper (already provides `Cache-Control: public, max-age=86400`).
   - Return instant HTTP 404 on cache miss / error to trigger frontend fallback.
4. **Multi-Tier Resilient Fallback**:
   - Update [`src/js/fsUtils.js`](file:///E:/Projects/QuiviT/src/js/fsUtils.js) with `SHELL_THUMBNAIL_EXTS`.
   - If `quivit://thumb/...` fails, fall back to direct file preview (`buildFileSrcSync`), and finally to the 32px native shell icon.

> [!IMPORTANT]
> ## User Review Required
> - **Format Scope**: Only universal formats (`jpg`, `jpeg`, `png`, `bmp`, `dib`, `gif`) query the shell. All other formats load directly via WebView2.
> - **Threading**: Shell COM calls run strictly on background threads via `tauri::async_runtime::spawn_blocking`.
> - **Size & Quality**: 96×96 requested from Windows Shell, providing 2x crispness on high-DPI displays.
> - **Cargo.toml**: No changes needed. All required Windows crate features (`Win32_UI_Shell`, `Win32_System_Com`, `Win32_Graphics_Gdi`, `Win32_Foundation`) are already enabled.

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
   - `png_response()` is already shared by the `/icon/` route; reusing it for `/thumb/` adds zero new response-building code.

---

## Proposed Changes

### 1. Backend Windows Shell Thumbnail Module (Rust)

#### [NEW] [src-tauri/src/platform/thumbnails.rs](file:///E:/Projects/QuiviT/src-tauri/src/platform/thumbnails.rs)
- [COMPLETED] Implement `get_shell_thumbnail_png(path: &str, size: u32) -> Result<Option<Vec<u8>>, String>`:
  - Validate path extension against `['jpg', 'jpeg', 'png', 'bmp', 'dib', 'gif']`; return `Ok(None)` for unsupported extensions.
  - Verify the file exists on disk (`std::path::Path::new(path).exists()`); return `Ok(None)` if missing.
  - **COM lifecycle per blocking thread:**
    - Call `CoInitializeEx(None, COINIT_APARTMENTTHREADED)`. If it returns `S_OK` or `S_FALSE`, proceed; on error, return `Err`.
    - Tokio's blocking pool reuses threads, so `CoInitializeEx` may return `S_FALSE` (already initialized by a prior task). Only call `CoUninitialize()` when we actually initialized (`S_OK`), not when piggy-backing (`S_FALSE`).
  - Call `SHCreateItemFromParsingName` with the wide-encoded path to obtain `IShellItemImageFactory`.
  - Call `GetImage(SIZE { cx: size, cy: size }, SIIGBF_BIGGERSIZEOK | SIIGBF_THUMBNAILONLY)`.
  - If `GetImage` fails (e.g. `E_FAIL` / `0x8004B200` for no cached thumbnail), return `Ok(None)`.
  - **HBITMAP → PNG conversion:**
    - Wrap returned `HBITMAP` in an RAII guard (matching `icons.rs` pattern: `ScopedHgdiobj`).
    - Obtain bitmap dimensions via `GetObjectW` → `BITMAP`.
    - Create a memory DC + DIB section (`CreateCompatibleDC`, `CreateDIBSection` with top-down `BITMAPINFOHEADER`).
    - `BitBlt` from a compatible DC with the HBITMAP selected into it, to the DIB DC, to extract raw pixel bytes.
    - Swap BGRA → RGBA in-place (matching `icons.rs` pattern).
    - Encode via `image::write_buffer_with_format` → PNG into `Vec<u8>`.
    - Clean up all GDI objects via RAII drop guards.
  - Reuse RAII guard structs from `icons.rs` where possible. If `icons.rs` guards are file-private, duplicate the minimal set (`ScopedHgdiobj`, `ScopedMemDc`, `ScopedScreenDc`), which are tiny 4-line structs.

#### [MODIFY] [src-tauri/src/platform/mod.rs](file:///E:/Projects/QuiviT/src-tauri/src/platform/mod.rs)
- [COMPLETED] Add `pub mod thumbnails;` export (after existing `pub mod icons;`).

---

### 2. Protocol Routing

#### [MODIFY] [src-tauri/src/protocol.rs](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs)

**Insertion point:** Between the existing `/icon/` check (line 22) and the archive URL fallthrough (line 50). This avoids any collision with `/archive/` since `/thumb/` is a distinct prefix.

- [COMPLETED] Add `/thumb/` URL pattern to `register_quivit_protocol`:
  - Route format: `quivit://thumb/<base64_path>`.
  - Add `fn parse_thumb_url(url: &str) -> Result<String, String>`:
    - `split_once("/thumb/")`, strip any trailing query (`?...`), decode base64 path via `crate::utils::base64_decode`.
  - Dispatch handler:
    - `tauri::async_runtime::spawn_blocking` → call `platform::thumbnails::get_shell_thumbnail_png(&path, 96)`.
    - On `Ok(Some(bytes))`: respond with `png_response(bytes)` (reuses existing helper, which already has `Content-Type`, `Cache-Control`, `Access-Control-Allow-Origin`).
    - On `Ok(None)` or `Err(_)`: respond with HTTP 404.
- [COMPLETED] Add `parse_thumb_url` to the test import list in [`protocol_tests.rs`](file:///E:/Projects/QuiviT/src-tauri/src/tests/protocol_tests.rs).

---

### 3. Frontend Thumbnail Routing & Fallback

#### [MODIFY] [src/js/fsUtils.js](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
- [COMPLETED] Define `SHELL_THUMBNAIL_EXTS = new Set(['jpg', 'jpeg', 'png', 'bmp', 'dib', 'gif'])` alongside existing `SUPPORTED_IMAGES`.
- [COMPLETED] Add `buildShellThumbnailSrc(path)`:
  ```js
  buildShellThumbnailSrc(path) {
    const encoded = _base64Encode(path);
    const isWindows = navigator.userAgent.includes('Windows');
    const base = isWindows ? 'http://quivit.localhost' : 'quivit://localhost';
    return `${base}/thumb/${encoded}`;
  },
  ```
- [COMPLETED] Modify `buildThumbnailSrc(item, state)`:
  - In the disk-image branch (line 185–188), before returning `buildFileSrcSync(item.path)`:
    - Extract the extension: `const ext = _ext(item.path).toLowerCase()`.
    - If `SHELL_THUMBNAIL_EXTS.has(ext)`: return `this.buildShellThumbnailSrc(item.path)`.
    - Otherwise (webp, avif, svg, apng, ico): keep existing `buildFileSrcSync` path.

#### [MODIFY] [src/js/filepanel/filePanel.js](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- [COMPLETED] Modify `slots.thumbImg.onerror` (line 910–916) to support two-tier fallback:
  ```js
  slots.thumbImg.onerror = () => {
    slots.thumbImg.onerror = null;
    const currentSrc = slots.thumbImg.getAttribute('src') || '';
    // Tier 1: shell thumb failed → try direct file preview
    if (currentSrc.includes('/thumb/')) {
      slots.thumbImg.onerror = () => {
        slots.thumbImg.onerror = null;
        // Tier 2: direct preview also failed → native icon
        const iconPath = FsUtils._isPathSpecificIcon(ext) ? item.path : '';
        const fallbackSrc = FsUtils.buildNativeIconSrc(iconPath, ext, 'large');
        thumbnailCache.set(targetSrc, fallbackSrc);
        slots.thumbImg.src = fallbackSrc;
      };
      const directSrc = FsUtils.buildFileSrcSync(item.path);
      thumbnailCache.set(targetSrc, directSrc);
      slots.thumbImg.src = directSrc;
    } else {
      // Non-thumb source failed → native icon directly
      const iconPath = FsUtils._isPathSpecificIcon(ext) ? item.path : '';
      const fallbackSrc = FsUtils.buildNativeIconSrc(iconPath, ext, 'large');
      thumbnailCache.set(targetSrc, fallbackSrc);
      slots.thumbImg.src = fallbackSrc;
    }
  };
  ```
- [COMPLETED] Apply same two-tier pattern to favorites `buildFavoriteEntry` `thumbImg.onerror` (line 419–424).

---

## Verification Plan

### Automated Tests
```pwsh
npm test
node --check src/js/filepanel/filePanel.js src/js/fsUtils.js
cargo check --tests --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml protocol_tests
```
- Unit test in `protocol_tests.rs` verifying `parse_thumb_url` decodes base64 paths and rejects malformed URLs.
- Unit test in `fileListViewMode.test.mjs` verifying `buildThumbnailSrc` routes universal-ext disk images to `/thumb/` and self-contained formats to `asset://`.

### Manual Verification
1. Open a folder of 10–50 MB JPEG/PNG camera photos in thumbnail view.
2. In DevTools Network tab, confirm requests are sent to `quivit://thumb/...`.
3. Confirm thumbnails load in milliseconds directly from Windows cache.
4. Verify WebP, AVIF, and SVG files continue to load directly via WebView2.
5. Delete Windows thumbnail cache (`cleanmgr` → Thumbnails), reopen folder, and verify graceful 404 fallback to direct file preview.
6. Verify favorites panel thumbnails use the same routing and fallback.

---

## Deviations, Violations & Runtime Fixes

- **[COMPLETED] Pre-existing: Animated SVG thumbnails intermittently freeze on refresh (`src/js/filepanel/filePanel.js`, disk, thumbnail only).** Not introduced by this slice; not Lanczos/filters or archives. Root cause: `loading='lazy'` + `thumbnailCache` retain via `new Image()` poisoned SMIL timeline + `display:none` pool recycling leaving stale `loading`. Fix: scoped `loading='eager'` for disk SVG only in `updateEntry` (uncached + cached), `commitPendingThumbnails`, `buildFavoriteEntry`; visibility-before-src (`li.top/display` before `src`); `removeAttribute('loading')` on reclaim; `thumbnailCache` skip retain for SVG (`set(src,true)` not `new Image()`). Validated via 30× refresh/scroll/click + canvas pixel diff (`playing:true`, `loading:eager`, `display:''`, `offsetParent:true`, `retain-skip-svg`). Temporary debug instrumentation cleanly removed.

