*This report was compared against .agents/skills/validate-changes/SKILL.md and .agents/AGENTS.md.*

# CSS options decoupling and runtime contract audit

Audit of CSS modularization for Options, Archive Info, and Preview Player windows, cross-referenced with planned architectural splits in `roadmap.md`, runtime pre-paint timing, and end-to-end testing contracts.

## Line-by-line surface ownership map of options.css, metadata.css, and preview_player.css

### Comprehensive mapping of `src/css/options.css`

`src/css/options.css` contains 797 lines. The table below partitions every contiguous line block into target stylesheets. Zero lines remain unmapped.

| Source Lines | Target Stylesheet | Primary Selectors | Classification and Rationale |
|---|---|---|---|
| 1-13 | `src/css/options/options.css` | `body`, `body > *` | Window shell flexbox layout, surface background, viewport scroll rules, child padding. |
| 14-22 | `src/css/options/options.css` | `.tabs` | Tab navigation strip container, bottom border, surface shadow. |
| 23-50 | `src/css/options/options.css` | `.tab-btn`, `.tab-btn:hover`, `.tab-btn.active` | Tab navigation buttons, hover states, active indicator border overrides. |
| 51-65 | `src/css/options/options.css` | `.tab-content`, `.tab-content.active` | Tab content switching via display toggle and flex scrolling constraints. |
| 66-96 | `src/css/options/options.css` | `.options-section:first-of-type`, `.options-section:last-of-type`, `.options-section h3`, `.options-section h4`, `.options-section label` | Section vertical rhythm, headings, typography, checkbox label alignment. |
| 97-102 | `src/css/options/custom-css.css` | `.theme-group` | Initial declaration of theme button row container. Consolidates with line 520 in the custom theme module. |
| 103-114 | `src/css/options/options.css` | `.flag-icon`, `.language-name` | Language tab Twemoji flag dimensions and text layout. |
| 115-120 | `src/css/options/options.css` | `.options-section .hint` | Muted hint typography under setting controls. |
| 121-132 | `src/css/global.css` | `.link-button` | Reusable text-link button primitive with accent underline and pointer cursor. |
| 133-142 | `src/css/options/options.css` | `#link-supported-sites`, `.link-button:hover`, `#link-supported-sites:hover` | Supported sites link styling in General tab Library section. |
| 143-156 | `src/css/options/options.css` | `.input-group`, `.input-group + .hint`, `.continue-last-label` | Vertical spacing for text input groups and startup checkboxes. |
| 157-198 | `src/css/options/options.css` | `.pan-step-row`, `.pan-step-col`, `.pan-step-col label`, `.pan-step-input-wrap`, `.pan-step-row input[type="number"]`, `.pan-step-unit` | Viewport pan-step number inputs and unit labels. |
| 199-203 | `src/css/global.css` | `.flex-row` | Shared utility class providing horizontal flexbox with 8px gap. |
| 204-221 | `src/css/options/keybinds.css` | `.keybinds-header`, `.keybinds-header .hint`, `#btn-reset-keybinds` | Keys tab header layout, instructions hint, and secondary reset button. |
| 222-242 | `src/css/global.css` | `textarea`, `textarea:focus` | Base monospace textarea form control reset with field background, border, and focus ring. |
| 243-373 | `src/css/options/custom-css.css` | `.custom-css-editor`, `.custom-css-editor pre, .custom-css-editor textarea`, `.custom-css-editor textarea`, `.custom-css-editor textarea:focus`, `.custom-css-editor textarea::placeholder`, `.custom-css-editor textarea::selection`, `.custom-css-editor pre`, `.custom-css-editor pre::-webkit-scrollbar`, `.custom-css-editor pre::-webkit-scrollbar-thumb`, `.custom-css-editor pre code`, `.custom-css-editor .token.*` | Custom CSS editor overlay, synchronized scrolling typography, Prism syntax token styling. |
| 374-398 | `src/css/options/options.css` | `.flex-row input[type="text"], .flex-row input[type="number"]`, `.flex-row input[type="number"]`, `.flex-row input[type="text"][readonly]`, `#opt-start-dir` | Text and number input sizing within options flex rows and browse fields. |
| 399-488 | `src/css/options/keybinds.css` | `.keybinds-list`, `.keybind-item`, `.keybind-name`, `.keybind-category-header`, `.keybind-category-header:first-child`, `.keybind-tags`, `.keybind-tag`, `.keybind-tag:hover`, `.keybind-tag .remove-btn`, `.keybind-tag .remove-btn:hover`, `.keybind-tag.capturing`, `.keybind-tag.add-btn`, `.keybind-tag.add-btn:hover` | Keybindings list rows, category group titles, tag pills, capturing ring, remove button, dashed add button. Hardcoded colors at lines 463 and 468 map to tokens. |
| 489-507 | `src/css/options/options.css` | `.dialog-footer`, `#options-status` | Sticky dialog footer container and status text element. |
| 508-519 | `src/css/global.css` | `button` | Base button reset with surface background, border, and hover transition. Duplicated across main.css and options.css. |
| 520-529 | `src/css/options/custom-css.css` | `.theme-group`, `.theme-btn` | Theme selector button row in Customization tab. |
| 530-572 | `src/css/options/keybinds.css` | `.scroll-mode-toggle`, `.scroll-mode-label`, `.scroll-mode-controls`, `.scroll-mode-btn`, `.scroll-mode-btn:hover`, `.scroll-mode-btn.active` | Wheel modifier mode toggle row inside keybinds list. Line 541 `.scroll-mode-label` is dead code pruned in Slice 0.1. |
| 573-604 | `src/css/global.css` | `button:hover`, `button.primary`, `button.primary:hover`, `button.danger`, `button.danger:hover`, `button:disabled` | Shared button variant primitives (primary accent, danger red, disabled states). |
| 605-609 | `src/css/options/options.css` | `.options-section label:has(input[type="checkbox"]:disabled)` | Opacity reduction for disabled setting checkbox labels. |
| 610-640 | `src/css/options/associations.css` | `.assoc-actions`, `.assoc-header`, `.assoc-grid`, `.assoc-label`, `.assoc-icon`, `.assoc-text` | File Types tab actions row, headers, format grid, format checkbox labels and icons. |
| 641-703 | `src/css/options/associations.css` | `.assoc-mascots-wrapper`, `.assoc-mascots`, `.assoc-mascot-box`, `.assoc-mascot-box.is-active`, `.assoc-mascot-svg`, `.assoc-format-icon`, `.assoc-mascot-box.is-active .assoc-format-icon` | Mascot format preview bar, active scale animation, icon cross-fade transitions. |
| 704-765 | `src/css/global.css` & `src/css/options/associations.css` | `.assoc-remove-dialog`, `.assoc-remove-dialog::backdrop`, `@supports (transition-behavior: allow-discrete)`, `@media (prefers-reduced-motion: reduce)` | Base `<dialog>` transitions and backdrop dimming belong in `global.css`. Specific dialog dimensions and typography belong in `associations.css`. |
| 766-797 | `src/css/options/associations.css` | `.assoc-remove-dialog form`, `.assoc-remove-dialog h3`, `.assoc-remove-dialog p`, `.assoc-remove-actions`, `.assoc-remove-actions button` | Association unregistration confirmation modal contents and action button layout. |

### Evaluation of `src/css/metadata.css`

`src/css/metadata.css` contains 126 lines governing the Archive Info window.
- Lines 1-4: `body` background uses `var(--surface)` and enables vertical scrolling.
- Lines 6-11: `#metadata-root` sets container padding to 16px and column flex layout with 20px gap.
- Lines 13-39: `#metadata-top` cover image orientation handling via `data-orientation="landscape"` and `data-orientation="square"`. This follows the data-attribute layout rule without inline style writes.
- Lines 40-57: `#metadata-cover-wrap` and `#metadata-cover-img` define cover thumbnail dimensions and border styling.
- Lines 58-85: `#metadata-title-block`, `#metadata-title`, `#metadata-series`, and `#metadata-summary` define typography using design tokens `--fs-18`, `--fs-13`, `--fs-12`, `--text`, `--accent`, and `--text-muted`.
- Lines 88-125: `#metadata-grid`, `.meta-label`, `.meta-value`, `.meta-credit`, and `.meta-credit-icon` define two-column CSS grid layout for ComicInfo metadata.
- Token, scope, and inline style compliance:
  1. The file contains zero inline style violations and zero universal descendant rules.
  2. All colors reference tokens in `global.css`.
  3. No restructuring into sibling CSS files is required; `metadata.css` remains the single stylesheet for `metadata.html`.

### Evaluation of `src-tauri/src/platform/previews/windows/preview_player.css`

`preview_player.css` contains 25 lines embedded directly into the WebView2 child preview pane via `include_str!("preview_player.css")` in `src-tauri/src/platform/previews/windows/image_pane.rs:433`.
- Lines 1-10:
  ```css
  :root {
    --preview-background: __BACKGROUND__;
    --preview-foreground: __FOREGROUND__;
    --preview-svg-max-edge: 1000px;
    color-scheme: light dark;
    font-family: "Segoe UI", sans-serif;
    background: var(--preview-background);
    color: var(--preview-foreground);
    user-select: none;
  }
  ```
  `__BACKGROUND__` and `__FOREGROUND__` are placeholders substituted at runtime by Rust from native Windows Explorer preview pane theme colors.
- Lines 20-23:
  ```css
  img.vector {
    width: min(100%, var(--preview-svg-max-edge), var(--svg-width, var(--preview-svg-max-edge)));
    height: min(100%, var(--preview-svg-max-edge), var(--svg-height, var(--preview-svg-max-edge)));
  }
  ```
  `preview_player.js:66` assigns `--svg-width` and `--svg-height` as CSS custom properties on the image host element, adhering strictly to the CSS source of truth rule.
- Token, scope, and inline style compliance:
  1. The preview player runs inside an isolated WebView2 instance separate from the main Tauri app shell, with no access to `global.css`.
  2. The placeholder token replacement mechanism is required for Explorer shell color synchronization.
  3. No changes to `preview_player.css` are necessary.

---

## Alignment with planned JS decoupling in roadmap.md

### Cross-reference with Slice 4.1 and Slice 5.3

1. Keybind tag recycling and `--conflict-color` custom property:
   - File references: `src/options.html:157-442`, `src/js/options/keybindUi.js:321-386`, `src/css/options/keybinds.css`.
   - Planned change in Slice 4.1 item #4.1.4:
     `keybindUi.js:330-331` currently sets `tag.style.color = conflictColor` and `tag.style.borderColor = conflictColor` directly as inline styles.
     In `src/options.html`, a `<template id="keybind-tag-template">` will declare the static markup for shortcut tags.
     In `src/css/options/keybinds.css`, the rule for `.keybind-tag` will consume the custom property:
     ```css
     .keybind-tag {
       display: inline-flex;
       align-items: center;
       gap: 6px;
       padding: 4px 8px;
       border: 1px solid var(--conflict-color, var(--border));
       border-radius: 4px;
       background: var(--field-bg);
       color: var(--conflict-color, var(--accent));
       font: inherit;
       font-size: var(--fs-11);
       font-weight: 600;
       cursor: pointer;
       white-space: nowrap;
     }
     ```
     `keybindUi.js` will call `tag.style.setProperty('--conflict-color', conflictColor)` when a conflict exists, and `tag.style.removeProperty('--conflict-color')` when clear. `renderKeybinds` will recycle existing DOM nodes in `.keybind-tags` instead of executing `innerHTML = ''` and `createElement`.

2. Tab strip measurement in `windowFit.js`:
   - File references: `src/js/shared/windowFit.js:15-18`, `src/css/options/options.css`.
   - Planned change in Slice 4.1 item #4.1.5:
     `windowFit.js:16` currently sets `tabs.style.width = 'fit-content'` and later restores `tabs.style.width = prev`.
     In `src/css/options/options.css`, a measurement class will be added:
     ```css
     .tabs.measuring {
       width: fit-content;
     }
     ```
     `windowFit.js` will toggle `tabs.classList.add('measuring')`, measure `tabs.getBoundingClientRect().width`, and call `tabs.classList.remove('measuring')`.

3. Custom CSS editor extraction:
   - File references: `src/js/options/options.js:386-485`, `src/js/options/customCssEditor.js`, `src/css/options/custom-css.css`.
   - Planned change in Slice 4.1 item #4.1.3:
     Prism live syntax highlighting, scroll synchronization between textarea and pre elements, and file import/export will be extracted into `src/js/options/customCssEditor.js`.
     All Prism editor styles, overlay positioning, transparent textarea caret rules, and syntax token rules will reside exclusively in `src/css/options/custom-css.css`.

4. Metadata detail row template and node recycling:
   - File references: `src/metadata.html`, `src/js/metadata-window.js:95-125`, `src/css/metadata.css`.
   - Planned change in Slice 5.3 item #5.3.2:
     `metadata-window.js:95-107` currently constructs `.meta-credit` and `.meta-credit-icon` elements dynamically via `document.createElement`.
     In `src/metadata.html`, a `<template id="meta-credit-template">` will be declared:
     ```html
     <template id="meta-credit-template">
       <span class="meta-credit">
         <img class="meta-credit-icon" alt="" aria-hidden="true" draggable="false" />
         <span class="meta-credit-text"></span>
       </span>
     </template>
     ```
     `metadata-window.js` will clone this template and recycle nodes rather than creating DOM structures from script.

### Resulting `<link>` and `<head>` structures

#### `src/options.html`
```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>QuiviT Options</title>
  <link rel="stylesheet" href="/css/global.css" />
  <link rel="stylesheet" href="/css/options/options.css" />
  <link rel="stylesheet" href="/css/options/keybinds.css" />
  <link rel="stylesheet" href="/css/options/associations.css" />
  <link rel="stylesheet" href="/css/options/custom-css.css" />
  <style id="custom-css"></style>
  <script src="/js/shared/themePrePaint.js"></script>
</head>
```

#### `src/metadata.html`
```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Archive Info</title>
  <link rel="stylesheet" href="/css/global.css" />
  <link rel="stylesheet" href="/css/metadata.css" />
  <style id="custom-css"></style>
  <script src="/js/shared/themePrePaint.js"></script>
</head>
```

---

## Pre-paint, windowFit.js measurement timing, and multi-window stylesheet loading

### Stylesheet loading order and pre-paint cascade

1. Pre-paint script placement and duplicate style element prevention:
   - In current code (`src/options.html:9-15` and `src/metadata.html:8-10`), `<script src="/js/shared/themePrePaint.js"></script>` is placed before `<style id="custom-css"></style>`.
   - `themePrePaint.js:7-10` executes `document.createElement('style')`, sets `s.id = 'custom-css'`, and appends it to `document.head`.
   - Because the static `<style id="custom-css"></style>` tag exists immediately after the script, two `#custom-css` elements are created in `<head>`, violating static placeholder invariants.
   - Moving `<style id="custom-css"></style>` before `<script src="/js/shared/themePrePaint.js"></script>` allows `themePrePaint.js` to query `document.getElementById('custom-css')` directly and populate its `textContent` without appending duplicate DOM nodes.
   - Placing `<style id="custom-css"></style>` after all `<link rel="stylesheet">` elements ensures user-defined custom CSS rules win the cascade over default stylesheets without requiring `!important`.

2. Multi-link stylesheet loading mechanics:
   - In Chromium and WebView2, all `<link rel="stylesheet">` elements declared in `<head>` block parsing of following synchronous `<script>` tags and block document rendering.
   - When `options.html` loads 5 separate `<link rel="stylesheet">` files (`global.css`, `options.css`, `keybinds.css`, `associations.css`, `custom-css.css`), the browser fetches and compiles all five into the CSSOM before evaluating `<script src="/js/shared/themePrePaint.js">`.
   - Because all files are local assets served from disk via Tauri's internal asset resolver, network latency is negligible and all sheets resolve synchronously during initial HTML parse.

3. Native shell background synchronization:
   - `shellBackground.js` executes as a deferred module script (`<script type="module" src="/js/shellBackground.js"></script>`) placed after `#measure-probe` at the end of `<body>`.
   - It reads computed `--surface` from `#measure-probe` via `getComputedStyle(probe).backgroundColor`.
   - Because `--surface` is declared on `:root` in `src/css/global.css`, and `.measure-probe` is styled in `src/css/global.css:264-272`, its value is fully defined and available regardless of how options CSS files are partitioned.
   - `shellBackground.js` schedules background synchronization through `SHELL_BACKGROUND_SYNC_DELAY_MS = 20`. This delay guarantees that initial layout has settled and any pre-paint theme attribute (`data-theme="dark"`) is applied before invoking `plugin:window|set_background_color`.

4. Timing of `windowFit.js` geometry measurements:
   - Options window measurement:
     `options.js:658` invokes `init().then(() => fitContentWidth().then(showOptionsWindow))`.
     `init()` awaits multiple asynchronous IPC calls (`load_config`, `get_library_dir`, `get_active_config_info`), which yields to the event loop.
     `fitContentWidth()` in `windowFit.js:10-25` wraps the measurement in `requestAnimationFrame`.
     By the time `requestAnimationFrame` fires, the DOM tree is fully constructed, all `<link>` stylesheets are parsed and active in CSSOM, and `.tabs` has its final font metrics.
   - Metadata window measurement:
     `metadata-window.js:165-179` attempts to measure synchronously:
     `fitContentHeight().then(showWindow)`.
     In `windowFit.js:30-39`, `fitContentHeight` executes immediately in a Promise tail without `requestAnimationFrame`:
     ```javascript
     const rootEl = document.getElementById('metadata-root');
     if (!rootEl) return resolve();
     const contentH = rootEl.scrollHeight;
     const targetH = Math.min(contentH, META_MAX_INITIAL_H);
     invoke('fit_metadata_window', { height: targetH }).then(resolve, resolve);
     ```
     Because `metadata.html` uses local system fonts (`Segoe UI`, specified in `global.css:192`), no remote web font downloading occurs.
     However, if a user applies a custom CSS rule with a custom font (`@import` or large font size), reading `rootEl.scrollHeight` synchronously can measure before the font metrics update layout.
     To guarantee rock-solid measurement across all machines, `fitContentHeight` should wrap the `scrollHeight` read inside `requestAnimationFrame` (matching `fitContentWidth`), ensuring all CSSOM recalculations and font substitutions are applied before measuring.
     Neither `window.onload` nor `DOMContentLoaded` listeners are necessary when using `requestAnimationFrame`, as module scripts run after DOMContentLoaded by specification.

---

## Diagnostic probe, E2E test, and architecture rule impact

### Telemetry and diagnostic probe verification

An exhaustive search of `e2e/replay-diagnostics/probes/viewerPipelineProbe.js` and `e2e/replay-diagnostics/base.js` was conducted for CSS selectors, class names, and computed style checks.

1. Probe selectors in `viewerPipelineProbe.js`:
   - `#viewport`, `#viewport.manhwa-active`, `#viewport[data-filter]`
   - `#manhwa-strip`, `#manhwa-strip-spacer-top`, `#manhwa-strip-spacer-bottom`, `.manhwa-slot`
   - `#manhwa-filter-canvas`, `#viewer-lanczos-canvas`, `#viewer-filter-canvas`
   - `#viewer-img-wrapper`, `.viewer-img.active`, `.viewer-img.bridge`, `.viewer-video.active`, `.viewer-video.bridge`
   - `#viewer-ico-row`, `.ico-container`, `.ico-size[data-ready]`
   - `#statusbar .status-filename, #statusbar .filename`
   - All computed style queries check `opacity`, `visibility`, or `transform` strictly on viewer and manhwa elements in the main window.
   - Result: Splitting `options.css` has zero interaction with `viewerPipelineProbe.js`.

2. Probe selectors in `base.js`:
   - Monitors `actions.js`, `core.js`, IPC invoke calls, and `quivit://` / `asset://` network requests.
   - Replay diagnostics inspects no elements or styles inside `options.html` or `metadata.html`.
   - Result: Zero impact on `base.js`.

### End-to-end pageobject and test spec audit

1. `options.page.js`:
   - Selectors queried:
     - Tabs: `.tab-btn[data-target="tab-general"]`, `.tab-btn[data-target="tab-keys"]`, `.tab-btn[data-target="tab-associations"]`, `.tab-btn[data-target="tab-customization"]`, `.tab-btn[data-target="tab-language"]`.
     - Controls: `#opt-show-hidden`, `#opt-start-dir`, `#btn-browse-start`, `#opt-continue-last`, `#opt-remember-last-image`, `#opt-single-instance`, `#opt-hide-chrome-fullscreen`, `#opt-open-first-image`, `#opt-keyboard-pan-step`, `#opt-wheel-pan-step`, `#opt-hide-cursor-delay`, `#opt-portable-mode`.
     - Customization: `.theme-btn`, `.theme-btn[data-theme="..."]`, `#opt-custom-css`, `#btn-save-apply-css`.
     - Footer: `#btn-save-options`, `#btn-cancel`, `#options-status`.
   - Analysis: All queried elements use ID selectors or data-target attribute selectors. None query specific stylesheet links.

2. `06-configuration.e2e.js`:
   - Lines 19-21:
     `await expect(optionsPage.tabGeneral).toHaveElementClass('active');`
     `await expect(optionsPage.optShowHidden).toBeDisplayed();`
     `await expect(optionsPage.optContinueLast).toBeDisplayed();`
   - Line 34:
     `await expect(optionsPage.customCssTextarea).toBeDisplayed();`
   - Lines 56-70:
     `await browser.execute(() => document.documentElement.dataset.theme);`
   - Analysis:
     `toBeDisplayed()` requires that computed style `display` is not `none` and `visibility` is not `hidden`.
     When `options.css` is split, `.tab-content.active` in `src/css/options/options.css` sets `display: flex`.
     Inside `#tab-customization`, `.custom-css-editor textarea` in `src/css/options/custom-css.css` sets `display: block`.
     Because all stylesheets are linked in `<head>`, all display rules are active before test assertions evaluate.

3. Other pageobjects (`menubar.page.js`, `statusbar.page.js`, `viewer.page.js`, `filepanel.page.js`):
   - All operate exclusively on `src/index.html` and `src/css/main.css`. Zero impact from options CSS modularization.

### Exact architecture documentation lines to update in Phase 7

When CSS modularization is completed in Phase 4 and finalized in Phase 7, the following lines across repository documentation and architecture rules describe single `main.css` and `options.css` sheets and must be updated:

1. `.agents/AGENTS.md`:
   - Line 61:
     Current text: `Shared tokens, resets, and cross-page rules live in global.css. Each HTML page has its own sheet for layout and components.`
     Update required: Note that Options window layout is partitioned into feature stylesheets under `src/css/options/` while maintaining single-writer modularity.

2. `.agents/architecture-state.md`:
   - Line 45:
     Current text: `main.css / options.css / metadata.css: that window's layout only, including detached workspace surface layout and panel orientation rules in main.css. Consume tokens; do not redeclare them.`
     Update required: Change `options.css` to `options/` directory containing `options.css`, `keybinds.css`, `associations.css`, and `custom-css.css`.

3. `README.md`:
   - Lines 340-344:
     Current text:
     ```text
     ├─ css/
     │  ├─ global.css               # Shared colors and type
     │  ├─ main.css                 # Main window layout
     │  ├─ options.css              # Options layout
     │  └─ metadata.css             # Archive Info layout
     ```
     Update required: Expand `src/css/` directory tree to document `src/css/options/` sub-sheets.

4. `.agents/major-refactor/roadmap.md`:
   - Line 41:
     Current text: `- **One CSS sheet per HTML page:** Keep global.css, main.css, options.css, and metadata.css as the sole sheets. Do not split CSS into component fragments.`
     Update required: Clarify that the rule prohibits uncontrolled component fragmentation across deep directories, while allowing feature-level domain sheets for Options tabs (`options/options.css`, `options/keybinds.css`, `options/associations.css`, `options/custom-css.css`).
