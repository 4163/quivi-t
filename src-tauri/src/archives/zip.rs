use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};

use crate::formats::{is_image_ext, is_metadata_ext};
use crate::models::{ArchiveEncryptionStatus, FileEntry};

use super::cache::ZipArchive;
use super::sort_archive_entries;

const FAST_TAIL_SCAN: u64 = 4 * 1024;
const MAX_TAIL_SCAN: u64 = 128 * 1024;

fn tail_has_eocd(buf: &[u8]) -> bool {
    buf.windows(4).rev().any(|w| {
        matches!(
            w,
            [0x50, 0x4B, 0x05, 0x06] | [0x50, 0x4B, 0x06, 0x06] | [0x50, 0x4B, 0x06, 0x07]
        )
    })
}

pub(super) fn validate_zip_header(archive_path: &str) -> Result<fs::File, String> {
    let mut file = fs::File::open(archive_path).map_err(|e| format!("Cannot open archive: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("Cannot read archive metadata: {e}"))?
        .len();

    if len < 22 {
        return Err(
            "Invalid ZIP archive: file is smaller than minimum ZIP header (22 bytes)".to_string(),
        );
    }

    // Allow ZIPs with prepended data (SFX/offset archives): do not require PK at byte 0.
    // Scan the final 4 KiB backwards first to hit standard EOCDs on stack memory before
    // falling back to the 128 KiB tail scan for archives with large trailing comments.
    let fast_len = len.min(FAST_TAIL_SCAN) as usize;
    file.seek(SeekFrom::Start(len - fast_len as u64))
        .map_err(|e| format!("Cannot seek archive tail: {e}"))?;
    let mut fast_buf = [0u8; FAST_TAIL_SCAN as usize];
    file.read_exact(&mut fast_buf[..fast_len])
        .map_err(|e| format!("Cannot read archive tail: {e}"))?;

    let mut found_eocd = tail_has_eocd(&fast_buf[..fast_len]);
    if !found_eocd && len > FAST_TAIL_SCAN {
        let tail_len = len.min(MAX_TAIL_SCAN) as usize;
        file.seek(SeekFrom::Start(len - tail_len as u64))
            .map_err(|e| format!("Cannot seek archive tail: {e}"))?;
        let mut tail_buf = vec![0u8; tail_len];
        file.read_exact(&mut tail_buf)
            .map_err(|e| format!("Cannot read archive tail: {e}"))?;
        found_eocd = tail_has_eocd(&tail_buf);
    }

    if !found_eocd {
        file.seek(SeekFrom::Start(0))
            .map_err(|e| format!("Cannot reset archive cursor: {e}"))?;
        let mut magic = [0u8; 4];
        if file.read_exact(&mut magic).is_ok() {
            let is_zip_magic = matches!(
                magic,
                [0x50, 0x4B, 0x03, 0x04] | [0x50, 0x4B, 0x05, 0x06] | [0x50, 0x4B, 0x07, 0x08]
            );
            if !is_zip_magic {
                return Err("Invalid ZIP archive: missing PK signature header".to_string());
            }
        }
        return Err("Invalid ZIP archive: End of Central Directory (EOCD) signature not found in archive tail".to_string());
    }

    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("Cannot reset archive cursor: {e}"))?;
    Ok(file)
}

pub(super) fn open_zip_archive(archive_path: &str) -> Result<ZipArchive, String> {
    let file = validate_zip_header(archive_path)?;
    zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("Invalid ZIP archive: {e}"))
}

pub(super) fn open_zip_archive_unchecked(archive_path: &str) -> Result<ZipArchive, String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Cannot open archive: {e}"))?;
    zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("Invalid ZIP archive: {e}"))
}

fn decode_zip_entry_name<R: Read + Seek>(entry: &zip::read::ZipFile<'_, R>) -> String {
    super::encoding::decode_cjk_name(entry.name_raw())
}

fn push_fallback_entry(
    archive_path: &str,
    name: &str,
    index: usize,
    index_map: &mut HashMap<String, usize>,
    files: &mut Vec<FileEntry>,
) {
    index_map.insert(name.to_string(), index);
    let normalized = name.replace('\\', "/");
    if normalized != name {
        index_map.insert(normalized, index);
    }
    let ext = name.rsplit('.').next().unwrap_or("");
    if is_image_ext(ext) || is_metadata_ext(ext) {
        files.push(FileEntry::new_archive_entry(
            name.to_string(),
            format!("{archive_path}|{name}"),
            ext.to_uppercase(),
            String::new(),
            0,
        ));
    }
}

pub(super) fn list_zip_entries(
    archive_path: &str,
    password: Option<&str>,
) -> Result<
    (
        Vec<FileEntry>,
        ZipArchive,
        HashMap<String, usize>,
        Option<ArchiveEncryptionStatus>,
    ),
    String,
> {
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

                let size = entry.size();
                files.push(FileEntry::new_archive_entry(
                    decoded_name.clone(),
                    format!("{}|{}", archive_path, decoded_name),
                    ext.to_uppercase(),
                    "".to_string(),
                    size,
                ));
            }
            Err(zip::result::ZipError::InvalidPassword) => {
                bad_password = true;
                push_fallback_entry(archive_path, name, i, &mut index_map, &mut files);
            }
            Err(zip::result::ZipError::UnsupportedArchive(err)) if err.contains("Password") => {
                has_encrypted = true;
                push_fallback_entry(archive_path, name, i, &mut index_map, &mut files);
            }
            Err(_) => {
                push_fallback_entry(archive_path, name, i, &mut index_map, &mut files);
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

    sort_archive_entries(&mut files);
    Ok((files, archive, index_map, encryption))
}

fn get_zip_entry_by_index<'a, R: Read + Seek>(
    archive: &'a mut zip::ZipArchive<R>,
    idx: usize,
    password: Option<&str>,
) -> zip::result::ZipResult<zip::read::ZipFile<'a, R>> {
    match password {
        Some(pwd) => archive.by_index_decrypt(idx, pwd.as_bytes()),
        None => archive.by_index(idx),
    }
}

fn get_zip_entry_by_name<'a, R: Read + Seek>(
    archive: &'a mut zip::ZipArchive<R>,
    name: &str,
    password: Option<&str>,
) -> zip::result::ZipResult<zip::read::ZipFile<'a, R>> {
    match password {
        Some(pwd) => archive.by_name_decrypt(name, pwd.as_bytes()),
        None => archive.by_name(name),
    }
}

pub(super) fn with_zip_entry_reader<R: Read + Seek, T>(
    archive: &mut zip::ZipArchive<R>,
    entry_name: &str,
    index_map: Option<&HashMap<String, usize>>,
    password: Option<&str>,
    f: impl FnOnce(&mut zip::read::ZipFile<'_, R>) -> Result<T, String>,
) -> Result<T, String> {
    if let Some(index) = index_map.and_then(|m| m.get(entry_name).copied()) {
        let mut entry = get_zip_entry_by_index(archive, index, password)
            .map_err(|e| format!("Error reading ZIP entry: {e}"))?;
        return f(&mut entry);
    }

    if let Ok(mut entry) = get_zip_entry_by_name(archive, entry_name, password) {
        return f(&mut entry);
    }

    let total = archive.len();
    for i in 0..total {
        if let Ok(mut entry) = get_zip_entry_by_index(archive, i, password) {
            if decode_zip_entry_name(&entry) == entry_name {
                return f(&mut entry);
            }
        }
    }

    Err(format!("Cannot find ZIP entry: {entry_name}"))
}

pub(super) fn read_zip_entry_by_decoded_name<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    entry_name: &str,
    index_map: Option<&HashMap<String, usize>>,
    password: Option<&str>,
) -> Result<Vec<u8>, String> {
    with_zip_entry_reader(archive, entry_name, index_map, password, |entry| {
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("Error reading entry: {e}"))?;
        Ok(buf)
    })
}

pub(super) fn read_zip_entry_header<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    entry_name: &str,
    limit: usize,
    index_map: Option<&HashMap<String, usize>>,
    password: Option<&str>,
) -> Result<Vec<u8>, String> {
    with_zip_entry_reader(archive, entry_name, index_map, password, |entry| {
        let mut buf = Vec::with_capacity(limit.min(entry.size() as usize));
        entry
            .take(limit as u64)
            .read_to_end(&mut buf)
            .map_err(|e| format!("Error reading ZIP entry header: {e}"))?;
        Ok(buf)
    })
}
