use std::fs;
use std::path::Path;

use crate::formats::is_image_ext;
use crate::models::{LibraryNode, LibraryProviderEntry};

pub fn read_gallery_metadata(path: &Path) -> (Option<String>, usize, bool) {
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

pub fn read_library_nodes(dir: &Path) -> Vec<LibraryNode> {
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

        let metadata = entry.metadata().ok();
        let created_millis = metadata
            .as_ref()
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
            size: if is_file {
                metadata.as_ref().map_or(0, fs::Metadata::len)
            } else {
                0
            },
            image_count,
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

pub fn read_library_tree_impl() -> Result<Vec<LibraryProviderEntry>, String> {
    let lib_dir = crate::config::configured_library_dir()?;
    let _ = fs::create_dir_all(&lib_dir);
    if !lib_dir.exists() {
        return Ok(Vec::new());
    }

    let provider_entries = fs::read_dir(&lib_dir).map_err(|e| e.to_string())?;
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
