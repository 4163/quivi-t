# Previews host spec (draft for review)

This validation comparison was performed against `.agents/skills/validate-changes/SKILL.md` before presenting. Spec only, no code changed, no behavior changed.

Status: draft. Do not implement until the user signs off each open point at the bottom.

## Locked definitions

These hold for the whole spec. A change here needs explicit user signoff.

- Previews means the Windows Explorer preview pane today plus the thumbnail handler later. Code and binary names use the plural. The CLSID value from `origin/experimental/windows-previews` stays unchanged so test machines do not orphan.
- Stable host path is `%LOCALAPPDATA%\QuiviT\bin\quivit-previews.exe` plus a sidecar `%LOCALAPPDATA%\QuiviT\bin\quivit-previews.version` holding preview version, build profile, and sha256. It is the only helper location. Every build registers this path, never `current_exe`.
- Ship artifact stays one file. `QuiviT.exe` is the only download. The helper materializes at runtime on machines where the user opts into archive previews. It is a runtime cache like `extractor-cache`, not a second product.
- Portable does not move the helper. Config stays portable per `src-tauri/src/config.rs:46`. Shell integration is machine local by nature. Deleting a portable folder does not unregister the handler.
- Preview version is independent of app version. One constant, `PREVIEW_HOST_VERSION: u32`, lives in the previews module and both the main exe and any future lean helper share it. Bump only on preview contract change. App only changes do not bump.
- Update rule is newest wins, never downgrade between release builds. Release: staged version lower than embedded means overwrite, staged debug profile means overwrite, equal healthy release means keep staged and re-register even when the running exe bytes differ, corrupt staged file (sha256 differs from the sidecar record) means repair, greater staged version means keep and re-register. Debug: always overwrite on consent with no version check. E2E suite: never stage, never register.
- Test runners stay hermetic and helpers stay global. Override folders (`.dev-config`, `.e2e-config`, `e2e/.debug-config`) hold config splits only, never helper binaries. The e2e suite (`is_e2e_suite`, `src-tauri/src/config.rs:407`) stages and registers nothing. Debug builds always overwrite the global path on consent with no version check, so iteration needs no bump. Release builds are version gated per the update rule.
- Registration writes only on user consent. File Types Apply enables, File Types remove disables, and open repairs already registered types. No background staging on every launch.
- Helper does read only work. List names, paint text, read archive stream. No registry writes, no child processes, no network from the `--previews-pane` path.

## Deviation rules

- A cold agent picks this up from a dirty tree with no handoff. Work the checklists in order. Check an item only when its accept line passes.
- States are `[x]` done and verified, `[ ]` not started, `[~]` partial with a note.
- Do not rename the CLSID, the registry layout, or the CLI contract without a migration note in this file first.
- Do not add a second shipped binary, a packer, or a scheduled task to solve anything in here.
- Docs stay in this file until signoff. Do not touch `README.md` or `.agents/architecture-state.md` for this work until asked.

## Background

Branch `origin/experimental/windows-previews` (`a4a45c6`) puts the COM local server inside the main exe. `src-tauri/src/main.rs` on that branch serves `--preview-handler` and returns before Tauri runs. Registration in `src-tauri/src/commands/registry.rs` on that branch passes `std::env::current_exe()` into `register_for_extension()`, and `src-tauri/src/platform/preview_handler/windows.rs:19` writes that path into `CLSID\{...}\LocalServer32`.

That breaks when more than one build exists. Installed release, portable copy, debug target, or a renamed download all overwrite the same `LocalServer32`. Last writer wins. Move or delete that exe and the pane goes black with a stale registration. Debug runs point Explorer at a path that gets rebuilt and locked. The historical writeup on that branch (`.agents/preview-handler.md`) already records the lock and low integrity fixes. This spec keeps those fixes and changes only where the exe lives and how it is versioned.

Existing main branch anchors: `src-tauri/src/commands/registry.rs:129` builds shell open commands from `current_exe`, `src-tauri/src/config.rs:38` defines exe dir and portable detection, `src-tauri/src/config.rs:78` defines the override dir used for dev isolation.

## Design phase 1: staged self clone (this spec)

No new crate. On consent, copy the running exe bytes to the stable host path with tmp plus rename, write the sidecar, register the stable path. The `--previews-pane` entry keeps the early return before Tauri setup so the helper never opens a window or touches the network.

Why a copy and not a second build target: one hash and one reputation to build, the Authenticode signature carries over byte for byte once signing exists, and the change is about 100 lines. A lean helper stays phase 2, only if pane cold start measures slow in release.

Naming in phase 1:

- Binary `quivit-previews.exe`. Folder `%LOCALAPPDATA%\QuiviT\bin\`.
- Module rename `platform/preview_handler/` to `platform/previews/`. Keep the CLSID string value.
- CLI flag becomes `--previews-pane`. Reserve `--previews-thumb` for later. This breaks old test machine registrations on purpose while unmerged. Repair path re-registers.

## Design phase 2: lean helper (deferred)

Only if release pane start is slow or Defender scans of the full copy hurt. New `[[bin]]` with no Tauri dep, shared listing module, embedded into the main exe and staged the same way to the same path with the same version rule. Not part of the checklists below.

## Registration flow

- `ensure_previews_host()` always resolves the global bin path. Override folders never change it. The e2e suite returns early and stages nothing.
- Compare staged sidecar version plus profile against embedded `PREVIEW_HOST_VERSION`. Release: lower stages overwrite, staged debug profile overwrites, equal healthy release keeps bytes and only re-registers, corrupt repairs from the running exe, greater keeps and re-registers. Debug outside the suite always overwrites on consent with no version check. The e2e suite stages nothing and touches no hive. Registration and the HKLM mirror run only outside the suite.
- `register_for_extension()` takes the ensured host path, not `current_exe`. Writes per user CLSID `LocalServer32`, the `DisableLowILProcessIsolation` opt out, the `PreviewHandlers` list value, and the `QuiviT.<ext>\shellex` link for archive types only. Elevated runs also mirror the CLSID tree to HKLM; standard runs write HKCU only. Existing helpers `is_archive_ext` in `src-tauri/src/formats.rs` gate the type list.
- Locked file handling. Explorer keeps the helper running briefly after the pane closes, and Windows refuses to overwrite a running program. A failed write returns a plain error telling the user to close the preview pane and retry. Never kill the server process.
- Unregister removes the per extension link. Removes the shared CLSID tree only when no archive type still links it. Never deletes the helper binary on unregister.
- Diagnostics extend the existing preview diagnostics with host path, host exists, staged preview version versus embedded, and a stale flag when `LocalServer32` points elsewhere.

## Antivirus posture

Self clone is the low flag option. One hash, signature preserved, no Mark of the Web on the copy since Rust read plus write does not propagate `Zone.Identifier`. Keep it that way and do not copy ADS streams.

- Write rarely, only on consent or repair. Version gate so app updates that did not touch previews rewrite nothing.
- Stage to the app bin folder only. Never `%TEMP%`.
- No packer, no UPX, no obfuscation. Publish sha256 per release.
- Helper stays read only at runtime. No registry, process, or network calls from the pane path.
- Local verification per slice: scan the staged file with Defender and note it. Per release: submit the single exe for a clean verdict. The copy needs no separate submission.
- Code signing and SmartScreen reputation stay future work. Nothing here blocks them. Signing the main exe signs the staged copy automatically. When signing lands, verify the staged copy still validates before relying on it.

## Checklist slice 1: host staging and versioning

- [ ] Add `PREVIEW_HOST_VERSION` plus `resolve_previews_host_path()` and `ensure_previews_host()` under the renamed previews module. Accept: path is always the global bin, portable included. No registry writes in this unit.
- [ ] Sidecar read and write with version, profile, plus sha256, tmp plus rename. Accept: missing sidecar stages, corrupt staged bytes repair, staged debug profile overwritten by release, equal healthy release keeps bytes without rewrite, greater staged version keeps bytes.
- [ ] Isolation test. Accept: e2e suite stages and registers nothing; debug stages global with no version check; release is version gated.
- [ ] Locked helper test. Accept: staging over a running helper returns a retry message naming the preview pane, no process is killed.

## Checklist slice 2: registration retarget

- [ ] Change `register_for_extension()` and callers in `src-tauri/src/commands/registry.rs` to use the ensured host path. Accept: `LocalServer32` in HKCU and HKLM (when writable) points at the stable host, never at `target/debug` or a portable path.
- [ ] Rename flag to `--previews-pane` in `src-tauri/src/main.rs` and the COM server entry. Accept: old `--preview-handler` registrations get repaired to the new command on next Apply or repair.
- [ ] Rename module and binary references to `previews` plural. Accept: `cargo check --tests --manifest-path src-tauri/Cargo.toml` green, CLSID value unchanged.

## Checklist slice 3: diagnostics and repair

- [ ] Extend preview diagnostics with host path, exists, staged versus embedded version, stale flag. Accept: Options can tell a stale registration apart from a render failure.
- [ ] Repair on File Types open touches only already registered archive types. Accept: opening the page never enables a new type by itself.

## Checklist slice 4: verification

- [ ] `cargo check --tests --manifest-path src-tauri/Cargo.toml` green.
- [ ] Nearest filtered backend test for touched registry and format code green. Full `cargo test` only at final signoff per blast radius.
- [ ] `node --check` on touched frontend files plus `npm run mocha` green.
- [ ] Defender scan of the staged helper noted clean.
- [ ] Staged file carries no `Zone.Identifier` stream (check with `dir /r`).
- [ ] Manual runtime list handed to the user, no slice declared done without signoff.

## Open points for user review

1. Decided: sidecar is JSON with `preview_version`, `profile`, and `sha256`. Matches the repo config convention, serde is already in the tree, and new fields later do not break field order.
2. Decided: File Types open repairs both bytes and registry for already registered archive types. Opening the page never enables a new type by itself.
3. Decided: the helper binary stays on disk on unregister by design. Keys only. No delete button in this spec.
4. Decided: thumbnail CLSID later. The thumbnail slice picks its ID when it starts. Nothing reserved now.
