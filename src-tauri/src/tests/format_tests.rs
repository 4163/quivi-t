use std::collections::HashSet;

use crate::formats::{
    check_animation_status, check_mp4_has_audio, is_archive_ext, is_image_ext, is_metadata_ext,
    read_dimensions_from_bytes, read_media_dimensions_from_path, read_media_dimensions_from_stream,
    read_mp4_dimensions, FormatCategory, FORMAT_ICONS, SUPPORTED_FORMATS,
};

#[test]
fn test_is_image_ext() {
    // All supported image extensions across viewer and shell thumbnails
    let valid_exts = [
        "jpg", "jpeg", "png", "gif", "webp", "avif", "dib", "bmp", "ico", "apng", "svg",
    ];

    for ext in valid_exts {
        assert!(is_image_ext(ext), "Expected '{}' to be recognized as image", ext);
        assert!(
            is_image_ext(&ext.to_uppercase()),
            "Expected uppercase '{}' to be recognized",
            ext
        );
    }

    // Mixed-case permutations
    assert!(is_image_ext("JpEg"));
    assert!(is_image_ext("PnG"));
    assert!(is_image_ext("WebP"));
    assert!(is_image_ext("AvIf"));
    assert!(is_image_ext("DiB"));
    assert!(is_image_ext("bMp"));
    assert!(is_image_ext("IcO"));
    assert!(is_image_ext("aPnG"));
    assert!(is_image_ext("SvG"));

    // Unsupported and non-image extensions
    let invalid_exts = [
        "exe", "txt", "zip", "xml", "pdf", "mp3", "doc", "bin", "dll", "json", "html", "rs",
        "cbz", "rar", "cbr", "7z", "cb7", "tar", "cbt", "opf",
    ];
    for ext in invalid_exts {
        assert!(!is_image_ext(ext), "Did not expect '{}' to be recognized as image", ext);
    }

    // Partial names and substrings
    assert!(!is_image_ext("jpgx"));
    assert!(!is_image_ext("xjpg"));
    assert!(!is_image_ext("jpeg2000"));
    assert!(!is_image_ext("png1"));
    assert!(!is_image_ext(".jpg"));
    assert!(!is_image_ext(".png"));

    // Edge cases: empty, whitespace
    assert!(!is_image_ext(""));
    assert!(!is_image_ext(" "));
    assert!(!is_image_ext("   "));
    assert!(!is_image_ext("\t"));
    assert!(!is_image_ext("\n"));
    assert!(!is_image_ext("jpg "));
    assert!(!is_image_ext(" jpg"));
    assert!(!is_image_ext(" png "));
    assert!(!is_image_ext("\twebp\n"));
}

#[test]
fn test_is_archive_ext() {
    // All 8 supported archive extensions
    let valid_archives = ["zip", "cbz", "rar", "cbr", "7z", "cb7", "tar", "cbt"];

    for ext in valid_archives {
        assert!(is_archive_ext(ext), "Expected '{}' to be recognized as archive", ext);
        assert!(
            is_archive_ext(&ext.to_uppercase()),
            "Expected uppercase '{}' to be recognized",
            ext
        );
    }

    // Mixed-case permutations
    assert!(is_archive_ext("Zip"));
    assert!(is_archive_ext("Cbz"));
    assert!(is_archive_ext("Rar"));
    assert!(is_archive_ext("Cbr"));
    assert!(is_archive_ext("7Z"));
    assert!(is_archive_ext("Cb7"));
    assert!(is_archive_ext("Tar"));
    assert!(is_archive_ext("Cbt"));

    // Non-archive extensions
    let invalid_exts = [
        "jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "ico", "svg", "xml", "opf", "exe",
        "txt", "pdf", "bin", "gz", "bz2", "xz", "zst", "iso", "cab", "apk",
    ];
    for ext in invalid_exts {
        assert!(!is_archive_ext(ext), "Did not expect '{}' to be recognized as archive", ext);
    }

    // Partial and compound extensions
    assert!(!is_archive_ext("7zip"));
    assert!(!is_archive_ext("zipx"));
    assert!(!is_archive_ext("tar.gz"));
    assert!(!is_archive_ext(".zip"));
    assert!(!is_archive_ext(".cbz"));
    assert!(!is_archive_ext(".7z"));

    // Edge cases: empty, whitespace
    assert!(!is_archive_ext(""));
    assert!(!is_archive_ext(" "));
    assert!(!is_archive_ext("   "));
    assert!(!is_archive_ext("\t"));
    assert!(!is_archive_ext("7Z "));
    assert!(!is_archive_ext(" zip"));
    assert!(!is_archive_ext(" cbz "));
    assert!(!is_archive_ext("\ttar\n"));
}

#[test]
fn test_is_metadata_ext() {
    // Valid cases (case insensitive)
    assert!(is_metadata_ext("xml"));
    assert!(is_metadata_ext("XML"));
    assert!(is_metadata_ext("Xml"));
    assert!(is_metadata_ext("xMl"));
    assert!(is_metadata_ext("opf"));
    assert!(is_metadata_ext("OPF"));
    assert!(is_metadata_ext("OpF"));
    assert!(is_metadata_ext("oPf"));

    // Invalid non-metadata extensions
    let invalid_exts = [
        "jpg", "png", "zip", "cbz", "rar", "7z", "json", "yaml", "yml", "toml", "txt", "html",
        "nfo", "exe",
    ];
    for ext in invalid_exts {
        assert!(!is_metadata_ext(ext), "Did not expect '{}' to be recognized as metadata", ext);
    }

    // Affixes and dotted forms
    assert!(!is_metadata_ext(".xml"));
    assert!(!is_metadata_ext(".opf"));
    assert!(!is_metadata_ext("xml2"));
    assert!(!is_metadata_ext("xxml"));
    assert!(!is_metadata_ext("opfx"));

    // Edge cases: empty, whitespace
    assert!(!is_metadata_ext(""));
    assert!(!is_metadata_ext(" "));
    assert!(!is_metadata_ext("\t"));
    assert!(!is_metadata_ext("xml "));
    assert!(!is_metadata_ext(" xml"));
    assert!(!is_metadata_ext(" opf "));
    assert!(!is_metadata_ext("\nopf\t"));
}

#[test]
fn test_supported_formats_table_integrity() {
    assert!(!SUPPORTED_FORMATS.is_empty(), "SUPPORTED_FORMATS must not be empty");

    let mut seen_exts = HashSet::new();
    for fmt in SUPPORTED_FORMATS {
        assert!(!fmt.ext.is_empty(), "Format extension must not be empty");
        assert_eq!(
            fmt.ext,
            fmt.ext.to_lowercase(),
            "Format extension '{}' must be stored lowercase",
            fmt.ext
        );
        assert_eq!(
            fmt.ext,
            fmt.ext.trim(),
            "Format extension '{}' must not contain whitespace",
            fmt.ext
        );
        assert!(!fmt.ext.starts_with('.'), "Format extension '{}' must not have leading dot", fmt.ext);
        assert!(!fmt.name.is_empty(), "Format name for '{}' must not be empty", fmt.ext);
        assert!(
            fmt.icon.ends_with(".ico"),
            "Format icon '{}' for '{}' must end with .ico",
            fmt.icon,
            fmt.ext
        );

        assert!(
            seen_exts.insert(fmt.ext),
            "Duplicate format extension '{}' in SUPPORTED_FORMATS",
            fmt.ext
        );

        match fmt.category {
            FormatCategory::Image => {
                assert!(
                    is_image_ext(fmt.ext),
                    "Category::Image format '{}' must return true from is_image_ext",
                    fmt.ext
                );
                assert!(
                    !is_archive_ext(fmt.ext),
                    "Category::Image format '{}' must return false from is_archive_ext",
                    fmt.ext
                );
            }
            FormatCategory::Archive => {
                assert!(
                    is_archive_ext(fmt.ext),
                    "Category::Archive format '{}' must return true from is_archive_ext",
                    fmt.ext
                );
                assert!(
                    !is_image_ext(fmt.ext),
                    "Category::Archive format '{}' must return false from is_image_ext",
                    fmt.ext
                );
            }
        }
    }
}

#[test]
fn test_format_icons_table_integrity() {
    assert!(!FORMAT_ICONS.is_empty(), "FORMAT_ICONS table must not be empty");

    let icon_map: std::collections::HashMap<&str, &[u8]> = FORMAT_ICONS.iter().cloned().collect();

    // Every format in SUPPORTED_FORMATS must have an embedded icon
    for fmt in SUPPORTED_FORMATS {
        let icon_bytes = icon_map.get(fmt.icon).unwrap_or_else(|| {
            panic!("Missing embedded icon '{}' for format '{}'", fmt.icon, fmt.ext)
        });
        assert!(
            !icon_bytes.is_empty(),
            "Embedded icon '{}' for '{}' must not be empty",
            fmt.icon,
            fmt.ext
        );
        // Valid ICO files start with 00 00 01 00
        assert!(
            icon_bytes.len() >= 4 && icon_bytes[..4] == [0, 0, 1, 0],
            "Embedded icon '{}' has invalid ICO header",
            fmt.icon
        );
    }
}

#[test]
fn test_archive_extension_unification_contract() {
    // 8 canonical archive formats unified across temp_archive and formats
    let expected_archives = ["zip", "cbz", "rar", "cbr", "7z", "cb7", "tar", "cbt"];

    let table_archives: Vec<&str> = SUPPORTED_FORMATS
        .iter()
        .filter(|f| f.category == FormatCategory::Archive)
        .map(|f| f.ext)
        .collect();

    assert_eq!(
        table_archives.len(),
        expected_archives.len(),
        "Archive count in SUPPORTED_FORMATS must match canonical list"
    );

    for ext in expected_archives {
        assert!(
            table_archives.contains(&ext),
            "SUPPORTED_FORMATS missing archive format '{}'",
            ext
        );
        assert!(is_archive_ext(ext), "is_archive_ext must return true for '{}'", ext);
        assert!(!is_image_ext(ext), "is_image_ext must return false for '{}'", ext);
        assert!(!is_metadata_ext(ext), "is_metadata_ext must return false for '{}'", ext);
    }
}

#[test]
fn test_shell_thumb_extensions_contract() {
    // Matches SHELL_THUMB_EXTS contract in platform/thumbnails.rs
    let shell_thumb_images = ["jpg", "jpeg", "png", "bmp", "dib", "gif", "ico"];
    for ext in shell_thumb_images {
        assert!(
            is_image_ext(ext),
            "Shell thumb extension '{}' must be recognized by is_image_ext",
            ext
        );
    }

    // Video container handled by shell thumbnails, not is_image_ext
    assert!(!is_image_ext("mp4"));
}

#[test]
fn test_format_category_display_and_as_str() {
    assert_eq!(FormatCategory::Image.as_str(), "Image");
    assert_eq!(FormatCategory::Archive.as_str(), "Archive");
    assert_eq!(format!("{}", FormatCategory::Image), "Image");
    assert_eq!(format!("{}", FormatCategory::Archive), "Archive");
}

#[test]
fn test_is_animated_svg() {
    let anim_svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><animate attributeName=\"opacity\" from=\"0\" to=\"1\" dur=\"1s\"/></svg>";
    assert!(check_animation_status(anim_svg).is_animated);

    let anim_transform_svg = b"<svg><animateTransform attributeName=\"transform\"/></svg>";
    assert!(check_animation_status(anim_transform_svg).is_animated);

    let set_svg = b"<svg><set attributeName=\"visibility\" to=\"visible\"/></svg>";
    assert!(check_animation_status(set_svg).is_animated);

    let static_svg = b"<svg viewBox=\"0 0 100 100\"><rect width=\"100\" height=\"100\"/></svg>";
    assert!(!check_animation_status(static_svg).is_animated);

    let empty_svg = b"<svg></svg>";
    assert!(!check_animation_status(empty_svg).is_animated);
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

fn make_test_png(w: u32, h: u32) -> Vec<u8> {
    use image::ImageEncoder;
    let img = image::RgbaImage::new(w, h);
    let mut out = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut out);
    encoder
        .write_image(img.as_raw(), w, h, image::ColorType::Rgba8.into())
        .expect("encode test png");
    out
}

fn make_test_gif(w: u32, h: u32) -> Vec<u8> {
    let img = image::DynamicImage::ImageRgba8(image::RgbaImage::new(w, h));
    let mut out = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut out);
    img.write_to(&mut cursor, image::ImageFormat::Gif)
        .expect("encode test gif");
    out
}

fn make_test_bmp(w: i32, h: i32) -> Vec<u8> {
    let mut out = Vec::with_capacity(54);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&54u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&54u32.to_le_bytes());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&h.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&24u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out
}

fn make_test_webp(w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::from(b"RIFF".as_ref());
    let riff_size = 4 + 4 + 4 + 5;
    out.extend_from_slice(&(riff_size as u32).to_le_bytes());
    out.extend_from_slice(b"WEBPVP8L");
    out.extend_from_slice(&5u32.to_le_bytes());
    out.push(0x2F);
    let bits: u32 = ((w - 1) & 0x3FFF) | (((h - 1) & 0x3FFF) << 14);
    out.extend_from_slice(&bits.to_le_bytes());
    out.push(0);
    out
}

fn make_test_jpeg(w: u32, h: u32) -> Vec<u8> {
    let img = image::DynamicImage::ImageRgba8(image::RgbaImage::new(w, h));
    let mut out = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut out);
    img.write_to(&mut cursor, image::ImageFormat::Jpeg)
        .expect("encode test jpeg");
    out
}

fn make_test_avif_ispe(w: u32, h: u32, rotate_90: bool) -> Vec<u8> {
    let mut out = ftyp_box(b"avif", &[*b"avif", *b"mif1"]);
    let mut ispe = Vec::new();
    ispe.extend_from_slice(&20u32.to_be_bytes());
    ispe.extend_from_slice(b"ispe");
    ispe.push(0);
    ispe.extend_from_slice(&[0, 0, 0]);
    ispe.extend_from_slice(&w.to_be_bytes());
    ispe.extend_from_slice(&h.to_be_bytes());
    out.extend_from_slice(&ispe);
    if rotate_90 {
        out.extend_from_slice(&9u32.to_be_bytes());
        out.extend_from_slice(b"irot");
        out.push(1);
    }
    // Trailer padding so byte scanning loop (i + 12 <= len) inspects trailing boxes
    out.extend_from_slice(&[0u8; 8]);
    out
}

fn make_test_ico(entries: &[(u8, u8)]) -> Vec<u8> {
    let count = entries.len();
    let mut ico = vec![0u8, 0, 1, 0, count as u8, 0];
    let mut offset = 6 + count * 16;
    for &(w, h) in entries {
        ico.push(w);
        ico.push(h);
        ico.push(0);
        ico.push(0);
        ico.extend_from_slice(&1u16.to_le_bytes());
        ico.extend_from_slice(&32u16.to_le_bytes());
        let dummy_size = 40u32;
        ico.extend_from_slice(&dummy_size.to_le_bytes());
        ico.extend_from_slice(&(offset as u32).to_le_bytes());
        offset += dummy_size as usize;
    }
    for _ in entries {
        ico.extend_from_slice(&[0u8; 40]);
    }
    ico
}

fn make_test_mp4(w: u32, h: u32) -> Vec<u8> {
    let mut mp4 = ftyp_box(b"isom", &[*b"mp41"]);
    let mut tkhd = Vec::new();
    tkhd.extend_from_slice(&0u32.to_be_bytes());
    tkhd.extend_from_slice(b"tkhd");
    tkhd.push(0);
    tkhd.extend_from_slice(&[0; 3]);
    tkhd.extend_from_slice(&[0u8; 72]);
    tkhd.extend_from_slice(&(w << 16).to_be_bytes());
    tkhd.extend_from_slice(&(h << 16).to_be_bytes());
    let tkhd_len = tkhd.len() as u32;
    tkhd[0..4].copy_from_slice(&tkhd_len.to_be_bytes());

    let mut trak = Vec::new();
    trak.extend_from_slice(&0u32.to_be_bytes());
    trak.extend_from_slice(b"trak");
    trak.extend_from_slice(&tkhd);
    let trak_len = trak.len() as u32;
    trak[0..4].copy_from_slice(&trak_len.to_be_bytes());

    let mut moov = Vec::new();
    moov.extend_from_slice(&0u32.to_be_bytes());
    moov.extend_from_slice(b"moov");
    moov.extend_from_slice(&trak);
    let moov_len = moov.len() as u32;
    moov[0..4].copy_from_slice(&moov_len.to_be_bytes());

    mp4.extend_from_slice(&moov);
    mp4
}

#[test]
fn test_read_dimensions_from_bytes_formats() {
    let png = make_test_png(120, 80);
    assert_eq!(read_dimensions_from_bytes(&png), Some((120, 80)));

    let gif = make_test_gif(64, 48);
    assert_eq!(read_dimensions_from_bytes(&gif), Some((64, 48)));

    let bmp = make_test_bmp(32, 16);
    assert_eq!(read_dimensions_from_bytes(&bmp), Some((32, 16)));

    let webp = make_test_webp(200, 150);
    assert_eq!(read_dimensions_from_bytes(&webp), Some((200, 150)));

    let jpeg = make_test_jpeg(160, 120);
    assert_eq!(read_dimensions_from_bytes(&jpeg), Some((160, 120)));
}

#[test]
fn test_read_dimensions_from_bytes_truncated_and_corrupt() {
    assert_eq!(read_dimensions_from_bytes(&[]), None);
    assert_eq!(read_dimensions_from_bytes(b"\x89PNG"), None);
    assert_eq!(read_dimensions_from_bytes(b"\x89PNG\r\n\x1a\n"), None);
    assert_eq!(read_dimensions_from_bytes(b"GIF89a"), None);
    assert_eq!(read_dimensions_from_bytes(b"BM"), None);
    assert_eq!(read_dimensions_from_bytes(b"RIFF\x10\0\0\0WEBP"), None);
    assert_eq!(read_dimensions_from_bytes(&[0xFF, 0xD8]), None);
    assert_eq!(read_dimensions_from_bytes(&[0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x02]), None);
    assert_eq!(read_dimensions_from_bytes(b"not an image data buffer"), None);
}

#[test]
fn test_read_media_dimensions_from_stream_svg() {
    use std::io::Cursor;

    let svg1 = br#"<svg width="300" height="150" xmlns="http://www.w3.org/2000/svg"></svg>"#;
    let mut c1 = Cursor::new(svg1);
    assert_eq!(
        read_media_dimensions_from_stream(&mut c1, svg1.len() as u64, "svg"),
        Some((300, 150))
    );

    let svg2 = br#"<svg   width = " 120px "   height = ' 80px ' ></svg>"#;
    let mut c2 = Cursor::new(svg2);
    assert_eq!(
        read_media_dimensions_from_stream(&mut c2, svg2.len() as u64, "svg"),
        Some((120, 80))
    );

    let svg3 = br#"<svg viewBox="0 0 450 320" xmlns="http://www.w3.org/2000/svg"></svg>"#;
    let mut c3 = Cursor::new(svg3);
    assert_eq!(
        read_media_dimensions_from_stream(&mut c3, svg3.len() as u64, "svg"),
        Some((450, 320))
    );

    let svg_pct = br#"<svg width="100%" height="100%"></svg>"#;
    let mut c_pct = Cursor::new(svg_pct);
    assert_eq!(
        read_media_dimensions_from_stream(&mut c_pct, svg_pct.len() as u64, "svg"),
        None
    );

    let svg_empty = br#"<svg></svg>"#;
    let mut c_empty = Cursor::new(svg_empty);
    assert_eq!(
        read_media_dimensions_from_stream(&mut c_empty, svg_empty.len() as u64, "svg"),
        None
    );

    let svg_trunc = br#"<svg width="100"#;
    let mut c_trunc = Cursor::new(svg_trunc);
    assert_eq!(
        read_media_dimensions_from_stream(&mut c_trunc, svg_trunc.len() as u64, "svg"),
        None
    );
}

#[test]
fn test_read_media_dimensions_from_stream_avif() {
    use std::io::Cursor;

    let avif = make_test_avif_ispe(1920, 1080, false);
    let mut c = Cursor::new(&avif);
    assert_eq!(
        read_media_dimensions_from_stream(&mut c, avif.len() as u64, "avif"),
        Some((1920, 1080))
    );

    let avif_rot = make_test_avif_ispe(1920, 1080, true);
    let mut c_rot = Cursor::new(&avif_rot);
    assert_eq!(
        read_media_dimensions_from_stream(&mut c_rot, avif_rot.len() as u64, "avif"),
        Some((1080, 1920))
    );

    let mut c_trunc = Cursor::new(&avif[..16]);
    assert_eq!(
        read_media_dimensions_from_stream(&mut c_trunc, 16, "avif"),
        None
    );
}

#[test]
fn test_read_media_dimensions_from_stream_ico() {
    use std::io::Cursor;

    let ico1 = make_test_ico(&[(32, 32)]);
    let mut c1 = Cursor::new(&ico1);
    assert_eq!(
        read_media_dimensions_from_stream(&mut c1, ico1.len() as u64, "ico"),
        Some((32, 32))
    );

    let ico_multi = make_test_ico(&[(16, 16), (48, 48)]);
    let mut c_multi = Cursor::new(&ico_multi);
    assert_eq!(
        read_media_dimensions_from_stream(&mut c_multi, ico_multi.len() as u64, "ico"),
        Some((64, 48))
    );

    let mut c_trunc = Cursor::new(&ico1[..4]);
    assert_eq!(
        read_media_dimensions_from_stream(&mut c_trunc, 4, "ico"),
        None
    );
}

#[test]
fn test_read_media_dimensions_from_stream_mp4() {
    use std::io::Cursor;

    let mp4 = make_test_mp4(1280, 720);
    let mut c_seek = Cursor::new(&mp4);
    assert_eq!(read_mp4_dimensions(&mut c_seek), Some((1280, 720)));

    let mut c = Cursor::new(&mp4);
    assert_eq!(
        read_media_dimensions_from_stream(&mut c, mp4.len() as u64, "mp4"),
        Some((1280, 720))
    );

    let mut c_zero = Cursor::new(&mp4);
    assert_eq!(
        read_media_dimensions_from_stream(&mut c_zero, 0, "mp4"),
        None
    );

    let mp4_bare = ftyp_box(b"isom", &[*b"mp41"]);
    let mut c_bare = Cursor::new(&mp4_bare);
    assert_eq!(
        read_media_dimensions_from_stream(&mut c_bare, mp4_bare.len() as u64, "mp4"),
        None
    );
}

#[test]
fn test_read_media_dimensions_from_stream_jpeg_large_header() {
    use std::io::Cursor;

    let mut jpeg = Vec::new();
    jpeg.extend_from_slice(&[0xFF, 0xD8]);
    jpeg.extend_from_slice(&[0xFF, 0xE1]);
    let app1_len = 502u16;
    jpeg.extend_from_slice(&app1_len.to_be_bytes());
    jpeg.extend_from_slice(&vec![0xAA; 500]);
    jpeg.extend_from_slice(&[0xFF, 0xC0]);
    let sof_len = 11u16;
    jpeg.extend_from_slice(&sof_len.to_be_bytes());
    jpeg.push(8);
    jpeg.extend_from_slice(&240u16.to_be_bytes());
    jpeg.extend_from_slice(&320u16.to_be_bytes());
    jpeg.push(1);
    jpeg.extend_from_slice(&[1, 0x11, 0]);
    jpeg.extend_from_slice(&[0xFF, 0xD9]);

    let mut c = Cursor::new(&jpeg);
    assert_eq!(
        read_media_dimensions_from_stream(&mut c, jpeg.len() as u64, "jpg"),
        Some((320, 240))
    );
}

#[test]
fn test_read_media_dimensions_from_path() {
    let scratch_dir = std::env::temp_dir().join("quivit-test-media-dims-path");
    let _ = std::fs::remove_dir_all(&scratch_dir);
    std::fs::create_dir_all(&scratch_dir).expect("create scratch dir");

    let png_path = scratch_dir.join("test.png");
    std::fs::write(&png_path, make_test_png(88, 44)).expect("write png");
    assert_eq!(read_media_dimensions_from_path(&png_path, "png"), Some((88, 44)));

    let jpg_path = scratch_dir.join("test.jpg");
    std::fs::write(&jpg_path, make_test_jpeg(100, 50)).expect("write jpg");
    assert_eq!(read_media_dimensions_from_path(&jpg_path, "jpg"), Some((100, 50)));

    let svg_path = scratch_dir.join("test.svg");
    std::fs::write(&svg_path, br#"<svg width="220" height="110"></svg>"#).expect("write svg");
    assert_eq!(read_media_dimensions_from_path(&svg_path, "svg"), Some((220, 110)));

    let ico_path = scratch_dir.join("test.ico");
    std::fs::write(&ico_path, make_test_ico(&[(48, 48)])).expect("write ico");
    assert_eq!(read_media_dimensions_from_path(&ico_path, "ico"), Some((48, 48)));

    let avif_path = scratch_dir.join("test.avif");
    std::fs::write(&avif_path, make_test_avif_ispe(800, 600, false)).expect("write avif");
    assert_eq!(read_media_dimensions_from_path(&avif_path, "avif"), Some((800, 600)));

    let mp4_path = scratch_dir.join("test.mp4");
    std::fs::write(&mp4_path, make_test_mp4(640, 360)).expect("write mp4");
    assert_eq!(read_media_dimensions_from_path(&mp4_path, "mp4"), Some((640, 360)));

    let empty_path = scratch_dir.join("empty.png");
    std::fs::write(&empty_path, b"").expect("write empty");
    assert_eq!(read_media_dimensions_from_path(&empty_path, "png"), None);

    let missing_path = scratch_dir.join("missing.png");
    assert_eq!(read_media_dimensions_from_path(&missing_path, "png"), None);

    let _ = std::fs::remove_dir_all(&scratch_dir);
}
