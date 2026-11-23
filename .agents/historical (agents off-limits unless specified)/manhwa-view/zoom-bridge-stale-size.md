# Zoom bridge stale size diagnosis

Note: compared against `.agents/skills/validate-changes/SKILL.md` before presenting. No prod files were touched and no code changes are proposed here. Diagnostics only.

Scenario: `e2e/scenarios/zoom-bridge-stale-size.json` (legacy view, phosphor, center file of ch. 75, zoom in 4 times, toggle to manhwa, toggle back). Probe: `zoom-handoff` in `e2e/replay-diagnostics/investigation.js`.

## Symptom

After zooming in legacy view, a manhwa round trip flashes the image at a stale size on return. The settled size matches neither the pre-toggle zoom nor a fresh fit.

## Primary root cause

- **Failing component**: shared zoom state in `src/js/services/viewerMath.js:376` (single `_scale`, no save or restore), written by the strip on entry (`src/js/viewer/manhwaStrip.js:1935`).
- **Mechanism**: Legacy zoom lives only in the shared `viewportState`. Four zoom presses take it to 2.0768. On entry the strip overwrites it with its column scale (1.4782) and nothing saves the legacy value. The bridge parks after the overwrite, freezing the strip scale. On return, legacy never re-applies fit (`viewerRender.js:815` skips when `fitModeGen` is unchanged), so it keeps the leftover. Final size 1.4782 equals the strip scale and equals neither the user zoom (2.0768) nor a fresh fit (1.0).
- **Why existing logic failed**: No module owns zoom memory across the toggle. Core persists fit and scaling modes but not zoom. Each side behaves correctly alone, so the staleness only exists in the round trip, and the frozen bridge layer can visibly disagree with the live paint during the handoff.

## Timeline evidence

- Steps 1-4 take wrapper scale 1 to 1.4783 to 1.6557 to 1.8543 to 2.0768, one 1.12x step per press.
- Step 5 entry carries strip scale 1.4782. Step 6 return shows bridge frozen at 1.4782 with the active rect at the same scale through all sampled frames.
- Bridge `--bridge-sx` 1.4782 against pre-toggle wrapper scale 2.0768 is a ~40% disagreement baked in before the return toggle is pressed.
- The single-frame flash itself was not sampled in these runs, so the flash frame is inferred from the proven stale condition rather than directly captured.

## Non-specified anomalies flagged

- Ignored per instruction. The per-press zoom motion hits (~73 per zoom step) are legitimate user zoom, noted only so they are not mistaken for the defect.

## Boundaries and open questions

- `viewportState` is shared mutable state written by legacy gestures, the strip, and the handoff path, saved by nobody. The bridge pool freezes whatever it reads at park time.
- Per `.agents/AGENTS.md`: one owner per concern (zoom memory across toggles currently has none), no cross-module reach-in for any reconciliation.
- Open: whether the toggle should restore the exact pre-toggle zoom or reset to fit. Current behavior is neither, it is strip residue.
