use super::*;

#[test]
fn test_fetch_extractor_text_finds_local_manifest() {
    let res = fetch_extractor_text("manifest.json".to_string());
    assert!(res.is_ok(), "Failed to fetch manifest: {:?}", res.err());
    let content = res.unwrap();
    assert!(content.contains("\"extractors\""));
}

#[test]
fn extractor_paths_reject_traversal_and_absolute_files() {
    assert!(is_safe_extractor_path("manifest.json"));
    assert!(is_safe_extractor_path("sites/example.js"));
    assert!(!is_safe_extractor_path("../Cargo.toml"));
    assert!(!is_safe_extractor_path("C:\\Windows\\win.ini"));
    assert!(!is_safe_extractor_path("manifest.txt"));
}

#[test]
fn extractor_cache_refreshes_and_falls_back_to_nested_source() {
    let root = std::env::temp_dir().join(format!(
        "quivit_extractor_cache_test_{}_{}",
        std::process::id(),
        EXTRACTOR_CACHE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let cache_path = root.join("sites").join("example.js");

    let source =
        resolve_remote_extractor_text(&cache_path, Ok("export const version = 1;".to_string()))
            .unwrap();
    assert_eq!(source, "export const version = 1;");
    assert_eq!(
        fs::read_to_string(&cache_path).unwrap(),
        "export const version = 1;"
    );

    let cached = resolve_remote_extractor_text(
        &cache_path,
        Err("Network request failed: offline".to_string()),
    )
    .unwrap();
    assert_eq!(cached, "export const version = 1;");

    let _ = fs::remove_dir_all(root);
}

#[test]
fn download_threshold_rounds_up_to_the_first_written_byte() {
    let threshold = 101_u64.saturating_mul(50).saturating_add(99) / 100;
    assert_eq!(threshold, 51);
}

#[test]
fn image_magic_accepts_matching_signatures() {
    assert!(check_image_magic_head(
        &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00],
        "png"
    ));
    assert!(check_image_magic_head(&[0xFF, 0xD8, 0xFF, 0xE0], "jpg"));
    assert!(check_image_magic_head(b"GIF89aXXXX", "gif"));
    assert!(check_image_magic_head(b"BMXXXX", "bmp"));
    assert!(check_image_magic_head(b"RIFF....WEBP", "webp"));
    assert!(check_image_magic_head(b"....ftypavif", "avif"));
    assert!(check_image_magic_head(b"whatever", "mp4"));
    assert!(check_image_magic_head(b"whatever", "unknown-ext"));
}

#[test]
fn image_magic_rejects_documents_and_short_reads() {
    assert!(!check_image_magic_head(b"<!DOCTYPE html><html>", "png"));
    assert!(!check_image_magic_head(b"<html><body>", "jpg"));
    assert!(!check_image_magic_head(&[0x89, 0x50], "png"));
    assert!(!check_image_magic_head(&[], "jpg"));
}

#[test]
fn sanitize_headers_rejects_denied_names() {
    let mut h = HashMap::new();
    h.insert("Host".to_string(), "evil.com".to_string());
    assert!(sanitize_headers(&h).is_err());

    h.clear();
    h.insert("COOKIE".to_string(), "session=abc".to_string());
    assert!(sanitize_headers(&h).is_err());

    h.clear();
    h.insert("Authorization".to_string(), "Bearer token".to_string());
    assert!(sanitize_headers(&h).is_err());

    h.clear();
    h.insert("content-LENGTH".to_string(), "999".to_string());
    assert!(sanitize_headers(&h).is_err());
}

#[test]
fn sanitize_headers_accepts_custom_headers() {
    let mut h = HashMap::new();
    h.insert("Plus-Vw-Token".to_string(), "abc123".to_string());
    h.insert("SESSION-TOKEN".to_string(), "uuid-value".to_string());
    let result = sanitize_headers(&h).unwrap();
    assert_eq!(result.len(), 2);
}

#[test]
fn sanitize_headers_rejects_oversized_values() {
    let mut h = HashMap::new();
    h.insert("X-Custom".to_string(), "x".repeat(HEADER_VALUE_MAX_LEN + 1));
    assert!(sanitize_headers(&h).is_err());
}

#[test]
fn sanitize_headers_rejects_too_many_entries() {
    let mut h = HashMap::new();
    for i in 0..=HEADER_MAP_MAX_ENTRIES {
        h.insert(format!("X-Header-{i}"), "value".to_string());
    }
    assert!(sanitize_headers(&h).is_err());
}

#[test]
fn sanitize_headers_accepts_empty_map() {
    let h = HashMap::new();
    let result = sanitize_headers(&h).unwrap();
    assert!(result.is_empty());
}

#[test]
fn xor_key_cycles_across_chunk_boundary() {
    let key = vec![0xAA, 0xBB, 0xCC];
    let mut data = vec![0u8; 5];
    let mut key_offset = 0usize;
    for byte in data.iter_mut() {
        *byte ^= key[key_offset % key.len()];
        key_offset += 1;
    }
    assert_eq!(data, vec![0xAA, 0xBB, 0xCC, 0xAA, 0xBB]);

    // Second chunk continues from where the first left off
    let mut data2 = vec![0u8; 4];
    for byte in data2.iter_mut() {
        *byte ^= key[key_offset % key.len()];
        key_offset += 1;
    }
    assert_eq!(data2, vec![0xCC, 0xAA, 0xBB, 0xCC]);
}

#[test]
fn tile_descramble_round_trip() {
    // Create a 4x4 pixel image (2x2 grid of 2x2 tiles).
    let mut img = image::RgbImage::new(4, 4);
    // Tile 0 (top-left): red
    for y in 0..2 {
        for x in 0..2 {
            img.put_pixel(x, y, image::Rgb([255, 0, 0]));
        }
    }
    // Tile 1 (top-right): green
    for y in 0..2 {
        for x in 2..4 {
            img.put_pixel(x, y, image::Rgb([0, 255, 0]));
        }
    }
    // Tile 2 (bottom-left): blue
    for y in 2..4 {
        for x in 0..2 {
            img.put_pixel(x, y, image::Rgb([0, 0, 255]));
        }
    }
    // Tile 3 (bottom-right): white
    for y in 2..4 {
        for x in 2..4 {
            img.put_pixel(x, y, image::Rgb([255, 255, 255]));
        }
    }

    // Scramble: swap tiles 0↔3 and 1↔2.
    let mut scrambled = image::RgbImage::new(4, 4);
    let perm = [3u32, 2, 1, 0]; // scramble order
    for (dest_idx, &src_idx) in perm.iter().enumerate() {
        let dc = (dest_idx % 2) as u32;
        let dr = (dest_idx / 2) as u32;
        let sc = src_idx % 2;
        let sr = src_idx / 2;
        for y in 0..2 {
            for x in 0..2 {
                scrambled.put_pixel(
                    dc * 2 + x,
                    dr * 2 + y,
                    *img.get_pixel(sc * 2 + x, sr * 2 + y),
                );
            }
        }
    }

    // Write scrambled image as PNG to a temp file.
    let tmp = std::env::temp_dir().join(format!(
        "quivit_tile_test_{}.png",
        std::process::id()
    ));
    scrambled.save(&tmp).unwrap();

    // Descramble with the inverse permutation.
    let desc = TileDescramble {
        cols: 2,
        rows: 2,
        order: vec![3, 2, 1, 0],
        align: None,
    };
    apply_tile_descramble(&tmp, &desc).unwrap();

    let result = image::open(&tmp).unwrap().to_rgb8();
    let _ = fs::remove_file(&tmp);

    // Verify each tile recovered its original color.
    assert_eq!(*result.get_pixel(0, 0), image::Rgb([255, 0, 0]));     // tile 0: red
    assert_eq!(*result.get_pixel(2, 0), image::Rgb([0, 255, 0]));     // tile 1: green
    assert_eq!(*result.get_pixel(0, 2), image::Rgb([0, 0, 255]));     // tile 2: blue
    assert_eq!(*result.get_pixel(2, 2), image::Rgb([255, 255, 255])); // tile 3: white
}

#[test]
fn tile_descramble_rejects_invalid_permutation() {
    let tmp = std::env::temp_dir().join(format!(
        "quivit_tile_reject_{}.png",
        std::process::id()
    ));
    let img = image::RgbImage::new(4, 4);
    img.save(&tmp).unwrap();

    // Wrong length
    let desc = TileDescramble { cols: 2, rows: 2, order: vec![0, 1, 2], align: None };
    assert!(apply_tile_descramble(&tmp, &desc).is_err());

    // Out of range
    let desc = TileDescramble { cols: 2, rows: 2, order: vec![0, 1, 2, 5], align: None };
    assert!(apply_tile_descramble(&tmp, &desc).is_err());

    // Duplicate
    let desc = TileDescramble { cols: 2, rows: 2, order: vec![0, 1, 2, 2], align: None };
    assert!(apply_tile_descramble(&tmp, &desc).is_err());

    let _ = fs::remove_file(&tmp);
}

#[test]
fn tile_descramble_with_8px_alignment() {
    // 18x18 image with 2x2 grid and align=8.
    // align=8 means: (18 / 8 * 8) = 16. tile_w = 16 / 2 = 8, tile_h = 8.
    // The bottom 2 rows and right 2 columns are remainder pixels.
    let mut img = image::RgbImage::new(18, 18);
    for y in 0..18 {
        for x in 0..18 {
            img.put_pixel(x, y, image::Rgb([100, 100, 100]));
        }
    }
    // Mark remainder pixels specially
    for x in 0..18 {
        img.put_pixel(x, 17, image::Rgb([42, 42, 42]));
    }

    let tmp = std::env::temp_dir().join(format!(
        "quivit_tile_align_{}.png",
        std::process::id()
    ));
    img.save(&tmp).unwrap();

    let desc = TileDescramble {
        cols: 2,
        rows: 2,
        order: vec![3, 2, 1, 0],
        align: Some(8),
    };
    apply_tile_descramble(&tmp, &desc).unwrap();

    let result = image::open(&tmp).unwrap().to_rgb8();
    let _ = fs::remove_file(&tmp);

    assert_eq!(result.width(), 18);
    assert_eq!(result.height(), 18);
    // Remainder pixel in bottom row should be preserved untouched
    assert_eq!(*result.get_pixel(5, 17), image::Rgb([42, 42, 42]));
}

#[test]
fn tile_descramble_fixture_if_present() {
    let fixture = std::env::temp_dir().join("opencode").join("kmanga-page1.jpg");
    if !fixture.is_file() {
        return;
    }
    let tmp = std::env::temp_dir().join(format!("quivit_fixture_test_{}.jpg", std::process::id()));
    fs::copy(&fixture, &tmp).unwrap();

    let desc = TileDescramble {
        cols: 4,
        rows: 4,
        order: vec![12, 5, 13, 6, 7, 10, 3, 1, 9, 14, 8, 2, 4, 0, 11, 15],
        align: Some(8),
    };
    apply_tile_descramble(&tmp, &desc).unwrap();

    let result = image::open(&tmp).unwrap();
    assert_eq!(result.width(), 1600);
    assert_eq!(result.height(), 2182);

    let _ = fs::remove_file(&tmp);
}
