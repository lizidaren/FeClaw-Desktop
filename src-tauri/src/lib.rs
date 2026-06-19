//! FeClaw Desktop — PR 5: tray + final wiring.
//!
//! Boot sequence:
//!   1. Load `~/.feclaw/config.toml` (or persist defaults).
//!   2. Spawn the engine process via [`EngineManager`].
//!   3. Authenticate against `/api/login` (or reuse cached JWT).
//!   4. Register [`AppState`] + build the system tray.
//!   5. Open the WebSocket and start the status / control pumps.
//!   6. Idle-watcher: if the engine process exits, shut the app down.
//!
//! The UI never touches the engine directly — every interaction flows
//! through [`ControlMsg`] (tray → runtime) or inbound WS messages
//! (engine → runtime).

mod auth;
mod config;
mod consent;
mod engine;
mod executor;
mod tray;
mod ws;
mod ws_types;

use crate::auth::AuthManager;
use crate::config::{Config, Mode};
use crate::consent::ConsentManager;
use crate::engine::EngineManager;
use crate::executor::CommandExecutor;
use crate::ws::{ConnectionStatus, WsClient};
use std::sync::Arc;
use tauri::async_runtime::{self, mpsc};
use tokio::sync::RwLock;

/// Commands the UI can send into the async runtime.
#[derive(Debug, Clone)]
pub enum ControlMsg {
    /// Force the WS client to drop the current connection and reconnect.
    /// (For MVP the WS client already auto-reconnects; this is exposed
    /// via the tray menu for manual intervention.)
    Reconnect,
    /// Persist a mode change (`~/.feclaw/config.toml`).
    SetMode(Mode),
    /// Exit the application cleanly.
    Quit,
}

/// Shared, read-mostly state surfaced via `app.state::<AppState>()`.
pub struct AppState {
    pub config: Arc<RwLock<Config>>,
    pub status: Arc<RwLock<ConnectionStatus>>,
    pub control_tx: mpsc::UnboundedSender<ControlMsg>,
}

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

async fn startup(app: tauri::AppHandle) -> anyhow::Result<()> {
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
    if let Err(e) = config.save() {
        tracing::warn!("failed to persist selected port to config.toml: {e:#}");
    }
    engine.wait_healthy().await?;
    tracing::info!("engine ready on port {port}");

    // 3. Authenticate.
    let mut auth = AuthManager::new(config.clone());
    let stdout_buffer = engine.stdout_buffer_handle();
    let token = auth.login_or_load(stdout_buffer).await?;
    tracing::info!("authenticated (token length={})", token.len());

    // 4. Register AppState (must exist before tray builder reads it).
    let (control_tx, control_rx) = mpsc::unbounded_channel::<ControlMsg>();
    let state = AppState {
        config: Arc::new(RwLock::new(config.clone())),
        status: Arc::new(RwLock::new(ConnectionStatus::Disconnected)),
        control_tx,
    };
    app.manage(state);

    // 5. Build system tray.
    if let Err(e) = tray::build_tray(&app) {
        tracing::warn!("failed to build tray: {e:#}");
    }

    // 6. Wire consent + executor + WS.
    let (status_tx, mut status_rx) = mpsc::channel(32);
    let consent = Arc::new(tokio::sync::Mutex::new(ConsentManager::new()));
    consent.lock().await.load_trusted();
    let executor = Arc::new(CommandExecutor::new());
    let ws = WsClient::new(config.ws_url(), token, status_tx, consent, executor);

    // 7. Status pump — updates AppState + tray icon.
    let app_for_status = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(status) = status_rx.recv().await {
            tracing::info!("ws status → {status:?}");
            {
                let state = app_for_status.state::<AppState>();
                *state.status.write().await = status;
            }
            if let Some(tray_icon) = app_for_status.tray_by_id(tray::TRAY_ID) {
                let icon = tray::icon_for_status(status);
                let _ = tray_icon.set_icon(Some(icon));
                let _ = tray_icon.set_tooltip(Some(format!("FeClaw Desktop — {status:?}")));
            }
        }
    });

    // 8. Control message pump — drains tray menu events.
    let mut control_rx = control_rx;
    let app_for_control = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = control_rx.recv().await {
            match msg {
                ControlMsg::Reconnect => {
                    tracing::info!("control: reconnect requested");
                    // The WS client already auto-reconnects up to 30 times.
                    // A full restart of the WS task is deferred to a later PR.
                }
                ControlMsg::SetMode(mode) => {
                    tracing::info!("control: set mode {mode:?}");
                    let state = app_for_control.state::<AppState>();
                    let mut cfg = state.config.write().await;
                    cfg.mode = mode;
                    if let Err(e) = cfg.save() {
                        tracing::warn!("failed to persist config: {e:#}");
                    }
                }
                ControlMsg::Quit => {
                    tracing::info!("control: quit requested");
                    app_for_control.exit(0);
                }
            }
        }
    });

    // 9. WS task.
    tauri::async_runtime::spawn(async move {
        ws.run().await;
    });

    // 10. Idle watcher.
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
