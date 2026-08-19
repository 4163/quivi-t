use std::fs;
use std::path::{Path, PathBuf};

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
pub fn open_parent(
    current_dir: &str,
    show_hidden: Option<bool>,
) -> Result<DirectoryReadResult, String> {
    let path = Path::new(current_dir);
    let parent = path.parent().ok_or("Already at root")?;
    // On Windows, a drive root like "E:\" has parent == "". Treat that as root too.
    if parent.as_os_str().is_empty() {
        return Err("Already at root".to_string());
    }
    let target_name = path.file_name().and_then(|n| n.to_str());
    read_directory_impl(
        parent.to_str().unwrap_or(""),
        show_hidden.unwrap_or(false),
        target_name,
    )
}

#[tauri::command]
pub fn open_sibling(
    current_dir: &str,
    delta: i32,
    show_hidden: Option<bool>,
) -> Result<DirectoryReadResult, String> {
    let path = Path::new(current_dir);
    let parent = path.parent().ok_or("Already at root")?;
    let show_hidden = show_hidden.unwrap_or(false);

    let mut siblings: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            let file_type = if let Ok(ft) = entry.file_type() {
                ft
            } else {
                continue;
            };
            if file_type.is_dir() {
                let p = entry.path();
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let metadata_res = entry.metadata();
                if !show_hidden && is_hidden_path(name, metadata_res.as_ref().ok()) {
                    continue;
                }
                siblings.push(p);
            }
        }
    }

    siblings.sort_by(|a, b| {
        natord::compare(
            &a.file_name().unwrap_or_default().to_string_lossy(),
            &b.file_name().unwrap_or_default().to_string_lossy(),
        )
    });

    let current_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let current_idx = siblings
        .iter()
        .position(|s| s.file_name().and_then(|n| n.to_str()).unwrap_or("") == current_name)
        .ok_or("Current directory not found among siblings")?;

    let new_idx = ((current_idx as i32 + delta).rem_euclid(siblings.len() as i32)) as usize;
    let sibling = &siblings[new_idx];

    read_directory_impl(sibling.to_str().unwrap_or(""), show_hidden, None)
}

#[tauri::command]
pub fn open_sibling_container(
    current_path: &str,
    delta: i32,
    show_hidden: Option<bool>,
) -> Result<String, String> {
    let path = Path::new(current_path);
    let show_hidden = show_hidden.unwrap_or(false);

    let parent_opt = path.parent();

    // If we are at the root (no parent), jump between drives
    if parent_opt.is_none() {
        let drives = get_drives();
        if drives.is_empty() {
            return Err("No drives found".into());
        }

        let path_upper = current_path.to_ascii_uppercase();
        let current_idx = drives
            .iter()
            .position(|d| d.to_ascii_uppercase() == path_upper)
            .unwrap_or(0);
        let new_idx = ((current_idx as i32 + delta).rem_euclid(drives.len() as i32)) as usize;
        return Ok(drives[new_idx].clone());
    }

    let parent = parent_opt.unwrap();

    let mut siblings: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            let p = entry.path();
            let file_type = if let Ok(ft) = entry.file_type() {
                ft
            } else {
                continue;
            };
            let is_dir = file_type.is_dir();
            let is_archive = if file_type.is_file() {
                p.extension()
                    .and_then(|e| e.to_str())
                    .map(is_archive_ext)
                    .unwrap_or(false)
            } else {
                false
            };

            if is_dir || is_archive {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let metadata_res = entry.metadata();
                if !show_hidden && is_hidden_path(name, metadata_res.as_ref().ok()) {
                    continue;
                }
                siblings.push(p);
            }
        }
    }

    if siblings.is_empty() {
        return Err("No sibling folders or archives found".into());
    }

    siblings.sort_by(|a, b| {
        b.is_dir().cmp(&a.is_dir()).then_with(|| {
            natord::compare(
                &a.file_name().unwrap_or_default().to_string_lossy(),
                &b.file_name().unwrap_or_default().to_string_lossy(),
            )
        })
    });

    let current_idx = siblings
        .iter()
        .position(|s| s == path)
        .ok_or("Current folder/archive not found among siblings")?;

    let new_idx = ((current_idx as i32 + delta).rem_euclid(siblings.len() as i32)) as usize;
    Ok(siblings[new_idx].to_string_lossy().into_owned())
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
    fs::write(&path, content).map_err(|e| e.to_string())
}
