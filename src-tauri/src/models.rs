use serde::Serialize;

// ── Data structures ──────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub ext: String,
    pub date: String,
    pub is_dir: bool,
    pub is_hidden: bool,
}

#[derive(Serialize)]
pub struct DirectoryReadResult {
    pub files: Vec<FileEntry>,
    pub initial_index: usize,
    pub directory: String,
    pub parent_directory: Option<String>,
}

#[derive(Serialize)]
pub struct ArchiveReadResult {
    pub files: Vec<FileEntry>,
    pub archive_path: String,
}
