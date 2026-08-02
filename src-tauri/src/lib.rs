use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::http::Response;
use tauri::{Manager, Emitter};
use tauri_plugin_opener::OpenerExt;
use notify::{Watcher, RecursiveMode, RecommendedWatcher, Event};

#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

// ── Supported formats ────────────────────────────────────────────────────────

const SUPPORTED_IMAGES: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "apng", "svg", "bmp", "ico", "avif",
];

const SUPPORTED_ARCHIVES: &[&str] = &["zip", "cbz", "rar", "cbr"];

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

fn roaming_dir(app_handle: &tauri::AppHandle) -> PathBuf {
    let path = app_handle.path().app_config_dir().unwrap_or_default();
    fs::create_dir_all(&path).ok();
    path
}

// ── Config split helpers ──────────────────────────────────────────────────────
// Runtime state (last-opened location, remembered images), per-directory
// sort prefs, and favorites are persisted as their own files so the roaming
// config file only holds user preferences. Portable mode keeps a single
// self-contained file.

const STATE_KEYS: &[&str] = &["last_opened_path", "last_active_image"];
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
        // Single self-contained file beside the executable
        let _ = fs::write(exe_dir.join(".portable"), "");
        let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
        fs::write(exe_dir.join("quivit_config.json"), data).map_err(|e| e.to_string())?;
    } else {
        // Roaming: remove portable leftovers, then split into config/state/sort files
        let _ = fs::remove_file(exe_dir.join(".portable"));
        let _ = fs::remove_file(exe_dir.join("quivit_config.json"));

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

struct ArchiveCache {
    /// Key: archive_path, Value: map of entry_name → bytes
    entries: HashMap<String, HashMap<String, Vec<u8>>>,
}

impl ArchiveCache {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    fn get(&self, archive_path: &str, entry_name: &str) -> Option<&Vec<u8>> {
        self.entries.get(archive_path)?.get(entry_name)
    }

    fn has_archive(&self, archive_path: &str) -> bool {
        self.entries.contains_key(archive_path)
    }

    fn insert_archive(&mut self, archive_path: String, entries: HashMap<String, Vec<u8>>) {
        self.entries.insert(archive_path, entries);
    }

    fn clear(&mut self) {
        self.entries.clear();
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

fn read_zip_entries(archive_path: &str) -> Result<HashMap<String, Vec<u8>>, String> {
    let file = fs::File::open(archive_path).map_err(|e| format!("Cannot open archive: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Invalid ZIP archive: {e}"))?;

    let mut entries = HashMap::new();

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Error reading ZIP entry: {e}"))?;
        let name = entry.name().to_string();

        // Skip directories and non-image files
        if entry.is_dir() {
            continue;
        }
        let ext = name.rsplit('.').next().unwrap_or("");
        if !is_image_ext(ext) {
            continue;
        }

        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("Error reading ZIP entry data: {e}"))?;

        entries.insert(name, buf);
    }

    Ok(entries)
}

// ── RAR reading ──────────────────────────────────────────────────────────────

fn read_rar_entries(archive_path: &str) -> Result<HashMap<String, Vec<u8>>, String> {
    let mut entries = HashMap::new();

    let archive = unrar::Archive::new(archive_path)
        .open_for_processing()
        .map_err(|e| format!("Cannot open RAR archive: {e}"))?;

    let mut iter = archive;
    loop {
        let result = iter.read_header();
        match result {
            Ok(Some(header)) => {
                let entry = header.entry();
                let name = entry.filename.to_string_lossy().to_string();
                let is_file = !entry.is_directory();

                if is_file {
                    let ext = name.rsplit('.').next().unwrap_or("");
                    if is_image_ext(ext) {
                        // Extract to memory
                        let (data, next) = header
                            .read()
                            .map_err(|e| format!("Error reading RAR entry: {e}"))?;
                        entries.insert(name, data);
                        iter = next;
                        continue;
                    }
                }

                // Skip this entry
                iter = header
                    .skip()
                    .map_err(|e| format!("Error skipping RAR entry: {e}"))?;
            }
            Ok(None) => break,
            Err(e) => return Err(format!("Error iterating RAR archive: {e}")),
        }
    }

    Ok(entries)
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
                        name,
                        path: path.to_string_lossy().into_owned(),
                        ext: ext_upper,
                        date,
                        is_dir,
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
fn read_archive(
    archive_path: &str,
    state: tauri::State<'_, Mutex<ArchiveCache>>,
) -> Result<ArchiveReadResult, String> {
    let mut cache = state.lock().map_err(|e| format!("Lock error: {e}"))?;

    // Load the archive into cache if not already loaded
    if !cache.has_archive(archive_path) {
        cache.clear(); // Only cache one archive at a time to limit memory

        let ext = archive_path.rsplit('.').next().unwrap_or("").to_lowercase();
        let entries = match ext.as_str() {
            "zip" | "cbz" => read_zip_entries(archive_path)?,
            "rar" | "cbr" => read_rar_entries(archive_path)?,
            _ => return Err(format!("Unsupported archive format: {ext}")),
        };

        cache.insert_archive(archive_path.to_string(), entries);
    }

    // Build the sorted file list from cached entries
    let entry_map = cache.entries.get(archive_path).unwrap();
    let mut files: Vec<FileEntry> = entry_map
        .keys()
        .map(|name| {
            let ext = name
                .rsplit('.')
                .next()
                .unwrap_or("")
                .to_uppercase();
            FileEntry {
                name: name.clone(),
                path: format!("{}|{}", archive_path, name), // pipe-separated for protocol
                ext,
                date: "".to_string(),
                is_dir: false,
            }
        })
        .collect();

    files.sort_by(|a, b| natord::compare(&a.name, &b.name));

    Ok(ArchiveReadResult {
        files,
        archive_path: archive_path.to_string(),
    })
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
            read_archive,
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
            get_ico_frames
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

            let state = ctx.app_handle().state::<Mutex<ArchiveCache>>();
            let cache = state.lock().unwrap();

            if let Some(data) = cache.get(&archive_path, &entry_name) {
                let mime = guess_mime(&entry_name);
                let response = Response::builder()
                    .status(200)
                    .header("Content-Type", mime)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(data.clone())
                    .unwrap();
                responder.respond(response);
            } else {
                let response = Response::builder()
                    .status(404)
                    .body(b"Entry not found in archive cache".to_vec())
                    .unwrap();
                responder.respond(response);
            }
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
    let mut result = String::new();
    let mut chars = input.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next().unwrap_or(0);
            let lo = chars.next().unwrap_or(0);
            let hex =
                String::from_utf8(vec![hi, lo]).unwrap_or_default();
            if let Ok(val) = u8::from_str_radix(&hex, 16) {
                result.push(val as char);
            }
        } else {
            result.push(b as char);
        }
    }
    result
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
