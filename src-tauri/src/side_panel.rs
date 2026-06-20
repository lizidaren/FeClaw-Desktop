//! Phase 0c — Agent side panel (info display + settings).
//!
//! Provides 4 Tauri commands for reading/updating per-agent panel settings
//! stored in the Desktop SQLite `permission_configs` table:
//!   - `get_agent_panel_info`   — read alias, avatar, pin, dnd, permission mode
//!   - `update_agent_alias`     — update display alias
//!   - `toggle_pin`            — toggle pinned status
//!   - `toggle_dnd`            — toggle do-not-disturb status
//!
//! SQLite schema additions (applied on startup migration):
//!   permission_configs ADD COLUMN alias TEXT
//!   permission_configs ADD COLUMN is_pinned INTEGER DEFAULT 0
//!   permission_configs ADD COLUMN is_dnd INTEGER DEFAULT 0

use crate::config::Config;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::PathBuf;

/// Path to the SQLite database.
fn db_path() -> PathBuf {
    Config::config_dir().join("feclaw.db")
}

/// Acquire a connection to the SQLite database.
fn with_conn<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> Result<T, rusqlite::Error>,
{
    let path = db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let conn =
        Connection::open(&path).map_err(|e| format!("打开数据库失败：{e}"))?;
    f(&conn)
}

/// Migrate the `permission_configs` table to add side-panel columns if they
/// don't already exist.
fn migrate_permission_configs(conn: &Connection) -> Result<(), rusqlite::Error> {
    // Check if alias column exists
    let has_alias: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('permission_configs') WHERE name = 'alias'",
            [],
            |row| Ok(row.get::<_, i32>(0)? > 0),
        )
        .unwrap_or(false);

    if !has_alias {
        conn.execute(
            "ALTER TABLE permission_configs ADD COLUMN alias TEXT",
            [],
        )?;
    }

    let has_pinned: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('permission_configs') WHERE name = 'is_pinned'",
            [],
            |row| Ok(row.get::<_, i32>(0)? > 0),
        )
        .unwrap_or(false);

    if !has_pinned {
        conn.execute(
            "ALTER TABLE permission_configs ADD COLUMN is_pinned INTEGER DEFAULT 0",
            [],
        )?;
    }

    let has_dnd: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('permission_configs') WHERE name = 'is_dnd'",
            [],
            |row| Ok(row.get::<_, i32>(0)? > 0),
        )
        .unwrap_or(false);

    if !has_dnd {
        conn.execute(
            "ALTER TABLE permission_configs ADD COLUMN is_dnd INTEGER DEFAULT 0",
            [],
        )?;
    }

    Ok(())
}

/// Run migrations. Called once during the first command invocation.
fn run_migrations() -> Result<(), String> {
    with_conn(|conn| {
        // Ensure the table itself exists first (init_db should have created it,
        // but run this defensively).
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS permission_configs (
                agent_hash TEXT PRIMARY KEY,
                mode TEXT NOT NULL DEFAULT 'balanced',
                trusted_directory TEXT,
                version_control INTEGER DEFAULT 0,
                full_access_expires INTEGER,
                updated_at INTEGER NOT NULL
            );
            "#,
        )?;
        migrate_permission_configs(conn)?;
        Ok(())
    })
}

/// Data returned by `get_agent_panel_info`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPanelInfo {
    /// Display alias (custom name set by user). Falls back to engine name.
    pub alias: String,
    /// Avatar URL from engine, if available.
    pub avatar_url: Option<String>,
    /// Whether this chat is pinned to the top.
    pub is_pinned: bool,
    /// Whether do-not-disturb is enabled.
    pub is_dnd: bool,
    /// Permission mode: "disabled" | "strict" | "balanced" | "relaxed" | "full"
    pub permission_mode: String,
}

/// Get the side-panel info for a given agent.
/// Creates a default row in `permission_configs` if none exists for this hash.
#[tauri::command]
pub fn get_agent_panel_info(agent_hash: String) -> Result<AgentPanelInfo, String> {
    run_migrations()?;

    with_conn(|conn| {
        // Upsert a default row so the panel always has something to show
        conn.execute(
            "INSERT OR IGNORE INTO permission_configs (agent_hash, mode, updated_at)
             VALUES (?1, 'balanced', ?2)",
            params![&agent_hash, chrono_now_s()],
        )?;

        let mut stmt = conn.prepare(
            "SELECT alias, is_pinned, is_dnd, mode FROM permission_configs
             WHERE agent_hash = ?1",
        )?;

        let info = stmt.query_row(params![&agent_hash], |row| {
            Ok(AgentPanelInfo {
                alias: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                avatar_url: None,
                is_pinned: row.get::<_, i32>(1)? != 0,
                is_dnd: row.get::<_, i32>(2)? != 0,
                permission_mode: row.get::<_, String>(3)?,
            })
        })?;

        Ok(info)
    })
}

/// Update the display alias for an agent.
#[tauri::command]
pub fn update_agent_alias(agent_hash: String, alias: String) -> Result<(), String> {
    run_migrations()?;

    with_conn(|conn| {
        // Ensure row exists first
        conn.execute(
            "INSERT OR IGNORE INTO permission_configs (agent_hash, mode, updated_at)
             VALUES (?1, 'balanced', ?2)",
            params![&agent_hash, chrono_now_s()],
        )?;

        conn.execute(
            "UPDATE permission_configs SET alias = ?1, updated_at = ?2
             WHERE agent_hash = ?3",
            params![alias, chrono_now_s(), agent_hash],
        )?;
        Ok(())
    })
}

/// Toggle the pinned status for an agent.
/// Returns the new pinned value (true = pinned).
#[tauri::command]
pub fn toggle_pin(agent_hash: String) -> Result<bool, String> {
    run_migrations()?;

    with_conn(|conn| {
        // Ensure row exists
        conn.execute(
            "INSERT OR IGNORE INTO permission_configs (agent_hash, mode, updated_at)
             VALUES (?1, 'balanced', ?2)",
            params![&agent_hash, chrono_now_s()],
        )?;

        conn.execute(
            "UPDATE permission_configs SET is_pinned = NOT is_pinned, updated_at = ?1
             WHERE agent_hash = ?2",
            params![chrono_now_s(), agent_hash],
        )?;

        let is_pinned: bool = conn.query_row(
            "SELECT is_pinned FROM permission_configs WHERE agent_hash = ?1",
            params![&agent_hash],
            |row| Ok(row.get::<_, i32>(0)? != 0),
        )?;

        Ok(is_pinned)
    })
}

/// Toggle the do-not-disturb status for an agent.
/// Returns the new dnd value (true = DND enabled).
#[tauri::command]
pub fn toggle_dnd(agent_hash: String) -> Result<bool, String> {
    run_migrations()?;

    with_conn(|conn| {
        // Ensure row exists
        conn.execute(
            "INSERT OR IGNORE INTO permission_configs (agent_hash, mode, updated_at)
             VALUES (?1, 'balanced', ?2)",
            params![&agent_hash, chrono_now_s()],
        )?;

        conn.execute(
            "UPDATE permission_configs SET is_dnd = NOT is_dnd, updated_at = ?1
             WHERE agent_hash = ?2",
            params![chrono_now_s(), agent_hash],
        )?;

        let is_dnd: bool = conn.query_row(
            "SELECT is_dnd FROM permission_configs WHERE agent_hash = ?1",
            params![&agent_hash],
            |row| Ok(row.get::<_, i32>(0)? != 0),
        )?;

        Ok(is_dnd)
    })
}

/// Return the current Unix timestamp in seconds.
fn chrono_now_s() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
