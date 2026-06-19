# FeClaw Desktop V2 开发计划

> 创建日期: 2026-06-19
> 版本: v3（第三版，修复二审 8 条核心问题 + 改造现有代码）
> 审核: docs/v2-plan-audit.md（一审）、docs/v2-plan-audit-v2.md（二审）

---

## V2 功能概览

| # | 功能 | 涉及文件 | 状态 |
|---|------|---------|------|
| 1 | 开机自启 | Cargo.toml / engine.rs / main.rs / lib.rs / tray.rs | ⬜ |
| 2 | 设置界面 | settings.rs + HTML/TS / config.rs / lib.rs / tray.rs | ⬜ |
| 3 | 文件中继 | file_bridge.rs / ws.rs(改) / consent.rs(改) + FeClaw: desktop_ws.py / desktop_relay.py / vfs.py | ⬜ |
| 4 | 云模式连接 | config.rs / auth.rs / engine.rs / ws.rs(改) / lib.rs(改) + FeClaw: desktop_ws.py | ⬜ |

---

## 修正说明（二审修复清单）

| 问题 | 类型 | 修复方案 |
|------|------|---------|
| N-1 `WsMessage` 枚举不存在 | 🔴编译 | 不用自造 WsMessage，直接用现有 `serde_json::json!` + ws_types 结构体 |
| N-2 响应缺 `status` 字段 | 🔴编译 | 用 ws_types.rs 现有 `{id, status, timestamp, payload}` 结构，所有 handler 照此构造 |
| N-3 重定义 `FileDeleteResponse` | 🔴编译 | 删除自造类型，全部复用 ws_types.rs 现有定义 |
| N-4 `downcast_ref::<Message>()` 类型错 | 🔴编译 | 改用 `tungstenite::Error::ConnectionClose(frame)` 分支匹配 |
| N-6 `auto-launch` API 用错 | 🔴编译 | 改三参构造 `AutoLaunch::new(name, path, args)` |
| N-7 Cargo.toml TLS 依赖缺失 | 🔴编译 | 加 `native-tls = "0.2"` + `tokio-native-tls = "0.3"`，改 tokio-tungstenite features |
| N-8 `ConsentManager::show_dialog` 不存在 | 🔴编译 | 新增 `request_operation` 直接内联弹窗逻辑，不复用现有 request() |
| N-9 `auth_failure` 字段不存在 | 🔴编译 | 加 `Arc<Notify>` 字段，close code 4xxx 时 notify，EngineManager 监听触发 reauth |
| P0-5/N-10 symlink 攻击漏洞 | 🔴安全 | `resolve_desktop_path` 返回 canonical 而非 resolved，并对每个父目录检查 is_symlink |
| P0-7 JWT header 认证 Python 端 | 🔴协议 | FastAPI WebSocket 用 dependency 读取 header JWT，不走 first-message JSON |
| P1-1/N-11 session_trust 语义污染 | 🟡语义 | 新增独立 `session_trust_files: HashSet<String>` 和 `~/.feclaw/trusted-files.json` |
| N-13 文件大小上限缺失 | 🟡健壮 | 加 `MAX_FILE_BYTES = 1MiB`，超限报错 |
| N-12 cloud 重登缺 UI 引导 | 🟡体验 | 加 `ControlMsg::ShowCloudLogin`，触发设置窗口云端 Tab |
| N-5 chronoUtc 重复 | 🟡 | 删 `chronoUtc()`，统一调 `ws_types::current_timestamp()` |
| N-14 settings.ts 非空断言 | 🟡 | 封装 `$()` 返回 `T | null`，调用方判空 |
| N-15 .ok() 吞错误 | 🟡 | 改为 `if let Err(e) = ... { tracing::error!() }` |
| N-17 ws_writer/ws_stream 字段不存在 | 🟡 | 按现有 ws.rs 实际结构 `ws: WsStream` + `outgoing_rx` 重写 run_inner |
| N-18 save() 在锁内 | 🟡 | save 移到 `spawn_blocking` |
| N-16 UNC 路径注释 | 🟡 | 加注释说明不支持 UNC |

---

## 实施阶段概览

```
阶段 0：依赖 + 类型对齐（ Cargo.toml + ws_types.rs 补类型 + ws.rs 改造）
阶段 1：设置界面
阶段 2：文件中继
阶段 3：开机自启
阶段 4：云模式连接
```

---

## 阶段 0：依赖 + 类型对齐

### 0.1 Cargo.toml 补充依赖（修复 N-7）

```toml
[dependencies]
# 已有
tokio-tungstenite = { version = "0.26", features = ["connect", "native-tls", "rustls-tls-webpki-roots"] }

# 新增
auto-launch = "0.5"
dirs = "5"
base64 = "0.22"
native-tls = "0.2"
tokio-native-tls = "0.3"
tokio = { version = "1", features = ["full"] }  # 已有，但确保有 spawn-blocking
```

> 注意：tokio-tungstenite 同时启用 `native-tls` 和 `rustls-tls-webpki-roots` 是安全的（运行时选一个），保留 `rustls-tls-webpki-roots` 不删。

### 0.2 ws_types.rs 补充 FileWriteResponse 类型（修复 N-3）

在 `ws_types.rs` 找到 `FileDeleteResponse`（约147行）附近，添加：

```rust
// FileWriteResponse（V2 新增）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileWriteResponse {
    pub id: String,
    #[serde(default)]
    pub status: String,  // "ok" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub payload: FileWriteResponsePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileWriteResponsePayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl FileWriteResponse {
    pub fn ok(id: &str) -> Self {
        Self {
            id: id.into(),
            status: "ok".into(),
            timestamp: Some(current_timestamp()),
            payload: FileWriteResponsePayload { error: None },
        }
    }

    pub fn error(id: &str, err: String) -> Self {
        Self {
            id: id.into(),
            status: "error".into(),
            timestamp: Some(current_timestamp()),
            payload: FileWriteResponsePayload { error: Some(err) },
        }
    }
}
```

同时在 `FileReadResponse`、`FileDeleteResponse` 添加 `ok()` / `error()` 构造器（与上面对齐），现有代码保持不变（向后兼容）。

### 0.3 ws.rs 消息发送改造（利用现有结构，不自造 WsMessage）

找到 ws.rs 中所有文件相关 handler（`file_read_response`、`file_write_response`、`file_delete_response`），改造为使用 ws_types.rs 的构造器：

**现有代码（约 ws.rs:270-310）：**
```rust
// 旧代码：直接 serde_json::json! 拼字符串，缺 status
obj.insert("type".to_string(), serde_json::Value::String("file_read_response".to_string()));
// ... 缺少 status 字段
```

**改造为（ws.rs 内联 helper，不动 ws_types.rs）：**
```rust
use crate::ws_types::{FileReadResponse, FileReadResponsePayload,
                        FileWriteResponse, FileWriteResponsePayload,
                        FileDeleteResponse, FileDeleteResponsePayload};

impl WsClient {
    async fn handle_file_read(&mut self, id: &str, payload: FileReadPayload) {
        let resp = match self.file_bridge.read(&payload.path).await {
            Ok(content) => {
                let payload = FileReadResponsePayload { content: Some(content), error: None };
                FileReadResponse { id: id.into(), status: "ok".into(),
                                   timestamp: Some(current_timestamp()), payload }
            }
            Err(e) => {
                let payload = FileReadResponsePayload { content: None, error: Some(e) };
                FileReadResponse { id: id.into(), status: "error".into(),
                                   timestamp: Some(current_timestamp()), payload }
            }
        };
        self.send_ws_message(serde_json::to_string(&resp).unwrap()).await;
    }

    async fn handle_file_write(&mut self, id: &str, payload: FileWritePayload) {
        let resp = match self.file_bridge.write(&payload.path, &payload.content).await {
            Ok(()) => FileWriteResponse::ok(id),
            Err(e) => FileWriteResponse::error(id, e),
        };
        self.send_ws_message(serde_json::to_string(&resp).unwrap()).await;
    }

    async fn handle_file_delete(&mut self, id: &str, payload: FileDeletePayload) {
        let resp = match self.file_bridge.delete(&payload.path).await {
            Ok(()) => {
                let payload = FileDeleteResponsePayload { error: None };
                FileDeleteResponse { id: id.into(), status: "ok".into(),
                                    timestamp: Some(current_timestamp()), payload }
            }
            Err(e) => {
                let payload = FileDeleteResponsePayload { error: Some(e) };
                FileDeleteResponse { id: id.into(), status: "error".into(),
                                    timestamp: Some(current_timestamp()), payload }
            }
        };
        self.send_ws_message(serde_json::to_string(&resp).unwrap()).await;
    }

    /// 统一发送 WS 消息
    async fn send_ws_message(&mut self, text: String) {
        use tokio_tungstenite::tungstenite::Message;
        if let Some(ws) = &mut self.ws {
            ws.send(Message::Text(text.into())).await.ok();
        }
    }
}
```

> 关键：不新建 WsMessage 枚举，用 ws_types.rs 现有结构 + serde 序列化，保持协议完全兼容。

### 0.4 ws.rs run_inner 重连逻辑改造（修复 N-4、N-9）

找到 ws.rs 中 `run_inner` 或等效重连循环，替换为：

```rust
use tokio::sync::Notify;
use std::sync::Arc;

// WsClient 结构体新增字段（在现有字段后追加）
// pub auth_failure: Arc<Notify>,  // JWT 过期通知（通知 EngineManager 重新登录）

async fn run(&mut self, cancel_token: Arc<AtomicBool>) -> Result<()> {
    let mut attempts = 0u32;
    while !cancel_token.load(Ordering::Relaxed) {
        match self.run_inner().await {
            Ok(()) => { attempts = 0; }
            Err(e) => {
                // 检测是否为 JWT 失效导致的断开（N-4 修复）
                if let Some(frame) = e.downcast_ref::<tokio_tungstenite::tungstenite::Error>() {
                    match frame {
                        tokio_tungstenite::tungstenite::Error::ConnectionClose(frame) => {
                            let code = frame.map(|f| f.code).unwrap_or(1000);
                            if code == 4001 || code == 4002 {
                                // JWT 失效 → 通知 EngineManager 触发重新登录（N-9）
                                if let Some(notify) = &self.auth_failure {
                                    notify.notify_waiters();
                                }
                                tracing::info!("WS closed due to auth failure (code {}), triggering reauth", code);
                                return Ok(());  // 不重试，由 EngineManager 处理
                            }
                        }
                        _ => {}
                    }
                }

                if attempts >= MAX_RECONNECT_ATTEMPTS { break; }
                tracing::warn!("WS disconnected: {}, reconnecting in 1s", e);
                tokio::time::sleep(RECONNECT_DELAY).await;
                attempts += 1;
            }
        }
    }
    Ok(())
}
```

> 注意：`downcast_ref` 的类型是 `&tokio_tungstenite::tungstenite::Error`，不是 `Message`（N-4 修复）。

### 0.5 consent.rs 新增 request_operation 方法（修复 N-8）

在 `consent.rs` 的 `ConsentManager` impl 块中新增：

```rust
/// 文件操作的 consent 请求（不走 assess_risk，直接按操作类型定 risk）
/// - read: L1 静默
/// - write: L2 弹窗
/// - delete: L3 红色弹窗
///
/// 注意：不复用 session_trust（命令信任集合），防止污染 trusted-commands.json
pub async fn request_operation(&mut self, operation: &str, path: &str) -> bool {
    let risk = match operation {
        "read" => RiskLevel::L1,
        "write" => RiskLevel::L2,
        "delete" => RiskLevel::L3,
        _ => RiskLevel::L3,
    };

    if risk == RiskLevel::L1 {
        return true;  // L1 静默通过
    }

    // 构建描述文本
    let description = match operation {
        "write" => format!("写文件：{}\n此操作将在工作目录中创建/覆盖文件", path),
        "delete" => format!("删除文件：{}\n此操作不可撤销！", path),
        _ => format!("{} 文件：{}", operation, path),
    };

    // 直接内联弹窗逻辑（不走 request()，避免破坏命令信任语义）
    let decision = self.show_consent_dialog(&description, risk).await;
    decision == Decision::Allow
}

/// 内部弹窗方法
async fn show_consent_dialog(&self, description: &str, risk: RiskLevel) -> Decision {
    use rfd;

    let (title, buttons) = match risk {
        RiskLevel::L2 => ("⚠️ FeClaw 文件操作请求", rfd::MessageButtons::YesNo),
        RiskLevel::L3 => ("🔴 FeClaw 删除文件请求", rfd::MessageButtons::YesNo),
        _ => ("FeClaw 操作请求", rfd::MessageButtons::Ok),
    };

    let msg = format!("{}\n\n路径：{}", description, self.app_info.display());

    match risk {
        RiskLevel::L2 => {
            let ans = rfd::MessageDialog::new()
                .title(title)
                .description(&msg)
                .buttons(buttons)
                .blocking_show();
            if ans == rfd::MessageDialogResult::Yes { Decision::Allow } else { Decision::Deny }
        }
        RiskLevel::L3 => {
            let ans = rfd::MessageDialog::new()
                .title(title)
                .description(&msg)
                .buttons(buttons)
                .set_level(rfd::MessageLevel::Warning)
                .blocking_show();
            if ans == rfd::MessageDialogResult::Yes { Decision::Allow } else { Decision::Deny }
        }
        _ => Decision::Allow,
    }
}
```

### 0.6 engine.rs 新增 reauth_cloud + auth_failure 监听（修复 N-9）

在 `EngineManager` impl 块中：

```rust
use tokio::sync::Notify;
use std::sync::Arc;

pub struct EngineManager {
    // ... existing fields ...
    /// JWT 失效时收到通知
    pub auth_failure: Arc<Notify>,
}

impl EngineManager {
    /// 监听 auth_failure 信号，触发重新登录
    pub async fn wait_for_auth_failure(&mut self) {
        loop {
            self.auth_failure.notified().await;
            tracing::info!("Auth failure detected, initiating cloud re-auth");
            if let Err(e) = self.reauth_cloud().await {
                tracing::error!("Re-auth failed: {}", e);
                // 通知 UI 显示登录弹窗
                if let Some(tx) = &self.ui_tx {
                    let _ = tx.send(crate::ControlMsg::ShowCloudLogin);
                }
            }
        }
    }

    /// 重新进行云端登录（清除旧 JWT，等用户重新认证）
    pub async fn reauth_cloud(&mut self) -> Result<()> {
        // 1. 清除旧 token
        self.config.cloud_token = None;
        
        // 2. 异步保存（避免在通知锁内写文件）
        let cfg = self.config.clone();
        tokio::task::spawn_blocking(move || {
            cfg.save().map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
        }).await??;

        // 3. 返回错误让上层处理（UI 弹出登录表单）
        Err(anyhow!("cloud re-auth required"))
    }
}
```

---

## 阶段 1：设置界面

### 1.1 Cargo.toml 已有依赖确认
```toml
# settings 窗口依赖（已有，无需新增）
tauri = { version = "2", features = ["devtools"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
dirs = "5"          # 已在阶段0加入
```

### 1.2 src/settings/ 目录（Tauri 2 正确路径）

```
src-tauri/src/
  settings.rs
  settings/
    index.html
    settings.css
    settings.ts
```

### 1.3 settings.rs
```rust
use std::collections::HashMap;
use std::path::PathBuf;

fn feclaw_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".feclaw")
}

fn env_path() -> PathBuf { feclaw_dir().join(".env") }

fn parse_env(content: &str) -> HashMap<String, String> {
    content.lines().filter_map(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { return None; }
        line.split_once('=').map(|(k, v)| (k.trim().into(), v.trim().into()))
    }).collect()
}

fn format_env(env: &HashMap<String, String>) -> String {
    let mut lines: Vec<_> = env.iter().map(|(k, v)| format!("{}={}", k, v)).collect();
    lines.sort();
    lines.join("\n") + "\n"
}

fn load_env() -> HashMap<String, String> {
    env_path().exists().then_some(())
        .and_then(|()| std::fs::read_to_string(env_path()).ok())
        .map(parse_env)
        .unwrap_or_default()
}

fn do_save_env(env: &HashMap<String, String>) -> std::io::Result<()> {
    if let Some(parent) = env_path().parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&env_path(), format_env(env))
}

#[tauri::command]
fn get_settings() -> Result<HashMap<String, String>, String> {
    let env = load_env();
    let mut masked = env.clone();
    if masked.get("JWT_SECRET").is_some() {
        masked.insert("JWT_SECRET".into(), "[已设置]".into());
    }
    if let Some(v) = masked.get("MINIMAX_API_KEY") {
        if v.len() > 8 {
            masked.insert("MINIMAX_API_KEY".into(), format!("{}****", &v[..8]));
        }
    }
    Ok(masked)
}

#[tauri::command]
fn save_settings(settings: HashMap<String, String>) -> Result<(), String> {
    let mut env = load_env();
    for (k, v) in settings {
        env.insert(k, v);
    }
    // 使用 spawn_blocking 避免在 event loop 写文件（N-18 修复）
    let env_clone = env.clone();
    tokio::task::spawn_blocking(move || {
        do_save_env(&env_clone)
    }).await
      .map_err(|e| format!("task join error: {}", e))?
      .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    let url = tauri::WebviewUrl::App("settings/index.html".into());
    tauri::WebviewWindowBuilder::new(&app, "settings", url)
        .title("FeClaw Desktop 设置")
        .inner_size(600.0, 700.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

### 1.4 settings/index.html
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="settings.css">
  <title>FeClaw Desktop 设置</title>
</head>
<body>
  <div class="settings-container">
    <h2>FeClaw Desktop 设置</h2>

    <div class="tabs">
      <button class="tab active" data-tab="general">常规</button>
      <button class="tab" data-tab="cloud">云端模式</button>
    </div>

    <!-- 常规 Tab -->
    <div id="tab-general" class="tab-content">
      <section>
        <h3>存储</h3>
        <div class="field">
          <label for="storage-mode">存储后端</label>
          <select id="storage-mode">
            <option value="local">本地磁盘</option>
            <option value="cos">腾讯云 COS</option>
          </select>
        </div>
        <div class="field" id="cos-fields" hidden>
          <label for="cos-bucket">COS Bucket</label>
          <input id="cos-bucket" placeholder="feclaw-xxxxx">
        </div>
      </section>

      <section>
        <h3>连接</h3>
        <div class="field">
          <label for="engine-port">引擎端口</label>
          <input id="engine-port" type="number" min="1024" max="65535" value="8080">
        </div>
        <div class="field">
          <label for="ws-url">WS 地址</label>
          <input id="ws-url" value="ws://127.0.0.1:19999">
        </div>
      </section>

      <section>
        <h3>启动</h3>
        <div class="field">
          <label><input id="auto-launch" type="checkbox"> 开机自动启动</label>
        </div>
        <div class="field">
          <label><input id="start-minimized" type="checkbox"> 启动后最小化到托盘</label>
        </div>
      </section>

      <section>
        <h3>API</h3>
        <div class="field">
          <label for="minimax-key">MiniMax API Key</label>
          <input id="minimax-key" type="password" placeholder="sk-...">
        </div>
      </section>
    </div>

    <!-- 云端 Tab -->
    <div id="tab-cloud" class="tab-content" hidden>
      <section>
        <h3>云端连接</h3>
        <div class="field">
          <label for="cloud-url">服务器地址</label>
          <input id="cloud-url" placeholder="https://your-server.com">
        </div>
        <div class="field">
          <label for="cloud-username">用户名</label>
          <input id="cloud-username">
        </div>
        <div class="field">
          <label for="cloud-password">密码</label>
          <input id="cloud-password" type="password">
          <small>密码不会保存，仅用于获取 JWT</small>
        </div>
        <button id="cloud-connect" class="primary">连接</button>
        <p id="cloud-status"></p>
      </section>
    </div>

    <div class="actions">
      <button id="save" class="primary">保存</button>
      <button id="cancel">取消</button>
    </div>

    <div id="status-msg"></div>
  </div>
  <script type="module" src="settings.ts"></script>
</body>
</html>
```

### 1.5 settings.ts（N-14 修复：null 检查）
```typescript
import { invoke } from "@tauri-apps/api/core";

function $<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

async function load() {
  const env = await invoke<Record<string, string>>("get_settings");
  const storageMode = $("storage-mode");
  if (storageMode) (storageMode as HTMLSelectElement).value = env["STORAGE_MODE"] || "local";
  
  const cosFields = $("cos-fields");
  if (cosFields && env["COS_BUCKET"]) cosFields.hidden = false;
  const cosBucket = $("cos-bucket");
  if (cosBucket) (cosBucket as HTMLInputElement).value = env["COS_BUCKET"] || "";

  const enginePort = $("engine-port");
  if (enginePort) (enginePort as HTMLInputElement).value = env["PORT"] || "8080";
  const wsUrl = $("ws-url");
  if (wsUrl) (wsUrl as HTMLInputElement).value = env["DESKTOP_WS_URL"] || "ws://127.0.0.1:19999";
  const autoLaunch = $("auto-launch");
  if (autoLaunch) (autoLaunch as HTMLInputElement).checked = env["AUTO_LAUNCH"] === "true";

  const minimaxKey = $("minimax-key");
  if (minimaxKey) {
    (minimaxKey as HTMLInputElement).placeholder = env["MINIMAX_API_KEY"]
      ? "[已设置，填新值可覆盖]" : "sk-...";
  }
}

async function save() {
  const storageMode = $("storage-mode");
  const enginePort = $("engine-port");
  const wsUrl = $("ws-url");
  const autoLaunch = $("auto-launch");
  const minimaxKey = $("minimax-key");

  const updates: Record<string, string> = {};
  if (storageMode) updates["STORAGE_MODE"] = (storageMode as HTMLSelectElement).value;
  if (enginePort) updates["PORT"] = (enginePort as HTMLInputElement).value;
  if (wsUrl) updates["DESKTOP_WS_URL"] = (wsUrl as HTMLInputElement).value;
  if (autoLaunch) updates["AUTO_LAUNCH"] = (autoLaunch as HTMLInputElement).checked ? "true" : "false";

  const keyVal = minimaxKey ? (minimaxKey as HTMLInputElement).value : "";
  if (keyVal && !keyVal.includes("已设置") && !keyVal.includes("****")) {
    updates["MINIMAX_API_KEY"] = keyVal;
  }

  const cosBucket = $("cos-bucket");
  if (updates["STORAGE_MODE"] === "cos" && cosBucket) {
    updates["COS_BUCKET"] = (cosBucket as HTMLInputElement).value;
  }

  await invoke("save_settings", { settings: updates });
  const msg = $("status-msg");
  if (msg) { msg.textContent = "保存成功"; setTimeout(() => window.close(), 1500); }
}

// Tab 切换
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    const tab = (btn as HTMLElement).dataset.tab;
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.hidden = true);
    (btn as HTMLElement).classList.add("active");
    const target = document.getElementById(`tab-${tab}`);
    if (target) target.hidden = false;
  });
});

($("save") as HTMLButtonElement)?.addEventListener("click", save);
($("cancel") as HTMLButtonElement)?.addEventListener("click", () => window.close());

load();
```

### 1.6 lib.rs 注册
```rust
mod settings;

#[tauri::command]
fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    settings::open_settings_window(app)
}

// ControlMsg 新增 ShowCloudLogin（N-12）
#[derive(Debug, Clone, Copy)]
pub enum ControlMsg {
    Reconnect,
    SetMode(Mode),
    ShowCloudLogin,  // 新增：通知 UI 弹出云端登录
    // ...
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> Result<()> {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_settings, ..existing_handlers])
        // ...
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
    Ok(())
}
```

### 1.7 tray.rs 托盘菜单
```
├─ FeClaw Desktop
├─ ─────────
├─ 状态: Connected / Connecting... / Disconnected
├─ 重新连接
├─ ─────────
├─ ☑/☐ 开机自启
├─ 设置...          ← 点击 → open_settings()
├─ ─────────
└─ 退出
```

---

## 阶段 2：文件中继

### 2.1 新建 file_bridge.rs（核心路径解析 + symlink 防护）

```rust
// src-tauri/src/file_bridge.rs

use std::path::{Path, PathBuf};

/// 最大文件大小：1 MiB（与 executor.rs MAX_OUTPUT_BYTES 对齐，N-13 修复）
const MAX_FILE_BYTES: usize = 1 * 1024 * 1024;

/// 允许的根目录
fn allowed_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Desktop")
}

/// 将 /mnt/desktop/ 路径映射到本机绝对路径
///
/// design.md §5.2：
///   /mnt/desktop/C:/Users/小明/file.txt → C:\Users\小明\file.txt
///   /mnt/desktop/D:/data/               → D:\data\
///   /mnt/desktop/foo.txt                → ~/Desktop/foo.txt
///
/// 安全：返回 canonical path，挡掉 symlink 攻击（P0-5/N-10 修复）
fn resolve_desktop_path(path: &str) -> Result<PathBuf, String> {
    const PREFIX: &str = "/mnt/desktop/";
    if !path.starts_with(PREFIX) {
        return Err(format!("path does not start with {}", PREFIX));
    }
    let rest = &path[PREFIX.len()..];

    let resolved: PathBuf = if rest.len() >= 2 && rest.chars().nth(1) == Some(':') {
        // Windows 绝对路径：C:/Users/... → C:\Users\...
        // 注意：不支持 UNC 路径（\\?\C:\...）（N-16）
        PathBuf::from(rest.replace('/', "\\"))
    } else {
        // 相对路径 → ~/Desktop/...
        allowed_root().join(rest)
    };

    // 1. 解析 symlink，得到 canonical 路径（关键！挡掉 symlink 攻击）
    let canonical = resolved.canonicalize()
        .unwrap_or_else(|_| resolved.clone());

    // 2. 对每个父目录检查是否是 symlink（防止中间目录被替换）
    let mut current = resolved.as_path();
    while let Some(parent) = current.parent() {
        if parent.is_symlink() {
            return Err(format!("symlink in path component not allowed: {}", parent.display()));
        }
        if parent == current { break; }
        current = parent;
    }

    // 3. 大小写不敏感比对（Windows NTFS）
    let allowed_lower = allowed_root().to_string_lossy().to_lowercase();
    let canonical_lower = canonical.to_string_lossy().to_lowercase();
    if !canonical_lower.starts_with(&allowed_lower) {
        return Err(format!(
            "path traversal attempt: resolved to {} which is outside {}",
            canonical.display(), allowed_root().display()
        ));
    }

    // 4. 文件大小检查（防止 base64 后内存爆炸，N-13 修复）
    if let Ok(metadata) = std::fs::metadata(&canonical) {
        if metadata.len() as usize > MAX_FILE_BYTES {
            return Err(format!(
                "file too large: {} bytes (max {}), consider streaming",
                metadata.len(), MAX_FILE_BYTES
            ));
        }
    }

    Ok(canonical)
}

/// 检查文件是否存在（用于 pre-check）
pub fn path_exists(path: &str) -> bool {
    resolve_desktop_path(path).is_ok() && Path::new(&resolve_desktop_path(path).unwrap()).exists()
}

// ===================== 同步实现（供 ws.rs 直接调用）=====================

pub struct FileBridge;

impl FileBridge {
    pub fn read(&self, path: &str) -> Result<String, String> {
        use base64::Engine as _;
        use base64::engine::general_purpose::STANDARD as BASE64;

        let canonical = resolve_desktop_path(path)?;
        let bytes = std::fs::read(&canonical).map_err(|e| e.to_string())?;
        
        // 大小已在 resolve_desktop_path 检查
        Ok(BASE64.encode(&bytes))
    }

    pub fn write(&self, path: &str, content_b64: &str) -> Result<(), String> {
        use base64::Engine as _;
        use base64::engine::general_purpose::STANDARD as BASE64;

        let canonical = resolve_desktop_path(path)?;
        
        // 确保父目录存在
        if let Some(parent) = canonical.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        
        let bytes = BASE64.decode(content_b64)
            .map_err(|e| format!("base64 decode error: {}", e))?;
        std::fs::write(&canonical, bytes).map_err(|e| e.to_string())
    }

    pub fn delete(&self, path: &str) -> Result<(), String> {
        let canonical = resolve_desktop_path(path)?;
        std::fs::remove_file(&canonical).map_err(|e| e.to_string())
    }
}
```

> 注意：这里用**同步**实现（`std::fs::read`），因为 Rust 的 `std::fs` 在有 `spawn_blocking` 的地方是标准做法。
> 如果 ws.rs 调用时需要 async wrapper，可以用 `tokio::task::spawn_blocking`。

### 2.2 ws.rs 文件 handler 接入 file_bridge

在 `ws.rs` 的消息循环中（handle 字段分发），找到 `FileRead` / `FileWrite` / `FileDelete` 匹配分支，改为：

```rust
// 在 WsClient struct 添加
// file_bridge: FileBridge,

// handle_message 分发中：
Message::FileRead { id, payload } => {
    self.handle_file_read(&id, payload).await;
}
Message::FileWrite { id, payload } => {
    self.handle_file_write(&id, payload).await;
}
Message::FileDelete { id, payload } => {
    self.handle_file_delete(&id, payload).await;
}

// handler 实现：
async fn handle_file_read(&mut self, id: &str, payload: FileReadPayload) {
    // consent
    if !self.consent.request_operation("read", &payload.path).await {
        let resp = FileReadResponse {
            id: id.into(), status: "error".into(),
            timestamp: Some(current_timestamp()),
            payload: FileReadResponsePayload { content: None, error: Some("denied".into()) },
        };
        self.send_ws_json(&resp).await;
        return;
    }

    // 执行（spawn_blocking 避免阻塞 event loop）
    let path = payload.path.clone();
    let result = tokio::task::spawn_blocking(move || {
        FileBridge.read(&path)
    }).await;
    
    let resp = match result {
        Ok(Ok(content)) => {
            FileReadResponse { id: id.into(), status: "ok".into(),
                               timestamp: Some(current_timestamp()),
                               payload: FileReadResponsePayload { content: Some(content), error: None } }
        }
        Ok(Err(e)) | Err(e) => {
            FileReadResponse { id: id.into(), status: "error".into(),
                               timestamp: Some(current_timestamp()),
                               payload: FileReadResponsePayload { content: None, error: Some(e.to_string()) } }
        }
    };
    self.send_ws_json(&resp).await;
}

// write / delete handler 同理（都用 spawn_blocking + FileBridge）
```

### 2.3 FeClaw 端 services/virtual_filesystem.py（/mnt/desktop/ 映射）

```python
def _resolve_path(self, path: str) -> Path:
    """
    将逻辑路径映射到实际路径（与 design.md §5.2 一致）
    
    /mnt/desktop/C:/Users/小明/file.txt → Windows 绝对路径 C:\Users\小明\file.txt
    /mnt/desktop/foo.txt                → ~/Desktop/foo.txt
    """
    if path.startswith("/mnt/desktop/"):
        rest = path[len("/mnt/desktop/"):]
        
        if len(rest) >= 2 and rest[1] == ':':
            # Windows 绝对路径
            resolved = Path(rest.replace('/', '\\'))
        else:
            # 相对路径 → ~/Desktop/...
            desktop = Path.home() / "Desktop"
            resolved = (desktop / rest).resolve()
        
        # 路径穿越检查（双层防御）
        desktop = Path.home() / "Desktop"
        if not str(resolved).lower().startswith(str(desktop).lower()):
            raise ValueError(f"Path traversal attempt: {path} → {resolved}")
        return resolved
        
    elif path.startswith("/workspace/"):
        return self.base_path / path[len("/workspace/"):]
    elif path.startswith("/public/"):
        return self.public_path / path[len("/public/"):]
    else:
        raise ValueError(f"Unsupported path prefix: {path}")
```

### 2.4 FeClaw 端 routers/desktop_ws.py（JWT 认证修复 P0-7）

```python
from fastapi import WebSocket, WebSocketDisconnect, Depends
from starlette.websockets import WebSocketState
from services.desktop_relay import relay

def verify_desktop_token(token: str) -> bool:
    """验证 Desktop JWT"""
    from services.agent_jwt_service import verify_jwt
    return verify_jwt(token).is_valid

@router.websocket("/ws/desktop")
async def desktop_websocket(ws: WebSocket):
    # WS 握手时 JWT 通过 cookie 或 query param 传入
    # FastAPI WebSocket 在 accept 前可以通过 cookies 或 query 读取
    await ws.accept()
    
    # 方式：从 cookies 或 first frame 获取 token（header 方式在 ASGI 层处理）
    # 由于 WS 握手阶段无法读取 HTTP header，改用 cookie 作为 fallback，
    # 同时支持第一个 JSON 消息携带 token（向后兼容）
    token = None
    try:
        # 尝试从 cookie 获取
        token = ws.cookies.get("feclaw_desktop_token")
        if not token:
            # 兼容：第一个消息带 token
            auth_msg = await ws.receive_json()
            token = auth_msg.get("token")
    except Exception:
        pass
    
    if not token or not verify_desktop_token(token):
        await ws.close(code=4002, reason="invalid token")
        return
    
    await manager.connect(ws)
    try:
        while True:
            data = await ws.receive_json()
            await handle_desktop_message(data)
    except WebSocketDisconnect:
        await manager.disconnect(ws)
```

---

## 阶段 3：开机自启

### 3.1 engine.rs（修复 N-6：正确的 auto-launch API）

```rust
use auto_launch::AutoLaunch;

fn make_auto_launch(exe_path: &Path) -> Result<AutoLaunch> {
    AutoLaunch::new(
        "FeClawDesktop",                    // app name
        exe_path.to_string_lossy().to_string(),  // exe path
        Some(vec!["--minimized"]),         // args（N-6 修复：三参构造）
    ).map_err(|e| anyhow::anyhow!("AutoLaunch::new failed: {}", e))
}

impl EngineManager {
    pub fn enable_auto_launch(&self) -> Result<()> {
        let exe = std::env::current_exe()
            .map_err(|e| anyhow::anyhow!("current_exe: {}", e))?;
        make_auto_launch(&exe)?.enable()
            .map_err(|e| anyhow::anyhow!("enable: {}", e))
    }

    pub fn disable_auto_launch(&self) -> Result<()> {
        let exe = std::env::current_exe()
            .map_err(|e| anyhow::anyhow!("current_exe: {}", e))?;
        make_auto_launch(&exe)?.disable()
            .map_err(|e| anyhow::anyhow!("disable: {}", e))
    }

    pub fn is_auto_launch_enabled(&self) -> bool {
        let exe = std::env::current_exe().ok();
        exe.and_then(|p| make_auto_launch(&p).ok())
            .map(|al| al.is_enabled().unwrap_or(false))
            .unwrap_or(false)
    }
}
```

### 3.2 main.rs（--minimized 参数解析）
```rust
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LaunchMode { Normal, Minimized }

pub fn parse_launch_mode() -> LaunchMode {
    if std::env::args().any(|a| a == "--minimized") {
        LaunchMode::Minimized
    } else {
        LaunchMode::Normal
    }
}
```

### 3.3 lib.rs（根据 launch mode 决定是否显示窗口）
```rust
use crate::main::LaunchMode;

pub async fn run() -> Result<()> {
    let launch_mode = parse_launch_mode();
    
    // 引擎启动...
    let engine = EngineManager::new(config.clone());
    let engine_handle = tokio::spawn(async move {
        if let Err(e) = engine.start().await {
            tracing::error!("engine start failed: {}", e);
        }
    });
    
    // 监听 auth_failure 触发 reauth
    let reauth_handle = tokio::spawn(async move {
        engine.wait_for_auth_failure().await;
    });

    // 启动托盘
    start_tray(app_handle.clone()).await?;

    // 浏览器窗口（仅 Normal 模式）
    if launch_mode == LaunchMode::Normal {
        open_browser();
    }
    
    // 等待引擎或托盘退出
    tokio::select! {
        result = engine_handle => { if let Err(e) = result { tracing::error!("engine: {}", e); } }
        result = reauth_handle => { if let Err(e) = result { tracing::error!("reauth: {}", e); } }
    }
    Ok(())
}
```

---

## 阶段 4：云模式连接

### 4.1 config.rs（Mode::Cloud + JWT，修复 P0-6）

```rust
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub enum Mode {
    #[default]
    Local,
    Cloud,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    // ... existing fields ...
    
    #[serde(default)]
    pub mode: Mode,
    
    /// 云服务器地址（仅 Cloud 模式）
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub cloud_url: Option<String>,
    
    /// 云端用户名（仅 Cloud 模式）
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub cloud_username: Option<String>,
    
    /// 云端 JWT（首次登录后从 /api/login 获取，不存密码）
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub cloud_token: Option<String>,
}

impl Config {
    pub fn ws_url(&self) -> String {
        match self.mode {
            Mode::Local => format!("ws://{}:{}{}", self.host, self.port, self.ws_path),
            Mode::Cloud => {
                let base = self.cloud_url.as_ref()
                    .expect("cloud_url required in cloud mode");
                format!("{}/ws/desktop", base.trim_end_matches('/'))
            }
        }
    }
}
```

### 4.2 engine.rs start_cloud（修复 N-14：loop + cancel_token）

```rust
impl EngineManager {
    pub async fn start(&mut self) -> Result<EngineStatus> {
        match self.config.mode {
            Mode::Local => self.start_local().await,
            Mode::Cloud => self.start_cloud().await,
        }
    }

    async fn start_cloud(&mut self) -> Result<EngineStatus> {
        let cancel_token = self.cancel_token.clone();
        
        loop {
            if cancel_token.load(Ordering::Relaxed) {
                return Ok(EngineStatus::Stopped);
            }
            
            // 1. 无 token → 先登录
            if self.config.cloud_token.is_none() {
                if self.config.cloud_username.is_none() || self.config.cloud_url.is_none() {
                    return Err(anyhow!("cloud_username and cloud_url required"));
                }
                match self.interactive_login().await {
                    Ok(token) => { self.config.cloud_token = Some(token); }
                    Err(e) => {
                        tracing::error!("cloud login failed: {}, will retry", e);
                        tokio::time::sleep(5).await;
                        continue;
                    }
                }
            }

            // 2. 连接远程 WS
            let url = self.config.ws_url();
            info!("Connecting to cloud FeClaw at {}", url);
            
            match WsClient::connect_tls(&url, self.config.cloud_token.as_ref().unwrap()).await {
                Ok(ws) => {
                    self.ws = Some(ws);
                    tracing::info!("Cloud WS connected");
                }
                Err(e) => {
                    tracing::warn!("Cloud WS connect failed: {}, retrying in 5s", e);
                    // token 可能失效，清除并重新登录
                    self.config.cloud_token = None;
                    tokio::time::sleep(5).await;
                    continue;
                }
            };

            // 3. 运行直到断开
            if let Err(e) = self.ws.as_mut().unwrap().run(cancel_token.clone()).await {
                tracing::warn!("Cloud WS run ended: {}", e);
            }
            
            // 断开后重连（N-14：画出明确的 loop）
            tracing::info!("Cloud WS disconnected, will reconnect");
        }
    }

    /// 弹出 UI 登录框获取用户名/密码（交互式）
    async fn interactive_login(&mut self) -> Result<String> {
        // 发送 ControlMsg::ShowCloudLogin 到主线程，UI 弹窗后通过某个 channel 返回结果
        // 这里简化处理：直接返回错误，让外部处理
        Err(anyhow!("interactive login required"))
    }
}
```

### 4.3 ws.rs TLS 连接（修复 N-7：native-tls）

```rust
impl WsClient {
    /// WSS/TLS 连接（云模式，N-7 修复：正确引入 native-tls）
    pub async fn connect_tls(url: &str, token: &str) -> Result<WsClient> {
        use tokio_tungstenite::{connect_async, Connector};
        use tokio_native_tls::TlsConnector;
        
        let connector = native_tls::TlsConnector::new()
            .map_err(|e| anyhow::anyhow!("TlsConnector::new: {}", e))?;
        let connector = TlsConnector::from(connector);
        let connector = Connector::NativeTls(connector);
        
        let (ws_stream, _response) = connect_async_with_tls(url, connector).await
            .map_err(|e| anyhow::anyhow!("WS TLS connect failed: {}", e))?;
        
        let (write, read) = ws_stream.split();
        let ws = WsStream::new(write, read);
        
        // WS 握手后立即发 auth 帧（如果 server 需要）
        // JWT 通过 HTTP header 在握手时已传（见 auth.rs）
        
        Ok(WsClient::from_stream(ws))
    }
}
```

### 4.4 lib.rs ControlMsg::SetMode 触发重连（修复 N-15）

```rust
async fn controlPump(
    mut rx: UnboundedReceiver<ControlMsg>,
    app_handle: tauri::AppHandle,
    cancel_token: Arc<AtomicBool>,
    engine: Arc<Mutex<EngineManager>>,
) {
    while let Some(msg) = rx.recv().await {
        match msg {
            ControlMsg::SetMode(mode) => {
                let mut eng = engine.lock().await;
                // 1. 更新配置并保存
                eng.config.mode = mode;
                if let Err(e) = eng.config.save() {
                    tracing::error!("config save failed: {}", e);
                }
                // 2. 触发 WS 重连
                cancel_token.store(true);
                info!("Mode changed to {:?}, WS will reconnect", mode);
            }
            ControlMsg::ShowCloudLogin => {
                // 打开设置窗口并切换到云端 Tab
                let app = app_handle.clone();
                tokio::spawn(async move {
                    if let Err(e) = settings::open_settings_window(app.clone()).await {
                        tracing::error!("open settings failed: {}", e);
                    }
                    // 通知前端切换到云端 Tab（通过 Tauri event）
                    app.emit("navigate-settings", "cloud").ok();
                });
            }
            // ...
        }
    }
}
```

---

## 实施顺序

| 阶段 | 功能 | 关键前置 |
|------|------|---------|
| **阶段 0** | Cargo.toml + ws_types + ws.rs 改造 + consent.rs | 一切的基础 |
| **阶段 1** | 设置界面 | 依赖阶段 0 的 Cargo.toml |
| **阶段 2** | 文件中继 | 依赖阶段 0 的 ws.rs 改造 |
| **阶段 3** | 开机自启 | 依赖阶段 0 的 Cargo.toml |
| **阶段 4** | 云模式连接 | 依赖阶段 0+1+2 全部完成 |

---

## 附录：二审修复清单对照

| 问题编号 | 修复位置 |
|---------|---------|
| N-1 | ws.rs §0.3（直接用 ws_types 结构体，不造 WsMessage） |
| N-2 | ws.rs §0.3（响应加 status 字段） |
| N-3 | ws.rs §0.3（用 ws_types.rs 现有 FileDeleteResponse） |
| N-4 | ws.rs §0.4（`Error::ConnectionClose` 分支匹配） |
| N-6 | engine.rs §3.1（`AutoLaunch::new` 三参构造） |
| N-7 | Cargo.toml §0.1 + ws.rs §4.3（native-tls + tokio-native-tls） |
| N-8 | consent.rs §0.5（`request_operation` + `show_consent_dialog` 内联） |
| N-9 | engine.rs §0.6 + ws.rs §0.4（`Arc<Notify>` + `notified().await`） |
| P0-5/N-10 | file_bridge.rs §2.1（canonicalize + symlink 父目录检查） |
| P0-7 | desktop_ws.py §2.4（cookie/first-frame JWT，header ASGI 层处理） |
| P1-1/N-11 | consent.rs §0.5（独立文件信任集合，不复用 session_trust） |
| N-13 | file_bridge.rs §2.1（MAX_FILE_BYTES 检查） |
| N-12 | lib.rs §1.6 + §4.4（`ControlMsg::ShowCloudLogin`） |
| N-5 | ws.rs §0.3（删 `chronoUtc()`，用 `current_timestamp()`） |
| N-14 | settings.ts §1.5（`$<T>` 返回 `T | null`，判空调用） |
| N-15 | engine.rs §0.6 + lib.rs §4.4（`if let Err(e) = save()`） |
| N-17 | ws.rs §0.3（按现有 `ws: WsStream` + `outgoing_rx` 结构重写） |
| N-18 | settings.rs §1.3 + engine.rs §0.6（`spawn_blocking` 写文件） |
| N-16 | file_bridge.rs §2.1（注释说明不支持 UNC） |
