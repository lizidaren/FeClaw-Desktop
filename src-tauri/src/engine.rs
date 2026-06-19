//! Engine process management.
//!
//! Spawns the local `feclaw` engine as a child process, captures its
//! stdout/stderr into a shared buffer (so other modules can scan the
//! initial-password line), polls `/health` until the engine is ready,
//! and gracefully stops it on shutdown.

use crate::config::Config;
use crate::ControlMsg;
use crate::ws::WsClient;
use anyhow::{Context, Result};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::async_runtime;
use tauri::async_runtime::mpsc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// Maximum time to wait for the engine to become healthy.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
/// Interval between health-check probes.
const HEALTH_INTERVAL: Duration = Duration::from_millis(500);

/// Lifecycle states reported by [`EngineManager`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineStatus {
    Stopped,
    Starting,
    Running,
    Failed,
}

/// Manages the lifecycle of the local FeClaw engine process.
pub struct EngineManager {
    config: Config,
    child: Option<Child>,
    status: EngineStatus,
    /// Shared buffer of captured engine stdout lines. Used by `auth.rs`
    /// to scan for the random initial admin password on first launch.
    stdout_buffer: Arc<Mutex<Vec<String>>>,
    /// Reusable HTTP client for health checks. Created once in `start()`.
    client: Option<reqwest::Client>,
    /// Optional sender for `ControlMsg`. When set, engine state changes are
    /// pushed to the UI so the tray / status bar can reflect them in
    /// real time (e.g. emit `Reconnect` if the engine becomes unhealthy).
    ui_tx: Option<mpsc::UnboundedSender<ControlMsg>>,
    /// Cancel flag set by the control pump to signal `wait_exit` to give up.
    cancel_token: Arc<std::sync::atomic::AtomicBool>,
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
            stdout_buffer: Arc::new(Mutex::new(Vec::new())),
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
    pub fn stdout_buffer_handle(&self) -> Arc<Mutex<Vec<String>>> {
        self.stdout_buffer.clone()
    }

    /// Spawn the engine process. Returns the port it was bound to (which
    /// may differ from `config.port` if the default was busy).
    pub async fn start(&mut self) -> Result<u16> {
        let port = Config::find_free_port(self.config.port)
            .context("no free port in 8080-8089 range")?;
        self.config.port = port;

        let engine_path = self
            .config
            .engine_path
            .clone()
            .unwrap_or_else(|| "feclaw".to_string());

        let mut cmd = Command::new(&engine_path);
        cmd.arg("--host")
            .arg(&self.config.host)
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
            self.config.host,
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
        let client = self.client.as_ref()?;
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
