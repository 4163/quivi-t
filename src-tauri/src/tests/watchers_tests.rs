use super::*;
use notify::event::{AccessKind, CreateKind, DataChange, RemoveKind, RenameMode};
use std::sync::atomic::AtomicUsize;

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

fn make_event(kind: EventKind, paths: &[&str]) -> Event {
    let mut event = Event::new(kind);
    event.paths = paths.iter().map(PathBuf::from).collect();
    event
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

#[test]
fn test_directory_event_predicate() {
    let tmp_create = make_event(EventKind::Create(CreateKind::File), &[r"C:\imgs\a.tmp"]);
    assert!(!should_emit_directory_event(&tmp_create));

    let tmp_upper = make_event(
        EventKind::Modify(ModifyKind::Data(DataChange::Any)),
        &[r"C:\imgs\a.TMP"],
    );
    assert!(!should_emit_directory_event(&tmp_upper));

    let rename_from_tmp = make_event(
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
        &[r"C:\imgs\a.tmp", r"C:\imgs\a.png"],
    );
    assert!(should_emit_directory_event(&rename_from_tmp));

    let png_create = make_event(EventKind::Create(CreateKind::File), &[r"C:\imgs\a.png"]);
    assert!(should_emit_directory_event(&png_create));

    let png_remove = make_event(EventKind::Remove(RemoveKind::File), &[r"C:\imgs\a.png"]);
    assert!(should_emit_directory_event(&png_remove));

    let access = make_event(EventKind::Access(AccessKind::Any), &[r"C:\imgs\a.png"]);
    assert!(!should_emit_directory_event(&access));
}

#[test]
fn test_parent_event_predicate() {
    let child = Path::new(r"C:\parent\Album");

    let remove_child = make_event(EventKind::Remove(RemoveKind::Folder), &[r"C:\parent\Album"]);
    assert!(should_check_parent_event(&remove_child, child));

    let rename_child = make_event(
        EventKind::Modify(ModifyKind::Name(RenameMode::From)),
        &[r"C:\parent\Album"],
    );
    assert!(should_check_parent_event(&rename_child, child));

    #[cfg(windows)]
    {
        let rename_child_case = make_event(
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            &[r"C:\parent\album"],
        );
        assert!(should_check_parent_event(&rename_child_case, child));
    }

    let sibling_remove = make_event(
        EventKind::Remove(RemoveKind::Folder),
        &[r"C:\parent\OtherAlbum"],
    );
    assert!(!should_check_parent_event(&sibling_remove, child));

    let child_data_modify = make_event(
        EventKind::Modify(ModifyKind::Data(DataChange::Any)),
        &[r"C:\parent\Album"],
    );
    assert!(!should_check_parent_event(&child_data_modify, child));

    let child_create = make_event(
        EventKind::Create(CreateKind::Folder),
        &[r"C:\parent\Album"],
    );
    assert!(!should_check_parent_event(&child_create, child));
}

#[test]
fn test_library_event_predicate() {
    let tmp_create = make_event(
        EventKind::Create(CreateKind::File),
        &[r"C:\lib\gallery.tmp"],
    );
    assert!(!should_emit_library_event(&tmp_create));

    let tmp_rename_to_final = make_event(
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
        &[r"C:\lib\gallery.tmp", r"C:\lib\gallery.json"],
    );
    assert!(should_emit_library_event(&tmp_rename_to_final));

    let gallery_data = make_event(
        EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        &[r"C:\lib\sub\gallery.json"],
    );
    assert!(should_emit_library_event(&gallery_data));

    let other_data = make_event(
        EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        &[r"C:\lib\sub\image.png"],
    );
    assert!(!should_emit_library_event(&other_data));

    let normal_create = make_event(
        EventKind::Create(CreateKind::File),
        &[r"C:\lib\sub\image.png"],
    );
    assert!(should_emit_library_event(&normal_create));

    let access = make_event(
        EventKind::Access(AccessKind::Any),
        &[r"C:\lib\gallery.json"],
    );
    assert!(!should_emit_library_event(&access));
}

#[test]
fn test_config_event_predicate() {
    let config_path = Path::new(r"C:\cfg\quivit_config.json");

    let cfg_create = make_event(
        EventKind::Create(CreateKind::File),
        &[r"C:\cfg\quivit_config.json"],
    );
    assert!(should_emit_config_event(&cfg_create, config_path));

    let cfg_modify = make_event(
        EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        &[r"C:\cfg\quivit_config.json"],
    );
    assert!(should_emit_config_event(&cfg_modify, config_path));

    let cfg_rename_over = make_event(
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
        &[r"C:\cfg\quivit_config.tmp", r"C:\cfg\quivit_config.json"],
    );
    assert!(should_emit_config_event(&cfg_rename_over, config_path));

    let css_create = make_event(
        EventKind::Create(CreateKind::File),
        &[r"C:\cfg\custom_css.css"],
    );
    assert!(should_emit_config_event(&css_create, config_path));

    let css_modify = make_event(
        EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        &[r"C:\cfg\custom_css.css"],
    );
    assert!(should_emit_config_event(&css_modify, config_path));

    let tmp_only = make_event(
        EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        &[r"C:\cfg\quivit_config.tmp"],
    );
    assert!(!should_emit_config_event(&tmp_only, config_path));

    let unrelated = make_event(
        EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        &[r"C:\cfg\notes.txt"],
    );
    assert!(!should_emit_config_event(&unrelated, config_path));

    let cfg_remove = make_event(
        EventKind::Remove(RemoveKind::File),
        &[r"C:\cfg\quivit_config.json"],
    );
    assert!(!should_emit_config_event(&cfg_remove, config_path));
}

#[test]
fn test_debounced_emitter_coalesces_and_stops_on_drop() {
    struct DropNotifier(Option<mpsc::Sender<()>>);
    impl Drop for DropNotifier {
        fn drop(&mut self) {
            if let Some(tx) = self.0.take() {
                let _ = tx.send(());
            }
        }
    }

    let fire_count = Arc::new(AtomicUsize::new(0));
    let fire_count_cb = Arc::clone(&fire_count);
    let (fired_tx, fired_rx) = mpsc::channel::<Instant>();
    let (dropped_tx, dropped_rx) = mpsc::channel::<()>();
    let drop_guard = DropNotifier(Some(dropped_tx));

    let tx = spawn_debounced_emitter(
        Duration::from_millis(DIRECTORY_CHANGE_DEBOUNCE_MS),
        move || {
            let _keep_alive = &drop_guard;
            fire_count_cb.fetch_add(1, Ordering::SeqCst);
            let _ = fired_tx.send(Instant::now());
        },
    );

    let start = Instant::now();
    for _ in 0..5 {
        tx.send(()).unwrap();
        std::thread::sleep(Duration::from_millis(15));
    }
    let last_signal = Instant::now();

    let fired_at = fired_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("debounced emitter should fire once");
    assert!(
        fired_at.duration_since(last_signal) >= Duration::from_millis(200),
        "expected trailing debounce >= 200ms after last signal, got {:?}",
        fired_at.duration_since(last_signal)
    );
    assert!(fired_at.duration_since(start) >= Duration::from_millis(200));

    // Ensure no second emission arrives.
    assert!(fired_rx.recv_timeout(Duration::from_millis(150)).is_err());
    assert_eq!(fire_count.load(Ordering::SeqCst), 1);

    // Dropping sender must cleanly terminate the debounce thread.
    drop(tx);
    dropped_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("debounce thread should exit when sender is dropped");
}

#[test]
fn test_watcher_state_facade_and_poison_recovery() {
    let state = WatcherState::default();
    assert!(state.watcher.is_none());
    assert!(state.parent_watcher.is_none());
    assert!(state.config_watcher.is_none());
    assert!(state.library_watcher.is_none());

    let shared = Arc::new(Mutex::new(state));
    {
        let mut guard = lock_watcher_state(&shared);
        let w1 = notify::recommended_watcher(|_| {}).unwrap();
        let w2 = notify::recommended_watcher(|_| {}).unwrap();
        let (old_w, old_p) = guard.set_directory_watchers(Some(w1), Some(w2));
        assert!(old_w.is_none());
        assert!(old_p.is_none());
        assert!(guard.watcher.is_some());
        assert!(guard.parent_watcher.is_some());

        let lib_w = notify::recommended_watcher(|_| {}).unwrap();
        assert!(guard.set_library_watcher(Some(lib_w)).is_none());
        assert!(guard.library_watcher.is_some());

        let cfg_w = notify::recommended_watcher(|_| {}).unwrap();
        assert!(guard.set_config_watcher(Some(cfg_w)).is_none());
        assert!(guard.config_watcher.is_some());
    }

    // Poison the mutex and confirm lock_watcher_state recovers cleanly.
    let shared_clone = Arc::clone(&shared);
    let handle = std::thread::spawn(move || {
        let _guard = shared_clone.lock().unwrap();
        panic!("intentional poison for test");
    });
    assert!(handle.join().is_err());
    assert!(shared.is_poisoned());

    let (old_w, old_p, old_lib, old_cfg) = {
        let mut guard = lock_watcher_state(&shared);
        let (old_w, old_p) = guard.set_directory_watchers(None, None);
        let old_lib = guard.set_library_watcher(None);
        let old_cfg = guard.set_config_watcher(None);
        (old_w, old_p, old_lib, old_cfg)
    };
    assert!(old_w.is_some());
    assert!(old_p.is_some());
    assert!(old_lib.is_some());
    assert!(old_cfg.is_some());

    let guard = lock_watcher_state(&shared);
    assert!(guard.watcher.is_none());
    assert!(guard.parent_watcher.is_none());
    assert!(guard.library_watcher.is_none());
    assert!(guard.config_watcher.is_none());
}
