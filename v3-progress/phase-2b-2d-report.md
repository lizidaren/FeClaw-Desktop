# Phase 2B + 2D — File Viewers/Editors + WS Attachments Report

**Date:** 2026-06-20
**Status:** ✅ Implementation Complete

---

## Phase 2B — File Viewers/Editors

### Completion Checklist

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Image viewer with zoom | ✅ Done | Click toggles `scale(2)` zoom; cursor changes `zoom-in`/`zoom-out` |
| 2 | Image fullscreen button | ✅ Done | `⛶` button creates `viewer-fullscreen` overlay; click outside or `✕` to close |
| 3 | Image prev/next navigation | ✅ Done | Gallery built from same directory's image entries; `◀` `▶` buttons; counter `1 / N` |
| 4 | Markdown viewer (CDNless) | ✅ Done | Inline `renderMarkdown()` handles: headers, bold, italic, code, blockquote, lists, links, HR, tables |
| 5 | Markdown → edit toggle | ✅ Done | `[✏️ 编辑]` button in toolbar switches to `<textarea>`; `[👁️ 预览]` returns to rendered HTML |
| 6 | Code editor with line numbers | ✅ Done | `.code-editor-wrap` = line-nums column + scrollable `.code-editor-area` |
| 7 | Code syntax highlighting | ✅ Done | Inline `highlight()` with CSS classes: `.tok-keyword`, `.tok-string`, `.tok-comment`, `.tok-number`, `.tok-function`; language map for 12 languages |
| 8 | Tab → 4 spaces in code editor | ✅ Done | `keydown` handler intercepts `Tab`, inserts 4 spaces at cursor |
| 9 | Ctrl+S saves via presigned PUT | ✅ Done | Works in both code editor and markdown edit mode |
| 10 | Unsaved changes 3-button dialog | ✅ Done | Custom modal: `[保存]` `[不保存]` `[取消]`; ESC triggers cancel |
| 11 | Audio player for media files | ✅ Done | `<audio controls loop>` with file name + size + download button |
| 12 | Video player for media files | ✅ Done | `<video controls loop>` with max 60vh height; file name + size + download |
| 13 | Download-only for binary files | ✅ Done | `📎` icon + filename + size + big download button |
| 14 | File type detection | ✅ Done | 5 categories: image, video, audio, markdown, code, text, binary |
| 15 | Viewer toolbar actions | ✅ Done | Per-viewer `[💻 本地打开]` `[⬇ 下载]` `[✏️ 编辑]` buttons in `.viewer-actions` |
| 16 | Edit button for read-only code view | ✅ Done | Clicking `编辑` calls `reopenInEdit()` to switch to code editor |

### File Type → Viewer Mapping

| Extension(s) | Viewer |
|---|---|
| `png jpg jpeg gif webp svg bmp ico avif` | Image gallery viewer |
| `mp4 webm mov avi mkv` | Video player |
| `mp3 wav ogg flac aac m4a` | Audio player |
| `md markdown` | Markdown renderer + edit toggle |
| `py js ts rs go java c cpp h hpp css html json toml yaml yml xml sql sh bash rb php cs` | Code editor (syntax-highlighted) |
| `txt log csv ini conf` | Plain text editor (no syntax) |
| All others | Download button |

### Files Modified

#### `src-tauri/src/chat/file-manager.html`

**New CSS (appended to existing styles):**
- `.viewer-img-wrap` / `.viewer-img-nav` / `.viewer-img-counter` / `.viewer-img-toolbar` / `.viewer-img-btn` — image viewer chrome
- `.viewer-fullscreen` / `.viewer-fullscreen-close` — fullscreen overlay
- `.code-editor-wrap` / `.code-line-nums` / `.code-editor-area` / `.code-textarea` / `.code-highlight` + `.tok-*` tokens — code editor
- `.md-rendered` + sub-styles — rendered markdown
- `.media-player-wrap` / `.media-label` — audio/video
- `.dl-only-wrap` / `.dl-only-icon` / `.dl-only-name` / `.dl-only-size` — binary download view
- `.viewer-actions` / `.viewer-action-btn` — toolbar buttons
- Updated `.viewer-body` to support flex layout

**New JavaScript functions:**

| Function | Purpose |
|---|---|
| `getFileCategory(ext, contentType)` | Classifies file into: image/video/audio/markdown/code/text/binary |
| `renderMarkdown(src)` | CDNless markdown → HTML renderer (handles all common MD syntax) |
| `highlight(code, lang)` | Simple syntax highlighter with `.tok-*` spans; supports 12 languages |
| `buildImageViewer(dataUrl, path)` | Builds image gallery from current directory's image entries |
| `loadGalleryThumb(imgPath, idx)` | Preloads adjacent gallery images in background |
| `renderImageViewer()` | Renders image viewer DOM with nav controls |
| `buildCodeEditor(text, path)` | Builds line-numbered + highlighted code editor with Tab/Ctrl+S support |
| `toggleLineComment(ta, lang)` | Toggles `//` or `#` line comments |
| `buildMarkdownViewer(text, path)` | Renders markdown HTML with `[✏️ 编辑]` toolbar button |
| `switchMdEdit(path)` | Switches markdown view → textarea edit mode |
| `switchMdView(path)` | Switches markdown edit mode → rendered HTML view |
| `buildMediaPlayer(blob, path, category)` | Builds `<audio>` or `<video>` player |
| `buildBinaryView(path, size)` | Shows download-only card |
| `openFile(path, mode)` | Main dispatcher: determines category → calls appropriate builder |
| `showUnsavedDialog()` | Returns `Promise<"save"|"discard"|"cancel">` with custom modal |
| `closeViewer()` | Handles unsaved dialog → closes overlay |

**Window exports (for inline onclick):**
- `window["imageNav"]`, `window["toggleZoom"]`, `window["toggleFullscreen"]`
- `window["switchMdEdit"]`, `window["switchMdView"]`
- `window["reopenInEdit"]`, `window["saveFileContent"]`

---

## Phase 2D — WS Message Attachment Rendering

### Completion Checklist

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | `attachments[]` field in ChatMessage | ✅ Done | Added `attachments?: Attachment[]` to `store.ts` type |
| 2 | `Attachment` discriminated union type | ✅ Done | `{ type: "image" } \| { type: "file" } \| { type: "miniapp_card" }` |
| 3 | Image attachment inline rendering | ✅ Done | `<div class="attachment-image"><img class="attachment-thumb">` |
| 4 | VFS image loading (presigned URL → data:URL) | ✅ Done | `get_vfs_preview_url` → fetch blob → `blobToDataURL` |
| 5 | Image loading placeholder | ✅ Done | SVG placeholder while loading; error SVG on failure |
| 6 | Click image → fullscreen view | ✅ Done | `openFullView()` creates `.viewer-fullscreen` overlay |
| 7 | File attachment card | ✅ Done | `📄 name · size · [下载]` in `.attachment-file` card |
| 8 | File download from WS attachment | ✅ Done | VFS: `download_vfs_file` → save dialog; URL: direct anchor |
| 9 | Miniapp card rendering | ✅ Done | Preview image + title + app name + `[打开]` button |
| 10 | Miniapp open handler | ✅ Done | Logs to console (Phase 6 will implement deep linking) |
| 11 | `formatBytes()` helper | ✅ Done | Bytes → B/KB/MB/GB string |
| 12 | `blobToDataURL()` helper | ✅ Done | `FileReader` → base64 data URL |
| 13 | Attachment CSS in chat.css | ✅ Done | All `.msg-attachments`, `.attachment-image`, `.attachment-file`, `.attachment-miniapp` styles |

### Files Modified

#### `src-tauri/src/chat/store.ts`

Added to `ChatMessage` type:
```typescript
attachments?: Attachment[];

export type Attachment =
  | { type: "image"; source: "vfs" | "url" | "data"; path?: string; url?: string; data?: string; width?: number; height?: number }
  | { type: "file"; name: string; size: number; path?: string; url?: string }
  | { type: "miniapp_card"; title: string; app_name: string; preview_url?: string; path?: string };
```

#### `src-tauri/src/chat/chat.ts`

**New functions added to `renderMessageEl`:**
- After text content, checks `msg.attachments?.length` → calls `renderAttachment()` for each

**New module-level functions:**

| Function | Purpose |
|---|---|
| `renderAttachment(container, att, agentHash)` | Dispatches on `att.type` to image/file/miniapp_card renderer |
| `openFullView(src)` | Creates fullscreen overlay for inline images |
| `downloadAttachment(att, agentHash)` | Handles VFS path → `download_vfs_file` + save dialog, or direct URL anchor |
| `openMiniapp(path)` | Logs for now (Phase 6 deep linking TBD) |
| `formatBytes(bytes)` | Converts byte count to human-readable string |
| `blobToDataURL(blob)` | Converts Blob to base64 data: URL for inline image embedding |

#### `src-tauri/src/chat/chat.css`

**New CSS classes added:**

| Class | Purpose |
|---|---|
| `.msg-attachments` | Flex column container for attachment cards inside bubble |
| `.attachment-image` | Wrapper for inline image thumbnails |
| `.attachment-thumb` | The `<img>` inside attachment-image; hover opacity effect |
| `.attachment-file` | File card: icon + name + size + download button |
| `.af-icon` / `.af-name` / `.af-size` | File card internal layout |
| `.af-download` | Download button with hover highlight |
| `.attachment-miniapp` | Card for miniapp: preview + info + open button |
| `.am-preview` / `.am-info` / `.am-title` / `.am-app` / `.am-open` | Miniapp card internals |
| `.viewer-fullscreen` / `.viewer-fullscreen-close` | Fullscreen image overlay (shared with file-manager) |

---

## Architecture Notes

### Markdown Rendering (CDNless)
`renderMarkdown()` is a self-contained ~50-line regex-based parser. It handles all common GitHub-flavored MD syntax:
- Fenced code blocks with language tag
- Inline code, bold, italic
- Headers (h1–h6)
- Blockquotes
- Ordered and unordered lists
- Links and images
- Horizontal rules

No external CDN dependency — works fully offline.

### Syntax Highlighting (CDNless)
`highlight()` applies CSS class tokens via regex replacements. Supports 12 languages with accurate keyword lists:
- Python, JavaScript/TypeScript, Rust, Go, Java, C/C++, HTML, CSS, JSON, TOML/YAML, SQL, Bash/Zsh, Ruby, PHP, C#

Language detection via file extension → `LANG_MAP` lookup.

### WS Attachments Flow
```
WS message with attachments[]
  → renderMessageEl()
    → renderAttachment(att, agentHash)
      → type=image:
          source=vfs → invoke("get_vfs_preview_url") → fetch blob → blobToDataURL → <img>
          source=url → <img src=url>
          source=data → <img src=data:...>
      → type=file: → .attachment-file card → downloadAttachment()
      → type=miniapp_card: → .attachment-miniapp card → openMiniapp()
```
