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
    FileFormat { ext: "jpg",  name: "JPEG Image",     icon: "jpg.ico",  category: FormatCategory::Image },
    FileFormat { ext: "jpeg", name: "JPEG Image",     icon: "jpeg.ico", category: FormatCategory::Image },
    FileFormat { ext: "png",  name: "PNG Image",      icon: "png.ico",  category: FormatCategory::Image },
    FileFormat { ext: "gif",  name: "GIF Image",      icon: "gif.ico",  category: FormatCategory::Image },
    FileFormat { ext: "webp", name: "WebP Image",     icon: "webp.ico", category: FormatCategory::Image },
    FileFormat { ext: "apng", name: "APNG Image",     icon: "apng.ico", category: FormatCategory::Image },
    FileFormat { ext: "svg",  name: "SVG Image",      icon: "svg.ico",  category: FormatCategory::Image },
    FileFormat { ext: "bmp",  name: "BMP Image",      icon: "bmp.ico",  category: FormatCategory::Image },
    FileFormat { ext: "ico",  name: "Icon Image",     icon: "ico.ico",  category: FormatCategory::Image },
    FileFormat { ext: "avif", name: "AVIF Image",     icon: "avif.ico", category: FormatCategory::Image },
    // Archives
    FileFormat { ext: "zip",  name: "ZIP Archive",    icon: "zip.ico",  category: FormatCategory::Archive },
    FileFormat { ext: "cbz",  name: "Comic Book ZIP", icon: "cbz.ico",  category: FormatCategory::Archive },
    FileFormat { ext: "rar",  name: "RAR Archive",    icon: "rar.ico",  category: FormatCategory::Archive },
    FileFormat { ext: "cbr",  name: "Comic Book RAR", icon: "cbr.ico",  category: FormatCategory::Archive },
    FileFormat { ext: "7z",   name: "7z Archive",     icon: "7z.ico",   category: FormatCategory::Archive },
    FileFormat { ext: "cb7",  name: "Comic Book 7z",  icon: "cb7.ico",  category: FormatCategory::Archive },
    FileFormat { ext: "cbt",  name: "Comic Book TAR", icon: "cbt.ico",  category: FormatCategory::Archive },
    FileFormat { ext: "tar",  name: "TAR Archive",    icon: "tar.ico",  category: FormatCategory::Archive },
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
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return AnimationInfo { is_animated: check_avif(bytes), no_loop: false };
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

fn be_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    bytes.get(offset..offset + 4)?.try_into().ok().map(u32::from_be_bytes)
}

/// Next ISO BMFF box at `pos`: (total size, header length, type).
fn isobmff_box(bytes: &[u8], pos: usize) -> Option<(usize, usize, [u8; 4])> {
    let size32 = be_u32(bytes, pos)? as usize;
    let typ: [u8; 4] = bytes.get(pos + 4..pos + 8)?.try_into().ok()?;
    if size32 == 1 {
        let hi = be_u32(bytes, pos + 8)? as u64;
        let lo = be_u32(bytes, pos + 12)? as u64;
        let size = ((hi << 32) | lo) as usize;
        if size < 16 {
            return None;
        }
        Some((size, 16, typ))
    } else if size32 == 0 {
        Some((bytes.len() - pos, 8, typ))
    } else if size32 < 8 {
        None
    } else {
        Some((size32, 8, typ))
    }
}

fn is_avif_family_brand(brand: &[u8]) -> bool {
    brand == b"avif" || brand == b"avis" || brand == b"mif1" || brand == b"miaf"
}

/// Animated AVIF is still a `.avif` file. Two in-file signals, either is enough:
/// `avis` in `ftyp` (the spec brand for a sequence) or a top-level `moov`
/// (the movie timeline) on an AVIF-family file. Still AVIF is `avif` without
/// `avis` and without `moov`. Walk boxes; do not scan payload bytes for the
/// four-character codes.
fn check_avif(bytes: &[u8]) -> bool {
    let mut pos = 0;
    let mut avis = false;
    let mut avif_family = false;
    let mut has_moov = false;

    while pos + 8 <= bytes.len() {
        let Some((size, header, typ)) = isobmff_box(bytes, pos) else {
            break;
        };
        if size < header || pos.checked_add(size).is_none() {
            break;
        }
        let box_end = (pos + size).min(bytes.len());

        if &typ == b"ftyp" {
            let payload = pos + header;
            if payload + 4 <= box_end {
                let major = &bytes[payload..payload + 4];
                avis |= major == b"avis";
                avif_family |= is_avif_family_brand(major);
                let mut i = payload + 8;
                while i + 4 <= box_end {
                    let brand = &bytes[i..i + 4];
                    avis |= brand == b"avis";
                    avif_family |= is_avif_family_brand(brand);
                    i += 4;
                }
            }
            if avis {
                return true;
            }
        } else if &typ == b"moov" {
            has_moov = true;
            if avif_family {
                return true;
            }
        }

        if pos + size > bytes.len() {
            break;
        }
        pos += size;
    }

    avis || (avif_family && has_moov)
}

fn check_svg(bytes: &[u8]) -> bool {
    // <animate matches <animate, <animateMotion, and <animateTransform
    bytes.windows(8).any(|w| w == b"<animate")
        || bytes.windows(5).any(|w| w == b"<set " || w == b"<set>")
        || bytes.windows(6).any(|w| w == b"<set\t\n" || w == b"<set\r\n") // Just in case, though <set > is enough usually
}
