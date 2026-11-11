use super::*;

struct TempTestDir {
    path: PathBuf,
}

impl TempTestDir {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "quivit_lib_test_{name}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create temp test dir");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempTestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

static CONFIG_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct ConfigEnvGuard {
    prev: Option<String>,
}

impl ConfigEnvGuard {
    fn set(path: &Path) -> Self {
        let prev = std::env::var("QUIVIT_CONFIG_DIR").ok();
        std::env::set_var("QUIVIT_CONFIG_DIR", path);
        Self { prev }
    }
}

impl Drop for ConfigEnvGuard {
    fn drop(&mut self) {
        match &self.prev {
            Some(val) => std::env::set_var("QUIVIT_CONFIG_DIR", val),
            None => std::env::remove_var("QUIVIT_CONFIG_DIR"),
        }
    }
}

#[test]
fn active_library_root_stays_writable_despite_retired_history() {
    let _lock = CONFIG_ENV_LOCK.lock().unwrap();
    // Regression guard: the retired list is append-only history and may
    // name the active root after a move back to a prior location. Writes
    // under the configured root must still be allowed.
    let root = crate::config::configured_library_dir().expect("library dir resolves");
    assert!(ensure_library_write_allowed(&root.join("probe")).is_ok());
}

#[test]
fn test_path_is_within_containment_and_normalization() {
    let root = Path::new(r"C:\QuiviT\Library");

    assert!(path_is_within(root, root));
    assert!(path_is_within(&root.join("sub"), root));
    assert!(path_is_within(
        &root.join("sub").join("nested").join("image.png"),
        root
    ));

    assert!(path_is_within(Path::new(r"C:\QuiviT\Library\"), root));
    assert!(path_is_within(Path::new("C:/QuiviT/Library/sub"), root));
    assert!(path_is_within(Path::new("C:/QuiviT/Library/sub/"), root));
    assert!(path_is_within(
        Path::new(r"C:\QuiviT\Library\sub\"),
        Path::new(r"C:\QuiviT\Library\")
    ));

    #[cfg(windows)]
    {
        assert!(path_is_within(
            Path::new(r"c:\quivit\library\sub\file.png"),
            root
        ));
        assert!(path_is_within(Path::new(r"C:\QUIVIT\LIBRARY\SUB"), root));
    }

    assert!(!path_is_within(Path::new(r"C:\QuiviT\LibraryExtra"), root));
    assert!(!path_is_within(
        Path::new(r"C:\QuiviT\LibraryExtra\sub"),
        root
    ));
    assert!(!path_is_within(Path::new(r"C:\QuiviT"), root));
    assert!(!path_is_within(Path::new(r"D:\QuiviT\Library\sub"), root));
    assert!(!path_is_within(Path::new(r"C:\Other\Folder"), root));
}

#[test]
fn test_is_within_library() {
    let _lock = CONFIG_ENV_LOCK.lock().unwrap();
    let root = crate::config::configured_library_dir().expect("library dir resolves");
    assert!(is_within_library(&root));
    assert!(is_within_library(&root.join("subfolder")));
    assert!(is_within_library(&root.join("subfolder").join("image.jpg")));

    let temp = TempTestDir::new("outside_library");
    assert!(!is_within_library(temp.path()));

    let collision = PathBuf::from(format!("{}_collision", root.display()));
    assert!(!is_within_library(&collision));
}

#[test]
fn test_same_path_equivalence() {
    let path = Path::new(r"C:\QuiviT\Library");
    assert!(same_path(path, path));
    assert!(same_path(path, Path::new(r"C:\QuiviT\Library\")));
    assert!(same_path(path, Path::new("C:/QuiviT/Library")));
    assert!(same_path(path, Path::new("C:/QuiviT/Library/")));

    #[cfg(windows)]
    {
        assert!(same_path(path, Path::new(r"c:\quivit\library")));
        assert!(same_path(path, Path::new(r"C:\QUIVIT\LIBRARY\")));
    }

    assert!(!same_path(path, Path::new(r"C:\QuiviT\Library2")));
    assert!(!same_path(path, Path::new(r"C:\QuiviT")));
    assert!(!same_path(path, Path::new(r"D:\QuiviT\Library")));
}

#[test]
fn test_is_filesystem_root() {
    #[cfg(windows)]
    {
        assert!(is_filesystem_root(Path::new(r"C:\")));
        assert!(is_filesystem_root(Path::new("C:/")));
        assert!(is_filesystem_root(Path::new(r"D:\")));
        assert!(!is_filesystem_root(Path::new(r"C:\QuiviT")));
        assert!(!is_filesystem_root(Path::new(r"C:\QuiviT\Library")));
    }

    #[cfg(not(windows))]
    {
        assert!(is_filesystem_root(Path::new("/")));
        assert!(!is_filesystem_root(Path::new("/home")));
        assert!(!is_filesystem_root(Path::new("/home/user")));
    }
}

#[test]
fn test_ensure_library_write_allowed_active_and_retired() {
    let _lock = CONFIG_ENV_LOCK.lock().unwrap();
    let temp = TempTestDir::new("write_allowed");
    let active_dir = temp.path().join("active");
    let retired_dir = temp.path().join("retired");
    let unrelated_dir = temp.path().join("unrelated");
    fs::create_dir_all(&active_dir).unwrap();
    fs::create_dir_all(&retired_dir).unwrap();
    fs::create_dir_all(&unrelated_dir).unwrap();

    let config_dir = temp.path().join("config");
    fs::create_dir_all(&config_dir).unwrap();

    let config_json = serde_json::json!({
        "frontend_data": {
            LIBRARY_PATH_KEY: config::display_path(&active_dir),
            RETIRED_LIBRARY_PATHS_KEY: [
                config::display_path(&retired_dir),
                config::display_path(&active_dir)
            ]
        }
    });
    fs::write(config_dir.join("quivit_config.json"), config_json.to_string()).unwrap();

    let _env = ConfigEnvGuard::set(&config_dir);

    // Active root allowed even with prior entry in retired history
    let active_child = active_dir.join("image.png");
    assert!(ensure_library_write_allowed(&active_child).is_ok());

    // Active root locked by in-directory relocation lock
    let active_lock = active_dir.join(LIBRARY_MOVE_LOCK_FILE);
    fs::write(&active_lock, "lock").unwrap();
    let err = ensure_library_write_allowed(&active_child).unwrap_err();
    assert!(err.contains("Library relocation is in progress"));
    let _ = fs::remove_file(&active_lock);

    // Active root locked by config directory relocation lock
    let config_lock = config_dir.join(CONFIG_MOVE_LOCK_FILE);
    fs::write(&config_lock, "lock").unwrap();
    let err = ensure_library_write_allowed(&active_child).unwrap_err();
    assert!(err.contains("Library relocation is in progress"));
    let _ = fs::remove_file(&config_lock);

    // Retired root rejected
    let retired_child = retired_dir.join("stale.png");
    let err = ensure_library_write_allowed(&retired_child).unwrap_err();
    assert!(err.contains("retired by a live move"));

    // Unrelated path allowed
    let unrelated_child = unrelated_dir.join("file.png");
    assert!(ensure_library_write_allowed(&unrelated_child).is_ok());

    // Unrelated path under relocation lock ancestor rejected
    let locked_ancestor = temp.path().join("ancestor_lock");
    let locked_child_dir = locked_ancestor.join("sub");
    fs::create_dir_all(&locked_child_dir).unwrap();
    fs::write(locked_ancestor.join(LIBRARY_MOVE_LOCK_FILE), "lock").unwrap();
    let err = ensure_library_write_allowed(&locked_child_dir.join("file.png")).unwrap_err();
    assert!(err.contains("Library relocation is in progress"));
}

#[test]
fn test_remap_path_rewriting() {
    let source = Path::new(r"C:\QuiviT\OldLibrary");
    let dest = Path::new(r"D:\Media\NewLibrary");

    assert_eq!(
        remap_path(r"C:\QuiviT\OldLibrary", source, dest),
        Some(r"D:\Media\NewLibrary".to_string())
    );

    assert_eq!(
        remap_path(r"C:\QuiviT\OldLibrary\Comics\ch1", source, dest),
        Some(r"D:\Media\NewLibrary\Comics\ch1".to_string())
    );

    assert_eq!(
        remap_path(r"C:\QuiviT\OldLibrary\Sub\Nested\file.png", source, dest),
        Some(r"D:\Media\NewLibrary\Sub\Nested\file.png".to_string())
    );

    assert_eq!(
        remap_path("C:/QuiviT/OldLibrary/Comics/cover.jpg", source, dest),
        Some(r"D:\Media\NewLibrary\Comics\cover.jpg".to_string())
    );

    assert_eq!(remap_path(r"C:\Other\file.png", source, dest), None);
    assert_eq!(
        remap_path(r"C:\QuiviT\OldLibraryExtra\file.png", source, dest),
        None
    );
    assert_eq!(remap_path(r"C:\QuiviT", source, dest), None);
}

#[test]
fn test_remap_library_paths_config_migration() {
    let source = Path::new(r"C:\OldLib");
    let dest = Path::new(r"D:\NewLib");

    let mut config = AppConfig::default();
    config.frontend_data = serde_json::json!({
        "last_opened_path": r"C:\OldLib\Folder\album",
        "last_active_image": {
            "container": r"C:\OldLib\Folder",
            "path": r"C:\OldLib\Folder\01.jpg"
        },
        "favorites": {
            "loadouts": [
                {
                    "name": "Main",
                    "items": [
                        { "path": r"C:\OldLib\art.png" },
                        { "path": r"C:\OldLib\manga.cbz|ch1/01.png" },
                        { "path": r"E:\Unrelated\photo.jpg" },
                        { "path": r"E:\Unrelated\comic.zip|entry.jpg" }
                    ]
                }
            ]
        },
        "directory_sort": {
            r"C:\OldLib\Folder": "name_asc",
            r"C:\OldLib\Manga": "date_desc",
            r"E:\Unrelated\Folder": "size_asc"
        }
    });

    remap_library_paths(&mut config, source, dest);

    let data = config.frontend_data.as_object().unwrap();

    assert_eq!(
        data.get("last_opened_path").and_then(|v| v.as_str()),
        Some(r"D:\NewLib\Folder\album")
    );

    let last_active = data
        .get("last_active_image")
        .and_then(|v| v.as_object())
        .unwrap();
    assert_eq!(
        last_active.get("container").and_then(|v| v.as_str()),
        Some(r"D:\NewLib\Folder")
    );
    assert_eq!(
        last_active.get("path").and_then(|v| v.as_str()),
        Some(r"D:\NewLib\Folder\01.jpg")
    );

    let items = data["favorites"]["loadouts"][0]["items"]
        .as_array()
        .unwrap();
    assert_eq!(items[0]["path"], r"D:\NewLib\art.png");
    assert_eq!(items[1]["path"], r"D:\NewLib\manga.cbz|ch1/01.png");
    assert_eq!(items[2]["path"], r"E:\Unrelated\photo.jpg");
    assert_eq!(items[3]["path"], r"E:\Unrelated\comic.zip|entry.jpg");

    let sort = data
        .get("directory_sort")
        .and_then(|v| v.as_object())
        .unwrap();
    assert_eq!(
        sort.get(r"D:\NewLib\Folder").and_then(|v| v.as_str()),
        Some("name_asc")
    );
    assert_eq!(
        sort.get(r"D:\NewLib\Manga").and_then(|v| v.as_str()),
        Some("date_desc")
    );
    assert_eq!(
        sort.get(r"E:\Unrelated\Folder").and_then(|v| v.as_str()),
        Some("size_asc")
    );
    assert!(!sort.contains_key(r"C:\OldLib\Folder"));
    assert!(!sort.contains_key(r"C:\OldLib\Manga"));
}

#[test]
fn test_remap_library_paths_empty_or_external_config() {
    let source = Path::new(r"C:\OldLib");
    let dest = Path::new(r"D:\NewLib");

    let mut config = AppConfig::default();
    remap_library_paths(&mut config, source, dest);
    assert_eq!(config.frontend_data, serde_json::json!({}));

    let mut config = AppConfig::default();
    config.frontend_data = serde_json::json!({
        "last_opened_path": r"E:\External\Folder",
        "last_active_image": {
            "container": r"E:\External",
            "path": r"E:\External\pic.png"
        }
    });
    remap_library_paths(&mut config, source, dest);
    assert_eq!(
        config.frontend_data["last_opened_path"],
        r"E:\External\Folder"
    );
    assert_eq!(
        config.frontend_data["last_active_image"]["container"],
        r"E:\External"
    );
}

#[test]
fn test_ensure_empty_writable_destination() {
    let temp = TempTestDir::new("destination_check");
    let source = temp.path().join("source");
    let dest = temp.path().join("dest");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&dest).unwrap();

    assert!(ensure_empty_writable_destination(&source, &dest).is_ok());
    assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);

    let dummy_file = dest.join("probe.txt");
    fs::write(&dummy_file, "data").unwrap();
    let err = ensure_empty_writable_destination(&source, &dest).unwrap_err();
    assert!(err.contains("Choose an empty folder for the Library"));
    let _ = fs::remove_file(&dummy_file);

    let dummy_subdir = dest.join("subdir");
    fs::create_dir_all(&dummy_subdir).unwrap();
    let err = ensure_empty_writable_destination(&source, &dest).unwrap_err();
    assert!(err.contains("Choose an empty folder for the Library"));
    let _ = fs::remove_dir(&dummy_subdir);

    let dest_inside = source.join("nested_dest");
    fs::create_dir_all(&dest_inside).unwrap();
    let err = ensure_empty_writable_destination(&source, &dest_inside).unwrap_err();
    assert!(err.contains("cannot contain, be contained by, or equal"));

    let temp_nest = TempTestDir::new("nested_source");
    let dest_outer = temp_nest.path().join("outer");
    let source_inner = dest_outer.join("inner");
    fs::create_dir_all(&source_inner).unwrap();
    let err = ensure_empty_writable_destination(&source_inner, &dest_outer).unwrap_err();
    assert!(err.contains("cannot contain, be contained by, or equal"));

    let err = ensure_empty_writable_destination(&source, &source).unwrap_err();
    assert!(err.contains("cannot contain, be contained by, or equal"));

    let non_existent = temp.path().join("non_existent");
    let err = ensure_empty_writable_destination(&source, &non_existent).unwrap_err();
    assert!(err.contains("Choose an existing empty folder for the Library"));

    let err = ensure_empty_writable_destination(&source, Path::new("relative_path")).unwrap_err();
    assert!(err.contains("must be an absolute path"));

    #[cfg(windows)]
    {
        let err = ensure_empty_writable_destination(&source, Path::new(r"C:\")).unwrap_err();
        assert!(err.contains("cannot be a drive root"));
    }
}

#[test]
fn test_carry_live_library_state_preserves_runtime_state() {
    let mut target = AppConfig::default();
    target.frontend_data = serde_json::json!({
        "theme": "dark",
        "zoom": 150,
        "continue_last": true
    });

    let mut current = AppConfig::default();
    current.frontend_data = serde_json::json!({
        "theme": "light",
        "last_opened_path": r"C:\Photos",
        "last_active_image": {
            "container": r"C:\Photos",
            "path": r"C:\Photos\1.jpg"
        },
        "favorites": {
            "loadouts": [{ "name": "Favs", "items": [] }]
        },
        "favorites_collapsed": true,
        "directory_sort": {
            r"C:\Photos": "date_asc"
        }
    });

    carry_live_library_state(&mut target, &current);

    let data = target.frontend_data.as_object().unwrap();

    assert_eq!(data["theme"], "dark");
    assert_eq!(data["zoom"], 150);

    assert_eq!(data["last_opened_path"], r"C:\Photos");
    assert_eq!(data["last_active_image"]["path"], r"C:\Photos\1.jpg");
    assert_eq!(data["favorites"]["loadouts"][0]["name"], "Favs");
    assert_eq!(data["favorites_collapsed"], true);
    assert_eq!(data["directory_sort"][r"C:\Photos"], "date_asc");
}

#[test]
fn test_carry_live_library_state_drops_last_opened_when_continue_last_false() {
    let mut target = AppConfig::default();
    target.frontend_data = serde_json::json!({
        "continue_last": false,
        "last_opened_path": r"C:\OldStale"
    });

    let mut current = AppConfig::default();
    current.frontend_data = serde_json::json!({
        "last_opened_path": r"C:\LiveResume",
        "favorites_collapsed": false
    });

    carry_live_library_state(&mut target, &current);

    let data = target.frontend_data.as_object().unwrap();
    assert!(data.get("last_opened_path").is_none());
    assert_eq!(data["favorites_collapsed"], false);
}

#[test]
fn test_carry_live_library_state_clears_keys_absent_in_current() {
    let mut target = AppConfig::default();
    target.frontend_data = serde_json::json!({
        "last_opened_path": r"C:\Stale",
        "favorites_collapsed": true,
        "directory_sort": { "a": "b" }
    });

    let current = AppConfig::default();

    carry_live_library_state(&mut target, &current);

    let data = target.frontend_data.as_object().unwrap();
    assert!(data.get("last_opened_path").is_none());
    assert!(data.get("favorites_collapsed").is_none());
    assert!(data.get("directory_sort").is_none());
}

#[test]
fn test_retain_retired_library_path() {
    let mut config = AppConfig::default();
    let current = AppConfig::default();
    let source = Path::new(r"C:\OldLib");
    let dest = Path::new(r"D:\NewLib");

    retain_retired_library_path(&mut config, &current, source, dest);
    let retired = config.frontend_data[RETIRED_LIBRARY_PATHS_KEY]
        .as_array()
        .unwrap();
    assert_eq!(retired.len(), 1);
    assert_eq!(retired[0], config::display_path(source));

    // Deduplication check
    let mut current2 = AppConfig::default();
    current2.frontend_data = config.frontend_data.clone();
    retain_retired_library_path(&mut config, &current2, source, dest);
    let retired2 = config.frontend_data[RETIRED_LIBRARY_PATHS_KEY]
        .as_array()
        .unwrap();
    assert_eq!(retired2.len(), 1);

    // Prune destination if it was in retired list
    let mut current3 = AppConfig::default();
    current3.frontend_data = serde_json::json!({
        RETIRED_LIBRARY_PATHS_KEY: [
            config::display_path(dest),
            r"C:\Prior1",
            r"C:\Prior2"
        ]
    });
    retain_retired_library_path(&mut config, &current3, source, dest);
    let retired3 = config.frontend_data[RETIRED_LIBRARY_PATHS_KEY]
        .as_array()
        .unwrap();
    assert!(!retired3
        .iter()
        .any(|p| same_path(Path::new(p.as_str().unwrap()), dest)));
    assert!(retired3
        .iter()
        .any(|p| same_path(Path::new(p.as_str().unwrap()), source)));

    // Limit check: at most 16 entries
    let mut current_many = AppConfig::default();
    let many_paths: Vec<String> = (0..20).map(|i| format!(r"C:\RetiredPath{i}")).collect();
    current_many.frontend_data = serde_json::json!({
        RETIRED_LIBRARY_PATHS_KEY: many_paths
    });
    retain_retired_library_path(&mut config, &current_many, source, dest);
    let retired_many = config.frontend_data[RETIRED_LIBRARY_PATHS_KEY]
        .as_array()
        .unwrap();
    assert_eq!(retired_many.len(), RETIRED_LIBRARY_PATH_LIMIT);
}
