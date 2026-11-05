# Working tree validation report

**Target:** Current working tree on 2026-09-12.

**Verdict:** Pass. Metadata runtime testing passed without regressions, and archiver-temp runtime verification passed across the tested programs and edges.

**Summary:** The working tree adds JSON archive metadata support, archiver-temp origin resolution, animated viewer pipeline changes, and `.agents/` documentation updates. The focused checks pass, and manual runtime verification passed for the archiver-temp paths the user tested.

## Checks run

- [x] Read `.agents/AGENTS.md`, `.agents/skills/validate-changes/SKILL.md`, `.agents/skills/blast-radius/SKILL.md`, and `.agents/skills/unslop/SKILL.md`.
- [x] Scoped changes with `git status --short`, `git diff --stat`, `git diff --name-only`, and targeted `git diff`.
- [x] Ran `npm test`.
  - Result: 67 passed, 0 failed.
- [x] Ran `cargo check --tests` from `src-tauri`.
  - Result: passed.
- [x] Ran `cargo test temp_archive_tests` from `src-tauri`.
  - Initial result: 17 passed, 0 failed.
  - After stale cleanup: 16 passed, 0 failed.
- [x] Ran `node --check` for changed JS files:
  - `src/js/core.js`
  - `src/js/fsUtils.js`
  - `src/js/metadata.js`
  - `src/js/services/metadataFiles.js`
  - `src/js/viewer/viewerPipelines.js`
  - `src/js/viewer/viewerRender.js`
  - `src/js/tests/metadata.test.mjs`
- [x] Ran `node --test src\js\tests\metadata.test.mjs` after architecture cleanup.
  - Result: 10 passed, 0 failed.
- [x] Ran `npm test` after architecture cleanup.
  - Result: 68 passed, 0 failed.
- [x] Ran `cargo test temp_archive_tests` from `src-tauri` after architecture cleanup.
  - Result: 16 passed, 0 failed.
- [x] Ran `cargo check --tests` from `src-tauri` after architecture cleanup.
  - Result: passed.
- [x] Ran `cargo test temp_archive_tests` from `src-tauri` after 7-Zip/NanaZip PID filtering.
  - Result: 17 passed, 0 failed.
- [x] Ran `cargo check --tests` from `src-tauri` after 7-Zip/NanaZip PID filtering.
  - Result: passed.
- [x] Ran archive default-order checks after the root-before-nested list ordering fix.
  - `node --check src\js\services\sorting.js`: passed.
  - `node --check src\js\fsUtils.js`: passed.
  - `node --test src\js\tests\sorting.test.mjs`: 1 passed, 0 failed.
  - `node --test src\js\tests\refresh.test.mjs`: 13 passed, 0 failed.
  - `cargo test --manifest-path src-tauri/Cargo.toml archive_default_order_places_root_files_before_nested_paths`: 1 passed, 0 failed.
  - `cargo test --manifest-path src-tauri/Cargo.toml zip_`: 19 passed, 0 failed.
  - `cargo test --manifest-path src-tauri/Cargo.toml rar_`: 6 passed, 0 failed.
  - `cargo test --manifest-path src-tauri/Cargo.toml sevenz_`: 6 passed, 0 failed.
  - `cargo test --manifest-path src-tauri/Cargo.toml tar_`: 3 passed, 0 failed.
- [ ] Did not run full `cargo test`. The repo guidance prefers targeted Rust checks unless the blast radius needs the full suite.
- [x] Manual runtime testing found no issues for Explorer ZIP, Bandizip, WinZip, PeaZip, 7-Zip, NanaZip, or the tested edge cases.

## AGENTS.md violations

- [x] `src-tauri/src/platform/temp_archive.rs:1181` [Observable change] `resolve_temp_origin` took the global `ArchiveCache` write lock before candidate discovery and held it through native window/registry probing. Fixed by splitting request preparation into `resolve_temp_request`; path parsing, file-size lookup, and `collect_candidates` now run before `state.write()` is taken at `src-tauri/src/platform/temp_archive.rs:1190`. The lock is held only while checking candidate archives through `ArchiveCache`.

- [x] `src/js/fsUtils.js:707` and `src-tauri/src/platform/temp_archive.rs:58` [Observable change] Temp-file detection accepted any path containing a `temp` folder. Fixed the backend authority: `parse_temp_engine` now requires `path.strip_prefix(std::env::temp_dir())` and returns `None` otherwise. Added a regression assertion for `E:\work\temp\7zO81809E5E\export.png` in `src-tauri/src/tests/temp_archive_tests.rs:241`.

- [x] `src/js/fsUtils.js:509` [Observable change] `isMetaEntry` used a loose regex separate from `metadata.js`'s exact matching. Fixed by adding the pure helper module `src/js/services/metadataFiles.js`, exporting `METADATA_FILENAMES`, `findMetadataEntry`, and `isMetadataEntryName`. `metadata.js` re-exports `findMetadataEntry`, and `fsUtils.js` filters metadata entries through the same exact basename predicate. Added regression coverage for `notmeta.json` and `mycomicinfo.json` in `src/js/tests/metadata.test.mjs:35`.

## Stale code and references

Cleanup pass completed on 2026-09-12.

- [x] `src/js/viewer/viewerRender.js:372` [No observable change] `isReEntry` was computed but unused after the branch switched to `state.isAnimated`. Removed the dead local.

- [x] `src/js/metadata.js:5` [No observable change] The top comment listed only `ComicInfo.xml`, `CoMet.xml`, and `metadata.opf`, but the implementation now supports `comicinfo.json`, `meta.json`, and `comet.json`. Updated the comment to match the broader format support.

- [x] `.agents/additions.md:105` [No observable change] "Additional Metadata Formats" was still in the deferred backlog and said `comicinfo.json` support was not implemented. Rewrote the entry as "Embedded Image Metadata" so the remaining backlog item is only EXIF/Acme-style metadata inside image files.

- [x] `.agents/slice-5_additional-metadata-formats-plan.md:191` [No observable change] The plan said 12 Rust temp-archive tests were added, but the test count changed. Replaced the fixed count with "targeted unit tests".

- [x] `src-tauri/src/tests/temp_archive_tests.rs:141` [No observable change] Temp-archive tests hard-coded `E:\Projects\QuiviT\test-files\_archives\zip.zip` repeatedly. Added repo-relative helpers based on `CARGO_MANIFEST_DIR` and switched the fixture references to those helpers.

- [x] `src-tauri/src/tests/temp_archive_tests.rs:681` [No observable change] `test_debug_live_collect_candidates` had no assertion and printed live window/candidate data. Removed it. The related Explorer candidate-history test also depended on local registry/window state, so it was converted into a deterministic relative-path matcher test.

## Confidence notes

- [x] JSON metadata parsing is covered by Node tests and syntax checks.
- [x] Runtime metadata testing showed no regressions or issues.
- [x] Temp-archive parser and matcher logic compile and pass the targeted Rust test module on this checkout.
- [x] The architecture fixes reached the "ran it" confidence level through targeted JS/Rust tests.
- [x] Live probing reproduced the mixed 7-Zip/NanaZip conflict: classic 7-Zip reported archive root while NanaZip reported `New folder`, and old deduplication collapsed the archive candidate to `New folder`.
- [x] The new 7-Zip/NanaZip conflict test passes, and a live diagnostic confirmed the mixed-window candidate can clear `known_subfolder` instead of forcing `New folder`.
- [x] Added 7-Zip/NanaZip PID filtering: the resolver decodes the low 12 process ID bits from `7zO*` temp folders, prefers a matching live window, and ignores unrelated live windows when the PID hint has no match.
- [x] User confirmed all programs and tested edge cases passed manual runtime verification.
- [x] Archive default list ordering keeps root entries before nested entries for ZIP, RAR, 7Z, and TAR. Natural sorting still applies inside each group, and user-selected sorts can still change the visible order.
