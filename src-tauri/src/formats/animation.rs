use crate::models::AnimationInfo;

use super::isobmff::isobmff_box;

const GIF_SCAN_LIMIT: usize = 262_144;

fn looks_like_xml_or_svg(bytes: &[u8]) -> bool {
    let rest = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    rest.iter()
        .find(|b| !b.is_ascii_whitespace())
        .is_some_and(|&b| b == b'<')
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
    } else if looks_like_xml_or_svg(bytes)
        && bytes.windows(4).any(|w| w.eq_ignore_ascii_case(b"<svg"))
    {
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
    let scan_limit = bytes.len().min(GIF_SCAN_LIMIT);

    while pos < scan_limit {
        let block_type = bytes[pos];
        if block_type == 0x2C {
            frame_count += 1;
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
                if ext_label == 0xFF
                    && pos + 12 <= bytes.len()
                    && &bytes[pos..pos + 12] == b"\x0BNETSCAPE2.0"
                {
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
    let mut pos = 12usize;
    let mut is_animated = false;

    while pos + 8 <= bytes.len() {
        let fourcc = &bytes[pos..pos + 4];
        let chunk_size = u32::from_le_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;

        if fourcc == b"VP8X" {
            if pos + 8 < bytes.len() {
                let flags = bytes[pos + 8];
                is_animated = (flags & 0b0000_0010) != 0;
                if !is_animated {
                    return AnimationInfo {
                        is_animated: false,
                        loop_count: 0,
                    };
                }
            } else {
                break;
            }
        } else if fourcc == b"ANIM" && is_animated {
            if chunk_size >= 6 && pos + 14 <= bytes.len() {
                let parsed_loop_count = u16::from_le_bytes([bytes[pos + 12], bytes[pos + 13]]);
                let loop_count = if parsed_loop_count == 0 {
                    0
                } else {
                    (parsed_loop_count as u32) + 1
                };
                return AnimationInfo {
                    is_animated: true,
                    loop_count,
                };
            }
            return AnimationInfo {
                is_animated: true,
                loop_count: 0,
            };
        }

        let padded = chunk_size.saturating_add(chunk_size & 1);
        let Some(next_pos) = pos.checked_add(8).and_then(|p| p.checked_add(padded)) else {
            break;
        };
        pos = next_pos;
    }

    AnimationInfo {
        is_animated,
        loop_count: 0,
    }
}

fn check_apng(bytes: &[u8]) -> AnimationInfo {
    let mut pos = 8usize;

    while pos + 8 <= bytes.len() {
        let chunk_len = u32::from_be_bytes([
            bytes[pos],
            bytes[pos + 1],
            bytes[pos + 2],
            bytes[pos + 3],
        ]) as usize;
        let chunk_type = &bytes[pos + 4..pos + 8];

        if chunk_type == b"acTL" {
            let loop_count = if chunk_len >= 8 && pos + 16 <= bytes.len() {
                u32::from_be_bytes([
                    bytes[pos + 12],
                    bytes[pos + 13],
                    bytes[pos + 14],
                    bytes[pos + 15],
                ])
            } else {
                0
            };
            return AnimationInfo {
                is_animated: true,
                loop_count,
            };
        }

        if chunk_type == b"IDAT" {
            break;
        }

        let Some(next_pos) = pos.checked_add(12).and_then(|p| p.checked_add(chunk_len)) else {
            break;
        };
        pos = next_pos;
    }

    AnimationInfo {
        is_animated: false,
        loop_count: 0,
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
    for (i, &b) in bytes.iter().enumerate() {
        if b != b'<' {
            continue;
        }
        let tail = &bytes[i..];
        // <animate matches <animate, <animateMotion, and <animateTransform.
        if tail.starts_with(b"<animate") {
            return true;
        }
        if tail.starts_with(b"<set")
            && tail
                .get(4)
                .is_some_and(|&next| matches!(next, b'>' | b' ' | b'\t' | b'\r' | b'\n'))
        {
            return true;
        }
    }
    false
}

/// PNG: color type 4 (grey+alpha) or 6 (RGBA) in IHDR, or a `tRNS` chunk
/// before `IDAT` signals palette/grey transparency.
pub(crate) fn png_has_alpha(hdr: &[u8]) -> bool {
    // PNG signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4)
    // + bit depth (1) + color type (1) = byte 25
    if hdr.len() < 26 || !hdr.starts_with(b"\x89PNG\r\n\x1a\n") {
        return false;
    }
    let color_type = hdr[25];
    if color_type == 4 || color_type == 6 {
        return true;
    }
    let mut pos = 8usize;
    while pos + 12 <= hdr.len() {
        let chunk_len =
            u32::from_be_bytes([hdr[pos], hdr[pos + 1], hdr[pos + 2], hdr[pos + 3]]) as usize;
        let chunk_type = &hdr[pos + 4..pos + 8];
        if chunk_type == b"tRNS" {
            return true;
        }
        if chunk_type == b"IDAT" {
            break;
        }
        let Some(next_pos) = pos.checked_add(12).and_then(|p| p.checked_add(chunk_len)) else {
            break;
        };
        pos = next_pos;
    }
    false
}

/// GIF: check Graphic Control Extension for the transparent color flag.
pub(crate) fn gif_has_transparency(hdr: &[u8]) -> bool {
    if hdr.len() < 13 || !hdr.starts_with(b"GIF") {
        return false;
    }
    let mut pos = 13usize;
    let flags = hdr[10];
    if (flags & 0x80) != 0 {
        let gct_size = 2_usize.pow((flags & 0x07) as u32 + 1);
        pos += 3 * gct_size;
    }
    while pos + 2 < hdr.len() {
        if hdr[pos] == 0x21 && hdr[pos + 1] == 0xF9 {
            // GCE block: introducer (0x21), label (0xF9), block size, packed flags
            if pos + 4 < hdr.len() {
                let packed = hdr[pos + 3];
                return (packed & 0x01) != 0;
            }
        }
        if hdr[pos] == 0x2C || hdr[pos] == 0x3B {
            break;
        }
        if hdr[pos] == 0x21 {
            pos += 2;
            while pos < hdr.len() {
                let block_size = hdr[pos] as usize;
                pos += 1;
                if block_size == 0 {
                    break;
                }
                pos += block_size;
            }
        } else {
            break;
        }
    }
    false
}
