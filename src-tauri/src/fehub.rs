//! FeHub mini-program management.
//!
//! Manages publishing and browsing of FeHub mini-programs (miniapps).
//! Calls the Engine's `/api/fehub/apps` endpoint to list published apps.

use crate::auth::load_local_token;
use crate::config::Config;
use serde::{Deserialize, Serialize};

/// Build an HTTP client.
fn build_client() -> Result<reqwest::Client, String> {
    Ok(crate::http_client::http_client().clone())
}

fn engine_url() -> String {
    let config = Config::load();
    config.engine_url()
}

// ---- Data types -----------------------------------------------------

/// Information about a published miniapp.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishInfo {
    pub id: String,
    #[serde(rename = "agent_hash")]
    pub agent_hash: String,
    #[serde(rename = "app_name")]
    pub app_name: String,
    pub tag: String,
    #[serde(rename = "is_public")]
    pub is_public: bool,
    #[serde(rename = "created_at")]
    pub created_at: u64,
}

// ---- Tauri commands --------------------------------------------------

/// List all miniapps published by the current user.
#[tauri::command]
pub async fn list_my_publishes() -> Result<Vec<PublishInfo>, String> {
    let token = load_local_token().ok_or_else(|| "no token in credentials file".to_string())?;
    let url = format!("{}/api/fehub/apps", engine_url());
    let resp = build_client()?
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("list_my_publishes request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "list_my_publishes failed: {}",
            resp.status()
        ));
    }
    let publishes: Vec<PublishInfo> = resp
        .json()
        .await
        .map_err(|e| format!("parse list_my_publishes response: {e}"))?;
    Ok(publishes)
}

/// Open a miniapp by creating a new Tauri WebviewWindow.
/// Cloud: https://{agent_hash}.feclaw.lizidaren.cn/apps/{app_name}/
/// Local: http://127.0.0.1:{port}/apps/{app_name}/
#[tauri::command]
pub async fn open_miniapp<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    app_name: String,
) -> Result<(), String> {
    use tauri::WebviewUrl;
    use tauri::WebviewWindowBuilder;

    let publishes = list_my_publishes()
        .await
        .map_err(|e| format!("获取应用信息失败：{e}"))?;

    let info = publishes
        .iter()
        .find(|p| p.app_name == app_name)
        .ok_or_else(|| format!("未找到应用：{}", app_name))?;

    let config = Config::load();
    let url = if config.mode == crate::config::Mode::Local {
        let port = config.port;
        format!("http://127.0.0.1:{}/apps/{}/", port, app_name)
    } else {
        format!(
            "https://{}.feclaw.lizidaren.cn/apps/{}/",
            info.agent_hash, app_name
        )
    };

    let label = format!("miniapp-{}", app_name.replace(['/', ' '], "-"));

    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url.parse().unwrap()))
        .title(&app_name)
        .inner_size(800.0, 600.0)
        .center()
        .build()
        .map_err(|e| format!("打开小程序窗口失败：{e}"))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---------------------------------------------------------------------------
    // PublishInfo — full deserialization
    // ---------------------------------------------------------------------------

    #[test]
    fn publish_info_deserialize_full() {
        let json = r#"{
            "id": "pub-001",
            "agent_hash": "a1b2c3d4",
            "app_name": "my-miniapp",
            "tag": "productivity",
            "is_public": true,
            "created_at": 1700000000
        }"#;
        let p: PublishInfo = serde_json::from_str(json).unwrap();
        assert_eq!(p.id, "pub-001");
        assert_eq!(p.agent_hash, "a1b2c3d4");
        assert_eq!(p.app_name, "my-miniapp");
        assert_eq!(p.tag, "productivity");
        assert!(p.is_public);
        assert_eq!(p.created_at, 1700000000);
    }

    // ---------------------------------------------------------------------------
    // PublishInfo — non-public flag
    // ---------------------------------------------------------------------------

    #[test]
    fn publish_info_is_public_false() {
        let json = r#"{
            "id": "pub-002",
            "agent_hash": "x1y2",
            "app_name": "private-app",
            "tag": "test",
            "is_public": false,
            "created_at": 1700001000
        }"#;
        let p: PublishInfo = serde_json::from_str(json).unwrap();
        assert!(!p.is_public);
    }

    // ---------------------------------------------------------------------------
    // PublishInfo — missing optional tag
    // ---------------------------------------------------------------------------

    #[test]
    fn publish_info_tag_missing() {
        // tag is a required String, not Option
        let json = r#"{
            "id": "pub-003",
            "agent_hash": "hash3",
            "app_name": "no-tag-app",
            "is_public": true,
            "created_at": 1700002000
        }"#;
        let result: Result<PublishInfo, _> = serde_json::from_str(json);
        assert!(result.is_err());
    }

    // ---------------------------------------------------------------------------
    // PublishInfo — round-trip
    // ---------------------------------------------------------------------------

    #[test]
    fn publish_info_roundtrip() {
        let p = PublishInfo {
            id: "pub-round".to_string(),
            agent_hash: "round-hash".to_string(),
            app_name: "roundtrip-app".to_string(),
            tag: "utilities".to_string(),
            is_public: false,
            created_at: 1700012345,
        };
        let json = serde_json::to_string(&p).unwrap();
        let parsed: PublishInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, p);
    }

    #[test]
    fn publish_info_public_roundtrip() {
        let p = PublishInfo {
            id: "pub-public".to_string(),
            agent_hash: "public-hash".to_string(),
            app_name: "public-app".to_string(),
            tag: "social".to_string(),
            is_public: true,
            created_at: 1700020000,
        };
        let json = serde_json::to_string(&p).unwrap();
        let parsed: PublishInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.is_public, true);
    }

    // ---------------------------------------------------------------------------
    // PublishInfo — debug and clone
    // ---------------------------------------------------------------------------

    #[test]
    fn publish_info_debug() {
        let p = PublishInfo {
            id: "pub-debug".to_string(),
            agent_hash: "dbg".to_string(),
            app_name: "debug-app".to_string(),
            tag: "dev".to_string(),
            is_public: false,
            created_at: 0,
        };
        let debug = format!("{:?}", p);
        assert!(debug.contains("pub-debug"));
        assert!(debug.contains("debug-app"));
    }

    #[test]
    fn publish_info_clone() {
        let p = PublishInfo {
            id: "pub-clone".to_string(),
            agent_hash: "clone-hash".to_string(),
            app_name: "clone-app".to_string(),
            tag: "clone".to_string(),
            is_public: true,
            created_at: 1,
        };
        let _cloned = p.clone();
        assert_eq!(cloned.id, "pub-clone");
    }
}
