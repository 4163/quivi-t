# Config run modes plan

Validation comparison against `.agents/skills/validate-changes/SKILL.md` performed before presenting. This plan adds no module-boundary crossings, no IPC shape changes, no new filenames, and no new test suites. It extends existing helpers and existing test files only.

## Starting tree state

A cold agent should know the tree is dirty before touching anything.

- `src-tauri/tauri.conf.json` has bundling off (installers removed, release is the bare exe).
- `src/css/options.css` holds a user link tweak. Leave it alone.
- `src-tauri/target/debug/.portable` was deleted by the user. Dev currently falls through to real roaming data until slice 2 lands. Do not run dev casually before then.

## Locked definitions

- Folder picker means the `QUIVIT_CONFIG_DIR` env var. Layout flag means `QUIVIT_PORTABLE=1`. Filenames never change.
- One folder holds one layout. Persistent folders never switch. Wiped folders take whatever layout the run sets.
- The marker is dead. Nothing writes `.portable` after slice 2. Portable detection is the in-file `portable_mode` flag only.
- Roaming user data is only touched by the release exe. Dev, tests, and diagnose never resolve to it.

## Deviation rules

- If a step needs a new filename or a new test suite, stop and ask instead.
- If a step touches installed-exe behavior for real users, stop and ask instead.
- Docs (`architecture-state.md`, `README.md`) update only when explicitly asked, after slices land.
- No commits unless explicitly asked.

## Slice 0: ignore the runner folders

- [ ] Append `.dev-config/` and `.e2e-config/` to `.gitignore:1-63`, next to the existing `e2e/.profile/` entry at line 55.
- Accept: `git status --porcelain` stays quiet after creating both folders with junk files in them, then remove the junk.

## Slice 1: backend folder override — done, verified 2026-09-25

Work in `src-tauri/src/config.rs`. Reused `extract_keys`, `merge_keys`, `read_json_file`, `merge_file_into`. No visibility widened (child `mod tests` reaches private items). Roaming and exe-portable bodies now share `load_from_dir` / `write_split_config`, behavior unchanged.

- [x] Resolver `override_config_dir` returns the dir only for absolute paths; `get_config_path` honors it, so the config watcher follows with no extra change.
- [x] Override set skips marker and exe-folder guessing. Layout is split unless `QUIVIT_PORTABLE=1` (`override_single_file`) or the in-file flag says portable.
- [x] `save_override` scopes to its own dir; single-file saves drop split leftovers in that dir only. Roaming migration behavior untouched.
- [x] Five hermetic tests in `src-tauri/src/tests/config_tests.rs` (temp dirs, env guard with drop-restore, one lock for env-mutating tests): marker precedence, relative and empty rejection, split round trip with favorites, single-file layout plus leftover cleanup, in-file flag honored.
- Accept met: `cargo test --lib config::` 13 passed. Blast radius: full `--lib` 92 passed, only the 2 pre-existing archive fixture failures (`cb7`/`7z` missing files, identical before this change). `cargo check --tests` clean.

## Slice 2a: runtime setup — done, verified 2026-09-25

- [x] `scripts/dev.js` (new): sets `QUIVIT_CONFIG_DIR` to `<repo>/.dev-config`, creates it, passes `--portable` through as `QUIVIT_PORTABLE=1`, forwards remaining args to `tauri dev`. `--print-dir` dry-run prints the folder without launching.
- [x] `package.json`: `dev` and `dev:portable` scripts added. Existing `tauri` script untouched.
- [x] `.gitignore`: `.dev-config/` and `.e2e-config/` added next to the `e2e/.profile/` entry.
- [x] Startup log: `describe_config_source` (`config.rs`) printed once from `run` (`lib.rs:35`), naming folder and layout. `node --check` clean, `--print-dir` prints the dev folder, `cargo check --tests` clean, `cargo test --lib config::` 14 passed.
- Accept for the user to confirm by launching: terminal shows the `[QuiviT] config:` line, settings land in `.dev-config` only, roaming untouched.

## Slice 2b: harness surgery — deferred

- [ ] `wdio.conf.js`: set the dir to `<repo>/.e2e-config` for suite runs and keep `<repo>/e2e/.profile` for record and diagnose. Delete the marker writes (`wdio.conf.js:181-182,199`), the backup and restore block (`wdio.conf.js:97-139`), and the onComplete restore (`wdio.conf.js:235-279`). Keep the `LOCALAPPDATA` redirect (`wdio.conf.js:12`) so tests keep a throwaway library.
- Accept: marker never reappears under `target/debug` after suite, record, and diagnose runs. Blast radius: config watcher path (`commands/watchers.rs:155`) still fires for the override dir. Verify with a full suite run.

## Slice 3: test both layouts

- [ ] Run the suite twice from the same specs: once split, once with `QUIVIT_PORTABLE=1`.
- [ ] Persistence spec asserts per layout: split run checks the split favorites file, portable run checks the single file's `frontend_data`.
- Accept: `npm test` passes, both suite runs pass. Full `cargo test --manifest-path src-tauri/Cargo.toml` reserved for final signoff per the targeted-testing rule.

## Slice 5: options folder hints — simplified per verdict, verified 2026-09-25

Same two rows, no badges, no brackets. Release runs show the fixed spots as before. An override run repoints both rows at its own folder, since that is where the files actually live, and both buttons open it via `open_active_config_dir`.

- [x] `get_active_config_info` plus `open_active_config_dir` in `config.rs`, struct in `models.rs`, both commands registered in `lib.rs`.
- [x] `options.html` and `options.css` untouched. `options.js`: one refresh overwrites both labels and both button targets only in override mode.
- Accept met: `node --check` clean, `cargo check --tests` clean, config tests 14 passed. User to confirm visually per run mode.

## Slice 4 (deferred): favorites save hardening

Only after slices 1 to 3 are green and modes are deterministic.

- [ ] Immediate persist for rare explicit favorites writes (`src/js/filepanel/favoritesStore.js:20-23,82-85`) with a no-op guard on unchanged collapse state.
- [ ] Flush before reload in `reloadConfigAndSyncLibrary` (`src/js/main/main.js:207`).
- [ ] Options save carries live favorites keys from disk, mirroring `carry_live_library_state` (`src-tauri/src/commands/library.rs:442`), since Options never edits them.
- [ ] Hermetic roaming round-trip test over temp dirs, no user paths.
- Accept: repro script (toggle, reload before flush) keeps the favorite. `node --check` on touched files, `npm test` passes. Manual runtime list presented to the user with no code references, then wait for signoff. Do not declare finished.
