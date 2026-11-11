use std::fs;
use std::path::Path;

use crate::models::DirectoryMetadataResult;

pub const METADATA_FILENAMES: [&str; 6] = [
    "comicinfo.xml",
    "comicinfo.json",
    "meta.json",
    "comet.xml",
    "comet.json",
    "metadata.opf",
];

pub fn find_directory_metadata_impl(
    dir_path: impl AsRef<Path>,
) -> Result<Option<DirectoryMetadataResult>, String> {
    let input_path = dir_path.as_ref();
    if !input_path.exists() {
        return Ok(None);
    }

    let dir = if input_path.is_file() {
        input_path.parent().unwrap_or(Path::new(""))
    } else {
        input_path
    };

    if !crate::library::is_within_library(dir) {
        return Ok(None);
    }

    if let Ok(entries) = fs::read_dir(dir) {
        let entries_vec: Vec<_> = entries.flatten().collect();
        for target in &METADATA_FILENAMES {
            if let Some(entry) = entries_vec.iter().find(|e| {
                e.file_name()
                    .to_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case(target))
            }) {
                let meta_path = entry.path();
                if let Ok(content) = fs::read_to_string(&meta_path) {
                    return Ok(Some(DirectoryMetadataResult {
                        meta_path: meta_path.to_string_lossy().into_owned(),
                        content,
                        dir_path: dir.to_string_lossy().into_owned(),
                    }));
                }
            }
        }
    }

    Ok(None)
}
