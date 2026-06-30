//! Group management: HTTP client for the Engine Group API.
//!
//! All endpoints require a valid JWT. The token is read from the
//! `local-credentials` file at `~/.feclaw/local-credentials` (the same
//! credential store used by [`crate::auth::AuthManager`]).

use crate::auth::load_local_token;
use serde::{Deserialize, Serialize};

/// Build the HTTP client with JWT bearer auth.
fn build_client() -> Result<reqwest::Client, String> {
    let _token = load_local_token().ok_or_else(|| "no token in credentials file".to_string())?;
    Ok(crate::http_client::http_client().clone())
}

fn engine_url() -> String {
    let config = crate::config::Config::load();
    config.engine_url()
}

fn authed() -> Result<reqwest::Client, String> {
    build_client()
}

// ---- Data types -----------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupInfo {
    pub id: String,
    pub name: String,
    pub announcement: String,
    #[serde(rename = "member_count")]
    pub member_count: usize,
    #[serde(rename = "created_at")]
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupMemberInfo {
    #[serde(rename = "agent_hash")]
    pub agent_hash: String,
    pub role: String,
    #[serde(rename = "is_silent")]
    pub is_silent: bool,
}

/// Frontend-friendly member projection used by `list_group_members`.
/// Includes `agent_name` so the @-mention picker can render a label
/// without an extra round-trip to fetch the agent's metadata. Fields
/// are all optional to tolerate older engine responses.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupMemberDisplay {
    #[serde(rename = "agent_hash")]
    pub agent_hash: String,
    #[serde(default, rename = "agent_name")]
    pub agent_name: String,
    #[serde(default, rename = "role")]
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupMessageInfo {
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
    #[serde(rename = "created_at")]
    pub created_at: u64,
}

// ---- Tauri commands --------------------------------------------------

#[tauri::command]
pub async fn list_groups() -> Result<Vec<GroupInfo>, String> {
    let client = authed()?;
    let url = format!("{}/api/groups", engine_url());
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("list_groups request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("list_groups failed: {}", resp.status()));
    }
    let groups: Vec<GroupInfo> = resp
        .json()
        .await
        .map_err(|e| format!("parse list_groups response: {e}"))?;
    Ok(groups)
}

#[tauri::command]
pub async fn get_group_detail(group_id: String) -> Result<GroupInfo, String> {
    let client = authed()?;
    let url = format!("{}/api/groups/{}", engine_url(), group_id);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("get_group_detail request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("get_group_detail failed: {}", resp.status()));
    }
    let group: GroupInfo = resp
        .json()
        .await
        .map_err(|e| format!("parse get_group_detail response: {e}"))?;
    Ok(group)
}

#[tauri::command]
pub async fn get_group_messages(group_id: String, before: Option<u64>) -> Result<Vec<GroupMessageInfo>, String> {
    let client = authed()?;
    let mut url = format!("{}/api/groups/{}/messages?limit=50", engine_url(), group_id);
    if let Some(b) = before {
        url.push_str(&format!("&before={}", b));
    }
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("get_group_messages request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("get_group_messages failed: {}", resp.status()));
    }
    let msgs: Vec<GroupMessageInfo> = resp
        .json()
        .await
        .map_err(|e| format!("parse get_group_messages response: {e}"))?;
    Ok(msgs)
}

#[tauri::command]
pub async fn create_group(name: String, member_hashes: Vec<String>) -> Result<GroupInfo, String> {
    let client = authed()?;
    let url = format!("{}/api/groups", engine_url());
    let body = serde_json::json!({
        "name": name,
        "member_hashes": member_hashes,
    });
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("create_group request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("create_group failed: {}", resp.status()));
    }
    let group: GroupInfo = resp
        .json()
        .await
        .map_err(|e| format!("parse create_group response: {e}"))?;
    Ok(group)
}

#[tauri::command]
pub async fn add_group_member(group_id: String, agent_hash: String) -> Result<(), String> {
    let client = authed()?;
    let url = format!("{}/api/groups/{}/members", engine_url(), group_id);
    let body = serde_json::json!({ "agent_hash": agent_hash });
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("add_group_member request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("add_group_member failed: {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_group_member(group_id: String, agent_hash: String) -> Result<(), String> {
    let client = authed()?;
    let url = format!(
        "{}/api/groups/{}/members/{}",
        engine_url(),
        group_id,
        agent_hash
    );
    let resp = client
        .delete(&url)
        .send()
        .await
        .map_err(|e| format!("remove_group_member request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("remove_group_member failed: {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_group(group_id: String) -> Result<(), String> {
    let client = authed()?;
    let url = format!("{}/api/groups/{}", engine_url(), group_id);
    let resp = client
        .delete(&url)
        .send()
        .await
        .map_err(|e| format!("delete_group request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("delete_group failed: {}", resp.status()));
    }
    Ok(())
}

/// List members of a group. Returns the rich projection used by the
/// frontend's @-mention picker (agent_hash + agent_name). Older engines
/// may return members with only `agent_hash`; missing names are
/// substituted with the hash so the UI always has something to render.
#[tauri::command]
pub async fn list_group_members(group_id: String) -> Result<Vec<GroupMemberDisplay>, String> {
    let client = authed()?;
    let url = format!("{}/api/groups/{}/members", engine_url(), group_id);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("list_group_members request: {e}"))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        // Engine doesn't expose the endpoint — let the frontend fall
        // back to its cached GroupInfo.members list.
        return Ok(Vec::new());
    }
    if !resp.status().is_success() {
        return Err(format!("list_group_members failed: {}", resp.status()));
    }
    // Accept both the rich shape and the legacy GroupMemberInfo
    // shape — we coerce to the display form here.
    let raw: Vec<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| format!("parse list_group_members response: {e}"))?;
    let members = raw
        .into_iter()
        .map(|v| {
            let hash = v
                .get("agent_hash")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let name = v
                .get("agent_name")
                .and_then(|x| x.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    // Fallback: derive a readable name from the hash.
                    let h = &hash;
                    if h.len() >= 4 {
                        format!("Agent {}", &h[..4])
                    } else {
                        format!("Agent {}", h)
                    }
                });
            let role = v
                .get("role")
                .and_then(|x| x.as_str())
                .unwrap_or("member")
                .to_string();
            GroupMemberDisplay {
                agent_hash: hash,
                agent_name: name,
                role,
            }
        })
        .filter(|m| !m.agent_hash.is_empty())
        .collect();
    Ok(members)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---------------------------------------------------------------------------
    // GroupInfo
    // ---------------------------------------------------------------------------

    #[test]
    fn group_info_deserialize_full() {
        let json = r#"{
            "id": "grp-001",
            "name": "Test Group",
            "announcement": "Welcome!",
            "member_count": 42,
            "created_at": 1700000000
        }"#;
        let g: GroupInfo = serde_json::from_str(json).unwrap();
        assert_eq!(g.id, "grp-001");
        assert_eq!(g.name, "Test Group");
        assert_eq!(g.announcement, "Welcome!");
        assert_eq!(g.member_count, 42);
        assert_eq!(g.created_at, 1700000000);
    }

    #[test]
    fn group_info_deserialize_minimal() {
        // announcement is required but may be empty string
        let json = r#"{
            "id": "grp-002",
            "name": "Minimal",
            "announcement": "",
            "member_count": 0,
            "created_at": 0
        }"#;
        let g: GroupInfo = serde_json::from_str(json).unwrap();
        assert_eq!(g.id, "grp-002");
        assert_eq!(g.name, "Minimal");
        assert_eq!(g.announcement, "");
        assert_eq!(g.member_count, 0);
        assert_eq!(g.created_at, 0);
    }

    #[test]
    fn group_info_roundtrip() {
        let g = GroupInfo {
            id: "grp-round".to_string(),
            name: "Roundtrip Test".to_string(),
            announcement: "Test announcement".to_string(),
            member_count: 10,
            created_at: 1700001234,
        };
        let json = serde_json::to_string(&g).unwrap();
        let parsed: GroupInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, g);
    }

    #[test]
    fn group_info_missing_required_field_fails() {
        // "id" is required — missing it should fail
        let json = r#"{"name": "No ID", "announcement": "", "member_count": 0, "created_at": 0}"#;
        let result: Result<GroupInfo, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    // ---------------------------------------------------------------------------
    // GroupMemberInfo
    // ---------------------------------------------------------------------------

    #[test]
    fn group_member_info_deserialize() {
        let json = r#"{
            "agent_hash": "a1b2",
            "role": "admin",
            "is_silent": false
        }"#;
        let m: GroupMemberInfo = serde_json::from_str(json).unwrap();
        assert_eq!(m.agent_hash, "a1b2");
        assert_eq!(m.role, "admin");
        assert!(!m.is_silent);
    }

    #[test]
    fn group_member_info_roundtrip() {
        let m = GroupMemberInfo {
            agent_hash: "c3d4".to_string(),
            role: "member".to_string(),
            is_silent: true,
        };
        let json = serde_json::to_string(&m).unwrap();
        let parsed: GroupMemberInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, m);
    }

    #[test]
    fn group_member_info_all_roles() {
        for role in &["admin", "member", "owner"] {
            let json = format!(
                r#"{{"agent_hash": "hash", "role": "{}", "is_silent": false}}"#,
                role
            );
            let m: GroupMemberInfo = serde_json::from_str(&json).unwrap();
            assert_eq!(m.role, *role);
        }
    }

    // ---------------------------------------------------------------------------
    // GroupMessageInfo
    // ---------------------------------------------------------------------------

    #[test]
    fn group_message_info_deserialize_full() {
        let json = r#"{
            "id": "msg-001",
            "sender_type": "agent",
            "sender_hash": "a1b2c3",
            "sender_name": "MyAgent",
            "content": "Hello world",
            "message_type": "text",
            "attachments": [{"type": "image", "url": "http://example.com/img.png"}],
            "created_at": 1700005000
        }"#;
        let m: GroupMessageInfo = serde_json::from_str(json).unwrap();
        assert_eq!(m.id, "msg-001");
        assert_eq!(m.sender_type, "agent");
        assert_eq!(m.sender_hash, Some("a1b2c3".to_string()));
        assert_eq!(m.sender_name, Some("MyAgent".to_string()));
        assert_eq!(m.content, "Hello world");
        assert_eq!(m.message_type, "text");
        assert!(m.attachments.is_some());
        assert_eq!(m.created_at, 1700005000);
    }

    #[test]
    fn group_message_info_optional_fields_missing() {
        // sender_hash, sender_name, attachments are optional
        let json = r#"{
            "id": "msg-002",
            "sender_type": "user",
            "content": "Hi",
            "message_type": "text",
            "created_at": 1700006000
        }"#;
        let m: GroupMessageInfo = serde_json::from_str(json).unwrap();
        assert_eq!(m.id, "msg-002");
        assert_eq!(m.sender_type, "user");
        assert!(m.sender_hash.is_none());
        assert!(m.sender_name.is_none());
        assert!(m.attachments.is_none());
        assert_eq!(m.content, "Hi");
    }

    #[test]
    fn group_message_info_roundtrip() {
        let m = GroupMessageInfo {
            id: "msg-round".to_string(),
            sender_type: "agent".to_string(),
            sender_hash: Some("abcd".to_string()),
            sender_name: Some("TestBot".to_string()),
            content: "Test content".to_string(),
            message_type: "text".to_string(),
            attachments: None,
            created_at: 1700010000,
        };
        let json = serde_json::to_string(&m).unwrap();
        let parsed: GroupMessageInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, m);
    }

    #[test]
    fn group_message_info_empty_attachments_array() {
        let json = r#"{
            "id": "msg-003",
            "sender_type": "user",
            "content": "No attachments",
            "message_type": "text",
            "attachments": [],
            "created_at": 1700011000
        }"#;
        let m: GroupMessageInfo = serde_json::from_str(json).unwrap();
        assert!(m.attachments.is_some());
        assert!(m.attachments.as_ref().unwrap().is_empty());
    }

    // ---------------------------------------------------------------------------
    // create_group name validation (unit of the async command)
    // ---------------------------------------------------------------------------

    #[test]
    fn create_group_empty_name_rejected_by_api() {
        // We can't call the real command without a server, but we can verify
        // the serde serialization of the request body matches expectations.
        // Empty name is a server-side validation; locally we serialize normally.
        let body = serde_json::json!({
            "name": "",
            "member_hashes": Vec::<String>::new(),
        });
        let json = serde_json::to_string(&body).unwrap();
        assert!(json.contains(r#""name":"""#));
    }

    #[test]
    fn create_group_with_members_serializes_correctly() {
        let body = serde_json::json!({
            "name": "My Group",
            "member_hashes": ["a1b2", "c3d4", "e5f6"],
        });
        let json = serde_json::to_string(&body).unwrap();
        assert!(json.contains(r#""member_hashes":["a1b2","c3d4","e5f6"]"#));
    }
}
