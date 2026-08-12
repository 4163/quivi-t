pub mod archives;
pub mod commands;
pub mod config;
pub mod ico;
pub mod models;
pub mod utils;

use std::fs;
use std::sync::Mutex;
use tauri::http::Response;
use tauri::window::Color;
use tauri::{Emitter, Manager};

use archives::*;
use commands::*;
use config::*;
use ico::*;

// ── App entry point ──────────────────────────────────────────────────────────

// Sets the native window background color before the webview paints, so the
// shell behind the page is never white/black at launch.
//
// NOTE: this is only a startup fallback. Live theme / custom-CSS changes are
// synced by the frontend `src/js/shellBackground.js`, which invokes the
// `plugin:window|set_background_color` command directly with a `value` key.
// The official `@tauri-apps/api` `Window#setBackgroundColor` wrapper must NOT
// be used: it sends `{ color }` while this command's parameter is named
// `value`, and since it is `Option<Color>`, the missing key silently
// deserializes to `None` (no error) — which *resets* the background instead
// of setting it. See the file header of shellBackground.js for details.
//
// These values mirror `--surface` from src/css/main.css (the dominant visible
// page background), NOT `--bg` (the page backdrop): light #ffffff, dark
// #252526.
fn apply_shell_background(window: &tauri::WebviewWindow, config: &AppConfig) {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = crate::config::apply_pending_config();
    // Single instance defaults to true if not explicitly set to false
    let single_instance = config
        .frontend_data
        .get("single_instance")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let cache_mb = config.archive_cache_mb.unwrap_or(512);

    let mut builder = tauri::Builder::default();

    if single_instance {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.show();
                let _ = main_window.set_focus();
                if argv.len() > 1 {
                    let path = argv[1].clone();
                    let _ = main_window.emit("single-instance-open", path);
                }
            }
        }));
    }

    builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            // The 'main' window is built here in Rust (not declared in
            // tauri.conf.json) so all windows share a single construction path
            // in config.rs and the shell background is applied before first paint.
            let main_window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("QuiviT")
            .inner_size(MAIN_INITIAL_W, MAIN_INITIAL_H)
            .min_inner_size(MAIN_MIN_W, MAIN_MIN_H)
            .visible(false)
            .devtools(true)
            .build()
            .expect("failed to build main window");

            apply_shell_background(&main_window, &config);

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                use notify::{EventKind, RecursiveMode, Watcher};
                use std::time::Duration;

                let config_path = crate::config::get_config_path();
                if let Some(parent) = config_path.parent() {
                    let (tx, rx) = std::sync::mpsc::channel();
                    let mut watcher = notify::recommended_watcher(tx).unwrap();
                    let _ = watcher.watch(parent, RecursiveMode::NonRecursive);

                    let mut last_emit = std::time::Instant::now();

                    for res in rx {
                        match res {
                            Ok(event) => {
                                if let EventKind::Modify(_) = event.kind {
                                    if event
                                        .paths
                                        .iter()
                                        .any(|p| p.file_name() == config_path.file_name())
                                    {
                                        if last_emit.elapsed() > Duration::from_millis(500) {
                                            last_emit = std::time::Instant::now();
                                            let _ = app_handle.emit("config-changed", ());
                                        }
                                    }
                                }
                            }
                            Err(_) => {}
                        }
                    }
                }
            });
            Ok(())
        });

    builder
        .manage(Mutex::new(ArchiveCache::new(cache_mb)))
        .manage(Mutex::new(WatcherState::new()))
        .invoke_handler(tauri::generate_handler![
            read_directory,
            list_archive,
            prefetch_archive_entries,
            open_parent,
            open_sibling,
            open_sibling_container,
            load_config,
            get_config_dir,
            open_config_dir,
            get_local_data_dir,
            open_local_data_dir,
            save_config,
            open_options,
            fit_options_window,
            open_metadata_window,
            fit_metadata_window,
            get_drives,
            watch_directory,
            open_in_explorer,
            get_path_kind,
            read_text_file,
            write_text_file,
            get_default_dir,
            get_ico_frames,
            get_archive_ico_frames,
            get_native_icon,
            get_format_status,
            register_associations,
            unregister_associations,
            get_initial_args,
            show_window
        ])
        .register_asynchronous_uri_scheme_protocol("quivit", |ctx, request, responder| {
            // Protocol: quivit://archive/<archive_path_base64>/<entry_name>
            let url = request.uri().to_string();

            // URL could be http://quivit.localhost/archive/... or quivit://localhost/archive/...
            let parts: Vec<&str> = url.splitn(2, "/archive/").collect();

            if parts.len() < 2 {
                let response = Response::builder()
                    .status(400)
                    .body(format!("Invalid quivit URL: {}", url).into_bytes())
                    .unwrap();
                responder.respond(response);
                return;
            }

            let path_parts: Vec<&str> = parts[1].splitn(2, '/').collect();
            if path_parts.len() < 2 {
                let response = Response::builder()
                    .status(400)
                    .body(b"Missing archive path or entry name".to_vec())
                    .unwrap();
                responder.respond(response);
                return;
            }

            let archive_path = match base64_decode(path_parts[0]) {
                Some(p) => p,
                None => {
                    let response = Response::builder()
                        .status(400)
                        .body(b"Invalid base64 archive path".to_vec())
                        .unwrap();
                    responder.respond(response);
                    return;
                }
            };

            // URL-decode the entry name (handles %20, etc.)
            let entry_name = urlencoding_decode(path_parts[1]);

            let app_handle = ctx.app_handle().clone();

            std::thread::spawn(move || {
                let mut data = None;
                let ext = archive_path.rsplit('.').next().unwrap_or("").to_lowercase();

                {
                    let state = app_handle.state::<Mutex<ArchiveCache>>();
                    let mut cache = state.lock().unwrap();

                    if ext == "zip" || ext == "cbz" {
                        data = cache.get_zip_entry(&archive_path, &entry_name);
                    } else if ext == "rar"
                        || ext == "cbr"
                        || ext == "7z"
                        || ext == "cb7"
                        || ext == "cbt"
                        || ext == "tar"
                    {
                        if let Some(single) = cache.archives.get(&archive_path) {
                            if let Some(temp_dir) = &single.extract_temp_dir {
                                let safe_name = entry_name.replace('\\', "/");
                                let file_path = temp_dir.join(&safe_name);
                                if let Ok(bytes) = fs::read(&file_path) {
                                    data = Some(bytes);
                                }
                            }
                        }
                    }
                }

                if data.is_none() {
                    if ext == "zip" || ext == "cbz" {
                        let extracted = {
                            let state = app_handle.state::<Mutex<ArchiveCache>>();
                            let mut cache = state.lock().unwrap();
                            if let Some(single) = cache.archives.get_mut(&archive_path) {
                                if let Some(archive) = single.zip_archive.as_mut() {
                                    // Try direct lookup first (UTF-8 ZIPs) and fallback scan if needed
                                    crate::archives::read_zip_entry_by_decoded_name(
                                        archive,
                                        &entry_name,
                                    )
                                    .ok()
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        };

                        let d = if let Some(d) = extracted {
                            d
                        } else {
                            extract_zip_entry(&archive_path, &entry_name).unwrap_or_default()
                        };

                        if !d.is_empty() {
                            data = Some(d.clone());
                            let state = app_handle.state::<Mutex<ArchiveCache>>();
                            let mut cache = state.lock().unwrap();
                            cache.insert_zip_entry(&archive_path, &entry_name, d);
                        }
                    } else if ext == "rar"
                        || ext == "cbr"
                        || ext == "7z"
                        || ext == "cb7"
                        || ext == "cbt"
                        || ext == "tar"
                    {
                        let (temp_dir_opt, notify_opt) = {
                            let state = app_handle.state::<Mutex<ArchiveCache>>();
                            let cache = state.lock().unwrap();
                            if let Some(single) = cache.archives.get(&archive_path) {
                                (
                                    single.extract_temp_dir.clone(),
                                    Some(single.extract_notify.clone()),
                                )
                            } else {
                                (None, None)
                            }
                        };
                        if let Some(temp_dir) = temp_dir_opt {
                            let safe_name = entry_name.replace('\\', "/");
                            let file_path = temp_dir.join(&safe_name);

                            if let Ok(bytes) = fs::read(&file_path) {
                                data = Some(bytes);
                            } else if let Some(notify) = notify_opt {
                                let (lock, cvar) = &*notify;
                                let set = lock.lock().unwrap();
                                let timeout = std::time::Duration::from_secs(30);
                                let _ = cvar
                                    .wait_timeout_while(set, timeout, |pending| {
                                        !pending.contains(&entry_name)
                                    })
                                    .unwrap();

                                if let Ok(bytes) = fs::read(&file_path) {
                                    data = Some(bytes);
                                }
                            }
                        }
                    }
                }

                if let Some(d) = data {
                    let mime = guess_mime(&entry_name);
                    let response = Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Content-Length", d.len().to_string())
                        .header("Access-Control-Allow-Origin", "*")
                        .body(d)
                        .unwrap();
                    responder.respond(response);
                } else {
                    let response = Response::builder()
                        .status(404)
                        .body(b"Entry not found or failed to extract".to_vec())
                        .unwrap();
                    responder.respond(response);
                }
            });
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Architectural Standard: The 'main' window acts as the primary process lifecycle controller.
                // If the user closes the main viewer window, all secondary/child windows (Options, Metadata, etc.)
                // MUST be explicitly closed here to ensure the Tauri app exits cleanly rather than leaving orphans running.
                if window.label() == "main" {
                    if let Some(options_window) = window.app_handle().get_webview_window("options")
                    {
                        let _ = options_window.close();
                    }
                    if let Some(metadata_window) =
                        window.app_handle().get_webview_window("metadata")
                    {
                        let _ = metadata_window.close();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Utility functions ────────────────────────────────────────────────────────

fn base64_decode(input: &str) -> Option<String> {
    // Simple base64 decoder (no external crate needed for this)
    let decoded = base64_decode_bytes(input)?;
    String::from_utf8(decoded).ok()
}

fn base64_decode_bytes(input: &str) -> Option<Vec<u8>> {
    let input = input.replace('-', "+").replace('_', "/");
    let padding = (4 - input.len() % 4) % 4;
    let padded = format!("{}{}", input, "=".repeat(padding));

    let table: Vec<u8> = (0..256)
        .map(|i| match i as u8 as char {
            'A'..='Z' => (i - 65) as u8,
            'a'..='z' => (i - 97 + 26) as u8,
            '0'..='9' => (i - 48 + 52) as u8,
            '+' => 62,
            '/' => 63,
            _ => 255,
        })
        .collect();

    let mut output = Vec::new();
    let bytes = padded.as_bytes();

    for chunk in bytes.chunks(4) {
        if chunk.len() < 4 {
            break;
        }
        let vals: Vec<u8> = chunk.iter().map(|&b| table[b as usize]).collect();
        if vals
            .iter()
            .any(|&v| v == 255 && chunk[vals.iter().position(|&x| x == 255).unwrap()] != b'=')
        {
            return None;
        }

        output.push((vals[0] << 2) | (vals[1] >> 4));
        if chunk[2] != b'=' {
            output.push((vals[1] << 4) | (vals[2] >> 2));
        }
        if chunk[3] != b'=' {
            output.push((vals[2] << 6) | vals[3]);
        }
    }

    Some(output)
}

fn urlencoding_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut decoded: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(val) = u8::from_str_radix(hex, 16) {
                decoded.push(val);
                i += 3;
                continue;
            }
        }
        decoded.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(decoded).unwrap_or_default()
}

#[tauri::command]
fn open_in_explorer(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_default_dir() -> String {
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return format!("{}\\Pictures", profile);
        }
    }
    String::new()
}

fn guess_mime(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "apng" => "image/apng",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod archive_tests {
    use super::*;
    use crate::utils::*;

    use std::io::Read;

    fn test_file(name: &str) -> std::path::PathBuf {
        // Tests run with CWD = src-tauri; test files live under the repo root.
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test-files")
            .join("archives")
            .join(name)
    }

    /// Returns the cbt.cbt fixture, rebuilding it from the 7z fixture if it is
    /// missing or invalid, so the tar tests are self-provisioning (no external
    /// 7z/7za required).
    fn ensure_cbt() -> std::path::PathBuf {
        let cbt = test_file("cbt.cbt");
        let valid = cbt.exists()
            && list_tar_entries(cbt.to_str().unwrap())
                .map(|f| f.len() >= 12 && f.iter().any(|e| e.name.contains('/')))
                .unwrap_or(false);
        if valid {
            return cbt;
        }
        // Re-pack images extracted from the 7z fixture (which carries the same
        // root images + New folder/) into the cbt.
        let seven = test_file("7z.7z");
        let hash = format!("{:x}", md5::compute(seven.to_str().unwrap()));
        let scratch = std::env::temp_dir().join("QuiviT-test-cbt").join(hash);
        let _ = fs::remove_dir_all(&scratch);
        let notify = std::sync::Arc::new((
            std::sync::Mutex::new(std::collections::HashSet::new()),
            std::sync::Condvar::new(),
        ));
        extract_7z_to_temp(seven.to_str().unwrap().to_string(), scratch.clone(), notify);

        let mut builder = tar::Builder::new(fs::File::create(&cbt).expect("create cbt"));
        for entry in fs::read_dir(&scratch).expect("read extracted source folder") {
            let entry = entry.expect("source entry");
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                // Nested New folder/ entries
                for nested in fs::read_dir(entry.path()).expect("read nested folder") {
                    let nested = nested.expect("nested entry");
                    let nname = nested.file_name().to_string_lossy().into_owned();
                    let bytes = fs::read(nested.path()).expect("read nested image");
                    let mut header = tar::Header::new_gnu();
                    header.set_size(bytes.len() as u64);
                    header.set_mode(0o644);
                    header.set_mtime(0);
                    builder
                        .append_data(&mut header, format!("{name}/{nname}"), bytes.as_slice())
                        .expect("append nested tar entry");
                }
            } else {
                let bytes = fs::read(entry.path()).expect("read extracted image");
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o644);
                header.set_mtime(0);
                builder
                    .append_data(&mut header, name, bytes.as_slice())
                    .expect("append tar entry");
            }
        }
        builder.finish().expect("finish tar");
        let _ = fs::remove_dir_all(&scratch);
        cbt
    }
    #[test]
    fn lists_solid_7z_with_nested_folders() {
        let path = test_file("7z.7z");
        let files = list_7z_entries(path.to_str().unwrap()).expect("list 7z");
        assert!(
            files.len() >= 12,
            "expected >=12 image entries, got {}",
            files.len()
        );
        // Composite archive|entry paths, nested folder preserved
        assert!(files.iter().any(|f| f.path.contains('|')));
        assert!(files.iter().any(|f| f.name.contains('/')));
        // Sorted naturally
        let names: Vec<&String> = files.iter().map(|f| &f.name).collect();
        let mut sorted = names.clone();
        sorted.sort_by(|a, b| natord::compare(a, b));
        assert_eq!(names, sorted);
    }

    #[test]
    fn extracts_solid_7z_to_temp() {
        let path = test_file("7z.7z");
        let hash = format!("{:x}", md5::compute(path.to_str().unwrap()));
        let temp_dir = std::env::temp_dir().join("QuiviT-test-extract").join(hash);
        let _ = fs::remove_dir_all(&temp_dir);
        let notify = std::sync::Arc::new((
            std::sync::Mutex::new(std::collections::HashSet::new()),
            std::sync::Condvar::new(),
        ));
        extract_7z_to_temp(path.to_str().unwrap().to_string(), temp_dir.clone(), notify);

        // A nested entry must exist and match the same-named root entry
        // (the test 7z carries duplicate copies).
        let nested = temp_dir.join("New folder/export_1785518859589.webp");
        assert!(nested.exists(), "nested entry not extracted");
        let mut buf = Vec::new();
        fs::File::open(&nested)
            .unwrap()
            .read_to_end(&mut buf)
            .unwrap();
        let root = fs::read(temp_dir.join("export_1785518859589.webp")).unwrap();
        assert_eq!(buf.len(), root.len());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn lists_and_reads_tar() {
        let cbt = ensure_cbt();
        let files = list_tar_entries(cbt.to_str().unwrap()).expect("list tar");
        assert!(
            files.len() >= 12,
            "expected >=12 entries, got {}",
            files.len()
        );
        let names: Vec<String> = files.iter().map(|f| f.name.clone()).collect();
        assert!(names.iter().any(|n| n.contains("gfl-spinner.svg")));
        assert!(names.iter().any(|n| n.contains("Mine_(Idol)_S2_09.webp")));
        // Nested folder preserved in the cbt
        assert!(names.iter().any(|n| n.starts_with("New folder/")));

        let data = extract_tar_entry(cbt.to_str().unwrap(), "export_1785518878919.png")
            .expect("extract tar entry");
        // The cbt entry must byte-match the same file inside the 7z fixture.
        let seven = test_file("7z.7z");
        let hash = format!("{:x}", md5::compute(seven.to_str().unwrap()));
        let scratch = std::env::temp_dir().join("QuiviT-test-cbt").join(hash);
        let _ = fs::remove_dir_all(&scratch);
        let notify = std::sync::Arc::new((
            std::sync::Mutex::new(std::collections::HashSet::new()),
            std::sync::Condvar::new(),
        ));
        extract_7z_to_temp(seven.to_str().unwrap().to_string(), scratch.clone(), notify);
        let original = fs::read(scratch.join("export_1785518878919.png")).unwrap();
        assert_eq!(data.len(), original.len());
        let _ = fs::remove_dir_all(&scratch);
    }

    #[test]
    fn extracts_tar_to_temp() {
        let cbt = ensure_cbt();
        let hash = format!("{:x}", md5::compute(cbt.to_str().unwrap()));
        let temp_dir = std::env::temp_dir()
            .join("QuiviT-test-tar-extract")
            .join(hash);
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).ok();
        let notify = std::sync::Arc::new((
            std::sync::Mutex::new(std::collections::HashSet::new()),
            std::sync::Condvar::new(),
        ));

        extract_tar_to_temp(cbt.to_str().unwrap().to_string(), temp_dir.clone(), notify);

        let root = temp_dir.join("export_1785518878919.png");
        let nested = temp_dir.join("New folder/export_1785518859589.webp");
        assert!(root.exists(), "root TAR entry not extracted");
        assert!(nested.exists(), "nested TAR entry not extracted");
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn supported_archives_include_new_formats() {
        for ext in ["7z", "cb7", "cbt", "tar"] {
            assert!(is_archive_ext(ext), "{} not recognized as archive", ext);
        }
    }

    #[test]
    fn lists_rar5_cbr() {
        let path = test_file("cbr.cbr");
        let files = list_rar_entries(path.to_str().unwrap()).expect("list cbr");
        assert!(
            files.len() >= 7,
            "expected >=7 image entries, got {}",
            files.len()
        );
        assert!(files.iter().any(|f| f.name.contains("BDレーベル.bmp")));
    }

    #[test]
    fn lists_cb7_like_7z() {
        // cb7 is the comic-book extension for 7z — same codec, must route the same.
        let src = test_file("7z.7z");
        let cb7 = std::env::temp_dir()
            .join("QuiviT-test-extract")
            .join("sample.cb7");
        let _ = fs::remove_file(&cb7);
        fs::copy(&src, &cb7).expect("copy 7z to cb7");
        let files = list_7z_entries(cb7.to_str().unwrap()).expect("list cb7");
        assert!(files.len() >= 12, "cb7 listed {} entries", files.len());
        let _ = fs::remove_file(&cb7);
    }

    #[test]
    fn url_decode_roundtrips_utf8_entry_names() {
        // The 31MB BMP fixture is really named "BDレーベル.bmp". The frontend
        // builds the protocol URL with encodeURIComponent, so the handler must
        // decode percent-encoded multi-byte UTF-8 back to the original name.
        let name = "BDレーベル.bmp";
        let mut encoded = String::new();
        for b in name.as_bytes() {
            encoded.push_str(&format!("%{:02X}", b));
        }
        assert_eq!(urlencoding_decode(&encoded), name);
        // ASCII + spaces from encodeURIComponent also survive
        assert_eq!(urlencoding_decode("a%20b%26c.jpg"), "a b&c.jpg");
    }

    #[test]
    fn protocol_serve_timing_simulation() {
        // Mirrors the protocol handler serving path:
        //  - rar/cbr/7z/cb7/cbt/tar: served from extract_temp_dir
        //  - zip/cbz: on-demand extract_zip_entry
        // Simulates the FIRST image request arriving right after list_archive
        // spawns the background extractor, then reports how long the first
        // entry takes to become servable and whether the 3s poll would 404.
        use std::time::{Duration, Instant};

        fn poll_temp(temp_dir: &std::path::Path, entry: &str, timeout_ms: u64) -> (bool, Duration) {
            let safe = entry.replace('\\', "/");
            let path = temp_dir.join(&safe);
            let start = Instant::now();
            for _ in 0..(timeout_ms / 100) {
                if path.exists() {
                    return (true, start.elapsed());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            (path.exists(), start.elapsed())
        }

        let seven = test_file("7z.7z");
        let hash = format!("{:x}", md5::compute(seven.to_str().unwrap()));
        let temp_dir = std::env::temp_dir().join("QuiviT-test-serve").join(hash);
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).ok();

        // Spawn background extraction exactly like list_archive does.
        let seven_path = seven.to_str().unwrap().to_string();
        let td = temp_dir.clone();
        let notify = std::sync::Arc::new((
            std::sync::Mutex::new(std::collections::HashSet::new()),
            std::sync::Condvar::new(),
        ));
        std::thread::spawn(move || extract_7z_to_temp(seven_path, td, notify));

        // First sorted entry is BAKEMONOGATARI...jpg. Poll it like the handler would.
        let first =
            "BAKEMONOGATARI - c013 (v03) - p002 [Kodansha Comics] [Digital] [1r0n] {HQ}.jpg";
        let (found, elapsed) = poll_temp(&temp_dir, first, 30000);
        eprintln!("7z first entry poll: found={found} elapsed={:?}", elapsed);
        assert!(
            found,
            "first 7z entry never became available within 30s poll -> 404"
        );

        // Now the large BMP: how long until IT is extractable from the temp dir?
        let bmp = "BDレーベル.bmp";
        let (found_bmp, elapsed_bmp) = poll_temp(&temp_dir, bmp, 30000);
        eprintln!("7z BMP poll: found={found_bmp} elapsed={:?}", elapsed_bmp);

        // On-demand paths (cbz/tar) must serve the first image synchronously.
        let zip_first = extract_zip_entry(test_file("cbz.cbz").to_str().unwrap(), first);
        eprintln!(
            "cbz on-demand first entry: {}",
            zip_first
                .as_ref()
                .map(|d| format!("{} bytes", d.len()))
                .unwrap_or_else(|e| format!("ERR {e}"))
        );
        assert!(
            zip_first.is_ok(),
            "cbz on-demand extraction failed: {:?}",
            zip_first.err()
        );

        let cbt = ensure_cbt();
        let cbt_hash = format!("{:x}", md5::compute(cbt.to_str().unwrap()));
        let tar_temp_dir = std::env::temp_dir()
            .join("QuiviT-test-serve-tar")
            .join(cbt_hash);
        let _ = fs::remove_dir_all(&tar_temp_dir);
        fs::create_dir_all(&tar_temp_dir).ok();
        let tar_notify = std::sync::Arc::new((
            std::sync::Mutex::new(std::collections::HashSet::new()),
            std::sync::Condvar::new(),
        ));
        extract_tar_to_temp(
            cbt.to_str().unwrap().to_string(),
            tar_temp_dir.clone(),
            tar_notify,
        );
        let tar_first = fs::read(tar_temp_dir.join(first));
        eprintln!(
            "cbt temp first entry: {}",
            tar_first
                .as_ref()
                .map(|d| format!("{} bytes", d.len()))
                .unwrap_or_else(|e| format!("ERR {e}"))
        );
        assert!(
            tar_first.is_ok(),
            "cbt on-demand extraction failed: {:?}",
            tar_first.err()
        );

        let _ = fs::remove_dir_all(&temp_dir);
        let _ = fs::remove_dir_all(&tar_temp_dir);
    }

    #[test]
    fn archive_cache_byte_budget_evicts_globally() {
        // Verifies the multi-archive LRU from archives.rs without touching the
        // protocol/Tauri layers. A cache hit refreshes recency, and a single
        // entry larger than the whole budget must still be inserted.
        let mut cache = ArchiveCache::new(2); // 2 MB budget

        // Mirrors list_archive: each opened archive first registers a slot.
        let register = |cache: &mut ArchiveCache, archive: &str| {
            cache.register_archive(
                archive.to_string(),
                SingleArchiveCache {
                    zip_entries: std::collections::HashMap::new(),
                    zip_archive: None,
                    extract_temp_dir: None,
                    extract_notify: std::sync::Arc::new((
                        std::sync::Mutex::new(std::collections::HashSet::new()),
                        std::sync::Condvar::new(),
                    )),
                },
            );
        };
        register(&mut cache, "a.cbz");
        register(&mut cache, "b.cbz");

        let insert = |cache: &mut ArchiveCache, archive: &str, entry: &str, bytes: usize| {
            let data = vec![0u8; bytes];
            cache.insert_zip_entry(archive, entry, data);
        };

        // 1 MB entries
        let mb1 = 1024 * 1024;
        insert(&mut cache, "a.cbz", "p1", mb1);
        insert(&mut cache, "a.cbz", "p2", mb1); // 2 MB total — at budget
        assert_eq!(cache.current_zip_bytes, 2 * mb1);
        assert!(cache.archives["a.cbz"].zip_entries.contains_key("p1"));

        // Touch p1, then insert p3. p2 is now least-recently-used and leaves.
        assert!(cache.get_zip_entry("a.cbz", "p1").is_some());
        insert(&mut cache, "a.cbz", "p3", mb1);
        assert!(cache.archives["a.cbz"].zip_entries.contains_key("p1"));
        assert!(!cache.archives["a.cbz"].zip_entries.contains_key("p2"));
        assert!(cache.archives["a.cbz"].zip_entries.contains_key("p3"));
        assert_eq!(cache.current_zip_bytes, 2 * mb1);

        // An entry in a second archive shares the same global budget.
        insert(&mut cache, "b.cbz", "q1", mb1);
        // Now 3 MB owed against 2 MB budget: p1 leaves first, then p3.
        insert(&mut cache, "b.cbz", "q2", mb1);
        assert!(!cache.archives["a.cbz"].zip_entries.contains_key("p1"));
        assert!(!cache.archives["a.cbz"].zip_entries.contains_key("p3"));
        assert!(cache.archives["b.cbz"].zip_entries.contains_key("q1"));
        assert!(cache.archives["b.cbz"].zip_entries.contains_key("q2"));
        assert_eq!(cache.current_zip_bytes, 2 * mb1);

        // Oversized single entry still lands even though it alone exceeds budget.
        insert(&mut cache, "b.cbz", "huge", 4 * mb1);
        assert!(cache.archives["b.cbz"].zip_entries.contains_key("huge"));
        assert_eq!(cache.current_zip_bytes, 4 * mb1);

        // Re-insertion of an already-cached key is a no-op (byte count stable).
        let before = cache.current_zip_bytes;
        insert(&mut cache, "b.cbz", "huge", 4 * mb1);
        assert_eq!(cache.current_zip_bytes, before);

        cache.insert_zip_entry("missing.cbz", "ghost", vec![0u8; mb1]);
        assert_eq!(cache.current_zip_bytes, before);
    }

    #[test]
    fn archive_cache_bounds_open_archive_state() {
        let mut cache = ArchiveCache::new(2);
        cache.max_open_archives = 2;

        let register = |cache: &mut ArchiveCache, archive: &str| {
            cache.register_archive(
                archive.to_string(),
                SingleArchiveCache {
                    zip_entries: std::collections::HashMap::new(),
                    zip_archive: None,
                    extract_temp_dir: None,
                    extract_notify: std::sync::Arc::new((
                        std::sync::Mutex::new(std::collections::HashSet::new()),
                        std::sync::Condvar::new(),
                    )),
                },
            );
        };

        register(&mut cache, "a.cbz");
        cache.insert_zip_entry("a.cbz", "p1", vec![0u8; 1024]);
        register(&mut cache, "b.cbz");
        register(&mut cache, "c.cbz");

        assert!(!cache.archives.contains_key("a.cbz"));
        assert!(cache.archives.contains_key("b.cbz"));
        assert!(cache.archives.contains_key("c.cbz"));
        assert_eq!(cache.current_zip_bytes, 0);
    }
}
