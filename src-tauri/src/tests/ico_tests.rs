use super::{ico_frames_from_bytes, ico_spritesheet_from_bytes};

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

fn bmp_masked_ico_2x2(bgra: [u8; 4]) -> Vec<u8> {
    // 40-byte BITMAPINFOHEADER + 16-byte 2x2 32bpp XOR mask + 8-byte 1bpp AND mask = 64 bytes
    let mut dib = Vec::with_capacity(64);
    dib.extend_from_slice(&40u32.to_le_bytes()); // biSize
    dib.extend_from_slice(&2i32.to_le_bytes()); // biWidth
    dib.extend_from_slice(&4i32.to_le_bytes()); // biHeight (doubled for XOR + AND)
    dib.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    dib.extend_from_slice(&32u16.to_le_bytes()); // biBitCount
    dib.extend_from_slice(&0u32.to_le_bytes()); // biCompression (BI_RGB)
    dib.extend_from_slice(&24u32.to_le_bytes()); // biSizeImage
    dib.extend_from_slice(&[0u8; 16]); // pels/colors
    for _ in 0..4 {
        dib.extend_from_slice(&bgra);
    }
    dib.extend_from_slice(&[0u8; 8]); // AND mask (all 0 = opaque)

    let mut ico = vec![0u8, 0, 1, 0, 1, 0];
    ico.push(2); // width
    ico.push(2); // height
    ico.push(0); // color count
    ico.push(0); // reserved
    ico.extend_from_slice(&1u16.to_le_bytes());
    ico.extend_from_slice(&32u16.to_le_bytes());
    ico.extend_from_slice(&(dib.len() as u32).to_le_bytes());
    ico.extend_from_slice(&22u32.to_le_bytes());
    ico.extend_from_slice(&dib);
    ico
}

#[test]
fn ico_frames_rejects_bad_headers() {
    assert!(ico_frames_from_bytes(&[]).is_err());
    assert!(ico_frames_from_bytes(&[0, 0, 1, 0, 0, 0]).is_err());
    // Bad magic (type = 2 cursor instead of 1 icon)
    assert!(ico_frames_from_bytes(&[0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).is_err());
    // Count > 1024
    let mut too_many = vec![0u8, 0, 1, 0];
    too_many.extend_from_slice(&1025u16.to_le_bytes());
    assert!(ico_frames_from_bytes(&too_many).is_err());
    // Truncated directory (claims 2 entries, only 10 bytes after header)
    assert!(ico_frames_from_bytes(&[0, 0, 1, 0, 2, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0]).is_err());
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
fn ico_spritesheet_stitches_unique_frames_and_rejects_invalid() {
    let small = png_bytes(2, 2, 10);
    let large = png_bytes(4, 4, 200);
    let dup = png_bytes(2, 2, 50);
    let ico = ico_container(&[small, large, dup]);

    let sheet = ico_spritesheet_from_bytes(&ico).expect("build ico spritesheet");
    assert_eq!(sheet.dimensions(), (6, 4));
    // Largest frame (4x4, red=200) is placed at x=0..4, y=0..4
    assert_eq!(*sheet.get_pixel(0, 0), image::Rgba([200, 100, 150, 255]));
    // Smaller frame (2x2, red=10) is placed at x=4..6, centered at y=(4-2)/2=1..3
    assert_eq!(*sheet.get_pixel(4, 1), image::Rgba([10, 100, 150, 255]));
    assert_eq!(*sheet.get_pixel(4, 0), image::Rgba([0, 0, 0, 0]));

    assert!(ico_spritesheet_from_bytes(&[]).is_err());
    assert!(ico_spritesheet_from_bytes(b"not-an-ico").is_err());
}

#[test]
fn ico_frames_decodes_bmp_masked_entry() {
    // BGRA [30, 60, 90, 255] -> RGBA [90, 60, 30, 255]
    let ico = bmp_masked_ico_2x2([30, 60, 90, 255]);
    let sizes = ico_frames_from_bytes(&ico).expect("decode bmp-masked ico");
    assert_eq!(sizes.len(), 1);
    assert_eq!((sizes[0].width, sizes[0].height), (2, 2));

    let raw = &sizes[0].data_url["data:image/png;base64,".len()..];
    let bytes = crate::utils::base64_decode_bytes(raw).expect("base64 payload");
    let decoded = image::load_from_memory(&bytes)
        .expect("decode payload png")
        .into_rgba8();
    assert_eq!(*decoded.get_pixel(0, 0), image::Rgba([90, 60, 30, 255]));
}
