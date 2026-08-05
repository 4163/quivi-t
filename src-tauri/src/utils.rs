// ── Supported formats ────────────────────────────────────────────────────────

pub const SUPPORTED_IMAGES: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "apng", "svg", "bmp", "ico", "avif",
];

pub const SUPPORTED_ARCHIVES: &[&str] = &["zip", "cbz", "rar", "cbr", "7z", "cb7", "cbt", "tar"];

pub fn is_image_ext(ext: &str) -> bool {
    SUPPORTED_IMAGES.contains(&ext.to_lowercase().as_str())
}

pub fn is_archive_ext(ext: &str) -> bool {
    SUPPORTED_ARCHIVES.contains(&ext.to_lowercase().as_str())
}
