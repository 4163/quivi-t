# Slice 3: Chrome/Visibility Consolidation

I have completed the JS DOM Decoupling for Slice 3, successfully extracting the menubar and statusbar visibility management into its own single-owner module.

## Changes Made

- **Extracted `src/js/menubar/chrome.js`:**
  - This new pure module now owns `menuBarVisible`, `statusBarVisible`, and the `_preFullscreenState`.
  - It exposes clean APIs: `setMenuBarVisible`, `setStatusBarVisible`, `toggleMenuBar`, and `toggleStatusBar`.
  - It now manages the DOM toggling (`.hidden`) for both bars.
  
- **Decoupled Checkmark Syncing:**
  - `updateViewToggleMenu` in `main.js` was a monolithic function that updated checkmarks for the file panel, menubar, statusbar, and fullscreen state.
  - This function has been eliminated. Now, `chrome.js` directly handles the checkmarks for the menubar and statusbar. `main.js` handles the fullscreen checkmark directly when toggling fullscreen, and `filePanel`'s toggle updates its own checkmark. This fully distributes DOM update responsibilities to the code that owns the state.

- **Consolidated Persistence:**
  - The redundant and competing debounce timers (`saveUIState` in `menubar.js` and inline persistence in `main.js`) were merged. 
  - `chrome.js` now exports a single `saveChromeState()` that safely debounces both states via `Core.persistConfig`.
  
- **Fullscreen Abstraction:**
  - `main.js` no longer worries about the implementation details of storing visibility state before entering fullscreen mode. It simply calls `Chrome.snapshotPreFullscreenChrome()` and `Chrome.restorePreFullscreenChrome()`.

## Validation Results

- Static analysis: `node --check` ran perfectly for all three files (`main.js`, `menubar.js`, `chrome.js`).
- Adherence to `AGENTS.md`: 
  - The slice respects *Measure twice, cut once* and *Work in logical slices* by maintaining a tightly focused change scope.
  - The implementation favors zero-overhead abstractions and keeps *performance first* (e.g., removing a large DOM lookup monolith in favor of targeted direct updates).
  - The code remains self-documenting without extraneous comments.

The repository is now in a clean state and ready for you to commit Slice 3 to the `refactor/decoupling` branch!
