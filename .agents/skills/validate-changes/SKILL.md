---
name: validate-changes
description: "Trigger only when asked to 'validate'. Runs an architectural review against AGENTS.md and checks for stale code and references. Do not use this for general slice completion, instead use verify-implementation."
argument-hint: "<files, diff, branch, or working tree>"
---

# Validate changes

Use this skill to run a strict compliance check of code changes against the repository's architectural standards (`.agents/AGENTS.md`). This acts as an adversarial review to catch regressions, drift, or violations before a branch is considered done.

## Important Constraint

**Reporting Only:** This skill is strictly an adversarial review tool. Do NOT attempt to automatically fix the violations you find. Your goal is solely to identify issues and report them to the user. 

## Workflow

1. **Scope the Review:**
   Identify what you are reviewing based on the user's request (e.g., the current working tree, staged changes, or a specific commit range/branch).
   - Use `git status`, `git diff`, or `git diff --cached` to gather the code changes.
   - If the diff is large, focus on files that affect core logic, architecture, UI, and performance.

2. **Review Against `.agents/AGENTS.md`:**
    Read and cross-reference the changes specifically against the guidelines in `.agents/AGENTS.md`. Pay special attention to:
    - **Code Guidelines:** Are we using flat control flow and early returns? Are hot paths caching aggressively? Are there any dynamic evaluations where O(1) lookups could be used? Are background threads used correctly for blocking tasks? Are commits grouped in logical slices?
    - **HTML-First Rendering:** Are we relying on static markup? Are we toggling visibility via CSS classes instead of `createElement` / `innerHTML`? Are nodes being recycled?
    - **CSS Source of Truth:** Is JS setting intrinsic visual values inline (e.g., `width`, `color`, `display`) instead of relying on CSS custom properties or classes?
    - **JS Module Ownership:** Do UI modules only subscribe to pure state modules (not the reverse)? Are modules using state callbacks instead of cross-module reach-in?
    - **Rust Encapsulation:** Are facade methods used instead of public field reach-in? Is there exactly one concern per module? Is test visibility restricted correctly using `#[path]`?
    - **Stale code and references:** Are there unused imports, dead functions, orphaned files, outdated comments, or stale paths that point to moved or renamed modules? Does the diff leave behind code that is no longer reachable? Use grep for old names, check imports, and verify every moved file has its callers updated.

    For every finding, mark impact. Use `[Observable change]` if it changes externally observable behaviour and `[No observable change]` if it is dead code, unused import, comment, formatting, or docs only. Observable means any external contract: UI, IPC return shape, config or persistence schema, protocol, cross-window state, or performance, not just UX.

3. **Synthesize the Verdict:**
   Output your findings in a structured Markdown format for the user:

    ```markdown
    ## Validation Report
    
    **Target:** (e.g., Working tree, staged changes, or branch name)
    **Summary:** (A high-level 1-2 sentence description of what the diff accomplishes)
    
    ### AGENTS.md Violations
    (List any specific blocking issues, architectural drift, code smells, or rule violations found during the review. If none, explicitly state "None".)
    - [File:Line] [Observable change or No observable change] Describe the violation and which AGENTS.md rule it breaks.
    
    ### Stale code and references
    (List unused imports, dead functions, orphaned files, outdated comments, or stale paths that point to moved or renamed modules. If none, explicitly state "None".)
    - [File:Line] [Observable change or No observable change] Describe the stale reference and why it is no longer needed.
    
    ### Verdict
    (Pass / Nits / Fail / Pass with Warnings)
    (Provide recommendations on how the user should remediate the violations, if any.)
    ```
