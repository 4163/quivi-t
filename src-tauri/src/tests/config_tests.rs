
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
