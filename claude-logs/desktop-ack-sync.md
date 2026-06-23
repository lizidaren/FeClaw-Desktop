All changes have been implemented. Here's a summary:

## Changes Made

### 1. `src-tauri/src/ws_types.rs`
Added `ChatAck` variant to `WsRequest` enum:
```rust
#[serde(rename = "chat_ack")]
ChatAck {
    id: String,
},
```

### 2. `src-tauri/src/ws.rs`
Added handler for `chat_ack` messages after the `Pong` handler, emits `chat-ack` event to frontend.

### 3. `src-tauri/src/chat/chat.js`
- **Message state machine**: Added `status: "pending"` to new user messages in `sendMessage()`
- **Spinner**: Added ⏳ spinner rendering in `renderMessageEl()` for pending user messages
- **chat-ack listener**: Marks message as `sent` and removes spinner when Engine sends ack
- **chat-reply listener**: Marks corresponding user message as `done` when reply arrives

### 4. `src-tauri/src/db.rs`
Added `sync_chat_history` async Tauri command that:
1. Gets agent list from Engine API
2. For each agent, gets last local message ID
3. Calls `GET /api/desktop/messages?agent_hash=x&after_id=n`
4. Inserts new messages into local SQLite DB
5. Emits `chat-history-synced` event to frontend with synced messages

### 5. `src-tauri/src/lib.rs`
- Registered `db::sync_chat_history` command in invoke handler
- Added trigger in cloud-mode status pump: when WS status becomes `Connected`, calls `sync_chat_history` (with `sync_done` flag to prevent duplicate syncs)

---

**Note**: Cannot verify compilation locally — the project uses `cargo_bridge.sh` which cross-compiles via a Windows host. The code follows existing patterns and should compile correctly.
