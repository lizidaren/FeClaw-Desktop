//! Phase 7 Desktop — Search commands (cloud + local FTS5).
//!
//! `search_all` calls the Engine's unified search endpoint (GET /api/user/search).
//! `search_local_chat` queries the local SQLite chat_messages FTS5 table
//! when the app is logged in but has no network connectivity.

use crate::config::Config;
use anyhow::anyhow;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchItem {
    pub id: String,
    #[serde(rename = "agentHash", skip_serializing_if = "Option::is_none")]
    pub agent_hash: Option<String>,
    #[serde(rename = "agentName", skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    pub snippet: String,
    pub score: f64,
    pub timestamp: u64,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceResults {
    pub status: String,
    pub items: Vec<SearchItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub query: String,
    pub results: HashMap<String, SourceResults>,
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------------------
// Credentials helper (same pattern as group.rs / moments.rs)
// ---------------------------------------------------------------------------

fn credentials_path() -> PathBuf {
    crate::config::Config::config_dir().join("local-credentials")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Credentials {
    #[serde(default)]
    username: String,
    #[serde(default)]
    token: Option<String>,
}

fn load_token() -> Result<String, String> {
    let path = credentials_path();
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let creds: Credentials =
        serde_json::from_str(&content).map_err(|e| format!("parse credentials: {e}"))?;
    creds.token
        .ok_or_else(|| "no token in credentials file".to_string())
}

fn engine_url() -> String {
    let config = Config::load();
    config.engine_url()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Call GET /api/user/search?q={query} on the Engine.
/// Returns results grouped by source (chat, vfs, moments, textbook, miniapps).
#[tauri::command]
pub async fn search_all(query: String) -> Result<SearchResult, String> {
    if query.trim().is_empty() {
        return Ok(SearchResult {
            query,
            results: HashMap::new(),
            elapsed_ms: 0,
        });
    }

    let token = load_token()?;
    let url = format!("{}/api/user/search?q={}", engine_url(), urlencoding::encode(&query));

    let start = Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("build reqwest client: {e}"))?;

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("search request failed: {e}"))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    if !resp.status().is_success() {
        return Err(format!("search_all failed: {}", resp.status()));
    }

    let results: HashMap<String, SourceResults> = resp
        .json()
        .await
        .map_err(|e| format!("parse search response: {e}"))?;

    Ok(SearchResult {
        query,
        results,
        elapsed_ms,
    })
}

/// Search local SQLite chat_messages table using FTS5.
/// Used when offline (cloud mode with no connection).
#[tauri::command]
pub async fn search_local_chat(query: String) -> Result<Vec<SearchItem>, String> {
    use rusqlite::{Connection, params};

    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    let db_path = Config::config_dir().join("chat_messages.db");
    if !db_path.exists() {
        return Ok(vec![]);
    }

    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    // Ensure FTS5 virtual table exists
    conn.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
            content,
            content_rowid='id'
        )",
        [],
    ).map_err(|e| e.to_string())?;

    // Simple LIKE-based search on content (FTS5 requires FTS queries)
    let _fts_query = format!("\"{}\"", query.replace('"', "\"\""));

    let mut stmt = conn.prepare(
        "SELECT id, agent_hash, content, created_at
         FROM chat_messages
         WHERE content LIKE ?1
         ORDER BY created_at DESC
         LIMIT 50"
    ).map_err(|e| e.to_string())?;

    let pattern = format!("%{}%", query);
    let rows = stmt.query_map(params![pattern], |row| {
        let id: String = row.get(0)?;
        let agent_hash: Option<String> = row.get(1)?;
        let content: String = row.get(2)?;
        let created_at: u64 = row.get::<_, i64>(3)? as u64;

        // Build snippet (truncate content around the match)
        let snippet = if content.len() > 200 {
            if let Some(pos) = content.find(&query) {
                let start = pos.saturating_sub(40);
                let end = (pos + query.len() + 80).min(content.len());
                format!("...{}...", &content[start..end])
            } else {
                format!("{}...", &content[..200])
            }
        } else {
            content
        };

        Ok(SearchItem {
            id,
            agent_hash,
            agent_name: None,
            snippet,
            score: 1.0,
            timestamp: created_at,
            source: "chat".to_string(),
            reference: None,
        })
    }).map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    for item in rows {
        if let Ok(item) = item {
            items.push(item);
        }
    }

    Ok(items)
}
