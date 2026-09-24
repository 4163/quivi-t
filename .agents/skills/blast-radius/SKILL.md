---
name: blast-radius
description: "When a change touches shared behavior, IPC contracts, config schemas, archive modules, cross-window state, or protocol URLs: find what it could break beyond the diff and prove safety by running code, not writing it up."
argument-hint: "<shared surface or file changed>"
---

# Blast radius

Find what a change breaks somewhere else, before it ships. Use it for "blast radius of X", "what could this break", or a small diff in shared behavior that should be checked before it lands.

Read the diff first. Then read `.agents/architecture-state.md` for the modules next to that change. Look for a consumer the diff never names: a caller that treats a return value differently, a config file already on disk, an IPC payload the other side still sends, a protocol URL that moved, or one window writing state that another window reads. Grep will list the direct callers. The miss is usually one step past them.

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

## What to trace

Start from the diff. For each changed function, type, command, key, token, or URL, find who else interprets it. Typical places:

- A caller that reads a return value or payload differently from the writer
- A config file or other saved file that already exists on disk
- An IPC name or JSON field the other side still sends
- A URL, header, or storage key another window or page still requests
- A CSS token, class, or element id a stylesheet or probe still matches
- An action id a menu, shortcut, or saved scenario still dispatches

Stay inside what the diff reaches.

## Pick a test

Run the smallest existing test that calls the real code and fails if you are wrong. Search the test directories for the name you changed. A `cargo test` filter, one mocha file, or one e2e spec is the usual fit. `cargo check --tests` is enough while types are still moving. Save the full suite for a change that crosses several of the zones above, or for final signoff.

## Steps

1. Read the change.
2. Trace who consumes each modified function, type, command, token, or contract. Go past direct callers to indirect readers: files on disk, other windows, the protocol handler, CSS that matches a class you renamed.
3. For each consumer, name the failure if the change is wrong.
4. Climb the confidence ladder. Prove safety with code where that is cheap. Use the test picked above. Flag anything stuck at steps 1 and 2.
5. Fix broken downstream consumers in the same slice. If you cannot reach confidence step 4 for a critical safety fact, tell the user what still needs a manual check.
