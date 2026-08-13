user note for initial familiarization:
"
read '.agents/familiarize.md' and follow its guidance.
"

# Familiarize

## 1. Learn the codebase

- Walk the file and directory structure from the root down before diving into any single file. Build a mental map of how the project is organized.
- Identify the architecture: languages and frameworks in use, how modules/services/layers are separated, where the entry points are (main files, routers, config), and how data and control flow through the system.
- Read the package manifest(s) (`package.json`, `requirements.txt`, `Cargo.toml`, etc.), build/config files, and any existing README or architecture docs.
- Note the conventions already in place — naming, folder layout, testing patterns, style — so new work fits the codebase instead of fighting it.
- **Most importantly, read and strictly adhere to the quality standards and rules outlined in the `.agents/AGENTS.md` guidelines.**

## 2. Gather context from past agent sessions

- Read `.agents/sessions-index.md`.
- Pull full session data via `.agents/session-recovery.md`, but only for entries relevant to the latest working tree.
- Treat session notes as leads, not ground truth — verify anything important against the current code.

## 3. Use subagents to do this faster

- If subagents are available, don't run all of the above serially yourself — delegate.
- Split the work: one subagent maps the file/directory structure, another digests `.agents/sessions-index.md` and pulls relevant entries from `.agents/session-recovery.md`, another explores a specific subsystem in depth.
- Have each subagent report back a short, focused summary rather than raw output. That keeps exploration costs off your main context window and reduces total token usage.
- Reserve your own context for synthesis and decisions, not for absorbing raw exploration — that's what subagents are for.
