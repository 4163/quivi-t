// ── Supported formats ────────────────────────────────────────────────────────
use serde::{Serialize, Deserialize};
use std::path::Path;

// ── Windows Hidden Attribute ─────────────────────────────────────────────────

/// Set or clear the Windows FILE_ATTRIBUTE_HIDDEN flag on a file.
/// Returns Ok(()) on success or if not on Windows.
#[cfg(windows)]
pub fn set_hidden_attribute(path: &Path, hidden: bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::ffi::OsStr;

    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;

    // Convert path to wide string for Windows API
    let wide_path: Vec<u16> = OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        // Get current attributes
        let attrs = windows::Win32::Storage::FileSystem::GetFileAttributesW(
            windows::core::PCWSTR(wide_path.as_ptr())
        );

        if attrs == windows::Win32::Storage::FileSystem::INVALID_FILE_ATTRIBUTES {
            return Err(format!("Failed to get file attributes for {:?}", path));
        }

        // Set or clear the hidden bit
        let new_attrs = if hidden {
            attrs | FILE_ATTRIBUTE_HIDDEN
        } else {
            attrs & !FILE_ATTRIBUTE_HIDDEN
        };

        // Apply new attributes
        let result = windows::Win32::Storage::FileSystem::SetFileAttributesW(
            windows::core::PCWSTR(wide_path.as_ptr()),
            windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(new_attrs)
        );

        if result.is_err() {
            return Err(format!("Failed to set file attributes for {:?}", path));
        }
    }

    Ok(())
}

#[cfg(not(windows))]
pub fn set_hidden_attribute(_path: &Path, _hidden: bool) -> Result<(), String> {
    // No-op on non-Windows platforms
    Ok(())
}

// ── Supported formats ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileFormat {
    pub ext: &'static str,
    pub name: &'static str,
    pub icon: &'static str,
    pub category: &'static str,
}

macro_rules! image {
    ($ext:expr, $name:expr, $icon:expr) => {
        FileFormat { ext: $ext, name: $name, icon: $icon, category: "Image" }
    };
}
macro_rules! archive {
    ($ext:expr, $name:expr, $icon:expr) => {
        FileFormat { ext: $ext, name: $name, icon: $icon, category: "Archive" }
    };
}

pub const SUPPORTED_FORMATS: &[FileFormat] = &[
    // Images
    image!("jpg",  "JPEG Image", "quivi-t_moe-icon.ico"),
    image!("jpeg", "JPEG Image", "quivi-t_moe-icon.ico"),
    image!("png",  "PNG Image", "quivi-t_moe-icon.ico"),
    image!("gif",  "GIF Image", "gif.ico"),
    image!("webp", "WebP Image", "webp.ico"),
    image!("apng", "APNG Image", "apng.ico"),
    image!("svg",  "SVG Image", "svg.ico"),
    image!("bmp",  "BMP Image", "quivi-t_moe-icon.ico"),
    image!("ico",  "Icon Image", "quivi-t_moe-icon.ico"),
    image!("avif", "AVIF Image", "quivi-t_moe-icon.ico"),
    // Archives
    archive!("zip", "ZIP Archive", "quivi-t_moe-icon.ico"),
    archive!("cbz", "Comic Book ZIP", "cbz.ico"),
    archive!("rar", "RAR Archive", "quivi-t_moe-icon.ico"),
    archive!("cbr", "Comic Book RAR", "cbr.ico"),
    archive!("7z",  "7z Archive", "quivi-t_moe-icon.ico"),
    archive!("cb7", "Comic Book 7z", "quivi-t_moe-icon.ico"),
    archive!("cbt", "Comic Book TAR", "quivi-t_moe-icon.ico"),
    archive!("tar", "TAR Archive", "quivi-t_moe-icon.ico"),
];

pub fn is_image_ext(ext: &str) -> bool {
    let lower = ext.to_lowercase();
    SUPPORTED_FORMATS.iter().any(|f| f.category == "Image" && f.ext == lower)
}

pub fn is_metadata_ext(ext: &str) -> bool {
    let lower = ext.to_lowercase();
    matches!(lower.as_str(), "xml" | "opf")
}

pub fn is_archive_ext(ext: &str) -> bool {
    let lower = ext.to_lowercase();
    SUPPORTED_FORMATS.iter().any(|f| f.category == "Archive" && f.ext == lower)
}
