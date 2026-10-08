use crate::config::AppConfig;
use tauri::window::Color;
use tauri::Manager;

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

// Options window width auto-fits to content (capped at OPTIONS_MAX_W), height fixed.
pub(crate) const OPTIONS_INITIAL_W: f64 = AUTO_FIT_INITIAL_W;
pub(crate) const OPTIONS_INITIAL_H: f64 = 620.0;
pub(crate) const OPTIONS_MIN_W: f64 = 400.0;
pub(crate) const OPTIONS_MIN_H: f64 = 360.0;
// Auto-fit clamp for the width; mirrored by OPTIONS_MAX_INITIAL_W in shared/windowFit.js.
#[allow(dead_code)] // Single source of truth for the cap; enforced in JS.
const OPTIONS_MAX_W: f64 = 560.0;

// Metadata window is 400 wide; height auto-fits to content (capped at META_MAX_H,
// a fit cap, not a hard size limit). Opens hidden, fitted + centered before show.
pub(crate) const META_INITIAL_W: f64 = 400.0;
pub(crate) const META_INITIAL_H: f64 = AUTO_FIT_INITIAL_H;
pub(crate) const META_MIN_W: f64 = 320.0;
pub(crate) const META_MIN_H: f64 = 280.0;
// Auto-fit clamp; mirrored by META_MAX_INITIAL_H in shared/windowFit.js.
#[allow(dead_code)] // Single source of truth for the cap; enforced in JS.
const META_MAX_H: f64 = 600.0;

// Styling and appearance

// Sets the native window background color before the webview paints, so the
// shell behind the page is never white/black at launch.
pub fn apply_shell_background(window: &tauri::WebviewWindow, config: &AppConfig) {
    let theme = config
        .frontend_data
        .get("theme")
        .and_then(|v| v.as_str())
        .unwrap_or("system");

    let dark = match theme {
        "dark" => true,
        "light" => false,
        _ => window
            .theme()
            .map(|theme| theme == tauri::Theme::Dark)
            .unwrap_or(false),
    };

    // --surface (light) / --surface (dark)
    let color = if dark {
        Color(37, 37, 38, 255)
    } else {
        Color(255, 255, 255, 255)
    };

    let _ = window.set_background_color(Some(color));
}

#[tauri::command]
pub fn update_theme(app: tauri::AppHandle, theme: Option<String>) {
    let tauri_theme = match theme.as_deref() {
        Some("dark") => Some(tauri::Theme::Dark),
        Some("light") => Some(tauri::Theme::Light),
        _ => None,
    };

    let dark = tauri_theme == Some(tauri::Theme::Dark)
        || (tauri_theme.is_none()
            && app.get_webview_window("main").and_then(|w| w.theme().ok())
                == Some(tauri::Theme::Dark));

    let color = if dark {
        Color(37, 37, 38, 255)
    } else {
        Color(255, 255, 255, 255)
    };

    for (_, window) in app.webview_windows() {
        let _ = window.set_theme(tauri_theme);
        let _ = window.set_background_color(Some(color));
    }
}

// Secondary window creation and fitting

#[tauri::command]
pub async fn open_options(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("options") {
        // The window can exist but be hidden (hide to tray), so show it, not just focus it.
        if !window
            .is_visible()
            .map_err(|e| format!("Failed to check options window: {e}"))?
        {
            window
                .show()
                .map_err(|e| format!("Failed to show options window: {e}"))?;
        }
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus options window: {e}"))?;
        return Ok(());
    }

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "options",
        tauri::WebviewUrl::App("options.html".into()),
    )
    .title("Options")
    .inner_size(OPTIONS_INITIAL_W, OPTIONS_INITIAL_H)
    .min_inner_size(OPTIONS_MIN_W, OPTIONS_MIN_H)
    .resizable(true)
    .closable(true)
    .maximizable(false)
    .visible(false)
    .devtools(true)
    .general_autofill_enabled(false)
    .center();

    builder
        .build()
        .map_err(|e| format!("Failed to open options window: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn open_metadata_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("metadata") {
        // The window can exist but be hidden (hide to tray), so show it, not just focus it.
        if !window
            .is_visible()
            .map_err(|e| format!("Failed to check metadata window: {e}"))?
        {
            window
                .show()
                .map_err(|e| format!("Failed to show metadata window: {e}"))?;
        }
        window
            .set_focus()
            .map_err(|e| format!("Failed to focus metadata window: {e}"))?;
        return Ok(());
    }

    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "metadata",
        tauri::WebviewUrl::App("metadata.html".into()),
    )
    .title("Archive Info")
    .inner_size(META_INITIAL_W, META_INITIAL_H)
    .min_inner_size(META_MIN_W, META_MIN_H)
    .resizable(true)
    .closable(true)
    .maximizable(true)
    .visible(false)
    .devtools(true)
    .general_autofill_enabled(false)
    .center();

    builder
        .build()
        .map_err(|e| format!("Failed to open metadata window: {e}"))?;

    Ok(())
}

pub fn center_window_over_main(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    target_width: f64,
    target_height: f64,
) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let pos = main.outer_position().map_err(|e| e.to_string())?;
    let size = main.outer_size().map_err(|e| e.to_string())?;
    let scale = main.scale_factor().map_err(|e| e.to_string())?;

    let x = pos.x + (size.width as i32 - (target_width * scale) as i32) / 2;
    let y = pos.y + (size.height as i32 - (target_height * scale) as i32) / 2;

    window
        .set_size(tauri::LogicalSize::new(target_width, target_height))
        .map_err(|e| e.to_string())?;

    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn fit_options_window(app: tauri::AppHandle, width: f64) -> Result<(), String> {
    let options = app
        .get_webview_window("options")
        .ok_or_else(|| "options window not found".to_string())?;

    let visible = options.is_visible().unwrap_or(false);
    if visible {
        options
            .set_size(tauri::LogicalSize::new(width, OPTIONS_INITIAL_H))
            .map_err(|e| e.to_string())?;
        Ok(())
    } else {
        center_window_over_main(&app, &options, width, OPTIONS_INITIAL_H)
    }
}

#[tauri::command]
pub async fn fit_metadata_window(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    let metadata = app
        .get_webview_window("metadata")
        .ok_or_else(|| "metadata window not found".to_string())?;

    let visible = metadata.is_visible().unwrap_or(false);
    if visible {
        metadata
            .set_size(tauri::LogicalSize::new(META_INITIAL_W, height))
            .map_err(|e| e.to_string())?;
        Ok(())
    } else {
        center_window_over_main(&app, &metadata, META_INITIAL_W, height)
    }
}

#[tauri::command]
pub fn show_window(window: tauri::Window) {
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

// Secondary windows owned by this app. Closed windows are gone, so only
// windows hidden by hide_to_tray (or mid-open) can exist here on restore.
const SECONDARY_WINDOWS: [&str; 2] = ["options", "metadata"];

fn restore_from_tray(app: &tauri::AppHandle) {
    for label in SECONDARY_WINDOWS {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.show();
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub async fn hide_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    ensure_tray(&app)?;
    for label in SECONDARY_WINDOWS {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.hide();
        }
    }
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    main.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn show_from_tray(app: tauri::AppHandle) -> Result<(), String> {
    restore_from_tray(&app);
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    main.set_focus().map_err(|e| e.to_string())
}
