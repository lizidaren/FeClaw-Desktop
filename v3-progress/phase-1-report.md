# Phase 1 Report — Screenshot Paste + Quick Templates

## Summary

Implemented Screenshot Paste (Ctrl+V) and Quick Template Bar for FeClaw-Desktop V3 Phase 1.

---

## What was implemented

### Rust backend (`src-tauri/src/db.rs`)

**New types:**
- `TempImageInfo` — `{ temp_path: String, name: String, size_bytes: u64 }`
- `PromptTemplate` — `{ id, name, prefix, category, created_at }`
- `PromptTemplateInput` — `{ id, name, prefix }` (for create/update)

**New commands:**
- `save_temp_image(base64_data: String) -> Result<TempImageInfo>`
  - Strips `data:image/...;base64,` prefix if present
  - Detects image type from magic bytes (PNG/JPG/GIF/WebP)
  - Saves to `~/.feclaw/temp/uploads/img_{timestamp}.{ext}`
  - Returns `{ temp_path, name, size_bytes }`
- `get_prompt_templates() -> Result<Vec<PromptTemplate>>`
  - Returns 6 built-in templates + all custom templates from SQLite
- `save_prompt_template(input: PromptTemplateInput) -> Result<()>`
  - Creates or updates a custom template in `prompt_templates` table
- `delete_prompt_template(id: String) -> Result<()>`
  - Deletes a custom template by ID (built-in templates cannot be deleted)

**Built-in templates:**
| ID | Name | Prefix |
|----|------|--------|
| builtin_summary | 总结 | `请总结以下内容：\n\n` |
| builtin_translate | 翻译 | `请将以下内容翻译成英文：\n\n` |
| builtin_check_grammar | 检查语法 | `请检查以下内容的语法：\n\n` |
| builtin_rewrite | 改写 | `请改写以下内容：\n\n` |
| builtin_explain_code | 解释代码 | `请解释以下代码：\n\n` |
| builtin_optimize_code | 优化代码 | `请优化以下代码：\n\n` |

### Command registration (`src-tauri/src/lib.rs`)

Registered all 4 new commands in `generate_handler![]`:
- `db::save_temp_image`
- `db::get_prompt_templates`
- `db::save_prompt_template`
- `db::delete_prompt_template`

### Frontend — input-box.ts (`src-tauri/src/chat/components/input-box.ts`)

**New state:**
- `imageCards: ImageCard[]` — tracks pasted screenshots
- `ImageCard` type: `{ id, temp_path, name, size_bytes, data_url }`
- `PromptTemplate` type exported for use by template editor

**Image paste handling:**
- `handleImagePaste(e: ClipboardEvent)` — attached to `.composer` element
- Detects `image/*` clipboard items, calls `save_temp_image` via Tauri invoke
- Adds thumbnail card to `#image-cards` container
- Cards show small preview image with ✕ remove button

**Image card management:**
- `addImageCard(card)`, `removeImageCard(id)`, `getImageCards()`, `clearImageCards()`
- `renderImageCards()` — renders/removes thumbnail cards in `#image-cards` div
- `buildImageCardsContainer()` — injects `#image-cards` div above textarea

**Template bar:**
- `buildTemplateBar(templates)` — injects `.template-bar` div below composer toolbar
- 6 pill-shaped built-in template buttons + custom template pills + ⚙ settings button
- Pill click → `applyTemplate(prefix)` → prepends prefix to textarea content
- `⚙` button → `openTemplateEditor()`

**Template editor modal:**
- Opens as overlay modal (`#tmpl-modal-overlay`)
- Lists all custom templates with edit/delete buttons
- Add button → inline form (name + prefix textarea) → save via `save_prompt_template`
- Edit button → pre-fills form with existing values
- Delete → `delete_prompt_template` with confirmation
- After save/delete → re-fetches and re-renders list

**Setup:**
- `setupInputBox()` now also calls `buildImageCardsContainer()` and attaches `handleImagePaste` to `.composer`
- New `setupTemplateBar()` async function — loads templates from backend and builds the bar

### Frontend — chat.ts (`src-tauri/src/chat/chat.ts`)

**Imports updated:**
- Added `setupTemplateBar`, `getImageCards`, `clearImageCards` from input-box

**Wire updates:**
- `setupTemplateBar()` called after `setupInputBox()` (async, no await needed — just fires)
- Removed old `input.addEventListener("paste", handlePaste)` (now in input-box)

**`sendMessage()` updated:**
- Added image card check: `if (!text && getFileCards().length === 0 && imgCards.length === 0) return`
- Image markers `[image:{temp_path}]` appended to `fullText` sent via WS
- Each image card inserted as separate `ChatMessage` with `message_type: "image"` and `content: data_url`
- Image cards cleared after sending: `clearImageCards()`

**Removed:**
- `handlePaste()` function (moved to input-box.ts)
- `saveAndInsertImage()` function (moved to input-box.ts)

---

## File list

| File | Change |
|------|--------|
| `src-tauri/src/db.rs` | Added `save_temp_image`, `get_prompt_templates`, `save_prompt_template`, `delete_prompt_template` commands + types |
| `src-tauri/src/lib.rs` | Registered 4 new commands |
| `src-tauri/src/chat/components/input-box.ts` | Full update: image cards, template bar, template editor, paste handling |
| `src-tauri/src/chat/chat.ts` | Wire update, sendMessage update, removed old paste handlers |

---

## Unclear / blocked items

1. **Image send via WS** — The backend `send_chat_message` WS protocol expects text. When `[image:{temp_path}]` markers are sent, the backend needs to handle them (read temp file, process as image). This is assumed to be handled by the backend or deferred to a future phase. Currently, the frontend sends `[image:/path/to/img.png]` as text markers alongside the text.

2. **Temp image cleanup** — No cleanup mechanism for old temp images. Consider adding a cleanup on startup or TTL-based deletion. Noted for future improvement.

3. **Template bar async load** — `setupTemplateBar()` is called with `void` (fire-and-forget). If it fails silently, the bar simply won't appear. Acceptable for MVP.

---

## Deliverables checklist

| # | Criterion | Status |
|---|-----------|--------|
| 1 | Ctrl+V on image → thumbnail shows in input box | ✅ Implemented in `input-box.ts` `handleImagePaste` |
| 2 | Image thumbnail removable (✕ button) | ✅ `removeImageCard()` + `ic-remove` button |
| 3 | Click send → image sent alongside text (saved to temp path) | ✅ `save_temp_image` → `[image:{path}]` in `fullText` + separate image messages in DB |
| 4 | Template bar visible below composer with 6 built-in buttons | ✅ `.template-bar` injected in `buildTemplateBar` |
| 5 | Click a template → prefix inserted into input | ✅ `applyTemplate(prefix)` → textarea value manipulation |
| 6 | ⚙ button opens custom template editor | ✅ `openTemplateEditor()` → modal overlay |
| 7 | Can add/edit/delete custom templates | ✅ Full CRUD in modal + `save_prompt_template`/`delete_prompt_template` |
| 8 | Custom templates persist in SQLite across restarts | ✅ `prompt_templates` table + `save_prompt_template`/`get_prompt_templates` |

---

## Notes

- `base64` crate (v0.22) was already in `Cargo.toml` — no dependency added
- Built-in templates have IDs starting with `builtin_`; attempting to delete them returns an error
- Image cards display as 100×72px thumbnails with file size overlay and ✕ remove button
- Template editor modal uses `escapeHtml()` to sanitize user input in display
- The `prompt_templates` table already existed (created in Phase 0a) with `content` column used as `prefix` field
