use std::{
    borrow::Cow,
    io::Cursor,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, OnceLock,
    },
};

use image::{AnimationDecoder, DynamicImage, ImageDecoder, ImageFormat, RgbaImage};

pub(super) const MAX_ENCODED_BYTES: usize = 128 * 1024 * 1024;
const MAX_DECODED_BYTES: u64 = 256 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 32_768;
const MAX_THUMBNAIL_DIMENSION: u32 = 1_024;
const MAX_SVG_BYTES: usize = 16 * 1024 * 1024;
static SVG_FONTS: OnceLock<Arc<resvg::usvg::fontdb::Database>> = OnceLock::new();

fn check_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0
        || height == 0
        || width > MAX_IMAGE_DIMENSION
        || height > MAX_IMAGE_DIMENSION
        || u64::from(width) * u64::from(height) * 4 > MAX_DECODED_BYTES
    {
        return Err("Decoded image exceeds the thumbnail limit.".into());
    }
    Ok(())
}

fn rgba_from_pixels(
    width: usize,
    height: usize,
    pixels: impl Iterator<Item = [u8; 4]>,
) -> Result<RgbaImage, String> {
    let width = u32::try_from(width).map_err(|_| "Invalid image width.")?;
    let height = u32::try_from(height).map_err(|_| "Invalid image height.")?;
    check_dimensions(width, height)?;
    let bytes: Vec<u8> = pixels.flatten().collect();
    RgbaImage::from_raw(width, height, bytes).ok_or_else(|| "Invalid decoded pixel count.".into())
}

fn decode_avif(bytes: &[u8]) -> Result<DynamicImage, String> {
    use aom_decode::avif::{Avif, Image};
    let parsed = match super::avif_sequence::first_frame(bytes)? {
        Some(parsed) => parsed,
        None => Avif::parse_avif(bytes).map_err(|error| error.to_string())?,
    };
    let metadata = parsed
        .primary_item_metadata()
        .map_err(|error| error.to_string())?;
    check_dimensions(
        metadata.max_frame_width.get(),
        metadata.max_frame_height.get(),
    )?;
    if let Some(alpha) = parsed
        .alpha_item_metadata()
        .map_err(|error| error.to_string())?
    {
        check_dimensions(alpha.max_frame_width.get(), alpha.max_frame_height.get())?;
    }
    let mut decoder = Avif::from_parsed_avif_data(parsed, &aom_decode::Config { threads: 2 })
        .map_err(|error| error.to_string())?;
    let decoded = decoder.convert().map_err(|error| error.to_string())?;
    let rgba = match decoded {
        Image::RGB8(image) => rgba_from_pixels(
            image.width(),
            image.height(),
            image.pixels().map(|p| [p.r, p.g, p.b, 255]),
        ),
        Image::RGBA8(image) => rgba_from_pixels(
            image.width(),
            image.height(),
            image.pixels().map(|p| [p.r, p.g, p.b, p.a]),
        ),
        Image::RGB16(image) => rgba_from_pixels(
            image.width(),
            image.height(),
            image
                .pixels()
                .map(|p| [(p.r >> 8) as u8, (p.g >> 8) as u8, (p.b >> 8) as u8, 255]),
        ),
        Image::RGBA16(image) => rgba_from_pixels(
            image.width(),
            image.height(),
            image.pixels().map(|p| {
                [
                    (p.r >> 8) as u8,
                    (p.g >> 8) as u8,
                    (p.b >> 8) as u8,
                    (p.a >> 8) as u8,
                ]
            }),
        ),
        Image::Gray8(image) => rgba_from_pixels(
            image.width(),
            image.height(),
            image.pixels().map(|p| [p, p, p, 255]),
        ),
        Image::Gray16(image) => rgba_from_pixels(
            image.width(),
            image.height(),
            image.pixels().map(|p| {
                let c = (p >> 8) as u8;
                [c, c, c, 255]
            }),
        ),
    }?;
    Ok(DynamicImage::ImageRgba8(rgba))
}

fn render_svg(bytes: &[u8], cx: u32) -> Result<RgbaImage, String> {
    use resvg::{tiny_skia, usvg};
    if bytes.len() > MAX_SVG_BYTES {
        return Err("SVG input exceeds the thumbnail limit.".into());
    }
    let needs_fonts = bytes
        .windows(5)
        .any(|part| part == b"<text" || part == b":text");
    let fonts = if needs_fonts {
        SVG_FONTS
            .get_or_init(|| {
                let mut fonts = usvg::fontdb::Database::new();
                fonts.load_system_fonts();
                Arc::new(fonts)
            })
            .clone()
    } else {
        Arc::new(usvg::fontdb::Database::new())
    };
    let mut options = usvg::Options {
        fontdb: fonts,
        ..Default::default()
    };
    options.image_href_resolver.resolve_string = Box::new(|_, _| None);
    let resolve_data = usvg::ImageHrefResolver::default_data_resolver();
    let embedded_bytes = AtomicU64::new(0);
    options.image_href_resolver.resolve_data = Box::new(move |mime, data, options| {
        if data.len() > MAX_SVG_BYTES || data.starts_with(&[0x1f, 0x8b]) {
            return None;
        }
        if let Ok(format) = image::guess_format(&data) {
            let (width, height) = image::ImageReader::with_format(Cursor::new(&*data), format)
                .into_dimensions()
                .ok()?;
            check_dimensions(width, height).ok()?;
            embedded_bytes
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |bytes| {
                    bytes
                        .checked_add(u64::from(width) * u64::from(height) * 4)
                        .filter(|bytes| *bytes <= MAX_DECODED_BYTES)
                })
                .ok()?;
        }
        resolve_data(mime, data, options)
    });
    let tree = usvg::Tree::from_data(bytes, &options).map_err(|error| error.to_string())?;
    let size = tree.size();
    let scale = cx as f32 / size.width().max(size.height());
    let width = (size.width() * scale).round().max(1.0).min(cx as f32) as u32;
    let height = (size.height() * scale).round().max(1.0).min(cx as f32) as u32;
    let mut pixmap =
        tiny_skia::Pixmap::new(width, height).ok_or("Unable to allocate SVG thumbnail.")?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let mut pixels = pixmap.take();
    for pixel in pixels.chunks_exact_mut(4) {
        let alpha = u16::from(pixel[3]);
        if alpha != 0 && alpha != 255 {
            for channel in &mut pixel[..3] {
                *channel = ((u16::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
            }
        }
    }
    RgbaImage::from_raw(width, height, pixels).ok_or_else(|| "Invalid SVG thumbnail pixels.".into())
}

fn decode_limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits
}

fn webp_frame_input(bytes: &[u8]) -> Cow<'_, [u8]> {
    let padding = (|| {
        let mut position = 12usize;
        loop {
            let header = bytes.get(position..position.checked_add(8)?)?;
            let size = u32::from_le_bytes(header[4..8].try_into().ok()?) as usize;
            let end = position.checked_add(8)?.checked_add(size)?;
            if end > bytes.len() {
                return None;
            }
            if &header[..4] == b"ANMF" {
                let mut inner = position.checked_add(24)?;
                while inner.checked_add(8)? <= end {
                    let size = u32::from_le_bytes(bytes.get(inner + 4..inner + 8)?.try_into().ok()?)
                        as usize;
                    let sub_end = inner.checked_add(8)?.checked_add(size)?;
                    if size % 2 == 1 && sub_end == end && bytes.get(end) == Some(&0) {
                        return Some(position + 4);
                    }
                    inner = sub_end.checked_add(size % 2)?;
                }
                return None;
            }
            position = end.checked_add(size % 2)?;
        }
    })();
    let Some(offset) = padding else {
        return Cow::Borrowed(bytes);
    };
    // Some encoders share the last subchunk's pad with the enclosing ANMF.
    // Include that byte in ANMF for image-webp's stricter inner size check.
    let mut normalized = bytes.to_vec();
    let size = u32::from_le_bytes(normalized[offset..offset + 4].try_into().unwrap());
    normalized[offset..offset + 4].copy_from_slice(&(size + 1).to_le_bytes());
    Cow::Owned(normalized)
}

pub(super) fn decode_first_frame(bytes: &[u8], cx: u32) -> Result<RgbaImage, String> {
    if cx == 0 {
        return Err("Thumbnail size is outside the supported range.".into());
    }
    let cx = cx.min(MAX_THUMBNAIL_DIMENSION);
    if bytes.is_empty() || bytes.len() > MAX_ENCODED_BYTES {
        return Err("Image input exceeds the thumbnail limit.".into());
    }

    let format = if super::avif_sequence::is_avif(bytes) {
        ImageFormat::Avif
    } else {
        match image::guess_format(bytes) {
            Ok(format) => format,
            Err(error) => {
                if std::str::from_utf8(bytes)
                    .is_ok_and(|text| text.contains("<svg") || text.contains(":svg"))
                {
                    return render_svg(bytes, cx);
                }
                return Err(error.to_string());
            }
        }
    };
    let image = match format {
        ImageFormat::Png => {
            let mut decoder =
                image::codecs::png::PngDecoder::with_limits(Cursor::new(bytes), decode_limits())
                    .map_err(|error| error.to_string())?;
            decoder
                .set_limits(decode_limits())
                .map_err(|error| error.to_string())?;
            if decoder.is_apng().map_err(|error| error.to_string())? {
                let frame = decoder
                    .apng()
                    .map_err(|error| error.to_string())?
                    .into_frames()
                    .next()
                    .ok_or("APNG contains no animation frames.")?
                    .map_err(|error| error.to_string())?;
                DynamicImage::ImageRgba8(frame.into_buffer())
            } else {
                DynamicImage::from_decoder(decoder).map_err(|error| error.to_string())?
            }
        }
        ImageFormat::WebP => {
            let input = webp_frame_input(bytes);
            let mut decoder = image::codecs::webp::WebPDecoder::new(Cursor::new(input.as_ref()))
                .map_err(|error| error.to_string())?;
            decoder
                .set_limits(decode_limits())
                .map_err(|error| error.to_string())?;
            check_dimensions(decoder.dimensions().0, decoder.dimensions().1)?;
            if decoder.has_animation() {
                let frame = decoder
                    .into_frames()
                    .next()
                    .ok_or("WebP contains no animation frames.")?
                    .map_err(|error| error.to_string())?;
                DynamicImage::ImageRgba8(frame.into_buffer())
            } else {
                DynamicImage::from_decoder(decoder).map_err(|error| error.to_string())?
            }
        }
        ImageFormat::Avif => decode_avif(bytes)?,
        _ => return Err("This format does not have a native thumbnail decoder.".into()),
    };

    let (width, height) = (image.width(), image.height());
    if width <= cx && height <= cx {
        return Ok(image.into_rgba8());
    }
    Ok(image.thumbnail(cx, cx).into_rgba8())
}
