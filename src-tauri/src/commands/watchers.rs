use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{Emitter, Manager};

pub struct WatcherState {
    pub watcher: Option<RecommendedWatcher>,
    pub parent_watcher: Option<RecommendedWatcher>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            watcher: None,
            parent_watcher: None,
        }
    }
}

#[tauri::command]
pub fn watch_directory(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<Mutex<WatcherState>>();
    let mut state = state.lock().unwrap();

    // Stop tracking the old directory.
    state.watcher = None;
    state.parent_watcher = None;

    // Watch for changes inside the directory.
    let app_clone = app.clone();
    let mut watcher = notify::recommended_watcher(move |_res: notify::Result<Event>| {
        let _ = app_clone.emit("directory-changed", ());
    })
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .watch(Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch directory: {}", e))?;

    state.watcher = Some(watcher);

    // Watch the parent for a move, rename, or deletion of this directory.
    // Emit only after this path disappears.
    let dir_path = PathBuf::from(&path);
    if let Some(parent) = dir_path.parent() {
        if !parent.as_os_str().is_empty() {
            let app_clone2 = app.clone();
            let child_path = dir_path.clone();
            let mut parent_watcher =
                notify::recommended_watcher(move |_res: notify::Result<Event>| {
                    if !child_path.exists() {
                        let _ = app_clone2.emit("directory-changed", ());
                    }
                })
                .map_err(|e| format!("Failed to create parent watcher: {}", e))?;

            let _ = parent_watcher.watch(parent, RecursiveMode::NonRecursive);
            state.parent_watcher = Some(parent_watcher);
        }
    }

    Ok(())
}
