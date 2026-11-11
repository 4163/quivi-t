use std::fs::{self, File, OpenOptions};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use super::guards::{ensure_library_root_writable, is_reparse_point, same_path};

#[cfg(windows)]
pub const PUBLICATION_MUTEX: &str = "Local\\QuiviT.LibraryPublication";

#[derive(Debug)]
pub enum CapturePublishError {
    Retryable(String),
    Failed(String),
}

impl CapturePublishError {
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::Retryable(_))
    }
}

impl From<String> for CapturePublishError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<&str> for CapturePublishError {
    fn from(message: &str) -> Self {
        Self::Failed(message.into())
    }
}

impl std::fmt::Display for CapturePublishError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Retryable(message) | Self::Failed(message) => f.write_str(message),
        }
    }
}

pub fn publish_captured_image(
    image: &crate::image_import::PreparedImage,
    cancelled: &AtomicBool,
) -> Result<String, CapturePublishError> {
    #[cfg(windows)]
    let _publication = crate::platform::process::ProcessLock::acquire(PUBLICATION_MUTEX)?;
    let root = crate::config::configured_library_dir()?;
    ensure_library_root_writable(&root).map_err(CapturePublishError::Retryable)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    if is_reparse_point(&root)? {
        return Err("The Library cannot be a reparse point".into());
    }
    if !same_path(&root, &crate::config::configured_library_dir()?) {
        return Err(CapturePublishError::Retryable(
            "Library location changed while saving the dropped image".into(),
        ));
    }
    let misc = root.join("Misc");
    if misc.exists() && is_reparse_point(&misc)? {
        return Err("Misc cannot be a reparse point".into());
    }
    fs::create_dir_all(&misc).map_err(|e| e.to_string())?;
    let dest = misc.join(&image.filename);
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let pending = misc.join(format!(
        ".{}.{}.{nonce}.tmp",
        image.filename,
        std::process::id()
    ));
    if cancelled.load(Ordering::SeqCst) {
        return Err("Drop cancelled".into());
    }
    if dest.exists() {
        if is_reparse_point(&dest)?
            || crate::image_import::file_hash(&dest)?
                != crate::image_import::file_hash(&image.path)?
        {
            return Err("A different file already exists at the capture destination".into());
        }
        return Ok(dest.to_string_lossy().into_owned());
    }
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|e| e.to_string())?;
        let mut input = File::open(&image.path).map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        if cancelled.load(Ordering::SeqCst) {
            return Err("Drop cancelled".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            let source: Vec<u16> = pending.as_os_str().encode_wide().chain(Some(0)).collect();
            let target: Vec<u16> = dest.as_os_str().encode_wide().chain(Some(0)).collect();
            // MoveFileW refuses replacement and also works on FAT/exFAT Libraries.
            unsafe {
                windows::Win32::Storage::FileSystem::MoveFileW(
                    windows::core::PCWSTR(source.as_ptr()),
                    windows::core::PCWSTR(target.as_ptr()),
                )
            }
            .map_err(|e| format!("Failed to publish dropped image: {e}"))?;
        }
        #[cfg(not(windows))]
        fs::hard_link(&pending, &dest)
            .map_err(|e| format!("Failed to publish dropped image: {e}"))?;
        Ok(dest.to_string_lossy().into_owned())
    })();
    let _ = fs::remove_file(&pending);
    result.map_err(CapturePublishError::Failed)
}

pub fn save_captured_image(
    image: &crate::image_import::PreparedImage,
    cancelled: &AtomicBool,
) -> Result<String, String> {
    const LIBRARY_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(150);
    publish_captured_image(image, cancelled)
        .or_else(|error| {
            if !error.is_retryable() {
                return Err(error);
            }
            std::thread::sleep(LIBRARY_RETRY_DELAY);
            publish_captured_image(image, cancelled)
        })
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn cleanup_capture_staging(misc: &Path) {
    let Ok(entries) = fs::read_dir(misc) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(body) = name
            .strip_prefix(".drop-")
            .and_then(|s| s.strip_suffix(".tmp"))
        else {
            continue;
        };
        let parts: Vec<_> = body.split('.').collect();
        if !(3..=4).contains(&parts.len())
            || parts[0].len() != 64
            || !parts[0].bytes().all(|byte| byte.is_ascii_hexdigit())
            || !matches!(
                parts[1],
                "png" | "jpg" | "gif" | "webp" | "bmp" | "ico" | "avif" | "svg"
            )
            || (parts.len() == 4 && parts[3].parse::<u128>().is_err())
        {
            continue;
        }
        let Ok(pid) = parts[2].parse::<u32>() else {
            continue;
        };
        if pid != std::process::id() && !crate::platform::process::is_running(pid) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(windows)]
pub fn cleanup_abandoned_captures() -> Result<(), String> {
    let _publication = crate::platform::process::ProcessLock::acquire(PUBLICATION_MUTEX)?;
    let root = crate::config::configured_library_dir()?;
    let misc = root.join("Misc");
    if root.is_dir() && !is_reparse_point(&root)? && misc.is_dir() && !is_reparse_point(&misc)? {
        cleanup_capture_staging(&misc);
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn cleanup_abandoned_captures() -> Result<(), String> {
    Ok(())
}
