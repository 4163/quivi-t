# Skill workflow audit

Date: 2026-08-20

## Scope

This audit compares the current QuiviT workflow with skills from:

- pstack: <https://github.com/cursor/plugins/tree/main/pstack>
- mattpocock/skills: <https://github.com/mattpocock/skills>

Local source check used the current repository files, not stale project-structure notes. I treated these as current facts:

- QuiviT is a Tauri 2 desktop app with a Rust backend in `src-tauri` and vanilla ES-module frontend code in `src`.
- The current branch has already moved toward the intended shape: CSS as visual source of truth, HTML-first rendering, JS state and service decoupling, and Rust module decoupling.
- Existing workflow skills are [`unslop`](https://github.com/cursor/plugins/tree/main/pstack), `familiarize`, `session-recovery`, and `commit-pipeline`.
- The repo has good Rust checks through Cargo tests and syntax checks for frontend files, but no project-specific skill that drives the real Tauri UI and proves user workflows end to end.

## Executive recommendation

Do not install either repository wholesale as-is.

The best workflow improvement is a small curated set:

1. Adopt pstack verification and review skills.
2. Adopt Matt Pocock architecture and spec skills.
3. Keep QuiviT's existing [`unslop`](https://github.com/cursor/plugins/tree/main/pstack), `familiarize`, `session-recovery`, and `commit-pipeline` as the local source of authority.
4. Borrow pstack principles into a QuiviT mode or AGENTS update only after adapting them to this repo's stricter safety and commit rules.

The highest value missing piece is not another planning mode. It is a real verification skill for QuiviT that can launch or control the app, load representative image and archive fixtures, and prove UI behavior against the current standards.

## Manual follow-up selection

After review, the project is adopting only the parts that fit QuiviT's workflow:

- Add `validate-changes` for strict AGENTS.md compliance checks over commit ranges, branches, and diffs.
- Add explicit-only documentation updaters for `.agents/architecture-state.md`, the README documentation architecture section, and the top user-facing README feature section.
- Add `session-handoff` as a separate explicit skill. It should add agent-first continuation entries to `.agents/session-index.md`, then output a one-sentence copy/paste handoff message that tells the next agent to use `session-recovery`.
- Add `diagnose` for bug and performance work, with an instrumentation path for Rust timings, JS timings, Python-driven benchmarks, and cargo runtime tests.
- Defer [`blast-radius`](https://github.com/cursor/plugins/tree/main/pstack) until a separate audit pass. It is valuable, but it should be last because it needs tighter fitting to QuiviT's current architecture.

Do not add `spec-to-slices`, skill-maintenance, skill-creation, or generic agent-writing workflow skills for now. Current AGENTS.md rules and the user's harness/model choices already handle work chunking well enough.

## Current workflow gaps

| Gap | Why it matters now | Best skill source |
| --- | --- | --- |
| Real UI verification | CSS, HTML-first rendering, and viewer behavior need runtime proof, not just compile checks. | pstack [`create-verification-skill`](https://github.com/cursor/plugins/tree/main/pstack), then [`maintain-verification-skill`](https://github.com/cursor/plugins/tree/main/pstack) |
| Final branch review | This branch touched architecture across CSS, HTML, JS, and Rust. A normal review can miss cross-layer regressions. | pstack [`interrogate`](https://github.com/cursor/plugins/tree/main/pstack), Matt [`code-review`](https://github.com/mattpocock/skills/tree/main/skills/code-review) |
| Architecture drift detection | The repo has good rules, but future work can still reintroduce shallow modules or mixed ownership. | Matt [`codebase-design`](https://github.com/mattpocock/skills/tree/main/skills/codebase-design), [`improve-codebase-architecture`](https://github.com/mattpocock/skills/tree/main/skills/improve-codebase-architecture); pstack principles |
| Bug and perf diagnosis | QuiviT has archive I/O, image loading, Windows shell calls, and UI rendering. Guessing here gets expensive fast. | Matt [`diagnosing-bugs`](https://github.com/mattpocock/skills/tree/main/skills/diagnosing-bugs); pstack `fix-root-causes`, `prove-it-works` |
| Session handoff quality | The user works across agents and harnesses. Handoffs need to be concise for the user but detailed enough for the next agent to continue without transcript spelunking. | Local `session-handoff` plus existing `session-recovery` |
| Instrumented diagnosis | The next phase needs Rust and JS timing data, call counts, Python-driven benchmark collection, and cargo runtime tests. | Local `diagnose`, Matt [`diagnosing-bugs`](https://github.com/mattpocock/skills/tree/main/skills/diagnosing-bugs), pstack `prove-it-works` principles |

## Recommended adoption tiers

### Tier 1: adopt soon

These fit QuiviT directly.

| Skill | Source | Use in QuiviT | Notes |
| --- | --- | --- | --- |
| [`create-verification-skill`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Create a QuiviT-specific verification skill that exercises the app as a user. | Highest payoff. Aim it at loading folders, CBZ/CBR/7z archives, navigation, fullscreen, options, metadata, theme, file panel, and edge fixtures. |
| [`maintain-verification-skill`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Keep that verification map current after UI or archive behavior changes. | Useful because fixtures and supported formats will keep evolving. |
| [`interrogate`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Run adversarial review before considering this branch done or before future broad refactors. | Adapt model-routing details to Codex. Keep the synthesized verdict format. |
| [`code-review`](https://github.com/mattpocock/skills/tree/main/skills/code-review) | Matt | Review a diff against repo standards and the originating spec. | Especially good with `.agents/AGENTS.md` as the standards source. |
| [`codebase-design`](https://github.com/mattpocock/skills/tree/main/skills/codebase-design) | Matt | Give agents a shared vocabulary for deeper modules and testable seams. | This maps cleanly onto the repo's one-owner, pure-module, and Rust encapsulation rules. |
| [`diagnosing-bugs`](https://github.com/mattpocock/skills/tree/main/skills/diagnosing-bugs) | Matt | Use for broken, failing, slow, or flaky behavior. | Pairs well with Tauri, archive, Windows shell, and viewer defects. |

### Tier 2: adopt with light adaptation

These are useful, but they need local guardrails or a narrower trigger.

| Skill | Source | Use in QuiviT | Adaptation |
| --- | --- | --- | --- |
| [`architect`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Use before changes that cross JS service/UI boundaries, IPC contracts, archive modules, or config/window lifecycle. | Remove Cursor-specific model defaults. Keep the ground, sketch, implement, scrap phases. |
| [`how`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Ask for subsystem walkthroughs before editing. | Good replacement for stale project-structure notes. Must read current files first. |
| [`technical-writing`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Use for README, reports, PR notes, and commit-message drafts. | Keep QuiviT [`unslop`](https://github.com/cursor/plugins/tree/main/pstack) as the final prose pass. |
| [`no-comments`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Review comments before finalizing code. | Rename or soften locally if desired. The useful rule is: comments must earn their place. |
| [`show-me-your-work`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Keep a decision log for long autonomous work or large migrations. | Store logs only when the task needs an audit trail. Do not add routine noise. |
| [`blast-radius`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Audit risky shared behavior before editing or shipping. | Defer until a separate QuiviT-specific audit pass. |
| [`grill-with-docs`](https://github.com/mattpocock/skills/tree/main/skills/grill-with-docs) | Matt | Interview through major design choices while building glossary and ADRs. | Use for new subsystems or unresolved architecture choices, not every small change. |
| [`domain-modeling`](https://github.com/mattpocock/skills/tree/main/skills/domain-modeling) | Matt | Build a compact QuiviT vocabulary for agents. | Consider `CONTEXT.md` or `.agents/domain.md` for terms like image entry, archive entry, virtual directory, viewer slot, metadata badge, portable config. |
| [`to-spec`](https://github.com/mattpocock/skills/tree/main/skills/to-spec) | Matt | Turn an agreed conversation into a local spec. | Use local Markdown by default unless you connect GitHub or another issue tracker. |
| [`to-tickets`](https://github.com/mattpocock/skills/tree/main/skills/to-tickets) | Matt | Split a plan into small agent-ready tickets with dependencies. | Good for the next post-decoupling phase. |
| [`prototype`](https://github.com/mattpocock/skills/tree/main/skills/prototype) | Matt | Try UI or state-model ideas cheaply before touching production code. | Especially useful for options UI, file panel behavior, and viewer controls. |
| [`tdd`](https://github.com/mattpocock/skills/tree/main/skills/tdd) | Matt | Use when a cheap test seam exists. | Better default than pstack [`tdd`](https://github.com/mattpocock/skills/tree/main/skills/tdd) for this repo because it is model-invoked and broader. Still skip when the only honest test is full UI verification. |
| [`improve-codebase-architecture`](https://github.com/mattpocock/skills/tree/main/skills/improve-codebase-architecture) | Matt | Periodically scan hot paths for deepening opportunities. | The shipped skill writes an HTML report. Adapt output to repo Markdown when you want a committed artifact. |
| [`wayfinder`](https://github.com/mattpocock/skills/tree/main/skills/wayfinder) | Matt | Plan very large work as decision tickets. | Useful only if the next effort is bigger than one session can hold. |

### Tier 3: situational

These are good tools, but not daily QuiviT workflow skills.

| Skill | Source | When it helps |
| --- | --- | --- |
| [`arena`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Competing designs for a tricky interface, state model, or UI behavior. |
| [`swarm`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Parallel coverage across many independent files or fixtures. |
| [`figure-it-out`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | A large migration where no bundled playbook fits. |
| [`why`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Decision archaeology when commit history, docs, and issues are available. Use current source and repo history first. |
| [`teach`](https://github.com/cursor/plugins/tree/main/pstack) | pstack or Matt | Explaining a subsystem to you, especially after a large refactor. |
| [`grill-me`](https://github.com/mattpocock/skills/tree/main/skills/grill-me) and [`grilling`](https://github.com/mattpocock/skills/tree/main/skills/grilling) | Matt | Clarifying a fuzzy design before turning it into a spec. |
| [`to-questionnaire`](https://github.com/mattpocock/skills/tree/main/skills/to-questionnaire) | Matt | Sending an async decision to a human who owns product taste or external constraints. |
| [`handoff`](https://github.com/mattpocock/skills/tree/main/skills/handoff) | Matt | Creating a clean handoff document for another agent. Covered locally by `session-handoff` plus `session-recovery`. |
| [`research`](https://github.com/mattpocock/skills/tree/main/skills/research) | Matt | Looking up external docs or APIs, with citations, when a task depends on current facts. |
| [`resolving-merge-conflicts`](https://github.com/mattpocock/skills/tree/main/skills/resolving-merge-conflicts) | Matt | Only during an active merge or rebase conflict. |
| [`wizard`](https://github.com/mattpocock/skills/tree/main/skills/wizard) | Matt | Human-only setup, secrets, dashboards, or release chores. |
| [`bro`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Plain-language restatement when an agent answer gets too dense. |

### Tier 4: skip for now

These do not fit the current repo or duplicate something better.

| Skill | Source | Reason |
| --- | --- | --- |
| [`poteto-mode`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Valuable ideas, but the shipped mode assumes Cursor-specific tools, model routing, external writes, and autonomy rules that should not override QuiviT's local rules. Adapt principles instead. |
| [`setup-pstack`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Cursor model configuration, not needed in Codex as a project skill. |
| [`recall`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Overlaps `session-recovery` and is riskier because old sessions are stale here. Keep the stricter QuiviT gate. |
| [`automate-me`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Interesting later, but you already hand-authored better local workflow skills. |
| [`reflect`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | Skip for now. It adds skill-maintenance process the project does not want right now. |
| [`typescript-best-practices`](https://github.com/cursor/plugins/tree/main/pstack) | pstack | No TypeScript in the current app. |
| [`setup-matt-pocock-skills`](https://github.com/mattpocock/skills/tree/main/skills/setup-matt-pocock-skills) | Matt | Useful only if you choose to install that whole system. For QuiviT, cherry-pick. |
| [`ask-matt`](https://github.com/mattpocock/skills/tree/main/skills/ask-matt) | Matt | Router skill. Less useful once this audit picks the shortlist. |
| [`triage`](https://github.com/mattpocock/skills/tree/main/skills/triage) | Matt | Needs an issue tracker workflow. Use later if GitHub Issues or another tracker becomes central. |
| [`implement`](https://github.com/mattpocock/skills/tree/main/skills/implement) | Matt | Mostly wraps spec-to-code execution. Codex already does this well; use after adopting [`to-spec`](https://github.com/mattpocock/skills/tree/main/skills/to-spec) and [`to-tickets`](https://github.com/mattpocock/skills/tree/main/skills/to-tickets). |
| [`git-guardrails-claude-code`](https://github.com/mattpocock/skills/tree/main/skills/git-guardrails-claude-code) | Matt | Claude Code hook setup, not Codex project workflow. |
| [`setup-pre-commit`](https://github.com/mattpocock/skills/tree/main/skills/setup-pre-commit) | Matt | Could be useful later, but QuiviT lacks the npm scripts this expects. |
| [`setup-ts-deep-modules`](https://github.com/mattpocock/skills/tree/main/skills/setup-ts-deep-modules) | Matt | TypeScript package discipline, not this repo. |
| [`migrate-to-shoehorn`](https://github.com/mattpocock/skills/tree/main/skills/migrate-to-shoehorn) | Matt | Total TypeScript test helper migration. Not relevant. |
| [`scaffold-exercises`](https://github.com/mattpocock/skills/tree/main/skills/scaffold-exercises) | Matt | Course exercise scaffolding. Not relevant. |
| [`claude-handoff`](https://github.com/mattpocock/skills/tree/main/skills/claude-handoff) | Matt | Claude-specific. |
| [`loop-me`](https://github.com/mattpocock/skills/tree/main/skills/loop-me) | Matt | In-progress workflow authoring. Not needed now. |
| [`writing-fragments`](https://github.com/mattpocock/skills/tree/main/skills/writing-fragments), [`writing-shape`](https://github.com/mattpocock/skills/tree/main/skills/writing-shape), [`writing-beats`](https://github.com/mattpocock/skills/tree/main/skills/writing-beats) | Matt | Article-writing experiments. Keep [`unslop`](https://github.com/cursor/plugins/tree/main/pstack) instead. |
| [`wait-what`](https://github.com/mattpocock/skills/tree/main/skills/wait-what) | Matt | Useful conversationally, but not worth installing as a project skill unless communication repair becomes a pattern. |

## pstack principle fit

The pstack principle skills are the most reusable part of that repo. I would not install all twenty-one as separate always-available skills. They are better folded into QuiviT rules or a focused `quivit-mode` skill.

High fit:

- [`principle-prove-it-works`](https://github.com/cursor/plugins/tree/main/pstack): make verification evidence part of every final answer.
- [`principle-fix-root-causes`](https://github.com/cursor/plugins/tree/main/pstack): especially for archive, protocol, Windows shell, and rendering bugs.
- [`principle-sequence-verifiable-units`](https://github.com/cursor/plugins/tree/main/pstack): matches the branch's slice-based refactoring history.
- [`principle-minimize-reader-load`](https://github.com/cursor/plugins/tree/main/pstack): reinforces the current push toward clear ownership and smaller mental hops.
- [`principle-model-the-domain`](https://github.com/cursor/plugins/tree/main/pstack): useful for viewer state, archive entries, directory traversal, and actions.
- [`principle-boundary-discipline`](https://github.com/cursor/plugins/tree/main/pstack): maps to IPC, config parsing, file system, registry, archive decoding, and protocol URLs.
- [`principle-type-system-discipline`](https://github.com/cursor/plugins/tree/main/pstack): strong fit for Rust models and command payloads. Less direct for plain JS, but still useful through structured registries.
- [`principle-migrate-callers-then-delete-legacy-apis`](https://github.com/cursor/plugins/tree/main/pstack): matches completed decoupling work and future cleanup.
- [`principle-separate-before-serializing-shared-state`](https://github.com/cursor/plugins/tree/main/pstack): useful for cross-window config, previews, and localStorage handoff.
- [`principle-build-the-lever`](https://github.com/cursor/plugins/tree/main/pstack): useful when repeated edits need a script, checker, or skill instead of hand edits.
- [`principle-encode-lessons-in-structure`](https://github.com/cursor/plugins/tree/main/pstack): fits your recent skill improvements. Good rules should become skills, tests, or scripts.

Lower fit:

- [`principle-never-block-on-the-human`](https://github.com/cursor/plugins/tree/main/pstack): good for reversible work, but QuiviT should keep its stricter local approval boundaries.
- [`principle-guard-the-context-window`](https://github.com/cursor/plugins/tree/main/pstack): useful, but current Codex instructions already limit subagents unless explicitly requested or skill-driven.
- [`principle-exhaust-the-design-space`](https://github.com/cursor/plugins/tree/main/pstack): good for novel UI and architecture choices, too heavy for routine fixes.
- [`principle-make-operations-idempotent`](https://github.com/cursor/plugins/tree/main/pstack): valuable for commands and migrations, less relevant to everyday UI edits.
- [`principle-experience-first`](https://github.com/cursor/plugins/tree/main/pstack): good product sense, but QuiviT already has concrete UI standards that should be more specific.
- [`principle-redesign-from-first-principles`](https://github.com/cursor/plugins/tree/main/pstack), [`principle-foundational-thinking`](https://github.com/cursor/plugins/tree/main/pstack), [`principle-subtract-before-you-add`](https://github.com/cursor/plugins/tree/main/pstack), [`principle-laziness-protocol`](https://github.com/cursor/plugins/tree/main/pstack), [`principle-outcome-oriented-execution`](https://github.com/cursor/plugins/tree/main/pstack): all fit, but they overlap heavily with existing AGENTS guidance. Fold the wording only where it adds a sharper trigger.

## Recommended local skill set

If you want the next workflow step to be clean, create or import these as QuiviT-local skills:

| Local skill | Based on | Trigger |
| --- | --- | --- |
| `validate-changes` | pstack [`interrogate`](https://github.com/cursor/plugins/tree/main/pstack) plus Matt [`code-review`](https://github.com/mattpocock/skills/tree/main/skills/code-review) | Strict AGENTS.md checks over commit ranges, branches, diffs, or the working tree. |
| `update-architecture-state` | Matt architecture skills, adapted locally | Explicit updates to `.agents/architecture-state.md` and the README documentation architecture section. |
| `update-readme-features` | Matt technical writing, adapted locally | Explicit updates to the top user-facing README feature sections. |
| `session-handoff` | Matt [`handoff`](https://github.com/mattpocock/skills/tree/main/skills/handoff), adapted to QuiviT | Explicit handoff entries in `.agents/session-index.md` and a one-sentence next-agent prompt. |
| `diagnose` | Matt [`diagnosing-bugs`](https://github.com/mattpocock/skills/tree/main/skills/diagnosing-bugs) plus pstack `fix-root-causes` | Bugs, perf regressions, flaky behavior, or confusing runtime symptoms. |

This keeps the number of new skills small and puts names around the work QuiviT actually does.

## Suggested rollout

1. Add `validate-changes`, the two documentation update skills, `session-handoff`, and `diagnose`.
2. Keep `session-recovery` focused on recovery and provenance. Store the index at `.agents/session-index.md`.
3. Leave `spec-to-slices`, skill-maintenance, skill-creation, and generic agent-writing skills out for now.
4. Revisit [`blast-radius`](https://github.com/cursor/plugins/tree/main/pstack) last, after a dedicated QuiviT-specific audit.

## Appendix: pstack audit

| Skill | Verdict | QuiviT note |
| --- | --- | --- |
| [`architect`](https://github.com/cursor/plugins/tree/main/pstack) | Adopt with adaptation | Strong for cross-boundary design. Remove Cursor model assumptions. |
| [`arena`](https://github.com/cursor/plugins/tree/main/pstack) | Situational | Use for competing designs, not routine work. |
| [`automate-me`](https://github.com/cursor/plugins/tree/main/pstack) | Skip for now | You already have hand-tuned local skills. |
| [`blast-radius`](https://github.com/cursor/plugins/tree/main/pstack) | Defer | Excellent fit for small changes in shared behavior, but needs a separate QuiviT-specific audit before adoption. |
| [`bro`](https://github.com/cursor/plugins/tree/main/pstack) | Situational | Nice communication fallback, low workflow priority. |
| [`create-verification-skill`](https://github.com/cursor/plugins/tree/main/pstack) | Adopt soon | Best missing workflow piece. |
| [`figure-it-out`](https://github.com/cursor/plugins/tree/main/pstack) | Situational | Good for migrations too odd for normal playbooks. |
| [`how`](https://github.com/cursor/plugins/tree/main/pstack) | Adopt with adaptation | Current-source walkthroughs before edits. |
| [`interrogate`](https://github.com/cursor/plugins/tree/main/pstack) | Adopt soon | Strong final-review tool for this branch. |
| [`maintain-verification-skill`](https://github.com/cursor/plugins/tree/main/pstack) | Adopt soon | Keeps verification honest after app drift. |
| [`no-comments`](https://github.com/cursor/plugins/tree/main/pstack) | Adopt with adaptation | Aligns with minimal-comment repo rules. |
| [`poteto-mode`](https://github.com/cursor/plugins/tree/main/pstack) | Skip as-is | Mine it for principles. Do not let it override local rules. |
| [`principle-boundary-discipline`](https://github.com/cursor/plugins/tree/main/pstack) | Fold into local rules | Strong fit for IPC, config, protocol, archive, shell. |
| [`principle-build-the-lever`](https://github.com/cursor/plugins/tree/main/pstack) | Fold into local rules | Use scripts or skills for repeated checks and migrations. |
| [`principle-encode-lessons-in-structure`](https://github.com/cursor/plugins/tree/main/pstack) | Fold into local rules | Directly supports your skill-based workflow improvements. |
| [`principle-exhaust-the-design-space`](https://github.com/cursor/plugins/tree/main/pstack) | Situational | Use for novel UI or architecture choices. |
| [`principle-experience-first`](https://github.com/cursor/plugins/tree/main/pstack) | Fold lightly | Useful, but QuiviT needs concrete UI standards. |
| [`principle-fix-root-causes`](https://github.com/cursor/plugins/tree/main/pstack) | Fold into local rules | High value for bugs and perf work. |
| [`principle-foundational-thinking`](https://github.com/cursor/plugins/tree/main/pstack) | Fold lightly | Already partly covered by current architecture rules. |
| [`principle-guard-the-context-window`](https://github.com/cursor/plugins/tree/main/pstack) | Fold lightly | Useful, but subagent policy comes from the harness and local skills. |
| [`principle-laziness-protocol`](https://github.com/cursor/plugins/tree/main/pstack) | Fold lightly | Already matches YAGNI and small-change rules. |
| [`principle-make-operations-idempotent`](https://github.com/cursor/plugins/tree/main/pstack) | Situational | Use for commands, config promotion, and repeated file operations. |
| [`principle-migrate-callers-then-delete-legacy-apis`](https://github.com/cursor/plugins/tree/main/pstack) | Fold into local rules | Great fit for decoupling cleanup. |
| [`principle-minimize-reader-load`](https://github.com/cursor/plugins/tree/main/pstack) | Fold into local rules | Strong fit for pure modules and ownership. |
| [`principle-model-the-domain`](https://github.com/cursor/plugins/tree/main/pstack) | Fold into local rules | Useful for viewer/archive/config state. |
| [`principle-never-block-on-the-human`](https://github.com/cursor/plugins/tree/main/pstack) | Fold carefully | Keep approval boundaries stricter than pstack's default. |
| [`principle-outcome-oriented-execution`](https://github.com/cursor/plugins/tree/main/pstack) | Fold lightly | Good for planned migrations. |
| [`principle-prove-it-works`](https://github.com/cursor/plugins/tree/main/pstack) | Fold into local rules | Should be a default final-answer standard. |
| [`principle-redesign-from-first-principles`](https://github.com/cursor/plugins/tree/main/pstack) | Situational | Use when new requirements fight old structure. |
| [`principle-separate-before-serializing-shared-state`](https://github.com/cursor/plugins/tree/main/pstack) | Fold into local rules | Strong for cross-window and shared-state work. |
| [`principle-sequence-verifiable-units`](https://github.com/cursor/plugins/tree/main/pstack) | Fold into local rules | Strong for future slices and stacked work. |
| [`principle-subtract-before-you-add`](https://github.com/cursor/plugins/tree/main/pstack) | Fold lightly | Already matches repo cleanup instincts. |
| [`principle-type-system-discipline`](https://github.com/cursor/plugins/tree/main/pstack) | Fold into local rules | Strong for Rust and structured JS registries. |
| [`recall`](https://github.com/cursor/plugins/tree/main/pstack) | Skip | Use stricter `session-recovery` instead. |
| [`reflect`](https://github.com/cursor/plugins/tree/main/pstack) | Skip for now | Adds a skill-maintenance loop the project does not want right now. |
| [`setup-pstack`](https://github.com/cursor/plugins/tree/main/pstack) | Skip | Cursor model config. |
| [`show-me-your-work`](https://github.com/cursor/plugins/tree/main/pstack) | Adopt with adaptation | Useful for unattended or high-stakes work. |
| [`swarm`](https://github.com/cursor/plugins/tree/main/pstack) | Situational | Good for wide audits. Too heavy by default. |
| [`tdd`](https://github.com/mattpocock/skills/tree/main/skills/tdd) | Situational | Prefer Matt [`tdd`](https://github.com/mattpocock/skills/tree/main/skills/tdd) unless pstack is already the active mode. |
| [`teach`](https://github.com/cursor/plugins/tree/main/pstack) | Situational | Good for understanding subsystems. |
| [`technical-writing`](https://github.com/cursor/plugins/tree/main/pstack) | Adopt with adaptation | Pair with [`unslop`](https://github.com/cursor/plugins/tree/main/pstack). |
| [`typescript-best-practices`](https://github.com/cursor/plugins/tree/main/pstack) | Skip | No TypeScript. |
| [`unslop`](https://github.com/cursor/plugins/tree/main/pstack) | Already covered | QuiviT's local [`unslop`](https://github.com/cursor/plugins/tree/main/pstack) is enough. |
| [`why`](https://github.com/cursor/plugins/tree/main/pstack) | Situational | Use for current-source and git archaeology. Avoid stale sessions unless gated. |

## Appendix: Matt Pocock skills audit

| Skill | Verdict | QuiviT note |
| --- | --- | --- |
| [`ask-matt`](https://github.com/mattpocock/skills/tree/main/skills/ask-matt) | Skip | Router is less useful after this audit. |
| [`claude-handoff`](https://github.com/mattpocock/skills/tree/main/skills/claude-handoff) | Skip | Claude-specific. |
| [`code-review`](https://github.com/mattpocock/skills/tree/main/skills/code-review) | Adopt soon | Strong branch and PR review shape. |
| [`codebase-design`](https://github.com/mattpocock/skills/tree/main/skills/codebase-design) | Adopt soon | Excellent fit for deep modules, locality, and test surfaces. |
| [`diagnosing-bugs`](https://github.com/mattpocock/skills/tree/main/skills/diagnosing-bugs) | Adopt soon | Good disciplined loop for QuiviT defects and slowness. |
| [`domain-modeling`](https://github.com/mattpocock/skills/tree/main/skills/domain-modeling) | Adopt with adaptation | Build a compact QuiviT glossary and ADR habit. |
| [`git-guardrails-claude-code`](https://github.com/mattpocock/skills/tree/main/skills/git-guardrails-claude-code) | Skip | Claude Code hook setup. |
| [`grill-me`](https://github.com/mattpocock/skills/tree/main/skills/grill-me) | Situational | Good for fuzzy plans. |
| [`grill-with-docs`](https://github.com/mattpocock/skills/tree/main/skills/grill-with-docs) | Adopt with adaptation | Use for major design choices where docs should change. |
| [`grilling`](https://github.com/mattpocock/skills/tree/main/skills/grilling) | Situational | Useful interview primitive behind other skills. |
| [`handoff`](https://github.com/mattpocock/skills/tree/main/skills/handoff) | Situational | Complements but does not replace `session-recovery`. |
| [`implement`](https://github.com/mattpocock/skills/tree/main/skills/implement) | Situational | Use only once specs or tickets become standard. |
| [`improve-codebase-architecture`](https://github.com/mattpocock/skills/tree/main/skills/improve-codebase-architecture) | Adopt with adaptation | Great periodic scan. Output should be Markdown when committed. |
| [`loop-me`](https://github.com/mattpocock/skills/tree/main/skills/loop-me) | Skip | In-progress and not needed. |
| [`migrate-to-shoehorn`](https://github.com/mattpocock/skills/tree/main/skills/migrate-to-shoehorn) | Skip | Not relevant. |
| [`prototype`](https://github.com/mattpocock/skills/tree/main/skills/prototype) | Adopt with adaptation | Useful for UI, state, and behavior experiments. |
| [`research`](https://github.com/mattpocock/skills/tree/main/skills/research) | Situational | Good for current external docs and API facts. |
| [`resolving-merge-conflicts`](https://github.com/mattpocock/skills/tree/main/skills/resolving-merge-conflicts) | Situational | Use only during conflicts. |
| [`scaffold-exercises`](https://github.com/mattpocock/skills/tree/main/skills/scaffold-exercises) | Skip | Course material scaffolding. |
| [`setup-matt-pocock-skills`](https://github.com/mattpocock/skills/tree/main/skills/setup-matt-pocock-skills) | Skip | Whole-system setup, but cherry-picking is better here. |
| [`setup-pre-commit`](https://github.com/mattpocock/skills/tree/main/skills/setup-pre-commit) | Skip for now | Repo lacks the npm scripts this expects. Revisit if tooling grows. |
| [`setup-ts-deep-modules`](https://github.com/mattpocock/skills/tree/main/skills/setup-ts-deep-modules) | Skip | TypeScript package setup. |
| [`tdd`](https://github.com/mattpocock/skills/tree/main/skills/tdd) | Adopt with adaptation | Use when there is a cheap honest test seam. |
| [`teach`](https://github.com/cursor/plugins/tree/main/pstack) | Situational | Good when you want to learn a subsystem. |
| [`to-questionnaire`](https://github.com/mattpocock/skills/tree/main/skills/to-questionnaire) | Situational | Useful for async product or design decisions. |
| [`to-spec`](https://github.com/mattpocock/skills/tree/main/skills/to-spec) | Adopt with adaptation | Good for turning conversations into local specs. |
| [`to-tickets`](https://github.com/mattpocock/skills/tree/main/skills/to-tickets) | Adopt with adaptation | Good for slicing larger efforts. |
| [`triage`](https://github.com/mattpocock/skills/tree/main/skills/triage) | Skip for now | Needs issue tracker workflow. |
| [`wait-what`](https://github.com/mattpocock/skills/tree/main/skills/wait-what) | Skip | Low project-level value. |
| [`wayfinder`](https://github.com/mattpocock/skills/tree/main/skills/wayfinder) | Adopt later | Useful for the next very large initiative. |
| [`wizard`](https://github.com/mattpocock/skills/tree/main/skills/wizard) | Situational | Useful for human-only setup flows. |
| [`writing-beats`](https://github.com/mattpocock/skills/tree/main/skills/writing-beats) | Skip | Article-writing workflow. |
| [`writing-for-agents`](https://github.com/mattpocock/skills/tree/main/skills/writing-for-agents) | Skip for now | Useful, but the project is avoiding extra skill-maintenance and skill-creation process right now. |
| [`writing-fragments`](https://github.com/mattpocock/skills/tree/main/skills/writing-fragments) | Skip | Article-writing workflow. |
| [`writing-shape`](https://github.com/mattpocock/skills/tree/main/skills/writing-shape) | Skip | Article-writing workflow. |
