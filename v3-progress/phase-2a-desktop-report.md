# Phase 2A Desktop — VFS File Manager UI Report

**Date:** 2026-06-20
**Status:** ✅ Implementation Complete

## Completion Checklist

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | File Manager Rust commands | ✅ Done | All 8 commands in `file_manager.rs` |
| 2 | `open_local_file` Tauri command | ✅ Done | Added to `file_ops.rs`, uses `open` crate |
| 3 | `cleanup_preview_temp` command | ✅ Done | Clears `~/.feclaw/temp/preview/` |
| 4 | File manager HTML | ✅ Done | `src-tauri/src/chat/file-manager.html` |
| 5 | Viewer component (inline) | ✅ Done | All viewer logic in HTML inline JS |
| 6 | `viewer.ts` reference module | ✅ Done | `src-tauri/src/chat/components/viewer.ts` |
| 7 | Column sorting (name/size/mtime) | ✅ Done | Toggle sort direction on same column |
| 8 | Context menu: file right-click | ✅ Done | 10 items: preview, edit, local, copy, cut, rename, download, sep, permission, delete |
| 9 | Context menu: blank right-click | ✅ Done | 5 items: upload, newFile, newDir, paste, refresh |
| 10 | Permission dialog | ✅ Done | 3 radio options: none/read/readwrite → PATCH Engine |
| 11 | Image viewer (data:URL) | ✅ Done | blob → FileReader → `<img>` |
| 12 | Text/code editor (Ctrl+S save) | ✅ Done | `<textarea>` + presigned PUT |
| 13 | "本地查看" → system default app | ✅ Done | `download_vfs_file` + `open_local_file` |
| 14 | Temp file cleanup on window close | ✅ Done | `cleanup_preview_temp` on `window.unload` |
| 15 | Error handling (user-friendly) | ✅ Done | Error banner + alert dialogs |
| 16 | lib.rs wiring | ✅ Done | All commands registered in `generate_handler![]` |
| 17 | `urlencoding` crate added | ✅ Done | Added to `Cargo.toml` for path encoding |

## Files Created

### `src-tauri/src/file_manager.rs` (NEW)
New Rust module for VFS File Manager Tauri commands.

**Commands:**

| Command | Engine Endpoint | Description |
|---------|----------------|-------------|
| `list_vfs_dir` | `GET /api/user/agents/{hash}/vfs?path=` | List directory entries |
| `get_vfs_preview_url` | `GET /api/user/agents/{hash}/vfs/url?path=&mode=view` | Presigned view URL |
| `get_vfs_upload_url` | `POST /api/user/agents/{hash}/vfs/url-upload` | Presigned upload URL |
| `vfs_mkdir` | `POST /api/user/agents/{hash}/vfs/mkdir` | Create directory |
| `vfs_rm` | `POST /api/user/agents/{hash}/vfs/rm` | Delete entry |
| `vfs_mv` | `POST /api/user/agents/{hash}/vfs/mv` | Rename / move |
| `vfs_set_permission` | `PATCH /api/user/agents/{hash}/vfs/permissions` | Set file permission |
| `vfs_notify_event` | `POST /api/user/agents/{hash}/vfs/events` | Notify FS events |
| `download_vfs_file` | (composite) | Get presigned URL → download bytes → save to `~/.feclaw/temp/preview/` → return local path |

**Structs:**
- `FsEntry` — `{ name, type, size, mtime, content_type }` (type serialized as `"type"`)
- `PreviewUrl` — `{ url, expires_at }`
- `UploadUrl` — `{ url, method, expires_at }`
- `FsEvent` — `{ type, path, new_path?, timestamp }`

All commands use `Config::load()` to determine Engine base URL (local: `http://host:port`, cloud: `cloud_url`) and Bearer token from `cloud_token`.

### `src-tauri/src/chat/file-manager.html` (NEW)
Standalone HTML file opened in a Tauri `WebviewWindow`. All CSS and JS are inline (no build step required for the separate window).

**Layout:**
```
┌── Header ──────────────────────────────────────────────┐
│ 📂 /workspace/...    [搜索文件...]                      │
├── Body ────────────────────────────────────────────────┤
│ ┌─ Sidebar ─┐ ┌─ Main Panel ────────────────────────┐ │
│ │ 📁 /      │ │ 名称      | 大小   | 修改时间       │ │
│ │ 📁 workspace│ │ 📄 a.txt  | 1.2KB  | 2026-06-20  │ │
│ │           │ │ 📁 docs/  | —      | 2026-06-19  │ │
│ └───────────┘ └────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

**Features implemented:**
- **Directory navigation:** Double-click dir to enter; breadcrumb click to navigate up
- **File preview:** Image → `<img>` with data:URL; Text/Markdown/Code → `<pre>` (readonly)
- **File editing:** Text files → `<textarea>`; Ctrl+S saves via presigned PUT URL
- **Unsaved indicator:** Yellow "有未保存的更改" shown in viewer header; close prompts confirmation
- **Sorting:** Click column header to sort (name asc by default; size/mtime desc); toggle direction on re-click
- **Search:** Real-time filter on file name
- **File right-click menu:**
  - 👁️ 预览 — open in viewer (readonly)
  - ✏️ 编辑 — open in textarea editor
  - 💻 本地查看 — download + open system default app via `open_local_file`
  - 📋 复制 / ✂️ 剪切 — store in clipboard
  - 📝 重命名 — `prompt()` → `vfs_mv`
  - ⬇️ 下载 — download to browser via anchor trick
  - 🔐 权限 — permission dialog
  - 🗑️ 删除 (danger) — confirm dialog → `vfs_rm`
- **Blank right-click menu:**
  - ⬆️ 上传文件 — `<input type=file">` → presigned PUT
  - 📄 新建文件 — `prompt()` → empty file via upload URL
  - 📁 新建文件夹 — `prompt()` → `vfs_mkdir`
  - 📋 粘贴 — clipboard → `vfs_mv` (cut) or download+reupload (copy)
  - 🔄 刷新 — `loadDirectory(currentPath)`
- **Permission dialog:** 3 radio buttons (🔒 隐藏/none, 📖 只读/read, ✏️ 可读可写/readwrite) → `vfs_set_permission`
- **Error banner:** Red banner below header for API errors
- **Cleanup on unload:** `window.unload` → `cleanup_preview_temp`

### `src-tauri/src/chat/components/viewer.ts` (NEW — reference module)
Documents the viewer logic that is inlined in `file-manager.html`. Exports:
- `isEditable(ext)` — returns true for text-based extensions
- `isImage(ext)` — returns true for image extensions
- `blobToDataURL(blob)` — converts image blob to data:URL

### `src-tauri/src/file_ops.rs` (MODIFIED)
Added two new commands:
- **`open_local_file(path)`** — calls `open::that(path)` to open a local file with the system default app (via `tokio::task::spawn_blocking`)
- **`cleanup_preview_temp()`** — removes and recreates `~/.feclaw/temp/preview/` directory

### `src-tauri/src/lib.rs` (MODIFIED)
- Added `mod file_manager;`
- Registered 9 new commands in `generate_handler![]`:
  - `file_ops::open_local_file`
  - `file_ops::cleanup_preview_temp`
  - `file_manager::list_vfs_dir`
  - `file_manager::get_vfs_preview_url`
  - `file_manager::get_vfs_upload_url`
  - `file_manager::vfs_mkdir`
  - `file_manager::vfs_rm`
  - `file_manager::vfs_mv`
  - `file_manager::vfs_set_permission`
  - `file_manager::vfs_notify_event`
  - `file_manager::download_vfs_file`

### `src-tauri/Cargo.toml` (MODIFIED)
Added `urlencoding = "2"` dependency (needed for path encoding in query strings).

## Engine HTTP API Summary

| Command | Method | Path |
|---------|--------|------|
| `list_vfs_dir` | GET | `/api/user/agents/{hash}/vfs?path={path}` |
| `get_vfs_preview_url` | GET | `/api/user/agents/{hash}/vfs/url?path={path}&mode=view` |
| `get_vfs_upload_url` | POST | `/api/user/agents/{hash}/vfs/url-upload` (body: `{path}`) |
| `vfs_mkdir` | POST | `/api/user/agents/{hash}/vfs/mkdir` (body: `{path}`) |
| `vfs_rm` | POST | `/api/user/agents/{hash}/vfs/rm` (body: `{path}`) |
| `vfs_mv` | POST | `/api/user/agents/{hash}/vfs/mv` (body: `{from_path, to_path}`) |
| `vfs_set_permission` | PATCH | `/api/user/agents/{hash}/vfs/permissions` (body: `{path, permission}`) |
| `vfs_notify_event` | POST | `/api/user/agents/{hash}/vfs/events` (body: `FsEvent[]`) |

All endpoints use Bearer auth (token from `cloud_token` config field).

## Window Opening Flow

```
Side Panel → open_file_manager_window (already existed in side_panel.rs)
  → WebviewWindowBuilder("filemanager-{agent_hash[..4]}", file-manager.html?agent={hash})
  → file-manager.html reads ?agent= param
  → loads /workspace directory via list_vfs_dir
  → renders sidebar tree + file list
```

## Out of Scope / Deferred
- Drag-and-drop file upload (Phase 2B or later)
- File list pagination (if directories are large)
- Multiple file selection
- File rename inline editing (prompt used instead)
- Real-time VFS updates (would need WebSocket or polling)
