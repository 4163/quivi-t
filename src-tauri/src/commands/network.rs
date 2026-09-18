use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 QuiviT/1.0";
const MANIFEST_BASE_URL: &str =
    "https://raw.githubusercontent.com/4163/quivi-t/main/extractors/";
const DOWNLOAD_CHUNK_SIZE: usize = 32 * 1024;

pub struct DownloadCancelFlag(pub Arc<AtomicU64>);

static DL_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn get_agent() -> &'static ureq::Agent {
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout(NETWORK_TIMEOUT)
            .user_agent(USER_AGENT)
            .build()
    })
}

#[tauri::command(async)]
pub fn fetch_text(url: String) -> Result<String, String> {
    let agent = get_agent();
    let response = agent.get(&url)
        .call()
        .map_err(|e| format!("Network request failed: {e}"))?;

    response
        .into_string()
        .map_err(|e| format!("Failed to read response body: {e}"))
}

#[tauri::command(async)]
pub fn fetch_extractor_text(relative_path: String) -> Result<String, String> {
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
    // Remote fallback: production or file not found locally.
    let url = format!("{MANIFEST_BASE_URL}{relative_path}");
    let agent = get_agent();
    let response = agent.get(&url)
        .call()
        .map_err(|e| format!("Network request failed: {e}"))?;
    response
        .into_string()
        .map_err(|e| format!("Failed to read response body: {e}"))
}

#[tauri::command(async)]
pub fn download_to_file(
    app: tauri::AppHandle,
    url: String,
    dest_path: String,
) -> Result<(), String> {
    use tauri::Manager;

    let dest = Path::new(&dest_path);
    if dest.is_file() && dest.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination directory: {e}"))?;
    }

    let cancel = app
        .state::<DownloadCancelFlag>()
        .0
        .clone();

    let my_gen = cancel.load(Ordering::SeqCst);

    let agent = get_agent();
    let response = agent.get(&url)
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

    let mut reader = response.into_reader();
    let mut file = File::create(&temp_dest)
        .map_err(|e| format!("Failed to create temp file: {e}"))?;

    let mut buf = vec![0u8; DOWNLOAD_CHUNK_SIZE];
    loop {
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

        file.write_all(&buf[..n]).map_err(|e| {
            let _ = fs::remove_file(&temp_dest);
            format!("Failed to write download content: {e}")
        })?;
    }

    drop(file);

    // Atomically move or copy finished file into final destination.
    if fs::rename(&temp_dest, dest).is_err() {
        fs::copy(&temp_dest, dest)
            .map_err(|e| {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fetch_extractor_text_finds_local_manifest() {
        let res = fetch_extractor_text("manifest.json".to_string());
        assert!(res.is_ok(), "Failed to fetch manifest: {:?}", res.err());
        let content = res.unwrap();
        assert!(content.contains("\"extractors\""));
    }
}
