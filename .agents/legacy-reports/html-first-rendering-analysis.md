# QuiviT HTML-First Rendering — Working Tree Audit & Refactoring Specification

> **Date:** August 15, 2026  
> **Scope:** Active HTML entry points (`index.html`, `options.html`, `metadata.html`), CSS stylesheets (`src/css/`), and decoupled JavaScript modules (`src/js/`).  
> **Reference Standard:** `.agents/additions.md` ("### HTML-First Rendering: Prefer Static Elements over Dynamic Injection") & `.agents/AGENTS.md`.

---

## 1. Core Principles (Applied to Current Code)

1. **Static Elements over Dynamic Injection:** UI structures, modals, badges, bridge image slots, and table structures must be pre-declared in static HTML files rather than created dynamically with `document.createElement()` or `innerHTML`.
2. **CSS Class / Token State Machine:** Toggle visibility and states using CSS classes (`.active`, `.hidden`, `.is-visible`, `.cursor-move`) or CSS custom properties (`--*`) instead of removing/re-inserting DOM nodes.
3. **Upfront Placeholders & Zero Layout Shift:** Placeholders, skeletons, and fixed DOM pools must exist up front in HTML to eliminate LCP delay and layout reflow freezes.
4. **CSS as the Single Source of Visual Truth:** Intrinsic visual styles (`width`, `height`, `display`, `cursor`, `image-rendering`, colors) must never be written inline via JS; JS only mutates CSS custom properties on `:root` or viewport matrix transforms.

### 3-Tier Scope & Class Assignment Standard (Performance-First Architecture)

To minimize browser engine (Blink/WebView2) style recalculations and eliminate full-tree layout invalidation walks, all class assignments and CSS variable scopes follow a strict 3-tier model:

| Tier | Target Scope | Intent & Performance Characteristics | QuiviT Architectural Examples |
|---|---|---|---|
| **Tier 1 (Global)** | `<body>` / `<html>` | Window-wide interaction modes, global drag cursor locks, app themes. Direct rules only (`body.cursor-move { cursor: move !important; }`) — never broad descendant selectors (`body.foo *`). | `body.cursor-move`, `body.resizing-panel`, `body.resizing-col`, `body.is-fullscreen`, `html[data-theme]` |
| **Tier 2 (Component / Container)** | Host Container / Parent Node | Compound multi-element state coordinated within a single module; locally-scoped custom properties (`--*`) to restrict inheritance recalc. | `#file-panel` (`--panel-w`), `.keybind-row.is-conflict`, `#file-list.is-empty` |
| **Tier 3 (Leaf / Direct Element)** | Target Element (Default) | Single-element state & visibility toggles. Highest performance: $O(1)$ localized invalidation bounded strictly to target node. | `.viewer-img.active`, `.viewer-img[data-scaling="none"]`, `#metadata-badge.is-visible`, `li.is-selected` |

---

## 2. Working Tree Compliance Matrix

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   WORKING TREE COMPLIANCE AUDIT                                  │
├───────────────────────────────┬──────────────────────────┬───────────┬───────────────────────────┤
│ File / Module                 │ Current DOM Operations   │ Status    │ Required Refactoring      │
├───────────────────────────────┼──────────────────────────┼───────────┼───────────────────────────┤
│ `src/index.html`              │ Static host markup       │ Partial   │ Remove inline display;    │
│                               │                          │           │ add loading placeholder   │
│ `src/options.html`            │ Options dialog markup    │ Non-Compl.│ Pre-render static keybind │
│                               │                          │           │ table & associations grid │
│ `src/metadata.html`           │ Inspector window markup  │ Partial   │ Pre-render standard grid  │
│ `src/js/viewer/viewerRender`  │ Two-Image DOM bridge     │ Non-Compl.│ Remove dynamic pool alloc,│
│                               │                          │           │ inline display & scaling  │
│ `src/js/viewer/viewerGestures`│ Viewport gestures & pan  │ Partial   │ Use body cursor classes   │
│ `src/js/filepanel/filePanel`  │ List rendering & sizing  │ Non-Compl.│ Fix --panel-w bypass,     │
│                               │                          │           │ virtualize DOM row pool   │
│ `src/js/main/metadataBadge.js`│ Metadata trigger badge   │ Partial   │ Replace inline display    │
│ `src/js/main/fullscreen.js`   │ Top-edge HUD & Exit btn  │ Partial   │ Replace measurement probe │
│ `src/js/options/keybindUi.js` │ Keybind editor & capture │ Non-Compl.│ Stop innerHTML rebuild;   │
│                               │                          │           │ update static tag slots   │
│ `src/js/options/associations` │ Format associations UI   │ Non-Compl.│ Sync static checkboxes;   │
│                               │                          │           │ stop innerHTML rebuild    │
│ `src/js/metadata-window.js`   │ Metadata inspector sync  │ Partial   │ Update static slots       │
│ `src/js/shared/shellBackground` Native surface color probe│ Partial  │ Replace dynamic probe div │
│ `src/js/shared/theme.js`      │ Theme & Custom CSS       │ Partial   │ Pre-embed <style> in head │
│ `src/js/core.js`              │ Pure State Machine       │ Compliant │ Zero DOM dependencies     │
│ `src/js/services/*`           │ Domain Logic & Math      │ Compliant │ Zero DOM dependencies     │
│ `src/js/menubar/*`            │ Menu Bar & Status Bar    │ Compliant │ Uses pure class toggles   │
└───────────────────────────────┴──────────────────────────┴───────────┴───────────────────────────┘
```

---

## 3. Detailed File-by-File Audit & Refactoring Targets

### A. Viewer Subsystem

#### 1. [`src/index.html`](file:///E:/Projects/QuiviT/src/index.html) & [`src/js/viewer/viewerRender.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerRender.js)
- **Problem:**
  - `index.html` lines 165–166 have inline `style="display: none;"` attributes on `#viewer-img` bridge elements.
  - `viewerRender.js` (lines 16–33, 105–110) dynamically calls `createElement('img')` and `pop()?.remove()` during pool operations.
  - `viewerRender.js` (lines 74, 112, 127, 147, 152, 251) mutates inline `style.display = 'none'`/`'block'` and `style.imageRendering`.
  - Missing upfront broken-image loading placeholder (`alt="Loading..."`).
- **Refactoring Requirement:**
  1. Declare a fixed static structure in `index.html`:
     ```html
     <div id="viewer-img-wrapper">
       <img id="viewer-loading-frame" class="viewer-img is-placeholder" alt="Loading..." src="data:image/svg+xml;base64,broken" draggable="false">
       <img id="viewer-img-primary" class="viewer-img" decoding="async" alt="" draggable="false">
       <img id="viewer-img-secondary" class="viewer-img" decoding="async" alt="" draggable="false">
     </div>
     ```
  2. In `main.css`:
     ```css
     .viewer-img { display: none; }
     .viewer-img.active { display: block; }
     .viewer-img[data-scaling="none"] { image-rendering: pixelated; }
     ```
  3. In `viewerRender.js`: Remove all `createElement`, `pop()?.remove()`, and inline `style.display` assignments. Toggle `.active` class exclusively.

#### 2. [`src/js/viewer/viewerGestures.js`](file:///E:/Projects/QuiviT/src/js/viewer/viewerGestures.js)
- **Problem:** Lines 64 & 72 mutate `document.body.style.cursor = 'move'` and `''` inline.
- **Refactoring Requirement:** Use `document.body.classList.toggle('cursor-move', isPanning)` with rule `body.cursor-move { cursor: move !important; }` in `global.css`.

---

### B. File Panel Subsystem

#### 1. [`src/js/filepanel/filePanel.js`](file:///E:/Projects/QuiviT/src/js/filepanel/filePanel.js)
- **Problem 1 (CSS Variable Bypass on Panel Resize):** Line 770 executes `filePanel.style.width = \`${newWidth}px\`` directly.
  - *Fix:* Update root CSS variable: `document.documentElement.style.setProperty('--panel-w', \`${newWidth}px\`)`.
- **Problem 2 (Inline Attributes in Icons):** `getIconHtml` (lines 229, 232, 238) injects `width="14" height="14" style="object-fit:contain;image-rendering:pixelated"`.
  - *Fix:* Remove inline attributes and let `.item-name > img` in `main.css` handle sizing and rendering.
- **Problem 3 (Unbounded DOM Teardown & Allocation):** Lines 344 & 608 clear `innerHTML = ''` and recreate thousands of `<li>` nodes during directory/favorites navigation.
  - *Fix:* Allocate a bounded pool of ~40 static `<li>` nodes inside `#file-list` and recycle them on scroll/navigation.
- **Problem 4 (Inline Resize Cursors):** Lines 723, 760, 793 mutate `document.body.style.cursor = 'col-resize'` / `'ew-resize'`.
  - *Fix:* Toggle `body.classList.toggle('resizing-panel', true)` / `body.classList.toggle('resizing-col', true)`.

---

### C. Options Dialog Subsystem

#### 1. [`src/options.html`](file:///E:/Projects/QuiviT/src/options.html) & [`src/js/options/keybindUi.js`](file:///E:/Projects/QuiviT/src/js/options/keybindUi.js)
- **Problem:**
  - `options.html` lines 115–117 leave `#keybinds-container` completely empty.
  - `keybindUi.js` (lines 327–438) calls `container.innerHTML = ''` and recreates all category headers, rows, labels, and buttons on every keystroke capture or dialog opening.
  - Lines 361–362 mutate `tag.style.color` and `tag.style.borderColor` directly.
- **Refactoring Requirement:**
  1. Pre-render static category headers and action rows directly in `options.html`. Each row includes a static `<div class="keybind-tags" data-action="cmd-id"></div>`.
  2. `renderKeybinds()` only updates the key tags inside each existing row slot without wiping the container.
  3. Style conflict tags using `--conflict-color` custom property and `.conflict` class.

#### 2. [`src/options.html`](file:///E:/Projects/QuiviT/src/options.html) & [`src/js/options/associationsUi.js`](file:///E:/Projects/QuiviT/src/js/options/associationsUi.js)
- **Problem:**
  - `options.html` lines 130–132 contains a temporary `<p>Loading formats...</p>` that is destroyed with `innerHTML = ''`.
  - `associationsUi.js` (lines 52–98) builds all category headers, cards, and format checkboxes at runtime.
- **Refactoring Requirement:**
  1. Declare the static format cards and checkboxes directly in `options.html`.
  2. `initAssociationsUi()` queries existing checkboxes and sets `.checked = true/false` based on backend registration.

#### 3. [`src/options.html`](file:///E:/Projects/QuiviT/src/options.html) Cleanup
- **Problem:** Line 125 has inline `style="margin-bottom: 10px;"`.
- **Refactoring Requirement:** Move to `.assoc-actions` class in `options.css`.

---

### D. Standalone Metadata Window

#### 1. [`src/metadata.html`](file:///E:/Projects/QuiviT/src/metadata.html) & [`src/js/metadata-window.js`](file:///E:/Projects/QuiviT/src/js/metadata-window.js)
- **Problem:** `metadata-window.js` (lines 55–97) calls `gridEl.replaceChildren(...)` and creates dynamic span elements on every render.
- **Refactoring Requirement:**
  1. Pre-render standard metadata row slots in `metadata.html` (e.g. `<span class="meta-label" data-key="date">Date</span><span class="meta-val" data-key="date"></span>`).
  2. `render()` updates `textContent` on existing elements and toggles `.hidden` on absent rows.

---

### E. Probes, Backgrounds & Theme Custom CSS

#### 1. Measurement Probes ([`fullscreen.js`](file:///E:/Projects/QuiviT/src/js/main/fullscreen.js) & [`shellBackground.js`](file:///E:/Projects/QuiviT/src/js/shared/shellBackground.js))
- **Problem:** Dynamically create `div` probe elements with inline `probe.style.cssText = 'position:absolute;left:-9999px;...'`.
- **Refactoring Requirement:** Use a pre-declared static `<div id="measure-probe" class="measure-probe" aria-hidden="true"></div>` in HTML or evaluate styles via `getComputedStyle(document.body).getPropertyValue('--surface')`.

#### 2. Theme Custom CSS ([`src/js/shared/theme.js`](file:///E:/Projects/QuiviT/src/js/shared/theme.js))
- **Problem:** Calls `document.createElement('style')` and appends it to `<head>` on first CSS application.
- **Refactoring Requirement:** Embed `<style id="custom-css"></style>` statically in the `<head>` of `index.html`, `options.html`, and `metadata.html`. `applyCustomCss()` then only updates `styleEl.textContent`.

#### 3. Metadata Badge ([`src/js/main/metadataBadge.js`](file:///E:/Projects/QuiviT/src/js/main/metadataBadge.js))
- **Problem:** Sets `badgeEl.style.display = 'inline-flex'` and `'none'`.
- **Refactoring Requirement:** Toggle `badgeEl.classList.toggle('is-visible', hasMetadata)` with CSS handling visibility.

---

## 4. Working Tree Refactoring Action Slices

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   REFACTORING ACTION SLICES                                      │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ SLICE 1: CSS AS SINGLE SOURCE OF TRUTH (Zero Inline Visual Styles)                               │
│  - Refactor filePanel.js line 770: update --panel-w CSS custom property on :root.                │
│  - Strip inline width/height/style from getIconHtml; bind sizing to .item-name > img in CSS.     │
│  - Replace viewerRender.js style.display & style.imageRendering with .active & data-scaling.    │
│  - Replace viewerGestures.js & filePanel.js body.style.cursor with body CSS classes.             │
│  - Remove inline style attributes from index.html (lines 165-166) and options.html (line 125).   │
│  - Replace metadataBadge.js style.display with .is-visible class toggle.                         │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ SLICE 2: STATIC EMBEDDING & UPFRONT SKELETONS                                                    │
│  - Embed <style id="custom-css"></style> statically in <head> of all 3 HTML files.              │
│  - Pre-render static keybinding categories, action rows, and tag slots in options.html.          │
│  - Pre-render static file associations category cards and checkboxes in options.html.           │
│  - Pre-render standard metadata label/value slots in metadata.html.                             │
│  - Embed static animated broken-image loading placeholder <img id="viewer-loading-frame">.       │
│  - Replace dynamic measurement probe creation with static probes in HTML.                        │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ SLICE 3: FILE PANEL DOM VIRTUALIZATION & POOL RECYCLING                                          │
│  - Replace innerHTML = '' and mass <li> construction in filePanel.js with a fixed 40-row        │
│    virtualized DOM pool recycled on scroll.                                                      │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```
