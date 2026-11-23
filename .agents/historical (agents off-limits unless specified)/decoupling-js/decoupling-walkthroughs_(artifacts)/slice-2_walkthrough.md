# Walkthrough: JS DOM Decoupling: Slice 2 (Statusbar single-owner)

This slice resolved the "3-writer problem" where `main.js`, `viewer.js`, and `shortcuts.js` all competed to mutate the `#statusbar` DOM elements directly.

## What was changed

### 1. Created `menubar/statusbar.js`
- Created a new cohesive UI module that owns all queries and mutations for `#statusbar` and its children (`.status-*`).
- Exported a strict API: `Statusbar.update`, `Statusbar.setImage`, `Statusbar.setZoom`, and `Statusbar.setScrollIndicatorState`.
- Housed all text-writing idempotency checks internally to avoid redundant browser layouts.

### 2. Thinned out `main.js`
- Removed all `status*` element lookups and local variables.
- Removed the fragile `data-decoded="true"` and `.complete` logic that previously tried to guess when `viewer.js` was done loading an image.
- Replaced the direct DOM mutations inside the `Core.onStateChange` callback with a simple `Statusbar.update(state)` call to handle list index, fit mode, and empty states.

### 3. Updated `viewer.js`
- Removed local `status*` queries.
- Modified the image loading pipeline (`_activatePoolNode` and `_attachLoadHandler`) to explicitly push dimensions, zoom scale, and filenames to `Statusbar.setImage(...)` exactly when they are ready.
- Handled explicit loading (`Loading...`) and error (`Error`) states natively in the loader sequence instead of leaving it to `main.js`.

### 4. Updated `shortcuts.js`
- Migrated the idempotency logic inside `_updateScrollIndicator` entirely into `statusbar.js`.
- Shrank the function to pure input dispatch and logic, culminating in a `Statusbar.setScrollIndicatorState(text, held, latched)` call without touching the DOM.

## Verification
- Code quality statically verified with `node --check`. No syntax errors introduced.
- Re-verified that the implementation strictly adhered to the `additions.md` JS DOM Decoupling state-callback model rule.
- Appended the summary to the **Completed Slices Log** in `.agents/js-dom-decoupling-plan.md`.
