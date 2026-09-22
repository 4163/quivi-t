# Extractor dependencies and host capabilities: implementation plan

Validation comparison performed against `.agents/skills/validate-changes/SKILL.md`. This is a plan, no code changed. It follows the urlLoader forefront goal: extractor work must reach users through the remote branch with zero QuiviT releases.

## Goal

Let `mangadex.js` consume a shared MangaPlus viewer client for `externalUrl` chapters, without duplicating viewer logic and without a second copy when a standalone MangaPlus extractor arrives later. Two mechanisms, one slice sequence:

1. File dependencies declared in the extractor header, resolved by the loader.
2. Host capabilities declared in the extractor header, gated by the loader, backed by small generic backend additions.

Non-goals: a standalone `mangaplus.js` entry, any other provider, login or device registration flows.

## Verified starting facts

- `loadExtractorModule` (`src/js/urlLoader.js:606`) fetches entry text, imports via Blob URL, and requires `match`/`extract` exports. Blob modules cannot resolve relative imports, so shared code has nowhere to live today. `sanitizePathSegment` is copied in both `imgur.js` and `extractors/mangadex.js`.
- `is_safe_extractor_path` (`src-tauri/src/commands/network.rs:158`) already accepts nested `.js` paths, and the test at `:339` proves `sites/example.js` passes. `shared/*.js` files load through the existing `fetch_extractor_text` with no backend change.
- The extractor context is `{ fetchText }` only (`urlLoader.js:1345,1395,1542,1912`). `fetch_text` (`network.rs:38`) returns a UTF-8 string, which corrupts protobuf bytes. MangaPlus page lists need binary fetch.
- `download_to_file` (`network.rs:174`) takes fixed args, no headers, no transform. It streams to a temp file and renames into place (`:215,:307`). Queue items carry url, fallbackUrl, destPath, filename only (`urlLoader.js:233`), and `_runAttempt` (`:447`) plus `_eagerDownload` (`:1718`) call `_downloadFile` without any per-image extras.
- `_validateImage` (`urlLoader.js:82`) checks url, fallbackUrl, and filename. Extra descriptor keys pass through silently today, which is convenient but means new keys like `headers` need explicit validation before the backend trusts them.
- New app commands need registration in the `lib.rs` handler list (`:121-123`) and nothing in `capabilities/default.json`, which only gates plugin permissions.

## Design

### Header directives

Two comment lines at the top of the entry file:

```js
// quivit-deps: shared/sanitize.js, shared/mangaplus.js
// quivit-needs: fetchBytes, requestHeaders, xorDecrypt
```

A comment beats an exported const because the module cannot be imported until deps resolve. The loader reads text first, so it parses headers before importing anything.

### File dependency resolution

- Authors write plain relative imports (`from './shared/sanitize.js'`). The loader fetches each declared file via `fetchExtractorText`, assigns each a Blob URL, and rewrites the entry specifiers to those URLs before `import()`.
- Headers resolve transitively. `shared/mangaplus.js` declares `shared/proto.js` in its own header and the loader walks the graph with cycle detection.
- Every imported path must be declared, must match `SAFE_EXTRACTOR_SOURCE_RE`, and must contain no `..`. Anything else rejects the load.
- Only the entry module gets the `match`/`extract` check. Library blobs skip it.
- Cache key extends to `id@version:source:<hash of resolved dep texts>`. Pushing a shared fix invalidates dependents on next load. The manifest schema does not change.

### Capability gate and context

- `urlLoader.js` holds a `SUPPORTED_EXTRACTOR_CAPABILITIES` set. A `quivit-needs` name outside the set fails fast with an "update QuiviT" error naming the missing capability.
- Three capabilities, all generic:
  - `fetchBytes`: new `fetch_bytes(url, headers)` command returning base64. JS decodes to `Uint8Array` for `shared/proto.js`. `base64` 0.23.1 is already a backend dependency.
  - `requestHeaders`: optional header map on `fetch_bytes` and `download_to_file`. Deny `host`, `content-length`, `cookie`. Cap value lengths.
  - `xorDecrypt`: image descriptors gain `decryption: { algorithm: 'xor', key }`. The loader forwards it without understanding it. The backend applies repeating-key XOR to the temp file before rename. Unknown algorithms error.
- `context` gains `fetchBytes`. Image item construction sites forward `headers` and `decryption` into queue items, `_runAttempt`, and `_eagerDownload`. Fallback downloads reuse the same headers and decryption as the primary.

### Branch layout

```text
extractors/
  manifest.json            # unchanged schema
  imgur.js                 # untouched
  mangadex.js              # header + externalUrl path via client
  shared/
    sanitize.js            # moved helper, single copy
    proto.js               # minimal protobuf reader
    mangaplus.js           # viewer client, pure functions of (viewerId, context)
```

The standalone `mangaplus.js` entry stays unbuilt. Its shape is fixed by this plan: manifest patterns plus a thin shell over `shared/mangaplus.js`.

## Slices

### Slice 1: loader file deps plus sanitize proof. No Rust.

Touch `src/js/urlLoader.js` only: header parse, transitive fetch, specifier rewrite, extended cache key, dep-aware eviction (revoke all blob URLs for the graph, the current `_blobUrls` map at `:60` holds one URL per key and needs one entry per file). Move `sanitizePathSegment` to branch `shared/sanitize.js`, point both extractors at it, bump manifest versions.

Accept: `npm test`, `node --check src/js/urlLoader.js`, plus a live import of a MangaDex chapter and an Imgur gallery proving byte-identical downloads before and after.

### Slice 2: capabilities. Rust plus loader.

Backend: `fetch_bytes` with optional headers, header plus xor-key params on `download_to_file`, header denylist, registration in `lib.rs`. Loader: capability set, `needs` gate, `fetchBytes` context function, descriptor validation for `headers` and `decryption`, passthrough in queue items, attempts, and eager downloads.

Accept: `cargo check --tests`, `cargo test network::tests`, `npm test`, plus a synthetic xor round-trip test downloading a known byte string through the new params.

### Slice 3: MangaPlus client and mangadex wiring.

Branch only: `shared/proto.js`, `shared/mangaplus.js` (viewer id parse, `manga_viewer_v3` call with random `SESSION-TOKEN`, page list with `encryptionKey`, `Plus-Vw-Token` header descriptors). `mangadex.js` routes `externalUrl` chapters through the client in both the single-chapter path (`:417` throw becomes resolve) and the feed path (`:610` silent skip becomes skip-with-reason plus resolve). Dedupe shared viewer ids per the providers report.

Accept: mocha urlLoader and diagnosticsContract suites, one live MangaPlus-linked chapter imported from a residential IP. The IP ban seen from datacenter egress (`.agents/mangadex-external-providers.md` follow-up) must be re-proven here, not assumed away.

## Open risks

- Shueisha bot mitigation returned "Account Banned" protobufs on every probe from this network. Slice 3 acceptance depends on a residential test.
- Only free-window chapters are served. Series imports still have gaps, reported as skipped-with-reason.
- `EXTRACTOR_MODULE_CACHE_CAPACITY` of 20 now counts graphs. Entries with large dep trees evict faster. Watch, do not pre-tune.
