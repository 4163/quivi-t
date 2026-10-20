//! Selects the app executable for file opens launched by Windows or Explorer previews.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const DEV_SWITCH: &str = ".quivit-open-dev";

fn launch_dir() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local).join("QuiviT").join("launch"))
}

fn read_path(name: &str) -> Option<PathBuf> {
    let value = fs::read_to_string(launch_dir()?.join(name)).ok()?;
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(PathBuf::from(value))
}

fn recorded_exe(profile: &str, name: &str) -> Result<PathBuf, String> {
    let Some(exe) = read_path(profile) else {
        return Err(format!(
            "The {name} build has no recorded path. Start it once from its current location."
        ));
    };
    if !exe.is_file() {
        return Err(format!(
            "The {name} build is no longer at {}. Start it from its new location.",
            exe.display()
        ));
    }
    Ok(exe)
}

pub fn release_exe() -> Result<PathBuf, String> {
    recorded_exe("release.path", "release")
}

pub fn record_current_exe() {
    if crate::config::is_e2e_suite() {
        return;
    }
    let (Some(dir), Ok(exe)) = (launch_dir(), std::env::current_exe()) else {
        return;
    };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }

    let profile = if cfg!(debug_assertions) {
        "debug.path"
    } else {
        "release.path"
    };
    let _ = fs::write(dir.join(profile), exe.to_string_lossy().as_bytes());
    if cfg!(debug_assertions) {
        if let Some(root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            let _ = fs::write(
                dir.join("project-root.path"),
                root.to_string_lossy().as_bytes(),
            );
        }
    }
}

pub fn selected_exe() -> Result<Option<PathBuf>, String> {
    let Some(root) = read_path("project-root.path") else {
        return Ok(None);
    };
    let switch_path = root.join(DEV_SWITCH);
    let use_dev = match fs::read_to_string(&switch_path) {
        Ok(value) => {
            let mut settings = value
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty() && !line.starts_with('#'));
            match (settings.next(), settings.next()) {
                (Some("true"), None) => true,
                (Some("false"), None) => false,
                _ => {
                    return Err(format!(
                        "{} must contain one true or false line.",
                        switch_path.display()
                    ))
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("Could not read {}: {error}", switch_path.display())),
    };
    let (profile, name) = if use_dev {
        ("debug.path", "debug")
    } else {
        ("release.path", "release")
    };
    recorded_exe(profile, name).map(Some)
}

pub fn forward_file_open(args: &[OsString]) -> Result<bool, String> {
    if !args
        .iter()
        .skip(1)
        .any(|arg| !arg.to_string_lossy().starts_with('-'))
    {
        return Ok(false);
    }
    let Some(target) = selected_exe()? else {
        return Ok(false);
    };
    let current = std::env::current_exe().map_err(|err| err.to_string())?;
    if fs::canonicalize(&target)
        .ok()
        .zip(fs::canonicalize(&current).ok())
        .is_some_and(|(target, current)| target == current)
    {
        return Ok(false);
    }
    Command::new(&target)
        .args(&args[1..])
        .spawn()
        .map_err(|err| format!("Could not start {}: {err}", target.display()))?;
    Ok(true)
}
