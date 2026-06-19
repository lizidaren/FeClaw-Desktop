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

use crate::consent::{ConsentManager, Decision};
use crate::executor::CommandExecutor;
use crate::ws_types::{
    CommandExecPayload, ConnectionStatus, FileReadPayload, FileWritePayload,
    NotificationPayload, WsRequest,
};
use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::async_runtime;
use tauri::async_runtime::mpsc;
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::{
    client::generate_key,
    http::Request,
    Message,
};
use tokio_tungstenite::{client_async, MaybeTlsStream, WebSocketStream};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const MAX_RECONNECT_ATTEMPTS: u32 = 30;
const RECONNECT_DELAY: Duration = Duration::from_secs(1);

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Cheap-to-clone WS client. `run()` consumes self and runs forever.
pub struct WsClient {
    url: String,
    token: String,
    outgoing_tx: mpsc::UnboundedSender<String>,
    outgoing_rx: Option<mpsc::UnboundedReceiver<String>>,
    status_tx: mpsc::Sender<ConnectionStatus>,
    consent: Arc<Mutex<ConsentManager>>,
    executor: Arc<CommandExecutor>,
}

impl WsClient {
    pub fn new(
        url: String,
        token: String,
        status_tx: mpsc::Sender<ConnectionStatus>,
        consent: Arc<Mutex<ConsentManager>>,
        executor: Arc<CommandExecutor>,
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
        }
    }

    pub fn sender(&self) -> mpsc::UnboundedSender<String> {
        self.outgoing_tx.clone()
    }

    async fn set_status(&self, s: ConnectionStatus) {
        let _ = self.status_tx.send(s).await;
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

    async fn run_inner(&mut self) -> Result<()> {
        let mut outgoing_rx = self
            .outgoing_rx
            .take()
            .ok_or_else(|| anyhow!("ws inner loop started without outgoing_rx"))?;

        let host = self
            .url
            .strip_prefix("ws://")
            .or_else(|| self.url.strip_prefix("wss://"))
            .unwrap_or(&self.url);
        let req = Request::builder()
            .method("GET")
            .uri(&self.url)
            .header("Host", host)
            .header("Upgrade", "websocket")
            .header("Connection", "Upgrade")
            .header("Sec-WebSocket-Key", generate_key())
            .header("Sec-WebSocket-Version", "13")
            .header("Authorization", format!("Bearer {}", self.token))
            .body(())
            .map_err(|e| anyhow!("build ws request: {e}"))?;

        let (mut ws, _resp) = client_async(req, None)
            .await
            .map_err(|e| anyhow!("ws connect: {e}"))?;
        self.set_status(ConnectionStatus::Connected).await;
        tracing::info!("ws connected to {}", self.url);

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
                    if matches!(msg, Message::Close(_)) {
                        return Ok(());
                    }
                    if let Err(e) = self.handle_message(msg).await {
                        tracing::error!("ws handle_message: {e:#}");
                    }
                }
            }
        }
    }

    async fn handle_message(&self, msg: Message) -> Result<()> {
        let text = match msg {
            Message::Text(t) => t,
            Message::Binary(b) => String::from_utf8(b)?,
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => return Ok(()),
            Message::Close(_) => return Ok(()),
        };
        let req: WsRequest = serde_json::from_str(&text)
            .map_err(|e| anyhow!("parse ws message: {e}; payload={text}"))?;
        match req {
            WsRequest::CommandExec { id, payload } => {
                self.spawn_command_exec(id, payload).await;
            }
            WsRequest::FileRead { id, payload } => {
                self.handle_file_read_not_implemented(id, payload);
            }
            WsRequest::FileWrite { id, payload } => {
                self.handle_file_write_not_implemented(id, payload);
            }
            WsRequest::Notification { payload, .. } => {
                tracing::info!(
                    "notification from engine: title={:?}, body={}",
                    payload.title,
                    payload.body
                );
            }
            WsRequest::Pong => {}
        }
        Ok(())
    }

    fn handle_file_read_not_implemented(&self, id: String, payload: FileReadPayload) {
        tracing::info!(
            "file_read_request received but file bridge is V2 (id={id}, path={})",
            payload.path
        );
        self.send_json(&serde_json::json!({
            "type": "file_read_response",
            "id": id,
            "status": "error",
            "payload": { "error": "file bridge not implemented in MVP" },
        }));
    }

    fn handle_file_write_not_implemented(&self, id: String, payload: FileWritePayload) {
        tracing::info!(
            "file_write_request received but file bridge is V2 (id={id}, path={})",
            payload.path
        );
        self.send_json(&serde_json::json!({
            "type": "file_write_response",
            "id": id,
            "status": "error",
            "payload": { "error": "file bridge not implemented in MVP" },
        }));
    }

    fn send_json(&self, value: &serde_json::Value) {
        match serde_json::to_string(value) {
            Ok(s) => {
                let _ = self.outgoing_tx.send(s);
            }
            Err(e) => tracing::error!("ws serialize response: {e}"),
        }
    }

    async fn spawn_command_exec(&self, id: String, payload: CommandExecPayload) {
        let consent = self.consent.clone();
        let executor = self.executor.clone();
        let outgoing_tx = self.outgoing_tx.clone();
        async_runtime::spawn(async move {
            let cmd_str = if payload.args.is_empty() {
                payload.command.clone()
            } else {
                format!("{} {}", payload.command, payload.args.join(" "))
            };
            tracing::info!("command_exec_request id={id} cmd={cmd_str}");

            let decision = {
                let mut guard = consent.lock().await;
                guard.request(&cmd_str).await
            };

            let cwd = PathBuf::from(payload.cwd.as_deref().unwrap_or("."));
            match decision {
                Decision::Allow | Decision::AlwaysAllow => {
                    let result = executor
                        .execute(&payload.command, &payload.args, &cwd, payload.timeout)
                        .await;
                    let response = serde_json::json!({
                        "type": "command_exec_response",
                        "id": id,
                        "status": "accepted",
                        "payload": {
                            "stdout": result.stdout,
                            "stderr": result.stderr,
                            "exit_code": result.exit_code,
                        }
                    });
                    if let Ok(s) = serde_json::to_string(&response) {
                        let _ = outgoing_tx.send(s);
                    }
                }
                Decision::Deny => {
                    tracing::info!("user denied command: {cmd_str}");
                    let response = serde_json::json!({
                        "type": "command_exec_response",
                        "id": id,
                        "status": "rejected",
                        "payload": { "reason": "denied by user" }
                    });
                    if let Ok(s) = serde_json::to_string(&response) {
                        let _ = outgoing_tx.send(s);
                    }
                }
            }
        });
    }
}
