use std::fs;
use std::io::Read;
use std::sync::RwLock;

use crate::archives::ArchiveCache;
use crate::formats;
use crate::models::AnimationInfo;

pub use crate::containers::DimensionEntry;

#[tauri::command]
pub fn cancel_width_scan() {
    crate::containers::sweep::cancel_width_scan();
}

#[tauri::command]
pub fn cancel_dims_scan() {
    crate::containers::sweep::cancel_dims_scan();
}

#[tauri::command(async)]
pub fn probe_media_dimensions(path: String) -> Option<(u32, u32)> {
    let p = std::path::Path::new(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
    formats::read_media_dimensions_from_path(p, ext)
}

#[tauri::command(async)]
pub fn check_is_animated(
    path: String,
    archive_path: Option<String>,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<AnimationInfo, String> {
    if let Some(arc_path) = archive_path {
        let header = {
            let cache = state.read().map_err(|e| e.to_string())?;
            cache.read_entry_header(&arc_path, &path, 262_144)?
        };
        Ok(crate::formats::check_animation_status(&header))
    } else {
        let mut f = fs::File::open(&path).map_err(|e| format!("Cannot open file: {}", e))?;
        let mut buffer = vec![0u8; 262_144];
        let bytes_read = f.read(&mut buffer).unwrap_or(0);
        Ok(crate::formats::check_animation_status(
            &buffer[..bytes_read],
        ))
    }
}

#[tauri::command(async)]
pub fn check_media_audio(
    path: String,
    archive_path: Option<String>,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<bool, String> {
    if let Some(arc_path) = archive_path {
        let entry_bytes = {
            let cache = state.read().map_err(|e| e.to_string())?;
            cache.read_entry_header(&arc_path, &path, 524_288)?
        };
        let mut cursor = std::io::Cursor::new(&entry_bytes);
        Ok(crate::formats::check_mp4_has_audio(&mut cursor))
    } else {
        let mut f = fs::File::open(&path).map_err(|e| format!("Cannot open file: {}", e))?;
        Ok(crate::formats::check_mp4_has_audio(&mut f))
    }
}

#[tauri::command(async)]
pub fn scan_container_max_width(
    container: String,
    is_archive: bool,
    password: Option<String>,
    app: tauri::AppHandle,
) {
    crate::containers::sweep::scan_container_max_width(container, is_archive, password, app);
}

#[tauri::command(async)]
pub fn scan_container_dimensions(
    container: String,
    is_archive: bool,
    password: Option<String>,
    app: tauri::AppHandle,
) {
    crate::containers::sweep::scan_container_dimensions(container, is_archive, password, app);
}
