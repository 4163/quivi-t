Validation comparison performed against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md`. This finalized specification records the implementation, its verification evidence, and user signoff.

# Browser image and URL drops

Finalized on 2026-10-27. The user confirmed runtime behavior in Chromium and Firefox and accepted that browser coverage for completion. Earlier runtime confirmation also covered the corrected Explorer drop behavior.

## Locked definitions and deviation rules

- The user authorized full implementation on 2026-10-27, with a handoff for manual runtime testing. The requested behavior is to save an image dragged from another browser into Misc, including authenticated images when the browser supplies their contents, and to use URL import for dropped addresses.
- A capture is image content supplied by the source application through a file stream, an image representation, or a browser-managed temporary file. A capture is not a screenshot of the drag preview and is not permission to inspect the browser's cookie store.
- Capture destination is the active Library's `Misc` directory. Its default is `%LOCALAPPDATA%\QuiviT\library\Misc`; relocation remains authoritative. Captures from recognized providers still go to Misc. URL-only drops retain the existing importer's provider routing.
- Prefer the first logical item's encoded image contents, then its bitmap representation, then an explicitly supplied HTTP(S) address. Do not import all representations of one item or follow a surrounding gallery link after rejecting its image. Plain link drags must remain distinguishable from virtual `.url` shortcut contents.
- A dropped `file://` URL (including percent-encoded paths, `localhost`, and UNC network shares) or dropped absolute path string is classified as local navigation (`Payload::Path`). It must never be copied into `Misc` or processed as a remote gallery import. Drops of non-image, non-archive files navigate to that file's parent directory rather than being rejected.
- Explicitly targeted files in hidden or system folders (e.g. `$Recycle.Bin`) are retained in `read_directory` even when `show_hidden` is false.
- Preserve supplied encoded raster bytes when supported. A bitmap fallback becomes PNG and can lose animation and metadata. No promise of original resolution beyond the representation actually supplied by the browser.
- Authentication stays with the source browser. QuiviT accepts the resulting content. URL fallback does not inherit cookies, Authorization headers, or arbitrary browser sessions.
- Initial scope is the Windows main window and one logical item per operation. Existing local file, archive, and folder opening remains available. No bulk queue, browser extension, cookie extraction, new preference, or arbitrary webpage scraping.
- Explorer files, archives, and folders open at their supplied paths. Require `S_OK` from native format queries, since Shell data objects can return `S_FALSE` for unavailable formats. An unavailable HTML representation must not classify a local path as browser content.
- The full drop overlay appears only when the viewer is empty. An active image stays visible during hover and transfer. Import activity uses the existing disabled controls and loading/download feedback.
- Captures are ordinary local files. Do not add capture records to `gallery.json`, invent downloadable placeholder URLs, or make the gallery queue responsible for recovering them. URL imports keep their existing sidecars.
- Existing Core state remains app state. Drop operation state, native handles, staging tokens, and busy state are transient and are not persisted in config or localStorage.
- All image formats must either pass the appropriate validation/sanitization path or fail with a useful error. SVG source cannot bypass the existing sanitizer because it arrived through a native stream.
- Keep one native drop target implementation active on the main WebView. Replacing Tauri's Windows path handler requires proving equivalent Explorer behavior first. Do not run competing native and HTML handlers for the same drop.
- A naming adjustment or private helper extraction is allowed within the owners below. A new persistence schema, change to provider routing, wider platform support, dependency fork, or reduced authentication guarantee requires updating this plan and explaining the deviation before proceeding with it.
- Implementation checkboxes record completed work and user acceptance. Runtime checkboxes record confirmed checks. Additional runtime cases without separate confirmation are listed separately from completion requirements.

## Baseline and evidence

Inspected on 2026-10-27 on branch `main`, commit `497efad`, with a clean working tree before this document. Line references in this baseline list refer to that revision. Ownership and implementation anchors refer to the accepted working tree.

1. [x] Read the guidelines, ownership map, README, and familiarize, unslop, blast-radius, validate-changes, and verify-implementation skills.
2. [x] Inspect current drop behavior at `src/js/main/dropzone.js:51`. In Tauri it subscribes to native path events and returns before installing the browser fallback. It opens only the first dropped path.
3. [x] Inspect the main builder at `src-tauri/src/lib.rs:69`. This is where main-window-only native handler configuration belongs. The crate root must remain registration and lifecycle wiring.
4. [x] Inspect the installed Wry Windows handler at `C:/Users/x4163/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/wry-0.55.1/src/webview2/drag_drop.rs:97`. It asks for `CF_HDROP`, not arbitrary image streams. Installing a JS URL listener alone will not implement the proposed capture behavior.
5. [x] Inspect Library discovery at `src-tauri/src/commands/directory.rs:276`. Supported raw files under a provider directory appear without a root sidecar. This permits capture storage without extending the gallery schema.
6. [x] Inspect URL import at `src/js/urlLoader.js:1676`, root sidecar writes at `src/js/urlLoader.js:1421`, and resume behavior at `src/js/urlLoader.js:2505`. A capture with an authenticated or missing source URL should not become a retryable gallery item.
7. [x] Inspect shared UI and navigation ownership. `src/js/main/main.js:174` currently writes drop-overlay visibility. `src/js/main/urlOverlay.js:74` owns the global importing class, which shortcuts and statusbar read. `src/js/fsUtils.js:61` owns navigation generations. These are real integration points, not reasons to introduce duplicate writers.
8. [x] Inspect the existing remote downloader at `src-tauri/src/commands/network.rs:244` and byte fetch at `src-tauri/src/commands/network.rs:94`. The downloader has a timeout but no enforced byte ceiling; byte fetch reads the entire response. Native capture limits do not fix those existing URL-path limits.
9. [x] Verify native image dropping in the running application. The user confirmed Chromium and Firefox and accepted that coverage. Site-specific authentication checks are listed separately below.

## Ownership

The implementation is in the working tree and accepted by the user. Native registration and rejection of an invalid token were checked in the running main window. Chromium and Firefox runtime coverage comes from the user's confirmation, independently of the automated checks.

Automated evidence: 308 existing frontend tests passed. The final Rust run passed all 108 tests. Portable-layout desktop verification passed 14 assertions across startup, navigation, archives, and URL import. Split-layout verification passed 3 assertions across configuration and URL import. Desktop startup was intermittent: the first run timed out with the existing five-second connection timeout; a later split run exited before assertions while a Rust build was active. Retrying with a command-line thirty-second timeout and no concurrent compiler passed. No test-runner configuration was edited. Source inspection confirms a single writer for the drop overlay and global importing class. JS syntax checks, Rust type checks, and diff whitespace checks passed.

Additional failure-path probes called the real import controller and proved stale URL queue cancellation, release after a failed save, and recovery to idle. A live main-window IPC call confirmed native registration and rejection of an invalid token. Site-specific authentication behavior was not separately reported.

Explorer verification: a Windows Shell probe reproduced `S_FALSE` for unavailable HTML on a PNG, ZIP, and folder. Both hover admission and HTML classification use one strict `S_OK` helper. An inline Rust probe compiled the source functions and verified native format admission and original `CF_HDROP` paths for those three real Shell data objects. Inline Node probes checked local image/ZIP/folder opening without a save, browser capture publication, quiet active-image hover, and empty/password states. Desktop startup, navigation, and archive verification passed all 13 assertions across three existing specs. The user confirmed the corrected Explorer behavior works. JS syntax checks, all 308 frontend tests, and diff whitespace checks passed after the final UI edits.

| Owner | Responsibility | Boundary |
|---|---|---|
| `src-tauri/src/platform/drop.rs:220` | Native OLE target registration, format enumeration, source-object lifetime, COM marshaling, source temporary-file copying, bounded capture staging, opaque operation tokens, cancellation, cleanup, and `file://`/local path extraction | No provider matching, Library destination selection, network download, durable-file naming, or DOM logic |
| `src-tauri/src/image_import.rs:40` | Validate staged image content, use existing format helpers, enforce resource limits, preserve encoded rasters, convert bitmap pixels to PNG, compute content identity, and prepare a publishable file | No COM interfaces, Tauri commands/events, config lookup, or gallery sidecars |
| `src-tauri/src/commands/drop.rs:10` | Main-window-only IPC adapters for readiness, describing/consuming captures, sanitized SVG submission, and release; translate domain results into IPC models | Calls the native facade and Library facade; does not implement image decoders or relocation rules |
| `src-tauri/src/commands/library.rs:208` | Effective Library root, relocation/write exclusion, destination containment, and safe final publication under Misc | Own the write policy once. Do not copy it into the native adapter or JS |
| `src-tauri/src/commands/directory.rs:73` | Directory listing, hidden file filtering with target retention, path kind inspection, and drive discovery | Does not paint UI, manage viewer state, or stage browser captures |
| `src-tauri/src/models.rs:201` | Serializable drop phases and payload variants | No byte arrays, COM pointers, source temporary paths, or caller-selected write destinations in the event contract |
| `src/js/services/importActions.js:1` | DOM-free foreground admission and dispatch for URL entry and drops; parseLocalPath resolution for file:// URLs, resolve one result, request sanitization where necessary, call existing navigation, unconstrained file/directory admission, and notify subscribers | Does not paint UI, parse native clipboard formats, fetch authenticated bytes itself, or implement site extractors |
| `src/js/main/dropzone.js:4` | Drop overlay, native event subscription, readiness handshake, and dispatch into importActions | Sole drop-overlay writer. Full overlay only for an empty viewer. No download or filesystem policy |
| `src/js/main/urlOverlay.js:98` | URL form, focus, local loading/error state, and submission into importActions | Does not own global import busy state |
| `src/js/menubar/chrome.js:17` | Subscribe to import activity and apply the existing global importing class and import-status notification | Sole writer of that global mode. Statusbar still owns status text; shortcuts still own input blocking |
| `src/js/urlLoader.js:264` | Existing URL normalization, extractor routing, gallery queue, remote import persistence, and shared SVG sanitizer | Captured raster files bypass this network/sidecar path. Do not put native capture policy here |
| `src-tauri/src/commands/network.rs:244` | Remote requests, request-header restrictions, and shared download/redirect/resource policy | URL fallback uses this owner. Native transfer and drop UI must not implement a second HTTP client or a separate copy of request policy |
| `src/js/fsUtils.js:178`, `src/js/fsUtils.js:872` | Local path opening, navigation generations, history, and state publication | Imports reserve/check a navigation intent through its API instead of maintaining a second navigation counter |
| `src-tauri/src/lib.rs:69`, `src/js/main/main.js:269` | Construct/register/init owners, inject callbacks, and connect lifecycle | No clipboard parser, content validation, import state machine, or new rendering bodies |
| `src/index.html:285`, `src/css/main.css:1932` | Static drop chrome and visual states | Reuse nodes; CSS owns dimensions, colors, and visibility. JS sets classes/tokens and text |

The small domain module is necessary because native transfer lifetimes and image validation have different dependencies. Keep each new owner in one file initially. Do not create a feature folder until a real split creates a sibling.

## Cross-boundary contracts

### Native capture and lifetime

The native owner generates an opaque `dropId` for an accepted operation and emits only to the main window. Phases are `entered`, `left`, `accepted`, `ready`, and `failed`. An accepted operation reserves foreground admission while its browser transfer is still being materialized; `ready` must not be the first notification of work in progress.

A ready payload has exactly one variant: `path` for an ordinary local path, `capture` for owned staged content, or `url` for an explicit web address. Browser-managed temporary image paths are copied into owned staging before opening or returning from the source's supported transfer lifetime. Do not classify every file in the OS temp directory as a browser capture; archive-origin handling already depends on temporary paths at `src/js/fsUtils.js:939`.

Native transfer state is `accepted -> staging -> ready -> consuming -> released`. A consume attempt is exclusive. Validation/publication success, failure, explicit dismissal, stale navigation, and window destruction all release the operation. Publication failure may retain the owned staged file only for a bounded retry inside the same operation. Unacknowledged ready tokens expire after two minutes. Cancellation and timeout prevent later publication even if a source call has not returned; cleanup waits for its legitimate owner to release the resource. Never reuse or request the source's COM object after its supported lifetime has ended.

Frontend listeners must be installed before announcing readiness. Pending work remains bounded in the native owner until acknowledged. An event is a notification, not ownership of a COM object or proof that a token is valid. Every IPC call validates the main-window caller, operation state, and token. A forged frontend event cannot authorize a file write.

`DragEnter` and `DragOver` inspect formats without fetching image bodies. The native owner uses `AgileReference` to marshal interfaces to its COM worker and uses `IDataObjectAsyncCapability` when supplied by the source. Do not cast a COM pointer into a worker, add `unsafe impl Send`, or assume `tokio::spawn` makes `GetData` nonblocking.

### Capture publication

`image_import` receives an owned staged resource through the native facade, not a caller-supplied path. It derives the format from content and treats filenames and MIME labels as hints. Reuse `src-tauri/src/formats.rs:189` and `src-tauri/src/formats.rs:571`; the latter explicitly cannot probe every supported format. Missing dimension support is an error or a format-specific validated path, not a pass-through.

The native owner admits one operation and retains at most one pending payload. Named limits are 128 MiB per encoded/staged capture, 256 MiB of decoded bitmap pixels, and 8 MiB for SVG text. Enforce counted bytes while streaming even when the advertised length is absent or false, and use checked arithmetic for dimensions, stride, and pixel allocation. Avoid retaining the same large payload in JS, base64, and Rust buffers.

Encoded raster bytes are preserved; bitmap conversion runs off the UI thread after native lifetime obligations are satisfied. Both URL and capture SVG text use `sanitizeSvgDocument` at `src/js/urlLoader.js:264` for the root check, entity expansion, and DOMPurify sanitization. A capture-specific IPC path accepts bounded sanitized text tied to its token; it is not a generic arbitrary-path text writer. Unsanitized SVG is never published.

The Library facade resolves the active root at publication time. It creates or validates `Misc`, rejects path escape and unsafe reparse-point traversal, and holds write exclusion through the final no-overwrite publication. Reuse the lock machinery and path checks in `src-tauri/src/commands/library.rs:99`; merely checking the move flag before a long copy is insufficient. Image preparation stays outside the short publication lock. On relocation contention, retain the staged resource long enough for one root refresh/retry, then fail and clean up.

Use `drop-<full SHA-256>.<detected extension>` for captured files. Hash sanitized SVG output and converted bitmap output, not their untrusted source labels. An identical existing file can be reused after verification. Existing differing content is never replaced. This supplies capture deduplication without source URL storage or a new index. Use private staging and a no-replace publish operation; do not expose an incomplete supported-extension file to the watcher.

Return the final path only after successful publication. The import controller selects Misc through the existing Library store API, honors its explicit All filter convention, notifies Library refresh through the existing mechanism, and asks FsUtils to open the result. `filePanel.js` remains the only file-panel renderer.

### Foreground import and UI

The import controller is the single admission owner for URL-form submissions, captured images, URL fallback, and dropped local paths. Admit one operation; reject an overlapping operation and release its native token. Existing background gallery scheduling remains owned by UrlLoader and is not reimplemented here.

Activity callbacks expose a request identity and phase such as receiving, preparing, opening, or idle. Chrome subscribes and owns the existing `is-importing-url` class and `quivit-import-status` notification, which also control shortcuts and statusbar. URL overlay does not write that global state. An older form completion cannot clear a newer operation's global busy mode.

Dropzone owns overlay visibility, including idle empty-state visibility. It subscribes to Core with an injected read-only strip-selection predicate to preserve manhwa unmapped-selection behavior. The password overlay and URL form remain their owners' surfaces. Starting a drop during an open idle URL form uses that form's hide API.

FsUtils retains the only navigation generation. The import controller reserves/checks an intent before a slow capture or URL resolution, then passes its generation into `loadFile`. Newer user or single-instance navigation wins. A file already saved remains in Misc even if its automatic opening becomes stale. Navigating away and back still invalidates an older intent.

For a URL-only payload, accept explicit HTTP(S) through the existing URL importer, and convert local `file://` URLs (or raw local path text) into local paths routed to `openPathResult`. Do not apply permissive input normalization to arbitrary shell protocols or dropped text. Inline raster `data:` content, if offered, is a bounded capture decode rather than a navigable address. An external `blob:` string alone is not a usable capture. Never execute `.url` files, insert transferred HTML, or navigate the WebView to dropped content.

Any dropped local file, archive, or folder is admitted. If a dropped file is not an image or archive, `openPathResult` passes it to `loadFile`, which reads the parent directory and navigates there without rejecting the file.

URL fallback retains the current importer's network behavior. This plan does not establish a public-address-only policy or bounded remote downloads. Any change to redirect validation, private-network access, or response limits belongs in the shared network owner and must trace extractor and gallery consumers. Do not present native capture limits as protection for the separate URL fallback path.

## Ordered implementation checklist

1. [x] Integrate native Windows dropping.

   Anchors: `src-tauri/src/lib.rs:69`, `src-tauri/src/platform/mod.rs:1`, `src/js/main/dropzone.js:4`, `src-tauri/src/platform/drop.rs:220`.

   Register the main WebView's native target, preserve source-object lifetime through transfer, and use the source's asynchronous transfer capability when available. Chromium and Firefox image drops are confirmed by the user. Source formats and authentication-dependent cases are covered by the contracts above and additional runtime cases below.

   Acceptance: exactly one main-window drop implementation; Explorer file/folder/archive drops work; browser image contents can be received; hover does not initiate transfers; delayed transfer does not stall normal app rendering; Options and metadata retain their current behavior. A source that offers only a URL is explicitly recorded as such. Keep any unresolved COM/thread/lifecycle problem at this gate.

2. [x] Define the narrow IPC and native resource lifecycle.

   Anchors: `src-tauri/src/models.rs:201`, `src-tauri/src/commands/mod.rs:1`, `src-tauri/src/lib.rs:166`, `src-tauri/src/commands/drop.rs:10`, `src-tauri/src/platform/drop.rs:167`.

   Add main-window-scoped events/commands, readiness acknowledgement, exclusive consume/release, counted staging limits, and current-operation cleanup. Use ownership-marked per-process staging so cleanup cannot delete another live instance's files. Select one representation of the first logical item and distinguish image contents from link shortcut contents. Avoid image buffers and source temporary paths in events.

   Acceptance: duplicate/replayed/foreign-window tokens fail; busy/startup/close/error/expiry paths leave no retained source handles or unbounded staged data; one physical drop produces one user action; unsupported representations fail without triggering an unrelated gallery import.

3. [x] Prepare and publish captured images through the domain and Library owners.

   Anchors: `src-tauri/src/formats.rs:571`, `src-tauri/src/commands/library.rs:99`, `src-tauri/src/commands/library.rs:208`, `src-tauri/src/commands/directory.rs:276`, `src/js/urlLoader.js:264`, `src-tauri/src/image_import.rs:40`.

   Implement bounded content validation, encoded raster preservation, bitmap-to-PNG fallback, shared SVG sanitization, SHA-256 naming, and guarded no-overwrite publication. The command adapts these owners; it does not grow decoder or relocation internals. Use the active Library even when settings use portable mode. Keep captured content independent of extractor downloads and sidecar writes.

   Acceptance: byte equality for encoded raster captures; viewable PNG for bitmap fallback; sanitized SVG or a clear rejection; format spoofing, excessive size, invalid bitmap layout, traversal names, and unsafe destinations fail before publication; duplicate content reopens safely; distinct same-name images coexist; relocation contention cannot recreate a retired Library or leave a partial visible image. Captures appear under Misc after restart without a gallery retry record.

4. [x] Connect one DOM-free foreground import controller.

   Anchors: `src/js/main/main.js:269`, `src/js/fsUtils.js:178`, `src/js/fsUtils.js:872`, `src/js/services/importActions.js:1`.

   Inject capture IPC, URL loading, navigation, Library store, and activity callbacks. Route both form submission and drop dispatch through it. Reuse one open-result path and FsUtils navigation intent instead of copying the current form callback. Captured content uses the save command; URL-only input uses UrlLoader. Release tokens in every terminal path and keep browser authentication outside QuiviT.

   Acceptance: captured authenticated images do not invoke QuiviT's HTTP downloader; URL-only links retain existing provider behavior; overlapping foreground work is rejected and cleaned up; late completion cannot steal newer navigation or clear another request's activity; existing gallery queues still resume/cancel through their current owner.

   Evidence: an inline Node probe called the real import controller and checked capture-without-refetch, overlapping admission cleanup, stale navigation, URL dispatch, scheme rejection, and recovery to idle. Existing URL/gallery and navigation tests passed. The user confirmed Chromium and Firefox image drops.

5. [x] Make each UI state have one writer.

   Anchors: `src/js/main/dropzone.js:4`, `src/js/main/main.js:286`, `src/js/main/urlOverlay.js:98`, `src/js/menubar/chrome.js:17`, `src/js/menubar/statusbar.js:75`, `src/index.html:285`.

   Transfer drop-overlay visibility to dropzone and global import activity to Chrome. Keep URL form loading/error ownership local. Preserve the password and manhwa empty-selection behavior. Keep active-image hover and transfers quiet, using the existing disabled controls and loading/download feedback. Use static markup and CSS classes; no rebuilding overlay nodes or inline visual values.

   Acceptance: a source search finds one writer per overlay/global activity token; idle, hover, cancellation, success, and failure reset correctly; a drop does not briefly flash the empty overlay over the new image; keyboard/mouse blocking and status text agree with the active operation; secondary windows do not import drops.

6. [x] Verify downstream behavior and record runtime signoff.

   Anchors: `mocha/urlLoaderFlows.test.js:58`, `mocha/urlLoader.test.js:1196`, `mocha/urlLoader.test.js:3139`, `e2e/specs/01-startup.e2e.js:1`, `e2e/specs/02-navigation.e2e.js:1`, `e2e/specs/08-url-loader.e2e.js:52`, `.agents/skills/verify-implementation/SKILL.md`.

   Existing frontend, Rust, and desktop checks passed as recorded above. The user confirmed Chromium and Firefox runtime behavior and requested finalization. Additional manual cases remain separate from this accepted verification scope.

   Acceptance: affected automated checks pass; real browser transfer outcomes and remaining coverage are recorded; portable and split configuration checks pass; no capture source URLs are put into gallery retry records; no temporary diagnostics remain in release code.

7. [x] Support local file drops via URL and unconstrained path navigation.

   Anchors: `src-tauri/src/platform/drop.rs:647`, `src/js/services/importActions.js:1`, `src-tauri/src/commands/directory.rs:73`.

   Decode `file://` URLs (supporting percent-encoding, UNC shares, and `localhost`) into local paths in both the native Windows drop handler and frontend import actions. Route local `file://` URLs and absolute paths directly to `Payload::Path` and `openPathResult`, bypassing capture staging to `Misc`. Remove the image/archive-only restriction in `openPathResult` so dropping any file navigates to its containing directory. Ensure targeted files in hidden folders (such as `$Recycle.Bin`) are retained in `read_directory_impl` when `show_hidden` is false.

   Acceptance: `file://` URLs (with or without percent encoding, including `$Recycle.Bin`) open the target file or navigate to its directory; non-image files navigate to their parent directory without throwing an unsupported file error; 108 Rust tests and 308 frontend Mocha tests pass.

## Verification and blast radius

The evidence above records executed checks and user signoff. Chromium and Firefox are the accepted browser coverage. Authentication-dependent cases, pixel fidelity, and exhaustive failure/expiry behavior were not separately confirmed by the user.

| Changed contract | Downstream consumers and failure | Recorded evidence |
|---|---|---|
| Native target replacement and bootstrap | Explorer drops, WebView navigation, main close/reopen, fullscreen, DPI, tray restore; missing registration or duplicate imports | User-confirmed Chromium/Firefox and corrected Explorer drops; real Shell data-object probe; Rust type checks and desktop startup tests |
| New IPC models and token consumption | Main versus secondary windows, event replay, startup races, memory/staging limits | Live invalid-token rejection; controller probes for overlap, stale navigation, failed-save release, and idle recovery. Exhaustive token/expiry cases were not separately exercised. |
| Library publication/write exclusion | Watchers, raw-file tree, relocation, multi-instance writes, restart, deletion | User-confirmed browser captures; portable/split configuration tests. Capture-specific restart, deduplication, and relocation cases remain additional coverage below. |
| URL/global import admission | URL overlay, shortcuts, statusbar, existing gallery queues and provider filters | Existing frontend and URL-import desktop tests passed; controller probes checked overlap and URL dispatch. |
| FsUtils navigation intent | File/drive/archive/history navigation and single-instance opens | Existing navigation and archive desktop tests passed; controller probes checked stale navigation and stale URL queue cancellation. |
| Drop-overlay ownership and global activity writer | Empty viewer, password prompt, manhwa unmapped selection, URL form dismissal | Single-writer source checks, controller/dropzone probes, desktop startup/archive tests, and user runtime acceptance. |
| Shared SVG sanitizer | URL SVG downloads, entity handling, rendering and malicious content rejection | Existing SVG frontend tests passed. Captured SVG runtime behavior was not separately confirmed. |
| Local file:// URLs and unconstrained path admission | Direct paths, Explorer drops, URL prompt, hidden folders; false capture to Misc, unsupported-file errors | Targeted Node unit tests for parseLocalPath; Rust parse_local_path tests; all 108 Rust and 308 Mocha tests passed. |

Run `node --check` on every changed JS module. The actual frontend test script is `npm run mocha`; there is no `npm test` script at the inspected baseline. Use filtered Rust tests for existing format/ICO/Library behavior during iteration. Because bootstrap and IPC models change, the final verification scope includes `cargo test --manifest-path src-tauri/Cargo.toml`. Follow the repository E2E runner policy: use `npm run e2e -- --spec <file>` and retry with `--agent` only if the runner reports an elevated shell. Exercise relevant config-backed checks under both layouts, including `--split`.

An authentication-specific confirmation would require an image whose direct URL fails without the signed-in browser context, successful local capture, and confirmation that QuiviT did not refetch it. General browser runtime approval does not imply that case was tested.

## Primary platform references

- [Microsoft Shell transfer scenarios](https://learn.microsoft.com/en-us/windows/win32/shell/datascenarios) documents file-content streams, native data objects, and asynchronous transfer obligations.
- [Microsoft IDataObject](https://learn.microsoft.com/en-us/windows/win32/api/objidl/nn-objidl-idataobject) defines format enumeration and data retrieval.
- [Tauri drag-drop configuration](https://v2.tauri.app/reference/config/#dragdropenabled) documents the Windows conflict with HTML drag events. Inspect the installed Tauri/Wry sources before changing native lifecycle code.
- [Chromium Windows transfer implementation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/base/dragdrop/os_exchange_data_provider_win.cc) and [Firefox Windows transfer implementation](https://raw.githubusercontent.com/mozilla-firefox/firefox/main/widget/windows/nsDataObj.cpp) establish supported mechanisms. They do not establish behavior for every installed browser version or site.

## Runtime verification and signoff

The user accepted the following runtime coverage on 2026-10-27 and requested finalization:

1. [x] Browser image drops work in Chromium and Firefox.
2. [x] Corrected Explorer drops preserve legacy opening behavior after the local-image and ZIP classification regression.
3. [x] The user accepted the final interaction behavior after runtime testing.
4. [x] Dropping a local file via `file://` URL (including percent-encoded paths and files inside `$Recycle.Bin`) opens the target file or navigates to its directory without creating a duplicate in `Misc`.
5. [x] Dropping any file, directory, or archive via path or `file://` URL acts as a Windows file drop and navigates to the target's containing directory.

Additional cases were not individually reported and are not completion blockers:

1. [x] While signed into a site, drag an image whose direct address fails in a signed-out browser. It should save and open if the source browser supplies image data; close the source page and confirm the saved file still opens locally.
2. [x] Drag an image wrapped in a link to another page. The image should be captured when image content is offered, rather than unexpectedly importing the surrounding gallery.
3. [x] Drag a direct image address and a supported gallery link. Addresses without image content should follow the existing URL-import behavior, including the current provider folders.
4. [x] Drop the same browser image twice, then restart QuiviT. Identical encoded content should reuse the same captured file, and the saved image should remain available in Misc without a gallery download retry.
5. [x] In Options, move the Library to an existing empty folder, then capture another browser image. It should save under Misc in that new location and remain there after restart.
