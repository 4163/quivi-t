use std::borrow::Borrow;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::hash::Hash;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

const MAX_OPEN_ARCHIVES: usize = 2;
pub(super) const MAX_ZIP_POOL_HANDLES: usize = 4;

#[derive(Default)]
pub struct ExtractState {
    pub extracted: HashSet<String>,
    pub extracted_order: Vec<String>,
    pub finished: bool,
}

pub(super) type ZipArchive = zip::ZipArchive<std::io::BufReader<std::fs::File>>;
pub(super) type ZipArchivePool = Arc<Mutex<Vec<ZipArchive>>>;
pub(super) type ExtractNotify = Arc<(Mutex<ExtractState>, Condvar)>;
pub(super) type TempRegNotify = Arc<(Mutex<u64>, Condvar)>;
pub(crate) type SharedEntryBytes = Arc<[u8]>;

pub(super) fn new_extract_notify() -> ExtractNotify {
    Arc::new((Mutex::new(ExtractState::default()), Condvar::new()))
}

pub(super) struct SingleArchiveCache {
    archive_key: Arc<str>,
    generation: u64,
    zip_entries: HashMap<Arc<str>, SharedEntryBytes>,
    zip_pool: Option<ZipArchivePool>,
    zip_index_map: Option<Arc<HashMap<String, usize>>>,
    password: Option<String>,
    encryption: Option<crate::models::ArchiveEncryptionStatus>,
    extract_temp_dir: Option<PathBuf>,
    extract_notify: ExtractNotify,
    extract_cancel: Arc<AtomicBool>,
}

impl SingleArchiveCache {
    pub(super) fn with_zip_archive(
        archive_key: Arc<str>,
        zip_archive: Option<ZipArchive>,
        zip_index_map: Option<HashMap<String, usize>>,
        password: Option<String>,
        encryption: Option<crate::models::ArchiveEncryptionStatus>,
    ) -> Self {
        let mut handles = Vec::with_capacity(MAX_ZIP_POOL_HANDLES);
        if let Some(archive) = zip_archive {
            handles.push(archive);
        }
        Self {
            archive_key,
            generation: 0,
            zip_entries: HashMap::new(),
            zip_pool: Some(Arc::new(Mutex::new(handles))),
            zip_index_map: zip_index_map.map(Arc::new),
            password,
            encryption,
            extract_temp_dir: None,
            extract_notify: new_extract_notify(),
            extract_cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(super) fn with_temp_dir(
        archive_key: Arc<str>,
        extract_temp_dir: PathBuf,
        password: Option<String>,
        encryption: Option<crate::models::ArchiveEncryptionStatus>,
    ) -> Self {
        Self {
            archive_key,
            generation: 0,
            zip_entries: HashMap::new(),
            zip_pool: None,
            zip_index_map: None,
            password,
            encryption,
            extract_temp_dir: Some(extract_temp_dir),
            extract_notify: new_extract_notify(),
            extract_cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(super) fn is_password_required(&self) -> bool {
        matches!(
            self.encryption,
            Some(crate::models::ArchiveEncryptionStatus::PasswordRequired)
                | Some(crate::models::ArchiveEncryptionStatus::PasswordIncorrect)
        )
    }

    pub(super) fn notify(&self) -> ExtractNotify {
        self.extract_notify.clone()
    }

    pub(super) fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.extract_cancel.clone()
    }

    pub(super) fn take_temp_dir(&mut self) -> Option<PathBuf> {
        self.extract_cancel.store(true, Ordering::Release);
        self.extract_temp_dir.take()
    }

    pub(super) fn has_temp_dir(&self) -> bool {
        self.extract_temp_dir.is_some()
    }

    pub(super) fn seed_zip_metadata(
        &mut self,
        zip_archive: Option<ZipArchive>,
        zip_index_map: Option<HashMap<String, usize>>,
    ) {
        if self.zip_index_map.is_none() {
            if let Some(map) = zip_index_map {
                self.zip_index_map = Some(Arc::new(map));
            }
        }
        if let Some(archive) = zip_archive {
            if let Some(pool) = &self.zip_pool {
                let mut guard = pool.lock().unwrap_or_else(|p| p.into_inner());
                if guard.len() < MAX_ZIP_POOL_HANDLES {
                    guard.push(archive);
                }
            } else {
                let mut handles = Vec::with_capacity(MAX_ZIP_POOL_HANDLES);
                handles.push(archive);
                self.zip_pool = Some(Arc::new(Mutex::new(handles)));
            }
        }
    }
}

impl Drop for SingleArchiveCache {
    fn drop(&mut self) {
        self.extract_cancel.store(true, Ordering::Release);
        if let Some(dir) = self.extract_temp_dir.take() {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

/// Amortized O(1) recency queue backed by a generation map and lazy compaction.
struct O1Lru<K: Eq + Hash + Clone> {
    gen: u64,
    latest: HashMap<K, u64>,
    queue: VecDeque<(K, u64)>,
}

impl<K: Eq + Hash + Clone> O1Lru<K> {
    fn new() -> Self {
        Self {
            gen: 0,
            latest: HashMap::new(),
            queue: VecDeque::new(),
        }
    }

    fn touch(&mut self, key: K) {
        self.gen = self.gen.wrapping_add(1);
        let g = self.gen;
        self.latest.insert(key.clone(), g);
        self.queue.push_back((key, g));
        self.maybe_compact();
    }

    fn remove_borrowed<Q>(&mut self, key: &Q)
    where
        K: Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.latest.remove(key);
        self.maybe_compact();
    }

    fn retain_keys(&mut self, mut keep: impl FnMut(&K) -> bool) {
        self.latest.retain(|k, _| keep(k));
        self.maybe_compact();
    }

    fn pop_lru(&mut self) -> Option<K> {
        while let Some((k, g)) = self.queue.pop_front() {
            if self.latest.get(&k) == Some(&g) {
                self.latest.remove(&k);
                return Some(k);
            }
        }
        None
    }

    fn clear(&mut self) {
        self.latest.clear();
        self.queue.clear();
    }

    fn maybe_compact(&mut self) {
        let threshold = self.latest.len().saturating_mul(2).max(64);
        if self.queue.len() > threshold {
            self.queue.retain(|(k, g)| self.latest.get(k) == Some(g));
        }
    }
}

impl O1Lru<Arc<str>> {
    fn pop_lru_except(&mut self, skip: &str) -> Option<Arc<str>> {
        let mut skipped: Option<(Arc<str>, u64)> = None;
        let mut result = None;
        while let Some((k, g)) = self.queue.pop_front() {
            if self.latest.get(&k) != Some(&g) {
                continue;
            }
            if k.as_ref() == skip {
                skipped = Some((k, g));
                continue;
            }
            self.latest.remove(&k);
            result = Some(k);
            break;
        }
        if let Some(entry) = skipped {
            self.queue.push_front(entry);
        }
        result
    }
}

type ZipLruKey = (Arc<str>, Arc<str>);

struct ArchiveLruState {
    global_zip_lru: O1Lru<ZipLruKey>,
    archive_lru: O1Lru<Arc<str>>,
    current_zip_bytes: usize,
}

pub struct ArchiveCache {
    archives: HashMap<Arc<str>, SingleArchiveCache>,
    lru: Mutex<ArchiveLruState>,
    temp_reg_notify: TempRegNotify,
    global_zip_capacity_bytes: usize,
    max_open_archives: usize,
    next_generation: u64,
}

impl ArchiveCache {
    pub fn new(capacity_mb: usize) -> Self {
        Self {
            archives: HashMap::new(),
            lru: Mutex::new(ArchiveLruState {
                global_zip_lru: O1Lru::new(),
                archive_lru: O1Lru::new(),
                current_zip_bytes: 0,
            }),
            temp_reg_notify: Arc::new((Mutex::new(0), Condvar::new())),
            global_zip_capacity_bytes: capacity_mb.saturating_mul(1024 * 1024),
            max_open_archives: MAX_OPEN_ARCHIVES,
            next_generation: 0,
        }
    }

    pub(super) fn archive_generation(&self, archive_path: &str) -> Option<u64> {
        self.archives.get(archive_path).map(|s| s.generation)
    }

    fn lock_lru(&self) -> MutexGuard<'_, ArchiveLruState> {
        self.lru.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(super) fn temp_reg_notify(&self) -> TempRegNotify {
        Arc::clone(&self.temp_reg_notify)
    }

    fn notify_temp_registered(&self) {
        let (lock, cvar) = &*self.temp_reg_notify;
        let mut seq = lock.lock().unwrap_or_else(|p| p.into_inner());
        *seq = seq.wrapping_add(1);
        cvar.notify_all();
    }

    pub(super) fn contains_archive(&self, archive_path: &str) -> bool {
        self.archives.contains_key(archive_path)
    }

    pub(super) fn touch_archive(&self, archive_path: &str) {
        let key = self
            .archives
            .get(archive_path)
            .map(|single| Arc::clone(&single.archive_key))
            .unwrap_or_else(|| Arc::<str>::from(archive_path));
        let mut lru = self.lock_lru();
        lru.archive_lru.touch(key);
    }

    pub(super) fn seed_existing_zip_metadata(
        &mut self,
        archive_path: &str,
        zip_archive: Option<ZipArchive>,
        zip_index_map: Option<HashMap<String, usize>>,
    ) {
        if let Some(single) = self.archives.get_mut(archive_path) {
            single.seed_zip_metadata(zip_archive, zip_index_map);
        }
    }

    pub(super) fn zip_lookup_state(
        &self,
        archive_path: &str,
    ) -> Option<(
        Option<String>,
        Option<Arc<HashMap<String, usize>>>,
        Option<ZipArchivePool>,
    )> {
        let single = self.archives.get(archive_path)?;
        Some((
            single.password.clone(),
            single.zip_index_map.clone(),
            single.zip_pool.clone(),
        ))
    }

    pub(super) fn read_from_open_zip(
        &mut self,
        archive_path: &str,
        entry_name: &str,
    ) -> Option<SharedEntryBytes> {
        let single = self.archives.get(archive_path)?;
        let pool = single.zip_pool.as_ref()?;
        let mut archive = pool.lock().unwrap_or_else(|p| p.into_inner()).pop()?;
        let index_map = single.zip_index_map.as_deref();
        let password = single.password.as_deref();
        let res = crate::archives::zip::read_zip_entry_by_decoded_name(
            &mut archive,
            entry_name,
            index_map,
            password,
        )
        .ok()
        .map(Vec::into);
        let mut guard = pool.lock().unwrap_or_else(|p| p.into_inner());
        if guard.len() < MAX_ZIP_POOL_HANDLES {
            guard.push(archive);
        }
        res
    }

    pub(super) fn read_from_open_zip_header(
        &mut self,
        archive_path: &str,
        entry_name: &str,
        limit: usize,
    ) -> Option<Vec<u8>> {
        let single = self.archives.get(archive_path)?;
        let pool = single.zip_pool.as_ref()?;
        let mut archive = pool.lock().unwrap_or_else(|p| p.into_inner()).pop()?;
        let index_map = single.zip_index_map.as_deref();
        let password = single.password.as_deref();
        let res = crate::archives::zip::read_zip_entry_header(
            &mut archive,
            entry_name,
            limit,
            index_map,
            password,
        )
        .ok();
        let mut guard = pool.lock().unwrap_or_else(|p| p.into_inner());
        if guard.len() < MAX_ZIP_POOL_HANDLES {
            guard.push(archive);
        }
        res
    }

    pub(super) fn temp_extraction_state(
        &self,
        archive_path: &str,
    ) -> Option<(PathBuf, ExtractNotify)> {
        let single = self.archives.get(archive_path)?;
        Some((
            single.extract_temp_dir.clone()?,
            single.extract_notify.clone(),
        ))
    }

    fn touch_zip_entry(&self, archive_key: Arc<str>, entry_key: Arc<str>) {
        let mut lru = self.lock_lru();
        lru.archive_lru.touch(Arc::clone(&archive_key));
        lru.global_zip_lru.touch((archive_key, entry_key));
    }

    fn remove_archive_zip_entries(&mut self, archive_path: &str) {
        let mut removed_bytes = 0;
        if let Some(single) = self.archives.get_mut(archive_path) {
            for (_, data) in single.zip_entries.drain() {
                removed_bytes += data.len();
            }
        }
        let mut lru = self.lock_lru();
        lru.current_zip_bytes = lru.current_zip_bytes.saturating_sub(removed_bytes);
        lru.global_zip_lru
            .retain_keys(|(path, _)| path.as_ref() != archive_path);
    }

    fn evict_idle_archives(&mut self, keep_path: &str, defer_temp_cleanup: bool) -> Vec<PathBuf> {
        let mut evicted_dirs = Vec::new();
        while self.archives.len() > self.max_open_archives {
            let old_archive = {
                let mut lru = self.lock_lru();
                let Some(front) = lru.archive_lru.pop_lru_except(keep_path) else {
                    break;
                };
                front
            };
            self.remove_archive_zip_entries(old_archive.as_ref());
            if let Some(mut removed) = self.archives.remove(old_archive.as_ref()) {
                if defer_temp_cleanup {
                    if let Some(dir) = removed.take_temp_dir() {
                        evicted_dirs.push(dir);
                    }
                }
            }
        }
        evicted_dirs
    }

    fn evict_until_within_budget(&mut self, incoming_bytes: usize) {
        let mut lru = self.lru.lock().unwrap_or_else(|p| p.into_inner());
        while lru.current_zip_bytes.saturating_add(incoming_bytes) > self.global_zip_capacity_bytes
        {
            let Some((old_archive, old_entry)) = lru.global_zip_lru.pop_lru() else {
                break;
            };
            let removed = self
                .archives
                .get_mut(old_archive.as_ref())
                .and_then(|s| s.zip_entries.remove(old_entry.as_ref()))
                .map(|d| d.len())
                .unwrap_or(0);
            lru.current_zip_bytes = lru.current_zip_bytes.saturating_sub(removed);
        }
    }

    pub(super) fn register_archive_deferred(
        &mut self,
        archive_key: Arc<str>,
        mut archive: SingleArchiveCache,
        defer_temp_cleanup: bool,
    ) -> Vec<PathBuf> {
        let is_temp = archive.has_temp_dir();
        let mut evicted_dirs = Vec::new();
        if self.archives.contains_key(archive_key.as_ref()) {
            self.remove_archive_zip_entries(archive_key.as_ref());
        }
        self.next_generation = self.next_generation.wrapping_add(1);
        archive.generation = self.next_generation;
        if let Some(mut previous) = self.archives.insert(Arc::clone(&archive_key), archive) {
            if defer_temp_cleanup {
                if let Some(dir) = previous.take_temp_dir() {
                    evicted_dirs.push(dir);
                }
            }
        }
        {
            let mut lru = self.lock_lru();
            lru.archive_lru.touch(Arc::clone(&archive_key));
        }
        evicted_dirs.extend(self.evict_idle_archives(archive_key.as_ref(), defer_temp_cleanup));
        if is_temp {
            self.notify_temp_registered();
        }
        evicted_dirs
    }

    pub(crate) fn drop_archive_deferred(&mut self, archive_path: &str) -> Vec<PathBuf> {
        self.remove_archive_zip_entries(archive_path);
        let mut dirs = Vec::new();
        if let Some(mut removed) = self.archives.remove(archive_path) {
            if let Some(dir) = removed.take_temp_dir() {
                dirs.push(dir);
            }
        }
        let mut lru = self.lock_lru();
        lru.archive_lru.remove_borrowed(archive_path);
        dirs
    }

    pub(crate) fn drop_archive(&mut self, archive_path: &str) {
        for dir in self.drop_archive_deferred(archive_path) {
            let _ = fs::remove_dir_all(dir);
        }
    }

    pub(crate) fn drop_all_archives(&mut self) {
        self.archives.clear();
        let mut lru = self.lock_lru();
        lru.archive_lru.clear();
        lru.global_zip_lru.clear();
        lru.current_zip_bytes = 0;
    }

    pub(super) fn is_archive_password_required(&self, archive_path: &str) -> bool {
        self.archives
            .get(archive_path)
            .map(|s| s.is_password_required())
            .unwrap_or(false)
    }

    pub(super) fn get_zip_entry(
        &self,
        archive_path: &str,
        entry_name: &str,
    ) -> Option<SharedEntryBytes> {
        let single = self.archives.get(archive_path)?;
        let (entry_key, data) = single.zip_entries.get_key_value(entry_name)?;
        let data = Arc::clone(data);
        self.touch_zip_entry(Arc::clone(&single.archive_key), Arc::clone(entry_key));
        Some(data)
    }

    pub(super) fn insert_zip_entry(
        &mut self,
        archive_path: &str,
        entry_name: &str,
        data: impl Into<SharedEntryBytes>,
    ) {
        if let Some(single) = self.archives.get(archive_path) {
            if let Some((entry_key, _)) = single.zip_entries.get_key_value(entry_name) {
                self.touch_zip_entry(Arc::clone(&single.archive_key), Arc::clone(entry_key));
                return;
            }
        } else {
            return;
        }

        let data = data.into();
        self.evict_until_within_budget(data.len());
        let entry_key: Arc<str> = Arc::from(entry_name);
        let archive_key = {
            let Some(single) = self.archives.get_mut(archive_path) else {
                return;
            };
            let mut lru = self.lru.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(old) = single
                .zip_entries
                .insert(Arc::clone(&entry_key), Arc::clone(&data))
            {
                lru.current_zip_bytes = lru.current_zip_bytes.saturating_sub(old.len());
            }
            lru.current_zip_bytes = lru.current_zip_bytes.saturating_add(data.len());
            Arc::clone(&single.archive_key)
        };
        self.touch_zip_entry(archive_key, entry_key);
    }

    #[cfg(test)]
    pub(super) fn register_test_archive(&mut self, archive_path: &str) {
        let key: Arc<str> = Arc::from(archive_path);
        let single =
            SingleArchiveCache::with_zip_archive(Arc::clone(&key), None, None, None, None);
        self.register_archive_deferred(key, single, false);
    }

    #[cfg(test)]
    pub(super) fn set_max_open_archives(&mut self, max_open_archives: usize) {
        self.max_open_archives = max_open_archives;
    }

    #[cfg(test)]
    pub(super) fn current_zip_bytes(&self) -> usize {
        self.lock_lru().current_zip_bytes
    }

    #[cfg(test)]
    pub(super) fn contains_zip_entry(&self, archive_path: &str, entry_name: &str) -> bool {
        self.archives
            .get(archive_path)
            .map(|single| single.zip_entries.contains_key(entry_name))
            .unwrap_or(false)
    }
}

fn quivit_temp_root() -> PathBuf {
    std::env::temp_dir().join("QuiviT")
}

fn pid_temp_dir() -> PathBuf {
    quivit_temp_root().join(format!("pid-{}", std::process::id()))
}

static TEMP_DIR_NONCE: AtomicU64 = AtomicU64::new(0);

pub(super) fn archive_temp_dir(archive_path: &str) -> PathBuf {
    let hash = format!("{:x}", md5::compute(archive_path));
    let nonce = TEMP_DIR_NONCE.fetch_add(1, Ordering::Relaxed);
    pid_temp_dir().join(format!("{hash}-{nonce}"))
}

pub(super) fn archive_entry_temp_path(temp_dir: &Path, entry_name: &str) -> Option<PathBuf> {
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

pub(super) fn prepare_temp_entry_paths(
    temp_dir: &Path,
    entry_name: &str,
    cancel_flag: &AtomicBool,
) -> Option<(PathBuf, PathBuf)> {
    if cancel_flag.load(Ordering::Acquire) {
        return None;
    }
    let out_path = archive_entry_temp_path(temp_dir, entry_name)?;
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent).ok()?;
    }
    if cancel_flag.load(Ordering::Acquire) {
        return None;
    }
    let file_name = out_path.file_name()?.to_string_lossy();
    let tmp_path = out_path.with_file_name(format!("{file_name}.tmp"));
    Some((tmp_path, out_path))
}

pub(super) fn commit_temp_entry(
    tmp_path: &Path,
    out_path: &Path,
    cancel_flag: &AtomicBool,
) -> Option<PathBuf> {
    if cancel_flag.load(Ordering::Acquire) {
        let _ = fs::remove_file(tmp_path);
        return None;
    }
    if fs::rename(tmp_path, out_path).is_err() {
        let _ = fs::remove_file(tmp_path);
        return None;
    }
    Some(out_path.to_path_buf())
}

// Called by sevenz.rs and tar.rs extractors to atomically write each
// decompressed entry to the temp directory via a .tmp rename.
pub(super) fn write_temp_entry(
    temp_dir: &Path,
    entry_name: &str,
    cancel_flag: &AtomicBool,
    write: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Option<PathBuf> {
    let (tmp_path, out_path) = prepare_temp_entry_paths(temp_dir, entry_name, cancel_flag)?;
    if write(&tmp_path).is_err() {
        let _ = fs::remove_file(&tmp_path);
        return None;
    }
    commit_temp_entry(&tmp_path, &out_path, cancel_flag)
}

// Called by rar.rs, sevenz.rs, and tar.rs extractors after each entry is
// written, waking any protocol/IPC thread waiting on that file.
pub(super) fn notify_extracted(notify: &ExtractNotify, entry_name: &str) {
    let (lock, cvar) = &**notify;
    {
        let mut state = lock.lock().unwrap_or_else(|p| p.into_inner());
        let owned = entry_name.to_string();
        if state.extracted.insert(owned.clone()) {
            state.extracted_order.push(owned);
        }
    }
    cvar.notify_all();
}

pub(super) fn notify_finished(notify: &ExtractNotify) {
    let (lock, cvar) = &**notify;
    {
        let mut state = lock.lock().unwrap_or_else(|p| p.into_inner());
        state.finished = true;
    }
    cvar.notify_all();
}

pub(super) struct FinishGuard<'a>(pub &'a ExtractNotify);

impl Drop for FinishGuard<'_> {
    fn drop(&mut self) {
        notify_finished(self.0);
    }
}

// -- PID-scoped temp directory lifecycle --
//
// Each running QuiviT instance writes extraction temps into
//   %TEMP%\QuiviT\pid-<PID>\<archive-hash>\...
// and holds an exclusive lock on
//   %TEMP%\QuiviT\pid-<PID>.lock
// while alive.  On startup we probe every sibling .lock file; if we can
// acquire it, the owner is dead and we delete its folder and lock file.

/// Held for the process lifetime so other instances can probe liveness.
static APP_TEMP_LOCK: Mutex<Option<fs::File>> = Mutex::new(None);

/// Create and exclusively hold `%TEMP%\QuiviT\pid-<PID>.lock`.
/// Call once during `setup()`.
pub(crate) fn acquire_temp_lock() {
    let root = quivit_temp_root();
    let _ = fs::create_dir_all(&root);
    let lock_path = root.join(format!("pid-{}.lock", std::process::id()));

    use std::io::Write;
    use std::os::windows::fs::OpenOptionsExt;
    // FILE_SHARE_READ (1): deny write-sharing so other instances'
    // open-for-write probe gets a sharing violation while we're alive.
    match fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .share_mode(1)
        .open(&lock_path)
    {
        Ok(mut file) => {
            let _ = write!(file, "{}", std::process::id());
            if let Ok(mut guard) = APP_TEMP_LOCK.lock() {
                *guard = Some(file);
            }
        }
        Err(e) => {
            eprintln!("[TempLock] failed to create lock file: {e}");
        }
    }
}

/// Delete temp dirs whose owning process is no longer alive.
/// A dir is orphaned when we can open its .lock file for writing (the
/// owner releases the handle on exit or crash).
pub(crate) fn cleanup_orphaned_temp_dirs() {
    let root = quivit_temp_root();
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    let own_pid = format!("pid-{}", std::process::id());

    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };

        // Only look at lock files that belong to other PIDs.
        let Some(stem) = name_str.strip_suffix(".lock") else {
            continue;
        };
        if stem == own_pid {
            continue;
        }

        // Try to open for writing; success means the owner is gone.
        let lock_path = entry.path();
        match fs::OpenOptions::new().write(true).open(&lock_path) {
            Ok(_handle) => {
                drop(_handle);
                let _ = fs::remove_file(&lock_path);
                let dir = root.join(stem);
                if dir.is_dir() {
                    let _ = fs::remove_dir_all(&dir);
                }
            }
            Err(_) => {
                // Lock held by a live process, skip.
            }
        }
    }
}

/// Remove the current instance's temp directory and lock file.
/// Call during `RunEvent::Exit`.
pub(crate) fn cleanup_current_temp_dir() {
    let dir = pid_temp_dir();
    if dir.exists() {
        let _ = fs::remove_dir_all(&dir);
    }
    // Drop the held file handle so Windows releases the lock before removal.
    if let Ok(mut guard) = APP_TEMP_LOCK.lock() {
        drop(guard.take());
    }
    let lock_path = quivit_temp_root().join(format!("pid-{}.lock", std::process::id()));
    let _ = fs::remove_file(&lock_path);
}
