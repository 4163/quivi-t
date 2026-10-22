use windows::{
    core::{Error, Result},
    Win32::{
        Foundation::{E_FAIL, RECT},
        Graphics::Gdi::{
            AlphaBlend, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject,
            AC_SRC_ALPHA, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, DIB_RGB_COLORS,
            HBITMAP, HDC,
        },
    },
};

pub(super) struct Bitmap {
    handle: HBITMAP,
    width: i32,
    height: i32,
}

impl Bitmap {
    pub fn new(image: &image::RgbaImage) -> Result<Self> {
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: image.width() as i32,
                biHeight: -(image.height() as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let handle = unsafe { CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0)? };
        let bitmap = Self {
            handle,
            width: image.width() as i32,
            height: image.height() as i32,
        };
        if bits.is_null() {
            return Err(Error::from(E_FAIL));
        }
        let output =
            unsafe { std::slice::from_raw_parts_mut(bits.cast::<u8>(), image.as_raw().len()) };
        for (source, target) in image
            .as_raw()
            .chunks_exact(4)
            .zip(output.chunks_exact_mut(4))
        {
            let alpha = source[3] as u16;
            target[0] = ((source[2] as u16 * alpha + 127) / 255) as u8;
            target[1] = ((source[1] as u16 * alpha + 127) / 255) as u8;
            target[2] = ((source[0] as u16 * alpha + 127) / 255) as u8;
            target[3] = source[3];
        }
        Ok(bitmap)
    }

    pub fn into_raw(self) -> HBITMAP {
        let handle = self.handle;
        std::mem::forget(self);
        handle
    }

    pub fn paint(&self, hdc: HDC, area: RECT) {
        let width = (area.right - area.left).max(0);
        let height = (area.bottom - area.top).max(0);
        if width == 0 || height == 0 {
            return;
        }
        let scale = (width as f64 / self.width as f64)
            .min(height as f64 / self.height as f64)
            .min(1.0);
        let target_width = (self.width as f64 * scale).round().max(1.0) as i32;
        let target_height = (self.height as f64 * scale).round().max(1.0) as i32;
        unsafe {
            let memory = CreateCompatibleDC(Some(hdc));
            if memory.0.is_null() {
                return;
            }
            let previous = SelectObject(memory, self.handle.into());
            let _ = AlphaBlend(
                hdc,
                area.left + (width - target_width) / 2,
                area.top + (height - target_height) / 2,
                target_width,
                target_height,
                memory,
                0,
                0,
                self.width,
                self.height,
                BLENDFUNCTION {
                    BlendOp: 0,
                    BlendFlags: 0,
                    SourceConstantAlpha: 255,
                    AlphaFormat: AC_SRC_ALPHA as u8,
                },
            );
            SelectObject(memory, previous);
            let _ = DeleteDC(memory);
        }
    }
}

impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(self.handle.into());
        }
    }
}
