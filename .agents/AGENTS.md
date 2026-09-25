# Guidelines

Coding standards, architecture rules, and agent workflow for QuiviT.

## Agent behavior
- Read every rule and referenced skill before starting work. Confirm adherence to the user.
- Keep responses concise and focused on the task.
- Follow existing code style and formatting for each directory and its associated files.
- Avoid using browser automation/browser subagent, use mocha when possible, or use e2e for any complex frontend problems that requires debugging.
- For writing work, read `.agents/skills/unslop/SKILL.md` and follow it even if the harness does not auto-load always-active skills. This applies to docs, prompts, comments, and user-facing copy.
- **Verify:** Run `.agents/skills/verify-implementation/SKILL.md` when finishing a slice or when asked to "verify".
- **Validate:** Run `.agents/skills/validate-changes/SKILL.md` when explicitly asked to "validate" code. Do not confuse "verify" (tests and docs) with "validate" (architecture review).

## Code guidelines
- **Self-documenting code.** Write code that reads clearly on its own. Use descriptive names and flat control flow (early returns over multi-layer nesting). Keep comments minimal and concise. Reserve them for *why*, non-obvious constraints, and maintained module invariants. A short local heading is fine when a file needs to explain an ownership, lifecycle, or persistence rule. Do not add commentary that merely narrates the code.
- **Performance first.** Avoid dynamic evaluations and allocations in hot paths. Cache aggressively.
  *Practical Examples for Agents:*
  1. **Hot Path Optimization:** Pre-parse config values into `O(1)` lookup structures (e.g. JS `Set` or `Map`) on configuration load instead of dynamically mapping strings inside `requestAnimationFrame`, `mousemove`, or `scroll` handlers.
  2. **Cached shell icons:** Native file icons are stored in `localStorage` under `icon:` so the file panel can paint them on the next open without another shell lookup.
  3. **Thread Concurrency:** Offload heavy CPU bound tasks (e.g., LZMA2/7Z extraction via `sevenz-rust`) strictly to non-blocking background threads (`tokio::spawn` or `std::thread`), leaving the primary Tauri IPC and JS UI threads exclusively for layout and rendering.
  4. **Aggressive I/O Caching:** Use header-only file reads and maintain in-memory LRU caches (`lru` crate) for fast virtual archive directory traversal.
  5. **DOM & Asset Virtualization:** Recycle a bounded row pool on scroll for list views. Shell formats use the 96x96 shell thumbnail. WebP, AVIF, SVG, and archive images have no pre-scaled cache, so thumbnail view decodes those one at a time in scroll order.
  6. **Explicit Named Cache Limits:** Define cache capacities, buffer limits, and memory thresholds as named constants at module scope, such as `THUMB_CACHE_CAPACITY` in `filePanel.js`. Size each cache from the max item count times the worst-case uncompressed byte size.
- **Measure twice, cut once.** Prefer small, deliberate changes over broad refactors. Before writing new logic, search the codebase for an existing helper that already does the job. Prefer intuitive shared helpers over inlining repeated lines of code for identical operations. If a change duplicates logic across callsites, extract it into a shared helper instead.
- **Work in logical slices.** Prioritize small, precise code changes rather than big blocks to prevent tooling and scope failures, especially during large refactors. Be surgical!
- **YAGNI.** Do not add abstractions, features, or complexity without a clear need.

### Guardrails
- **No automated git commits.** Never execute git commit commands or automate commits unless explicitly instructed. The user handles all commits manually or through the commit pipeline.
- **Blast radius.** When modifying core cross-cutting surfaces (IPC, configs, cross-window state, protocol URLs, or archives), stop and prove you haven't broken downstream consumers. Do not rely on speculation or writeups. Use the `.agents/skills/blast-radius/SKILL.md` workflow to execute actual checks and confirm safety.
- **Targeted testing via blast radius.** Do not run the full `cargo test` suite on minor or localized changes. Full suite runs incur high linker and archive extraction overhead (30+ seconds). Derive targeted test commands directly from the diff's blast radius (e.g., `npm test` for pure frontend math/state, `cargo test format_tests` or `cargo test <filter>` for backend). Use `cargo check --tests` during iteration to validate types and test signatures in 2 to 4 seconds. Reserve full suite runs for final slice verification.
- **Validate before presenting.** Every implementation plan, report, analysis, and roadmap must be compared against `.agents/skills/validate-changes/SKILL.md` rules before presenting it to the user. This applies to agent messages, artifacts, and any document written under `.agents/`. The message, artifact, or document must state at the top that this validation comparison was performed.
- **Agent-facing plans.** For any implementation plan written under `.agents/`, treat it as a continuation doc that a cold agent on a different harness can pick up from a dirty tree without a handoff. Use ordered checklists with file:line references, accept criteria per item, and `[x]`/`[ ]` state. Lock definitions and deviation rules at the top so the plan does not drift across sessions.
- **No test harness creation during implementation.** Do not create new test suites or test harnesses while implementation work is in progress. Manual runtime tests carry higher value because test harnesses written against incomplete code are fragile and waste implementation time. Edit existing tests only when a code change breaks them (blast radius). However, using cargo, e2e, or mocha to debug the implementation work that is currently being done is allowed.
- **No documentation editing during implementation.** Never edit architecture tracking or user-facing feature docs while code changes are in progress. Updating files governed by `.agents/skills/update-architecture-state/SKILL.md` or `.agents/skills/update-readme-features/SKILL.md` mid-implementation leads to speculative feature dumps and stale docs. Run those skills only when explicitly asked.
- **No premature finalization.** Never declare work done, implemented, or complete until the user explicitly says so. Do not write completion summaries or treat a slice as finished on your own.

## Architecture rules

Keep the codebase from drifting into mixed patterns. Apply these on every change. Order for UI work is structure, then presentation, then behavior.

### Shared
- **One owner per concern.** Each surface or responsibility has exactly one writer (a status readout, chrome visibility, a panel, an image pool, theme apply, an action id).
- **Folders are a byproduct of splitting.** A file moves into a feature folder only when a slice creates a sibling. No pure reorganization changes.
- **Pure modules first.** State machines and domain/services have zero DOM / UI imports. UI modules import them; never the reverse.
- **Communicate across files via state callbacks, not reach-in.** Module A updates shared state (or a dedicated owner API). Module B paints what it owns. A module may mutate its own DOM or view-local state (scroll, drag, hover) without going through the state machine.
- **Do not split a single owner** into sibling files that all touch the same surface. That relocates coupling without removing it.
- **Refactors do not change behavior** unless there is a practical function or UX/performance win.

### HTML-first rendering
- Prefer static markup over `createElement` / `innerHTML` for stable chrome (menus, rows, badges, probes, placeholders).
- Toggle visibility and state with CSS classes or tokens. Do not remove and re-insert nodes to hide them.
- When a node must be created at runtime, declare a placeholder or template in HTML first.
- Recycle existing nodes on update. Do not wipe a container and rebuild it when slots or a pool already exist.
- A dynamically sized pool is fine when the count depends on viewport or font size.
- Default update path: `textContent`, `src`, `classList`, `data-*`.

### CSS source of truth
- Shared tokens, resets, and cross-page rules live in `global.css`. Each HTML page has its own sheet for layout and components.
- Design tokens are CSS custom properties on `:root` in `global.css`. Page sheets consume them; they do not redeclare the token set.
- **CSS is the visual source of truth.** JS must not set intrinsic visual values (`width`, `height`, `display`, `cursor`, `opacity`, `color`, `image-rendering`, etc.) via inline `style` or presentational HTML attributes.
- Allowed JS writes: CSS custom properties on `:root` or a host node, viewport / virtualization `transform` matrices, and `classList` / `data-*` state.
- Class and custom-property assignment follows the 3-tier scope model (keep style invalidation local):
  1. **Global.** `html` / `body` for window-wide modes. Direct rules only; never `body.foo *`.
  2. **Component.** Host node for coordinated child state.
  3. **Leaf.** The target element.

### JS module ownership
- The state machine owns app state and has no DOM. UI modules subscribe to it and render themselves.
- Domain logic lives in pure service modules (no `document`). Action ids, labels, defaults, and handlers have one registry; other files derive from it. Filter and scaler methods live under `services/filters` and `services/scaling`; the GL runtime does not know their names; overlay canvases have one UI owner.
- Each UI feature owns its DOM and self-subscribes. Bootstrap stays thin: init + a slim state fan-out. It does not render another module's surface.
- A coordinator such as `urlLoader.js` owns its domain and has no DOM. The file that paints a surface, such as `filePanel.js`, is the only writer for that surface. The file-by-file map is `.agents/architecture-state.md`.
- Shared cross-window helpers (theme, preview, window fit) stay out of the state machine and out of feature UI files.
- New frontend work extends this layering. Do not dump new DOM into bootstrap or new domain logic into a UI file. Frontend unit tests live in `mocha/`, while E2E tests, action recorder shims, and replay diagnostic probes live in `e2e/`, strictly outside `src/` to prevent embedding test or diagnostic machinery into the release bundle via `frontendDist: "../src"`.

### Rust module ownership
- The crate root is bootstrap: plugin wiring, command registration, main-window construction, config-watcher start. It does not grow archive, protocol, command, or test bodies.
- Domain logic lives in `archives/` (readers + `ArchiveCache` facade), `formats.rs`, and `ico.rs`. Callers use facade methods, not another module's internals.
- `commands/` is the Tauri IPC surface. Each command file owns one family and adapts domain modules. It does not grow archive, window, or config internals.
- Protocol, windows, platform, and config stay out of bootstrap and out of each other. `models.rs` is the IPC contract. Tests live under `tests/` via `#[path]`; do not widen visibility for tests.
- New backend work extends this layering. The file-by-file map is `.agents/architecture-state.md`. Do not dump new domain into `lib.rs`, new window code into `config.rs`, or a second copy of a helper that already exists. Keep IPC command names, JSON shapes, and `quivit://` URLs stable unless the change is a practical function or performance win.
