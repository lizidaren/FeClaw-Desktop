//! Engine process management.
//!
//! Spawns the local `feclaw` engine as a child process, captures its
//! stdout/stderr into a shared buffer (so other modules can scan the
//! initial-password line), polls `/health` until the engine is ready,
//! and gracefully stops it on shutdown.

use crate::config::Config;
use anyhow::{Context, Result};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::async_runtime;
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
}

impl EngineManager {
    /// Create a new manager bound to the given configuration.
    pub fn new(config: Config) -> Self {
        Self {
            config,
            child: None,
            status: EngineStatus::Stopped,
            stdout_buffer: Arc::new(Mutex::new(Vec::new())),
        }
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
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .kill_on_drop(true);

        tracing::info!(
            "starting engine: {} --host {} --port {}",
            engine_path,
            self.config.host,
            port
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
        Ok(port)
    }

    /// Poll `/health` until the engine responds 200 or the timeout elapses.
    pub async fn wait_healthy(&self) -> Result<()> {
        let url = format!("{}/health", self.config.engine_url());
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .context("build health-check client")?;
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
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
        {
            Ok(c) => c,
            Err(_) => return false,
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
