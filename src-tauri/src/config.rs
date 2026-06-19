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
    /// Cloud server base URL (e.g. `https://feclaw.example.com`).
    /// Only used when `mode == Mode::Cloud`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_url: Option<String>,
    /// Cloud account username — only persisted locally to remember who is
    /// signed in; the password is never stored (it is exchanged for a JWT).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_username: Option<String>,
    /// JWT returned by `POST /api/login` against the cloud server. Persisted
    /// so subsequent launches don't have to re-prompt for credentials.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_token: Option<String>,
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
            cloud_url: None,
            cloud_username: None,
            cloud_token: None,
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

    /// WebSocket URL the engine manager should dial.
    ///
    /// * `Local`  → `ws://{host}:{port}{ws_path}` against the embedded engine.
    /// * `Cloud`  → `{cloud_url}/ws/desktop` against the remote FeClaw server.
    ///              `cloud_url` is required and is normalised so the trailing
    ///              slash is stripped before `/ws/desktop` is appended.
    pub fn ws_url(&self) -> String {
        match self.mode {
            Mode::Local => format!("ws://{}:{}{}", self.host, self.port, self.ws_path),
            Mode::Cloud => {
                let base = self
                    .cloud_url
                    .as_deref()
                    .unwrap_or("https://feclaw.example.com");
                format!("{}/ws/desktop", base.trim_end_matches('/'))
            }
        }
    }

    /// HTTP base URL for the engine (used by `auth.rs` and settings probes).
    /// In cloud mode the same `cloud_url` is reused for `/api/login` and
    /// `/api/health`.
    pub fn cloud_base_url(&self) -> Option<&str> {
        self.cloud_url.as_deref()
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

    #[test]
    fn cloud_ws_url_appends_path() {
        let cfg = Config {
            mode: Mode::Cloud,
            cloud_url: Some("https://feclaw.example.com".to_string()),
            ..Default::default()
        };
        assert_eq!(cfg.ws_url(), "https://feclaw.example.com/ws/desktop");
    }

    #[test]
    fn cloud_ws_url_strips_trailing_slash() {
        let cfg = Config {
            mode: Mode::Cloud,
            cloud_url: Some("https://feclaw.example.com/".to_string()),
            ..Default::default()
        };
        assert_eq!(cfg.ws_url(), "https://feclaw.example.com/ws/desktop");
    }

    #[test]
    fn cloud_ws_url_strips_multiple_trailing_slashes() {
        let cfg = Config {
            mode: Mode::Cloud,
            cloud_url: Some("https://feclaw.example.com///".to_string()),
            ..Default::default()
        };
        assert_eq!(cfg.ws_url(), "https://feclaw.example.com/ws/desktop");
    }

    #[test]
    fn cloud_ws_url_uses_http_when_configured() {
        // Local-network dev servers may be served over plain HTTP.
        let cfg = Config {
            mode: Mode::Cloud,
            cloud_url: Some("http://10.0.0.5:8080".to_string()),
            ..Default::default()
        };
        assert_eq!(cfg.ws_url(), "http://10.0.0.5:8080/ws/desktop");
    }

    #[test]
    fn local_ws_url_unaffected_by_cloud_fields() {
        // cloud_* fields should be ignored in local mode.
        let cfg = Config {
            mode: Mode::Local,
            cloud_url: Some("https://remote.example.com".to_string()),
            cloud_username: Some("alice".to_string()),
            cloud_token: Some("jwt".to_string()),
            ..Default::default()
        };
        assert_eq!(cfg.ws_url(), "ws://127.0.0.1:8080/ws/desktop");
    }

    #[test]
    fn cloud_fields_default_to_none() {
        let cfg = Config::default();
        assert!(cfg.cloud_url.is_none());
        assert!(cfg.cloud_username.is_none());
        assert!(cfg.cloud_token.is_none());
    }

    #[test]
    fn cloud_base_url_returns_set_value() {
        let cfg = Config {
            cloud_url: Some("https://feclaw.example.com".to_string()),
            ..Default::default()
        };
        assert_eq!(cfg.cloud_base_url(), Some("https://feclaw.example.com"));
    }

    #[test]
    fn cloud_token_omitted_from_toml_when_none() {
        // Avoid leaking the field name with `cloud_token = ""` when the user
        // hasn't signed in yet.
        let cfg = Config::default();
        let encoded = toml::to_string(&cfg).unwrap();
        assert!(!encoded.contains("cloud_token"));
        assert!(!encoded.contains("cloud_username"));
    }

    #[test]
    fn toml_roundtrip_cloud_with_credentials() {
        let cfg = Config {
            mode: Mode::Cloud,
            cloud_url: Some("https://feclaw.example.com".to_string()),
            cloud_username: Some("alice".to_string()),
            cloud_token: Some("jwt.payload.sig".to_string()),
            ..Default::default()
        };
        let encoded = toml::to_string(&cfg).unwrap();
        let decoded: Config = toml::from_str(&encoded).unwrap();
        assert_eq!(decoded.mode, Mode::Cloud);
        assert_eq!(
            decoded.cloud_url.as_deref(),
            Some("https://feclaw.example.com")
        );
        assert_eq!(decoded.cloud_username.as_deref(), Some("alice"));
        assert_eq!(decoded.cloud_token.as_deref(), Some("jwt.payload.sig"));
    }
}
