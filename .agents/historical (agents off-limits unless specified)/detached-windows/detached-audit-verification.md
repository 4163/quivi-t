Compared against `.agents/skills/validate-changes/SKILL.md` rules.

# Detached window audit verification

Target range: `35f38e9..dc61d10` on `feature/window-relocation`.
Baseline reports: `.agents/08-synthesis.txt` and `.agents/scratch/detached-audit-reports/01` through `07`.

## Summary

Current branch work addresses all ten confirmed findings and all seven conditional risks from `.agents/08-synthesis.txt`. Three items include practical design deviations from the original audit assumptions or follow-up prompts, while preserving the intended user behavior. Pre-existing legacy items rejected in the synthesis report remain out of scope.

## Confirmed findings

- **Finding 01. Auxiliary windows opening off-screen when main is minimized.** Resolved with a behavioral deviation. Instead of centering Options or Archive Info over the detached File List while leaving the main viewer minimized, opening either auxiliary window now restores and focuses the main viewer first, then centers the dialog over main within clamped monitor bounds. If main still has no usable bounds, centering falls back to the current monitor.
- **Finding 02. Options Save overwriting live workspace state.** Resolved. Options flushes any pending main-window config writes, reloads the live configuration as its base, and overlays only Options-managed fields. Active fit modes, scaling, spread, manhwa mode, thumbnail view, directory sort preferences, and current navigation paths stay intact on Save.
- **Finding 03. Preview theme and CSS overrides sticking in the detached File List after Save.** Resolved. Both the main window and the detached File List clear active preview overrides when settings are saved or when Options closes and reverts previews.
- **Finding 04. Detaching the File List during an active theme preview opening with stale styling.** Resolved. Newly created workspace and auxiliary windows inherit the active theme and shell background from main, receive active in-memory theme and CSS previews in the initial session snapshot, and finish background synchronization before showing.
- **Finding 05. Duplicate metadata extraction and broadcast race across windows.** Resolved. The main window is now the sole metadata producer, guarded against out-of-order async completions and locked archives. The detached File List receives metadata availability through session snapshots and forwarded events so its badge updates without running duplicate parsers or canvas resizes.
- **Finding 06. Manhwa strip scroll settle not updating the detached File List or Favorites.** Resolved with a transport deviation. Rather than forwarding a separate settle event across the wire, main publishes the visible strip indices on settle, and the detached replica triggers the local settle update when that strip info arrives. Both list selection and Favorites in-view markers update without stealing window focus.
- **Finding 07. Library active provider filter not syncing across windows.** Resolved. Active provider changes forward in both directions between main and the detached File List without echo loops, keeping storage, the Library view, and the Imports menu aligned.
- **Finding 08. Detached File List deletion failure toast not reaching the main status bar.** Resolved. Status flash events from failed deletions on the detached replica forward to main and appear on the visible status bar.
- **Finding 09. Manhwa strip top-boundary reveal targeting hidden DOM on main.** Resolved. The detached File List reports its top-scroll state to main, and top-boundary pan or jump reveals route to the detached File List while keeping the boundary hold active until the list is at the top.
- **Finding 10. Modal prompt focus loss across detached windows.** Resolved. Workspace actions track which window initiated the flow. Password and URL prompts bring the main viewer to the foreground before focusing the input field, block background focus grabs from the detached File List, and return focus to the initiating window when cancelled with Escape.

## Conditional risks

- **Risk 01. Inter-window request flood during gallery scroll in the detached File List.** Resolved. Visible-range updates from the detached File List coalesce behind a single in-flight request, and new gallery queues seed from the last known visible range.
- **Risk 02. Replica download status path separator mismatch on Windows.** Resolved. Replica download status keys normalize path separators and casing, seed initial queue statuses on startup, and repaint existing rows on snapshot load.
- **Risk 03. Library relocation ignored by replica thumbnail caches.** Resolved. Library relocation dispatches a dedicated event prior to the library update event and forwards it to the detached File List, clearing file, Favorites, and Library thumbnail caches.
- **Risk 04. Initial attachment missing visible strip range in Manhwa view.** Resolved. Full workspace snapshots include the current visible strip indices so the detached File List marks visible strip rows on first render.
- **Risk 05. Windows foreground lock and file dialog parenting from the detached window.** Resolved. Open Directory and Open File actions now run on the active window so native file pickers parent to the window where they were triggered, and modal prompts request native window focus before input focus.
- **Risk 06. Native titlebar close on Options dropping async preview reversion.** Resolved. Closing Options via the native titlebar close button while previewing intercepts immediate destruction, awaits theme and CSS reversion across windows, and then closes.
- **Risk 07. Second instance launch leaving the detached File List minimized.** Resolved. Single-instance handoff and tray restore unminimize all secondary windows alongside main.

## Additional lifecycle deviation

- **Detached File List close button behavior.** The original audit reports and manual checklist expected clicking the native close button on the detached File List window to quit the entire application. Commit `a4a3a71` intentionally changed this contract. The detached File List titlebar close button is now disabled and muted, close requests are blocked, and any unexpected closure of the detached window docks the File List back into the main window instead of quitting the app.

## Rejected report items left unchanged

- **Report 01 CR-02. Multi-monitor DPI submenu clipping.** Rejected in synthesis as an untraced hypothesis; left unchanged.
- **Report 05 RISK-OPT-02. Config watcher rebinding across Roaming and Portable toggle.** Rejected in synthesis as pre-existing behavior outside detached window scope; left unchanged, though split-config save ordering and reload generation guards were hardened.
- **Report 07 GAP-07-03. Metadata window staying populated when navigating to a folder without metadata.** Rejected in synthesis as pre-existing single-window behavior; left unchanged.
- **Report 07 RISK-07-02. Duplicate hint ID in Options markup.** Rejected in synthesis as non-functional markup hygiene; left unchanged.
