//! Authentication: first-time password extraction + JWT persistence.
//!
//! On the first launch, the engine generates a random admin password and
//! prints it to stdout. Desktop scans the captured stdout, POSTs to
//! `/api/login`, and saves the resulting JWT to
//! `~/.feclaw/local-credentials`. Subsequent launches just read the
//! token from disk (with a quick `/api/me` round-trip to make sure it
//! is still valid).

use crate::config::Config;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Credentials persisted to `~/.feclaw/local-credentials`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Credentials {
    #[serde(default = "default_username")]
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

fn default_username() -> String {
    "admin".to_string()
}

pub struct AuthManager {
    config: Config,
    creds_path: PathBuf,
    client: reqwest::Client,
}

impl AuthManager {
    pub fn new(config: Config) -> Self {
        let creds_path = Config::config_dir().join("local-credentials");
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("build reqwest client");
        Self {
            config,
            creds_path,
            client,
        }
    }

    pub fn credentials_path(&self) -> &PathBuf {
        &self.creds_path
    }

    /// Load existing credentials from disk, if any.
    pub fn load_credentials(&self) -> Option<Credentials> {
        let content = fs::read_to_string(&self.creds_path).ok()?;
        serde_json::from_str(&content).ok()
    }

    /// Persist credentials (password or token) to disk.
    pub fn save_credentials(&self, creds: &Credentials) -> Result<()> {
        if let Some(parent) = self.creds_path.parent() {
            fs::create_dir_all(parent).context("create ~/.feclaw dir")?;
        }
        let json = serde_json::to_string_pretty(creds).context("serialize credentials")?;
        fs::write(&self.creds_path, json).context("write credentials")?;
        Ok(())
    }

    /// Try to load an existing token; if missing/invalid, extract password
    /// from `stdout_buffer` and login. Returns the JWT.
    pub async fn login_or_load(
        &mut self,
        stdout_buffer: Arc<Mutex<Vec<String>>>,
    ) -> Result<String> {
        // 1. Reuse an existing token if it still works.
        if let Some(creds) = self.load_credentials() {
            if let Some(tok) = creds.token.as_deref() {
                if self.verify_token(tok).await {
                    tracing::info!("using existing JWT token");
                    return Ok(tok.to_string());
                }
                tracing::warn!("existing token rejected; re-authenticating");
            }
        }

        // 2. First-time setup: scan engine stdout for the initial password.
        let password = {
            let buf = stdout_buffer
                .lock()
                .map_err(|e| anyhow!("stdout buffer poisoned: {e}"))?;
            Self::extract_password_from_stdout(&buf.join("\n"))
        }
        .ok_or_else(|| {
            anyhow!(
                "could not find initial admin password in engine stdout; \
                 check ~/.feclaw/initial-password or set FECLAW_INITIAL_PASSWORD"
            )
        })?;

        // 3. Login + persist.
        let token = self.login("admin", &password).await?;
        let creds = Credentials {
            username: "admin".to_string(),
            password: Some(password),
            token: Some(token.clone()),
        };
        self.save_credentials(&creds)?;
        tracing::info!("saved new JWT to {}", self.creds_path.display());
        Ok(token)
    }

    /// POST `/api/login` with `username` + `password`, return the JWT.
    pub async fn login(&self, username: &str, password: &str) -> Result<String> {
        let url = format!("{}/api/login", self.config.engine_url());
        let resp = self
            .client
            .post(&url)
            .json(&serde_json::json!({
                "username": username,
                "password": password,
            }))
            .send()
            .await
            .context("POST /api/login")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("login failed: {status} {body}");
        }
        let body: serde_json::Value = resp.json().await.context("parse login response")?;
        let token = body
            .get("token")
            .or_else(|| body.get("access_token"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("no token in login response"))?
            .to_string();
        Ok(token)
    }

    /// Quick `GET /api/me` to verify the JWT is still valid.
    pub async fn verify_token(&self, token: &str) -> bool {
        let url = format!("{}/api/me", self.config.engine_url());
        self.client
            .get(&url)
            .bearer_auth(token)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// Parse engine stdout looking for a random initial admin password.
    ///
    /// Recognised patterns:
    ///   `Initial admin password: <pwd>`
    ///   `password=<pwd>`
    pub fn extract_password_from_stdout(stdout: &str) -> Option<String> {
        for line in stdout.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("Initial admin password:") {
                let pwd = rest.trim();
                if !pwd.is_empty() {
                    return Some(pwd.to_string());
                }
            }
            if let Some(rest) = line.strip_prefix("initial admin password:") {
                let pwd = rest.trim();
                if !pwd.is_empty() {
                    return Some(pwd.to_string());
                }
            }
            if let Some(idx) = line.find("password=") {
                let rest = &line[idx + "password=".len()..];
                let pwd: String = rest
                    .chars()
                    .take_while(|c| !c.is_whitespace() && *c != ',')
                    .collect();
                if !pwd.is_empty() {
                    return Some(pwd);
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_password_known_pattern() {
        let s = "Some line\nInitial admin password: AbCd1234xYz\nOther line";
        assert_eq!(
            AuthManager::extract_password_from_stdout(s),
            Some("AbCd1234xYz".to_string())
        );
    }

    #[test]
    fn extract_password_alt_pattern() {
        let s = "engine: password=Sup3r$ecret ready";
        assert_eq!(
            AuthManager::extract_password_from_stdout(s),
            Some("Sup3r$ecret".to_string())
        );
    }

    #[test]
    fn extract_password_missing() {
        assert!(AuthManager::extract_password_from_stdout("no secrets here").is_none());
    }

    #[test]
    fn extract_password_admin_password_pattern() {
        // "admin password: aB3#kM9$xR7$" → "aB3#kM9$xR7$"
        let s = "server started\n  admin password: aB3#kM9$xR7$\nlistening on 8080";
        assert_eq!(
            AuthManager::extract_password_from_stdout(s),
            Some("aB3#kM9$xR7$".to_string())
        );
    }

    #[test]
    fn extract_password_empty_string() {
        assert!(AuthManager::extract_password_from_stdout("").is_none());
    }

    #[test]
    fn extract_password_no_password_after_colon() {
        // "Initial admin password:   " (empty after colon) → None
        let s = "Initial admin password:   ";
        assert!(AuthManager::extract_password_from_stdout(s).is_none());
    }

    #[test]
    fn extract_password_special_chars_preserved() {
        // Special characters in password should be preserved
        let s = "Initial admin password: P@ssw0rd!#$%^&*()";
        assert_eq!(
            AuthManager::extract_password_from_stdout(s),
            Some("P@ssw0rd!#$%^&*()".to_string())
        );
    }

    #[test]
    fn load_credentials_file_not_found() {
        let cfg = Config {
            host: "127.0.0.1".to_string(),
            port: 8080,
            engine_path: None,
            ws_path: "/ws/desktop".to_string(),
            mode: crate::config::Mode::Local,
        };
        let auth = AuthManager::new(cfg);
        // Use a path that definitely doesn't exist
        let creds = auth.load_credentials();
        assert!(creds.is_none());
    }

    #[test]
    fn credentials_default_username() {
        let creds = Credentials::default();
        assert_eq!(creds.username, "admin");
        assert!(creds.password.is_none());
        assert!(creds.token.is_none());
    }

    #[test]
    fn credentials_serialize_deserialize() {
        let creds = Credentials {
            username: "admin".to_string(),
            password: Some("secret123".to_string()),
            token: Some("jwt.token.here".to_string()),
        };
        let json = serde_json::to_string(&creds).unwrap();
        let parsed: Credentials = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.username, creds.username);
        assert_eq!(parsed.password, creds.password);
        assert_eq!(parsed.token, creds.token);
    }

    #[test]
    fn credentials_skips_none_password_in_json() {
        let creds = Credentials {
            username: "admin".to_string(),
            password: None,
            token: Some("jwt.token".to_string()),
        };
        let json = serde_json::to_string(&creds).unwrap();
        // password should not appear in JSON when None
        assert!(!json.contains("password"));
        assert!(json.contains("token"));
        assert!(json.contains("admin"));
    }
}
