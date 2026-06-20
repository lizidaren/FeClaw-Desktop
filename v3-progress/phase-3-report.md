# Phase 3 Report — Windows Right-Click Menu

## Summary

Implemented Windows shell right-click context menu integration for FeClaw-Desktop V3 Phase 3. Users can right-click any file in Windows Explorer and send/reference it directly to a FeClaw Agent.

---

## What was implemented

### 1. Registry Manager (`src-tauri/src/right_click.rs`)

New module exposing four Tauri commands:

| Command | Description |
|---------|-------------|
| `register_right_click(exe_path)` | Writes `HKCU\Software\Classes\*\shell\FeClawReference` and `FeClawSend` registry keys |
| `unregister_right_click()` | Deletes both registry keys (best-effort) |
| `is_right_click_registered()` | Returns `true` if both keys exist |
| `get_executable_path()` | Returns `std::env::current_exe()` for building command strings |

**Registry structure:**
```
HKCU\Software\Classes\*\shell\FeClawReference
  (Default) = "📎 FeClaw 引用"
  Icon     = "<exe_path>"
  command\(Default) = "<exe_path>" --right-click reference "%1"

HKCU\Software\Classes\*\shell\FeClawSend
  (Default) = "📤 FeClaw 发送"
  command\(Default) = "<exe_path>" --right-click send "%1"
```

**Non-command helper:**
- `handle_right_click_invocation(mode, path)` — validates the path, writes `~/.feclaw/pending-right-click.json`, called from `main.rs` before the GUI starts.

### 2. CLI Args Parsing (`src-tauri/src/main.rs`)

Updated `main()` to intercept `--right-click <mode> <filepath>` before calling `run()`:

```rust
if args.len() >= 4 && args[1] == "--right-click" {
    let mode = &args[2];
    let path = &args[3];
    feclaw_desktop_lib::handle_right_click_invocation(mode, path)?;
    // Proceed to normal GUI startup
}
```

### 3. Startup Integration (`src-tauri/src/lib.rs`)

- Added `right_click` module and registered 4 new commands in `invoke_handler`
- Added `pub use right_click::handle_right_click_invocation` for main.rs access
- In the `setup` closure: after `startup()` succeeds, calls `right_click::take_pending_right_click()` and emits `right-click-pending` Tauri event to the frontend (with 500ms delay to let the UI initialise)

### 4. Send Dialog UI (`src-tauri/src/chat/components/send-dialog.ts`)

New modal component (`openSendDialog(pending: PendingFile)`):

```
┌── 发送文件 ────────────────────┐
│ 📄 复习计划.pdf  (2.3 MB)       │
│                                 │
│ 发送方式：                      │
│ ○ 📎 引用（Agent 可读写）        │
│ ● 📤 发送（只读副本）            │
│                                 │
│ 发送到：                        │
│ [我的数学助手 ▼]                │
│                                 │
│ 附加消息（可选）：               │
│ [                          ]   │
│                                 │
│              [取消]  [发送]      │
└─────────────────────────────────┘
```

**Features:**
- File icon inferred from extension (📄 PDF, 🖼️ images, 🐍 Python, etc.)
- File size via `fetch("file://...")` (with fallback to "未知大小")
- Radio buttons for mode selection (reference / send_copy)
- Agent dropdown pre-populated from `store.agents`
- Textarea with Ctrl+V image paste support (uses existing `save_temp_image`)
- Cancel closes dialog; Send adds file card to composer, switches agent, sets message text

### 5. Frontend Wiring (`src-tauri/src/chat/chat.ts`)

- Added `openSendDialog` import from `./components/send-dialog`
- Added `right-click-pending` event listener in `subscribeEvents()` → calls `openSendDialog(pending)`

### 6. Dependencies (`src-tauri/Cargo.toml`)

Added `winreg = "0.55"` for Windows registry operations.

---

## File changes

| File | Change |
|------|--------|
| `src-tauri/src/right_click.rs` | New — registry manager module |
| `src-tauri/src/main.rs` | Updated — CLI args parsing before `run()` |
| `src-tauri/src/lib.rs` | Updated — module declaration, command registration, startup check |
| `src-tauri/Cargo.toml` | Updated — added `winreg = "0.55"` |
| `src-tauri/src/chat/components/send-dialog.ts` | New — send dialog UI component |
| `src-tauri/src/chat/chat.ts` | Updated — import and event listener for send dialog |

---

## Design notes

- **Path canonicalisation**: `handle_right_click_invocation` calls `Path::canonicalize()` to resolve the `%1` argument (which may contain `\` or `/` separators, relative components, etc.) before writing the pending file.
- **Pending file cleanup**: `take_pending_right_click()` reads and then deletes the pending file regardless of success/failure, so stale files don't persist across restarts.
- **Fallback for large files**: `send-dialog.ts` tries to get file size via `fetch("file://...")` — this works for local files but may fail for very large files. Size is informational only; no hard limit is enforced in the dialog.
- **Image paste in message**: Reuses the existing `save_temp_image` invoke call with the same base64 paste mechanism from Phase 1.
- **No circular dependency**: `send-dialog.ts` uses a dynamic `await import("../chat")` to call `selectChat()`, avoiding a static import cycle with `chat.ts`.

---

## Not implemented (deferred)

- Settings UI toggle for "Enable right-click menu" (can be wired to `register_right_click` / `unregister_right_click`)
- Registration on first install (needs a post-install step or explicit user opt-in)
