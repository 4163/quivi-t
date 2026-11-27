#[cfg(windows)]
use super::gdi::{self, ScopedComInit, ScopedHgdiobj, ScopedMemDc, ScopedScreenDc};
#[cfg(windows)]
use crate::formats::{gif_has_transparency, ico_has_alpha, png_has_alpha, tiff_has_alpha};
#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(windows)]
use std::io::Read;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::sync::{mpsc, Arc, Mutex, OnceLock};
#[cfg(windows)]
use windows::Win32::Foundation::SIZE;
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, GetDC, GetObjectW, SelectObject, BITMAP,
    DIB_RGB_COLORS, SRCCOPY,
};
#[cfg(windows)]
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_THUMBNAILONLY,
};

#[cfg(windows)]
const SHELL_THUMB_EXTS: &[&str] = &[
    "jpg", "jpeg", "jfif", "png", "bmp", "dib", "gif", "ico", "tif", "tiff", "mp4",
];

#[cfg(windows)]
const SHELL_THUMB_STA_WORKERS: usize = 2;

#[cfg(windows)]
const GIF_STACK_PROBE_BYTES: usize = 8192;

#[cfg(windows)]
const GIF_MAX_PROBE_BYTES: usize = 262_144;

#[cfg(windows)]
type ShellThumbPixels = Result<Option<(Vec<u8>, u32, u32)>, String>;

#[cfg(windows)]
struct ShellThumbJob {
    path: String,
    size: u32,
    reply: mpsc::SyncSender<ShellThumbPixels>,
}

#[cfg(windows)]
fn shell_thumb_pool() -> &'static mpsc::Sender<ShellThumbJob> {
    static POOL: OnceLock<mpsc::Sender<ShellThumbJob>> = OnceLock::new();
    POOL.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<ShellThumbJob>();
        let rx = Arc::new(Mutex::new(rx));
        for i in 0..SHELL_THUMB_STA_WORKERS {
            let rx = Arc::clone(&rx);
            let _ = std::thread::Builder::new()
                .name(format!("shell-thumb-sta-{i}"))
                .spawn(move || {
                    let com = ScopedComInit::init();
                    loop {
                        let job = {
                            let guard = rx.lock().unwrap_or_else(|e| e.into_inner());
                            guard.recv()
                        };
                        let Ok(job) = job else { break };
                        let result = match &com {
                            Ok(_) => extract_shell_thumbnail_pixels_sta(&job.path, job.size),
                            Err(e) => Err(e.clone()),
                        };
                        let _ = job.reply.send(result);
                    }
                });
        }
        tx
    })
}

#[cfg(windows)]
fn extract_shell_thumbnail_pixels_sta(path: &str, size: u32) -> ShellThumbPixels {
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
    let bmi = gdi::top_down_bgra_bitmap_info(width, height);
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

    let pixels = unsafe { gdi::copy_bgra_to_rgba(bits_ptr as *const u8, width, height) };

    unsafe {
        SelectObject(hdc_src.0, old_src);
        SelectObject(hdc_dst.0, old_dst);
    }

    Ok(Some((pixels, width, height)))
}

#[cfg(windows)]
fn is_animated_gif_file(path: &str) -> Option<bool> {
    let mut f = std::fs::File::open(path).ok()?;
    let file_len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut stack_buf = [0u8; GIF_STACK_PROBE_BYTES];
    let n = f.read(&mut stack_buf).unwrap_or(0);
    if crate::formats::check_animation_status(&stack_buf[..n]).is_animated {
        return Some(true);
    }
    if file_len > n as u64 {
        let cap = (file_len as usize).min(GIF_MAX_PROBE_BYTES);
        if cap > n {
            let mut heap_buf = Vec::with_capacity(cap);
            heap_buf.extend_from_slice(&stack_buf[..n]);
            let _ = f.take((cap - n) as u64).read_to_end(&mut heap_buf);
            return Some(crate::formats::check_animation_status(&heap_buf).is_animated);
        }
    }
    Some(false)
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

        let Some(ext_str) = ext.as_deref() else {
            return Ok(None);
        };
        if !SHELL_THUMB_EXTS.contains(&ext_str) {
            return Ok(None);
        }

        // Animated GIFs: skip Shell extraction (static first-frame only).
        // The frontend falls back to asset:// which plays animation natively.
        if ext_str == "gif" {
            match is_animated_gif_file(path) {
                None | Some(true) => return Ok(None),
                Some(false) => {}
            }
        }

        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        shell_thumb_pool()
            .send(ShellThumbJob {
                path: path.to_string(),
                size,
                reply: reply_tx,
            })
            .map_err(|_| "Shell thumbnail worker pool closed".to_string())?;

        let Some((pixels, width, height)) = reply_rx
            .recv()
            .map_err(|_| "Shell thumbnail worker dropped reply".to_string())??
        else {
            return Ok(None);
        };

        // Detect black matte: the Shell sometimes composites transparent
        // sources onto a black background, producing a fully opaque thumbnail
        // with black where transparency was. Check in-memory alpha and border
        // pixels before opening the source file on disk.
        if should_reject_black_matte(&pixels, width, height, || {
            source_has_transparency(path, ext_str)
        }) {
            return Ok(None);
        }

        let png_bytes = gdi::encode_rgba_png_fast(&pixels, width, height)?;
        Ok(Some(png_bytes))
    }
}

/// Returns true if the thumbnail is an opaque black-matte composite of a
/// transparent source image. Evaluates in-memory alpha and border pixels
/// before invoking `source_has_alpha` so non-matte or already-transparent
/// thumbnails avoid disk I/O.
#[cfg(windows)]
fn should_reject_black_matte<F>(
    pixels: &[u8],
    width: u32,
    height: u32,
    source_has_alpha: F,
) -> bool
where
    F: FnOnce() -> bool,
{
    let has_alpha = pixels.chunks_exact(4).any(|px| px[3] < 255);
    if has_alpha || !has_black_matte_border(pixels, width, height) {
        return false;
    }
    source_has_alpha()
}

/// Samples the outer pixel ring of the thumbnail for pure-black pixels.
/// A genuine black matte produces solid black (0,0,0) at edges where
/// transparency was composited. Returns true when >40% of border pixels
/// are pure black, which reliably separates mattes from naturally opaque
/// images (manga pages, photos) that have colored or white edges.
#[cfg(windows)]
fn has_black_matte_border(pixels: &[u8], width: u32, height: u32) -> bool {
    if width < 2 || height < 2 {
        return false;
    }
    let w = width as usize;
    let h = height as usize;
    let stride = w * 4;
    let mut black = 0u32;
    let mut total = 0u32;

    // Top and bottom rows
    for x in 0..w {
        for &y in &[0, h - 1] {
            let off = y * stride + x * 4;
            total += 1;
            if pixels[off] == 0 && pixels[off + 1] == 0 && pixels[off + 2] == 0 {
                black += 1;
            }
        }
    }
    // Left and right columns (skip corners already counted)
    for y in 1..h - 1 {
        for &x in &[0, w - 1] {
            let off = y * stride + x * 4;
            total += 1;
            if pixels[off] == 0 && pixels[off + 1] == 0 && pixels[off + 2] == 0 {
                black += 1;
            }
        }
    }

    total > 0 && black * 100 / total > 40
}

/// Returns true if the source image file contains transparency data.
/// Reads only the first 1024 bytes (header) to avoid full-file I/O.
#[cfg(windows)]
fn source_has_transparency(path: &str, ext: &str) -> bool {
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut hdr = [0u8; 1024];
    let n = f.read(&mut hdr).unwrap_or(0);
    let hdr = &hdr[..n];

    match ext {
        "png" => png_has_alpha(hdr),
        "gif" => gif_has_transparency(hdr),
        "ico" => ico_has_alpha(hdr),
        "tif" | "tiff" => tiff_has_alpha(hdr),
        _ => false,
    }
}

#[cfg(test)]
#[path = "../tests/thumbnails_tests.rs"]
mod tests;
