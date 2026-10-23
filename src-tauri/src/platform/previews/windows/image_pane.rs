use std::{
    borrow::Cow,
    cell::{Cell, RefCell},
    collections::VecDeque,
    fs::File,
    io::Read,
    num::NonZeroIsize,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        atomic::{AtomicBool, AtomicIsize, AtomicU32, AtomicUsize, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
};

use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment;
use windows::{
    core::{w, Error},
    Win32::{
        Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::Gdi::{
            BeginPaint, DrawTextW, EndPaint, FillRect, GetStockObject, InvalidateRect, SetBkMode,
            SetDCBrushColor, SetTextColor, DC_BRUSH, DT_CENTER, DT_NOPREFIX, DT_WORDBREAK, HBRUSH,
            HDC, PAINTSTRUCT, TRANSPARENT,
        },
        System::{Com::CoTaskMemFree, LibraryLoader::GetModuleHandleW},
        UI::{
            Input::KeyboardAndMouse::SetFocus,
            Shell::{FOLDERID_LocalAppDataLow, SHGetKnownFolderPath, KF_FLAG_CREATE},
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetWindowLongPtrW,
                KillTimer, LoadCursorW, PostMessageW, RegisterClassW, SetTimer, SetWindowLongPtrW,
                ShowWindow, CREATESTRUCTW, GWLP_USERDATA, IDC_ARROW, SW_HIDE, WINDOW_EX_STYLE,
                WM_APP, WM_ERASEBKGND, WM_NCCREATE, WM_NCDESTROY, WM_PAINT, WM_SIZE, WM_TIMER,
                WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_VISIBLE,
            },
        },
    },
};
use wry::{
    raw_window_handle::{
        HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle,
    },
    WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows,
};

use super::{
    bitmap::{paint_buffered, Bitmap},
    log_event,
};

const MAX_MEDIA_BYTES: u64 = 128 * 1024 * 1024;
const MEDIA_READ_CHUNK_BYTES: usize = 64 * 1024;
const MAX_PENDING_PREVIEWS: usize = 8;
const WM_MEDIA_READY: u32 = WM_APP + 20;
const WM_BACKGROUND: u32 = WM_APP + 21;
const WM_FOCUS: u32 = WM_APP + 22;
const WM_CANCEL: u32 = WM_APP + 23;
const READY_TIMER: usize = 1;
const ORIGIN: &str = "https://quivit-preview.localhost/";
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
const SVG_CSP: &str = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'";
static REGISTERED: OnceLock<Result<(), String>> = OnceLock::new();
static LOAD_QUEUE: OnceLock<Arc<LoadQueue>> = OnceLock::new();
static NEXT_WINDOW_ID: AtomicUsize = AtomicUsize::new(1);
thread_local! {
    static WEB_ENVIRONMENT: RefCell<Option<ICoreWebView2Environment>> = const { RefCell::new(None) };
    static BROWSER_BUILDING: Cell<bool> = const { Cell::new(false) };
}
struct BrowserBuild;
impl Drop for BrowserBuild {
    fn drop(&mut self) {
        BROWSER_BUILDING.with(|busy| busy.set(false));
    }
}

#[derive(Clone, Copy)]
pub(super) enum MediaKind {
    Raster(&'static str),
    Svg,
    Ico,
}

impl MediaKind {
    pub fn for_path(path: &Path) -> Option<Self> {
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "webp" => Some(Self::Raster("image/webp")),
            "apng" => Some(Self::Raster("image/png")),
            "avif" => Some(Self::Raster("image/avif")),
            "gif" => Some(Self::Raster("image/gif")),
            "svg" => Some(Self::Svg),
            "ico" => Some(Self::Ico),
            _ => None,
        }
    }
}

enum Payload {
    Media(Arc<[u8]>, &'static str),
    Ico(image::RgbaImage),
}
struct LoadJob {
    cancelled: AtomicBool,
    result: Mutex<Option<Result<Payload, String>>>,
}
struct LoadRequest {
    path: PathBuf,
    kind: MediaKind,
    job: Arc<LoadJob>,
    hwnd: isize,
}
struct LoadQueue {
    pending: Mutex<VecDeque<LoadRequest>>,
    wake: Condvar,
}

fn queue_media(request: LoadRequest) {
    let queue = LOAD_QUEUE.get_or_init(|| {
        let queue = Arc::new(LoadQueue {
            pending: Mutex::new(VecDeque::<LoadRequest>::new()),
            wake: Condvar::new(),
        });
        let worker = queue.clone();
        std::thread::spawn(move || loop {
            let request = {
                let mut pending = worker
                    .pending
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                while pending.is_empty() {
                    pending = worker
                        .wake
                        .wait(pending)
                        .unwrap_or_else(|error| error.into_inner());
                }
                pending.pop_front().unwrap()
            };
            if request.job.cancelled.load(Ordering::Acquire) {
                continue;
            }
            let result = load_media(&request.path, request.kind, &request.job.cancelled);
            complete_request(request, result);
        });
        queue
    });
    let mut pending = queue
        .pending
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    pending.retain(|request| !request.job.cancelled.load(Ordering::Acquire));
    if pending.len() == MAX_PENDING_PREVIEWS {
        drop(pending);
        complete_request(
            request,
            Err("Too many previews are loading. Select this file again.".into()),
        );
        return;
    }
    pending.push_back(request);
    drop(pending);
    queue.wake.notify_one();
}

fn complete_request(request: LoadRequest, result: Result<Payload, String>) {
    if request.job.cancelled.load(Ordering::Acquire) {
        return;
    }
    if let Ok(mut slot) = request.job.result.lock() {
        *slot = Some(result);
    }
    if !request.job.cancelled.load(Ordering::Acquire) {
        unsafe {
            let _ = PostMessageW(
                Some(HWND(request.hwnd as _)),
                WM_MEDIA_READY,
                WPARAM(0),
                LPARAM(0),
            );
        }
    }
}
struct WindowState {
    id: usize,
    background: Arc<AtomicU32>,
    hwnd: AtomicIsize,
    message: RefCell<Vec<u16>>,
    job: Arc<LoadJob>,
    bitmap: RefCell<Option<Bitmap>>,
    webview: RefCell<Option<Rc<WebView>>>,
}

impl WindowState {
    fn hwnd(&self) -> HWND {
        HWND(self.hwnd.load(Ordering::Acquire) as _)
    }
}

pub(super) struct ImagePane {
    state: Rc<WindowState>,
}

impl Drop for WindowState {
    fn drop(&mut self) {
        self.webview.get_mut().take();
        let hwnd = self.hwnd();
        if !hwnd.0.is_null() {
            unsafe {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                let _ = DestroyWindow(hwnd);
            }
        }
    }
}

struct Parent(HWND);
impl HasWindowHandle for Parent {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let handle = NonZeroIsize::new(self.0 .0 as isize).ok_or(HandleError::Unavailable)?;
        Ok(unsafe {
            WindowHandle::borrow_raw(RawWindowHandle::Win32(Win32WindowHandle::new(handle)))
        })
    }
}

impl ImagePane {
    pub fn create(
        parent: HWND,
        area: RECT,
        path: PathBuf,
        kind: MediaKind,
        background: COLORREF,
    ) -> Result<Self, String> {
        register_window()?;
        let job = Arc::new(LoadJob {
            cancelled: AtomicBool::new(false),
            result: Mutex::new(None),
        });
        let state = Rc::new(WindowState {
            id: NEXT_WINDOW_ID.fetch_add(1, Ordering::Relaxed),
            background: Arc::new(AtomicU32::new(background.0)),
            hwnd: AtomicIsize::new(0),
            message: RefCell::new(Vec::new()),
            job: job.clone(),
            bitmap: RefCell::new(None),
            webview: RefCell::new(None),
        });
        let instance = unsafe { GetModuleHandleW(None) }.map_err(|error| error.to_string())?;
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("QuiviTImagePreview"),
                w!(""),
                WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                area.left,
                area.top,
                (area.right - area.left).max(0),
                (area.bottom - area.top).max(0),
                Some(parent),
                None,
                Some(HINSTANCE(instance.0)),
                Some(Rc::as_ptr(&state).cast()),
            )
        }
        .map_err(|error| error.to_string())?;
        state.hwnd.store(hwnd.0 as isize, Ordering::Release);
        queue_media(LoadRequest {
            path,
            kind,
            job,
            hwnd: hwnd.0 as isize,
        });
        Ok(Self { state })
    }

    pub fn hwnd(&self) -> HWND {
        self.state.hwnd()
    }

    fn post(&self, message: u32, value: WPARAM) {
        let hwnd = self.hwnd();
        if hwnd.0.is_null() {
            return;
        }
        unsafe {
            let _ = PostMessageW(Some(hwnd), message, value, LPARAM(self.state.id as isize));
        }
    }

    pub fn cancel(&self) {
        self.state.job.cancelled.store(true, Ordering::Release);
        self.post(WM_CANCEL, WPARAM(0));
    }

    pub fn set_background(&mut self, color: COLORREF) {
        self.post(WM_BACKGROUND, WPARAM(color.0 as usize));
    }

    pub fn focus(&self) {
        self.post(WM_FOCUS, WPARAM(0));
    }
}

impl Drop for ImagePane {
    fn drop(&mut self) {
        self.state.job.cancelled.store(true, Ordering::Release);
        let view = self.state.webview.borrow_mut().take();
        drop(view);
        unsafe {
            let _ = ShowWindow(self.hwnd(), SW_HIDE);
        }
    }
}

fn load_media(path: &Path, kind: MediaKind, cancelled: &AtomicBool) -> Result<Payload, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() > MAX_MEDIA_BYTES {
        return Err("Image exceeds the preview size limit.".into());
    }
    let mut bytes = Vec::new();
    let mut file = file.take(MAX_MEDIA_BYTES + 1);
    let mut chunk = [0u8; MEDIA_READ_CHUNK_BYTES];
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err("Preview cancelled.".into());
        }
        let count = file.read(&mut chunk).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    if bytes.len() as u64 > MAX_MEDIA_BYTES {
        return Err("Image exceeds the preview size limit.".into());
    }
    match kind {
        MediaKind::Ico => crate::ico::ico_spritesheet_from_bytes(&bytes).map(Payload::Ico),
        MediaKind::Svg => Ok(Payload::Media(bytes.into(), "image/svg+xml")),
        MediaKind::Raster(mime) => Ok(Payload::Media(bytes.into(), mime)),
    }
}

fn register_window() -> Result<(), String> {
    REGISTERED
        .get_or_init(|| unsafe {
            let instance = GetModuleHandleW(None).map_err(|error| error.to_string())?;
            let class = WNDCLASSW {
                lpfnWndProc: Some(window_proc),
                hInstance: HINSTANCE(instance.0),
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                lpszClassName: w!("QuiviTImagePreview"),
                ..Default::default()
            };
            if RegisterClassW(&class) == 0 {
                Err(Error::from_thread().to_string())
            } else {
                Ok(())
            }
        })
        .clone()
}

fn css_color(color: u32) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        color & 255,
        (color >> 8) & 255,
        (color >> 16) & 255
    )
}
fn rgba(color: u32) -> (u8, u8, u8, u8) {
    (color as u8, (color >> 8) as u8, (color >> 16) as u8, 255)
}
fn foreground(color: u32) -> &'static str {
    if (color & 255) + ((color >> 8) & 255) + ((color >> 16) & 255) > 384 {
        "#202020"
    } else {
        "#eeeeee"
    }
}

fn create_webview(
    hwnd: HWND,
    media: Arc<[u8]>,
    mime: &'static str,
    background: Arc<AtomicU32>,
) -> Result<WebView, String> {
    // Explorer can activate the local server with its low-integrity token.
    let root = unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppDataLow, KF_FLAG_CREATE, None) }
        .map_err(|error| error.to_string())?;
    let folder = unsafe { root.to_string() }.map(PathBuf::from);
    unsafe { CoTaskMemFree(Some(root.0.cast())) };
    let folder = folder
        .map_err(|error| error.to_string())?
        .join("QuiviT")
        .join("preview-webview");
    let mut context = WebContext::new(Some(folder));
    let color = background.load(Ordering::Acquire);
    let parent = Parent(hwnd);
    let mut area = RECT::default();
    unsafe { GetClientRect(hwnd, &mut area) }.map_err(|error| error.to_string())?;
    let mut builder = WebViewBuilder::new_with_web_context(&mut context);
    if let Some(environment) = WEB_ENVIRONMENT.with(|slot| slot.borrow().clone()) {
        builder = builder.with_environment(environment);
    }
    let view = builder
        .with_focused(false)
        .with_additional_browser_args("--block-new-web-contents")
        .with_bounds(wry::Rect {
            position: wry::dpi::PhysicalPosition::new(0, 0).into(),
            size: wry::dpi::PhysicalSize::new(area.right.max(1) as u32, area.bottom.max(1) as u32)
                .into(),
        })
        .with_https_scheme(true)
        .with_background_color(rgba(color))
        .with_devtools(cfg!(debug_assertions))
        .with_default_context_menus(false)
        .with_browser_accelerator_keys(false)
        .with_navigation_handler(|url| url == ORIGIN || url == "quivit-preview://localhost/")
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
        .with_download_started_handler(|_, _| false)
        .with_custom_protocol("quivit-preview".into(), move |_, request| {
            let (status, content_type, body): (_, _, Cow<'static, [u8]>) =
                match request.uri().path() {
                    "/" => (
                        200,
                        "text/html; charset=utf-8",
                        Cow::Borrowed(include_bytes!("preview_player.html")),
                    ),
                    "/preview_player.css" => (
                        200,
                        "text/css; charset=utf-8",
                        Cow::Owned(
                            include_str!("preview_player.css")
                                .replace(
                                    "__BACKGROUND__",
                                    &css_color(background.load(Ordering::Acquire)),
                                )
                                .replace(
                                    "__FOREGROUND__",
                                    foreground(background.load(Ordering::Acquire)),
                                )
                                .into_bytes(),
                        ),
                    ),
                    "/preview_player.js" => (
                        200,
                        "text/javascript; charset=utf-8",
                        Cow::Borrowed(include_bytes!("preview_player.js")),
                    ),
                    "/media" => (200, mime, Cow::Owned(media.to_vec())),
                    _ => (404, "text/plain", Cow::Borrowed(b"Not found")),
                };
            wry::http::Response::builder()
                .status(status)
                .header("Content-Type", content_type)
                .header("Cache-Control", "no-store")
                .header(
                    "Content-Security-Policy",
                    if request.uri().path() == "/media" && mime == "image/svg+xml" {
                        SVG_CSP
                    } else {
                        CSP
                    },
                )
                .header("X-Content-Type-Options", "nosniff")
                .body(body)
                .unwrap()
        })
        .with_url("quivit-preview://localhost/")
        .build_as_child(&parent)
        .map_err(|error| format!("Browser controller: {error}"))?;
    WEB_ENVIRONMENT.with(|slot| *slot.borrow_mut() = Some(view.environment()));
    Ok(view)
}

unsafe fn media_ready(hwnd: HWND, state: &Rc<WindowState>) {
    if state.job.cancelled.load(Ordering::Acquire) {
        return;
    }
    if BROWSER_BUILDING.with(Cell::get) {
        SetTimer(Some(hwnd), READY_TIMER, 50, None);
        return;
    }
    let _ = KillTimer(Some(hwnd), READY_TIMER);
    let result = state
        .job
        .result
        .lock()
        .ok()
        .and_then(|mut slot| slot.take());
    let Some(result) = result else {
        return;
    };
    let result = match result {
        Ok(Payload::Ico(image)) => Bitmap::new(&image)
            .map(|bitmap| {
                *state.bitmap.borrow_mut() = Some(bitmap);
            })
            .map_err(|error| error.to_string()),
        Ok(Payload::Media(bytes, mime)) => {
            BROWSER_BUILDING.with(|busy| busy.set(true));
            let _building = BrowserBuild;
            create_webview(hwnd, bytes, mime, state.background.clone()).map(|view| {
                if !state.job.cancelled.load(Ordering::Acquire) {
                    *state.webview.borrow_mut() = Some(Rc::new(view));
                    resize_webview(hwnd, &state);
                }
            })
        }
        Err(error) => Err(error),
    };
    if state.job.cancelled.load(Ordering::Acquire) {
        return;
    }
    match result {
        Ok(()) => {
            state.message.borrow_mut().clear();
            log_event("image preview ready");
        }
        Err(error) => {
            log_event(&format!("image preview error: {error}"));
            *state.message.borrow_mut() = format!("Unable to display this preview: {error}")
                .encode_utf16()
                .collect();
        }
    }
    let _ = InvalidateRect(Some(hwnd), None, false);
}

unsafe fn resize_webview(hwnd: HWND, state: &WindowState) {
    let view = state.webview.borrow().clone();
    if let Some(view) = view {
        let mut area = RECT::default();
        let _ = GetClientRect(hwnd, &mut area);
        let _ = view.set_bounds(wry::Rect {
            position: wry::dpi::PhysicalPosition::new(0, 0).into(),
            size: wry::dpi::PhysicalSize::new(area.right.max(0) as u32, area.bottom.max(0) as u32)
                .into(),
        });
    }
}

unsafe fn paint_content(hdc: HDC, area: RECT, state: &WindowState) {
    let color = state.background.load(Ordering::Acquire);
    let bitmap = state.bitmap.borrow();
    let mut message = state.message.borrow_mut();
    let fill_background = |target| {
        SetDCBrushColor(target, COLORREF(color));
        FillRect(target, &area, HBRUSH(GetStockObject(DC_BRUSH).0));
    };
    if bitmap.is_none() && message.is_empty() {
        fill_background(hdc);
        return;
    }
    paint_buffered(hdc, area, |buffer| {
        fill_background(buffer);
        if let Some(bitmap) = bitmap.as_ref() {
            bitmap.paint(buffer, area);
        } else {
            SetBkMode(buffer, TRANSPARENT);
            let light = (color & 255) + ((color >> 8) & 255) + ((color >> 16) & 255) > 384;
            SetTextColor(buffer, COLORREF(if light { 0x202020 } else { 0xeeeeee }));
            let mut text_area = area;
            text_area.left += 16;
            text_area.right -= 16;
            text_area.top += 24;
            DrawTextW(
                buffer, &mut message, &mut text_area, DT_CENTER | DT_NOPREFIX | DT_WORDBREAK,
            );
        }
    });
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let create = &*(lparam.0 as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
    }
    let pointer = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const WindowState;
    if pointer.is_null() {
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
    // WebView calls can pump messages that unload this same pane.
    Rc::increment_strong_count(pointer);
    let state = Rc::from_raw(pointer);
    if matches!(message, WM_BACKGROUND | WM_FOCUS | WM_CANCEL) && lparam.0 as usize != state.id {
        return LRESULT(0);
    }
    if message == WM_MEDIA_READY || (message == WM_TIMER && wparam.0 == READY_TIMER) {
        media_ready(hwnd, &state);
        return LRESULT(0);
    }
    match message {
        WM_CANCEL => {
            let _ = ShowWindow(hwnd, SW_HIDE);
            LRESULT(0)
        }
        WM_BACKGROUND => {
            let color = wparam.0 as u32;
            state.background.store(color, Ordering::Release);
            let view = state.webview.borrow().clone();
            if let Some(view) = view {
                let _ = view.set_background_color(rgba(color));
                let _ = view.evaluate_script(&format!("document.documentElement.style.setProperty('--preview-background','{}');document.documentElement.style.setProperty('--preview-foreground','{}')", css_color(color), foreground(color)));
            }
            let _ = InvalidateRect(Some(hwnd), None, false);
            LRESULT(0)
        }
        WM_FOCUS => {
            let view = state.webview.borrow().clone();
            if let Some(view) = view {
                let _ = view.focus();
            } else {
                let _ = SetFocus(Some(hwnd));
            }
            LRESULT(0)
        }
        WM_ERASEBKGND => {
            let mut area = RECT::default();
            let _ = GetClientRect(hwnd, &mut area);
            paint_content(HDC(wparam.0 as _), area, &state);
            LRESULT(1)
        }
        WM_SIZE => {
            resize_webview(hwnd, &state);
            let _ = InvalidateRect(Some(hwnd), None, false);
            LRESULT(0)
        }
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let hdc = BeginPaint(hwnd, &mut paint);
            let mut area = RECT::default();
            let _ = GetClientRect(hwnd, &mut area);
            paint_content(hdc, area, &state);
            let _ = EndPaint(hwnd, &paint);
            LRESULT(0)
        }
        WM_NCDESTROY => {
            state.hwnd.store(0, Ordering::Release);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            DefWindowProcW(hwnd, message, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}
