# Rust Backend Decoupling: Slice 4 Complete

Slice 4 of the Rust backend decoupling plan is implemented in the working tree (not yet committed). The archive subsystem is encapsulated behind `ArchiveCache` facade methods; the old flat `archives.rs` is gone.

## Changes Made

- **Split `archives.rs` into `archives/`:**
  - [`mod.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/mod.rs): `ArchiveKind`, `prepare_archive`, `read_entry_bytes`, background extractor spawn
  - [`cache.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs): `ArchiveCache` / `SingleArchiveCache`, LRU byte-budget, temp-path safety, test inspectors
  - [`zip.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/zip.rs): ZIP / CBZ listing, CJK name decode, on-demand extract
  - [`rar.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/rar.rs): RAR / CBR listing + temp extraction
  - [`sevenz.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/sevenz.rs): 7Z / CB7 listing + temp extraction
  - [`tar.rs`](file:///E:/Projects/QuiviT/src-tauri/src/archives/tar.rs): TAR / CBT listing + temp extraction
- **Encapsulated cache internals:** `SingleArchiveCache` fields are private. Callers no longer reach into `extract_temp_dir`, `extract_notify`, or ZIP handles.
- **Unified extraction:** [`commands.rs`](file:///E:/Projects/QuiviT/src-tauri/src/commands.rs) (`list_archive`, `prefetch_archive_entries`, `get_archive_ico_frames`) and the inline `quivit://` handler in [`lib.rs`](file:///E:/Projects/QuiviT/src-tauri/src/lib.rs) all go through `prepare_archive` / `read_entry_bytes`.
- **Tests:** [`archive_tests.rs`](file:///E:/Projects/QuiviT/src-tauri/src/tests/archive_tests.rs) uses test-only inspectors instead of constructing `SingleArchiveCache`. Added path-escape coverage for `archive_entry_temp_path`.

`get_temp_extraction_dir` from the plan was not added as a public API. Callers no longer need the temp dir; `temp_extraction_state` stays crate-private inside `read_entry_bytes`.

## Validation Results

- `cargo check`: passed
- `cargo test`: 21 passed, 0 failed
- `git diff --check`: clean
- No commit made

## Out of scope in this working tree

[`src/js/shortcuts.js`](file:///E:/Projects/QuiviT/src/js/shortcuts.js) has an unrelated side-button press-vs-release change. Do not include it in the Slice 4 commit.

## Next Steps

Manually smoke ZIP/CBZ, RAR/CBR, 7Z/CB7, and TAR/CBT open + first-image serve. Then commit Slice 4 on `refactor/decoupling` and start a new session for Slice 5 (`protocol.rs` extraction: now a thin wrapper over `read_entry_bytes`).
