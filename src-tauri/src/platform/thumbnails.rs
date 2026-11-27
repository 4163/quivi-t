#[cfg(windows)]
use super::gdi::{self, ScopedComInit, ScopedHgdiobj, ScopedMemDc, ScopedScreenDc};
#[cfg(windows)]
use crate::formats::{gif_has_transparency, ico_has_alpha, png_has_alpha, tiff_has_alpha};
#[cfg(windows)]
use std::collections::VecDeque;
#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(windows)]
use std::io::Read;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::sync::{mpsc, Mutex, OnceLock};
#[cfg(windows)]
use std::time::{Duration, Instant};
#[cfg(windows)]
use windows::Win32::Foundation::{CloseHandle, HANDLE, SIZE, WAIT_OBJECT_0, WAIT_TIMEOUT};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, GdiFlush, GetDC, GetObjectW, SelectObject,
    BITMAP, DIB_RGB_COLORS, SRCCOPY,
};
#[cfg(windows)]
use windows::Win32::System::Threading::{CreateEventW, ResetEvent, SetEvent};
#[cfg(windows)]
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_THUMBNAILONLY,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, MsgWaitForMultipleObjectsEx, PeekMessageW, TranslateMessage, MSG,
    MWMO_INPUTAVAILABLE, PM_REMOVE, QS_ALLINPUT,
};

#[cfg(windows)]
const SHELL_THUMB_EXTS: &[&str] = &[
    "jpg", "jpeg", "jfif", "png", "bmp", "dib", "gif", "ico", "tif", "tiff", "mp4",
];

#[cfg(windows)]
const SHELL_THUMB_STA_WORKERS: usize = 2;

#[cfg(windows)]
const SHELL_THUMB_WORKER_IDLE_TIMEOUT: Duration = Duration::from_secs(15);

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
struct WinEvent(HANDLE);

// Win32 event handles are kernel objects safe to signal and wait on across threads.
#[cfg(windows)]
unsafe impl Send for WinEvent {}
#[cfg(windows)]
unsafe impl Sync for WinEvent {}

#[cfg(windows)]
impl Drop for WinEvent {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

#[cfg(windows)]
struct ShellThumbPoolState {
    queue: VecDeque<ShellThumbJob>,
    active_workers: usize,
    idle_workers: usize,
    next_worker_id: usize,
}

#[cfg(windows)]
struct ShellThumbPool {
    state: Mutex<ShellThumbPoolState>,
    wake_event: WinEvent,
}

#[cfg(windows)]
impl ShellThumbPool {
    fn new() -> Result<Self, String> {
        let handle = unsafe { CreateEventW(None, true, false, None) }
            .map_err(|e| format!("Failed to create shell thumbnail wake event: {e}"))?;
        Ok(Self {
            state: Mutex::new(ShellThumbPoolState {
                queue: VecDeque::new(),
                active_workers: 0,
                idle_workers: 0,
                next_worker_id: 0,
            }),
            wake_event: WinEvent(handle),
        })
    }

    fn set_event(&self) {
        unsafe {
            let _ = SetEvent(self.wake_event.0);
        }
    }

    fn reset_event(&self) {
        unsafe {
            let _ = ResetEvent(self.wake_event.0);
        }
    }

    fn submit(&'static self, job: ShellThumbJob) -> Result<(), String> {
        let spawn_id = {
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.queue.push_back(job);
            self.set_event();

            if state.queue.len() > state.idle_workers
                && state.active_workers < SHELL_THUMB_STA_WORKERS
            {
                state.active_workers += 1;
                let id = state.next_worker_id;
                state.next_worker_id = state.next_worker_id.wrapping_add(1);
                Some(id)
            } else {
                None
            }
        };

        if let Some(id) = spawn_id {
            let spawn_res = std::thread::Builder::new()
                .name(format!("shell-thumb-sta-{id}"))
                .spawn(move || run_shell_thumb_sta_worker(self));

            if let Err(err) = spawn_res {
                let err_msg = format!("Failed to spawn shell thumbnail STA worker: {err}");
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                state.active_workers = state.active_workers.saturating_sub(1);
                if state.active_workers == 0 {
                    let orphaned: Vec<_> = state.queue.drain(..).collect();
                    self.reset_event();
                    drop(state);
                    for queued in orphaned {
                        let _ = queued.reply.send(Err(err_msg.clone()));
                    }
                    return Err(err_msg);
                }
            }
        }

        Ok(())
    }
}

#[cfg(windows)]
struct WorkerSlotGuard {
    pool: &'static ShellThumbPool,
    active: bool,
    is_idle: bool,
}

#[cfg(windows)]
impl WorkerSlotGuard {
    fn new(pool: &'static ShellThumbPool) -> Self {
        Self {
            pool,
            active: true,
            is_idle: false,
        }
    }

    fn disarm(&mut self) {
        self.active = false;
        self.is_idle = false;
    }
}

#[cfg(windows)]
impl Drop for WorkerSlotGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let mut state = self.pool.state.lock().unwrap_or_else(|e| e.into_inner());
        if self.is_idle {
            state.idle_workers = state.idle_workers.saturating_sub(1);
        }
        state.active_workers = state.active_workers.saturating_sub(1);
        if state.active_workers == 0 && !state.queue.is_empty() {
            let orphaned: Vec<_> = state.queue.drain(..).collect();
            self.pool.reset_event();
            drop(state);
            for queued in orphaned {
                let _ = queued
                    .reply
                    .send(Err("Shell thumbnail STA worker terminated".to_string()));
            }
        }
    }
}

#[cfg(windows)]
fn pump_sta_messages() {
    let mut msg = MSG::default();
    unsafe {
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(windows)]
fn run_shell_thumb_sta_worker(pool: &'static ShellThumbPool) {
    let mut guard = WorkerSlotGuard::new(pool);
    let _com = match ScopedComInit::init_sta() {
        Ok(com) => com,
        Err(err) => {
            let err_msg = err.to_string();
            let mut state = pool.state.lock().unwrap_or_else(|e| e.into_inner());
            state.active_workers = state.active_workers.saturating_sub(1);
            guard.disarm();
            if state.active_workers == 0 && !state.queue.is_empty() {
                let orphaned: Vec<_> = state.queue.drain(..).collect();
                pool.reset_event();
                drop(state);
                for queued in orphaned {
                    let _ = queued.reply.send(Err(err_msg.clone()));
                }
            }
            return;
        }
    };

    loop {
        let next_job = {
            let mut state = pool.state.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(job) = state.queue.pop_front() {
                if state.queue.is_empty() {
                    pool.reset_event();
                }
                Some(job)
            } else {
                pool.reset_event();
                state.idle_workers += 1;
                guard.is_idle = true;
                None
            }
        };

        if let Some(job) = next_job {
            let result = extract_shell_thumbnail_pixels_sta(&job.path, job.size);
            let _ = job.reply.send(result);
            pump_sta_messages();
            continue;
        }

        let deadline = Instant::now() + SHELL_THUMB_WORKER_IDLE_TIMEOUT;
        let mut timed_out = false;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let wait_ms = remaining.as_millis().min(u32::MAX as u128) as u32;
            if wait_ms == 0 {
                timed_out = true;
                break;
            }
            let wait = unsafe {
                MsgWaitForMultipleObjectsEx(
                    Some(&[pool.wake_event.0]),
                    wait_ms,
                    QS_ALLINPUT,
                    MWMO_INPUTAVAILABLE,
                )
            };
            if wait == WAIT_OBJECT_0 {
                break;
            } else if wait.0 == WAIT_OBJECT_0.0 + 1 {
                pump_sta_messages();
            } else if wait == WAIT_TIMEOUT {
                timed_out = true;
                break;
            } else {
                timed_out = true;
                break;
            }
        }

        let should_exit = {
            let mut state = pool.state.lock().unwrap_or_else(|e| e.into_inner());
            state.idle_workers = state.idle_workers.saturating_sub(1);
            guard.is_idle = false;
            if timed_out && state.queue.is_empty() {
                state.active_workers = state.active_workers.saturating_sub(1);
                guard.disarm();
                true
            } else {
                false
            }
        };
        if should_exit {
            pump_sta_messages();
            break;
        }
    }
}

#[cfg(windows)]
fn shell_thumb_pool() -> Result<&'static ShellThumbPool, String> {
    static POOL: OnceLock<Result<ShellThumbPool, String>> = OnceLock::new();
    match POOL.get_or_init(ShellThumbPool::new) {
        Ok(pool) => Ok(pool),
        Err(err) => Err(err.clone()),
    }
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
    let got = unsafe {
        GetObjectW(
            hbitmap.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut std::ffi::c_void),
        )
    };
    if got == 0 || bmp.bmWidth <= 0 || bmp.bmHeight <= 0 {
        return Ok(None);
    }
    let (Ok(width), Ok(height)) = (u32::try_from(bmp.bmWidth), u32::try_from(bmp.bmHeight)) else {
        return Ok(None);
    };

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

    let blt_ok = unsafe {
        BitBlt(
            hdc_dst.0,
            0,
            0,
            width as i32,
            height as i32,
            Some(hdc_src.0),
            0,
            0,
            SRCCOPY,
        )
        .is_ok()
    };

    let pixels = if blt_ok {
        unsafe {
            let _ = GdiFlush();
            gdi::copy_bgra_to_rgba(bits_ptr as *const u8, width, height)
        }
    } else {
        None
    };

    unsafe {
        SelectObject(hdc_src.0, old_src);
        SelectObject(hdc_dst.0, old_dst);
    }

    let Some(pixels) = pixels else {
        return Ok(None);
    };

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
        shell_thumb_pool()?.submit(ShellThumbJob {
            path: path.to_string(),
            size,
            reply: reply_tx,
        })?;

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
