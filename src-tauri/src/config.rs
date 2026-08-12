use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

// ── Window Size Constants ────────────────────────────────────────────────────
// Initial/min sizes in logical pixels. Named for easy tweaking.

// Main window — built in lib.rs setup so all windows share one path.
pub const MAIN_INITIAL_W: f64 = 1280.0;
pub const MAIN_INITIAL_H: f64 = 720.0;
pub const MAIN_MIN_W: f64 = 640.0;
pub const MAIN_MIN_H: f64 = 400.0;

// Shared initial size for auto-fit windows: hidden until the JS fits + centers it,
// so these are only build placeholders, never displayed.
const AUTO_FIT_INITIAL_W: f64 = 560.0;
const AUTO_FIT_INITIAL_H: f64 = 600.0;

// Options window — width auto-fits to content (capped at OPTIONS_MAX_W), height fixed.
const OPTIONS_INITIAL_W: f64 = AUTO_FIT_INITIAL_W;
const OPTIONS_INITIAL_H: f64 = 620.0;
const OPTIONS_MIN_W: f64 = 400.0;
const OPTIONS_MIN_H: f64 = 360.0;
// Auto-fit clamp for the width; mirrored by OPTIONS_MAX_INITIAL_W in options.js.
#[allow(dead_code)] // Single source of truth for the cap; enforced in JS.
const OPTIONS_MAX_W: f64 = 560.0;

// Metadata window — 400 wide; height auto-fits to content (capped at META_MAX_H,
// a fit cap, not a hard size limit). Opens hidden, fitted + centered before show.
const META_INITIAL_W: f64 = 400.0;
const META_INITIAL_H: f64 = AUTO_FIT_INITIAL_H;
const META_MIN_W: f64 = 320.0;
const META_MIN_H: f64 = 280.0;
// Auto-fit clamp; mirrored by META_MAX_INITIAL_H in metadata-window.js.
#[allow(dead_code)] // Single source of truth for the cap; enforced in JS.
const META_MAX_H: f64 = 600.0;

// ── Configuration ────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct AppConfig {
    pub portable_mode: bool,
    pub hidden: bool,
    pub frontend_data: JsonValue,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            portable_mode: false,
            hidden: false,
            frontend_data: serde_json::json!({}),
        }
    }
}

pub fn get_exe_dir() -> PathBuf {
    std::env::current_exe()
        .unwrap_or_default()
        .parent()
        .unwrap_or(Path::new(""))
        .to_path_buf()
}

pub fn is_portable() -> bool {
    let exe_dir = get_exe_dir();
    exe_dir.join("quivit_config.json").exists()
}

pub fn roaming_dir_path(app_handle: &tauri::AppHandle) -> PathBuf {
    app_handle.path().app_config_dir().unwrap_or_default()
}

pub fn roaming_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    let path = roaming_dir_path(app_handle);
    fs::create_dir_all(&path).ok();
    path
}

pub const ROAMING_FILES: &[&str] = &[
    "quivit_config.json",
    "quivit_state.json",
    "quivit_directory_sort.json",
    "quivit_favorites.json",
    "custom_css.css",
];

pub fn remove_roaming_files(dir: &Path) {
    for name in ROAMING_FILES {
        let _ = fs::remove_file(dir.join(name));
    }
}

pub fn get_config_path() -> PathBuf {
    let exe_dir = get_exe_dir();
    let is_port = exe_dir.join(".portable").exists() || exe_dir.join("quivit_config.json").exists();
    
    if is_port {
        exe_dir.join("quivit_config.json")
    } else {
        if let Ok(appdata) = std::env::var("APPDATA") {
            Path::new(&appdata).join("com.x4163.quivit").join("quivit_config.json")
        } else {
            PathBuf::new()
        }
    }
}

pub fn load_config_early() -> AppConfig {
    let config_path = get_config_path();
    
    if let Ok(content) = fs::read_to_string(&config_path) {
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        AppConfig::default()
    }
}

// Startup-only settings are persisted as a "pending" value so they only take
// effect after a restart (matching the Options "Takes effect after restarting
// QuiviT." hint). Options writes `pending_single_instance`; the effective
// `single_instance` is never written by the UI. On the next launch, promote the
// pending value into `single_instance`, drop the pending key, and persist the
// file — before any startup logic (single-instance plugin gate) reads it.
pub fn apply_pending_to_config(config: &mut AppConfig) {
    if let Some(pending) = config.frontend_data.get("pending_single_instance").cloned() {
        if pending.is_boolean() {
            config.frontend_data["single_instance"] = pending;
        }
        if let Some(obj) = config.frontend_data.as_object_mut() {
            obj.remove("pending_single_instance");
        }
    }
}

pub fn apply_pending_config() -> AppConfig {
    let mut config = load_config_early();
    let had_pending = config.frontend_data.get("pending_single_instance").is_some();
    apply_pending_to_config(&mut config);
    if had_pending {
        if let Ok(data) = serde_json::to_string_pretty(&config) {
            let _ = fs::write(get_config_path(), data);
        }
    }
    config
}

// ── Config split helpers ──────────────────────────────────────────────────────
// Runtime state (last-opened location, remembered images), per-directory
// sort prefs, and favorites are persisted as their own files so the roaming
// config file only holds user preferences. Portable mode keeps a single
// self-contained file.

pub const STATE_KEYS: &[&str] = &["last_opened_path", "last_active_image", "scroll_zoom_latched"];
pub const SORT_KEYS: &[&str] = &["directory_sort"];
pub const FAVORITES_KEYS: &[&str] = &["favorites", "favorites_collapsed"];

pub fn extract_keys(src: &mut JsonValue, keys: &[&str]) -> JsonValue {
    let mut out = serde_json::Map::new();
    if let Some(obj) = src.as_object_mut() {
        for k in keys {
            if let Some(v) = obj.remove(*k) {
                out.insert(k.to_string(), v);
            }
        }
    }
    JsonValue::Object(out)
}

pub fn merge_keys(dst: &mut JsonValue, src: JsonValue) {
    if let (Some(d), Some(s)) = (dst.as_object_mut(), src.as_object()) {
        for (k, v) in s {
            d.insert(k.clone(), v.clone());
        }
    }
}

pub fn read_json_file<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

pub fn merge_file_into(path: &Path, frontend_data: &mut JsonValue) {
    if let Some(value) = read_json_file::<JsonValue>(path) {
        merge_keys(frontend_data, value);
    }
}

#[tauri::command]
pub fn load_config(app_handle: tauri::AppHandle) -> AppConfig {
    if is_portable() {
        return read_json_file(&get_exe_dir().join("quivit_config.json")).unwrap_or_default();
    }

    let dir = roaming_dir(&app_handle);
    let mut config: AppConfig = read_json_file(&dir.join("quivit_config.json")).unwrap_or_default();
    // New layout: state, directory-sort, and favorites live in their own files.
    // Legacy layout (everything in quivit_config.json) loads unchanged.
    merge_file_into(&dir.join("quivit_state.json"), &mut config.frontend_data);
    merge_file_into(&dir.join("quivit_directory_sort.json"), &mut config.frontend_data);
    merge_file_into(&dir.join("quivit_favorites.json"), &mut config.frontend_data);
    
    // Load custom CSS from separate file in roaming mode
    let css_path = dir.join("custom_css.css");
    if let Ok(custom_css) = fs::read_to_string(&css_path) {
        config.frontend_data["custom_css"] = serde_json::json!(custom_css);
    }
    
    config
}

// Static pointers shown in Options. The global config folder always points at
// the roaming location (%APPDATA%\com.x4163.quivit); the local folder always
// points beside the executable (the portable location). They do not track the
// "Save config data locally" state.

#[tauri::command]
pub fn get_config_dir(app_handle: tauri::AppHandle) -> String {
    roaming_dir(&app_handle).to_string_lossy().into_owned()
}

#[tauri::command]
pub fn open_config_dir(app_handle: tauri::AppHandle) -> Result<(), String> {
    let dir = roaming_dir(&app_handle);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config directory: {e}"))?;
    app_handle
        .opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| format!("Failed to open config directory: {e}"))
}

#[tauri::command]
pub fn get_local_data_dir() -> String {
    get_exe_dir().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn open_local_data_dir(app_handle: tauri::AppHandle) -> Result<(), String> {
    let dir = get_exe_dir();
    app_handle
        .opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| format!("Failed to open local data directory: {e}"))
}

#[tauri::command]
pub fn save_config(app_handle: tauri::AppHandle, mut config: AppConfig) -> Result<(), String> {
    let exe_dir = get_exe_dir();

    if config.portable_mode {
        // Portable: write the single self-contained file beside the executable
        // first, then drop the roaming copies so exactly one location stays active.
        let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        let config_path = exe_dir.join("quivit_config.json");
        fs::write(&config_path, data).map_err(|e| e.to_string())?;

        // Apply hidden attribute to the portable config file only
        crate::utils::set_hidden_attribute(&config_path, config.hidden)?;

        remove_roaming_files(&roaming_dir_path(&app_handle));
        
        // Remove roaming custom_css.css if it exists
        let _ = fs::remove_file(roaming_dir(&app_handle).join("custom_css.css"));
    } else {
        // Roaming: write the split files first, then remove portable leftovers so
        // a failed write never loses the config.
        let mut fd = std::mem::take(&mut config.frontend_data);
        let state = extract_keys(&mut fd, STATE_KEYS);
        let sort = extract_keys(&mut fd, SORT_KEYS);
        let favorites = extract_keys(&mut fd, FAVORITES_KEYS);
        
        // Extract custom_css and save it as a separate file
        let custom_css = fd.get("custom_css").and_then(|v| v.as_str()).unwrap_or("").to_string();
        fd.as_object_mut().map(|obj| obj.remove("custom_css"));
        
        config.frontend_data = fd;

        let dir = roaming_dir(&app_handle);
        let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        fs::write(dir.join("quivit_config.json"), data).map_err(|e| e.to_string())?;
        fs::write(
            dir.join("quivit_state.json"),
            serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::write(
            dir.join("quivit_directory_sort.json"),
            serde_json::to_string_pretty(&sort).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::write(
            dir.join("quivit_favorites.json"),
            serde_json::to_string_pretty(&favorites).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        
        // Write custom CSS as a separate file
        fs::write(dir.join("custom_css.css"), custom_css).map_err(|e| e.to_string())?;

        let _ = fs::remove_file(exe_dir.join("quivit_config.json"));
    }
    Ok(())
}

#[tauri::command]
pub async fn open_options(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("options") {
        // If the window already exists but is still hidden (mid auto-fit), don't
        // force-show it — the JS side reveals it via showOptionsWindow() once the
        // fit settles. Force-showing now would paint the pre-fit width and cause
        // a visible flicker, which spam-clicking would otherwise trigger.
        if window.is_visible().map_err(|e| format!("Failed to check options window: {e}"))? {
            window.set_focus().map_err(|e| format!("Failed to focus options window: {e}"))?;
        }
        return Ok(());
    }

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "options",
        tauri::WebviewUrl::App("options.html".into())
    )
    .title("Options")
    .inner_size(OPTIONS_INITIAL_W, OPTIONS_INITIAL_H)
    .min_inner_size(OPTIONS_MIN_W, OPTIONS_MIN_H)
    .resizable(true)
    .closable(true)
    .maximizable(false)
    // Hidden until JS fits the width to content (avoids a size flicker).
    // fit_options_window also re-centers it over the main window after the fit.
    .visible(false)
    .devtools(true)
    .center();

    builder
        .build()
        .map_err(|e| format!("Failed to open options window: {e}"))?;

    Ok(())
}

// Fit the options window to `width` logical px and center it over the main
// window. Height stays fixed at OPTIONS_INITIAL_H. Called by the frontend after
// measuring the rendered content so the window is exactly as wide as it needs.
#[tauri::command]
pub async fn fit_options_window(app: tauri::AppHandle, width: f64) -> Result<(), String> {
    let options = app.get_webview_window("options")
        .ok_or_else(|| "options window not found".to_string())?;

    options
        .set_size(tauri::LogicalSize::new(width, OPTIONS_INITIAL_H))
        .map_err(|e| format!("Failed to size options window: {e}"))?;

    let position: Option<tauri::PhysicalPosition<i32>> = (|| {
        let main = app.get_webview_window("main")?;
        let pos  = main.outer_position().ok()?;
        let size = main.outer_size().ok()?;
        let scale = main.scale_factor().ok()?;
        let x = pos.x + (size.width  as i32 - (width * scale) as i32) / 2;
        let y = pos.y + (size.height as i32 - (OPTIONS_INITIAL_H * scale) as i32) / 2;
        Some(tauri::PhysicalPosition::new(x, y))
    })();

    if let Some(pos) = position {
        options
            .set_position(pos)
            .map_err(|e| format!("Failed to position options window: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn open_metadata_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("metadata") {
        // If the window already exists but is still hidden (mid auto-fit), don't
        // force-show it — the JS side reveals it via showWindow() once the fit
        // settles. Force-showing now would paint the pre-fit height and cause a
        // visible flicker, which spam-clicking the badge would otherwise trigger.
        if window.is_visible().map_err(|e| format!("Failed to check metadata window: {e}"))? {
            window.set_focus().map_err(|e| format!("Failed to focus metadata window: {e}"))?;
        }
        return Ok(());
    }

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "metadata",
        tauri::WebviewUrl::App("metadata.html".into())
    )
    .title("Archive Info")
    .inner_size(META_INITIAL_W, META_INITIAL_H)
    .min_inner_size(META_MIN_W, META_MIN_H)
    .resizable(true)
    .closable(true)
    .maximizable(true)
    // Hidden until JS fits the height to content (avoids a size flicker).
    // fit_metadata_window also re-centers it after the fit.
    .visible(false)
    // Devtools enabled for all windows so users can inspect/debug Custom CSS.
    .devtools(true)
    .center();

    builder
        .build()
        .map_err(|e| format!("Failed to open metadata window: {e}"))?;

    Ok(())
}

// Fit the metadata window to `height` logical px and center it over the main
// window. Dynamic height keeps it exactly centered on the actual content.
#[tauri::command]
pub async fn fit_metadata_window(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    let metadata = app.get_webview_window("metadata")
        .ok_or_else(|| "metadata window not found".to_string())?;

    metadata
        .set_size(tauri::LogicalSize::new(META_INITIAL_W, height))
        .map_err(|e| format!("Failed to size metadata window: {e}"))?;

    let position: Option<tauri::PhysicalPosition<i32>> = (|| {
        let main = app.get_webview_window("main")?;
        let pos  = main.outer_position().ok()?;
        let size = main.outer_size().ok()?;
        let scale = main.scale_factor().ok()?;
        let x = pos.x + (size.width  as i32 - (META_INITIAL_W * scale) as i32) / 2;
        let y = pos.y + (size.height as i32 - (height * scale) as i32) / 2;
        Some(tauri::PhysicalPosition::new(x, y))
    })();

    if let Some(pos) = position {
        metadata
            .set_position(pos)
            .map_err(|e| format!("Failed to position metadata window: {e}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
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
}
