# Custom Agent Rules
These rules apply to the AI coding assistant (Antigravity).

## General Guidelines
- Keep responses concise and focused on the task.
- Follow existing code style and formatting for each directory and its associated files.
- NEVER (unless instructed otherwise) execute git commit commands or automate git commits. The user handles all commits manually or through the push pipeline.
- **Self-documenting code.** Write code that reads clearly on its own — use descriptive names and flat control flow (early returns over multi-layer nesting). Keep comments minimal and concise and reserve them for *why*, not *what*. The only exception is documenting complex module invariants or system rules (e.g., `// Architectural Standard:` or `// ── Persistence policy ──`), which should be thoroughly documented in-line to maintain structural consistency.
- **Performance first.** Avoid dynamic evaluations and allocations in hot paths. Cache aggressively.
  *Practical Examples for Agents:*
  1. **Hot Path Optimization:** Pre-parse config values into `O(1)` lookup structures (e.g. JS `Set` or `Map`) on configuration load instead of dynamically mapping strings inside `requestAnimationFrame`, `mousemove`, or `scroll` handlers.
  2. **Zero-Flicker Lifecycle:** Inject tiny Base64-encoded cover thumbnails directly into `localStorage` cross-window state to eliminate IPC and protocol (`asset://`) fetch latency during window instantiation.
  3. **Thread Concurrency:** Offload heavy CPU bound tasks (e.g., LZMA2/7Z extraction via `sevenz-rust`) strictly to non-blocking background threads (`tokio::spawn` or `std::thread`), leaving the primary Tauri IPC and JS UI threads exclusively for layout and rendering.
  4. **Aggressive I/O Caching:** Utilize header-only file reads and maintain in-memory LRU caches (`lru` crate) to achieve instantaneous virtual archive directory traversal.
  5. **DOM & Asset Virtualization:** Lazy-load images in list views (`IntersectionObserver`) and NEVER decode original full-size image assets to create thumbnail views—leverage system/shell thumbnails (`SHGetFileInfoW`) or pre-scaled caches where applicable.
- **Measure twice, cut once.** Prefer small, deliberate changes over broad refactors. Before writing a new function, search the existing codebase for one that already does the job — reuse it or extend it rather than creating a duplicate. If a change would duplicate logic, extract it into a shared helper instead.
- **Work in logical slices.** Prioritize small, precise code changes rather than big blocks to prevent tooling and scope failures, especially during large refactors. Be surgical!
- **YAGNI.** Do not add abstractions, features, or complexity without a clear need.
