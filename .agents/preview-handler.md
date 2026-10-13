# Explorer archive preview: issues hit and what fixed them

This validation comparison was performed against `.agents/skills/validate-changes/SKILL.md` before presenting. The report covers the working tree only. It adds no code and changes no behavior.

Goal: archives associated with QuiviT show a file list tree in the Windows preview pane, in a style matching the app, from the single QuiviT executable. The user confirmed the pane renders and signed off, then asked for this writeup.

## 1. Diff view showed phantom changes

`git status` listed 19 modified files while `git diff` showed real changes in 8. The extra 11 had hashes identical to HEAD. Stale stat info, nothing more. Checking out those 11 paths cleared the noise without losing work. The real diff is 11 tracked files plus the new `src-tauri/src/platform/preview_handler.rs` module from `src-tauri/src/platform/mod.rs:4`.

## 2. First review findings, all fixed

The opening validation pass flagged one blocking item and several warnings. Each got a fix in the tree.

- `src/js/options/associationsUi.js:62` ran preview migration inside the same try block as checkbox setup, so a sync failure left File Types unusable. The sync call now lives in its own try/catch and only logs a warning.
- `src-tauri/src/commands/registry.rs:162` sent a shell-wide associate-changed notice on every Options open. It notifies only when registration actually wrote something.
- Unregister ran preview cleanup for image types that never register previews. It now guards on archive types, matching register.
- The 64 MB preview cache was a bare number. The cache is gone entirely now. Preview listing never opens a cache entry, so there is nothing to budget.
- Magic-byte sniffing lived only in the preview module. It moved to `src-tauri/src/formats.rs:171` as `sniff_archive_ext`, and the preview module calls it.
- A whitespace-only reformat in `src-tauri/src/lib.rs` got reverted.

## 3. The activator ignored per-user registration on this machine

Symptom: correct keys under `HKCU\Software\Classes`, yet Explorer never launched the server and no log appeared.

A throwaway harness outside the repo called `CoCreateInstance` directly. `HKCU` plus local server failed with class-not-registered, elevated and filtered alike. `HKCU` plus in-proc DLL failed the same way. `HKLM` plus local server launched. So this box resolves machine-wide classes and skips per-user ones.

Fix: `src-tauri/src/platform/preview_handler/windows.rs:59` writes the CLSID local-server subtree to `HKCU` always and mirrors it to `HKLM` when the process can write there. Association keys stay per-user. Standard users see no prompt and no change. `src-tauri/src/commands/registry.rs:86` adds a read-only diagnostics command reporting both hives per archive type, backed by `src-tauri/src/models.rs:112`.

## 4. The host launches preview servers at low integrity

I checked the launched server token directly. It ran at low integrity. A low process cannot write `%TEMP%`, which killed both the log and the temp archive copy, and it cannot parent a window to Explorer's medium pane, which fails the child creation. Black pane, no trace.

Fix: `src-tauri/src/platform/preview_handler/windows.rs:94` sets the documented low-IL opt-out DWORD on the CLSID in both hives. I confirmed medium integrity afterwards. The server is read-only. It lists names and draws text, nothing more.

## 5. COM calls run on RPC threads, not the pump thread

Per-call thread ids in the log settled this. Pump work logs one thread. `Initialize`, `SetWindow`, `DoPreview`, and `Unload` log other threads. The shell stream proxy only works on the calling thread. Reads moved anywhere else fail.

Fix: `DoPreview` copies the stream to temp on the calling thread, in 64 KiB chunks with a 512 MB cap, and file paths list in place with no copy at all. The pump task and the listing worker only ever touch plain paths. `src-tauri/src/platform/preview_handler/windows/com_server.rs:588` holds the chunked copy, `src-tauri/src/platform/preview_handler/windows/com_server.rs:787` sniffs file heads.

## 6. Thread timers ignore the requested id

The idle shutdown never fired during testing. `SetTimer` with a null window returns a system-generated id, not the id passed in. The code compared the `WM_TIMER` parameter against the requested id, so it never matched.

Fix: `src-tauri/src/platform/preview_handler/windows/com_server.rs:68` keeps a 30 second budget, and the pump stores the actual returned id and matches against that. I watched one process serve two activations 10 seconds apart with zero startup on the second, then exit by itself after the timeout.

## 7. A resize landing mid-build stuck the child at zero size

`SetRect` with the real size arrived after `DoPreview` posted but before the pump built the child. With no pane yet, `SetRect` recorded and skipped. The child was born at zero size and nothing repositioned it.

Fix: `src-tauri/src/platform/preview_handler/windows/com_server.rs:626` reconciles position at the end of every build through the same `pump_position` path the resize calls use.

## 8. The first paint never arrived on its own

Across many runs the child existed and stayed blank with no `WM_PAINT` dispatched to it. Rather than fight the delivery, the server paints synchronously with `GetDC` right after creation and after every resize. `WM_PAINT` handling stays as the backup path. Pixel capture of the live pane showed dark filenames clustered at the top, matching the header plus rows layout.

## 9. Explorer froze while the pane worked

Once rendering worked, Explorer locked up on selection. Every host call did cross-process window work synchronously while Explorer waited on it. That is the classic mutual wait.

Fix: host entry points in `src-tauri/src/platform/preview_handler/windows/com_server.rs:443` only record and return. `SetWindow` and `SetRect` store geometry. `DoPreview` stores params. `Unload` clears. Each posts one of `TASK_CREATE`, `TASK_POSITION`, or `TASK_TEARDOWN` from `src-tauri/src/platform/preview_handler/windows/com_server.rs:76`, and the pump performs the window work serially when no host call is in flight. The state handle crosses through the message itself with strict single-owner discipline, so no shared registry was needed. Listing runs on a named worker thread per `src-tauri/src/platform/preview_handler/windows/com_server.rs:1024`, and results land in a per-window job slot keyed by child handle, so a superseded listing can never paint into a recycled window. `src-tauri/src/archives/mod.rs:66` exposes the name-only listing the worker uses, with no cache entry and no background extraction.

## 10. Dead servers locked the binary

The first lifetime design quit on last release, but crashed or killed servers lingered and held `target/debug/tauri-app.exe` open, which broke rebuilds with access denied. The idle timer design keeps one warm server for browsing and still exits by itself. Kill-before-build is no longer part of the loop.

## 11. My own test artifacts, kept out of the tree

Several dead ends came from the test setup, not the product. Wrong interface ids in my probe script, since corrected against the windows crate metadata and `HKCR\Interface`. A stream the script let the garbage collector drop mid-run. Multi-select accumulation hiding selection changes. A background window that never drives the visible pane. Stale binaries and consoles killed by hand. Explorer caching handler state per session, cleared with a restart. All harness files lived under `%TEMP%\quivit-ph-test` and are deleted, along with the dummy registry keys from activation tests.

## Verification on record

- `cargo check --tests`, `cargo build`, 35 archive tests, 13 format tests, 308 mocha, `node --check` on the touched frontend file. All green.
- Direct COM activation with class-not-registered for `HKCU` and success for `HKLM`.
- Full Explorer runs in the log: activate, stream init, list of 3 entries, swap, paint at full pane size.
- Pixel capture of live preview children showing rendered rows.
- One process serving two activations, then exiting alone after the idle window.

## Open notes

Debug builds pay Defender scans and unoptimized code on every cold start, so release numbers will read better. If huge archives still feel heavy, the honest next step is streaming the listing itself instead of the temp copy, or a first-rows-fast mode. The preview log at `%TEMP%\QuiviT-preview.log` stays in the code, capped to lifecycle lines, for the next round of questions.
