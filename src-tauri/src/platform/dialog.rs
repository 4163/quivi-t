#[cfg(windows)]
struct ScopedCoInit {
    initialized: bool,
}

#[cfg(windows)]
impl ScopedCoInit {
    fn new() -> Self {
        let hr = unsafe {
            windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_APARTMENTTHREADED,
            )
        };
        Self {
            initialized: hr.is_ok(),
        }
    }
}

#[cfg(windows)]
impl Drop for ScopedCoInit {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                windows::Win32::System::Com::CoUninitialize();
            }
        }
    }
}

#[cfg(windows)]
unsafe fn pwstr_to_string(pwstr: windows::core::PWSTR) -> Result<String, String> {
    let result = pwstr
        .to_string()
        .map_err(|e| format!("Path conversion failed: {e}"));
    windows::Win32::System::Com::CoTaskMemFree(Some(pwstr.0.cast()));
    result
}

/// Show a native folder picker. Windows Library virtual folders (Documents,
/// Pictures, Videos, Music) resolve to their default save location on disk.
///
/// Returns `Ok(Some(path))` on selection, `Ok(None)` on cancel, or `Err` on
/// COM/dialog failure.
#[cfg(windows)]
pub fn pick_folder(owner: Option<isize>) -> Result<Option<String>, String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, IShellItem, IShellLibrary, ShellLibrary, DSFT_DETECT,
        FOS_PICKFOLDERS, SIGDN_DESKTOPABSOLUTEPARSING, SIGDN_FILESYSPATH,
    };

    let _co_init = ScopedCoInit::new();

    unsafe {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("CoCreateInstance failed: {e}"))?;

        // Allow both filesystem folders and virtual library folders
        dialog
            .SetOptions(FOS_PICKFOLDERS)
            .map_err(|e| format!("SetOptions failed: {e}"))?;

        let hwnd = HWND(owner.unwrap_or(0) as *mut _);
        let show_result = dialog.Show(Some(hwnd));

        if show_result.is_err() {
            // User cancelled (HRESULT_FROM_WIN32(ERROR_CANCELLED))
            return Ok(None);
        }

        let item: IShellItem = dialog
            .GetResult()
            .map_err(|e| format!("GetResult failed: {e}"))?;

        // Try direct filesystem path first (works for normal folders)
        if let Ok(path_pwstr) = item.GetDisplayName(SIGDN_FILESYSPATH) {
            return Ok(Some(pwstr_to_string(path_pwstr)?));
        }

        // Virtual folder. Try resolving as a Windows Library.
        if let Ok(library) =
            CoCreateInstance::<_, IShellLibrary>(&ShellLibrary, None, CLSCTX_INPROC_SERVER)
        {
            if library.LoadLibraryFromItem(&item, 0).is_ok() {
                if let Ok(default_folder) = library.GetDefaultSaveFolder::<IShellItem>(DSFT_DETECT)
                {
                    if let Ok(path_pwstr) = default_folder.GetDisplayName(SIGDN_FILESYSPATH) {
                        if let Ok(path) = pwstr_to_string(path_pwstr) {
                            return Ok(Some(path));
                        }
                    }
                }
            }
        }

        // Fallback for virtual folders such as "This PC": return the parsing name.
        if let Ok(path_pwstr) = item.GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING) {
            return Ok(Some(pwstr_to_string(path_pwstr)?));
        }

        Err("Selected folder is virtual and could not be resolved".into())
    }
}

#[cfg(not(windows))]
pub fn pick_folder(_owner: Option<isize>) -> Result<Option<String>, String> {
    Err("pick_folder is only supported on Windows".into())
}

#[cfg(test)]
#[path = "../tests/dialog_tests.rs"]
mod tests;
