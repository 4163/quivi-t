#[cfg(windows)]
use super::*;

#[cfg(windows)]
#[test]
fn test_scoped_co_init_clean_thread_and_mode_mismatch() {
    use windows::Win32::Foundation::{S_FALSE, S_OK};
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    std::thread::spawn(|| {
        let co = ScopedCoInit::new();
        assert!(co.initialized);
    })
    .join()
    .unwrap();

    std::thread::spawn(|| unsafe {
        let first = CoInitializeEx(None, COINIT_MULTITHREADED);
        assert_eq!(first, S_OK);

        {
            let co = ScopedCoInit::new();
            assert!(!co.initialized);
        }

        // Dropping ScopedCoInit must not have uninitialized the MTA apartment.
        let still_mta = CoInitializeEx(None, COINIT_MULTITHREADED);
        assert_eq!(still_mta, S_FALSE);
        CoUninitialize();

        CoUninitialize();
    })
    .join()
    .unwrap();
}

#[cfg(windows)]
#[test]
fn test_pwstr_to_string_roundtrip() {
    use windows::core::PWSTR;
    use windows::Win32::System::Com::CoTaskMemAlloc;

    let expected = r"C:\Users\demo\Pictures\日本語";
    let wide: Vec<u16> = expected.encode_utf16().chain(std::iter::once(0)).collect();
    let byte_len = wide.len() * std::mem::size_of::<u16>();

    unsafe {
        let raw = CoTaskMemAlloc(byte_len) as *mut u16;
        assert!(!raw.is_null());
        std::ptr::copy_nonoverlapping(wide.as_ptr(), raw, wide.len());

        let decoded = pwstr_to_string(PWSTR(raw)).unwrap();
        assert_eq!(decoded, expected);
    }
}
