# Custom Agent Rules
These rules apply to the AI coding assistant.

## Agent Behavior
- Keep responses concise and focused on the task.
- Follow existing code style and formatting for each directory and its associated files.
- For writing work, read `.agents/skills/unslop/SKILL.md` and follow it even if the harness does not auto-load always-active skills. This applies to docs, prompts, comments, and user-facing copy.
- **Verify:** Run `.agents/skills/verify-implementation/SKILL.md` when finishing a slice or when asked to "verify".
- **Validate:** Run `.agents/skills/validate-changes/SKILL.md` when explicitly asked to "validate" code. Do not confuse "verify" (tests and docs) with "validate" (architecture review).
- NEVER (unless instructed otherwise) execute git commit commands or automate git commits. The user handles all commits manually or through the commit pipeline.

## Code Guidelines
- **Self-documenting code.** Write code that reads clearly on its own. Use descriptive names and flat control flow (early returns over multi-layer nesting). Keep comments minimal and concise. Reserve them for *why*, non-obvious constraints, and maintained module invariants. A short local heading is fine when a file needs to explain an ownership, lifecycle, or persistence rule. Do not add commentary that merely narrates the code.
- **Performance first.** Avoid dynamic evaluations and allocations in hot paths. Cache aggressively.
  *Practical Examples for Agents:*
  1. **Hot Path Optimization:** Pre-parse config values into `O(1)` lookup structures (e.g. JS `Set` or `Map`) on configuration load instead of dynamically mapping strings inside `requestAnimationFrame`, `mousemove`, or `scroll` handlers.
  2. **Zero-Flicker Lifecycle:** Inject tiny Base64-encoded cover thumbnails directly into `localStorage` cross-window state to eliminate IPC and protocol (`asset://`) fetch latency during window instantiation.
  3. **Thread Concurrency:** Offload heavy CPU bound tasks (e.g., LZMA2/7Z extraction via `sevenz-rust`) strictly to non-blocking background threads (`tokio::spawn` or `std::thread`), leaving the primary Tauri IPC and JS UI threads exclusively for layout and rendering.
  4. **Aggressive I/O Caching:** Use header-only file reads and maintain in-memory LRU caches (`lru` crate) for fast virtual archive directory traversal.
  5. **DOM & Asset Virtualization:** Recycle a bounded row pool on scroll for list views. NEVER decode original full-size image assets to create thumbnail views. Use system/shell thumbnails (`SHGetFileInfoW`) or pre-scaled caches where applicable.
- **Measure twice, cut once.** Prefer small, deliberate changes over broad refactors. Before writing a new function, search the existing codebase for one that already does the job. Reuse it or extend it rather than creating a duplicate. If a change would duplicate logic, extract it into a shared helper instead.
- **Work in logical slices.** Prioritize small, precise code changes rather than big blocks to prevent tooling and scope failures, especially during large refactors. Be surgical!
- **YAGNI.** Do not add abstractions, features, or complexity without a clear need.
- **Blast radius.** When modifying core cross-cutting surfaces (IPC, configs, cross-window state, protocol URLs, or archives), stop and prove you haven't broken downstream consumers. Do not rely on speculation or writeups. Use the `.agents/skills/blast-radius/SKILL.md` workflow to execute actual checks and confirm safety.

## Architecture Rules

Keep the codebase from drifting into mixed patterns. Apply these on every change. Order for UI work is structure, then presentation, then behavior.

### Shared
- **One owner per concern.** Each surface or responsibility has exactly one writer (a status readout, chrome visibility, a panel, an image pool, theme apply, an action id).
- **Folders are a byproduct of splitting.** A file moves into a feature folder only when a slice creates a sibling. No pure reorganization commits.
- **Pure modules first.** State machines and domain/services have zero DOM / UI imports. UI modules import them; never the reverse.
- **Communicate across files via state callbacks, not reach-in.** Module A updates shared state (or a dedicated owner API). Module B paints what it owns. A module may mutate its own DOM or view-local state (scroll, drag, hover) without going through the state machine.
- **Do not split a single owner** into sibling files that all touch the same surface. That relocates coupling without removing it.
- **Refactors do not change behavior** unless there is a practical function or UX/performance win.

### HTML-First Rendering
- Prefer static markup over `createElement` / `innerHTML` for stable chrome (menus, rows, badges, probes, placeholders).
- Toggle visibility and state with CSS classes or tokens. Do not remove and re-insert nodes to hide them.
- When a node must be created at runtime, declare a placeholder or template in HTML first.
- Recycle existing nodes on update. Do not wipe a container and rebuild it when slots or a pool already exist.
- A dynamically sized pool is fine when the count depends on viewport or font size.
- Default update path: `textContent`, `src`, `classList`, `data-*`.

### CSS Source of Truth
- Shared tokens, resets, and cross-page rules live in `global.css`. Each HTML page has its own sheet for layout and components.
- Design tokens are CSS custom properties on `:root` in `global.css`. Page sheets consume them; they do not redeclare the token set.
- **CSS is the visual source of truth.** JS must not set intrinsic visual values (`width`, `height`, `display`, `cursor`, `opacity`, `color`, `image-rendering`, etc.) via inline `style` or presentational HTML attributes.
- Allowed JS writes: CSS custom properties on `:root` or a host node, viewport / virtualization `transform` matrices, and `classList` / `data-*` state.
- Class and custom-property assignment follows the 3-tier scope model (keep style invalidation local):
  1. **Global.** `html` / `body` for window-wide modes. Direct rules only; never `body.foo *`.
  2. **Component.** Host node for coordinated child state.
  3. **Leaf.** The target element.

### JS Module Ownership
- The state machine owns app state and has no DOM. UI modules subscribe to it and render themselves.
- Domain logic lives in pure service modules (no `document`). Action ids, labels, defaults, and handlers have one registry; other files derive from it. Filter and scaler methods live under `services/filters` and `services/scaling`; the GL runtime does not know their names; overlay canvases have one UI owner.
- Each UI feature owns its DOM and self-subscribes. Bootstrap stays thin: init + a slim state fan-out. It does not render another module's surface.
- Shared cross-window helpers (theme, preview, window fit) stay out of the state machine and out of feature UI files.
- New frontend work extends this layering. Do not dump new DOM into bootstrap or new domain logic into a UI file.

### Rust Module Ownership
- The crate root is bootstrap: plugin wiring, command registration, main-window construction, config-watcher start. It does not grow archive, protocol, command, or test bodies.
- Domain logic lives in `archives/` (readers + `ArchiveCache` facade), `formats.rs`, and `ico.rs`. Callers use facade methods, not another module's internals.
- `commands/` is the Tauri IPC surface. Each command file owns one family (directory, archives, animation, watchers, associations, shell) and adapts domain modules. It does not grow archive, window, or config internals.
- Protocol, windows, platform, and config stay out of bootstrap and out of each other: `protocol.rs` owns `quivit://`, `windows.rs` owns window lifecycle and size constants, `platform/` owns OS integrations, `config.rs` is persistence only. `models.rs` is the IPC contract. Tests live under `tests/` via `#[path]`; do not widen visibility for tests.
- New backend work extends this layering. Do not dump new domain into `lib.rs`, new window code into `config.rs`, or a second copy of a helper that already exists. Keep IPC command names, JSON shapes, and `quivit://` URLs stable unless the change is a practical function or performance win.
