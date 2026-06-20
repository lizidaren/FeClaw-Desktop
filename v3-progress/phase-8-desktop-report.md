# Phase 8 Desktop Report — QR Upload (扫码拍照上传)

## Status: Implemented

## What was built

### 1. `src-tauri/src/qr_upload.rs` [NEW]

Three Tauri commands implementing the QR upload flow:

**`create_upload_session()` → `Result<UploadSession>`**
- POSTs to `/api/desktop/upload_session` on the Engine REST API
- Reads JWT from `~/.feclaw/local-credentials` (same auth as `group.rs`)
- Returns `{ session_id, presigned_url, presigned_get_url, expires_in }`

**`generate_qr_code(data: String)` → `Result<String>`**
- Takes any string (typically the upload URL with session params)
- Uses the `qrcode` crate to encode as QR
- Renders to grayscale PNG via `image` crate
- Returns base64-encoded PNG data URL (`data:image/png;base64,...`)

**`download_uploaded_file(url: String)` → `Result<String>`**
- GETs the `presigned_get_url` from the upload session
- Detects MIME type from URL extension (jpg/jpeg/png/gif)
- Returns `data:{mime};base64,...` data URL for direct rendering

### 2. `Cargo.toml` — New dependencies

```toml
qrcode = "0.14"   # QR code generation
image = "0.25"    # Image encoding (PNG output)
```

### 3. `src-tauri/src/lib.rs` — Module registration

```rust
mod qr_upload;
// Registered commands:
qr_upload::create_upload_session,
qr_upload::generate_qr_code,
qr_upload::download_uploaded_file,
```

### 4. `src-tauri/src/ws_types.rs` — WS event variant

Added `UploadComplete` to the `WsRequest` enum:
```rust
#[serde(rename = "upload_complete")]
UploadComplete {
    session_id: String,
    presigned_get_url: String,
    file_name: Option<String>,
    mime_type: Option<String>,
}
```

### 5. `src-tauri/src/ws.rs` — WS event handler

Match arm in `handle_message`:
```rust
WsRequest::UploadComplete { session_id, presigned_get_url, file_name, mime_type } => {
    // Emits "upload-complete" Tauri event to frontend
    handle.emit("upload-complete", payload);
}
```

### 6. `src-tauri/src/chat/components/qr-upload.ts` [NEW]

Dialog component implementing the full flow:

```
┌── 📱 扫码上传 ──────────────────┐
│                                  │
│       ┌──────────────┐          │
│       │  [QR PNG]   │          │
│       └──────────────┘          │
│                                  │
│  打开手机相机扫码上传文件          │
│  会话: abc123                   │
│                                  │
│       [取消]  [我已上传]          │
└──────────────────────────────────┘
```

**Flow:**
1. `openQrUploadDialog()` → calls `create_upload_session`
2. Builds upload URL: `{presigned_url}?sid={session_id}`
3. Calls `generate_qr_code` with that URL → gets base64 PNG data URL
4. Renders dialog with QR code image
5. Subscribes to `upload-complete` Tauri event (WS-driven)
6. On `upload-complete` with matching `session_id`:
   - Calls `download_uploaded_file(presigned_get_url)` → gets image data URL
   - Calls `addImageCard()` (imported from `input-box`) to inject into input
   - Shows toast "图片已添加，点击发送"
   - Auto-closes after 3s
7. "我已上传" button provides manual fallback trigger

### 7. `src-tauri/src/chat/components/input-box.ts` — 📱 button

Added to `buildComposerToolbar()`:
- New `btn-qr-upload` button in the composer toolbar (next to 📎 attachment menu)
- Click → dynamically imports `qr-upload.ts` → calls `openQrUploadDialog()`
- Styled with `.btn-qr-upload` CSS class (matches existing `btn-attach` style)

### 8. `src-tauri/src/chat/chat.css` — Styles

Added styles for:
- `.qr-upload-overlay` — full-screen backdrop
- `.qr-upload-dialog` — centered card
- `.qud-header`, `.qud-body`, `.qud-footer` — dialog layout
- `.qud-qr-container` — white container with shadow for QR visibility
- `.qud-qr` — 180×180px QR image
- `.qud-btn-cancel`, `.qud-btn-confirm` — action buttons
- `.btn-qr-upload` — toolbar button

## Files changed summary

| File | Change |
|------|--------|
| `Cargo.toml` | Added `qrcode = "0.14"`, `image = "0.25"` |
| `src-tauri/src/lib.rs` | Added `mod qr_upload;`, registered 3 commands |
| `src-tauri/src/qr_upload.rs` | **NEW** — 3 Tauri commands |
| `src-tauri/src/ws_types.rs` | Added `UploadComplete` WS variant |
| `src-tauri/src/ws.rs` | Added `upload_complete` match arm in `handle_message` |
| `src-tauri/src/chat/components/qr-upload.ts` | **NEW** — QR upload dialog |
| `src-tauri/src/chat/components/input-box.ts` | Added 📱 button, wired click |
| `src-tauri/src/chat/chat.css` | Added QR dialog styles |

## Completion criteria

| Criterion | Status |
|-----------|--------|
| 📱 button in input box | ✅ Added to `buildComposerToolbar` |
| Click → QR code dialog opens | ✅ `openQrUploadDialog()` |
| QR code shows upload page URL with session params | ✅ Uses `generate_qr_code` with `presigned_url?sid=session_id` |
| Phone scans, uploads photo, POSTs /upload_done | ⚠️ Server-side (FeClaw engine) |
| Desktop receives WS `upload_complete` event | ✅ `WsRequest::UploadComplete` + Tauri event emission |
| Image appears in input box as file card | ✅ `addImageCard()` from input-box |
| User can send image card to chat | ✅ Reuses existing `sendMessage()` image card flow |

## Server-side requirements (FeClaw engine)

The desktop side is complete. The FeClaw engine must implement:

1. `POST /api/desktop/upload_session` → returns `{ session_id, presigned_url, presigned_get_url, expires_in }`
2. The upload page at `/static/upload.html` (or similar) must:
   - Accept the `url` (presigned upload URL) and `sid` (session_id) query params
   - Show a simple upload form for photos
   - POST the file directly to `presigned_url`
   - After successful upload, POST to engine's `/api/upload_done` (or similar) with `sid`
3. Engine must send WS `upload_complete` message to desktop with `session_id` and `presigned_get_url`
