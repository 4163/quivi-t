use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

#[derive(Default)]
pub struct ExtractState {
    pub extracted: HashSet<String>,
    pub finished: bool,
}

pub(crate) type ZipArchive = zip::ZipArchive<std::io::BufReader<std::fs::File>>;
pub(crate) type ExtractNotify = Arc<(Mutex<ExtractState>, Condvar)>;
pub(crate) type SharedEntryBytes = Arc<[u8]>;

pub(crate) fn new_extract_notify() -> ExtractNotify {
    Arc::new((Mutex::new(ExtractState::default()), Condvar::new()))
}

pub(crate) struct SingleArchiveCache {
    zip_entries: HashMap<String, SharedEntryBytes>,
    zip_archive: Option<ZipArchive>,
    zip_index_map: Option<HashMap<String, usize>>,
    password: Option<String>,
    encryption: Option<crate::models::ArchiveEncryptionStatus>,
    extract_temp_dir: Option<PathBuf>,
    extract_notify: ExtractNotify,
    extract_cancel: Arc<std::sync::atomic::AtomicBool>,
}

impl SingleArchiveCache {
    pub(crate) fn with_zip_archive(
        zip_archive: Option<ZipArchive>,
        zip_index_map: Option<HashMap<String, usize>>,
        password: Option<String>,
        encryption: Option<crate::models::ArchiveEncryptionStatus>,
    ) -> Self {
        Self {
            zip_entries: HashMap::new(),
            zip_archive,
            zip_index_map,
            password,
            encryption,
            extract_temp_dir: None,
            extract_notify: new_extract_notify(),
            extract_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub(crate) fn with_temp_dir(
        extract_temp_dir: PathBuf,
        password: Option<String>,
        encryption: Option<crate::models::ArchiveEncryptionStatus>,
    ) -> Self {
        Self {
            zip_entries: HashMap::new(),
            zip_archive: None,
            zip_index_map: None,
            password,
            encryption,
            extract_temp_dir: Some(extract_temp_dir),
            extract_notify: new_extract_notify(),
            extract_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    pub(crate) fn is_password_required(&self) -> bool {
        matches!(
            self.encryption,
            Some(crate::models::ArchiveEncryptionStatus::PasswordRequired)
                | Some(crate::models::ArchiveEncryptionStatus::PasswordIncorrect)
        )
    }

    pub(crate) fn notify(&self) -> ExtractNotify {
        self.extract_notify.clone()
    }

    pub(crate) fn cancel_flag(&self) -> Arc<std::sync::atomic::AtomicBool> {
        self.extract_cancel.clone()
    }
}

impl Drop for SingleArchiveCache {
    fn drop(&mut self) {
        self.extract_cancel
            .store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(dir) = &self.extract_temp_dir {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

struct ArchiveLruState {
    global_zip_lru: VecDeque<(String, String)>,
    archive_lru: VecDeque<String>,
    current_zip_bytes: usize,
}

pub struct ArchiveCache {
    archives: HashMap<String, SingleArchiveCache>,
    lru: Mutex<ArchiveLruState>,
    global_zip_capacity_bytes: usize,
    max_open_archives: usize,
}

impl ArchiveCache {
    pub fn new(capacity_mb: usize) -> Self {
        Self {
            archives: HashMap::new(),
            lru: Mutex::new(ArchiveLruState {
                global_zip_lru: VecDeque::new(),
                archive_lru: VecDeque::new(),
                current_zip_bytes: 0,
            }),
            global_zip_capacity_bytes: capacity_mb.saturating_mul(1024 * 1024),
            max_open_archives: 8,
        }
    }

    pub(crate) fn contains_archive(&self, archive_path: &str) -> bool {
        self.archives.contains_key(archive_path)
    }

    pub(crate) fn touch_archive(&self, archive_path: &str) {
        let mut lru = self.lru.lock().unwrap();
        lru.archive_lru.retain(|p| p != archive_path);
        lru.archive_lru.push_back(archive_path.to_string());
    }

    pub(crate) fn read_from_open_zip(
        &mut self,
        archive_path: &str,
        entry_name: &str,
    ) -> Option<SharedEntryBytes> {
        let single = self.archives.get_mut(archive_path)?;
        let index_map = single.zip_index_map.as_ref();
        let password = single.password.as_deref();
        single
            .zip_archive
            .as_mut()
            .and_then(|archive| {
                crate::archives::zip::read_zip_entry_by_decoded_name(archive, entry_name, index_map, password).ok()
            })
            .map(Vec::into)
    }

    pub(crate) fn read_from_open_zip_header(
        &mut self,
        archive_path: &str,
        entry_name: &str,
        limit: usize,
    ) -> Option<Vec<u8>> {
        let single = self.archives.get_mut(archive_path)?;
        let index_map = single.zip_index_map.as_ref();
        let password = single.password.as_deref();
        single
            .zip_archive
            .as_mut()
            .and_then(|archive| {
                crate::archives::zip::read_zip_entry_header(archive, entry_name, limit, index_map, password).ok()
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

    fn touch_zip_entry(&self, archive_path: &str, entry_name: &str) {
        let key = (archive_path.to_string(), entry_name.to_string());
        {
            let mut lru = self.lru.lock().unwrap();
            lru.global_zip_lru.retain(|existing| existing != &key);
            lru.global_zip_lru.push_back(key);
        }
        self.touch_archive(archive_path);
    }

    fn remove_archive_zip_entries(&mut self, archive_path: &str) {
        let mut removed_bytes = 0;
        if let Some(single) = self.archives.get_mut(archive_path) {
            for data in single.zip_entries.drain().map(|(_, data)| data) {
                removed_bytes += data.len();
            }
        }
        let mut lru = self.lru.lock().unwrap();
        lru.current_zip_bytes = lru.current_zip_bytes.saturating_sub(removed_bytes);
        lru.global_zip_lru.retain(|(path, _)| path != archive_path);
    }

    fn evict_idle_archives(&mut self, keep_path: &str) {
        while self.archives.len() > self.max_open_archives {
            let old_archive = {
                let mut lru = self.lru.lock().unwrap();
                let Some(front) = lru.archive_lru.pop_front() else {
                    break;
                };
                if front == keep_path {
                    lru.archive_lru.push_back(front);
                    continue;
                }
                front
            };
            self.remove_archive_zip_entries(&old_archive);
            self.archives.remove(&old_archive);
        }
    }

    fn evict_until_within_budget(&mut self, incoming_bytes: usize) {
        loop {
            let (old_archive, old_entry) = {
                let lru = self.lru.lock().unwrap();
                if lru.current_zip_bytes + incoming_bytes <= self.global_zip_capacity_bytes {
                    break;
                }
                let Some(entry) = lru.global_zip_lru.front().cloned() else {
                    break;
                };
                entry
            };
            
            let removed = self
                .archives
                .get_mut(&old_archive)
                .and_then(|s| s.zip_entries.remove(&old_entry))
                .map(|d| d.len())
                .unwrap_or(0);
                
            let mut lru = self.lru.lock().unwrap();
            lru.global_zip_lru.pop_front();
            lru.current_zip_bytes = lru.current_zip_bytes.saturating_sub(removed);
        }
    }

    pub(crate) fn register_archive(&mut self, archive_path: String, archive: SingleArchiveCache) {
        self.archives.insert(archive_path.clone(), archive);
        self.touch_archive(&archive_path);
        self.evict_idle_archives(&archive_path);
    }

    pub(crate) fn drop_archive(&mut self, archive_path: &str) {
        self.remove_archive_zip_entries(archive_path);
        self.archives.remove(archive_path);
        let mut lru = self.lru.lock().unwrap();
        lru.archive_lru.retain(|p| p != archive_path);
    }

    pub(crate) fn is_archive_password_required(&self, archive_path: &str) -> bool {
        self.archives
            .get(archive_path)
            .map(|s| s.is_password_required())
            .unwrap_or(false)
    }

    pub(crate) fn get_zip_entry(
        &self,
        archive_path: &str,
        entry_name: &str,
    ) -> Option<SharedEntryBytes> {
        let data = self
            .archives
            .get(archive_path)?
            .zip_entries
            .get(entry_name)?
            .clone();
        self.touch_zip_entry(archive_path, entry_name);
        Some(data)
    }

    pub(crate) fn insert_zip_entry(
        &mut self,
        archive_path: &str,
        entry_name: &str,
        data: impl Into<SharedEntryBytes>,
    ) {
        if !self.archives.contains_key(archive_path) {
            return;
        }
        if self.archives.get(archive_path).unwrap().zip_entries.contains_key(entry_name) {
            self.touch_zip_entry(archive_path, entry_name);
            return;
        }

        let data = data.into();
        self.evict_until_within_budget(data.len());
        if let Some(single) = self.archives.get_mut(archive_path) {
            let mut lru = self.lru.lock().unwrap();
            if let Some(old) = single
                .zip_entries
                .insert(entry_name.to_string(), data.clone())
            {
                lru.current_zip_bytes = lru.current_zip_bytes.saturating_sub(old.len());
            }
            lru.current_zip_bytes = lru.current_zip_bytes.saturating_add(data.len());
        }
        self.touch_zip_entry(archive_path, entry_name);
    }

    #[cfg(test)]
    pub(crate) fn register_test_archive(&mut self, archive_path: &str) {
        self.register_archive(
            archive_path.to_string(),
            SingleArchiveCache::with_zip_archive(None, None, None, None),
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
        self.lru.lock().unwrap().current_zip_bytes
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
    {
        let mut state = match lock.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.extracted.insert(entry_name.to_string());
    }
    cvar.notify_all();
}

pub(crate) fn notify_finished(notify: &ExtractNotify) {
    let (lock, cvar) = &**notify;
    {
        let mut state = match lock.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        state.finished = true;
    }
    cvar.notify_all();
}

pub(crate) struct FinishGuard<'a>(pub &'a ExtractNotify);

impl<'a> Drop for FinishGuard<'a> {
    fn drop(&mut self) {
        notify_finished(self.0);
    }
}
