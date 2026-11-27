use crate::config::AppConfig;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;
use tauri::window::Color;
use tauri::{Emitter, Manager};

static ACTIVE_THEME: AtomicU8 = AtomicU8::new(0);
// Serializes check-and-build for secondary windows across concurrent async IPC calls.
static WINDOW_CREATE_LOCK: Mutex<()> = Mutex::new(());

fn encode_tauri_theme(theme: Option<tauri::Theme>) -> u8 {
    match theme {
        Some(tauri::Theme::Light) => 1,
        Some(tauri::Theme::Dark) => 2,
        _ => 0,
    }
}

fn active_tauri_theme() -> Option<tauri::Theme> {
    match ACTIVE_THEME.load(Ordering::Relaxed) {
        1 => Some(tauri::Theme::Light),
        2 => Some(tauri::Theme::Dark),
        _ => None,
    }
}

// Window size constants
// Initial/min sizes in logical pixels. Named for easy tweaking.

// Main window is built in lib.rs setup so all windows share one path.
pub const MAIN_INITIAL_W: f64 = 1280.0;
pub const MAIN_INITIAL_H: f64 = 720.0;
pub const MAIN_MIN_W: f64 = 640.0;
pub const MAIN_MIN_H: f64 = 400.0;

// Shared initial size for auto-fit windows: hidden until the JS fits + centers it,
// so these are only build placeholders, never displayed.
const AUTO_FIT_INITIAL_W: f64 = 560.0;
const AUTO_FIT_INITIAL_H: f64 = 600.0;
const FILE_LIST_INITIAL_W: f64 = 440.0;
const FILE_LIST_MIN_W: f64 = 320.0;
const WORKSPACE_WINDOWS: [&str; 2] = ["main", "workspace-file-list"];

pub(crate) fn is_workspace_window(label: &str) -> bool {
    WORKSPACE_WINDOWS.contains(&label)
}

// Options window width auto-fits to content (capped at OPTIONS_MAX_W), height fixed.
pub(crate) const OPTIONS_INITIAL_W: f64 = AUTO_FIT_INITIAL_W;
pub(crate) const OPTIONS_INITIAL_H: f64 = 620.0;
pub(crate) const OPTIONS_MIN_W: f64 = 400.0;
pub(crate) const OPTIONS_MIN_H: f64 = 360.0;
// Auto-fit clamp for the width; mirrored by OPTIONS_MAX_INITIAL_W in shared/windowFit.js.
const OPTIONS_MAX_W: f64 = 560.0;

// Metadata window is 400 wide; height auto-fits to content (capped at META_MAX_H,
// a fit cap, not a hard size limit). Opens hidden, fitted + centered before show.
pub(crate) const META_INITIAL_W: f64 = 400.0;
pub(crate) const META_INITIAL_H: f64 = AUTO_FIT_INITIAL_H;
pub(crate) const META_MIN_W: f64 = 320.0;
pub(crate) const META_MIN_H: f64 = 280.0;
// Auto-fit clamp; mirrored by META_MAX_INITIAL_H in shared/windowFit.js.
const META_MAX_H: f64 = 600.0;

struct AuxiliaryWindowSpec {
    label: &'static str,
    url: &'static str,
    title: &'static str,
    initial_size: (f64, f64),
    min_size: (f64, f64),
    maximizable: bool,
}

const OPTIONS_SPEC: AuxiliaryWindowSpec = AuxiliaryWindowSpec {
    label: "options",
    url: "options.html",
    title: "Options",
    initial_size: (OPTIONS_INITIAL_W, OPTIONS_INITIAL_H),
    min_size: (OPTIONS_MIN_W, OPTIONS_MIN_H),
    maximizable: false,
};

const METADATA_SPEC: AuxiliaryWindowSpec = AuxiliaryWindowSpec {
    label: "metadata",
    url: "metadata.html",
    title: "Archive Info",
    initial_size: (META_INITIAL_W, META_INITIAL_H),
    min_size: (META_MIN_W, META_MIN_H),
    maximizable: true,
};

fn clamp_dimension(value: f64, min: f64, max: f64) -> f64 {
    if !value.is_finite() {
        return min;
    }
    value.clamp(min, max)
}

fn clamp_options_width(width: f64) -> f64 {
    clamp_dimension(width, OPTIONS_MIN_W, OPTIONS_MAX_W)
}

fn clamp_metadata_height(height: f64) -> f64 {
    clamp_dimension(height, META_MIN_H, META_MAX_H)
}

// Styling and appearance

// --surface (light) / --surface (dark)
fn shell_background_color(dark: bool) -> Color {
    if dark {
        Color(37, 37, 38, 255)
    } else {
        Color(255, 255, 255, 255)
    }
}

// Sets the native window background color before the webview paints, so the
// shell behind the page is never white/black at launch.
pub fn apply_shell_background(window: &tauri::WebviewWindow, config: &AppConfig) {
    let theme = config
        .frontend_data
        .get("theme")
        .and_then(|v| v.as_str())
        .unwrap_or("system");

    let tauri_theme = match theme {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None,
    };
    ACTIVE_THEME.store(encode_tauri_theme(tauri_theme), Ordering::Relaxed);

    let dark = match tauri_theme {
        Some(tauri::Theme::Dark) => true,
        Some(tauri::Theme::Light) => false,
        _ => window
            .theme()
            .map(|theme| theme == tauri::Theme::Dark)
            .unwrap_or(false),
    };

    let _ = window.set_background_color(Some(shell_background_color(dark)));
}

pub(crate) fn update_theme(app: &tauri::AppHandle, theme: Option<&str>) {
    let tauri_theme = match theme {
        Some("dark") => Some(tauri::Theme::Dark),
        Some("light") => Some(tauri::Theme::Light),
        _ => None,
    };
    ACTIVE_THEME.store(encode_tauri_theme(tauri_theme), Ordering::Relaxed);

    for (_, window) in app.webview_windows() {
        let _ = window.set_theme(tauri_theme);
    }
}

// Secondary window creation and fitting

fn workspace_window(surface: &str) -> Result<&'static str, String> {
    match surface {
        "fileList" => Ok("workspace-file-list"),
        _ => Err("Unknown workspace surface".into()),
    }
}

pub(crate) fn open_workspace_window(app: &tauri::AppHandle, surface: &str) -> Result<(), String> {
    let label = workspace_window(surface)?;
    let _create_guard = WINDOW_CREATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.set_closable(true);
        window.show().map_err(|e| e.to_string())?;
        TRAY_HIDDEN.clear(label);
        let _ = window.unminimize();
        return window.set_focus().map_err(|e| e.to_string());
    }
    let title = app
        .get_webview_window("main")
        .and_then(|window| window.title().ok())
        .unwrap_or_else(|| "QuiviT".into());
    let window = tauri::WebviewWindowBuilder::new(
        app,
        label,
        tauri::WebviewUrl::App(format!("index.html?surface={surface}").into()),
    )
    .title(title)
    .inner_size(FILE_LIST_INITIAL_W, MAIN_INITIAL_H)
    .min_inner_size(FILE_LIST_MIN_W, MAIN_MIN_H)
    .closable(true)
    .visible(false)
    .disable_drag_drop_handler()
    .devtools(true)
    .general_autofill_enabled(false)
    .center()
    .build()
    .map_err(|e| e.to_string())?;
    TRAY_HIDDEN.clear(label);
    let theme = active_tauri_theme();
    let _ = window.set_theme(theme);
    let dark = match theme {
        Some(tauri::Theme::Dark) => true,
        Some(tauri::Theme::Light) => false,
        _ => app
            .get_webview_window("main")
            .and_then(|main| main.theme().ok())
            .or_else(|| window.theme().ok())
            .map(|resolved| resolved == tauri::Theme::Dark)
            .unwrap_or(false),
    };
    let _ = window.set_background_color(Some(shell_background_color(dark)));
    let _ = center_window_over_main(app, &window, FILE_LIST_INITIAL_W, MAIN_INITIAL_H);
    #[cfg(windows)]
    if let Err(error) = crate::platform::drop::install(&window) {
        let _ = window.destroy();
        return Err(error);
    }
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            TRAY_HIDDEN.clear(label);
            #[cfg(windows)]
            crate::platform::drop::uninstall(label);
            let _ = app_handle.emit_to("main", "workspace-detached-closed", label);
        }
    });
    Ok(())
}

pub(crate) fn close_workspace_window(app: &tauri::AppHandle, surface: &str) -> Result<(), String> {
    let label = workspace_window(surface)?;
    TRAY_HIDDEN.clear(label);
    if let Some(window) = app.get_webview_window(label) {
        window.destroy().map_err(|e| e.to_string())?;
    } else {
        app.emit_to("main", "workspace-detached-closed", label)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn set_workspace_title(app: &tauri::AppHandle, title: &str) -> Result<(), String> {
    for label in WORKSPACE_WINDOWS {
        if let Some(window) = app.get_webview_window(label) {
            window.set_title(title).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn close_secondary_windows(app: &tauri::AppHandle) {
    for label in SECONDARY_WINDOWS {
        TRAY_HIDDEN.clear(label);
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.destroy();
        }
    }
}

// Auxiliary windows open over main, so a request from the detached File List
// restores and raises main first. The auxiliary window then shows on top of it.
fn raise_main(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

fn open_auxiliary_window(
    app: &tauri::AppHandle,
    spec: &AuxiliaryWindowSpec,
) -> Result<(), String> {
    raise_main(app);
    let _create_guard = WINDOW_CREATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(window) = app.get_webview_window(spec.label) {
        // The window can exist but be hidden (hide to tray), so show it, not just focus it.
        if !window
            .is_visible()
            .map_err(|e| format!("Failed to check {} window: {e}", spec.label))?
        {
            window
                .show()
                .map_err(|e| format!("Failed to show {} window: {e}", spec.label))?;
        }
        TRAY_HIDDEN.clear(spec.label);
        let _ = window.unminimize();
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus {} window: {e}", spec.label))?;
        return Ok(());
    }

    let builder = tauri::WebviewWindowBuilder::new(
        app,
        spec.label,
        tauri::WebviewUrl::App(spec.url.into()),
    )
    .title(spec.title)
    .inner_size(spec.initial_size.0, spec.initial_size.1)
    .min_inner_size(spec.min_size.0, spec.min_size.1)
    .resizable(true)
    .closable(true)
    .maximizable(spec.maximizable)
    .visible(false)
    .devtools(true)
    .general_autofill_enabled(false)
    .center();

    let window = builder
        .build()
        .map_err(|e| format!("Failed to open {} window: {e}", spec.label))?;
    TRAY_HIDDEN.clear(spec.label);
    let _ = window.set_theme(active_tauri_theme());

    Ok(())
}

pub(crate) fn open_options(app: &tauri::AppHandle) -> Result<(), String> {
    open_auxiliary_window(app, &OPTIONS_SPEC)
}

pub(crate) fn open_metadata_window(app: &tauri::AppHandle) -> Result<(), String> {
    open_auxiliary_window(app, &METADATA_SPEC)
}

fn usable_window_bounds(
    window: &tauri::WebviewWindow,
) -> Option<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>, f64)> {
    if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return None;
    }
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let scale = window.scale_factor().ok()?;
    if pos.x <= -30_000
        || pos.y <= -30_000
        || size.width == 0
        || size.height == 0
        || !scale.is_finite()
        || scale <= 0.0
    {
        return None;
    }
    Some((pos, size, scale))
}

fn centered_position_in_work_area(
    main_pos: tauri::PhysicalPosition<i32>,
    main_size: tauri::PhysicalSize<u32>,
    target_size: (i32, i32),
    work_area: Option<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>)>,
) -> tauri::PhysicalPosition<i32> {
    let (target_w, target_h) = target_size;
    let mut x = main_pos.x + (main_size.width as i32 - target_w) / 2;
    let mut y = main_pos.y + (main_size.height as i32 - target_h) / 2;

    if let Some((area_pos, area_size)) = work_area {
        let min_x = area_pos.x;
        let min_y = area_pos.y;
        let max_x = (area_pos.x + area_size.width as i32 - target_w).max(min_x);
        let max_y = (area_pos.y + area_size.height as i32 - target_h).max(min_y);
        x = x.clamp(min_x, max_x);
        y = y.clamp(min_y, max_y);
    }

    tauri::PhysicalPosition::new(x, y)
}

pub fn center_window_over_main(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    target_width: f64,
    target_height: f64,
) -> Result<(), String> {
    window
        .set_size(tauri::LogicalSize::new(target_width, target_height))
        .map_err(|e| e.to_string())?;

    // A minimized main reports the Win32 parking origin, so fall back to the
    // current monitor rather than placing the window off-screen.
    let Some(main) = app.get_webview_window("main") else {
        return window.center().map_err(|e| e.to_string());
    };
    let Some((pos, size, scale)) = usable_window_bounds(&main) else {
        return window.center().map_err(|e| e.to_string());
    };

    let target_w = (target_width * scale) as i32;
    let target_h = (target_height * scale) as i32;
    let work_area = main
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .map(|monitor| {
            let area = monitor.work_area();
            (area.position, area.size)
        });
    let position = centered_position_in_work_area(pos, size, (target_w, target_h), work_area);

    window.set_position(position).map_err(|e| e.to_string())?;

    Ok(())
}

fn fit_auxiliary_window(
    app: &tauri::AppHandle,
    label: &str,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("{label} window not found"))?;

    if window.is_visible().unwrap_or(false) {
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        Ok(())
    } else {
        center_window_over_main(app, &window, width, height)
    }
}

pub(crate) fn fit_options_window(app: &tauri::AppHandle, width: f64) -> Result<(), String> {
    fit_auxiliary_window(app, "options", clamp_options_width(width), OPTIONS_INITIAL_H)
}

pub(crate) fn fit_metadata_window(app: &tauri::AppHandle, height: f64) -> Result<(), String> {
    fit_auxiliary_window(app, "metadata", META_INITIAL_W, clamp_metadata_height(height))
}

pub(crate) fn show_window(window: &tauri::Window) {
    TRAY_HIDDEN.clear(window.label());
    let _ = window.show();
    let _ = window.set_focus();
}

// Hide to tray
//
// The tray icon is built lazily on first hide so startup stays unchanged.
// Left click or Show restores main, Quit exits through the normal close path.
fn ensure_tray(app: &tauri::AppHandle) -> Result<(), String> {
    if app.tray_by_id("main-tray").is_some() {
        return Ok(());
    }
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|e| format!("Failed to load tray icon: {e}"))?;
    let show = tauri::menu::MenuItem::with_id(app, "tray-show", "Show", true, None::<&str>)
        .map_err(|e| format!("Failed to build tray menu: {e}"))?;
    let quit = tauri::menu::MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)
        .map_err(|e| format!("Failed to build tray menu: {e}"))?;
    let menu = tauri::menu::Menu::with_items(app, &[&show, &quit])
        .map_err(|e| format!("Failed to build tray menu: {e}"))?;
    tauri::tray::TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("QuiviT")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => restore_from_tray(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                ..
            } = event
            {
                restore_from_tray(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| format!("Failed to build tray icon: {e}"))?;
    Ok(())
}

// Secondary windows owned by this app. Mid-init windows stay hidden until fitted,
// so track only windows that were visible when hide_to_tray hid them.
const SECONDARY_WINDOWS: [&str; 3] = ["options", "metadata", "workspace-file-list"];

struct TrayHiddenTracker(AtomicU8);

impl TrayHiddenTracker {
    const fn new() -> Self {
        Self(AtomicU8::new(0))
    }

    fn bit(label: &str) -> u8 {
        match SECONDARY_WINDOWS.iter().position(|&item| item == label) {
            Some(index) => 1u8 << index,
            None => 0,
        }
    }

    fn mark_if_visible(&self, label: &str, visible: bool) {
        if !visible {
            return;
        }
        let mask = Self::bit(label);
        if mask != 0 {
            self.0.fetch_or(mask, Ordering::Relaxed);
        }
    }

    fn clear(&self, label: &str) {
        let mask = Self::bit(label);
        if mask != 0 {
            self.0.fetch_and(!mask, Ordering::Relaxed);
        }
    }

    fn take_labels(&self) -> Vec<&'static str> {
        let bits = self.0.swap(0, Ordering::Relaxed);
        SECONDARY_WINDOWS
            .iter()
            .enumerate()
            .filter_map(|(index, &label)| ((bits & (1u8 << index)) != 0).then_some(label))
            .collect()
    }
}

static TRAY_HIDDEN: TrayHiddenTracker = TrayHiddenTracker::new();

pub(crate) fn restore_from_tray(app: &tauri::AppHandle) {
    for label in TRAY_HIDDEN.take_labels() {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.show();
            let _ = window.unminimize();
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub(crate) fn hide_to_tray(app: &tauri::AppHandle) -> Result<(), String> {
    ensure_tray(app)?;
    for label in SECONDARY_WINDOWS {
        if let Some(window) = app.get_webview_window(label) {
            let visible = window.is_visible().unwrap_or(false);
            TRAY_HIDDEN.mark_if_visible(label, visible);
            if visible {
                let _ = window.hide();
            }
        }
    }
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    main.hide().map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "tests/windows_tests.rs"]
mod tests;
