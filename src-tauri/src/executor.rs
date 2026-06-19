//! Subprocess execution.
//!
//! Spawns the command via `tokio::process::Command`, captures stdout/stderr,
//! enforces a configurable timeout, and truncates over-long output so a
//! runaway command can't blow up our WebSocket frame.

use anyhow::Result;
use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const DEFAULT_TIMEOUT_SECS: u64 = 300;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024; // 1 MiB

/// Outcome of a single command execution.
#[derive(Debug, Clone, Serialize)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

pub struct CommandExecutor {
    default_timeout: Duration,
}

impl CommandExecutor {
    pub fn new() -> Self {
        Self {
            default_timeout: Duration::from_secs(DEFAULT_TIMEOUT_SECS),
        }
    }

    pub fn with_timeout(timeout: Duration) -> Self {
        Self {
            default_timeout: timeout,
        }
    }

    /// Run `command` with `args` in `cwd`. If `cwd` doesn't exist, we try
    /// to create it (a sibling path or an explicit mkdir) before giving up.
    pub async fn execute(
        &self,
        command: &str,
        args: &[String],
        cwd: &Path,
        timeout_secs: Option<u64>,
    ) -> ExecResult {
        let timeout = timeout_secs
            .map(Duration::from_secs)
            .unwrap_or(self.default_timeout);

        if !cwd.exists() {
            if let Err(e) = tokio::fs::create_dir_all(cwd).await {
                return ExecResult {
                    stdout: String::new(),
                    stderr: format!(
                        "failed to create cwd {}: {e}",
                        cwd.display()
                    ),
                    exit_code: -1,
                };
            }
        }

        let mut cmd = Command::new(command);
        cmd.args(args)
            .current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .kill_on_drop(true);

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return ExecResult {
                    stdout: String::new(),
                    stderr: format!("failed to spawn {command}: {e}"),
                    exit_code: -1,
                };
            }
        };

        let timeout_at = tokio::time::sleep(timeout);
        tokio::pin!(timeout_at);

        let mut stdout_pipe = child.stdout.take();
        let mut stderr_pipe = child.stderr.take();

        let stdout_fut = async {
            let mut buf = Vec::with_capacity(4096);
            if let Some(pipe) = stdout_pipe.as_mut() {
                let _ = pipe.read_to_end(&mut buf).await;
            }
            buf
        };
        let stderr_fut = async {
            let mut buf = Vec::with_capacity(4096);
            if let Some(pipe) = stderr_pipe.as_mut() {
                let _ = pipe.read_to_end(&mut buf).await;
            }
            buf
        };
        tokio::pin!(stdout_fut);
        tokio::pin!(stderr_fut);

        let (status, stdout_bytes, stderr_bytes) = tokio::select! {
            _ = &mut timeout_at => {
                let _ = child.start_kill();
                // Drain whatever the process wrote before it dies.
                let _ = child.wait().await;
                let stdout = stdout_fut.await;
                let stderr = stderr_fut.await;
                (None, stdout, stderr)
            }
            res = child.wait() => {
                let status = res.ok();
                let stdout = stdout_fut.await;
                let stderr = stderr_fut.await;
                (status, stdout, stderr)
            }
        };

        let mut stdout = String::from_utf8_lossy(&stdout_bytes).into_owned();
        let mut stderr = String::from_utf8_lossy(&stderr_bytes).into_owned();
        truncate_output(&mut stdout, MAX_OUTPUT_BYTES);
        truncate_output(&mut stderr, MAX_OUTPUT_BYTES);

        let exit_code = match status.and_then(|s| s.code()) {
            Some(c) => c,
            None => 124, // standard "command timed out" code
        };

        ExecResult {
            stdout,
            stderr,
            exit_code,
        }
    }
}

impl Default for CommandExecutor {
    fn default() -> Self {
        Self::new()
    }
}

fn truncate_output(s: &mut String, max: usize) {
    if s.len() > max {
        s.truncate(max);
        s.push_str("\n... [output truncated]");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[tokio::test]
    async fn execute_echo() {
        let exec = CommandExecutor::new();
        let result = exec
            .execute(
                if cfg!(windows) { "cmd" } else { "echo" },
                if cfg!(windows) {
                    &["/C", "echo", "hello"]
                        .into_iter()
                        .map(String::from)
                        .collect::<Vec<_>>()
                } else {
                    &[String::from("hello")]
                },
                &PathBuf::from("."),
                Some(5),
            )
            .await;
        assert_eq!(result.exit_code, 0);
        assert!(result.stdout.contains("hello"));
    }
}
