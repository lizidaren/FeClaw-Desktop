# FeClaw-Desktop V3 实施计划

> 基于 vision-0620.md（Vision v3.1 群广场版）。**本文档自包含，不依赖外部文档。**
> 每个阶段写明：目标 → 交付物 → 具体文件 → 数据模型 → API 端点 → 完成条件。
>
> 最后更新：2026-06-20

---

## 0. 一句话定位

> **FeClaw-Desktop 让每个用户拥有一个属于自己的 AI 群广场。**
>
> 像微信一样使用你的 AI Agents：每个 Agent 是一个「联系人」，用户站在多 Agent 社交网络中央。
>
> **设计灵感：** 清华大学 OpenMAIC（《From MOOC to MAIC》，JCST 2026）提出的多 Agent 互动课堂范式——一个备课群中，老师-Agent 备课、好学生-Agent 提挑战性问题、学困生-Agent 指出易错点，三者协同产出更优教案。FeClaw-Desktop 将此范式普遍化：用户是所有 Agent 的「共同好友」，私聊、群聊、群广场、小程序、搜一搜构成完整的 AI 社交体验。

---

## 1. 当前状态盘点（2026-06-20）

按代码仓库实际状况盘点：

### 1.1 已完成

| 模块 | 文件 | 状态 |
|------|------|------|
| 引擎进程管理 | `engine.rs` | ✅ 完成（spawn / health / 优雅停） |
| 本地登录 | `auth.rs` | ✅ 完成（stdout 提取密码 + JWT 缓存） |
| WS 客户端 | `ws.rs` + `ws_types.rs` | ✅ MVP 完成（chat_message / chat_reply / chat_event / file_* / command_exec / file_operation_request / consent_response） |
| 弹窗确认 | `consent.rs` | ✅ 完成（5 风险等级 + rfd） |
| 命令执行 | `executor.rs` | ✅ 完成（subprocess + 截断 + 超时） |
| 系统托盘 | `tray.rs` | ✅ 完成（5 项菜单） |
| 设置界面 | `settings.rs` + `settings/index.html` | ✅ 完成（常规 / 云端 Tab） |
| 欢迎页 | `welcome.rs` + `welcome/index.html` | ✅ 完成（三卡片：官方 / 自建 / 本地） |
| 本地模式引导 | `local_setup.rs` + `local_setup/index.html` | ✅ 完成（9 命令流程） |
| 主题 | `set_theme / get_theme` | ✅ 完成 |
| 文件桥接 | `file_bridge.rs` | ✅ MVP 完成（path 解析 + canonicalize + symlink 防护 + 1MiB 上限） |
| 聊天历史 | `chat.rs`（chat_history.json） | ✅ MVP 完成 |
| 首次启动检测 | `welcome::check_first_launch` | ✅ 完成 |

### 1.2 V2 阶段收尾（前置依赖）

| 阶段 | 功能 | 关键变更 | 当前 |
|------|------|---------|:----:|
| 0 | Cargo + ws_types + ws.rs 改造 | 补 `FileWriteResponse`、重连检测 close code 4xxx、auth_failure notify | ⬜ |
| 1 | 设置界面 | 已基本完成，待 camelCase 全面验证（`loginUrl` 等） | 🟡 |
| 2 | 文件桥接 | `file_bridge.rs` 已实现，待 ws.rs handler 接入 + 引擎 `/mnt/desktop/` 映射 | ⬜ |
| 3 | 开机自启 | `auto-launch` 0.5 三参构造 + `--minimized` CLI | ⬜ |
| 4 | 云模式连接 | `.well-known/feclaw-desktop` 已就绪（`type=platform/local`），待 `cloud_login`/`cloud_disconnect` 命令 + JWT 头鉴权 | ⬜ |

V2 收尾是 **进入 V3 的前置**——V3 的所有云端能力（群广场、MCP 中继、全盘索引搜索）都依赖 V2 的云模式连接 + JWT 头鉴权 + 文件桥接。

### 1.3 V3 还未开始

全部 12 个阶段都未启动。当前 `chat.rs` 仅支持单 Agent 单窗口聊天，UI 是单栏布局（`chat/index.html` 单个聊天窗口），群聊 / 群广场 / 三栏 UI / ⌘K / 扫码上传 / MCP 客户端全部不存在。

---

## 2. 关键架构决策（基于代码现实 + Vision v3.1）

### 2.1 双模式：本地 + 云端，对外接口一致

```
┌──────────────────────────────────────────────────────────┐
│                  FeClaw-Desktop（Tauri）                  │
│                                                          │
│  UI 层：欢迎页 → 设置 → 主聊天窗口（V3 重构为三栏）       │
│  Rust 层：chat | config | consent | engine | ws | auth    │
│                                                          │
└────────────────────┬────────────────────┬────────────────┘
                     │ 本地模式            │ 云模式
                     ▼                    ▼
       ┌──────────────────────┐  ┌────────────────────────┐
       │ 本地 FeClaw 引擎     │  │ wss://feclaw.lizidaren │
       │ (subprocess 127.0.0.1│  │ .cn/ws/desktop/{hash}  │
       │  :8080)             │  │ (JWT RS256 头鉴权)     │
       └──────────────────────┘  └───────────┬────────────┘
                                             │ OAuth Client
                                             ▼
                              ┌──────────────────────────────┐
                              │ FirstEntrancePlatform        │
                              │ (OAuth/OIDC Provider, RS256) │
                              │ /.well-known/openid-         │
                              │ configuration + jwks.json    │
                              └──────────────────────────────┘
```

**统一 WS 协议：** 本地模式连 `ws://127.0.0.1:{port}/ws/desktop/{hash}`，云模式连 `wss://...`，消息信封 `{type, id, payload, timestamp}` 完全一致。Desktop 端不需要为云模式写额外协议代码——只需要换 `ws_url()`（见 `config.rs`）。

**鉴权一致性：**
- 本地：Desktop 通过 stdout 解析的密码 → `POST /api/user/login` → JWT
- 云端：Desktop → Platform OAuth flow（`/authorize` → `/token`）→ JWT → 用同一 JWT 连 FeClaw WS
- 引擎端用 `utils/auth.py::decode_jwt_token` 验证，**不区分本地还是云端**——只要 JWT 签名正确 + `user_id` 存在 + 拥有 `agent_hash` 即通过

### 2.2 「群广场」命名调整

| 旧 Vision v3 名称 | 新 Vision v3.1 名称 | 原因 |
|-------------------|---------------------|------|
| 朋友圈 | **群广场** | "朋友圈" 为腾讯商标，本产品不再使用 |
| Agent 朋友圈 | **群内 Agent 产出动态墙** | 强调范围 = 单个群，非全局 |

代码内统一用 `moments`（命名空间）+ UI 显示「群广场」（仅中文文案）。**不要**重命名代码中的 `moments` 模块。

### 2.3 群聊上云：Engine 侧模型层（必要改动）

**群功能必须上云。** 将来移动端 APP 直接调同一套 API，Desktop 不能独享群逻辑。

```
FeClaw Engine (Python) 侧新增：

Group 表 (SQLite)
├── id: str (UUID)
├── name: str
├── announcement: str (群公告)
├── created_at: datetime
├── owner_user_id: int
├── settings: JSON
│   ├── allow_agent_edit_name: bool      — 允许 Agent 改群名
│   ├── allow_agent_edit_announce: bool  — 允许 Agent 改公告
│   └── moments_enabled: bool            — 是否开启群广场
└── context_isolation: bool = true       — 隔离单聊/群聊上下文

GroupMember 表
├── group_id: str → Group.id
├── agent_hash: str → AgentProfile.hash
└── role: str ("owner" | "member")

群消息路由：
用户发消息 → Engine 收到 → 并行/串行调用群内每个 Agent
→ 聚合结果 → 推给 Desktop

群 WS：/ws/desktop/groups/{group_id}?token=<JWT>

API 端点：
├── POST /api/groups/create — 创建群
├── POST /api/groups/{id}/send — 发送群消息（用户触发）
├── GET  /api/groups/{id}/messages — 获取历史
├── POST /api/groups/{id}/join — 拉 Agent 入群
├── POST /api/groups/{id}/leave — 踢出
├── PATCH /api/groups/{id}/settings — 更新群设置
├── DELETE /api/groups/{id} — 解散群
└── GET  /api/desktop/groups — 列出用户所有群
```

**@提及语义：** Engine 解析 `@Agent A` → 给被 @ 的 Agent 注入 `system_injection: "用户 @ 了你"`。

### 2.4 群广场：Engine 侧事件管理

群广场跟着群走，群在引擎侧，群广场也应在引擎侧。

```
GroupMoments 表 (SQLite)
├── id: str (UUID)
├── group_id: str → Group.id
├── agent_hash: str (发布者)
├── kind: str ("task_done" | "file_changed" | "analysis" | "manual")
├── title: str
├── content: str
├── data: JSON (附件/链接等)
└── created_at: datetime

流程：
Agent 完成任务 → tools_service 检测 → 写入 GroupMoments 表
→ WS 推送 `moments_event` 给群内所有成员所属 Desktop
→ Desktop 收到后缓存到 ~/.feclaw/groups/{group_id}_moments.json
→ 前端按群展示
```

**引擎必须改动：** 新建 `models/group.py`、`routers/group.py`、`services/group_service.py`

### 2.5 文件中继：两种路径映射 + 安全策略 + FUSE 权限

#### 映射路径

**已实现（V2）：**
```
Agent: /mnt/desktop/C:/Users/xm/data.csv
  → Engine vfs.py resolve_path()
  → WS file_read_request { path: "/mnt/desktop/C:/Users/xm/data.csv" }
  → Desktop file_bridge.resolve_desktop_path()
  → C:\Users\xm\data.csv (canonicalize + symlink 防护 + 1MiB 上限)
  → 读 → base64 → WS file_read_response { content }
  → Engine vfs 透明返回给 Agent
```

**V3 新增（VFS 共享）：**
```
Desktop 文件管理器面板 → invoke('list_vfs_directory', { agent_hash, path })
  → Engine GET /api/desktop/agents/{hash}/vfs?path=/workspace/exams/
  → 列出文件树
  → Desktop 显示
  → 用户点文件 → invoke('read_vfs_file', { agent_hash, path })
  → Engine 读 Agent VFS (COS 或本地) → 返回内容
```

#### Agent 文件编辑工具（两种）

Agent 通过 VFS 工具操作文件时，提供两种写入模式：

| 工具 | 行为 | 适用场景 |
|------|------|---------|
| **写文件（覆盖）** | 完整重写文件 | 生成新文件、完全替换内容 |
| **写文件（替换）** | Agent 提供 `match_string` + `new_string`，系统搜索并替换 | 局部修改，保留文件其他部分 |

**替换写安全规则：** `match_string` 必须在文件中**唯一出现**。若匹配到多处，返回错误并列出所有匹配位置，由 Agent 选择更精确的匹配串。防止误替换。

#### /mnt/desktop/ 安全日志

Agent 对 `/mnt/desktop/` 下文件的每次读写操作必须附带**一句话描述修改意图**：

```
WS file_write_request {
  path: "/mnt/desktop/C:/Users/xm/report.docx",
  content: base64,
  intent: "更新期中考试成绩统计表，添加新的柱状图"
}
```

系统自动记录安全日志到 `~/.feclaw/security_logs/`：
```json
{
  "timestamp": "2026-06-20T11:47:00Z",
  "agent_hash": "a1b2c3",
  "path": "/mnt/desktop/C:/Users/xm/report.docx",
  "operation": "write",
  "intent": "更新期中考试成绩统计表，添加新的柱状图",
  "permission_mode": "balanced",
  "approved": true
}
```

#### FUSE 层权限执行（云模式核心优势）

在运行于 SaaS 平台的云模式连接中，Agent 的 Bash 工具在服务器端 **bwrap 沙箱**中执行。对用户本地文件的影响通过 **FUSE 中继**完成。

```
bwrap sandbox (服务器)
  ↓ Agent 执行 vfs.write("/mnt/desktop/...")
  ↓ Engine interceptor 拦截
  ↓ WS file_write_request → Desktop
  ↓ Desktop consent 审批
  ↓ 实际写入本地文件系统
```

FUSE 层天然能：
- **监控所有文件操作** — 每个 read/write/delete 都经过 FUSE，没有绕过路径
- **精细权限控制** — 在 FUSE 端应用权限规则（禁止删除、只读目录等）
- **实时审计日志** — 每个操作记录 intent + 文件 hash + 时间戳
- **操作可视化** — Desktop 可在文件管理器中用颜色标记 FUSE 文件的状态

**设计价值：** FUSE + 中继 WS 构成一个**不可绕过的安全审计层**。Agent 无法直接访问用户文件系统，所有操作都经过这个层。

#### 文件修改展示（diff UI）

参考 Claude Code CLI 的 diff 展示方式——**可视化差异，而非 Git 式统一 diff**：

```
┌─ 修改前 ─────────────────────┐
│ 期中考试成绩统计表初稿.docx   │
│                              │
│ 成绩分布：                    │
│ 90以上：5人                  │  ← 红色背景：被删除的内容
│ 80-89：12人                  │
└──────────────────────────────┘

┌─ 修改后 ─────────────────────┐
│ 期中考试成绩统计表终稿.docx   │  ← 绿色背景：新增/修改的内容
│                              │
│ 成绩分布：                    │
│ 90以上：8人（+3）            │
│ 80-89：15人（+3）            │
│ 新增柱状图展示各分数段变化    │
└──────────────────────────────┘
```

前端实现：并排或上下对照显示，红绿高亮变更行（类似 GitHub PR File Changed 界面 + 文件差异对比）。

不展示 Git unified diff（`@@ -1,5 +1,5 @@` 之类的对一般用户不可读）。
```

### 2.6 鉴权链路全景

```
                        FirstEntrancePlatform
                        (OAuth/OIDC Provider)
                               ▲
                               │ ① 浏览器：用户登录
                               │ ② Desktop 收到授权码
                               │ ③ POST /token → JWT (RS256)
                               │ ④ 用 JWT 连 FeClaw WS
                               │
                       ┌───────┴────────┐
                       │ FeClaw-Desktop │
                       └───────┬────────┘
                               │ wss://... + Bearer JWT (header)
                               ▼
                        FeClaw Engine
                        decode_jwt_token → 取 user_id
                        → 校验 user_id 拥有 agent_hash → accept
                               │
                               ▼
                        Desktop 连接建立
                        → 所有 chat_message / file_* / command_exec 走这条 WS
```

**Desktop 不需要单独处理 Platform 协议**——`/.well-known/feclaw-desktop` 已经把 `auth.endpoint`（Platform 的 `/api/auth/login`）告诉 Desktop，Desktop 用它去 Platform 拿 JWT，**剩下的就是连 Engine 的 WS**。

---

### 2.7 消息渠道模型与 Session Memory 隔离

群聊不是一个独立的 Entity，而是**一个新的消息渠道**，与现有渠道同级。

#### 消息渠道架构

```
消息渠道 (MessageChannel)
├── web        — Web 聊天界面
├── wechat     — 微信通道
├── im    — IM 私聊（Desktop + Mobile 共享）
├── im_group:<id> — IM 群聊（Desktop + Mobile 共享）
└── (未来) mobile — 移动端 APP
```

#### Session Memory 存储策略

每个渠道写入**独立的 Session Memory .md 文件**，存放于 Agent 工作区内：

```
agents/{hash}/workspace/
├── memory/
│   ├── session_web.md        ← Web 消息的记忆
│   ├── session_wechat.md     ← 微信消息的记忆
│   ├── session_im.md           ← IM 私聊（Desktop + Mobile 共享）
│   └── session_im_group_xxx.md ← IM 群聊（Desktop + Mobile 共享）
```

**当前策略（默认）：** 渠道间上下文隔离。LLM 调用时只拼接当前渠道的 Session Memory。

**允许跨渠道读取（不拦截）：** 由于同一个 Agent 服务于所有渠道，Agent 完全可以通过文件读取工具查看其他渠道的 Session Memory。例如 Agent 发现工作区多了个文件，可以查看其他渠道的 Memory 来确认来源和用途。**系统不做拦截**——这是同一 Agent 的合理行为。

**未来实验功能：** 跨渠道上下文主动拼接。用户说"接着群里的讨论"→ 系统在单聊消息后面拼接群聊最近 N 条消息，标注 `[渠道:群聊]`。不稳定，可测试效果。

#### 与群聊 Phase 4 的关系

群聊 Engine 侧的 `GroupMessage` 模型已包含 `sender_type` 和 `sender_hash`。关键改动在 ChatService：每条消息必须携带 `channel` 字段。

```python
# ChatService._build_messages() 中
# 按 channel 隔离：
context = session.get_history(channel=channel)
```

#### 权限与隔离

群设置中 `context_isolation: bool = True`（默认隔离）。设为 False 启用实验性共享。

在 Desktop 聊天窗口右侧小侧栏中切换。每级权限作用于**单个 Agent**。

| 等级 | 模式 | 操作限制 | 适用场景 |
|:----:|------|----------|----------|
| 🚫 L0 | **禁止** | 纯聊天，无工具调用 | 公开演示 Agent |
| 🟡 L1 | **严格** | 任何读写执行均需点审批 | 不确定信任的 Agent |
| 🟢 L2 | **平衡** ⭐ | 选定工作目录内放行（除删除）；该目录后台版本控制可回滚；其他操作须询问 | **默认推荐** |
| 🔵 L3 | **宽松** | 平衡 + 任意位置可读取 | 高度信任的 Agent |
| 🔴 L4 | **完全授权** | 放行所有操作，30min 超时自动过期 | 临时密集操作 |

**最后一道防线（不可关闭）：**
- 每条 `subprocess` 命令执行前经独立 LLM 审计
- 极高风险操作（`rm -rf`、Python 代码实现等价删除等）弹出红色警示框，明确说明潜在影响
- 用户可选择拦截或放行此单次操作

**存储：** `~/.feclaw/permissions/{agent_hash}.json`
```json
{
  "agent_hash": "a1b2c3",
  "mode": "balanced",
  "trusted_directory": "C:/Users/lizidaren/Documents/feclaw-work",
  "version_control": true,
  "full_access_expires": null
}
```

### 2.8 Agent 消息类型（7 种）

Agent 可向聊天窗口推送多种消息类型，由 Engine 侧 chat_service 根据响应内容判断：

```json
{
  "type": "chat_message",
  "agent_hash": "a1b2c3",
  "message_type": "text" | "image" | "file" | "consent_card" | "moments_post" | "mini_program" | "question_box",
  "payload": { ... }
}
```

| 消息类型 | `message_type` | Desktop 渲染方式 | 引擎触发条件 |
|----------|---------------|-----------------|--------------|
| 文本 | `text` | 流式输出 | 标准聊天回复/文字 | 自带 |
| 图片 | `image` | 图片卡片 | Agent 生成/处理的图片 | 自带的 Base64/URL |
| 文件 | `file` | 文件卡片（可下载） | Agent 在云端编辑完成 → 发回 | 复用 file_bridge |
| 权限询问 | `consent_card` | 卡片 +「允许/拒绝」按钮 | Agent 请求访问文件/执行命令 | 复用 consent.rs |
| 群广场动态 | `moments_post` | 摘要卡片 +「去广场看」| Agent 群广场发布内容的通知 | Phase 5 |
| 小程序入口 | `mini_program` | App 图标 + 名称 | Agent 推荐打开某个小程序 | Phase 6 |
| 问题框 | `question_box` | ABCD 选项 / 输入框 | Agent 需要用户选择指导下一步 | 独立的 question_box 卡片 |

---

### 2.9 Desktop SQLite 数据结构

Desktop 使用 `~/.feclaw/feclaw.db` 管理本地数据。Rust 侧用 `rusqlite` 访问。

#### IM 聊天缓存

```sql
CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,          -- UUID
    channel TEXT NOT NULL,        -- "im" | "im_group:<id>"
    agent_hash TEXT,              -- NULL 表示用户自己发的
    role TEXT NOT NULL,           -- "user" | "assistant" | "system"
    content TEXT NOT NULL,
    message_type TEXT DEFAULT 'text',
    -- 以上字段与 Engine GroupMessage 一致
    
    -- Desktop 本地字段:
    created_at INTEGER NOT NULL,  -- Unix timestamp ms
    synced INTEGER DEFAULT 0,    -- 0=还没同步给Engine, 1=已同步
    is_deleted INTEGER DEFAULT 0  -- 软删除（用户撤回消息）
);

CREATE INDEX idx_chat_messages_channel ON chat_messages(channel, created_at);

-- 同步状态
CREATE TABLE sync_state (
    channel TEXT PRIMARY KEY,
    last_synced_at INTEGER NOT NULL,  -- 最后同步的时间戳
    last_message_id TEXT              -- 最后同步的消息ID
);
```

#### 群聊缓存

```sql
CREATE TABLE group_messages (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    sender_type TEXT NOT NULL,
    sender_hash TEXT,
    content TEXT NOT NULL,
    message_type TEXT DEFAULT 'text',
    created_at INTEGER NOT NULL,
    synced INTEGER DEFAULT 1  -- 群聊由 Engine 主导，Desktop 只消费
);

CREATE INDEX idx_group_messages_group ON group_messages(group_id, created_at);
```

#### 权限配置

```sql
CREATE TABLE permission_configs (
    agent_hash TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'balanced',      -- disabled|strict|balanced|relaxed|full
    trusted_directory TEXT,
    version_control INTEGER DEFAULT 0,
    full_access_expires INTEGER,               -- Unix timestamp or NULL
    updated_at INTEGER NOT NULL
);
```

#### 快捷模板

```sql
CREATE TABLE prompt_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    icon TEXT DEFAULT '😄',
    sort_order INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);
```

#### 安全日志

```sql
CREATE TABLE security_logs (
    id TEXT PRIMARY KEY,
    agent_hash TEXT NOT NULL,
    path TEXT NOT NULL,
    operation TEXT NOT NULL,  -- "read" | "write" | "overwrite" | "replace" | "delete"
    intent TEXT,              -- Agent 提供的描述
    match_string TEXT,        -- 替换写时的匹配串
    permission_mode TEXT NOT NULL,
    approved INTEGER NOT NULL, -- 0=拒绝 1=批准 2=待审批
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_security_logs_agent ON security_logs(agent_hash, created_at);
```

#### 设置

```sql
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- 预置: theme (light|dark|system), window_x/y/w/h, last_active_chat, ...
```

---

## 3. V3 阶段路线图

> **本节是 roadmap，不重复实现细节。** 每个阶段标注：
> - 主要交付物
> - 涉及的关键文件
> - 引擎侧是否需要改
> - 估计工时（人日）
### Phase 0a — 登录/欢迎页 + 三栏 UI 骨架 + SQLite + 草稿 ✅ 第一步

**目标：** 登录入口 → 加载权限 → 显示三栏 IM UI → 旧聊天记录可看 → 切换聊天保留草稿。

#### 欢迎页 / 登录（替换现有三卡片）

```
首次启动 / 未登录时显示：

┌──────────────────────────────────┐
│                                  │
│           FeClaw                  │
│     你的 AI 即时通讯              │
│                                  │
│  ┌────────────────────────────┐  │
│  │ 邮箱 / 用户名              │  │
│  └────────────────────────────┘  │
│  ┌────────────────────────────┐  │
│  │ 密码                       │  │
│  └────────────────────────────┘  │
│                                  │
│  [    登  录    ]                │
│                                  │
│  没有账号？注册                   │
│  ────── 或 ──────                │
│  自建服务 · 本地运行             │ ← 小字链接
└──────────────────────────────────┘

状态影响：
- 登录成功 → JWT 存本地 → GET /api/user/permissions → 进入三栏 IM UI
- 点击"自建服务" → 弹窗输入 server_url + login_url → 同上流程
- 点击"本地运行" → 进入本地模式引导（V2 已有）
```

#### 启动流程

```
Desktop 启动
  ├── ~/.feclaw/cloud-token 存在？
  │   ├── 是 → 验证 JWT → GET /api/user/permissions → 进入三栏 UI
  │   └── 否 → 显示登录界面
  │
  ├── 登录成功后
  │   ├── 存储 JWT
  │   ├── GET /api/user/permissions → 缓存到 store.permissions
  │   ├── GET /api/desktop/agents → 填充聊天列表
  │   ├── SQLite 初始化 feclaw.db
  │   └── 导入旧 chat_history.json（如果有）
  │
  └── 进入三栏 UI
```

#### 三栏布局

```
┌──────┬──────────────┬─────────────────────────────┐
│ Tab  │   聊天列表    │         聊天窗口              │
│ (左) │    (中)      │          (右)                │
│      │              │                             │
│ 💬   │ 按最后活跃   │ 流式输出 + 富文本输入框        │
│ 聊天 │ 时间排序      │  [消息草稿自动保留]           │
│      │ 群/单聊混排   │                             │
│ 🙋   │ 头像/备注/    │                             │
│ 我的 │ 最新消息/红点  │                             │
│      │ 订阅/权限状态  │                             │
└──────┴──────────────┴─────────────────────────────┘
```

#### 关键交付

| 交付 | 文件 | 说明 |
|------|------|------|
| 欢迎页 HTML（登录表单） | `src-tauri/src/welcome/index.html` | **重写**现有三卡片页 |
| 登录流程 TS | `src-tauri/src/welcome/welcome.ts` | 登录/自建/本地 三路由 |
| 三栏 HTML 骨架 | `src-tauri/src/chat/index.html` | **重写**现有单栏 |
| 状态管理 | `src-tauri/src/chat/store.ts` | 当前Tab/聊天/消息/permissions |
| SQLite 初始化 | `src-tauri/src/db.rs`（新建）| 建 6 张表 |
| V2 历史导入 | `src-tauri/src/db.rs` | 检测 → 导入 → 标记已处理 |
| 消息草稿 | `src-tauri/src/store.ts` + `db.rs` | 存 `settings:draft:<channel>` |
| 图片存 VFS 只读 | `src-tauri/src/chat/chat.ts` | 写入 Agent VFS images/ |
| 登录命令 | `src-tauri/src/auth.rs` | 复用 `cloud_login` |
| 权限命令 | `src-tauri/src/welcome.rs` / `chat.rs` | `get_permissions` → 缓存 |
| Agent 列表命令 | `src-tauri/src/chat.rs` | `list_agents` |
| SQLite 命令 | `src-tauri/src/db.rs` | `init_db` / `import_chat_history` / `save_draft` / `load_draft` |
| Engine 端 | `FeClaw/routers/` | `GET /api/user/permissions`（新建）+ `GET /api/desktop/agents`（新建）|

#### Tauri 命令清单

```rust
// auth.rs - 已有
#[tauri::command] async fn cloud_login(url, login_url, username, password) → Result<CloudSession>

// db.rs - 新建
#[tauri::command] fn init_db() → Result<()>
#[tauri::command] fn check_legacy_chat_history() → Result<bool>
#[tauri::command] fn import_chat_history() → Result<u64> // 返回导入条数
#[tauri::command] fn save_draft(channel: String, content: String) → Result<()>
#[tauri::command] fn load_draft(channel: String) → Result<Option<String>>

// welcome.rs - 已有 + 扩展
#[tauri::command] async fn get_permissions() → Result<UserPermissions>

// chat.rs - 已有 + 扩展
#[tauri::command] async fn list_agents() → Result<Vec<AgentInfo>>
#[tauri::command] async fn get_chat_history(agent_hash: String) → Result<Vec<ChatMessage>>
```

#### 完成条件

```
1. 启动 → 显示登录表单
2. 登录成功 → 进入三栏 IM UI
3. 中栏显示 Agent 列表（从 Engine 获取）
4. 点击 Agent → 右栏加载聊天记录（从 SQLite / Engine）
5. 输入框打字 → 切换到其他聊天 → 切回来 → 内容保留
6. 粘贴图片 → 存 VFS images/ → 在聊天中显示
7. V2 遗留 chat_history.json → 启动时自动导入
8. permissions API 已调用并缓存
```

**工时：** 4 天（+1 天用于欢迎页重写）

---

### Phase 0b — 创建流程 + 文件引用卡片 ✅ 第二步

**目标：** 在聊了，能建 Agent 了，能引用文件了。

**关键交付：**
- `src-tauri/src/create.rs`（新建）：`create_agent` / `create_group_placeholder`
  - 创建 Agent 时选类型（classic/im）→ 引擎 `POST /api/desktop/agents`
- 文件引用交互：点击 📎 → 选「本地文件」或「云文件」
  - 本地 → 选「引用（可读写）」或「发送（只读副本）」→ 文件选择框 → 卡片嵌入输入框
  - 云 → VFS 浏览器 → 选中文件 → 卡片嵌入输入框
  - 卡片支持删除、可在卡片后继续打字
- `src-tauri/src/chat/components/create-dialog.ts`
- `src-tauri/src/chat/components/input-box.ts`

**完成条件：** 能创建 Agent + 文件以卡片嵌入输入框

**工时：** 2 天

---

### Phase 0c — 小侧栏 + API 对接 ✅ 第三步

**目标：** 三 dot 菜单能展开小侧栏，所有 API 走通。

**关键交付：**
- `src-tauri/src/side_panel.rs`（新建）：info 查询、alias 修改、pin/dnd toggle
- `src-tauri/src/chat/components/side-panel.ts`
- 侧栏展示：头像、备注、置顶、免打扰、权限模式选择
- 引擎对接：`GET /api/desktop/agents/{hash}` 获取 Agent 信息
- 新增命令：`get_agent_panel_info` / `update_agent_alias` / `toggle_pin` / `toggle_dnd`

**完成条件：** 小侧栏可展示和操作

**工时：** 2 天

---

### Phase 1 — 截图粘贴 + 快捷模板（IM 模式起步）

**目标：** 富文本输入框（contenteditable + Ctrl+V 粘贴截图），底部快捷模板按钮栏。

**关键交付：**
- 粘贴处理：`paste` 事件 → 检测 `image/*` MIME → `invoke('save_temp_image', { base64 })` → 插入缩略图到输入框 → 加入待发送附件列表
- 模板栏：内置 6 个（总结 / 翻译 / 检查语法 / 改写 / 解释代码 / 优化代码）+ 自定义 CRUD
- 新增命令：`save_temp_image` / `get_prompt_templates` / `save_prompt_templates`


**工时：** 2–3 天

---

### Phase 2 — 三 dot 菜单 + VFS 文件管理器 + 小侧栏

**目标：** 聊天窗口右上角 `⋮` → 右侧展开小侧栏，包含完整的 Agent 管理功能。

**小侧栏完整内容：**
```
┌── Agent 设置 ──────────────────────┐
│                                     │
│  [头像]                              │
│  备注名（显示名，可编辑）             │
│                                     │
│  📌 置顶聊天       [开/关]          │
│  🔕 免打扰         [开/关]          │
│                                     │
│  📂 VFS 文件编辑器                   │
│  ├── 浏览目录结构                    │
│  ├── 编辑非二进制文件                 │
│  ├── 上传/下载                       │
│  └── 新建文件夹                      │
│                                     │
│  ⚙️ 配置管理                         │
│  └── 同网页版 {hash}.feclaw/         │
│      lizidaren.cn/settings           │
│                                     │
│  🛡️ 权限模式                         │
│  └── 当前：平衡 (L2) ▼              │
│                                     │
│  🏪 小程序列表                       │
│  └── 3 个可用 App                    │
│                                     │
│  📱 群广场设置（仅群聊）             │
│  └── [开/关]                         │
└─────────────────────────────────────┘
```

**关键交付：**
- `src-tauri/src/file_manager.rs` + `src-tauri/src/file_manager/index.html`（VFS 编辑器）
- `src-tauri/src/side_panel.rs`（新建）— 小侧栏状态管理 + Agent 属性变更命令
  - `get_agent_panel_info(agent_hash)` — 获取所有侧栏展示数据
  - `update_agent_alias(agent_hash, alias)` — 修改备注名
  - `toggle_agent_pin(agent_hash)` — 置顶
  - `toggle_agent_dnd(agent_hash)` — 免打扰
  - `get_agent_permission_mode(agent_hash)` / `set_agent_permission_mode(agent_hash, mode)`
  - `update_agent_config(agent_hash, config)` — 引擎配置代理
- 引擎端：`GET /api/desktop/agents/{hash}/vfs`、`GET /api/desktop/agents/{hash}/apps`、`GET /api/desktop/agents/{hash}/config`
- 复用 `virtual_filesystem.py` 已有逻辑

**工时：** 5–6 天

---

### Phase 3 — Windows 右键菜单（📎 引用 / 📤 发送）

**目标：** 资源管理器右键 → 「FeClaw 引用」/「FeClaw 发送」→ Desktop 收到文件路径 → 加入当前聊天待发送列表。

**关键交付：**
- `src-tauri/src/right_click.rs` 注册表操作（HKCU）
- `main.rs` 解析 `--right-click reference/send <path>` 参数
- 设置中加开关（默认关，让用户显式启用）
- 安全：复用 `file_bridge::resolve_desktop_path` 的路径遍历防护

**依赖：** `winreg = "0.52"`


**工时：** 3–4 天

---

### Phase 4 — 群聊引擎侧（核心改动：群上云）

**目标：** Engine 侧新增 Group 模型层 + API + WS 端点。群数据由服务器管理，Desktop 是消费方。

**引擎侧新增文件：**
- `models/group.py` — Group + GroupMember + GroupMoments 模型
- `services/group_service.py` — 群聊核心逻辑（创建/路由/上下文管理）
- `routers/group.py` — REST API + WS 端点

**引擎侧 API 端点：**
```
POST   /api/groups/create               — 创建群
POST   /api/groups/{id}/send            — 发送群消息（用户触发）
POST   /api/groups/{id}/join            — 拉 Agent 入群
POST   /api/groups/{id}/leave           — 踢出 Agent
PATCH  /api/groups/{id}/settings        — 更新群设置（改名/公告/权限/广场开关）
DELETE /api/groups/{id}                 — 解散群
GET    /api/groups/{id}/messages        — 获取历史消息
GET    /api/desktop/groups              — Desktop 列出用户所有群
WS     /ws/desktop/groups/{group_id}    — 群消息实时推送
```

**典型消息路由（备课场景）：**
```
用户"我想学三角函数" → POST /api/groups/{id}/send
  → group_service.send_message() 分发消息给群内每个 Agent
    → 并行调用 3 次 chat_service.chat()（各 Agent 独立思考）
      Agent A (老师): 生成教案 + 知识点拆解
      Agent B (好学生): 提挑战性问题
      Agent C (学困生): 指出易错点
  → 聚合结果 → WS 推送给 Desktop
  → Desktop 按时间线渲染群聊窗口
```

**引擎侧数据 model：**
```python
class Group(Base):
    id: str (UUID)
    name: str
    announcement: str (群公告)
    announcement_updated_at: datetime
    owner_user_id: int
    settings: JSON (allow_agent_edit_name, allow_agent_edit_announce, 
                    moments_enabled, unified_permission_mode)
    # unified_permission_mode: str — 群统一权限级别 ("disabled"|"strict"|"balanced"|"relaxed"|"full")
    # 设置为 non-null 时覆盖群内各 Agent 的独立权限配置
    context_isolation: bool = True
    created_at / updated_at

class GroupMember(Base):
    group_id: str → Group.id
    agent_hash: str → AgentProfile.hash
    role: str ("owner" | "member")

class GroupMessage(Base):
    id: str (UUID)
    group_id: str → Group.id
    sender_type: str ("user" | "agent")
    sender_hash: str (agent_hash 或 None)
    content: str
    message_type: str ("text" | "image" | "file" | "consent_card" | "question_box")
    mentions: list[str] (@提及的 agent_hash 列表)
    created_at
```

**上下文隔离：** group_service 在构建每条消息的上下文时，只注入该群的历史消息，不混入单聊记录。

**Desktop 侧改动：**
- `src-tauri/src/group.rs` — HTTP 客户端调用 Engine Group API（不是本地数据管理）
- `ws.rs` 扩展 — 接收群聊 WS 消息类型 `group_message` / `group_event`
- 前端渲染 — 群聊窗口独立 Tab，消息按 sender 分色显示

**工时：** 引擎 4–5 天 + Desktop 2–3 天

---

### Phase 5 — 群广场（Engine 侧事件管理）

**目标：** 群广场跟随群上云。Agent 完成任务 → 写入 `GroupMoments` 表 → WS 推送给 Desktop。

**引擎侧新增：**
- `models/group.py` 中 GroupMoments 表（或独立文件）
```python
class GroupMoments(Base):
    id: str (UUID)
    group_id: str → Group.id
    agent_hash: str
    kind: str ("task_done" | "file_changed" | "analysis" | "manual")
    title: str
    content: str
    data: JSON (附加链接/详情)
    created_at: datetime
```
- `services/group_service.py` 中 `post_moment(group_id, agent_hash, kind, title, content, data)` 方法
- `services/agent_tools_service.py` 增加 `_check_post_moment()` 钩子
  - Agent 完成写文件 → 自动发一条 `file_changed` 类型动态
  - Agent 完成分析/批改 → 自动发 `analysis` 类型动态
  - 涉及隐私操作 → 不自动发（默认禁止）
- WS 推送：`/ws/desktop/groups/{group_id}` 接收 `moments_event` 类型

**Desktop 侧改动：**
- `src-tauri/src/moments.rs` — 3 个命令（均调 Engine API）
  - `get_group_moments(group_id)` → GET /api/groups/{id}/moments
  - `post_moment(group_id, title, content)` → POST 手动发布
  - `set_moments_enabled(group_id, enabled)` → PATCH settings
- 本地缓存：`~/.feclaw/groups/{group_id}_moments.json`（离线浏览）
- 前端：聊天窗口顶部 Tab「💬 聊天」/「📱 群广场」切换

**工时：** 引擎 3–4 天 + Desktop 2 天

---

### Phase 6 — 小程序入口

**目标：** Agent 三 dot → 「🏪 小程序」→ iframe 嵌入引擎的 `apps_service.py` 已注册的 App。

**关键交付：**
- `src-tauri/src/mini_program.rs`：`MiniProgramEntry` 结构 + 2 个命令
  - `list_mini_programs(agent_hash)` / `open_mini_program(agent_hash, app_id)`
- 前端：Tauri WebviewWindow 加载引擎的小程序 URL
  - 云模式：`https://{hash}.feclaw.lizidaren.cn/apps/{app_id}/`
  - 本地模式：`http://127.0.0.1:{port}/apps/{app_id}/`
- 引擎端：`GET /api/desktop/agents/{hash}/apps`（列 App 元信息）

**引擎侧：** **零改动**——完全复用 `apps_service.py`


**工时：** 2–3 天

---

### Phase 7 — ⌘K 搜一搜

**目标：** 全平台向量语义搜索：Agent 内聊天记录 + VFS 文件 + 群广场动态 +（可选）本地文件全盘。

**关键交付：**
- `src-tauri/src/search.rs`：`SearchResult` / `SearchSourceKind` + 聚合命令
- `src-tauri/src/ws.rs`：发送 `search_request` / 接收 `search_response`
- 引擎侧：`vector_search_service.py` 扩展支持跨 Agent 搜索
- 前端：`#tab-search` Tab，⌘K / Ctrl+K 聚焦搜索框，结果可点击跳转到对应 Agent 聊天 / 群聊 / 文件管理器


**工时：** 4–5 天

---

### Phase 8 — 扫码拍照上传（COS 预签名 URL 方案）

**目标：** 文件传输助手——聊天窗口底部 `📱` 按钮 → 二维码 → 手机扫码 → 拍照/选图 → 上传到 Desktop → 嵌入聊天输入框。

**技术方案（Vision v3.1 指定）：**
```
用户点 📱
  → Desktop 请求 Engine POST /api/desktop/upload_session → 返回 COS 预签名 PUT URL + 临时 token
  → Desktop 生成二维码（含 URL + token）
  → 手机扫码 → 打开上传网页 → 拍照/选相册照片
  → POST 到 COS 预签名 URL（直传，不走公网服务器带宽）
  → Engine 收到 COS 通知（或 Webhook） → WS 通知 Desktop
  → Desktop 通过预签名 URL 下载临时文件 → 嵌入聊天输入框作为图片卡片
  → Engine 10min 后清理临时文件
```

**无需本地 HTTP server。** 即使在本地模式下，也可通过 FeClaw 引擎的 COS 配置签发预签名 URL。极端无 COS 场景回退本地 HTTP。

**关键交付：**
- `src-tauri/src/qr_upload.rs`：QR 生成 + 上传会话管理
- `src-tauri/src/qr_upload/index.html`：二维码弹窗
- 引擎侧：`POST /api/desktop/upload_session` → 返回 COS presigned PUT URL + 临时 token
- 引擎侧：`POST /api/desktop/upload_cleanup` → 10min 后清理

**依赖：** `qrcode = "0.14"` / `image = "0.25"`

**工时：** 3–4 天

---

### Phase 9 — 本地 MCP 接入

**目标：** Desktop 启动本地 MCP Server（stdio JSON-RPC）→ 注册其 tools 到 Agent → Agent 可通过 Desktop 中继调用本地工具（sqlite_query / filesystem 等）。

**关键交付：**
- `src-tauri/src/mcp.rs`：`McpServerConfig` / `McpManager`（stdin/stdout JSON-RPC 通信）
- 新增命令：`list_mcp_servers` / `start_mcp_server` / `stop_mcp_server`
- 设置页加「MCP」Tab：CRUD Server 配置
- 引擎侧：`services/desktop_relay.py::request_mcp_tool()` + `routers/desktop_ws.py` 新增 `mcp_tool_request/response` 处理
- 安全：每次 MCP 工具调用弹窗确认（复用 `consent.rs::request_operation`，按 MCP tool name 映射风险等级）

**引擎侧改动：**
- `services/agent_tools_service.py` 增加 `mcp_*` 工具前缀
- `routers/desktop_ws.py` 新增消息类型分发


**工时：** 8–10 天

---

### Phase 10 — 本地文件全盘索引

**目标：** 后台低优先级扫描用户指定目录 → 解析 PDF/DOCX/TXT/MD/代码 → 向量化 → 写入本地向量库 → 让 ⌘K 能搜到全盘内容。

**关键交付：**
- `src-tauri/src/file_index.rs` + 子模块（walker / parser / embedder / store）
- 托盘菜单加「索引: 1234 文件」状态显示
- 设置页加「索引」Tab：选择要索引的目录、查看索引状态、删除索引
- 嵌入模型：优先调用 FeClaw 引擎 `/api/embed`（若存在），否则 ONNX 本地跑 MiniLM

**依赖：** `walkdir = "2"` / `lopdf = "0.32"` / `docx-rs = "0.4"` / `usearch = "2"` 或 `lancedb` / `ort = "2"`


**工时：** 10–14 天

---

### Phase 11 — Agent IM 模式后台支持

**目标：** 支持 IM 类型 Agent 的后台能力（Agent 类型已在 Phase 0 创建时选定）。

**前置说明：** Agent 类型（经典/IM）在**创建时选定**（Phase 0 加号菜单）。**IM 模式不限制任何工具**，只改变行为风格。

**IM 模式定义：**
| 维度 | IM 模式行为 |
|------|------------|
| 回复长度 | 短句（1-3 句），不输出长段落 |
| 长任务 | 启动 SubAgent 后台执行，前台立即回复"正在处理…" |
| 工具集 | **全部可用，无限制** |
| 打断能力 | 用户可随时发新消息中断当前 SubAgent 任务 |
| Typing 指示器 | SubAgent 运行时显示"正在处理…" |

**引擎侧改动：**
- `models/database.py::AgentProfile` 新增字段：`agent_type: str = "classic"`（"classic" | "im"）
- `services/chat_service.py` 根据 `agent_type` 选择不同 system prompt
  - classic: 详尽回复，可长可短
  - im: 短句优先，用 SubAgent 跑长任务，可打断
- `services/agent_init_service.py` 读 `agent_type` 字段注入 prompt

**Desktop 侧改动：**
- 消息气泡加「typing…」指示器
- IM 模式的 Agent 列表显示「在线」「处理中…」状态
- 群聊约束：群内无视 Agent 类型，统一按群聊 session behavior

**工时：** 引擎 2 天 + Desktop 1 天

---

### Phase 12 — 多模态操控 PC（远期探索）

**目标：** Agent 可请求 Desktop 截图 → 多模态 LLM 分析 → 请求鼠标/键盘操作。

**不实施，仅预留架构：**
- 新增 WS 消息类型：`screen_capture_request/response` / `input_action_request/response`
- 三级权限：旁观（仅截图）/ 指点（截图 + 标位置）/ 操控（截图 + 输入）
- 安全：必须用户全程允许（任何操作前弹窗）


**工时：** 不计入

---

## 4. 引擎侧改动清单（汇总）

按 V3 阶段汇总 FeClaw 引擎侧需配合的改动：

| 阶段 | 引擎侧改动 | 文件 |
|:----:|-----------|------|
| 0 | 新增 `GET /api/desktop/agents` | `main.py` |
| 2 | 新增 `GET /api/desktop/agents/{hash}/vfs`、`/apps`、`/config` | `main.py` + `virtual_filesystem.py` + `apps_service.py` |
| 4 | **大改：** 新增 Group/GroupMember/GroupMessage 模型、`routers/group.py`、`services/group_service.py`、WS `/ws/desktop/groups/{id}` | 新建 3+ 文件 |
| 5 | 新增 GroupMoments 模型 + `group_service.post_moment()` + agent_tools 钩子 + WS 推送 `moments_event` | `group_service.py` + `agent_tools_service.py` |
| 6 | 新增 `GET /api/desktop/agents/{hash}/apps` | `main.py` + `apps_service.py` |
| 7 | 新增 `search_request` / `search_response` 处理 + `vector_search_service.py` 扩展 | `routers/desktop_ws.py` + `vector_search_service.py` |
| 8 | 新增 `POST /api/desktop/upload_session`（COS 预签名） | `main.py` + COS SDK |
| 9 | 新增 `mcp_tool_request/response` 处理 + `request_mcp_tool()` | `routers/desktop_ws.py` + `desktop_relay.py` + `agent_tools_service.py` |
| 10 | 暴露 `POST /api/embed`（给 Desktop 调用） | `embedding_service.py` + `main.py` |
| 11 | `AgentProfile.agent_type` 字段 + `ChatService` 读字段选 prompt | `models/database.py` + `chat_service.py` |

**关键点：** Phase 4–5 是引擎侧最大的改动（群上云 + 群广场），其他阶段 Engine 改动相对独立。

---

## 5. 鉴权链路（OAuth + JWT + Platform）

**完整链路（云模式）：**

```
┌──────────────────┐                                    ┌──────────────────────┐
│ FeClaw-Desktop   │                                    │ FirstEntrancePlatform│
│ (Tauri)          │                                    │ (OAuth/OIDC Provider)│
└────────┬─────────┘                                    └──────────┬───────────┘
         │                                                        │
         │  ① 用户输入 Platform URL（设置 → 云端 Tab）              │
         │  ② 探测 GET /.well-known/feclaw-desktop                │
         │     ← { auth: { type: "platform",                      │
         │               endpoint: "https://platform/.../login" }}│
         │                                                        │
         │  ③ 浏览器打开 Platform OAuth flow                       │
         │     GET /authorize?response_type=code&client_id=...    │
         │                                                        │
         │  ④ 用户在 Platform 登录                                 │
         │     ← 302 redirect with ?code=xxx                      │
         │                                                        │
         │  ⑤ POST /token { grant_type: authorization_code,        │
         │                    code, client_id, client_secret }    │
         │     ← { access_token: JWT, expires_in: 3600 }          │
         │                                                        │
         │  ⑥ 保存 JWT 到 ~/.feclaw/cloud-token                    │
         │                                                        │
         │  ⑦ wss://feclaw.lizidaren.cn/ws/desktop/{hash}         │
         │     Header: Authorization: Bearer <JWT>                │
         ▼                                                        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ FeClaw Engine                                                            │
│                                                                         │
│  ⑧ decode_jwt_token(token) → 验签 (RS256 via JWKS) → 取 user_id          │
│  ⑨ _user_owns_agent(user_id, agent_hash) → 校验 DB                        │
│  ⑩ 通过 → accept WS → 后续 chat_message/file_*/command_exec 正常处理     │
└──────────────────────────────────────────────────────────────────────────┘
```

**关键文件：**
- Platform：`/home/lch/Projects/FirstEntrancePlatform/`
  - `routers/oauth.py` — `/authorize` `/token` `/userinfo`
  - `routers/wellknown.py` — `/.well-known/openid-configuration`、`/.well-known/jwks.json`
  - `services/jwt_service.py` — RS256 签发
  - `services/jwk_service.py` — JWKS 暴露
- Engine：`/home/lch/Projects/FeClaw/`
  - `routers/well_known.py` — `/.well-known/feclaw-desktop`（auth.endpoint 指 Platform）
  - `routers/desktop_ws.py` — `WS /ws/desktop/{hash}` + `decode_jwt_token` 验签
  - `services/agent_jwt_service.py` — JWT 工具
  - `utils/auth.py::decode_jwt_token` — 引擎本地 JWT 验签（可独立，不一定调 Platform JWKS）
- Desktop：`/home/lch/Projects/FeClaw-Desktop/`
  - `settings.rs::cloud_login` — 走 Platform OAuth flow 拿 JWT
  - `engine.rs::start_cloud` — 用 JWT 连 Engine WS
  - `config.rs::ws_url()` — 根据 `Mode::Cloud` 拼 `wss://...` URL

**设计决策：** Engine 端**不直接连 Platform JWKS**——Desktop 拿 JWT 时已验签，Engine 只验签本地签发的内部 JWT。这样 Engine 与 Platform 完全解耦，Platform 可以独立升级签名算法。

---

## 6. V2 → V3 衔接策略

**V2 收尾（必须先完成）：**

1. 阶段 0：补 `FileWriteResponse` 类型 + ws.rs 改造 + consent.rs `request_operation` + engine.rs `auth_failure` 监听
2. 阶段 1：设置界面 camelCase 验证（`loginUrl` 等参数全部走 TS invoke 检查）
3. 阶段 2：ws.rs handler 接入 file_bridge + 引擎 `/mnt/desktop/` 映射 + JWT header 鉴权
4. 阶段 3：`auto-launch` 接入 + `--minimized` 参数
5. 阶段 4：`.well-known/feclaw-desktop` 已就绪，补 `cloud_login` / `cloud_disconnect` 命令 + JWT 头鉴权

**进入 V3 的准入：**
- [ ] V2 五阶段全部 ✅
- [ ] 云模式 + 本地模式都能跑通 chat_reply + file_read/write + command_exec
- [ ] JWT 头鉴权 + 4xxx close code + `ShowCloudLogin` UI 引导全部生效
- [ ] `chats/{agent_hash}.json` 数据迁移脚本可执行（V3 Phase 0 用）

**V3 阶段间依赖：**

```
Phase 0 (三栏 + 私聊)
    │
    ├── Phase 1 (截图 + 模板) ── 可与 Phase 0 并行
    │
    ├── Phase 2 (VFS 文件管理器) ── 依赖 Phase 0
    │
    └── Phase 4 (群聊) ── 依赖 Phase 0
            │
            └── Phase 5 (群广场) ── 依赖 Phase 4
                    │
                    ├── Phase 6 (小程序) ── 独立
                    │
                    ├── Phase 7 (搜索) ── 可与 Phase 5 并行
                    │
                    ├── Phase 8 (扫码上传) ── 独立
                    │
                    └── Phase 9 (MCP) ── 依赖 Phase 0

Phase 10 (全盘索引) ── 依赖 Phase 7
Phase 11 (IM 模式) ── 独立
```

**并行建议：**
- Phase 0 完成前：团队可先并行做 Phase 1（截图/模板）和 Phase 11（IM 模式）——这两块对前端依赖较弱
- Phase 4 完成后：Phase 5、6、7、8 可并行推进（不同模块不同 owner）

---

## 7. 风险与缓解

| 风险 | 等级 | 缓解 |
|------|:----:|------|
| **chat.rs 重写冲击 V2 改动** | 🔴 高 | V3 Phase 0 启动前必须 V2 全部合并；chat.rs 的 `agent_hash` 路由要一次到位 |
| **群聊 chat_message 协议扩展破坏老 Engine** | 🟡 中 | `group_id` 字段为可选（`#[serde(default)]`），老 Engine 不解析也兼容 |
| **群广场事件风暴** — Agent 频繁操作产生大量 moments | 🟡 中 | Desktop 端按 group_id 去重 + 按时间窗口聚合（默认 5 分钟）；用户可关闭群广场 |
| **扫码上传 COS 预签名 URL 泄露** | 🟡 中 | URL 含 5 分钟过期时间 + 一次性 token；token 用完即焚 |
| **MCP 工具注入** | 🔴 高 | 每个 MCP 工具调用弹窗确认（复用 ConsentManager）；默认禁用所有 MCP 工具；用户显式启用 |
| **本地文件全盘索引泄露** | 🔴 高 | 仅索引用户显式选定的目录；数据本地；随时可删除；默认不启用 |
| **跨阶段数据迁移** | 🟡 中 | `chat_history.json → chats/{hash}.json` 提供幂等迁移；失败可回滚 |
| **OAuth refresh token 处理** | 🟡 中 | Platform JWT 1 小时过期，Desktop 检测 `exp - now < 5min` 自动用 refresh_token 续签 |
| **Tauri 2 + 多 WebviewWindow 性能** | 🟢 低 | 单进程共享 Rust 状态；窗口间通信走 Tauri event 总线；实测控制 5 个以内窗口无明显卡顿 |
| **Vision v3.1 文档与实现偏差** | 🟢 低 | future-plan.md 为唯一路线图；所有 PR description 标注 vision-0620 对齐

---

## 8. 决策点（实施前需确认）

以下决策点影响多个 Phase 的实现方式，建议在启动 Phase 0 前逐项决策。

### D1 群消息路由：并行 vs 串行（已决策 ✅）

| 方案 | 优点 | 缺点 |
|------|------|------|
| **并行** | 速度快，群聊「即时感」强 | 后回答的 Agent 看不到前面 Agent 的回答 |
| **串行 🏆** | 上下文连贯，每个 Agent 能看到前面 Agent 的输出 | 慢（N 个 Agent = N 倍等待时间） |

**决策：先串行。** 稳定后考虑引入"主持人"Agent（见 D8）进行更复杂的群讨论编排。

### D2 LLM 审计防线（已决策 ✅）

**先不实现。** L0-L3 权限模式已提供足够安全基线。LLM 审计作为 P2 功能后续加入。

**未来实现方案（已定）：**
- **模型：** DeepSeek V4 Flash（快速，性价比高）
- **审计方式：** 分析 subprocess 命令的目的、潜在风险，给出综合评分
- **审计模型权限：** 受限制的只读工具调用（可读文件以确认 Python 代码的实际内容）
- **高危操作：** 标记为可疑/高危 → 强制弹窗确认
  - 与免打扰联动：**有免打扰 → 窗口内确认卡片；无免打扰 → 置顶系统弹窗**
- **审计模型掉线：** 明示用户"审计模型离线"，建议切换至受限权限模式手动审批
- **群聊统一权限：** 群设置内统一配置权限级别，群内 Agent 统一执行。审批弹窗同上（免打扰联动）

### D3 平衡模式版本控制（已决策 ✅）

| 方案 | 说明 |
|------|------|
| **参考 Claude Code CLI 方式 🏆** | 按操作记录变更（如"文件 A 第 10 行替换为 B"），每个变更独立可逆。用户编辑其他位置不影响回滚 |
| git (libgit2) | 需要每个目录 init，.git 可见，回滚粒度粗 |
| 自定义快照 | 需要自己写 diff 引擎 |

**决策：参考 Claude Code CLI 的变更追踪方式。** 每次文件修改记录 `{file, old_snippet, new_snippet, timestamp, agent_hash}`，回滚时只 revert 具体片段。作为 L2 平衡模式的进阶特性，Phase 2 后实施。

### D4 上下文隔离策略（已决策 ✅）

**决策：群聊作为独立消息渠道，与渠道模型一致。**

群聊 = 一个独立的 `MessageChannel`，与 Web / WeChat / IM 私聊同级。每个渠道有独立的 Session Memory，**不默认共享上下文**。

```
Agent A（唯一身份）
  ├── Session Memory (web)
  ├── Session Memory (wechat)
  ├── Session Memory (im)
  └── Session Memory (im_group:xxx)
         ↑ 各自独立，不默认共享 ↑
```

- Agent 可以在单聊中通过工具主动读取群聊 Session Memory（默认关闭权限）
- 未来实验功能：跨渠道上下文拼接，标注 `[渠道:群聊]`，用户可开启/关闭

### D5 本地模式群聊（已决策 ✅）

**决策：本地模式禁用群聊。** 仅有 SaaS 官方平台提供群聊功能。Desktop 上群聊 Tab 灰显，提示"群聊需要连接官方平台"。

### D6 IM 模式行为定义（已决策 ✅）

**修正理解：IM 模式不是限制工具，而是改变 Agent 的响应风格。**

| | 经典模式 | IM 模式 |
|---|---------|---------|
| **回复长度** | 详尽，完整段落 | 短句，1-3 句 |
| **长任务** | 前台等待 | **SubAgent 后台执行**，前台可中途打断 |
| **工具集** | 全部可用 | **全部可用，不限制** |
| **用户交互** | 等待完整输出 | 实时短句 + 后台进度指示 |
| **打断能力** | 弱（消息发了就发了） | **强**（用户可随时说"这个不做了，换个方向"） |

IM 模式的本质是把 Agent 从"AI 助手"变成"可以随时打断的下属"。

### D7 文件写入展示与同步（已决策 ✅）

**决策：diff 预览，参考 Claude Code CLI 界面。不展示 Git 统一 diff。**

Agent 写完文件 → Desktop 展示**可视化差异**（并排/上下对照，红删绿增）→ 用户确认 → 写回本地。

**两种文件编辑工具：**
| 工具 | 行为 | 安全约束 |
|------|------|---------|
| **覆盖写** | 完整重写文件 | 无额外约束 |
| **替换写** | Agent 提供 `match_string` + `new_string`，系统搜索替换 | `match_string` 必须在文件中唯一出现 |

**安全日志：** 每次 `/mnt/desktop/` 操作记录 `{timestamp, agent_hash, path, operation, intent, permission_mode, approved}`。

### D8 群聊主持人 Agent（远期规划）

**概念：** 每个群内置一个「主持人」Agent，负责：

- 决定何时让哪个 Agent 发言
- 总结群聊进展
- 分配任务给特定 Agent
- 保持群聊不跑题

**现状：** 串行路由已够用。主持人角色可纳入中远期规划（Phase 4 稳定后）。

**实现方式：** 在 Group 模型中新增 `moderator_agent_hash` 字段。主持人收到消息后先思考「谁适合回答」，再路由给对应 Agent。

### T0 实施前决策（架构待定）

以下三个在启动 Phase 0 前需要决定。

#### T0.1 Phase 0 粒度（已决策 ✅）

**决策：拆为 P0a / P0b / P0c 三步，每步 2-3 天。**

| 子阶段 | 内容 | 工时 |
|:------:|------|:----:|
| P0a | 三栏 UI 骨架 + SQLite 建表 + 聊天历史导入 + 消息草稿 | 3d |
| P0b | 左下角 ➕ 创建 Agent/群聊 + 文件引用卡片 | 2d |
| P0c | 小侧栏 + API 对接 | 2d |

#### T0.2 前端技术栈（已决策 ✅）

**决策：纯 HTML + 模块化 JS。** 不引入 Vue/Svelte。

理由：零构建步骤、当前代码直接复用、WSL 上构建不折腾。通过模块化 (`components/`、`store.ts`) 管理复杂度即可。

#### T0.3 V2 收尾优先级（待决策 ❓）

#### T0.3 V2 收尾优先级

5 项待办中，哪项最先做？推荐顺序：
1. camelCase 验证（已基本完工）
2. 云模式 JWT 鉴权（关键前置）
3. 文件桥接 ws.rs 接入
4. Cargo 补全
5. 开机自启

**待定：** V2 全部收完才开 V3，还是 camelCase 验证完就并行启动 Phase 0？

---

### 附录：IM 功能对标检查

对照微信/Telegram/Slack 等典型 IM 软件，确认 FeClaw-Desktop V3 覆盖情况：

| 功能 | 微信 | Telegram | Slack | FeClaw | 说明 |
|------|:---:|:--------:|:-----:|:------:|------|
| 私聊 | ✅ | ✅ | ✅ | ✅ Phase 0 | |
| 群聊 | ✅ | ✅ | ✅ | ✅ Phase 4 | |
| 文件传输 | ✅ | ✅ | ✅ | ✅ Phase 3+8 | 扫码上传 + 右键引用 |
| 图片/截图 | ✅ | ✅ | ✅ | ✅ Phase 1 | |
| 消息引用 | ✅ | ✅ | ✅ | ✅ Phase 0 | |
| @提及 | ✅ | ✅ | ✅ | ✅ Phase 4 | |
| 消息历史 | ✅ | ✅ | ✅ | ✅ Phase 0 | SQLite 本地缓存 |
| 置顶聊天 | ✅ | ✅ | ✅ | ✅ Phase 2 | 小侧栏 |
| 免打扰 | ✅ | ✅ | ✅ | ✅ Phase 2 | 小侧栏 |
| 搜聊天记录 | ✅ | ✅ | ✅ | ✅ Phase 7 | 向量搜索，比所有 IM 都强 |
| 快捷回复/模板 | ❌ | ✅ | ✅ | ✅ Phase 1 | 对标 Telegram/Slack |
| 消息撤回 | ✅ | ✅ | ❌ | ⬜ **待加** | 撤回后软删 + 标记 `(已撤回)` |
| 表情回应 | ✅ | ✅ | ✅ | ⬜ **待加** | `👍❤️😂😮😢😡` 六连 |
| 已读回执 | ⚠️ 群 | ✅ | ✅ | 🟡 Phase 11 | IM 模式的一部分 |
| 输入中…指示器 | ✅ | ✅ | ✅ | 🟡 Phase 11 | IM 模式 |
| 在线状态 | ✅ | ✅ | ✅ | 🟡 Phase 11 | IM 模式 |
| 消息草稿 | ❌ | ✅ | ✅ | ⬜ **待加** | 切换聊天不丢输入内容 |
| 多设备支持 | ✅ | ✅ | ✅ | 🟢 架构已支持 | IM 渠道，Desktop+Mobile 共享 |
| 聊天记录导出 | ✅ | ✅ | ✅ | ⬜ 低优先级 | 后续加 |
| 聊天背景 | ✅ | ✅ | ❌ | ⬜ 低优先级 | Agent 颜色主题 |

**待加的高优功能：**

1. **消息撤回（高）** — 用户长按自己发的消息 → 「撤回」→ 软删除，显示 `(已撤回)`
2. **表情回应（高）** — 长按消息 → 六连表情选择。Agent 也可发回应（系统根据内容决定）
3. **消息草稿（中）** — 输入框打字后切换聊天，内容保留不丢失

建议 Phase 1-2 之间补上撤回和回应（各 1 天工时）。草稿在 Phase 0 就做（即写即用）。

---

## 9. 后续步骤

**立即（本周）：**
1. V2 收尾（补 FileWriteResponse + ws bridge 接入 + auth_failure，约 1-2 天）
2. 启动 V3 Phase 0a（三栏 UI 骨架 + SQLite + 草稿）

**短期（2 周内）：**
3. Phase 0a → 0b → 0c 三迭代
4. Phase 1（截图 + 模板）可与 Phase 0c 并行

**中期（1 个月内）：**
5. Phase 2（文件管理器）+ Phase 3（右键菜单）
6. 启动 Phase 4（群聊引擎侧）——核心差异化功能

**中期（3 个月内）：**
6. 完成 Phase 4–7（群聊 + 群广场 + 小程序 + 搜索）——Vision v3.1 主功能全部上线

**长期（6 个月+）：**
7. Phase 8（扫码上传）+ Phase 9（MCP）+ Phase 10（全盘索引）+ Phase 11（IM 模式）
8. Phase 12（多模态 PC 操控）——探索