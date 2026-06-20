# Phase 5 Desktop Report — Group Moments UI (群广场)

## Overview

Implemented the "📱 广场" (Moments) tab for FeClaw Desktop, enabling users to browse, filter, and manage group moment posts across all groups. Moments are real-time and sync via WebSocket push.

## Changes by File

### `src-tauri/src/chat/index.html`
- Added "📱 广场" tab button between "💬 聊天" and "🙋 我的" in the left tab bar
- Added `#moments-feed` container inside the middle panel (`.chat-list-panel`), hidden by default
  - Filter bar with `#moments-group-filter` dropdown
  - `#moments-list` for moment cards, with `#moments-empty` empty state
- Added `#moments-toast` notification element fixed at bottom-center

### `src-tauri/src/chat/store.ts`
- Extended `TabId` to include `"moments"`
- Added `MomentInfo` type (mirrors `MomentInfo` Rust struct):
  ```typescript
  export type MomentInfo = {
    id: string; group_id: string; group_name?: string;
    agent_hash?: string; agent_name?: string; kind: string;
    title: string; content: string; attachments: Attachment[]; created_at: number;
  };
  ```
- Added store fields: `moments: MomentInfo[]`, `momentsGroupFilter: string | null`
- Added store methods:
  - `setMoments(moments)` — replaces all moments
  - `addMoment(moment)` — prepends a new moment (for WS push)
  - `setMomentsGroupFilter(groupId)` — sets the active group filter
  - `getMoments()` — returns filtered or all moments

### `src-tauri/src/chat/components/moments-feed.ts` [NEW]
- `buildMomentCard(moment)` — builds a `.moment-card` element:
  - Kind icon (✅ 📁 🔍 🤝 ✍️)
  - Group name (clickable → navigates to group chat)
  - Agent name + relative time
  - Title (bold) + content snippet
  - Attachment chips (📄 file, 🖼️ image)
- `renderMomentsFeed(moments)` — renders the full list
- `populateGroupFilter()` — populates the dropdown from `store.groups`
- `refreshMoments()` — calls `get_moments` Rust command
- `showMomentsFeed(groupId?)` — shows feed, optionally filtered
- `hideMomentsFeed()` — hides feed, restores chat list panel
- `addMomentCard(moment)` — adds a single card at top of list + shows toast
- `showMomentToast(moment)` — brief bottom toast notification
- `wireMomentsFeed()` — wires the filter dropdown change event
- Store subscription re-renders feed whenever `moments` changes and tab is active

### `src-tauri/src/chat/chat.ts`
- Updated imports to include `MomentInfo`, `showMomentsFeed`, `hideMomentsFeed`, `addMomentCard`, `wireMomentsFeed`, `refreshMoments`
- Updated `switchTab` to handle `"moments"`:
  - Hides active chat, calls `showMomentsFeed()`
  - When switching away from moments back to chat, restores active chat
- Added `hideActiveChat()` helper
- Updated `selectGroup` to detect if called from moments tab and switch back to chat tab before activating group
- Added `moments-event` Tauri listener in `subscribeEvents`:
  - Parses `MomentEventPayload` into `MomentInfo`
  - Calls `store.addMoment(moment)`
  - If on moments tab: store subscription re-renders
  - If elsewhere: calls `addMomentCard(moment)` to show toast
- Updated `btn-chat-menu` ⋮ button handler:
  - If `store.activeGroupId` is set (group chat): navigates to moments tab filtered by that group
  - Otherwise: opens agent side panel as before
- Calls `wireMomentsFeed()` in `wire()`

### `src-tauri/src/moments.rs` [NEW]
- `MomentInfo` struct matching the TypeScript type
- `get_moments(group_id: Option<String>)` → `GET /api/user/moments?group_id=xxx`
- `post_moment(group_id, title, content)` → `POST /api/user/moments`
- `delete_moment(group_id, moment_id)` → `DELETE /api/groups/{id}/moments/{mid}`
- All commands use JWT from `local-credentials` file (same pattern as `group.rs`)

### `src-tauri/src/ws_types.rs`
- Added `MomentsEvent` variant to `WsRequest` enum:
  ```rust
  #[serde(rename = "moments_event")]
  MomentsEvent {
      #[serde(rename = "group_id")]
      group_id: String,
      #[serde(default)]
      data: Option<MomentEventPayload>,
  }
  ```
- Added `MomentEventPayload` struct for the nested data

### `src-tauri/src/ws.rs`
- Added `WsRequest::MomentsEvent` handling in `handle_message`:
  - Emits `moments-event` Tauri event to frontend

### `src-tauri/src/lib.rs`
- Added `mod moments;`
- Registered `moments::get_moments`, `moments::post_moment`, `moments::delete_moment` in `invoke_handler`

### `src-tauri/src/chat/chat.css`
- `.moments-feed` — feed container (flex column, full height)
- `.moments-filter-bar` — filter bar with border
- `.moments-group-filter` — styled dropdown
- `.moments-list` — scrollable list with gap between cards
- `.moments-empty` — centered empty state text
- `.moment-card` — card with hover highlight and fade-in animation
- `.mc-header`, `.mc-meta`, `.mc-title`, `.mc-content`, `.mc-attachments` — card sub-elements
- `.moment-attachment-chip`, `.mac-icon`, `.mac-name` — file chip styling with hover effect
- `.moments-toast` — fixed bottom-center toast with opacity transition

## Architecture Notes

1. **Tab routing**: The `currentTab` state in store drives which view is shown. The middle panel switches between `.chat-list-panel` (chat list) and `.moments-feed` (moments list).

2. **Real-time sync**: WS `moments_event` messages from the engine are forwarded as Tauri events to the frontend. The `moments-event` listener in `subscribeEvents` converts the payload to a `MomentInfo` and calls `store.addMoment`. The store subscription in `moments-feed.ts` automatically re-renders if the user is on the moments tab.

3. **Group filter**: `store.momentsGroupFilter` is set when navigating from group ⋮ menu or changing the dropdown. `refreshMoments()` passes it to `get_moments` when reloading.

4. **Navigation from moments to chat**: Clicking a group name on a moment card fires `group-selected` custom event, which `chat.ts` handles by calling `selectGroup`. `selectGroup` detects it came from the moments tab and switches back to the chat tab before activating the group.

5. **Group ⋮ menu**: The `btn-chat-menu` handler now checks `store.activeGroupId`. If set (group chat context), it navigates to the moments tab filtered by that group instead of opening the agent side panel.

## Completion Checklist

| # | Criterion | Status |
|---|-----------|--------|
| 1 | "📱 广场" tab visible in left sidebar | ✅ |
| 2 | Moments feed shows cards from all groups | ✅ |
| 3 | Each card shows group, agent, kind, title, content, time | ✅ |
| 4 | Filter dropdown filters by group | ✅ |
| 5 | Card attachments render as clickable chips | ✅ |
| 6 | WS moments_event → real-time card addition | ✅ |
| 7 | Group ⋮ menu → "群广场" → filtered view | ✅ |
| 8 | Can create/delete moments (via API) | ✅ (Rust commands wired, UI needed for create/delete) |
