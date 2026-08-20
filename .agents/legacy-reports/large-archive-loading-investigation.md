# Large-Archive Image Loading Failure: Investigation Notes

Status: IN PROGRESS: root cause partially identified (7z poll race confirmed at Rust layer), cbz path still unexplained. Delegated for deeper debugging.

Date: 2026-08-05

## Bug report (user)

- Formats affected: **7z and cbz** on "larger files".
- Symptom: images don't load initially: the viewer shows a generic broken-image icon with `title=""` (the `onerror` fallback in viewer.js) instead of the picture.
- Loading "eventually works" after navigating back/forth between images (initial load fails, takes several attempts).
- The user's "404/202" phrasing was approximate; the real observable is the broken-image icon.
- The first (sorted) file is `BAKEMONOGATARI - c013 (v03) - p002 [Kodansha Comics] [Digital] [1r0n] {HQ}.jpg` (7.8MB, pure ASCII name): so the UTF-8 name handling is NOT the trigger for the first image, though it was a real bug worth fixing.
- User confirmed the issue **still persists** after the UTF-8 fix.

## Architecture recap

- Frontend: `src/js/fsUtils.js` `buildArchiveSrc()` (line 49) builds image URLs:
  `http://quivit.localhost/archive/{base64url(archivePath)}/{encodeURIComponent(entryName)}`
  (Windows uses `http://quivit.localhost`; macOS/Linux `quivit://localhost`).
- Backend: `register_asynchronous_uri_scheme_protocol("quivit", ...)` in `src-tauri/src/lib.rs` (~line 1148) handles those URLs. Tauri v2.11.5, `protocol-asset` feature.
- Viewer preloader: `src/js/viewer.js` (~261-294). `_currentPreloadSrc` guard; on `onerror` falls back to `img.src = state.src` → broken image shown.
- Archive cache: `ArchiveCache` struct (lib.rs:300), `zip_capacity: 20` LRU.

### Per-format serving path in the protocol handler (lib.rs ~1190-1253)

| ext | path | mechanism |
|---|---|---|
| `zip` / `cbz` | `zip_entries` LRU | cache hit, else on-demand `extract_zip_entry()` (full in-memory Vec) |
| `rar` / `cbr` / `7z` / `cb7` | `extract_temp_dir` | background extraction writes all images to temp dir; handler polls file up to **3s (30 × 100ms)** then 404 |
| `cbt` / `tar` | none | on-demand `extract_tar_entry()` (streams entry, full in-memory Vec) |

- Background extractors spawned in `list_archive` (lib.rs:704): `extract_rar_to_temp` / `extract_7z_to_temp`.
- 7z/cb7 are SOLID archives (single LZMA2 block) → must extract sequentially in archive order; cannot random-access single entries. `extract_7z_to_temp` (lib.rs:478) writes only image files.
- `prefetch_archive_entries` (lib.rs:756) only prefetches for zip/cbz (extracts 7-ahead / 3-behind into LRU).

## Findings so far

### CONFIRMED at Rust layer (reproduced with timing test)

`protocol_serve_timing_simulation` test in `src-tauri/src/lib.rs` archive_tests module reproduces the exact handler serving path against the real fixtures. Results:

```
7z first entry poll: found=true  elapsed=101ms     (BAKEMONOGATARI jpg, 7.8MB)
7z BMP poll:         found=false elapsed=3.02s    (BDレーベル.bmp, 31MB)  → 3s poll EXHAUSTED → handler would return 404
cbz on-demand first entry: 7790305 bytes (OK)
cbt on-demand first entry: 7790305 bytes (OK)
```

- **7z/cb7 (and rar/cbr) large files: CONFIRMED RACE.** The handler's 3-second poll (lib.rs:1240-1246) is too short. The 31MB BMP is not written to the temp dir within 3s of extraction starting, so the first request 404s → broken image. Navigating back/forth later works because by then the background extraction has finished writing the file. This exactly matches the "eventually works after going back/forth" report.
  - The first/early entries are fine (extracted quickly): so the user's failing case is large entries deep in the archive, or slow disks / big archives.
  - Race also has a secondary hazard: `fs::read` on a file that is currently mid-write (background thread uses `File::create` + `io::copy`) can return a PARTIAL file → image decodes as garbage even if the poll succeeds. Not yet proven, but the write-then-read race exists (no atomic rename).

### FIXED (regression-tested)

- **`urlencoding_decode` (lib.rs:1326) corrupted multi-byte UTF-8 entry names.** The 31MB BMP in every fixture is really named `BDレーベル.bmp` (UTF-8 bytes `42 44 E3 83 AC E3 83 BC E3 83 99 E3 83 AB`). Old code pushed each `%XX` byte as a Latin-1 char (`0xE3 → 'ã'`), producing a garbage name → name never matched archive entry → 404 → broken image, permanently, regardless of timing. Fixed to accumulate bytes + `String::from_utf8`. New test: `url_decode_roundtrips_utf8_entry_names`. This was a REAL bug but is NOT the trigger for the first image (ASCII name).

### Still unexplained

- **cbz serving at Rust layer works** (on-demand extraction returns full bytes; no poll race for zip). So why does the user see cbz fail on larger files? Hypotheses, not yet verified:
  1. WebView2/Tauri custom-protocol large-response failure: serving ~8MB (or the 31MB BMP) in a single `Response.body(vec)` over `register_asynchronous_uri_scheme_protocol` on Windows. Known Tauri issue family (#9875, #3421, wry #1174). The tauri IPC-fallback fix (#10582, b1d9ffa) is in 2.11.5, but large-body behavior on Windows WebView2 custom protocols is still suspect. zip/rar/tar of the SAME content would presumably also fail → but user only reported 7z + cbz, so maybe they only tested those, or the mechanism differs.
  2. LRU eviction interaction: `zip_capacity: 20`, archive has 14 image entries, so eviction shouldn't matter, but 31MB × 14 ≈ 434MB in RAM: memory pressure possible.
  3. Something specific to how WebView2 loads `<img>` from the custom protocol with large bodies (response buffering / content-length handling).
- Why 7z AND cbz specifically (not zip/rar/tar/cbt) is odd given code-path equivalence (cbz≡zip). Possibly the user only opened cbz + 7z, or fixture `cbz.cbz`/`7z.7z` sizes (47MB/38MB) trigger it while `zip.zip` (49MB) happens to be tolerated: unlikely to be a hard threshold.

## Test fixtures (test-files/archives/): all 8 contain identical content

- `7z.7z` 38MB solid LZMA2 (Blocks=1), `cb7.cb7` 38MB solid LZMA2:25
- `cbz.cbz` 47MB, `zip.zip` 49MB, `cbt.cbt` 82MB, `tar.tar` 82MB
- `cbr.cbr` 37MB RAR5, `rar.rar` 37MB
- Content: 14 entries incl. `New folder/` nested dupes; 31MB `BDレーベル.bmp` (the large one); 7.8MB BAKEMONOGATARI jpg (first sorted); misc png/webp/gif/svg/ico/apng.

## Reproduction commands

```bash
cd src-tauri
cargo test --lib protocol_serve_timing_simulation -- --nocapture
cargo test --lib archive_tests
cargo check
```

## Candidate fixes to explore (not yet applied)

1. **7z/rar temp-dir race:**
   - Replace the 3s fixed poll with waiting until the entry exists (no arbitrary timeout), OR
   - Make `extract_7z_to_temp`/`extract_rar_to_temp` write to a temp filename then atomically rename when the entry is complete, so the handler never reads a partial file, OR
   - Have the background extractor signal completion (e.g., a `.done` marker file or shared flag) and have the handler block until then instead of polling, OR
   - Serve 7z via on-demand decompression: extract just the requested entry from the solid block (sevenz-rust2 supports seeking within the block: see `ArchiveReader` iteration) instead of the full temp extraction. Removes the race entirely but may be slower per request.
2. **cbz / large response bodies:**
   - Investigate WebView2 custom-protocol large-response limits on Windows. Options: stream the body via chunked response, or use `convertFileSrc`/asset protocol + temp file for zip entries (already on disk for 7z), or serve via a local HTTP server.
   - Verify by testing whether `zip.zip`/`rar.rar`/`tar.tar` (same content) also fail in the app: if yes, it's a size/protocol issue, not cbz-specific.
3. **General:** check WebView2 `Response` body size handling; consider setting `Content-Length` explicitly (currently only `Content-Type` + CORS are set).

## Key file references

- `src-tauri/src/lib.rs`:
  - protocol handler: ~1148-1271 (zip/rar/temp poll branches ~1196-1253, 3s poll 1240-1246)
  - `ArchiveCache`: 300-318
  - `extract_zip_entry`: 359, `list_zip_entries`: 334
  - `extract_rar_to_temp`: 405, `list_rar_entries`: 371
  - `extract_7z_to_temp`: 478, `list_7z_entries`: 449
  - `extract_tar_entry`: 541, `list_tar_entries`: 507
  - `list_archive`: 704, `prefetch_archive_entries`: 756
  - `guess_mime`: 1368, `urlencoding_decode`: 1326 (FIXED), `base64_decode`: 1278
  - tests: `archive_tests` mod ~1383+; new `protocol_serve_timing_simulation` ~1556+
- `src/js/fsUtils.js`: `buildArchiveSrc` 49-54, `prefetchAhead` 466-494
- `src/js/viewer.js`: preloader 261-294, load handler 242-257
- `src/js/core.js`: archive load/navigate ~134-154
- `src-tauri/Cargo.toml`: tauri 2 (protocol-asset), zip 8.6.0, unrar 0.5.8, sevenz-rust2 0.21, tar 0.4, md5 0.8.1

## Environment

- Windows (win32), WebView2, Tauri v2.11.5 (Cargo.lock)
- NanaZip Store app available at `%LOCALAPPDATA%\Microsoft\WindowsApps\NanaZipC.exe` (7z CLI) for fixture inspection.
