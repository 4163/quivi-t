---
name: replay-debugging
description: "Run automated hypothesis-driven replay diagnostics, isolate visual flicker or IPC anomalies, and deliver detailed root-cause telemetry reports."
argument-hint: "<scenario name, issue description, or target module>"
---

# Replay debugging

Isolate frontend rendering glitches, blank frame blackouts, state desynchronization, and IPC latency using recorded action replays and in-browser telemetry probes without modifying production files.

## Core rules

1. Zero guesswork. Formulate an explicit, falsifiable hypothesis before investigating.
2. Probe before concluding. Run the replay diagnostics harness to capture real frame and event timelines.
3. Start clean and iterate. Always start each new investigation with a fresh copy of `base.js`. Clear any leftover `investigation.js` from previous runs so old probes do not contaminate the new diagnosis.
4. Flag non-specified issues. While isolating the reported problem, check the report for unexpected anomalies, unhandled rejections, and jank frames.
5. Strictly diagnostics first. Never modify production frontend or backend files (`src/` or `src-tauri/`) during a replay debugging session. Do not draft code patches or speculative solutions. Focus strictly on isolating and documenting the race condition, lifecycle flaw, or timing mismatch. Modifying the runner, `base.js`, or other files within the record and replay debugging system is allowed when a new useful baseline, general improvement, or tooling fix presents itself.
6. Deliver telemetry and stop. Report the isolated root cause with frame-accurate timeline evidence. Stop and await user review. The user will review the findings, lead discussion, and approve planning before any implementation begins.

## Investigation lifecycle

### 1. Ingest scenario and run baseline replay

When the user provides a scenario and reports an issue:

```bash
npm run diagnose -- <scenario>
```

Add `--verbose` to print the complete event timeline for every step. Add `--pause <ms>` to accelerate or decelerate the dispatch cadence.

If an existing report already exists, inspect the latest metrics without launching the webview:

```bash
npm run diagnose -- --inspect [scenario]
```

### 2. Analyze the anomaly report

Open `e2e/replay-diagnostics/reports/<scenario>-report.json`. Locate the earliest step reporting anomalies or blackout frames around the user's reported symptom.

Key telemetry signatures:

- **Blackout frame**: Both `activeImg` and `bridgeImg` have zero opacity or incomplete load states while the statusbar displays a valid image filename. Indicates image pool retirement raced ahead of texture or DOM paint.
- **Protocol fetch failure or status error**: Custom protocol route `quivit://` returned HTTP 4xx/5xx or timed out. Points to archive extraction bottlenecks, corrupted archive caches, or invalid path encoding.
- **IPC rejection**: Tauri command threw an unhandled error across the serialization boundary.
- **Uncaught error or unhandled rejection**: JavaScript runtime exceptions triggered during action dispatch or state notification fans.
- **Jank frame**: Inter-frame duration exceeded 50ms. Points to synchronous main-thread parsing, large image decode spikes, or unvirtualized layout thrashing.

Check for both the user's specified problem and any unrelated anomalies flagged in the report.

### 3. Formulate the hypothesis

State the suspected root cause explicitly before probing:

- Which component owns the failing state?
- What asynchronous boundary causes the race?
- Why did the existing synchronization mechanism fail to protect the frame?

Example hypothesis:
> When CRT filter is active, `#viewport[data-filter]` forces active and bridge images to opacity zero. During image transitions, WebGL texture preparation in `glRuntime.js` takes more than two animation frames to load and create an ImageBitmap. The retiring bridge image disappears before the WebGL canvas completes its draw, causing a single blank frame.

### 4. Self-diagnostic investigation loop

Isolate scenario-specific probes in an investigation copy rather than editing `base.js`. Modifying `base.js`, the runner, or other files in the record and replay debugging system is allowed when a new useful baseline, general improvement, or tooling fix presents itself.

1. **Initialize a fresh investigation copy**:
   Clear any leftover investigation file from prior runs to guarantee a clean slate:
   ```bash
   npm run diagnose -- --clean
   npm run diagnose -- <scenario> --investigate
   ```
   This creates a fresh `e2e/replay-diagnostics/investigation.js` from `base.js`. Starting clean prevents stale probes from earlier investigations from distorting new telemetry. The runner automatically loads `investigation.js` whenever it exists.

2. **Inject tighter assertion probes**:
   Edit `e2e/replay-diagnostics/investigation.js` to add granular checks around the suspected code path:
   - Capture microtask queues or promise resolution order.
   - Assert element opacity, class transitions, and canvas readiness at specific millisecond offsets.
   - Wrap internal service methods to log arguments and execution order.

3. **Execute the replay iteration**:
   ```bash
   npm run diagnose -- <scenario>
   ```

4. **Narrow and repeat**:
   Inspect the new report. If the hypothesis is refuted or ambiguous, adjust the probes in `investigation.js` and re-run. Repeat until the probe catches the exact microtask or frame boundary where the race occurs.

### 5. Deliver diagnostic report

Once the diagnostic loop isolates the issue, do not edit production files and do not draft code solutions. Stop and report the diagnosis to the user using this format:

```markdown
### Diagnostic Report: [Scenario Name]

#### 1. Primary Root Cause
- **Failing Component**: `file:line` reference
- **Mechanism**: Description of the race condition, timing boundary, or state inconsistency
- **Why Existing Logic Failed**: Specific reason the current safeguard or lifecycle did not protect the frame

#### 2. Timeline Evidence
- **Step**: Step index and action ID
- **Timestamp**: Exact relative offset in milliseconds
- **Captured Telemetry**: State diff, element classes, canvas readiness, or frame blackout details

#### 3. Non-Specified Anomalies Flagged
- List any other unexpected errors, jank frames (>50ms), or protocol delays caught during the run that were not part of the initial issue description. If none, state: "None. All other steps executed within frame budgets."

#### 4. Architectural Boundaries and Discussion Points
- Note the module ownership and lifecycle boundaries involved.
- List architectural constraints from [.agents/AGENTS.md](../AGENTS.md) that apply to this surface.
- Highlight trade-offs or open questions for user discussion.
```

Do not generate speculative diffs or code solutions in this report. Stop here and wait for the user to review the diagnostic findings.

### 6. Planning and discussion

Do not modify production code under `src/` or `src-tauri/` during this workflow. The user will review the diagnostic report, lead discussion on the findings, and approve any subsequent planning.

When moving to implementation after user approval, refer directly to [.agents/AGENTS.md](../AGENTS.md) for architectural rules, module ownership, HTML-first rendering, CSS source of truth, and performance standards rather than relying on paraphrased guidelines.

### 7. Clean up and verify

1. Once diagnostics conclude or when requested by the user, remove the temporary investigation workspace:
   ```bash
   npm run diagnose -- --clean
   ```
2. When changes are subsequently implemented and approved in a separate plan, re-run the scenario to confirm zero blackout frames and zero anomalies:
   ```bash
   npm run diagnose -- <scenario>
   ```
3. Run targeted tests as prescribed by [.agents/AGENTS.md](../AGENTS.md): `npm test` for frontend state and math, `cargo check --tests` and `cargo test <filter>` for backend contracts.
