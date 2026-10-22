use super::*;
use std::fs;

fn unique_dir(name: &str) -> PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push(format!(
        "quivit-previews-test-{}-{}-{}",
        name,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_source(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn test_sha256_known_vector() {
    assert_eq!(
        compute_sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn test_resolve_is_global_bin() {
    let host = resolve_previews_host_path();
    let text = host.to_string_lossy().replace('/', "\\");
    assert!(text.ends_with(r"QuiviT\bin\quivit-previews.exe"), "{text}");
}

#[test]
fn test_missing_sidecar_stages() {
    let dir = unique_dir("missing");
    let source = write_source(&dir, "src.exe", b"helper-bytes-v1");
    let host = dir.join("bin").join(PREVIEWS_BIN_NAME);
    let out = ensure_previews_host_from(&source, &host, 1, false).unwrap();
    assert_eq!(out, host);
    assert!(host.exists());
    let sidecar = read_sidecar(&sidecar_path_for(&host)).unwrap();
    assert_eq!(sidecar.preview_version, 1);
    assert_eq!(sidecar.profile, "release");
    assert_eq!(sidecar.sha256, compute_sha256_hex(b"helper-bytes-v1"));
}

#[test]
fn test_corrupt_staged_bytes_repair() {
    let dir = unique_dir("corrupt");
    let source = write_source(&dir, "src.exe", b"good-bytes");
    let host = dir.join("bin").join(PREVIEWS_BIN_NAME);
    ensure_previews_host_from(&source, &host, 1, false).unwrap();
    fs::write(&host, b"tampered").unwrap();
    ensure_previews_host_from(&source, &host, 1, false).unwrap();
    assert_eq!(fs::read(&host).unwrap(), b"good-bytes");
}

#[test]
fn test_staged_debug_overwritten_by_release() {
    let dir = unique_dir("debug-staged");
    let release_src = write_source(&dir, "release.exe", b"release-bytes");
    let debug_src = write_source(&dir, "debug.exe", b"debug-bytes");
    let host = dir.join("bin").join(PREVIEWS_BIN_NAME);
    ensure_previews_host_from(&debug_src, &host, 1, true).unwrap();
    assert_eq!(fs::read(&host).unwrap(), b"debug-bytes");
    ensure_previews_host_from(&release_src, &host, 1, false).unwrap();
    assert_eq!(fs::read(&host).unwrap(), b"release-bytes");
    let sidecar = read_sidecar(&sidecar_path_for(&host)).unwrap();
    assert_eq!(sidecar.profile, "release");
}

#[test]
fn test_equal_healthy_release_keeps_bytes() {
    let dir = unique_dir("equal");
    let staged_src = write_source(&dir, "staged.exe", b"staged-bytes");
    let other_src = write_source(&dir, "other.exe", b"other-bytes-same-version");
    let host = dir.join("bin").join(PREVIEWS_BIN_NAME);
    ensure_previews_host_from(&staged_src, &host, 1, false).unwrap();
    let before = fs::read(&host).unwrap();
    ensure_previews_host_from(&other_src, &host, 1, false).unwrap();
    assert_eq!(fs::read(&host).unwrap(), before);
}

#[test]
fn test_greater_staged_version_keeps_bytes() {
    let dir = unique_dir("greater");
    let new_src = write_source(&dir, "new.exe", b"new-bytes");
    let old_src = write_source(&dir, "old.exe", b"old-bytes");
    let host = dir.join("bin").join(PREVIEWS_BIN_NAME);
    ensure_previews_host_from(&new_src, &host, 2, false).unwrap();
    ensure_previews_host_from(&old_src, &host, 1, false).unwrap();
    assert_eq!(fs::read(&host).unwrap(), b"new-bytes");
    let sidecar = read_sidecar(&sidecar_path_for(&host)).unwrap();
    assert_eq!(sidecar.preview_version, 2);
}

#[test]
fn test_lower_staged_version_overwrites() {
    let dir = unique_dir("lower");
    let old_src = write_source(&dir, "old.exe", b"old-bytes");
    let new_src = write_source(&dir, "new.exe", b"new-bytes");
    let host = dir.join("bin").join(PREVIEWS_BIN_NAME);
    ensure_previews_host_from(&old_src, &host, 1, false).unwrap();
    ensure_previews_host_from(&new_src, &host, 2, false).unwrap();
    assert_eq!(fs::read(&host).unwrap(), b"new-bytes");
}

#[test]
fn test_debug_always_overwrites() {
    let dir = unique_dir("debug-always");
    let first = write_source(&dir, "a.exe", b"first");
    let second = write_source(&dir, "b.exe", b"second");
    let host = dir.join("bin").join(PREVIEWS_BIN_NAME);
    ensure_previews_host_from(&first, &host, 1, true).unwrap();
    ensure_previews_host_from(&second, &host, 1, true).unwrap();
    assert_eq!(fs::read(&host).unwrap(), b"second");
}

#[test]
fn test_locked_helper_reports_retry() {
    let dir = unique_dir("locked");
    let source = write_source(&dir, "src.exe", b"bytes");
    let host_dir = dir.join("bin");
    fs::create_dir_all(&host_dir).unwrap();
    let host = host_dir.join(PREVIEWS_BIN_NAME);
    fs::create_dir_all(&host).unwrap();
    let error = ensure_previews_host_from(&source, &host, 1, false).unwrap_err();
    assert!(error.contains("preview pane"), "{error}");
}

#[test]
fn test_stale_points_elsewhere() {
    let host = PathBuf::from(r"C:\Users\me\AppData\Local\QuiviT\bin\quivit-previews.exe");
    let expected = expected_command_for(&host);
    assert!(!is_stale_registration(None, &host));
    assert!(!is_stale_registration(Some(&expected), &host));
    assert!(is_stale_registration(
        Some(r#""C:\other\QuiviT.exe" --previews-pane"#),
        &host
    ));
    assert!(is_stale_registration(
        Some(&format!(
            r#""{}" --preview-handler"#,
            host.to_string_lossy()
        )),
        &host
    ));
}

#[test]
fn test_decide_matrix() {
    let release_v1 = PreviewsSidecar {
        preview_version: 1,
        profile: "release".into(),
        sha256: "x".into(),
        app_path: None,
        proxy_sha256: None,
    };
    assert_eq!(decide_host_action(None, false, 1, false), HostAction::Stage);
    assert_eq!(
        decide_host_action(Some(&release_v1), false, 1, false),
        HostAction::Stage
    );
    let debug = PreviewsSidecar {
        preview_version: 1,
        profile: "debug".into(),
        sha256: "x".into(),
        app_path: None,
        proxy_sha256: None,
    };
    assert_eq!(
        decide_host_action(Some(&debug), true, 1, false),
        HostAction::Stage
    );
    let old = PreviewsSidecar {
        preview_version: 1,
        profile: "release".into(),
        sha256: "x".into(),
        app_path: None,
        proxy_sha256: None,
    };
    assert_eq!(
        decide_host_action(Some(&old), true, 2, false),
        HostAction::Stage
    );
    assert_eq!(
        decide_host_action(Some(&release_v1), true, 1, false),
        HostAction::Keep
    );
    let newer = PreviewsSidecar {
        preview_version: 3,
        profile: "release".into(),
        sha256: "x".into(),
        app_path: None,
        proxy_sha256: None,
    };
    assert_eq!(
        decide_host_action(Some(&newer), true, 1, false),
        HostAction::Keep
    );
    assert_eq!(
        decide_host_action(Some(&release_v1), true, 1, true),
        HostAction::Stage
    );
}
