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

/// Returns current timestamp as Unix epoch seconds string.
pub fn current_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default()
}

/// Inbound group message from the engine.
#[derive(Debug, Deserialize, Serialize)]
pub struct GroupMessagePayload {
    pub id: String,
    #[serde(rename = "sender_type")]
    pub sender_type: String,
    #[serde(rename = "sender_hash")]
    pub sender_hash: Option<String>,
    #[serde(rename = "sender_name")]
    pub sender_name: Option<String>,
    pub content: String,
    #[serde(rename = "message_type")]
    pub message_type: String,
    pub attachments: Option<Vec<serde_json::Value>>,
    pub round: Option<u32>,
    #[serde(rename = "is_tail")]
    pub is_tail: Option<bool>,
    pub timestamp: Option<u64>,
}

/// Inbound group event (member joined/left/renamed).
#[derive(Debug, Deserialize)]
pub struct GroupEventPayload {
    pub event: String,
    pub data: Option<serde_json::Value>,
}

/// Group info update payload.
#[derive(Debug, Deserialize, Serialize)]
pub struct GroupUpdatedPayload {
    pub id: String,
    pub name: Option<String>,
    pub announcement: Option<String>,
    #[serde(rename = "member_count")]
    pub member_count: Option<usize>,
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
        timestamp: Option<String>,
        #[serde(default)]
        payload: CommandExecPayload,
    },
    #[serde(rename = "file_read_request")]
    FileRead {
        id: String,
        #[serde(default)]
        timestamp: Option<String>,
        payload: FileReadPayload,
    },
    #[serde(rename = "file_write_request")]
    FileWrite {
        id: String,
        #[serde(default)]
        timestamp: Option<String>,
        payload: FileWritePayload,
    },
    #[serde(rename = "file_delete_request")]
    FileDelete {
        id: String,
        #[serde(default)]
        timestamp: Option<String>,
        payload: FileDeletePayload,
    },
    #[serde(rename = "notification")]
    Notification {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        timestamp: Option<String>,
        payload: NotificationPayload,
    },
    #[serde(rename = "pong")]
    Pong,
    // ---- P0.6: chat protocol -------------------------------------
    /// Agent / engine reply to a `chat_message` sent earlier.
    #[serde(rename = "chat_reply")]
    ChatReply {
        id: String,
        text: String,
        #[serde(default)]
        agent: Option<String>,
        #[serde(default)]
        timestamp: Option<String>,
    },
    /// Streaming event (thinking, tool call, tool result, done, …).
    /// The frontend renders these inline with the reply text.
    #[serde(rename = "chat_event")]
    ChatEvent {
        id: String,
        kind: String,
        #[serde(default)]
        data: Option<serde_json::Value>,
        #[serde(default)]
        timestamp: Option<String>,
    },
    /// Inline file-operation consent request (P1.2). Sent by the
    /// server when the agent wants to read/write/delete a file on the
    /// user's desktop. The desktop surfaces it inside the chat window
    /// and replies with a `consent_response` envelope.
    #[serde(rename = "file_operation_request")]
    FileOperationRequest {
        op_id: String,
        operation: String,
        path: String,
        #[serde(default)]
        level: Option<u8>,
        #[serde(default)]
        reason: Option<String>,
        #[serde(default)]
        timestamp: Option<String>,
    },
    /// Inbound group message (engine → desktop).
    #[serde(rename = "group_message")]
    GroupMessage {
        #[serde(rename = "group_id")]
        group_id: String,
        message: GroupMessagePayload,
    },
    /// Inbound group event notification (member joined/left/renamed).
    #[serde(rename = "group_event")]
    GroupEvent {
        #[serde(rename = "group_id")]
        group_id: String,
        event: String,
        #[serde(default)]
        data: Option<serde_json::Value>,
    },
    /// Inbound group info update.
    #[serde(rename = "group_updated")]
    GroupUpdated {
        #[serde(rename = "group_id")]
        group_id: String,
        #[serde(default)]
        data: Option<GroupUpdatedPayload>,
    },
    /// Inbound moment event (new moment posted).
    #[serde(rename = "moments_event")]
    MomentsEvent {
        #[serde(rename = "group_id")]
        group_id: String,
        #[serde(default)]
        data: Option<MomentEventPayload>,
    },
    /// Phone completed QR upload (server → desktop).
    #[serde(rename = "upload_complete")]
    UploadComplete {
        #[serde(rename = "session_id")]
        session_id: String,
        #[serde(rename = "presigned_get_url")]
        presigned_get_url: String,
        #[serde(rename = "file_name")]
        file_name: Option<String>,
        #[serde(rename = "mime_type")]
        mime_type: Option<String>,
    },
}

/// Payload inside a `moments_event` WS message.
#[derive(Debug, Deserialize, Serialize)]
pub struct MomentEventPayload {
    pub id: String,
    #[serde(rename = "group_id")]
    pub group_id: String,
    #[serde(rename = "group_name", default)]
    pub group_name: Option<String>,
    #[serde(rename = "agent_hash", default)]
    pub agent_hash: Option<String>,
    #[serde(rename = "agent_name", default)]
    pub agent_name: Option<String>,
    pub kind: String,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub attachments: Vec<serde_json::Value>,
    #[serde(rename = "created_at")]
    pub created_at: u64,
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
pub struct FileDeletePayload {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct NotificationPayload {
    pub title: Option<String>,
    pub body: String,
}

/// Outbound response to a `command_exec_request`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CommandExecResponse {
    pub id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub payload: CommandExecPayloadOut,
}

/// Payload inside [`CommandExecResponse`].
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct CommandExecPayloadOut {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Outbound response to a `file_read_request`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileReadResponse {
    pub id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub payload: FileReadResponsePayload,
}

/// Payload inside [`FileReadResponse`].
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FileReadResponsePayload {
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Outbound response to a `file_write_request` (V2 file bridge).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileWriteResponse {
    pub id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub payload: FileWriteResponsePayload,
}

/// Payload inside [`FileWriteResponse`].
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FileWriteResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_length: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}

/// Outbound response to a `file_delete_request` (V2 file bridge).
/// Kept for protocol completeness; MVP returns error.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileDeleteResponse {
    pub id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub payload: FileDeleteResponsePayload,
}

/// Payload inside [`FileDeleteResponse`].
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FileDeleteResponsePayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Outbound consent response — independent consent channel (V2, not yet used).
/// V1 still merges decisions into command_exec_response.reason.
/// Defined here for protocol completeness per design §4.3.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConsentResponse {
    pub id: String,
    pub decision: ConsentDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Decision values for [`ConsentResponse`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ConsentDecision {
    Allow,
    Deny,
    AlwaysAllow,
}

/// Outbound: send a message to a group via WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsSendGroupMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(rename = "group_id")]
    pub group_id: String,
    pub content: String,
    #[serde(default)]
    pub mentions: Option<Vec<String>>,
    #[serde(default)]
    pub attachments: Option<Vec<serde_json::Value>>,
}

impl Default for WsSendGroupMessage {
    fn default() -> Self {
        Self {
            msg_type: "send_group_message".to_string(),
            group_id: String::new(),
            content: String::new(),
            mentions: None,
            attachments: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- WsRequest deserialization ---

    #[test]
    fn deserialize_command_exec_request() {
        let json = r#"{
            "type": "command_exec_request",
            "id": "req-001",
            "payload": {
                "command": "echo",
                "args": ["hello", "world"],
                "cwd": "/tmp",
                "timeout": 30
            }
        }"#;
        let req: WsRequest = serde_json::from_str(json).unwrap();
        match req {
            WsRequest::CommandExec { id, payload } => {
                assert_eq!(id, "req-001");
                assert_eq!(payload.command, "echo");
                assert_eq!(payload.args, &["hello", "world"]);
                assert_eq!(payload.cwd, Some("/tmp".to_string()));
                assert_eq!(payload.timeout, Some(30));
            }
            _ => panic!("expected CommandExec"),
        }
    }

    #[test]
    fn deserialize_command_exec_request_minimal() {
        // Only required fields; defaults applied for missing optional fields.
        let json = r#"{
            "type": "command_exec_request",
            "id": "req-002",
            "payload": { "command": "ls" }
        }"#;
        let req: WsRequest = serde_json::from_str(json).unwrap();
        match req {
            WsRequest::CommandExec { id, payload } => {
                assert_eq!(id, "req-002");
                assert_eq!(payload.command, "ls");
                assert!(payload.args.is_empty());
                assert!(payload.cwd.is_none());
                assert!(payload.timeout.is_none());
            }
            _ => panic!("expected CommandExec"),
        }
    }

    #[test]
    fn deserialize_command_exec_request_extra_fields() {
        // serde ignores unknown fields by default.
        let json = r#"{
            "type": "command_exec_request",
            "id": "req-003",
            "payload": { "command": "echo", "extra": "ignored" },
            "unknown_field": 123
        }"#;
        let req: WsRequest = serde_json::from_str(json).unwrap();
        match req {
            WsRequest::CommandExec { id, payload } => {
                assert_eq!(id, "req-003");
                assert_eq!(payload.command, "echo");
            }
            _ => panic!("expected CommandExec"),
        }
    }

    #[test]
    fn deserialize_file_read_request() {
        let json = r#"{
            "type": "file_read_request",
            "id": "fr-001",
            "payload": { "path": "/etc/hosts" }
        }"#;
        let req: WsRequest = serde_json::from_str(json).unwrap();
        match req {
            WsRequest::FileRead { id, payload } => {
                assert_eq!(id, "fr-001");
                assert_eq!(payload.path, "/etc/hosts");
            }
            _ => panic!("expected FileRead"),
        }
    }

    #[test]
    fn deserialize_file_write_request() {
        let json = r#"{
            "type": "file_write_request",
            "id": "fw-001",
            "payload": { "path": "/tmp/out.txt", "content": "hello" }
        }"#;
        let req: WsRequest = serde_json::from_str(json).unwrap();
        match req {
            WsRequest::FileWrite { id, payload } => {
                assert_eq!(id, "fw-001");
                assert_eq!(payload.path, "/tmp/out.txt");
                assert_eq!(payload.content, "hello");
            }
            _ => panic!("expected FileWrite"),
        }
    }

    #[test]
    fn deserialize_notification() {
        let json = r#"{
            "type": "notification",
            "id": "notif-001",
            "payload": { "title": "Done", "body": "Task completed" }
        }"#;
        let req: WsRequest = serde_json::from_str(json).unwrap();
        match req {
            WsRequest::Notification { id, payload } => {
                assert_eq!(id, Some("notif-001".to_string()));
                assert_eq!(payload.title, Some("Done".to_string()));
                assert_eq!(payload.body, "Task completed");
            }
            _ => panic!("expected Notification"),
        }
    }

    #[test]
    fn deserialize_notification_minimal() {
        // title is optional
        let json = r#"{
            "type": "notification",
            "payload": { "body": "Just a body" }
        }"#;
        let req: WsRequest = serde_json::from_str(json).unwrap();
        match req {
            WsRequest::Notification { id, payload } => {
                assert!(id.is_none());
                assert!(payload.title.is_none());
                assert_eq!(payload.body, "Just a body");
            }
            _ => panic!("expected Notification"),
        }
    }

    #[test]
    fn deserialize_pong() {
        let json = r#"{"type": "pong"}"#;
        let req: WsRequest = serde_json::from_str(json).unwrap();
        match req {
            WsRequest::Pong => {}
            _ => panic!("expected Pong"),
        }
    }

    #[test]
    fn deserialize_file_delete_request() {
        let json = r#"{
            "type": "file_delete_request",
            "id": "fd-001",
            "payload": { "path": "/tmp/garbage.txt" }
        }"#;
        let req: WsRequest = serde_json::from_str(json).unwrap();
        match req {
            WsRequest::FileDelete { id, payload } => {
                assert_eq!(id, "fd-001");
                assert_eq!(payload.path, "/tmp/garbage.txt");
            }
            _ => panic!("expected FileDelete"),
        }
    }

    #[test]
    fn deserialize_missing_type_field_fails() {
        let json = r#"{"id": "x", "payload": {}}"#;
        let result: Result<WsRequest, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    // --- CommandExecResponse round-trip ---

    #[test]
    fn command_exec_response_roundtrip() {
        let resp = CommandExecResponse {
            id: "req-001".to_string(),
            status: "accepted".to_string(),
            payload: CommandExecPayloadOut {
                stdout: "hello\n".to_string(),
                stderr: "".to_string(),
                exit_code: 0,
                reason: None,
            },
        };
        let json = serde_json::to_string(&resp).unwrap();
        let parsed: CommandExecResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, resp);
    }

    #[test]
    fn command_exec_response_with_reason() {
        let json = r#"{
            "id": "req-002",
            "status": "rejected",
            "payload": { "reason": "denied by user" }
        }"#;
        let resp: CommandExecResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.id, "req-002");
        assert_eq!(resp.status, "rejected");
        assert_eq!(resp.payload.reason, Some("denied by user".to_string()));
    }

    // --- FileReadResponse round-trip ---

    #[test]
    fn file_read_response_roundtrip() {
        let resp = FileReadResponse {
            id: "fr-001".to_string(),
            status: "ok".to_string(),
            payload: FileReadResponsePayload {
                content: Some("file contents".to_string()),
                error: None,
            },
        };
        let json = serde_json::to_string(&resp).unwrap();
        let parsed: FileReadResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, resp);
    }

    #[test]
    fn file_read_response_error() {
        let json = r#"{
            "id": "fr-002",
            "status": "error",
            "payload": { "error": "file bridge not implemented in MVP" }
        }"#;
        let resp: FileReadResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.id, "fr-002");
        assert_eq!(resp.status, "error");
        assert_eq!(
            resp.payload.error,
            Some("file bridge not implemented in MVP".to_string())
        );
        assert!(resp.payload.content.is_none());
    }

    // --- FileWriteResponse round-trip ---

    #[test]
    fn file_write_response_success_roundtrip() {
        let resp = FileWriteResponse {
            id: "fw-001".to_string(),
            status: "ok".to_string(),
            timestamp: Some("1700000000".to_string()),
            payload: FileWriteResponsePayload {
                success: true,
                error: None,
                content_length: Some(42),
                hash: Some("sha256:deadbeef".to_string()),
            },
        };
        let json = serde_json::to_string(&resp).unwrap();
        let parsed: FileWriteResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, resp);
    }

    #[test]
    fn file_write_response_error_roundtrip() {
        let json = r#"{
            "id": "fw-002",
            "status": "error",
            "payload": { "success": false, "error": "permission denied" }
        }"#;
        let resp: FileWriteResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.id, "fw-002");
        assert_eq!(resp.status, "error");
        assert!(!resp.payload.success);
        assert_eq!(resp.payload.error, Some("permission denied".to_string()));
        assert!(resp.payload.content_length.is_none());
        assert!(resp.payload.hash.is_none());
    }

    // --- FileDeleteResponse round-trip ---

    #[test]
    fn file_delete_response_error() {
        let json = r#"{
            "id": "fd-001",
            "status": "error",
            "payload": { "error": "file bridge not implemented in MVP" }
        }"#;
        let resp: FileDeleteResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.id, "fd-001");
        assert_eq!(resp.status, "error");
        assert_eq!(
            resp.payload.error,
            Some("file bridge not implemented in MVP".to_string())
        );
    }

    // --- ConsentResponse round-trip ---

    #[test]
    fn consent_response_roundtrip() {
        let resp = ConsentResponse {
            id: "consent-001".to_string(),
            decision: ConsentDecision::Allow,
            reason: None,
        };
        let json = serde_json::to_string(&resp).unwrap();
        let parsed: ConsentResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, resp);
    }

    #[test]
    fn consent_response_with_reason() {
        let resp = ConsentResponse {
            id: "consent-002".to_string(),
            decision: ConsentDecision::Deny,
            reason: Some("risky command".to_string()),
        };
        let json = serde_json::to_string(&resp).unwrap();
        let parsed: ConsentResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "consent-002");
        assert_eq!(parsed.decision, ConsentDecision::Deny);
        assert_eq!(parsed.reason, Some("risky command".to_string()));
    }
}
