use std::io::Seek;

const MAX_TIFF_INPUT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TIFF_DECODED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TIFF_DIMENSION: u32 = 32_768;

fn tiff_decode_limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_TIFF_DIMENSION);
    limits.max_image_height = Some(MAX_TIFF_DIMENSION);
    limits.max_alloc = Some(MAX_TIFF_DECODED_BYTES);
    limits
}

fn orientation_swaps_axes(orientation: image::metadata::Orientation) -> bool {
    matches!(
        orientation,
        image::metadata::Orientation::Rotate90
            | image::metadata::Orientation::Rotate270
            | image::metadata::Orientation::Rotate90FlipH
            | image::metadata::Orientation::Rotate270FlipH
    )
}

pub fn read_tiff_dimensions_from_reader<R: std::io::BufRead + Seek>(reader: R) -> Option<(u32, u32)> {
    use image::ImageDecoder;
    let mut decoder = image::codecs::tiff::TiffDecoder::new(reader).ok()?;
    let (w, h) = decoder.dimensions();
    if w == 0 || h == 0 {
        return None;
    }
    let swap = decoder
        .orientation()
        .ok()
        .is_some_and(orientation_swaps_axes);
    Some(if swap { (h, w) } else { (w, h) })
}

fn encode_tiff_decoder_to_png<R: std::io::BufRead + Seek>(reader: R) -> Result<Vec<u8>, String> {
    use image::{ImageDecoder, ImageEncoder};
    let mut decoder = image::codecs::tiff::TiffDecoder::new(reader)
        .map_err(|e| format!("Invalid TIFF image: {e}"))?;
    decoder
        .set_limits(tiff_decode_limits())
        .map_err(|e| format!("TIFF image exceeds decode limits: {e}"))?;
    let orientation = decoder.orientation().ok();
    let mut img = image::DynamicImage::from_decoder(decoder)
        .map_err(|e| format!("Failed to decode TIFF image: {e}"))?;
    if let Some(orientation) = orientation {
        img.apply_orientation(orientation);
    }

    let mut png_bytes = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new_with_quality(
        &mut png_bytes,
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::NoFilter,
    );
    if img.color().has_alpha() {
        let rgba = img.into_rgba8();
        let (w, h) = rgba.dimensions();
        encoder
            .write_image(rgba.as_raw(), w, h, image::ColorType::Rgba8.into())
            .map_err(|e| format!("Failed to encode TIFF as PNG: {e}"))?;
    } else {
        let rgb = img.into_rgb8();
        let (w, h) = rgb.dimensions();
        encoder
            .write_image(rgb.as_raw(), w, h, image::ColorType::Rgb8.into())
            .map_err(|e| format!("Failed to encode TIFF as PNG: {e}"))?;
    }
    Ok(png_bytes)
}

pub fn decode_tiff_to_png(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || (bytes.len() as u64) > MAX_TIFF_INPUT_BYTES {
        return Err("TIFF input is empty or exceeds the size limit".into());
    }
    encode_tiff_decoder_to_png(std::io::Cursor::new(bytes))
}

pub fn decode_tiff_file_to_png(path: &std::path::Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Cannot open TIFF file: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("Cannot inspect TIFF file: {e}"))?
        .len();
    if len == 0 || len > MAX_TIFF_INPUT_BYTES {
        return Err("TIFF file is empty or exceeds the size limit".into());
    }
    encode_tiff_decoder_to_png(std::io::BufReader::new(file))
}

/// TIFF: check first IFD for the ExtraSamples tag (338) when the IFD lies in the
/// leading header buffer.
pub(crate) fn tiff_has_alpha(hdr: &[u8]) -> bool {
    if hdr.len() < 8 {
        return false;
    }
    let le = match &hdr[..4] {
        [0x49, 0x49, 0x2A, 0x00] => true,
        [0x4D, 0x4D, 0x00, 0x2A] => false,
        _ => return false,
    };
    let read_u16 = |off: usize| -> Option<u16> {
        let end = off.checked_add(2)?;
        let bytes: [u8; 2] = hdr.get(off..end)?.try_into().ok()?;
        Some(if le {
            u16::from_le_bytes(bytes)
        } else {
            u16::from_be_bytes(bytes)
        })
    };
    let read_u32 = |off: usize| -> Option<u32> {
        let end = off.checked_add(4)?;
        let bytes: [u8; 4] = hdr.get(off..end)?.try_into().ok()?;
        Some(if le {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        })
    };
    let Some(ifd_off) = read_u32(4).map(|v| v as usize) else {
        return false;
    };
    let Some(count) = read_u16(ifd_off).map(|v| v as usize) else {
        return false;
    };
    for i in 0..count {
        let Some(entry) = ifd_off
            .checked_add(2)
            .and_then(|base| i.checked_mul(12).and_then(|delta| base.checked_add(delta)))
        else {
            break;
        };
        let Some(tag) = read_u16(entry) else {
            break;
        };
        if tag == 338 {
            return true;
        }
    }
    false
}
