use super::*;
use std::sync::Mutex;

static ACTIVE_THEME_LOCK: Mutex<()> = Mutex::new(());

struct ActiveThemeGuard(u8);

impl ActiveThemeGuard {
    fn capture() -> Self {
        Self(ACTIVE_THEME.load(Ordering::Relaxed))
    }
}

impl Drop for ActiveThemeGuard {
    fn drop(&mut self) {
        ACTIVE_THEME.store(self.0, Ordering::Relaxed);
    }
}

#[test]
fn test_encode_tauri_theme() {
    assert_eq!(encode_tauri_theme(None), 0);
    assert_eq!(encode_tauri_theme(Some(tauri::Theme::Light)), 1);
    assert_eq!(encode_tauri_theme(Some(tauri::Theme::Dark)), 2);
}

#[test]
fn test_active_tauri_theme_roundtrip() {
    let _lock = ACTIVE_THEME_LOCK.lock().unwrap();
    let _guard = ActiveThemeGuard::capture();

    for theme in [None, Some(tauri::Theme::Light), Some(tauri::Theme::Dark)] {
        ACTIVE_THEME.store(encode_tauri_theme(theme), Ordering::Relaxed);
        assert_eq!(active_tauri_theme(), theme);
    }
}

#[test]
fn test_workspace_window_mapping() {
    assert_eq!(workspace_window("fileList"), Ok("workspace-file-list"));
    assert!(workspace_window("").is_err());
    assert!(workspace_window("main").is_err());
    assert!(workspace_window("options").is_err());
    assert!(workspace_window("unknown").is_err());
}

#[test]
fn test_is_workspace_window() {
    assert!(is_workspace_window("main"));
    assert!(is_workspace_window("workspace-file-list"));
    assert!(!is_workspace_window("options"));
    assert!(!is_workspace_window("metadata"));
    assert!(!is_workspace_window(""));
}

#[test]
fn test_window_size_and_secondary_constants() {
    assert_eq!(OPTIONS_MIN_W, 400.0);
    assert_eq!(OPTIONS_MAX_W, 560.0);
    assert_eq!(META_MIN_H, 280.0);
    assert_eq!(META_MAX_H, 600.0);
    assert_eq!(OPTIONS_INITIAL_W, 560.0);
    assert_eq!(META_INITIAL_H, 600.0);
    assert_eq!(
        SECONDARY_WINDOWS,
        ["options", "metadata", "workspace-file-list"]
    );
}
