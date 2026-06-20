# Phase 2C — Side Panel Completion Report

**Date:** 2026-06-20
**Status:** ✅ Complete

## Checklist

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Settings sync to Engine server | ✅ Done | `sync_agent_settings` + `sync_to_engine_internal` added; fires after every alias/pin/dnd local save |
| 2 | Permission mode write-back | ✅ Done | `set_agent_permission_mode` command + wired to dropdown change |
| 3 | Config management button | ✅ Done | `open_config_window` command + "⚙️ 配置管理 [打开]" button in side panel |
| 4 | App list section | ✅ Done | `list_agent_apps` command + "🏪 小程序" section with card rendering |
| 5 | VFS file manager entry point | ✅ Done | `open_file_manager_window` + "📂 文件管理器 [打开]" button |
| 6 | Side panel section order | ✅ Done | Matches spec: avatar → alias → pin/dnd → file manager → config → permission → apps |
| 7 | lib.rs command registration | ✅ Done | All 5 new commands registered |
| 8 | CSS styles for new sections | ✅ Done | `.sp-btn-row`, `.sp-btn`, `.sp-section`, `.sp-app-card` etc. |

## Changes by File

### `src-tauri/src/side_panel.rs`
- **New struct `AppInfo`** (`app_id`, `name`, `description`, `icon_url`) — returned by `list_agent_apps`
- **New struct `EngineSettingsPayload`** — internal, used for PATCH body
- **`set_agent_permission_mode(agent_hash, mode)`** — saves to SQLite + fires async Engine sync
- **`sync_agent_settings(agent_hash)`** — Tauri command; reads local DB + PATCHes Engine
- **`sync_to_engine_internal(agent_hash)`** — internal async fn; does the HTTP PATCH with current settings
- **`list_agent_apps(agent_hash)`** — calls `GET /api/user/agents/{hash}/apps` on Engine
- **`open_config_window(app, agent_hash)`** — opens `WebviewWindow` at agent config URL
- **`open_file_manager_window(app, agent_hash)`** — opens `WebviewWindow` at `file-manager.html?agent={hash}`

### `src-tauri/src/lib.rs`
Added to `tauri::generate_handler![]`:
- `side_panel::set_agent_permission_mode`
- `side_panel::sync_agent_settings`
- `side_panel::list_agent_apps`
- `side_panel::open_config_window`
- `side_panel::open_file_manager_window`

### `src-tauri/src/chat/components/side-panel.ts`
- **Permission mode dropdown wired** — `change` event → `setPermissionModeAndSync(select.value)`
- **Alias blur** → `saveAliasAndSync` (existing save + new sync call)
- **Pin toggle** → `togglePinAndSync` (existing toggle + new sync call)
- **DND toggle** → `toggleDndAndSync` (existing toggle + new sync call)
- **New section: 文件管理器** — "📂 文件管理器 [打开]" button → `openFileManager()`
- **New section: 配置管理** — "⚙️ 配置管理 [打开]" button → `openConfig()`
- **New section: 小程序** — `loadApps(agentHash)` called on panel open; renders `AppInfo[]` as clickable cards
- **App card click** → `openApp(appId)` (currently a no-op fallback; Engine `open_app` command not yet implemented)

### `src-tauri/src/chat/chat.css`
Added:
- `.sp-btn-row`, `.sp-btn-label`, `.sp-btn` — button rows for file manager & config
- `.sp-section`, `.sp-section-header` — apps section header
- `.sp-apps-loading`, `.sp-apps-empty`, `.sp-apps-list` — loading/empty states
- `.sp-app-card`, `.sp-app-icon`, `.sp-app-info`, `.sp-app-name`, `.sp-app-desc` — app card layout

## Engine HTTP API Usage

| Action | Method | Path |
|--------|--------|------|
| Sync settings | `PATCH` | `/api/user/agents/{hash}/settings` |
| List apps | `GET` | `/api/user/agents/{hash}/apps` |

- **Local mode:** uses `http://{host}:{port}` base URL
- **Cloud mode:** uses `cloud_url` base (e.g. `https://feclaw.lizidaren.cn`)
- **Auth:** Bearer token from `cloud_token` config field (sent when available)
- **Sync failure:** non-fatal — logs warning, does not block UI

## Window URLs

| Window | Local URL | Cloud URL |
|--------|-----------|-----------|
| Config | `http://{host}:{port}/settings` | `https://{hash}.feclaw.lizidaren.cn/settings` |
| File Manager | `file-manager.html?agent={hash}` (app-relative) | same |

## Persistence
All local settings (alias, pin, dnd, permission_mode) continue to survive app restarts via SQLite `permission_configs` table.

## Out of Scope (deferred to future phases)
- `open_app` Tauri command (app card click is wired but no-op)
- Actual `file-manager.html` implementation (window creation is wired, page content deferred to 2A Desktop)
- Group settings placeholder ("📱 群广场设置")
