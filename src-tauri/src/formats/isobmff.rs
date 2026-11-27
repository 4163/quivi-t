use std::io::{Read, Seek, SeekFrom};

const MAX_MOOV_BYTES: u64 = 10 * 1024 * 1024;
const MOOV_INITIAL_CAPACITY: usize = 64 * 1024;

pub(super) fn be_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    bytes
        .get(offset..end)?
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
        let size = usize::try_from((hi << 32) | lo).ok()?;
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

/// Walk top-level ISOBMFF boxes until `moov`, reading at most `MAX_MOOV_BYTES`
/// via `take().read_to_end()` so chunked streams are not truncated and `size32 == 0`
/// does not allocate 10 MiB upfront.
fn read_moov_box<R: Read, F>(reader: &mut R, mut skip_bytes: F) -> Option<Vec<u8>>
where
    F: FnMut(&mut R, u64) -> bool,
{
    let mut header = [0u8; 8];
    while reader.read_exact(&mut header).is_ok() {
        let size32 = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
        let typ = &header[4..8];

        let (box_size, header_len) = if size32 == 1 {
            let mut s64 = [0u8; 8];
            reader.read_exact(&mut s64).ok()?;
            (u64::from_be_bytes(s64), 16u64)
        } else if size32 == 0 {
            (0, 8u64)
        } else {
            (size32, 8u64)
        };

        if typ == b"moov" {
            let limit = if size32 == 0 {
                MAX_MOOV_BYTES
            } else if box_size >= header_len {
                (box_size - header_len).min(MAX_MOOV_BYTES)
            } else {
                return None;
            };
            let mut buf = Vec::with_capacity((limit as usize).min(MOOV_INITIAL_CAPACITY));
            let _ = reader.by_ref().take(limit).read_to_end(&mut buf);
            return Some(buf);
        }

        if box_size == 0 || box_size < header_len {
            break;
        }
        if !skip_bytes(reader, box_size - header_len) {
            break;
        }
    }
    None
}

fn read_moov_seek<R: Read + Seek>(reader: &mut R) -> Option<Vec<u8>> {
    read_moov_box(reader, |r, skip| {
        i64::try_from(skip)
            .ok()
            .and_then(|offset| r.seek(SeekFrom::Current(offset)).ok())
            .is_some()
    })
}

fn read_moov_stream<R: Read>(reader: &mut R) -> Option<Vec<u8>> {
    read_moov_box(reader, |r, skip| {
        std::io::copy(&mut r.by_ref().take(skip), &mut std::io::sink())
            .is_ok_and(|copied| copied == skip)
    })
}

fn moov_has_audio(moov_bytes: &[u8]) -> bool {
    moov_bytes.windows(4).any(|w| w == b"soun" || w == b"smhd")
}

/// Checks if an MP4 file or seekable stream contains an audio track.
/// Scans the top-level ISOBMFF boxes for `moov`, then checks if `moov`
/// contains sound stream markers (`soun` handler or `smhd` sound media header).
pub fn check_mp4_has_audio<R: Read + Seek>(reader: &mut R) -> bool {
    read_moov_seek(reader).is_some_and(|moov| moov_has_audio(&moov))
}

/// Checks if a non-seekable MP4 stream (such as a ZipFile entry) contains an audio track.
pub fn check_mp4_has_audio_stream<R: Read>(reader: &mut R) -> bool {
    read_moov_stream(reader).is_some_and(|moov| moov_has_audio(&moov))
}

/// Read video track dimensions from an MP4/ISOBMFF container. Walks the
/// top-level boxes to find `moov`, then parses `trak`/`tkhd` for width and height.
pub fn read_mp4_dimensions<R: Read + Seek>(reader: &mut R) -> Option<(u32, u32)> {
    let moov = read_moov_seek(reader)?;
    find_tkhd_dimensions(&moov)
}

/// Stream through an MP4/ISOBMFF reader without `Seek` (e.g. a ZipFile entry)
/// to locate `moov` -> `trak` -> `tkhd` width and height.
pub fn read_mp4_dimensions_stream<R: Read>(reader: &mut R) -> Option<(u32, u32)> {
    let moov = read_moov_stream(reader)?;
    find_tkhd_dimensions(&moov)
}

/// Walk boxes inside `moov` looking for the first `trak`/`tkhd` with non-zero dims.
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

/// Parse `tkhd` width/height (16.16 fixed-point) inside a `trak` box payload.
fn find_tkhd_in_trak(trak_bytes: &[u8]) -> Option<(u32, u32)> {
    let mut pos = 0;
    while pos + 8 <= trak_bytes.len() {
        let (size, hdr, typ) = isobmff_box(trak_bytes, pos)?;
        if size < hdr || pos.checked_add(size).is_none() {
            break;
        }
        let box_end = (pos + size).min(trak_bytes.len());

        if &typ == b"tkhd" {
            let payload = trak_bytes.get(pos + hdr..box_end)?;
            if payload.is_empty() {
                break;
            }
            let version = payload[0];
            // v0: width at byte 76, v1: width at byte 88 (from payload start)
            let off = if version >= 1 { 88 } else { 76 };
            if payload.len() >= off + 8 {
                let w = be_u32(payload, off)? >> 16;
                let h = be_u32(payload, off + 4)? >> 16;
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
