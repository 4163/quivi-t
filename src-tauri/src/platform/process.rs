use windows::core::HSTRING;
use windows::Win32::Foundation::{
    CloseHandle, ERROR_INVALID_PARAMETER, HANDLE, STILL_ACTIVE, WAIT_ABANDONED, WAIT_OBJECT_0,
};
use windows::Win32::System::Threading::{
    CreateMutexW, GetExitCodeProcess, OpenProcess, ReleaseMutex, WaitForSingleObject, INFINITE,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

pub struct ProcessLock(HANDLE);

impl ProcessLock {
    pub fn acquire(name: &str) -> Result<Self, String> {
        let handle = unsafe { CreateMutexW(None, false, &HSTRING::from(name)) }
            .map_err(|error| error.to_string())?;
        match unsafe { WaitForSingleObject(handle, INFINITE) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self(handle)),
            _ => {
                let error = windows::core::Error::from_thread().to_string();
                let _ = unsafe { CloseHandle(handle) };
                Err(error)
            }
        }
    }
}

impl Drop for ProcessLock {
    fn drop(&mut self) {
        let _ = unsafe { ReleaseMutex(self.0) };
        let _ = unsafe { CloseHandle(self.0) };
    }
}

pub fn is_running(pid: u32) -> bool {
    match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        Ok(handle) => {
            let mut code = 0;
            let result = unsafe { GetExitCodeProcess(handle, &mut code) };
            let _ = unsafe { CloseHandle(handle) };
            result.is_err() || code == STILL_ACTIVE.0 as u32
        }
        Err(error) => error.code().0 as u32 & 0xffff != ERROR_INVALID_PARAMETER.0,
    }
}
