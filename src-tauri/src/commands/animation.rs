use std::fs;
use std::io::Read;
use std::sync::RwLock;

use crate::archives::ArchiveCache;
use crate::formats::is_animated;

#[tauri::command(async)]
pub fn check_is_animated(
    path: String,
    archive_path: Option<String>,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<bool, String> {
    if let Some(arc_path) = archive_path {
        let header = {
            let mut cache = state.write().map_err(|e| e.to_string())?;
            cache.read_entry_header(&arc_path, &path, 8192)?
        };
        Ok(is_animated(&header))
    } else {
        let mut f = fs::File::open(&path).map_err(|e| format!("Cannot open file: {}", e))?;
        let mut buffer = [0u8; 8192];
        let bytes_read = f.read(&mut buffer).unwrap_or(0);
        Ok(is_animated(&buffer[..bytes_read]))
    }
}
