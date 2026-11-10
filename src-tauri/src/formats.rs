use std::io::{Read, Seek, SeekFrom};

use crate::models::AnimationInfo;
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
    FileFormat {
        ext: "jpg",
        name: "JPEG Image",
        icon: "jpg.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "jpeg",
        name: "JPEG Image",
        icon: "jpeg.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "png",
        name: "PNG Image",
        icon: "png.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "gif",
        name: "GIF Image",
        icon: "gif.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "webp",
        name: "WebP Image",
        icon: "webp.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "apng",
        name: "APNG Image",
        icon: "apng.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "svg",
        name: "SVG Image",
        icon: "svg.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "bmp",
        name: "BMP Image",
        icon: "bmp.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "dib",
        name: "BMP Image",
        icon: "dib.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "ico",
        name: "Icon Image",
        icon: "ico.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "avif",
        name: "AVIF Image",
        icon: "avif.ico",
        category: FormatCategory::Image,
    },
    // Archives
    FileFormat {
        ext: "zip",
        name: "ZIP Archive",
        icon: "zip.ico",
        category: FormatCategory::Archive,
    },
    FileFormat {
        ext: "cbz",
        name: "Comic Book ZIP",
        icon: "cbz.ico",
        category: FormatCategory::Archive,
    },
    FileFormat {
        ext: "rar",
        name: "RAR Archive",
        icon: "rar.ico",
        category: FormatCategory::Archive,
    },
    FileFormat {
        ext: "cbr",
        name: "Comic Book RAR",
        icon: "cbr.ico",
        category: FormatCategory::Archive,
    },
    FileFormat {
        ext: "7z",
        name: "7z Archive",
        icon: "7z.ico",
        category: FormatCategory::Archive,
    },
    FileFormat {
        ext: "cb7",
        name: "Comic Book 7z",
        icon: "cb7.ico",
        category: FormatCategory::Archive,
    },
    FileFormat {
        ext: "cbt",
        name: "Comic Book TAR",
        icon: "cbt.ico",
        category: FormatCategory::Archive,
    },
    FileFormat {
        ext: "tar",
        name: "TAR Archive",
        icon: "tar.ico",
        category: FormatCategory::Archive,
    },
];

pub(crate) const FORMAT_ICONS: &[(&str, &[u8])] = &[
    ("7z.ico", include_bytes!("../../icons/formats/7z.ico")),
    (
        "apng.ico",
        include_bytes!("../../icons/formats/apng.ico"),
    ),
    (
        "avif.ico",
        include_bytes!("../../icons/formats/avif.ico"),
    ),
    ("bmp.ico", include_bytes!("../../icons/formats/bmp.ico")),
    ("cb7.ico", include_bytes!("../../icons/formats/cb7.ico")),
    ("cbr.ico", include_bytes!("../../icons/formats/cbr.ico")),
    ("cbt.ico", include_bytes!("../../icons/formats/cbt.ico")),
    ("cbz.ico", include_bytes!("../../icons/formats/cbz.ico")),
    ("dib.ico", include_bytes!("../../icons/formats/dib.ico")),
    ("gif.ico", include_bytes!("../../icons/formats/gif.ico")),
    ("ico.ico", include_bytes!("../../icons/formats/ico.ico")),
    (
        "jpeg.ico",
        include_bytes!("../../icons/formats/jpeg.ico"),
    ),
    ("jpg.ico", include_bytes!("../../icons/formats/jpg.ico")),
    ("png.ico", include_bytes!("../../icons/formats/png.ico")),
    ("rar.ico", include_bytes!("../../icons/formats/rar.ico")),
    ("svg.ico", include_bytes!("../../icons/formats/svg.ico")),
    ("tar.ico", include_bytes!("../../icons/formats/tar.ico")),
    (
        "webp.ico",
        include_bytes!("../../icons/formats/webp.ico"),
    ),
    ("zip.ico", include_bytes!("../../icons/formats/zip.ico")),
];

#[inline]
pub fn is_image_ext(ext: &str) -> bool {
    SUPPORTED_FORMATS
        .iter()
        .any(|f| f.category == FormatCategory::Image && f.ext.eq_ignore_ascii_case(ext))
}

#[inline]
pub fn is_archive_ext(ext: &str) -> bool {
    SUPPORTED_FORMATS
        .iter()
        .any(|f| f.category == FormatCategory::Archive && f.ext.eq_ignore_ascii_case(ext))
}

#[inline]
pub fn is_metadata_ext(ext: &str) -> bool {
    ext.eq_ignore_ascii_case("xml") || ext.eq_ignore_ascii_case("opf")
}

pub const ARCHIVE_EXTENSIONS: &[&str] = &["zip", "cbz", "rar", "cbr", "7z", "cb7", "tar", "cbt"];

pub const ARCHIVE_SLASH_EXTS: &[&str] = &[
    ".zip\\", ".cbz\\", ".rar\\", ".cbr\\", ".7z\\", ".cb7\\", ".tar\\", ".cbt\\",
    ".zip/", ".cbz/", ".rar/", ".cbr/", ".7z/", ".cb7/", ".tar/", ".cbt/",
];

pub const ARCHIVE_DOT_EXTS: &[&str] = &[
    ".zip", ".cbz", ".rar", ".cbr", ".7z", ".cb7", ".tar", ".cbt",
];

#[inline]
pub fn is_shell_thumb_supported(ext: &str) -> bool {
    is_image_ext(ext) || ext.eq_ignore_ascii_case("mp4")
}

pub fn guess_mime(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("");
    if ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg") {
        "image/jpeg"
    } else if ext.eq_ignore_ascii_case("png") {
        "image/png"
    } else if ext.eq_ignore_ascii_case("gif") {
        "image/gif"
    } else if ext.eq_ignore_ascii_case("webp") {
        "image/webp"
    } else if ext.eq_ignore_ascii_case("svg") {
        "image/svg+xml"
    } else if ext.eq_ignore_ascii_case("bmp") || ext.eq_ignore_ascii_case("dib") {
        "image/bmp"
    } else if ext.eq_ignore_ascii_case("ico") {
        "image/x-icon"
    } else if ext.eq_ignore_ascii_case("avif") {
        "image/avif"
    } else if ext.eq_ignore_ascii_case("apng") {
        "image/apng"
    } else if ext.eq_ignore_ascii_case("mp4") {
        "video/mp4"
    } else {
        "application/octet-stream"
    }
}

pub fn check_image_magic_head(head: &[u8], expected_ext: &str) -> bool {
    let ext = expected_ext.trim_start_matches('.').to_ascii_lowercase();
    let enough = |n: usize| head.len() >= n;
    match ext.as_str() {
        "png" | "apng" => enough(8) && head[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
        "jpg" | "jpeg" => enough(2) && head[..2] == [0xFF, 0xD8],
        "gif" => enough(6) && (head[..6] == *b"GIF87a" || head[..6] == *b"GIF89a"),
        "bmp" | "dib" => enough(2) && head[..2] == *b"BM",
        "webp" => enough(12) && head[..4] == *b"RIFF" && head[8..12] == *b"WEBP",
        "avif" => enough(12) && head[4..8] == *b"ftyp",
        _ => true,
    }
}

pub fn check_animation_status(bytes: &[u8]) -> AnimationInfo {
    if bytes.len() < 8 {
        return AnimationInfo {
            is_animated: false,
            loop_count: 0,
        };
    }

    if bytes.starts_with(b"GIF8") {
        return check_gif(bytes);
    } else if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        return check_webp(bytes);
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return check_apng(bytes);
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return check_avif(bytes);
    } else if bytes.windows(4).any(|w| w == b"<svg") {
        return AnimationInfo {
            is_animated: check_svg(bytes),
            loop_count: 0,
        };
    }

    AnimationInfo {
        is_animated: false,
        loop_count: 0,
    }
}

fn check_gif(bytes: &[u8]) -> AnimationInfo {
    if bytes.len() < 13 || !bytes.starts_with(b"GIF") {
        return AnimationInfo {
            is_animated: false,
            loop_count: 0,
        };
    }

    let mut pos = 13;
    let flags = bytes[10];
    if (flags & 0x80) != 0 {
        let gct_size = 2_usize.pow((flags & 0x07) as u32 + 1);
        pos += 3 * gct_size;
    }

    let mut frame_count: u32 = 0;
    let mut parsed_loop_count: Option<u16> = None;
    let scan_limit = bytes.len().min(262_144); // 256 KiB

    while pos < scan_limit {
        let block_type = bytes[pos];
        if block_type == 0x2C {
            frame_count += 1;
            // Early exit: we know it's animated and already found loop status
            if frame_count > 1 && parsed_loop_count.is_some() {
                break;
            }
            pos += 1;
            if pos + 9 > bytes.len() {
                break;
            }
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
                    if block_size == 0 {
                        break;
                    }
                    pos += block_size;
                }
            }
        } else if block_type == 0x21 {
            pos += 1;
            if pos < bytes.len() {
                let ext_label = bytes[pos];
                pos += 1;
                if ext_label == 0xFF {
                    if pos + 12 <= bytes.len() && &bytes[pos..pos + 12] == b"\x0BNETSCAPE2.0" {
                        if pos + 16 <= bytes.len()
                            && bytes[pos + 12] == 0x03
                            && bytes[pos + 13] == 0x01
                        {
                            parsed_loop_count =
                                Some(u16::from_le_bytes([bytes[pos + 14], bytes[pos + 15]]));
                        } else {
                            parsed_loop_count = Some(0);
                        }
                    }
                }
                while pos < bytes.len() {
                    let block_size = bytes[pos] as usize;
                    pos += 1;
                    if block_size == 0 {
                        break;
                    }
                    pos += block_size;
                }
            }
        } else if block_type == 0x3B {
            break;
        } else {
            break;
        }
    }

    let is_animated = frame_count > 1 || parsed_loop_count.is_some();

    // Normalize GIF loop count to total_plays
    let loop_count = if is_animated {
        match parsed_loop_count {
            None => 1,                 // No NETSCAPE block = play once
            Some(0) => 0,              // 0 = infinite
            Some(n) => (n as u32) + 1, // Native plays N + 1 times
        }
    } else {
        0
    };

    AnimationInfo {
        is_animated,
        loop_count,
    }
}

fn check_webp(bytes: &[u8]) -> AnimationInfo {
    if let Some(pos) = bytes.windows(4).position(|w| w == b"VP8X") {
        if pos + 8 < bytes.len() {
            let flags = bytes[pos + 8];
            let is_animated = (flags & 0b0000_0010) != 0;
            if is_animated {
                if let Some(anim_pos) = bytes.windows(4).position(|w| w == b"ANIM") {
                    if anim_pos + 14 <= bytes.len() {
                        let parsed_loop_count =
                            u16::from_le_bytes([bytes[anim_pos + 12], bytes[anim_pos + 13]]);
                        let loop_count = if parsed_loop_count == 0 {
                            0
                        } else {
                            (parsed_loop_count as u32) + 1
                        };
                        return AnimationInfo {
                            is_animated,
                            loop_count,
                        };
                    }
                }
                return AnimationInfo {
                    is_animated,
                    loop_count: 0,
                };
            }
        }
    }
    AnimationInfo {
        is_animated: false,
        loop_count: 0,
    }
}

fn check_apng(bytes: &[u8]) -> AnimationInfo {
    let actl_pos = bytes.windows(4).position(|w| w == b"acTL");
    let idat_pos = bytes.windows(4).position(|w| w == b"IDAT");

    match (actl_pos, idat_pos) {
        (Some(a), Some(i)) if a < i => {
            let mut loop_count = 0;
            if a + 12 <= bytes.len() {
                if let Ok(num_plays) = bytes[a + 8..a + 12].try_into() {
                    loop_count = u32::from_be_bytes(num_plays);
                }
            }
            AnimationInfo {
                is_animated: true,
                loop_count,
            }
        }
        (Some(_), None) => AnimationInfo {
            is_animated: true,
            loop_count: 0,
        },
        _ => AnimationInfo {
            is_animated: false,
            loop_count: 0,
        },
    }
}

fn be_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    bytes
        .get(offset..offset + 4)?
        .try_into()
        .ok()
        .map(u32::from_be_bytes)
}

/// Next ISO BMFF box at `pos`: (total size, header length, type).
pub(crate) fn isobmff_box(bytes: &[u8], pos: usize) -> Option<(usize, usize, [u8; 4])> {
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
fn contains_elst(bytes: &[u8], start: usize, end: usize) -> bool {
    let mut pos = start;
    while pos + 8 <= end {
        let Some((size, header, typ)) = isobmff_box(bytes, pos) else {
            break;
        };
        if size < header || pos.checked_add(size).is_none() {
            break;
        }
        let box_end = (pos + size).min(end);

        if &typ == b"elst" {
            return true;
        } else if &typ == b"moov" || &typ == b"trak" || &typ == b"edts" {
            if contains_elst(bytes, pos + header, box_end) {
                return true;
            }
        }

        if pos + size > end {
            break;
        }
        pos += size;
    }
    false
}

fn check_avif(bytes: &[u8]) -> AnimationInfo {
    let mut pos = 0;
    let mut avis = false;
    let mut avif_family = false;
    let mut has_moov = false;
    let mut has_elst = false;

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
        } else if &typ == b"moov" {
            has_moov = true;
            if contains_elst(bytes, pos + header, box_end) {
                has_elst = true;
            }
        }

        if pos + size > bytes.len() {
            break;
        }
        pos += size;
    }

    let is_animated = avis || (avif_family && has_moov);
    let loop_count = if is_animated && has_elst { 1 } else { 0 };

    AnimationInfo {
        is_animated,
        loop_count,
    }
}

fn check_svg(bytes: &[u8]) -> bool {
    // <animate matches <animate, <animateMotion, and <animateTransform
    bytes.windows(8).any(|w| w == b"<animate")
        || bytes.windows(5).any(|w| w == b"<set " || w == b"<set>")
        || bytes
            .windows(6)
            .any(|w| w == b"<set\t\n" || w == b"<set\r\n") // Just in case, though <set > is enough usually
}

/// Checks if an MP4 file or stream contains an audio track.
/// Scans the top-level ISOBMFF boxes for `moov`, then checks if `moov`
/// contains sound stream markers (`soun` handler or `smhd` sound media header).
pub fn check_mp4_has_audio<R: Read + Seek>(reader: &mut R) -> bool {
    let mut header = [0u8; 8];
    while reader.read_exact(&mut header).is_ok() {
        let size32 = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
        let typ = &header[4..8];

        let (box_size, header_len) = if size32 == 1 {
            let mut s64 = [0u8; 8];
            if reader.read_exact(&mut s64).is_err() {
                return false;
            }
            (u64::from_be_bytes(s64), 16u64)
        } else if size32 == 0 {
            (0, 8u64)
        } else {
            (size32, 8u64)
        };

        if typ == b"moov" {
            let read_len = if box_size > header_len {
                ((box_size - header_len) as usize).min(10 * 1024 * 1024)
            } else {
                10 * 1024 * 1024
            };
            let mut moov_buf = vec![0u8; read_len];
            let n = reader.read(&mut moov_buf).unwrap_or(0);
            let moov_bytes = &moov_buf[..n];
            return moov_bytes.windows(4).any(|w| w == b"soun" || w == b"smhd");
        }

        if box_size == 0 || box_size < header_len {
            break;
        }
        if reader.seek(SeekFrom::Current((box_size - header_len) as i64)).is_err() {
            break;
        }
    }
    false
}

/// Header-only dimension probe from a byte slice. Uses the image crate's
/// fast path: it parses the format header without decoding pixel data.
/// Returns None for formats the crate cannot probe (SVG, unsupported AVIF).
pub fn read_dimensions_from_bytes(bytes: &[u8]) -> Option<(u32, u32)> {
    use std::io::{BufReader, Cursor};
    let cursor = Cursor::new(bytes);
    let reader = image::ImageReader::new(BufReader::new(cursor))
        .with_guessed_format()
        .ok()?;
    reader.into_dimensions().ok()
}

/// Read video track dimensions from an MP4/ISOBMFF container. Walks the
/// top-level boxes to find moov, then parses trak/tkhd for width and height.
pub fn read_mp4_dimensions<R: Read + Seek>(reader: &mut R) -> Option<(u32, u32)> {
    let mut header = [0u8; 8];
    while reader.read_exact(&mut header).is_ok() {
        let size32 = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
        let typ: [u8; 4] = header[4..8].try_into().ok()?;

        let (box_size, header_len) = if size32 == 1 {
            let mut s64 = [0u8; 8];
            reader.read_exact(&mut s64).ok()?;
            (u64::from_be_bytes(s64), 16u64)
        } else if size32 == 0 {
            (0, 8u64)
        } else {
            (size32, 8u64)
        };

        if &typ == b"moov" {
            let read_len = if box_size > header_len {
                ((box_size - header_len) as usize).min(10 * 1024 * 1024)
            } else {
                10 * 1024 * 1024
            };
            let mut moov_buf = vec![0u8; read_len];
            let n = reader.read(&mut moov_buf).unwrap_or(0);
            return find_tkhd_dimensions(&moov_buf[..n]);
        }

        if box_size == 0 || box_size < header_len {
            break;
        }
        if reader
            .seek(SeekFrom::Current((box_size - header_len) as i64))
            .is_err()
        {
            break;
        }
    }
    None
}

/// Walk boxes inside moov looking for the first trak/tkhd with non-zero dims.
fn find_tkhd_dimensions(moov_bytes: &[u8]) -> Option<(u32, u32)> {
    let mut pos = 0;
    while pos + 8 <= moov_bytes.len() {
        let (size, hdr, typ) = isobmff_box(moov_bytes, pos)?;
        if size < hdr || pos.checked_add(size).is_none() {
            break;
        }
        let box_end = (pos + size).min(moov_bytes.len());

        if &typ == b"trak" {
            if let Some(dims) = find_tkhd_in_trak(&moov_bytes[pos + hdr..box_end]) {
                if dims.0 > 0 && dims.1 > 0 {
                    return Some(dims);
                }
            }
        }

        if pos + size > moov_bytes.len() {
            break;
        }
        pos += size;
    }
    None
}

/// Parse tkhd width/height (16.16 fixed-point) inside a trak box payload.
fn find_tkhd_in_trak(trak_bytes: &[u8]) -> Option<(u32, u32)> {
    let mut pos = 0;
    while pos + 8 <= trak_bytes.len() {
        let (size, hdr, typ) = isobmff_box(trak_bytes, pos)?;
        if size < hdr || pos.checked_add(size).is_none() {
            break;
        }

        if &typ == b"tkhd" {
            let payload = trak_bytes.get(pos + hdr..)?;
            if payload.is_empty() {
                break;
            }
            let version = payload[0];
            // v0: width at byte 76, v1: width at byte 88 (from payload start)
            let off = if version >= 1 { 88 } else { 76 };
            if payload.len() >= off + 8 {
                let w = u32::from_be_bytes(payload[off..off + 4].try_into().ok()?) >> 16;
                let h = u32::from_be_bytes(payload[off + 4..off + 8].try_into().ok()?) >> 16;
                return Some((w, h));
            }
        }

        if pos + size > trak_bytes.len() {
            break;
        }
        pos += size;
    }
    None
}

/// Stream through an MP4/ISOBMFF reader without Seek (e.g. a ZipFile entry)
/// to locate moov -> trak -> tkhd width and height.
fn read_mp4_dimensions_stream<R: Read>(reader: &mut R) -> Option<(u32, u32)> {
    let mut header = [0u8; 8];
    while reader.read_exact(&mut header).is_ok() {
        let size32 = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
        let typ: [u8; 4] = header[4..8].try_into().ok()?;

        let (box_size, header_len) = if size32 == 1 {
            let mut s64 = [0u8; 8];
            reader.read_exact(&mut s64).ok()?;
            (u64::from_be_bytes(s64), 16u64)
        } else if size32 == 0 {
            (0, 8u64)
        } else {
            (size32, 8u64)
        };

        if &typ == b"moov" {
            let read_len = if box_size > header_len {
                ((box_size - header_len) as usize).min(10 * 1024 * 1024)
            } else {
                10 * 1024 * 1024
            };
            let mut moov_buf = vec![0u8; read_len];
            let n = reader.read(&mut moov_buf).unwrap_or(0);
            return find_tkhd_dimensions(&moov_buf[..n]);
        }

        if box_size == 0 || box_size < header_len {
            break;
        }
        let skip = box_size - header_len;
        if std::io::copy(&mut reader.by_ref().take(skip), &mut std::io::sink()).ok()? < skip {
            break;
        }
    }
    None
}

/// Walk JPEG markers over a stream to extract SOF width and height even when
/// APP1/EXIF/ICC segments exceed the initial 64 KiB header buffer.
fn read_jpeg_dimensions_from_reader<R: Read>(reader: &mut R) -> Option<(u32, u32)> {
    let mut soi = [0u8; 2];
    reader.read_exact(&mut soi).ok()?;
    if soi != [0xFF, 0xD8] {
        return None;
    }
    let mut byte = [0u8; 1];
    loop {
        reader.read_exact(&mut byte).ok()?;
        if byte[0] != 0xFF {
            continue;
        }
        loop {
            reader.read_exact(&mut byte).ok()?;
            if byte[0] != 0xFF {
                break;
            }
        }
        let marker = byte[0];
        if marker == 0xD9 || marker == 0xDA {
            return None;
        }
        if marker == 0x00 || marker == 0x01 || (0xD0..=0xD8).contains(&marker) {
            continue;
        }
        let mut len_bytes = [0u8; 2];
        reader.read_exact(&mut len_bytes).ok()?;
        let seg_len = u16::from_be_bytes(len_bytes) as usize;
        if seg_len < 2 {
            return None;
        }
        if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
            if seg_len < 7 {
                return None;
            }
            let mut sof = [0u8; 5];
            reader.read_exact(&mut sof).ok()?;
            let h = u16::from_be_bytes([sof[1], sof[2]]) as u32;
            let w = u16::from_be_bytes([sof[3], sof[4]]) as u32;
            return if w > 0 && h > 0 { Some((w, h)) } else { None };
        }
        let skip = (seg_len - 2) as u64;
        if std::io::copy(&mut reader.by_ref().take(skip), &mut std::io::sink()).ok()? < skip {
            return None;
        }
    }
}

/// Parse AVIF image dimensions from ISOBMFF `ispe` (and `irot` rotation) boxes.
fn read_avif_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut best: Option<(u32, u32)> = None;
    let mut rotate_90 = false;
    let mut i = 0;
    while i + 12 <= bytes.len() {
        if &bytes[i + 4..i + 8] == b"ispe" && i + 20 <= bytes.len() {
            let size = u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
            let version = bytes[i + 8];
            if size >= 20 && version == 0 {
                let w = u32::from_be_bytes([bytes[i + 12], bytes[i + 13], bytes[i + 14], bytes[i + 15]]);
                let h = u32::from_be_bytes([bytes[i + 16], bytes[i + 17], bytes[i + 18], bytes[i + 19]]);
                if w > 0 && h > 0 && w <= 65536 && h <= 65536 {
                    let area = (w as u64) * (h as u64);
                    let best_area = best.map(|(bw, bh)| (bw as u64) * (bh as u64)).unwrap_or(0);
                    if area > best_area {
                        best = Some((w, h));
                    }
                }
            }
        } else if &bytes[i + 4..i + 8] == b"irot" && i + 9 <= bytes.len() {
            let size = u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
            if size == 9 {
                let angle = bytes[i + 8] & 0x03;
                if angle == 1 || angle == 3 {
                    rotate_90 = true;
                }
            }
        }
        i += 1;
    }
    best.map(|(w, h)| if rotate_90 { (h, w) } else { (w, h) })
}

/// Compute stitched ICO dimensions matching `icoSizesTotal` in the viewer:
/// sum of unique frame widths and max of unique frame heights.
fn read_ico_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 6 || data[..4] != [0, 0, 1, 0] {
        return None;
    }
    let count = u16::from_le_bytes([data[4], data[5]]) as usize;
    if count == 0 || count > 1024 || data.len() < 6 + count * 16 {
        return None;
    }
    let mut seen = std::collections::HashSet::new();
    let mut total_w = 0u32;
    let mut max_h = 0u32;
    for i in 0..count {
        let entry = 6 + i * 16;
        let mut w = if data[entry] == 0 { 256u32 } else { data[entry] as u32 };
        let mut h = if data[entry + 1] == 0 { 256u32 } else { data[entry + 1] as u32 };
        let offset = u32::from_le_bytes([
            data[entry + 12],
            data[entry + 13],
            data[entry + 14],
            data[entry + 15],
        ]) as usize;
        if offset + 24 <= data.len() && &data[offset..offset + 8] == b"\x89PNG\r\n\x1a\n" {
            let png_w = u32::from_be_bytes([
                data[offset + 16],
                data[offset + 17],
                data[offset + 18],
                data[offset + 19],
            ]);
            let png_h = u32::from_be_bytes([
                data[offset + 20],
                data[offset + 21],
                data[offset + 22],
                data[offset + 23],
            ]);
            if png_w > 0 && png_h > 0 && png_w <= 4096 && png_h <= 4096 {
                w = png_w;
                h = png_h;
            }
        }
        if seen.insert((w, h)) {
            total_w = total_w.saturating_add(w);
            if h > max_h {
                max_h = h;
            }
        }
    }
    if total_w > 0 && max_h > 0 {
        Some((total_w, max_h))
    } else {
        None
    }
}

fn parse_svg_length_attr(tag: &str, attr_name: &str) -> Option<f64> {
    let lower = tag.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(pos) = lower[search_from..].find(attr_name) {
        let idx = search_from + pos;
        let before_ok = idx == 0 || {
            let b = lower.as_bytes()[idx - 1];
            b.is_ascii_whitespace() || b == b'"' || b == b'\''
        };
        let after_idx = idx + attr_name.len();
        if before_ok && after_idx < lower.len() {
            let rest = tag[after_idx..].trim_start();
            if let Some(after_eq) = rest.strip_prefix('=') {
                let after_eq = after_eq.trim_start();
                let quote = after_eq.chars().next()?;
                if quote == '"' || quote == '\'' {
                    let val_end = after_eq[1..].find(quote)?;
                    let raw_val = after_eq[1..1 + val_end].trim();
                    if raw_val.ends_with('%') {
                        return None;
                    }
                    let num_str = raw_val
                        .trim_end_matches(|c: char| c.is_ascii_alphabetic())
                        .trim();
                    if let Ok(v) = num_str.parse::<f64>() {
                        if v.is_finite() && v > 0.0 {
                            return Some(v);
                        }
                    }
                }
            }
        }
        search_from = after_idx;
    }
    None
}

fn parse_svg_viewbox(tag: &str) -> Option<(f64, f64)> {
    let lower = tag.to_ascii_lowercase();
    let idx = lower.find("viewbox")?;
    let rest = tag[idx + 7..].trim_start().strip_prefix('=')?.trim_start();
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let end = rest[1..].find(quote)?;
    let content = &rest[1..1 + end];
    let nums: Vec<f64> = content
        .split(|c: char| c.is_ascii_whitespace() || c == ',')
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<f64>().ok())
        .collect();
    if nums.len() == 4 && nums[2] > 0.0 && nums[3] > 0.0 {
        Some((nums[2], nums[3]))
    } else {
        None
    }
}

/// Parse `<svg>` width/height or `viewBox` from the leading UTF-8 header bytes.
fn read_svg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let text = String::from_utf8_lossy(bytes);
    let lower = text.to_ascii_lowercase();
    let start = lower.find("<svg")?;
    let end = text[start..].find('>')?;
    let tag = &text[start..=start + end];
    let vb = parse_svg_viewbox(tag);
    let w = parse_svg_length_attr(tag, "width").or_else(|| vb.map(|(vw, _)| vw))?;
    let h = parse_svg_length_attr(tag, "height").or_else(|| vb.map(|(_, vh)| vh))?;
    let w_u32 = w.round() as u32;
    let h_u32 = h.round() as u32;
    if w_u32 > 0 && h_u32 > 0 {
        Some((w_u32, h_u32))
    } else {
        None
    }
}

/// Probe media dimensions from a file on disk using header-only reads.
pub fn read_media_dimensions_from_path(path: &std::path::Path, ext: &str) -> Option<(u32, u32)> {
    let mut file = std::fs::File::open(path).ok()?;
    let file_len = file.metadata().ok().map(|m| m.len()).unwrap_or(0);
    if file_len == 0 {
        return None;
    }
    if ext.eq_ignore_ascii_case("mp4") {
        return read_mp4_dimensions(&mut file);
    }
    let header_limit = 65_536usize.min(file_len as usize);
    let mut buf = vec![0u8; header_limit];
    let n = file.read(&mut buf).ok()?;
    let slice = &buf[..n];
    if ext.eq_ignore_ascii_case("ico") {
        return read_ico_dimensions(slice).or_else(|| read_dimensions_from_bytes(slice));
    }
    if ext.eq_ignore_ascii_case("svg") {
        return read_svg_dimensions(slice);
    }
    if ext.eq_ignore_ascii_case("avif") {
        return read_avif_dimensions(slice).or_else(|| read_dimensions_from_bytes(slice));
    }
    if let Some(dims) = read_dimensions_from_bytes(slice) {
        return Some(dims);
    }
    if ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg") {
        let _ = file.seek(SeekFrom::Start(0));
        return read_jpeg_dimensions_from_reader(&mut file);
    }
    image::image_dimensions(path).ok()
}

/// Probe media dimensions from a non-seekable stream (such as a ZIP archive entry).
pub fn read_media_dimensions_from_stream<R: Read>(
    reader: &mut R,
    entry_size: u64,
    ext: &str,
) -> Option<(u32, u32)> {
    if entry_size == 0 {
        return None;
    }
    if ext.eq_ignore_ascii_case("mp4") {
        return read_mp4_dimensions_stream(reader);
    }
    if ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg") {
        return read_jpeg_dimensions_from_reader(reader);
    }
    let limit = 65_536u64.min(entry_size) as usize;
    let mut buf = Vec::with_capacity(limit);
    reader.take(limit as u64).read_to_end(&mut buf).ok()?;
    if ext.eq_ignore_ascii_case("ico") {
        return read_ico_dimensions(&buf).or_else(|| read_dimensions_from_bytes(&buf));
    }
    if ext.eq_ignore_ascii_case("svg") {
        return read_svg_dimensions(&buf);
    }
    if ext.eq_ignore_ascii_case("avif") {
        return read_avif_dimensions(&buf).or_else(|| read_dimensions_from_bytes(&buf));
    }
    read_dimensions_from_bytes(&buf)
}
