pub mod attributes;
pub mod dialog;
#[cfg(windows)]
pub mod direct_open;
#[cfg(windows)]
pub mod drop;
#[cfg(windows)]
pub mod gdi;
pub mod icons;
pub mod previews;
#[cfg(windows)]
pub mod process;
pub mod temp_archive;
pub mod thumbnails;

#[cfg(windows)]
pub fn encode_wide_null(s: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}
