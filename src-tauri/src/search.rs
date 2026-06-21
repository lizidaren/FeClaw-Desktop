//! Phase 7 Desktop — Search commands (cloud + local FTS5).
//!
//! `search_all` calls the Engine's unified search endpoint (GET /api/user/search).
//! `search_local_chat` queries the local SQLite chat_messages FTS5 table
//! when the app is logged in but has no network connectivity.

use crate::config::Config;
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
    let client = crate::http_client::http_client();

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---------------------------------------------------------------------------
    // SearchItem — full deserialization
    // ---------------------------------------------------------------------------

    #[test]
    fn search_item_deserialize_full() {
        let json = r#"{
            "id": "item-001",
            "agentHash": "a1b2c3",
            "agentName": "TestBot",
            "snippet": "...matched text...",
            "score": 0.95,
            "timestamp": 1700000000,
            "source": "chat",
            "reference": "msg-123"
        }"#;
        let s: SearchItem = serde_json::from_str(json).unwrap();
        assert_eq!(s.id, "item-001");
        assert_eq!(s.agent_hash, Some("a1b2c3".to_string()));
        assert_eq!(s.agent_name, Some("TestBot".to_string()));
        assert_eq!(s.snippet, "...matched text...");
        assert!((s.score - 0.95).abs() < f64::EPSILON);
        assert_eq!(s.timestamp, 1700000000);
        assert_eq!(s.source, "chat");
        assert_eq!(s.reference, Some("msg-123".to_string()));
    }

    // ---------------------------------------------------------------------------
    // SearchItem — minimal (only required fields)
    // ---------------------------------------------------------------------------

    #[test]
    fn search_item_minimal() {
        let json = r#"{
            "id": "item-min",
            "snippet": "just a snippet",
            "score": 0.5,
            "timestamp": 1700001000,
            "source": "vfs"
        }"#;
        let s: SearchItem = serde_json::from_str(json).unwrap();
        assert_eq!(s.id, "item-min");
        assert!(s.agent_hash.is_none());
        assert!(s.agent_name.is_none());
        assert!(s.reference.is_none());
        assert_eq!(s.source, "vfs");
    }

    // ---------------------------------------------------------------------------
    // SearchItem — all source types
    // ---------------------------------------------------------------------------

    #[test]
    fn search_item_all_sources() {
        for source in &["chat", "vfs", "moments", "textbook", "miniapps"] {
            let json = format!(
                r#"{{"id": "s{}", "snippet": "t", "score": 1.0, "timestamp": 1, "source": "{}"}}"#,
                source,
                source
            );
            let s: SearchItem = serde_json::from_str(&json).unwrap();
            assert_eq!(s.source, *source);
        }
    }

    // ---------------------------------------------------------------------------
    // SearchItem — JSON serialization preserves fields
    // ---------------------------------------------------------------------------

    #[test]
    fn search_item_roundtrip() {
        let s = SearchItem {
            id: "round-item".to_string(),
            agent_hash: Some("abcd".to_string()),
            agent_name: Some("RoundBot".to_string()),
            snippet: "roundtrip snippet text".to_string(),
            score: 0.88,
            timestamp: 1700010000,
            source: "chat".to_string(),
            reference: Some("ref-001".to_string()),
        };
        let json = serde_json::to_string(&s).unwrap();
        let parsed: SearchItem = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, s);
    }

    #[test]
    fn search_item_roundtrip_minimal() {
        let s = SearchItem {
            id: "round-min".to_string(),
            agent_hash: None,
            agent_name: None,
            snippet: "minimal snippet".to_string(),
            score: 0.1,
            timestamp: 0,
            source: "vfs".to_string(),
            reference: None,
        };
        let json = serde_json::to_string(&s).unwrap();
        let parsed: SearchItem = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, s);
    }

    // ---------------------------------------------------------------------------
    // SourceResults
    // ---------------------------------------------------------------------------

    #[test]
    fn source_results_deserialize() {
        let json = r#"{
            "status": "ok",
            "items": [
                {"id": "i1", "snippet": "a", "score": 0.9, "timestamp": 1, "source": "chat"},
                {"id": "i2", "snippet": "b", "score": 0.8, "timestamp": 2, "source": "vfs"}
            ]
        }"#;
        let sr: SourceResults = serde_json::from_str(json).unwrap();
        assert_eq!(sr.status, "ok");
        assert_eq!(sr.items.len(), 2);
        assert_eq!(sr.items[0].id, "i1");
        assert_eq!(sr.items[1].id, "i2");
    }

    #[test]
    fn source_results_empty_items() {
        let json = r#"{"status": "ok", "items": []}"#;
        let sr: SourceResults = serde_json::from_str(json).unwrap();
        assert!(sr.items.is_empty());
    }

    // ---------------------------------------------------------------------------
    // SearchResult — empty results
    // ---------------------------------------------------------------------------

    #[test]
    fn search_result_empty() {
        let json = r#"{
            "query": "nonexistent term xyz",
            "results": {},
            "elapsed_ms": 5
        }"#;
        let r: SearchResult = serde_json::from_str(json).unwrap();
        assert_eq!(r.query, "nonexistent term xyz");
        assert!(r.results.is_empty());
        assert_eq!(r.elapsed_ms, 5);
    }

    // ---------------------------------------------------------------------------
    // SearchResult — multi-source
    // ---------------------------------------------------------------------------

    #[test]
    fn search_result_multi_source() {
        let json = r#"{
            "query": "test query",
            "results": {
                "chat": {
                    "status": "ok",
                    "items": [{"id": "c1", "snippet": "chat match", "score": 0.9, "timestamp": 1, "source": "chat"}]
                },
                "vfs": {
                    "status": "ok",
                    "items": [{"id": "v1", "snippet": "file match", "score": 0.7, "timestamp": 2, "source": "vfs"}]
                }
            },
            "elapsed_ms": 12
        }"#;
        let r: SearchResult = serde_json::from_str(json).unwrap();
        assert_eq!(r.query, "test query");
        assert_eq!(r.results.len(), 2);
        assert_eq!(r.results["chat"].items.len(), 1);
        assert_eq!(r.results["vfs"].items.len(), 1);
        assert_eq!(r.elapsed_ms, 12);
    }

    // ---------------------------------------------------------------------------
    // SearchResult — round-trip
    // ---------------------------------------------------------------------------

    #[test]
    fn search_result_roundtrip() {
        use std::collections::HashMap;
        let mut results = HashMap::new();
        results.insert(
            "chat".to_string(),
            SourceResults {
                status: "ok".to_string(),
                items: vec![SearchItem {
                    id: "r1".to_string(),
                    agent_hash: None,
                    agent_name: None,
                    snippet: "test".to_string(),
                    score: 0.5,
                    timestamp: 1700000000,
                    source: "chat".to_string(),
                    reference: None,
                }],
            },
        );
        let r = SearchResult {
            query: "roundtrip query".to_string(),
            results,
            elapsed_ms: 42,
        };
        let json = serde_json::to_string(&r).unwrap();
        let parsed: SearchResult = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.query, "roundtrip query");
        assert_eq!(parsed.elapsed_ms, 42);
        assert_eq!(parsed.results["chat"].items[0].id, "r1");
    }

    // ---------------------------------------------------------------------------
    // SearchItem — missing required fields
    // ---------------------------------------------------------------------------

    #[test]
    fn search_item_missing_id_fails() {
        let json = r#"{"snippet": "s", "score": 1.0, "timestamp": 1, "source": "chat"}"#;
        let result: Result<SearchItem, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    #[test]
    fn search_item_missing_source_fails() {
        let json = r#"{"id": "i", "snippet": "s", "score": 1.0, "timestamp": 1}"#;
        let result: Result<SearchItem, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    // ---------------------------------------------------------------------------
    // Credentials struct (internal helper)
    // ---------------------------------------------------------------------------

    #[test]
    fn credentials_parse() {
        let json = r#"{"username": "testuser", "token": "jwt-token-here"}"#;
        let creds: Credentials = serde_json::from_str(json).unwrap();
        assert_eq!(creds.username, "testuser");
        assert_eq!(creds.token, Some("jwt-token-here".to_string()));
    }

    #[test]
    fn credentials_missing_token() {
        let json = r#"{"username": "user", "token": null}"#;
        let creds: Credentials = serde_json::from_str(json).unwrap();
        assert_eq!(creds.username, "user");
        assert!(creds.token.is_none());
    }

    #[test]
    fn credentials_empty_username() {
        let json = r#"{"username": "", "token": "tok"}"#;
        let creds: Credentials = serde_json::from_str(json).unwrap();
        assert_eq!(creds.username, "");
        assert_eq!(creds.token, Some("tok".to_string()));
    }
}
