---
name: update-architecture-state
description: "Trigger when the user asks to explicitly update the architecture state tracking in .agents/architecture-state.md and the README.md Documentation section."
argument-hint: "<refactor or restructuring summary>"
disable-model-invocation: true
---

# Update architecture state

Use this skill when explicitly requested by the user to update the architecture state after a major refactor or system behavior change. This ensures the architectural map stays perfectly synced with the code.

Read and follow `.agents/skills/unslop/SKILL.md` for all written output.

## Scope

- `.agents/architecture-state.md`
- `README.md` sections: `## Documentation` (and its subsections: see specs below), `## Project Structure`.
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

## Instructions

1. **Analyze:** Map the changes from the refactor or feature implementation to the existing architectural documentation.
2. **Surgical Updates:** Edit only the specific lines, lists, or paragraphs that govern the module or logic that changed. Do not rewrite entire sections.
3. **Verify Project Structure:** If files or directories were added, moved, or deleted, update the ASCII tree under `## Project Structure` in the `README.md` to match the current filesystem.
4. **Maintain Principles:** Ensure new descriptions enforce QuiviT's core rules (e.g., "One owner per concern", "Pure modules first", state callbacks vs DOM reach-in).
