全部三个问题已修复。

## 修改总结

**Issue 1 — CSP (`src-tauri/tauri.conf.json:23`)**
将 `csp: null` 替换为策略化 CSP：
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; connect-src 'self' https: wss:;
```
脚本 `script-src` 不含 `'unsafe-inline'`；`'unsafe-inline'` 只用于 `style-src`（Tauri 2 注入的内联样式所需）。

**Issue 2 — chat.js XSS 修复**
- 新增 `SAFE_IMAGE_MIMES` + `pickSafeImageSrc()`（与 chat.ts 一致），拒绝 `data:image/svg+xml` 等危险 MIME
- `renderMessageEl` (chat.js:225-248)：图像消息先用 `pickSafeImageSrc` 过滤，未通过则降级为 `[图片类型不支持预览]` 文本
- `renderChatList` (chat.js:119-125)：`item.avatar_url` 先经 `pickSafeImageSrc` 再 `escapeHtml` 注入模板
- `showActiveChat` 与 `wireAvatarModal`：同样的 escapeHtml + pickSafeImageSrc 组合应用

**Issue 3 — `vfs_rm` consent 检查 (`src-tauri/src/file_manager.rs:282`)**
按照 `file_delete` (file_ops.rs:152-180) 的同一模式：
- 引入 `use crate::consent::{Operation, OperationOutcome}`
- 在函数签名加 `state: State<'_, AppState>`
- 发起 HTTP 请求前调用 `guard.request_operation(Operation::L3, &path)`；Denied/Timeout 时返回错误并不实际删除

注：本机缺 `webkit2gtk-4.1` 系统库，因此 `cargo check` 无法运行。Rust 代码完全镜像 `file_delete` 的现有 pattern，并已被 `lib.rs` 中原有的 `file_manager::vfs_rm` 注册项自动识别（State 注入由 Tauri 通过参数类型反射完成，无需修改 `lib.rs`）。`chat.js` 通过 `node --check` 语法验证。
