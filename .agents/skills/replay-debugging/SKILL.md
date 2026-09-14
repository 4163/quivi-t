---
name: replay-debugging
description: "Run automated hypothesis-driven replay diagnostics, isolate visual flicker or IPC anomalies, and synthesize targeted pipeline fixes."
argument-hint: "<scenario name, issue description, or target module>"
---

# Replay Debugging

Isolate and fix frontend rendering glitches, blank frame blackouts, state desynchronization, and IPC latency using recorded action replays and in-browser telemetry probes.

## Core Rules

1. Zero guesswork. Formulate an explicit, falsifiable hypothesis before touching production code.
2. Probe before patching. Run the replay diagnostics harness to capture real frame and event timelines.
3. Copy-and-iterate. Always copy `base.js` to `investigation.js` to add targeted hypothesis probes. Keep `base.js` clean as the baseline template.
4. Flag non-specified issues. While isolating the user's reported problem, always check the report for unexpected anomalies, unhandled rejections, or jank frames.
5. Surgical remediation. Fix the specific lifecycle or race condition without altering surrounding architecture or widening API surfaces.
6. Verify non-regression. Confirm the diagnostic report registers zero blackout frames and zero anomalies after the fix, then clean up the investigation file.

## Investigation Lifecycle

### 1. Ingest Scenario and Run Baseline Replay

When the user provides a scenario and reports an issue:

```bash
npm run diagnose -- <scenario>
```

Add `--verbose` to print the complete event timeline for every step. Add `--pause <ms>` to accelerate or decelerate the dispatch cadence.

If an existing report already exists, inspect the latest metrics without launching the webview:

```bash
npm run diagnose -- --inspect [scenario]
```

### 2. Analyze the Anomaly Report

Open `e2e/replay-diagnostics/reports/<scenario>-report.json`. Locate the earliest step reporting anomalies or blackout frames around the user's reported symptom.

Key telemetry signatures:

- **Blackout frame**: Both `activeImg` and `bridgeImg` have zero opacity or incomplete load states while the statusbar displays a valid image filename. Indicates image pool retirement raced ahead of texture or DOM paint.
- **Protocol fetch failure or status error**: Custom protocol route `quivit://` returned HTTP 4xx/5xx or timed out. Points to archive extraction bottlenecks, corrupted archive caches, or invalid path encoding.
- **IPC rejection**: Tauri command threw an unhandled error across the serialization boundary.
- **Uncaught error or unhandled rejection**: JavaScript runtime exceptions triggered during action dispatch or state notification fans.
- **Jank frame**: Inter-frame duration exceeded 50ms. Points to synchronous main-thread parsing, large image decode spikes, or unvirtualized layout thrashing.

Check for both the user's specified problem and any unrelated anomalies flagged in the report.

### 3. Formulate the Hypothesis

State the root cause explicitly before editing:

- Which component owns the failing state?
- What asynchronous boundary causes the race?
- Why did the existing synchronization mechanism fail to protect the frame?

Example hypothesis:
> When CRT filter is active, `#viewport[data-filter]` forces active and bridge images to opacity zero. During image transitions, WebGL texture preparation in `glRuntime.js` takes more than two animation frames to load and create an ImageBitmap. The retiring bridge image disappears before the WebGL canvas completes its draw, causing a single blank frame.

### 4. Self-Diagnostic Investigation Loop

Do not edit `base.js` directly. Use an investigation copy to isolate the issue:

1. **Create the investigation copy**:
   ```bash
   npm run diagnose -- <scenario> --investigate
   ```
   This generates `e2e/replay-diagnostics/investigation.js` from `base.js`. The runner automatically loads `investigation.js` whenever it exists.

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

### 5. Deliver Diagnostic Report

Once the diagnostic loop isolates the issue, do not edit production code immediately. Stop and report the full diagnosis to the user using this format:

```markdown
### Diagnostic Report: [Scenario Name]

#### 1. Primary Root Cause
- **Failing Component**: `file:line` reference
- **Mechanism**: Description of the race condition, timing boundary, or state inconsistency
- **Why Existing Logic Failed**: Specific reason the current safeguard or lifecycle did not protect the frame

#### 2. Timeline Evidence
- **Step**: Step index and action ID
- **Timestamp**: Exact relative offset in milliseconds
- **Captured Telemetry**: State diff, element classes, or frame blackout details

#### 3. Non-Specified Anomalies Flagged
- List any other unexpected errors, jank frames (>50ms), or protocol delays caught during the run that were not part of the initial issue description. If none, state: "None. All other steps executed within frame budgets."

#### 4. Proposed Surgical Remediation
- Minimal diff or proposed change to resolve the issue while preserving single-owner and CSS-source-of-truth invariants.
```

Wait for user review and approval before modifying production files.

### 6. Apply the Surgical Fix

Once approved, apply the minimal code change to production files under `src/js/` or `src-tauri/`. Maintain QuiviT architectural invariants:

- Keep CSS as the visual source of truth. Do not inject inline styles for visibility.
- Keep state machines pure with zero DOM imports.
- Maintain single-owner boundaries. UI modules subscribe to state changes rather than reaching into sibling components.
- Avoid dynamic allocations in hot paths.

### 7. Verify and Clean Up

1. Re-run `npm run diagnose -- <scenario>`. Verify total blackout frames equals zero and total anomalies equals zero.
2. Remove the investigation copy once verified:
   ```bash
   npm run diagnose -- --clean
   ```
3. Run `npm test` to ensure all frontend unit tests pass.
4. If Rust code was touched, run `cargo check --tests` and `cargo test <filter>` to verify backend contracts.
