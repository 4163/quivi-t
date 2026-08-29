use std::fs;
use std::io::Read;
use std::sync::RwLock;

use crate::archives::ArchiveCache;
use crate::models::AnimationInfo;

#[tauri::command(async)]
pub fn check_is_animated(
    path: String,
    archive_path: Option<String>,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<AnimationInfo, String> {
    if let Some(arc_path) = archive_path {
        let header = {
            let mut cache = state.write().map_err(|e| e.to_string())?;
            cache.read_entry_header(&arc_path, &path, 262_144)?
        };
        Ok(crate::formats::check_animation_status(&header))
    } else {
        let mut f = fs::File::open(&path).map_err(|e| format!("Cannot open file: {}", e))?;
        let mut buffer = vec![0u8; 262_144]; // 256 KiB
        let bytes_read = f.read(&mut buffer).unwrap_or(0);
        Ok(crate::formats::check_animation_status(&buffer[..bytes_read]))
    }
}
