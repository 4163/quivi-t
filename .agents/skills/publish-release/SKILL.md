---
name: publish-release
description: "Build, package, tag, and publish a QuiviT Windows release to GitHub Releases. Trigger only when explicitly asked to release or publish a version."
argument-hint: "<version, e.g. 1.0.0 or 1.0.1>"
---

# Publish release

Build the standalone Windows release binary, package the portable zip with bundled themes, tag the release commit, and publish it on GitHub Releases via `gh`.

Read and apply `.agents/skills/unslop/SKILL.md` to all release notes. Never tag, push, or publish without explicit user approval at the approval gate.

## Prerequisites

- GitHub CLI (`gh`) installed and authenticated against `4163/quivi-t` (`gh auth status`).
- Clean working tree on `main` (or the explicitly requested release branch), synced with `origin`.
- Target tag `v<version>` does not exist locally or on `origin`.

## Naming conventions

- **Tag:** `v<version>` (e.g. `v1.0.0`). Matches `evaluateReleasesUpdate` in `src/js/services/appVersion.js`.
- **Release title:** `v<version> (<Codename>)` when the major version has a codename in `MAJOR_VERSION_CODENAMES` (e.g. `v1.0.0 (Freya)`), otherwise `v<version>`.
- **Zip archive:** `QuiviT-v<version>-<Codename>-win-x64.zip` when the major version has a codename (e.g. `QuiviT-v1.0.0-Freya-win-x64.zip`), otherwise `QuiviT-v<version>-win-x64.zip`.
- **Top-level folder inside zip:** `QuiviT-v<major>-<Codename>/` when the major version has a codename (e.g. `QuiviT-v1-Freya/`), otherwise `QuiviT-v<major>/`.
- **Executable inside folder:** `QuiviT.exe` (renamed from `src-tauri/target/release/tauri-app.exe`).
- **Themes inside folder:** `themes/*.css` copied from the repo `themes/` directory.

## Workflow

### 1. Preflight checks

1. Run `git status --short` and confirm the working tree is clean.
2. Verify version and codename parity across all manifests and frontend fallbacks:
   - `package.json` (`"version"`)
   - `src-tauri/Cargo.toml` (`version`)
   - `src-tauri/tauri.conf.json` (`"version"`)
   - `src/js/services/appVersion.js` (`FALLBACK_APP_VERSION` and `MAJOR_VERSION_CODENAMES` entry for the major version)
   - `src/index.html` (`.status-version` `aria-label`, `.status-version-codename`, and `.status-version-number` static pre-JS fallback)
   Stop and report any mismatch before building.
3. Confirm `git tag -l v<version>` and `git ls-remote --tags origin v<version>` are empty.
4. Run `npm run mocha` and `cargo test --manifest-path src-tauri/Cargo.toml`. Stop if any test fails.

### 2. Build release binary

1. Run `npm run build` (`tauri build`). Because `src-tauri/tauri.conf.json` sets `"bundle": { "active": false }`, this produces the standalone executable at `src-tauri/target/release/tauri-app.exe`.
2. Confirm `src-tauri/target/release/tauri-app.exe` exists and check its timestamp and size.

### 3. Package portable zip

Stage everything under `src-tauri/target/release/package/` (ignored by git) so the working tree stays clean:

1. Recreate `src-tauri/target/release/package/<folder-name>/`.
2. Copy `src-tauri/target/release/tauri-app.exe` to `<folder-name>/QuiviT.exe`.
3. Copy `themes/*.css` to `<folder-name>/themes/`.
4. Compress `<folder-name>/` into `src-tauri/target/release/QuiviT-v<version>-<Codename>-win-x64.zip` (omitting `-<Codename>` if unmapped).
5. Inspect the archive entries to verify it contains only `QuiviT.exe` and `themes/*.css` (no `.pdb`, `.dev-config`, or portable config files).
6. Compute the SHA-256 checksum of both `QuiviT.exe` and the release zip.

### 4. Draft release notes

Keep `README.md`'s `## Changelog` pointing to GitHub Releases. Do not duplicate release notes into `README.md`.

- **Initial release (`1.0.0`):** Write in present tense. Open with one sentence naming the release and codename, list grouped user-facing highlights, and close with a short **Install & Notes** block (Windows 10/11 with WebView2, portable single executable, bundled themes under `themes/` importable via **Options → Customization**, unsigned binary SmartScreen note, and SHA-256 checksum).
- **Subsequent releases (`1.0.1`, `1.1.0`, `2.0.0`, etc.):** Inspect `git log <previous-tag>..HEAD` and write user-facing changes in past tense grouped under **Added**, **Changed**, and **Fixed** (omit empty sections). Skip purely internal refactors unless they change user-visible behavior or performance. Include the SHA-256 checksum at the bottom.

### 5. Approval gate

Present the following to the user and wait for explicit approval before running any tag or publish command:

- Commit hash and branch being released
- Tag name and release title
- Archive file name, size, entry listing, and SHA-256 checksum
- Full draft release notes

### 6. Tag, push, and publish

Only after explicit user approval:

1. Create and push the annotated tag:
   ```bash
   git tag -a v<version> -m "v<version> (<Codename>)"
   git push origin v<version>
   ```
2. Write the approved release notes to a temporary file under `src-tauri/target/release/package/release-notes.md`.
3. Publish the release with `gh`:
   ```bash
   gh release create v<version> "src-tauri/target/release/<zip-name>" --title "v<version> (<Codename>)" --notes-file "src-tauri/target/release/package/release-notes.md" --latest
   ```
   Do not pass `--draft` or `--prerelease` unless the user asks for it, because the in-app update check ignores drafts and prereleases.
4. Remove the temporary staging directory `src-tauri/target/release/package/` and confirm `git status --short` is clean.
5. Report the published GitHub Release URL to the user.
