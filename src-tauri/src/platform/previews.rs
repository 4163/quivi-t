//! Windows Explorer previews integration.
//!
//! Explorer launches the staged helper at `%LOCALAPPDATA%\QuiviT\bin\`
//! with `--previews-pane` as a COM local server. Keeping this out of the
//! Tauri process gives the shell a small, read-only surface that cannot
//! affect the main viewer window.

#[cfg(windows)]
pub(crate) mod windows;

pub mod host;

#[cfg(windows)]
pub use windows::{
    log_event, register_for_extension, register_for_extension_with_host, run_server,
    unregister_for_extension, PREVIEW_HANDLER_CATEGORY, PREVIEW_HANDLER_CLSID_TEXT,
};

pub use host::{
    ensure_previews_host, resolve_previews_host_path, PREVIEW_HOST_VERSION,
};

#[cfg(not(windows))]
pub fn register_for_extension(_extension: &str) -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(windows))]
pub fn unregister_for_extension(_extension: &str) -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(windows))]
pub fn run_server() -> Result<(), String> {
    Err("Windows Explorer previews are only available on Windows.".into())
}
