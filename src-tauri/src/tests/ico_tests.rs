use super::{ico_frames_from_bytes, ico_spritesheet_from_bytes, MAX_ICO_BYTES};

fn png_bytes(width: u32, height: u32, fill: u8) -> Vec<u8> {
    let img = image::RgbaImage::from_pixel(width, height, image::Rgba([fill, 100, 150, 255]));
    let mut out: Vec<u8> = Vec::new();
    {
        use image::ImageEncoder;
        let encoder = image::codecs::png::PngEncoder::new(&mut out);
        encoder
            .write_image(img.as_raw(), width, height, image::ColorType::Rgba8.into())
            .expect("encode test png");
    }
    out
}

fn ico_container(entries: &[Vec<u8>]) -> Vec<u8> {
    let mut ico = vec![0u8, 0, 1, 0, entries.len() as u8, 0];
    let mut offset = (6 + 16 * entries.len()) as u32;
    for png in entries {
        ico.push(0);
        ico.push(0);
        ico.push(0);
        ico.push(0);
        ico.extend_from_slice(&1u16.to_le_bytes());
        ico.extend_from_slice(&32u16.to_le_bytes());
        ico.extend_from_slice(&(png.len() as u32).to_le_bytes());
        ico.extend_from_slice(&offset.to_le_bytes());
        offset += png.len() as u32;
    }
    for png in entries {
        ico.extend_from_slice(png);
    }
    ico
}

#[test]
fn ico_frames_rejects_bad_headers() {
    assert!(ico_frames_from_bytes(&[]).is_err());
    assert!(ico_frames_from_bytes(&[0, 0, 1, 0, 0, 0]).is_err());
}

#[test]
fn ico_frames_returns_per_size_data_urls_sorted_largest_first() {
    let small = png_bytes(1, 1, 10);
    let large = png_bytes(2, 2, 200);
    let ico = ico_container(&[small, large]);

    let sizes = ico_frames_from_bytes(&ico).expect("decode test ico");
    assert_eq!(sizes.len(), 2);
    assert_eq!((sizes[0].width, sizes[0].height), (2, 2));
    assert_eq!((sizes[1].width, sizes[1].height), (1, 1));
    for size in &sizes {
        assert!(size.data_url.starts_with("data:image/png;base64,"));
        let raw = &size.data_url["data:image/png;base64,".len()..];
        let bytes = crate::utils::base64_decode_bytes(raw).expect("base64 payload");
        let decoded = image::load_from_memory(&bytes).expect("decode payload png");
        assert_eq!((decoded.width(), decoded.height()), (size.width, size.height));
    }
}

#[test]
fn ico_frames_dedupes_identical_dims() {
    let first = png_bytes(2, 2, 10);
    let second = png_bytes(2, 2, 200);
    let ico = ico_container(&[first, second]);

    let sizes = ico_frames_from_bytes(&ico).expect("decode test ico");
    assert_eq!(sizes.len(), 1);
    assert_eq!((sizes[0].width, sizes[0].height), (2, 2));
}

#[test]
fn ico_spritesheet_single_frame() {
    let frame = png_bytes(16, 16, 42);
    let ico = ico_container(&[frame]);
    let sheet = ico_spritesheet_from_bytes(&ico).expect("decode spritesheet single frame");
    assert_eq!(sheet.width(), 16);
    assert_eq!(sheet.height(), 16);
    assert_eq!(sheet.get_pixel(0, 0), &image::Rgba([42, 100, 150, 255]));
}

#[test]
fn ico_spritesheet_multi_frame_layout() {
    let small = png_bytes(8, 8, 10);
    let large = png_bytes(24, 24, 200);
    let ico = ico_container(&[small, large]);
    let sheet = ico_spritesheet_from_bytes(&ico).expect("decode spritesheet multi frame");
    assert_eq!(sheet.width(), 32);
    assert_eq!(sheet.height(), 24);
    assert_eq!(sheet.get_pixel(0, 0), &image::Rgba([200, 100, 150, 255]));
    assert_eq!(sheet.get_pixel(24, 8), &image::Rgba([10, 100, 150, 255]));
}

#[test]
fn ico_spritesheet_rejects_bad_and_truncated_headers() {
    assert!(ico_spritesheet_from_bytes(&[]).is_err());
    assert!(ico_spritesheet_from_bytes(&[0, 0, 1]).is_err());
    assert!(ico_spritesheet_from_bytes(&[0, 0, 1, 0]).is_err());
    assert!(ico_spritesheet_from_bytes(&[0, 0, 1, 0, 0, 0]).is_err());
    assert!(ico_spritesheet_from_bytes(&[0, 0, 2, 0, 1, 0]).is_err());
    assert!(ico_spritesheet_from_bytes(&[0, 0, 1, 0, 0x05, 0x04]).is_err());
    let truncated = vec![0u8, 0, 1, 0, 2, 0, 0, 0, 0, 0, 1, 0, 32, 0];
    assert!(ico_spritesheet_from_bytes(&truncated).is_err());
}

#[test]
fn ico_directory_entry_corrupted_bounds_handling() {
    let valid_png = png_bytes(8, 8, 50);

    let mut bad_offset_ico = ico_container(&[valid_png.clone()]);
    bad_offset_ico[18..22].copy_from_slice(&999999u32.to_le_bytes());
    assert!(ico_spritesheet_from_bytes(&bad_offset_ico).is_err());

    let mut bad_size_ico = ico_container(&[valid_png.clone()]);
    bad_size_ico[14..18].copy_from_slice(&999999u32.to_le_bytes());
    assert!(ico_spritesheet_from_bytes(&bad_size_ico).is_err());

    let mut bad_inside_dir = ico_container(&[valid_png.clone()]);
    bad_inside_dir[18..22].copy_from_slice(&2u32.to_le_bytes());
    assert!(ico_spritesheet_from_bytes(&bad_inside_dir).is_err());

    let valid1 = png_bytes(8, 8, 100);
    let valid2 = png_bytes(16, 16, 200);
    let mut mixed_ico = ico_container(&[valid1, valid2]);
    mixed_ico[18..22].copy_from_slice(&999999u32.to_le_bytes());
    let sheet = ico_spritesheet_from_bytes(&mixed_ico).expect("decode valid surviving frame");
    assert_eq!(sheet.width(), 16);
    assert_eq!(sheet.height(), 16);
    assert_eq!(sheet.get_pixel(0, 0), &image::Rgba([200, 100, 150, 255]));
}

#[test]
fn ico_spritesheet_size_bounds_limit() {
    let huge_header = vec![0u8; MAX_ICO_BYTES + 1];
    assert_eq!(
        ico_spritesheet_from_bytes(&huge_header),
        Err("ICO input is outside the supported size limit.".into())
    );
}
