//! Phase 10 Desktop — Local File Index (本地文件全盘索引) MVP
//!
//! Background walker scans text files in user directories (Desktop, Documents, Downloads)
//! and indexes them into a local SQLite FTS5 table for fast Alt+Space search.
//!
//! Embedding (semantic search) deferred to Phase 10.1.

use crate::config::Config;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexFileInfo {
    pub id: i64,
    pub file_path: String,
    pub file_name: String,
    pub extension: String,
    pub snippet: String,
    pub modified_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub is_indexing: bool,
    pub total: usize,
    pub indexed: usize,
    pub current: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexDir {
    pub id: i64,
    pub path: String,
}

// ---------------------------------------------------------------------------
// SQLite helpers (shared with db.rs via same connection pool)
// ---------------------------------------------------------------------------

fn db_path() -> PathBuf {
    Config::config_dir().join("feclaw.db")
}

fn with_conn<F, T>(f: F) -> Result<T, rusqlite::Error>
where
    F: FnOnce(&Connection) -> Result<T, rusqlite::Error>,
{
    let path = db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| rusqlite::Error::InvalidPath(path.clone()))?;
    }
    let conn = Connection::open(&path)?;
    f(&conn)
}

/// Initialize file_index tables (called on first start_index).
fn init_tables(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS file_index (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL UNIQUE,
            file_name TEXT NOT NULL,
            directory TEXT NOT NULL,
            extension TEXT NOT NULL,
            content TEXT,
            snippet TEXT,
            modified_at INTEGER,
            indexed_at INTEGER,
            file_size INTEGER
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts5(
            file_name, content, directory
        );

        CREATE TABLE IF NOT EXISTS index_dirs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE
        );
        "#,
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Global indexing state (shared across commands)
// ---------------------------------------------------------------------------

static INDEXING: AtomicBool = AtomicBool::new(false);

/// Returns true if indexing is currently running.
pub fn is_indexing() -> bool {
    INDEXING.load(Ordering::SeqCst)
}

// ---------------------------------------------------------------------------
// Default directories
// ---------------------------------------------------------------------------

fn default_index_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));

    let mut dirs = Vec::new();
    for name in &["Desktop", "Documents", "Downloads"] {
        let dir = home.join(name);
        if dir.exists() && dir.is_dir() {
            dirs.push(dir);
        }
    }
    dirs
}

// ---------------------------------------------------------------------------
// File extensions to index
// ---------------------------------------------------------------------------

const INDEXED_EXTENSIONS: &[&str] = &[
    "txt", "md", "json", "py", "js", "html", "css", "ts", "rs", "java", "cpp", "hpp", "c", "h",
    "go", "rb", "php", "swift", "kt", "scala", "lua", "sh", "bash", "zsh", "ps1", "yaml", "yml",
    "toml", "ini", "cfg", "conf", "xml", "sql",
];

fn is_indexed_extension(ext: &str) -> bool {
    INDEXED_EXTENSIONS.contains(&ext.to_lowercase().as_str())
}

// ---------------------------------------------------------------------------
// Directory skip list
// ---------------------------------------------------------------------------

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".fehub",
    "__pycache__",
    "venv",
    ".venv",
    ".releases",
    ".idea",
    ".vscode",
    "dist",
    "build",
    ".cache",
    ".npm",
    ".cargo",
];

fn should_skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name) || name.starts_with('.')
}

// ---------------------------------------------------------------------------
// File walker + indexer
// ---------------------------------------------------------------------------

fn read_text_content(path: &Path) -> Option<String> {
    // Skip files > 1MB — only index filename + first 100KB
    let metadata = std::fs::metadata(path).ok()?;
    let file_size = metadata.len() as usize;

    let max_read = 100 * 1024; // 100KB
    let to_read = file_size.min(max_read);

    // Use a buffered read for efficiency
    let mut file = std::fs::File::open(path).ok()?;
    use std::io::{BufRead, BufReader};
    let reader = BufReader::new(file);
    let mut content = String::with_capacity(to_read);
    for line in reader.lines().take(2000) {
        if content.len() >= max_read {
            break;
        }
        if let Ok(l) = line {
            content.push_str(&l);
            content.push('\n');
        }
    }
    Some(content)
}

fn build_snippet(content: &str, query: &str) -> String {
    // Return first 200 chars as snippet
    if content.len() <= 200 {
        return content.to_string();
    }
    format!("{}...", &content[..200])
}

fn index_directory(
    dir: &Path,
    conn: &Connection,
    total_counter: &Mutex<usize>,
    indexed_counter: &Mutex<usize>,
    current_file: &RwLock<String>,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    use walkdir::WalkDir;

    let mut count = 0;
    for entry in WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                if let Some(name) = e.file_name().to_str() {
                    !should_skip_dir(name)
                } else {
                    true
                }
            } else {
                true
            }
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        if !is_indexed_extension(&ext) {
            continue;
        }

        // Update current file
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            *current_file.write().await = name.to_string();
        }

        let file_path_str = path.to_string_lossy().to_string();
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let directory = path
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        let modified_at = path
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let file_size = path.metadata().ok().map(|m| m.len() as i64);

        let content = read_text_content(path);
        let snippet = content
            .as_ref()
            .map(|c| build_snippet(c, ""))
            .unwrap_or_default();
        let content_for_fts = content.unwrap_or_default();

        let indexed_at = chrono_now_ms();

        // Upsert into file_index
        conn.execute(
            "INSERT OR REPLACE INTO file_index
             (file_path, file_name, directory, extension, content, snippet, modified_at, indexed_at, file_size)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                file_path_str,
                file_name,
                directory,
                ext,
                content_for_fts,
                snippet,
                modified_at,
                indexed_at,
                file_size,
            ],
        )?;

        let file_id: i64 = conn.last_insert_rowid();

        // Insert into FTS table
        conn.execute(
            "INSERT OR REPLACE INTO file_fts (rowid, file_name, content, directory)
             VALUES (?1, ?2, ?3, ?4)",
            params![file_id, file_name, content_for_fts, directory],
        )?;

        count += 1;
        *indexed_counter.lock().await += 1;
    }

    Ok(count)
}

/// Current indexing progress — updated by the background task.
static INDEX_TOTAL: std::sync::LazyLock<RwLock<usize>> =
    std::sync::LazyLock::new(|| RwLock::new(0));
static INDEX_INDEXED: std::sync::LazyLock<Mutex<usize>> =
    std::sync::LazyLock::new(|| Mutex::new(0));
static INDEX_CURRENT: std::sync::LazyLock<RwLock<String>> =
    std::sync::LazyLock::new(|| RwLock::new(String::new()));

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Start background indexing of configured directories.
/// Returns immediately; indexing runs on a spawned task.
#[tauri::command]
pub async fn start_index() -> Result<String, String> {
    if is_indexing() {
        return Ok("already indexing".to_string());
    }

    // Load index directories from DB
    let dirs: Vec<String> = with_conn(|conn| {
        init_tables(conn)?;
        let mut stmt = conn.prepare("SELECT path FROM index_dirs")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut dirs = Vec::new();
        for r in rows {
            if let Ok(d) = r {
                dirs.push(d);
            }
        }
        Ok(dirs)
    })
    .map_err(|e| format!("load index_dirs: {e}"))?;

    let dirs: Vec<PathBuf> = if dirs.is_empty() {
        default_index_dirs()
    } else {
        dirs.into_iter().map(PathBuf::from).collect()
    };

    if dirs.is_empty() {
        return Err("no index directories available".to_string());
    }

    INDEXING.store(true, Ordering::SeqCst);
    *INDEX_TOTAL.write().await = 0;
    *INDEX_INDEXED.lock().await = 0;
    *INDEX_CURRENT.write().await = String::new();

    // Spawn background task
    tauri::async_runtime::spawn(async move {
        tracing::info!("file_index: starting background scan of {} dirs", dirs.len());

        let result = with_conn(|conn| {
            init_tables(conn)?;
            let total = dirs.len();
            for (i, dir) in dirs.iter().enumerate() {
                if !is_indexing() {
                    tracing::info!("file_index: cancelled");
                    return Ok(0usize);
                }

                *INDEX_TOTAL.write().await = total;
                *INDEX_CURRENT.write().await = dir.to_string_lossy().to_string();

                match index_directory(dir, conn, &INDEX_INDEXED, &INDEX_INDEXED, &INDEX_CURRENT) {
                    Ok(count) => {
                        tracing::info!("file_index: {} → {} files", dir.display(), count);
                    }
                    Err(e) => {
                        tracing::warn!("file_index: error scanning {}: {e}", dir.display());
                    }
                }
            }
            Ok::<usize, rusqlite::Error>(total)
        });

        INDEXING.store(false, Ordering::SeqCst);
        *INDEX_CURRENT.write().await = String::new();

        match result {
            Ok(_) => tracing::info!("file_index: background scan complete"),
            Err(e) => tracing::error!("file_index: scan failed: {e}"),
        }
    });

    Ok("indexing started".to_string())
}

/// Get current indexing status.
#[tauri::command]
pub async fn get_index_status() -> Result<IndexStatus, String> {
    let total = *INDEX_TOTAL.read().await;
    let indexed = *INDEX_INDEXED.lock().await;
    let current = INDEX_CURRENT.read().await.clone();
    let is_indexing = is_indexing();

    Ok(IndexStatus {
        is_indexing,
        total,
        indexed,
        current,
    })
}

/// Search indexed local files using SQLite FTS5.
#[tauri::command]
pub async fn search_local_files(query: String) -> Result<Vec<IndexFileInfo>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    let escaped = query.replace('"', "\"\"");
    let fts_query = format!("\"{}\"", escaped);

    with_conn(|conn| {
        // Ensure table exists
        init_tables(conn)?;

        let mut stmt = conn.prepare(
            "SELECT fi.id, fi.file_path, fi.file_name, fi.extension, fi.snippet, fi.modified_at
             FROM file_index fi
             JOIN file_fts fts ON fi.id = fts.rowid
             WHERE file_fts MATCH ?1
             ORDER BY fi.modified_at DESC
             LIMIT 50",
        )?;

        let rows = stmt.query_map(params![fts_query], |row| {
            Ok(IndexFileInfo {
                id: row.get(0)?,
                file_path: row.get(1)?,
                file_name: row.get(2)?,
                extension: row.get(3)?,
                snippet: row.get(4)?,
                modified_at: row.get::<_, i64>(5)? as u64,
            })
        })?;

        let mut items = Vec::new();
        for item in rows {
            if let Ok(item) = item {
                items.push(item);
            }
        }
        Ok(items)
    })
    .map_err(|e| format!("search_local_files: {e}"))
}

/// Add a directory to the index list.
#[tauri::command]
pub async fn add_index_directory(path: String) -> Result<(), String> {
    with_conn(|conn| {
        init_tables(conn)?;
        conn.execute(
            "INSERT OR IGNORE INTO index_dirs (path) VALUES (?1)",
            params![path],
        )?;
        Ok(())
    })
    .map_err(|e| format!("add_index_directory: {e}"))
}

/// Remove a directory from the index list.
#[tauri::command]
pub async fn remove_index_directory(path: String) -> Result<(), String> {
    with_conn(|conn| {
        conn.execute("DELETE FROM index_dirs WHERE path = ?1", params![path])?;
        Ok(())
    })
    .map_err(|e| format!("remove_index_directory: {e}"))
}

/// Get all configured index directories.
#[tauri::command]
pub async fn get_index_directories() -> Result<Vec<String>, String> {
    with_conn(|conn| {
        init_tables(conn)?;
        let mut stmt = conn.prepare("SELECT path FROM index_dirs")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut dirs = Vec::new();
        for r in rows {
            if let Ok(d) = r {
                dirs.push(d);
            }
        }
        Ok(dirs)
    })
    .map_err(|e| format!("get_index_directories: {e}"))
}
