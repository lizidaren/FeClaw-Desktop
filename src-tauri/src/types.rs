//! Shared types used across commands.

use serde::{Deserialize, Serialize};

/// Agent info returned by `GET /api/desktop/agents`.
/// Note: Engine returns snake_case JSON fields, so we do NOT
/// use rename_all = "camelCase" here.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub hash: String,
    pub name: String,
    pub description: Option<String>,
    pub avatar_url: Option<String>,
    pub permission_mode: Option<String>,
    /// Engine returns `status` ("pending", "active", etc.) — we map it to
    /// `is_online` for convenience. Defaults to false when field is absent.
    #[serde(default)]
    pub is_online: bool,
    /// Agent configuration status ("pending" = not configured, "active" = configured).
    pub status: Option<String>,
}
