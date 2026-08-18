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
        let mut config: AppConfig = serde_json::from_str(r#"{
            "frontend_data": { "single_instance": true, "pending_single_instance": false }
        }"#).unwrap();
        apply_pending_to_config(&mut config);
        assert_eq!(config.frontend_data["single_instance"], false);
        assert!(config.frontend_data.get("pending_single_instance").is_none());
    }

    #[test]
    fn test_apply_pending_config_enable_promotion() {
        // Enable staged: pending true promotes over the effective false.
        let mut config: AppConfig = serde_json::from_str(r#"{
            "frontend_data": { "single_instance": false, "pending_single_instance": true }
        }"#).unwrap();
        apply_pending_to_config(&mut config);
        assert_eq!(config.frontend_data["single_instance"], true);
        assert!(config.frontend_data.get("pending_single_instance").is_none());
    }

    #[test]
    fn test_apply_pending_config_noop_without_pending() {
        let mut config: AppConfig = serde_json::from_str(r#"{
            "frontend_data": { "single_instance": true }
        }"#).unwrap();
        apply_pending_to_config(&mut config);
        assert_eq!(config.frontend_data["single_instance"], true);
    }

    #[test]
    fn test_apply_pending_config_non_bool_dropped() {
        // Non-boolean pending is invalid: dropped without promoting.
        let mut config: AppConfig = serde_json::from_str(r#"{
            "frontend_data": { "single_instance": true, "pending_single_instance": "yes" }
        }"#).unwrap();
        apply_pending_to_config(&mut config);
        assert_eq!(config.frontend_data["single_instance"], true);
        assert!(config.frontend_data.get("pending_single_instance").is_none());
    }
