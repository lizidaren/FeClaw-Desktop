# FeClaw-Desktop V3 — Architecture & Extensibility Audit

> Review date: 2026-06-22 | Scope: `src-tauri/src/` + `src-tauri/src/chat/` frontend

---

## 1. Code Structure

### Finding 1.1 — `types.rs` is nearly empty; `ws_types.rs` holds the real shared types
- **Observation:** `types.rs` contains only `AgentInfo`. All other cross-module wire types (inbound/outbound WS envelopes, connection status, group payloads) live in `ws_types.rs`. This split is undocumented and non-obvious.
- **Impact (now):** Low — it works, but a reader unfamiliar with the codebase won't know where to look for shared types.
- **Recommendation:** Merge `types.rs` into `ws_types.rs` (or rename `types.rs` to something like `agents.rs`). Add a module-level doc comment explaining the type organization.

### Finding 1.2 — `lib.rs` is doing too many jobs
- **Observation:** `lib.rs` (~510 lines) handles: the `run()` Tauri entry point, `AppState`, `ControlMsg`, `startup()` async function (cloud/local branching, status pump, control pump, idle watcher, WS task, right-click pending check). The startup logic alone is ~250 lines with deeply nested async blocks.
- **Impact (now):** Hard to test in isolation, hard to modify one concern without understanding all of them. The two startup paths (cloud vs local) share state-building code that is nearly but not entirely identical — this is a common source of divergence bugs.
- **Recommendation:** Extract each concern into its own module: `startup/cloud.rs` and `startup/local.rs` for the two modes, `startup/shared.rs` for the common AppState wiring, `pumps/status.rs` and `pumps/control.rs` for the two pump loops.

### Finding 1.3 — Dead code: `_phantom_marker()` in `chat.rs`
- **Observation:** `chat.rs` line 371–372 has a `#[allow(dead_code)]` + `pub(crate) fn _phantom_marker() {}` with comment "Currently unused — kept here so future extensions can lock around disk appends without re-importing the helpers." This is vestigial.
- **Impact (now):** Noise.
- **Recommendation:** Remove it. If disk serialization locking is needed in future, re-add with a real implementation.

---

## 2. State Management

### Finding 2.1 — `engine_running` is in `AppState` but never mutated
- **Observation:** `AppState.engine_running: Arc<RwLock<bool>>` is present in both cloud and local startup paths, always initialized to `false`, and marked `#[allow(dead_code)]`. It is never written to. The comment says it "was planned for pause/resume engine work."
- **Impact (future):** When pause/resume is needed, the field exists as a placeholder but has no writer. A developer might read it expecting it to be current.
- **Recommendation:** Either remove it (and add a proper engine pause API when needed), or wire it up to `EngineManager` status now so it is a live signal.

### Finding 2.2 — `ws_outgoing` is stored redundantly in `AppState`
- **Observation:** `WsClient::sender()` already returns a clone of the internal `mpsc::UnboundedSender<String>`. The sender is stored in `AppState::ws_outgoing` and then re-read by `send_chat_message` via `state.ws_outgoing.read().await`. The `WsClient` is not stored in `AppState` — only the sender channel. When `WsClient` is dropped, the sender becomes invalid, but there's no lifetime link between the WS task and the stored sender.
- **Impact (now):** If the WS task panics or the client is dropped, `ws_outgoing` becomes a stale sender with no error. `send_chat_message` will silently fail to send (the `send()` on a closed channel returns `Err`).
- **Recommendation:** Store the `WsClient` itself (or an `Arc<WsClient>`) in `AppState` rather than just the sender. This gives callers access to the client's status and prevents stale-sender issues. Alternatively, wrap the sender in a struct that detects disconnection.

### Finding 2.3 — Mixed `tokio::sync::Mutex` and `std::sync::Mutex` in the same type hierarchy
- **Observation:** `ConsentManager` is protected by `tokio::sync::Mutex` (async context), while `EngineManager::stdout_buffer` uses `std::sync::Mutex` (sync context). This is intentional and correct — but it's worth noting that `ConsentManager` uses `tokio::sync::Mutex` while the rest of `AppState` fields use `RwLock`. There's no principled policy documented for which lock type to use.
- **Impact (now):** Low — it's correct by accident rather than by design.
- **Recommendation:** Document the locking strategy: `RwLock` for read-mostly shared config/status, `tokio::sync::Mutex` when the locked type has async methods, `std::sync::Mutex` for blocking-only access.

---

## 3. Feature Gating

### Finding 3.1 — `log` crate is declared in `Cargo.toml` but never imported
- **Observation:** `log = "0.4"` is in `[dependencies]` but `grep -rn "^use log" src/` returns nothing. Only `tracing` is used. The `tauri-plugin-log` uses `tracing` internally, not the `log` facade.
- **Impact (now):** Wasted dependency resolution time, a misleading crate list for readers.
- **Recommendation:** Remove `log` from `Cargo.toml`.

### Finding 3.2 — Feature granularity: `desktop` covers ~14 modules
- **Observation:** `feature = "desktop"` gates: `alt_space`, `autostart`, `engine`, `executor`, `file_bridge`, `file_index`, `file_ops`, `local_setup`, `right_click`, `tray`. These modules vary in size and independence. `file_bridge` and `file_index` are relatively independent of the tray/shortcut machinery.
- **Impact (future):** When adding mobile support, some (but not all) desktop features can be excluded. The current binary split is "everything desktop or nothing." Fine-grained features would allow mobile to include `engine` but exclude `tray`, for example.
- **Recommendation:** Consider splitting into smaller features: `tray`, `global-shortcut`, `file-system` (covering `file_ops`, `file_bridge`, `file_index`), `local-engine`, `right-click`. This doesn't affect binary size today but enables more precise conditional compilation for mobile.

### Finding 3.3 — `#[cfg(feature = "desktop")]` guard on `windows-hwnd` in `Cargo.toml` has no code gated by it
- **Observation:** `windows-hwnd = []` is listed in `[features]` but no `#[cfg(feature = "windows-hwnd")]` appears in any source file.
- **Impact (now):** None — it's inert.
- **Recommendation:** Remove it or implement the HWN-based window handle extraction if that capability is needed.

---

## 4. Error Handling

### Finding 4.1 — Inconsistent error types: `Result<T, String>` vs `Result<T, anyhow::Error>` vs raw `rusqlite::Error`
- **Observation:** Most Tauri commands return `Result<T, String>` (e.g., all chat commands). Some internal functions return `Result<T, anyhow::Error>`. `db.rs` uses raw `rusqlite::Error` in several places without wrapping. `StartupError` is a dedicated enum.
- **Impact (now):** Callers can't uniformly propagate errors. Converting between `String`, `anyhow::Error`, and `rusqlite::Error` requires boilerplate. The frontend receives error strings that may or may not be user-friendly.
- **Recommendation:** Pick a convention: prefer `anyhow::Error` for internal errors (with `.to_string()` at the Tauri command boundary), keep `StartupError` as a typed enum for startup-only errors, and map `rusqlite::Error` to a custom `DbError` enum before exposing to command handlers.

### Finding 4.2 — `log` facade unused (see 3.1) means `log::*` macros are not available
- **Observation:** If the intent was to use the `log` facade for compatibility with libraries that emit `log` events, it needs to be wired up with a `log::Logger` implementation. Currently only `tracing` is used.
- **Impact (now):** Some libraries that emit `log` messages (if used in future) won't have a logger configured.
- **Recommendation:** Remove `log` from Cargo.toml unless a specific crate requires it. If logging compatibility is needed, add `log` + `tracing` bridge.

### Finding 4.3 — Panic handling in async tasks
- **Observation:** `async_runtime::spawn_blocking` in `handle_file_read` and `handle_file_write` catches panics with `.await` on the JoinHandle (the `result` variable), but the comment says "read task panicked" — this is correct. However, the `CommandExecutor::execute` call in `spawn_command_exec` is not wrapped in `spawn_blocking`; it's called directly in an async task. If `execute` panics, it kills the task.
- **Impact (now):** A panic in `execute` (e.g., from a buggy shell command) would silently terminate the command-handling task, leaving the engine waiting for a response that never comes.
- **Recommendation:** Wrap `executor.execute()` in `async_runtime::spawn_blocking` or add a panic handler. Also add a timeout at the `spawn` level (not just inside `execute`).

---

## 5. Frontend Architecture (chat.js / store.ts)

### Finding 5.1 — `chat.js` is a large monolith (~800+ lines)
- **Observation:** A single `chat.ts` file handles: DOM helpers, rendering (list + messages + attachments), actions (send, select), tab switching, event subscriptions, stream handling, composer, utilities. No separation between rendering logic, business logic, and event handling.
- **Impact (now):** Difficult to locate specific functionality. High risk of merge conflicts in team collaboration.
- **Impact (future):** Adding new UI panels (settings sub-pages, a second chat view, etc.) will grow this file further.
- **Recommendation:** Split along responsibility lines: `chat/renderer.ts` (DOM building), `chat/store-client.ts` (store class + helpers), `chat/actions.ts` (send, select, etc.), `chat/events.ts` (Tauri event subscriptions), `chat/streaming.ts` (append/finalize streaming).

### Finding 5.2 — Store is not persisted; no offline/reload story
- **Observation:** `Store` class holds all state in memory. The `agents` list, `chatItems`, `messages`, `groups`, `moments` are re-fetched from SQLite/WS on every `initChat()`. There is no serialized store snapshot.
- **Impact (now):** On page reload, the UI re-fetches everything. Acceptable for MVP but means no offline mode and no fast cold-start.
- **Recommendation:** When persistence is needed, serialize the store to `localStorage` or a SQLite table. A `Store Hydration` step on load can restore the last known state before the network fetch completes.

### Finding 5.3 — Event subscriptions race condition window
- **Observation:** `subscribeEvents()` (which calls `listen(...)` for all Tauri events) is called after `initChat()` in `DOMContentLoaded`. Events that arrive between app startup and the `listen()` call will be silently dropped.
- **Impact (now):** Low — events are fire-and-forget, and no critical state is lost by missing one event. But for `moments-event` or `group-message`, a dropped event means the UI is out of sync until the next update.
- **Recommendation:** Register all `listen()` handlers before any async initialization. Or use a message queue (the store itself) that is initialized synchronously, with async subscriptions draining it.

### Finding 5.4 — `ChatMessage` type is defined twice with different field names
- **Observation:** Rust `chat.rs` defines `ChatMessage` with `role: String`, `content: String`, `timestamp: Option<String>`, `agent: Option<String>`, `id: String`, `message_type` (via `#[serde(default)]`). The TypeScript `store.ts` defines `ChatMessage` with `role`, `content`, `id`, `message_type?`, `created_at: number`, `timestamp?`, `agent?`, `agent_hash?`, `attachments?`. The two are not code-generated from a shared schema.
- **Impact (now):** Any field rename or type change requires manual edits in two places. Semantic drift (e.g., `timestamp` as `String` in Rust vs `string | undefined` in TS) can cause subtle bugs.
- **Recommendation:** Introduce a shared schema (e.g., Protobuf, JSON Schema + codegen, or at minimum a `types.ts` that mirrors the Rust `ws_types.rs` with explicit field correspondence). At minimum, document the field mapping explicitly in a comment.

---

## 6. Extensibility

### Finding 6.1 — Adding a new `WsRequest` variant requires edits in 3 places
- **Observation:** To add a new inbound WS message type, you must: (1) add a variant to `ws_types.rs`'s `WsRequest` enum, (2) add a match arm in `ws.rs`'s `handle_message`, (3) add a `listen` call in `chat.ts`'s `subscribeEvents` (if it needs frontend visibility). There is no automated wiring.
- **Impact (future):** Adding features is straightforward but requires knowing all three locations. Missing step 2 or 3 produces silent failures (variant is parsed but discarded).
- **Recommendation:** Consider a `trait WsMessageHandler` or a registry pattern: each module registers a handler for specific `WsRequest` variants at startup. This makes the dispatch explicit and self-documenting.

### Finding 6.2 — Adding a new agent type is relatively contained
- **Observation:** Agent types are identified by string (`hash`) rather than a typed enum. New agent types only require: (1) backend support for the new agent kind, (2) frontend `AgentInfo` type update, (3) UI rendering changes. No new wire types needed.
- **Impact (now):** Positive — the architecture accommodates agent diversity through data rather than code branching.
- **Recommendation:** Maintain this pattern. Avoid introducing agent-type enums in the wire protocol.

### Finding 6.3 — No plugin or module system; hard extension points
- **Observation:** All functionality is compiled into the binary. There are no `#[async_trait]` dynamic trait objects, no `Extension` registries, no `include_bytes!` or dynamic loading. Extension would require a full feature flag rebuild.
- **Impact (future):** Third-party features (custom agent behaviors, additional panels, etc.) require forking or feature-gating. For a desktop app this is acceptable for MVP, but the architecture doesn't support a plugin marketplace.
- **Recommendation:** If a plugin system is planned, the consent subsystem (`ConsentManager`) and the WS dispatch are the two most natural extension points. Design a `trait WsExtension` that modules can implement to claim interest in specific `WsRequest` variants.

### Finding 6.4 — Mobile support is prepared at the feature level but lacks mobile-specific WS
- **Observation:** The `mobile` feature removes desktop-only modules, but there is no mobile-specific WS implementation. Mobile still uses `WsClient` which assumes a file system and the same file-bridge protocol.
- **Impact (future):** When building the mobile companion app, the WS protocol will need mobile-specific handling for: (a) no local file system for `file_read_request`/`file_write_request`, (b) potentially different auth flow, (c) different notification handling.
- **Recommendation:** Define a `trait WsMessageHandler` and a `DesktopWsHandler` that implements file system operations. For mobile, provide a `MobileWsHandler` that returns appropriate "not supported" responses. This is a moderate refactor but the groundwork is already laid.

---

## 7. Tech Debt

### Finding 7.1 — Hardcoded polling loop in `lib.rs` startup
```rust
for _ in 0..50 {
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    if app_for_pending.get_webview_window("main").is_some() { break; }
}
```
- **Observation:** A 5-second hardcoded timeout (50 × 100ms) waiting for the main WebView window to appear. No cancellation, no adaptive polling.
- **Impact (now):** In slow startup environments (HDD, AV scanning), the right-click pending event may be emitted after the window check loop has already exited.
- **Recommendation:** Use a `tokio::sync::oneshot` channel that the window setup code fires when the WebView is ready, rather than polling. Or increase the poll count with exponential back-off.

### Finding 7.2 — Hardcoded composer height limit (`160px`)
- **Observation:** `autoResize()` in `chat.ts`: `Math.min(input.scrollHeight, 160)`. This is a magic number with no CSS variable or constant.
- **Impact (now):** Users with large font sizes or narrow windows may want more visible input area. No setting to override.
- **Recommendation:** Extract to a named constant `MAX_COMPOSER_HEIGHT_PX`.

### Finding 7.3 — Status label format inconsistency
- **Observation:** `ConnectionStatus` is a Rust enum rendered via `format!("{:?}", status)` (e.g., `"Connected"`, `"Reconnecting"`) and compared as string in TypeScript. The enum variant names are the interface between Rust and JS.
- **Impact (now):** Renaming a Rust variant (e.g., `Connecting` → `EstablishingConnection`) silently breaks the TypeScript string comparisons.
- **Recommendation:** Use explicit `Serialize` with specific string values (e.g., `#[serde(rename = "connected")]`) rather than relying on `Debug` format. Mirror these as TypeScript string constants (`const CONN_STATUS_CONNECTED = "connected"`).

### Finding 7.4 — `log` crate declared but unused (see 3.1)
- **Impact:** Trivial dependency bloat.

### Finding 7.5 — `ChatMessage` double definition (see 5.4)
- **Impact:** Silent drift risk on every field rename.

### Finding 7.6 — V2 protocol remnants in comments
- **Observation:** `ws.rs` line 1 comment says "PR 4: full message dispatch." `handle_file_read` comment says "V2 file bridge." Comments reference "P1.2", "Phase 0a V3" — these are internal development markers that won't age well.
- **Impact (future):** These comments will become confusing as the codebase evolves past these milestones.
- **Recommendation:** Remove PR/Phase/P1.2 markers from comments. Replace with functional descriptions. Keep milestone history in Git commit messages and PR descriptions.

---

## 8. Future Architecture Recommendations

### 8.1 — Streaming Chat: `persist_and_emit` is not yet wired
- **Current state:** `ws.rs` logs `"chat_reply received — handled by persist_and_emit in a later PR"`. The `ChatReply` and `ChatEvent` variants in `WsRequest` are parsed but produce no frontend effect. `store.ts` has `appendStreamingMessage` / `finalizeStreaming` functions wired to the `chat-stream` event (not the `chat-event` event), suggesting the intended streaming protocol uses a separate event channel.
- **Recommended architecture:**
  1. Wire `persist_and_emit` (in `chat.rs`) to `ChatReply` and `ChatEvent` variants in `handle_message`.
  2. For streaming, emit incremental chunks via `app.emit("chat-stream", chunk)` — the frontend already handles this.
  3. Add a "streaming" flag to `ChatMessage` in `store.ts` so the UI can show a pulsing indicator during streaming.
  4. Consider Server-Sent Events (SSE) as an alternative to WS for chat streaming: SSE is unidirectional (engine → desktop), simpler to proxy, and works well over mobile networks.

### 8.2 — WS Bridge vs Direct HTTP
- **Current state:** `WsClient` is the single transport. File read/write goes over WS with base64 encoding (capped at 1MB). The comment notes "consider streaming" for large files.
- **Recommendation:** Split file transport:
  - **Small files (< 1MB):** Continue over WS base64 (already implemented).
  - **Large files:** Use a direct HTTP POST/PUT to a signed URL (presigned URL returned in the WS `file_operation_request` or a separate `file_upload_url` WS message). This avoids base64 bloat and enables resumable uploads.
  - This is a protocol addition, not an architecture change.

### 8.3 — Mobile Architecture Alignment
- **Current gaps:**
  1. `file_ops` (Rust) is desktop-only — `file_manager` is also desktop. Mobile needs its own file access layer (iOS/Android document picker, Android SAF).
  2. `consent.rs` uses `rfd::MessageDialog` (native Windows dialogs) — mobile needs a different consent UX (inline UI or native mobile dialogs).
  3. `WsClient` connects to a desktop-specific WS path `/ws/desktop` — mobile may need a different path or a separate WS endpoint.
  4. `tray`, `right_click`, `autostart`, `alt_space`, `global-shortcut` are all desktop-only by nature.

- **Recommendation:** Create a platform abstraction layer:
  ```
  trait PlatformServices {
    fn file_manager() -> Box<dyn FileManager>;
    fn consent_ui() -> Box<dyn ConsentUI>;
    fn notification() -> Box<dyn Notification>;
    fn ws_url(config: &Config) -> String;
  }
  ```
  Then provide `DesktopPlatform` and `MobilePlatform` implementations. Feature flags select the implementation at compile time.

### 8.4 — Local Mode Future
- **Current state:** Local mode spawns a `feclaw` subprocess. The engine URL is `http://127.0.0.1:{port}`. The `engine_path` is configurable.
- **Recommendations for local mode evolution:**
  1. **Docker support:** Accept `engine_path = "docker:feclaw"` to run the engine in a container instead of a bare process. This isolates the engine from the host filesystem.
  2. **Engine API versioning:** The `EngineManager` should negotiate an API version with the engine on startup. If the engine returns an incompatible version response, surface a clear error rather than silent failures downstream.
  3. **Hot reload:** Currently if the engine process dies, the desktop goes into reconnect loops but doesn't automatically restart it. The idle watcher only exits the app. Consider: restart-on-crash as a configurable option.

### 8.5 — Testability
- **Current state:** `config.rs` has comprehensive unit tests. No integration tests or mock infrastructure for `WsClient` or `AppState`. `chat.rs` has no tests. The `startup` function is not `async fn` with a clear return type that could be unit-tested with a mock `AppHandle`.
- **Recommendation:**
  1. Extract `startup` into a free function (or a `StartupContext` struct) that accepts mockable dependencies (`ConfigLoader`, `WsClientFactory`, `EngineManagerFactory`).
  2. Add integration tests that start the Tauri app in headless mode and exercise the invoke handlers.
  3. The `ws_types` tests are good — maintain this standard for all wire-format types.

---

## Summary Table

| Area | # | Finding | Severity | Effort |
|------|---|---------|----------|--------|
| Structure | 1.1 | `types.rs` nearly empty, split with `ws_types.rs` undocumented | Low | Low |
| Structure | 1.2 | `lib.rs` too large (500+ lines, multiple responsibilities) | Medium | Medium |
| Structure | 1.3 | `_phantom_marker()` dead code in `chat.rs` | Trivial | Trivial |
| State | 2.1 | `engine_running` in `AppState` never mutated | Low | Low |
| State | 2.2 | `ws_outgoing` stored redundantly; stale-sender risk | Medium | Low |
| State | 2.3 | Mixed lock types without documented policy | Low | Low |
| Gating | 3.1 | `log` crate declared but unused | Trivial | Trivial |
| Gating | 3.2 | `desktop` feature too coarse (gates 14 modules) | Low | Medium |
| Gating | 3.3 | `windows-hwnd` feature with no gated code | Trivial | Trivial |
| Error | 4.1 | Inconsistent error types (`String` vs `anyhow` vs raw) | Medium | Medium |
| Error | 4.2 | Panic in `CommandExecutor::execute` kills task | Medium | Low |
| Frontend | 5.1 | `chat.js` monolith (800+ lines, no separation) | Medium | Medium |
| Frontend | 5.2 | Store not persisted; no offline/cold-start story | Low | Medium |
| Frontend | 5.3 | Event subscription race window on startup | Low | Low |
| Frontend | 5.4 | `ChatMessage` defined in both Rust and TypeScript | Medium | Medium |
| Extensibility | 6.1 | New `WsRequest` variant requires 3-file edits | Low | Medium |
| Extensibility | 6.3 | No plugin system; hard extension points | Low | High |
| Extensibility | 6.4 | Mobile lacks platform abstraction for WS, consent, file | Medium | High |
| Tech Debt | 7.1 | Hardcoded 5s polling loop for WebView readiness | Low | Low |
| Tech Debt | 7.2 | Hardcoded `160px` composer height | Trivial | Trivial |
| Tech Debt | 7.3 | `ConnectionStatus` compared as strings across language boundary | Low | Medium |
| Future | 8.1 | Streaming `persist_and_emit` not wired | Medium | Medium |
| Future | 8.2 | Large file transport via WS base64 needs HTTP alternative | Low | Medium |
| Future | 8.3 | Mobile platform abstraction layer needed | Medium | High |
| Future | 8.4 | Local mode: Docker support + engine API versioning | Low | High |
| Future | 8.5 | No test infrastructure for `WsClient` or `AppState` | Medium | Medium |

**Top 5 by priority:**
1. **Wire `persist_and_emit` for `ChatReply`/`ChatEvent`** (functional gap — streaming doesn't work)
2. **Fix stale-sender risk in `ws_outgoing`** (reliability)
3. **Extract `lib.rs` startup into separate modules** (maintainability, required for any further development)
4. **Document the `ChatMessage` field mapping between Rust and TypeScript** (correctness, prevent silent bugs)
5. **Add panic guard around `CommandExecutor::execute`** (reliability — a crashing shell command should not kill the command-handling task)
