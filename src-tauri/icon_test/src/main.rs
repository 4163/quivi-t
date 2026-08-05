use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_USEFILEATTRIBUTES, SHGFI_LARGEICON};
use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, DestroyIcon, HICON};
use windows::Win32::Graphics::Gdi::{DeleteObject};
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

fn get_icon_for_ext(ext: &str) -> Option<String> {
    unsafe {
        let ext_wide: Vec<u16> = OsStr::new(ext).encode_wide().chain(std::iter::once(0)).collect();
        let mut shfi = SHFILEINFOW::default();
        let flags = SHGFI_ICON | SHGFI_USEFILEATTRIBUTES | SHGFI_LARGEICON;
        let res = SHGetFileInfoW(
            windows::core::PCWSTR(ext_wide.as_ptr()),
            windows::Win32::Foundation::FILE_ATTRIBUTE_NORMAL.0,
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        );

        if res == 0 || shfi.hIcon.is_invalid() {
            return None;
        }
        
        let hicon = shfi.hIcon;
        println!("Got HICON for {}", ext);
        
        let mut icon_info = windows::Win32::UI::WindowsAndMessaging::ICONINFO::default();
        if GetIconInfo(hicon, &mut icon_info).is_ok() {
            println!("Got ICONINFO");
            let _ = DeleteObject(icon_info.hbmColor);
            let _ = DeleteObject(icon_info.hbmMask);
        }
        
        DestroyIcon(hicon);
    }
    None
}

fn main() {
    get_icon_for_ext(".zip");
    get_icon_for_ext(".jpg");
}
