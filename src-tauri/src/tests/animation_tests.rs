use super::*;
use std::path::PathBuf;

fn repo_test_file(rel: &str) -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("test-files")
        .join(rel)
}

#[test]
fn skip_for_width_scan_filters_svg_and_ico_case_insensitively() {
    for ext in ["svg", "SVG", "Svg", "ico", "ICO", "Ico"] {
        assert!(skip_for_width_scan(ext), "expected {ext} to be skipped");
    }
    for ext in ["png", "jpg", "jpeg", "mp4", "tif", "tiff", "webp", "avif", ""] {
        assert!(!skip_for_width_scan(ext), "expected {ext} not to be skipped");
    }
}

#[test]
fn cancel_scan_commands_increment_generation_counters() {
    let width_before = SCAN_GENERATION.load(Ordering::SeqCst);
    cancel_width_scan();
    assert_eq!(SCAN_GENERATION.load(Ordering::SeqCst), width_before + 1);

    let dims_before = DIMS_SCAN_GENERATION.load(Ordering::SeqCst);
    cancel_dims_scan();
    assert_eq!(DIMS_SCAN_GENERATION.load(Ordering::SeqCst), dims_before + 1);
}

#[test]
fn probe_media_dimensions_handles_real_fixtures_and_missing_paths() {
    for rel in [
        "export_1785518878919.png",
        "50-51.tif",
        "endfield.ico",
        "gfl-spinner.svg",
    ] {
        let path = repo_test_file(rel);
        assert!(path.exists(), "missing fixture: {}", path.display());
        let dims = probe_media_dimensions(path.to_string_lossy().into_owned());
        let (w, h) = dims.unwrap_or_else(|| panic!("expected dimensions for {rel}"));
        assert!(w > 0 && h > 0, "expected positive dimensions for {rel}, got ({w}, {h})");
    }

    let missing = repo_test_file("does_not_exist_probe_test.png");
    assert_eq!(
        probe_media_dimensions(missing.to_string_lossy().into_owned()),
        None
    );
}

#[test]
fn dimension_entry_serializes_expected_json_fields() {
    let entry = DimensionEntry {
        name: "01.png".to_string(),
        width: 800,
        height: 1200,
    };
    let val = serde_json::to_value(&entry).expect("serialize DimensionEntry");
    assert_eq!(val["name"], "01.png");
    assert_eq!(val["width"], 800);
    assert_eq!(val["height"], 1200);
}

#[test]
fn archive_header_animation_check_reads_cbz_entry() {
    let cbz_path = repo_test_file("_archives/cbz.cbz");
    assert!(cbz_path.exists(), "missing fixture: {}", cbz_path.display());
    let cbz_str = cbz_path.to_string_lossy().into_owned();

    let mut cache = ArchiveCache::new(32);
    let prepared = cache
        .prepare_archive(&cbz_str, None)
        .expect("prepare cbz archive");
    let first_entry = prepared
        .files
        .iter()
        .find(|f| !f.is_dir)
        .expect("cbz has at least one file entry");

    let header = cache
        .read_entry_header(&cbz_str, &first_entry.name, 262_144)
        .expect("read cbz entry header");
    assert!(!header.is_empty());
    let status = formats::check_animation_status(&header);
    assert!(!status.is_animated);
}
