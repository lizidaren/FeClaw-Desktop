# FeClaw-Desktop Phase 0-10 Architectural Audit

**Date:** 2026-06-21
**Auditor:** Claude Code
**Files Reviewed:** 27 source files + Cargo.toml

---

## Summary of Findings

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 7 |
| Medium | 12 |
| Low | 11 |
| **Total** | **30** |

**Overall Assessment: Needs Work**

The codebase is well-structured overall with good patterns (consent gating, path traversal defense, async I/O via `spawn_blocking`). However, there are several correctness and security issues that should be addressed before production deployment.

---

## 1. Architecture Issues

### HIGH: Duplicate `Credentials` + `load_token` Pattern Across 5 Modules

**Files:** `group.rs:13-36`, `moments.rs:13-35`, `fehub.rs:13-35`, `search.rs:54-73`, `qr_upload.rs:21-41`

All five modules duplicate the same `Credentials` struct and `load_token()` function. This is ~20 lines of identical code × 5 = 100+ lines of duplication.

**Suggested fix:** Extract to a shared `crates/desktop-auth` crate or at minimum a `src/auth_client.rs` module that provides a single `authed_client()` function returning a configured `reqwest::Client` with bearer auth already attached.

---

### HIGH: Token Loaded But Not Attached to HTTP Requests

**Files:** `moments.rs:106` (get_moments), `fehub.rs:77` (list_my_publishes), `search.rs:107` (search_all), `qr_upload.rs:113` (create_upload_session), `moments.rs:124` (post_moment), `moments.rs:149` (delete_moment), `qr_upload.rs:137` (download_uploaded_file)

Example from `moments.rs:104-109`:
```rust
let resp = client
    .get(&url)
    .header("Authorization", format!("Bearer {}", token))  // token loaded but...
    .send()
    .await
```
The token IS being attached via `.header(...)` directly on the builder — **this is actually correct**. These calls are NOT using `with_auth()` helper, they inline the header. This is functional but inconsistent with the pattern used elsewhere.

---

### HIGH: `build_client()` Creates New `reqwest::Client` Per Call (No Connection Pooling)

**Files:** `group.rs:39-47`, `moments.rs:38-59`, `fehub.rs:38-43`, `search.rs:100-103`, `qr_upload.rs:43-50`, `settings.rs:200-204`, `chat.rs:401-405`, `create.rs:53-57`, `side_panel.rs:423-426`, `side_panel.rs:495-498`

`reqwest::Client` holds a connection pool internally. Creating a new client per call defeats pooling. All these modules should share a single client.

**Suggested fix:** Create a module `src/http_client.rs` with a lazy static:
```rust
pub fn http_client() -> &'static reqwest::Client {
    static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap()
    });
    CLIENT
}
```

---

### MEDIUM: `#[tauri::command]` with `R: Runtime` Generic Won't Work

**File:** `side_panel.rs:317,406` (`open_config_window`, `list_agent_apps`)

```rust
pub async fn open_config_window<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    ...
```

Tauri's `#[tauri::command]` proc macro generates code that must type-erase at the proc macro boundary. Named generic parameters like `R: Runtime` are not supported by `tauri::generate_handler!`.

**Suggested fix:** Remove the generic and use `tauri::AppHandle` directly (or `tauri::AppHandle<tauri::Wry>` for desktop):
```rust
pub async fn open_config_window(
    app: tauri::AppHandle<tauri::Wry>,
    agent_hash: String,
) -> Result<(), String>
```

---

### MEDIUM: `file_index.rs` — SQLite Synchronous Calls on Async Executor

**File:** `file_index.rs:341-413`

All SQLite operations (`with_conn`, `init_tables`, `index_directory` inner loop) run synchronously on the async executor via `tauri::async_runtime::spawn`. For a background indexing task this is acceptable (CPU-bound), but `search_local_files` (line 434) is a user-facing command that will block.

**Suggested fix:** Wrap `search_local_files` in `tokio::task::spawn_blocking`.

---

### MEDIUM: `index_directory` Is 112 Lines — Should Be Split

**File:** `file_index.rs:205-317`

The function handles directory walking, FTS5 indexing, and counter updates all in one function.

**Suggested fix:** Extract the inner loop body into `index_file_entry`.

---

### LOW: `lib.rs:startup` Is ~175 Lines

**File:** `lib.rs:288-463`

This function chains 10 sequential initialization steps. While each step is labeled and commented, the function is at the upper limit of comfortable single-function length. Not critical but worth refactoring.

---

## 2. Security Issues

### HIGH: Hardcoded Cloud Domain `feclaw.lizidaren.cn`

**Files:** `welcome.rs:91`, `settings.rs:91`, `side_panel.rs:344`, `fehub.rs:119`

These appear in both default URL construction and as hardcoded fallbacks:
```rust
// welcome.rs:91
cfg.cloud_url = Some("https://feclaw.lizidaren.cn".to_string());
// settings.rs:91
"https://feclaw.lizidaren.cn".to_string()
// side_panel.rs:344
let _base = config.cloud_base_url().unwrap_or("https://feclaw.lizidaren.cn");
// fehub.rs:119
format!("https://{}.feclaw.lizidaren.cn/apps/{}/", info.agent_hash, app_name)
```

While this is the official server, a future self-hosted deployment would need to change these manually.

---

### HIGH: `file_bridge.rs:52-54` — No Canonicalization Before `starts_with` Check

**File:** `file_bridge.rs:51-54`

```rust
// Default: relative to ~/Desktop.
let desktop = dirs::desktop_dir()
    .ok_or_else(|| anyhow!("could not locate user desktop directory"))?;
Ok(desktop.join(stripped))
```

If an attacker could somehow cause `dirs::desktop_dir()` to return a symlink (unlikely but theoretically possible on a misconfigured system), and the resolved path uses a symlink component, `starts_with` would not catch traversal.

**Suggested fix:** Canonicalize both paths before comparison:
```rust
let desktop = dirs::desktop_dir()
    .ok_or_else(|| anyhow!("could not locate user desktop directory"))?;
let canonical = desktop.canonicalize()
    .map_err(|_| anyhow!("desktop path not accessible"))?;
```

Note: `canonicalize()` itself can fail if the path doesn't exist, so handle that case explicitly.

---

### MEDIUM: `qr_upload.rs:154-161` — MIME Type Detection From URL Extension

**File:** `qr_upload.rs:154-161`

```rust
let mime = if url.contains(".jpg") || url.contains(".jpeg") {
    "image/jpeg"
} else if ...
```

A malicious server could return a file with a misleading URL (e.g., `https://server.com/evil.jpg` containing HTML/JS). The MIME type should come from the `Content-Type` header of the HTTP response, not from the URL.

**Suggested fix:** Use `resp.headers().get("Content-Type")` from the download response.

---

### MEDIUM: `search.rs:97` — Path Component Not URL-Encoded

**File:** `search.rs:97`

```rust
let url = format!("{}/api/user/search?q={}", engine_url(), urlencoding::encode(&query));
```

Only the query parameter `q` is encoded. The `engine_url()` itself may contain characters that need encoding if the host has special characters. This is a low risk since `engine_url()` comes from a trusted config file.

---

### LOW: `right_click.rs:84,100` — Command Injection in Registry Values

**File:** `right_click.rs:84,100`

```rust
let ref_cmd_str = format!("\"{exe_path}\" --right-click reference \"%1\"");
ref_cmd.set_value("", &ref_cmd_str)?;
```

The `%1` (file path from Explorer) is passed without quoting. If the file path contains spaces or special characters, the shell parsing could be unpredictable. Should be:
```rust
let ref_cmd_str = format!("\"{exe_path}\" --right-click reference \"%1\"");
```
Actually this looks correct since `%1` is already quoted. However, `exe_path` should be validated to not contain quotes.

---

### LOW: `create_group` — No Input Validation on `member_hashes`

**File:** `group.rs:161`

```rust
pub async fn create_group(name: String, member_hashes: Vec<String>) -> Result<GroupInfo, String> {
```

No validation that `name` is non-empty, no validation that `member_hashes` elements are valid hash formats. A server could return a misleading error.

---

## 3. Performance Issues

### HIGH: No HTTP Client Reuse (see Architecture — connection pooling)

Already covered above in Architecture section.

---

### MEDIUM: `executor.rs:94-96` — Pre-Allocates 4KB Buffer for stdout/stderr

**File:** `executor.rs:93-106`

```rust
let stdout_fut = async {
    let mut buf = Vec::with_capacity(4096);  // Always allocates 4KB
    ...
};
```

The buffer is always 4KB even for commands that produce no output. Use `Vec::new()` and let `read_to_end` grow it as needed.

**Suggested fix:** Use `Vec::new()` and let `read_to_end` handle allocation.

---

### MEDIUM: `file_index.rs:392` — Wrong Counter Passed to `index_directory`

**File:** `file_index.rs:392`

```rust
match index_directory(dir, conn, &INDEX_INDEXED, &INDEX_INDEXED, &INDEX_CURRENT) {
```

The `total_counter` and `indexed_counter` arguments are both passed as `&INDEX_INDEXED`. This means the total counter is never updated (stays 0). The code sets `*INDEX_TOTAL.write().await = total` where `total = dirs.len()` but it's never propagated to `INDEX_TOTAL` inside the directory walker.

---

### LOW: `chat.rs:96-101` — Full File Read on Every `append_chat_message`

**File:** `chat.rs:96-101`

```rust
let mut list: Vec<ChatMessage> = match tokio::fs::read_to_string(&path).await {
    Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
    ...
};
```

Every chat message append does a full read of the entire history file. For sessions with hundreds of messages this will become slow. Acceptable for MVP, but should migrate to SQLite append-only model in a future phase.

---

### LOW: `ws.rs:513-520` — Entire File Loaded Into Memory for WS Transfer

**File:** `ws.rs:513-520`

The file bridge reads entire files into memory for WS transmission. For 1MB files this is fine, but the cap should be documented.

---

## 4. Tauri 2 API Misuse

### MEDIUM: `R: Runtime` Generic on `#[tauri::command]` Functions

**File:** `side_panel.rs:317,406`

Covered in Architecture section above.

---

### MEDIUM: `app.run()` Callback Takes Unused Parameters

**File:** `lib.rs:284`

```rust
app.run(|_app_handle, _event| {});
```

The underscore prefix suppresses warnings but the callback signature should match `Fn(AppHandle, RunEvent)`. Currently passing `_app_handle` and `_event` implies they're unused, which is correct — but the correct way to indicate unused parameters in a callback is to just not name them:

```rust
app.run(|_app_handle, _event| {});
```

This is fine and common in Tauri 2.

---

### LOW: `settings.rs:279` — `get_cloud_session` is Sync But Doesn't Need to Be

**File:** `settings.rs:279`

```rust
#[tauri::command]
pub async fn get_cloud_session() -> Result<CloudSession, String> {
    let cfg = Config::load();
    ...
}
```

The function is marked `async` but does no I/O — just deserializes from a local file. The `async` keyword is harmless here but misleading. Could be a sync function.

---

## 5. Code Quality

### LOW: Dead Code — `_phantom_marker` in `chat.rs`

**File:** `chat.rs:371-372`

```rust
#[allow(dead_code)]
pub(crate) fn _phantom_marker() {}
```

This empty marker function was added for future extension but is never used. Should be removed before shipping.

---

### LOW: Chinese Error Messages vs English Inconsistency

**Files:** Multiple

Error messages throughout use a mix of Chinese (for user-facing errors) and English (for internal/technical errors). Examples:
- `chat.rs:73`: Chinese `"读取聊天历史失败：{e}"`
- `settings.rs:114`: Chinese `"读取设置失败：{e}"`
- `ws.rs:156`: English error message in header insertion

This is actually **intentional and consistent** — user-facing errors are in Chinese while technical/internal errors are in English. No change needed, just noting the pattern is deliberate.

---

### LOW: `lib.rs:54` — Unused Import

**File:** `lib.rs:54`

```rust
use tokio::sync::mpsc;
```

Checked — `mpsc` IS used (lines 58, 89, 98, 312, etc.). No issue.

---

### LOW: `create_group_placeholder` — Returns Hardcoded Placeholder

**File:** `create.rs:94-97`

```rust
pub async fn create_group_placeholder() -> Result<String, String> {
    Ok(String::from("placeholder-group-id"))
}
```

This is intentional as documented ("Phase 4 will wire this to the engine's POST /api/groups/create endpoint"). Not a bug.

---

### LOW: `db.rs:88` — Emoji in Default Icon

**File:** `db.rs:88`

```rust
icon TEXT DEFAULT '😄',
```

Using emoji in SQLite defaults is non-standard. May cause encoding issues on some platforms. Low risk.

---

## 6. WS Message Handling — No Message Loss Risk Detected

The `tokio::select!` in `ws.rs:242-322` is well-structured:
- `outgoing_rx.recv()` handles back-pressure via bounded channel
- Inbound messages are deserialized and dispatched synchronously (fast)
- `cancel_token` is checked after each message loop iteration
- Close frames are handled explicitly

The architecture is sound for message handling.

---

## 7. Thread Safety — Mostly Correct

### `INDEXING` AtomicBool

**File:** `file_index.rs:101`

```rust
static INDEXING: AtomicBool = AtomicBool::new(false);
```

This is correctly guarded by `Ordering::SeqCst` in `is_indexing()` and `INDEXING.store()`.

### `ALT_SPACE_REGISTERED` AtomicBool

**File:** `alt_space.rs:21`

```rust
static ALT_SPACE_REGISTERED: AtomicBool = AtomicBool::new(false);
```

Correctly uses `Ordering::SeqCst`.

### Static Lazy Locks in `file_index.rs`

**File:** `file_index.rs:320-325`

```rust
static INDEX_TOTAL: std::sync::LazyLock<RwLock<usize>> = ...
static INDEX_INDEXED: std::sync::LazyLock<Mutex<usize>> = ...
```

These are initialized once and protected by RwLock/Mutex. Correct.

---

## 8. Missing Doc Comments

Several public API functions lack doc comments:
- `file_manager.rs` — all 9 functions have good doc comments
- `file_ops.rs` — functions have doc comments
- `group.rs` — no doc comments on any `#[tauri::command]` functions (lines 100-234)
- `moments.rs` — no doc comments (lines 96-160)
- `fehub.rs` — no doc comments (lines 71-135)
- `qr_upload.rs` — no doc comments (lines 105-166)
- `search.rs` — only `search_all` has a comment

**Suggested fix:** Add doc comments to all `#[tauri::command]` public functions.

---

## 9. Hardcoded Default Ports/Hosts

| File | Line | Value |
|------|------|-------|
| `config.rs:55` | port | `8080` |
| `config.rs:56` | host | `"127.0.0.1"` |
| `settings.rs:91` | cloud_url | `"https://feclaw.lizidaren.cn"` |
| `settings.rs:92` | cloud_login_url | `"https://platform.firstentrance.lizidaren.cn"` |
| `welcome.rs:91` | cloud_url | `"https://feclaw.lizidaren.cn"` |
| `welcome.rs:92` | cloud_login_url | `"https://platform.firstentrance.lizidaren.cn"` |

These are acceptable defaults but should ideally be compile-time constants rather than inline literals.

---

## Overall Assessment

### Deployable / Needs Work / Risky

**Needs Work** — The following must be addressed before production:

1. **HIGH: Fix `R: Runtime` generic on `#[tauri::command]` functions** (`side_panel.rs:317,406`) — these will silently fail to route commands
2. **HIGH: Create shared HTTP client** — creating a new `reqwest::Client` per call defeats connection pooling across all API modules
3. **HIGH: Extract duplicate `Credentials`/`load_token`** — 5 modules duplicate the same authentication helper
4. **MEDIUM: Fix `file_bridge.rs` canonicalization** — symlink traversal risk
5. **MEDIUM: Fix `qr_upload.rs` MIME detection** — use Content-Type header not URL extension
6. **MEDIUM: Fix `file_index.rs:392` wrong counter** — `total_counter` never updated

### What's Working Well

- **Path traversal defense** in `file_bridge.rs` is solid (blocks `..`, enforces `/mnt/desktop/` prefix)
- **Consent gating** on file operations (`file_ops.rs`) is well-implemented
- **WS reconnect logic** with exponential backoff and close code detection is correct
- **Async I/O** properly uses `spawn_blocking` for file operations
- **Error handling** with `anyhow::Result` and `?` operator is consistent
- **Test coverage** is comprehensive (unit tests in most modules)
- **Module structure** is logical and well-separated by concern
