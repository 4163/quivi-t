use crate::models::{DropEvent, DropPayload};
use std::{
    cell::{Cell, RefCell},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use windows::core::{implement, AgileReference, Interface, Ref, BOOL, HRESULT};
use windows::Win32::Foundation::{CloseHandle, HGLOBAL, HWND, LPARAM, POINTL, S_OK};
use windows::Win32::System::Com::{
    CoCreateGuid, CoInitializeEx, CoUninitialize, IDataObject, COINIT_MULTITHREADED,
    DVASPECT_CONTENT, FORMATETC, STGMEDIUM, STREAM_SEEK_SET, TYMED_HGLOBAL, TYMED_ISTREAM,
};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::{
    IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop, CF_DIB,
    CF_DIBV5, CF_HDROP, CF_TEXT, CF_UNICODETEXT, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Shell::{
    DragQueryFileW, IDataObjectAsyncCapability, FILEDESCRIPTORW, FILEGROUPDESCRIPTORW, HDROP,
};
use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

const CAPTURE_LIFETIME: Duration = Duration::from_secs(120);
const SOURCE_TIMEOUT: Duration = Duration::from_secs(60);
const STREAM_CHUNK_BYTES: usize = 64 * 1024;
const MAX_DESCRIPTOR_BYTES: usize = 64 * 1024;

struct Formats {
    descriptor: u16,
    contents: u16,
    png: u16,
    mime_png: u16,
    url_w: u16,
    url_a: u16,
    uri_list: u16,
    text: u16,
    html: u16,
}
impl Formats {
    fn new() -> Self {
        let register = |name: &str| {
            let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            unsafe { RegisterClipboardFormatW(windows::core::PCWSTR(wide.as_ptr())) as u16 }
        };
        Self {
            descriptor: register("FileGroupDescriptorW"),
            contents: register("FileContents"),
            png: register("PNG"),
            mime_png: register("image/png"),
            url_w: register("UniformResourceLocatorW"),
            url_a: register("UniformResourceLocator"),
            uri_list: register("text/uri-list"),
            text: register("text/plain"),
            html: register("HTML Format"),
        }
    }
    fn accepts(&self, object: &IDataObject) -> bool {
        [
            self.descriptor,
            self.png,
            self.mime_png,
            CF_DIBV5.0,
            CF_DIB.0,
            CF_HDROP.0,
            self.url_w,
            self.url_a,
            self.uri_list,
            self.text,
            CF_UNICODETEXT.0,
            CF_TEXT.0,
        ]
        .iter()
        .any(|id| offers_global(object, *id))
    }
}
struct Registry {
    enabled: bool,
    installed: bool,
    worker_running: bool,
    pending: Option<Pending>,
}
struct Pending {
    id: String,
    created: Instant,
    cancelled: Arc<AtomicBool>,
    payload: Option<Payload>,
    consuming: bool,
}
enum Payload {
    Path(String),
    Url(String),
    Capture(Capture),
}
pub struct Capture {
    pub path: PathBuf,
    pub dib: bool,
}
impl Drop for Capture {
    fn drop(&mut self) {
        for path in [
            &self.path,
            &self.path.with_extension("png"),
            &self.path.with_extension("svg"),
        ] {
            let _ = fs::remove_file(path);
        }
    }
}
pub struct CaptureLease {
    pub capture: Capture,
    pub cancelled: Arc<AtomicBool>,
    id: String,
}
impl Drop for CaptureLease {
    fn drop(&mut self) {
        release(&self.id);
    }
}
fn registry() -> &'static Mutex<Registry> {
    static STATE: OnceLock<Mutex<Registry>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(Registry {
            enabled: false,
            installed: false,
            worker_running: false,
            pending: None,
        })
    })
}
fn emit(app: &tauri::AppHandle, phase: &'static str, id: Option<String>, message: Option<String>) {
    let _ = app.emit_to(
        "main",
        "quivit-drop",
        DropEvent {
            phase,
            drop_id: id,
            message,
        },
    );
}
pub fn enable() -> Result<(), String> {
    let mut state = registry().lock().unwrap();
    if !state.installed {
        return Err("Native drop handler is not ready".into());
    }
    state.enabled = true;
    Ok(())
}
pub fn release(id: &str) {
    let mut state = registry().lock().unwrap();
    if state.pending.as_ref().is_some_and(|p| p.id == id) {
        if let Some(pending) = state.pending.take() {
            pending.cancelled.store(true, Ordering::SeqCst);
        }
    }
}
pub fn describe(id: &str) -> Result<DropPayload, String> {
    let state = registry().lock().unwrap();
    let pending = state
        .pending
        .as_ref()
        .filter(|p| p.id == id && !p.consuming && !p.cancelled.load(Ordering::SeqCst))
        .ok_or("Drop is expired or already consumed")?;
    match pending
        .payload
        .as_ref()
        .ok_or("Drop content is not ready")?
    {
        Payload::Path(path) => Ok(DropPayload::Path { path: path.clone() }),
        Payload::Url(url) => Ok(DropPayload::Url { url: url.clone() }),
        Payload::Capture(capture) => Ok(DropPayload::Capture {
            svg_text: if capture.dib {
                None
            } else {
                crate::image_import::svg_text(&capture.path)?
            },
        }),
    }
}
pub fn claim(id: &str) -> Result<CaptureLease, String> {
    let mut state = registry().lock().unwrap();
    let pending = state
        .pending
        .as_mut()
        .filter(|p| p.id == id && !p.consuming && !p.cancelled.load(Ordering::SeqCst))
        .ok_or("Drop is expired or already consumed")?;
    if !matches!(pending.payload, Some(Payload::Capture(_))) {
        return Err("Drop does not contain an image capture".into());
    }
    let Some(Payload::Capture(capture)) = pending.payload.take() else {
        unreachable!()
    };
    pending.consuming = true;
    Ok(CaptureLease {
        capture,
        cancelled: pending.cancelled.clone(),
        id: id.into(),
    })
}
struct RegisteredTarget {
    hwnd: HWND,
    _target: IDropTarget,
}
impl Drop for RegisteredTarget {
    fn drop(&mut self) {
        let _ = unsafe { RevokeDragDrop(self.hwnd) };
    }
}
thread_local! { static TARGETS: RefCell<Vec<RegisteredTarget>> = const { RefCell::new(Vec::new()) }; }
pub fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as usize;
    let app = window.app_handle().clone();
    let watchdog_app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let expired = {
            let mut state = registry().lock().unwrap();
            let deadline = if state.worker_running {
                SOURCE_TIMEOUT
            } else {
                CAPTURE_LIFETIME
            };
            if state
                .pending
                .as_ref()
                .is_some_and(|p| p.created.elapsed() > deadline)
            {
                state.pending.take().map(|p| {
                    p.cancelled.store(true, Ordering::SeqCst);
                    p.id
                })
            } else {
                None
            }
        };
        if let Some(id) = expired {
            emit(
                &watchdog_app,
                "failed",
                Some(id),
                Some("Image transfer timed out".into()),
            );
        }
    });
    std::thread::spawn(cleanup_abandoned_captures);
    window
        .with_webview(move |_| {
            let mut context = InstallContext {
                app,
                formats: Arc::new(Formats::new()),
                targets: Vec::new(),
            };
            unsafe {
                let root = HWND(hwnd as *mut _);
                install_target(root, &mut context);
                let _ = EnumChildWindows(
                    Some(root),
                    Some(install_child),
                    LPARAM(&mut context as *mut _ as isize),
                );
            }
            registry().lock().unwrap().installed = !context.targets.is_empty();
            TARGETS.with(|targets| targets.borrow_mut().extend(context.targets));
        })
        .map_err(|e| e.to_string())
}
pub fn shutdown() {
    let mut state = registry().lock().unwrap();
    state.enabled = false;
    if let Some(pending) = state.pending.take() {
        pending.cancelled.store(true, Ordering::SeqCst);
    }
    drop(state);
    TARGETS.with(|targets| targets.borrow_mut().clear());
}
struct InstallContext {
    app: tauri::AppHandle,
    formats: Arc<Formats>,
    targets: Vec<RegisteredTarget>,
}
unsafe extern "system" fn install_child(hwnd: HWND, context: LPARAM) -> BOOL {
    install_target(hwnd, &mut *(context.0 as *mut InstallContext));
    BOOL(1)
}
unsafe fn install_target(hwnd: HWND, context: &mut InstallContext) {
    let target: IDropTarget = NativeTarget {
        app: context.app.clone(),
        formats: context.formats.clone(),
        hovering: Cell::new(false),
    }
    .into();
    let _ = RevokeDragDrop(hwnd);
    if RegisterDragDrop(hwnd, &target).is_ok() {
        context.targets.push(RegisteredTarget {
            hwnd,
            _target: target,
        });
    }
}
#[implement(IDropTarget)]
struct NativeTarget {
    app: tauri::AppHandle,
    formats: Arc<Formats>,
    hovering: Cell<bool>,
}
#[allow(non_snake_case)]
impl IDropTarget_Impl for NativeTarget_Impl {
    fn DragEnter(
        &self,
        object: Ref<'_, IDataObject>,
        _: MODIFIERKEYS_FLAGS,
        _: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let available = {
            let state = registry().lock().unwrap();
            state.enabled && !state.worker_running && state.pending.is_none()
        };
        let accepts = available && object.as_ref().is_some_and(|o| self.formats.accepts(o));
        self.hovering.set(accepts);
        unsafe {
            *effect = if accepts {
                DROPEFFECT_COPY
            } else {
                DROPEFFECT_NONE
            };
        }
        if accepts {
            emit(&self.app, "entered", None, None);
        }
        Ok(())
    }
    fn DragOver(
        &self,
        _: MODIFIERKEYS_FLAGS,
        _: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        unsafe {
            *effect = if self.hovering.get() {
                DROPEFFECT_COPY
            } else {
                DROPEFFECT_NONE
            };
        }
        Ok(())
    }
    fn DragLeave(&self) -> windows::core::Result<()> {
        self.hovering.set(false);
        emit(&self.app, "left", None, None);
        Ok(())
    }
    fn Drop(
        &self,
        object: Ref<'_, IDataObject>,
        _: MODIFIERKEYS_FLAGS,
        _: &POINTL,
        effect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        self.hovering.set(false);
        unsafe {
            *effect = DROPEFFECT_NONE;
        }
        let Some(object) = object.as_ref() else {
            return Ok(());
        };
        let id = format!("{:?}", unsafe { CoCreateGuid()? });
        let reference = AgileReference::new(object)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut state = registry().lock().unwrap();
            if !state.enabled || state.worker_running || state.pending.is_some() {
                return Ok(());
            }
            state.worker_running = true;
            state.pending = Some(Pending {
                id: id.clone(),
                created: Instant::now(),
                cancelled: cancelled.clone(),
                payload: None,
                consuming: false,
            });
        }
        // Keep browser-managed downloads alive until their data has been consumed.
        let asynchronous = object
            .cast::<IDataObjectAsyncCapability>()
            .ok()
            .filter(|a| unsafe { a.SetAsyncMode(true).is_ok() && a.StartOperation(None).is_ok() });
        let async_reference = asynchronous
            .as_ref()
            .and_then(|a| AgileReference::new(a).ok());
        if asynchronous.is_some() && async_reference.is_none() {
            if let Some(a) = asynchronous {
                let _ = unsafe { a.EndOperation(HRESULT(0x80004004u32 as i32), None, 0) };
            }
            release(&id);
            registry().lock().unwrap().worker_running = false;
            return Ok(());
        }
        emit(&self.app, "accepted", Some(id.clone()), None);
        let app = self.app.clone();
        let formats = self.formats.clone();
        std::thread::spawn(move || {
            let result = ComApartment::new().and_then(|_apartment| {
                // Release marshaled owners before this scope's COM apartment.
                let data_reference = reference;
                let operation_reference = async_reference;
                let result = data_reference
                    .resolve()
                    .map_err(|e| e.to_string())
                    .and_then(|object| receive(&object, &formats, &cancelled));
                if let Some(a) = operation_reference.and_then(|a| a.resolve().ok()) {
                    let code = if result.is_ok() {
                        HRESULT(0)
                    } else {
                        HRESULT(0x80004005u32 as i32)
                    };
                    let _ = unsafe { a.EndOperation(code, None, DROPEFFECT_COPY.0) };
                }
                result
            });
            let mut state = registry().lock().unwrap();
            state.worker_running = false;
            if cancelled.load(Ordering::SeqCst) {
                return;
            }
            let Some(pending) = state.pending.as_mut().filter(|p| p.id == id) else {
                return;
            };
            match result {
                Ok(payload) => {
                    pending.payload = Some(payload);
                    drop(state);
                    emit(&app, "ready", Some(id), None);
                }
                Err(message) => {
                    state.pending.take();
                    drop(state);
                    emit(&app, "failed", Some(id), Some(message));
                }
            }
        });
        unsafe {
            *effect = DROPEFFECT_COPY;
        }
        Ok(())
    }
}
struct ComApartment;
impl ComApartment {
    fn new() -> Result<Self, String> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|e| e.to_string())?;
        Ok(Self)
    }
}
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}
fn format(id: u16, tymed: u32, index: i32) -> FORMATETC {
    FORMATETC {
        cfFormat: id,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: index,
        tymed,
    }
}
fn offers_global(object: &IDataObject, id: u16) -> bool {
    // Shell data objects can report an unavailable format with S_FALSE.
    unsafe { object.QueryGetData(&format(id, TYMED_HGLOBAL.0 as u32, -1)) == S_OK }
}
struct Medium(STGMEDIUM);
impl Drop for Medium {
    fn drop(&mut self) {
        unsafe { ReleaseStgMedium(&mut self.0) }
    }
}
fn get(object: &IDataObject, id: u16, tymed: u32, index: i32) -> Result<Medium, String> {
    unsafe { object.GetData(&format(id, tymed, index)) }
        .map(Medium)
        .map_err(|e| e.to_string())
}
fn global_bytes(handle: HGLOBAL, limit: usize) -> Result<Vec<u8>, String> {
    let size = unsafe { GlobalSize(handle) };
    if size == 0 || size > limit {
        return Err("Dropped data exceeds its size limit".into());
    }
    let pointer = unsafe { GlobalLock(handle) };
    if pointer.is_null() {
        return Err("Unable to access dropped data".into());
    }
    let bytes = unsafe { std::slice::from_raw_parts(pointer as *const u8, size) }.to_vec();
    let _ = unsafe { GlobalUnlock(handle) };
    Ok(bytes)
}
fn new_capture(dib: bool) -> Result<(Capture, File), String> {
    let guid = unsafe { CoCreateGuid() }.map_err(|e| e.to_string())?;
    let path =
        std::env::temp_dir().join(format!("quivit-drop-{}-{guid:?}.bin", std::process::id()));
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    Ok((Capture { path, dib }, file))
}

fn cleanup_abandoned_captures() {
    let Ok(entries) = fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some((pid, _)) = name
            .strip_prefix("quivit-drop-")
            .and_then(|s| s.split_once('-'))
        else {
            continue;
        };
        let Ok(pid) = pid.parse::<u32>() else {
            continue;
        };
        if pid == std::process::id() || !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        if !matches!(
            entry.path().extension().and_then(|s| s.to_str()),
            Some("bin" | "png" | "svg")
        ) {
            continue;
        }
        match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
            Ok(handle) => {
                let _ = unsafe { CloseHandle(handle) };
            }
            Err(error) if error.code().0 as u32 & 0xffff == 87 => {
                let _ = fs::remove_file(entry.path());
            }
            Err(_) => {}
        }
    }
}

fn dropped_path(object: &IDataObject) -> Option<String> {
    let medium = get(object, CF_HDROP.0, TYMED_HGLOBAL.0 as u32, -1).ok()?;
    let handle = HDROP(unsafe { medium.0.u.hGlobal }.0);
    let length = unsafe { DragQueryFileW(handle, 0, None) };
    if length == 0 || length >= 32768 {
        return None;
    }
    let mut path = vec![0; length as usize + 1];
    unsafe {
        DragQueryFileW(handle, 0, Some(&mut path));
    }
    Some(String::from_utf16_lossy(&path[..length as usize]))
}
fn check_cancel(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        Err("Drop cancelled".into())
    } else {
        Ok(())
    }
}
fn stage_medium(medium: Medium, dib: bool, cancelled: &AtomicBool) -> Result<Capture, String> {
    let (capture, mut file) = new_capture(dib)?;
    let limit = if dib {
        crate::image_import::MAX_BITMAP_BYTES
    } else {
        crate::image_import::MAX_CAPTURE_BYTES
    };
    if medium.0.tymed == TYMED_ISTREAM.0 as u32 {
        let stream = unsafe { medium.0.u.pstm.as_ref() }.ok_or("Dropped stream is missing")?;
        let _ = unsafe { stream.Seek(0, STREAM_SEEK_SET, None) };
        let mut buffer = vec![0; STREAM_CHUNK_BYTES];
        let mut total = 0usize;
        loop {
            check_cancel(cancelled)?;
            let mut count = 0;
            unsafe {
                stream.Read(
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as u32,
                    Some(&mut count),
                )
            }
            .ok()
            .map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            if count as usize > buffer.len() {
                return Err("Invalid dropped stream length".into());
            }
            total = total
                .checked_add(count as usize)
                .filter(|n| *n <= limit)
                .ok_or("Dropped image exceeds its size limit")?;
            file.write_all(&buffer[..count as usize])
                .map_err(|e| e.to_string())?;
        }
    } else if medium.0.tymed == TYMED_HGLOBAL.0 as u32 {
        check_cancel(cancelled)?;
        file.write_all(&global_bytes(unsafe { medium.0.u.hGlobal }, limit)?)
            .map_err(|e| e.to_string())?;
    } else {
        return Err("Dropped storage format is not supported".into());
    }
    check_cancel(cancelled)?;
    Ok(capture)
}
fn descriptor_name(object: &IDataObject, formats: &Formats) -> Option<String> {
    let medium = get(object, formats.descriptor, TYMED_HGLOBAL.0 as u32, -1).ok()?;
    let bytes = global_bytes(unsafe { medium.0.u.hGlobal }, MAX_DESCRIPTOR_BYTES).ok()?;
    let offset = std::mem::offset_of!(FILEGROUPDESCRIPTORW, fgd);
    if bytes.len() < offset + std::mem::size_of::<FILEDESCRIPTORW>()
        || u32::from_le_bytes(bytes[..4].try_into().ok()?) == 0
    {
        return None;
    }
    let descriptor =
        unsafe { std::ptr::read_unaligned(bytes.as_ptr().add(offset).cast::<FILEDESCRIPTORW>()) };
    let filename = descriptor.cFileName;
    let length = filename
        .iter()
        .position(|c| *c == 0)
        .unwrap_or(filename.len());
    Some(String::from_utf16_lossy(&filename[..length]))
}
fn text_value(object: &IDataObject, formats: &Formats) -> Option<String> {
    for (id, wide) in [
        (formats.url_w, true),
        (formats.url_a, false),
        (formats.uri_list, false),
        (CF_UNICODETEXT.0, true),
        (formats.text, false),
        (CF_TEXT.0, false),
    ] {
        let Ok(medium) = get(object, id, TYMED_HGLOBAL.0 as u32, -1) else {
            continue;
        };
        let Ok(bytes) = global_bytes(
            unsafe { medium.0.u.hGlobal },
            crate::image_import::MAX_SVG_BYTES,
        ) else {
            continue;
        };
        let text = if wide {
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .take_while(|n| *n != 0)
                .collect();
            String::from_utf16_lossy(&units)
        } else {
            String::from_utf8_lossy(bytes.split(|b| *b == 0).next().unwrap_or(&[])).into_owned()
        };
        for line in text
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty() && !s.starts_with('#'))
        {
            if line.starts_with("data:image/")
                || tauri::Url::parse(line).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
            {
                return Some(line.into());
            }
        }
    }
    None
}
fn receive(
    object: &IDataObject,
    formats: &Formats,
    cancelled: &AtomicBool,
) -> Result<Payload, String> {
    check_cancel(cancelled)?;
    let text = text_value(object, formats);
    let web_content = text.is_some() || offers_global(object, formats.html);
    if !web_content {
        if let Some(path) = dropped_path(object) {
            return Ok(Payload::Path(path));
        }
    }
    if let Some(name) = descriptor_name(object, formats) {
        let extension = Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if crate::formats::is_image_ext(&extension) && extension != "mp4" {
            if let Ok(medium) = get(object, formats.contents, TYMED_ISTREAM.0 as u32, 0)
                .or_else(|_| get(object, formats.contents, TYMED_HGLOBAL.0 as u32, 0))
            {
                return stage_medium(medium, false, cancelled).map(Payload::Capture);
            }
        }
    }
    for (id, dib) in [
        (formats.png, false),
        (formats.mime_png, false),
        (CF_DIBV5.0, true),
        (CF_DIB.0, true),
    ] {
        if let Ok(medium) = get(object, id, TYMED_HGLOBAL.0 as u32, -1) {
            return stage_medium(medium, dib, cancelled).map(Payload::Capture);
        }
    }
    if let Some(path) = dropped_path(object) {
        if Path::new(&path)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("url"))
        {
            return text
                .map(Payload::Url)
                .ok_or_else(|| "Dropped shortcut has no supported web URL".into());
        }
        if web_content && Path::new(&path).is_file() {
            let (capture, mut output) = new_capture(false)?;
            let mut input = File::open(&path)
                .map_err(|e| e.to_string())?
                .take(crate::image_import::MAX_CAPTURE_BYTES as u64 + 1);
            let n = std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
            if n > crate::image_import::MAX_CAPTURE_BYTES as u64 {
                return Err("Dropped image exceeds the size limit".into());
            }
            check_cancel(cancelled)?;
            return Ok(Payload::Capture(capture));
        }
        return Ok(Payload::Path(path));
    }
    if let Some(text) = text {
        if text.starts_with("data:image/") {
            let (header, encoded) = text.split_once(',').ok_or("Invalid inline image")?;
            if !header.ends_with(";base64") {
                return Err("Inline image encoding is not supported".into());
            }
            let bytes = crate::utils::base64_decode_bytes(encoded)
                .ok_or("Invalid inline image encoding")?;
            let (capture, mut file) = new_capture(false)?;
            file.write_all(&bytes).map_err(|e| e.to_string())?;
            return Ok(Payload::Capture(capture));
        }
        return Ok(Payload::Url(text));
    }
    Err("The browser did not provide image content or a supported URL".into())
}
