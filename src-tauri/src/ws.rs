//! WebSocket client — PR 4: full message dispatch.
//!
//! Connects to `/ws/desktop`, heartbeats every 30 s, reconnects up to
//! 30 times spaced 1 s apart, and dispatches inbound messages:
//!   * `command_exec_request` → asks `ConsentManager`, runs the
//!     command via `CommandExecutor`, sends the
//!     `command_exec_response` back.
//!   * `file_read_request` / `file_write_request` → V2 file bridge
//!     (currently answered with `status: "error"`).
//!   * `notification` → logged; V2 will pop a native toast.
//!
//! Outgoing traffic flows through an unbounded mpsc so any spawned
//! task can ship a response without holding the WebSocket stream.


use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use crate::chat::{ChatMessage, persist_and_emit};
use crate::consent::{ConsentManager, Decision, Operation, OperationOutcome};
use crate::executor::CommandExecutor;
use crate::file_bridge;
use crate::ws_types::WsRequest;
use crate::ws_types::{
    CommandExecPayload, CommandExecPayloadOut, CommandExecResponse, ConnectionStatus,
    ConsentDecision, ConsentResponse, FileDeletePayload, FileDeleteResponse,
    FileDeleteResponsePayload, FileReadPayload, FileReadResponse, FileReadResponsePayload,
    FileWritePayload, FileWriteResponse, FileWriteResponsePayload, NotificationPayload,
};
use tauri::Emitter;

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::async_runtime;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const PONG_TIMEOUT: Duration = Duration::from_secs(35);
const MAX_RECONNECT_ATTEMPTS: u32 = 30;
const RECONNECT_DELAY: Duration = Duration::from_secs(1);

/// Maximum file size for an inbound `file_read_request` / `file_write_request`
/// over the WS bridge. Matches the cap used by `file_ops::MAX_FILE_BYTES` so
/// a single message can't blow up memory or a websocket frame. Requests
/// larger than this are rejected with an error envelope rather than
/// silently truncated.
const MAX_BRIDGE_BYTES: u64 = 1024 * 1024;

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Cheap-to-clone WS client. `run()` consumes self and runs forever.
pub struct WsClient {
    url: String,
    token: String,
    outgoing_tx: mpsc::UnboundedSender<String>,
    outgoing_rx: Option<mpsc::UnboundedReceiver<String>>,
    status_tx: mpsc::Sender<ConnectionStatus>,
    consent: Arc<tokio::sync::Mutex<ConsentManager>>,
    executor: Arc<CommandExecutor>,
    /// Instant of the last received Pong. Updated on Pong message and
    /// initialised to Instant::now() when the connection is established.
    last_pong_at: std::sync::Mutex<Option<Instant>>,
    /// Close code received from the server (if the connection ended via a
    /// Close frame). Set by `run_loop`; read by callers via
    /// [`WsClient::last_close_code`] to differentiate a normal shutdown
    /// from an app-level 4xxx error (e.g. 4001 invalid token → reauth).
    last_close_code: std::sync::Mutex<Option<u16>>,
    /// Cancel token: when set to true by the control pump, the run loop
    /// exits gracefully to trigger a reconnect.
    cancel_token: Arc<AtomicBool>,
    /// Optional AppHandle for emitting Tauri events to the frontend.
    app_handle: Option<tauri::AppHandle>,
}

impl WsClient {
    pub fn new(
        url: String,
        token: String,
        status_tx: mpsc::Sender<ConnectionStatus>,
        consent: Arc<tokio::sync::Mutex<ConsentManager>>,
        executor: Arc<CommandExecutor>,
        cancel_token: Arc<AtomicBool>,
        app_handle: Option<tauri::AppHandle>,
    ) -> Self {
        let (outgoing_tx, outgoing_rx) = mpsc::unbounded_channel();
        Self {
            url,
            token,
            outgoing_tx,
            outgoing_rx: Some(outgoing_rx),
            status_tx,
            consent,
            executor,
            last_pong_at: std::sync::Mutex::new(None),
            last_close_code: std::sync::Mutex::new(None),
            cancel_token,
            app_handle,
        }
    }

    pub fn sender(&self) -> mpsc::UnboundedSender<String> {
        self.outgoing_tx.clone()
    }

    /// Most recent server-side close code (if the connection ended via a
    /// `Close` frame). `None` means the connection is still active or
    /// ended without a close frame (e.g. TCP reset).
    ///
    /// Cloud mode uses this to detect 4001 (invalid token) and 4002
    /// (forbidden) — both signal that the JWT is no longer good and
    /// needs to be re-acquired via the login flow.
    pub fn last_close_code(&self) -> Option<u16> {
        *self.last_close_code.lock().unwrap()
    }

    async fn set_status(&self, s: ConnectionStatus) {
        let _ = self.status_tx.send(s).await;
    }

    /// Public helper: establish a (possibly TLS) WebSocket connection and
    /// return the live stream. The JWT is sent via the standard
    /// `Authorization: Bearer …` header during the upgrade so the server
    /// can authenticate the handshake (matches `desktop_ws.py` on the
    /// FeClaw side, which reads JWT from headers / cookies / first frame).
    ///
    /// The scheme is auto-detected: `ws://` → plain TCP, `wss://` → rustls
    /// with WebPKI roots (the `rustls-tls-webpki-roots` feature on
    /// `tokio-tungstenite` is enabled in `Cargo.toml`).
    ///
    /// Used by `EngineManager::start_cloud` for the cloud endpoint; the
    /// local path uses the same constructor via `run_inner`.
    pub async fn connect_tls(url: &str, token: &str) -> Result<WsStream> {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        // Append the JWT as a query parameter — the server reads
        // `?token=xxx` on the WS upgrade endpoint.
        let url_with_token = if token.is_empty() {
            url.to_string()
        } else {
            let sep = if url.contains('?') { "&" } else { "?" };
            format!("{url}{sep}token={token}")
        };

        // Extract host:port for TCP connection (strip scheme + path).
        let host_port = url_with_token
            .strip_prefix("wss://")
            .or_else(|| url_with_token.strip_prefix("ws://"))
            .unwrap_or(&url_with_token)
            .split('/')
            .next()
            .unwrap_or("")
            .split('?')
            .next()
            .unwrap_or("")
            .to_string();

        // Build the upgrade request with the token-bearing URL.
        let req = url_with_token
            .into_client_request()
            .map_err(|e| anyhow!("build ws request: {e}"))?;

        // Establish the TCP connection first so the stream type is concrete
        // when handed to `client_async_tls` (passing `None` triggers a type
        // inference failure in tungstenite 0.24). `client_async_tls` returns
        // `MaybeTlsStream<TcpStream>` — exactly the type the `WsStream` alias
        // expects — and upgrades to TLS automatically when the URL is `wss://`.
        let tcp = TcpStream::connect(host_port.clone())
            .await
            .map_err(|e| anyhow!("ws tcp connect to {host_port}: {e}"))?;
        let (ws, _resp) = tokio_tungstenite::client_async_tls(req, tcp)
            .await
            .map_err(|e| anyhow!("ws connect: {e}"))?;
        Ok(ws)
    }

    /// Outer reconnect loop. Runs forever (or until max attempts fail).
    pub async fn run(mut self) {
        for attempt in 1..=MAX_RECONNECT_ATTEMPTS {
            if attempt == 1 {
                self.set_status(ConnectionStatus::Connecting).await;
            } else {
                self.set_status(ConnectionStatus::Reconnecting).await;
                tracing::info!("ws reconnect attempt {attempt}/{MAX_RECONNECT_ATTEMPTS}");
                tokio::time::sleep(RECONNECT_DELAY).await;
            }

            match self.run_inner().await {
                Ok(()) => {
                    tracing::warn!("ws disconnected gracefully");
                    self.set_status(ConnectionStatus::Disconnected).await;
                }
                Err(e) => {
                    tracing::warn!("ws loop error: {e:#}");
                    self.set_status(ConnectionStatus::Disconnected).await;
                }
            }
        }
        self.set_status(ConnectionStatus::Failed).await;
        tracing::error!(
            "ws exhausted {MAX_RECONNECT_ATTEMPTS} reconnect attempts; \
             user must click reconnect"
        );
    }

    /// Single connect + run cycle. Unlike [`run`], this returns after the
    /// first disconnection so the caller can implement its own retry
    /// policy (e.g. cloud mode wants a 5-second delay between attempts and
    /// needs to inspect [`last_close_code`] to detect auth failures).
    ///
    /// Returns `Ok(())` for any clean termination (close frame received,
    /// cancel token flipped, or the peer hung up) and `Err(_)` for
    /// transport-level errors (TLS failure, DNS, timeout, …).
    /// Connect, run, disconnect, then return the server-side close code
    /// (if any) together with the I/O result.  Callers that need to
    /// inspect `last_close_code` **after** the connection ends (e.g. to
    /// distinguish an auth failure from a clean shutdown) should use this
    /// method instead of `run` + `last_close_code` because `run_once`
    /// consumes `self`.
    pub async fn run_once(mut self) -> (Option<u16>, Result<()>) {
        self.set_status(ConnectionStatus::Connecting).await;
        let r = self.run_inner().await;
        self.set_status(ConnectionStatus::Disconnected).await;
        let close_code = self.last_close_code();
        (close_code, r)
    }

    async fn run_inner(&mut self) -> Result<()> {
        // IMPORTANT: 先连接再 take receiver。如果 connect_tls 失败返回 Err，
        // receiver 不会被丢掉，后续重试还能用——否则 ws_outgoing 发送端永久死亡。
        let mut ws = Self::connect_tls(&self.url, &self.token).await?;
        let mut outgoing_rx = self
            .outgoing_rx
            .take()
            .ok_or_else(|| anyhow!("ws inner loop started without outgoing_rx"))?;
        self.set_status(ConnectionStatus::Connected).await;
        tracing::info!("ws connected to {}", self.url);
        *self.last_pong_at.lock().unwrap() = Some(Instant::now());

        let result = self.run_loop(&mut ws, &mut outgoing_rx).await;

        self.outgoing_rx = Some(outgoing_rx);
        result
    }

    async fn run_loop(
        &self,
        ws: &mut WsStream,
        outgoing_rx: &mut mpsc::UnboundedReceiver<String>,
    ) -> Result<()> {
        let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        heartbeat.tick().await;

        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    if let Err(e) = ws.send(Message::Ping(Vec::new())).await {
                        return Err(anyhow!("ws ping send: {e}"));
                    }
                    // Check pong timeout: if no pong received for > 35s, close connection.
                    let stale = self.last_pong_at.lock().unwrap()
                        .map(|last| last.elapsed() > PONG_TIMEOUT)
                        .unwrap_or(false);
                    if stale {
                        tracing::warn!(
                            "pong timeout ({:?} since last pong), closing connection",
                            self.last_pong_at.lock().unwrap().unwrap().elapsed()
                        );
                        let _ = ws.close(None).await;
                        return Ok(());
                    }
                }
                out = outgoing_rx.recv() => {
                    match out {
                        Some(json) => {
                            if let Err(e) = ws.send(Message::Text(json)).await {
                                return Err(anyhow!("ws send: {e}"));
                            }
                        }
                        None => return Ok(()),
                    }
                }
                msg = ws.next() => {
                    let Some(msg) = msg else { return Ok(()); };
                    let msg = msg.map_err(|e| anyhow!("ws recv: {e}"))?;
                    // [V3-5/N-4] Extract close code so we can distinguish a normal
                    // shutdown from an app-level 4xxx error sent by the engine
                    // (4001 invalid token, 4003 forbidden, 4004 agent not found).
                    if let Message::Close(frame) = &msg {
                        if let Some(frame) = frame {
                            let code: u16 = frame.code.into();
                            // Stash for callers (`last_close_code` reader) so
                            // the cloud reconnect loop can detect 4001/4002
                            // and trigger a fresh login.
                            *self.last_close_code.lock().unwrap() = Some(code);
                            if (4000..5000).contains(&code) {
                                tracing::error!(
                                    "ws closed by server with app-level code {code}: {:?}",
                                    frame.reason
                                );
                            } else {
                                tracing::info!(
                                    "ws closed by server (code={code}): {:?}",
                                    frame.reason
                                );
                            }
                        } else {
                            tracing::info!("ws closed by server (no close frame)");
                        }
                        return Ok(());
                    }
                    if let Err(e) = self.handle_message(msg).await {
                        tracing::error!("ws handle_message: {e:#}");
                    }
                }
            }
            // Check if a reconnect was requested by the control pump.
            if self.cancel_token.load(Ordering::SeqCst) {
                tracing::info!("cancel_token set; closing connection to trigger reconnect");
                let _ = ws.close(None).await;
                self.cancel_token.store(false, Ordering::SeqCst);
                return Ok(());
            }
        }
    }

    async fn handle_message(&self, msg: Message) -> Result<()> {
        let text = match msg {
            Message::Text(t) => t,
            Message::Binary(b) => String::from_utf8(b)?,
            Message::Ping(_) => return Ok(()),
            Message::Pong(_) => {
                *self.last_pong_at.lock().unwrap() = Some(Instant::now());
                return Ok(());
            }
            Message::Frame(_) => return Ok(()),
            Message::Close(_) => return Ok(()),
        };
        let req: WsRequest = serde_json::from_str(&text)
            .map_err(|e| anyhow!("parse ws message: {e}; payload={text}"))?;
        match req {
            WsRequest::CommandExec { id, timestamp: _, payload } => {
                self.spawn_command_exec(id, payload).await;
            }
            WsRequest::FileRead { id, timestamp: _, payload } => {
                self.handle_file_read(id, payload).await;
            }
            WsRequest::FileWrite { id, timestamp: _, payload } => {
                self.handle_file_write(id, payload).await;
            }
            WsRequest::FileDelete { id, timestamp: _, payload } => {
                self.handle_file_delete(id, payload).await;
            }
            WsRequest::Notification { payload, .. } => {
                self.show_native_notification(&payload);
            }
            WsRequest::ChatReply { id, text, agent, timestamp } => {
                tracing::info!(
                    agent = agent.as_deref(),
                    id = id.as_str(),
                    "chat_reply received (length={})",
                    text.len()
                );
                let msg = ChatMessage {
                    id: id.clone(),
                    role: "assistant".to_string(),
                    content: text.clone(),
                    timestamp: timestamp.clone(),
                    agent: agent.clone(),
                };
                if let Some(ref handle) = self.app_handle {
                    let _ = persist_and_emit(handle, msg.clone()).await;
                    let _ = handle.emit("chat-reply", &serde_json::json!({
                        "id": id,
                        "text": text,
                        "agent": agent,
                        "timestamp": timestamp,
                    }));
                }
            }
            WsRequest::ChatEvent { id, kind, data, timestamp: _ } => {
                tracing::debug!(id = id.as_str(), kind = kind.as_str(), "chat_event received");
                if let Some(ref handle) = self.app_handle {
                    if kind == "token" {
                        let delta = data.as_ref().and_then(|d| d.get("delta")).and_then(|v| v.as_str()).map(|s| s.to_string());
                        let _ = handle.emit("chat-event", &serde_json::json!({
                            "id": id,
                            "kind": kind,
                            "delta": delta,
                        }));
                    } else if kind == "done" {
                        let session_id = data.as_ref().and_then(|d| d.get("session_id")).and_then(|v| v.as_str()).map(|s| s.to_string());
                        let _ = handle.emit("chat-done", &serde_json::json!({
                            "id": id,
                            "kind": kind,
                            "session_id": session_id,
                        }));
                    } else if kind == "thinking" || kind == "reasoning" || kind == "tool" || kind == "tool_result" {
                        let _ = handle.emit("chat-stream", &serde_json::json!({
                            "id": id,
                            "kind": kind,
                            "data": data,
                        }));
                    }
                }
            }
            WsRequest::FileOperationRequest { op_id, operation, path, level: _level, reason, timestamp: _timestamp } => {
                // Inline consent channel: the engine is asking the desktop
                // to surface a confirm dialog for a *future* file operation.
                // The actual I/O will arrive later as a separate
                // `file_read_request` / `file_write_request` /
                // `file_delete_request` and is gated on its own. Here we
                // show the preview dialog and report the decision back
                // over the WS as a `consent_response` envelope.
                //
                // We spawn the dialog so a slow / absent user doesn't
                // stall the WS read loop (the 30s heartbeat would fire
                // and drop the connection).
                let consent = self.consent.clone();
                let outgoing_tx = self.outgoing_tx.clone();
                let op_id_for_task = op_id.clone();
                let operation_for_task = operation.clone();
                let path_for_task = path.clone();
                let reason_for_task = reason.clone();
                async_runtime::spawn(async move {
                    // Map the wire-format operation string to the typed
                    // `Operation` enum. Unknown verbs are conservatively
                    // treated as L3 — better to pop a confirmation dialog
                    // for a typo'd "delte" than to silently allow.
                    let op = match operation_for_task.as_str() {
                        "read" => Operation::L1,
                        "write" => Operation::L2,
                        "delete" => Operation::L3,
                        _ => Operation::L3,
                    };
                    let outcome = {
                        let mut guard = consent.lock().await;
                        guard.request_operation(op, &path_for_task).await
                    };
                    let (decision_out, reason_out) = match outcome {
                        OperationOutcome::Allow => (ConsentDecision::Allow, None),
                        OperationOutcome::Timeout => (
                            ConsentDecision::Deny,
                            Some("consent dialog timed out".to_string()),
                        ),
                        OperationOutcome::Denied => (
                            ConsentDecision::Deny,
                            Some(
                                reason_for_task
                                    .unwrap_or_else(|| "denied by user".to_string()),
                            ),
                        ),
                    };
                    tracing::info!(
                        op_id = op_id_for_task.as_str(),
                        operation = operation_for_task.as_str(),
                        path = path_for_task.as_str(),
                        ?decision_out,
                        "file_operation_request consent decision"
                    );
                    let resp = ConsentResponse {
                        id: op_id_for_task.clone(),
                        decision: decision_out,
                        reason: reason_out,
                    };
                    let mut value = serde_json::to_value(&resp).unwrap_or_else(|_| {
                        serde_json::json!({
                            "id": op_id_for_task,
                            "decision": "deny",
                            "reason": "serialize failed",
                        })
                    });
                    if let Some(obj) = value.as_object_mut() {
                        obj.insert(
                            "type".to_string(),
                            serde_json::Value::String("consent_response".to_string()),
                        );
                    }
                    if let Ok(s) = serde_json::to_string(&value) {
                        let _ = outgoing_tx.send(s);
                    }
                });
            }
            WsRequest::GroupMessage { group_id, message } => {
                tracing::info!(
                    group_id = group_id.as_str(),
                    message_id = message.id.as_str(),
                    "group_message received"
                );
                if let Some(ref handle) = self.app_handle {
                    let payload = serde_json::json!({
                        "group_id": group_id,
                        "message": message,
                    });
                    let _ = handle.emit("group-message", payload);
                }
            }
            WsRequest::GroupEvent { group_id, event, data } => {
                tracing::info!(
                    group_id = group_id.as_str(),
                    event = event.as_str(),
                    "group_event received"
                );
                if let Some(ref handle) = self.app_handle {
                    let payload = serde_json::json!({
                        "group_id": group_id,
                        "event": event,
                        "data": data,
                    });
                    let _ = handle.emit("group-event", payload);
                }
            }
            WsRequest::GroupUpdated { group_id, data } => {
                tracing::info!(
                    group_id = group_id.as_str(),
                    "group_updated received"
                );
                if let Some(ref handle) = self.app_handle {
                    let payload = serde_json::json!({
                        "group_id": group_id,
                        "data": data,
                    });
                    let _ = handle.emit("group-updated", payload);
                }
            }
            WsRequest::MomentsEvent { group_id, data } => {
                tracing::info!(
                    group_id = group_id.as_str(),
                    "moments_event received"
                );
                if let Some(ref handle) = self.app_handle {
                    let payload = serde_json::json!({
                        "group_id": group_id,
                        "data": data,
                    });
                    let _ = handle.emit("moments-event", payload);
                }
            }
            WsRequest::UploadComplete { session_id, presigned_get_url, file_name, mime_type } => {
                tracing::info!(
                    session_id = session_id.as_str(),
                    "upload_complete received"
                );
                if let Some(ref handle) = self.app_handle {
                    let payload = serde_json::json!({
                        "session_id": session_id,
                        "presigned_get_url": presigned_get_url,
                        "file_name": file_name,
                        "mime_type": mime_type,
                    });
                    let _ = handle.emit("upload-complete", payload);
                }
            }
            WsRequest::Pong => {}
            WsRequest::ChatAck { id } => {
                tracing::debug!(id = id.as_str(), "chat_ack received");
                if let Some(ref handle) = self.app_handle {
                    let _ = handle.emit("chat-ack", &serde_json::json!({ "id": id }));
                }
            }
        }
        Ok(())
    }

    async fn handle_file_read(&self, id: String, payload: FileReadPayload) {
        tracing::info!(
            "file_read_request id={id} path={}",
            payload.path
        );
        let ts = crate::ws_types::current_timestamp();

        // Consent gate (L1: silent read). `request_operation` short-circuits
        // to `Allow` for reads today, but going through the same code path
        // means any future policy change (audit, allow-list, etc.) applies
        // uniformly to file ops.
        {
            let mut guard = self.consent.lock().await;
            let outcome = guard.request_operation(Operation::L1, &payload.path).await;
            if !outcome.is_allowed() {
                let reason = match outcome {
                    OperationOutcome::Denied => "denied by user",
                    OperationOutcome::Timeout => "consent dialog timed out",
                    OperationOutcome::Allow => "allowed",
                };
                tracing::info!("file_read denied (id={id}): {reason}");
                let resp = FileReadResponse {
                    id,
                    status: "error".to_string(),
                    timestamp: Some(ts),
                    payload: FileReadResponsePayload {
                        content: None,
                        error: Some(format!("file read not permitted: {reason}")),
                    },
                };
                return self.send_file_response(&resp, "file_read_response");
            }
        }

        // Resolve the VFS path → local path. The bridge enforces the
        // `/mnt/desktop/` prefix and blocks `..` traversal, so any escape
        // attempt shows up here as an Err.
        let resolved = match file_bridge::resolve_desktop_path(&payload.path) {
            Ok(p) => p,
            Err(e) => {
                let resp = FileReadResponse {
                    id,
                    status: "error".to_string(),
                    timestamp: Some(ts),
                    payload: FileReadResponsePayload {
                        content: None,
                        error: Some(format!("invalid path: {e}")),
                    },
                };
                return self.send_file_response(&resp, "file_read_response");
            }
        };

        // Enforce the size cap synchronously via `metadata` so we don't
        // allocate the full file just to reject it.
        let size = match std::fs::metadata(&resolved) {
            Ok(m) => m.len(),
            Err(e) => {
                let resp = FileReadResponse {
                    id,
                    status: "error".to_string(),
                    timestamp: Some(crate::ws_types::current_timestamp()),
                    payload: FileReadResponsePayload {
                        content: None,
                        error: Some(format!("stat {}: {e}", resolved.display())),
                    },
                };
                return self.send_file_response(&resp, "file_read_response");
            }
        };
        if size > MAX_BRIDGE_BYTES {
            let resp = FileReadResponse {
                id,
                status: "error".to_string(),
                timestamp: Some(crate::ws_types::current_timestamp()),
                payload: FileReadResponsePayload {
                    content: None,
                    error: Some(format!(
                        "file too large: {size} bytes (max {MAX_BRIDGE_BYTES}); consider streaming"
                    )),
                },
            };
            return self.send_file_response(&resp, "file_read_response");
        }

        // Read + base64-encode. Done in a blocking task because file I/O
        // can stall on slow disks / antivirus scans.
        let path_for_err = resolved.clone();
        let result = async_runtime::spawn_blocking(move || -> Result<(String, u64)> {
            let bytes = std::fs::read(&resolved)
                .map_err(|e| anyhow!("read {}: {e}", resolved.display()))?;
            let len = bytes.len() as u64;
            let encoded = BASE64.encode(&bytes);
            Ok((encoded, len))
        })
        .await;

        let resp = match result {
            Ok(Ok((encoded, _len))) => FileReadResponse {
                id,
                status: "ok".to_string(),
                timestamp: Some(crate::ws_types::current_timestamp()),
                payload: FileReadResponsePayload {
                    content: Some(encoded),
                    error: None,
                },
            },
            Ok(Err(e)) => FileReadResponse {
                id,
                status: "error".to_string(),
                timestamp: Some(crate::ws_types::current_timestamp()),
                payload: FileReadResponsePayload {
                    content: None,
                    error: Some(format!("{e}")),
                },
            },
            Err(e) => FileReadResponse {
                id,
                status: "error".to_string(),
                timestamp: Some(crate::ws_types::current_timestamp()),
                payload: FileReadResponsePayload {
                    content: None,
                    error: Some(format!("read task panicked: {e} (path={})", path_for_err.display())),
                },
            },
        };
        self.send_file_response(&resp, "file_read_response");
    }

    async fn handle_file_write(&self, id: String, payload: FileWritePayload) {
        tracing::info!(
            "file_write_request id={id} path={} content_len={}",
            payload.path,
            payload.content.len()
        );
        let ts = crate::ws_types::current_timestamp();

        // Consent gate (L2: write — info dialog, Yes/No). Pops a native
        // dialog so the user can deny the operation before any bytes hit
        // disk. Mirrors the `request()` flow used by `spawn_command_exec`.
        {
            let mut guard = self.consent.lock().await;
            let outcome = guard.request_operation(Operation::L2, &payload.path).await;
            if !outcome.is_allowed() {
                let reason = match outcome {
                    OperationOutcome::Denied => "denied by user",
                    OperationOutcome::Timeout => "consent dialog timed out",
                    OperationOutcome::Allow => "allowed",
                };
                tracing::info!("file_write denied (id={id}): {reason}");
                let resp = FileWriteResponse {
                    id,
                    status: "error".to_string(),
                    timestamp: Some(ts),
                    payload: FileWriteResponsePayload {
                        success: false,
                        error: Some(format!("file write not permitted: {reason}")),
                        content_length: None,
                        hash: None,
                    },
                };
                return self.send_file_response(&resp, "file_write_response");
            }
        }

        // Resolve the VFS path → local path.
        let resolved = match file_bridge::resolve_desktop_path(&payload.path) {
            Ok(p) => p,
            Err(e) => {
                let resp = FileWriteResponse {
                    id,
                    status: "error".to_string(),
                    timestamp: Some(ts),
                    payload: FileWriteResponsePayload {
                        success: false,
                        error: Some(format!("invalid path: {e}")),
                        content_length: None,
                        hash: None,
                    },
                };
                return self.send_file_response(&resp, "file_write_response");
            }
        };

        // Decode the base64 payload first so the size check is on the
        // actual bytes written, not the encoded string length.
        let decoded = match BASE64.decode(payload.content.as_bytes()) {
            Ok(b) => b,
            Err(e) => {
                let resp = FileWriteResponse {
                    id,
                    status: "error".to_string(),
                    timestamp: Some(crate::ws_types::current_timestamp()),
                    payload: FileWriteResponsePayload {
                        success: false,
                        error: Some(format!("base64 decode failed: {e}")),
                        content_length: None,
                        hash: None,
                    },
                };
                return self.send_file_response(&resp, "file_write_response");
            }
        };

        if decoded.len() as u64 > MAX_BRIDGE_BYTES {
            let resp = FileWriteResponse {
                id,
                status: "error".to_string(),
                timestamp: Some(crate::ws_types::current_timestamp()),
                payload: FileWriteResponsePayload {
                    success: false,
                    error: Some(format!(
                        "file too large: {} bytes (max {MAX_BRIDGE_BYTES})",
                        decoded.len()
                    )),
                    content_length: None,
                    hash: None,
                },
            };
            return self.send_file_response(&resp, "file_write_response");
        }

        // Write to disk in a blocking task. The path is dropped after the
        // closure so we clone first for the error path.
        let path_for_err = resolved.clone();
        let decoded_len = decoded.len() as u64;
        let result = async_runtime::spawn_blocking(move || -> Result<u64> {
            if let Some(parent) = resolved.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| anyhow!("mkdir {}: {e}", parent.display()))?;
            }
            std::fs::write(&resolved, &decoded)
                .map_err(|e| anyhow!("write {}: {e}", resolved.display()))?;
            Ok(decoded_len)
        })
        .await;

        let resp = match result {
            Ok(Ok(len)) => FileWriteResponse {
                id,
                status: "ok".to_string(),
                timestamp: Some(crate::ws_types::current_timestamp()),
                payload: FileWriteResponsePayload {
                    success: true,
                    error: None,
                    content_length: Some(len),
                    hash: None,
                },
            },
            Ok(Err(e)) => FileWriteResponse {
                id,
                status: "error".to_string(),
                timestamp: Some(crate::ws_types::current_timestamp()),
                payload: FileWriteResponsePayload {
                    success: false,
                    error: Some(format!("{e}")),
                    content_length: None,
                    hash: None,
                },
            },
            Err(e) => FileWriteResponse {
                id,
                status: "error".to_string(),
                timestamp: Some(crate::ws_types::current_timestamp()),
                payload: FileWriteResponsePayload {
                    success: false,
                    error: Some(format!("write task panicked: {e} (path={})", path_for_err.display())),
                    content_length: None,
                    hash: None,
                },
            },
        };
        self.send_file_response(&resp, "file_write_response");
    }

    async fn handle_file_delete(&self, id: String, payload: FileDeletePayload) {
        tracing::info!(
            "file_delete_request id={id} path={}",
            payload.path
        );
        let ts = crate::ws_types::current_timestamp();

        // Consent gate (L3: delete — warning dialog, Yes/No). The dialog
        // explicitly warns that the operation is permanent; we treat any
        // non-Allow outcome (Denied / Timeout) as a hard stop.
        {
            let mut guard = self.consent.lock().await;
            let outcome = guard.request_operation(Operation::L3, &payload.path).await;
            if !outcome.is_allowed() {
                let reason = match outcome {
                    OperationOutcome::Denied => "denied by user",
                    OperationOutcome::Timeout => "consent dialog timed out",
                    OperationOutcome::Allow => "allowed",
                };
                tracing::info!("file_delete denied (id={id}): {reason}");
                let resp = FileDeleteResponse {
                    id,
                    status: "error".to_string(),
                    timestamp: Some(ts),
                    payload: FileDeleteResponsePayload {
                        error: Some(format!("file delete not permitted: {reason}")),
                    },
                };
                return self.send_file_response(&resp, "file_delete_response");
            }
        }

        // Resolve the VFS path → local path. Re-uses the same sandboxing
        // rules as read/write (`/mnt/desktop/...`, no `..` traversal).
        let resolved = match file_bridge::resolve_desktop_path(&payload.path) {
            Ok(p) => p,
            Err(e) => {
                let resp = FileDeleteResponse {
                    id,
                    status: "error".to_string(),
                    timestamp: Some(ts),
                    payload: FileDeleteResponsePayload {
                        error: Some(format!("invalid path: {e}")),
                    },
                };
                return self.send_file_response(&resp, "file_delete_response");
            }
        };

        // Delete on a blocking task so a slow disk / AV scan can't stall
        // the WS run loop.
        let path_for_err = resolved.clone();
        let result = async_runtime::spawn_blocking(move || -> Result<()> {
            std::fs::remove_file(&resolved)
                .map_err(|e| anyhow!("delete {}: {e}", resolved.display()))
        })
        .await;

        let resp = match result {
            Ok(Ok(())) => FileDeleteResponse {
                id,
                status: "ok".to_string(),
                timestamp: Some(crate::ws_types::current_timestamp()),
                payload: FileDeleteResponsePayload { error: None },
            },
            Ok(Err(e)) => FileDeleteResponse {
                id,
                status: "error".to_string(),
                timestamp: Some(crate::ws_types::current_timestamp()),
                payload: FileDeleteResponsePayload {
                    error: Some(format!("{e}")),
                },
            },
            Err(e) => FileDeleteResponse {
                id,
                status: "error".to_string(),
                timestamp: Some(crate::ws_types::current_timestamp()),
                payload: FileDeleteResponsePayload {
                    error: Some(format!(
                        "delete task panicked: {e} (path={})",
                        path_for_err.display()
                    )),
                },
            },
        };
        self.send_file_response(&resp, "file_delete_response");
    }

    fn show_native_notification(&self, payload: &NotificationPayload) {
        tracing::info!(
            "notification from engine: title={:?}, body={}",
            payload.title,
            payload.body
        );
        // Show a native message dialog (non-blocking, no buttons—just an info toast).
        let title = payload.title.as_deref().unwrap_or("FeClaw Desktop");
        let body = &payload.body;
        let title_owned = title.to_string();
        let body_owned = body.to_string();
        std::thread::spawn(move || {
            let _ = rfd::MessageDialog::new()
                .set_title(&title_owned)
                .set_description(&body_owned)
                .set_buttons(rfd::MessageButtons::Ok)
                .set_level(rfd::MessageLevel::Info)
                .show();
        });
    }

    fn send_json(&self, value: &serde_json::Value) {
        match serde_json::to_string(value) {
            Ok(s) => {
                let _ = self.outgoing_tx.send(s);
            }
            Err(e) => tracing::error!("ws serialize response: {e}"),
        }
    }

    /// Serialize a typed file response, attach the `type` discriminator, and
    /// push it onto the outgoing WS channel. Centralised so the read/write
    /// branches stay symmetrical and the wire-format details live in one
    /// place.
    fn send_file_response<T>(&self, resp: &T, kind: &str)
    where
        T: Serialize,
    {
        let mut value = serde_json::to_value(resp).unwrap_or_else(|_| {
            serde_json::json!({ "id": "", "status": "error", "payload": {} })
        });
        if let Some(obj) = value.as_object_mut() {
            obj.insert(
                "type".to_string(),
                serde_json::Value::String(kind.to_string()),
            );
        }
        self.send_json(&value);
    }

    async fn spawn_command_exec(&self, id: String, payload: CommandExecPayload) {
        let consent = self.consent.clone();
        let executor = self.executor.clone();
        let outgoing_tx = self.outgoing_tx.clone();
        let cwd_from_payload = payload.cwd.clone();
        async_runtime::spawn(async move {
            let cmd_str = if payload.args.is_empty() {
                payload.command.clone()
            } else {
                format!("{} {}", payload.command, payload.args.join(" "))
            };
            tracing::info!("command_exec_request id={id} cmd={cmd_str}");

            let decision = {
                let mut guard = consent.lock().await;
                guard.request(&cmd_str, cwd_from_payload.as_deref()).await
            };

            let cwd = PathBuf::from(payload.cwd.as_deref().unwrap_or("."));
            match decision {
                Decision::Allow | Decision::AlwaysAllow => {
                    let result = executor
                        .execute(&payload.command, &payload.args, &cwd, payload.timeout)
                        .await;
                    let exit_code = result.exit_code;
                    let status = if exit_code == 124 {
                        "timeout"
                    } else {
                        "accepted"
                    };
                    let ts = crate::ws_types::current_timestamp();
                    let resp = CommandExecResponse {
                        id,
                        status: status.to_string(),
                        timestamp: Some(ts),
                        payload: CommandExecPayloadOut {
                            stdout: result.stdout,
                            stderr: result.stderr,
                            exit_code,
                            reason: None,
                        },
                    };
                    let mut value = serde_json::to_value(&resp).unwrap_or_else(|_| {
                        serde_json::json!({ "id": "", "status": "error", "payload": {} })
                    });
                    if let Some(obj) = value.as_object_mut() {
                        obj.insert("type".to_string(), serde_json::Value::String("command_exec_response".to_string()));
                    }
                    if let Ok(s) = serde_json::to_string(&value) {
                        let _ = outgoing_tx.send(s);
                    }
                }
                Decision::Deny => {
                    tracing::info!("user denied command: {cmd_str}");
                    let ts = crate::ws_types::current_timestamp();
                    let resp = CommandExecResponse {
                        id,
                        status: "rejected".to_string(),
                        timestamp: Some(ts),
                        payload: CommandExecPayloadOut {
                            stdout: String::new(),
                            stderr: String::new(),
                            exit_code: -1,
                            reason: Some("denied by user".to_string()),
                        },
                    };
                    let mut value = serde_json::to_value(&resp).unwrap_or_else(|_| {
                        serde_json::json!({ "id": "", "status": "rejected", "payload": {} })
                    });
                    if let Some(obj) = value.as_object_mut() {
                        obj.insert("type".to_string(), serde_json::Value::String("command_exec_response".to_string()));
                    }
                    if let Ok(s) = serde_json::to_string(&value) {
                        let _ = outgoing_tx.send(s);
                    }
                }
            }
        });
    }
}
