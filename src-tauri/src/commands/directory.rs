use std::fs;
use std::path::Path;

use crate::formats::*;
use crate::models::*;
use crate::platform::attributes::is_hidden_path;

pub fn read_directory_impl(
    path: &str,
    show_hidden: bool,
    target_name_override: Option<&str>,
) -> Result<DirectoryReadResult, String> {
    let input_path = Path::new(path);
    if !input_path.exists() {
        return Err("Path does not exist".into());
    }

    let dir = if input_path.is_file() {
        input_path.parent().unwrap_or(Path::new(""))
    } else {
        input_path
    };

    let target_filename = if let Some(name) = target_name_override {
        name
    } else if input_path.is_file() {
        input_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
    } else {
        ""
    };

    let mut files = Vec::new();

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let file_type = if let Ok(ft) = entry.file_type() {
                ft
            } else {
                continue;
            };
            let is_dir = file_type.is_dir();
            let is_file = file_type.is_file();

            if is_dir || is_file {
                let mut include = false;
                let mut ext_upper = String::new();

                if is_dir {
                    include = true;
                } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if is_image_ext(ext) || is_archive_ext(ext) {
                        include = true;
                        ext_upper = ext.to_uppercase();
                    }
                }

                if include {
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();
                    let metadata_res = entry.metadata();
                    let is_hidden = is_hidden_path(&name, metadata_res.as_ref().ok());

                    if !show_hidden && is_hidden {
                        continue;
                    }

                    let date = if let Ok(metadata) = &metadata_res {
                        if let Ok(modified) = metadata.modified() {
                            if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                                duration.as_millis().to_string()
                            } else {
                                "".to_string()
                            }
                        } else {
                            "".to_string()
                        }
                    } else {
                        "".to_string()
                    };

                    let size = metadata_res.as_ref().map(|m| m.len()).unwrap_or(0);

                    if is_dir {
                        files.push(FileEntry::new_directory(
                            name.clone(),
                            path.to_string_lossy().into_owned(),
                            date,
                            is_hidden,
                        ));
                    } else {
                        files.push(FileEntry::new_file(
                            name.clone(),
                            path.to_string_lossy().into_owned(),
                            ext_upper,
                            date,
                            is_hidden,
                            size,
                        ));
                    }
                }
            }
        }
    }

    files.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| natord::compare(&a.name, &b.name))
    });

    let initial_index = files
        .iter()
        .position(|f| f.name == target_filename)
        .unwrap_or(0);

    let parent_dir_str = if let Some(parent) = dir.parent() {
        if parent.as_os_str().is_empty() {
            Some("__DRIVES__".to_string())
        } else {
            Some(parent.to_string_lossy().into_owned())
        }
    } else {
        Some("__DRIVES__".to_string())
    };

    Ok(DirectoryReadResult {
        files,
        initial_index,
        target_filename: target_filename.to_string(),
        directory: dir.to_string_lossy().into_owned(),
        parent_directory: parent_dir_str,
    })
}

#[tauri::command(async)]
pub fn read_directory(
    path: String,
    show_hidden: Option<bool>,
    target_name: Option<String>,
) -> Result<DirectoryReadResult, String> {
    read_directory_impl(&path, show_hidden.unwrap_or(false), target_name.as_deref())
}

#[tauri::command]
pub fn get_drives() -> Vec<String> {
    let mut drives = Vec::new();
    for c in b'A'..=b'Z' {
        let path = format!("{}:\\", c as char);
        if Path::new(&path).exists() {
            drives.push(path);
        }
    }
    drives
}

#[tauri::command]
pub fn get_path_kind(path: &str) -> String {
    let path = Path::new(path);
    if path.is_dir() {
        "directory".to_string()
    } else if path.is_file() {
        "file".to_string()
    } else {
        "missing".to_string()
    }
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn create_placeholder_files(dir: String, filenames: Vec<String>) -> Result<(), String> {
    let dir_path = Path::new(&dir);
    if !dir_path.exists() {
        fs::create_dir_all(dir_path).map_err(|e| e.to_string())?;
    }
    for filename in filenames {
        let file_path = dir_path.join(filename);
        if !file_path.exists() {
            let _ = fs::File::create(&file_path);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn remove_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn read_library_tree() -> Result<Vec<LibraryProviderEntry>, String> {
    let lib_dir_str = crate::commands::shell::get_library_dir()?;
    let lib_dir = Path::new(&lib_dir_str);
    if !lib_dir.exists() {
        return Ok(Vec::new());
    }

    let provider_entries = fs::read_dir(lib_dir).map_err(|e| e.to_string())?;
    let mut providers = Vec::new();

    for entry in provider_entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !file_type.is_dir() {
            continue;
        }

        let provider_path = entry.path();
        let provider_name = provider_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        if provider_name.is_empty() {
            continue;
        }

        let mut galleries = Vec::new();
        if let Ok(gallery_entries) = fs::read_dir(&provider_path) {
            for g_entry in gallery_entries.flatten() {
                let g_type = match g_entry.file_type() {
                    Ok(ft) => ft,
                    Err(_) => continue,
                };
                let g_path = g_entry.path();
                let g_name = g_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();

                if g_name.is_empty() {
                    continue;
                }

                let is_dir = g_type.is_dir();
                let is_file = g_type.is_file();

                if !is_dir && !is_file {
                    continue;
                }

                if is_file {
                    if let Some(ext) = g_path.extension().and_then(|e| e.to_str()) {
                        if !is_image_ext(ext) {
                            continue;
                        }
                    } else {
                        continue;
                    }
                }

                let metadata = g_entry.metadata().ok();
                let created_millis = metadata
                    .as_ref()
                    .and_then(|m| m.created().or_else(|_| m.modified()).ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);

                let date_str = if created_millis > 0 {
                    created_millis.to_string()
                } else {
                    String::new()
                };

                let mut title = None;
                let mut image_count = 0;

                if is_dir {
                    let sidecar_path = g_path.join("gallery.json");
                    if sidecar_path.is_file() {
                        if let Ok(sidecar_text) = fs::read_to_string(&sidecar_path) {
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&sidecar_text) {
                                if let Some(t) = v.get("title").and_then(|t| t.as_str()) {
                                    if !t.is_empty() {
                                        title = Some(t.to_string());
                                    }
                                }
                                if let Some(imgs) = v.get("images").and_then(|i| i.as_array()) {
                                    image_count = imgs.len();
                                }
                            }
                        }
                    }
                }

                galleries.push(LibraryGalleryEntry {
                    name: g_name,
                    path: g_path.to_string_lossy().into_owned(),
                    title,
                    date: date_str,
                    created_millis,
                    is_dir,
                    image_count,
                });
            }
        }

        galleries.sort_by(|a, b| {
            a.created_millis
                .cmp(&b.created_millis)
                .then_with(|| natord::compare(&a.name, &b.name))
        });

        providers.push(LibraryProviderEntry {
            name: provider_name,
            path: provider_path.to_string_lossy().into_owned(),
            galleries,
        });
    }

    providers.sort_by(|a, b| natord::compare(&a.name, &b.name));
    Ok(providers)
}

#[tauri::command(async)]
pub fn remove_directory(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(());
    }

    let lib_dir_str = crate::commands::shell::get_library_dir()?;
    let lib_dir = Path::new(&lib_dir_str);

    let canonical_lib = fs::canonicalize(lib_dir)
        .map_err(|e| format!("Failed to canonicalize library root: {e}"))?;
    let canonical_target = fs::canonicalize(p)
        .map_err(|e| format!("Failed to canonicalize target path: {e}"))?;

    if !canonical_target.starts_with(&canonical_lib) || canonical_target == canonical_lib {
        return Err("Cannot remove path outside of library root".into());
    }

    if canonical_target.is_dir() {
        fs::remove_dir_all(&canonical_target).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(&canonical_target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_placeholder_files() {
        let temp_dir = std::env::temp_dir().join(format!("quivit_test_placeholders_{}", std::process::id()));
        let filenames = vec!["001.png".to_string(), "002.png".to_string()];
        let res = create_placeholder_files(temp_dir.to_string_lossy().into_owned(), filenames);
        assert!(res.is_ok());

        assert!(temp_dir.join("001.png").is_file());
        assert!(temp_dir.join("002.png").is_file());
        assert_eq!(temp_dir.join("001.png").metadata().unwrap().len(), 0);

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_remove_file() {
        let temp_file = std::env::temp_dir().join(format!("quivit_test_remove_{}", std::process::id()));
        fs::write(&temp_file, "hello").unwrap();
        assert!(temp_file.is_file());

        let res = remove_file(temp_file.to_string_lossy().into_owned());
        assert!(res.is_ok());
        assert!(!temp_file.exists());

        // Deleting non-existent file should succeed as a no-op
        let res2 = remove_file(temp_file.to_string_lossy().into_owned());
        assert!(res2.is_ok());
    }

    #[test]
    fn test_remove_directory_safety() {
        let non_existent = std::env::temp_dir().join(format!("quivit_non_existent_{}", std::process::id()));
        let res = remove_directory(non_existent.to_string_lossy().into_owned());
        assert!(res.is_ok());

        let outside_dir = std::env::temp_dir();
        let res_outside = remove_directory(outside_dir.to_string_lossy().into_owned());
        assert!(res_outside.is_err());
    }
}


