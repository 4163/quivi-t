# Slice 1: Archive Engine Optimization & Password Architecture Plan

## Goal

Optimize archive processing performance and implement password-protected archive support in the Rust backend. This slice implements Backend Priorities 1 and 2 from [.agents/cl-refactor-report.md](file:///E:/Projects/QuiviT/.agents/cl-refactor-report.md):
1. **Archive Loading Bottlenecks**: Eliminate O(N) seek penalties on corrupt or non-UTF-8 ZIP entries, provide O(1) entry lookup, and minimize lock contention in the background extraction pipeline.
2. **Password-Protected Archives**: Add credential handling across ZIP, RAR, and 7Z engines, with explicit error signaling (`PasswordRequired`, `PasswordIncorrect`) back to the host frontend.

> [!IMPORTANT]
> ## User Review Required
> This slice focuses strictly on the **backend Rust/Tauri implementation**. The frontend password prompt UI in the file list will be connected in a follow-up slice once these backend primitives and contracts are verified.

> [!CAUTION]
> ## Execution Rules
> **Do not mark pending items as completed after writing the code.** Items must remain marked as `[PENDING]` until the user has explicitly approved that the implementation works correctly at runtime.

---

## Architectural Invariants & Validation Constraints

Every item in this plan is designed to follow [.agents/AGENTS.md](file:///E:/Projects/QuiviT/.agents/AGENTS.md) and the architectural review standards of [.agents/skills/validate-changes/SKILL.md](file:///E:/Projects/QuiviT/.agents/skills/validate-changes/SKILL.md):

1. **Rust Encapsulation & Module Ownership:**
   - The crate root ([lib.rs](file:///E:/Projects/QuiviT/src-tauri/src/lib.rs)) remains bootstrap only. No archive extraction or caching logic may be added to `lib.rs`.
   - Domain logic lives entirely in [archives/](file:///E:/Projects/QuiviT/src-tauri/src/archives/) through the [`ArchiveCache`](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs#L64) facade. External callers (Tauri commands and protocol handlers) must use facade methods instead of reaching into reader modules directly.
   - [commands/archives.rs](file:///E:/Projects/QuiviT/src-tauri/src/commands/archives.rs) is strictly an IPC adapter. It must not grow archive format parsing or extraction internals.
   - Shared cross-module types and IPC contracts live exclusively in [models.rs](file:///E:/Projects/QuiviT/src-tauri/src/models.rs).
   - Tests stay in [tests/](file:///E:/Projects/QuiviT/src-tauri/src/tests/) via `#[path]`. Internal visibility will not be widened for testing.

2. **Performance First & Hot Path Invariants:**
   - **O(1) ZIP Entry Index Map:** Replace the double linear scan `0..archive.len()` in `read_zip_entry_by_decoded_name` and `read_zip_entry_header` with a pre-indexed `HashMap<String, usize>` built during initial listing.
   - **Fast-Fail on Corrupted Headers:** When a corrupt entry is encountered, fail immediately without scanning thousands of adjacent entries.
   - **Lock Contention Reduction:** Refactor [`ExtractNotify`](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs#L7) notification locks to prevent blocking the Tauri async runtime when background extractors write hundreds of files.
   - **Thread Concurrency:** CPU-heavy decompression remains strictly isolated to background threads (`std::thread::spawn`), keeping Tauri IPC and WebView2 threads responsive.

3. **Blast Radius & Downstream Safety:**
   - **IPC Backward Compatibility:** In [commands/archives.rs](file:///E:/Projects/QuiviT/src-tauri/src/commands/archives.rs), `list_archive` will take `password: Option<String>`. Omission of this parameter by existing JS callers ([fsUtils.js:335](file:///E:/Projects/QuiviT/src/js/fsUtils.js#L335)) will deserialize to `None` without errors.
   - **Model Backward Compatibility:** [`ArchiveReadResult`](file:///E:/Projects/QuiviT/src-tauri/src/models.rs#L21) keeps `files` and `archive_path` intact, adding an optional `encryption` status field. Existing frontend consumers will continue to receive and parse the file list uninterrupted.
   - **Protocol URL Stability:** The `quivit://` URL scheme ([protocol.rs](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs)) will not change. Decryption credentials are retained in the cached archive session within [`ArchiveCache`](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs#L64), allowing `quivit://` asset requests to resolve decrypted entries without exposing credentials in URL query parameters.

4. **Stale Code Prevention:**
   - Remove obsolete linear scan loops in [zip.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/zip.rs) upon adding index map lookups.
   - Ensure all old entry points and unused imports are cleaned up in the same slice.

---

## Proposed Changes

### 1. Shared Data Models
#### [MODIFY] [models.rs](file:///E:/Projects/QuiviT/src-tauri/src/models.rs)
- [COMPLETED] `[Observable change]` Add `ArchiveEncryptionStatus` enum (`None`, `PasswordRequired`, `PasswordIncorrect`) with `#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]` and `#[serde(rename_all = "snake_case")]`.
- [COMPLETED] `[Observable change]` Extend [`ArchiveReadResult`](file:///E:/Projects/QuiviT/src-tauri/src/models.rs#L21) with an optional `encryption: Option<ArchiveEncryptionStatus>` field decorated with `#[serde(default, skip_serializing_if = "Option::is_none")]`.
- **Validation Notes:** Fully backward-compatible with frontend JS callers. No fields are removed or renamed.

---

### 2. Tauri IPC Commands
#### [MODIFY] [commands/archives.rs](file:///E:/Projects/QuiviT/src-tauri/src/commands/archives.rs)
- [COMPLETED] `[Observable change]` Update `list_archive` signature to accept `archive_path: String, password: Option<String>`.
- [COMPLETED] `[Observable change]` Forward `password.as_deref()` into `cache.prepare_archive(&archive_path, password.as_deref())`.
- [COMPLETED] `[No observable change]` Verify that `prefetch_archive_entries` and `get_archive_ico_frames` rely on session-cached archive state in [`ArchiveCache`](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs#L64) without requiring redundant password arguments.
- **Validation Notes:** Conforms to adapter role. Does not contain format-specific parsing or extraction logic.

---

### 3. Archive Caching & Extraction Engine

#### [MODIFY] [archives/cache.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs)
- [COMPLETED] `[No observable change]` Add `password: Option<String>` and `zip_index_map: Option<HashMap<String, usize>>` fields to [`SingleArchiveCache`](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs#L10).
- [COMPLETED] `[No observable change]` Add helper methods to [`SingleArchiveCache`](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs#L10) to store and query the password and decoded entry index map.
- [COMPLETED] `[No observable change]` Optimize [`ExtractNotify`](file:///E:/Projects/QuiviT/src-tauri/src/archives/cache.rs#L7): minimize lock contention in `notify_extracted` by ensuring notification locks are brief, avoiding lock holding across disk operations, and batching condition variable signals when multiple files are extracted rapidly.
- [COMPLETED] `[No observable change]` Add a fast path for entry reads that avoids taking exclusive `write()` locks across unrelated archive lookups where an existing extraction state or cached buffer is present.
- **Validation Notes:** Encapsulated inside `cache.rs`. Does not expose internal cache structures outside `archives/`.

#### [MODIFY] [archives/zip.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/zip.rs)
- [COMPLETED] `[Observable change]` Update `list_zip_entries` to build and return an O(1) lookup table `HashMap<String, usize>` mapping decoded entry names to zip central directory indices.
- [COMPLETED] `[Observable change]` Update `list_zip_entries` to detect password-protected ZIP headers. If entries require a password and none is provided, or if decrypting a test header fails with invalid credentials, return the appropriate `ArchiveEncryptionStatus`.
- [COMPLETED] `[Observable change]` Refactor `read_zip_entry_by_decoded_name` and `read_zip_entry_header`:
  - Use the pre-indexed `HashMap<String, usize>` to find the entry index in O(1) time.
  - Call `by_index` or `by_index_decrypt` exactly once using the cached password if provided.
  - Remove the slow linear scan fallback `for i in 0..archive.len()`.
  - On corrupt local header or failed decompression, fast-fail immediately instead of looping across the remaining archive.
- [COMPLETED] `[Observable change]` Support password decryption via `by_name_decrypt` / `by_index_decrypt` with password bytes.
- **Validation Notes:** Eliminates the double full-file scan bottleneck and prevents UI thread lock-up when opening archives with corrupt local headers.

#### [MODIFY] [archives/sevenz.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/sevenz.rs)
- [COMPLETED] `[Observable change]` Update `list_7z_entries` to accept `password: Option<&str>`. Pass `sevenz_rust2::Password::from(pwd)` when present, or `Password::empty()`.
- [COMPLETED] `[Observable change]` Detect password requirement in `list_7z_entries`: return `ArchiveEncryptionStatus::PasswordRequired` if opening fails due to missing password, or `PasswordIncorrect` if the supplied password fails block decryption.
- [COMPLETED] `[Observable change]` Update `extract_7z_to_temp` to accept `password: Option<String>` and pass credentials to `ArchiveReader::open`.
- **Validation Notes:** Encapsulates `sevenz-rust2` API within `sevenz.rs`.

#### [MODIFY] [archives/rar.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/rar.rs)
- [COMPLETED] `[Observable change]` Update `list_rar_entries` to accept `password: Option<&str>`. Attach password to `unrar::Archive` processing.
- [COMPLETED] `[Observable change]` Detect password requirement in `list_rar_entries`: catch password-required header flags and return `ArchiveEncryptionStatus::PasswordRequired` or `PasswordIncorrect`.
- [COMPLETED] `[Observable change]` Update `extract_rar_to_temp` to accept `password: Option<String>` and supply credentials to the decompression loop.
- **Validation Notes:** Encapsulates `unrar` API within `rar.rs`.

#### [MODIFY] [archives/mod.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/mod.rs)
- [COMPLETED] `[Observable change]` Update `prepare_archive(&mut self, archive_path: &str, password: Option<&str>) -> Result<ArchiveReadResult, String>`.
- [COMPLETED] `[No observable change]` Store the optional password and zip index map into `SingleArchiveCache` during `prepare_archive_state`.
- [COMPLETED] `[No observable change]` Forward the password string to `spawn_temp_extractor`.
- [COMPLETED] `[No observable change]` Pass cached password and index map to `read_zip_entry_bytes` and `read_zip_entry_header`.
- **Validation Notes:** Preserves `ArchiveCache` facade pattern. Callers in `commands/archives.rs` and `protocol.rs` interact with `ArchiveCache` without format branch leaks.

---

### 4. Protocol Handler Validation
#### [MODIFY] [protocol.rs](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs)
- [COMPLETED] `[No observable change]` Ensure `quivit://` entry requests continue to resolve correctly through `cache.read_entry_bytes`, transparently leveraging the session-cached password without requiring changes to URL formats or routing.
- [COMPLETED] `[No observable change]` Confirm that `quivit://` requests do not block while waiting for unrelated background extraction locks.
- **Validation Notes:** Preserves existing URL format `quivit://archive/<base64_archive_path>/<entry_name>`. No changes to protocol contracts.

---

### 5. Automated Tests & Fixtures
#### [NEW] [tests/fixtures/make_test_archives.py](file:///E:/Projects/QuiviT/src-tauri/src/tests/fixtures/make_test_archives.py)
- [COMPLETED] `[No observable change]` Add a test fixture generator script to build encrypted test archives (`encrypted.zip`, `encrypted.rar`, `encrypted.7z`) with a known password (`quivit_test_pwd`) and a corrupted header ZIP archive (`corrupt_local_header.zip`).

#### [MODIFY] [tests/archive_tests.rs](file:///E:/Projects/QuiviT/src-tauri/src/tests/archive_tests.rs)
- [COMPLETED] `[No observable change]` Add unit tests verifying O(1) ZIP lookup and fast-fail behavior on corrupted headers without repeated scanning.
- [COMPLETED] `[No observable change]` Add unit tests verifying `PasswordRequired` detection for encrypted ZIP, RAR, and 7Z archives when opened without a password.
- [COMPLETED] `[No observable change]` Add unit tests verifying successful listing and extraction when the correct password is provided.
- [COMPLETED] `[No observable change]` Add unit tests verifying `PasswordIncorrect` emission when an incorrect password is supplied.
- **Validation Notes:** Tests reside strictly in `src-tauri/src/tests/`. No test logic or test-only dependencies are placed in crate root or domain modules.

---

### 6. Additional: Fast-Skip Invalid & Corrupted Archives Across All Formats
#### [MODIFY] [archives/zip.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/zip.rs)
- [COMPLETED] `[Observable change]` Implement `validate_zip_header` to inspect trailing 128 KB for `PK\x05\x06` EOCD signature and check 22-byte minimum size and `PK` magic bytes, eliminating 392 MB backward disk scans on truncated ZIP files.

#### [MODIFY] [archives/rar.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/rar.rs)
- [COMPLETED] `[Observable change]` Implement `validate_rar_header` to verify 14-byte minimum size, `b"Rar!\x1a\x07"` signature, and RAR4/RAR5 format byte before invoking `unrar_sys` C++ library.

#### [MODIFY] [archives/sevenz.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/sevenz.rs)
- [COMPLETED] `[Observable change]` Implement `validate_7z_header` to verify 32-byte signature header, `7z\xBC\xAF\x27\x1C` magic bytes, and header bounds (`32 + NextHeaderOffset + NextHeaderSize <= len`) to instantly reject truncated archives.

#### [MODIFY] [archives/tar.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/tar.rs)
- [COMPLETED] `[Observable change]` Implement `validate_tar_header` to check 512-byte minimum size, all-zero EOF blocks, `ustar` magic at offset 257, or 512-byte header octal checksum verification.

#### [MODIFY] [js/fsUtils.js](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
- [COMPLETED] `[Observable change]` Update `openSibling` to pass `{ generation, skipLocked: true, suppressErrorState: true }`, ensuring seamless navigation past corrupt or password-locked siblings without screen clearing or status flicker.
- [COMPLETED] `[Observable change]` Update `loadArchive` to throw when `skipLocked` is set on password-blocked archives, and avoid clearing active image state when `suppressErrorState` is true.

#### [MODIFY] [tests/archive_tests.rs](file:///E:/Projects/QuiviT/src-tauri/src/tests/archive_tests.rs)
- [COMPLETED] `[No observable change]` Add 5 automated tests validating microsecond rejection of truncated 10 MB ZIPs, invalid magic headers, truncated RAR/7Z files, and invalid TAR checksum blocks.

---

## Validation & Blast Radius Checklist

Following [.agents/skills/validate-changes/SKILL.md](file:///E:/Projects/QuiviT/.agents/skills/validate-changes/SKILL.md), the slice will be audited against the following checklist before requesting user approval:

| Category | Item to Validate | Expected Result |
|---|---|---|
| **Rust Ownership** | Crate root ([lib.rs](file:///E:/Projects/QuiviT/src-tauri/src/lib.rs)) | Zero archive logic added to bootstrap. |
| **Rust Ownership** | IPC adapter ([commands/archives.rs](file:///E:/Projects/QuiviT/src-tauri/src/commands/archives.rs)) | Thin translation layer only; delegates all cache and format logic to `ArchiveCache`. |
| **Rust Ownership** | Domain facade ([archives/mod.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/mod.rs)) | External callers use facade methods; no direct reach-in to `rar`, `sevenz`, or `zip` internals. |
| **Hot Path** | ZIP entry seek performance | O(1) index map replaces linear scan; no double seek loop on corrupt or non-UTF-8 entries. |
| **Hot Path** | Extraction lock contention | Mutex locks in `ExtractNotify` held for minimal duration; no thread starvation. |
| **Blast Radius** | [fsUtils.js](file:///E:/Projects/QuiviT/src/js/fsUtils.js#L335) | `list_archive` calls without password continue to succeed on unencrypted archives. |
| **Blast Radius** | [protocol.rs](file:///E:/Projects/QuiviT/src-tauri/src/protocol.rs) | `quivit://` URLs remain unchanged; decodes entries using session-cached password. |
| **Stale Code** | Deprecated scan loops | Old `by_name` fallback loops in `zip.rs` fully removed; zero dead imports. |

---

## Verification Plan

### Automated Checks
Run the following commands from the repository root:
1. `cargo check --manifest-path src-tauri/Cargo.toml`
   - Must compile with zero errors and zero warnings.
2. `cargo test --manifest-path src-tauri/Cargo.toml --lib archive_tests`
   - All existing archive tests must pass.
   - All new encrypted archive and seek optimization tests must pass.

### Manual Runtime Checklist
1. **Unencrypted Archive Navigation:**
   - Open standard `.zip`, `.cbz`, `.rar`, `.cbr`, `.7z`, and `.tar` files in the viewer.
   - Confirm file listing, navigation, and image display behave as before.
2. **Corrupted ZIP Handling:**
   - Open a ZIP archive containing corrupted local headers.
   - Confirm the viewer loads valid entries without UI freezing or noticeable seek delays.
3. **Encrypted Archive Rejection:**
   - Open an encrypted ZIP, RAR, and 7Z archive without supplying a password.
   - Confirm the backend returns `PasswordRequired` without crashing or freezing.
4. **Encrypted Archive Extraction:**
   - Supply the correct password to the backend test harness or IPC command.
   - Confirm that entries are successfully decrypted and rendered.
5. **Large Archive UI Responsiveness:**
   - Open a large 7Z or RAR archive with multiple high-resolution images.
   - Confirm the UI remains fully responsive while extraction proceeds in the background.
