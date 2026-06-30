# Fix P0/P1 issues from Desktop audit (Phase 1-5)

## Issue 1: CSP = null (P0)
**File**: `src-tauri/tauri.conf.json`
**Current**: `"csp": null`
**Fix**: Add a proper CSP. Minimum:
```json
"csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; connect-src 'self' https: wss:;"
```
Note: `style-src 'unsafe-inline'` is needed because Tauri 2's own injected styles use inline style. DO NOT add `'unsafe-inline'` for scripts.

## Issue 2: chat.js running in production lacks XSS protections (P0)
**Context**: The app loads `chat.js` at runtime (not `chat.ts`). The `.js` file lacks:
- `pickSafeImageSrc` MIME whitelist (allows `data:image/svg+xml` which is an XSS vector)
- `renderMarkdown` + DOMPurify for message rendering
- `escapeHtml` properly applied in template strings

**Fix approach**: Edit `chat.js` directly (since that's what actually runs):
1. Add `pickSafeImageSrc()` function (same as `.ts`: only allow png/jpeg/jpg/gif/webp)
2. Use it in the avatar and image URL generation (line ~225 where `img.src = msg.content`)
3. Apply `escapeHtml` to `item.avatar_url` in the template string where it's interpolated

Don't try to merge .ts into .js - just patch the gaps in .js.

## Issue 3: vfs_rm missing consent dialog (P1)
**Context**: `vfs_rm` in `file_manager.rs` is listed in `dangerous.json` capability but doesn't call the consent dialog before executing. Other dangerous operations like `file_delete` use `guard.request_operation(Operation::L3, &path)`.

**Fix**: In `src-tauri/src/chat/file_manager.rs`, add consent check before the vfs_rm HTTP call. Follow the same pattern as `file_delete` in `file_ops.rs`.

## Do NOT modify
- Don't touch ts files (they're reference only, not what runs)
- Don't change UI layout or add new features
- Don't modify capability JSON files
- Focus only on the 3 issues above
