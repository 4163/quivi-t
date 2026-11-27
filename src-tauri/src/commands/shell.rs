#[tauri::command]
pub fn open_in_explorer(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if path.starts_with("ms-settings:") {
            crate::platform::shell::open_uri(path)?;
        } else {
            std::process::Command::new("explorer")
                .arg(path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_default_dir() -> String {
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return format!("{}\\Pictures", profile);
        }
    }
    String::new()
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

#[tauri::command]
pub fn get_library_dir() -> Result<String, String> {
    let dir = crate::config::configured_library_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create library directory: {e}"))?;
    Ok(crate::config::display_path(&dir))
}

#[tauri::command]
pub fn get_default_library_dir() -> Result<String, String> {
    Ok(crate::config::display_path(
        &crate::config::default_library_dir()?,
    ))
}
