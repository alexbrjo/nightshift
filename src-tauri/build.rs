use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

const SIDECAR_BASE_NAME: &str = "codex-app-server";

fn main() {
    let target = env::var("TARGET").expect("TARGET is set by Cargo");
    let host = env::var("HOST").expect("HOST is set by Cargo");
    println!("cargo:rustc-env=NIGHTSHIFT_TARGET_TRIPLE={}", target);
    stage_codex_sidecar(&target, &host);
    tauri_build::build();
}

fn stage_codex_sidecar(target: &str, host: &str) {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=NIGHTSHIFT_CODEX_SOURCE_BINARY");
    println!("cargo:rerun-if-env-changed=NIGHTSHIFT_SKIP_CODEX_SIDECAR_STAGE");

    if env::var_os("NIGHTSHIFT_SKIP_CODEX_SIDECAR_STAGE").is_some() {
        return;
    }

    let explicit_source = env::var_os("NIGHTSHIFT_CODEX_SOURCE_BINARY").map(PathBuf::from);
    let Some(source) = explicit_source
        .clone()
        .filter(|path| path.is_file())
        .or_else(|| find_host_codex_source_binary(target, host))
    else {
        println!(
            "cargo:warning=Codex sidecar was not staged. Set NIGHTSHIFT_CODEX_SOURCE_BINARY to the target platform's Codex executable before building a runnable Agent workspace."
        );
        return;
    };

    if explicit_source.is_none() && target != host {
        println!(
            "cargo:warning=Codex sidecar was not staged for cross-target build {} from host {}. Set NIGHTSHIFT_CODEX_SOURCE_BINARY to the target platform's Codex executable.",
            target, host
        );
        return;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let target_dir = manifest_dir.join("binaries");
    let extension = if target.contains("windows") { ".exe" } else { "" };
    let staged = target_dir.join(format!("{}-{}{}", SIDECAR_BASE_NAME, target, extension));

    if let Err(error) = fs::create_dir_all(&target_dir) {
        println!("cargo:warning=Failed to create Codex sidecar directory: {}", error);
        return;
    }

    match should_copy_by_hash(&source, &staged) {
        Ok(false) => return,
        Ok(true) => {}
        Err(error) => {
            println!(
                "cargo:warning=Failed to compare Codex sidecar hashes for {} and {}: {}",
                source.display(),
                staged.display(),
                error
            );
        }
    }

    match fs::copy(&source, &staged) {
        Ok(_) => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(mut permissions) =
                    fs::metadata(&staged).map(|metadata| metadata.permissions())
                {
                    permissions.set_mode(0o755);
                    let _ = fs::set_permissions(&staged, permissions);
                }
            }
            println!("cargo:warning=Staged Codex sidecar from {}", source.display());
        }
        Err(error) => {
            println!(
                "cargo:warning=Failed to stage Codex sidecar from {}: {}",
                source.display(),
                error
            );
        }
    }
}

fn find_host_codex_source_binary(target: &str, host: &str) -> Option<PathBuf> {
    if target != host {
        return None;
    }
    find_installed_codex_binary().or_else(find_path_codex_binary)
}

fn find_installed_codex_binary() -> Option<PathBuf> {
    let candidates = [
        "/Applications/Codex.app/Contents/Resources/codex",
        "/usr/local/bin/codex",
        "/opt/homebrew/bin/codex",
    ];
    candidates.iter().map(Path::new).find(|path| path.is_file()).map(Path::to_path_buf)
}

fn find_path_codex_binary() -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|dir| dir.join(if cfg!(windows) { "codex.exe" } else { "codex" }))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| fs::canonicalize(&candidate).ok().or(Some(candidate)))
}

fn should_copy_by_hash(source: &Path, staged: &Path) -> io::Result<bool> {
    if !staged.exists() {
        return Ok(true);
    }
    Ok(file_sha256(source)? != file_sha256(staged)?)
}

fn file_sha256(path: &Path) -> io::Result<[u8; 32]> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
}
