# Goal

Address the core backend capabilities and performance limits for archive processing, tackling specific priorities from the Component Library Refactor Report:
1. **Archive Loading Bottlenecks**: Optimizing the mutex locking and extraction pipeline.
2. **Password-Protected Archives**: Allowing the frontend to supply credentials for encrypted `zip`, `rar`, and `7z` files.

> [!IMPORTANT]
> ## User Review Required
> This slice focuses purely on the **backend Rust/Tauri implementation**. The frontend UI to actually prompt the user for a password will need to be wired up after these backend primitives are in place.

> [!NOTE]
> ## Open Questions
> 1. **Corrupted Archive Seek Cost**: The current seek bottleneck stems from corrupted `.zip` files forcing double full-file scans when `by_name` misses and `by_index` is invoked across thousands of corrupt local headers. We will profile and implement a fast-fail or single-pass detection to avoid blocking the `Mutex`.

> [!CAUTION]
> ## Execution Rules
> **Do not mark pending items as completed after writing the code.** Items must remain marked as `[PENDING]` until the user has explicitly approved that the implementation works correctly at runtime. Never jump the gun.

## Proposed Changes

---

### Shared Data Models
#### [MODIFY] [models.rs](file:///e:/Projects/QuiviT/src-tauri/src/models.rs)
- [ ] Update `ArchiveReadResult` (or how we return from Tauri commands) to explicitly signal `PasswordRequired` or `PasswordIncorrect` back to the frontend.

---

### Tauri IPC Commands
#### [MODIFY] [archives.rs](file:///e:/Projects/QuiviT/src-tauri/src/commands/archives.rs)
- [PENDING] Update command signatures (`list_archive`, `prefetch_archive_entries`, `get_archive_ico_frames`) to accept an optional `password: Option<String>` argument.
- [PENDING] Route the password into the `ArchiveCache` method calls.

---

### Archive Caching & Extraction Engine
#### [MODIFY] [cache.rs](file:///e:/Projects/QuiviT/src-tauri/src/archives/cache.rs)
- [PENDING] Update `prepare_archive` and internal extraction thread spawns to accept and forward the password string.
- [PENDING] **Mutex Optimization**: Refactor `ExtractNotify` which currently uses an `Arc<(Mutex<HashSet<String>>, Condvar)>`. The extraction loop locks this Mutex repeatedly to insert extracted filenames, stalling UI threads trying to check if a specific entry is ready. Optimize this by minimizing lock contention (e.g., buffering extracted names and committing them in batches, or unlocking early).

#### [MODIFY] [sevenz.rs](file:///e:/Projects/QuiviT/src-tauri/src/archives/sevenz.rs)
- [PENDING] Add password support: Replace `sevenz_rust2::Password::empty()` with the provided password.

#### [MODIFY] [rar.rs](file:///e:/Projects/QuiviT/src-tauri/src/archives/rar.rs)
- [PENDING] Add password support to the `unrar` extraction logic using the provided credentials.

#### [MODIFY] [zip.rs](file:///e:/Projects/QuiviT/src-tauri/src/archives/zip.rs)
- [PENDING] Add password support: Replace `by_name` and `by_index` with `by_name_decrypt` and `by_index_decrypt` using the provided credentials when applicable.

## Verification Plan

### Automated Tests
- [PENDING] **Test Fixture Generation**: Create a throwaway script or use `7z` command-line (via a Python script) to programmatically generate dummy encrypted `.zip`, `.rar`, and `.7z` fixtures with a known password.
- [PENDING] Run `cargo test --manifest-path src-tauri/Cargo.toml` to ensure no existing archive caching or extraction tests break.
- [PENDING] Add new unit tests in `src-tauri/src/tests/` utilizing the new encrypted fixtures to verify that `PasswordRequired` is emitted when omitted, and extraction succeeds when provided.

### Manual Verification
- [PENDING] Launch the application and open an encrypted archive to ensure it cleanly rejects/signals the password requirement without crashing.
- [PENDING] Verify that opening a massive archive does not lock up the main application thread during its extraction phase.
