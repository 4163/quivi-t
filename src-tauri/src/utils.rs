// ── Supported formats ────────────────────────────────────────────────────────
use serde::{Serialize, Deserialize};

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

pub fn is_archive_ext(ext: &str) -> bool {
    let lower = ext.to_lowercase();
    SUPPORTED_FORMATS.iter().any(|f| f.category == "Archive" && f.ext == lower)
}
