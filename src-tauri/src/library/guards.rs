use std::fs;
use std::path::{Path, PathBuf};

pub const LIBRARY_MOVE_LOCK_FILE: &str = ".quivit-library-move.lock";
pub const CONFIG_MOVE_LOCK_FILE: &str = "quivit-library-move.lock";

pub fn normalized_path(path: &Path) -> String {
    let display = crate::config::display_path(path);
    let trimmed = crate::utils::trim_trailing_slashes(&display);
    let value = if trimmed.len() <= 2 && display.len() > trimmed.len() {
        format!("{trimmed}\\")
    } else {
        trimmed.to_string()
    };
    #[cfg(windows)]
    {
        return value.to_ascii_lowercase();
    }
    #[cfg(not(windows))]
    value
}

pub fn path_is_within(path: &Path, root: &Path) -> bool {
    let path = normalized_path(path);
    let root = normalized_path(root);
    path == root || path.starts_with(&format!("{root}\\"))
}

pub fn is_within_library(path: &Path) -> bool {
    let Ok(library_root) = crate::config::configured_library_dir() else {
        return false;
    };
    path_is_within(path, &library_root)
}

pub fn same_path(left: &Path, right: &Path) -> bool {
    normalized_path(left) == normalized_path(right)
}

pub fn is_filesystem_root(path: &Path) -> bool {
    path.parent().is_none() || path.parent().is_some_and(|parent| same_path(path, parent))
}

#[cfg(windows)]
pub fn is_reparse_point(path: &Path) -> Result<bool, String> {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("Failed to inspect '{}': {err}", path.display()))?;
    Ok(metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

#[cfg(not(windows))]
pub fn is_reparse_point(path: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("Failed to inspect '{}': {err}", path.display()))?;
    Ok(metadata.file_type().is_symlink())
}

pub fn library_write_scope(path: &Path) -> Result<Option<PathBuf>, String> {
    let library_root = crate::config::configured_library_dir()?;
    Ok(path_is_within(path, &library_root).then_some(library_root))
}

pub fn ensure_library_root_writable(library_root: &Path) -> Result<(), String> {
    let config_lock = crate::config::get_config_path().with_file_name(CONFIG_MOVE_LOCK_FILE);
    if config_lock.exists() || library_root.join(LIBRARY_MOVE_LOCK_FILE).exists() {
        return Err("Library relocation is in progress. The pending write was cancelled.".into());
    }
    Ok(())
}

pub fn relocation_lock_ancestor(path: &Path) -> Option<PathBuf> {
    let mut current = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()?.to_path_buf()
    };
    loop {
        if current.join(LIBRARY_MOVE_LOCK_FILE).exists() {
            return Some(current);
        }
        let parent = current.parent()?.to_path_buf();
        if same_path(&current, &parent) {
            return None;
        }
        current = parent;
    }
}

pub fn ensure_library_write_allowed(path: &Path) -> Result<(), String> {
    // The active root is always writable while no move is in flight. Resolve
    // it first so a stale retired entry can never lock out the Library.
    if let Some(library_root) = library_write_scope(path)? {
        ensure_library_root_writable(&library_root)?;
        return Ok(());
    }
    let is_retired_path = crate::config::load_config_early()
        .frontend_data
        .get(crate::config::RETIRED_LIBRARY_PATHS_KEY)
        .and_then(|value| value.as_array())
        .is_some_and(|paths| {
            paths
                .iter()
                .filter_map(|value| value.as_str())
                .any(|retired| {
                    let retired = Path::new(retired);
                    retired.is_absolute() && path_is_within(path, retired)
                })
        });
    if is_retired_path {
        return Err("This Library location was retired by a live move. Reload QuiviT before downloading or changing its files.".into());
    }
    if relocation_lock_ancestor(path).is_some() {
        return Err("Library relocation is in progress. The pending write was cancelled.".into());
    }
    Ok(())
}
