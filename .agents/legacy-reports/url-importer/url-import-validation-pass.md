# URL import final validation pass

Validation comparison against `.agents/skills/validate-changes/SKILL.md` performed. Reporting only, no code changed.

Scope: the url-import feature entirety. `src/js/urlLoader.js`, its callers, the extractors branch, `mocha/urlLoader.test.js`, `e2e/specs/08-url-loader.e2e.js`, and the three docs (contract, refactor checklist, extractors README) against `.agents/scratch/user-transcript.txt`.

## User question 1: goal alignment with urlLoader.js L3-8

Verdict: aligned, proven mechanically. A domain scan of `src/js/urlLoader.js` finds zero provider names, hosts, or vendor patterns outside one comment about dependency rewriting. All site knowledge (K MANGA hashes, MangaDex feeds, MANGA Plus protobuf, Imgur payloads) lives in extractor modules behind the manifest. The contract additions (`supersedes`, stub covers, rank tiers, sized normalization) each landed on the correct side: declarations in extractors, generic machinery in core.

One gap: the L3-8 header still describes only loading and downloads. It never states the ownership split, so a new extractor author reading the file top learns nothing about where site logic belongs. Either extend the header with two lines or accept the README as the entry point.

## User question 2: stale logic per the transcript

Verdict: three live candidates, one already resolved.

- Resolved: front-facing `K-Manga` to `K MANGA` rename from the transcript is complete. No leftovers in core, extractors, manifest, or README.
- Candidate: the filename-substring jump rule. It predates the contract, survives as jump-only, and is the fuzziest matcher left. [Observable change] either way.
- Candidate: the covers-first subdirectory visit order. Name-based ordering kept for tie determinism. It decides outcomes on ties, so it is semantics wearing a performance comment. [Observable change] either way.
- Candidate: `recordRootMediaDownload` dedups with its own inline comparison instead of `buildMatchSets`. Same concern, second implementation. [No observable change] to unify, since behavior is already correct.

## Further findings

- Commit messages `beb3875` and `bbc0cfb` do not describe their diffs. The former claims a `targetFilename` override removal that is not in the code; the latter claims a stub-cover helper removal while the helper still exists and is called. Code, docs, and tests all agree `targetFilename` is intact, so only the messages lie. Do not rewrite pushed history over this. Record the correction here instead, which this line does.
- Version discipline slipped once: `a1dfeb8` changed `shared/kmanga.js` without bumping dependents, against the stated workflow rule. Later bumps (kmanga v2, mangadex v6) are each correctly paired with their script changes, so nothing is outstanding. The rule needs enforcing going forward, not retroactively.
- Orchestrator flows have zero mocha coverage. Series import, gallery import, stub resolution, and queue management are proven only by manual passes and a blocked e2e suite. The 145 unit tests cover validation, matching, cleanup, and helpers. Whether that gap is acceptable is a decision, not a defect.
- E2E remains environmentally blocked (two identical session-creation failures). Nothing in the changes can affect it, but nothing in the changes is covered by it either.

## Checklist

- [x] Decide the header question: extend L3-8 with the ownership split or formally accept the README as entry point. Done: header extended, manual pass confirmed.
- [x] Bless or remove the filename-substring jump rule. Removed: records that cannot match by address or stem are poorly recorded, per Extractors Define. Suite green, one stale expectation updated openly.
- [x] Bless or remove the covers-first visit order. Removed name sniffing; ties break by plain path order, documented as stability only. Same proof as above.
- [x] Route `recordRootMediaDownload` dedup through `buildMatchSets`. Done: suite green at 145, manual pass confirmed.
- [x] Decide root-sidecar growth. Accepted unbounded per practical path: records are ~200 bytes each with dedup on re-download and removal when emptied, so growth is negligible and no behavior changes at realistic sizes. Stale-record jumps become a separate bug only if ever reproduced.
- [x] Decide orchestrator coverage: mocked-Tauri mocha for the import and resolve paths, or written acceptance of the manual-plus-blocked-e2e posture. Done as split: new `mocha/urlLoaderFlows.test.js` covers prepare, resume, and entry-prune flows (10 tests); series/gallery import and stub resolution stay manual-only since module loading cannot run in Node and widening visibility for tests is forbidden. Suite at 155 passing.
- [x] Hygiene sweep: Temp logs and session throwaways deleted. Scratch binaries (`kmanga-page1.jpg`, descrambled variant) kept per user decision.
- [x] Confirm the three docs agree after this pass and restate which one wins on conflict. Agreement verified: contract, checklist, and README state the same jump tiers, clearing rule, and field names. On conflict the extractors README wins, since every doc already names it the sole contract.
- [x] Enforce version-with-script pairing on the next extractor commit. Nothing outstanding today; rule enforced going forward.
