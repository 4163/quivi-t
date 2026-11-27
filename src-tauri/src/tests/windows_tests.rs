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
    assert_eq!(FILE_LIST_MIN_W, 320.0);
    assert_eq!(
        SECONDARY_WINDOWS,
        ["options", "metadata", "workspace-file-list"]
    );
}

#[test]
fn test_clamp_options_width() {
    assert_eq!(clamp_options_width(400.0), 400.0);
    assert_eq!(clamp_options_width(480.0), 480.0);
    assert_eq!(clamp_options_width(560.0), 560.0);
    assert_eq!(clamp_options_width(200.0), 400.0);
    assert_eq!(clamp_options_width(800.0), 560.0);
    assert_eq!(clamp_options_width(f64::NAN), 400.0);
    assert_eq!(clamp_options_width(f64::INFINITY), 400.0);
    assert_eq!(clamp_options_width(f64::NEG_INFINITY), 400.0);
}

#[test]
fn test_clamp_metadata_height() {
    assert_eq!(clamp_metadata_height(280.0), 280.0);
    assert_eq!(clamp_metadata_height(450.0), 450.0);
    assert_eq!(clamp_metadata_height(600.0), 600.0);
    assert_eq!(clamp_metadata_height(100.0), 280.0);
    assert_eq!(clamp_metadata_height(900.0), 600.0);
    assert_eq!(clamp_metadata_height(f64::NAN), 280.0);
    assert_eq!(clamp_metadata_height(f64::INFINITY), 280.0);
    assert_eq!(clamp_metadata_height(f64::NEG_INFINITY), 280.0);
}

#[test]
fn test_shell_background_color() {
    assert_eq!(shell_background_color(true), Color(37, 37, 38, 255));
    assert_eq!(shell_background_color(false), Color(255, 255, 255, 255));
}

#[test]
fn test_centered_position_in_work_area() {
    let area = Some((
        tauri::PhysicalPosition::new(40, 30),
        tauri::PhysicalSize::new(1920, 1080),
    ));

    // Centered normally inside monitor work area.
    let centered = centered_position_in_work_area(
        tauri::PhysicalPosition::new(200, 100),
        tauri::PhysicalSize::new(1000, 800),
        (400, 600),
        area,
    );
    assert_eq!(centered, tauri::PhysicalPosition::new(500, 200));

    // Clamped to left/top work-area bounds.
    let clamped_tl = centered_position_in_work_area(
        tauri::PhysicalPosition::new(-200, -100),
        tauri::PhysicalSize::new(400, 300),
        (400, 300),
        area,
    );
    assert_eq!(clamped_tl, tauri::PhysicalPosition::new(40, 30));

    // Clamped to right/bottom work-area bounds.
    let clamped_br = centered_position_in_work_area(
        tauri::PhysicalPosition::new(1800, 950),
        tauri::PhysicalSize::new(600, 400),
        (400, 300),
        area,
    );
    assert_eq!(clamped_br, tauri::PhysicalPosition::new(1560, 810));

    // Target larger than monitor clamps safely to work-area origin.
    let oversized = centered_position_in_work_area(
        tauri::PhysicalPosition::new(300, 200),
        tauri::PhysicalSize::new(800, 600),
        (2400, 1400),
        area,
    );
    assert_eq!(oversized, tauri::PhysicalPosition::new(40, 30));
}

#[test]
fn test_tray_hidden_tracker() {
    let tracker = TrayHiddenTracker::new();

    // Only visible secondary windows are tracked; mid-init hidden or unknown labels are skipped.
    tracker.mark_if_visible("options", true);
    tracker.mark_if_visible("metadata", false);
    tracker.mark_if_visible("workspace-file-list", true);
    tracker.mark_if_visible("main", true);
    tracker.mark_if_visible("unknown", true);

    // Clearing an individual label drops only that window.
    tracker.clear("options");
    assert_eq!(tracker.take_labels(), vec!["workspace-file-list"]);

    // Restore drains the tracked set.
    assert!(tracker.take_labels().is_empty());

    // Tracks multiple visible windows in SECONDARY_WINDOWS order and drains cleanly.
    tracker.mark_if_visible("metadata", true);
    tracker.mark_if_visible("options", true);
    assert_eq!(tracker.take_labels(), vec!["options", "metadata"]);
    assert!(tracker.take_labels().is_empty());
}
