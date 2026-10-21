# Explorer archive preview implementation

Validation comparison performed against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md` before finalizing this document.

Status: finalized on 2026-10-22 at the user's request. The archive pane has user runtime signoff, including independent previews in multiple Explorer windows. The shared File Types error-message follow-up also has final user runtime signoff. No acceptance checks remain open. This document records the current implementation and the failures that shaped it.

The shared executable, staging, registration, and version rules live in [previews-host-spec.md](previews-host-spec.md). Image panes and thumbnail providers are covered by [image-previews-spec.md](image-previews-spec.md).

## Accepted behavior

Archives associated with QuiviT display a native file tree in Explorer's preview pane. The tree uses QuiviT's light or dark palette, system file icons, expandable folders, selection, and scrolling. Listing reads archive metadata without extracting entry contents into the main viewer cache.

The pane accepts a filesystem path through IInitializeWithFile or IInitializeWithItem. It sniffs the file header through `formats::sniff_archive_ext` and lists the source in place. The current pane has no IInitializeWithStream interface or stream-to-temp copy. Stream initialization belongs to the separate thumbnail provider.

Explorer activates the stable staged executable with `--previews-pane`. The archive CLSID remains `{4FCA3A7C-329E-4B50-98D1-1B6DDFE36C59}`. The legacy `--preview-handler` flag still works until registration repair replaces it. These entry points return before normal Tauri startup.

Archive rendering does not initialize WebView2. The same pane process also serves the image class, whose browser requirements are documented separately.

## Current owners

| Concern | Owner and lookup |
| --- | --- |
| Early helper dispatch | [main.rs](../src-tauri/src/main.rs), `main` |
| Stable executable, sidecar, update rules | [previews/host.rs](../src-tauri/src/platform/previews/host.rs), `ensure_previews_host` |
| COM registration and ownership-aware cleanup | [previews/windows.rs](../src-tauri/src/platform/previews/windows.rs), `register_for_extension_with_host` and `unregister_for_extension` |
| COM interfaces, native tree, window lifecycle | [windows/com_server.rs](../src-tauri/src/platform/previews/windows/com_server.rs), `PreviewHandler` and `ArchivePreview` |
| Metadata-only archive listing | [archives/mod.rs](../src-tauri/src/archives/mod.rs), `list_archive_names` |
| Archive signature detection | [formats.rs](../src-tauri/src/formats.rs), `sniff_archive_ext` |
| Apply, repair, startup sync, diagnostics | [commands/registry.rs](../src-tauri/src/commands/registry.rs) |
| File Types repair error handling | [associationsUi.js](../src/js/options/associationsUi.js), `sync_preview_associations` call |

## COM and window lifecycle

COM calls can arrive on RPC threads while the native window pump runs elsewhere. SetWindow and SetRect record geometry. DoPreview resolves the source and posts creation work. Unload clears the source, cancels pending work, and posts teardown. Cross-process child creation, positioning, focus, and destruction run on the pump rather than synchronously inside Explorer's call.

Posted tasks own a reference to their state until dispatch. Epoch checks discard work superseded by a new selection. Archive listing runs on a named worker and places plain results in the window's job slot. The worker does not manipulate HWNDs. A completed job cannot paint into a recycled child.

A private message-only window receives lifecycle tasks and idle timers. This matters when the image renderer enters a nested WebView2 message loop in the same process. Both the outer and nested pumps dispatch window messages; thread-only messages could otherwise be consumed without executing the task.

The server remains warm while COM references or server locks exist. Once they are released, its 30-second idle window allows natural exit. Closing a visible pane alone does not prove Explorer has released every reference. Staging never terminates a helper to replace its executable.

## Failures and their resolutions

### Correct registration did not produce activation

Early direct activation on this test machine rejected the per-user class registration but accepted a machine-wide class. Registration therefore always writes HKCU and mirrors QuiviT's class entries to HKLM when already writable. It does not prompt standard users for elevation.

This was an observed result on the test machine, not a claim that Windows universally ignores per-user COM registration. Read-only diagnostics report both hives and the selected ProgID so activation failures can be distinguished from rendering failures.

### Low-integrity activation hid the cause of a blank pane

Early failures included writes to locations unavailable to the launched token. The retained `DisableLowILProcessIsolation=1` class value produced medium-integrity activation in an earlier direct check. Later real Explorer image activations still ran at low integrity.

The registration value is therefore not evidence of the actual launch token. The current archive path lists files in place. The image browser resolves Windows' LocalLow known folder for its writable profile. See the image spec for the repaired Explorer startup path.

### Moving a COM stream between threads failed

An earlier stream-based experiment failed when an apartment-bound stream proxy was read away from its calling thread. The current archive pane receives file or item paths and has no stream-copy path. The thumbnail server reads its IStream on the calling thread before decoding plain bytes.

This history explains the threading constraint without claiming the removed archive stream interface is still supported.

### Resize arrived before child creation

SetRect could record a real size while creation was still queued. The child then appeared at the old zero size.

`pump_create` now reconciles the latest geometry through `pump_position` after construction. Later resizes use the same path.

### The first paint stayed blank

Some runs created a child without delivering an initial WM_PAINT promptly. Archive creation and positioning paint synchronously through a device context, with WM_PAINT retained for normal repaint delivery.

Live pixel captures confirmed filenames in the expected header and row layout.

### Explorer waited on its own synchronous window work

Creating or repositioning a child synchronously during a host call caused a cross-process mutual wait. Deferring that work to the pump lets Explorer's COM call return before the window operations run.

Later mixed archive/image stress checks exercised the same shared lifecycle.

### Idle tasks disappeared inside a nested browser pump

An early null-window timer check compared the requested id with a different id returned by SetTimer. Recording the returned id fixed that case.

Image integration later exposed another failure: Wry's nested loop consumed thread messages without executing the outer loop's dispatch logic. Tasks and timers now target the private message-only window. A quit flag also lets the outer loop finish if a nested wait consumes WM_QUIT.

The corrected stress run exited naturally 30,108 ms after its references were released.

### Rebuilds targeted a running application executable

Registering a debug or portable application path let Explorer lock that file and left stale registrations when the application moved. Staging now isolates the shell server at the stable global path. A locked staged helper returns a retry message rather than triggering process termination.

### Repair disrupted File Types or repeated shell-wide notifications

File Types runs preview repair in its own try/catch, so a repair failure does not prevent association controls from initializing. Repair sends SHChangeNotify only when it changes registration. Apply stages the host once and performs blocking work off the UI thread.

## Verification record

The recorded checks include:

- Direct COM activation, archive initialization, metadata listing, painting, resizing, and unload.
- Pixel capture of live native children.
- Repeated activations sharing a warm process, followed by natural idle exit.
- Mixed archive/image rapid selections after the shared pump repair.
- The user's confirmation that archive previews work independently in multiple Explorer windows.
- The final implementation's `cargo check --tests`, all 108 Rust tests, and all 308 frontend tests. The broader image spec records the release build, portable-mode checks, and Defender results.

These are results from implementation verification, not new test runs performed for this documentation pass.

## Operational notes

Lifecycle logging remains in `%TEMP%\QuiviT-preview.log`. A helper's token can affect whether that location is writable, so an absent log does not establish that activation never occurred. Use the diagnostics command and actual process state as well.

Explorer's Internet-zone warning can block preview activation before QuiviT runs. It is Windows behavior and applies to archives as well as images. The image spec records the affected fixtures and the decision to preserve their trust marks.

There is no pending archive implementation work in this document. Performance redesigns, such as streaming an enormous listing or presenting only its first rows, require a measured need and a separate scope.
