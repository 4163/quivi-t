# Rust Backend Decoupling: Slice 5 Complete

Slice 5 of the Rust backend decoupling plan is implemented in the working tree (not yet committed). The `quivit://` custom URI scheme protocol handler has been completely extracted out of `lib.rs` into a dedicated `protocol.rs` module.

## Changes Made

- **Extracted `protocol.rs`:**
  - [`protocol.rs`](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs): `register_quivit_protocol` and `guess_mime`. Handles URI path parsing, Base64 decoding of archive paths, URL-decoding of entry names, MIME type guessing, and async background thread dispatch for HTTP response creation.
- **Slimmed `lib.rs`:**
  - [`lib.rs`](file:///E:/Projects/QuiviT/src-tauri/src/lib.rs): Dropped from 292 lines to 206 lines (-86 lines). Removed inline protocol scheme handler block, unused `tauri::http::Response` import, and `guess_mime`. Replaced with a single builder chaining call `crate::protocol::register_quivit_protocol(builder)`.
- **Encapsulated Cache Delegation:**
  - `protocol.rs` cleanly interacts with `ArchiveCache` via the facade method `read_entry_bytes(&archive_path, &entry_name)` without inspecting or reaching into inner cache fields.

## Validation Results

- `cargo check`: clean (0 errors, 0 warnings)
- `cargo test`: 23 passed, 0 failed
- Runtime verification: User confirmed working across ZIP/CBZ, RAR/CBR, 7Z/CB7, TAR/CBT, Shift-JIS ZIP, rapid navigation scrubbing, and archive-to-folder transitions.
- No commit made (per AGENTS.md policy).

## Next Steps

Commit Slice 5 on `refactor/decoupling` with:
```
slice5: Custom URI scheme protocol handler extraction
```
Then rollover to a fresh session for Slice 6 (`commands/` monolith dissolution).
