#[cfg(windows)]
use image::RgbaImage;
#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(windows)]
use std::io::Cursor;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows::Win32::Foundation::SIZE;
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, GetObjectW,
    ReleaseDC, SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC,
    HGDIOBJ, SRCCOPY,
};
#[cfg(windows)]
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
#[cfg(windows)]
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK,
    SIIGBF_THUMBNAILONLY,
};

#[cfg(windows)]
const SHELL_THUMB_EXTS: &[&str] = &["jpg", "jpeg", "png", "bmp", "dib", "gif"];

// RAII guards matching the pattern in icons.rs (file-private there).

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

#[cfg(windows)]
struct ComGuard(bool);
#[cfg(windows)]
impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                CoUninitialize();
            }
        }
    }
}


/// Extracts a pre-rendered thumbnail from the Windows Shell thumbnail cache.
/// Returns `Ok(None)` when the extension is unsupported, the file is missing,
/// or the OS has no cached thumbnail. Only `Err` on COM initialization failure.
pub fn get_shell_thumbnail_png(path: &str, size: u32) -> Result<Option<Vec<u8>>, String> {
    #[cfg(not(windows))]
    return Ok(None);

    #[cfg(windows)]
    {
        let ext = std::path::Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());

        match ext {
            Some(ref e) if SHELL_THUMB_EXTS.contains(&e.as_str()) => {}
            _ => return Ok(None),
        }

        if !std::path::Path::new(path).exists() {
            return Ok(None);
        }

        // COM init — only call CoUninitialize if we were the thread that
        // actually initialized (S_OK), not when piggy-backing (S_FALSE).
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if hr.is_err() {
            return Err(format!("COM init failed: {:?}", hr));
        }
        let _com = ComGuard(hr.0 == 0); // S_OK = 0

        let wide_path: Vec<u16> = OsStr::new(path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let factory: IShellItemImageFactory = match unsafe {
            SHCreateItemFromParsingName(windows::core::PCWSTR(wide_path.as_ptr()), None)
        } {
            Ok(f) => f,
            Err(_) => return Ok(None),
        };

        let req_size = SIZE {
            cx: size as i32,
            cy: size as i32,
        };
        let flags = SIIGBF_BIGGERSIZEOK | SIIGBF_THUMBNAILONLY;

        let hbitmap = match unsafe { factory.GetImage(req_size, flags) } {
            Ok(h) => h,
            Err(_) => return Ok(None),
        };
        let _hbm_guard = ScopedHgdiobj(hbitmap.into());

        let mut bmp = BITMAP::default();
        unsafe {
            GetObjectW(
                hbitmap.into(),
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bmp as *mut _ as *mut std::ffi::c_void),
            );
        }
        let width = bmp.bmWidth as u32;
        let height = bmp.bmHeight as u32;
        if width == 0 || height == 0 {
            return Ok(None);
        }

        let hdc_screen = ScopedScreenDc(unsafe { GetDC(None) });
        let hdc_src = ScopedMemDc(unsafe { CreateCompatibleDC(Some(hdc_screen.0)) });
        let old_src = unsafe { SelectObject(hdc_src.0, hbitmap.into()) };

        let hdc_dst = ScopedMemDc(unsafe { CreateCompatibleDC(Some(hdc_screen.0)) });

        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = width as i32;
        bmi.bmiHeader.biHeight = -(height as i32); // top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB.0;

        let mut bits_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        let hbm_dib = unsafe {
            CreateDIBSection(
                Some(hdc_dst.0),
                &bmi,
                DIB_RGB_COLORS,
                &mut bits_ptr,
                None,
                0,
            )
        };

        let hbm_dib = match hbm_dib {
            Ok(h) if !h.is_invalid() => h,
            _ => {
                unsafe { SelectObject(hdc_src.0, old_src); }
                return Ok(None);
            }
        };
        let _dib_guard = ScopedHgdiobj(hbm_dib.into());
        let old_dst = unsafe { SelectObject(hdc_dst.0, hbm_dib.into()) };

        unsafe {
            let _ = BitBlt(
                hdc_dst.0,
                0,
                0,
                width as i32,
                height as i32,
                Some(hdc_src.0),
                0,
                0,
                SRCCOPY,
            );
        }

        let mut pixels = vec![0u8; (width * height * 4) as usize];
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
            SelectObject(hdc_src.0, old_src);
            SelectObject(hdc_dst.0, old_dst);
        }

        // BGRA → RGBA
        for chunk in pixels.chunks_exact_mut(4) {
            let b = chunk[0];
            chunk[0] = chunk[2];
            chunk[2] = b;
        }

        let img =
            RgbaImage::from_raw(width, height, pixels).ok_or("Failed to create RgbaImage")?;
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

        Ok(Some(buf.into_inner()))
    }
}
