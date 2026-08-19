use crate::formats::*;
use crate::models::FormatStatus;

#[cfg(windows)]
use winreg::{enums::*, RegKey};

#[tauri::command]
pub fn get_native_icon(ext: String) -> Result<Option<String>, String> {
    crate::platform::icons::get_cached_native_icon(&ext)
}

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

            // Check UserChoice first. This is the actual default handler on Win10/11.
            // UserChoice is hash-protected and can only be set by the user through
            // Windows Settings, but we can read it to know if QuiviT is the active default.
            let userchoice_path = format!(
                r#"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.{}\UserChoice"#,
                fmt.ext.to_lowercase()
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

const ICON_APNG: &[u8] = include_bytes!("../../../icons/apng.ico");
const ICON_CBR: &[u8] = include_bytes!("../../../icons/cbr.ico");
const ICON_CBZ: &[u8] = include_bytes!("../../../icons/cbz.ico");
const ICON_GIF: &[u8] = include_bytes!("../../../icons/gif.ico");
const ICON_SVG: &[u8] = include_bytes!("../../../icons/svg.ico");
const ICON_WEBP: &[u8] = include_bytes!("../../../icons/webp.ico");
const ICON_MOE: &[u8] = include_bytes!("../../../icons/quivi-t_moe-icon.ico");

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
