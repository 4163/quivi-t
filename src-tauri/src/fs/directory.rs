use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::formats::{is_archive_ext, is_image_ext};
use crate::models::{DirectoryReadResult, FileEntry};
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

    let is_library_or_gallery = dir.join("gallery.json").is_file()
        || crate::library::is_within_library(dir);

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
                    if is_image_ext(ext)
                        || is_archive_ext(ext)
                        || (is_library_or_gallery && ext.eq_ignore_ascii_case("mp4"))
                    {
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

                    if !show_hidden && is_hidden && name != target_filename {
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

pub fn get_drives_impl() -> Vec<String> {
    let mut drives = Vec::new();
    for c in b'A'..=b'Z' {
        let path = format!("{}:\\", c as char);
        if Path::new(&path).exists() {
            drives.push(path);
        }
    }
    drives
}

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

pub fn get_file_sizes(paths: Vec<String>) -> HashMap<String, u64> {
    paths
        .into_iter()
        .filter_map(|path| {
            let metadata = fs::metadata(&path).ok()?;
            metadata.is_file().then(|| (path, metadata.len()))
        })
        .collect()
}

pub fn read_text_file(path: impl AsRef<Path>) -> Result<String, String> {
    fs::read_to_string(path.as_ref()).map_err(|e| e.to_string())
}

pub fn write_text_file(path: impl AsRef<Path>, content: impl AsRef<str>) -> Result<(), String> {
    let p = path.as_ref();
    crate::library::ensure_library_write_allowed(p)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(p, content.as_ref()).map_err(|e| e.to_string())
}

pub fn create_placeholder_files<P: AsRef<Path>, S: AsRef<str>, I: IntoIterator<Item = S>>(
    dir: P,
    filenames: I,
) -> Result<(), String> {
    let dir_path = dir.as_ref();
    crate::library::ensure_library_write_allowed(dir_path)?;
    if !dir_path.exists() {
        fs::create_dir_all(dir_path).map_err(|e| e.to_string())?;
    }
    for filename in filenames {
        let file_path = dir_path.join(filename.as_ref());
        if !file_path.exists() {
            let _ = fs::File::create(&file_path);
        }
    }
    Ok(())
}

pub fn remove_file(path: impl AsRef<Path>) -> Result<(), String> {
    let p = path.as_ref();
    crate::library::ensure_library_write_allowed(p)?;
    if p.exists() {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn remove_directory_impl(path: impl AsRef<Path>) -> Result<(), String> {
    let p = path.as_ref();
    crate::library::ensure_library_write_allowed(p)?;
    if !p.exists() {
        return Ok(());
    }

    let lib_dir = crate::config::configured_library_dir()?;
    let _ = fs::create_dir_all(&lib_dir);

    let canonical_lib = fs::canonicalize(&lib_dir)
        .map_err(|e| format!("Failed to canonicalize library root: {e}"))?;
    let canonical_target =
        fs::canonicalize(p).map_err(|e| format!("Failed to canonicalize target path: {e}"))?;

    if !canonical_target.starts_with(&canonical_lib) || canonical_target == canonical_lib {
        return Err("Cannot remove path outside of library root".into());
    }

    #[cfg(windows)]
    let recycled = crate::platform::recycle::move_to_recycle_bin(&canonical_target).is_ok();
    #[cfg(not(windows))]
    let recycled = false;

    if !recycled && canonical_target.exists() {
        if canonical_target.is_dir() {
            crate::platform::recycle::remove_dir_all_robust(&canonical_target)
                .map_err(|e| e.to_string())?;
        } else {
            crate::platform::recycle::remove_file_robust(&canonical_target)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
