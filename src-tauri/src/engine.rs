//! Engine process management.
//!
//! Spawns the local `feclaw` engine as a child process, captures its
//! stdout/stderr into a shared buffer (so other modules can scan the
//! initial-password line), polls `/health` until the engine is ready,
//! and gracefully stops it on shutdown.
//!
//! In **cloud** mode the local engine is not started; instead, a
//! background task dials the configured `cloud_url`/JWT, runs the WS
//! loop, and reconnects with a 5-second delay after each disconnect.
//! Auth-failure close codes (4001/4002) clear the cached token and
//! trigger an interactive re-login via the Settings window.

use crate::config::{Config, Mode};
use crate::consent::ConsentManager;
use crate::executor::CommandExecutor;
use crate::ws::WsClient;
use crate::ws_types::ConnectionStatus;
use crate::ControlMsg;
use anyhow::{anyhow, Context, Result};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::async_runtime;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::sync::{Mutex as TokioMutex, RwLock};

/// Maximum time to wait for the engine to become healthy.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
/// Interval between health-check probes.
const HEALTH_INTERVAL: Duration = Duration::from_millis(500);

/// Reconnect delay for cloud mode after a clean disconnect / error.
const CLOUD_RECONNECT_DELAY: Duration = Duration::from_secs(5);
/// Brief backoff after a `ShowCloudLogin` request so we don't spam the
/// UI if the user is away.
const CLOUD_LOGIN_BACKOFF: Duration = Duration::from_secs(2);

/// Lifecycle states reported by [`EngineManager`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineStatus {
    Stopped,
    Starting,
    Running,
    Failed,
}

/// Manages the lifecycle of the local FeClaw engine process OR, in cloud
/// mode, the WebSocket connection to the remote engine.
pub struct EngineManager {
    config: Config,
    child: Option<Child>,
    status: EngineStatus,
    /// Shared buffer of captured engine stdout lines. Used by `auth.rs`
    /// to scan for the random initial admin password on first launch.
    stdout_buffer: Arc<StdMutex<Vec<String>>>,
    /// Reusable HTTP client for health checks. Created once in `start()`.
    client: Option<reqwest::Client>,
    /// Optional sender for `ControlMsg`. When set, engine state changes are
    /// pushed to the UI so the tray / status bar can reflect them in
    /// real time (e.g. emit `Reconnect` if the engine becomes unhealthy).
    ui_tx: Option<mpsc::UnboundedSender<ControlMsg>>,
    /// Cancel flag set by the control pump to signal `wait_exit` to give up.
    cancel_token: Arc<AtomicBool>,
    /// Optional handle to the WS client so the engine manager can ask the
    /// WS layer to drop its connection (e.g. on engine restart).
    ws: Option<Arc<WsClient>>,
}

impl EngineManager {
    /// Create a new manager bound to the given configuration.
    pub fn new(config: Config) -> Self {
        let cancel_token = Arc::new(std::sync::atomic::AtomicBool::new(false));
        Self {
            config,
            child: None,
            status: EngineStatus::Stopped,
            stdout_buffer: Arc::new(StdMutex::new(Vec::new())),
            client: None,
            ui_tx: None,
            cancel_token,
            ws: None,
        }
    }

    /// Inject the UI control channel after `AppState` has been built.
    /// Must be called once before the engine starts pushing state events.
    pub fn set_ui_tx(&mut self, tx: mpsc::UnboundedSender<ControlMsg>) {
        self.ui_tx = Some(tx);
    }

    /// Inject a shared cancel token used by the control pump to abort waits.
    pub fn set_cancel_token(&mut self, token: Arc<std::sync::atomic::AtomicBool>) {
        self.cancel_token = token;
    }

    /// Wire the WS client so the engine can signal it on lifecycle changes.
    pub fn set_ws(&mut self, ws: Arc<WsClient>) {
        self.ws = Some(ws);
    }

    /// Current lifecycle status.
    pub fn status(&self) -> EngineStatus {
        self.status
    }

    /// Effective configuration (with the chosen port applied after `start`).
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Handle to the shared stdout buffer; pass to other modules that need
    /// to scan engine output (e.g. for the initial admin password).
    pub fn stdout_buffer_handle(&self) -> Arc<StdMutex<Vec<String>>> {
        self.stdout_buffer.clone()
    }

    /// Spawn the engine process (local) OR start the cloud connection
    /// loop. Returns the port the local engine bound to; in cloud mode
    /// there is no local engine so the returned port is `0` and the
    /// caller should skip `wait_healthy()`.
    pub async fn start(
        &mut self,
        consent: Arc<TokioMutex<ConsentManager>>,
        executor: Arc<CommandExecutor>,
        status_tx: mpsc::Sender<ConnectionStatus>,
        shared_config: Arc<RwLock<Config>>,
    ) -> Result<u16> {
        match self.config.mode {
            Mode::Local => self.start_local().await,
            Mode::Cloud => {
                self.start_cloud(consent, executor, status_tx, shared_config)
                    .await
            }
        }
    }

    /// Local engine startup — unchanged from the original implementation,
    /// just renamed to make the dispatch explicit.
    async fn start_local(&mut self) -> Result<u16> {
        let port = Config::find_free_port(8080)
            .context("no free port in 8080-8089 range")?;

        let engine_path = self
            .config
            .engine_path
            .clone()
            .unwrap_or_else(|| "feclaw".to_string());

        let mut cmd = Command::new(&engine_path);
        cmd.arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .arg("--config")
            .arg(Config::config_path().to_string_lossy().as_ref())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .kill_on_drop(true);

        tracing::info!(
            "starting engine: {} --host {} --port {} --config {}",
            engine_path,
            "127.0.0.1",
            port,
            Config::config_path().display()
        );
        let mut child = cmd.spawn().context("spawn feclaw engine")?;

        if let Some(stdout) = child.stdout.take() {
            let buf = self.stdout_buffer.clone();
            async_runtime::spawn(async move {
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!("[engine] {line}");
                    if let Ok(mut b) = buf.lock() {
                        b.push(line);
                    }
                }
            });
        }
        if let Some(stderr) = child.stderr.take() {
            async_runtime::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::warn!("[engine] {line}");
                }
            });
        }

        self.child = Some(child);
        self.status = EngineStatus::Starting;

        // Create a reusable HTTP client for health checks.
        self.client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .ok();

        Ok(port)
    }

    /// Cloud-mode startup. Spawns a background task that owns the WS
    /// connection lifecycle (connect → run → wait 5 s → repeat). The
    /// task reads `cloud_url`/`cloud_token` from `shared_config` so the
    /// Settings UI can update them live; the cancel token is shared with
    /// the control pump so `SetMode`/`Reconnect` can force a re-handshake.
    ///
    /// If the connection fails with a 4xxx close code (4001 invalid
    /// token, 4002 forbidden) the cached JWT is cleared and the user is
    /// prompted to re-authenticate via the Settings window.
    ///
    /// Returns `Ok(0)` — there is no local port to report.
    async fn start_cloud(
        &mut self,
        consent: Arc<TokioMutex<ConsentManager>>,
        executor: Arc<CommandExecutor>,
        status_tx: mpsc::Sender<ConnectionStatus>,
        shared_config: Arc<RwLock<Config>>,
    ) -> Result<u16> {
        // Sanity-check the config up front. We don't *require* a token —
        // the loop will trigger the login UI if one is missing — but the
        // URL is mandatory.
        if self
            .config
            .cloud_url
            .as_deref()
            .map(str::is_empty)
            .unwrap_or(true)
        {
            return Err(anyhow!(
                "cloud mode requires `cloud_url` to be set in config.toml"
            ));
        }

        let cancel_token = self.cancel_token.clone();
        let ui_tx = self.ui_tx.clone();

        self.status = EngineStatus::Starting;

        async_runtime::spawn(async move {
            Self::cloud_loop(
                shared_config,
                cancel_token,
                ui_tx,
                consent,
                executor,
                status_tx,
            )
            .await;
        });

        tracing::info!("cloud mode: connection loop started");
        Ok(0)
    }

    /// Inner cloud connection loop. Lives for the entire process
    /// lifetime (until the cancel token is flipped twice in a row, which
    /// the control pump doesn't do — this only ends when the process
    /// exits).
    async fn cloud_loop(
        shared_config: Arc<RwLock<Config>>,
        cancel_token: Arc<AtomicBool>,
        ui_tx: Option<mpsc::UnboundedSender<ControlMsg>>,
        consent: Arc<TokioMutex<ConsentManager>>,
        executor: Arc<CommandExecutor>,
        status_tx: mpsc::Sender<ConnectionStatus>,
    ) {
        loop {
            // 1. Honour a pending reconnect request (SetMode, Reconnect, …)
            //    by clearing the flag and re-reading the config from disk.
            if cancel_token.load(Ordering::SeqCst) {
                cancel_token.store(false, Ordering::SeqCst);
                tracing::info!("cloud loop: reconnect requested via cancel token");
            }

            // 2. Snapshot the current cloud config.
            let (cloud_url, cloud_token, cloud_username) = {
                let cfg = shared_config.read().await;
                (
                    cfg.cloud_url.clone(),
                    cfg.cloud_token.clone(),
                    cfg.cloud_username.clone(),
                )
            };

            // 3. URL is mandatory. If it's missing, prompt the user via
            //    the Settings window and back off.
            let url = match cloud_url {
                Some(u) if !u.trim().is_empty() => u,
                _ => {
                    tracing::warn!("cloud_url not configured; prompting user");
                    Self::request_cloud_login(&ui_tx);
                    tokio::time::sleep(CLOUD_LOGIN_BACKOFF).await;
                    continue;
                }
            };

            // 4. Token is required to actually connect. If it's missing
            //    or malformed, prompt the user.
            let token = match cloud_token {
                Some(t) if crate::auth::verify_desktop_jwt(&t) => t,
                Some(t) => {
                    tracing::warn!(
                        "cached cloud token is malformed (len={}); requesting re-login",
                        t.len()
                    );
                    Self::clear_token(&shared_config).await;
                    Self::request_cloud_login(&ui_tx);
                    Self::emit_auth_failure(&ui_tx, "cached token rejected");
                    tokio::time::sleep(CLOUD_LOGIN_BACKOFF).await;
                    continue;
                }
                None => {
                    tracing::info!("no cloud token; requesting login");
                    Self::request_cloud_login(&ui_tx);
                    tokio::time::sleep(CLOUD_LOGIN_BACKOFF).await;
                    continue;
                }
            };

            // 5. Build the WS URL and spin up a fresh WsClient. The
            //    outgoing channel is owned by the WsClient; the rest of
            //    the app only consumes status updates via `status_tx`,
            //    so we don't need to plumb the sender back out.
            let ws_url = format!("{}/ws/desktop", url.trim_end_matches('/'));
            tracing::info!("cloud: connecting to {ws_url} as user={:?}", cloud_username);
            let ws = WsClient::new(
                ws_url,
                token,
                status_tx.clone(),
                consent.clone(),
                executor.clone(),
                cancel_token.clone(),
                None,
            );

            let (close_code, result) = ws.run_once().await;

            // 6. Auth-failure close codes invalidate the JWT.
            //
            // Codes we treat as auth failures (per the cloud WS contract):
            //   4001 — invalid / expired token
            //   4002 — forbidden (account disabled, scope mismatch, …)
            //   4003 — authentication required (peer demanded creds we
            //          didn't supply, e.g. after a server-side session
            //          invalidation)
            //
            // In every case the JWT is no longer usable, so we clear it
            // and notify the UI. 4003 is added on top of the original
            // 4001/4002 pair so a missing-or-stale cookie also lands in
            // the same "please re-authenticate" path.
            if matches!(close_code, Some(4001) | Some(4002) | Some(4003)) {
                let reason = match close_code {
                    Some(4001) => "token invalid or expired",
                    Some(4002) => "forbidden",
                    Some(4003) => "authentication required",
                    _ => "unknown auth failure",
                };
                tracing::warn!(
                    "cloud auth failure (close code {:?}, reason={reason}); clearing token",
                    close_code
                );
                Self::clear_token(&shared_config).await;
                Self::request_cloud_login(&ui_tx);
                Self::emit_auth_failure(&ui_tx, reason);
                tokio::time::sleep(CLOUD_LOGIN_BACKOFF).await;
                continue;
            }

            // 7. Transport-level error or clean disconnect → wait and retry.
            match &result {
                Ok(()) => tracing::info!("cloud WS disconnected cleanly; will retry"),
                Err(e) => tracing::warn!("cloud WS error: {e:#}; will retry"),
            }
            tokio::time::sleep(CLOUD_RECONNECT_DELAY).await;
        }
    }

    /// Ask the user to log in by emitting a `ControlMsg::ShowCloudLogin`.
    /// The control pump in `lib.rs` opens the Settings window and
    /// switches to the cloud tab.
    fn request_cloud_login(ui_tx: &Option<mpsc::UnboundedSender<ControlMsg>>) {
        if let Some(tx) = ui_tx {
            let _ = tx.send(ControlMsg::ShowCloudLogin);
        } else {
            tracing::error!(
                "no ui_tx; cannot request cloud login. \
                 The user must manually sign in via Settings."
            );
        }
    }

    /// Surface a cloud auth failure to the UI by emitting
    /// `ControlMsg::AuthFailure`. The control pump in `lib.rs` turns this
    /// into a `auth-failure` Tauri event so the chat window can show an
    /// inline "session expired" banner immediately, without waiting for
    /// the user to navigate to Settings.
    ///
    /// `reason` is a short human-readable string (e.g. `"token invalid or
    /// expired"`, `"forbidden"`, `"authentication required"`). The frontend
    /// decides whether to translate / display it.
    fn emit_auth_failure(ui_tx: &Option<mpsc::UnboundedSender<ControlMsg>>, reason: &str) {
        if let Some(tx) = ui_tx {
            let _ = tx.send(ControlMsg::AuthFailure {
                reason: reason.to_string(),
            });
        } else {
            tracing::error!(
                "no ui_tx; cannot forward auth-failure event. \
                 The user will only see this on the next reconnect attempt."
            );
        }
    }

    /// Clear the cached cloud token and persist the change. Used when
    /// the server reports the token is no longer valid.
    async fn clear_token(shared_config: &Arc<RwLock<Config>>) {
        let mut cfg = shared_config.write().await;
        cfg.cloud_token = None;
        if let Err(e) = cfg.save() {
            tracing::warn!("failed to persist cleared cloud token: {e:#}");
        }
    }

    /// Poll `/health` until the engine responds 200 or the timeout elapses.
    pub async fn wait_healthy(&self) -> Result<()> {
        let url = format!("{}/health", self.config.engine_url());
        let client = self.client.as_ref().context("health-check client not initialized")?;
        let deadline = Instant::now() + HEALTH_TIMEOUT;
        while Instant::now() < deadline {
            if let Ok(resp) = client.get(&url).send().await {
                if resp.status().is_success() {
                    tracing::info!("engine is healthy at {url}");
                    return Ok(());
                }
            }
            tokio::time::sleep(HEALTH_INTERVAL).await;
        }
        anyhow::bail!("engine did not become healthy within {HEALTH_TIMEOUT:?}")
    }

    /// Single health probe (no polling).
    pub async fn health_check(&self) -> bool {
        let url = format!("{}/health", self.config.engine_url());
        let Some(client) = self.client.as_ref() else {
            return false;
        };
        client
            .get(&url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// Graceful stop: wait up to 5 s for the engine to exit on its own,
    /// then send SIGKILL.
    pub async fn stop(&mut self) -> Result<()> {
        if let Some(mut child) = self.child.take() {
            tracing::info!("stopping engine (graceful)");
            let _ = child.start_kill();
            match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
                Ok(_) => {
                    self.status = EngineStatus::Stopped;
                    return Ok(());
                }
                Err(_) => {
                    tracing::warn!("engine did not exit within 5s; killing");
                    let _ = child.kill().await;
                }
            }
        }
        self.status = EngineStatus::Stopped;
        Ok(())
    }

    /// Non-blocking check: is the engine process still alive?
    pub fn is_running(&mut self) -> bool {
        match self.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// Wait until the child process exits (e.g. for crash detection).
    pub async fn wait_exit(&mut self) -> Result<Option<i32>> {
        if let Some(child) = self.child.as_mut() {
            let status = child.wait().await.context("wait on child")?;
            self.status = EngineStatus::Stopped;
            return Ok(status.code());
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_manager_initial_status_is_stopped() {
        let cfg = Config::default();
        let engine = EngineManager::new(cfg);
        assert_eq!(engine.status(), EngineStatus::Stopped);
    }

    #[test]
    fn engine_status_equality() {
        use crate::engine::EngineStatus::*;
        assert_eq!(Stopped, Stopped);
        assert_eq!(Starting, Starting);
        assert_eq!(Running, Running);
        assert_eq!(Failed, Failed);
        assert_ne!(Stopped, Starting);
    }

    #[test]
    fn engine_status_debug() {
        let status = EngineStatus::Stopped;
        let debug_str = format!("{:?}", status);
        assert_eq!(debug_str, "Stopped");
    }

    #[test]
    fn engine_config_preserved() {
        let cfg = Config {
            host: "192.168.1.1".to_string(),
            port: 9999,
            engine_path: Some("/custom/feclaw".to_string()),
            ws_path: "/custom/ws".to_string(),
            mode: crate::config::Mode::Cloud,
        };
        let engine = EngineManager::new(cfg.clone());
        assert_eq!(engine.config().host, "192.168.1.1");
        assert_eq!(engine.config().port, 9999);
        assert_eq!(engine.config().mode, crate::config::Mode::Cloud);
    }

    #[test]
    fn stdout_buffer_handle_cloneable() {
        let cfg = Config::default();
        let engine = EngineManager::new(cfg);
        let handle = engine.stdout_buffer_handle();
        // Should be cloneable (Arc)
        let _ = handle.clone();
    }

    #[test]
    fn is_running_when_no_child() {
        let cfg = Config::default();
        let mut engine = EngineManager::new(cfg);
        // No child spawned yet → not running
        assert!(!engine.is_running());
    }
}
