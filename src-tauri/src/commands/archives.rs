use std::sync::Mutex;

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
    state: tauri::State<'_, Mutex<ArchiveCache>>,
) -> Result<ArchiveReadResult, String> {
    let mut cache = state.lock().map_err(|e| e.to_string())?;
    cache.prepare_archive(&archive_path)
}

#[tauri::command(async)]
pub fn prefetch_archive_entries(
    archive_path: String,
    entries: Vec<String>,
    state: tauri::State<'_, Mutex<ArchiveCache>>,
) -> Result<(), String> {
    let ext = archive_path.rsplit('.').next().unwrap_or("").to_lowercase();
    if ext != "zip" && ext != "cbz" {
        return Ok(());
    }

    for entry_name in entries {
        let mut cache = state.lock().map_err(|e| e.to_string())?;
        let _ = cache.read_entry_bytes(&archive_path, &entry_name);
    }

    Ok(())
}

#[tauri::command(async)]
pub fn get_archive_ico_frames(
    archive_path: String,
    entry_name: String,
    state: tauri::State<'_, Mutex<ArchiveCache>>,
) -> Result<String, String> {
    let data = state
        .lock()
        .map_err(|e| e.to_string())?
        .read_entry_bytes(&archive_path, &entry_name)?;
    ico_frames_from_bytes(&data)
}
