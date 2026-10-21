# Shared previews host specification

Validation comparison performed against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md` before finalizing this document.

Status: finalized on 2026-10-22 at the user's request. This is the shared hosting contract for the accepted archive and image preview implementation. Host staging, Apply performance, and the final File Types error-message follow-up have user runtime signoff. No acceptance checks remain open.

[preview-handler.md](preview-handler.md) records the native archive pane and its troubleshooting history. [image-previews-spec.md](image-previews-spec.md) defines image behavior, thumbnail decoding, verification evidence, and the tested release artifact.

## Release packaging and runtime files

QuiviT remains one downloadable EXE. Its bytes are copied to the stable preview host path when staging is required. The application also embeds the thumbnail proxy DLL and writes it beside that host. The user approved the embedded, staged DLL on 2026-10-21 after Windows rejected EXE-only thumbnail-cache activation.

| File | Purpose |
| --- | --- |
| `%LOCALAPPDATA%\QuiviT\bin\quivit-previews.exe` | Shared executable for pane and thumbnail COM servers |
| `%LOCALAPPDATA%\QuiviT\bin\quivit-previews.version` | JSON staging metadata |
| `%LOCALAPPDATA%\QuiviT\bin\quivit-thumbnail-proxy.dll` | Standard in-process thumbnail proxy forwarding to the EXE |

Portable mode and config overrides do not move these files. Each application's config retains its existing portable or split layout. Removing a portable application folder does not unregister shell integration.

There is no second download, optional AVIF codec installation, background service, scheduled task, custom packer, or injected loader. `build.rs` compiles the proxy as a small Rust cdylib with a static CRT and embeds its bytes through the host module. A separate lean executable remains outside this scope.

The helper entry points return before Tauri startup, config initialization, and ordinary file-open forwarding:

| Argument | Runtime |
| --- | --- |
| `--previews-pane` | Archive and image preview class factories on the shared pane pump |
| `--previews-thumb` | Native thumbnail COM worker |
| `--preview-handler` | Legacy pane alias retained until registration repair |

The helper reads preview inputs and draws results. Registration belongs to the main app, not to an activated helper. Archive and thumbnail requests do not initialize WebView2. Image panes lazily create WebView2 controllers and its normal runtime child processes. The browser profile uses Windows' LocalLow known folder under `QuiviT\preview-webview`.

## Version and sidecar contract

`PREVIEW_HOST_VERSION: u32` lives in [previews/host.rs](../src-tauri/src/platform/previews/host.rs). Its current value is **5**. It changes for preview capability or contract updates, independently of the app version.

The JSON sidecar contains:

| Field | Meaning |
| --- | --- |
| `preview_version` | Staged preview capability version |
| `profile` | `debug` or `release` |
| `sha256` | SHA-256 of the staged executable |
| `app_path` | Optional source application path, refreshed on a keep decision when possible |
| `proxy_sha256` | Optional proxy hash in the schema, required for healthy current Windows staging |

Optional fields deserialize with defaults for older sidecars. A current Windows host is healthy only when both executable and proxy bytes match their recorded hashes. The host and proxy are staged before publishing the updated sidecar.

Staging writes sibling `.tmp` files and renames them into place. The executable, proxy, and sidecar are separate file operations, not one filesystem transaction. An interrupted or locked update can leave a mismatch, which subsequent health checks detect. A proxy whose bytes already match the embedded DLL is left untouched, including when Windows has it loaded.

### Update decisions

The following rules apply in order:

| Condition | Action |
| --- | --- |
| E2E suite | Stage and register nothing |
| Running executable is already the resolved host | Return the host path without copying itself |
| Debug application outside E2E | Stage the running EXE and embedded proxy regardless of version |
| Release with missing or unreadable sidecar, missing files, or failed hash checks | Repair from the running EXE and embedded proxy |
| Release with staged debug profile | Replace with the release implementation |
| Release with a lower staged preview version | Stage the newer capability |
| Release with an equal or greater healthy release version | Keep staged bytes and synchronize eligible registrations |

Thus an older release preserves a newer healthy host. Corruption is repaired from the application performing the repair rather than trusted solely because the sidecar advertises a greater version. A healthy equal-version host is kept even when the running application EXE has a different hash.

On a keep decision, `app_path` can change without replacing the executable or proxy. That sidecar-only refresh is best effort.

Windows refuses to replace a running EXE or loaded DLL. Apply returns a retry error asking the user to close the preview pane and Explorer windows. File Types shows concise recovery guidance for known preview-lock errors and retains other specific failure reasons; the status wraps so the instructions remain visible. Startup logs a staging notice and can synchronize against an existing host, subject to capability checks. Product staging never terminates a server process.

## Registration identity

The archive identity is unchanged. Image pane and thumbnail identities are separate:

| Class | CLSID | Activation |
| --- | --- | --- |
| Archive preview | `{4FCA3A7C-329E-4B50-98D1-1B6DDFE36C59}` | Host with `--previews-pane` |
| Image preview | `{B75A51FA-2D58-45F2-9214-E48BD1A14282}` | Host with `--previews-pane` |
| Image thumbnail | `{A6F7C8D1-4E2B-4A1C-8D93-7F6E5B4A3C21}` | Proxy InprocServer32 and host LocalServer32 with `--previews-thumb` |

The preview shell category is `{8895b1c6-b41f-4c1c-a562-0d564250836f}`. The thumbnail category is `{e357fccd-a995-4576-b01f-234630154e96}`.

The archive constants and registration logic live in [previews/windows.rs](../src-tauri/src/platform/previews/windows.rs). Shared image GUIDs, the thumbnail category, and the DLL name live in [previews/contract.rs](../src-tauri/src/platform/previews/contract.rs), which is also used by the standalone proxy build.

Class entries are written under HKCU. When the current process can already write HKLM, QuiviT mirrors its class entries there without requesting elevation. Preview classes retain `DisableLowILProcessIsolation=1` and a PreviewHandlers entry. This value does not guarantee medium-integrity activation; real Explorer image previews were observed at low integrity.

Per-extension shell links live under QuiviT-owned ProgIDs. Eligible formats are archives plus WebP, APNG, AVIF, GIF, SVG, and ICO. GIF and ICO receive pane links only. Thumbnail links cover WebP, APNG, AVIF, and SVG when external SVG handlers do not take precedence.

Image registration checks the staged capability and proxy health. GIF requires version 5; the other image formats require at least version 3. A locked older host must not acquire a GIF registration it cannot serve. SVG external-handler preservation runs before this image capability check.

## Apply, launch, repair, and removal

[commands/registry.rs](../src-tauri/src/commands/registry.rs) owns these operations:

1. Apply stages once when the selection includes an eligible preview format, then passes the ensured path to `register_for_extension_with_host` for each extension. Blocking work runs through `spawn_blocking`.
2. Ordinary startup runs `spawn_launch_previews_sync` on a background thread. Launches without a file-open argument perform normal staging checks. File-open launches reuse an existing host and stage only if it is missing.
3. Opening File Types calls `sync_preview_associations`. It synchronizes existing registrations and stages only if the host is absent. Apply or ordinary startup performs replacement and hash-based staging repair.
4. Startup and File Types repair operate only on formats already registered to QuiviT. They do not enable a new association as a side effect of opening the page.
5. Repair also applies an empty `TypeOverlay` value to active QuiviT image ProgIDs, consistently suppressing Explorer's application badge.
6. SVG detection captures external preview and thumbnail references before changing the open ProgID. Either external slot causes both QuiviT SVG implementations to be skipped. Any relay is written only under QuiviT.svg; third-party source registrations and class servers stay intact.
7. Removal deletes a shell link only when it still names the expected QuiviT class. Shared activation entries survive while a supported extension still links that class. External SVG references under QuiviT.svg are preserved when needed. Helper files remain on disk.
8. Registration synchronization sends SHChangeNotify only when it reports actual changes. The File Types UI catches a sync failure separately from checkbox setup.

E2E guards run before staging or registry mutation. Development and test override folders hold config, not another shell host. The explicit early helper CLI entry points are separate from normal app startup.

## Diagnostics

`get_preview_diagnostics` returns read-only rows for supported preview extensions. The `PreviewDiagnostic` model in [models.rs](../src-tauri/src/models.rs) retains the existing fields and adds defaulted image and thumbnail fields.

Rows report association state, UserChoice, preview CLSID and servers in both hives, PreviewHandlers membership, host existence, staged and embedded capability versions, thumbnail servers and proxy health, external SVG handlers, and SVG skip status.

The stale flag identifies a noncanonical pane server command or an owned thumbnail registration with a wrong worker command, wrong proxy path, or unhealthy proxy. A missing pane registration is unregistered rather than stale. An old `--preview-handler` command is stale for repair purposes even though the alias remains executable.

Diagnostics do not stage files or modify registration.

## Antivirus and trust boundaries

Staging uses ordinary file I/O and standard COM registration/loading. No executable compression, obfuscation, process injection, or background persistence mechanism is added. Version and hash decisions avoid unnecessary rewrites of a healthy release host.

The executable copy preserves the source EXE's bytes, including any future Authenticode signature. The DLL is a separate artifact; signing the main EXE would not sign it. A future signing workflow must sign and verify the proxy before embedding it as well.

Recorded Defender custom scans of the release EXE and staged bin folder completed without new detections. This is evidence for the tested files and local signatures, not a promise about SmartScreen reputation or future antivirus verdicts. The image spec records the exact tested hashes.

Preview input trust is separate from executable staging. QuiviT does not strip Zone.Identifier from images or archives or change Windows policies to bypass Explorer's Internet-zone preview block.

## Verification and closure

The recorded host checks cover all 12 existing staging tests, including version decisions, missing sidecars, corrupt bytes, equal and greater healthy release preservation, debug replacement, global path resolution, and locked-file errors.

Normal split-config and real portable release launches used the same global host and proxy. The original release `app_path` was restored after the portable check. Existing configuration E2E cases passed in split and portable modes without changing the real helper/proxy hashes.

Apply performance and the original host slices have user runtime signoff. The final image follow-up also passed its user runtime checks. The final source passed `cargo check --tests`, all 108 Rust tests, all 308 frontend tests, and debug/release builds. Those results were recorded before this docs-only pass.

The host specification has no open product or packaging decisions. The image spec records the remaining preview checks, single-slot SVG code verification, and the association error-message fix. The user confirmed that fix at runtime on 2026-10-22, closing the final follow-up. This documentation pass changed no runtime code, registration, config, or installed helper.
