use super::*;

#[test]
fn test_appconfig_resiliency() {
    // Test missing portable_mode
    let json_str = r#"{
            "frontend_data": {
                "theme": "dark"
            }
        }"#;
    let config: AppConfig = serde_json::from_str(json_str).unwrap();
    assert_eq!(config.portable_mode, false);
    assert_eq!(config.frontend_data["theme"], "dark");

    // Test missing frontend_data
    let json_str = r#"{
            "portable_mode": true
        }"#;
    let config: AppConfig = serde_json::from_str(json_str).unwrap();
    assert_eq!(config.portable_mode, true);
    assert!(config.frontend_data.is_object());
}

#[test]
fn test_apply_pending_config_disable_promotion() {
    // Disable staged: pending false promotes over the effective true.
    let mut config: AppConfig = serde_json::from_str(
        r#"{
            "frontend_data": { "single_instance": true, "pending_single_instance": false }
        }"#,
    )
    .unwrap();
    apply_pending_to_config(&mut config);
    assert_eq!(config.frontend_data["single_instance"], false);
    assert!(config
        .frontend_data
        .get("pending_single_instance")
        .is_none());
}

#[test]
fn test_apply_pending_config_enable_promotion() {
    // Enable staged: pending true promotes over the effective false.
    let mut config: AppConfig = serde_json::from_str(
        r#"{
            "frontend_data": { "single_instance": false, "pending_single_instance": true }
        }"#,
    )
    .unwrap();
    apply_pending_to_config(&mut config);
    assert_eq!(config.frontend_data["single_instance"], true);
    assert!(config
        .frontend_data
        .get("pending_single_instance")
        .is_none());
}

#[test]
fn test_apply_pending_config_noop_without_pending() {
    let mut config: AppConfig = serde_json::from_str(
        r#"{
            "frontend_data": { "single_instance": true }
        }"#,
    )
    .unwrap();
    apply_pending_to_config(&mut config);
    assert_eq!(config.frontend_data["single_instance"], true);
}

#[test]
fn test_should_cleanup_old_location_only_on_migration() {
    // Normal saves in either mode must leave the other location alone.
    // E2E and diagnose runs save portable configs routinely; every-save
    // deletion wiped real roaming user data.
    assert!(!should_cleanup_old_location(false, false));
    assert!(!should_cleanup_old_location(true, true));
    // Real mode switches still migrate stale files away.
    assert!(should_cleanup_old_location(false, true));
    assert!(should_cleanup_old_location(true, false));
}

#[test]
fn test_is_portable_dir_marker_and_content() {
    let base = std::env::temp_dir().join(format!("quivit_cfg_test_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);

    // Empty dir: roaming.
    let empty = base.join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    assert!(!is_portable_dir(&empty));

    // `.portable` marker always wins, even with no config file.
    let marked = base.join("marked");
    std::fs::create_dir_all(&marked).unwrap();
    std::fs::write(marked.join(".portable"), "").unwrap();
    assert!(is_portable_dir(&marked));

    // Exe-dir config opting into portable mode stays portable.
    let opted_in = base.join("opted_in");
    std::fs::create_dir_all(&opted_in).unwrap();
    std::fs::write(
        opted_in.join("quivit_config.json"),
        r#"{"portable_mode": true, "frontend_data": {}}"#,
    )
    .unwrap();
    assert!(is_portable_dir(&opted_in));

    // Stray file with portable_mode false must not hijack roaming.
    let stray = base.join("stray");
    std::fs::create_dir_all(&stray).unwrap();
    std::fs::write(
        stray.join("quivit_config.json"),
        r#"{"portable_mode": false, "frontend_data": {}}"#,
    )
    .unwrap();
    assert!(!is_portable_dir(&stray));

    // Corrupt exe-dir file: stay portable rather than silently switching
    // locations and letting the next save rewrite the other side.
    let corrupt = base.join("corrupt");
    std::fs::create_dir_all(&corrupt).unwrap();
    std::fs::write(corrupt.join("quivit_config.json"), "{not json").unwrap();
    assert!(is_portable_dir(&corrupt));

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn test_apply_pending_config_non_bool_dropped() {
    // Non-boolean pending is invalid: dropped without promoting.
    let mut config: AppConfig = serde_json::from_str(
        r#"{
            "frontend_data": { "single_instance": true, "pending_single_instance": "yes" }
        }"#,
    )
    .unwrap();
    apply_pending_to_config(&mut config);
    assert_eq!(config.frontend_data["single_instance"], true);
    assert!(config
        .frontend_data
        .get("pending_single_instance")
        .is_none());
}

#[test]
fn test_e2e_suite_non_persistence_and_detection() {
    let mut config: AppConfig = serde_json::from_str(
        r#"{
            "frontend_data": { "e2e_suite": true, "theme": "dark" }
        }"#,
    )
    .unwrap();

    // Verify e2e_suite gets removed on save preparation
    if let Some(obj) = config.frontend_data.as_object_mut() {
        obj.remove("e2e_suite");
    }
    assert!(config.frontend_data.get("e2e_suite").is_none());
    assert_eq!(config.frontend_data["theme"], "dark");

    // Without environment or CLI flags, is_e2e_suite is false
    let _lock = OVERRIDE_ENV_LOCK.lock().unwrap();
    let _guard = OverrideEnvGuard::set(&[("QUIVIT_E2E_SUITE", None)]);
    assert!(!is_e2e_suite());

    // When QUIVIT_E2E_SUITE is present, is_e2e_suite returns true
    std::env::set_var("QUIVIT_E2E_SUITE", "1");
    assert!(is_e2e_suite());
}

fn temp_override_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "quivit_override_{name}_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

// Process env is shared across test threads. These tests hold one lock while
// they mutate the override vars, and every guard restores on drop.
static OVERRIDE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

struct OverrideEnvGuard {
    prev: Vec<(String, Option<String>)>,
}

impl OverrideEnvGuard {
    fn set(vars: &[(&str, Option<&str>)]) -> Self {
        let prev = vars
            .iter()
            .map(|(k, _)| ((*k).to_string(), std::env::var(k).ok()))
            .collect();
        for (k, v) in vars {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
        Self { prev }
    }
}

impl Drop for OverrideEnvGuard {
    fn drop(&mut self) {
        for (k, v) in &self.prev {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
    }
}

#[test]
fn test_override_dir_wins_over_marker() {
    let _lock = OVERRIDE_ENV_LOCK.lock().unwrap();
    let home = temp_override_dir("home");
    let other = temp_override_dir("other");
    std::fs::write(other.join(".portable"), "").unwrap();
    let _guard = OverrideEnvGuard::set(&[
        ("QUIVIT_CONFIG_DIR", Some(home.to_str().unwrap())),
        ("QUIVIT_PORTABLE", None),
    ]);
    assert_eq!(override_config_dir(), Some(home.clone()));
    assert_eq!(get_config_path(), home.join("quivit_config.json"));
    let _ = std::fs::remove_dir_all(&home);
    let _ = std::fs::remove_dir_all(&other);
}

#[test]
fn test_override_dir_rejects_relative_and_empty() {
    let _lock = OVERRIDE_ENV_LOCK.lock().unwrap();
    let _guard = OverrideEnvGuard::set(&[("QUIVIT_CONFIG_DIR", Some("relative/path"))]);
    assert_eq!(override_config_dir(), None);
    drop(_guard);
    let _guard = OverrideEnvGuard::set(&[("QUIVIT_CONFIG_DIR", Some("   "))]);
    assert_eq!(override_config_dir(), None);
}

#[test]
fn test_override_split_roundtrip() {
    let dir = temp_override_dir("split");
    let mut config = AppConfig::default();
    config.frontend_data = serde_json::json!({
        "theme": "dark",
        "favorites": {"active": "Favorites 1", "loadouts": [{"name": "Favorites 1", "items": [{"path": "C:\\pics\\a.jpg", "name": "a.jpg"}]}]},
        "favorites_collapsed": false,
        "last_opened_path": "C:\\pics",
    });
    write_split_config(&dir, &mut config).unwrap();
    let main: serde_json::Value =
        read_json_file(&dir.join("quivit_config.json")).unwrap();
    assert_eq!(main["frontend_data"]["theme"], "dark");
    assert!(main["frontend_data"].get("favorites").is_none());
    let loaded = load_from_dir(&dir, false);
    assert_eq!(
        loaded.frontend_data["favorites"]["loadouts"][0]["items"][0]["path"],
        "C:\\pics\\a.jpg"
    );
    assert_eq!(loaded.frontend_data["last_opened_path"], "C:\\pics");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_override_single_file_layout() {
    let _lock = OVERRIDE_ENV_LOCK.lock().unwrap();
    let dir = temp_override_dir("single");
    std::fs::write(dir.join("quivit_favorites.json"), r#"{"favorites":{}}"#).unwrap();
    let mut config = AppConfig::default();
    config.frontend_data =
        serde_json::json!({"theme": "dark", "favorites": {"loadouts": [{"items": [{"path": "C:\\pics\\a.jpg"}]}]}});
    let _guard = OverrideEnvGuard::set(&[("QUIVIT_PORTABLE", Some("1"))]);
    save_override(&dir, config).unwrap();
    assert!(!dir.join("quivit_favorites.json").exists());
    let main: serde_json::Value =
        read_json_file(&dir.join("quivit_config.json")).unwrap();
    assert_eq!(
        main["frontend_data"]["favorites"]["loadouts"][0]["items"][0]["path"],
        "C:\\pics\\a.jpg"
    );
    let loaded = load_from_dir(&dir, true);
    assert_eq!(
        loaded.frontend_data["favorites"]["loadouts"][0]["items"][0]["path"],
        "C:\\pics\\a.jpg"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_describe_config_source_names_override() {
    let _lock = OVERRIDE_ENV_LOCK.lock().unwrap();
    let dir = temp_override_dir("describe");
    let _guard = OverrideEnvGuard::set(&[
        ("QUIVIT_CONFIG_DIR", Some(dir.to_str().unwrap())),
        ("QUIVIT_PORTABLE", None),
    ]);
    let text = describe_config_source();
    assert!(text.starts_with("override "));
    assert!(text.contains("split files"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_override_in_file_flag_honored() {
    let _lock = OVERRIDE_ENV_LOCK.lock().unwrap();
    let dir = temp_override_dir("flag");
    std::fs::write(
        dir.join("quivit_config.json"),
        r#"{"portable_mode": true, "frontend_data": {"theme": "dark"}}"#,
    )
    .unwrap();
    std::fs::write(
        dir.join("quivit_favorites.json"),
        r#"{"favorites": {"loadouts": [{"items": [{"path": "STALE"}]}]}}"#,
    )
    .unwrap();
    let _guard = OverrideEnvGuard::set(&[("QUIVIT_PORTABLE", None)]);
    let loaded = load_from_dir(&dir, false);
    assert!(loaded.frontend_data.get("favorites").is_none());
    assert_eq!(loaded.frontend_data["theme"], "dark");
    let _ = std::fs::remove_dir_all(&dir);
}

struct TempDirGuard(PathBuf);

impl TempDirGuard {
    fn new(name: &str) -> Self {
        Self(temp_override_dir(name))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn config_with_library_path(path: &str) -> AppConfig {
    let mut config = AppConfig::default();
    config.frontend_data = serde_json::json!({ LIBRARY_PATH_KEY: path });
    config
}

#[test]
fn test_display_path_normalization_and_verbatim_strip() {
    assert_eq!(
        display_path(Path::new(r"C:\Users\demo\Library")),
        r"C:\Users\demo\Library"
    );
    assert_eq!(
        display_path(Path::new("C:/Users/demo/Library")),
        r"C:\Users\demo\Library"
    );

    #[cfg(windows)]
    {
        assert_eq!(
            display_path(Path::new(r"\\?\C:\Users\demo\Library")),
            r"C:\Users\demo\Library"
        );
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\server\share\dir")),
            r"\\server\share\dir"
        );
    }
}

#[test]
fn test_same_library_location() {
    let normal = config_with_library_path(r"C:\Users\demo\Library");
    let other = config_with_library_path(r"C:\Users\demo\Other");
    assert_eq!(same_library_location(&normal, &other), Ok(false));

    let slashed = config_with_library_path("C:/Users/demo/Library");
    assert_eq!(same_library_location(&normal, &slashed), Ok(true));

    #[cfg(windows)]
    {
        let different_case = config_with_library_path(r"c:\users\demo\library");
        assert_eq!(same_library_location(&normal, &different_case), Ok(true));

        let verbatim = config_with_library_path(r"\\?\C:\Users\demo\Library");
        assert_eq!(same_library_location(&normal, &verbatim), Ok(true));
    }

    let relative = config_with_library_path("relative/library");
    assert!(same_library_location(&relative, &normal).is_err());
    assert!(same_library_location(&normal, &relative).is_err());
}

#[test]
fn test_normalize_library_location_paths() {
    let mut config = AppConfig::default();
    config.frontend_data = serde_json::json!({
        "library_path": r"\\?\C:/Users/demo/Library",
        "last_opened_path": r"\\?\C:/Users/demo/Library/Comics",
        "last_active_image": {
            "container": r"\\?\C:/Users/demo/Library/Comics/vol1.zip",
            "path": r"\\?\C:/Users/demo/Library/Comics/cover.png"
        },
        "favorites": {
            "loadouts": [
                {
                    "name": "Default",
                    "items": [
                        { "path": r"\\?\C:/Users/demo/Library/img.png" },
                        { "path": r"\\?\C:/Users/demo/Library/archive.zip|page/01.png" }
                    ]
                }
            ]
        },
        "directory_sort": {
            r"\\?\C:/Users/demo/Library/Comics": "name_asc"
        },
        "retired_library_paths": [
            r"\\?\C:/Old/Library",
            r"\\?\UNC\server\share\old_lib"
        ]
    });

    normalize_library_location_paths(&mut config);

    #[cfg(windows)]
    let prefix = "";
    #[cfg(not(windows))]
    let prefix = r"\\?\";

    assert_eq!(
        config.frontend_data["library_path"],
        format!(r"{prefix}C:\Users\demo\Library")
    );
    assert_eq!(
        config.frontend_data["last_opened_path"],
        format!(r"{prefix}C:\Users\demo\Library\Comics")
    );
    assert_eq!(
        config.frontend_data["last_active_image"]["container"],
        format!(r"{prefix}C:\Users\demo\Library\Comics\vol1.zip")
    );
    assert_eq!(
        config.frontend_data["last_active_image"]["path"],
        format!(r"{prefix}C:\Users\demo\Library\Comics\cover.png")
    );

    let items = config.frontend_data["favorites"]["loadouts"][0]["items"]
        .as_array()
        .unwrap();
    assert_eq!(items[0]["path"], format!(r"{prefix}C:\Users\demo\Library\img.png"));
    assert_eq!(
        items[1]["path"],
        format!(r"{prefix}C:\Users\demo\Library\archive.zip|page/01.png")
    );

    let sort_map = config.frontend_data["directory_sort"].as_object().unwrap();
    assert!(sort_map.get(r"\\?\C:/Users/demo/Library/Comics").is_none());
    assert_eq!(
        sort_map.get(&format!(r"{prefix}C:\Users\demo\Library\Comics")),
        Some(&serde_json::json!("name_asc"))
    );

    let retired = config.frontend_data["retired_library_paths"]
        .as_array()
        .unwrap();
    assert_eq!(retired[0], format!(r"{prefix}C:\Old\Library"));
    #[cfg(windows)]
    assert_eq!(retired[1], r"\\server\share\old_lib");
}

#[test]
fn test_remove_roaming_files_and_nonexistent_dir() {
    let dir = TempDirGuard::new("remove_roaming");
    for name in ROAMING_FILES {
        std::fs::write(dir.path().join(name), "data").unwrap();
    }
    assert!(dir.path().join("custom_css.css").exists());

    remove_roaming_files(dir.path());
    for name in ROAMING_FILES {
        assert!(!dir.path().join(name).exists(), "{name} should be removed");
    }

    let missing_dir = dir.path().join("does_not_exist");
    assert!(!missing_dir.exists());
    remove_roaming_files(&missing_dir);
    assert!(!missing_dir.exists());
}

#[test]
fn test_apply_pending_config_to_disk() {
    let _lock = OVERRIDE_ENV_LOCK.lock().unwrap();
    let dir = TempDirGuard::new("apply_pending");
    let config_path = dir.path().join("quivit_config.json");
    std::fs::write(
        &config_path,
        r#"{
            "portable_mode": false,
            "frontend_data": {
                "single_instance": true,
                "pending_single_instance": false
            }
        }"#,
    )
    .unwrap();

    let _guard = OverrideEnvGuard::set(&[
        ("QUIVIT_CONFIG_DIR", Some(dir.path().to_str().unwrap())),
        ("QUIVIT_PORTABLE", None),
    ]);

    apply_pending_config_to_disk();

    let persisted: AppConfig = read_json_file(&config_path).unwrap();
    assert_eq!(persisted.frontend_data["single_instance"], false);
    assert!(persisted
        .frontend_data
        .get("pending_single_instance")
        .is_none());
}

#[test]
fn test_roaming_to_portable_migration_does_not_recreate_missing_roaming_dir() {
    let base = TempDirGuard::new("portable_migrate");

    // Case 1: existing roaming files are all removed on migration.
    let exe_dir = base.path().join("exe_existing");
    let roaming_dir = base.path().join("roaming_existing");
    std::fs::create_dir_all(&exe_dir).unwrap();
    std::fs::create_dir_all(&roaming_dir).unwrap();
    for name in ROAMING_FILES {
        std::fs::write(roaming_dir.join(name), "stale").unwrap();
    }

    let mut portable_cfg = AppConfig::default();
    portable_cfg.portable_mode = true;
    portable_cfg.frontend_data = serde_json::json!({ "theme": "dark" });

    save_config_unchecked_with_paths(&exe_dir, &roaming_dir, portable_cfg.clone()).unwrap();
    assert!(exe_dir.join("quivit_config.json").is_file());
    for name in ROAMING_FILES {
        assert!(
            !roaming_dir.join(name).exists(),
            "{name} should be removed during roaming-to-portable migration"
        );
    }

    // Case 2: missing roaming directory must stay absent.
    let exe_dir_missing = base.path().join("exe_missing");
    let missing_roaming = base.path().join("roaming_never_created");
    std::fs::create_dir_all(&exe_dir_missing).unwrap();
    assert!(!missing_roaming.exists());

    save_config_unchecked_with_paths(&exe_dir_missing, &missing_roaming, portable_cfg).unwrap();
    assert!(exe_dir_missing.join("quivit_config.json").is_file());
    assert!(!missing_roaming.exists());
}

#[test]
fn test_load_startup_config_promotes_pending_in_one_pass() {
    let _lock = OVERRIDE_ENV_LOCK.lock().unwrap();
    let dir = TempDirGuard::new("startup_promote");
    let config_path = dir.path().join("quivit_config.json");
    std::fs::write(
        &config_path,
        r#"{
            "portable_mode": false,
            "frontend_data": {
                "single_instance": true,
                "pending_single_instance": false,
                "library_path": "C:\\StartupLib"
            }
        }"#,
    )
    .unwrap();

    let _guard = OverrideEnvGuard::set(&[
        ("QUIVIT_CONFIG_DIR", Some(dir.path().to_str().unwrap())),
        ("QUIVIT_PORTABLE", None),
    ]);

    let startup = load_startup_config();
    assert_eq!(startup.config_path, config_path);
    assert!(startup.source_description.starts_with("override "));
    assert_eq!(startup.config.frontend_data["single_instance"], false);
    assert!(startup
        .config
        .frontend_data
        .get("pending_single_instance")
        .is_none());

    let persisted: AppConfig = read_json_file(&config_path).unwrap();
    assert_eq!(persisted.frontend_data["single_instance"], false);
    assert!(persisted
        .frontend_data
        .get("pending_single_instance")
        .is_none());
    assert_eq!(
        configured_library_dir().unwrap(),
        PathBuf::from(r"C:\StartupLib")
    );
}

#[test]
fn test_library_config_cache_hits_and_invalidates() {
    let _lock = OVERRIDE_ENV_LOCK.lock().unwrap();
    let dir = TempDirGuard::new("library_cache");
    let config_path = dir.path().join("quivit_config.json");
    std::fs::write(
        &config_path,
        r#"{
            "frontend_data": {
                "library_path": "C:\\LibA",
                "retired_library_paths": ["C:\\OldA"]
            }
        }"#,
    )
    .unwrap();

    let _guard = OverrideEnvGuard::set(&[
        ("QUIVIT_CONFIG_DIR", Some(dir.path().to_str().unwrap())),
        ("QUIVIT_PORTABLE", None),
    ]);
    invalidate_library_cache();

    assert_eq!(configured_library_dir().unwrap(), PathBuf::from(r"C:\LibA"));
    assert_eq!(retired_library_paths(), vec![PathBuf::from(r"C:\OldA")]);

    // Modify disk out-of-band: repeat reads must serve the cached values.
    std::fs::write(
        &config_path,
        r#"{
            "frontend_data": {
                "library_path": "C:\\LibB",
                "retired_library_paths": ["C:\\OldB"]
            }
        }"#,
    )
    .unwrap();

    assert_eq!(configured_library_dir().unwrap(), PathBuf::from(r"C:\LibA"));
    assert_eq!(retired_library_paths(), vec![PathBuf::from(r"C:\OldA")]);

    // Explicit invalidation refreshes immediately.
    invalidate_library_cache();
    assert_eq!(configured_library_dir().unwrap(), PathBuf::from(r"C:\LibB"));
    assert_eq!(retired_library_paths(), vec![PathBuf::from(r"C:\OldB")]);

    // Saving through save_config_unchecked invalidates the cache too.
    let mut updated = AppConfig::default();
    updated.frontend_data = serde_json::json!({
        "library_path": r"C:\LibC",
        "retired_library_paths": [r"C:\OldC"]
    });
    save_config_unchecked(dir.path(), updated).unwrap();
    assert_eq!(configured_library_dir().unwrap(), PathBuf::from(r"C:\LibC"));
    assert_eq!(retired_library_paths(), vec![PathBuf::from(r"C:\OldC")]);
}

#[test]
fn test_descriptor_consistency_between_describe_and_active_info() {
    let _lock = OVERRIDE_ENV_LOCK.lock().unwrap();
    let dir = TempDirGuard::new("descriptor_consistency");

    // Override split layout
    {
        let _guard = OverrideEnvGuard::set(&[
            ("QUIVIT_CONFIG_DIR", Some(dir.path().to_str().unwrap())),
            ("QUIVIT_PORTABLE", None),
        ]);
        let desc = describe_config_source();
        let info = active_config_info();
        assert_eq!(desc, format!("override {} (split files)", dir.path().display()));
        assert_eq!(info.dir, dir.path().to_string_lossy());
        assert_eq!(info.mode, "override (split files)");
    }

    // Override single-file layout
    {
        let _guard = OverrideEnvGuard::set(&[
            ("QUIVIT_CONFIG_DIR", Some(dir.path().to_str().unwrap())),
            ("QUIVIT_PORTABLE", Some("1")),
        ]);
        let desc = describe_config_source();
        let info = active_config_info();
        assert_eq!(desc, format!("override {} (single file)", dir.path().display()));
        assert_eq!(info.dir, dir.path().to_string_lossy());
        assert_eq!(info.mode, "override (single file)");
    }
}
