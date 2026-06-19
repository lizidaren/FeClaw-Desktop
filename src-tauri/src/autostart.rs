//! Cross-platform "launch on login" support.
//!
//! Wraps `auto-launch` 0.5 with `AutoLaunchBuilder` so the platform-specific
//! parameter shape (Linux `&[&str]`, macOS `bool` use_launch_agent, Windows
//! `Option<&[&str]>`) is hidden from callers.

use anyhow::Result;
use auto_launch::{AutoLaunch, AutoLaunchBuilder};

/// Identifier used by the OS to recognise the autostart entry.
const APP_NAME: &str = "FeClaw Desktop";

/// CLI flag passed to the engine when launched at login.
const ARGS: &[&str] = &["--minimized"];

pub struct AutoStart {
    inner: AutoLaunch,
}

impl AutoStart {
    /// Build an `AutoLaunch` instance pointed at the current executable.
    pub fn new() -> Result<Self> {
        let exe = std::env::current_exe()?;
        let inner = AutoLaunchBuilder::new()
            .set_app_name(APP_NAME)
            .set_app_path(exe.to_string_lossy().as_ref())
            .set_args(ARGS)
            .set_use_launch_agent(true) // macOS only, ignored elsewhere
            .build()
            .map_err(|e| anyhow::anyhow!("build AutoLaunch: {e}"))?;
        Ok(Self { inner })
    }

    pub fn enable(&self) -> Result<()> {
        self.inner.enable().map_err(|e| anyhow::anyhow!("enable: {e}"))
    }

    pub fn disable(&self) -> Result<()> {
        self.inner.disable().map_err(|e| anyhow::anyhow!("disable: {e}"))
    }

    pub fn is_enabled(&self) -> Result<bool> {
        self.inner.is_enabled().map_err(|e| anyhow::anyhow!("is_enabled: {e}"))
    }
}
