# FeClaw-Desktop V3 实施计划

> 基于 vision.md（2026-06-20）的完整实施计划。
> 涵盖：Phase 0–11 的详细架构、数据模型、通信协议、UI 组件、Rust 命令、Python 引擎改动、系统集成。
>
> 最后更新：2026-06-20

---

## 目录

- [A. 架构概览](#a-架构概览)
- [B. 数据模型](#b-数据模型)
- [C. 通信协议](#c-通信协议)
- [D. 前端 UI](#d-前端-ui)
- [E. 前端集成 (Tauri Commands)](#e-前端集成-tauri-commands)
- [F. 后端集成 (FeClaw 引擎改动)](#f-后端集成-feclaw-引擎改动)
- [G. 系统集成](#g-系统集成)
- [H. 实施阶段](#h-实施阶段)
- [I. 风险与缓解](#i-风险与缓解)

---

## A. 架构概览

### A.1 核心映射：Agent = 联系人

vision.md 的核心洞察是把 **AI Agent 视为微信联系人**。这个映射直接驱动了整个架构：

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FeClaw-Desktop V3                             │
│                                                                     │
│  ┌──────────────────────────────┐    ┌────────────────────────────┐ │
│  │     左侧导航面板              │    │     右侧主内容区            │ │
│  │                              │    │                            │ │
│  │  ┌ 私聊列表 ──────────────┐  │    │  ┌ 聊天窗口 ────────────┐  │ │
│  │  │ 数学老师 (a1b2)       │  │    │  │ Agent 流式输出        │  │ │
│  │  │ 英语老师 (c3d4)       │  │    │  │ 消息引用卡片          │  │ │
│  │  │ 编程助手 (e5f6)       │  │    │  │ 图片/截图展示         │  │ │
│  │  └────────────────────────┘  │    │  └──────────────────────┘  │ │
│  │                              │    │                            │ │
│  │  ┌ 群聊列表 ──────────────┐  │    │  ┌ 富文本输入区域 ──────┐  │ │
│  │  │ 学习群 (3 agents)     │  │    │  │ contenteditable div   │  │ │
│  │  │ 开发群 (2 agents)     │  │    │  │ 支持粘贴图片          │  │ │
│  │  └────────────────────────┘  │    │  │ 快捷键模板列表        │  │ │
│  │                              │    │  └──────────────────────┘  │ │
│  │  ┌ 搜一搜 ────────────────┐  │    │                            │ │
│  │  │ ⌘K 全局搜索框         │  │    │  ┌ 三 dot 菜单 ──────────┐  │ │
│  │  └────────────────────────┘  │    │  │ 📂 文件管理器         │  │ │
│  │                              │    │  │ ⚙️ Agent 配置          │  │ │
│  │  ┌ 群朋友圈 ──────────────┐  │    │  │ 🏪 小程序列表         │  │ │
│  │  │ 学习群动态列表         │  │    │  │ 📱 朋友圈设置         │  │ │
│  │  └────────────────────────┘  │    │  └──────────────────────┘  │ │
│  └──────────────────────────────┘    └────────────────────────────┘ │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                      Rust Backend (Tauri)                     │   │
│  │                                                              │   │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌───────────────┐  │   │
│  │  │ws.rs     │ │chat.rs   │ │group.rs   │ │moments.rs     │  │   │
│  │  │WS client │ │私聊状态  │ │群聊聚合   │ │朋友圈数据     │  │   │
│  │  └──────────┘ └──────────┘ └───────────┘ └───────────────┘  │   │
│  │                                                              │   │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌───────────────┐  │   │
│  │  │search.rs │ │qr_upload │ │mcp.rs     │ │right_click.rs │  │   │
│  │  │向量搜索  │ │.rs       │ │MCP client │ │右键菜单注册   │  │   │
│  │  └──────────┘ │扫码上传  │ └───────────┘ └───────────────┘  │   │
│  │               └──────────┘                                   │   │
│  │  ┌──────────────────────────────────────────────────────────┐ │   │
│  │  │ 现有模块 (不变或少量扩展)                                │ │   │
│  │  │ auth.rs | config.rs | consent.rs | engine.rs |           │ │   │
│  │  │ executor.rs | file_bridge.rs | file_ops.rs | tray.rs     │ │   │
│  │  │ ws_types.rs | welcome.rs | settings.rs | autostart.rs    │ │   │
│  │  └──────────────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ═══════════════════════ WebSocket ═══════════════════════════════  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                FeClaw Engine (Python)                         │   │
│  │  desktop_relay.py | desktop_ws.py | apps_service.py | ...    │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### A.2 模块职责对照

| 模块 | 归属 | 核心职责 |
|------|------|---------|
| 私聊 | Desktop | 通过现有 WS 通道发送 `chat_message`，接收 `chat_reply` / `chat_event` |
| 群聊 | **Desktop 独占** | 并行调用多个 Agent 的 `chat_message`，聚合回复，展示时间线 |
| 朋友圈 | **Desktop 独占** | 监听群内 Agent 产出事件，本地存储 timeline，按群过滤展示 |
| 小程序 | FeClaw 引擎 | 复用 `apps_service.py`，Desktop 仅嵌入 iframe 展示 |
| 搜一搜 | Desktop + 引擎 | Agent 内搜索走引擎向量库；全局搜索走 Desktop 本地索引 |
| 消息引用 | Desktop + 引擎 | 前端生成 `[reference:xxx]` token；引擎解析 |
| 文件传输助手 | **Desktop 独占** | 临时 HTTP server + 二维码 + 手机网页上传 |
| 右键菜单 | **Desktop 独占** | Windows Registry 注册 + shell extension |
| 快捷模板 | **Desktop 独占** | 本地 JSON 存储 + 输入框弹出面板 |
| MCP 连接 | **Desktop 独占** | 本地 MCP Client → WS 中继 → 引擎工具调用 |
| 全盘索引 | **Desktop 独占** | 后台进程 + 本地向量库（usearch/lancedb） |

### A.3 关键设计决策

1. **群聊不在 Server 端做**。Server 只有 Agent 的 1:1 chat 能力。Desktop 负责并行调用多个 Agent、聚合、排序、展示。
2. **朋友圈数据完全本地化**。Agent 产出事件通过现有 SSE/WS 流推送，Desktop 解析并存入本地 `moments.json`。
3. **小程序复用已有系统**。FeClaw 引擎的 `apps_service.py` 已完整实现 App 注册、路由、沙箱执行，Desktop 只需展示 iframe。
4. **右键菜单是 Windows 专属**，通过注册表 + COM shell extension 实现（远期可选 Rust 原生实现）。

---

## B. 数据模型

### B.1 Rust 数据模型

#### B.1.1 群聊 (GroupChat)

```rust
// src-tauri/src/group.rs
use serde::{Deserialize, Serialize};

/// 一个群聊 = 多个 Agent 的集合
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    /// 群 ID（UUID v4）
    pub id: String,
    /// 群名称
    pub name: String,
    /// 群成员 agent_hash 列表
    pub members: Vec<String>,
    /// 是否开启朋友圈
    #[serde(default)]
    pub moments_enabled: bool,
    /// 创建时间 (Unix epoch seconds)
    pub created_at: String,
    /// 最后活跃时间
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_active_at: Option<String>,
}

/// 群聊中的一条消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupMessage {
    /// 消息 ID
    pub id: String,
    /// 所属群 ID
    pub group_id: String,
    /// 发送者：`"user"` 或 agent_hash
    pub sender: String,
    /// 发送者显示名（Agent name 或 "我"）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_name: Option<String>,
    /// 消息内容
    pub content: String,
    /// 时间戳
    pub timestamp: String,
    /// @提及的 agent_hash 列表
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<String>,
    /// 引用的消息 ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// 附件
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
}

/// 消息附件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub kind: String,  // "image" | "file" | "reference"
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// 前端加载群聊时的快照
#[derive(Debug, Clone, Serialize)]
pub struct GroupChatSnapshot {
    pub group: Group,
    pub messages: Vec<GroupMessage>,
    /// 该群的朋友圈动态数
    pub moments_count: usize,
}
```

#### B.1.2 朋友圈 (Moments)

```rust
// src-tauri/src/moments.rs
use serde::{Deserialize, Serialize};

/// 一条朋友圈动态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Moment {
    /// 动态 ID
    pub id: String,
    /// 所属群 ID
    pub group_id: String,
    /// 发布者 agent_hash（或 "user"）
    pub author: String,
    /// 发布者显示名
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
    /// 动态内容
    pub content: String,
    /// 动态类型
    pub kind: MomentKind,
    /// 相关数据 (JSON，用于链接跳转)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    /// 时间戳
    pub timestamp: String,
    /// 用户是否手动发布
    #[serde(default)]
    pub is_manual: bool,
}

/// 动态类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MomentKind {
    /// 任务完成
    TaskCompleted,
    /// 文件变更
    FileChanged,
    /// 分析报告
    AnalysisReport,
    /// 自定义消息
    Custom,
}

/// 前端加载朋友圈时的快照
#[derive(Debug, Clone, Serialize)]
pub struct MomentsSnapshot {
    pub group_id: String,
    pub group_name: String,
    pub moments: Vec<Moment>,
}
```

#### B.1.3 快捷模板 (Prompt Templates)

```rust
// src-tauri/src/templates.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptTemplate {
    pub id: String,
    pub label: String,      // 按钮显示文本，如 "翻译成英文"
    pub content: String,    // 完整的 Prompt 文本
    pub category: String,   // "写作" | "翻译" | "代码" | "自定义"
    #[serde(default)]
    pub is_builtin: bool,
}
```

#### B.1.4 搜索 (Search)

```rust
// src-tauri/src/search.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    /// 来源：agent_hash、文件路径、或 "local"
    pub source: String,
    /// 显示标题
    pub title: String,
    /// 匹配片段
    pub snippet: String,
    /// 相关度分数
    pub score: f32,
    /// 数据来源类型
    pub source_kind: SearchSourceKind,
    /// 跳转目标
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchSourceKind {
    ChatMessage,
    File,
    Moment,
    Reference,
}
```

#### B.1.5 小程序 (MiniProgram)

```rust
// src-tauri/src/mini_program.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MiniProgramEntry {
    pub app_id: String,
    pub name: String,
    pub description: String,
    pub agent_hash: String,
    /// 访问 URL（相对路径如 /apps/my-app/）
    pub url: String,
    /// 入口图标
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}
```

#### B.1.6 Config 扩展

```rust
// config.rs 新增字段
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    // ... 现有字段 ...

    /// 快捷模板列表
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub prompt_templates: Vec<PromptTemplate>,

    /// 群聊列表（本地持久化）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<Group>,

    /// 右键菜单/发送的默认行为
    #[serde(default)]
    pub right_click_default: RightClickDefault,

    /// 文件索引目录列表
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub indexed_directories: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RightClickDefault {
    #[default]
    Send,     // 发送（云端副本，本地只读）
    Reference, // 引用（可读写）
}
```

#### B.1.7 文件索引 (FileIndex)

```rust
// src-tauri/src/file_index.rs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedFile {
    /// 绝对路径
    pub path: String,
    /// 文件名
    pub name: String,
    /// 文件大小
    pub size: u64,
    /// 最后修改时间
    pub modified_at: String,
    /// 内容哈希（用于增量更新检测）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    /// 已提取的文本摘要（前 500 字符）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_snippet: Option<String>,
}

/// 索引元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexMetadata {
    /// 索引版本
    pub version: u32,
    /// 已索文件数
    pub file_count: u32,
    /// 最后全量索引完成时间
    pub last_full_index: Option<String>,
    /// 被跳过的文件数（二进制、过大等）
    pub skipped_count: u32,
}
```

### B.2 Python 模型扩展（FeClaw 引擎）

```python
# 新增：群聊消息事件 (在 desktop_ws.py 的 handle_desktop_message 中)
# Desktop → Engine: 多 Agent 群聊时，Desktop 挨个向 Agent 发 chat_message
# 无需服务端模型变更——Engine 只看到「某个 Agent 收到了一条 chat_message」

# 新增：Moments 发布事件（Engine → Desktop）
# 当 Agent 完成重要操作时，Engine 可发送 moments_event
# 格式：{ "type": "moments_event", "agent_hash": "...", "kind": "...", "content": "...", "data": {...} }
```

### B.3 本地文件存储布局

```
~/.feclaw/
├── config.toml              # 主配置（含 groups, prompt_templates）
├── settings.json            # 桌面设置
├── ui-settings.json         # UI 键值设置
├── local-credentials        # 本地认证凭据
├── trusted-commands.json    # 已信任命令
├── chat_history.json        # 私聊历史（已有）
├── groups/                  # 群聊数据目录
│   ├── {group_id}.json      # 群聊消息
│   └── {group_id}_moments.json  # 群朋友圈
├── templates.json           # 快捷模板
├── file_index/              # 文件索引
│   ├── index_meta.json      # 索引元数据
│   └── vectors.db           # 本地向量库 (usearch/lancedb)
└── uploads/                 # 扫码上传临时文件
    └── {session_id}/
```

---

## C. 通信协议

### C.1 WebSocket 消息类型全览

#### C.1.1 现有消息类型（不变）

```
Engine → Desktop:
  command_exec_request     - 命令执行请求 (L1-L5 风险)
  file_read_request        - 读文件请求
  file_write_request       - 写文件请求
  file_delete_request      - 删文件请求
  notification             - 托盘通知
  chat_reply               - Agent 回复
  chat_event               - 流式事件 (thinking / tool / tool_result / message / done)
  file_operation_request   - 文件操作授权请求
  pong                     - 心跳响应

Desktop → Engine:
  command_exec_response    - 命令执行结果
  file_read_response       - 读结果
  file_write_response      - 写结果
  file_delete_response     - 删结果
  consent_response         - 用户决策
  chat_message             - 聊天消息
  disconnect               - Desktop 关闭
  ping                     - 心跳
```

#### C.1.2 V3 新增消息类型

```
Engine → Desktop (新增):
  moments_event            - Agent 产出事件（触发朋友圈动态）
  mini_program_list        - 某 Agent 的小程序列表
  agent_status_change      - Agent 状态变更（在线/离线/忙碌）

Desktop → Engine (新增):
  group_chat_message       - 群聊消息（携带 group_id + mentions）
  mini_program_launch      - 打开小程序
  search_request           - 语义搜索请求
  mcp_tool_request         - MCP 工具调用请求（Desktop 中继）
  mcp_tool_response        - MCP 工具调用结果
```

#### C.1.3 新增消息 JSON Schema

```jsonc
// === moments_event (Engine → Desktop) ===
{
  "type": "moments_event",
  "agent_hash": "a1b2",
  "agent_name": "数学老师",
  "group_id": "uuid-of-group",        // 关联的群（可选，如无则为全局）
  "kind": "task_completed",           // task_completed | file_changed | analysis_report | custom
  "content": "批改了 3 份试卷，正确率 72%",
  "data": {                           // 可选：结构化数据
    "vfs_path": "/workspace/exams/batch_001/",
    "metrics": { "correct_rate": 0.72, "weak_points": ["诱导公式"] }
  },
  "timestamp": "1750000000"
}

// === group_chat_message (Desktop → Engine) ===
{
  "type": "group_chat_message",
  "id": "msg-uuid",
  "group_id": "uuid-of-group",
  "sender": "user",
  "content": "帮我分析这张试卷",
  "mentions": ["a1b2"],               // @的 agent hash 列表；空 = 发给所有群成员
  "reply_to": "prev-msg-uuid",        // 可选：引用的消息 ID
  "attachments": [
    { "kind": "image", "path": "/mnt/desktop/exam_photo.png", "name": "试卷照片.png" }
  ],
  "timestamp": "1750000000"
}

// === mini_program_list (Engine → Desktop) ===
{
  "type": "mini_program_list",
  "agent_hash": "a1b2",
  "apps": [
    {
      "app_id": "vocab-drill",
      "name": "单词本",
      "description": "交互式英语单词练习",
      "icon": "📖",
      "url": "/apps/vocab-drill/"
    }
  ]
}

// === search_request (Desktop → Engine) ===
{
  "type": "search_request",
  "id": "search-uuid",
  "query": "三角函数 诱导公式",
  "agent_hash": "a1b2",               // 限定搜索范围（可选，空 = 全局）
  "include_local": true,              // 是否包含本地文件索引
  "top_k": 10
}

// === search_response (Engine → Desktop) ===
{
  "type": "search_response",
  "id": "search-uuid",
  "results": [
    {
      "source": "agent/a1b2",
      "title": "2026-06-15 数学作业批改",
      "snippet": "...三角函数诱导公式...",
      "score": 0.92,
      "source_kind": "file",
      "target": "/workspace/exams/batch_001/report.md"
    }
  ]
}

// === mcp_tool_request (Engine → Desktop) ===
{
  "type": "mcp_tool_request",
  "id": "mcp-uuid",
  "tool_name": "sqlite_query",
  "arguments": { "query": "SELECT * FROM users" },
  "agent_hash": "a1b2"
}

// === mcp_tool_response (Desktop → Engine) ===
{
  "type": "mcp_tool_response",
  "id": "mcp-uuid",
  "status": "ok",                     // "ok" | "error"
  "payload": {
    "result": "..."                   // 或 { "error": "..." }
  }
}
```

### C.2 群聊通信流程

```
用户发送群聊消息
        │
        ▼
┌────────────────┐
│  Desktop 前端  │  1. 用户点击发送
│  输入框        │  2. 生成本地 GroupMessage（sender="user"）
└───────┬────────┘  3. 持久化到 groups/{group_id}.json
        │
        ▼
┌────────────────┐
│  Rust group.rs │  4. 遍历群成员 agent_hash 列表
│  broadcast()   │  5. 为每个 Agent 构造独立的 chat_message
└───────┬────────┘     - copy mentions: 只保留 @该Agent 的
        │              - copy attachments: 全部传递
        │              - 标记 group_id 用于回传关联
        │
        ▼
┌──────────────────────────────────────────────────┐
│  并行 WS 发送                                    │
│                                                  │
│  ┌─ ws.send → agent_a1b2 → Engine → Agent 回复   │
│  ├─ ws.send → agent_c3d4 → Engine → Agent 回复   │
│  └─ ws.send → agent_e5f6 → Engine → Agent 回复   │
│                                                  │
│  每个 Agent 回复的 chat_reply 携带 group_id      │
│  Desktop 接收后：                                │
│    1. 创建 GroupMessage（sender=agent_hash）     │
│    2. 持久化                                     │
│    3. 通过 Tauri event 推送到前端                │
└──────────────────────────────────────────────────┘
        │
        ▼
┌────────────────┐
│  前端更新 UI   │  所有群成员回复按时间顺序展示
│  群聊窗口      │  @提及的消息高亮
└────────────────┘
```

### C.3 朋友圈事件流

```
Agent 在 Engine 中完成操作
        │
        ▼
┌────────────────┐
│  Engine 判断   │  操作是否需要创建 Moments 事件
│  agent_executor │  - TaskCompleted: Agent 执行了工具调用
└───────┬────────┘  - FileChanged: VFS 文件创建/修改
        │           - AnalysisReport: Agent 输出了分析结论
        │
        ▼
┌────────────────┐
│  Desktop WS     │  Engine → Desktop 发送 moments_event
│  接收           │  包含 agent_hash、content、data 等
└───────┬────────┘
        │
        ▼
┌────────────────┐
│  Rust moments.rs│  1. 查找该 agent 所属的群
│  handle_event() │  2. 创建 Moment 实例
└───────┬────────┘  3. 持久化到 groups/{group_id}_moments.json
        │           4. 通过 Tauri event 推送到前端
        ▼
┌────────────────┐
│  Frontend       │  朋友圈面板更新
│  MomentsPanel   │  仅展示该群的动态
└────────────────┘
```

### C.4 云端模式 vs 本地模式协议区别

| 方面 | 本地模式 | 云模式 |
|------|---------|--------|
| WS 端点 | `ws://127.0.0.1:{port}/ws/desktop/{hash}` | `wss://feclaw.lizidaren.cn/ws/desktop/{hash}` |
| 认证方式 | 本地 JWT (local-credentials) | 云端 JWT (cloud_token) |
| Agent 发现 | 扫描 ~/.feclaw/agent_*.json | `POST /api/agents/list` REST |
| 文件路径 | `/mnt/desktop/...` 直接映射 | `/mnt/desktop/...` 经 WS 中继 |
| 搜索 | 引擎向量库 + 本地向量库 | 引擎向量库 + 本地向量库 |
| 群聊 | Desktop 本地聚合 | Desktop 本地聚合（无区别） |
| 朋友圈 | Desktop 本地存储 | Desktop 本地存储（无区别） |

**关键原则：群聊和朋友圈逻辑完全相同，不受模式影响。** 只有 Agent 连接方式（本地进程 vs 远程 WS）和文件操作路径不同。

---

## D. 前端 UI

### D.1 窗口架构

Tauri 2 多窗口架构，与现有 `chat`、`settings`、`welcome` 窗口共存：

```
┌──────────────────────────────────────────────────────────────────────┐
│  main 窗口（隐藏，仅用于 app state）                                  │
│  ├─ welcome 窗口（首次启动，按需聚焦）                                │
│  ├─ chat 窗口（主界面，Phase 0 改造为左侧栏 + 右侧聊天）              │
│  ├─ settings 窗口（已有，扩展 tab）                                   │
│  ├─ file-manager 窗口（新建，三 dot 菜单触发）                        │
│  ├─ moments 窗口（新建，朋友圈面板）                                  │
│  ├─ mini-program 窗口（新建，小程序 iframe）                          │
│  └─ qr-upload 窗口（新建，扫码上传弹窗）                              │
└──────────────────────────────────────────────────────────────────────┘
```

### D.2 chat 窗口组件树（Phase 0 改造）

```
chat/index.html
└── <body class="app-shell">
    ├── <aside id="left-sidebar">
    │   ├── <div id="user-info">           <!-- 用户头像 + 状态 -->
    │   ├── <nav id="sidebar-nav">
    │   │   ├── <button data-tab="private">  💬 私聊  </button>
    │   │   ├── <button data-tab="groups">   👥 群聊  </button>
    │   │   ├── <button data-tab="search">   🔍 搜一搜</button>
    │   │   └── <button data-tab="moments">  📱 朋友圈</button>
    │   │
    │   ├── <div id="tab-private" class="tab-content">
    │   │   └── <agent-list>               <!-- Agent 联系人列表 -->
    │   │       ├── <agent-item data-hash="a1b2">
    │   │       │   ├── .avatar
    │   │       │   ├── .name
    │   │       │   ├── .last-message       <!-- 最后一条消息预览 -->
    │   │       │   └── .unread-badge
    │   │       └── ...
    │   │
    │   ├── <div id="tab-groups" class="tab-content" hidden>
    │   │   ├── <button id="create-group"> + 新建群聊 </button>
    │   │   └── <group-list>
    │   │       └── <group-item> ... </group-item>
    │   │
    │   ├── <div id="tab-search" class="tab-content" hidden>
    │   │   └── <search-box>               <!-- ⌘K 搜索框 -->
    │   │       ├── <input>
    │   │       └── <search-results>
    │   │
    │   └── <div id="tab-moments" class="tab-content" hidden>
    │       └── <group-moments-list>
    │           └── <group-moments-item>
    │
    └── <main id="right-panel">
        ├── <header id="chat-header">
        │   ├── <span class="chat-title">   <!-- Agent 名 或 群名 -->
        │   ├── <button id="three-dot-menu"> ⋮ </button>
        │   └── <button id="phone-upload">  📱 </button>
        │
        ├── <div id="message-list">         <!-- 消息流 -->
        │   ├── <message-bubble class="user"> ... </message-bubble>
        │   ├── <message-bubble class="agent" data-agent="a1b2"> ... </message-bubble>
        │   ├── <message-bubble class="thinking"> ... </message-bubble>  <!-- 流式输出中 -->
        │   ├── <message-bubble class="tool-call"> ... </message-bubble>
        │   └── <message-bubble class="consent-card"> ... </message-bubble>
        │
        ├── <div id="input-area">
        │   ├── <div id="template-bar">     <!-- 快捷模板 -->
        │   │   ├── <button> 翻译成英文 </button>
        │   │   ├── <button> 总结摘要 </button>
        │   │   └── ...
        │   ├── <div id="rich-input" contenteditable="true">
        │   │   <!-- 富文本输入：支持粘贴图片、@提及 -->
        │   ├── <button id="send-btn"> 发送 </button>
        │   └── <div id="attachment-preview"> <!-- 待发送附件预览 -->
        │
        └── <div id="three-dot-panel" class="dropdown-menu" hidden>
            ├── <button data-action="file-manager"> 📂 文件管理器 </button>
            ├── <button data-action="agent-config">  ⚙️ Agent 配置  </button>
            ├── <button data-action="mini-programs"> 🏪 小程序列表 </button>
            ├── <button data-action="moments-config">📱 朋友圈设置 </button>
            └── <hr> <button data-action="clear-chat"> 清空对话 </button>
    </main>
```

### D.3 富文本输入实现

```html
<!-- #rich-input 实现方案 -->
<div id="input-container" class="rich-input-wrapper">
  <!-- contenteditable div 作为核心输入区 -->
  <div id="rich-input"
       contenteditable="true"
       placeholder="输入消息... 支持 Ctrl+V 粘贴截图"
       role="textbox"
       aria-multiline="true">
  </div>
  <!-- 隐藏的 file input 用于粘贴图片 -->
  <input type="file" id="paste-file-input" accept="image/*" hidden>
</div>
```

```typescript
// chat.ts 中的粘贴处理
const richInput = $('#rich-input') as HTMLDivElement;

richInput.addEventListener('paste', (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const blob = item.getAsFile();
      if (blob) handlePastedImage(blob);
      return;
    }
  }
  // 纯文本粘贴 → 正常处理
});

async function handlePastedImage(blob: File) {
  // 1. 转为 base64 用于预览
  const reader = new FileReader();
  reader.onload = () => {
    // 2. 插入缩略图到输入区
    const img = document.createElement('img');
    img.src = reader.result as string;
    img.classList.add('pasted-image-preview');
    richInput.appendChild(img);
  };
  reader.readAsDataURL(blob);

  // 3. 保存到临时文件
  const path = await invoke('save_temp_image', { imageBase64: await blobToBase64(blob) });
  // 4. 添加到待发送附件列表
  pendingAttachments.push({ kind: 'image', path, name: 'screenshot.png' });
}
```

### D.4 三 dot 菜单结构

```
┌────────────────────────┐
│ ⋮                      │
├────────────────────────┤
│ 📂 文件管理器          │ → 打开 file-manager 窗口，展示当前 Agent 的 VFS
│ ⚙️ Agent 配置          │ → 内联面板或 settings 窗口的 Agent tab
│ 🏪 小程序列表          │ → 打开 mini-program 列表面板
│ 📱 朋友圈设置          │ → 切换群朋友圈开关 / 选择触发类型
│ ────────────────────── │
│ 🗑 清空对话            │ → 清除 chat_history.json
│ 📋 复制对话摘要        │ → 全选 → clipboard
└────────────────────────┘
```

### D.5 导航/路由

```
左侧栏 Tab          右侧主区域内容
──────────────────────────────────────────
💬 私聊 (默认)  →  当前选中 Agent 的 1:1 聊天窗口
👥 群聊         →  群列表（点击群进入群聊窗口）
🔍 搜一搜       →  ⌘K 搜索框 + 结果列表（可点击跳转到聊天）
📱 朋友圈       →  按群分组的朋友圈动态流（可展开/折叠）
```

切换逻辑（纯前端，无需 Tauri 命令）：
- 所有数据已在加载时获取（`load_agents`, `load_groups`, `load_moments`）
- Tab 切换仅改变 CSS `display` / `hidden` 属性
- 选中不同 Agent 时调用 `invoke('get_chat_history_for_agent', { agentHash })`

### D.6 文件管理器面板

```
┌──────────────────────────────────────────────────────────────┐
│ 📂 文件管理器 — 数学老师 (a1b2)                      [× 关闭] │
├──────────────────────────────────────────────────────────────┤
│ 路径: /workspace/                                  [刷新]    │
├────────────┬─────────────────────────────────────────────────┤
│ 📁 exams/  │                                                   │
│ 📁 notes/  │  ┌─────────────────────────────────────┐       │
│ 📁 apps/   │  │  选中文件详情                        │       │
│ 📄 README  │  │  名称: report.md                    │       │
│            │  │  大小: 2.4 KB                       │       │
│            │  │  修改时间: 2026-06-20               │       │
│            │  │                                      │       │
│            │  │  [📥 下载] [📤 发送给 Agent] [🗑 删除] │       │
│            │  └─────────────────────────────────────┘       │
└────────────┴─────────────────────────────────────────────────┘
```

### D.7 群聊创建对话框

```
┌───────────────────────────────────────────┐
│  创建群聊                          [× 关闭] │
├───────────────────────────────────────────┤
│  群名称：[学习小组________________]        │
│                                           │
│  选择成员：                                │
│  ☑ 数学老师 (a1b2)                        │
│  ☑ 英语老师 (c3d4)                        │
│  ☐ 语文老师 (e5f6)                        │
│  ☐ 编程助手 (a7b8)                        │
│                                           │
│  ☐ 开启朋友圈                             │
│                                           │
│  [取消]            [创建]                   │
└───────────────────────────────────────────┘
```

### D.8 朋友圈面板

```
┌────────────────────────────────────────────────────────┐
│ 📱 群朋友圈                                           │
├────────────────────────────────────────────────────────┤
│                                                        │
│ ┌─ 学习群 ────────────────────────────────────────┐   │
│ │                                                  │   │
│ │ ✏️ 数学老师  刚刚批改了 3 份试卷                  │   │
│ │   正确率：72% | 薄弱项：诱导公式                   │   │
│ │   [查看详情 → 跳转文件管理器]                     │   │
│ │   ─────────────────────────────────────          │   │
│ │ 📝 英语老师  完成了作文批改                       │   │
│ │   评分：21/25                                     │   │
│ │   [查看批改详情]                                  │   │
│ │                                                  │   │
│ └──────────────────────────────────────────────────┘   │
│                                                        │
│ ┌─ 开发群 (暂无动态) ──────────────────────────┐      │
│ └──────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────┘
```

---

## E. 前端集成 (Tauri Commands)

### E.1 现有命令（不变或少量修改）

| 命令 | 所属模块 | 修改类型 |
|------|---------|---------|
| `load_settings` | settings.rs | 不需要修改 |
| `save_settings` | settings.rs | 不需要修改 |
| `open_settings_window` | settings.rs | 不需要修改 |
| `test_cloud_connection` | settings.rs | 不需要修改 |
| `get_cloud_session` | settings.rs | 不需要修改 |
| `cloud_login` | settings.rs | 不需要修改 |
| `cloud_disconnect` | settings.rs | 不需要修改 |
| `set_theme` | settings.rs | 不需要修改 |
| `get_theme` | settings.rs | 不需要修改 |
| `get_app_version` | settings.rs | 不需要修改 |
| `file_read` | file_ops.rs | **修改**：接受不带 `/mnt/desktop/` 前缀的路径 |
| `file_write` | file_ops.rs | 不需要修改 |
| `file_delete` | file_ops.rs | 不需要修改 |
| `check_first_launch` | welcome.rs | 不需要修改 |
| `save_welcome_config` | welcome.rs | 不需要修改 |
| `discover_well_known` | welcome.rs | 不需要修改 |
| `open_welcome_window` | welcome.rs | 不需要修改 |
| `get_chat_history` | chat.rs | **修改**：接受 `agent_hash` 参数 |
| `append_chat_message` | chat.rs | **修改**：接受 `agent_hash` 参数 |
| `clear_chat_history` | chat.rs | **修改**：接受 `agent_hash` 参数 |
| `send_chat_message` | chat.rs | **修改**：接受 `agent_hash` + `group_id` |
| `open_chat_window` | chat.rs | 不需要修改 |
| `get_connection_status` | chat.rs | 不需要修改 |
| `get_chat_history_path` | chat.rs | 不需要修改 |
| `send_consent_response` | chat.rs | 不需要修改 |

### E.2 Phase 0-2 新增命令

```rust
// ============ chat.rs 新增 ============

/// 获取当前用户的 Agent 列表（从 engine 或本地缓存）
#[tauri::command]
async fn list_agents(state: State<'_, AppState>) -> Result<Vec<AgentInfo>, String>;

/// 获取特定 Agent 的聊天历史
#[tauri::command]
async fn get_chat_history_for_agent(
    agent_hash: String,
) -> Result<ChatHistory, String>;

/// 获取所有快捷模板
#[tauri::command]
async fn get_prompt_templates() -> Result<Vec<PromptTemplate>, String>;

/// 保存快捷模板
#[tauri::command]
async fn save_prompt_templates(
    templates: Vec<PromptTemplate>,
) -> Result<(), String>;

/// 保存剪贴板中的图片到临时目录，返回路径
#[tauri::command]
async fn save_temp_image(image_base64: String) -> Result<String, String>;


// ============ group.rs (新建) ============

/// 创建群聊
#[tauri::command]
async fn create_group(name: String, members: Vec<String>) -> Result<Group, String>;

/// 获取所有群聊
#[tauri::command]
async fn list_groups() -> Result<Vec<Group>, String>;

/// 获取群聊消息
#[tauri::command]
async fn get_group_messages(group_id: String) -> Result<Vec<GroupMessage>, String>;

/// 发送群聊消息（并行广播到所有群成员 Agent）
#[tauri::command]
async fn send_group_message(
    group_id: String,
    content: String,
    mentions: Vec<String>,
    attachments: Vec<Attachment>,
    state: State<'_, AppState>,
) -> Result<String, String>;

/// 删除群聊
#[tauri::command]
async fn delete_group(group_id: String) -> Result<(), String>;

/// 更新群设置（名称、成员、朋友圈开关）
#[tauri::command]
async fn update_group(group: Group) -> Result<(), String>;


// ============ moments.rs (新建) ============

/// 获取某群的朋友圈动态
#[tauri::command]
async fn get_group_moments(group_id: String) -> Result<Vec<Moment>, String>;

/// 获取所有已开启朋友圈的群的动态
#[tauri::command]
async fn get_all_moments() -> Result<Vec<MomentsSnapshot>, String>;

/// 用户手动发布朋友圈动态
#[tauri::command]
async fn post_moment(
    group_id: String,
    content: String,
) -> Result<Moment, String>;


// ============ search.rs (新建) ============

/// 全局语义搜索
#[tauri::command]
async fn global_search(
    query: String,
    top_k: Option<usize>,
) -> Result<Vec<SearchResult>, String>;


// ============ mini_program.rs (新建) ============

/// 获取某 Agent 的小程序列表
#[tauri::command]
async fn list_mini_programs(
    agent_hash: String,
) -> Result<Vec<MiniProgramEntry>, String>;

/// 打开小程序窗口
#[tauri::command]
async fn open_mini_program(
    agent_hash: String,
    app_id: String,
    app: AppHandle,
) -> Result<(), String>;


// ============ qr_upload.rs (新建) ============

/// 启动临时 HTTP server 并返回二维码数据 URL
#[tauri::command]
async fn start_qr_upload_server() -> Result<QrUploadSession, String>;

/// 停止临时 HTTP server
#[tauri::command]
async fn stop_qr_upload_server(session_id: String) -> Result<(), String>;

/// 检查是否有新上传的文件
#[tauri::command]
async fn check_uploaded_files(session_id: String) -> Result<Vec<UploadedFile>, String>;


// ============ VFS 命令（现有 file_ops.rs 扩展）============

/// 列出 VFS 目录
#[tauri::command]
async fn list_vfs_directory(
    agent_hash: String,
    path: String,
) -> Result<Vec<FileEntryInfo>, String>;

/// 读取 VFS 文件内容
#[tauri::command]
async fn read_vfs_file(
    agent_hash: String,
    path: String,
) -> Result<String, String>;


// ============ mcp.rs (新建) ============

/// 列出已配置的 MCP Server
#[tauri::command]
async fn list_mcp_servers() -> Result<Vec<McpServerConfig>, String>;

/// 启动 MCP Server
#[tauri::command]
async fn start_mcp_server(name: String) -> Result<(), String>;

/// 停止 MCP Server
#[tauri::command]
async fn stop_mcp_server(name: String) -> Result<(), String>;
```

### E.3 invoke_handler 注册

```rust
// lib.rs run() 函数内，invoke_handler 扩展为：
. invoke_handler(tauri::generate_handler![
    // 已有 settings
    settings::load_settings,
    settings::save_settings,
    settings::open_settings_window,
    settings::test_cloud_connection,
    settings::get_cloud_session,
    settings::cloud_login,
    settings::cloud_disconnect,
    settings::set_theme,
    settings::get_theme,
    settings::get_app_version,
    // 已有 file_ops
    file_ops::file_read,
    file_ops::file_write,
    file_ops::file_delete,
    // 已有 welcome
    welcome::check_first_launch,
    welcome::save_welcome_config,
    welcome::discover_well_known,
    welcome::open_welcome_window,
    // 聊天（扩展）
    chat::get_chat_history,
    chat::get_chat_history_for_agent,
    chat::append_chat_message,
    chat::clear_chat_history,
    chat::send_chat_message,
    chat::open_chat_window,
    chat::get_connection_status,
    chat::get_chat_history_path,
    chat::send_consent_response,
    chat::list_agents,
    chat::get_prompt_templates,
    chat::save_prompt_templates,
    chat::save_temp_image,
    // 群聊（新建）
    group::create_group,
    group::list_groups,
    group::get_group_messages,
    group::send_group_message,
    group::delete_group,
    group::update_group,
    // 朋友圈（新建）
    moments::get_group_moments,
    moments::get_all_moments,
    moments::post_moment,
    // 搜索（新建）
    search::global_search,
    // 小程序（新建）
    mini_program::list_mini_programs,
    mini_program::open_mini_program,
    // 扫码上传（新建）
    qr_upload::start_qr_upload_server,
    qr_upload::stop_qr_upload_server,
    qr_upload::check_uploaded_files,
    // VFS（新建 / 扩展）
    file_ops::list_vfs_directory,
    file_ops::read_vfs_file,
    // MCP（新建）
    mcp::list_mcp_servers,
    mcp::start_mcp_server,
    mcp::stop_mcp_server,
])
```

### E.4 聊天历史格式变更

现有 `chat_history.json` 是全局单文件。V3 需要按 `agent_hash` 分文件：

```
# 现有（V2）:
~/.feclaw/chat_history.json

# V3 改为:
~/.feclaw/chats/
├── a1b2.json      # 数学老师的聊天记录
├── c3d4.json      # 英语老师的聊天记录
└── e5f6.json      # 编程助手的聊天记录
```

`ChatMessage` 结构不变，只是文件路径从 `chat_history.json` 变为 `chats/{agent_hash}.json`。

---

## F. 后端集成 (FeClaw 引擎改动)

### F.1 不做改动的部分

以下引擎能力**不需要修改**，Desktop 直接复用：

- `ChatService.chat()` — Agent 1:1 对话核心。群聊时 Desktop 并行调用多个 Agent 的 chat。
- `apps_service.py` — 小程序注册、路由、静态/代码/AI 三种 handler。Desktop 通过 iframe 嵌入。
- `virtual_filesystem.py` — VFS 命令系统。Desktop 文件管理器面板显示 VFS 目录树。
- `vector_search_service.py` — 向量搜索。Desktop 通过 `search_request` WS 消息调用。
- `llm_service.py` — LLM 提供者。无改动。
- `ShareReference` 模型 — `[reference:xxx]` 引用解析。Desktop 聊天直接使用。
- `auth.py` / JWT — 认证体系。Desktop 已集成。

### F.2 需要新增 / 修改

#### F.2.1 desktop_ws.py — 新增消息类型支持

```python
# routers/desktop_ws.py 的 handle_desktop_message() 新增分支

def handle_desktop_message(data: dict):
    msg_type = data.get("type")
    agent_hash = data.get("agent_hash")
    user_id = data.get("user_id")

    if msg_type == "consent_response":
        relay.resolve_consent(data["id"], data.get("decision"))
    elif msg_type == "pong":
        pass
    elif msg_type in ("file_read_response", "file_write_response", "file_delete_response"):
        relay.resolve_response(data["id"], data.get("payload", {}))

    # === V3 新增 ===
    elif msg_type == "search_request":
        # Desktop 请求语义搜索
        asyncio.create_task(handle_search_request(data, agent_hash))
    elif msg_type == "mini_program_launch":
        # Desktop 请求打开小程序（服务端验证 App 存在 + 返回入口 URL）
        asyncio.create_task(handle_mini_program_launch(data, agent_hash))
    elif msg_type == "mcp_tool_response":
        # Desktop 返回 MCP 工具执行结果
        relay.resolve_response(data["id"], data["payload"])
    elif msg_type == "group_chat_message":
        # 群聊消息：Desktop 已处理分发，Engine 仅转发给目标 Agent
        # （在群聊流程中，Desktop 对每个 Agent 单独发 chat_message，
        #  此消息类型实际不经过此 handler，而是在 chat WS 上直接发送）
        pass
```

#### F.2.2 desktop_relay.py — 新增搜索 + MCP 请求

```python
# services/desktop_relay.py 新增方法

class DesktopRelay:
    # ... 现有 pending, request_consent, request_file_* ...

    async def request_mcp_tool(
        self, tool_name: str, arguments: dict, agent_hash: str
    ) -> dict:
        """请求 Desktop 执行 MCP 工具调用"""
        if not self.is_desktop_connected():
            return {"error": "Desktop not connected", "status": "denied"}

        request_id = str(uuid.uuid4())
        future = asyncio.get_event_loop().create_future()
        self.pending[request_id] = future

        await send_to_desktop({
            "type": "mcp_tool_request",
            "id": request_id,
            "tool_name": tool_name,
            "arguments": arguments,
            "agent_hash": agent_hash,
            "timestamp": datetime.utcnow().isoformat(),
        })

        try:
            result = await asyncio.wait_for(future, timeout=60)
            return result
        except asyncio.TimeoutError:
            self.pending.pop(request_id, None)
            return {"error": "MCP tool execution timeout", "status": "timeout"}
```

#### F.2.3 main.py — 新增 Agent 列表 API

```python
# main.py 新增 REST 端点

@app.get("/api/desktop/agents")
async def list_agents_for_desktop(
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    返回当前用户的所有 Agent 列表，供 Desktop 构建侧边栏。
    注意：此端点仅在 DESKTOP_ENABLED=true 时注册。
    """
    agents = db.query(AgentProfile).filter(
        AgentProfile.user_id == current_user.id
    ).all()

    return [
        {
            "hash": a.hash,
            "name": a.name,
            "description": a.description,
            "status": a.status,
            "is_default": a.is_default,
            "created_at": a.created_at.isoformat() if a.created_at else None,
        }
        for a in agents
    ]

@app.get("/api/desktop/agents/{agent_hash}/vfs")
async def list_agent_vfs(
    agent_hash: str,
    path: str = "/",
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """列出 Agent VFS 目录（Desktop 文件管理器用）"""
    # 验证所有权
    agent = db.query(AgentProfile).filter(
        AgentProfile.hash == agent_hash,
        AgentProfile.user_id == current_user.id,
    ).first()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")

    from services.virtual_filesystem import VirtualFileSystem
    vfs = VirtualFileSystem(agent_hash=agent_hash)
    result = await vfs.list_dir(path)
    return result


@app.get("/api/desktop/agents/{agent_hash}/apps")
async def list_agent_apps(
    agent_hash: str,
    current_user = Depends(get_current_user),
):
    """列出 Agent 的小程序（Desktop 三 dot 菜单用）"""
    # 验证所有权...
    from services.apps_service import list_registered_apps
    apps = list_registered_apps(agent_hash)
    return [{"app_id": aid, **cfg} for aid, cfg in apps.items()]


@app.get("/api/desktop/agents/{agent_hash}/chat_history")
async def get_agent_chat_history(
    agent_hash: str,
    limit: int = 100,
    before: str = None,  # ISO timestamp for pagination
    current_user = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    返回 Agent 的聊天历史（从数据库 ChatHistory 表）。
    Desktop 可用此 API 恢复本地未存储的历史。
    """
    # 验证所有权...
    from models.database import ChatHistory
    query = db.query(ChatHistory).filter(
        ChatHistory.agent_hash == agent_hash,
        ChatHistory.user_id == current_user.id,
    ).order_by(ChatHistory.created_at.desc()).limit(limit)

    if before:
        query = query.filter(ChatHistory.created_at < before)

    messages = query.all()
    return [
        {
            "id": m.id,
            "role": m.role,
            "content": m.content,
            "timestamp": m.created_at.isoformat() if m.created_at else None,
            "agent_hash": m.agent_hash,
        }
        for m in reversed(messages)  # 返回时间正序
    ]
```

### F.3 不需要新增 REST 端点的情况

以下功能完全由 Desktop 本地处理，不需要新端点：
- 群聊创建/管理 → Desktop 本地 `groups.json`
- 朋友圈聚合 → Desktop 本地 `moments.json`
- 快捷模板 → Desktop 本地 `templates.json`
- 右键菜单 → Windows 注册表
- 扫码上传 → Desktop 临时 HTTP server
- 文件全盘索引 → Desktop 后台进程

### F.4 Auth 改进

#### F.4.1 JWT Token 刷新

Desktop 已通过 `ws.rs` 中的 `last_close_code()` 检测 4001/4002 并触发 `ShowCloudLogin`。改进点：

```rust
// engine.rs cloud_loop 内，在 token 即将过期时主动刷新
let token_exp = Self::decode_jwt_exp(&token);  // 新增
if let Some(exp) = token_exp {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    if exp < now + 3600 {  // 1小时内过期
        // 尝试刷新 token
        if let Ok(new_token) = Self::refresh_cloud_token(&shared_config).await {
            // 用新 token 重连
        }
    }
}
```

#### F.4.2 QR 码扫码登录（Phase 11）

远期可实现类似微信 Web 版的扫码登录流程：
1. Desktop 生成一个临时 session token
2. Display 二维码（img + session_id）
3. 轮询 `GET /api/auth/qr-check?session_id=xxx`
4. 用户在 FeClaw 控制台确认 → Server 绑定 JWT → Desktop 收到 token

---

## G. 系统集成

### G.1 Windows 右键菜单实现方案

#### G.1.1 技术方案

Windows 右键菜单有两种实现路径：

**路径 A：注册表静态注册（Phase 3 MVP）**

```rust
// src-tauri/src/right_click.rs
use winreg::enums::*;
use winreg::RegKey;

/// 注册右键菜单到 Windows Registry
pub fn register_context_menu(exe_path: &str) -> Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    // 所有文件 (*.*) 的右键菜单
    let all_files = hkcu.create_subkey(
        r"Software\Classes\*\shell\FeClaw.Reference"
    )?;
    all_files.0.set_value("", "📎 FeClaw 引用")?;
    all_files.0.set_value("Icon", &format!("{exe_path},0"))?;

    let cmd_ref = all_files.0.create_subkey("command")?;
    cmd_ref.0.set_value("", &format!(
        r#""{exe_path}" --right-click reference "%1""#,
    ))?;

    let all_files = hkcu.create_subkey(
        r"Software\Classes\*\shell\FeClaw.Send"
    )?;
    all_files.0.set_value("", "📤 FeClaw 发送")?;
    all_files.0.set_value("Icon", &format!("{exe_path},0"))?;

    let cmd_send = all_files.0.create_subkey("command")?;
    cmd_send.0.set_value("", &format!(
        r#""{exe_path}" --right-click send "%1""#,
    ))?;

    Ok(())
}

/// 从 Windows Registry 移除右键菜单
pub fn unregister_context_menu() -> Result<()> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    // 删除整个子键树
    hkcu.delete_subkey_all(r"Software\Classes\*\shell\FeClaw.Reference")?;
    hkcu.delete_subkey_all(r"Software\Classes\*\shell\FeClaw.Send")?;
    Ok(())
}
```

**路径 B：COM Shell Extension（远期优化）**
- 原生 C++ DLL，通过 `IShellExtInit` + `IContextMenu` 接口
- 优点：可以动态显示/隐藏菜单项、显示图标、支持多文件选择
- 缺点：复杂度高，需要 C++/winapi 开发

#### G.1.2 右键菜单行为

```rust
// main.rs 或 lib.rs 中处理 --right-click 参数
fn parse_args() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == "--right-click" {
        let action = &args[2];  // "reference" | "send"
        let file_path = &args[3];  // 文件的完整路径

        // 1. 确保 Desktop 主进程已运行（通过 Named Pipe 或 TCP 发送）
        // 2. 将操作加入当前活跃 Agent 的待发送队列
        // 3. 如果主窗口未打开，弹出系统通知
    }
}
```

#### G.1.3 文件关联

```rust
/// 可选：将 .md / .txt 关联到 FeClaw Desktop
pub fn register_file_associations() -> Result<()> {
    let exe = std::env::current_exe()?;
    let exe_str = exe.to_string_lossy();

    // .feclaw 自定义文件（引出 Agent 对话）
    let hkcu = winreg::RegKey::predef(HKEY_CURRENT_USER);
    let prog_id = hkcu.create_subkey(r"Software\Classes\FeClaw.Document")?;
    prog_id.0.set_value("", "FeClaw Document")?;

    let cmd = prog_id.0.create_subkey(r"shell\open\command")?;
    cmd.0.set_value("", &format!(r#""{exe_str}" --open "%1""#))?;

    let ext = hkcu.create_subkey(r"Software\Classes\.feclaw")?;
    ext.0.set_value("", "FeClaw.Document")?;

    Ok(())
}
```

### G.2 扫码上传 (文件传输助手替代方案)

#### G.2.1 技术架构

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Desktop App  │     │  Temporary HTTP   │     │  Mobile Phone │
│  (Rust)      │     │  Server (Rust)    │     │  (Browser)   │
│              │     │                   │     │              │
│  1. 生成 QR码 │────→│  localhost:19888  │     │              │
│     (data URL)│     │                   │     │              │
│              │     │  2. 手机扫码       │←────│ 扫描二维码    │
│              │     │  3. 打开网页       │────→│ 拍照 / 选照片 │
│              │     │  4. POST /upload   │←────│ 提交图片      │
│              │     │  5. 存入临时目录   │     │              │
│  6. 轮询检查  │←────│  GET /status       │     │              │
│  7. 拿到文件  │     │                   │     │              │
└──────────────┘     └──────────────────┘     └──────────────┘
```

#### G.2.2 Rust 实现概要

```rust
// src-tauri/src/qr_upload.rs

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use warp::Filter;
use qrcode::QrCode;
use image::Luma;
use base64::Engine;

pub struct QrUploadSession {
    pub id: String,
    pub url: String,
    pub qr_data_url: String,   // Base64 PNG for <img src="...">
    pub port: u16,
    pub uploaded_files: Arc<Mutex<Vec<UploadedFile>>>,
}

pub struct UploadedFile {
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
    pub mime_type: String,
}

pub async fn start_server() -> Result<QrUploadSession, String> {
    // 1. 找一个空闲端口
    let port = Config::find_free_port(19888)
        .ok_or("no free port for QR upload server")?;

    // 2. 生成 session ID 和 URL
    let session_id = uuid::Uuid::new_v4().to_string();
    let url = format!("http://192.168.1.100:{port}/upload/{session_id}");
    //   ^^^ 需要获取本机局域网 IP，用 local-ip-address crate

    // 3. 生成二维码 PNG
    let qr = QrCode::new(&url)
        .map_err(|e| format!("qr code: {e}"))?;
    let image = qr.render::<Luma<u8>>()
        .min_dimensions(300, 300)
        .build();
    let mut png_bytes = Vec::new();
    image.write_to(&mut Cursor::new(&mut png_bytes),
        image::ImageFormat::Png)
        .map_err(|e| format!("encode png: {e}"))?;
    let qr_data_url = format!(
        "data:image/png;base64,{}",
        BASE64_STANDARD.encode(&png_bytes)
    );

    // 4. 启动 HTTP server 后台任务
    let files = Arc::new(Mutex::new(Vec::new()));
    let files_clone = files.clone();

    tokio::spawn(async move {
        // 上传页面 HTML
        let upload_page = warp::path("upload")
            .and(warp::path::param::<String>())
            .and(warp::get())
            .map(|sid: String| {
                warp::reply::html(format!(r#"
                <!DOCTYPE html><html><head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <title>FeClaw 文件上传</title>
                </head><body>
                <h2>FeClaw Desktop 文件上传</h2>
                <input type="file" id="f" accept="image/*" capture="environment">
                <button onclick="upload()">上传</button>
                <p id="status"></p>
                <script>
                async function upload() {{
                    const f = document.getElementById('f').files[0];
                    if (!f) return;
                    const form = new FormData();
                    form.append('file', f);
                    const r = await fetch('/upload/{sid}',
                        {{method:'POST', body:form}});
                    const t = await r.text();
                    document.getElementById('status').textContent = t;
                }}
                </script></body></html>
                "#)))
            });

        // 文件接收端点
        let upload = warp::path("upload")
            .and(warp::path::param::<String>())
            .and(warp::post())
            .and(warp::multipart::form().max_length(50 * 1024 * 1024))
            .and_then(move |sid: String, form: warp::multipart::FormData| {
                let files = files_clone.clone();
                async move {
                    // 解析 multipart 并保存到 ~/.feclaw/uploads/{sid}/
                    let dir = Config::config_dir()
                        .join("uploads")
                        .join(&sid);
                    std::fs::create_dir_all(&dir).ok();

                    // ... multipart 解析逻辑 ...

                    Ok::<_, warp::Rejection>(
                        warp::reply::html("✅ 上传成功！可以关闭此页面。")
                    )
                }
            });

        warp::serve(upload_page.or(upload))
            .run(([127, 0, 0, 1], port))
            .await;
    });

    Ok(QrUploadSession {
        id: session_id, url, qr_data_url, port,
        uploaded_files: files,
    })
}
```

**依赖添加：**
```toml
# Cargo.toml 新增：
qrcode = "0.14"
image = "0.25"
warp = "0.3"                 # 轻量异步 HTTP 框架
# 或使用 axum 0.7 替代 warp（更符合现有 tokio 生态）
```

### G.3 系统托盘扩展

```rust
// tray.rs 扩展菜单项：
fn build_tray_menu(app: &AppHandle) -> Menu {
    // ... 现有项 ...

    // V3 新增：
    let file_index_status = MenuItem::with_id(app, "idx_status",
        "索引: 未启动", true, None::<&str>)?;  // 动态更新
    let sep3 = PredefinedMenuItem::separator(app)?;
    let settings_item = MenuItem::with_id(app, "settings",
        "设置...", true, None::<&str>)?;
    let right_click_item = CheckMenuItem::with_id(app, "right_click",
        "右键菜单", true, true, None::<&str>)?;

    // menu 包含：
    // ├─ 状态: Connected
    // ├─ 重新连接
    // ├─ 搜索... (Ctrl+K)
    // ├─ ─────────
    // ├─ ☑ 右键菜单
    // ├─ 索引: 1234 文件
    // ├─ 模式: ☑ 本地 / ☐ 云端
    // ├─ ─────────
    // ├─ 设置...
    // ├─ ─────────
    // └─ 退出
}
```

### G.4 文件全盘索引后台任务

```rust
// src-tauri/src/file_index.rs

use std::path::PathBuf;
use tokio::sync::mpsc;
use tokio::time::{interval, Duration};

pub struct FileIndexer {
    directories: Vec<PathBuf>,
    status_tx: mpsc::Sender<IndexerStatus>,
    cancel: tokio::sync::watch::Sender<bool>,
}

pub enum IndexerStatus {
    Idle,
    Scanning { current: PathBuf, files_done: u32 },
    Indexing { file: PathBuf, progress: f32 },
    Done { total_files: u32 },
}

impl FileIndexer {
    pub async fn run(&self) {
        let mut tick = interval(Duration::from_secs(5));
        // 低优先级后台任务
        tokio::select! {
            _ = self.full_index() => {}
            _ = self.cancel.subscribe() => {}
            _ = tick.tick() => {
                // 增量更新：检查文件变更
                self.incremental_update().await;
            }
        }
    }

    async fn full_index(&self) -> Result<()> {
        for dir in &self.directories {
            self.index_directory(dir).await?;
        }
        Ok(())
    }

    async fn index_directory(&self, dir: &Path) -> Result<()> {
        // 递归扫描，使用 WalkDir crate
        // 解析支持的文件格式：
        //   PDF  → pdf-extract / lopdf
        //   DOCX → docx-rs
        //   TXT  → 直接读取
        //   MD   → 直接读取
        //   代码 → 直接读取（.rs/.py/.js/.ts/.go...）
        // 使用 vectorscan (hyperscan) 或直接存文本片段
        // 向量化使用 ort (ONNX runtime) 加载轻量 embedding 模型
        unimplemented!()
    }
}
```

**依赖添加：**
```toml
# Cargo.toml 新增（全盘索引，Phase 10）：
walkdir = "2"
lopdf = "0.32"               # PDF 解析
docx-rs = "0.4"              # DOCX 解析
ort = "2"                    # ONNX Runtime (embedding 推理)
# 或直接用 HTTP 调 FeClaw 的 embed 接口
```

### G.5 MCP 协议集成

```rust
// src-tauri/src/mcp.rs

/// MCP Server 配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,        // "npx" / "python" / "uvx"
    pub args: Vec<String>,      // ["-y", "@modelcontextprotocol/server-filesystem"]
    pub env: HashMap<String, String>,
    pub enabled: bool,
}

/// MCP Client 管理器
pub struct McpManager {
    servers: Vec<McpServerConfig>,
    processes: HashMap<String, tokio::process::Child>,
    tools_cache: HashMap<String, Vec<McpTool>>,
}

impl McpManager {
    pub async fn start_server(&mut self, name: &str) -> Result<()> {
        // 1. 根据配置 spawn 子进程
        // 2. 通过 stdin/stdout JSON-RPC 通信
        // 3. 发送 initialize 请求
        // 4. 获取 tools/list
        // 5. 缓存工具列表
        unimplemented!()
    }

    pub async fn call_tool(
        &self,
        server: &str,
        tool: &str,
        args: serde_json::Value
    ) -> Result<serde_json::Value> {
        // 1. 构造 JSON-RPC tools/call 请求
        // 2. 发送到子进程 stdin
        // 3. 读取 stdout 响应
        // 4. 返回结果
        unimplemented!()
    }
}
```

---

## H. 实施阶段

### 阶段总览

```
Phase 0  ──→  Phase 1  ──→  Phase 2  ──→  Phase 3
(UI重构)      (体验增强)    (文件管理)     (右键菜单)
    │              │              │              │
    └──────────────┴──────────────┴──────┬───────┘
                                         │
                                    Phase 4 ──→ Phase 5 ──→ Phase 6
                                    (群聊)       (朋友圈)    (小程序)
                                         │
                                    Phase 7 ──→ Phase 8 ──→ Phase 9
                                    (搜索)       (扫码上传)   (MCP)
                                         │
                                    Phase 10 ──→ Phase 11
                                    (全盘索引)   (多模态PC)
```

---

### Phase 0 — 基础聊天 UI 重构 + 私聊

**目标：** 将现有的单 Agent 聊天窗口改造为「左侧 Agent 列表 + 右侧聊天窗口」的微信式布局。

**复杂度：** 中

**前置依赖：** 无（基于现有 master 分支）

**修改文件：**

| 文件 | 操作 | 改动说明 |
|------|------|---------|
| `src/chat/index.html` | **重写** | 从单聊天区域改为左侧栏 + 右侧聊天两栏布局 |
| `src/chat/chat.css` | **重写** | 新布局样式，Agent 列表样式，消息气泡样式 |
| `src/chat/chat.ts` | **重写** | 新增 Agent 列表渲染、选中切换、Tab 导航 |
| `src-tauri/src/chat.rs` | **修改** | 新增 `list_agents`、`get_chat_history_for_agent` 命令；聊天历史按 agent_hash 分文件 |
| `src-tauri/src/lib.rs` | **修改** | 注册新命令 |
| `src-tauri/src/ws_types.rs` | **扩展** | 新增 `chat_message` 的 `agent_hash` 字段 |

**实现要点：**

1. **Agent 列表获取：** 云模式调用 `GET /api/desktop/agents`，本地模式扫描 `~/.feclaw/agents/*.json`。
2. **聊天历史分离：** `chat_history.json` → `chats/{agent_hash}.json`。
3. **消息发送带上 agent_hash：** `send_chat_message` 增加 `agent_hash` 参数，构造 `chat_message` 时携带。
4. **流式回复关联 agent_hash：** `chat_reply` / `chat_event` 已携带 `agent` 字段，前端按此路由到正确的聊天窗口。
5. **搜索栏（⌘K）：** 在左侧栏放置搜索框（Phase 7 才接通后端，Phase 0 可以仅 UI 占位）。

**测试方式：**
- 手动验证：启动 Desktop，确认 Agent 列表正确加载
- 单元测试：`chat.rs` 的 `list_agents` 命令解析
- 集成测试：通过模拟 `chat_reply` JSON 验证前端路由到正确的 Agent Tab

---

### Phase 1 — 截图粘贴 + 快捷模板

**目标：** 支持 Ctrl+V 粘贴截图到聊天输入框，一键发送 Prompt 模板。

**复杂度：** 低

**前置依赖：** Phase 0

**修改文件：**

| 文件 | 操作 | 改动说明 |
|------|------|---------|
| `src/chat/chat.ts` | **修改** | 新增粘贴事件处理、图片预览、快捷模板栏 |
| `src/chat/chat.css` | **修改** | 图片预览样式、模板按钮栏样式 |
| `src/chat/index.html` | **修改** | 新增 `#template-bar`、`#rich-input` contenteditable |
| `src-tauri/src/chat.rs` | **新增命令** | `save_temp_image`、`get_prompt_templates`、`save_prompt_templates` |
| `src-tauri/src/lib.rs` | **修改** | 注册新命令 |

**实现要点：**

1. **粘贴处理：** 监听 `paste` 事件 → 检测 `image/*` MIME → 保存到 `~/.feclaw/uploads/temp/` → 插入缩略图到输入区 → 添加到附件列表。
2. **快捷模板：** 从 `templates.json` 加载 → 渲染为按钮 → 点击按钮填充 `#rich-input` 内容。
3. **内置模板：**
   - `总结要点` → "请用 3 个要点总结以下内容："
   - `翻译成英文` → "Please translate the following to English:"
   - `检查语法` → "请检查以下文本的语法错误并改正："
   - `改写成文言文` → "请将以下内容改写成文言文："
   - `解释代码` → "请解释以下代码的功能："
   - `优化代码` → "请优化以下代码："

**测试方式：**
- 手动测试：粘贴截图、点击模板按钮
- 快照测试：粘贴后的 DOM 状态

---

### Phase 2 — 三 dot 菜单 + 文件管理器

**目标：** Agent 右侧面板的 `⋮` 菜单，以及文件管理器窗口。

**复杂度：** 中

**前置依赖：** Phase 0（UI 框架存在），Phase 1（不强制但建议）

**修改/新建文件：**

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/chat/index.html` | **修改** | 新增 `#three-dot-panel` 下拉菜单 DOM |
| `src/chat/chat.ts` | **修改** | 三 dot 菜单点击处理、文件管理器窗口打开 |
| `src/chat/chat.css` | **修改** | 下拉菜单样式 |
| `src/file-manager/index.html` | **新建** | 文件管理器窗口 HTML |
| `src/file-manager/file-manager.css` | **新建** | 文件管理器样式 |
| `src/file-manager/file-manager.ts` | **新建** | 文件管理器逻辑 |
| `src-tauri/src/file_ops.rs` | **扩展** | 新增 `list_vfs_directory`、`read_vfs_file` 命令 |
| `src-tauri/src/lib.rs` | **修改** | 注册新命令 |

**实现要点：**

1. **三 dot 菜单：** 下拉菜单显示 4 个选项 + 分隔线 + 清空对话。
2. **文件管理器：** 新建 Tauri WebviewWindow "file-manager"，通过 `open` crate 的类比打开。左侧文件树（调用 `list_vfs_directory`），右侧文件详情。
3. **FeClaw 引擎端：** 新增 `GET /api/desktop/agents/{hash}/vfs?path=/` 端点（见 §F.2.3）。

**测试方式：**
- 手动测试：点击三 dot → 文件管理器 → 导航目录树 → 查看文件
- 网络测试：mock `list_vfs_directory` 返回值验证前端渲染

---

### Phase 3 — 右键引用/发送

**目标：** 在 Windows 资源管理器中右键文件选择「📎 FeClaw 引用」或「📤 FeClaw 发送」。

**复杂度：** 中

**前置依赖：** Phase 0（Desktop 基础运行），`winreg` crate

**修改/新建文件：**

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/src/right_click.rs` | **新建** | 右键注册/注销/命令处理 |
| `src-tauri/src/main.rs` | **修改** | 解析 `--right-click` CLI 参数 |
| `src-tauri/Cargo.toml` | **修改** | 添加 `winreg` 依赖 |
| `src-tauri/src/lib.rs` | **修改** | 调用注册/注销、IPC 路由 |
| `src/chat/chat.ts` | **修改** | 接收 IPC 消息，将文件添加到当前聊天 |

**依赖添加：**
```toml
winreg = "0.52"  # Windows Registry API
```

**实现要点：**

1. **注册时机：** 安装时或设置中手动开启（Settings → 常规 → ☑ 右键菜单）。
2. **命令行中继：**
   ```
   FeClaw-Desktop.exe --right-click reference "C:\Users\小明\document.pdf"
   ```
   如果主进程已在运行，通过 Named Pipe 发送文件路径。
   如果主进程未运行，先启动主进程，再中继。
3. **行为区别：**
   - **引用：** 构造消息 `"请分析文件：/mnt/desktop/C:/Users/小明/document.pdf"`。Agent 可通过 Desktop 中继读写该文件。
   - **发送：** 先复制文件到 VFS `agents/{hash}/uploads/`，构造消息 `"我发了一个文件：/workspace/uploads/document.pdf"`。本地文件不变。

**安全关注点：** 路径遍历检测（已在 `file_bridge.rs` 中实现）。

**测试方式：**
- 手动测试：右键文件 → 选择菜单 → 验证 Desktop 收到文件路径
- 单元测试：`right_click.rs` 的注册表操作
- 安全测试：尝试遍历路径（`../../etc/passwd`）

---

### Phase 4 — 群聊功能

**目标：** 用户创建群，拉多个 Agent，发一条消息所有 Agent 收到。

**复杂度：** 高

**前置依赖：** Phase 0（UI 框架 + Agent 列表）

**新建/修改文件：**

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/src/group.rs` | **新建** | 群聊 Group/GroupMessage 结构 + 所有群聊命令 |
| `src/chat/index.html` | **修改** | 左侧栏新增群聊 Tab |
| `src/chat/chat.ts` | **修改** | 群聊 UI 逻辑、并行消息发送 |
| `src/chat/chat.css` | **修改** | 群聊消息气泡（显示发送者 Agent 名称） |
| `src-tauri/src/ws.rs` | **修改** | `chat_reply` 处理增加 `group_id` 路由 |
| `src-tauri/src/lib.rs` | **修改** | 注册群聊命令 |

**实现要点：**

1. **群聊消息模型：** `GroupMessage` 包含 `group_id`、`sender`、`sender_name`、`mentions`、`reply_to`（见 §B.1.1）。
2. **广播机制：**
   ```rust
   async fn send_group_message(group_id, content, mentions, attachments, state) {
       let group = load_group(&group_id)?;
       let recipients = if mentions.is_empty() {
           &group.members  // 发给所有群成员
       } else {
           &mentions       // 只发给 @的 Agent
       };

       // 并行发送
       let tasks: Vec<_> = recipients.iter().map(|agent_hash| {
           let envelope = build_chat_message(content, agent_hash, &attachments);
           let tx = state.ws_outgoing.clone();
           tx.send(serde_json::to_string(&envelope).unwrap())
       }).collect();
       futures::future::join_all(tasks).await;

       // 持久化本地
       persist_group_message(&group_id, msg).await;
   }
   ```
3. **消息排序：** 所有 Agent 回复通过 `chat_reply` / `chat_event` 回传，附带 `group_id`。Desktop 在收到回复时打时间戳，按时间排序推送到群聊窗口。
4. **@提及处理：** 输入框支持 `@Agent名`，转换为 `mentions: [agent_hash]`。被 @的 Agent 在其 system prompt 中注入 "用户正在@你" 的提示。

**测试方式：**
- 手动测试：创建群 → 发送消息 → 验证所有 Agent 收到 → 验证回复按时间排列
- 单元测试：`group.rs` 的 CRUD 命令
- 集成测试：模拟 3 个 Agent 回复，验证消息排序

---

### Phase 5 — 朋友圈（群内动态墙）

**目标：** 群内 Agent 的产出自动展示为朋友圈动态。

**复杂度：** 中

**前置依赖：** Phase 4（群聊存在）

**新建/修改文件：**

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/src/moments.rs` | **新建** | Moment 结构 + 朋友圈命令 |
| `src/chat/index.html` | **修改** | 左侧栏朋友圈 Tab 内容 |
| `src/chat/chat.ts` | **修改** | 朋友圈 UI 展示 |
| `src/chat/chat.css` | **修改** | 朋友圈卡片样式 |
| `src-tauri/src/ws.rs` | **修改** | 接收 `moments_event` 消息 |
| `src-tauri/src/ws_types.rs` | **扩展** | 新增 `MomentsEvent` 反序列化 |
| `/home/lch/Projects/FeClaw/routers/desktop_ws.py` | **修改** | 新增 `moments_event` 消息发送 |

**实现要点：**

1. **事件生成：** Agent 完成以下操作时，FeClaw 引擎发送 `moments_event`：
   - `file_write` 完成 → `FileChanged` 事件
   - Agent 执行完工具调用 → `TaskCompleted` 事件
   - Agent 输出分析/报告 → `AnalysisReport` 事件（通过启发式检测消息长度和结构）

2. **FeClaw 引擎端改动：**
   ```python
   # services/agent_executor.py 或 agent_tools_service.py
   async def _emit_moments_event(agent_hash, kind, content, data=None):
       if relay.is_desktop_connected():
           await send_to_desktop({
               "type": "moments_event",
               "agent_hash": agent_hash,
               "kind": kind,
               "content": content,
               "data": data or {},
               "timestamp": datetime.utcnow().isoformat(),
           })
   ```

3. **Desktop 端匹配 Agent 到群：** moments_module 加载所有 Group，反向查找 `members.contains(&agent_hash)`，只为该群的朋友圈写入。

4. **安全：** 朋友圈只展示，不触发任何文件操作。Agent 发朋友圈不带有操作权限。

**测试方式：**
- 手动测试：在群聊中交互，切换到朋友圈 Tab 验证动态出现
- 单元测试：`moments.rs` 的读取/写入

---

### Phase 6 — 小程序入口

**目标：** 展示 Agent 自部署的 App（单词本、画板等）。

**复杂度：** 低

**前置依赖：** Phase 2（三 dot 菜单存在）

**新建/修改文件：**

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/src/mini_program.rs` | **新建** | MiniProgram 结构 + 命令 |
| `src/mini-program/index.html` | **新建** | 小程序 iframe 窗口 |
| `src/mini-program/mini-program.ts` | **新建** | 小程序列表 + 启动逻辑 |
| `src/chat/chat.ts` | **修改** | 三 dot 菜单 → 小程序入口 |

**实现要点：**

1. **小程序列表从引擎获取：** `GET /api/desktop/agents/{hash}/apps`。
2. **启动小程序：** `open_mini_program` 命令创建一个新的 WebviewWindow，URL 为引擎的小程序地址：
   ```
   https://{agent_hash}.feclaw.lizidaren.cn/apps/{app_id}/
   ```
   本地模式则为：
   ```
   http://127.0.0.1:{port}/apps/{app_id}/
   ```
3. **无引擎改动：** 完全复用 `apps_service.py` 已有功能。

**测试方式：**
- 手动测试：在引擎中注册一个 App → Desktop 打开小程序列表 → 点击启动

---

### Phase 7 — 搜一搜

**目标：** ⌘K 全局语义搜索，跨 Agent 聊天记录、文件、朋友圈。

**复杂度：** 中

**前置依赖：** Phase 0（UI 框架）

**新建/修改文件：**

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/src/search.rs` | **新建** | Search 命令（聚合多源结果） |
| `src/chat/index.html` | **修改** | `#tab-search` 内 ⌘K 搜索框 |
| `src/chat/chat.ts` | **修改** | 搜索 UI 交互 |
| `src-tauri/src/ws.rs` | **修改** | 发送 `search_request`，接收 `search_response` |
| `src-tauri/src/ws_types.rs` | **扩展** | 新增 SearchRequest / SearchResponse 类型 |
| `/home/lch/Projects/FeClaw/routers/desktop_ws.py` | **修改** | 新增 `search_request` 处理 |

**实现要点：**

1. **搜索策略：**
   - Agent 搜索：通过 WS 发送 `search_request` → Engine 调用 `VectorSearchService.search()`。
   - 本地搜索：Desktop 自己遍历 `chat_history.json`、`groups/*.json`、文件名。
   - 全盘搜索（Phase 10）：从本地向量库检索。

2. **⌘K 快捷键：**
   ```typescript
   document.addEventListener('keydown', (e) => {
     if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
       e.preventDefault();
       switchToSearchTab();
       $('#search-input').focus();
     }
   });
   ```

3. **搜索结果可跳转：** 点击结果 → 如果 `source_kind == "file"` → 打开文件管理器并导航到目标文件；如果是 `chat_message` → 跳转到聊天窗口并滚动到对应消息。

**测试方式：**
- 手动测试：⌘K → 输入查询 → 验证结果
- 模拟测试：mock `search_response` JSON 验证 UI 渲染

---

### Phase 8 — 扫码拍照上传

**目标：** 生成二维码 → 手机扫码 → 拍照/选择照片 → 上传到 Desktop。

**复杂度：** 中

**前置依赖：** Phase 0（UI 框架）

**新建/修改文件：**

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/src/qr_upload.rs` | **新建** | QR 生成 + 临时 HTTP server |
| `src/qr-upload/index.html` | **新建** | 二维码弹窗 |
| `src/chat/chat.ts` | **修改** | 📱 按钮 → 打开二维码弹窗 |
| `src-tauri/Cargo.toml` | **修改** | 添加 `qrcode`, `image`, `axum`/`warp` 依赖 |
| `src-tauri/src/lib.rs` | **修改** | 注册上传命令 |

**依赖：**
```toml
qrcode = "0.14"
image = "0.25"
axum = "0.7"                # HTTP server
tower = "0.4"
local-ip-address = "0.6"    # 获取本机局域网 IP
```

**实现要点：**

1. **临时 HTTP Server：**
   - 绑定 `0.0.0.0:{port}`，使手机可访问
   - 提供两个路由：`GET /upload/:session_id`（拍照页面）、`POST /upload/:session_id`（接收文件）
   - 上传完成后 `shutdown`。

2. **安全：**
   - Session ID 是一次性随机 token（防止未授权上传）
   - Session 5 分钟过期自毁
   - 仅接受 `image/*` MIME 类型
   - 最大 50MB 文件限制

**测试方式：**
- 手动测试：Desktop 生成 QR → 手机扫码 → 拍照上传 → Desktop 收到文件

---

### Phase 9 — 本地 MCP 接入

**目标：** Desktop 启动本地 MCP Server → Agent 可通过 Desktop 中继调用 MCP 工具。

**复杂度：** 高

**前置依赖：** Phase 0（Desktop 基本运行）

**新建/修改文件：**

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/src/mcp.rs` | **新建** | MCP Client 管理、JSON-RPC 通信 |
| `src/settings/mcp-config.html` | **新建** | MCP Server 配置页面 |
| `src-tauri/src/ws.rs` | **修改** | 接收 `mcp_tool_request`，发送 `mcp_tool_response` |
| `src-tauri/src/ws_types.rs` | **扩展** | 新增 MCP 消息类型 |
| `/home/lch/Projects/FeClaw/services/desktop_relay.py` | **修改** | 新增 `request_mcp_tool()` 方法 |
| `/home/lch/Projects/FeClaw/routers/desktop_ws.py` | **修改** | 新增 `mcp_tool_response` 处理 |
| `src-tauri/Cargo.toml` | **修改** | 添加 `serde_json`（已有） |

**实现要点：**

1. **MCP 进程管理：** 类似 `engine.rs` 的子进程管理，通过 stdin/stdout JSON-RPC 2.0 协议通信。
2. **工具发现：** 启动时发送 `tools/list` 请求，缓存工具列表。
3. **工具中继：**
   ```
   Agent 调用 MCP 工具
     → Engine: relay.request_mcp_tool(tool_name, args)
     → WS: mcp_tool_request → Desktop
     → Rust McpManager: 转发到 MCP Server 子进程
     → MCP Server 执行 → 返回结果
     → WS: mcp_tool_response → Engine
     → Engine 将结果返回给 Agent
   ```
4. **安全：** Desktop 弹窗确认每次 MCP 工具调用（与 `command_exec_request` 相同的同意机制）。

**测试方式：**
- 单元测试：McpManager 的 JSON-RPC 解析
- 集成测试：启动 filesystem MCP Server → Agent 请求读取文件 → 验证结果

---

### Phase 10 — 本地文件全盘索引

**目标：** 后台低优先级扫描用户目录，向量化文档，支持全盘语义搜索。

**复杂度：** 高

**前置依赖：** Phase 7（搜索 UI）

**新建文件：**

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/src/file_index.rs` | **新建** | 文件扫描、解析、索引核心逻辑 |
| `src-tauri/src/file_index/` | **新建目录** | 子模块 |
| `src-tauri/src/file_index/walker.rs` | **新建** | 目录遍历 |
| `src-tauri/src/file_index/parser.rs` | **新建** | 文件解析（PDF/DOCX/TXT/MD/代码） |
| `src-tauri/src/file_index/embedder.rs` | **新建** | 向量化（调用 FeClaw 引擎 embed 端点或本地 ONNX） |
| `src-tauri/src/file_index/store.rs` | **新建** | 本地向量库（usearch 或 lance） |
| `src-tauri/Cargo.toml` | **修改** | 添加 `walkdir`, `lopdf`, `docx-rs`, `usearch`/`lancedb` |

**实现要点：**

1. **扫描策略：** 低优先级（`tokio::task::spawn_blocking` + `thread::sleep` 节流），每 5 秒索引一个文件。
2. **支持格式：** PDF, DOCX, TXT, MD, .rs, .py, .js, .ts, .go, .java, .cpp, .html, .css。
3. **向量化方案：** 通过 HTTP 调用 FeClaw 引擎的 `/api/embed` 端点（如果有），或使用 ONNX 运行 MiniLM 等轻量模型。
4. **增量更新：** 记录文件哈希，只重新索引变更的文件。

**测试方式：**
- 手动测试：索引一个小目录，验证搜索返回正确结果

---

### Phase 11 — 多模态操控 PC（远期探索）

**目标：** Agent 可请求 Desktop 截图 → 分析 → 请求鼠标/键盘操作。

**复杂度：** 极高

**前置依赖：** Phase 9（MCP 接入）

**说明：** 这是远期探索功能，不在 V3 核心范围内。仅在 `vision.md` 中提及，实施计划不详述，但预留架构扩展点：
- `screen_capture_request` / `screen_capture_response` WS 消息类型
- `input_action_request` / `input_action_response` WS 消息类型
- 三级安全权限（旁观/指点/操控）

---

### 文件创建/修改总览

| 阶段 | Rust 新建 | Rust 修改 | HTML 新建 | HTML 修改 | Python 修改 |
|:----:|-----------|-----------|-----------|-----------|-------------|
| 0 | 0 | 3 | 0 | 3 | 0 |
| 1 | 0 | 2 | 0 | 2 | 0 |
| 2 | 0 | 2 | 3 | 2 | 1 |
| 3 | 1 | 2 | 0 | 1 | 0 |
| 4 | 1 | 3 | 0 | 2 | 0 |
| 5 | 1 | 2 | 0 | 2 | 2 |
| 6 | 1 | 1 | 2 | 0 | 0 |
| 7 | 1 | 2 | 0 | 1 | 1 |
| 8 | 1 | 1 | 1 | 1 | 0 |
| 9 | 1 | 2 | 1 | 0 | 2 |
| 10 | 4 | 0 | 0 | 0 | 0 |
| 11 | — | — | — | — | — |

**Rust 新增模块：** `group.rs`, `moments.rs`, `mini_program.rs`, `search.rs`, `right_click.rs`, `qr_upload.rs`, `mcp.rs`, `file_index.rs` + 3 子模块。

**Rust 修改模块：** `chat.rs`, `ws.rs`, `ws_types.rs`, `lib.rs`, `config.rs`, `main.rs`, `tray.rs`, `file_ops.rs`, `Cargo.toml`。

**Python 修改模块：** `desktop_ws.py`, `desktop_relay.py`, `main.py`, `agent_executor.py`。

---

## I. 风险与缓解

### I.1 安全风险

| 风险 | 等级 | 缓解措施 |
|------|:----:|---------|
| **MCP 工具注入** — Agent 可能通过 MCP 中继调用危险工具 | 🔴 高 | 每个 MCP 工具调用弹窗确认（复用 ConsentManager）；可配置工具白名单；默认禁用所有 MCP 工具 |
| **右键菜单路径遍历** — 恶意文件名可能绕过路径检查 | 🔴 高 | 复用 `file_bridge::resolve_desktop_path` 的路径遍历防护；只能传绝对路径或 `~/Desktop/` 下的相对路径 |
| **剪贴板数据泄露** — 粘贴敏感图片到 Agent | 🟡 中 | 粘贴前显示预览缩略图，用户确认后发送；不在 Desktop 本地缓存明文图片超过 1 小时 |
| **群聊消息跨 Agent 泄露** — 非 @的 Agent 也应看到上下文 | 🟡 中 | Desktop 群聊设计为「所有成员都能看到所有消息」；如需要私聊，直接 1:1 chat |
| **临时 HTTP server 暴露** — 扫码上传的 HTTP server 无认证 | 🟡 中 | 一次性 session token；5 分钟过期；只接受图片类型；绑定本机（`0.0.0.0` 仅限局域网共享场景）；可配置仅 127.0.0.1 + QR 用 ngrok |
| **全盘索引隐私** — 索引用户所有文件 | 🔴 高 | 仅索引用户显式指定的目录；本地索引，数据不出 Desktop；可随时删除索引数据；默认不启用 |

### I.2 Windows 特定边界情况

| 情况 | 影响 | 处理 |
|------|------|------|
| **路径大小写** — Windows NTFS 大小写不敏感 | `resolve_desktop_path` 比对 | 使用 `.to_lowercase()` 比对 |
| **驱动器字母不存在** — `D:\data` 但只有 C 盘 | `file_bridge` 报错 | 返回明确错误信息，不静默失败 |
| **UNC 路径** — `\\server\share\file` | 不支持 | 明确拒绝并记录日志（已有 N-16 注释） |
| **注册表权限** — 右键菜单注册需要 HKCU 写入 | 安装时可能被 UAC 阻止 | 提供设置中的「注册/注销」按钮；注册失败时提示用户手动操作 |
| **防火墙** — 扫码上传 HTTP server 可能被 Windows 防火墙拦截 | 手机无法连接 | QR 弹窗中显示提示：「请确保 Windows 防火墙允许此连接」 |

### I.3 与 V2 开发的并行冲突

当前 V2 正在开发中（`v2-plan.md` 中的 Phase 0-4）。V3 开发需要注意以下冲突：

| V2 文件 | V3 改动 | 冲突风险 |
|---------|---------|:--------:|
| `chat.rs` | **重写** — 从单 Agent 改为多 Agent 模式 | 🔴 高 |
| `ws.rs` | **扩展** — 新增消息类型处理 | 🟡 中 |
| `ws_types.rs` | **扩展** — 新增 V3 消息类型 | 🟡 中 |
| `lib.rs` | **扩展** — 注册新命令 | 🟡 中 |
| `config.rs` | **扩展** — 新增字段 | 🟢 低 |
| `tray.rs` | **扩展** — 新增菜单项 | 🟢 低 |
| `file_bridge.rs` | 不变 | 🟢 无 |
| `engine.rs` | 不变 | 🟢 无 |
| `consent.rs` | 不变 | 🟢 无 |

**建议合并策略：**
1. **先完成 V2 Phase 0-4**（依赖 + 设置 + 文件中继 + 自启 + 云模式），确保基础稳定。
2. **V3 Phase 0 在 V2 稳定后开始**，以 `chat.rs` 的大重构为核心。
3. **V3 新增模块**（`group.rs`, `moments.rs` 等）可在 V2 开发期间并行设计，因为它们与 V2 代码无交集。

### I.4 性能风险

| 风险 | 缓解 |
|------|------|
| **群聊并发 WS 连接数** — 每个 Agent 一个 WS，群越大连接越多 | 单 WS 连接 + `agent_hash` 路由（Desktop 已有设计）；不需要多连接 |
| **`chat_history.json` 文件过大** — 长期使用后可能达到数 MB | 按 agent 分文件；每次读取限制最近 500 条消息；长期考虑 SQLite 迁移 |
| **全盘索引 CPU 占用** — 扫描大目录时影响系统性能 | 低优先级线程 + 节流（每 5 秒一个文件）；文件系统变更监听做增量更新 |
| **前端内存** — 多个聊天窗口同时展示大量消息 | 虚拟滚动（`content-visibility: auto`）；分页加载历史消息 |

### I.5 架构风险

| 风险 | 缓解 |
|------|------|
| **Server 端群聊概念缺失** — Desktop 独自聚合，Server 不理解群聊上下文 | 每个 Agent 的 system prompt 中注入群名 + 成员列表，Agent 可以感知群聊上下文 |
| **朋友圈事件生成不可靠** — 无法准确检测所有「Agent 产出」 | 提供用户手动发布入口；Agent 可通过 remark 命令 `![moments]消息内容` 主动发布 |
| **小程序嵌入 iframe 跨域** — Tauri WebView 加载远程 URL | 使用 `tauri://localhost` scheme；先确保引擎配置 CORS 正确 |
| **二维码上传 HTTP 端口冲突** — 默认端口已被占用 | 自动端口探测（复用 `find_free_port`） |

---

## 附录：关键文件清单

### A. V3 新增 Rust 源文件清单

```
src-tauri/src/
├── group.rs              # Phase 4 — 群聊模型 + 命令
├── moments.rs            # Phase 5 — 朋友圈模型 + 命令
├── mini_program.rs       # Phase 6 — 小程序模型 + 命令
├── search.rs             # Phase 7 — 搜索聚合
├── right_click.rs        # Phase 3 — 右键菜单
├── qr_upload.rs          # Phase 8 — 扫码上传
├── mcp.rs                # Phase 9 — MCP Client
└── file_index/
    ├── mod.rs            # Phase 10 — 文件索引入口
    ├── walker.rs         # Phase 10 — 目录遍历
    ├── parser.rs         # Phase 10 — 文件解析
    ├── embedder.rs       # Phase 10 — 向量化
    └── store.rs          # Phase 10 — 向量存储
```

### B. V3 新增前端文件清单

```
src/
├── file-manager/
│   ├── index.html        # Phase 2
│   ├── file-manager.css  # Phase 2
│   └── file-manager.ts   # Phase 2
├── mini-program/
│   ├── index.html        # Phase 6
│   └── mini-program.ts   # Phase 6
├── qr-upload/
│   └── index.html        # Phase 8
└── settings/
    └── mcp-config.html   # Phase 9
```

### C. V3 需要修改的前端文件清单

```
src/chat/
├── index.html            # Phase 0,1,2,4,5,7 — 渐进改造
├── chat.css              # Phase 0,1,2,4,5,7 — 渐进扩展
└── chat.ts               # Phase 0,1,2,4,5,7,8 — 渐进扩展
```

---

> **本计划基于 vision.md v3、design.md v1、v2-plan.md v3（二审修复版）以及完整的现有代码审计编写。**
>
> 每个 Phase 的实现者只需阅读本文件和对应阶段的源码文件即可开始开发。
