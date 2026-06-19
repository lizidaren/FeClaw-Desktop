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

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
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

    #[test]
    fn default_values() {
        let cfg = Config::default();
        assert_eq!(cfg.host, "127.0.0.1");
        assert_eq!(cfg.port, 8080);
        assert_eq!(cfg.mode, Mode::Local);
    }

    #[test]
    fn ws_url_custom_host_port() {
        let cfg = Config {
            host: "192.168.1.100".to_string(),
            port: 9000,
            ..Default::default()
        };
        assert_eq!(cfg.ws_url(), "ws://192.168.1.100:9000/ws/desktop");
    }

    #[test]
    fn engine_url_custom_host_port() {
        let cfg = Config {
            host: "192.168.1.100".to_string(),
            port: 9000,
            ..Default::default()
        };
        assert_eq!(cfg.engine_url(), "http://192.168.1.100:9000");
    }

    #[test]
    fn toml_roundtrip_local_mode() {
        let cfg = Config::default();
        let encoded = toml::to_string(&cfg).unwrap();
        let decoded: Config = toml::from_str(&encoded).unwrap();
        assert_eq!(decoded.host, cfg.host);
        assert_eq!(decoded.port, cfg.port);
        assert_eq!(decoded.mode, cfg.mode);
        assert_eq!(decoded.ws_path, cfg.ws_path);
    }

    #[test]
    fn toml_roundtrip_cloud_mode() {
        let cfg = Config {
            mode: Mode::Cloud,
            host: "engine.example.com".to_string(),
            port: 443,
            engine_path: Some("/usr/bin/feclaw".to_string()),
            ws_path: "/ws/cloud".to_string(),
        };
        let encoded = toml::to_string(&cfg).unwrap();
        let decoded: Config = toml::from_str(&encoded).unwrap();
        assert_eq!(decoded.mode, Mode::Cloud);
        assert_eq!(decoded.host, "engine.example.com");
        assert_eq!(decoded.port, 443);
        assert_eq!(decoded.engine_path, Some("/usr/bin/feclaw".to_string()));
        assert_eq!(decoded.ws_path, "/ws/cloud");
    }

    #[test]
    fn mode_serde_lowercase() {
        // Mode must serialize as "local" / "cloud" (lowercase, per #[serde(rename_all = "lowercase")]).
        let local: Mode = Mode::Local;
        let cloud: Mode = Mode::Cloud;
        let local_str = toml::to_string(&local).unwrap();
        let cloud_str = toml::to_string(&cloud).unwrap();
        assert_eq!(local_str, "\"local\"");
        assert_eq!(cloud_str, "\"cloud\"");
    }

    #[test]
    fn config_dir_is_home_feclaw() {
        let dir = Config::config_dir();
        let expected = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(|h| PathBuf::from(h).join(".feclaw"))
            .unwrap();
        assert_eq!(dir, expected);
    }

    #[test]
    fn config_path_is_home_feclaw_config_toml() {
        let path = Config::config_path();
        let expected = Config::config_dir().join("config.toml");
        assert_eq!(path, expected);
    }
}
