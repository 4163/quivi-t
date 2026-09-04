use std::fs;
use std::path::PathBuf;

use crate::formats::{is_image_ext, is_metadata_ext};
use crate::models::{ArchiveEncryptionStatus, FileEntry};

use super::cache::{notify_extracted, write_temp_entry, ExtractNotify, FinishGuard};

pub(crate) fn validate_rar_header(archive_path: &str) -> Result<(), String> {
    use std::io::Read;

    let mut file = fs::File::open(archive_path).map_err(|e| format!("Cannot open archive: {e}"))?;
    let len = file.metadata().map_err(|e| format!("Cannot read archive metadata: {e}"))?.len();

    if len < 14 {
        return Err("Invalid RAR archive: file is smaller than minimum RAR header (14 bytes)".to_string());
    }

    let mut magic = [0u8; 7];
    file.read_exact(&mut magic).map_err(|e| format!("Cannot read RAR signature: {e}"))?;

    if magic[0..6] != [0x52, 0x61, 0x72, 0x21, 0x1A, 0x07] || (magic[6] != 0x00 && magic[6] != 0x01) {
        return Err("Invalid RAR archive: missing RAR signature header".to_string());
    }

    Ok(())
}

pub(crate) fn list_rar_entries(
    archive_path: &str,
    password: Option<&str>,
) -> Result<(Vec<FileEntry>, Option<ArchiveEncryptionStatus>), String> {
    validate_rar_header(archive_path)?;

    let builder = match password {
        Some(pwd) => unrar::Archive::with_password(archive_path, pwd.as_bytes()),
        None => unrar::Archive::new(archive_path),
    };

    let archive = match builder.open_for_processing() {
        Ok(a) => a,
        Err(e) => {
            let msg = e.to_string();
            let msg_lower = msg.to_lowercase();
            if msg_lower.contains("password") {
                let status = if password.is_some() {
                    ArchiveEncryptionStatus::PasswordIncorrect
                } else {
                    ArchiveEncryptionStatus::PasswordRequired
                };
                return Ok((Vec::new(), Some(status)));
            }
            return Err(format!("Cannot open RAR archive: {e}"));
        }
    };

    let mut iter = archive;
    let mut files = Vec::new();
    let mut encryption = None;
    let mut tested_password = false;

    loop {
        match iter.read_header() {
            Ok(Some(header)) => {
                let entry = header.entry();
                let is_enc = entry.is_encrypted();
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

                if is_enc {
                    if password.is_none() {
                        encryption = Some(ArchiveEncryptionStatus::PasswordRequired);
                        iter = header.skip().map_err(|e| e.to_string())?;
                    } else if !tested_password {
                        tested_password = true;
                        match header.test() {
                            Ok(next_iter) => {
                                iter = next_iter;
                            }
                            Err(e) => {
                                let msg = e.to_string();
                                let msg_lower = msg.to_lowercase();
                                if msg_lower.contains("password") {
                                    encryption = Some(ArchiveEncryptionStatus::PasswordIncorrect);
                                    break;
                                }
                                return Err(format!("Error testing RAR entry: {e}"));
                            }
                        }
                    } else {
                        iter = header.skip().map_err(|e| e.to_string())?;
                    }
                } else {
                    iter = header.skip().map_err(|e| e.to_string())?;
                }
            }
            Ok(None) => break,
            Err(e) => {
                let msg = e.to_string();
                let msg_lower = msg.to_lowercase();
                if msg_lower.contains("password") {
                    let status = if password.is_some() {
                        ArchiveEncryptionStatus::PasswordIncorrect
                    } else {
                        ArchiveEncryptionStatus::PasswordRequired
                    };
                    return Ok((files, Some(status)));
                }
                return Err(format!("Error iterating RAR archive: {e}"));
            }
        }
    }
    files.sort_by(|a, b| natord::compare(&a.name, &b.name));
    Ok((files, encryption))
}

pub(crate) fn extract_rar_to_temp(
    archive_path: String,
    temp_dir: PathBuf,
    notify: ExtractNotify,
    cancel_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    password: Option<String>,
) {
    let _finish_guard = FinishGuard(&notify);
    if validate_rar_header(&archive_path).is_err() {
        return;
    }
    let builder = match password.as_deref() {
        Some(pwd) => unrar::Archive::with_password(&archive_path, pwd.as_bytes()),
        None => unrar::Archive::new(&archive_path),
    };

    let Ok(archive) = builder.open_for_processing() else {
        return;
    };
    let mut iter = archive;
        loop {
            if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
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
