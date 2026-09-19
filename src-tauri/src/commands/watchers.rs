use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{Emitter, Manager};

const LIBRARY_CHANGE_DEBOUNCE_MS: u64 = 250;

pub struct WatcherState {
    pub watcher: Option<RecommendedWatcher>,
    pub parent_watcher: Option<RecommendedWatcher>,
    pub config_watcher: Option<RecommendedWatcher>,
    pub library_watcher: Option<RecommendedWatcher>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            watcher: None,
            parent_watcher: None,
            config_watcher: None,
            library_watcher: None,
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
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            match event.kind {
                notify::EventKind::Create(_)
                | notify::EventKind::Remove(_)
                | notify::EventKind::Modify(notify::event::ModifyKind::Name(_)) => {
                    let _ = app_clone.emit("directory-changed", ());
                }
                _ => {}
            }
        }
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

pub fn spawn_library_watcher(app: tauri::AppHandle) {
    let library_path = match crate::commands::shell::get_library_dir() {
        Ok(path) => path,
        Err(err) => {
            eprintln!("Failed to resolve Library directory for watching: {err}");
            return;
        }
    };
    let (change_tx, change_rx) = mpsc::channel::<()>();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            let changes_library_tree = matches!(
                event.kind,
                notify::EventKind::Create(_)
                    | notify::EventKind::Remove(_)
                    | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
            ) || matches!(
                event.kind,
                notify::EventKind::Modify(notify::event::ModifyKind::Data(_))
            ) && event.paths.iter().any(|path| {
                path.file_name().and_then(|name| name.to_str()) == Some("gallery.json")
            });

            if changes_library_tree {
                let _ = change_tx.send(());
            }
        }
    }) {
        Ok(watcher) => watcher,
        Err(err) => {
            eprintln!("Failed to create Library watcher: {err}");
            return;
        }
    };

    if let Err(err) = watcher.watch(Path::new(&library_path), RecursiveMode::Recursive) {
        eprintln!("Failed to watch Library directory: {err}");
        return;
    }

    app.state::<Mutex<WatcherState>>()
        .lock()
        .unwrap()
        .library_watcher = Some(watcher);

    std::thread::spawn(move || {
        while change_rx.recv().is_ok() {
            loop {
                match change_rx.recv_timeout(Duration::from_millis(LIBRARY_CHANGE_DEBOUNCE_MS)) {
                    Ok(()) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            let _ = app.emit("library-changed", ());
        }
    });
}

pub fn spawn_config_file_watcher(app: tauri::AppHandle) {
    let state = app.state::<Mutex<WatcherState>>();
    let mut state = state.lock().unwrap();

    let config_path = crate::config::get_config_path();
    if let Some(parent) = config_path.parent() {
        let parent_path = parent.to_path_buf();
        let app_clone = app.clone();

        let last_emit = std::sync::Arc::new(std::sync::Mutex::new(std::time::Instant::now()));

        let watcher_res = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(event) = res {
                if let notify::EventKind::Modify(_) = event.kind {
                    if event
                        .paths
                        .iter()
                        .any(|p| p.file_name() == config_path.file_name())
                    {
                        let mut last = last_emit.lock().unwrap();
                        if last.elapsed() > std::time::Duration::from_millis(500) {
                            *last = std::time::Instant::now();
                            let _ = app_clone.emit("config-changed", ());
                        }
                    }
                }
            }
        });

        if let Ok(mut watcher) = watcher_res {
            if watcher
                .watch(&parent_path, notify::RecursiveMode::NonRecursive)
                .is_ok()
            {
                state.config_watcher = Some(watcher);
            }
        }
    }
}
