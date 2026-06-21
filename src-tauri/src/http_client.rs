//! Shared HTTP client with connection pooling.
//!
//! Replaces scattered `reqwest::Client::builder()...build()` calls across the
//! codebase with a single, lazily-initialised static client that:
//!   - Enables TCP connection pooling and keep-alive (reqwest default)
//!   - Applies a 30 s read-timeout to all requests
//!   - Is cheap to clone (internally `reqwest::Client` is cheap to clone)

use std::sync::OnceLock;
use reqwest::Client;
use std::time::Duration;

static CLIENT: OnceLock<Client> = OnceLock::new();

/// Returns the shared [`Client`] instance.
pub fn http_client() -> &'static Client {
    CLIENT.get_or_init(|| {
        Client::builder()
            .pool_max_idle_per_host(20)
            .pool_idle_timeout(Duration::from_secs(60))
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build shared reqwest Client")
    })
}
