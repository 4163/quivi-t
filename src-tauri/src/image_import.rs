use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

pub const MAX_CAPTURE_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_BITMAP_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_SVG_BYTES: usize = 8 * 1024 * 1024;
const HASH_BUFFER_BYTES: usize = 64 * 1024;

pub struct PreparedImage {
    pub path: PathBuf,
    pub filename: String,
}

pub fn svg_text(path: &Path) -> Result<Option<String>, String> {
    let mut head = [0; 1024];
    let n = File::open(path)
        .and_then(|mut f| f.read(&mut head))
        .map_err(|e| e.to_string())?;
    if image::guess_format(&head[..n]).is_ok() {
        return Ok(None);
    }
    let start = String::from_utf8_lossy(&head[..n]);
    if !start
        .trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with('<')
    {
        return Err("Dropped content is not a supported image".into());
    }
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > MAX_SVG_BYTES as u64 {
        return Err("Dropped SVG exceeds the 8 MiB limit".into());
    }
    let text = fs::read_to_string(path).map_err(|_| "Dropped SVG is not valid UTF-8")?;
    Ok(Some(text))
}

pub fn prepare(
    path: &Path,
    dib: bool,
    sanitized_svg: Option<&str>,
) -> Result<PreparedImage, String> {
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    let limit = if dib {
        MAX_BITMAP_BYTES
    } else {
        MAX_CAPTURE_BYTES
    };
    if size == 0 || size > limit as u64 {
        return Err("Dropped image is empty or exceeds the size limit".into());
    }
    let extension;
    let mut prepared_path = path.to_path_buf();
    if dib {
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        let bmp = dib_to_bmp(&bytes)?;
        let mut reader = image::ImageReader::with_format(Cursor::new(bmp), image::ImageFormat::Bmp);
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(MAX_BITMAP_BYTES as u64);
        reader.limits(limits);
        let decoded = reader
            .decode()
            .map_err(|e| format!("Invalid dropped bitmap: {e}"))?;
        prepared_path = path.with_extension("png");
        decoded
            .save_with_format(&prepared_path, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        extension = "png";
    } else if let Some(text) = svg_text(path)? {
        let clean = sanitized_svg.ok_or("Dropped SVG must be sanitized before saving")?;
        if text.is_empty() || clean.len() > MAX_SVG_BYTES || !clean.trim_start().starts_with("<svg")
        {
            return Err("Dropped SVG was rejected".into());
        }
        prepared_path = path.with_extension("svg");
        fs::write(&prepared_path, clean).map_err(|e| e.to_string())?;
        extension = "svg";
    } else {
        let reader = image::ImageReader::open(path)
            .map_err(|e| e.to_string())?
            .with_guessed_format()
            .map_err(|e| e.to_string())?;
        let format = reader.format().ok_or("Unrecognized dropped image format")?;
        extension = match format {
            image::ImageFormat::Png => "png",
            image::ImageFormat::Jpeg => "jpg",
            image::ImageFormat::Gif => "gif",
            image::ImageFormat::WebP => "webp",
            image::ImageFormat::Bmp => "bmp",
            image::ImageFormat::Ico => "ico",
            image::ImageFormat::Avif => "avif",
            _ => return Err("Dropped image format is not supported".into()),
        };
        let (width, height) = if format == image::ImageFormat::Avif {
            avif_dimensions(path)?
        } else {
            reader
                .into_dimensions()
                .map_err(|e| format!("Invalid dropped image: {e}"))?
        };
        check_dimensions(width, height)?;
    }
    if fs::metadata(&prepared_path)
        .map_err(|e| e.to_string())?
        .len()
        > MAX_CAPTURE_BYTES as u64
    {
        return Err("Dropped image exceeds the 128 MiB limit".into());
    }
    let hash = file_hash(&prepared_path)?;
    Ok(PreparedImage {
        path: prepared_path,
        filename: format!("drop-{hash}.{extension}"),
    })
}

pub fn file_hash(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0; HASH_BUFFER_BYTES];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn check_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width == 0
        || height == 0
        || u64::from(width) * u64::from(height) > MAX_BITMAP_BYTES as u64 / 4
    {
        return Err("Dropped image dimensions exceed the pixel limit".into());
    }
    Ok(())
}

#[cfg(windows)]
fn avif_dimensions(path: &Path) -> Result<(u32, u32), String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    if let Some(dimensions) = crate::formats::read_mp4_dimensions(&mut file) {
        return Ok(dimensions);
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let parsed =
        aom_decode::avif::Avif::parse_avif(&bytes).map_err(|e| format!("Invalid AVIF: {e}"))?;
    let metadata = parsed
        .primary_item_metadata()
        .map_err(|e| format!("Invalid AVIF: {e}"))?;
    Ok((
        metadata.max_frame_width.get(),
        metadata.max_frame_height.get(),
    ))
}

#[cfg(not(windows))]
fn avif_dimensions(path: &Path) -> Result<(u32, u32), String> {
    image::ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .into_dimensions()
        .map_err(|e| e.to_string())
}

fn dib_to_bmp(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() < 40 {
        return Err("Dropped bitmap header is incomplete".into());
    }
    let u32_at = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    let header = u32_at(0) as usize;
    if ![40, 52, 56, 108, 124].contains(&header) || header > bytes.len() {
        return Err("Dropped bitmap header is not supported".into());
    }
    let width = i32::from_le_bytes(bytes[4..8].try_into().unwrap());
    let height = i32::from_le_bytes(bytes[8..12].try_into().unwrap());
    if width <= 0 || height == i32::MIN {
        return Err("Invalid dropped bitmap dimensions".into());
    }
    check_dimensions(width as u32, height.unsigned_abs())?;
    let depth = u16::from_le_bytes(bytes[14..16].try_into().unwrap());
    let compression = u32_at(16);
    if ![1, 4, 8, 16, 24, 32].contains(&depth) || ![0, 3, 6].contains(&compression) {
        return Err("Dropped bitmap encoding is not supported".into());
    }
    let palette = if u32_at(32) != 0 {
        u32_at(32) as usize
    } else if depth <= 8 {
        1 << depth
    } else {
        0
    };
    let masks = if header == 40 {
        match compression {
            3 => 12,
            6 => 16,
            _ => 0,
        }
    } else {
        0
    };
    let offset = header
        .checked_add(masks)
        .and_then(|n| palette.checked_mul(4).and_then(|p| n.checked_add(p)))
        .filter(|n| *n <= bytes.len())
        .ok_or("Invalid dropped bitmap layout")?;
    let mut bmp = Vec::with_capacity(bytes.len() + 14);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&((bytes.len() + 14) as u32).to_le_bytes());
    bmp.extend_from_slice(&[0; 4]);
    bmp.extend_from_slice(&((offset + 14) as u32).to_le_bytes());
    bmp.extend_from_slice(bytes);
    Ok(bmp)
}
