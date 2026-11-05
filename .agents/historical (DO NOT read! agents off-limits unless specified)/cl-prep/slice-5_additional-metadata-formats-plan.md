# Slice 5: Additional Metadata Formats (ComicInfo JSON & Meta JSON) Plan

## Goal

Extend QuiviT's archive metadata engine to detect and parse `comicinfo.json` (and `ComicInfo.json`) and `meta.json` alongside `ComicInfo.xml`, `CoMet.xml`, and `metadata.opf`.

Key capabilities in this slice:
1. **Archive metadata entry detection**: Recognize `comicinfo.json` and `meta.json` in archives, keeping them hidden from the primary image list while exposing them to the metadata extraction pipeline.
2. **ComicInfo JSON schema mapping**: Support both PascalCase (ComicRack / Anansi exports) and camelCase (Tachiyomi / Mihon / Komga / Suwayomi exports), mapping cleanly into the existing `ComicMeta` contract.
3. **Scraper / gallery Meta JSON schema mapping**: Support gallery metadata formats (`meta.json`) by extracting title (multilingual dictionaries or strings), artists, parody franchises, groups, categories, tags, languages, page counts, and upload timestamps.
4. **Resilient value normalization**: Normalize string and array variants for creators and tags, handle boolean and string manga orientation flags, and parse numeric year, month, and page counts safely.
5. **Automated test coverage**: Provide unit tests in `src/js/tests/metadata.test.mjs` verifying entry matching, schema parsing for both JSON variants, and malformed JSON resilience.

> [!IMPORTANT]
> ## User Review Required
> - **Precedence**: Priority order is `ComicInfo.xml` -> `comicinfo.json` -> `meta.json` -> `comet.xml` -> `metadata.opf`.
> - **Entry Visibility**: Both `comicinfo.json` and `meta.json` are classified as metadata files and filtered out of the active image list in `fsUtils.js`.
> - **Casing & Schema Detection**: The JSON parser automatically distinguishes between ComicInfo schema and gallery `meta.json` schema without requiring configuration flags.
> - **Privacy & Sanitization**: Test fixtures use only sanitized, synthetic mock data. No user paths, filenames, or sensitive text are placed into the repository.

> [!CAUTION]
> ## Execution Rules
> **Do not mark pending items as completed after writing the code.** Pending deviation items must remain marked as `[PENDING]` until the user has explicitly verified and approved that the implementation works correctly at runtime.

---

## Architectural Invariants & Validation Constraints

Every item in this plan follows [.agents/AGENTS.md](file:///E:/Projects/QuiviT/.agents/AGENTS.md) and the architectural review standards of [.agents/skills/validate-changes/SKILL.md](file:///E:/Projects/QuiviT/.agents/skills/validate-changes/SKILL.md):

1. **Frontend DOM & Architecture Boundaries:**
   - [metadata.js](file:///E:/Projects/QuiviT/src/js/metadata.js) is a pure domain service with zero DOM imports, UI querying, or cross-window dependencies.
   - Single owner per surface: [metadataBadge.js](file:///E:/Projects/QuiviT/src/js/main/metadataBadge.js) owns the action-bar trigger, and [metadata-window.js](file:///E:/Projects/QuiviT/src/js/metadata-window.js) owns the standalone metadata window rendering.
   - State machine decoupling: [core.js](file:///E:/Projects/QuiviT/src/js/core.js) stores `archiveMetadataFiles` as a raw string array without parsing or caching metadata payloads in global state.

2. **Performance First & Hot Path Invariants:**
   - **Zero Synchronous I/O**: Metadata parsing occurs strictly asynchronously on archive load.
   - **Native JSON Parsing**: Uses native `JSON.parse()` without third-party schema validators or dynamic evaluations.
   - **Fallback Graceful Teardown**: Corrupted or non-JSON payloads return `null` immediately, avoiding error propagation or UI stalls.

3. **Blast Radius & Downstream Safety:**
   - **Preserved XML Precedence**: `ComicInfo.xml` maintains priority over JSON formats when both exist in an archive.
   - **List Filtering Parity**: `fsUtils.js` filters `comicinfo.json` and `meta.json` from the active file list so metadata files never appear as unrenderable image rows.
   - **Stable IPC and Contract**: The `ComicMeta` object structure consumed by [metadata-window.js](file:///E:/Projects/QuiviT/src/js/metadata-window.js) remains unchanged.

---

## Scope of Work

### 1. File List & Metadata Entry Detection
- **Issue**: In `src/js/fsUtils.js`, `metaFiles` filters only `/\.(xml|opf)$/i`. If an archive contains `comicinfo.json` or `meta.json`, they are treated as generic files and displayed in the file list rather than routed to the metadata pipeline.
- **Change**:
  - Centralize metadata filename priority and exact basename matching in [metadataFiles.js](file:///E:/Projects/QuiviT/src/js/services/metadataFiles.js).
  - Update archive entry filtering in [fsUtils.js](file:///E:/Projects/QuiviT/src/js/fsUtils.js) to classify `comicinfo.json`, `meta.json`, and `comet.json` through `isMetadataEntryName`.
  - Separate `metaFiles` and `imgFiles` using the shared predicate so metadata detection stays consistent with [metadata.js](file:///E:/Projects/QuiviT/src/js/metadata.js).

### 2. Priority Matching & Format Resolution
- **Issue**: [metadata.js](file:///E:/Projects/QuiviT/src/js/metadata.js) previously owned metadata filename priority by itself, while archive filtering used a separate predicate.
- **Change**:
  - Use the shared [metadataFiles.js](file:///E:/Projects/QuiviT/src/js/services/metadataFiles.js) priority order:
    ```js
    ['comicinfo.xml', 'comicinfo.json', 'meta.json', 'comet.xml', 'comet.json', 'metadata.opf']
    ```
  - In `fetchMetadata()`, check if the matched entry ends with `.json`.
  - When `.json`, parse using `JSON.parse(text)` and route:
    - If entry is `meta.json` or payload contains tag objects with `type` and `name`, delegate to `parseGalleryMetaJson(data)`.
    - Otherwise, delegate to `parseComicInfoJson(data)`.
  - When `.xml` or `.opf`, retain existing `DOMParser` pipeline.

### 3. Schema Parser Implementations
- **Change**:
  - Implement `parseComicInfoJson(raw)` in [metadata.js](file:///E:/Projects/QuiviT/src/js/metadata.js):
    - Helper `get(keyPascal, keyCamel)`: checks `raw[keyPascal] ?? raw[keyCamel]`, trims strings, joins string arrays with `', '`, or converts primitive numbers to string.
    - Helper `getNum(keyPascal, keyCamel)`: parses integer values safely, returning `null` on missing or NaN.
    - Helper `getManga(keyPascal, keyCamel)`: handles boolean flags (`true` -> `'Yes'`, `false` -> `'No'`) and string values (`'Yes'`, `'No'`, `'YesAndRightToLeft'`).
    - Maps to canonical `ComicMeta` fields.
  - Implement `parseGalleryMetaJson(raw)` in [metadata.js](file:///E:/Projects/QuiviT/src/js/metadata.js):
    - `title`: extracts string or `title.english` || `title.pretty` || `title.japanese`.
    - `series`: extracts tags with `type === 'parody'`.
    - `writer` / `penciller`: extracts tags with `type === 'artist'`.
    - `publisher`: extracts tags with `type === 'group'`.
    - `genre`: extracts tags with `type === 'category'`.
    - `tags`: extracts tags with `type === 'tag'` and `type === 'character'`.
    - `languageISO`: extracts tags with `type === 'language'` excluding `'translated'`.
    - `year` and `month`: derived from `upload_date` epoch timestamp if present.
    - `pageCount`: parsed from `num_pages`.
    - `manga`: defaults to `'Yes'`.
    - `notes`: formatted scanlator notice if present.

### 4. Automated Testing
- **Change**:
  - Create [src/js/tests/metadata.test.mjs](file:///E:/Projects/QuiviT/src/js/tests/metadata.test.mjs) testing:
    - `findMetadataEntry` priority ordering (`comicinfo.xml` before `comicinfo.json`, before `meta.json`, before `metadata.opf`).
    - Case-insensitivity and nested path stripping.
    - `parseComicInfoJson` with PascalCase and camelCase properties.
    - `parseGalleryMetaJson` with multilingual titles, tag classification, and timestamp derivation.
    - Safe recovery and `null` return on invalid JSON input.

### 5. Archiver Temporary Extraction Redirection (Completed Deviation)
- **Problem**: When opening an image or supported file directly from inside an archiver, the engine extracts the file into `%TEMP%` and invokes QuiviT with the temporary file path. Without redirection, QuiviT opens the single extracted file in disk mode, isolating the user inside an ephemeral temporary folder instead of opening the parent archive container with the selected file active.
- **Forensics Findings**:
  - Investigation in [.agents/archiver-temp-subfolder-report.md](file:///E:/Projects/QuiviT/.agents/archiver-temp-subfolder-report.md) showed archivers divide into two distinct categories:
    1. **Hierarchy-Preserving Engines**: Windows Explorer (`zipfldr.dll`), PeaZip (`peazip-tmp\.ptmp*`), and WinZip (`wz*`). These preserve inner relative paths directly in the temp directory tree and are inferable from the path structure.
    2. **Flattening Engines**: 7-Zip, NanaZip, WinRAR, and Bandizip. These flatten extractions to `%TEMP%\<random>\<filename>`, discarding folder hierarchy.
- **Resolution Design**:
  - In Rust, implement `resolve_archive_temp_origin(path: String, state: State<'_, RwLock<ArchiveCache>>) -> Result<Option<TempArchiveOrigin>, String>` in [temp_archive.rs](file:///E:/Projects/QuiviT/src-tauri/src/platform/temp_archive.rs).
  - Fast bypass check: If the file path does not reside within `std::env::temp_dir()`, return `None` immediately with zero disk or registry overhead.
  - Path parsing and signature detection:
    1. **Windows Explorer (`zipfldr.dll`)**:
       - Pattern: `%TEMP%\<UUID>_<archive_filename>.<3hex>\<subfolders>\<leaf_filename>`.
       - Archive Name: Parsed directly from directory name without guessing (for example, `..._zip.zip.49d` gives `zip.zip`).
       - Inner Path: Relative path after the UUID directory is the exact entry path (for example, `New folder/image.png`).
       - Archive Lookup: Locate the source archive on disk by checking recent MRU or candidate paths matching the extracted archive name.
    2. **PeaZip**:
       - Pattern: `%TEMP%\peazip-tmp\.ptmp<6b64>\<subfolders>\<leaf_filename>`.
       - Inner Path: Relative path after `.ptmp*` is exact.
       - Disambiguation: Check archive candidates matching relative path and uncompressed file size.
    3. **WinZip**:
       - Pattern: `%TEMP%\wz<4hex>\<subfolders>\<leaf_filename>`.
       - Inner Path: Relative path after `wz*` is exact when subfolders exist.
    4. **WinRAR**:
       - Pattern: `%TEMP%\Rar$DIa<PID>.<rand>.rartemp\<leaf_filename>` (or `Rar$DRa`).
       - Direct PID Extraction: Parse the archiver PID directly from `Rar$DIa<PID>`.
       - Candidate Lookup: Read `HKCU\Software\WinRAR\ArcHistory` (`0` is active archive).
       - Lightweight Scoped Probing: Inspect top-level window title for that PID only (under 3 ms) to detect active subfolder (for example `archive.rar\subfolder - WinRAR`).
       - Entry Matching: Match entry by subfolder + filename + uncompressed size.
       - Safe Fallback: If no subfolder in title or window closed, match unique filename + size. If duplicates of identical size exist and no subfolder was resolved, fail closed and open flat file to avoid incorrect page selection.
    5. **7-Zip & NanaZip**:
       - Pattern: `%TEMP%\7zO<8hex>\<leaf_filename>` (or `7zE` on drag-and-drop).
       - Candidate Lookup: Read 7-Zip registry MRU (`HKCU\Software\7-Zip\FM\PanelPath0` and `FolderHistory`) and NanaZip MSIX package history hive (`SystemAppData\Helium\User.dat`).
       - Top-Level Window Filtering: Enumerate top-level desktop windows filtering for window class `FM` (`7-Zip`) and NanaZip package desktops to discover active archive paths and possible subfolders from window titles or live address-bar controls.
       - Entry Matching: Match by unique filename + uncompressed size. If window title carries a verified subfolder, prefer that subfolder path.
       - Safe Fallback: If duplicate entries with identical filename and size exist and no subfolder is determined, fail closed (fall back to flat temp view) to avoid incorrect page selection.
    6. **Bandizip**:
       - Pattern: `%TEMP%\BNZ.<15hex>\<leaf_filename>` (or `~bz.thumb`).
       - Prefix Filter: Require the immediate parent directory to start with `BNZ.` or `~bz.thumb` before doing any lookups.
       - Candidate Lookup: Read Bandizip MRU registry (`HKCU\Software\Bandizip`).
       - Top-Level Window Filtering: Enumerate top-level desktop windows filtering for classes `Bandizip` and `Arkview` to discover active archive paths from window titles.
       - Entry Matching: Match by unique filename + uncompressed size. If window title carries a verified subfolder, prefer that subfolder path.
       - Safe Fallback: If duplicate entries with identical filename and size exist and no subfolder is determined, fail closed (fall back to flat temp view) to avoid incorrect page selection.
  - Multi-tier archive verification guard:
    - Never guess or accept an unverified archive path.
    - Check that candidate archive exists and has a supported archive extension.
    - Collect path/window/registry candidates before acquiring the global `ArchiveCache` write lock.
    - Inspect archive contents using QuiviT's archive reader (`ArchiveCache::prepare_archive`).
    - Verify entry path and file size match.
    - When verified, return `TempArchiveOrigin` and pre-warm `ArchiveCache`.
    - If no candidate passes verification, return `None` and fall back to standard file loading.
  - Frontend integration:
    - In [fsUtils.js](file:///E:/Projects/QuiviT/src/js/fsUtils.js) `loadFile`, detect temp directory paths.
    - Invoke `resolve_archive_temp_origin`.
    - If resolved, redirect execution to `this.loadArchive(origin.archive_path, origin.entry_name, { ...options, preferInitial: true, restoreLastImage: false })`.

---

## Proposed Changes

### 1. Navigation & Entry Filtering
#### [MODIFY] [src/js/fsUtils.js](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
- [COMPLETED] `[Observable change]` Update archive entry filtering in `loadArchive` to classify `comicinfo.json`, `meta.json`, and `comet.json` through `isMetadataEntryName`, include them in `metaFiles`, and exclude them from `imgFiles`.

### 2. Metadata Detection & Parsing
#### [NEW] [src/js/services/metadataFiles.js](file:///E:/Projects/QuiviT/src/js/services/metadataFiles.js)
- [COMPLETED] `[Observable change]` Centralize `METADATA_FILENAMES`, `findMetadataEntry`, and `isMetadataEntryName` so archive filtering and metadata parsing use the same exact basename rules.

#### [MODIFY] [src/js/metadata.js](file:///E:/Projects/QuiviT/src/js/metadata.js)
- [COMPLETED] `[Observable change]` Reuse the shared metadata filename priority, including `comicinfo.json`, `meta.json`, and `comet.json`.
- [COMPLETED] `[Observable change]` Update `fetchMetadata` to route `.json` files to `JSON.parse`, `parseComicInfoJson`, and `parseGalleryMetaJson`.
- [COMPLETED] `[Observable change]` Implement `parseComicInfoJson` with dual casing support, array-to-string conversion, and safe number parsing.
- [COMPLETED] `[Observable change]` Implement `parseGalleryMetaJson` with title extraction, tag grouping, and date calculation.

### 3. Unit Test Suite
#### [NEW] [src/js/tests/metadata.test.mjs](file:///E:/Projects/QuiviT/src/js/tests/metadata.test.mjs)
- [COMPLETED] `[Observable change]` Add unit tests covering entry finding, exact basename filtering, JSON schema normalization for both formats, and error resilience using generic mock data.

### 4. Archiver Temp Extraction Resolution (Deviation)
#### [MODIFY] [src-tauri/src/models.rs](file:///E:/Projects/QuiviT/src-tauri/src/models.rs)
- [COMPLETED] `[Observable change]` Define `TempArchiveOrigin` struct with `archive_path: String` and `entry_name: String`.

#### [NEW] [src-tauri/src/platform/temp_archive.rs](file:///E:/Projects/QuiviT/src-tauri/src/platform/temp_archive.rs)
- [COMPLETED] `[Observable change]` Implement temp path parsing and signature detection for Windows Explorer, PeaZip, WinZip, WinRAR, 7-Zip/NanaZip, and Bandizip (window classes `Bandizip` and `Arkview`, `BNZ.` directory signature), candidate discovery before the `ArchiveCache` write lock, history subfolder isolation, live window/address-bar authority, entry size verification, strict `std::env::temp_dir()` bypass, and cache pre-warming.

#### [MODIFY] [src-tauri/src/platform/mod.rs](file:///E:/Projects/QuiviT/src-tauri/src/platform/mod.rs)
- [COMPLETED] `[Observable change]` Expose `pub mod temp_archive;`.

#### [MODIFY] [src-tauri/src/commands/archives.rs](file:///E:/Projects/QuiviT/src-tauri/src/commands/archives.rs) & [src-tauri/src/lib.rs](file:///E:/Projects/QuiviT/src-tauri/src/lib.rs)
- [COMPLETED] `[Observable change]` Expose and register `resolve_archive_temp_origin` Tauri IPC command.

#### [MODIFY] [src/js/fsUtils.js](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
- [COMPLETED] `[Observable change]` In `loadFile`, detect temp extraction paths, invoke `resolve_archive_temp_origin`, and redirect execution to `loadArchive(origin.archive_path, origin.entry_name)` with `preferInitial: true`.

#### [NEW] [src-tauri/src/tests/temp_archive_tests.rs](file:///E:/Projects/QuiviT/src-tauri/src/tests/temp_archive_tests.rs)
- [COMPLETED] `[Observable change]` Add targeted unit tests verifying path parsing, strict temp-root rejection, signature detection (Explorer, PeaZip, WinZip, WinRAR PID extraction, 7-Zip/NanaZip prefixes, Bandizip `BNZ.` prefix), window title/address-bar parsing for root and subfolders, candidate deduplication, and entry matching.

### 5. Archive Default List Ordering (Deviation)
#### [MODIFY] [src-tauri/src/archives/mod.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/mod.rs)
- [COMPLETED] `[Observable change]` Centralize archive default ordering so root entries sort before nested entries, with natural sorting inside each group.

#### [MODIFY] [src-tauri/src/archives/zip.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/zip.rs), [src-tauri/src/archives/rar.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/rar.rs), [src-tauri/src/archives/sevenz.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/sevenz.rs), and [src-tauri/src/archives/tar.rs](file:///E:/Projects/QuiviT/src-tauri/src/archives/tar.rs)
- [COMPLETED] `[Observable change]` Apply the shared root-before-nested default ordering to ZIP/CBZ, RAR/CBR, 7Z/CB7, and TAR/CBT archive listings.

#### [MODIFY] [src/js/services/sorting.js](file:///E:/Projects/QuiviT/src/js/services/sorting.js) and [src/js/fsUtils.js](file:///E:/Projects/QuiviT/src/js/fsUtils.js)
- [COMPLETED] `[Observable change]` Preserve root-before-nested ordering for archive entries in the default ascending Name sort and in `naturalPagePosition`, while leaving explicit user sorting able to change the visible order.

#### [NEW] [src/js/tests/sorting.test.mjs](file:///E:/Projects/QuiviT/src/js/tests/sorting.test.mjs) and [MODIFY] [src-tauri/src/tests/archive_tests.rs](file:///E:/Projects/QuiviT/src-tauri/src/tests/archive_tests.rs)
- [COMPLETED] `[Observable change]` Add regression coverage for archive default ordering across the frontend sorter and the ZIP, RAR, 7Z, and TAR backend readers.

---

## Verification & Testing Plan

### Automated Tests
1. Run Node test suite:
   ```pwsh
   npm test
   ```
   Current result on 2026-09-12: 68 passed, 0 failed.
2. Run targeted Rust tests:
   ```pwsh
   cargo test --manifest-path src-tauri/Cargo.toml temp_archive_
   ```
   Current result on 2026-09-12: 17 temp-archive tests passed, 0 failed.
3. Run Rust compile and test check:
   ```pwsh
   cargo check --tests --manifest-path src-tauri/Cargo.toml
   ```
   Current result on 2026-09-12: passed.

### Manual Verification Checklist
1. Open an archive in Windows Explorer, double-click an image, and verify QuiviT opens the archive with the image selected instead of a single temp file.
2. Open an archive in PeaZip, double-click an image, and verify QuiviT opens the archive container with the image active.
3. Open an archive in WinZip, double-click an image, and verify QuiviT opens the archive container with the image active.
4. Open an archive in WinRAR, double-click an image (both root and subfolder), and verify QuiviT opens the archive with the matching image active.
5. Open an archive in 7-Zip or NanaZip, double-click an image (both root and subfolder), and verify QuiviT opens the archive container with the matching image active.
6. Open an archive in Bandizip, double-click an image (both root and subfolder), and verify QuiviT opens the archive container with the matching image active.
7. Verify an image inside an archive subfolder (for example `New folder\image.png`) resolves to the exact subfolder entry.
8. Verify normal images outside temp directories open immediately without IPC overhead or delay.
9. Verify archive default list ordering keeps root files before subdirectory files, and that user sorting still changes the visible order when selected.

---

## Deviations, Violations & Runtime Fixes

During Slice 5 implementation, the following deviations were addressed and manually approved at runtime.

1. **[COMPLETED] Direct Launch from Archiver Temp Extraction (Deviation / Runtime Backlog)**:
   - *Issue*: Opening a supported image directly from inside an archiver extracts the single file to `%TEMP%` and passes that temporary file path to QuiviT. QuiviT opened the standalone temporary file in disk mode, isolating the user inside the temporary directory rather than opening the parent archive.
   - *Forensics Analysis*: As documented in [.agents/archiver-temp-subfolder-report.md](file:///E:/Projects/QuiviT/.agents/archiver-temp-subfolder-report.md), engines differ in how they write to `%TEMP%`:
     1. Windows Explorer (`zipfldr.dll`), PeaZip (`peazip-tmp\.ptmp*`), and WinZip (`wz*`) preserve the inner relative folder hierarchy under their temporary extraction directory.
     2. 7-Zip, NanaZip, WinRAR, and Bandizip deliberately flatten extraction into `%TEMP%\<random>\<filename>`, discarding folder hierarchy.
   - *Subfolder Loop Root Cause & Working-Tree Fix*:
     1. During initial testing, 7-Zip, NanaZip, and WinRAR always selected subfolders even when files were opened from root.
     2. Investigation revealed that `FolderHistory` in the 7-Zip registry recorded past navigation (e.g. `zip.zip\New folder\`) and was parsed with active subfolders. Furthermore, candidate deduplication was explicitly overwriting root findings (`Some("")`) with non-empty subfolder strings.
     3. WinRAR root window titles (`zip.zip - WinRAR`) and address bar texts (`zip.zip\`) failed the subfolder regex check, returning `None` instead of explicit root (`Some("")`), falling back to stale registry history.
     4. Current implementation: candidate collection treats registry history strictly as candidate archive paths (`known_subfolder: None`). The live window and address bar (`get_winrar_address_bar`, `get_7z_address_bar`, `parse_winrar_window_title`, `parse_7z_window_title`) are the sole authority for active subfolders in flattening engines.
     5. For 7-Zip and NanaZip, the `7zO` temp folder leaks the low 12 bits of the creator process ID. The resolver uses that to prefer the matching live 7-Zip/NanaZip window when one exists.
     6. If the PID hint exists but no live 7-Zip/NanaZip window matches it, unrelated live subfolder context is ignored. If no PID hint exists and two live 7-Zip/NanaZip windows for the same archive disagree about root versus subfolder, deduplication clears the subfolder hint and fails closed instead of forcing a stale subfolder redirect.
     7. Current implementation also rejects paths outside `std::env::temp_dir()` before doing archive-origin work and gathers native candidates before acquiring the `ArchiveCache` write lock.
   - *Verification*: Automated checks passed on 2026-09-12: `node --test src\js\tests\metadata.test.mjs` (10 passed), `npm test` (68 passed), `cargo test temp_archive_tests` (17 passed), and `cargo check --tests`. Manual runtime verification passed for Explorer ZIP, Bandizip, WinZip, PeaZip, 7-Zip, NanaZip, and the tested edge cases.

2. **[COMPLETED] Archive Root-Before-Subdirectory Default Ordering (Deviation / Runtime Backlog)**:
   - *Issue*: Archive entries were naturally sorted by their full entry path. A nested file such as `aaa/01.jpg` could appear before a root file such as `z.jpg`, which made default archive reading order drift from the expected root-first order.
   - *Working-Tree Fix*: The backend archive readers now share one default comparator: root entries first, then nested entries, with natural ordering inside both groups. The frontend default ascending Name sort uses the same archive grouping for composite archive paths, and `naturalPagePosition` reuses that same default sorter so title/status page counts match the file list.
   - *Scope*: Applies to ZIP/CBZ, RAR/CBR, 7Z/CB7, and TAR/CBT archive listings. User-selected sorting remains active and can change the visible order.
    - *Verification*: Automated checks passed on 2026-09-12: `node --check src\js\services\sorting.js`, `node --check src\js\fsUtils.js`, `node --test src\js\tests\sorting.test.mjs` (1 passed), `node --test src\js\tests\refresh.test.mjs` (13 passed), `cargo test --manifest-path src-tauri/Cargo.toml archive_default_order_places_root_files_before_nested_paths` (1 passed), and targeted archive reader tests for `zip_`, `rar_`, `sevenz_`, and `tar_`. Manual runtime verification confirmed the default order works, including after sorting interactions.
