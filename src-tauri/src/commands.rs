use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Condvar};

use tauri::{Manager, Emitter};
use notify::{Watcher, RecursiveMode, RecommendedWatcher, Event};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

use crate::utils::*;
use crate::models::*;
use crate::archives::*;

// ── Directory Watcher ────────────────────────────────────────────────────────

pub struct WatcherState {
    pub watcher: Option<RecommendedWatcher>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self { watcher: None }
    }
}

// ── Tauri commands ───────────────────────────────────────────────────────────

pub fn is_hidden_path(path: &Path, name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }

    #[cfg(windows)]
    {
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if let Ok(metadata) = fs::metadata(path) {
            return metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0;
        }
    }

    false
}

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
            let is_dir = path.is_dir();
            let is_file = path.is_file();

            if is_dir || is_file {
                let mut include = false;
                let mut ext_upper = String::new();

                if is_dir {
                    include = true;
                } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if is_image_ext(&ext_lower) || is_archive_ext(&ext_lower) {
                        include = true;
                        ext_upper = ext_lower.to_uppercase();
                    }
                }

                if include {
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();
                    if !show_hidden && is_hidden_path(&path, &name) {
                        continue;
                    }

                    let date = if let Ok(metadata) = path.metadata() {
                        if let Ok(modified) = metadata.modified() {
                            if let Ok(duration) =
                                modified.duration_since(std::time::UNIX_EPOCH)
                            {
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

                    files.push(FileEntry {
                        name: name.clone(),
                        path: path.to_string_lossy().into_owned(),
                        ext: ext_upper,
                        date,
                        is_dir,
                        is_hidden: is_hidden_path(&path, &name),
                    });
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
        directory: dir.to_string_lossy().into_owned(),
        parent_directory: parent_dir_str,
    })
}

#[tauri::command]
pub fn read_directory(path: &str, show_hidden: Option<bool>) -> Result<DirectoryReadResult, String> {
    read_directory_impl(path, show_hidden.unwrap_or(false), None)
}

#[tauri::command]
pub fn list_archive(
    archive_path: &str,
    state: tauri::State<'_, Mutex<ArchiveCache>>,
) -> Result<ArchiveReadResult, String> {
    let mut cache = state.lock().map_err(|e| e.to_string())?;

    if cache.active_path.as_deref() != Some(archive_path) {
        cache.active_path = Some(archive_path.to_string());
        cache.zip_entries.clear();
        cache.zip_lru.clear();
        cache.zip_archive = None;
        cache.extract_notify = Arc::new((Mutex::new(HashSet::new()), Condvar::new()));
        
        // Cleanup old rar/7z temp dir if exists
        if let Some(old_dir) = &cache.extract_temp_dir {
            let _ = fs::remove_dir_all(old_dir);
        }
        cache.extract_temp_dir = None;

        let ext = archive_path.rsplit('.').next().unwrap_or("").to_lowercase();
        if ext == "rar" || ext == "cbr" || ext == "7z" || ext == "cb7" {
            let hash = format!("{:x}", md5::compute(archive_path));
            let temp_dir = std::env::temp_dir().join("QuiviT").join(hash);
            fs::create_dir_all(&temp_dir).ok();
            cache.extract_temp_dir = Some(temp_dir.clone());
            
            let notify = cache.extract_notify.clone();
            // Spawn background extractor
            let archive_path_clone = archive_path.to_string();
            std::thread::spawn(move || {
                if ext == "rar" || ext == "cbr" {
                    extract_rar_to_temp(archive_path_clone, temp_dir, notify);
                } else {
                    extract_7z_to_temp(archive_path_clone, temp_dir, notify);
                }
            });
        } else if ext == "zip" || ext == "cbz" {
            if let Ok(file) = fs::File::open(&archive_path) {
                if let Ok(archive) = zip::ZipArchive::new(file) {
                    cache.zip_archive = Some(archive);
                }
            }
        }
    }

    let ext = archive_path.rsplit('.').next().unwrap_or("").to_lowercase();
    let files = match ext.as_str() {
        "zip" | "cbz" => list_zip_entries(archive_path)?,
        "rar" | "cbr" => list_rar_entries(archive_path)?,
        "7z" | "cb7" => list_7z_entries(archive_path)?,
        "cbt" | "tar" => list_tar_entries(archive_path)?,
        _ => return Err(format!("Unsupported archive format: {ext}")),
    };

    Ok(ArchiveReadResult {
        files,
        archive_path: archive_path.to_string(),
    })
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
        // Skip if already in cache
        {
            let cache = state.lock().unwrap();
            if cache.active_path.as_deref() != Some(archive_path.as_str()) {
                break; // archive changed
            }
            if cache.zip_entries.contains_key(&entry_name) {
                continue;
            }
        }

        let extracted = {
            let mut cache = state.lock().unwrap();
            if cache.active_path.as_deref() != Some(archive_path.as_str()) {
                break;
            }
            if let Some(archive) = cache.zip_archive.as_mut() {
                if let Ok(mut entry) = archive.by_name(&entry_name) {
                    let mut data = Vec::with_capacity(entry.size() as usize);
                    if std::io::Read::read_to_end(&mut entry, &mut data).is_ok() {
                        Some(data)
                    } else { None }
                } else { None }
            } else { None }
        };

        let data = if let Some(d) = extracted { d } else {
            if let Ok(d) = extract_zip_entry(&archive_path, &entry_name) { d } else { continue }
        };

        let mut cache = state.lock().unwrap();
        if cache.active_path.as_deref() == Some(archive_path.as_str()) && !cache.zip_entries.contains_key(&entry_name) {
            cache.zip_capacity = 20;
            if cache.zip_lru.len() >= cache.zip_capacity {
                if let Some(oldest) = cache.zip_lru.pop_front() {
                    cache.zip_entries.remove(&oldest);
                }
            }
            cache.zip_entries.insert(entry_name.clone(), data);
            cache.zip_lru.push_back(entry_name);
        }
    }
    
    Ok(())
}

#[tauri::command]
pub fn open_parent(current_dir: &str, show_hidden: Option<bool>) -> Result<DirectoryReadResult, String> {
    let path = Path::new(current_dir);
    let parent = path.parent().ok_or("Already at root")?;
    // On Windows, a drive root like "E:\" has parent == "" — treat that as root too
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
            let p = entry.path();
            if p.is_dir() {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !show_hidden && is_hidden_path(&p, name) {
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
        .position(|s| {
            s.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                == current_name
        })
        .ok_or("Current directory not found among siblings")?;

    let new_idx =
        ((current_idx as i32 + delta).rem_euclid(siblings.len() as i32)) as usize;
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
        let current_idx = drives.iter().position(|d| d.to_ascii_uppercase() == path_upper).unwrap_or(0);
        let new_idx = ((current_idx as i32 + delta).rem_euclid(drives.len() as i32)) as usize;
        return Ok(drives[new_idx].clone());
    }

    let parent = parent_opt.unwrap();

    let mut siblings: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            let p = entry.path();
            let is_dir = p.is_dir();
            let is_archive = p
                .extension()
                .and_then(|e| e.to_str())
                .map(is_archive_ext)
                .unwrap_or(false);

            if is_dir || is_archive {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !show_hidden && is_hidden_path(&p, name) {
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

    let new_idx =
        ((current_idx as i32 + delta).rem_euclid(siblings.len() as i32)) as usize;
    Ok(siblings[new_idx].to_string_lossy().into_owned())
}

#[tauri::command]
pub fn get_drives() -> Vec<String> {
    let mut drives = Vec::new();
    for c in b'A'..=b'Z' {
        let path = format!("{}:\\", c as char);
        if std::path::Path::new(&path).exists() {
            drives.push(path);
        }
    }
    drives
}

#[tauri::command]
pub fn watch_directory(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<Mutex<WatcherState>>();
    let mut state = state.lock().unwrap();
    
    // Drop existing watcher to stop tracking the old directory
    state.watcher = None;
    
    let app_clone = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            if event.kind.is_create() || event.kind.is_remove() || event.kind.is_modify() {
                let _ = app_clone.emit("directory-changed", ());
            }
        }
    }).map_err(|e| format!("Failed to create watcher: {}", e))?;
    
    watcher
        .watch(Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch directory: {}", e))?;
        
    state.watcher = Some(watcher);
    Ok(())
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

