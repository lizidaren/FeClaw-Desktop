# Phase 6 — FeHub Mini-program UI

## Overview

Implemented the FeHub tab in the FeClaw Desktop application, allowing users to browse and launch their published mini-programs (miniapps) from a dedicated panel.

## Changes

### 1. New Rust module: `src-tauri/src/fehub.rs`

**`PublishInfo` struct:**
```rust
pub struct PublishInfo {
    pub id: String,
    pub agent_hash: String,
    pub app_name: String,
    pub tag: String,
    pub is_public: bool,
    pub created_at: u64,
}
```

**Commands:**
- `list_my_publishes()` — GET `/api/fehub/apps` with JWT auth; returns `Vec<PublishInfo>`
- `open_miniapp(app_name)` — resolves agent_hash from publish list, then opens a Tauri `WebviewWindow` at:
  - Cloud: `https://{agent_hash}.feclaw.lizidaren.cn/apps/{app_name}/`
  - Local: `http://127.0.0.1:{port}/apps/{app_name}/`

### 2. `lib.rs` — module + command registration

- Added `mod fehub;`
- Registered `fehub::list_my_publishes` and `fehub::open_miniapp` in `invoke_handler`

### 3. `src-tauri/src/chat/store.ts` — state

- `TabId` type extended: `"chat" | "moments" | "profile" | "settings" | "fehub"`
- Added `PublishInfo` type
- Added `publishes: PublishInfo[]` state field
- Added `setPublishes(publishes: PublishInfo[])` method

### 4. New component: `src-tauri/src/chat/components/fehub-tab.ts`

Public API:
- `showFehubTab()` — show the FeHub panel, hide chat/moments
- `hideFehubTab()` — hide the FeHub panel
- `refreshFehubTab()` — call `list_my_publishes` and re-render

Features:
- Loading state while fetching
- Empty state with "从模板创建" CTA button
- Published app cards: icon, name, version tag, visibility badge (🌐 公有 / 🔒 私有), date, action buttons
- "打开" button → calls `open_miniapp` Rust command, opens a new WebviewWindow
- "发布新版本" button → opens publish dialog with tag input + public/private radio
- "转为私有" / "公开" toggle button
- Publish dialog: modal overlay, tag input, visibility radio buttons, confirm/cancel

### 5. `src-tauri/src/chat/index.html`

- Added FeHub tab button (`data-tab="fehub"`) in the tab bar between "广场" and "我的"
- Added FeHub panel HTML inside `chat-list-panel`:
  ```html
  <div class="fehub-panel" id="fehub-panel" style="display:none;">
    <div class="fehub-header">...</div>
    <div class="fehub-content" id="fehub-content"></div>
  </div>
  ```

### 6. `src-tauri/src/chat/chat.ts`

- Imported `showFehubTab`, `hideFehubTab` from `fehub-tab`
- Updated `switchTab()` signature to include `"fehub"` tabId
- Added FeHub case in `switchTab`: hides active chat + moments, shows FeHub panel
- Updated tab button click handler type to include `"moments" | "fehub"`

### 7. `src-tauri/src/chat/chat.css`

Added styles for:
- `.fehub-panel`, `.fehub-header`, `.fehub-content` — panel layout
- `.fehub-empty` / `.fehub-empty-icon` — empty state
- `.fehub-loading` — loading indicator
- `.fehub-list` — card list container
- `.fehub-card` — miniapp card with hover effect
- `.fehub-card-icon`, `.fehub-card-info`, `.fehub-card-name`, `.fehub-card-meta`, `.fehub-card-tag`, `.fehub-card-date`, `.fehub-card-actions`
- `.fehub-visibility-badge.public` / `.fehub-visibility-badge.private` — colored badges
- `.fehub-btn`, `.fehub-btn-open` — action buttons
- `.fehub-footer` — create button footer
- `.fehub-dialog-overlay`, `.fehub-dialog`, `.fehub-dialog-header`, `.fehub-dialog-body`, `.fehub-dialog-footer`, `.fehub-dialog-field`, `.fehub-dialog-label`, `.fehub-dialog-input`, `.fehub-dialog-visibility`, `.fehub-visibility-option` — publish dialog styles

## Completion Criteria

| Criteria | Status |
|----------|--------|
| "🏗️ FeHub" tab exists in sidebar | ✅ |
| Published apps list loads from API | ✅ |
| Each app shows name, version, visibility, timestamp | ✅ |
| "Open" launches WebviewWindow with miniapp URL | ✅ |
| Publish dialog (tag + public/private toggle) | ✅ |
| FeHub tab integration with store | ✅ |

## Notes

- The `open_miniapp` Rust command fetches `PublishInfo` first to resolve the agent_hash needed for the cloud URL. This requires an extra HTTP call; could be optimized by caching publishes or passing agent_hash from the frontend.
- The "发布新版本" dialog's confirm button is wired to a `TODO` log — the corresponding `publish_new_version` Rust command is not yet implemented.
- The visibility toggle button is wired to a `TODO` log — the corresponding `set_publish_visibility` Rust command is not yet implemented.
