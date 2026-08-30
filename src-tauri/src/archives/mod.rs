mod cache;
mod encoding;
mod rar;
mod sevenz;
mod tar;
mod zip;

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::models::ArchiveReadResult;

pub(crate) use cache::archive_entry_temp_path;
pub(crate) use cache::archive_temp_dir;
pub use cache::ArchiveCache;
#[cfg(test)]
pub(crate) use rar::list_rar_entries;
#[cfg(test)]
pub(crate) use sevenz::extract_7z_to_temp;
#[cfg(test)]
pub(crate) use sevenz::list_7z_entries;
#[cfg(test)]
pub(crate) use tar::extract_tar_entry;
#[cfg(test)]
pub(crate) use tar::extract_tar_to_temp;
#[cfg(test)]
pub(crate) use tar::list_tar_entries;
#[cfg(test)]
pub(crate) use zip::extract_zip_entry;
#[cfg(test)]
pub(crate) use zip::list_zip_entries;

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

pub enum ArchiveEntryData {
    Ready(Arc<[u8]>),
    PendingExtraction {
        file_path: PathBuf,
        notify: cache::ExtractNotify,
    },
}

impl ArchiveEntryData {
    pub fn wait_for_data(self, entry_name: &str) -> Result<Vec<u8>, String> {
        match self {
            Self::Ready(data) => Ok(data.to_vec()),
            Self::PendingExtraction { file_path, notify } => {
                let (lock, cvar) = &*notify;
                let set = lock.lock().map_err(|e| e.to_string())?;
                let _ = cvar
                    .wait_timeout_while(set, Duration::from_secs(30), |pending| {
                        !pending.contains(entry_name)
                    })
                    .map_err(|e| e.to_string())?;

                fs::read(&file_path)
                    .map_err(|e| format!("Cannot read extracted archive entry {entry_name}: {e}"))
            }
        }
    }
}

impl ArchiveCache {
    pub fn prepare_archive(&mut self, archive_path: &str) -> Result<ArchiveReadResult, String> {
        let kind = ArchiveKind::from_path(archive_path)?;
        let files = match kind {
            ArchiveKind::Zip => {
                let (files, zip_archive) = zip::list_zip_entries(archive_path)?;
                self.prepare_archive_state(archive_path, kind, Some(zip_archive));
                files
            }
            ArchiveKind::Rar => {
                self.prepare_archive_state(archive_path, kind, None);
                rar::list_rar_entries(archive_path)?
            }
            ArchiveKind::SevenZ => {
                self.prepare_archive_state(archive_path, kind, None);
                sevenz::list_7z_entries(archive_path)?
            }
            ArchiveKind::Tar => {
                self.prepare_archive_state(archive_path, kind, None);
                tar::list_tar_entries(archive_path)?
            }
        };

        Ok(ArchiveReadResult {
            files,
            archive_path: archive_path.to_string(),
        })
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
        zip::read_zip_entry_header(&mut archive, entry_name, limit)
    }

    // Architectural Note: RAR, 7Z, and TAR formats currently wait for the entire entry
    // to be fully extracted to disk before we can slice the header out of it.
    // Unlike ZIP, we do not stream the header from these formats directly.
    // This behavior is intentional/maintained for now as the temp extractor handles it.
    fn read_temp_entry_header(
        &mut self,
        archive_path: &str,
        entry_name: &str,
        limit: usize,
    ) -> Result<Vec<u8>, String> {
        let data = self.read_temp_entry_bytes(archive_path, entry_name)?;
        let bytes = data.wait_for_data(entry_name)?;
        let end = bytes.len().min(limit);
        Ok(bytes[..end].to_vec())
    }

    fn prepare_archive_state(
        &mut self,
        archive_path: &str,
        kind: ArchiveKind,
        zip_archive: Option<cache::ZipArchive>,
    ) {
        if self.contains_archive(archive_path) {
            self.touch_archive(archive_path);
            return;
        }

        let single = match kind {
            ArchiveKind::Zip => cache::SingleArchiveCache::with_zip_archive(zip_archive),
            ArchiveKind::Rar | ArchiveKind::SevenZ | ArchiveKind::Tar => {
                let temp_dir = archive_temp_dir(archive_path);
                fs::create_dir_all(&temp_dir).ok();
                let single = cache::SingleArchiveCache::with_temp_dir(temp_dir.clone());
                spawn_temp_extractor(
                    kind,
                    archive_path.to_string(),
                    temp_dir,
                    single.notify(),
                    single.cancel_flag(),
                );
                single
            }
        };

        self.register_archive(archive_path.to_string(), single);
    }

    fn read_zip_entry_bytes(
        &mut self,
        archive_path: &str,
        entry_name: &str,
    ) -> Result<cache::SharedEntryBytes, String> {
        if let Some(cached) = self.get_zip_entry(archive_path, entry_name) {
            return Ok(cached);
        }

        self.prepare_archive_state(archive_path, ArchiveKind::Zip, None);

        let shared = if let Some(data) = self.read_from_open_zip(archive_path, entry_name) {
            data
        } else {
            zip::extract_zip_entry(archive_path, entry_name)
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
        let kind = ArchiveKind::from_path(archive_path)?;
        self.prepare_archive_state(archive_path, kind, None);

        let (temp_dir, notify) = self.temp_extraction_state(archive_path).ok_or_else(|| {
            format!("Archive is not prepared for temporary extraction: {archive_path}")
        })?;
        let file_path = archive_entry_temp_path(&temp_dir, entry_name)
            .ok_or_else(|| format!("Unsafe archive entry path: {entry_name}"))?;

        if let Ok(bytes) = fs::read(&file_path) {
            return Ok(ArchiveEntryData::Ready(bytes.into()));
        }

        Ok(ArchiveEntryData::PendingExtraction { file_path, notify })
    }
}

fn spawn_temp_extractor(
    kind: ArchiveKind,
    archive_path: String,
    temp_dir: PathBuf,
    notify: cache::ExtractNotify,
    cancel_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    std::thread::spawn(move || match kind {
        ArchiveKind::Rar => rar::extract_rar_to_temp(archive_path, temp_dir, notify, cancel_flag),
        ArchiveKind::SevenZ => {
            sevenz::extract_7z_to_temp(archive_path, temp_dir, notify, cancel_flag)
        }
        ArchiveKind::Tar => tar::extract_tar_to_temp(archive_path, temp_dir, notify, cancel_flag),
        ArchiveKind::Zip => {}
    });
}

pub(crate) use encoding::decode_cjk_name;
