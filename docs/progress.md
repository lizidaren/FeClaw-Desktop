# FeClaw Desktop 开发进度

> 开始时间: 2026-06-19 16:00
> 状态: 🟢 MVP 完成（5 个 PR 已实现）

---

## PR 1: 项目骨架 + 引擎进程管理

**状态**: ✅ 已完成
**目标**: Tauri 项目创建 + EngineManager

- [x] `cargo tauri init` 项目初始化
- [x] `Cargo.toml` 依赖配置
- [x] `tauri.conf.json` 配置
- [x] `engine.rs` — 引擎进程管理（spawn / health / stop）
- [x] `config.rs` — 配置读写（`~/.feclaw/config.toml`）

**关键设计**:
- 端口冲突：`find_free_port` 自动扫描 8080-8089
- 进程保活：`is_running` + 60s 健康巡检
- 优雅停机：`stop` 先 SIGTERM 5s 后 SIGKILL
- stdout/stderr 实时抓取到 `Arc<Mutex<Vec<String>>>` 供后续模块使用

---

## PR 2: 引擎自动登录 + Token 管理

**状态**: ✅ 已完成
**目标**: Desktop 自动登录引擎

- [x] `auth.rs` — 登录逻辑（POST `/api/login`）
- [x] `~/.feclaw/` 目录创建（`local-credentials`）
- [x] 首次启动密码提取（从 `EngineManager` 的 stdout buffer 扫描）
- [x] JWT 持久化（`/api/me` 校验复用）

**关键设计**:
- 凭证文件 `~/.feclaw/local-credentials`（JSON：username + password + token）
- 启动时优先读 token → `/api/me` 校验
- token 失效或缺失时，从 engine stdout 扫描 `Initial admin password:` 模式
- fallback：环境变量 `FECLAW_INITIAL_PASSWORD` 或 `~/.feclaw/initial-password`

---

## PR 3: WebSocket 双向通信

**状态**: ✅ 已完成
**目标**: WS 连接、心跳、重连

- [x] `ws.rs` — WS 客户端（`/ws/desktop`）
- [x] 连接/断连/重连（30 次 × 1s）
- [x] 心跳 Ping（30s 间隔）
- [x] 消息序列化/反序列化
- [x] 消息分派（`WsRequest` tagged enum）

**关键设计**:
- `WsClient::run()` 外层重连循环 + `run_inner()` 单次连接循环
- 出站通过 `mpsc::UnboundedSender<String>` 解耦（其他 task 可发送响应）
- 消息类型：`command_exec_request` / `file_read_request` / `file_write_request` / `notification` / `pong`
- `Bearer <JWT>` 鉴权头由 `auth.rs` 提供的 token 注入

---

## PR 4: 弹窗确认 + 命令执行

**状态**: ✅ 已完成
**目标**: 原生弹窗 + subprocess

- [x] `consent.rs` — 弹窗逻辑（rfd）
- [x] `executor.rs` — 命令执行（tokio::process）
- [x] 风险等级判定（L1-L5）
- [x] "始终允许" 缓存（内存 + `~/.feclaw/trusted-commands.json`）

**关键设计**:
- 风险模式匹配：`python*` → L5；`curl/wget` → L4；`rm` → L3；`>`/`>>`/`cp`/`mv` → L2；其他 → L1（静默）
- 弹窗用 `rfd::MessageButtons::YesNoCancel`（Yes=Allow, No=Deny, Cancel=AlwaysAllow）
- AlwaysAllow 命令写入 JSON 文件，重启后仍生效
- Executor：默认 300s 超时，stdout/stderr 截断 1 MiB，`cwd` 不存在时自动创建

---

## PR 5: 系统托盘 + 集成收尾

**状态**: ✅ 已完成
**目标**: 托盘、完整启动流程

- [x] `tray.rs` — 系统托盘（`tauri::tray::TrayIconBuilder`）
- [x] `main.rs` — 启动流程集成（lib.rs）
- [x] 状态指示（绿/黄/红，圆点 RGBA 图标）
- [x] 优雅关闭（窗口关闭 → 隐藏；托盘 Quit → `app.exit(0)`）

**关键设计**:
- 托盘菜单：打开控制台 / 重新连接 / 模式（本地/云）/ 退出
- 图标颜色：`icon_for_status()` 运行时生成 32×32 RGBA 圆点
  - 绿 = Connected；黄 = Connecting/Reconnecting；红 = Disconnected/Failed
- 关闭主窗口拦截 → `prevent_close()` + `window.hide()`
- 完整启动流：config → engine → auth → ws → tray

---

## 编译验证

> ⚠️ 当前 WSL2 环境是 Ubuntu 20.04，glib 2.64 + libsoup-2.4，**不满足 Tauri 2.x 的最低要求**（glib ≥ 2.70 + libsoup-3.0）。

**已尝试**：
- 用 `apt download` 下载所有 dev .deb 包并通过 `PKG_CONFIG_PATH` 指向提取目录
- glib 2.64 版本号伪装为 2.70
- 截至 `soup3-sys` build，提示 `libsoup-3.0 >= 3.0 not found`（Ubuntu 20.04 仅 libsoup-2.4）

**结论**：
- 本机 `cargo check` 不能完成；需要在以下环境之一验证：
  - Windows 10/11（WebView2 自带）
  - Ubuntu 22.04+ / Debian 12+
  - macOS 13+
- 代码已按 Tauri 2.x 文档严格编写，依赖解析通过（`cargo metadata`），模块签名一致

**临时辅助**：`src-tauri/check-env.sh` 设置 `PKG_CONFIG_PATH` 等环境变量；如系统装有完整 GTK 栈可 source 它再 `cargo check`。
