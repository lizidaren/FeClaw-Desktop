//! Phase 0b — Agent + group creation + file picking commands.
//!
//! [`create_agent`] — POST /api/desktop/agents to the engine.
//! [`create_group_placeholder`] — empty shell, wired in Phase 4.
//! [`pick_local_file`] — native file picker → returns file metadata for input cards.
//! [`open_agent_config`] — opens the agent config WebView in a new window.

use crate::config::Config;
use serde::{Deserialize, Serialize};
use tauri::webview::WebviewWindowBuilder;
use tauri::Manager;

/// Request body for POST /api/desktop/agents.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateAgentRequest {
    name: String,
    agent_type: String,
}

/// Response from GET /api/desktop/agents (mirrors chat.rs AgentInfo).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub hash: String,
    pub name: String,
    pub description: Option<String>,
    pub avatar_url: Option<String>,
    pub permission_mode: Option<String>,
    pub is_online: bool,
}

/// Response envelope from POST /api/desktop/agents.
#[derive(Debug, Deserialize)]
struct CreateAgentResponse {
    hash: String,
    name: String,
    description: Option<String>,
}

/// Create a new Agent via the engine API.
/// `agent_type` is either "classic" or "im".
#[tauri::command]
pub async fn create_agent(
    name: String,
    agent_type: String,
) -> Result<AgentInfo, String> {
    let cfg = Config::load();
    let token = cfg.cloud_token
        .clone()
        .ok_or_else(|| "未登录：cloud_token 不存在".to_string())?;
    let base_url = cfg.cloud_base_url()
        .ok_or_else(|| "cloud_url 未配置".to_string())?;
    let url = format!("{}/api/desktop/agents", base_url.trim_end_matches('/'));

    let client = crate::http_client::http_client();

    let req_body = CreateAgentRequest {
        name: name.trim().to_string(),
        agent_type,
    };

    let resp = client
        .post(&url)
        .bearer_auth(&token)
        .json(&req_body)
        .send()
        .await
        .map_err(|e| format!("创建 Agent 失败：{e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("创建 Agent 失败 ({}): {}", status, body));
    }

    let created: CreateAgentResponse = resp.json().await
        .map_err(|e| format!("解析创建响应失败：{e}"))?;

    Ok(AgentInfo {
        hash: created.hash,
        name: created.name,
        description: created.description,
        avatar_url: None,
        permission_mode: None,
        is_online: true,
    })
}

/// Placeholder for group creation. Phase 4 will wire this to the engine's
/// POST /api/groups/create endpoint.
#[tauri::command]
pub async fn create_group_placeholder() -> Result<String, String> {
    // Returns a placeholder group ID. Real implementation in Phase 4.
    Ok(String::from("placeholder-group-id"))
}

/// Open the agent configuration WebView (AI config wizard on the web).
#[tauri::command]
pub async fn open_agent_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    agent_hash: String,
) -> Result<(), String> {
    let guard = state.config.read().await;
    let config = guard.clone();
    let token = config.cloud_token.clone()
        .ok_or_else(|| "未登录".to_string())?;
    let base_url = config.cloud_base_url()
        .ok_or_else(|| "cloud_url 未配置".to_string())?;
    let configure_url = format!(
        "{}/agent/{}/configure?token={}",
        base_url.trim_end_matches('/'),
        agent_hash,
        token,
    );

    let app_handle = app.clone();
    let url = configure_url.clone();
    tauri::async_runtime::spawn(async move {
        let bapp = app_handle.clone();
        let napp = app_handle;
        if let Ok(window) = WebviewWindowBuilder::new(
            &bapp,
            "agent-config",
            tauri::WebviewUrl::External(url.parse().unwrap()),
        )
        .title("Agent 配置")
        .inner_size(1024.0, 720.0)
        .on_navigation(move |url| {
            if !url.as_str().contains("/configure") {
                if let Some(w) = napp.get_webview_window("agent-config") {
                    let _ = w.close();
                }
                return false;
            }
            true
        })
        .build()
        {
            let _ = window;
        }
    });

    Ok(())
}

// ---------------------------------------------------------------------------
// Local file picker
// ---------------------------------------------------------------------------

/// A file card displayed in the input box.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    /// Unique temporary ID for this card.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Full resolved path on the local filesystem.
    pub path: String,
    /// Human-readable size string (e.g. "2.3 MB").
    pub size_label: String,
    /// "reference" (read/write) or "send_copy" (read-only).
    pub mode: String,
    /// Raw size in bytes.
    pub size_bytes: u64,
}

/// Open a native file picker and return metadata for the selected file.
/// `mode` is either "reference" (read/write) or "send_copy" (read-only).
#[tauri::command]
pub fn pick_local_file(mode: String) -> Result<Option<PickedFile>, String> {
    let file = rfd::FileDialog::new()
        .pick_file();

    match file {
        Some(path) => {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("未知文件")
                .to_string();

            let size_bytes = path
                .metadata()
                .map(|m| m.len())
                .unwrap_or(0);

            let size_label = human_size(size_bytes);

            Ok(Some(PickedFile {
                id: format!("file-{}", uuid_like()),
                name,
                path: path.display().to_string(),
                size_label,
                mode,
                size_bytes,
            }))
        }
        None => Ok(None),
    }
}

/// Format bytes into a human-readable string.
fn human_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;
    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{bytes} B")
    }
}

/// Cheap random hex suffix for file IDs.
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:08x}", nanos & 0xFFFF_FFFF)
}
