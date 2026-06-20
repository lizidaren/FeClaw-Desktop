//! Phase 7 Desktop — Alt+Space global shortcut + privacy API.
//!
//! Registers the Alt+Space global hotkey. When triggered, emits the
//! `toggle-search-overlay` Tauri event to the frontend so the search UI
//! can appear.
//!
//! On Windows, also applies `SetWindowDisplayAffinity` with `WDA_MONITOR`
//! so the overlay is hidden from screenshots and screen recordings.

use tauri::{AppHandle, Runtime};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

// ---------------------------------------------------------------------------
// Shortcut registration state
// ---------------------------------------------------------------------------

/// Guard type to hold the registered shortcut so it stays alive.
#[cfg(feature = "global-shortcut")]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Whether the Alt+Space shortcut is currently registered.
static ALT_SPACE_REGISTERED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Path to the persisted "shortcut bound" flag in `~/.feclaw/ui-settings.json`.
fn shortcut_bound_path() -> std::path::PathBuf {
    crate::config::Config::config_dir().join("shortcut_bound.json")
}

/// Load the persisted shortcut bound flag.
fn load_shortcut_bound() -> bool {
    let path = shortcut_bound_path();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("alt_space_bound")?.as_bool())
        .unwrap_or(false)
}

/// Save the shortcut bound flag.
fn save_shortcut_bound(bound: bool) -> std::io::Result<()> {
    let path = shortcut_bound_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&serde_json::json!({
        "alt_space_bound": bound
    }))?;
    std::fs::write(&path, json)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Windows privacy API (SetWindowDisplayAffinity)
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod privacy {
    use std::ffi::c_void;

    const WDA_MONITOR: u32 = 1;

    #[link(name = "winuser")]
    extern "system" {
        fn SetWindowDisplayAffinity(hwnd: *mut c_void, dwAffinity: u32) -> i32;
    }

    /// Apply WDA_MONITOR to the window associated with the given HWND pointer.
    /// Returns Ok(()) on success, Err(message) on failure.
    pub fn apply_privacy_affinity(hwnd_ptr: usize) -> Result<(), String> {
        let result = unsafe { SetWindowDisplayAffinity(hwnd_ptr as *mut c_void, WDA_MONITOR) };
        if result == 0 {
            Ok(())
        } else {
            Err(format!("SetWindowDisplayAffinity failed with code {}", result))
        }
    }

    /// Get theHWND of the main window for the current process.
    /// Uses GetForegroundWindow + GetWindowThreadProcessId to find our own HWND.
    pub fn get_main_window_hwnd() -> Option<usize> {
        // Use the Windows API via the `windows` crate feature if available,
        // otherwise fall back to a minimal inline import.
        #[cfg(feature = "windows-hwnd")]
        {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

            let hwnd = unsafe { GetForegroundWindow() };
            if hwnd.0.is_null() {
                return None;
            }
            let mut pid: u32 = 0;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            // Check it's our process
            if pid == std::process::id() {
                Some(hwnd.0 as usize)
            } else {
                None
            }
        }
        #[cfg(not(feature = "windows-hwnd"))]
        {
            // Minimal fallback using winapi directly
            None
        }
    }
}

#[cfg(not(windows))]
mod privacy {
    pub fn apply_privacy_affinity(_hwnd_ptr: usize) -> Result<(), String> {
        Ok(()) // No-op on non-Windows
    }
}

// ---------------------------------------------------------------------------
// Core registration logic
// ---------------------------------------------------------------------------

/// Build the Alt+Space shortcut: Alt + Space
#[cfg(feature = "global-shortcut")]
fn alt_space_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::Space)
}

/// Register Alt+Space as a global shortcut.
/// Emits `toggle-search-overlay` when pressed.
/// Applies privacy affinity on Windows.
#[cfg(feature = "global-shortcut")]
pub async fn register_alt_space<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

    let shortcut = Shortcut::new(Some(Modifiers::ALT), Code::Space);
    let app_handle = app.clone();

    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _scut, event| {
            if event.state == ShortcutState::Pressed {
                tracing::info!("Alt+Space triggered");
                if let Err(e) = app_handle.emit("toggle-search-overlay", ()) {
                    tracing::warn!("emit toggle-search-overlay: {e}");
                }
            }
        })
        .map_err(|e| format!("register global shortcut: {e}"))?;

    ALT_SPACE_REGISTERED.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = save_shortcut_bound(true);

    // Apply privacy affinity on the main window (Windows only)
    #[cfg(windows)]
    {
        if let Some(hwnd) = privacy::get_main_window_hwnd() {
            if let Err(e) = privacy::apply_privacy_affinity(hwnd) {
                tracing::warn!("SetWindowDisplayAffinity: {e}");
            } else {
                tracing::info!("SetWindowDisplayAffinity applied to main window");
            }
        }
    }

    tracing::info!("Alt+Space global shortcut registered");
    Ok(())
}

/// Unregister the Alt+Space global shortcut.
#[cfg(feature = "global-shortcut")]
pub async fn unregister_alt_space<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

    let shortcut = Shortcut::new(Some(Modifiers::ALT), Code::Space);
    app.global_shortcut()
        .unregister(shortcut)
        .map_err(|e| format!("unregister global shortcut: {e}"))?;

    ALT_SPACE_REGISTERED.store(false, std::sync::atomic::Ordering::SeqCst);
    let _ = save_shortcut_bound(false);

    tracing::info!("Alt+Space global shortcut unregistered");
    Ok(())
}

/// Check whether the Alt+Space shortcut is currently registered.
#[cfg(feature = "global-shortcut")]
pub fn is_alt_space_registered() -> bool {
    ALT_SPACE_REGISTERED.load(std::sync::atomic::Ordering::SeqCst)
}

/// Register Alt+Space if in cloud mode and not already registered.
/// Call this after a successful `cloud_login`.
#[cfg(feature = "global-shortcut")]
pub async fn register_if_needed<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if !is_alt_space_registered() {
        register_alt_space(app).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// No-op stubs when global-shortcut feature is disabled
// ---------------------------------------------------------------------------

#[cfg(not(feature = "global-shortcut"))]
pub async fn register_alt_space<R: Runtime>(_app: AppHandle<R>) -> Result<(), String> {
    tracing::warn!("global-shortcut feature not enabled; Alt+Space disabled");
    Ok(())
}

#[cfg(not(feature = "global-shortcut"))]
pub async fn unregister_alt_space<R: Runtime>(_app: AppHandle<R>) -> Result<(), String> {
    Ok(())
}

#[cfg(not(feature = "global-shortcut"))]
pub fn is_alt_space_registered() -> bool {
    false
}

#[cfg(not(feature = "global-shortcut"))]
pub async fn register_if_needed<R: Runtime>(_app: AppHandle<R>) -> Result<(), String> {
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Register the Alt+Space global shortcut (called after cloud login succeeds).
#[tauri::command]
pub async fn register_search_shortcut<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    register_alt_space(app).await
}

/// Unregister the Alt+Space global shortcut (called on logout).
#[tauri::command]
pub async fn unregister_search_shortcut<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    unregister_alt_space(app).await
}

/// Check whether the search shortcut is currently bound.
#[tauri::command]
pub fn is_search_shortcut_bound() -> bool {
    is_alt_space_registered()
}

/// Apply privacy mode (screenshot protection) to the search overlay window.
#[tauri::command]
pub fn apply_search_privacy(hwnd_ptr: usize) -> Result<(), String> {
    privacy::apply_privacy_affinity(hwnd_ptr)
}
