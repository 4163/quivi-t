use crate::config::{self, AppConfig};
use crate::models::ActiveConfigInfo;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

pub fn roaming_dir_path(app_handle: &tauri::AppHandle) -> PathBuf {
    app_handle.path().app_config_dir().unwrap_or_default()
}

pub fn roaming_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    let path = roaming_dir_path(app_handle);
    fs::create_dir_all(&path).ok();
    path
}

#[tauri::command(async)]
pub async fn load_config(app_handle: tauri::AppHandle) -> AppConfig {
    let roaming_path = roaming_dir_path(&app_handle);
    tauri::async_runtime::spawn_blocking(move || config::load_config(&roaming_path))
        .await
        .unwrap_or_default()
}

// `get_config_dir` and `get_local_data_dir` return the fixed roaming and exe-dir
// locations. Options uses `get_active_config_info` and `open_active_config_dir`
// for the active override, portable, or roaming folder.

#[tauri::command(async)]
pub async fn get_config_dir(app_handle: tauri::AppHandle) -> String {
    tauri::async_runtime::spawn_blocking(move || {
        roaming_dir(&app_handle).to_string_lossy().into_owned()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command(async)]
pub async fn open_active_config_dir(app_handle: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = if let Some(dir) = config::override_config_dir() {
            dir
        } else if config::is_portable() {
            config::get_exe_dir()
        } else {
            roaming_dir(&app_handle)
        };
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config directory: {e}"))?;
        app_handle
            .opener()
            .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|e| format!("Failed to open config directory: {e}"))
    })
    .await
    .map_err(|e| format!("Failed to open config directory: {e}"))?
}

/// Folder and layout this run actually uses. Options renders it as the
/// primary row; the secondary row names the inactive fixed spot.
#[tauri::command]
pub fn get_active_config_info() -> ActiveConfigInfo {
    config::active_config_info()
}

#[tauri::command(async)]
pub async fn open_config_dir(app_handle: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = roaming_dir(&app_handle);
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config directory: {e}"))?;
        app_handle
            .opener()
            .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|e| format!("Failed to open config directory: {e}"))
    })
    .await
    .map_err(|e| format!("Failed to open config directory: {e}"))?
}

#[tauri::command]
pub fn get_local_data_dir() -> String {
    config::get_exe_dir().to_string_lossy().into_owned()
}

#[tauri::command(async)]
pub async fn open_local_data_dir(app_handle: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = config::get_exe_dir();
        app_handle
            .opener()
            .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|e| format!("Failed to open local data directory: {e}"))
    })
    .await
    .map_err(|e| format!("Failed to open local data directory: {e}"))?
}

#[tauri::command(async)]
pub async fn save_config(app_handle: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    let roaming_path = roaming_dir_path(&app_handle);
    tauri::async_runtime::spawn_blocking(move || {
        if crate::commands::library::library_move_in_progress()? {
            return Err(
                "Library relocation is in progress. Try saving settings again when it finishes."
                    .into(),
            );
        }

        let current = config::load_main_config(&roaming_path);
        if !config::same_library_location(&current, &config)? {
            return Err("Use the Library location control to move the Library. Settings saves cannot change its path.".into());
        }

        config::save_config_unchecked(&roaming_path, config)
    })
    .await
    .map_err(|e| format!("Failed to save config: {e}"))?
}
