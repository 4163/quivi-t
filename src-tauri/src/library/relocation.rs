use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::config::{self, AppConfig, LIBRARY_PATH_KEY, RETIRED_LIBRARY_PATHS_KEY};
use super::guards::{
    is_filesystem_root, is_reparse_point, path_is_within, same_path,
    CONFIG_MOVE_LOCK_FILE, LIBRARY_MOVE_LOCK_FILE,
};

pub const STAGING_PREFIX: &str = ".quivit-library-staging-";
pub const RETIRED_LIBRARY_PATH_LIMIT: usize = 16;

static MOVE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMoveResult {
    pub old_path: String,
    pub library_path: String,
    pub cleanup_warning: Option<String>,
    pub watcher_warning: Option<String>,
}

pub struct LibraryMoveLock {
    config_lock: PathBuf,
    library_lock: PathBuf,
    keep_library_lock: bool,
    #[cfg(windows)]
    _publication: crate::platform::process::ProcessLock,
}

impl Drop for LibraryMoveLock {
    fn drop(&mut self) {
        if !self.keep_library_lock {
            let _ = fs::remove_file(&self.library_lock);
        }
        let _ = fs::remove_file(&self.config_lock);
    }
}

fn create_lock(path: &Path, body: &str) -> Result<(), String> {
    let mut lock = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| {
            format!(
                "Library relocation is already in progress: {}",
                path.display()
            )
        })?;
    lock.write_all(body.as_bytes())
        .map_err(|err| format!("Failed to write relocation lock: {err}"))
}

impl LibraryMoveLock {
    pub fn acquire(source: &Path, destination: &Path) -> Result<Self, String> {
        #[cfg(windows)]
        let publication = crate::platform::process::ProcessLock::acquire(super::publication::PUBLICATION_MUTEX)?;
        let configured = fs::canonicalize(config::configured_library_dir()?)
            .map_err(|error| error.to_string())?;
        if !same_path(source, &configured) {
            return Err("Library location changed before relocation started".into());
        }
        let config_lock = config::get_config_path().with_file_name(CONFIG_MOVE_LOCK_FILE);
        let library_lock = source.join(LIBRARY_MOVE_LOCK_FILE);
        let body = format!(
            "pid={}\nsource={}\ndestination={}\n",
            std::process::id(),
            source.display(),
            destination.display()
        );

        create_lock(&config_lock, &body)?;
        if let Err(err) = create_lock(&library_lock, &body) {
            let _ = fs::remove_file(&config_lock);
            return Err(err);
        }

        Ok(Self {
            config_lock,
            library_lock,
            keep_library_lock: false,
            #[cfg(windows)]
            _publication: publication,
        })
    }

    pub fn retain_library_lock(&mut self) {
        self.keep_library_lock = true;
    }
}

pub fn ensure_empty_writable_destination(source: &Path, destination: &Path) -> Result<(), String> {
    if !destination.is_absolute() {
        return Err("Library location must be an absolute path".into());
    }
    if !destination.is_dir() {
        return Err("Choose an existing empty folder for the Library".into());
    }
    if is_filesystem_root(destination) {
        return Err("The Library cannot be a drive root".into());
    }
    if is_reparse_point(destination)? {
        return Err("The Library location cannot be a symlink or reparse point".into());
    }
    if same_path(source, destination)
        || path_is_within(destination, source)
        || path_is_within(source, destination)
    {
        return Err("The new Library location cannot contain, be contained by, or equal the current Library".into());
    }
    if fs::read_dir(destination)
        .map_err(|err| format!("Failed to read Library destination: {err}"))?
        .next()
        .is_some()
    {
        return Err("Choose an empty folder for the Library. Existing files are never merged or overwritten.".into());
    }

    let probe = destination.join(format!(
        ".quivit-library-write-probe-{}-{}",
        std::process::id(),
        MOVE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    File::create(&probe)
        .map_err(|err| format!("The Library destination is not writable: {err}"))?;
    fs::remove_file(&probe)
        .map_err(|err| format!("Failed to remove Library write probe: {err}"))?;
    Ok(())
}

#[derive(Clone)]
pub struct CopiedFile {
    pub relative_path: PathBuf,
    pub bytes: u64,
}

pub fn copy_library_tree(
    source_root: &Path,
    current_source: &Path,
    destination: &Path,
    files: &mut Vec<CopiedFile>,
) -> Result<(), String> {
    for entry in fs::read_dir(current_source)
        .map_err(|err| format!("Failed to read Library source: {err}"))?
    {
        let entry = entry.map_err(|err| format!("Failed to read Library source entry: {err}"))?;
        let source_path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|err| format!("Failed to inspect Library source entry: {err}"))?;
        if source_path
            .file_name()
            .is_some_and(|name| name == LIBRARY_MOVE_LOCK_FILE)
            && file_type.is_file()
        {
            continue;
        }
        if is_reparse_point(&source_path)? {
            return Err(format!(
                "Library relocation does not follow symlinks or reparse points: {}",
                source_path.display()
            ));
        }

        let relative_path = source_path
            .strip_prefix(source_root)
            .map_err(|err| format!("Failed to build Library copy path: {err}"))?;
        let destination_path = destination.join(relative_path);
        if file_type.is_dir() {
            fs::create_dir_all(&destination_path)
                .map_err(|err| format!("Failed to create Library destination folder: {err}"))?;
            copy_library_tree(source_root, &source_path, destination, files)?;
            continue;
        }
        if !file_type.is_file() {
            return Err(format!(
                "Library relocation cannot copy '{}'.",
                source_path.display()
            ));
        }

        if let Some(parent) = destination_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("Failed to create Library destination folder: {err}"))?;
        }
        let bytes = fs::copy(&source_path, &destination_path)
            .map_err(|err| format!("Failed to copy '{}': {err}", source_path.display()))?;
        files.push(CopiedFile {
            relative_path: relative_path.to_path_buf(),
            bytes,
        });
    }
    Ok(())
}

pub fn verify_library_copy(destination: &Path, files: &[CopiedFile]) -> Result<(), String> {
    for copied in files {
        let path = destination.join(&copied.relative_path);
        let metadata = fs::metadata(&path).map_err(|err| {
            format!(
                "Library copy verification could not read '{}': {err}",
                path.display()
            )
        })?;
        if !metadata.is_file() || metadata.len() != copied.bytes {
            return Err(format!(
                "Library copy verification failed for '{}'.",
                path.display()
            ));
        }
    }
    Ok(())
}

pub fn staging_marker_path(staging: &Path, operation_id: &str) -> PathBuf {
    staging.join(format!("{STAGING_PREFIX}{operation_id}.json"))
}

pub fn write_staging_marker(staging: &Path, operation_id: &str) -> Result<(), String> {
    fs::write(staging_marker_path(staging, operation_id), operation_id)
        .map_err(|err| format!("Failed to mark staged Library copy: {err}"))
}

pub fn cleanup_staged_destination(path: &Path, operation_id: &str) -> Result<(), String> {
    let marker = staging_marker_path(path, operation_id);
    let recorded = fs::read_to_string(&marker)
        .map_err(|err| format!("Failed to verify staged Library copy: {err}"))?;
    if recorded != operation_id {
        return Err(
            "Refusing to remove a destination that does not belong to this Library relocation."
                .into(),
        );
    }
    fs::remove_dir_all(path)
        .map_err(|err| format!("Failed to remove incomplete Library copy: {err}"))
}

pub fn clear_owned_tree(path: &Path, operation_id: &str) -> Result<(), String> {
    cleanup_staged_destination(path, operation_id)
}

pub fn publish_staging(staging: &Path, destination: &Path) -> Result<(), String> {
    fs::remove_dir(destination)
        .map_err(|err| format!("Library destination changed during relocation: {err}"))?;
    if let Err(err) = fs::rename(staging, destination) {
        let _ = fs::create_dir(destination);
        return Err(format!("Failed to publish relocated Library: {err}"));
    }
    Ok(())
}

pub fn remap_path(path: &str, source: &Path, destination: &Path) -> Option<String> {
    let candidate = Path::new(path);
    if !path_is_within(candidate, source) {
        return None;
    }
    let source_text = config::display_path(source).replace('/', "\\");
    let input_text = config::display_path(candidate).replace('/', "\\");
    let suffix = input_text.get(source_text.len()..).unwrap_or("");
    Some(format!("{}{}", config::display_path(destination), suffix))
}

pub fn remap_library_paths(config: &mut AppConfig, source: &Path, destination: &Path) {
    let Some(data) = config.frontend_data.as_object_mut() else {
        return;
    };

    for key in ["last_opened_path"] {
        if let Some(path) = data.get(key).and_then(|value| value.as_str()) {
            if let Some(remapped) = remap_path(path, source, destination) {
                data.insert(key.to_string(), serde_json::json!(remapped));
            }
        }
    }

    if let Some(last_active) = data
        .get_mut("last_active_image")
        .and_then(|value| value.as_object_mut())
    {
        for key in ["container", "path"] {
            if let Some(path) = last_active.get(key).and_then(|value| value.as_str()) {
                if let Some(remapped) = remap_path(path, source, destination) {
                    last_active.insert(key.to_string(), serde_json::json!(remapped));
                }
            }
        }
    }

    if let Some(favorites) = data
        .get_mut("favorites")
        .and_then(|value| value.as_object_mut())
    {
        if let Some(loadouts) = favorites
            .get_mut("loadouts")
            .and_then(|value| value.as_array_mut())
        {
            for loadout in loadouts {
                if let Some(items) = loadout
                    .get_mut("items")
                    .and_then(|value| value.as_array_mut())
                {
                    for item in items {
                        let Some(item_obj) = item.as_object_mut() else {
                            continue;
                        };
                        let Some(path) = item_obj.get("path").and_then(|value| value.as_str())
                        else {
                            continue;
                        };
                        let (filesystem_path, archive_entry) =
                            crate::archives::split_archive_path(path);
                        if let Some(remapped) = remap_path(filesystem_path, source, destination) {
                            let path = if archive_entry.is_empty() {
                                remapped
                            } else {
                                crate::archives::format_archive_entry_path(&remapped, archive_entry)
                            };
                            item_obj.insert("path".to_string(), serde_json::json!(path));
                        }
                    }
                }
            }
        }
    }

    let Some(sort_preferences) = data
        .get_mut("directory_sort")
        .and_then(|value| value.as_object_mut())
    else {
        return;
    };
    let remapped = sort_preferences
        .iter()
        .filter_map(|(path, value)| {
            remap_path(path, source, destination)
                .map(|new_path| (path.clone(), new_path, value.clone()))
        })
        .collect::<Vec<_>>();
    for (old_path, new_path, value) in remapped {
        sort_preferences.remove(&old_path);
        sort_preferences.insert(new_path, value);
    }
}

pub fn carry_live_library_state(config: &mut AppConfig, current: &AppConfig) {
    let (Some(target), Some(source)) = (
        config.frontend_data.as_object_mut(),
        current.frontend_data.as_object(),
    ) else {
        return;
    };

    let drop_last_opened = target.get("continue_last") == Some(&serde_json::Value::Bool(false));
    for key in [
        "last_opened_path",
        "last_active_image",
        "favorites",
        "favorites_collapsed",
        "directory_sort",
    ] {
        if key == "last_opened_path" && drop_last_opened {
            target.remove(key);
            continue;
        }
        match source.get(key) {
            Some(value) => {
                target.insert(key.to_string(), value.clone());
            }
            None => {
                target.remove(key);
            }
        }
    }
}

pub fn retain_retired_library_path(
    config: &mut AppConfig,
    current: &AppConfig,
    source: &Path,
    destination: &Path,
) {
    let mut retired = current
        .frontend_data
        .get(RETIRED_LIBRARY_PATHS_KEY)
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && !same_path(path, destination))
        .map(|path| config::display_path(&path))
        .collect::<Vec<_>>();
    let source_str = config::display_path(source);
    if !retired
        .iter()
        .any(|path| path.eq_ignore_ascii_case(&source_str))
    {
        retired.push(source_str);
    }
    if retired.len() > RETIRED_LIBRARY_PATH_LIMIT {
        retired.drain(..retired.len() - RETIRED_LIBRARY_PATH_LIMIT);
    }
    config.frontend_data[RETIRED_LIBRARY_PATHS_KEY] = serde_json::json!(retired);
}

pub fn relocate_library(
    app_handle: AppHandle,
    mut config: AppConfig,
    destination: String,
) -> Result<LibraryMoveResult, String> {
    let current = config::load_config(app_handle.clone());
    if current.portable_mode != config.portable_mode {
        return Err("Apply the config storage mode change before moving the Library.".into());
    }

    let configured_source = config::configured_library_dir()?;
    if is_reparse_point(&configured_source)? {
        return Err("The current Library location is not safe to relocate.".into());
    }
    let source = fs::canonicalize(&configured_source)
        .map_err(|err| format!("Failed to resolve current Library: {err}"))?;
    if is_filesystem_root(&source) || is_reparse_point(&source)? {
        return Err("The current Library location is not safe to relocate.".into());
    }

    let use_default_destination = destination.trim().is_empty();
    let selected_destination = if use_default_destination {
        let default = config::default_library_dir()?;
        fs::create_dir_all(&default)
            .map_err(|err| format!("Failed to create the default Library folder: {err}"))?;
        default
    } else {
        PathBuf::from(destination.trim())
    };
    if !selected_destination.is_absolute() {
        return Err("Library location must be an absolute path".into());
    }
    if !selected_destination.is_dir() {
        return Err("Choose an existing empty folder for the Library".into());
    }
    if selected_destination.is_dir() && is_reparse_point(&selected_destination)? {
        return Err("The Library location cannot be a symlink or reparse point".into());
    }
    let destination = fs::canonicalize(&selected_destination)
        .map_err(|err| format!("Failed to resolve Library destination: {err}"))?;
    ensure_empty_writable_destination(&source, &destination)?;
    crate::commands::watchers::validate_library_watch_path(&destination)?;

    let mut lock = LibraryMoveLock::acquire(&source, &destination)?;
    app_handle
        .state::<crate::commands::network::DownloadCancelFlag>()
        .0
        .fetch_add(1, Ordering::SeqCst);

    let operation_id = format!(
        "{}-{}",
        std::process::id(),
        MOVE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let staging = destination
        .parent()
        .ok_or("Library destination has no parent folder")?
        .join(format!("{STAGING_PREFIX}{operation_id}"));
    fs::create_dir(&staging)
        .map_err(|err| format!("Failed to create Library staging folder: {err}"))?;
    if let Err(err) = write_staging_marker(&staging, &operation_id) {
        let _ = fs::remove_dir(&staging);
        return Err(err);
    }

    let mut copied_files = Vec::new();
    if let Err(err) = copy_library_tree(&source, &source, &staging, &mut copied_files)
        .and_then(|_| verify_library_copy(&staging, &copied_files))
    {
        let _ = cleanup_staged_destination(&staging, &operation_id);
        return Err(err);
    }

    if let Err(err) = publish_staging(&staging, &destination) {
        let _ = cleanup_staged_destination(&staging, &operation_id);
        return Err(err);
    }

    carry_live_library_state(&mut config, &current);
    if use_default_destination {
        if let Some(data) = config.frontend_data.as_object_mut() {
            data.remove(LIBRARY_PATH_KEY);
        }
    } else {
        config.frontend_data[LIBRARY_PATH_KEY] =
            serde_json::json!(config::display_path(&destination));
    }
    remap_library_paths(&mut config, &source, &destination);
    retain_retired_library_path(&mut config, &current, &source, &destination);
    if let Err(err) = config::save_config_unchecked(app_handle.clone(), config) {
        let _ = cleanup_staged_destination(&destination, &operation_id);
        let _ = fs::create_dir(&destination);
        return Err(format!(
            "Library data was copied, but settings were not updated: {err}"
        ));
    }

    let watcher_warning =
        crate::commands::watchers::rebind_library_watcher(app_handle.clone()).err();
    let _ = app_handle.emit(
        "library-relocated",
        serde_json::json!({
            "oldPath": config::display_path(&source),
            "libraryPath": config::display_path(&destination),
        }),
    );

    std::thread::sleep(std::time::Duration::from_millis(750));
    let cleanup_warning = fs::remove_dir_all(&source)
        .err()
        .map(|err| format!("Library moved, but the old folder could not be removed: {err}"));
    if cleanup_warning.is_some() {
        lock.retain_library_lock();
    }
    let _ = fs::remove_file(staging_marker_path(&destination, &operation_id));

    Ok(LibraryMoveResult {
        old_path: config::display_path(&source),
        library_path: config::display_path(&destination),
        cleanup_warning,
        watcher_warning,
    })
}
