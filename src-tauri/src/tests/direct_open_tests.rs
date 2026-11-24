use super::*;
use std::sync::Mutex;

static LOCALAPPDATA_LOCK: Mutex<()> = Mutex::new(());

struct LocalAppDataGuard(Option<OsString>);

impl LocalAppDataGuard {
    fn set(path: &Path) -> Self {
        let prev = std::env::var_os("LOCALAPPDATA");
        std::env::set_var("LOCALAPPDATA", path);
        Self(prev)
    }
}

impl Drop for LocalAppDataGuard {
    fn drop(&mut self) {
        match &self.0 {
            Some(prev) => std::env::set_var("LOCALAPPDATA", prev),
            None => std::env::remove_var("LOCALAPPDATA"),
        }
    }
}

struct TempDirGuard(PathBuf);

impl TempDirGuard {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "quivit_direct_open_{name}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn os_args(items: &[&str]) -> Vec<OsString> {
    items.iter().map(OsString::from).collect()
}

#[test]
fn test_has_file_open_arg() {
    assert!(!has_file_open_arg(&os_args(&[])));
    assert!(!has_file_open_arg(&os_args(&["quivit.exe"])));
    assert!(!has_file_open_arg(&os_args(&[
        "quivit.exe",
        "--previews-pane",
        "--previews-thumb",
        "-v",
    ])));
    assert!(has_file_open_arg(&os_args(&["quivit.exe", "image.png"])));
    assert!(has_file_open_arg(&os_args(&[
        "quivit.exe",
        "--previews-pane",
        "image.png",
    ])));
}

#[test]
fn test_release_exe_missing_stale_and_valid() {
    let _lock = LOCALAPPDATA_LOCK.lock().unwrap();
    let base = TempDirGuard::new("release");
    let _env = LocalAppDataGuard::set(base.path());
    let launch = base.path().join("QuiviT").join("launch");
    fs::create_dir_all(&launch).unwrap();

    // Missing release.path
    let err = release_exe().unwrap_err();
    assert!(err.starts_with("The release build"), "unexpected error: {err}");
    let err = recorded_exe("release.path", "release").unwrap_err();
    assert!(err.starts_with("The release build"), "unexpected error: {err}");

    // Stale path pointing to a nonexistent executable
    let missing_exe = base.path().join("missing_release.exe");
    fs::write(launch.join("release.path"), missing_exe.to_string_lossy().as_bytes()).unwrap();
    let err = release_exe().unwrap_err();
    assert!(err.starts_with("The release build"), "unexpected error: {err}");

    // Existing dummy executable
    let valid_exe = base.path().join("release_dummy.exe");
    fs::write(&valid_exe, b"").unwrap();
    fs::write(launch.join("release.path"), valid_exe.to_string_lossy().as_bytes()).unwrap();
    assert_eq!(release_exe().unwrap(), valid_exe);
}

#[test]
fn test_selected_exe_without_project_root() {
    let _lock = LOCALAPPDATA_LOCK.lock().unwrap();
    let base = TempDirGuard::new("no_root");
    let _env = LocalAppDataGuard::set(base.path());

    assert_eq!(selected_exe().unwrap(), None);
}

#[test]
fn test_selected_exe_switch_variants() {
    let _lock = LOCALAPPDATA_LOCK.lock().unwrap();
    let base = TempDirGuard::new("switch");
    let _env = LocalAppDataGuard::set(base.path());
    let launch = base.path().join("QuiviT").join("launch");
    let project_root = base.path().join("repo");
    fs::create_dir_all(&launch).unwrap();
    fs::create_dir_all(&project_root).unwrap();

    let release_bin = base.path().join("quivit-release.exe");
    let debug_bin = base.path().join("quivit-debug.exe");
    fs::write(&release_bin, b"").unwrap();
    fs::write(&debug_bin, b"").unwrap();

    fs::write(
        launch.join("project-root.path"),
        project_root.to_string_lossy().as_bytes(),
    )
    .unwrap();
    fs::write(
        launch.join("release.path"),
        release_bin.to_string_lossy().as_bytes(),
    )
    .unwrap();

    // Missing .quivit-open-dev defaults to release.path.
    assert_eq!(selected_exe().unwrap(), Some(release_bin.clone()));

    // Comments + blank lines + true selects debug.path (error prefix when debug.path is missing).
    let switch_file = project_root.join(DEV_SWITCH);
    fs::write(&switch_file, "# toggle dev build\n\n  true  \n# trailing comment\n").unwrap();
    let err = selected_exe().unwrap_err();
    assert!(err.starts_with("The debug build"), "unexpected error: {err}");

    fs::write(
        launch.join("debug.path"),
        debug_bin.to_string_lossy().as_bytes(),
    )
    .unwrap();
    assert_eq!(selected_exe().unwrap(), Some(debug_bin));

    // Explicit false selects release.path.
    fs::write(&switch_file, "false\n").unwrap();
    assert_eq!(selected_exe().unwrap(), Some(release_bin));

    // Invalid switch contents return an error naming the expected format.
    for invalid in ["maybe\n", "true\nfalse\n"] {
        fs::write(&switch_file, invalid).unwrap();
        let err = selected_exe().unwrap_err();
        assert!(
            err.contains("must contain one true or false line."),
            "unexpected error for {invalid:?}: {err}"
        );
    }
}
