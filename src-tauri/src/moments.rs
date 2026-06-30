//! Moments (群广场) API client.
//!
//! Calls the Engine's `/api/user/moments` endpoints to fetch, create,
//! and delete moment posts.

use crate::auth::load_local_token;
use crate::config::Config;
use serde::{Deserialize, Serialize};

fn engine_url() -> String {
    let config = Config::load();
    config.engine_url()
}

/// Load the shared HTTP client and the local JWT token together.
///
/// Returns a `(client, token)` pair that every command must use together;
/// each outbound request below attaches `Authorization: Bearer …` via the
/// token. (Renamed from `authed()` which previously returned a client
/// but discarded the token, leading to unauthenticated requests.)
fn load_client_with_token() -> Result<(reqwest::Client, String), String> {
    let token = load_local_token().ok_or_else(|| "no token in credentials file".to_string())?;
    Ok((crate::http_client::http_client().clone(), token))
}

// ---- Data types -----------------------------------------------------

/// A single moment post.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MomentInfo {
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

/// Request body for posting a new moment.
#[derive(Debug, Serialize)]
struct PostMomentRequest {
    group_id: String,
    title: String,
    content: String,
}

// ---- Tauri commands --------------------------------------------------

/// Fetch moments, optionally filtered by group_id.
#[tauri::command]
pub async fn get_moments(group_id: Option<String>) -> Result<Vec<MomentInfo>, String> {
    let (client, token) = load_client_with_token()?;
    let mut url = format!("{}/api/user/moments", engine_url());
    if let Some(ref gid) = group_id {
        url.push_str(&format!("?group_id={}", gid));
    }
    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("get_moments request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("get_moments failed: {}", resp.status()));
    }
    let moments: Vec<MomentInfo> = resp
        .json()
        .await
        .map_err(|e| format!("parse get_moments response: {e}"))?;
    Ok(moments)
}

/// Post a new moment to a group.
#[tauri::command]
pub async fn post_moment(group_id: String, title: String, content: String) -> Result<(), String> {
    let (client, token) = load_client_with_token()?;
    let url = format!("{}/api/user/moments", engine_url());
    let body = PostMomentRequest {
        group_id,
        title,
        content,
    };
    let resp = client
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("post_moment request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("post_moment failed: {}", resp.status()));
    }
    Ok(())
}

/// Delete a moment.
#[tauri::command]
pub async fn delete_moment(group_id: String, moment_id: String) -> Result<(), String> {
    let (client, token) = load_client_with_token()?;
    let url = format!("{}/api/groups/{}/moments/{}", engine_url(), group_id, moment_id);
    let resp = client
        .delete(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("delete_moment request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("delete_moment failed: {}", resp.status()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---------------------------------------------------------------------------
    // MomentInfo — struct derives
    // ---------------------------------------------------------------------------

    #[test]
    fn moment_info_debug() {
        let m = MomentInfo {
            id: "moment-001".to_string(),
            group_id: "grp-001".to_string(),
            group_name: Some("My Group".to_string()),
            agent_hash: Some("a1b2".to_string()),
            agent_name: Some("TestBot".to_string()),
            kind: "post".to_string(),
            title: "Test Title".to_string(),
            content: "Test content body".to_string(),
            attachments: vec![],
            created_at: 1700000000,
        };
        let debug = format!("{:?}", m);
        assert!(debug.contains("moment-001"));
        assert!(debug.contains("Test Title"));
    }

    #[test]
    fn moment_info_clone() {
        let m = MomentInfo {
            id: "moment-clone".to_string(),
            group_id: "grp-001".to_string(),
            group_name: None,
            agent_hash: None,
            agent_name: None,
            kind: "post".to_string(),
            title: "Clone Test".to_string(),
            content: "Content".to_string(),
            attachments: vec![],
            created_at: 1700000000,
        };
        let _cloned = m.clone();
        assert_eq!(cloned.id, "moment-clone");
    }

    // ---------------------------------------------------------------------------
    // MomentInfo — full deserialization
    // ---------------------------------------------------------------------------

    #[test]
    fn moment_info_deserialize_full() {
        let json = r#"{
            "id": "moment-001",
            "group_id": "grp-001",
            "group_name": "My Group",
            "agent_hash": "a1b2c3",
            "agent_name": "TestBot",
            "kind": "post",
            "title": "Hello World",
            "content": "This is a moment post",
            "attachments": [{"type": "image", "url": "http://example.com/img.png"}],
            "created_at": 1700001234
        }"#;
        let m: MomentInfo = serde_json::from_str(json).unwrap();
        assert_eq!(m.id, "moment-001");
        assert_eq!(m.group_id, "grp-001");
        assert_eq!(m.group_name, Some("My Group".to_string()));
        assert_eq!(m.agent_hash, Some("a1b2c3".to_string()));
        assert_eq!(m.agent_name, Some("TestBot".to_string()));
        assert_eq!(m.kind, "post");
        assert_eq!(m.title, "Hello World");
        assert_eq!(m.content, "This is a moment post");
        assert_eq!(m.attachments.len(), 1);
        assert_eq!(m.created_at, 1700001234);
    }

    // ---------------------------------------------------------------------------
    // MomentInfo — missing / empty fields (defaults applied)
    // ---------------------------------------------------------------------------

    #[test]
    fn moment_info_missing_optionals() {
        // group_name, agent_hash, agent_name default to None
        // attachments defaults to []
        let json = r#"{
            "id": "moment-min",
            "group_id": "grp-002",
            "kind": "post",
            "title": "Minimal",
            "content": "No optionals",
            "created_at": 1700002000
        }"#;
        let m: MomentInfo = serde_json::from_str(json).unwrap();
        assert_eq!(m.id, "moment-min");
        assert!(m.group_name.is_none());
        assert!(m.agent_hash.is_none());
        assert!(m.agent_name.is_none());
        assert!(m.attachments.is_empty());
    }

    #[test]
    fn moment_info_empty_title_and_content() {
        // Empty strings are valid strings, not None
        let json = r#"{
            "id": "moment-empty",
            "group_id": "grp-003",
            "kind": "post",
            "title": "",
            "content": "",
            "created_at": 0
        }"#;
        let m: MomentInfo = serde_json::from_str(json).unwrap();
        assert_eq!(m.title, "");
        assert_eq!(m.content, "");
    }

    #[test]
    fn moment_info_empty_attachments_array() {
        let json = r#"{
            "id": "moment-no-attach",
            "group_id": "grp-001",
            "kind": "post",
            "title": "No Attachments",
            "content": "Body",
            "attachments": [],
            "created_at": 1700003000
        }"#;
        let m: MomentInfo = serde_json::from_str(json).unwrap();
        assert!(m.attachments.is_empty());
    }

    #[test]
    fn moment_info_various_kinds() {
        for kind in &["post", "image", "video", "link"] {
            let json = format!(
                r#"{{"id": "m{}", "group_id": "g", "kind": "{}", "title": "T", "content": "C", "created_at": 1}}"#,
                kind,
                kind
            );
            let m: MomentInfo = serde_json::from_str(&json).unwrap();
            assert_eq!(m.kind, *kind);
        }
    }

    // ---------------------------------------------------------------------------
    // MomentInfo — JSON round-trip
    // ---------------------------------------------------------------------------

    #[test]
    fn moment_info_roundtrip() {
        let m = MomentInfo {
            id: "moment-round".to_string(),
            group_id: "grp-round".to_string(),
            group_name: Some("Round Group".to_string()),
            agent_hash: Some("abcd".to_string()),
            agent_name: Some("RoundBot".to_string()),
            kind: "post".to_string(),
            title: "Roundtrip Title".to_string(),
            content: "Roundtrip content".to_string(),
            attachments: vec![serde_json::json!({"type": "image"})],
            created_at: 1700010000,
        };
        let json = serde_json::to_string(&m).unwrap();
        let parsed: MomentInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, m.id);
        assert_eq!(parsed.group_id, m.group_id);
        assert_eq!(parsed.group_name, m.group_name);
        assert_eq!(parsed.agent_hash, m.agent_hash);
        assert_eq!(parsed.title, m.title);
        assert_eq!(parsed.content, m.content);
        assert_eq!(parsed.attachments.len(), 1);
        assert_eq!(parsed.created_at, m.created_at);
    }

    #[test]
    fn moment_info_roundtrip_no_optionals() {
        let m = MomentInfo {
            id: "moment-round-min".to_string(),
            group_id: "grp-min".to_string(),
            group_name: None,
            agent_hash: None,
            agent_name: None,
            kind: "post".to_string(),
            title: "Min Title".to_string(),
            content: "Min content".to_string(),
            attachments: vec![],
            created_at: 0,
        };
        let json = serde_json::to_string(&m).unwrap();
        let parsed: MomentInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, m);
    }

    // ---------------------------------------------------------------------------
    // MomentInfo — missing required fields
    // ---------------------------------------------------------------------------

    #[test]
    fn moment_info_missing_id_fails() {
        let json = r#"{"group_id": "g", "kind": "p", "title": "T", "content": "C", "created_at": 1}"#;
        let result: Result<MomentInfo, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn moment_info_missing_group_id_fails() {
        let json = r#"{"id": "m", "kind": "p", "title": "T", "content": "C", "created_at": 1}"#;
        let result: Result<MomentInfo, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    // ---------------------------------------------------------------------------
    // PostMomentRequest — serialize
    // ---------------------------------------------------------------------------

    #[test]
    fn post_moment_request_serialize() {
        let req = PostMomentRequest {
            group_id: "grp-001".to_string(),
            title: "My Title".to_string(),
            content: "My content".to_string(),
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains(r#""group_id":"grp-001""#));
        assert!(json.contains(r#""title":"My Title""#));
        assert!(json.contains(r#""content":"My content""#));
    }
}
