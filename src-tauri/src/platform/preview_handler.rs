//! Windows Explorer preview integration.
//!
//! Explorer launches the normal QuiviT executable with `--preview-handler` as a
//! COM local server. Keeping this out of the Tauri process gives the shell a
//! small, read-only surface that cannot affect the main viewer window.

#[cfg(windows)]
pub(crate) mod windows;

#[cfg(windows)]
pub use windows::{
    log_event, register_for_extension, run_server, unregister_for_extension,
    PREVIEW_HANDLER_CATEGORY, PREVIEW_HANDLER_CLSID_TEXT,
};

#[cfg(not(windows))]
pub fn register_for_extension(_extension: &str, _exe_path: &std::path::Path) -> Result<bool, String> {
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
