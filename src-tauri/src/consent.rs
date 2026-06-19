//! Native confirmation dialogs and command risk assessment.
//!
//! When the engine asks Desktop to run a command, we classify it by risk
//! level (L1–L5) and either silently allow (L1) or pop a native dialog.
//! Commands the user has previously trusted are auto-allowed for the
//! rest of the session (and persisted to
//! `~/.feclaw/trusted-commands.json` so they survive restarts).

use crate::config::Config;
use anyhow::Result;
use rfd::{MessageButtons, MessageDialog};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;

/// What the user chose in the consent dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Decision {
    Allow,
    Deny,
    AlwaysAllow,
}

/// Risk classification used to pick a dialog title/colour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RiskLevel {
    L1 = 1, // silent read
    L2 = 2, // write / redirect
    L3 = 3, // delete
    L4 = 4, // network
    L5 = 5, // code execution
}

pub struct ConsentManager {
    session_trust: HashSet<String>,
    trust_file: PathBuf,
}

impl ConsentManager {
    pub fn new() -> Self {
        Self {
            session_trust: HashSet::new(),
            trust_file: Config::config_dir().join("trusted-commands.json"),
        }
    }

    /// Read the persistent trusted-commands file into the session cache.
    pub fn load_trusted(&mut self) {
        match std::fs::read_to_string(&self.trust_file) {
            Ok(content) => match serde_json::from_str::<Vec<String>>(&content) {
                Ok(list) => {
                    for cmd in list {
                        self.session_trust.insert(cmd);
                    }
                    tracing::info!(
                        "loaded {} trusted commands from {}",
                        self.session_trust.len(),
                        self.trust_file.display()
                    );
                }
                Err(e) => tracing::warn!("trusted-commands.json parse error: {e}"),
            },
            Err(_) => {
                // No file yet — that's fine.
            }
        }
    }

    /// Persist the session trust list to disk.
    fn save_trusted(&self) -> Result<()> {
        if let Some(parent) = self.trust_file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut list: Vec<&String> = self.session_trust.iter().collect();
        list.sort();
        let json = serde_json::to_string_pretty(&list)?;
        std::fs::write(&self.trust_file, json)?;
        Ok(())
    }

    /// Heuristic risk assessment. Inspects the first whitespace-delimited
    /// token and a few substring patterns. Conservative by design — when
    /// in doubt, fall back to L1 (lowest).
    pub fn assess_risk(command: &str) -> RiskLevel {
        let cmd = command.trim().to_lowercase();
        let first_token = cmd.split_whitespace().next().unwrap_or("");

        // L5: interpreted code execution.
        if matches!(
            first_token,
            "python" | "python3" | "python2" | "node" | "deno" | "bun" | "ruby" | "perl"
        ) {
            return RiskLevel::L5;
        }
        if first_token == "bash" || first_token == "sh" || first_token == "zsh" {
            return RiskLevel::L5;
        }
        if first_token == "powershell" || first_token == "pwsh" || first_token == "cmd" {
            return RiskLevel::L5;
        }

        // L4: outbound network.
        if matches!(first_token, "curl" | "wget" | "http" | "https" | "nc" | "ncat") {
            return RiskLevel::L4;
        }

        // L3: deletion.
        if matches!(first_token, "rm" | "rmdir" | "del" | "erase") {
            return RiskLevel::L3;
        }

        // L2: writes / redirects / filesystem mutation.
        if matches!(first_token, "cp" | "mv" | "mkdir" | "touch" | "tee" | "install") {
            return RiskLevel::L2;
        }
        if cmd.contains(">>") || cmd.contains('>') || cmd.contains(" 2>") {
            return RiskLevel::L2;
        }

        // L1: read-only / safe.
        RiskLevel::L1
    }

    /// Ask the user for permission to run `command`.
    ///
    /// Behaviour:
    ///   * L1 → silently [`Decision::Allow`].
    ///   * L2–L5 → if the exact command is in `session_trust`, return
    ///     [`Decision::AlwaysAllow`] without showing a dialog.
    ///   * Otherwise show a native dialog. We use Yes/No/Cancel where
    ///     **Yes** = allow once, **No** = deny, **Cancel** = always allow.
    ///
    /// `cwd` is included in the dialog description so the user knows where
    /// the command will run (and that it will be created if missing).
    pub async fn request(&mut self, command: &str, cwd: Option<&str>) -> Decision {
        let risk = Self::assess_risk(command);

        if risk == RiskLevel::L1 {
            return Decision::Allow;
        }
        if self.session_trust.contains(command) {
            return Decision::AlwaysAllow;
        }

        let title = match risk {
            RiskLevel::L5 => "FeClaw Desktop — Code execution (L5)",
            RiskLevel::L4 => "FeClaw Desktop — Network request (L4)",
            RiskLevel::L3 => "FeClaw Desktop — Deletion (L3)",
            RiskLevel::L2 => "FeClaw Desktop — Write / redirect (L2)",
            RiskLevel::L1 => "FeClaw Desktop",
        };

        let cwd_info = match cwd {
            Some(path) => format!(
                "\n\nWorking directory: {path}\n(will be created automatically if it doesn't exist)"
            ),
            None => String::new(),
        };
        let body = format!(
            "Agent wants to run:\n\n  {command}{cwd_info}\n\n\
             Risk level: L{}\n\n\
             [Yes] Allow once\n\
             [No]  Deny\n\
             [Cancel] Always allow this command",
            risk as u8
        );

        let title = title.to_string();
        let body = body.to_string();
        let dialog = MessageDialog::new()
            .set_title(&title)
            .set_description(&body)
            .set_buttons(MessageButtons::YesNoCancel);

        // rfd dialogs are blocking; offload so we don't stall the runtime.
        let result = tokio::task::spawn_blocking(move || dialog.show()).await;

        let decision = match result {
            Ok(rfd::MessageDialogResult::Yes) => Decision::Allow,
            Ok(rfd::MessageDialogResult::No) => Decision::Deny,
            Ok(rfd::MessageDialogResult::Cancel) | Ok(rfd::MessageDialogResult::Other) => {
                // Add to session trust immediately (in-memory).
                self.session_trust.insert(command.to_string());
                if let Err(e) = self.save_trusted() {
                    // Persistence failed: command stays in session_trust (re-prompt next
                    // session) but warn the user so they know it won't survive restart.
                    tracing::warn!(
                        "failed to persist trusted-commands.json: {e:#}; \
                         will re-prompt after restart"
                    );
                }
                Decision::AlwaysAllow
            }
            Ok(_) => Decision::Deny, // OK / Close → deny for safety
            Err(e) => {
                tracing::error!("consent dialog error: {e}");
                Decision::Deny
            }
        };
        decision
    }
}

impl Default for ConsentManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn risk_assessment_examples() {
        assert_eq!(ConsentManager::assess_risk("ls -la"), RiskLevel::L1);
        assert_eq!(ConsentManager::assess_risk("cat foo.txt"), RiskLevel::L1);
        assert_eq!(ConsentManager::assess_risk("echo hi > out.txt"), RiskLevel::L2);
        assert_eq!(ConsentManager::assess_risk("rm -rf build"), RiskLevel::L3);
        assert_eq!(ConsentManager::assess_risk("curl https://x"), RiskLevel::L4);
        assert_eq!(ConsentManager::assess_risk("python3 analyze.py"), RiskLevel::L5);
        assert_eq!(ConsentManager::assess_risk("bash script.sh"), RiskLevel::L5);
    }

    #[test]
    fn assess_risk_python3_analyze() {
        // python3 analyze.py → L5
        assert_eq!(ConsentManager::assess_risk("python3 analyze.py"), RiskLevel::L5);
    }

    #[test]
    fn assess_risk_rm_rf_temp() {
        // rm -rf /temp → L3
        assert_eq!(ConsentManager::assess_risk("rm -rf /temp"), RiskLevel::L3);
    }

    #[test]
    fn assess_risk_curl() {
        // curl http://x.com → L4
        assert_eq!(ConsentManager::assess_risk("curl http://x.com"), RiskLevel::L4);
    }

    #[test]
    fn assess_risk_wget() {
        // wget http://x.com → L4
        assert_eq!(ConsentManager::assess_risk("wget http://x.com"), RiskLevel::L4);
    }

    #[test]
    fn assess_risk_ls() {
        // ls . → L1
        assert_eq!(ConsentManager::assess_risk("ls ."), RiskLevel::L1);
    }

    #[test]
    fn assess_risk_cat() {
        // cat file.txt → L1
        assert_eq!(ConsentManager::assess_risk("cat file.txt"), RiskLevel::L1);
    }

    #[test]
    fn assess_risk_echo_redirect() {
        // echo hello > file.txt → L2
        assert_eq!(ConsentManager::assess_risk("echo hello > file.txt"), RiskLevel::L2);
    }

    #[test]
    fn assess_risk_cp() {
        // cp a b → L2
        assert_eq!(ConsentManager::assess_risk("cp a b"), RiskLevel::L2);
    }

    #[test]
    fn assess_risk_mv() {
        // mv a b → L2
        assert_eq!(ConsentManager::assess_risk("mv a b"), RiskLevel::L2);
    }

    #[test]
    fn assess_risk_empty_string() {
        // empty string → L1
        assert_eq!(ConsentManager::assess_risk(""), RiskLevel::L1);
    }

    #[test]
    fn assess_risk_python3_with_path_args() {
        // python3 test.py --input /mnt/desktop/data.csv → L5 (path不影响风险判定)
        assert_eq!(
            ConsentManager::assess_risk("python3 test.py --input /mnt/desktop/data.csv"),
            RiskLevel::L5
        );
    }

    #[test]
    fn assess_risk_node_interpreter() {
        // node run.js → L5
        assert_eq!(ConsentManager::assess_risk("node run.js"), RiskLevel::L5);
    }

    #[test]
    fn assess_risk_powershell() {
        // powershell -Command → L5
        assert_eq!(ConsentManager::assess_risk("powershell -Command"), RiskLevel::L5);
    }

    #[test]
    fn assess_risk_redirect_stderr() {
        // cmd 2> file → L2
        assert_eq!(ConsentManager::assess_risk("cmd 2> err.log"), RiskLevel::L2);
    }

    #[test]
    fn assess_risk_append_redirect() {
        // echo >> file → L2
        assert_eq!(ConsentManager::assess_risk("echo world >> file.txt"), RiskLevel::L2);
    }

    #[test]
    fn assess_risk_mkdir() {
        // mkdir → L2
        assert_eq!(ConsentManager::assess_risk("mkdir /tmp/dir"), RiskLevel::L2);
    }

    #[test]
    fn assess_risk_touch() {
        // touch → L2
        assert_eq!(ConsentManager::assess_risk("touch file.txt"), RiskLevel::L2);
    }

    #[test]
    fn assess_risk_whitespace_only() {
        // whitespace-only → L1
        assert_eq!(ConsentManager::assess_risk("   "), RiskLevel::L1);
    }
}
