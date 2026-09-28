Validation comparison performed against `.agents/AGENTS.md` and `.agents/skills/validate-changes/SKILL.md`.

# Manhwa view validation report

**Target:** `origin/main` merge-base `5c672c75e92fc5f06ad86a1b8c0442a4407893ea` through `feature/manhwa-view` `6e1058a4c6accac5cf47260021c03e5518eea512`.

**Scope:** 45 commits and 39 changed files. I traced the new strip through the state machine, input dispatch, viewer, file panel, URL queue, archive protocol, cache, and CSS. This is a reporting-only review. No production code or tests were changed.

**Excluded by request:** I did not report stale user documentation or defects in test suites that predate this work. I also did not count the archived planning files as feature defects.

**Summary:** The branch adds a vertical, windowed manhwa reader with fit modes, input routing, file-panel highlights, incremental gallery downloads, and a ZIP protocol fast path. The UI integration is broad and the standard checks pass, but three blockers remain: unlocked encrypted ZIPs take an unauthenticated path, width-only decodes leave geometry stale, and the new UI writes intrinsic dimensions inline.

## Evidence collected

- `npm run mocha` passed: 247 tests in 4 seconds.
- `cargo check --tests --manifest-path src-tauri/Cargo.toml` passed.
- `node --check` passed for all 20 changed JavaScript files outside `mocha/`.
- `git diff --check` reports three trailing blank lines. They are non-functional, listed below.
- I did not run a desktop session. The pass results do not exercise the protocol request after an encrypted ZIP unlock, nor a long, actively downloading strip. The two functional blockers have code-trace confidence at level 3 of the blast-radius ladder. They need a runtime check after remediation.

## AGENTS.md violations

- [src/js/viewer/manhwaStrip.js:268] [Blocking] The strip writes intrinsic `height` and `width` through `style`, then repeats those writes at lines 394, 400-401, and 1600-1601. `AGENTS.md` makes CSS the visual source of truth and permits JavaScript to write custom properties, transforms, classes, and data attributes, not intrinsic visual values. Define slot dimension custom properties in CSS and set only those values from the strip.

- [src/js/viewer/manhwaStrip.js:13] [Warning] The feature creates an import cycle: `manhwaStrip.js` imports the file-panel cache and `revealListTop`, while `filePanel.js:28` imports the strip. `viewer.js:6` also reaches into the file panel for the same scroll action. This bypasses the state/callback boundary required by `AGENTS.md` and couples three UI owners during module initialization. The file panel should expose an injected callback or react to dedicated state, and the archive image cache should live outside the file-panel module.

- [src/options.html:1] [Nit] Adding one keybinding row also reformats most of Options. The semantic diff is about 100 changed lines after whitespace is ignored, but the ordinary diff is more than 1,000 lines. That conflicts with the repository's small, deliberate slice rule and makes review, merge conflicts, and blame worse.

## Functional and UX findings

- [src-tauri/src/archives/mod.rs:429] [Blocking] A ZIP that the user has successfully unlocked is sent through `read_plain_zip_entry_shared`, which only rejects `PasswordRequired` and `PasswordIncorrect`. A successful password produces `encryption: None` in `archives/zip.rs:192-198`, although the open cache still holds the password and uses it for normal reads in `archives/cache.rs:137-146`. The new helper then calls `extract_zip_entry(..., None)` at `archives/mod.rs:437`. Encrypted entries fail, and `protocol.rs:108-118` turns that failure into a 404. Preserve the authenticated cached-read path whenever an archive has a stored password, or give the fast-path decision an explicit "plain archive" predicate. This affects every `quivit://archive/` request, not only manhwa mode.

- [src/js/viewer/manhwaStrip.js:357] [Blocking] `_onItemDecoded` saves the new width at line 379 before checking `item.naturalWidth !== nw` at line 409. That comparison is always false. If a decoded image has the estimated height but a different width, no layout pass runs. The slot becomes the decoded width at line 401 while viewport dimensions, pan limits, and fit scale still reflect the old widest width from `_updateLayout` at lines 306-348. A 1600x1200 image after the 800x1200 estimate demonstrates the failure. Save the previous width before assignment and request layout whenever either dimension changes.

- [src/js/viewer/manhwaStrip.js:370] [Warning] The animated-SVG cap cannot be selected. `_buildImageIndex` creates items with no animation field at lines 169-177, and the IPC `FileEntry` contract has no `is_animated` member in `src-tauri/src/models.rs:4-13`. `item.isAnimated` is therefore always false, so animated SVGs take the 2048px path instead of the intended 512px path. This risks a large decode and a visible pause on an animated SVG. Carry animation status into each strip item or use a deliberate, bounded fallback policy.

## Performance and perceived performance

- [src/js/viewer/manhwaStrip.js:255] [Warning] The strip keeps image nodes bounded but creates one `.manhwa-slot` and, for multi-image lists, one backdrop for every image. The loop runs on activation and full list reloads. More importantly, each `quivit-download-complete` event enters `_admitCompleted` at line 1550, rebuilds all slots at line 1590, and is emitted once per completed gallery item by `src/js/urlLoader.js:2353-2360`. A 200-page gallery can repeatedly remove and recreate roughly 400 DOM nodes per page while the user reads. Use a bounded slot pool plus a layout representation that does not require a DOM element for every page.

- [src/js/services/viewerMath.js:38] [Warning] Layout and range calculation scale with the full chapter on the pan path. `computeColumnOffsets` makes two full passes over all items at lines 44 and 55. `computeWindowRange` scans offsets from the first item at line 134. `_updateWindow` calls the latter at `manhwaStrip.js:472`, and the viewport subscription invokes `_updateWindow` for every pan/zoom update at lines 1532-1543. Combined with the per-download rebuild above, large chapters will turn pointer or held-key movement into repeated whole-list work. Maintain prefix geometry incrementally and find the visible range with binary search.

- [src/js/viewer/manhwaStrip.js:123] [Warning] `_icoCache` is an unbounded `Map` of generated data URIs. It has no capacity, byte budget, or clear path, even though entries are added at lines 693 and 899 and survive deactivation. This conflicts with the named, bounded cache rule and can retain large ICO spritesheets across many folders and archives. Use a bounded cache with an explicit byte or entry limit and dispose it at the appropriate lifecycle boundary.

## Redundant code and shared helpers

None beyond the ownership coupling called out above. The strip correctly reuses the shared viewport state and the existing pure viewer-math module instead of duplicating the pan and fit formulas.

## Stale code and references

No stale production references found in the reviewed feature path.

- [src/js/viewer/manhwaStrip.js:1661] [Nit] `git diff --check` reports a new blank line at end of file.
- [src/js/services/viewerMath.js:575] [Nit] `git diff --check` reports a new blank line at end of file.
- [mocha/viewerMath.test.js:725] [Nit] `git diff --check` reports a new blank line at end of file.

## Diagnostics and test limits

The diagnostic contract test passes, and the committed `investigation.js` exports correctly. I did not treat the diagnostics fixture as stale because the request excludes pre-existing test-suite cleanup.

The passing Mocha suite covers the pure action and layout helpers. It does not call `manhwaStrip.js` in a browser DOM, dispatch a real `quivit-download-complete` sequence, or request an encrypted ZIP page through the new protocol helper. Those are the highest-value manual checks after the blockers are fixed.

## Verdict

**Fail.** Do not merge with the encrypted-ZIP regression, stale width-only layout, or inline intrinsic dimensions. The performance and ownership warnings should be resolved in the same manhwa slice because they are directly on the reader's long-chapter and live-download paths.

## Remediation checklist

**Scope lock:** Address the defects and direct verification listed below. Do not use this work to refresh user documentation or repair pre-existing test suites. Keep deviations in this report with the reason and the affected file.

1. [ ] **Restore authenticated reads for unlocked encrypted ZIPs.** [src-tauri/src/archives/mod.rs:429] Preserve the cached password path for encrypted archive protocol requests, or make the fast path prove that an archive is unencrypted before it calls `extract_zip_entry` without a password.
   **Accept when:** an encrypted ZIP opened with its correct password serves an image through `quivit://archive/`, and a missing or incorrect password still fails without exposing data.

2. [ ] **Invalidate strip geometry when decoded dimensions change.** [src/js/viewer/manhwaStrip.js:357] Compare the previous width and height before overwriting either value, then request layout whenever either dimension differs.
   **Accept when:** an image whose decoded width differs from its estimate updates the widest width, fit scale, and pan limits without requiring a mode change or reload.

3. [x] **Move strip dimensions back under CSS ownership.** [src/js/viewer/manhwaStrip.js:272, 403, 413, 419-420, 1629-1630; src/css/main.css:1468] Slot dimensions now flow through leaf-scoped `--slot-width` and `--slot-height` properties consumed by the manhwa stylesheet.
   **Accept when:** the strip has no JavaScript writes to intrinsic `width` or `height`, while slot sizing and placeholders remain correct through load, reload, and resize.

4. [ ] **Break the file-panel and strip import cycle.** [src/js/viewer/manhwaStrip.js:13; src/js/filepanel/filePanel.js:28; src/js/viewer.js:6] Move archive image caching to a domain owner and route the list-reveal action through state or an injected callback.
   **Accept when:** neither UI owner imports the other, and opening, selecting, and revealing the current image still work.

5. [ ] **Stop rebuilding every page node after each download.** [src/js/viewer/manhwaStrip.js:255, 1550, 1590; src/js/urlLoader.js:2353-2360] Keep a bounded, recyclable page-node pool and update only the downloaded item and visible window.
   **Accept when:** completing one gallery download does not replace unaffected page nodes, and a long gallery keeps its mounted DOM count bounded.

6. [ ] **Remove full-chapter work from the pan path.** [src/js/services/viewerMath.js:38, 134; src/js/viewer/manhwaStrip.js:472, 1532-1543] Maintain prefix geometry when dimensions change and locate the visible range with indexed lookup.
   **Accept when:** ordinary pan and zoom updates do not scan the full image list, and layout changes still place every image at the correct offset.

7. [ ] **Bound and clear the ICO data-URI cache.** [src/js/viewer/manhwaStrip.js:123, 693, 899] Use named entry or byte limits and clear the cache at its defined lifecycle boundary.
   **Accept when:** the cache cannot grow without limit across folders or archives, and repeated current-folder icons remain available from cache.

8. [ ] **Implement the animated-SVG sizing policy.** [src/js/viewer/manhwaStrip.js:169-177, 370; src-tauri/src/models.rs:4-13] Provide animation metadata to strip items, or replace the unreachable branch with an explicit, bounded fallback rule.
   **Accept when:** animated SVGs take the intended decode limit and static SVG behavior remains unchanged.

9. [ ] **Remove the three trailing blank lines.** [src/js/viewer/manhwaStrip.js:1661; src/js/services/viewerMath.js:575; mocha/viewerMath.test.js:725]
   **Accept when:** `git diff --check` reports no errors for this branch.

10. [ ] **Run the focused final checks.** Re-run `npm run mocha`, `cargo check --tests --manifest-path src-tauri/Cargo.toml`, JavaScript syntax checks, and a desktop smoke test that opens an unlocked encrypted ZIP, loads a long gallery incrementally, and changes an image from estimated to decoded dimensions.
   **Accept when:** all listed checks pass and the three former blockers cannot be reproduced.

11. [x] **Refresh the existing column fit after ICO dimensions resolve.** [src/js/viewer/manhwaStrip.js:358, 775] This pre-existing race occurred only on fresh navigation to an ICO directory. The reader first fit the full column from 1200 px placeholder heights. `get_ico_frames` then returned each 256 px spritesheet, but layout updated without recalculating the active fit. Pressing a fit key later recalculated the same column fit and made the problem disappear. The first ICO now supplies the height estimate for unresolved ICO entries, then the reader reapplies the same active column fit after the coalesced layout update.
   **Accept when:** enable Manhwa View, open `E:\Projects\QuiviT\icons\formats`, and use Height, Height if Larger, Window, or Window if Larger before the ICO previews appear. Once they load, the strip occupies the same correct full-column bounds as it would after pressing that fit key a second time. `npm run mocha` passes.
