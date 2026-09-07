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
            panic!("expected shell thumbnail for test PNG, got Ok(None)");
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
