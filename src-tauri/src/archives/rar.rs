use std::fs;
use std::path::PathBuf;

use crate::formats::{is_image_ext, is_metadata_ext};
use crate::models::FileEntry;

use super::cache::{notify_extracted, write_temp_entry, ExtractNotify};

pub(crate) fn list_rar_entries(archive_path: &str) -> Result<Vec<FileEntry>, String> {
    let archive = unrar::Archive::new(archive_path)
        .open_for_processing()
        .map_err(|e| format!("Cannot open RAR archive: {e}"))?;

    let mut iter = archive;
    let mut files = Vec::new();
    loop {
        match iter.read_header() {
            Ok(Some(header)) => {
                let entry = header.entry();
                let name = entry.filename.to_string_lossy().to_string();
                if !entry.is_directory() {
                    let ext = name.rsplit('.').next().unwrap_or("");
                    if is_image_ext(ext) || is_metadata_ext(ext) {
                        files.push(FileEntry::new_archive_entry(
                            name.clone(),
                            format!("{}|{}", archive_path, name),
                            ext.to_uppercase(),
                            "".to_string(),
                        ));
                    }
                }
                iter = header.skip().map_err(|e| e.to_string())?;
            }
            Ok(None) => break,
            Err(e) => return Err(format!("Error iterating RAR archive: {e}")),
        }
    }
    files.sort_by(|a, b| natord::compare(&a.name, &b.name));
    Ok(files)
}

pub(crate) fn extract_rar_to_temp(archive_path: String, temp_dir: PathBuf, notify: ExtractNotify) {
    if let Ok(archive) = unrar::Archive::new(&archive_path).open_for_processing() {
        let mut iter = archive;
        loop {
            match iter.read_header() {
                Ok(Some(header)) => {
                    let entry = header.entry();
                    let name = entry.filename.to_string_lossy().to_string();
                    if !entry.is_directory() {
                        let ext = name.rsplit('.').next().unwrap_or("");
                        if is_image_ext(ext) || is_metadata_ext(ext) {
                            if let Ok((data, next)) = header.read() {
                                if write_temp_entry(&temp_dir, &name, |path| fs::write(path, &data))
                                    .is_some()
                                {
                                    notify_extracted(&notify, &name);
                                }
                                iter = next;
                                continue;
                            } else {
                                break;
                            }
                        }
                    }
                    if let Ok(next) = header.skip() {
                        iter = next;
                    } else {
                        break;
                    }
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
    }
}
