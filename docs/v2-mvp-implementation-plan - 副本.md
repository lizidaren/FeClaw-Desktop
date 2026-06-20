# FeClaw Desktop V2 MVP 实施方案

> 目标：今晚完成一个可用的 MVP，明天早上用户能登录官方平台、看到聊天界面、体验文件操作。

---

## P0 — 核心功能（今晚必须完成）

### P0.1 camelCase 全面适配
- 检查所有 `#[tauri::command]` 参数名 → 前端 invoke 传的 JavaScript key 必须用 camelCase
- 已知问题：`login_url` → `loginUrl`（已修复，但需验证 ts/js 中所有引用）
- 检查 `get_cloud_session`、`cloud_disconnect`、`file_read/write/delete` 等

### P0.2 `.well-known/feclaw-desktop`（FeClaw 引擎端）
- **文件：** `FeClaw/routers/well_known.py`
- 响应：`{version, name, auth: {type, endpoint}, ws_path}`
- `type = "platform"` 当 `OAUTH_ENABLED=True`，否则 `"local"`
- Old FeClaw 无此端点 → Desktop fallback 到 local

### P0.3 欢迎页
- **文件：** `src-tauri/src/welcome/index.html` + `.css` + `.ts` → `.js`
- `lib.rs` 注册：`check_first_launch` / `save_welcome_config`
- 检测 `~/.feclaw/config.toml`
- 三张卡片：官方 / 自建 / 本地

### P0.4 云模式完整登录
- 两个 URL 分开（服务器地址 + 平台地址）
- 正确的 camelCase 参数 `loginUrl`
- POST `/api/auth/login` → 保存 JWT → WS 连接

### P0.5 Desktop 消息渠道（WS 协议）
- Cloud WS 连接后，消息双向流通
- Desktop 作为独立消息渠道（区别于 WeChat / FeChat）
- Agent 可以通过 Desktop 渠道发消息、请求文件操作

### P0.6 主 UI 聊天界面
- **文件：** `src-tauri/src/chat/index.html` + `.css` + `.ts`
- 消息气泡（Agent / 用户）
- 输入框 + 发送按钮
- 连接状态指示器 🟢🟡🔴⚪
- 文件操作同意按钮在聊天框内

---

## P1 — 重要功能（今晚尽量做）

### P1.1 本地模式方案 C
- **文件：** `src-tauri/src/local_setup.rs` + `local_setup/index.html` + `.ts`
- 9 个 Tauri 命令：check_git/check_python/clone/write_env/pip_install/start_engine/check_health
- 引导式配置窗口

### P1.2 文件操作在聊天框内
- file_read/write/delete 的同意/拒绝弹窗在聊天界面内
- 不在独立的 Windows 对话框

---

## P2 — 锦上添花

### P2.1 设置页全部激活
- 外观 Tab：浅色/深色/跟随系统
- 关于 Tab：版本信息
- 保存按钮实际工作

---

## P3 — 后续迭代（仅预留接口）

### P3.1 一键扫码登录
- Desktop 弹出二维码
- 手机 FeClaw 控制台扫码
- 平台验证后下发 JWT

---

## 执行顺序

```
1. camelCase 全面检查（10min）
2. .well-known 端点 FeClaw 端（10min）
3. 欢迎页（25min）
4. 云模式完整登录（15min）
5. 主 UI 聊天界面（30min）
6. Desktop 消息渠道 WS 协议（20min）
7. 本地模式方案 C（40min）
8. 文件操作在聊天框内（20min）
9. 设置页全部激活（15min）
────────────────────────────
总计：~3 小时
```

## 各步骤进度文件

每次完成一个步骤，追加到 `docs/implementation-progress.md`

---

*计划于 2026-06-20 凌晨 2:15 生成*
