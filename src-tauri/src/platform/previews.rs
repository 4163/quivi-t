//! Windows Explorer previews integration.
//!
//! Explorer launches the staged helper at `%LOCALAPPDATA%\QuiviT\bin\`
//! with `--previews-pane` as a COM local server. Keeping this out of the
//! Tauri process gives the shell a small, read-only surface that cannot
//! affect the main viewer window.

#[cfg(windows)]
pub(crate) mod windows;

pub(crate) mod contract;
pub mod host;
#[cfg(windows)]
mod thumb_decoders;
#[cfg(windows)]
mod avif_sequence;

#[cfg(windows)]
pub use windows::{
    log_event, register_for_extensions_with_host, run_server,
    run_thumbnail_server,
    unregister_for_extensions, PREVIEW_HANDLER_CATEGORY, PREVIEW_HANDLER_CLSID_TEXT,
    detect_svg_shell_handlers, preserve_svg_handlers, has_foreign_progid_handlers,
    supports_extension, has_thumbnail, IMAGE_PREVIEW_CLSID_TEXT, IMAGE_THUMBNAIL_CLSID_TEXT,
    THUMBNAIL_CATEGORY,
};

pub use host::{
    ensure_previews_host, resolve_previews_host_path, PREVIEW_HOST_VERSION,
};

#[cfg(not(windows))]
pub fn unregister_for_extensions(_extensions: &[String]) -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(windows))]
pub fn run_server() -> Result<(), String> {
    Err("Windows Explorer previews are only available on Windows.".into())
}

#[cfg(not(windows))]
pub fn run_thumbnail_server() -> Result<(), String> {
    Err("Windows Explorer thumbnails are only available on Windows.".into())
}
