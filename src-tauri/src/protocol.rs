use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use tauri::http::{Response, Uri};
use tauri::Manager;

use crate::archives::ArchiveCache;

const TIFF_PNG_CACHE_MAX_ENTRIES: usize = 16;
const TIFF_PNG_CACHE_MAX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
enum ProtocolRoute {
    Icon {
        path: String,
        ext_key: String,
        size: crate::platform::icons::IconSize,
    },
    Thumb {
        path: String,
    },
    Tiff {
        path: String,
    },
    Archive {
        archive_path: String,
        entry_name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum TiffCacheKey {
    Local {
        path: String,
        len: u64,
        mtime_nanos: u128,
    },
    Archive {
        archive_path: String,
        entry_name: String,
    },
}

struct TiffPngCache {
    entries: HashMap<TiffCacheKey, Arc<[u8]>>,
    order: VecDeque<TiffCacheKey>,
    total_bytes: usize,
    max_entries: usize,
    max_bytes: usize,
}

impl TiffPngCache {
    fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            total_bytes: 0,
            max_entries,
            max_bytes,
        }
    }

    fn get(&mut self, key: &TiffCacheKey) -> Option<Arc<[u8]>> {
        let value = self.entries.get(key).cloned()?;
        self.order.retain(|existing| existing != key);
        self.order.push_back(key.clone());
        Some(value)
    }

    fn insert(&mut self, key: TiffCacheKey, png: Arc<[u8]>) {
        if self.max_entries == 0 || png.len() > self.max_bytes {
            return;
        }
        if let Some(old) = self.entries.remove(&key) {
            self.total_bytes = self.total_bytes.saturating_sub(old.len());
            self.order.retain(|existing| existing != &key);
        }
        while !self.order.is_empty()
            && (self.entries.len() >= self.max_entries
                || self.total_bytes.saturating_add(png.len()) > self.max_bytes)
        {
            if let Some(evicted_key) = self.order.pop_front() {
                if let Some(evicted) = self.entries.remove(&evicted_key) {
                    self.total_bytes = self.total_bytes.saturating_sub(evicted.len());
                }
            }
        }
        if self.total_bytes.saturating_add(png.len()) > self.max_bytes {
            return;
        }
        self.total_bytes = self.total_bytes.saturating_add(png.len());
        self.entries.insert(key.clone(), png);
        self.order.push_back(key);
    }

    fn invalidate_archive(&mut self, archive_path: &str) {
        let mut removed_bytes = 0usize;
        self.entries.retain(|key, val| {
            let matches = matches!(
                key,
                TiffCacheKey::Archive {
                    archive_path: p,
                    ..
                } if p == archive_path
            );
            if matches {
                removed_bytes = removed_bytes.saturating_add(val.len());
            }
            !matches
        });
        self.total_bytes = self.total_bytes.saturating_sub(removed_bytes);
        self.order.retain(|key| {
            !matches!(
                key,
                TiffCacheKey::Archive {
                    archive_path: p,
                    ..
                } if p == archive_path
            )
        });
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.total_bytes = 0;
    }
}

static TIFF_PNG_CACHE: OnceLock<Mutex<TiffPngCache>> = OnceLock::new();

fn tiff_png_cache() -> &'static Mutex<TiffPngCache> {
    TIFF_PNG_CACHE
        .get_or_init(|| Mutex::new(TiffPngCache::new(TIFF_PNG_CACHE_MAX_ENTRIES, TIFF_PNG_CACHE_MAX_BYTES)))
}

fn try_get_cached_tiff_png(key: &TiffCacheKey) -> Option<Arc<[u8]>> {
    let cache = TIFF_PNG_CACHE.get()?;
    let mut guard = cache.try_lock().ok()?;
    guard.get(key)
}

fn get_cached_tiff_png(key: &TiffCacheKey) -> Option<Arc<[u8]>> {
    let mut guard = tiff_png_cache().lock().unwrap_or_else(|p| p.into_inner());
    guard.get(key)
}

fn insert_cached_tiff_png(key: TiffCacheKey, png: Arc<[u8]>) {
    let mut guard = tiff_png_cache().lock().unwrap_or_else(|p| p.into_inner());
    guard.insert(key, png);
}

pub(crate) fn invalidate_tiff_cache_for_archive(archive_path: &str) {
    if let Some(cache) = TIFF_PNG_CACHE.get() {
        let mut guard = cache.lock().unwrap_or_else(|p| p.into_inner());
        guard.invalidate_archive(archive_path);
    }
}

pub(crate) fn clear_tiff_cache() {
    if let Some(cache) = TIFF_PNG_CACHE.get() {
        let mut guard = cache.lock().unwrap_or_else(|p| p.into_inner());
        guard.clear();
    }
}

fn local_tiff_cache_key(path: &str) -> Result<TiffCacheKey, std::io::Error> {
    let meta = std::fs::metadata(path)?;
    let len = meta.len();
    let mtime_nanos = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(TiffCacheKey::Local {
        path: path.to_string(),
        len,
        mtime_nanos,
    })
}

fn serve_local_tiff(path: &str) -> Response<Vec<u8>> {
    let Ok(cache_key) = local_tiff_cache_key(path) else {
        return error_response(404, b"TIFF image not found or failed to decode");
    };
    if let Some(cached) = get_cached_tiff_png(&cache_key) {
        return no_store_png_response(cached.to_vec());
    }
    match crate::formats::decode_tiff_file_to_png(Path::new(path)) {
        Ok(bytes) => {
            insert_cached_tiff_png(cache_key, Arc::from(bytes.as_slice()));
            no_store_png_response(bytes)
        }
        Err(_) => error_response(404, b"TIFF image not found or failed to decode"),
    }
}

/// Registers the `quivit://` custom URI scheme protocol on the Tauri builder.
///
/// Live host+path formats:
/// - `http://quivit.localhost/archive/<archive_path_base64>/<entry_name>`
/// - `quivit://localhost/archive/<archive_path_base64>/<entry_name>`
/// plus `/icon/<path_b64>/<ext_b64>[?size=large|32]`, `/thumb/<path_b64>`,
/// and `/tiff/<path_b64>`.
pub fn register_quivit_protocol<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("quivit", |ctx, request, responder| {
        let range_header = request
            .headers()
            .get("range")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);

        let route = match parse_route(request.uri()) {
            Ok(route) => route,
            Err(message) => {
                responder.respond(error_response(400, message.into_bytes()));
                return;
            }
        };

        match route {
            ProtocolRoute::Icon {
                path,
                ext_key,
                size,
            } => {
                if let Some(bytes) =
                    crate::platform::icons::try_get_cached_native_icon_png_with_size(&ext_key, size)
                {
                    responder.respond(png_response(bytes.to_vec()));
                    return;
                }

                tauri::async_runtime::spawn_blocking(move || {
                    let response = match crate::platform::icons::get_cached_native_icon_png_with_size(
                        &path, &ext_key, size,
                    ) {
                        Ok(Some(bytes)) => png_response(bytes),
                        _ => error_response(404, b"Icon not found"),
                    };
                    responder.respond(response);
                });
            }
            ProtocolRoute::Thumb { path } => {
                tauri::async_runtime::spawn_blocking(move || {
                    let response =
                        match crate::platform::thumbnails::get_shell_thumbnail_png(&path, 96) {
                            Ok(Some(bytes)) => png_response(bytes),
                            _ => error_response(404, b"Thumbnail not found"),
                        };
                    responder.respond(response);
                });
            }
            ProtocolRoute::Tiff { path } => {
                if !crate::formats::is_tiff_name(&path) {
                    responder.respond(error_response(400, b"Not a TIFF file"));
                    return;
                }

                tauri::async_runtime::spawn_blocking(move || {
                    responder.respond(serve_local_tiff(&path));
                });
            }
            ProtocolRoute::Archive {
                archive_path,
                entry_name,
            } => {
                let app_handle = ctx.app_handle().clone();
                let is_tiff = crate::formats::is_tiff_name(&entry_name);

                if is_tiff {
                    let tiff_key = TiffCacheKey::Archive {
                        archive_path: archive_path.clone(),
                        entry_name: entry_name.clone(),
                    };
                    if let Some(cached_png) = try_get_cached_tiff_png(&tiff_key) {
                        responder.respond(no_store_png_response(cached_png.to_vec()));
                        return;
                    }
                } else if let Some(response) = try_cached_entry_response(
                    &app_handle,
                    &archive_path,
                    &entry_name,
                    range_header.as_deref(),
                ) {
                    responder.respond(response);
                    return;
                }

                tauri::async_runtime::spawn_blocking(move || {
                    if is_tiff {
                        let tiff_key = TiffCacheKey::Archive {
                            archive_path: archive_path.clone(),
                            entry_name: entry_name.clone(),
                        };
                        if let Some(cached_png) = get_cached_tiff_png(&tiff_key) {
                            responder.respond(no_store_png_response(cached_png.to_vec()));
                            return;
                        }
                        let state = app_handle.state::<std::sync::RwLock<ArchiveCache>>();
                        let response = match crate::archives::read_entry_bytes_shared(
                            &state,
                            &archive_path,
                            &entry_name,
                        ) {
                            Ok(bytes) => match crate::formats::decode_tiff_to_png(&bytes) {
                                Ok(png) => {
                                    insert_cached_tiff_png(tiff_key, Arc::from(png.as_slice()));
                                    no_store_png_response(png)
                                }
                                Err(_) => error_response(422, b"Failed to decode TIFF entry"),
                            },
                            Err(_) => error_response(404, b"Entry not found or failed to extract"),
                        };
                        responder.respond(response);
                        return;
                    }

                    let state = app_handle.state::<std::sync::RwLock<ArchiveCache>>();
                    let response = match crate::archives::read_entry_bytes_shared(
                        &state,
                        &archive_path,
                        &entry_name,
                    ) {
                        Ok(data) => entry_response(&entry_name, &data, range_header.as_deref()),
                        Err(_) => error_response(404, b"Entry not found or failed to extract"),
                    };
                    responder.respond(response);
                });
            }
        }
    })
}

fn parse_icon_parts(
    icon_path: &str,
    query: Option<&str>,
) -> Result<(String, String, crate::platform::icons::IconSize), String> {
    let Some((path_encoded, ext_encoded)) = icon_path.split_once('/') else {
        return Err("Missing icon path or extension key".to_string());
    };

    let size = match query {
        Some(q) if q.contains("size=large") || q.contains("size=32") => {
            crate::platform::icons::IconSize::Large
        }
        _ => crate::platform::icons::IconSize::Small,
    };

    let path = crate::utils::base64_decode(path_encoded)
        .ok_or_else(|| "Invalid base64 icon path".to_string())?;
    let ext_key = crate::utils::base64_decode(ext_encoded)
        .ok_or_else(|| "Invalid base64 icon extension key".to_string())?;
    Ok((path, ext_key, size))
}

fn parse_thumb_parts(path_encoded: &str) -> Result<String, String> {
    crate::utils::base64_decode(path_encoded)
        .ok_or_else(|| "Invalid base64 thumbnail path".to_string())
}

fn parse_tiff_parts(path_encoded: &str) -> Result<String, String> {
    crate::utils::base64_decode(path_encoded).ok_or_else(|| "Invalid base64 TIFF path".to_string())
}

fn parse_archive_parts(archive_entry_path: &str) -> Result<(String, String), String> {
    let Some((archive_path_encoded, entry_name_encoded)) = archive_entry_path.split_once('/')
    else {
        return Err("Missing archive path or entry name".to_string());
    };

    let archive_path = crate::utils::base64_decode(archive_path_encoded)
        .ok_or_else(|| "Invalid base64 archive path".to_string())?;
    let entry_name = crate::utils::url_decode(entry_name_encoded);
    Ok((archive_path, entry_name))
}

fn parse_route(uri: &Uri) -> Result<ProtocolRoute, String> {
    let path = uri.path();
    let query = uri.query();

    if let Some(rest) = path.strip_prefix("/icon/") {
        let (path, ext_key, size) = parse_icon_parts(rest, query)?;
        return Ok(ProtocolRoute::Icon {
            path,
            ext_key,
            size,
        });
    }
    if let Some(rest) = path.strip_prefix("/thumb/") {
        return Ok(ProtocolRoute::Thumb {
            path: parse_thumb_parts(rest)?,
        });
    }
    if let Some(rest) = path.strip_prefix("/tiff/") {
        return Ok(ProtocolRoute::Tiff {
            path: parse_tiff_parts(rest)?,
        });
    }
    if let Some(rest) = path.strip_prefix("/archive/") {
        let (archive_path, entry_name) = parse_archive_parts(rest)?;
        return Ok(ProtocolRoute::Archive {
            archive_path,
            entry_name,
        });
    }

    Err(format!("Invalid quivit URL: {uri}"))
}

#[cfg(test)]
fn parse_icon_url(url: &str) -> Result<(String, String, crate::platform::icons::IconSize), String> {
    let uri: Uri = url
        .parse()
        .map_err(|_| format!("Invalid quivit icon URL: {url}"))?;
    match parse_route(&uri)? {
        ProtocolRoute::Icon {
            path,
            ext_key,
            size,
        } => Ok((path, ext_key, size)),
        _ => Err(format!("Invalid quivit icon URL: {url}")),
    }
}

#[cfg(test)]
fn parse_thumb_url(url: &str) -> Result<String, String> {
    let uri: Uri = url
        .parse()
        .map_err(|_| format!("Invalid quivit thumbnail URL: {url}"))?;
    match parse_route(&uri)? {
        ProtocolRoute::Thumb { path } => Ok(path),
        _ => Err(format!("Invalid quivit thumbnail URL: {url}")),
    }
}

#[cfg(test)]
fn parse_tiff_url(url: &str) -> Result<String, String> {
    let uri: Uri = url
        .parse()
        .map_err(|_| format!("Invalid quivit TIFF URL: {url}"))?;
    match parse_route(&uri)? {
        ProtocolRoute::Tiff { path } => Ok(path),
        _ => Err(format!("Invalid quivit TIFF URL: {url}")),
    }
}

#[cfg(test)]
fn parse_archive_url(url: &str) -> Result<(String, String), String> {
    let uri: Uri = url.parse().map_err(|_| format!("Invalid quivit URL: {url}"))?;
    match parse_route(&uri)? {
        ProtocolRoute::Archive {
            archive_path,
            entry_name,
        } => Ok((archive_path, entry_name)),
        _ => Err(format!("Invalid quivit URL: {url}")),
    }
}

fn try_cached_entry_response<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    archive_path: &str,
    entry_name: &str,
    range_header: Option<&str>,
) -> Option<Response<Vec<u8>>> {
    let state = app_handle.state::<std::sync::RwLock<ArchiveCache>>();
    let cache = state.try_read().ok()?;
    let data = cache
        .cached_zip_entry_bytes(archive_path, entry_name)
        .ok()
        .flatten()?;
    Some(entry_response(entry_name, &data, range_header))
}

fn error_response(status: u16, msg: impl Into<Vec<u8>>) -> Response<Vec<u8>> {
    Response::builder().status(status).body(msg.into()).unwrap()
}

fn png_response(data: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(200)
        .header("Content-Type", "image/png")
        .header("Content-Length", data.len().to_string())
        .header("Cache-Control", "public, max-age=86400")
        .header("Access-Control-Allow-Origin", "*")
        .body(data)
        .unwrap()
}

fn no_store_png_response(data: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(200)
        .header("Content-Type", "image/png")
        .header("Content-Length", data.len().to_string())
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .body(data)
        .unwrap()
}

#[cfg(test)]
fn archive_entry_response(
    entry_name: &str,
    data: &[u8],
    range_header: Option<&str>,
) -> Response<Vec<u8>> {
    if crate::formats::is_tiff_name(entry_name) {
        return match crate::formats::decode_tiff_to_png(data) {
            Ok(png) => no_store_png_response(png),
            Err(_) => error_response(422, b"Failed to decode TIFF entry"),
        };
    }
    entry_response(entry_name, data, range_header)
}

fn entry_response(entry_name: &str, data: &[u8], range_header: Option<&str>) -> Response<Vec<u8>> {
    let mime = crate::formats::guess_mime(entry_name);
    if let Some(range) = range_header.and_then(|range| parse_byte_range(range, data.len())) {
        let body = data[range.start..=range.end].to_vec();
        return Response::builder()
            .status(206)
            .header("Content-Type", mime)
            .header("Accept-Ranges", "bytes")
            .header("Content-Range", range.content_range(data.len()))
            .header("Content-Length", body.len().to_string())
            .header("Cache-Control", "no-store")
            .header("Access-Control-Allow-Origin", "*")
            .body(body)
            .unwrap();
    }

    Response::builder()
        .status(200)
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", data.len().to_string())
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .body(data.to_vec())
        .unwrap()
}

#[derive(Debug, PartialEq, Eq)]
struct ByteRange {
    start: usize,
    end: usize,
}

impl ByteRange {
    fn content_range(&self, total_len: usize) -> String {
        format!("bytes {}-{}/{}", self.start, self.end, total_len)
    }
}

fn parse_byte_range(header: &str, total_len: usize) -> Option<ByteRange> {
    if total_len == 0 {
        return None;
    }

    let range = header.trim().strip_prefix("bytes=")?;
    let (start, end) = range.split_once('-')?;
    if start.is_empty() {
        let suffix_len = end.parse::<usize>().ok()?.min(total_len);
        if suffix_len == 0 {
            return None;
        }
        return Some(ByteRange {
            start: total_len - suffix_len,
            end: total_len - 1,
        });
    }

    let start = start.parse::<usize>().ok()?;
    if start >= total_len {
        return None;
    }

    let end = if end.is_empty() {
        total_len - 1
    } else {
        end.parse::<usize>().ok()?.min(total_len - 1)
    };

    if start > end {
        return None;
    }

    Some(ByteRange { start, end })
}

#[cfg(test)]
#[path = "tests/protocol_tests.rs"]
mod tests;
