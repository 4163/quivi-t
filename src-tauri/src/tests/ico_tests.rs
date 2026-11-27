use super::{ico_frames_from_bytes, ico_frames_from_path, ico_spritesheet_from_bytes, MAX_ICO_BYTES};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static ICO_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new(prefix: &str) -> Self {
        let n = ICO_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "quivit-ico-test-{prefix}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

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


#[test]
fn ico_frames_from_path_reads_valid_and_rejects_oversized() {
    let dir = TempDir::new("path-limit");

    // Valid ICO on disk
    let valid_path = dir.0.join("valid.ico");
    let ico = ico_container(&[png_bytes(4, 4, 180)]);
    std::fs::write(&valid_path, &ico).expect("write valid ico");
    let sizes = ico_frames_from_path(&valid_path).expect("read valid ico from path");
    assert_eq!(sizes.len(), 1);
    assert_eq!((sizes[0].width, sizes[0].height), (4, 4));

    // Oversized ICO (> MAX_ICO_BYTES) rejected via metadata before reading
    let oversized_path = dir.0.join("oversized.ico");
    let file = std::fs::File::create(&oversized_path).expect("create oversized ico");
    file.set_len(MAX_ICO_BYTES as u64 + 1)
        .expect("set oversized length");
    drop(file);
    let err = ico_frames_from_path(&oversized_path).expect_err("oversized ico must be rejected");
    assert!(err.contains("size limit"), "unexpected error: {err}");

    // Empty / missing file rejection
    let empty_path = dir.0.join("empty.ico");
    std::fs::write(&empty_path, b"").expect("write empty ico");
    assert!(ico_frames_from_path(&empty_path).is_err());
    assert!(ico_frames_from_path(&dir.0.join("missing.ico")).is_err());
}

#[test]
fn ico_frames_dedupes_overlapping_entries_and_caps_bmp_scan() {
    // 1. Multiple directory entries sharing the exact same (offset, size) are deduplicated.
    let single_bmp = bmp_masked_ico_2x2([30, 60, 90, 255]);
    let dib = &single_bmp[22..];
    let dup_count: u16 = 16;
    let dir_end = 6 + (dup_count as usize) * 16;
    let mut dup_ico = vec![0u8, 0, 1, 0];
    dup_ico.extend_from_slice(&dup_count.to_le_bytes());
    for _ in 0..dup_count {
        let mut entry = [0u8; 16];
        entry[0] = 2;
        entry[1] = 2;
        entry[4..6].copy_from_slice(&1u16.to_le_bytes());
        entry[6..8].copy_from_slice(&32u16.to_le_bytes());
        entry[8..12].copy_from_slice(&(dib.len() as u32).to_le_bytes());
        entry[12..16].copy_from_slice(&(dir_end as u32).to_le_bytes());
        dup_ico.extend_from_slice(&entry);
    }
    dup_ico.extend_from_slice(dib);

    let sizes = ico_frames_from_bytes(&dup_ico).expect("duplicate span entries should dedupe cleanly");
    assert_eq!(sizes.len(), 1);
    assert_eq!((sizes[0].width, sizes[0].height), (2, 2));

    // 2. Distinct overlapping BMP spans summing beyond MAX_ICO_BMP_SCAN_BYTES hit the scan cap.
    let entries: u16 = 66;
    let payload_len = 1024 * 1024usize; // 1 MiB payload -> 66 distinct shifted spans > 64 MiB cap
    let scan_dir_end = 6 + (entries as usize) * 16;
    let mut bomb_ico = Vec::with_capacity(scan_dir_end + payload_len);
    bomb_ico.extend_from_slice(&[0, 0, 1, 0]);
    bomb_ico.extend_from_slice(&entries.to_le_bytes());
    for i in 0..entries as usize {
        let offset = (scan_dir_end + i) as u32;
        let size = (payload_len - i) as u32;
        let mut entry = [0u8; 16];
        entry[0] = 16;
        entry[1] = 16;
        entry[4..6].copy_from_slice(&1u16.to_le_bytes());
        entry[6..8].copy_from_slice(&32u16.to_le_bytes());
        entry[8..12].copy_from_slice(&size.to_le_bytes());
        entry[12..16].copy_from_slice(&offset.to_le_bytes());
        bomb_ico.extend_from_slice(&entry);
    }
    bomb_ico.resize(scan_dir_end + payload_len, 0u8);

    let err = ico_frames_from_bytes(&bomb_ico).expect_err("overlapping BMP scan bomb must fail");
    assert!(err.contains("scan limit"), "unexpected error: {err}");
}
