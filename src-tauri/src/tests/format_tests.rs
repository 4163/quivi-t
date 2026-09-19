use crate::formats::{
    check_animation_status, check_mp4_has_audio, is_archive_ext, is_image_ext, is_metadata_ext,
};

#[test]
fn test_is_image_ext() {
    // Valid cases (case insensitive)
    assert!(is_image_ext("jpg"));
    assert!(is_image_ext("JPG"));
    assert!(is_image_ext("JpEg"));
    assert!(is_image_ext("png"));
    assert!(is_image_ext("gif"));
    assert!(is_image_ext("avif"));
    assert!(is_image_ext("webp"));

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

    // Test case mapping for single-frame with NETSCAPE loop
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
    let mut buf = b"\x89PNG\r\n\x1a\n...".to_vec();
    buf.extend_from_slice(b"acTL...IDAT");
    assert!(check_animation_status(&buf).is_animated);

    let mut static_buf = b"\x89PNG\r\n\x1a\n...".to_vec();
    static_buf.extend_from_slice(b"IDAT...acTL");
    assert!(!check_animation_status(&static_buf).is_animated);
}

#[test]
fn test_is_animated_apng_loop_count() {
    let mut buf = b"\x89PNG\r\n\x1a\n...".to_vec();
    buf.extend_from_slice(b"acTL");
    buf.extend_from_slice(&[0, 0, 0, 0]); // num_frames
    buf.extend_from_slice(&[0, 0, 0, 3]); // num_plays = 3
    buf.extend_from_slice(b"IDAT");

    let status = check_animation_status(&buf);
    assert!(status.is_animated);
    assert_eq!(status.loop_count, 3);
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
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("test-files")
        .join("avif")
        .join("export_1788174887667.avif");
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
fn test_is_animated_truncated() {
    // Truncated buffer should fail gracefully
    assert!(!check_animation_status(b"GIF8").is_animated);
    assert!(!check_animation_status(b"RIFF").is_animated);
    assert!(!check_animation_status(b"\x89PNG").is_animated);
    assert!(!check_animation_status(b"\0\0\0\x18ftyp").is_animated);
}

#[test]
fn test_check_mp4_has_audio() {
    use std::io::Cursor;

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

    // Test real library files if present on disk
    let no_audio_path = std::path::Path::new(r"C:\Users\x4163\AppData\Local\QuiviT\library\Imgur\vnSzv5X.mp4");
    if no_audio_path.is_file() {
        let mut f = std::fs::File::open(no_audio_path).unwrap();
        assert!(!check_mp4_has_audio(&mut f));
    }
    let yes_audio_path = std::path::Path::new(r"C:\Users\x4163\AppData\Local\QuiviT\library\Imgur\w2npfQH.mp4");
    if yes_audio_path.is_file() {
        let mut f = std::fs::File::open(yes_audio_path).unwrap();
        assert!(check_mp4_has_audio(&mut f));
    }
}
