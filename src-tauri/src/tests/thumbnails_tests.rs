use image::GenericImageView;

#[test]
fn shell_thumbnail_png_serves_valid_image() {
    // This test only runs on Windows where shell thumbnails are available
    #[cfg(not(windows))]
    return;

    let path = r"E:\Projects\QuiviT\test-files\export_1785518878919.png";
    if !std::path::Path::new(path).exists() {
        eprintln!("test file not found, skipping: {}", path);
        return;
    }

    let result = crate::platform::thumbnails::get_shell_thumbnail_png(path, 96);
    match result {
        Ok(Some(bytes)) => {
            assert!(!bytes.is_empty(), "thumbnail bytes should not be empty");
            let img = image::load_from_memory(&bytes).expect("decode thumb png");
            let (w, h) = img.dimensions();
            assert!(w > 0 && h > 0, "thumbnail dimensions should be non-zero");
        }
        Ok(None) => {
            // Valid: shell cache empty, or matte detection rejected a transparent PNG
            eprintln!("test PNG returned Ok(None), shell cache may be empty or matte detected");
        }
        Err(e) => {
            panic!("get_shell_thumbnail_png failed: {}", e);
        }
    }
}

#[test]
fn shell_thumbnail_jpg_is_opaque() {
    #[cfg(not(windows))]
    return;
    // Use a known opaque jpg if exists, else skip
    let candidates = [
        r"E:\Projects\QuiviT\test-files\a.jpg",
        r"E:\Projects\QuiviT\test-files\sample.jpg",
    ];
    let path = candidates.iter().find(|p| std::path::Path::new(p).exists());
    if path.is_none() {
        eprintln!("no jpg test file found, skipping");
        return;
    }
    let path = path.unwrap();
    let result = crate::platform::thumbnails::get_shell_thumbnail_png(path, 96);
    if let Ok(Some(bytes)) = result {
        let img = image::load_from_memory(&bytes).unwrap().to_rgba8();
        let opaque = img.pixels().filter(|p| p[3] == 255).count();
        let total = (img.width() * img.height()) as usize;
        eprintln!("jpg thumb opaque {}/{} ({:.1}%)", opaque, total, opaque as f32 / total as f32 * 100.0);
        // jpg should be fully opaque
        assert!(opaque > total * 95 / 100, "jpg thumb should be mostly opaque");
    }
}

#[test]
fn shell_thumbnail_rejects_animated_gif() {
    #[cfg(not(windows))]
    return;

    let path = r"E:\Projects\QuiviT\test-files\gif\pixiv_final-gif.gif";
    if !std::path::Path::new(path).exists() {
        eprintln!("test file not found, skipping: {}", path);
        return;
    }

    let result = crate::platform::thumbnails::get_shell_thumbnail_png(path, 96);
    match result {
        Ok(None) => {} // animated GIF correctly bypassed
        Ok(Some(_)) => panic!("animated GIF should return Ok(None), not a thumbnail"),
        Err(e) => panic!("get_shell_thumbnail_png failed: {}", e),
    }
}

#[test]
fn shell_thumbnail_accepts_static_gif() {
    #[cfg(not(windows))]
    return;

    let path = r"E:\Projects\QuiviT\test-files\gif\single-frame.gif";
    if !std::path::Path::new(path).exists() {
        eprintln!("test file not found, skipping: {}", path);
        return;
    }

    let result = crate::platform::thumbnails::get_shell_thumbnail_png(path, 96);
    match result {
        Ok(Some(bytes)) => {
            assert!(!bytes.is_empty(), "static GIF thumbnail should not be empty");
        }
        Ok(None) => {
            // Shell has no cached thumbnail for this file, acceptable
            eprintln!("static GIF returned Ok(None), shell cache may be empty");
        }
        Err(e) => panic!("get_shell_thumbnail_png failed: {}", e),
    }
}

#[test]
fn source_transparency_detects_rgba_png() {
    #[cfg(not(windows))]
    return;

    let path = r"E:\Projects\QuiviT\test-files\export_1785518878919.png";
    if !std::path::Path::new(path).exists() {
        eprintln!("test file not found, skipping: {}", path);
        return;
    }

    // This PNG has RGBA color type (6), so source_has_transparency should be true
    let result = crate::platform::thumbnails::source_has_transparency(path, "png");
    assert!(result, "RGBA PNG should be detected as transparent");
}

#[test]
fn source_transparency_detects_opaque_jpg() {
    #[cfg(not(windows))]
    return;

    let candidates = [
        r"E:\Projects\QuiviT\test-files\BAKEMONOGATARI - c013 (v03) - p002 [Kodansha Comics] [Digital] [1r0n] {HQ}.jpg",
    ];
    let path = candidates.iter().find(|p| std::path::Path::new(p).exists());
    if path.is_none() {
        eprintln!("no jpg test file found, skipping");
        return;
    }

    let result = crate::platform::thumbnails::source_has_transparency(path.unwrap(), "jpg");
    assert!(!result, "JPG should never be detected as transparent");
}

#[test]
fn shell_thumbnail_transparent_png_not_black_matte() {
    #[cfg(not(windows))]
    return;

    let path = r"E:\Projects\QuiviT\test-files\export_1785518878919.png";
    if !std::path::Path::new(path).exists() {
        eprintln!("test file not found, skipping: {}", path);
        return;
    }

    let result = crate::platform::thumbnails::get_shell_thumbnail_png(path, 96);
    match result {
        Ok(Some(bytes)) => {
            // Shell returned a thumbnail for a transparent PNG, verify it has alpha
            let img = image::load_from_memory(&bytes).unwrap().to_rgba8();
            let has_transparent = img.pixels().any(|p| p[3] < 255);
            assert!(has_transparent, "thumbnail of transparent PNG should have alpha pixels");
        }
        Ok(None) => {
            // Shell had no cached thumbnail or matte was detected, both acceptable
            eprintln!("transparent PNG returned Ok(None), shell cache may be empty or matte detected");
        }
        Err(e) => panic!("get_shell_thumbnail_png failed: {}", e),
    }
}
