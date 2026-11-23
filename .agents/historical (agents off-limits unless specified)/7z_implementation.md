# Replace 7Z Extraction with Native 7zr Sidecar

> [!NOTE]
> **Status: Shelved.** This plan was written to address UI blocking during heavy solid-archive extraction. However, the issue was successfully resolved by wrapping the existing pure-Rust `sevenz-rust2` extraction in a background thread and using Condvar notifications. Since the 10MB/s vs 50MB/s extraction speed difference for typical image archives does not manifest as a significant UX problem, this native-sidecar approach has been shelved to avoid LGPL binary deployment complexity. The plan is retained here for future reference if extraction speed ever becomes a hard bottleneck.

This plan details the process of migrating QuiviT's 7Z extraction from the pure Rust `sevenz-rust2` crate (which lacks SIMD/assembly optimizations) to the native 7-Zip engine (`7zr.exe`) bundled as a Tauri sidecar.

## Proposed Changes

We will bundle the lightweight, standalone 7z-only binary (`7zr.exe`) and use a background filesystem watcher to incrementally notify the frontend as files finish extracting, exactly matching our current seamless behavior but significantly faster.

### Tauri Configuration & Dependencies

#### [MODIFY] [Cargo.toml](file:///e:/Projects/QuiviT/src-tauri/Cargo.toml)
- Add `tauri-plugin-shell = "2"` to dependencies to safely resolve and launch sidecar binaries from the AppHandle context.

#### [MODIFY] [tauri.conf.json](file:///e:/Projects/QuiviT/src-tauri/tauri.conf.json)
- Add the `externalBin` array to the `bundle` configuration pointing to `"binaries/7zr"`.
- Add `shell:sidecar` permission to capabilities if necessary (in `capabilities/default.json`).

#### [NEW] `src-tauri/binaries/7zr-x86_64-pc-windows-msvc.exe`
- Download the official `7zr.exe` from `https://www.7-zip.org/a/7zr.exe`.
- Place it in the `binaries` directory with the Tauri target triple suffix so the bundler correctly detects and packages it as a sidecar.

### Backend Extraction Logic

#### [MODIFY] [src-tauri/src/lib.rs](file:///e:/Projects/QuiviT/src-tauri/src/lib.rs)
- Refactor `extract_7z_to_temp` to spawn the `7zr` sidecar instead of using `sevenz-rust2`.
- The command will be: `7zr.exe x <archive> -o<temp_dir> -y`.
- Because `7zr.exe` does not extract to `.tmp` files atomically like our previous implementation, we will use the `notify` crate (already in our dependencies) to watch the `temp_dir`.
- When the watcher receives a `Close(Write)` event (indicating `7zr` has completely finished writing a file and released the lock), we will extract the filename, add it to the `HashSet`, and trigger `Condvar::notify_all()`.
- Wait for the `7zr` subprocess to exit. Once it does, we terminate the watcher and ensure any remaining files are marked as extracted.

## User Review Required
> [!IMPORTANT]
> The sidecar binary is an official compiled executable from the 7-Zip author (Igor Pavlov). Because it is LGPL licensed, bundling it inside the application is fully permitted. It is a ~500kb standalone binary that does not require the user to have 7-Zip installed. Is this acceptable?

## Verification Plan

### Automated Tests
- Run `cargo check` to ensure the `tauri-plugin-shell` and `notify` modifications compile correctly.
- Run `cargo test --lib -- --nocapture` to verify that `protocol_serve_timing_simulation` still passes and that the 7z extraction test runs without timing out.

### Manual Verification
- Launch the application via `npm run tauri dev`.
- Load the large 7Z archive.
- Ensure the "Loading..." indicator appears, but wait time is vastly reduced compared to the pure Rust implementation, and that the image loads flawlessly without partial-read corruption.
