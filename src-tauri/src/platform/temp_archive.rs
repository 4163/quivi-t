use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use tauri::State;

use crate::archives::ArchiveCache;
use crate::models::TempArchiveOrigin;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TempEngine {
    WindowsExplorer {
        archive_filename: String,
        rel_entry: String,
    },
    PeaZip {
        rel_entry: String,
    },
    WinZip {
        rel_entry: String,
    },
    WinRar {
        pid: u32,
        filename: String,
    },
    SevenZip {
        filename: String,
        creator_pid_low12: Option<u16>,
    },
    Bandizip {
        filename: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateArchive {
    pub path: PathBuf,
    pub known_subfolder: Option<String>,
    pub subfolder_index: Option<usize>,
}

impl CandidateArchive {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            known_subfolder: None,
            subfolder_index: None,
        }
    }

    pub fn with_subfolder(path: PathBuf, known_subfolder: Option<String>) -> Self {
        Self {
            path,
            known_subfolder,
            subfolder_index: None,
        }
    }
}

/// Parses the relative path within the temp directory to determine archiver engine.
pub fn parse_temp_engine(path: &Path) -> Option<TempEngine> {
    let temp_dir = std::env::temp_dir();
    let rel = path.strip_prefix(&temp_dir).ok()?;
    parse_temp_engine_relative(rel)
}

fn parse_temp_engine_relative(rel: &Path) -> Option<TempEngine> {
    let comps: Vec<&str> = rel.iter().filter_map(|c| c.to_str()).collect();

    if comps.len() < 2 {
        return None;
    }

    let c0 = comps[0];
    let leaf_file = *comps.last()?;

    // 1. PeaZip: peazip-tmp/.ptmp<6b64>/<rel_path>
    if c0.eq_ignore_ascii_case("peazip-tmp") && comps.len() >= 3 {
        let c1 = comps[1];
        if c1.starts_with(".ptmp") {
            let rel_entry = comps[2..].join("/");
            return Some(TempEngine::PeaZip { rel_entry });
        }
    }

    // 2. Windows Explorer: <36-char UUID>_<archive_filename>.<3hex>/<rel_path>
    if c0.len() >= 42 && c0.as_bytes()[36] == b'_' && c0.as_bytes()[c0.len() - 4] == b'.' {
        let uuid_part = &c0[..36];
        if uuid_part.contains('-') {
            let suffix_hex = &c0[c0.len() - 3..];
            if suffix_hex.chars().all(|c| c.is_ascii_hexdigit()) {
                let archive_filename = c0[37..c0.len() - 4].to_string();
                if archive_filename.contains('.') {
                    let rel_entry = comps[1..].join("/");
                    return Some(TempEngine::WindowsExplorer {
                        archive_filename,
                        rel_entry,
                    });
                }
            }
        }
    }
    // Legacy Explorer: Temp<digits>_<archive_filename>
    if c0.starts_with("Temp") && c0.contains('_') {
        let rest = &c0[4..];
        if let Some(pos) = rest.find('_') {
            let num_part = &rest[..pos];
            if num_part.chars().all(|c| c.is_ascii_digit()) {
                let archive_filename = rest[pos + 1..].to_string();
                if archive_filename.contains('.') {
                    let rel_entry = comps[1..].join("/");
                    return Some(TempEngine::WindowsExplorer {
                        archive_filename,
                        rel_entry,
                    });
                }
            }
        }
    }

    // 3. WinZip: wz<3-5 hex>/<rel_path>
    if (c0.starts_with("wz") || c0.starts_with("WZ")) && c0.len() >= 5 && c0.len() <= 8 {
        let hex_part = &c0[2..];
        if hex_part.chars().all(|c| c.is_ascii_hexdigit()) {
            let rel_entry = comps[1..].join("/");
            return Some(TempEngine::WinZip { rel_entry });
        }
    }

    // 4. WinRAR: Rar$DIa<PID>.<rand>.rartemp/<leaf> or Rar$DRa...
    if c0.starts_with("Rar$DIa") || c0.starts_with("Rar$DRa") || c0.ends_with(".rartemp") {
        let pid = parse_winrar_pid(c0);
        return Some(TempEngine::WinRar {
            pid,
            filename: leaf_file.to_string(),
        });
    }

    // 5. 7-Zip & NanaZip: 7zO<hex>/<leaf> or 7zE<hex>/<leaf>
    if (c0.starts_with("7zO")
        || c0.starts_with("7zE")
        || c0.starts_with("7zo")
        || c0.starts_with("7ze"))
        && c0.len() >= 4
    {
        let hex_part = &c0[3..];
        if hex_part.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(TempEngine::SevenZip {
                filename: leaf_file.to_string(),
                creator_pid_low12: sevenzip_creator_pid_low12(c0),
            });
        }
    }

    // 6. Bandizip: BNZ.<15hex>/<leaf> or ~bz.thumb
    if c0.starts_with("BNZ.") || c0.starts_with("~bz.thumb") {
        return Some(TempEngine::Bandizip {
            filename: leaf_file.to_string(),
        });
    }

    None
}

fn parse_winrar_pid(folder_name: &str) -> u32 {
    let stripped = if let Some(rest) = folder_name.strip_prefix("Rar$DIa") {
        rest
    } else if let Some(rest) = folder_name.strip_prefix("Rar$DRa") {
        rest
    } else {
        folder_name
    };

    let digits: String = stripped
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();

    digits.parse::<u32>().unwrap_or(0)
}

pub fn sevenzip_creator_pid_low12(folder_name: &str) -> Option<u16> {
    let hex_part = folder_name.get(3..)?;
    if hex_part.len() < 3 || !hex_part.chars().take(3).all(|c| c.is_ascii_hexdigit()) {
        return None;
    }

    let mut pid_low_chars: Vec<char> = hex_part.chars().take(3).collect();
    pid_low_chars.reverse();
    let pid_low_hex: String = pid_low_chars.into_iter().collect();
    u16::from_str_radix(&pid_low_hex, 16).ok()
}

pub fn select_sevenzip_live_candidates(
    creator_pid_low12: Option<u16>,
    live_candidates: Vec<(u32, CandidateArchive)>,
) -> Vec<CandidateArchive> {
    let mut all = Vec::new();
    let mut matched = Vec::new();

    for (pid, candidate) in live_candidates {
        if creator_pid_low12
            .map(|expected| ((pid as u16) & 0x0fff) == expected)
            .unwrap_or(false)
        {
            matched.push(candidate.clone());
        }
        all.push(candidate);
    }

    if !matched.is_empty() {
        matched
    } else if creator_pid_low12.is_some() {
        Vec::new()
    } else {
        all
    }
}

#[cfg(windows)]
extern "system" {
    pub(crate) fn OpenWindowStationW(
        lpszWinSta: *const u16,
        fInherit: i32,
        dwDesiredAccess: u32,
    ) -> isize;
    pub(crate) fn SetProcessWindowStation(hWinSta: isize) -> i32;
    pub(crate) fn EnumDesktopsW(
        hWinSta: isize,
        lpEnumFunc: unsafe extern "system" fn(*const u16, isize) -> i32,
        lParam: isize,
    ) -> i32;
    pub(crate) fn CloseWindowStation(hWinSta: isize) -> i32;
    pub(crate) fn OpenDesktopW(
        lpszDesktop: *const u16,
        dwFlags: u32,
        fInherit: i32,
        dwDesiredAccess: u32,
    ) -> isize;
    pub(crate) fn CloseDesktop(hDesktop: isize) -> i32;
    pub(crate) fn EnumDesktopWindows(
        hDesktop: isize,
        lpfn: unsafe extern "system" fn(isize, isize) -> i32,
        lParam: isize,
    ) -> i32;
    pub(crate) fn EnumWindows(
        lpEnumFunc: unsafe extern "system" fn(isize, isize) -> i32,
        lParam: isize,
    ) -> i32;
    pub(crate) fn EnumChildWindows(
        hWnd: isize,
        lpEnumFunc: unsafe extern "system" fn(isize, isize) -> i32,
        lParam: isize,
    ) -> i32;
    pub(crate) fn GetWindowTextW(hWnd: isize, lpString: *mut u16, nMaxCount: i32) -> i32;
    pub(crate) fn GetClassNameW(hWnd: isize, lpClassName: *mut u16, nMaxCount: i32) -> i32;
    pub(crate) fn GetWindowThreadProcessId(hWnd: isize, lpdwProcessId: *mut u32) -> u32;
    pub(crate) fn SendMessageTimeoutW(
        hWnd: isize,
        Msg: u32,
        wParam: usize,
        lParam: isize,
        fuFlags: u32,
        uTimeout: u32,
        lpdwResult: *mut usize,
    ) -> isize;
}

#[cfg(windows)]
pub fn enumerate_top_level_windows() -> Vec<(isize, u32, String, String)> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    struct WindowCollector {
        list: Vec<(isize, u32, String, String)>,
    }

    struct EnumContext {
        collector: *mut WindowCollector,
        hdesk: isize,
    }

    unsafe extern "system" fn enum_proc(hwnd: isize, lparam: isize) -> i32 {
        let ctx = &mut *(lparam as *mut EnumContext);
        let collector = &mut *ctx.collector;
        let mut title_buf = [0u16; 512];
        let mut class_buf = [0u16; 256];
        let title_len = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), 512);
        if title_len > 0 {
            let class_len = GetClassNameW(hwnd, class_buf.as_mut_ptr(), 256);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            let mut title = OsString::from_wide(&title_buf[..title_len as usize])
                .to_string_lossy()
                .to_string();
            let class_name = if class_len > 0 {
                OsString::from_wide(&class_buf[..class_len as usize])
                    .to_string_lossy()
                    .to_string()
            } else {
                String::new()
            };
            if class_name.contains("NanaZip") || class_name.contains("FileManager") {
                if let Some(nanazip_title) = get_nanazip_address_bar(hwnd, ctx.hdesk) {
                    title = nanazip_title;
                }
            }
            if let Some(existing) = collector.list.iter_mut().find(|(h, _, _, _)| *h == hwnd) {
                if title != existing.3 && !title.is_empty() {
                    existing.3 = title;
                }
            } else {
                collector.list.push((hwnd, pid, class_name, title));
            }
        }
        1
    }

    let mut collector = WindowCollector { list: Vec::new() };
    let mut default_ctx = EnumContext {
        collector: &mut collector as *mut _,
        hdesk: 0,
    };

    unsafe {
        EnumWindows(enum_proc, &mut default_ctx as *mut _ as isize);

        let winsta_name: Vec<u16> = "WinSta0\0".encode_utf16().collect();
        let hwinsta = OpenWindowStationW(winsta_name.as_ptr(), 0, 0x10000000);
        if hwinsta != 0 {
            SetProcessWindowStation(hwinsta);

            struct DesktopEnumContext {
                collector: *mut WindowCollector,
            }

            unsafe extern "system" fn desk_proc(desk_name: *const u16, lparam: isize) -> i32 {
                let dctx = &*(lparam as *const DesktopEnumContext);
                let hdesk = OpenDesktopW(desk_name, 0, 0, 0x10000000);
                if hdesk != 0 {
                    let mut ectx = EnumContext {
                        collector: dctx.collector,
                        hdesk,
                    };
                    EnumDesktopWindows(hdesk, enum_proc, &mut ectx as *mut _ as isize);
                    CloseDesktop(hdesk);
                }
                1
            }

            let dctx = DesktopEnumContext {
                collector: &mut collector as *mut _,
            };
            EnumDesktopsW(hwinsta, desk_proc, &dctx as *const _ as isize);
            CloseWindowStation(hwinsta);
        }
    }
    collector.list
}

#[cfg(not(windows))]
pub fn enumerate_top_level_windows() -> Vec<(isize, u32, String, String)> {
    Vec::new()
}

fn paths_match(p1: &Path, p2: &Path) -> bool {
    p1.to_string_lossy()
        .eq_ignore_ascii_case(&p2.to_string_lossy())
}

#[cfg(windows)]
pub fn get_winrar_address_bar(hwnd: isize) -> Option<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    unsafe extern "system" fn find_edit(child: isize, lparam: isize) -> i32 {
        let mut class_buf = [0u16; 64];
        let len = GetClassNameW(child, class_buf.as_mut_ptr(), 64);
        if len > 0 {
            let class_name = OsString::from_wide(&class_buf[..len as usize])
                .to_string_lossy()
                .to_string();
            if class_name == "Edit" {
                *(lparam as *mut isize) = child;
                return 0;
            }
        }
        1
    }

    let mut edit_hwnd: isize = 0;
    unsafe {
        EnumChildWindows(hwnd, find_edit, &mut edit_hwnd as *mut _ as isize);
        if edit_hwnd != 0 {
            let mut text_buf = [0u16; 512];
            let mut res: usize = 0;
            SendMessageTimeoutW(
                edit_hwnd,
                0x000D, // WM_GETTEXT
                512,
                text_buf.as_mut_ptr() as isize,
                2, // SMTO_ABORTIFHUNG
                100,
                &mut res,
            );
            if res > 0 {
                let text = OsString::from_wide(&text_buf[..res])
                    .to_string_lossy()
                    .trim()
                    .to_string();
                let clean = text.split(" - ").next().unwrap_or(&text).trim();
                let lower = clean.to_lowercase();
                for ext in &[
                    ".zip\\", ".cbz\\", ".rar\\", ".cbr\\", ".7z\\", ".cb7\\", ".tar\\", ".cbt\\",
                    ".zip/", ".cbz/", ".rar/", ".cbr/", ".7z/", ".cb7/", ".tar/", ".cbt/",
                ] {
                    if let Some(pos) = lower.find(ext) {
                        let sub = clean[pos + ext.len()..].trim_matches(&['\\', '/'][..]);
                        if !sub.is_empty() {
                            return Some(sub.replace('\\', "/"));
                        } else {
                            return Some(String::new());
                        }
                    }
                }
                for ext in &[
                    ".zip", ".cbz", ".rar", ".cbr", ".7z", ".cb7", ".tar", ".cbt",
                ] {
                    if lower.ends_with(ext) {
                        return Some(String::new());
                    }
                }
                if is_supported_archive(Path::new(clean)) {
                    return Some(String::new());
                }
            }
        }
    }
    None
}

#[cfg(not(windows))]
pub fn get_winrar_address_bar(_hwnd: isize) -> Option<String> {
    None
}

#[cfg(windows)]
pub fn get_7z_address_bar(hwnd: isize) -> Option<(String, Option<String>)> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    unsafe extern "system" fn find_combo_or_edit(child: isize, lparam: isize) -> i32 {
        let mut class_buf = [0u16; 64];
        let len = GetClassNameW(child, class_buf.as_mut_ptr(), 64);
        if len > 0 {
            let class_name = OsString::from_wide(&class_buf[..len as usize])
                .to_string_lossy()
                .to_string();
            if class_name == "ComboBox" || class_name == "Edit" || class_name == "ComboBoxEx32" {
                let mut text_buf = [0u16; 512];
                let mut res: usize = 0;
                SendMessageTimeoutW(
                    child,
                    0x000D, // WM_GETTEXT
                    512,
                    text_buf.as_mut_ptr() as isize,
                    2, // SMTO_ABORTIFHUNG
                    100,
                    &mut res,
                );
                if res > 0 {
                    let text = OsString::from_wide(&text_buf[..res])
                        .to_string_lossy()
                        .trim()
                        .to_string();
                    if let Some(parsed) = parse_7z_window_title(&text) {
                        *(lparam as *mut Option<(String, Option<String>)>) = Some(parsed);
                        return 0;
                    }
                }
            }
        }
        1
    }

    let mut result: Option<(String, Option<String>)> = None;
    unsafe {
        EnumChildWindows(hwnd, find_combo_or_edit, &mut result as *mut _ as isize);
    }
    result
}

#[cfg(not(windows))]
pub fn get_7z_address_bar(_hwnd: isize) -> Option<(String, Option<String>)> {
    None
}

#[cfg(windows)]
pub fn get_nanazip_address_bar(hwnd: isize, hdesk: isize) -> Option<String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Variant::VariantToString;
    use windows::Win32::UI::Accessibility::{
        CUIAutomation8, IUIAutomation, TreeScope_Descendants, UIA_ValueValuePropertyId,
    };

    std::thread::spawn(move || unsafe {
        extern "system" {
            fn SetThreadDesktop(hdesk: isize) -> i32;
        }
        if hdesk != 0 {
            SetThreadDesktop(hdesk);
        }
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        if let Ok(uia) =
            CoCreateInstance::<_, IUIAutomation>(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
        {
            if let Ok(elem) = uia.ElementFromHandle(HWND(hwnd as *mut _)) {
                if let Ok(cond) = uia.CreateTrueCondition() {
                    if let Ok(arr) = elem.FindAll(TreeScope_Descendants, &cond) {
                        let len = arr.Length().unwrap_or(0);
                        for i in 0..len {
                            if let Ok(item) = arr.GetElement(i) {
                                if let Ok(id) = item.CurrentAutomationId() {
                                    if id == "TextBoxElement" {
                                        if let Ok(val) =
                                            item.GetCurrentPropertyValue(UIA_ValueValuePropertyId)
                                        {
                                            let mut buf = [0u16; 512];
                                            if VariantToString(&val, &mut buf).is_ok() {
                                                let tlen = buf
                                                    .iter()
                                                    .position(|&c| c == 0)
                                                    .unwrap_or(buf.len());
                                                let text = String::from_utf16_lossy(&buf[..tlen])
                                                    .trim()
                                                    .to_string();
                                                if !text.is_empty() {
                                                    return Some(text);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    })
    .join()
    .ok()
    .flatten()
}

#[cfg(not(windows))]
pub fn get_nanazip_address_bar(_hwnd: isize, _hdesk: isize) -> Option<String> {
    None
}

#[cfg(windows)]
unsafe fn find_tree_caret_index(
    tree_hwnd: isize,
    item: usize,
    caret: usize,
    current_idx: &mut usize,
) -> Option<usize> {
    const TVM_GETNEXTITEM: u32 = 0x110A;
    const TVGN_NEXT: usize = 0x1;
    const TVGN_CHILD: usize = 0x4;

    if item == caret {
        return Some(*current_idx);
    }
    *current_idx += 1;

    let mut child: usize = 0;
    SendMessageTimeoutW(
        tree_hwnd,
        TVM_GETNEXTITEM,
        TVGN_CHILD,
        item as isize,
        2,
        50,
        &mut child,
    );
    while child != 0 {
        if let Some(found) = find_tree_caret_index(tree_hwnd, child, caret, current_idx) {
            return Some(found);
        }
        let mut next: usize = 0;
        SendMessageTimeoutW(
            tree_hwnd,
            TVM_GETNEXTITEM,
            TVGN_NEXT,
            child as isize,
            2,
            50,
            &mut next,
        );
        child = next;
    }
    None
}

#[cfg(windows)]
fn get_bandizip_tree_state(hwnd: isize) -> (Option<String>, Option<usize>) {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    unsafe extern "system" fn find_tree(child: isize, lparam: isize) -> i32 {
        let mut class_buf = [0u16; 64];
        let len = GetClassNameW(child, class_buf.as_mut_ptr(), 64);
        if len > 0 {
            let class_name = OsString::from_wide(&class_buf[..len as usize])
                .to_string_lossy()
                .to_string();
            if class_name == "SysTreeView32" {
                *(lparam as *mut isize) = child;
                return 0;
            }
        }
        1
    }

    let mut tree_hwnd: isize = 0;
    unsafe {
        EnumChildWindows(hwnd, find_tree, &mut tree_hwnd as *mut _ as isize);
        if tree_hwnd != 0 {
            const TVM_GETNEXTITEM: u32 = 0x110A;
            const TVGN_ROOT: usize = 0x0;
            const TVGN_NEXT: usize = 0x1;
            const TVGN_CHILD: usize = 0x4;
            const TVGN_CARET: usize = 0x9;

            let mut root: usize = 0;
            SendMessageTimeoutW(tree_hwnd, TVM_GETNEXTITEM, TVGN_ROOT, 0, 2, 50, &mut root);
            let mut caret: usize = 0;
            SendMessageTimeoutW(tree_hwnd, TVM_GETNEXTITEM, TVGN_CARET, 0, 2, 50, &mut caret);

            if root != 0 && caret != 0 {
                if caret == root {
                    return (Some(String::new()), None);
                }

                let mut child: usize = 0;
                SendMessageTimeoutW(
                    tree_hwnd,
                    TVM_GETNEXTITEM,
                    TVGN_CHILD,
                    root as isize,
                    2,
                    50,
                    &mut child,
                );
                let mut idx = 0;
                while child != 0 {
                    if let Some(found) = find_tree_caret_index(tree_hwnd, child, caret, &mut idx) {
                        return (None, Some(found));
                    }
                    let mut next: usize = 0;
                    SendMessageTimeoutW(
                        tree_hwnd,
                        TVM_GETNEXTITEM,
                        TVGN_NEXT,
                        child as isize,
                        2,
                        50,
                        &mut next,
                    );
                    child = next;
                }
            }
        }
    }
    (None, None)
}

#[cfg(not(windows))]
fn get_bandizip_tree_state(_hwnd: isize) -> (Option<String>, Option<usize>) {
    (None, None)
}

pub fn collect_candidates(engine: &TempEngine) -> Vec<CandidateArchive> {
    let mut candidates = Vec::new();

    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let windows = enumerate_top_level_windows();

        // 1. Collect candidate archive file paths from recent histories and folders.
        // These ALL have known_subfolder: None because history is past navigation, not current view.
        if let Ok(key) = hkcu.open_subkey("Software\\WinRAR\\ArcHistory") {
            for i in 0..10 {
                if let Ok(path_str) = key.get_value::<String, _>(&i.to_string()) {
                    let p = PathBuf::from(&path_str);
                    if p.is_file() {
                        let parent = p.parent().map(|d| d.to_path_buf());
                        candidates.push(CandidateArchive::new(p));
                        if let Some(par) = parent {
                            scan_folder_archives(&par, &mut candidates);
                        }
                    }
                }
            }
        }

        if let Ok(key) = hkcu.open_subkey("Software\\Bandizip") {
            for i in 0..10 {
                let name = format!("RecentArchive{i}");
                if let Ok(path_str) = key.get_value::<String, _>(&name) {
                    let p = PathBuf::from(&path_str);
                    if p.is_file() {
                        let parent = p.parent().map(|d| d.to_path_buf());
                        candidates.push(CandidateArchive::new(p));
                        if let Some(par) = parent {
                            scan_folder_archives(&par, &mut candidates);
                        }
                    }
                }
            }
        }

        if let Ok(key) = hkcu.open_subkey("Software\\7-Zip\\FM") {
            if let Ok(val) = key.get_raw_value("FolderHistory") {
                parse_7z_folder_history(&val.bytes, &mut candidates);
            }
            for panel in &["PanelPath0", "PanelPath1"] {
                if let Ok(path_str) = key.get_value::<String, _>(panel) {
                    let p = PathBuf::from(path_str.trim_matches(&['\\', '/'][..]));
                    if p.is_dir() {
                        scan_folder_archives(&p, &mut candidates);
                    } else if p.is_file() {
                        candidates.push(CandidateArchive::new(p));
                    }
                }
            }
        }

        collect_peazip_conf_archives(&mut candidates);
        collect_nanazip_package_archives(&mut candidates);

        if let Ok(key) =
            hkcu.open_subkey("Software\\Nico Mak Computing\\WinZip\\WinZip\\mru\\archives")
        {
            for i in 0..10 {
                if let Ok(path_str) = key.get_value::<String, _>(&i.to_string()) {
                    let p = PathBuf::from(&path_str);
                    if p.is_file() {
                        candidates.push(CandidateArchive::new(p));
                    }
                }
            }
        }

        // Scan folders from open Explorer windows
        for (_hwnd, _pid, class_name, title) in &windows {
            if class_name == "CabinetWClass" && !title.is_empty() {
                let p = PathBuf::from(title);
                if p.is_dir() {
                    scan_folder_archives(&p, &mut candidates);
                } else {
                    collect_named_folder_archives(title, &mut candidates);
                }
            }
        }

        // Check user profile folders if Explorer engine
        if let TempEngine::WindowsExplorer {
            archive_filename, ..
        } = engine
        {
            collect_user_folder_candidates(archive_filename, &mut candidates);
        }

        // 2. Active view inspection: inspect live windows to determine active subfolder context
        match engine {
            TempEngine::Bandizip { .. } => {
                for (hwnd, _pid, class_name, title) in &windows {
                    let is_bandizip = class_name.to_lowercase().contains("bandizip")
                        || class_name == "Arkview"
                        || title.contains("Bandizip");

                    if is_bandizip {
                        let (known_sub, sub_idx) = get_bandizip_tree_state(*hwnd);
                        if let Some(cand) = parse_bandizip_window_title(title) {
                            let mut c = cand;
                            c.known_subfolder = known_sub.clone();
                            c.subfolder_index = sub_idx;
                            candidates.push(c);
                        }
                        if let Some(arc_name) = parse_bandizip_archive_name(title) {
                            for cand in &mut candidates {
                                if cand
                                    .path
                                    .file_name()
                                    .and_then(|n| n.to_str())
                                    .map(|n| n.eq_ignore_ascii_case(&arc_name))
                                    .unwrap_or(false)
                                {
                                    if known_sub.is_some() {
                                        cand.known_subfolder = known_sub.clone();
                                    }
                                    if sub_idx.is_some() {
                                        cand.subfolder_index = sub_idx;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            TempEngine::WinRar {
                pid: engine_pid, ..
            } => {
                for (hwnd, pid, class_name, title) in &windows {
                    let is_winrar = class_name.eq_ignore_ascii_case("winrarwindow")
                        || title.to_lowercase().contains("winrar");

                    if is_winrar {
                        let mut known_sub = get_winrar_address_bar(*hwnd);
                        if known_sub.is_none() {
                            known_sub = parse_winrar_window_title(title);
                        }
                        let clean = title
                            .split(" - ")
                            .next()
                            .unwrap_or(title)
                            .split(" (")
                            .next()
                            .unwrap_or(title)
                            .trim();
                        let lower = clean.to_lowercase();
                        for ext in &[
                            ".zip\\", ".cbz\\", ".rar\\", ".cbr\\", ".7z\\", ".cb7\\", ".tar\\",
                            ".cbt\\", ".zip/", ".cbz/", ".rar/", ".cbr/", ".7z/", ".cb7/", ".tar/",
                            ".cbt/",
                        ] {
                            if let Some(pos) = lower.find(ext) {
                                let arc_p = PathBuf::from(&clean[..pos + ext.len() - 1]);
                                if arc_p.is_file() {
                                    candidates.push(CandidateArchive::with_subfolder(
                                        arc_p,
                                        known_sub.clone(),
                                    ));
                                }
                            }
                        }
                        for ext in &[
                            ".zip", ".cbz", ".rar", ".cbr", ".7z", ".cb7", ".tar", ".cbt",
                        ] {
                            if lower.ends_with(ext) {
                                let arc_p = PathBuf::from(clean);
                                if arc_p.is_file() {
                                    candidates.push(CandidateArchive::with_subfolder(
                                        arc_p,
                                        known_sub.clone(),
                                    ));
                                }
                            }
                        }
                        if *pid == *engine_pid && known_sub.is_some() {
                            for cand in &mut candidates {
                                if cand.known_subfolder.is_none() {
                                    cand.known_subfolder = known_sub.clone();
                                }
                            }
                        }
                    }
                }
            }

            TempEngine::SevenZip {
                creator_pid_low12, ..
            } => {
                let mut live_candidates = Vec::new();

                for (hwnd, pid, class_name, title) in &windows {
                    let is_7z_or_nanazip = class_name == "FM"
                        || class_name == "7-Zip::FM"
                        || class_name.contains("7-Zip")
                        || class_name.contains("FileManager")
                        || class_name.contains("NanaZip")
                        || title.contains("7-Zip")
                        || title.contains("NanaZip");

                    if is_7z_or_nanazip {
                        let win_info =
                            get_7z_address_bar(*hwnd).or_else(|| parse_7z_window_title(title));
                        if let Some((arc_str, known_sub)) = win_info {
                            let mut window_candidates = Vec::new();
                            let p = PathBuf::from(&arc_str);
                            if p.is_file() {
                                window_candidates
                                    .push(CandidateArchive::with_subfolder(p, known_sub.clone()));
                            } else {
                                let arc_file_name =
                                    p.file_name().and_then(|n| n.to_str()).unwrap_or(&arc_str);
                                for cand in &candidates {
                                    if cand
                                        .path
                                        .file_name()
                                        .and_then(|n| n.to_str())
                                        .map(|n| n.eq_ignore_ascii_case(arc_file_name))
                                        .unwrap_or(false)
                                    {
                                        window_candidates.push(CandidateArchive::with_subfolder(
                                            cand.path.clone(),
                                            known_sub.clone(),
                                        ));
                                    }
                                }
                            }

                            for candidate in window_candidates {
                                live_candidates.push((*pid, candidate));
                            }
                        }
                    }
                }

                candidates.extend(select_sevenzip_live_candidates(
                    *creator_pid_low12,
                    live_candidates,
                ));
            }

            TempEngine::PeaZip { .. } => {
                for (_hwnd, _pid, _class_name, title) in &windows {
                    if let Some(cand) = parse_peazip_window_title(title) {
                        candidates.push(cand);
                    }
                }
            }

            _ => {}
        }
    }

    deduplicate_candidate_archives(engine, candidates)
}

fn normalize_subfolder(value: &str) -> String {
    value.replace('\\', "/").trim_matches('/').to_lowercase()
}

fn known_subfolders_conflict(left: &Option<String>, right: &Option<String>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => normalize_subfolder(left) != normalize_subfolder(right),
        _ => false,
    }
}

pub fn deduplicate_candidate_archives(
    engine: &TempEngine,
    candidates: Vec<CandidateArchive>,
) -> Vec<CandidateArchive> {
    // Deduplicate candidate paths case-insensitively.
    // Candidates discovered from live windows have known_subfolder set (Some("") for root, Some("sub") for subfolder).
    // History candidates have known_subfolder: None.
    // For 7-Zip/NanaZip, conflicting live windows for the same archive are not authoritative.
    // The temp path cannot identify which app/window created the flat 7zO folder.
    let mut deduped: Vec<CandidateArchive> = Vec::new();
    let mut sevenzip_conflicts: HashSet<String> = HashSet::new();
    let is_sevenzip = matches!(engine, TempEngine::SevenZip { .. });

    for c in candidates {
        if let Some(existing) = deduped.iter_mut().find(|e| paths_match(&e.path, &c.path)) {
            let key = existing.path.to_string_lossy().to_lowercase();
            let has_sevenzip_conflict = is_sevenzip
                && known_subfolders_conflict(&existing.known_subfolder, &c.known_subfolder);
            if has_sevenzip_conflict {
                existing.known_subfolder = None;
                existing.subfolder_index = None;
                sevenzip_conflicts.insert(key);
                continue;
            }
            if is_sevenzip && sevenzip_conflicts.contains(&key) {
                continue;
            }

            let incoming_has_sub = c
                .known_subfolder
                .as_ref()
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            if incoming_has_sub {
                existing.known_subfolder = c.known_subfolder;
            } else if existing.known_subfolder.is_none() && c.known_subfolder.is_some() {
                existing.known_subfolder = c.known_subfolder;
            }
            if c.subfolder_index.is_some() {
                existing.subfolder_index = c.subfolder_index;
            }
        } else {
            deduped.push(c);
        }
    }

    // Prioritize candidates with resolved subfolder context (including explicit root "") to the front
    deduped.sort_by_key(|c| {
        if c.known_subfolder.is_some() || c.subfolder_index.is_some() {
            0
        } else {
            1
        }
    });
    deduped
}

fn is_supported_archive(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    matches!(
        ext.as_str(),
        "zip" | "cbz" | "rar" | "cbr" | "7z" | "cb7" | "tar" | "cbt"
    )
}

fn scan_folder_archives(dir: &Path, candidates: &mut Vec<CandidateArchive>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() && is_supported_archive(&p) {
                candidates.push(CandidateArchive::new(p));
            }
        }
    }
}

#[cfg(windows)]
fn collect_named_folder_archives(folder_name: &str, candidates: &mut Vec<CandidateArchive>) {
    // Check if any existing candidate's parent has this folder name
    let existing_parents: Vec<PathBuf> = candidates
        .iter()
        .filter_map(|c| c.path.parent().map(|p| p.to_path_buf()))
        .collect();

    for par in existing_parents {
        if par.file_name().and_then(|n| n.to_str()) == Some(folder_name) {
            scan_folder_archives(&par, candidates);
        }
    }
}

#[cfg(windows)]
fn collect_peazip_conf_archives(candidates: &mut Vec<CandidateArchive>) {
    if let Ok(appdata) = std::env::var("APPDATA") {
        let conf_path = Path::new(&appdata).join("PeaZip").join("conf.txt");
        if let Ok(content) = std::fs::read_to_string(conf_path) {
            let mut take_next = false;
            for line in content.lines() {
                let trimmed = line.trim();
                if take_next {
                    let p = PathBuf::from(trimmed.trim_matches(&['\\', '/'][..]));
                    if p.is_dir() {
                        scan_folder_archives(&p, candidates);
                    }
                    break;
                }
                if trimmed.contains("[Initial dir for file/archive browser]") {
                    take_next = true;
                }
            }
        }
    }
}

#[cfg(windows)]
fn collect_nanazip_package_archives(candidates: &mut Vec<CandidateArchive>) {
    if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
        let pkg_dir = Path::new(&local_appdata).join("Packages");
        if let Ok(entries) = std::fs::read_dir(pkg_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_lower = name.to_string_lossy().to_lowercase();
                if name_lower.contains("nanazip") {
                    let user_dat = entry
                        .path()
                        .join("SystemAppData")
                        .join("Helium")
                        .join("User.dat");
                    if let Ok(bytes) = std::fs::read(user_dat) {
                        parse_7z_folder_history(&bytes, candidates);
                    }
                }
            }
        }
    }
}

#[cfg(windows)]
fn collect_user_folder_candidates(archive_filename: &str, candidates: &mut Vec<CandidateArchive>) {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let root = Path::new(&profile);
        for sub in &["Downloads", "Desktop", "Documents"] {
            let target = root.join(sub).join(archive_filename);
            if target.is_file() {
                candidates.push(CandidateArchive::new(target));
            }
        }
    }
}

pub fn parse_winrar_window_title(title: &str) -> Option<String> {
    let clean = title.split(" - ").next()?.split(" (").next()?.trim();
    let lower = clean.to_lowercase();

    for ext in &[
        ".zip\\", ".cbz\\", ".rar\\", ".cbr\\", ".7z\\", ".cb7\\", ".tar\\", ".cbt\\", ".zip/",
        ".cbz/", ".rar/", ".cbr/", ".7z/", ".cb7/", ".tar/", ".cbt/",
    ] {
        if let Some(pos) = lower.find(ext) {
            let sub_start = pos + ext.len();
            let sub = clean[sub_start..].trim_matches(&['\\', '/'][..]);
            if !sub.is_empty() {
                return Some(sub.replace('\\', "/"));
            } else {
                return Some(String::new());
            }
        }
    }

    for ext in &[
        ".zip", ".cbz", ".rar", ".cbr", ".7z", ".cb7", ".tar", ".cbt",
    ] {
        if lower.ends_with(ext) {
            return Some(String::new());
        }
    }

    if is_supported_archive(Path::new(clean)) {
        return Some(String::new());
    }

    None
}

pub fn parse_7z_folder_history(bytes: &[u8], candidates: &mut Vec<CandidateArchive>) {
    let u16_chars: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();

    let text = String::from_utf16_lossy(&u16_chars);
    for item in text.split('\0') {
        let trimmed = item.trim();
        if trimmed.is_empty() {
            continue;
        }

        for ext in &[
            ".zip\\", ".cbz\\", ".rar\\", ".cbr\\", ".7z\\", ".cb7\\", ".tar\\", ".cbt\\", ".zip/",
            ".cbz/", ".rar/", ".cbr/", ".7z/", ".cb7/", ".tar/", ".cbt/",
        ] {
            let lower = trimmed.to_lowercase();
            if let Some(pos) = lower.find(ext) {
                let arc_end = pos + ext.len() - 1;
                let arc_str = &trimmed[..arc_end];
                let p = PathBuf::from(arc_str);
                if p.is_file() {
                    candidates.push(CandidateArchive::new(p));
                }
                break;
            }
        }
        for ext in &[
            ".zip", ".cbz", ".rar", ".cbr", ".7z", ".cb7", ".tar", ".cbt",
        ] {
            let lower = trimmed.to_lowercase();
            if lower.ends_with(ext) {
                let p = PathBuf::from(trimmed);
                if p.is_file() {
                    candidates.push(CandidateArchive::new(p));
                }
                break;
            }
        }
    }
}

pub fn parse_7z_window_title(title: &str) -> Option<(String, Option<String>)> {
    let trimmed = title.split(" - ").next()?.trim();
    let lower = trimmed.to_lowercase();

    for ext in &[
        ".zip\\", ".cbz\\", ".rar\\", ".cbr\\", ".7z\\", ".cb7\\", ".tar\\", ".cbt\\", ".zip/",
        ".cbz/", ".rar/", ".cbr/", ".7z/", ".cb7/", ".tar/", ".cbt/",
    ] {
        if let Some(pos) = lower.find(ext) {
            let arc_end = pos + ext.len() - 1;
            let arc_str = &trimmed[..arc_end];
            let sub_part = trimmed[pos + ext.len()..].trim_matches(&['\\', '/'][..]);
            let known_subfolder = if sub_part.is_empty() {
                Some(String::new())
            } else {
                Some(sub_part.replace('\\', "/"))
            };
            return Some((arc_str.to_string(), known_subfolder));
        }
    }

    for ext in &[
        ".zip", ".cbz", ".rar", ".cbr", ".7z", ".cb7", ".tar", ".cbt",
    ] {
        if lower.ends_with(ext) {
            return Some((trimmed.to_string(), Some(String::new())));
        }
    }

    let p = Path::new(trimmed);
    if is_supported_archive(p) {
        Some((trimmed.to_string(), Some(String::new())))
    } else {
        None
    }
}

pub fn parse_bandizip_window_title(title: &str) -> Option<CandidateArchive> {
    let clean = title.split(" - ").next()?.trim();
    let p = PathBuf::from(clean);
    if p.is_file() {
        Some(CandidateArchive::new(p))
    } else {
        None
    }
}

pub fn parse_bandizip_archive_name(title: &str) -> Option<String> {
    let clean = title.split(" - ").next()?.trim();
    let p = Path::new(clean);
    if is_supported_archive(p) {
        p.file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string())
    } else {
        None
    }
}

pub fn parse_peazip_window_title(title: &str) -> Option<CandidateArchive> {
    let mut cand = title.trim();
    if let Some(rest) = cand.strip_prefix("PeaZip - ") {
        cand = rest.trim();
    } else if let Some(rest) = cand.split(" - PeaZip").next() {
        cand = rest.trim();
    }
    let p = PathBuf::from(cand);
    if p.is_file() {
        Some(CandidateArchive::new(p))
    } else {
        None
    }
}

pub fn resolve_temp_origin(
    path: &str,
    state: &State<'_, RwLock<ArchiveCache>>,
) -> Result<Option<TempArchiveOrigin>, String> {
    let (engine, temp_file_size, candidates) = match resolve_temp_request(path) {
        Some(request) => request,
        None => return Ok(None),
    };

    let mut cache = state.write().map_err(|e| e.to_string())?;
    resolve_temp_origin_from_candidates(&engine, temp_file_size, candidates, &mut cache)
}

pub fn resolve_temp_origin_with_cache(
    path: &str,
    cache: &mut ArchiveCache,
) -> Result<Option<TempArchiveOrigin>, String> {
    let (engine, temp_file_size, candidates) = match resolve_temp_request(path) {
        Some(request) => request,
        None => return Ok(None),
    };

    resolve_temp_origin_from_candidates(&engine, temp_file_size, candidates, cache)
}

fn resolve_temp_request(path: &str) -> Option<(TempEngine, u64, Vec<CandidateArchive>)> {
    let path_buf = PathBuf::from(path);
    let engine = match parse_temp_engine(&path_buf) {
        Some(e) => e,
        None => return None,
    };

    let temp_file_size = std::fs::metadata(&path_buf).map(|m| m.len()).unwrap_or(0);

    let candidates = collect_candidates(&engine);
    Some((engine, temp_file_size, candidates))
}

fn resolve_temp_origin_from_candidates(
    engine: &TempEngine,
    temp_file_size: u64,
    candidates: Vec<CandidateArchive>,
    cache: &mut ArchiveCache,
) -> Result<Option<TempArchiveOrigin>, String> {
    for candidate in candidates {
        if !candidate.path.is_file() {
            continue;
        }

        let cand_str = candidate.path.to_string_lossy().to_string();
        let archive_result = match cache.prepare_archive(&cand_str, None) {
            Ok(res) => res,
            Err(_) => continue,
        };

        if let Some(origin) =
            match_candidate_origin(&candidate, engine, temp_file_size, &archive_result)
        {
            return Ok(Some(origin));
        }
    }

    Ok(None)
}

pub fn match_candidate_origin(
    candidate: &CandidateArchive,
    engine: &TempEngine,
    temp_file_size: u64,
    archive_result: &crate::models::ArchiveReadResult,
) -> Option<TempArchiveOrigin> {
    let cand_str = candidate.path.to_string_lossy().to_string();
    match engine {
        TempEngine::WindowsExplorer { rel_entry, .. }
        | TempEngine::PeaZip { rel_entry }
        | TempEngine::WinZip { rel_entry } => {
            let norm_rel = rel_entry
                .replace('\\', "/")
                .trim_start_matches('/')
                .to_lowercase();

            for entry in &archive_result.files {
                if entry.is_dir {
                    continue;
                }
                let norm_entry = entry
                    .name
                    .replace('\\', "/")
                    .trim_start_matches('/')
                    .to_lowercase();

                if norm_entry == norm_rel && (temp_file_size == 0 || entry.size == temp_file_size) {
                    return Some(TempArchiveOrigin {
                        archive_path: cand_str,
                        entry_name: entry.name.clone(),
                    });
                }
            }
        }

        TempEngine::WinRar { filename, .. }
        | TempEngine::SevenZip { filename, .. }
        | TempEngine::Bandizip { filename } => {
            let target_lower = filename.to_lowercase();

            // 1. Resolve subfolder index if present (e.g. from Bandizip treeview)
            let mut resolved_subfolder = candidate.known_subfolder.clone();
            if resolved_subfolder
                .as_ref()
                .map(|s| s.is_empty())
                .unwrap_or(true)
            {
                if let Some(idx) = candidate.subfolder_index {
                    let mut dirs: Vec<String> = archive_result
                        .files
                        .iter()
                        .filter_map(|f| {
                            if f.is_dir {
                                Some(f.name.replace('\\', "/").trim_matches('/').to_string())
                            } else if let Some((dir, _)) =
                                f.name.replace('\\', "/").rsplit_once('/')
                            {
                                Some(dir.trim_matches('/').to_string())
                            } else {
                                None
                            }
                        })
                        .collect();
                    dirs.sort();
                    dirs.dedup();
                    if let Some(dir_name) = dirs.get(idx) {
                        resolved_subfolder = Some(dir_name.clone());
                    }
                }
            }

            // 2. If an explicit subfolder was discovered
            if let Some(sub) = &resolved_subfolder {
                if sub.is_empty() {
                    // Explicit root: match only entries that have NO subfolder (leaf is at root)
                    for entry in &archive_result.files {
                        if entry.is_dir {
                            continue;
                        }
                        let norm = entry.name.replace('\\', "/");
                        let clean = norm.trim_start_matches('/').trim_start_matches("./");
                        let has_slash = clean.contains('/');
                        if !has_slash {
                            let leaf = clean.to_lowercase();
                            if leaf == target_lower
                                && (temp_file_size == 0 || entry.size == temp_file_size)
                            {
                                return Some(TempArchiveOrigin {
                                    archive_path: cand_str,
                                    entry_name: entry.name.clone(),
                                });
                            }
                        }
                    }
                } else {
                    let norm_sub = sub.replace('\\', "/").trim_matches('/').to_lowercase();
                    let expected_path = format!("{norm_sub}/{target_lower}");
                    for entry in &archive_result.files {
                        if entry.is_dir {
                            continue;
                        }
                        let norm_entry = entry
                            .name
                            .replace('\\', "/")
                            .trim_start_matches('/')
                            .trim_start_matches("./")
                            .to_lowercase();

                        if norm_entry == expected_path
                            && (temp_file_size == 0 || entry.size == temp_file_size)
                        {
                            return Some(TempArchiveOrigin {
                                archive_path: cand_str,
                                entry_name: entry.name.clone(),
                            });
                        }
                    }
                }
            }

            // 3. Otherwise match by filename + size
            let mut matches = Vec::new();
            for entry in &archive_result.files {
                if entry.is_dir {
                    continue;
                }
                let norm = entry.name.replace('\\', "/");
                let clean = norm.trim_start_matches('/').trim_start_matches("./");
                let leaf = clean.rsplit('/').next().unwrap_or("").to_lowercase();

                if leaf == target_lower && (temp_file_size == 0 || entry.size == temp_file_size) {
                    matches.push(&entry.name);
                }
            }

            if matches.len() == 1 {
                return Some(TempArchiveOrigin {
                    archive_path: cand_str,
                    entry_name: matches[0].clone(),
                });
            }
        }
    }

    None
}
