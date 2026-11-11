use std::fs;
use std::path::Path;

pub fn remove_file_robust(path: &Path) -> std::io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    if let Ok(meta) = fs::metadata(path) {
        if meta.permissions().readonly() {
            let mut perms = meta.permissions();
            perms.set_readonly(false);
            let _ = fs::set_permissions(path, perms);
        }
    }
    for attempt in 0..10 {
        match fs::remove_file(path) {
            Ok(_) => return Ok(()),
            Err(e) if attempt == 9 => return Err(e),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
    Ok(())
}

pub fn remove_dir_contents_and_self(dir: &Path) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if let Ok(meta) = entry.metadata() {
            if meta.permissions().readonly() {
                let mut perms = meta.permissions();
                perms.set_readonly(false);
                let _ = fs::set_permissions(&path, perms);
            }
            if meta.is_dir() {
                remove_dir_contents_and_self(&path)?;
            } else {
                remove_file_robust(&path)?;
            }
        }
    }
    fs::remove_dir(dir)
}

pub fn remove_dir_all_robust(dir: &Path) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    for attempt in 0..10 {
        match remove_dir_contents_and_self(dir) {
            Ok(_) => return Ok(()),
            Err(e) if attempt == 9 => return Err(e),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
    Ok(())
}

#[cfg(windows)]
pub fn move_to_recycle_bin(path: &Path) -> std::io::Result<()> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };

    let clean_path = crate::utils::strip_verbatim_prefix(&path.to_string_lossy());

    let mut wide: Vec<u16> = clean_path.encode_utf16().collect();
    wide.push(0);
    wide.push(0);

    let mut op = SHFILEOPSTRUCTW {
        hwnd: Default::default(),
        wFunc: FO_DELETE,
        pFrom: PCWSTR(wide.as_ptr()),
        pTo: PCWSTR::null(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI).0 as u16,
        fAnyOperationsAborted: Default::default(),
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: PCWSTR::null(),
    };

    let ret = unsafe { SHFileOperationW(&mut op) };
    if ret == 0 && !op.fAnyOperationsAborted.as_bool() {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("SHFileOperationW failed with return code {ret}"),
        ))
    }
}

#[cfg(not(windows))]
pub fn move_to_recycle_bin(_path: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Recycle bin is not supported on this platform",
    ))
}
