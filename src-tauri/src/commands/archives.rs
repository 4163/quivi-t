use std::sync::RwLock;

use crate::archives::ArchiveCache;
use crate::ico::ico_frames_from_bytes;
use crate::models::ArchiveReadResult;
use std::fs;

#[tauri::command(async)]
pub fn get_ico_frames(path: String) -> Result<String, String> {
    let data = fs::read(&path).map_err(|e| format!("Cannot read ICO file: {e}"))?;
    ico_frames_from_bytes(&data)
}

#[tauri::command(async)]
pub fn list_archive(
    archive_path: String,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<ArchiveReadResult, String> {
    let mut cache = state.write().map_err(|e| e.to_string())?;
    cache.prepare_archive(&archive_path)
}

#[tauri::command(async)]
pub fn prefetch_archive_entries(
    archive_path: String,
    entries: Vec<String>,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<(), String> {
    let ext = archive_path.rsplit('.').next().unwrap_or("");
    if !ext.eq_ignore_ascii_case("zip") && !ext.eq_ignore_ascii_case("cbz") {
        return Ok(());
    }

    let mut cache = state.write().map_err(|e| e.to_string())?;
    for entry_name in entries {
        let _ = cache.read_entry_bytes(&archive_path, &entry_name);
    }

    Ok(())
}

#[tauri::command(async)]
pub fn get_archive_ico_frames(
    archive_path: String,
    entry_name: String,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<String, String> {
    let entry_data = state
        .write()
        .map_err(|e| e.to_string())?
        .read_entry_bytes(&archive_path, &entry_name)?;
    let data = entry_data.wait_for_data(&entry_name)?;
    ico_frames_from_bytes(&data)
}
