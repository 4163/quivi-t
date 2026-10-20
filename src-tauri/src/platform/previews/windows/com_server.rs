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
            CLASS_E_NOAGGREGATION, COLORREF, E_NOINTERFACE, E_NOTIMPL, HINSTANCE, HWND, LPARAM,
            LRESULT, POINT, RECT, S_FALSE, WPARAM,
        },
        Graphics::Gdi::{
            BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontIndirectW,
            CreatePen, CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect,
            GetDC, InvalidateRect, Polyline, ReleaseDC, SelectObject, SetBkMode, SetTextColor,
            DT_END_ELLIPSIS, DT_LEFT, DT_SINGLELINE, DT_VCENTER, HFONT, HGDIOBJ, LOGFONTW,
            PAINTSTRUCT, PS_SOLID, SRCCOPY, TRANSPARENT,
        },
        Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL},
        System::{
            Com::{
                CoInitializeEx, CoRegisterClassObject, CoRevokeClassObject, CoUninitialize,
                IClassFactory, IClassFactory_Impl, IStream, CLSCTX_LOCAL_SERVER,
                COINIT_APARTMENTTHREADED, REGCLS_MULTIPLEUSE, STREAM_SEEK_SET,
            },
            LibraryLoader::GetModuleHandleW,
            Ole::{IObjectWithSite, IObjectWithSite_Impl, IOleWindow, IOleWindow_Impl},
            Threading::GetCurrentThreadId,
        },
        UI::{
            Input::KeyboardAndMouse::{GetFocus, SetFocus},
            Shell::{
                IInitializeWithItem, IInitializeWithItem_Impl, IPreviewHandler,
                IPreviewHandlerFrame, IPreviewHandlerVisuals, IPreviewHandlerVisuals_Impl,
                IPreviewHandler_Impl, PropertiesSystem::IInitializeWithFile,
                PropertiesSystem::IInitializeWithFile_Impl, SHGetFileInfoW, SHFILEINFOW,
                SHGFI_ICON, SHGFI_SMALLICON, SHGFI_USEFILEATTRIBUTES, SIGDN_FILESYSPATH,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyWindow, DispatchMessageW,
                DrawIconEx, GetClientRect, GetMessageW, GetWindowLongPtrW, KillTimer, MoveWindow,
                PostMessageW, PostThreadMessageW, RegisterClassW, SetParent, SetTimer,
                SetWindowLongPtrW, TranslateMessage, CREATESTRUCTW, CS_DBLCLKS, DI_NORMAL,
                GWLP_USERDATA, HICON, MSG, WINDOW_EX_STYLE, WM_ERASEBKGND, WM_KEYDOWN,
                WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_MOUSEWHEEL, WM_NCCREATE, WM_PAINT, WM_SIZE,
                WM_TIMER, WNDCLASSW, WS_CHILD, WS_CLIPSIBLINGS, WS_VISIBLE,
            },
        },
    },
};

use super::PREVIEW_HANDLER_CLSID;

const PREVIEW_CLASS_NAME: &[u16] = &[
    81, 117, 105, 118, 105, 84, 80, 114, 101, 118, 105, 101, 119, 80, 97, 110, 101, 0,
];
const MAX_SOURCE_BYTES: usize = 512 * 1024 * 1024;
const HEADER_HEIGHT: i32 = 34;
const ROW_HEIGHT: i32 = 24;
const MARGIN_LEFT: i32 = 8;
const INDENT_WIDTH: i32 = 16;
const CHEVRON_WIDTH: i32 = 16;
const ICON_SIZE: i32 = 16;
const ICON_TEXT_GAP: i32 = 6;
static PREVIEW_SOURCE_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static ACTIVE_HANDLERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static PREVIEW_CLASS_REGISTERED: OnceLock<()> = OnceLock::new();
static PAINT_LOGGED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static PUMP_THREAD_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
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
// Actual thread-timer id returned by SetTimer. Thread timers ignore the
// requested id, so the WM_TIMER match must use this, not IDLE_TIMER_ID.
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

fn lock_state(
    state: &Arc<Mutex<PreviewState>>,
) -> std::sync::MutexGuard<'_, PreviewState> {
    state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn run() -> Result<()> {
    preview_log("server start");
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()? };

    // Recorded before any class object exists so no task post can miss it.
    PUMP_THREAD_ID.store(unsafe { GetCurrentThreadId() }, std::sync::atomic::Ordering::Relaxed);

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

    // Explorer releases the COM object when its Preview pane closes. The
    // message pump keeps the native child responsive for tree interaction.
    // The pump thread id lets handler teardown manage the idle timer even
    // when the final Release arrives on an RPC worker thread.
    unsafe {
        let mut message = MSG::default();
        loop {
            let more: bool = GetMessageW(&mut message, None, 0, 0).into();
            if !more {
                break;
            }
            if message.message == WM_APP_ARM_IDLE {
                let prev = IDLE_TIMER_ACTUAL.swap(0, std::sync::atomic::Ordering::Relaxed);
                if prev != 0 {
                    KillTimer(None, prev).ok();
                }
                let id = SetTimer(None, IDLE_TIMER_ID, IDLE_QUIT_MS, None);
                if id == 0 {
                    preview_log("server idle timer failed");
                } else {
                    IDLE_TIMER_ACTUAL.store(id, std::sync::atomic::Ordering::Relaxed);
                }
                continue;
            }
            if message.message == WM_APP_DISARM_IDLE {
                let prev = IDLE_TIMER_ACTUAL.swap(0, std::sync::atomic::Ordering::Relaxed);
                if prev != 0 {
                    KillTimer(None, prev).ok();
                }
                continue;
            }
            if message.message == WM_TIMER {
                let actual = IDLE_TIMER_ACTUAL.load(std::sync::atomic::Ordering::Relaxed);
                if actual != 0
                    && message.wParam.0 == actual
                    && ACTIVE_HANDLERS.load(std::sync::atomic::Ordering::Relaxed) == 0
                {
                    preview_log("server idle timeout");
                    break;
                }
                continue;
            }
            if message.message == WM_APP_TASK {
                let kind = message.wParam.0;
                let state = Arc::from_raw(message.lParam.0 as *const Mutex<PreviewState>);
                match kind {
                    TASK_CREATE => pump_create(&state),
                    TASK_POSITION => pump_position(&state),
                    TASK_TEARDOWN => pump_teardown(&state),
                    _ => {}
                }
                drop(state);
                continue;
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        preview_log("server message loop exit");
        CoRevokeClassObject(cookie)?;
        CoUninitialize();
    }
    Ok(())
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
        ACTIVE_HANDLERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        disarm_idle_timeout();
        let preview: IUnknown = PreviewHandler {
            state: Arc::new(Mutex::new(PreviewState::default())),
        }
        .into();
        let queried = unsafe { preview.query(riid, result) };
        if queried.is_err() {
            ACTIVE_HANDLERS.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
            preview_log("CreateInstance QueryInterface failed");
        } else {
            preview_log("CreateInstance ok");
        }
        queried.ok()
    }

    fn LockServer(&self, _lock: BOOL) -> Result<()> {
        Ok(())
    }
}

#[derive(Default)]
struct PreviewState {
    stream: Option<IStream>,
    file_path: Option<PathBuf>,
    parent: HWND,
    rect: RECT,
    site: Option<IPreviewHandlerFrame>,
    pane: Option<Box<PreviewPane>>,
    dark: bool,
    custom_font: Option<LOGFONTW>,
    custom_text_color: Option<COLORREF>,
    pending_preview: Option<PreviewParams>,
    applied_parent: HWND,
    applied_rect: RECT,
}

// Everything a deferred preview build needs. Recorded synchronously in
// DoPreview so the host call returns immediately; the pump consumes it.
// Holds only plain data: the shell stream stays behind because its proxy
// is only valid on the calling thread.
enum Materialized {
    List(PathBuf, bool),
    NotArchive,
    Failed(String),
}

struct PreviewParams {
    materialized: Materialized,
    dark: bool,
    epoch: u64,
    custom_font: Option<LOGFONTW>,
    custom_text_color: Option<COLORREF>,
}

static PREVIEW_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// One in-flight listing per child window. The worker stores its result here
// and wakes the pump; a newer preview for a recycled window handle can never
// apply a stale result because epochs mismatch.
struct PreviewJob {
    epoch: u64,
    result: Option<PreviewContent>,
}

static PREVIEW_JOBS: OnceLock<Mutex<HashMap<isize, Arc<Mutex<PreviewJob>>>>> =
    OnceLock::new();

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

/// Hands one unit of deferred work to the pump thread. The state Arc travels
/// as a raw pointer through the message itself, so no shared registry is
/// needed. The pump reclaims exactly one ref per delivered task; if posting
/// fails the ref is reclaimed here instead.
fn post_task(state: &Arc<Mutex<PreviewState>>, kind: usize) {
    let ptr = Arc::into_raw(state.clone());
    let posted = unsafe {
        PostThreadMessageW(
            pump_thread_id(),
            WM_APP_TASK,
            WPARAM(kind),
            LPARAM(ptr as isize),
        )
    };
    if posted.is_err() {
        drop(unsafe { Arc::from_raw(ptr) });
    }
}

#[implement(
    IPreviewHandler,
    IPreviewHandlerVisuals,
    IObjectWithSite,
    IOleWindow,
    IInitializeWithFile,
    IInitializeWithItem,
    windows::Win32::UI::Shell::PropertiesSystem::IInitializeWithStream
)]
struct PreviewHandler {
    state: Arc<Mutex<PreviewState>>,
}

impl Drop for PreviewHandler {
    fn drop(&mut self) {
        let remaining = ACTIVE_HANDLERS.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
        preview_log(&format!("handler drop remaining={}", remaining.saturating_sub(1)));
        if remaining == 1 {
            arm_idle_timeout();
        }
    }
}

fn pump_thread_id() -> u32 {
    PUMP_THREAD_ID.load(std::sync::atomic::Ordering::Relaxed)
}

fn arm_idle_timeout() {
    let tid = pump_thread_id();
    preview_log(&format!("arm idle timeout tid={tid}"));
    if tid != 0 {
        let posted = unsafe { PostThreadMessageW(tid, WM_APP_ARM_IDLE, WPARAM(0), LPARAM(0)) };
        preview_log(&format!("arm post ok={}", posted.is_ok()));
    }
}

fn disarm_idle_timeout() {
    let tid = pump_thread_id();
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_APP_DISARM_IDLE, WPARAM(0), LPARAM(0));
        }
    }
}

impl windows::Win32::UI::Shell::PropertiesSystem::IInitializeWithStream_Impl
    for PreviewHandler_Impl
{
    fn Initialize(&self, stream: windows::core::Ref<IStream>, _mode: u32) -> Result<()> {
        let has_stream = (*stream).is_some();
        preview_log(&format!("Initialize stream has_stream={has_stream}"));
        let mut state = self.state.lock().unwrap();
        state.stream = (*stream).clone();
        state.file_path = None;
        Ok(())
    }
}

impl IInitializeWithFile_Impl for PreviewHandler_Impl {
    fn Initialize(&self, file_path: &PCWSTR, _mode: u32) -> Result<()> {
        let path = unsafe { file_path.to_string() }.map(PathBuf::from).map_err(|error| {
            Error::new(E_NOINTERFACE, format!("Preview path is not readable: {error}"))
        })?;
        preview_log(&format!("Initialize file path={}", path.display()));
        let mut state = self.state.lock().unwrap();
        state.file_path = Some(path);
        state.stream = None;
        Ok(())
    }
}

impl IInitializeWithItem_Impl for PreviewHandler_Impl {
    fn Initialize(
        &self,
        item: windows::core::Ref<windows::Win32::UI::Shell::IShellItem>,
        _mode: u32,
    ) -> Result<()> {
        let path = (*item)
            .as_ref()
            .ok_or_else(|| Error::from(E_NOINTERFACE))
            .and_then(|shell_item| unsafe {
                shell_item
                    .GetDisplayName(SIGDN_FILESYSPATH)
                    .map_err(|error| error.into())
            })
            .and_then(|display| unsafe {
                display.to_string().map_err(|error| {
                    Error::new(E_NOINTERFACE, format!("Preview path is not readable: {error}"))
                })
            })
            .map(PathBuf::from)?;
        preview_log(&format!("Initialize item path={}", path.display()));
        let mut state = self.state.lock().unwrap();
        state.file_path = Some(path);
        state.stream = None;
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
        // COLORREF stores red in the low byte. Explorer supplies the current
        // pane background, which lets this native surface choose QuiviT's
        // matching light or dark palette without reaching into app settings.
        let red = color.0 & 0xff;
        let green = (color.0 >> 8) & 0xff;
        let blue = (color.0 >> 16) & 0xff;
        state.dark = red + green + blue < 384;
        let dark = state.dark;
        let custom_text = state.custom_text_color;
        if let Some(pane) = state.pane.as_mut() {
            pane.theme = Theme::from_dark(dark);
            if let Some(text_color) = custom_text {
                pane.theme.text = text_color;
            }
            let _ = unsafe { InvalidateRect(Some(pane.hwnd), None, false) };
        }
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
        if let Some(pane) = state.pane.as_mut() {
            pane.theme.text = color;
            let _ = unsafe { InvalidateRect(Some(pane.hwnd), None, false) };
        }
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
                state.pane.is_some()
            ));
            state.pane.is_some()
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
                state.pane.is_some()
            ));
            state.pane.is_some()
        };
        if has_pane {
            post_task(&self.state, TASK_POSITION);
        }
        Ok(())
    }

    fn DoPreview(&self) -> Result<()> {
        // The stream proxy is only valid on this calling thread (proven by
        // failed reads anywhere else), so materialize the listable path
        // here. Chunked sequential I/O only: no window calls, no locks held.
        // The recipe-blessed pattern: preview hosts expect DoPreview itself
        // to pull stream data.
        let (stream, file_path, dark, custom_font, custom_text_color) = {
            let state = lock_state(&self.state);
            if state.stream.is_none() && state.file_path.is_none() {
                preview_log("DoPreview no source");
                return Err(Error::new(
                    E_NOINTERFACE,
                    "Explorer did not provide preview data.",
                ));
            }
            (
                state.stream.clone(),
                state.file_path.clone(),
                state.dark,
                state.custom_font,
                state.custom_text_color,
            )
        };
        let materialized: Materialized =
            if let Some(stream) = stream.as_ref() {
                match copy_stream_to_temp(stream) {
                    Ok(Some((path, _))) => Materialized::List(path, true),
                    Ok(None) => Materialized::NotArchive,
                    Err(error) => Materialized::Failed(error),
                }
            } else if let Some(path) = file_path.as_ref() {
                match sniff_file_head(path) {
                    Ok(Some(_)) => Materialized::List(path.clone(), false),
                    Ok(None) => Materialized::NotArchive,
                    Err(error) => Materialized::Failed(error),
                }
            } else {
                Materialized::NotArchive
            };
        {
            let mut state = lock_state(&self.state);
            let epoch = PREVIEW_EPOCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            state.pending_preview = Some(PreviewParams {
                materialized,
                dark,
                epoch,
                custom_font,
                custom_text_color,
            });
            preview_log("DoPreview posted");
        }
        post_task(&self.state, TASK_CREATE);
        Ok(())
    }

    fn Unload(&self) -> Result<()> {
        preview_log("Unload");
        {
            let mut state = lock_state(&self.state);
            state.pending_preview = None;
            state.stream = None;
            state.file_path = None;
            state.site = None;
        }
        post_task(&self.state, TASK_TEARDOWN);
        Ok(())
    }

    fn SetFocus(&self) -> Result<()> {
        let state = lock_state(&self.state);
        if let Some(pane) = state.pane.as_ref() {
            if pane.hwnd.0.is_null() {
                return Err(Error::from(S_FALSE));
            }
            unsafe { SetFocus(Some(pane.hwnd))? };
            return Ok(());
        }
        Err(Error::from(S_FALSE))
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

fn destroy_pane(state: &mut PreviewState) {
    if let Some(pane) = state.pane.take() {
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
    a.left == b.left
        && a.top == b.top
        && a.right == b.right
        && a.bottom == b.bottom
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
    {
        let mut guard = lock_state(state);
        destroy_pane(&mut guard);
    }

    let mut pane = Box::new(PreviewPane::loading(
        params.dark,
        params.epoch,
        params.custom_font,
        params.custom_text_color,
    ));
    let worker_input = match params.materialized {
        Materialized::List(path, owns) => Some((path, owns)),
        Materialized::NotArchive => {
            pane.content = PreviewContent::Message(
                "This preview is available only for QuiviT archive types. Open this file in QuiviT."
                    .into(),
            );
            None
        }
        Materialized::Failed(error) => {
            pane.content =
                PreviewContent::Message(format!("Unable to open this archive: {error}"));
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
    // A SetRect can land while the child is being built; reconcile once so
    // the pane never sticks at a stale zero size.
    pump_position(state);
    if let Some((path, owns)) = worker_input {
        preview_log(&format!(
            "preview worker spawn owns={owns} path={}",
            path.display()
        ));
        spawn_preview_worker(path, owns, params.epoch, job, hwnd.0 as isize);
    } else {
        preview_log("preview worker skipped (message pane)");
    }
}

/// Repositions the live child on the pump thread. Skips work the host
/// already has.
fn pump_position(state: &Arc<Mutex<PreviewState>>) {
    let (hwnd, parent, area, move_needed) = {
        let mut guard = lock_state(state);
        let Some(hwnd) = guard.pane.as_ref().map(|pane| pane.hwnd) else {
            return;
        };
        let changed = guard.parent.0 != guard.applied_parent.0
            || !rect_equal(guard.rect, guard.applied_rect);
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
fn pump_teardown(state: &Arc<Mutex<PreviewState>>) {
    let mut guard = lock_state(state);
    guard.pending_preview = None;
    destroy_pane(&mut guard);
}

/// Copies a shell stream to a temp file in 64 KiB chunks, sniffing the first
/// chunk for the archive kind. Single pass with bounded memory; the listing
/// worker reads the temp file afterwards on its own thread.
fn copy_stream_to_temp(stream: &IStream) -> std::result::Result<Option<(PathBuf, usize)>, String> {
    use std::io::Write as _;

    unsafe { stream.Seek(0, STREAM_SEEK_SET, None) }.map_err(|error| error.to_string())?;
    let mut buffer = [0u8; 64 * 1024];
    let mut total = 0usize;
    let mut out: Option<(PathBuf, fs::File)> = None;
    loop {
        let mut read = 0u32;
        unsafe {
            stream
                .Read(
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                    Some(&mut read),
                )
                .ok()
        }
        .map_err(|error| error.to_string())?;
        if read == 0 {
            preview_log(&format!("stream read empty total={total}"));
            break;
        }
        let part = &buffer[..read as usize];
        if out.is_none() {
            preview_log(&format!(
                "stream first chunk len={} head={:02x?}",
                part.len(),
                &part[..part.len().min(8)]
            ));
        }
        total = total.saturating_add(part.len());
        if total > MAX_SOURCE_BYTES {
            if let Some((path, _)) = out.take() {
                let _ = fs::remove_file(path);
            }
            return Err("This file is too large for a File Explorer preview.".into());
        }
        if out.is_none() {
            match crate::formats::sniff_archive_ext(part) {                Some(extension) => {
                    let source_id =
                        PREVIEW_SOURCE_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let path = std::env::temp_dir().join(format!(
                        "QuiviT-preview-{}-{source_id}.{extension}",
                        std::process::id()
                    ));
                    let mut file =
                        fs::File::create(&path).map_err(|error| error.to_string())?;
                    file.write_all(part).map_err(|error| error.to_string())?;
                    out = Some((path, file));
                }
                None => return Ok(None),
            }
        } else if let Some((_, file)) = out.as_mut() {
            file.write_all(part).map_err(|error| error.to_string())?;
        }
    }
    Ok(out.map(|(path, _)| (path, total)))
}

fn sniff_file_head(path: &Path) -> std::result::Result<Option<&'static str>, String> {
    use std::io::Read as _;

    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut head = [0u8; 512];
    let mut read = 0usize;
    while read < head.len() {
        match file
            .read(&mut head[read..])
            .map_err(|error| error.to_string())?
        {
            0 => break,
            n => read += n,
        }
    }
    Ok(crate::formats::sniff_archive_ext(&head[..read]))
}

#[derive(Clone, Copy)]
struct Theme {
    bg: COLORREF,
    surface: COLORREF,
    border: COLORREF,
    text: COLORREF,
    muted: COLORREF,
    selected: COLORREF,
    selected_border: COLORREF,
    chevron: COLORREF,
}

impl Theme {
    fn from_dark(dark: bool) -> Self {
        if dark {
            Self {
                bg: color(25, 25, 25),
                surface: color(32, 32, 32),
                border: color(50, 50, 50),
                text: color(240, 240, 240),
                muted: color(150, 150, 150),
                selected: color(38, 50, 66),
                selected_border: color(65, 85, 115),
                chevron: color(160, 160, 160),
            }
        } else {
            Self {
                bg: color(255, 255, 255),
                surface: color(255, 255, 255),
                border: color(229, 229, 229),
                text: color(26, 26, 26),
                muted: color(112, 112, 112),
                selected: color(204, 232, 255),
                selected_border: color(153, 209, 255),
                chevron: color(112, 112, 112),
            }
        }
    }
}

const fn color(red: u8, green: u8, blue: u8) -> COLORREF {
    COLORREF(red as u32 | ((green as u32) << 8) | ((blue as u32) << 16))
}

struct TreeNode {
    label: String,
    is_file: bool,
    children: Vec<usize>,
    expanded: bool,
}

struct ArchivePreview {
    source_path: PathBuf,
    owns_source: bool,
    nodes: Vec<TreeNode>,
    selected: Option<usize>,
    scroll: usize,
}

impl Drop for ArchivePreview {
    fn drop(&mut self) {
        if self.owns_source {
            let _ = fs::remove_file(&self.source_path);
        }
    }
}

impl ArchivePreview {
    fn from_listed(
        source_path: PathBuf,
        owns_source: bool,
        files: Vec<crate::models::FileEntry>,
    ) -> Self {
        Self {
            source_path,
            owns_source,
            nodes: build_tree(files),
            selected: None,
            scroll: 0,
        }
    }

    fn visible_rows(&self) -> Vec<(usize, usize)> {
        let mut rows = Vec::new();
        append_visible_rows(&self.nodes, 0, 0, &mut rows);
        rows
    }

    fn activate(&mut self, node_id: usize) {
        let Some(node) = self.nodes.get_mut(node_id) else {
            return;
        };
        self.selected = Some(node_id);
        if !node.is_file {
            node.expanded = !node.expanded;
        }
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
        for part in &parts[..parts.len() - 1] {
            let key = (parent, (*part).to_string());
            parent = if let Some(existing) = folders.get(&key) {
                *existing
            } else {
                let id = nodes.len();
                nodes.push(TreeNode {
                    label: (*part).to_string(),
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
        left_node
            .is_file
            .cmp(&right_node.is_file)
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
            return if !hicon.is_invalid() { Some(hicon) } else { None };
        }

        let hicon = load_shell_icon(is_folder, ext);
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

struct PreviewPane {
    hwnd: HWND,
    theme: Theme,
    content: PreviewContent,
    epoch: u64,
    font: HFONT,
    icon_cache: IconCache,
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
        dark: bool,
        epoch: u64,
        custom_font: Option<LOGFONTW>,
        custom_text_color: Option<COLORREF>,
    ) -> Self {
        let mut theme = Theme::from_dark(dark);
        if let Some(tc) = custom_text_color {
            theme.text = tc;
        }
        let font = create_default_ui_font(custom_font.as_ref());
        Self {
            hwnd: HWND(std::ptr::null_mut()),
            theme,
            content: PreviewContent::Message("Loading archive contents...".into()),
            epoch,
            font,
            icon_cache: IconCache::new(),
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
    unsafe { GetModuleHandleW(None).map(|handle| handle.into()).unwrap_or_default() }
}

/// Lists one archive off the host thread. The result lands in the job slot
/// only for the preview that requested it; a superseded result is dropped,
/// which also removes its temp file through ArchivePreview.
fn spawn_preview_worker(
    list_path: PathBuf,
    owns_source: bool,
    epoch: u64,
    job: Arc<Mutex<PreviewJob>>,
    child_addr: isize,
) {
    std::thread::Builder::new()
        .name("quivit-preview-list".into())
        .spawn(move || {
            preview_log("preview worker start");
            let content = match crate::archives::list_archive_names(&list_path.to_string_lossy())
            {
                Ok(files) => {
                    preview_log(&format!("preview listed {} entries", files.len()));
                    PreviewContent::Archive(ArchivePreview::from_listed(
                        list_path,
                        owns_source,
                        files,
                    ))
                }
                Err(error) => {
                    if owns_source {
                        let _ = fs::remove_file(&list_path);
                    }
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
                let posted = unsafe {
                    PostMessageW(Some(child), WM_APP_PREVIEW_DONE, WPARAM(0), LPARAM(0))
                };
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
            let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            LRESULT(0)
        }
        WM_LBUTTONDOWN | WM_LBUTTONDBLCLK => {
            let _ = unsafe { SetFocus(Some(hwnd)) };
            handle_click(pane, lparam);
            let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            LRESULT(0)
        }
        WM_MOUSEWHEEL => {
            handle_wheel(pane, wparam);
            let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            LRESULT(0)
        }
        WM_KEYDOWN => {
            handle_key(pane, wparam.0 as u32);
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

fn handle_click(pane: &mut PreviewPane, lparam: LPARAM) {
    let y = ((lparam.0 as u32 >> 16) & 0xffff) as i16 as i32;
    let x = (lparam.0 as u32 & 0xffff) as i16 as i32;
    let PreviewContent::Archive(archive) = &mut pane.content else {
        return;
    };
    if y < HEADER_HEIGHT {
        return;
    }
    let row = (y - HEADER_HEIGHT) / ROW_HEIGHT + archive.scroll as i32;
    let rows = archive.visible_rows();
    if let Some((node_id, depth)) = rows.get(row.max(0) as usize) {
        let node_id = *node_id;
        let depth = *depth;
        let indent_x = MARGIN_LEFT + depth as i32 * INDENT_WIDTH;
        let chevron_left = indent_x;
        let chevron_right = indent_x + CHEVRON_WIDTH;

        let is_expandable = !archive.nodes[node_id].is_file && !archive.nodes[node_id].children.is_empty();

        if is_expandable && x >= chevron_left && x < chevron_right {
            archive.nodes[node_id].expanded = !archive.nodes[node_id].expanded;
            archive.selected = Some(node_id);
        } else {
            archive.activate(node_id);
        }
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
    let visible_count = ((client.bottom - client.top - HEADER_HEIGHT).max(0) / ROW_HEIGHT) as usize;
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
    let visible_count = ((client.bottom - client.top - HEADER_HEIGHT).max(0) / ROW_HEIGHT) as usize;

    match key {
        0x26 => archive.move_selection(-1, visible_count), // VK_UP
        0x28 => archive.move_selection(1, visible_count),  // VK_DOWN
        0x0d => {
            if let Some(selected) = archive.selected {
                archive.activate(selected);
            }
        }
        0x27 => {
            // VK_RIGHT: expand folder if collapsed, or move down
            if let Some(selected) = archive.selected {
                let node = &mut archive.nodes[selected];
                if !node.is_file && !node.children.is_empty() {
                    if !node.expanded {
                        node.expanded = true;
                    } else {
                        archive.move_selection(1, visible_count);
                    }
                }
            }
        }
        0x25 => {
            // VK_LEFT: collapse folder if expanded
            if let Some(selected) = archive.selected {
                let node = &mut archive.nodes[selected];
                if !node.is_file && node.expanded {
                    node.expanded = false;
                }
            }
        }
        _ => {}
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

fn log_paint(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    client: RECT,
    pane: &PreviewPane,
) {
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
    fill(hdc, client, pane.theme.bg);
    let old_font = if !pane.font.is_invalid() {
        Some(SelectObject(hdc, pane.font.into()))
    } else {
        None
    };

    let theme = pane.theme;
    match &pane.content {
        PreviewContent::Archive(archive) => {
            draw_archive(hdc, client, archive, &mut pane.icon_cache, theme)
        }
        PreviewContent::Message(message) => draw_message(hdc, client, message, theme),
    }

    if let Some(old) = old_font {
        SelectObject(hdc, old);
    }
}

unsafe fn draw_archive(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    client: RECT,
    archive: &ArchivePreview,
    icon_cache: &mut IconCache,
    theme: Theme,
) {
    fill(hdc, client, theme.surface);
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
    draw_text(
        hdc,
        "ARCHIVE CONTENTS",
        RECT {
            left: client.left + 12,
            top: client.top,
            right: client.right - 8,
            bottom: client.top + HEADER_HEIGHT,
        },
        theme.muted,
    );

    let rows = archive.visible_rows();
    let visible_height =
        (client.bottom - client.top - HEADER_HEIGHT).max(0) as usize / ROW_HEIGHT as usize + 1;
    for (view_index, (node_id, depth)) in rows
        .iter()
        .skip(archive.scroll)
        .take(visible_height)
        .enumerate()
    {
        let y = client.top + HEADER_HEIGHT + view_index as i32 * ROW_HEIGHT;
        let row = RECT {
            left: client.left,
            top: y,
            right: client.right,
            bottom: y + ROW_HEIGHT,
        };
        let node = &archive.nodes[*node_id];
        if archive.selected == Some(*node_id) {
            let sel_rect = RECT {
                left: client.left + 2,
                top: row.top + 1,
                right: client.right - 2,
                bottom: row.bottom - 1,
            };
            fill(hdc, sel_rect, theme.selected);
            draw_border(hdc, sel_rect, theme.selected_border);
        }

        let indent_x = client.left + MARGIN_LEFT + *depth as i32 * INDENT_WIDTH;

        // Chevron slot: only folders with children get an arrow chevron
        if !node.is_file && !node.children.is_empty() {
            let chevron_cx = indent_x + CHEVRON_WIDTH / 2;
            let chevron_cy = row.top + ROW_HEIGHT / 2;
            draw_chevron(hdc, chevron_cx, chevron_cy, node.expanded, theme.chevron);
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
                hdc,
                icon_x,
                icon_y,
                hicon,
                ICON_SIZE,
                ICON_SIZE,
                0,
                None,
                DI_NORMAL,
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
                right: client.right - 8,
                bottom: row.bottom,
            },
            theme.text,
        );
    }
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
            POINT { x: cx - 4, y: cy - 2 },
            POINT { x: cx, y: cy + 2 },
            POINT { x: cx + 4, y: cy - 2 },
        ];
        let pts2 = [
            POINT { x: cx - 4, y: cy - 1 },
            POINT { x: cx, y: cy + 3 },
            POINT { x: cx + 4, y: cy - 1 },
        ];
        let _ = Polyline(hdc, &pts1);
        let _ = Polyline(hdc, &pts2);
    } else {
        // Right-pointing chevron (collapsed)
        let pts1 = [
            POINT { x: cx - 2, y: cy - 4 },
            POINT { x: cx + 2, y: cy },
            POINT { x: cx - 2, y: cy + 4 },
        ];
        let pts2 = [
            POINT { x: cx - 1, y: cy - 4 },
            POINT { x: cx + 3, y: cy },
            POINT { x: cx - 1, y: cy + 4 },
        ];
        let _ = Polyline(hdc, &pts1);
        let _ = Polyline(hdc, &pts2);
    }

    SelectObject(hdc, old_pen);
    let _ = DeleteObject(pen.into());
}

unsafe fn draw_border(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    rect: RECT,
    color: COLORREF,
) {
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
    padded.top += 16;
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

unsafe fn fill(hdc: windows::Win32::Graphics::Gdi::HDC, rect: RECT, fill_color: COLORREF) {
    let brush = CreateSolidBrush(fill_color);
    FillRect(hdc, &rect, brush);
    let _ = DeleteObject(HGDIOBJ(brush.0));
}
