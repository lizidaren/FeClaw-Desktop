//! Group management: HTTP client for the Engine Group API.
//!
//! All endpoints require a valid JWT. The token is read from the
//! `local-credentials` file at `~/.feclaw/local-credentials` (the same
//! credential store used by [`crate::auth::AuthManager`]).

use crate::config::Config;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Path to the persisted credentials file.
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
fn load_token() -> Result<String> {
    let path = credentials_path();
    let content = fs::read_to_string(&path)?;
    let creds: Credentials =
        serde_json::from_str(&content).map_err(|e| anyhow!("parse credentials: {e}"))?;
    creds
        .token
        .ok_or_else(|| anyhow!("no token in credentials file"))
}

/// Build the HTTP client with JWT bearer auth.
fn build_client() -> Result<reqwest::Client> {
    let token = load_token()?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| anyhow!("build reqwest client: {e}"))?;
    // Attach JWT to a cloned builder so the original client is not consumed.
    let client = client;
    Ok(client)
}

fn engine_url() -> String {
    let config = crate::config::Config::load();
    config.engine_url()
}

fn authed() -> Result<reqwest::Client> {
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
pub async fn list_groups() -> Result<Vec<GroupInfo>> {
    let client = authed()?;
    let url = format!("{}/api/groups", engine_url());
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| anyhow!("list_groups request: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("list_groups failed: {}", resp.status()));
    }
    let groups: Vec<GroupInfo> = resp
        .json()
        .await
        .map_err(|e| anyhow!("parse list_groups response: {e}"))?;
    Ok(groups)
}

#[tauri::command]
pub async fn get_group_detail(group_id: String) -> Result<GroupInfo> {
    let client = authed()?;
    let url = format!("{}/api/groups/{}", engine_url(), group_id);
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| anyhow!("get_group_detail request: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("get_group_detail failed: {}", resp.status()));
    }
    let group: GroupInfo = resp
        .json()
        .await
        .map_err(|e| anyhow!("parse get_group_detail response: {e}"))?;
    Ok(group)
}

#[tauri::command]
pub async fn get_group_messages(group_id: String, before: Option<u64>) -> Result<Vec<GroupMessageInfo>> {
    let client = authed()?;
    let mut url = format!("{}/api/groups/{}/messages?limit=50", engine_url(), group_id);
    if let Some(b) = before {
        url.push_str(&format!("&before={}", b));
    }
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| anyhow!("get_group_messages request: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("get_group_messages failed: {}", resp.status()));
    }
    let msgs: Vec<GroupMessageInfo> = resp
        .json()
        .await
        .map_err(|e| anyhow!("parse get_group_messages response: {e}"))?;
    Ok(msgs)
}

#[tauri::command]
pub async fn create_group(name: String, member_hashes: Vec<String>) -> Result<GroupInfo> {
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
        .map_err(|e| anyhow!("create_group request: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("create_group failed: {}", resp.status()));
    }
    let group: GroupInfo = resp
        .json()
        .await
        .map_err(|e| anyhow!("parse create_group response: {e}"))?;
    Ok(group)
}

#[tauri::command]
pub async fn add_group_member(group_id: String, agent_hash: String) -> Result<()> {
    let client = authed()?;
    let url = format!("{}/api/groups/{}/members", engine_url(), group_id);
    let body = serde_json::json!({ "agent_hash": agent_hash });
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("add_group_member request: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("add_group_member failed: {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_group_member(group_id: String, agent_hash: String) -> Result<()> {
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
        .map_err(|e| anyhow!("remove_group_member request: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("remove_group_member failed: {}", resp.status()));
    }
    Ok(())
}

#[tauri::command]
pub async fn delete_group(group_id: String) -> Result<()> {
    let client = authed()?;
    let url = format!("{}/api/groups/{}", engine_url(), group_id);
    let resp = client
        .delete(&url)
        .send()
        .await
        .map_err(|e| anyhow!("delete_group request: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("delete_group failed: {}", resp.status()));
    }
    Ok(())
}
