*This report was compared against `.agents/skills/validate-changes/SKILL.md` and `.agents/AGENTS.md`.*

# CSS architecture and decoupling audit: main.css and global.css

This document audits the monolithic stylesheet `src/css/main.css`, comprising 2,805 lines, and the shared tokens sheet `src/css/global.css`, comprising 278 lines. It establishes an exhaustive line-by-line decoupling plan into 7 surface stylesheets under `src/css/main/`, identifies cascade and specificity hazards, aligns stylesheet rules with the JavaScript refactor roadmap in `.agents/major-refactor/roadmap.md`, and catalogs all `validate-changes` rule breaks with exact `file:line` citations.

## Line-by-line surface ownership map of main.css and global.css

The monolithic stylesheet `src/css/main.css` combines 8 distinct application concerns into one file. Slices in Phases 3 through 6 decouple JavaScript modules by DOM surface including `workspace.js`, `menubar.js`, `filePanel.js`, `viewer.js`, `manhwaStrip.js`, `statusbar.js`, and overlay managers. Splitting `main.css` into matching stylesheets provides each surface owner with exclusive authority over its visual rules.

### Surface stylesheet destinations

1. `src/css/global.css`: cross-window tokens, CSS resets, typography defaults, shared `.hidden` utility, universal scrollbar styling, and offscreen measurement probe. Loaded by `src/index.html`, `src/options.html`, and `src/metadata.html`.
2. `src/css/main/workspace.css`: main window flex root layout, `#workspace` container, 4-way docking orientations, detached surface visibility rules for `?surface=fileList` and `?surface=main`, panel resize handle layout, and `body.is-importing-url` interaction locks.
3. `src/css/main/menubar.css`: `#menubar`, menubar spacer, menu links, items, triggers, dropdown menus, flyout submenus, dark theme submenu shadows, aiming hover protection, checkmarks, shortcuts, favorites loadout rows, and imports provider rows.
4. `src/css/main/file-panel.css`: `#file-panel` container, header top, breadcrumb, search input, action toolbar buttons, archive metadata badge button, favorites panel, library panel, defensive deletion buttons, column headers, column resizers, virtualized `#file-list`, scroll spacer, measurement sentinels, list item grid cells, item icons, refresh pulse animations, row selection/hover/search-match states, and thumbnail grid card virtualization.
5. `src/css/main/viewer.css`: `#viewport` container, checkerboard pattern, `#viewport.empty`, single-view `#viewer-img-wrapper`, `.viewer-img`, `.viewer-video`, `#viewer-bridge-layer`, single-view WebGL `#viewer-filter-canvas`, Lanczos canvas `#viewer-lanczos-canvas`, SVG pump, `#img-grill`, `#img-grill-border`, `#viewer-ico-row`, legacy `.ico-container` and `.ico-size` cells, single-view audio controls `.audio-control-container`, `#btn-audio-toggle`, volume popover, `#audio-volume-slider`, `#viewport.cursor-hidden`, `#fullscreen-exit-hint`, and `#fullscreen-exit-region`.
6. `src/css/main/manhwa.css`: `#manhwa-strip`, `#viewport.manhwa-active #manhwa-strip`, strip spacers, `.manhwa-slot`, subpixel slot seam overlap, `#manhwa-slot-grill`, `.manhwa-slot-backdrop`, raw slot media, image scaling modes, `#manhwa-filter-canvas`, `#manhwa-audio-overlay`, per-slot video audio pills `.manhwa-volume`, `.manhwa-volume-toggle`, popover, slider, manhwa-specific ICO cell backdrops, and `#manhwa-svg-pump-layer`.
7. `src/css/main/statusbar.css`: `#statusbar` flex container, `#statusbar.hidden`, `.refreshing` pulse animation, `.status-filename`, readout items including `.status-spread`, `.status-manhwa`, `.status-dims`, `.status-index`, `.status-zoom`, `.status-fit`, `.status-scaling`, `.status-filter`, and `.status-version`, readout separator dots, scroll-zoom indicator `.status-scroll-zoom`, and viewport indicator overlay badges `#spread-indicator` and `#manhwa-indicator`.
8. `src/css/main/overlays.css`: `#drop-overlay`, `#password-overlay`, `#url-overlay`, prompt cards, icons, input fields, action buttons, error text, `@container overlay` responsive adjustments, drop zone drag-over and unsupported states, and loading states.

### Contiguous line-by-line mapping of main.css

Every contiguous block from line 1 through line 2805 maps to a target stylesheet. Zero lines remain unassigned.

| Line Range | Target Stylesheet | Selectors and Elements Covered | Description |
|---|---|---|---|
| `1-5` | `src/css/main/workspace.css` | `body` | Main window flex column root container |
| `6-10` | `src/css/main/viewer.css` | `body.cursor-move` | Viewport pan drag cursor |
| `11-18` | `src/css/main/workspace.css` | `body.resizing-panel`, `body.resizing-panel-vertical` | Panel drag resize cursor states |
| `19-22` | `src/css/main/file-panel.css` | `body.resizing-col` | File list column drag resize cursor state |
| `23-29` | `src/css/main/file-panel.css` | `.offscreen-measure` | Hidden offscreen clone for column width calculation |
| `30-456` | `src/css/main/menubar.css` | `#menubar`, `.menubar-spacer`, `.menu-link`, `.menu-item`, `.menu-trigger`, `.menu-dropdown`, `.submenu`, `.loadout-*`, `.import-provider-*` | Menubar chrome, dropdown menus, submenus, dynamic row templates |
| `457-514` | `src/css/main/workspace.css` | `#workspace`, `#workspace[data-file-list-position]`, `:root[data-workspace-surface] #workspace` | Workspace docking layout, border adjustments, detached surface hiding |
| `515-888` | `src/css/main/file-panel.css` | `#file-panel`, `#file-panel-header-top`, `#file-panel-favorites`, `#favorites-list`, `#file-panel-library`, `.lib-remove`, `#file-panel-breadcrumb`, `.file-panel-search`, `.file-panel-actions`, `.icon-btn` | File panel frame, favorites section, library tree, breadcrumb, search, action buttons |
| `889-896` | `src/css/main/file-panel.css` | `#status-metadata-badge`, `#status-metadata-badge.is-visible` | Archive metadata button visibility in file panel action bar |
| `897-1026` | `src/css/main/viewer.css` | `.audio-control-container`, `#btn-audio-toggle`, `.volume-popover`, `#audio-volume-slider` | Viewport fixed audio control pill, toggle button, popover, volume slider |
| `1027-1136` | `src/css/main/manhwa.css` | `.manhwa-volume`, `.manhwa-volume-toggle`, `.manhwa-volume-popover`, `.manhwa-volume-slider` | Per-slot manhwa video audio pill, toggle button, popover, volume slider |
| `1137-1144` | `src/css/main/viewer.css` & `manhwa.css` | `.audio-control-container:has(:focus-visible)`, `.manhwa-volume:has(:focus-visible)` | Keyboard focus ring on audio pills, split per surface |
| `1145-1321` | `src/css/main/file-panel.css` | `#file-panel-header`, `.header-cell`, `.col-resizer`, `.col-name`, `.col-date`, `.col-size`, `.col-dims`, `#file-panel.col-hide-*`, `#file-list`, `.scroll-spacer`, `#file-list-sentinel`, `#file-list-thumbnail-sentinel`, `#file-list li`, `#favorites-list li`, `.library-provider-list li` | File list column headers, resize handles, column visibility, virtual scroll containers, sentinels, row grid templates |
| `1322-1380` | `src/css/main/file-panel.css` | `#file-panel.refreshing #file-panel-header-top::after`, `@keyframes refresh-bar-sweep`, `#file-panel.refreshing #file-list`, `@keyframes refresh-list-pulse` | File panel top sweep line animation and list pulse animation on directory reload |
| `1381-1399` | `src/css/main/statusbar.css` | `#statusbar.refreshing`, `@keyframes statusbar-refresh-pulse` | Statusbar reload pulse animation and keyframe |
| `1400-1727` | `src/css/main/file-panel.css` | `#file-list li:hover`, `.selected`, `.in-view`, `.search-match`, `.item-name`, `.item-label`, `.item-ext`, `.item-date`, `.item-size`, `.item-dims`, `.view-mode-thumbnail`, `--thumbnail-size`, `.item-thumbnail-*` | File row states, cell typography, thumbnail view mode, card layouts, placeholder icons, native shell icon background |
| `1728-1763` | `src/css/main/workspace.css` | `#panel-resize-handle`, `#workspace[data-file-list-position] #panel-resize-handle` | Docking-dependent layout and hover/dragging styling of the panel resize handle |
| `1764-1789` | `src/css/main/viewer.css` | `#viewport`, `#viewport.empty` | Viewport container, transparent checkerboard background, empty container background |
| `1790-1941` | `src/css/main/manhwa.css` | `#manhwa-strip`, `#viewport.manhwa-active #manhwa-strip`, `#manhwa-strip-spacer-top`, `#manhwa-strip-spacer-bottom`, `.manhwa-slot`, `.manhwa-slot+.manhwa-slot`, `#manhwa-slot-grill`, `.manhwa-slot-backdrop`, slot images/videos, scaling rules | Manhwa strip flex column, spacers, slot sizing, subpixel seam overlap, group grill bed, slot backdrops, media rendering |
| `1942-1957` | `src/css/main/viewer.css` | `#viewport.manhwa-active #viewer-img-wrapper`, `#viewport.manhwa-active #viewer-lanczos-canvas`, `#viewport.manhwa-active #viewer-filter-canvas`, `#viewport.manhwa-active #viewer-svg-pump`, `#viewport.manhwa-active.manhwa-warmup #viewer-filter-canvas` | Single-view element hiding rules and warmup frame retention when manhwa strip is active |
| `1958-1960` | `src/css/main/statusbar.css` | `#viewport:not(.manhwa-active) #manhwa-indicator` | Manhwa badge overlay hiding rule when manhwa mode is inactive |
| `1961-1965` | `src/css/main/viewer.css` | `#viewport.manhwa-active .audio-control-container` | Viewport audio control pill hiding rule when manhwa mode is active |
| `1966-1970` | `src/css/main/viewer.css` | `#viewport.cursor-hidden`, `#viewport.cursor-hidden *` | Inactivity cursor hiding rule in viewport |
| `1971-2069` | `src/css/main/viewer.css` | `#fullscreen-exit-hint`, `#fullscreen-exit-key`, `#fullscreen-exit-region`, `#fullscreen-exit-btn`, `body.fullscreen-exit-visible`, `body.fullscreen-active` | Fullscreen exit keyboard reminder badge and top hover exit button |
| `2070-2286` | `src/css/main/overlays.css` | `#drop-overlay`, `#password-overlay`, `#url-overlay`, `.overlay-prompt`, `.overlay-field`, `.url-field`, `.overlay-error`, `@container overlay`, `.drop-hint`, `.drag-over`, `.unsupported`, `.loading` | Center prompt overlays for file drop, encrypted archive password entry, and URL gallery import |
| `2287-2306` | `src/css/main/workspace.css` | `body.is-importing-url :is(#menubar, #file-panel)`, `body.is-importing-url :is(#menubar, #file-panel) *`, hover rules | Import activity state disabling interaction across menubar and file panel |
| `2307-2332` | `src/css/main/statusbar.css` | `#spread-indicator`, `#manhwa-indicator`, `#spread-indicator:empty`, `#manhwa-indicator:empty` | Viewport overlay badge indicators for spread reading mode and manhwa mode |
| `2333-2483` | `src/css/main/viewer.css` | `#viewer-img-wrapper`, `.viewer-img`, `.viewer-video`, `.viewer-img.bridge`, `.viewer-video.bridge`, `#viewer-bridge-layer`, `#viewport[data-scaling]`, `.svg-pump-live`, `#viewer-svg-pump.hidden`, `#viewer-lanczos-canvas`, `#viewer-filter-canvas`, `#viewport[data-filter]` | Single-view transformed image wrapper, active image pool, bridge retirement layer, scaling modes, WebGL and Lanczos output canvases |
| `2484-2559` | `src/css/main/manhwa.css` | `#manhwa-filter-canvas`, `#viewport.manhwa-active #manhwa-filter-canvas`, `#manhwa-audio-overlay`, `#manhwa-audio-overlay .manhwa-volume`, `#viewport.manhwa-active[data-filter] #manhwa-strip`, `#manhwa-svg-pump-layer` | Manhwa column WebGL filter canvas, audio overlay container, column filter raw slot hiding rules, SVG pump layer |
| `2560-2565` | `src/css/main/viewer.css` | `.viewer-img[data-svg-bounds]` | Base width and height constraints on shrink-wrapped SVG elements |
| `2566-2607` | `src/css/main/viewer.css` | `#img-grill`, `#img-grill.active`, `#img-grill-border`, `#img-grill-border.active` | Single-view opaque backdrop diagonal line pattern and border shadow |
| `2608-2674` | `src/css/main/viewer.css` | `#viewer-ico-row`, `#viewer-img-wrapper[data-ico="true"]`, `.ico-container`, `.ico-size`, `.ico-size-backdrop`, `#viewer-img-wrapper.grill-active .ico-size[data-ready] .ico-size-backdrop` | Single-view ICO entry row, container, size cells, and cell backdrop pattern |
| `2675-2682` | `src/css/main/manhwa.css` | `#manhwa-strip.grill-active .manhwa-slot[data-ready] .ico-size[data-ready] .ico-size-backdrop`, `.manhwa-slot[data-ico="true"] > .manhwa-slot-backdrop` | Manhwa strip ICO slot backdrop styling and default backdrop suppression |
| `2683-2692` | `src/css/main/viewer.css` | `.ico-size > img` | Shared ICO size image rendering inside `.ico-size` |
| `2693-2805` | `src/css/main/statusbar.css` | `#statusbar`, `#statusbar.hidden`, `.status-filename`, `.status-spread`, `.status-manhwa`, `.status-dims`, `.status-index`, `.status-zoom`, `.status-fit`, `.status-scaling`, `.status-filter`, `.status-version`, separator dots, `.status-scroll-zoom`, `#statusbar.action-held`, `#statusbar.action-latched` | Statusbar chrome, file name, numeric metadata readouts, separator dots, scroll-zoom modifier indicator |

### Line mapping of global.css

`src/css/global.css` contains 278 lines. It provides tokens and resets shared across `index.html`, `options.html`, and `metadata.html`.

| Line Range | Category | Content and Selectors | Audit Notes |
|---|---|---|---|
| `1-90` | Root tokens | `:root` token block with light theme palette, syntax tokens, layout dimensions, typography scale (`--fs-8` through `--fs-50`), and opaque grill variables | Retain in `global.css`. Add missing tokens `--on-accent`, `--menu-shadow-right`, `--menu-shadow-left`, `--favorite-star`, and `--backdrop-scrim`. |
| `91-131` | Dark theme media query | `@media (prefers-color-scheme: dark)` palette overrides and `.assoc-mascot-*` filter | Lines `127-130` contain `.assoc-mascot-svg` and `.assoc-mascot-box`. These belong exclusively to the Options window (`options.css`) and should be moved out of `global.css`. |
| `133-170` | Explicit dark theme | `:root[data-theme="dark"]` manual theme override block | Lines `166-169` repeat the `.assoc-mascot-*` filter. Move to `options.css`. |
| `171-232` | Reset and base elements | `*`, `*::before`, `*::after`, `:focus`, `:focus-visible`, `html`, `body`, `button`, `input` | Universal reset, typography root, and form control baseline. Retain in `global.css`. |
| `233-237` | Shared utility | `.hidden { display: none !important; }` | Universal visibility utility. Retain in `global.css`. |
| `238-262` | Custom scrollbars | `:root, *`, `::-webkit-scrollbar*` | Universal thin scrollbar styling. Retain in `global.css`. |
| `263-272` | Measurement probe | `.measure-probe` | Hidden DOM probe for text measurement. Retain in `global.css`. |
| `274-276` | Viewer image placeholder | `.viewer-img.is-placeholder { display: none; }` | Misplaced rule. `.viewer-img` belongs exclusively to `src/index.html` and should move to `src/css/main/viewer.css`. |

### Component consolidation of scattered rules

Several components in `main.css` have rule blocks scattered across unrelated sections of the file. Splitting into surface stylesheets consolidates these fragmented blocks into their target sheets.

1. Statusbar refreshing animation:
   `main.css:1381-1399` defines `#statusbar.refreshing` and `@keyframes statusbar-refresh-pulse` directly between file panel header rules and file list item rules. In the split, these lines move into `src/css/main/statusbar.css` alongside `#statusbar` at `main.css:2694-2708`.
2. Viewport indicator badges:
   `main.css:1948` hides `#spread-indicator` when `#viewport.manhwa-active` is set. `main.css:1958-1960` hides `#manhwa-indicator` when manhwa is inactive. `main.css:2307-2332` defines the layout, borders, font size, and padding for `#spread-indicator` and `#manhwa-indicator`. `main.css:2719, 2732, 2741, 2745` defines the matching statusbar badges `.status-spread` and `.status-manhwa`. Because `menubar/statusbar.js` is the sole writer for both statusbar indicators and viewport indicator badges per `.agents/architecture-state.md:62`, all `#spread-indicator` and `#manhwa-indicator` rules consolidate in `src/css/main/statusbar.css`.
3. Viewport audio controls versus manhwa slot audio pills:
   `main.css:897-1026` defines single-view audio controls for `.audio-control-container`, `#btn-audio-toggle`, `.volume-popover`, and `#audio-volume-slider` directly after `#status-metadata-badge` inside the file panel section. `main.css:1027-1136` defines `.manhwa-volume` per-slot pills in the same file panel section. `main.css:1137-1144` rings both with focus outlines. `main.css:1961-1965` hides `.audio-control-container` when manhwa is active. `main.css:2504-2525` styles `#manhwa-audio-overlay`. In the split:
   - Viewport audio rules from `main.css:897-1026, 1137-1144, 1961-1965` move to `src/css/main/viewer.css`.
   - Manhwa video audio rules from `main.css:1027-1136, 1137-1144, 2504-2525` move to `src/css/main/manhwa.css`.
4. Opaque grill rules:
   Manhwa strip grill rules live at `main.css:1853-1915`. Single-image grill rules live at `main.css:2566-2607`. ICO backdrop grill rules live at `main.css:2647-2682`. In the split, single-view grill rules covering `#img-grill`, `#img-grill-border`, and `.ico-size-backdrop` consolidate in `src/css/main/viewer.css`, while manhwa grill rules covering `#manhwa-slot-grill`, `.manhwa-slot-backdrop`, and `#manhwa-strip.grill-active .manhwa-slot[data-ready] .ico-size-backdrop` consolidate in `src/css/main/manhwa.css`.
5. ICO entry row and size cells:
   `main.css:2393-2402` defines ICO bridge layer transforms. `main.css:2411-2421` defines ICO pixelated scaling. `main.css:2477, 2480` defines ICO filter canvas opacity hiding. `main.css:2531` defines manhwa slot ICO filter hiding. `main.css:2608-2692` defines `#viewer-ico-row`, `.ico-container`, and `.ico-size`. In the split, single-view ICO rules consolidate in `src/css/main/viewer.css`, while manhwa slot ICO rules consolidate in `src/css/main/manhwa.css`.
6. Fullscreen exit chrome:
   `main.css:1971-2069` defines `#fullscreen-exit-hint`, `#fullscreen-exit-region`, and `#fullscreen-exit-btn`. In the split, these rules consolidate into `src/css/main/viewer.css`, which owns fullscreen viewport overlay interactions.
7. Center overlays:
   `main.css:2070-2286` defines `#drop-overlay`, `#password-overlay`, and `#url-overlay`. In the split, these rules consolidate in `src/css/main/overlays.css`.

---

## DOM link order and cascade or specificity hazards

### Document head stylesheet load sequence

In `src/index.html`, `src/css/main.css` is replaced by the 7 surface stylesheets loaded sequentially after `global.css` and prior to `themePrePaint.js` and `<style id="custom-css"></style>`:

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="QuiviT, standalone image and comic viewer." />
  <title>QuiviT</title>
  <link rel="stylesheet" href="/css/global.css" />
  <link rel="stylesheet" href="/css/main/workspace.css" />
  <link rel="stylesheet" href="/css/main/menubar.css" />
  <link rel="stylesheet" href="/css/main/file-panel.css" />
  <link rel="stylesheet" href="/css/main/viewer.css" />
  <link rel="stylesheet" href="/css/main/manhwa.css" />
  <link rel="stylesheet" href="/css/main/statusbar.css" />
  <link rel="stylesheet" href="/css/main/overlays.css" />
  <script src="/js/shared/themePrePaint.js"></script>
  <style id="custom-css"></style>
</head>
```

This sequence follows the structural hierarchy of the application:
1. `global.css`: tokens and typography resets.
2. `workspace.css`: outer layout framework and docking slots.
3. `menubar.css`: top navigation bar.
4. `file-panel.css`: left navigation panel and list scroller.
5. `viewer.css`: primary media canvas and single-view pipeline.
6. `manhwa.css`: alternative long-strip reading mode that stacks on top of viewport.
7. `statusbar.css`: bottom telemetry readout and floating indicators.
8. `overlays.css`: modal prompt cards that occlude the workspace.

### Cross-surface specificity and order dependencies

When breaking a 2,805-line file into multiple sheets, selectors that previously depended on appearance order in `main.css` could behave differently if order changes. Every cross-surface selector in `main.css` was analyzed:

1. Workspace surface detachment versus element base dimensions:
   - In `file-panel.css`, `#file-panel` sets `width: var(--panel-w); min-width: var(--panel-min-w); max-width: var(--panel-max-w);` with specificity `(0, 1, 0)`.
   - In `workspace.css`, `:root[data-workspace-surface="fileList"] #workspace > #file-panel` sets `width: 100%; max-width: none; border: 0;` with specificity `(0, 2, 1)`.
   - In `workspace.css`, `#workspace:is([data-file-list-position="top"], [data-file-list-position="bottom"]) > #file-panel` sets `width: 100%; max-width: none; height: clamp(...)` with specificity `(0, 2, 1)`.
   Because the docking and detachment selectors carry higher specificity `(0, 2, 1)` than the element selector `(0, 1, 0)`, they override base dimensions regardless of whether `workspace.css` loads before or after `file-panel.css`.

2. Detached viewport suppression:
   - In `workspace.css`, `:root[data-workspace-surface="fileList"] #viewport { display: none; }` has specificity `(0, 2, 0)`.
   - In `viewer.css`, `#viewport` sets flex layout with specificity `(0, 1, 0)`.
   Specificity `(0, 2, 0)` guarantees that the detached file-list window suppresses the viewport without relying on source order.

3. Single-view hiding under manhwa mode:
   - In `viewer.css`, `#viewport.manhwa-active #viewer-img-wrapper`, `#viewport.manhwa-active #viewer-lanczos-canvas`, and `#viewport.manhwa-active #viewer-filter-canvas` carry specificity `(0, 2, 1)` or `(0, 2, 0)`.
   - In `viewer.css`, base canvas rules `#viewer-lanczos-canvas` and `#viewer-filter-canvas` carry specificity `(0, 1, 0)`.
   - In `viewer.css`, `#viewer-filter-canvas[data-render-ready="true"]` carries specificity `(0, 2, 0)`.
   Because `#viewport.manhwa-active #viewer-filter-canvas` has specificity `(0, 2, 1)` when qualified with parent tag or ID, it defeats `[data-render-ready="true"]` `(0, 2, 0)`. In `viewer.css`, placing the `.manhwa-active` suppression block at the bottom of the sheet preserves this relationship.
   - For warmup bridging, `#viewport.manhwa-active.manhwa-warmup #viewer-filter-canvas` carries specificity `(0, 3, 0)`, which cleanly beats `#viewport.manhwa-active #viewer-filter-canvas` `(0, 2, 0)` to keep the warmup frame visible until the column paints.

4. Manhwa indicator suppression:
   - In `statusbar.css`, `#viewport:not(.manhwa-active) #manhwa-indicator { display: none; }` carries specificity `(0, 2, 1)`.
   - In `statusbar.css`, `#manhwa-indicator` carries specificity `(0, 1, 0)` and `#manhwa-indicator:empty` carries specificity `(0, 1, 1)`.
   Specificity `(0, 2, 1)` ensures `#manhwa-indicator` remains hidden whenever manhwa mode is not active. Keeping both rules inside `statusbar.css` eliminates cross-file order hazards.

5. URL import interaction lock:
   - `main.css:2288-2305` applies `body.is-importing-url :is(#menubar, #file-panel)`.
   - When refactored per Slice 4.2 to `body.is-importing-url #menubar, body.is-importing-url #file-panel { pointer-events: none; cursor: not-allowed; opacity: 0.6; }` in `workspace.css`, specificity is `(0, 2, 0)`. Because `pointer-events: none` on the container stops mouse events before reaching children, child elements do not need specificity overrides.

6. Audio control focus rings:
   - `main.css:1137-1144` combined `.audio-control-container:has(:focus-visible)` and `.manhwa-volume:has(:focus-visible)`.
   - Splitting these into `.audio-control-container:has(:focus-visible)` in `viewer.css` and `.manhwa-volume:has(:focus-visible)` in `manhwa.css` gives each element an identical specificity of `(0, 1, 0)` inside its own sheet. There is zero cross-surface coupling.

7. Universal visibility utility:
   - `.hidden` in `src/css/global.css:234-236` uses `display: none !important;`.
   - It beats all surface-level `display` declarations regardless of specificity or load order.

### Verification of theme and custom CSS overrides

The application supports bundled themes such as `themes/matcha-latte.css` and `themes/sage-mint.css` and arbitrary user CSS edited in Options.

- Bundled themes:
  Both `matcha-latte.css` and `sage-mint.css` define variables on `:root`, `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`, and `:root[data-theme="dark"]`. Neither file targets specific component selectors, except `#options-status` in the options window. In `src/index.html`, themes are injected into `<style id="custom-css"></style>` via `themePrePaint.js:7-12`. Because `<style id="custom-css"></style>` appears after all `<link rel="stylesheet">` elements, the injected custom properties override `:root` defaults in `global.css` immediately.
- User custom CSS:
  Users write arbitrary CSS rules into the custom CSS editor. Because `<style id="custom-css"></style>` is the final stylesheet in `<head>`, any rule written by a user targeting a selector in `workspace.css`, `menubar.css`, `file-panel.css`, `viewer.css`, `manhwa.css`, `statusbar.css`, or `overlays.css` with equal specificity wins the cascade by source order.
- Conclusion:
  Splitting `main.css` into 7 modular sheets maintains `<style id="custom-css"></style>` strictly as the last stylesheet in document order. Bundled themes and user custom CSS preserve 100% identical override behavior.

---

## Alignment with planned JS decoupling in roadmap.md

The CSS split directly supports the planned module extractions in Phases 3, 4, 5, and 6 of `.agents/major-refactor/roadmap.md`. Below is the cross-reference of every class toggle, dataset attribute, and CSS custom property affected by the refactor, along with the exact rules required in each split sheet.

### Slice 3.3 chrome and viewer DOM ownership

`roadmap.md` Slice 3.3 item 3.3.6 strips foreign DOM mutations out of `src/js/main/main.js`. Each UI surface assumes sole ownership of its class toggles.

1. `#viewport.empty`:
   - Moved from `main.js:101-104` to `src/js/viewer/viewer.js`.
   - Target sheet: `src/css/main/viewer.css`.
   - Rule in `viewer.css`:
     ```css
     #viewport.empty {
       background: var(--bg);
     }
     ```
2. `#img-grill` and `#viewer-img-wrapper.grill-active`:
   - Moved from `main.js:192-230` to `src/js/viewer/viewer.js`.
   - Target sheet: `src/css/main/viewer.css`.
   - Rules in `viewer.css`:
     ```css
     #img-grill.active {
       display: block;
     }
     #img-grill-border.active {
       display: block;
     }
     #viewer-img-wrapper.grill-active .ico-size[data-ready] .ico-size-backdrop {
       display: block;
     }
     ```
3. `#manhwa-strip.grill-active`:
   - Moved from `main.js:203` to `src/js/viewer/manhwaStrip.js`.
   - Target sheet: `src/css/main/manhwa.css`.
   - Rules in `manhwa.css`:
     ```css
     #manhwa-strip.grill-active #manhwa-slot-grill {
       display: block;
     }
     #manhwa-strip.grill-active .manhwa-slot[data-ready] .manhwa-slot-backdrop {
       display: block;
     }
     #manhwa-strip.grill-active .manhwa-slot[data-ready] .ico-size[data-ready] .ico-size-backdrop {
       display: block;
     }
     ```
4. `#statusbar.hidden`:
   - Moved from `main.js:105, 194` to `src/js/menubar/statusbar.js`.
   - Target sheet: `src/css/main/statusbar.css`.
   - Rule in `statusbar.css`:
     ```css
     #statusbar.hidden {
       display: none;
     }
     ```

### Slice 4.2 scope compliance and token migration

`roadmap.md` Slice 4.2 items 4.2.1 and 4.2.2 resolves 3-tier CSS scope violations and replaces hardcoded literals with design tokens.

1. `#fullscreen-exit-region.fullscreen-exit-visible`:
   - `fullscreen.js:42, 90, 96, 101` currently toggles `document.body.classList.toggle('fullscreen-exit-visible')`. Toggling a class on `body` to show a single button violates the 3-tier scope rule.
   - Refactor: `fullscreen.js` toggles `.fullscreen-exit-visible` directly on host element `#fullscreen-exit-region`.
   - Target sheet: `src/css/main/viewer.css`.
   - Replaced rule in `viewer.css`:
     ```css
     #fullscreen-exit-region.fullscreen-exit-visible #fullscreen-exit-btn,
     body.fullscreen-active #fullscreen-exit-btn:focus-visible {
       opacity: 1;
       pointer-events: auto;
       transform: translateY(14px);
       transition-duration: 0.1s;
       transition-timing-function: ease-out;
     }
     ```
2. `body.is-importing-url`:
   - `main.css:2288-2305` applies `body.is-importing-url :is(#menubar, #file-panel) * { cursor: not-allowed; cursor: disabled; }`. This universal selector forces browser style recalculation across every element in the menubar and file panel trees.
   - Refactor: Disable pointer events on the container hosts directly.
   - Target sheet: `src/css/main/workspace.css`.
   - Replaced rule in `workspace.css`:
     ```css
     body.is-importing-url #menubar,
     body.is-importing-url #file-panel {
       opacity: 0.6;
       pointer-events: none;
       cursor: not-allowed;
     }
     ```
3. `#viewport.cursor-hidden`:
   - `main.css:1966-1969` uses `#viewport.cursor-hidden, #viewport.cursor-hidden * { cursor: none !important; }`. The universal descendant selector `*` is unnecessary because cursor inherits down the DOM tree.
   - Target sheet: `src/css/main/viewer.css`.
   - Replaced rule in `viewer.css`:
     ```css
     #viewport.cursor-hidden {
       cursor: none !important;
     }
     ```

### Slice 5.3 file panel virtualization and template pools

`roadmap.md` Slice 5.3 items 5.3.2 and 5.3.3 eliminates all inline `style.display`, `style.top`, and `style.height` assignments in `filePanel.js` to satisfy the CSS source of truth rule.

1. Virtual scroll height:
   - `filePanel.js:2327-2328` writes `scrollSpacer.style.height = totalHeight + 'px'`.
   - Refactor: Assign CSS custom property `--file-list-total-height` on `#file-list`.
   - Target sheet: `src/css/main/file-panel.css`.
   - Rule in `file-panel.css`:
     ```css
     #file-list .scroll-spacer {
       display: block;
       width: 1px;
       height: var(--file-list-total-height, 0px);
       pointer-events: none;
     }
     ```
2. Virtual row positioning:
   - `filePanel.js:2255-2256` writes `row.style.top = top + 'px'`.
   - Refactor: Position virtual rows via GPU transform `transform: translateY(var(--row-top, 0px));`. This avoids triggering layout reflows on virtualized scroll updates.
   - Target sheet: `src/css/main/file-panel.css`.
   - Rule in `file-panel.css`:
     ```css
     #file-list li {
       position: absolute;
       left: 0;
       width: 100%;
       box-sizing: border-box;
       transform: translateY(var(--row-top, 0px));
       will-change: transform;
     }
     ```
3. Virtual row visibility:
   - `filePanel.js:772, 775, 1807-1819, 2054, 2269, 2291` writes `row.style.display = 'none'` and `.style.display = ''`.
   - Refactor: Toggle `.hidden` on recycled rows returned to the free pool.
   - Relies on `.hidden` in `global.css:234-236`.
4. Dynamic icon mode switching:
   - `filePanel.js` toggles inline display between shell icons, inline SVGs, and thumbnail images.
   - Refactor: Use `data-icon-mode="native|svg|thumb"` on rows or thumbnail wrappers.
   - Target sheet: `src/css/main/file-panel.css`.
   - Rules in `file-panel.css`:
     ```css
     #file-list li[data-icon-mode="native"] .item-name>svg,
     #file-list li[data-icon-mode="native"] .item-icon-svg {
       display: none;
     }
     #file-list li[data-icon-mode="svg"] .item-name>img {
       display: none;
     }
     ```
5. Template pools for Favorites and Library:
   - Declare `<template id="favorites-item-template">` and `<template id="library-provider-template">` in `src/index.html`.
   - Cloned elements inherit existing classes `#favorites-list li`, `.library-provider-list li`, `.favorite-remove`, `.lib-remove`.
   - Target sheet: `src/css/main/file-panel.css`.

### Slices 6.1, 6.2, and 6.3 viewer pipelines and manhwa strip

`roadmap.md` Phase 6 decouples viewer rendering, audio management, WebGL compositing, and manhwa strip layout.

1. Retiring bridge layer in `src/js/viewer/viewerBridge.js`:
   - Transferred elements park in `#viewer-bridge-layer` with frozen navigation coordinates.
   - Target sheet: `src/css/main/viewer.css`.
   - Properties consumed: `--bridge-tx`, `--bridge-ty`, `--bridge-rot`, `--bridge-sx`, `--bridge-sy`.
   - Consolidated rule in `viewer.css`:
     ```css
     #viewer-bridge-layer {
       position: absolute;
       inset: 0;
       pointer-events: none;
     }
     #viewer-bridge-layer :is(.viewer-img, .viewer-video, .ico-container).bridge {
       display: block;
       position: absolute;
       top: 50%;
       left: 50%;
       transform-origin: center center;
       transform: translate(calc(-50% + var(--bridge-tx, 0px)), calc(-50% + var(--bridge-ty, 0px)))
                  rotate(var(--bridge-rot, 0deg))
                  scale(var(--bridge-sx, 1), var(--bridge-sy, 1));
       pointer-events: none;
       z-index: 0;
     }
     #viewer-bridge-layer .ico-container.bridge {
       display: flex;
     }
     ```
2. Shared ICO size cells in `src/js/viewer/icoCells.js`:
   - Properties consumed: `--ico-w`, `--ico-h`, `--ico-total-w`, `--ico-total-h`.
   - Target sheets: `src/css/main/viewer.css` for the single-view row, and `src/css/main/manhwa.css` for strip slot rows.
   - Rules in `viewer.css`:
     ```css
     #viewer-ico-row {
       display: none;
       position: absolute;
       inset: 0;
       align-items: center;
       justify-content: center;
       pointer-events: none;
     }
     #viewer-img-wrapper[data-ico="true"] {
       width: var(--ico-total-w);
       height: var(--ico-total-h);
     }
     #viewer-img-wrapper[data-ico="true"] #viewer-ico-row {
       display: flex;
     }
     .ico-container {
       display: flex;
       align-items: center;
       justify-content: center;
       pointer-events: none;
     }
     .ico-size {
       position: relative;
       display: flex;
       justify-content: center;
       align-items: center;
       flex-shrink: 0;
       width: var(--ico-w);
       height: var(--ico-h);
       padding: 0;
       margin: 0;
     }
     .ico-size > img {
       display: block;
       position: relative;
       z-index: 1;
       width: 100%;
       height: 100%;
       user-select: none;
       -webkit-user-select: none;
     }
     ```
3. WebGL and Lanczos canvases in `viewerPipelines.js`:
   - Properties consumed: `--crop-top`, `--crop-left`, `--crop-w`, `--crop-h`, `data-render-ready`, `data-filter`.
   - Target sheet: `src/css/main/viewer.css`.
   - Rules in `viewer.css`:
     ```css
     #viewer-lanczos-canvas {
       position: absolute;
       top: var(--crop-top, 0px);
       left: var(--crop-left, 0px);
       width: var(--crop-w);
       height: var(--crop-h);
       opacity: 0;
       z-index: 2;
       pointer-events: none;
     }
     #viewer-lanczos-canvas[data-render-ready="true"] {
       opacity: 1;
     }
     #viewer-filter-canvas {
       position: absolute;
       inset: 0;
       margin: auto;
       pointer-events: none;
       opacity: 0;
       z-index: 2;
     }
     #viewer-filter-canvas[data-render-ready="true"] {
       opacity: 1;
     }
     #viewport[data-filter] #viewer-img-wrapper .viewer-img,
     #viewport[data-filter] #viewer-img-wrapper .viewer-video,
     #viewport[data-filter] #viewer-img-wrapper #viewer-ico-row .ico-size > img,
     #viewport[data-filter] #viewer-bridge-layer .viewer-img,
     #viewport[data-filter] #viewer-bridge-layer .viewer-video,
     #viewport[data-filter] #viewer-bridge-layer .ico-container .ico-size > img {
       opacity: 0 !important;
     }
     ```
4. Continuous column WebGL in `src/js/viewer/manhwaColumnPipeline.js`:
   - Properties consumed: `data-render-ready`, `data-filter`, `manhwa-warmup`, `manhwa-exit-warmup`.
   - Target sheet: `src/css/main/manhwa.css`.
   - Rules in `manhwa.css`:
     ```css
     #manhwa-filter-canvas {
       position: absolute;
       inset: 0;
       margin: auto;
       pointer-events: none;
       opacity: 0;
       display: none;
       z-index: 1;
     }
     #viewport.manhwa-active #manhwa-filter-canvas[data-render-ready="true"],
     #viewport.manhwa-exit-warmup #manhwa-filter-canvas[data-render-ready="true"] {
       display: block;
       opacity: 1;
     }
     #viewport.manhwa-active[data-filter] #manhwa-strip .manhwa-slot>img,
     #viewport.manhwa-active[data-filter] #manhwa-strip .manhwa-slot>video,
     #viewport.manhwa-active[data-filter] #manhwa-strip .manhwa-slot[data-ico="true"] .ico-size>img {
       visibility: hidden;
     }
     #viewport.manhwa-active[data-filter="lanczos"] #manhwa-strip .manhwa-slot[data-kind="svg"]>img,
     #viewport.manhwa-active[data-filter="anime4k"] #manhwa-strip .manhwa-slot[data-kind="svg"]>img {
       visibility: visible;
     }
     ```
5. Manhwa strip spacers and layout in `src/js/viewer/manhwaStrip.js`:
   - Static spacers declared in `index.html:379-380` per Slice 6.3 item 6.3.2.
   - Properties consumed: `--strip-spacer-top`, `--strip-spacer-bottom`, `--strip-width`, `--slot-width`, `--slot-height`, `--zoom-scale`, `--slot-grill-top`, `--slot-grill-height`, `--grill-angle`, `--slot-backdrop-bg`, `--slot-backdrop-angle`.
   - Target sheet: `src/css/main/manhwa.css`.
   - Rules in `manhwa.css`:
     ```css
     #manhwa-strip-spacer-top {
       height: var(--strip-spacer-top, 0px);
     }
     #manhwa-strip-spacer-bottom {
       height: var(--strip-spacer-bottom, 0px);
     }
     .manhwa-slot {
       display: flex;
       justify-content: center;
       align-items: flex-start;
       flex-shrink: 0;
       width: var(--slot-width, 100%);
       height: var(--slot-height, auto);
       position: relative;
       padding: 0;
       margin: 0;
     }
     .manhwa-slot+.manhwa-slot {
       margin-top: min(-1px, calc(-1px / var(--zoom-scale, 1)));
     }
     #manhwa-slot-grill {
       display: none;
       position: absolute;
       top: var(--slot-grill-top, 0px);
       left: 0;
       right: 0;
       height: var(--slot-grill-height, 0px);
       pointer-events: none;
     }
     ```
6. Per-slot video audio pills in `src/js/viewer/manhwaAudio.js`:
   - Cloned from `<template id="manhwa-volume-template">` into `#manhwa-audio-overlay`.
   - Pill positioning uses `transform: translate(var(--pill-x, 0px), var(--pill-y, 0px));` instead of layout-triggering inline style top/left writes.
   - Target sheet: `src/css/main/manhwa.css`.
   - Rules in `manhwa.css`:
     ```css
     #manhwa-audio-overlay {
       display: none;
       position: absolute;
       inset: 0;
       pointer-events: none;
       z-index: 2;
       overflow: hidden;
     }
     #viewport.manhwa-active #manhwa-audio-overlay {
       display: block;
     }
     #manhwa-audio-overlay .manhwa-volume {
       top: 0;
       left: 0;
       bottom: auto;
       transform-origin: 0 0;
       transform: translate(var(--pill-x, 0px), var(--pill-y, 0px));
     }
     ```

---

## Validate-changes CSS audit of global.css and main.css

### Three-tier scope violations

The three-tier scope rule in `.agents/AGENTS.md` restricts class assignments:
1. Global: `html` or `body` for window-wide modes. Direct rules only, never `body.foo *`.
2. Component: host node for coordinated child state.
3. Leaf: target element.

Violations identified:

1. `src/css/main.css:2294-2297` `[Blocking]`
   `body.is-importing-url :is(#menubar, #file-panel) * { cursor: not-allowed; cursor: disabled; }`
   Targets every descendant of the menubar and file panel from `body`. This forces full subtree style invalidation on import state toggles.
   Remediation: Set `pointer-events: none; cursor: not-allowed;` on `#menubar` and `#file-panel` directly in `workspace.css`.
2. `src/css/main.css:2054-2055` `[Warning]`
   `body.fullscreen-exit-visible #fullscreen-exit-btn`
   Toggles a class on `body` solely to mutate the exit button inside `#fullscreen-exit-region`.
   Remediation: Toggle `.fullscreen-exit-visible` on `#fullscreen-exit-region` directly in `viewer.css`.
3. `src/css/main.css:2299-2305` `[Warning]`
   `body.is-importing-url .menu-trigger:hover, body.is-importing-url #file-panel-favorites-header:hover, body.is-importing-url .library-provider-header:hover, body.is-importing-url .header-cell:hover { cursor: not-allowed; cursor: disabled; }`
   Applies four specific leaf hover overrides from `body`. Setting `pointer-events: none` on `#menubar` and `#file-panel` eliminates the need for all four leaf rules.
4. `src/css/main.css:1966-1969` `[Warning]`
   `#viewport.cursor-hidden, #viewport.cursor-hidden * { cursor: none !important; }`
   Universal child selector `*` under `#viewport.cursor-hidden`.
   Remediation: Target `#viewport.cursor-hidden` directly with `cursor: none !important`.

### Universal and deep descendant selectors

Deep descendant and universal selectors defeat browser style recalculation boundaries by querying entire DOM subtrees.

1. `src/css/global.css:172-178` `[Compliant]`
   `*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }`
   This is the root CSS reset. It runs once on initial document construction and is standard practice.
2. `src/css/global.css:239-243` `[Warning]`
   `:root, * { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }`
   Uses universal `*` to force thin scrollbars on every element.
   Remediation: Apply `scrollbar-width: thin` and `scrollbar-color` to specific scrolling containers such as `.menu-dropdown`, `.submenu`, `#favorites-list`, `.library-provider-list`, `#file-list`, and `#viewport` instead of every DOM node.
3. `src/css/main.css:126-129` `[Warning]`
   `.menu-dropdown>* { direction: ltr; }`
   Uses universal child selector `*` on all dropdown children to reset writing direction after `direction: rtl` puts the scrollbar on the left.
   Remediation: Target list item children explicitly `.menu-dropdown > li, .menu-dropdown > div`.
4. `src/css/main.css:1812-1814` `[Warning]`
   `#manhwa-strip>* { flex-shrink: 0; }`
   Universal selector on all strip direct children.
   Remediation: Target `.manhwa-slot, #manhwa-strip-spacer-top, #manhwa-strip-spacer-bottom, #manhwa-slot-grill` explicitly in `manhwa.css`.

### Hardcoded color, shadow, and dimension literals

Tokens centralized in `src/css/global.css` provide the single visual source of truth. Literals embedded in component sheets break theme inheritance and WCAG contrast conformance.

1. `src/css/main.css:229, 252, 270` `[Warning]`
   `color: #fff;` on `.menu-dropdown li.has-submenu.open`, `.menu-dropdown li[role^="menuitem"]:hover`, and `.menu-dropdown li[role^="menuitem"]:hover>.shortcut`.
   Remediation: Define semantic token `--on-accent: #ffffff;` in `global.css` and consume it in `menubar.css`.
2. `src/css/main.css:557` `[Warning]`
   `color: #f5c518;` on `#btn-favorite-current.active`.
   Remediation: Define semantic token `--favorite-star: #f5c518;` in `global.css` and consume it in `file-panel.css`.
3. `src/css/main.css:637` `[Warning]`
   `color: #999;` on `.favorite-remove`.
   Remediation: Replace with existing token `var(--text-dim)`.
4. `src/css/main.css:2199` `[Warning]`
   `color: #fff;` on `.overlay-field button`.
   Remediation: Replace with `var(--on-accent)`.
5. `src/css/main.css:2267-2268` `[Warning]`
   `border-color: #d83b01; color: #d83b01;` on `#drop-overlay.unsupported .drop-hint`.
   Remediation: Replace with `var(--danger)`.
6. `src/css/main.css:196, 201, 207, 211, 216, 220` `[Warning]`
   Duplicated hardcoded shadow values `rgba(0, 0, 0, 0.18)` and `rgba(0, 0, 0, 0.5)`.
   Remediation: Define `--menu-shadow-right` and `--menu-shadow-left` in `global.css` and consume them in `menubar.css`.
7. `src/css/main.css:84, 809, 1173-1174, 1294, 2697` `[Nit]`
   Fractional subpixel values:
   - Line `84`: `margin: 1.3045px 0;` in `.menu-trigger`.
   - Line `809`: `padding: 4.078px 8px;` in `.file-panel-search`.
   - Lines `1173-1174`: `padding-top: 2.15625px; padding-bottom: 2.15625px;` in `#file-panel-header>div`.
   - Line `1294`: `padding: 1.6015px 0;` in `#file-list li`.
   - Line `2697`: `padding: 2.453px 8px;` in `#statusbar`.
   These fractional magic numbers were manually calculated to force specific integer line heights at 100% DPI on Windows. They should be documented as display-scaling invariants or standardized to layout tokens.

### Duplicated declaration blocks

1. Submenu box shadow blocks at `src/css/main.css:195-221`:
   Submenu shadow rules repeat 4 separate times across light mode, `@media (prefers-color-scheme: dark)`, and `:root[data-theme="dark"]`. Lines `215-221` are identical to lines `206-212`. Tokenizing `--menu-shadow-right` and `--menu-shadow-left` collapses these 26 lines into two static rules in `menubar.css`.
2. Striped diagonal grill gradients at `src/css/main.css:1865-1875, 1896-1906, 2575-2585, 2654-2664`:
   The 10-stop linear gradient formula is repeated in four separate rule blocks for `#manhwa-slot-grill`, `.manhwa-slot-backdrop`, `#img-grill`, and `.ico-size-backdrop`. Defining a shared CSS custom property `--grill-gradient` in `global.css` or referencing a shared class eliminates 44 lines of duplicate gradient math.
3. Duplicate `.svg-pump-live` rules at `src/css/main.css:2424-2431` and `2437-2440`:
   `.svg-pump-live` is declared at line `2424` and then declared a second time at line `2437` separated by `#viewer-svg-pump.hidden`. These should be unified into one rule block in `viewer.css`.
4. Statusbar separator dot repetitions at `src/css/main.css:2745-2792`:
   Eight separate rules each declare `{ content: '·'; margin-right: 12px; color: var(--border); }`. Combining them into one selector list collapses 47 lines into 12 lines in `statusbar.css`.
5. Bridge transform blocks at `src/css/main.css:2371-2402`:
   Three consecutive blocks for `.viewer-video.bridge`, `.viewer-img.bridge`, and `#viewer-bridge-layer .ico-container.bridge` repeat identical absolute positioning, 50% top/left coordinates, transform-origin, and 5-variable transform formulas. Combining them with `:is(.viewer-img, .viewer-video, .ico-container).bridge` collapses 31 lines into 11 lines in `viewer.css`.
6. Audio slider thumb and track styling at `src/css/main.css:1009-1025` and `1119-1135`:
   `#audio-volume-slider` and `.manhwa-volume-slider` declare identical track with height 3px, border-radius 2px, and background `var(--border)` and thumb with size `min(var(--fs-11), 12px)`, border-radius 50%, and background `var(--accent)` styles. Moving the common slider rules to `global.css` as a shared `.volume-slider` class removes 34 lines of duplicated vendor-prefixed CSS.

### Misplaced and dead selectors

1. `src/css/main.css:752-760` `[Nit]`
   `.lib-remove .lib-remove-box { display: block; width: 10px; height: 10px; box-sizing: border-box; border: 1px solid currentColor; border-radius: 50%; }`
   Dead CSS selector. `filePanel.js:841, 1317` injects an inline SVG icon , `MARU_O_SVG`,, leaving `.lib-remove-box` completely unreferenced in the DOM tree. Delete per `roadmap.md` Slice 0.1 item 0.1.10.
2. `src/css/global.css:127-130, 166-169` `[Nit]`
   `.assoc-mascot-svg, .assoc-mascot-box.is-active .assoc-format-icon` filter rules.
   Misplaced rules. These elements exist only in `src/options.html` under the file associations tab. They do not exist in `src/index.html` or `src/metadata.html`. Move them to `src/css/options.css`.
3. `src/css/global.css:274-276` `[Nit]`
   `.viewer-img.is-placeholder { display: none; }`
   Misplaced rule. `.viewer-img` exists only in `src/index.html` inside `#viewer-img-wrapper`. Move to `src/css/main/viewer.css`.
4. `src/css/main.css:1381-1399` `[Nit]`
   `#statusbar.refreshing` pulse animation inside file panel rules.
   Misplaced rule. Move to `src/css/main/statusbar.css`.
5. `src/css/main.css:897-1136` `[Nit]`
   Viewport audio controls and manhwa volume pills declared inside file panel rules.
   Misplaced rules. Move viewport audio to `src/css/main/viewer.css` and manhwa video volume to `src/css/main/manhwa.css`.

---

## Conclusion and remediation summary

The decoupling of `src/css/main.css` into 7 surface stylesheets into `workspace.css`, `menubar.css`, `file-panel.css`, `viewer.css`, `manhwa.css`, `statusbar.css`, and `overlays.css` mirrors the planned JavaScript module boundaries in `.agents/major-refactor/roadmap.md`. Zero lines are left unmapped. Source order dependencies have been verified, proving that themes and user custom CSS in `<style id="custom-css"></style>` retain identical cascade precedence. Consolidating scattered rules, eliminating 3-tier scope violations, and moving misplaced selectors out of `global.css` establishes clean single-owner surface boundaries across the QuiviT stylesheet architecture.
