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

struct AnimTempDir(PathBuf);

impl AnimTempDir {
    fn new(tag: &str) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "quivit-anim-test-{tag}-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create anim temp dir");
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for AnimTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn mp4_box(typ: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let size = (8 + payload.len()) as u32;
    let mut out = Vec::with_capacity(size as usize);
    out.extend_from_slice(&size.to_be_bytes());
    out.extend_from_slice(typ);
    out.extend_from_slice(payload);
    out
}

fn synthetic_mp4_with_trailing_moov(mdat_padding: usize, has_audio: bool) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&mp4_box(b"ftyp", b"isom\0\0\x02\0isom"));
    let mdat_payload = vec![0u8; mdat_padding];
    out.extend_from_slice(&mp4_box(b"mdat", &mdat_payload));

    let hdlr_type = if has_audio { b"soun" } else { b"vide" };
    let mut hdlr_payload = vec![0u8; 12];
    hdlr_payload[8..12].copy_from_slice(hdlr_type);
    let hdlr = mp4_box(b"hdlr", &hdlr_payload);
    let mdia = mp4_box(b"mdia", &hdlr);
    let trak = mp4_box(b"trak", &mdia);
    let moov = mp4_box(b"moov", &trak);
    out.extend_from_slice(&moov);
    out
}

#[test]
fn scanner_directory_width_and_dimensions_and_cancellation() {
    let dir = AnimTempDir::new("dir-scan");
    let png_src = repo_test_file("export_1785518878919.png");
    let ico_src = repo_test_file("endfield.ico");
    let svg_src = repo_test_file("gfl-spinner.svg");
    assert!(png_src.exists() && ico_src.exists() && svg_src.exists());

    fs::copy(&png_src, dir.path().join("page.png")).expect("copy png");
    fs::copy(&ico_src, dir.path().join("icon.ico")).expect("copy ico");
    fs::copy(&svg_src, dir.path().join("spinner.svg")).expect("copy svg");
    fs::write(dir.path().join("notes.txt"), b"ignored").expect("write txt");
    fs::create_dir_all(dir.path().join("subdir")).expect("create subdir");

    let dir_str = dir.path().to_string_lossy().into_owned();
    let expected_png_dims = probe_media_dimensions(png_src.to_string_lossy().into_owned())
        .expect("probe png");

    // Width scan skips SVG and ICO, finds PNG width, emits done.
    let mut progress = Vec::new();
    let mut done_max = None;
    scan_container_max_width_with(
        &dir_str,
        false,
        None,
        None,
        std::time::Duration::from_millis(100),
        || false,
        |w| progress.push(w),
        |max_w| done_max = Some(max_w),
    );
    assert_eq!(progress, vec![expected_png_dims.0]);
    assert_eq!(done_max, Some(expected_png_dims.0));

    // Dimensions scan includes PNG, ICO, and SVG.
    let mut all_entries = Vec::new();
    let mut saw_done = false;
    scan_container_dimensions_with(
        &dir_str,
        false,
        None,
        None,
        std::time::Duration::from_millis(100),
        || false,
        |entries, done| {
            all_entries.extend(entries);
            if done {
                saw_done = true;
            }
        },
    );
    assert!(saw_done);
    let names: std::collections::HashSet<&str> =
        all_entries.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains("page.png"));
    assert!(names.contains("icon.ico"));
    assert!(names.contains("spinner.svg"));
    assert!(!names.contains("notes.txt"));

    // Cancelled scan emits neither progress nor done.
    let mut cancelled_done = false;
    scan_container_max_width_with(
        &dir_str,
        false,
        None,
        None,
        std::time::Duration::from_millis(100),
        || true,
        |_| panic!("cancelled scan should not emit progress"),
        |_| cancelled_done = true,
    );
    assert!(!cancelled_done);
}

#[test]
fn scanner_zip_and_temp_archive_width_and_dimensions() {
    let cbz = repo_test_file("_archives/cbz.cbz");
    assert!(cbz.exists(), "missing fixture: {}", cbz.display());
    let cbz_str = cbz.to_string_lossy().into_owned();

    let mut zip_max = None;
    scan_container_max_width_with(
        &cbz_str,
        true,
        None,
        None,
        std::time::Duration::from_millis(100),
        || false,
        |_| {},
        |max_w| zip_max = Some(max_w),
    );
    assert!(zip_max.unwrap_or(0) > 0, "expected positive max width for cbz");

    let mut zip_dims = Vec::new();
    let mut zip_done = false;
    scan_container_dimensions_with(
        &cbz_str,
        true,
        None,
        None,
        std::time::Duration::from_millis(100),
        || false,
        |entries, done| {
            zip_dims.extend(entries);
            if done {
                zip_done = true;
            }
        },
    );
    assert!(zip_done);
    assert!(!zip_dims.is_empty());

    // Temp archive scan wakes immediately when prepare_archive_shared registers the archive.
    let tar = repo_test_file("_archives/tar.tar");
    assert!(tar.exists(), "missing fixture: {}", tar.display());
    let tar_str = tar.to_string_lossy().into_owned();

    let cache = std::sync::Arc::new(RwLock::new(ArchiveCache::new(32)));
    let cache_for_prep = std::sync::Arc::clone(&cache);
    let tar_for_prep = tar_str.clone();
    let prep = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(30));
        crate::archives::prepare_archive_shared(&cache_for_prep, &tar_for_prep, None)
            .expect("prepare tar")
    });

    let mut tar_max = None;
    scan_container_max_width_with(
        &tar_str,
        true,
        None,
        Some(&cache),
        std::time::Duration::from_secs(5),
        || false,
        |_| {},
        |max_w| tar_max = Some(max_w),
    );
    prep.join().expect("join tar prep");
    assert!(tar_max.unwrap_or(0) > 0, "expected positive max width for tar");

    let mut tar_dims = Vec::new();
    let mut tar_done = false;
    scan_container_dimensions_with(
        &tar_str,
        true,
        None,
        Some(&cache),
        std::time::Duration::from_secs(5),
        || false,
        |entries, done| {
            tar_dims.extend(entries);
            if done {
                tar_done = true;
            }
        },
    );
    assert!(tar_done);
    assert!(!tar_dims.is_empty());

    let dirs = cache.write().unwrap().drop_archive_deferred(&tar_str);
    for dir in dirs {
        let _ = fs::remove_dir_all(dir);
    }
}

#[test]
fn check_media_audio_streams_archived_mp4_with_trailing_moov_beyond_512kib() {
    use std::io::Write;

    let dir = AnimTempDir::new("mp4-audio");
    let zip_path = dir.path().join("videos.cbz");

    let mp4_audio = synthetic_mp4_with_trailing_moov(600 * 1024, true);
    let mp4_silent = synthetic_mp4_with_trailing_moov(600 * 1024, false);

    {
        let file = fs::File::create(&zip_path).expect("create test cbz");
        let mut writer = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        writer.start_file("with_audio.mp4", opts).expect("start audio");
        writer.write_all(&mp4_audio).expect("write audio mp4");
        writer.start_file("silent.mp4", opts).expect("start silent");
        writer.write_all(&mp4_silent).expect("write silent mp4");
        writer.finish().expect("finish zip");
    }

    let state = RwLock::new(ArchiveCache::new(16));
    let zip_str = zip_path.to_string_lossy().into_owned();
    assert!(
        check_archive_media_audio(&state, &zip_str, "with_audio.mp4")
            .expect("check archived audio mp4"),
        "expected audio stream detected past 512 KiB mdat"
    );
    assert!(
        !check_archive_media_audio(&state, &zip_str, "silent.mp4")
            .expect("check archived silent mp4"),
        "expected silent mp4 to report false"
    );

    let local_mp4 = dir.path().join("local_audio.mp4");
    fs::write(&local_mp4, &mp4_audio).expect("write local mp4");
    assert!(check_file_media_audio(&local_mp4).expect("check local mp4 audio"));
}

#[test]
fn check_file_is_animated_probes_stack_buffer_and_escalates_for_large_svg() {
    let dir = AnimTempDir::new("anim-probe");
    let static_png = repo_test_file("export_1785518878919.png");
    assert!(!check_file_is_animated(&static_png).expect("probe png").is_animated);

    let large_svg = dir.path().join("large_anim.svg");
    let mut content = String::from("<svg xmlns=\"http://www.w3.org/2000/svg\">");
    content.push_str(&" ".repeat(12 * 1024));
    content.push_str("<animate attributeName=\"opacity\" from=\"0\" to=\"1\" dur=\"1s\"/></svg>");
    fs::write(&large_svg, content.as_bytes()).expect("write large svg");

    assert!(
        check_file_is_animated(&large_svg)
            .expect("probe large svg")
            .is_animated,
        "expected stack probe to escalate past 8 KiB for SVG"
    );
}
