use std::fs;
use std::io::Read;
use std::sync::RwLock;

use crate::animation::is_animated;
use crate::archives::ArchiveCache;

#[tauri::command(async)]
pub fn check_is_animated(
    path: String,
    archive_path: Option<String>,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<bool, String> {
    if let Some(arc_path) = archive_path {
        let entry_data = {
            let mut cache = state.write().map_err(|e| e.to_string())?;
            cache.read_entry_bytes(&arc_path, &path)?
        };
        
        let bytes = entry_data.wait_for_data(&path)?;
        Ok(is_animated(&bytes))
    } else {
        let mut f = fs::File::open(&path).map_err(|e| format!("Cannot open file: {}", e))?;
        let mut buffer = [0u8; 8192];
        let bytes_read = f.read(&mut buffer).unwrap_or(0);
        Ok(is_animated(&buffer[..bytes_read]))
    }
}
