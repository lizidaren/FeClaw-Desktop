//! Tauri commands exposing the file relay to the frontend (Phase 2).
//!
//! The frontend calls these via `invoke('file_read', { path })` etc. Each
//! command resolves the VFS path through [`file_bridge::resolve_desktop_path`]
//! (which enforces the `/mnt/desktop/` prefix and blocks `..` traversal),
//! enforces the 1 MiB size cap on reads, and asks `ConsentManager` before
//! any write/delete.
//!
//! File system calls run inside `tokio::task::spawn_blocking` so we don't
//! stall the async runtime on disk I/O.

use crate::consent::OperationOutcome;
use crate::file_bridge;
use crate::AppState;
use std::path::PathBuf;
use tauri::State;

/// Maximum file size for a single `file_read` call. Matches the cap used by
/// `executor::MAX_OUTPUT_BYTES` so an agent can't blow up memory / a
/// websocket frame by reading an oversized file.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// Returns `true` if `vfs_path` looks like a Windows absolute path
/// (e.g. `C:/foo/bar`, `D:\Users\alice\file.txt`). Used to reject
/// drive-letter paths on non-Windows hosts.
fn looks_like_windows_absolute(vfs_path: &str) -> bool {
    let bytes = vfs_path.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && (bytes[1] == b':' || bytes[1] == b'\\' || bytes[1] == b'/')
}

/// Resolve a VFS path to a local path, with two extra defences on top of
/// `file_bridge::resolve_desktop_path`:
///   * Reject Windows-absolute paths on non-Windows platforms.
///   * Enforce the 1 MiB size cap for reads.
fn resolve_for_read(vfs_path: &str) -> Result<(PathBuf, u64), String> {
    #[cfg(not(windows))]
    {
        if looks_like_windows_absolute(vfs_path) {
            return Err(format!(
                "Windows absolute path not supported on this platform: {vfs_path}"
            ));
        }
    }

    let resolved = file_bridge::resolve_desktop_path(vfs_path)
        .map_err(|e| format!("invalid path {vfs_path}: {e}"))?;

    let size = std::fs::metadata(&resolved)
        .map_err(|e| format!("stat {}: {e}", resolved.display()))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err(format!(
            "file too large: {size} bytes (max {MAX_FILE_BYTES}); consider streaming"
        ));
    }

    Ok((resolved, size))
}

/// Resolve a VFS path for write/delete — same as `resolve_for_read` but
/// without the size check (the file may not exist yet).
fn resolve_for_write(vfs_path: &str) -> Result<PathBuf, String> {
    #[cfg(not(windows))]
    {
        if looks_like_windows_absolute(vfs_path) {
            return Err(format!(
                "Windows absolute path not supported on this platform: {vfs_path}"
            ));
        }
    }

    file_bridge::resolve_desktop_path(vfs_path)
        .map_err(|e| format!("invalid path {vfs_path}: {e}"))
}

/// Read a file's UTF-8 contents. Requires L2 consent — even the agent
/// must ask before reading files on the user's machine.
#[tauri::command]
pub async fn file_read(
    path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let outcome = {
        let mut guard = state.consent.lock().await;
        guard.request_operation("read", &path).await
    };
    match outcome {
        OperationOutcome::Allow => {}
        OperationOutcome::Denied => {
            return Err(format!("user denied read of {path}"));
        }
        OperationOutcome::Timeout => {
            return Err(format!(
                "consent dialog timed out (5 min) for read of {path}"
            ));
        }
    }

    let (resolved, _size) = resolve_for_read(&path)?;

    let path_for_err = path.clone();
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&resolved))
        .await
        .map_err(|e| format!("read task panicked: {e}"))?
        .map_err(|e| format!("read {path_for_err}: {e}"))?;

    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Write `content` to a file. Asks for L2 consent first.
#[tauri::command]
pub async fn file_write(
    path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let outcome = {
        let mut guard = state.consent.lock().await;
        guard.request_operation("write", &path).await
    };
    match outcome {
        OperationOutcome::Allow => {}
        OperationOutcome::Denied => {
            return Err(format!("user denied write to {path}"));
        }
        OperationOutcome::Timeout => {
            return Err(format!(
                "consent dialog timed out (5 min) for write to {path}"
            ));
        }
    }

    let resolved = resolve_for_write(&path)?;
    let path_for_err = path.clone();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        if let Some(parent) = resolved.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&resolved, content.as_bytes())
    })
    .await
    .map_err(|e| format!("write task panicked: {e}"))?
    .map_err(|e| format!("write {path_for_err}: {e}"))?;

    Ok(())
}

/// Delete a file. Asks for L3 consent first (warning-level dialog).
#[tauri::command]
pub async fn file_delete(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let outcome = {
        let mut guard = state.consent.lock().await;
        guard.request_operation("delete", &path).await
    };
    match outcome {
        OperationOutcome::Allow => {}
        OperationOutcome::Denied => {
            return Err(format!("user denied delete of {path}"));
        }
        OperationOutcome::Timeout => {
            return Err(format!(
                "consent dialog timed out (5 min) for delete of {path}"
            ));
        }
    }

    let resolved = resolve_for_write(&path)?;
    let path_for_err = path.clone();
    tokio::task::spawn_blocking(move || std::fs::remove_file(&resolved))
        .await
        .map_err(|e| format!("delete task panicked: {e}"))?
        .map_err(|e| format!("delete {path_for_err}: {e}"))?;

    Ok(())
}

/// Open a local file with the system default application.
/// Uses the `open` crate which is already a dependency.
#[tauri::command]
pub async fn open_local_file(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        open::that(&path).map_err(|e| format!("open file {}: {e}", path))
    })
    .await
    .map_err(|e| format!("open_local_file task panicked: {e}"))?
}

/// Clean up the temp preview directory (called on app exit or window close).
/// Removes all files under `~/.feclaw/temp/preview/`.
#[tauri::command]
pub fn cleanup_preview_temp() -> Result<(), String> {
    let preview_dir = crate::config::Config::config_dir().join("temp").join("preview");
    if !preview_dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&preview_dir)
        .map_err(|e| format!("cleanup preview dir: {e}"))?;
    std::fs::create_dir_all(&preview_dir)
        .map_err(|e| format!("recreate preview dir: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_absolute_detection() {
        assert!(looks_like_windows_absolute("C:/foo/bar.txt"));
        assert!(looks_like_windows_absolute("D:\\Users\\alice"));
        assert!(looks_like_windows_absolute("c:/lowercase"));
        assert!(!looks_like_windows_absolute("/etc/passwd"));
        assert!(!looks_like_windows_absolute("relative/file.txt"));
        assert!(!looks_like_windows_absolute("Z:"));
    }
}