---
name: update-architecture-state
description: "Trigger when the user asks to explicitly update the architecture state tracking in .agents/architecture-state.md, AGENTS.md Architecture Rules, README.md Documentation section, and .agents/skills/blast-radius/SKILL.md surfaces."
argument-hint: "<refactor or restructuring summary>"
---

# Update architecture state

Use this skill when explicitly requested by the user to update the architecture state after a major refactor or system behavior change. This ensures the architectural map stays perfectly synced with the code.

Read and follow `.agents/skills/unslop/SKILL.md` for all written output.

## Scope

- `.agents/architecture-state.md`
- `.agents/AGENTS.md` section: `## Architecture Rules` (and its subsections: see specs below)
- `README.md` sections: `## Documentation` (and its subsections: see specs below), `## Project Structure`.
- `.agents/skills/blast-radius/SKILL.md` section `## QuiviT surfaces to check`. Treat it as architecture state, not a standalone checklist. Keep its zone list, file paths, and failure modes aligned with the current code and with `architecture-state.md`.
- Git: working tree, recent commits, current branch, or a user-specified range.

### README Documentation subsection specs

Each subsection under `## Documentation` has a fixed purpose. Update content within that purpose; do not let it drift into a changelog or narrative history.

| Subsection | Purpose |
|---|---|
| **System Defaults** | Current default values and behaviors that ship with the app. State what *is*, not what *changed*. |
| **Configuration & Persistence** | Where config lives, what keys exist, portable vs roaming rules. Schema reference, not migration log. |
| **Architecture** | Module boundaries, data/control flow, ownership rules. Reflect the current structure, not the history of refactors. |
| **File Associations (Windows)** | Registry paths, per-user registration mechanics, supported extensions. |
| **Command-Line Interface** | Accepted flags, arguments, and their behavior. |
| **Project Structure** | ASCII tree matching the current filesystem. Add/remove/move entries when files change. |

### AGENTS.md Architecture Rules subsection specs

`## Architecture Rules` is the current contract for where new work goes. Update a subsection only when the layering it describes actually changed. Rewrite the stale bullet. Do not append slice notes, "we now...", or a second line that restates an existing rule.

| Subsection | Purpose |
|---|---|
| **Shared** | Cross-layer invariants for every change: one owner, folders as a byproduct of splits, pure modules, callbacks not reach-in, do not split a single owner, refactors keep behavior unless there is a practical win. |
| **HTML-First Rendering** | How DOM is created and updated. Markup over `createElement`, CSS classes for state, recycle existing nodes. |
| **CSS Source of Truth** | Where tokens live, which JS visual writes are allowed, 3-tier class and custom-property scope. |
| **JS Module Ownership** | Where new frontend work goes: state machine, services, UI owners, bootstrap, shared helpers. Current layering, not slice history. |
| **Rust Module Ownership** | Where new backend work goes: bootstrap, domain, commands, protocol / windows / platform / config, tests. Current layering, not slice history. |

### Blast-radius surfaces spec

`## QuiviT surfaces to check` in `.agents/skills/blast-radius/SKILL.md` is the blast-radius contract list. Update it when the code moves a source of truth.

| Zone | Keep in sync with |
|---|---|
| IPC commands | `src-tauri/src/commands/` and the JS caller in `src/js/` |
| Config schema | `src-tauri/src/config.rs`, `architecture-state.md` Config & Persistence |
| Archive & format readers | `src-tauri/src/archives/`, `src-tauri/src/formats.rs` |
| Protocol URLs | `src-tauri/src/protocol.rs` (`quivit://`, `asset://`) |
| Platform & Windowing | `src-tauri/src/platform/`, `src-tauri/src/windows.rs` |
| Cross-window state | `localStorage` keys, `architecture-state.md` Config & Persistence |
| CSS tokens | `src/css/global.css` `:root` and `AGENTS.md` CSS Source of Truth |
| Action registry | `src/js/services/actions.js` and `AGENTS.md` JS Module Ownership |
| State machine | `src/js/core.js` and `AGENTS.md` Shared / JS Module Ownership |

When a zone's path, shape, or consumer changes, rewrite the stale bullet in the blast-radius skill the same way you would rewrite a stale bullet in `architecture-state.md`. Do not append a second bullet that restates it.

## Instructions

1. **Analyze:** Map the changes from the refactor or feature implementation to the existing architectural documentation.
2. **Surgical Updates:** Edit only the specific lines, lists, or paragraphs that govern the module or logic that changed. Do not rewrite entire sections.
3. **Verify Project Structure:** If files or directories were added, moved, or deleted, update the ASCII tree under `## Project Structure` in the `README.md` to match the current filesystem.
4. **Architecture Rules:** If ownership or layering moved, update the matching subsection in `.agents/AGENTS.md` so the rule still describes the current contract. Prefer replacing a stale line over adding a clarifying paragraph.
5. **Blast-radius surfaces:** If a blast-radius zone changed (new command, config key, archive path, protocol route, window helper, storage key, CSS token, action id, or state shape), update `## QuiviT surfaces to check` in `.agents/skills/blast-radius/SKILL.md` to match. Apply the same surgical rule as above. If the diff touched a live contract, also run `blast-radius` steps 2-4 to trace consumers and climb the confidence ladder before documenting the new shape as settled.
6. **Maintain Principles:** New descriptions in `architecture-state.md`, README, and `blast-radius` still have to match those rules after the edit.
