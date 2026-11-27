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
        ext: "jfif",
        name: "JFIF Image",
        icon: "jfif.ico",
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
        ext: "avif",
        name: "AVIF Image",
        icon: "avif.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "ico",
        name: "Icon Image",
        icon: "ico.ico",
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
        name: "DIB Image",
        icon: "dib.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "tif",
        name: "TIFF Image",
        icon: "tif.ico",
        category: FormatCategory::Image,
    },
    FileFormat {
        ext: "tiff",
        name: "TIFF Image",
        icon: "tiff.ico",
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

pub(crate) const FORMAT_ICONS: &[(&str, &[u8])] = &[
    ("7z.ico", include_bytes!("../../../icons/formats/7z.ico")),
    (
        "apng.ico",
        include_bytes!("../../../icons/formats/apng.ico"),
    ),
    (
        "avif.ico",
        include_bytes!("../../../icons/formats/avif.ico"),
    ),
    ("bmp.ico", include_bytes!("../../../icons/formats/bmp.ico")),
    ("cb7.ico", include_bytes!("../../../icons/formats/cb7.ico")),
    ("cbr.ico", include_bytes!("../../../icons/formats/cbr.ico")),
    ("cbt.ico", include_bytes!("../../../icons/formats/cbt.ico")),
    ("cbz.ico", include_bytes!("../../../icons/formats/cbz.ico")),
    ("dib.ico", include_bytes!("../../../icons/formats/dib.ico")),
    ("gif.ico", include_bytes!("../../../icons/formats/gif.ico")),
    ("ico.ico", include_bytes!("../../../icons/formats/ico.ico")),
    (
        "jfif.ico",
        include_bytes!("../../../icons/formats/jfif.ico"),
    ),
    (
        "jpeg.ico",
        include_bytes!("../../../icons/formats/jpeg.ico"),
    ),
    ("jpg.ico", include_bytes!("../../../icons/formats/jpg.ico")),
    ("png.ico", include_bytes!("../../../icons/formats/png.ico")),
    ("rar.ico", include_bytes!("../../../icons/formats/rar.ico")),
    ("svg.ico", include_bytes!("../../../icons/formats/svg.ico")),
    ("tar.ico", include_bytes!("../../../icons/formats/tar.ico")),
    ("tif.ico", include_bytes!("../../../icons/formats/tif.ico")),
    (
        "tiff.ico",
        include_bytes!("../../../icons/formats/tiff.ico"),
    ),
    (
        "webp.ico",
        include_bytes!("../../../icons/formats/webp.ico"),
    ),
    ("zip.ico", include_bytes!("../../../icons/formats/zip.ico")),
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

#[inline]
pub fn is_tiff_ext(ext: &str) -> bool {
    ext.eq_ignore_ascii_case("tif") || ext.eq_ignore_ascii_case("tiff")
}

#[inline]
pub fn is_tiff_name(name: &str) -> bool {
    name.rsplit('.').next().is_some_and(is_tiff_ext)
}

pub fn guess_mime(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("");
    if ext.eq_ignore_ascii_case("jpg")
        || ext.eq_ignore_ascii_case("jpeg")
        || ext.eq_ignore_ascii_case("jfif")
    {
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
    } else if ext.eq_ignore_ascii_case("tif") || ext.eq_ignore_ascii_case("tiff") {
        "image/tiff"
    } else if ext.eq_ignore_ascii_case("apng") {
        "image/apng"
    } else if ext.eq_ignore_ascii_case("mp4") {
        "video/mp4"
    } else {
        "application/octet-stream"
    }
}
