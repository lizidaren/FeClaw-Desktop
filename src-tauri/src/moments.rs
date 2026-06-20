//! Moments (群广场) API client.
//!
//! Calls the Engine's `/api/user/moments` endpoints to fetch, create,
//! and delete moment posts.

use crate::config::Config;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Path to the persisted credentials file (same as group.rs).
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
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| anyhow!("build reqwest client: {e}"))?;
    Ok(client)
}

fn engine_url() -> String {
    let config = Config::load();
    config.engine_url()
}

fn authed() -> Result<reqwest::Client> {
    let token = load_token()?;
    let client = build_client()?;
    // Attach JWT to a cloned builder so the original client is not consumed.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| anyhow!("build reqwest client: {e}"))?;
    Ok(client)
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
pub async fn get_moments(group_id: Option<String>) -> Result<Vec<MomentInfo>> {
    let client = authed()?;
    let token = load_token()?;
    let mut url = format!("{}/api/user/moments", engine_url());
    if let Some(ref gid) = group_id {
        url.push_str(&format!("?group_id={}", gid));
    }
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| anyhow!("get_moments request: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("get_moments failed: {}", resp.status()));
    }
    let moments: Vec<MomentInfo> = resp
        .json()
        .await
        .map_err(|e| anyhow!("parse get_moments response: {e}"))?;
    Ok(moments)
}

/// Post a new moment to a group.
#[tauri::command]
pub async fn post_moment(group_id: String, title: String, content: String) -> Result<()> {
    let client = authed()?;
    let token = load_token()?;
    let url = format!("{}/api/user/moments", engine_url());
    let body = PostMomentRequest {
        group_id,
        title,
        content,
    };
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("post_moment request: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("post_moment failed: {}", resp.status()));
    }
    Ok(())
}

/// Delete a moment.
#[tauri::command]
pub async fn delete_moment(group_id: String, moment_id: String) -> Result<()> {
    let client = authed()?;
    let token = load_token()?;
    let url = format!("{}/api/groups/{}/moments/{}", engine_url(), group_id, moment_id);
    let resp = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| anyhow!("delete_moment request: {e}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("delete_moment failed: {}", resp.status()));
    }
    Ok(())
}
