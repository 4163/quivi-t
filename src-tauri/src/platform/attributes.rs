use std::path::Path;
use std::fs;
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;

/// Set or clear the Windows FILE_ATTRIBUTE_HIDDEN flag on a file.
/// Returns Ok(()) on success or if not on Windows.
#[cfg(windows)]
pub fn set_hidden_attribute(path: &Path, hidden: bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use std::ffi::OsStr;

    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;

    // Convert the path for Win32.
    let wide_path: Vec<u16> = OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        // Read current attributes.
        let attrs = windows::Win32::Storage::FileSystem::GetFileAttributesW(
            windows::core::PCWSTR(wide_path.as_ptr())
        );

        if attrs == windows::Win32::Storage::FileSystem::INVALID_FILE_ATTRIBUTES {
            return Err(format!("Failed to get file attributes for {:?}", path));
        }

        // Set or clear the hidden bit
        let new_attrs = if hidden {
            attrs | FILE_ATTRIBUTE_HIDDEN
        } else {
            attrs & !FILE_ATTRIBUTE_HIDDEN
        };

        // Write updated attributes.
        let result = windows::Win32::Storage::FileSystem::SetFileAttributesW(
            windows::core::PCWSTR(wide_path.as_ptr()),
            windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(new_attrs)
        );

        if result.is_err() {
            return Err(format!("Failed to set file attributes for {:?}", path));
        }
    }

    Ok(())
}

#[cfg(not(windows))]
pub fn set_hidden_attribute(_path: &Path, _hidden: bool) -> Result<(), String> {
    // No-op outside Windows.
    Ok(())
}

pub fn is_hidden_path(name: &str, metadata: Option<&fs::Metadata>) -> bool {
    if name.starts_with('.') {
        return true;
    }

    #[cfg(windows)]
    {
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if let Some(meta) = metadata {
            return meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0;
        }
    }

    false
}
