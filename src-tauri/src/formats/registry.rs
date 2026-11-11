use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FormatCategory {
    Image,
    Archive,
}

impl FormatCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            FormatCategory::Image => "Image",
            FormatCategory::Archive => "Archive",
        }
    }
}

impl std::fmt::Display for FormatCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct FileFormat {
    pub ext: &'static str,
    pub name: &'static str,
    pub icon: &'static str,
    pub category: FormatCategory,
}

pub const SUPPORTED_FORMATS: &[FileFormat] = &[
    // Images
    FileFormat {
        ext: "jpg",
        name: "JPEG Image",
        icon: "jpg.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "jpeg",
        name: "JPEG Image",
        icon: "jpeg.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "png",
        name: "PNG Image",
        icon: "png.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "gif",
        name: "GIF Image",
        icon: "gif.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "webp",
        name: "WebP Image",
        icon: "webp.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "apng",
        name: "APNG Image",
        icon: "apng.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "svg",
        name: "SVG Image",
        icon: "svg.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "bmp",
        name: "BMP Image",
        icon: "bmp.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "dib",
        name: "BMP Image",
        icon: "dib.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "ico",
        name: "Icon Image",
        icon: "ico.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "avif",
        name: "AVIF Image",
        icon: "avif.ico",
        category: FormatCategory::Image,
    },
    // Archives
    FileFormat {
        ext: "zip",
        name: "ZIP Archive",
        icon: "zip.ico",
        category: FormatCategory::Archive,
    },
    FileFormat {
        ext: "cbz",
        name: "Comic Book ZIP",
        icon: "cbz.ico",
        category: FormatCategory::Archive,
    },
    FileFormat {
        ext: "rar",
        name: "RAR Archive",
        icon: "rar.ico",
        category: FormatCategory::Archive,
    },
    FileFormat {
        ext: "cbr",
        name: "Comic Book RAR",
        icon: "cbr.ico",
        category: FormatCategory::Archive,
    },
    FileFormat {
        ext: "7z",
        name: "7z Archive",
        icon: "7z.ico",
        category: FormatCategory::Archive,
    },
    FileFormat {
        ext: "cb7",
        name: "Comic Book 7z",
        icon: "cb7.ico",
        category: FormatCategory::Archive,
    },
    FileFormat {
        ext: "cbt",
        name: "Comic Book TAR",
        icon: "cbt.ico",
        category: FormatCategory::Archive,
    },
    FileFormat {
        ext: "tar",
        name: "TAR Archive",
        icon: "tar.ico",
        category: FormatCategory::Archive,
    },
];

#[inline]
pub fn is_image_ext(ext: &str) -> bool {
    SUPPORTED_FORMATS
        .iter()
        .any(|f| f.category == FormatCategory::Image && f.ext.eq_ignore_ascii_case(ext))
}

#[inline]
pub fn is_archive_ext(ext: &str) -> bool {
    SUPPORTED_FORMATS
        .iter()
        .any(|f| f.category == FormatCategory::Archive && f.ext.eq_ignore_ascii_case(ext))
}

#[inline]
pub fn is_metadata_ext(ext: &str) -> bool {
    ext.eq_ignore_ascii_case("xml") || ext.eq_ignore_ascii_case("opf")
}

pub const ARCHIVE_EXTENSIONS: &[&str] = &["zip", "cbz", "rar", "cbr", "7z", "cb7", "tar", "cbt"];

pub const ARCHIVE_SLASH_EXTS: &[&str] = &[
    ".zip\\", ".cbz\\", ".rar\\", ".cbr\\", ".7z\\", ".cb7\\", ".tar\\", ".cbt\\",
    ".zip/", ".cbz/", ".rar/", ".cbr/", ".7z/", ".cb7/", ".tar/", ".cbt/",
];

pub const ARCHIVE_DOT_EXTS: &[&str] = &[
    ".zip", ".cbz", ".rar", ".cbr", ".7z", ".cb7", ".tar", ".cbt",
];

#[inline]
pub fn is_shell_thumb_supported(ext: &str) -> bool {
    is_image_ext(ext) || ext.eq_ignore_ascii_case("mp4")
}

pub fn guess_mime(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("");
    if ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg") {
        "image/jpeg"
    } else if ext.eq_ignore_ascii_case("png") {
        "image/png"
    } else if ext.eq_ignore_ascii_case("gif") {
        "image/gif"
    } else if ext.eq_ignore_ascii_case("webp") {
        "image/webp"
    } else if ext.eq_ignore_ascii_case("svg") {
        "image/svg+xml"
    } else if ext.eq_ignore_ascii_case("bmp") || ext.eq_ignore_ascii_case("dib") {
        "image/bmp"
    } else if ext.eq_ignore_ascii_case("ico") {
        "image/x-icon"
    } else if ext.eq_ignore_ascii_case("avif") {
        "image/avif"
    } else if ext.eq_ignore_ascii_case("apng") {
        "image/apng"
    } else if ext.eq_ignore_ascii_case("mp4") {
        "video/mp4"
    } else {
        "application/octet-stream"
    }
}

pub fn check_image_magic_head(head: &[u8], expected_ext: &str) -> bool {
    let ext = expected_ext.trim_start_matches('.').to_ascii_lowercase();
    let enough = |n: usize| head.len() >= n;
    match ext.as_str() {
        "png" | "apng" => enough(8) && head[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
        "jpg" | "jpeg" => enough(2) && head[..2] == [0xFF, 0xD8],
        "gif" => enough(6) && (head[..6] == *b"GIF87a" || head[..6] == *b"GIF89a"),
        "bmp" | "dib" => enough(2) && head[..2] == *b"BM",
        "webp" => enough(12) && head[..4] == *b"RIFF" && head[8..12] == *b"WEBP",
        "avif" => enough(12) && head[4..8] == *b"ftyp",
        _ => true,
    }
}
