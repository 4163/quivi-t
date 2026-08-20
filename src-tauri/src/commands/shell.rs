#[tauri::command]
pub fn open_in_explorer(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if path.starts_with("ms-settings:") {
            open_uri(path)?;
        } else {
            std::process::Command::new("explorer")
                .arg(path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_uri(uri: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide_null(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let operation = wide_null("open");
    let target = wide_null(uri);
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(operation.as_ptr()),
            PCWSTR(target.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };

    if result.0 as isize <= 32 {
        return Err(format!("Failed to open URI: {}", uri));
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
