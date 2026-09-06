# Slice 4.3: Thumbnail Pipeline Optimization Roadmap

## Goal

Optimize the file list thumbnail rendering and serving pipeline, eliminating full-resolution asset decoding for thumbnails and reducing I/O and memory overhead during scrolling across both standalone disk files and archive containers.

To prevent context creep and maintain surgical precision, Slice 4.3 is divided into three incremental, self-contained passes where each slice leads smoothly into the next:

1. **[Slice 4.3.1: Scroll Debouncing, Request Cancellation & Skeleton Placeholders](file:///E:/Projects/QuiviT/.agents/slice-4.3.1_scroll-debounce-and-placeholders-plan.md)**:
   - Client-side virtualized scroll throttling (100ms debouncer with `scrollend` support).
   - Pre-allocated 24×24 muted SVG picture placeholder on `li._slots`.
   - Cancellation of in-flight decode pipelines when rows are recycled into `freePool`.
   - Immediate rendering for initial directory opens and selection jumps.
2. **[Slice 4.3.2: Windows Shell Native Thumbnail Service](file:///E:/Projects/QuiviT/.agents/slice-4.3.2_windows-shell-thumbnails-plan.md)**:
   - Decoupled Rust platform module [`src-tauri/src/platform/thumbnails.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/thumbnails.rs) using `IShellItemImageFactory` with `SIIGBF_THUMBNAILONLY`.
   - Universal formats (**`jpg`, `jpeg`, `png`, `bmp`, `dib`, `gif`**) retrieve pre-rendered 96×96 thumbnails from Windows `thumbcache_*.db` in ~0.2ms.
   - Zero OS-extension assumptions: self-contained formats (**`webp`, `avif`, `svg`, `apng`**) route directly to WebView2.
   - Dedicated protocol route `quivit://thumb/<base64_path>` with `Cache-Control: public, max-age=86400`.
3. **[Slice 4.3.3: Dual-Tier Archive Thumbnail Downscaling](file:///E:/Projects/QuiviT/.agents/slice-4.3.3_archive-thumbnails-plan.md)**:
   - Dual-tier cache isolation in [`ArchiveCache`](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs): dedicated 200-entry `thumb_lru` (~2 MB RAM) separated from the reader's 20-entry `zip_lru`.
   - On-demand background downscaling to 96×96 PNGs served via `quivit://archive-thumb/...`.
   - Unified support across ZIP, CBZ, RAR, CBR, 7Z, CB7, TAR, and CBT.

> [!IMPORTANT]
> ## User Review Required
> - **Execution Strategy**: Each sub-slice will be implemented in its own dedicated session.
> - **Zero Regressions**: Each pass compiles cleanly, passes `npm test` and `cargo check --tests`, and leaves the working tree in a production-ready state before moving to the next.

> [!CAUTION]
> ## Execution Rules
> **Do not mark pending items as completed after writing the code.** Items must remain marked as `[PENDING]` until the user has explicitly verified and approved that the implementation functions properly at runtime.

---

## Status Matrix

| Sub-Slice | Focus Area | Primary Files | Status |
| :--- | :--- | :--- | :--- |
| **Slice 4.3.1** | Virtualization Debouncing & Placeholders | `filePanel.js`, `main.css`, `fsUtils.js`, `services/cache.js`, `protocol.rs` | `[COMPLETED]` |
| **Slice 4.3.2** | Windows Shell Native Thumbnails | `platform/thumbnails.rs`, `protocol.rs`, `fsUtils.js` | `[PENDING]` |
| **Slice 4.3.3** | Dual-Tier Archive Thumbnails | `archives/cache.rs`, `archives/mod.rs`, `protocol.rs` | `[PENDING]` |

---

## Architectural Invariants & Validation Constraints

Every sub-slice follows [.agents/AGENTS.md](file:///E:/Projects/QuiviT/.agents/AGENTS.md) and [.agents/skills/validate-changes/SKILL.md](file:///E:/Projects/QuiviT/.agents/skills/validate-changes/SKILL.md):

1. **Frontend DOM & Architecture Boundaries:**
   - [`core.js`](file:///E:/Projects/QuiviT/src/js/core.js) remains pure domain with zero DOM dependencies.
   - [`filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js) is the sole owner of `#file-panel` and `#file-list`.
   - CSS in [`main.css`](file:///E:/Projects/QuiviT/src/css/main.css) is the visual source of truth.
   - Zero-allocation hot paths on scroll ticks.
2. **Decoupled Backend Architecture (No Monoliths):**
   - Windows Shell thumbnail logic lives exclusively in [`platform/thumbnails.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/thumbnails.rs).
   - [`platform/icons.rs`](file:///E:/Projects/QuiviT/src-tauri/src/platform/icons.rs) remains strictly for file/folder icons (`SHGetFileInfoW`).
   - Archive thumbnail extraction lives within `archives/` domain modules.
3. **Performance First & Hot Path Invariants:**
   - Universal formats use the microsecond OS thumbnail cache.
   - Self-contained formats use Chromium's built-in hardware-accelerated decoders.
   - Archive thumbnails never evict the reader viewport cache.
   - Heavy operations run strictly on background threads.

---

## Verification Plan

### Automated Tests
```pwsh
npm test
node --check src/js/filepanel/filePanel.js src/js/fsUtils.js
cargo check --tests --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

### Manual Verification
1. **Pass 1 Verification**: Rapid scrollbar dragging shows placeholder icons without decode thrashing.
2. **Pass 2 Verification**: Disk images (JPG, PNG, BMP, GIF) load pre-scaled 96×96 thumbnails from `quivit://thumb/...`.
3. **Pass 3 Verification**: Comic book archives serve 10 KB thumbnails from `quivit://archive-thumb/...` without reader cache eviction.

---

## Deviations, Violations & Runtime Fixes
 
- **Container Open Selection Default Fix (`src/js/fsUtils.js`)**: Fixed UX regression where opening an archive or folder defaulted selection to the previous directory index. Restricted `findNearestSurvivingIndex` strictly to `options.isRefresh`. Initial navigation into a container now correctly defaults to `..` (index 0) with blank image when `open_first_image` is off, or the first image entry when `open_first_image` is enabled.
- **In-Memory Frontend Thumbnail Cache (`src/js/filepanel/filePanel.js`)**: Exported `THUMB_CACHE_CAPACITY = 250` and `thumbnailCache = new BoundedMap(THUMB_CACHE_CAPACITY)` to retain loaded thumbnail URLs (~14 full screens on 1080p, covering entire manga volumes under ~10 MB RAM). Revisiting previously loaded rows assigns `.src` and `.is-loaded` synchronously on the same frame, eliminating debounce delays and skeleton placeholder flashing during bidirectional scrolling. Cache is cleared on manual `F5` refresh.
- **Distinct Skeleton Placeholders for Folders and Archives (`src/js/filepanel/filePanel.js`, `src/css/main.css`)**: Pre-allocated SVG icons for image, folder, archive, and file types inside `thumbPlaceholder`. Added `getPlaceholderType(item)` and CSS `data-type` switching to display dedicated folder and archive box skeletons instead of generic image icons while rows are loading or during scrolling, preserving zero runtime DOM allocation on scroll ticks.
- **Cache Module Extraction (`src/js/services/cache.js`)**: Extract `BoundedMap` from `fsUtils.js` into a standalone pure service module for reuse by the image viewer. `fsUtils.js` re-exports for backward compatibility.
- **Canonical Icon URLs and HTTP Caching (`src/js/fsUtils.js`, `src/js/filepanel/filePanel.js`, `src-tauri/src/protocol.rs`)**: Canonicalize non-image icon URLs to be path-agnostic across all three pipelines (list mode, thumbnail mode, favorites). Add `Cache-Control: public, max-age=86400` to `png_response`. Fix favorite routing so absolute paths don't fall into archive mode.
- **Favorites Cache Isolation (`src/js/filepanel/filePanel.js`)**: Dedicated `favoritesThumbnailCache = new BoundedMap(250)` isolated from the main virtualized list. Permanent `staticIconCache` for ~20 canonical format/folder icon URLs. Favorites survive refresh and 14k-item scrolling.
