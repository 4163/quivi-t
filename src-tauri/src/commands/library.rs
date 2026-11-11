use std::fs;
use tauri::AppHandle;

pub use crate::library::*;

#[tauri::command]
pub fn library_move_in_progress() -> Result<bool, String> {
    let config_lock = crate::config::get_config_path().with_file_name(CONFIG_MOVE_LOCK_FILE);
    if config_lock.exists() {
        return Ok(true);
    }
    let library_root = crate::config::configured_library_dir()?;
    Ok(library_root.join(LIBRARY_MOVE_LOCK_FILE).exists())
}

#[tauri::command(async)]
pub async fn move_library(
    app_handle: AppHandle,
    config: crate::config::AppConfig,
    destination: String,
) -> Result<LibraryMoveResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::library::relocate_library(app_handle, config, destination)
    })
    .await
    .map_err(|err| format!("Library relocation worker failed: {err}"))?
}

#[tauri::command]
pub fn get_library_dir() -> Result<String, String> {
    let dir = crate::config::configured_library_dir()?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create library directory: {e}"))?;
    Ok(crate::config::display_path(&dir))
}

#[tauri::command]
pub fn get_default_library_dir() -> Result<String, String> {
    Ok(crate::config::display_path(
        &crate::config::default_library_dir()?,
    ))
}
