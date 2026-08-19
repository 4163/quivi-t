use std::fs;
use std::path::PathBuf;

use crate::formats::{is_image_ext, is_metadata_ext};
use crate::models::FileEntry;

use super::cache::{notify_extracted, write_temp_entry, ExtractNotify};

pub(crate) fn list_7z_entries(archive_path: &str) -> Result<Vec<FileEntry>, String> {
    let reader = sevenz_rust2::ArchiveReader::open(archive_path, sevenz_rust2::Password::empty())
        .map_err(|e| format!("Cannot open 7z archive: {e}"))?;
    let archive = reader.archive();

    let mut files = Vec::new();
    for entry in &archive.files {
        if entry.is_directory() || entry.is_anti_item() {
            continue;
        }
        let name = entry.name().to_string();
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

pub(crate) fn extract_7z_to_temp(archive_path: String, temp_dir: PathBuf, notify: ExtractNotify) {
    let Ok(mut reader) =
        sevenz_rust2::ArchiveReader::open(&archive_path, sevenz_rust2::Password::empty())
    else {
        return;
    };
    let _ = reader.for_each_entries(|entry, data| {
        if entry.is_directory() || entry.is_anti_item() {
            return Ok(true);
        }
        let name = entry.name().to_string();
        let ext = name.rsplit('.').next().unwrap_or("");
        if !is_image_ext(ext) && !is_metadata_ext(ext) {
            return Ok(true);
        }
        if write_temp_entry(&temp_dir, &name, |path| {
            let mut file = fs::File::create(path)?;
            std::io::copy(data, &mut file)?;
            Ok(())
        })
        .is_some()
        {
            notify_extracted(&notify, &name);
        }
        Ok(true)
    });
}
