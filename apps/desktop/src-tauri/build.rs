use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    cleanup_tauri_resource_cache();
    tauri_build::build()
}

fn cleanup_tauri_resource_cache() {
    let out_dir = match env::var_os("OUT_DIR") {
        Some(path) => PathBuf::from(path),
        None => return,
    };

    let Some(target_dir) = out_dir
        .parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
    else {
        return;
    };

    let cached_runtime_root = target_dir.join("desktop-runtime");
    if cached_runtime_root.exists() {
        let _ = clear_readonly(&cached_runtime_root);
        let _ = fs::remove_dir_all(&cached_runtime_root);
    }
}

fn clear_readonly(path: &std::path::Path) -> std::io::Result<()> {
    if path.is_dir() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            clear_readonly(&entry.path())?;
        }
    }

    let mut permissions = fs::metadata(path)?.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mode = if path.is_dir() { 0o755 } else { 0o644 };
        permissions.set_mode(mode);
    }
    #[cfg(not(unix))]
    {
        permissions.set_readonly(false);
    }
    fs::set_permissions(path, permissions)
}
