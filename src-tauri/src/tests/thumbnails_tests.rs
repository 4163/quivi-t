#[cfg(windows)]
mod windows_tests {
    use super::super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(prefix: &str) -> Self {
            let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "quivit-thumb-test-{prefix}-{}-{n}",
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

    fn synthetic_png(color_type: u8, extra_before_idat: Option<(&[u8; 4], &[u8])>, extra_after_idat: Option<(&[u8; 4], &[u8])>) -> Vec<u8> {
        let mut buf = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut ihdr = vec![0u8; 13];
        ihdr[3] = 1; // width = 1
        ihdr[7] = 1; // height = 1
        ihdr[8] = 8; // bit depth = 8
        ihdr[9] = color_type;
        buf.extend_from_slice(&png_chunk(b"IHDR", &ihdr));
        if let Some((t, d)) = extra_before_idat {
            buf.extend_from_slice(&png_chunk(t, d));
        }
        buf.extend_from_slice(&png_chunk(b"IDAT", &[0u8; 4]));
        if let Some((t, d)) = extra_after_idat {
            buf.extend_from_slice(&png_chunk(t, d));
        }
        buf
    }

    #[test]
    fn has_black_matte_border_thresholds() {
        // 1x1 -> false
        assert!(!has_black_matte_border(&[0, 0, 0, 255], 1, 1));

        // 4x4 has 12 border pixels.
        // All white border -> false
        let white = vec![255u8; 4 * 4 * 4];
        assert!(!has_black_matte_border(&white, 4, 4));

        // 5/12 = 41% (> 40%) -> true
        let mut over = white.clone();
        for x in 0..4 {
            let off = x * 4;
            over[off..off + 3].copy_from_slice(&[0, 0, 0]);
        }
        // 5th border pixel at (0, 3)
        let off5 = (3 * 4) * 4;
        over[off5..off5 + 3].copy_from_slice(&[0, 0, 0]);
        assert!(has_black_matte_border(&over, 4, 4));

        // 4/12 = 33% (<= 40%) -> false
        let mut under = white.clone();
        for x in 0..4 {
            let off = x * 4;
            under[off..off + 3].copy_from_slice(&[0, 0, 0]);
        }
        assert!(!has_black_matte_border(&under, 4, 4));
    }

    #[test]
    fn png_has_alpha_detects_color_types_and_trns() {
        assert!(png_has_alpha(&synthetic_png(6, None, None)));
        assert!(png_has_alpha(&synthetic_png(4, None, None)));
        assert!(!png_has_alpha(&synthetic_png(2, None, None)));
        assert!(png_has_alpha(&synthetic_png(3, Some((b"tRNS", &[0])), None)));
        assert!(!png_has_alpha(&synthetic_png(3, None, Some((b"tRNS", &[0])))));
        assert!(!png_has_alpha(b"\x89PNG\r\n\x1a\nshort"));
    }

    #[test]
    fn gif_has_transparency_parses_gce_and_gct() {
        // GCE with transparent flag set (packed = 0x01), no GCT
        let mut with_trans = b"GIF89a\x01\x00\x01\x00\x00\x00\x00".to_vec();
        with_trans.extend_from_slice(&[0x21, 0xF9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3B]);
        assert!(gif_has_transparency(&with_trans));

        // GCE with transparent flag off (packed = 0x00)
        let mut without_trans = b"GIF89a\x01\x00\x01\x00\x00\x00\x00".to_vec();
        without_trans.extend_from_slice(&[0x21, 0xF9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3B]);
        assert!(!gif_has_transparency(&without_trans));

        // GCT present (flags = 0x80 -> 2 colors * 3 = 6 bytes) followed by GCE with transparent bit
        let mut with_gct = b"GIF89a\x01\x00\x01\x00\x80\x00\x00".to_vec();
        with_gct.extend_from_slice(&[0u8; 6]);
        with_gct.extend_from_slice(&[0x21, 0xF9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3B]);
        assert!(gif_has_transparency(&with_gct));

        // No GCE (image descriptor immediately)
        let no_gce = b"GIF89a\x01\x00\x01\x00\x00\x00\x00\x2C\x00\x00\x00\x00\x01\x00\x01\x00\x00\x3B";
        assert!(!gif_has_transparency(no_gce));

        // Truncated
        assert!(!gif_has_transparency(b"GIF89a"));
    }

    #[test]
    fn ico_has_alpha_checks_bpp_and_structure() {
        let mut ico_32 = vec![0u8, 0, 1, 0, 1, 0];
        let mut entry = [0u8; 16];
        entry[0] = 16;
        entry[1] = 16;
        entry[6] = 32; // 32bpp
        ico_32.extend_from_slice(&entry);
        assert!(ico_has_alpha(&ico_32));

        let mut ico_24 = vec![0u8, 0, 1, 0, 1, 0];
        entry[6] = 24;
        ico_24.extend_from_slice(&entry);
        assert!(!ico_has_alpha(&ico_24));

        // Invalid / truncated
        assert!(!ico_has_alpha(&[]));
        assert!(!ico_has_alpha(&[0, 0, 2, 0, 1, 0]));
        assert!(!ico_has_alpha(&[0, 0, 1, 0, 1, 0, 16, 16]));
    }

    fn synthetic_tiff_header(little_endian: bool, has_extra_samples: bool) -> Vec<u8> {
        let mut buf = Vec::new();
        let push_u16 = |b: &mut Vec<u8>, v: u16| {
            if little_endian {
                b.extend_from_slice(&v.to_le_bytes());
            } else {
                b.extend_from_slice(&v.to_be_bytes());
            }
        };
        let push_u32 = |b: &mut Vec<u8>, v: u32| {
            if little_endian {
                b.extend_from_slice(&v.to_le_bytes());
            } else {
                b.extend_from_slice(&v.to_be_bytes());
            }
        };

        if little_endian {
            buf.extend_from_slice(&[0x49, 0x49, 0x2A, 0x00]);
        } else {
            buf.extend_from_slice(&[0x4D, 0x4D, 0x00, 0x2A]);
        }
        push_u32(&mut buf, 8); // IFD offset
        let tags: &[u16] = if has_extra_samples { &[256, 338] } else { &[256, 257] };
        push_u16(&mut buf, tags.len() as u16);
        for &tag in tags {
            push_u16(&mut buf, tag);
            push_u16(&mut buf, 3); // SHORT
            push_u32(&mut buf, 1);
            push_u32(&mut buf, 1);
        }
        push_u32(&mut buf, 0);
        buf
    }

    #[test]
    fn tiff_has_alpha_checks_le_be_and_invalid() {
        assert!(tiff_has_alpha(&synthetic_tiff_header(true, true)));
        assert!(!tiff_has_alpha(&synthetic_tiff_header(true, false)));
        assert!(tiff_has_alpha(&synthetic_tiff_header(false, true)));
        assert!(!tiff_has_alpha(&synthetic_tiff_header(false, false)));
        assert!(!tiff_has_alpha(b"not-a-tiff"));
        assert!(!tiff_has_alpha(&[0x49, 0x49, 0x2A, 0x00]));
    }

    #[test]
    fn source_has_transparency_reads_files_and_ignores_unsupported() {
        let dir = TempDir::new("src-alpha");
        let rgba_path = dir.0.join("rgba.png");
        let rgb_path = dir.0.join("rgb.png");
        let jpg_path = dir.0.join("photo.jpg");

        std::fs::write(&rgba_path, synthetic_png(6, None, None)).unwrap();
        std::fs::write(&rgb_path, synthetic_png(2, None, None)).unwrap();
        std::fs::write(&jpg_path, b"\xFF\xD8\xFF\xD9").unwrap();

        assert!(source_has_transparency(rgba_path.to_str().unwrap(), "png"));
        assert!(!source_has_transparency(rgb_path.to_str().unwrap(), "png"));
        assert!(!source_has_transparency(jpg_path.to_str().unwrap(), "jpg"));
        assert!(!source_has_transparency(
            dir.0.join("missing.png").to_str().unwrap(),
            "png"
        ));
    }

    #[test]
    fn get_shell_thumbnail_png_returns_none_for_unsupported_missing_and_animated_gif() {
        let dir = TempDir::new("shell-thumb");
        let txt_path = dir.0.join("notes.txt");
        std::fs::write(&txt_path, b"hello").unwrap();

        assert_eq!(
            get_shell_thumbnail_png(txt_path.to_str().unwrap(), 96).expect("txt ok"),
            None
        );

        let missing_png = dir.0.join("missing.png");
        assert_eq!(
            get_shell_thumbnail_png(missing_png.to_str().unwrap(), 96).expect("missing ok"),
            None
        );

        let anim_gif = repo_test_file("animated/pixiv_final-gif.gif");
        assert!(anim_gif.exists(), "missing fixture: {}", anim_gif.display());
        assert_eq!(
            get_shell_thumbnail_png(anim_gif.to_str().unwrap(), 96).expect("anim gif ok"),
            None
        );
    }
}
