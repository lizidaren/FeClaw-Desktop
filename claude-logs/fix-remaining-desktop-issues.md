
Both fixes applied:

**Fix 1** (`chat/chat.js:661`): `chat-done` now calls `finalizeStreaming(id, null)` — removes `.streaming` class without touching content.

**Fix 2** (`config.rs`): Added `is_default` helper and `#[serde(default, skip_serializing_if = "...")]` to `port`, `host`, `ws_path`, and `engine_path`. In cloud mode, default-valued Local fields will no longer clutter the saved config, while old configs still deserialize correctly via `#[serde(default)]`.
