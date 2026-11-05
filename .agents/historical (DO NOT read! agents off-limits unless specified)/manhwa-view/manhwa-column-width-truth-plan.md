Validation comparison performed against .agents/AGENTS.md and .agents/skills/validate-changes/SKILL.md before presenting. Each slice below was checked for module ownership, pure-module direction, CSS source of truth, HTML-first rendering, blast radius with runnable checks, and docs discipline.

# Manhwa column width truth plan

**Target:** Working tree in `src/js/viewer/manhwaStrip.js` and `src-tauri/src/commands/animation.rs` with directory entry fit behaviors completed.

**Scope lock:** Eliminate every guessed width (including the 800 fallback) so the column backdrop (`--strip-width`) and width fits always derive from real observed dims. Backend stays and always wins. Frontend tracking is the fallback for formats the backend cannot probe and for component-library serving with no Rust. Do not touch legacy single-image rendering, height estimation, or viewer layout tokens.

**Definitions.**
- **First reported dims:** The first real width that lands after opening a directory, from either the first decoded image or the first backend report, whichever arrives first. First paint lays out from these, never from a constant.
- **Container widest:** A per-container running maximum fed by the decode pipeline and backend reports. Reset on every directory change, never reused or persisted.
- **Backend wins:** Any backend max-width report overwrites the tracked max, including late reports.
- **Linear growth:** The tracked max only ever grows. Corrections widen the column smoothly, never shrink or jump it.
- **Finished signal:** A terminal backend emission carrying the final max (possibly 0) for the active sweep generation, so the frontend knows the number is final.

---

## Behavioral specification

### Backend sweep
- Keeps probing the directory and always reports the widest width found (existing progressive emits stay).
- Exiting a directory stops the previous sweep and starts a fresh one for the new directory (existing generation guard).
- Emits the finished signal once per sweep, even when nothing wider was found.

### Frontend tracking
- Tracks the widest width observed from images loading through the sequential pipeline. Any observed width beats the record.
- First paint uses the first reported dims. No constant fallback anywhere in the width path.
- Backend reports overwrite the tracked max on arrival. Late reports still apply.
- Svg, ico, and future unprobable formats stay frontend-measured through the same tracker.
- Width corrections only ever grow the column, keeping shifts smooth and LCP-clean.

---

## Ordered implementation slices

### Slice 1. Backend finished signal
**Status:** `[x]` Done

- [x] Emit a terminal finished payload (final max, possibly 0) at the end of each sweep in `src-tauri/src/commands/animation.rs`, under the existing generation guard, for both directory and archive paths.
- [x] Stale generations stay silent.

### Slice 2. Frontend widest truth, no guessing
**Status:** `[x]` Done

- [x] Delete the 800 fallback. Undecoded widths resolve from first reported dims, never a constant.
- [x] Add a per-container widest tracker fed by the decode pipeline, reset on every directory change.
- [x] Backend reports (progressive and finished) overwrite the tracked max.
- [x] First paint lays out from the first reported dims.
- [x] `--strip-width` and width-fit math read only the tracked max.

### Slice 3. Verification
**Status:** `[~]` Static checks done; manual runtime open

- [x] Run syntax check: `node --check src/js/viewer/manhwaStrip.js`.
- [x] Run unit test suite: `npm run mocha`.
- [x] Run Rust compilation check: `cargo check --tests`.
- [ ] Replay `manhwa-directory-entry-fits` with the entry-fit probe asserting strip width equals the true container max per entry step. (Skipped per user: manual runtime instead.)
- [ ] Manual runtime check: cold-open a large chapter and confirm one clean paint with linear-only width growth.
