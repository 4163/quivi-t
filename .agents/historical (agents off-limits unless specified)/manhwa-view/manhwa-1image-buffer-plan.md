# Manhwa 1-image buffer plus pre-decode plan

Validation comparison performed against `.agents/skills/validate-changes/SKILL.md`. This doc is a plan only. It changes no code.

## Definitions lock

- Buffer is strictly item based. 1 mounted image behind the anchor, 1 ahead. Visible range unions in so zoomed-out views stay covered.
- Pre-decode means off-DOM `img.decode()` resolves for the ahead item before its node enters the slot. Paint must never wait on first rasterization.
- Anchor is the item under viewport center via `findAnchorIndex`. Owner is `src/js/viewer/manhwaStrip.js`.
- Backend warm is Rust zip LRU warming only. No new JS-side bitmap caches beyond the existing node pools.
- Deviation rule. If a slice changes who owns a surface, stop and update this doc first. Do not split one owner across sibling files. Do not grow new caches without naming capacity and eviction here.

## Context

Replay on `test-files/issue.zip` showed zero `manhwa-visible-unmounted` and 929 ms of `manhwa-visible-incomplete` on one 10.6 MB PNG. Slot `<img>` mounts, but decompression plus Chromium rasterization run after viewport entry. Two causes feed it. Chromium defers rasterization of offscreen images unless `decode()` runs first. `protocol.rs` holds the exclusive `ArchiveCache` write lock across `read_entry_bytes` plus `wait_for_data`, so parallel entry fetches serialize. Current tree mounts anchor minus 3 plus 5 with backend warm of 8 past the window. That over-mounts against the user's strict 1-image decision and still exposes first rasterization.

## Slice 1. Strict 1-item buffer in the strip

- [x] Set `STRIP_BEHIND_COUNT` to 1 and `STRIP_AHEAD_COUNT` to 1 in `src/js/viewer/manhwaStrip.js:22-27`. Keep the visible-range union in `_updateWindow` at `src/js/viewer/manhwaStrip.js:431-438` so zoomed-out views with many small items stay covered.
- [x] Keep evict-outside-window as is at `src/js/viewer/manhwaStrip.js:436-456`. No hysteresis margin returns. Mounted nodes stay bounded by visible plus 2.
- [x] Reduce `PREFETCH_AHEAD_COUNT` to 1 and `PREFETCH_CACHE_CAPACITY` to 1 in `src/js/viewer/manhwaStrip.js:29-36`. One decoded node retained, nothing more.
- [x] Reduce `BACKEND_WARM_AHEAD` to 2 in `src/js/viewer/manhwaStrip.js:36`. Warms the 1-ahead mount plus its prefetch, not a chapter. Keeps the direct-invoke path and `_lastBackendWarmKey` dedup in `_warmBackendAhead` at `src/js/viewer/manhwaStrip.js:647-677`.
- [x] Accept: `node --check src/js/viewer/manhwaStrip.js` passes. Replay shows mounted set equals visible union 1 behind plus 1 ahead on every step. Zero `manhwa-visible-unmounted`.

## Slice 2. Pre-decode gate before slot entry

- [x] In `_prefetchAhead` at `src/js/viewer/manhwaStrip.js:570-628`, call `pre.decode()` after src set and await it before inserting into `_prefetchedImages`. Keep the existing `_onItemDecoded` dims recording. A node that fails decode drops out of the map like an error today.
- [x] In the mount loop at `src/js/viewer/manhwaStrip.js:458-530`, prefer the prefetched node for the ahead item as today. If the ahead node is absent or undecodable at scroll time, mount with src as today and let onload correct. No blank holding, no frame delay added to the pan path.
- [x] Do not append-then-decode in the slot. The slot receives nodes whose bitmap is ready. Decode failure falls back to current onload behavior.
- [x] Accept: ahead node has `complete` true and `naturalWidth` greater than 0 before `appendChild`. Replay shows zero `manhwa-visible-incomplete` on steady scroll. `npm run mocha` passes.

## Slice 3. Scope down the protocol extraction lock

- [x] In `src-tauri/src/protocol.rs` around line 101, restructure the `spawn_blocking` body so the `ArchiveCache` write lock covers cache lookup plus insert only, and releases while `wait_for_data` blocks on extraction. Read the exact guard shape at implementation time. Touch nothing else in the handler.
- [x] Blast radius: this handler serves every archive image fetch plus shell thumbnails through `read_entry_bytes` and `cached_zip_entry_bytes`. Parallel fetches must overlap after the change. Single-image viewer prefetch through `src-tauri/src/commands/archives.rs:44-61` shares the same LRU and must not regress.
- [x] Accept: `cargo check --tests --manifest-path src-tauri/Cargo.toml` passes. `cargo test --manifest-path src-tauri/Cargo.toml archive` passes. Replay shows ahead-mount fetch latency no longer stacks serially behind the visible fetch.

## Slice 4. Verify and clean

- [x] Run `npm run diagnose -- manhwa-buffer --pause 600` against `test-files/issue.zip`. Accept: zero `manhwa-visible-incomplete` and zero `manhwa-visible-unmounted` across all steps. Note: `issue.zip` is gitignored and absent from this checkout. If unavailable, run against `test-files/_archives/zip.zip` and record which file the numbers came from.
- [x] Run `npm run mocha` and `cargo check --tests --manifest-path src-tauri/Cargo.toml`. Full `cargo test` only at final signoff per AGENTS.md targeted-testing rule.
- [ ] Run `npm run diagnose -- --clean` to remove the investigation workspace. Accept: `e2e/replay-diagnostics/investigation.js` gone, scenario and report retained. Left for a harness that runs e2e.
- [x] Do not declare done. Present static results plus the runtime list and await user signoff per the verify workflow. Signoff received: user confirmed the second image arrives painted with no kick.

## Slice 5. Hold first paint on cold open - REVERTED

- Reverted. It targeted image 0 cold start and did not solve the second-image pop-in. Strip plus CSS carry no `manhwa-boot` code.

## Slice 6. First-build pre-decode bypass plus scroll layout kick

- [x] Mount loop in `_updateWindow` mounts non-visible window items only from decoded prefetched nodes. Direct raw mounts are visible-range only, so nothing unrasterized enters the viewport on first scroll.
- [x] `_prefetchAhead` runs on the first build and enqueues non-visible window items first, then the directional ring. Backend warm still waits one update to protect cold-open CPU.
- [x] `_updateLayout` end-pin re-pins gated on 150 ms pan quiet via `_lastPanAt`, recorded in `_updateWindow` on nonzero `deltaTy`. Delta-anchor correction unchanged.
- [x] Accept: fast-scroll trace shows slot 1 pre-decoded before viewport entry and no ty kick on its decode. `node --check` and `npm run mocha` pass. User confirmed fixed in the running app.

## Open questions

- Steady scroll at 600 ms cadence gives decode time to settle. Fast flicks past 1 ahead still mount cold. That is accepted by the strict buffer decision, not solved here.
- Folders need no backend warm. The warm path already skips non-archive modes. No folder work in this plan.
- The 2 deferred jank frames from the diagnosis stay deferred. They are outside this plan unless replay shows them blocking paint.
