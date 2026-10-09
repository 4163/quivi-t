# ICO validation followup plan

This validation comparison was performed against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md` before writing. The source report covers `4911f0b..HEAD` on `refactor/ico-spritesheet`, code only, `*.md` excluded.

## Scope lock

- Branch is `refactor/ico-spritesheet`. Diverge point is `4911f0b`. HEAD moves, so rebase line numbers if they drift.
- This plan tracks only lines changed in that range. Do not fix pre-existing code outside the diff unless a fix cannot land without it.
- Binary fixtures under `test-files/` are out of scope for line review.
- Items marked accepted need no code change. They stay in the list so the next agent does not re-flag them.

## Definitions lock

- ICO row means the legacy `#viewer-ico-row` with one `.ico-size` cell per ICO size.
- Total means sum of widths by max height for an `IcoSize[]`.
- Composite means the single canvas built from all sizes for WebGL and Lanczos paths.
- Same row means `_activeTargetSrc === state.src` reuse in `viewerRender.js`.
- Quiet means 150 ms since last pan or zoom in `manhwaStrip.js`.
- Done means static checks pass plus the accept line under the item passes.

## Deviation rules

- Work one item at a time. Keep each change small enough to review alone.
- Reuse the existing helper before adding a new one. Search first.
- Do not move files or rename CSS classes in this plan. That belongs elsewhere.
- If an item needs a new shared helper, put pure math in `src/js/services/viewerMath.js` and DOM creation in `src/js/viewer/icoCells.js`.
- If HEAD moved and a line number is stale, find the function name and update the plan line before editing.
- Stop and ask if a fix would change manhwa alignment, gate timing, or IPC shape beyond what the item says.

## Checklist

### Shared helpers

- [x] 1. Reuse one total helper. See `src/js/viewer/viewerPipelines.js:192`, `src/js/viewer/viewerPipelines.js:1219`, `src/js/fsUtils.js:294`. Delete the two local copies in pipeline code and call `FsUtils.icoSourcesTotal`. If pipeline code should not import `FsUtils`, move the function to `services/viewerMath.js` and call it from all three places. Accept when only one total implementation remains and `npm run mocha` passes.
- [x] 2. Share the composite draw block. See `src/js/viewer/viewerPipelines.js:214` and `src/js/viewer/viewerPipelines.js:1229`. Both build a canvas, clear it, then draw each size centered vertically from left to right. Keep the two caches as they are. Extract only the canvas build into one helper. Accept when legacy and column paths call the same draw helper and an ICO with three or more sizes still paints every cell.

### Ownership and state

- [ ] 3. Remove cross-surface read in legacy bridge parking. See `src/js/viewer/viewerRender.js:183`. It reads `#manhwa-strip` class state to decide grill on an ICO bridge node. Read `Core` manhwa state or the viewport grill value instead. Accept when no `getElementById('manhwa-strip')` remains in `viewerRender.js` and legacy to manhwa toggle still carries grill correctly.
- [ ] 4. Decide the owner for wrapper grill. See `src/js/main/main.js:238` and `src/js/main/main.js:241`. Bootstrap toggles `grill-active` on `#viewer-img-wrapper`. Either keep it as documented fan-out or move it into the viewer owner. Do not keep it ambiguous. Accept when one file owns the wrapper class and the choice is noted in the checklist.
- [ ] 5. Scope the cover thumbnail format. See `src/js/main/metadataBadge.js:22`. The change moved all covers from JPEG to PNG. PNG fits ICO transparency but costs more bytes for photos. Branch on ICO or restore JPEG for non-ICO covers. Accept when ICO covers keep transparency and photo covers stay JPEG, verified by generating both covers.

### Pooling and CSS nits

- [ ] 6. Document the narrowed strip release. See `src/js/viewer/manhwaStrip.js:559`. The `else` became `else if IMG`, so `.ico-container` DIVs fall through without pooling. That is likely correct because ICO nodes detach rather than pool. Add a short comment that states this. Accept when the intent is written in code and no behavior changes.
- [ ] 7. Drop `!important` on the bridge container. See `src/css/main.css:2232`. Replace with a selector that already wins, such as the full `#viewer-bridge-layer` path used at line 2243. Accept when computed display stays flex for bridge ICO and no `!important` remains in the added rule.
- [x] 8. Rename the stale test. See `e2e/specs/03-viewer.e2e.js:210`. The name still says spritesheet continuity. The code now uses per-size row and composite. Rename to row continuity. Accept when the test name names the current mechanism and the spec still passes.

### Coverage gap

- [ ] 9. Add a Rust unit test for the new IPC shape. See `src-tauri/src/ico.rs:1` and `src-tauri/src/models.rs:123`. No test in `src-tauri/src/tests/` covers `Vec<IcoSize>`. Add one that decodes a small ICO and asserts widths, heights, sort order, and `data_url` prefix. Accept when `cargo test` with an ICO filter passes.

### Accepted, no action

- [x] 10. Width report quiet refresh. See `src/js/viewer/manhwaStrip.js:93` and line 113. Widened from armed-only to armed-or-quiet. Accepted as a replay-debugging fix in this branch. No change here.
- [x] 11. Manhwa centering and end-pin changes. See `src/js/viewer/manhwaStrip.js:227`, line 242, line 251, `src/js/viewer/manhwaStrip.js:785`, line 814, `src/js/viewer/manhwaStrip.js:1915`, `src/js/viewer/manhwaStrip.js:1956`, `src/js/viewer/manhwaStrip.js:2152`, `src/js/viewer/manhwaStrip.js:2200`. Center, middle-anchor, `length <= 2`, and `colFits` behavior. Accepted as replay-debugging fixes in this branch. No change here. Prior report lines 866 and 1127 pointed at diff hunks. The paths above are HEAD source lines.
- [x] 12. Runner promise guard. See `e2e/replay-diagnostics/runner.e2e.js:109` and line 136. `Promise.resolve` wrap around `Core.selectIndex`. Accepted as a runner hardening fix in this branch. No change here.
- [x] 13. Fixture move and `.gitignore` re-pathing. Accompanies the viewer fixture move. Accepted. No change here.
- [x] 14. Markdown spritesheet wording. `README.md` and `.agents/architecture-state.md` still say spritesheet. Out of scope for this code-only validation. Handle under docs skills when docs work is explicitly requested.
