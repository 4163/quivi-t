use super::*;
use crate::formats::*;

use std::fs;

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
    let temp_dir = std::env::temp_dir().join("QuiviT-test-path-safety");

    assert!(archive_entry_temp_path(&temp_dir, "folder/page.jpg").is_some());
    assert!(archive_entry_temp_path(&temp_dir, "folder\\page.jpg").is_some());
    assert!(archive_entry_temp_path(&temp_dir, "../page.jpg").is_none());
    assert!(archive_entry_temp_path(&temp_dir, "folder/../../page.jpg").is_none());
    assert!(archive_entry_temp_path(&temp_dir, "/absolute/page.jpg").is_none());
    assert!(archive_entry_temp_path(&temp_dir, "").is_none());
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
    if !path.exists() {
        return;
    }
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
fn invalid_archive_zip_corrupt_tail_missing_eocd_fails_fast() {
    let scratch_dir = std::env::temp_dir().join("quivit-test-fast-skip-zip");
    let _ = fs::remove_dir_all(&scratch_dir);
    fs::create_dir_all(&scratch_dir).expect("create scratch dir");

    let fake_zip = scratch_dir.join("truncated_missing_eocd.zip");
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

    let _ = fs::remove_dir_all(&scratch_dir);
}

#[test]
fn invalid_archive_zip_invalid_magic_fails_fast() {
    let scratch_dir = std::env::temp_dir().join("quivit-test-fast-skip-zip-magic");
    let _ = fs::remove_dir_all(&scratch_dir);
    fs::create_dir_all(&scratch_dir).expect("create scratch dir");

    let fake_zip = scratch_dir.join("not_a_zip.zip");
    fs::write(&fake_zip, b"<!DOCTYPE html><html>404 Not Found</html>").expect("write fake html");

    let res = list_zip_entries(fake_zip.to_str().unwrap(), None);
    assert!(res.is_err());
    assert!(res.err().unwrap().contains("missing PK signature header"));

    let _ = fs::remove_dir_all(&scratch_dir);
}

#[test]
fn invalid_archive_rar_invalid_magic_and_truncated() {
    let scratch_dir = std::env::temp_dir().join("quivit-test-fast-skip-rar");
    let _ = fs::remove_dir_all(&scratch_dir);
    fs::create_dir_all(&scratch_dir).expect("create scratch dir");

    let small_rar = scratch_dir.join("too_small.rar");
    fs::write(&small_rar, b"Rar!").expect("write small");
    let res = list_rar_entries(small_rar.to_str().unwrap(), None);
    assert!(res.is_err());
    assert!(res
        .err()
        .unwrap()
        .contains("smaller than minimum RAR header"));

    let bad_magic = scratch_dir.join("bad_magic.rar");
    fs::write(&bad_magic, b"NOT_A_RAR_FILE_HEADER").expect("write bad magic");
    let res = list_rar_entries(bad_magic.to_str().unwrap(), None);
    assert!(res.is_err());
    assert!(res.err().unwrap().contains("missing RAR signature header"));

    let _ = fs::remove_dir_all(&scratch_dir);
}

#[test]
fn invalid_archive_sevenz_invalid_magic_and_truncated() {
    let scratch_dir = std::env::temp_dir().join("quivit-test-fast-skip-sevenz");
    let _ = fs::remove_dir_all(&scratch_dir);
    fs::create_dir_all(&scratch_dir).expect("create scratch dir");

    let small_7z = scratch_dir.join("too_small.7z");
    fs::write(&small_7z, b"7z\xbc\xaf\x27\x1c").expect("write small");
    let res = list_7z_entries(small_7z.to_str().unwrap(), None);
    assert!(res.is_err());
    assert!(res
        .err()
        .unwrap()
        .contains("smaller than minimum 7Z header"));

    let bad_magic = scratch_dir.join("bad_magic.7z");
    fs::write(&bad_magic, [0u8; 32]).expect("write zeros");
    let res = list_7z_entries(bad_magic.to_str().unwrap(), None);
    assert!(res.is_err());
    assert!(res.err().unwrap().contains("missing 7Z signature header"));

    let trunc_7z = scratch_dir.join("truncated.7z");
    let mut header = [0u8; 32];
    header[0..6].copy_from_slice(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]);
    header[12..20].copy_from_slice(&1_000_000u64.to_le_bytes());
    header[20..28].copy_from_slice(&100u64.to_le_bytes());
    fs::write(&trunc_7z, header).expect("write header");
    let res = list_7z_entries(trunc_7z.to_str().unwrap(), None);
    assert!(res.is_err());
    assert!(res.err().unwrap().contains("truncated archive header"));

    let _ = fs::remove_dir_all(&scratch_dir);
}

#[test]
fn invalid_archive_tar_invalid_checksum_and_truncated() {
    let scratch_dir = std::env::temp_dir().join("quivit-test-fast-skip-tar");
    let _ = fs::remove_dir_all(&scratch_dir);
    fs::create_dir_all(&scratch_dir).expect("create scratch dir");

    let small_tar = scratch_dir.join("too_small.tar");
    fs::write(&small_tar, b"tar data").expect("write small");
    let res = list_tar_entries(small_tar.to_str().unwrap());
    assert!(res.is_err());
    assert!(res
        .err()
        .unwrap()
        .contains("smaller than minimum TAR block"));

    let garbage_tar = scratch_dir.join("garbage.tar");
    let garbage = vec![0x42u8; 512];
    fs::write(&garbage_tar, garbage).expect("write garbage");
    let res = list_tar_entries(garbage_tar.to_str().unwrap());
    assert!(res.is_err());
    assert!(res.err().unwrap().contains("invalid header checksum"));

    let _ = fs::remove_dir_all(&scratch_dir);
}
