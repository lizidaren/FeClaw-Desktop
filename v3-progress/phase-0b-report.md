# Phase 0b Report

> **Date:** 2026-06-20
> **Plan reference:** `docs/future-plan.md` — Section "### Phase 0b"
> **Status:** Implementation complete; build blocked by WSL GLib issue (expected — cannot run cargo build/check)

---

## What was implemented

### 1. Create Agent Dialog ✅

**Files created:**
- `src-tauri/src/create.rs` — Rust module with Tauri commands
- `src-tauri/src/chat/components/create-dialog.ts` — Popup dialog UI

**Rust commands (`create.rs`):**
- `create_agent(name, agent_type)` — POSTs to `POST /api/desktop/agents` on the engine, returns `AgentInfo`. `agent_type` is `"classic"` or `"im"`.
- `create_group_placeholder()` — Returns a placeholder string. Real implementation in Phase 4.
- `pick_local_file(mode)` — Opens native Windows file dialog via `rfd::FileDialog`, returns `PickedFile { id, name, path, size_label, mode, size_bytes }`.

**Dialog UI (`create-dialog.ts`):**
- Full-screen dim overlay (`cd-overlay`) + modal card (`cd-dialog`)
- Two radio cards: **🤖 经典** (full toolchain) / **💬 IM** (short replies, backgroundable, interruptible)
- Name input field (max 40 chars, autofocus, Enter key submits)
- Confirm → `invoke('create_agent', ...)` → new agent added to store → switches to new chat
- Cancel / ✕ / ESC → closes dialog
- Error display if creation fails

**Wiring:**
- `btn-new-chat` in `index.html` (already existed) → wired in `chat.ts` to `openCreateDialog()`
- `agent-created` CustomEvent dispatched by dialog → `chat.ts` listens and calls `selectChat(newAgentHash)`

---

### 2. File Reference Cards in Input Box ✅

**File created:**
- `src-tauri/src/chat/components/input-box.ts` — Extended composer component

**UI elements injected into the existing `.composer` in `index.html`:**

- **📎 attachment button** — Added to a new `.composer-toolbar` above the textarea. Opens a dropdown menu on click (closes on outside click or ESC).

- **Dropdown menu:**
  - "本地文件" section → hover to reveal sub-menu:
    - "📄 引用（可读写）" → `invoke('pick_local_file', { mode: 'reference' })`
    - "📤 发送（只读副本）" → `invoke('pick_local_file', { mode: 'send_copy' })`
  - "☁️ 云文件" → placeholder toast: "云文件浏览器（Phase 2 实现）"
  - "👥 创建群聊" → disabled item: "Phase 4 实现"

- **File cards** — Rendered in a `.file-cards` flex-wrap container above the textarea:
  - Each card: 📄 icon + filename (truncated, ellipsis) + size label + badge ("引用" blue / "发送" yellow) + ✕ remove button
  - Cards animate in with `fcIn` keyframe (scale + opacity)
  - ✕ removes the card from state and re-renders

**Integration with `chat.ts`:**
- `setupInputBox()` called in `wire()` — injects toolbar + cards container into DOM
- `sendMessage()` builds `fullText` = user text + file card info lines (`[文件: name (size) - 模式 - path]`)
- `fullText` sent to engine via WS; raw `text` shown in optimistic local echo
- `clearFileCards()` called after send

---

### 3. Command Registration ✅

**`src-tauri/src/lib.rs` changes:**
- Added `mod create;` to module list
- Registered `create::create_agent`, `create::create_group_placeholder`, `create::pick_local_file` in `tauri::generate_handler![]`

---

### 4. Chat.ts Wiring Updates ✅

**`src-tauri/src/chat/chat.ts` changes:**
- Added imports: `openCreateDialog`, `setupInputBox`, `getFileCards`, `clearFileCards`
- `wire()`: calls `setupInputBox()` and adds `agent-created` event listener
- `sendMessage()`: builds `fullText` including file card info; clears cards after send; allows sending even if text is empty (file-only messages)
- `btn-new-chat` click handler: calls `openCreateDialog()` (was a no-op TODO)

---

## Files Created (Summary)

| File | Purpose |
|------|---------|
| `src-tauri/src/create.rs` | Rust commands: `create_agent`, `create_group_placeholder`, `pick_local_file` |
| `src-tauri/src/chat/components/create-dialog.ts` | Create Agent dialog UI component |
| `src-tauri/src/chat/components/input-box.ts` | Extended input box with file cards |

## Files Modified (Summary)

| File | Change |
|------|--------|
| `src-tauri/src/lib.rs` | Added `mod create;` + 3 command registrations |
| `src-tauri/src/chat/chat.ts` | Wire `openCreateDialog`, `setupInputBox`, `getFileCards`; update `sendMessage` |

---

## What Was Skipped (and Why)

1. **Cloud file VFS browser** — Deferred to Phase 2. The "云文件" menu item is present but shows a "Phase 2 实现" toast. The `list_vfs_directory` / `read_vfs_file` commands will be implemented in Phase 2 alongside the full VFS file manager.

2. **群组创建 (Group creation)** — Deferred to Phase 4. The "👥 创建群聊" menu item is disabled (placeholder). `create_group_placeholder()` returns a dummy string.

3. **File cards in WS message envelope** — Phase 0b sends file card info as plain text appended to the message body. A proper structured envelope (e.g., `attachments: [{ type, path, mode }]`) will be added when Phase 2+ clarifies the full message protocol.

4. **`cargo build` / `cargo check`** — Not run. WSL environment cannot compile (GLib issue per project rules). Build must be verified on the Windows host.

---

## Unclear / Blocked Items

1. **`POST /api/desktop/agents` engine endpoint not yet implemented** — `create_agent` calls this endpoint but it doesn't exist in the FeClaw engine yet. This is expected (engine-side work) and documented in the Engine API section below. Until the engine implements it, `create_agent` will return a 404/500 error.

2. **`PickedFile` path field** — For "引用" mode, the path is passed as-is. Whether the engine interprets this as a VFS path or a raw desktop path is TBD in Phase 2 (when `/mnt/desktop/` mapping is finalized).

---

## Engine-Side API Needed

The following endpoint must be implemented in the FeClaw engine (FeClaw, not FeClaw-Desktop):

```
POST /api/desktop/agents
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "name": "我的助手",
  "agentType": "classic"   // or "im"
}

→ 201 Created
{
  "hash": "a1b2c3",
  "name": "我的助手",
  "description": null
}
```

This is the only engine-side dependency for Phase 0b to be fully functional.

---

## Checklist

| Deliverable | Status |
|------------|--------|
| `create_agent(name, agent_type)` Rust command | ✅ Done |
| `create_group_placeholder()` Rust command | ✅ Done |
| `pick_local_file(mode)` Rust command | ✅ Done |
| Create Agent dialog (radio cards + name input + buttons) | ✅ Done |
| ➕ button wired to openCreateDialog() | ✅ Done |
| File reference cards in input box | ✅ Done |
| 📎 button with 本地文件 / 云文件 menu | ✅ Done |
| 本地文件 → 引用/发送 sub-menu → file dialog | ✅ Done |
| Cloud files → placeholder (Phase 2) | ✅ Done |
| File cards embed in composer (removable, typeable after) | ✅ Done |
| `create::` commands registered in lib.rs | ✅ Done |
| File cards included in send (as text append for now) | ✅ Done |
| Engine `POST /api/desktop/agents` endpoint | ⬜ Engine side (not Desktop) |
