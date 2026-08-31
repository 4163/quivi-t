use crate::formats::{is_archive_ext, is_image_ext, is_metadata_ext, check_animation_status};

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
    assert!(status.no_loop);
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
fn test_is_animated_apng() {
    let mut buf = b"\x89PNG\r\n\x1a\n...".to_vec();
    buf.extend_from_slice(b"acTL...IDAT");
    assert!(check_animation_status(&buf).is_animated);

    let mut static_buf = b"\x89PNG\r\n\x1a\n...".to_vec();
    static_buf.extend_from_slice(b"IDAT...acTL");
    assert!(!check_animation_status(&static_buf).is_animated);
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
    assert!(!check_animation_status(&avis).no_loop);

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
        .join("export_1788174887667.avif");
    let bytes = std::fs::read(&path).expect("test AVIF fixture");
    let status = check_animation_status(&bytes);
    assert!(status.is_animated);
    assert!(!status.no_loop);
}

#[test]
fn test_is_animated_truncated() {
    // Truncated buffer should fail gracefully
    assert!(!check_animation_status(b"GIF8").is_animated);
    assert!(!check_animation_status(b"RIFF").is_animated);
    assert!(!check_animation_status(b"\x89PNG").is_animated);
    assert!(!check_animation_status(b"\0\0\0\x18ftyp").is_animated);
}
