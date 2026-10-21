// Prevents an extra console window on Windows release builds. Do not remove.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--previews-thumb") {
        if let Err(error) = tauri_app_lib::platform::previews::run_thumbnail_server() {
            tauri_app_lib::platform::previews::log_event(&format!("thumbnail server error: {error}"));
            eprintln!("[QuiviT thumbnail] {error}");
        }
        return;
    }

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

    #[cfg(all(windows, debug_assertions))]
    if tauri_app_lib::config::override_config_dir().is_none() {
        if let Some(root) = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            std::env::set_var("QUIVIT_CONFIG_DIR", root.join(".dev-config"));
        }
    }

    #[cfg(windows)]
    {
        tauri_app_lib::platform::direct_open::record_current_exe();
        let args_os: Vec<std::ffi::OsString> = std::env::args_os().collect();
        match tauri_app_lib::platform::direct_open::forward_file_open(&args_os) {
            Ok(true) => return,
            Err(error) => {
                use windows::core::HSTRING;
                use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
                let message = HSTRING::from(error);
                let caption = HSTRING::from("QuiviT");
                unsafe {
                    MessageBoxW(None, &message, &caption, MB_OK | MB_ICONERROR);
                }
                return;
            }
            Ok(false) => {}
        }
    }

    tauri_app_lib::run()
}
