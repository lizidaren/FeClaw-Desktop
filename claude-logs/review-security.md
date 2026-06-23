# FeClaw-Desktop Security Audit Report

**Auditor:** Subagent (Ambient)
**Date:** 2026-06-22
**Scope:** FeClaw-Desktop (Tauri 2) + FeClaw Engine Server (FastAPI)
**Files Reviewed:** auth.rs, config.rs, lib.rs, ws.rs, executor.rs, db.rs, consent.rs, types.rs, chat.rs, create.rs, engine.rs, http_client.rs, file_bridge.rs, tauri.conf.json, Cargo.toml + desktop_ws.py, desktop_api.py, auth.py, desktop_relay.py, config.py (server)

---

## Summary

| Severity | Count |
|---|---|
| Critical | 3 |
| High | 5 |
| Medium | 5 |
| Low | 6 |

---

## 🔴 Critical Findings

---

### C-1: SHA-256 Used for Password Hashing (Server)

**Severity:** Critical
**Location:** `utils/auth.py:hash_password` (server)

**Description:**
Password hashing on the server uses `hashlib.sha256(password + salt)` — a fast, unsalted or single-salt hash unsuitable for password storage. The code itself contains a `TODO` acknowledging this should be migrated to bcrypt. Unlike bcrypt/scrypt/Argon2, SHA-256 is trivially fast and vulnerable to GPU brute-force and rainbow-table attacks.

**Code snippet:**
```python
def hash_password(password: str, salt: str) -> str:
    # TODO: 迁移到 bcrypt，SHA-256 不适合密码存储
    return hashlib.sha256((password + salt).encode()).hexdigest()
```

**Fix:** Replace with `bcrypt.hashpw` / `bcrypt.checkpw`, or use Argon2 via `argon2-cffi`. Also increase the number of iterations if keeping PBKDF2.

---

### C-2: TLS Certificate Verification Disabled in Desktop→Platform Call (Server)

**Severity:** Critical
**Location:** `routers/desktop_api.py:_verify_platform_token` (server)

**Description:**
When the Desktop client exchanges its Platform access token for a FeClaw JWT, the server calls Platform's `/api/auth/me` using `httpx.AsyncClient(verify=False)`, disabling TLS certificate verification. This allows man-in-the-middle attackers on the network path to intercept and steal Platform tokens.

**Code snippet:**
```python
async with httpx.AsyncClient(timeout=10.0, verify=False) as client:
    resp = await client.get(
        me_url,
        headers={"Authorization": f"Bearer {access_token}"},
    )
```

**Fix:** Remove `verify=False`. If Platform uses a self-signed cert, install its CA bundle in the server's trust store instead of disabling verification entirely.

---

### C-3: No File Permission Hardening on Sensitive Config Files

**Severity:** Critical
**Location:** `src-tauri/src/config.rs:save` + `src-tauri/src/auth.rs:save_credentials` (client)

**Description:**
`config.toml` (contains `cloud_token` JWT) and `local-credentials` (contains JWT + plaintext password) are saved with the OS default umask (typically 0o644). Any local user on the same machine can read these files. On shared hosting or multi-user Windows systems, any process or user can exfiltrate the JWT and replay it.

There is no `fs::set_permissions` call, no permission hardening, and no use of OS-level credential storage (e.g., Windows DPAPI, Linux secret-service API).

**Code snippet (config.rs):**
```rust
// No permission hardening before write:
fs::write(Self::config_path(), content).context("write config.toml")?;
```

**Fix:** Use platform-specific credential storage:
- **Windows:** `windows-rs` crate to call `CredWriteW` (Credential Manager) or DPAPI
- **macOS:** Keychain API via `security` crate
- **Linux:** secret-service API via `secret-service` crate or pass `libsecret`

Alternatively, encrypt the JWT at rest using a machine-derived key (e.g., hashed machine ID + user SID) before writing to the file.

---

## 🟠 High Findings

---

### H-1: JWT Client-Side Validation is Structural Only

**Severity:** High
**Location:** `src-tauri/src/auth.rs:verify_desktop_jwt` (client)

**Description:**
`verify_desktop_jwt()` does **not** verify the cryptographic signature of the JWT. It only checks the envelope structure (3 base64url segments, no padding). A malicious server, compromised DNS, or man-in-the-middle could supply a completely fake JWT with a valid-looking structure, and the client would accept it.

The server (`utils/auth.py:decode_jwt_token`) is the sole source of truth for signature verification. The client also sends this unverified JWT in the `Authorization: Bearer` header to the server — which does verify it — so no immediate auth bypass exists, but the client has a false sense of security.

**Code snippet:**
```rust
// base64url format check only — NO signature verification
let is_b64url = |s: &str| {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
};
is_b64url(header) && is_b64url(payload) && is_b64url(signature)
```

**Fix:** Either decode and verify the JWT using the known server's public key (HS256 with a server-known secret), or remove the function entirely since the server is authoritative. If kept, the function should be clearly documented as "envelope-only sanity check."

---

### H-2: No Refresh Token — Re-Authentication Required After 7 Days

**Severity:** High
**Location:** `utils/auth.py:create_jwt_token` (server) + `src-tauri/src/config.rs` (client)

**Description:**
JWT expires after `JWT_EXPIRE_HOURS = 24 * 7` (7 days). There is no refresh-token mechanism. When the token expires, the user must manually re-enter credentials. This encourages long-lived tokens and creates usability pressure to set very long expiry.

**Fix:** Implement OAuth2-style refresh tokens (opaque rotating refresh token → new access token). Store refresh token in HttpOnly cookie or platform keychain.

---

### H-3: No Rate Limiting on `/api/desktop/auth_exchange`

**Severity:** High
**Location:** `routers/desktop_api.py:desktop_auth_exchange` (server)

**Description:**
The `POST /api/desktop/auth_exchange` endpoint accepts `platform_token` and creates or links local user accounts with no rate limiting, CAPTCHA, or proof-of-work. An attacker with a valid Platform token could repeatedly call this endpoint to enumerate which Platform user IDs have existing FeClaw accounts.

**Fix:** Add rate limiting (e.g., 5 attempts per IP per minute). Add a same-site CSRF cookie or `Origin` check.

---

### H-4: `verify_password` Uses Unsafe String Comparison

**Severity:** High
**Location:** `utils/auth.py:verify_password` (server)

**Description:**
`return hash_password(password, salt) == password_hash` uses `==` for constant-time-sensitive comparison. In CPython, `str.__eq__` short-circuits on the first mismatched byte, making it vulnerable to timing oracle attacks. While the impact is limited by the SHA-256 speed (already broken), fixing this is trivial and expected.

**Code snippet:**
```python
def verify_password(password: str, salt: str, password_hash: str) -> bool:
    return hash_password(password, salt) == password_hash
```

**Fix:** Use `hmac.compare_digest()` from the Python stdlib for constant-time comparison.

---

### H-5: Cloud WebSocket — No Replay Attack Prevention

**Severity:** High
**Location:** `src-tauri/src/ws.rs` + `routers/desktop_ws.py` (client + server)

**Description:**
The cloud WebSocket sends the same JWT on every reconnect. There is no `nonce` or `jti` (JWT ID) tracking on the server to detect replayed tokens. If a JWT is captured (e.g., from network traffic or a config file exfil), it can be replayed for up to 7 days.

**Fix:** Track issued JTIs in Redis/in-memory store with TTL matching token expiry. Reject any reconnect attempt with a `jti` that was already used.

---

## 🟡 Medium Findings

---

### M-1: CSP is Set to `null` in tauri.conf.json

**Severity:** Medium
**Location:** `src-tauri/tauri.conf.json` → `app.security.csp`

**Description:**
`"csp": null` means Tauri uses its default permissive CSP rather than a purpose-built policy. The default allows `default-src 'self'; script-src 'self'; object-src 'none'; connect-src 'self' https://*.feclaw.example.com` etc. The WebSocket target (`cloud_url`) is user-configurable and could be a malicious server, which the CSP does not restrict.

**Fix:** Set a minimal CSP that allows only necessary origins. Derive `connect-src` dynamically from `cloud_url` at startup ( Tauri's `csp` field supports runtime variables in Tauri 2):

```json
"csp": "default-src 'self'; script-src 'self'; connect-src 'self' $CLOUD_ORIGIN; frame-src 'none';"
```

---

### M-2: `CommandExecutor` Auto-Creates Parent Directories (CWD Escape Risk)

**Severity:** Medium
**Location:** `src-tauri/src/executor.rs:execute` (client)

**Description:**
If the `cwd` does not exist, `execute()` calls `tokio::fs::create_dir_all(cwd)` before running the command. While this is convenient, `create_dir_all` can create arbitrary nested directories anywhere on the filesystem if `cwd` is attacker-controlled. In this application's threat model, `cwd` comes from the server via the consent flow — but a compromised or malicious server could exploit this.

**Code snippet:**
```rust
if !cwd.exists() {
    if let Err(e) = tokio::fs::create_dir_all(cwd).await {
        return ExecResult { stderr: format!("failed to create cwd {}: {e}", cwd.display()), ... };
    }
}
```

**Fix:** Validate that `cwd` resolves to a path under a known-safe directory (e.g., the project root or a sandboxed temp dir) before creating it. Reject absolute paths or paths containing `..` that escape the project.

---

### M-3: No Message-Level Rate Limiting on Cloud WebSocket

**Severity:** Medium
**Location:** `src-tauri/src/ws.rs` + `routers/desktop_ws.py` (client + server)

**Description:**
The cloud WebSocket connection has no per-message rate limiting. A compromised or malicious server could send an unbounded flood of messages (e.g., repeated `consent_request` dialogs, `file_read_request`s) to overwhelm the client or exhaust memory.

**Fix:** Implement a client-side message queue with a maximum depth (e.g., 50 pending requests). Server-side: track messages/second per connection and disconnect clients exceeding a threshold.

---

### M-4: SQLite Database Has No File Permission Hardening

**Severity:** Medium
**Location:** `src-tauri/src/db.rs:with_conn` (client)

**Description:**
The SQLite database (`~/.feclaw/feclaw.db`) stores chat history, permission configs, prompt templates, and security audit logs — including `security_logs` table which records file operations and agent decisions. The DB is not encrypted (SQLite supports encryption via SEE or SQLCipher but is not used) and has default file permissions.

**Fix:** Use SQLCipher via `rusqlite` with a machine-derived key. Alternatively, at minimum set filesystem permissions on the DB file (0600) using `std::fs::set_permissions`.

---

### M-5: Consent Risk Classification is Entirely Client-Side

**Severity:** Medium
**Location:** `src-tauri/src/consent.rs` (client) + `services/desktop_relay.py:request_consent` (server)

**Description:**
Risk level (L1–L5) is determined entirely on the client side (`consent.rs`) and sent to the server in the `consent_request`. A malicious or compromised server could ignore the client's classification and execute arbitrary commands without ever showing a consent dialog to the user. The server-side `desktop_relay.py` trusts the `risk_level` field blindly.

The code comment says "风险分类在 Desktop 端完成" — this is a design choice, but it means a compromised server has full code execution capability on the Desktop machine with no guardrails.

**Fix:** Implement risk classification on the **server side** (`desktop_relay.py`) based on a server-maintained allowlist or blocklist of commands. Use the client-side classification only for UI ordering/filtering.

---

## 🔵 Low Findings

---

### L-1: JWT Expiry Set to 7 Days

**Severity:** Low
**Location:** `config.py` → `JWT_EXPIRE_HOURS = 24 * 7` (server)

**Description:**
Long-lived JWTs are a standard security concern. 7 days is moderate but could be reduced. No refresh token mechanism means users lose session on expiry.

**Fix:** Reduce to 1–24 hours for access tokens. Implement refresh token rotation.

---

### L-2: No Window Security Hardening in tauri.conf.json

**Severity:** Low
**Location:** `src-tauri/tauri.conf.json` → `app.windows[0]`

**Description:**
The window config has no `security` subsection (e.g., `disableNavigation`, `focus`), no `minWidth`/`minHeight` constraints, and `resizable: true`. While this is mostly usability, certain Tauri features (e.g., `file://` navigation) could be exploited if the CSP is weak.

**Fix:** Add window security constraints appropriate for a trusted-content app.

---

### L-3: `engine_path` Configurable Without Validation

**Severity:** Low
**Location:** `src-tauri/src/config.rs` → `Config.engine_path` (client)

**Description:**
`engine_path` is configurable in `config.toml`. If a user modifies it to point to a malicious binary, that binary runs as the same user. This is a user-controlled configuration, so the risk is limited to the user themselves — but a tampered `config.toml` could still be a supply-chain risk.

**Fix:** Warn users if `engine_path` points outside of standard install directories. Sign engine binaries and verify signature on load.

---

### L-4: UTF-8 Lossy Truncation in `CommandExecutor`

**Severity:** Low
**Location:** `src-tauri/src/executor.rs:truncate_output` (client)

**Description:**
`String::from_utf8_lossy` replaces invalid UTF-8 sequences with the Unicode replacement character, then truncation happens on byte boundaries with a char-boundary safety check. The check only goes backward from `max` to find a valid boundary, but if the replacement character itself straddles a boundary, output could be malformed. Impact: minor display glitch, no security implication.

**Code snippet:**
```rust
fn truncate_output(s: &mut String, max: usize) {
    if s.len() > max {
        let mut boundary = max;
        while !s.is_char_boundary(boundary) {
            boundary -= 1;
        }
        s.truncate(boundary);
    }
}
```

**Fix:** Use `s.is_char_boundary(boundary - 1)` check before decrementing, or decode bytes to chars first.

---

### L-5: DesktopPath Resolution — No Symlink/Escape Check

**Severity:** Low
**Location:** `services/desktop_relay.py:resolve_desktop_path` (server)

**Description:**
`resolve_desktop_path` blocks `..` segments but does not resolve symlinks. If a path component under `~/Desktop/` is a symlink to a sensitive directory (e.g., `~/.ssh/`), the relay would follow it. The `..` block helps, but symlinks are not checked.

**Code snippet:**
```python
# No symlink check
home = Path.home()
desktop = home / "Desktop"
return str(desktop / stripped)
```

**Fix:** After resolving, verify the final canonical path still starts with the desktop directory using `Path.resolve()` and a prefix check.

---

### L-6: No TLS Enforcement for Local Engine WebSocket

**Severity:** Low
**Location:** `src-tauri/src/config.rs:ws_url` (client)

**Description:**
In local mode, the WebSocket connects to `ws://127.0.0.1:{port}` — unencrypted. Since it's loopback, interception is not a concern on a single-user machine. However, if the Desktop app is running on a multi-user system, any local user could sniff loopback traffic.

**Fix:** Use `wss://` for local connections too (requires the local engine to support TLS, which is not currently assumed).

---

## ✅ Security Positives (What's Done Well)

1. **Command injection mitigated** — `CommandExecutor` uses `tokio::process::Command::new()` + `.args()` which passes command and args as separate argv (no shell interpolation). Rust's `std::process::Command` does not invoke a shell by default.

2. **Path traversal blocked** — `desktop_relay.py` checks for `..` segments and the `file_bridge.rs` also enforces `/mnt/desktop/` prefixing.

3. **Per-message agent_hash ownership check** — The global WS endpoint in `desktop_ws.py` checks `user_id` owns the agent on every message before processing.

4. **JWT close codes** — The server uses proper 4xxx close codes (4001 invalid, 4002 forbidden, 4004 not found) for WebSocket auth failures.

5. **Token persistence clears on auth failure** — `engine.rs` clears `cloud_token` on 4001/4002/4003 close codes and prompts re-login.

6. **Parameterized SQL queries** — All SQLite operations in `db.rs` use `?` placeholders (`conn.execute(..., params![...])`), eliminating SQL injection risk.

7. **Output truncation** — Command output is capped at 1 MiB to prevent WebSocket frame exhaustion.

8. **Input validation** — `truncate_output` uses `is_char_boundary` for safe UTF-8 truncation.

---

## Recommendations (Priority Order)

| Priority | Action | Finding |
|---|---|---|
| P0 | Migrate password hashing to bcrypt/Argon2 | C-1 |
| P0 | Enable TLS verification in httpx call to Platform | C-2 |
| P0 | Hardened file permissions on `config.toml` and `local-credentials` | C-3 |
| P1 | Implement JWT refresh token rotation | H-2 |
| P1 | Add rate limiting to `/api/desktop/auth_exchange` | H-3 |
| P1 | Replace `==` with `hmac.compare_digest` in `verify_password` | H-4 |
| P1 | Track JTIs to prevent JWT replay | H-5 |
| P1 | Implement server-side risk classification | M-5 |
| P2 | Set CSP to restrict connect-src to configured cloud_url | M-1 |
| P2 | Validate `cwd` path before `create_dir_all` | M-2 |
| P2 | Add WS message rate limiting | M-3 |
| P2 | Encrypt SQLite DB or harden file permissions | M-4 |
| P3 | Reduce JWT expiry + implement refresh tokens | L-1 |
| P3 | Add symlink escape check in path resolution | L-5 |
| P3 | Enforce TLS for local engine WS | L-6 |

---

*End of report.*
