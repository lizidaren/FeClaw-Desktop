//! Configuration management for FeClaw Desktop.
//!
//! Reads/writes `~/.feclaw/config.toml`. Provides default port (8080) and
//! automatic port scanning (8080-8089) when the default is in use.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::net::TcpListener;
use std::path::PathBuf;

/// Top-level FeClaw Desktop configuration persisted to `~/.feclaw/config.toml`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub port: u16,
    pub host: String,
    pub engine_path: Option<String>,
    pub ws_path: String,
    pub mode: Mode,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Local,
    Cloud,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: 8080,
            host: "127.0.0.1".to_string(),
            engine_path: None,
            ws_path: "/ws/desktop".to_string(),
            mode: Mode::Local,
        }
    }
}

impl Config {
    /// `~/.feclaw` directory (or `%USERPROFILE%\.feclaw` on Windows).
    pub fn config_dir() -> PathBuf {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        home.join(".feclaw")
    }

    /// Path to the persisted `config.toml` file.
    pub fn config_path() -> PathBuf {
        Self::config_dir().join("config.toml")
    }

    /// Load configuration from disk, falling back to (and persisting) defaults
    /// if the file is missing or unparseable.
    pub fn load() -> Self {
        let path = Self::config_path();
        match fs::read_to_string(&path) {
            Ok(content) => match toml::from_str::<Config>(&content) {
                Ok(cfg) => cfg,
                Err(e) => {
                    tracing::warn!("failed to parse {}: {e}; using defaults", path.display());
                    Self::default()
                }
            },
            Err(_) => {
                let cfg = Self::default();
                if let Err(e) = cfg.save() {
                    tracing::warn!("failed to write default config: {e:#}");
                }
                cfg
            }
        }
    }

    /// Persist this configuration to `~/.feclaw/config.toml`.
    pub fn save(&self) -> Result<()> {
        let dir = Self::config_dir();
        fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
        let content = toml::to_string_pretty(self).context("serialize config")?;
        fs::write(Self::config_path(), content).context("write config.toml")?;
        Ok(())
    }

    /// `http://host:port` URL for the engine REST API.
    pub fn engine_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    /// `ws://host:port/ws/desktop` URL for the engine WebSocket endpoint.
    pub fn ws_url(&self) -> String {
        format!("ws://{}:{}{}", self.host, self.port, self.ws_path)
    }

    /// Find a free port starting at `start`, scanning `start..start+10`.
    /// Returns `None` if every port in the range is busy.
    pub fn find_free_port(start: u16) -> Option<u16> {
        (start..start.saturating_add(10)).find(|port| {
            TcpListener::bind(("127.0.0.1", *port)).is_ok()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_engine_url() {
        let cfg = Config::default();
        assert_eq!(cfg.engine_url(), "http://127.0.0.1:8080");
        assert_eq!(cfg.ws_url(), "ws://127.0.0.1:8080/ws/desktop");
    }

    #[test]
    fn find_free_port_returns_some() {
        // Port 0 is special; just ensure we get *something* back from a valid range.
        let p = Config::find_free_port(49052);
        assert!(p.is_some());
    }
}
