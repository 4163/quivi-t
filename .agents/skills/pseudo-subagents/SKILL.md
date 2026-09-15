---
name: pseudo-subagents
description: "Trigger ONLY when the user explicitly asks to 'emulate' subagents, use 'pseudo-subagents', or specifically requests shelling out to the opencode CLI. Do not trigger for general subagent requests, as the harness may have native subagent tooling."
argument-hint: "<research targets or parallel subtasks>"
---

# Pseudo-subagents

Use this skill to perform concurrent, deep factual research without polluting the main conversation's context window. Instead of doing heavy discovery locally, spin up headless OpenCode instances in parallel, task them with targeted exploration, and have them write maps/reports directly to `.agents/scratch/`.

## Workflow

1. **Identify targets.** Break the research goal into discrete, non-overlapping domains (for example, pipeline A, pipeline B, IPC layer).
2. **Launch subagents.** Use the `run_command` tool to spawn headless `opencode` instances concurrently.
   - You MUST pipe `$null` to `opencode` in PowerShell to avoid hanging on standard input.
   - Default to using the `opencode/muse-spark-1.3-contributor-free` model at `--variant xhigh` unless specified otherwise.
   - Direct the agents to output findings directly to a designated scratch folder (e.g., `.agents/scratch/<domain-name>.md`).
3. **Wait and gather.** Wait for the background `run_command` tasks to complete. Do not poll. The system will notify you when they finish.
4. **Synthesize.** Read the output files generated and synthesize the findings for the main context.

## How to prompt

When crafting the `<prompt>` for the subagent, follow these guidelines to get the best results:
1. **Be specific about boundaries.** Tell the subagent exactly which files or directories to read (for example, "Thoroughly read `core.js` and `actions.js`.").
2. **Demand factual mapping.** Instruct the subagent to trace, map, or analyze rather than solve (for example, "Map out the state mutation pipeline. Do not suggest fixes.").
3. **Specify the exact output path.** Explicitly tell the subagent where to write the file so you can read it later (for example, "Write your findings directly to `.agents/scratch/state_machine.md`.").
4. **Avoid conversational fluff.** The subagent is headless and one-shot; give it raw, actionable, and comprehensive instructions.

## Command template

```powershell
$null | opencode run --auto -m opencode/muse-spark-1.3-contributor-free --variant xhigh "<prompt>"
```

*Note: Ensure the target output directory (e.g., `.agents/scratch/`) exists before launching subagents, or explicitly instruct the subagents to create it.*
