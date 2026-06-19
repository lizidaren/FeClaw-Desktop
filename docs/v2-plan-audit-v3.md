# FeClaw Desktop V2 开发计划 — 三审（V3 修正版）

> 评审对象: `docs/v2-plan.md`（v3，2026-06-19）
> 复审日期: 2026-06-19
> 复审范围: 逐项核对二审 8 个核心问题（N-1/N-2/N-3/N-4/N-6/N-7/N-8/N-9/P0-5/P0-7）的修复是否正确且不引入新问题；同时按"代码片段可在 Rust 1.77+ / Tauri 2 / tokio-tungstenite 0.24 / rfd 0.15 环境下编译"的标准复核
> 参考: `docs/v2-plan-audit.md`（一审）、`docs/v2-plan-audit-v2.md`（二审）、`src-tauri/src/{config,auth,ws,ws_types,consent,engine,lib}.rs`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、本地 `~/.cargo/registry` 中 tungstenite-0.24.0 / rfd-0.15.4 / auto-launch-0.5.0 / tokio-tungstenite-0.24.0 的源码

---

## 三审结论

V3 **形式上回应了二审全部 8 个核心问题**，但在"代码可直接编译"层仍存在 **6 处真实阻塞**，其中 N-4 / N-6 / N-8 三个二审标记为已修复的问题**实际仍不可编译**（API 名/类型签名错误），另有多处新引入的字段/方法引用与现有 `WsClient` / `ConsentManager` / `Config` / `EngineManager` / `tauri.conf.json` 实际结构不一致。

**关键阻塞清单**（按优先级）：
1. **N-4 未真正修复**：`Error::ConnectionClose(frame)` 在 tungstenite 0.24 不存在（无此变体），且 `downcast_ref` 用法本身也是错的
2. **N-6 未真正修复**：`AutoLaunch::new(name, path, Some(vec!["--minimized"]))` 签名错误——第三参是 `&[impl AsRef<str>]`，不是 `Option<Vec<&str>>`
3. **N-8 未真正修复**：rfd 0.15 API 不匹配（`.title`/`.description`/`.buttons`/`.blocking_show` 都不存在），且引用了 `ConsentManager` 上不存在的 `app_info` 字段
4. **N-3 0.2 `FileWriteResponsePayload` 与现有 `FileWritePayload` 命名空间**——新增是 OK 的，但 plan 0.2 把它放在 `FileDeleteResponse` 附近（"约 147 行"）而不是 `FileWritePayload` 附近，可读性下降
5. **0.3 `send_ws_message(&mut self)` 引用 `self.ws`，但 `WsClient` 没有 `ws` 字段**
6. **4.3 `connect_async_with_tls(url, connector)` 在 tokio-tungstenite 0.24 不存在**
7. **1.3 `save_settings` 声明 `fn`（同步）但内部 `.await` `spawn_blocking`——必须 `async fn`**
8. **1.2 / 1.6 `WebviewUrl::App("settings/index.html")` 与 `tauri.conf.json` 的 `frontendDist: "../dist"` 路径不匹配**

新发现但**非阻塞**的问题（可在实施时一并修）：
- 0.4 `run` 签名与现有 `WsClient::run(mut self)` 不一致
- 0.4 `MAX_RECONNECT_ATTEMPTS` / `RECONNECT_DELAY` 在新代码中直接使用但 `WsClient` 内部已定义
- 0.5 `self.app_info` 字段不存在
- 0.6 `self.ui_tx` 字段不存在
- 2.1 `path_exists` 调用 `resolve_desktop_path` 两次并 `unwrap()`
- 2.2 `Message::FileRead { id, payload }` 模式匹配错误（应匹配 `WsRequest::FileRead`）
- 4.1 `Mode` 需 `#[derive(Default)]` 才能用 `#[default] Local`
- 4.2 `EngineManager` 没有 `cancel_token` / `ws` 字段
- 2.1 `resolve_desktop_path` 父目录 symlink 循环在 macOS 上会把 `~/Desktop`（本身是 symlink to `/Users/foo/Desktop`）误判
- 0.5 `show_consent_dialog` 是 `async` 但函数体只用阻塞 rfd 调用——`async` 关键字多余

**整体判断**：v3 修复表的"标注完成度"高（约 80%），但**真实可编译性 / 真实 API 正确性**只有约 50%。建议按本报告"必须再修复项"清单逐条 patch 后再进入实施。

---

## 二审问题修复确认

### ✅ N-1：删除自造 WsMessage，直接用 ws_types.rs 现有结构

- **修复位置**：§0.3
- **状态**：✅ **正确**
- **说明**：v3 不再自造 `WsMessage` 枚举，而是 `use crate::ws_types::{FileReadResponse, FileReadResponsePayload, FileWriteResponse, FileWriteResponsePayload, FileDeleteResponse, FileDeleteResponsePayload};` 并通过 `serde_json::to_string(&resp)` 序列化。完全对齐 ws_types.rs:127-161 的现有结构。
- **轻微瑕疵**：`self.send_ws_message(serde_json::to_string(&resp).unwrap()).await` 中的 `unwrap()` 在序列化失败时会 panic——可改为 `match ... { Ok(s) => self.send_ws_message(s), Err(e) => tracing::error!() }`。
- **新发现问题**：见下文 §0.3 `send_ws_message` 引用 `self.ws` 不存在。

### ✅ N-2：响应补 `status: String` 字段

- **修复位置**：§0.3
- **状态**：✅ **正确**
- **说明**：所有 `FileReadResponse` / `FileWriteResponse` / `FileDeleteResponse` 构造都带 `status: "ok".into()` 或 `status: "error".into()`，与 ws_types.rs:127 / 146 的结构完全一致。

### ⚠️ N-3：删除自造 FileWriteResponse，复用 ws_types.rs

- **修复位置**：§0.2
- **状态**：⚠️ **部分修复**
- **说明**：
  - v3 在 ws_types.rs 新增 `FileWriteResponse` 和 `FileWriteResponsePayload`，不复用现有 `FileDeleteResponse` 结构。**这是新增而非复用**，但因为 ws_types.rs 之前确实没有 `FileWriteResponse`（只有 `FileWritePayload` 作为 request 侧），新增是必要的。✅
  - plan 写"在 `ws_types.rs` 找到 `FileDeleteResponse`（约147行）附近，添加"——但 `FileWriteResponse` 和 `FileWritePayload` 是**配对**的（request / response 侧），放在 `FileDeleteResponse` 附近逻辑上有点割裂，**建议放在现有 `FileWritePayload`（ws_types.rs:87-91）附近**。
  - v3 说"同时在 `FileReadResponse`、`FileDeleteResponse` 添加 `ok()` / `error()` 构造器"——ws_types.rs:127-161 的现有结构里**没有 `ok()` / `error()` 构造器**，是 OK 的新增。但需要确认 `FileReadResponsePayload` 的字段（content + error）能在所有分支用上——目前 `FileDeleteResponsePayload` 只有 `error: Option<String>`，语义清晰；`FileReadResponsePayload` 有 `content + error` 双字段，OK 时 `content=Some`, `error=None`，err 时反之，OK。

### ❌ N-4：`Error::ConnectionClose(frame)` 分支匹配

- **修复位置**：§0.4
- **状态**：❌ **未真正修复，编译失败**
- **tungstenite 0.24.0 实际 Error 定义**（`tungstenite-0.24.0/src/error.rs:15-76`）：
  ```rust
  pub enum Error {
      ConnectionClosed,           // <-- 没有 data
      AlreadyClosed,
      Io(io::Error),
      Tls(TlsError),
      Capacity(CapacityError),
      Protocol(ProtocolError),    // <-- close code 在这里？
      WriteBufferFull(Message),
      Utf8,
      AttackAttempt,
      Url(UrlError),
      Http(...),
      HttpFormat(http::Error),
  }
  ```
  - **`Error::ConnectionClose(CloseFrame)` 变体根本不存在**。v3 plan 的 `tokio_tungstenite::tungstenite::Error::ConnectionClose(frame)` 会编译失败："no variant or associated item named `ConnectionClose` found for enum `Error`"。
  - 即使改用存在的 `Error::ConnectionClosed`，它也是**无 payload 的**——close code 4xxx 在 `tungstenite::Error` 里**根本拿不到**。
- **正确的 close code 提取方式**：
  1. 在 `run_loop` 收到 `Message::Close(Some(close_frame))` 时取 `close_frame.code`
  2. `Message::Close(Option<CloseFrame<'static>>)` ——`CloseFrame` 结构有 `pub code: CloseCode` 字段
  3. 用 `as u16` 转 `CloseCode` 到整数
  4. 如果 `code == CloseCode::Library(4001)` 或 `4002` 则通知 reauth
- **`downcast_ref` 用法本身也错**：
  - `client_async` 返回 `Result<(_, _), tungstenite::Error>`，**不是 `anyhow::Error`**
  - 所以 `e.downcast_ref::<tungstenite::Error>()` 是无意义的——`e` 已经是 `tungstenite::Error`
  - 正确写法：`match e { tungstenite::Error::ConnectionClosed => ... }` 即可，但**拿不到 close code**
- **修复方案**：
  ```rust
  // 在 run_loop 的 msg 分支中（替换现有 if matches!(msg, Message::Close(_))）：
  if let Message::Close(frame) = &msg {
      if let Some(cf) = frame {
          let code: u16 = cf.code.into();  // CloseCode → u16
          if code == 4001 || code == 4002 {
              if let Some(notify) = &self.auth_failure {
                  notify.notify_waiters();
              }
              tracing::info!("auth failure close code {}, triggering reauth", code);
          }
      }
      return Ok(());
  }
  ```

### ❌ N-6：`AutoLaunch::new` 三参构造

- **修复位置**：§3.1
- **状态**：❌ **未真正修复，第三参类型错**
- **auto-launch 0.5.0 实际签名**（`auto-launch-0.5.0/src/{linux,windows,macos}.rs`）：
  - **Linux / Windows**：`AutoLaunch::new(app_name: &str, app_path: &str, args: &[impl AsRef<str>]) -> AutoLaunch`
  - **macOS**：`AutoLaunch::new(app_name: &str, app_path: &str, use_launch_agent: bool, args: &[impl AsRef<str>]) -> AutoLaunch`
- **v3 plan 的写法**：`AutoLaunch::new("FeClawDesktop", exe_str, Some(vec!["--minimized"]))`
  - 第三参 `Some(vec!["--minimized"])` 类型是 `Option<Vec<&str>>`
  - 期望类型是 `&[&str]`（即 `&["--minimized"]`）或 `Option<...>` 都不对
  - 编译错误："expected `&[impl AsRef<_>]`, found `Option<Vec<&str>>`"
- **macOS 上还会进一步出错**：如果 `cfg!(target_os = "macos")`，第三参期望 `bool`（`use_launch_agent`），传 `Option<Vec<&str>>` 完全错位
- **正确写法**：
  ```rust
  // Linux/Windows：
  AutoLaunch::new("FeClawDesktop", &exe_path_str, &["--minimized"])

  // 或用 builder（跨平台统一）：
  AutoLaunchBuilder::new()
      .set_app_name("FeClawDesktop")
      .set_app_path(&exe_path_str)
      .set_args(&["--minimized"])
      .build()?
  ```
  强烈建议用 `AutoLaunchBuilder`，避免 macOS 上签名差异。

### ✅ N-7：补 Cargo.toml TLS 依赖

- **修复位置**：§0.1
- **状态**：✅ **方向正确，有版本升级注意**
- **Cargo.toml 实际为 0.24.0**（`Cargo.lock` 锁定）：
  ```toml
  tokio-tungstenite = { version = "0.24", features = ["connect", "rustls-tls-webpki-roots"] }
  ```
- **v3 plan 升级到 0.26 + 加 native-tls feature**：
  ```toml
  tokio-tungstenite = { version = "0.26", features = ["connect", "native-tls", "rustls-tls-webpki-roots"] }
  native-tls = "0.2"
  tokio-native-tls = "0.3"
  ```
  - 0.24 → 0.26 是**大版本跨越**，需要重新跑 `cargo update`，会拉新依赖
  - 同时启用 `native-tls` + `rustls-tls-webpki-roots` 会**增加二进制体积**（两套 TLS 栈），建议只保留一个（云模式用 native-tls，本地模式用 rustls）
  - **更小的变更**：保留 0.24，只加 `native-tls` feature + native-tls 依赖；或者完全用 rustls（去掉 native-tls 相关），云模式用 rustls 也行
- **`auto-launch = "0.5"`** ✅ 与 `auto-launch-0.5.0` 匹配
- **`dirs = "5"`** ✅
- **`base64 = "0.22"`** ✅

### ❌ N-8：新增 `request_operation` + 内联 `show_consent_dialog`

- **修复位置**：§0.5
- **状态**：❌ **未真正修复，多处不匹配**
- **rfd 0.15.4 实际 API**（`rfd-0.15.4/src/message_dialog.rs:29-79`）：
  - `set_title(impl Into<String>)` 不是 `title`
  - `set_description(impl Into<String>)` 不是 `description`
  - `set_buttons(MessageButtons)` 不是 `buttons`
  - `show() -> MessageDialogResult` 不是 `blocking_show()`
- **v3 plan 的写法**（编译全部失败）：
  ```rust
  let ans = rfd::MessageDialog::new()
      .title(title)               // ❌
      .description(&msg)          // ❌
      .buttons(buttons)           // ❌
      .blocking_show();           // ❌
  ```
- **正确写法**（与现有 ws.rs:323-328 一致）：
  ```rust
  let ans = rfd::MessageDialog::new()
      .set_title(title)
      .set_description(&msg)
      .set_buttons(buttons)
      .show();
  ```
- **结构性错误**：`show_consent_dialog` 是 `async fn` 但函数体**没有 await**——`async` 关键字多余，可改为 `fn`；或者改用 `tokio::task::spawn_blocking` 包裹（与现有 consent.rs:170-176 一致），因为 rfd 是同步阻塞调用。
- **`ConsentManager` 缺 `app_info` 字段**：v3 引用 `self.app_info.display()`，但现有 `ConsentManager { session_trust, trust_file }`（consent.rs:34-37）**没有 `app_info` 字段**。需要在 impl 中添加（如 `app_info: String` 或 `app_info: PathBuf`），并改 `ConsentManager::new()` 签名。
- **未走 assess_risk 的设计是 OK 的**（N-1 / P1-9 修复方向正确），但应保留 `assess_risk` 给命令使用，新方法只对文件操作定级。

### ⚠️ N-9：`Arc<Notify>` 字段

- **修复位置**：§0.4 + §0.6
- **状态**：⚠️ **方向正确，配套代码需补**
- **正确性**：
  - WsClient 加 `auth_failure: Arc<Notify>` 字段 ✅（与现有 `outgoing_tx` 等 Arc/Mutex 风格一致）
  - 收到 close code 4xxx 时 `notify.notify_waiters()` ✅
  - EngineManager 加 `auth_failure: Arc<Notify>` 字段并 `wait_for_auth_failure().await` 循环 ✅
- **问题 1**：close code 提取依赖 N-4 的修复——`Error::ConnectionClose` 不可用，必须改用 `Message::Close(close_frame)`，所以 N-9 的实现代码**目前无法编译**
- **问题 2**：§0.6 `wait_for_auth_failure` 引用 `self.ui_tx`——`EngineManager` 结构里**没有这个字段**（现有 engine.rs:32 只有 config / child / stdout_buffer 等）。需要新增 `ui_tx: Option<mpsc::UnboundedSender<ControlMsg>>` 或类似字段。
- **问题 3**：§0.6 `reauth_cloud` 调用 `cfg.save()`，但 `Config::save` 是 `fs::write` 同步写盘——用 `spawn_blocking` 包是对的，✅

### ✅ P0-5 / N-10：canonical 路径 + 父目录 symlink 检查

- **修复位置**：§2.1 `resolve_desktop_path`
- **状态**：✅ **方向正确，1 个 macOS 边界 case**
- **正确性**：
  - `let canonical = resolved.canonicalize().unwrap_or_else(|_| resolved.clone());` ✅
  - `Ok(canonical)` 返回 canonical ✅
  - 父目录循环检查 `is_symlink()` ✅
  - 大小写不敏感 `starts_with` 检查 ✅
- **边界问题**：在 macOS 上，`~/Desktop` 本身**就是一个 symlink**（指向 `/Users/foo/Desktop` 或类似），所以 `~/Desktop` 的 `is_symlink()` 会返回 `true`——`resolve_desktop_path("/mnt/desktop/foo.txt")` 会走到 `allowed_root().join("foo.txt")` 也就是 `~/Desktop/foo.txt`，然后 canonicalize 成 `/Users/foo/Desktop/foo.txt`，**父目录循环从 `~/Desktop/foo.txt` 开始**，`parent = ~/Desktop`，`is_symlink() = true` → **会错误地返回 "symlink in path component not allowed"**
- **修复建议**：在父目录 symlink 检查中**跳过 `allowed_root` 本身**，或者对 `allowed_root` 也做 canonicalize 后再比对：
  ```rust
  let allowed_canonical = allowed_root().canonicalize().unwrap_or_else(|_| allowed_root().clone());
  while let Some(parent) = current.parent() {
      if parent == allowed_canonical { break; }  // 跳过 allowed_root
      if parent.is_symlink() { return Err(...); }
      if parent == current { break; }
      current = parent;
  }
  ```
  或者用 `is_relative_to` 检查（Rust 1.70+ 已有，但 `Path::starts_with` 大小写敏感的问题要解决）。

### ⚠️ P0-7：JWT header 认证（Python 端）

- **修复位置**：§2.4
- **状态**：⚠️ **形式修复，核心机制仍弱**
- **代码**：
  ```python
  await ws.accept()
  token = ws.cookies.get("feclaw_desktop_token")
  if not token:
      auth_msg = await ws.receive_json()
      token = auth_msg.get("token")
  ```
- **问题 1**：仍然先 `await ws.accept()` 再校验 token——攻击者仍可在 accept 后再收到 close 帧 4002，这给了重放/资源消耗的空间。**正确做法**：在 `accept()` 之前校验，校验失败直接 `close(4001)` 不 accept。
- **问题 2**：「从 cookies 或 first frame」双 fallback 设计意味着 `first-message JSON auth` 仍被保留——这与设计 §4.1 的「header 方式」初衷冲突。如果保留 first-message，必须为它设置速率限制（防 DoS）。
- **问题 3**：现有 ws.rs:147 的 Rust 客户端**没有设置 Cookie**——只设置 `Authorization: Bearer {token}` header。所以 Rust 端发的请求**不会经过 cookie 分支**，**必须**走 first-message 或在 Rust 端补 Cookie。这是个**实现漏洞**：两端的认证机制不匹配。
- **推荐方案**：
  ```python
  @router.websocket("/ws/desktop")
  async def desktop_websocket(websocket: WebSocket, token: str | None = Query(default=None)):
      # 从 query 读 token（Rust 端可以 ws://server/ws/desktop?token=...）
      if not token:
          token = websocket.headers.get("authorization", "").removeprefix("Bearer ")
      if not token or not verify_desktop_token(token):
          # accept 前直接 close，攻击者拿不到 session
          await websocket.close(code=4001)
          return
      await websocket.accept()
      ...
  ```
  配合 Rust 端 `let url = format!("{}/ws/desktop?token={}", base, token);`（WSS 走 TLS，token 走 query 在生产环境是 OK 的，因为 query 不被中间人看到）。

### ✅ P1-1 / N-11：session_trust_files 独立

- **修复位置**：§0.5
- **状态**：✅ **方向正确，未画完整代码**
- **说明**：plan §0.5 说"独立 `session_trust_files: HashSet<String>` 和 `~/.feclaw/trusted-files.json`"，但**没有画完整的字段定义 / 构造 / 持久化代码**。需要在 ConsentManager impl 中加：
  ```rust
  session_trust_files: HashSet<String>,
  trust_files_file: PathBuf,

  // new() 中：
  trust_files_file: Config::config_dir().join("trusted-files.json"),
  ```
  并在 `request_operation("write"|"delete", path)` 用户勾"始终允许"时插入到 `session_trust_files` 而非 `session_trust`。
- **新问题**：plan §0.5 的"show_consent_dialog"只有 L2/L3 分支，没有"始终允许"按钮——目前 v3 只用 `rfd::MessageButtons::YesNo`，但 consent.rs:170-173 用 `MessageButtons::YesNoCancel` 提供三选项（Yes=允许一次, No=拒绝, Cancel=始终允许）。`request_operation` 是否需要"始终允许"语义需要明确。

### ✅ N-13：MAX_FILE_BYTES = 1MiB

- **修复位置**：§2.1
- **状态**：✅
- **说明**：定义了 `const MAX_FILE_BYTES: usize = 1 * 1024 * 1024;` 并在 `resolve_desktop_path` 中检查 `metadata.len() > MAX_FILE_BYTES` 返回错误。✅
- **轻微问题**：检查 `if let Ok(metadata) = std::fs::metadata(&canonical)`——对 write 操作时文件不存在，`metadata` Err 被静默忽略，size check 跳过。这**对 write 是 OK 的**（文件还没创建），但对 read 操作时文件不存在会跳过 size check，**应当返回 "file not found" 错误**——目前是 `std::fs::read` 在后续步骤报 IO error，可接受。

### ✅ N-12：ControlMsg::ShowCloudLogin

- **修复位置**：§1.6 + §4.4
- **状态**：✅ **方向正确**
- **说明**：v3 在 `ControlMsg` 加 `ShowCloudLogin`，§4.4 `controlPump` 收到后调 `settings::open_settings_window` + `app.emit("navigate-settings", "cloud")`。需要前端监听 `navigate-settings` 事件并切换 tab。
- **细节缺口**：plan 没有说明前端 `settings.ts` 如何监听 `navigate-settings` 事件——需要新增 `@tauri-apps/api/event` 的 `listen("navigate-settings", ...)` 调用。

### ✅ N-5：删 chronoUtc，用 current_timestamp

- **修复位置**：§0.3
- **状态**：✅
- **说明**：v3 的所有 handler 用 `crate::ws_types::current_timestamp()`（在 `use` 中已 import），与现有 ws.rs:262 / 286 / 301 的用法一致。

### ✅ N-14：settings.ts `$()` 封装 null 检查

- **修复位置**：§1.5
- **状态**：✅
- **说明**：`function $<T>(id: string): T | null` + 所有调用方判空。✅
- **轻微问题**：`$("save")` 在文件末尾，line 640 `($("save") as HTMLButtonElement)?.addEventListener(...)`——这行在模块顶层立即执行，如果 DOM 还没 ready 会是 null——应当包在 `DOMContentLoaded` 监听中。

### ✅ N-15：save() 错误不吞

- **修复位置**：§0.6 + §4.4
- **状态**：✅
- **说明**：v3 改用 `if let Err(e) = save() { tracing::error!() }` 或 `tracing::warn!()`，没有 `.ok()` 吞错。✅

### ⚠️ N-17：按现有 `ws: WsStream` + `outgoing_rx` 重写

- **修复位置**：§0.3
- **状态**：⚠️ **修复说明与代码不一致**
- **修复说明**（v2-plan.md:124）写"按现有 ws.rs 实际结构 `ws: WsStream` + `outgoing_rx` 重写 run_inner"
- **但 §0.3 代码中**新增的 `send_ws_message(&mut self, text)` 引用 `self.ws`：
  ```rust
  async fn send_ws_message(&mut self, text: String) {
      use tokio_tungstenite::tungstenite::Message;
      if let Some(ws) = &mut self.ws {        // ❌ self.ws 不存在
          ws.send(Message::Text(text.into())).await.ok();
      }
  }
  ```
  实际 `WsClient` 结构（ws.rs:52-66）**没有 `ws` 字段**，`ws` 是 `run_inner` 内的局部变量（ws.rs:151 `let (mut ws, _resp) = client_async(req, None).await`）。
- **正确做法**：用现有的 `outgoing_tx` 通道：
  ```rust
  async fn send_ws_message(&self, text: String) {
      let _ = self.outgoing_tx.send(text);
  }
  ```
  这与现有 ws.rs:332-339 `send_json` 完全一致。**handler 中应改回 `self.send_json(&serde_json::to_value(&resp).unwrap())`，或者新增一个 `send_str` helper 通过 `outgoing_tx` 发送。**

### ✅ N-18：spawn_blocking 写文件

- **修复位置**：§1.3 + §0.6
- **状态**：⚠️ **方向正确但函数签名错**（见下文 §1.3）

### ✅ N-16：UNC 路径注释

- **修复位置**：§2.1
- **状态**：✅
- **说明**：`rest.replace('/', "\\")` 处加注释"不支持 UNC 路径（\\?\C:\...）"。✅

---

## 新发现问题（重点：可编译性 / API 正确性）

### 🔴 阻塞级（编译失败）

#### V3-1 §0.3 `send_ws_message` 引用 `self.ws`，但 `WsClient` 无此字段
（已在 N-17 修复确认中详述，标记为 🔴 阻塞）

#### V3-2 §1.3 `save_settings` 声明 `fn` 但内部 `.await`
```rust
#[tauri::command]
fn save_settings(settings: HashMap<String, String>) -> Result<(), String> {
    // ...
    tokio::task::spawn_blocking(move || {
        do_save_env(&env_clone)
    }).await                  // ❌ fn 中不能 .await
    .map_err(|e| ...)?
    .map_err(|e| e.to_string())
}
```
**修复**：改为 `async fn save_settings(...)` + `#[tauri::command]`（Tauri 2 支持 async commands）。

#### V3-3 §1.2 / §1.6 `WebviewUrl::App("settings/index.html")` 与 `tauri.conf.json` 不匹配
- `tauri.conf.json:7` 有 `frontendDist: "../dist"`
- v3 plan 把 `index.html` / `settings.ts` / `settings.css` 放在 `src-tauri/src/settings/`
- Tauri 2 的 `WebviewUrl::App(path)` 是相对于 `frontendDist` 解析的——`settings/index.html` 会找 `src-tauri/dist/settings/index.html`
- **修复**：
  - 方案 A：把 `src-tauri/src/settings/` 改名为 `dist/settings/`，构建时由前端构建工具输出
  - 方案 B：改 `tauri.conf.json` `frontendDist: "../src"`，把所有静态资源放 `src/`
  - 方案 C：用 `tauri::custom_protocol` 嵌入资源
  - 建议方案 B（最少改动）

#### V3-4 §0.5 `ConsentManager` 引用 `self.app_info` 不存在
```rust
let msg = format!("{}\n\n路径：{}", description, self.app_info.display());  // ❌
```
现有 `ConsentManager { session_trust, trust_file }`（consent.rs:34-37）无 `app_info`。需要：
```rust
pub struct ConsentManager {
    session_trust: HashSet<String>,
    session_trust_files: HashSet<String>,
    trust_file: PathBuf,
    trust_files_file: PathBuf,
    app_info: String,  // 新增：app 名 / 显示名
}
```

#### V3-5 §0.4 `Error::ConnectionClose` + `downcast_ref` 双重错
（已在 N-4 中详述，🔴 阻塞）

#### V3-6 §0.6 `wait_for_auth_failure` 引用 `self.ui_tx`，但 `EngineManager` 无此字段
需要新增：
```rust
pub struct EngineManager {
    pub config: Config,
    pub ui_tx: Option<mpsc::UnboundedSender<ControlMsg>>,  // 新增
    // ...
}
```

#### V3-7 §3.1 `AutoLaunch::new` 第三参类型错
（已在 N-6 中详述，🔴 阻塞）

#### V3-8 §4.3 `connect_async_with_tls(url, connector)` 在 tokio-tungstenite 0.24 不存在
- 0.24 实际 API（`tokio-tungstenite-0.24.0/src/connect.rs`）：
  - `pub async fn connect_async<R>(request: R) -> Result<...>` — 无 TLS 自定义
  - `pub async fn connect_async_with_config<R>(request: R, config: ...)` — 无 TLS 自定义
  - `pub async fn connect_async_tls_with_config<R>(request: R, config: ..., connector: ...)` — TLS 自定义
- v3 用的 `connect_async_with_tls(url, connector)` 是**不存在的函数名**
- 而且传 `url: &str` 不对——应该传 `Request<()>`，需要 `Request::builder().uri(url).header("Authorization", ...).body(())`
- **正确写法**：
  ```rust
  use tokio_tungstenite::connect_async_tls_with_config;

  let req = Request::builder()
      .method("GET")
      .uri(url)
      .header("Host", host)
      .header("Authorization", format!("Bearer {}", token))
      .body(())?;
  let (ws_stream, _resp) = connect_async_tls_with_config(req, None, Some(Connector::NativeTls(connector))).await?;
  ```
  或继续用现有 `client_async(req, Some(Connector::NativeTls(connector)))` 模式（ws.rs:151）。

#### V3-9 §4.1 `Mode` 缺 `Default` 派生
```rust
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub enum Mode {
    #[default]
    Local,
    Cloud,
}
```
需要 `Default` 派生，否则 `#[default]` 编译失败。但现有 `Config`（config.rs:13-21）有 `Default`（impl Default 块），且 v3 改成 enum 自带 `#[default]`——**Config 的 `impl Default` 块会与 enum 的 `#[default]` 冲突**（两份默认逻辑）。需要删 `impl Default for Config`，只用 enum 的 `#[default]`。或者保留 impl Default 但不用 `#[default]`。

#### V3-10 §4.2 `start_cloud` 引用 `EngineManager` 上不存在的字段
```rust
async fn start_cloud(&mut self) -> Result<EngineStatus> {
    let cancel_token = self.cancel_token.clone();   // ❌ EngineManager 无 cancel_token
    // ...
    if let Err(e) = self.ws.as_mut().unwrap().run(...)  // ❌ EngineManager 无 ws
    ...
}
```
需要在 `EngineManager` 加 `cancel_token: Arc<AtomicBool>` 和 `ws: Option<WsClient>` 字段。

### 🟡 中度（逻辑 / 行为问题）

#### V3-11 §0.3 handler `serde_json::to_string(&resp).unwrap()` 序列化失败时 panic
应改 `match serde_json::to_string(&resp) { Ok(s) => self.send_ws_message(s), Err(e) => tracing::error!("serialize: {e}") }`。
现有 ws.rs:272 / 333 也用了 `.unwrap_or_else` 模式，**建议对齐现有风格**。

#### V3-12 §2.1 macOS `~/Desktop` 是 symlink 导致 `resolve_desktop_path` 误判
（已在 P0-5 修复确认中详述，🟡 需在 macOS 测试时验证）

#### V3-13 §2.1 `path_exists` 调用 `resolve_desktop_path` 两次并 `unwrap()`
```rust
pub fn path_exists(path: &str) -> bool {
    resolve_desktop_path(path).is_ok() && Path::new(&resolve_desktop_path(path).unwrap()).exists()
    //                                          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 第二次调用 + unwrap
}
```
**修复**：
```rust
pub fn path_exists(path: &str) -> bool {
    match resolve_desktop_path(path) {
        Ok(p) => p.exists(),
        Err(_) => false,
    }
}
```

#### V3-14 §2.2 `Message::FileRead { id, payload }` 模式匹配错
```rust
// v3 写法：
Message::FileRead { id, payload } => {
    self.handle_file_read(&id, payload).await;
}
```
`tungstenite::Message`（tungstenite-0.24.0/src/protocol/message.rs:36）的变体是 `Text`/`Binary`/`Ping`/`Pong`/`Close`/`Frame`，**没有 `FileRead`**。
**正确写法**：
```rust
let req: WsRequest = serde_json::from_str(&text)?;
match req {
    WsRequest::FileRead { id, timestamp: _, payload } => {
        self.handle_file_read(&id, payload).await;
    }
    // ...
}
```
（与现有 ws.rs:236-255 一致）

#### V3-15 §0.5 `show_consent_dialog` 是 `async fn` 但无 `.await`
应改 `fn`，或用 `spawn_blocking` 包裹 `dialog.show()`（与现有 consent.rs:175-176 一致）。

#### V3-16 §1.5 `settings.ts` 顶层 `addEventListener` 在 DOM ready 之前可能为 null
`($("save") as HTMLButtonElement)?.addEventListener(...)` 在 script 末尾执行——如果 `<script type="module">` 是 defer/async 可能比 DOM 早，但裸 `<script>` 会在解析时执行。需要确认 HTML 中 `<script>` 位置——v3 放在 `</body>` 前，OK（defer module）。但更稳妥用 `DOMContentLoaded` 监听。

#### V3-17 §0.4 `run` 签名与现有 `WsClient::run(mut self)` 不一致
v3 plan 写：
```rust
async fn run(&mut self, cancel_token: Arc<AtomicBool>) -> Result<()> { ... }
```
但现有 `WsClient::run(mut self)`（ws.rs:100）签名是 `pub async fn run(mut self)`，且 `cancel_token` 已在结构里。`&mut self` + 外部 cancel_token 不对。
**正确**：保留现有 `pub async fn run(mut self)`，cancel_token 来自 `self.cancel_token` 字段。

#### V3-18 §0.4 直接使用 `MAX_RECONNECT_ATTEMPTS` / `RECONNECT_DELAY` 常量
这两个常量在 ws.rs:46-47 已经定义。v3 plan §0.4 直接用没问题（在同一 crate 内），但**没有 import**——需要在文件顶部 `use crate::ws::{MAX_RECONNECT_ATTEMPTS, RECONNECT_DELAY};` 或保持 pub 可见性。

#### V3-19 §2.1 `is_relative_to` vs `starts_with` 大小写
v3 §2.1 用 `to_lowercase()` 后 `starts_with`——这是为了 Windows NTFS 兼容性。但更标准的方式是 `Path::starts_with`（区分大小写）+ 先 `allowed_root` 也 canonicalize。如果只在 Windows 上跑，可以接受；macOS / Linux 上 `to_lowercase` 是冗余的（无副作用，但浪费）。

### 🟢 轻微

#### V3-20 §0.4 `MAX_RECONNECT_ATTEMPTS` 命中后跳出但 `set_status(Failed)` 没调
现有 ws.rs:121 `self.set_status(ConnectionStatus::Failed).await;`——v3 plan §0.4 的 `if attempts >= MAX_RECONNECT_ATTEMPTS { break; }` 直接 break 漏了 set_status。**修复**：在 break 前 `self.set_status(ConnectionStatus::Failed).await;`。

#### V3-21 §1.6 `ControlMsg` 加 `ShowCloudLogin` 后，lib.rs:170-178 的 match 也要加分支
现有 `ControlMsg::SetMode(Mode) => { ... }` 模式匹配，v3 加了 `ShowCloudLogin` 但没说在 lib.rs 的 match 中如何处理——需要在 §4.4 画完整 match 代码（已画，但 §1.6 没画 `lib.rs` 的 `invoke_handler!` 也要包含 `open_settings` 命令）。

#### V3-22 §2.4 Python 端 `manager.connect(ws)` 未定义
plan 引用 `manager.connect(ws)` / `manager.disconnect(ws)` 但**没给出 ConnectionManager 实现**。需要补：
```python
class ConnectionManager:
    def __init__(self): self.active: list[WebSocket] = []
    async def connect(self, ws): self.active.append(ws)
    async def disconnect(self, ws): self.active.remove(ws)
```

#### V3-23 §2.3 Python `Path(rest.replace('/', '\\'))` 在 Linux 上错误
Linux 上 `pathlib.Path` 是 `PosixPath`，不能直接构造 Windows 路径 `C:\Users\foo`。需要在 `if sys.platform == "win32"` 分支处理（这个 Python 端实际是 FeClaw 服务端跑在 Windows server 上，所以可能 OK，但需要明示）。

#### V3-24 §1.4 HTML 用 `import { invoke } from "@tauri-apps/api/core"` 但 v3 没提 tauri JS 包如何被加载
如果 `frontendDist` 是 `dist/`，且前端用 vite/webpack，需要前端构建系统。如果只用静态文件，需要从 `@tauri-apps/api` npm 包或用 `window.__TAURI__.invoke`（来自 `tauri.conf.json` `withGlobalTauri: true`，当前 conf.json 没设）。需要在 conf.json 中加 `"withGlobalTauri": true` 或在 HTML 中用 `<script src="...">` 引入。

#### V3-25 §0.6 `reauth_cloud` 调 `cfg.save()` 但 `EngineManager` 的 `self.config` 是 `Config`，不是 `Arc<Config>`——`spawn_blocking(move || cfg.save())` 的 `move` 会让 `cfg` 移入 closure，没问题。但 `self.config` 的借用已经结束（`let cfg = self.config.clone();`），OK。

---

## 实施顺序评估

| 阶段 | 是否合理 | 备注 |
|------|---------|------|
| **0** Cargo.toml + ws_types + ws.rs + consent.rs | ⚠️ | 必须最先。但 V3-5/V3-7/V3-8 等阻塞在阶段 0 内部，会让 cargo build 失败 |
| **1** 设置界面 | ⚠️ | V3-2 / V3-3 阻塞（save_settings async 错误 + frontendDist 路径错） |
| **2** 文件中继 | ⚠️ | V3-1 / V3-4 / V3-13 / V3-14 阻塞 |
| **3** 开机自启 | ❌ | V3-7 阻塞（AutoLaunch API 错） |
| **4** 云模式连接 | ❌ | V3-5 / V3-6 / V3-8 / V3-9 / V3-10 阻塞；最复杂，必须等所有前序阶段编译通过 |

**建议**：
1. 阶段 0 拆为 **0a（Cargo.toml 升级）** + **0b（ws_types 补类型）** + **0c（ws.rs handler 改造）** + **0d（consent.rs 加方法）**，每步独立可编译
2. 阶段 0a 之前先跑 `cargo check` 确认基线
3. 阶段 1 之前先把 `tauri.conf.json` 改完（V3-3）
4. 阶段 4 推迟——等阶段 0/1/2/3 全部合并后再做云模式，单独 PR

---

## 测试覆盖评估

- 现有 `ws_types.rs` / `consent.rs` / `auth.rs` 有 ~30 个 cargo test
- v3 plan **没提新增模块的测试**：
  - `file_bridge.rs` `resolve_desktop_path` 需要：symlink 攻击 / 路径穿越 / UNC / 父目录 symlink / 大文件 / 1MiB 边界
  - `settings.rs` `parse_env` / `format_env` / `load_env` / `save_env` 需要 round-trip + 注释行 / 空行 / UTF-8 测试
  - `engine.rs` `AutoLaunch` 需要 mock（auto-launch 0.5 没有 mock trait，可考虑 trait 抽象）
  - `ws.rs` TLS 重连需要 mock WS server（用 `tokio-tungstenite` 的 accept side）
- **建议**：每个 PR 至少 5 个新单测

---

## 总结：必须再修复（按优先级）

1. **V3-5 / N-4 ❌** §0.4 改用 `Message::Close(Option<CloseFrame>)` 提取 close code（编译能过）
2. **V3-7 / N-6 ❌** §3.1 改用 `AutoLaunchBuilder` 或 `&["--minimized"] as &[&str]`（编译能过）
3. **V3-8 ❌** §4.3 改用 `connect_async_tls_with_config(req, None, Some(Connector::NativeTls(...)))` 或 `client_async(req, Some(connector))`（编译能过）
4. **V3-1 / N-17 ❌** §0.3 `send_ws_message` 改用 `outgoing_tx` 而非 `self.ws`（编译能过）
5. **V3-2 ❌** §1.3 `save_settings` 改 `async fn`（编译能过）
6. **V3-3 ❌** §1.2 / §1.6 改 `tauri.conf.json` 的 `frontendDist` 为 `"../src"` 或把 settings/ 移到 `dist/`（运行能过）
7. **V3-4 ❌** §0.5 `ConsentManager` 加 `app_info` 字段（编译能过）
8. **V3-6 ❌** §0.6 `EngineManager` 加 `ui_tx` 字段（编译能过）
9. **V3-9 ❌** §4.1 `Mode` 删 `impl Default for Config` 或加 `#[derive(Default)]` 并去重（编译能过）
10. **V3-10 ❌** §4.2 `EngineManager` 加 `cancel_token` 和 `ws` 字段（编译能过）
11. **V3-14 ❌** §2.2 改用 `match req { WsRequest::FileRead { id, payload, .. } => ... }`（编译能过）
12. **V3-13 ❌** §2.1 `path_exists` 重写（panic 风险）
13. **V3-15 ❌** §0.5 `show_consent_dialog` 改 `fn` 或 `spawn_blocking`（编译能过 + 与现有 consent.rs 风格一致）
14. **V3-17 ❌** §0.4 `run` 签名改为 `pub async fn run(mut self)`（与现有对齐）
15. **V3-12 🟡** §2.1 macOS `~/Desktop` symlink 边界 case（需 macOS 测试）

**修完这 15 条后**才真正达到"可实施"状态。当前 v3 修复表完整度约 80%，**代码可编译完整度约 50%**——仍有约一半的关键修改会让 `cargo check` 失败。

---

## 通过项

- 设计层面：路径映射语义、Cargo.toml 依赖大头、auto-launch、--minimized、SetMode 触发重连、serde(default)、executor 解耦、Tauri 2 API、文件操作 risk 直接定级、session_trust_files 拆分、canonical 路径、文件大小上限、ControlMsg::ShowCloudLogin——**方向全部正确**
- 协议层面：ws_types.rs 现有响应结构 `{id, status, timestamp, payload}` 一致性、use existing types 不再重造、删 `chronoUtc` 统一 `current_timestamp()`、Python 端用 `/api/login` 路径、WS close code 4xxx 触发 reauth 设计
- 安全层面：JWT header-based auth 设计意图、symlink 父目录防御、MAX_FILE_BYTES 1MiB 限制、Python 端 dual-write 取消、save() 移到 spawn_blocking
- 测试覆盖：现有 30+ cargo test 仍有效；新增模块的测试缺口已识别
- 文档完整度：v3 修复表覆盖了二审 8 个核心问题 + 10 个 N 系列 + 2 个 P0

**最大改进点**：从 v2 的"5 个真实阻塞点"减少到 v3 的"6 个真实阻塞点"，但**质量更均匀**——v3 阻塞在 N-4 / N-6 / N-8（v2 标注已修的）+ 5 个新发现；v2 阻塞在 N-1 / N-2 / N-3 / N-7（v3 已修）+ 1 个 N-10。整体方向更稳，但**对 tungstenite 0.24 / rfd 0.15 / auto-launch 0.5 真实 API 的核对**仍是 v2 / v3 共同的弱点——建议下一版在写代码前直接 grep `~/.cargo/registry` 验证 API。

## 结论

**不可以开始实施**——15 个阻塞项中前 10 个都是编译失败，会让 `cargo check` 在阶段 0 第一步就挂。

按本报告"必须再修复项"前 10 条 patch 后再进入阶段 0 实施；阶段 4（云模式）建议在阶段 0-3 全部合并、cargo build 通过后再开新 PR。
