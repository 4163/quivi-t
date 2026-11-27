use std::fs;
use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use tauri::{Emitter, Manager};

use crate::archives::{
    read_entry_header_shared, scan_container_dimensions_with, scan_container_max_width_with,
    with_entry_stream_shared, ArchiveCache, TEMP_REG_WAIT_TIMEOUT,
};
use crate::formats;
use crate::models::{AnimationInfo, DimensionEntry};

#[cfg(test)]
use crate::archives::skip_for_width_scan;

static SCAN_GENERATION: AtomicU64 = AtomicU64::new(0);
static DIMS_SCAN_GENERATION: AtomicU64 = AtomicU64::new(0);

const INITIAL_ANIM_PROBE_BYTES: usize = 8 * 1024;
const MAX_ANIM_PROBE_BYTES: usize = 262_144;

#[tauri::command]
pub fn cancel_width_scan() {
    SCAN_GENERATION.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
pub fn cancel_dims_scan() {
    DIMS_SCAN_GENERATION.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command(async)]
pub fn probe_media_dimensions(path: String) -> Option<(u32, u32)> {
    let p = Path::new(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
    formats::read_media_dimensions_from_path(p, ext)
}

fn read_up_to(reader: &mut impl Read, buf: &mut [u8]) -> usize {
    let mut total = 0;
    while total < buf.len() {
        match reader.read(&mut buf[total..]) {
            Ok(0) => break,
            Ok(n) => total += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    total
}

fn needs_extended_animation_probe(header: &[u8]) -> bool {
    if header.len() < 8 {
        return false;
    }
    if header.starts_with(b"GIF8")
        || (header.starts_with(b"RIFF") && header.len() > 12 && &header[8..12] == b"WEBP")
        || header.starts_with(b"\x89PNG\r\n\x1a\n")
        || (header.len() >= 12 && &header[4..8] == b"ftyp")
    {
        return true;
    }
    let rest = header.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(header);
    rest.iter()
        .find(|b| !b.is_ascii_whitespace())
        .is_some_and(|&b| b == b'<')
}

fn check_file_is_animated(path: &Path) -> Result<AnimationInfo, String> {
    let mut f = fs::File::open(path).map_err(|e| format!("Cannot open file: {}", e))?;
    let file_len = f
        .metadata()
        .map(|m| m.len() as usize)
        .unwrap_or(MAX_ANIM_PROBE_BYTES);

    let mut stack_buf = [0u8; INITIAL_ANIM_PROBE_BYTES];
    let n = read_up_to(&mut f, &mut stack_buf);
    let initial = formats::check_animation_status(&stack_buf[..n]);
    if initial.is_animated
        || n < INITIAL_ANIM_PROBE_BYTES
        || file_len <= n
        || !needs_extended_animation_probe(&stack_buf[..n])
    {
        return Ok(initial);
    }

    let target_len = file_len.min(MAX_ANIM_PROBE_BYTES);
    let mut buf = Vec::with_capacity(target_len);
    buf.extend_from_slice(&stack_buf[..n]);
    let _ = f.take((target_len - n) as u64).read_to_end(&mut buf);
    Ok(formats::check_animation_status(&buf))
}

#[tauri::command(async)]
pub fn check_is_animated(
    path: String,
    archive_path: Option<String>,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<AnimationInfo, String> {
    if let Some(arc_path) = archive_path {
        let header = read_entry_header_shared(&state, &arc_path, &path, MAX_ANIM_PROBE_BYTES)?;
        Ok(formats::check_animation_status(&header))
    } else {
        check_file_is_animated(Path::new(&path))
    }
}

fn check_archive_media_audio(
    state: &RwLock<ArchiveCache>,
    archive_path: &str,
    entry_name: &str,
) -> Result<bool, String> {
    with_entry_stream_shared(state, archive_path, entry_name, |mut reader| {
        formats::check_mp4_has_audio_stream(&mut reader)
    })
}

fn check_file_media_audio(path: &Path) -> Result<bool, String> {
    let f = fs::File::open(path).map_err(|e| format!("Cannot open file: {}", e))?;
    let mut reader = BufReader::new(f);
    Ok(formats::check_mp4_has_audio(&mut reader))
}

#[tauri::command(async)]
pub fn check_media_audio(
    path: String,
    archive_path: Option<String>,
    state: tauri::State<'_, RwLock<ArchiveCache>>,
) -> Result<bool, String> {
    if let Some(arc_path) = archive_path {
        check_archive_media_audio(&state, &arc_path, &path)
    } else {
        check_file_media_audio(Path::new(&path))
    }
}

/// Background sweep: read image/video headers to find the widest entry in
/// a directory or archive. Emits `manhwa-max-width` each time a wider
/// entry is found so the frontend can progressively update the strip.
#[tauri::command(async)]
pub fn scan_container_max_width(
    container: String,
    is_archive: bool,
    password: Option<String>,
    app: tauri::AppHandle,
) {
    let gen = SCAN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        let cache = app.try_state::<RwLock<ArchiveCache>>();
        scan_container_max_width_with(
            &container,
            is_archive,
            password.as_deref(),
            cache.as_deref(),
            TEMP_REG_WAIT_TIMEOUT,
            || SCAN_GENERATION.load(Ordering::Relaxed) != gen,
            |w| {
                let _ = app.emit(
                    "manhwa-max-width",
                    serde_json::json!({ "container": &container, "max_width": w }),
                );
            },
            |max_w| {
                let _ = app.emit(
                    "manhwa-max-width",
                    serde_json::json!({ "container": &container, "max_width": max_w, "done": true }),
                );
            },
        );
    });
}

#[tauri::command(async)]
pub fn scan_container_dimensions(
    container: String,
    is_archive: bool,
    password: Option<String>,
    app: tauri::AppHandle,
) {
    let gen = DIMS_SCAN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        let cache = app.try_state::<RwLock<ArchiveCache>>();
        scan_container_dimensions_with(
            &container,
            is_archive,
            password.as_deref(),
            cache.as_deref(),
            TEMP_REG_WAIT_TIMEOUT,
            || DIMS_SCAN_GENERATION.load(Ordering::Relaxed) != gen,
            |entries: Vec<DimensionEntry>, done: bool| {
                let _ = app.emit(
                    "container-dimensions",
                    serde_json::json!({
                        "container": &container,
                        "entries": entries,
                        "done": done,
                    }),
                );
            },
        );
    });
}

#[cfg(test)]
#[path = "../tests/animation_tests.rs"]
mod tests;
