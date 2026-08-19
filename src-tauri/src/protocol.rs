use std::sync::Mutex;

use tauri::http::Response;
use tauri::Manager;

use crate::archives::ArchiveCache;

/// Registers the `quivit://` custom URI scheme protocol on the Tauri builder.
///
/// Protocol format: `quivit://archive/<archive_path_base64>/<entry_name>`
pub fn register_quivit_protocol<R: tauri::Runtime>(
    builder: tauri::Builder<R>,
) -> tauri::Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol("quivit", |ctx, request, responder| {
        let url = request.uri().to_string();
        let range_header = request
            .headers()
            .get("range")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);

        if url.contains("/icon/") {
            let (path, ext_key) = match parse_icon_url(&url) {
                Ok(parts) => parts,
                Err(message) => {
                    let response = Response::builder()
                        .status(400)
                        .body(message.into_bytes())
                        .unwrap();
                    responder.respond(response);
                    return;
                }
            };

            tauri::async_runtime::spawn_blocking(move || {
                let response = match crate::platform::icons::get_cached_native_icon_png(
                    &path, &ext_key,
                ) {
                    Ok(Some(bytes)) => png_response(bytes),
                    _ => Response::builder()
                        .status(404)
                        .body(b"Icon not found".to_vec())
                        .unwrap(),
                };
                responder.respond(response);
            });
            return;
        }

        let (archive_path, entry_name) = match parse_archive_url(&url) {
            Ok(parts) => parts,
            Err(message) => {
                let response = Response::builder()
                    .status(400)
                    .body(message.into_bytes())
                    .unwrap();
                responder.respond(response);
                return;
            }
        };

        let app_handle = ctx.app_handle().clone();
        if let Some(response) = try_cached_entry_response(
            &app_handle,
            &archive_path,
            &entry_name,
            range_header.as_deref(),
        )
        {
            responder.respond(response);
            return;
        }

        tauri::async_runtime::spawn_blocking(move || {
            let entry_data = app_handle
                .state::<Mutex<ArchiveCache>>()
                .lock()
                .map_err(|e| e.to_string())
                .and_then(|mut cache| cache.read_entry_bytes(&archive_path, &entry_name));

            let data = entry_data.and_then(|d| d.wait_for_data(&entry_name));

            if let Ok(d) = data {
                responder.respond(entry_response(&entry_name, d, range_header.as_deref()));
            } else {
                let response = Response::builder()
                    .status(404)
                    .body(b"Entry not found or failed to extract".to_vec())
                    .unwrap();
                responder.respond(response);
            }
        });
    })
}

fn parse_icon_url(url: &str) -> Result<(String, String), String> {
    let Some((_, icon_path)) = url.split_once("/icon/") else {
        return Err(format!("Invalid quivit icon URL: {url}"));
    };

    let Some((path_encoded, ext_encoded)) = icon_path.split_once('/') else {
        return Err("Missing icon path or extension key".to_string());
    };

    let path = crate::utils::base64_decode(path_encoded)
        .ok_or_else(|| "Invalid base64 icon path".to_string())?;
    let ext_key = crate::utils::base64_decode(ext_encoded)
        .ok_or_else(|| "Invalid base64 icon extension key".to_string())?;
    Ok((path, ext_key))
}

fn parse_archive_url(url: &str) -> Result<(String, String), String> {
    let Some((_, archive_entry_path)) = url.split_once("/archive/") else {
        return Err(format!("Invalid quivit URL: {url}"));
    };

    let Some((archive_path_encoded, entry_name_encoded)) = archive_entry_path.split_once('/') else {
        return Err("Missing archive path or entry name".to_string());
    };

    let archive_path = crate::utils::base64_decode(archive_path_encoded)
        .ok_or_else(|| "Invalid base64 archive path".to_string())?;
    let entry_name = crate::utils::url_decode(entry_name_encoded);
    Ok((archive_path, entry_name))
}

fn try_cached_entry_response<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    archive_path: &str,
    entry_name: &str,
    range_header: Option<&str>,
) -> Option<Response<Vec<u8>>> {
    let state = app_handle.state::<Mutex<ArchiveCache>>();
    let mut cache = state.try_lock().ok()?;
    let data = cache
        .cached_zip_entry_bytes(archive_path, entry_name)
        .ok()
        .flatten()?;
    Some(entry_response(entry_name, data.to_vec(), range_header))
}

fn png_response(data: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(200)
        .header("Content-Type", "image/png")
        .header("Content-Length", data.len().to_string())
        .header("Access-Control-Allow-Origin", "*")
        .body(data)
        .unwrap()
}

fn entry_response(
    entry_name: &str,
    data: Vec<u8>,
    range_header: Option<&str>,
) -> Response<Vec<u8>> {
    let mime = guess_mime(entry_name);
    if let Some(range) = range_header.and_then(|range| parse_byte_range(range, data.len())) {
        let body = data[range.start..=range.end].to_vec();
        return Response::builder()
            .status(206)
            .header("Content-Type", mime)
            .header("Accept-Ranges", "bytes")
            .header("Content-Range", range.content_range(data.len()))
            .header("Content-Length", body.len().to_string())
            .header("Access-Control-Allow-Origin", "*")
            .body(body)
            .unwrap();
    }

    Response::builder()
        .status(200)
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", data.len().to_string())
        .header("Access-Control-Allow-Origin", "*")
        .body(data)
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

fn guess_mime(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("");
    if ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg") {
        "image/jpeg"
    } else if ext.eq_ignore_ascii_case("png") {
        "image/png"
    } else if ext.eq_ignore_ascii_case("gif") {
        "image/gif"
    } else if ext.eq_ignore_ascii_case("webp") {
        "image/webp"
    } else if ext.eq_ignore_ascii_case("svg") {
        "image/svg+xml"
    } else if ext.eq_ignore_ascii_case("bmp") {
        "image/bmp"
    } else if ext.eq_ignore_ascii_case("ico") {
        "image/x-icon"
    } else if ext.eq_ignore_ascii_case("avif") {
        "image/avif"
    } else if ext.eq_ignore_ascii_case("apng") {
        "image/apng"
    } else {
        "application/octet-stream"
    }
}

#[cfg(test)]
#[path = "tests/protocol_tests.rs"]
mod tests;
