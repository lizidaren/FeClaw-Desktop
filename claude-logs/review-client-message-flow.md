# 桌面客户端发消息全链路审查（Review 1）

> **范围**：`FeClaw-Desktop` 从用户点击“发送” → 消息经 Tauri command → WS envelope → `WsClient::run_loop` → TCP/WS 帧送达的全链路。
> **审查日期**：2026-06-22
> **审查方法**：静态阅读 + 调用链追踪（无运行时复现）。
> **严重程度**：`P0`（核心功能不可用） / `P1`（功能降级/不可恢复） / `P2`（体验或代码质量）

---

## 0. 链路总览

```
┌──────────────────────────────────────────────────────────────────┐
│ chat/chat.js::sendMessage()                                       │
│   ① 读 input → trim → 入参 message 对象                         │
│   ② await invoke("insert_chat_message", …)  ── SQLite 本地入库  │
│   ③ store.appendMessage + renderMessageEl  ── 乐观渲染气泡      │
│   ④ await invoke("send_chat_message", { text })                  │
│           │                                                       │
│           ▼                                                       │
│ chat.rs::send_chat_message()  ── Tauri command                  │
│   ⑤ trim/为空检查 → 生成 id/ts                                  │
│   ⑥ append_internal()  ── 写 chat_history.json (V2)             │
│   ⑦ state.ws_outgoing.write().await → tx.send(json)             │
│           │                                                       │
│           ▼                                                       │
│ WsClient::run_loop (ws.rs)                                       │
│   ⑧ outgoing_rx.recv() → ws.send(Message::Text(json))           │
│   ⑨ TCP → TLS → tungstenite → 服务端 /ws/desktop                │
│           │                                                       │
│           ▼                                                       │
│ engine (Python, FeClaw)  ── 业务处理 → 回包 chat_reply /         │
│                                              chat_event          │
└──────────────────────────────────────────────────────────────────┘
            ▲
            │  ⑩ reply 路径
            │   handle_message() → WsRequest::ChatReply / ChatEvent
            │   ⚠ 当前只 `tracing::info!`，未 persist_and_emit       │
            │   ⚠ 没有任何 Tauri event 发出，UI 永远看不到回复
```

**关键发现预览**：
1. **P0-#A**：服务器回复链路未接通——`ChatReply` / `ChatEvent` 收到后只写日志，前端永远看不到。
2. **P0-#B**：云模式（cloud mode）重连在 `MAX_RECONNECT_ATTEMPTS=30` 次失败后**永久离线**，且 tray / 控制泵的 “重新连接” 菜单在 cloud 模式无效。
3. **P1-#C**：发送失败时输入框文字已清空，用户需要重新输入。
4. **P1-#D**：`engine.rs::start_cloud / cloud_loop`（含 4001/4002/4003 auth-failure 检测 + 无限重连）在实际 cloud 启动路径中**是死代码**——`lib.rs` 的 cloud 分支从未调用 `engine.start()`。

下文逐项展开。

---

## 1. P0 级问题（必须修）

### P0-#A 服务器回复完全丢失（chat_reply / chat_event 不触发 UI）

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/ws.rs:364-378` |
| 涉及类型 | `WsRequest::ChatReply`、`WsRequest::ChatEvent`（`ws_types.rs:111-129`） |
| 严重程度 | **P0**（核心聊天功能断链） |

**问题描述**：

`WsClient::handle_message` 收到服务器的 `chat_reply` / `chat_event` 后**只写一行 tracing 日志**，不调用 `chat.rs::persist_and_emit`，也不调用 `app_handle.emit("chat-event", …)`：

```rust
// ws.rs:364-371
WsRequest::ChatReply { id, text, agent, timestamp } => {
    tracing::info!(
        agent = agent.as_deref(),
        id = id.as_str(),
        "chat_reply received (length={}) — handled by persist_and_emit in a later PR",
        text.len()
    );
}

// ws.rs:372-378
WsRequest::ChatEvent { id, kind, data, timestamp } => {
    tracing::info!(
        id = id.as_str(),
        kind = kind.as_d(),
        "chat_event received — streaming events not yet wired on desktop"
    );
}
```

注释明确写着 “handled by persist_and_emit in a later PR” / “streaming events not yet wired on desktop”——是个未完工的 TODO，但用户视角下，**发出去的消息永远没有回包**，整个 IM 流程对用户而言是“只发不收”。

`chat.rs::persist_and_emit` 已经定义好（`chat.rs:232-239`），但 `grep persist_and_emit src-tauri/src` 的调用点为 **0**：

```
$ grep -rn 'persist_and_emit' src-tauri/src
src-tauri/src/chat.rs:232:pub(crate) async fn persist_and_emit(  ← 定义
src-tauri/src/ws.rs:368: "…handled by persist_and_emit in a later PR"  ← 仅日志字符串
```

**后果**：
1. 用户消息成功入 SQLite + WS 发出 ✓
2. 服务器处理完返回 `chat_reply` → `WsClient::handle_message` 解析成功 ✓
3. **但 reply 既没写入 `chat_history.json`，也没 emit `chat-event`** ✗
4. `chat.js:595` 监听的 `chat-event` 永远收不到 → **用户看不到回复** ✗
5. 流式 `chat_event`（thinking/tool/message_chunk/message_end）全部丢 → **没有任何 streaming 反馈** ✗

**修复建议**：

在 `handle_message` 的 `ChatReply` / `ChatEvent` 分支调用 `persist_and_emit`：

```rust
WsRequest::ChatReply { id, text, agent, timestamp } => {
    let msg = ChatMessage {
        id,
        role: "assistant".into(),
        content: text,
        timestamp,
        agent,
    };
    if let Some(handle) = &self.app_handle {
        if let Err(e) = crate::chat::persist_and_emit(handle, msg).await {
            tracing::error!("chat_reply persist_and_emit: {e:#}");
        }
    } else {
        tracing::warn!("chat_reply dropped: no app_handle");
    }
}
WsRequest::ChatEvent { id, kind, data, timestamp } => {
    // 透传给前端做流式渲染；不写盘（每帧都写 SQLite 太重）
    if let Some(handle) = &self.app_handle {
        let _ = handle.emit("chat-stream", serde_json::json!({
            "id": id, "kind": kind, "data": data, "timestamp": timestamp,
        }));
    }
}
```

`chat-stream` 监听 `chat.js:608-648` 已存在，只缺后端的 emit。

**附加问题**：`WsClient` 必须能拿到 `AppHandle`。当前 cloud 模式下 `engine.rs:335-343` 构造 `WsClient` 时 `app_handle=None`——这是另一个独立问题（P0-#B 见下文），但要彻底修 A，必须先把 `app_handle` 接进 `cloud_loop`。

---

### P0-#B 云模式重连在 30 次后永久离线 + “重新连接”菜单无效

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/ws.rs:182-209`（`MAX_RECONNECT_ATTEMPTS=30`）；`src-tauri/src/lib.rs:434-472`（cloud 控制泵） |
| 严重程度 | **P0**（长时间网络抖动后整个 client 不可用） |

**问题描述**：

云模式启动时（`lib.rs:371-475`），构造 WsClient 后调用 `ws.run()`（不是 `run_once`）。`WsClient::run` 的循环上限是 `MAX_RECONNECT_ATTEMPTS=30`，每次间隔 `RECONNECT_DELAY=1s`，**总失败预算 ≈ 30 秒**：

```rust
// ws.rs:182-209
pub async fn run(mut self) {
    for attempt in 1..=MAX_RECONNECT_ATTEMPTS {     // 30 次
        if attempt == 1 { … }
        else {
            tokio::time::sleep(RECONNECT_DELAY).await;  // 1 秒
        }
        match self.run_inner().await { … }
    }
    self.set_status(ConnectionStatus::Failed).await;   // ← 永久失败
    tracing::error!("ws exhausted {MAX_RECONNECT_ATTEMPTS} reconnect attempts; user must click reconnect");
}
```

30 次失败后：
- `WsClient` 任务退出，`outgoing_rx` 被 drop；
- `state.ws_outgoing` 中保存的 sender 仍指向已关闭的 channel → 后续 `send_chat_message` 直接拿到 `"WebSocket 已断开"` 错误；
- 控制泵收不到任何后续 status 推送（status_tx 也是 mpsc 但 sender clone 已被 drop），前端连接点固定显示“离线”；
- **tray 上的 “重新连接” 菜单和 UI 上的重连按钮都没用**——cloud 模式的 control pump 处理 `ControlMsg::Reconnect` 只 `tracing::info!`：

```rust
// lib.rs:438-441（cloud 模式控制泵）
ControlMsg::Reconnect => {
    tracing::info!("control: reconnect requested");
    // cancel + WS will auto-reconnect in WsClient
}
```

`cancel_token` 没被 set，`ws_outgoing` 没被替换。

而本地模式的 control pump 写法完全不同（`lib.rs:588-591`）：

```rust
// 本地模式控制泵
ControlMsg::Reconnect => {
    tracing::info!("control: reconnect requested");
    cancel_token_for_pump.store(true, Ordering::SeqCst);   // ← 真的会触发重连
}
```

**cloud 模式漏了这一行**。

**修复建议**：

1. **cloud 模式控制泵补 cancel_token**（最小修复，立刻让重连菜单生效）：

   ```rust
   // lib.rs:438-441
   ControlMsg::Reconnect => {
       tracing::info!("control: reconnect requested");
       cancel_token.store(true, Ordering::SeqCst);
   }
   ```

   （cloud 分支需要在 `startup()` 顶部也建一个 `cancel_token_for_pump` clone 透传到控制泵闭包里，参考本地模式 584 行。）

2. **更彻底**：把 cloud 模式也走 `engine.rs::start_cloud` → `cloud_loop` 那条**带 5s backoff + 无限重连 + 4001/4002/4003 auth-failure 检测**的路径。但当前 `lib.rs:393-411` 已经在 cloud 分支里手工建了 WsClient，绕过了 engine.start——见 P1-#D。

3. **`MAX_RECONNECT_ATTEMPTS=30` 应改成无限（`u32::MAX` 或 `loop {}`）**或指数退避，避免被一次性打挂。或参考 `engine.rs::CLOUD_RECONNECT_DELAY=5s` 改成 5s 间隔。

---

### P0-#E `engine.rs::start_cloud` / `cloud_loop` 在实际 cloud 启动路径中是死代码

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/engine.rs:221-385`（`start_cloud` + `cloud_loop`）；`src-tauri/src/lib.rs:371-475` |
| 严重程度 | **P0-#B 的根因**（独立性次之，但合并报告） |

**问题描述**：

`engine.rs::cloud_loop` 是带**完整 4001/4002/4003 auth-failure 检测**的：

```rust
// engine.rs:360-376
if matches!(close_code, Some(4001) | Some(4002) | Some(4003)) {
    let reason = match close_code { … };
    tracing::warn!("cloud auth failure (close code {:?}, reason={reason}); clearing token", close_code);
    Self::clear_token(&shared_config).await;
    Self::request_cloud_login(&ui_tx);
    Self::emit_auth_failure(&ui_tx, reason);
    tokio::time::sleep(CLOUD_LOGIN_BACKOFF).await;
    continue;
}
```

但调用栈是：

```
lib.rs::startup()
  └─ if config.mode == Mode::Cloud { … ; return Ok(token); }   ← 提前 return，不调 engine.start()
  └─ else { engine.start(…) }   ← 只有本地模式走这里
        └─ match config.mode {
             Local => start_local(),          ← 本地
             Cloud => start_cloud()            ← 不可达
           }
```

也就是说 `start_cloud` / `cloud_loop` 这段代码**永远不会被执行**——本地分支不会传 `mode=Cloud`，cloud 分支根本不调 `engine.start()`。

后果：
- 真实 cloud 模式下，服务器 close-code 4001（token 过期）发生时，**不会有 `ControlMsg::AuthFailure` 发出**，UI 不会弹出 “session expired” 提示；
- 真实 cloud 模式下，token 被服务端拒绝后**不会自动 clear**，下次启动还在用失效 token 连。

**修复建议**：

二选一：
1. **删掉** `start_cloud` / `cloud_loop` 死代码，改 `lib.rs:395` 直接 `run()` + 在控制泵里增加 4001 检测逻辑（接近现在的写法，但补全 auth-failure 分支）；
2. **改** `lib.rs:371` 的 cloud 分支，让它也走 `engine.start() → start_cloud → cloud_loop` 这条带 auth-failure 的路径；同时确保 `cloud_loop` 里构造 `WsClient` 时把 `app_handle` 传进去（当前传的是 `None`，见 P0-#A 末尾）。

强烈推荐方案 2——auth-failure 检测是非常关键的用户体验。

---

## 2. P1 级问题（影响可用性 / 数据一致性）

### P1-#F 发送失败时输入框文字丢失

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/chat/chat.js:279-350`（`sendMessage`） |
| 严重程度 | **P1**（UX 阻塞，长消息丢失后用户需重打） |

**问题描述**：

`sendMessage` 在 await invoke 之前就 `input.value = ""`：

```javascript
// chat.js:283-288
btn.disabled = true;
input.value = "";          // ← 先清空
autoResize();
const id = `msg-${Date.now()}`;
…
// chat.js:321-333
try {
  await invoke("send_chat_message", { text });
} catch (e) {
  …
  store.appendMessage({
    id: `err-${Date.now()}`,
    …
    content: `⚠ ${errMsg}`,   // 只显示错误，没把原文还给用户
  });
}
```

`text` 变量已经清空了 input，所以 catch 里没法把原文塞回去（变量保留的是 trim 后的字符串）。

并且：chat.rs 的 `send_chat_message` 设计上是 “本地先写、WS 后发”，返回 `"WebSocket 已断开，消息仅保存到本地"` 仍把消息写到 `chat_history.json`——但前端会以为失败，把原文丢了。

**修复建议**：

```javascript
async function sendMessage() {
  const input = $("input");
  const btn = $("btn-send");
  if (!input || !btn || btn.disabled) return;
  const text = input.value.trim();
  if (!text || !store.activeAgentHash) return;

  btn.disabled = true;
  // ❌ 删除 input.value = "";            ← 改成发完再清
  const originalInput = input.value;       // ← 保留原文
  input.value = "";
  autoResize();

  // … 写 SQLite + 乐观渲染（用 originalInput）…
  try {
    await invoke("send_chat_message", { text });
  } catch (e) {
    // ❌ 不再用 ⚠ 错误气泡，把原文还回输入框
    input.value = originalInput;
    autoResize();
    input.focus();
    store.appendMessage({
      id: `err-${Date.now()}`,
      …,
      content: `⚠ ${typeof e === "string" ? e : "发送失败（已保留输入）"}`,
    });
  } finally {
    btn.disabled = false;
  }
}
```

或者更好：调用方拿到 `id` 后再 `input.value=""`，失败时还原。

---

### P1-#G 消息 ID 在前端和后端两套生成，结果不一致

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/chat/chat.js:289`（前端）vs `src-tauri/src/chat.rs:141-146`（后端） |
| 严重程度 | **P1**（debug / 关联 / 去重困难） |

**问题描述**：

前端 `chat.js:289`：
```js
const id = `msg-${Date.now()}`;
```

后端 `chat.rs:141`：
```rust
let id = format!(
    "msg-{}-{}",
    crate::ws_types::current_timestamp(),
    uuid_like_suffix()
);
```

同一个用户消息产生两个 id：
- 前端 `msg-1719043200000` → 写 SQLite 的 PK
- 后端 `msg-1719043200-abcd1234` → 发到 WS envelope 的 `id` 字段

后端 WS envelope 的 `id` 与 SQLite 的 PK 不对应；服务器返回 `chat_reply` 时用的也是后端 id，**前端要靠内容匹配来识别**，无法用 id 直接关联。

如果以后想做 “点气泡重发” 或 “按 id 去重”，会立刻撞墙。

**修复建议**：

让前端**只负责文本**，id 完全由后端生成（参考 chat.rs 现在的逻辑），返回给前端：

```rust
// chat.rs:181
Ok(id)   // ← 已经返回 id
```

```javascript
// chat.js
const ts = Math.floor(Date.now() / 1e3);
const msgId = await invoke("send_chat_message", { text });
// 用 msgId 替换本地 id
```

或者反过来：前端生成 id，作为入参传给后端，后端原样使用——更省一次 round-trip。

---

### P1-#H 发送失败后没有任何重试/退避队列（消息卡在 SQLite 里但永远不同步）

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/chat.rs:130-182` + `src-tauri/src/chat/chat.js`（无 retry 逻辑） |
| 严重程度 | **P1**（数据一致性） |

**问题描述**：

WS 断开时，`send_chat_message` 把消息持久化到 `chat_history.json` 但**不更新 `db.rs` 的 `chat_messages.synced` 字段**——因为 `chat.rs` 和 `db.rs` 是两套存储（V2 JSON + V3 SQLite），完全独立。

同时 `db.rs` 的 `chat_messages.synced` 字段**永远是 0**（前端 `insert_chat_message` 调用时传 `synced=0`，但前端的“sendMessage”流程只在 `invoke("send_chat_message", …)` 失败时才显示错误气泡，没有在 WS 恢复后批量重发的机制。

`sync_state` 表存在但**没有被任何代码读或写**（`grep sync_state` 命中只有表结构）。

后果：
- WS 抖动期间用户发的消息会变成“幽灵消息”——数据库里有，前端 UI 里也有，但服务端永远收不到；
- 用户的“已发送”气泡其实是“已入库未送达”，没有视觉提示区分。

**修复建议**：

1. **短期**：发送成功后才 `UPDATE chat_messages SET synced=1 WHERE id=?`；失败时让前端用气泡颜色/图标区分 synced=0 状态；
2. **中期**：WS status 变为 `Connected` 后扫描 `synced=0` 的消息批量补发；
3. **或者干脆合并 V2/V3 存储**：`send_chat_message` 内部改写 `chat_messages`（同时更新 synced），删除对 `chat_history.json` 的依赖（让 `db.rs` 接管）。

---

### P1-#I `WsClient::run_loop` 的 cancel_token 检查在每次 `tokio::select!` 之后而不是之前

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/ws.rs:262-330` |
| 严重程度 | **P1**（重连延迟，最坏情况下 30s） |

**问题描述**：

```rust
loop {
    tokio::select! {
        _ = heartbeat.tick() => { … }
        out = outgoing_rx.recv() => { … }
        msg = ws.next() => { … }
    }
    // ← cancel_token 检查在 select 之后
    if self.cancel_token.load(Ordering::SeqCst) {
        tracing::info!("cancel_token set; closing connection to trigger reconnect");
        let _ = ws.close(None).await;
        self.cancel_token.store(false, Ordering::SeqCst);
        return Ok(());
    }
}
```

如果服务端长时间不发任何消息（空闲连接），`outgoing_rx.recv()` 和 `ws.next()` 都阻塞着。cancel_token 被 set 后，要等下一次收到任何帧（包括服务端 30s 一次的 ping/pong）才会被检测到。

虽然 ping 30s 一次不算太差，但加上 select 的随机唤醒，最坏情况 30+1 秒重连延迟。

**修复建议**：

把 cancel_token 检测也放进 select：

```rust
loop {
    tokio::select! {
        _ = heartbeat.tick() => { … }
        out = outgoing_rx.recv() => { … }
        msg = ws.next() => { … }
        _ = wait_cancel(&self.cancel_token) => {   // 新分支
            let _ = ws.close(None).await;
            return Ok(());
        }
    }
}

async fn wait_cancel(tok: &Arc<AtomicBool>) -> std::future::Pending<()> {
    if tok.load(Ordering::SeqCst) {
        std::future::ready(()).await
    } else {
        std::future::pending::<()>().await
    }
}
```

或者用 `tokio::sync::Notify` + `notify_one()`，更干净。

---

### P1-#J 心跳 PONG 超时判断竞态：35s 阈值相对 30s ping 间隔太宽松

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/ws.rs:44-45, 257-279` |
| 严重程度 | **P1**（误判或漏判） |

**问题描述**：

```rust
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const PONG_TIMEOUT: Duration = Duration::from_secs(35);

let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
heartbeat.tick().await;
```

逻辑：每 30s 发一次 ping；每次 tick 都检查 “上次 pong 距今 > 35s 就断开”。

问题：
1. 第一次 `heartbeat.tick()` 立即 tick 一次（Tokio interval 的默认行为）；紧接着连发两个 ping 间隔只差 ~0s，可能造成服务端节流。
2. “35s 阈值” 判断的是 **上一次心跳以来的延迟**——意味着服务端**少回一个 pong 就会断连**。一次网络抖动 / 服务端 GC 暂停就可能触发。
3. 没有把“刚连上 / 刚发 ping”的宽容期算进去，连接建立后第 30s 就开始检查，可能把第一个 pong 还没回来的连接误断。

**修复建议**：

1. `heartbeat.tick().await` 之后立刻去掉这次快 tick（用 `tokio::time::interval` + 第一次 `tick()` 后 sleep 30s）；
2. PONG_TIMEOUT 拉到 60~90s；
3. 计数 N 次连续缺失再断（例如连续 2 次心跳没回 pong 才断开）；
4. 建议增加 “刚 ping 出去后的宽限窗”——发完 ping 后重置 `last_pong_at` 的宽容起点。

---

### P1-#K `AppState.ws_outgoing` 用 `write()` 锁读取 Option

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/chat.rs:172-179, 217-224, 339-346` |
| 严重程度 | **P1**（并发串行化，但日常不触发） |

**问题描述**：

```rust
let tx = state.ws_outgoing.clone();
let tx_guard = tx.write().await;        // ← 写锁
if let Some(tx) = tx_guard.as_ref() {    // ← 只是读
    tx.send(json).map_err(…)?;
}
```

`UnboundedSender::send` 不需要 await，只需读 Option；这里用了 `RwLock::write()` 等同于 `Mutex`，把所有 send_chat_message / send_group_message / send_consent_response 都串行化。

实际场景下前端有 `btn.disabled` 防抖，单 send 串行无害；但**未来如果要补 retry queue**（见 P1-#H）或者别的后台任务并发 send，会撞这个锁。

**修复建议**：

```rust
let tx_opt = state.ws_outgoing.read().await.clone();  // 读锁 + clone
if let Some(tx) = tx_opt {
    tx.send(json).map_err(…)?;
}
```

或者把 `ws_outgoing` 直接改成 `Arc<Mutex<UnboundedSender<String>>>`（不再需要 Option，因为启动时立即 set）；但这样要求 startup 一定能先 set sender。

---

### P1-#L `chat.rs::append_internal` 写的是 V2 JSON，`db.rs::insert_chat_message` 写的是 V3 SQLite——双写不一致

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/chat.rs:84-110, 262-270`（V2 JSON） vs `src-tauri/src/db.rs:288-307`（V3 SQLite） |
| 严重程度 | **P1**（数据双轨） |

**问题描述**：

同一个用户消息被写两份：
- `chat.js::sendMessage` 调 `invoke("insert_chat_message")` → SQLite（`db.rs`）；
- `chat.rs::send_chat_message` 又调 `append_internal` → `~/.feclaw/chat_history.json`（V2 遗留）；

两份内容甚至字段都不一样：
- V2 JSON：`{id, role, content, timestamp, agent}`
- V3 SQLite：`{id, channel, agent_hash, role, content, message_type, created_at, synced, is_deleted}`

历史回放时 `get_chat_history`（V2 JSON）和 `get_chat_history_by_agent`（V3 SQLite）给出的列表**不一致**——chat.js 走的是 SQLite，但前端”新对话“按钮调用的是 `clear_chat_history`（V2）只删 JSON。

**修复建议**：

1. 短期：把 `chat.rs::send_chat_message` 改成调用 `db::insert_chat_message`，不再写 `chat_history.json`；
2. 中期：把 `import_chat_history`（`db.rs:150-190`）保留为一次性 V2→V3 迁移，迁移完删 `chat_history.json`。

---

### P1-#M `WsRequest::ChatReply` 缺字段映射——`text`/`agent`/`timestamp` 直接传字符串

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/ws_types.rs:111-118` |
| 严重程度 | **P1**（前后端协议容易脱节） |

**问题描述**：

```rust
#[serde(rename = "chat_reply")]
ChatReply {
    id: String,
    text: String,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
},
```

`text` 字段没限定长度——如果服务端把整个 Markdown / 大段工具输出塞进来，会推一个巨大 WS 帧（虽然 tungstenite 会切帧，但 1MB 单帧会很慢）。

另外缺字段 `is_final: bool`、`round: u32`、`tool_calls: Option<Vec<ToolCall>>` 等——目前协议扩展性差，加一个字段两边都得改。

**修复建议**：

```rust
ChatReply {
    id: String,
    text: String,           // 限定单帧 ≤ 64KB；超过要求服务端分片
    agent: Option<String>,
    timestamp: Option<String>,
    #[serde(default)]
    is_final: Option<bool>, // P0.6 协议扩展预留
    #[serde(default)]
    attachments: Option<Vec<serde_json::Value>>,
}
```

加上 size 校验（在 `handle_message` 入口），超长直接报错并丢弃。

---

## 3. P2 级问题（代码质量 / 可维护性）

### P2-#N `append_chat_message` 与 `persist_to_disk` 重复代码

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/chat.rs:84-110`（`append_chat_message`）vs `chat.rs:241-260`（`persist_to_disk`） |
| 严重程度 | **P2** |

**问题描述**：

两段几乎完全一样的 “读 JSON → push → 写 JSON” 代码：

```rust
// append_chat_message
let mut list: Vec<ChatMessage> = match tokio::fs::read_to_string(&path).await { … };
list.push(message);
let json = serde_json::to_string_pretty(&list).map_err(…)?;
tokio::fs::write(&path, json).await.map_err(…)?;

// persist_to_disk —— 完全一样
let mut list: Vec<ChatMessage> = match tokio::fs::read_to_string(&path).await { … };
list.push(message.clone());
let json = serde_json::to_string_pretty(&list).map_err(…)?;
tokio::fs::write(&path, json).await.map_err(…)?;
```

`append_chat_message`（Tauri command）只是对 `persist_to_disk` 加了个 `pub` 包装，且两者**没有任何并发保护**——`get_chat_history` 读 JSON 时如果 `append_chat_message` 写到一半，会读到半截 JSON（parse error 被 catch 静默成空列表，见 `chat.rs:67-70`，但消息会丢）。

**修复建议**：

合并成单个私有函数 + 加 Mutex 串行化：

```rust
static HISTORY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn push_internal(message: ChatMessage) -> Result<(), String> {
    let _g = HISTORY_LOCK.lock().await;
    // …读 / push / 写…
}
```

并且删掉 `append_chat_message`（Tauri command）——前端不需要它，前端走 `db.rs::insert_chat_message`。

---

### P2-#O 前端双重事件监听 + 重复发送检测不完善

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/chat/chat.js:279-350, 595-606` |
| 严重程度 | **P2** |

**问题描述**：

`sendMessage` 里写了：
```javascript
store.appendMessage(msg);
const list = $("messages");
if (list) renderMessageEl(list, msg);     // 手动渲染一个气泡
scrollToBottom();
```

但 `chat.js:595` 的 `chat-event` 监听器也会：
```javascript
await listen("chat-event", (e) => {
  const msg = e.payload;
  if (!msg || !msg.id) return;
  if (msg.agent_hash !== store.activeAgentHash) return;
  store.appendMessage(msg);
  const list = $("messages");
  if (list) renderMessageEl(list, msg);    // 又渲染一个
});
```

如果后端把用户自己的消息以某种 ack 形式回包（部分 server 实现会 echo），`chat-event` 收到后会和本地乐观渲染的 user 气泡**重复**。需要在前端加 `if (msg.role === "user") return;` 之类的去重。

另外：
- `btn.disabled = true` 是唯一防重——如果用户开了多个 chat 窗口（前端用了 webview window），每个窗口独立 `btn.disabled`，互不知情，可并发发送。
- 离线恢复后没有 “补发历史消息” 逻辑，参见 P1-#H。

**修复建议**：

```javascript
await listen("chat-event", (e) => {
  const msg = e.payload;
  if (!msg || !msg.id) return;
  if (msg.agent_hash !== store.activeAgentHash) return;
  if (msg.role === "user") return;          // ← 去重
  // 检查 store 里是否已存在同 id
  if (store.messages.some(m => m.id === msg.id)) return;
  store.appendMessage(msg);
  const list = $("messages");
  if (list) renderMessageEl(list, msg);
});
```

---

### P2-#P `chat.js::sendMessage` 的 `err-${Date.now()}` 可能撞 ID

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/chat/chat.js:326, 337` |
| 严重程度 | **P2** |

**问题描述**：

```javascript
const errMsg = typeof e === "string" ? e : "发送失败";
store.appendMessage({
  id: `err-${Date.now()}`,      // ← 326
  …
});
const list2 = $("messages");
if (list2) {
  renderMessageEl(list2, {
    id: `err-${Date.now()}`,    // ← 337 又生成一次，可能不同
    …
  });
}
```

两次 `Date.now()` 调用若跨秒边界，**id 就不一致**——`store.messages` 里和 DOM 里分别是两个 id。

**修复建议**：

```javascript
const errId = `err-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const errPayload = {
  id: errId,
  channel: msg.channel,
  agent_hash: store.activeAgentHash,
  role: "assistant",
  content: `⚠ ${errMsg}`,
  message_type: "text",
  created_at: Math.floor(Date.now() / 1e3),
};
store.appendMessage(errPayload);
const list2 = $("messages");
if (list2) renderMessageEl(list2, errPayload);
```

---

### P2-#Q 没有为 send_chat_message 区分 “持久化成功但 WS 失败” 的 UI 状态

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/chat/chat.rs:176, 178, 222, 345` |
| 严重程度 | **P2** |

**问题描述**：

`send_chat_message` 在 `tx.send(json)` 失败时返回 `"WebSocket 已断开，消息仅保存到本地"`，但消息已经被 `append_internal` 持久化了——这种半成功状态，前端 UI 只能把整个调用当失败（catch 路径显示 ⚠ 气泡 + 还可能清空输入框，见 P1-#F），让用户以为消息彻底丢失了。

实际上消息是落在 SQLite 里的，下次窗口打开通过 `get_chat_history_by_agent` 还能看到。

**修复建议**：

```rust
// chat.rs::send_chat_message 返回 enum 而不是 String
pub enum SendResult {
    Delivered,                          // WS 发送成功
    PersistedOffline,                   // 已入库但 WS 断；前端可显示 ⏳
}
```

前端按结果区分气泡状态（灰底“待发送” vs 蓝底“已发送”）。

---

### P2-#R `WsClient::connect_tls` 用 URL 解析 host:port 在 IPv6 / 路径含特殊字符时会失败

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/ws.rs:139-180` |
| 严重程度 | **P2**（一般部署不会触发，但 cloud URL 含 IPv6 / 用户名时炸） |

**问题描述**：

```rust
let host_port = url_with_token
    .strip_prefix("wss://")
    .or_else(|| url_with_token.strip_prefix("ws://"))
    .unwrap_or(&url_with_token)
    .split('/')
    .next()
    .unwrap_or("")
    .split('?')
    .next()
    .unwrap_or("");

let tcp = TcpStream::connect(host_port).await
    .map_err(|e| anyhow!("ws tcp connect to {host_port}: {e}"))?;
```

`host_port` 永远是 `host:port` 的纯文本。问题：
- IPv6：`wss://[::1]:8080/ws/desktop` → `[::1]:8080` 包含 `[]`，`TcpStream::connect` 不能直接接带方括号的字符串；
- 带 userinfo：`wss://user:pass@host/ws/desktop` → `user:pass@host` 无法解析；
- 默认端口：`wss://host/ws/desktop` 没显式端口时会 connect 443 而不是 443（取决于 tokio 版本行为）。

**修复建议**：

用 `url::Url::parse(&url_with_token)` 然后取 `host_str()` + `port_or_known_default()`：

```rust
use url::Url;
let parsed = Url::parse(&url_with_token)?;
let host = parsed.host_str().context("missing host")?;
let port = parsed.port_or_known_default().context("missing port")?;
let host_port = if parsed.host().is_ipv6() {
    format!("[{host}]:{port}")
} else {
    format!("{host}:{port}")
};
```

依赖已存在（tokio-tungstenite 内部用了 url crate），加进 Cargo.toml 即可。

---

### P2-#S `cancel_token.store(false, Ordering::SeqCst)` 在 `run_loop` 末尾重置——但 cloud_loop / run 的下一次循环没检查

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/ws.rs:325-330` vs `engine.rs:276-282` |
| 严重程度 | **P2** |

**问题描述**：

`ws.rs::run_loop` 在 cancel_token 被 set 后会 close 连接、reset token、return Ok。但 caller `run()`（`ws.rs:182-209`）的 for 循环只看到 Ok 就 `set_status(Disconnected)` 然后**直接进入下一次 attempt**——不会重新检查 cancel_token。

虽然下一次 attempt 立刻又会发起 connect，对“单次 cancel 后强制重连”这个语义是 OK 的。但如果 cancel_token 在 attempt 2 进行中再次被 set（例如 user 连点两次 reconnect），第二次 cancel 在 run_loop 第一次 tick 后才会被检测到（参见 P1-#I 的延迟）。

而 `engine.rs::cloud_loop` 在循环顶部显式检查 cancel_token：

```rust
// engine.rs:279
if cancel_token.load(Ordering::SeqCst) {
    cancel_token.store(false, Ordering::SeqCst);
    tracing::info!("cloud loop: reconnect requested via cancel token");
}
```

但 cloud_loop 是 P0-#E 的死代码，所以这个检查目前无效。

**修复建议**：

让 `run()` 也尊重 cancel_token，参考 cloud_loop 的模式；或统一改用 `tokio::sync::Notify`，避免 atomic bool 的 race。

---

### P2-#T `chat.rs::send_group_message` 复制了 `send_chat_message` 的 WS 发送样板代码

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/chat.rs:186-227, 318-348` |
| 严重程度 | **P2** |

**问题描述**：

`send_chat_message` / `send_group_message` / `send_consent_response` 三段代码模式几乎一致：

```rust
let envelope = serde_json::json!({ … });
let json = serde_json::to_string(&envelope).map_err(…)?;
let tx = state.ws_outgoing.clone();
let tx_guard = tx.write().await;
if let Some(tx) = tx_guard.as_ref() {
    tx.send(json).map_err(|_| "WebSocket 已断开，…".to_string())?;
} else {
    return Err("WebSocket 发送端未初始化".to_string());
}
```

任何一处改动（例如 P1-#K 改用 read 锁）都得改三遍。

**修复建议**：

抽到 `chat.rs` 里一个内部 helper：

```rust
async fn send_envelope(state: &AppState, envelope: serde_json::Value, err_msg: &'static str) -> Result<(), String> {
    let json = serde_json::to_string(&envelope)
        .map_err(|e| format!("序列化失败：{e}"))?;
    let tx_opt = state.ws_outgoing.read().await.clone();
    match tx_opt {
        Some(tx) => tx.send(json).map_err(|_| err_msg.to_string()),
        None => Err("WebSocket 发送端未初始化".to_string()),
    }
}
```

---

### P2-#U 前端没有 “WS 离线时禁用 send 按钮” 的视觉提示

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/chat/chat.js:539-572`（`ws-status` 监听器） |
| 严重程度 | **P2** |

**问题描述**：

前端监听 `ws-status` / `connection-status`，更新右上角连接点颜色，但 **send 按钮在 WS 断开时仍可点击**——点击后才在 catch 里显示 ⚠ 错误。更好做法是：

- `disconnected` 时按钮置灰 + 提示 “等待连接…”；
- `connected` 后如果有 “未发送” 的消息自动补发（结合 P1-#H）。

**修复建议**：

```javascript
await listen("ws-status", (e) => {
  const s = e.payload.status;
  const btn = $("btn-send");
  if (btn) {
    btn.disabled = (s !== "Connected" && s !== "Connecting");
    btn.title = (s === "Connected") ? "" : "WebSocket 离线，无法发送";
  }
  // …既有 UI 更新…
});
```

---

### P2-#V 缺少端到端测试覆盖消息往返

| 字段 | 内容 |
|---|---|
| 代码位置 | `src-tauri/src/ws_types.rs:372-695`（只有协议层单测） |
| 严重程度 | **P2** |

**问题描述**：

`ws_types.rs` 有详尽的 `serde_json` 协议单测，但**没有任何端到端测试**模拟：
1. send_chat_message 写入 JSON + WS envelope 正确性；
2. 收到 ChatReply / ChatEvent 后 `persist_and_emit` 被调用、emit 出正确的 Tauri event；
3. ws.run 在 auth-failure 4001 时正确退出并触发 clear_token。

目前的协议单测都绿，但 P0-#A / P0-#E 这种 “逻辑根本没接通” 的 bug 完全不会被发现。

**修复建议**：

加 `tests/chat_e2e.rs`：mock 一个 echo server（用 `tokio-tungstenite` 监听本地端口），跑：

```rust
let (tx, rx) = …;
let ws = spawn(WsClient::new("ws://127.0.0.1:PORT", "".into(), …, Some(app)));
// 1. send_chat_message → 验证 WS 收到正确的 envelope
// 2. mock server 回包 chat_reply → 验证 app_handle.emit("chat-event", …) 被调用
// 3. 关掉 server → 验证 run() 在 30 次后退出并 set_status(Failed)
```

---

## 4. 修复优先级建议（落地顺序）

| 顺序 | 任务 | 估时 | 依赖 |
|---|---|---|---|
| 1 | **P0-#A** 修 `ChatReply` / `ChatEvent` 路径：调用 `persist_and_emit`、emit `chat-event` / `chat-stream` | 半天 | 需先解决 `app_handle=None`（修 #B 才能拿 handle） |
| 2 | **P0-#B** cloud 控制泵补 `cancel_token.store(true)`；改 `MAX_RECONNECT_ATTEMPTS` 为无限/长退避 | 2h | — |
| 3 | **P0-#E** 让 cloud 模式走 `cloud_loop`（或保留双 WsClient 但补 auth-failure 处理） | 1 天 | #A |
| 4 | **P1-#F** 前端发送失败保留输入框文字 | 1h | — |
| 5 | **P1-#H** 发送失败时消息标 `synced=0`、WS 重连后批量补发 | 1 天 | #B（重连路径稳定） |
| 6 | **P1-#G** 统一前后端消息 id 协议 | 半天 | — |
| 7 | **P1-#I / #J** select! 加 cancel 分支；放宽 PONG_TIMEOUT | 2h | — |
| 8 | **P1-#K / #L** `ws_outgoing` 改读锁；合并 V2/V3 存储 | 半天 | — |
| 9 | **P2 全部** 代码质量 / 测试 | 1–2 天 | — |

---

## 5. 附录：关键调用链速查

### 5.1 send_chat_message 完整调用图

```
chat.js::sendMessage (chat.js:279)
  ├─ insert_chat_message → db.rs:288 (SQLite)
  ├─ invoke("send_chat_message") ── Tauri IPC
  │    └─ chat.rs::send_chat_message (chat.rs:130)
  │         ├─ append_internal → persist_to_disk → chat_history.json (chat.rs:241)
  │         └─ state.ws_outgoing.write() → UnboundedSender::send
  │              └─ WsClient::run_loop  select! outgoing_rx branch (ws.rs:280)
  │                   └─ ws.send(Message::Text(json)) → TCP/TLS → server

server ──── chat_reply / chat_event ────►
  WsClient::handle_message (ws.rs:334)
    ├─ ChatReply → ❌ 只 tracing::info!（P0-#A）
    ├─ ChatEvent → ❌ 只 tracing::info!（P0-#A）
    ├─ GroupMessage → ✅ app_handle.emit("group-message", …)
    ├─ GroupEvent → ✅ app_handle.emit("group-event", …)
    ├─ UploadComplete → ✅ app_handle.emit("upload-complete", …)
    └─ FileOperationRequest → ❌ 只 tracing::info!（consent 流程未接通）

chat.js listens:
  ├─ "chat-event"     → 监听器在 (chat.js:595)  ← 永远收不到（P0-#A）
  ├─ "chat-stream"    → 监听器在 (chat.js:608)  ← 永远收不到（P0-#A）
  ├─ "ws-status"      → 监听器在 (chat.js:552)  ← OK
  └─ "connection-status" → 监听器在 (chat.js:574)  ← OK
```

### 5.2 cloud mode / local mode 启动路径差异

```
lib.rs::startup()
  │
  ├─ if Mode::Cloud (lib.rs:371) ────────────────┐
  │    ├─ 建 AppState                             │
  │    ├─ WsClient::new(...)                      │
  │    ├─ ws_outgoing = Some(ws.sender())         │
  │    ├─ spawn { ws.run() }                      │ ← 30 次重连上限
  │    ├─ spawn { status pump }                   │   ⚠ P0-#B：30 次后
  │    ├─ spawn { control pump }                  │     永久离线；Reconnect
  │    │    └─ Reconnect → 只 tracing::info! ⚠   │     菜单无效
  │    └─ return Ok(token)                        │
  │       ※ engine.start() 从未被调用 ───────┐    │
  └─ else Mode::Local (lib.rs:478)         │    │
       ├─ engine.start() ──────┐           │    │
       │   ├─ Local → start_local()       │    │
       │   └─ Cloud → start_cloud() → cloud_loop() ← 死代码 ⚠ P0-#E
       ├─ WsClient::new(...)
       ├─ ws_outgoing = Some(ws.sender())
       ├─ spawn { ws.run() }
       ├─ spawn { status pump }
       └─ spawn { control pump }
            └─ Reconnect → cancel_token.store(true) ✅
```

### 5.3 关键文件 + 行号速查表

| 关注点 | 文件:行 |
|---|---|
| 前端发送入口 | `chat/chat.js:279-350` |
| 前端监听 chat-event | `chat/chat.js:595-606` |
| 前端监听 chat-stream | `chat/chat.js:608-648` |
| 前端 WS 状态显示 | `chat/chat.js:551-592` |
| Tauri command send_chat_message | `chat.rs:130-182` |
| append_internal + persist_to_disk | `chat.rs:241-270` |
| send_group_message | `chat.rs:186-227` |
| send_consent_response | `chat.rs:318-348` |
| SQLite insert_chat_message | `db.rs:288-307` |
| SQLite get_chat_history_by_agent | `db.rs:253-285` |
| AppState 定义 | `lib.rs:111-130` |
| cloud mode 启动 | `lib.rs:371-475` |
| local mode 启动 | `lib.rs:477-644` |
| cloud control pump（缺 cancel_token） | `lib.rs:434-472` |
| local control pump（有 cancel_token） | `lib.rs:582-627` |
| WsClient 结构 | `ws.rs:59-80` |
| connect_tls（host:port 解析） | `ws.rs:139-180` |
| run（30 次重连上限） | `ws.rs:182-209` |
| run_loop（select! + cancel） | `ws.rs:252-332` |
| handle_message（chat_reply 未接通） | `ws.rs:334-460` |
| GroupMessage 正确 emit（参照） | `ws.rs:387-400` |
| 云模式 cloud_loop（死代码） | `engine.rs:268-385` |
| ws_url 构造 | `config.rs:161-179` |
| MAX_RECONNECT_ATTEMPTS=30 | `ws.rs:46` |
| 心跳间隔 30s / PONG 超时 35s | `ws.rs:44-45` |

---

## 6. 总结

**核心阻塞点（P0）有 3 个**：
1. 服务器回复完全丢失（`#A`）——前端能看到发出消息，但永远看不到回复；
2. 云模式 30 次重连后永久离线（`#B`）——长时间网络抖动后必须重启应用；
3. `engine.rs::cloud_loop` 的 auth-failure 处理是死代码（`#E`）——token 失效不会清理，UI 不会收到 “session expired”。

**最大隐患**：P0-#A + P0-#E 同时存在时，用户经历 “发消息 → 等不到回复 → 想重连发现菜单无效 → token 还在但服务端已拒 → 整个 client 半死”——这正是当前 cloud 模式完整掉链的路径。

**短期止血**：先修 #A（`persist_and_emit` 接通）+ #B（cloud 控制泵补 cancel_token）能在不重构的前提下让 cloud 模式基本可用；之后 #E、#F、#G、#H 一起做才有完整的 IM 体验。