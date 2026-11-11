pub mod animation;
pub mod archives;
pub mod config;
pub mod directory;
#[cfg(windows)]
pub mod drop;
pub mod library;
pub mod network;
pub mod registry;
pub mod shell;
pub mod watchers;

pub use animation::{
    cancel_dims_scan, cancel_width_scan, check_is_animated, check_media_audio,
    probe_media_dimensions, scan_container_dimensions, scan_container_max_width,
};
pub use archives::{
    drop_all_archives_cache, drop_archive_cache, get_archive_ico_frames, get_ico_frames,
    list_archive, prefetch_archive_entries, resolve_archive_temp_origin,
};
pub use config::{
    get_active_config_info, get_config_dir, get_local_data_dir, load_config,
    open_active_config_dir, open_config_dir, open_local_data_dir, save_config,
};
pub use directory::{
    create_placeholder_files, find_directory_metadata, get_drives, get_file_sizes,
    get_path_kind, read_directory, read_library_tree, read_text_file, remove_directory,
    remove_file, write_text_file,
};
#[cfg(windows)]
pub use drop::{describe_drop, enable_native_drop, release_drop, save_dropped_image};
pub use library::{
    get_default_library_dir, get_library_dir, library_move_in_progress, move_library,
};
pub use network::{
    cancel_download, download_to_file, fetch_bytes, fetch_extractor_text, fetch_text,
    verify_image_magic, DownloadCancelFlag,
};
pub use registry::{
    apply_associations, get_format_status, get_native_icon, get_preview_diagnostics,
    invalidate_native_icon_cache, register_associations, sync_preview_associations,
    unregister_associations,
};
pub use shell::{get_default_dir, get_initial_args, open_in_explorer, pick_folder};
pub use watchers::{
    rebind_library_watcher, record_config_self_write, watch_directory, WatcherState,
};
