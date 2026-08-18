pub mod archives;
pub mod commands;
pub mod config;
pub mod formats;
pub mod ico;
pub mod models;
pub mod platform;
pub mod utils;
pub mod windows;

use std::fs;
use std::sync::Mutex;
use tauri::http::Response;
use tauri::{Emitter, Manager};

use archives::*;
use commands::*;
use config::*;
use ico::*;
use windows::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = crate::config::load_config_early();
    // Single instance defaults to true if not explicitly set to false
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
            // The 'main' window is built here in Rust (not declared in
            // tauri.conf.json) so all windows share a single construction path
            // in config.rs and the shell background is applied before first paint.
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

    builder
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
        ])
        .register_asynchronous_uri_scheme_protocol("quivit", |ctx, request, responder| {
            // Protocol: quivit://archive/<archive_path_base64>/<entry_name>
            let url = request.uri().to_string();

            // URL could be http://quivit.localhost/archive/... or quivit://localhost/archive/...
            let parts: Vec<&str> = url.splitn(2, "/archive/").collect();

            if parts.len() < 2 {
                let response = Response::builder()
                    .status(400)
                    .body(format!("Invalid quivit URL: {}", url).into_bytes())
                    .unwrap();
                responder.respond(response);
                return;
            }

            let path_parts: Vec<&str> = parts[1].splitn(2, '/').collect();
            if path_parts.len() < 2 {
                let response = Response::builder()
                    .status(400)
                    .body(b"Missing archive path or entry name".to_vec())
                    .unwrap();
                responder.respond(response);
                return;
            }

            let archive_path = match crate::utils::base64_decode(path_parts[0]) {
                Some(p) => p,
                None => {
                    let response = Response::builder()
                        .status(400)
                        .body(b"Invalid base64 archive path".to_vec())
                        .unwrap();
                    responder.respond(response);
                    return;
                }
            };

            // URL-decode the entry name (handles %20, etc.)
            let entry_name = crate::utils::url_decode(path_parts[1]);

            let app_handle = ctx.app_handle().clone();

            std::thread::spawn(move || {
                let mut data = None;
                let ext = archive_path.rsplit('.').next().unwrap_or("").to_lowercase();

                {
                    let state = app_handle.state::<Mutex<ArchiveCache>>();
                    let mut cache = state.lock().unwrap();

                    if ext == "zip" || ext == "cbz" {
                        data = cache.get_zip_entry(&archive_path, &entry_name);
                    } else if ext == "rar"
                        || ext == "cbr"
                        || ext == "7z"
                        || ext == "cb7"
                        || ext == "cbt"
                        || ext == "tar"
                    {
                        if let Some(single) = cache.archives.get(&archive_path) {
                            if let Some(temp_dir) = &single.extract_temp_dir {
                                if let Some(file_path) =
                                    crate::archives::archive_entry_temp_path(temp_dir, &entry_name)
                                {
                                    if let Ok(bytes) = fs::read(&file_path) {
                                        data = Some(bytes);
                                    }
                                }
                            }
                        }
                    }
                }

                if data.is_none() {
                    if ext == "zip" || ext == "cbz" {
                        let extracted = {
                            let state = app_handle.state::<Mutex<ArchiveCache>>();
                            let mut cache = state.lock().unwrap();
                            if let Some(single) = cache.archives.get_mut(&archive_path) {
                                if let Some(archive) = single.zip_archive.as_mut() {
                                    // Try direct lookup first (UTF-8 ZIPs) and fallback scan if needed
                                    crate::archives::read_zip_entry_by_decoded_name(
                                        archive,
                                        &entry_name,
                                    )
                                    .ok()
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        };

                        let d = if let Some(d) = extracted {
                            d
                        } else {
                            extract_zip_entry(&archive_path, &entry_name).unwrap_or_default()
                        };

                        if !d.is_empty() {
                            data = Some(d.clone());
                            let state = app_handle.state::<Mutex<ArchiveCache>>();
                            let mut cache = state.lock().unwrap();
                            cache.insert_zip_entry(&archive_path, &entry_name, d);
                        }
                    } else if ext == "rar"
                        || ext == "cbr"
                        || ext == "7z"
                        || ext == "cb7"
                        || ext == "cbt"
                        || ext == "tar"
                    {
                        let (temp_dir_opt, notify_opt) = {
                            let state = app_handle.state::<Mutex<ArchiveCache>>();
                            let cache = state.lock().unwrap();
                            if let Some(single) = cache.archives.get(&archive_path) {
                                (
                                    single.extract_temp_dir.clone(),
                                    Some(single.extract_notify.clone()),
                                )
                            } else {
                                (None, None)
                            }
                        };
                        if let Some(temp_dir) = temp_dir_opt {
                            if let Some(file_path) =
                                crate::archives::archive_entry_temp_path(&temp_dir, &entry_name)
                            {
                                if let Ok(bytes) = fs::read(&file_path) {
                                    data = Some(bytes);
                                } else if let Some(notify) = notify_opt {
                                    let (lock, cvar) = &*notify;
                                    let set = lock.lock().unwrap();
                                    let timeout = std::time::Duration::from_secs(30);
                                    let _ = cvar
                                        .wait_timeout_while(set, timeout, |pending| {
                                            !pending.contains(&entry_name)
                                        })
                                        .unwrap();

                                    if let Ok(bytes) = fs::read(&file_path) {
                                        data = Some(bytes);
                                    }
                                }
                            }
                        }
                    }
                }

                if let Some(d) = data {
                    let mime = guess_mime(&entry_name);
                    let response = Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Content-Length", d.len().to_string())
                        .header("Access-Control-Allow-Origin", "*")
                        .body(d)
                        .unwrap();
                    responder.respond(response);
                } else {
                    let response = Response::builder()
                        .status(404)
                        .body(b"Entry not found or failed to extract".to_vec())
                        .unwrap();
                    responder.respond(response);
                }
            });
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Architectural Standard: The 'main' window acts as the primary process lifecycle controller.
                // If the user closes the main viewer window, all secondary/child windows (Options, Metadata, etc.)
                // MUST be explicitly closed here to ensure the Tauri app exits cleanly rather than leaving orphans running.
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

// ── Utility functions ────────────────────────────────────────────────────────


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

fn guess_mime(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "apng" => "image/apng",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
#[path = "tests/archive_tests.rs"]
mod archive_tests;

#[cfg(test)]
#[path = "tests/format_tests.rs"]
mod format_tests;
