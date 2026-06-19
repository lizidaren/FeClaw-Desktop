//! Welcome / first-launch flow.
//!
//! Shown only when `~/.feclaw/config.toml` doesn't exist (or exists but
//! has no `mode` set). User picks one of three modes:
//!   * `official`   → pre-fill `feclaw.lizidaren.cn` + platform URL
//!   * `selfhosted` → user-supplied server URL (+ optional .well-known auto-discovery)
//!   * `local`      → open the local-setup wizard (Plan C)
//!
//! On save we either write a fresh `config.toml` (cloud / selfhosted) or
//! redirect the UI to the local-setup page (local).

use crate::config::{Config, Mode};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

/// Tauri command — return `true` when this is the first time the user
/// is opening the app (config.toml is absent or has no `mode` set).
#[tauri::command]
pub async fn check_first_launch() -> Result<bool, String> {
    let path = Config::config_path();
    if !path.exists() {
        return Ok(true);
    }
    // If the file exists but has no `mode` line, treat as first launch.
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            if content.contains("mode") {
                Ok(false)
            } else {
                Ok(true)
            }
        }
        Err(_) => Ok(true),
    }
}

/// Mode picked by the user on the welcome screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WelcomeMode {
    /// Pre-fill official endpoints (cloud).
    Official,
    /// User-supplied server URL (self-hosted cloud).
    Selfhosted,
    /// Local engine — open local-setup wizard.
    Local,
}

/// Arguments accepted by [`save_welcome_config`].
#[derive(Debug, Deserialize)]
pub struct WelcomeConfigArgs {
    pub mode: WelcomeMode,
    /// Required when `mode == Selfhosted`. Ignored otherwise.
    #[serde(default)]
    pub server_url: Option<String>,
    /// Optional override for the platform login URL (selfhosted only).
    #[serde(default)]
    pub login_url: Option<String>,
}

/// Result of saving welcome config — UI uses this to decide what to
/// navigate to next.
#[derive(Debug, Serialize)]
pub struct WelcomeResult {
    /// Config was persisted.
    pub saved: bool,
    /// If true, UI should navigate to the local-setup wizard.
    pub redirect_to_local_setup: bool,
    /// The selected mode, echoed back to the UI for confirmation.
    pub mode: String,
}

/// Save the welcome-page selection to `~/.feclaw/config.toml`.
///
/// For `local` mode, we only mark the intent (save a `config.toml` with
/// `mode = "local"`) and let the UI redirect to the local-setup wizard
/// (Plan C) which will populate the rest of the config after the engine
/// is cloned and started.
///
/// For `official` / `selfhosted`, we save the cloud URLs and switch
/// `mode` to `Cloud` so the next launch goes straight to the chat
/// window.
#[tauri::command]
pub async fn save_welcome_config(args: WelcomeConfigArgs) -> Result<WelcomeResult, String> {
    let mut cfg = Config::load();

    match args.mode {
        WelcomeMode::Official => {
            cfg.mode = Mode::Cloud;
            cfg.cloud_url = Some("https://feclaw.lizidaren.cn".to_string());
            cfg.cloud_login_url =
                Some("https://platform.firstentrance.lizidaren.cn".to_string());
            cfg.cloud_token = None;
            cfg.cloud_username = None;
            cfg.save().map_err(|e| format!("保存配置失败：{e:#}"))?;
            Ok(WelcomeResult {
                saved: true,
                redirect_to_local_setup: false,
                mode: "official".to_string(),
            })
        }
        WelcomeMode::Selfhosted => {
            let url = args
                .server_url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "请填写服务器地址".to_string())?
                .trim_end_matches('/')
                .to_string();
            let login_url = args
                .login_url
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.trim_end_matches('/').to_string())
                .unwrap_or_else(|| url.clone());

            cfg.mode = Mode::Cloud;
            cfg.cloud_url = Some(url);
            cfg.cloud_login_url = Some(login_url);
            cfg.cloud_token = None;
            cfg.cloud_username = None;
            cfg.save().map_err(|e| format!("保存配置失败：{e:#}"))?;
            Ok(WelcomeResult {
                saved: true,
                redirect_to_local_setup: false,
                mode: "selfhosted".to_string(),
            })
        }
        WelcomeMode::Local => {
            cfg.mode = Mode::Local;
            // Don't touch cloud_* fields — the user might still want
            // them after the local engine is running.
            cfg.save().map_err(|e| format!("保存配置失败：{e:#}"))?;
            Ok(WelcomeResult {
                saved: true,
                redirect_to_local_setup: true,
                mode: "local".to_string(),
            })
        }
    }
}

/// Optional: probe a server's `/.well-known/feclaw-desktop` endpoint to
/// pre-fill `login_url`. Returns the JSON payload on success, `None` if
/// the server doesn't expose the discovery endpoint (older deployments).
#[tauri::command]
pub async fn discover_well_known(url: String) -> Result<Option<String>, String> {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("服务器地址不能为空".to_string());
    }
    let probe = format!("{trimmed}/.well-known/feclaw-desktop");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent(concat!("FeClaw-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败：{e}"))?;

    match client.get(&probe).send().await {
        Ok(resp) if resp.status().is_success() => match resp.text().await {
            Ok(body) => Ok(Some(body)),
            Err(_) => Ok(None),
        },
        _ => Ok(None),
    }
}

/// Open the welcome window. Created once; subsequent calls just focus
/// the existing window.
#[tauri::command]
pub async fn open_welcome_window<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    const WIN: &str = "welcome";

    if let Some(existing) = app.get_webview_window(WIN) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, WIN, WebviewUrl::App("welcome/index.html".into()))
        .title("欢迎使用 FeClaw Desktop")
        .inner_size(820.0, 600.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| format!("创建欢迎窗口失败：{e}"))?;
    Ok(())
}

/// Helper used by the frontend to point the user at the live
/// `config.toml` path (e.g. for the "Reveal in Explorer" button on
/// the local-setup page).
pub fn config_path() -> PathBuf {
    Config::config_path()
}
