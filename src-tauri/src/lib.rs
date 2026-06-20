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

mod alt_space;
mod auth;
mod autostart;
mod chat;
mod config;
mod consent;
mod create;
mod db;
mod engine;
mod executor;
mod fehub;
mod file_bridge;
mod file_manager;
mod file_ops;
mod group;
mod local_setup;
mod moments;
mod right_click;
mod qr_upload;
mod search;
mod settings;
mod side_panel;
mod tray;
mod welcome;
mod ws;
mod ws_types;

// Re-export handle_right_click_invocation so main.rs (which is part of the
// same library crate) can call it before the Tauri app starts.
pub use right_click::handle_right_click_invocation;

use crate::auth::AuthManager;
use crate::config::{Config, Mode};
use crate::consent::ConsentManager;
use crate::engine::EngineManager;
use crate::executor::CommandExecutor;
use crate::ws::WsClient;
use crate::ws_types::ConnectionStatus;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
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
    /// The cloud engine rejected our credentials (close code 4001, 4002,
    /// or 4003). The control pump turns this into a frontend `auth-failure`
    /// Tauri event so the chat UI can show a "session expired, please
    /// re-authenticate" notice without waiting for the user to open
    /// Settings.
    AuthFailure { reason: String },
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
    pub consent: Arc<tokio::sync::Mutex<ConsentManager>>,
    /// Outgoing channel for chat messages / consent responses. Populated
    /// after [`WsClient`] is constructed (the WS client owns the
    /// receiver); `chat::send_chat_message` reads this clone to push
    /// envelopes without holding the WS stream.
    pub ws_outgoing: Arc<RwLock<Option<mpsc::UnboundedSender<String>>>>,
    /// Handle to the running engine process (when in local mode). Stored
    /// so chat-side consent/file ops can pause/resume engine work.
    #[allow(dead_code)]
    pub engine_running: Arc<RwLock<bool>>,
}

/// Tauri application entry point.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Logging is handled by `tauri-plugin-log` below.

    tauri::async_runtime::block_on(async {
        let app = tauri::Builder::default()
            .plugin(tauri_plugin_log::Builder::default().build())
            .invoke_handler(tauri::generate_handler![
                settings::load_settings,
                settings::save_settings,
                settings::open_settings_window,
                settings::test_cloud_connection,
                settings::get_cloud_session,
                settings::cloud_login,
                settings::cloud_disconnect,
                settings::set_theme,
                settings::get_theme,
                settings::get_app_version,
                file_ops::file_read,
                file_ops::file_write,
                file_ops::file_delete,
                file_ops::open_local_file,
                file_ops::cleanup_preview_temp,
                file_manager::list_vfs_dir,
                file_manager::get_vfs_preview_url,
                file_manager::get_vfs_upload_url,
                file_manager::vfs_mkdir,
                file_manager::vfs_rm,
                file_manager::vfs_mv,
                file_manager::vfs_set_permission,
                file_manager::vfs_notify_event,
                file_manager::download_vfs_file,
                welcome::check_first_launch,
                welcome::save_welcome_config,
                welcome::discover_well_known,
                welcome::open_welcome_window,
                welcome::get_permissions,
                chat::get_chat_history,
                chat::append_chat_message,
                chat::clear_chat_history,
                chat::send_chat_message,
                chat::open_chat_window,
                chat::get_connection_status,
                chat::get_chat_history_path,
                chat::send_consent_response,
                chat::list_agents,
                chat::get_chat_history_by_agent,
                chat::insert_chat_message,
                chat::delete_chat_message,
                create::create_agent,
                create::create_group_placeholder,
                create::pick_local_file,
                db::init_db,
                db::check_legacy_chat_history,
                db::import_chat_history,
                db::save_draft,
                db::load_draft,
                db::save_temp_image,
                db::get_prompt_templates,
                db::save_prompt_template,
                db::delete_prompt_template,
                local_setup::check_git_installed,
                local_setup::check_python_version,
                local_setup::clone_feclaw,
                local_setup::generate_env_template,
                local_setup::write_env_file,
                local_setup::install_dependencies,
                local_setup::start_feclaw,
                local_setup::check_engine_health,
                local_setup::save_local_engine_config,
                local_setup::default_engine_dest,
                local_setup::open_local_setup_window,
                side_panel::get_agent_panel_info,
                side_panel::update_agent_alias,
                side_panel::toggle_pin,
                side_panel::toggle_dnd,
                side_panel::set_agent_permission_mode,
                side_panel::sync_agent_settings,
                side_panel::list_agent_apps,
                side_panel::open_config_window,
                side_panel::open_file_manager_window,
                right_click::register_right_click,
                right_click::unregister_right_click,
                right_click::is_right_click_registered,
                right_click::get_executable_path,
                group::list_groups,
                group::get_group_detail,
                group::get_group_messages,
                group::create_group,
                group::add_group_member,
                group::remove_group_member,
                group::delete_group,
                chat::send_group_message,
                moments::get_moments,
                moments::post_moment,
                moments::delete_moment,
                qr_upload::create_upload_session,
                qr_upload::generate_qr_code,
                qr_upload::download_uploaded_file,
                fehub::list_my_publishes,
                fehub::open_miniapp,
                search::search_all,
                search::search_local_chat,
                alt_space::register_search_shortcut,
                alt_space::unregister_search_shortcut,
                alt_space::is_search_shortcut_bound,
                alt_space::apply_search_privacy,
            ])
            .setup(|app| {
                let handle = app.handle().clone();
                let app_handle_for_error = app.handle().clone();
                // First-launch check: if `~/.feclaw/config.toml` does not exist,
                // open the welcome window immediately so the user can pick an
                // onboarding path (official / selfhosted / local).
                // NOTE: Config::load() CREATES the file on first call (default +
                // auto-save), so we must check existence BEFORE calling load().
                let is_first = !crate::config::Config::config_path().exists();
                let _ = crate::config::Config::load(); // ensure default config exists
                tauri::async_runtime::spawn(async move {
                    if is_first {
                        if let Err(e) = welcome::open_welcome_window(handle.clone()).await {
                            tracing::warn!("failed to open welcome window on first launch: {e}");
                        }
                        return;
                    }
                    if let Err(e) = startup(handle).await {
                        tracing::error!("startup failed: {e:#}");
                        let err_msg = format!("{e:#}");
                        let app_handle = app_handle_for_error.clone();
                        std::thread::spawn(move || {
                            let _ = rfd::MessageDialog::new()
                                .set_title("FeClaw Desktop — 启动失败")
                                .set_description(&err_msg)
                                .set_buttons(rfd::MessageButtons::Ok)
                                .set_level(rfd::MessageLevel::Error)
                                .show();
                        });
                        // Open settings so user can configure cloud mode.
                        tauri::async_runtime::spawn(async move {
                            let _ = settings::open_settings_window(app_handle).await;
                        });
                        return;
                    }

                    // Check for pending right-click file (written by shell invocation)
                    if let Ok(Some(pending)) = right_click::take_pending_right_click() {
                        tracing::info!("found pending right-click: mode={}, path={}", pending.mode, pending.path);
                        let pending_mode = pending.mode.clone();
                        let pending_path = pending.path.clone();
                        let app_for_pending = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            // Give the UI a moment to initialise before emitting the event
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            if let Err(e) = app_for_pending.emit("right-click-pending", &pending) {
                                tracing::warn!("emit right-click-pending: {e}");
                            }
                        });
                        // Store the pending info in a static so chat.ts can read it after init
                        // (The event above is the primary mechanism; the static is a fallback.)
                        let _ = pending_mode;
                        let _ = pending_path;
                    }
                });
                Ok(())
            })
            .build(tauri::generate_context!())
            .expect("error while building tauri application");

        #[cfg(feature = "global-shortcut")]
        let app = app.plugin(tauri_plugin_global_shortcut::Builder::new().build());

        app.run(|_app_handle, _event| {});
    });
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
        ws_outgoing: Arc::new(RwLock::new(None)),
        engine_running: Arc::new(RwLock::new(false)),
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

    // 6b. Register Alt+Space global shortcut if in cloud mode and previously bound.
    if config.mode == crate::config::Mode::Cloud {
        let app_for_shortcut = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = alt_space::register_if_needed(app_for_shortcut).await {
                tracing::warn!("register_if_needed: {e}");
            }
        });
    }

    // 6. Wire executor + WS (consent Arc is shared with AppState).
    //    `executor` was created earlier (alongside AppState) and reused here.
    let ws = WsClient::new(
        config.ws_url(),
        token,
        status_tx,
        consent,
        executor,
        cancel_token.clone(),
        Some(app.clone()),
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
                ControlMsg::AuthFailure { reason } => {
                    tracing::warn!("control: auth failure forwarded to UI (reason={reason})");
                    // Forward to the frontend so any open chat window can
                    // show a "session expired" banner immediately. The
                    // payload is the reason string the server sent (or a
                    // synthesised message when the server didn't include
                    // one); the UI decides how to render it.
                    if let Err(e) = app_for_control.emit("auth-failure", &reason) {
                        tracing::warn!("emit auth-failure: {e}");
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
