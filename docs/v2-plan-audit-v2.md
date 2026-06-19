# FeClaw Desktop V2 开发计划 — 复审（V2 修正版）

> 评审对象: `docs/v2-plan.md`（修正版，2026-06-19）
> 复审日期: 2026-06-19
> 复审范围: 逐项核对 M3 审核发现的所有 P0/P1 是否真正修复；同时审查修正版是否引入新问题、代码片段是否可编译、实施顺序是否合理
> 参考: `docs/v2-plan-audit.md`（M3 报告）、`docs/design.md`、当前 `src-tauri/src/{config,auth,ws,ws_types,consent}.rs`、`src-tauri/Cargo.toml`

---

## 复审结论

修正版**总体方向正确**，主要 P0（依赖声明、路径映射、安全约束、密码策略、JWT 方式）已**形式上回应**，P1 大多数也做了修复标注。但仍有以下关键问题**未真正闭环**，按字面实现会再次撞墙：

1. **代码与 ws_types.rs 现状不一致**（高危）：修正版自造了 `WsMessage` 枚举并重写 `FileWriteResponse`/`FileDeleteResponse`/`FileReadResponse` 结构，但 ws_types.rs 已有同名同结构类型；多处字段（`status: String`）被省略，编译会失败或与协议错位。
2. **Cargo.toml 修复不完整**：新增了 `auto-launch`/`dirs`/`base64`，但**漏掉了 P1-4 TLS 所需的 `native-tls` 与 `tokio-native-tls`**；§4.4 直接 `use tokio_tungstenite::native_tls::TlsConnector` 会失败。
3. **P0-7 JWT 认证方式修正未真正落地**：§4.5（Python 端）仍保留"先 accept 再 first-message JSON auth"的旧写法，与设计 §4.1 的 header 方式以及现有 ws.rs:147 的客户端发送逻辑仍不一致。
4. **P0-5 路径穿越防护有 symlink 漏洞**：返回的是 `resolved`（canonicalize 之前的路径），但实际 I/O 时会跟随 symlink 解析到允许目录之外——`canonicalize()` 解析完的 `canonical` 被丢弃。
5. **多处代码片段缺少字段/方法依赖**：如 `self.auth_failure.replace(())`、`self.consent.show_dialog(...)`、`WsMessage::FileReadResponse(...)` 等都引用了计划里未定义的结构。

整体判断：**修正版在"标注"层完成度高，在"代码可直接落地"层仍有 5-6 个真实阻塞点**。建议按本报告"必须再修复项"清单逐条 patch 后再进入实施。

---

## P0/P1 修复确认

### 🔴 P0（阻塞）

| ID | 标题 | 状态 | 说明 |
|----|------|------|------|
| **P0-1** | `auto-launch` 依赖未声明 | ✅ **形式修复**，⚠️ **API 写法可能错** | §1.1 已显式加 `auto-launch = "0.5"`。但 §1.3 用 `AutoLaunch::new(AutoLaunchConfig { app_name, app_path, args, ..Default::default() })` 构造——`auto-launch = "0.5"` 的实际 API 是 `AutoLaunch::new(name, path, args)` 三参或 `AutoLaunchBuilder` 链式构造，**`AutoLaunchConfig` 结构体在 0.5 不存在**。需改为 builder 或三参构造。 |
| **P0-2** | `expand_user()` 不存在 | ✅ | §1.3、§2.2、§3.2 全部用 `dirs::home_dir()` 替代，与 ws_types / consent 模式一致。 |
| **P0-3** | `FileWriteResponse` 未定义 | ⚠️ **部分修复，引入新错** | §3.1 定义了 `FileWriteResponse { id, timestamp, error }`，但与 ws_types.rs:147 已有的 `FileDeleteResponse { id, status, timestamp, payload: { error } }` 风格不一致——**少了 `status` 字段**。同时 `FileReadResponse` 现有结构是 `{id, status, timestamp, payload: FileReadResponsePayload { content, error }}`（ws_types.rs:127），§3.4 handler 里用 `WsMessage::FileReadResponse(FileReadResponse { id, timestamp, payload })` 也漏 `status`。 |
| **P0-4** | `/mnt/desktop/` 路径映射错 | ✅ **核心正确**，⚠️ **细节有 bug** | §3.2 Rust 端和 §3.5 Python 端都按 design.md §5.2 分支：`/mnt/desktop/C:/...` → Windows 绝对路径，`/mnt/desktop/foo` → `~/Desktop/foo`。**关键 bug**：返回的是 `resolved`（pre-canonicalize 路径），但 `tokio::fs::read(&resolved)` 会**跟随 symlink 解析到 allowed_root 之外**，必须返回 `canonical` 才能彻底挡掉 symlink 攻击。 |
| **P0-5** | 路径穿越防护漏洞 | ⚠️ **有但不完备** | §3.2 做了 `canonicalize()` + 小写化 `starts_with()` 比对，但：(1) 用了 `starts_with` 而非 `is_relative_to`（与修复表声明不一致，且对路径中含相似前缀如 `~/Desktopx/` 的情形虽然 `canonicalize` 解决了但实现很脆）；(2) **symlink 跟随问题** 同 P0-4；(3) Python 端 §3.5 只在 `_resolve_path` 里做了 `str(resolved).startswith(str(desktop))`，没有 canonicalize 检查，攻击者只要传入 `~/Desktop/../foo.txt` 这种 prefix-match 路径就能绕过。 |
| **P0-6** | 云模式密码明文存盘 | ✅ | §4.1 Config 已去掉 `cloud_password`，只剩 `cloud_token`。但**注意 auth.rs:19-27 的本地 `Credentials` 仍保留 `password: Option<String>` 字段**——这是设计有意（用于 token 过期重登），不要混淆。 |
| **P0-7** | JWT 认证方式不一致 | ❌ **未真正修复** | §4.5 Python 端仍是 `await ws.accept(); auth_msg = await ws.receive_json(); if auth_msg.get("type") != "auth": close(4001)`——即"先 accept 再 first-message auth"。但现有 ws.rs:147 已用 `.header("Authorization", format!("Bearer {}", self.token))`，两端完全不对。设计 §4.1 也是 header 方式。需要改写 §4.5：在 `await ws.accept()` 之前从 `websocket.headers["authorization"]` 取 JWT 校验。FastAPI WebSocket 接受前的 header 读取需要走 ASGI scope 或 dependency，不是 handler 内手动 JSON 协议。 |
| **P1-1** | `ConsentManager::request()` 不接受 risk | ⚠️ **形式修复，破坏既有 trust 语义** | §3.3 加了 `request_operation(operation, path)`，但把 `key = format!("{}:{}", operation, path)` 加进 `session_trust: HashSet<String>`——这个集合目前**只服务于命令信任**（`trusted-commands.json` 持久化），混入文件路径会让 `trusted-commands.json` 出现非命令条目。应新增独立 `session_trust_files: HashSet<String>`（和独立持久化文件）来隔离。 |
| **P1-2** | `exe_path` 不存在 | ✅ | §1.3 用 `std::env::current_exe()`。 |
| **P1-3** | `ws_url()` 签名冲突 | ✅ | §4.1 把 `ws_url()` 改成 mode 分发，没有重名方法。 |
| **P1-4** | WSS/TLS 未支持 | ❌ **未真正修复（依赖缺失）** | §4.4 用 `tokio_tungstenite::native_tls::TlsConnector` 和 `tokio_native_tls::TlsConnectorExt`——这两个 crate 都没有出现在 §1.1 的 Cargo.toml 依赖里。**Cargo.toml 必须加 `native-tls = "0.2"` 和 `tokio-native-tls = "0.3"`**，否则 import 即编译失败。另外当前 `tokio-tungstenite` features 是 `["connect", "rustls-tls-webpki-roots"]`，要么改 `["connect", "native-tls"]` 要么单独用 `connect_async_tls` 配 connector。 |
| **P1-5** | 设置页 HTML 路径错误 | ⚠️ **形式修复，缺配置联动** | §2.1 把 HTML 放 `src/settings/`，§2.2 用 `WebviewUrl::App("settings/index.html".into())`。但 Tauri 2 实际还需要在 `tauri.conf.json` 设置 `build.frontendDist` 指向 `../src/settings`（或把它注册为 asset），否则 `WebviewUrl::App(...)` 找不到资源。修正版没提 `tauri.conf.json` 改动。 |
| **P1-6** | Tauri 2 API 错误 | ✅ | §2.2 用了 `tauri::WebviewWindowBuilder::new(&app, "settings", url)`。 |
| **P1-7** | `file_*` 混入 executor | ✅ | §3.2 新建 `file_bridge.rs` 模块。 |
| **P1-8** | `--minimized` 无人处理 | ✅ | §1.4 main.rs 解析 `LaunchMode`。 |
| **P1-9** | `assess_risk` 对文件操作无效 | ✅ | §3.3 直接按 operation 类型定 risk，不走 `assess_risk`。 |
| **P1-10** | 同步 IO 阻塞事件循环 | ⚠️ **Rust 端修，Python 端未提** | §3.2 Rust 用 `tokio::fs::read/write/remove_file`。但 §3.5 Python `_resolve_path` 只重写了路径映射，没有碰实际 I/O 代码——vfs.py 的 `cat / echo` 等真正落盘的命令仍是同步 `open(...)`。需要明确 FeClaw 端文件中继也要走 `asyncio.to_thread` 或 `aiofiles`。 |
| **P1-11** | cloud 重连放错模块 | ✅ | §4.4 重连在 ws.rs Rust 端。Python 端 §4.5 没再提重连。 |
| **P1-12** | JWT 过期无重新登录 | ⚠️ **有方向，缺字段** | §4.4 `run_inner` 检测 close code 4xxx 时 `self.auth_failure.replace(())`——但 `WsClient` 结构体没有 `auth_failure` 字段（现有 ws.rs 没有这个成员）。需要在结构体里加 `auth_failure: Arc<Once>` 或类似，并实现"收到通知 → 调 `EngineManager::reauth_cloud()`"的链路。 |
| **P1-13** | 新字段无 `#[serde(default)]` | ✅ | §1.2 §4.1 都加了 `#[serde(default)]`。 |
| **P1-14** | `start_cloud` 无取消机制 | ⚠️ **claim 了但没画 loop** | §4.3 `start_cloud` 函数体不包含重连/取消循环，只是单次 `start → connect → return`；`cancel_token` 仅在 §4.7 controlPump 提了一下，没在 §4.3 的 cloud 模式下集成。需要显式画出 `loop { if cancel_token.load() { break; } ... }` 结构。 |
| **P1-15** | `SetMode` 不触发 ws 重连 | ✅ | §4.7 `ControlMsg::SetMode` 分支 `cancel_token.store(true)`。 |

### 🟢 P2 修订版中的态度

修正版没再罗列 P2 项，仅修复表里保留了 P0/P1。从 §4.7 实现看：

- **P2-1**（`/auth/login` vs `/api/login`）：§4.3 用了 `/api/login`，已统一。✅
- **P2-2**（心跳 25s vs 30s）：修正版没声明心跳间隔，§4.4 `HEARTBEAT_INTERVAL` 直接复用现有 ws.rs 的 30s 常量，**与设计 §4.2 一致**。✅
- **P2-3**（`from "tauri/api"` → `@tauri-apps/api/core`）：§2.4 settings.ts 用了 `import { invoke } from "@tauri-apps/api/core"`。✅
- **P2-7**（敏感字段 masking）：§2.2 `get_settings` 做了 JWT_SECRET/MINIMAX_API_KEY 的遮蔽。✅

---

## 新发现问题

### 🔴 真实可编译性 / 协议一致性 Bug

#### N-1 `WsMessage` 枚举不存在，但 §3.4 全文使用
- `WsMessage::FileReadResponse(FileReadResponse { ... })`、`WsMessage::FileWriteResponse(...)`、`WsMessage::FileDeleteResponse(...)` 全部引用了一个**未在 ws_types.rs 定义的 `WsMessage` 枚举**。
- 现有 ws.rs 用的是 `serde_json::json!({"type": "file_read_response", ...})` 直接构造（见 ws.rs:272-278, 287-292, 302-307）。
- **修复**：要么删掉 `WsMessage::FileReadResponse(...)` 调用、改用 `send_json(&serde_json::json!({"type": "file_read_response", ...}))`；要么在 ws_types.rs 加 `WsMessage` 枚举并实现序列化。
- **影响**：handler 代码字面编译失败。

#### N-2 响应结构遗漏 `status: String` 字段
- §3.4 所有 `FileReadResponse/FileWriteResponse/FileDeleteResponse` 构造都缺 `status` 字段，而 ws_types.rs:127-142 / 146-161 的现有类型强制要求 `status: String`。
- **修复**：每个响应构造加 `status: "ok".into()` 或 `"error".into()`。

#### N-3 §3.1 重定义 `FileDeleteResponse`，与 ws_types.rs:147 冲突
- 修正版定义 `FileDeleteResponse { id, timestamp, error: Option<String> }`。
- 现有 ws_types.rs:147 是 `FileDeleteResponse { id, status: String, timestamp, payload: FileDeleteResponsePayload { error: Option<String> } }`。
- **修复**：直接用 ws_types.rs 现有的，不要再写一份。

#### N-4 §4.4 `e.downcast_ref::<tokio_tungstenite::tungstenite::Message>()` 类型错误
- `client_async` 返回的 `Result<(_, _), tungstenite::Error>`，错误类型是 `tungstenite::Error`（enum），不是 `Message`。
- `Error::ConnectionClose(CloseFrame)` 或 `Error::Protocol(ProtocolError)` 是真正承载 close code 的变体。
- **修复**：`match e { tungstenite::Error::ConnectionClose(frame) => ... tungstenite::Error::AlreadyClosed => ... }`，或者用 `tungstenite::protocol::CloseCode` 来识别自定义 4001/4002。

#### N-5 `chronoUtc()` 与 ws_types.rs `current_timestamp()` 重复
- §3.4 末尾定义了 `fn chronoUtc()`（全小写驼峰违反 Rust 命名规范）。
- ws_types.rs:19 已有 `pub fn current_timestamp()`，且 ws.rs:262 等处已经在用。
- **修复**：删 `chronoUtc`，统一调 `crate::ws_types::current_timestamp()`。

#### N-6 `auto-launch` 0.5 API 用错
- §1.3：`AutoLaunch::new(AutoLaunchConfig { app_name: ..., app_path: ..., args: ..., ..Default::default() })`。
- `auto-launch = "0.5"` 实际签名：`AutoLaunch::new(name: impl Into<String>, path: impl Into<PathBuf>, args: Option<Vec<&str>>)` 或 `AutoLaunchBuilder`。
- **修复**：
  ```rust
  let al = AutoLaunch::new("FeClawDesktop", exe_path.to_string_lossy().as_ref(), Some(vec!["--minimized"]));
  ```

#### N-7 Cargo.toml TLS 依赖缺失
- §1.1 只加了 `auto-launch`/`dirs`/`base64`，**漏掉 native-tls 与 tokio-native-tls**。
- §4.4 直接 `use tokio_tungstenite::native_tls::TlsConnector; use tokio_native_tls::TlsConnectorExt;` 会找不到 crate。
- **修复**：Cargo.toml 追加：
  ```toml
  native-tls = "0.2"
  tokio-native-tls = "0.3"
  ```
  并把 `tokio-tungstenite` features 改为 `["connect", "native-tls"]`（或同时启用 native-tls 与 rustls）。

#### N-8 `ConsentManager::show_dialog` 方法未定义
- §3.3 `request_operation` 调用 `self.show_dialog(&description, risk).await`。
- consent.rs 中没有 `show_dialog` 方法，只有 `request()`。需要在 ConsentManager 上加这个私有方法（与 `request()` 共享 rfd 对话框逻辑）或把 `request_operation` 内联展开。

#### N-9 `WsClient::auth_failure` 字段未定义
- §4.4 用 `self.auth_failure.replace(())`。
- 现有 ws.rs:52-66 的 `WsClient` 结构体没有 `auth_failure` 字段。
- **修复**：加 `auth_failure: Arc<Once>`（或 `Arc<Notify>`），并在 close code 触发时调用 `self.auth_failure.notify_waiters()`；EngineManager 监听这个信号触发 `reauth_cloud()`。

### 🟡 安全性 / 健壮性

#### N-10 路径穿越防护 symlink 漏洞（与 P0-4/P0-5 重叠）
- §3.2 `resolve_desktop_path` 返回 `resolved`（pre-canonicalize 路径）。
- 攻击者可在 `~/Desktop/` 内放一个指向 `C:\Users\<user>\.ssh\id_rsa` 的 symlink（如果用户在该目录有创建 symlink 的权限或目录已被入侵者控制）。
- 调用方用 `tokio::fs::read(&resolved)` 时，OS 跟随 symlink 解析，绕过 `canonicalize().starts_with(allowed)` 检查。
- **修复**：`resolve_desktop_path` 应返回 `canonical`（或两者都返回），并对中间每个父目录做 `is_symlink()` 检查拒绝。

#### N-11 `assess_risk` trust 集合语义污染
- §3.3 把 `format!("{}:{}", operation, path)` 加入 `session_trust: HashSet<String>`。
- `session_trust` 当前唯一用途是 `request()` 的命令信任，并把内容序列化到 `~/.feclaw/trusted-commands.json`。
- 混入 `write:/mnt/desktop/foo.txt` 这类条目会让 `trusted-commands.json` 出现非命令行，未来 `load_trusted()` 反序列化会向用户呈现混乱状态。
- **修复**：新增 `session_trust_files: HashSet<String>` 与 `~/.feclaw/trusted-files.json`。

#### N-12 Cloud 端 token 失效应有 UI 引导
- §4.3 `reauth_cloud` 函数只 `cloud_token = None; save();` 然后 `Err(anyhow!("cloud re-auth required"))`——没说明 UI 怎么收到通知、怎么重新弹出登录表单。
- 现有 `AppState::send_notification` 提了一下但没实现细节。
- **修复**：补一个 `ControlMsg::ShowCloudLogin` 由 lib.rs controlPump 触发 Tauri 主窗口的事件（`app.emit("cloud-reauth-required", ())`）。

#### N-13 文件大小上限缺失
- §3.2 `tokio::fs::read` 一次性读整个文件再 base64。
- 4GB 视频会撑爆内存，base64 再 +33%。
- 与 design.md §6.2 的"FUSE 中转"边界情况没处理。
- **修复**：加 `MAX_FILE_BYTES = 1MiB`（与 executor.rs `MAX_OUTPUT_BYTES` 对齐），超大文件报错或分块流式发送。

### 🟢 实施细节

#### N-14 settings.ts `addEventListener` 在 TS strict 模式下不安全
- §2.4 多处 `document.getElementById(id)! as HTMLElement`——非空断言 + 类型断言容易运行时崩（id 拼错就 null）。建议封装 `$()` 函数返回 `T | null`，调用方判空。

#### N-15 §4.7 `state.config.save().ok()` 吞掉错误
- 应当 `if let Err(e) = state.config.save() { tracing::error!("save: {e:#}"); }`，否则用户感知不到保存失败。

#### N-16 §3.2 `rest.replace('/', "\\").into()` 在 Windows 上对 UNC 路径行为可疑
- `\\?\C:\...` 这种路径会被破坏。
- 实际上 `/mnt/desktop/C:/...` → `C:\...` 在普通 Windows 路径没问题，但实现最好加注释说明不支持 UNC。

#### N-17 缺少对 `self.ws_writer`/`self.ws_stream` 的定义
- §4.4 `run_inner` 里写了 `result = self.ws_writer.next()` 和 `self.ws_stream.send(msg)`——但这两个字段在 ws.rs:52-66 的 `WsClient` 结构里都没有。实际用的是 `ws: &mut WsStream`（run_loop 局部变量）和 `outgoing_rx` 通道。

#### N-18 模式切换的 `state.config.save().ok()` 在锁内调用
- §4.7 `let mut state = app_handle.state::<AppState>();` 然后 `state.config.save().ok()`——`AppState` 用 `Mutex` 包，`save()` 同步写文件会把 controlPump task 卡住。
- **修复**：把 save 移到 spawn_blocking 或单独 task 里。

---

## 实施顺序确认

修正版 §实施顺序：

```
阶段 0  Cargo.toml + ws_types.rs 类型补齐
阶段 1  设置界面
阶段 2  文件中继（Desktop + FeClaw）
阶段 3  开机自启
阶段 4  云模式连接
```

| 阶段 | 是否合理 | 备注 |
|------|---------|------|
| 0 | ✅ | 必须最先；所有 V2 都依赖 ws_types 完整 + Cargo.toml 全 |
| 1 | ⚠️ | 阶段 1 与阶段 0 强耦合（settings/HTML、auto-launch 开关都依赖 Cargo.toml）。建议把"auto-launch 依赖 + 字段定义"挪到阶段 0；阶段 1 只做窗口 + UI |
| 2 | ⚠️ | 文件中继**必须先**做但要拆细：(a) ws_types.rs 类型（阶段 0），(b) Rust file_bridge + 路径解析（与设计 §5.2 同步验证），(c) ws.rs handler 接线，(d) FeClaw 端 Python vfs.py 改写。顺序倒过来会导致 agent 看到 `/mnt/desktop/C:/foo` 路径时 desktop 端还没准备好 |
| 3 | ✅ | 独立、可并行 |
| 4 | ✅ | 必须最后做，依赖：WSS/TLS（N-7）、JWT header 校验（N-1/§4.5）、cancel_token 集成（N-9/N-14）、reauth UI（N-12） |

### 建议的微调

1. **把阶段 0 拆为 0a（依赖与类型） + 0b（config 新字段）**，避免阶段 1 重复改动 config.rs。
2. **阶段 2 加一步 §3.5 设计同步**：FeClaw 端 vfs.py 的 `/mnt/desktop/` 映射必须与 design.md §5.2 完全一致——建议把 design.md §5.2 表格的 "Windows / macOS / 远期" 三行抽出来作为 Python helper 的单元测试输入。
3. **阶段 4 不要单独做**：应合并到 E2E 测试里——本地模式 ↔ 云模式切换是核心 UX，单独 PR 容易断。

---

## 总结：本轮必须再修复（按优先级）

1. **N-7 Cargo.toml 补 `native-tls` + `tokio-native-tls`**（P1-4 真实闭环）
2. **N-1/N-2/N-3 删除自造 `WsMessage` 与冗余 response 类型定义，统一使用 ws_types.rs**（编译能过、协议对齐）
3. **P0-7 真实修复：改 §4.5 Python 端为 header-based auth（读 `websocket.headers["authorization"]`）**（设计一致）
4. **N-4 §4.4 close code 检测改用 `tungstenite::Error` 的 `ConnectionClose` 变体**（编译能过）
5. **N-6 `auto-launch` API 改为 `AutoLaunch::new(name, path, args)` 三参**（编译能过）
6. **N-9 §4.4 `WsClient` 加 `auth_failure: Arc<Notify>` 字段并在 handle_message 中触发**（P1-12 真实闭环）
7. **P0-5/N-10 file_bridge.rs 返回 `canonical` 而非 `resolved`**（symlink 攻击防御）
8. **P1-1/N-11 ConsentManager 拆出 `session_trust_files` 集合**（语义清洁）

修完这 8 条后即可按 §实施顺序推进，**不再会有编译期或协议错位阻塞**。

---

## 通过项

- 设计层面：路径映射语义、Cargo.toml 依赖大头、HTML 路径、JWT header 方向、auto-launch、--minimized、SetMode 触发重连、serde(default)、executor 解耦、Tauri 2 API、文件操作 risk 直接定级——全部形式落地。
- 现有代码资产：`auth.rs::Credentials` 的 password 字段（用于本地模式重登）不动是对的，`ws.rs` 的 30 次重连 + 1s 间隔保留也是对的，`consent.rs::assess_risk` 不变是正确的，`ws_types.rs` 的响应结构 `{id, status, timestamp, payload}` 是好的协议骨架。
- 测试基础设施：现有 cargo test 覆盖 ws_types.rs / consent.rs / auth.rs，新增模块（file_bridge.rs / settings.rs）应在 PR 中补单测；目前修正版没列测试清单，建议阶段 2/3/4 各自补 5+ 单测。