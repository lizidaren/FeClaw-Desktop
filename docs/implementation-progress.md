# FeClaw Desktop V2 MVP Implementation Progress

Real-time log of step completion. One line per step (or a small block when a
step touches multiple files).

- ✅ **P0.1 camelCase audit** — verified all `invoke()` calls. `cloud_login` already uses `loginUrl` (commits e7f6aae, 694b89a). Other commands use single-word keys (no conversion needed).
- ✅ **P0.2 .well-known endpoint** — added `routers/well_known.py` exposing `GET /.well-known/feclaw-desktop` with `{version, name, auth: {type, endpoint}, ws_path}`. Registered in `main.py`. Committed in FeClaw repo.
- ✅ **P0.3 welcome page wiring** — `welcome.rs` commands + `open_welcome_window` registered in `lib.rs::invoke_handler`; first-launch detection in `setup` callback opens the window when `~/.feclaw/config.toml` is missing. (commit 888ea9c)
- ✅ **P0.4 cloud login full fix** — `cloud_login` already accepts `loginUrl` (Tauri 2 camelCase → `login_url` Rust). Login endpoint `/api/auth/login` with separate `cloud_login_url` field. Verified in `settings.ts:275` (`{ url, loginUrl, username, password }`). (commits e7f6aae, 694b89a, cc5c50f, a8fc102, c55526c)
- 🚧 **P0.5 main chat UI** — in progress: register `chat` commands, create `chat/` frontend (index.html, chat.ts, chat.css).
- ✅ **P1.1 local mode (方案C)** — `local_setup.rs` backend (12 commands: git/python prereq checks, clone, env template, pip install, engine start, health check, config save). `local_setup/` frontend (5-step wizard: prerequisites → directory → clone+config → install+start → connect). Wired in `lib.rs` (mod + invoke_handler) and `welcome.ts` (opens wizard on local mode selection). All Rust syntax checks pass (`-Z parse-crate-root-only`), TS compiled with esbuild. (commit dd512ea)
- ✅ **P0.1b re-audit (post-chat)** — re-checked all 22 commands after `lib.rs`/`ws.rs`/`ws_types.rs` modifications and new `chat.rs` + `chat/` frontend. Found **0 mismatches**: `send_consent_response` (Rust `op_id` → JS `opId`), `save_welcome_config` (Rust `args.{server_url, login_url}` → JS `args.{serverUrl, loginUrl}`), and `cloud_login` (`login_url` → `loginUrl`) all use correct camelCase. `file_read`/`file_write`/`file_delete`/`test_cloud_connection` have no JS callers (engine-side only). Recompiled all 3 pages with `npx esbuild` (settings.js 8.5kb, welcome.js 4.5kb, chat.js 10.9kb) — sizes unchanged, confirming .ts/.js were already in sync.


