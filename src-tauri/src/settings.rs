//! User-editable settings persisted to `~/.feclaw/settings.json`.
//!
//! Mirrors the structure previously inlined in `tauri.conf.json`. The struct
//! is intentionally `async` for `save` so we never block the runtime when
//! writing to disk on slow filesystems.

use crate::config::Config;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Settings {
    /// Last-selected mode (mirrored from `Config::mode`).
    pub mode: crate::config::Mode,
    /// Tray tooltip override.
    pub tray_tooltip: Option<String>,
    /// Whether to launch at login.
    pub auto_start: bool,
    /// Identifier of the active agent (used to scope WS auth).
    pub active_agent_hash: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            mode: crate::config::Mode::Local,
            tray_tooltip: None,
            auto_start: false,
            active_agent_hash: None,
        }
    }
}

impl Settings {
    pub fn path() -> PathBuf {
        Config::config_dir().join("settings.json")
    }

    pub fn load() -> Self {
        let path = Self::path();
        match std::fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
                tracing::warn!("settings parse error: {e}; using defaults");
                Self::default()
            }),
            Err(_) => {
                let s = Self::default();
                // Best-effort persist of defaults.
                let path = path.clone();
                let s_clone = s.clone();
                tokio::spawn(async move {
                    let _ = s_clone.save().await;
                });
                s
            }
        }
    }

    /// Persist this settings object to disk. Async to avoid blocking the
    /// runtime on slow drives or antivirus scans.
    pub async fn save(&self) -> Result<()> {
        if let Some(parent) = Self::path().parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("create {}", parent.display()))?;
        }
        let json = serde_json::to_string_pretty(self).context("serialize settings")?;
        tokio::fs::write(Self::path(), json)
            .await
            .context("write settings.json")?;
        Ok(())
    }
}
