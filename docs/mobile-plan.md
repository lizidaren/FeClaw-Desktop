# FeClaw Mobile — 设计规划

> 移动端定位：**纯 Thin Client**，仅做聊天显示 + 输入（文字/图片/语音）+ 推送通知。
> Agent 全部运行在云端，移动端不执行命令、不读写本地文件系统。
> 移动端独有的系统能力通过 Tauri Plugin 暴露给 Agent 调用。

---

## 一、架构

```
┌─────────────────────────────────────────────┐
│  FeClaw Mobile (Tauri 2)                     │
│                                              │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐   │
│  │ 前端 UI │  │ Rust 层  │  │ 原生插件  │   │
│  │         │  │          │  │           │   │
│  │ 聊天    │  │ ws.rs    │  │ Calendar  │   │
│  │ Agent   │  │ config   │  │ Contacts  │   │
│  │ 列表    │  │ auth     │  │ Camera    │   │
│  │ 设置    │  │ http_cli │  │ Push      │   │
│  │ 搜索    │  │ ...      │  │ ShareExt  │   │
│  └────┬────┘  └────┬─────┘  └─────┬─────┘   │
│       │             │              │          │
│       └──────┬──────┴──────┬──────┘          │
│              │             │                  │
│         WebSocket      HTTP/API               │
└──────────────┼─────────────┼──────────────────┘
               │             │
               ▼             ▼
       feclaw.lizidaren.cn (云端 Engine)
```

**共享代码（已有，不用改）：** `ws.rs`, `http_client.rs`, `config.rs`, `auth.rs`, `chat.rs`, `group.rs`, `moments.rs`, `search.rs`, `ws_types.rs`, `types.rs`

**移动端新增：** 原生插件目录 `src-mobile/plugins/`

**Desktop-only（移动端不编译）：** `alt_space.rs`, `right_click.rs`, `tray.rs`, `autostart.rs`, `executor.rs`, `file_bridge.rs`, `file_index.rs`, `file_ops.rs`, `engine.rs`, `local_setup.rs`

---

## 二、移动端特有的系统能力（Agent 可调用）

通过 Tauri Plugin 暴露给 Rust 层，Rust 命令再暴露给 Agent（走 WS 工具调用）。

### P0 — 聊天体验（与 Desktop 一致）

| 能力 | 实现 | 依赖 |
|:----|:-----|:-----|
| 文字聊天 | 复用现有 WS 链路 | 已有 |
| 图片发送 | 系统相册/拍照 → WS 上传 | Tauri camera plugin |
| 语音输入 | 系统语音识别 → 文字发送 | Tauri speech plugin |
| 推送通知 | Agent 有响应时通知 | APNs / FCM |
| 消息历史 | WS 消息拉取 + 本地 SQLite 缓存 | 已有 |

### P1 — 系统能力 Agent 工具

| 工具 | Agent 可用操作 | 移动端 API |
|:----|:-------------|:----------|
| 📅 **CalendarTool** | 查今天日程、创建提醒、查空闲时间 | `EventKit` (iOS) / `CalendarContract` (Android) |
| 👤 **ContactsTool** | 查联系人信息（姓名/电话）| `Contacts` framework (iOS) / `ContactsContract` (Android) |
| 📸 **CameraTool** | 拍照分析、OCR | 系统相机 API |
| 📍 **LocationTool** | 查询当前位置（授权后） | CoreLocation / Fused Location |
| 🔔 **NotificationTool** | Agent 完成长任务后推通知 | APNs / FCM |
| 📎 **ShareExtTool** | 从其他 App 接收内容（分享到 FeClaw）| Share Extension / Intent |

### P2 — 增强

| 能力 | 说明 |
|:----|:------|
| **Widget** | 主屏幕小组件显示 Agent 消息预览 |
| **Shortcuts** | Siri Shortcuts / Android shortcuts 快速发消息 |
| **Voice** | Hey Siri/OK Google 触发 Agent |
| **Clipboard** | Agent 读取/写入剪贴板 |

---

## 三、权限模型

```
Agent 调用移动端原生工具：
  ┌─────────────────────────────────────┐
  │  用户授权（系统权限层）              │
  │  第一次使用时系统弹窗：              │
  │  "FeClaw 想访问你的日历"             │
  │  [允许] [不允许]                     │
  └─────────────────────────────────────┘
                     ↓
  ┌─────────────────────────────────────┐
  │  Agent 调用（应用内确认层）          │
  │  "通讯录Agent 想读取你的联系人以     │
  │   查找张经理的电话，是否允许？"       │
  │  [允许本次] [拒绝] [总是允许]        │
  └─────────────────────────────────────┘
```

双层：系统权限（iOS/Android 原生） + 应用内确认（用户知道 Agent 要干什么）。

---

## 四、实现阶段

### Phase 0 — 基础聊天 App（2-3 天）

| 任务 | 产出 |
|:----|:-----|
| 提取共享 Rust 代码到 `common/` | 编译零错误 |
| 用 feature gate 包 Desktop-only 模块 | Desktop 正常编译 |
| 初始化 Tauri 2 mobile 项目 | `cargo tauri ios dev` 能跑 |
| 移植前端（底部 Tab + 聊天列表 + 聊天窗口）| 能登录、聊天 |
| WS 连接 + 心跳 | 消息实时推送 |
| JWT 存储（iOS Keychain / Android Keystore）| 安全持久化 |

### Phase 1 — 聊天增强（1-2 天）

| 任务 | 说明 |
|:----|:------|
| 图片发送 | 相册选图 + 拍照 |
| 推送通知 | APNs + FCM 配置 |
| 离线消息缓存 | SQLite 缓存历史 |

### Phase 2 — 系统能力 Agent 工具（2-3 天）

| 工具 | Tauri Plugin | ETA |
|:----|:------------|:---:|
| CalendarTool | `tauri-plugin-calendar` 或自写 | 半天 |
| ContactsTool | 同上 | 半天 |
| CameraTool | Tauri 内置 camera plugin | 已有 |
| LocationTool | `tauri-plugin-geolocation` | 半天 |
| PushTool | `tauri-plugin-push` | 半天 |

### Phase 3 — 增强体验（可选）

| 功能 | 复杂度 |
|:----|:------:|
| Share Extension | ⭐⭐ |
| Widget | ⭐⭐⭐ |
| Siri Shortcuts | ⭐⭐ |
| Voicemail | ⭐⭐ |

---

## 五、现在就要做的准备

**改动最小、收益最大的 3 件事：**

### 1. Feature gate Desktop-only 模块（30 分钟）

```toml
[features]
default = ["desktop"]
desktop = ["tray-icon", "global-shortcut", ...]
mobile = []
```

用 `#[cfg(feature = "desktop")]` 包裹 `alt_space`、`right_click`、`tray`、`autostart`、`executor`、`file_bridge`、`file_index`、`file_ops`、`engine`、`local_setup`。

### 2. 提取共享代码目录结构（30 分钟）

```
src/
  common/    ← ws, http_client, config, auth, chat, group, moments, search, ws_types, types
  desktop/   ← alt_space, right_click, tray, autostart, executor, file_bridge, file_index, file_ops, engine, local_setup
  mobile/    ← 暂空，未来放移动端插件
```

### 3. 移动端原生插件设计模式（现在定好接口）

```rust
// 移动端 Agent 工具的标准接口
#[cfg_attr(mobile, tauri::command)]
pub async fn calendar_query_today() -> Result<Vec<CalendarEvent>, String> {
    // iOS: EventKit
    // Android: CalendarContract
}

#[cfg_attr(mobile, tauri::command)]
pub async fn contact_search(name: String) -> Result<Vec<Contact>, String> {
    // iOS: Contacts framework
    // Android: ContactsContract
}
```

---

## 六、不建议做的事

| 事 | 原因 |
|:---|:------|
| ❌ 移动端执行 shell 命令 | iOS 无 shell，Android 沙箱限制 |
| ❌ 移动端运行本地 Engine | 手机扛不住 Python FastAPI |
| ❌ 移动端桌面级权限系统 | 5 级权限、LLM 审计在手机上无意义 |
| ❌ 移动端全盘文件索引 | 沙箱限制 + 用户隐私风险 |
| ❌ 移动端右键菜单 | 不存在 |
| ❌ 移动端 Alt+Space | 无物理键盘 |

---

> **核心原则：移动端是云端 Agent 的交互界面，不是执行平台。**
> Agent 的工具调用全部在云端 Engine 执行，移动端只负责输入/输出和原生系统能力代理。
