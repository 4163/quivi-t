use crate::platform::temp_archive::{
    deduplicate_candidate_archives, parse_7z_folder_history, parse_7z_window_title,
    parse_bandizip_archive_name, parse_bandizip_window_title, parse_peazip_window_title,
    parse_temp_engine, parse_winrar_window_title, select_sevenzip_live_candidates,
    sevenzip_creator_pid_low12, TempEngine,
};
use std::path::PathBuf;

fn fixture_archive_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("test-files")
        .join("_archives")
        .join("zip.zip")
}

fn fixture_archive_string() -> String {
    let path = fixture_archive_path();
    path.canonicalize()
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

fn temp_path(parts: &[&str]) -> PathBuf {
    let mut path = std::env::temp_dir();
    for part in parts {
        path.push(part);
    }
    path
}

#[test]
fn test_parse_explorer_temp_path() {
    let p1 = temp_path(&[
        "8c8b0bbf-a0e0-48b1-bd41-8a199b9c66e5_zip.zip.6e5",
        "export.png",
    ]);
    assert_eq!(
        parse_temp_engine(&p1),
        Some(TempEngine::WindowsExplorer {
            archive_filename: "zip.zip".to_string(),
            rel_entry: "export.png".to_string(),
        })
    );

    let p2 = temp_path(&[
        "8fa2de21-bee0-40f5-b9a5-aa9c0e20449d_manga.cbz.49d",
        "chapter1",
        "01.png",
    ]);
    assert_eq!(
        parse_temp_engine(&p2),
        Some(TempEngine::WindowsExplorer {
            archive_filename: "manga.cbz".to_string(),
            rel_entry: "chapter1/01.png".to_string(),
        })
    );

    let p_legacy = temp_path(&["Temp42_comic.zip", "sub", "cover.jpg"]);
    assert_eq!(
        parse_temp_engine(&p_legacy),
        Some(TempEngine::WindowsExplorer {
            archive_filename: "comic.zip".to_string(),
            rel_entry: "sub/cover.jpg".to_string(),
        })
    );
}

#[test]
fn test_parse_peazip_temp_path() {
    let p1 = temp_path(&["peazip-tmp", ".ptmp0F5E47", "export.png"]);
    assert_eq!(
        parse_temp_engine(&p1),
        Some(TempEngine::PeaZip {
            rel_entry: "export.png".to_string(),
        })
    );

    let p2 = temp_path(&["peazip-tmp", ".ptmp0F5E47", "New folder", "nested.png"]);
    assert_eq!(
        parse_temp_engine(&p2),
        Some(TempEngine::PeaZip {
            rel_entry: "New folder/nested.png".to_string(),
        })
    );
}

#[test]
fn test_parse_winzip_temp_path() {
    let p1 = temp_path(&["wz013b", "export.png"]);
    assert_eq!(
        parse_temp_engine(&p1),
        Some(TempEngine::WinZip {
            rel_entry: "export.png".to_string(),
        })
    );

    let p2 = temp_path(&["wz78dc", "New folder", "export.png"]);
    assert_eq!(
        parse_temp_engine(&p2),
        Some(TempEngine::WinZip {
            rel_entry: "New folder/export.png".to_string(),
        })
    );
}

#[test]
fn test_parse_winrar_temp_path_and_window_title() {
    let p_dialog = temp_path(&["Rar$DIa19052.17864.rartemp", "export.png"]);
    assert_eq!(
        parse_temp_engine(&p_dialog),
        Some(TempEngine::WinRar {
            pid: 19052,
            filename: "export.png".to_string(),
        })
    );

    let p_drag = temp_path(&["Rar$DRa20180.20230.rartemp", "export.png"]);
    assert_eq!(
        parse_temp_engine(&p_drag),
        Some(TempEngine::WinRar {
            pid: 20180,
            filename: "export.png".to_string(),
        })
    );

    assert_eq!(
        parse_winrar_window_title(r"archive.rar\New folder - WinRAR"),
        Some("New folder".to_string())
    );
    assert_eq!(
        parse_winrar_window_title(r"archive.rar\New folder (only 2 days left to buy a license)"),
        Some("New folder".to_string())
    );
    assert_eq!(
        parse_winrar_window_title(r"E:\path\archive.rar\New folder - WinRAR"),
        Some("New folder".to_string())
    );
    assert_eq!(
        parse_winrar_window_title(r"archive.rar - WinRAR"),
        Some(String::new())
    );
    assert_eq!(
        parse_winrar_window_title(r"E:\path\archive.rar - WinRAR"),
        Some(String::new())
    );
    assert_eq!(
        parse_winrar_window_title(r"archive.rar\ - WinRAR"),
        Some(String::new())
    );
}

#[test]
fn test_parse_7zip_temp_path_and_folder_history() {
    let p1 = temp_path(&["7zO81809E5E", "export.png"]);
    assert_eq!(
        parse_temp_engine(&p1),
        Some(TempEngine::SevenZip {
            filename: "export.png".to_string(),
            creator_pid_low12: Some(0x818),
        })
    );

    let p2 = temp_path(&["7zE0564639E", "drag.png"]);
    assert_eq!(
        parse_temp_engine(&p2),
        Some(TempEngine::SevenZip {
            filename: "drag.png".to_string(),
            creator_pid_low12: Some(0x650),
        })
    );

    assert_eq!(sevenzip_creator_pid_low12("7zO81809E5E"), Some(0x818));
    assert_eq!(sevenzip_creator_pid_low12("7zO0564639E"), Some(0x650));

    // Mock UTF-16LE FolderHistory binary with fixture path
    let fixture = fixture_archive_string();
    let history_str = format!("{fixture}\\chapter1\\\0{fixture}\\\0");
    let bytes: Vec<u8> = history_str
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();

    let mut candidates = Vec::new();
    parse_7z_folder_history(&bytes, &mut candidates);
    if PathBuf::from(&fixture).exists() {
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].known_subfolder, None);
        assert_eq!(candidates[1].known_subfolder, None);
    }

    // Test parse_7z_window_title on existing test file
    let sub_title = format!(r"{fixture}\New folder\");
    if let Some((_arc, known_sub)) = parse_7z_window_title(&sub_title) {
        assert_eq!(known_sub, Some("New folder".to_string()));
    }
    let root_title = format!(r"{fixture}\");
    if let Some((_arc, known_sub)) = parse_7z_window_title(&root_title) {
        assert_eq!(known_sub, Some(String::new()));
    }
    let bare_title = fixture.to_string();
    if let Some((_arc, known_sub)) = parse_7z_window_title(&bare_title) {
        assert_eq!(known_sub, Some(String::new()));
    }
}

#[test]
fn test_parse_bandizip_temp_path_and_window_title() {
    let p1 = temp_path(&["BNZ.6aa4604625b3e2d", "export.png"]);
    assert_eq!(
        parse_temp_engine(&p1),
        Some(TempEngine::Bandizip {
            filename: "export.png".to_string(),
        })
    );

    let p2 = temp_path(&["~bz.thumb.abc", "thumb.png"]);
    assert_eq!(
        parse_temp_engine(&p2),
        Some(TempEngine::Bandizip {
            filename: "thumb.png".to_string(),
        })
    );

    assert!(
        parse_bandizip_window_title("nonexistent_test_archive_abc123.zip - Bandizip").is_none()
    );
    assert_eq!(
        parse_bandizip_archive_name("zip.zip - Bandizip (Standard) [Administrator]"),
        Some("zip.zip".to_string())
    );
    assert!(parse_peazip_window_title("PeaZip - nonexistent_test_archive_abc123.zip").is_none());
}

#[test]
fn test_ignore_non_temp_paths() {
    let normal_path = PathBuf::from(r"C:\Users\tester\Desktop\image.png");
    assert_eq!(parse_temp_engine(&normal_path), None);

    let drive_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("test-files")
        .join("sample.png");
    assert_eq!(parse_temp_engine(&drive_path), None);

    let temp_named_folder = PathBuf::from(r"E:\work\temp\7zO81809E5E\export.png");
    assert_eq!(parse_temp_engine(&temp_named_folder), None);
}

#[test]
fn test_match_candidate_origin_subfolder_and_root() {
    let fixture = fixture_archive_string();
    if !PathBuf::from(&fixture).exists() {
        return;
    }
    let mut cache = crate::archives::ArchiveCache::new(50);
    let archive_result = cache
        .prepare_archive(&fixture, None)
        .expect("failed to open fixture");

    let engine = TempEngine::SevenZip {
        filename: "export_1785518835803.apng".to_string(),
        creator_pid_low12: None,
    };

    // 1. When subfolder is "New folder", matches entry in "New folder"
    let cand_sub = crate::platform::temp_archive::CandidateArchive::with_subfolder(
        PathBuf::from(&fixture),
        Some("New folder".to_string()),
    );
    let origin_sub = crate::platform::temp_archive::match_candidate_origin(
        &cand_sub,
        &engine,
        0,
        &archive_result,
    );
    assert_eq!(
        origin_sub,
        Some(crate::models::TempArchiveOrigin {
            archive_path: fixture.clone(),
            entry_name: "New folder/export_1785518835803.apng".to_string(),
        })
    );

    // 2. When subfolder is "" (explicit root), matches entry at root
    let cand_root = crate::platform::temp_archive::CandidateArchive::with_subfolder(
        PathBuf::from(&fixture),
        Some(String::new()),
    );
    let origin_root = crate::platform::temp_archive::match_candidate_origin(
        &cand_root,
        &engine,
        0,
        &archive_result,
    );
    assert_eq!(
        origin_root,
        Some(crate::models::TempArchiveOrigin {
            archive_path: fixture.clone(),
            entry_name: "export_1785518835803.apng".to_string(),
        })
    );

    // 3. When known_subfolder is None and ambiguous duplicates exist, returns None (fails closed)
    let cand_none = crate::platform::temp_archive::CandidateArchive::new(PathBuf::from(&fixture));
    let origin_none = crate::platform::temp_archive::match_candidate_origin(
        &cand_none,
        &engine,
        0,
        &archive_result,
    );
    assert_eq!(origin_none, None);
}

#[test]
fn test_deduplicate_and_subfolder_override() {
    let fixture = fixture_archive_string();
    if !PathBuf::from(&fixture).exists() {
        return;
    }
    let mut cache = crate::archives::ArchiveCache::new(50);
    let archive_result = cache
        .prepare_archive(&fixture, None)
        .expect("failed to open fixture");

    let engine = TempEngine::Bandizip {
        filename: "export_1785518835803.apng".to_string(),
    };

    // When known_subfolder is Some("") (root) but subfolder_index is Some(0),
    // subfolder_index should take precedence and resolve to "New folder"
    let mut cand = crate::platform::temp_archive::CandidateArchive::with_subfolder(
        PathBuf::from(&fixture),
        Some(String::new()),
    );
    cand.subfolder_index = Some(0);

    let origin =
        crate::platform::temp_archive::match_candidate_origin(&cand, &engine, 0, &archive_result);
    assert_eq!(
        origin,
        Some(crate::models::TempArchiveOrigin {
            archive_path: fixture.clone(),
            entry_name: "New folder/export_1785518835803.apng".to_string(),
        })
    );
}

#[test]
fn test_explorer_entry_matching_uses_relative_path() {
    let fixture = fixture_archive_string();
    if !PathBuf::from(&fixture).exists() {
        return;
    }

    let mut cache = crate::archives::ArchiveCache::new(50);
    let archive_result = cache.prepare_archive(&fixture, None).unwrap();
    let candidate = crate::platform::temp_archive::CandidateArchive::new(PathBuf::from(&fixture));

    let nested_engine = TempEngine::WindowsExplorer {
        archive_filename: "zip.zip".to_string(),
        rel_entry: "New folder/export_1785518835803.apng".to_string(),
    };
    let nested_origin = crate::platform::temp_archive::match_candidate_origin(
        &candidate,
        &nested_engine,
        0,
        &archive_result,
    );
    assert_eq!(
        nested_origin,
        Some(crate::models::TempArchiveOrigin {
            archive_path: fixture.clone(),
            entry_name: "New folder/export_1785518835803.apng".to_string(),
        })
    );

    let root_engine = TempEngine::WindowsExplorer {
        archive_filename: "zip.zip".to_string(),
        rel_entry: "export_1785518835803.apng".to_string(),
    };
    let root_origin = crate::platform::temp_archive::match_candidate_origin(
        &candidate,
        &root_engine,
        0,
        &archive_result,
    );
    assert_eq!(
        root_origin,
        Some(crate::models::TempArchiveOrigin {
            archive_path: fixture,
            entry_name: "export_1785518835803.apng".to_string(),
        })
    );
}

#[test]
fn test_7z_folder_history_dedup_and_subfolder_match() {
    let fixture = fixture_archive_string();
    if !PathBuf::from(&fixture).exists() {
        return;
    }
    let history_str = format!("{fixture}\\New folder\\\0{fixture}\\\0");
    let bytes: Vec<u8> = history_str
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();

    let mut candidates = Vec::new();
    parse_7z_folder_history(&bytes, &mut candidates);
    assert_eq!(candidates.len(), 2);
    assert_eq!(candidates[0].known_subfolder, None);
    assert_eq!(candidates[1].known_subfolder, None);

    // Add a live window candidate representing root view
    candidates.push(
        crate::platform::temp_archive::CandidateArchive::with_subfolder(
            PathBuf::from(&fixture),
            Some(String::new()),
        ),
    );

    let engine = TempEngine::SevenZip {
        filename: "export_1785518835803.apng".to_string(),
        creator_pid_low12: None,
    };

    let deduped = deduplicate_candidate_archives(&engine, candidates);

    assert_eq!(deduped.len(), 1);
    // Live window root must be preserved and not overwritten
    assert_eq!(deduped[0].known_subfolder, Some(String::new()));

    let mut cache = crate::archives::ArchiveCache::new(50);
    let archive_result = cache.prepare_archive(&fixture, None).unwrap();
    let origin_root = crate::platform::temp_archive::match_candidate_origin(
        &deduped[0],
        &engine,
        0,
        &archive_result,
    );
    assert_eq!(
        origin_root,
        Some(crate::models::TempArchiveOrigin {
            archive_path: fixture.clone(),
            entry_name: "export_1785518835803.apng".to_string(),
        })
    );

    // When live window is in "New folder"
    let mut cand_sub = deduped[0].clone();
    cand_sub.known_subfolder = Some("New folder".to_string());
    let origin_sub = crate::platform::temp_archive::match_candidate_origin(
        &cand_sub,
        &engine,
        0,
        &archive_result,
    );
    assert_eq!(
        origin_sub,
        Some(crate::models::TempArchiveOrigin {
            archive_path: fixture.clone(),
            entry_name: "New folder/export_1785518835803.apng".to_string(),
        })
    );
}

#[test]
fn test_winrar_window_title_and_subfolder_match() {
    let fixture = fixture_archive_string();
    if !PathBuf::from(&fixture).exists() {
        return;
    }
    let mut cache = crate::archives::ArchiveCache::new(50);
    let archive_result = cache.prepare_archive(&fixture, None).unwrap();

    let engine = TempEngine::WinRar {
        pid: 1234,
        filename: "export_1785518835803.apng".to_string(),
    };

    // 1. Root window title "zip.zip - WinRAR" -> matches root entry
    let sub_root = parse_winrar_window_title("zip.zip - WinRAR");
    assert_eq!(sub_root, Some(String::new()));
    let cand_root = crate::platform::temp_archive::CandidateArchive::with_subfolder(
        PathBuf::from(&fixture),
        sub_root,
    );
    let origin_root = crate::platform::temp_archive::match_candidate_origin(
        &cand_root,
        &engine,
        0,
        &archive_result,
    );
    assert_eq!(
        origin_root,
        Some(crate::models::TempArchiveOrigin {
            archive_path: fixture.clone(),
            entry_name: "export_1785518835803.apng".to_string(),
        })
    );

    // 2. Subfolder window title "zip.zip\New folder - WinRAR" -> matches subfolder entry
    let sub_folder = parse_winrar_window_title(r"zip.zip\New folder - WinRAR");
    assert_eq!(sub_folder, Some("New folder".to_string()));
    let cand_folder = crate::platform::temp_archive::CandidateArchive::with_subfolder(
        PathBuf::from(&fixture),
        sub_folder,
    );
    let origin_folder = crate::platform::temp_archive::match_candidate_origin(
        &cand_folder,
        &engine,
        0,
        &archive_result,
    );
    assert_eq!(
        origin_folder,
        Some(crate::models::TempArchiveOrigin {
            archive_path: fixture.clone(),
            entry_name: "New folder/export_1785518835803.apng".to_string(),
        })
    );
}

#[test]
fn test_nanazip_window_title_and_subfolder_match() {
    let fixture = fixture_archive_string();
    if !PathBuf::from(&fixture).exists() {
        return;
    }
    let mut cache = crate::archives::ArchiveCache::new(50);
    let archive_result = cache
        .prepare_archive(&fixture, None)
        .expect("failed to open fixture");

    let engine = TempEngine::SevenZip {
        filename: "export_1785518835803.apng".to_string(),
        creator_pid_low12: None,
    };

    // 1. NanaZip root title "E:\...\zip.zip\" -> parses to explicit root Some("")
    let root_title = format!(r"{fixture}\");
    let (arc, sub_root) =
        parse_7z_window_title(&root_title).expect("failed to parse NanaZip root title");
    assert_eq!(arc, fixture);
    assert_eq!(sub_root, Some(String::new()));
    let cand_root = crate::platform::temp_archive::CandidateArchive::with_subfolder(
        PathBuf::from(arc),
        sub_root,
    );
    let origin_root = crate::platform::temp_archive::match_candidate_origin(
        &cand_root,
        &engine,
        0,
        &archive_result,
    );
    assert_eq!(
        origin_root,
        Some(crate::models::TempArchiveOrigin {
            archive_path: fixture.clone(),
            entry_name: "export_1785518835803.apng".to_string(),
        })
    );

    // 2. NanaZip subfolder title "E:\...\zip.zip\New folder\" -> parses to subfolder Some("New folder")
    let sub_title = format!(r"{fixture}\New folder\");
    let (arc_sub, sub_folder) =
        parse_7z_window_title(&sub_title).expect("failed to parse NanaZip sub title");
    assert_eq!(arc_sub, fixture);
    assert_eq!(sub_folder, Some("New folder".to_string()));
    let cand_folder = crate::platform::temp_archive::CandidateArchive::with_subfolder(
        PathBuf::from(arc_sub),
        sub_folder,
    );
    let origin_folder = crate::platform::temp_archive::match_candidate_origin(
        &cand_folder,
        &engine,
        0,
        &archive_result,
    );
    assert_eq!(
        origin_folder,
        Some(crate::models::TempArchiveOrigin {
            archive_path: fixture.clone(),
            entry_name: "New folder/export_1785518835803.apng".to_string(),
        })
    );
}

#[test]
fn test_parse_nanazip_address_bar_paths() {
    let fixture = fixture_archive_string();
    let sub = format!(r"{fixture}\New folder\");
    let parsed_sub = parse_7z_window_title(&sub);
    assert_eq!(
        parsed_sub,
        Some((fixture.clone(), Some("New folder".to_string())))
    );

    let nested = r"C:\path\to\archive.7z\dir1\dir2\";
    let parsed_nested = parse_7z_window_title(nested);
    assert_eq!(
        parsed_nested,
        Some((
            r"C:\path\to\archive.7z".to_string(),
            Some("dir1/dir2".to_string())
        ))
    );

    let root_slash = format!(r"{fixture}\");
    let parsed_root = parse_7z_window_title(&root_slash);
    assert_eq!(parsed_root, Some((fixture.clone(), Some("".to_string()))));

    let parsed_no_slash = parse_7z_window_title(&fixture);
    assert_eq!(parsed_no_slash, Some((fixture, Some("".to_string()))));
}

#[test]
fn test_7z_nanazip_conflicting_live_context_fails_closed() {
    use crate::platform::temp_archive::CandidateArchive;

    let path = fixture_archive_path();

    let candidates = vec![
        CandidateArchive::with_subfolder(path.clone(), Some(String::new())),
        CandidateArchive::with_subfolder(path.clone(), Some("New folder".to_string())),
    ];
    let engine = TempEngine::SevenZip {
        filename: "export_1785518835803.apng".to_string(),
        creator_pid_low12: None,
    };
    let deduped = deduplicate_candidate_archives(&engine, candidates);

    assert_eq!(deduped.len(), 1);
    assert_eq!(deduped[0].known_subfolder, None);

    let candidates_reversed = vec![
        CandidateArchive::with_subfolder(path.clone(), Some("New folder".to_string())),
        CandidateArchive::with_subfolder(path.clone(), Some(String::new())),
    ];
    let deduped2 = deduplicate_candidate_archives(&engine, candidates_reversed);

    assert_eq!(deduped2.len(), 1);
    assert_eq!(deduped2[0].known_subfolder, None);

    let bandizip_engine = TempEngine::Bandizip {
        filename: "export_1785518835803.apng".to_string(),
    };
    let bandizip_deduped = deduplicate_candidate_archives(
        &bandizip_engine,
        vec![
            CandidateArchive::with_subfolder(path.clone(), Some(String::new())),
            CandidateArchive::with_subfolder(path, Some("New folder".to_string())),
        ],
    );

    assert_eq!(bandizip_deduped.len(), 1);
    assert_eq!(
        bandizip_deduped[0].known_subfolder,
        Some("New folder".to_string())
    );
}

#[test]
fn test_7z_nanazip_pid_hint_selects_matching_window() {
    use crate::platform::temp_archive::CandidateArchive;

    let path = fixture_archive_path();
    let root = CandidateArchive::with_subfolder(path.clone(), Some(String::new()));
    let subfolder = CandidateArchive::with_subfolder(path, Some("New folder".to_string()));

    let selected = select_sevenzip_live_candidates(
        Some(0x650),
        vec![(0x1650, root.clone()), (0x1818, subfolder.clone())],
    );
    assert_eq!(selected, vec![root.clone()]);

    let unmatched = select_sevenzip_live_candidates(
        Some(0x999),
        vec![(0x1650, root.clone()), (0x1818, subfolder.clone())],
    );
    assert!(unmatched.is_empty());

    let no_hint =
        select_sevenzip_live_candidates(None, vec![(0x1650, root.clone()), (0x1818, subfolder)]);
    assert_eq!(no_hint.len(), 2);
}

#[test]
fn test_nanazip_match_candidate_origin_subfolder_vs_root() {
    use crate::models::{ArchiveReadResult, FileEntry};
    use crate::platform::temp_archive::{match_candidate_origin, CandidateArchive};

    let fixture = fixture_archive_string();

    let arc_result = ArchiveReadResult {
        archive_path: fixture.clone(),
        files: vec![
            FileEntry::new_archive_entry(
                "export_1785518835803.apng".to_string(),
                "export_1785518835803.apng".to_string(),
                "apng".to_string(),
                String::new(),
                1000,
            ),
            FileEntry::new_archive_entry(
                "New folder/export_1785518835803.apng".to_string(),
                "New folder/export_1785518835803.apng".to_string(),
                "apng".to_string(),
                String::new(),
                1000,
            ),
        ],
        encryption: None,
    };

    let engine = TempEngine::SevenZip {
        filename: "export_1785518835803.apng".to_string(),
        creator_pid_low12: None,
    };

    // Candidate with resolved subfolder "New folder" (from NanaZip address bar)
    let cand_sub =
        CandidateArchive::with_subfolder(PathBuf::from(&fixture), Some("New folder".to_string()));
    let origin_sub = match_candidate_origin(&cand_sub, &engine, 1000, &arc_result);
    assert!(origin_sub.is_some());
    assert_eq!(
        origin_sub.unwrap().entry_name,
        "New folder/export_1785518835803.apng"
    );

    // Candidate with root "" (NanaZip opened from root)
    let cand_root = CandidateArchive::with_subfolder(PathBuf::from(&fixture), Some(String::new()));
    let origin_root = match_candidate_origin(&cand_root, &engine, 1000, &arc_result);
    assert!(origin_root.is_some());
    assert_eq!(origin_root.unwrap().entry_name, "export_1785518835803.apng");
}
