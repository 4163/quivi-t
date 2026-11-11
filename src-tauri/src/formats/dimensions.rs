use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use super::isobmff::isobmff_box;

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
pub fn read_media_dimensions_from_path(path: &Path, ext: &str) -> Option<(u32, u32)> {
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
