use std::fs;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use tauri::Emitter;

use crate::archives::ArchiveCache;
use crate::formats;
use crate::models::AnimationInfo;

static SCAN_GENERATION: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
pub fn cancel_width_scan() {
    SCAN_GENERATION.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command(async)]
pub fn check_is_animated(
    path: String,
    archive_path: Option<String>,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<AnimationInfo, String> {
    if let Some(arc_path) = archive_path {
        let header = {
            let mut cache = state.write().map_err(|e| e.to_string())?;
            cache.read_entry_header(&arc_path, &path, 262_144)?
        };
        Ok(crate::formats::check_animation_status(&header))
    } else {
        let mut f = fs::File::open(&path).map_err(|e| format!("Cannot open file: {}", e))?;
        let mut buffer = vec![0u8; 262_144]; // 256 KiB
        let bytes_read = f.read(&mut buffer).unwrap_or(0);
        Ok(crate::formats::check_animation_status(
            &buffer[..bytes_read],
        ))
    }
}

#[tauri::command(async)]
pub fn check_media_audio(
    path: String,
    archive_path: Option<String>,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<bool, String> {
    if let Some(arc_path) = archive_path {
        let entry_bytes = {
            let mut cache = state.write().map_err(|e| e.to_string())?;
            cache.read_entry_header(&arc_path, &path, 524_288)?
        };
        let mut cursor = std::io::Cursor::new(&entry_bytes);
        Ok(crate::formats::check_mp4_has_audio(&mut cursor))
    } else {
        let mut f = fs::File::open(&path).map_err(|e| format!("Cannot open file: {}", e))?;
        Ok(crate::formats::check_mp4_has_audio(&mut f))
    }
}

/// Bytes read from each entry header for dimension probing.
const DIMENSION_HEADER_LIMIT: usize = 32_768;

/// Extensions skipped during the width scan. SVG has no reliable header
/// dimensions, and ICO dimensions differ from the generated spritesheet.
fn skip_for_width_scan(ext: &str) -> bool {
    ext.eq_ignore_ascii_case("svg") || ext.eq_ignore_ascii_case("ico")
}

/// Background sweep: read image/video headers to find the widest entry in
/// a directory or ZIP archive. Emits `manhwa-max-width` each time a wider
/// entry is found so the frontend can progressively update the strip.
#[tauri::command(async)]
pub fn scan_container_max_width(
    container: String,
    is_archive: bool,
    password: Option<String>,
    app: tauri::AppHandle,
) {
    let gen = SCAN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let mut max_w: u32 = 0;
        if is_archive {
            scan_archive_widths(&container, password.as_deref(), &app, &mut max_w, gen);
        } else {
            scan_directory_widths(&container, &app, &mut max_w, gen);
        }
    });
}

fn emit_max_width(app: &tauri::AppHandle, container: &str, w: u32) {
    let _ = app.emit(
        "manhwa-max-width",
        serde_json::json!({ "container": container, "max_width": w }),
    );
}

fn scan_directory_widths(dir: &str, app: &tauri::AppHandle, max_w: &mut u32, gen: u64) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if SCAN_GENERATION.load(Ordering::Relaxed) != gen {
            return;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e.to_owned(),
            None => continue,
        };
        if skip_for_width_scan(&ext) {
            continue;
        }

        let w = if ext.eq_ignore_ascii_case("mp4") {
            let mut f = match fs::File::open(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            formats::read_mp4_dimensions(&mut f).map(|(w, _)| w)
        } else if formats::is_image_ext(&ext) {
            image::image_dimensions(&path).ok().map(|(w, _)| w)
        } else {
            None
        };

        if let Some(w) = w {
            if w > *max_w {
                *max_w = w;
                emit_max_width(app, dir, w);
            }
        }
    }
}

fn scan_archive_widths(
    archive_path: &str,
    password: Option<&str>,
    app: &tauri::AppHandle,
    max_w: &mut u32,
    gen: u64,
) {
    let ext = archive_path.rsplit('.').next().unwrap_or("");
    if ext.eq_ignore_ascii_case("zip") || ext.eq_ignore_ascii_case("cbz") {
        scan_zip_archive_widths(archive_path, password, app, max_w, gen);
    } else {
        scan_temp_archive_widths(archive_path, app, max_w, gen);
    }
}

fn scan_zip_archive_widths(
    archive_path: &str,
    password: Option<&str>,
    app: &tauri::AppHandle,
    max_w: &mut u32,
    gen: u64,
) {
    let mut archive = match crate::archives::open_zip_archive(archive_path) {
        Ok(a) => a,
        Err(_) => return,
    };
    let count = archive.len();
    for i in 0..count {
        if SCAN_GENERATION.load(Ordering::Relaxed) != gen {
            return;
        }
        let mut entry = match password {
            Some(pwd) => archive.by_index_decrypt(i, pwd.as_bytes()),
            None => archive.by_index(i),
        };
        let entry = match entry.as_mut() {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.is_dir() {
            continue;
        }
        let name = crate::archives::decode_cjk_name(entry.name_raw());
        let entry_ext = name.rsplit('.').next().unwrap_or("");
        if skip_for_width_scan(entry_ext) {
            continue;
        }

        let is_mp4 = entry_ext.eq_ignore_ascii_case("mp4");
        let is_image = formats::is_image_ext(entry_ext);
        if !is_mp4 && !is_image {
            continue;
        }

        let limit = (DIMENSION_HEADER_LIMIT as u64).min(entry.size());
        let mut buf = Vec::with_capacity(limit as usize);
        if entry.by_ref().take(limit).read_to_end(&mut buf).is_err() {
            continue;
        }

        let w = if is_mp4 {
            let mut cursor = std::io::Cursor::new(&buf);
            formats::read_mp4_dimensions(&mut cursor).map(|(w, _)| w)
        } else {
            formats::read_dimensions_from_bytes(&buf).map(|(w, _)| w)
        };

        if let Some(w) = w {
            if w > *max_w {
                *max_w = w;
                emit_max_width(app, archive_path, w);
            }
        }
    }
}

fn scan_temp_archive_widths(
    archive_path: &str,
    app: &tauri::AppHandle,
    max_w: &mut u32,
    gen: u64,
) {
    use tauri::Manager;
    let mut extraction_state = None;
    for _ in 0..10 {
        if SCAN_GENERATION.load(Ordering::Relaxed) != gen {
            return;
        }
        if let Some(cache) = app.try_state::<RwLock<ArchiveCache>>() {
            if let Ok(c) = cache.read() {
                if let Some(s) = c.temp_extraction_state(archive_path) {
                    extraction_state = Some(s);
                    break;
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    let (temp_dir, notify) = match extraction_state {
        Some(s) => s,
        None => return,
    };

    let (lock, cvar) = &*notify;
    let mut checked: std::collections::HashSet<String> = std::collections::HashSet::new();

    loop {
        if SCAN_GENERATION.load(Ordering::Relaxed) != gen {
            return;
        }

        let (to_check, is_finished) = {
            let guard = match lock.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let new_entries: Vec<String> = guard
                .extracted
                .iter()
                .filter(|name| !checked.contains(*name))
                .cloned()
                .collect();
            (new_entries, guard.finished)
        };

        for name in to_check {
            if SCAN_GENERATION.load(Ordering::Relaxed) != gen {
                return;
            }
            checked.insert(name.clone());
            let ext = name.rsplit('.').next().unwrap_or("");
            if skip_for_width_scan(ext) {
                continue;
            }
            if let Some(path) = crate::archives::archive_entry_temp_path(&temp_dir, &name) {
                let is_mp4 = ext.eq_ignore_ascii_case("mp4");
                let is_image = formats::is_image_ext(ext);
                let w = if is_mp4 {
                    if let Ok(mut f) = fs::File::open(&path) {
                        formats::read_mp4_dimensions(&mut f).map(|(w, _)| w)
                    } else {
                        None
                    }
                } else if is_image {
                    image::image_dimensions(&path).ok().map(|(w, _)| w)
                } else {
                    None
                };
                if let Some(w) = w {
                    if w > *max_w {
                        *max_w = w;
                        emit_max_width(app, archive_path, w);
                    }
                }
            }
        }

        if is_finished {
            break;
        }

        if let Ok(guard) = lock.lock() {
            if !guard.finished && guard.extracted.len() == checked.len() {
                let _ = cvar.wait_timeout(guard, std::time::Duration::from_millis(50));
            }
        }
    }
}
