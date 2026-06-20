//! Windows right-click shell context menu registration.
//!
//! Registers two entries in `HKCU\Software\Classes\*\shell\`:
//!   - `FeClawReference` → "📎 FeClaw 引用" (mode = "reference")
//!   - `FeClawSend`      → "📤 FeClaw 发送" (mode = "send")
//!
//! Each entry's `command` sub-key invokes the desktop exe with:
//!   `--right-click <mode> <filepath>`

use anyhow::{anyhow, Result};

#[cfg(windows)]
use winreg::enums::*;
#[cfg(windows)]
use winreg::RegKey;

/// Save a pending right-click file to `~/.feclaw/pending-right-click.json`.
/// The app reads this on startup to show the send dialog.
fn pending_file_path() -> std::path::PathBuf {
    crate::config::Config::config_dir().join("pending-right-click.json")
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct PendingFile {
    pub mode: String,   // "reference" | "send"
    pub path: String,   // absolute local path
}

fn save_pending(mode: &str, path: &str) -> Result<()> {
    let pending = PendingFile {
        mode: mode.to_string(),
        path: path.to_string(),
    };
    let json = serde_json::to_string_pretty(&pending)?;
    std::fs::create_dir_all(pending_file_path().parent().unwrap())?;
    std::fs::write(pending_file_path(), json)?;
    Ok(())
}

/// Read and clear the pending right-click file. Returns `None` if no pending file.
pub fn take_pending_right_click() -> Result<Option<PendingFile>> {
    let path = pending_file_path();
    if !path.exists() {
        return Ok(None);
    }
    let json = std::fs::read_to_string(&path)?;
    std::fs::remove_file(&path).ok(); // cleanup regardless
    let pending: PendingFile = serde_json::from_str(&json)?;
    Ok(Some(pending))
}

/// Return the current executable path — used to build the registry command strings.
#[tauri::command]
pub fn get_executable_path() -> Result<String, String> {
    std::env::current_exe()
        .map_err(|e| format!("failed to get exe path: {e}"))
        .map(|p| p.to_string_lossy().into_owned())
}

/// Register the right-click shell context menu entries.
#[tauri::command]
pub fn register_right_click(exe_path: String) -> Result<(), String> {
    #[cfg(not(windows))]
    return Err("right-click registration is only supported on Windows".into());

    #[cfg(windows)]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        // ---- FeClawReference: "📎 FeClaw 引用" ----
        let (ref_key, _) = hkcu
            .create_subkey(r"Software\Classes\*\shell\FeClawReference")
            .map_err(|e| format!("create FeClawReference key: {e}"))?;
        ref_key
            .set_value("", &"📎 FeClaw 引用")
            .map_err(|e| format!("set FeClawReference default: {e}"))?;
        ref_key
            .set_value("Icon", &exe_path)
            .map_err(|e| format!("set FeClawReference Icon: {e}"))?;

        let (ref_cmd, _) = ref_key
            .create_subkey("command")
            .map_err(|e| format!("create FeClawReference\\command: {e}"))?;
        let ref_cmd_str = format!("\"{exe_path}\" --right-click reference \"%1\"");
        ref_cmd
            .set_value("", &ref_cmd_str)
            .map_err(|e| format!("set FeClawReference\\command: {e}"))?;

        // ---- FeClawSend: "📤 FeClaw 发送" ----
        let (send_key, _) = hkcu
            .create_subkey(r"Software\Classes\*\shell\FeClawSend")
            .map_err(|e| format!("create FeClawSend key: {e}"))?;
        send_key
            .set_value("", &"📤 FeClaw 发送")
            .map_err(|e| format!("set FeClawSend default: {e}"))?;

        let (send_cmd, _) = send_key
            .create_subkey("command")
            .map_err(|e| format!("create FeClawSend\\command: {e}"))?;
        let send_cmd_str = format!("\"{exe_path}\" --right-click send \"%1\"");
        send_cmd
            .set_value("", &send_cmd_str)
            .map_err(|e| format!("set FeClawSend\\command: {e}"))?;

        Ok(())
    }
}

/// Unregister (delete) the right-click shell context menu entries.
#[tauri::command]
pub fn unregister_right_click() -> Result<(), String> {
    #[cfg(not(windows))]
    return Err("right-click unregistration is only supported on Windows".into());

    #[cfg(windows)]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        // Best-effort deletion — ignore errors if keys don't exist
        let _ = hkcu.delete_subkey_all(r"Software\Classes\*\shell\FeClawReference");
        let _ = hkcu.delete_subkey_all(r"Software\Classes\*\shell\FeClawSend");

        Ok(())
    }
}

/// Check whether the right-click entries are currently registered.
#[tauri::command]
pub fn is_right_click_registered() -> Result<bool, String> {
    #[cfg(not(windows))]
    return Ok(false);

    #[cfg(windows)]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let ref_exists = hkcu
            .open_subkey(r"Software\Classes\*\shell\FeClawReference\command")
            .is_ok();
        let send_exists = hkcu
            .open_subkey(r"Software\Classes\*\shell\FeClawSend\command")
            .is_ok();
        // Return true only if both exist
        Ok(ref_exists && send_exists)
    }
}

/// Handle `--right-click <mode> <filepath>` invocation from the shell.
/// Writes the pending file and returns `Ok(())` so main.rs can continue
/// to boot the GUI normally.
pub fn handle_right_click_invocation(mode: &str, path: &str) -> Result<()> {
    // Canonicalise / validate the path exists
    let path_buf = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| anyhow!("invalid path {}: {e}", path))?;
    let path_str = path_buf.to_string_lossy().into_owned();

    if mode != "reference" && mode != "send" {
        return Err(anyhow!("unknown right-click mode: {mode}"));
    }

    save_pending(mode, &path_str)?;
    tracing::info!("pending right-click stored: mode={mode}, path={path_str}");
    Ok(())
}
