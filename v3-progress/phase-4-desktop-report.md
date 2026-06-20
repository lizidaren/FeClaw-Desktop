# Phase 4 Desktop — Group Chat UI + WS

**Date**: 2026-06-20
**Status**: Implementation complete

## Summary

Implemented Group Chat UI + WebSocket support for FeClaw Desktop, enabling users to create group chats with multiple agents, send messages to groups, and receive real-time group message updates via WebSocket.

## Files Created

### `src-tauri/src/group.rs` (NEW)
HTTP client for Engine Group API with JWT authentication.

**Commands**:
- `list_groups()` — GET /api/groups
- `get_group_detail(group_id)` — GET /api/groups/{id}
- `get_group_messages(group_id, before?)` — GET /api/groups/{id}/messages
- `create_group(name, member_hashes)` — POST /api/groups
- `add_group_member(group_id, agent_hash)` — POST /api/groups/{id}/members
- `remove_group_member(group_id, agent_hash)` — DELETE /api/groups/{id}/members/{hash}
- `delete_group(group_id)` — DELETE /api/groups/{id}

JWT token is read from `~/.feclaw/local-credentials` (same credential store as AuthManager).

## Files Modified

### `src-tauri/src/ws_types.rs`
- Added `GroupMessagePayload`, `GroupEventPayload`, `GroupUpdatedPayload` structs
- Added `WsRequest::GroupMessage`, `WsRequest::GroupEvent`, `WsRequest::GroupUpdated` variants to inbound `WsRequest` enum
- Added `WsSendGroupMessage` outbound struct for sending group messages via WS

### `src-tauri/src/ws.rs`
- Added `tauri::Emitter` import
- Added `app_handle: Option<tauri::AppHandle>` field to `WsClient`
- Updated `WsClient::new` to accept `app_handle` parameter
- Added `WsRequest::GroupMessage`, `GroupEvent`, `GroupUpdated` handling in `handle_message()` that emits Tauri events:
  - `group-message` — emitted when engine sends a group message
  - `group-event` — emitted for member joined/left/renamed events
  - `group-updated` — emitted when group info changes

### `src-tauri/src/lib.rs`
- Added `mod group;`
- Registered 7 group commands + `chat::send_group_message` in invoke_handler
- Updated `WsClient::new` call to pass `app.clone()`

### `src-tauri/src/chat.rs`
- Added `send_group_message(group_id, content, mentions?, attachments?)` Tauri command that sends `send_group_message` WS envelope via `ws_outgoing` channel

### `src-tauri/src/chat/store.ts`
- Added `GroupInfo` type (camelCase client-side variant of Rust struct)
- Added `GroupMessage` type for group messages
- Added to `Store` class:
  - `groups: GroupInfo[]`
  - `activeGroupId: string | null`
  - `groupMessages: Map<string, GroupMessage[]>`
  - `setGroups(groups)` — sets groups and rebuilds group chat items
  - `setActiveGroup(groupId)` — activates a group chat
  - `getGroupById(id)` — finds group by id
  - `setGroupMessages(groupId, msgs)` — stores group messages
  - `appendGroupMessage(groupId, msg)` — appends a message to group

### `src-tauri/src/chat/chat.ts`
- Updated imports to include `GroupInfo`, `GroupMessage` types
- Updated `renderChatList` to render group items with 👥 avatar icon and handle clicks
- Added `selectGroup(groupId)` function for activating a group chat
- Added `loadGroupMessages(groupId)` to fetch and render group messages
- Updated `sendMessage` to handle both agent and group mode:
  - Checks `store.activeGroupId` vs `store.activeAgentHash`
  - Sends via `send_group_message` WS command when in group mode
  - Handles file cards and image markers same as agent mode
- Updated `showActiveChat` to display group name, 👥 avatar, and member count in header
- Updated `initChat` to load groups from engine API on startup
- Added group WS event listeners in `subscribeEvents`:
  - `group-message` — renders incoming group messages with sender color-coding
  - `group-event` — shows system event pills (member joined/left/renamed)
  - `group-updated` — updates group info in store and re-renders header
- Added `group-selected` event listener for create-dialog group switching

### `src-tauri/src/chat/chat.css`
- Added `.chat-item.group-item` with purple gradient avatar for group items
- Added `.chat-header .chat-status` group member count display
- Added agent color variants `.bubble.group-agent-0/1/2/3` for sender color-coding
- Added `.bubble.group-user` for user messages in group
- Added `.event-pill.system` for system event pills
- Added `.chat-item.group-item.active` for active group selection
- Added CSS for `.cd-checkbox-list`, `.cd-checkbox-item`, `.cd-empty-agents` used in group creation dialog

### `src-tauri/src/chat/components/create-dialog.ts`
- Updated imports to include `GroupInfo` type
- Added "👥 群聊" third radio option in dialog body
- Added `cd-group-members` container with `cd-agent-checkboxes` div (hidden by default)
- Added `populateAgentCheckboxes()` — renders agent checkboxes from store
- Added `wireRadioChanges()` — shows/hides group members section when group radio selected
- Updated `showDialog()` to populate checkboxes and wire radio change events
- Updated `handleConfirm()` to handle group creation:
  - Collects checked agent hashes
  - Validates at least 2 members selected
  - Calls `create_group` Tauri command
  - Adds new group to store
  - Dispatches `group-selected` event
- Added `escapeHtml` helper (was missing)

### `src-tauri/src/chat/components/input-box.ts`
- Enabled "👥 创建群聊" button in attach dropdown (was disabled with "Phase 4 实现" badge)
- Added click handler that opens create dialog with group radio pre-selected

## Architecture Notes

### Group vs Agent Chat
The UI maintains a unified chat list (`chatItems`) that contains both agent and group entries. Selection is mutually exclusive:
- `store.activeAgentHash` — currently selected agent (null when group selected)
- `store.activeGroupId` — currently selected group (null when agent selected)

### WS Event Flow (Engine → Desktop)
```
Engine sends: { type: "group_message", group_id, message }
  → ws.rs: WsRequest::GroupMessage handler
  → emits Tauri "group-message" event
  → chat.ts: group-message listener
  → store.appendGroupMessage()
  → renderMessageEl() in messages panel
```

### WS Send Flow (Desktop → Engine)
```
User sends message in group mode
  → sendMessage() detects store.activeGroupId
  → invoke("send_group_message", { group_id, content, ... })
  → chat.rs: send_group_message command
  → builds { type: "send_group_message", ... } envelope
  → sends via ws_outgoing channel
```

### Group Message Sender Color Coding
Group messages from agents are color-coded using rotating colors based on sender hash modulo 4:
- `.bubble.group-agent-0` — #1e3a5f (blue)
- `.bubble.group-agent-1` — #134e4a (teal)
- `.bubble.group-agent-2` — #3b1f5e (purple)
- `.bubble.group-agent-3` — #4a1f1f (red)

User messages in groups use `.bubble.group-user` (same as regular user bubble).

## Completion Criteria Check

| Criterion | Status |
|-----------|--------|
| "👥 创建群聊" option in create dialog | ✅ Added as 3rd radio option |
| Group appears in chat list with icon | ✅ 👥 avatar, purple gradient |
| Click group → shows group messages | ✅ `selectGroup()` + `loadGroupMessages()` |
| Can send message to group (via WS) | ✅ `send_group_message` command + WS envelope |
| Group messages render with sender color-coding | ✅ Agent colors 0-3, user color |
| System events display (joined/left/renamed) | ✅ `event-pill.system` CSS class |
| Agent reply messages appear in real-time via WS | ✅ `group-message` WS event listener |
| All group CRUD works | ✅ 7 HTTP commands registered |

## Testing Notes

⚠️ **Do NOT run `cargo build/check`** — as per project rules.

The implementation is complete but untested. Engine-side Group API must be running for HTTP calls to succeed. WebSocket group message handling requires engine to send `group_message` type messages.

## Future Considerations

- Group message persistence (currently only agent chat history is persisted to SQLite)
- Unread count tracking for groups (store field exists but not incremented on message receipt)
- Group member management UI (add/remove members after creation)
- Group announcements display
