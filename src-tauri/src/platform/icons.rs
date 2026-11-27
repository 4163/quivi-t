#[cfg(windows)]
use super::gdi::{
    self, ComInitError, ScopedComInit, ScopedHgdiobj, ScopedMemDc, ScopedScreenDc,
};
#[cfg(windows)]
use std::collections::{HashMap, VecDeque};
#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::sync::{Arc, Mutex};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, GdiFlush, GetDC, GetObjectW, SelectObject, BITMAP,
    DIB_RGB_COLORS,
};
#[cfg(windows)]
use windows::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_FLAGS_AND_ATTRIBUTES,
};
#[cfg(windows)]
use windows::Win32::UI::Shell::{
    SHGetFileInfoW, SHFILEINFOW, SHGFI_FLAGS, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_SMALLICON,
    SHGFI_USEFILEATTRIBUTES,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, DrawIconEx, GetIconInfo, DI_NORMAL, HICON,
};

pub(crate) const MAX_NATIVE_ICON_CACHE_ENTRIES: usize = 512;

#[cfg(windows)]
struct NativeIconCache {
    entries: HashMap<String, Arc<[u8]>>,
    order: VecDeque<String>,
}

#[cfg(windows)]
impl NativeIconCache {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    fn get(&self, key: &str) -> Option<Arc<[u8]>> {
        self.entries.get(key).cloned()
    }

    fn insert(&mut self, key: String, bytes: Arc<[u8]>) {
        if let Some(slot) = self.entries.get_mut(&key) {
            *slot = bytes;
            return;
        }
        while self.entries.len() >= MAX_NATIVE_ICON_CACHE_ENTRIES {
            let Some(evicted) = self.order.pop_front() else {
                break;
            };
            self.entries.remove(&evicted);
        }
        self.order.push_back(key.clone());
        self.entries.insert(key, bytes);
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }

    #[cfg(test)]
    fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(windows)]
static NATIVE_ICON_CACHE: Mutex<Option<NativeIconCache>> = Mutex::new(None);

#[cfg(windows)]
fn icon_cache_key_from_lower(lower_ext: &str, size: IconSize) -> String {
    match size {
        IconSize::Small => lower_ext.to_string(),
        IconSize::Large => format!("large:{}", lower_ext),
    }
}

#[cfg(windows)]
fn icon_cache_key(ext_key: &str, size: IconSize) -> String {
    let lower_ext = ext_key.to_ascii_lowercase();
    icon_cache_key_from_lower(&lower_ext, size)
}

/// Drops the process-local shell icon cache after Windows changes a file association.
pub fn clear_cached_native_icons() -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut cache_guard = NATIVE_ICON_CACHE.lock().map_err(|e| e.to_string())?;
        if let Some(cache) = cache_guard.as_mut() {
            cache.clear();
        }
    }

    Ok(())
}

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
            // Deferred video support lists mp4 only in Library/gallery dirs,
            // so its per-ext icon never warms through normal browsing. Prime
            // it here through the shared dummy path (no filesystem access).
            let _ = get_cached_native_icon_png_with_size("", "mp4", IconSize::Small);
        });
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconSize {
    Small,
    Large,
}

pub fn get_cached_native_icon(
    path: &str,
    ext_key: &str,
    size: Option<&str>,
) -> Result<Option<String>, String> {
    let icon_size = match size {
        Some(s) if s.eq_ignore_ascii_case("large") || s == "32" => IconSize::Large,
        _ => IconSize::Small,
    };
    let Some(png_bytes) = get_cached_native_icon_png_with_size(path, ext_key, icon_size)? else {
        return Ok(None);
    };

    #[cfg(windows)]
    {
        let base64_str = crate::utils::base64_encode(&png_bytes);
        return Ok(Some(format!("data:image/png;base64,{}", base64_str)));
    }

    #[cfg(not(windows))]
    return Ok(None);
}

pub fn try_get_cached_native_icon_png_with_size(
    ext_key: &str,
    size: IconSize,
) -> Option<std::sync::Arc<[u8]>> {
    #[cfg(not(windows))]
    {
        let _ = (ext_key, size);
        return None;
    }

    #[cfg(windows)]
    {
        let cache_key = icon_cache_key(ext_key, size);
        let guard = NATIVE_ICON_CACHE.try_lock().ok()?;
        guard.as_ref()?.get(&cache_key)
    }
}

#[cfg(windows)]
fn fetch_real_path_icon_png_sta(
    query_name: Vec<u16>,
    attrs: FILE_FLAGS_AND_ATTRIBUTES,
    flags: SHGFI_FLAGS,
) -> Result<Option<Vec<u8>>, String> {
    match ScopedComInit::init_sta() {
        Ok(_com) => fetch_icon_png(&query_name, attrs, flags),
        Err(ComInitError::ChangedMode) => {
            let handle = std::thread::Builder::new()
                .name("shell-icon-sta".to_string())
                .spawn(move || {
                    let _com = ScopedComInit::init_sta().map_err(|e| e.to_string())?;
                    fetch_icon_png(&query_name, attrs, flags)
                })
                .map_err(|e| format!("Failed to spawn STA icon thread: {e}"))?;
            handle
                .join()
                .map_err(|_| "STA icon thread panicked".to_string())?
        }
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(windows)]
fn fetch_icon_png(
    query_name: &[u16],
    attrs: FILE_FLAGS_AND_ATTRIBUTES,
    flags: SHGFI_FLAGS,
) -> Result<Option<Vec<u8>>, String> {
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

    let hicon = ScopedHicon(shfi.hIcon);

    let mut icon_info = windows::Win32::UI::WindowsAndMessaging::ICONINFO::default();
    if unsafe { GetIconInfo(hicon.0, &mut icon_info).is_err() } {
        return Ok(None);
    }

    let _hbm_color = ScopedHgdiobj(icon_info.hbmColor.into());
    let _hbm_mask = ScopedHgdiobj(icon_info.hbmMask.into());

    // Monochrome icons have no hbmColor; hbmMask packs color and transparency (double height).
    let (bmp_width, bmp_height) = if icon_info.hbmColor.is_invalid() {
        if icon_info.hbmMask.is_invalid() {
            return Ok(None);
        }
        let mut bmp = BITMAP::default();
        let got = unsafe {
            GetObjectW(
                icon_info.hbmMask.into(),
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bmp as *mut _ as *mut std::ffi::c_void),
            )
        };
        if got == 0 {
            return Ok(None);
        }
        (bmp.bmWidth, bmp.bmHeight / 2)
    } else {
        let mut bmp = BITMAP::default();
        let got = unsafe {
            GetObjectW(
                icon_info.hbmColor.into(),
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bmp as *mut _ as *mut std::ffi::c_void),
            )
        };
        if got == 0 {
            return Ok(None);
        }
        (bmp.bmWidth, bmp.bmHeight)
    };

    if bmp_width <= 0 || bmp_height <= 0 {
        return Ok(None);
    }
    let (Ok(width), Ok(height)) = (u32::try_from(bmp_width), u32::try_from(bmp_height)) else {
        return Ok(None);
    };

    let hdc_screen = ScopedScreenDc(unsafe { GetDC(None) });
    let hdc_mem = ScopedMemDc(unsafe { CreateCompatibleDC(Some(hdc_screen.0)) });
    let bmi = gdi::top_down_bgra_bitmap_info(width, height);
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

    let pixels = match hbm_dib {
        Ok(h) if !h.is_invalid() => {
            let _hbm_dib_guard = ScopedHgdiobj(h.into());
            let old_bmp = unsafe { SelectObject(hdc_mem.0, h.into()) };

            let draw_ok = unsafe {
                DrawIconEx(
                    hdc_mem.0,
                    0,
                    0,
                    hicon.0,
                    width as i32,
                    height as i32,
                    0,
                    None,
                    DI_NORMAL,
                )
                .is_ok()
            };

            let rgba = if draw_ok {
                unsafe {
                    let _ = GdiFlush();
                    gdi::copy_bgra_to_rgba(bits_ptr as *const u8, width, height)
                }
            } else {
                None
            };

            unsafe {
                SelectObject(hdc_mem.0, old_bmp);
            }

            match rgba {
                Some(rgba) => rgba,
                None => return Ok(None),
            }
        }
        _ => return Ok(None),
    };

    let png_bytes = gdi::encode_rgba_png_fast(&pixels, width, height)?;
    Ok(Some(png_bytes))
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
        let lower_ext = ext_key.to_ascii_lowercase();
        let cache_key = icon_cache_key_from_lower(&lower_ext, size);

        let cached = {
            let mut cache_guard = NATIVE_ICON_CACHE.lock().map_err(|e| e.to_string())?;
            if let Some(cache) = cache_guard.as_ref() {
                cache.get(&cache_key)
            } else {
                *cache_guard = Some(NativeIconCache::new());
                None
            }
        };
        if let Some(png_bytes) = cached {
            return Ok(Some(png_bytes.to_vec()));
        }

        // Drives and special folders use the real path so Windows resolves their
        // unique shell icons. Regular extensions use a dummy filename with
        // SHGFI_USEFILEATTRIBUTES for speed (no filesystem access).
        let is_real_path =
            lower_ext.contains('\\') || lower_ext.contains('/') || lower_ext.contains(':');
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
            (
                wide,
                FILE_ATTRIBUTE_DIRECTORY,
                SHGFI_ICON | SHGFI_USEFILEATTRIBUTES | size_flag,
            )
        } else {
            let name = format!("dummy.{}", ext_key.trim_start_matches('.'));
            let wide: Vec<u16> = OsStr::new(&name)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            (
                wide,
                FILE_ATTRIBUTE_NORMAL,
                SHGFI_ICON | SHGFI_USEFILEATTRIBUTES | size_flag,
            )
        };

        let Some(png_bytes) = (if is_real_path {
            fetch_real_path_icon_png_sta(query_name, attrs, flags)?
        } else {
            fetch_icon_png(&query_name, attrs, flags)?
        }) else {
            return Ok(None);
        };

        let shared: Arc<[u8]> = Arc::from(png_bytes.as_slice());

        {
            let mut cache_guard = NATIVE_ICON_CACHE.lock().map_err(|e| e.to_string())?;
            let cache = cache_guard.get_or_insert_with(NativeIconCache::new);
            cache.insert(cache_key, shared);
        }

        Ok(Some(png_bytes))
    }
}

#[cfg(test)]
#[path = "../tests/icons_tests.rs"]
mod tests;
