use std::path::Path;

use windows::core::GUID;
use winreg::{enums::*, RegKey};

pub const PREVIEW_HANDLER_CLSID: GUID = GUID::from_u128(0x4fca3a7c_329e_4b50_98d1_1b6ddfe36c59);
pub const PREVIEW_HANDLER_CLSID_TEXT: &str = "{4FCA3A7C-329E-4B50-98D1-1B6DDFE36C59}";
pub const PREVIEW_HANDLER_CATEGORY: &str = "{8895b1c6-b41f-4c1c-a562-0d564250836f}";
const PREVIEW_HANDLER_NAME: &str = "QuiviT Preview";

/// Registers the staged helper as the local server and associates it with
/// the selected QuiviT ProgID only. It deliberately does not touch other
/// apps' extension or preview registrations. Returns true when a registry
/// value was created or updated.
pub fn register_for_extension(extension: &str) -> Result<bool, String> {
    if !crate::formats::is_archive_ext(extension) {
        return Ok(false);
    }
    if crate::config::is_e2e_suite() {
        return Ok(false);
    }

    let host_path = match super::host::ensure_previews_host() {
        Ok(path) => path,
        Err(err) => {
            let fallback = super::host::resolve_previews_host_path();
            if fallback.exists() {
                fallback
            } else {
                return Err(err);
            }
        }
    };
    register_for_extension_with_host(extension, &host_path)
}

/// Registry writes for one extension against an already staged host. Callers
/// that touch several types stage once via `ensure_previews_host` and reuse
/// the path here, so one Apply pays exactly one copy plus one hash.
pub fn register_for_extension_with_host(
    extension: &str,
    host_path: &Path,
) -> Result<bool, String> {
    if !crate::formats::is_archive_ext(extension) {
        return Ok(false);
    }
    if crate::config::is_e2e_suite() {
        return Ok(false);
    }

    let command = super::host::expected_command_for(host_path);
    let mut changed = false;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    // Association surface stays per-user: Explorer reads it directly.
    let progid_preview_path = format!(
        r"Software\Classes\QuiviT.{}\shellex\{}",
        extension, PREVIEW_HANDLER_CATEGORY
    );
    let already_linked = hkcu
        .open_subkey(&progid_preview_path)
        .and_then(|key| key.get_value::<String, _>(""))
        .is_ok_and(|value| value.eq_ignore_ascii_case(PREVIEW_HANDLER_CLSID_TEXT));
    if !already_linked {
        let (preview_key, _) = hkcu
            .create_subkey(&progid_preview_path)
            .map_err(|error| format!("Failed to enable preview for .{extension}: {error}"))?;
        preview_key
            .set_value("", &PREVIEW_HANDLER_CLSID_TEXT)
            .map_err(|error| error.to_string())?;
        changed = true;
    }

    // Activation surface goes to every writable hive. The COM activator
    // reads HKLM reliably; per-user class registration is ignored on
    // some machines, which leaves Explorer with a black pane.
    changed |= register_server_tree(&hkcu, &command)?;
    if let Some(hklm) = writable_hklm() {
        if let Ok(hklm_changed) = register_server_tree(&hklm, &command) {
            changed |= hklm_changed;
        }
    }

    Ok(changed)
}

/// Writes the CLSID local-server entry plus the PreviewHandlers list value
/// under one hive root. Returns true when a value was created or updated.
fn register_server_tree(root: &RegKey, command: &str) -> Result<bool, String> {
    let mut changed = false;

    let clsid_path = format!(r"Software\Classes\CLSID\{}", PREVIEW_HANDLER_CLSID_TEXT);
    let (clsid_key, _) = root
        .create_subkey(&clsid_path)
        .map_err(|error| format!("Failed to register the QuiviT preview handler: {error}"))?;
    if clsid_key
        .get_value::<String, _>("")
        .map(|value| value != PREVIEW_HANDLER_NAME)
        .unwrap_or(true)
    {
        clsid_key
            .set_value("", &PREVIEW_HANDLER_NAME)
            .map_err(|error| error.to_string())?;
        changed = true;
    }
    let current_server = clsid_key
        .open_subkey("LocalServer32")
        .and_then(|key| key.get_value::<String, _>(""))
        .unwrap_or_default();
    if current_server != command {
        let (server_key, _) = clsid_key
            .create_subkey("LocalServer32")
            .map_err(|error| error.to_string())?;
        server_key
            .set_value("", &command)
            .map_err(|error| error.to_string())?;
        changed = true;
    }

    // Preview hosts launch handlers at low integrity by default. A low
    // process can neither parent a window to Explorer's pane (UIPI) nor
    // write temp files, so the pane stays black. This documented opt-out
    // keeps the read-only listing server at medium like its host.
    const LOW_IL_OPT_OUT: &str = "DisableLowILProcessIsolation";
    if clsid_key
        .get_value::<u32, _>(LOW_IL_OPT_OUT)
        .map(|value| value != 1)
        .unwrap_or(true)
    {
        clsid_key
            .set_value(LOW_IL_OPT_OUT, &1u32)
            .map_err(|error| error.to_string())?;
        changed = true;
    }

    let (handlers, _) = root
        .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\PreviewHandlers")
        .map_err(|error| error.to_string())?;
    if handlers
        .get_value::<String, _>(PREVIEW_HANDLER_CLSID_TEXT)
        .map(|value| value != PREVIEW_HANDLER_NAME)
        .unwrap_or(true)
    {
        handlers
            .set_value(PREVIEW_HANDLER_CLSID_TEXT, &PREVIEW_HANDLER_NAME)
            .map_err(|error| error.to_string())?;
        changed = true;
    }

    Ok(changed)
}

/// HKLM only when this process can write it. Standard users keep the
/// per-user registration; elevated runs mirror the activation surface.
fn writable_hklm() -> Option<RegKey> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    hklm.open_subkey_with_flags(r"SOFTWARE\Classes", KEY_WRITE)
        .ok()
        .map(|_| hklm)
}

/// Removes the preview registration for one QuiviT-owned extension. The
/// shared server registration is retained while another selected type uses it.
/// The helper binary stays on disk by design. Returns true when a key or
/// value was removed.
pub fn unregister_for_extension(extension: &str) -> Result<bool, String> {
    if crate::config::is_e2e_suite() {
        return Ok(false);
    }
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let progid_preview_path = format!(
        r"Software\Classes\QuiviT.{}\shellex\{}",
        extension, PREVIEW_HANDLER_CATEGORY
    );
    let mut changed = false;
    if hkcu.open_subkey(&progid_preview_path).is_ok() {
        let _ = hkcu.delete_subkey_all(&progid_preview_path);
        changed = true;
    }

    if !any_quivit_preview_remains(&hkcu) {
        changed |= unregister_server_tree(&hkcu);
        if let Some(hklm) = writable_hklm() {
            changed |= unregister_server_tree(&hklm);
        }
    }

    Ok(changed)
}

/// Best-effort removal of the shared activation entries under one hive.
/// Returns true when a key or value was removed.
fn unregister_server_tree(root: &RegKey) -> bool {
    let mut changed = false;
    if let Ok(handlers) = root.open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\PreviewHandlers",
        KEY_ALL_ACCESS,
    ) {
        if handlers.get_value::<String, _>(PREVIEW_HANDLER_CLSID_TEXT).is_ok() {
            let _ = handlers.delete_value(PREVIEW_HANDLER_CLSID_TEXT);
            changed = true;
        }
    }
    let clsid_path = format!(r"Software\Classes\CLSID\{}", PREVIEW_HANDLER_CLSID_TEXT);
    if root.open_subkey(&clsid_path).is_ok() {
        let _ = root.delete_subkey_all(&clsid_path);
        changed = true;
    }
    changed
}

fn any_quivit_preview_remains(hkcu: &RegKey) -> bool {
    crate::formats::SUPPORTED_FORMATS
        .iter()
        .filter(|format| crate::formats::is_archive_ext(format.ext))
        .any(|format| {
        let path = format!(
            r"Software\Classes\QuiviT.{}\shellex\{}",
            format.ext, PREVIEW_HANDLER_CATEGORY
        );
        hkcu.open_subkey(&path)
            .and_then(|key| key.get_value::<String, _>(""))
            .is_ok_and(|value| value.eq_ignore_ascii_case(PREVIEW_HANDLER_CLSID_TEXT))
    })
}

pub fn run_server() -> Result<(), String> {
    com_server::run().map_err(|error| error.to_string())
}

pub fn log_event(event: &str) {
    com_server::log_event(event);
}

mod com_server;
