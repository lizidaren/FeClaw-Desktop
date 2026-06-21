# Compilation Fix 2 — Report

## Status: Fixes applied (build verification unavailable — missing system GTK/GLIB 2.70 deps in WSL)

## Fixes Applied

### 1. ws_types.rs — Added `Serialize` derive to 3 structs
- `GroupMessagePayload` (line 29): `#[derive(Debug, Deserialize, Serialize)]`
- `GroupUpdatedPayload` (line 56): `#[derive(Debug, Deserialize, Serialize)]`
- `MomentEventPayload` (line 194): `#[derive(Debug, Deserialize, Serialize)]`

### 2. alt_space.rs — Fixed imports
- Added `use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};`
- Removed unused `Emitter`, `Manager` from tauri import
- Added `#[cfg(feature = "global-shortcut")]` to `alt_space_shortcut()` helper function

### 3. lib.rs — Feature-gated global-shortcut plugin
- Changed unconditional `.plugin(tauri_plugin_global_shortcut::Builder::new().build())`
- To `#[cfg(feature = "global-shortcut")] .plugin(...)`

### 4. chat.rs:393 — Added missing Config import
- Added `use crate::config::Config;` to imports

### 5. engine.rs:335 — Added 7th argument to WsClient::new()
- In `cloud_loop()`, changed from 6 args to 7 args
- Added `None` as the 7th `app_handle` argument:
```rust
let ws = WsClient::new(
    ws_url,
    token,
    status_tx.clone(),
    consent.clone(),
    executor.clone(),
    cancel_token.clone(),
    None,  // app_handle — not available in cloud_loop
);
```

### 6. create.rs:126 — Removed invalid `.ok()` call
- Changed `rfd::FileDialog::new().pick_file().ok()` to just `.pick_file()`
- `pick_file()` already returns `Option<PathBuf>`, `.ok()` was redundant and would produce `Option<Option<PathBuf>>`

### 7. create.rs:74 — Fixed moved value `resp.status()`
- Saved `status` before consuming `resp.text()`:
```rust
if !resp.status().is_success() {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    return Err(format!("创建 Agent 失败 ({}): {}", status, body));
}
```

### 8. welcome.rs:253 — Same moved value pattern
- Applied identical fix for `get_permissions()`:
```rust
if !resp.status().is_success() {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    return Err(format!("获取权限失败 ({}): {}", status, body));
}
```

### 9. db.rs — Fixed rusqlite error handling in iterators
- `get_chat_history_by_agent` (line ~281): Changed to use explicit error conversion:
```rust
for row in rows {
    let msg = row.map_err(|e| format!("读取消息行失败：{e}"))?;
    messages.push(msg);
}
```
- `get_prompt_templates` (line ~482): Same pattern:
```rust
for row in rows {
    let tmpl = row.map_err(|e| format!("read template row failed: {e}"))?;
    templates.push(tmpl);
}
```

## Build Environment Note
Cannot verify compilation in current WSL — system has GTK 2.64.6 but Tauri 2 requires ≥ 2.70. The code changes follow the patterns specified in the mission and should compile correctly in a properly configured environment.
