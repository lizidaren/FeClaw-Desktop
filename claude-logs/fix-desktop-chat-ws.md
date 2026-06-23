Done. All 4 changes have been committed:

**Summary of changes:**

1. **chat.rs** — Added `agent_hash: Option<String>` parameter to `send_chat_message`. The param is stored in `ChatMessage.agent` and included in the WS envelope JSON.

2. **ws.rs** — Wired `ChatReply` and `ChatEvent` in `handle_message()`:
   - `ChatReply`: constructs a `ChatMessage`, calls `persist_and_emit(handle, msg)` to persist + emit, then emits `chat-reply` Tauri event
   - `ChatEvent`: `kind=="token"` → emits `chat-event` with `delta`; `kind=="done"` → emits `chat-done` with `session_id`

3. **chat.js** — Updated `sendMessage` to pass `agentHash: store.activeAgentHash` in the invoke call. Added three event listeners in `subscribeEvents`: `chat-reply` (appends reply message), `chat-event` (handles streaming tokens via `appendStreamingMessage`), `chat-done` (finalizes streaming via `finalizeStreaming`).

4. The `#[tauri::command]` handler for `send_chat_message` in `lib.rs` already existed and required no changes.

Note: `cargo check` fails due to missing Linux system libraries (webkit2gtk, glib >= 2.70) in WSL2 — this is an environment issue, not a code issue. The rustfmt syntax check confirmed the code is syntactically valid Rust 2021.
