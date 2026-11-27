use super::*;
use crate::formats::*;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

static ARCHIVE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new(prefix: &str) -> Self {
        let n = ARCHIVE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "quivit-archive-test-{prefix}-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        Self(dir)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn test_file(name: &str) -> std::path::PathBuf {
    // Tests run with CWD = src-tauri; test files live under the repo root.
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("test-files")
        .join("_archives")
        .join(name)
}

#[test]
fn archive_entry_temp_path_rejects_escape_paths() {
    let temp_dir = TempDir::new("path-safety");

    assert!(archive_entry_temp_path(temp_dir.path(), "folder/page.jpg").is_some());
    assert!(archive_entry_temp_path(temp_dir.path(), "folder\\page.jpg").is_some());
    assert!(archive_entry_temp_path(temp_dir.path(), "../page.jpg").is_none());
    assert!(archive_entry_temp_path(temp_dir.path(), "folder/../../page.jpg").is_none());
    assert!(archive_entry_temp_path(temp_dir.path(), "/absolute/page.jpg").is_none());
    assert!(archive_entry_temp_path(temp_dir.path(), "").is_none());
}

#[test]
fn supported_archives_include_new_formats() {
    for ext in ["7z", "cb7", "cbt", "tar"] {
        assert!(is_archive_ext(ext), "{} not recognized as archive", ext);
    }
}

#[test]
fn url_decode_roundtrips_utf8_entry_names() {
    // The 31MB BMP fixture is named "BDレーベル.bmp". The frontend
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
fn archive_cache_byte_budget_evicts_globally() {
    // Verifies the multi-archive LRU from archives.rs without touching the
    // protocol/Tauri layers. A cache hit refreshes recency, and a single
    // entry larger than the whole budget must still be inserted.
    let mut cache = ArchiveCache::new(2); // 2 MB budget

    cache.register_test_archive("a.cbz");
    cache.register_test_archive("b.cbz");

    let insert = |cache: &mut ArchiveCache, archive: &str, entry: &str, bytes: usize| {
        let data = vec![0u8; bytes];
        cache.insert_zip_entry(archive, entry, data);
    };

    // 1 MB entries
    let mb1 = 1024 * 1024;
    insert(&mut cache, "a.cbz", "p1", mb1);
    insert(&mut cache, "a.cbz", "p2", mb1); // 2 MB total, at budget
    assert_eq!(cache.current_zip_bytes(), 2 * mb1);
    assert!(cache.contains_zip_entry("a.cbz", "p1"));

    // Touch p1, then insert p3. p2 is now least-recently-used and leaves.
    assert!(cache
        .read_entry_bytes("a.cbz", "p1")
        .unwrap()
        .wait_for_data("p1")
        .is_ok());
    insert(&mut cache, "a.cbz", "p3", mb1);
    assert!(cache.contains_zip_entry("a.cbz", "p1"));
    assert!(!cache.contains_zip_entry("a.cbz", "p2"));
    assert!(cache.contains_zip_entry("a.cbz", "p3"));
    assert_eq!(cache.current_zip_bytes(), 2 * mb1);

    // An entry in a second archive shares the same global budget.
    insert(&mut cache, "b.cbz", "q1", mb1);
    // Now 3 MB owed against 2 MB budget: p1 leaves first, then p3.
    insert(&mut cache, "b.cbz", "q2", mb1);
    assert!(!cache.contains_zip_entry("a.cbz", "p1"));
    assert!(!cache.contains_zip_entry("a.cbz", "p3"));
    assert!(cache.contains_zip_entry("b.cbz", "q1"));
    assert!(cache.contains_zip_entry("b.cbz", "q2"));
    assert_eq!(cache.current_zip_bytes(), 2 * mb1);

    // Oversized single entry still lands even though it alone exceeds budget.
    insert(&mut cache, "b.cbz", "huge", 4 * mb1);
    assert!(cache.contains_zip_entry("b.cbz", "huge"));
    assert_eq!(cache.current_zip_bytes(), 4 * mb1);

    // Re-insertion of an already-cached key is a no-op (byte count stable).
    let before = cache.current_zip_bytes();
    insert(&mut cache, "b.cbz", "huge", 4 * mb1);
    assert_eq!(cache.current_zip_bytes(), before);

    cache.insert_zip_entry("missing.cbz", "ghost", vec![0u8; mb1]);
    assert_eq!(cache.current_zip_bytes(), before);
}

#[test]
fn archive_cache_zip_hits_reuse_shared_bytes() {
    let mut cache = ArchiveCache::new(2);
    cache.register_test_archive("a.cbz");
    cache.insert_zip_entry("a.cbz", "p1", vec![1, 2, 3, 4]);

    let first = cache
        .cached_zip_entry_bytes("a.cbz", "p1")
        .expect("cache lookup")
        .expect("cached entry");
    let second = cache
        .cached_zip_entry_bytes("a.cbz", "p1")
        .expect("cache lookup")
        .expect("cached entry");

    assert!(std::sync::Arc::ptr_eq(&first, &second));
}

#[test]
fn archive_cache_bounds_open_archive_state() {
    let mut cache = ArchiveCache::new(2);
    cache.set_max_open_archives(2);

    cache.register_test_archive("a.cbz");
    cache.insert_zip_entry("a.cbz", "p1", vec![0u8; 1024]);
    cache.register_test_archive("b.cbz");
    cache.register_test_archive("c.cbz");

    assert!(!cache.contains_archive("a.cbz"));
    assert!(cache.contains_archive("b.cbz"));
    assert!(cache.contains_archive("c.cbz"));
    assert_eq!(cache.current_zip_bytes(), 0);
}

#[test]
fn archive_cache_max_open_archives_one_evicts_previous() {
    let mut cache = ArchiveCache::new(2);
    cache.set_max_open_archives(1);

    cache.register_test_archive("first.cbz");
    cache.insert_zip_entry("first.cbz", "p1", vec![1u8; 512]);
    assert!(cache.contains_archive("first.cbz"));

    cache.register_test_archive("second.cbz");
    assert!(!cache.contains_archive("first.cbz"));
    assert!(cache.contains_archive("second.cbz"));
    assert_eq!(cache.current_zip_bytes(), 0);

    // Overwriting an existing archive key subtracts its cached ZIP bytes and bumps generation.
    let gen_before = cache.archive_generation("second.cbz").expect("initial gen");
    cache.insert_zip_entry("second.cbz", "p1", vec![2u8; 768]);
    assert_eq!(cache.current_zip_bytes(), 768);
    cache.register_test_archive("second.cbz");
    assert_eq!(cache.current_zip_bytes(), 0);
    assert_ne!(cache.archive_generation("second.cbz"), Some(gen_before));
}

// CJK encoding regression tests

fn encoding_test_file(name: &str) -> std::path::PathBuf {
    test_file("encoding_tests").join(name)
}

#[test]
fn zip_decodes_shift_jis_entry_names() {
    let path = encoding_test_file("shift_jis_test.zip");
    let (entries, _, _, _) =
        list_zip_entries(path.to_str().unwrap(), None).expect("list shift-jis zip");
    assert_eq!(entries.len(), 1);
    assert!(
        entries[0].name.contains("テスト"),
        "Shift-JIS name not decoded: {}",
        entries[0].name
    );
}

#[test]
fn zip_decodes_gbk_entry_names() {
    let path = encoding_test_file("gbk_test.zip");
    let (entries, _, _, _) = list_zip_entries(path.to_str().unwrap(), None).expect("list gbk zip");
    assert_eq!(entries.len(), 1);
    assert!(
        entries[0].name.contains("测试"),
        "GBK name not decoded: {}",
        entries[0].name
    );
}

#[test]
fn zip_decodes_euckr_entry_names() {
    let path = encoding_test_file("euckr_test.zip");
    let (entries, _, _, _) =
        list_zip_entries(path.to_str().unwrap(), None).expect("list euc-kr zip");
    assert_eq!(entries.len(), 1);
    assert!(
        entries[0].name.contains("테스트"),
        "EUC-KR name not decoded: {}",
        entries[0].name
    );
}

fn encrypted_test_file(name: &str) -> std::path::PathBuf {
    test_file("encrypted_tests").join(name)
}

#[test]
fn zip_corrupt_local_header_fails_fast_on_corrupt_entry_and_reads_valid_entry() {
    let path = encrypted_test_file("corrupt_local_header.zip");
    assert!(path.exists(), "missing fixture: {}", path.display());
    let (files, _archive, _map, encryption) =
        list_zip_entries(path.to_str().unwrap(), None).expect("list corrupt header zip");
    assert_eq!(encryption, None);
    assert_eq!(files.len(), 2);

    let mut cache = ArchiveCache::new(64);
    let _ = cache
        .prepare_archive(path.to_str().unwrap(), None)
        .expect("prepare corrupt zip");

    let valid_bytes = cache
        .read_entry_bytes(path.to_str().unwrap(), "01.png")
        .expect("read valid entry")
        .wait_for_data("01.png")
        .expect("wait for valid data");
    assert!(valid_bytes.starts_with(b"\x89PNG\r\n\x1a\n"));

    let corrupt_res = cache.read_entry_bytes(path.to_str().unwrap(), "corrupt.png");
    assert!(
        corrupt_res.is_err(),
        "Corrupt entry should fail immediately"
    );
}

#[test]
fn read_plain_zip_entry_shared_caches_handles_concurrency_cjk_encrypted_and_non_zip() {
    let cbz = test_file("cbz.cbz");
    assert!(cbz.exists(), "missing fixture: {}", cbz.display());
    let cbz_str = cbz.to_str().unwrap();

    let entries = list_archive_names(cbz_str).expect("list cbz");
    let first_name = entries
        .iter()
        .find(|e| !e.is_dir)
        .expect("cbz has file entry")
        .name
        .clone();

    let state = Arc::new(RwLock::new(ArchiveCache::new(64)));
    let first = read_plain_zip_entry_shared(&state, cbz_str, &first_name)
        .expect("zip returns Some")
        .expect("extract first entry");
    assert!(!first.is_empty());

    let second = read_plain_zip_entry_shared(&state, cbz_str, &first_name)
        .expect("zip returns Some")
        .expect("cache hit");
    assert!(Arc::ptr_eq(&first, &second));

    // Concurrent multi-thread reads on the same archive
    let mut handles = Vec::new();
    for _ in 0..4 {
        let st = Arc::clone(&state);
        let p = cbz_str.to_string();
        let n = first_name.clone();
        handles.push(std::thread::spawn(move || {
            read_plain_zip_entry_shared(&st, &p, &n)
                .expect("some")
                .expect("ok")
        }));
    }
    for h in handles {
        let bytes = h.join().expect("join reader thread");
        assert!(Arc::ptr_eq(&first, &bytes));
    }

    // CJK entry lookups
    for name in ["shift_jis_test.zip", "gbk_test.zip", "euckr_test.zip"] {
        let p = encoding_test_file(name);
        assert!(p.exists(), "missing fixture: {}", p.display());
        let p_str = p.to_str().unwrap();
        let list = list_archive_names(p_str).expect("list cjk zip");
        let cjk_entry = &list[0].name;
        let data = read_plain_zip_entry_shared(&state, p_str, cjk_entry)
            .expect("cjk zip returns Some")
            .expect("extract cjk entry");
        assert!(!data.is_empty());
    }

    // Non-ZIP returns None
    let tar = test_file("tar.tar");
    assert!(tar.exists(), "missing fixture: {}", tar.display());
    assert!(read_plain_zip_entry_shared(&state, tar.to_str().unwrap(), "any.jpg").is_none());

    // Locked encrypted ZIP returns None; unlocked encrypted ZIP returns Some(Ok(..))
    let enc = encrypted_test_file("encrypted-123.zip");
    assert!(enc.exists(), "missing fixture: {}", enc.display());
    let enc_str = enc.to_str().unwrap();
    let enc_state = RwLock::new(ArchiveCache::new(32));
    {
        let mut cache = enc_state.write().unwrap();
        let res = cache
            .prepare_archive(enc_str, None)
            .expect("prepare locked zip");
        assert!(res.encryption.is_some());
    }
    assert!(read_plain_zip_entry_shared(&enc_state, enc_str, "any.jpg").is_none());

    let enc_entry = {
        let mut cache = enc_state.write().unwrap();
        let res = cache
            .prepare_archive(enc_str, Some("123"))
            .expect("unlock encrypted zip");
        assert_eq!(res.encryption, None);
        res.files
            .into_iter()
            .find(|f| !f.is_dir)
            .expect("encrypted zip has entry")
            .name
    };
    let decrypted = read_plain_zip_entry_shared(&enc_state, enc_str, &enc_entry)
        .expect("unlocked zip returns Some")
        .expect("decrypt entry");
    assert!(!decrypted.is_empty());
}

#[test]
fn read_entry_header_works_for_zip_and_temp_archive() {
    let cbz = test_file("cbz.cbz");
    assert!(cbz.exists(), "missing fixture: {}", cbz.display());
    let cbz_str = cbz.to_str().unwrap();

    let mut cache = ArchiveCache::new(32);
    let cbz_res = cache.prepare_archive(cbz_str, None).expect("prepare cbz");
    let cbz_entry = cbz_res
        .files
        .iter()
        .find(|f| !f.is_dir)
        .expect("cbz file")
        .name
        .clone();
    let zip_hdr = cache
        .read_entry_header(cbz_str, &cbz_entry, 64)
        .expect("read zip header");
    assert!(!zip_hdr.is_empty() && zip_hdr.len() <= 64);

    let cbr = test_file("cbr.cbr");
    assert!(cbr.exists(), "missing fixture: {}", cbr.display());
    let cbr_str = cbr.to_str().unwrap();
    let cbr_res = cache.prepare_archive(cbr_str, None).expect("prepare cbr");
    let cbr_entry = cbr_res
        .files
        .iter()
        .find(|f| !f.is_dir)
        .expect("cbr file")
        .name
        .clone();
    let rar_hdr = cache
        .read_entry_header(cbr_str, &cbr_entry, 64)
        .expect("read rar header");
    assert!(!rar_hdr.is_empty() && rar_hdr.len() <= 64);
    cache.drop_archive(cbr_str);
}

#[test]
fn list_archive_names_and_tar_parity() {
    for name in ["cbz.cbz", "cbr.cbr", "cb7.cb7", "tar.tar"] {
        let path = test_file(name);
        assert!(path.exists(), "missing fixture: {}", path.display());
        let files = list_archive_names(path.to_str().unwrap())
            .unwrap_or_else(|e| panic!("list_archive_names({name}) failed: {e}"));
        assert!(!files.is_empty(), "{name} should contain entries");
    }

    let tar_path = test_file("tar.tar");
    let tar_files = list_archive_names(tar_path.to_str().unwrap()).expect("list tar");
    let mut expected_order = tar_files.clone();
    sort_archive_entries(&mut expected_order);
    let actual_names: Vec<&str> = tar_files.iter().map(|f| f.name.as_str()).collect();
    let expected_names: Vec<&str> = expected_order.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(actual_names, expected_names);
    for entry in &tar_files {
        let ext = entry.name.rsplit('.').next().unwrap_or("");
        assert!(
            is_image_ext(ext) || is_metadata_ext(ext),
            "unexpected tar entry extension: {}",
            entry.name
        );
    }
}

#[test]
fn drop_archive_removes_state_and_cleans_temp_dir() {
    let tar_path = test_file("tar.tar");
    assert!(tar_path.exists(), "missing fixture: {}", tar_path.display());
    let tar_str = tar_path.to_str().unwrap();

    let mut cache = ArchiveCache::new(32);
    let res = cache.prepare_archive(tar_str, None).expect("prepare tar");
    assert!(cache.contains_archive(tar_str));

    let (temp_dir, _) = cache
        .temp_extraction_state(tar_str)
        .expect("temp extraction state");
    let first_entry = res
        .files
        .iter()
        .find(|f| !f.is_dir)
        .expect("tar file")
        .name
        .clone();
    let _ = cache
        .read_entry_bytes(tar_str, &first_entry)
        .expect("read tar entry")
        .wait_for_data(&first_entry)
        .expect("wait for tar extraction");
    assert!(temp_dir.exists());

    cache.drop_archive(tar_str);
    assert!(!cache.contains_archive(tar_str));
    assert!(!temp_dir.exists(), "temp dir should be removed on drop_archive");
}

#[test]
fn invalid_archive_zip_corrupt_tail_missing_eocd_fails_fast() {
    let scratch_dir = TempDir::new("fast-skip-zip");

    let fake_zip = scratch_dir.path().join("truncated_missing_eocd.zip");
    let mut file = fs::File::create(&fake_zip).expect("create fake zip");
    use std::io::Write;
    file.write_all(b"PK\x03\x04").expect("write magic");
    file.set_len(128 * 1024).expect("set 128KB length");

    let res = list_zip_entries(fake_zip.to_str().unwrap(), None);

    assert!(res.is_err(), "truncated ZIP missing EOCD must fail");
    let err = res.err().unwrap();
    assert!(
        err.contains("End of Central Directory (EOCD) signature not found in archive tail"),
        "error should indicate tail EOCD check failed: {err}"
    );
}

#[test]
fn invalid_archive_zip_invalid_magic_fails_fast() {
    let scratch_dir = TempDir::new("fast-skip-zip-magic");

    let fake_zip = scratch_dir.path().join("not_a_zip.zip");
    fs::write(&fake_zip, b"<!DOCTYPE html><html>404 Not Found</html>").expect("write fake html");

    let res = list_zip_entries(fake_zip.to_str().unwrap(), None);
    assert!(res.is_err());
    assert!(res.err().unwrap().contains("missing PK signature header"));
}

#[test]
fn invalid_archive_rar_invalid_magic_and_truncated() {
    let scratch_dir = TempDir::new("fast-skip-rar");

    let small_rar = scratch_dir.path().join("too_small.rar");
    fs::write(&small_rar, b"Rar!").expect("write small");
    let res = list_rar_entries(small_rar.to_str().unwrap(), None);
    assert!(res.is_err());
    assert!(res
        .err()
        .unwrap()
        .contains("smaller than minimum RAR header"));

    let bad_magic = scratch_dir.path().join("bad_magic.rar");
    fs::write(&bad_magic, b"NOT_A_RAR_FILE_HEADER").expect("write bad magic");
    let res = list_rar_entries(bad_magic.to_str().unwrap(), None);
    assert!(res.is_err());
    assert!(res.err().unwrap().contains("missing RAR signature header"));
}

#[test]
fn invalid_archive_sevenz_invalid_magic_and_truncated() {
    let scratch_dir = TempDir::new("fast-skip-sevenz");

    let small_7z = scratch_dir.path().join("too_small.7z");
    fs::write(&small_7z, b"7z\xbc\xaf\x27\x1c").expect("write small");
    let res = list_7z_entries(small_7z.to_str().unwrap(), None);
    assert!(res.is_err());
    assert!(res
        .err()
        .unwrap()
        .contains("smaller than minimum 7Z header"));

    let bad_magic = scratch_dir.path().join("bad_magic.7z");
    fs::write(&bad_magic, [0u8; 32]).expect("write zeros");
    let res = list_7z_entries(bad_magic.to_str().unwrap(), None);
    assert!(res.is_err());
    assert!(res.err().unwrap().contains("missing 7Z signature header"));

    let trunc_7z = scratch_dir.path().join("truncated.7z");
    let mut header = [0u8; 32];
    header[0..6].copy_from_slice(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]);
    header[12..20].copy_from_slice(&1_000_000u64.to_le_bytes());
    header[20..28].copy_from_slice(&100u64.to_le_bytes());
    fs::write(&trunc_7z, header).expect("write header");
    let res = list_7z_entries(trunc_7z.to_str().unwrap(), None);
    assert!(res.is_err());
    assert!(res.err().unwrap().contains("truncated archive header"));
}

#[test]
fn invalid_archive_tar_invalid_checksum_and_truncated() {
    let scratch_dir = TempDir::new("fast-skip-tar");

    let small_tar = scratch_dir.path().join("too_small.tar");
    fs::write(&small_tar, b"tar data").expect("write small");
    let res = list_tar_entries(small_tar.to_str().unwrap());
    assert!(res.is_err());
    assert!(res
        .err()
        .unwrap()
        .contains("smaller than minimum TAR block"));

    let garbage_tar = scratch_dir.path().join("garbage.tar");
    let garbage = vec![0x42u8; 512];
    fs::write(&garbage_tar, garbage).expect("write garbage");
    let res = list_tar_entries(garbage_tar.to_str().unwrap());
    assert!(res.is_err());
    assert!(res.err().unwrap().contains("invalid header checksum"));
}

#[test]
fn archive_cache_max_open_archives_zero_does_not_hang() {
    let mut cache = ArchiveCache::new(2);
    cache.set_max_open_archives(0);

    cache.register_test_archive("only.cbz");
    assert!(cache.contains_archive("only.cbz"));

    cache.register_test_archive("next.cbz");
    assert!(!cache.contains_archive("only.cbz"));
    assert!(cache.contains_archive("next.cbz"));
}

#[test]
fn drop_archive_deferred_returns_temp_dir_without_removing_under_lock() {
    let scratch = TempDir::new("deferred-drop");
    let fake_temp = scratch.path().join("extracted-temp");
    fs::create_dir_all(&fake_temp).expect("create fake temp dir");
    fs::write(fake_temp.join("01.png"), b"png").expect("write marker");

    let mut cache = ArchiveCache::new(16);
    let key: Arc<str> = Arc::from("deferred-test.rar");
    let single = cache::SingleArchiveCache::with_temp_dir(
        Arc::clone(&key),
        fake_temp.clone(),
        None,
        None,
    );
    let cancel = single.cancel_flag();
    cache.register_archive_deferred(key, single, true);

    let deferred_dirs = cache.drop_archive_deferred("deferred-test.rar");
    assert_eq!(deferred_dirs, vec![fake_temp.clone()]);
    assert!(!cache.contains_archive("deferred-test.rar"));
    assert!(cancel.load(AtomicOrdering::Acquire));
    assert!(
        fake_temp.exists(),
        "drop_archive_deferred should defer fs::remove_dir_all to caller"
    );

    for dir in deferred_dirs {
        fs::remove_dir_all(dir).expect("remove deferred dir");
    }
    assert!(!fake_temp.exists());
}

#[test]
fn extract_state_tracks_extracted_order_without_duplicates() {
    let notify = cache::new_extract_notify();
    cache::notify_extracted(&notify, "01.png");
    cache::notify_extracted(&notify, "02.png");
    cache::notify_extracted(&notify, "01.png");
    cache::notify_extracted(&notify, "03.png");

    let (lock, _) = &*notify;
    let guard = lock.lock().unwrap();
    assert_eq!(guard.extracted_order, vec!["01.png", "02.png", "03.png"]);
    assert_eq!(guard.extracted.len(), 3);

    // Cursor progression slices only newly arrived items in O(1).
    let mut cursor = 0usize;
    let first_batch = guard.extracted_order[cursor..2].to_vec();
    cursor = 2;
    assert_eq!(first_batch, vec!["01.png", "02.png"]);
    let second_batch = guard.extracted_order[cursor..].to_vec();
    assert_eq!(second_batch, vec!["03.png"]);
}

#[test]
fn read_plain_zip_entry_shared_does_not_block_while_read_entry_header_shared_waits() {
    let cbz = test_file("cbz.cbz");
    assert!(cbz.exists(), "missing fixture: {}", cbz.display());
    let cbz_str = cbz.to_str().unwrap().to_string();
    let cbz_entries = list_archive_names(&cbz_str).expect("list cbz");
    let cbz_entry = cbz_entries
        .iter()
        .find(|e| !e.is_dir)
        .expect("cbz has file")
        .name
        .clone();

    let scratch = TempDir::new("nonblocking-header");
    let pending_temp = scratch.path().join("pending-rar");
    fs::create_dir_all(&pending_temp).expect("create pending temp dir");

    let state = Arc::new(RwLock::new(ArchiveCache::new(64)));
    let pending_key = "synthetic-pending.rar";
    let notify = {
        let mut cache = state.write().unwrap();
        let key: Arc<str> = Arc::from(pending_key);
        let single = cache::SingleArchiveCache::with_temp_dir(
            Arc::clone(&key),
            pending_temp.clone(),
            None,
            None,
        );
        let notify = single.notify();
        cache.register_archive_deferred(key, single, true);
        notify
    };

    let state_for_waiter = Arc::clone(&state);
    let waiter = std::thread::spawn(move || {
        read_entry_header_shared(&state_for_waiter, pending_key, "page01.png", 64)
    });

    // Give waiter a moment to enter wait_for_extracted_path.
    std::thread::sleep(Duration::from_millis(40));

    // Concurrent ZIP read must complete immediately without blocking on the pending RAR header wait.
    let start = std::time::Instant::now();
    let zip_bytes = read_plain_zip_entry_shared(&state, &cbz_str, &cbz_entry)
        .expect("zip returns Some")
        .expect("zip extract ok");
    assert!(!zip_bytes.is_empty());
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "ZIP read stalled behind pending temp header read"
    );

    // Now fulfill the pending entry so the waiter completes cleanly.
    let out_path = archive_entry_temp_path(&pending_temp, "page01.png").unwrap();
    fs::write(&out_path, b"\x89PNG\r\n\x1a\nheader-bytes").expect("write pending entry");
    cache::notify_extracted(&notify, "page01.png");
    cache::notify_finished(&notify);

    let hdr = waiter
        .join()
        .expect("join header waiter")
        .expect("pending header read succeeds");
    assert!(hdr.starts_with(b"\x89PNG\r\n\x1a\n"));
}

#[test]
fn rar_streaming_extraction_works_for_plain_and_encrypted_archives() {
    let state = RwLock::new(ArchiveCache::new(32));

    let cbr = test_file("cbr.cbr");
    assert!(cbr.exists(), "missing fixture: {}", cbr.display());
    let cbr_str = cbr.to_str().unwrap();
    let cbr_res = prepare_archive_shared(&state, cbr_str, None).expect("prepare cbr");
    let cbr_entry = cbr_res
        .files
        .iter()
        .find(|f| !f.is_dir)
        .expect("cbr has entry")
        .name
        .clone();
    let cbr_bytes =
        read_entry_bytes_shared(&state, cbr_str, &cbr_entry).expect("extract cbr entry");
    assert!(!cbr_bytes.is_empty());

    let enc_rar = encrypted_test_file("encrypted-123.rar");
    assert!(enc_rar.exists(), "missing fixture: {}", enc_rar.display());
    let enc_str = enc_rar.to_str().unwrap();

    let locked = prepare_archive_shared(&state, enc_str, None).expect("list locked rar");
    assert_eq!(
        locked.encryption,
        Some(ArchiveEncryptionStatus::PasswordRequired)
    );

    let wrong = prepare_archive_shared(&state, enc_str, Some("wrong")).expect("list wrong pwd");
    assert_eq!(
        wrong.encryption,
        Some(ArchiveEncryptionStatus::PasswordIncorrect)
    );

    let unlocked = prepare_archive_shared(&state, enc_str, Some("123")).expect("unlock rar");
    assert_eq!(unlocked.encryption, None);
    let enc_entry = unlocked
        .files
        .iter()
        .find(|f| !f.is_dir)
        .expect("encrypted rar has entry")
        .name
        .clone();
    let enc_bytes =
        read_entry_bytes_shared(&state, enc_str, &enc_entry).expect("extract encrypted rar entry");
    assert!(!enc_bytes.is_empty());

    let dirs = {
        let mut cache = state.write().unwrap();
        let mut d = cache.drop_archive_deferred(cbr_str);
        d.extend(cache.drop_archive_deferred(enc_str));
        d
    };
    for dir in dirs {
        let _ = fs::remove_dir_all(dir);
    }
}
