use std::fs;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::formats::{is_image_ext, is_metadata_ext};
use crate::models::{ArchiveEncryptionStatus, FileEntry};

use super::cache::{notify_extracted, write_temp_entry, ExtractNotify, FinishGuard};
use super::sort_archive_entries;

pub(super) fn validate_7z_header(archive_path: &str) -> Result<(), String> {
    use std::io::Read;

    let mut file = fs::File::open(archive_path).map_err(|e| format!("Cannot open archive: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("Cannot read archive metadata: {e}"))?
        .len();

    if len < 32 {
        return Err(
            "Invalid 7Z archive: file is smaller than minimum 7Z header (32 bytes)".to_string(),
        );
    }

    let mut header = [0u8; 32];
    file.read_exact(&mut header)
        .map_err(|e| format!("Cannot read 7Z signature: {e}"))?;

    if header[0..6] != [0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C] {
        return Err("Invalid 7Z archive: missing 7Z signature header".to_string());
    }

    let next_header_offset = u64::from_le_bytes(header[12..20].try_into().unwrap());
    let next_header_size = u64::from_le_bytes(header[20..28].try_into().unwrap());

    if let Some(end) = 32u64
        .checked_add(next_header_offset)
        .and_then(|h| h.checked_add(next_header_size))
    {
        if end > len {
            return Err("Invalid 7Z archive: truncated archive header".to_string());
        }
    } else {
        return Err("Invalid 7Z archive: invalid header offset/size calculation".to_string());
    }

    Ok(())
}

pub(super) fn list_7z_entries(
    archive_path: &str,
    password: Option<&str>,
) -> Result<(Vec<FileEntry>, Option<ArchiveEncryptionStatus>), String> {
    validate_7z_header(archive_path)?;

    let pwd = password
        .map(sevenz_rust2::Password::from)
        .unwrap_or_else(sevenz_rust2::Password::empty);

    let mut reader = match sevenz_rust2::ArchiveReader::open(archive_path, pwd) {
        Ok(r) => r,
        Err(sevenz_rust2::Error::PasswordRequired) => {
            return Ok((Vec::new(), Some(ArchiveEncryptionStatus::PasswordRequired)));
        }
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
            return Err(format!("Cannot open 7z archive: {e}"));
        }
    };

    let (is_enc, mut files) = {
        let archive = reader.archive();

        let is_enc = archive.blocks.iter().any(|b| {
            b.coders
                .iter()
                .any(|c| c.encoder_method_id() == [0x06, 0xf1, 0x07, 0x01])
        });

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

            let size = entry.size();
            files.push(FileEntry::new_archive_entry(
                name.clone(),
                format!("{}|{}", archive_path, name),
                ext.to_uppercase(),
                "".to_string(),
                size,
            ));
        }

        (is_enc, files)
    };

    sort_archive_entries(&mut files);

    let encryption = if is_enc {
        if password.is_none() {
            Some(ArchiveEncryptionStatus::PasswordRequired)
        } else {
            let mut bad_pass = false;
            let _ = reader.for_each_entries(|_e, d| {
                let mut sink = std::io::sink();
                if std::io::copy(d, &mut sink).is_err() {
                    bad_pass = true;
                }
                Ok(false)
            });
            if bad_pass {
                Some(ArchiveEncryptionStatus::PasswordIncorrect)
            } else {
                None
            }
        }
    } else {
        None
    };

    Ok((files, encryption))
}

pub(super) fn extract_7z_to_temp(
    archive_path: String,
    temp_dir: PathBuf,
    notify: ExtractNotify,
    cancel_flag: Arc<AtomicBool>,
    password: Option<String>,
) {
    let _finish_guard = FinishGuard(&notify);
    if validate_7z_header(&archive_path).is_err() {
        return;
    }
    let pwd = password
        .as_deref()
        .map(sevenz_rust2::Password::from)
        .unwrap_or_else(sevenz_rust2::Password::empty);
    let Ok(mut reader) = sevenz_rust2::ArchiveReader::open(&archive_path, pwd) else {
        return;
    };
    let _ = reader.for_each_entries(|entry, data| {
        if cancel_flag.load(Ordering::Acquire) {
            return Ok(false);
        }
        if entry.is_directory() || entry.is_anti_item() {
            return Ok(true);
        }
        let name = entry.name().to_string();
        let ext = name.rsplit('.').next().unwrap_or("");
        if !is_image_ext(ext) && !is_metadata_ext(ext) {
            return Ok(true);
        }
        if write_temp_entry(&temp_dir, &name, &cancel_flag, |path| {
            let file = fs::File::create(path)?;
            let mut writer = BufWriter::new(file);
            std::io::copy(data, &mut writer)?;
            writer.flush()?;
            Ok(())
        })
        .is_some()
        {
            notify_extracted(&notify, &name);
        }
        Ok(true)
    });
}
