//! FeClaw Desktop — PR 3: WebSocket transport layer.
//!
//! After PR 2 authenticates against the engine, this iteration wires
//! the JWT into a `WsClient` that connects to `/ws/desktop`,
//! heartbeats every 30 s, and reconnects up to 30 times spaced 1 s
//! apart. Connection status flows back over an mpsc channel. The
//! actual message dispatch (consent dialog + executor) lands in PR 4.

mod auth;
mod config;
mod engine;
mod ws;
mod ws_types;

use crate::auth::AuthManager;
use crate::config::Config;
use crate::engine::EngineManager;
use crate::ws::WsClient;
use crate::ws_types::ConnectionStatus;

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

/// PR 1+2+3 startup: config → engine → auth → ws.
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

    // 4. Wire up the WebSocket.
    let (status_tx, mut status_rx) = tauri::async_runtime::mpsc::channel(32);
    let ws = WsClient::new(config.ws_url(), token, status_tx);

    // Status pump: log every status change.
    tauri::async_runtime::spawn(async move {
        while let Some(status) = status_rx.recv().await {
            tracing::info!("ws status → {status:?}");
        }
    });

    // WS task — reconnect + heartbeat + (eventual) dispatch.
    tauri::async_runtime::spawn(async move {
        ws.run().await;
    });

    // 5. Idle watcher — surfaces a crashed engine.
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
