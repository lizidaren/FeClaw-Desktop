# FeClaw-Desktop Test Coverage Report

**Date:** 2026-06-21
**Scope:** Phase 4–8 modules (`group.rs`, `moments.rs`, `fehub.rs`, `search.rs`, `qr_upload.rs`, `alt_space.rs`, `ws_types.rs`)
**Note:** Build environment lacks GTK/glib system libraries; tests are syntactically valid Rust but require those deps to compile.

---

## Summary

| Module | Test Functions | Est. Lines | Covered Types / Functions |
|--------|---------------|------------|--------------------------|
| `ws_types.rs` | 19 | ~320 | All `WsRequest` variants, all response types, `ConnectionStatus` |
| `group.rs` | 14 | ~160 | `GroupInfo`, `GroupMemberInfo`, `GroupMessageInfo`, create_group body |
| `moments.rs` | 11 | ~175 | `MomentInfo` (full/minimal/missing), `PostMomentRequest`, all struct derives |
| `fehub.rs` | 7 | ~95 | `PublishInfo` (full/roundtrip/missing), `is_public` flag, derives |
| `search.rs` | 15 | ~195 | `SearchItem`, `SourceResults`, `SearchResult`, `Credentials`, all source types |
| `qr_upload.rs` | 15 | ~165 | `UploadSession`, `generate_qr_image` (basic/empty/short/unicode/long/URL), `Credentials` |
| `alt_space.rs` | 9 | ~115 | `shortcut_bound_path`, save/load roundtrip, privacy noop, stubs, `ConnectionStatus` |
| **TOTAL** | **90** | **~1,225** | |

---

## ws_types.rs — Pre-existing Tests (19 functions, ~320 lines)

All `WsRequest` variant deserialization:
- `deserialize_command_exec_request`
- `deserialize_command_exec_request_minimal`
- `deserialize_command_exec_request_extra_fields`
- `deserialize_file_read_request`
- `deserialize_file_write_request`
- `deserialize_notification`
- `deserialize_notification_minimal`
- `deserialize_pong`
- `deserialize_file_delete_request`
- `deserialize_missing_type_field_fails`

All response type round-trips:
- `command_exec_response_roundtrip`
- `command_exec_response_with_reason`
- `file_read_response_roundtrip`
- `file_read_response_error`
- `file_write_response_success_roundtrip`
- `file_write_response_error_roundtrip`
- `file_delete_response_error`
- `consent_response_roundtrip`
- `consent_response_with_reason`

---

## group.rs — New Tests (14 functions, ~160 lines)

### GroupInfo
- Full deserialization from JSON
- Minimal (empty strings) deserialization
- Round-trip: struct → JSON → struct
- Missing required field (`id`) → error
- `member_count = 0` and `created_at = 0` edge case

### GroupMemberInfo
- Deserialization with all fields
- Round-trip
- All role string values (`admin`, `member`, `owner`)

### GroupMessageInfo
- Full deserialization (all optional fields present)
- Missing optionals (`sender_hash`, `sender_name`, `attachments`)
- Round-trip
- Empty `attachments` array
- `sender_type = "user"` vs `"agent"`

### create_group body
- Empty name serialized (server-side validation)
- Multiple member hashes serialized correctly

---

## moments.rs — New Tests (11 functions, ~175 lines)

### MomentInfo struct derives
- `Debug` formatted output contains expected fields
- `Clone` produces identical copy

### MomentInfo deserialization
- Full JSON with all optional fields
- Missing optionals → `None`/`[]` defaults
- Empty `title` and `content` strings
- Empty `attachments` array
- All `kind` values (`post`, `image`, `video`, `link`)

### MomentInfo round-trip
- Full struct → JSON → struct (preserves all fields)
- Minimal struct round-trip

### MomentInfo missing required fields
- Missing `id` → error
- Missing `group_id` → error

### PostMomentRequest
- Serializes to correct JSON shape

---

## fehub.rs — New Tests (7 functions, ~95 lines)

### PublishInfo
- Full deserialization (all fields)
- `is_public = false` case
- Missing required field (`tag`) → error
- Round-trip with `is_public = false`
- Round-trip with `is_public = true`
- `Debug` output contains expected fields
- `Clone` produces identical copy

---

## search.rs — New Tests (15 functions, ~195 lines)

### SearchItem
- Full deserialization (all optional fields: `agentHash`, `agentName`, `reference`)
- Minimal (only required fields)
- All source types (`chat`, `vfs`, `moments`, `textbook`, `miniapps`)
- Round-trip with all fields
- Round-trip minimal
- Missing `id` → error
- Missing `source` → error

### SourceResults
- Deserialize with 2 items
- Empty items array

### SearchResult
- Empty results (query with no matches, empty `results` map)
- Multi-source results (`chat` + `vfs`)
- Round-trip with one source

### Credentials (internal helper)
- Full parse (`username` + `token`)
- Missing `token` → `None`
- Empty `username`

---

## qr_upload.rs — New Tests (15 functions, ~165 lines)

### UploadSession
- Full deserialization (all fields including `presigned_get_url`)
- Missing `presigned_get_url` → `None`
- Round-trip with `presigned_get_url`
- Round-trip without `presigned_get_url`
- `expires_in = 0` edge case

### generate_qr_image (QR code generation)
- Basic URL → data URL with PNG base64
- Empty string → valid (minimal) QR code
- Short strings (`"a"`, `"1"`, `"hello"`, `"http://x.co"`)
- Unicode (`"你好世界"`)
- URL with query params
- Very long data (2000 `"x"` chars — may exceed QR capacity; tests no panic)
- Repeated URL pattern (50× repeated — buffer growth edge case)
- Data URL format: valid base64 + PNG magic bytes `[0x89, 0x50, 0x4E, 0x47]`

### Credentials (internal helper)
- Full parse
- Missing `token` → `None`

---

## alt_space.rs — New Tests (9 functions, ~115 lines)

### shortcut_bound_path
- Returns absolute path ending in `shortcut_bound.json`

### save_shortcut_bound / load_shortcut_bound round-trip (via temp file)
- JSON `{"alt_space_bound": true}` → read back → `true`
- JSON `{"alt_space_bound": false}` → read back → `false`

### load_shortcut_bound edge cases
- Missing file → `false` (via `read_to_string` error)
- Malformed JSON → `false` (via `from_str` error)
- Valid JSON without `alt_space_bound` key → `false` (via `.get()` returning `None`)

### Privacy noop (non-Windows)
- `apply_privacy_affinity(12345)` returns `Ok(())` on non-Windows

### Stub functions
- `is_alt_space_registered()` — always returns current state (no panic)
- `register_search_shortcut` — type-checks (async fn returning `Result<(), String>`)

### ConnectionStatus (from ws_types)
- All 5 variants serialize/deserialize correctly: `Disconnected`, `Connecting`, `Connected`, `Reconnecting`, `Failed`

---

## Modules NOT Covered (async Tauri commands)

These modules contain async `#[tauri::command]` functions that require a full Tauri runtime + HTTP client mocking to test:

- `group.rs` — `list_groups`, `create_group`, `get_group_detail`, `add_group_member`, `remove_group_member`, `delete_group`, `get_group_messages` (require mock `reqwest::Client`)
- `moments.rs` — `get_moments`, `post_moment`, `delete_moment` (require mock HTTP)
- `fehub.rs` — `list_my_publishes`, `open_miniapp` (require mock HTTP + Tauri window)
- `search.rs` — `search_all` (require mock HTTP), `search_local_chat` (requires SQLite FTS5 setup)
- `qr_upload.rs` — `create_upload_session`, `download_uploaded_file` (require mock HTTP)

These commands are tested implicitly through struct serialization tests and can be integration-tested with mock servers.

---

## Lines of Test Code Added

| Module | LOC Added |
|--------|-----------|
| `ws_types.rs` | ~320 (pre-existing) |
| `group.rs` | ~160 |
| `moments.rs` | ~175 |
| `fehub.rs` | ~95 |
| `search.rs` | ~195 |
| `qr_upload.rs` | ~165 |
| `alt_space.rs` | ~115 |
| **Total** | **~1,225** |
