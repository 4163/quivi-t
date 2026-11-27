use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder};
use windows::Win32::Foundation::{RPC_E_CHANGED_MODE, S_FALSE, S_OK};
use windows::Win32::Graphics::Gdi::{
    DeleteDC, DeleteObject, ReleaseDC, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, HDC, HGDIOBJ,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};

pub struct ScopedHgdiobj(pub HGDIOBJ);
impl Drop for ScopedHgdiobj {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = DeleteObject(self.0);
            }
        }
    }
}

pub struct ScopedMemDc(pub HDC);
impl Drop for ScopedMemDc {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = DeleteDC(self.0);
            }
        }
    }
}

pub struct ScopedScreenDc(pub HDC);
impl Drop for ScopedScreenDc {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = ReleaseDC(None, self.0);
            }
        }
    }
}

/// STA COM lifetime guard. Calls `CoUninitialize` only when this guard
/// performed the initial `S_OK` initialization; `S_FALSE` and
/// `RPC_E_CHANGED_MODE` (already initialized on an MTA thread) succeed without
/// uninitializing on drop.
pub struct ScopedComInit {
    should_uninit: bool,
}

impl ScopedComInit {
    pub fn init() -> Result<Self, String> {
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if hr == S_OK {
            Ok(Self {
                should_uninit: true,
            })
        } else if hr == S_FALSE || hr == RPC_E_CHANGED_MODE {
            Ok(Self {
                should_uninit: false,
            })
        } else {
            Err(format!("COM init failed: {hr:?}"))
        }
    }
}

impl Drop for ScopedComInit {
    fn drop(&mut self) {
        if self.should_uninit {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

pub fn top_down_bgra_bitmap_info(width: u32, height: u32) -> BITMAPINFO {
    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = width as i32;
    bmi.bmiHeader.biHeight = -(height as i32);
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = BI_RGB.0;
    bmi
}

/// Copies a 32-bit top-down BGRA DIB buffer into an RGBA `Vec<u8>` in a single pass.
///
/// # Safety
/// If `bits_ptr` is non-null, it must be valid for reads of `width * height * 4` bytes.
pub unsafe fn copy_bgra_to_rgba(bits_ptr: *const u8, width: u32, height: u32) -> Vec<u8> {
    let byte_len = (width as usize)
        .saturating_mul(height as usize)
        .saturating_mul(4);
    if bits_ptr.is_null() || byte_len == 0 {
        return vec![0u8; byte_len];
    }
    let src = std::slice::from_raw_parts(bits_ptr, byte_len);
    let mut dst = Vec::with_capacity(byte_len);
    for px in src.chunks_exact(4) {
        dst.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
    }
    dst
}

pub fn encode_rgba_png_fast(pixels: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let encoder =
        PngEncoder::new_with_quality(&mut buf, CompressionType::Fast, FilterType::NoFilter);
    encoder
        .write_image(pixels, width, height, ExtendedColorType::Rgba8)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}
