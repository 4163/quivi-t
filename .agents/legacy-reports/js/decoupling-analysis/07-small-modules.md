# Small JS Modules — Decoupling Analysis

> Files: `associationsUi.js` (~134 lines), `directoryPrefs.js` (~113 lines), `navigationHistory.js` (~102 lines), `shellBackground.js` (~74 lines), `metadata.js` (~175 lines), `metadata-window.js` (~212 lines).

> Note: `Core.getState()` returns a *shallow* copy — `state.config` is the **same object reference** as `_state.config`. Any module mutating `state.config.frontend_data.x` is silently mutating real Core state outside the state machine's API.

## 1. associationsUi.js

**Exports:** `applyAssociations(statusCallback)`, `initAssociationsUi(containerId, statusCallback)`. Renders file-type association checkbox grid in Options; pushes register/unregister diffs to backend.

**Imports:** none (uses guarded `window.__TAURI__.core.invoke`). Consumed by options.js.

**DOM: Heavy** — querySelectorAll('.assoc-checkbox'), 3 buttons, fully dynamic DOM tree with inline styles.

**Coupling:** statusCallback injected by options.js; silently depends on the shared Options Apply flow (hides `btn-assoc-apply` because apply is folded into Options Save). Backend commands: get_format_status, register/unregister_associations, open_in_explorer.

**Smells:**
- Module-global mutable baseline `initialState` — hidden state tracking checkbox baselines.
- All layout in inline styles (grid/flex/gap/font sizes) — styling in JS instead of CSS.
- `container.innerHTML = ...` error interpolation without escaping.
- Direct `btn.onclick = ...` assignments that could clobber handlers.

**Verdict: needs work.**
- **Rec:** Split into pure `computeAssociationsDelta(checkboxes)` (returns `{toRegister, toUnregister}`) + a renderer taking a `formats` array. Move inline styles to CSS classes. Replace baseline-mutation with pure re-derivation (payload already has `registered`). Have options.js drive button visibility, not this module.

## 2. directoryPrefs.js

**Exports:** `DirectoryPrefs` — getSortPrefs, setSortPrefs, sortCurrentState, naturalCompare, applySort.

**Imports:** `Core` from `./core.js`. Used by fsUtils.js and filePanel.js.

**DOM: None.** Pure logic. (Best in class.)

**Coupling:** reads/mutates `state.config.frontend_data` directly (shallow-copy bypass of Core.setState). `applySort` hard-codes is_parent/is_dir/is_drive conventions (shared with fsUtils.buildDirectoryList). `naturalPagePosition` in fsUtils reuses `DirectoryPrefs.naturalCompare` (no duplication — good).

**Smells:**
- **Dead branch:** `setSortPrefs` early-returns when `!directoryPath` (L20), yet L28-30 contains an unreachable `if (!directoryPath) { fd.default_sort = ... }`.
- **Internal duplication:** default-init block duplicated in getSortPrefs and setSortPrefs.
- `sortCurrentState` does read→sort→`Core.setListAndIndex` bypassing fsUtils navigation/history path — two overlapping "apply list change" pathways.
- Natural-compare + partition bundled in a "prefs" module (persistence concern + algorithm concern mixed).

**Verdict: mostly decoupled, needs tightening.**
- **Rec:** Route writes through Core (e.g. `Core.setDirectorySortPref(path, col, desc)`). Delete the unreachable branch. Hoist default-sort normalization into mergeConfig so defaults exist once. Move naturalCompare/applySort into a shared pure `sorting.js` module.

## 3. navigationHistory.js

**Exports:** createHistoryEntry(state), recordNavigation(prev, next, options), goBack(state), goForward(state), canGoBack(), canGoForward().

**Imports:** none. Used by fsUtils.js and main.js.

**DOM: None** (dispatches a CustomEvent on window — the only window touch).

**Coupling:** coupled to the **shape** of Core state (mode, directory, archivePath, list, index). Reads `options.history` flags ('skip'/'replace') set by fsUtils — convention shared by convention. Notifies via raw `window` CustomEvent `quivit-history-changed` — inconsistent with the Core callback architecture.

**Smells:**
- **Half-implemented option:** recordNavigation returns early for both 'skip' and 'replace', but "replace last entry" never implemented — no caller passes `history: 'replace'`. Effectively a dead option branch.
- Module-level mutable stacks not in Core's state — history invisible to getState/onStateChange subscribers.
- `emitChange` via window event is the only non-consistent integration point.

**Verdict: already well-decoupled.**
- **Rec:** Implement 'replace' or remove the branch. Consider replacing the window CustomEvent with a subscriber pattern for architectural consistency. This is the model other modules should follow.

## 4. shellBackground.js

**Exports:** none — self-executing IIFE mirroring computed `--surface` into the native window via `plugin:window|set_background_color`. Deliberate leaf module (documents why it bypasses the official wrapper — value/color key mismatch).

**Imports:** none. Included non-module-style as `<script>` on all 3 pages.

**DOM: Moderate** — creates a 1×1 probe div, reads getComputedStyle, runs MutationObserver on `<html>` (data-theme) and `<head>`.

**Coupling:** zero to other JS modules (intentional). Re-observes the theming convention (data-theme attr + head style injection) but not the code. **Dead hook:** listens for `quivit:shell-sync` but nothing dispatches it. The head MutationObserver re-fires on any CSS/style edit (options preview, custom CSS) — broad trigger.

**Smells:** duplicated trigger mechanisms (MutationObserver + a custom event nobody emits); 20ms debounce re-implements a primitive used elsewhere.

**Verdict: well-decoupled leaf; minimal work.**
- **Rec:** Wire the existing `theme-preview`/`css-preview`/storage events instead of the raw head MutationObserver; drop the dead `quivit:shell-sync` listener.

## 5. metadata.js

**Exports:** `findMetadataEntry(fileNames)`, `fetchMetadata(archivePath, fileNames)`. Finds (comicinfo.xml/comet.xml/metadata.opf, root-level only) and parses into a `ComicMeta` object.

**Imports:** `FsUtils` from `./fsUtils.js` (only buildArchiveSrc). Used by main.js.

**DOM: None** for UI. (DOMParser produces a detached XML document.)

**Coupling:** depends on FsUtils.buildArchiveSrc for the fetch URL. Returned ComicMeta shape consumed by main.js + metadata-window.js (by convention). findMetadataEntry's filtering overlaps conceptually with fsUtils.loadArchive's `/\.(xml|opf)$/i` filter — two mechanisms deciding "what counts as metadata-ish."

**Smells:**
- **Duplicated parallel shapes:** parseComicInfo (28 fields) and parseOpf (same 28 keys, mostly empty strings) — OPF hand-lists ~15 `''` fillers.
- OPF `year` via parseInt(get('date')) leaves `month` always null even when full date present — silent data loss.
- parseComicInfo uses case-sensitive querySelector('Title') etc.
- Broad `catch { return null; }` (defensible for optional metadata).

**Verdict: already well-decoupled (pure logic).**
- **Rec:** Extract a shared emptyMeta/field-list so both parsers merge into it. Optionally parse OPF month. Consider injecting a fetch/URL-builder dependency for testability.

## 6. metadata-window.js

**Exports:** none — side-effect module for the secondary metadata window. Renders ComicMeta + cover, auto-fits window height, shows the window, subscribes to live theme/CSS updates.

**Imports:** none. Uses `window.__TAURI__`, localStorage, 7 getElementById calls at module top.

**DOM: Heavy** — element lookups at load, class toggling, replaceChildren, img onload/onerror wiring.

**Responsibility clusters:** (a) metadata rendering, (b) window height-fit + show orchestration (serialized promise chain `fitTail`), (c) theme/custom-CSS application.

**Coupling:**
- Protocol coupling to main.js: localStorage key `quivit-metadata-current` + Tauri event `metadata-data`.
- **Duplicated constant:** `META_MAX_INITIAL_H = 600` must match `META_MAX_H: f64 = 600.0` in config.rs — cross-language magic number.
- Theme/CSS events `theme-preview`/`css-preview` from options.js + `storage` event fallback — listens for both, so the same change can be applied twice.
- `applyTheme`/`applyCustomCss` near-verbatim copies from options.js/main.js. Note metadata-window's applyTheme omits localStorage mirroring options.js does — inconsistent.

**Smells:**
- **Primary mixed-concern offender.** Window choreography, rendering, theme application in one file.
- Triplicated applyCustomCss/applyTheme.
- Bidirectional localStorage: main.js writes `quivit-metadata-current`; metadata-window writes it back on each event — double-writer protocol.
- Top-level script mixing synchronous render with async fit/show sequencing.
- Theme application lacks the 'system' localStorage-removal path options.js has.

**Verdict: needs the most work.**
- **Rec:** Split into `metadata-render.js` (pure render(payload) → DOM), `metadata-window-fit.js` (fit/show logic), and shared `theme.js` for applyTheme/applyCustomCss. Import META_MAX_INITIAL_H from a shared constants module or query the backend. Consolidate on one live-update mechanism.

## Cross-file duplication summary

| Duplication | Locations | Verdict |
|---|---|---|
| `applyCustomCss` (identical ~8-line body) | main.js, options.js, metadata-window.js | Extract to shared theme.js |
| `applyTheme` / data-theme handling | options.js, metadata-window.js, core.js loadConfig, head scripts | 3-4 copies; consolidate |
| default_sort/directory_sort default-init | directoryPrefs.js (in-file) | Normalize once in mergeConfig |
| Metadata-ish file filtering | metadata.js vs fsUtils.loadArchive regex | Delegate to findMetadataEntry |
| ComicMeta shape construction | metadata.js parseComicInfo vs parseOpf | Share default-field template |
| META_MAX_H constant | metadata-window.js vs config.rs | Single JS source or backend query |
| applySort/naturalCompare | directoryPrefs.js reused by fsUtils | Clean — no duplication |
| History entry creation | navigationHistory.js | Clean |
| Shell background | shellBackground.js unique, re-observes theming | Extract event hook-up with theme.js |

**Dead code found:** the `history: 'replace'` branch in navigationHistory.js (no caller, not implemented as replace); the unreachable `default_sort` branch in directoryPrefs.setSortPrefs; the `quivit:shell-sync` listener in shellBackground.js (nothing dispatches it); the hidden `btn-assoc-apply` workaround in associationsUi.js.

**Overall ranking for decoupling effort:** metadata.js and navigationHistory.js are near-pure and are the templates to follow. directoryPrefs.js is pure but mutates Core state through the snapshot and has dead code. shellBackground.js is a clean leaf with a minor redundant trigger. associationsUi.js and especially metadata-window.js carry the bulk of the DOM work and mixed concerns — those two are the priority, plus the shared applyTheme/applyCustomCss consolidation.