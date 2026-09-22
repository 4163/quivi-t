# URL layer contract

Validation comparison against `.agents/skills/validate-changes/SKILL.md` performed. This is a design doc, no code changed.

It sets the rules for cover clearing and jumping so future extractor work never needs core changes unless the contract itself changes. Part 1 describes what the code does today, read from the tree, not from memory. Part 2 maps the new contract onto it with the smallest possible delta.

## Terms

These are the user's definitions, used everywhere below.

- Layer is any URL the importer handles. Direct images, chapters, volumes, titles. The word covers all of them.
- Freely defined means within generic filesystem validity. Depth, folder shape, and names differ per provider. Core enforces only what the filesystem needs.
- Cleared means deleted, file plus its sidecar records.
- Jump means QuiviT opens a directory in the file list and highlights a file.
- Core assigns no semantic meaning to a layer based on depth, name, or position. Cover, chapter, and title are extractor words. Core sees folders, files, and sidecars.

## Part 1. What the architecture does today

### Entry and loading

`loadUrl` at `src/js/urlLoader.js:1492` normalizes the URL, fetches the manifest fresh, finds the first entry whose patterns match (`findExtractor`, `src/js/urlLoader.js:635`), loads the module with its dependency graph rewritten to blob URLs (`loadExtractorModule`, `src/js/urlLoader.js:751`), checks `mod.match`, then hands off to `_loadUrlWithLibraryDir` (`src/js/urlLoader.js:1528`). Unknown `quivit-needs` tokens fail fast with an update message. Provider string must equal the manifest `name` (`validateExtractorResult`, `src/js/urlLoader.js:799`).

The manifest at `extractors/manifest.json` registers four entries: imgur v2, mangadex v5, mangaplus v2, kmanga v1 (`K MANGA`, committed as `extractors@a1dfeb8`). First pattern match wins across entries. The extractor branch README documents the module contract: required `match` and `extract`, optional `isDirectUrl` and `parseDirectUrl`, `quivit-deps` and `quivit-needs` headers, gallery versus series return shapes.

### Direct image path

`_loadUrlWithLibraryDir` at `src/js/urlLoader.js:1532` treats a URL as direct when the extractor says so or the path ends in a known image extension. It matches twice against everything already saved (`findMatchingGalleryImage`, `src/js/urlLoader.js:977`, called at `:1539` and `:1575`). A hit jumps straight to the saved file, filling a 0-byte placeholder eagerly first. A miss downloads to the provider root and records the file in the root `gallery.json` (`recordRootMediaDownload`, `src/js/urlLoader.js:1148`, called at `:1606`).

This is the path for both K MANGA CDN cases: the title art and the episode thumbnail each import today as a lonely top-level file. MangaDex cover and network URLs and MANGA Plus CDN URLs behave the same way, except those two resolve friendly filenames through an API call inside `parseDirectUrl`.

### Series and title path

`src/js/urlLoader.js:1627` writes the series root with its cover download, a series sidecar whose single image is marked Series Cover, per-tier folder metadata, and one stub sidecar per chapter (`unresolved: true`, empty images). Stubs for already resolved chapters are left alone. Metadata always refreshes. Cleanup runs, then the return target honors `open_first_image` (cover only when that setting is on).

This is the path for the MangaDex chapters tab and the K MANGA title URL. Depths differ freely: MangaDex stubs nest four deep (series, language, volume, chapter) while K MANGA stubs nest two deep (series, chapter). Core never interprets the tiers.

### Gallery and chapter path

`src/js/urlLoader.js:1770` follows `nextPageUrl` pagination with an identity guard, rejects empty results, then checks for an existing gallery by id or source URL (`findMatchingGalleryBySourceUrl`, `src/js/urlLoader.js:1056`). A known gallery updates additively: the fresh image list becomes authoritative, placeholders cover new files only, download status derives from bytes on disk. A new gallery writes its sidecar first, then metadata, intermediate markers, and placeholders, eager-downloads the `targetFilename` (or first image), prunes matching root files, and starts the background queue. MangaDex page-suffixed chapter URLs are the only current `targetFilename` producer.

### Matching and jump priority today

`_getGalleryMatchPriority` at `src/js/urlLoader.js:950` scores content images in art collections 100, content elsewhere 80, series covers in collections 50, standard series covers 10. A score of 100 returns immediately, otherwise the best score wins and ties fall to whatever breadth-first order found first, which is the provider root. That tie is the reported bug: a standalone K MANGA thumbnail and the episode's prepended `00.png` share one source URL, both score 80, and the root wins.

### Clearing today

`cleanupMatchingProviderEntries` at `src/js/urlLoader.js:1286` removes standalone chapter folders matching the series chapter ids or URLs, removes loose root cover files matching exact names, hashes, or URLs, prunes the root `gallery.json`, and for plain galleries delegates to `cleanupMatchingRawFiles` (`src/js/urlLoader.js:1104`), which deletes root files by stem or filename. The thumbnail case misses because the standalone filename and the chapter filename share no key today.

### Queue, resolve, and safety rails

The queue (`DownloadQueue`, `src/js/urlLoader.js:263`) admits viewport files plus buffer, starts the next file at 50 percent of the previous, fills upward past the visible end, and reprioritizes the active file on every navigation cutover. Opening a stub resolves it (`resolveUnresolvedGallery`, `src/js/urlLoader.js:2171`; `prepareGalleryDirectory`, `src/js/urlLoader.js:2489`) and resumes pending bytes on directory entry. `ensureGalleryOwnership` (`src/js/urlLoader.js:2046`) fails loud on path collisions. `forgetDeletedLibraryEntry` (`src/js/urlLoader.js:2367`) prunes sidecars so resume stops refetching trashed files. Validation (`_validateWindowsName`, `_validateImage`, `_validateGallery`, manifest checks at `src/js/urlLoader.js:72-153,601-633`) is the filesystem wall and stays untouched.

### Extractor side today

Shared helpers carry no `match` or `extract`, are never manifest entries, and are pulled through declared `quivit-deps`. MangaDex merges two feed passes (plain hosted, then external) with first id winning, which reads as hosted winning duplicates. That merge order is MangaDex-local logic. Cross-provider chapters are stubs with the other site's URL, resolved by core re-matching the manifest on open, which is why no orchestrator change was needed for K MANGA externals.

## Part 2. The new contract mapped onto it

### Ownership

Core owns the Library: placement-agnostic writes, matching, clearing, queueing, opening, and all safety rails. Extractors own site facts: what belongs together, what it is called, what the cover is, which prior standalone a gallery image absorbs, and where a jump should land. Site logic never enters core. Core never interprets layer meaning.

### Placement, no core change

Extractors keep returning relative paths, filenames, covers, chapters, folders, and metadata exactly as today. Free depth and naming hold within the filesystem wall. Chapter stubs may carry their own `cover`. One new core behavior closes the gap: series import downloads stub covers next to their stubs, since today only the series `cover` is downloaded and the K MANGA per-stub field would otherwise be dead data.

### Clearing, one optional per-image list

Images gain optional `supersedes`, an array of URLs or stems naming the prior standalones this image absorbs. Field name locked: `supersedes`. Core feeds those entries into the existing match-set builder in `cleanupMatchingRawFiles` and the existing root sidecar prune. Matching uses normalized source URL equality first, then stem and filename; `supersedes` entries are additionally added to the match set. No list means current behavior exactly. Policy flags (`removeMatchingChapters`, `removeLooseCovers`, `removeLooseFiles`) keep their current defaults and scope. Clearing stays inside one provider folder.

### Jumping, generic default plus explicit override

Default selection is gallery beats root beats series cover, with exact address beating stem. No depth counting. When an extractor provides a jump target, that target overrides the generic jump-selection logic. The explicit jump-target field was deferred to the jump slice and resolved there: no new field. Tiebreak plus `targetFilename` cover every contract case. True ties between two galleries remain extractor-defined, otherwise core keeps its deterministic existing order so behavior never depends on timestamps. Placeholder eager fill stays on every jump path, and `open_first_image` keeps its current role: the cover opens the viewer only when that setting is on or the extractor target names it.

### Feed and cross-provider rules, extractor-local

MangaDex hosted-first merging stays a MangaDex convention, not a core law. Core guarantees only first id wins within one result and finished chapters are never overwritten. Cross-provider rules: entries never call each other, shared code lives in `shared/` behind `quivit-deps`, stubs carry the foreign URL for core re-matching, canonical helpers strip tracking params in the shared layer, external stubs keep their provider suffix, shared changes bump every dependent entry version in the same commit, and new powers declare `quivit-needs`.

### README as the sole contract

The extractors branch README lists every accepted field and what core does with it. Unlisted fields are ignored. One verified link per behavior stays in the table so anyone retests by pasting. Version bumps ride with script changes. If it is not in the README, it does not exist.

## Implementation slices in order

- [x] Accept and validate `images[i].supersedes` and `chapters[i].cover`, nothing else. Both validation-only, zero behavior change. The explicit jump-target field shape is deferred to the jump slice, which decides whether a new field is needed at all.
- [x] Feed the absorbed list into the existing cleanup match set and root prune. Done, manual checklist passed.
- [x] Prefer gallery over root on score ties, honor the explicit jump target, keep placeholder fill and `open_first_image` behavior. Done, manual checklist passed. No new jump-target field needed; tiebreak plus `targetFilename` cover it. Also fixed the new-gallery return forcing the first image when the setting is off.
- [x] Download chapter stub covers during series import. Done, manual checklist passed.
- [ ] Adopt in K MANGA first (thumbnail absorbed list, deepest-gallery jump), then MangaDex art duplicates. Leave Imgur and MANGA Plus alone.
- [ ] Update the extractors README contract and bump touched manifest versions together.
- [ ] Prove with `npx mocha mocha/urlLoader.test.js`, `npx mocha mocha/diagnosticsContract.test.js`, `node --check` on touched files, then targeted series plus direct specs per the blast-radius matrix.
