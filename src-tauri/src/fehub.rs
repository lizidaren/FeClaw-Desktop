//! FeHub mini-program management.
//!
//! Manages publishing and browsing of FeHub mini-programs (miniapps).
//! Calls the Engine's `/api/fehub/apps` endpoint to list published apps.

use crate::config::Config;
use anyhow::anyhow;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Path to the persisted credentials file (same as group.rs / moments.rs).
fn credentials_path() -> PathBuf {
    crate::config::Config::config_dir().join("local-credentials")
}

/// Lightweight struct mirroring the Credentials file layout.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Credentials {
    #[serde(default)]
    username: String,
    #[serde(default)]
    token: Option<String>,
}

/// Read the JWT from the local-credentials file.
fn load_token() -> Result<String, String> {
    let path = credentials_path();
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let creds: Credentials =
        serde_json::from_str(&content).map_err(|e| format!("parse credentials: {e}"))?;
    creds
        .token
        .ok_or_else(|| "no token in credentials file".to_string())
}

/// Build an HTTP client.
fn build_client() -> Result<reqwest::Client, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("build reqwest client: {e}"))?;
    Ok(client)
}

fn engine_url() -> String {
    let config = Config::load();
    config.engine_url()
}

// ---- Data types -----------------------------------------------------

/// Information about a published miniapp.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishInfo {
    pub id: String,
    #[serde(rename = "agent_hash")]
    pub agent_hash: String,
    #[serde(rename = "app_name")]
    pub app_name: String,
    pub tag: String,
    #[serde(rename = "is_public")]
    pub is_public: bool,
    #[serde(rename = "created_at")]
    pub created_at: u64,
}

// ---- Tauri commands --------------------------------------------------

/// List all miniapps published by the current user.
#[tauri::command]
pub async fn list_my_publishes() -> Result<Vec<PublishInfo>, String> {
    let token = load_token()?;
    let url = format!("{}/api/fehub/apps", engine_url());
    let resp = build_client()?
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("list_my_publishes request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "list_my_publishes failed: {}",
            resp.status()
        ));
    }
    let publishes: Vec<PublishInfo> = resp
        .json()
        .await
        .map_err(|e| format!("parse list_my_publishes response: {e}"))?;
    Ok(publishes)
}

/// Open a miniapp by creating a new Tauri WebviewWindow.
/// Cloud: https://{agent_hash}.feclaw.lizidaren.cn/apps/{app_name}/
/// Local: http://127.0.0.1:{port}/apps/{app_name}/
#[tauri::command]
pub async fn open_miniapp<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    app_name: String,
) -> Result<(), String> {
    use tauri::WebviewUrl;
    use tauri::WebviewWindowBuilder;

    let publishes = list_my_publishes()
        .await
        .map_err(|e| format!("获取应用信息失败：{e}"))?;

    let info = publishes
        .iter()
        .find(|p| p.app_name == app_name)
        .ok_or_else(|| format!("未找到应用：{}", app_name))?;

    let config = Config::load();
    let url = if config.mode == crate::config::Mode::Local {
        let port = config.port;
        format!("http://127.0.0.1:{}/apps/{}/", port, app_name)
    } else {
        format!(
            "https://{}.feclaw.lizidaren.cn/apps/{}/",
            info.agent_hash, app_name
        )
    };

    let label = format!("miniapp-{}", app_name.replace(['/', ' '], "-"));

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url.parse().unwrap()))
        .title(&app_name)
        .inner_size(800.0, 600.0)
        .center()
        .build()
        .map_err(|e| format!("打开小程序窗口失败：{e}"))?;

    Ok(())
}
