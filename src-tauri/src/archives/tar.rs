use std::fs;
use std::path::PathBuf;

use crate::formats::{is_image_ext, is_metadata_ext};
use crate::models::FileEntry;

use super::cache::{notify_extracted, write_temp_entry, ExtractNotify, FinishGuard};
use super::decode_cjk_name;

fn decode_tar_name<R: std::io::Read>(entry: &tar::Entry<'_, R>) -> String {
    decode_cjk_name(&entry.path_bytes()).replace('\\', "/")
}

pub(crate) fn validate_tar_header(archive_path: &str) -> Result<fs::File, String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = fs::File::open(archive_path).map_err(|e| format!("Cannot open TAR archive: {e}"))?;
    let len = file.metadata().map_err(|e| format!("Cannot read TAR metadata: {e}"))?.len();

    if len < 512 {
        return Err("Invalid TAR archive: file is smaller than minimum TAR block (512 bytes)".to_string());
    }

    let mut block = [0u8; 512];
    file.read_exact(&mut block).map_err(|e| format!("Cannot read TAR header block: {e}"))?;

    if block.iter().all(|&b| b == 0) {
        file.seek(SeekFrom::Start(0)).map_err(|e| format!("Cannot reset TAR cursor: {e}"))?;
        return Ok(file);
    }

    if &block[257..262] == b"ustar" {
        file.seek(SeekFrom::Start(0)).map_err(|e| format!("Cannot reset TAR cursor: {e}"))?;
        return Ok(file);
    }

    let mut sum: u32 = 0;
    for (i, &byte) in block.iter().enumerate() {
        if (148..156).contains(&i) {
            sum += 0x20;
        } else {
            sum += byte as u32;
        }
    }

    let chksum_str = std::str::from_utf8(&block[148..156])
        .unwrap_or("")
        .trim_matches(|c: char| c.is_whitespace() || c == '\0');
    let expected_sum = u32::from_str_radix(chksum_str, 8).unwrap_or(0);

    if expected_sum == 0 || sum != expected_sum {
        return Err("Invalid TAR archive: invalid header checksum".to_string());
    }

    file.seek(SeekFrom::Start(0)).map_err(|e| format!("Cannot reset TAR cursor: {e}"))?;
    Ok(file)
}

pub(crate) fn list_tar_entries(archive_path: &str) -> Result<Vec<FileEntry>, String> {
    let file = validate_tar_header(archive_path)?;
    let mut archive = tar::Archive::new(file);

    let mut files = Vec::new();
    let entries = archive
        .entries()
        .map_err(|e| format!("Cannot read TAR entries: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Error reading TAR entry: {e}"))?;
        let name = decode_tar_name(&entry);
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
    let file = validate_tar_header(archive_path)?;
    let mut archive = tar::Archive::new(file);
    let entries = archive
        .entries()
        .map_err(|e| format!("Cannot read TAR entries: {e}"))?;

    for entry in entries {
        let mut entry = entry.map_err(|e| format!("Error reading TAR entry: {e}"))?;
        let name = decode_tar_name(&entry);
        if name == entry_name {
            let mut buf = Vec::with_capacity(entry.size() as usize);
            std::io::Read::read_to_end(&mut entry, &mut buf)
                .map_err(|e| format!("Error reading TAR entry {entry_name}: {e}"))?;
            return Ok(buf);
        }
    }

    Err(format!("Cannot find TAR entry {}", entry_name))
}

pub(crate) fn extract_tar_to_temp(
    archive_path: String,
    temp_dir: PathBuf,
    notify: ExtractNotify,
    cancel_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    let _finish_guard = FinishGuard(&notify);
    let Ok(file) = validate_tar_header(&archive_path) else {
        return;
    };
    let mut archive = tar::Archive::new(file);
    let Ok(entries) = archive.entries() else {
        return;
    };

    for entry in entries {
        if cancel_flag.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        let Ok(mut entry) = entry else {
            continue;
        };
        let name = decode_tar_name(&entry);
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
