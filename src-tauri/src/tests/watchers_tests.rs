use super::*;

struct TempDirGuard(PathBuf);

impl TempDirGuard {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "quivit_watcher_{name}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn test_watcher_state_new_initializes_none() {
    let state = WatcherState::new();
    assert!(state.watcher.is_none());
    assert!(state.parent_watcher.is_none());
    assert!(state.config_watcher.is_none());
    assert!(state.library_watcher.is_none());
}

#[test]
fn test_library_change_debounce_constant() {
    assert_eq!(LIBRARY_CHANGE_DEBOUNCE_MS, 250);
}

#[test]
fn test_validate_library_watch_path() {
    let dir = TempDirGuard::new("validate");
    assert!(validate_library_watch_path(dir.path()).is_ok());

    let missing = dir.path().join("nonexistent_subdir");
    assert!(validate_library_watch_path(&missing).is_err());
}
