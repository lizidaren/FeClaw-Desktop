# FeClaw Desktop 设计规范

> 版本 1 — 2026-06-19
> 涵盖：定位、技术栈、双模式、通信协议、文件体系、执行体系、MVP 范围

---

## 1. 定位

**FeClaw Desktop 是 Agent 的"手和脚"。**

它是一个 Windows 原生桌面应用（Tauri），不处理任何 AI 逻辑。它的职责只有：

| 职责 | 说明 |
|------|------|
| 启动/管理本地 FeClaw 引擎 | 本地模式 |
| 提供 WS 隧道连接云端 Agent | 云模式 |
| 中继文件读写（`/mnt/desktop/`） | 双向 |
| 中继命令执行（弹窗确认后） | 双向 |
| 原生弹窗确认 | 安全 |
| 系统托盘 | 常驻 |
| 开机自启 | 便捷 |

**以下不属于 Desktop 的职责（由 FeClaw 引擎处理）：**
- LLM 调用
- 工具执行逻辑
- 知识库检索
- 错题识别
- 对话管理
- WeChat 消息通道
- 用户认证

---

## 2. 技术栈

**框架**: [Tauri 2.0](https://v2.tauri.app/)
- Rust 后端：进程管理、WS 通信、原生弹窗、系统托盘
- WebView：内嵌引擎 Web UI（可选）
- 单 exe <10MB

**Rust crate**:
- `tokio-tungstenite` — WebSocket 客户端
- `tray-icon` — 系统托盘
- `rfd` — 原生文件/消息对话框
- `auto-launch` — 开机自启
- `reqwest` — HTTP 客户端（登录、API）
- `serde` / `serde_json` — 序列化

---

## 3. 双模式

### 3.1 本地模式

```
用户双击 FeClaw-Desktop.exe
         │
         ├─ 1. Desktop 启动本地 FeClaw 引擎
         │      进程: feclaw --host 127.0.0.1 --port 8080
         │      配置自动写入 ~/.feclaw/config.toml
         │
         ├─ 2. Desktop 自动登录引擎
         │      POST http://127.0.0.1:8080/api/login
         │      凭据从 ~/.feclaw/local-credentials 读取
         │      （首次启动时引擎自建 admin + 随机密码，Desktop 保存）
         │
         ├─ 3. Desktop 建立 WS 连接
         │      ws://127.0.0.1:8080/ws/desktop
         │      
         └─ 4. 系统托盘常驻 + 弹出浏览器窗口
                 浏览器自动打开 http://127.0.0.1:8080
```

**安全**:
- 引擎只绑定 `127.0.0.1`，外部不可达
- 凭据存储在 `~/.feclaw/local-credentials`，本机进程可读（自用电脑可接受）
- 无远程攻击面

### 3.2 云模式

```
用户双击 FeClaw-Desktop.exe → 切换到"云模式"
         │
         ├─ 1. 显示登录界面
         │      用户名 + 密码 → POST feclaw.lizidaren.cn/api/login
         │      → 返回 JWT
         │      （远期可选：Agent 控制台扫码授权登录）
         │
         ├─ 2. Desktop 保存 JWT 到 ~/.feclaw/cloud-token
         │
         ├─ 3. Desktop 连接云端 WS
         │      wss://feclaw.lizidaren.cn/ws/desktop
         │      请求头: Authorization: Bearer <JWT>
         │
         └─ 4. 云端 Agent 识别到 Desktop 执行通道可用
                 可通过 Desktop 访问 /mnt/desktop/ 和 执行命令
```

**安全**:
- JWT 标准认证（已有成熟机制）
- 命令执行需弹窗确认
- 文件读写需弹窗确认
- WS 端点需 JWT 验证

### 3.4 Desktop 端点保护

Desktop 专用端点（`/ws/desktop`、`/api/v0.2/desktop/*`）**只在 Desktop 模式开启**。

| 环境 | 配置 | Desktop 端点 |
|------|------|-------------|
| 本地模式（用户笔记本） | `DESKTOP_ENABLED=true` | ✅ 开启 |
| 云模式（生产服务器） | `DESKTOP_ENABLED=false`（默认） | ❌ 不注册，零攻击面 |

云模式的 Desktop 不通过独立端点连接，而是通过 Agent 的**现有 WS 通道**——Desktop 上线时 Agent 注册为执行通道，跟 WeChat 通道平级。

```python
# config.py
DESKTOP_ENABLED: bool = False

# main.py — 条件注册
if settings.DESKTOP_ENABLED:
    from routers.desktop_ws import router as desktop_ws_router
    app.include_router(desktop_ws_router)
```

### 3.5 模式切换

用户通过系统托盘菜单切换模式：

```
[FeClaw Desktop 托盘图标]
├── 本地模式 🔵 (当前)
├── 云模式 🟢
├── ─────
├── 打开控制台
├── 重新连接
├── ─────
└── 退出
```

切换模式时断连当前 WS、清理旧连接、连接新模式指定的端点。

---

## 4. 通信协议（WebSocket）

### 4.1 连接

```
请求头: Authorization: Bearer <JWT>
端点:   /ws/desktop

引擎/云端验证 JWT 后建立连接。
JWT 过期时服务端关闭连接，Desktop 重新登录。
```

### 4.2 连接可靠性

#### 心跳

```
Desktop ── Ping (30s 间隔) ──→ 引擎
引擎    ── Pong ─────────────→ Desktop

Desktop 35s 内未收到 Pong → 判定断连
```

引擎侧也需要发送主动心跳——如果引擎崩溃、进程被 kill、或 WS 异常断开，Desktop 能立即感知。

#### 断连重连

```
检测到断连
  │
  ├─ 立即重试
  ├─ 等待 1s → 再试
  ├─ 等待 1s → 再试
  ├─ 等待 1s → 再试（匀速 1s 间隔，不求指数退避）
  │
  └─ 连续 30 次失败 → 放弃，托盘变红显示"连接失败"
     （用户手动点击"重新连接"开始新的一轮）
```

不使用指数退避。Desktop 是用户端应用，用户体验优先——用户看到图标变灰了，希望它立刻变绿。127.0.0.1 的本地重连在 1s 内完成，云模式切换 Wi-Fi 后 1s 一轮检测也足够灵敏。

#### 执行中掉线

```
Agent 发送了 command_exec_request (exec_id=xxx)
                 │
            Desktop 收到 → 开始执行
                 │
            Desktop 断网/关机
                 │
            Agent 侧等待 response
                 │
            30s WS 超时 → 收不到
                 │
            Agent 判定: "Desktop 执行超时"
                 │
            Agent 标记任务失败 (exit_code=124)
                 │
            Desktop 重连后：
              → 检查有未完成的 exec_id
              → 托盘冒泡提示用户

              桌面右下角冒泡：
              ╔══════════════════════════╗
              ║ ⚠️ FeClaw Desktop        ║
              ║                          ║
              ║ python3 analyze.py 因    ║
              ║ 连接中断未执行完成        ║
              ╚══════════════════════════╝

              用户点泡 → 跟 Agent 说 "刚才那个命令再跑一次"

  不使用 WeChat 作为通知渠道。WeChat 是消息渠道——跟 Agent 聊天的，
  不是收系统通知的。Desktop 自己有原生通知（托盘冒泡、Windows 通知中心）。
```

Desktop 重连后：
- Agent 检查 `pending` 队列 → 发现 `exec_id` 已超时 → **丢弃结果**，防止乱序
- 用户如果手动重试，会生成新的 `exec_id`，互不干扰

```python
# Agent 侧——执行超时与去重
PENDING_TIMEOUT = 300  # 5 分钟超时

async def exec_via_desktop(self, code):
    exec_id = str(uuid.uuid4())
    await self.desktop_channel.send_json({
        "type": "command_exec_request",
        "id": exec_id,
        "payload": {"command": code, "timeout": PENDING_TIMEOUT}
    })
    
    try:
        response = await asyncio.wait_for(
            self.pending.wait_for(exec_id),
            timeout=PENDING_TIMEOUT
        )
        return response
    except asyncio.TimeoutError:
        self.notify_user(f"Desktop 连接中断，命令未执行完成")
        return ExecResult(stderr="Desktop 连接中断", exit_code=124)
```

#### 状态指示

| 托盘图标 | 状态 | 含义 |
|---------|------|------|
| 🟢 绿色 | 已连接 | WS 正常，引擎运行中 |
| 🟡 黄色 | 重连中 | WS 断连，正在尝试重连 |
| 🔴 红色 | 已断开 | 重连失败，需用户干预 |
| ⚫ 灰色 | 停止 | 引擎未运行 |

### 4.3 消息格式

```json
{
  "type": "request_type",
  "id": "uuid",
  "payload": { ... },
  "timestamp": "2026-06-19T14:00:00Z"
}
```

响应格式：

```json
{
  "type": "response_type",
  "id": "uuid",
  "status": "accepted" | "rejected" | "timeout" | "error",
  "payload": { ... }
}
```

### 4.3 消息类型

#### 引擎/Agent → Desktop

| 类型 | 说明 | 风险等级 |
|------|------|---------|
| `file_read_request` | 读 `/mnt/desktop/` 文件 | L1（静默） |
| `file_write_request` | 写 `/mnt/desktop/` 文件 | L2（弹窗） |
| `file_delete_request` | 删 `/mnt/desktop/` 文件 | L3（弹窗+红） |
| `command_exec_request` | 执行命令 | L5（弹窗） |
| `notification` | 托盘冒泡通知 | — |

#### Desktop → 引擎/Agent

| 类型 | 说明 |
|------|------|
| `file_read_response` | 读结果 |
| `file_write_response` | 写结果 |
| `file_delete_response` | 删结果 |
| `command_exec_response` | 执行结果 |
| `consent_response` | 用户决策（allow/deny/always） |
| `disconnect` | Desktop 关闭/休眠 |

### 4.4 执行通道流程

```
Agent: "读取 /mnt/desktop/C:/Users/小明/成绩.txt"
  → WS: file_read_request { path }
  → Desktop 判断风险等级 L1 → 静默读取
  → WS: file_read_response { content }

Agent: "执行 python3 analyze.py"
  → WS: command_exec_request { command, args, cwd }
  → Desktop 判断风险等级 L5 → 弹出原生对话框
  → 用户点"允许"
  → WS: command_exec_response { stdout, stderr, exit_code }
```

---

## 5. 文件体系

### 5.1 三层路径

```
/mnt/desktop/...  ← Desktop 中继（WS 隧道）
                     云/本地 Agent 都能访问
                     读写需要弹窗确认（L1 读静默）
                     映射到用户本机文件系统

/workspace/...    ← FeClaw 自有工作区
                     Server 模式 → COS
                     本地模式 → ~/.feclaw/data/
                     Agent 随意读写，不弹窗

其他路径            ← Agent 临时文件、缓存
                     引擎自主管理
```

### 5.2 路径映射规则

| Desktop 端操作系统 | Agent 路径 | 映射到 |
|-------------------|-----------|--------|
| Windows | `/mnt/desktop/C:/Users/小明/file.txt` | `C:\Users\小明\file.txt` |
| Windows | `/mnt/desktop/D:/data/` | `D:\data\` |
| macOS（远期） | `/mnt/desktop/Users/xiaoming/file.txt` | `/Users/xiaoming/file.txt` |

### 5.3 安全约束

- Desktop 可配置**允许 Desktop 访问的目录白名单**
- 默认白名单：`C:\Users\<用户名>\Desktop`、`C:\Users\<用户名>\Documents`
- 用户可在 Desktop 设置中增删白名单
- 超出白名单的路径访问直接拒绝（不弹窗）

---

## 6. 执行体系

### 6.1 执行决策树

```
Agent 需要执行一个命令

    ┌─────────────────────────────────────┐
    │                                     │
    ▼                                     ▼
 本地模式 (Desktop)                  云模式 (Server)
    │                                     │
    │                              Desktop 已连接?
    │                              ├── 是: bwrap 绑定 /mnt/desktop/ FUSE
    │                              │     Agent 正常执行，文件操作走 FUSE
    │                              │     → WS → Desktop 确认 → 中继文件
    │                              │
    │                              └── 否: 跟以前一样，没有 /mnt/desktop/
    │                                    /workspace/ 正常走 COS
    │
    └── WS → Desktop 弹窗确认 → 执行        执行结果统一返回
         │                                       │
         └── Agent 在 Desktop 上执行        Agent 在服务器 bwrap 里执行
              （无 bwrap）                      （有 bwrap）
```

### 6.2 云模式的 /mnt/desktop/ 工作原理

```
Agent (服务器 bwrap 沙箱内)
        │
  访问 /mnt/desktop/C:/Users/小明/成绩.csv
        │
  沙箱内 FUSE 挂载点 (/mnt/desktop/)
        │
  FUSE daemon 检测到文件操作
        │
  ┌─────┴──────┐
  │             │
 读文件 (L1)    写/删文件 (L2/L3)
  │             │
 静默通过       WS → Desktop 弹窗
  │             │
  └─────┬──────┘
        │
  WS → Desktop 读取/写入文件
        │
  FUSE daemon 收到响应 → 返回给 Agent

Agent 不感知文件在远程——只觉得在读文件系统。
```

| 组件 | 角色 |
|------|------|
| bwrap 沙箱 | 隔离 Agent 执行环境 |
| FUSE (`/mnt/desktop/`) | 拦截文件操作，中转到 Desktop |
| WS 隧道 | 传输文件数据和确认请求 |
| Desktop | 执行实际文件 I/O，弹窗确认 |
| Agent | 不知情，正常读/写文件路径 |

### 6.3 Agent 级 Desktop 连接检测

```python
# 每个 Agent 独立检测 Desktop 是否在线
class AgentExecutor:
    def has_desktop_channel(self) -> bool:
        """Desktop 通道是否在线"""
        return "desktop" in self.execution_channels and \
               self.execution_channels["desktop"].active
    
    def should_bind_mnt_desktop(self) -> bool:
        """沙箱是否要绑定 /mnt/desktop/"""
        return self.has_desktop_channel()
```

- 未连接 Desktop: `/mnt/desktop/` 不存在，Agent 不知道有这个路径
- Desktop 连接时: Agent 的沙箱启动时绑定 `/mnt/desktop/` FUSE 挂载点
- Desktop 断连: 沙箱内 `/mnt/desktop/` 变为不可用（I/O 错误）

### 6.4 风险等级

| 等级 | 操作 | 行为 |
|------|------|------|
| L1 | 读文件（`/mnt/desktop/` read） | 静默执行，不弹窗 |
| L2 | 写文件 | Desktop 弹窗确认 |
| L3 | 删文件 | Desktop 弹窗 + 红色警告 |
| L4 | 网络请求 | Desktop 弹窗确认 |
| L5 | 命令执行（Python/bash） | Desktop 弹窗确认 |

风险等级通过模式匹配判定，而非命令名——检测 `>`、`rm`、`curl`、`python3` 等关键词。

### 6.3 WeChat 降级

用户关闭 Desktop 窗口但机器未关机时：

```
Agent 请求执行 → WS 超时（Desktop 不在线）
  → Agent 通过 WeChat 发送：
    "🛡️ 需要执行：python3 analyze.py
     回复 Y 允许 / N 拒绝"
  → 用户微信回复 Y
  → Agent 暂存请求
  → Desktop 下次上线时执行
```

---

## 7. 引擎配置

### 7.1 配置方式

FeClaw 平台使用 Pydantic Settings，自动从 `.env` 文件读取配置。
Desktop 写入 `~/.feclaw/.env`，FeClaw 自动加载。

**配置优先级**：
```
环境变量 > CLI 参数（未来） > ~/.feclaw/.env > .env（项目根目录） > config.py 默认值
```

### 7.2 Desktop 写入的配置

```env
# ~/.feclaw/.env
STORAGE_MODE=local
DESKTOP_ENABLED=true
HOST=127.0.0.1
PORT=8080
```

Desktop 写入规则：
1. **先读取** `~/.feclaw/.env` 中的现有内容
2. **替换** Desktop 管理的键（STORAGE_MODE、HOST、PORT、DESKTOP_ENABLED）
3. **保留** 用户已配置的键（JWT_SECRET、LLM API Key、COS 密钥等）
4. **如果 `.env` 完全不存在**，Desktop 弹配置引导页

```rust
// Desktop 配置合并逻辑（伪代码）
fn write_env(config: &Config) -> Result<()> {
    let path = feclaw_dir().join(".env");
    
    // 1. 读取现有 .env（如有）
    let mut existing = std::collections::HashMap::new();
    if path.exists() {
        for line in std::fs::read_to_string(&path)?.lines() {
            if let Some((k, v)) = line.split_once('=') {
                existing.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
    }
    
    // 2. 覆盖 Desktop 管理的项
    existing.insert("STORAGE_MODE".into(), "local".into());
    existing.insert("HOST".into(), "127.0.0.1".into());
    existing.insert("PORT".into(), config.port.to_string());
    existing.insert("DESKTOP_ENABLED".into(), "true".into());
    
    // 3. 写回
    let content: String = existing.iter()
        .map(|(k, v)| format!("{k}={v}\n"))
        .collect();
    std::fs::write(&path, content)?;
    Ok(())
}
```

### 7.3 首次配置引导

`.env` 不存在时（首次使用），Desktop 弹出配置页面：

```
┌──────────────────────────────────────┐
│  欢迎使用 FeClaw Desktop             │
│                                      │
│  LLM API Key 是必填项，否则无法对话:  │
│                                      │
│  [_____________________________]     │
│                                      │
│  存储后端: [本地磁盘 ▼]               │
│                                      │
│  COS 密钥（可选，使用云存储时填写）:   │
│  [_____________________________]     │
│                                      │
│  [✅ 启动 FeClaw]                    │
└──────────────────────────────────────┘
```

### 7.4 引擎启动命令

```bash
# Desktop 内部启动引擎
feclaw
# 引擎自动从 ~/.feclaw/.env 读取配置
```

### 7.5 本地凭据存储

```json
# ~/.feclaw/local-credentials
{
  "username": "admin",
  "password": "aB3#kM9$xR7$",
  "token": "eyJhbGciOi..."
}
```

首次启动：
1. 引擎启动 → 检测无 admin 用户 → 创建 admin + 随机密码
2. Desktop 扫描引擎 stdout 提取密码
3. Desktop POST 登录 → 拿 JWT → 存储
4. 以后启动直接读 token

---

## 8. MVP 范围

### 🌱 MVP（最低可用版本）

```
□  Tauri 项目骨架搭建
□  本地模式：
    □  引擎进程管理（spawn / health check / graceful kill）
    □  自动登录（首次随机密码 + 后续 token）
    □  WS 双向通信（连接 / 心跳 / 重连）
    □  弹窗确认（L3/L5 级别）
    □  命令执行中继（subprocess + stdout/stderr 回传）
□  系统托盘（显示/隐藏/退出）
□  端口冲突检测（8080 被占用自动换）
```

### 🌿 V2（功能完整）

```
□  云模式：
    □  登录界面（用户名 + 密码）
    □  远程 WS 连接
□  文件中继（/mnt/desktop/ 读写）
□  开机自启
□  原生通知（托盘冒泡）
□  设置界面（白名单、端口、自启开关）
□  WebView 内嵌引擎 Web UI
```

### 🌳 V3（成熟版）

```
□  MSI 安装包 + 数字签名
□  自动更新（GitHub Releases）
□  日志查看器
□  多语言
□  Agent 控制台扫码授权登录
□  2FA（密码 + Agent 级 TOTP）
```

---

## 9. 分发

- **GitHub Releases**（自动构建 + 上传）
- README 提供直接下载链接（可放 COS）
- 单 exe，绿色运行，无需安装
- 未来提供 MSI 安装包

---

## 10. 开发指南

```bash
# 前置条件
cargo install tauri-cli
rustup target add x86_64-pc-windows-msvc

# 本地开发
cd FeClaw-Desktop
cargo tauri dev

# 构建
cargo tauri build
# 输出: src-tauri/target/release/FeClaw-Desktop.exe
```

---

## 11. 参考

- FeClaw 引擎仓库: [lizidaren/FeClaw](https://github.com/lizidaren/FeClaw)
- FeClaw-Desktop 仓库: [lizidaren/FeClaw-Desktop](https://github.com/lizidaren/FeClaw-Desktop)
- Tauri 文档: https://v2.tauri.app
- 审计报告: `docs/desktop-mode-audit-report.md`
