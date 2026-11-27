use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

pub const LIBRARY_PATH_KEY: &str = "library_path";
pub const RETIRED_LIBRARY_PATHS_KEY: &str = "retired_library_paths";

const ROAMING_APP_ID: &str = if cfg!(debug_assertions) {
    "com.x4163.quivit.dev"
} else {
    "com.x4163.quivit"
};

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

pub struct StartupConfig {
    pub config: AppConfig,
    pub config_path: PathBuf,
    pub source_description: String,
}

#[derive(Clone)]
struct CachedLibraryConfig {
    override_dir: Option<PathBuf>,
    library_path: Option<String>,
    retired_library_paths: Vec<PathBuf>,
}

impl CachedLibraryConfig {
    fn from_config(config: &AppConfig, override_dir: Option<PathBuf>) -> Self {
        let library_path = config
            .frontend_data
            .get(LIBRARY_PATH_KEY)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_string);

        let retired_library_paths = config
            .frontend_data
            .get(RETIRED_LIBRARY_PATHS_KEY)
            .and_then(|value| value.as_array())
            .map(|paths| {
                paths
                    .iter()
                    .filter_map(|value| value.as_str())
                    .map(PathBuf::from)
                    .filter(|path| path.is_absolute())
                    .collect()
            })
            .unwrap_or_default();

        Self {
            override_dir,
            library_path,
            retired_library_paths,
        }
    }
}

static LIBRARY_CONFIG_CACHE: RwLock<Option<CachedLibraryConfig>> = RwLock::new(None);

fn seed_library_cache(config: &AppConfig) {
    let entry = CachedLibraryConfig::from_config(config, override_config_dir());
    let mut guard = LIBRARY_CONFIG_CACHE
        .write()
        .unwrap_or_else(|e| e.into_inner());
    *guard = Some(entry);
}

pub fn invalidate_library_cache() {
    let mut guard = LIBRARY_CONFIG_CACHE
        .write()
        .unwrap_or_else(|e| e.into_inner());
    *guard = None;
}

fn cached_library_config() -> CachedLibraryConfig {
    let current_override = override_config_dir();
    {
        let guard = LIBRARY_CONFIG_CACHE
            .read()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = guard.as_ref() {
            if cached.override_dir == current_override {
                return cached.clone();
            }
        }
    }
    let config = load_config_early();
    let fresh = CachedLibraryConfig::from_config(&config, current_override);
    let mut guard = LIBRARY_CONFIG_CACHE
        .write()
        .unwrap_or_else(|e| e.into_inner());
    *guard = Some(fresh.clone());
    fresh
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

enum ConfigSourceKind {
    Override { single_file: bool },
    Portable,
    Roaming,
}

struct ConfigSource {
    dir: PathBuf,
    config_path: PathBuf,
    kind: ConfigSourceKind,
}

impl ConfigSource {
    fn describe(&self) -> String {
        match self.kind {
            ConfigSourceKind::Override { single_file } => {
                let layout = if single_file {
                    "single file"
                } else {
                    "split files"
                };
                format!("override {} ({layout})", self.dir.display())
            }
            ConfigSourceKind::Portable => format!("portable {}", self.dir.display()),
            ConfigSourceKind::Roaming => format!("roaming {}", self.config_path.display()),
        }
    }

    fn active_config_info(&self) -> crate::models::ActiveConfigInfo {
        let mode = match self.kind {
            ConfigSourceKind::Override { single_file } => {
                let layout = if single_file {
                    "single file"
                } else {
                    "split files"
                };
                format!("override ({layout})")
            }
            ConfigSourceKind::Portable => "portable".to_string(),
            ConfigSourceKind::Roaming => "roaming".to_string(),
        };
        crate::models::ActiveConfigInfo {
            dir: self.dir.to_string_lossy().into_owned(),
            mode,
        }
    }
}

fn resolve_config_source() -> ConfigSource {
    if let Some(dir) = override_config_dir() {
        let config_path = dir.join("quivit_config.json");
        return ConfigSource {
            dir,
            config_path,
            kind: ConfigSourceKind::Override {
                single_file: override_single_file(),
            },
        };
    }

    let exe_dir = get_exe_dir();
    if is_portable_dir(&exe_dir) {
        let config_path = exe_dir.join("quivit_config.json");
        return ConfigSource {
            dir: exe_dir,
            config_path,
            kind: ConfigSourceKind::Portable,
        };
    }

    let dir = std::env::var("APPDATA")
        .map(|appdata| Path::new(&appdata).join(ROAMING_APP_ID))
        .unwrap_or_default();
    let config_path = if dir.as_os_str().is_empty() {
        PathBuf::new()
    } else {
        dir.join("quivit_config.json")
    };
    ConfigSource {
        dir,
        config_path,
        kind: ConfigSourceKind::Roaming,
    }
}

/// One-line startup note naming the config folder and layout, so the active
/// run mode is never a mystery.
pub fn describe_config_source() -> String {
    resolve_config_source().describe()
}

/// Active settings folder and layout description for Options UI.
pub fn active_config_info() -> crate::models::ActiveConfigInfo {
    resolve_config_source().active_config_info()
}

/// Old-location cleanup runs only on a real mode switch, never on a normal
/// save. Every-save deletion wiped roaming user data whenever the app ran
/// portable with a factory-empty config (E2E runs share the debug exe dir).
pub fn should_cleanup_old_location(was_portable: bool, will_be_portable: bool) -> bool {
    was_portable != will_be_portable
}

pub const ROAMING_FILES: &[&str] = &[
    "quivit_config.json",
    "quivit_state.json",
    "quivit_directory_sort.json",
    "quivit_favorites.json",
    "custom_css.css",
];

pub fn remove_roaming_files(dir: &Path) {
    for name in ROAMING_FILES {
        let _ = fs::remove_file(dir.join(name));
    }
}

pub fn get_config_path() -> PathBuf {
    resolve_config_source().config_path
}

pub fn load_config_early() -> AppConfig {
    let config_path = get_config_path();
    read_json_file(&config_path).unwrap_or_default()
}

/// Read only `quivit_config.json` from the active config folder, skipping split
/// state/sort/favorites/CSS files and path normalization.
pub fn load_main_config(roaming_dir_path: &Path) -> AppConfig {
    let config_path = if let Some(dir) = override_config_dir() {
        dir.join("quivit_config.json")
    } else if is_portable() {
        get_exe_dir().join("quivit_config.json")
    } else {
        roaming_dir_path.join("quivit_config.json")
    };
    read_json_file(&config_path).unwrap_or_default()
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

fn resolve_library_path(raw: Option<&str>) -> Result<PathBuf, String> {
    let Some(path) = raw.map(str::trim).filter(|path| !path.is_empty()) else {
        return default_library_dir();
    };

    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("Library location must be an absolute path".into());
    }
    Ok(path)
}

pub fn library_dir_from_config(config: &AppConfig) -> Result<PathBuf, String> {
    let raw = config
        .frontend_data
        .get(LIBRARY_PATH_KEY)
        .and_then(|value| value.as_str());
    resolve_library_path(raw)
}

pub fn configured_library_dir() -> Result<PathBuf, String> {
    let cached = cached_library_config();
    resolve_library_path(cached.library_path.as_deref())
}

pub fn retired_library_paths() -> Vec<PathBuf> {
    cached_library_config().retired_library_paths
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

/// Rewrite every stored session, Favorites, and per-folder sort path in place.
pub(crate) fn map_config_paths(config: &mut AppConfig, mut f: impl FnMut(&str) -> Option<String>) {
    let Some(data) = config.frontend_data.as_object_mut() else {
        return;
    };

    if let Some(path) = data.get("last_opened_path").and_then(|value| value.as_str()) {
        if let Some(updated) = f(path) {
            data.insert("last_opened_path".to_string(), serde_json::json!(updated));
        }
    }

    if let Some(last_active) = data
        .get_mut("last_active_image")
        .and_then(|value| value.as_object_mut())
    {
        for key in ["container", "path"] {
            if let Some(path) = last_active.get(key).and_then(|value| value.as_str()) {
                if let Some(updated) = f(path) {
                    last_active.insert(key.to_string(), serde_json::json!(updated));
                }
            }
        }
    }

    if let Some(favorites) = data
        .get_mut("favorites")
        .and_then(|value| value.as_object_mut())
    {
        if let Some(loadouts) = favorites
            .get_mut("loadouts")
            .and_then(|value| value.as_array_mut())
        {
            for loadout in loadouts {
                if let Some(items) = loadout
                    .get_mut("items")
                    .and_then(|value| value.as_array_mut())
                {
                    for item in items {
                        let Some(item_obj) = item.as_object_mut() else {
                            continue;
                        };
                        let Some(path) = item_obj.get("path").and_then(|value| value.as_str())
                        else {
                            continue;
                        };
                        let (filesystem_path, archive_entry) =
                            path.split_once('|').unwrap_or((path, ""));
                        if let Some(updated) = f(filesystem_path) {
                            let value = if archive_entry.is_empty() {
                                updated
                            } else {
                                format!("{updated}|{archive_entry}")
                            };
                            item_obj.insert("path".to_string(), serde_json::json!(value));
                        }
                    }
                }
            }
        }
    }

    if let Some(sort_preferences) = data
        .get_mut("directory_sort")
        .and_then(|value| value.as_object_mut())
    {
        let remapped = sort_preferences
            .iter()
            .filter_map(|(path, value)| {
                let updated = f(path)?;
                (updated != *path).then(|| (path.clone(), updated, value.clone()))
            })
            .collect::<Vec<_>>();
        for (original, replacement, value) in remapped {
            sort_preferences.remove(&original);
            sort_preferences.insert(replacement, value);
        }
    }
}

/// Older live moves wrote Windows canonical paths into frontend state. Clean
/// those values as they cross the configuration boundary so session restore,
/// Favorites, and breadcrumbs never expose a `\\?\` prefix.
fn normalize_library_location_paths(config: &mut AppConfig) {
    map_config_paths(config, |path| Some(clean_saved_path(path)));

    let Some(data) = config.frontend_data.as_object_mut() else {
        return;
    };

    if let Some(path) = data.get(LIBRARY_PATH_KEY).and_then(|value| value.as_str()) {
        data.insert(
            LIBRARY_PATH_KEY.to_string(),
            serde_json::json!(clean_saved_path(path)),
        );
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

/// Resolve the active config source once, promote any staged startup settings,
/// sync portable attributes, and seed the in-memory library config cache.
pub fn load_startup_config() -> StartupConfig {
    let source = resolve_config_source();
    let mut config: AppConfig = read_json_file(&source.config_path).unwrap_or_default();
    let had_pending = config
        .frontend_data
        .get("pending_single_instance")
        .is_some();
    apply_pending_to_config(&mut config);
    if had_pending {
        if let Ok(data) = serde_json::to_string_pretty(&config) {
            let _ = atomic_write(&source.config_path, data);
        }
    }

    // Sync the Win32 hidden attribute so manual JSON edits apply on launch.
    if config.portable_mode {
        let _ = crate::platform::attributes::set_hidden_attribute(
            &source.config_path,
            config.hidden,
        );
    }

    seed_library_cache(&config);

    let source_description = source.describe();
    StartupConfig {
        config,
        config_path: source.config_path,
        source_description,
    }
}

pub fn apply_pending_config_to_disk() {
    let _ = load_startup_config();
}

// Runtime state, directory sort prefs, and favorites live in their own roaming
// files so quivit_config.json only holds preferences. Portable mode keeps one
// self-contained file.

pub const STATE_KEYS: &[&str] = &[
    "last_opened_path",
    "last_active_image",
    "scroll_zoom_latched",
];
pub const SORT_KEYS: &[&str] = &["directory_sort"];
pub const FAVORITES_KEYS: &[&str] = &["favorites", "favorites_collapsed"];

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
    let mut cfg: AppConfig = read_json_file(&dir.join("quivit_config.json")).unwrap_or_default();
    if !(force_single || cfg.portable_mode) {
        // New layout: state, directory-sort, and favorites live in their own files.
        merge_file_into(&dir.join("quivit_state.json"), &mut cfg.frontend_data);
        merge_file_into(
            &dir.join("quivit_directory_sort.json"),
            &mut cfg.frontend_data,
        );
        merge_file_into(&dir.join("quivit_favorites.json"), &mut cfg.frontend_data);

        // Split mode stores custom CSS in its own file.
        let css_path = dir.join("custom_css.css");
        if let Ok(custom_css) = fs::read_to_string(&css_path) {
            cfg.frontend_data["custom_css"] = serde_json::json!(custom_css);
        }
    }
    cfg
}

pub fn load_config(roaming_dir_path: &Path) -> AppConfig {
    let mut config = if let Some(dir) = override_config_dir() {
        fs::create_dir_all(&dir).ok();
        load_from_dir(&dir, override_single_file())
    } else if is_portable() {
        read_json_file(&get_exe_dir().join("quivit_config.json")).unwrap_or_default()
    } else {
        fs::create_dir_all(roaming_dir_path).ok();
        load_from_dir(roaming_dir_path, false)
    };

    normalize_library_location_paths(&mut config);

    if is_e2e_suite() {
        config.frontend_data["e2e_suite"] = serde_json::json!(true);
    } else if let Some(obj) = config.frontend_data.as_object_mut() {
        obj.remove("e2e_suite");
    }

    config
}

/// Write the split layout into one folder. Shared by roaming and override saves.
fn write_split_config(dir: &Path, config: &mut AppConfig) -> Result<(), String> {
    let mut fd = std::mem::take(&mut config.frontend_data);
    let state = extract_keys(&mut fd, STATE_KEYS);
    let sort = extract_keys(&mut fd, SORT_KEYS);
    let favorites = extract_keys(&mut fd, FAVORITES_KEYS);

    // Store custom CSS separately.
    let custom_css = fd
        .get("custom_css")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if let Some(obj) = fd.as_object_mut() {
        obj.remove("custom_css");
    }

    config.frontend_data = fd;

    let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
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
        &dir.join("quivit_favorites.json"),
        serde_json::to_string_pretty(&favorites).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    atomic_write(&dir.join("custom_css.css"), custom_css).map_err(|e| e.to_string())?;

    atomic_write(&dir.join("quivit_config.json"), data).map_err(|e| e.to_string())
}

/// Save into the override folder only. One layout per folder: a single-file
/// save drops split leftovers so stale files can never come back.
fn save_override(dir: &Path, mut config: AppConfig) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    if override_single_file() || config.portable_mode {
        let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        atomic_write(&dir.join("quivit_config.json"), data).map_err(|e| e.to_string())?;
        for name in &ROAMING_FILES[1..] {
            let _ = fs::remove_file(dir.join(name));
        }
    } else {
        write_split_config(dir, &mut config)?;
    }
    invalidate_library_cache();
    Ok(())
}

fn prepare_config_for_save(config: &mut AppConfig) {
    normalize_library_location_paths(config);
    if let Some(obj) = config.frontend_data.as_object_mut() {
        obj.remove("e2e_suite");
    }
}

pub fn save_config_unchecked_with_paths(
    exe_dir: &Path,
    roaming_dir_path: &Path,
    mut config: AppConfig,
) -> Result<(), String> {
    prepare_config_for_save(&mut config);
    let will_be_portable = config.portable_mode;
    let was_portable = is_portable_dir(exe_dir);
    let migrating = should_cleanup_old_location(was_portable, will_be_portable);

    if will_be_portable {
        fs::create_dir_all(exe_dir).map_err(|e| e.to_string())?;
        let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        let config_path = exe_dir.join("quivit_config.json");
        atomic_write(&config_path, data).map_err(|e| e.to_string())?;

        // Only the portable config file gets the hidden attribute.
        crate::platform::attributes::set_hidden_attribute(&config_path, config.hidden)?;

        // Migration only: a normal portable save must never touch roaming
        // user data. E2E and diagnose runs save portable configs routinely.
        if migrating {
            remove_roaming_files(roaming_dir_path);
        }
    } else {
        // Roaming: write the split files first, then remove portable leftovers so
        // a failed write never loses the config.
        fs::create_dir_all(roaming_dir_path).map_err(|e| e.to_string())?;
        write_split_config(roaming_dir_path, &mut config)?;

        // Migration only: leaving a stray exe-dir config behind would trap
        // the next launch back into portable mode via is_portable_dir.
        if migrating {
            let _ = fs::remove_file(exe_dir.join("quivit_config.json"));
        }
    }
    invalidate_library_cache();
    Ok(())
}

pub fn save_config_unchecked(roaming_dir_path: &Path, mut config: AppConfig) -> Result<(), String> {
    if let Some(dir) = override_config_dir() {
        prepare_config_for_save(&mut config);
        return save_override(&dir, config);
    }
    save_config_unchecked_with_paths(&get_exe_dir(), roaming_dir_path, config)
}

#[cfg(test)]
#[path = "tests/config_tests.rs"]
mod tests;
