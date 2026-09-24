# Extractor import time optimizations plan

> Validation comparison performed: this implementation plan was compared against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md` before presentation.

**Target:** branch `refactor/extractor-polish`, plus `extractors/` worktree on branch `extractors`.
**Scope source:** clipboard audit brief and `.agents/user-notes` line 90: per-extractor import time optimizations for existing extractors.
**Summary:** Optimize import latency across all site extractors and the `urlLoader.js` extraction bridge. Remove unnecessary remote HTML page fetches for API-driven providers (MangaDex, MANGA Plus), replace unconditional sleep delays with adaptive inter-request throttlers in shared clients, parallelize independent API requests in MangaDex chapter, series, and art extraction, and preserve strict early-break stop rules in K MANGA candidate checks.

## Lock definitions and deviation rules

1. **Output contract stability.** Every extractor must produce identical output data shapes (`gallery`, `images`, `metadata`, `chapters`, `folders`). Relative folder paths, ComicInfo XML/JSON fields, image filenames, and destination directories must not change.
2. **Offline cache contract.** Extractor scripts are cached under `%LOCALAPPDATA%/QuiviT/extractor-cache/`. Any modification to an extractor script or its dependencies under `extractors/shared/` requires bumping its integer `version` in `extractors/manifest.json`.
3. **No DOM imports in pure modules.** Extractor scripts and shared helpers under `extractors/` must remain pure JavaScript without DOM queries, global `window` mutations, or node additions.
4. **Boundary rules.** Changes in `src/js/urlLoader.js` must preserve backward compatibility for third-party or future extractors that omit optional flags. Default behavior when a flag is absent must match current behavior.

## Bottleneck inventory

### 1. Loader bridge (`src/js/urlLoader.js`)

- **B1. Unconditional HTML fetch on gallery and series imports (`urlLoader.js:1868`):**
  `const html = url.startsWith('blob:') ? '' : await fetchRemoteText(url);`
  Every URL import fetches the full HTML page over HTTP before calling `extractGallery()`. MangaDex is a client-side SPA where metadata is fetched via `api.mangadex.org`, and MANGA Plus uses Protobuf APIs over `jumpg-webapi.tokyo-cdn.com`. Neither extractor uses the HTML page. This wastes 200ms to 800ms of network latency per import.
- **B2. Unconditional HTML fetch on stub gallery resolution (`urlLoader.js:2474`):**
  `pageHtml = await fetchRemoteText(data.sourceUrl);`
  When opening an unresolved chapter stub, `resolveUnresolvedGallery()` fetches the chapter's HTML page before delegating to `extractGallery()`. For MANGA Plus and MangaDex chapter stubs, this fetch is unused and adds latency before first chapter paint.
- **Fix:** Allow extractors to export `needsHtml: false` (or a function `needsHtml(url)`). When false, `urlLoader.js` skips `fetchRemoteText` and passes an empty string `''` to `extract()`.

### 2. MANGA Plus (`extractors/mangaplus.js`, `extractors/shared/mangaplus.js`)

- **B3. Artificial pre-request sleep (`shared/mangaplus.js:166, 195`):**
  `await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));` with `RATE_LIMIT_MS = 500`.
  Both `fetchMangaPlusChapter` and `fetchMangaTitleDetail` unconditionally slept 500ms *before* making their network request. On a chapter import, both functions ran sequentially, wasting an enforced 1,000ms pause in `setTimeout` loops even when no previous request was made.
- **Fix:** Replaced static pre-sleep with an adaptive inter-request throttler (`lastMangaPlusRequestTime`). If elapsed time since the previous request to the API host is greater than or equal to `RATE_LIMIT_MS`, dispatch immediately with 0ms delay. If called sooner, sleep only the remaining delta.
- **B4. Opt out of HTML:** Exported `needsHtml = false` in `extractors/mangaplus.js`.

### 3. MangaDex (`extractors/mangadex.js`)

- **B5. Sequential API requests during chapter extraction (`mangadex.js:390-475`):**
  Chapter extraction executed three sequential network round-trips:
  1. `await context.fetchText(chapterApiUrl)` (`/chapter/${chapterId}`)
  2. `await context.fetchText(mangaApiUrl)` (`/manga/${mangaId}`)
  3. `await context.fetchText(atHomeUrl)` (`/at-home/server/${chapterId}`)
  Notice `atHomeUrl` only requires `chapterId`, which is already known from the chapter URL. It does not depend on `chapterApiUrl` or `mangaApiUrl`.
- **Fix:** Fetch `chapterApiUrl` and `atHomeUrl` concurrently using `Promise.all`. If `externalUrl` is detected, the at-home result is discarded. For standard chapters, this removes an entire network round-trip (~200ms to 500ms).
- **B6. Sequential feed passes during series extraction (`mangadex.js:611-617`):**
  `for (const extraParams of ['', '&includeExternalUrl=1'])` ran `await pullFeedPages(extraParams)` serially.
  The hosted feed and external URL feed are disjoint, independent queries to `api.mangadex.org`.
- **Fix:** Execute `Promise.all([pullFeedPages(''), pullFeedPages('&includeExternalUrl=1')])` concurrently. Additionally, run `context.fetchText(mangaUrl)` concurrently with feed collection.
- **B7. Sequential requests during cover gallery extraction (`mangadex.js:752-785`):**
  `extractArt` fetched `mangaUrl` and awaited it before fetching the first page of `coversApiUrl`. Both only require `mangaId`.
- **Fix:** Run `mangaUrl` fetch and the first covers page fetch in parallel via `Promise.all`.
- **B8. Opt out of HTML:** Exported `needsHtml = false` in `extractors/mangadex.js`.

### 4. K MANGA (`extractors/kmanga.js`, `extractors/shared/kmanga.js`)

- **B9. Artificial pre-request sleep (`shared/kmanga.js:92, 157`):**
  `await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));` with `RATE_LIMIT_MS = 300`.
  Both `fetchViewerPages` and `fetchEpisodeDetail` unconditionally slept 300ms before making requests. On single episode import, the user sat through 300ms of artificial wait time.
- **Fix:** Replaced static pre-sleep with adaptive inter-request throttling (`lastKmangaRequestTime`). The first request executes immediately. Subsequent requests space out at 300ms, preserving the exact early-break non-free episode stop contract.

### 5. Imgur (`extractors/imgur.js`) & Direct (`extractors/direct.js`)

- **Imgur:** Imgur requires HTML because album data is embedded in `<script>` tags on the page. Leave `needsHtml` default (`true`). Direct URLs already route via `isDirectUrl` without HTML fetch.
- **Direct:** Uses 1KB HTTP range request for document sniffing. Keep for safety.

---

## Ordered checklist

### Slice 1: Loader bridge HTML opt-out

- [x] [`src/js/urlLoader.js:1876`](file:///E:/Projects/QuiviT/src/js/urlLoader.js#L1876): Check `mod.needsHtml`. When `mod.needsHtml === false` (or `typeof mod.needsHtml === 'function' && !mod.needsHtml(url)`), skip `fetchRemoteText(url)` and set `html = ''`.
- [x] [`src/js/urlLoader.js:2483`](file:///E:/Projects/QuiviT/src/js/urlLoader.js#L2483): In `resolveUnresolvedGallery`, skip `fetchRemoteText(data.sourceUrl)` when `mod.needsHtml === false` (or returns false).
- [x] **Acceptance criteria:** Unit tests pass (`npm test`). When `needsHtml: false` is exported, `fetchRemoteText` is not called for that URL during import or stub resolution.

### Slice 2: MANGA Plus optimizations

- [x] [`extractors/shared/mangaplus.js:14-22`](file:///E:/Projects/QuiviT/extractors/shared/mangaplus.js#L14-L22): Implement adaptive rate-limit throttle helper using timestamp delta (`Date.now() - lastRequestTime`). Replace unconditional `setTimeout(r, RATE_LIMIT_MS)` in `fetchMangaPlusChapter` and `fetchMangaTitleDetail`. First call has zero sleep delay.
- [x] [`extractors/mangaplus.js:43`](file:///E:/Projects/QuiviT/extractors/mangaplus.js#L43): Export `export const needsHtml = false;`.
- [x] [`extractors/manifest.json:32`](file:///E:/Projects/QuiviT/extractors/manifest.json#L32): Bump MANGA Plus version from 3 to 4.
- [x] **Acceptance criteria:** MANGA Plus chapter and series extraction return identical outputs. `npm test` passes. First request executes without pre-sleep delay.

### Slice 3: MangaDex optimizations

- [x] [`extractors/mangadex.js:345`](file:///E:/Projects/QuiviT/extractors/mangadex.js#L345): Export `export const needsHtml = false;`.
- [x] [`extractors/mangadex.js:390-460`](file:///E:/Projects/QuiviT/extractors/mangadex.js#L390-L460): In `extract()`, initiate `chapterApiUrl` and `atHomeUrl` concurrently using `Promise.all`. Await both before image mapping. Discard at-home result if chapter has `externalUrl`.
- [x] [`extractors/mangadex.js:540-620`](file:///E:/Projects/QuiviT/extractors/mangadex.js#L540-L620): In `extractTitle()`, fetch `mangaUrl` concurrently with feed initialization. In feed collection, execute `Promise.all([pullFeedPages(''), pullFeedPages('&includeExternalUrl=1')])` concurrently instead of sequentially.
- [x] [`extractors/mangadex.js:766-800`](file:///E:/Projects/QuiviT/extractors/mangadex.js#L766-L800): In `extractArt()`, fetch `mangaUrl` and the initial covers page (offset 0) concurrently via `Promise.all`.
- [x] [`extractors/manifest.json:19`](file:///E:/Projects/QuiviT/extractors/manifest.json#L19): Bump MangaDex version from 8 to 9.
- [x] **Acceptance criteria:** MangaDex chapter, series, and cover extraction produce identical output structures. `npm test` passes. Chapter extraction time drops by at least one network round-trip.

### Slice 4: K MANGA optimizations

- [x] [`extractors/shared/kmanga.js:14-22`](file:///E:/Projects/QuiviT/extractors/shared/kmanga.js#L14-L22): Implement adaptive rate-limit throttle helper using timestamp delta. Replace unconditional `setTimeout(r, RATE_LIMIT_MS)` in `fetchViewerPages` and `fetchEpisodeDetail`. First call has zero sleep delay.
- [x] [`extractors/manifest.json:44`](file:///E:/Projects/QuiviT/extractors/manifest.json#L44): Bump K MANGA version from 4 to 5.
- [x] **Acceptance criteria:** K MANGA episode and series extraction produce identical structures. Unit test execution time for K MANGA tests drops noticeably (eliminating ~300ms delays per test case). `npm test` passes.

### Slice 5: Verification and regression check

- [x] Run `npm test` to verify all 199 frontend unit tests pass.
- [x] Validate syntax across modified files using `node --check src/js/urlLoader.js`, `node --check extractors/mangadex.js`, `node --check extractors/mangaplus.js`, `node --check extractors/kmanga.js`.
- [x] Run targeted blast-radius checks: `cargo check --tests --manifest-path src-tauri/Cargo.toml`.
- [x] **Acceptance criteria:** All tests pass with zero regressions; manifest version numbers match bumped module versions.
