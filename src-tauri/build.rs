#[allow(dead_code)]
#[path = "src/platform/previews/contract.rs"]
mod preview_contract;

fn main() {
    println!("cargo:rerun-if-changed=src/platform/previews/contract.rs");
    println!("cargo:rerun-if-changed=src/platform/previews/windows/thumb_proxy.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap())
            .join(preview_contract::THUMBNAIL_PROXY_NAME);
        let mut command = std::process::Command::new(std::env::var_os("RUSTC").unwrap());
        command
            .args([
                "--crate-name",
                "quivit_thumbnail_proxy",
                "--crate-type",
                "cdylib",
                "--edition",
                "2021",
            ])
            .arg("src/platform/previews/windows/thumb_proxy.rs")
            .arg("--target")
            .arg(std::env::var_os("TARGET").unwrap())
            .args([
                "-C",
                "opt-level=z",
                "-C",
                "panic=abort",
                "-C",
                "target-feature=+crt-static",
            ])
            .arg("-o")
            .arg(output);
        if let Some(linker) = std::env::var_os("RUSTC_LINKER") {
            command
                .arg("-C")
                .arg(format!("linker={}", linker.to_string_lossy()));
        }
        let result = command
            .output()
            .expect("Cannot compile the thumbnail proxy DLL");
        if !result.status.success() {
            panic!(
                "Thumbnail proxy build failed:\n{}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }
    tauri_build::build()
}
