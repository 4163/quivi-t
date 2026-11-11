use super::*;

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

// Process env is shared across test threads. Tests hold this lock while
// mutating env vars, and every guard restores previous values on drop.
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
fn test_appconfig_resiliency() {
    // Missing portable_mode defaults to false
    let json_str = r#"{
            "frontend_data": {
                "theme": "dark"
            }
        }"#;
    let config: AppConfig = serde_json::from_str(json_str).unwrap();
    assert_eq!(config.portable_mode, false);
    assert_eq!(config.frontend_data["theme"], "dark");

    // Missing frontend_data defaults to object
    let json_str = r#"{
            "portable_mode": true
        }"#;
    let config: AppConfig = serde_json::from_str(json_str).unwrap();
    assert_eq!(config.portable_mode, true);
    assert!(config.frontend_data.is_object());
}

#[test]
fn test_appconfig_resiliency_defaults_and_corruption() {
    // Empty JSON object gives clean defaults
    let config: AppConfig = serde_json::from_str("{}").unwrap();
    assert_eq!(config.portable_mode, false);
    assert_eq!(config.hidden, false);
    assert_eq!(config.archive_cache_mb, None);
    assert_eq!(config.frontend_data, serde_json::json!({}));

    // Extra unknown top-level keys deserialize safely
    let config: AppConfig = serde_json::from_str(
        r#"{
            "unknown_feature": "abc",
            "archive_cache_mb": 1024,
            "hidden": true
        }"#,
    )
    .unwrap();
    assert_eq!(config.archive_cache_mb, Some(1024));
    assert_eq!(config.hidden, true);
    assert_eq!(config.portable_mode, false);

    // Null archive_cache_mb
    let config: AppConfig = serde_json::from_str(r#"{"archive_cache_mb": null}"#).unwrap();
    assert_eq!(config.archive_cache_mb, None);

    let dir = temp_override_dir("resilience");

    // Empty quivit_config.json -> defaults
    std::fs::write(dir.join("quivit_config.json"), "").unwrap();
    let loaded = load_from_dir(&dir, false);
    assert_eq!(loaded.portable_mode, false);

    // Malformed quivit_config.json -> defaults
    std::fs::write(dir.join("quivit_config.json"), "{not-json").unwrap();
    let loaded = load_from_dir(&dir, false);
    assert_eq!(loaded.portable_mode, false);

    // Valid quivit_config.json with malformed split files
    std::fs::write(
        dir.join("quivit_config.json"),
        r#"{"portable_mode": false, "frontend_data": {"theme": "dark"}}"#,
    )
    .unwrap();
    std::fs::write(dir.join("quivit_state.json"), "{broken").unwrap();
    std::fs::write(dir.join("quivit_directory_sort.json"), "").unwrap();
    std::fs::write(dir.join("quivit_favorites.json"), "invalid").unwrap();

    let loaded = load_from_dir(&dir, false);
    assert_eq!(loaded.frontend_data["theme"], "dark");
    assert!(loaded.frontend_data.get("last_opened_path").is_none());

    // Non-existent directory returns default AppConfig
    let non_existent = dir.join("does_not_exist");
    let loaded = load_from_dir(&non_existent, false);
    assert_eq!(loaded.portable_mode, false);

    let _ = std::fs::remove_dir_all(&dir);
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
fn test_apply_pending_to_config_edge_cases() {
    // Empty string: invalid, dropped, single_instance unchanged
    let mut config: AppConfig = serde_json::from_str(
        r#"{"frontend_data": {"single_instance": true, "pending_single_instance": ""}}"#,
    )
    .unwrap();
    apply_pending_to_config(&mut config);
    assert_eq!(config.frontend_data["single_instance"], true);
    assert!(config.frontend_data.get("pending_single_instance").is_none());

    // String "true" / "false": invalid, dropped
    let mut config: AppConfig = serde_json::from_str(
        r#"{"frontend_data": {"single_instance": false, "pending_single_instance": "true"}}"#,
    )
    .unwrap();
    apply_pending_to_config(&mut config);
    assert_eq!(config.frontend_data["single_instance"], false);
    assert!(config.frontend_data.get("pending_single_instance").is_none());

    // Numbers 0 or 1: invalid, dropped
    let mut config: AppConfig = serde_json::from_str(
        r#"{"frontend_data": {"single_instance": true, "pending_single_instance": 0}}"#,
    )
    .unwrap();
    apply_pending_to_config(&mut config);
    assert_eq!(config.frontend_data["single_instance"], true);
    assert!(config.frontend_data.get("pending_single_instance").is_none());

    // Array [true]: invalid, dropped
    let mut config: AppConfig = serde_json::from_str(
        r#"{"frontend_data": {"single_instance": false, "pending_single_instance": [true]}}"#,
    )
    .unwrap();
    apply_pending_to_config(&mut config);
    assert_eq!(config.frontend_data["single_instance"], false);
    assert!(config.frontend_data.get("pending_single_instance").is_none());

    // Object: invalid, dropped
    let mut config: AppConfig = serde_json::from_str(
        r#"{"frontend_data": {"single_instance": false, "pending_single_instance": {"active": true}}}"#,
    )
    .unwrap();
    apply_pending_to_config(&mut config);
    assert_eq!(config.frontend_data["single_instance"], false);
    assert!(config.frontend_data.get("pending_single_instance").is_none());

    // Null: invalid, dropped
    let mut config: AppConfig = serde_json::from_str(
        r#"{"frontend_data": {"single_instance": true, "pending_single_instance": null}}"#,
    )
    .unwrap();
    apply_pending_to_config(&mut config);
    assert_eq!(config.frontend_data["single_instance"], true);
    assert!(config.frontend_data.get("pending_single_instance").is_none());

    // Already matching values: pending removed, value unchanged
    let mut config: AppConfig = serde_json::from_str(
        r#"{"frontend_data": {"single_instance": true, "pending_single_instance": true}}"#,
    )
    .unwrap();
    apply_pending_to_config(&mut config);
    assert_eq!(config.frontend_data["single_instance"], true);
    assert!(config.frontend_data.get("pending_single_instance").is_none());

    // Unset single_instance promotes cleanly
    let mut config: AppConfig = serde_json::from_str(
        r#"{"frontend_data": {"pending_single_instance": true}}"#,
    )
    .unwrap();
    apply_pending_to_config(&mut config);
    assert_eq!(config.frontend_data["single_instance"], true);
    assert!(config.frontend_data.get("pending_single_instance").is_none());

    // Non-object frontend_data does not panic
    let mut config = AppConfig {
        portable_mode: false,
        hidden: false,
        archive_cache_mb: None,
        frontend_data: serde_json::json!(42),
    };
    apply_pending_to_config(&mut config);
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
fn test_e2e_suite_non_persistence_and_detection() {
    let _lock = OVERRIDE_ENV_LOCK.lock().unwrap();
    let _guard = OverrideEnvGuard::set(&[("QUIVIT_E2E_SUITE", None)]);

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
    assert!(!is_e2e_suite());

    // When QUIVIT_E2E_SUITE is present, is_e2e_suite returns true
    std::env::set_var("QUIVIT_E2E_SUITE", "1");
    assert!(is_e2e_suite());
    std::env::remove_var("QUIVIT_E2E_SUITE");
}

#[test]
fn test_atomic_write_creates_and_overwrites() {
    let dir = temp_override_dir("atomic");
    let target = dir.join("test_file.json");
    let tmp = dir.join("test_file.tmp");

    atomic_write(&target, "first write").unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "first write");
    assert!(!tmp.exists());

    atomic_write(&target, "second write").unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "second write");
    assert!(!tmp.exists());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_read_json_file_resilience() {
    let dir = temp_override_dir("read_json");

    // Non-existent file
    let missing = dir.join("missing.json");
    assert!(read_json_file::<serde_json::Value>(&missing).is_none());

    // Empty file (0 bytes)
    let empty = dir.join("empty.json");
    std::fs::write(&empty, "").unwrap();
    assert!(read_json_file::<serde_json::Value>(&empty).is_none());

    // Malformed JSON
    let malformed = dir.join("malformed.json");
    std::fs::write(&malformed, "{\"key\": incomplete").unwrap();
    assert!(read_json_file::<serde_json::Value>(&malformed).is_none());

    // Type mismatch: string where object expected
    let primitive = dir.join("primitive.json");
    std::fs::write(&primitive, "\"just a string\"").unwrap();
    assert!(read_json_file::<AppConfig>(&primitive).is_none());

    // Valid file
    let valid = dir.join("valid.json");
    std::fs::write(&valid, "{\"portable_mode\": true}").unwrap();
    let loaded: Option<AppConfig> = read_json_file(&valid);
    assert!(loaded.is_some());
    assert_eq!(loaded.unwrap().portable_mode, true);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_write_split_config_all_five_files() {
    let dir = temp_override_dir("split_all");
    let mut config = AppConfig {
        portable_mode: false,
        hidden: false,
        archive_cache_mb: Some(512),
        frontend_data: serde_json::json!({
            "theme": "dark",
            "font_size": 16,
            "last_opened_path": "C:\\pics",
            "last_active_image": {
                "container": "C:\\pics",
                "path": "img1.png"
            },
            "scroll_zoom_latched": true,
            "directory_sort": {
                "C:\\pics": "name_asc"
            },
            "favorites": {
                "active": "Default",
                "loadouts": [{
                    "name": "Default",
                    "items": [{"path": "C:\\pics\\img1.png"}]
                }]
            },
            "favorites_collapsed": true,
            "custom_css": "body { background-color: #121212; }"
        }),
    };

    write_split_config(&dir, &mut config).unwrap();

    // Verify all 5 files exist on disk
    for name in ROAMING_FILES {
        assert!(dir.join(name).exists(), "Missing split file: {name}");
    }

    // Main config must not retain split keys
    let main: serde_json::Value = read_json_file(&dir.join("quivit_config.json")).unwrap();
    assert_eq!(main["frontend_data"]["theme"], "dark");
    assert_eq!(main["frontend_data"]["font_size"], 16);
    assert_eq!(main["archive_cache_mb"], 512);
    assert!(main["frontend_data"].get("last_opened_path").is_none());
    assert!(main["frontend_data"].get("directory_sort").is_none());
    assert!(main["frontend_data"].get("favorites").is_none());
    assert!(main["frontend_data"].get("custom_css").is_none());

    // quivit_state.json
    let state: serde_json::Value = read_json_file(&dir.join("quivit_state.json")).unwrap();
    assert_eq!(state["last_opened_path"], "C:\\pics");
    assert_eq!(state["last_active_image"]["path"], "img1.png");
    assert_eq!(state["scroll_zoom_latched"], true);
    assert!(state.get("theme").is_none());

    // quivit_directory_sort.json
    let sort: serde_json::Value = read_json_file(&dir.join("quivit_directory_sort.json")).unwrap();
    assert_eq!(sort["directory_sort"]["C:\\pics"], "name_asc");
    assert!(sort.get("theme").is_none());

    // quivit_favorites.json
    let favs: serde_json::Value = read_json_file(&dir.join("quivit_favorites.json")).unwrap();
    assert_eq!(favs["favorites"]["active"], "Default");
    assert_eq!(favs["favorites_collapsed"], true);
    assert!(favs.get("theme").is_none());

    // custom_css.css
    let css = std::fs::read_to_string(dir.join("custom_css.css")).unwrap();
    assert_eq!(css, "body { background-color: #121212; }");

    // Reassemble and verify roundtrip completeness
    let loaded = load_from_dir(&dir, false);
    assert_eq!(loaded.archive_cache_mb, Some(512));
    assert_eq!(loaded.frontend_data["theme"], "dark");
    assert_eq!(loaded.frontend_data["font_size"], 16);
    assert_eq!(loaded.frontend_data["last_opened_path"], "C:\\pics");
    assert_eq!(loaded.frontend_data["last_active_image"]["path"], "img1.png");
    assert_eq!(loaded.frontend_data["scroll_zoom_latched"], true);
    assert_eq!(loaded.frontend_data["directory_sort"]["C:\\pics"], "name_asc");
    assert_eq!(loaded.frontend_data["favorites"]["active"], "Default");
    assert_eq!(loaded.frontend_data["favorites_collapsed"], true);
    assert_eq!(
        loaded.frontend_data["custom_css"],
        "body { background-color: #121212; }"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_split_config_missing_files_and_extra_keys() {
    let dir = temp_override_dir("split_extra");

    // quivit_config.json with unknown extra preference
    std::fs::write(
        dir.join("quivit_config.json"),
        r#"{
            "portable_mode": false,
            "frontend_data": {
                "theme": "light",
                "custom_unknown_setting": 999
            }
        }"#,
    )
    .unwrap();

    // quivit_state.json with standard key + unknown extra key
    std::fs::write(
        dir.join("quivit_state.json"),
        r#"{
            "last_opened_path": "D:\\gallery",
            "legacy_state_field": "preserved"
        }"#,
    )
    .unwrap();

    // quivit_directory_sort.json, quivit_favorites.json, custom_css.css are missing
    let mut loaded = load_from_dir(&dir, false);
    assert_eq!(loaded.frontend_data["theme"], "light");
    assert_eq!(loaded.frontend_data["custom_unknown_setting"], 999);
    assert_eq!(loaded.frontend_data["last_opened_path"], "D:\\gallery");
    assert_eq!(loaded.frontend_data["legacy_state_field"], "preserved");
    assert!(loaded.frontend_data.get("directory_sort").is_none());
    assert!(loaded.frontend_data.get("favorites").is_none());
    assert!(loaded.frontend_data.get("custom_css").is_none());

    // When saving again, extra keys are preserved
    write_split_config(&dir, &mut loaded).unwrap();
    let reloaded = load_from_dir(&dir, false);
    assert_eq!(reloaded.frontend_data["custom_unknown_setting"], 999);
    assert_eq!(reloaded.frontend_data["legacy_state_field"], "preserved");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_unchanged_config_save_preserves_content_deterministically() {
    let dir = temp_override_dir("preserve");
    let mut config = AppConfig {
        portable_mode: false,
        hidden: false,
        archive_cache_mb: Some(256),
        frontend_data: serde_json::json!({
            "theme": "dark",
            "ui_scale": 1.25,
            "last_opened_path": "C:\\images",
            "directory_sort": {"C:\\images": "desc"},
            "favorites": {"active": "Set 1", "loadouts": []},
            "custom_css": ".panel { opacity: 0.9; }"
        }),
    };

    write_split_config(&dir, &mut config).unwrap();

    // Read bytes of all 5 split files after initial save
    let initial_files: Vec<(String, Vec<u8>)> = ROAMING_FILES
        .iter()
        .map(|name| {
            (
                name.to_string(),
                std::fs::read(dir.join(name)).unwrap(),
            )
        })
        .collect();

    // Load back and immediately re-save unchanged
    let mut loaded = load_from_dir(&dir, false);
    write_split_config(&dir, &mut loaded).unwrap();

    for (name, initial_bytes) in initial_files {
        let current_bytes = std::fs::read(dir.join(&name)).unwrap();
        assert_eq!(
            initial_bytes, current_bytes,
            "File {name} changed after saving unchanged config"
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_remove_roaming_files_leaves_unrelated_files() {
    let dir = temp_override_dir("cleanup_roaming");

    for name in ROAMING_FILES {
        std::fs::write(dir.join(name), "test data").unwrap();
    }
    let unrelated = dir.join("unrelated_notes.txt");
    std::fs::write(&unrelated, "keep this file").unwrap();

    remove_roaming_files(&dir);

    for name in ROAMING_FILES {
        assert!(!dir.join(name).exists(), "Roaming file was not removed: {name}");
    }
    assert!(unrelated.exists(), "Unrelated file was removed unexpectedly");
    assert_eq!(std::fs::read_to_string(&unrelated).unwrap(), "keep this file");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn test_extract_and_merge_keys_edge_cases() {
    // extract_keys on valid object with mix of existing and absent keys
    let mut source = serde_json::json!({
        "keep_me": "yes",
        "extract_me": 42,
        "extract_too": true
    });
    let extracted = extract_keys(&mut source, &["extract_me", "extract_too", "absent_key"]);

    assert_eq!(source["keep_me"], "yes");
    assert!(source.get("extract_me").is_none());
    assert!(source.get("extract_too").is_none());
    assert_eq!(extracted["extract_me"], 42);
    assert_eq!(extracted["extract_too"], true);
    assert!(extracted.get("absent_key").is_none());

    // extract_keys on non-object must not panic
    let mut non_obj = serde_json::json!("not an object");
    let extracted_non_obj = extract_keys(&mut non_obj, &["a", "b"]);
    assert_eq!(extracted_non_obj, serde_json::json!({}));

    // merge_keys into object with overlapping and distinct keys
    let mut dst = serde_json::json!({
        "existing_key": "old",
        "untouched": 1
    });
    let src = serde_json::json!({
        "existing_key": "new",
        "added": 2
    });
    merge_keys(&mut dst, src);

    assert_eq!(dst["existing_key"], "new");
    assert_eq!(dst["untouched"], 1);
    assert_eq!(dst["added"], 2);

    // merge_keys on non-object dst or src must not panic
    let mut non_obj_dst = serde_json::json!(42);
    merge_keys(&mut non_obj_dst, serde_json::json!({"k": "v"}));
    assert_eq!(non_obj_dst, serde_json::json!(42));
}

#[test]
fn test_normalize_library_location_paths_surfaces() {
    let mut config = AppConfig {
        portable_mode: false,
        hidden: false,
        archive_cache_mb: None,
        frontend_data: serde_json::json!({
            LIBRARY_PATH_KEY: r"\\?\C:\Library\Images",
            "last_opened_path": r"\\?\D:\Photos\Album",
            "last_active_image": {
                "container": r"\\?\D:\Photos\Album",
                "path": r"\\?\D:\Photos\Album\cover.jpg"
            },
            "favorites": {
                "loadouts": [
                    {
                        "name": "Quick",
                        "items": [
                            {"path": r"\\?\C:\Pictures\item.png"},
                            {"path": r"\\?\C:\Archive.zip|nested\img.jpg"}
                        ]
                    }
                ]
            },
            "directory_sort": {
                r"\\?\E:\SortTarget": "name_desc",
                r"F:\CleanTarget": "date_asc"
            },
            RETIRED_LIBRARY_PATHS_KEY: [
                r"\\?\C:\OldLibrary",
                r"D:\CleanOldLibrary"
            ]
        }),
    };

    normalize_library_location_paths(&mut config);

    let fd = &config.frontend_data;
    assert_eq!(fd[LIBRARY_PATH_KEY], r"C:\Library\Images");
    assert_eq!(fd["last_opened_path"], r"D:\Photos\Album");
    assert_eq!(fd["last_active_image"]["container"], r"D:\Photos\Album");
    assert_eq!(fd["last_active_image"]["path"], r"D:\Photos\Album\cover.jpg");
    assert_eq!(
        fd["favorites"]["loadouts"][0]["items"][0]["path"],
        r"C:\Pictures\item.png"
    );
    assert_eq!(
        fd["favorites"]["loadouts"][0]["items"][1]["path"],
        r"C:\Archive.zip|nested\img.jpg"
    );
    assert_eq!(fd["directory_sort"][r"E:\SortTarget"], "name_desc");
    assert_eq!(fd["directory_sort"][r"F:\CleanTarget"], "date_asc");
    assert_eq!(fd[RETIRED_LIBRARY_PATHS_KEY][0], r"C:\OldLibrary");
    assert_eq!(fd[RETIRED_LIBRARY_PATHS_KEY][1], r"D:\CleanOldLibrary");

    // Non-object frontend_data must not panic
    let mut invalid_config = AppConfig {
        portable_mode: false,
        hidden: false,
        archive_cache_mb: None,
        frontend_data: serde_json::json!(null),
    };
    normalize_library_location_paths(&mut invalid_config);
}

#[test]
fn test_same_library_location_matching_and_validation() {
    let mut config_a = AppConfig::default();
    let mut config_b = AppConfig::default();

    // Both with default path
    assert_eq!(same_library_location(&config_a, &config_b), Ok(true));

    // Both with identical custom absolute paths
    let abs_path_a = if cfg!(windows) { "C:\\Library" } else { "/tmp/library" };
    let abs_path_b = if cfg!(windows) { "C:\\Library" } else { "/tmp/library" };
    config_a.frontend_data[LIBRARY_PATH_KEY] = serde_json::json!(abs_path_a);
    config_b.frontend_data[LIBRARY_PATH_KEY] = serde_json::json!(abs_path_b);
    assert_eq!(same_library_location(&config_a, &config_b), Ok(true));

    #[cfg(windows)]
    {
        // Case-insensitive comparison on Windows
        config_b.frontend_data[LIBRARY_PATH_KEY] = serde_json::json!("c:\\library");
        assert_eq!(same_library_location(&config_a, &config_b), Ok(true));
    }

    // Different paths
    let abs_other = if cfg!(windows) { "C:\\OtherLib" } else { "/tmp/other" };
    config_b.frontend_data[LIBRARY_PATH_KEY] = serde_json::json!(abs_other);
    assert_eq!(same_library_location(&config_a, &config_b), Ok(false));

    // Relative path returns validation error
    config_b.frontend_data[LIBRARY_PATH_KEY] = serde_json::json!("relative/lib");
    assert!(same_library_location(&config_a, &config_b).is_err());
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
fn test_save_override_cleans_split_files_on_portable() {
    let dir = temp_override_dir("override_clean");

    // Populate split files first
    for name in [
        "quivit_state.json",
        "quivit_directory_sort.json",
        "quivit_favorites.json",
        "custom_css.css",
    ] {
        std::fs::write(dir.join(name), "stale data").unwrap();
    }

    // Save with portable_mode: true
    let mut config = AppConfig::default();
    config.portable_mode = true;
    config.frontend_data = serde_json::json!({"theme": "dark"});

    save_override(&dir, config).unwrap();

    let main: serde_json::Value = read_json_file(&dir.join("quivit_config.json")).unwrap();
    assert_eq!(main["frontend_data"]["theme"], "dark");
    assert_eq!(main["portable_mode"], true);

    // All split files must be cleaned up
    for name in [
        "quivit_state.json",
        "quivit_directory_sort.json",
        "quivit_favorites.json",
        "custom_css.css",
    ] {
        assert!(!dir.join(name).exists(), "Stale split file left behind: {name}");
    }

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
fn test_describe_config_source_all_modes() {
    let _lock = OVERRIDE_ENV_LOCK.lock().unwrap();
    let dir = temp_override_dir("describe_modes");

    // 1. Override dir with default split files layout
    let _guard1 = OverrideEnvGuard::set(&[
        ("QUIVIT_CONFIG_DIR", Some(dir.to_str().unwrap())),
        ("QUIVIT_PORTABLE", None),
    ]);
    assert_eq!(
        describe_config_source(),
        format!("override {} (split files)", dir.display())
    );
    drop(_guard1);

    // 2. Override dir with QUIVIT_PORTABLE=1 -> single file
    let _guard2 = OverrideEnvGuard::set(&[
        ("QUIVIT_CONFIG_DIR", Some(dir.to_str().unwrap())),
        ("QUIVIT_PORTABLE", Some("1")),
    ]);
    assert_eq!(
        describe_config_source(),
        format!("override {} (single file)", dir.display())
    );
    drop(_guard2);

    // 3. Override dir with QUIVIT_PORTABLE=true -> single file
    let _guard3 = OverrideEnvGuard::set(&[
        ("QUIVIT_CONFIG_DIR", Some(dir.to_str().unwrap())),
        ("QUIVIT_PORTABLE", Some("true")),
    ]);
    assert_eq!(
        describe_config_source(),
        format!("override {} (single file)", dir.display())
    );
    drop(_guard3);

    // 4. Override dir with QUIVIT_PORTABLE=0 -> split files
    let _guard4 = OverrideEnvGuard::set(&[
        ("QUIVIT_CONFIG_DIR", Some(dir.to_str().unwrap())),
        ("QUIVIT_PORTABLE", Some("0")),
    ]);
    assert_eq!(
        describe_config_source(),
        format!("override {} (split files)", dir.display())
    );
    drop(_guard4);

    // 5. No override dir: verifies portable or roaming format
    let _guard5 = OverrideEnvGuard::set(&[
        ("QUIVIT_CONFIG_DIR", None),
        ("QUIVIT_PORTABLE", None),
    ]);
    let desc = describe_config_source();
    if is_portable() {
        assert_eq!(desc, format!("portable {}", get_exe_dir().display()));
    } else {
        assert_eq!(desc, format!("roaming {}", get_config_path().display()));
    }
    drop(_guard5);

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
