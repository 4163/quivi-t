use std::fs::{self, File};
use std::io;
use std::path::Path;
use std::time::Duration;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 QuiviT/1.0";

fn create_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(NETWORK_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
}

#[tauri::command]
pub fn fetch_text(url: String) -> Result<String, String> {
    let agent = create_agent();
    let response = agent.get(&url)
        .call()
        .map_err(|e| format!("Network request failed: {e}"))?;

    response
        .into_string()
        .map_err(|e| format!("Failed to read response body: {e}"))
}

#[tauri::command]
pub fn download_to_file(url: String, dest_path: String) -> Result<(), String> {
    let dest = Path::new(&dest_path);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination directory: {e}"))?;
    }

    let temp_dest = format!("{dest_path}.tmp");
    let agent = create_agent();
    let response = agent.get(&url)
        .call()
        .map_err(|e| format!("Download request failed: {e}"))?;

    let mut reader = response.into_reader();
    let mut file = File::create(&temp_dest)
        .map_err(|e| format!("Failed to create temp file: {e}"))?;

    io::copy(&mut reader, &mut file)
        .map_err(|e| {
            let _ = fs::remove_file(&temp_dest);
            format!("Failed to stream download content: {e}")
        })?;

    drop(file);

    if dest.exists() {
        let _ = fs::remove_file(dest);
    }

    fs::rename(&temp_dest, dest)
        .map_err(|e| {
            let _ = fs::remove_file(&temp_dest);
            format!("Failed to finalize downloaded file: {e}")
        })?;

    Ok(())
}
