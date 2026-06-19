//! WebSocket client — PR 3: connection, heartbeat, reconnect.
//!
//! This iteration establishes and maintains a single WebSocket
//! connection to the engine's `/ws/desktop` endpoint. Outgoing
//! messages flow through an unbounded mpsc channel so future PRs
//! (consent + executor) can ship responses back without holding a
//! reference to the WebSocket stream. PR 4 adds the
//! `command_exec_request` dispatch and bridges it through the consent
//! manager and command executor.

use crate::ws_types::{WsRequest, ConnectionStatus};
use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tauri::async_runtime::mpsc;
use tokio::net::TcpStream;
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

/// Cheap-to-clone WS client. The inner `run` consumes self and runs
/// forever (or until `MAX_RECONNECT_ATTEMPTS` is exhausted).
pub struct WsClient {
    url: String,
    token: String,
    outgoing_tx: mpsc::UnboundedSender<String>,
    outgoing_rx: Option<mpsc::UnboundedReceiver<String>>,
    status_tx: mpsc::Sender<ConnectionStatus>,
}

impl WsClient {
    pub fn new(
        url: String,
        token: String,
        status_tx: mpsc::Sender<ConnectionStatus>,
    ) -> Self {
        let (outgoing_tx, outgoing_rx) = mpsc::unbounded_channel();
        Self {
            url,
            token,
            outgoing_tx,
            outgoing_rx: Some(outgoing_rx),
            status_tx,
        }
    }

    /// Public sender handle so other tasks (added in later PRs) can
    /// queue outgoing messages without owning the whole client.
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
        // Take the receiver so we own it for the duration of the connection.
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

        // Always put the receiver back so the next reconnect attempt can
        // drain any messages that were queued while we were disconnected.
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
        heartbeat.tick().await; // skip immediate

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
                        None => return Ok(()),  // all senders dropped
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
        // PR 3: just log. PR 4 dispatches command_exec_request via
        // ConsentManager + CommandExecutor.
        tracing::debug!("ws message: {req:?}");
        Ok(())
    }
}
