# CBZ Large-Image Broken Icon: Root-Cause Research Report

Status: RESEARCH COMPLETE (no code changes made). Complements `large-archive-loading-investigation.md`, which confirmed the 7z/Rust-side poll race; this report closes the cbz gap.

Date: 2026-08-05
Scope: Tauri v2.11.5 / wry 0.55.1 / tauri-runtime-wry 2.11.4 / WebView2, Windows.

## (a) Most likely cbz root cause

The Rust serving layer for zip/cbz is **correct** (on-demand extraction returns full bytes: verified by
`protocol_serve_timing_simulation` and extraction timing of 88-350 ms per large entry). The failure is in
**how wry/WebView2 delivers the response on Windows**, and it is a size/intermittency issue, not a
cbz-code-path bug.

Evidence chain:

1. **The handler runs on the WebView2 callback thread and BLOCKS it during extraction.**
   In `wry-0.55.1/src/webview2/mod.rs` the `add_WebResourceRequested` event handler calls
   `custom_protocol_handler(...)` **synchronously** (line 1021). It only *looks* async because
   `GetDeferral()` + `responder.respond()` is deferred; the closure body still executes on the WebView2
   thread. Tauri issue #15408 (open) documents that on Windows this handler can be invoked off the main
   thread: so extraction of the 7.8 MB jpg (~90 ms) or 31 MB BMP (~350 ms) runs on that callback thread.

2. **The response is marshalled to the main thread and delivered as a large `SHCreateMemStream` with NO
   `Content-Length`.**
   `async_responder` (`mod.rs:1012-1016`): if not already on the main thread it `PostMessageW`s to the
   window thread, which then builds the response. `prepare_web_request_response` (`mod.rs:1106-1131`)
   wraps the whole body via `SHCreateMemStream(Some(content))` and calls
   `CreateWebResourceResponse(stream, status, reason, headers_map)`: and `headers_map` contains ONLY the
   headers the app supplied. The app's handler (lib.rs:1255-1262) sets `Content-Type` + CORS but **no
   `Content-Length`**. So a 7.8-31 MB body is handed to Chromium as an unterminated-length stream.

3. **Contrast: the built-in asset protocol (used for regular images) sets `Content-Length` AND supports
   Range.**
   `tauri-2.11.5/src/protocol/asset.rs` sets `CONTENT_LENGTH` (lines 147, 209, 221) and serves byte ranges
   (206 Partial Content, `MAX_LEN = 1000*1024`: line 119). Regular images go through this path via
   `convertFileSrc` and are known-good even when large. The `quivit` path has neither Content-Length nor
   Range support.

4. **First-load congestion makes it intermittent.**
   On open, `core.js:154` → `prefetchAhead` (`fsUtils.js:466-494`) invokes `prefetch_archive_entries`
   (lib.rs:756) for 7-ahead + 3-behind: including the 31 MB BMP: at the same time the preloader
   (`viewer.js:268-288`) issues the first image request. The zip is re-opened per entry
   (`extract_zip_entry`, lib.rs:359). During this window the callback thread and main thread are busy, so a
   deferred large response can land after the renderer already aborted the request → `onerror` →
   `img.src = state.src` fallback → the same large URL retried (warm cache) can fail again → broken icon.

5. **Why navigating back/forth eventually works.**
   Once entries are warm in the LRU (lib.rs:1217-1226, capacity 20; 14 entries fit), every retry is served
   in microseconds with idle threads, so the request completes within WebView2/Chromium's tolerance window.
   Small archives never hit the window because extraction + body delivery are fast and small.

**Conclusion:** most likely root cause for cbz is a WebView2/wry custom-protocol **large-single-body
response delivery fragility on Windows** (deferred, length-less `SHCreateMemStream` response, delivered
after blocking the WebView2 callback thread), triggered by large images (≥7.8 MB) during first-load
congestion. This is format-agnostic: `zip`, `cbt`, `tar`, and (once temp files exist) `rar`/`cbr` serve
the identical 31 MB BMP over the same fragile path, so they should exhibit the same intermittent behavior.
7z/cb7 also have the CONFIRMED deterministic Rust-side 3 s poll race (lib.rs:1240-1246) → hard 404,
which explains why 7z is reliably broken while cbz is intermittently broken.

## (b) Upstream evidence

| Source | Evidence |
|---|---|
| `wry-0.55.1/src/webview2/mod.rs:1012-1016` | `async_responder`: if not on main thread → `PostMessageW` to window thread before `SetResponse`+`Complete` |
| `wry-0.55.1/src/webview2/mod.rs:1021` | custom protocol handler called synchronously on WebView2 event thread |
| `wry-0.55.1/src/webview2/mod.rs:1106-1131` | body → `SHCreateMemStream`; `CreateWebResourceResponse`; headers = app-supplied only (no auto Content-Length) |
| `tauri-runtime-wry-2.11.4/src/lib.rs:5197-5206` | `with_asynchronous_custom_protocol` wiring; responder responds later |
| `tauri-2.11.5/src/protocol/asset.rs:119,147,209,221` | asset protocol sets `CONTENT_LENGTH` and serves 1 MB range chunks (206): the working path for regular images |
| `lib.rs:1255-1262` (app) | quivit response: `Content-Type` + `Access-Control-Allow-Origin`, **no `Content-Length`**, full body |
| Tauri #15408 (open) | Windows custom protocol handler can be invoked off the main thread |
| Tauri #11505 | `register_uri_scheme_protocol` inconsistent on Windows; subresource requests fail/refuse |
| Tauri #3421, #9875 | custom-scheme freeze / page load failure family |
| Tauri #10582 (`b1d9ffa`, in 2.11.5) | fixes the internal `ipc://` fallback hang: NOT the `quivit` scheme; do not misattribute |
| MicrosoftEdge/WebView2Feedback #2789 | WebResourceRequested with large/custom responses → empty/truncated bodies; MS comment re streams closed too early |
| MicrosoftEdge/WebView2Feedback #2679 | WebResourceRequested reads the whole stream ignoring Range; "response stream cannot be too large" |
| Local timing | NanaZipC: zip BMP 350 ms, rar BMP 279 ms; `protocol_serve_timing_simulation`: 7z BMP poll = 3.02 s → **404**; cbz/tar first entry = 7,790,305 bytes OK |

## (c) Fix options ranked (likelihood × effort)

1. **Add `Content-Length` to the quivit response** (lib.rs:1255-1262, one line).
   Trivial effort; directly addresses the length-less whole-stream delivery that the asset protocol avoids.
   Best first experiment.
2. **Warm the current entry + reduce first-load congestion.**
   - In `prefetchAhead` (fsUtils.js:466-494) also prefetch the CURRENT index (or call `prefetch_archive_entries`
     with index 0..7 before the preloader fires), so the first image is served from LRU in µs instead of
     blocking the WebView2 callback thread with a cold extraction.
   - Avoid re-opening the zip per entry in `extract_zip_entry` (open once per prefetch batch).
   Small effort; removes the primary trigger.
3. **Frontend retry-with-backoff on image error for archive URLs** (viewer.js `preloader.onerror`).
   Retry N times with a short delay before showing the broken state; warm-cache retries are fast and mirror
   the manual "navigate back/forth" workaround. Small-medium effort; high UX impact, but does not fix the cause.
4. **Serve large entries via the asset protocol from a temp file (Content-Length + Range).**
   Extract on-demand to a temp file, then serve via `convertFileSrc` (`http://asset.localhost`), reusing the
   battle-tested path with Content-Length and 1 MB range chunks (asset.rs). Medium effort; highest-confidence
   architectural fix; adds temp-file lifecycle (mirrors the existing 7z temp-dir machinery).
5. **Stream/chunk the response with a proper Content-Length IStream.**
   Requires wry changes (custom IStream wrapper or chunked encoding); high effort. Only if #1-#4 fail.
6. **Memory/LRU tuning.** 14 × 31 MB ≈ 434 MB worst case: unlikely the direct cause; lowest priority.

Recommended sequence: 1 → 2 → 3 (cheap mitigations) then 4 (robust fix).

## (d) Confirm / rule-out tests

1. Add `Content-Length` header in the handler and re-open `cbz.cbz` in the app on the 31 MB BMP.
   Fixed → confirms length-less large-body delivery is the trigger.
2. Open `zip.zip`, `cbt.cbt`, `tar.tar`, `rar.rar`, `cbr.cbr` (identical content) in the app.
   Same intermittent failure → format-agnostic browser-side issue (supports (a)); only cbz+7z failing → the
   mechanism is different and needs revisiting.
3. Load a large (≥20 MB) image from a plain folder (asset protocol path). Reliable → asset path (Content-Length
   + Range) works while `quivit` fails; strongly supports fix #4.
4. Instrument the handler (log entry, bytes, extraction ms, cache hit/miss per request) and correlate with the
   broken-image events; confirm the warm-cache-on-retry narrative (request #2 after `onerror` is a cache hit).
5. Disable `prefetchAhead` temporarily and re-test. Failure disappears → first-load congestion is a confirmed
   trigger (supports fix #2).
6. Run WebView2 with `--enable-logging=stderr` (via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`) and capture the
   network error code on the failed image requests (net::ERR_*), to distinguish timeout vs. truncated body.
7. Loop `extract_zip_entry` on the 31 MB BMP 20× and assert full byte count each time (already implied by the
   existing test) to rule out Rust-layer data truncation.

## Key references

- `src-tauri/src/lib.rs`: handler 1148-1271, response build 1255-1262 (no Content-Length), LRU 1217-1226,
  `extract_zip_entry` 359, `prefetch_archive_entries` 756, `list_archive` 704.
- `src/js/fsUtils.js`: `buildArchiveSrc` 49-54, `prefetchAhead` 466-494.
- `src/js/viewer.js`: preloader 261-294 (onerror fallback → broken icon).
- `src/js/core.js`: `_selectEntry` prefetch call 153-155.
- Vendored crates (see paths above): wry webview2/mod.rs, tauri protocol/asset.rs, tauri-runtime-wry lib.rs.
- Upstream: tauri #15408, #11505, #3421, #9875, #10582; WebView2Feedback #2679, #2789.
