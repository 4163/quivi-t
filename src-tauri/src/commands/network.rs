use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;

pub(crate) use crate::formats::check_image_magic_head;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 QuiviT/1.0";
const MANIFEST_BASE_URL: &str = "https://raw.githubusercontent.com/4163/quivi-t/extractors/";
const DOWNLOAD_CHUNK_SIZE: usize = 32 * 1024;
const HEADER_VALUE_MAX_LEN: usize = 2048;
const HEADER_MAP_MAX_ENTRIES: usize = 20;
const DENIED_HEADERS: &[&str] = &["host", "content-length", "cookie", "authorization"];
const DESCRAMBLE_JPEG_QUALITY: u8 = 95;

/// Tile-grid descramble descriptor. The extractor computes the site-specific
/// permutation; the backend only rearranges tiles.
/// `order` uses pull semantics: `dest[i] = src[order[i]]`.
#[derive(Deserialize)]
pub struct TileDescramble {
    cols: u32,
    rows: u32,
    order: Vec<u32>,
    align: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadThresholdEvent<'a> {
    request_id: &'a str,
    queue_generation: u64,
}

pub struct DownloadCancelFlag(pub Arc<AtomicU64>);

static DL_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static EXTRACTOR_CACHE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn get_agent() -> &'static ureq::Agent {
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout(NETWORK_TIMEOUT)
            .user_agent(USER_AGENT)
            .build()
    })
}

fn sanitize_headers(headers: &HashMap<String, String>) -> Result<Vec<(&str, &str)>, String> {
    if headers.len() > HEADER_MAP_MAX_ENTRIES {
        return Err(format!("Too many request headers (max {HEADER_MAP_MAX_ENTRIES})"));
    }
    let mut sanitized = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        if DENIED_HEADERS.iter().any(|d| name.eq_ignore_ascii_case(d)) {
            return Err(format!("Request header '{name}' is not allowed"));
        }
        if value.len() > HEADER_VALUE_MAX_LEN {
            return Err(format!("Request header '{name}' value exceeds {HEADER_VALUE_MAX_LEN} bytes"));
        }
        sanitized.push((name.as_str(), value.as_str()));
    }
    Ok(sanitized)
}

#[tauri::command(async)]
pub fn fetch_text(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let agent = get_agent();
    let mut request = agent.get(&url);

    if let Some(ref h) = headers {
        for (name, value) in sanitize_headers(h)? {
            request = request.set(name, value);
        }
    }

    let response = request
        .call()
        .map_err(|e| format!("Network request failed: {e}"))?;

    response
        .into_string()
        .map_err(|e| format!("Failed to read response body: {e}"))
}

#[tauri::command(async)]
pub fn fetch_bytes(
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let agent = get_agent();
    let mut request = agent.get(&url);

    if let Some(ref h) = headers {
        for (name, value) in sanitize_headers(h)? {
            request = request.set(name, value);
        }
    }

    let response = request
        .call()
        .map_err(|e| format!("Network request failed: {e}"))?;

    let mut bytes = Vec::new();
    response
        .into_reader()
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read response body: {e}"))?;

    Ok(crate::utils::base64_encode(&bytes))
}

#[tauri::command(async)]
pub fn fetch_extractor_text(relative_path: String) -> Result<String, String> {
    if !is_safe_extractor_path(&relative_path) {
        return Err("Invalid extractor path".to_string());
    }
    // Local-first: check working directory and ancestor directories for extractors/ (dev mode).
    if let Ok(cwd) = std::env::current_dir() {
        let mut cur = Some(cwd.as_path());
        while let Some(dir) = cur {
            let local = dir.join("extractors").join(&relative_path);
            if local.is_file() {
                return fs::read_to_string(&local)
                    .map_err(|e| format!("Failed to read local extractor: {e}"));
            }
            cur = dir.parent();
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent();
        while let Some(dir) = cur {
            let local = dir.join("extractors").join(&relative_path);
            if local.is_file() {
                return fs::read_to_string(&local)
                    .map_err(|e| format!("Failed to read local extractor: {e}"));
            }
            cur = dir.parent();
        }
    }
    // Production checks the trusted registry source on every request. A
    // successful response replaces the disk cache; an outage falls back to
    // the last complete manifest or extractor source.
    let url = format!("{MANIFEST_BASE_URL}{relative_path}");
    let agent = get_agent();
    let remote = agent
        .get(&url)
        .call()
        .map_err(|e| format!("Network request failed: {e}"))
        .and_then(|response| {
            response
                .into_string()
                .map_err(|e| format!("Failed to read response body: {e}"))
        });

    if let Ok(cache_path) = cached_extractor_path(&relative_path) {
        return resolve_remote_extractor_text(&cache_path, remote);
    }

    remote
}

fn extractor_cache_dir() -> Result<std::path::PathBuf, String> {
    let local = std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA not set".to_string())?;
    Ok(Path::new(&local).join("QuiviT").join("extractor-cache"))
}

fn cached_extractor_path(relative_path: &str) -> Result<std::path::PathBuf, String> {
    if !is_safe_extractor_path(relative_path) {
        return Err("Invalid extractor path".to_string());
    }
    Ok(extractor_cache_dir()?.join(relative_path))
}

fn read_cached_extractor_text(cache_path: &Path) -> Result<String, String> {
    fs::read_to_string(cache_path).map_err(|e| format!("Failed to read cached extractor: {e}"))
}

fn resolve_remote_extractor_text(
    cache_path: &Path,
    remote: Result<String, String>,
) -> Result<String, String> {
    match remote {
        Ok(source) => {
            let _ = cache_extractor_text_at(cache_path, &source);
            Ok(source)
        }
        Err(remote_error) => read_cached_extractor_text(cache_path)
            .map_err(|_| format!("{remote_error}. No cached extractor source is available")),
    }
}

fn cache_extractor_text_at(cache_path: &Path, source: &str) -> Result<(), String> {
    let parent = cache_path
        .parent()
        .ok_or_else(|| "Invalid extractor cache path".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create extractor cache directory: {e}"))?;

    let name = cache_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid extractor cache filename".to_string())?;
    let temp_path = parent.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        EXTRACTOR_CACHE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));

    fs::write(&temp_path, source).map_err(|e| format!("Failed to write extractor cache: {e}"))?;

    if fs::rename(&temp_path, cache_path).is_err() {
        fs::copy(&temp_path, cache_path)
            .map_err(|e| format!("Failed to finalize extractor cache: {e}"))?;
        let _ = fs::remove_file(&temp_path);
    }

    Ok(())
}

fn is_safe_extractor_path(relative_path: &str) -> bool {
    let path = Path::new(relative_path);
    if relative_path.is_empty() || path.is_absolute() {
        return false;
    }
    if !path
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        return false;
    }
    relative_path == "manifest.json"
        || path.extension().and_then(|extension| extension.to_str()) == Some("js")
}

#[tauri::command(async)]
pub fn download_to_file(
    app: tauri::AppHandle,
    url: String,
    dest_path: String,
    request_id: Option<String>,
    queue_generation: Option<u64>,
    threshold_percent: Option<u8>,
    headers: Option<HashMap<String, String>>,
    xor_key: Option<String>,
    descramble: Option<TileDescramble>,
) -> Result<(), String> {
    use tauri::Manager;

    let dest = Path::new(&dest_path);
    crate::commands::library::ensure_library_write_allowed(dest)?;
    let library_write_root = crate::commands::library::library_write_scope(dest)?;
    if let Some(library_root) = &library_write_root {
        crate::commands::library::ensure_library_root_writable(library_root)?;
    }
    if dest.is_file() && dest.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination directory: {e}"))?;
    }

    let xor_bytes = match &xor_key {
        Some(key) => Some(
            crate::utils::base64_decode_bytes(key)
                .ok_or_else(|| "Invalid base64 XOR key".to_string())?,
        ),
        None => None,
    };

    let cancel = app.state::<DownloadCancelFlag>().0.clone();

    let my_gen = cancel.load(Ordering::SeqCst);

    let agent = get_agent();
    let mut request = agent.get(&url);

    if let Some(ref h) = headers {
        for (name, value) in sanitize_headers(h)? {
            request = request.set(name, value);
        }
    }

    let response = request
        .call()
        .map_err(|e| format!("Download request failed: {e}"))?;

    // Fast-fail: abort before creating temp file if cancelled while waiting for response headers
    if cancel.load(Ordering::SeqCst) != my_gen {
        return Err("Download cancelled".to_string());
    }

    // Stream download into a temporary file in OS temp directory so that
    // chunk writes do not trigger filesystem watcher events in the gallery folder.
    let temp_name = format!(
        "quivit_dl_{}_{}_{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        DL_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let temp_dest = std::env::temp_dir().join(temp_name);

    let content_length = response
        .header("content-length")
        .and_then(|value| value.parse::<u64>().ok());
    let threshold_bytes = match (content_length, threshold_percent) {
        (Some(length), Some(percent)) if (1..100).contains(&percent) => {
            Some(length.saturating_mul(u64::from(percent)).saturating_add(99) / 100)
        }
        _ => None,
    };
    let mut threshold_emitted = threshold_bytes.is_none();
    let mut bytes_written = 0_u64;
    let mut reader = response.into_reader();
    let mut file =
        File::create(&temp_dest).map_err(|e| format!("Failed to create temp file: {e}"))?;

    let mut buf = vec![0u8; DOWNLOAD_CHUNK_SIZE];
    let mut xor_key_offset = 0usize;
    loop {
        if let Some(library_root) = &library_write_root {
            if let Err(err) = crate::commands::library::ensure_library_root_writable(library_root) {
                drop(file);
                let _ = fs::remove_file(&temp_dest);
                return Err(err);
            }
        }
        if cancel.load(Ordering::SeqCst) != my_gen {
            drop(file);
            let _ = fs::remove_file(&temp_dest);
            return Err("Download cancelled".to_string());
        }

        let n = reader.read(&mut buf).map_err(|e| {
            let _ = fs::remove_file(&temp_dest);
            format!("Failed to read download content: {e}")
        })?;

        if n == 0 {
            break;
        }

        // Fast-fail: abort immediately if cancel arrived while blocked in socket read
        if cancel.load(Ordering::SeqCst) != my_gen {
            drop(file);
            let _ = fs::remove_file(&temp_dest);
            return Err("Download cancelled".to_string());
        }

        if let Some(ref key) = xor_bytes {
            for byte in buf[..n].iter_mut() {
                *byte ^= key[xor_key_offset % key.len()];
                xor_key_offset += 1;
            }
        }

        file.write_all(&buf[..n]).map_err(|e| {
            let _ = fs::remove_file(&temp_dest);
            format!("Failed to write download content: {e}")
        })?;
        bytes_written = bytes_written.saturating_add(n as u64);

        if !threshold_emitted && threshold_bytes.is_some_and(|threshold| bytes_written >= threshold)
        {
            threshold_emitted = true;
            if let (Some(request_id), Some(queue_generation)) = (&request_id, queue_generation) {
                let _ = app.emit(
                    "quivit-download-threshold",
                    DownloadThresholdEvent {
                        request_id,
                        queue_generation,
                    },
                );
            }
        }
    }

    drop(file);

    if cancel.load(Ordering::SeqCst) != my_gen {
        let _ = fs::remove_file(&temp_dest);
        return Err("Download cancelled".to_string());
    }

    // Tile-grid descramble: decode, rearrange tiles, re-encode in the source format.
    if let Some(ref desc) = descramble {
        if let Err(e) = apply_tile_descramble(&temp_dest, desc) {
            let _ = fs::remove_file(&temp_dest);
            return Err(e);
        }
    }

    if let Some(library_root) = &library_write_root {
        if let Err(err) = crate::commands::library::ensure_library_root_writable(library_root) {
            let _ = fs::remove_file(&temp_dest);
            return Err(err);
        }
    }

    // Atomically move or copy finished file into final destination.
    if fs::rename(&temp_dest, dest).is_err() {
        fs::copy(&temp_dest, dest).map_err(|e| {
            let _ = fs::remove_file(&temp_dest);
            format!("Failed to finalize downloaded file: {e}")
        })?;
        let _ = fs::remove_file(&temp_dest);
    }

    Ok(())
}

#[tauri::command]
pub fn cancel_download(app: tauri::AppHandle) {
    use tauri::Manager;
    app.state::<DownloadCancelFlag>()
        .0
        .fetch_add(1, Ordering::SeqCst);
}

/// First-byte check that a downloaded file matches its extension, so document
/// pages saved under image names never reach the Library. Unknown extensions
/// pass through; short or mismatched files fail so the caller retries or
/// reports instead of keeping corrupt bytes.
#[tauri::command(async)]
pub fn verify_image_magic(path: String, expected_ext: String) -> Result<(), String> {
    if !check_image_magic_head(&read_head(&path)?, &expected_ext) {
        return Err(format!(
            "Downloaded file is not a valid {expected_ext} image: {path}"
        ));
    }
    Ok(())
}

fn read_head(path: &str) -> Result<Vec<u8>, String> {
    let mut f = File::open(path).map_err(|e| format!("Failed to open downloaded file: {e}"))?;
    let mut head = vec![0u8; 16];
    let mut n = 0;
    while n < head.len() {
        match f.read(&mut head[n..]) {
            Ok(0) => break,
            Ok(read) => n += read,
            Err(e) => return Err(format!("Failed to read downloaded file: {e}")),
        }
    }
    head.truncate(n);
    Ok(head)
}


fn apply_tile_descramble(path: &std::path::Path, desc: &TileDescramble) -> Result<(), String> {
    let total = (desc.cols as usize) * (desc.rows as usize);
    if desc.cols == 0 || desc.rows == 0 {
        return Err("Descramble grid must have at least 1 column and 1 row".to_string());
    }
    if desc.order.len() != total {
        return Err(format!(
            "Descramble order length {} does not match grid {}x{}",
            desc.order.len(),
            desc.cols,
            desc.rows
        ));
    }
    let mut seen = HashSet::with_capacity(total);
    for &idx in &desc.order {
        if idx as usize >= total {
            return Err(format!(
                "Descramble order index {idx} out of range for grid of {total} tiles"
            ));
        }
        if !seen.insert(idx) {
            return Err(format!("Descramble order contains duplicate index {idx}"));
        }
    }

    let raw = fs::read(path).map_err(|e| format!("Failed to read temp file for descramble: {e}"))?;
    let format = image::guess_format(&raw)
        .map_err(|e| format!("Failed to detect image format for descramble: {e}"))?;
    let src = image::load_from_memory_with_format(&raw, format)
        .map_err(|e| format!("Failed to decode image for descramble: {e}"))?;
    let (img_w, img_h) = (src.width(), src.height());

    let align = desc.align.unwrap_or(1);
    let tile_w = if align > 1 {
        (img_w / align * align) / desc.cols
    } else {
        img_w / desc.cols
    };
    let tile_h = if align > 1 {
        (img_h / align * align) / desc.rows
    } else {
        img_h / desc.rows
    };
    if tile_w == 0 || tile_h == 0 {
        return Err(format!(
            "Image {img_w}x{img_h} too small for {}x{} tile grid",
            desc.cols, desc.rows
        ));
    }

    let mut out = src.clone();

    for (dest_idx, &src_idx) in desc.order.iter().enumerate() {
        let dest_col = (dest_idx % desc.cols as usize) as u32;
        let dest_row = (dest_idx / desc.cols as usize) as u32;
        let src_col = (src_idx % desc.cols) as u32;
        let src_row = (src_idx / desc.cols) as u32;

        let src_tile = src.crop_imm(src_col * tile_w, src_row * tile_h, tile_w, tile_h);
        image::imageops::replace(&mut out, &src_tile, (dest_col * tile_w).into(), (dest_row * tile_h).into());
    }

    // Remainder strips (bottom and right edges) stay in place from the clone.

    let mut output_bytes: Vec<u8> = Vec::new();
    match format {
        image::ImageFormat::Jpeg => {
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
                &mut output_bytes,
                DESCRAMBLE_JPEG_QUALITY,
            );
            out.write_with_encoder(encoder)
                .map_err(|e| format!("Failed to encode descrambled JPEG: {e}"))?;
        }
        other => {
            let cursor = std::io::Cursor::new(&mut output_bytes);
            out.write_to(&mut std::io::BufWriter::new(cursor), other)
                .map_err(|e| format!("Failed to encode descrambled image: {e}"))?;
        }
    }

    fs::write(path, &output_bytes)
        .map_err(|e| format!("Failed to write descrambled image: {e}"))?;
    Ok(())
}

#[cfg(test)]
#[path = "../tests/network_tests.rs"]
mod tests;
