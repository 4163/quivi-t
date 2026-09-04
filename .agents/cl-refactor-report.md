# Component Library & Backend Refactor Analysis

This report classifies the backlog from `additions.md` and `user-notes` through the lens of the QuiviT Component Library (CL) extraction. It separates items that belong in the portable JS viewer (the CL) from those that belong in the desktop application (the host/backend).

## 1. Component Library (CL) Features

These items directly affect the viewer engine. They must be built into the CL or exposed via its public API.

*   **[PENDING] Window & Panel Resize Transform Snap Fix:** Preserving relative zoom and pan during container resize. This is a core mathematics fix for the CL's layout engine.
*   **Double Page View & Manga Spread Mode:** Rendering two images side-by-side or splitting wide images. This is a primary rendering mode the CL must support via its configuration object.
*   **Manhwa Mode (Continuous Vertical Strip):** Rendering a continuous list of images. The CL needs a mode to handle virtualized vertical stacking.
*   **[PENDING] Animated "Loading..." Feedback:** Visual feedback during image fetch. The CL must handle its own loading states and placeholder visuals.
*   **[PENDING] Flickering Issue on Re-fetch:** Optimizing the browser image cache. The CL must manage its internal `Blob` or `ImageBitmap` lifecycle without redundant network requests.
*   **[PENDING] Idle Cursor Auto-Hide:** Hiding the cursor over the canvas. The CL should handle its own interaction idle state.
*   **Animated Frame Timeline:** A scrubber for WebCodecs/animated formats. The CL should either render this timeline or expose the exact frame state (`currentFrame`, `totalFrames`, `seek()`) so the host application can render it.
*   **[PENDING] Options Save Resets Fit/Zoom (Bug):** The CL needs a clean configuration update path (e.g. `viewer.setConfig(...)`) that does not destroy current transform state unless explicitly requested.
*   **Lanczos Memory & Instrumentation:** Reducing memory usage in the WebGL and Canvas pools, and measuring scaling delays. This is entirely internal to the CL.

## 2. Host Application (Desktop / UI / Routing)

These items belong to the consumer application. The CL does not know or care about them. For QuiviT Desktop, they stay in the frontend shell. For the portfolio, they are replaced by your custom gallery UI.

*   **Favorites & Bookmarks System:** Sorting, saving, and displaying lists.
*   **File List & Navigation:** Continuous scroll, middle-click, search filters, `.filename` visibility bugs, and keyboard navigation regressions.
*   **Layout & Styling:** Persistent column sizes, custom CSS persistence, and syntax highlighting.
*   **Window Management:** Detaching image windows, emergency boss keys, and fullscreen focus loss. (Note: Detaching images relies on Tauri window management because DOM elements cannot escape WebView2 bounds).
*   **Web Fetching & Remote Routing:** Determining where URLs come from.
*   **Update Indicators:** GitHub release checking.
*   **UI Sound Design:** Audio feedback for clicks and list navigation.

## 3. Backend & I/O Priorities (Rust / Tauri)

These items modify the Rust backend or the OS integration. They do not affect the portfolio web app, but they are critical for QuiviT Desktop.

### Priority 1: High-Impact / Core Reliability
*   **Instrumentation System (Test Harness):** Writing `cargo test` coverage for archive parsing, caching, and config schemas. This is the safety net required before major backend refactoring.
*   **.ico Spritesheet & Windows Icon Resolution:** Reworking how the backend fetches `SHGFI_LARGEICON` and how it passes those buffers to the frontend. The CL will just receive an array of URLs or a spritesheet image; the backend must do the heavy lifting of extracting and packing them.
*   **[COMPLETED] Archive Loading Bottlenecks:** Fixed seek costs and backward scans in corrupted archives (O(1) entry map, trailing EOCD scan, microsecond header and boundary validation across ZIP, RAR, 7Z, and TAR) and eliminated condition variable / mutex lock contention during extraction.

### Priority 2: New Features
*   **Thumbnail View & High-Res Icons:** Fetching `SHGFI_LARGEICON` via the Rust backend to render higher-resolution Windows icons in the file list.
*   **Extended Format Support (PSD, XCF, PDF):** Implementing Rust-side decoders to turn these formats into raw pixels or standard web formats before passing them to the CL.
*   **[COMPLETED] Password-Protected Archives:** Passing credentials through the IPC layer to `zip`, `unrar`, and `sevenz-rust2`, with frontend status signaling and locked container handling.
*   **Additional Metadata Formats:** Parsing `comicinfo.json` alongside the existing metadata parsers.
*   **Native 7-Zip Sidecar:** Using `7zr.exe` for faster LZMA2 extraction.

### Priority 3: Shelved / Low Value
*   **Windows Thumbnails (APNG/WebP/AVIF):** Explicitly marked out of scope.
*   **Video Support:** Out of scope for the image viewer context.

## Next Steps

1.  **Review this classification.** Confirm the boundary between the CL and the Host App aligns with your vision for the portfolio.
2.  **Define the extraction plan.** Once the boundaries are approved, we will map out the multi-slice roadmap to sever the CL from QuiviT's IPC and state machine, bundle it, and integrate it into the web.
