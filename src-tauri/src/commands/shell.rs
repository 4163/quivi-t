#[tauri::command]
pub fn open_in_explorer(path: &str) -> Result<(), String> {
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
