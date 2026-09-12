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
    IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_THUMBNAILONLY,
};

#[cfg(windows)]
const SHELL_THUMB_EXTS: &[&str] = &["jpg", "jpeg", "png", "bmp", "dib", "gif", "ico"];

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

        // Animated GIFs: skip Shell extraction (static first-frame only).
        // The frontend falls back to asset:// which plays animation natively.
        if ext.as_ref().map_or(false, |e| e == "gif") {
            let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 262_144];
            let n = std::io::Read::read(&mut f, &mut buf).unwrap_or(0);
            if crate::formats::check_animation_status(&buf[..n]).is_animated {
                return Ok(None);
            }
        }

        // COM initialization. Only call CoUninitialize if this thread
        // initialized COM (S_OK), not when reusing an existing runtime (S_FALSE).
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
                unsafe {
                    SelectObject(hdc_src.0, old_src);
                }
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

        // Detect black matte: if the source has transparency but the Shell
        // thumbnail is fully opaque, it was composited onto a black background.
        let ext_str = ext.as_ref().unwrap();
        if source_has_transparency(path, ext_str) {
            let has_alpha = pixels.chunks_exact(4).any(|px| px[3] < 255);
            if !has_alpha {
                return Ok(None);
            }
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

        Ok(Some(buf.into_inner()))
    }
}

/// Returns true if the source image file contains transparency data.
/// Reads only the first 1024 bytes (header) to avoid full-file I/O.
#[cfg(windows)]
pub(crate) fn source_has_transparency(path: &str, ext: &str) -> bool {
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut hdr = [0u8; 1024];
    let n = std::io::Read::read(&mut f, &mut hdr).unwrap_or(0);
    let hdr = &hdr[..n];

    match ext {
        "png" => png_has_alpha(hdr),
        "gif" => gif_has_transparency(hdr),
        "ico" => ico_has_alpha(hdr),
        _ => false,
    }
}

/// PNG: color type 4 (grey+alpha) or 6 (RGBA) in IHDR, or a tRNS chunk
/// before IDAT signals palette/grey transparency.
#[cfg(windows)]
fn png_has_alpha(hdr: &[u8]) -> bool {
    // PNG signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4)
    // + bit depth (1) + color type (1) = byte 25
    if hdr.len() < 26 {
        return false;
    }
    let color_type = hdr[25];
    if color_type == 4 || color_type == 6 {
        return true;
    }
    // Scan chunks for tRNS before IDAT
    let mut pos = 8; // after PNG signature
    while pos + 12 <= hdr.len() {
        let chunk_len =
            u32::from_be_bytes([hdr[pos], hdr[pos + 1], hdr[pos + 2], hdr[pos + 3]]) as usize;
        let chunk_type = &hdr[pos + 4..pos + 8];
        if chunk_type == b"tRNS" {
            return true;
        }
        if chunk_type == b"IDAT" {
            break;
        }
        // 4 (length) + 4 (type) + chunk_len (data) + 4 (CRC)
        pos += 12 + chunk_len;
    }
    false
}

/// GIF: check Graphic Control Extension for the transparent color flag.
#[cfg(windows)]
fn gif_has_transparency(hdr: &[u8]) -> bool {
    if hdr.len() < 13 || !hdr.starts_with(b"GIF") {
        return false;
    }
    let mut pos = 13;
    let flags = hdr[10];
    if (flags & 0x80) != 0 {
        let gct_size = 2_usize.pow((flags & 0x07) as u32 + 1);
        pos += 3 * gct_size;
    }
    while pos + 2 < hdr.len() {
        if hdr[pos] == 0x21 && hdr[pos + 1] == 0xF9 {
            // GCE block: introducer (0x21), label (0xF9), block size, packed flags
            if pos + 4 < hdr.len() {
                let packed = hdr[pos + 3];
                return (packed & 0x01) != 0;
            }
        }
        if hdr[pos] == 0x2C || hdr[pos] == 0x3B {
            break; // image descriptor or trailer, stop scanning
        }
        // Skip extension block
        if hdr[pos] == 0x21 {
            pos += 2;
            while pos < hdr.len() {
                let block_size = hdr[pos] as usize;
                pos += 1;
                if block_size == 0 {
                    break;
                }
                pos += block_size;
            }
        } else {
            break;
        }
    }
    false
}

/// ICO: any entry with 32bpp contains alpha. Parse directory per ico.rs.
#[cfg(windows)]
fn ico_has_alpha(hdr: &[u8]) -> bool {
    if hdr.len() < 6 {
        return false;
    }
    // Reserved (0) + type (1 = icon) + count
    if hdr[0..2] != [0, 0] || hdr[2..4] != [1, 0] {
        return false;
    }
    let count = u16::from_le_bytes([hdr[4], hdr[5]]) as usize;
    if count == 0 || hdr.len() < 6 + count * 16 {
        return false;
    }
    for i in 0..count {
        let off = 6 + i * 16;
        let bpp = hdr[off + 6];
        // bpp 0 means 256, but 32 indicates BGRA with alpha
        if bpp == 32 {
            return true;
        }
        // Also treat 0 bpp with PNG entry as alpha (PNG signature inside)
        // Fallback: if entry size suggests PNG, assume alpha
        let bytes_in_res =
            u32::from_le_bytes([hdr[off + 8], hdr[off + 9], hdr[off + 10], hdr[off + 11]]) as usize;
        if bytes_in_res >= 8 && hdr.len() >= 22 {
            // Heuristic: PNG entries are stored as PNG, which typically has alpha
            // We cannot read entry data in header-only 1024, but 32bpp is reliable.
        }
    }
    false
}
