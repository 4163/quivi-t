use super::ico_frames_from_bytes;

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
