//! FeClaw Desktop — PR 1: project skeleton + engine process management.
//!
//! This iteration only loads `~/.feclaw/config.toml`, spawns the local
//! `feclaw` engine, polls `/health` until it responds 200, and idles.
//! Subsequent PRs layer on authentication, WebSocket, consent, executor,
//! and the system tray.

mod config;
mod engine;

use crate::config::Config;
use crate::engine::EngineManager;

/// Tauri application entry point.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Honour `RUST_LOG` if set, otherwise default to `info`.
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

/// PR 1 startup: load config → spawn engine → wait for `/health` → idle.
async fn startup(_app: tauri::AppHandle) -> anyhow::Result<()> {
    let mut config = Config::load();
    tracing::info!(
        "loaded config: host={}, port={}, mode={:?}",
        config.host,
        config.port,
        config.mode
    );

    let mut engine = EngineManager::new(config.clone());
    let port = engine.start().await?;
    config.port = port;
    engine.wait_healthy().await?;
    tracing::info!("engine ready on port {port}");

    // PR 1: idle loop. We poll the child once a minute so a crash surfaces
    // in the logs. Subsequent PRs replace this with the auth + WS layers.
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
