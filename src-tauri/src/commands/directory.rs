use std::collections::HashMap;

use crate::models::{
    DirectoryMetadataResult, DirectoryReadResult, LibraryProviderEntry,
};

pub use crate::fs::{
    find_directory_metadata_impl, get_drives_impl, read_directory_impl, remove_directory_impl,
    METADATA_FILENAMES,
};
pub use crate::library::tree::{read_gallery_metadata, read_library_nodes};

#[tauri::command(async)]
pub fn read_directory(
    path: String,
    show_hidden: Option<bool>,
    target_name: Option<String>,
) -> Result<DirectoryReadResult, String> {
    crate::fs::read_directory_impl(&path, show_hidden.unwrap_or(false), target_name.as_deref())
}

#[tauri::command(async)]
pub async fn get_drives() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(crate::fs::get_drives_impl)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_path_kind(path: &str) -> String {
    crate::fs::get_path_kind(path)
}

#[tauri::command(async)]
pub fn get_file_sizes(paths: Vec<String>) -> HashMap<String, u64> {
    crate::fs::get_file_sizes(paths)
}

#[tauri::command(async)]
pub async fn read_text_file(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::fs::read_text_file(path))
        .await
        .map_err(|e| format!("Worker failed: {e}"))?
}

#[tauri::command(async)]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::fs::write_text_file(path, content))
        .await
        .map_err(|e| format!("Worker failed: {e}"))?
}

#[tauri::command(async)]
pub fn create_placeholder_files(dir: String, filenames: Vec<String>) -> Result<(), String> {
    crate::fs::create_placeholder_files(dir, filenames)
}

#[tauri::command(async)]
pub async fn remove_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::fs::remove_file(path))
        .await
        .map_err(|e| format!("Worker failed: {e}"))?
}

#[tauri::command(async)]
pub async fn remove_directory(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::fs::remove_directory_impl(path))
        .await
        .map_err(|err| format!("Library removal worker failed: {err}"))?
}

#[tauri::command(async)]
pub fn find_directory_metadata(dir_path: String) -> Result<Option<DirectoryMetadataResult>, String> {
    crate::fs::find_directory_metadata_impl(dir_path)
}

#[tauri::command(async)]
pub fn read_library_tree() -> Result<Vec<LibraryProviderEntry>, String> {
    crate::library::tree::read_library_tree_impl()
}
