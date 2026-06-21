//! Shared types used across commands.

use serde::{Deserialize, Serialize};

/// Agent info returned by `GET /api/desktop/agents`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub hash: String,
    pub name: String,
    pub description: Option<String>,
    pub avatar_url: Option<String>,
    pub permission_mode: Option<String>,
    pub is_online: bool,
}
