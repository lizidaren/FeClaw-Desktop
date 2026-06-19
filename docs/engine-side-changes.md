# Engine-Side Changes (V2)

Items that require changes to the FeClaw engine (`/home/lch/Projects/FeClaw/`), not the Desktop app. These are out of scope for the current P1 audit fix round but are documented here for tracking.

---

## WebSocket Protocol Extensions

### `file_delete_request` inbound (Desktop ← Engine)

Engine should send this when an Agent requests file deletion (risk L3).

```json
{
  "type": "file_delete_request",
  "id": "req-xxx",
  "payload": { "path": "/path/to/file" }
}
```

### `file_delete_response` outbound (Desktop → Engine)

Desktop responds:

```json
{
  "type": "file_delete_response",
  "id": "req-xxx",
  "status": "accepted" | "error",
  "payload": { ... }
}
```

MVP Desktop returns `status: "error", payload.error: "file bridge not implemented in MVP"`.

V2: implement actual file deletion via COS-backed VFS.

### `consent_response` outbound (Desktop → Engine)

When the Desktop consent dialog is decoupled from `command_exec_response` (V2), the Desktop should send an independent consent message:

```json
{
  "type": "consent_response",
  "id": "consent-xxx",
  "decision": "allow" | "deny" | "always_allow",
  "reason": "optional free-text reason"
}
```

Note: Currently decisions are merged into `command_exec_response.payload.reason` ("denied by user"). V2 should use this independent channel.

### `disconnect` outbound (Desktop → Engine)

When Desktop shuts down or loses connection intentionally, send:

```json
{
  "type": "disconnect",
  "reason": "user_quit" | "engine_exit" | "reconnecting"
}
```

This lets the Agent immediately release resources rather than waiting for WS timeout.

### `timestamp` field on all messages

Design §4.3 includes `timestamp` on all messages. Both inbound and outbound messages should include ISO-8601 timestamp:

```json
{
  "type": "...",
  "id": "...",
  "timestamp": "2026-06-19T10:30:00Z",
  ...
}
```

---

## Engine Accepts `--config` Argument

Design §7.2 specifies:

```
feclaw --config ~/.feclaw/config.toml
```

The Desktop app now passes `--config ~/.feclaw/config.toml` when spawning the engine process. The engine should read this path and load `~/.feclaw/config.toml` as its configuration file (instead of requiring the user to manually place a config at that location).

If the engine does not yet support `--config`, this is harmless — the engine ignores unknown arguments. When the engine gains `--config` support, Desktop will automatically use it.

---

## Pending exec_id Queue / Disconnect Handling

Design §4.4: when WS disconnects mid-execution, Desktop loses track of pending `exec_id`s. V2 should:

1. On WS disconnect, send `disconnect` message to engine with reason `"reconnecting"`.
2. Engine should maintain a queue of pending `exec_id`s for that desktop session.
3. On reconnect, Desktop can query engine for in-flight exec_ids and reconcile state.
4. Deduplicate: if the same `exec_id` arrives twice (once via old WS, once via new WS), reject the duplicate.

---

## Health Check on Reconnect

Currently Desktop only checks engine health at startup (`wait_healthy`). V2 should also verify engine health after a WS reconnect, before sending new commands, to avoid sending commands to a stale engine instance.
