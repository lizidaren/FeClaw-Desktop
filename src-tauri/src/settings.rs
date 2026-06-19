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

// ---------------------------------------------------------------------------
// Cloud login (Settings UI → /api/login → JWT persistence)
// ---------------------------------------------------------------------------
//
// Flow:
//   1. Settings UI submits {url, username, password}.
//   2. We POST to {url}/api/login with JSON `{username, password}`.
//   3. Server returns `{token, ...}` (or `{access_token, ...}` as a fallback).
//   4. We persist `cloud_url`, `cloud_username`, `cloud_token` to config.toml
//      and switch `mode` to Cloud. The password is NEVER written to disk —
//      only the JWT, which is the bearer credential for subsequent requests.
//
// Error reporting surfaces the server's response body when available so the
// user can see *why* the login failed (e.g. "Invalid credentials" vs a
// network timeout). All errors come back as localized Chinese strings
// matching the rest of the Settings UI.

/// Login payload for `{url}/api/login`.
#[derive(Debug, Serialize)]
struct LoginRequest<'a> {
    username: &'a str,
    password: &'a str,
}

/// Subset of the server's login response we care about.
#[derive(Debug, Deserialize)]
struct LoginResponse {
    #[serde(default, alias = "access_token")]
    token: String,
}

/// Cloud session info surfaced to the UI. Used by the Settings page to
/// decide whether to show the login form or the "already connected" card.
#[derive(Debug, Serialize)]
pub struct CloudSession {
    pub connected: bool,
    pub username: Option<String>,
    pub url: Option<String>,
}

/// Inspect the current config.toml to determine if a cloud session is
/// already active. Safe to call on every page load.
#[tauri::command]
pub async fn get_cloud_session() -> Result<CloudSession, String> {
    let cfg = Config::load();
    let connected = cfg.mode == crate::config::Mode::Cloud && cfg.cloud_token.is_some();
    Ok(CloudSession {
        connected,
        username: cfg.cloud_username,
        url: cfg.cloud_url,
    })
}

/// POST `{url}/api/login` with the supplied credentials. On success, persist
/// the JWT and username to `~/.feclaw/config.toml` and flip `mode` to Cloud.
/// The password is consumed in-memory only and never written to disk.
///
/// Returns the JWT on success, or a user-friendly error string on failure.
#[tauri::command]
pub async fn cloud_login(
    url: String,
    username: String,
    password: String,
) -> Result<String, String> {
    // ---- Validate inputs ---------------------------------------------
    let url_trimmed = url.trim();
    if url_trimmed.is_empty() {
        return Err("服务器地址不能为空".to_string());
    }
    if username.trim().is_empty() {
        return Err("用户名不能为空".to_string());
    }
    if password.is_empty() {
        return Err("密码不能为空".to_string());
    }

    let login_url = format!("{}/api/auth/login", url_trimmed.trim_end_matches('/'));
    let username_owned = username.trim().to_string();

    // ---- HTTP POST ---------------------------------------------------
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(concat!("FeClaw-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败：{e}"))?;

    let resp = client
        .post(&login_url)
        .json(&LoginRequest {
            username: &username_owned,
            password: &password,
        })
        .send()
        .await
        .map_err(|e| format!("登录请求失败：{e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format_login_error(status.as_u16(), &body));
    }

    let body: LoginResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析登录响应失败：{e}"))?;

    if body.token.trim().is_empty() {
        return Err("服务器响应中未找到 token".to_string());
    }
    let token = body.token;

    // ---- Persist to config.toml -------------------------------------
    // Load the existing config so we don't clobber unrelated fields
    // (port, host, ws_path, etc.). The password is never written.
    let mut cfg = Config::load();
    cfg.cloud_url = Some(url_trimmed.trim_end_matches('/').to_string());
    cfg.cloud_username = Some(username_owned);
    cfg.cloud_token = Some(token.clone());
    cfg.mode = crate::config::Mode::Cloud;
    cfg.save().map_err(|e| format!("保存配置失败：{e:#}"))?;

    tracing::info!("cloud login succeeded; token length={}", token.len());
    Ok(token)
}

/// Disconnect from the cloud: clear the stored credentials and switch the
/// app back to local mode. The password is never stored, so this is the
/// only cleanup needed.
#[tauri::command]
pub async fn cloud_disconnect() -> Result<(), String> {
    let mut cfg = Config::load();
    cfg.cloud_token = None;
    cfg.cloud_username = None;
    // Keep cloud_url so the user doesn't have to retype it next time.
    cfg.mode = crate::config::Mode::Local;
    cfg.save().map_err(|e| format!("保存配置失败：{e:#}"))?;
    tracing::info!("cloud session disconnected");
    Ok(())
}

/// Convert a non-2xx login response into a user-friendly error message.
/// Tries to pull `detail` / `message` from the JSON body, falling back to
/// the raw text if the body isn't valid JSON.
fn format_login_error(status: u16, body: &str) -> String {
    let detail = if body.is_empty() {
        "服务器未返回详细信息".to_string()
    } else if let Ok(json) = serde_json::from_str::<Value>(body) {
        json.get("detail")
            .or_else(|| json.get("message"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| body.to_string())
    } else {
        body.to_string()
    };
    format!("登录失败 ({}): {}", status, detail)
}
