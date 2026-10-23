use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

use windows::{
    core::{implement, Error, IUnknown, Interface, Result, BOOL, GUID, PCWSTR},
    Win32::{
        Foundation::{
            CLASS_E_NOAGGREGATION, COLORREF, E_NOINTERFACE, E_NOTIMPL, E_POINTER, HINSTANCE, HWND,
            LPARAM, LRESULT, POINT, RECT, WPARAM,
        },
        Graphics::Gdi::{
            BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontIndirectW,
            CreatePen, CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect,
            GetDC, InvalidateRect, Polyline, ReleaseDC, SelectObject, SetBkMode, SetTextColor,
            DT_CENTER, DT_END_ELLIPSIS, DT_LEFT, DT_SINGLELINE, DT_VCENTER, HFONT, HGDIOBJ,
            LOGFONTW, PAINTSTRUCT, PS_SOLID, SRCCOPY, TRANSPARENT,
        },
        Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL},
        System::{
            Com::{
                CoInitializeEx, CoRegisterClassObject, CoRevokeClassObject, CoTaskMemFree,
                CoUninitialize, IClassFactory, IClassFactory_Impl, CLSCTX_LOCAL_SERVER,
                COINIT_APARTMENTTHREADED, REGCLS_MULTIPLEUSE,
            },
            LibraryLoader::GetModuleHandleW,
            Ole::{IObjectWithSite, IObjectWithSite_Impl, IOleWindow, IOleWindow_Impl},
            Threading::GetCurrentThreadId,
        },
        UI::{
            Controls::IImageList,
            Input::KeyboardAndMouse::{GetFocus, ReleaseCapture, SetCapture, SetFocus},
            Shell::{
                IInitializeWithItem, IInitializeWithItem_Impl, IPreviewHandler,
                IPreviewHandlerFrame, IPreviewHandlerVisuals, IPreviewHandlerVisuals_Impl,
                IPreviewHandler_Impl, PropertiesSystem::IInitializeWithFile,
                PropertiesSystem::IInitializeWithFile_Impl, SHGetFileInfoW, SHGetImageList,
                SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON, SHGFI_SYSICONINDEX,
                SHGFI_USEFILEATTRIBUTES, SIGDN_FILESYSPATH,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyWindow, DispatchMessageW,
                DrawIconEx, GetClientRect, GetMessageW, GetWindowLongPtrW, KillTimer, LoadCursorW,
                LoadImageW, MoveWindow, PostMessageW, PostQuitMessage, RegisterClassW, SetCursor,
                SetParent, SetTimer, SetWindowLongPtrW, TranslateMessage, CREATESTRUCTW,
                CS_DBLCLKS, DI_NORMAL, GWLP_USERDATA, HICON, HWND_MESSAGE, IDC_ARROW, IMAGE_ICON,
                LR_LOADFROMFILE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_CAPTURECHANGED,
                WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP,
                WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_NCCREATE, WM_PAINT, WM_SETCURSOR, WM_SIZE,
                WM_TIMER, WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS, WS_VISIBLE,
            },
        },
    },
};
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

use super::{
    image_pane::{ImagePane, MediaKind},
    PREVIEW_HANDLER_CLSID,
};

const PREVIEW_CLASS_NAME: &[u16] = &[
    81, 117, 105, 118, 105, 84, 80, 114, 101, 118, 105, 101, 119, 80, 97, 110, 101, 0,
];
const HEADER_HEIGHT: i32 = 150;
const ROW_HEIGHT: i32 = 24;
const MARGIN_LEFT: i32 = 8;
const INDENT_WIDTH: i32 = 16;
const CHEVRON_WIDTH: i32 = 16;
const ICON_SIZE: i32 = 16;
const LARGE_ICON_SIZE: i32 = 96;
const ICON_TEXT_GAP: i32 = 6;
const SCROLLBAR_WIDTH: i32 = 12;
const ARROW_BUTTON_HEIGHT: i32 = 14;
const WM_MOUSELEAVE: u32 = 0x02A3;
const TME_LEAVE: u32 = 0x00000002;

#[repr(C)]
struct TRACKMOUSEEVENT {
    cb_size: u32,
    flags: u32,
    hwnd_track: HWND,
    hover_time: u32,
}

extern "system" {
    fn TrackMouseEvent(lp_event_track: *mut TRACKMOUSEEVENT) -> i32;
}

static ACTIVE_HANDLERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static SERVER_LOCKS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static PREVIEW_CLASS_REGISTERED: OnceLock<()> = OnceLock::new();
static PAINT_LOGGED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static PUMP_WINDOW: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
static QUIT_REQUESTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
// Idle shutdown keeps one warm server while the user browses archives, so
// only the first preview pays process startup. All timer state changes run
// on the pump thread, which keeps arming race-free.
const IDLE_TIMER_ID: usize = 1;
const IDLE_QUIT_MS: u32 = 30_000;
const WM_APP_ARM_IDLE: u32 = 0x8000;
const WM_APP_DISARM_IDLE: u32 = 0x8001;
const WM_APP_PREVIEW_DONE: u32 = 0x8002;
// Deferred host work. COM entry points only record intent and return, so the
// host thread never blocks on cross-process window calls. The pump performs
// the work serially when no host call is in flight.
const WM_APP_TASK: u32 = 0x8003;
const TASK_CREATE: usize = 1;
const TASK_POSITION: usize = 2;
const TASK_TEARDOWN: usize = 3;
const TASK_BACKGROUND: usize = 4;
const TASK_FOCUS: usize = 5;
// The private window receives timers even inside WebView2's nested pump.
static IDLE_TIMER_ACTUAL: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn preview_log(event: &str) {
    let mut path = std::env::temp_dir();
    path.push("QuiviT-preview.log");
    let line = format!(
        "[{} pid={} tid={}] {}\n",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        std::process::id(),
        unsafe { GetCurrentThreadId() },
        event
    );
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = file.write_all(line.as_bytes());
    }
}

pub(super) fn log_event(event: &str) {
    preview_log(event);
}

fn lock_state(state: &Arc<Mutex<PreviewState>>) -> std::sync::MutexGuard<'_, PreviewState> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn run() -> Result<()> {
    preview_log("server start");
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()? };
    let result = run_initialized();
    unsafe { CoUninitialize() };
    result
}

fn run_initialized() -> Result<()> {
    let pump = unsafe {
        let instance = HINSTANCE(GetModuleHandleW(None)?.0);
        let class = WNDCLASSW {
            lpfnWndProc: Some(pump_proc),
            hInstance: instance,
            lpszClassName: windows::core::w!("QuiviTPreviewPump"),
            ..Default::default()
        };
        if RegisterClassW(&class) == 0 {
            return Err(Error::from_thread());
        }
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class.lpszClassName,
            windows::core::w!(""),
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(instance),
            None,
        )?
    };
    PUMP_WINDOW.store(pump.0 as isize, std::sync::atomic::Ordering::Release);
    let result = run_pump();
    PUMP_WINDOW.store(0, std::sync::atomic::Ordering::Release);
    unsafe {
        let _ = DestroyWindow(pump);
    }
    result
}

fn run_pump() -> Result<()> {
    let factory: IClassFactory = PreviewClassFactory.into();
    let cookie = unsafe {
        CoRegisterClassObject(
            &PREVIEW_HANDLER_CLSID,
            &factory,
            CLSCTX_LOCAL_SERVER,
            REGCLS_MULTIPLEUSE,
        )?
    };
    preview_log("server registered");
    let image_cookie = match unsafe {
        CoRegisterClassObject(
            &GUID::from_u128(super::super::contract::IMAGE_PREVIEW_CLSID),
            &factory,
            CLSCTX_LOCAL_SERVER,
            REGCLS_MULTIPLEUSE,
        )
    } {
        Ok(cookie) => cookie,
        Err(error) => {
            unsafe {
                let _ = CoRevokeClassObject(cookie);
            }
            return Err(error);
        }
    };
    arm_idle_timeout();
    unsafe {
        let mut message = MSG::default();
        let result = loop {
            if QUIT_REQUESTED.load(std::sync::atomic::Ordering::Acquire) {
                break Ok(());
            }
            match GetMessageW(&mut message, None, 0, 0).0 {
                -1 => break Err(Error::from_thread()),
                0 => break Ok(()),
                _ => {}
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        };
        preview_log("server message loop exit");
        CoRevokeClassObject(cookie)?;
        CoRevokeClassObject(image_cookie)?;
        result
    }
}

unsafe extern "system" fn pump_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    use std::sync::atomic::Ordering;
    match message {
        WM_APP_ARM_IDLE => {
            let previous = IDLE_TIMER_ACTUAL.swap(0, Ordering::Relaxed);
            if previous != 0 {
                let _ = KillTimer(Some(hwnd), previous);
            }
            let timer = SetTimer(Some(hwnd), IDLE_TIMER_ID, IDLE_QUIT_MS, None);
            IDLE_TIMER_ACTUAL.store(timer, Ordering::Relaxed);
            if timer == 0 {
                preview_log("server idle timer failed");
            }
        }
        WM_APP_DISARM_IDLE => {
            let previous = IDLE_TIMER_ACTUAL.swap(0, Ordering::Relaxed);
            if previous != 0 {
                let _ = KillTimer(Some(hwnd), previous);
            }
        }
        WM_TIMER => {
            if wparam.0 == IDLE_TIMER_ACTUAL.load(Ordering::Relaxed)
                && ACTIVE_HANDLERS.load(Ordering::Relaxed) == 0
                && SERVER_LOCKS.load(Ordering::Relaxed) == 0
            {
                preview_log("server idle timeout");
                QUIT_REQUESTED.store(true, Ordering::Release);
                PostQuitMessage(0);
            }
        }
        WM_APP_TASK => {
            let task = Box::from_raw(lparam.0 as *mut PumpTask);
            match wparam.0 {
                TASK_CREATE => pump_create(&task.state),
                TASK_POSITION => pump_position(&task.state),
                TASK_TEARDOWN => pump_teardown(&task.state, task.epoch),
                TASK_BACKGROUND => pump_background(&task.state),
                TASK_FOCUS => pump_focus(&task.state),
                _ => {}
            }
        }
        _ => return DefWindowProcW(hwnd, message, wparam, lparam),
    }
    LRESULT(0)
}

#[implement(IClassFactory)]
struct PreviewClassFactory;

impl IClassFactory_Impl for PreviewClassFactory_Impl {
    fn CreateInstance(
        &self,
        outer: windows::core::Ref<IUnknown>,
        riid: *const GUID,
        result: *mut *mut core::ffi::c_void,
    ) -> Result<()> {
        if !outer.is_null() {
            preview_log("CreateInstance rejected aggregation");
            return Err(Error::from(CLASS_E_NOAGGREGATION));
        }
        if riid.is_null() || result.is_null() {
            return Err(Error::from(E_POINTER));
        }
        unsafe {
            *result = std::ptr::null_mut();
        }
        ACTIVE_HANDLERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        disarm_idle_timeout();
        let preview: IUnknown = PreviewHandler {
            state: Arc::new(Mutex::new(PreviewState::default())),
        }
        .into();
        let queried = unsafe { preview.query(riid, result) };
        if queried.is_err() {
            preview_log("CreateInstance QueryInterface failed");
        } else {
            preview_log("CreateInstance ok");
        }
        queried.ok()
    }

    fn LockServer(&self, lock: BOOL) -> Result<()> {
        use std::sync::atomic::Ordering;
        if lock.as_bool() {
            SERVER_LOCKS.fetch_add(1, Ordering::Relaxed);
            disarm_idle_timeout();
        } else if SERVER_LOCKS
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                count.checked_sub(1)
            })
            .is_ok_and(|old| old == 1)
            && ACTIVE_HANDLERS.load(Ordering::Relaxed) == 0
        {
            arm_idle_timeout();
        }
        Ok(())
    }
}

#[derive(Default)]
struct PreviewState {
    file_path: Option<PathBuf>,
    display_name: Option<String>,
    parent: HWND,
    rect: RECT,
    site: Option<IPreviewHandlerFrame>,
    pane: Option<Box<PreviewPane>>,
    image_pane: Option<ImagePane>,
    background: Option<COLORREF>,
    custom_font: Option<LOGFONTW>,
    custom_text_color: Option<COLORREF>,
    pending_preview: Option<PreviewParams>,
    epoch: u64,
    applied_parent: HWND,
    applied_rect: RECT,
}

// Everything a deferred preview build needs. Recorded synchronously in
// DoPreview so the host call returns immediately; the pump consumes it.
// The file path is provided via IInitializeWithItem or IInitializeWithFile.
enum Materialized {
    List(PathBuf),
    Image(PathBuf, MediaKind),
    NotArchive,
}

struct PreviewParams {
    materialized: Materialized,
    theme: Theme,
    epoch: u64,
    custom_font: Option<LOGFONTW>,
    display_name: String,
}

static PREVIEW_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// One in-flight listing per child window. The worker stores its result here
// and wakes the pump; a newer preview for a recycled window handle can never
// apply a stale result because epochs mismatch.
struct PreviewJob {
    epoch: u64,
    result: Option<PreviewContent>,
}

static PREVIEW_JOBS: OnceLock<Mutex<HashMap<isize, Arc<Mutex<PreviewJob>>>>> = OnceLock::new();

fn preview_jobs() -> &'static Mutex<HashMap<isize, Arc<Mutex<PreviewJob>>>> {
    PREVIEW_JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_job(hwnd: HWND, job: Arc<Mutex<PreviewJob>>) {
    if let Ok(mut jobs) = preview_jobs().lock() {
        jobs.insert(hwnd.0 as isize, job);
    }
}

fn unregister_job(hwnd: HWND) {
    if let Ok(mut jobs) = preview_jobs().lock() {
        jobs.remove(&(hwnd.0 as isize));
    }
}

/// Each posted task owns its state reference until the pump consumes it.
struct PumpTask {
    state: Arc<Mutex<PreviewState>>,
    epoch: Option<u64>,
}

fn post_task(state: &Arc<Mutex<PreviewState>>, kind: usize) {
    post_task_for_epoch(state, kind, None);
}

fn post_task_for_epoch(state: &Arc<Mutex<PreviewState>>, kind: usize, epoch: Option<u64>) {
    let Some(hwnd) = pump_window() else {
        return;
    };
    let ptr = Box::into_raw(Box::new(PumpTask {
        state: state.clone(),
        epoch,
    }));
    let posted =
        unsafe { PostMessageW(Some(hwnd), WM_APP_TASK, WPARAM(kind), LPARAM(ptr as isize)) };
    if posted.is_err() {
        drop(unsafe { Box::from_raw(ptr) });
    }
}

#[implement(
    IPreviewHandler,
    IPreviewHandlerVisuals,
    IObjectWithSite,
    IOleWindow,
    IInitializeWithFile,
    IInitializeWithItem
)]
struct PreviewHandler {
    state: Arc<Mutex<PreviewState>>,
}

impl Drop for PreviewHandler {
    fn drop(&mut self) {
        // Window and controller ownership must end on the pump thread.
        post_task(&self.state, TASK_TEARDOWN);
        let remaining = ACTIVE_HANDLERS.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        preview_log(&format!(
            "handler drop remaining={}",
            remaining.saturating_sub(1)
        ));
        if remaining == 1 {
            arm_idle_timeout();
        }
    }
}

fn pump_window() -> Option<HWND> {
    let value = PUMP_WINDOW.load(std::sync::atomic::Ordering::Acquire);
    (value != 0).then_some(HWND(value as _))
}

fn arm_idle_timeout() {
    if let Some(hwnd) = pump_window() {
        let posted = unsafe { PostMessageW(Some(hwnd), WM_APP_ARM_IDLE, WPARAM(0), LPARAM(0)) };
        preview_log(&format!("arm post ok={}", posted.is_ok()));
    }
}

fn disarm_idle_timeout() {
    if let Some(hwnd) = pump_window() {
        unsafe {
            let _ = PostMessageW(Some(hwnd), WM_APP_DISARM_IDLE, WPARAM(0), LPARAM(0));
        }
    }
}

impl IInitializeWithFile_Impl for PreviewHandler_Impl {
    fn Initialize(&self, file_path: &PCWSTR, _mode: u32) -> Result<()> {
        let path = unsafe { file_path.to_string() }
            .map(PathBuf::from)
            .map_err(|error| {
                Error::new(
                    E_NOINTERFACE,
                    format!("Preview path is not readable: {error}"),
                )
            })?;
        preview_log(&format!("Initialize file path={}", path.display()));
        let mut state = self.state.lock().unwrap();
        state.display_name = path.file_name().map(|n| n.to_string_lossy().into_owned());
        state.file_path = Some(path);
        Ok(())
    }
}

impl IInitializeWithItem_Impl for PreviewHandler_Impl {
    fn Initialize(
        &self,
        item: windows::core::Ref<windows::Win32::UI::Shell::IShellItem>,
        _mode: u32,
    ) -> Result<()> {
        let shell_item = (*item).as_ref().ok_or_else(|| Error::from(E_NOINTERFACE))?;
        let display = unsafe { shell_item.GetDisplayName(SIGDN_FILESYSPATH)? };
        let path = unsafe { display.to_string() };
        unsafe { CoTaskMemFree(Some(display.0.cast())) };
        let path = path
            .map_err(|error| {
                Error::new(
                    E_NOINTERFACE,
                    format!("Preview path is not readable: {error}"),
                )
            })
            .map(PathBuf::from)?;
        preview_log(&format!("Initialize item path={}", path.display()));
        let mut state = self.state.lock().unwrap();
        state.display_name = path.file_name().map(|n| n.to_string_lossy().into_owned());
        state.file_path = Some(path);
        Ok(())
    }
}

impl IObjectWithSite_Impl for PreviewHandler_Impl {
    fn SetSite(&self, site: windows::core::Ref<IUnknown>) -> Result<()> {
        self.state.lock().unwrap().site = (*site).as_ref().and_then(|value| value.cast().ok());
        Ok(())
    }

    fn GetSite(&self, _riid: *const GUID, _site: *mut *mut core::ffi::c_void) -> Result<()> {
        Err(Error::from(E_NOINTERFACE))
    }
}

impl IOleWindow_Impl for PreviewHandler_Impl {
    fn GetWindow(&self) -> Result<HWND> {
        Ok(self.state.lock().unwrap().parent)
    }

    fn ContextSensitiveHelp(&self, _enter_mode: BOOL) -> Result<()> {
        Err(Error::from(E_NOTIMPL))
    }
}

impl IPreviewHandlerVisuals_Impl for PreviewHandler_Impl {
    fn SetBackgroundColor(&self, color: COLORREF) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        state.background = Some(color);
        drop(state);
        post_task(&self.state, TASK_BACKGROUND);
        Ok(())
    }

    fn SetFont(&self, font: *const windows::Win32::Graphics::Gdi::LOGFONTW) -> Result<()> {
        let lf = unsafe { font.as_ref() }.copied();
        let mut state = lock_state(&self.state);
        state.custom_font = lf;
        if let Some(pane) = state.pane.as_mut() {
            pane.update_font(lf);
            let _ = unsafe { InvalidateRect(Some(pane.hwnd), None, false) };
        }
        Ok(())
    }

    fn SetTextColor(&self, color: COLORREF) -> Result<()> {
        let mut state = lock_state(&self.state);
        state.custom_text_color = Some(color);
        drop(state);
        post_task(&self.state, TASK_BACKGROUND);
        Ok(())
    }
}

impl IPreviewHandler_Impl for PreviewHandler_Impl {
    fn SetWindow(&self, parent: HWND, rect: *const RECT) -> Result<()> {
        let has_pane = {
            let mut state = lock_state(&self.state);
            state.parent = parent;
            if let Some(rect) = unsafe { rect.as_ref() } {
                state.rect = *rect;
            }
            preview_log(&format!(
                "SetWindow parent={:?} rect=({},{},{},{}) has_pane={}",
                state.parent.0,
                state.rect.left,
                state.rect.top,
                state.rect.right,
                state.rect.bottom,
                state.pane.is_some() || state.image_pane.is_some()
            ));
            state.pane.is_some() || state.image_pane.is_some()
        };
        // Window moves happen on the pump, outside the host call, so the
        // host thread never blocks on cross-process window messages.
        if has_pane {
            post_task(&self.state, TASK_POSITION);
        }
        Ok(())
    }

    fn SetRect(&self, rect: *const RECT) -> Result<()> {
        let has_pane = {
            let mut state = lock_state(&self.state);
            if let Some(rect) = unsafe { rect.as_ref() } {
                state.rect = *rect;
            }
            preview_log(&format!(
                "SetRect rect=({},{},{},{}) has_pane={}",
                state.rect.left,
                state.rect.top,
                state.rect.right,
                state.rect.bottom,
                state.pane.is_some() || state.image_pane.is_some()
            ));
            state.pane.is_some() || state.image_pane.is_some()
        };
        if has_pane {
            post_task(&self.state, TASK_POSITION);
        }
        Ok(())
    }

    fn DoPreview(&self) -> Result<()> {
        // Record the source here; archive validation and image I/O run on workers.
        let (file_path, theme, custom_font, state_display_name) = {
            let state = lock_state(&self.state);
            if state.file_path.is_none() {
                preview_log("DoPreview no source");
                return Err(Error::new(
                    E_NOINTERFACE,
                    "Explorer did not provide a preview file path.",
                ));
            }
            (
                state.file_path.clone(),
                Theme::for_preview(state.background, state.custom_text_color),
                state.custom_font,
                state.display_name.clone(),
            )
        };
        let display_name = state_display_name.unwrap_or_else(|| {
            file_path
                .as_ref()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Archive".into())
        });
        let materialized = file_path
            .as_deref()
            .map(preview_source)
            .unwrap_or(Materialized::NotArchive);
        {
            let mut state = lock_state(&self.state);
            let epoch = PREVIEW_EPOCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            state.epoch = epoch;
            if let Some(pane) = state.image_pane.as_ref() {
                pane.cancel();
            }
            state.pending_preview = Some(PreviewParams {
                materialized,
                theme,
                epoch,
                custom_font,
                display_name,
            });
            preview_log("DoPreview posted");
        }
        post_task(&self.state, TASK_CREATE);
        Ok(())
    }

    fn Unload(&self) -> Result<()> {
        preview_log("Unload");
        let epoch = {
            let mut state = lock_state(&self.state);
            state.epoch = PREVIEW_EPOCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            state.pending_preview = None;
            state.file_path = None;
            state.display_name = None;
            state.site = None;
            if let Some(pane) = state.image_pane.as_ref() {
                pane.cancel();
            }
            state.epoch
        };
        post_task_for_epoch(&self.state, TASK_TEARDOWN, Some(epoch));
        Ok(())
    }

    fn SetFocus(&self) -> Result<()> {
        post_task(&self.state, TASK_FOCUS);
        Ok(())
    }

    fn QueryFocus(&self) -> Result<HWND> {
        unsafe { Ok(GetFocus()) }
    }

    fn TranslateAccelerator(&self, _message: *const MSG) -> Result<()> {
        let site = lock_state(&self.state).site.clone();
        if let Some(site) = site.as_ref() {
            unsafe { return site.TranslateAccelerator(_message) };
        }
        Ok(())
    }
}

fn pump_focus(state: &Arc<Mutex<PreviewState>>) {
    let hwnd = {
        let state = lock_state(state);
        if let Some(pane) = state.image_pane.as_ref() {
            pane.focus();
            return;
        }
        if let Some(pane) = state.pane.as_ref() {
            pane.hwnd
        } else {
            return;
        }
    };
    if !hwnd.0.is_null() {
        unsafe {
            let _ = SetFocus(Some(hwnd));
        }
    }
}

fn pump_background(state: &Arc<Mutex<PreviewState>>) {
    let mut state = lock_state(state);
    let theme = Theme::for_preview(state.background, state.custom_text_color);
    if let Some(pane) = state.pane.as_mut() {
        pane.theme = theme;
        let _ = unsafe { InvalidateRect(Some(pane.hwnd), None, false) };
    }
    if let Some(pane) = state.image_pane.as_mut() {
        pane.set_background(theme.surface);
    }
}

fn destroy_pane(state: &Arc<Mutex<PreviewState>>) {
    let (image, archive) = {
        let mut state = lock_state(state);
        (state.image_pane.take(), state.pane.take())
    };
    drop(image);
    if let Some(pane) = archive {
        unregister_job(pane.hwnd);
        if !pane.hwnd.0.is_null() {
            let _ = unsafe { DestroyWindow(pane.hwnd) };
        }
        drop(pane);
    }
}

fn resize_child(hwnd: HWND, rect: RECT) -> Result<()> {
    unsafe {
        MoveWindow(
            hwnd,
            rect.left,
            rect.top,
            (rect.right - rect.left).max(0),
            (rect.bottom - rect.top).max(0),
            true,
        )?;
    }
    Ok(())
}

fn rect_equal(a: RECT, b: RECT) -> bool {
    a.left == b.left && a.top == b.top && a.right == b.right && a.bottom == b.bottom
}

/// Builds the preview on the pump thread, outside any host call. Runs after
/// DoPreview recorded its params, so cross-process window calls can never
/// stall the host.
fn pump_create(state: &Arc<Mutex<PreviewState>>) {
    let params = {
        let mut guard = lock_state(state);
        guard.pending_preview.take()
    };
    let Some(params) = params else {
        return;
    };
    destroy_pane(state);
    if lock_state(state).epoch != params.epoch {
        return;
    }

    if let Materialized::Image(path, kind) = &params.materialized {
        let (parent, area) = {
            let guard = lock_state(state);
            (guard.parent, guard.rect)
        };
        match ImagePane::create(parent, area, path.clone(), *kind, params.theme.surface) {
            Ok(pane) => {
                let mut guard = lock_state(state);
                if guard.epoch != params.epoch {
                    drop(guard);
                    drop(pane);
                    return;
                }
                guard.image_pane = Some(pane);
                guard.applied_parent = parent;
                guard.applied_rect = area;
            }
            Err(error) => preview_log(&format!("image preview child failed: {error}")),
        }
        pump_background(state);
        pump_position(state);
        return;
    }

    let mut pane = Box::new(PreviewPane::loading(
        params.theme,
        params.epoch,
        params.custom_font,
        params.display_name.clone(),
    ));
    let worker_input = match params.materialized {
        Materialized::Image(_, _) => unreachable!(),
        Materialized::List(path) => Some(path),
        Materialized::NotArchive => {
            pane.content = PreviewContent::Message(
                "This preview is available only for QuiviT archive types. Open this file in QuiviT."
                    .into(),
            );
            None
        }
    };
    let (parent, area) = {
        let guard = lock_state(state);
        (guard.parent, guard.rect)
    };
    let hwnd = match create_preview_child(parent, area, pane.as_mut()) {
        Ok(hwnd) => hwnd,
        Err(error) => {
            preview_log(&format!("preview create child failed: {error}"));
            return;
        }
    };
    pane.hwnd = hwnd;
    if lock_state(state).epoch != params.epoch {
        let _ = unsafe { DestroyWindow(hwnd) };
        return;
    }
    paint_now(hwnd, &mut pane);
    let job = Arc::new(Mutex::new(PreviewJob {
        epoch: params.epoch,
        result: None,
    }));
    register_job(hwnd, job.clone());
    {
        let mut guard = lock_state(state);
        guard.applied_parent = parent;
        guard.applied_rect = area;
        guard.pane = Some(pane);
    }
    pump_background(state);
    // A SetRect can land while the child is being built; reconcile once so
    // the pane never sticks at a stale zero size.
    pump_position(state);
    if let Some(path) = worker_input {
        preview_log(&format!("preview worker spawn path={}", path.display()));
        spawn_preview_worker(
            path,
            params.epoch,
            params.display_name,
            job,
            hwnd.0 as isize,
        );
    } else {
        preview_log("preview worker skipped (message pane)");
    }
}

/// Repositions the live child on the pump thread. Skips work the host
/// already has.
fn pump_position(state: &Arc<Mutex<PreviewState>>) {
    let (hwnd, parent, area, move_needed) = {
        let mut guard = lock_state(state);
        let Some(hwnd) = guard
            .pane
            .as_ref()
            .map(|pane| pane.hwnd)
            .or_else(|| guard.image_pane.as_ref().map(ImagePane::hwnd))
        else {
            return;
        };
        let changed =
            guard.parent.0 != guard.applied_parent.0 || !rect_equal(guard.rect, guard.applied_rect);
        if changed {
            guard.applied_parent = guard.parent;
            guard.applied_rect = guard.rect;
        }
        (hwnd, guard.parent, guard.rect, changed)
    };
    if !move_needed || hwnd.0.is_null() {
        return;
    }
    unsafe {
        SetParent(hwnd, Some(parent)).ok();
    }
    if resize_child(hwnd, area).is_ok() {
        repaint_now(state, hwnd);
    }
}

/// Tears the preview down on the pump thread.
fn pump_teardown(state: &Arc<Mutex<PreviewState>>, epoch: Option<u64>) {
    {
        let mut guard = lock_state(state);
        if epoch.is_some_and(|epoch| epoch != guard.epoch) {
            return;
        }
        guard.pending_preview = None;
    }
    destroy_pane(state);
}

fn preview_source(path: &Path) -> Materialized {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(crate::formats::is_archive_ext)
    {
        return Materialized::List(path.to_path_buf());
    }
    MediaKind::for_path(path)
        .map(|kind| Materialized::Image(path.to_path_buf(), kind))
        .unwrap_or(Materialized::NotArchive)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScrollbarPart {
    UpArrow,
    DownArrow,
    Thumb,
    Track,
}

#[derive(Clone, Copy)]
struct Theme {
    surface: COLORREF,
    border: COLORREF,
    text: COLORREF,
    muted: COLORREF,
    selected: COLORREF,
    selected_border: COLORREF,
    hover: COLORREF,
    hover_border: COLORREF,
    chevron: COLORREF,
    scrollbar_thumb: COLORREF,
    scrollbar_hover: COLORREF,
    scrollbar_active: COLORREF,
    scrollbar_btn_hover: COLORREF,
}

impl Theme {
    fn for_preview(background: Option<COLORREF>, text: Option<COLORREF>) -> Self {
        let background = background.unwrap_or(color(255, 255, 255));
        // Explorer can supply a white host background even in dark app mode.
        let dark = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
            .and_then(|key| key.get_value::<u32, _>("AppsUseLightTheme"))
            .map(|light| light == 0)
            .unwrap_or_else(|_| is_dark_color(background));
        let mut theme = Self::from_dark(dark || is_dark_color(background));
        if !dark {
            theme.surface = background;
        }
        if let Some(text) = text.filter(|text| is_dark_color(*text) != is_dark_color(theme.surface)) {
            theme.text = text;
        }
        theme
    }

    fn from_dark(dark: bool) -> Self {
        if dark {
            Self {
                surface: color(32, 32, 32),
                border: color(50, 50, 50),
                text: color(240, 240, 240),
                muted: color(150, 150, 150),
                selected: color(38, 50, 66),
                selected_border: color(65, 85, 115),
                hover: color(45, 48, 52),
                hover_border: color(60, 64, 70),
                chevron: color(160, 160, 160),
                scrollbar_thumb: color(85, 85, 85),
                scrollbar_hover: color(110, 110, 110),
                scrollbar_active: color(140, 140, 140),
                scrollbar_btn_hover: color(56, 56, 56),
            }
        } else {
            Self {
                surface: color(255, 255, 255),
                border: color(229, 229, 229),
                text: color(26, 26, 26),
                muted: color(112, 112, 112),
                selected: color(204, 232, 255),
                selected_border: color(153, 209, 255),
                hover: color(232, 243, 253),
                hover_border: color(205, 228, 247),
                chevron: color(112, 112, 112),
                scrollbar_thumb: color(195, 195, 195),
                scrollbar_hover: color(165, 165, 165),
                scrollbar_active: color(135, 135, 135),
                scrollbar_btn_hover: color(225, 225, 225),
            }
        }
    }
}

fn is_dark_color(color: COLORREF) -> bool {
    (color.0 & 0xff) + ((color.0 >> 8) & 0xff) + ((color.0 >> 16) & 0xff) < 384
}

const fn color(red: u8, green: u8, blue: u8) -> COLORREF {
    COLORREF(red as u32 | ((green as u32) << 8) | ((blue as u32) << 16))
}

struct TreeNode {
    label: String,
    path: String,
    is_file: bool,
    children: Vec<usize>,
    expanded: bool,
}

struct ArchivePreview {
    path: PathBuf,
    nodes: Vec<TreeNode>,
    rows: Vec<(usize, usize)>,
    selected: Option<usize>,
    scroll: usize,
    display_name: String,
}

impl ArchivePreview {
    fn from_listed(
        path: PathBuf,
        files: Vec<crate::models::FileEntry>,
        display_name: String,
    ) -> Self {
        let nodes = build_tree(files);
        let mut rows = Vec::with_capacity(nodes.len().saturating_sub(1));
        append_visible_rows(&nodes, 0, 0, &mut rows);
        Self {
            path,
            nodes,
            rows,
            selected: None,
            scroll: 0,
            display_name,
        }
    }

    fn target_archive_path(&self) -> &Path {
        &self.path
    }

    fn visible_rows(&self) -> &[(usize, usize)] {
        &self.rows
    }

    fn set_expanded(&mut self, node_id: usize, expanded: bool) {
        let Some(node) = self.nodes.get_mut(node_id) else {
            return;
        };
        if node.is_file || node.expanded == expanded {
            return;
        }
        node.expanded = expanded;
        self.rows.clear();
        append_visible_rows(&self.nodes, 0, 0, &mut self.rows);
    }

    fn activate(&mut self, node_id: usize) {
        let Some(node) = self.nodes.get(node_id) else {
            return;
        };
        self.selected = Some(node_id);
        self.set_expanded(node_id, !node.expanded);
    }

    fn move_selection(&mut self, offset: isize, visible_count: usize) {
        let rows = self.visible_rows();
        if rows.is_empty() {
            return;
        }
        let current = self
            .selected
            .and_then(|selected| rows.iter().position(|(id, _)| *id == selected))
            .unwrap_or(0) as isize;
        let next = (current + offset).clamp(0, rows.len() as isize - 1) as usize;
        self.selected = Some(rows[next].0);

        if next < self.scroll {
            self.scroll = next;
        } else if visible_count > 0 && next >= self.scroll + visible_count {
            self.scroll = next + 1 - visible_count;
        }
    }
}

fn build_tree(files: Vec<crate::models::FileEntry>) -> Vec<TreeNode> {
    let mut nodes = vec![TreeNode {
        label: String::new(),
        path: String::new(),
        is_file: false,
        children: Vec::new(),
        expanded: true,
    }];
    let mut folders: HashMap<(usize, String), usize> = HashMap::new();

    for file in files {
        let normalized = file.name.replace('\\', "/");
        let parts: Vec<&str> = normalized
            .split('/')
            .filter(|part| !part.is_empty())
            .collect();
        if parts.is_empty() {
            continue;
        }
        let mut parent = 0;
        let mut folder_path = String::new();
        for part in &parts[..parts.len() - 1] {
            if !folder_path.is_empty() {
                folder_path.push('/');
            }
            folder_path.push_str(part);
            let key = (parent, (*part).to_string());
            parent = if let Some(existing) = folders.get(&key) {
                *existing
            } else {
                let id = nodes.len();
                nodes.push(TreeNode {
                    label: (*part).to_string(),
                    path: folder_path.clone(),
                    is_file: false,
                    children: Vec::new(),
                    expanded: true,
                });
                nodes[parent].children.push(id);
                folders.insert(key, id);
                id
            };
        }
        let id = nodes.len();
        nodes.push(TreeNode {
            label: parts.last().unwrap().to_string(),
            path: normalized,
            is_file: true,
            children: Vec::new(),
            expanded: false,
        });
        nodes[parent].children.push(id);
    }

    sort_tree(&mut nodes, 0);
    nodes
}

fn sort_tree(nodes: &mut [TreeNode], node_id: usize) {
    let mut children = nodes[node_id].children.clone();
    children.sort_by(|left, right| {
        let left_node = &nodes[*left];
        let right_node = &nodes[*right];
        right_node
            .is_file
            .cmp(&left_node.is_file)
            .then_with(|| natord::compare(&left_node.label, &right_node.label))
    });
    nodes[node_id].children = children.clone();
    for child in children {
        sort_tree(nodes, child);
    }
}

fn append_visible_rows(
    nodes: &[TreeNode],
    node_id: usize,
    depth: usize,
    rows: &mut Vec<(usize, usize)>,
) {
    for child in &nodes[node_id].children {
        rows.push((*child, depth));
        if !nodes[*child].is_file && nodes[*child].expanded {
            append_visible_rows(nodes, *child, depth + 1, rows);
        }
    }
}

enum PreviewContent {
    Archive(ArchivePreview),
    Message(String),
}

struct IconCache {
    icons: HashMap<String, HICON>,
}

impl IconCache {
    fn new() -> Self {
        Self {
            icons: HashMap::new(),
        }
    }

    fn get_or_load(&mut self, is_folder: bool, ext: &str) -> Option<HICON> {
        let key = if is_folder {
            "__folder__".to_string()
        } else {
            ext.to_ascii_lowercase()
        };

        if let Some(&hicon) = self.icons.get(&key) {
            return if !hicon.is_invalid() {
                Some(hicon)
            } else {
                None
            };
        }

        let hicon = load_shell_icon(is_folder, ext);
        if let Some(h) = hicon {
            self.icons.insert(key, h);
            Some(h)
        } else {
            None
        }
    }

    fn get_or_load_large(&mut self, ext: &str) -> Option<HICON> {
        let key = format!("{}:large", ext.to_ascii_lowercase());

        if let Some(&hicon) = self.icons.get(&key) {
            return if !hicon.is_invalid() {
                Some(hicon)
            } else {
                None
            };
        }

        let hicon = load_shell_large_icon(ext);
        if let Some(h) = hicon {
            self.icons.insert(key, h);
            Some(h)
        } else {
            None
        }
    }
}

impl Drop for IconCache {
    fn drop(&mut self) {
        for (_, hicon) in self.icons.drain() {
            if !hicon.is_invalid() {
                unsafe {
                    let _ = DestroyIcon(hicon);
                }
            }
        }
    }
}

fn parse_icon_path(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let unquoted = if let Some(rest) = trimmed.strip_prefix('"') {
        rest.split('"').next().unwrap_or("")
    } else {
        trimmed.split(',').next().unwrap_or("")
    };
    let clean = unquoted.trim();
    if clean.is_empty() {
        None
    } else {
        Some(PathBuf::from(clean))
    }
}

fn resolve_ico_path_for_ext(ext: &str) -> Option<PathBuf> {
    let clean = ext.trim_start_matches('.').to_ascii_lowercase();
    if clean.is_empty() {
        return None;
    }

    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        let progid_icon_key = format!(r"Software\Classes\QuiviT.{}\DefaultIcon", clean);
        if let Ok(key) = hkcu.open_subkey(&progid_icon_key) {
            if let Ok(val) = key.get_value::<String, _>("") {
                if let Some(path) = parse_icon_path(&val) {
                    if path.exists() {
                        return Some(path);
                    }
                }
            }
        }

        let ext_key = format!(r"Software\Classes\.{}", clean);
        if let Ok(key) = hkcu.open_subkey(&ext_key) {
            if let Ok(progid) = key.get_value::<String, _>("") {
                let p_icon_key = format!(r"Software\Classes\{}\DefaultIcon", progid.trim());
                if let Ok(ikey) = hkcu.open_subkey(&p_icon_key) {
                    if let Ok(val) = ikey.get_value::<String, _>("") {
                        if let Some(path) = parse_icon_path(&val) {
                            if path.exists() {
                                return Some(path);
                            }
                        }
                    }
                }
            }
        }
    }

    let icon_file_name = format!("{}.ico", clean);
    if let Ok(appdata) = std::env::var("APPDATA") {
        let p1 = PathBuf::from(&appdata)
            .join("com.x4163.quivit.dev")
            .join("icons")
            .join(&icon_file_name);
        if p1.exists() {
            return Some(p1);
        }
        let p2 = PathBuf::from(&appdata)
            .join("com.x4163.quivit")
            .join("icons")
            .join(&icon_file_name);
        if p2.exists() {
            return Some(p2);
        }
    }
    if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(&localappdata)
            .join("QuiviT")
            .join("icons")
            .join(&icon_file_name);
        if p.exists() {
            return Some(p);
        }
    }

    for &(name, bytes) in crate::formats::FORMAT_ICONS {
        if name.eq_ignore_ascii_case(&icon_file_name) {
            let target_dir = if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
                PathBuf::from(localappdata).join("QuiviT").join("icons")
            } else {
                std::env::temp_dir().join("quivit_icons")
            };
            let _ = std::fs::create_dir_all(&target_dir);
            let target_path = target_dir.join(&icon_file_name);
            if std::fs::write(&target_path, bytes).is_ok() {
                return Some(target_path);
            }
        }
    }

    None
}

fn load_hicon_from_ico_file(path: &Path, size: i32) -> Option<HICON> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    if !path.exists() {
        return None;
    }
    if !path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("ico"))
        .unwrap_or(false)
    {
        return None;
    }

    let wide: Vec<u16> = OsStr::new(path.as_os_str())
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let handle_res = unsafe {
        LoadImageW(
            None,
            PCWSTR(wide.as_ptr()),
            IMAGE_ICON,
            size,
            size,
            LR_LOADFROMFILE,
        )
    };

    match handle_res {
        Ok(handle) => {
            let hicon = HICON(handle.0);
            if !hicon.is_invalid() {
                Some(hicon)
            } else {
                None
            }
        }
        Err(_) => None,
    }
}

fn load_shell_large_icon(ext: &str) -> Option<HICON> {
    // 1. First attempt: Load directly from high-resolution .ico source to avoid
    // Shell System Image List nearest-neighbor upscaling artifacts.
    if let Some(ico_path) = resolve_ico_path_for_ext(ext) {
        if let Some(hicon) = load_hicon_from_ico_file(&ico_path, LARGE_ICON_SIZE) {
            return Some(hicon);
        }
    }

    // 2. Fallback to Shell Image List (SHIL_JUMBO 256x256, SHIL_EXTRALARGE 48x48)
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    let name = if ext.is_empty() {
        "dummy".to_string()
    } else {
        format!("dummy.{}", ext.trim_start_matches('.'))
    };
    let wide: Vec<u16> = OsStr::new(&name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    let mut shfi = SHFILEINFOW::default();
    let res = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_SYSICONINDEX | SHGFI_USEFILEATTRIBUTES,
        )
    };

    if res != 0 {
        for &shil in &[4, 2] {
            if let Ok(image_list) = unsafe { SHGetImageList::<IImageList>(shil) } {
                if let Ok(hicon) = unsafe { image_list.GetIcon(shfi.iIcon, 1) } {
                    if !hicon.is_invalid() {
                        return Some(hicon);
                    }
                }
            }
        }
    }

    load_shell_icon(false, ext)
}

fn load_shell_icon(is_folder: bool, ext: &str) -> Option<HICON> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    let (query_name, attrs) = if is_folder {
        let wide: Vec<u16> = OsStr::new("dummy")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        (wide, FILE_ATTRIBUTE_DIRECTORY)
    } else {
        let name = if ext.is_empty() {
            "dummy".to_string()
        } else {
            format!("dummy.{}", ext.trim_start_matches('.'))
        };
        let wide: Vec<u16> = OsStr::new(&name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        (wide, FILE_ATTRIBUTE_NORMAL)
    };

    let mut shfi = SHFILEINFOW::default();
    let res = unsafe {
        SHGetFileInfoW(
            PCWSTR(query_name.as_ptr()),
            attrs,
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_USEFILEATTRIBUTES | SHGFI_SMALLICON,
        )
    };

    if res != 0 && !shfi.hIcon.is_invalid() {
        Some(shfi.hIcon)
    } else {
        None
    }
}

fn create_default_ui_font(custom: Option<&LOGFONTW>) -> HFONT {
    if let Some(lf) = custom {
        let hfont = unsafe { CreateFontIndirectW(lf) };
        if !hfont.is_invalid() {
            return hfont;
        }
    }

    let font_name: Vec<u16> = "Segoe UI\0".encode_utf16().collect();
    let mut lf = LOGFONTW::default();
    lf.lfHeight = -12;
    lf.lfWeight = 400;
    lf.lfCharSet = windows::Win32::Graphics::Gdi::FONT_CHARSET(1);
    lf.lfQuality = windows::Win32::Graphics::Gdi::FONT_QUALITY(5);
    let len = font_name.len().min(lf.lfFaceName.len());
    lf.lfFaceName[..len].copy_from_slice(&font_name[..len]);

    unsafe { CreateFontIndirectW(&lf) }
}

struct ScrollbarGeometry {
    up_btn: RECT,
    down_btn: RECT,
    track: RECT,
    thumb: RECT,
    max_scroll: usize,
    track_height: i32,
    thumb_height: i32,
}

enum ArchiveHit {
    Row { node_id: usize, chevron: bool },
    Scrollbar(ScrollbarPart),
}

fn visible_row_count(client: RECT) -> usize {
    ((client.bottom - client.top - HEADER_HEIGHT).max(0) / ROW_HEIGHT) as usize
}

fn row_indent_x(client: RECT, depth: usize) -> i32 {
    client.left + MARGIN_LEFT + depth as i32 * INDENT_WIDTH
}

fn hit_test_archive(
    archive: &ArchivePreview,
    client: RECT,
    scrollbar: Option<&ScrollbarGeometry>,
    x: i32,
    y: i32,
) -> Option<ArchiveHit> {
    let content_top = client.top + HEADER_HEIGHT;
    if x < client.left || x >= client.right || y < content_top || y >= client.bottom {
        return None;
    }
    if let Some(sb) = scrollbar {
        if x >= sb.track.left - 2 {
            let part = if y >= sb.up_btn.top && y <= sb.up_btn.bottom {
                ScrollbarPart::UpArrow
            } else if y >= sb.down_btn.top && y <= sb.down_btn.bottom {
                ScrollbarPart::DownArrow
            } else if y >= sb.thumb.top && y <= sb.thumb.bottom {
                ScrollbarPart::Thumb
            } else {
                ScrollbarPart::Track
            };
            return Some(ArchiveHit::Scrollbar(part));
        }
    }

    let row = archive.scroll + ((y - content_top) / ROW_HEIGHT) as usize;
    let &(node_id, depth) = archive.visible_rows().get(row)?;
    let node = &archive.nodes[node_id];
    let indent_x = row_indent_x(client, depth);
    let chevron = !node.is_file
        && !node.children.is_empty()
        && x >= indent_x
        && x < indent_x + CHEVRON_WIDTH;
    Some(ArchiveHit::Row { node_id, chevron })
}

fn compute_scrollbar(client: RECT, total_rows: usize, scroll: usize) -> Option<ScrollbarGeometry> {
    let visible_count = visible_row_count(client);
    if total_rows <= visible_count || visible_count == 0 {
        return None;
    }
    let sb_left = client.right - SCROLLBAR_WIDTH - 2;
    let sb_right = client.right - 2;
    let sb_top = client.top + HEADER_HEIGHT + 2;
    let sb_bottom = client.bottom - 2;
    let total_height = (sb_bottom - sb_top).max(0);
    if total_height < 50 {
        return None;
    }
    let up_btn = RECT {
        left: sb_left,
        top: sb_top,
        right: sb_right,
        bottom: sb_top + ARROW_BUTTON_HEIGHT,
    };
    let down_btn = RECT {
        left: sb_left,
        top: sb_bottom - ARROW_BUTTON_HEIGHT,
        right: sb_right,
        bottom: sb_bottom,
    };
    let track = RECT {
        left: sb_left,
        top: up_btn.bottom + 2,
        right: sb_right,
        bottom: down_btn.top - 2,
    };
    let track_height = (track.bottom - track.top).max(0);
    if track_height < 20 {
        return None;
    }
    let max_scroll = total_rows.saturating_sub(visible_count);
    let thumb_height = ((track_height as f64 * visible_count as f64 / total_rows as f64) as i32)
        .clamp(20, track_height);
    let travel = (track_height - thumb_height).max(0);
    let thumb_top = if max_scroll > 0 {
        track.top + ((scroll.min(max_scroll) as f64 / max_scroll as f64) * travel as f64) as i32
    } else {
        track.top
    };
    let thumb = RECT {
        left: track.left,
        top: thumb_top,
        right: track.right,
        bottom: thumb_top + thumb_height,
    };
    Some(ScrollbarGeometry {
        up_btn,
        down_btn,
        track,
        thumb,
        max_scroll,
        track_height,
        thumb_height,
    })
}

#[derive(Clone, Copy)]
struct ScrollbarDrag {
    start_y: i32,
    start_scroll: usize,
}

struct PreviewPane {
    hwnd: HWND,
    theme: Theme,
    content: PreviewContent,
    epoch: u64,
    font: HFONT,
    icon_cache: IconCache,
    display_name: String,
    dragging_scrollbar: Option<ScrollbarDrag>,
    hovered_item: Option<usize>,
    hovered_chevron: Option<usize>,
    hovered_scrollbar_part: Option<ScrollbarPart>,
    mouse_tracked: bool,
}

impl Drop for PreviewPane {
    fn drop(&mut self) {
        if !self.font.is_invalid() {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(self.font.0));
            }
        }
    }
}

impl PreviewPane {
    fn loading(
        theme: Theme,
        epoch: u64,
        custom_font: Option<LOGFONTW>,
        display_name: String,
    ) -> Self {
        let font = create_default_ui_font(custom_font.as_ref());
        Self {
            hwnd: HWND(std::ptr::null_mut()),
            theme,
            content: PreviewContent::Message(String::new()),
            epoch,
            font,
            icon_cache: IconCache::new(),
            display_name,
            dragging_scrollbar: None,
            hovered_item: None,
            hovered_chevron: None,
            hovered_scrollbar_part: None,
            mouse_tracked: false,
        }
    }

    fn update_font(&mut self, custom: Option<LOGFONTW>) {
        let new_font = create_default_ui_font(custom.as_ref());
        if !self.font.is_invalid() {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(self.font.0));
            }
        }
        self.font = new_font;
    }
}

fn module_instance() -> HINSTANCE {
    unsafe {
        GetModuleHandleW(None)
            .map(|handle| handle.into())
            .unwrap_or_default()
    }
}

/// Lists one archive off the host thread. The result lands in the job slot
/// only for the preview that requested it; a superseded result is dropped.
fn spawn_preview_worker(
    path: PathBuf,
    epoch: u64,
    display_name: String,
    job: Arc<Mutex<PreviewJob>>,
    child_addr: isize,
) {
    std::thread::Builder::new()
        .name("quivit-preview-list".into())
        .spawn(move || {
            preview_log("preview worker start");
            let content = match crate::archives::list_archive_names(&path.to_string_lossy()) {
                Ok(files) => {
                    preview_log(&format!("preview listed {} entries", files.len()));
                    PreviewContent::Archive(ArchivePreview::from_listed(
                        path,
                        files,
                        display_name,
                    ))
                }
                Err(error) => {
                    PreviewContent::Message(format!("Unable to open this archive: {error}"))
                }
            };
            let stored = {
                let mut guard = match job.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                if guard.epoch == epoch {
                    guard.result = Some(content);
                    true
                } else {
                    false
                }
            };
            if stored {
                let child = HWND(child_addr as *mut std::ffi::c_void);
                let posted =
                    unsafe { PostMessageW(Some(child), WM_APP_PREVIEW_DONE, WPARAM(0), LPARAM(0)) };
                preview_log(&format!("preview worker done posted={}", posted.is_ok()));
            } else {
                preview_log("preview worker discarded superseded result");
            }
        })
        .ok();
}

fn create_preview_child(parent: HWND, rect: RECT, pane: &mut PreviewPane) -> Result<HWND> {
    register_preview_class().map_err(|error| {
        preview_log(&format!("register class failed: {error}"));
        error
    })?;
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            windows::core::PCWSTR(PREVIEW_CLASS_NAME.as_ptr()),
            windows::core::PCWSTR::null(),
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
            rect.left,
            rect.top,
            (rect.right - rect.left).max(0),
            (rect.bottom - rect.top).max(0),
            Some(parent),
            None,
            Some(module_instance()),
            Some((pane as *mut PreviewPane).cast()),
        )?
    };
    if hwnd.0.is_null() {
        preview_log("create child returned null hwnd");
        return Err(Error::from(E_NOINTERFACE));
    }
    pane.hwnd = hwnd;
    Ok(hwnd)
}

fn register_preview_class() -> Result<()> {
    if PREVIEW_CLASS_REGISTERED.get().is_some() {
        return Ok(());
    }
    let class = WNDCLASSW {
        style: CS_DBLCLKS,
        lpfnWndProc: Some(preview_window_proc),
        hInstance: module_instance(),
        lpszClassName: windows::core::PCWSTR(PREVIEW_CLASS_NAME.as_ptr()),
        ..Default::default()
    };
    if unsafe { RegisterClassW(&class) } == 0 {
        let code = unsafe { windows::Win32::Foundation::GetLastError().0 };
        preview_log(&format!("RegisterClassW failed code={code}"));
        return Err(Error::from(E_NOINTERFACE));
    }
    let _ = PREVIEW_CLASS_REGISTERED.set(());
    preview_log("preview class registered");
    Ok(())
}

unsafe extern "system" fn preview_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let create = unsafe { &*(lparam.0 as *const CREATESTRUCTW) };
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize) };
    }
    let pane = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PreviewPane };
    if pane.is_null() {
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    }
    let pane = unsafe { &mut *pane };

    match message {
        WM_PAINT => {
            paint_preview(hwnd, pane);
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_SIZE => {
            clamp_scroll(hwnd, pane);
            let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            let _ = unsafe { SetFocus(Some(hwnd)) };
            handle_lbutton_down(hwnd, pane, lparam);
            clamp_scroll(hwnd, pane);
            let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            LRESULT(0)
        }
        WM_LBUTTONDBLCLK => {
            let _ = unsafe { SetFocus(Some(hwnd)) };
            handle_lbutton_dblclk(hwnd, pane, lparam);
            clamp_scroll(hwnd, pane);
            let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            LRESULT(0)
        }
        WM_SETCURSOR => {
            unsafe {
                if let Ok(cursor) = LoadCursorW(None, IDC_ARROW) {
                    let _ = SetCursor(Some(cursor));
                }
            }
            LRESULT(1)
        }
        WM_MOUSEMOVE => {
            unsafe {
                if let Ok(cursor) = LoadCursorW(None, IDC_ARROW) {
                    let _ = SetCursor(Some(cursor));
                }
            }
            if !pane.mouse_tracked {
                let mut tme = TRACKMOUSEEVENT {
                    cb_size: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                    flags: TME_LEAVE,
                    hwnd_track: hwnd,
                    hover_time: 0,
                };
                unsafe {
                    let _ = TrackMouseEvent(&mut tme);
                }
                pane.mouse_tracked = true;
            }
            handle_mouse_move(hwnd, pane, lparam);
            LRESULT(0)
        }
        WM_MOUSELEAVE => {
            pane.mouse_tracked = false;
            let mut changed = false;
            if pane.hovered_item.is_some() {
                pane.hovered_item = None;
                changed = true;
            }
            if pane.hovered_chevron.is_some() {
                pane.hovered_chevron = None;
                changed = true;
            }
            if pane.hovered_scrollbar_part.is_some() {
                pane.hovered_scrollbar_part = None;
                changed = true;
            }
            if changed {
                let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            if pane.dragging_scrollbar.is_some() {
                pane.dragging_scrollbar = None;
                let _ = unsafe { ReleaseCapture() };
                let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            }
            LRESULT(0)
        }
        WM_CAPTURECHANGED => {
            if pane.dragging_scrollbar.is_some() {
                pane.dragging_scrollbar = None;
                let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            }
            LRESULT(0)
        }
        WM_MOUSEWHEEL => {
            handle_wheel(pane, wparam);
            let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            LRESULT(0)
        }
        WM_KEYDOWN => {
            handle_key(pane, wparam.0 as u32);
            clamp_scroll(hwnd, pane);
            let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            LRESULT(0)
        }
        WM_APP_PREVIEW_DONE => {
            preview_log("preview done received");
            let content = preview_jobs()
                .lock()
                .ok()
                .and_then(|map| map.get(&(hwnd.0 as isize)).cloned())
                .and_then(|job| {
                    job.lock().ok().and_then(|mut guard| {
                        guard.result.take().filter(|_| guard.epoch == pane.epoch)
                    })
                });
            if let Some(content) = content {
                pane.content = content;
                paint_now(hwnd, pane);
                let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            }
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

fn clamp_scroll(hwnd: HWND, pane: &mut PreviewPane) {
    let PreviewContent::Archive(archive) = &mut pane.content else {
        return;
    };
    let mut client = RECT::default();
    unsafe {
        let _ = GetClientRect(hwnd, &mut client);
    }
    let visible_count = visible_row_count(client);
    let rows = archive.visible_rows();
    let max_scroll = rows.len().saturating_sub(visible_count);
    if archive.scroll > max_scroll {
        archive.scroll = max_scroll;
    }
}

fn handle_lbutton_down(hwnd: HWND, pane: &mut PreviewPane, lparam: LPARAM) {
    let y = ((lparam.0 as u32 >> 16) & 0xffff) as i16 as i32;
    let x = (lparam.0 as u32 & 0xffff) as i16 as i32;
    let PreviewContent::Archive(archive) = &mut pane.content else {
        return;
    };
    let mut client = RECT::default();
    unsafe {
        let _ = GetClientRect(hwnd, &mut client);
    }
    let scrollbar = compute_scrollbar(client, archive.visible_rows().len(), archive.scroll);
    match hit_test_archive(archive, client, scrollbar.as_ref(), x, y) {
        Some(ArchiveHit::Row { node_id, .. }) => archive.activate(node_id),
        Some(ArchiveHit::Scrollbar(part)) => {
            let Some(sb) = scrollbar else {
                return;
            };
            match part {
                ScrollbarPart::UpArrow => archive.scroll = archive.scroll.saturating_sub(1),
                ScrollbarPart::DownArrow => {
                    archive.scroll = (archive.scroll + 1).min(sb.max_scroll);
                }
                ScrollbarPart::Thumb => {
                    pane.dragging_scrollbar = Some(ScrollbarDrag {
                        start_y: y,
                        start_scroll: archive.scroll,
                    });
                    unsafe {
                        let _ = SetCapture(hwnd);
                    }
                }
                ScrollbarPart::Track => {
                    let page = visible_row_count(client).max(1);
                    if y < sb.thumb.top && y > sb.up_btn.bottom {
                        archive.scroll = archive.scroll.saturating_sub(page);
                    } else if y > sb.thumb.bottom && y < sb.down_btn.top {
                        archive.scroll = (archive.scroll + page).min(sb.max_scroll);
                    }
                }
            }
        }
        None => archive.selected = None,
    }
}

fn handle_lbutton_dblclk(hwnd: HWND, pane: &mut PreviewPane, lparam: LPARAM) {
    let y = ((lparam.0 as u32 >> 16) & 0xffff) as i16 as i32;
    let x = (lparam.0 as u32 & 0xffff) as i16 as i32;
    let PreviewContent::Archive(archive) = &mut pane.content else {
        return;
    };
    let mut client = RECT::default();
    unsafe {
        let _ = GetClientRect(hwnd, &mut client);
    }
    let scrollbar = compute_scrollbar(client, archive.visible_rows().len(), archive.scroll);
    let Some(ArchiveHit::Row { node_id, chevron }) =
        hit_test_archive(archive, client, scrollbar.as_ref(), x, y)
    else {
        return;
    };
    if !chevron && archive.nodes[node_id].is_file {
        archive.selected = Some(node_id);
        open_item_in_app(archive, node_id);
    } else {
        archive.activate(node_id);
    }
}

fn handle_mouse_move(hwnd: HWND, pane: &mut PreviewPane, lparam: LPARAM) {
    let PreviewContent::Archive(archive) = &mut pane.content else {
        return;
    };
    let y = ((lparam.0 as u32 >> 16) & 0xffff) as i16 as i32;
    let x = (lparam.0 as u32 & 0xffff) as i16 as i32;
    let mut client = RECT::default();
    unsafe {
        let _ = GetClientRect(hwnd, &mut client);
    }
    if let Some(drag) = pane.dragging_scrollbar {
        if let Some(sb) = compute_scrollbar(client, archive.visible_rows().len(), drag.start_scroll) {
            let delta_y = y - drag.start_y;
            let travel = (sb.track_height - sb.thumb_height).max(1);
            let delta_scroll =
                (delta_y as f64 * sb.max_scroll as f64 / travel as f64).round() as isize;
            let new_scroll = (drag.start_scroll as isize + delta_scroll)
                .clamp(0, sb.max_scroll as isize) as usize;
            if new_scroll != archive.scroll {
                archive.scroll = new_scroll;
                let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            }
        }
        return;
    }

    let scrollbar = compute_scrollbar(client, archive.visible_rows().len(), archive.scroll);
    let (new_sb_part, new_item, new_chevron) =
        match hit_test_archive(archive, client, scrollbar.as_ref(), x, y) {
            Some(ArchiveHit::Scrollbar(part)) => (Some(part), None, None),
            Some(ArchiveHit::Row { node_id, chevron }) => {
                (None, Some(node_id), chevron.then_some(node_id))
            }
            None => (None, None, None),
        };

    if new_sb_part != pane.hovered_scrollbar_part
        || new_item != pane.hovered_item
        || new_chevron != pane.hovered_chevron
    {
        pane.hovered_scrollbar_part = new_sb_part;
        pane.hovered_item = new_item;
        pane.hovered_chevron = new_chevron;
        let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
    }
}

fn handle_wheel(pane: &mut PreviewPane, wparam: WPARAM) {
    let PreviewContent::Archive(archive) = &mut pane.content else {
        return;
    };
    let delta = ((wparam.0 >> 16) & 0xffff) as i16;
    let rows = archive.visible_rows();
    let mut client = RECT::default();
    unsafe {
        let _ = GetClientRect(pane.hwnd, &mut client);
    }
    let visible_count = visible_row_count(client);
    let max_scroll = rows.len().saturating_sub(visible_count);

    if delta > 0 {
        archive.scroll = archive.scroll.saturating_sub(3);
    } else if delta < 0 {
        archive.scroll = (archive.scroll + 3).min(max_scroll);
    }
}

fn handle_key(pane: &mut PreviewPane, key: u32) {
    let PreviewContent::Archive(archive) = &mut pane.content else {
        return;
    };
    let mut client = RECT::default();
    unsafe {
        let _ = GetClientRect(pane.hwnd, &mut client);
    }
    let visible_count = visible_row_count(client);

    match key {
        0x26 => archive.move_selection(-1, visible_count), // VK_UP
        0x28 => archive.move_selection(1, visible_count),  // VK_DOWN
        0x21 => archive.move_selection(-(visible_count.max(1) as isize), visible_count), // VK_PRIOR (Page Up)
        0x22 => archive.move_selection(visible_count.max(1) as isize, visible_count), // VK_NEXT (Page Down)
        0x24 => archive.move_selection(-(archive.nodes.len() as isize), visible_count), // VK_HOME
        0x23 => archive.move_selection(archive.nodes.len() as isize, visible_count),  // VK_END
        0x0d => {
            if let Some(selected) = archive.selected {
                if let Some(node) = archive.nodes.get(selected) {
                    if node.is_file {
                        open_item_in_app(archive, selected);
                    } else {
                        archive.activate(selected);
                    }
                }
            }
        }
        0x27 => {
            // VK_RIGHT: expand folder if collapsed, or move down
            if let Some(selected) = archive.selected {
                let node = &archive.nodes[selected];
                if !node.is_file && !node.children.is_empty() {
                    if !node.expanded {
                        archive.set_expanded(selected, true);
                    } else {
                        archive.move_selection(1, visible_count);
                    }
                }
            }
        }
        0x25 => {
            // VK_LEFT: collapse folder if expanded
            if let Some(selected) = archive.selected {
                archive.set_expanded(selected, false);
            }
        }
        _ => {}
    }
}

fn find_quivit_app_exe() -> Option<PathBuf> {
    match crate::platform::direct_open::selected_exe() {
        Ok(Some(selected)) => return Some(selected),
        Err(error) => {
            preview_log(&format!("find_quivit_app_exe failed: {error}"));
            return None;
        }
        Ok(None) => {}
    }

    if let Ok(current) = std::env::current_exe() {
        let file_name = current.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !file_name.eq_ignore_ascii_case("quivit-previews.exe") && current.exists() {
            return Some(current);
        }
    }

    let host_path = crate::platform::previews::resolve_previews_host_path();
    let sidecar_path = crate::platform::previews::host::sidecar_path_for(&host_path);
    if let Some(sidecar) = crate::platform::previews::host::read_sidecar(&sidecar_path) {
        if let Some(app_path) = sidecar.app_path {
            let path = PathBuf::from(app_path);
            if path.exists() {
                return Some(path);
            }
        }
    }

    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let candidates = [
            r"Software\Classes\Applications\quivit.exe\shell\open\command",
            r"Software\Classes\QuiviT.zip\shell\open\command",
        ];
        for subkey in candidates {
            if let Ok(key) = hkcu.open_subkey(subkey) {
                if let Ok(val) = key.get_value::<String, _>("") {
                    let trimmed = val.trim();
                    let exe_str = if trimmed.starts_with('"') {
                        trimmed
                            .trim_start_matches('"')
                            .split('"')
                            .next()
                            .unwrap_or("")
                    } else {
                        trimmed.split_whitespace().next().unwrap_or("")
                    };
                    let path = PathBuf::from(exe_str);
                    if path.exists() {
                        return Some(path);
                    }
                }
            }
        }
    }

    std::env::current_exe().ok()
}

fn open_item_in_app(archive: &ArchivePreview, node_id: usize) {
    let Some(node) = archive.nodes.get(node_id) else {
        return;
    };
    if !node.is_file {
        return;
    }

    let archive_path = archive.target_archive_path();
    let target_arg = format!("{}|{}", archive_path.to_string_lossy(), node.path);

    let Some(app_exe) = find_quivit_app_exe() else {
        preview_log(&format!(
            "open_item_in_app failed: could not locate app exe for target={target_arg}"
        ));
        return;
    };

    preview_log(&format!(
        "open_item_in_app exe={} target={target_arg}",
        app_exe.display()
    ));

    let mut cmd = std::process::Command::new(&app_exe);
    if let Some(parent) = app_exe.parent() {
        cmd.current_dir(parent);
    }
    cmd.arg(&target_arg);

    match cmd.spawn() {
        Ok(_) => preview_log("open_item_in_app spawned successfully"),
        Err(err) => preview_log(&format!("open_item_in_app spawn error: {err}")),
    }
}

fn paint_preview(hwnd: HWND, pane: &mut PreviewPane) {
    unsafe {
        let mut paint = PAINTSTRUCT::default();
        let hdc = BeginPaint(hwnd, &mut paint);
        let mut client = RECT::default();
        let _ = GetClientRect(hwnd, &mut client);
        log_paint(hdc, client, pane);
        if hdc.0.is_null() {
            return;
        }
        paint_double_buffered(hdc, client, pane);
        let _ = EndPaint(hwnd, &paint);
    }
}

/// Immediate first paint outside the message queue. The host sometimes shows
/// the child before its first WM_PAINT arrives; painting synchronously here
/// guarantees content from the first frame. Later repaints still flow
/// through WM_PAINT.
fn paint_now(hwnd: HWND, pane: &mut PreviewPane) {
    unsafe {
        let hdc = GetDC(Some(hwnd));
        let mut client = RECT::default();
        let _ = GetClientRect(hwnd, &mut client);
        log_paint(hdc, client, pane);
        if hdc.0.is_null() {
            return;
        }
        paint_double_buffered(hdc, client, pane);
        let _ = ReleaseDC(Some(hwnd), hdc);
    }
}

/// Repaints the live child after a host-driven resize without waiting for
/// WM_PAINT. Moves the window first, then draws synchronously.
fn repaint_now(state: &Arc<Mutex<PreviewState>>, hwnd: HWND) {
    let mut state = lock_state(state);
    if let Some(pane) = state.pane.as_mut() {
        if pane.hwnd == hwnd {
            paint_now(hwnd, pane);
        }
    }
}

fn log_paint(hdc: windows::Win32::Graphics::Gdi::HDC, client: RECT, pane: &PreviewPane) {
    if PAINT_LOGGED.fetch_add(1, std::sync::atomic::Ordering::Relaxed) < 5 {
        let kind = match &pane.content {
            PreviewContent::Archive(_) => "archive",
            PreviewContent::Message(_) => "message",
        };
        preview_log(&format!(
            "paint client=({},{},{},{}) kind={kind} hdc_null={}",
            client.left,
            client.top,
            client.right,
            client.bottom,
            hdc.0.is_null()
        ));
    }
}

unsafe fn paint_double_buffered(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    client: RECT,
    pane: &mut PreviewPane,
) {
    let width = (client.right - client.left).max(1);
    let height = (client.bottom - client.top).max(1);

    let mem_dc = CreateCompatibleDC(Some(hdc));
    if mem_dc.0.is_null() {
        render_content(hdc, client, pane);
        return;
    }

    let mem_bm = CreateCompatibleBitmap(hdc, width, height);
    if mem_bm.0.is_null() {
        let _ = DeleteDC(mem_dc);
        render_content(hdc, client, pane);
        return;
    }

    let old_bm = SelectObject(mem_dc, mem_bm.into());

    render_content(mem_dc, client, pane);

    let _ = BitBlt(
        hdc,
        client.left,
        client.top,
        width,
        height,
        Some(mem_dc),
        client.left,
        client.top,
        SRCCOPY,
    );

    SelectObject(mem_dc, old_bm);
    let _ = DeleteObject(mem_bm.into());
    let _ = DeleteDC(mem_dc);
}

unsafe fn render_content(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    client: RECT,
    pane: &mut PreviewPane,
) {
    fill(hdc, client, pane.theme.surface);
    let old_font = if !pane.font.is_invalid() {
        Some(SelectObject(hdc, pane.font.into()))
    } else {
        None
    };

    let theme = pane.theme;
    let display_name = if !pane.display_name.is_empty() {
        &pane.display_name
    } else if let PreviewContent::Archive(archive) = &pane.content {
        &archive.display_name
    } else {
        ""
    };
    draw_header(hdc, client, display_name, &mut pane.icon_cache, theme);

    let is_dragging = pane.dragging_scrollbar.is_some();
    let hovered_item = pane.hovered_item;
    let hovered_chevron = pane.hovered_chevron;
    let hovered_sb = pane.hovered_scrollbar_part;
    match &mut pane.content {
        PreviewContent::Archive(archive) => {
            draw_archive(
                hdc,
                client,
                archive,
                &mut pane.icon_cache,
                theme,
                is_dragging,
                hovered_item,
                hovered_chevron,
                hovered_sb,
            );
        }
        PreviewContent::Message(message) => {
            if !message.is_empty() {
                draw_message(hdc, client, message, theme);
            }
        }
    }

    if let Some(old) = old_font {
        SelectObject(hdc, old);
    }
}

unsafe fn draw_header(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    client: RECT,
    display_name: &str,
    icon_cache: &mut IconCache,
    theme: Theme,
) {
    fill(
        hdc,
        RECT {
            left: client.left,
            top: client.top,
            right: client.right,
            bottom: client.top + HEADER_HEIGHT,
        },
        theme.surface,
    );
    fill(
        hdc,
        RECT {
            left: client.left,
            top: client.top + HEADER_HEIGHT - 1,
            right: client.right,
            bottom: client.top + HEADER_HEIGHT,
        },
        theme.border,
    );

    let title = if display_name.is_empty() {
        "Archive"
    } else {
        display_name
    };

    let ext = Path::new(title)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    let width = client.right - client.left;
    if let Some(hicon) = icon_cache.get_or_load_large(ext) {
        let icon_x = client.left + ((width - LARGE_ICON_SIZE) / 2).max(0);
        let icon_y = client.top + 14;
        let _ = DrawIconEx(
            hdc,
            icon_x,
            icon_y,
            hicon,
            LARGE_ICON_SIZE,
            LARGE_ICON_SIZE,
            0,
            None,
            DI_NORMAL,
        );

        draw_text_centered(
            hdc,
            title,
            RECT {
                left: client.left + 12,
                top: client.top + 118,
                right: (client.right - 12).max(client.left + 12),
                bottom: client.top + 136,
            },
            theme.text,
        );
    } else {
        draw_text_centered(
            hdc,
            title,
            RECT {
                left: client.left + 12,
                top: client.top,
                right: (client.right - 12).max(client.left + 12),
                bottom: client.top + HEADER_HEIGHT,
            },
            theme.text,
        );
    }
}

unsafe fn draw_archive(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    client: RECT,
    archive: &ArchivePreview,
    icon_cache: &mut IconCache,
    theme: Theme,
    is_dragging_scrollbar: bool,
    hovered_item: Option<usize>,
    hovered_chevron: Option<usize>,
    hovered_sb_part: Option<ScrollbarPart>,
) {
    let rows = archive.visible_rows();
    let scrollbar = compute_scrollbar(client, rows.len(), archive.scroll);
    let content_right = if let Some(sb) = &scrollbar {
        sb.track.left - 4
    } else {
        client.right - 8
    };

    let visible_height = visible_row_count(client) + 1;
    for (view_index, (node_id, depth)) in rows
        .iter()
        .skip(archive.scroll)
        .take(visible_height)
        .enumerate()
    {
        let y = client.top + HEADER_HEIGHT + view_index as i32 * ROW_HEIGHT;
        let row = RECT {
            left: client.left + 6,
            top: y,
            right: content_right + 1,
            bottom: y + ROW_HEIGHT,
        };
        let node = &archive.nodes[*node_id];
        let is_selected = archive.selected == Some(*node_id);
        let is_hovered = hovered_item == Some(*node_id);

        let indent_x = row_indent_x(client, *depth);
        let item_box_left = client.left + 6;

        if is_selected {
            let sel_rect = RECT {
                left: item_box_left,
                top: row.top + 1,
                right: content_right + 1,
                bottom: row.bottom - 1,
            };
            fill(hdc, sel_rect, theme.selected);
            draw_border(hdc, sel_rect, theme.selected_border);
        } else if is_hovered {
            let hov_rect = RECT {
                left: item_box_left,
                top: row.top + 1,
                right: content_right + 1,
                bottom: row.bottom - 1,
            };
            fill(hdc, hov_rect, theme.hover);
            draw_border(hdc, hov_rect, theme.hover_border);
        }

        // Chevron slot: only folders with children get an arrow chevron
        if !node.is_file && !node.children.is_empty() {
            let chevron_cx = indent_x + CHEVRON_WIDTH / 2;
            let chevron_cy = row.top + ROW_HEIGHT / 2;
            let is_ch_hovered = hovered_chevron == Some(*node_id);
            let chevron_color = if is_ch_hovered {
                theme.text
            } else {
                theme.chevron
            };
            draw_chevron(hdc, chevron_cx, chevron_cy, node.expanded, chevron_color);
        }

        // Icon slot: Windows folder or file icon
        let icon_x = indent_x + CHEVRON_WIDTH;
        let icon_y = row.top + (ROW_HEIGHT - ICON_SIZE) / 2;
        let ext = if node.is_file {
            Path::new(&node.label)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
        } else {
            ""
        };

        if let Some(hicon) = icon_cache.get_or_load(!node.is_file, ext) {
            let _ = DrawIconEx(
                hdc, icon_x, icon_y, hicon, ICON_SIZE, ICON_SIZE, 0, None, DI_NORMAL,
            );
        }

        // Text slot
        let text_x = icon_x + ICON_SIZE + ICON_TEXT_GAP;
        draw_text(
            hdc,
            &node.label,
            RECT {
                left: text_x,
                top: row.top,
                right: content_right,
                bottom: row.bottom,
            },
            theme.text,
        );
    }

    if let Some(sb) = scrollbar {
        // Up arrow button
        let is_up_hovered = hovered_sb_part == Some(ScrollbarPart::UpArrow);
        let is_up_enabled = archive.scroll > 0;
        if is_up_hovered && is_up_enabled {
            fill(hdc, sb.up_btn, theme.scrollbar_btn_hover);
        }
        let up_cx = (sb.up_btn.left + sb.up_btn.right) / 2;
        let up_cy = (sb.up_btn.top + sb.up_btn.bottom) / 2;
        let up_color = if !is_up_enabled {
            theme.border
        } else if is_up_hovered {
            theme.text
        } else {
            theme.chevron
        };
        draw_scroll_arrow(hdc, up_cx, up_cy, true, up_color);

        // Down arrow button
        let is_down_hovered = hovered_sb_part == Some(ScrollbarPart::DownArrow);
        let is_down_enabled = archive.scroll < sb.max_scroll;
        if is_down_hovered && is_down_enabled {
            fill(hdc, sb.down_btn, theme.scrollbar_btn_hover);
        }
        let down_cx = (sb.down_btn.left + sb.down_btn.right) / 2;
        let down_cy = (sb.down_btn.top + sb.down_btn.bottom) / 2;
        let down_color = if !is_down_enabled {
            theme.border
        } else if is_down_hovered {
            theme.text
        } else {
            theme.chevron
        };
        draw_scroll_arrow(hdc, down_cx, down_cy, false, down_color);

        // Thumb
        let thumb_color = if is_dragging_scrollbar {
            theme.scrollbar_active
        } else if hovered_sb_part == Some(ScrollbarPart::Thumb) {
            theme.scrollbar_hover
        } else {
            theme.scrollbar_thumb
        };
        fill(hdc, sb.thumb, thumb_color);
    }
}

unsafe fn draw_scroll_arrow(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    cx: i32,
    cy: i32,
    up: bool,
    color: COLORREF,
) {
    let pen = CreatePen(PS_SOLID, 1, color);
    let old_pen = SelectObject(hdc, pen.into());

    if up {
        let pts1 = [
            POINT {
                x: cx - 3,
                y: cy + 1,
            },
            POINT { x: cx, y: cy - 2 },
            POINT {
                x: cx + 4,
                y: cy + 2,
            },
        ];
        let pts2 = [
            POINT {
                x: cx - 3,
                y: cy + 2,
            },
            POINT { x: cx, y: cy - 1 },
            POINT {
                x: cx + 4,
                y: cy + 3,
            },
        ];
        let _ = Polyline(hdc, &pts1);
        let _ = Polyline(hdc, &pts2);
    } else {
        let pts1 = [
            POINT {
                x: cx - 3,
                y: cy - 2,
            },
            POINT { x: cx, y: cy + 1 },
            POINT {
                x: cx + 4,
                y: cy - 3,
            },
        ];
        let pts2 = [
            POINT {
                x: cx - 3,
                y: cy - 1,
            },
            POINT { x: cx, y: cy + 2 },
            POINT {
                x: cx + 4,
                y: cy - 2,
            },
        ];
        let _ = Polyline(hdc, &pts1);
        let _ = Polyline(hdc, &pts2);
    }

    SelectObject(hdc, old_pen);
    let _ = DeleteObject(pen.into());
}

unsafe fn draw_chevron(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    cx: i32,
    cy: i32,
    expanded: bool,
    color: COLORREF,
) {
    let pen = CreatePen(PS_SOLID, 1, color);
    let old_pen = SelectObject(hdc, pen.into());

    if expanded {
        // Down-pointing chevron (expanded)
        let pts1 = [
            POINT {
                x: cx - 4,
                y: cy - 2,
            },
            POINT { x: cx, y: cy + 2 },
            POINT {
                x: cx + 5,
                y: cy - 3,
            },
        ];
        let pts2 = [
            POINT {
                x: cx - 4,
                y: cy - 1,
            },
            POINT { x: cx, y: cy + 3 },
            POINT {
                x: cx + 5,
                y: cy - 2,
            },
        ];
        let _ = Polyline(hdc, &pts1);
        let _ = Polyline(hdc, &pts2);
    } else {
        // Right-pointing chevron (collapsed)
        let pts1 = [
            POINT {
                x: cx - 2,
                y: cy - 4,
            },
            POINT { x: cx + 2, y: cy },
            POINT {
                x: cx - 3,
                y: cy + 5,
            },
        ];
        let pts2 = [
            POINT {
                x: cx - 1,
                y: cy - 4,
            },
            POINT { x: cx + 3, y: cy },
            POINT {
                x: cx - 2,
                y: cy + 5,
            },
        ];
        let _ = Polyline(hdc, &pts1);
        let _ = Polyline(hdc, &pts2);
    }

    SelectObject(hdc, old_pen);
    let _ = DeleteObject(pen.into());
}

unsafe fn draw_border(hdc: windows::Win32::Graphics::Gdi::HDC, rect: RECT, color: COLORREF) {
    fill(
        hdc,
        RECT {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.top + 1,
        },
        color,
    );
    fill(
        hdc,
        RECT {
            left: rect.left,
            top: rect.bottom - 1,
            right: rect.right,
            bottom: rect.bottom,
        },
        color,
    );
    fill(
        hdc,
        RECT {
            left: rect.left,
            top: rect.top,
            right: rect.left + 1,
            bottom: rect.bottom,
        },
        color,
    );
    fill(
        hdc,
        RECT {
            left: rect.right - 1,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        },
        color,
    );
}

unsafe fn draw_message(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    area: RECT,
    message: &str,
    theme: Theme,
) {
    let mut padded = area;
    padded.left += 16;
    padded.right -= 16;
    padded.top += HEADER_HEIGHT + 16;
    draw_text(hdc, message, padded, theme.muted);
}

unsafe fn draw_text(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    text: &str,
    mut rect: RECT,
    text_color: COLORREF,
) {
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, text_color);
    let _ = DrawTextW(
        hdc,
        &mut wide,
        &mut rect,
        DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS,
    );
}

unsafe fn draw_text_centered(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    text: &str,
    mut rect: RECT,
    text_color: COLORREF,
) {
    let mut wide: Vec<u16> = text.encode_utf16().collect();
    SetBkMode(hdc, TRANSPARENT);
    SetTextColor(hdc, text_color);
    let _ = DrawTextW(
        hdc,
        &mut wide,
        &mut rect,
        DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS,
    );
}

unsafe fn fill(hdc: windows::Win32::Graphics::Gdi::HDC, rect: RECT, fill_color: COLORREF) {
    let brush = CreateSolidBrush(fill_color);
    FillRect(hdc, &rect, brush);
    let _ = DeleteObject(HGDIOBJ(brush.0));
}
