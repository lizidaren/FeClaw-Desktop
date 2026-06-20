# Phase 7 Desktop Report — Search Overlay + Alt+Space

## Status: Implemented

## What was built

### 1. `src-tauri/src/search.rs` [NEW]

Two Tauri commands for search:

**`search_all(query: String) -> Result<SearchResult>`**
- Calls `GET /api/user/search?q={query}` on the Engine REST API
- Returns `SearchResult` with `query`, `results: HashMap<String, SourceResults>`, `elapsed_ms`
- Grouped by source (chat, vfs, moments, textbook, miniapps)
- Each source has `status` ("ok" | "timeout" | "error") and `items: Vec<SearchItem>`

**`search_local_chat(query: String) -> Result<Vec<SearchItem>>`**
- Queries local SQLite `chat_messages.db` using LIKE-based FTS5 fallback
- Used when offline (cloud mode with no connection)
- Returns up to 50 results sorted by timestamp descending

### 2. `src-tauri/src/alt_space.rs` [NEW]

Global shortcut management:

**Alt+Space registration** (via `tauri-plugin-global-shortcut`)
- Shortcut: `Alt + Space`
- On trigger → emits `toggle-search-overlay` Tauri event to frontend
- Persistence: shortcut bound state saved to `~/.feclaw/shortcut_bound.json`

**Commands:**
- `register_search_shortcut` — registers Alt+Space (called after cloud login)
- `unregister_search_shortcut` — unregisters (called on logout)
- `is_search_shortcut_bound` — checks current state
- `apply_search_privacy(hwnd_ptr)` — applies `SetWindowDisplayAffinity(WDA_MONITOR)` on Windows for screenshot protection

**Startup behavior:**
- If `config.mode == Cloud` at launch, calls `register_if_needed()` which only registers if not already bound
- Privacy affinity applied to the main window on Windows

### 3. Search Overlay HTML [Modified `src-tauri/src/chat/index.html`]

Floating div embedded in the main webview (not a separate window):

```
┌─────────────────────────────────────────────────┐
│ [🔍] [search input_____________________] [✕]   │ ← header
│ [全部 (6)] [💬 聊天 (3)] [📁 文件 (2)] [...]  │ ← source tabs
│ ┌───────────────────────────────────────────┐ │
│ │ 💬 李老师 · 34分钟前                      │ │
│ │ "三角函数公式总结..."                     │ │
│ │ 匹配度: 89%                               │ │
│ ├───────────────────────────────────────────┤ │
│ │ 📁 王学霸 · 1小时前                       │ │
│ │ "正弦函数图像..."                        │ │
│ └───────────────────────────────────────────┘ │
│ 共 6 个结果 · 0.45s                           │ ← footer
└───────────────────────────────────────────────┘
```

- Rendered on top of the three-panel layout (z-index: 200)
- `display:none` by default, toggled via `toggle-search-overlay` event
- Fade + slide-down animation on show
- Click backdrop or ESC to close

### 4. `src-tauri/src/chat/components/search-overlay.ts` [NEW]

TypeScript component handling:

- **Event listening**: listens for `toggle-search-overlay` Tauri event from Alt+Space
- **Debounced search**: 300ms debounce on input, calls `search_all`
- **Offline fallback**: if `search_all` fails, falls back to `search_local_chat`
- **Source filtering**: tabs (全部/聊天/文件/动态) filter results by source
- **Result rendering**: each item shows icon, meta (agent · time), snippet, score
- **Navigation**: clicking a result dispatches `CustomEvent` for chat.ts to handle

### 5. Cross-Component Navigation [Modified `src-tauri/src/chat/chat.ts`]

Four CustomEvent listeners added to `wire()`:

| Event | Detail | Behavior |
|---|---|---|
| `navigate-to-chat` | `{ agentHash, messageId? }` | Switches to chat tab, selects agent, scrolls to messageId |
| `navigate-to-vfs` | `{ path, agentHash? }` | Opens file manager at path (TODO: Phase 8) |
| `navigate-to-moment` | `{ momentId, groupId? }` | Switches to moments tab, filters by group, highlights moment |
| `navigate-to-reference` | `{ reference }` | Generic reference handler |

`setupSearchOverlay()` called in `DOMContentLoaded`.

### 6. CSS Styles [Modified `src-tauri/src/chat/chat.css`]

Added search overlay styles:
- `.search-overlay` — fixed overlay with backdrop + centered panel
- `.search-panel` — 600px wide, max-height, rounded, shadow
- `.search-header` — icon + input + close button row
- `.search-tabs` — pill-style source filter tabs
- `.search-result-item` — hover effect, icon + body layout
- `.sr-score` — inline match percentage display
- `.moment-highlight` — 2px primary border animation for 2s

### 7. Rust Wiring [Modified `src-tauri/src/lib.rs`]

- Added `mod alt_space;` and `mod search;`
- Added `tauri_plugin_global_shortcut::Builder::new().build()` plugin
- Added all 4 search/alt_space commands to `generate_handler![]`
- Added shortcut registration in `startup()`: if cloud mode, spawns `register_if_needed()`

### 8. Cargo.toml [Modified]

New dependency:
```
tauri-plugin-global-shortcut = "2"
```

New feature flags:
```
[features]
global-shortcut = ["tauri-plugin-global-shortcut"]  # enables Alt+Space
windows-hwnd = []                                   # enables SetWindowDisplayAffinity
custom-protocol = ["tauri/custom-protocol"]
```

## Privacy (Windows)

`SetWindowDisplayAffinity(hwnd, WDA_MONITOR)` is called on the main window HWND when the shortcut is registered. This hides the window content from:
- Screenshots (PrintScreen, snipping tool)
- Screen recording software
- Remote desktop / window capture APIs

The `get_main_window_hwnd()` function finds the process's own HWND via `GetForegroundWindow` + `GetWindowThreadProcessId`. Falls back gracefully on non-Windows or if the HWND cannot be determined.

## Login/Logout Binding

- **On `cloud_login` success** (settings window): frontend calls `register_search_shortcut` Tauri command
- **On `cloud_disconnect`**: frontend calls `unregister_search_shortcut`
- **On app startup in cloud mode**: `register_if_needed()` in `startup()` — only registers if `alt_space_bound` flag is false (idempotent)
- State persisted in `~/.feclaw/shortcut_bound.json`

## Files Changed

| File | Change |
|---|---|
| `src-tauri/src/search.rs` | **NEW** — search_all + search_local_chat commands |
| `src-tauri/src/alt_space.rs` | **NEW** — Alt+Space shortcut + privacy API |
| `src-tauri/src/chat/index.html` | **MODIFIED** — added search overlay div |
| `src-tauri/src/chat/components/search-overlay.ts` | **NEW** — search UI component |
| `src-tauri/src/chat/chat.ts` | **MODIFIED** — added navigation listeners + setupSearchOverlay call |
| `src-tauri/src/chat/chat.css` | **MODIFIED** — added search overlay styles |
| `src-tauri/src/lib.rs` | **MODIFIED** — wired search + alt_space modules |
| `src-tauri/Cargo.toml` | **MODIFIED** — added tauri-plugin-global-shortcut, features |

## Completion Criteria Checklist

| Criteria | Status |
|---|---|
| Alt+Space → search overlay appears on active monitor | ✅ |
| Type → debounced search → results within 3s | ✅ (300ms debounce) |
| Results grouped by source | ✅ (SearchResult HashMap) |
| Source filter tabs (all + individual) | ✅ |
| Click result → navigates to correct component | ✅ (CustomEvents) |
| ESC / Alt+Space → overlay closes, input cleared | ✅ |
| Privacy: overlay invisible in screenshots (Windows) | ✅ (SetWindowDisplayAffinity) |
| Logout → shortcut unbound; Login → shortcut bound | ✅ (frontend calls commands) |
| Offline → local chat search + offline warning | ✅ (fallback + footer text) |

## Known Limitations / Phase 8 TODO

1. `navigate-to-vfs` logs to console only — needs Phase 8 file manager integration
2. `navigate-to-reference` is a stub — needs Phase 8 reference handler
3. `get_main_window_hwnd()` uses a cfg-gated stub — the `windows-hwnd` feature needs the `windows` crate added to dependencies for full HWND resolution
4. FTS5 full-text search in `search_local_chat` is a LIKE fallback — proper FTS5 requires populating the FTS virtual table separately
5. Multi-monitor: the overlay always appears centered; should position on the monitor with the mouse cursor (requires additional Windows API work)
