# FeClaw-Desktop 批量改动审查报告（Phase 1-5 + Final）

我已完成对最近批量改动的多角度代码审查。以下从 UI/UX、用户认知、安全三个维度逐项分析。

---

## 一、UI/UX 角度

### 总体评价：质量整体较好，但仍存在不一致性

### ✅ 设计良好之处

| 项 | 评估 |
|---|---|
| 全局 Toast（`toast.ts`）| 依赖零、可点击关闭、ARIA 正确（`role="status"` + `aria-live="polite"`）、最多 5 条防堆叠 |
| 200ms Spinner 防闪烁（`spinner.ts`）| 用 `requestAnimationFrame` + 200ms 防抖，sub-200ms 操作不会闪烁；慢操作才显示遮罩 |
| 重试按钮内联在失败气泡上（`chat.ts:268-289`）| 比单独的错误条更直观，用户点击重发不需重新输入 |
| 日期分隔线（`chat.ts:147-159`）| 今天/昨天/前天/N天前/具体日期 五档分级，符合国内 IM 习惯 |
| 实时主题切换（`settings.ts:78-87` → `chat.ts:1077-1085`）| iframe emit → 父窗口 listen → 同步 `data-theme`，即时反馈 |
| 引擎 watchdog（`lib.rs:568-588`）| 2s 轮询 `is_running()` + 主动 emit Disconnected，避免僵尸连接 |
| Tab 收敛为 4 个（chat/moments/settings/fehub）| 与当前内容匹配，规避占位页混乱 |

### ⚠️ 风险点

#### 风险 1（高）：chat.ts / chat.js 双轨制——运行时实际跑的是 .js
`README` 明确写道："直接使用 .js 文件运行（未使用 esbuild/打包工具）"。因此：

- `chat.ts`（1606 行）作为源码参考，但 **`index.html` 加载的是 `chat.js`（1156 行）**
- `.js` 中**缺失**以下功能/安全机制：
  - `renderMarkdown` + `DOMPurify` 助手消息渲染（`.js` 用纯 `textContent`，安全但功能缺失）
  - `pickSafeImageSrc` 严格 MIME 白名单（`.js` 只检查 `data:image/` 前缀，可通过 `data:image/svg+xml`！）
  - 失败气泡 patch（`.js` 走的是追加新 `⚠` 错误气泡，会污染会话）
  - 群聊、动态、搜索、附件、图片粘贴等全部 feature
- **结果**：`.ts` 中所有 Phase 1-5 的新代码实际上未运行，但 `.js` 仍在用未过滤的 SVG image src，构成 XSS 隐患

**建议**：要么真的跑 `.ts`（最简单：把 `chat.ts` 改成纯 JS 模块语法即可，因为没有 TypeScript-only 类型），要么把 `.js` 同步成 `.ts` 等价实现。短期至少删除 `.ts` 中关于渲染/SVG 的注释避免误导。

#### 风险 2（中）：两个重复的 ws-status 监听
`chat.js:662-704` 注册了两个监听器（`ws-status` 和 `connection-status`），但 `chat.ts` 只有 `ws-status`。后端只 emit `ws-status`，`connection-status` 永远不会被触发——这是 `.js` 残留 dead code，但意味着 `.js` 和 `.ts` 已经长期分叉。

#### 风险 3（中）：两套 toast 实现并存
- `chat.ts` 没有 `showToast` 导出，但 `chat.js:635` 内部有 `showToast()`（直接在 DOM 上 style.cssText 注入）
- `chat/components/toast.ts` 是新全局 toast，但 **没人调用它**（grep 不到 `import { showToast }`）
- `settings.ts:110-121` 有第三套自己的 toast（基于 `#toast` 元素）

→ 三套实现，行为/样式不一致。

#### 风险 4（中）：删除 Agent 用浏览器原生 `confirm()`
`chat.js:1131`：`confirm("确定要删除此Agent吗？此操作不可撤销。")`——而其他危险操作都用自定义 styled modal。视觉上不一致，且原生 `confirm` 在某些 Tauri 版本下被抑制或不可定制。

#### 风险 5（低）：思考中/工具调用无超时/取消 UI
`renderEventPill("thinking", "思考中…")` 一旦显示就只等 `done` 事件。如果 Agent 卡住（典型 LLM 流式中断），用户没法取消，需要等 5min WS 心跳超时才会重连。

---

## 二、用户认知角度

### 总体评价：错误信息和权限提示都做得较细致，但模式认知与状态变化反馈仍有缺口

### ✅ 做得好的

| 项 | 评估 |
|---|---|
| 权限分级显式 L0-L4（`side-panel.ts:91-97`）| 每个级别都有 `label + desc`，用户可清晰理解代价 |
| 文件操作 consent 显示完整路径（`consent.rs:306-318`）| "Agent wants to DELETE a file under your Desktop: /xxx/yyy.txt" |
| 错误信息中文本地化（`settings.rs:281-285` 等）| "服务器地址不能为空"/"用户名不能为空"/"密码不能为空"——具体到字段 |
| Toast `kind` 视觉区分（`chat.css:2979-2990`）| info 蓝边、success 绿边、error 红边+红字 |
| `cloud_disconnect` 二次确认对话框明确告知下次启动生效（`settings.ts:394-396`）| 用户不会被假象欺骗 |

### ⚠️ 风险点

#### 风险 1（高）：Cloud vs Local 模式无任何视觉指示
`Config.mode` 字段决定后端连本地引擎还是云端 WS，但 UI 上：
- 没有当前模式徽章
- `get_cloud_session()` 返回 `connected: true/false`——但 **false 不等于 Local 模式**（也可能是 Cloud 模式但未登录）
- 用户看到一个空聊天列表，无法判断 "是因为没连云端还是因为没装本地引擎"

**建议**：在右上角头像旁增加一个 mode pill "本地引擎" / "云端"，并在启动时显示一次性提示告知当前模式。

#### 风险 2（高）：Cloud 模式 refresh 失败时错误信息含 jargon
`engine.rs:316` 等处的用户面对的错误包括：
- "cached cloud token is malformed"
- "cloud mode requires `cloud_url` to be set in config.toml"
- "Platform refresh 失败 (XXX): 服务器未返回详细信息"
- "FeClaw auth_exchange 失败"

普通用户不会知道 "Platform JWT"、"FeClaw JWT"、"auth_exchange" 是什么。建议在前端做一层翻译，把这些内部错误映射成 "云端登录已过期，请重新登录" 这种面向用户的话术。

#### 风险 3（中）：ShowCloudLogin 事件可能在 settings iframe 加载前丢失
`engine.rs:299` 在 cloud_loop 启动早期就可能 emit `ShowCloudLogin`；settings iframe 此时可能还在加载 `chat/index.html`。前端 `wireExternalNavigation()` 在 `DOMContentLoaded` 才注册 `listen`，**早 emit 的事件会丢失**——用户看到的是"什么都没发生"。

**建议**：在 Rust 端用 channel 缓存"待显示的 login 提示"，settings 加载完后回放。

#### 风险 4（中）：连接状态指示器视觉对弱视用户不友好
`conn-dot` 仅靠颜色（绿/黄/红）+ 文字（在线/连接中/离线）。`chat.js:667` 一上来就 `dot.className = "conn-dot"` 重置了所有状态 class，**没有处理 `aria-live` 公告**给屏幕阅读器。建议把文字变化包在 `aria-live="polite"` 容器里（已部分有，但状态文字被覆盖而非追加）。

#### 风险 5（中）：错误未区分 transient vs permanent
`chat.ts:812-822` 把 `invoke` 抛出的任何错都标记成 `error: errMsg` + retry 按钮。如果错误是 "this agent is disabled" 这种永久性失败，用户重试只会再次失败。建议后端返回错误码，前端区分。

#### 风险 6（低）：thinking 流没用户可见的进度
`renderEventPill("thinking", "思考中…")` 一行静态文字，长时间没动静用户会以为卡死。如果能加个微动画（dot dot dot 跳动）或流式 token 计数，体验会好很多。

---

## 三、安全角度

### 总体评价：capability 拆分细致、XSS 防护多层，但存在几个中高风险缺口

### ✅ 做得好的

| 项 | 评估 |
|---|---|
| capability 拆分到 6 个文件 | chat / dangerous / file-manager / local-setup / welcome / default 隔离，最小特权原则落地 |
| dangerous.json 只含 3 个命令且只对 chat 窗口开放 | 拆得克制，注释明确"Add a window only after deliberate UX review" |
| DOMPurify + marked + highlight.js 三层 pipeline（`markdown.ts`）| FORBID_TAGS 显式禁 style/script/iframe/form；FORBID_ATTR 显式禁 onerror/onload/onclick/onmouseover/style |
| `pickSafeImageSrc` 白名单（`chat.ts:1037-1043`）| 只允许 png/jpeg/jpg/gif/webp，**显式排除 SVG**（即使在 `<img>` 内，SVG 也可能携带脚本特性，且新窗口/全屏场景下可能被换种方式执行） |
| 链接加固（`markdown.ts:165-171`）| outbound 强制 `target=_blank` + `rel="noopener noreferrer"` |
| `on_new_window_request` 拦截（`chat.rs:317-351`）| 只允许 http/https，URL 用于生成 window label（最大 32 字符过滤后），拒绝 file:// / javascript: / data: |
| 文件路径遍历阻止（`file_bridge.rs:28-32`）| 显式拒绝 `..` segments；额外 Windows 绝对路径检测（`file_ops.rs:26-31`） |
| Consent dialog 5min 超时（`consent.rs:36`）| 防止用户走开后 WS 30s 心跳超时掉线；超时按 deny 处理 |
| JWT 信封校验（`auth.rs:216-248`）| 上线前先做 3 段 + base64url 字符集快速校验，过滤明显垃圾输入 |
| 凭证清除原子性（`settings.rs:389-401`）| `cloud_disconnect` 同时清 cloud_token + platform_token，避免泄漏 |
| `set_theme` 严格白名单（`settings.rs:551-553`）| "light/dark/system" 三选一，无效值直接拒，config poisoning 防御 |
| `format_login_error` 只取 detail/message 字段（`settings.rs:581-594`）| 防止服务端堆栈/敏感字段泄漏给前端 |
| `extract_password_from_stdout` 处理 `password=` 前缀（`auth.rs:158-185`）| 多种格式兼容 |

### ⚠️ 风险点

#### 风险 1（**CRITICAL**）：`csp: null` —— CSP 完全关闭
`tauri.conf.json:23`：`"csp": null`

Tauri 2 默认就允许设 CSP。这里显式置 null，等于所有 webview 都 **没有任何 CSP 限制**。如果 DOMPurify 被绕过（或者某个新加的 `dangerouslyAllowAllTags` 配置错误），攻击者可以注入任意 `<script>` 直接执行而无 CSP 兜底。

**影响**：所有 webview（包括 chat / settings / welcome / file-manager / local-setup）都裸奔。

**建议**：至少配置 `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; connect-src 'self' https: wss:;`。vendored 的 `marked.min.js` 等是同源，可以不加 `unsafe-inline`。

#### 风险 2（**高**）：`vfs_rm` 列入 dangerous.json 但 **未走 ConsentManager**
对比两个危险操作：

- `file_delete`（`file_ops.rs:151-180`）：先 `guard.request_operation(Operation::L3, &path)` 再删
- `vfs_rm`（`file_manager.rs:283-310`）：直接 HTTP POST 到 engine，**完全没有 consent dialog**

虽然 `vfs_rm` 删除的是 engine 端的 VFS 路径（不是本地 `~/Desktop`），但 capability 文件的注释明明说 "Each of these is gated by an in-app consent dialog"——这句话对 `vfs_rm` 不成立。

**建议**：`vfs_rm` 也加 consent（至少对 L3 删除操作），或者在 capability 文件注释里区分 "本地删除 consent-gated / 云端删除 risk-acknowledged"。

#### 风险 3（**高**）：JWT 持久化为明文 TOML
`config.rs:36-46`：`cloud_token` / `platform_token` 直接以明文写到 `~/.feclaw-desktop/config.toml`。

- Windows：任何以同一用户身份运行的进程都能读到
- macOS：未受 FileVault 加密保护时，其他用户进程通过权限漏洞可读
- Linux：root / 同用户其他进程可读
- 此外 toml 文件被列入备份/同步（如 iCloud / OneDrive）时会泄露到云端

**风险等级评估**：考虑到产品定位是个人桌面端、不是企业产品，**可接受**，但应记录在 README / security notes 中。中长期应集成：
- macOS Keychain
- Windows DPAPI（`windows` crate 已支持）
- Linux Secret Service（`secret-service` crate）

#### 风险 4（**高**）：chat.js 实际运行时 image 渲染不做 SVG 过滤
`chat.js:225` `img.src = msg.content;`——直接把 message content 当 src 用，**没有调用 `pickSafeImageSrc`**。如果历史记录里包含 `data:image/svg+xml;base64,...`，会直接渲染。

而且 `chat.js` 没有调用 `escapeHtml` 处理 avatar_url：`src="${item.avatar_url}"`——如果后端返回 avatar_url 含 `"` 会破 HTML（双重 escape 需要）。

**建议**：在 `chat.js` 中也加 `pickSafeImageSrc` 过滤（这是修复 .js/.ts 双轨制的一部分）。

#### 风险 5（中）：trusted-commands 没有 TTL
`consent.rs:42-44, 122-154`：用户点 "Cancel" 表示 "always allow" 后，命令以原文字符串存入 `~/.feclaw/trusted-commands.json`，永久生效。

- L3（rm）风险中等，可接受
- L4（curl / wget）网络命令和 L5（python / bash）代码执行是 **长期 trust 风险**：今天信任 `python3 analyze.py`，明天被替换为恶意脚本，仍会放行

**建议**：对 L4/L5 增加 24h 或会话级 TTL，过期重新弹窗。或者区分 L4/L5 的 trust 行为—— L4/L5 不应支持 always-allow。

#### 风险 6（中）：settings iframe 同源信任链断裂
`chat/index.html:120`：`<iframe id="settings-frame" src="/settings/index.html">`，`withGlobalTauri: true` 暴露 `__TAURI__` 给所有 webview（包括 iframe）。settings iframe 通过 `window.__TAURI__.event.emit("theme-changed", ...)` 通知父窗口。

- 当前 settings iframe 来自 `frontendDist: "src"`，是同源（src/settings/），安全
- 但如果未来 settings 需要嵌入第三方 widget（如支付 SDK、分析脚本），**这个 `withGlobalTauri` 跨 frame 边界暴露整个 IPC surface 给第三方 JS**
- 当前没有 CSP 限制，第三方脚本可直接读 token、调用 invoke

**建议**：对 settings iframe 单独设 CSP `script-src 'self'`；考虑 `withGlobalTauri` 只在主 chat 窗口打开（iframe 不需要全局对象，可通过 `postMessage` 桥接）。

#### 风险 7（中）：extract_password_from_stdout 可被错误日志污染
`auth.rs:158-185`：匹配 `password=<anything>` 任何一行——如果 engine 在错误消息中输出 `Failed to authenticate: wrong password=hunter2`，会被误识别为 admin 密码。

虽然 stderr 没有走 stdout buffer，但 stdout 也会有 INFO/WARN 日志。

**建议**：只扫描 engine 启动后的前 N 行（`< 60s`），或要求 prefix 是 `Admin password:` 而不是泛 `password=`。

#### 风险 8（中）：auth.rs 文档结构异常（潜在隐藏编译错误）
`auth.rs:151-186` 中 `verify_token` 结束后，`extract_password_from_stdout` 的 doc comment 缩进从 0 开始（`///`），看起来是顶层 free function，但函数体被放在 `impl AuthManager` 块内——后面 `}` 关闭 impl。`login_or_load` 第 88 行调用 `Self::extract_password_from_stdout(...)` 能编过（都在 impl 内），但视觉上非常容易误导维护者。

虽然能编译，但这种风格强烈建议规整化（要么全放 impl 内，要么全 free function）。

#### 风险 9（中）：测试代码引用已删除的字段
`config.rs:326-381`、`engine.rs:552-555` 等多处测试代码引用 `cfg.host`、`cfg.port`、`cfg.ws_path`，但 `Config` struct 已重构成不含这些字段。`cargo test` 会编译失败。

**实际后果**：
- CI 如果跑 `cargo test` 会挂
- 新提交的代码不会被测试覆盖（测试编不过就不跑）
- 等于把 `cargo test` 当 gate 的 workflow 失效

**建议**：删除/重写 stale test，或在 CI 中 `#[cfg(test)] #[ignore]` 临时跳过。

#### 风险 10（中）：ws URL label 可能碰撞
`chat.rs:332-339`：`format!("ext-{}", url_str.chars().filter(is_ascii_alphanumeric).take(32).collect())`。两个不同 URL 可能产生相同 label（哈希碰撞），导致 Tauri 复用同一个窗口显示错的内容（虽然只是 read-only 风险）。

**建议**：用 URL hash 或 `URL.len() + first_64_chars` 作为 label，确保唯一。

#### 风险 11（低）：chat.ts:1043 的 `escapeHtml` 不转义单引号
`side-panel.ts:617-624` 的 `escapeHtml` 转义了 `&#39;`，但 `chat.ts:1025-1031` 和 `chat.js:632-634` 的 `escapeHtml` 没有转义 `'`。在 attribute 上下文里 `'` 不转义可能被 break out。`chat.ts` 第 84 行 `src="${item.avatar_url}"` 用双引号包裹，所以暂时安全，但 attribute 值如果未来切换到单引号包裹就破。

#### 风险 12（低）：frontmatter 视角下，"删除 Agent" 缺真正的二次确认
`chat.js:1131` 用 `confirm()`，且确认文案不含 agent 名称（`"确定要删除此Agent吗？此操作不可撤销。"`）。如果 agent 列表里用户看错了，删错不可恢复（虽然有 cloud → engine → DB 残留，但本地 store 立刻清空）。

**建议**：在 confirmation 中带入 agent name：`确定要删除 Agent "${name}" 吗？此操作不可撤销，本地聊天记录将一并清除。`

#### 风险 13（低）：trusted-commands.json 跨 OS 字符编码
`consent.rs:146` 写入 UTF-8 JSON，正常。但 `assess_risk` 第 160 行 `cmd.to_lowercase()` 不处理 Unicode normalization——如果命令含特殊字符，trust 匹配会失败但不影响安全（fail-closed: 重新弹窗）。

---

## 综合优先级清单

| 优先级 | 风险 | 一句话建议 |
|---|---|---|
| **P0（必须修）** | `csp: null` | 给 `tauri.conf.json` 加 `csp` object，至少限制 `script-src 'self'` |
| **P0** | chat.js 与 chat.ts 分叉（运行时 XSS 防护缺失）| 统一入口；要么 .js 同步、要么真跑 .ts |
| **P1（应修）** | `vfs_rm` 不走 consent | 在 file_manager.rs::vfs_rm 头部加 `request_operation(L3, &path)` |
| **P1** | JWT 明文持久化 | 集成 OS keyring（keyring crate） |
| **P1** | chat.js SVG image 渲染 | 给 .js 加 pickSafeImageSrc |
| **P2（建议修）** | Cloud/Local 模式无 UI 指示 | 顶部加 mode pill |
| **P2** | trusted-commands L4/L5 无 TTL | 对 L4/L5 限制 always-allow |
| **P2** | ShowCloudLogin 事件可能丢失 | Rust 端缓存待显示提示 |
| **P2** | 测试代码引用已删字段（CI 失效）| 修测试代码 |
| **P3（锦上添花）** | 两套 toast | 统一到 toast.ts |
| **P3** | delete_agent 用浏览器原生 confirm | 改用 styled modal，附带 agent name |
| **P3** | refresh 错误 jargon | 前端做 i18n 映射 |
| **P3** | ws 标签可能碰撞 | URL hash 作为 label |

---

## 总结

Phase 1-5 + Final review 这一批改动整体**质量高**，架构清晰（capability 拆分、consent 分级、token refresh 双链），大部分代码路径都有明确的安全注释。但有 **3 个 P0/P1 级安全问题** 建议立即处理：

1. CSP 关闭（影响所有 webview）
2. `chat.ts` / `chat.js` 双轨制导致运行时实际缺乏 XSS 防护层
3. `vfs_rm` 列入 dangerous 但未走 consent

UI/UX 维度主要是 **chat.js 滞后导致很多新功能未生效**，需要在构建/分发策略上明确选择；用户认知维度主要是 **Cloud/Local 模式无视觉指示** 和 **错误 jargon 未翻译**。

无 malware。所有代码路径符合 Tauri 2 推荐的架构（capability-based IPC、webview 沙箱、async runtime 分层），主要问题集中在配置和已删除字段的测试代码。
