mod cache;
mod encoding;
mod rar;
mod scanner;
mod sevenz;
mod tar;
mod zip;

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, Read};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use crate::models::{ArchiveEncryptionStatus, ArchiveReadResult, FileEntry};

pub use cache::ArchiveCache;
pub(crate) use cache::{
    acquire_temp_lock, cleanup_current_temp_dir, cleanup_orphaned_temp_dirs,
};
pub(crate) use scanner::{
    scan_container_dimensions_with, scan_container_max_width_with, TEMP_REG_WAIT_TIMEOUT,
};
#[cfg(test)]
pub(crate) use scanner::skip_for_width_scan;

use cache::{archive_entry_temp_path, archive_temp_dir, ExtractNotify, ZipArchivePool};

#[cfg(test)]
use rar::list_rar_entries;
#[cfg(test)]
use sevenz::list_7z_entries;
#[cfg(test)]
use tar::list_tar_entries;
#[cfg(test)]
use zip::list_zip_entries;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ArchiveKind {
    Zip,
    Rar,
    SevenZ,
    Tar,
}

impl ArchiveKind {
    fn from_path(path: &str) -> Result<Self, String> {
        let ext = path.rsplit('.').next().unwrap_or("");
        if ext.eq_ignore_ascii_case("zip") || ext.eq_ignore_ascii_case("cbz") {
            Ok(Self::Zip)
        } else if ext.eq_ignore_ascii_case("rar") || ext.eq_ignore_ascii_case("cbr") {
            Ok(Self::Rar)
        } else if ext.eq_ignore_ascii_case("7z") || ext.eq_ignore_ascii_case("cb7") {
            Ok(Self::SevenZ)
        } else if ext.eq_ignore_ascii_case("tar") || ext.eq_ignore_ascii_case("cbt") {
            Ok(Self::Tar)
        } else {
            Err(format!("Unsupported archive format: {ext}"))
        }
    }
}

fn is_nested_archive_entry(name: &str) -> bool {
    let trimmed = name.trim_matches(|c| c == '/' || c == '\\');
    trimmed.contains('/') || trimmed.contains('\\')
}

pub(crate) fn compare_archive_entry_names(a: &str, b: &str) -> Ordering {
    let a_nested = is_nested_archive_entry(a);
    let b_nested = is_nested_archive_entry(b);
    a_nested.cmp(&b_nested).then_with(|| natord::compare(a, b))
}

pub(super) fn sort_archive_entries(files: &mut [FileEntry]) {
    files.sort_by(|a, b| compare_archive_entry_names(&a.name, &b.name));
}

/// Name-only listing without opening a cache entry or spawning background
/// extraction. The Explorer preview needs the tree, never entry bytes.
pub(crate) fn list_archive_names(archive_path: &str) -> Result<Vec<FileEntry>, String> {
    match ArchiveKind::from_path(archive_path)? {
        ArchiveKind::Zip => zip::list_zip_entries(archive_path, None).map(|(files, _, _, _)| files),
        ArchiveKind::Rar => rar::list_rar_entries(archive_path, None).map(|(files, _)| files),
        ArchiveKind::SevenZ => sevenz::list_7z_entries(archive_path, None).map(|(files, _)| files),
        ArchiveKind::Tar => tar::list_tar_entries(archive_path),
    }
}

pub(crate) fn spawn_remove_temp_dirs(dirs: Vec<PathBuf>) {
    if dirs.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        for dir in dirs {
            let _ = fs::remove_dir_all(dir);
        }
    });
}

fn wait_for_extracted_path(
    file_path: PathBuf,
    notify: ExtractNotify,
    entry_name: &str,
) -> Result<PathBuf, String> {
    let (lock, cvar) = &*notify;
    let mut guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    let timeout = Duration::from_secs(30);
    let start = std::time::Instant::now();

    while !guard.extracted.contains(entry_name) && !guard.finished {
        let elapsed = start.elapsed();
        if elapsed >= timeout {
            break;
        }
        let rem = timeout - elapsed;
        let (next_guard, timeout_res) = cvar
            .wait_timeout(guard, rem)
            .unwrap_or_else(|p| p.into_inner());
        guard = next_guard;
        if timeout_res.timed_out() {
            break;
        }
    }

    if guard.extracted.contains(entry_name) {
        Ok(file_path)
    } else {
        Err(format!(
            "Archive entry {entry_name} not available or extraction finished"
        ))
    }
}

fn read_file_header(path: &PathBuf, entry_name: &str, limit: usize) -> Result<Vec<u8>, String> {
    let f = fs::File::open(path)
        .map_err(|e| format!("Cannot open extracted entry {entry_name}: {e}"))?;
    let cap = f
        .metadata()
        .map(|m| (m.len() as usize).min(limit))
        .unwrap_or_else(|_| limit.min(64 * 1024));
    let mut buf = Vec::with_capacity(cap);
    f.take(limit as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("Cannot read extracted entry header {entry_name}: {e}"))?;
    Ok(buf)
}

pub enum ArchiveEntryData {
    Ready(Arc<[u8]>),
    ReadyPath(PathBuf),
    PendingExtraction {
        file_path: PathBuf,
        notify: ExtractNotify,
    },
}

impl ArchiveEntryData {
    pub fn wait_for_data(self, entry_name: &str) -> Result<Vec<u8>, String> {
        match self {
            Self::Ready(data) => Ok(data.to_vec()),
            Self::ReadyPath(file_path) => fs::read(&file_path)
                .map_err(|e| format!("Cannot read extracted archive entry {entry_name}: {e}")),
            Self::PendingExtraction { file_path, notify } => {
                let path = wait_for_extracted_path(file_path, notify, entry_name)?;
                fs::read(&path)
                    .map_err(|e| format!("Cannot read extracted archive entry {entry_name}: {e}"))
            }
        }
    }
}

struct PreparedArchive {
    kind: ArchiveKind,
    files: Vec<FileEntry>,
    zip_archive: Option<cache::ZipArchive>,
    zip_index_map: Option<HashMap<String, usize>>,
    password: Option<String>,
    encryption: Option<ArchiveEncryptionStatus>,
}

fn open_and_list_archive(
    archive_path: &str,
    password: Option<&str>,
) -> Result<PreparedArchive, String> {
    let kind = ArchiveKind::from_path(archive_path)?;
    let owned_password = password.map(str::to_string);
    match kind {
        ArchiveKind::Zip => {
            let (files, zip_archive, index_map, encryption) =
                zip::list_zip_entries(archive_path, password)?;
            Ok(PreparedArchive {
                kind,
                files,
                zip_archive: Some(zip_archive),
                zip_index_map: Some(index_map),
                password: owned_password,
                encryption,
            })
        }
        ArchiveKind::Rar => {
            let (files, encryption) = rar::list_rar_entries(archive_path, password)?;
            Ok(PreparedArchive {
                kind,
                files,
                zip_archive: None,
                zip_index_map: None,
                password: owned_password,
                encryption,
            })
        }
        ArchiveKind::SevenZ => {
            let (files, encryption) = sevenz::list_7z_entries(archive_path, password)?;
            Ok(PreparedArchive {
                kind,
                files,
                zip_archive: None,
                zip_index_map: None,
                password: owned_password,
                encryption,
            })
        }
        ArchiveKind::Tar => {
            let files = tar::list_tar_entries(archive_path)?;
            Ok(PreparedArchive {
                kind,
                files,
                zip_archive: None,
                zip_index_map: None,
                password: owned_password,
                encryption: None,
            })
        }
    }
}

fn acquire_zip_handle(
    archive_path: &str,
    pool: Option<&ZipArchivePool>,
    already_registered: bool,
) -> Result<cache::ZipArchive, String> {
    if let Some(pool) = pool {
        if let Some(archive) = pool.lock().unwrap_or_else(|p| p.into_inner()).pop() {
            return Ok(archive);
        }
    }
    if already_registered {
        zip::open_zip_archive_unchecked(archive_path)
    } else {
        zip::open_zip_archive(archive_path)
    }
}

fn release_zip_handle(pool: Option<&ZipArchivePool>, archive: cache::ZipArchive) {
    if let Some(pool) = pool {
        let mut guard = pool.lock().unwrap_or_else(|p| p.into_inner());
        if guard.len() < cache::MAX_ZIP_POOL_HANDLES {
            guard.push(archive);
        }
    }
}

fn resolve_temp_entry_shared(
    state: &RwLock<ArchiveCache>,
    archive_path: &str,
    entry_name: &str,
) -> Result<ArchiveEntryData, String> {
    let existing = {
        let cache = state.read().map_err(|e| e.to_string())?;
        if cache.is_archive_password_required(archive_path) {
            return Err(format!("Archive is password-protected: {archive_path}"));
        }
        cache.temp_extraction_state(archive_path)
    };

    let (temp_dir, notify) = match existing {
        Some(pair) => pair,
        None => {
            let kind = ArchiveKind::from_path(archive_path)?;
            let (pair, evicted_dirs) = {
                let mut cache = state.write().map_err(|e| e.to_string())?;
                if cache.is_archive_password_required(archive_path) {
                    return Err(format!("Archive is password-protected: {archive_path}"));
                }
                let evicted = cache.prepare_archive_state(
                    archive_path,
                    kind,
                    None,
                    None,
                    None,
                    None,
                    true,
                );
                let pair = cache.temp_extraction_state(archive_path).ok_or_else(|| {
                    format!("Archive is not prepared for temporary extraction: {archive_path}")
                })?;
                (pair, evicted)
            };
            spawn_remove_temp_dirs(evicted_dirs);
            pair
        }
    };

    let file_path = archive_entry_temp_path(&temp_dir, entry_name)
        .ok_or_else(|| format!("Unsafe archive entry path: {entry_name}"))?;

    let is_extracted = {
        let (lock, _) = &*notify;
        let guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        guard.extracted.contains(entry_name)
    };
    if is_extracted {
        return Ok(ArchiveEntryData::ReadyPath(file_path));
    }

    Ok(ArchiveEntryData::PendingExtraction { file_path, notify })
}

impl ArchiveCache {
    fn register_prepared_archive(
        &mut self,
        archive_path: &str,
        prepared: PreparedArchive,
        defer_temp_cleanup: bool,
    ) -> (ArchiveReadResult, Vec<PathBuf>) {
        let evicted = self.prepare_archive_state(
            archive_path,
            prepared.kind,
            prepared.zip_archive,
            prepared.zip_index_map,
            prepared.password,
            prepared.encryption,
            defer_temp_cleanup,
        );

        let result = ArchiveReadResult {
            files: prepared.files,
            archive_path: archive_path.to_string(),
            encryption: prepared.encryption,
        };
        (result, evicted)
    }

    pub fn prepare_archive(
        &mut self,
        archive_path: &str,
        password: Option<&str>,
    ) -> Result<ArchiveReadResult, String> {
        let prepared = open_and_list_archive(archive_path, password)?;
        let (result, _) = self.register_prepared_archive(archive_path, prepared, false);
        Ok(result)
    }

    pub fn read_entry_bytes(
        &mut self,
        archive_path: &str,
        entry_name: &str,
    ) -> Result<ArchiveEntryData, String> {
        match ArchiveKind::from_path(archive_path)? {
            ArchiveKind::Zip => self
                .read_zip_entry_bytes(archive_path, entry_name)
                .map(ArchiveEntryData::Ready),
            ArchiveKind::Rar | ArchiveKind::SevenZ | ArchiveKind::Tar => {
                self.read_temp_entry_bytes(archive_path, entry_name)
            }
        }
    }

    pub fn cached_zip_entry_bytes(
        &self,
        archive_path: &str,
        entry_name: &str,
    ) -> Result<Option<cache::SharedEntryBytes>, String> {
        if ArchiveKind::from_path(archive_path)? != ArchiveKind::Zip {
            return Ok(None);
        }

        Ok(self.get_zip_entry(archive_path, entry_name))
    }

    pub fn read_entry_header(
        &mut self,
        archive_path: &str,
        entry_name: &str,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        match ArchiveKind::from_path(archive_path)? {
            ArchiveKind::Zip => self.read_zip_entry_header(archive_path, entry_name, limit),
            ArchiveKind::Rar | ArchiveKind::SevenZ | ArchiveKind::Tar => {
                self.read_temp_entry_header(archive_path, entry_name, limit)
            }
        }
    }

    fn read_zip_entry_header(
        &mut self,
        archive_path: &str,
        entry_name: &str,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        if self.is_archive_password_required(archive_path) {
            return Err(format!("Archive is password-protected: {archive_path}"));
        }

        if let Some(cached) = self.get_zip_entry(archive_path, entry_name) {
            let end = cached.len().min(limit);
            return Ok(cached[..end].to_vec());
        }

        if self.contains_archive(archive_path) {
            if let Some(buf) = self.read_from_open_zip_header(archive_path, entry_name, limit) {
                return Ok(buf);
            }
        }

        let mut archive = zip::open_zip_archive(archive_path)?;
        zip::read_zip_entry_header(&mut archive, entry_name, limit, None, None)
    }

    fn read_temp_entry_header(
        &mut self,
        archive_path: &str,
        entry_name: &str,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        if self.is_archive_password_required(archive_path) {
            return Err(format!("Archive is password-protected: {archive_path}"));
        }

        let data = self.read_temp_entry_bytes(archive_path, entry_name)?;
        match data {
            ArchiveEntryData::Ready(arc) => {
                let end = arc.len().min(limit);
                Ok(arc[..end].to_vec())
            }
            ArchiveEntryData::ReadyPath(file_path) => {
                read_file_header(&file_path, entry_name, limit)
            }
            ArchiveEntryData::PendingExtraction { file_path, notify } => {
                let ready_path = wait_for_extracted_path(file_path, notify, entry_name)?;
                read_file_header(&ready_path, entry_name, limit)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn prepare_archive_state(
        &mut self,
        archive_path: &str,
        kind: ArchiveKind,
        zip_archive: Option<cache::ZipArchive>,
        zip_index_map: Option<HashMap<String, usize>>,
        password: Option<String>,
        encryption: Option<ArchiveEncryptionStatus>,
        defer_temp_cleanup: bool,
    ) -> Vec<PathBuf> {
        let mut evicted_dirs = Vec::new();
        if self.contains_archive(archive_path) {
            if password.is_some() {
                if defer_temp_cleanup {
                    evicted_dirs.extend(self.drop_archive_deferred(archive_path));
                } else {
                    self.drop_archive(archive_path);
                }
            } else {
                if kind == ArchiveKind::Zip {
                    self.seed_existing_zip_metadata(archive_path, zip_archive, zip_index_map);
                }
                self.touch_archive(archive_path);
                return evicted_dirs;
            }
        }

        let archive_key: Arc<str> = Arc::from(archive_path);
        let single = match kind {
            ArchiveKind::Zip => cache::SingleArchiveCache::with_zip_archive(
                Arc::clone(&archive_key),
                zip_archive,
                zip_index_map,
                password,
                encryption,
            ),
            ArchiveKind::Rar | ArchiveKind::SevenZ | ArchiveKind::Tar => {
                let temp_dir = archive_temp_dir(archive_path);
                let single = cache::SingleArchiveCache::with_temp_dir(
                    Arc::clone(&archive_key),
                    temp_dir.clone(),
                    password.clone(),
                    encryption,
                );
                if !single.is_password_required() {
                    spawn_temp_extractor(
                        kind,
                        archive_path.to_string(),
                        temp_dir,
                        single.notify(),
                        single.cancel_flag(),
                        password,
                    );
                }
                single
            }
        };

        evicted_dirs.extend(self.register_archive_deferred(
            archive_key,
            single,
            defer_temp_cleanup,
        ));
        evicted_dirs
    }

    fn read_zip_entry_bytes(
        &mut self,
        archive_path: &str,
        entry_name: &str,
    ) -> Result<cache::SharedEntryBytes, String> {
        if self.is_archive_password_required(archive_path) {
            return Err(format!("Archive is password-protected: {archive_path}"));
        }

        if let Some(cached) = self.get_zip_entry(archive_path, entry_name) {
            return Ok(cached);
        }

        self.prepare_archive_state(archive_path, ArchiveKind::Zip, None, None, None, None, false);

        let shared = if let Some(data) = self.read_from_open_zip(archive_path, entry_name) {
            data
        } else {
            let (password, index_map, _) = self
                .zip_lookup_state(archive_path)
                .unwrap_or((None, None, None));
            let mut archive = zip::open_zip_archive(archive_path)?;
            zip::read_zip_entry_by_decoded_name(
                &mut archive,
                entry_name,
                index_map.as_deref(),
                password.as_deref(),
            )
            .map(cache::SharedEntryBytes::from)
            .map_err(|_| format!("Cannot find ZIP entry: {entry_name}"))?
        };

        self.insert_zip_entry(archive_path, entry_name, shared.clone());
        Ok(shared)
    }

    fn read_temp_entry_bytes(
        &mut self,
        archive_path: &str,
        entry_name: &str,
    ) -> Result<ArchiveEntryData, String> {
        if self.is_archive_password_required(archive_path) {
            return Err(format!("Archive is password-protected: {archive_path}"));
        }

        let kind = ArchiveKind::from_path(archive_path)?;
        self.prepare_archive_state(archive_path, kind, None, None, None, None, false);

        let (temp_dir, notify) = self.temp_extraction_state(archive_path).ok_or_else(|| {
            format!("Archive is not prepared for temporary extraction: {archive_path}")
        })?;
        let file_path = archive_entry_temp_path(&temp_dir, entry_name)
            .ok_or_else(|| format!("Unsafe archive entry path: {entry_name}"))?;

        let is_extracted = {
            let (lock, _) = &*notify;
            let guard = lock.lock().unwrap_or_else(|p| p.into_inner());
            guard.extracted.contains(entry_name)
        };
        if is_extracted {
            return Ok(ArchiveEntryData::ReadyPath(file_path));
        }

        Ok(ArchiveEntryData::PendingExtraction { file_path, notify })
    }
}

/// Unlocked disk listing followed by short-locked registration and deferred
/// temp-dir eviction cleanup.
pub(crate) fn prepare_archive_shared(
    state: &RwLock<ArchiveCache>,
    archive_path: &str,
    password: Option<&str>,
) -> Result<ArchiveReadResult, String> {
    let prepared = open_and_list_archive(archive_path, password)?;
    let (result, evicted_dirs) = {
        let mut cache = state.write().map_err(|e| e.to_string())?;
        cache.register_prepared_archive(archive_path, prepared, true)
    };
    spawn_remove_temp_dirs(evicted_dirs);
    Ok(result)
}

/// Protocol hot-path ZIP read that never holds the global lock across
/// extraction. Read-lock check first, write-lock upgrade only when the
/// archive is unregistered, unlocked inflate via pooled `ZipArchive` +
/// cached `zip_index_map`, short-lock insert with dedup. Returns `None` for
/// non-ZIP kinds or archives still awaiting a password.
pub(crate) fn read_plain_zip_entry_shared(
    state: &RwLock<ArchiveCache>,
    archive_path: &str,
    entry_name: &str,
) -> Option<Result<cache::SharedEntryBytes, String>> {
    if ArchiveKind::from_path(archive_path).ok()? != ArchiveKind::Zip {
        return None;
    }

    let (password, index_map, zip_pool, generation) = {
        let cache = state.read().ok()?;
        if cache.is_archive_password_required(archive_path) {
            return None;
        }
        if let Some(hit) = cache.get_zip_entry(archive_path, entry_name) {
            return Some(Ok(hit));
        }
        match cache.zip_lookup_state(archive_path) {
            Some((pwd, map, pool)) => (pwd, map, pool, cache.archive_generation(archive_path)),
            None => (None, None, None, None),
        }
    };

    let already_registered = generation.is_some();
    let (password, index_map, zip_pool, generation) = if let Some(gen) = generation {
        (password, index_map, zip_pool, Some(gen))
    } else {
        let (lookup, gen, evicted_dirs) = {
            let mut cache = state.write().ok()?;
            if cache.is_archive_password_required(archive_path) {
                return None;
            }
            if let Some(hit) = cache.get_zip_entry(archive_path, entry_name) {
                return Some(Ok(hit));
            }
            let evicted = if !cache.contains_archive(archive_path) {
                cache.prepare_archive_state(
                    archive_path,
                    ArchiveKind::Zip,
                    None,
                    None,
                    None,
                    None,
                    true,
                )
            } else {
                Vec::new()
            };
            let lookup = cache
                .zip_lookup_state(archive_path)
                .unwrap_or((None, None, None));
            let gen = cache.archive_generation(archive_path);
            (lookup, gen, evicted)
        };
        spawn_remove_temp_dirs(evicted_dirs);
        (lookup.0, lookup.1, lookup.2, gen)
    };

    let mut archive = match acquire_zip_handle(archive_path, zip_pool.as_ref(), already_registered)
    {
        Ok(a) => a,
        Err(_) => return Some(Err(format!("Cannot find ZIP entry: {entry_name}"))),
    };
    let read_res = zip::read_zip_entry_by_decoded_name(
        &mut archive,
        entry_name,
        index_map.as_deref(),
        password.as_deref(),
    );
    release_zip_handle(zip_pool.as_ref(), archive);

    let extracted = match read_res {
        Ok(bytes) => cache::SharedEntryBytes::from(bytes),
        Err(_) => return Some(Err(format!("Cannot find ZIP entry: {entry_name}"))),
    };

    {
        let mut cache = state.write().ok()?;
        if generation.is_some() && cache.archive_generation(archive_path) == generation {
            if let Some(hit) = cache.get_zip_entry(archive_path, entry_name) {
                return Some(Ok(hit));
            }
            cache.insert_zip_entry(archive_path, entry_name, extracted.clone());
        }
    }
    Some(Ok(extracted))
}

/// Unlocked entry header probe for animation and format inspection. Never holds
/// `RwLock<ArchiveCache>` across ZIP inflation, `Condvar` waits, or file reads.
pub(crate) fn read_entry_header_shared(
    state: &RwLock<ArchiveCache>,
    archive_path: &str,
    entry_name: &str,
    limit: usize,
) -> Result<Vec<u8>, String> {
    match ArchiveKind::from_path(archive_path)? {
        ArchiveKind::Zip => {
            let (password, index_map, zip_pool, already_registered) = {
                let cache = state.read().map_err(|e| e.to_string())?;
                if cache.is_archive_password_required(archive_path) {
                    return Err(format!("Archive is password-protected: {archive_path}"));
                }
                if let Some(cached) = cache.get_zip_entry(archive_path, entry_name) {
                    let end = cached.len().min(limit);
                    return Ok(cached[..end].to_vec());
                }
                match cache.zip_lookup_state(archive_path) {
                    Some((pwd, map, pool)) => (pwd, map, pool, true),
                    None => (None, None, None, false),
                }
            };

            let mut archive =
                acquire_zip_handle(archive_path, zip_pool.as_ref(), already_registered)?;
            let res = zip::read_zip_entry_header(
                &mut archive,
                entry_name,
                limit,
                index_map.as_deref(),
                password.as_deref(),
            );
            release_zip_handle(zip_pool.as_ref(), archive);
            res
        }
        ArchiveKind::Rar | ArchiveKind::SevenZ | ArchiveKind::Tar => {
            match resolve_temp_entry_shared(state, archive_path, entry_name)? {
                ArchiveEntryData::Ready(arc) => {
                    let end = arc.len().min(limit);
                    Ok(arc[..end].to_vec())
                }
                ArchiveEntryData::ReadyPath(file_path) => {
                    read_file_header(&file_path, entry_name, limit)
                }
                ArchiveEntryData::PendingExtraction { file_path, notify } => {
                    let ready_path = wait_for_extracted_path(file_path, notify, entry_name)?;
                    read_file_header(&ready_path, entry_name, limit)
                }
            }
        }
    }
}

/// Unlocked entry reader for streaming inspection (e.g., MP4 audio check with
/// trailing `moov` boxes beyond header caps).
pub(crate) fn with_entry_stream_shared<T>(
    state: &RwLock<ArchiveCache>,
    archive_path: &str,
    entry_name: &str,
    f: impl FnOnce(&mut dyn Read) -> T,
) -> Result<T, String> {
    match ArchiveKind::from_path(archive_path)? {
        ArchiveKind::Zip => {
            let (cached, lookup) = {
                let cache = state.read().map_err(|e| e.to_string())?;
                if cache.is_archive_password_required(archive_path) {
                    return Err(format!("Archive is password-protected: {archive_path}"));
                }
                if let Some(hit) = cache.get_zip_entry(archive_path, entry_name) {
                    (Some(hit), None)
                } else {
                    (None, Some(cache.zip_lookup_state(archive_path)))
                }
            };

            if let Some(hit) = cached {
                let mut cursor = std::io::Cursor::new(&hit[..]);
                return Ok(f(&mut cursor));
            }

            let (password, index_map, zip_pool, already_registered) = match lookup.flatten() {
                Some((pwd, map, pool)) => (pwd, map, pool, true),
                None => (None, None, None, false),
            };

            let mut archive =
                acquire_zip_handle(archive_path, zip_pool.as_ref(), already_registered)?;
            let res = zip::with_zip_entry_reader(
                &mut archive,
                entry_name,
                index_map.as_deref(),
                password.as_deref(),
                |entry| Ok(f(entry)),
            );
            release_zip_handle(zip_pool.as_ref(), archive);
            res
        }
        ArchiveKind::Rar | ArchiveKind::SevenZ | ArchiveKind::Tar => {
            let ready_path = match resolve_temp_entry_shared(state, archive_path, entry_name)? {
                ArchiveEntryData::Ready(arc) => {
                    let mut cursor = std::io::Cursor::new(&arc[..]);
                    return Ok(f(&mut cursor));
                }
                ArchiveEntryData::ReadyPath(file_path) => file_path,
                ArchiveEntryData::PendingExtraction { file_path, notify } => {
                    wait_for_extracted_path(file_path, notify, entry_name)?
                }
            };
            let file = fs::File::open(&ready_path)
                .map_err(|e| format!("Cannot open extracted entry {entry_name}: {e}"))?;
            let mut reader = BufReader::new(file);
            Ok(f(&mut reader))
        }
    }
}

/// Unlocked full-entry read used by IPC commands (e.g., `get_archive_ico_frames`)
/// and the `quivit://` protocol handler.
pub(crate) fn read_entry_bytes_shared(
    state: &RwLock<ArchiveCache>,
    archive_path: &str,
    entry_name: &str,
) -> Result<Vec<u8>, String> {
    match ArchiveKind::from_path(archive_path)? {
        ArchiveKind::Zip => match read_plain_zip_entry_shared(state, archive_path, entry_name) {
            Some(res) => res.map(|bytes| bytes.to_vec()),
            None => {
                {
                    let cache = state.read().map_err(|e| e.to_string())?;
                    if cache.is_archive_password_required(archive_path) {
                        return Err(format!("Archive is password-protected: {archive_path}"));
                    }
                }
                let entry_data = {
                    let mut cache = state.write().map_err(|e| e.to_string())?;
                    cache.read_entry_bytes(archive_path, entry_name)?
                };
                entry_data.wait_for_data(entry_name)
            }
        },
        ArchiveKind::Rar | ArchiveKind::SevenZ | ArchiveKind::Tar => {
            resolve_temp_entry_shared(state, archive_path, entry_name)?.wait_for_data(entry_name)
        }
    }
}

fn spawn_temp_extractor(
    kind: ArchiveKind,
    archive_path: String,
    temp_dir: PathBuf,
    notify: ExtractNotify,
    cancel_flag: Arc<AtomicBool>,
    password: Option<String>,
) {
    std::thread::spawn(move || {
        if cancel_flag.load(AtomicOrdering::Acquire) {
            cache::notify_finished(&notify);
            let _ = fs::remove_dir_all(&temp_dir);
            return;
        }
        let _ = fs::create_dir_all(&temp_dir);
        if cancel_flag.load(AtomicOrdering::Acquire) {
            cache::notify_finished(&notify);
            let _ = fs::remove_dir_all(&temp_dir);
            return;
        }
        match kind {
            ArchiveKind::Rar => rar::extract_rar_to_temp(
                archive_path,
                temp_dir.clone(),
                notify,
                cancel_flag.clone(),
                password,
            ),
            ArchiveKind::SevenZ => sevenz::extract_7z_to_temp(
                archive_path,
                temp_dir.clone(),
                notify,
                cancel_flag.clone(),
                password,
            ),
            ArchiveKind::Tar => tar::extract_tar_to_temp(
                archive_path,
                temp_dir.clone(),
                notify,
                cancel_flag.clone(),
            ),
            ArchiveKind::Zip => {}
        }
        if cancel_flag.load(AtomicOrdering::Acquire) {
            let _ = fs::remove_dir_all(&temp_dir);
        }
    });
}

#[cfg(test)]
#[path = "../tests/archive_tests.rs"]
mod tests;
