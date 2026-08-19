/// Show a native folder picker. Windows Library virtual folders (Documents,
/// Pictures, Videos, Music) resolve to their default save location on disk.
///
/// Returns `Ok(Some(path))` on selection, `Ok(None)` on cancel, or `Err` on
/// COM/dialog failure.
#[cfg(windows)]
pub fn pick_folder(owner: Option<isize>) -> Result<Option<String>, String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize,
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, IShellItem, ShellLibrary, IShellLibrary,
        FOS_PICKFOLDERS, SIGDN_FILESYSPATH, SIGDN_DESKTOPABSOLUTEPARSING, DSFT_DETECT,
    };

    unsafe {
        // COM init is harmless if already initialized on this thread.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("CoCreateInstance failed: {e}"))?;

        // Allow both filesystem folders and virtual library folders
        dialog.SetOptions(FOS_PICKFOLDERS)
            .map_err(|e| format!("SetOptions failed: {e}"))?;

        let hwnd = HWND(owner.unwrap_or(0) as *mut _);
        let show_result = dialog.Show(Some(hwnd));

        if show_result.is_err() {
            // User cancelled (HRESULT_FROM_WIN32(ERROR_CANCELLED))
            return Ok(None);
        }

        let item: IShellItem = dialog.GetResult()
            .map_err(|e| format!("GetResult failed: {e}"))?;

        // Try direct filesystem path first (works for normal folders)
        if let Ok(path_pwstr) = item.GetDisplayName(SIGDN_FILESYSPATH) {
            let path = path_pwstr.to_string()
                .map_err(|e| format!("Path conversion failed: {e}"))?;
            CoUninitialize();
            return Ok(Some(path));
        }

        // Virtual folder. Try resolving as a Windows Library.
        if let Ok(library) = CoCreateInstance::<_, IShellLibrary>(&ShellLibrary, None, CLSCTX_INPROC_SERVER) {
            if library.LoadLibraryFromItem(&item, 0).is_ok() {
                if let Ok(default_folder) = library.GetDefaultSaveFolder::<IShellItem>(DSFT_DETECT) {
                    if let Ok(path_pwstr) = default_folder.GetDisplayName(SIGDN_FILESYSPATH) {
                        if let Ok(path) = path_pwstr.to_string() {
                            CoUninitialize();
                            return Ok(Some(path));
                        }
                    }
                }
            }
        }

        // Fallback for virtual folders such as "This PC": return the parsing name.
        if let Ok(path_pwstr) = item.GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING) {
            let path = path_pwstr.to_string()
                .map_err(|e| format!("Path conversion failed: {e}"))?;
            CoUninitialize();
            return Ok(Some(path));
        }

        CoUninitialize();
        Err("Selected folder is virtual and could not be resolved".into())
    }
}

#[cfg(not(windows))]
pub fn pick_folder(_owner: Option<isize>) -> Result<Option<String>, String> {
    Err("pick_folder is only supported on Windows".into())
}
