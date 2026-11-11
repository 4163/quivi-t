use std::io::{Read, Seek, SeekFrom};

fn be_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    bytes
        .get(offset..offset + 4)?
        .try_into()
        .ok()
        .map(u32::from_be_bytes)
}

/// Next ISO BMFF box at `pos`: (total size, header length, type).
pub fn isobmff_box(bytes: &[u8], pos: usize) -> Option<(usize, usize, [u8; 4])> {
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

pub(crate) fn is_avif_family_brand(brand: &[u8]) -> bool {
    brand == b"avif" || brand == b"avis" || brand == b"mif1" || brand == b"miaf"
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
