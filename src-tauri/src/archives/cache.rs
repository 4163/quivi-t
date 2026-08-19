use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

pub(crate) type ZipArchive = zip::ZipArchive<std::io::BufReader<std::fs::File>>;
pub(crate) type ExtractNotify = Arc<(Mutex<HashSet<String>>, Condvar)>;

pub(crate) struct SingleArchiveCache {
    zip_entries: HashMap<String, Vec<u8>>,
    zip_archive: Option<ZipArchive>,
    extract_temp_dir: Option<PathBuf>,
    extract_notify: ExtractNotify,
}

impl SingleArchiveCache {
    pub(crate) fn with_zip_archive(zip_archive: Option<ZipArchive>) -> Self {
        Self {
            zip_entries: HashMap::new(),
            zip_archive,
            extract_temp_dir: None,
            extract_notify: Arc::new((Mutex::new(HashSet::new()), Condvar::new())),
        }
    }

    pub(crate) fn with_temp_dir(extract_temp_dir: PathBuf) -> Self {
        Self {
            zip_entries: HashMap::new(),
            zip_archive: None,
            extract_temp_dir: Some(extract_temp_dir),
            extract_notify: Arc::new((Mutex::new(HashSet::new()), Condvar::new())),
        }
    }

    pub(crate) fn notify(&self) -> ExtractNotify {
        self.extract_notify.clone()
    }
}

impl Drop for SingleArchiveCache {
    fn drop(&mut self) {
        if let Some(dir) = &self.extract_temp_dir {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

pub struct ArchiveCache {
    archives: HashMap<String, SingleArchiveCache>,
    global_zip_lru: VecDeque<(String, String)>,
    archive_lru: VecDeque<String>,
    global_zip_capacity_bytes: usize,
    current_zip_bytes: usize,
    max_open_archives: usize,
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

    pub(crate) fn contains_archive(&self, archive_path: &str) -> bool {
        self.archives.contains_key(archive_path)
    }

    pub(crate) fn touch_archive(&mut self, archive_path: &str) {
        self.archive_lru.retain(|p| p != archive_path);
        self.archive_lru.push_back(archive_path.to_string());
    }

    pub(crate) fn read_from_open_zip(
        &mut self,
        archive_path: &str,
        entry_name: &str,
    ) -> Option<Vec<u8>> {
        self.archives
            .get_mut(archive_path)?
            .zip_archive
            .as_mut()
            .and_then(|archive| {
                crate::archives::zip::read_zip_entry_by_decoded_name(archive, entry_name).ok()
            })
    }

    pub(crate) fn temp_extraction_state(
        &self,
        archive_path: &str,
    ) -> Option<(PathBuf, ExtractNotify)> {
        let single = self.archives.get(archive_path)?;
        Some((
            single.extract_temp_dir.clone()?,
            single.extract_notify.clone(),
        ))
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

    pub(crate) fn register_archive(&mut self, archive_path: String, archive: SingleArchiveCache) {
        self.archives.insert(archive_path.clone(), archive);
        self.touch_archive(&archive_path);
        self.evict_idle_archives(&archive_path);
    }

    pub(crate) fn get_zip_entry(
        &mut self,
        archive_path: &str,
        entry_name: &str,
    ) -> Option<Vec<u8>> {
        let data = self
            .archives
            .get(archive_path)?
            .zip_entries
            .get(entry_name)?
            .clone();
        self.touch_zip_entry(archive_path, entry_name);
        Some(data)
    }

    pub(crate) fn insert_zip_entry(&mut self, archive_path: &str, entry_name: &str, data: Vec<u8>) {
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

    #[cfg(test)]
    pub(crate) fn register_test_archive(&mut self, archive_path: &str) {
        self.register_archive(
            archive_path.to_string(),
            SingleArchiveCache::with_zip_archive(None),
        );
    }

    #[cfg(test)]
    pub(crate) fn open_archive_count(&self) -> usize {
        self.archives.len()
    }

    #[cfg(test)]
    pub(crate) fn set_max_open_archives(&mut self, max_open_archives: usize) {
        self.max_open_archives = max_open_archives;
    }

    #[cfg(test)]
    pub(crate) fn current_zip_bytes(&self) -> usize {
        self.current_zip_bytes
    }

    #[cfg(test)]
    pub(crate) fn contains_zip_entry(&self, archive_path: &str, entry_name: &str) -> bool {
        self.archives
            .get(archive_path)
            .map(|single| single.zip_entries.contains_key(entry_name))
            .unwrap_or(false)
    }
}

pub(crate) fn archive_temp_dir(archive_path: &str) -> PathBuf {
    let hash = format!("{:x}", md5::compute(archive_path));
    std::env::temp_dir().join("QuiviT").join(hash)
}

pub(crate) fn archive_entry_temp_path(temp_dir: &Path, entry_name: &str) -> Option<PathBuf> {
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

// Called by rar.rs, sevenz.rs, and tar.rs extractors to atomically write
// each decompressed entry to the temp directory via a .tmp rename.
pub(crate) fn write_temp_entry(
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

// Called by rar.rs, sevenz.rs, and tar.rs extractors after each entry is
// written, waking any protocol/IPC thread waiting on that file.
pub(crate) fn notify_extracted(notify: &ExtractNotify, entry_name: &str) {
    let (lock, cvar) = &**notify;
    let mut set = lock.lock().unwrap();
    set.insert(entry_name.to_string());
    cvar.notify_all();
}
