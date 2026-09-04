use std::collections::HashMap;
use std::fs;

use crate::formats::{is_image_ext, is_metadata_ext};
use crate::models::{ArchiveEncryptionStatus, FileEntry};

use super::cache::ZipArchive;

pub(crate) fn validate_zip_header(archive_path: &str) -> Result<fs::File, String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = fs::File::open(archive_path).map_err(|e| format!("Cannot open archive: {e}"))?;
    let len = file.metadata().map_err(|e| format!("Cannot read archive metadata: {e}"))?.len();

    if len < 22 {
        return Err("Invalid ZIP archive: file is smaller than minimum ZIP header (22 bytes)".to_string());
    }

    let mut magic = [0u8; 4];
    file.read_exact(&mut magic).map_err(|e| format!("Cannot read ZIP signature: {e}"))?;
    let is_zip_magic = matches!(
        magic,
        [0x50, 0x4B, 0x03, 0x04] | [0x50, 0x4B, 0x05, 0x06] | [0x50, 0x4B, 0x07, 0x08]
    );
    if !is_zip_magic {
        return Err("Invalid ZIP archive: missing PK signature header".to_string());
    }

    const MAX_TAIL_SCAN: u64 = 128 * 1024;
    let tail_len = len.min(MAX_TAIL_SCAN) as usize;
    let seek_offset = len - tail_len as u64;
    file.seek(SeekFrom::Start(seek_offset))
        .map_err(|e| format!("Cannot seek archive tail: {e}"))?;

    let mut tail_buf = vec![0u8; tail_len];
    file.read_exact(&mut tail_buf)
        .map_err(|e| format!("Cannot read archive tail: {e}"))?;

    let has_eocd = tail_buf.windows(4).any(|w| w == [0x50, 0x4B, 0x05, 0x06]);
    if !has_eocd {
        return Err("Invalid ZIP archive: End of Central Directory (EOCD) signature not found in archive tail".to_string());
    }

    file.seek(SeekFrom::Start(0)).map_err(|e| format!("Cannot reset archive cursor: {e}"))?;
    Ok(file)
}

pub(crate) fn open_zip_archive(archive_path: &str) -> Result<ZipArchive, String> {
    let file = validate_zip_header(archive_path)?;
    zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("Invalid ZIP archive: {e}"))
}

fn decode_zip_entry_name<R: std::io::Read + std::io::Seek>(
    entry: &zip::read::ZipFile<'_, R>,
) -> String {
    crate::archives::decode_cjk_name(entry.name_raw())
}

pub(crate) fn list_zip_entries(
    archive_path: &str,
    password: Option<&str>,
) -> Result<(Vec<FileEntry>, ZipArchive, HashMap<String, usize>, Option<ArchiveEncryptionStatus>), String> {
    let mut archive = open_zip_archive(archive_path)?;
    let all_names: Vec<String> = archive.file_names().map(|s| s.to_string()).collect();

    let mut files = Vec::new();
    let mut index_map = HashMap::with_capacity(all_names.len());
    let mut skipped_count = 0;
    let mut has_encrypted = false;
    let mut bad_password = false;

    for (i, name) in all_names.iter().enumerate() {
        let entry_res = match password {
            Some(pwd) => archive.by_index_decrypt(i, pwd.as_bytes()),
            None => archive.by_index(i),
        };

        match entry_res {
            Ok(entry) => {
                if entry.encrypted() {
                    has_encrypted = true;
                }
                let decoded_name = decode_zip_entry_name(&entry);
                index_map.insert(decoded_name.clone(), i);
                if name != &decoded_name {
                    index_map.insert(name.clone(), i);
                }
                let normalized = decoded_name.replace('\\', "/");
                if normalized != decoded_name {
                    index_map.insert(normalized, i);
                }

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
            Err(zip::result::ZipError::InvalidPassword) => {
                bad_password = true;
                index_map.insert(name.clone(), i);
                let normalized = name.replace('\\', "/");
                if normalized != *name {
                    index_map.insert(normalized, i);
                }
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
            Err(zip::result::ZipError::UnsupportedArchive(err)) if err.contains("Password") => {
                has_encrypted = true;
                index_map.insert(name.clone(), i);
                let normalized = name.replace('\\', "/");
                if normalized != *name {
                    index_map.insert(normalized, i);
                }
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
            Err(_) => {
                index_map.insert(name.clone(), i);
                let normalized = name.replace('\\', "/");
                if normalized != *name {
                    index_map.insert(normalized, i);
                }

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

    let encryption = if bad_password {
        Some(ArchiveEncryptionStatus::PasswordIncorrect)
    } else if has_encrypted && password.is_none() {
        Some(ArchiveEncryptionStatus::PasswordRequired)
    } else {
        None
    };

    if skipped_count > 0 {
        eprintln!(
            "Warning: {} ZIP entry(ies) have corrupt local headers and may fail to load",
            skipped_count
        );
    }

    files.sort_by(|a, b| natord::compare(&a.name, &b.name));
    Ok((files, archive, index_map, encryption))
}

fn get_zip_entry_by_index<'a, R: std::io::Read + std::io::Seek>(
    archive: &'a mut zip::ZipArchive<R>,
    idx: usize,
    password: Option<&str>,
) -> zip::result::ZipResult<zip::read::ZipFile<'a, R>> {
    match password {
        Some(pwd) => archive.by_index_decrypt(idx, pwd.as_bytes()),
        None => archive.by_index(idx),
    }
}

fn get_zip_entry_by_name<'a, R: std::io::Read + std::io::Seek>(
    archive: &'a mut zip::ZipArchive<R>,
    name: &str,
    password: Option<&str>,
) -> zip::result::ZipResult<zip::read::ZipFile<'a, R>> {
    match password {
        Some(pwd) => archive.by_name_decrypt(name, pwd.as_bytes()),
        None => archive.by_name(name),
    }
}

pub(crate) fn read_zip_entry_by_decoded_name<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    entry_name: &str,
    index_map: Option<&HashMap<String, usize>>,
    password: Option<&str>,
) -> Result<Vec<u8>, String> {
    if let Some(index) = index_map.and_then(|m| m.get(entry_name).copied()) {
        let mut entry = get_zip_entry_by_index(archive, index, password)
            .map_err(|e| format!("Error reading ZIP entry: {e}"))?;
        let mut buf = Vec::with_capacity(entry.size() as usize);
        std::io::Read::read_to_end(&mut entry, &mut buf)
            .map_err(|e| format!("Error reading entry: {e}"))?;
        return Ok(buf);
    }

    if let Ok(mut entry) = get_zip_entry_by_name(archive, entry_name, password) {
        let mut buf = Vec::with_capacity(entry.size() as usize);
        if std::io::Read::read_to_end(&mut entry, &mut buf).is_ok() {
            return Ok(buf);
        }
    }

    let total = archive.len();
    for i in 0..total {
        if let Ok(mut entry) = get_zip_entry_by_index(archive, i, password) {
            let decoded_name = decode_zip_entry_name(&entry);
            if decoded_name == entry_name {
                let mut buf = Vec::with_capacity(entry.size() as usize);
                std::io::Read::read_to_end(&mut entry, &mut buf)
                    .map_err(|e| format!("Error reading entry: {e}"))?;
                return Ok(buf);
            }
        }
    }

    Err(format!("Cannot find ZIP entry: {}", entry_name))
}

pub(crate) fn extract_zip_entry(
    archive_path: &str,
    entry_name: &str,
    password: Option<&str>,
) -> Result<Vec<u8>, String> {
    let mut archive = open_zip_archive(archive_path)?;
    read_zip_entry_by_decoded_name(&mut archive, entry_name, None, password)
}

pub(crate) fn read_zip_entry_header<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    entry_name: &str,
    limit: usize,
    index_map: Option<&HashMap<String, usize>>,
    password: Option<&str>,
) -> Result<Vec<u8>, String> {
    use std::io::Read;

    let try_limited = |entry: &mut zip::read::ZipFile<'_, R>| -> Result<Vec<u8>, String> {
        let mut buf = Vec::with_capacity(limit.min(entry.size() as usize));
        let mut take = entry.take(limit as u64);
        take.read_to_end(&mut buf)
            .map_err(|e| format!("Error reading ZIP entry header: {e}"))?;
        Ok(buf)
    };

    if let Some(index) = index_map.and_then(|m| m.get(entry_name).copied()) {
        let mut entry = get_zip_entry_by_index(archive, index, password)
            .map_err(|e| format!("Error reading ZIP entry header: {e}"))?;
        return try_limited(&mut entry);
    }

    if let Ok(mut entry) = get_zip_entry_by_name(archive, entry_name, password) {
        return try_limited(&mut entry);
    }

    let total = archive.len();
    for i in 0..total {
        if let Ok(mut entry) = get_zip_entry_by_index(archive, i, password) {
            let decoded_name = decode_zip_entry_name(&entry);
            if decoded_name == entry_name {
                return try_limited(&mut entry);
            }
        }
    }

    Err(format!("Cannot find ZIP entry: {}", entry_name))
}
