use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub ext: String,
    pub date: String,
    pub is_dir: bool,
    pub is_hidden: bool,
}

impl FileEntry {
    #[inline(always)]
    pub fn new_file(name: String, path: String, ext: String, date: String, is_hidden: bool) -> Self {
        Self { name, path, ext, date, is_dir: false, is_hidden }
    }

    #[inline(always)]
    pub fn new_directory(name: String, path: String, date: String, is_hidden: bool) -> Self {
        Self { name, path, ext: String::new(), date, is_dir: true, is_hidden }
    }

    #[inline(always)]
    pub fn new_archive_entry(name: String, path: String, ext: String, date: String) -> Self {
        Self { name, path, ext, date, is_dir: false, is_hidden: false }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DirectoryReadResult {
    pub files: Vec<FileEntry>,
    pub initial_index: usize,
    pub target_filename: String,
    pub directory: String,
    pub parent_directory: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchiveEncryptionStatus {
    None,
    PasswordRequired,
    PasswordIncorrect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArchiveReadResult {
    pub files: Vec<FileEntry>,
    pub archive_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encryption: Option<ArchiveEncryptionStatus>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FormatStatus {
    pub ext: String,
    pub name: String,
    pub icon: String,
    pub category: String,
    pub registered: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnimationInfo {
    pub is_animated: bool,
    pub loop_count: u32,
}
