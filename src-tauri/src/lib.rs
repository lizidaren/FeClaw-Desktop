//! FeClaw Desktop — PR 4: native consent + command execution.
//!
//! PR 3 established the WS transport. This iteration wires in:
//!   * `ConsentManager` — risk-classifies each `command_exec_request`,
//!     pops a native `rfd::MessageDialog`, persists user choices to
//!     `~/.feclaw/trusted-commands.json` for "Always Allow".
//!   * `CommandExecutor` — `tokio::process::Command` with timeout
//!     (default 300 s), 1 MiB stdout/stderr truncation, and auto-mkdir
//!     for missing `cwd`.

mod auth;
mod config;
mod consent;
mod engine;
mod executor;
mod ws;
mod ws_types;

use crate::auth::AuthManager;
use crate::config::Config;
use crate::consent::ConsentManager;
use crate::engine::EngineManager;
use crate::executor::CommandExecutor;
use crate::ws::WsClient;
use crate::ws_types::ConnectionStatus;
use std::sync::Arc;

/// Tauri application entry point.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = startup(handle).await {
                    tracing::error!("startup failed: {e:#}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn startup(_app: tauri::AppHandle) -> anyhow::Result<()> {
    // 1. Load config.
    let mut config = Config::load();
    tracing::info!(
        "loaded config: host={}, port={}, mode={:?}",
        config.host,
        config.port,
        config.mode
    );

    // 2. Start engine.
    let mut engine = EngineManager::new(config.clone());
    let port = engine.start().await?;
    config.port = port;
    engine.wait_healthy().await?;
    tracing::info!("engine ready on port {port}");

    // 3. Authenticate.
    let mut auth = AuthManager::new(config.clone());
    let stdout_buffer = engine.stdout_buffer_handle();
    let token = auth.login_or_load(stdout_buffer).await?;
    tracing::info!("authenticated (token length={})", token.len());

    // 4. Wire up consent + executor + WS.
    let (status_tx, mut status_rx) = tauri::async_runtime::mpsc::channel(32);
    let consent = Arc::new(tokio::sync::Mutex::new(ConsentManager::new()));
    consent.lock().await.load_trusted();
    let executor = Arc::new(CommandExecutor::new());
    let ws = WsClient::new(
        config.ws_url(),
        token,
        status_tx,
        consent,
        executor,
    );

    // 5. Status pump.
    tauri::async_runtime::spawn(async move {
        while let Some(status) = status_rx.recv().await {
            tracing::info!("ws status → {status:?}");
        }
    });

    // 6. WS task — reconnect + heartbeat + dispatch.
    tauri::async_runtime::spawn(async move {
        ws.run().await;
    });

    // 7. Idle watcher.
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        if !engine.is_running() {
            tracing::error!("engine process exited; shutting down");
            break;
        }
    }
    let _ = engine.stop().await;
    Ok(())
}
