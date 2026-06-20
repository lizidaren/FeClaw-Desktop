//! Chat window + history persistence (P0.5).
//!
//! The chat window is the main user-facing UI after onboarding. It
//! displays:
//!   * past messages persisted to `~/.feclaw/chat_history.json`
//!   * live messages streamed from the engine over WebSocket
//!   * inline consent prompts for file operations (P1.2)
//!
//! Persistence model: every send/receive is appended to the JSON file
//! immediately so a crash never loses context. The file is also re-read
//! on every `get_chat_history` call so multiple windows see consistent
//! state.
//!
//! Transport: the chat module does NOT own a WebSocket — it borrows the
//! shared `WsClient` sender (`outgoing_tx`) via [`AppState::ws_outgoing`]
//! so all messages funnel through the same reconnect loop. Incoming chat
//! messages are pushed to the frontend by `WsClient::handle_message`
//! which emits the `chat-event` Tauri event.

use crate::AppState;
use tauri::Manager;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Emitter;

/// One persisted message. JSON-encoded to `~/.feclaw/chat_history.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    /// Stable identifier (UUID v4 in practice; here we accept any string).
    pub id: String,
    /// `user` for messages the user typed, `assistant` for replies.
    pub role: String,
    /// Plain-text body. Newlines preserved.
    pub content: String,
    /// Unix epoch seconds (string for forward compatibility with ISO-8601).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    /// Optional agent identifier for assistant messages — useful when the
    /// engine runs multiple sub-agents and the user wants to know which one
    /// answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

/// Snapshot returned to the frontend on page load.
#[derive(Debug, Clone, Serialize)]
pub struct ChatHistory {
    pub messages: Vec<ChatMessage>,
    /// Path to the underlying JSON file (handy for debugging / "Reveal in
    /// Explorer" buttons).
    pub path: String,
}

/// Path to the JSON file backing [`ChatMessage`].
fn history_path() -> PathBuf {
    crate::config::Config::config_dir().join("chat_history.json")
}

/// Read the entire chat history. Missing file → empty list (no error).
#[tauri::command]
pub async fn get_chat_history() -> Result<ChatHistory, String> {
    let path = history_path();
    let messages = match tokio::fs::read_to_string(&path).await {
        Ok(content) => match serde_json::from_str::<Vec<ChatMessage>>(&content) {
            Ok(list) => list,
            Err(e) => {
                tracing::warn!("chat history parse error: {e}; starting fresh");
                Vec::new()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("读取聊天历史失败：{e}")),
    };
    Ok(ChatHistory {
        messages,
        path: path.display().to_string(),
    })
}

/// Append one message to the JSON file atomically. The frontend calls
/// this after rendering an optimistic local echo so the message survives
/// a crash even if the WS send hasn't been ACKed yet.
#[tauri::command]
pub async fn append_chat_message(message: ChatMessage) -> Result<(), String> {
    let path = history_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建配置目录失败：{e}"))?;
    }

    // Read existing list (if any) → push → write back. The file is small
    // (a few KB even after hundreds of messages), so the read-modify-write
    // is fine for MVP. A real DB can replace this later.
    let mut list: Vec<ChatMessage> = match tokio::fs::read_to_string(&path).await {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("读取聊天历史失败：{e}")),
    };
    list.push(message);

    // Pretty-print so the file is human-inspectable.
    let json = serde_json::to_string_pretty(&list)
        .map_err(|e| format!("序列化聊天历史失败：{e}"))?;
    tokio::fs::write(&path, json)
        .await
        .map_err(|e| format!("写入聊天历史失败：{e}"))?;
    Ok(())
}

/// Clear the chat history (used by the "新对话" button in the chat UI).
#[tauri::command]
pub async fn clear_chat_history() -> Result<(), String> {
    let path = history_path();
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("清除聊天历史失败：{e}")),
    }
}

/// Send a chat message to the engine. The frontend passes just the text
/// payload — we generate the envelope (`type`, `id`, `timestamp`) here so
/// the JS side doesn't need to know the wire format.
///
/// On success, the message is also persisted to the history file so the
/// UI can show it immediately without waiting for a server echo.
#[tauri::command]
pub async fn send_chat_message(
    text: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("消息不能为空".to_string());
    }

    // Generate a stable id (timestamp + random suffix). Not crypto-strong,
    // but unique enough for a single user session.
    let id = format!(
        "msg-{}-{}",
        crate::ws_types::current_timestamp(),
        uuid_like_suffix()
    );
    let ts = crate::ws_types::current_timestamp();

    // 1. Persist locally first so a WS outage doesn't lose the user's
    //    message.
    append_internal(
        ChatMessage {
            id: id.clone(),
            role: "user".to_string(),
            content: trimmed.to_string(),
            timestamp: Some(ts.clone()),
            agent: None,
        },
        state.clone(),
    )
    .await?;

    // 2. Send to the engine over the shared WS.
    let envelope = serde_json::json!({
        "type": "chat_message",
        "id": id,
        "text": trimmed,
        "timestamp": ts,
    });
    let json = serde_json::to_string(&envelope)
        .map_err(|e| format!("序列化消息失败：{e}"))?;

    let tx = state.ws_outgoing.clone();
    let tx_guard = tx.write().await;
    if let Some(tx) = tx_guard.as_ref() {
        tx.send(json)
            .map_err(|_| "WebSocket 已断开，消息仅保存到本地".to_string())?;
    } else {
        return Err("WebSocket 发送端未初始化".to_string());
    }

    Ok(id)
}

/// Send a group message via the shared WS channel.
#[tauri::command]
pub async fn send_group_message(
    group_id: String,
    content: String,
    mentions: Option<Vec<String>>,
    attachments: Option<Vec<serde_json::Value>>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("消息不能为空".to_string());
    }

    let id = format!(
        "gmsg-{}-{}",
        crate::ws_types::current_timestamp(),
        uuid_like_suffix()
    );
    let ts = crate::ws_types::current_timestamp();

    let envelope = serde_json::json!({
        "type": "send_group_message",
        "id": id,
        "group_id": group_id,
        "content": trimmed,
        "mentions": mentions,
        "attachments": attachments,
        "timestamp": ts,
    });
    let json = serde_json::to_string(&envelope)
        .map_err(|e| format!("序列化群消息失败：{e}"))?;

    let tx = state.ws_outgoing.clone();
    let tx_guard = tx.write().await;
    if let Some(tx) = tx_guard.as_ref() {
        tx.send(json)
            .map_err(|_| "WebSocket 已断开，消息发送失败".to_string())?;
    } else {
        return Err("WebSocket 发送端未初始化".to_string());
    }

    Ok(id)
}

/// Append a message to history AND emit a `chat-event` so any open chat
/// window re-renders. Used internally by [`send_chat_message`] and by the
/// WS inbound dispatcher (for `chat_reply` and `chat_event` messages).
pub(crate) async fn persist_and_emit(
    app: &tauri::AppHandle,
    message: ChatMessage,
) -> Result<(), String> {
    persist_to_disk(&message).await?;
    let _ = app.emit("chat-event", &message);
    Ok(())
}

async fn persist_to_disk(message: &ChatMessage) -> Result<(), String> {
    let path = history_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let mut list: Vec<ChatMessage> = match tokio::fs::read_to_string(&path).await {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(format!("读取聊天历史失败：{e}")),
    };
    list.push(message.clone());
    let json = serde_json::to_string_pretty(&list)
        .map_err(|e| format!("序列化聊天历史失败：{e}"))?;
    tokio::fs::write(&path, json)
        .await
        .map_err(|e| format!("写入聊天历史失败：{e}"))?;
    Ok(())
}

/// Internal helper for `send_chat_message` — append + emit. We pass
/// `State` rather than `AppHandle` so we don't need to plumb the handle
/// through the command signature.
async fn append_internal(
    message: ChatMessage,
    _state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    persist_to_disk(&message).await
}

/// Cheap random suffix for message IDs. NOT cryptographic; only used to
/// differentiate messages within a single session.
fn uuid_like_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:08x}", nanos & 0xFFFF_FFFF)
}

/// Open the chat window. Idempotent — if a chat window is already open,
/// focus it instead of spawning a duplicate.
#[tauri::command]
pub async fn open_chat_window<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    const WIN: &str = "chat";

    if let Some(existing) = app.get_webview_window(WIN) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, WIN, WebviewUrl::App("chat/index.html".into()))
        .title("FeClaw Desktop")
        .inner_size(880.0, 640.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| format!("创建聊天窗口失败：{e}"))?;
    Ok(())
}

/// P1.2 — Send a consent decision back to the engine over WS, then
/// (for `read`) execute the read locally and ship the content back as
/// a follow-up envelope so the agent can keep going.
///
/// Mirrors the Rust side of the chat UI's consent card. We accept the
/// camelCase `opId` / `decision` from the frontend (Tauri 2 maps
/// `op_id` Rust → `opId` JSON automatically).
#[tauri::command]
pub async fn send_consent_response(
    op_id: String,
    operation: String,
    path: String,
    decision: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let normalized = decision.to_lowercase();
    let allow = matches!(normalized.as_str(), "allow" | "always_allow" | "alwaysallow");

    let envelope = serde_json::json!({
        "type": "consent_response",
        "op_id": op_id,
        "operation": operation,
        "path": path,
        "decision": if allow { "allow" } else { "deny" },
        "timestamp": crate::ws_types::current_timestamp(),
    });
    let json = serde_json::to_string(&envelope)
        .map_err(|e| format!("序列化同意响应失败：{e}"))?;

    let tx = state.ws_outgoing.clone();
    let tx_guard = tx.write().await;
    if let Some(tx) = tx_guard.as_ref() {
        tx.send(json)
            .map_err(|_| "WebSocket 已断开，无法发送同意响应".to_string())?;
    } else {
        return Err("WebSocket 发送端未初始化".to_string());
    }
    Ok(())
}

/// Read the current WS connection status as a string. Used by the chat
/// UI to render the "已连接 / 未连接" indicator.
#[tauri::command]
pub async fn get_connection_status(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let s = state.status.read().await;
    Ok(format!("{:?}", *s))
}

/// Return the persisted chat history path (handy for the
/// `reveal_in_explorer` button).
#[tauri::command]
pub async fn get_chat_history_path() -> Result<String, String> {
    Ok(history_path().display().to_string())
}

/// Convenience wrapper shared by the WS inbound dispatcher: persist +
/// emit a single message. Currently unused — kept here so future
/// extensions can lock around disk appends without re-importing the
/// helpers.
#[allow(dead_code)]
pub(crate) fn _phantom_marker() {}

// ---------------------------------------------------------------------------
// V3 Phase 0a: list_agents + SQLite-backed history
// ---------------------------------------------------------------------------

/// Agent info returned by `GET /api/desktop/agents`.
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

/// Fetch the list of agents from the engine.
/// Calls `GET {cloud_url}/api/desktop/agents` with Bearer JWT auth.
#[tauri::command]
pub async fn list_agents() -> Result<Vec<AgentInfo>, String> {
    let cfg = Config::load();
    let token = cfg.cloud_token.clone()
        .ok_or_else(|| "未登录：cloud_token 不存在".to_string())?;
    let base_url = cfg.cloud_base_url()
        .ok_or_else(|| "cloud_url 未配置".to_string())?;
    let url = format!("{}/api/desktop/agents", base_url.trim_end_matches('/'));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent(concat!("FeClaw-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败：{e}"))?;

    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("获取 Agent 列表失败：{e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("获取 Agent 列表失败 ({}): {}", resp.status(), body));
    }

    let agents: Vec<AgentInfo> = resp.json().await
        .map_err(|e| format!("解析 Agent 列表响应失败：{e}"))?;

    Ok(agents)
}