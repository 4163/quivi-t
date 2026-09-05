#[cfg(windows)]
use base64::prelude::*;
#[cfg(windows)]
use image::RgbaImage;
#[cfg(windows)]
use std::collections::HashMap;
#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(windows)]
use std::io::Cursor;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::sync::Mutex;
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, GetObjectW, ReleaseDC,
    SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, HGDIOBJ,
};
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL};
#[cfg(windows)]
use windows::Win32::UI::Shell::{
    SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_SMALLICON, SHGFI_USEFILEATTRIBUTES,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, DrawIconEx, GetIconInfo, DI_NORMAL, HICON,
};

#[cfg(windows)]
static NATIVE_ICON_CACHE: Mutex<Option<HashMap<String, Vec<u8>>>> = Mutex::new(None);

#[cfg(windows)]
struct ScopedHicon(HICON);
#[cfg(windows)]
impl Drop for ScopedHicon {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = DestroyIcon(self.0);
            }
        }
    }
}

#[cfg(windows)]
struct ScopedHgdiobj(HGDIOBJ);
#[cfg(windows)]
impl Drop for ScopedHgdiobj {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = DeleteObject(self.0);
            }
        }
    }
}

#[cfg(windows)]
struct ScopedMemDc(HDC);
#[cfg(windows)]
impl Drop for ScopedMemDc {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = DeleteDC(self.0);
            }
        }
    }
}

#[cfg(windows)]
struct ScopedScreenDc(HDC);
#[cfg(windows)]
impl Drop for ScopedScreenDc {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = ReleaseDC(None, self.0);
            }
        }
    }
}

/// Pre-warm the Windows shell icon infrastructure on a background thread.
/// The first SHGetFileInfoW call in a process pays a ~2-3s initialization cost;
/// absorbing it here keeps the UI icon pipeline jank-free.
pub fn warmup() {
    #[cfg(windows)]
    {
        std::thread::spawn(|| {
            let dummy: Vec<u16> = OsStr::new("warmup.txt")
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let mut shfi = SHFILEINFOW::default();
            unsafe {
                SHGetFileInfoW(
                    windows::core::PCWSTR(dummy.as_ptr()),
                    FILE_ATTRIBUTE_NORMAL,
                    Some(&mut shfi),
                    std::mem::size_of::<SHFILEINFOW>() as u32,
                    SHGFI_ICON | SHGFI_USEFILEATTRIBUTES | SHGFI_SMALLICON,
                );
                if !shfi.hIcon.is_invalid() {
                    let _ = DestroyIcon(shfi.hIcon);
                }
            }
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconSize {
    Small,
    Large,
}

pub fn get_cached_native_icon(path: &str, ext_key: &str, size: Option<&str>) -> Result<Option<String>, String> {
    let icon_size = match size {
        Some(s) if s.eq_ignore_ascii_case("large") || s == "32" => IconSize::Large,
        _ => IconSize::Small,
    };
    let Some(png_bytes) = get_cached_native_icon_png_with_size(path, ext_key, icon_size)? else {
        return Ok(None);
    };

    #[cfg(windows)]
    {
        let base64_str = BASE64_STANDARD.encode(png_bytes);
        return Ok(Some(format!("data:image/png;base64,{}", base64_str)));
    }

    #[cfg(not(windows))]
    return Ok(None);
}

pub fn get_cached_native_icon_png(path: &str, ext_key: &str) -> Result<Option<Vec<u8>>, String> {
    get_cached_native_icon_png_with_size(path, ext_key, IconSize::Small)
}

pub fn get_cached_native_icon_png_with_size(
    path: &str,
    ext_key: &str,
    size: IconSize,
) -> Result<Option<Vec<u8>>, String> {
    #[cfg(not(windows))]
    return Ok(None);

    #[cfg(windows)]
    {
        let lower_ext = ext_key.to_string();
        let cache_key = match size {
            IconSize::Small => lower_ext.clone(),
            IconSize::Large => format!("large:{}", lower_ext),
        };

        {
            let mut cache_guard = NATIVE_ICON_CACHE.lock().map_err(|e| e.to_string())?;
            if let Some(cache) = cache_guard.as_mut() {
                if let Some(png_bytes) = cache.get(&cache_key) {
                    return Ok(Some(png_bytes.clone()));
                }
            } else {
                *cache_guard = Some(HashMap::new());
            }
        }

        // Drives and special folders use the real path so Windows resolves their
        // unique shell icons. Regular extensions use a dummy filename with
        // SHGFI_USEFILEATTRIBUTES for speed (no filesystem access).
        let is_real_path = lower_ext.contains('\\') || lower_ext.contains('/') || lower_ext.contains(':');
        let is_generic_folder = lower_ext == "__folder__";

        let size_flag = match size {
            IconSize::Small => SHGFI_SMALLICON,
            IconSize::Large => SHGFI_LARGEICON,
        };

        let (query_name, attrs, flags) = if is_real_path {
            let wide: Vec<u16> = OsStr::new(path)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            (wide, FILE_ATTRIBUTE_NORMAL, SHGFI_ICON | size_flag)
        } else if is_generic_folder {
            let wide: Vec<u16> = OsStr::new("dummy")
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            (wide, FILE_ATTRIBUTE_DIRECTORY, SHGFI_ICON | SHGFI_USEFILEATTRIBUTES | size_flag)
        } else {
            let name = format!("dummy.{}", ext_key.trim_start_matches('.'));
            let wide: Vec<u16> = OsStr::new(&name)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            (wide, FILE_ATTRIBUTE_NORMAL, SHGFI_ICON | SHGFI_USEFILEATTRIBUTES | size_flag)
        };

        let mut shfi = SHFILEINFOW::default();
        let res = unsafe {
            SHGetFileInfoW(
                windows::core::PCWSTR(query_name.as_ptr()),
                attrs,
                Some(&mut shfi),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                flags,
            )
        };

        if res == 0 || shfi.hIcon.is_invalid() {
            return Ok(None);
        }

        // Wrap HICON in RAII
        let hicon = ScopedHicon(shfi.hIcon);

        let mut icon_info = windows::Win32::UI::WindowsAndMessaging::ICONINFO::default();
        if unsafe { GetIconInfo(hicon.0, &mut icon_info).is_err() } {
            return Ok(None);
        }

        // Wrap color and mask in RAII
        let _hbm_color = ScopedHgdiobj(icon_info.hbmColor.into());
        let _hbm_mask = ScopedHgdiobj(icon_info.hbmMask.into());

        let mut width: u32 = 0;
        let mut height: u32 = 0;

        // Monochrome icons don't have an hbmColor, they use hbmMask for both color and transparency (double height).
        if icon_info.hbmColor.is_invalid() {
            if !icon_info.hbmMask.is_invalid() {
                let mut bmp = BITMAP::default();
                unsafe {
                    GetObjectW(
                        icon_info.hbmMask.into(),
                        std::mem::size_of::<BITMAP>() as i32,
                        Some(&mut bmp as *mut _ as *mut std::ffi::c_void),
                    );
                }
                width = bmp.bmWidth as u32;
                height = (bmp.bmHeight / 2) as u32;
            }
        } else {
            let mut bmp = BITMAP::default();
            unsafe {
                GetObjectW(
                    icon_info.hbmColor.into(),
                    std::mem::size_of::<BITMAP>() as i32,
                    Some(&mut bmp as *mut _ as *mut std::ffi::c_void),
                );
            }
            width = bmp.bmWidth as u32;
            height = bmp.bmHeight as u32;
        }

        if width == 0 || height == 0 {
            return Ok(None);
        }

        let hdc_screen = ScopedScreenDc(unsafe { GetDC(None) });
        let hdc_mem = ScopedMemDc(unsafe { CreateCompatibleDC(Some(hdc_screen.0)) });

        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = width as i32;
        bmi.bmiHeader.biHeight = -(height as i32); // top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB.0;

        let mut pixels: Vec<u8> = vec![0; (width * height * 4) as usize];
        let mut bits_ptr: *mut std::ffi::c_void = std::ptr::null_mut();

        let hbm_dib = unsafe {
            CreateDIBSection(
                Some(hdc_mem.0),
                &bmi,
                DIB_RGB_COLORS,
                &mut bits_ptr,
                None,
                0,
            )
        };

        if let Ok(h) = hbm_dib {
            if h.is_invalid() {
                return Ok(None);
            }
            let _hbm_dib_guard = ScopedHgdiobj(h.into());
            let old_bmp = unsafe { SelectObject(hdc_mem.0, h.into()) };

            unsafe {
                let _ = DrawIconEx(
                    hdc_mem.0,
                    0,
                    0,
                    hicon.0,
                    width as i32,
                    height as i32,
                    0,
                    None,
                    DI_NORMAL,
                );
            }

            if !bits_ptr.is_null() {
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        bits_ptr as *const u8,
                        pixels.as_mut_ptr(),
                        pixels.len(),
                    );
                }
            }

            unsafe {
                SelectObject(hdc_mem.0, old_bmp);
            }
        } else {
            return Ok(None);
        }
        // Convert BGRA to RGBA
        for chunk in pixels.chunks_exact_mut(4) {
            let b = chunk[0];
            let r = chunk[2];
            chunk[0] = r;
            chunk[2] = b;
        }

        let img = RgbaImage::from_raw(width, height, pixels).ok_or("Failed to create RgbaImage")?;
        let mut buf = Cursor::new(Vec::new());
        image::write_buffer_with_format(
            &mut buf,
            &img,
            width,
            height,
            image::ColorType::Rgba8,
            image::ImageFormat::Png,
        )
        .map_err(|e| e.to_string())?;

        let png_bytes = buf.into_inner();

        // Store in cache
        {
            let mut cache_guard = NATIVE_ICON_CACHE.lock().map_err(|e| e.to_string())?;
            if let Some(cache) = cache_guard.as_mut() {
                cache.insert(cache_key, png_bytes.clone());
            }
        }

        Ok(Some(png_bytes))
    }
}
