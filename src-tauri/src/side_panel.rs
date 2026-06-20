//! Phase 0c + 2C — Agent side panel (info display + settings).
//!
//! Provides Tauri commands for reading/updating per-agent panel settings
//! stored in the Desktop SQLite `permission_configs` table:
//!   - `get_agent_panel_info`          — read alias, avatar, pin, dnd, permission mode
//!   - `update_agent_alias`            — update display alias
//!   - `toggle_pin`                   — toggle pinned status
//!   - `toggle_dnd`                   — toggle do-not-disturb status
//!   - `set_agent_permission_mode`     — set permission mode (Phase 2C)
//!   - `sync_agent_settings`           — push settings to Engine HTTP API (Phase 2C)
//!   - `list_agent_apps`               — fetch app list from Engine (Phase 2C)
//!   - `open_config_window`            — open agent config page (Phase 2C)
//!   - `open_file_manager_window`      — open VFS file manager window (Phase 2C)
//!
//! SQLite schema additions (applied on startup migration):
//!   permission_configs ADD COLUMN alias TEXT
//!   permission_configs ADD COLUMN is_pinned INTEGER DEFAULT 0
//!   permission_configs ADD COLUMN is_dnd INTEGER DEFAULT 0

use crate::config::Config;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
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

// ---------------------------------------------------------------------------
// Phase 2C — Engine sync + app list + window management
// ---------------------------------------------------------------------------

/// App info returned by `list_agent_apps`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub app_id: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
}

/// Settings shape sent to Engine in `sync_agent_settings`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineSettingsPayload {
    alias: String,
    is_pinned: bool,
    is_dnd: bool,
    permission_mode: String,
}

/// Set the permission mode for an agent (Phase 2C).
/// Saves to local SQLite and triggers an async Engine sync.
#[tauri::command]
pub async fn set_agent_permission_mode(
    agent_hash: String,
    mode: String,
) -> Result<(), String> {
    run_migrations()?;

    with_conn(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO permission_configs (agent_hash, mode, updated_at)
             VALUES (?1, 'balanced', ?2)",
            params![&agent_hash, chrono_now_s()],
        )?;
        conn.execute(
            "UPDATE permission_configs SET mode = ?1, updated_at = ?2 WHERE agent_hash = ?3",
            params![&mode, chrono_now_s(), &agent_hash],
        )?;
        Ok(())
    })?;

    // Fire-and-forget sync to Engine (log warning on failure, don't block)
    let hash = agent_hash.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = sync_to_engine_internal(&hash).await {
            tracing::warn!("sync_agent_settings failed for {hash}: {e}");
        }
    });

    Ok(())
}

/// Open a WebviewWindow pointing to the agent's config page (Phase 2C).
#[tauri::command]
pub async fn open_config_window<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    agent_hash: String,
) -> Result<(), String> {
    use tauri::Manager;
    use tauri::WebviewUrl;
    use tauri::WebviewWindowBuilder;

    let win_label = format!("config-{}", &agent_hash[..4.min(agent_hash.len())]);

    if let Some(existing) = app.get_webview_window(&win_label) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    // Determine URL based on mode (local vs cloud).
    // We synchronously read config via a blocking lock on AppState.
    let url = {
        let state = app.state::<crate::AppState>();
        let config = state.config.blocking_read();
        match config.mode {
            crate::config::Mode::Local => {
                let base = config.engine_url(); // http://host:port
                format!("{}/settings", base.trim_end_matches('/'))
            }
            crate::config::Mode::Cloud => {
                let _base = config.cloud_base_url().unwrap_or("https://feclaw.lizidaren.cn");
                format!("https://{}.feclaw.lizidaren.cn/settings", agent_hash)
            }
        }
    };

    WebviewWindowBuilder::new(
        &app,
        &win_label,
        WebviewUrl::External(url.parse().map_err(|e| format!("invalid URL: {e}"))?),
    )
    .title("Agent 配置")
    .inner_size(720.0, 600.0)
    .min_inner_size(520.0, 400.0)
    .resizable(true)
    .center()
    .build()
    .map_err(|e| format!("打开配置窗口失败：{e}"))?;

    Ok(())
}

/// Open a WebviewWindow for the VFS file manager (Phase 2C).
#[tauri::command]
pub async fn open_file_manager_window<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    agent_hash: String,
) -> Result<(), String> {
    use tauri::Manager;
    use tauri::WebviewUrl;
    use tauri::WebviewWindowBuilder;

    let win_label = format!("filemanager-{}", &agent_hash[..4.min(agent_hash.len())]);

    if let Some(existing) = app.get_webview_window(&win_label) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    // file-manager.html is a built-in HTML page (implemented in 2A Desktop side).
    // We pass the agent hash as a query param.
    let url = format!("file-manager.html?agent={}", agent_hash);

    WebviewWindowBuilder::new(
        &app,
        &win_label,
        WebviewUrl::App(url.into()),
    )
    .title("文件管理器")
    .inner_size(900.0, 650.0)
    .min_inner_size(640.0, 480.0)
    .resizable(true)
    .center()
    .build()
    .map_err(|e| format!("打开文件管理器窗口失败：{e}"))?;

    Ok(())
}

/// Fetch the list of apps for an agent from the Engine HTTP API (Phase 2C).
#[tauri::command]
pub async fn list_agent_apps(
    app: tauri::AppHandle<impl tauri::Runtime>,
    agent_hash: String,
) -> Result<Vec<AppInfo>, String> {
    let state = app.state::<crate::AppState>();
    let config = state.config.blocking_read();

    let base_url = match config.mode {
        crate::config::Mode::Local => config.engine_url(),
        crate::config::Mode::Cloud => {
            config.cloud_base_url().unwrap_or("https://feclaw.lizidaren.cn").to_string()
        }
    };
    let token = config.cloud_token.clone();

    let url = format!("{}/api/user/agents/{}/apps", base_url.trim_end_matches('/'), agent_hash);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("build reqwest client: {e}"))?;

    let mut req = client.get(&url);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }

    let resp = req.send().await.map_err(|e| format!("HTTP request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Engine /apps returned {}", resp.status()));
    }

    let apps: Vec<AppInfo> = resp
        .json()
        .await
        .map_err(|e| format!("failed to parse apps response: {e}"))?;

    Ok(apps)
}

/// Push current local settings to the Engine HTTP API (Phase 2C).
/// This is called internally after local writes; it can also be called directly.
#[tauri::command]
pub async fn sync_agent_settings(agent_hash: String) -> Result<(), String> {
    sync_to_engine_internal(&agent_hash).await
}

/// Internal helper: read local settings from SQLite and PATCH them to Engine.
async fn sync_to_engine_internal(agent_hash: &str) -> Result<(), String> {
    // Read local settings synchronously first
    let (alias, is_pinned, is_dnd, permission_mode) = with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT alias, is_pinned, is_dnd, mode FROM permission_configs WHERE agent_hash = ?1",
        )?;
        let row = stmt.query_row(params![agent_hash], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                row.get::<_, i32>(1)? != 0,
                row.get::<_, i32>(2)? != 0,
                row.get::<_, String>(3)?,
            ))
        })?;
        Ok(row)
    }).map_err(|e| format!("read local settings: {e}"))?;

    // Load config to get base URL and token
    let config = Config::load();
    let base_url = match config.mode {
        crate::config::Mode::Local => config.engine_url(),
        crate::config::Mode::Cloud => {
            config.cloud_base_url().unwrap_or("https://feclaw.lizidaren.cn").to_string()
        }
    };
    let token = config.cloud_token.clone();

    let url = format!(
        "{}/api/user/agents/{}/settings",
        base_url.trim_end_matches('/'),
        agent_hash
    );

    let payload = EngineSettingsPayload {
        alias,
        is_pinned,
        is_dnd,
        permission_mode,
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("build reqwest client: {e}"))?;

    let mut req = client.patch(&url).json(&payload);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }

    match req.send().await {
        Ok(resp) => {
            if resp.status().is_success() || resp.status().as_u16() == 404 {
                // 404 is acceptable — agent may not exist on server yet
                Ok(())
            } else {
                Err(format!("Engine PATCH returned {}", resp.status()))
            }
        }
        Err(e) => Err(format!("sync HTTP request failed: {e}")),
    }
}
