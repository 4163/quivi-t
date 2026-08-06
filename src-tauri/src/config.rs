use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

// ── Configuration ────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct AppConfig {
    pub portable_mode: bool,
    pub frontend_data: JsonValue,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            portable_mode: false,
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
    exe_dir.join(".portable").exists() || exe_dir.join("quivit_config.json").exists()
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
        fs::write(exe_dir.join("quivit_config.json"), data).map_err(|e| e.to_string())?;
        let _ = fs::write(exe_dir.join(".portable"), "");

        remove_roaming_files(&roaming_dir_path(&app_handle));
    } else {
        // Roaming: write the split files first, then remove portable leftovers so
        // a failed write never loses the config.
        let mut fd = std::mem::take(&mut config.frontend_data);
        let state = extract_keys(&mut fd, STATE_KEYS);
        let sort = extract_keys(&mut fd, SORT_KEYS);
        let favorites = extract_keys(&mut fd, FAVORITES_KEYS);
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

        let _ = fs::remove_file(exe_dir.join(".portable"));
        let _ = fs::remove_file(exe_dir.join("quivit_config.json"));
    }
    Ok(())
}

#[tauri::command]
pub async fn open_options(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("options") {
        window.show().map_err(|e| format!("Failed to show options window: {e}"))?;
        window.set_focus().map_err(|e| format!("Failed to focus options window: {e}"))?;
        return Ok(());
    }

    const OPT_W: f64 = 560.0;
    const OPT_H: f64 = 620.0;

    // Try to position centered over the main window; fall back to screen center.
    let position: Option<tauri::PhysicalPosition<i32>> = (|| {
        let main = app.get_webview_window("main")?;
        let pos  = main.outer_position().ok()?;
        let size = main.outer_size().ok()?;
        let scale = main.scale_factor().ok()?;
        let x = pos.x + (size.width  as i32 - (OPT_W * scale) as i32) / 2;
        let y = pos.y + (size.height as i32 - (OPT_H * scale) as i32) / 2;
        Some(tauri::PhysicalPosition::new(x, y))
    })();

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "options",
        tauri::WebviewUrl::App("options.html".into())
    )
    .title("Options")
    .inner_size(OPT_W, OPT_H)
    .min_inner_size(460.0, 420.0)
    .resizable(true)
    .closable(true)
    .maximizable(false)
    .visible(true)
    .devtools(cfg!(debug_assertions));

    let window = if let Some(pos) = position {
        builder.position(pos.x as f64, pos.y as f64)
    } else {
        builder.center()
    }
    .build()
    .map_err(|e| format!("Failed to open options window: {e}"))?;

    window.show().map_err(|e| format!("Failed to show options window: {e}"))?;
    window.set_focus().map_err(|e| format!("Failed to focus options window: {e}"))
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
}
