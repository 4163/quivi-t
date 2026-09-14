# IPC + Protocol Telemetry Map — QuiviT

Source files (exact revisions read 2026-09-14):
- `src-tauri/src/protocol.rs` (305 lines)
- `src-tauri/src/commands/archives.rs` (82 lines)
- `src-tauri/src/commands/directory.rs` (183 lines)
- `src-tauri/src/archives/mod.rs` (430 lines) + `src-tauri/src/archives/cache.rs` (536 lines, supporting)
- `src/js/fsUtils.js` (1000 lines)
- Supporting signatures verified: `src-tauri/src/lib.rs:77-112` (handler registration), `src-tauri/src/commands/animation.rs`, `shell.rs`, `watchers.rs`, `registry.rs:8-14`, `src-tauri/src/platform/icons.rs:116-152`, `src-tauri/src/platform/thumbnails.rs:84-113`, `src-tauri/src/archives/zip.rs:233-278`

---

## 1. Tauri IPC command inventory (registered in `lib.rs:77-112`)

35 commands in `generate_handler!`. Telemetry-relevant subset below with exact signatures. Remainder (config/windows/registry) listed in §1.4 as out-of-hot-path.

### 1.1 Archives — `src-tauri/src/commands/archives.rs`

| Command | Signature | Mode | Frontend caller (`fsUtils.js`) |
|---|---|---|---|
| `get_ico_frames` | `pub fn get_ico_frames(path: String) -> Result<String, String>` | `#[tauri::command(async)]`, `fs::read` + `ico_frames_from_bytes` | `FsUtils.buildFileSrc:232-242` — only when `isIco(filePath)`; returns data-URL spritesheet, else falls through to `convertFileSrc` |
| `list_archive` | `pub fn list_archive(archive_path: String, password: Option<String>, state: State<'_, RwLock<ArchiveCache>>) -> Result<ArchiveReadResult, String>` → `cache.prepare_archive(path, password)` | `async` (tokio `spawn_blocking`) | `checkArchiveEncryption:130` (`{archivePath, password:null}`), `loadArchive:502` (`{archivePath, password}`) |
| `drop_archive_cache` | `pub fn drop_archive_cache(archive_path: String, state: State<'_, RwLock<ArchiveCache>>) -> Result<(), String>` → `cache.drop_archive` | `async` | `refresh:920` (`{archivePath}`) before reload |
| `drop_all_archives_cache` | `pub fn drop_all_archives_cache(state: State<'_, RwLock<ArchiveCache>>) -> Result<(), String>` → `cache.drop_all_archives` | `async` | No `fsUtils.js` caller (exit path in `lib.rs:139` calls `drop_all_archives` directly) |
| `prefetch_archive_entries` | `pub fn prefetch_archive_entries(archive_path: String, entries: Vec<String>, state: State<'_, RwLock<ArchiveCache>>) -> Result<(), String>` — early `Ok(())` unless ext is `zip`/`cbz`; else loops `cache.read_entry_bytes` (result discarded with `let _ =`) | `async` | `prefetchAhead:993` (`{archivePath, entries: indicesToPrefetch}`), 75 ms debounce, symmetric window §3.4 |
| `get_archive_ico_frames` | `pub fn get_archive_ico_frames(archive_path: String, entry_name: String, state: State<'_, RwLock<ArchiveCache>>) -> Result<String, String>` → `read_entry_bytes(...)?` → `wait_for_data(&entry_name)?` → `ico_frames_from_bytes` | `async` | `buildArchiveEntrySrc:221-230` — only when `isIco(entryName)` |
| `resolve_archive_temp_origin` | `pub fn resolve_archive_temp_origin(path: String, state: State<'_, RwLock<ArchiveCache>>) -> Result<Option<TempArchiveOrigin>, String>` → `platform::temp_archive::resolve_temp_origin` | `async` | `loadFile:726` (`{path}`) when non-archive path matches `/temp/` or `AppData/Local/Temp/` |

### 1.2 Directory / filesystem — `src-tauri/src/commands/directory.rs`

| Command / helper | Signature |
|---|---|
| `read_directory_impl` (not IPC, helper) | `pub fn read_directory_impl(path: &str, show_hidden: bool, target_name_override: Option<&str>) -> Result<DirectoryReadResult, String>` — `fs::read_dir`, filters to `is_image_ext \|\| is_archive_ext` + dirs, `is_hidden_path`, `natord::compare` sort, `initial_index`, `parent_directory` (`__DRIVES__` sentinel at roots) |
| `read_directory` | `#[tauri::command(async)] pub fn read_directory(path: String, show_hidden: Option<bool>, target_name: Option<String>) -> Result<DirectoryReadResult, String>` — `show_hidden.unwrap_or(false)` |
| `get_drives` | `#[tauri::command] pub fn get_drives() -> Vec<String>` — sync, probes `A:\`–`Z:\` via `Path::exists` |
| `get_path_kind` | `#[tauri::command] pub fn get_path_kind(path: &str) -> String` — `"directory" \| "file" \| "missing"` |
| `read_text_file` | `#[tauri::command] pub fn read_text_file(path: String) -> Result<String, String>` |
| `write_text_file` | `#[tauri::command] pub fn write_text_file(path: String, content: String) -> Result<(), String>` |

Frontend `read_directory` call sites (`fsUtils.js`): `loadFile:743` (`{path, showHidden, targetName}`), `openParent:764,789`, `openSibling:822`, `refresh:929`. `get_drives`: `loadFile:695` (`__DRIVES__` virtual path), `openSibling:818`. `pick_folder` (no args → `Option<String>`): `openDirectoryDialog:872`. `watch_directory` (`{path}`): `applyDirectoryResult:473` (fire-and-forget, warn on fail).

### 1.3 Adjacent commands on the image hot path

| Command | File:line | Signature |
|---|---|---|
| `check_is_animated` | `commands/animation.rs:9` | `pub fn check_is_animated(path: String, archive_path: Option<String>, state: State<'_, RwLock<ArchiveCache>>) -> Result<AnimationInfo, String>` — disk: open + read up to 256 KiB (`262_144`); archive: `cache.read_entry_header(path, 262_144)` under write lock → `formats::check_animation_status(&header)`. Caller: `Core.checkIsAnimated` (`core.js:325`), memoized in `_animMemo`; `fsUtils.js:438,612` |
| `get_native_icon` | `commands/registry.rs:8` | `#[tauri::command(async)] pub fn get_native_icon(path: String, ext_key: String, size: Option<String>) -> Result<Option<String>, String>` → `platform::icons::get_cached_native_icon` (data-URL). Legacy IPC path; hot thumbnail path now uses `quivit://icon/` protocol instead. Caller: `filePanel.js:424` |
| `watch_directory` | `commands/watchers.rs:24` | `#[tauri::command] pub fn watch_directory(app: AppHandle, path: String) -> Result<(), String>` — replaces `watcher` + `parent_watcher` (`notify`, `NonRecursive`), emits `directory-changed`; parent watcher emits only after `child_path` disappears. Sync (not `async`) — blocks IPC thread briefly on watcher setup |
| `open_in_explorer` | `commands/shell.rs:2` | `pub fn open_in_explorer(path: &str) -> Result<(), String>` — `explorer <path>` or `ShellExecuteW("open")` for `ms-settings:` |
| `get_default_dir` | `commands/shell.rs:48` | `pub fn get_default_dir() -> String` — `%USERPROFILE%\Pictures` or `""` |
| `get_initial_args` | `commands/shell.rs:59` | `pub fn get_initial_args() -> Vec<String>` |
| `pick_folder` | `commands/shell.rs:64` | `pub fn pick_folder(window: Window) -> Result<Option<String>, String>` — `platform::dialog::pick_folder(hwnd)` |

### 1.4 Registered but off the image hot path (for completeness)

`load_config`, `get_config_dir`, `open_config_dir`, `get_local_data_dir`, `open_local_data_dir`, `save_config`, `open_options`, `fit_options_window`, `open_metadata_window`, `fit_metadata_window`, `get_format_status` (`registry.rs:17` → `Vec<FormatStatus>`), `register_associations`, `unregister_associations`, `show_window`, `update_theme`. No per-image telemetry needed; `save_config` volume matters only for options-path noise.

---

## 2. Custom protocol routes

Handler: `register_quivit_protocol<R: Runtime>(builder: Builder<R>) -> Builder<R>` (`protocol.rs:9`), via `builder.register_asynchronous_uri_scheme_protocol("quivit", closure)`. Dispatch order inside closure is **`/icon/` → `/thumb/` → `/archive/`** (substring `url.contains(...)` checks, `protocol.rs:20,48,75`). Range header is captured once up front (`protocol.rs:14-18`).

Base URL construction (`fsUtils.js:145-166`): Windows → `http://quivit.localhost/...`; non-Windows → `quivit://localhost/...`. Encoding: `_base64Encode` = UTF-8 → base64url **no padding** (`+/` → `-_`, strip `=`); archive entry name additionally `encodeURIComponent`. Decoding backend: `utils::base64_decode` (must accept no-pad url-safe) for paths; `utils::url_decode` for entry names after stripping `?...` query.

### 2.1 `quivit://archive/<b64_archive_path>/<urlenc_entry_name>`

- Parser: `parse_archive_url(url: &str) -> Result<(String, String), String>` (`protocol.rs:156`). Splits on `/archive/`, then first `/`; entry part strips query (`split('?').next()`).
- Builder: `FsUtils.buildArchiveSrc(archivePath, entryName)` (`fsUtils.js:145-150`); archive-mode thumb alias `buildThumbnailSrc:196-198`; neighbor preload `neighborEntries:299`.
- Response: `entry_response(entry_name, data, range_header)` (`protocol.rs:203`). MIME via `guess_mime` (jpg/jpeg, png, gif, webp, svg, bmp, ico→`image/x-icon`, avif, apng; else `application/octet-stream`). Full: `200` + `Accept-Ranges: bytes` + `Content-Length` + `Cache-Control: no-store` + `Access-Control-Allow-Origin: *`. Ranged: `206` + `Content-Range: bytes s-e/total` + sliced body. Range parser: `parse_byte_range(header: &str, total_len: usize) -> Option<ByteRange>` (`protocol.rs:242`) — supports `bytes=s-e`, `bytes=s-`, `bytes=-suffix`; clamps `end` to `total-1`; `None` on `total==0`, bad prefix, `start>=total`, `start>end`, `suffix==0` → falls back to `200`.
- `asset://` contrast: Tauri built-in `convertFileSrc(filePath)` (`fsUtils.js:241,248` → `http://asset.localhost/...` on Windows). Used for **disk** images (`buildFileSrc/Sync`, `buildThumbnailSrc:204` for non-`SHELL_THUMBNAIL_EXTS`, `neighborEntries:303`). `isConstrainedThumbnailSrc:183-187` classifies `/archive/` + `asset.localhost`/`asset://` as heavy (viewport-queued); `/thumb/` + `/icon/` as light. Disk ICO excluded from neighbor preload (`:303` returns `null` — viewer uses data-URL spritesheet).

### 2.2 `quivit://thumb/<b64_path>` — shell thumbnail, 96 px

- Parser: `parse_thumb_url(url: &str) -> Result<String, String>` (`protocol.rs:148`), strips query.
- Builder: `FsUtils.buildShellThumbnailSrc(path)` (`fsUtils.js:161-166`); chosen in `buildThumbnailSrc:200-203` when `_ext ∈ SHELL_THUMBNAIL_EXTS` (`jpg jpeg png bmp dib gif ico`, `fsUtils.js:15`).
- Backend: `spawn_blocking(|| platform::thumbnails::get_shell_thumbnail_png(&path, 96))` (`protocol.rs:61-71`). Signature `pub fn get_shell_thumbnail_png(path: &str, size: u32) -> Result<Option<Vec<u8>>, String>` — `Ok(None)` for unsupported ext / missing file / animated GIF (falls back to `asset://` so animation plays, `thumbnails.rs:106-112`) / no OS thumbnail; `Err` only on COM init failure. Response: `png_response` (`200`, `image/png`, `Cache-Control: public, max-age=86400`, CORS `*`).

### 2.3 `quivit://icon/<b64_path>/<b64_ext_key>[?size=large]`

- Parser: `parse_icon_url(url: &str) -> Result<(String, String, IconSize), String>` (`protocol.rs:120`). Splits on `/icon/`, then first `/`; `?size=large` or `?size=32` → `IconSize::Large`, else `Small` (backward compat: no query → Small).
- Builder: `FsUtils.buildNativeIconSrc(path, extKey, size)` (`fsUtils.js:152-159`); `getIconExtKey:168-179` (`is_drive`→path; dirs/`..`→path only for Downloads/Pictures/Documents/Music/Videos/Desktop else `__folder__`; files→`ext` lowercase); `_isPathSpecificIcon:217` (contains `\`/`/`/`:` → pass real `item.path`, else `''`). `buildThumbnailSrc:207-209` requests `size='large'` (32 px) for non-image rows.
- Backend: `spawn_blocking(|| platform::icons::get_cached_native_icon_png_with_size(&path, &ext_key, size))` (`protocol.rs:33-45`). Signature `pub fn get_cached_native_icon_png_with_size(path: &str, ext_key: &str, size: IconSize) -> Result<Option<Vec<u8>>, String>` (`icons.rs:148`), `enum IconSize { Small, Large }` (`icons.rs:116`). In-memory `NATIVE_ICON_CACHE: HashMap<cache_key, png>` (`icons.rs:165-173`; key = `ext` or `large:ext`). Real-path SHGFI lookup only when ext contains path chars or `__folder__` special-cased; else dummy filename + `SHGFI_USEFILEATTRIBUTES` (no fs access). Response `png_response` (same cacheable headers as thumb).

---

## 3. Cache hit vs miss paths

### 3.1 `quivit://archive/` — fast path vs blocking path (`protocol.rs:87-116`)

```
request → parse_archive_url (400 on Err)
  → try_cached_entry_response (try_read lock; cached_zip_entry_bytes)
      HIT  → entry_response → responder.respond (no thread hop, no decompression)
      MISS → spawn_blocking:
               state.write() → cache.read_entry_bytes → wait_for_data(entry) (≤30 s)
               → Ok  → entry_response (200/206)
               → Err → 404 "Entry not found or failed to extract"
```

- Hit function: `try_cached_entry_response<R: Runtime>(app_handle, archive_path, entry_name, range_header) -> Option<Response<Vec<u8>>>` (`protocol.rs:177`). Uses `try_read()` — returns `None` (→ miss path) rather than blocking if the write lock is held. Then `cached_zip_entry_bytes` (`mod.rs:198`): non-ZIP kinds → `Ok(None)` always (RAR/7z/TAR never hit this path); ZIP → `get_zip_entry` (`cache.rs:277`, touches LRU on hit).
- Miss function chain: `read_entry_bytes(&mut self, archive_path, entry_name) -> Result<ArchiveEntryData, String>` (`mod.rs:183`) → ZIP: `read_zip_entry_bytes` (`mod.rs:357`); RAR/7z/TAR: `read_temp_entry_bytes` (`mod.rs:384`).

### 3.2 ZIP entry cache (`cache.rs`)

- State: `SingleArchiveCache { zip_entries: HashMap<String, SharedEntryBytes /* Arc<[u8]> */>, zip_archive: Option<ZipArchive>, zip_index_map, ... }`; global `ArchiveCache { archives: HashMap<String, Single>, lru: Mutex<ArchiveLruState { global_zip_lru: VecDeque<(String,String)>, archive_lru: VecDeque<String>, current_zip_bytes: usize }>, global_zip_capacity_bytes, max_open_archives }`. Limits: `MAX_OPEN_ARCHIVES = 2` (`cache.rs:6`); byte budget `capacity_mb * 1024*1024` (`cache.rs:110`).
- `read_zip_entry_bytes` (`mod.rs:357`): (1) password-gate → Err; (2) `get_zip_entry` hit → return; (3) `prepare_archive_state(Zip,...)` touch-or-reopen; (4) `read_from_open_zip` (kept-open `ZipArchive` + `read_zip_entry_by_decoded_name` with index_map fast path) → else `extract_zip_entry` (re-open file from disk); (5) `insert_zip_entry` (budget eviction `evict_until_within_budget`, LRU touch). Miss cost = one entry inflate (deflate/store) + one HashMap insert; no temp files.
- Eviction: `evict_idle_archives` (keep only 2 most-touched archives, `cache.rs:203`); `evict_until_within_budget` (pop oldest `(archive,entry)` until `current + incoming ≤ budget`, `cache.rs:221`). `prepare_archive_state` (`mod.rs:307`): archive known + no new password → `touch_archive` + return (cheap); known + new password → `drop_archive` + rebuild.

### 3.3 RAR / 7z / TAR — temp-disk cache + 30 s condvar (`mod.rs:384-407,410-428`)

- `read_temp_entry_bytes`: password-gate → `prepare_archive_state(kind,...)` (spawns `spawn_temp_extractor` thread on first prepare: `rar::extract_rar_to_temp` / `sevenz::extract_7z_to_temp` / `tar::extract_tar_to_temp` → `%TEMP%\QuiviT\pid-<pid>\<md5(archive_path)>\`, `cache.rs:362-365`) → `temp_extraction_state` → `archive_entry_temp_path` (`None` → `Err "Unsafe archive entry path"`) → `fs::read(file_path)` hit → `Ready(bytes)`; else `PendingExtraction { file_path, notify }`.
- `ArchiveEntryData::wait_for_data(self, entry_name) -> Result<Vec<u8>, String>` (`mod.rs:77`): `Ready` → clone; `PendingExtraction` → condvar loop on `ExtractState { extracted: HashSet<String>, finished: bool }` with **30 s timeout** → then `fs::read(file_path)` or `Err "...not available or extraction finished"`. `read_temp_entry_header` (`mod.rs:254`) duplicates this wait inline, then reads only `limit` bytes (256 KiB for animation checks).
- Frontend consequence: first view of a RAR/7z entry pays **sequential full-extraction latency** (background thread extracts in archive order; `wait_for_data` blocks the protocol `spawn_blocking` slot until this entry's turn or 30 s timeout → `404`).

### 3.4 Frontend caches (`fsUtils.js`)

- `_unlockedArchivePasswords: BoundedMap(50)` + `_archiveEncryptionCache: BoundedMap(100)` (`:27-28`). `checkArchiveEncryption:123-139` short-circuits (`unlocked → null`; `encryptionCache.has → get`) before `invoke('list_archive')`; `loadArchive:505-511` maintains both on `password_incorrect` / success. `refresh:917` deletes encryption entry + `drop_archive_cache` to force re-list.
- Prefetch: `prefetchAhead(archivePath, currentIndex, direction)` (`:959`) — symmetric `PREFETCH_HALF = 7` ahead+behind image entries only; `++_archivePrefetchSeq` + `clearTimeout`; 75 ms debounce; drops stale if `seq/mode/archivePath/index` changed; `invoke('prefetch_archive_entries', {archivePath, entries})`. Backend no-ops for non-ZIP (`archives.rs:49-52`) and swallows per-entry errors — prefetch never rejects.
- Blob dedupe (implemented per legacy reports, lives in `filePanel.js`/`viewerRender.js`, not `fsUtils.js`): `ensureArchiveBlob` — one `fetch(quivit://archive/...)→blob→objectURL` per src shared by thumb/hover/viewer; archive-only (`isConstrainedThumbnailSrc` gate). Disk `asset://` never deduped.

---

## 4. Disk decompression latencies — where time actually goes

| Stage | Code | Cost model |
|---|---|---|
| Open ZIP central directory | `zip::open_zip_archive` (`zip.rs:63`) per `list_zip_entries` / `extract_zip_entry` fallback | 1× file open + CD parse; kept-open `zip_archive` in cache avoids repeat for `read_from_open_zip` hits |
| Inflate one ZIP entry | `read_zip_entry_by_decoded_name` (`zip.rs:233`): index_map hit → `by_index` direct; else `by_name`/`by_name_decrypt`; else **O(n) scan** decoding every name (`decode_zip_entry_name`, CJK-aware) | Fast path ≈ inflate only. Slow path (no index_map, e.g. `extract_zip_entry` reopen) can scan + decode all names — the dominant ZIP miss cost on large CBZ |
| Header-only sniff | `read_zip_entry_header(..., limit)` (`zip.rs:280`) — `take(limit)` streaming | 256 KiB max for `check_is_animated`; cheap even on miss |
| RAR/7z/TAR full extract | `spawn_temp_extractor` (`mod.rs:410`) → `extract_*_to_temp` background thread, sequential to `%TEMP%` | Latency = position-in-archive × per-entry decompress + disk write; solid 7z/RAR worst case. `wait_for_data` 30 s cap converts tail into `404` |
| Temp-file read | `fs::read(file_path)` after condvar wake (`mod.rs:104,402`) | Full entry bytes re-read from disk per request (no RAM cache for non-ZIP) — repeated views re-pay disk read but not decompression once extracted |
| Shell icon/thumb | `SHGetFileInfoW` / shell thumbnail COM (`icons.rs`, `thumbnails.rs`) + `NATIVE_ICON_CACHE` RAM hit | Miss = COM round-trip; animated-GIF sniff adds a 256 KiB disk read (`thumbnails.rs:107-109`) |
| Directory list | `read_directory_impl` (`directory.rs:8`) — `read_dir` + per-entry `metadata()` + `modified()` + image/archive filter + `natord` sort | Linear in dir size; `metadata()` syscalls dominate on HDD/network drives |
| Range slicing | `entry_response` (`protocol.rs:203`) — `data[s..=e].to_vec()` | One copy of the served slice; full-file path copies whole entry (`body(data.to_vec())`) |

---

## 5. Error states (exact strings / codes)

### Backend protocol (`protocol.rs`)

| Site | Condition | Response |
|---|---|---|
| `:21-31` | `parse_icon_url` Err (not `/icon/`, missing part, bad b64 path/ext) | `400` + message (`"Invalid quivit icon URL: …"`, `"Missing icon path or extension key"`, `"Invalid base64 …"`) |
| `:49-59` | `parse_thumb_url` Err | `400` + message |
| `:75-85` | `parse_archive_url` Err (not `/archive/`, missing part, bad b64) | `400` + `"Invalid quivit URL: …"` / `"Missing archive path or entry name"` / `"Invalid base64 archive path"` |
| `:37-41` | `get_cached_native_icon_png_with_size` → `Err` or `Ok(None)` (non-Windows always `None`) | `404 "Icon not found"` |
| `:64-68` | `get_shell_thumbnail_png` → `Err` or `Ok(None)` (unsupported ext, missing file, animated GIF, no OS thumb) | `404 "Thumbnail not found"` |
| `:107-115` | `read_entry_bytes` Err or `wait_for_data` Err (missing entry, password-gated, unsafe path, 30 s timeout, temp read fail) | `404 "Entry not found or failed to extract"` (timeout and not-found are indistinguishable here) |

### IPC `Err(String)` payloads (surfaced as JS rejection → UI banners)

- `"Path does not exist"` (`directory.rs:15`); fs errors verbatim (`read_text_file`, `write_text_file`, `watch_directory: "Failed to create/watch …"`).
- Archives: `"Unsupported archive format: {ext}"` (`mod.rs:48`); `"Archive is password-protected: …"` (all `read_*` gates); `"Cannot find ZIP entry: {name}"`; `"Cannot read extracted archive entry {name}: {e}"`; `"Archive entry {name} not available or extraction finished"` (timeout); `"Unsafe archive entry path"`; `"Archive is not prepared for temporary extraction"`; `"Cannot read ICO file: {e}"`.
- Animation: `"Cannot open file: …"` (disk).
- Frontend mapping (`fsUtils.js`): `loadArchive:523-547` password-gated → lock label (`Password required:` / `Password incorrect!`) with empty `src`; `:638-648` other errors → `Failed to open archive: <basename>` (startup → `loadFallbackAncestor` walk-up to `__DRIVES__`); `cleanEntryName:67-70` strips those prefixes for index matching. `openSibling:851-861` retries with `suppressErrorState:true`, skipping broken siblings silently.

---

## 6. Surgical hook points for diagnostic telemetry (H1–H12)

Conventions: `t0 = Instant::now()` at hook entry; log `{route, archive_kind, entry_bytes, hit:bool, elapsed_ms, err:?}`. Prefer `eprintln!`/tracing behind a `cfg(feature)` or env-gated macro so release stays quiet. Frontend: `performance.now()` deltas + `console.debug` behind a flag; never in the 75 ms prefetch debounce path itself.

- **H1 — protocol ingress** (`protocol.rs:12-18`, closure top): single place seeing every `quivit://` fetch. Record `{url_len, route: icon|thumb|archive, has_range}` + `t0`. Correlate with H2/H3 by passing `t0` into the `spawn_blocking` move closures (all three routes).
- **H2 — archive cache hit/miss counter** (`protocol.rs:88-96` + `try_cached_entry_response:177-190`): log `hit=true, elapsed=t0→respond` on `Some`; `hit=false` on `None`. Note `try_read` failure counts as miss — tag it separately (`lock_busy:true`) to distinguish contention from cold cache.
- **H3 — miss decompression timer** (`protocol.rs:98-116`, `spawn_blocking` body): wrap `read_entry_bytes` and `wait_for_data` as two spans: `decompress_ms` (lock + `read_entry_bytes` returning `Ready|Pending`) and `wait_ms` (condvar block). Emit `entry_bytes` from `entry_response`. This is the primary disk-latency signal per format.
- **H4 — temp-extraction wait breakdown** (`archives/mod.rs:77-114` `wait_for_data` + `:254-305` `read_temp_entry_header` inline duplicate): log `{entry_name, waited_ms, timed_out:bool, finished:bool}`. Both copies must be instrumented identically (or dedupe first — currently intentionally duplicated per comment `:270`).
- **H5 — parse-failure sampler** (`parse_icon_url:120`, `parse_thumb_url:148`, `parse_archive_url:156` Err arms + the three `400` responders): count by `{route, reason}`. Frontend URL-encoding regressions show up here, not in H3.
- **H6 — range-request split** (`entry_response:203`, `parse_byte_range:242`): count `{full_200, ranged_206, range_ignored}` + `slice_bytes`. Validates video/seek-style clients vs full re-fetch regressions.
- **H7 — shell icon/thumb latency + `None` reasons** (`protocol.rs:33-45,61-71`; `icons.rs:148-173` cache check; `thumbnails.rs:84-112` early-`None` gates): spans for `cache_hit` (RAM), `com_call`, plus `none_reason ∈ {unsupported_ext, missing, animated_gif, no_os_thumb, non_windows}`. Distinguishes "slow COM" from "always-404 ext".
- **H8 — `list_archive` duration + encryption outcome** (`commands/archives.rs:14-22` + `mod.rs:117-181` per-kind branch): log `{kind: zip|rar|7z|tar, entry_count, encryption, elapsed_ms}`. Frontend `checkArchiveEncryption` (`fsUtils.js:123-139`) calls this with `password:null` purely to probe — tag probes vs real opens via `password.is_some()`.
- **H9 — prefetch batch observer** (`commands/archives.rs:43-60` + `fsUtils.js:959-999`): frontend logs `{requested: entries.length, debounced:bool}`; backend logs `{processed, skipped_non_zip:bool}`. Per-entry errors are swallowed (`let _ =`) — count successes via `insert_zip_entry` calls if needed, not via return value.
- **H10 — `read_directory` volume timer** (`commands/directory.rs:142-149` + `read_directory_impl:8-140`): log `{file_count, show_hidden, elapsed_ms}`. Slow-HDD/network-drive diagnosis; `get_drives` (`:152`, sync A–Z probe) gets its own cheap span.
- **H11 — `check_is_animated` header cost** (`commands/animation.rs:9-27`): log `{via: disk|archive, bytes_read (≤262144), elapsed_ms}`. Archive path takes the cache **write** lock — contention with H3 shows up as correlated stalls.
- **H12 — frontend invoke wrapper timing + generation discards** (`fsUtils.js`: `_nextNavigationGeneration:30`, `_isCurrentGeneration:35`, every `await invoke` in `loadArchive/loadFile/applyDirectoryResult/refresh`): wrap invokes with `{cmd, elapsed_ms, generation, discarded: !_isCurrentGeneration(gen)}`. Discarded-but-slow responses (rapid navigation) are the main source of "phantom latency" invisible to backend-only telemetry.

Minimal-risk insertion order for a first slice: H1+H2 (1 span, 1 counter) → H3 (the latency number this report exists to capture) → H8+H10 (open/list costs) → rest as needed.
