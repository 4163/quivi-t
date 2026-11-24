#[cfg(windows)]
#[test]
fn test_com_apartment_mode_mismatch() {
    use windows::Win32::Foundation::{RPC_E_CHANGED_MODE, S_OK};
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED,
    };

    std::thread::spawn(|| unsafe {
        let first = CoInitializeEx(None, COINIT_MULTITHREADED);
        assert_eq!(first, S_OK);

        let second = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        assert_eq!(second, RPC_E_CHANGED_MODE);

        // Balance only the successful initialization.
        CoUninitialize();
    })
    .join()
    .unwrap();
}

#[cfg(windows)]
#[test]
fn test_cotaskmem_pwstr_roundtrip() {
    use windows::core::PWSTR;
    use windows::Win32::System::Com::{CoTaskMemAlloc, CoTaskMemFree};

    let expected = r"C:\Users\demo\Pictures\日本語";
    let wide: Vec<u16> = expected.encode_utf16().chain(std::iter::once(0)).collect();
    let byte_len = wide.len() * std::mem::size_of::<u16>();

    unsafe {
        let raw = CoTaskMemAlloc(byte_len) as *mut u16;
        assert!(!raw.is_null());
        std::ptr::copy_nonoverlapping(wide.as_ptr(), raw, wide.len());

        let decoded = PWSTR(raw).to_string().unwrap();
        CoTaskMemFree(Some(raw as *const _));

        assert_eq!(decoded, expected);
    }
}
