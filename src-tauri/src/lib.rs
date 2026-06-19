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
mod autostart;
mod config;
mod consent;
mod engine;
mod executor;
mod file_bridge;
mod file_ops;
mod settings;
mod tray;
mod ws;
mod ws_types;

use crate::auth::AuthManager;
use crate::config::{Config, Mode};
use crate::consent::ConsentManager;
use crate::engine::EngineManager;
use crate::executor::CommandExecutor;
use crate::ws::WsClient;
use crate::ws_types::ConnectionStatus;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::async_runtime;
use tauri::Manager;
use tokio::sync::mpsc;
use tokio::sync::{Mutex, RwLock};

/// Commands the UI can send into the async runtime.
#[derive(Debug, Clone)]
pub enum ControlMsg {
    /// Force the WS client to drop the current connection and reconnect.
    /// (For MVP the WS client already auto-reconnects; this is exposed
    /// via the tray menu for manual intervention.)
    Reconnect,
    /// Persist a mode change (`~/.feclaw/config.toml`).
    SetMode(Mode),
    /// Open the Settings window on the cloud tab and tell the UI to focus
    /// the login form. Emitted by `EngineManager::cloud_loop` whenever
    /// the cloud token is missing or rejected (4001/4002 close codes).
    ShowCloudLogin,
    /// Exit the application cleanly.
    Quit,
}

/// Shared, read-mostly state surfaced via `app.state::<AppState>()`.
pub struct AppState {
    pub config: Arc<RwLock<Config>>,
    pub status: Arc<RwLock<ConnectionStatus>>,
    pub control_tx: mpsc::UnboundedSender<ControlMsg>,
    /// Signals the WS client to cancel the current connection and reconnect.
    pub cancel_token: Arc<AtomicBool>,
    /// Shared with `WsClient` so file-relay Tauri commands and the WS handler
    /// funnel through one consent gate (shared session_trust list).
    pub consent: Arc<Mutex<ConsentManager>>,
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
        .invoke_handler(tauri::generate_handler![
            settings::load_settings,
            settings::save_settings,
            settings::open_settings_window,
            settings::test_cloud_connection,
            file_ops::file_read,
            file_ops::file_write,
            file_ops::file_delete,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = startup(handle).await {
                    tracing::error!("startup failed: {e:#}");
                    // Show a native error dialog so the user knows why startup failed.
                    let err_msg = format!("{e:#}");
                    std::thread::spawn(move || {
                        let _ = rfd::MessageDialog::new()
                            .set_title("FeClaw Desktop — 启动失败")
                            .set_description(&err_msg)
                            .set_buttons(rfd::MessageButtons::Ok)
                            .set_level(rfd::MessageLevel::Error)
                            .show();
                    });
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

    // 2. Build the engine manager but DON'T start it yet — `start()` needs
    //    `consent`, `executor`, `status_tx`, and `shared_config` which all
    //    live behind AppState. We start in step 5 once those exist.
    let mut engine = EngineManager::new(config.clone());

    // 3. Authenticate against the local engine's credentials cache.
    //    In cloud mode this is skipped — the cloud token is read inside
    //    `engine.start_cloud`.
    let mut auth = AuthManager::new(config.clone());
    let stdout_buffer = engine.stdout_buffer_handle();
    let token = auth.login_or_load(stdout_buffer).await?;
    tracing::info!("authenticated (token length={})", token.len());

    // 4. Register AppState (must exist before tray builder reads it).
    let (control_tx, control_rx) = mpsc::unbounded_channel::<ControlMsg>();
    let cancel_token = Arc::new(AtomicBool::new(false));
    let (status_tx, mut status_rx) = mpsc::channel(32);
    // Consent is created here (before AppState) so we can hand the same Arc
    // to both AppState and WsClient — both the Tauri commands and the WS
    // file handlers must share one consent gate.
    let consent = Arc::new(Mutex::new(ConsentManager::new()));
    consent.lock().await.load_trusted();
    let executor = Arc::new(CommandExecutor::new());
    let shared_config = Arc::new(RwLock::new(config.clone()));
    let state = AppState {
        config: shared_config.clone(),
        status: Arc::new(RwLock::new(ConnectionStatus::Disconnected)),
        control_tx: control_tx.clone(),
        cancel_token: cancel_token.clone(),
        consent: consent.clone(),
    };
    engine.set_ui_tx(control_tx.clone());
    engine.set_cancel_token(cancel_token.clone());
    app.manage(state);

    // 5. Start the engine now that AppState exists. We hand `engine.start()`
    //    a clone of `status_tx` so the local-mode `WsClient` (constructed
    //    below) can still publish connection status updates on the same
    //    channel — in cloud mode the inner cloud_loop consumes the cloned
    //    sender instead.
    let port = engine
        .start(
            consent.clone(),
            executor.clone(),
            status_tx.clone(),
            shared_config.clone(),
        )
        .await?;
    config.port = port;
    if let Err(e) = config.save() {
        tracing::warn!("failed to persist selected port to config.toml: {e:#}");
    }
    if port != 0 {
        engine.wait_healthy().await?;
        tracing::info!("engine ready on port {port}");
    }

    // 6. Build system tray.
    if let Err(e) = tray::build_tray(&app) {
        tracing::warn!("failed to build tray: {e:#}");
    }

    // 6. Wire executor + WS (consent Arc is shared with AppState).
    //    `executor` was created earlier (alongside AppState) and reused here.
    let ws = WsClient::new(
        config.ws_url(),
        token,
        status_tx,
        consent,
        executor,
        cancel_token,
    );

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
    let cancel_token_for_pump = cancel_token.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(msg) = control_rx.recv().await {
            match msg {
                ControlMsg::Reconnect => {
                    tracing::info!("control: reconnect requested");
                    cancel_token_for_pump.store(true, Ordering::SeqCst);
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
                ControlMsg::ShowCloudLogin => {
                    tracing::info!("control: show cloud login requested");
                    if let Err(e) = settings::open_settings_window(app_for_control.clone()).await {
                        tracing::error!("open settings window: {e}");
                    }
                    if let Err(e) = app_for_control.emit("navigate-settings", "cloud") {
                        tracing::warn!("emit navigate-settings: {e}");
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
