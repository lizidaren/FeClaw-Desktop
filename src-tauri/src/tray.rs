//! System tray: icon + menu.
//!
//! The tray icon is generated at runtime as a coloured RGBA bitmap so the
//! colour can change with the WebSocket connection status (green /
//! yellow / red / gray). The menu has fixed entries (open / reconnect /
//! quit) that route through the [`ControlMsg`] channel into the
//! async runtime.

use crate::ws_types::ConnectionStatus;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

pub const TRAY_ID: &str = "main";

/// Build the system tray and attach it to `app`.
///
/// The constructed [`TrayIcon`] is registered with Tauri's own tray
/// registry, so background tasks can later look it up via
/// `app.tray_by_id(TRAY_ID)` to update the icon / tooltip as the WS
/// connection state changes.
pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open", "打开控制台", true, None::<&str>)?;
    let reconnect_item = MenuItem::with_id(app, "reconnect", "重新连接", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open_item,
            &reconnect_item,
            &sep1,
            &quit_item,
        ],
    )?;

    let icon = icon_for_status(ConnectionStatus::Disconnected);
    let initial_tooltip = format!(
        "FeClaw Desktop — {:?}",
        ConnectionStatus::Disconnected
    );

    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(&initial_tooltip)
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::DoubleClick { .. } = event {
                open_console(tray.app_handle().clone());
            }
        })
        .build(app)?;

    Ok(())
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return;
    };
    match id {
        "open" => open_console(app.clone()),
        "reconnect" => {
            let _ = state.control_tx.send(crate::ControlMsg::Reconnect);
        }
        "quit" => {
            let _ = state.control_tx.send(crate::ControlMsg::Quit);
        }
        _ => {}
    }
}

fn open_console<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let url = {
            let state = app.state::<crate::AppState>();
            let cfg = state.config.read().await;
            cfg.engine_url()
        };
        if let Err(e) = open::that_detached(&url) {
            tracing::warn!("failed to open browser: {e:#}");
        }
    });
}

/// Build a 32×32 RGBA bitmap of a filled circle in the colour that matches
/// `status`. Returned as a Tauri `Image` ready to plug into a tray icon.
pub fn icon_for_status(status: ConnectionStatus) -> tauri::image::Image<'static> {
    let (r, g, b) = match status {
        ConnectionStatus::Connected => (40, 200, 80),     // green
        ConnectionStatus::Reconnecting => (240, 200, 40), // yellow
        ConnectionStatus::Connecting => (240, 200, 40),   // yellow
        ConnectionStatus::Disconnected => (220, 60, 60),  // red
        ConnectionStatus::Failed => (220, 60, 60),        // red
    };
    make_circle_icon(r, g, b, 32)
}

fn make_circle_icon(r: u8, g: u8, b: u8, size: u32) -> tauri::image::Image<'static> {
    let mut data = vec![0u8; (size * size * 4) as usize];
    let cx = size as f32 / 2.0;
    let cy = size as f32 / 2.0;
    let radius = cx - 1.0;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - cx + 0.5;
            let dy = y as f32 - cy + 0.5;
            let dist = (dx * dx + dy * dy).sqrt();
            let i = ((y * size + x) * 4) as usize;
            if dist <= radius {
                data[i] = r;
                data[i + 1] = g;
                data[i + 2] = b;
                data[i + 3] = 255;
            }
        }
    }
    tauri::image::Image::new_owned(data, size, size)
}
