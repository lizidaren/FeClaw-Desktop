## Summary

Implemented the avatar upload feature across 5 files:

### Engine (already existed)
- **`/home/lch/Projects/FeClaw/routers/desktop_api.py:201-241`** - Already had `POST /api/desktop/agents/{hash}/avatar` endpoint

### Desktop Rust
- **`src-tauri/Cargo.toml:26`** - Added `multipart` feature to reqwest
- **`src-tauri/src/side_panel.rs:494-545`** - Added `upload_agent_avatar` command that:
  - Decodes base64 image data
  - Sends as multipart POST to Engine `/api/desktop/agents/{hash}/avatar`
  - Returns the VFS view URL
- **`src-tauri/src/lib.rs:229`** - Registered `upload_agent_avatar` in generate_handler

### Desktop JS/HTML/CSS
- **`src-tauri/src/chat/chat.js`**
  - Added `avatar_url` field to store's chatItems
  - Updated `renderChatList` to show `<img>` when avatar_url exists
  - Updated `showActiveChat` to show `<img>` in header avatar when avatar_url exists
  - Added `openAvatarPicker`, `closeAvatarModal`, `confirmAvatarUpload`, `wireAvatarModal` helper functions
  - Replaced URL prompt in 3-dot menu "avatar" action with file picker flow
- **`src-tauri/src/chat/index.html:195-218`** - Added hidden file input and avatar preview modal with side-by-side comparison
- **`src-tauri/src/chat/chat.css:2196-2290`** - Added styles for `.avatar-modal-overlay`, `.avatar-modal-card`, `.avatar-compare`, `.avatar-img`, etc.

### Next steps
Run `cargo check` in `src-tauri` to verify compilation, then deploy Engine changes via scp to the remote server.
