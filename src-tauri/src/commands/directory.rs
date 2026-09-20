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

    let is_library_or_gallery = dir.join("gallery.json").is_file()
        || crate::commands::library::is_within_library(dir);

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
    crate::commands::library::ensure_library_write_allowed(p)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn create_placeholder_files(dir: String, filenames: Vec<String>) -> Result<(), String> {
    let dir_path = Path::new(&dir);
    crate::commands::library::ensure_library_write_allowed(dir_path)?;
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
    crate::commands::library::ensure_library_write_allowed(p)?;
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

        let nodes = read_library_nodes(&provider_path);

        providers.push(LibraryProviderEntry {
            name: provider_name,
            path: provider_path.to_string_lossy().into_owned(),
            nodes,
        });
    }

    providers.sort_by(|a, b| natord::compare(&a.name, &b.name));
    Ok(providers)
}

fn read_library_nodes(dir: &Path) -> Vec<LibraryNode> {
    let mut nodes = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return nodes,
    };

    for entry in entries.flatten() {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        let path = entry.path();
        let name = match path.file_name().and_then(|part| part.to_str()) {
            Some(name) if !name.is_empty() && name != "gallery.json" => name.to_string(),
            _ => continue,
        };
        let is_dir = file_type.is_dir();
        let is_file = file_type.is_file();
        if !is_dir && !is_file {
            continue;
        }
        if is_file
            && !path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| is_image_ext(ext) || ext.eq_ignore_ascii_case("mp4"))
        {
            continue;
        }

        let created_millis = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.created().or_else(|_| metadata.modified()).ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        let date = if created_millis > 0 {
            created_millis.to_string()
        } else {
            String::new()
        };

        let (title, image_count, is_gallery) = if is_dir {
            read_gallery_metadata(&path)
        } else {
            (None, 0, false)
        };
        if is_dir && !is_gallery {
            continue;
        }

        nodes.push(LibraryNode {
            name,
            path: path.to_string_lossy().into_owned(),
            title,
            date,
            created_millis,
            is_dir,
            is_gallery,
            image_count,
            children: Vec::new(),
        });
    }

    nodes.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.created_millis.cmp(&b.created_millis))
            .then_with(|| natord::compare(&a.name, &b.name))
    });
    nodes
}

fn read_gallery_metadata(path: &Path) -> (Option<String>, usize, bool) {
    let sidecar_path = path.join("gallery.json");
    if !sidecar_path.is_file() {
        return (None, 0, false);
    }
    let sidecar_text = match fs::read_to_string(sidecar_path) {
        Ok(sidecar_text) => sidecar_text,
        Err(_) => return (None, 0, false),
    };
    let metadata = match serde_json::from_str::<serde_json::Value>(&sidecar_text) {
        Ok(metadata) => metadata,
        Err(_) => return (None, 0, false),
    };
    let title = metadata
        .get("title")
        .and_then(|title| title.as_str())
        .filter(|title| !title.is_empty())
        .map(str::to_string);
    let image_count = metadata
        .get("images")
        .and_then(|images| images.as_array())
        .map_or(0, Vec::len);
    (title, image_count, true)
}

fn remove_file_robust(path: &Path) -> std::io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    if let Ok(meta) = fs::metadata(path) {
        if meta.permissions().readonly() {
            let mut perms = meta.permissions();
            perms.set_readonly(false);
            let _ = fs::set_permissions(path, perms);
        }
    }
    for attempt in 0..10 {
        match fs::remove_file(path) {
            Ok(_) => return Ok(()),
            Err(e) if attempt == 9 => return Err(e),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
    Ok(())
}

fn remove_dir_contents_and_self(dir: &Path) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if let Ok(meta) = entry.metadata() {
            if meta.permissions().readonly() {
                let mut perms = meta.permissions();
                perms.set_readonly(false);
                let _ = fs::set_permissions(&path, perms);
            }
            if meta.is_dir() {
                remove_dir_contents_and_self(&path)?;
            } else {
                remove_file_robust(&path)?;
            }
        }
    }
    fs::remove_dir(dir)
}

fn remove_dir_all_robust(dir: &Path) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for attempt in 0..10 {
        match remove_dir_contents_and_self(dir) {
            Ok(_) => return Ok(()),
            Err(e) if attempt == 9 => return Err(e),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn move_to_recycle_bin(path: &Path) -> std::io::Result<()> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };

    let path_str = path.to_string_lossy();
    let clean_path = path_str.strip_prefix(r"\\?\").unwrap_or(&path_str);

    let mut wide: Vec<u16> = clean_path.encode_utf16().collect();
    wide.push(0);
    wide.push(0);

    let mut op = SHFILEOPSTRUCTW {
        hwnd: Default::default(),
        wFunc: FO_DELETE,
        pFrom: PCWSTR(wide.as_ptr()),
        pTo: PCWSTR::null(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI).0 as u16,
        fAnyOperationsAborted: Default::default(),
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: PCWSTR::null(),
    };

    let ret = unsafe { SHFileOperationW(&mut op) };
    if ret == 0 && !op.fAnyOperationsAborted.as_bool() {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("SHFileOperationW failed with return code {ret}"),
        ))
    }
}

#[tauri::command(async)]
pub fn remove_directory(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    crate::commands::library::ensure_library_write_allowed(p)?;
    if !p.exists() {
        return Ok(());
    }

    let lib_dir_str = crate::commands::shell::get_library_dir()?;
    let lib_dir = Path::new(&lib_dir_str);

    let canonical_lib = fs::canonicalize(lib_dir)
        .map_err(|e| format!("Failed to canonicalize library root: {e}"))?;
    let canonical_target =
        fs::canonicalize(p).map_err(|e| format!("Failed to canonicalize target path: {e}"))?;

    if !canonical_target.starts_with(&canonical_lib) || canonical_target == canonical_lib {
        return Err("Cannot remove path outside of library root".into());
    }

    #[cfg(windows)]
    let recycled = move_to_recycle_bin(&canonical_target).is_ok();
    #[cfg(not(windows))]
    let recycled = false;

    if !recycled && canonical_target.exists() {
        if canonical_target.is_dir() {
            remove_dir_all_robust(&canonical_target).map_err(|e| e.to_string())?;
        } else {
            remove_file_robust(&canonical_target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

const METADATA_FILENAMES: [&str; 6] = [
    "comicinfo.xml",
    "comicinfo.json",
    "meta.json",
    "comet.xml",
    "comet.json",
    "metadata.opf",
];

#[tauri::command(async)]
pub fn find_directory_metadata(dir_path: String) -> Result<Option<DirectoryMetadataResult>, String> {
    let input_path = Path::new(&dir_path);
    if !input_path.exists() {
        return Ok(None);
    }

    let dir = if input_path.is_file() {
        input_path.parent().unwrap_or(Path::new(""))
    } else {
        input_path
    };

    if !crate::commands::library::is_within_library(dir) {
        return Ok(None);
    }

    if let Ok(entries) = fs::read_dir(dir) {
        let entries_vec: Vec<_> = entries.flatten().collect();
        for target in &METADATA_FILENAMES {
            if let Some(entry) = entries_vec.iter().find(|e| {
                e.file_name()
                    .to_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(target))
            }) {
                let meta_path = entry.path();
                if let Ok(content) = fs::read_to_string(&meta_path) {
                    return Ok(Some(DirectoryMetadataResult {
                        meta_path: meta_path.to_string_lossy().into_owned(),
                        content,
                        dir_path: dir.to_string_lossy().into_owned(),
                    }));
                }
            }
        }
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_nodes_are_single_galleries_without_nested_tree() {
        let root = std::env::temp_dir().join(format!(
            "quivit_library_nodes_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let series = root.join("Series");
        fs::create_dir_all(&series).unwrap();
        fs::write(
            series.join("gallery.json"),
            r#"{"title":"Series Title","images":[{"filename":"Cover.jpg"}]}"#,
        )
        .unwrap();

        let nodes = read_library_nodes(&root);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "Series");
        assert_eq!(nodes[0].title.as_deref(), Some("Series Title"));
        assert!(nodes[0].is_gallery);
        assert_eq!(nodes[0].image_count, 1);
        assert!(nodes[0].children.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn library_nodes_never_include_files_under_subdirectories() {
        let root = std::env::temp_dir().join(format!(
            "quivit_library_files_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let provider = root.join("Imgur");
        let album = provider.join("My Album");
        fs::create_dir_all(&album).unwrap();

        // Direct raw file under provider root
        fs::write(provider.join("direct.png"), "image").unwrap();

        // Files inside album
        fs::write(album.join("001.png"), "placeholder").unwrap();
        fs::write(album.join("002.png"), "placeholder").unwrap();

        // Without gallery.json: album is not a recognized gallery, so it's skipped
        let nodes = read_library_nodes(&provider);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "direct.png");
        assert!(!nodes[0].is_dir);

        // With gallery.json: album is recognized as a gallery with image_count = 2, children = []
        fs::write(
            album.join("gallery.json"),
            r#"{"title":"My Album","images":[{"filename":"001.png"},{"filename":"002.png"}]}"#,
        )
        .unwrap();

        let nodes_with_gallery = read_library_nodes(&provider);
        assert_eq!(nodes_with_gallery.len(), 2);
        let gallery_node = nodes_with_gallery.iter().find(|n| n.name == "My Album").unwrap();
        assert!(gallery_node.is_dir);
        assert!(gallery_node.is_gallery);
        assert_eq!(gallery_node.image_count, 2);
        assert!(gallery_node.children.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn test_create_placeholder_files() {
        let temp_dir =
            std::env::temp_dir().join(format!("quivit_test_placeholders_{}", std::process::id()));
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
        let temp_file =
            std::env::temp_dir().join(format!("quivit_test_remove_{}", std::process::id()));
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
        let non_existent =
            std::env::temp_dir().join(format!("quivit_non_existent_{}", std::process::id()));
        let res = remove_directory(non_existent.to_string_lossy().into_owned());
        assert!(res.is_ok());

        let outside_dir = std::env::temp_dir();
        let res_outside = remove_directory(outside_dir.to_string_lossy().into_owned());
        assert!(res_outside.is_err());
    }
}
