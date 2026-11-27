use crate::formats::{
    check_animation_status, check_mp4_has_audio, decode_tiff_file_to_png, decode_tiff_to_png,
    is_archive_ext, is_image_ext, is_metadata_ext, is_tiff_ext, read_avif_dimensions,
    read_ico_dimensions, read_jpeg_dimensions_from_reader, read_media_dimensions_from_path,
    read_media_dimensions_from_stream, read_mp4_dimensions, read_mp4_dimensions_stream,
    read_svg_dimensions, read_tiff_dimensions_from_reader,
};
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static FORMAT_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new(prefix: &str) -> Self {
        let n = FORMAT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "quivit-format-test-{prefix}-{}-{n}",
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

fn repo_test_file(rel: &str) -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("test-files")
        .join(rel)
}

fn png_chunk(typ: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + data.len());
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(typ);
    out.extend_from_slice(data);
    out.extend_from_slice(&[0, 0, 0, 0]);
    out
}

fn minimal_ihdr_chunk(w: u32, h: u32) -> Vec<u8> {
    let mut data = Vec::with_capacity(13);
    data.extend_from_slice(&w.to_be_bytes());
    data.extend_from_slice(&h.to_be_bytes());
    data.extend_from_slice(&[8, 6, 0, 0, 0]);
    png_chunk(b"IHDR", &data)
}

fn box_wrap(typ: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let size = (8 + payload.len()) as u32;
    let mut buf = Vec::with_capacity(size as usize);
    buf.extend_from_slice(&size.to_be_bytes());
    buf.extend_from_slice(typ);
    buf.extend_from_slice(payload);
    buf
}

fn ftyp_box(major: &[u8; 4], compat: &[[u8; 4]]) -> Vec<u8> {
    let size = 16 + compat.len() * 4;
    let mut buf = Vec::with_capacity(size);
    buf.extend_from_slice(&(size as u32).to_be_bytes());
    buf.extend_from_slice(b"ftyp");
    buf.extend_from_slice(major);
    buf.extend_from_slice(&0u32.to_be_bytes());
    for brand in compat {
        buf.extend_from_slice(brand);
    }
    buf
}

fn empty_box(typ: &[u8; 4]) -> Vec<u8> {
    let mut buf = Vec::from(8u32.to_be_bytes());
    buf.extend_from_slice(typ);
    buf
}

fn synthetic_mp4(version: u8, width: u32, height: u32, zero_size_moov: bool) -> Vec<u8> {
    let mut tkhd_payload = if version >= 1 {
        vec![0u8; 96]
    } else {
        vec![0u8; 84]
    };
    tkhd_payload[0] = version;
    let off = if version >= 1 { 88 } else { 76 };
    tkhd_payload[off..off + 4].copy_from_slice(&(width << 16).to_be_bytes());
    tkhd_payload[off + 4..off + 8].copy_from_slice(&(height << 16).to_be_bytes());

    let tkhd = box_wrap(b"tkhd", &tkhd_payload);
    let trak = box_wrap(b"trak", &tkhd);

    let mut mp4 = ftyp_box(b"isom", &[*b"mp41"]);
    if zero_size_moov {
        mp4.extend_from_slice(&0u32.to_be_bytes());
        mp4.extend_from_slice(b"moov");
        mp4.extend_from_slice(&trak);
    } else {
        mp4.extend_from_slice(&box_wrap(b"moov", &trak));
    }
    mp4
}

fn synthetic_avif(width: u32, height: u32, irot_angle: Option<u8>) -> Vec<u8> {
    let mut ispe_payload = Vec::with_capacity(12);
    ispe_payload.extend_from_slice(&[0u8; 4]); // version 0 + flags
    ispe_payload.extend_from_slice(&width.to_be_bytes());
    ispe_payload.extend_from_slice(&height.to_be_bytes());
    let mut ipco_payload = box_wrap(b"ispe", &ispe_payload);
    if let Some(angle) = irot_angle {
        ipco_payload.extend_from_slice(&box_wrap(b"irot", &[angle]));
    }
    let ipco = box_wrap(b"ipco", &ipco_payload);
    let iprp = box_wrap(b"iprp", &ipco);
    let mut meta_payload = vec![0u8; 4]; // fullbox version + flags
    meta_payload.extend_from_slice(&iprp);
    let meta = box_wrap(b"meta", &meta_payload);

    let mut avif = ftyp_box(b"avif", &[*b"avif", *b"mif1"]);
    avif.extend_from_slice(&meta);
    avif.extend_from_slice(&box_wrap(b"mdat", &[0u8; 4]));
    avif
}

fn synthetic_jpeg_with_large_exif(width: u16, height: u16, app1_count: usize, app1_payload_len: usize) -> Vec<u8> {
    let mut buf = vec![0xFF, 0xD8]; // SOI
    for _ in 0..app1_count {
        buf.extend_from_slice(&[0xFF, 0xE1]); // APP1
        let seg_len = (app1_payload_len + 2) as u16;
        buf.extend_from_slice(&seg_len.to_be_bytes());
        buf.extend(std::iter::repeat_n(0x41u8, app1_payload_len));
    }
    // SOF0: length=11 (2 + 1 precision + 2 height + 2 width + 1 components + 3 comp)
    buf.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x0B, 0x08]);
    buf.extend_from_slice(&height.to_be_bytes());
    buf.extend_from_slice(&width.to_be_bytes());
    buf.extend_from_slice(&[0x01, 0x01, 0x11, 0x00]);
    buf.extend_from_slice(&[0xFF, 0xD9]); // EOI
    buf
}

fn synthetic_tiff_with_orientation(width: u32, height: u32, orientation: u16) -> Vec<u8> {
    let pixel_count = width * height;
    let ifd_entries: u16 = 9;
    let pixel_offset: u32 = 8 + 2 + u32::from(ifd_entries) * 12 + 4;

    let mut buf = Vec::new();
    // Little-endian TIFF header + IFD offset = 8
    buf.extend_from_slice(&[0x49, 0x49, 0x2A, 0x00]);
    buf.extend_from_slice(&8u32.to_le_bytes());

    buf.extend_from_slice(&ifd_entries.to_le_bytes());
    let mut push_tag = |tag: u16, typ: u16, count: u32, val: u32| {
        buf.extend_from_slice(&tag.to_le_bytes());
        buf.extend_from_slice(&typ.to_le_bytes());
        buf.extend_from_slice(&count.to_le_bytes());
        buf.extend_from_slice(&val.to_le_bytes());
    };
    push_tag(256, 4, 1, width); // ImageWidth
    push_tag(257, 4, 1, height); // ImageLength
    push_tag(258, 3, 1, 8); // BitsPerSample
    push_tag(259, 3, 1, 1); // Compression = None
    push_tag(262, 3, 1, 1); // PhotometricInterpretation = BlackIsZero
    push_tag(273, 4, 1, pixel_offset); // StripOffsets
    push_tag(274, 3, 1, u32::from(orientation)); // Orientation
    push_tag(278, 4, 1, height); // RowsPerStrip
    push_tag(279, 4, 1, pixel_count); // StripByteCounts
    buf.extend_from_slice(&0u32.to_le_bytes()); // next IFD = 0
    buf.extend(std::iter::repeat_n(0x80u8, pixel_count as usize));
    buf
}

#[test]
fn test_is_image_ext() {
    // Valid cases (case insensitive)
    assert!(is_image_ext("jpg"));
    assert!(is_image_ext("JPG"));
    assert!(is_image_ext("JpEg"));
    assert!(is_image_ext("jfif"));
    assert!(is_image_ext("JFIF"));
    assert!(is_image_ext("png"));
    assert!(is_image_ext("gif"));
    assert!(is_image_ext("avif"));
    assert!(is_image_ext("webp"));
    assert!(is_image_ext("dib"));
    assert!(is_image_ext("DIB"));
    assert!(is_image_ext("tif"));
    assert!(is_image_ext("TIF"));
    assert!(is_image_ext("tiff"));
    assert!(is_image_ext("TIFF"));
    assert!(is_tiff_ext("tif"));
    assert!(is_tiff_ext("TIFF"));
    assert!(!is_tiff_ext("jpg"));

    // Invalid cases
    assert!(!is_image_ext(""));
    assert!(!is_image_ext("zip"));
    assert!(!is_image_ext("xml"));
    assert!(!is_image_ext("exe"));
    assert!(!is_image_ext("jpg "));
}

#[test]
fn test_is_archive_ext() {
    // Valid cases (case insensitive)
    assert!(is_archive_ext("zip"));
    assert!(is_archive_ext("ZIP"));
    assert!(is_archive_ext("cbz"));
    assert!(is_archive_ext("rar"));
    assert!(is_archive_ext("cbr"));
    assert!(is_archive_ext("7z"));
    assert!(is_archive_ext("cb7"));
    assert!(is_archive_ext("tar"));
    assert!(is_archive_ext("cbt"));

    // Invalid cases
    assert!(!is_archive_ext(""));
    assert!(!is_archive_ext("jpg"));
    assert!(!is_archive_ext("xml"));
    assert!(!is_archive_ext("7Z "));
}

#[test]
fn test_is_metadata_ext() {
    // Valid cases (case insensitive)
    assert!(is_metadata_ext("xml"));
    assert!(is_metadata_ext("XML"));
    assert!(is_metadata_ext("opf"));
    assert!(is_metadata_ext("OpF"));

    // Invalid cases
    assert!(!is_metadata_ext(""));
    assert!(!is_metadata_ext("jpg"));
    assert!(!is_metadata_ext("zip"));
    assert!(!is_metadata_ext("xml "));
}

#[test]
fn test_is_animated_gif() {
    // 13-byte header: GIF89a + width/height + flags (0) + bg color + aspect ratio
    let mut buf = b"GIF89a\x01\x00\x01\x00\x00\x00\x00".to_vec();
    // \x21 = Extension, \xFF = Application Extension, \x0B = length 11, NETSCAPE2.0, \x03 = length 3 data block, \x01\x00\x00, \x00 = terminator
    buf.extend_from_slice(b"\x21\xFF\x0BNETSCAPE2.0\x03\x01\x00\x00\x00");
    assert!(check_animation_status(&buf).is_animated);

    let static_buf = b"GIF89a\x01\x00\x01\x00\x00\x00\x00\x2C\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3B";
    assert!(!check_animation_status(static_buf).is_animated);
}

#[test]
fn test_is_animated_gif_no_loop() {
    let buf = b"GIF89a\x01\x00\x01\x00\x00\x00\x00\x2C\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x2C\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3B".to_vec();
    let status = check_animation_status(&buf);
    assert!(status.is_animated);
    assert_eq!(status.loop_count, 1);
}

#[test]
fn test_is_animated_webp() {
    let mut buf = b"RIFF....WEBPVP8X".to_vec();
    // Add 4 bytes for chunk size (VP8X chunk size is usually 10)
    buf.extend_from_slice(&[10, 0, 0, 0]);
    // Flags: bit 1 is ANIM (0b0000_0010)
    buf.push(0b0000_0010);
    assert!(check_animation_status(&buf).is_animated);

    let mut static_buf = b"RIFF....WEBPVP8X".to_vec();
    static_buf.extend_from_slice(&[10, 0, 0, 0]);
    static_buf.push(0b0000_0000);
    assert!(!check_animation_status(&static_buf).is_animated);
}

#[test]
fn test_is_animated_webp_loop_count() {
    let mut buf = b"RIFF....WEBPVP8X".to_vec();
    buf.extend_from_slice(&[10, 0, 0, 0]);
    buf.push(0b0000_0010); // ANIM flag
    buf.extend_from_slice(&[0; 9]); // Pad VP8X
    buf.extend_from_slice(b"ANIM");
    buf.extend_from_slice(&[6, 0, 0, 0]);
    buf.extend_from_slice(&[0, 0, 0, 0]); // bg color
    buf.extend_from_slice(&[1, 0]); // loop_count = 1

    let status = check_animation_status(&buf);
    assert!(status.is_animated);
    assert_eq!(status.loop_count, 2); // 1 + 1 normalization
}

#[test]
fn test_is_animated_apng() {
    let mut buf = b"\x89PNG\r\n\x1a\n".to_vec();
    buf.extend_from_slice(&minimal_ihdr_chunk(1, 1));
    buf.extend_from_slice(&png_chunk(b"acTL", &[0, 0, 0, 2, 0, 0, 0, 0]));
    buf.extend_from_slice(&png_chunk(b"IDAT", &[0u8; 4]));
    assert!(check_animation_status(&buf).is_animated);

    let mut static_buf = b"\x89PNG\r\n\x1a\n".to_vec();
    static_buf.extend_from_slice(&minimal_ihdr_chunk(1, 1));
    static_buf.extend_from_slice(&png_chunk(b"IDAT", &[0u8; 4]));
    static_buf.extend_from_slice(&png_chunk(b"acTL", &[0, 0, 0, 2, 0, 0, 0, 0]));
    assert!(!check_animation_status(&static_buf).is_animated);
}

#[test]
fn test_is_animated_apng_loop_count() {
    let mut buf = b"\x89PNG\r\n\x1a\n".to_vec();
    buf.extend_from_slice(&minimal_ihdr_chunk(1, 1));
    buf.extend_from_slice(&png_chunk(b"acTL", &[0, 0, 0, 2, 0, 0, 0, 3]));
    buf.extend_from_slice(&png_chunk(b"IDAT", &[0u8; 4]));

    let status = check_animation_status(&buf);
    assert!(status.is_animated);
    assert_eq!(status.loop_count, 3);
}

#[test]
fn test_animated_fixtures_in_test_files() {
    let cases: &[(&str, bool, Option<u32>)] = &[
        ("animated/export_1785518835803.apng", true, Some(0)),
        ("animated/export_loop3.apng", true, Some(3)),
        ("animated/still_single_frame.apng", false, Some(0)),
        ("animated/export_1785518859589.webp", true, Some(0)),
        ("animated/export_loop1.webp", true, None),
        ("animated/still_single_frame.webp", false, Some(0)),
        ("animated/no_loop.gif", true, Some(1)),
        ("animated/single-frame.gif", false, Some(0)),
        ("animated/still_single_frame.avif", false, Some(0)),
        ("animated/export_loop1.avif", true, Some(1)),
    ];

    for &(rel, expected_anim, expected_loop) in cases {
        let path = repo_test_file(rel);
        assert!(path.exists(), "missing fixture: {}", path.display());
        let bytes = std::fs::read(&path).expect("read animated fixture");
        let status = check_animation_status(&bytes);
        assert_eq!(
            status.is_animated, expected_anim,
            "is_animated mismatch for {rel}: got {status:?}"
        );
        if let Some(lc) = expected_loop {
            assert_eq!(
                status.loop_count, lc,
                "loop_count mismatch for {rel}: got {status:?}"
            );
        }
    }
}

#[test]
fn test_is_animated_avif() {
    // Spec sequence: major brand avis.
    let avis = ftyp_box(b"avis", &[*b"avis", *b"avif", *b"mif1", *b"miaf"]);
    assert!(check_animation_status(&avis).is_animated);
    assert_eq!(check_animation_status(&avis).loop_count, 0);

    // avis only in compatible brands.
    let compat_avis = ftyp_box(b"avif", &[*b"mif1", *b"avis"]);
    assert!(check_animation_status(&compat_avis).is_animated);

    // Still AVIF: avif brand, no avis, no moov.
    let still = ftyp_box(b"avif", &[*b"avif", *b"mif1", *b"miaf"]);
    assert!(!check_animation_status(&still).is_animated);

    // Misbranded sequence: avif brand, no avis, but a top-level moov.
    let mut avif_moov = ftyp_box(b"avif", &[*b"avif", *b"mif1"]);
    avif_moov.extend_from_slice(&empty_box(b"moov"));
    assert!(check_animation_status(&avif_moov).is_animated);

    // MP4-like ftyp + moov is not an AVIF-family file.
    let mut mp4 = ftyp_box(b"isom", &[*b"mp41"]);
    mp4.extend_from_slice(&empty_box(b"moov"));
    assert!(!check_animation_status(&mp4).is_animated);

    // Real sequence fixture (avis + moov).
    let path = repo_test_file("avif/export_1788174887667.avif");
    let bytes = std::fs::read(&path).expect("test AVIF fixture");
    let status = check_animation_status(&bytes);
    assert!(status.is_animated);
    assert_eq!(status.loop_count, 0);

    // Test elst
    let mut avif_elst = ftyp_box(b"avif", &[*b"avif", *b"mif1"]);
    let mut moov = empty_box(b"moov");
    moov.extend_from_slice(&empty_box(b"trak"));
    moov.extend_from_slice(&empty_box(b"edts"));
    moov.extend_from_slice(&empty_box(b"elst"));
    // Update moov size (8 + 8 + 8 + 8 = 32)
    moov[0..4].copy_from_slice(&32u32.to_be_bytes());
    avif_elst.extend_from_slice(&moov);

    let status_elst = check_animation_status(&avif_elst);
    assert!(status_elst.is_animated);
    assert_eq!(status_elst.loop_count, 1);
}

#[test]
fn test_is_animated_svg() {
    assert!(check_animation_status(b"<svg><animate attributeName='x'/></svg>").is_animated);
    assert!(check_animation_status(b"<svg><set attributeName='fill' to='red'/></svg>").is_animated);
    assert!(!check_animation_status(b"<svg width='10' height='10'><rect/></svg>").is_animated);

    let spinner = std::fs::read(repo_test_file("gfl-spinner.svg")).expect("read gfl-spinner.svg");
    assert!(check_animation_status(&spinner).is_animated);

    let koi = std::fs::read(repo_test_file("koi.svg")).expect("read koi.svg");
    assert!(!check_animation_status(&koi).is_animated);
}

#[test]
fn test_is_animated_truncated() {
    // Truncated buffer should fail gracefully
    assert!(!check_animation_status(b"GIF8").is_animated);
    assert!(!check_animation_status(b"RIFF").is_animated);
    assert!(!check_animation_status(b"\x89PNG").is_animated);
    assert!(!check_animation_status(b"\0\0\0\x18ftyp").is_animated);
}

#[test]
fn test_check_mp4_has_audio() {
    // MP4 with moov but no audio tracks (video only)
    let mut mp4_no_audio = ftyp_box(b"isom", &[*b"mp41"]);
    let mut moov_no_audio = empty_box(b"moov");
    moov_no_audio.extend_from_slice(&empty_box(b"trak"));
    moov_no_audio.extend_from_slice(&empty_box(b"mdia"));
    moov_no_audio.extend_from_slice(b"\0\0\0\x10hdlrvide\0\0\0\0");
    let moov_len = moov_no_audio.len() as u32;
    moov_no_audio[0..4].copy_from_slice(&moov_len.to_be_bytes());
    mp4_no_audio.extend_from_slice(&moov_no_audio);

    let mut cursor = Cursor::new(&mp4_no_audio);
    assert!(!check_mp4_has_audio(&mut cursor));

    // MP4 with audio track (contains soun handler in moov)
    let mut mp4_audio = ftyp_box(b"isom", &[*b"mp41"]);
    let mut moov_audio = empty_box(b"moov");
    moov_audio.extend_from_slice(b"\0\0\0\x10hdlrsoun\0\0\0\0");
    let moov_len = moov_audio.len() as u32;
    moov_audio[0..4].copy_from_slice(&moov_len.to_be_bytes());
    mp4_audio.extend_from_slice(&moov_audio);

    let mut cursor = Cursor::new(&mp4_audio);
    assert!(check_mp4_has_audio(&mut cursor));

    // Truncated / empty bytes
    let mut empty_cursor = Cursor::new(b"");
    assert!(!check_mp4_has_audio(&mut empty_cursor));
}

#[test]
fn test_read_mp4_dimensions_and_stream() {
    let mp4_v0 = synthetic_mp4(0, 1280, 720, false);
    assert_eq!(read_mp4_dimensions(&mut Cursor::new(&mp4_v0)), Some((1280, 720)));
    assert_eq!(
        read_mp4_dimensions_stream(&mut Cursor::new(&mp4_v0)),
        Some((1280, 720))
    );

    let mp4_v1 = synthetic_mp4(1, 1920, 1080, false);
    assert_eq!(read_mp4_dimensions(&mut Cursor::new(&mp4_v1)), Some((1920, 1080)));
    assert_eq!(
        read_mp4_dimensions_stream(&mut Cursor::new(&mp4_v1)),
        Some((1920, 1080))
    );

    let mp4_zero_moov = synthetic_mp4(0, 640, 480, true);
    assert_eq!(
        read_mp4_dimensions(&mut Cursor::new(&mp4_zero_moov)),
        Some((640, 480))
    );
    assert_eq!(
        read_mp4_dimensions_stream(&mut Cursor::new(&mp4_zero_moov)),
        Some((640, 480))
    );

    assert_eq!(read_mp4_dimensions(&mut Cursor::new(b"")), None);
    assert_eq!(read_mp4_dimensions(&mut Cursor::new(b"not-an-mp4")), None);
    assert_eq!(read_mp4_dimensions_stream(&mut Cursor::new(b"")), None);
}

#[test]
fn test_read_jpeg_dimensions_from_reader_past_64k_exif() {
    // Two 40 KiB APP1 segments = 80 KiB before SOF0 (> 64 KiB header buffer).
    let jpeg = synthetic_jpeg_with_large_exif(1024, 768, 2, 40_000);
    assert!(jpeg.len() > 65_536);
    assert_eq!(
        read_jpeg_dimensions_from_reader(&mut Cursor::new(&jpeg)),
        Some((1024, 768))
    );
    assert_eq!(
        read_jpeg_dimensions_from_reader(&mut Cursor::new(b"not-a-jpeg")),
        None
    );
}

#[test]
fn test_read_avif_dimensions_and_irot() {
    let avif = synthetic_avif(800, 600, None);
    assert_eq!(read_avif_dimensions(&avif), Some((800, 600)));

    let avif_rot90 = synthetic_avif(800, 600, Some(1));
    assert_eq!(read_avif_dimensions(&avif_rot90), Some((600, 800)));

    let avif_rot270 = synthetic_avif(800, 600, Some(3));
    assert_eq!(read_avif_dimensions(&avif_rot270), Some((600, 800)));

    let avif_rot180 = synthetic_avif(800, 600, Some(2));
    assert_eq!(read_avif_dimensions(&avif_rot180), Some((800, 600)));

    assert_eq!(read_avif_dimensions(b"not-an-avif"), None);
}

#[test]
fn test_read_ico_dimensions() {
    // Two distinct directory entries (16x16 and 32x32) + duplicate 16x16
    let mut ico = vec![0u8, 0, 1, 0, 3, 0];
    let entries: &[(u8, u8)] = &[(16, 16), (32, 32), (16, 16)];
    for &(w, h) in entries {
        let mut e = [0u8; 16];
        e[0] = w;
        e[1] = h;
        ico.extend_from_slice(&e);
    }
    assert_eq!(read_ico_dimensions(&ico), Some((48, 32)));

    // Embedded PNG overrides directory dims (0, 0 -> 256x256, PNG says 512x512)
    let mut png_hdr = b"\x89PNG\r\n\x1a\n".to_vec();
    png_hdr.extend_from_slice(&minimal_ihdr_chunk(512, 512));
    let mut ico_png = vec![0u8, 0, 1, 0, 1, 0];
    let mut e = [0u8; 16];
    e[8..12].copy_from_slice(&(png_hdr.len() as u32).to_le_bytes());
    e[12..16].copy_from_slice(&22u32.to_le_bytes());
    ico_png.extend_from_slice(&e);
    ico_png.extend_from_slice(&png_hdr);
    assert_eq!(read_ico_dimensions(&ico_png), Some((512, 512)));

    assert_eq!(read_ico_dimensions(&[]), None);
    assert_eq!(read_ico_dimensions(&[0, 0, 2, 0, 1, 0]), None);
    assert_eq!(read_ico_dimensions(&[0, 0, 1, 0, 0, 0]), None);
}

#[test]
fn test_read_svg_dimensions() {
    assert_eq!(
        read_svg_dimensions(br#"<svg width="320" height="240"></svg>"#),
        Some((320, 240))
    );
    assert_eq!(
        read_svg_dimensions(br#"<svg width="100px" height="50pt"></svg>"#),
        Some((100, 50))
    );
    assert_eq!(
        read_svg_dimensions(br#"<svg viewBox="0 0 800 600"></svg>"#),
        Some((800, 600))
    );
    assert_eq!(
        read_svg_dimensions(br#"<svg width="100%" height="100%"></svg>"#),
        None
    );
    assert_eq!(
        read_svg_dimensions(br#"<SVG WIDTH='128' HEIGHT='64'></SVG>"#),
        Some((128, 64))
    );
    assert_eq!(read_svg_dimensions(b"not an svg"), None);
}

#[test]
fn test_read_media_dimensions_from_path_and_stream() {
    let dir = TempDir::new("media-dims");

    // PNG
    let mut png_bytes = Vec::new();
    image::DynamicImage::ImageRgba8(image::RgbaImage::new(12, 8))
        .write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .expect("encode png");
    let png_path = dir.0.join("sample.png");
    std::fs::write(&png_path, &png_bytes).unwrap();
    assert_eq!(read_media_dimensions_from_path(&png_path, "png"), Some((12, 8)));
    assert_eq!(
        read_media_dimensions_from_stream(&mut Cursor::new(&png_bytes), png_bytes.len() as u64, "png"),
        Some((12, 8))
    );

    // JPEG (>64 KiB EXIF)
    let jpeg_bytes = synthetic_jpeg_with_large_exif(640, 480, 2, 40_000);
    let jpeg_path = dir.0.join("sample.jpg");
    std::fs::write(&jpeg_path, &jpeg_bytes).unwrap();
    assert_eq!(read_media_dimensions_from_path(&jpeg_path, "jpg"), Some((640, 480)));
    assert_eq!(
        read_media_dimensions_from_stream(&mut Cursor::new(&jpeg_bytes), jpeg_bytes.len() as u64, "jpg"),
        Some((640, 480))
    );

    // ICO
    let mut ico_bytes = vec![0u8, 0, 1, 0, 1, 0];
    let mut entry = [0u8; 16];
    entry[0] = 32;
    entry[1] = 32;
    ico_bytes.extend_from_slice(&entry);
    let ico_path = dir.0.join("sample.ico");
    std::fs::write(&ico_path, &ico_bytes).unwrap();
    assert_eq!(read_media_dimensions_from_path(&ico_path, "ico"), Some((32, 32)));
    assert_eq!(
        read_media_dimensions_from_stream(&mut Cursor::new(&ico_bytes), ico_bytes.len() as u64, "ico"),
        Some((32, 32))
    );

    // SVG
    let svg_bytes = br#"<svg width="200" height="100"></svg>"#;
    let svg_path = dir.0.join("sample.svg");
    std::fs::write(&svg_path, svg_bytes).unwrap();
    assert_eq!(read_media_dimensions_from_path(&svg_path, "svg"), Some((200, 100)));
    assert_eq!(
        read_media_dimensions_from_stream(&mut Cursor::new(svg_bytes), svg_bytes.len() as u64, "svg"),
        Some((200, 100))
    );

    // AVIF
    let avif_bytes = synthetic_avif(400, 300, None);
    let avif_path = dir.0.join("sample.avif");
    std::fs::write(&avif_path, &avif_bytes).unwrap();
    assert_eq!(read_media_dimensions_from_path(&avif_path, "avif"), Some((400, 300)));
    assert_eq!(
        read_media_dimensions_from_stream(&mut Cursor::new(&avif_bytes), avif_bytes.len() as u64, "avif"),
        Some((400, 300))
    );

    // TIFF
    let tiff_bytes = synthetic_tiff_with_orientation(5, 3, 1);
    let tiff_path = dir.0.join("sample.tif");
    std::fs::write(&tiff_path, &tiff_bytes).unwrap();
    assert_eq!(read_media_dimensions_from_path(&tiff_path, "tif"), Some((5, 3)));
    assert_eq!(
        read_media_dimensions_from_stream(&mut Cursor::new(&tiff_bytes), tiff_bytes.len() as u64, "tif"),
        Some((5, 3))
    );

    // MP4
    let mp4_bytes = synthetic_mp4(0, 1280, 720, false);
    let mp4_path = dir.0.join("sample.mp4");
    std::fs::write(&mp4_path, &mp4_bytes).unwrap();
    assert_eq!(read_media_dimensions_from_path(&mp4_path, "mp4"), Some((1280, 720)));
    assert_eq!(
        read_media_dimensions_from_stream(&mut Cursor::new(&mp4_bytes), mp4_bytes.len() as u64, "mp4"),
        Some((1280, 720))
    );

    // Empty
    let empty_path = dir.0.join("empty.png");
    std::fs::write(&empty_path, b"").unwrap();
    assert_eq!(read_media_dimensions_from_path(&empty_path, "png"), None);
    assert_eq!(
        read_media_dimensions_from_stream(&mut Cursor::new(b""), 0, "png"),
        None
    );
}

#[test]
fn test_decode_tiff_to_png_roundtrip() {
    let mut img = image::RgbaImage::new(3, 2);
    img.put_pixel(0, 0, image::Rgba([255, 10, 20, 128]));
    let mut tiff_bytes = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut Cursor::new(&mut tiff_bytes), image::ImageFormat::Tiff)
        .expect("encode test TIFF");

    assert_eq!(
        read_tiff_dimensions_from_reader(Cursor::new(&tiff_bytes)),
        Some((3, 2))
    );

    let png_bytes = decode_tiff_to_png(&tiff_bytes).expect("decode TIFF to PNG");
    assert!(png_bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    let decoded = image::load_from_memory_with_format(&png_bytes, image::ImageFormat::Png)
        .expect("decode PNG output")
        .into_rgba8();
    assert_eq!(decoded.dimensions(), (3, 2));
    assert_eq!(*decoded.get_pixel(0, 0), image::Rgba([255, 10, 20, 128]));
}

#[test]
fn test_tiff_orientation_swap_file_decode_and_rejection() {
    // Orientation = 6 (Rotate90) swaps 3x2 -> 2x3
    let rotated_tiff = synthetic_tiff_with_orientation(3, 2, 6);
    assert_eq!(
        read_tiff_dimensions_from_reader(Cursor::new(&rotated_tiff)),
        Some((2, 3))
    );
    let png_bytes = decode_tiff_to_png(&rotated_tiff).expect("decode rotated TIFF");
    let decoded = image::load_from_memory_with_format(&png_bytes, image::ImageFormat::Png)
        .expect("decode rotated PNG");
    assert_eq!((decoded.width(), decoded.height()), (2, 3));

    // Real fixture decode_tiff_file_to_png
    let fixture = repo_test_file("50-51.tif");
    assert!(fixture.exists(), "missing fixture: {}", fixture.display());
    let fixture_png = decode_tiff_file_to_png(&fixture).expect("decode 50-51.tif");
    assert!(fixture_png.starts_with(b"\x89PNG\r\n\x1a\n"));

    // Empty / invalid TIFF rejection
    assert!(decode_tiff_to_png(&[]).is_err());
    assert!(decode_tiff_to_png(b"not-a-tiff").is_err());
    assert!(decode_tiff_file_to_png(&repo_test_file("missing_file_for_tiff.tif")).is_err());
}
