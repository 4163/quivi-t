use serde::{Deserialize, Serialize};
use crate::models::AnimationInfo;


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

pub fn check_animation_status(bytes: &[u8]) -> AnimationInfo {
    if bytes.len() < 8 {
        return AnimationInfo { is_animated: false, no_loop: false };
    }

    if bytes.starts_with(b"GIF8") {
        return check_gif(bytes);
    } else if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        return AnimationInfo { is_animated: check_webp(bytes), no_loop: false };
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return AnimationInfo { is_animated: check_apng(bytes), no_loop: false };
    } else if bytes.windows(4).any(|w| w == b"<svg") {
        return AnimationInfo { is_animated: check_svg(bytes), no_loop: false };
    }

    AnimationInfo { is_animated: false, no_loop: false }
}

fn check_gif(bytes: &[u8]) -> AnimationInfo {
    if bytes.len() < 13 || !bytes.starts_with(b"GIF") {
        return AnimationInfo { is_animated: false, no_loop: false };
    }

    let mut pos = 13;
    let flags = bytes[10];
    if (flags & 0x80) != 0 {
        let gct_size = 2_usize.pow((flags & 0x07) as u32 + 1);
        pos += 3 * gct_size;
    }

    let mut frame_count: u32 = 0;
    let mut loop_count: Option<u16> = None;
    let scan_limit = bytes.len().min(262_144); // 256 KiB

    while pos < scan_limit {
        let block_type = bytes[pos];
        if block_type == 0x2C {
            frame_count += 1;
            // Early exit: we know it's animated and already found loop status
            if frame_count > 1 && loop_count.is_some() {
                break;
            }
            pos += 1;
            if pos + 9 > bytes.len() { break; }
            let lct_flags = bytes[pos + 8];
            pos += 9;
            if (lct_flags & 0x80) != 0 {
                let lct_size = 2_usize.pow((lct_flags & 0x07) as u32 + 1);
                pos += 3 * lct_size;
            }
            if pos < bytes.len() {
                pos += 1; // LZW code size
                while pos < bytes.len() {
                    let block_size = bytes[pos] as usize;
                    pos += 1;
                    if block_size == 0 { break; }
                    pos += block_size;
                }
            }
        } else if block_type == 0x21 {
            pos += 1;
            if pos < bytes.len() {
                let ext_label = bytes[pos];
                pos += 1;
                if ext_label == 0xFF {
                    if pos + 12 <= bytes.len() && &bytes[pos..pos+12] == b"\x0BNETSCAPE2.0" {
                        if pos + 16 <= bytes.len() && bytes[pos + 12] == 0x03 && bytes[pos + 13] == 0x01 {
                            loop_count = Some(u16::from_le_bytes([bytes[pos + 14], bytes[pos + 15]]));
                        } else {
                            loop_count = Some(0);
                        }
                    }
                }
                while pos < bytes.len() {
                    let block_size = bytes[pos] as usize;
                    pos += 1;
                    if block_size == 0 { break; }
                    pos += block_size;
                }
            }
        } else if block_type == 0x3B {
            break;
        } else {
            break;
        }
    }

    let is_animated = frame_count > 1 || loop_count.is_some();
    // no_loop only meaningful for animated content.
    // loop_count 0 = infinite, 1+ = finite, None = no NETSCAPE block = play once.
    let no_loop = is_animated && loop_count.unwrap_or(1) != 0;

    AnimationInfo { is_animated, no_loop }
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
    // <animate matches <animate, <animateMotion, and <animateTransform
    bytes.windows(8).any(|w| w == b"<animate")
        || bytes.windows(5).any(|w| w == b"<set " || w == b"<set>")
        || bytes.windows(6).any(|w| w == b"<set\t\n" || w == b"<set\r\n") // Just in case, though <set > is enough usually
}
