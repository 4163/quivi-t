pub mod archives;
pub mod commands;
pub mod config;
pub mod formats;
pub mod ico;
pub mod models;
pub mod platform;
pub mod protocol;
pub mod utils;
pub mod windows;

use std::sync::Mutex;
use tauri::{Emitter, Manager};

use archives::*;
use commands::*;
use config::*;
use ico::*;
use windows::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = crate::config::load_config_early();
    // Single instance defaults to true unless config opts out.
    let single_instance = config
        .frontend_data
        .get("single_instance")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let cache_mb = config.archive_cache_mb.unwrap_or(512);

    let mut builder = tauri::Builder::default();

    if single_instance {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.show();
                let _ = main_window.set_focus();
                if argv.len() > 1 {
                    let path = argv[1].clone();
                    let _ = main_window.emit("single-instance-open", path);
                }
            }
        }));
    }

    builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            // Build the main window in Rust, not tauri.conf.json. That keeps
            // window setup in one path and applies the shell background before
            // first paint.
            let main_window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("QuiviT")
            .inner_size(MAIN_INITIAL_W, MAIN_INITIAL_H)
            .min_inner_size(MAIN_MIN_W, MAIN_MIN_H)
            .visible(false)
            .devtools(true)
            .build()
            .expect("failed to build main window");

            windows::apply_shell_background(&main_window, &config);

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                use notify::{EventKind, RecursiveMode, Watcher};
                use std::time::Duration;

                let config_path = crate::config::get_config_path();
                if let Some(parent) = config_path.parent() {
                    let (tx, rx) = std::sync::mpsc::channel();
                    let mut watcher = notify::recommended_watcher(tx).unwrap();
                    let _ = watcher.watch(parent, RecursiveMode::NonRecursive);

                    let mut last_emit = std::time::Instant::now();

                    for res in rx {
                        match res {
                            Ok(event) => {
                                if let EventKind::Modify(_) = event.kind {
                                    if event
                                        .paths
                                        .iter()
                                        .any(|p| p.file_name() == config_path.file_name())
                                    {
                                        if last_emit.elapsed() > Duration::from_millis(500) {
                                            last_emit = std::time::Instant::now();
                                            let _ = app_handle.emit("config-changed", ());
                                        }
                                    }
                                }
                            }
                            Err(_) => {}
                        }
                    }
                }
            });
            Ok(())
        });

    builder = builder
        .manage(Mutex::new(ArchiveCache::new(cache_mb)))
        .manage(Mutex::new(WatcherState::new()))
        .invoke_handler(tauri::generate_handler![
            read_directory,
            list_archive,
            prefetch_archive_entries,
            open_parent,
            open_sibling,
            open_sibling_container,
            load_config,
            get_config_dir,
            open_config_dir,
            get_local_data_dir,
            open_local_data_dir,
            save_config,
            open_options,
            fit_options_window,
            open_metadata_window,
            fit_metadata_window,
            get_drives,
            watch_directory,
            open_in_explorer,
            get_path_kind,
            read_text_file,
            write_text_file,
            get_default_dir,
            get_ico_frames,
            get_archive_ico_frames,
            get_native_icon,
            get_format_status,
            register_associations,
            unregister_associations,
            get_initial_args,
            show_window,
            pick_folder
        ]);

    crate::protocol::register_quivit_protocol(builder)
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // The main viewer owns the app lifetime. Closing it also closes
                // secondary windows so Tauri exits cleanly.
                if window.label() == "main" {
                    if let Some(options_window) = window.app_handle().get_webview_window("options")
                    {
                        let _ = options_window.close();
                    }
                    if let Some(metadata_window) =
                        window.app_handle().get_webview_window("metadata")
                    {
                        let _ = metadata_window.close();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                crate::config::apply_pending_config_to_disk();
            }
        });
}

#[tauri::command]
fn open_in_explorer(path: &str) -> Result<(), String> {
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
fn get_default_dir() -> String {
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return format!("{}\\Pictures", profile);
        }
    }
    String::new()
}



#[cfg(test)]
#[path = "tests/archive_tests.rs"]
mod archive_tests;

#[cfg(test)]
#[path = "tests/format_tests.rs"]
mod format_tests;
