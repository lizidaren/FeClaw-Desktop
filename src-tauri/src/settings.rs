//! User-editable settings persisted to `~/.feclaw/`.
//!
//! Two layers:
//!
//! * [`Settings`] — strongly-typed runtime settings (mode, auto-start, agent
//!   hash). Persisted to `settings.json`.
//! * [`load_settings`] / [`save_settings`] — generic key/value bag used by the
//!   Settings UI (cloud URL/token, theme, start-minimized, …). Persisted to a
//!   separate file (`ui-settings.json`) to keep the two schemas independent.

use crate::config::Config;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Settings {
    /// Last-selected mode (mirrored from `Config::mode`).
    pub mode: crate::config::Mode,
    /// Tray tooltip override.
    pub tray_tooltip: Option<String>,
    /// Whether to launch at login.
    pub auto_start: bool,
    /// Identifier of the active agent (used to scope WS auth).
    pub active_agent_hash: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            mode: crate::config::Mode::Local,
            tray_tooltip: None,
            auto_start: false,
            active_agent_hash: None,
        }
    }
}

impl Settings {
    pub fn path() -> PathBuf {
        Config::config_dir().join("settings.json")
    }

    pub fn load() -> Self {
        let path = Self::path();
        match std::fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
                tracing::warn!("settings parse error: {e}; using defaults");
                Self::default()
            }),
            Err(_) => {
                let s = Self::default();
                // Best-effort persist of defaults.
                let path = path.clone();
                let s_clone = s.clone();
                tokio::spawn(async move {
                    let _ = s_clone.save().await;
                });
                s
            }
        }
    }

    /// Persist this settings object to disk. Async to avoid blocking the
    /// runtime on slow drives or antivirus scans.
    pub async fn save(&self) -> Result<()> {
        if let Some(parent) = Self::path().parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let json = serde_json::to_string_pretty(self).context("serialize settings")?;
        tokio::fs::write(Self::path(), json)
            .await
            .context("write settings.json")?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// UI key/value settings (`~/.feclaw/ui-settings.json`)
// ---------------------------------------------------------------------------
//
// Schema-less bag exposed to the Settings UI. The frontend treats every value
// as a string; the backend flattens JSON primitives (bool/number/null) to
// their string representation on read and stores the bag as a JSON object on
// write. This lets the UI add new keys without a Rust recompile.

/// Path to the UI key/value settings file.
fn ui_settings_path() -> PathBuf {
    Config::config_dir().join("ui-settings.json")
}

/// Coerce a JSON [`Value`] into a flat string suitable for the UI.
fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Read the UI settings bag from disk. Missing file → empty bag (no error).
#[tauri::command]
pub async fn load_settings() -> Result<HashMap<String, String>, String> {
    let path = ui_settings_path();
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(format!("读取设置失败：{e}")),
    };

    let value: Value = serde_json::from_str(&content)
        .map_err(|e| format!("解析设置文件失败：{e}"))?;

    let map = match value {
        Value::Object(obj) => obj,
        // Tolerate a top-level scalar (e.g. `null` or `"foo"`) by treating it
        // as an empty bag rather than panicking.
        _ => {
            tracing::warn!("ui-settings.json top-level is not an object; ignoring");
            return Ok(HashMap::new());
        }
    };

    Ok(map.into_iter().map(|(k, v)| (k, value_to_string(&v))).collect())
}

/// Persist the entire UI settings bag to disk. The frontend is the source of
/// truth — the Rust side just round-trips the map.
#[tauri::command]
pub async fn save_settings(settings: HashMap<String, String>) -> Result<(), String> {
    let path = ui_settings_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    // Preserve the user's preferred key order by sorting (matches the existing
    // .env writer in v2-plan §1.3 and keeps diffs in version control clean).
    let mut entries: Vec<(String, String)> = settings.into_iter().collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let json = serde_json::to_string_pretty(&entries)
        .map_err(|e| format!("序列化设置失败：{e}"))?;
    tokio::fs::write(&path, json)
        .await
        .map_err(|e| format!("写入设置失败：{e}"))?;
    Ok(())
}

/// Open the Settings window. If the window is already open it is focused
/// instead of spawned a second time.
#[tauri::command]
pub async fn open_settings_window<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    use tauri::Manager;
    use tauri::WebviewUrl;
    use tauri::WebviewWindowBuilder;

    const WIN: &str = "settings";

    if let Some(existing) = app.get_webview_window(WIN) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, WIN, WebviewUrl::App("settings/index.html".into()))
        .title("FeClaw Desktop 设置")
        .inner_size(640.0, 720.0)
        .min_inner_size(520.0, 480.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| format!("创建设置窗口失败：{e}"))?;
    Ok(())
}

/// Probe a cloud server URL with an optional bearer token. Returns `Ok(true)`
/// for any 2xx/3xx response, `Ok(false)` for 4xx/5xx, and an `Err` for
/// network-level failures (DNS, TCP, TLS, timeout).
#[tauri::command]
pub async fn test_cloud_connection(url: String, token: String) -> Result<bool, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("服务器地址不能为空".to_string());
    }

    let probe_url = format!(
        "{}/api/health",
        trimmed.trim_end_matches('/'),
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent(concat!("FeClaw-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败：{e}"))?;

    let mut req = client.get(&probe_url);
    if !token.trim().is_empty() {
        req = req.bearer_auth(token.trim());
    }

    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            if status.is_success() || status.is_redirection() {
                Ok(true)
            } else {
                tracing::warn!("cloud probe returned {status} for {probe_url}");
                Ok(false)
            }
        }
        Err(e) => Err(format!("连接失败：{e}")),
    }
}
