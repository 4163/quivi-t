use super::*;

#[test]
fn test_is_hidden_path() {
    #[cfg(windows)]
    {
        assert!(!is_hidden_path(".hidden_dotfile", None));
        assert!(!is_hidden_path("normal_file.png", None));
    }
    #[cfg(not(windows))]
    {
        assert!(is_hidden_path(".hidden_dotfile", None));
        assert!(!is_hidden_path("normal_file.png", None));
    }
}

#[cfg(windows)]
struct TempDirGuard(std::path::PathBuf);

#[cfg(windows)]
impl TempDirGuard {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "quivit_attr_{name}_{}_{}",
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

#[cfg(windows)]
impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(windows)]
#[test]
fn test_set_hidden_attribute_roundtrip_and_missing() {
    let dir = TempDirGuard::new("hidden");
    let file = dir.path().join("sample.json");
    std::fs::write(&file, "{}").unwrap();

    let meta = std::fs::metadata(&file).unwrap();
    assert!(!is_hidden_path("sample.json", Some(&meta)));

    set_hidden_attribute(&file, true).unwrap();
    let meta = std::fs::metadata(&file).unwrap();
    assert!(is_hidden_path("sample.json", Some(&meta)));

    // Setting hidden when already hidden stays idempotent.
    set_hidden_attribute(&file, true).unwrap();
    let meta = std::fs::metadata(&file).unwrap();
    assert!(is_hidden_path("sample.json", Some(&meta)));

    set_hidden_attribute(&file, false).unwrap();
    let meta = std::fs::metadata(&file).unwrap();
    assert!(!is_hidden_path("sample.json", Some(&meta)));

    // Clearing hidden when already clear stays idempotent.
    set_hidden_attribute(&file, false).unwrap();
    let meta = std::fs::metadata(&file).unwrap();
    assert!(!is_hidden_path("sample.json", Some(&meta)));

    let missing = dir.path().join("does_not_exist.json");
    assert!(set_hidden_attribute(&missing, true).is_err());
    assert!(set_hidden_attribute(&missing, false).is_err());
}
