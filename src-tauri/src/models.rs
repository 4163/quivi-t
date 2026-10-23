use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub ext: String,
    pub date: String,
    pub is_dir: bool,
    pub is_hidden: bool,
    #[serde(default)]
    pub size: u64,
}

impl FileEntry {
    #[inline(always)]
    pub fn new_file(
        name: String,
        path: String,
        ext: String,
        date: String,
        is_hidden: bool,
        size: u64,
    ) -> Self {
        Self {
            name,
            path,
            ext,
            date,
            is_dir: false,
            is_hidden,
            size,
        }
    }

    #[inline(always)]
    pub fn new_directory(name: String, path: String, date: String, is_hidden: bool) -> Self {
        Self {
            name,
            path,
            ext: String::new(),
            date,
            is_dir: true,
            is_hidden,
            size: 0,
        }
    }

    #[inline(always)]
    pub fn new_archive_entry(
        name: String,
        path: String,
        ext: String,
        date: String,
        size: u64,
    ) -> Self {
        Self {
            name,
            path,
            ext,
            date,
            is_dir: false,
            is_hidden: false,
            size,
        }
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DirectoryMetadataResult {
    pub meta_path: String,
    pub content: String,
    pub dir_path: String,
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
pub struct PreviewDiagnostic {
    pub ext: String,
    pub registered: bool,
    pub classes_default: Option<String>,
    pub userchoice_progid: Option<String>,
    pub progid_preview_clsid: Option<String>,
    pub clsid_server: Option<String>,
    pub hklm_clsid_server: Option<String>,
    pub in_preview_handlers_list: bool,
    #[serde(default)]
    pub host_path: String,
    #[serde(default)]
    pub host_exists: bool,
    #[serde(default)]
    pub staged_preview_version: Option<u32>,
    #[serde(default)]
    pub embedded_preview_version: u32,
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub progid_thumbnail_clsid: Option<String>,
    #[serde(default)]
    pub thumbnail_server: Option<String>,
    #[serde(default)]
    pub thumbnail_proxy_server: Option<String>,
    #[serde(default)]
    pub thumbnail_proxy_path: String,
    #[serde(default)]
    pub thumbnail_proxy_exists: bool,
    #[serde(default)]
    pub thumbnail_proxy_healthy: bool,
    #[serde(default)]
    pub external_preview_handler: Option<String>,
    #[serde(default)]
    pub external_thumbnail_provider: Option<String>,
    #[serde(default)]
    pub svg_skipped: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnimationInfo {
    pub is_animated: bool,
    pub loop_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TempArchiveOrigin {
    pub archive_path: String,
    pub entry_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IcoSize {
    pub width: u32,
    pub height: u32,
    pub data_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LibraryNode {
    pub name: String,
    pub path: String,
    pub title: Option<String>,
    pub date: String,
    pub created_millis: u64,
    pub is_dir: bool,
    pub is_gallery: bool,
    #[serde(default)]
    pub size: u64,
    pub image_count: usize,
    pub children: Vec<LibraryNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LibraryProviderEntry {
    pub name: String,
    pub path: String,
    pub nodes: Vec<LibraryNode>,
}

/// Effective settings folder and how it is laid out. Shown in Options so the
/// readout always names the folder this run actually uses.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActiveConfigInfo {
    pub dir: String,
    pub mode: String,
}
