// Prevents an extra console window on Windows release builds. Do not remove.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // New flag is `--previews-pane`. The old `--preview-handler` still serves
    // so machines registered before the rename keep working until repair.
    if args
        .iter()
        .any(|arg| arg == "--previews-pane" || arg == "--preview-handler")
    {
        tauri_app_lib::platform::previews::log_event(&format!(
            "process start args={args:?} exe={}",
            std::env::current_exe()
                .map(|path| path.display().to_string())
                .unwrap_or_default()
        ));
        if let Err(error) = tauri_app_lib::platform::previews::run_server() {
            tauri_app_lib::platform::previews::log_event(&format!("server error: {error}"));
            eprintln!("[QuiviT preview] {error}");
        }
        return;
    }

    tauri_app_lib::run()
}
