# Phase 3 Antigravity Handoff

Status as of the Codex handoff: Phase 3 has meaningful progress, but it is not fully done.

## Current dirty slice

Files currently dirty:

- `src-tauri/src/platform/icons.rs`
- `src-tauri/src/protocol.rs`
- `src-tauri/src/tests/protocol_tests.rs`
- `src/js/filepanel/filePanel.js`
- `src/js/fsUtils.js`

What this slice does:

- Adds a binary native-icon path through the existing `quivit` custom protocol: `/icon/<path_b64>/<ext_b64>`.
- Keeps the existing `get_native_icon` IPC command as a fallback.
- Changes the Rust native-icon cache to store PNG bytes internally, then wraps those bytes as a data URI only for the old IPC path.
- Updates the file panel to probe the binary icon URL first and fall back to IPC if loading fails.
- Keeps the protocol miss path on `tauri::async_runtime::spawn_blocking` instead of a raw `std::thread::spawn`.
- Keeps archive image byte-range support from the prior protocol work.

Manual verification already done:

- Large archive image smoke test passed after the protocol/range work.
- File-panel native icons were checked in the app after the icon protocol work. No issues seen.

Checks already run:

- `cargo check` passed.
- `cargo test protocol::tests` passed, 9 tests.
- Full `cargo test` passed before the last formatting-only protocol test/import tidy, 39 tests.
- `node --check src/js/fsUtils.js` passed.
- `node --check src/js/filepanel/filePanel.js` passed.
- `git diff --check` passed.

Before committing, rerun:

- `cargo check`
- `cargo test`
- `node --check src/js/fsUtils.js`
- `node --check src/js/filepanel/filePanel.js`
- `git diff --check`

## Section 3 smell status

From `.agents/rust-decoupling-final-passthrough.md`, section `3. Remaining architectural & safety smells`:

- `3.1 Unbounded OS thread spawning in protocol.rs`: partly addressed. Protocol misses now use `tauri::async_runtime::spawn_blocking`. Do not move archive temp extractors to that runtime without more work; Codex tried it and `archive_cache_evicts_extract_temp_on_drop` failed because extraction no longer completed quickly enough in the test harness.
- `3.2 Granularity of Mutex<ArchiveCache> and Condvar lock starvation`: the serious starvation bug is addressed. `read_entry_bytes()` returns `ArchiveEntryData`, and callers drop the archive mutex before `wait_for_data()`. Prefetch lock batching is also present. The bigger optional rewrite to `RwLock` or per-archive locks is still open.
- `3.3 Missing cancellation signal for background archive extractors`: addressed. `SingleArchiveCache::cancel_flag()` exists and extractors check it.
- `3.4 Missing RAII COM guard in platform/dialog.rs`: addressed. `ScopedCoInit` exists.
- `3.5 Missing metadata filter in 7z listing bug`: addressed. 7z listing includes metadata extensions.
- `3.6 Non-atomic configuration writes in config.rs`: addressed. `atomic_write()` exists and config writes use it.

## Phase 3 work that remains worth doing

### 1. Finish and harden the icon protocol slice

This is the current dirty slice.

Recommended follow-up:

- Re-run full checks listed above.
- Review the file-panel fallback path. It should keep working if `/icon/...` returns 404.
- Confirm `localStorage` now stores protocol icon URLs for newly loaded icons, not base64 data URIs, unless the fallback path is used.
- Consider whether storing protocol icon URLs in `localStorage` is desirable across restarts. It should be stable because it encodes the path/ext key, but for real paths it may point to moved folders. This matches previous behavior reasonably, but it is worth one quick review.
- If this slice is accepted, update `README.md` only if the project documents native icon loading internals. Otherwise no README change is needed.

### 2. Decide whether to attempt per-archive locking

This is the only remaining real item from section 3.2.

Current problem:

- `ArchiveCache` still sits behind one global `Mutex`.
- Reads mutate LRU state, so simply changing `Mutex<ArchiveCache>` to `RwLock<ArchiveCache>` will not create much parallel read access.

Reasonable approach:

- Do not start with a full `RwLock` conversion.
- First split pure cache lookup from LRU mutation only where it pays off, probably cached ZIP protocol hits.
- If that stays clean, consider per-archive state locks later.

Stop condition:

- If the change starts widening `ArchiveCache` internals or forces public-field reach-in, stop. The repo rule is facade methods only.

### 3. Improve zero-copy response only if Tauri allows it

What is already done:

- ZIP cache entries use `Arc<[u8]>` via `SharedEntryBytes`.

Remaining limitation:

- Tauri protocol responses still take `Response<Vec<u8>>`, so the final response currently copies into a `Vec`.

Next useful investigation:

- Check whether the Tauri response body can use another body type or a streaming/ranged body in this version.
- If not, do not spend time trying to remove the final response copy. The cache clone win is already captured.

### 4. Do not chase raw thread spawning in icon warmup yet

`platform/icons.rs` still has a raw `std::thread::spawn` in `warmup()`.

Recommendation:

- Leave it alone unless there is a measured issue.
- It runs once to absorb shell icon initialization. It is not the same problem as spawning one OS thread per protocol image request.

### 5. Do not redo completed Section 3 work

Avoid reworking these unless tests or manual verification show a problem:

- Condvar wait lock-drop behavior.
- Extractor cancellation.
- COM RAII guard.
- 7z metadata inclusion.
- Atomic config writes.
- ZIP open-handle reuse.
- `write_temp_entry` and `notify_extracted`. They are active extractor helpers. Do not prune them.

## Suggested next slice order

1. Finalize and commit the current icon protocol slice.
2. If continuing Phase 3, investigate per-archive locking with a narrow prototype around cached ZIP hits.
3. Only then consider bigger wire-breaking work.

Binary icon transport is now partly implemented without a hard wire break. A fully wire-breaking cleanup could remove the old base64 IPC icon path later, but keep it for now until the protocol path has had real app time.
