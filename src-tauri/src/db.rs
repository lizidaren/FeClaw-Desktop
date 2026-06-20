//! SQLite database for FeClaw Desktop V3.
//!
//! Manages `~/.feclaw/feclaw.db` with 6 tables:
//!   - chat_messages   — IM chat cache
//!   - group_messages   — group chat cache
//!   - permission_configs — per-agent permission settings
//!   - prompt_templates — user shortcut templates
//!   - security_logs    — file operation audit log
//!   - settings         — key/value store
//!   - sync_state       — channel sync tracking
//!
//! Also handles V2 `chat_history.json` import on first launch.

use crate::config::Config;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// Path to the SQLite database.
fn db_path() -> PathBuf {
    Config::config_dir().join("feclaw.db")
}

/// Acquire a connection to the SQLite database. Creates the file and
/// tables if they don't exist.
fn with_conn<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> Result<T, rusqlite::Error>,
{
    let path = db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let conn = Connection::open(&path)
        .map_err(|e| format!("打开数据库失败：{e}"))?;
    f(&conn)
}

/// Initialise the database: create all 6 tables if they don't exist.
#[tauri::command]
pub fn init_db() -> Result<(), String> {
    with_conn(|conn| {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS chat_messages (
                id TEXT PRIMARY KEY,
                channel TEXT NOT NULL,
                agent_hash TEXT,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                message_type TEXT DEFAULT 'text',
                created_at INTEGER NOT NULL,
                synced INTEGER DEFAULT 0,
                is_deleted INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_chat_messages_channel
                ON chat_messages(channel, created_at);

            CREATE TABLE IF NOT EXISTS group_messages (
                id TEXT PRIMARY KEY,
                group_id TEXT NOT NULL,
                sender_type TEXT NOT NULL,
                sender_hash TEXT,
                content TEXT NOT NULL,
                message_type TEXT DEFAULT 'text',
                created_at INTEGER NOT NULL,
                synced INTEGER DEFAULT 1
            );

            CREATE INDEX IF NOT EXISTS idx_group_messages_group
                ON group_messages(group_id, created_at);

            CREATE TABLE IF NOT EXISTS permission_configs (
                agent_hash TEXT PRIMARY KEY,
                mode TEXT NOT NULL DEFAULT 'balanced',
                trusted_directory TEXT,
                version_control INTEGER DEFAULT 0,
                full_access_expires INTEGER,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS prompt_templates (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                content TEXT NOT NULL,
                icon TEXT DEFAULT '😄',
                sort_order INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS security_logs (
                id TEXT PRIMARY KEY,
                agent_hash TEXT NOT NULL,
                path TEXT NOT NULL,
                operation TEXT NOT NULL,
                intent TEXT,
                match_string TEXT,
                permission_mode TEXT NOT NULL,
                approved INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_security_logs_agent
                ON security_logs(agent_hash, created_at);

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sync_state (
                channel TEXT PRIMARY KEY,
                last_synced_at INTEGER NOT NULL,
                last_message_id TEXT
            );
            "#,
        )?;
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// V2 legacy import
// ---------------------------------------------------------------------------

/// V2 chat message shape (matches chat.rs ChatMessage).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct V2ChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

/// Check whether the legacy `chat_history.json` exists.
#[tauri::command]
pub fn check_legacy_chat_history() -> Result<bool, String> {
    let path = Config::config_dir().join("chat_history.json");
    Ok(path.exists())
}

/// Import messages from the legacy `chat_history.json` into SQLite.
/// Returns the number of messages imported.
#[tauri::command]
pub fn import_chat_history() -> Result<u64, String> {
    let path = Config::config_dir().join("chat_history.json");
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 legacy chat_history.json 失败：{e}"))?;
    let messages: Vec<V2ChatMessage> = serde_json::from_str(&content)
        .map_err(|e| format!("解析 chat_history.json 失败：{e}"))?;

    if messages.is_empty() {
        return Ok(0);
    }

    let count = messages.len() as u64;
    with_conn(|conn| {
        let mut stmt = conn.prepare(
            "INSERT OR IGNORE INTO chat_messages
                (id, channel, agent_hash, role, content, message_type, created_at, synced, is_deleted)
             VALUES (?1, 'im', ?2, ?3, ?4, 'text', ?5, 1, 0)",
        )?;
        for msg in messages {
            let ts = msg.timestamp
                .as_ref()
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or_else(|| chrono_now_ms());
            let agent_hash = msg.agent.filter(|s| !s.is_empty());
            stmt.execute(params![
                msg.id,
                agent_hash,
                msg.role,
                msg.content,
                ts,
            ])?;
        }
        Ok(())
    })?;

    // Rename the old file so we don't re-import
    let renamed = path.with_extension("json.imported");
    let _ = std::fs::rename(&path, renamed);

    Ok(count)
}

/// Return the current Unix timestamp in milliseconds.
fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Message draft
// ---------------------------------------------------------------------------

/// Save a draft for a given channel to the settings table.
#[tauri::command]
pub fn save_draft(channel: String, content: String) -> Result<(), String> {
    with_conn(|conn| {
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![format!("draft:{}", channel), content],
        )?;
        Ok(())
    })
}

/// Load the draft for a given channel. Returns `None` if no draft exists.
#[tauri::command]
pub fn load_draft(channel: String) -> Result<Option<String>, String> {
    with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT value FROM settings WHERE key = ?1",
        )?;
        let result: rusqlite::Result<String> = stmt.query_row(
            params![format!("draft:{}", channel)],
            |row| row.get(0),
        );
        match result {
            Ok(content) => Ok(Some(content)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("加载草稿失败：{e}")),
        }
    })
}

// ---------------------------------------------------------------------------
// Chat history (V3 SQLite-backed)
// ---------------------------------------------------------------------------

/// A message retrieved from SQLite.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbChatMessage {
    pub id: String,
    pub channel: String,
    pub agent_hash: Option<String>,
    pub role: String,
    pub content: String,
    pub message_type: String,
    pub created_at: i64,
    pub synced: bool,
    pub is_deleted: bool,
}

/// Get chat history for a specific agent channel.
#[tauri::command]
pub fn get_chat_history_by_agent(agent_hash: String) -> Result<Vec<DbChatMessage>, String> {
    let channel = format!("im:{}", agent_hash);
    with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, channel, agent_hash, role, content, message_type,
                    created_at, synced, is_deleted
               FROM chat_messages
              WHERE channel = ?1 AND is_deleted = 0
              ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map(params![channel], |row| {
            Ok(DbChatMessage {
                id: row.get(0)?,
                channel: row.get(1)?,
                agent_hash: row.get(2)?,
                role: row.get(3)?,
                content: row.get(4)?,
                message_type: row.get(5)?,
                created_at: row.get(6)?,
                synced: row.get::<_, i32>(7)? != 0,
                is_deleted: row.get::<_, i32>(8)? != 0,
            })
        })?;
        let mut messages = Vec::new();
        for row in rows {
            let msg = row.map_err(|e| format!("读取消息行失败：{e}"))?;
            messages.push(msg);
        }
        Ok(messages)
    })
}

/// Insert a new chat message into SQLite.
#[tauri::command]
pub fn insert_chat_message(
    id: String,
    channel: String,
    agent_hash: Option<String>,
    role: String,
    content: String,
    message_type: String,
    created_at: i64,
) -> Result<(), String> {
    with_conn(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO chat_messages
                (id, channel, agent_hash, role, content, message_type, created_at, synced, is_deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0)",
            params![id, channel, agent_hash, role, content, message_type, created_at],
        )?;
        Ok(())
    })
}

/// Mark a message as deleted (soft delete).
#[tauri::command]
pub fn delete_chat_message(id: String) -> Result<(), String> {
    with_conn(|conn| {
        conn.execute(
            "UPDATE chat_messages SET is_deleted = 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Screenshot / pasted image
// ---------------------------------------------------------------------------

/// Info returned after saving a temp image.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TempImageInfo {
    pub temp_path: String,
    pub name: String,
    pub size_bytes: u64,
}

/// Save a base64-encoded image to `~/.feclaw/temp/uploads/` and return its path.
#[tauri::command]
pub fn save_temp_image(base64_data: String) -> Result<TempImageInfo, String> {
    // Strip data URL prefix if present (e.g. "data:image/png;base64,")
    let data = if base64_data.contains(',') {
        base64_data.split(',').nth(1).unwrap_or(&base64_data)
    } else {
        &base64_data
    };

    let decoded = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        data.trim(),
    )
    .map_err(|e| format!("base64 decode failed: {e}"))?;

    let size_bytes = decoded.len() as u64;

    // Determine extension from magic bytes
    let extension = if decoded.len() >= 3 {
        match &decoded[0..3] {
            [0x89, 0x50, 0x4E] => "png",
            [0xFF, 0xD8, 0xFF] => "jpg",
            [0x47, 0x49, 0x46] => "gif",
            [0x52, 0x49, 0x46, 0x46] => "webp",
            _ => "png",
        }
    } else {
        "png"
    };

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let name = format!("img_{}.{}", timestamp, extension);

    let upload_dir = Config::config_dir().join("temp").join("uploads");
    std::fs::create_dir_all(&upload_dir)
        .map_err(|e| format!("create temp dir failed: {e}"))?;

    let path = upload_dir.join(&name);
    std::fs::write(&path, &decoded)
        .map_err(|e| format!("write image file failed: {e}"))?;

    Ok(TempImageInfo {
        temp_path: path.to_string_lossy().to_string(),
        name,
        size_bytes,
    })
}

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

/// A prompt template (built-in or custom).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptTemplate {
    pub id: String,
    pub name: String,
    /// The prefix text inserted into the input when the template is selected.
    pub prefix: String,
    pub category: String, // "builtin" | "custom"
    pub created_at: u64,
}

/// Input for saving a custom template.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptTemplateInput {
    pub id: String,
    pub name: String,
    pub prefix: String,
}

/// Built-in templates (always present, not stored in SQLite).
fn builtin_templates() -> Vec<PromptTemplate> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    vec![
        PromptTemplate {
            id: "builtin_summary".into(),
            name: "总结".into(),
            prefix: "请总结以下内容：\n\n".into(),
            category: "builtin".into(),
            created_at: now,
        },
        PromptTemplate {
            id: "builtin_translate".into(),
            name: "翻译".into(),
            prefix: "请将以下内容翻译成英文：\n\n".into(),
            category: "builtin".into(),
            created_at: now,
        },
        PromptTemplate {
            id: "builtin_check_grammar".into(),
            name: "检查语法".into(),
            prefix: "请检查以下内容的语法：\n\n".into(),
            category: "builtin".into(),
            created_at: now,
        },
        PromptTemplate {
            id: "builtin_rewrite".into(),
            name: "改写".into(),
            prefix: "请改写以下内容：\n\n".into(),
            category: "builtin".into(),
            created_at: now,
        },
        PromptTemplate {
            id: "builtin_explain_code".into(),
            name: "解释代码".into(),
            prefix: "请解释以下代码：\n\n".into(),
            category: "builtin".into(),
            created_at: now,
        },
        PromptTemplate {
            id: "builtin_optimize_code".into(),
            name: "优化代码".into(),
            prefix: "请优化以下代码：\n\n".into(),
            category: "builtin".into(),
            created_at: now,
        },
    ]
}

/// Get all prompt templates (built-in + custom).
#[tauri::command]
pub fn get_prompt_templates() -> Result<Vec<PromptTemplate>, String> {
    let mut templates = builtin_templates();

    with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, content, created_at FROM prompt_templates ORDER BY sort_order ASC, created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PromptTemplate {
                id: row.get(0)?,
                name: row.get(1)?,
                prefix: row.get(2)?,
                category: "custom".into(),
                created_at: row.get::<_, i64>(3)? as u64,
            })
        })?;
        for row in rows {
            let tmpl = row.map_err(|e| format!("read template row failed: {e}"))?;
            templates.push(tmpl);
        }
        Ok(templates)
    })
}

/// Save (create or update) a custom prompt template.
#[tauri::command]
pub fn save_prompt_template(input: PromptTemplateInput) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    with_conn(|conn| {
        conn.execute(
            "INSERT OR REPLACE INTO prompt_templates (id, name, content, sort_order, created_at)
             VALUES (?1, ?2, ?3, 100, ?4)",
            params![input.id, input.name, input.prefix, now],
        )?;
        Ok(())
    })
}

/// Delete a custom prompt template by id (built-in templates cannot be deleted).
#[tauri::command]
pub fn delete_prompt_template(id: String) -> Result<(), String> {
    if id.starts_with("builtin_") {
        return Err("Cannot delete built-in templates".into());
    }
    with_conn(|conn| {
        conn.execute("DELETE FROM prompt_templates WHERE id = ?1", params![id])?;
        Ok(())
    })
}
