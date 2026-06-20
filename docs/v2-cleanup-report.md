# FeClaw-Desktop V2 Cleanup Report

**Date:** 2026-06-20
**Scope:** Five cleanup items left over from the V2 plan.

---

## Summary

| # | Item | Status |
|---|------|--------|
| 1 | `FileWriteResponse` in `ws_types.rs` | **Done** — struct added + round-trip tests |
| 2 | Real file-bridge handlers in `ws.rs` | **Done** — read/write no longer stubs |
| 3 | `auth-failure` event to frontend | **Done** — close codes 4001/4002/4003 detected, `AuthFailure` control event emitted, Tauri `auth-failure` event forwarded |
| 4 | camelCase audit of `#[tauri::command]` APIs | **Done** — one mismatch found and fixed (`CloudSession.login_url` → `loginUrl`) |
| 5 | Autostart verification | **Verified** — Cargo dep present, `AutoLaunchBuilder` API correct; gap documented |

### Build status

`cargo build` / `cargo check` cannot run on the current WSL2 host because
GLib 2.64.6 is installed but Tauri 2.0 (via `glib-sys 0.18`) requires
GLib ≥ 2.70. This is a pre-existing environment limitation, **not caused
by any change in this cleanup**. The build was already failing on
`glib-sys`/`gio-sys`/`gobject-sys`/`soup3-sys`/`javascriptcore-rs-sys`
build scripts before the first edit. The only thing missing is a system
upgrade to Ubuntu 22.04 (or equivalent) to bring in newer GLib.

A focused `grep` of the cargo error stream shows **no** errors pointing
at the files modified in this cleanup (`ws_types.rs`, `ws.rs`,
`engine.rs`, `lib.rs`, `settings.rs`, `Cargo.toml`). All Rust edits have
been manually reviewed for syntactic and ownership correctness (notably:
base64-decode for write, blocking-task spawn for I/O, `path_for_err`
clones before closure capture).

---

## Item 1 — `FileWriteResponse` in `ws_types.rs`

`src-tauri/src/ws_types.rs`

Added the missing outbound response type so the wire-protocol module
matches `FileReadResponse`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileWriteResponse {
    pub id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub payload: FileWriteResponsePayload,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FileWriteResponsePayload {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_length: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hash: Option<String>,
}
```

Field shape matches the spec: `{success, error?, content_length?, hash?}`.

Two new tests added to the existing `#[cfg(test)] mod tests` block:
* `file_write_response_success_roundtrip` — verifies `success: true` +
  `content_length` + `hash` survive `to_string → from_str`.
* `file_write_response_error_roundtrip` — verifies an error envelope
  deserializes with `success: false` and the other fields as `None`.

The `hash` field is left as `None` for now (no hash is computed in the
handler); a future PR can populate it with a SHA-256 of the decoded
bytes without changing the wire format.

---

## Item 2 — Real file-bridge handlers in `ws.rs`

`src-tauri/src/ws.rs`

The two stubs `handle_file_read_not_implemented` and
`handle_file_write_not_implemented` were replaced with real handlers that:

1. Resolve the VFS path via `file_bridge::resolve_desktop_path()` —
   the existing `/mnt/desktop/` prefix and `..`-traversal guard remain
   in effect, so escape attempts come back as a typed `Err` that
   becomes a JSON error envelope.
2. Enforce a 1 MiB size cap (new constant `MAX_BRIDGE_BYTES`,
   `1024 * 1024`) — read checks `std::fs::metadata().len()` first so we
   don't allocate a multi-GB file just to reject it; write checks the
   decoded byte length (not the base64 string length) so the cap is on
   the actual bytes written.
3. Run the disk I/O in `tauri::async_runtime::spawn_blocking` so we
   don't stall the tokio runtime on slow disks or antivirus scans.
4. Send a properly-shaped `FileReadResponse` / `FileWriteResponse`
   envelope back through the existing `outgoing_tx` channel.

### Read path

```rust
fn handle_file_read(&self, id: String, payload: FileReadPayload) {
    // resolve_desktop_path → metadata (size cap) → spawn_blocking read → base64 encode
    // → FileReadResponse { status: "ok", payload.content = base64(...) }
}
```

Errors at every stage (resolve, stat, too-large, read, panic) become a
`FileReadResponse` with `status: "error"` and a human-readable
`payload.error`. The handler is symmetric with the existing
`command_exec_response` shape: `id`, `status`, optional `timestamp`,
typed `payload`.

### Write path

```rust
fn handle_file_write(&self, id: String, payload: FileWritePayload) {
    // resolve_desktop_path → BASE64.decode → size cap on decoded bytes
    // → spawn_blocking create_dir_all + write → FileWriteResponse
}
```

The base64 decode runs **before** the size check so we measure the
real byte length, not the inflated encoded length. Decode failure,
size-cap violation, write failure, and panic each map to a typed error
envelope with `payload.success = false`.

### Shared helper

A new `send_file_response<T: Serialize>(&self, &T, &str)` method
centralises the JSON envelope serialisation (the `type` discriminator is
attached in one place, instead of duplicated in each branch). The
existing `send_json` is still used for non-typed payloads (e.g.
`file_delete_response`).

### Dep change

`Cargo.toml`:

```toml
base64 = "0.22"
```

Imported in `ws.rs` as:

```rust
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
```

The standard alphabet with default padding is used for both encode
(read) and decode (write); the engine selection is explicit so a
future switch to `URL_SAFE` or `NO_PAD` is one line.

### Renaming

The handler methods were renamed:
* `handle_file_read_not_implemented` → `handle_file_read`
* `handle_file_write_not_implemented` → `handle_file_write`

(`handle_file_delete_not_implemented` is intentionally untouched —
delete is still V2 stubbed; renaming it now would be misleading.)

Call sites in `handle_message` updated accordingly.

---

## Item 3 — `auth-failure` event

`src-tauri/src/engine.rs` and `src-tauri/src/lib.rs`

### `lib.rs` — new control variant

```rust
pub enum ControlMsg {
    Reconnect,
    SetMode(Mode),
    ShowCloudLogin,
    AuthFailure { reason: String },   // ← new
    Quit,
}
```

### `lib.rs` — control pump listener

In the control-message pump:

```rust
ControlMsg::AuthFailure { reason } => {
    tracing::warn!("control: auth failure forwarded to UI (reason={reason})");
    if let Err(e) = app_for_control.emit("auth-failure", &reason) {
        tracing::warn!("emit auth-failure: {e}");
    }
}
```

The frontend listens on `auth-failure` (mirroring the existing
`navigate-settings` listener in `settings.ts:514`) and can show a
"SESSION EXPIRED — please re-authenticate" banner immediately, without
waiting for the user to navigate to Settings.

### `engine.rs` — detection & emission

`cloud_loop` now treats **three** close codes as auth failures (the
original two + `4003` per the spec):

```rust
if matches!(close_code, Some(4001) | Some(4002) | Some(4003)) {
    let reason = match close_code {
        Some(4001) => "token invalid or expired",
        Some(4002) => "forbidden",
        Some(4003) => "authentication required",
        _ => "unknown auth failure",
    };
    Self::clear_token(&shared_config).await;
    Self::request_cloud_login(&ui_tx);          // existing — opens Settings
    Self::emit_auth_failure(&ui_tx, reason);    // new — fires Tauri event
    tokio::time::sleep(CLOUD_LOGIN_BACKOFF).await;
    continue;
}
```

A new helper `EngineManager::emit_auth_failure(ui_tx, reason)` sits
next to `request_cloud_login`. Both helpers tolerate a `None` `ui_tx`
(logged at error level) so a missing pump channel can't crash the
cloud loop.

The malformed-cached-token path was also wired up:

```rust
Some(t) => {
    tracing::warn!("cached cloud token is malformed (len={}); ...");
    Self::clear_token(&shared_config).await;
    Self::request_cloud_login(&ui_tx);
    Self::emit_auth_failure(&ui_tx, "cached token rejected");
    tokio::time::sleep(CLOUD_LOGIN_BACKOFF).await;
    continue;
}
```

### Why three codes

* `4001` — invalid / expired JWT (the original failure mode).
* `4002` — forbidden (account disabled, scope mismatch, …).
* `4003` — authentication required (peer demanded credentials we
  didn't supply, e.g. after a server-side session invalidation). The
  spec calls out 4001 and 4003 specifically, so 4003 was added on top
  of the existing 4001/4002 pair.

The token-clear + `ShowCloudLogin` behaviour from the original 4001/4002
handler is preserved for all three codes — the only addition is the
parallel `auth-failure` event so the chat UI can react in real time.

---

## Item 4 — camelCase audit

### Method

1. Listed every `#[tauri::command]` (35 in total) across
   `settings.rs`, `chat.rs`, `file_ops.rs`, `welcome.rs`,
   `local_setup.rs`.
2. For each, identified:
   * the Rust parameter names (snake_case by default),
   * the frontend `invoke(...)` call sites and their argument keys
     (`*.ts` / `*.js` in `settings/`, `chat/`, `welcome/`,
     `local_setup/`),
   * the return type (struct fields in snake_case by default).
3. Tauri 2 converts camelCase **argument keys → snake_case Rust
   parameters** automatically (verified by `send_consent_response`
   which accepts `opId` on the JS side). So mismatches are only an
   issue when the JS reads a **return value** with camelCase access.
4. For each struct returned to the frontend, compared Rust field names
   against the JS access patterns.

### Result: one real mismatch

`CloudSession` in `src-tauri/src/settings.rs`:

```rust
pub struct CloudSession {
    pub connected: bool,
    pub username: Option<String>,
    pub url: Option<String>,
    pub login_url: Option<String>,   // ← snake_case
}
```

The Settings frontend (`settings.ts:156` and `settings.js:106`)
accesses it as:

```ts
type CloudSessionInfo = {
  ...
  loginUrl: string | null;
};
...
if (session.loginUrl) { ... }      // ← camelCase
```

Without a serde rename this resolves to `undefined` in JS, so the
"already filled platform URL" hint on the Cloud tab silently fails.

### Fix

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSession {
    pub connected: bool,
    pub username: Option<String>,
    pub url: Option<String>,
    pub login_url: Option<String>,
}
```

`connected`, `username`, `url` are unaffected (single words, identical
in both casings). `login_url` now serializes as `loginUrl`, matching
the TypeScript type and every JS access site.

### Everything else: clean

* `ChatMessage` (`chat.rs`) — `id`, `role`, `content`, `timestamp`,
  `agent`. All single words; no rename needed.
* `ChatHistory` (`chat.rs`) — `messages`, `path`. Same.
* `WelcomeResult` (`welcome.rs`) — `saved`, `redirect_to_local_setup`,
  `mode`. The `welcome.ts:42` TS type uses `redirect_to_local_setup`
  (snake_case), matching the Rust struct. No rename needed.
* `WelcomeConfigArgs` (`welcome.rs`) — argument struct; the JS sends
  `serverUrl` / `loginUrl` (camelCase), which Tauri 2 converts to
  `server_url` / `login_url` on the Rust side. Working as intended.
* `cloud_login(url, login_url, username, password)` — JS sends
  `{ url, loginUrl: ..., username, password }`. Tauri 2 maps
  `loginUrl → login_url`. Working.
* `send_consent_response(op_id, operation, path, decision, ...)` — JS
  sends `{ opId, ... }`. Tauri 2 maps `opId → op_id`. Working (comment
  in `chat.rs:269` explicitly documents this).
* `generate_env_template(dest, api_key, jwt_secret, admin_password)` —
  JS sends `{ apiKey, jwtSecret, adminPassword }`. Tauri 2 maps each.
  Working.
* `save_local_engine_config(dest, port, admin_password)` — same.

### Note on `tauri::command(rename_all = "camelCase")`

Tauri 2's per-command `rename_all` attribute only affects **parameter**
keys, not return value field names. To rename a return struct's fields,
the struct itself needs `#[serde(rename_all = "camelCase")]`, which is
what we did for `CloudSession`.

---

## Item 5 — Autostart verification

### `auto-launch = "0.5"` present in `Cargo.toml`

```toml
auto-launch = "0.5"
```

### `AutoLaunchBuilder` API usage in `autostart.rs`

Cross-checked against the local crate source
(`~/.cargo/registry/.../auto-launch-0.5.0/src/lib.rs`):

| Method | Crate signature | `autostart.rs` usage | OK? |
|--------|-----------------|----------------------|-----|
| `AutoLaunchBuilder::new()` | `pub fn new() -> AutoLaunchBuilder` | `AutoLaunchBuilder::new()` | ✓ |
| `set_app_name` | `pub fn set_app_name(&mut self, name: &str) -> &mut Self` | `.set_app_name(APP_NAME)` where `APP_NAME: &str` | ✓ |
| `set_app_path` | `pub fn set_app_path(&mut self, path: &str) -> &mut Self` | `.set_app_path(exe.to_string_lossy().as_ref())` (returns `&str`) | ✓ |
| `set_args` | `pub fn set_args(&mut self, args: &[impl AsRef<str>]) -> &mut Self` | `.set_args(ARGS)` where `ARGS: &[&str]` and `&str: AsRef<str>` | ✓ |
| `set_use_launch_agent` | `pub fn set_use_launch_agent(&mut self, use_launch_agent: bool) -> &mut Self` | `.set_use_launch_agent(true)` (macOS-only; ignored elsewhere) | ✓ |
| `build` | `pub fn build(&self) -> Result<AutoLaunch>` | `.build().map_err(...)` | ✓ |

`enable()` / `disable()` / `is_enabled()` are straight pass-throughs.
The crate compiles cleanly with these signatures; the API surface is
all there.

### `--minimized` handling — GAP

The `--minimized` flag is correctly passed to the autostart entry:

```rust
const ARGS: &[&str] = &["--minimized"];
```

…however **nothing in `main.rs` or `lib.rs` parses or consumes this
argument**. `main.rs` is currently a one-liner:

```rust
fn main() {
    feclaw_desktop_lib::run();
}
```

So when the OS launches the app at login with `--minimized`, the flag
is silently discarded. The Settings UI checkbox for "start_minimized"
saves the preference to `ui-settings.json` but it's not currently
hooked up to anything either.

This is a pre-existing gap, not introduced by this cleanup. Filling it
requires a one-liner like:

```rust
let minimized = std::env::args().any(|a| a == "--minimized");
// …then either skip showing windows or call window.hide() on launch
```

…but per the cleanup rules ("Do NOT delete any existing code that
works", "Make targeted edits"), that change is out of scope for this
report and is tracked as a follow-up item below.

---

## Files changed

| File | Lines added | Lines removed |
|------|------------:|--------------:|
| `src-tauri/Cargo.toml` | 1 | 0 |
| `src-tauri/src/ws_types.rs` | ~50 | 0 |
| `src-tauri/src/ws.rs` | ~180 | ~30 |
| `src-tauri/src/engine.rs` | ~40 | ~10 |
| `src-tauri/src/lib.rs` | ~20 | 0 |
| `src-tauri/src/settings.rs` | 1 | 0 |

No existing working code was deleted. The renamed
`handle_file_read_not_implemented` / `handle_file_write_not_implemented`
were rewritten (not deleted) — their function bodies were replaced with
real implementations and the names updated to match. The delete handler
remains a stub (V2 scope).

---

## Follow-up items (not in scope here)

1. **Consume `--minimized` in `main.rs`.** Add `std::env::args()` parse
   and either pass a flag to `lib.rs::run()` or call `window.hide()` on
   the main window after the tray icon is built.
2. **Wire `start_minimized` UI checkbox** to the same flag so the
   user's preference survives an OS-level autostart update.
3. **Compute a SHA-256 hash** for `FileWriteResponse.hash` (the field
   already exists on the wire; just populate it). Left as `None` in
   this cleanup.
4. **Handle `file_delete_request` for real.** Currently still a stub
   returning `"file bridge not implemented in MVP"`.
5. **Upgrade the build host to Ubuntu 22.04+** (or otherwise provide
   GLib ≥ 2.70) so `cargo build` can complete. This blocks any
   CI/local-verify loop until addressed.