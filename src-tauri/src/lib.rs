//! FeClaw Desktop — PR 2: engine auto-login + JWT persistence.
//!
//! After PR 1 starts the engine, this iteration:
//!   1. Loads the persisted `~/.feclaw/local-credentials` (if any).
//!   2. If a JWT is present, validates it via `GET /api/me`. If valid,
//!      uses it directly.
//!   3. Otherwise, scans the engine stdout buffer (captured by
//!      `EngineManager`) for the random initial admin password, POSTs
//!      `/api/login`, and writes the JWT back to disk.
//!
//! Subsequent PRs layer the WebSocket, consent dialog, executor, and
//! system tray on top of this foundation.

mod auth;
mod config;
mod engine;

use crate::auth::AuthManager;
use crate::config::Config;
use crate::engine::EngineManager;

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

/// PR 1+2 startup: config → engine → auth. The WS layer is added in PR 3.
async fn startup(_app: tauri::AppHandle) -> anyhow::Result<()> {
    // 1. Load (or initialise) config.
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

    // 3. Authenticate (reuse token or log in via initial password).
    let mut auth = AuthManager::new(config.clone());
    let stdout_buffer = engine.stdout_buffer_handle();
    let token = auth.login_or_load(stdout_buffer).await?;
    tracing::info!("authenticated (token length={})", token.len());

    // PR 1+2: keep the engine alive and watch for crashes.
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
