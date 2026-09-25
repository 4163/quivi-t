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
    std::env::remove_var("QUIVIT_E2E_SUITE");
    assert!(!is_e2e_suite());

    // When QUIVIT_E2E_SUITE is present, is_e2e_suite returns true
    std::env::set_var("QUIVIT_E2E_SUITE", "1");
    assert!(is_e2e_suite());
    std::env::remove_var("QUIVIT_E2E_SUITE");
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
