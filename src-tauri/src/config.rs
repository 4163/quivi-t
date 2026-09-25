use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

pub const LIBRARY_PATH_KEY: &str = "library_path";
pub const RETIRED_LIBRARY_PATHS_KEY: &str = "retired_library_paths";

/// Write-to-tmp then rename. Prevents half-written config on crash.
fn atomic_write(path: &Path, data: impl AsRef<[u8]>) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct AppConfig {
    pub portable_mode: bool,
    pub hidden: bool,
    pub archive_cache_mb: Option<usize>,
    pub frontend_data: JsonValue,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            portable_mode: false,
            hidden: false,
            archive_cache_mb: None,
            frontend_data: serde_json::json!({}),
        }
    }
}

pub fn get_exe_dir() -> PathBuf {
    std::env::current_exe()
        .unwrap_or_default()
        .parent()
        .unwrap_or(Path::new(""))
        .to_path_buf()
}

pub fn is_portable_dir(exe_dir: &Path) -> bool {
    // The `.portable` marker always wins. It is what the E2E harness and
    // intentional portable installs create.
    if exe_dir.join(".portable").exists() {
        return true;
    }
    // Legacy fallback: an exe-dir config implies portable, but only when it
    // actually opts in. A stray file with `portable_mode: false` must not
    // hijack a roaming install into reading an empty local file.
    let cfg = exe_dir.join("quivit_config.json");
    if !cfg.exists() {
        return false;
    }
    match fs::read_to_string(&cfg) {
        Ok(content) => match serde_json::from_str::<AppConfig>(&content) {
            Ok(c) => c.portable_mode,
            // Corrupt exe-dir file: stay portable so we keep reading the
            // local file instead of silently switching locations.
            Err(_) => true,
        },
        Err(_) => false,
    }
}

pub fn is_portable() -> bool {
    is_portable_dir(&get_exe_dir())
}

/// Explicit runner folder. When `QUIVIT_CONFIG_DIR` names an absolute path,
/// every config decision uses it and all marker and exe-folder guessing is
/// skipped. One runner owns one folder, so dev, suite, and diagnose never
/// share files.
pub fn override_config_dir() -> Option<PathBuf> {
    let trimmed = std::env::var("QUIVIT_CONFIG_DIR").ok()?;
    let trimmed = trimmed.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        Some(path)
    } else {
        None
    }
}

/// One-line startup note naming the config folder and layout, so the active
/// run mode is never a mystery.
pub fn describe_config_source() -> String {
    if let Some(dir) = override_config_dir() {
        let layout = if override_single_file() {
            "single file"
        } else {
            "split files"
        };
        return format!("override {} ({layout})", dir.display());
    }
    if is_portable() {
        return format!("portable {}", get_exe_dir().display());
    }
    format!("roaming {}", get_config_path().display())
}

/// One-file layout inside the override folder. Split files are the default.
fn override_single_file() -> bool {
    matches!(
        std::env::var("QUIVIT_PORTABLE")
            .ok()
            .as_deref()
            .map(str::trim),
        Some("1") | Some("true")
    )
}

/// Old-location cleanup runs only on a real mode switch, never on a normal
/// save. Every-save deletion wiped roaming user data whenever the app ran
/// portable with a factory-empty config (E2E runs share the debug exe dir).
pub fn should_cleanup_old_location(was_portable: bool, will_be_portable: bool) -> bool {
    was_portable != will_be_portable
}

pub fn roaming_dir_path(app_handle: &tauri::AppHandle) -> PathBuf {
    app_handle.path().app_config_dir().unwrap_or_default()
}

pub fn roaming_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    let path = roaming_dir_path(app_handle);
    fs::create_dir_all(&path).ok();
    path
}

pub const ROAMING_FILES: &[&str] = &[
    "quivit_config.json",
    "quivit_state.json",
    "quivit_directory_sort.json",
    "quivit_bookmarks.json",
    "custom_css.css",
];

pub fn remove_roaming_files(dir: &Path) {
    for name in ROAMING_FILES {
        let _ = fs::remove_file(dir.join(name));
    }
}

pub fn get_config_path() -> PathBuf {
    if let Some(dir) = override_config_dir() {
        return dir.join("quivit_config.json");
    }
    let exe_dir = get_exe_dir();
    let is_port = is_portable_dir(&exe_dir);

    if is_port {
        exe_dir.join("quivit_config.json")
    } else {
        if let Ok(appdata) = std::env::var("APPDATA") {
            Path::new(&appdata)
                .join("com.x4163.quivit")
                .join("quivit_config.json")
        } else {
            PathBuf::new()
        }
    }
}

pub fn load_config_early() -> AppConfig {
    let config_path = get_config_path();

    if let Ok(content) = fs::read_to_string(&config_path) {
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        AppConfig::default()
    }
}

pub fn default_library_dir() -> Result<PathBuf, String> {
    let local = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA not set".to_string())?;
    Ok(Path::new(&local).join("QuiviT").join("library"))
}

/// `std::fs::canonicalize` returns a Windows verbatim path (`\\?\C:\...`).
/// Keep that form inside filesystem operations, but never expose or persist it
/// as a user-facing Library location.
pub fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('/', "\\");
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value
}

pub fn library_dir_from_config(config: &AppConfig) -> Result<PathBuf, String> {
    let Some(path) = config
        .frontend_data
        .get(LIBRARY_PATH_KEY)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|path| !path.is_empty())
    else {
        return default_library_dir();
    };

    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("Library location must be an absolute path".into());
    }
    Ok(path)
}

pub fn configured_library_dir() -> Result<PathBuf, String> {
    library_dir_from_config(&load_config_early())
}

pub fn same_library_location(left: &AppConfig, right: &AppConfig) -> Result<bool, String> {
    let left = library_dir_from_config(left)?;
    let right = library_dir_from_config(right)?;
    #[cfg(windows)]
    {
        return Ok(display_path(&left).eq_ignore_ascii_case(&display_path(&right)));
    }
    #[cfg(not(windows))]
    Ok(left == right)
}

fn clean_saved_path(path: &str) -> String {
    display_path(Path::new(path))
}

/// Older live moves wrote Windows canonical paths into frontend state. Clean
/// those values as they cross the configuration boundary so session restore,
/// Bookmarks, and breadcrumbs never expose a `\\?\` prefix.
fn normalize_library_location_paths(config: &mut AppConfig) {
    let Some(data) = config.frontend_data.as_object_mut() else {
        return;
    };

    for key in [LIBRARY_PATH_KEY, "last_opened_path"] {
        if let Some(path) = data.get(key).and_then(|value| value.as_str()) {
            data.insert(key.to_string(), serde_json::json!(clean_saved_path(path)));
        }
    }

    if let Some(last_active) = data
        .get_mut("last_active_image")
        .and_then(|value| value.as_object_mut())
    {
        for key in ["container", "path"] {
            if let Some(path) = last_active.get(key).and_then(|value| value.as_str()) {
                last_active.insert(key.to_string(), serde_json::json!(clean_saved_path(path)));
            }
        }
    }

    if let Some(bookmarks) = data
        .get_mut("bookmarks")
        .and_then(|value| value.as_array_mut())
    {
        for bookmark in bookmarks {
            let Some(bookmark) = bookmark.as_object_mut() else {
                continue;
            };
            let Some(path) = bookmark.get("path").and_then(|value| value.as_str()) else {
                continue;
            };
            let (filesystem_path, archive_entry) = path.split_once('|').unwrap_or((path, ""));
            let normalized = clean_saved_path(filesystem_path);
            let value = if archive_entry.is_empty() {
                normalized
            } else {
                format!("{normalized}|{archive_entry}")
            };
            bookmark.insert("path".to_string(), serde_json::json!(value));
        }
    }

    if let Some(sort_preferences) = data
        .get_mut("directory_sort")
        .and_then(|value| value.as_object_mut())
    {
        let normalized = sort_preferences
            .iter()
            .map(|(path, value)| (path.clone(), clean_saved_path(path), value.clone()))
            .collect::<Vec<_>>();
        for (original, replacement, value) in normalized {
            if original != replacement {
                sort_preferences.remove(&original);
                sort_preferences.insert(replacement, value);
            }
        }
    }

    if let Some(retired) = data
        .get_mut(RETIRED_LIBRARY_PATHS_KEY)
        .and_then(|value| value.as_array_mut())
    {
        for path in retired {
            if let Some(path_text) = path.as_str() {
                *path = serde_json::json!(clean_saved_path(path_text));
            }
        }
    }
}

// Startup-only settings use a pending value so they take effect after restart.
// Options writes `pending_single_instance`; the UI never writes the effective
// `single_instance`. On the next launch, promote the pending value, drop the
// pending key, and persist before startup logic reads it.
pub fn apply_pending_to_config(config: &mut AppConfig) {
    if let Some(pending) = config.frontend_data.get("pending_single_instance").cloned() {
        if pending.is_boolean() {
            config.frontend_data["single_instance"] = pending;
        }
        if let Some(obj) = config.frontend_data.as_object_mut() {
            obj.remove("pending_single_instance");
        }
    }
}

pub fn apply_pending_config_to_disk() {
    let mut config = load_config_early();
    let had_pending = config
        .frontend_data
        .get("pending_single_instance")
        .is_some();
    apply_pending_to_config(&mut config);
    if had_pending {
        if let Ok(data) = serde_json::to_string_pretty(&config) {
            let _ = atomic_write(&get_config_path(), data);
        }
    }

    // Sync the Win32 hidden attribute so manual JSON edits apply on launch.
    if config.portable_mode {
        let _ = crate::platform::attributes::set_hidden_attribute(
            &get_exe_dir().join("quivit_config.json"),
            config.hidden,
        );
    }
}

// Runtime state, directory sort prefs, and bookmarks live in their own roaming
// files so quivit_config.json only holds preferences. Portable mode keeps one
// self-contained file.

pub const STATE_KEYS: &[&str] = &[
    "last_opened_path",
    "last_active_image",
    "scroll_zoom_latched",
];
pub const SORT_KEYS: &[&str] = &["directory_sort"];
pub const BOOKMARKS_KEYS: &[&str] = &["bookmarks", "bookmarks_collapsed"];

pub fn extract_keys(src: &mut JsonValue, keys: &[&str]) -> JsonValue {
    let mut out = serde_json::Map::new();
    if let Some(obj) = src.as_object_mut() {
        for k in keys {
            if let Some(v) = obj.remove(*k) {
                out.insert(k.to_string(), v);
            }
        }
    }
    JsonValue::Object(out)
}

pub fn merge_keys(dst: &mut JsonValue, src: JsonValue) {
    if let (Some(d), Some(s)) = (dst.as_object_mut(), src.as_object()) {
        for (k, v) in s {
            d.insert(k.clone(), v.clone());
        }
    }
}

pub fn read_json_file<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

pub fn merge_file_into(path: &Path, frontend_data: &mut JsonValue) {
    if let Some(value) = read_json_file::<JsonValue>(path) {
        merge_keys(frontend_data, value);
    }
}

pub fn is_e2e_suite() -> bool {
    std::env::var("QUIVIT_E2E_SUITE").is_ok() || std::env::args().any(|a| a == "--e2e-suite")
}

/// Read one config folder. Split files merge unless single-file layout wins
/// (caller-forced or the stored portable flag). Legacy single files that hold
/// everything load unchanged.
fn load_from_dir(dir: &Path, force_single: bool) -> AppConfig {
    let mut cfg: AppConfig =
        read_json_file(&dir.join("quivit_config.json")).unwrap_or_default();
    if !(force_single || cfg.portable_mode) {
        // New layout: state, directory-sort, and bookmarks live in their own files.
        merge_file_into(&dir.join("quivit_state.json"), &mut cfg.frontend_data);
        merge_file_into(
            &dir.join("quivit_directory_sort.json"),
            &mut cfg.frontend_data,
        );
        merge_file_into(&dir.join("quivit_bookmarks.json"), &mut cfg.frontend_data);

        // Split mode stores custom CSS in its own file.
        let css_path = dir.join("custom_css.css");
        if let Ok(custom_css) = fs::read_to_string(&css_path) {
            cfg.frontend_data["custom_css"] = serde_json::json!(custom_css);
        }
    }
    cfg
}

#[tauri::command]
pub fn load_config(app_handle: tauri::AppHandle) -> AppConfig {
    let mut config = if let Some(dir) = override_config_dir() {
        fs::create_dir_all(&dir).ok();
        load_from_dir(&dir, override_single_file())
    } else if is_portable() {
        read_json_file(&get_exe_dir().join("quivit_config.json")).unwrap_or_default()
    } else {
        load_from_dir(&roaming_dir(&app_handle), false)
    };

    normalize_library_location_paths(&mut config);

    if is_e2e_suite() {
        config.frontend_data["e2e_suite"] = serde_json::json!(true);
    } else if let Some(obj) = config.frontend_data.as_object_mut() {
        obj.remove("e2e_suite");
    }

    config
}

// Options folder rows. They name the roaming and exe-dir spots, except an
// override run repoints both at its own folder since that is where the files
// actually live. They do not track the "Save config data locally" state.

#[tauri::command]
pub fn get_config_dir(app_handle: tauri::AppHandle) -> String {
    roaming_dir(&app_handle).to_string_lossy().into_owned()
}

#[tauri::command]
pub fn open_active_config_dir(app_handle: tauri::AppHandle) -> Result<(), String> {
    let dir = if let Some(dir) = override_config_dir() {
        dir
    } else if is_portable() {
        get_exe_dir()
    } else {
        roaming_dir(&app_handle)
    };
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config directory: {e}"))?;
    app_handle
        .opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| format!("Failed to open config directory: {e}"))
}

/// Folder and layout this run actually uses. Options renders it as the
/// primary row; the secondary row names the inactive fixed spot.
#[tauri::command]
pub fn get_active_config_info() -> crate::models::ActiveConfigInfo {
    if let Some(dir) = override_config_dir() {
        let layout = if override_single_file() {
            "single file"
        } else {
            "split files"
        };
        return crate::models::ActiveConfigInfo {
            dir: dir.to_string_lossy().into_owned(),
            mode: format!("override ({layout})"),
        };
    }
    let mode = if is_portable() { "portable" } else { "roaming" };
    let dir = get_config_path()
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    crate::models::ActiveConfigInfo {
        dir,
        mode: mode.to_string(),
    }
}

#[tauri::command]
pub fn open_config_dir(app_handle: tauri::AppHandle) -> Result<(), String> {
    let dir = roaming_dir(&app_handle);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config directory: {e}"))?;
    app_handle
        .opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| format!("Failed to open config directory: {e}"))
}

#[tauri::command]
pub fn get_local_data_dir() -> String {
    get_exe_dir().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn open_local_data_dir(app_handle: tauri::AppHandle) -> Result<(), String> {
    let dir = get_exe_dir();
    app_handle
        .opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| format!("Failed to open local data directory: {e}"))
}

/// Write the split layout into one folder. Shared by roaming and override saves.
fn write_split_config(dir: &Path, config: &mut AppConfig) -> Result<(), String> {
    let mut fd = std::mem::take(&mut config.frontend_data);
    let state = extract_keys(&mut fd, STATE_KEYS);
    let sort = extract_keys(&mut fd, SORT_KEYS);
    let bookmarks = extract_keys(&mut fd, BOOKMARKS_KEYS);

    // Store custom CSS separately.
    let custom_css = fd
        .get("custom_css")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    fd.as_object_mut().map(|obj| obj.remove("custom_css"));

    config.frontend_data = fd;

    let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    atomic_write(&dir.join("quivit_config.json"), data).map_err(|e| e.to_string())?;
    atomic_write(
        &dir.join("quivit_state.json"),
        serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    atomic_write(
        &dir.join("quivit_directory_sort.json"),
        serde_json::to_string_pretty(&sort).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    atomic_write(
        &dir.join("quivit_bookmarks.json"),
        serde_json::to_string_pretty(&bookmarks).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    atomic_write(&dir.join("custom_css.css"), custom_css).map_err(|e| e.to_string())
}

/// Save into the override folder only. One layout per folder: a single-file
/// save drops split leftovers so stale files can never come back.
fn save_override(dir: &Path, mut config: AppConfig) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    if override_single_file() || config.portable_mode {
        let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        atomic_write(&dir.join("quivit_config.json"), data).map_err(|e| e.to_string())?;
        for name in [
            "quivit_state.json",
            "quivit_directory_sort.json",
            "quivit_bookmarks.json",
            "custom_css.css",
        ] {
            let _ = fs::remove_file(dir.join(name));
        }
    } else {
        write_split_config(dir, &mut config)?;
    }
    Ok(())
}

pub fn save_config_unchecked(
    app_handle: tauri::AppHandle,
    mut config: AppConfig,
) -> Result<(), String> {
    normalize_library_location_paths(&mut config);
    if let Some(obj) = config.frontend_data.as_object_mut() {
        obj.remove("e2e_suite");
    }
    if let Some(dir) = override_config_dir() {
        return save_override(&dir, config);
    }
    let exe_dir = get_exe_dir();
    let will_be_portable = config.portable_mode;
    let was_portable = is_portable_dir(&exe_dir);
    let migrating = should_cleanup_old_location(was_portable, will_be_portable);

    if will_be_portable {
        let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        let config_path = exe_dir.join("quivit_config.json");
        atomic_write(&config_path, data).map_err(|e| e.to_string())?;

        // Only the portable config file gets the hidden attribute.
        crate::platform::attributes::set_hidden_attribute(&config_path, config.hidden)?;

        // Migration only: a normal portable save must never touch roaming
        // user data. E2E and diagnose runs save portable configs routinely.
        if migrating {
            remove_roaming_files(&roaming_dir_path(&app_handle));

            let _ = fs::remove_file(roaming_dir(&app_handle).join("custom_css.css"));
        }
    } else {
        // Roaming: write the split files first, then remove portable leftovers so
        // a failed write never loses the config.
        let dir = roaming_dir(&app_handle);
        write_split_config(&dir, &mut config)?;

        // Migration only: leaving a stray exe-dir config behind would trap
        // the next launch back into portable mode via is_portable_dir.
        if migrating {
            let _ = fs::remove_file(exe_dir.join("quivit_config.json"));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn save_config(app_handle: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    if crate::commands::library::library_move_in_progress()? {
        return Err(
            "Library relocation is in progress. Try saving settings again when it finishes.".into(),
        );
    }

    let current = load_config(app_handle.clone());
    if !same_library_location(&current, &config)? {
        return Err("Use the Library location control to move the Library. Settings saves cannot change its path.".into());
    }

    save_config_unchecked(app_handle, config)
}

#[cfg(test)]
#[path = "tests/config_tests.rs"]
mod tests;
