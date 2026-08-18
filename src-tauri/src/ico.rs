use std::fs;


#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_USEFILEATTRIBUTES};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, DestroyIcon, DrawIconEx, DI_NORMAL};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{GetDC, ReleaseDC, CreateCompatibleDC, DeleteDC, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, DeleteObject, CreateDIBSection, SelectObject, GetObjectW, BITMAP};
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_DIRECTORY};

// ── ICO Spritesheet ──────────────────────────────────────────────────────────

/// Extract all frames from an ICO file and return them as a horizontal
/// spritesheet encoded as a PNG data-URL.
#[tauri::command]
pub fn get_ico_frames(path: String) -> Result<String, String> {
    let data = fs::read(&path).map_err(|e| format!("Cannot read ICO file: {e}"))?;
    ico_frames_from_bytes(&data)
}

pub fn ico_frames_from_bytes(data: &[u8]) -> Result<String, String> {
    // Parse the ICO directory header manually to find all image entries,
    // then decode each sub-image individually.
    if data.len() < 6 {
        return Err("File too small to be an ICO".into());
    }
    
    // ICO header: reserved(2) + type(2) + count(2)
    let count = u16::from_le_bytes([data[4], data[5]]) as usize;
    if count == 0 || data.len() < 6 + count * 16 {
        return Err("Invalid ICO file structure".into());
    }
    
    let mut frames: Vec<image::DynamicImage> = Vec::new();
    
    for i in 0..count {
        let entry_offset = 6 + i * 16;
        let offset = u32::from_le_bytes([
            data[entry_offset + 12],
            data[entry_offset + 13],
            data[entry_offset + 14],
            data[entry_offset + 15],
        ]) as usize;
        let size = u32::from_le_bytes([
            data[entry_offset + 8],
            data[entry_offset + 9],
            data[entry_offset + 10],
            data[entry_offset + 11],
        ]) as usize;
        
        if offset + size > data.len() {
            continue;
        }
        
        let frame_data = &data[offset..offset + size];
        
        // Try to decode as PNG first (modern ICOs embed PNG)
        if frame_data.starts_with(b"\x89PNG") {
            match image::load_from_memory_with_format(frame_data, image::ImageFormat::Png) {
                Ok(image) => {
                    frames.push(image);
                }
                Err(_) => continue,
            }
        } else {
            // BMP frame - try to decode by creating a synthetic single-entry ICO
            // Create a minimal ICO file with just this one BMP entry
            let mut synthetic_ico = Vec::new();
            synthetic_ico.extend_from_slice(&[0, 0, 1, 0, 1, 0]); // ICO header with count=1
            synthetic_ico.extend_from_slice(&data[entry_offset..entry_offset + 12]); // Copy directory entry (width, height, etc.)
            // Adjust offset to point right after the 6+16 byte header
            synthetic_ico.extend_from_slice(&[22, 0, 0, 0]); // New offset = 22
            synthetic_ico.extend_from_slice(frame_data); // Append the BMP data
            
            match image::load_from_memory_with_format(&synthetic_ico, image::ImageFormat::Ico) {
                Ok(image) => {
                    frames.push(image);
                }
                Err(_) => continue,
            }
        }
    }
    
    if frames.is_empty() {
        // Last resort: just load the whole ICO
        let img = image::load_from_memory_with_format(&data, image::ImageFormat::Ico)
            .map_err(|e| format!("Failed to decode ICO: {e}"))?;
        frames.push(img);
    }
    
    // Sort largest to smallest for a consistent left-to-right order
    frames.sort_by(|a, b| b.width().cmp(&a.width()));
    // Deduplicate by width/height
    frames.dedup_by(|a, b| a.width() == b.width() && a.height() == b.height());
    
    let total_width: u32 = frames.iter().map(|f| f.width()).sum();
    let max_height: u32 = frames.iter().map(|f| f.height()).max().unwrap_or(0);
    
    let mut spritesheet = image::RgbaImage::new(total_width, max_height);
    let mut x_offset = 0u32;
    for frame in &frames {
        let rgba = frame.to_rgba8();
        let y_offset = (max_height - rgba.height()) / 2;
        for (px, py, pixel) in rgba.enumerate_pixels() {
            spritesheet.put_pixel(x_offset + px, y_offset + py, *pixel);
        }
        x_offset += rgba.width();
    }
    
    // Encode as PNG and return as data-URL
    let mut png_bytes: Vec<u8> = Vec::new();
    {
        use image::ImageEncoder;
        let encoder = image::codecs::png::PngEncoder::new(&mut png_bytes);
        encoder
            .write_image(
                spritesheet.as_raw(),
                spritesheet.width(),
                spritesheet.height(),
                image::ColorType::Rgba8.into(),
            )
            .map_err(|e| format!("Failed to encode PNG: {e}"))?;
    }
    
    let b64 = crate::utils::base64_encode(&png_bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}



#[tauri::command]
pub fn get_native_icon(ext: &str) -> Result<Option<String>, String> {
    #[cfg(not(windows))]
    return Ok(None);

    #[cfg(windows)]
    unsafe {
        use image::RgbaImage;
        use std::io::Cursor;
        use base64::prelude::*;

        let is_folder = ext == "__folder__";

        let dummy_name = if is_folder {
            "dummy".to_string()
        } else {
            let name = format!("dummy{}", if ext.starts_with('.') { "" } else { "." });
            format!("{}{}", name, ext)
        };
        
        let ext_wide: Vec<u16> = OsStr::new(&dummy_name).encode_wide().chain(std::iter::once(0)).collect();
        let mut shfi = SHFILEINFOW::default();
        let flags = SHGFI_ICON | SHGFI_USEFILEATTRIBUTES | windows::Win32::UI::Shell::SHGFI_SMALLICON;
        let attrs = if is_folder {
            FILE_ATTRIBUTE_DIRECTORY
        } else {
            FILE_ATTRIBUTE_NORMAL
        };

        let res = SHGetFileInfoW(
            windows::core::PCWSTR(ext_wide.as_ptr()),
            attrs,
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        );

        if res == 0 || shfi.hIcon.is_invalid() {
            return Ok(None);
        }

        let hicon = shfi.hIcon;
        
        let mut icon_info = windows::Win32::UI::WindowsAndMessaging::ICONINFO::default();
        if GetIconInfo(hicon, &mut icon_info).is_err() {
            let _ = DestroyIcon(hicon);
            return Ok(None);
        }

        // Get bitmap info
        let mut bmp = BITMAP::default();
        GetObjectW(
            icon_info.hbmColor.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut std::ffi::c_void),
        );

        let width = bmp.bmWidth as u32;
        let height = bmp.bmHeight as u32;
        
        let hdc_screen = GetDC(None);
        let hdc_mem = CreateCompatibleDC(Some(hdc_screen));
        
        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = width as i32;
        bmi.bmiHeader.biHeight = -(height as i32); // top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB.0;

        let mut pixels: Vec<u8> = vec![0; (width * height * 4) as usize];
        
        let mut bits_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
        let hbm_dib = match CreateDIBSection(
            Some(hdc_mem),
            &bmi,
            DIB_RGB_COLORS,
            &mut bits_ptr,
            None,
            0,
        ) {
            Ok(h) => h,
            Err(_) => {
                let _ = DeleteDC(hdc_mem);
                let _ = ReleaseDC(None, hdc_screen);
                let _ = DeleteObject(icon_info.hbmColor.into());
                let _ = DeleteObject(icon_info.hbmMask.into());
                let _ = DestroyIcon(hicon);
                return Ok(None);
            }
        };

        if hbm_dib.is_invalid() {
            let _ = DeleteDC(hdc_mem);
            let _ = ReleaseDC(None, hdc_screen);
            let _ = DeleteObject(icon_info.hbmColor.into());
            let _ = DeleteObject(icon_info.hbmMask.into());
            let _ = DestroyIcon(hicon);
            return Ok(None);
        }

        let old_bmp = SelectObject(hdc_mem, hbm_dib.into());
        
        // Draw the icon onto the DIB
        let _ = DrawIconEx(
            hdc_mem,
            0,
            0,
            hicon,
            width as i32,
            height as i32,
            0,
            None,
            DI_NORMAL,
        );
        
        // Copy bits from DIB to our vec
        std::ptr::copy_nonoverlapping(bits_ptr as *const u8, pixels.as_mut_ptr(), pixels.len());
        
        // Clean up GDI
        SelectObject(hdc_mem, old_bmp);
        let _ = DeleteObject(hbm_dib.into());
        let _ = DeleteDC(hdc_mem);
        let _ = ReleaseDC(None, hdc_screen);
        
        let _ = DeleteObject(icon_info.hbmColor.into());
        let _ = DeleteObject(icon_info.hbmMask.into());
        let _ = DestroyIcon(hicon);
        
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
        ).map_err(|e| e.to_string())?;
        
        let base64_str = BASE64_STANDARD.encode(buf.into_inner());
        let data_uri = format!("data:image/png;base64,{}", base64_str);
        
        Ok(Some(data_uri))
    }
}
