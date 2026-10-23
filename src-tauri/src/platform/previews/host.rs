//! Stable preview host staging.
//!
//! Explorer must always launch the same helper path. Every build registers
//! `%LOCALAPPDATA%\QuiviT\bin\quivit-previews.exe`, never `current_exe`.
//! The helper is staged at application launch or registration by copying
//! the running exe bytes with tmp plus rename. Override folders never change
//! the path, and the e2e suite stages nothing.

use std::path::{Path, PathBuf};

/// Bump only on preview contract change. App only changes do not bump.
pub const PREVIEW_HOST_VERSION: u32 = 13;

pub const PREVIEWS_BIN_NAME: &str = "quivit-previews.exe";
pub const PREVIEWS_SIDECAR_NAME: &str = "quivit-previews.version";
pub const PREVIEWS_PANE_ARG: &str = "--previews-pane";
const PREVIEWS_THUMB_ARG: &str = "--previews-thumb";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PreviewsSidecar {
    pub preview_version: u32,
    pub profile: String,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_sha256: Option<String>,
}

#[cfg(windows)]
const THUMBNAIL_PROXY_BYTES: &[u8] =
    include_bytes!(concat!(env!("OUT_DIR"), "/quivit-thumbnail-proxy.dll"));

pub fn proxy_path_for(host_path: &Path) -> PathBuf {
    host_path.with_file_name(super::contract::THUMBNAIL_PROXY_NAME)
}

pub fn proxy_is_healthy(host_path: &Path, sidecar: &PreviewsSidecar) -> bool {
    #[cfg(windows)]
    {
        sidecar.proxy_sha256.as_ref().is_some_and(|expected| {
            std::fs::read(proxy_path_for(host_path))
                .is_ok_and(|bytes| compute_sha256_hex(&bytes) == *expected)
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (host_path, sidecar);
        true
    }
}

fn stage_proxy(host_path: &Path) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let hash = compute_sha256_hex(THUMBNAIL_PROXY_BYTES);
        let path = proxy_path_for(host_path);
        if std::fs::read(&path).is_ok_and(|bytes| compute_sha256_hex(&bytes) == hash) {
            return Ok(Some(hash));
        }
        let tmp = tmp_for(&path);
        std::fs::write(&tmp, THUMBNAIL_PROXY_BYTES)
            .map_err(|error| locked_retry_message(&error.to_string()))?;
        std::fs::rename(&tmp, &path).map_err(|error| locked_retry_message(&error.to_string()))?;
        Ok(Some(hash))
    }
    #[cfg(not(windows))]
    {
        let _ = host_path;
        Ok(None)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostAction {
    Stage,
    Keep,
}

pub fn embedded_profile() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    }
}

/// Always the global bin path. Portable included, override folders ignored.
pub fn resolve_previews_host_path() -> PathBuf {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    if local.trim().is_empty() {
        return PathBuf::new();
    }
    Path::new(&local)
        .join("QuiviT")
        .join("bin")
        .join(PREVIEWS_BIN_NAME)
}

pub fn sidecar_path_for(host_path: &Path) -> PathBuf {
    host_path.with_file_name(PREVIEWS_SIDECAR_NAME)
}

pub fn expected_command_for(host_path: &Path) -> String {
    format!(r#""{}" {}"#, host_path.to_string_lossy(), PREVIEWS_PANE_ARG)
}

pub fn thumb_command_for(host_path: &Path) -> String {
    format!(
        r#""{}" {}"#,
        host_path.to_string_lossy(),
        PREVIEWS_THUMB_ARG
    )
}

/// True when a registration points somewhere other than the stable host.
/// Missing registration is not stale, it is just unregistered. An old
/// `--preview-handler` command counts as stale so the next Apply repairs it.
pub fn is_stale_registration(current_server: Option<&str>, host_path: &Path) -> bool {
    match current_server {
        None => false,
        Some(current) => current != expected_command_for(host_path),
    }
}

pub fn compute_sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn tmp_for(path: &Path) -> PathBuf {
    let mut text = path.as_os_str().to_owned();
    text.push(".tmp");
    PathBuf::from(text)
}

fn locked_retry_message(detail: &str) -> String {
    format!("Close the preview pane and Explorer windows, then retry: cannot update the preview helper ({detail}). A shell handler may still be running.")
}

pub(crate) fn decide_host_action(
    staged: Option<&PreviewsSidecar>,
    hash_ok: bool,
    embedded_version: u32,
    embedded_is_debug: bool,
) -> HostAction {
    if embedded_is_debug {
        return HostAction::Stage;
    }
    let Some(staged) = staged else {
        return HostAction::Stage;
    };
    if !hash_ok {
        return HostAction::Stage;
    }
    if staged.profile == "debug" {
        return HostAction::Stage;
    }
    if staged.preview_version < embedded_version {
        return HostAction::Stage;
    }
    HostAction::Keep
}

pub fn read_sidecar(sidecar_path: &Path) -> Option<PreviewsSidecar> {
    let text = std::fs::read_to_string(sidecar_path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_sidecar_atomic(sidecar_path: &Path, sidecar: &PreviewsSidecar) -> Result<(), String> {
    let text = serde_json::to_string_pretty(sidecar).map_err(|e| e.to_string())?;
    let tmp = tmp_for(sidecar_path);
    if let Some(parent) = sidecar_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&tmp, text.as_bytes()).map_err(|e| locked_retry_message(&e.to_string()))?;
    std::fs::rename(&tmp, sidecar_path).map_err(|e| locked_retry_message(&e.to_string()))?;
    Ok(())
}

fn stage_copy(source_exe: &Path, host_path: &Path) -> Result<String, String> {
    let bytes =
        std::fs::read(source_exe).map_err(|e| format!("Failed to read the running exe: {e}"))?;
    let sha256 = compute_sha256_hex(&bytes);
    if let Some(parent) = host_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = tmp_for(host_path);
    std::fs::write(&tmp, &bytes).map_err(|e| locked_retry_message(&e.to_string()))?;
    std::fs::rename(&tmp, host_path).map_err(|e| locked_retry_message(&e.to_string()))?;
    Ok(sha256)
}

fn same_file(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    let canonical_left = std::fs::canonicalize(left).ok();
    let canonical_right = std::fs::canonicalize(right).ok();
    match (canonical_left, canonical_right) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

fn lock_staging(host_path: &Path) -> Result<std::fs::File, String> {
    if let Some(parent) = host_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(host_path.with_extension("lock"))
        .map_err(|error| format!("Cannot open the preview staging lock: {error}"))?;
    lock.lock()
        .map_err(|error| format!("Cannot acquire the preview staging lock: {error}"))?;
    Ok(lock)
}

/// Testable core. Copies `source_exe` to `host_path` per the update rule.
/// Never kills a process; a locked helper surfaces as a retry message.
pub(crate) fn ensure_previews_host_from(
    source_exe: &Path,
    host_path: &Path,
    embedded_version: u32,
    embedded_is_debug: bool,
) -> Result<PathBuf, String> {
    if host_path.as_os_str().is_empty() {
        return Err("Preview helper folder is unavailable (LOCALAPPDATA not set).".into());
    }
    if same_file(source_exe, host_path) {
        return Ok(host_path.to_path_buf());
    }
    // Keep helper bytes, proxy bytes, and their sidecar in one writer's update.
    let _staging_lock = lock_staging(host_path)?;
    let sidecar_path = sidecar_path_for(host_path);
    let app_path_str = Some(source_exe.to_string_lossy().into_owned());
    if embedded_is_debug {
        let sha256 = stage_copy(source_exe, host_path)?;
        let proxy_sha256 = stage_proxy(host_path)?;
        write_sidecar_atomic(
            &sidecar_path,
            &PreviewsSidecar {
                preview_version: embedded_version,
                profile: "debug".into(),
                sha256,
                app_path: app_path_str,
                proxy_sha256,
            },
        )?;
        return Ok(host_path.to_path_buf());
    }

    let staged = read_sidecar(&sidecar_path);
    let hash_ok = match (&staged, host_path.exists()) {
        (Some(sidecar), true) => match std::fs::read(host_path) {
            Ok(bytes) => {
                compute_sha256_hex(&bytes) == sidecar.sha256 && proxy_is_healthy(host_path, sidecar)
            }
            Err(_) => false,
        },
        _ => false,
    };
    match decide_host_action(staged.as_ref(), hash_ok, embedded_version, false) {
        HostAction::Keep => {
            if let Some(mut sidecar) = staged {
                if sidecar.app_path != app_path_str {
                    sidecar.app_path = app_path_str;
                    let _ = write_sidecar_atomic(&sidecar_path, &sidecar);
                }
            }
            Ok(host_path.to_path_buf())
        }
        HostAction::Stage => {
            let sha256 = stage_copy(source_exe, host_path)?;
            let proxy_sha256 = stage_proxy(host_path)?;
            write_sidecar_atomic(
                &sidecar_path,
                &PreviewsSidecar {
                    preview_version: embedded_version,
                    profile: "release".into(),
                    sha256,
                    app_path: app_path_str,
                    proxy_sha256,
                },
            )?;
            Ok(host_path.to_path_buf())
        }
    }
}

/// Stable host path, staged on consent. Override folders never change it.
/// The e2e suite stages nothing. Debug always overwrites, release is gated.
pub fn ensure_previews_host() -> Result<PathBuf, String> {
    if crate::config::is_e2e_suite() {
        return Err("E2E suite never stages the preview helper.".into());
    }
    let host_path = resolve_previews_host_path();
    let source_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    ensure_previews_host_from(
        &source_exe,
        &host_path,
        PREVIEW_HOST_VERSION,
        cfg!(debug_assertions),
    )
}

/// Diagnostics helper. Reports what is on disk without staging anything.
pub fn staged_host_info() -> (PathBuf, bool, Option<PreviewsSidecar>) {
    let host_path = resolve_previews_host_path();
    if host_path.as_os_str().is_empty() {
        return (host_path, false, None);
    }
    let exists = host_path.exists();
    let sidecar = read_sidecar(&sidecar_path_for(&host_path));
    (host_path, exists, sidecar)
}

#[cfg(test)]
#[path = "../../tests/previews_tests.rs"]
mod tests;
