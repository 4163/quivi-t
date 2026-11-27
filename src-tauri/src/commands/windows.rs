#[tauri::command]
pub fn update_theme(app: tauri::AppHandle, theme: Option<String>) {
    crate::windows::update_theme(&app, theme.as_deref());
}

#[tauri::command]
pub async fn open_workspace_window(app: tauri::AppHandle, surface: String) -> Result<(), String> {
    crate::windows::open_workspace_window(&app, &surface)
}

#[tauri::command]
pub async fn close_workspace_window(app: tauri::AppHandle, surface: String) -> Result<(), String> {
    crate::windows::close_workspace_window(&app, &surface)
}

#[tauri::command]
pub fn set_workspace_title(app: tauri::AppHandle, title: String) -> Result<(), String> {
    crate::windows::set_workspace_title(&app, &title)
}

#[tauri::command]
pub async fn open_options(app: tauri::AppHandle) -> Result<(), String> {
    crate::windows::open_options(&app)
}

#[tauri::command]
pub async fn open_metadata_window(app: tauri::AppHandle) -> Result<(), String> {
    crate::windows::open_metadata_window(&app)
}

#[tauri::command]
pub async fn fit_options_window(app: tauri::AppHandle, width: f64) -> Result<(), String> {
    crate::windows::fit_options_window(&app, width)
}

#[tauri::command]
pub async fn fit_metadata_window(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    crate::windows::fit_metadata_window(&app, height)
}

#[tauri::command]
pub fn show_window(window: tauri::Window) {
    crate::windows::show_window(&window);
}

#[tauri::command]
pub async fn hide_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    crate::windows::hide_to_tray(&app)
}
