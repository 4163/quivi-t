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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComInitError {
    ChangedMode,
    Failed(String),
}

impl std::fmt::Display for ComInitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ChangedMode => write!(f, "COM init failed: RPC_E_CHANGED_MODE"),
            Self::Failed(msg) => f.write_str(msg),
        }
    }
}

/// STA COM lifetime guard. Every `S_OK` or `S_FALSE` call to `CoInitializeEx`
/// increments the thread's COM refcount and must be paired with `CoUninitialize`
/// on drop. `RPC_E_CHANGED_MODE` is returned as an error so callers never
/// silently run STA-required shell APIs on an MTA thread.
pub struct ScopedComInit {
    should_uninit: bool,
}

impl ScopedComInit {
    pub fn init_sta() -> Result<Self, ComInitError> {
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if hr == S_OK || hr == S_FALSE {
            Ok(Self {
                should_uninit: true,
            })
        } else if hr == RPC_E_CHANGED_MODE {
            Err(ComInitError::ChangedMode)
        } else {
            Err(ComInitError::Failed(format!("COM init failed: {hr:?}")))
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
/// Returns `None` on null pointer, zero dimensions, or byte-length overflow.
///
/// # Safety
/// If `bits_ptr` is non-null, it must be valid for reads of `width * height * 4` bytes.
pub unsafe fn copy_bgra_to_rgba(
    bits_ptr: *const u8,
    width: u32,
    height: u32,
) -> Option<Vec<u8>> {
    if bits_ptr.is_null() || width == 0 || height == 0 {
        return None;
    }
    let byte_len = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)?;
    if byte_len > isize::MAX as usize {
        return None;
    }
    let src = std::slice::from_raw_parts(bits_ptr, byte_len);
    let mut dst = Vec::with_capacity(byte_len);
    for px in src.chunks_exact(4) {
        dst.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
    }
    Some(dst)
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
