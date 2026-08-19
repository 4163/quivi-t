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

        let archive_path = match crate::utils::base64_decode(path_parts[0]) {
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

        // Decode the entry name, including %20 spaces.
        let entry_name = crate::utils::url_decode(path_parts[1]);

        let app_handle = ctx.app_handle().clone();
        if let Ok(mut cache) = app_handle.state::<Mutex<ArchiveCache>>().try_lock() {
            if let Ok(Some(data)) = cache.cached_zip_entry_bytes(&archive_path, &entry_name) {
                responder.respond(entry_response(&entry_name, data.to_vec()));
                return;
            }
        }

        std::thread::spawn(move || {
            let entry_data = app_handle
                .state::<Mutex<ArchiveCache>>()
                .lock()
                .map_err(|e| e.to_string())
                .and_then(|mut cache| cache.read_entry_bytes(&archive_path, &entry_name));

            let data = entry_data.and_then(|d| d.wait_for_data(&entry_name));

            if let Ok(d) = data {
                responder.respond(entry_response(&entry_name, d));
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

fn entry_response(entry_name: &str, data: Vec<u8>) -> Response<Vec<u8>> {
    let mime = guess_mime(entry_name);
    Response::builder()
        .status(200)
        .header("Content-Type", mime)
        .header("Content-Length", data.len().to_string())
        .header("Access-Control-Allow-Origin", "*")
        .body(data)
        .unwrap()
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
