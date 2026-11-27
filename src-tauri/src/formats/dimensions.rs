use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};

use super::isobmff::{be_u32, isobmff_box, read_mp4_dimensions, read_mp4_dimensions_stream};
use super::registry::is_tiff_ext;
use super::tiff::read_tiff_dimensions_from_reader;

const STACK_HEADER_PROBE_BYTES: usize = 8 * 1024;
const MAX_HEADER_PROBE_BYTES: usize = 64 * 1024;
const MAX_ICO_DIR_ENTRIES: usize = 1_024;
const MAX_AVIF_BOX_DEPTH: usize = 8;

#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub(crate) struct IcoDirEntry {
    pub width: u8,
    pub height: u8,
    pub planes: u16,
    pub bit_count: u16,
    pub size: u32,
    pub offset: u32,
    pub raw_entry: [u8; 16],
}

pub(crate) struct IcoDirIter<'a> {
    data: &'a [u8],
    index: usize,
    count: usize,
}

impl Iterator for IcoDirIter<'_> {
    type Item = IcoDirEntry;

    fn next(&mut self) -> Option<Self::Item> {
        if self.index >= self.count {
            return None;
        }
        let off = 6 + self.index * 16;
        self.index += 1;
        let raw_entry: [u8; 16] = self.data[off..off + 16].try_into().ok()?;
        Some(IcoDirEntry {
            width: raw_entry[0],
            height: raw_entry[1],
            planes: u16::from_le_bytes([raw_entry[4], raw_entry[5]]),
            bit_count: u16::from_le_bytes([raw_entry[6], raw_entry[7]]),
            size: u32::from_le_bytes([raw_entry[8], raw_entry[9], raw_entry[10], raw_entry[11]]),
            offset: u32::from_le_bytes([
                raw_entry[12],
                raw_entry[13],
                raw_entry[14],
                raw_entry[15],
            ]),
            raw_entry,
        })
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let remaining = self.count - self.index;
        (remaining, Some(remaining))
    }
}

impl ExactSizeIterator for IcoDirIter<'_> {}

pub(crate) fn parse_ico_dir(data: &[u8]) -> Option<IcoDirIter<'_>> {
    if data.len() < 6 || data[..4] != [0, 0, 1, 0] {
        return None;
    }
    let count = u16::from_le_bytes([data[4], data[5]]) as usize;
    if count == 0 || count > MAX_ICO_DIR_ENTRIES || data.len() < 6 + count * 16 {
        return None;
    }
    Some(IcoDirIter {
        data,
        index: 0,
        count,
    })
}

/// ICO: any entry with 32bpp contains alpha.
pub(crate) fn ico_has_alpha(hdr: &[u8]) -> bool {
    let Some(entries) = parse_ico_dir(hdr) else {
        return false;
    };
    entries.into_iter().any(|entry| entry.bit_count == 32)
}

/// Header-only dimension probe from a byte slice. Uses the image crate's
/// fast path: it parses the format header without decoding pixel data.
/// Returns `None` for formats the crate cannot probe (SVG, unsupported AVIF).
pub fn read_dimensions_from_bytes(bytes: &[u8]) -> Option<(u32, u32)> {
    let cursor = Cursor::new(bytes);
    let reader = image::ImageReader::new(BufReader::new(cursor))
        .with_guessed_format()
        .ok()?;
    reader.into_dimensions().ok()
}

/// Walk JPEG markers over a stream to extract SOF width and height even when
/// APP1/EXIF/ICC segments exceed the initial 64 KiB header buffer.
pub fn read_jpeg_dimensions_from_reader<R: Read>(reader: &mut R) -> Option<(u32, u32)> {
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

fn scan_avif_boxes(
    bytes: &[u8],
    start: usize,
    end: usize,
    depth: usize,
    best: &mut Option<(u32, u32)>,
    rotate_90: &mut bool,
) {
    if depth > MAX_AVIF_BOX_DEPTH {
        return;
    }
    let mut pos = start;
    while pos + 8 <= end {
        let Some((size, header, typ)) = isobmff_box(bytes, pos) else {
            break;
        };
        if size < header || pos.checked_add(size).is_none() {
            break;
        }
        let box_end = (pos + size).min(end);
        let payload_start = pos + header;

        if &typ == b"meta" {
            // `meta` is a FullBox: 4-byte version + flags precede child boxes.
            if payload_start + 4 <= box_end {
                scan_avif_boxes(bytes, payload_start + 4, box_end, depth + 1, best, rotate_90);
            }
        } else if &typ == b"iprp" || &typ == b"ipco" {
            scan_avif_boxes(bytes, payload_start, box_end, depth + 1, best, rotate_90);
        } else if &typ == b"ispe" {
            if let Some(payload) = bytes.get(payload_start..box_end) {
                if payload.len() >= 12 && payload[0] == 0 {
                    if let (Some(w), Some(h)) = (be_u32(payload, 4), be_u32(payload, 8)) {
                        if w > 0 && h > 0 && w <= 65536 && h <= 65536 {
                            let area = (w as u64) * (h as u64);
                            let best_area =
                                best.map(|(bw, bh)| (bw as u64) * (bh as u64)).unwrap_or(0);
                            if area > best_area {
                                *best = Some((w, h));
                            }
                        }
                    }
                }
            }
        } else if &typ == b"irot" {
            if size == header + 1 && payload_start < box_end {
                let angle = bytes[payload_start] & 0x03;
                if angle == 1 || angle == 3 {
                    *rotate_90 = true;
                }
            }
        }

        if pos + size > end {
            break;
        }
        pos += size;
    }
}

/// Parse AVIF image dimensions from ISOBMFF `ispe` (and `irot` rotation) boxes.
pub fn read_avif_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut best: Option<(u32, u32)> = None;
    let mut rotate_90 = false;
    scan_avif_boxes(bytes, 0, bytes.len(), 0, &mut best, &mut rotate_90);
    best.map(|(w, h)| if rotate_90 { (h, w) } else { (w, h) })
}

/// Compute stitched ICO dimensions matching `icoSizesTotal` in the viewer:
/// sum of unique frame widths and max of unique frame heights.
pub fn read_ico_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    let entries = parse_ico_dir(data)?;
    let mut seen = std::collections::HashSet::new();
    let mut total_w = 0u32;
    let mut max_h = 0u32;
    for entry in entries {
        let mut w = if entry.width == 0 {
            256u32
        } else {
            entry.width as u32
        };
        let mut h = if entry.height == 0 {
            256u32
        } else {
            entry.height as u32
        };
        let offset = entry.offset as usize;
        if offset
            .checked_add(24)
            .is_some_and(|end| end <= data.len())
            && &data[offset..offset + 8] == b"\x89PNG\r\n\x1a\n"
        {
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

fn parse_svg_length_attr(lower_tag: &str, attr_name: &str) -> Option<f64> {
    let mut search_from = 0;
    while let Some(pos) = lower_tag[search_from..].find(attr_name) {
        let idx = search_from + pos;
        let before_ok = idx == 0 || {
            let b = lower_tag.as_bytes()[idx - 1];
            b.is_ascii_whitespace() || b == b'"' || b == b'\''
        };
        let after_idx = idx + attr_name.len();
        if before_ok && after_idx < lower_tag.len() {
            let rest = lower_tag[after_idx..].trim_start();
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

fn parse_svg_viewbox(lower_tag: &str) -> Option<(f64, f64)> {
    let idx = lower_tag.find("viewbox")?;
    let rest = lower_tag[idx + 7..]
        .trim_start()
        .strip_prefix('=')?
        .trim_start();
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
pub fn read_svg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let start = bytes
        .windows(4)
        .position(|w| w.eq_ignore_ascii_case(b"<svg"))?;
    let rel_end = bytes[start..].iter().position(|&b| b == b'>')?;
    let lower_tag = String::from_utf8_lossy(&bytes[start..=start + rel_end]).to_ascii_lowercase();
    let vb = parse_svg_viewbox(&lower_tag);
    let w = parse_svg_length_attr(&lower_tag, "width").or_else(|| vb.map(|(vw, _)| vw))?;
    let h = parse_svg_length_attr(&lower_tag, "height").or_else(|| vb.map(|(_, vh)| vh))?;
    let w_u32 = w.round() as u32;
    let h_u32 = h.round() as u32;
    if w_u32 > 0 && h_u32 > 0 {
        Some((w_u32, h_u32))
    } else {
        None
    }
}

fn read_header_dimensions_from_slice(slice: &[u8], ext: &str) -> Option<(u32, u32)> {
    if ext.eq_ignore_ascii_case("ico") {
        return read_ico_dimensions(slice).or_else(|| read_dimensions_from_bytes(slice));
    }
    if ext.eq_ignore_ascii_case("svg") {
        return read_svg_dimensions(slice);
    }
    if ext.eq_ignore_ascii_case("avif") {
        return read_avif_dimensions(slice).or_else(|| read_dimensions_from_bytes(slice));
    }
    if is_tiff_ext(ext) {
        return read_tiff_dimensions_from_reader(Cursor::new(slice))
            .or_else(|| read_dimensions_from_bytes(slice));
    }
    read_dimensions_from_bytes(slice)
}

fn read_up_to<R: Read>(reader: &mut R, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut total = 0;
    while total < buf.len() {
        match reader.read(&mut buf[total..]) {
            Ok(0) => break,
            Ok(n) => total += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(total)
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
    if is_tiff_ext(ext) {
        if let Some(dims) = read_tiff_dimensions_from_reader(BufReader::new(&mut file)) {
            return Some(dims);
        }
        file.seek(SeekFrom::Start(0)).ok()?;
        return image::ImageReader::new(BufReader::new(file))
            .with_guessed_format()
            .ok()?
            .into_dimensions()
            .ok();
    }

    let mut stack_buf = [0u8; STACK_HEADER_PROBE_BYTES];
    let initial_limit = STACK_HEADER_PROBE_BYTES.min(file_len as usize);
    let n = read_up_to(&mut file, &mut stack_buf[..initial_limit]).ok()?;
    if let Some(dims) = read_header_dimensions_from_slice(&stack_buf[..n], ext) {
        return Some(dims);
    }

    if file_len > n as u64 {
        let header_limit = MAX_HEADER_PROBE_BYTES.min(file_len as usize);
        let mut buf = vec![0u8; header_limit];
        buf[..n].copy_from_slice(&stack_buf[..n]);
        let extra = read_up_to(&mut file, &mut buf[n..]).ok()?;
        let total = n + extra;
        if let Some(dims) = read_header_dimensions_from_slice(&buf[..total], ext) {
            return Some(dims);
        }
    }

    if ext.eq_ignore_ascii_case("svg") {
        return None;
    }

    if ext.eq_ignore_ascii_case("jpg")
        || ext.eq_ignore_ascii_case("jpeg")
        || ext.eq_ignore_ascii_case("jfif")
    {
        file.seek(SeekFrom::Start(0)).ok()?;
        let mut buffered = BufReader::new(&mut file);
        return read_jpeg_dimensions_from_reader(&mut buffered);
    }

    file.seek(SeekFrom::Start(0)).ok()?;
    image::ImageReader::new(BufReader::new(file))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
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
    if ext.eq_ignore_ascii_case("jpg")
        || ext.eq_ignore_ascii_case("jpeg")
        || ext.eq_ignore_ascii_case("jfif")
    {
        return read_jpeg_dimensions_from_reader(reader);
    }
    let limit = (MAX_HEADER_PROBE_BYTES as u64).min(entry_size) as usize;
    let mut buf = Vec::with_capacity(limit);
    reader.by_ref().take(limit as u64).read_to_end(&mut buf).ok()?;
    read_header_dimensions_from_slice(&buf, ext)
}
