# FeClaw Desktop 安全与架构审计报告

> 审计范围：云模式（连接 `feclaw.lizidaren.cn`），覆盖 30 个 Rust 源文件 + 15+ 个前端文件
> 审计日期：2026-06-21

---

## 一、用户主流程（User Flow）

### 1.1 首次启动窗口与配置创建的竞态

**文件**：`src-tauri/src/lib.rs:230-231`

首次启动检测逻辑在 `lib.rs` 的 `setup` 中：

```rust
let is_first = !crate::config::Config::config_path().exists();
let _ = crate::config::Config::load(); // ensure default config exists
```

问题在于 `is_first` 检查的是"配置文件不存在"，但 `Config::load()` **会创建默认配置文件**（如果不存在的话）。这意味着：
- 第二次启动时，`config_path().exists()` 已为 `true`，`is_first = false`，Welcome 窗口不会打开
- 但如果首次启动后用户**不保存 Welcome 配置**（例如直接关闭 Welcome 窗口），`Config::load()` 已写入了默认配置，导致 `mode = Local`，下次启动会走 `startup()` 而不是 Welcome 流程
- Welcome 窗口关闭时没有阻止 `startup()` 继续执行的机制

**影响**：用户可能跳过 Welcome 流程，直接以不完整的 Local 模式启动，但从未真正配置过。

---

### 1.2 右键挂起文件的 500ms 竞态窗口

**文件**：`src-tauri/src/lib.rs:267`

```rust
tauri::async_runtime::spawn(async move {
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    if let Err(e) = app_for_pending.emit("right-click-pending", &pending) {
        tracing::warn!("emit right-click-pending: {e}");
    }
});
```

500ms 的固定延迟是主观选择的，没有考虑机器性能差异。如果在此期间 `right-click-pending` 事件监听器（`chat.ts` 中的 `subscribeEvents()`）尚未完成注册，事件会静默丢弃，pending 文件丢失无感知。

---

### 1.3 云模式 WS 连接状态对用户不可见

**文件**：`src-tauri/src/chat.ts:88-89` + `src-tauri/src/ws.rs`

`chat.ts` 中连接状态的 UI 显示：

```html
<span class="conn-dot" id="conn-dot"></span>
<span class="conn-text" id="conn-text">在线</span>
```

`conn-text` 始终渲染为"在线"，无论 `ConnectionStatus` 的实际值。状态泵（`lib.rs:388-401`）更新了 `AppState.status`，但没有通过 Tauri 事件将状态变化推送到 UI 层，导致用户无法感知 WS 连接断开、认证失败等异常。

---

### 1.4 消息发送无幂等性保障

**文件**：`src-tauri/src/chat.ts:500-649`

`sendMessage()` 函数中，乐观本地回显在 `btn.disabled = true` 之前就已经渲染到消息列表。如果用户双击发送按钮或网络快速失败，消息可能被重复插入数据库（`insert_chat_message` 没有去重检查），且 `send_chat_message` 的 WS 请求没有请求 ID 或幂等标记。

---

### 1.5 主题变更需要重启才能生效

**文件**：`src-tauri/src/settings.ts:478-488`

主题变更通过 `set_theme` 实时写入 `config.toml`，但应用的主题系统（`data-theme="system"` + CSS 变量）只在 `applyTheme()` 时生效一次。WebView 进程不会重新加载 HTML/JS，下次启动才读取新主题。

---

## 二、功能配合（Functional Coordination）

### 2.1 `AgentInfo` 结构体重复定义

**文件**：`src-tauri/src/chat.rs:41-49` vs `src-tauri/src/create.rs:21-31`

```rust
// chat.rs
pub struct AgentInfo {
    pub hash: String, pub name: String, pub description: Option<String>,
    pub avatar_url: Option<String>, pub permission_mode: Option<String>, pub is_online: bool,
}

// create.rs（几乎相同）
pub struct AgentInfo {
    pub hash: String, pub name: String, pub description: Option<String>,
    pub avatar_url: Option<String>, pub permission_mode: Option<String>, pub is_online: bool,
}
```

两者除了 `pub` 可见性差异外完全一致。这种重复在 TypeScript 前端（`store.ts`）也存在一个版本，导致维护成本加倍，且容易在添加字段时产生不一致。

---

### 2.2 FTS5 搜索：建表但未使用

**文件**：`src-tauri/src/search.rs:310-325`

```rust
// 创建了 FTS5 虚拟表
CREATE VIRTUAL TABLE IF NOT EXISTS file_search USING fts5(path, name, snippet, tokenize='porter unicode61');
```

但实际搜索使用的是 LIKE 而非 FTS5 MATCH：

```rust
let rows = conn.query(
    "SELECT id, path, name, snippet, modified_at FROM file_search WHERE name LIKE ?1",
    params![&format!("%{}%", query)],
)?;
```

`LIKE '%query%'` 无法利用 FTS5 的倒排索引和分词器，搜索性能在大量文件时极差，且 FTS5 的 `porter unicode61` 分词器对中文支持更好，但完全没有被利用。

---

### 2.3 凭证加载逻辑重复 5 次

**文件**：分别位于 `group.rs`、`moments.rs`、`search.rs`、`qr_upload.rs`、`fehub.rs`

每个模块都独立实现了完全相同的 `load_token()` 函数：

```rust
fn load_token() -> Option<String> {
    let path = Config::config_dir().join("local-credentials");
    let content = std::fs::read_to_string(path).ok()?;
    let cred: serde_json::Value = serde_json::from_str(&content).ok()?;
    cred.get("token")?.as_str().map(String::from)
}
```

没有任何共享模块或 trait 来统一管理，任意一处改动需要同步其他五处，容易遗漏。

---

### 2.4 Alt+Space 快捷键与 Windows 系统冲突

**文件**：`src-tauri/src/alt_space.rs:200-210`

`alt_space.rs` 注册全局快捷键 `Alt+Space` 用于打开搜索面板，但 `Alt+Space` 在 Windows 中通常被用于**切换输入法开关**。这会：
- 与大多数中文输入法的默认快捷键冲突
- 导致用户无法正常使用输入法

代码中没有任何检测或警告机制。

---

### 2.5 本地模式 Bash 命令在 Windows 上不可用

**文件**：`src-tauri/src/local_setup.rs:100-330`

`local_setup.rs` 在 Step 4 中调用：

```rust
invoke("install_dependencies", { dest: state.destPath });
invoke("start_feclaw", { dest: state.destPath, port });
```

这些 Rust 命令内部使用 `bash -c "pip install ..."` 和 `nohup python3 ...`（在 WSL 环境下），但 `local_setup.ts` 面向的是 Windows 用户（在 Windows 上运行 Tauri 应用）。虽然 `local_setup.ts` 会调用 `check_git_installed` 和 `check_python_version`，但这些检查本身依赖 Rust 层调用系统命令，在纯 Windows 环境无法正确验证。

---

## 三、UI/UX 设计

### 3.1 设置页作为独立窗口而非内嵌面板

**文件**：`src-tauri/src/chat/index.html:30-33` + `src-tauri/src/settings.ts:658-659`

点击"设置" Tab 会调用 `invoke("open_settings_window")` 打开**新的系统窗口**：

```rust
// lib.rs 中 Settings 窗口和 Chat 窗口是独立的 WebviewWindow
WebviewWindowBuilder::new(&app, WIN, WebviewUrl::App("settings/index.html".into()))
```

这破坏了 IM 应用的沉浸感，用户需要管理两个窗口，且 Settings 窗口关闭后没有回调通知 Chat 窗口刷新状态。

---

### 3.2 连接状态图标无颜色区分

**文件**：`src-tauri/src/tray.rs:60-70`

托盘图标根据连接状态变色（绿/黄/红），但聊天窗口内的 `conn-dot`（连接状态圆点）始终是单一颜色，没有和托盘状态联动。用户只能通过托盘颜色感知连接状态，聊天窗口内部始终显示"在线"。

---

### 3.3 右键菜单命令路径未加引号

**文件**：`src-tauri/src/right_click.rs:60-65`

```rust
let cmd = format!("\"{exe_path}\" --right-click reference \"%1\"");
```

如果 `exe_path` 包含空格（例如 `C:\Program Files\...`），注册表中的命令字符串会断裂，导致 shell 调用失败。此外，如果文件路径中包含特殊字符（引号、反斜杠），同样会导致命令注入或解析错误。

---

### 3.4 缺少全局加载状态和错误处理

**文件**：多个组件

`side-panel.ts`、`create-dialog.ts`、`moments-feed.ts`、`fehub-tab.ts` 等组件在调用 Rust `invoke()` 时：

```typescript
} catch (e) {
    console.error("xxx failed:", e);
    // 仅打印到 console，UI 无任何反馈
}
```

网络错误、权限错误、超时等常见故障对用户完全不可见，用户不知道操作是失败还是进行中。

---

### 3.5 图片粘贴无尺寸和格式校验

**文件**：`src-tauri/src/chat/components/input-box.ts:746-783`

`handleImagePaste` 接受任何 `image/*` 类型，`save_temp_image` 虽然在 Rust 层有 1MB 限制（`file_ops.rs`），但 UI 层在粘贴时没有任何预览、大小提示或格式过滤，用户粘贴大图后收到模糊的错误信息。

---

## 四、安全性（Security）

### 4.1 JWT 明文存储于配置文件

**文件**：`src-tauri/src/config.rs` + `~/.feclaw/config.toml`

`cloud_token`（JWT）在登录成功后以**明文**写入 `config.toml`：

```toml
cloud_token = "eyJhbGc..."
```

无加密、无签名、仅依赖文件系统权限。在多用户 Windows 系统或被恶意软件访问时，攻击者可直接读取 JWT 并用于对 Engine API 的身份认证。

**对比**：本地模式下的凭证通过 `local-credentials` JSON 同样明文存储，无任何保护。

---

### 4.2 JWT 通过 URL 查询参数传递

**文件**：`src-tauri/src/create.rs:111-116`

```rust
let configure_url = format!(
    "{}/agent/{}/configure?token={}",
    base_url.trim_end_matches('/'),
    agent_hash,
    token,  // JWT 直接放在 URL 中
);
```

浏览器会：
- 将完整 URL 记录到浏览器历史记录
- 通过 `Referer` 头泄漏到外部站点
- 被 CDN/代理服务器记录到日志

建议改用 `POST` 方式或安全的令牌传递机制（如一次性 signed URL）。

---

### 4.3 命令执行无参数转义

**文件**：`src-tauri/src/executor.rs:50-55`

```rust
pub async fn execute(&self, command: String, args: Vec<String>) -> Result<String> {
    let output = Command::new(&command)
        .args(&args)  // Tokio Command::args 是安全的
        .output()
        .await
```

`tokio::process::Command::args` 本身是安全的，但 `ws.rs` 中的调用方式存在问题：

```rust
// ws.rs:351-360
let output = Command::new("cmd")
    .args(["/C", &full_cmd])  // full_cmd 是字符串插值构建的 shell 命令！
    .output()
    .await
```

其中 `full_cmd = format!("{} {}", command, args.join(" "))`，`args` 数组被用空格连接成单个字符串交给 `cmd /C` 执行，**完全没有转义**。如果 Agent 执行的命令包含特殊字符（`&`, `|`, `;`, `>`, `<`），可以实现任意命令注入。

---

### 4.4 WS 消息无 JSON Schema 验证

**文件**：`src-tauri/src/ws.rs:120-200`

接收到的 WS 消息直接 `serde_json::from_str` 到对应的结构体：

```rust
let msg: WsIncoming = serde_json::from_str(&text)
    .map_err(|_| WsError::Protocol)?;
```

如果服务器返回格式不同的消息（例如新增字段、类型不匹配），反序列化会失败但不关闭连接，可能导致悬挂状态。此外，`WsIncoming` 的各个 variant 对未知字段是允许的（`#[serde(flatten)]` 或忽略），攻击者可能发送畸形消息触发意外行为。

---

### 4.5 Trusted Commands 无签名验证

**文件**：`src-tauri/src/consent.rs:200-230`

`trusted-commands.json` 的加载和保存没有任何签名或篡改检测：

```rust
pub fn load_trusted(&mut self) {
    let path = self.trust_file();
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let trusted: Vec<String> = serde_json::from_str(&content).unwrap_or_default();
    self.session_trust.extend(trusted);
}
```

攻击者（具有本地文件系统访问权限）可以修改 `trusted-commands.json` 添加任意白名单命令，绕过 Consent Manager 的 L1-L5 分类限制。

---

### 4.6 右键菜单 exe_path 未加引号导致命令注入风险

**文件**：`src-tauri/src/right_click.rs:58-65`

```rust
let cmd = format!("\"{exe_path}\" --right-click reference \"%1\"");
```

`exe_path` 如果包含反引号或 `$()` 等 shell 元字符，在 Windows `cmd.exe` 中可能被解析执行。建议对 `exe_path` 做额外的引号包裹和转义。

---

## 五、Server 模式兼容性

### 5.1 硬编码域名贯穿多个模块

**文件**：多处

- `src-tauri/src/side_panel.rs:415`：`open_config_window` 硬编码 `https://{agent_hash}.feclaw.lizidaren.cn/settings`
- `src-tauri/src/fehub.rs:140`：`open_miniapp` 硬编码 `https://{agent_hash}.feclaw.lizidaren.cn`
- `src-tauri/src/config.rs:150`：`ws_url()` 默认 `ws://127.0.0.1:{port}`（本地模式），但云模式没有独立默认值

自托管部署场景下这些域名全部失效，且无降级或配置覆盖机制。

---

### 5.2 VFS 路径映射与 Engine 侧不一致

**文件**：`src-tauri/src/file_bridge.rs:30-50`

Desktop 端的 VFS 前缀映射：
- `/mnt/desktop/` → `Desktop`
- Windows 绝对路径（`C:/...`）不做转换

但 FeClaw Engine 侧的 VFS 实现可能使用不同的映射规则（`/mnt/mobile/`, `/mnt/desktop/` 的具体行为），如果两端不一致，Agent 返回的文件路径在 Desktop 端可能无法正确解析。

---

### 5.3 云模式心跳间隔与 Engine 不对齐

**文件**：`src-tauri/src/ws.rs:35-40` + `src-tauri/src/engine.rs`

心跳发送间隔：
- Desktop WS Client：**30 秒**（`HEARTBEAT_INTERVAL`）
- FeClaw Engine：**预期 60 秒**（从上下文推断，参考 `cloud_loop` 中的超时设置）

如果 Engine 的空闲超时短于 30 秒，Desktop 的心跳会被视为活跃连接但仍然触发 Engine 侧的断连。

---

### 5.4 云模式 Consent Manager 分类对 Agent 无效

**文件**：`src-tauri/src/consent.rs:100-200`

`ConsentManager` 的 L1-L5 风险分类逻辑主要针对**本地模式**下的命令执行（`file_bridge.rs`、`file_ops.rs`）。在**云模式**下，Agent 运行在远程 Engine，Desktop 端仅转发消息，不执行任何文件操作，因此：
- Consent Manager 的所有分类逻辑对云模式 Agent 完全不适用
- 云模式下的 Agent 操作完全没有本地权限控制

---

### 5.5 `config.toml` 云模式默认 `cloud_url` 指向本地地址

**文件**：`src-tauri/src/config.rs:50-60`

`Config::load()` 中：
```rust
pub fn cloud_base_url(&self) -> Option<String> {
    self.cloud_url.clone()
}
```

当 `config.toml` 中 `cloud_url = ""`（空字符串）时，`cloud_base_url()` 返回 `None`，但 `ws_url()` fallback 到 `http://127.0.0.1:{port}`，这意味着：
- 云模式下如果配置未正确写入，用户看到的是**本地的"无法连接"错误**，而不是云端地址配置错误的提示

---

## 附录：发现优先级汇总

| 优先级 | 问题 | 维度 |
|--------|------|------|
| **严重** | 命令执行无转义（shell 注入） | 安全 |
| **严重** | JWT 明文存储于 config.toml | 安全 |
| **严重** | JWT 通过 URL query param 传递 | 安全 |
| **高** | FTS5 建表但用 LIKE 查询 | 功能配合 |
| **高** | 右键菜单 exe_path 未加引号 | 安全 |
| **高** | 云模式 WS 连接状态对用户不可见 | 用户流程 |
| **高** | Trusted Commands 无签名验证 | 安全 |
| **中** | AgentInfo 结构体重复定义 | 功能配合 |
| **中** | 设置页作为独立窗口而非内嵌 | UI/UX |
| **中** | 硬编码 feclaw.lizidaren.cn 域名 | Server 兼容 |
| **中** | Alt+Space 与输入法快捷键冲突 | UI/UX |
| **中** | 主题变更需重启才生效 | UI/UX |
| **低** | 凭证加载逻辑重复 5 次 | 功能配合 |
| **低** | 右键 pending 事件 500ms 竞态 | 用户流程 |
| **低** | 图片粘贴无尺寸/格式校验 | UI/UX |
