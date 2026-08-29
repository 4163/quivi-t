use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FormatCategory {
    Image,
    Archive,
}

impl FormatCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            FormatCategory::Image => "Image",
            FormatCategory::Archive => "Archive",
        }
    }
}

impl std::fmt::Display for FormatCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct FileFormat {
    pub ext: &'static str,
    pub name: &'static str,
    pub icon: &'static str,
    pub category: FormatCategory,
}

pub const SUPPORTED_FORMATS: &[FileFormat] = &[
    // Images
    FileFormat { ext: "jpg",  name: "JPEG Image",     icon: "quivi-t_moe-icon.ico", category: FormatCategory::Image },
    FileFormat { ext: "jpeg", name: "JPEG Image",     icon: "quivi-t_moe-icon.ico", category: FormatCategory::Image },
    FileFormat { ext: "png",  name: "PNG Image",      icon: "quivi-t_moe-icon.ico", category: FormatCategory::Image },
    FileFormat { ext: "gif",  name: "GIF Image",      icon: "gif.ico",              category: FormatCategory::Image },
    FileFormat { ext: "webp", name: "WebP Image",     icon: "webp.ico",             category: FormatCategory::Image },
    FileFormat { ext: "apng", name: "APNG Image",     icon: "apng.ico",             category: FormatCategory::Image },
    FileFormat { ext: "svg",  name: "SVG Image",      icon: "svg.ico",              category: FormatCategory::Image },
    FileFormat { ext: "bmp",  name: "BMP Image",      icon: "quivi-t_moe-icon.ico", category: FormatCategory::Image },
    FileFormat { ext: "ico",  name: "Icon Image",     icon: "quivi-t_moe-icon.ico", category: FormatCategory::Image },
    FileFormat { ext: "avif", name: "AVIF Image",     icon: "quivi-t_moe-icon.ico", category: FormatCategory::Image },
    // Archives
    FileFormat { ext: "zip",  name: "ZIP Archive",    icon: "quivi-t_moe-icon.ico", category: FormatCategory::Archive },
    FileFormat { ext: "cbz",  name: "Comic Book ZIP", icon: "cbz.ico",              category: FormatCategory::Archive },
    FileFormat { ext: "rar",  name: "RAR Archive",    icon: "quivi-t_moe-icon.ico", category: FormatCategory::Archive },
    FileFormat { ext: "cbr",  name: "Comic Book RAR", icon: "cbr.ico",              category: FormatCategory::Archive },
    FileFormat { ext: "7z",   name: "7z Archive",     icon: "quivi-t_moe-icon.ico", category: FormatCategory::Archive },
    FileFormat { ext: "cb7",  name: "Comic Book 7z",  icon: "quivi-t_moe-icon.ico", category: FormatCategory::Archive },
    FileFormat { ext: "cbt",  name: "Comic Book TAR", icon: "quivi-t_moe-icon.ico", category: FormatCategory::Archive },
    FileFormat { ext: "tar",  name: "TAR Archive",    icon: "quivi-t_moe-icon.ico", category: FormatCategory::Archive },
];

#[inline]
pub fn is_image_ext(ext: &str) -> bool {
    SUPPORTED_FORMATS.iter().any(|f| f.category == FormatCategory::Image && f.ext.eq_ignore_ascii_case(ext))
}

#[inline]
pub fn is_archive_ext(ext: &str) -> bool {
    SUPPORTED_FORMATS.iter().any(|f| f.category == FormatCategory::Archive && f.ext.eq_ignore_ascii_case(ext))
}

#[inline]
pub fn is_metadata_ext(ext: &str) -> bool {
    ext.eq_ignore_ascii_case("xml") || ext.eq_ignore_ascii_case("opf")
}

pub fn is_animated(bytes: &[u8]) -> bool {
    if bytes.len() < 8 {
        return false;
    }

    if bytes.starts_with(b"GIF8") {
        return check_gif(bytes);
    } else if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        return check_webp(bytes);
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return check_apng(bytes);
    } else if bytes.windows(4).any(|w| w == b"<svg") {
        return check_svg(bytes);
    }

    false
}

fn check_gif(bytes: &[u8]) -> bool {
    // NETSCAPE2.0 looping block is within first ~1 KiB; bound scan to 2 KiB header.
    // Note: A single-frame GIF with a NETSCAPE loop extension is treated as animated
    // which is an acceptable false-positive per spec. The alternative would require a full frame-count parse.
    let end = bytes.len().min(2048);
    bytes[..end].windows(14).any(|w| w == b"\x21\xFF\x0BNETSCAPE2.0")
}

fn check_webp(bytes: &[u8]) -> bool {
    if let Some(pos) = bytes.windows(4).position(|w| w == b"VP8X") {
        if pos + 8 < bytes.len() {
            let flags = bytes[pos + 8];
            return (flags & 0b0000_0010) != 0;
        }
    }
    false
}

fn check_apng(bytes: &[u8]) -> bool {
    let actl_pos = bytes.windows(4).position(|w| w == b"acTL");
    let idat_pos = bytes.windows(4).position(|w| w == b"IDAT");

    match (actl_pos, idat_pos) {
        (Some(a), Some(i)) => a < i,
        (Some(_), None) => true,
        _ => false,
    }
}

fn check_svg(bytes: &[u8]) -> bool {
    bytes.windows(8).any(|w| w == b"<animate")
        || bytes.windows(4).any(|w| w == b"<set")
        || bytes.windows(16).any(|w| w == b"animateTransform")
}
