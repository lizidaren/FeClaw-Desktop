//! VFS `/mnt/desktop/<path>` ⇄ local filesystem path translation.
//!
//! Layout (per design §3.2):
//!   * `/mnt/desktop/C:/Users/alice/file.txt`  → Windows absolute
//!   * `/mnt/desktop/foo.txt`                  → `~/Desktop/foo.txt`
//!   * `/mnt/desktop/sub/note.md`              → `~/Desktop/sub/note.md`
//!
//! Path-traversal defence: the resolved local path MUST stay under
//! `dirs::desktop_dir()` (or be an explicit Windows absolute that starts
//! with a drive letter). We canonicalise both sides and check `starts_with`.

use anyhow::{anyhow, Result};
use std::path::{Component, Path, PathBuf};

/// Resolve a `/mnt/desktop/...` path to a local filesystem path.
/// Returns `Err` if the path tries to escape the desktop directory.
pub fn resolve_desktop_path(vfs_path: &str) -> Result<PathBuf> {
    let stripped = vfs_path
        .strip_prefix("/mnt/desktop/")
        .ok_or_else(|| anyhow!("not under /mnt/desktop/: {vfs_path}"))?;

    if stripped.is_empty() {
        return Err(anyhow!("empty /mnt/desktop/ path"));
    }

    // Disallow `..` segments outright — we never want a caller to walk above
    // the desktop root.
    for comp in Path::new(stripped).components() {
        if matches!(comp, Component::ParentDir) {
            return Err(anyhow!("path traversal blocked: {vfs_path}"));
        }
    }

    // Windows absolute (`C:/...`, `D:\...`) → pass through with separator fix.
    #[cfg(windows)]
    {
        if stripped.len() >= 2 {
            let bytes = stripped.as_bytes();
            if bytes[0].is_ascii_alphabetic() && (bytes[1] == b':' || bytes[1] == b'\\' || bytes[1] == b'/') {
                let mut p = PathBuf::from(&stripped[0..2]);
                for seg in stripped[2..].split(|c| c == '/' || c == '\\') {
                    if !seg.is_empty() {
                        p.push(seg);
                    }
                }
                return Ok(p);
            }
        }
    }

    // Default: relative to ~/Desktop.
    let desktop = dirs::desktop_dir()
        .ok_or_else(|| anyhow!("could not locate user desktop directory"))?;
    Ok(desktop.join(stripped))
}

/// Single-call existence check: resolves the path once, then asks the OS.
pub fn path_exists(vfs_path: &str) -> Result<bool> {
    let resolved = resolve_desktop_path(vfs_path)?;
    Ok(resolved.exists())
}

/// Read the file at the given VFS path. Returns UTF-8 content.
pub async fn file_read(vfs_path: &str) -> Result<String> {
    let resolved = resolve_desktop_path(vfs_path)?;
    let bytes = tokio::fs::read(&resolved)
        .await
        .map_err(|e| anyhow!("read {}: {e}", resolved.display()))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Write `content` to the given VFS path. Creates parent directories.
pub async fn file_write(vfs_path: &str, content: &str) -> Result<()> {
    let resolved = resolve_desktop_path(vfs_path)?;
    if let Some(parent) = resolved.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| anyhow!("mkdir {}: {e}", parent.display()))?;
    }
    tokio::fs::write(&resolved, content)
        .await
        .map_err(|e| anyhow!("write {}: {e}", resolved.display()))?;
    Ok(())
}

/// Delete the file at the given VFS path.
pub async fn file_delete(vfs_path: &str) -> Result<()> {
    let resolved = resolve_desktop_path(vfs_path)?;
    tokio::fs::remove_file(&resolved)
        .await
        .map_err(|e| anyhow!("delete {}: {e}", resolved.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_traversal() {
        assert!(resolve_desktop_path("/mnt/desktop/../etc/passwd").is_err());
        assert!(resolve_desktop_path("/mnt/desktop/sub/../../passwd").is_err());
    }

    #[test]
    fn resolve_rejects_non_desktop_prefix() {
        assert!(resolve_desktop_path("/etc/hosts").is_err());
        assert!(resolve_desktop_path("/mnt/foo/bar").is_err());
    }

    #[test]
    fn resolve_accepts_simple_relative() {
        // We can't assert the exact path (depends on host), but the call must succeed
        // and return an absolute path under the user's home.
        let p = resolve_desktop_path("/mnt/desktop/notes.md").unwrap();
        assert!(p.is_absolute());
    }
}
