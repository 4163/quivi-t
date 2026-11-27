use std::path::Path;
use std::sync::RwLock;

use crate::archives::{
    prepare_archive_shared, read_entry_bytes_shared, read_plain_zip_entry_shared,
    spawn_remove_temp_dirs, ArchiveCache,
};
use crate::ico::{ico_frames_from_bytes, ico_frames_from_path};
use crate::models::ArchiveReadResult;

#[tauri::command(async)]
pub fn get_ico_frames(path: String) -> Result<Vec<crate::models::IcoSize>, String> {
    ico_frames_from_path(Path::new(&path))
}

#[tauri::command(async)]
pub fn list_archive(
    archive_path: String,
    password: Option<String>,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<ArchiveReadResult, String> {
    let result = prepare_archive_shared(&state, &archive_path, password.as_deref())?;
    if result.encryption.is_some() {
        crate::protocol::invalidate_tiff_cache_for_archive(&archive_path);
    }
    Ok(result)
}

#[tauri::command(async)]
pub fn drop_archive_cache(
    archive_path: String,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<(), String> {
    let dirs = {
        let mut cache = state.write().map_err(|e| e.to_string())?;
        cache.drop_archive_deferred(&archive_path)
    };
    crate::protocol::invalidate_tiff_cache_for_archive(&archive_path);
    spawn_remove_temp_dirs(dirs);
    Ok(())
}

#[tauri::command(async)]
pub fn prefetch_archive_entries(
    archive_path: String,
    entries: Vec<String>,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<(), String> {
    for entry_name in entries {
        if read_plain_zip_entry_shared(&state, &archive_path, &entry_name).is_none() {
            break;
        }
    }

    Ok(())
}

#[tauri::command(async)]
pub fn get_archive_ico_frames(
    archive_path: String,
    entry_name: String,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<Vec<crate::models::IcoSize>, String> {
    let data = read_entry_bytes_shared(&state, &archive_path, &entry_name)?;
    ico_frames_from_bytes(&data)
}

#[tauri::command(async)]
pub fn resolve_archive_temp_origin(
    path: String,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<Option<crate::models::TempArchiveOrigin>, String> {
    crate::platform::temp_archive::resolve_temp_origin(&path, &state)
}
