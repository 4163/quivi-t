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

use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, RwLock};
use tauri::{Emitter, Manager};

use archives::*;
use commands::*;
use config::*;
use windows::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = crate::config::load_config_early();
    // Single instance defaults to true unless config opts out. Forced true under E2E suite.
    let single_instance = if crate::config::is_e2e_suite() {
        true
    } else {
        config
            .frontend_data
            .get("single_instance")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    };
    let cache_mb = config.archive_cache_mb.unwrap_or(128);

    let mut builder = tauri::Builder::default();

    if single_instance {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.show();
                let _ = main_window.set_focus();
                let path_arg = argv.iter().skip(1).find(|arg| !arg.starts_with('-'));
                if let Some(path) = path_arg {
                    let _ = main_window.emit("single-instance-open", path.clone());
                }
            }
        }));
    }

    builder = builder
        .manage(RwLock::new(ArchiveCache::new(cache_mb)))
        .manage(Mutex::new(WatcherState::new()))
        .manage(network::DownloadCancelFlag(Arc::new(AtomicU64::new(0))))
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
            platform::icons::warmup();
            crate::commands::watchers::spawn_config_file_watcher(app.handle().clone());
            crate::commands::watchers::spawn_library_watcher(app.handle().clone());
            crate::archives::cache::acquire_temp_lock();
            crate::archives::cache::cleanup_orphaned_temp_dirs();

            Ok(())
        });

    builder = builder.invoke_handler(tauri::generate_handler![
        read_directory,
        find_directory_metadata,
        list_archive,
        drop_archive_cache,
        drop_all_archives_cache,
        prefetch_archive_entries,
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
        update_theme,
        pick_folder,
        check_is_animated,
        check_media_audio,
        resolve_archive_temp_origin,
        fetch_text,
        fetch_extractor_text,
        fetch_bytes,
        download_to_file,
        get_library_dir,
        get_default_library_dir,
        move_library,
        library_move_in_progress,
        rebind_library_watcher,
        create_placeholder_files,
        remove_file,
        remove_directory,
        read_library_tree,
        cancel_download
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
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                crate::config::apply_pending_config_to_disk();
                if let Some(cache) = app_handle.try_state::<std::sync::RwLock<ArchiveCache>>() {
                    if let Ok(mut guard) = cache.write() {
                        guard.drop_all_archives();
                    }
                }
                crate::archives::cache::cleanup_current_temp_dir();
            }
        });
}

#[cfg(test)]
#[path = "tests/archive_tests.rs"]
mod archive_tests;

#[cfg(test)]
#[path = "tests/format_tests.rs"]
mod format_tests;

#[cfg(test)]
#[path = "tests/temp_archive_tests.rs"]
mod temp_archive_tests;
