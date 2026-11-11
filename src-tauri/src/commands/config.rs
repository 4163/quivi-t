use std::fs;
use tauri_plugin_opener::OpenerExt;

use crate::config::{
    self, get_config_path, get_exe_dir, is_portable, override_config_dir, override_single_file,
    roaming_dir, same_library_location, save_config_unchecked, AppConfig,
};
use crate::models::ActiveConfigInfo;

#[tauri::command]
pub fn load_config(app_handle: tauri::AppHandle) -> AppConfig {
    config::load_config(app_handle)
}

#[tauri::command]
pub fn get_config_dir(app_handle: tauri::AppHandle) -> String {
    roaming_dir(&app_handle).to_string_lossy().into_owned()
}

#[tauri::command]
pub fn open_active_config_dir(app_handle: tauri::AppHandle) -> Result<(), String> {
    let dir = if let Some(dir) = override_config_dir() {
        dir
    } else if is_portable() {
        get_exe_dir()
    } else {
        roaming_dir(&app_handle)
    };
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config directory: {e}"))?;
    app_handle
        .opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| format!("Failed to open config directory: {e}"))
}

#[tauri::command]
pub fn get_active_config_info() -> ActiveConfigInfo {
    if let Some(dir) = override_config_dir() {
        let layout = if override_single_file() {
            "single file"
        } else {
            "split files"
        };
        return ActiveConfigInfo {
            dir: dir.to_string_lossy().into_owned(),
            mode: format!("override ({layout})"),
        };
    }
    let mode = if is_portable() { "portable" } else { "roaming" };
    let dir = get_config_path()
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    ActiveConfigInfo {
        dir,
        mode: mode.to_string(),
    }
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
pub fn save_config(app_handle: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    if crate::commands::library::library_move_in_progress()? {
        return Err(
            "Library relocation is in progress. Try saving settings again when it finishes.".into(),
        );
    }

    let current = config::load_config(app_handle.clone());
    if !same_library_location(&current, &config)? {
        return Err(
            "Use the Library location control to move the Library. Settings saves cannot change its path.".into(),
        );
    }

    crate::commands::watchers::record_config_self_write(&app_handle);
    save_config_unchecked(app_handle, config)
}
