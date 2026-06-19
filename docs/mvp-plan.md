# FeClaw Desktop MVP 实施计划

> 目标：一个可用的 Windows 原生桌面应用
> 用户双击 exe → 引擎启动 → 系统托盘常驻 → 可聊天、可弹窗确认执行命令

---

## 0. 前置依赖

**开始前需要确认**：

| 依赖 | 说明 | 安装 |
|------|------|------|
| Rust 工具链 | 编译 Tauri + 项目代码 | `winget install Rustup` → `rustup default stable` |
| Tauri CLI | 构建/运行 Tauri 项目 | `cargo install tauri-cli` |
| WebView2 | Windows 上 Tauri 的渲染引擎 | Win10/11 自带 ✅ |
| Node.js | Tauri 前端构建工具链 | `winget install OpenJS.NodeJS` |

**feclaw 引擎**：本地模式需要引擎可执行文件。MVP 阶段 Desktop 假设 `feclaw` 在 PATH 里（pip install 后就有）。未来 Desktop 可自带嵌入式引擎包。

---

## 1. 项目结构

```
FeClaw-Desktop/
├── src-tauri/                ← Rust 后端
│   ├── src/
│   │   ├── main.rs           ← 入口 + Tauri 构建器
│   │   ├── engine.rs         ← 引擎进程管理（spawn / kill / health）
│   │   ├── ws.rs             ← WebSocket 客户端（连接 / 心跳 / 重连 / 消息处理）
│   │   ├── consent.rs        ← 弹窗确认逻辑（rfd 原生对话框）
│   │   ├── executor.rs       ← 命令执行（subprocess）
│   │   ├── auth.rs           ← 登录 / token 管理
│   │   ├── config.rs         ← 配置读写（~/.feclaw/config.toml）
│   │   └── tray.rs           ← 系统托盘
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── src/                      ← 前端（Tauri WebView）
│   ├── App.svelte            ← 最小 Web UI（可选 MVP 跳过）
│   ├── main.js
│   └── index.html
│
├── docs/design.md            ← 设计规范
├── README.md
├── LICENSE
├── .gitignore
└── package.json
```

---

## 2. 分步计划（5 个 PR，4-6 天）

### PR 1: 项目骨架 + 引擎进程管理（1 天）

**目标**：`cargo tauri dev` 跑起来，能启动/停止引擎。

```rust
// engine.rs
pub struct EngineManager {
    process: Option<Child>,
    port: u16,
}

impl EngineManager {
    /// 启动 feclaw 引擎
    /// feclaw --host 127.0.0.1 --port 8080
    pub fn start(&mut self) -> Result<()>;
    
    /// 健康检查（GET /health）
    pub fn health_check(&self) -> bool;
    
    /// 优雅停止（先 SIGTERM，5s 后 SIGKILL）
    pub fn stop(&mut self) -> Result<()>;
}
```

**关键边界情况**：
- 端口 8080 被占用 → 自动扫描 8080-8089
- 引擎崩溃 → 自动重启（最多 3 次，指数退避）
- 引擎 stdout/stderr → Desktop 日志文件

**产出**：
- [ ] Tauri 项目创建成功
- [ ] 空窗口能打开
- [ ] `EngineManager` 能启动/停止引擎
- [ ] 引擎崩溃能检测

### PR 2: 引擎自动登录 + Token 管理（0.5 天）

**目标**：引擎启动后 Desktop 自动登录，拿到 JWT。

```rust
// auth.rs
pub struct AuthManager {
    engine_url: String,
    token_path: PathBuf,  // ~/.feclaw/local-credentials
}

impl AuthManager {
    /// 首次启动：读取引擎 stdout 提取密码
    pub fn extract_password_from_stdout(&self, stdout: &str) -> Option<String>;
    
    /// POST /api/login → 拿 JWT
    pub async fn login(&self, password: &str) -> Result<String>;
    
    /// 保存 token 到文件
    pub fn save_token(&self, token: &str);
    
    /// 从文件读取 token
    pub fn load_token(&self) -> Option<String>;
}
```

**关键边界**：
- 首次启动引擎日志里提取随机密码
- `~/.feclaw/` 目录不存在时自动创建
- 登录失败时重试（最多 3 次）

**产出**：
- [ ] 引擎启动后自动登录成功
- [ ] 拿到 JWT
- [ ] JWT 持久化到文件

### PR 3: WebSocket 双向通信（1.5 天）

**目标**：Desktop 连上引擎 WS，Agent 能发执行请求，Desktop 能回响应。

```rust
// ws.rs
pub struct WsClient {
    ws: Option<WebSocket>,
    url: String,
    jwt: String,
    pending_requests: HashMap<String, PendingRequest>,
}

impl WsClient {
    /// 连接引擎 WS 端点
    pub async fn connect(&mut self) -> Result<()>;
    
    /// 处理收到的消息（匹配请求 ID，触发回调）
    pub async fn handle_message(&mut self, msg: Message);
    
    /// 发送响应（执行结果 / 决策结果）
    pub async fn send_response(&self, id: &str, payload: Value);
    
    /// 心跳（每 30s ping）
    pub async fn heartbeat(&self);
    
    /// 自动重连（指数退避：1s, 2s, 4s, 8s... 最多 60s）
    pub async fn reconnect(&mut self);
    
    /// 接收消息并分发给对应处理器
    pub async fn listen(self, sender: mpsc::Sender<Event>);
}
```

**协议消息处理**（MVP 只需 `command_exec_request` 和 `command_exec_response`）：

```rust
#[derive(Deserialize)]
#[serde(tag = "type")]
enum WsMessage {
    #[serde(rename = "command_exec_request")]
    ExecRequest { id: String, payload: ExecPayload },
    // MVP 先只处理这一种
}

#[derive(Deserialize)]
struct ExecPayload {
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    timeout: Option<u64>,
}
```

**关键边界**：
- 断连检测（60s 收不到 ping 判定断连）
- 消息超时（发送后 30s 无响应报错）
- JWT 过期 → 触发重登
- 消息排队（断连时暂存，重连后发送）

**产出**：
- [ ] Desktop 能收 `command_exec_request`
- [ ] 消息解析 + 分发正确
- [ ] 心跳正常
- [ ] 断连重连工作
- [ ] 单元测试：消息序列化/反序列化

### PR 4: 弹窗确认 + 命令执行（1.5 天）

**目标**：收到执行请求 → 弹原生窗 → 用户决策 → 执行 → 返回结果。

```rust
// consent.rs
pub struct ConsentManager {
    trusted_commands: HashSet<String>,  // "始终允许" 列表
}

impl ConsentManager {
    /// 弹原生确认对话框
    /// 返回: Allow | Deny | AlwaysAllow
    pub fn show_dialog(&self, command: &str, risk_level: u8) -> DialogResult;
    
    /// 命令风险等级判定（模式匹配）
    pub fn assess_risk(command: &str) -> u8;
}

// executor.rs
pub struct CommandExecutor;

impl CommandExecutor {
    /// 执行命令，返回 stdout/stderr/exit_code
    pub fn execute(command: &str, args: &[String], cwd: &Path) -> ExecResult;
}
```

**弹窗 UI**（`rfd` crate）：

```
┌──────────────────────────────────────┐
│ 🔒 FeClaw Desktop                    │
│                                      │
│ Agent 要执行：                        │
│   python3 analyze.py --input data.csv │
│                                      │
│        [✅ 允许]   [❌ 拒绝]          │
│                                      │
│    ☐ 本次会话始终允许这样的命令        │
└──────────────────────────────────────┘
```

**风险等级判定**（模式匹配）：

```rust
pub fn assess_risk(command: &str) -> u8 {
    let command = command.to_lowercase();
    
    // L3: 删除
    if command.starts_with("rm ") {
        return 3;
    }
    
    // L5: Python/代码执行
    if command.starts_with("python3") || command.starts_with("python ") {
        return 5;
    }
    
    // L4: 网络
    if command.starts_with("curl ") || command.starts_with("wget ") {
        return 4;
    }
    
    // L2: 写文件/重定向
    if command.contains(">") || command.contains(">>") {
        return 2;
    }
    
    // 默认：低风险
    1
}
```

**完整执行流程**：

```
收到 WS command_exec_request
  → assess_risk(command) → L5
  → show_dialog(command) 
     → 用户点 "允许"
        → CommandExecutor::execute(command, args, cwd)
        → WS 发回 command_exec_response { stdout, stderr, exit_code }
     → 用户点 "拒绝"
        → WS 发回 command_exec_response { status: "rejected" }
     → 用户点 "始终允许"
        → 加入 trusted_commands
        → CommandExecutor::execute(...) → 返回结果
```

**关键边界**：
- 命令执行超时（默认 300s，可配置）
- stdout 太长截断（默认 1MB）
- `cwd` 不存在时自动 mkdir
- 始终允许列表持久化到文件（会话级 = 内存；永久级 = 文件）

**产出**：
- [ ] 弹窗能显示
- [ ] 三种决策（允许/拒绝/始终允许）正常工作
- [ ] 命令执行正确
- [ ] stdout/stderr/exit_code 返回正确
- [ ] 边界情况处理（超时、空输出、长输出）

### PR 5: 系统托盘 + 集成收尾（0.5 天）

**目标**：系统托盘常驻、启动流程完整的 MVP。

```rust
// tray.rs
pub fn build_tray() -> SystemTray {
    SystemTray::new()
        .with_menu(
            Menu::new()
                .add_item(MenuItem::new("打开控制台", "open"))
                .add_item(MenuItem::new("切换模式"))
                .add_separator()
                .add_item(MenuItem::new("重新连接", "reconnect"))
                .add_separator()
                .add_item(MenuItem::new("退出", "quit"))
        )
}
```

```rust
// main.rs — 启动流程
fn main() {
    // 1. 读配置 (~/.feclaw/config.toml)
    let config = Config::load();
    
    // 2. 启动引擎
    let mut engine = EngineManager::new(config.port);
    engine.start();
    engine.wait_healthy();
    
    // 3. 登录 + 拿 JWT
    let auth = AuthManager::new(config.engine_url());
    let jwt = auth.login_or_load();
    
    // 4. 连 WS
    let ws = WsClient::new(config.ws_url(), &jwt);
    tokio::spawn(ws.listen(event_sender));
    
    // 5. 系统托盘
    TauriApp::new()
        .system_tray(build_tray())
        .on_event(handle_event)
        .run();
}
```

**产出**：
- [ ] 系统托盘显示/隐藏/退出
- [ ] 完整启动流程（引擎→登录→WS→托盘）
- [ ] 完整关闭流程（WS 断连→引擎 SIGTERM→进程清理）

---

## 3. 时间线

```
Day 1:  PR 1 — 项目骨架 + 引擎进程管理
Day 2:  PR 2 — 引擎自动登录 + Token 管理
Day 2-3: PR 3 — WebSocket 双向通信
Day 4-5: PR 4 — 弹窗确认 + 命令执行
Day 5:   PR 5 — 系统托盘 + 集成收尾
               ─────────────────
          总计 ~5 个工作日
```

每个 PR 独立可测。PR 1 完成后就可以 `cargo tauri dev` 看到空窗口+引擎启动了。

---

## 4. 不做的事（明确排除在 MVP 外）

| 功能 | 原因 |
|------|------|
| 云模式 | 需要引擎端修改，MVP 纯本地 |
| 文件中继（`/mnt/desktop/`） | 需要 WS 协议扩展，V2 做 |
| WebView 内嵌引擎 UI | MVP 弹浏览器窗口即可 |
| 自动更新 | 成熟版再做 |
| 开机自启 | V2 做 |
| WeChat 降级确认 | V3 做 |
| 扫码授权登录 | V3 做 |
| 前端 Web UI（Svelte/React） | MVP 零前端代码 |
| MSI 安装包 | V3 做 |

MVP 只有三个用户可见功能：
1. ⬛ 系统托盘图标（引擎活了/死了）
2. 🔒 弹窗确认（Agent 要执行命令时弹）
3. 🌐 自动打开浏览器（向 http://127.0.0.1:8080）
