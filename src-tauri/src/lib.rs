use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
struct ImageFile {
    name: String,
    path: String,
    ext: String,
    date: String,
}

#[derive(Serialize)]
struct DirectoryReadResult {
    files: Vec<ImageFile>,
    initial_index: usize,
}

#[tauri::command]
fn read_directory(path: &str) -> Result<DirectoryReadResult, String> {
    let input_path = Path::new(path);
    if !input_path.exists() {
        return Err("Path does not exist".into());
    }

    let dir = if input_path.is_file() {
        input_path.parent().unwrap_or(Path::new(""))
    } else {
        input_path
    };

    let target_filename = if input_path.is_file() {
        input_path.file_name().and_then(|n| n.to_str()).unwrap_or("")
    } else {
        ""
    };

    let supported_exts = [
        "jpg", "jpeg", "png", "gif", "webp", "apng", "svg", "bmp", "ico", "avif",
    ];

    let mut files = Vec::new();

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if supported_exts.contains(&ext_lower.as_str()) {
                        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
                        let date = if let Ok(metadata) = path.metadata() {
                            if let Ok(modified) = metadata.modified() {
                                if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                                    duration.as_millis().to_string()
                                } else {
                                    "".to_string()
                                }
                            } else { "".to_string() }
                        } else { "".to_string() };

                        files.push(ImageFile {
                            name,
                            path: path.to_string_lossy().into_owned(),
                            ext: ext_lower.to_uppercase(),
                            date,
                        });
                    }
                }
            }
        }
    }

    // Sort naturally using natord
    files.sort_by(|a, b| natord::compare(&a.name, &b.name));

    let initial_index = files.iter().position(|f| f.name == target_filename).unwrap_or(0);

    Ok(DirectoryReadResult {
        files,
        initial_index,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_directory])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
