    use super::*;
    use crate::utils::*;

    use std::io::Read;

    fn test_file(name: &str) -> std::path::PathBuf {
        // Tests run with CWD = src-tauri; test files live under the repo root.
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test-files")
            .join("archives")
            .join(name)
    }

    /// Returns the cbt.cbt fixture, rebuilding it from the 7z fixture if it is
    /// missing or invalid, so the tar tests are self-provisioning (no external
    /// 7z/7za required).
    fn ensure_cbt() -> std::path::PathBuf {
        let cbt = test_file("cbt.cbt");
        let valid = cbt.exists()
            && list_tar_entries(cbt.to_str().unwrap())
                .map(|f| f.len() >= 12 && f.iter().any(|e| e.name.contains('/')))
                .unwrap_or(false);
        if valid {
            return cbt;
        }
        // Re-pack images extracted from the 7z fixture (which carries the same
        // root images + New folder/) into the cbt.
        let seven = test_file("7z.7z");
        let hash = format!("{:x}", md5::compute(seven.to_str().unwrap()));
        let scratch = std::env::temp_dir().join("QuiviT-test-cbt").join(hash);
        let _ = fs::remove_dir_all(&scratch);
        let notify = std::sync::Arc::new((
            std::sync::Mutex::new(std::collections::HashSet::new()),
            std::sync::Condvar::new(),
        ));
        extract_7z_to_temp(seven.to_str().unwrap().to_string(), scratch.clone(), notify);

        let mut builder = tar::Builder::new(fs::File::create(&cbt).expect("create cbt"));
        for entry in fs::read_dir(&scratch).expect("read extracted source folder") {
            let entry = entry.expect("source entry");
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                // Nested New folder/ entries
                for nested in fs::read_dir(entry.path()).expect("read nested folder") {
                    let nested = nested.expect("nested entry");
                    let nname = nested.file_name().to_string_lossy().into_owned();
                    let bytes = fs::read(nested.path()).expect("read nested image");
                    let mut header = tar::Header::new_gnu();
                    header.set_size(bytes.len() as u64);
                    header.set_mode(0o644);
                    header.set_mtime(0);
                    builder
                        .append_data(&mut header, format!("{name}/{nname}"), bytes.as_slice())
                        .expect("append nested tar entry");
                }
            } else {
                let bytes = fs::read(entry.path()).expect("read extracted image");
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o644);
                header.set_mtime(0);
                builder
                    .append_data(&mut header, name, bytes.as_slice())
                    .expect("append tar entry");
            }
        }
        builder.finish().expect("finish tar");
        let _ = fs::remove_dir_all(&scratch);
        cbt
    }
    #[test]
    fn lists_solid_7z_with_nested_folders() {
        let path = test_file("7z.7z");
        let files = list_7z_entries(path.to_str().unwrap()).expect("list 7z");
        assert!(
            files.len() >= 12,
            "expected >=12 image entries, got {}",
            files.len()
        );
        // Composite archive|entry paths, nested folder preserved
        assert!(files.iter().any(|f| f.path.contains('|')));
        assert!(files.iter().any(|f| f.name.contains('/')));
        // Sorted naturally
        let names: Vec<&String> = files.iter().map(|f| &f.name).collect();
        let mut sorted = names.clone();
        sorted.sort_by(|a, b| natord::compare(a, b));
        assert_eq!(names, sorted);
    }

    #[test]
    fn extracts_solid_7z_to_temp() {
        let path = test_file("7z.7z");
        let hash = format!("{:x}", md5::compute(path.to_str().unwrap()));
        let temp_dir = std::env::temp_dir().join("QuiviT-test-extract").join(hash);
        let _ = fs::remove_dir_all(&temp_dir);
        let notify = std::sync::Arc::new((
            std::sync::Mutex::new(std::collections::HashSet::new()),
            std::sync::Condvar::new(),
        ));
        extract_7z_to_temp(path.to_str().unwrap().to_string(), temp_dir.clone(), notify);

        // A nested entry must exist and match the same-named root entry
        // (the test 7z carries duplicate copies).
        let nested = temp_dir.join("New folder/export_1785518859589.webp");
        assert!(nested.exists(), "nested entry not extracted");
        let mut buf = Vec::new();
        fs::File::open(&nested)
            .unwrap()
            .read_to_end(&mut buf)
            .unwrap();
        let root = fs::read(temp_dir.join("export_1785518859589.webp")).unwrap();
        assert_eq!(buf.len(), root.len());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn lists_and_reads_tar() {
        let cbt = ensure_cbt();
        let files = list_tar_entries(cbt.to_str().unwrap()).expect("list tar");
        assert!(
            files.len() >= 12,
            "expected >=12 entries, got {}",
            files.len()
        );
        let names: Vec<String> = files.iter().map(|f| f.name.clone()).collect();
        assert!(names.iter().any(|n| n.contains("gfl-spinner.svg")));
        assert!(names.iter().any(|n| n.contains("Mine_(Idol)_S2_09.webp")));
        // Nested folder preserved in the cbt
        assert!(names.iter().any(|n| n.starts_with("New folder/")));

        let data = extract_tar_entry(cbt.to_str().unwrap(), "export_1785518878919.png")
            .expect("extract tar entry");
        // The cbt entry must byte-match the same file inside the 7z fixture.
        let seven = test_file("7z.7z");
        let hash = format!("{:x}", md5::compute(seven.to_str().unwrap()));
        let scratch = std::env::temp_dir().join("QuiviT-test-cbt").join(hash);
        let _ = fs::remove_dir_all(&scratch);
        let notify = std::sync::Arc::new((
            std::sync::Mutex::new(std::collections::HashSet::new()),
            std::sync::Condvar::new(),
        ));
        extract_7z_to_temp(seven.to_str().unwrap().to_string(), scratch.clone(), notify);
        let original = fs::read(scratch.join("export_1785518878919.png")).unwrap();
        assert_eq!(data.len(), original.len());
        let _ = fs::remove_dir_all(&scratch);
    }

    #[test]
    fn extracts_tar_to_temp() {
        let cbt = ensure_cbt();
        let hash = format!("{:x}", md5::compute(cbt.to_str().unwrap()));
        let temp_dir = std::env::temp_dir()
            .join("QuiviT-test-tar-extract")
            .join(hash);
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).ok();
        let notify = std::sync::Arc::new((
            std::sync::Mutex::new(std::collections::HashSet::new()),
            std::sync::Condvar::new(),
        ));

        extract_tar_to_temp(cbt.to_str().unwrap().to_string(), temp_dir.clone(), notify);

        let root = temp_dir.join("export_1785518878919.png");
        let nested = temp_dir.join("New folder/export_1785518859589.webp");
        assert!(root.exists(), "root TAR entry not extracted");
        assert!(nested.exists(), "nested TAR entry not extracted");
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn archive_entry_temp_path_rejects_escape_paths() {
        let temp_dir = std::env::temp_dir().join("QuiviT-test-path-safety");

        assert!(archive_entry_temp_path(&temp_dir, "folder/page.jpg").is_some());
        assert!(archive_entry_temp_path(&temp_dir, "folder\\page.jpg").is_some());
        assert!(archive_entry_temp_path(&temp_dir, "../page.jpg").is_none());
        assert!(archive_entry_temp_path(&temp_dir, "folder/../../page.jpg").is_none());
        assert!(archive_entry_temp_path(&temp_dir, "/absolute/page.jpg").is_none());
        assert!(archive_entry_temp_path(&temp_dir, "").is_none());
    }

    #[test]
    fn tar_temp_extraction_includes_metadata() {
        let temp_root = std::env::temp_dir().join("QuiviT-test-tar-metadata");
        let _ = fs::remove_dir_all(&temp_root);
        fs::create_dir_all(&temp_root).ok();

        let cbt = temp_root.join("metadata.cbt");
        let mut builder = tar::Builder::new(fs::File::create(&cbt).expect("create cbt"));
        let entries = [
            ("page.jpg", b"image".as_slice()),
            ("ComicInfo.xml", b"<ComicInfo />".as_slice()),
        ];
        for (name, bytes) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_mtime(0);
            builder
                .append_data(&mut header, name, bytes)
                .expect("append tar entry");
        }
        builder.finish().expect("finish cbt");

        let extract_dir = temp_root.join("extract");
        fs::create_dir_all(&extract_dir).ok();
        let notify = std::sync::Arc::new((
            std::sync::Mutex::new(std::collections::HashSet::new()),
            std::sync::Condvar::new(),
        ));
        extract_tar_to_temp(
            cbt.to_string_lossy().into_owned(),
            extract_dir.clone(),
            notify,
        );

        assert!(extract_dir.join("page.jpg").exists());
        assert!(extract_dir.join("ComicInfo.xml").exists());
        let _ = fs::remove_dir_all(&temp_root);
    }

    #[test]
    fn supported_archives_include_new_formats() {
        for ext in ["7z", "cb7", "cbt", "tar"] {
            assert!(is_archive_ext(ext), "{} not recognized as archive", ext);
        }
    }

    #[test]
    fn lists_rar5_cbr() {
        let path = test_file("cbr.cbr");
        let files = list_rar_entries(path.to_str().unwrap()).expect("list cbr");
        assert!(
            files.len() >= 7,
            "expected >=7 image entries, got {}",
            files.len()
        );
        assert!(files.iter().any(|f| f.name.contains("BDレーベル.bmp")));
    }

    #[test]
    fn lists_cb7_like_7z() {
        // cb7 is the comic-book extension for 7z — same codec, must route the same.
        let src = test_file("7z.7z");
        let cb7 = std::env::temp_dir()
            .join("QuiviT-test-extract")
            .join("sample.cb7");
        let _ = fs::remove_file(&cb7);
        fs::copy(&src, &cb7).expect("copy 7z to cb7");
        let files = list_7z_entries(cb7.to_str().unwrap()).expect("list cb7");
        assert!(files.len() >= 12, "cb7 listed {} entries", files.len());
        let _ = fs::remove_file(&cb7);
    }

    #[test]
    fn url_decode_roundtrips_utf8_entry_names() {
        // The 31MB BMP fixture is really named "BDレーベル.bmp". The frontend
        // builds the protocol URL with encodeURIComponent, so the handler must
        // decode percent-encoded multi-byte UTF-8 back to the original name.
        let name = "BDレーベル.bmp";
        let mut encoded = String::new();
        for b in name.as_bytes() {
            encoded.push_str(&format!("%{:02X}", b));
        }
        assert_eq!(crate::utils::url_decode(&encoded), name);
        // ASCII + spaces from encodeURIComponent also survive
        assert_eq!(crate::utils::url_decode("a%20b%26c.jpg"), "a b&c.jpg");
    }

    #[test]
    fn protocol_serve_timing_simulation() {
        // Mirrors the protocol handler serving path:
        //  - rar/cbr/7z/cb7/cbt/tar: served from extract_temp_dir
        //  - zip/cbz: on-demand extract_zip_entry
        // Simulates the FIRST image request arriving right after list_archive
        // spawns the background extractor, then reports how long the first
        // entry takes to become servable and whether the 3s poll would 404.
        use std::time::{Duration, Instant};

        fn poll_temp(temp_dir: &std::path::Path, entry: &str, timeout_ms: u64) -> (bool, Duration) {
            let safe = entry.replace('\\', "/");
            let path = temp_dir.join(&safe);
            let start = Instant::now();
            for _ in 0..(timeout_ms / 100) {
                if path.exists() {
                    return (true, start.elapsed());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            (path.exists(), start.elapsed())
        }

        let seven = test_file("7z.7z");
        let hash = format!("{:x}", md5::compute(seven.to_str().unwrap()));
        let temp_dir = std::env::temp_dir().join("QuiviT-test-serve").join(hash);
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).ok();

        // Spawn background extraction exactly like list_archive does.
        let seven_path = seven.to_str().unwrap().to_string();
        let td = temp_dir.clone();
        let notify = std::sync::Arc::new((
            std::sync::Mutex::new(std::collections::HashSet::new()),
            std::sync::Condvar::new(),
        ));
        std::thread::spawn(move || extract_7z_to_temp(seven_path, td, notify));

        // First sorted entry is BAKEMONOGATARI...jpg. Poll it like the handler would.
        let first =
            "BAKEMONOGATARI - c013 (v03) - p002 [Kodansha Comics] [Digital] [1r0n] {HQ}.jpg";
        let (found, elapsed) = poll_temp(&temp_dir, first, 30000);
        eprintln!("7z first entry poll: found={found} elapsed={:?}", elapsed);
        assert!(
            found,
            "first 7z entry never became available within 30s poll -> 404"
        );

        // Now the large BMP: how long until IT is extractable from the temp dir?
        let bmp = "BDレーベル.bmp";
        let (found_bmp, elapsed_bmp) = poll_temp(&temp_dir, bmp, 30000);
        eprintln!("7z BMP poll: found={found_bmp} elapsed={:?}", elapsed_bmp);

        // On-demand paths (cbz/tar) must serve the first image synchronously.
        let zip_first = extract_zip_entry(test_file("cbz.cbz").to_str().unwrap(), first);
        eprintln!(
            "cbz on-demand first entry: {}",
            zip_first
                .as_ref()
                .map(|d| format!("{} bytes", d.len()))
                .unwrap_or_else(|e| format!("ERR {e}"))
        );
        assert!(
            zip_first.is_ok(),
            "cbz on-demand extraction failed: {:?}",
            zip_first.err()
        );

        let cbt = ensure_cbt();
        let cbt_hash = format!("{:x}", md5::compute(cbt.to_str().unwrap()));
        let tar_temp_dir = std::env::temp_dir()
            .join("QuiviT-test-serve-tar")
            .join(cbt_hash);
        let _ = fs::remove_dir_all(&tar_temp_dir);
        fs::create_dir_all(&tar_temp_dir).ok();
        let tar_notify = std::sync::Arc::new((
            std::sync::Mutex::new(std::collections::HashSet::new()),
            std::sync::Condvar::new(),
        ));
        extract_tar_to_temp(
            cbt.to_str().unwrap().to_string(),
            tar_temp_dir.clone(),
            tar_notify,
        );
        let tar_first = fs::read(tar_temp_dir.join(first));
        eprintln!(
            "cbt temp first entry: {}",
            tar_first
                .as_ref()
                .map(|d| format!("{} bytes", d.len()))
                .unwrap_or_else(|e| format!("ERR {e}"))
        );
        assert!(
            tar_first.is_ok(),
            "cbt on-demand extraction failed: {:?}",
            tar_first.err()
        );

        let _ = fs::remove_dir_all(&temp_dir);
        let _ = fs::remove_dir_all(&tar_temp_dir);
    }

    #[test]
    fn archive_cache_byte_budget_evicts_globally() {
        // Verifies the multi-archive LRU from archives.rs without touching the
        // protocol/Tauri layers. A cache hit refreshes recency, and a single
        // entry larger than the whole budget must still be inserted.
        let mut cache = ArchiveCache::new(2); // 2 MB budget

        // Mirrors list_archive: each opened archive first registers a slot.
        let register = |cache: &mut ArchiveCache, archive: &str| {
            cache.register_archive(
                archive.to_string(),
                SingleArchiveCache {
                    zip_entries: std::collections::HashMap::new(),
                    zip_archive: None,
                    extract_temp_dir: None,
                    extract_notify: std::sync::Arc::new((
                        std::sync::Mutex::new(std::collections::HashSet::new()),
                        std::sync::Condvar::new(),
                    )),
                },
            );
        };
        register(&mut cache, "a.cbz");
        register(&mut cache, "b.cbz");

        let insert = |cache: &mut ArchiveCache, archive: &str, entry: &str, bytes: usize| {
            let data = vec![0u8; bytes];
            cache.insert_zip_entry(archive, entry, data);
        };

        // 1 MB entries
        let mb1 = 1024 * 1024;
        insert(&mut cache, "a.cbz", "p1", mb1);
        insert(&mut cache, "a.cbz", "p2", mb1); // 2 MB total — at budget
        assert_eq!(cache.current_zip_bytes, 2 * mb1);
        assert!(cache.archives["a.cbz"].zip_entries.contains_key("p1"));

        // Touch p1, then insert p3. p2 is now least-recently-used and leaves.
        assert!(cache.get_zip_entry("a.cbz", "p1").is_some());
        insert(&mut cache, "a.cbz", "p3", mb1);
        assert!(cache.archives["a.cbz"].zip_entries.contains_key("p1"));
        assert!(!cache.archives["a.cbz"].zip_entries.contains_key("p2"));
        assert!(cache.archives["a.cbz"].zip_entries.contains_key("p3"));
        assert_eq!(cache.current_zip_bytes, 2 * mb1);

        // An entry in a second archive shares the same global budget.
        insert(&mut cache, "b.cbz", "q1", mb1);
        // Now 3 MB owed against 2 MB budget: p1 leaves first, then p3.
        insert(&mut cache, "b.cbz", "q2", mb1);
        assert!(!cache.archives["a.cbz"].zip_entries.contains_key("p1"));
        assert!(!cache.archives["a.cbz"].zip_entries.contains_key("p3"));
        assert!(cache.archives["b.cbz"].zip_entries.contains_key("q1"));
        assert!(cache.archives["b.cbz"].zip_entries.contains_key("q2"));
        assert_eq!(cache.current_zip_bytes, 2 * mb1);

        // Oversized single entry still lands even though it alone exceeds budget.
        insert(&mut cache, "b.cbz", "huge", 4 * mb1);
        assert!(cache.archives["b.cbz"].zip_entries.contains_key("huge"));
        assert_eq!(cache.current_zip_bytes, 4 * mb1);

        // Re-insertion of an already-cached key is a no-op (byte count stable).
        let before = cache.current_zip_bytes;
        insert(&mut cache, "b.cbz", "huge", 4 * mb1);
        assert_eq!(cache.current_zip_bytes, before);

        cache.insert_zip_entry("missing.cbz", "ghost", vec![0u8; mb1]);
        assert_eq!(cache.current_zip_bytes, before);
    }

    #[test]
    fn archive_cache_bounds_open_archive_state() {
        let mut cache = ArchiveCache::new(2);
        cache.max_open_archives = 2;

        let register = |cache: &mut ArchiveCache, archive: &str| {
            cache.register_archive(
                archive.to_string(),
                SingleArchiveCache {
                    zip_entries: std::collections::HashMap::new(),
                    zip_archive: None,
                    extract_temp_dir: None,
                    extract_notify: std::sync::Arc::new((
                        std::sync::Mutex::new(std::collections::HashSet::new()),
                        std::sync::Condvar::new(),
                    )),
                },
            );
        };

        register(&mut cache, "a.cbz");
        cache.insert_zip_entry("a.cbz", "p1", vec![0u8; 1024]);
        register(&mut cache, "b.cbz");
        register(&mut cache, "c.cbz");

        assert!(!cache.archives.contains_key("a.cbz"));
        assert!(cache.archives.contains_key("b.cbz"));
        assert!(cache.archives.contains_key("c.cbz"));
        assert_eq!(cache.current_zip_bytes, 0);
    }
