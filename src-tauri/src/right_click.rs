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

    // Cap the file size before reading to avoid OOM if a buggy installer
    // or compromised process writes a multi-GB file here. The real payload
    // is well under 1 KiB.
    const MAX_PENDING_BYTES: u64 = 8 * 1024;
    let meta = std::fs::metadata(&path)?;
    if meta.len() > MAX_PENDING_BYTES {
        let _ = std::fs::remove_file(&path);
        return Err(anyhow!(
            "pending-right-click.json is too large ({} bytes > {} limit); \
             file removed for safety",
            meta.len(),
            MAX_PENDING_BYTES
        ));
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

/// Escape a path so it's safe to embed inside a Windows `cmd.exe`
/// command string that is itself wrapped in double quotes.
///
/// Rules (see https://learn.microsoft.com/en-us/cpp/cpp/main-function-command-line-args ):
///   - Inside a `"..."` quoted argument, a literal `"` must be written as `\"`.
///   - A run of backslashes immediately followed by `"` must double the
///     backslashes (so the parser doesn't treat them as escapes for the quote).
///
/// This matters because the path is later written to the Windows registry
/// under `HKCU\Software\Classes\*\shell\FeClawReference\command` and invoked
/// by the shell as a substitution for `%1`. If `exe_path` contains a quote
/// or a backslash-quote pattern, a naive `format!("\"{exe_path}\" ...")`
/// would let `%1` arguments be smuggled in or out of the quoted region.
#[cfg(windows)]
fn quote_cmd_arg(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    let mut backslashes: usize = 0;
    for ch in s.chars() {
        match ch {
            '\\' => {
                backslashes += 1;
                out.push('\\');
            }
            '"' => {
                // Escape the preceding backslashes, then escape the quote.
                for _ in 0..backslashes {
                    out.push('\\');
                }
                out.push('\\');
                out.push('"');
                backslashes = 0;
            }
            _ => {
                backslashes = 0;
                out.push(ch);
            }
        }
    }
    out
}

/// Build the registry command string for a given mode, with the exe path
/// properly escaped for cmd.exe argument parsing.
#[cfg(windows)]
fn build_command_string(exe_path: &str, mode: &str) -> String {
    format!(
        "\"{}\" --right-click {} \"%1\"",
        quote_cmd_arg(exe_path),
        mode
    )
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
        let ref_cmd_str = build_command_string(&exe_path, "reference");
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
        let send_cmd_str = build_command_string(&exe_path, "send");
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn quote_cmd_arg_plain_path() {
        // No special characters — output should just be the input.
        assert_eq!(quote_cmd_arg(r"C:\Program Files\App\app.exe"), r"C:\Program Files\App\app.exe");
    }

    #[test]
    fn quote_cmd_arg_escapes_quote() {
        // A literal " inside the path must become \"
        assert_eq!(quote_cmd_arg(r#"C:\foo"bar.exe"#), r#"C:\foo\"bar.exe"#);
    }

    #[test]
    fn quote_cmd_arg_doubles_backslash_before_quote() {
        // A run of backslashes followed by " must double them, so the
        // parser doesn't eat them as escapes for the quote.
        assert_eq!(quote_cmd_arg(r#"C:\foo\"bar.exe"#), r#"C:\foo\\\"bar.exe"#);
    }

    #[test]
    fn build_command_string_wraps_in_quotes() {
        let s = build_command_string(r"C:\App\app.exe", "send");
        assert_eq!(s, r#""C:\App\app.exe" --right-click send "%1""#);
    }
}
