---
name: blast-radius
description: "When a change touches shared behavior, IPC contracts, config schemas, archive modules, cross-window state, or protocol URLs: find what it could break beyond the diff and prove safety by running code, not writing it up."
argument-hint: "<shared surface or file changed>"
---

# Blast radius

Find what a change breaks somewhere else, before it ships. Use for "blast radius of X", "what could this break", or reviewing a small diff you don't trust yet.

Listing callers is not the job. The agent can grep those in a second. The job is the breakage grep won't show you: downstream consumers that interpret a return value differently, config shapes that changed under existing persisted files, IPC contracts that shifted, protocol URLs that moved, or cross-window state that one side writes and another reads.

## Don't trust your own writeup

A blast-radius writeup that sounds right is worthless. It reads as convincing whether or not it's true. Find the one or two facts the whole thing depends on and prove them by running code. Words are where you start, not what you ship.

### Confidence ladder

For each fact the change's safety depends on, get it as far down this list as is cheap, and say where it stopped.

1. **You said so.** Worthless on its own.
2. **You pointed at the line.** A real `file:line` reference.
3. **You showed the bad case can't happen.** You walked the failure path step by step and it doesn't reach.
4. **You ran it.** A script or test that calls the real code and fails loud if you're wrong.
5. **You reproduced it in the running app.**

Any safety fact you can't get to step 4, say so out loud. Don't write it up as settled.

## QuiviT surfaces to check

These are the repo's common blast-radius zones. Not every change touches all of them. Scope your analysis to what the diff actually reaches.

- **IPC commands** (`src-tauri/src/commands/`): changed return types, renamed commands, or shifted payloads break the JS caller.
- **Config schema** (`src-tauri/src/config.rs`): changed keys, types, or defaults break existing user config files and portable-mode paths.
- **Archive & format readers** (`src-tauri/src/archives/`, `src-tauri/src/formats.rs`): changed entry shapes, sort orders, or cache keys break virtual directory traversal and viewer navigation.
- **Protocol URLs** (`src-tauri/src/protocol.rs` handling `asset://`, `quivi://`): changed routes or response headers break image loading and cross-window preview.
- **Platform & Windowing** (`src-tauri/src/platform/`, `src-tauri/src/windows.rs`): changed native integrations, file associations, or window spawning logic break OS-level behaviors.
- **Cross-window state** (`localStorage`, theme, preview payload): changed shapes or keys break secondary windows that read what the primary writes.
- **CSS tokens** (`global.css` `:root`): changed or removed custom properties break downstream page sheets and theme application.
- **Action registry** (JS service modules): changed action ids, labels, or handler signatures break menus, shortcuts, and context menus.
- **State machine** (JS core): changed state shapes or callback contracts break every UI subscriber.

## Steps

1. Read the change.
2. For each modified function, struct, command, token, or contract: trace who consumes it. Go beyond direct callers to indirect readers (config files on disk, other windows, the protocol handler, CSS selectors that match on a class you renamed).
3. For each consumer, determine the failure mode if the change is wrong.
4. Climb the confidence ladder. Prove safety with code where cheap. Flag anything stuck at steps 1 and 2.
5. Act on the findings. Fix any broken downstream consumers in the same slice. If you cannot reach confidence step 4 for a critical safety fact, explicitly warn the user and explain what needs manual validation before considering the task done.
