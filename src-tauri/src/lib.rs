pub mod archives;
pub mod commands;
pub mod config;
pub mod formats;
pub mod ico;
pub mod image_import;
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
    eprintln!(
        "[QuiviT] config: {}",
        crate::config::describe_config_source()
    );

    let mut builder = tauri::Builder::default();

    if single_instance {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.unminimize();
                windows::restore_from_tray(app);
                let path_arg = argv
                    .iter()
                    .skip(1)
                    .filter(|arg| !arg.starts_with('-'))
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("|");
                if !path_arg.is_empty() {
                    let _ = main_window.emit("single-instance-open", path_arg);
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
            let main_builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("QuiviT")
            .inner_size(MAIN_INITIAL_W, MAIN_INITIAL_H)
            .min_inner_size(MAIN_MIN_W, MAIN_MIN_H)
            .visible(false)
            .devtools(true)
            .general_autofill_enabled(false);
            #[cfg(windows)]
            let main_builder = main_builder.disable_drag_drop_handler();
            let main_window = main_builder.build().expect("failed to build main window");

            #[cfg(windows)]
            platform::drop::install(&main_window).map_err(std::io::Error::other)?;
            #[cfg(windows)]
            std::thread::spawn(|| {
                let _ = commands::library::cleanup_abandoned_captures();
            });

            windows::apply_shell_background(&main_window, &config);
            platform::icons::warmup();
            crate::commands::registry::spawn_launch_previews_sync(app.handle().clone());
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
        get_active_config_info,
        open_active_config_dir,
        open_config_dir,
        get_local_data_dir,
        open_local_data_dir,
        save_config,
        open_options,
        open_workspace_window,
        close_workspace_window,
        set_workspace_title,
        fit_options_window,
        open_metadata_window,
        fit_metadata_window,
        get_drives,
        watch_directory,
        open_in_explorer,
        get_path_kind,
        get_file_sizes,
        read_text_file,
        write_text_file,
        get_default_dir,
        get_ico_frames,
        get_archive_ico_frames,
        get_native_icon,
        invalidate_native_icon_cache,
        get_format_status,
        get_preview_diagnostics,
        sync_preview_associations,
        apply_associations,
        register_associations,
        unregister_associations,
        get_initial_args,
        show_window,
        hide_to_tray,
        show_from_tray,
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
        cancel_download,
        verify_image_magic,
        scan_container_max_width,
        cancel_width_scan,
        #[cfg(windows)]
        enable_native_drop,
        #[cfg(windows)]
        describe_drop,
        #[cfg(windows)]
        release_drop,
        #[cfg(windows)]
        save_dropped_image
    ]);

    crate::protocol::register_quivit_protocol(builder)
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                windows::close_secondary_windows(window.app_handle());
            }
            #[cfg(windows)]
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                platform::drop::shutdown();
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
