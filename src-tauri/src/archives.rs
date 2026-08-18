use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

use crate::models::FileEntry;
use crate::utils::{is_image_ext, is_metadata_ext};

// ── Archive cache (thread-safe) ──────────────────────────────────────────────
// Caches extracted bytes so we don't re-read the archive for every image.

pub struct SingleArchiveCache {
    pub zip_entries: HashMap<String, Vec<u8>>,
    pub zip_archive: Option<zip::ZipArchive<std::io::BufReader<std::fs::File>>>,
    pub extract_temp_dir: Option<PathBuf>,
    pub extract_notify: Arc<(Mutex<HashSet<String>>, Condvar)>,
}

pub struct ArchiveCache {
    pub archives: HashMap<String, SingleArchiveCache>,

    // Global LRU for ZIP entries: (archive_path, entry_name)
    pub global_zip_lru: VecDeque<(String, String)>,
    pub archive_lru: VecDeque<String>,

    pub global_zip_capacity_bytes: usize,
    pub current_zip_bytes: usize,
    pub max_open_archives: usize,
}

impl ArchiveCache {
    pub fn new(capacity_mb: usize) -> Self {
        Self {
            archives: HashMap::new(),
            global_zip_lru: VecDeque::new(),
            archive_lru: VecDeque::new(),
            global_zip_capacity_bytes: capacity_mb.saturating_mul(1024 * 1024),
            current_zip_bytes: 0,
            max_open_archives: 8,
        }
    }

    pub fn touch_archive(&mut self, archive_path: &str) {
        self.archive_lru.retain(|p| p != archive_path);
        self.archive_lru.push_back(archive_path.to_string());
    }

    fn touch_zip_entry(&mut self, archive_path: &str, entry_name: &str) {
        let key = (archive_path.to_string(), entry_name.to_string());
        self.global_zip_lru.retain(|existing| existing != &key);
        self.global_zip_lru.push_back(key);
        self.touch_archive(archive_path);
    }

    fn remove_archive_zip_entries(&mut self, archive_path: &str) {
        if let Some(single) = self.archives.get_mut(archive_path) {
            for data in single.zip_entries.drain().map(|(_, data)| data) {
                self.current_zip_bytes = self.current_zip_bytes.saturating_sub(data.len());
            }
        }
        self.global_zip_lru.retain(|(path, _)| path != archive_path);
    }

    fn evict_idle_archives(&mut self, keep_path: &str) {
        while self.archives.len() > self.max_open_archives {
            let Some(old_archive) = self.archive_lru.pop_front() else {
                break;
            };
            if old_archive == keep_path {
                self.archive_lru.push_back(old_archive);
                continue;
            }
            self.remove_archive_zip_entries(&old_archive);
            self.archives.remove(&old_archive);
        }
    }

    // Evict the least-recently-used (archive, entry) pairs until the incoming
    // entry fits within the byte budget. A single entry larger than the whole
    // budget still wins (the LRU drains but the requested image must be
    // viewable rather than 404-ing).
    fn evict_until_within_budget(&mut self, incoming_bytes: usize) {
        while self.current_zip_bytes + incoming_bytes > self.global_zip_capacity_bytes {
            let Some((old_archive, old_entry)) = self.global_zip_lru.pop_front() else {
                break;
            };
            let removed = self
                .archives
                .get_mut(&old_archive)
                .and_then(|s| s.zip_entries.remove(&old_entry))
                .map(|d| d.len())
                .unwrap_or(0);
            self.current_zip_bytes = self.current_zip_bytes.saturating_sub(removed);
        }
    }

    pub fn register_archive(&mut self, archive_path: String, archive: SingleArchiveCache) {
        self.archives.insert(archive_path.clone(), archive);
        self.touch_archive(&archive_path);
        self.evict_idle_archives(&archive_path);
    }

    pub fn get_zip_entry(&mut self, archive_path: &str, entry_name: &str) -> Option<Vec<u8>> {
        let data = self
            .archives
            .get(archive_path)?
            .zip_entries
            .get(entry_name)?
            .clone();
        self.touch_zip_entry(archive_path, entry_name);
        Some(data)
    }

    // Cache `data` under (archive_path, entry_name), enforcing the global byte
    // budget. Existing entries are only touched, so a read-hot page remains hot.
    pub fn insert_zip_entry(&mut self, archive_path: &str, entry_name: &str, data: Vec<u8>) {
        let Some(single) = self.archives.get(archive_path) else {
            return;
        };
        if single.zip_entries.contains_key(entry_name) {
            self.touch_zip_entry(archive_path, entry_name);
            return;
        }

        self.evict_until_within_budget(data.len());
        if let Some(single) = self.archives.get_mut(archive_path) {
            self.current_zip_bytes += data.len();
            single.zip_entries.insert(entry_name.to_string(), data);
            self.touch_zip_entry(archive_path, entry_name);
        }
    }
}

impl Drop for SingleArchiveCache {
    fn drop(&mut self) {
        if let Some(dir) = &self.extract_temp_dir {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

pub fn archive_entry_temp_path(temp_dir: &Path, entry_name: &str) -> Option<PathBuf> {
    let normalized = entry_name.replace('\\', "/");
    let mut relative = PathBuf::new();

    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }

    if relative.as_os_str().is_empty() {
        return None;
    }

    Some(temp_dir.join(relative))
}

fn write_temp_entry(
    temp_dir: &Path,
    entry_name: &str,
    write: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Option<PathBuf> {
    let out_path = archive_entry_temp_path(temp_dir, entry_name)?;
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent).ok()?;
    }

    let file_name = out_path.file_name()?.to_string_lossy();
    let tmp_path = out_path.with_file_name(format!("{file_name}.tmp"));
    write(&tmp_path).ok()?;
    fs::rename(&tmp_path, &out_path).ok()?;
    Some(out_path)
}

fn notify_extracted(notify: &Arc<(Mutex<HashSet<String>>, Condvar)>, entry_name: &str) {
    let (lock, cvar) = &**notify;
    let mut set = lock.lock().unwrap();
    set.insert(entry_name.to_string());
    cvar.notify_all();
}

// ── ZIP reading ──────────────────────────────────────────────────────────────

/// Decodes a ZIP entry name, handling legacy Shift-JIS encoding.
///
/// ZIP archives created on Japanese Windows systems often use Shift-JIS (CP932)
/// encoding for filenames without setting the UTF-8 flag (bit 11 in the general
/// purpose bit flag). The `zip` crate's `.name()` method returns a UTF-8 string,
/// but when the original bytes are Shift-JIS, this produces mojibake (garbled text).
///
/// This function detects when `.name()` contains replacement characters (�, U+FFFD)
/// and attempts to re-decode the raw filename bytes as Shift-JIS.
fn decode_zip_entry_name<R: std::io::Read + std::io::Seek>(
    entry: &zip::read::ZipFile<'_, R>,
) -> String {
    let name = entry.name();

    // Fast path: if the name is valid UTF-8 without replacement characters, use it directly
    if !name.contains('\u{FFFD}') {
        return name.to_string();
    }

    // Slow path: the name contains replacement characters, likely due to non-UTF-8 encoding
    let raw_bytes = entry.name_raw();

    // Try Shift-JIS (Japanese)
    let (decoded, _, had_errors) = encoding_rs::SHIFT_JIS.decode(raw_bytes);
    if !had_errors {
        return decoded.into_owned();
    }

    // Try GB18030 (Chinese)
    let (decoded, _, had_errors) = encoding_rs::GB18030.decode(raw_bytes);
    if !had_errors {
        return decoded.into_owned();
    }

    // Try EUC-KR (Korean)
    let (decoded, _, had_errors) = encoding_rs::EUC_KR.decode(raw_bytes);
    if !had_errors {
        return decoded.into_owned();
    }

    // Fallback: return the mojibake name as-is
    name.to_string()
}

pub fn list_zip_entries(archive_path: &str) -> Result<Vec<FileEntry>, String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Cannot open archive: {e}"))?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("Invalid ZIP archive: {e}"))?;

    // First pass: collect all entry names from the central directory.
    // This allows us to list corrupt entries even when their local headers are invalid.
    let all_names: Vec<String> = archive.file_names().map(|s| s.to_string()).collect();

    let mut files = Vec::new();
    let mut skipped_count = 0;

    for (i, name) in all_names.iter().enumerate() {
        // Try to read the entry to check if it's accessible
        match archive.by_index(i) {
            Ok(entry) => {
                let decoded_name = decode_zip_entry_name(&entry);
                if entry.is_dir() {
                    continue;
                }
                let ext = decoded_name.rsplit('.').next().unwrap_or("").to_lowercase();
                if !is_image_ext(&ext) && !is_metadata_ext(&ext) {
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
                // Entry has a corrupt local file header but exists in central directory.
                // List it anyway so users see it exists (will show "Failed to load" in UI).
                let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
                if is_image_ext(&ext) || is_metadata_ext(&ext) {
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
    Ok(files)
}

pub fn read_zip_entry_by_decoded_name<R: std::io::Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
    entry_name: &str,
) -> Result<Vec<u8>, String> {
    // Try direct lookup first (handles UTF-8 encoded ZIPs)
    if let Ok(mut entry) = archive.by_name(entry_name) {
        let mut buf = Vec::with_capacity(entry.size() as usize);
        if std::io::Read::read_to_end(&mut entry, &mut buf).is_ok() {
            return Ok(buf);
        }
    }

    // Fallback: scan all entries and match by decoded name (handles Shift-JIS/GBK/EUC-KR ZIPs)
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

    // Then extract by index if found
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

pub fn extract_zip_entry(archive_path: &str, entry_name: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Cannot open archive: {e}"))?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("Invalid ZIP archive: {e}"))?;
    read_zip_entry_by_decoded_name(&mut archive, entry_name)
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
                    if is_image_ext(&ext) || is_metadata_ext(&ext) {
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

pub fn extract_rar_to_temp(
    archive_path: String,
    temp_dir: PathBuf,
    notify: Arc<(Mutex<HashSet<String>>, Condvar)>,
) {
    if let Ok(archive) = unrar::Archive::new(&archive_path).open_for_processing() {
        let mut iter = archive;
        loop {
            match iter.read_header() {
                Ok(Some(header)) => {
                    let entry = header.entry();
                    let name = entry.filename.to_string_lossy().to_string();
                    if !entry.is_directory() {
                        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
                        if is_image_ext(&ext) || is_metadata_ext(&ext) {
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

pub fn extract_7z_to_temp(
    archive_path: String,
    temp_dir: PathBuf,
    notify: Arc<(Mutex<HashSet<String>>, Condvar)>,
) {
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
        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        if !is_image_ext(&ext) && !is_metadata_ext(&ext) {
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

// ── TAR reading ─────────────────────────────────────────────────────────────
// TAR is uncompressed, but random image navigation still pays for repeated
// archive scans. Extracting images to the same temp-dir pipeline as RAR/7Z
// keeps active page serving on ordinary file reads after the background pass.

pub fn list_tar_entries(archive_path: &str) -> Result<Vec<FileEntry>, String> {
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
        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        if !is_image_ext(&ext) && !is_metadata_ext(&ext) {
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

pub fn extract_tar_entry(archive_path: &str, entry_name: &str) -> Result<Vec<u8>, String> {
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

pub fn extract_tar_to_temp(
    archive_path: String,
    temp_dir: PathBuf,
    notify: Arc<(Mutex<HashSet<String>>, Condvar)>,
) {
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

        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        if !is_image_ext(&ext) && !is_metadata_ext(&ext) {
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
