# Review 2 — FeClaw Desktop ↔ FeClaw Engine: WS / HTTP 协调审查

**审查日期**: 2026-06-22
**审查范围**: 双端协议对齐、认证一致性、数据格式、EdgeOne CDN 兼容
**Desktop 仓库**: `/home/lch/Projects/FeClaw-Desktop/src-tauri/src/`
**Engine 服务端**: `ubuntu@139.199.89.129:~/FeClaw/` (routers/desktop_ws.py, routers/desktop_api.py, routers/user.py 等)

---

## 总览

本审查共发现 **12 项问题**，分布如下：

| 严重程度 | 数量 |
|----------|------|
| P0 (致命) | 4 |
| P1 (严重) | 5 |
| P2 (一般) | 3 |

最关键的发现：**Desktop 主动发送的 3 类 WS 消息（`chat_message`、`send_group_message`、`consent_response`）在 Engine 端全部无法被正确解析**，聊天功能事实上是断开的。

---

## P0 — 致命问题

### P0-1. Engine 不接受 `chat_message` 信封 — 聊天功能断开

**Desktop 侧**: `src-tauri/src/chat.rs:163-168`
```rust
let envelope = serde_json::json!({
    "type": "chat_message",
    "id": id,
    "text": trimmed,
    "timestamp": ts,
});
```

**Engine 侧**: `routers/desktop_ws.py:191-213` (`handle_desktop_message`)
```python
async def handle_desktop_message(msg: dict):
    msg_type = msg.get("type")
    if msg_type == "consent_response":
        ...
    elif msg_type == "pong":
        ...
    elif msg_type in ("file_read_response", "file_write_response", "file_delete_response"):
        ...
    else:
        logger.warning(f"Unknown desktop message type: {msg_type}")
```

**差异描述**: Engine `handle_desktop_message` 仅识别 `consent_response`、`pong` 和三种 `file_*_response`，**完全没有 `chat_message` 分支**。Desktop 发送的每一条用户消息都会被 Engine 打印 "Unknown desktop message type: chat_message" 然后丢弃，**Agent 永远不会收到任何来自 Desktop 的聊天输入**。

**修复方案**:
1. 在 `handle_desktop_message` 中新增 `elif msg_type == "chat_message":` 分支
2. 从 `msg.get("text")` 提取消息正文，`msg.get("id")` 作为消息 ID
3. 调用现有的 `WebChannelService.chat_stream()` 或类似入口触发 Agent 执行
4. 通过 `manager.send()` 把流式事件（token/tool/done）和 `chat_reply` 反推回 Desktop

---

### P0-2. `consent_response` 信封字段名不匹配 (`op_id` vs `request_id`)

**Desktop 侧**: `src-tauri/src/chat.rs:328-335` (`send_consent_response`)
```rust
let envelope = serde_json::json!({
    "type": "consent_response",
    "op_id": op_id,
    "operation": operation,
    "path": path,
    "decision": if allow { "allow" } else { "deny" },
    "timestamp": ...,
});
```

**Engine 侧**: `routers/desktop_ws.py:195-201`
```python
if msg_type == "consent_response":
    request_id = msg.get("request_id")
    decision = msg.get("decision")
    if request_id and decision:
        from services.desktop_relay import relay
        await relay.resolve_consent(request_id, decision)
```

**差异描述**: Desktop 发送的是 `op_id`，Engine 读取的是 `request_id`。**两个字段名不一致，永远是 None**，`relay.resolve_consent` 永远不会被调用。任何等待中的 `command_exec_request` 都会在 300 秒后超时。

**修复方案**:
- 二选一：要么 Desktop 改发 `request_id`（保持与 Engine 的 relay 一致），要么 Engine 改读 `msg.get("op_id")`（与 `file_operation_request` 的入站字段保持一致）。考虑到 `desktop_relay.py` 内部已经统一使用 `request_id`，**建议 Engine 同时接受两个字段**，向前兼容：
  ```python
  request_id = msg.get("request_id") or msg.get("op_id")
  ```

---

### P0-3. Engine 全局 `/ws/desktop` 端点不接受 `chat_message`、`send_group_message`、`consent_response` 之外的任何业务消息

**Desktop 侧**: `src-tauri/src/chat.rs` (outgoing envelopes: `chat_message`, `send_group_message`)
**Desktop 侧**: `src-tauri/src/ws.rs:329-440` (`WsRequest` enum 没有 `ChatMessage` 接收变体)

**Engine 侧**: `routers/desktop_ws.py:96-126` (`desktop_websocket_global`)
```python
while True:
    data = await ws.receive_json()
    if isinstance(data, dict):
        data.setdefault("user_id", user_id)
        msg_agent = data.get("agent_hash") or data.get("agent")
        if msg_agent:
            owns, exists = _user_owns_agent(user_id, msg_agent)
            if not owns:
                continue
    await handle_desktop_message(data)
```

**差异描述**: 全局端点收到的消息必须含 `agent_hash` 或 `agent` 字段才会做归属校验，而 Desktop 的 `chat_message` / `send_group_message` 信封**完全不包含** agent_hash 字段。结果是：
- `agent_hash` 为空 → 跳过归属校验（但不影响丢弃）
- 调用 `handle_desktop_message`，由于 P0-1 的问题被丢弃

同时，Desktop 的 `WsRequest` enum（`ws_types.rs:66-190`）也**没有 `ChatMessage` 接收变体**——意味着即便 Engine 推送 `chat_message` 给 Desktop，Desktop 端反序列化会失败（unknown variant）。Engine 也从未定义过 `chat_message` 作为推送给 Desktop 的类型——这是**双向协议缺失**。

**修复方案**:
1. 在 Engine `desktop_websocket_global` 中允许 `chat_message` / `send_group_message` 不带 agent_hash 时通过（session-level 而非 agent-level 消息）
2. 在 Desktop `WsRequest` enum 中添加 `ChatMessage` 变体（即便目前不消费，先保证反序列化不失败）
3. 重新设计 chat 推送方向：Desktop 的 `chat_message` 是否应该映射到 `feclaw_chat.py` 的 `chat_stream` 而不是走 desktop WS？

---

### P0-4. Desktop `verify_token` 调用 `/api/me`，但 Engine 没有这个端点

**Desktop 侧**: `src-tauri/src/auth.rs:141-150`
```rust
pub async fn verify_token(&self, token: &str) -> bool {
    let url = format!("{}/api/me", self.config.engine_url());
    crate::http_client::http_client()
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}
```

**Engine 侧**: `routers/user.py` 路由前缀是 `/api/user`，**没有任何裸 `/api/me` 路由**。`/api/oauth/me` 存在，但需要 OAuth token 而非 FeClaw JWT。

**差异描述**: `login_or_load` 在本地模式启动时调用 `verify_token` 来判断是否复用旧 token。这个调用会返回 404，导致 `verify_token` 返回 false → 触发密码提取 + 重新登录流程。即使 JWT 还有效，每次重启 Desktop 都会强制重新登录。

**修复方案**:
- **首选**: Engine 添加 `GET /api/me` 端点（接受 Bearer JWT，返回 `{user_id, username, is_admin}`）
- **备选**: Desktop 改用 `{engine_url}/api/user/me` 或已存在的 OAuth 端点

---

## P1 — 严重问题

### P1-1. `/api/desktop/agents` 返回字段 vs Desktop `AgentInfo` struct 不一致

**Desktop 侧**: `src-tauri/src/types.rs:8-21`
```rust
pub struct AgentInfo {
    pub hash: String,
    pub name: String,
    pub description: Option<String>,
    pub avatar_url: Option<String>,
    pub permission_mode: Option<String>,
    #[serde(default)]
    pub is_online: bool,
    pub status: Option<String>,
}
```

**Engine 侧**: `routers/desktop_api.py:147-176`
```python
return [
    {
        "hash": a.hash,
        "name": a.name or a.hash,
        "description": a.description or "",
        "agent_type": a.agent_type or "classic",
        "avatar_url": a.avatar_url,
        "status": a.status or "pending",
        "is_default": a.is_default,
        "is_pinned": a.is_pinned or False,
        "is_dnd": a.is_dnd or False,
        "permission_mode": a.permission_mode,
    }
    for a in agents
]
```

**差异描述**:
- Engine 返回 `agent_type`、`is_default`、`is_pinned`、`is_dnd`，Desktop 不解析（被忽略）
- Desktop 期望 `is_online: bool`，Engine **不返回这个字段**
- Engine `description` 是字符串（`""`），Desktop 是 `Option<String>` —— serde 会接受 `""` 没问题

由于 Rust serde 默认忽略未知字段，`is_default` / `is_pinned` 等字段被丢弃不影响功能；但 `is_online` 永远是 `false`（默认值），UI 上"在线"指示会一直熄灭。

**修复方案**:
- Engine 在返回中加 `is_online: bool`（可基于 `status == "active"` 或心跳时间判断）
- Desktop 在 `AgentInfo` struct 中加 `agent_type`、`is_default`、`is_pinned`、`is_dnd` 字段，避免字段丢失

---

### P1-2. `/api/desktop/auth_exchange` 响应格式与 Desktop 期望不一致

**Desktop 侧**: `src-tauri/src/auth.rs:114-138`
```rust
let body: serde_json::Value = resp.json().await.context("parse login response")?;
let token = body
    .get("token")
    .or_else(|| body.get("access_token"))
    .and_then(|v| v.as_str())
    .ok_or_else(|| anyhow!("no token in login response"))?
    .to_string();
```

**Engine 侧**: `routers/desktop_api.py:127-133`
```python
return {
    "token": local_jwt,
    "user_id": user.id,
    "username": user.username,
}
```

**差异描述**: 字段名匹配（`token`），但 Desktop **目前根本没有调用 `/api/desktop/auth_exchange` 端点**。云模式登录走的是 `cloud_login` 命令 → 调用 `auth.rs::login` → POST `{cloud_login_base_url}/api/auth/login`（Platform 端点）→ 返回 token。然后 Desktop 用这个 token 直接连 `/ws/desktop`，**绕过了** Engine 的 `auth_exchange` 流程。

后果：
- Engine 数据库没有这个用户的记录
- 第一次 WS 连接时 Engine 用 JWT 解出 `user_id`，但 DB 中没有该 user，会导致 `_user_owns_agent` 永远返回 False
- Desktop 收到 4003 (forbidden) 或 4004 (agent not found)

**修复方案**:
1. Desktop cloud 登录成功后立即 POST `cloud_login_url/api/desktop/auth_exchange`（带上 platform_token），拿到 Engine 本地 JWT
2. 或者 Platform 在签发 token 时已经做了 user 同步（需要验证 Platform 代码），那 Engine 应该信任 Platform 的 user_id 直接建本地 user 记录
3. 同时让 `chat::list_agents` 和其他依赖 `user_id` 的端点能正常工作

---

### P1-3. Cloud 模式 Desktop WS 用 query param 传 token，但 Engine 文档说同时支持 header/cookie

**Desktop 侧**: `src-tauri/src/ws.rs:139-180` (`connect_tls`)
```rust
let url_with_token = if token.is_empty() {
    url.to_string()
} else {
    let sep = if url.contains('?') { "&" } else { "?" };
    format!("{url}{sep}token={token}")
};
```

**Engine 侧**: `routers/desktop_ws.py:96-101` (`desktop_websocket_global`)
```python
@router.websocket("/ws/desktop")
async def desktop_websocket_global(
    ws: WebSocket,
    token: Optional[str] = Query(None),
):
```

**差异描述**:
- Desktop 只用 query param `?token=...` 传 token
- Engine `desktop_websocket_global` 只声明了 `Query(None)`，**不读取 `Authorization` header**（看 ws.rs:127-135 的注释 "matches `desktop_ws.py` on the FeClaw side, which reads JWT from headers / cookies / first frame" 是不准确的——只读了 query）
- `desktop_websocket`（带 agent_hash 的版本）也只读 query
- 当 JWT 通过 EdgeOne CDN 时，**query string 可能被 CDN 记录在 access log 里**（token 泄漏风险）
- 但更重要的是：通过某些 CDN/代理时 query string 长度有限制（虽然 token 通常 < 2KB，不至于截断）

**修复方案**:
1. Desktop 优先使用 `Authorization: Bearer <token>` header（`tungstenite` 的 `IntoClientRequest` 支持），把 token 从 URL 中剥离
2. Engine 端 `websocket` 装饰器同时读取 query 和 header：
   ```python
   auth_header = ws.headers.get("authorization", "")
   if auth_header.startswith("Bearer "):
       token = auth_header[7:]
   if not token:
       token = ws.query_params.get("token", "")
   ```
3. 这样既兼容当前 Desktop 实现，也避免 token 进入 CDN URL access log

---

### P1-4. WS 连接全局只有一个 — 多窗口冲突

**Engine 侧**: `routers/desktop_ws.py:30-50` (`DesktopConnectionManager`)
```python
class DesktopConnectionManager:
    def __init__(self):
        self.conn: Optional[WebSocket] = None  # 单连接槽位
        self.lock = asyncio.Lock()
```

**Desktop 侧**: `src-tauri/src/lib.rs:396-411` 启动时只 spawn 一次 `ws.run()`

**差异描述**: Engine 全局 `DesktopConnectionManager` 只有一个 `self.conn`，第二次连接会**覆盖**第一次。如果 Desktop 因为网络抖动断线重连，并且恰好在断线瞬间两条连接同时存在，Engine 会把后到的当作"当前连接"，前一条的 `send_to_desktop` 调用就会失败（`is_connected=False`）。

更严重的是：Engine 没有去重逻辑 —— 多个 Desktop 实例（用户在两个机器登录同一账号）连过来，**只会保留最后一个**。

**修复方案**:
1. `DesktopConnectionManager` 改为 `dict[str, WebSocket]`（key 可以是 `desktop_instance_id` 或 JWT 签名）
2. 每次新连接时关闭旧的（"last writer wins"），至少避免幽灵连接
3. Desktop 端在重连前主动发送 Close 帧（已有 `cancel_token` 机制，但需要确保旧连接的服务端 slot 也被清空）

---

### P1-5. WS 客户端对错误响应无重试/退避智能

**Desktop 侧**: `src-tauri/src/ws.rs:44-47`
```rust
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const PONG_TIMEOUT: Duration = Duration::from_secs(35);
const MAX_RECONNECT_ATTEMPTS: u32 = 30;
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
```

**差异描述**:
- PONG_TIMEOUT 35s < EdgeOne CDN 典型空闲超时 300s 的一半，**心跳间隔 30s 是合理的**
- 但 `MAX_RECONNECT_ATTEMPTS = 30` 后进入 `Failed` 状态，需要用户手动重连
- 当 Engine 长期不可用（如部署中），Desktop 会快速耗尽 30 次重试（30 秒后即失败）
- 没有指数退避，每次重试间隔固定 1 秒

**修复方案**:
1. 重连间隔从 1s 改为指数退避（1s, 2s, 4s, ..., cap 60s）
2. `MAX_RECONNECT_ATTEMPTS` 改为无限（仅在收到 app-level close code 4001/4002/4003 时停止）
3. 收到 4001/4002/4003 时应触发 `AuthFailure` 控制消息（已有逻辑，但触发条件需要更准确）

---

## P2 — 一般问题

### P2-1. Engine 鉴权用 `decode_jwt_token`，但 Desktop cloud 模式拿到的可能是 Platform JWT 而非 Engine JWT

**Desktop 侧**: `src-tauri/src/auth.rs:114-138` 登录到 Platform，返回 Platform JWT 存到 `cloud_token`
**Desktop 侧**: `src-tauri/src/lib.rs:372-374` 直接把 `cloud_token` 传给 `WsClient::new`

**Engine 侧**: `routers/desktop_ws.py:103-108`
```python
payload = decode_jwt_token(token)
if not payload or not payload.get("user_id"):
    await ws.close(code=4001, reason=b"invalid token")
```

**差异描述**:
- Engine 用 `JWT_SECRET` (HS256) 解 JWT
- Platform 用 RS256 (RSA 私钥签发)，密钥完全不同
- 如果 Desktop 把 Platform JWT 传给 Engine，**Engine 解码会失败 → 4001**
- 这与 P1-2 是同一根因的两个表现：Desktop 应该通过 `auth_exchange` 拿到 Engine 自己的 JWT

**修复方案**: 见 P1-2 修复方案

---

### P2-2. `chat_message` 信封缺 `agent_hash` / `session_id` 字段

**Desktop 侧**: `src-tauri/src/chat.rs:163-168`
```json
{"type": "chat_message", "id": "msg-...", "text": "...", "timestamp": "..."}
```

**差异描述**: 消息体没有 `agent_hash` 也没有 `session_id`。即使 Engine 加上了 `chat_message` 分支（修复 P0-1），也无法知道这条消息应该路由到哪个 Agent 实例、用哪个会话上下文。Engine 的 `WebChannelService` 需要这两个字段。

**修复方案**: Desktop `chat_message` 信封应至少包含：
```json
{
  "type": "chat_message",
  "id": "msg-...",
  "text": "...",
  "agent_hash": "<hash>",  // 当前激活的 Agent
  "session_id": "<sess_id>", // 可选，新建会话时省略
  "timestamp": "..."
}
```

---

### P2-3. EdgeOne CDN 兼容：缺少 trace_id / correlation_id

**Desktop 侧**: 所有 outgoing envelope 无 `request_id` / `trace_id`
**Engine 侧**: 日志中大量使用 `logger.warning(...)` 但无统一 trace_id

**差异描述**: 通过 CDN 时一条消息可能经历多跳代理（Desktop → CDN 边缘 → CDN 中心 → Engine）。当用户报"我发了消息没收到回复"时，没有 trace_id 串不起来。

**修复方案**:
1. Desktop 为每条 outgoing envelope 生成 `request_id`（UUID v4），Engine 在日志和响应中透传
2. Engine 把 inbound message 的 `id` (Desktop 生成的) 写入所有相关日志
3. 借助 CDN 自带的 `X-Request-Id` header（EdgeOne 默认会注入）

---

## 附加观察 (Out of Scope 但值得注意)

### Obs-1. `request_id` vs `id` 字段命名混乱
- Engine `desktop_relay.py` 内部用 `id` 作为 request_id (e.g. `command_exec_request`)
- Engine `desktop_ws.py` 处理 `consent_response` 时读 `request_id`
- Engine `desktop_ws.py` 处理 `file_*_response` 时读 `id`
- **Engine 内部字段命名就不一致**

### Obs-2. Desktop `WsRequest::Pong` 变体永远不会被触发
Desktop 收到 `"pong"` 消息会反序列化为 `WsRequest::Pong` 单元变体，但 Engine 的 `handle_desktop_message` 把 `pong` 当作 debug 日志，**永远不会推送给 Desktop**。当前变体是无用代码。

### Obs-3. `chat_reply` / `chat_event` 在 Desktop 端只 log 不消费
`src-tauri/src/ws.rs:364-378` 收到 `chat_reply` 和 `chat_event` 只 `tracing::info!`，**没有 emit 给前端 UI**。即使 Engine 推回来，聊天窗口也不会显示。

### Obs-4. 心跳实现不一致
- Desktop 主动发 Ping（`Message::Ping(Vec::new())`），依赖 tungstenite 自动回复 Pong
- Engine 没有显式心跳代码，仅在 `handle_desktop_message` 收 `pong` 写 debug 日志
- Engine 不会主动 Ping Desktop，所以 Pong timeout 永远不会被触发（Desktop 是被 Ping 的一方）

### Obs-5. CDN 缓存与 SSE 不兼容
`NoCacheMiddleware` 正确禁用了 `/api/*` 缓存，但 `app.add_middleware(NoCacheMiddleware)` 在 CORS middleware 之后注册——CORS preflight 可能被缓存。

---

## 优先级修复建议

| 顺序 | 问题 | 工作量 |
|------|------|--------|
| 1 | P0-4 `/api/me` 缺失 | S (1h) |
| 2 | P1-2 auth_exchange 流程 | M (4h) |
| 3 | P0-2 `consent_response` 字段名 | XS (15min) |
| 4 | P0-1 `chat_message` Engine 处理 | L (1d) |
| 5 | P1-1 `is_online` + AgentInfo 字段对齐 | S (2h) |
| 6 | P2-2 chat 信封补 `agent_hash` | S (1h) |
| 7 | P1-3 token 改用 header | S (2h) |
| 8 | P1-4 多连接管理 | M (4h) |
| 9 | Obs-3 chat_reply 推到前端 | M (4h) |

P0 全部修复前，**生产环境云模式事实上不可用**（无法登录 + 登录后聊天无响应）。