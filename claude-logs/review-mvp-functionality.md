# MVP Functionality Audit — FeClaw-Desktop (V3)

**Date:** 2026-06-22  
**Reviewer:** Ambient (subagent)  
**Scope:** Full end-to-end trace of V3 MVP features across Desktop + Engine

---

## Executive Summary

The Desktop client **cannot** complete the core chat flow in V3 MVP. There are **5 P0 blockers** and **3 P1 issues** that prevent the user from sending a message and receiving a reply. The most critical issue is that the Desktop sends `chat_message` to `/ws/desktop`, but the Engine's handler for that endpoint silently drops all `chat_message` types and never forwards them to the chat service.

---

## Trace Log: Full Code Path

### 1. `lib.rs:setup()` → Startup Flow ✅

- **File:** `src-tauri/src/lib.rs` lines ~250–300
- **Flow:** First-launch check → `Config::load()` → if no config: `welcome::open_welcome_window()` → else: `startup()` → on error: fallback to welcome window
- **Status:** ✅ Implemented correctly. Error handling falls back to welcome page (not error dialog).

### 2. `config.rs:load()` → Config Handling ✅

- **File:** `src-tauri/src/config.rs`
- **Flow:** Loads `~/.feclaw/config.toml`, creates with defaults if absent
- **Status:** ✅ Fully implemented. Handles Local/Cloud modes, WS URL building, JWT token storage.

### 3. `welcome.rs` → Welcome Window + Login ✅

- **File:** `src-tauri/src/welcome.rs`
- **Flow:** `check_first_launch()` → `open_welcome_window()` → `save_welcome_config()` (Official/Selfhosted/Local modes) → `check_cloud_health()`, `discover_well_known()`
- **Status:** ✅ Implemented. Official mode pre-fills `feclaw.lizidaren.cn`, selfhosted allows custom URL.

### 4. `settings.rs` → Settings Window, `cloud_login()` ✅

- **File:** `src-tauri/src/settings.rs`
- **Auth Flow:**
  1. POST `{login_url}/api/auth/login` with `{username, password}` → Platform access_token
  2. POST `{engine_url}/api/desktop/auth_exchange` with `{platform_token}` → FeClaw JWT
  3. Persist JWT + URLs to `config.toml`
- **Engine endpoint:** `POST /api/desktop/auth_exchange` ✅ exists in `routers/desktop_api.py`
- **Status:** ✅ Implemented. JWT exchange is correct.

### 5. `chat.rs:list_agents()` → Agent List ✅

- **File:** `src-tauri/src/chat.rs` (and `routers/desktop_api.py` on Engine)
- **Desktop:** `list_agents` Tauri command → `GET /api/desktop/agents` with Bearer JWT
- **Engine:** `GET /api/desktop/agents` ✅ exists in `routers/desktop_api.py`
- **Response:** `{hash, name, description, avatar_url, status, is_online, ...}`
- **Frontend:** `store.setAgents(agents)` → `renderChatList()` → clickable list
- **Status:** ✅ Fully functional.

### 6. `chat.rs:send_chat_message()` → Message Sending ❌

- **File:** `src-tauri/src/chat.rs` lines 130–175
- **Desktop sends:**
  ```json
  {
    "type": "chat_message",
    "id": "msg-...",
    "text": "user input",
    "timestamp": "..."
  }
  ```
  to `/ws/desktop` via the shared WS outgoing channel.
- **⚠️ CRITICAL:** The `agent_hash` is **NOT** included in the outbound envelope. The `agent_hash` is only in the `channel` field of the locally-persisted message (`im:{agent_hash}`). This is a problem because the Engine needs `agent_hash` to route the message.

### 7. `ws.rs:connect_tls()` → WS Connection ✅

- **File:** `src-tauri/src/ws.rs` lines ~125–175
- **URL:** `wss://{cloud_url}/ws/desktop?token={jwt}` ✅
- **Token:** Appended as `?token=xxx` query param ✅ (WS token auth fix is done)
- **Status:** ✅ Connection works correctly.

### 8. `ws.rs:run_inner()` → WS Message Loop ✅

- **File:** `src-tauri/src/ws.rs` lines ~260–530
- **Inbound handling (`handle_message`):**
  - `CommandExec` ✅ → spawns command exec
  - `FileRead/Write/Delete` ✅ → handled
  - `Notification` ✅ → logged
  - **`ChatReply`** ⚠️ → **only logged**, not emitted to frontend
  - **`ChatEvent`** ⚠️ → **only logged**, not emitted to frontend
  - **`GroupMessage`** ⚠️ → emitted as `group-message` event (P1, not MVP)
  - **`FileOperationRequest`** ⚠️ → logged (P1.2)
- **Heartbeat:** 30s ping / 35s pong timeout ✅
- **Reconnect:** 30 attempts, 1s delay ✅
- **Status:** ⚠️ Structure is correct but `ChatReply`/`ChatEvent` are not forwarded to frontend.

### 9. `create.rs` → Agent Creation ❌

- **File:** `src-tauri/src/create.rs`
- **Desktop calls:** `POST /api/desktop/agents` with `{name, agent_type}`
- **Engine:** `POST /api/desktop/agents` → **405 Method Not Allowed** (endpoint does not exist)
- **Fallback path:** Engine has `POST /api/console/agents` (agent_config_ui.py line 763) but Desktop doesn't use it
- **Status:** ❌ **P0 — create agent fails at MVP**

### 10. `chat/chat.js` → Frontend Rendering ✅

- **File:** `src-tauri/src/chat/chat.js` (compiled from `chat.ts`)
- **WS event listeners:**
  - `ws-status` / `connection-status` → connection indicator ✅
  - `chat-event` → renderEventPill (thinking, tool, done) ⚠️ never emitted by backend
  - `chat-stream` → streaming message rendering ⚠️ never emitted by backend
  - `group-message` → group chat (P1)
- **Status:** ✅ UI scaffolding is complete; events are not being emitted.

---

## P0 Blockers (MVP Cannot Work)

### Gap 1: `chat_message` is silently dropped by the Engine
- **Severity:** P0 — blocks MVP entirely
- **Files affected:**
  - Desktop side: `src-tauri/src/chat.rs:164` (sends `type: "chat_message"`)
  - Engine side: `routers/desktop_ws.py:72` (`handle_desktop_message` only handles `consent_response`, `pong`, `file_*_response`)
- **Root cause:** The Engine's `handle_desktop_message()` function in `desktop_ws.py` does not have a handler for `type == "chat_message"`. The message is received by the WS but silently falls through to the `else` branch (logged as "Unknown desktop message type" and discarded).
- **Fix required:**
  Option A (recommended): Add `chat_message` handling in `desktop_ws.py:handle_desktop_message` that forwards to the chat service (`WebChannelService` or equivalent) and sends back `chat_reply`/`chat_event` via `send_to_desktop()`.
  
  Option B: Change Desktop to send to `/api/chat/ws` (but this requires redesigning the WS connection architecture since `/api/chat/ws` is per-agent via Host header, while Desktop uses a single `/ws/desktop` connection).

---

### Gap 2: Engine has no `chat_reply`/`chat_event` sending mechanism for Desktop WS
- **Severity:** P0 — even if Gap 1 is fixed, replies won't reach the user
- **Files affected:**
  - Engine: `routers/desktop_ws.py` (only `send_to_desktop` for consent/file relay)
  - Engine: `services/desktop_relay.py` (only handles consent + file ops)
  - Desktop: `src-tauri/src/ws.rs:368-380` (receives but drops `ChatReply`/`ChatEvent`)
- **Root cause:** The Engine's chat service (`WebChannelService`) returns responses as SSE events (`token`, `done`, `error`) to the `/api/chat/ws` endpoint. There is no code path that converts these into `chat_reply`/`chat_event` types and sends them to the Desktop's `/ws/desktop` connection.
- **Fix required:**
  1. Engine needs a `send_chat_reply_to_desktop(agent_hash, user_id, reply_text)` function that uses `send_to_desktop()` with `{type: "chat_reply", id, text, agent, timestamp}`.
  2. Streaming events (`chat_event`) need to be batched/buffered and sent over the Desktop WS.
  3. Alternatively: Desktop should connect per-agent to `/ws/desktop/{agent_hash}` and the Engine should relay chat responses through that same connection.

---

### Gap 3: `POST /api/desktop/agents` missing on Engine
- **Severity:** P0 — agent creation fails
- **Files affected:**
  - Desktop: `src-tauri/src/create.rs`
  - Engine: `routers/desktop_api.py` (only `GET /api/desktop/agents` at line 140, no POST)
- **Fix required:** Add `POST /api/desktop/agents` to `routers/desktop_api.py`:
  ```python
  @router.post("/api/desktop/agents")
  async def create_agent(name: str, agent_type: str = "classic", user_id: int = Depends(get_current_user_id), db: Session = Depends(get_db)):
      # Create AgentProfile, generate hash, return {hash, name, status, ...}
  ```
  Note: Engine has `POST /api/console/agents` in `agent_config_ui.py` which is the Web console's endpoint — Desktop should either use that endpoint or the new `/api/desktop/agents` endpoint should be added.

---

### Gap 4: `chat_message` outbound lacks `agent_hash` in the WS envelope
- **Severity:** P1 (workaround exists: engine can extract from connection context)
- **Files affected:** `src-tauri/src/chat.rs:164`
- **Detail:** The outbound `chat_message` envelope is:
  ```json
  {"type": "chat_message", "id": "msg-...", "text": "...", "timestamp": "..."}
  ```
  No `agent_hash` is included. The Engine's `desktop_ws.py` global handler receives the message and `msg_agent = data.get("agent_hash") or data.get("agent")` would return `None`. However, for the `/ws/desktop/{agent_hash}` per-agent connection, the `agent_hash` is injected by the WebSocket handler (line 59: `data.setdefault("agent_hash", agent_hash)`).
- **Fix:** Desktop should either (a) connect to `/ws/desktop/{agent_hash}` per-agent, or (b) include `agent_hash` in the outbound message body.

---

### Gap 5: Desktop uses wrong message format for chat service
- **Severity:** P0 — protocol mismatch even if routing were fixed
- **Files affected:** `src-tauri/src/chat.rs:164` (Desktop sends), `routers/feclaw_chat.py` (Engine expects)
- **Desktop sends:**
  ```json
  {"type": "chat_message", "id": "msg-...", "text": "...", "timestamp": "..."}
  ```
- **Engine `/api/chat/ws` expects:**
  ```json
  {"content": "...", "session_id": "...", "image_url": "..."}
  ```
- **Engine `/ws/desktop` `handle_desktop_message` expects:** `consent_response`, `pong`, or `file_*_response`
- **Fix:** The Engine needs to add `chat_message` handling in `desktop_ws.py` that accepts the Desktop's format and internally calls the chat service.

---

## P1 Issues (Should Fix)

### Gap 6: `ChatReply` received but not persisted/emitted to frontend
- **Severity:** P1
- **Files affected:** `src-tauri/src/ws.rs:368-374`
- **Detail:** When a `chat_reply` is received over WS, it is only logged. It should be:
  1. Persisted to local SQLite (`db::insert_chat_message`)
  2. Emitted as `chat-event` Tauri event to frontend
- **Fix:** In `ws.rs:handle_message`, after matching `WsRequest::ChatReply`, call `chat::append_chat_message` and emit `chat-event` to the frontend.

### Gap 7: `ChatEvent` (streaming) received but not emitted to frontend
- **Severity:** P1
- **Files affected:** `src-tauri/src/ws.rs:375-381`
- **Detail:** `chat_event` with kinds `thinking`, `tool`, `message_chunk`, `message_end` are logged but not forwarded. The frontend has full rendering support (`chat-stream` listener in `chat.js` lines 640-690) but never receives events.
- **Fix:** Map `WsRequest::ChatEvent` to `chat-stream` Tauri event and emit to frontend.

### Gap 8: Group message `send_group_message` not handled by Engine
- **Severity:** P1 (group chat is should-have)
- **Files affected:** `src-tauri/src/chat.rs:179+` (sends `type: "send_group_message"`), `routers/desktop_ws.py` (no handler)
- **Detail:** Desktop sends `{"type": "send_group_message", "group_id": "...", "content": "..."}` but Engine's `handle_desktop_message` has no `send_group_message` case.
- **Fix:** Add `send_group_message` handling in `desktop_ws.py:handle_desktop_message`.

---

## P2 Issues (Nice to Have)

| # | Gap | Files | Severity |
|---|-----|-------|----------|
| 9 | Theme support: `set_theme` registered but not wired to CSS variables | `settings.rs`, frontend | P2 |
| 10 | Connection status dot: rendered in UI but may not update on WS disconnect | `chat.js`, `ws.rs` | P2 |
| 11 | Image paste: stored as draft marker but not actually sent as attachment | `chat.js:saveAndInsertImage` | P2 |

---

## MVP Checklist

### ✅ Must-have
| Feature | Status | Notes |
|---------|--------|-------|
| First launch → Welcome → Cloud login | ✅ | Works end-to-end |
| Auth flow: Platform → JWT → config | ✅ | `auth_exchange` works |
| Agent list from `GET /api/desktop/agents` | ✅ | Fully wired |
| Chat: Select agent → Send → Receive | ❌ | Gap 1+2+4+5 block this |
| WebSocket: Connect + heartbeat | ✅ | Works |
| Settings: change mode, view config | ✅ | Fully implemented |
| Create agent | ❌ | Gap 3 — 405 on `POST /api/desktop/agents` |
| Error handling: fail → welcome page | ✅ | Correct fallback behavior |

### 🟡 Should-have
| Feature | Status | Notes |
|---------|--------|-------|
| Group chat | ❌ | Gap 8 — not handled by Engine |
| File operations via WS relay | ✅ | Consent + file ops work |
| Connection status indicator | ⚠️ | UI ready, may need verification |
| Theme support (light/dark) | ⚠️ | Wired but CSS not verified |

---

## Priority Fix Order

1. **Fix 1:** Add `chat_message` handler in `desktop_ws.py:handle_desktop_message` that forwards to `WebChannelService`
2. **Fix 2:** Engine sends `chat_reply`/`chat_event` back via `send_to_desktop()` to Desktop's WS
3. **Fix 3:** Add `POST /api/desktop/agents` to Engine (`routers/desktop_api.py`)
4. **Fix 4:** Desktop: include `agent_hash` in outbound `chat_message` envelope (or connect per-agent)
5. **Fix 5:** Desktop: wire `ChatReply` → persist to DB + emit `chat-event` to frontend
6. **Fix 6:** Desktop: wire `ChatEvent` → emit `chat-stream` to frontend
7. **Fix 7:** Engine: add `send_group_message` handler in `desktop_ws.py`

---

## Summary of Engine Endpoints Availability

| Endpoint | Desktop Usage | Engine Status |
|----------|--------------|---------------|
| `POST /api/auth/login` | Platform login | ✅ Exists |
| `POST /api/desktop/auth_exchange` | JWT exchange | ✅ Exists |
| `GET /api/desktop/agents` | List agents | ✅ Exists |
| `POST /api/desktop/agents` | Create agent | ❌ **Missing (405)** |
| `GET /api/user/permissions` | Get permissions | ✅ Used by welcome.rs |
| `WS /ws/desktop` | Desktop WS connection | ✅ Accepts, but drops `chat_message` |
| `WS /api/chat/ws` | Engine chat WS | ✅ Works for Web clients only |
| `WS /ws/desktop/{agent_hash}` | Per-agent WS | ✅ Accepts, but drops `chat_message` |

---

*Generated by Ambient — MVP Functionality Audit, 2026-06-22*
