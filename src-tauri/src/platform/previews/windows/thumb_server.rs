use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use windows::{
    core::{implement, Error, IUnknown, Interface, Ref, Result, BOOL, GUID},
    Win32::{
        Foundation::{CLASS_E_NOAGGREGATION, E_FAIL, E_INVALIDARG, E_POINTER},
        Graphics::Gdi::HBITMAP,
        System::Com::{
            CoInitializeEx, CoRegisterClassObject, CoRevokeClassObject, CoUninitialize,
            IClassFactory, IClassFactory_Impl, IStream, CLSCTX_LOCAL_SERVER,
            COINIT_APARTMENTTHREADED, REGCLS_MULTIPLEUSE,
        },
        UI::{
            Shell::{
                IThumbnailProvider, IThumbnailProvider_Impl,
                PropertiesSystem::{IInitializeWithStream, IInitializeWithStream_Impl},
                WTSAT_ARGB, WTSAT_UNKNOWN, WTS_ALPHATYPE,
            },
            WindowsAndMessaging::{
                DispatchMessageW, GetMessageW, KillTimer, SetTimer, TranslateMessage, MSG, WM_TIMER,
            },
        },
    },
};

use super::super::thumb_decoders::{decode_first_frame, MAX_ENCODED_BYTES};
use super::{bitmap::Bitmap, log_event, IMAGE_THUMBNAIL_CLSID};

const STREAM_CHUNK_BYTES: usize = 64 * 1024;
const MAX_STORED_BYTES: usize = 256 * 1024 * 1024;
const IDLE_CHECK_MS: u32 = 1_000;
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
static ACTIVE_OBJECTS: AtomicUsize = AtomicUsize::new(0);
static SERVER_LOCKS: AtomicUsize = AtomicUsize::new(0);
static ACTIVITY: AtomicUsize = AtomicUsize::new(0);
static DECODE_LOCK: Mutex<()> = Mutex::new(());
static STORED_BYTES: AtomicUsize = AtomicUsize::new(0);

#[derive(Default)]
struct EncodedImage(Vec<u8>);

impl Drop for EncodedImage {
    fn drop(&mut self) {
        STORED_BYTES.fetch_sub(self.0.len(), Ordering::AcqRel);
    }
}

enum StreamState {
    Empty,
    Reading,
    Ready(EncodedImage),
}

pub(super) fn run() -> Result<()> {
    log_event("thumbnail server start");
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()? };
    let result = run_initialized();
    unsafe { CoUninitialize() };
    result
}

fn run_initialized() -> Result<()> {
    let factory: IClassFactory = ThumbnailClassFactory.into();
    let cookie = unsafe {
        CoRegisterClassObject(
            &IMAGE_THUMBNAIL_CLSID,
            &factory,
            CLSCTX_LOCAL_SERVER,
            REGCLS_MULTIPLEUSE,
        )?
    };
    let timer = unsafe { SetTimer(None, 0, IDLE_CHECK_MS, None) };
    if timer == 0 {
        let error = Error::from_thread();
        unsafe { CoRevokeClassObject(cookie)? };
        return Err(error);
    }
    log_event("thumbnail server registered");
    let mut idle_since = Instant::now();
    let mut activity = ACTIVITY.load(Ordering::Acquire);
    let mut message = MSG::default();
    let result = loop {
        let status = unsafe { GetMessageW(&mut message, None, 0, 0) };
        if status.0 == -1 {
            break Err(Error::from_thread());
        }
        if status.0 == 0 {
            break Ok(());
        }
        if message.message == WM_TIMER && message.wParam.0 == timer {
            let current_activity = ACTIVITY.load(Ordering::Acquire);
            if current_activity != activity
                || ACTIVE_OBJECTS.load(Ordering::Acquire) != 0
                || SERVER_LOCKS.load(Ordering::Acquire) != 0
            {
                idle_since = Instant::now();
                activity = current_activity;
            } else if idle_since.elapsed() >= IDLE_TIMEOUT {
                log_event("thumbnail server idle timeout");
                break Ok(());
            }
            continue;
        }
        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    };
    unsafe {
        let _ = KillTimer(None, timer);
        CoRevokeClassObject(cookie)?;
    }
    result
}

#[implement(IClassFactory)]
struct ThumbnailClassFactory;

impl IClassFactory_Impl for ThumbnailClassFactory_Impl {
    fn CreateInstance(
        &self,
        outer: Ref<IUnknown>,
        riid: *const GUID,
        result: *mut *mut core::ffi::c_void,
    ) -> Result<()> {
        if !outer.is_null() {
            return Err(Error::from(CLASS_E_NOAGGREGATION));
        }
        if riid.is_null() || result.is_null() {
            return Err(Error::from(E_POINTER));
        }
        unsafe { *result = std::ptr::null_mut() };
        ACTIVE_OBJECTS.fetch_add(1, Ordering::AcqRel);
        let provider: IUnknown = ThumbnailProvider {
            bytes: Mutex::new(StreamState::Empty),
        }
        .into();
        log_event("thumbnail CreateInstance");
        unsafe { provider.query(riid, result).ok() }
    }

    fn LockServer(&self, lock: BOOL) -> Result<()> {
        if lock.as_bool() {
            SERVER_LOCKS.fetch_add(1, Ordering::AcqRel);
        } else {
            let _ = SERVER_LOCKS.fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                count.checked_sub(1)
            });
        }
        Ok(())
    }
}

#[implement(IThumbnailProvider, IInitializeWithStream)]
struct ThumbnailProvider {
    bytes: Mutex<StreamState>,
}

impl Drop for ThumbnailProvider {
    fn drop(&mut self) {
        ACTIVE_OBJECTS.fetch_sub(1, Ordering::AcqRel);
        ACTIVITY.fetch_add(1, Ordering::AcqRel);
    }
}

impl IInitializeWithStream_Impl for ThumbnailProvider_Impl {
    fn Initialize(&self, stream: Ref<IStream>, _mode: u32) -> Result<()> {
        let stream = stream.as_ref().ok_or_else(|| Error::from(E_POINTER))?;
        {
            let mut stored = self.bytes.lock().map_err(|_| Error::from(E_FAIL))?;
            if !matches!(*stored, StreamState::Empty) {
                return Err(Error::new(
                    E_FAIL,
                    "Thumbnail provider is already initialized.",
                ));
            }
            *stored = StreamState::Reading;
        }
        // Stream reads can reenter COM. Keep the provider mutex out of those calls.
        let result = read_stream(stream);
        let mut stored = self.bytes.lock().map_err(|_| Error::from(E_FAIL))?;
        match result {
            Ok(bytes) => {
                *stored = StreamState::Ready(bytes);
                Ok(())
            }
            Err(error) => {
                *stored = StreamState::Empty;
                Err(error)
            }
        }
    }
}

fn read_stream(stream: &IStream) -> Result<EncodedImage> {
    let mut bytes = EncodedImage::default();
    let mut chunk = [0u8; STREAM_CHUNK_BYTES];
    loop {
        let mut read = 0u32;
        unsafe {
            stream
                .Read(
                    chunk.as_mut_ptr().cast(),
                    chunk.len() as u32,
                    Some(&mut read),
                )
                .ok()?
        };
        let read = read as usize;
        if read > chunk.len() || bytes.0.len().saturating_add(read) > MAX_ENCODED_BYTES {
            return Err(Error::new(
                E_INVALIDARG,
                "Image input exceeds the thumbnail limit.",
            ));
        }
        STORED_BYTES
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |total| {
                total
                    .checked_add(read)
                    .filter(|total| *total <= MAX_STORED_BYTES)
            })
            .map_err(|_| Error::new(E_FAIL, "Thumbnail stream memory limit reached."))?;
        bytes.0.extend_from_slice(&chunk[..read]);
        if read == 0 {
            break;
        }
    }
    log_event(&format!(
        "thumbnail Initialize stream bytes={}",
        bytes.0.len()
    ));
    Ok(bytes)
}

impl IThumbnailProvider_Impl for ThumbnailProvider_Impl {
    fn GetThumbnail(&self, cx: u32, bitmap: *mut HBITMAP, alpha: *mut WTS_ALPHATYPE) -> Result<()> {
        if bitmap.is_null() || alpha.is_null() {
            return Err(Error::from(E_POINTER));
        }
        unsafe {
            *bitmap = HBITMAP::default();
            *alpha = WTSAT_UNKNOWN;
        }
        let stored = self.bytes.lock().map_err(|_| Error::from(E_FAIL))?;
        let StreamState::Ready(bytes) = &*stored else {
            return Err(Error::new(E_FAIL, "No image stream."));
        };
        let _decode = DECODE_LOCK.lock().map_err(|_| Error::from(E_FAIL))?;
        let started = Instant::now();
        let image = decode_first_frame(&bytes.0, cx).map_err(|error| {
            log_event(&format!("thumbnail decode failed cx={cx}: {error}"));
            Error::new(E_FAIL, error)
        })?;
        let dib = Bitmap::new(&image)?.into_raw();
        log_event(&format!(
            "thumbnail GetThumbnail cx={cx} width={} height={} decode_us={}",
            image.width(),
            image.height(),
            started.elapsed().as_micros()
        ));
        unsafe {
            *bitmap = dib;
            *alpha = WTSAT_ARGB;
        }
        Ok(())
    }
}
