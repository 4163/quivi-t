use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use notify::event::ModifyKind;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{Emitter, Manager};

const DIRECTORY_CHANGE_DEBOUNCE_MS: u64 = 250;
const LIBRARY_CHANGE_DEBOUNCE_MS: u64 = 250;
const CONFIG_CHANGE_COOLDOWN_MS: u64 = 500;

#[derive(Default)]
pub struct WatcherState {
    watcher: Option<RecommendedWatcher>,
    parent_watcher: Option<RecommendedWatcher>,
    config_watcher: Option<RecommendedWatcher>,
    library_watcher: Option<RecommendedWatcher>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_directory_watchers(
        &mut self,
        watcher: Option<RecommendedWatcher>,
        parent_watcher: Option<RecommendedWatcher>,
    ) -> (Option<RecommendedWatcher>, Option<RecommendedWatcher>) {
        (
            std::mem::replace(&mut self.watcher, watcher),
            std::mem::replace(&mut self.parent_watcher, parent_watcher),
        )
    }

    pub fn set_library_watcher(
        &mut self,
        watcher: Option<RecommendedWatcher>,
    ) -> Option<RecommendedWatcher> {
        std::mem::replace(&mut self.library_watcher, watcher)
    }

    pub fn set_config_watcher(
        &mut self,
        watcher: Option<RecommendedWatcher>,
    ) -> Option<RecommendedWatcher> {
        std::mem::replace(&mut self.config_watcher, watcher)
    }
}

fn lock_watcher_state(state: &Mutex<WatcherState>) -> MutexGuard<'_, WatcherState> {
    state.lock().unwrap_or_else(|e| e.into_inner())
}

fn spawn_debounced_emitter(
    debounce: Duration,
    on_fire: impl Fn() + Send + 'static,
) -> mpsc::Sender<()> {
    let (tx, rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            loop {
                match rx.recv_timeout(debounce) {
                    Ok(()) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            on_fire();
        }
    });
    tx
}

fn is_tmp_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("tmp"))
}

fn is_tmp_only_event(event: &Event) -> bool {
    !event.paths.is_empty() && event.paths.iter().all(|path| is_tmp_path(path))
}

fn should_emit_directory_event(event: &Event) -> bool {
    if is_tmp_only_event(event) {
        return false;
    }
    matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_)
    )
}

fn path_matches_child(event_path: &Path, child_path: &Path) -> bool {
    if event_path == child_path {
        return true;
    }
    let (Some(event_name), Some(child_name)) = (event_path.file_name(), child_path.file_name())
    else {
        return false;
    };
    #[cfg(windows)]
    if let (Some(event_str), Some(child_str)) = (event_name.to_str(), child_name.to_str()) {
        return event_str.eq_ignore_ascii_case(child_str);
    }
    event_name == child_name
}

fn should_check_parent_event(event: &Event, child_path: &Path) -> bool {
    if !matches!(
        event.kind,
        EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
    ) {
        return false;
    }
    event
        .paths
        .iter()
        .any(|path| path_matches_child(path, child_path))
}

fn should_emit_library_event(event: &Event) -> bool {
    if is_tmp_only_event(event) {
        return false;
    }
    matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
    ) || (matches!(event.kind, EventKind::Modify(ModifyKind::Data(_)))
        && event.paths.iter().any(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("gallery.json"))
        }))
}

fn is_watched_config_file(path: &Path, config_path: &Path) -> bool {
    let Some(file_name) = path.file_name() else {
        return false;
    };
    if config_path.file_name().is_some_and(|expected| {
        #[cfg(windows)]
        if let (Some(a), Some(b)) = (file_name.to_str(), expected.to_str()) {
            return a.eq_ignore_ascii_case(b);
        }
        file_name == expected
    }) {
        return true;
    }
    file_name.to_str().is_some_and(|name| {
        crate::config::ROAMING_FILES
            .iter()
            .any(|roaming| name.eq_ignore_ascii_case(roaming))
    })
}

fn should_emit_config_event(event: &Event, config_path: &Path) -> bool {
    if !matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
        return false;
    }
    event
        .paths
        .iter()
        .any(|path| !is_tmp_path(path) && is_watched_config_file(path, config_path))
}

fn build_directory_watchers(
    app: &tauri::AppHandle,
    dir_path: &Path,
) -> Result<(RecommendedWatcher, Option<RecommendedWatcher>), String> {
    let app_clone = app.clone();
    let change_tx = spawn_debounced_emitter(
        Duration::from_millis(DIRECTORY_CHANGE_DEBOUNCE_MS),
        move || {
            let _ = app_clone.emit("directory-changed", ());
        },
    );

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            if should_emit_directory_event(&event) {
                let _ = change_tx.send(());
            }
        }
    })
    .map_err(|e| format!("Failed to create watcher: {e}"))?;

    watcher
        .watch(dir_path, RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch directory: {e}"))?;

    // Watch the parent for a move, rename, or deletion of this directory.
    // Emit at most once after this path disappears.
    let mut parent_watcher_opt = None;
    if let Some(parent) = dir_path.parent() {
        if !parent.as_os_str().is_empty() {
            let app_clone = app.clone();
            let child_path = dir_path.to_path_buf();
            let emitted_missing = AtomicBool::new(false);
            let mut parent_watcher =
                notify::recommended_watcher(move |res: notify::Result<Event>| {
                    let Ok(event) = res else {
                        return;
                    };
                    if !should_check_parent_event(&event, &child_path) {
                        return;
                    }
                    if !child_path.exists() && !emitted_missing.swap(true, Ordering::AcqRel) {
                        let _ = app_clone.emit("directory-changed", ());
                    }
                })
                .map_err(|e| format!("Failed to create parent watcher: {e}"))?;

            if parent_watcher
                .watch(parent, RecursiveMode::NonRecursive)
                .is_ok()
            {
                parent_watcher_opt = Some(parent_watcher);
            }
        }
    }

    Ok((watcher, parent_watcher_opt))
}

#[tauri::command]
pub fn watch_directory(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<Mutex<WatcherState>>();
    match build_directory_watchers(&app, Path::new(&path)) {
        Ok((watcher, parent_watcher)) => {
            let replaced = {
                let mut guard = lock_watcher_state(&state);
                guard.set_directory_watchers(Some(watcher), parent_watcher)
            };
            drop(replaced);
            Ok(())
        }
        Err(err) => {
            let replaced = {
                let mut guard = lock_watcher_state(&state);
                guard.set_directory_watchers(None, None)
            };
            drop(replaced);
            Err(err)
        }
    }
}

fn create_library_watcher(
    app: tauri::AppHandle,
    library_path: &Path,
) -> Result<RecommendedWatcher, String> {
    let change_tx = spawn_debounced_emitter(
        Duration::from_millis(LIBRARY_CHANGE_DEBOUNCE_MS),
        move || {
            let _ = app.emit("library-changed", ());
        },
    );

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            if should_emit_library_event(&event) {
                let _ = change_tx.send(());
            }
        }
    })
    .map_err(|err| format!("Failed to create Library watcher: {err}"))?;

    watcher
        .watch(library_path, RecursiveMode::Recursive)
        .map_err(|err| format!("Failed to watch Library directory: {err}"))?;

    Ok(watcher)
}

pub fn validate_library_watch_path(path: &Path) -> Result<(), String> {
    let mut watcher = notify::recommended_watcher(|_| {})
        .map_err(|err| format!("Failed to create Library watcher: {err}"))?;
    watcher
        .watch(path, RecursiveMode::Recursive)
        .map_err(|err| format!("Failed to watch Library directory: {err}"))
}

#[tauri::command]
pub fn rebind_library_watcher(app: tauri::AppHandle) -> Result<(), String> {
    let dir = crate::config::configured_library_dir()?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|err| format!("Failed to create Library directory: {err}"))?;
    }
    let watcher = create_library_watcher(app.clone(), &dir)?;
    let state = app.state::<Mutex<WatcherState>>();
    let replaced = {
        let mut guard = lock_watcher_state(&state);
        guard.set_library_watcher(Some(watcher))
    };
    drop(replaced);
    Ok(())
}

pub fn spawn_library_watcher(app: tauri::AppHandle) {
    if let Err(err) = rebind_library_watcher(app) {
        eprintln!("Failed to start Library watcher: {err}");
    }
}

pub fn spawn_config_file_watcher(app: tauri::AppHandle) {
    spawn_config_file_watcher_for_path(app, crate::config::get_config_path());
}

pub fn spawn_config_file_watcher_for_path(app: tauri::AppHandle, config_path: PathBuf) {
    let Some(parent) = config_path.parent() else {
        return;
    };
    if parent.as_os_str().is_empty() {
        return;
    }
    let parent_path = parent.to_path_buf();
    let app_clone = app.clone();
    let last_emit = Arc::new(Mutex::new(Instant::now()));

    let Ok(mut watcher) = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(event) = res else {
            return;
        };
        if !should_emit_config_event(&event, &config_path) {
            return;
        }
        let mut last = last_emit.lock().unwrap_or_else(|e| e.into_inner());
        if last.elapsed() > Duration::from_millis(CONFIG_CHANGE_COOLDOWN_MS) {
            *last = Instant::now();
            drop(last);
            crate::config::invalidate_library_cache();
            let _ = app_clone.emit("config-changed", ());
        }
    }) else {
        return;
    };

    if watcher
        .watch(&parent_path, RecursiveMode::NonRecursive)
        .is_err()
    {
        return;
    }

    let state = app.state::<Mutex<WatcherState>>();
    let replaced = {
        let mut guard = lock_watcher_state(&state);
        guard.set_config_watcher(Some(watcher))
    };
    drop(replaced);
}

#[cfg(test)]
#[path = "../tests/watchers_tests.rs"]
mod tests;
