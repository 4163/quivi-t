use std::fs;

use crate::formats::{is_image_ext, is_metadata_ext};
use crate::models::FileEntry;

use super::cache::ZipArchive;

pub(crate) fn open_zip_archive(archive_path: &str) -> Result<ZipArchive, String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Cannot open archive: {e}"))?;
    zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("Invalid ZIP archive: {e}"))
}

fn decode_zip_entry_name<R: std::io::Read + std::io::Seek>(
    entry: &zip::read::ZipFile<'_, R>,
) -> String {
    crate::archives::decode_cjk_name(entry.name_raw())
}

pub(crate) fn list_zip_entries(archive_path: &str) -> Result<(Vec<FileEntry>, ZipArchive), String> {
    let mut archive = open_zip_archive(archive_path)?;
    let all_names: Vec<String> = archive.file_names().map(|s| s.to_string()).collect();

    let mut files = Vec::new();
    let mut skipped_count = 0;

    for (i, name) in all_names.iter().enumerate() {
        match archive.by_index(i) {
            Ok(entry) => {
                let decoded_name = decode_zip_entry_name(&entry);
                if entry.is_dir() {
                    continue;
                }
                let ext = decoded_name.rsplit('.').next().unwrap_or("");
                if !is_image_ext(ext) && !is_metadata_ext(ext) {
                    continue;
                }

                files.push(FileEntry::new_archive_entry(
                    decoded_name.clone(),
                    format!("{}|{}", archive_path, decoded_name),
                    ext.to_uppercase(),
                    "".to_string(),
                ));
            }
            Err(_) => {
                let ext = name.rsplit('.').next().unwrap_or("");
                if is_image_ext(ext) || is_metadata_ext(ext) {
                    files.push(FileEntry::new_archive_entry(
                        name.clone(),
                        format!("{}|{}", archive_path, name),
                        ext.to_uppercase(),
                        "".to_string(),
                    ));
                }
                skipped_count += 1;
            }
        }
    }

    if skipped_count > 0 {
        eprintln!(
            "Warning: {} ZIP entry(ies) have corrupt local headers and may fail to load",
            skipped_count
        );
    }

    files.sort_by(|a, b| natord::compare(&a.name, &b.name));
    Ok((files, archive))
}

pub(crate) fn read_zip_entry_by_decoded_name<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    entry_name: &str,
) -> Result<Vec<u8>, String> {
    if let Ok(mut entry) = archive.by_name(entry_name) {
        let mut buf = Vec::with_capacity(entry.size() as usize);
        if std::io::Read::read_to_end(&mut entry, &mut buf).is_ok() {
            return Ok(buf);
        }
    }

    let mut matching_index = None;
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let decoded_name = decode_zip_entry_name(&entry);
            if decoded_name == entry_name {
                matching_index = Some(i);
                break;
            }
        }
    }

    if let Some(index) = matching_index {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("Error reading ZIP entry: {e}"))?;
        let mut buf = Vec::with_capacity(entry.size() as usize);
        std::io::Read::read_to_end(&mut entry, &mut buf)
            .map_err(|e| format!("Error reading entry: {e}"))?;
        return Ok(buf);
    }

    Err(format!("Cannot find ZIP entry: {}", entry_name))
}

pub(crate) fn extract_zip_entry(archive_path: &str, entry_name: &str) -> Result<Vec<u8>, String> {
    let mut archive = open_zip_archive(archive_path)?;
    read_zip_entry_by_decoded_name(&mut archive, entry_name)
}

pub(crate) fn read_zip_entry_header<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    entry_name: &str,
    limit: usize,
) -> Result<Vec<u8>, String> {
    use std::io::Read;

    let try_limited = |entry: &mut zip::read::ZipFile<'_, R>| -> Result<Vec<u8>, String> {
        let mut buf = Vec::with_capacity(limit.min(entry.size() as usize));
        let mut take = entry.take(limit as u64);
        take.read_to_end(&mut buf)
            .map_err(|e| format!("Error reading ZIP entry header: {e}"))?;
        Ok(buf)
    };

    if let Ok(mut entry) = archive.by_name(entry_name) {
        return try_limited(&mut entry);
    }

    let mut matching_index = None;
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index(i) {
            let decoded_name = decode_zip_entry_name(&entry);
            if decoded_name == entry_name {
                matching_index = Some(i);
                break;
            }
        }
    }

    if let Some(index) = matching_index {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("Error reading ZIP entry: {e}"))?;
        return try_limited(&mut entry);
    }

    Err(format!("Cannot find ZIP entry: {}", entry_name))
}
