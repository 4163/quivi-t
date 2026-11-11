use std::fs;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use tauri::{Emitter, Manager};

use crate::archives::ArchiveCache;
use crate::formats;

static SCAN_GENERATION: AtomicU64 = AtomicU64::new(0);
static DIMS_SCAN_GENERATION: AtomicU64 = AtomicU64::new(0);

const DIMS_BATCH_SIZE: usize = 64;
const DIMENSION_HEADER_LIMIT: usize = 32_768;

#[derive(serde::Serialize, Clone)]
pub struct DimensionEntry {
    pub name: String,
    pub width: u32,
    pub height: u32,
}

pub fn cancel_width_scan() {
    SCAN_GENERATION.fetch_add(1, Ordering::SeqCst);
}

pub fn cancel_dims_scan() {
    DIMS_SCAN_GENERATION.fetch_add(1, Ordering::SeqCst);
}

// SVG has no reliable header dimensions; ICO header dimensions differ from the generated row total.
fn skip_for_width_scan(ext: &str) -> bool {
    ext.eq_ignore_ascii_case("svg") || ext.eq_ignore_ascii_case("ico")
}

pub fn scan_container_max_width(
    container: String,
    is_archive: bool,
    password: Option<String>,
    app: tauri::AppHandle,
) {
    let gen = SCAN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        if SCAN_GENERATION.load(Ordering::Relaxed) != gen {
            return;
        }
        let mut max_w: u32 = 0;
        if is_archive {
            scan_archive_widths(&container, password.as_deref(), &app, &mut max_w, gen);
        } else {
            scan_directory_widths(&container, &app, &mut max_w, gen);
        }
    });
}

fn emit_max_width(app: &tauri::AppHandle, container: &str, w: u32, gen: u64) {
    if SCAN_GENERATION.load(Ordering::Relaxed) != gen {
        return;
    }
    let _ = app.emit(
        "manhwa-max-width",
        serde_json::json!({ "container": container, "max_width": w }),
    );
}

fn emit_scan_done(app: &tauri::AppHandle, container: &str, max_w: u32, gen: u64) {
    if SCAN_GENERATION.load(Ordering::Relaxed) != gen {
        return;
    }
    let _ = app.emit(
        "manhwa-max-width",
        serde_json::json!({ "container": container, "max_width": max_w, "done": true }),
    );
}

fn scan_directory_widths(dir: &str, app: &tauri::AppHandle, max_w: &mut u32, gen: u64) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => {
            emit_scan_done(app, dir, *max_w, gen);
            return;
        }
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
                emit_max_width(app, dir, w, gen);
            }
        }
    }
    emit_scan_done(app, dir, *max_w, gen);
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
        Err(_) => {
            emit_scan_done(app, archive_path, *max_w, gen);
            return;
        }
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
                emit_max_width(app, archive_path, w, gen);
            }
        }
    }
    emit_scan_done(app, archive_path, *max_w, gen);
}

fn scan_temp_archive_widths(
    archive_path: &str,
    app: &tauri::AppHandle,
    max_w: &mut u32,
    gen: u64,
) {
    let extraction_state = app.try_state::<RwLock<ArchiveCache>>().and_then(|cache| {
        crate::archives::wait_for_temp_extraction_state(
            &cache,
            archive_path,
            std::time::Duration::from_millis(500),
            || SCAN_GENERATION.load(Ordering::Relaxed) != gen,
        )
    });

    let (temp_dir, notify) = match extraction_state {
        Some(s) => s,
        None => {
            emit_scan_done(app, archive_path, *max_w, gen);
            return;
        }
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
                        emit_max_width(app, archive_path, w, gen);
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
    emit_scan_done(app, archive_path, *max_w, gen);
}

pub fn scan_container_dimensions(
    container: String,
    is_archive: bool,
    password: Option<String>,
    app: tauri::AppHandle,
) {
    let gen = DIMS_SCAN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        if DIMS_SCAN_GENERATION.load(Ordering::Relaxed) != gen {
            return;
        }
        if is_archive {
            let ext = container.rsplit('.').next().unwrap_or("");
            if ext.eq_ignore_ascii_case("zip") || ext.eq_ignore_ascii_case("cbz") {
                scan_zip_archive_dimensions(&container, password.as_deref(), &app, gen);
            } else {
                scan_temp_archive_dimensions(&container, &app, gen);
            }
        } else {
            scan_directory_dimensions(&container, &app, gen);
        }
    });
}

fn emit_dims_batch(
    app: &tauri::AppHandle,
    container: &str,
    entries: Vec<DimensionEntry>,
    done: bool,
    gen: u64,
) {
    if DIMS_SCAN_GENERATION.load(Ordering::Relaxed) != gen {
        return;
    }
    let _ = app.emit(
        "container-dimensions",
        serde_json::json!({
            "container": container,
            "entries": entries,
            "done": done,
        }),
    );
}

fn scan_directory_dimensions(dir: &str, app: &tauri::AppHandle, gen: u64) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => {
            emit_dims_batch(app, dir, Vec::new(), true, gen);
            return;
        }
    };
    let mut batch = Vec::with_capacity(DIMS_BATCH_SIZE);
    for entry in entries.flatten() {
        if DIMS_SCAN_GENERATION.load(Ordering::Relaxed) != gen {
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
        if !formats::is_image_ext(&ext) && !ext.eq_ignore_ascii_case("mp4") {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(|s| s.to_owned()) else {
            continue;
        };
        if let Some((width, height)) = formats::read_media_dimensions_from_path(&path, &ext) {
            if width > 0 && height > 0 {
                batch.push(DimensionEntry { name, width, height });
                if batch.len() >= DIMS_BATCH_SIZE {
                    emit_dims_batch(app, dir, std::mem::take(&mut batch), false, gen);
                }
            }
        }
    }
    emit_dims_batch(app, dir, batch, true, gen);
}

fn scan_zip_archive_dimensions(
    archive_path: &str,
    password: Option<&str>,
    app: &tauri::AppHandle,
    gen: u64,
) {
    let mut archive = match crate::archives::open_zip_archive(archive_path) {
        Ok(a) => a,
        Err(_) => {
            emit_dims_batch(app, archive_path, Vec::new(), true, gen);
            return;
        }
    };
    let count = archive.len();
    let mut batch = Vec::with_capacity(DIMS_BATCH_SIZE);
    for i in 0..count {
        if DIMS_SCAN_GENERATION.load(Ordering::Relaxed) != gen {
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
        let entry_ext = name.rsplit('.').next().unwrap_or("").to_owned();
        if !formats::is_image_ext(&entry_ext) && !entry_ext.eq_ignore_ascii_case("mp4") {
            continue;
        }
        let entry_size = entry.size();
        if let Some((width, height)) =
            formats::read_media_dimensions_from_stream(entry, entry_size, &entry_ext)
        {
            if width > 0 && height > 0 {
                batch.push(DimensionEntry { name, width, height });
                if batch.len() >= DIMS_BATCH_SIZE {
                    emit_dims_batch(app, archive_path, std::mem::take(&mut batch), false, gen);
                }
            }
        }
    }
    emit_dims_batch(app, archive_path, batch, true, gen);
}

fn scan_temp_archive_dimensions(archive_path: &str, app: &tauri::AppHandle, gen: u64) {
    let extraction_state = app.try_state::<RwLock<ArchiveCache>>().and_then(|cache| {
        crate::archives::wait_for_temp_extraction_state(
            &cache,
            archive_path,
            std::time::Duration::from_millis(500),
            || DIMS_SCAN_GENERATION.load(Ordering::Relaxed) != gen,
        )
    });

    let (temp_dir, notify) = match extraction_state {
        Some(s) => s,
        None => {
            emit_dims_batch(app, archive_path, Vec::new(), true, gen);
            return;
        }
    };

    let (lock, cvar) = &*notify;
    let mut checked: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut batch = Vec::with_capacity(DIMS_BATCH_SIZE);

    loop {
        if DIMS_SCAN_GENERATION.load(Ordering::Relaxed) != gen {
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
            if DIMS_SCAN_GENERATION.load(Ordering::Relaxed) != gen {
                return;
            }
            checked.insert(name.clone());
            let ext = name.rsplit('.').next().unwrap_or("");
            if !formats::is_image_ext(ext) && !ext.eq_ignore_ascii_case("mp4") {
                continue;
            }
            if let Some(path) = crate::archives::archive_entry_temp_path(&temp_dir, &name) {
                if let Some((width, height)) = formats::read_media_dimensions_from_path(&path, ext) {
                    if width > 0 && height > 0 {
                        batch.push(DimensionEntry { name, width, height });
                        if batch.len() >= DIMS_BATCH_SIZE {
                            emit_dims_batch(
                                app,
                                archive_path,
                                std::mem::take(&mut batch),
                                false,
                                gen,
                            );
                        }
                    }
                }
            }
        }

        if !batch.is_empty() {
            emit_dims_batch(app, archive_path, std::mem::take(&mut batch), false, gen);
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
    emit_dims_batch(app, archive_path, batch, true, gen);
}
