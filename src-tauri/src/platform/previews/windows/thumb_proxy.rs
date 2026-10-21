//! Explorer loads this COM adapter; decoding stays in the shared EXE worker.

use std::{
    ffi::c_void,
    ptr,
    sync::atomic::{AtomicU32, Ordering},
};

#[allow(dead_code)]
#[path = "../contract.rs"]
mod contract;

type HResult = i32;
const S_OK: HResult = 0;
const S_FALSE: HResult = 1;
const E_POINTER: HResult = 0x80004003u32 as i32;
const E_NOINTERFACE: HResult = 0x80004002u32 as i32;
const CLASS_E_NOAGGREGATION: HResult = 0x80040110u32 as i32;
const CLASS_E_CLASSNOTAVAILABLE: HResult = 0x80040111u32 as i32;
static OBJECTS: AtomicU32 = AtomicU32::new(0);
static LOCKS: AtomicU32 = AtomicU32::new(0);

#[repr(C)]
#[derive(PartialEq, Eq)]
struct Guid {
    a: u32,
    b: u16,
    c: u16,
    d: [u8; 8],
}

impl Guid {
    const fn new(value: u128) -> Self {
        Self {
            a: (value >> 96) as u32,
            b: (value >> 80) as u16,
            c: (value >> 64) as u16,
            d: (value as u64).to_be_bytes(),
        }
    }
}

const CLASS_ID: Guid = Guid::new(contract::IMAGE_THUMBNAIL_CLSID);
const IID_UNKNOWN: Guid = Guid::new(0x00000000_0000_0000_c000_000000000046);
const IID_FACTORY: Guid = Guid::new(0x00000001_0000_0000_c000_000000000046);
const IID_THUMBNAIL: Guid = Guid::new(0xe357fccd_a995_4576_b01f_234630154e96);
const IID_STREAM_INIT: Guid = Guid::new(0xb824b49d_22ac_4161_ac8a_9916e8fa3f7f);

#[link(name = "ole32")]
extern "system" {
    fn CoCreateInstance(
        class: *const Guid,
        outer: *mut c_void,
        context: u32,
        iid: *const Guid,
        result: *mut *mut c_void,
    ) -> HResult;
}

#[repr(C)]
struct UnknownVtable {
    query: unsafe extern "system" fn(*mut c_void, *const Guid, *mut *mut c_void) -> HResult,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
}

#[repr(C)]
struct ThumbnailVtable {
    unknown: UnknownVtable,
    get_thumbnail: unsafe extern "system" fn(*mut c_void, u32, *mut isize, *mut u32) -> HResult,
}

#[repr(C)]
struct InitializeVtable {
    unknown: UnknownVtable,
    initialize: unsafe extern "system" fn(*mut c_void, *mut c_void, u32) -> HResult,
}

#[repr(C)]
struct FactoryVtable {
    unknown: UnknownVtable,
    create: unsafe extern "system" fn(
        *mut c_void,
        *mut c_void,
        *const Guid,
        *mut *mut c_void,
    ) -> HResult,
    lock: unsafe extern "system" fn(*mut c_void, i32) -> HResult,
}

#[repr(C)]
struct ProxyInterface {
    vtable: *const c_void,
    owner: *mut Proxy,
}

struct Proxy {
    thumbnail: ProxyInterface,
    initialize: ProxyInterface,
    references: AtomicU32,
    remote_thumbnail: *mut c_void,
    remote_initialize: *mut c_void,
}

impl Drop for Proxy {
    fn drop(&mut self) {
        unsafe {
            release_remote(self.remote_initialize);
            release_remote(self.remote_thumbnail);
        }
        OBJECTS.fetch_sub(1, Ordering::AcqRel);
    }
}

unsafe fn release_remote(object: *mut c_void) {
    if !object.is_null() {
        let table = *(object as *const *const UnknownVtable);
        ((*table).release)(object);
    }
}

unsafe fn proxy(this: *mut c_void) -> *mut Proxy {
    (*(this as *mut ProxyInterface)).owner
}

unsafe extern "system" fn proxy_query(
    this: *mut c_void,
    iid: *const Guid,
    result: *mut *mut c_void,
) -> HResult {
    if iid.is_null() || result.is_null() {
        return E_POINTER;
    }
    *result = ptr::null_mut();
    let owner = proxy(this);
    let interface = if *iid == IID_UNKNOWN || *iid == IID_THUMBNAIL {
        &mut (*owner).thumbnail
    } else if *iid == IID_STREAM_INIT {
        &mut (*owner).initialize
    } else {
        return E_NOINTERFACE;
    };
    *result = (interface as *mut ProxyInterface).cast();
    (*owner).references.fetch_add(1, Ordering::Relaxed);
    S_OK
}

unsafe extern "system" fn proxy_add_ref(this: *mut c_void) -> u32 {
    (*proxy(this)).references.fetch_add(1, Ordering::Relaxed) + 1
}

unsafe extern "system" fn proxy_release(this: *mut c_void) -> u32 {
    let owner = proxy(this);
    let remaining = (*owner).references.fetch_sub(1, Ordering::AcqRel) - 1;
    if remaining == 0 {
        drop(Box::from_raw(owner));
    }
    remaining
}

unsafe extern "system" fn initialize(this: *mut c_void, stream: *mut c_void, mode: u32) -> HResult {
    if stream.is_null() {
        return E_POINTER;
    }
    let remote = (*proxy(this)).remote_initialize;
    let table = *(remote as *const *const InitializeVtable);
    ((*table).initialize)(remote, stream, mode)
}

unsafe extern "system" fn get_thumbnail(
    this: *mut c_void,
    cx: u32,
    bitmap: *mut isize,
    alpha: *mut u32,
) -> HResult {
    if bitmap.is_null() || alpha.is_null() {
        return E_POINTER;
    }
    *bitmap = 0;
    *alpha = 0;
    let remote = (*proxy(this)).remote_thumbnail;
    let table = *(remote as *const *const ThumbnailVtable);
    ((*table).get_thumbnail)(remote, cx, bitmap, alpha)
}

static THUMBNAIL_VTABLE: ThumbnailVtable = ThumbnailVtable {
    unknown: UnknownVtable {
        query: proxy_query,
        add_ref: proxy_add_ref,
        release: proxy_release,
    },
    get_thumbnail,
};
static INITIALIZE_VTABLE: InitializeVtable = InitializeVtable {
    unknown: UnknownVtable {
        query: proxy_query,
        add_ref: proxy_add_ref,
        release: proxy_release,
    },
    initialize,
};

#[repr(C)]
struct Factory {
    vtable: *const FactoryVtable,
    references: AtomicU32,
}

unsafe extern "system" fn factory_query(
    this: *mut c_void,
    iid: *const Guid,
    result: *mut *mut c_void,
) -> HResult {
    if iid.is_null() || result.is_null() {
        return E_POINTER;
    }
    *result = ptr::null_mut();
    if *iid != IID_UNKNOWN && *iid != IID_FACTORY {
        return E_NOINTERFACE;
    }
    *result = this;
    factory_add_ref(this);
    S_OK
}

unsafe extern "system" fn factory_add_ref(this: *mut c_void) -> u32 {
    (*(this as *mut Factory))
        .references
        .fetch_add(1, Ordering::Relaxed)
        + 1
}

unsafe extern "system" fn factory_release(this: *mut c_void) -> u32 {
    let factory = this as *mut Factory;
    let remaining = (*factory).references.fetch_sub(1, Ordering::AcqRel) - 1;
    if remaining == 0 {
        drop(Box::from_raw(factory));
        OBJECTS.fetch_sub(1, Ordering::AcqRel);
    }
    remaining
}

unsafe extern "system" fn create(
    _this: *mut c_void,
    outer: *mut c_void,
    iid: *const Guid,
    result: *mut *mut c_void,
) -> HResult {
    if iid.is_null() || result.is_null() {
        return E_POINTER;
    }
    *result = ptr::null_mut();
    if !outer.is_null() {
        return CLASS_E_NOAGGREGATION;
    }
    let mut remote = ptr::null_mut();
    // Explicit local-server context prevents recursively loading this DLL.
    let status = CoCreateInstance(&CLASS_ID, ptr::null_mut(), 4, &IID_THUMBNAIL, &mut remote);
    if status < 0 {
        return status;
    }
    let mut remote_initialize = ptr::null_mut();
    let remote_table = *(remote as *const *const UnknownVtable);
    let status = ((*remote_table).query)(remote, &IID_STREAM_INIT, &mut remote_initialize);
    if status < 0 {
        release_remote(remote);
        return status;
    }
    let owner = Box::into_raw(Box::new(Proxy {
        thumbnail: ProxyInterface {
            vtable: (&THUMBNAIL_VTABLE as *const ThumbnailVtable).cast(),
            owner: ptr::null_mut(),
        },
        initialize: ProxyInterface {
            vtable: (&INITIALIZE_VTABLE as *const InitializeVtable).cast(),
            owner: ptr::null_mut(),
        },
        references: AtomicU32::new(1),
        remote_thumbnail: remote,
        remote_initialize,
    }));
    OBJECTS.fetch_add(1, Ordering::AcqRel);
    (*owner).thumbnail.owner = owner;
    (*owner).initialize.owner = owner;
    let interface = (&mut (*owner).thumbnail as *mut ProxyInterface).cast();
    let status = proxy_query(interface, iid, result);
    proxy_release(interface);
    status
}

unsafe extern "system" fn lock(_this: *mut c_void, locked: i32) -> HResult {
    if locked != 0 {
        LOCKS.fetch_add(1, Ordering::AcqRel);
    } else {
        let _ = LOCKS.fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
            value.checked_sub(1)
        });
    }
    S_OK
}

static FACTORY_VTABLE: FactoryVtable = FactoryVtable {
    unknown: UnknownVtable {
        query: factory_query,
        add_ref: factory_add_ref,
        release: factory_release,
    },
    create,
    lock,
};

#[no_mangle]
pub unsafe extern "system" fn DllGetClassObject(
    class: *const Guid,
    iid: *const Guid,
    result: *mut *mut c_void,
) -> HResult {
    if class.is_null() || iid.is_null() || result.is_null() {
        return E_POINTER;
    }
    *result = ptr::null_mut();
    if *class != CLASS_ID {
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    if *iid != IID_FACTORY && *iid != IID_UNKNOWN {
        return E_NOINTERFACE;
    }
    OBJECTS.fetch_add(1, Ordering::AcqRel);
    *result = Box::into_raw(Box::new(Factory {
        vtable: &FACTORY_VTABLE,
        references: AtomicU32::new(1),
    }))
    .cast();
    S_OK
}

#[no_mangle]
pub extern "system" fn DllCanUnloadNow() -> HResult {
    if OBJECTS.load(Ordering::Acquire) == 0 && LOCKS.load(Ordering::Acquire) == 0 {
        S_OK
    } else {
        S_FALSE
    }
}
