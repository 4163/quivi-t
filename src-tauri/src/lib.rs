use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::http::Response;
use tauri::{Manager, Emitter};
use tauri_plugin_opener::OpenerExt;
use notify::{Watcher, RecursiveMode, RecommendedWatcher, Event};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

#[cfg(windows)]
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_USEFILEATTRIBUTES};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, DestroyIcon, DrawIconEx, DI_NORMAL};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{GetDC, ReleaseDC, CreateCompatibleDC, DeleteDC, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, DeleteObject, CreateDIBSection, SelectObject, GetObjectW, BITMAP};
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_DIRECTORY};
#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

// ── Supported formats ────────────────────────────────────────────────────────

const SUPPORTED_IMAGES: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "apng", "svg", "bmp", "ico", "avif",
];

const SUPPORTED_ARCHIVES: &[&str] = &["zip", "cbz", "rar", "cbr", "7z", "cb7", "cbt", "tar"];

fn is_image_ext(ext: &str) -> bool {
    SUPPORTED_IMAGES.contains(&ext.to_lowercase().as_str())
}

fn is_archive_ext(ext: &str) -> bool {
    SUPPORTED_ARCHIVES.contains(&ext.to_lowercase().as_str())
}

// ── Configuration ────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
struct AppConfig {
    portable_mode: bool,
    frontend_data: JsonValue,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            portable_mode: false,
            frontend_data: serde_json::json!({}),
        }
    }
}

fn get_exe_dir() -> PathBuf {
    std::env::current_exe()
        .unwrap_or_default()
        .parent()
        .unwrap_or(Path::new(""))
        .to_path_buf()
}

fn is_portable() -> bool {
    let exe_dir = get_exe_dir();
    exe_dir.join(".portable").exists() || exe_dir.join("quivit_config.json").exists()
}

fn roaming_dir_path(app_handle: &tauri::AppHandle) -> PathBuf {
    app_handle.path().app_config_dir().unwrap_or_default()
}

fn roaming_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    let path = roaming_dir_path(app_handle);
    fs::create_dir_all(&path).ok();
    path
}

const ROAMING_FILES: &[&str] = &[
    "quivit_config.json",
    "quivit_state.json",
    "quivit_directory_sort.json",
    "quivit_favorites.json",
];

fn remove_roaming_files(dir: &Path) {
    for name in ROAMING_FILES {
        let _ = fs::remove_file(dir.join(name));
    }
}

// ── Config split helpers ──────────────────────────────────────────────────────
// Runtime state (last-opened location, remembered images), per-directory
// sort prefs, and favorites are persisted as their own files so the roaming
// config file only holds user preferences. Portable mode keeps a single
// self-contained file.

const STATE_KEYS: &[&str] = &["last_opened_path", "last_active_image", "scroll_zoom_latched"];
const SORT_KEYS: &[&str] = &["directory_sort"];
const FAVORITES_KEYS: &[&str] = &["favorites", "favorites_collapsed"];

fn extract_keys(src: &mut JsonValue, keys: &[&str]) -> JsonValue {
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

fn merge_keys(dst: &mut JsonValue, src: JsonValue) {
    if let (Some(d), Some(s)) = (dst.as_object_mut(), src.as_object()) {
        for (k, v) in s {
            d.insert(k.clone(), v.clone());
        }
    }
}

fn read_json_file<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn merge_file_into(path: &Path, frontend_data: &mut JsonValue) {
    if let Some(value) = read_json_file::<JsonValue>(path) {
        merge_keys(frontend_data, value);
    }
}

#[tauri::command]
fn load_config(app_handle: tauri::AppHandle) -> AppConfig {
    if is_portable() {
        return read_json_file(&get_exe_dir().join("quivit_config.json")).unwrap_or_default();
    }

    let dir = roaming_dir(&app_handle);
    let mut config: AppConfig = read_json_file(&dir.join("quivit_config.json")).unwrap_or_default();
    // New layout: state, directory-sort, and favorites live in their own files.
    // Legacy layout (everything in quivit_config.json) loads unchanged.
    merge_file_into(&dir.join("quivit_state.json"), &mut config.frontend_data);
    merge_file_into(&dir.join("quivit_directory_sort.json"), &mut config.frontend_data);
    merge_file_into(&dir.join("quivit_favorites.json"), &mut config.frontend_data);
    config
}

// Static pointers shown in Options. The global config folder always points at
// the roaming location (%APPDATA%\com.x4163.quivit); the local folder always
// points beside the executable (the portable location). They do not track the
// "Save config data locally" state.

#[tauri::command]
fn get_config_dir(app_handle: tauri::AppHandle) -> String {
    roaming_dir(&app_handle).to_string_lossy().into_owned()
}

#[tauri::command]
fn open_config_dir(app_handle: tauri::AppHandle) -> Result<(), String> {
    let dir = roaming_dir(&app_handle);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config directory: {e}"))?;
    app_handle
        .opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| format!("Failed to open config directory: {e}"))
}

#[tauri::command]
fn get_local_data_dir() -> String {
    get_exe_dir().to_string_lossy().into_owned()
}

#[tauri::command]
fn open_local_data_dir(app_handle: tauri::AppHandle) -> Result<(), String> {
    let dir = get_exe_dir();
    app_handle
        .opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| format!("Failed to open local data directory: {e}"))
}

#[tauri::command]
fn save_config(app_handle: tauri::AppHandle, mut config: AppConfig) -> Result<(), String> {
    let exe_dir = get_exe_dir();

    if config.portable_mode {
        // Portable: write the single self-contained file beside the executable
        // first, then drop the roaming copies so exactly one location stays active.
        let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        fs::write(exe_dir.join("quivit_config.json"), data).map_err(|e| e.to_string())?;
        let _ = fs::write(exe_dir.join(".portable"), "");

        remove_roaming_files(&roaming_dir_path(&app_handle));
    } else {
        // Roaming: write the split files first, then remove portable leftovers so
        // a failed write never loses the config.
        let mut fd = std::mem::take(&mut config.frontend_data);
        let state = extract_keys(&mut fd, STATE_KEYS);
        let sort = extract_keys(&mut fd, SORT_KEYS);
        let favorites = extract_keys(&mut fd, FAVORITES_KEYS);
        config.frontend_data = fd;

        let dir = roaming_dir(&app_handle);
        let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        fs::write(dir.join("quivit_config.json"), data).map_err(|e| e.to_string())?;
        fs::write(
            dir.join("quivit_state.json"),
            serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::write(
            dir.join("quivit_directory_sort.json"),
            serde_json::to_string_pretty(&sort).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::write(
            dir.join("quivit_favorites.json"),
            serde_json::to_string_pretty(&favorites).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;

        let _ = fs::remove_file(exe_dir.join(".portable"));
        let _ = fs::remove_file(exe_dir.join("quivit_config.json"));
    }
    Ok(())
}

#[tauri::command]
async fn open_options(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("options") {
        window.show().map_err(|e| format!("Failed to show options window: {e}"))?;
        window.set_focus().map_err(|e| format!("Failed to focus options window: {e}"))?;
        return Ok(());
    }

    const OPT_W: f64 = 560.0;
    const OPT_H: f64 = 620.0;

    // Try to position centered over the main window; fall back to screen center.
    let position: Option<tauri::PhysicalPosition<i32>> = (|| {
        let main = app.get_webview_window("main")?;
        let pos  = main.outer_position().ok()?;
        let size = main.outer_size().ok()?;
        let scale = main.scale_factor().ok()?;
        let x = pos.x + (size.width  as i32 - (OPT_W * scale) as i32) / 2;
        let y = pos.y + (size.height as i32 - (OPT_H * scale) as i32) / 2;
        Some(tauri::PhysicalPosition::new(x, y))
    })();

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "options",
        tauri::WebviewUrl::App("options.html".into())
    )
    .title("Options")
    .inner_size(OPT_W, OPT_H)
    .min_inner_size(460.0, 420.0)
    .resizable(true)
    .closable(true)
    .maximizable(false)
    .visible(true)
    .devtools(cfg!(debug_assertions));

    let window = if let Some(pos) = position {
        builder.position(pos.x as f64, pos.y as f64)
    } else {
        builder.center()
    }
    .build()
    .map_err(|e| format!("Failed to open options window: {e}"))?;

    window.show().map_err(|e| format!("Failed to show options window: {e}"))?;
    window.set_focus().map_err(|e| format!("Failed to focus options window: {e}"))
}


// ── Data structures ──────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct FileEntry {
    name: String,
    path: String,
    ext: String,
    date: String,
    is_dir: bool,
    is_hidden: bool,
}

#[derive(Serialize)]
struct DirectoryReadResult {
    files: Vec<FileEntry>,
    initial_index: usize,
    directory: String,
    parent_directory: Option<String>,
}

#[derive(Serialize)]
struct ArchiveReadResult {
    files: Vec<FileEntry>,
    archive_path: String,
}

// ── Archive cache (thread-safe) ──────────────────────────────────────────────
// Caches extracted bytes so we don't re-read the archive for every image.

use std::collections::VecDeque;
use std::collections::HashSet;
use std::sync::{Arc, Condvar};

struct ArchiveCache {
    active_path: Option<String>,
    zip_entries: HashMap<String, Vec<u8>>,
    zip_lru: VecDeque<String>,
    zip_capacity: usize,
    extract_temp_dir: Option<PathBuf>,
    zip_archive: Option<zip::ZipArchive<std::fs::File>>,
    extract_notify: Arc<(Mutex<HashSet<String>>, Condvar)>,
}

impl ArchiveCache {
    fn new() -> Self {
        Self {
            active_path: None,
            zip_entries: HashMap::new(),
            zip_lru: VecDeque::new(),
            zip_capacity: 20, // Keep 20 images in RAM
            extract_temp_dir: None,
            zip_archive: None,
            extract_notify: Arc::new((Mutex::new(HashSet::new()), Condvar::new())),
        }
    }
}

// ── Directory Watcher ────────────────────────────────────────────────────────

struct WatcherState {
    watcher: Option<RecommendedWatcher>,
}

impl WatcherState {
    fn new() -> Self {
        Self { watcher: None }
    }
}

// ── ZIP reading ──────────────────────────────────────────────────────────────

fn list_zip_entries(archive_path: &str) -> Result<Vec<FileEntry>, String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Cannot open archive: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid ZIP archive: {e}"))?;
    let mut files = Vec::new();

    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("Error reading ZIP entry: {e}"))?;
        let name = entry.name().to_string();
        if entry.is_dir() { continue; }
        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        if !is_image_ext(&ext) { continue; }

        files.push(FileEntry {
            name: name.clone(),
            path: format!("{}|{}", archive_path, name),
            ext: ext.to_uppercase(),
            date: "".to_string(),
            is_dir: false,
            is_hidden: false,
        });
    }
    
    files.sort_by(|a, b| natord::compare(&a.name, &b.name));
    Ok(files)
}

fn extract_zip_entry(archive_path: &str, entry_name: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Cannot open archive: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid ZIP archive: {e}"))?;
    
    let mut entry = archive.by_name(entry_name).map_err(|e| format!("Cannot find ZIP entry {}: {}", entry_name, e))?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    std::io::Read::read_to_end(&mut entry, &mut buf).map_err(|e| format!("Error reading entry: {e}"))?;
    Ok(buf)
}

// ── RAR reading ──────────────────────────────────────────────────────────────

fn list_rar_entries(archive_path: &str) -> Result<Vec<FileEntry>, String> {
    let archive = unrar::Archive::new(archive_path)
        .open_for_processing()
        .map_err(|e| format!("Cannot open RAR archive: {e}"))?;

    let mut iter = archive;
    let mut files = Vec::new();
    loop {
        match iter.read_header() {
            Ok(Some(header)) => {
                let entry = header.entry();
                let name = entry.filename.to_string_lossy().to_string();
                if !entry.is_directory() {
                    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
                    if is_image_ext(&ext) {
                        files.push(FileEntry {
                            name: name.clone(),
                            path: format!("{}|{}", archive_path, name),
                            ext: ext.to_uppercase(),
                            date: "".to_string(),
                            is_dir: false,
                            is_hidden: false,
                        });
                    }
                }
                iter = header.skip().map_err(|e| e.to_string())?;
            }
            Ok(None) => break,
            Err(e) => return Err(format!("Error iterating RAR archive: {e}")),
        }
    }
    files.sort_by(|a, b| natord::compare(&a.name, &b.name));
    Ok(files)
}

fn extract_rar_to_temp(archive_path: String, temp_dir: PathBuf, notify: Arc<(Mutex<HashSet<String>>, Condvar)>) {
    if let Ok(archive) = unrar::Archive::new(&archive_path).open_for_processing() {
        let mut iter = archive;
        loop {
            match iter.read_header() {
                Ok(Some(header)) => {
                    let entry = header.entry();
                    let name = entry.filename.to_string_lossy().to_string();
                    if !entry.is_directory() {
                        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
                        if is_image_ext(&ext) {
                            if let Ok((data, next)) = header.read() {
                                let safe_name = name.replace('\\', "/");
                                let out_path = temp_dir.join(&safe_name);
                                if let Some(parent) = out_path.parent() {
                                    fs::create_dir_all(parent).ok();
                                }
                                let tmp_path = temp_dir.join(format!("{}.tmp", safe_name));
                                if fs::write(&tmp_path, &data).is_ok() {
                                    if fs::rename(&tmp_path, &out_path).is_ok() {
                                        let (lock, cvar) = &*notify;
                                        let mut set = lock.lock().unwrap();
                                        set.insert(name.clone());
                                        cvar.notify_all();
                                    }
                                }
                                iter = next;
                                continue;
                            } else {
                                break;
                            }
                        }
                    }
                    if let Ok(next) = header.skip() {
                        iter = next;
                    } else {
                        break;
                    }
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
    }
}

// ── 7z reading ──────────────────────────────────────────────────────────────
// Solid 7z archives (single compression block, as commonly produced) cannot do
// random access — decompressing any entry requires decompressing everything
// before it. Listing only parses the header, but serving individual entries
// goes through the same sequential temp-dir pipeline as RAR.

fn list_7z_entries(archive_path: &str) -> Result<Vec<FileEntry>, String> {
    let reader = sevenz_rust2::ArchiveReader::open(archive_path, sevenz_rust2::Password::empty())
        .map_err(|e| format!("Cannot open 7z archive: {e}"))?;
    let archive = reader.archive();

    let mut files = Vec::new();
    for entry in &archive.files {
        if entry.is_directory() || entry.is_anti_item() {
            continue;
        }
        let name = entry.name().to_string();
        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        if !is_image_ext(&ext) {
            continue;
        }

        files.push(FileEntry {
            name: name.clone(),
            path: format!("{}|{}", archive_path, name),
            ext: ext.to_uppercase(),
            date: "".to_string(),
            is_dir: false,
            is_hidden: false,
        });
    }

    files.sort_by(|a, b| natord::compare(&a.name, &b.name));
    Ok(files)
}

fn extract_7z_to_temp(archive_path: String, temp_dir: PathBuf, notify: Arc<(Mutex<HashSet<String>>, Condvar)>) {
    let Ok(mut reader) = sevenz_rust2::ArchiveReader::open(&archive_path, sevenz_rust2::Password::empty()) else {
        return;
    };
    let _ = reader.for_each_entries(|entry, data| {
        if entry.is_directory() || entry.is_anti_item() {
            return Ok(true);
        }
        let name = entry.name().to_string();
        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        if !is_image_ext(&ext) {
            return Ok(true);
        }
        let safe_name = name.replace('\\', "/");
        let out_path = temp_dir.join(&safe_name);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).ok();
        }
        let tmp_path = temp_dir.join(format!("{}.tmp", safe_name));
        if let Ok(mut file) = fs::File::create(&tmp_path) {
            if std::io::copy(data, &mut file).is_ok() {
                drop(file);
                if fs::rename(&tmp_path, &out_path).is_ok() {
                    let (lock, cvar) = &*notify;
                    let mut set = lock.lock().unwrap();
                    set.insert(name.clone());
                    cvar.notify_all();
                }
            }
        }
        Ok(true)
    });
}

// ── TAR reading ─────────────────────────────────────────────────────────────
// TAR is uncompressed with seekable entries, so individual files can be read
// on demand with no temp extraction and no in-memory cache.

fn list_tar_entries(archive_path: &str) -> Result<Vec<FileEntry>, String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Cannot open TAR archive: {e}"))?;
    let mut archive = tar::Archive::new(file);

    let mut files = Vec::new();
    let entries = archive.entries().map_err(|e| format!("Cannot read TAR entries: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Error reading TAR entry: {e}"))?;
        let name = entry
            .path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if entry.header().entry_type().is_dir() {
            continue;
        }
        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        if !is_image_ext(&ext) {
            continue;
        }

        files.push(FileEntry {
            name: name.clone(),
            path: format!("{}|{}", archive_path, name),
            ext: ext.to_uppercase(),
            date: "".to_string(),
            is_dir: false,
            is_hidden: false,
        });
    }

    files.sort_by(|a, b| natord::compare(&a.name, &b.name));
    Ok(files)
}

fn extract_tar_entry(archive_path: &str, entry_name: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Cannot open TAR archive: {e}"))?;
    let mut archive = tar::Archive::new(file);
    let entries = archive.entries().map_err(|e| format!("Cannot read TAR entries: {e}"))?;

    for entry in entries {
        let mut entry = entry.map_err(|e| format!("Error reading TAR entry: {e}"))?;
        let name = entry
            .path()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        if name == entry_name {
            let mut buf = Vec::with_capacity(entry.size() as usize);
            std::io::Read::read_to_end(&mut entry, &mut buf)
                .map_err(|e| format!("Error reading TAR entry {entry_name}: {e}"))?;
            return Ok(buf);
        }
    }

    Err(format!("Cannot find TAR entry {}", entry_name))
}

// ── Tauri commands ───────────────────────────────────────────────────────────

fn is_hidden_path(path: &Path, name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }

    #[cfg(windows)]
    {
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if let Ok(metadata) = fs::metadata(path) {
            return metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0;
        }
    }

    false
}

fn read_directory_impl(
    path: &str,
    show_hidden: bool,
    target_name_override: Option<&str>,
) -> Result<DirectoryReadResult, String> {
    let input_path = Path::new(path);
    if !input_path.exists() {
        return Err("Path does not exist".into());
    }

    let dir = if input_path.is_file() {
        input_path.parent().unwrap_or(Path::new(""))
    } else {
        input_path
    };

    let target_filename = if let Some(name) = target_name_override {
        name
    } else if input_path.is_file() {
        input_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
    } else {
        ""
    };

    let mut files = Vec::new();

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_dir = path.is_dir();
            let is_file = path.is_file();

            if is_dir || is_file {
                let mut include = false;
                let mut ext_upper = String::new();

                if is_dir {
                    include = true;
                } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if is_image_ext(&ext_lower) || is_archive_ext(&ext_lower) {
                        include = true;
                        ext_upper = ext_lower.to_uppercase();
                    }
                }

                if include {
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();
                    if !show_hidden && is_hidden_path(&path, &name) {
                        continue;
                    }

                    let date = if let Ok(metadata) = path.metadata() {
                        if let Ok(modified) = metadata.modified() {
                            if let Ok(duration) =
                                modified.duration_since(std::time::UNIX_EPOCH)
                            {
                                duration.as_millis().to_string()
                            } else {
                                "".to_string()
                            }
                        } else {
                            "".to_string()
                        }
                    } else {
                        "".to_string()
                    };

                    files.push(FileEntry {
                        name: name.clone(),
                        path: path.to_string_lossy().into_owned(),
                        ext: ext_upper,
                        date,
                        is_dir,
                        is_hidden: is_hidden_path(&path, &name),
                    });
                }
            }
        }
    }

    files.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| natord::compare(&a.name, &b.name))
    });

    let initial_index = files
        .iter()
        .position(|f| f.name == target_filename)
        .unwrap_or(0);

    let parent_dir_str = if let Some(parent) = dir.parent() {
        if parent.as_os_str().is_empty() {
            Some("__DRIVES__".to_string())
        } else {
            Some(parent.to_string_lossy().into_owned())
        }
    } else {
        Some("__DRIVES__".to_string())
    };

    Ok(DirectoryReadResult {
        files,
        initial_index,
        directory: dir.to_string_lossy().into_owned(),
        parent_directory: parent_dir_str,
    })
}

#[tauri::command]
fn read_directory(path: &str, show_hidden: Option<bool>) -> Result<DirectoryReadResult, String> {
    read_directory_impl(path, show_hidden.unwrap_or(false), None)
}

#[tauri::command]
fn list_archive(
    archive_path: &str,
    state: tauri::State<'_, Mutex<ArchiveCache>>,
) -> Result<ArchiveReadResult, String> {
    let mut cache = state.lock().map_err(|e| e.to_string())?;

    if cache.active_path.as_deref() != Some(archive_path) {
        cache.active_path = Some(archive_path.to_string());
        cache.zip_entries.clear();
        cache.zip_lru.clear();
        cache.zip_archive = None;
        cache.extract_notify = Arc::new((Mutex::new(HashSet::new()), Condvar::new()));
        
        // Cleanup old rar/7z temp dir if exists
        if let Some(old_dir) = &cache.extract_temp_dir {
            let _ = fs::remove_dir_all(old_dir);
        }
        cache.extract_temp_dir = None;

        let ext = archive_path.rsplit('.').next().unwrap_or("").to_lowercase();
        if ext == "rar" || ext == "cbr" || ext == "7z" || ext == "cb7" {
            let hash = format!("{:x}", md5::compute(archive_path));
            let temp_dir = std::env::temp_dir().join("QuiviT").join(hash);
            fs::create_dir_all(&temp_dir).ok();
            cache.extract_temp_dir = Some(temp_dir.clone());
            
            let notify = cache.extract_notify.clone();
            // Spawn background extractor
            let archive_path_clone = archive_path.to_string();
            std::thread::spawn(move || {
                if ext == "rar" || ext == "cbr" {
                    extract_rar_to_temp(archive_path_clone, temp_dir, notify);
                } else {
                    extract_7z_to_temp(archive_path_clone, temp_dir, notify);
                }
            });
        } else if ext == "zip" || ext == "cbz" {
            if let Ok(file) = fs::File::open(&archive_path) {
                if let Ok(archive) = zip::ZipArchive::new(file) {
                    cache.zip_archive = Some(archive);
                }
            }
        }
    }

    let ext = archive_path.rsplit('.').next().unwrap_or("").to_lowercase();
    let files = match ext.as_str() {
        "zip" | "cbz" => list_zip_entries(archive_path)?,
        "rar" | "cbr" => list_rar_entries(archive_path)?,
        "7z" | "cb7" => list_7z_entries(archive_path)?,
        "cbt" | "tar" => list_tar_entries(archive_path)?,
        _ => return Err(format!("Unsupported archive format: {ext}")),
    };

    Ok(ArchiveReadResult {
        files,
        archive_path: archive_path.to_string(),
    })
}

#[tauri::command(async)]
fn prefetch_archive_entries(
    archive_path: String,
    entries: Vec<String>,
    state: tauri::State<'_, Mutex<ArchiveCache>>,
) -> Result<(), String> {
    let ext = archive_path.rsplit('.').next().unwrap_or("").to_lowercase();
    if ext != "zip" && ext != "cbz" {
        return Ok(());
    }

    for entry_name in entries {
        // Skip if already in cache
        {
            let cache = state.lock().unwrap();
            if cache.active_path.as_deref() != Some(archive_path.as_str()) {
                break; // archive changed
            }
            if cache.zip_entries.contains_key(&entry_name) {
                continue;
            }
        }

        let extracted = {
            let mut cache = state.lock().unwrap();
            if cache.active_path.as_deref() != Some(archive_path.as_str()) {
                break;
            }
            if let Some(archive) = cache.zip_archive.as_mut() {
                if let Ok(mut entry) = archive.by_name(&entry_name) {
                    let mut data = Vec::with_capacity(entry.size() as usize);
                    if std::io::Read::read_to_end(&mut entry, &mut data).is_ok() {
                        Some(data)
                    } else { None }
                } else { None }
            } else { None }
        };

        let data = if let Some(d) = extracted { d } else {
            if let Ok(d) = extract_zip_entry(&archive_path, &entry_name) { d } else { continue }
        };

        let mut cache = state.lock().unwrap();
        if cache.active_path.as_deref() == Some(archive_path.as_str()) && !cache.zip_entries.contains_key(&entry_name) {
            cache.zip_capacity = 20;
            if cache.zip_lru.len() >= cache.zip_capacity {
                if let Some(oldest) = cache.zip_lru.pop_front() {
                    cache.zip_entries.remove(&oldest);
                }
            }
            cache.zip_entries.insert(entry_name.clone(), data);
            cache.zip_lru.push_back(entry_name);
        }
    }
    
    Ok(())
}

#[tauri::command]
fn open_parent(current_dir: &str, show_hidden: Option<bool>) -> Result<DirectoryReadResult, String> {
    let path = Path::new(current_dir);
    let parent = path.parent().ok_or("Already at root")?;
    // On Windows, a drive root like "E:\" has parent == "" — treat that as root too
    if parent.as_os_str().is_empty() {
        return Err("Already at root".to_string());
    }
    let target_name = path.file_name().and_then(|n| n.to_str());
    read_directory_impl(
        parent.to_str().unwrap_or(""),
        show_hidden.unwrap_or(false),
        target_name,
    )
}

#[tauri::command]
fn open_sibling(
    current_dir: &str,
    delta: i32,
    show_hidden: Option<bool>,
) -> Result<DirectoryReadResult, String> {
    let path = Path::new(current_dir);
    let parent = path.parent().ok_or("Already at root")?;
    let show_hidden = show_hidden.unwrap_or(false);

    let mut siblings: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !show_hidden && is_hidden_path(&p, name) {
                    continue;
                }
                siblings.push(p);
            }
        }
    }

    siblings.sort_by(|a, b| {
        natord::compare(
            &a.file_name().unwrap_or_default().to_string_lossy(),
            &b.file_name().unwrap_or_default().to_string_lossy(),
        )
    });

    let current_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let current_idx = siblings
        .iter()
        .position(|s| {
            s.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                == current_name
        })
        .ok_or("Current directory not found among siblings")?;

    let new_idx =
        ((current_idx as i32 + delta).rem_euclid(siblings.len() as i32)) as usize;
    let sibling = &siblings[new_idx];

    read_directory_impl(sibling.to_str().unwrap_or(""), show_hidden, None)
}

#[tauri::command]
fn open_sibling_container(
    current_path: &str,
    delta: i32,
    show_hidden: Option<bool>,
) -> Result<String, String> {
    let path = Path::new(current_path);
    let show_hidden = show_hidden.unwrap_or(false);

    let parent_opt = path.parent();
    
    // If we are at the root (no parent), jump between drives
    if parent_opt.is_none() {
        let drives = get_drives();
        if drives.is_empty() {
            return Err("No drives found".into());
        }
        
        let path_upper = current_path.to_ascii_uppercase();
        let current_idx = drives.iter().position(|d| d.to_ascii_uppercase() == path_upper).unwrap_or(0);
        let new_idx = ((current_idx as i32 + delta).rem_euclid(drives.len() as i32)) as usize;
        return Ok(drives[new_idx].clone());
    }

    let parent = parent_opt.unwrap();

    let mut siblings: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            let p = entry.path();
            let is_dir = p.is_dir();
            let is_archive = p
                .extension()
                .and_then(|e| e.to_str())
                .map(is_archive_ext)
                .unwrap_or(false);

            if is_dir || is_archive {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !show_hidden && is_hidden_path(&p, name) {
                    continue;
                }
                siblings.push(p);
            }
        }
    }

    if siblings.is_empty() {
        return Err("No sibling folders or archives found".into());
    }

    siblings.sort_by(|a, b| {
        b.is_dir().cmp(&a.is_dir()).then_with(|| {
            natord::compare(
                &a.file_name().unwrap_or_default().to_string_lossy(),
                &b.file_name().unwrap_or_default().to_string_lossy(),
            )
        })
    });

    let current_idx = siblings
        .iter()
        .position(|s| s == path)
        .ok_or("Current folder/archive not found among siblings")?;

    let new_idx =
        ((current_idx as i32 + delta).rem_euclid(siblings.len() as i32)) as usize;
    Ok(siblings[new_idx].to_string_lossy().into_owned())
}

#[tauri::command]
fn get_drives() -> Vec<String> {
    let mut drives = Vec::new();
    for c in b'A'..=b'Z' {
        let path = format!("{}:\\", c as char);
        if std::path::Path::new(&path).exists() {
            drives.push(path);
        }
    }
    drives
}

#[tauri::command]
fn watch_directory(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<Mutex<WatcherState>>();
    let mut state = state.lock().unwrap();
    
    // Drop existing watcher to stop tracking the old directory
    state.watcher = None;
    
    let app_clone = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            if event.kind.is_create() || event.kind.is_remove() || event.kind.is_modify() {
                let _ = app_clone.emit("directory-changed", ());
            }
        }
    }).map_err(|e| format!("Failed to create watcher: {}", e))?;
    
    watcher
        .watch(Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch directory: {}", e))?;
        
    state.watcher = Some(watcher);
    Ok(())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

// ── ICO Spritesheet ──────────────────────────────────────────────────────────

/// Extract all frames from an ICO file and return them as a horizontal
/// spritesheet encoded as a PNG data-URL.
#[tauri::command]
fn get_ico_frames(path: String) -> Result<String, String> {
    let data = fs::read(&path).map_err(|e| format!("Cannot read ICO file: {e}"))?;
    
    // Parse the ICO directory header manually to find all image entries,
    // then decode each sub-image individually.
    if data.len() < 6 {
        return Err("File too small to be an ICO".into());
    }
    
    // ICO header: reserved(2) + type(2) + count(2)
    let count = u16::from_le_bytes([data[4], data[5]]) as usize;
    if count == 0 || data.len() < 6 + count * 16 {
        return Err("Invalid ICO file structure".into());
    }
    
    let mut frames: Vec<image::DynamicImage> = Vec::new();
    
    for i in 0..count {
        let entry_offset = 6 + i * 16;
        let offset = u32::from_le_bytes([
            data[entry_offset + 12],
            data[entry_offset + 13],
            data[entry_offset + 14],
            data[entry_offset + 15],
        ]) as usize;
        let size = u32::from_le_bytes([
            data[entry_offset + 8],
            data[entry_offset + 9],
            data[entry_offset + 10],
            data[entry_offset + 11],
        ]) as usize;
        
        if offset + size > data.len() {
            continue;
        }
        
        let frame_data = &data[offset..offset + size];
        
        // Try to decode as PNG first (modern ICOs embed PNG), then as BMP
        let img = if frame_data.starts_with(b"\x89PNG") {
            image::load_from_memory_with_format(frame_data, image::ImageFormat::Png)
                .map_err(|e| format!("Failed to decode PNG frame: {e}"))
        } else {
            // BMP frame in ICO: needs ICO-specific BMP handling
            // Fallback: use image::load_from_memory with the full ICO
            image::load_from_memory_with_format(&data, image::ImageFormat::Ico)
                .map_err(|e| format!("Failed to decode ICO: {e}"))
        };
        
        match img {
            Ok(image) => frames.push(image),
            Err(_) => continue,
        }
        
        // For BMP frames we only use the whole-ICO fallback once
        if !frame_data.starts_with(b"\x89PNG") {
            break;
        }
    }
    
    if frames.is_empty() {
        // Last resort: just load the whole ICO
        let img = image::load_from_memory_with_format(&data, image::ImageFormat::Ico)
            .map_err(|e| format!("Failed to decode ICO: {e}"))?;
        frames.push(img);
    }
    
    // Sort largest to smallest for a consistent left-to-right order
    frames.sort_by(|a, b| b.width().cmp(&a.width()));
    // Deduplicate by width/height
    frames.dedup_by(|a, b| a.width() == b.width() && a.height() == b.height());
    
    let total_width: u32 = frames.iter().map(|f| f.width()).sum();
    let max_height: u32 = frames.iter().map(|f| f.height()).max().unwrap_or(0);
    
    let mut spritesheet = image::RgbaImage::new(total_width, max_height);
    let mut x_offset = 0u32;
    for frame in &frames {
        let rgba = frame.to_rgba8();
        let y_offset = (max_height - rgba.height()) / 2;
        for (px, py, pixel) in rgba.enumerate_pixels() {
            spritesheet.put_pixel(x_offset + px, y_offset + py, *pixel);
        }
        x_offset += rgba.width();
    }
    
    // Encode as PNG and return as data-URL
    let mut png_bytes: Vec<u8> = Vec::new();
    {
        use image::ImageEncoder;
        let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
        encoder
            .write_image(
                spritesheet.as_raw(),
                spritesheet.width(),
                spritesheet.height(),
                image::ColorType::Rgba8.into(),
            )
            .map_err(|e| format!("Failed to encode PNG: {e}"))?;
    }
    
    let b64 = base64_encode(&png_bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((n >> 18) & 63) as usize] as char);
        result.push(CHARS[((n >> 12) & 63) as usize] as char);
        result.push(if chunk.len() > 1 { CHARS[((n >> 6) & 63) as usize] as char } else { '=' });
        result.push(if chunk.len() > 2 { CHARS[(n & 63) as usize] as char } else { '=' });
    }
    result
}

#[tauri::command]
fn get_native_icon(ext: &str) -> Result<Option<String>, String> {
    #[cfg(not(windows))]
    return Ok(None);

    #[cfg(windows)]
    unsafe {
        use image::RgbaImage;
        use std::io::Cursor;
        use base64::prelude::*;

        let is_folder = ext == "__folder__";

        let dummy_name = if is_folder {
            "dummy".to_string()
        } else {
            let name = format!("dummy{}", if ext.starts_with('.') { "" } else { "." });
            format!("{}{}", name, ext)
        };
        
        let ext_wide: Vec<u16> = OsStr::new(&dummy_name).encode_wide().chain(std::iter::once(0)).collect();
        let mut shfi = SHFILEINFOW::default();
        let flags = SHGFI_ICON | SHGFI_USEFILEATTRIBUTES | windows::Win32::UI::Shell::SHGFI_SMALLICON;
        let attrs = if is_folder {
            FILE_ATTRIBUTE_DIRECTORY
        } else {
            FILE_ATTRIBUTE_NORMAL
        };

        let res = SHGetFileInfoW(
            windows::core::PCWSTR(ext_wide.as_ptr()),
            attrs,
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        );

        if res == 0 || shfi.hIcon.is_invalid() {
            return Ok(None);
        }

        let hicon = shfi.hIcon;
        
        let mut icon_info = windows::Win32::UI::WindowsAndMessaging::ICONINFO::default();
        if GetIconInfo(hicon, &mut icon_info).is_err() {
            let _ = DestroyIcon(hicon);
            return Ok(None);
        }

        // Get bitmap info
        let mut bmp = BITMAP::default();
        GetObjectW(
            icon_info.hbmColor.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut std::ffi::c_void),
        );

        let width = bmp.bmWidth as u32;
        let height = bmp.bmHeight as u32;
        
        let hdc_screen = GetDC(None);
        let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
        
        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = width as i32;
        bmi.bmiHeader.biHeight = -(height as i32); // top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB.0;

        let mut pixels: Vec<u8> = vec![0; (width * height * 4) as usize];
        
        let mut bits_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        let hbm_dib = match CreateDIBSection(
            Some(hdc_mem),
            &bmi,
            DIB_RGB_COLORS,
            &mut bits_ptr,
            None,
            0,
        ) {
            Ok(h) => h,
            Err(_) => {
                let _ = DeleteDC(hdc_mem);
                let _ = ReleaseDC(None, hdc_screen);
                let _ = DeleteObject(icon_info.hbmColor.into());
                let _ = DeleteObject(icon_info.hbmMask.into());
                let _ = DestroyIcon(hicon);
                return Ok(None);
            }
        };

        if hbm_dib.is_invalid() {
            let _ = DeleteDC(hdc_mem);
            let _ = ReleaseDC(None, hdc_screen);
            let _ = DeleteObject(icon_info.hbmColor.into());
            let _ = DeleteObject(icon_info.hbmMask.into());
            let _ = DestroyIcon(hicon);
            return Ok(None);
        }

        let old_bmp = SelectObject(hdc_mem, hbm_dib.into());
        
        // Draw the icon onto the DIB
        let _ = DrawIconEx(
            hdc_mem,
            0,
            0,
            hicon,
            width as i32,
            height as i32,
            0,
            None,
            DI_NORMAL,
        );
        
        // Copy bits from DIB to our vec
        std::ptr::copy_nonoverlapping(bits_ptr as *const u8, pixels.as_mut_ptr(), pixels.len());
        
        // Clean up GDI
        SelectObject(hdc_mem, old_bmp);
        let _ = DeleteObject(hbm_dib.into());
        let _ = DeleteDC(hdc_mem);
        let _ = ReleaseDC(None, hdc_screen);
        
        let _ = DeleteObject(icon_info.hbmColor.into());
        let _ = DeleteObject(icon_info.hbmMask.into());
        let _ = DestroyIcon(hicon);
        
        // Convert BGRA to RGBA
        for chunk in pixels.chunks_exact_mut(4) {
            let b = chunk[0];
            let r = chunk[2];
            chunk[0] = r;
            chunk[2] = b;
        }

        let img = RgbaImage::from_raw(width, height, pixels).ok_or("Failed to create RgbaImage")?;
        let mut buf = Cursor::new(Vec::new());
        image::write_buffer_with_format(
            &mut buf,
            &img,
            width,
            height,
            image::ColorType::Rgba8,
            image::ImageFormat::Png,
        ).map_err(|e| e.to_string())?;
        
        let base64_str = BASE64_STANDARD.encode(buf.into_inner());
        let data_uri = format!("data:image/png;base64,{}", base64_str);
        
        Ok(Some(data_uri))
    }
}

// ── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second instance was launched. Focus the primary window and
            // optionally open the file that was passed as an argument.
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.show();
                let _ = main_window.set_focus();
                // If a path was passed, emit it so main.js can load it
                if argv.len() > 1 {
                    let path = argv[1].clone();
                    let _ = main_window.emit("single-instance-open", path);
                }
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(ArchiveCache::new()))
        .manage(Mutex::new(WatcherState::new()))
        .invoke_handler(tauri::generate_handler![
            read_directory,
            list_archive,
            prefetch_archive_entries,
            open_parent,
            open_sibling,
            open_sibling_container,
            load_config,
            get_config_dir,
            open_config_dir,
            get_local_data_dir,
            open_local_data_dir,
            save_config,
            open_options,
            get_drives,
            watch_directory,
            open_in_explorer,
            read_text_file,
            write_text_file,
            get_default_dir,
            get_ico_frames,
            get_native_icon
        ])
        .register_asynchronous_uri_scheme_protocol("quivit", |ctx, request, responder| {
            // Protocol: quivit://archive/<archive_path_base64>/<entry_name>
            let url = request.uri().to_string();

            // URL could be http://quivit.localhost/archive/... or quivit://localhost/archive/...
            let parts: Vec<&str> = url.splitn(2, "/archive/").collect();

            if parts.len() < 2 {
                let response = Response::builder()
                    .status(400)
                    .body(format!("Invalid quivit URL: {}", url).into_bytes())
                    .unwrap();
                responder.respond(response);
                return;
            }

            let path_parts: Vec<&str> = parts[1].splitn(2, '/').collect();
            if path_parts.len() < 2 {
                let response = Response::builder()
                    .status(400)
                    .body(b"Missing archive path or entry name".to_vec())
                    .unwrap();
                responder.respond(response);
                return;
            }

            let archive_path = match base64_decode(path_parts[0]) {
                Some(p) => p,
                None => {
                    let response = Response::builder()
                        .status(400)
                        .body(b"Invalid base64 archive path".to_vec())
                        .unwrap();
                    responder.respond(response);
                    return;
                }
            };

            // URL-decode the entry name (handles %20, etc.)
            let entry_name = urlencoding_decode(path_parts[1]);
            
            let app_handle = ctx.app_handle().clone();

            std::thread::spawn(move || {
                let mut data = None;
                let ext = archive_path.rsplit('.').next().unwrap_or("").to_lowercase();
                
                {
                    let state = app_handle.state::<Mutex<ArchiveCache>>();
                    let cache = state.lock().unwrap();
                    
                    if ext == "zip" || ext == "cbz" {
                        if let Some(cached_data) = cache.zip_entries.get(&entry_name) {
                            data = Some(cached_data.clone());
                        }
                    } else if ext == "rar" || ext == "cbr" || ext == "7z" || ext == "cb7" {
                        if let Some(temp_dir) = &cache.extract_temp_dir {
                            let safe_name = entry_name.replace('\\', "/");
                            let file_path = temp_dir.join(&safe_name);
                            if let Ok(bytes) = fs::read(&file_path) {
                                data = Some(bytes);
                            }
                        }
                    }
                }
                
                if data.is_none() {
                    if ext == "zip" || ext == "cbz" {
                        let extracted = {
                            let state = app_handle.state::<Mutex<ArchiveCache>>();
                            let mut cache = state.lock().unwrap();
                            if cache.active_path.as_deref() == Some(archive_path.as_str()) {
                                if let Some(archive) = cache.zip_archive.as_mut() {
                                    if let Ok(mut entry) = archive.by_name(&entry_name) {
                                        let mut d = Vec::with_capacity(entry.size() as usize);
                                        if std::io::Read::read_to_end(&mut entry, &mut d).is_ok() {
                                            Some(d)
                                        } else { None }
                                    } else { None }
                                } else { None }
                            } else { None }
                        };
                        
                        let d = if let Some(d) = extracted { d } else {
                            extract_zip_entry(&archive_path, &entry_name).unwrap_or_default()
                        };
                        
                        if !d.is_empty() {
                            data = Some(d.clone());
                            let state = app_handle.state::<Mutex<ArchiveCache>>();
                            let mut cache = state.lock().unwrap();
                            if cache.active_path.as_deref() == Some(archive_path.as_str()) {
                                cache.zip_capacity = 20;
                                if cache.zip_lru.len() >= cache.zip_capacity {
                                    if let Some(oldest) = cache.zip_lru.pop_front() {
                                        cache.zip_entries.remove(&oldest);
                                    }
                                }
                                cache.zip_entries.insert(entry_name.clone(), d);
                                cache.zip_lru.push_back(entry_name.clone());
                            }
                        }
                    } else if ext == "rar" || ext == "cbr" || ext == "7z" || ext == "cb7" {
                        let (temp_dir_opt, notify_opt) = {
                            let state = app_handle.state::<Mutex<ArchiveCache>>();
                            let cache = state.lock().unwrap();
                            (cache.extract_temp_dir.clone(), Some(cache.extract_notify.clone()))
                        };
                        if let Some(temp_dir) = temp_dir_opt {
                            let safe_name = entry_name.replace('\\', "/");
                            let file_path = temp_dir.join(&safe_name);
                            
                            if let Ok(bytes) = fs::read(&file_path) {
                                data = Some(bytes);
                            } else if let Some(notify) = notify_opt {
                                let (lock, cvar) = &*notify;
                                let set = lock.lock().unwrap();
                                let timeout = std::time::Duration::from_secs(30);
                                let _ = cvar.wait_timeout_while(set, timeout, |pending| {
                                    !pending.contains(&entry_name)
                                }).unwrap();
                                
                                if let Ok(bytes) = fs::read(&file_path) {
                                    data = Some(bytes);
                                }
                            }
                        }
                    } else if ext == "cbt" || ext == "tar" {
                        if let Ok(extracted) = extract_tar_entry(&archive_path, &entry_name) {
                            data = Some(extracted);
                        }
                    }
                }

                if let Some(d) = data {
                    let mime = guess_mime(&entry_name);
                    let response = Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Content-Length", d.len().to_string())
                        .header("Access-Control-Allow-Origin", "*")
                        .body(d)
                        .unwrap();
                    responder.respond(response);
                } else {
                    let response = Response::builder()
                        .status(404)
                        .body(b"Entry not found or failed to extract".to_vec())
                        .unwrap();
                    responder.respond(response);
                }
            });
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Utility functions ────────────────────────────────────────────────────────

fn base64_decode(input: &str) -> Option<String> {
    // Simple base64 decoder (no external crate needed for this)
    let decoded = base64_decode_bytes(input)?;
    String::from_utf8(decoded).ok()
}

fn base64_decode_bytes(input: &str) -> Option<Vec<u8>> {
    let input = input.replace('-', "+").replace('_', "/");
    let padding = (4 - input.len() % 4) % 4;
    let padded = format!("{}{}", input, "=".repeat(padding));

    let table: Vec<u8> = (0..256)
        .map(|i| {
            match i as u8 as char {
                'A'..='Z' => (i - 65) as u8,
                'a'..='z' => (i - 97 + 26) as u8,
                '0'..='9' => (i - 48 + 52) as u8,
                '+' => 62,
                '/' => 63,
                _ => 255,
            }
        })
        .collect();

    let mut output = Vec::new();
    let bytes = padded.as_bytes();

    for chunk in bytes.chunks(4) {
        if chunk.len() < 4 {
            break;
        }
        let vals: Vec<u8> = chunk.iter().map(|&b| table[b as usize]).collect();
        if vals.iter().any(|&v| v == 255 && chunk[vals.iter().position(|&x| x == 255).unwrap()] != b'=') {
            return None;
        }

        output.push((vals[0] << 2) | (vals[1] >> 4));
        if chunk[2] != b'=' {
            output.push((vals[1] << 4) | (vals[2] >> 2));
        }
        if chunk[3] != b'=' {
            output.push((vals[2] << 6) | vals[3]);
        }
    }

    Some(output)
}

fn urlencoding_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut decoded: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(val) = u8::from_str_radix(hex, 16) {
                decoded.push(val);
                i += 3;
                continue;
            }
        }
        decoded.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(decoded).unwrap_or_default()
}

#[tauri::command]
fn open_in_explorer(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_default_dir() -> String {
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return format!("{}\\Pictures", profile);
        }
    }
    String::new()
}

fn guess_mime(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "apng" => "image/apng",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod archive_tests {
    use super::*;
    use std::io::Read;

    fn test_file(name: &str) -> std::path::PathBuf {
        // Tests run with CWD = src-tauri; test files live under the repo root.
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test-files")
            .join("archives")
            .join(name)
    }

    /// Returns the cbt.cbt fixture, rebuilding it from the 7z fixture if it is
    /// missing or invalid, so the tar tests are self-provisioning (no external
    /// 7z/7za required).
    fn ensure_cbt() -> std::path::PathBuf {
        let cbt = test_file("cbt.cbt");
        let valid = cbt.exists()
            && list_tar_entries(cbt.to_str().unwrap())
                .map(|f| f.len() >= 12 && f.iter().any(|e| e.name.contains('/')))
                .unwrap_or(false);
        if valid {
            return cbt;
        }
        // Re-pack images extracted from the 7z fixture (which carries the same
        // root images + New folder/) into the cbt.
        let seven = test_file("7z.7z");
        let hash = format!("{:x}", md5::compute(seven.to_str().unwrap()));
        let scratch = std::env::temp_dir().join("QuiviT-test-cbt").join(hash);
        let _ = fs::remove_dir_all(&scratch);
        let notify = std::sync::Arc::new((std::sync::Mutex::new(std::collections::HashSet::new()), std::sync::Condvar::new()));
        extract_7z_to_temp(seven.to_str().unwrap().to_string(), scratch.clone(), notify);

        let mut builder = tar::Builder::new(fs::File::create(&cbt).expect("create cbt"));
        for entry in fs::read_dir(&scratch).expect("read extracted source folder") {
            let entry = entry.expect("source entry");
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                // Nested New folder/ entries
                for nested in fs::read_dir(entry.path()).expect("read nested folder") {
                    let nested = nested.expect("nested entry");
                    let nname = nested.file_name().to_string_lossy().into_owned();
                    let bytes = fs::read(nested.path()).expect("read nested image");
                    let mut header = tar::Header::new_gnu();
                    header.set_size(bytes.len() as u64);
                    header.set_mode(0o644);
                    header.set_mtime(0);
                    builder
                        .append_data(&mut header, format!("{name}/{nname}"), bytes.as_slice())
                        .expect("append nested tar entry");
                }
            } else {
                let bytes = fs::read(entry.path()).expect("read extracted image");
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o644);
                header.set_mtime(0);
                builder
                    .append_data(&mut header, name, bytes.as_slice())
                    .expect("append tar entry");
            }
        }
        builder.finish().expect("finish tar");
        let _ = fs::remove_dir_all(&scratch);
        cbt
    }
    #[test]
    fn lists_solid_7z_with_nested_folders() {
        let path = test_file("7z.7z");
        let files = list_7z_entries(path.to_str().unwrap()).expect("list 7z");
        assert!(files.len() >= 12, "expected >=12 image entries, got {}", files.len());
        // Composite archive|entry paths, nested folder preserved
        assert!(files.iter().any(|f| f.path.contains('|')));
        assert!(files.iter().any(|f| f.name.contains('/')));
        // Sorted naturally
        let names: Vec<&String> = files.iter().map(|f| &f.name).collect();
        let mut sorted = names.clone();
        sorted.sort_by(|a, b| natord::compare(a, b));
        assert_eq!(names, sorted);
    }

    #[test]
    fn extracts_solid_7z_to_temp() {
        let path = test_file("7z.7z");
        let hash = format!("{:x}", md5::compute(path.to_str().unwrap()));
        let temp_dir = std::env::temp_dir().join("QuiviT-test-extract").join(hash);
        let _ = fs::remove_dir_all(&temp_dir);
        let notify = std::sync::Arc::new((std::sync::Mutex::new(std::collections::HashSet::new()), std::sync::Condvar::new()));
        extract_7z_to_temp(path.to_str().unwrap().to_string(), temp_dir.clone(), notify);

        // A nested entry must exist and match the same-named root entry
        // (the test 7z carries duplicate copies).
        let nested = temp_dir.join("New folder/export_1785518859589.webp");
        assert!(nested.exists(), "nested entry not extracted");
        let mut buf = Vec::new();
        fs::File::open(&nested)
            .unwrap()
            .read_to_end(&mut buf)
            .unwrap();
        let root = fs::read(temp_dir.join("export_1785518859589.webp")).unwrap();
        assert_eq!(buf.len(), root.len());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn lists_and_reads_tar() {
        let cbt = ensure_cbt();
        let files = list_tar_entries(cbt.to_str().unwrap()).expect("list tar");
        assert!(files.len() >= 12, "expected >=12 entries, got {}", files.len());
        let names: Vec<String> = files.iter().map(|f| f.name.clone()).collect();
        assert!(names.iter().any(|n| n.contains("gfl-spinner.svg")));
        assert!(names.iter().any(|n| n.contains("Mine_(Idol)_S2_09.webp")));
        // Nested folder preserved in the cbt
        assert!(names.iter().any(|n| n.starts_with("New folder/")));

        let data = extract_tar_entry(cbt.to_str().unwrap(), "export_1785518878919.png")
            .expect("extract tar entry");
        // The cbt entry must byte-match the same file inside the 7z fixture.
        let seven = test_file("7z.7z");
        let hash = format!("{:x}", md5::compute(seven.to_str().unwrap()));
        let scratch = std::env::temp_dir().join("QuiviT-test-cbt").join(hash);
        let _ = fs::remove_dir_all(&scratch);
        let notify = std::sync::Arc::new((std::sync::Mutex::new(std::collections::HashSet::new()), std::sync::Condvar::new()));
        extract_7z_to_temp(seven.to_str().unwrap().to_string(), scratch.clone(), notify);
        let original = fs::read(scratch.join("export_1785518878919.png")).unwrap();
        assert_eq!(data.len(), original.len());
        let _ = fs::remove_dir_all(&scratch);
    }

    #[test]
    fn supported_archives_include_new_formats() {
        for ext in ["7z", "cb7", "cbt", "tar"] {
            assert!(is_archive_ext(ext), "{} not recognized as archive", ext);
        }
    }

    #[test]
    fn lists_rar5_cbr() {
        let path = test_file("cbr.cbr");
        let files = list_rar_entries(path.to_str().unwrap()).expect("list cbr");
        assert!(files.len() >= 7, "expected >=7 image entries, got {}", files.len());
        assert!(files.iter().any(|f| f.name.contains("BDレーベル.bmp")));
    }

    #[test]
    fn lists_cb7_like_7z() {
        // cb7 is the comic-book extension for 7z — same codec, must route the same.
        let src = test_file("7z.7z");
        let cb7 = std::env::temp_dir().join("QuiviT-test-extract").join("sample.cb7");
        let _ = fs::remove_file(&cb7);
        fs::copy(&src, &cb7).expect("copy 7z to cb7");
        let files = list_7z_entries(cb7.to_str().unwrap()).expect("list cb7");
        assert!(files.len() >= 12, "cb7 listed {} entries", files.len());
        let _ = fs::remove_file(&cb7);
    }

    #[test]
    fn url_decode_roundtrips_utf8_entry_names() {
        // The 31MB BMP fixture is really named "BDレーベル.bmp". The frontend
        // builds the protocol URL with encodeURIComponent, so the handler must
        // decode percent-encoded multi-byte UTF-8 back to the original name.
        let name = "BDレーベル.bmp";
        let mut encoded = String::new();
        for b in name.as_bytes() {
            encoded.push_str(&format!("%{:02X}", b));
        }
        assert_eq!(urlencoding_decode(&encoded), name);
        // ASCII + spaces from encodeURIComponent also survive
        assert_eq!(urlencoding_decode("a%20b%26c.jpg"), "a b&c.jpg");
    }

    #[test]
    fn protocol_serve_timing_simulation() {
        // Mirrors the protocol handler serving path (lib.rs ~1190-1253):
        //  - rar/cbr/7z/cb7: served from extract_temp_dir, poll up to 3s (30x100ms)
        //  - zip/cbz: on-demand extract_zip_entry
        //  - cbt/tar: on-demand extract_tar_entry
        // Simulates the FIRST image request arriving right after list_archive
        // spawns the background extractor, then reports how long the first
        // entry takes to become servable and whether the 3s poll would 404.
        use std::time::{Duration, Instant};

        fn poll_temp(temp_dir: &std::path::Path, entry: &str, timeout_ms: u64) -> (bool, Duration) {
            let safe = entry.replace('\\', "/");
            let path = temp_dir.join(&safe);
            let start = Instant::now();
            for _ in 0..(timeout_ms / 100) {
                if path.exists() {
                    return (true, start.elapsed());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            (path.exists(), start.elapsed())
        }

        let seven = test_file("7z.7z");
        let hash = format!("{:x}", md5::compute(seven.to_str().unwrap()));
        let temp_dir = std::env::temp_dir().join("QuiviT-test-serve").join(hash);
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).ok();

        // Spawn background extraction exactly like list_archive does.
        let seven_path = seven.to_str().unwrap().to_string();
        let td = temp_dir.clone();
        let notify = std::sync::Arc::new((std::sync::Mutex::new(std::collections::HashSet::new()), std::sync::Condvar::new()));
        std::thread::spawn(move || extract_7z_to_temp(seven_path, td, notify));

        // First sorted entry is BAKEMONOGATARI...jpg. Poll it like the handler would.
        let first = "BAKEMONOGATARI - c013 (v03) - p002 [Kodansha Comics] [Digital] [1r0n] {HQ}.jpg";
        let (found, elapsed) = poll_temp(&temp_dir, first, 30000);
        eprintln!("7z first entry poll: found={found} elapsed={:?}", elapsed);
        assert!(found, "first 7z entry never became available within 30s poll -> 404");

        // Now the large BMP: how long until IT is extractable from the temp dir?
        let bmp = "BDレーベル.bmp";
        let (found_bmp, elapsed_bmp) = poll_temp(&temp_dir, bmp, 30000);
        eprintln!("7z BMP poll: found={found_bmp} elapsed={:?}", elapsed_bmp);

        // On-demand paths (cbz/tar) must serve the first image synchronously.
        let zip_first = extract_zip_entry(
            test_file("cbz.cbz").to_str().unwrap(),
            first,
        );
        eprintln!("cbz on-demand first entry: {}", zip_first.as_ref().map(|d| format!("{} bytes", d.len())).unwrap_or_else(|e| format!("ERR {e}")));
        assert!(zip_first.is_ok(), "cbz on-demand extraction failed: {:?}", zip_first.err());

        let tar_first = extract_tar_entry(
            test_file("cbt.cbt").to_str().unwrap(),
            first,
        );
        eprintln!("cbt on-demand first entry: {}", tar_first.as_ref().map(|d| format!("{} bytes", d.len())).unwrap_or_else(|e| format!("ERR {e}")));
        assert!(tar_first.is_ok(), "cbt on-demand extraction failed: {:?}", tar_first.err());

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
