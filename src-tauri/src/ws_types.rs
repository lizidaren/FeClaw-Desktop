//! Wire-format types shared between the WebSocket client and any future
//! producer/consumer. Lifted out of `ws.rs` so PR 3 can compile the WS
//! transport without depending on the consent/executor types added in
//! PR 4.

use serde::{Deserialize, Serialize};

/// Connection state surfaced to the UI / tray.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Failed,
}

/// Inbound message envelope from the engine/agent. PR 4 will add a real
/// dispatcher that handles `CommandExec`.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum WsRequest {
    #[serde(rename = "command_exec_request")]
    CommandExec {
        id: String,
        #[serde(default)]
        payload: CommandExecPayload,
    },
    #[serde(rename = "file_read_request")]
    FileRead {
        id: String,
        payload: FileReadPayload,
    },
    #[serde(rename = "file_write_request")]
    FileWrite {
        id: String,
        payload: FileWritePayload,
    },
    #[serde(rename = "notification")]
    Notification {
        #[serde(default)]
        id: Option<String>,
        payload: NotificationPayload,
    },
    #[serde(rename = "pong")]
    Pong,
}

#[derive(Debug, Deserialize, Default)]
pub struct CommandExecPayload {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub timeout: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct FileReadPayload {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct FileWritePayload {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct NotificationPayload {
    pub title: Option<String>,
    pub body: String,
}
