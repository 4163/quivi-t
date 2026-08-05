use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Condvar};

use crate::utils::is_image_ext;
use crate::models::FileEntry;

// ── Archive cache (thread-safe) ──────────────────────────────────────────────
// Caches extracted bytes so we don't re-read the archive for every image.

pub struct ArchiveCache {
    pub active_path: Option<String>,
    pub zip_entries: HashMap<String, Vec<u8>>,
    pub zip_lru: VecDeque<String>,
    pub zip_capacity: usize,
    pub extract_temp_dir: Option<PathBuf>,
    pub zip_archive: Option<zip::ZipArchive<std::fs::File>>,
    pub extract_notify: Arc<(Mutex<HashSet<String>>, Condvar)>,
}

impl ArchiveCache {
    pub fn new() -> Self {
        Self {
            active_path: None,
            zip_entries: HashMap::new(),
            zip_lru: VecDeque::new(),
            zip_capacity: 20, // Keep 20 images in RAM
            extract_temp_dir: None,
            zip_archive: None,
            extract_notify: Arc::new((Mutex::new(HashSet::new()), Condvar::new())),
        }
    }
}

// ── ZIP reading ──────────────────────────────────────────────────────────────

pub fn list_zip_entries(archive_path: &str) -> Result<Vec<FileEntry>, String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Cannot open archive: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid ZIP archive: {e}"))?;
    let mut files = Vec::new();

    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("Error reading ZIP entry: {e}"))?;
        let name = entry.name().to_string();
        if entry.is_dir() { continue; }
        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        if !is_image_ext(&ext) { continue; }

        files.push(FileEntry {
            name: name.clone(),
            path: format!("{}|{}", archive_path, name),
            ext: ext.to_uppercase(),
            date: "".to_string(),
            is_dir: false,
            is_hidden: false,
        });
    }
    
    files.sort_by(|a, b| natord::compare(&a.name, &b.name));
    Ok(files)
}

pub fn extract_zip_entry(archive_path: &str, entry_name: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Cannot open archive: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid ZIP archive: {e}"))?;
    
    let mut entry = archive.by_name(entry_name).map_err(|e| format!("Cannot find ZIP entry {}: {}", entry_name, e))?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    std::io::Read::read_to_end(&mut entry, &mut buf).map_err(|e| format!("Error reading entry: {e}"))?;
    Ok(buf)
}

// ── RAR reading ──────────────────────────────────────────────────────────────

pub fn list_rar_entries(archive_path: &str) -> Result<Vec<FileEntry>, String> {
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
                    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
                    if is_image_ext(&ext) {
                        files.push(FileEntry {
                            name: name.clone(),
                            path: format!("{}|{}", archive_path, name),
                            ext: ext.to_uppercase(),
                            date: "".to_string(),
                            is_dir: false,
                            is_hidden: false,
                        });
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

pub fn extract_rar_to_temp(archive_path: String, temp_dir: PathBuf, notify: Arc<(Mutex<HashSet<String>>, Condvar)>) {
    if let Ok(archive) = unrar::Archive::new(&archive_path).open_for_processing() {
        let mut iter = archive;
        loop {
            match iter.read_header() {
                Ok(Some(header)) => {
                    let entry = header.entry();
                    let name = entry.filename.to_string_lossy().to_string();
                    if !entry.is_directory() {
                        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
                        if is_image_ext(&ext) {
                            if let Ok((data, next)) = header.read() {
                                let safe_name = name.replace('\\', "/");
                                let out_path = temp_dir.join(&safe_name);
                                if let Some(parent) = out_path.parent() {
                                    fs::create_dir_all(parent).ok();
                                }
                                let tmp_path = temp_dir.join(format!("{}.tmp", safe_name));
                                if fs::write(&tmp_path, &data).is_ok() {
                                    if fs::rename(&tmp_path, &out_path).is_ok() {
                                        let (lock, cvar) = &*notify;
                                        let mut set = lock.lock().unwrap();
                                        set.insert(name.clone());
                                        cvar.notify_all();
                                    }
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

// ── 7z reading ──────────────────────────────────────────────────────────────
// Solid 7z archives (single compression block, as commonly produced) cannot do
// random access — decompressing any entry requires decompressing everything
// before it. Listing only parses the header, but serving individual entries
// goes through the same sequential temp-dir pipeline as RAR.

pub fn list_7z_entries(archive_path: &str) -> Result<Vec<FileEntry>, String> {
    let reader = sevenz_rust2::ArchiveReader::open(archive_path, sevenz_rust2::Password::empty())
        .map_err(|e| format!("Cannot open 7z archive: {e}"))?;
    let archive = reader.archive();

    let mut files = Vec::new();
    for entry in &archive.files {
        if entry.is_directory() || entry.is_anti_item() {
            continue;
        }
        let name = entry.name().to_string();
        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        if !is_image_ext(&ext) {
            continue;
        }

        files.push(FileEntry {
            name: name.clone(),
            path: format!("{}|{}", archive_path, name),
            ext: ext.to_uppercase(),
            date: "".to_string(),
            is_dir: false,
            is_hidden: false,
        });
    }

    files.sort_by(|a, b| natord::compare(&a.name, &b.name));
    Ok(files)
}

pub fn extract_7z_to_temp(archive_path: String, temp_dir: PathBuf, notify: Arc<(Mutex<HashSet<String>>, Condvar)>) {
    let Ok(mut reader) = sevenz_rust2::ArchiveReader::open(&archive_path, sevenz_rust2::Password::empty()) else {
        return;
    };
    let _ = reader.for_each_entries(|entry, data| {
        if entry.is_directory() || entry.is_anti_item() {
            return Ok(true);
        }
        let name = entry.name().to_string();
        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        if !is_image_ext(&ext) {
            return Ok(true);
        }
        let safe_name = name.replace('\\', "/");
        let out_path = temp_dir.join(&safe_name);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).ok();
        }
        let tmp_path = temp_dir.join(format!("{}.tmp", safe_name));
        if let Ok(mut file) = fs::File::create(&tmp_path) {
            if std::io::copy(data, &mut file).is_ok() {
                drop(file);
                if fs::rename(&tmp_path, &out_path).is_ok() {
                    let (lock, cvar) = &*notify;
                    let mut set = lock.lock().unwrap();
                    set.insert(name.clone());
                    cvar.notify_all();
                }
            }
        }
        Ok(true)
    });
}

// ── TAR reading ─────────────────────────────────────────────────────────────
// TAR is uncompressed with seekable entries, so individual files can be read
// on demand with no temp extraction and no in-memory cache.

pub fn list_tar_entries(archive_path: &str) -> Result<Vec<FileEntry>, String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Cannot open TAR archive: {e}"))?;
    let mut archive = tar::Archive::new(file);

    let mut files = Vec::new();
    let entries = archive.entries().map_err(|e| format!("Cannot read TAR entries: {e}"))?;
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
        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        if !is_image_ext(&ext) {
            continue;
        }

        files.push(FileEntry {
            name: name.clone(),
            path: format!("{}|{}", archive_path, name),
            ext: ext.to_uppercase(),
            date: "".to_string(),
            is_dir: false,
            is_hidden: false,
        });
    }

    files.sort_by(|a, b| natord::compare(&a.name, &b.name));
    Ok(files)
}

pub fn extract_tar_entry(archive_path: &str, entry_name: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Cannot open TAR archive: {e}"))?;
    let mut archive = tar::Archive::new(file);
    let entries = archive.entries().map_err(|e| format!("Cannot read TAR entries: {e}"))?;

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
