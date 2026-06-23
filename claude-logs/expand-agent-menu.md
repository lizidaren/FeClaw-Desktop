All changes are complete. Here's a summary:

**Rust changes:**

1. **`src-tauri/src/side_panel.rs`** — Added `update_agent_settings` command (lines 451-492) that PATCHes `{alias, is_pinned, is_dnd, permission_mode}` to `/api/user/agents/{hash}/settings`. Handles both local and cloud modes.

2. **`src-tauri/src/lib.rs`** — Registered `side_panel::update_agent_settings` in `generate_handler![]`.

**JS changes in `src-tauri/src/chat/chat.js`:**

1. Added `is_pinned`, `is_dnd`, and `permission_mode` fields to `chatItems` in `setAgents()`

2. Added `showToast()` helper function for user feedback

3. Replaced the 3-dot menu HTML with new options: config, rename, pin, dnd, permission, divider, avatar, delete

4. Action handlers:
   - `config` → `invoke("open_agent_config", ...)` (existing)
   - `rename` → `prompt()` for new name → `invoke("update_agent_settings", { alias })` → updates `store.chatItems`
   - `pin` → toggles → `invoke("update_agent_settings", { isPinned })` → updates store
   - `dnd` → toggles → `invoke("update_agent_settings", { isDnd })` → updates store
   - `permission` → cycles through `strict/balanced/relaxed/full` → `invoke("update_agent_settings", { permissionMode })`
   - `avatar` / `delete` → `showToast("即将支持")`
