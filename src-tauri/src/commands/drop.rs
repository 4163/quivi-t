use crate::models::DropPayload;
const LIBRARY_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(150);
fn workspace_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if !crate::windows::is_workspace_window(window.label()) {
        return Err("Only workspace windows accept drops".into());
    }
    Ok(())
}
#[tauri::command]
pub fn enable_native_drop(window: tauri::WebviewWindow) -> Result<(), String> {
    workspace_only(&window)?;
    crate::platform::drop::enable()
}
#[tauri::command(async)]
pub fn describe_drop(window: tauri::WebviewWindow, drop_id: String) -> Result<DropPayload, String> {
    workspace_only(&window)?;
    crate::platform::drop::describe(&drop_id)
}
#[tauri::command]
pub fn release_drop(window: tauri::WebviewWindow, drop_id: String) -> Result<(), String> {
    workspace_only(&window)?;
    crate::platform::drop::release(&drop_id);
    Ok(())
}
#[tauri::command(async)]
pub fn save_dropped_image(
    window: tauri::WebviewWindow,
    drop_id: String,
    sanitized_svg: Option<String>,
) -> Result<String, String> {
    workspace_only(&window)?;
    let lease = crate::platform::drop::claim(&drop_id)?;
    let image = crate::image_import::prepare(
        &lease.capture.path,
        lease.capture.dib,
        sanitized_svg.as_deref(),
    )?;
    crate::commands::library::publish_captured_image(&image, &lease.cancelled)
        .or_else(|error| {
            if !error.is_retryable() {
                return Err(error);
            }
            std::thread::sleep(LIBRARY_RETRY_DELAY);
            crate::commands::library::publish_captured_image(&image, &lease.cancelled)
        })
        .map_err(|error| error.to_string())
}
