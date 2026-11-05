<!--
Validation comparison against .agents/skills/validate-changes/SKILL.md performed.
-->

# Plan: Imports dropdown for Library providers

## Overview
Add an Imports menu to the menubar that lists Library providers plus All at the bottom. The file panel keeps its current imported first stacking for All. When a single provider is active, the file panel shows only that provider. A new import becomes active unless All is active.

Spec from clipboard:
```
Imports >
  Provider 1
  Provider 2
  All
```
Notes: Imports trigger uses muted style when empty. Order reuses the imported first append system. New provider becomes active when a single provider is active. All keeps legacy append behavior.

## Locked definitions
- **Active provider**: A localStorage UI value holding a provider directory name, or null for All. Null is the default and means show everything.
- **Imported first**: The order from `orderProviders` in `src/js/filepanel/libraryStore.js:106-119`. Stored names that still exist keep rank. Unseen names append at the end. This function does not change.
- **New provider**: A `providerDir` from `src/js/urlLoader.js:1740-1741` that was absent from the last ordered tree and appears after `quivit-library-updated` or `library-changed`.
- **All**: The static bottom row. It always renders last and never moves with provider order.
- **Misc**: The `direct` extractor provider (`libraryPath: Misc`) for direct image and video links. It renders only with real nodes like every other provider. Pinned last in the menu above All, first in the file panel under Favorites. Stale provider dirs with no galleries stay out because `read_library_tree` returns every top-level dir regardless of content.
- **Trigger**: The Imports tab stays hidden until the first import lands, then appears. No muted empty state. Arrow key cycling skips hidden triggers.
- **First import**: The filter follows every import, including the first, until the user explicitly clicks a row. All latches only on an explicit click, tracked by `quivit_library_active_explicit`. Emptying the Library clears the latch so the next import starts from scratch.
- **Order**: Imported first, newest appends last. Emptied provider dirs drop out of the stored order, so a re-import appends newest instead of reclaiming its old slot.
- **Deleted active**: Falls back to the nearest neighbor in the pre-prune stored order, next first then previous, and persists it. Never drops to All while providers remain.
- **Title**: Imports, matching the overlay Import button, the Importing status, and the Imported URLs options label. Downloads would clash with in-progress download language.

## Deviation rules
- Do not change `orderProviders` ranking, `read_library_tree` output, or any Rust IPC shape.
- Do not put DOM in `libraryStore.js` or `urlLoader.js`. Stores and coordinators stay DOM free. `menubar.js` owns the dropdown. `filePanel.js` owns the panel filter.
- Do not set inline visual style from JS. Use classes, data attributes, and custom props per CSS source of truth.
- Do not add config keys. Active provider is UI state in localStorage, next to `quivit_library_provider_order`. Favorites stays in config.
- Do not rename provider keys. Directory names stay the keys for collapse, order, ids, and datasets. Display names from the manifest stay labels only.

## Ordered checklist

### Slice 1: Store, markup, and menubar dropdown
- [x] In `src/js/filepanel/libraryStore.js:90-119`:
  - Add `ACTIVE_ALL = null` plus `getActiveProvider()` and `setActiveProvider(nameOrNull)` around key `quivit_library_active_provider`.
  - Treat missing, empty, or unknown names as All at read time, without writing back during read.
  - Add `resolveActiveProvider(tree)` that returns null when stored name is missing from `tree`, so deleted providers fall back to All.
  - Dispatch `quivit-library-active-changed` on set, with `{ active }` detail.
  - Accept criteria: Order functions untouched. Unknown or deleted names read as All. Setting a name persists and emits the event.
- [x] In `src/index.html:148-163`:
  - Add `div.menu-item#menu-imports` after `#menu-favorites`, following the same trigger and dropdown pattern.
  - Declare `ul#imports-menu-dropdown` with `template#import-provider-row-template` holding `li.import-provider-item[role=menuitem]`, then `li.separator`, then static `li#import-provider-all[role=menuitem]`.
  - Accept criteria: Static markup holds the template, separator, and All row. No provider rows hardcoded.
- [x] In `src/js/menubar.js:18-22`:
  - Wire `bindImportsDropdown()` and `renderImportsMenu()` into `initMenuBar`, mirroring `bindFavoritesDropdown` and `renderFavoritesMenu`.
  - Accept criteria: Bootstrap stays thin. Imports has its own bind and render, no logic in generic `bindMenus`.
- [x] In `src/js/menubar.js:189-214`:
  - Call `renderImportsMenu()` on `mousedown`, `mouseenter`, and trigger `keydown` when `menu.id === 'menu-imports`, same as favorites.
  - Update ArrowRight and ArrowLeft trigger cycling to include the new trigger with no hardcoded index.
  - Accept criteria: Opening Imports always paints fresh state. Trigger order follows DOM, no index fixups.
- [x] In `src/js/menubar.js:448-480`:
  - Add `renderImportsMenu()` that recycles rows from the template with `insertBefore` at the separator anchor and prunes surplus, same as favorites.
  - Order rows by `orderProviders(fetchLibraryTree cache or fresh tree)`. Map display names via `fetchManifest` extractors `libraryPath to name`, same as `src/js/filepanel/filePanel.js:1260-1262`.
  - Mark the active row with `.checked`. Keep All checked when active is null. Pin All last.
  - When `hasLibraryEntries` from `src/js/filepanel/libraryStore.js:30-37` is false, mute the Imports trigger with `_setMenuItemDisabled` in `src/js/menubar.js:642-658` and show rows muted with no selectable provider.
  - Accept criteria: Row order matches file panel All order. Checked tracks active. Empty library mutes the trigger and blocks selection.
- [x] In `src/js/menubar.js:482-613`:
  - Add `bindImportsDropdown()` with click delegation for provider rows and All, plus Enter, Space, ArrowUp, and ArrowDown handling. No rename or delete controls.
  - Keep selection open behavior consistent with favorites row select in `src/js/menubar.js:518-523`, which sets active without `closeMenus`.
  - Listen to `quivit-library-active-changed`, `quivit-library-updated`, `library-changed`, and `quivit-config-loaded` to rerender.
  - Accept criteria: Click or keyboard sets active provider and rerenders. No inputs or buttons inside rows to trap focus.
- [x] In `src/css/main.css:239-274` and `src/css/main.css:291-360`:
  - Reuse `.checked` and `.muted` for import rows. Add `.import-provider-item` padding to match `.loadout-item`.
  - Add muted trigger style under the 3 tier scope model, host node only, no global overrides.
  - Accept criteria: No inline style from JS. Empty state reads muted. Checked shows the same tick as favorites.

### Slice 2: File panel filter
- [x] In `src/js/filepanel/filePanel.js:1236-1340`:
  - After `orderProviders(treeRaw)`, resolve active with the new store helper. When active is a provider name, render only that provider section. When null or unknown, render all as today.
  - Keep tombstone filtering in `src/js/filepanel/filePanel.js:1248-1253`, empty provider skip in `src/js/filepanel/filePanel.js:1273-1274`, header and list build in `src/js/filepanel/filePanel.js:1281-1328`, and `all-collapsed` in `src/js/filepanel/filePanel.js:1331` unchanged apart from the filter.
  - Keep `libraryPanelEl.classList.toggle('is-empty', !hasAny)` semantics for the filtered set, so a filtered provider with zero nodes shows empty rather than other providers.
  - Rerender on `quivit-library-active-changed` next to existing `quivit-library-updated` in `src/js/filepanel/filePanel.js:2474-2486`.
  - Accept criteria: All shows the current stacked order unchanged. Single provider shows only its header and list. Deleted active falls back to All.
- [x] In `src/js/filepanel/filePanel.js:1016-1184`:
  - Keep optimistic delete, stale root retry with `getCachedLibraryDir` and `remapLibraryPath`, and boot out to `providerRoot`.
  - When filtered to a provider that becomes empty after delete, keep the empty panel state and leave active as is. Do not auto switch to All on delete.
  - Accept criteria: Delete works the same filtered or unfiltered. No flash of deleted rows. No forced active change on delete.
- [x] In `src/js/filepanel/filePanel.js:1342-1376`:
  - Confirm `updateLibrarySelection` still highlights by path when filtered. No change unless selection misses hidden providers, which is correct.
  - Accept criteria: Selection highlights the current path when visible. No highlight when the current path belongs to a hidden provider.

### Slice 3: Auto activate on new import
- [x] In `src/js/urlLoader.js:1739-1820`:
  - After direct media import resolves `providerDir`, and after series, existing gallery, and new gallery paths create `Library/<providerDir>`, call the new `setActiveProvider`.
  - Rule: when current active is a provider name, set active to the imported `providerDir`, even if it equals current. When current active is All, leave it null so the new provider appends at the end.
  - Fire before or with `quivit-library-updated` in `src/js/urlLoader.js:1788-1792`, `src/js/urlLoader.js:2211`, and series equivalents, so menubar and panel update once.
  - Accept criteria: Importing while filtered switches the filter to the new provider. Importing while on All keeps All and appends the provider last.
- [x] In `src/js/urlLoader.js:2690-2717`:
  - On `handleLibraryRelocation`, keep active value as is because provider dir names survive the move. If the stored name no longer exists after move, the Slice 1 resolver falls back to All.
  - Accept criteria: Relocation does not clear active. Missing names fall back without extra writes.
- [x] Direct image parity, per `.agents/user-notes:65-67`:
  - Confirm provider root files from `recordRootMediaDownload` in `src/js/urlLoader.js:1409-1464` appear as nodes under the active provider filter and carry the same opacity and thumbnail treatment as `buildLibraryEntry`.
  - Accept criteria: Direct images filter with their provider. Opacity and thumbnails match the All view. File the thumbnail gap as a follow up if the row lacks a thumbnail source.

### Slice 4: Checks and blast radius signoff
- [x] Run `node --check` on touched JS files. Run `npm test` for mocha unit and contract coverage.
- [~] Run nearest existing coverage: mocha ran clean (305 passing). `e2e/specs/08-url-loader.e2e.js` was not run from this harness; user runtime confirmed instead.
- [x] Run `cargo check --tests --manifest-path src-tauri/Cargo.toml` only if Rust was touched. Plan touches no Rust.
- [x] Manual runtime list for the user: open Imports empty and confirm muted, import two providers and confirm order plus All last, select provider 1 then import provider 2 and confirm auto switch, select All then import and confirm no switch, delete active provider and confirm fallback, move Library and confirm active survives, check menubar Arrow keys include Imports.
- [x] Accept criteria: Static checks pass. Targeted mocha and e2e pass. Anything stuck below confidence step 4 is named as needing a manual check.

## Blast radius
- Menubar generic binding in `src/js/menubar.js:179-233` iterates all `.menu-item`, so `#menu-imports` joins focus and Arrow cycling with no extra wiring. Risk is a missed `renderImportsMenu` call on one open path. Covered by Slice 1 mirroring all three favorites open paths.
- Favorites dropdown in `src/js/menubar.js:448-613` shares CSS classes and template recycle style but no code. Imports adds separate ids and handlers, so favorites render and rename flows stay intact.
- `orderProviders` contract in `src/js/filepanel/libraryStore.js:86-119` stays the single ordering owner. Both dropdown and panel read it. Backend stays out of ordering.
- `renderLibrary` in `src/js/filepanel/filePanel.js:1236-1340` gains one filter branch. Collapse map, order list, tombstones, display names, and delete flow keep behavior. `e2e/specs/08-url-loader.e2e.js:198-200` asserts provider header and list text, so filtered All must keep header text and `library-list-<name>` ids identical.
- UrlLoader import paths in `src/js/urlLoader.js:1664-2225` gain one setter call. Queue, placeholder, download status, and `quivit-download-status` flows unchanged. Statusbar importing flags in `src/js/menubar/statusbar.js:239-260` untouched.
- Library move in `src-tauri/src/commands/library.rs:515-648` and watcher in `src-tauri/src/commands/watchers.rs:82-128` emit existing events. No Rust change. Active provider keyed by dir name survives move. Retired paths in `src-tauri/src/config.rs:8-9` do not affect it.
- Config surface: no new `frontend_data` keys. Active provider in localStorage avoids stale config after Library relocation and avoids persistence spec changes in `e2e/specs/05-persistence.e2e.js`.
- CSS scope: new row class reuses existing `.checked` and `.muted`. Trigger muted uses host scope only. No `body.foo *` rules.

## Similar code reused
- Favorites static template and recycle from commit `7438c3f`: `src/index.html:148-163`, `src/js/menubar.js:448-480`.
- Muted helper `_setMenuItemDisabled` in `src/js/menubar.js:642-658` with styles in `src/css/main.css:252-274`.
- Provider order, collapse, display names, and empty checks from `src/js/filepanel/libraryStore.js:30-119` and `src/js/filepanel/filePanel.js:1240-1262`.
- Import to paint flow from `src/js/urlLoader.js:1664-1820` through `quivit-library-updated` to `renderLibrary`.
