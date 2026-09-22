# URL import refactor checklist

Validation comparison against `.agents/skills/validate-changes/SKILL.md` performed. This is a plan, no code changed.

Reference: `.agents/scratch/user-transcript.txt` holds the discussion this refactor is drawn from. `.agents/url-layer-contract.md` holds the five built slices and the skipped verification. The contract stays in force. This refactor does not renegotiate it. It removes the duplicated machinery the slices layered over the old code.

Locked definitions from the transcript: a layer is any URL the importer handles. Freely defined means within generic filesystem validity. Cleared means deleted, file plus records, no relocation. A jump opens a directory and highlights a file. Core assigns no semantic meaning to a layer based on depth, name, or position. Extractors define placement, clearing, and jumping. The extractors README is the sole contract.

## Validation report

**Target:** URL import feature entirety. `src/js/urlLoader.js`, its callers in `src/js/main/main.js` and `src/js/main/urlOverlay.js`, the extractors branch, `mocha/urlLoader.test.js`, and `e2e/specs/08-url-loader.e2e.js`. Slice range `2340a72..HEAD` plus extractors `082e6eb..HEAD`.

**Summary:** Five additive slices implemented the layer contract without structural change. The provider-agnostic core held, but each slice layered a new mechanism next to the old one instead of consolidating it.

### AGENTS.md violations

- [src/js/urlLoader.js:2774-2779] [No observable change] `reloadLibraryDir` and `getCachedLibraryDir` each appear twice in the `UrlLoader` export object. Duplicate keys, second wins silently. Breaks the one-owner-per-concern rule in spirit and invites a future edit to update the wrong copy.
- [src/js/urlLoader.js:cleanupMatchingProviderEntries] [Observable change] Two clearing vocabularies now coexist. The exact-cover block matches names, hashes, and URLs its own way while `cleanupMatchingRawFiles` matches through the unified URL, stem, filename, and `supersedes` set. Same concern, two owners of the matching logic. The strict reading of one owner per concern fails.
- [src/js/urlLoader.js:963] [Observable change] Jump scoring keeps four numeric tiers plus a root flag bolted on. The contract rule is gallery beats root beats cover with exact beating stem. The tiers encode that rule plus legacy carve-outs in one number, so the next reader must reverse-engineer the rule from the scores.
- [src/js/urlLoader.js:findMatchingGalleryImage vs cleanupMatchingRawFiles link phase] [Observable change] Record matching exists twice in different flavors: sidecar scan with scoring for jumps, sidecar scan with linking for cleanup. One shared matcher would serve both.
- [mocha/urlLoader.test.js] [No observable change] Eight added tests plus one extended assertion were written against new code during implementation. They pass, but under the delete-and-rewrite directive they are all removed and rewritten from scratch against the refactored design, not patched.

### Stale code and references

- [src/js/urlLoader.js:2774-2779] [No observable change] Duplicate export keys noted above. Delete the second copies.
- [extractors/README.md:fixed in slice 6] [No observable change] The stale `K-Manga` external-stub suffix was already corrected to `K MANGA`. No action left.
- None other found. No domain leakage into core (one comment-only mention of a shared path). No dead exports (every candidate is referenced in at least two files). Viewer probes, action ids, and replay scenarios untouched. No `investigation.js` present. Rust untouched.

### Verdict

Pass with warnings. The feature works and the contract holds, but the implementation carries duplicated matching and scoring machinery plus one export-object defect. The checklist below removes them.

## Refactor rules

- Extractors define. Any logic about what a layer is, where it goes, what it absorbs, or where it lands lives in the extractor or its declared contract fields. Core interprets nothing.
- Delete first. The eight listed tests and the one extended assertion are removed before replacement tests are written. No patching old tests onto new code.
- One mechanism per concern. After this refactor there is exactly one match set builder, one jump ranker, and one sidecar record pruner.
- Contract frozen. Field names, shapes, and rules do not change in this refactor. If a slice proves the contract wrong, stop and ask instead of improvising.

## Checklist

Mark an item done only with its proof command green. If an item must deviate, write the reason under it plus which later items the deviation affects, then continue. Unmarked deviations fail review.

- [x] Baseline. Commit or shelve both trees clean. Record `npm test` count and `git diff --stat` for main and extractors trees so the refactor has a before picture. Baseline recorded: main clean except untracked checklist doc, extractors clean, `npm test` 140 passing.
- [x] Delete the eight added tests (`accepts valid supersedes`, `accepts valid chapter cover`, both `buildStubCoverRecord` tests, `prefers the gallery copy`, `renamed standalone`, `token-variant`, `host-variant`) and revert the K MANGA episode `supersedes` assertion to its pre-contract form. Proof: `npm test` drops by exactly the removed count with no other failures. Done: 140 to 132, zero trace, unused import removed.
- [x] Unify clearing. Collapse the exact-cover block into the unified match set so one vocabulary (URLs, stems, filenames, `supersedes`) serves series covers, loose covers, and raw files. Proof: targeted mocha plus a manual series re-import showing finished work untouched. Deviation affects the jump ranker item if shared helpers are extracted early.
- [x] Collapse jump scoring to the contract tiers with the art fast path kept and documented as performance, not semantics. Remove the numeric archaeology. Proof: targeted mocha plus direct-link jumps to chapter copies in the running app. Deviation affects replacement jump tests.
- [x] Extract one shared sidecar matcher used by both the jump scan and the cleanup link phase. Proof: `node --check` plus unchanged mocha count before replacement tests land. Done: suite holds at 132, manual runtime passed.
- [x] Remove the duplicate export keys and fix any error-label cosmetics touched along the way. Nothing else in the export surface changes. Done: 40 keys, zero duplicates, supersedes and chapter-cover labels match file conventions, suite green at 132.
- [x] Re-derive extractor adoption against the unified core. K MANGA absorbed list and MangaDex art duplicates resolve with zero extractor changes. Done: episode re-derive links exact, art re-derive links fuzzy, extractors tree untouched. Follow-up pass: sized cover variants (file.jpg.512.jpg) normalized in mangadex `parseDirectUrl` with manifest v5 to v6, core untouched by design, manual checklist passed.
- [ ] Rewrite tests from scratch per area: validation, clearing, jumping, stub covers, adoption. No old test text returns. Proof: full `npm test` green with the new suite only.
- [ ] Update this doc and the extractors README to the final wording, bump any touched manifest versions with their scripts. Proof: manifest passes `validateManifest`, README examples match implemented shapes.
- [ ] Run the skipped verification in full: `cargo test`, the e2e URL loader spec, and replay diagnostics for a navigation scenario. This is the slice skipped last time. It does not get skipped twice. Proof: reported numbers, then user signoff, then and only then port to `implemented.md`.
