use std::collections::HashSet;
use std::io::Cursor;

use image::{DynamicImage, ImageFormat, ImageReader, RgbaImage};

const MAX_ICO_BYTES: usize = 64 * 1024 * 1024;
const MAX_ICO_ENTRIES: usize = 1_024;
const MAX_ICO_DIMENSION: u32 = 4_096;
const MAX_ICO_PIXELS_BYTES: u64 = 128 * 1024 * 1024;

fn decode_image(bytes: &[u8], format: ImageFormat) -> Result<RgbaImage, String> {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_ICO_DIMENSION);
    limits.max_image_height = Some(MAX_ICO_DIMENSION);
    limits.max_alloc = Some(MAX_ICO_PIXELS_BYTES);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    reader.decode().map(DynamicImage::into_rgba8).map_err(|error| error.to_string())
}

fn decoded_ico_frames(data: &[u8]) -> Result<Vec<RgbaImage>, String> {
    if data.len() < 6 || data.len() > MAX_ICO_BYTES {
        return Err("ICO input is outside the supported size limit.".into());
    }
    let count = u16::from_le_bytes([data[4], data[5]]) as usize;
    if data[..4] != [0, 0, 1, 0] || count == 0 || count > MAX_ICO_ENTRIES
        || data.len() < 6 + count * 16 {
        return Err("Invalid ICO file structure".into());
    }
    let mut frames = Vec::new();
    let mut dimensions = HashSet::new();
    let mut decoded_bytes = 0u64;
    for i in 0..count {
        let entry = 6 + i * 16;
        let offset = u32::from_le_bytes(data[entry + 12..entry + 16].try_into().unwrap()) as usize;
        let size = u32::from_le_bytes(data[entry + 8..entry + 12].try_into().unwrap()) as usize;
        let Some(end) = offset.checked_add(size).filter(|end| *end <= data.len()) else { continue };
        if offset < 6 + count * 16 { continue; }
        let bytes = &data[offset..end];
        let decoded = if bytes.starts_with(b"\x89PNG") {
            decode_image(bytes, ImageFormat::Png)
        } else {
            // A single-entry container preserves ICO-specific BMP masks.
            let mut synthetic = Vec::with_capacity(22 + bytes.len());
            synthetic.extend_from_slice(&[0, 0, 1, 0, 1, 0]);
            synthetic.extend_from_slice(&data[entry..entry + 12]);
            synthetic.extend_from_slice(&22u32.to_le_bytes());
            synthetic.extend_from_slice(bytes);
            decode_image(&synthetic, ImageFormat::Ico)
        };
        let Ok(frame) = decoded else { continue };
        if !dimensions.insert((frame.width(), frame.height())) { continue; }
        decoded_bytes += frame.as_raw().len() as u64;
        if decoded_bytes > MAX_ICO_PIXELS_BYTES {
            return Err("ICO frames exceed the decoded image limit.".into());
        }
        frames.push(frame);
    }
    if frames.is_empty() {
        frames.push(decode_image(data, ImageFormat::Ico).map_err(|error| format!("Failed to decode ICO: {error}"))?);
    }
    frames.sort_by(|a, b| b.width().cmp(&a.width()));
    Ok(frames)
}

pub(crate) fn ico_spritesheet_from_bytes(data: &[u8]) -> Result<RgbaImage, String> {
    let frames = decoded_ico_frames(data)?;
    let width = frames.iter().try_fold(0u32, |sum, frame| sum.checked_add(frame.width()))
        .ok_or("ICO spritesheet width overflow.")?;
    let height = frames.iter().map(RgbaImage::height).max().unwrap_or(0);
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) * 4 > MAX_ICO_PIXELS_BYTES {
        return Err("ICO spritesheet exceeds the decoded image limit.".into());
    }
    let mut spritesheet = RgbaImage::new(width, height);
    let mut x = 0u32;
    for frame in frames {
        let y = (height - frame.height()) / 2;
        image::imageops::replace(&mut spritesheet, &frame, i64::from(x), i64::from(y));
        x += frame.width();
    }
    Ok(spritesheet)
}

pub fn ico_frames_from_bytes(data: &[u8]) -> Result<Vec<crate::models::IcoSize>, String> {
    let frames = decoded_ico_frames(data)?;
    let mut sizes = Vec::with_capacity(frames.len());
    for rgba in frames {
        let (width, height) = (rgba.width(), rgba.height());
        let mut png_bytes = Vec::new();
        {
            use image::ImageEncoder;
            let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
            encoder.write_image(rgba.as_raw(), width, height, image::ColorType::Rgba8.into())
                .map_err(|error| format!("Failed to encode PNG: {error}"))?;
        }
        sizes.push(crate::models::IcoSize {
            width,
            height,
            data_url: format!("data:image/png;base64,{}", crate::utils::base64_encode(&png_bytes)),
        });
    }
    Ok(sizes)
}

#[cfg(test)]
#[path = "tests/ico_tests.rs"]
mod tests;
