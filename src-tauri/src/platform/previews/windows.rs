use std::path::Path;

use windows::core::GUID;
use winreg::{enums::*, RegKey};

pub use super::contract::{
    IMAGE_PREVIEW_CLSID_TEXT, IMAGE_THUMBNAIL_CLSID_TEXT, THUMBNAIL_CATEGORY,
};
pub const PREVIEW_HANDLER_CLSID: GUID = GUID::from_u128(0x4fca3a7c_329e_4b50_98d1_1b6ddfe36c59);
pub const PREVIEW_HANDLER_CLSID_TEXT: &str = "{4FCA3A7C-329E-4B50-98D1-1B6DDFE36C59}";
pub const PREVIEW_HANDLER_CATEGORY: &str = "{8895b1c6-b41f-4c1c-a562-0d564250836f}";
const IMAGE_THUMBNAIL_CLSID: GUID = GUID::from_u128(super::contract::IMAGE_THUMBNAIL_CLSID);
const INHERITED_SOURCE: &str = "QuiviTInheritedFrom";
const INHERITED_CLSID: &str = "QuiviTInheritedClsid";
const GIF_PREVIEW_MIN_HOST_VERSION: u32 = 5;

#[derive(Clone)]
pub struct ExternalHandler {
    pub clsid: String,
    pub source: String,
}

#[derive(Default, Clone)]
pub struct SvgShellHandlers {
    pub preview: Option<ExternalHandler>,
    pub thumbnail: Option<ExternalHandler>,
}

impl SvgShellHandlers {
    pub fn is_external(&self) -> bool {
        self.preview.is_some() || self.thumbnail.is_some()
    }
}

pub fn supports_extension(extension: &str) -> bool {
    crate::formats::is_archive_ext(extension)
        || matches!(extension, "webp" | "apng" | "avif" | "gif" | "svg" | "ico")
}

pub fn has_thumbnail(extension: &str) -> bool {
    matches!(extension, "webp" | "apng" | "avif" | "svg")
}

fn is_quivit_class(value: &str) -> bool {
    [
        PREVIEW_HANDLER_CLSID_TEXT,
        IMAGE_PREVIEW_CLSID_TEXT,
        IMAGE_THUMBNAIL_CLSID_TEXT,
    ]
    .iter()
    .any(|clsid| value.eq_ignore_ascii_case(clsid))
}

fn default_value(root: &RegKey, path: &str) -> Option<String> {
    root.open_subkey(path)
        .and_then(|key| key.get_value(""))
        .ok()
}

fn inherited_source(key: &RegKey, value: &str) -> Option<String> {
    let copied: String = key.get_value(INHERITED_CLSID).ok()?;
    if !copied.eq_ignore_ascii_case(value) {
        return None;
    }
    key.get_value(INHERITED_SOURCE).ok()
}

fn external_handler(path: &str, depth: usize) -> Option<ExternalHandler> {
    if depth > 3 {
        return None;
    }
    let classes = RegKey::predef(HKEY_CLASSES_ROOT);
    let key = classes.open_subkey(path).ok()?;
    let clsid: String = key.get_value("").ok()?;
    if clsid.is_empty() || is_quivit_class(&clsid) {
        return None;
    }
    if let Some(source) = inherited_source(&key, &clsid) {
        return external_handler(&source, depth + 1);
    }
    Some(ExternalHandler {
        clsid,
        source: path.into(),
    })
}

fn svg_slot(category: &str) -> Option<ExternalHandler> {
    let classes = RegKey::predef(HKEY_CLASSES_ROOT);
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let userchoice: Option<String> = hkcu
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.svg\UserChoice")
        .and_then(|key| key.get_value("ProgId"))
        .ok();
    let class_default = default_value(&classes, ".svg");
    let mut owners = vec![".svg".to_string()];
    if let Some(progid) = userchoice {
        owners.push(progid);
    }
    if let Some(progid) = class_default {
        owners.push(progid);
    }
    owners.push(r"SystemFileAssociations\.svg".into());
    owners.push("QuiviT.svg".into());
    owners
        .into_iter()
        .find_map(|owner| external_handler(&format!(r"{owner}\shellex\{category}"), 0))
}

pub fn detect_svg_shell_handlers() -> SvgShellHandlers {
    SvgShellHandlers {
        preview: svg_slot(PREVIEW_HANDLER_CATEGORY),
        thumbnail: svg_slot(THUMBNAIL_CATEGORY),
    }
}

fn set_string(key: &RegKey, name: &str, value: &str) -> Result<bool, String> {
    if key
        .get_value::<String, _>(name)
        .is_ok_and(|old| old == value)
    {
        return Ok(false);
    }
    key.set_value(name, &value)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

fn set_dword(key: &RegKey, name: &str, value: u32) -> Result<bool, String> {
    if key.get_value::<u32, _>(name).is_ok_and(|old| old == value) {
        return Ok(false);
    }
    key.set_value(name, &value)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

fn shell_path(extension: &str, category: &str) -> String {
    format!(r"Software\Classes\QuiviT.{extension}\shellex\{category}")
}

fn write_link(
    extension: &str,
    category: &str,
    clsid: &str,
    inherited: Option<&ExternalHandler>,
) -> Result<bool, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = shell_path(extension, category);
    let (key, _) = hkcu
        .create_subkey(path)
        .map_err(|error| error.to_string())?;
    let mut changed = set_string(&key, "", clsid)?;
    if let Some(handler) = inherited {
        let own = format!(r"QuiviT.{extension}\shellex\{category}");
        if !handler.source.eq_ignore_ascii_case(&own) {
            changed |= set_string(&key, INHERITED_SOURCE, &handler.source)?;
            changed |= set_string(&key, INHERITED_CLSID, clsid)?;
        }
    } else {
        for name in [INHERITED_SOURCE, INHERITED_CLSID] {
            if key.get_value::<String, _>(name).is_ok() {
                key.delete_value(name).map_err(|error| error.to_string())?;
                changed = true;
            }
        }
    }
    Ok(changed)
}

fn remove_link(
    extension: &str,
    category: &str,
    clsid: &str,
    remove_inherited: bool,
) -> Result<bool, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = shell_path(extension, category);
    let Ok(key) = hkcu.open_subkey(&path) else {
        return Ok(false);
    };
    let value: String = key.get_value("").unwrap_or_default();
    let owned = value.eq_ignore_ascii_case(clsid)
        || (remove_inherited && inherited_source(&key, &value).is_some());
    drop(key);
    if !owned {
        return Ok(false);
    }
    hkcu.delete_subkey_all(path)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

pub fn preserve_svg_handlers(handlers: &SvgShellHandlers) -> Result<bool, String> {
    let mut changed = false;
    for (category, own, external) in [
        (
            PREVIEW_HANDLER_CATEGORY,
            IMAGE_PREVIEW_CLSID_TEXT,
            handlers.preview.as_ref(),
        ),
        (
            THUMBNAIL_CATEGORY,
            IMAGE_THUMBNAIL_CLSID_TEXT,
            handlers.thumbnail.as_ref(),
        ),
    ] {
        if let Some(handler) = external {
            changed |= write_link("svg", category, &handler.clsid, Some(handler))?;
        } else {
            changed |= remove_link("svg", category, own, true)?;
        }
    }
    Ok(changed)
}

pub fn has_foreign_progid_handlers(extension: &str) -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    [PREVIEW_HANDLER_CATEGORY, THUMBNAIL_CATEGORY]
        .iter()
        .any(|category| {
            default_value(&hkcu, &shell_path(extension, category))
                .is_some_and(|value| !value.is_empty() && !is_quivit_class(&value))
        })
}

struct ShellClass<'a> {
    clsid: &'static str,
    name: &'static str,
    command: &'a str,
    preview: bool,
    proxy: Option<&'a Path>,
}

fn register_server_tree(root: &RegKey, class: &ShellClass<'_>) -> Result<bool, String> {
    let (key, _) = root
        .create_subkey(format!(r"Software\Classes\CLSID\{}", class.clsid))
        .map_err(|error| error.to_string())?;
    let mut changed = set_string(&key, "", class.name)?;
    let (server, _) = key
        .create_subkey("LocalServer32")
        .map_err(|error| error.to_string())?;
    changed |= set_string(&server, "", class.command)?;
    if let Some(proxy) = class.proxy {
        let (inproc, _) = key
            .create_subkey("InprocServer32")
            .map_err(|error| error.to_string())?;
        changed |= set_string(&inproc, "", &proxy.to_string_lossy())?;
        changed |= set_string(&inproc, "ThreadingModel", "Apartment")?;
    }
    if class.preview {
        changed |= set_dword(&key, "DisableLowILProcessIsolation", 1)?;
        let (handlers, _) = root
            .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\PreviewHandlers")
            .map_err(|error| error.to_string())?;
        changed |= set_string(&handlers, class.clsid, class.name)?;
    }
    Ok(changed)
}

fn writable_hklm() -> Option<RegKey> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    hklm.open_subkey_with_flags(r"SOFTWARE\Classes", KEY_WRITE)
        .ok()
        .map(|_| hklm)
}

fn register_class(class: &ShellClass<'_>) -> Result<bool, String> {
    let mut changed = register_server_tree(&RegKey::predef(HKEY_CURRENT_USER), class)?;
    if let Some(hklm) = writable_hklm() {
        if let Ok(updated) = register_server_tree(&hklm, class) {
            changed |= updated;
        }
    }
    Ok(changed)
}

pub fn register_for_extensions_with_host(
    extensions: &[String],
    host_path: &Path,
) -> Result<bool, String> {
    if crate::config::is_e2e_suite() {
        return Ok(false);
    }
    let extensions: Vec<_> = extensions
        .iter()
        .map(|extension| extension.to_lowercase())
        .filter(|extension| supports_extension(extension))
        .collect();
    let svg_handlers = extensions
        .iter()
        .any(|extension| extension == "svg")
        .then(detect_svg_shell_handlers);
    let native_extensions: Vec<_> = extensions
        .iter()
        .filter(|extension| {
            extension.as_str() != "svg"
                || !svg_handlers
                    .as_ref()
                    .is_some_and(SvgShellHandlers::is_external)
        })
        .collect();
    if !native_extensions.is_empty() && !host_path.is_file() {
        return Err("Preview helper update is pending. Close the preview pane and Explorer windows, then restart QuiviT and apply again.".into());
    }
    let has_archives = native_extensions
        .iter()
        .any(|extension| crate::formats::is_archive_ext(extension));
    let has_images = native_extensions
        .iter()
        .any(|extension| !crate::formats::is_archive_ext(extension));
    let has_thumbnails = native_extensions
        .iter()
        .any(|extension| has_thumbnail(extension));
    if has_images {
        let minimum_version = if native_extensions
            .iter()
            .any(|extension| extension.as_str() == "gif")
        {
            GIF_PREVIEW_MIN_HOST_VERSION
        } else {
            3
        };
        let sidecar = super::host::read_sidecar(&super::host::sidecar_path_for(host_path));
        if !sidecar.as_ref().is_some_and(|sidecar| {
            sidecar.preview_version >= minimum_version
                && super::host::proxy_is_healthy(host_path, sidecar)
        }) {
            return Err("Preview helper update is pending. Close the preview pane and Explorer windows, then restart QuiviT and apply again.".into());
        }
    }
    let command = super::host::expected_command_for(host_path);
    let mut changed = false;
    for (needed, clsid, name) in [
        (
            has_archives,
            PREVIEW_HANDLER_CLSID_TEXT,
            "QuiviT archive preview",
        ),
        (has_images, IMAGE_PREVIEW_CLSID_TEXT, "QuiviT image preview"),
    ] {
        if needed {
            changed |= register_class(&ShellClass {
                clsid,
                name,
                command: &command,
                preview: true,
                proxy: None,
            })?;
        }
    }
    if has_thumbnails {
        let command = super::host::thumb_command_for(host_path);
        let proxy = super::host::proxy_path_for(host_path);
        changed |= register_class(&ShellClass {
            clsid: IMAGE_THUMBNAIL_CLSID_TEXT,
            name: "QuiviT image thumbnail",
            command: &command,
            preview: false,
            proxy: Some(&proxy),
        })?;
    }
    for extension in native_extensions {
        let clsid = if crate::formats::is_archive_ext(extension) {
            PREVIEW_HANDLER_CLSID_TEXT
        } else {
            IMAGE_PREVIEW_CLSID_TEXT
        };
        changed |= write_link(extension, PREVIEW_HANDLER_CATEGORY, clsid, None)?;
        if has_thumbnail(extension) {
            changed |= write_link(
                extension,
                THUMBNAIL_CATEGORY,
                IMAGE_THUMBNAIL_CLSID_TEXT,
                None,
            )?;
        }
    }
    if let Some(handlers) = svg_handlers.filter(SvgShellHandlers::is_external) {
        changed |= preserve_svg_handlers(&handlers)?;
    }
    Ok(changed)
}

fn any_link_remains(clsid: &str, category: &str) -> bool {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    crate::formats::SUPPORTED_FORMATS.iter().any(|format| {
        default_value(&hkcu, &shell_path(format.ext, category))
            .is_some_and(|value| value.eq_ignore_ascii_case(clsid))
    })
}

fn unregister_server_tree(root: &RegKey, clsid: &str) -> bool {
    let mut changed = false;
    if let Ok(handlers) = root.open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\PreviewHandlers",
        KEY_ALL_ACCESS,
    ) {
        if handlers.get_value::<String, _>(clsid).is_ok() {
            changed |= handlers.delete_value(clsid).is_ok();
        }
    }
    let path = format!(r"Software\Classes\CLSID\{clsid}");
    if root.open_subkey(&path).is_ok() {
        changed |= root.delete_subkey_all(&path).is_ok();
    }
    changed
}

pub fn unregister_for_extensions(extensions: &[String]) -> Result<bool, String> {
    if crate::config::is_e2e_suite() {
        return Ok(false);
    }
    let mut changed = false;
    for extension in extensions {
        let extension = extension.to_lowercase();
        if !supports_extension(&extension) {
            continue;
        }
        let clsid = if crate::formats::is_archive_ext(&extension) {
            PREVIEW_HANDLER_CLSID_TEXT
        } else {
            IMAGE_PREVIEW_CLSID_TEXT
        };
        changed |= remove_link(&extension, PREVIEW_HANDLER_CATEGORY, clsid, false)?;
        changed |= remove_link(
            &extension,
            THUMBNAIL_CATEGORY,
            IMAGE_THUMBNAIL_CLSID_TEXT,
            false,
        )?;
    }
    for (clsid, category) in [
        (PREVIEW_HANDLER_CLSID_TEXT, PREVIEW_HANDLER_CATEGORY),
        (IMAGE_PREVIEW_CLSID_TEXT, PREVIEW_HANDLER_CATEGORY),
        (IMAGE_THUMBNAIL_CLSID_TEXT, THUMBNAIL_CATEGORY),
    ] {
        if !any_link_remains(clsid, category) {
            changed |= unregister_server_tree(&RegKey::predef(HKEY_CURRENT_USER), clsid);
            if let Some(hklm) = writable_hklm() {
                changed |= unregister_server_tree(&hklm, clsid);
            }
        }
    }
    Ok(changed)
}

pub fn run_server() -> Result<(), String> {
    com_server::run().map_err(|error| error.to_string())
}
pub fn log_event(event: &str) {
    com_server::log_event(event);
}
pub fn run_thumbnail_server() -> Result<(), String> {
    thumb_server::run().map_err(|error| error.to_string())
}

mod bitmap;
mod com_server;
mod image_pane;
mod thumb_server;
