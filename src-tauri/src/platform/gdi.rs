use windows::Win32::Graphics::Gdi::{DeleteDC, DeleteObject, ReleaseDC, HDC, HGDIOBJ};

#[cfg(windows)]
pub struct ScopedHgdiobj(pub HGDIOBJ);
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
pub struct ScopedMemDc(pub HDC);
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
pub struct ScopedScreenDc(pub HDC);
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

pub fn bgra_to_rgba_in_place(pixels: &mut [u8]) {
    for chunk in pixels.chunks_exact_mut(4) {
        chunk.swap(0, 2);
    }
}

pub fn rgba_to_premultiplied_bgra(source: &[u8], target: &mut [u8]) {
    for (src, dst) in source.chunks_exact(4).zip(target.chunks_exact_mut(4)) {
        let alpha = src[3] as u16;
        dst[0] = ((src[2] as u16 * alpha + 127) / 255) as u8;
        dst[1] = ((src[1] as u16 * alpha + 127) / 255) as u8;
        dst[2] = ((src[0] as u16 * alpha + 127) / 255) as u8;
        dst[3] = src[3];
    }
}

pub fn unpremultiply_rgba_in_place(pixels: &mut [u8]) {
    for pixel in pixels.chunks_exact_mut(4) {
        let alpha = u16::from(pixel[3]);
        if alpha != 0 && alpha != 255 {
            for channel in &mut pixel[..3] {
                *channel = ((u16::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
            }
        }
    }
}
