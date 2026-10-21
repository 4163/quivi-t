# Image thumbnails and previews specification

Validation comparison performed against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md` before finalizing this document.

Status: finalized on 2026-10-22 at the user's request. The accepted implementation is the version-5 preview contract. The user confirmed the raster previews, GIF follow-up, static AVIF repair, ICO spritesheet, PowerToys SVG delegation, direct QuiviT SVG animation, removal of loading text, and independent animated image previews across multiple Explorer windows. Subsequent user and code verification covers the remaining preview checks below. The final association error-message follow-up also has user runtime signoff. No acceptance checks remain open.

The shared packaging, staging, CLI, registration identities, and update rules are defined in [previews-host-spec.md](previews-host-spec.md). The native archive pane is documented in [preview-handler.md](preview-handler.md).

## Accepted behavior

| Format | Explorer preview pane | Thumbnail |
| --- | --- | --- |
| WebP | Static image or animation repeating indefinitely | Native, static first composited frame |
| APNG | Static image or animation repeating indefinitely | Native, static first animation frame |
| AVIF | Static image or animation repeating indefinitely | Bundled native decoder, static first frame |
| GIF | Static image or animation repeating indefinitely | Existing Windows provider; no QuiviT thumbnail hook |
| SVG | Authored declarative animation timing, when QuiviT owns the pane | Static resvg rendering, when QuiviT owns the thumbnail slot |
| ICO | Native spritesheet of distinct dimensions | Existing Windows provider; no QuiviT thumbnail hook |

No new handlers are registered for ordinary PNG or general video. Existing main-viewer behavior is unchanged.

Raster animation repeats indefinitely so Explorer users can inspect motion without a replay control. SVG retains authored timing because forcing repeats can disturb dependent or chained animations. Finite SVG animations can stop; authored infinite animations continue. Previewing never rewrites source files.

An APNG can have a default PNG image outside its animation. Its thumbnail and player start with the first animation frame rather than assuming IDAT is frame zero.

Image panes paint Explorer's supplied background while media loads. There is no visible "Loading preview..." placeholder. Decode or runtime failures still produce a visible error.

QuiviT image ProgIDs use an empty `TypeOverlay` string to suppress Explorer's application-logo badge consistently. Apply and repair share this policy. Other applications' ProgIDs are not changed.

### SVG coexistence

A registered non-QuiviT SVG preview handler or thumbnail provider causes both QuiviT SVG shell implementations to be skipped. Merely installing PowerToys without registered SVG shell support does not trigger the skip. There is no override setting.

Detection checks merged shell registration through the extension, UserChoice/default ProgIDs, SystemFileAssociations, and QuiviT's own relayed references. It preserves non-QuiviT slot values conservatively rather than identifying a provider by its filename.

Changing the default open ProgID must preserve effective SVG preview and thumbnail resolution. QuiviT can relay the external CLSIDs under QuiviT.svg with source metadata, but it does not edit the third party's source keys or class servers. Either external slot suppresses both QuiviT implementations, including when the other slot is absent.

This skip applies to shell rendering. SVG opening in QuiviT remains available. Apply and launch/repair reevaluate the shell ownership.

### ICO layout

The shared ICO parser supplies valid frames, deduplicated by dimensions and ordered largest first. The shell composes them in one horizontal row:

- Width is the sum of frame widths.
- Height is the greatest frame height.
- Each frame's vertical offset is half the difference between the row and frame heights, rounded down.
- The whole row scales down proportionally when necessary. Natural sizes are retained when space permits, and small frames are not individually inflated.
- Transparency is composited against Explorer's background.

The existing `Vec<IcoSize>` and per-size PNG data-URL IPC shapes remain unchanged.

## Implementation ownership

| Concern | Owner and lookup |
| --- | --- |
| Early pane and thumbnail dispatch | [main.rs](../src-tauri/src/main.rs), `main` |
| Shared GUIDs and proxy name | [previews/contract.rs](../src-tauri/src/platform/previews/contract.rs) |
| Stable staging, hashes, capability version | [previews/host.rs](../src-tauri/src/platform/previews/host.rs) |
| Eligibility, SVG resolution, per-class registration and removal | [previews/windows.rs](../src-tauri/src/platform/previews/windows.rs) |
| Shared COM pump and source routing | [windows/com_server.rs](../src-tauri/src/platform/previews/windows/com_server.rs), `PreviewHandler` |
| Image/ICO child surfaces and browser lifetime | [windows/image_pane.rs](../src-tauri/src/platform/previews/windows/image_pane.rs), `ImagePane` |
| Wrapper structure and presentation | [preview_player.html](../src-tauri/src/platform/previews/windows/preview_player.html) and [preview_player.css](../src-tauri/src/platform/previews/windows/preview_player.css) |
| Raster playback and native-image fallback | [preview_player.js](../src-tauri/src/platform/previews/windows/preview_player.js), `start` and `paintFrame` |
| Standard DLL forwarding | [windows/thumb_proxy.rs](../src-tauri/src/platform/previews/windows/thumb_proxy.rs) |
| Thumbnail COM interfaces and worker lifetime | [windows/thumb_server.rs](../src-tauri/src/platform/previews/windows/thumb_server.rs) |
| Native decoding and thumbnail bounds | [previews/thumb_decoders.rs](../src-tauri/src/platform/previews/thumb_decoders.rs) |
| First AV1 sample and optional alpha from AVIF sequences | [previews/avif_sequence.rs](../src-tauri/src/platform/previews/avif_sequence.rs) |
| Premultiplied BGRA DIB ownership | [windows/bitmap.rs](../src-tauri/src/platform/previews/windows/bitmap.rs), `Bitmap` |
| Shared ICO parser and compositor | [ico.rs](../src-tauri/src/ico.rs) |
| Apply, repair, launch sync, diagnostics | [commands/registry.rs](../src-tauri/src/commands/registry.rs) and [models.rs](../src-tauri/src/models.rs) |

These are implementation owners, not proposed modules. There is no second ICO parser or main-app protocol added for shell previews.

## Native thumbnail contract

Windows loads `quivit-thumbnail-proxy.dll` through standard COM. The proxy forwards initialization and bitmap extraction to the EXE's `--previews-thumb` local server. It does not decode media in Explorer or start a browser.

The thumbnail server initializes through IInitializeWithStream. It reads the COM stream on its calling thread in 64 KiB chunks. Only plain bytes cross into decoding; an apartment-bound stream proxy is not moved to a worker.

Native decoders produce straight RGBA. The DIB boundary converts once to top-down, premultiplied BGRA and returns WTSAT_ARGB. Explorer owns a successfully transferred HBITMAP. Failure paths release their bitmaps and decoder resources.

The implementations use the existing image decoder for WebP/APNG, bundled `aom-decode 0.2.14` with static libaom for AVIF, and `resvg 0.48.1` with tiny-skia for SVG. AVIF thumbnails require no optional Windows codec or runtime codec DLL. Higher-depth native pixels are converted to 8-bit thumbnail output.

SVG thumbnails are static document rendering. They do not evaluate animation or scripts, and there is no browser fallback. A warm render below 5 ms is a measured target, not a guarantee for every SVG or process startup. Spinner samples at 256 px measured 1.46 to 1.83 ms warm; the complex koi sample was about 18 ms. These do not establish a cold-start bound.

### Limits and compatibility

| Resource | Bound |
| --- | --- |
| Encoded thumbnail input | 128 MiB |
| Aggregate stored thumbnail inputs | 256 MiB per worker |
| Decoded native image | 256 MiB and maximum edge 32,768 |
| SVG thumbnail input | 16 MiB |
| Thumbnail output edge | `min(cx, 1024)`; zero is invalid |
| Native decoding concurrency | Serialized within a thumbnail worker |

Explorer requested `cx=2560` during testing. The provider accepts a positive request above 1024 and caps output rather than rejecting the request. A real APNG extraction returned a proportional 184×199 bitmap for both 2560 and 1280 requests.

Two fixture compatibility cases are deliberate. Animated AVIF detection includes avis and compatible AVIF brands, then extracts the first AV1 movie-track sample plus optional alpha. An animated WebP fixture shares a final subchunk padding byte with ANMF; an in-memory copy accounts for it before decoding. Source files remain unchanged. Malformed or unsupported input returns an error within the configured limits.

## Preview pane lifecycle and security

The archive and image CLSIDs share the native COM pump. Host callbacks record state and queue window operations. Workers load plain data. Epoch and window-generation checks reject superseded results, late browser creation, and messages for recycled HWNDs.

Image loading uses one reader with at most eight pending jobs. Reads check cancellation in 64 KiB chunks and accept at most 128 MiB per media input. The ICO parser imposes its own tighter entry, dimension, and decoded-memory limits.

ICO remains native. Other image panes create WebView2 lazily and reuse a cached native environment for their controllers. Browser creation and destruction stay on the owning pump thread; WebView objects are dropped outside locks to tolerate reentrant callbacks.

The browser serves only embedded wrapper assets and the selected media through the isolated secure origin `https://quivit-preview.localhost/`. CSP, request filtering, navigation checks, and download/popup denial prevent external document activity. SVG source scripts are disabled. Responses use no-store and nosniff headers.

The profile directory is resolved through `SHGetKnownFolderPath(FOLDERID_LocalAppDataLow)` and placed under `QuiviT\preview-webview`. This works with Explorer's observed low-integrity activation. Browser creation uses explicit initial bounds and does not take focus; explicit host focus requests remain separate. The additional browser arguments retain WebView2's default security features.

Raster playback uses WebCodecs ImageDecoder with explicit frame indices. It waits for both decoder completion and track discovery, then selects an animated track if available. It does not set preferAnimation during construction. That preference made WebView2 reject metadata discovery for the valid static AVIF fixture.

Single-frame raster files and SVG use the native browser image element. Animated raster frames paint to a canvas with the authored frame durations and wrap indefinitely. The canvas is bounded to 4096 per edge and 16 × 1024² pixels. Every VideoFrame is closed after drawing. Visibility changes pause playback, and unload closes the decoder and cancels pending work.

Unload also removes native children, releases bitmaps and controllers, and invalidates pending callbacks. Pane tasks and idle timers target a private message-only window so Wry's nested pump cannot consume thread-only messages without dispatching them. The helper exits after its 30-second idle window once COM objects and server locks are released.

## Thumbnail hosting decision and proof

The initial EXE-only thumbnail design failed a real Windows-cache activation gate, despite direct COM success. A Windows DLL control passed on the same test data. The user then approved an embedded, staged proxy while retaining one release EXE download.

| Exercised path | Observed result |
| --- | --- |
| Direct EXE IInitializeWithStream and GetThumbnail | S_OK; valid 32×16 alpha bitmap |
| EXE-only IThumbnailCache with WTS_FORCEEXTRACTION | 0x80040154, REGDB_E_CLASSNOTREG; no provider activation |
| EXE-only cache with WTS_EXTRACTINPROC or WTS_REQUIRESURROGATE | Same class-not-registered result |
| Windows PhotoThumbnailProvider DLL control | S_OK in all three cache modes |
| QuiviT staged proxy forwarding to the EXE | S_OK in all three cache modes; worker initialization and extraction observed |

The controlled alpha sample returned first BGRA bytes `19-32-64-80` for source RGBA `200,100,50,128`, matching premultiplication. The corrected shell category was used for the decisive comparison. An earlier probe with the draft's misspelled category is excluded.

Disposable gate registrations were removed. Runtime probe code stayed outside release sources, and no permanent test suite or harness was added during implementation.

## Verification record

These results were recorded on 2026-10-21 and 2026-10-22. They were not rerun merely to finalize these documents.

| Area | Evidence |
| --- | --- |
| Static thumbnails | Real cache extraction for still and animated WebP/APNG/AVIF, plus native SVG samples; user confirmed thumbnail appearance, badge removal after refresh, and transparent edges |
| APNG frame selection | Separate red default image and blue first animation frame; thumbnail and player both return blue |
| Raster loops | Actual WebView2 observed WebP, APNG, and AVIF beyond authored repeat counts; the version-5 player observed two wraps for WebP/AVIF/GIF and four for an APNG with repetitionCount 2 |
| GIF and static AVIF | User confirmed no_loop.gif and pixiv_final-gif.gif animate, the finite GIF repeats, and still_single_frame.avif displays; single-frame GIF also passes browser checks |
| Loading transition | User confirmed file switching no longer shows loading text |
| SVG ownership | User confirmed PowerToys handles registered SVG previews; effective preview and thumbnail CLSIDs remain external at their source and under QuiviT.svg |
| QuiviT SVG rendering | User confirmed the spinner in a separate direct activation of QuiviT's image CLSID; finite SVG screenshots changed during animation and matched after two authored repeats |
| ICO | Existing IPC tests pass; user confirmed the spritesheet, wide/narrow pane sizing, and keyboard focus behavior; native background, resize, and unload checks pass |
| Shared lifecycle | 100 rapid mixed selections returned with a maximum observed DoPreview latency of 47 ms; the corrected idle stress run exited after 30,108 ms |
| Background and bounds | Browser resized from 640×400 to 240×180 and matched supplied RGB backgrounds 17,34,51 and 187,204,221; ICO corner pixels matched the supplied COLORREF |
| Explorer activation | Version-5 release activated at low integrity and created visible native/browser children for GIF |
| Multiple windows | User confirmed archive previews and animated image previews work independently in multiple Explorer windows |
| Diagnostics and staging | Actual IPC reported class ownership, proxy health, capability version, and SVG skip state; portable and split-config release launches used the same global host |
| E2E isolation | Existing config cases passed in split and portable layouts without changing the real helper/proxy hashes; the first portable driver attach timed out and a clean retry passed |
| Static checks and builds | cargo check --tests, all 108 Rust tests including 12 host tests, all 308 frontend tests, node --check for the player, git diff --check, and debug/release builds passed |

PowerToys-rendered SVG observations are not evidence that QuiviT's renderer works. The separately activated QuiviT spinner check provides that evidence.

### Follow-up coverage, 2026-10-22

| Check | Result |
| --- | --- |
| Thumbnail badges and transparent edges after refresh | User confirmed pass |
| External SVG preview-only and thumbnail-only states | Code and production-function checks passed; the user requested code verification instead of manual toggling |
| Partial image/archive association removal and restoration | User confirmed pass, with the error-message issue recorded below |
| Keyboard focus and ICO appearance at wide/narrow pane sizes | User confirmed pass |

The single-slot SVG check compiled the unchanged production detection and preservation functions in memory and exercised nine transitions in a process-local registry sandbox: preview-only, thumbnail-only, then preview-only again, each resolved through the extension, default ProgID, and UserChoice. Assertions confirmed that either slot triggers external ownership, the absent slot has no QuiviT handler, obsolete inherited relays are removed, original fixture registrations survive, and repeated preservation is a no-op. Source inspection also confirmed that registration returns through this preservation path before creating QuiviT classes.

This is function-level registry verification, not an Explorer rendering test. No real PowerToys registration was changed. Registry overrides were restored and the disposable sandbox key was removed. These four preview checks no longer require manual confirmation.

## Explorer startup repairs

Real Explorer activation exposed failures that the earlier medium-integrity direct COM checks did not:

- WebView2 `0x800700AA` occurred with the helper's low-integrity token and an unsuitable writable profile location. Resolving the LocalLow known folder repaired that path.
- Browser creation then hit `0x80070057` during automatic startup focus. Disabling automatic focus and supplying initial bounds repaired the controller creation.
- Explorer's large thumbnail requests exceeded the original rejection threshold. Capping positive requested sizes repaired those extractions.
- Valid static AVIF metadata discovery failed with preferAnimation=true. Discovering tracks first repaired static files while retaining animated AVIF selection.

Capability version 3 introduced image panes and the thumbnail proxy. Version 4 refreshed the Explorer startup, overlay, and thumbnail-size fixes. Version 5 adds GIF pane support, empty loading surfaces, and the static AVIF track-selection repair. The shared host spec defines the actual update and registration gates.

## Windows Internet-zone behavior

The following fixtures retain `Zone.Identifier` with `ZoneId=3`:

- `test-files/animated/export_1785518859589.webp`
- `test-files/animated/export_1788174887667.avif`
- `test-files/issue.zip`

Windows security updates from October 2025 block preview activation for Internet-zone files before QuiviT runs. The user requested a cause and YAGNI assessment, so no trust marks or Windows security policies were changed. This is not a decoder or archive-preview defect.

For a file the user trusts, Properties → Unblock is the per-file Windows action. QuiviT does not automate it. [Microsoft KB5070960](https://support.microsoft.com/en-us/servicing/os/windows/docs/2025/10/file-explorer-automatically-disables-the-preview-feature-for-files-downloaded-from-the-internet)

## Tested release artifact and build requirements

This is the local artifact used for preview verification before the later File Types error-message change, not a published release. Later builds can replace the executable at this path; the association UI follow-up is recorded below.

| Item | Recorded value |
| --- | --- |
| Preview capability | 5 |
| Local executable | `src-tauri/target/release/tauri-app.exe` |
| Executable size | 33,270,784 bytes |
| Executable/staged-host SHA-256 | `5ef0fe7ee2be4ff9c1afeba0304d04e47d68e5e46def646e0c52487aca300f51` |
| Proxy SHA-256 | `d489fda5605f1421b094ba37813938192233bc444bd5daef5d8796c35c2b9ca4` |
| Defender signature | 1.461.135.0; real-time protection enabled |
| Defender result | Custom scans of the release EXE and staged bin folder completed with no new detections |

A local clean scan does not establish SmartScreen reputation or guarantee future signatures. The release remains one EXE download, with the proxy embedded and staged at runtime.

Building static libaom on this host requires the MSVC C++ toolchain, CMake, Ninja, and NASM. The recorded build used the Visual Studio developer shell, `CMAKE_GENERATOR=Ninja`, and NASM 2.16.03 under ignored `src-tauri/target/build-tools`. These are build prerequisites, not end-user installations. The PE has no AVIF codec DLL import.

Debug linking reports the existing libaom MSVCRTD conflict warning. The release build does not import that debug CRT. Temporary fixtures, logs, and portable proofs remain under ignored `src-tauri/target` rather than release assets.

## Association error-message follow-up, 2026-10-22

The user passed the remaining manual preview checks but found that a blocked association update displayed only a generic failure. The backend already returned the reason and retry instructions; associationsUi.js discarded that detail, and the Options footer truncated long status messages.

The user requested concise indicators that retain useful recovery information. Known preview-update lock errors now display:

> File types could not be updated. Previews may still be in use. Close all File Explorer windows, then save again.

The existing Options save flow prefixes this with "Settings saved." when other settings were saved successfully. Console logging retains the full error. Other failures keep their specific reason, including registry and disk-space errors. The existing missing-release instruction is preserved. options.css allows the status to wrap instead of hiding its ending behind an ellipsis.

Verification covers eleven error/retry cases through the actual association module, all 308 frontend tests, and both existing Options E2E cases. A controlled IPC failure in an isolated release window exercised the actual Save handler and confirmed that the concise message and Save button remain visible at 800 px and the 400 px minimum width. Screenshots were inspected. Diagnostics used isolated config/profile paths and the E2E guard; real helper/proxy hashes stayed unchanged. No permanent test suite or harness was added.

The final debug and release builds pass. The rebuilt release embeds the concise copy and passed the same Save-handler and layout checks. It is 33,270,784 bytes with SHA-256 68352c42b4f9454d706325100f59a79665fa0d7e1550bab81bcc1d773d8723d0. Defender scans of that EXE and the staged bin folder found no new detections with real-time protection enabled and signature 1.461.135.0. The existing debug-only libaom CRT warning remains.

The user confirmed the concise error message works at runtime on 2026-10-22. The four preview coverage checks and this follow-up are closed. There is no preview capability bump because the change affects only Options copy and layout.

## Research references

The PowerToys source inspected on 2026-10-21 embeds SVG without rewriting repeat counts. That informed the authored-timing decision; it is not an independent interactive test of PowerToys timing.

- [PowerToys SVG control](https://github.com/microsoft/PowerToys/blob/main/src/modules/previewpane/SvgPreviewHandler/SvgPreviewControl.cs)
- [PowerToys SVG HTML generator](https://github.com/microsoft/PowerToys/blob/main/src/modules/previewpane/SvgPreviewHandler/SvgHTMLPreviewGenerator.cs)
- [PowerToys SVG layout helper](https://github.com/microsoft/PowerToys/blob/main/src/modules/previewpane/common/Utilities/SvgPreviewHandlerHelper.cs)
- [resvg static SVG scope](https://github.com/linebender/resvg#svg-support)
- [Windows thumbnail-provider initialization](https://learn.microsoft.com/en-us/windows/win32/api/thumbcache/nn-thumbcache-ithumbnailprovider)
- [Building Windows thumbnail handlers](https://learn.microsoft.com/en-us/windows/win32/shell/building-thumbnail-providers)
- [GetThumbnail bitmap contract](https://learn.microsoft.com/en-us/windows/win32/api/thumbcache/nf-thumbcache-ithumbnailprovider-getthumbnail)
- [Windows application-badge overlays](https://learn.microsoft.com/en-us/windows/win32/shell/thumbnail-providers#thumbnail-overlays)
- [APNG default images and animation frames](https://www.w3.org/TR/png-3/#4Concepts.APNG)
- [WebCodecs image decoding and track selection](https://www.w3.org/TR/webcodecs/#image-decoding)
- [Wry startup-focus issue](https://github.com/tauri-apps/wry/issues/1798)

These three preview documents are finalized at the user's request. Branch-wide cleanup or an architecture/README update is separate work. No commit, release publication, or additional code change is implied by this documentation finalization.
