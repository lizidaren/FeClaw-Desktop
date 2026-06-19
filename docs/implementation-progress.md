# FeClaw Desktop V2 MVP Implementation Progress

Real-time log of step completion. One line per step (or a small block when a
step touches multiple files).

- ✅ **P0.1 camelCase audit** — verified all `invoke()` calls. `cloud_login` already uses `loginUrl` (commits e7f6aae, 694b89a). Other commands use single-word keys (no conversion needed).
- ✅ **P0.2 .well-known endpoint** — added `routers/well_known.py` exposing `GET /.well-known/feclaw-desktop` with `{version, name, auth: {type, endpoint}, ws_path}`. Registered in `main.py`. Committed in FeClaw repo.


