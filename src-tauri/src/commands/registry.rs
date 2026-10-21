use crate::formats::*;
use crate::models::FormatStatus;

#[cfg(windows)]
use winreg::{enums::*, RegKey};

#[tauri::command(async)]
pub fn get_native_icon(
    path: String,
    ext_key: String,
    size: Option<String>,
) -> Result<Option<String>, String> {
    crate::platform::icons::get_cached_native_icon(&path, &ext_key, size.as_deref())
}

#[tauri::command]
pub fn invalidate_native_icon_cache() -> Result<(), String> {
    crate::platform::icons::clear_cached_native_icons()
}

#[tauri::command]
pub fn get_format_status() -> Vec<FormatStatus> {
    let mut statuses = Vec::new();

    #[cfg(windows)]
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    for fmt in SUPPORTED_FORMATS {
        let mut registered = false;
        let expected_progid = format!("QuiviT.{}", fmt.ext);

        #[cfg(windows)]
        {
            let mut actually_exists = false;
            let progid_path = format!(r#"Software\Classes\{}"#, expected_progid);
            if hkcu.open_subkey(&progid_path).is_ok() {
                actually_exists = true;
            }

            // Check UserChoice first. This is the actual default handler on Win10/11.
            // UserChoice is hash-protected and can only be set by the user through
            // Windows Settings, but we can read it to know if QuiviT is the active default.
            let userchoice_path = format!(
                r#"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{}\UserChoice"#,
                fmt.ext
            );
            if let Ok(uc_key) = hkcu.open_subkey(&userchoice_path) {
                if let Ok(prog_id) = uc_key.get_value::<String, _>("ProgId") {
                    if prog_id.eq_ignore_ascii_case(&expected_progid) && actually_exists {
                        registered = true;
                    }
                    // If UserChoice exists but points elsewhere, QuiviT is not the default.
                    // Leave registered = false so the user can register it again.
                }
            } else {
                // No UserChoice set. Fall back to checking Classes default value.
                // This covers fresh installs or formats where no app has claimed default.
                let ext_key_path = format!(r#"Software\Classes\.{}"#, fmt.ext);
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

/// Reports how Explorer resolves the QuiviT preview handler for each archive
/// type. Read-only; used to tell a stale registration or a foreign default
/// apart from a rendering failure.
#[tauri::command]
pub fn get_preview_diagnostics() -> Result<Vec<crate::models::PreviewDiagnostic>, String> {
    #[cfg(windows)]
    {
        use crate::models::PreviewDiagnostic;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let registered_by_ext: std::collections::HashMap<String, bool> = get_format_status()
            .into_iter()
            .map(|status| (status.ext, status.registered))
            .collect();

        let read_default = |root: &RegKey, path: &str| -> Option<String> {
            root.open_subkey(path)
                .and_then(|key| key.get_value::<String, _>(""))
                .ok()
        };
        let classes_default = |ext: &str| -> Option<String> {
            let path = format!(r#"Software\Classes\.{}"#, ext);
            read_default(&hkcu, &path).or_else(|| {
                hklm.open_subkey(format!(r#"SOFTWARE\Classes\.{}"#, ext))
                    .and_then(|key| key.get_value::<String, _>(""))
                    .ok()
            })
        };

        let clsid_path = format!(
            r"Software\Classes\CLSID\{}",
            crate::platform::previews::PREVIEW_HANDLER_CLSID_TEXT
        );
        let clsid_server = read_default(&hkcu, &format!(r"{}\LocalServer32", clsid_path));
        let hklm_clsid_server = read_default(&hklm, &format!(r"{}\LocalServer32", clsid_path));
        let in_handlers_list = hkcu
            .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\PreviewHandlers")
            .and_then(|key| {
                key.get_value::<String, _>(
                    crate::platform::previews::PREVIEW_HANDLER_CLSID_TEXT,
                )
            })
            .is_ok();

        let (host_path, host_exists, sidecar) =
            crate::platform::previews::host::staged_host_info();
        let host_path_text = host_path.to_string_lossy().into_owned();
        let staged_preview_version = sidecar.as_ref().map(|sidecar| sidecar.preview_version);
        let embedded_preview_version = crate::platform::previews::PREVIEW_HOST_VERSION;
        let stale = crate::platform::previews::host::is_stale_registration(
            clsid_server.as_deref(),
            &host_path,
        );

        let mut rows = Vec::new();
        for format in SUPPORTED_FORMATS
            .iter()
            .filter(|format| is_archive_ext(format.ext))
        {
            let userchoice_path = format!(
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{}\UserChoice",
                format.ext
            );
            let progid_preview_path = format!(
                r"Software\Classes\QuiviT.{}\shellex\{}",
                format.ext,
                crate::platform::previews::PREVIEW_HANDLER_CATEGORY
            );
            rows.push(PreviewDiagnostic {
                ext: format.ext.to_string(),
                registered: registered_by_ext.get(format.ext).copied().unwrap_or(false),
                classes_default: classes_default(format.ext),
                userchoice_progid: read_default(&hkcu, &userchoice_path),
                progid_preview_clsid: read_default(&hkcu, &progid_preview_path),
                clsid_server: clsid_server.clone(),
                hklm_clsid_server: hklm_clsid_server.clone(),
                in_preview_handlers_list: in_handlers_list,
                host_path: host_path_text.clone(),
                host_exists,
                staged_preview_version,
                embedded_preview_version,
                stale,
            });
        }
        return Ok(rows);
    }

    #[cfg(not(windows))]
    return Err("File associations are only supported natively on Windows.".into());
}

#[cfg(windows)]
fn sync_preview_associations_impl(stage_host_always: bool) -> Result<bool, String> {
    if crate::config::is_e2e_suite() {
        return Ok(false);
    }

    let host_path = if stage_host_always {
        match crate::platform::previews::ensure_previews_host() {
            Ok(path) => Some(path),
            Err(err) => {
                eprintln!("[previews] Staging notice: {err}");
                let fallback = crate::platform::previews::resolve_previews_host_path();
                if fallback.exists() {
                    Some(fallback)
                } else {
                    None
                }
            }
        }
    } else {
        let path = crate::platform::previews::resolve_previews_host_path();
        if path.exists() {
            Some(path)
        } else {
            crate::platform::previews::ensure_previews_host().ok()
        }
    };

    let exts: Vec<String> = get_format_status()
        .into_iter()
        .filter(|status| status.registered && is_archive_ext(&status.ext))
        .map(|status| status.ext)
        .collect();

    let Some(host) = host_path else {
        return Ok(false);
    };

    if exts.is_empty() {
        return Ok(false);
    }

    let mut changed = false;
    for ext in &exts {
        if crate::platform::previews::register_for_extension_with_host(ext, &host)? {
            changed = true;
        }
    }

    Ok(changed)
}

/// Spawns a background thread on startup to sync preview handlers. Ordinary
/// launches also stage the preview helper.
pub fn spawn_launch_previews_sync() {
    #[cfg(windows)]
    {
        if crate::config::is_e2e_suite() {
            return;
        }
        std::thread::spawn(|| {
            let args: Vec<_> = std::env::args_os().collect();
            let stage_host = !crate::platform::direct_open::has_file_open_arg(&args);
            match sync_preview_associations_impl(stage_host) {
                Ok(true) => unsafe {
                    use windows::Win32::UI::Shell::{
                        SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST,
                    };
                    SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
                },
                Ok(false) => {}
                Err(err) => eprintln!("[previews] Launch sync warning: {err}"),
            }
        });
    }
}

#[cfg(not(windows))]
pub fn spawn_launch_previews_sync() {}

/// Enables Explorer previews for active QuiviT archive associations when the
/// File Types page opens. Blocking registry plus staging work runs on a
/// background thread, and the helper stages exactly once per call.
#[tauri::command(async)]
pub async fn sync_preview_associations() -> Result<(), String> {
    #[cfg(windows)]
    {
        if crate::config::is_e2e_suite() {
            return Ok(());
        }
        let changed = tauri::async_runtime::spawn_blocking(|| {
            sync_preview_associations_impl(false)
        })
        .await
        .map_err(|err| format!("Preview repair worker failed: {err}"))??;

        if changed {
            unsafe {
                use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};
                SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
            }
        }
        return Ok(());
    }

    #[cfg(not(windows))]
    return Err("File associations are only supported natively on Windows.".into());
}

pub(crate) const FORMAT_ICONS: &[(&str, &[u8])] = &[
    ("7z.ico", include_bytes!("../../../icons/formats/7z.ico")),
    (
        "apng.ico",
        include_bytes!("../../../icons/formats/apng.ico"),
    ),
    (
        "avif.ico",
        include_bytes!("../../../icons/formats/avif.ico"),
    ),
    ("bmp.ico", include_bytes!("../../../icons/formats/bmp.ico")),
    ("cb7.ico", include_bytes!("../../../icons/formats/cb7.ico")),
    ("cbr.ico", include_bytes!("../../../icons/formats/cbr.ico")),
    ("cbt.ico", include_bytes!("../../../icons/formats/cbt.ico")),
    ("cbz.ico", include_bytes!("../../../icons/formats/cbz.ico")),
    ("dib.ico", include_bytes!("../../../icons/formats/dib.ico")),
    ("gif.ico", include_bytes!("../../../icons/formats/gif.ico")),
    ("ico.ico", include_bytes!("../../../icons/formats/ico.ico")),
    (
        "jpeg.ico",
        include_bytes!("../../../icons/formats/jpeg.ico"),
    ),
    ("jpg.ico", include_bytes!("../../../icons/formats/jpg.ico")),
    ("png.ico", include_bytes!("../../../icons/formats/png.ico")),
    ("rar.ico", include_bytes!("../../../icons/formats/rar.ico")),
    ("svg.ico", include_bytes!("../../../icons/formats/svg.ico")),
    ("tar.ico", include_bytes!("../../../icons/formats/tar.ico")),
    (
        "webp.ico",
        include_bytes!("../../../icons/formats/webp.ico"),
    ),
    ("zip.ico", include_bytes!("../../../icons/formats/zip.ico")),
];

pub fn dump_icons(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let config_dir = crate::config::roaming_dir(app);
    let icon_dir = config_dir.join("icons");
    std::fs::create_dir_all(&icon_dir).map_err(|e| e.to_string())?;

    for (name, bytes) in FORMAT_ICONS {
        let _ = std::fs::write(icon_dir.join(name), bytes);
    }

    Ok(icon_dir)
}

#[tauri::command(async)]
pub async fn register_associations(
    app: tauri::AppHandle,
    extensions: Vec<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            register_associations_impl(app, extensions)
        })
        .await
        .map_err(|err| format!("File Types worker failed: {err}"))??;
        return Ok(());
    }

    #[cfg(not(windows))]
    return Err("File associations are only supported natively on Windows.".into());
}

#[cfg(windows)]
fn register_associations_impl(
    app: tauri::AppHandle,
    extensions: Vec<String>,
) -> Result<(), String> {
    {
        let exe_path = crate::platform::direct_open::release_exe()?;
        let exe_str = exe_path.to_string_lossy().into_owned();
        let icon_dir = dump_icons(&app)?;
        let need_preview = extensions
            .iter()
            .any(|ext| is_archive_ext(&ext.to_lowercase()));
        let host = if need_preview {
            let host_path = crate::platform::previews::resolve_previews_host_path();
            if host_path.exists() {
                Some(host_path)
            } else {
                Some(crate::platform::previews::ensure_previews_host()?)
            }
        } else {
            None
        };

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        for ext in &extensions {
            let lower_ext = ext.to_lowercase();
            let format_info = SUPPORTED_FORMATS.iter().find(|f| f.ext == lower_ext);
            let display_name = format_info.map(|f| f.name).unwrap_or("QuiviT File");
            let icon_name = format_info.map(|f| f.icon).unwrap_or("jpg.ico");

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

            if is_archive_ext(&lower_ext) {
                let host_path = host
                    .as_ref()
                    .ok_or("Preview helper was not staged.".to_string())?;
                crate::platform::previews::register_for_extension_with_host(
                    &lower_ext,
                    host_path,
                )?;
            }

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

        // 7. Register the application itself so it shows up in "Open With"
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
        Ok(())
    }
}

#[tauri::command]
pub fn unregister_associations(extensions: Vec<String>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        for ext in &extensions {
            let lower_ext = ext.to_lowercase();
            let progid = format!("QuiviT.{}", lower_ext);

            if is_archive_ext(&lower_ext) {
                crate::platform::previews::unregister_for_extension(&lower_ext)?;
            }

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
