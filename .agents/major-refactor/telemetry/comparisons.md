# Telemetry verification ledger

Continuation record of pre-refactor (`[Telemetry A]`) versus post-refactor (`[Telemetry B]`) test runs across all refactoring slices.

---

## Slice 1.1: Frontend shared path, archive, media classification, and shader helpers

- **Telemetry A:** `.agents/major-refactor/telemetry/slice-1.1-a.json`
- **Telemetry B:** `.agents/major-refactor/telemetry/slice-1.1-b.json`
- **Harness:** Pure frontend Mocha (`mocha/actions.test.js`, `mocha/sorting.test.js`, `mocha/viewerMath.test.js`, `mocha/quadCompositor.test.js`)
- **Verdict:** 100% contract parity, 0 failures.

### Metrics comparison

| Metric | Telemetry A | Telemetry B | Delta |
|---|---|---|---|
| Suites | 34 | 34 | 0 |
| Total tests | 128 | 128 | 0 |
| Passes | 128 | 128 | 0 |
| Failures | 0 | 0 | 0 |
| Pending | 0 | 0 | 0 |
| Duration | 54 ms | 67 ms | +13 ms (timer resolution jitter) |

### Test suite breakdown

- `mocha/actions.test.js`: 17 / 17
- `mocha/sorting.test.js`: 20 / 20
- `mocha/viewerMath.test.js`: 72 / 72
- `mocha/quadCompositor.test.js`: 19 / 19

### Notes

- All 128 tests matched 1:1 in title, hierarchy, and sequence order.
- The +13 ms total delta reflects standard Windows 15.6 ms system timer tick variance, with 126 of 128 tests executing in 0 to 1 ms.

---

## Slice 1.2: Rust shared path, archive, Win32, GDI, and pixel helpers

- **Telemetry A:** `.agents/major-refactor/telemetry/slice-1.2-a.json`
- **Telemetry B:** `.agents/major-refactor/telemetry/slice-1.2-b.json`
- **Harness:** Rust backend unit tests (`src-tauri/src/tests/archive_tests.rs`, `src-tauri/src/tests/format_tests.rs`)
- **Verdict:** 100% contract parity, 0 failures.

### Metrics comparison

| Metric | Telemetry A | Telemetry B | Delta |
|---|---|---|---|
| Suites | 3 | 3 | 0 |
| Total tests | 62 | 62 | 0 |
| Passes | 62 | 62 | 0 |
| Failures | 0 | 0 | 0 |
| Pending | 0 | 0 | 0 |
| Duration | 3161 ms | 3200 ms | +39 ms (link and process launch variance) |

### Test suite breakdown

- `src-tauri/src/tests/archive_tests.rs`: 44 / 44 (includes 16 `temp_archive` origin matching tests)
- `src-tauri/src/tests/format_tests.rs`: 18 / 18

### Notes

- All 62 tests matched 1:1 in title, hierarchy, and sequence order.
- Test stubs in `archive_tests.rs` now import real extracted helpers from `crate::archives`, `crate::utils`, `crate::platform`, and `crate::platform::gdi` with 0 contract regressions.
- The +39 ms (+1.2%) duration delta reflects standard Windows process spawn, binary loading, and timer tick variance across `cargo test` invocations. Pure test execution time remained identical at ~60 ms.

---

## Slice 2.1: formats.rs decomposition, ArchiveCache lock contention, and panic-free parsing

- **Telemetry A:** `.agents/major-refactor/telemetry/slice-2.1-a.json`
- **Telemetry B:** `.agents/major-refactor/telemetry/slice-2.1-b.json`
- **Harness:** Rust backend unit tests (`src-tauri/src/tests/archive_tests.rs`, `src-tauri/src/tests/format_tests.rs`, `src-tauri/src/tests/ico_tests.rs`, `src-tauri/src/tests/protocol_tests.rs`)
- **Verdict:** 100% contract parity, 0 failures.

### Metrics comparison

| Metric | Telemetry A | Telemetry B | Delta |
|---|---|---|---|
| Suites | 5 | 5 | 0 |
| Total tests | 100 | 100 | 0 |
| Passes | 100 | 100 | 0 |
| Failures | 0 | 0 | 0 |
| Pending | 0 | 0 | 0 |
| Duration | 1834 ms | 320 ms | -1514 ms (fine-grained lock concurrency & reduced allocations) |

### Test suite breakdown

- `src-tauri/src/tests/archive_tests.rs`: 48 / 48 (32 `archive_tests` + 16 `temp_archive_tests`)
- `src-tauri/src/tests/format_tests.rs`: 26 / 26
- `src-tauri/src/tests/ico_tests.rs`: 8 / 8
- `src-tauri/src/tests/protocol_tests.rs`: 18 / 18

### Notes

- All 100 tests matched 1:1 in title, hierarchy, and sequence order with 0 regressions.
- `formats.rs` decomposed into `src-tauri/src/formats/{mod,registry,icons,animation,isobmff,dimensions}.rs` with 100% API facade compatibility.
- `ArchiveCache` header reads and temp extraction polling refactored to fine-grained concurrency, eliminating global write-lock starvation.
- Protocol zero-copy responses and fallible parsing in ICO and DIB image import verified with 0 failures or panics.

---

## Slice 2.2: Config, Library, Directory, and Container Sweep domain extraction

- **Telemetry A:** `.agents/major-refactor/telemetry/slice-2.2-a.json`
- **Telemetry B:** Pending implementation completion (#2.2.6)
- **Harness:** Rust backend unit tests (`src-tauri/src/tests/config_tests.rs`, `src-tauri/src/tests/directory_tests.rs`, `src-tauri/src/tests/library_tests.rs`)
- **Verdict:** Telemetry A baseline captured, 0 failures.

### Metrics baseline

| Metric | Telemetry A | Telemetry B | Delta |
|---|---|---|---|
| Suites | 3 | TBD | TBD |
| Total tests | 54 | TBD | TBD |
| Passes | 54 | TBD | TBD |
| Failures | 0 | TBD | TBD |
| Pending | 0 | TBD | TBD |
| Duration | 100 ms | TBD | TBD |

### Test suite breakdown

- `src-tauri/src/tests/config_tests.rs`: 27 / 27
- `src-tauri/src/tests/directory_tests.rs`: 13 / 13
- `src-tauri/src/tests/library_tests.rs`: 14 / 14

### Notes

- Baseline coverage expanded across split config serialization/deserialization across all 5 files, unchanged save determinism, pending config promotion edge cases, directory listing and sorting with natural order, metadata sidecar detection, deletion safety boundaries, library root write guards, path containment and normalization, and library relocation config remapping.
- All 54 tests pass without failures or panics.
