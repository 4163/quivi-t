use std::fs;
use std::path::PathBuf;

use crate::formats::{is_image_ext, is_metadata_ext};
use crate::models::FileEntry;

use super::cache::{notify_extracted, write_temp_entry, ExtractNotify};

pub(crate) fn list_tar_entries(archive_path: &str) -> Result<Vec<FileEntry>, String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Cannot open TAR archive: {e}"))?;
    let mut archive = tar::Archive::new(file);

    let mut files = Vec::new();
    let entries = archive
        .entries()
        .map_err(|e| format!("Cannot read TAR entries: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Error reading TAR entry: {e}"))?;
        let name = entry
            .path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if entry.header().entry_type().is_dir() {
            continue;
        }
        let ext = name.rsplit('.').next().unwrap_or("");
        if !is_image_ext(ext) && !is_metadata_ext(ext) {
            continue;
        }

        files.push(FileEntry::new_archive_entry(
            name.clone(),
            format!("{}|{}", archive_path, name),
            ext.to_uppercase(),
            "".to_string(),
        ));
    }

    files.sort_by(|a, b| natord::compare(&a.name, &b.name));
    Ok(files)
}

#[cfg(test)]
pub(crate) fn extract_tar_entry(archive_path: &str, entry_name: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Cannot open TAR archive: {e}"))?;
    let mut archive = tar::Archive::new(file);
    let entries = archive
        .entries()
        .map_err(|e| format!("Cannot read TAR entries: {e}"))?;

    for entry in entries {
        let mut entry = entry.map_err(|e| format!("Error reading TAR entry: {e}"))?;
        let name = entry
            .path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if name == entry_name {
            let mut buf = Vec::with_capacity(entry.size() as usize);
            std::io::Read::read_to_end(&mut entry, &mut buf)
                .map_err(|e| format!("Error reading TAR entry {entry_name}: {e}"))?;
            return Ok(buf);
        }
    }

    Err(format!("Cannot find TAR entry {}", entry_name))
}

pub(crate) fn extract_tar_to_temp(archive_path: String, temp_dir: PathBuf, notify: ExtractNotify) {
    let Ok(file) = fs::File::open(&archive_path) else {
        return;
    };
    let mut archive = tar::Archive::new(file);
    let Ok(entries) = archive.entries() else {
        return;
    };

    for entry in entries {
        let Ok(mut entry) = entry else {
            continue;
        };
        let Ok(path) = entry.path() else {
            continue;
        };
        let name = path.to_string_lossy().replace('\\', "/");
        if entry.header().entry_type().is_dir() {
            continue;
        }

        let ext = name.rsplit('.').next().unwrap_or("");
        if !is_image_ext(ext) && !is_metadata_ext(ext) {
            continue;
        }

        if write_temp_entry(&temp_dir, &name, |path| {
            let mut file = fs::File::create(path)?;
            std::io::copy(&mut entry, &mut file)?;
            Ok(())
        })
        .is_some()
        {
            notify_extracted(&notify, &name);
        }
    }
}
