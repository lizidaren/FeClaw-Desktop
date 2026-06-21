# Phase 10 Desktop — Local File Index (本地文件全盘索引) MVP Report

## What was implemented

### 1. `src-tauri/src/file_index.rs` [NEW]

A new Rust module implementing full local file indexing with SQLite FTS5.

**Data types:**
- `IndexFileInfo` — returned by search, includes `id`, `file_path`, `file_name`, `extension`, `snippet`, `modified_at`
- `IndexStatus` — current indexing progress: `is_indexing`, `total`, `indexed`, `current` file
- `IndexDir` — configured index directories

**SQLite schema (auto-created on first use):**
```sql
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
```

**Walker implementation:**
- Uses `walkdir = "2"` crate for directory traversal
- Skips: `.git`, `node_modules`, `target`, `.fehub`, `__pycache__`, `venv`, `.venv`, `.releases`, `.idea`, `.vscode`, `dist`, `build`, `.cache`, `.npm`, `.cargo`
- Default dirs: `Desktop`, `Documents`, `Downloads` (from `$HOME`)
- Indexed extensions: `txt`, `md`, `json`, `py`, `js`, `html`, `css`, `ts`, `rs`, `java`, `cpp`, `hpp`, `c`, `h`, `go`, `rb`, `php`, `swift`, `kt`, `scala`, `lua`, `sh`, `bash`, `zsh`, `ps1`, `yaml`, `yml`, `toml`, `ini`, `cfg`, `conf`, `xml`, `sql`
- Files > 1MB: only filename is indexed, content skipped
- Files ≤ 1MB: first 100KB of content indexed
- Upsert via `INSERT OR REPLACE` (re-indexes on changes)

**Tauri commands:**
| Command | Description |
|---------|-------------|
| `start_index` | Spawns background task to scan all configured dirs. Returns `"indexing started"` immediately |
| `get_index_status` | Returns `{is_indexing, total, indexed, current}` |
| `search_local_files(query)` | FTS5 search on `file_fts`, returns `Vec<IndexFileInfo>` (up to 50 results, sorted by modified_at desc) |
| `add_index_directory(path)` | Adds path to `index_dirs` table |
| `remove_index_directory(path)` | Removes path from `index_dirs` table |
| `get_index_directories` | Returns all configured index directories |

### 2. `Cargo.toml` — added dependency

```toml
walkdir = "2"
```

### 3. `src-tauri/src/lib.rs` — module + command registration

- Added `mod file_index;`
- Registered 6 commands: `start_index`, `get_index_status`, `search_local_files`, `add_index_directory`, `remove_index_directory`, `get_index_directories`

### 4. `src-tauri/src/chat/components/search-overlay.ts` — integration

- Added `"local"` case to `sourceIcon()` → `🖥️`
- `doSearch` now calls `search_local_files` in parallel with `search_all` using `Promise.allSettled`
- Local file results are merged into `SearchResult.results["local"]` with `status: "ok"`
- `IndexFileInfo` TypeScript interface added
- Local results show as clickable items; `reference` field carries `file_path` for navigation

## Deferred to Phase 10.1
- Vector embedding / semantic search
- PDF/DOCX parsing
- File watcher (notify crate) for live updates

## Completion criteria status

| Criterion | Status |
|-----------|--------|
| Background walker scans default dirs | ✅ Implemented |
| Text files indexed to SQLite FTS5 | ✅ Implemented |
| Alt+Space search shows local file results | ✅ Integrated in search-overlay.ts |
| Index status visible somewhere | ✅ `get_index_status` command available |
| Can add/remove index directories | ✅ `add/remove_index_directory` commands |

## Notes
- No `cargo build/check` was run per the RULES
- Indexing is cancelable (checks `INDEXING` atomic flag between directories)
- FTS5 `file_fts` is synced with `file_index` via `rowid` join
- Search overlay's `navigateToResult` uses `item.reference` for local files (file_path), which fires `navigate-to-reference` CustomEvent — frontend handler should open the file
