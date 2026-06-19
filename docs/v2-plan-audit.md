# FeClaw Desktop V2 开发计划 — 架构评审

> 评审对象: `docs/v2-plan.md`
> 评审日期: 2026-06-19
> 评审范围: 技术可行性 / 架构一致性 / 安全 / 实现风险 / 遗漏项 / FeClaw 端实现
> 参考: `docs/design.md`, `docs/progress.md`, 当前 src-tauri 代码, FeClaw 端 desktop_* 模块

---

## 总体评价

V2 计划在功能维度覆盖完整、与设计规范总体对齐，但在**依赖声明、路径映射、类型签名、跨进程架构边界**上存在多处事实错误和重要安全遗漏。如果按计划原文实现，编译期就会失败（`auto-launch`、`expand_user` 等 API 不存在），且路径穿越防护形同虚设。建议先做一轮与设计规范 + 现状代码的精对账再实施。

---

## 详细问题

### 🔴 P0（阻塞）

#### P0-1 `auto-launch` 依赖未声明，与计划声称不符
- **现状**: `src-tauri/Cargo.toml` 第 17-32 行无 `auto-launch`；`Cargo.lock` 中也找不到。
- **计划原文**: §1.1 声称 `auto-launch = "0.5"  # 已在 Cargo.toml，无需新增`，这是错的。
- **后果**: `use auto_launch::{AutoLaunch, AutoLaunchConfig};` 直接编译失败。
- **修复**: 必须把 `auto-launch = "0.5"` 加进 Cargo.toml；同时注意该 crate 的 Windows 实现要求 manifest 中有 `identifier` 字段，否则 MSIX/打包路径下注册表项可能被杀毒软件告警。

#### P0-2 `Path::expand_user()` 不是 std API，依赖未声明
- **现状**: Rust std `Path` 没有 `expand_user()` 方法。
- **计划原文**: §2.2 `Path::new(ENV_PATH).expand_user()`、`ENV_PATH = "~/.feclaw/.env"`。
- **后果**: 编译失败。
- **修复**: 引入 `dirs = "5"` 或 `home = "0.5"` 等 crate（`dirs` 已经在 Cargo.lock 中作为 transitive 存在）。或者用 `dirs::home_dir()` 替代自己写展开逻辑。同时 Windows 下 `~/.feclaw/.env` 实际路径应为 `%USERPROFILE%\.feclaw\.env`，要注意前后斜杠。

#### P0-3 V2 文件 handlers 的返回类型签名与现有 ws_types.rs 不一致
- **现状** (`src-tauri/src/ws_types.rs`):
  - `FileReadResponse { id, status, timestamp, payload: FileReadResponsePayload { content: Option<String>, error: Option<String> } }`
  - 没有 `FileWriteResponse` 类型（V2 计划 §3.1 用到了，但 ws_types.rs 没定义）
- **计划原文**: §3.1
  ```rust
  FileReadResponse { content: None, error: Some("denied".into()) }
  FileWriteResponse { error: Some("denied".into()) }
  ```
- **后果**: 编译失败；需要先扩展 ws_types.rs。
- **修复**: 在 ws_types.rs 补 `FileWriteResponse` / `FileWriteResponsePayload` 类型；handler 用全字段结构体初始化（或加 `#[derive(Default)]` + `..Default::default()`）。

#### P0-4 `_resolve_desktop_path` 与 design.md §5.2 的路径映射规则不符（关键安全/语义错误）
- **design.md §5.2 表格明确**:
  - `/mnt/desktop/C:/Users/小明/file.txt` → `C:\Users\小明\file.txt`
  - `/mnt/desktop/D:/data/` → `D:\data\`
  - 即 `/mnt/desktop/` 之后是**绝对 Windows 路径**，不是相对路径。
- **V2 计划 §3.4**:
  ```python
  relative = path[len("/mnt/desktop/"):]
  return str((desktop / relative).resolve())   # 拼到了 ~/Desktop 下
  ```
- **后果**:
  1. Agent 用设计文档承诺的路径 `/mnt/desktop/C:/Users/小明/成绩.csv` 会变成 `C:\Users\<运行用户>\Desktop\C:\Users\小明\成绩.csv` —— 这个路径在 Windows 上根本不存在（出现两个 `:`）。
  2. 与设计文档约定的 Windows 路径映射完全相反。
  3. §3.5 的 vfs.py 改写直接照搬错误语义，会让整个 VFS 的 `/mnt/desktop/` 子树错位。
- **修复**: 必须按 design.md 实现：若 `/mnt/desktop/` 后跟 `^[A-Za-z]:/`，则**直接把后面部分当绝对路径**（Windows 上拼 root）；否则按 macOS/远期约定拼 `~/Desktop/`。同时只在 Desktop 端做路径穿越检查，**不要只在 FeClaw 端做**（见 P0-5）。

#### P0-5 路径穿越防护实际未生效，仅在 FeClaw 端且实现漏洞
- **计划原文 §3.4**:
  ```python
  def _resolve_desktop_path(path: str) -> str:
      if not path.startswith("/mnt/desktop/"):
          raise ValueError(f"Invalid path: {path}")
      desktop = Path.home() / "Desktop"
      relative = path[len("/mnt/desktop/"):]
      return str((desktop / relative).resolve())
  ```
- **问题**:
  1. 完全没有任何"结果必须在 desktop 目录内"的检查（plan §3.5 的注释写了，代码里没有）。
  2. `str(resolved).startswith(str(desktop_dir))` 在 Windows 上会失败：NTFS 大小写不敏感，但 Python `str(Path)` 会保留原始大小写，而 `Path.home()` 在 Windows 上返回 `C:\Users\xxx`，用户路径可能是 `C:\users\xxx`。
  3. **没有 symlink/hardlink 检查** —— 攻击者可以在 Desktop 内放一个指向 `C:\Windows\System32\config\SAM` 的符号链接（如果桌面有该权限的话）。
- **计划原文 §3.1 写的是 Desktop 端**也应该做检查，但实际 handler 直接 `tokio::fs::read(path)` 把 payload.path 当成本机路径，**Desktop 端零检查**。
- **后果**: 设计文档 §5.3 "白名单" 提到的安全约束完全没实现，恶意 Agent 可以读 `C:\Users\<user>\.ssh\id_rsa` 等。
- **修复**:
  1. Desktop 端必须在收到 `file_*_request` 后、用相对路径解析前做：
     - 绝对路径解析（支持设计文档约定的 Windows/macOS 路径映射）
     - `canonicalize()` 后必须 `is_relative_to(&allowed_roots)` 检查
     - 大小写不敏感比对（Windows）
     - 对中间每个父目录做 symlink 拒绝（`is_symlink()`）
  2. FeClaw 端 `_resolve_desktop_path` 也需要白名单 + 同样的检查，作为双层防御。
  3. 白名单需要做成配置项（设计文档 §5.3 的"用户在设置中增删白名单"必须落实）。

#### P0-6 云模式密码明文持久化
- **计划原文 §4.1**:
  ```rust
  pub cloud_password: Option<String>,  // 与 mode/url/username 一起持久化
  ```
  Config 结构体通过 `Config::save()` 写到 `~/.feclaw/config.toml`（TOML 明文）。
- **问题**:
  1. **密码不应存盘**。本地凭据机制 (`auth.rs`) 用的是"首次启动拿随机密码 → 立刻换 JWT → 丢弃密码"的模式，密码只在内存中存在。V2 把密码作为 Config 字段会污染这个模型。
  2. JWT 有 TTL，过期再重新登录即可；密码不需要长期保存。
- **后果**: 用户机器被入侵 → 攻击者拿到云端账号长期密码。
- **修复**: 去掉 `cloud_password`，密码只在登录瞬间使用一次换取 JWT；JWT 存到 `~/.feclaw/cloud-token`（与 design.md §3.2 "Desktop 保存 JWT 到 ~/.feclaw/cloud-token" 一致）。Token 过期时再走一次交互式登录。

#### P0-7 FeClaw 端 JWT 认证方式与 design.md §4.1 不一致
- **design.md §4.1**:
  ```
  请求头: Authorization: Bearer <JWT>
  端点:   /ws/desktop
  引擎/云端验证 JWT 后建立连接。
  ```
- **V2 计划 §4.5**:
  ```python
  await ws.accept()
  auth_msg = await ws.receive_json()      # 先 accept 再收消息
  if auth_msg.get("type") != "auth": ...
  ```
- **问题**:
  1. 已经在 WS 握手前没有 JWT 校验，任何人只要能连到端口就能进入消息循环（虽然马上被踢）。
  2. 当前 Desktop 端（`src-tauri/src/ws.rs:147`）已经把 JWT 放在 `Authorization` header 里了 —— 设计已经定型为 header 方式，V2 计划却改成"先握手后 auth"消息协议，**两端对不上**。
- **后果**: 如果服务端按计划改成消息式 auth，Desktop 端发出的连接请求会立即被服务端拒绝（因为 token 在 header 里，服务端却期待 JSON 消息）。
- **修复**: 统一为 design.md 定义的 header 方式；在 FastAPI 端用 WebSocket 路由的 `dependencies` 或中间件校验 JWT，不要在 handler 里手撸。

---

### 🟡 P1（重要）

#### P1-1 `ConsentManager::request()` 现有签名不接受 risk 等级
- **现状** (`src-tauri/src/consent.rs:135`): `pub async fn request(&mut self, command: &str, cwd: Option<&str>) -> Decision` —— 内部自己算 risk。
- **计划原文 §3.1**: `self.consent.request(path, risk)` —— 期望新签名 `(path, RiskLevel)`。
- **后果**: 编译失败，且会改变 `command_exec` 路径下 `session_trust` 的语义（文件名作为 trust key 不可接受）。
- **修复**: 给 ConsentManager 加新方法，例如 `request_with_risk(operation: &str, risk: RiskLevel, display: &str)`；不要复用 `request()`，否则命令信任列表会混入文件路径。

#### P1-2 `self.exe_path` 字段在 EngineManager 中不存在
- **计划原文 §1.3**: `let al = make_auto_launch("FeClawDesktop", &self.exe_path);`
- **现状**: EngineManager 只有 `config: Config`；Config 没有 `exe_path` 字段（只有 `engine_path: Option<String>` 指向 **feclaw 引擎**路径，不是 Desktop 自身）。
- **修复**: auto-launch 路径应该用 `std::env::current_exe()` 获取 Desktop 自己，不是从 EngineManager 取。

#### P1-3 `Config::ws_url()` 的现有签名被计划覆盖
- **现状** (`config.rs:93`): `pub fn ws_url(&self) -> String` 只返回 ws://host:port/ws/desktop。
- **计划原文 §4.1**: 同样叫 `ws_url()`，但加了 mode 分发逻辑。
- **修复**: OK，但要注意 plan §4.5 又写"Desktop 自动登录引擎 POST http://127.0.0.1:8080/api/login"（design.md §3.1 的本地模式逻辑），但 §4 整体描述的是云模式。云模式**不应该**尝试本地引擎登录。`engine.rs::start()` 重写为 `start() -> match mode { Local => start_local, Cloud => start_cloud }` 时，需要让 `start_cloud` 完全跳过 engine spawn/健康检查/stdout 扫描流程。当前 `startup()` 在 lib.rs 串行地"启动 engine → 扫描密码 → 登录"，云模式需要把这一段拆掉。计划没写。

#### P1-4 WSS / TLS 不支持
- **现状** (`src-tauri/src/ws.rs:151`): `client_async(req, None)` —— `None` 表示不使用 TLS connector。
- **计划原文 §4.1**: 云模式 URL 是 `https://your-server.com`，ws_url 生成 `wss://...`
- **后果**: WSS 握手直接失败，连不上云端。
- **修复**: 引入 `tokio-tungstenite::connect_async_tls` 或手动传 `tokio_rustls::TlsConnector`；Cargo.toml 的 `tokio-tungstenite` 当前 features 是 `connect` + `rustls-tls-webpki-roots`，需要再开启 `native-tls` 或显式传 TLS connector。

#### P1-5 设置页 HTML 文件路径错误
- **计划原文 §2.1**:
  ```
  src-tauri/
    pages/
      settings.html
      settings.css
      settings.ts
  ```
- **Tauri 2 静态资源规则**: WebView 加载的资源必须在 `tauri.conf.json` 的 `frontendDist` / `devUrl` 指向的目录里，**默认就是 `src-tauri/src/` 或独立 `dist/`**。`src-tauri/pages/` 不会被 Tauri 服务，会出现 404。
- **修复**: HTML/CSS/TS 必须放在 `src/` 目录下（或专门的 `dist/`），且 §2.5 中 `let url = "pages/settings.html"` 要改成 `"settings.html"` 或 Tauri 的 asset protocol URL。

#### P1-6 Tauri 2 创建窗口的 API 不存在
- **计划原文 §2.5**:
  ```rust
  tauri::Window::new("settings", url, tauri::WindowOptions::default())
  ```
- **现状**: Tauri 2 已经没有 `tauri::Window::new()`；正确方式是 `tauri::WebviewWindowBuilder::new(handle, "settings", tauri::WebviewUrl::App("settings.html".into()))`。还需要权限配置（`with_url` 或在 capabilities 里加 `default`）。
- **后果**: 编译失败。

#### P1-7 `executor.rs` 不应承担 file_* 方法
- **计划原文 §3.2** 把 `file_read/file_write/file_delete` 加进 `CommandExecutor`。
- **现状**: `CommandExecutor` 是"subprocess 执行器"，职责清晰。文件 I/O 不是它的活。
- **后果**: 概念混淆，未来给 file ops 加独立的超时/限流/配额逻辑会卡。
- **修复**: 新建 `file_bridge.rs`（或合并进 `ws.rs`），与 executor 解耦。

#### P1-8 `auto-launch --minimized` 参数没人处理
- **计划原文 §1.3**: `args: Some("--minimized")`
- **现状**: `lib.rs::run()` / `startup()` 不解析命令行参数，`main.rs` 也没看到。
- **后果**: 开机自启会以全功能启动（弹浏览器、弹托盘等），与"启动时仅托盘常驻"的目标不符。
- **修复**: 在 main.rs / lib.rs 增加 `std::env::args()` 解析，启动时若发现 `--minimized` 则跳过浏览器打开步骤。

#### P1-9 `assess_risk(&format!("cat {}", path))` 语义错乱
- **计划原文 §3.1**:
  ```rust
  let risk = assess_risk(&format!("cat {}", path));
  if risk >= RiskLevel::L2 { ... }
  ```
- **问题**: `assess_risk` 看的是**第一个 token**，所以 `cat /path/foo` 永远落到 L1，**L2+ 弹窗分支永远不进**。
- **后果**: 写文件/删除文件的 L2/L3 弹窗确认完全失效，所有写删操作都默默执行。
- **修复**: 文件 handlers 不要走 `assess_risk`，直接根据操作类型（read → L1 静默，write → L2 弹窗，delete → L3 弹窗）判定；或者扩展 ConsentManager 让它能接收显式 risk。

#### P1-10 FeClaw 端 `_resolve_desktop_path` 是同步 IO 嵌入异步路由
- **计划原文 §3.4**: `with open(resolved, "rb") as f: f.read()` 同步阻塞。
- **现状**: FastAPI 在 threadpool 里跑同步函数，但每个 WebSocket 消息都在事件循环里。
- **后果**: 文件很大时阻塞整个 desktop_ws 端点的其他消息处理（包括心跳响应、其他 Agent 请求）。
- **修复**: 用 `asyncio.to_thread(open, ...)` 或 `aiofiles` 包；大文件要流式分块（>1MB 时分帧发送，避免 WS 帧大小限制）。

#### P1-11 `desktop_relay.py` 与 cloud 模式重连职责混淆
- **计划原文 §4.6**:
  ```python
  class DesktopRelay:
      async def keep_alive(self): ...
      async def _reconnect(self): ...
  ```
  把 ping/reconnect 逻辑放在 `desktop_relay.py`（**服务端**模块）。
- **现状**: `DesktopRelay` 是 server 侧的 channel 代理（向 Desktop 推消息）。重连是 **Desktop 客户端**的事，应该在 `src-tauri/src/ws.rs::run()` 的外层循环里。
- **后果**: 把客户端逻辑放进了服务端模块，且与现有 `run()` 30 次重连循环（ws.rs:101-126）冲突（两套机制会同时触发，状态不一致）。
- **修复**: cloud 重连完全是 Desktop 端的事，放在 ws.rs 内；服务端 (`desktop_relay.py`) 只负责**检测 Desktop 断开**并通知 Agent（"Desktop 已下线"事件）。

#### P1-12 JWT 过期后无自动重新登录
- **design.md §4.1**: "JWT 过期时服务端关闭连接，Desktop 重新登录。"
- **V2 计划**: 没看到 Desktop 侧 401/close(4001) → 触发 `login_cloud()` → 用保存的密码或刷新 token 的循环。
- **后果**: 云端 JWT 一过期 Desktop 就再也连不上，只能重启。
- **修复**: 在 WsClient::run_inner 检测到 close code 是 4xxx 时进入"重新登录 → 重连"分支；密码按 P0-6 修复后走"交互式重新登录"（弹窗让用户重新输入，或引导到设置页）。

#### P1-13 `Mode::default()` 实现 vs plan 不一致
- **现状** (`config.rs:29-39`): Config 的 `Default` 已经实现，`mode: Mode::Local`。
- **计划原文 §4.1**: 重新定义了 `impl Default for Mode { fn default() -> Self { Mode::Local } }`。
- **问题**: `Mode` 是枚举，本身就有隐式 `Mode::Local` 是默认；写一个空的 `impl Default` 也行，但意义不大；真正需要的是**新加 `cloud_url/username/password/token` 等 Option 字段**及其向后兼容的反序列化（用 `#[serde(default)]`），不然旧 config.toml 加载会失败。
- **修复**: 给新字段加 `#[serde(default)]` 标注；Default impl 不需要重写。

#### P1-14 `start_cloud` 重连循环没有取消机制
- **计划原文 §4.1**:
  ```rust
  async fn login_cloud(&self) -> Result<String> {
      // ...
      self.ws.as_ref().unwrap().send_json(...).await?;
  }
  ```
  没有提供"用户切回 Local 模式 → 立刻断开云端"的路径。
- **现状**: lib.rs 已经有 `ControlMsg::SetMode(Mode)` 和 `cancel_token`，但 plan 没复用。
- **后果**: 切模式后旧的 ws 客户端仍在 reconnecting。

#### P1-15 `ControlMsg::SetMode(Mode)` 当前只更新 Config，不重启 WS
- **现状** (`lib.rs:170-178`): 切模式只 `cfg.save()`，**WS 还在用旧 URL**。
- **V2 计划**: 没说怎么把 mode 变化反映到 ws 重连。
- **修复**: SetMode 处理里应该 `cancel_token.store(true)` 触发 ws 重建，重建时按新 mode 选 URL（Local → spawn engine + connect localhost；Cloud → login + connect wss）。

---

### 🟠 P2（建议）

#### P2-1 V2 §4.5 提到 `/auth/login` 端点与 design.md `/api/login` 不一致
- design.md §3.1 / §3.2 全文统一用 `/api/login`；plan §4.1/§4.3 用 `/auth/login`。
- 建议: 沿用 `/api/login`，让本地和云端用同一接口；响应字段保持 `{token}` 或 `{access_token}` 二者皆可（auth.rs 已经兼容）。

#### P2-2 `keep_alive` 的 25s ping 间隔与设计规范的 30s 心跳不一致
- design.md §4.2: "Desktop ── Ping (30s 间隔) → 引擎"。
- plan §4.6: 25s。
- 建议: 统一 30s，留余量避免"两端都按 30s 计时但时钟漂移导致误判"。

#### P2-3 settings.html 加载顺序问题
- plan §2.4 用 `import { invoke } from "tauri/api"`，Tauri 2 已改成 `@tauri-apps/api/core`。
- 修复: `from "@tauri-apps/api/core"` 或直接用全局 `window.__TAURI__.core.invoke`。

#### P2-4 `settings.html` 的 emoji 按钮（💾 / ⚙️）可加但要注意 Windows 上 WebView2 字体回退
- 当前 emoji 在 Windows 中文环境通常显示正常，但若目标用户装了繁体/简体的奇怪字体子集，可能渲染异常。
- 建议: 把 emoji 换成 SVG 或文字标签。

#### P2-5 `expand_user` 与 `~` 在 Windows 路径语义
- `%USERPROFILE%` 与 `~` 在 Windows 上不一定等价（`~` 是 bash 概念，PowerShell 用 `$HOME`）。
- 建议: `Settings → 高级` 加 "打开 ~/.feclaw 目录" 按钮，用 `dirs::home_dir().join(".feclaw")` 直接给绝对路径，避免一切 `~` 转换。

#### P2-6 V2 plan 没有错误处理章节
- 实施时建议补一份 error matrix：
  - 引擎启动失败（exe 缺失、端口被占）
  - WS 认证失败（401 / 4001）
  - 文件 I/O 失败（ENOENT / EACCES / 路径穿越被拒）
  - 云端 JWT 过期（关闭连接 → 重新登录流程）
  - 设置保存冲突（用户在 GUI 改时托盘也改）

#### P2-7 增量持久化的失败恢复
- 设计文档 §7.2 提到 "Desktop 写入配置" 时要保留用户已有的 `.env` 键（JWT_SECRET、LLM API Key）。
- V2 计划 §2.2 `save_settings` 直接 `env.insert(k, v)` 覆盖；但 `MINIMAX_API_KEY` 这种敏感字段应支持只写一次（用户在 GUI 不该看见明文），而 `load_env` 会把明文返回给前端 → **泄露到前端 DOM**。
- 建议: 前端只显示 masked（`sk-*****`），提交时如果不空才覆盖。

#### P2-8 V2 plan 的 `executor.rs` file_* 方法与 `ws.rs` file_* handler 重复
- 同一个功能在两处实现，调用关系不清（谁用谁？）。
- 建议: 把 file I/O 抽到独立模块，两边共用；executor.rs 保持只管 subprocess。

#### P2-9 缺少文件大小上限
- plan §3.1 `tokio::fs::read(path)` 一次性把整个文件读进内存再 base64 编码。
- 一个 4GB 视频会把 Desktop 内存打爆，base64 后还会再膨胀 33%。
- 建议: 与 executor.rs 的 `MAX_OUTPUT_BYTES = 1MiB` 对齐，超大文件分块或拒绝。

#### P2-10 `auto-launch` 在 Windows 上对单 exe 友好，但 MSI 安装后行为不同
- 当前单 exe 模式（设计文档 §9）下，`std::env::current_exe()` 返回 exe 路径，注册表写 `HKCU\...\Run\FeClawDesktop.exe`。
- 但 V2 计划里没说"开机自启时是否还要 `--minimized`"。如果用户设置里关闭了"开机自启 → 启动时自动最小化"，会出现开机弹浏览器的体验。
- 建议: 在 Settings UI 里把"开机自启"和"启动后最小化"做成两个独立 toggle。

#### P2-11 `path.startswith("/mnt/desktop/")` 对 Windows 路径的兼容
- FeClaw 跑在服务器上（Linux bwrap 沙箱），不会跑 Windows；这是 Python 端逻辑可以这么写。但 plan §3.4 没考虑 FeClaw 服务端在 Windows 上部署的远期情况（macOS 开发模式？）。
- 建议: 写一个跨平台 helper，别把 `"/"` 写死。

#### P2-12 V2 §3.3 router 与现有 `handle_desktop_message` 不一致
- 现有 `routers/desktop_ws.py:69` 的 `handle_desktop_message` 处理 `consent_response` / `pong`。
- V2 §3.3 在 router 的 `while True` 循环里直接 `handle_file_read_request` 等，会**绕开**现有 dispatch。
- 修复: 走 `handle_desktop_message(data)` 的 switch 风格，否则未来再加消息类型时容易漏掉。

#### P2-13 状态指示器缺 cloud 模式
- design.md §4.2 列了 4 个图标状态，但 V2 计划没在 tray.rs 加 cloud 模式视觉区分。
- 建议: 已连 Cloud 时托盘图标加一圈边框或不同 base color。

#### P2-14 MVP 已有功能未联动
- 现有 `notification` 消息类型在 ws.rs:311 用 `rfd::MessageDialog` 弹**阻塞模态对话框**（"OK 按钮"）。
- 这违反 design.md §4.2 "冒泡提示（非阻塞）" 的精神；V2 应顺手用 `tauri-plugin-notification` 替换。
- 不是阻塞性问题，但既然要做设置 UI，正好一起做。

---

### 🟢 通过

- **V2 §3.3 整体思路**: FeClaw 端用 `handle_file_*_request` 把请求转给 `relay.file_*`，架构合理。
- **V2 §3.1 base64 编码二进制文件**: 协议选择合理（WS Text 帧走 base64）。
- **V2 §2.3 设置页面 UI 分组**: 存储/连接/启动/API 分块清晰。
- **V2 §4.6 重连指数退避 5 次封顶**: 比 ws.rs::run 的 30 次 1s 间隔更克制（云端适用场景），但要与客户端 ws.rs 的现有 30 次机制协调（见 P1-11）。
- **auth.rs::extract_password_from_stdout**: 测试覆盖好，不动。
- **risk assessment (consent.rs)**: L1-L5 分级与 design.md §6.4 一致。
- **ws.rs::run 30 次重连 + 1s 间隔**: 与 design.md §4.2 一致。
- **Config::find_free_port 端口扫描**: 实现完整（test 覆盖）。

---

## 实施建议

按下面顺序实施可以避免前期返工：

### 阶段 0 — 类型与依赖对齐（半天）
1. **补 Cargo.toml 依赖**: `auto-launch = "0.5"`, `dirs = "5"`, `base64 = "0.22"`, 必要时 `tauri-plugin-notification = "2"`。
2. **补 ws_types.rs**: 增加 `FileWriteResponse` / `FileWriteResponsePayload` 类型，给所有新字段加 `#[serde(default)]`。
3. **补 design.md 中缺的设计细节**: 把 P0-4（Windows 路径映射）、P0-6（云密码不留盘策略）写进 design.md，避免计划与设计脱节。

### 阶段 1 — 设置 UI（1-2 天，先做这个解锁后面所有需要配置的项）
- **原因**: cloud URL、auto-launch、白名单、token 持久化路径都需要在 UI 里改。P0-4 路径映射必须在阶段 1 就验证通过。
- 文件结构按 Tauri 2 实际要求修：HTML/TS 放 `src/`，不用 `pages/`。
- 同时实现 P1-5/1-6 的 Tauri 2 API 修正。

### 阶段 2 — 文件中继（2-3 天）
- **必须先做**: Desktop 端文件 handlers（§3.1） + 路径白名单检查（修 P0-5）。
- 再做 FeClaw 端 `_resolve_desktop_path`（**修 P0-4 的路径映射 bug**）。
- 最后接 vfs.py 的 `/mnt/desktop/` 映射（注意 P1-12：不要破坏现有 `_resolve_path` 的 `/workspace/` `/public/` `/config/` 三个分支）。

### 阶段 3 — 开机自启（0.5 天）
- 最简单、独立性最强；放在这里是因为 Settings UI（阶段 1）做完后，用户才能从 UI 勾选。

### 阶段 4 — 云模式连接（2-3 天，**最后做**）
- 依赖: WSS/TLS（P1-4）、JWT 过期重登（P1-12）、Mode 切换触发 ws 重连（P1-15）、密码不留盘（P0-6）。
- 必须先做端到端联调：本地模式 → 切云 → 切回本地。

### 不要并行做的项
- **§3.4 `_resolve_desktop_path` 和 §3.5 vfs.py `/mnt/desktop/` 映射**: 必须先与 design.md §5.2 对齐再动手（修 P0-4）。如果照 plan 原文写完，整个 VFS 子树错位，回滚成本高。
- **§4 cloud password 字段**: 决定"用密码"还是"用 token"再动手；中途改字段名会让所有 .toml 文件迁移麻烦。