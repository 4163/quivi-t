use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{Emitter, Manager};

use crate::archives::*;
use crate::formats::*;
use crate::ico::ico_frames_from_bytes;
use crate::models::*;
use crate::platform::attributes::is_hidden_path;

// ── Directory Watcher ────────────────────────────────────────────────────────

pub struct WatcherState {
    pub watcher: Option<RecommendedWatcher>,
    pub parent_watcher: Option<RecommendedWatcher>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            watcher: None,
            parent_watcher: None,
        }
    }
}

// ── Tauri commands ───────────────────────────────────────────────────────────

pub fn read_directory_impl(
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
            let file_type = if let Ok(ft) = entry.file_type() {
                ft
            } else {
                continue;
            };
            let is_dir = file_type.is_dir();
            let is_file = file_type.is_file();

            if is_dir || is_file {
                let mut include = false;
                let mut ext_upper = String::new();

                if is_dir {
                    include = true;
                } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if is_image_ext(ext) || is_archive_ext(ext) {
                        include = true;
                        ext_upper = ext.to_uppercase();
                    }
                }

                if include {
                    let name = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();
                    let metadata_res = entry.metadata();
                    let is_hidden = is_hidden_path(&name, metadata_res.as_ref().ok());

                    if !show_hidden && is_hidden {
                        continue;
                    }

                    let date = if let Ok(metadata) = &metadata_res {
                        if let Ok(modified) = metadata.modified() {
                            if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
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

                    if is_dir {
                        files.push(FileEntry::new_directory(
                            name.clone(),
                            path.to_string_lossy().into_owned(),
                            date,
                            is_hidden,
                        ));
                    } else {
                        files.push(FileEntry::new_file(
                            name.clone(),
                            path.to_string_lossy().into_owned(),
                            ext_upper,
                            date,
                            is_hidden,
                        ));
                    }
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
        target_filename: target_filename.to_string(),
        directory: dir.to_string_lossy().into_owned(),
        parent_directory: parent_dir_str,
    })
}

#[tauri::command(async)]
pub fn read_directory(
    path: String,
    show_hidden: Option<bool>,
    target_name: Option<String>,
) -> Result<DirectoryReadResult, String> {
    read_directory_impl(&path, show_hidden.unwrap_or(false), target_name.as_deref())
}

#[tauri::command(async)]
pub fn list_archive(
    archive_path: String,
    state: tauri::State<'_, Mutex<ArchiveCache>>,
) -> Result<ArchiveReadResult, String> {
    let mut cache = state.lock().map_err(|e| e.to_string())?;
    cache.prepare_archive(&archive_path)
}

#[tauri::command(async)]
pub fn prefetch_archive_entries(
    archive_path: String,
    entries: Vec<String>,
    state: tauri::State<'_, Mutex<ArchiveCache>>,
) -> Result<(), String> {
    let ext = archive_path.rsplit('.').next().unwrap_or("").to_lowercase();
    if ext != "zip" && ext != "cbz" {
        return Ok(());
    }

    for entry_name in entries {
        let mut cache = state.lock().map_err(|e| e.to_string())?;
        let _ = cache.read_entry_bytes(&archive_path, &entry_name);
    }

    Ok(())
}

#[tauri::command(async)]
pub fn get_archive_ico_frames(
    archive_path: String,
    entry_name: String,
    state: tauri::State<'_, Mutex<ArchiveCache>>,
) -> Result<String, String> {
    let data = state
        .lock()
        .map_err(|e| e.to_string())?
        .read_entry_bytes(&archive_path, &entry_name)?;
    ico_frames_from_bytes(&data)
}

#[tauri::command]
pub fn open_parent(
    current_dir: &str,
    show_hidden: Option<bool>,
) -> Result<DirectoryReadResult, String> {
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
pub fn open_sibling(
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
            let file_type = if let Ok(ft) = entry.file_type() {
                ft
            } else {
                continue;
            };
            if file_type.is_dir() {
                let p = entry.path();
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let metadata_res = entry.metadata();
                if !show_hidden && is_hidden_path(name, metadata_res.as_ref().ok()) {
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
        .position(|s| s.file_name().and_then(|n| n.to_str()).unwrap_or("") == current_name)
        .ok_or("Current directory not found among siblings")?;

    let new_idx = ((current_idx as i32 + delta).rem_euclid(siblings.len() as i32)) as usize;
    let sibling = &siblings[new_idx];

    read_directory_impl(sibling.to_str().unwrap_or(""), show_hidden, None)
}

#[tauri::command]
pub fn open_sibling_container(
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
        let current_idx = drives
            .iter()
            .position(|d| d.to_ascii_uppercase() == path_upper)
            .unwrap_or(0);
        let new_idx = ((current_idx as i32 + delta).rem_euclid(drives.len() as i32)) as usize;
        return Ok(drives[new_idx].clone());
    }

    let parent = parent_opt.unwrap();

    let mut siblings: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            let p = entry.path();
            let file_type = if let Ok(ft) = entry.file_type() {
                ft
            } else {
                continue;
            };
            let is_dir = file_type.is_dir();
            let is_archive = if file_type.is_file() {
                p.extension()
                    .and_then(|e| e.to_str())
                    .map(is_archive_ext)
                    .unwrap_or(false)
            } else {
                false
            };

            if is_dir || is_archive {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let metadata_res = entry.metadata();
                if !show_hidden && is_hidden_path(name, metadata_res.as_ref().ok()) {
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

    let new_idx = ((current_idx as i32 + delta).rem_euclid(siblings.len() as i32)) as usize;
    Ok(siblings[new_idx].to_string_lossy().into_owned())
}

#[tauri::command]
pub fn get_drives() -> Vec<String> {
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
pub fn get_path_kind(path: &str) -> String {
    let path = Path::new(path);
    if path.is_dir() {
        "directory".to_string()
    } else if path.is_file() {
        "file".to_string()
    } else {
        "missing".to_string()
    }
}

#[tauri::command]
pub fn watch_directory(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let state = app.state::<Mutex<WatcherState>>();
    let mut state = state.lock().unwrap();

    // Drop existing watchers to stop tracking the old directory
    state.watcher = None;
    state.parent_watcher = None;

    // Main watcher: fires on any change inside the directory
    let app_clone = app.clone();
    let mut watcher = notify::recommended_watcher(move |_res: notify::Result<Event>| {
        let _ = app_clone.emit("directory-changed", ());
    })
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .watch(Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch directory: {}", e))?;

    state.watcher = Some(watcher);

    // Parent watcher: detects when the directory itself is moved/renamed/deleted
    // from the outside. Only emits if our directory no longer exists at its path.
    let dir_path = PathBuf::from(&path);
    if let Some(parent) = dir_path.parent() {
        if !parent.as_os_str().is_empty() {
            let app_clone2 = app.clone();
            let child_path = dir_path.clone();
            let mut parent_watcher =
                notify::recommended_watcher(move |_res: notify::Result<Event>| {
                    if !child_path.exists() {
                        let _ = app_clone2.emit("directory-changed", ());
                    }
                })
                .map_err(|e| format!("Failed to create parent watcher: {}", e))?;

            let _ = parent_watcher.watch(parent, RecursiveMode::NonRecursive);
            state.parent_watcher = Some(parent_watcher);
        }
    }

    Ok(())
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[cfg(windows)]
use winreg::{enums::*, RegKey};

#[tauri::command]
pub fn get_format_status() -> Vec<FormatStatus> {
    let mut statuses = Vec::new();

    #[cfg(windows)]
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    for fmt in SUPPORTED_FORMATS {
        let mut registered = false;
        let expected_progid = format!("QuiviT.{}", fmt.ext.to_lowercase());

        #[cfg(windows)]
        {
            let mut actually_exists = false;
            let progid_path = format!(r#"Software\Classes\{}"#, expected_progid);
            if hkcu.open_subkey(&progid_path).is_ok() {
                actually_exists = true;
            }

            // Check UserChoice first — this is the actual default handler on Win10/11.
            // UserChoice is hash-protected and can only be set by the user through
            // Windows Settings, but we can *read* it to know if QuiviT is the active default.
            let userchoice_path = format!(
                r#"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{}\UserChoice"#,
                fmt.ext.to_lowercase()
            );
            if let Ok(uc_key) = hkcu.open_subkey(&userchoice_path) {
                if let Ok(prog_id) = uc_key.get_value::<String, _>("ProgId") {
                    if prog_id.eq_ignore_ascii_case(&expected_progid) && actually_exists {
                        registered = true;
                    }
                    // If UserChoice exists but points elsewhere, QuiviT is NOT the
                    // default — leave registered = false so the user can re-register.
                }
            } else {
                // No UserChoice set — fall back to checking Classes default value.
                // This covers fresh installs or formats where no app has claimed default.
                let ext_key_path = format!(r#"Software\Classes\.{}"#, fmt.ext.to_lowercase());
                if let Ok(ext_key) = hkcu.open_subkey(&ext_key_path) {
                    if let Ok(current_progid) = ext_key.get_value::<String, _>("") {
                        if current_progid.eq_ignore_ascii_case(&expected_progid) && actually_exists
                        {
                            registered = true;
                        }
                    }
                }
            }
        }

        statuses.push(FormatStatus {
            ext: fmt.ext.to_string(),
            name: fmt.name.to_string(),
            icon: fmt.icon.to_string(),
            category: fmt.category.to_string(),
            registered,
        });
    }

    statuses
}

const ICON_APNG: &[u8] = include_bytes!("../../icons/apng.ico");
const ICON_CBR: &[u8] = include_bytes!("../../icons/cbr.ico");
const ICON_CBZ: &[u8] = include_bytes!("../../icons/cbz.ico");
const ICON_GIF: &[u8] = include_bytes!("../../icons/gif.ico");
const ICON_SVG: &[u8] = include_bytes!("../../icons/svg.ico");
const ICON_WEBP: &[u8] = include_bytes!("../../icons/webp.ico");
const ICON_MOE: &[u8] = include_bytes!("../../icons/quivi-t_moe-icon.ico");

pub fn dump_icons(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let config_dir = crate::config::roaming_dir(app);
    let icon_dir = config_dir.join("icons");
    std::fs::create_dir_all(&icon_dir).map_err(|e| e.to_string())?;

    if let Err(e) = std::fs::write(icon_dir.join("apng.ico"), ICON_APNG) {
        return Err(e.to_string());
    }
    let _ = std::fs::write(icon_dir.join("cbr.ico"), ICON_CBR);
    let _ = std::fs::write(icon_dir.join("cbz.ico"), ICON_CBZ);
    let _ = std::fs::write(icon_dir.join("gif.ico"), ICON_GIF);
    let _ = std::fs::write(icon_dir.join("svg.ico"), ICON_SVG);
    let _ = std::fs::write(icon_dir.join("webp.ico"), ICON_WEBP);
    let _ = std::fs::write(icon_dir.join("quivi-t_moe-icon.ico"), ICON_MOE);

    Ok(icon_dir)
}

#[tauri::command]
pub fn register_associations(app: tauri::AppHandle, extensions: Vec<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = exe_path.to_string_lossy().into_owned();
        let icon_dir = dump_icons(&app)?;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        for ext in &extensions {
            let lower_ext = ext.to_lowercase();
            let format_info = SUPPORTED_FORMATS.iter().find(|f| f.ext == lower_ext);
            let display_name = format_info.map(|f| f.name).unwrap_or("QuiviT File");
            let icon_name = format_info
                .map(|f| f.icon)
                .unwrap_or("quivi-t_moe-icon.ico");

            let progid = format!("QuiviT.{}", lower_ext);

            // 1. HKCU\Software\Classes\.ext
            let ext_key_path = format!(r#"Software\Classes\.{}"#, lower_ext);
            let (ext_key, _) = hkcu
                .create_subkey(&ext_key_path)
                .map_err(|e| format!("Failed creating subkey {}: {}", ext_key_path, e))?;
            let _ = ext_key.set_value("", &progid);

            // 2. HKCU\Software\Classes\.ext\OpenWithProgids
            let owp_path = format!(r#"Software\Classes\.{}\OpenWithProgids"#, lower_ext);
            if let Ok((owp_key, _)) = hkcu.create_subkey(&owp_path) {
                let _ = owp_key.set_value(&progid, &"");
            }

            // 3. HKCU\Software\Classes\QuiviT.ext
            let progid_path = format!(r#"Software\Classes\{}"#, progid);
            let (progid_key, _) = hkcu
                .create_subkey(&progid_path)
                .map_err(|e| format!("Failed creating progid {}: {}", progid_path, e))?;
            let _ = progid_key.set_value("", &display_name);

            // DefaultIcon
            let icon_path_key = format!(r#"Software\Classes\{}\DefaultIcon"#, progid);
            let (icon_key, _) = hkcu
                .create_subkey(&icon_path_key)
                .map_err(|e| format!("Failed creating DefaultIcon {}: {}", icon_path_key, e))?;
            let full_icon_path = icon_dir.join(icon_name).to_string_lossy().into_owned();
            let _ = icon_key.set_value("", &full_icon_path);

            // shell\open\command
            let cmd_path = format!(r#"Software\Classes\{}\shell\open\command"#, progid);
            let (cmd_key, _) = hkcu
                .create_subkey(&cmd_path)
                .map_err(|e| format!("Failed creating command {}: {}", cmd_path, e))?;
            let cmd_val = format!(r#""{}" "%1""#, exe_str);
            let _ = cmd_key.set_value("", &cmd_val);
        }

        // 4. Register app capabilities so QuiviT appears in Windows Default Apps
        let (cap_key, _) = hkcu
            .create_subkey(r"Software\QuiviT\Capabilities")
            .map_err(|e| format!("Failed creating Capabilities key: {}", e))?;
        let _ = cap_key.set_value("ApplicationName", &"QuiviT");
        let _ = cap_key.set_value("ApplicationDescription", &"QuiviT Image Viewer");

        // 5. Populate Capabilities\FileAssociations with all registered extensions
        let (fa_key, _) = hkcu
            .create_subkey(r"Software\QuiviT\Capabilities\FileAssociations")
            .map_err(|e| format!("Failed creating FileAssociations key: {}", e))?;
        for ext in &extensions {
            let lower_ext = ext.to_lowercase();
            let progid = format!("QuiviT.{}", lower_ext);
            let _ = fa_key.set_value(format!(".{}", lower_ext), &progid);
        }

        // 6. Register in RegisteredApplications so Windows knows about QuiviT
        let (reg_apps, _) = hkcu
            .create_subkey(r"Software\RegisteredApplications")
            .map_err(|e| format!("Failed creating RegisteredApplications: {}", e))?;
        let _ = reg_apps.set_value("QuiviT", &r"Software\QuiviT\Capabilities");

        // 7. Register the application itself to ensure it shows up in "Open With"
        let (app_key, _) = hkcu
            .create_subkey(r"Software\Classes\Applications\quivit.exe")
            .map_err(|e| format!("Failed creating quivit.exe key: {}", e))?;

        let (app_cmd, _) = app_key
            .create_subkey(r"shell\open\command")
            .map_err(|e| format!("Failed creating app command key: {}", e))?;
        let _ = app_cmd.set_value("", &format!(r#""{}" "%1""#, exe_str));

        let (app_supported, _) = app_key
            .create_subkey("SupportedTypes")
            .map_err(|e| format!("Failed creating SupportedTypes key: {}", e))?;

        for ext in &extensions {
            let lower_ext = ext.to_lowercase();
            let _ = app_supported.set_value(format!(".{}", lower_ext), &"");
        }

        // Notify shell to refresh icons
        unsafe {
            use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        }
        return Ok(());
    }

    #[cfg(not(windows))]
    return Err("File associations are only supported natively on Windows.".into());
}

#[tauri::command]
pub fn unregister_associations(extensions: Vec<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        for ext in &extensions {
            let lower_ext = ext.to_lowercase();
            let progid = format!("QuiviT.{}", lower_ext);

            // Remove ProgId class entry
            let progid_path = format!(r#"Software\Classes\{}"#, progid);
            let _ = hkcu.delete_subkey_all(&progid_path);

            // If .ext default is our progid, clear it
            let ext_key_path = format!(r#"Software\Classes\.{}"#, lower_ext);
            if let Ok(ext_key) = hkcu.open_subkey_with_flags(&ext_key_path, KEY_ALL_ACCESS) {
                if let Ok(default_val) = ext_key.get_value::<String, _>("") {
                    if default_val.eq_ignore_ascii_case(&progid) {
                        let _ = ext_key.delete_value("");
                    }
                }
            }

            // Remove from OpenWithProgids
            let owp_path = format!(r#"Software\Classes\.{}\OpenWithProgids"#, lower_ext);
            if let Ok(owp_key) = hkcu.open_subkey_with_flags(&owp_path, KEY_ALL_ACCESS) {
                let _ = owp_key.delete_value(&progid);
            }

            // Remove from Capabilities\FileAssociations
            if let Ok(fa_key) = hkcu.open_subkey_with_flags(
                r"Software\QuiviT\Capabilities\FileAssociations",
                KEY_ALL_ACCESS,
            ) {
                let _ = fa_key.delete_value(format!(".{}", lower_ext));
            }

            // Remove from Applications\quivit.exe\SupportedTypes
            if let Ok(app_supported) = hkcu.open_subkey_with_flags(
                r"Software\Classes\Applications\quivit.exe\SupportedTypes",
                KEY_ALL_ACCESS,
            ) {
                let _ = app_supported.delete_value(format!(".{}", lower_ext));
            }
        }

        // If no more file associations remain, clean up Capabilities + RegisteredApplications
        let mut has_remaining = false;
        if let Ok(fa_key) = hkcu.open_subkey(r"Software\QuiviT\Capabilities\FileAssociations") {
            has_remaining = fa_key.enum_values().count() > 0;
        }
        if !has_remaining {
            let _ = hkcu.delete_subkey_all(r"Software\QuiviT");
            if let Ok(reg_apps) =
                hkcu.open_subkey_with_flags(r"Software\RegisteredApplications", KEY_ALL_ACCESS)
            {
                let _ = reg_apps.delete_value("QuiviT");
            }
        }

        // Clean up Applications\quivit.exe if no SupportedTypes remain
        if let Ok(app_supported) =
            hkcu.open_subkey(r"Software\Classes\Applications\quivit.exe\SupportedTypes")
        {
            if app_supported.enum_values().count() == 0 {
                let _ = hkcu.delete_subkey_all(r"Software\Classes\Applications\quivit.exe");
            }
        }

        unsafe {
            use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
        }
        return Ok(());
    }

    #[cfg(not(windows))]
    return Err("File associations are only supported natively on Windows.".into());
}

#[tauri::command]
pub fn get_initial_args() -> Vec<String> {
    std::env::args().collect()
}

#[tauri::command]
pub fn pick_folder(window: tauri::Window) -> Result<Option<String>, String> {
    let hwnd = window.hwnd().map(|h| h.0 as isize).ok();
    crate::platform::dialog::pick_folder(hwnd)
}
