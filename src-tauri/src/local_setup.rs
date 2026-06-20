//! Local-mode setup wizard (Plan C).
//!
//! Guides the user through cloning, configuring, and starting a local FeClaw
//! engine instance. Exposed as Tauri commands consumed by
//! `local_setup/index.html` via `window.__TAURI__.core.invoke()`.

use std::path::PathBuf;
use std::process::Command;

/// Check whether `git` is available on the host.
#[tauri::command]
pub fn check_git_installed() -> bool {
    Command::new("git")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Check whether Python 3.11+ is available.
///
/// Returns the version string on success (e.g. `"3.12.3"`), or an error
/// message when Python is missing or too old.
#[tauri::command]
pub fn check_python_version() -> Result<String, String> {
    let output = Command::new("python3")
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("无法运行 python3：{e}"))?;

    let raw = String::from_utf8_lossy(
        if output.stdout.is_empty() {
            &output.stderr
        } else {
            &output.stdout
        },
    )
    .trim()
    .to_string();

    // "Python 3.12.3" → "3.12.3"
    let version = raw
        .strip_prefix("Python ")
        .map(str::trim)
        .map(str::to_string)
        .unwrap_or(raw);

    // Parse major.minor — reject < 3.11
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() < 2 {
        return Err(format!("无法解析 Python 版本：{version}"));
    }
    let major: u32 = parts[0]
        .parse()
        .map_err(|_| format!("无法解析 Python 主版本号：{version}"))?;
    let minor: u32 = parts[1]
        .parse()
        .map_err(|_| format!("无法解析 Python 次版本号：{version}"))?;
    if major < 3 || (major == 3 && minor < 11) {
        return Err(format!(
            "Python 版本过低（{version}），需要 3.11 或更高版本"
        ));
    }
    Ok(version)
}

/// Clone the FeClaw engine repository into `{dest}/FeClaw`.
#[tauri::command]
pub fn clone_feclaw(dest: String) -> Result<(), String> {
    let dest_path = PathBuf::from(&dest);
    let feclaw_path = dest_path.join("FeClaw");

    if feclaw_path.exists() {
        return Err(format!(
            "目标目录已存在：{}",
            feclaw_path.display()
        ));
    }

    // Ensure parent exists.
    if let Some(parent) = feclaw_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建目录 {} 失败：{e}", parent.display()))?;
    }

    let status = Command::new("git")
        .arg("clone")
        .arg("https://github.com/lizidaren/FeClaw.git")
        .arg(&feclaw_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .status()
        .map_err(|e| format!("执行 git clone 失败：{e}"))?;

    if !status.success() {
        return Err("git clone 失败，请检查网络连接和仓库地址".to_string());
    }
    Ok(())
}

/// Expand `~` (and `~user`) in a path string.
fn expand_tilde(path: &str) -> PathBuf {
    if path.starts_with('~') {
        if let Some(home) = dirs::home_dir() {
            if path == "~" {
                return home;
            }
            if let Some(rest) = path.strip_prefix("~/") {
                return home.join(rest);
            }
        }
    }
    PathBuf::from(path)
}

/// Read the `FeClaw/.env.example` template, substitute placeholders with
/// reasonable defaults, and return the generated `.env` content.
#[tauri::command]
pub async fn generate_env_template(
    dest: String,
    api_key: String,
    jwt_secret: String,
    admin_password: String,
) -> Result<String, String> {
    let dest_path = expand_tilde(&dest);
    let template_path = dest_path.join("FeClaw").join(".env.example");

    let template = tokio::fs::read_to_string(&template_path)
        .await
        .map_err(|e| format!("读取 .env.example 失败：{e}"))?;

    let mut result = template.replace("YOUR_API_KEY", &api_key);
    result = result.replace("YOUR_JWT_SECRET", &jwt_secret);
    result = result.replace("YOUR_ADMIN_PASSWORD", &admin_password);

    // Also handle common placeholder patterns.
    result = result.replace("your_api_key_here", &api_key);
    result = result.replace("your_jwt_secret_here", &jwt_secret);
    result = result.replace("your_admin_password_here", &admin_password);
    result = result.replace("changeme", &admin_password);
    result = result.replace("change_me", &admin_password);

    Ok(result)
}

/// Write the generated `.env` content to `{dest}/FeClaw/.env`.
#[tauri::command]
pub fn write_env_file(dest: String, content: String) -> Result<(), String> {
    let dest_path = expand_tilde(&dest);
    let env_path = dest_path.join("FeClaw").join(".env");

    std::fs::write(&env_path, content)
        .map_err(|e| format!("写入 .env 文件失败：{e}"))?;
    Ok(())
}

/// Install Python dependencies via pip.
///
/// Returns stdout progress lines as a string.
#[tauri::command]
pub async fn install_dependencies(dest: String) -> Result<String, String> {
    let dest_path = expand_tilde(&dest);
    let requirements = dest_path.join("FeClaw").join("requirements.txt");

    if !requirements.exists() {
        return Err(format!(
            "未找到 requirements.txt：{}",
            requirements.display()
        ));
    }

    let output = Command::new("pip")
        .arg("install")
        .arg("-r")
        .arg(&requirements)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("执行 pip install 失败：{e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = format!("{stdout}\n{stderr}").trim().to_string();

    if !output.status.success() {
        return Err(format!("pip install 失败：\n{combined}"));
    }
    Ok(combined)
}

/// Start the FeClaw engine process.
///
/// Returns the admin password (extracted from engine output or falls back
/// to the default `"admin"`).
#[tauri::command]
pub async fn start_feclaw(dest: String, port: u16) -> Result<String, String> {
    let dest_path = expand_tilde(&dest);
    let feclaw_path = dest_path.join("FeClaw");

    if !feclaw_path.exists() {
        return Err(format!("引擎目录不存在：{}", feclaw_path.display()));
    }

    // Kill any existing process on the target port.
    let _ = Command::new("bash")
        .arg("-c")
        .arg(format!(
            "lsof -ti:{port} 2>/dev/null | xargs -r kill -9 2>/dev/null"
        ))
        .status();

    // Start the engine in the background.
    let child = Command::new("bash")
        .arg("-c")
        .arg(format!(
            "cd '{}' && nohup python3 -m uvicorn main:app --host 0.0.0.0 --port {port} > /tmp/feclaw-engine.log 2>&1 &",
            feclaw_path.display(),
            port
        ))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("启动引擎失败：{e}"))?;

    // The bash -c spawns a background process and exits immediately.
    let _ = child.wait_with_output();

    // Wait a moment for the engine to start.
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    // Try to read admin password from engine startup output.
    let log_content = tokio::fs::read_to_string("/tmp/feclaw-engine.log")
        .await
        .unwrap_or_default();

    // Look for common admin-password patterns in the log:
    // "Admin password: xxx", "ADMIN_PASSWORD=xxx", etc.
    for line in log_content.lines() {
        let lower = line.to_lowercase();
        if lower.contains("admin password") || lower.contains("admin_password") {
            // Try to extract after ":" or "=".
            if let Some(idx) = line.find(':').or_else(|| line.find('=')) {
                let candidate = line[idx + 1..].trim().trim_matches('"').trim_matches('\'');
                if !candidate.is_empty() {
                    return Ok(candidate.to_string());
                }
            }
        }
    }

    // Default fallback — most test/dev deployments use "admin".
    Ok("admin".to_string())
}

/// Check whether the local engine is healthy (responding on the given port).
#[tauri::command]
pub async fn check_engine_health(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/health");
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };

    match client.get(&url).send().await {
        Ok(resp) => resp.status().is_success(),
        Err(_) => {
            // Fallback: check if port is listening.
            std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
        }
    }
}

/// Save the local engine configuration to `~/.feclaw/config.toml`.
#[tauri::command]
pub async fn save_local_engine_config(
    dest: String,
    port: u16,
    admin_password: String,
) -> Result<(), String> {
    use crate::config::Config;

    let dest_path = expand_tilde(&dest);
    let feclaw_path = dest_path.join("FeClaw");

    let mut cfg = Config::load();
    cfg.mode = crate::config::Mode::Local;
    cfg.host = "127.0.0.1".to_string();
    cfg.port = port;
    cfg.engine_path = Some(feclaw_path.to_string_lossy().to_string());

    // Persist the admin password as the local-mode credential so
    // auth.rs can use it on the next launch.
    cfg.cloud_token = Some(admin_password);

    cfg.save().map_err(|e| format!("保存配置失败：{e:#}"))
}

/// Standard location for the local engine — `~/feclaw`.
#[tauri::command]
pub fn default_engine_dest() -> String {
    dirs::home_dir()
        .map(|h| h.join("feclaw").to_string_lossy().to_string())
        .unwrap_or_else(|| "./feclaw".to_string())
}

/// Open the local-setup wizard window.
#[tauri::command]
pub async fn open_local_setup_window<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    const WIN: &str = "local-setup";

    if let Some(existing) = app.get_webview_window(WIN) {
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, WIN, WebviewUrl::App("local_setup/index.html".into()))
        .title("FeClaw Desktop — 本地引擎配置")
        .inner_size(720.0, 640.0)
        .min_inner_size(560.0, 480.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| format!("创建本地配置窗口失败：{e}"))?;
    Ok(())
}
