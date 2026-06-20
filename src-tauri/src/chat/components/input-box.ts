// =========================================================
// FeClaw Desktop — Extended Input Box (Phase 1 V3)
// =========================================================
//
// Adds (Phase 0b + Phase 1):
//   - 📎 attachment button in the composer toolbar
//   - Popup menu: 本地文件 / 云文件
//   - File reference cards embedded in the composer
//   - Cards can be removed; user continues typing below them
//   - Ctrl+V screenshot paste → thumbnail in composer
//   - Quick template bar (6 built-in + custom CRUD)
//
// Cards are rendered above the textarea. The textarea retains
// its original behaviour. On send, file cards are serialised
// alongside the text into the message payload.
//
// Architecture:
//   setupInputBox() is called once from chat.ts wire().
//   The component owns the attachment menu state and the file-card list.
//   chat.ts's sendMessage() reads the current cards via getFileCards()
//   and getImageCards().

import type { AgentInfo } from "../store";

type TauriCore = {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>;
};

function getTauri(): TauriCore {
  const g = (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__;
  if (!g?.core) throw new Error("Tauri global not available");
  return g.core;
}

const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  getTauri().invoke<T>(cmd, args);

// ---- Types (must mirror Rust PickedFile in create.rs) ----

export type PickedFile = {
  id: string;
  name: string;
  path: string;
  size_label: string;
  mode: string; // "reference" | "send_copy"
  size_bytes: number;
};

export type ImageCard = {
  id: string;
  temp_path: string;
  name: string;
  size_bytes: number;
  data_url: string; // base64 data URL for thumbnail display
};

export type PromptTemplate = {
  id: string;
  name: string;
  prefix: string;
  category: string; // "builtin" | "custom"
  created_at: number;
};

// ---- State ----

let fileCards: PickedFile[] = [];
let imageCards: ImageCard[] = [];
let menuVisible = false;
let templateBarVisible = false;

// ---- Inject styles ----

function injectStyles(): void {
  if (document.getElementById("ib-styles")) return;
  const style = document.createElement("style");
  style.id = "ib-styles";
  style.textContent = `
/* Input-box component styles */
.composer-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 16px 0;
  background: var(--bg-elev);
}
.btn-attach {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}
.btn-attach:hover { background: var(--bg-hover); color: var(--text); }

/* Attachment menu */
.attach-menu {
  position: relative;
}
.attach-dropdown {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 200px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow);
  z-index: 200;
  overflow: hidden;
  display: none;
}
.attach-dropdown.open { display: block; }
.attach-dropdown-section {
  padding: 6px 0 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding-left: 12px;
}
.attach-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 14px;
  color: var(--text);
  transition: background 0.12s;
  border: none;
  background: transparent;
  width: 100%;
  text-align: left;
  font-family: inherit;
}
.attach-item:hover { background: var(--bg-hover); }
.attach-item.disabled {
  opacity: 0.45;
  cursor: not-allowed;
  pointer-events: none;
}
.attach-item-icon { font-size: 15px; }
.attach-item-text { flex: 1; }
.attach-item-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--border);
  color: var(--text-muted);
}
.attach-submenu {
  position: relative;
}
.attach-submenu-items {
  display: none;
  position: absolute;
  left: calc(100% + 2px);
  top: 0;
  min-width: 180px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.attach-submenu:hover .attach-submenu-items { display: block; }
.attach-submenu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text);
  transition: background 0.12s;
  border: none;
  background: transparent;
  width: 100%;
  text-align: left;
  font-family: inherit;
}
.attach-submenu-item:hover { background: var(--bg-hover); }

/* File cards */
.file-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 16px 0;
}
.fc-card {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 10px;
  border-radius: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  font-size: 13px;
  color: var(--text);
  max-width: 220px;
  animation: fcIn 0.15s ease-out;
}
@keyframes fcIn {
  from { opacity: 0; transform: scale(0.92); }
  to   { opacity: 1; transform: scale(1); }
}
.fc-icon { font-size: 14px; flex-shrink: 0; }
.fc-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}
.fc-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.fc-size { font-size: 11px; color: var(--text-muted); }
.fc-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  flex-shrink: 0;
}
.fc-badge.ref {
  background: rgba(56, 189, 248, 0.15);
  color: var(--primary);
}
.fc-badge.copy {
  background: rgba(251, 191, 36, 0.15);
  color: var(--warning);
}
.fc-remove {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}
.fc-remove:hover { background: var(--bg-hover); color: var(--error); }
.fc-badge.ref { background: rgba(56, 189, 248, 0.15); color: var(--primary); }
.fc-badge.copy { background: rgba(251, 191, 36, 0.15); color: var(--warning); }

/* Image cards (pasted screenshots) */
.image-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 16px 0;
}
.ic-card {
  position: relative;
  display: inline-flex;
  align-items: center;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
  animation: fcIn 0.15s ease-out;
  max-width: 120px;
}
.ic-card img {
  display: block;
  width: 100px;
  height: 72px;
  object-fit: cover;
}
.ic-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: rgba(0,0,0,0.5);
  color: white;
  cursor: pointer;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.12s;
}
.ic-remove:hover { background: var(--error); }
.ic-size {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(0,0,0,0.4);
  color: white;
  font-size: 9px;
  padding: 1px 4px;
  text-align: center;
}

/* Template bar */
.template-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px 0;
  flex-wrap: wrap;
}
.tmpl-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
  font-family: inherit;
  white-space: nowrap;
}
.tmpl-pill:hover {
  background: var(--bg-hover);
  border-color: var(--primary);
  color: var(--primary);
}
.tmpl-pill.builtin { border-color: var(--border); }
.tmpl-pill.custom { border-color: var(--primary); color: var(--primary); }
.tmpl-settings {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  transition: background 0.12s, color 0.12s;
  font-family: inherit;
}
.tmpl-settings:hover { background: var(--bg-hover); color: var(--text); }

/* Template editor modal */
.tmpl-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  z-index: 500;
  display: flex;
  align-items: center;
  justify-content: center;
}
.tmpl-modal {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 14px;
  width: 480px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.tmpl-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-soft);
  flex-shrink: 0;
}
.tmpl-modal-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.tmpl-modal-close {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s;
}
.tmpl-modal-close:hover { background: var(--bg-hover); color: var(--text); }
.tmpl-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}
.tmpl-add-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
  transition: background 0.12s, color 0.12s;
  margin-bottom: 12px;
}
.tmpl-add-btn:hover { background: var(--bg-hover); color: var(--text); }
.tmpl-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-soft);
  margin-bottom: 8px;
  background: var(--bg);
}
.tmpl-item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.tmpl-item-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.tmpl-item-actions {
  display: flex;
  gap: 4px;
}
.tmpl-item-btn {
  padding: 2px 8px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  transition: background 0.12s, color 0.12s;
}
.tmpl-item-btn:hover { background: var(--bg-hover); color: var(--text); }
.tmpl-item-btn.delete:hover { background: rgba(248,113,113,0.1); color: var(--error); }
.tmpl-item-preview {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 380px;
}
.tmpl-empty {
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  padding: 20px;
}
.tmpl-editor-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--primary);
  background: rgba(56,189,248,0.05);
  margin-bottom: 8px;
}
.tmpl-form-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tmpl-form-label {
  font-size: 12px;
  color: var(--text-muted);
  min-width: 40px;
}
.tmpl-form-input {
  flex: 1;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  outline: none;
}
.tmpl-form-input:focus { border-color: var(--primary); }
.tmpl-form-textarea {
  width: 100%;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  resize: vertical;
  min-height: 60px;
}
.tmpl-form-textarea:focus { border-color: var(--primary); }
.tmpl-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.tmpl-btn-cancel {
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  transition: background 0.12s;
}
.tmpl-btn-cancel:hover { background: var(--bg-hover); }
.tmpl-btn-save {
  padding: 5px 12px;
  border-radius: 6px;
  border: none;
  background: var(--primary);
  color: white;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  transition: background 0.12s;
}
.tmpl-btn-save:hover { background: var(--primary-dark); }
`;
  document.head.appendChild(style);
}

// ---- Menu toggle ----

function toggleMenu(): void {
  menuVisible = !menuVisible;
  const dropdown = document.getElementById("attach-dropdown");
  if (dropdown) dropdown.classList.toggle("open", menuVisible);
}

function closeMenu(): void {
  menuVisible = false;
  const dropdown = document.getElementById("attach-dropdown");
  if (dropdown) dropdown.classList.remove("open");
}

// ---- Pick local file ----

async function pickFile(mode: "reference" | "send_copy"): Promise<void> {
  closeMenu();
  const label = mode === "reference" ? "引用" : "发送";
  try {
    const file = await invoke<PickedFile | null>("pick_local_file", { mode });
    if (file) {
      addCard(file);
    }
  } catch (err) {
    console.error("pick_local_file failed:", err);
  }
}

// ---- Cloud file (placeholder) ----

function openCloudBrowser(): void {
  closeMenu();
  // Phase 0b placeholder: VFS browser deferred to Phase 2
  // Show a temporary toast-like notice
  const notice = document.createElement("div");
  notice.style.cssText = `
    position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
    background: var(--bg-elev); border: 1px solid var(--border);
    color: var(--text); padding: 10px 18px; border-radius: 10px;
    font-size: 13px; z-index: 9999; box-shadow: var(--shadow);
    animation: fcIn 0.2s ease-out;
  `;
  notice.textContent = "☁️ 云文件浏览器（Phase 2 实现）";
  document.body.appendChild(notice);
  setTimeout(() => notice.remove(), 2500);
}

// ---- Card management ----

function addCard(file: PickedFile): void {
  fileCards.push(file);
  renderCards();
}

export function removeCard(id: string): void {
  fileCards = fileCards.filter((f) => f.id !== id);
  renderCards();
}

export function getFileCards(): PickedFile[] {
  return [...fileCards];
}

export function clearFileCards(): void {
  fileCards = [];
  renderCards();
}

function renderCards(): void {
  let container = document.getElementById("file-cards");
  if (!container) return;

  if (fileCards.length === 0) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }

  container.style.display = "flex";
  container.innerHTML = "";

  for (const file of fileCards) {
    const card = document.createElement("span");
    card.className = "fc-card";
    card.dataset.id = file.id;
    card.innerHTML = `
      <span class="fc-icon">📄</span>
      <span class="fc-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      <span class="fc-meta">
        <span class="fc-size">${file.size_label}</span>
        <span class="fc-badge ${file.mode === "reference" ? "ref" : "copy"}">${file.mode === "reference" ? "引用" : "发送"}</span>
        <button class="fc-remove" title="移除" aria-label="移除文件">✕</button>
      </span>
    `;
    card.querySelector(".fc-remove")!.addEventListener("click", (e) => {
      e.stopPropagation();
      removeCard(file.id);
    });
    container.appendChild(card);
  }
}

// ---- Image card management ----

export function addImageCard(card: ImageCard): void {
  imageCards.push(card);
  renderImageCards();
}

export function removeImageCard(id: string): void {
  imageCards = imageCards.filter((c) => c.id !== id);
  renderImageCards();
}

export function getImageCards(): ImageCard[] {
  return [...imageCards];
}

export function clearImageCards(): void {
  imageCards = [];
  renderImageCards();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function renderImageCards(): void {
  let container = document.getElementById("image-cards");
  if (!container) return;

  if (imageCards.length === 0) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }

  container.style.display = "flex";
  container.innerHTML = "";

  for (const img of imageCards) {
    const card = document.createElement("span");
    card.className = "ic-card";
    card.dataset.id = img.id;
    card.innerHTML = `
      <img src="${img.data_url}" alt="${escapeHtml(img.name)}" />
      <button class="ic-remove" title="移除图片" aria-label="移除图片">✕</button>
      <span class="ic-size">${formatBytes(img.size_bytes)}</span>
    `;
    card.querySelector(".ic-remove")!.addEventListener("click", (e) => {
      e.stopPropagation();
      removeImageCard(img.id);
    });
    container.appendChild(card);
  }
}

// ---- Image cards container ----

function buildImageCardsContainer(): void {
  const composer = document.querySelector<HTMLElement>(".composer");
  if (!composer) return;

  const container = document.createElement("div");
  container.id = "image-cards";
  container.className = "image-cards";
  container.style.display = "none";

  const textarea = composer.querySelector<HTMLElement>("textarea");
  composer.insertBefore(container, textarea);
}

// ---- Paste image handling ----

function handleImagePaste(e: ClipboardEvent): void {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) return;
      void saveAndInsertImage(file);
      return;
    }
  }
}

async function saveAndInsertImage(file: File): Promise<void> {
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const base64 = ev.target?.result as string;
    if (!base64) return;
    try {
      const info = await invoke<{ temp_path: string; name: string; size_bytes: number }>(
        "save_temp_image",
        { base64Data: base64 },
      );
      addImageCard({
        id: `img-${Date.now()}`,
        temp_path: info.temp_path,
        name: info.name,
        size_bytes: info.size_bytes,
        data_url: base64,
      });
    } catch (err) {
      console.error("save_temp_image failed:", err);
    }
  };
  reader.readAsDataURL(file);
}

// ---- Template bar ----

let editorVisible = false;

async function openTemplateEditor(): Promise<void> {
  if (editorVisible) return;
  editorVisible = true;

  const templates = await loadTemplates();
  renderTemplateEditorModal(templates);
}

function closeTemplateEditorModal(): void {
  editorVisible = false;
  const overlay = document.getElementById("tmpl-modal-overlay");
  overlay?.remove();
}

async function loadTemplates(): Promise<PromptTemplate[]> {
  try {
    return await invoke<PromptTemplate[]>("get_prompt_templates");
  } catch {
    return [];
  }
}

function applyTemplate(prefix: string): void {
  const input = document.querySelector<HTMLTextAreaElement>(".composer textarea");
  if (!input) return;
  const hasContent = input.value.trim().length > 0;
  input.value = hasContent ? input.value + "\n" + prefix : prefix;
  input.focus();
  // Trigger autoResize if available
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

let editingTemplate: PromptTemplate | null = null;

function renderTemplateEditorModal(templates: PromptTemplate[]): void {
  // Remove existing
  document.getElementById("tmpl-modal-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "tmpl-modal-overlay";
  overlay.id = "tmpl-modal-overlay";
  overlay.innerHTML = `
    <div class="tmpl-modal">
      <div class="tmpl-modal-header">
        <span class="tmpl-modal-title">自定义模板</span>
        <button class="tmpl-modal-close" id="tmpl-modal-close-btn">✕</button>
      </div>
      <div class="tmpl-modal-body" id="tmpl-modal-body">
        <button class="tmpl-add-btn" id="tmpl-add-btn">+ 添加自定义模板</button>
        <div id="tmpl-list"></div>
        <div id="tmpl-editor-area" style="display:none;"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeTemplateEditorModal();
  });

  document.getElementById("tmpl-modal-close-btn")?.addEventListener("click", closeTemplateEditorModal);

  renderTemplateList(templates);

  document.getElementById("tmpl-add-btn")?.addEventListener("click", () => {
    editingTemplate = null;
    showTemplateForm("");
  });
}

function renderTemplateList(templates: PromptTemplate[]): void {
  const list = document.getElementById("tmpl-list");
  if (!list) return;

  const customTemplates = templates.filter((t) => t.category === "custom");

  if (customTemplates.length === 0) {
    list.innerHTML = '<div class="tmpl-empty">暂无自定义模板，点击上方按钮添加</div>';
    return;
  }

  list.innerHTML = "";
  for (const tmpl of customTemplates) {
    const item = document.createElement("div");
    item.className = "tmpl-item";
    item.dataset.id = tmpl.id;
    item.innerHTML = `
      <div class="tmpl-item-header">
        <span class="tmpl-item-name">${escapeHtml(tmpl.name)}</span>
        <div class="tmpl-item-actions">
          <button class="tmpl-item-btn edit-btn" data-id="${tmpl.id}">编辑</button>
          <button class="tmpl-item-btn delete delete-btn" data-id="${tmpl.id}">删除</button>
        </div>
      </div>
      <div class="tmpl-item-preview">${escapeHtml(tmpl.prefix)}</div>
    `;
    list.appendChild(item);
  }

  list.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = (btn as HTMLElement).dataset.id!;
      const tmpl = customTemplates.find((t) => t.id === id)!;
      editingTemplate = tmpl;
      showTemplateForm(tmpl.prefix, tmpl.name);
    });
  });

  list.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = (btn as HTMLElement).dataset.id!;
      if (!confirm("确定删除该模板？")) return;
      try {
        await invoke("delete_prompt_template", { id });
        const all = await loadTemplates();
        renderTemplateList(all);
      } catch (err) {
        console.error("delete_prompt_template failed:", err);
      }
    });
  });
}

function showTemplateForm(initialPrefix = "", initialName = ""): void {
  const area = document.getElementById("tmpl-editor-area");
  const list = document.getElementById("tmpl-list");
  if (!area || !list) return;

  list.style.display = "none";
  const addBtn = document.getElementById("tmpl-add-btn");
  if (addBtn) addBtn.style.display = "none";

  area.style.display = "block";
  area.innerHTML = `
    <div class="tmpl-editor-form">
      <div class="tmpl-form-row">
        <label class="tmpl-form-label">名称</label>
        <input class="tmpl-form-input" id="tmpl-name-input" type="text" placeholder="模板名称，如：总结" value="${escapeHtml(initialName)}" />
      </div>
      <div>
        <label class="tmpl-form-label" style="display:block;margin-bottom:4px;">前缀文本</label>
        <textarea class="tmpl-form-textarea" id="tmpl-prefix-input" placeholder="如：请总结以下内容：\n\n">${escapeHtml(initialPrefix)}</textarea>
      </div>
      <div class="tmpl-form-actions">
        <button class="tmpl-btn-cancel" id="tmpl-form-cancel">取消</button>
        <button class="tmpl-btn-save" id="tmpl-form-save">保存</button>
      </div>
    </div>
  `;

  area.querySelector("#tmpl-form-cancel")?.addEventListener("click", () => {
    area.style.display = "none";
    if (list) list.style.display = "";
    if (addBtn) addBtn.style.display = "";
    editingTemplate = null;
  });

  area.querySelector("#tmpl-form-save")?.addEventListener("click", async () => {
    const nameInput = document.getElementById("tmpl-name-input") as HTMLInputElement;
    const prefixInput = document.getElementById("tmpl-prefix-input") as HTMLTextAreaElement;
    const name = nameInput?.value.trim();
    const prefix = prefixInput?.value ?? "";

    if (!name) {
      nameInput?.focus();
      return;
    }

    const id = editingTemplate?.id ?? `custom_${Date.now()}`;
    try {
      await invoke("save_prompt_template", {
        input: { id, name, prefix },
      });
      area.style.display = "none";
      if (list) list.style.display = "";
      if (addBtn) addBtn.style.display = "";
      editingTemplate = null;
      const all = await loadTemplates();
      renderTemplateList(all);
    } catch (err) {
      console.error("save_prompt_template failed:", err);
    }
  });
}

function buildTemplateBar(templates: PromptTemplate[]): void {
  const composer = document.querySelector<HTMLElement>(".composer");
  if (!composer) return;

  const bar = document.createElement("div");
  bar.className = "template-bar";
  bar.id = "template-bar";

  let html = templates
    .filter((t) => t.category === "builtin")
    .map(
      (t) =>
        `<button class="tmpl-pill builtin" data-prefix="${escapeHtml(t.prefix)}" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</button>`,
    )
    .join("");

  // Custom templates
  const customTemplates = templates.filter((t) => t.category === "custom");
  html += customTemplates
    .map(
      (t) =>
        `<button class="tmpl-pill custom" data-prefix="${escapeHtml(t.prefix)}" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</button>`,
    )
    .join("");

  html += `<button class="tmpl-settings" id="tmpl-settings-btn" title="管理自定义模板">⚙</button>`;

  bar.innerHTML = html;

  // Insert after composer-toolbar (or at top of composer)
  const toolbar = composer.querySelector(".composer-toolbar");
  if (toolbar && toolbar.nextSibling) {
    composer.insertBefore(bar, toolbar.nextSibling);
  } else {
    composer.insertBefore(bar, composer.firstChild);
  }

  // Wire pill clicks
  bar.querySelectorAll<HTMLButtonElement>(".tmpl-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      const prefix = pill.dataset.prefix ?? "";
      applyTemplate(prefix);
    });
  });

  // Wire settings button
  document.getElementById("tmpl-settings-btn")?.addEventListener("click", () => {
    void openTemplateEditor();
  });
}

// ---- Setup (called from chat.ts wire) ----

export function setupInputBox(): void {
  injectStyles();
  buildFileCardsContainer();
  buildImageCardsContainer();
  buildComposerToolbar();

  // Wire paste handler on the textarea
  const composer = document.querySelector<HTMLElement>(".composer");
  composer?.addEventListener("paste", handleImagePaste as EventListener);
}

// Called after init to load and render template bar
export async function setupTemplateBar(): Promise<void> {
  const templates = await loadTemplates();
  buildTemplateBar(templates);
}

// ---- Attach toolbar button (injected into composer) ----

function buildComposerToolbar(): void {
  // Find the composer element
  const composer = document.querySelector<HTMLElement>(".composer");
  if (!composer) return;

  // Insert toolbar above the textarea
  const toolbar = document.createElement("div");
  toolbar.className = "composer-toolbar";
  toolbar.innerHTML = `
    <div class="attach-menu">
      <button type="button" class="btn-attach" id="btn-attach" title="添加附件" aria-haspopup="true" aria-expanded="false">
        📎
      </button>
      <div class="attach-dropdown" id="attach-dropdown" role="menu">
        <div class="attach-dropdown-section">本地文件</div>
        <div class="attach-submenu">
          <button type="button" class="attach-item" id="attach-local-ref">
            <span class="attach-item-icon">✏️</span>
            <span class="attach-item-text">引用（可读写）</span>
            <span class="attach-item-badge">推荐</span>
          </button>
          <div class="attach-submenu-items" id="local-submenu">
            <button type="button" class="attach-submenu-item" id="pick-ref">
              📄 引用（可读写）
            </button>
            <button type="button" class="attach-submenu-item" id="pick-copy">
              📤 发送（只读副本）
            </button>
          </div>
        </div>
        <div style="border-top: 1px solid var(--border-soft); margin: 4px 0;"></div>
        <div class="attach-dropdown-section">云文件</div>
        <button type="button" class="attach-item disabled" id="attach-cloud" title="Phase 2 实现">
          <span class="attach-item-icon">☁️</span>
          <span class="attach-item-text">云文件</span>
          <span class="attach-item-badge">待实现</span>
        </button>
        <div style="border-top: 1px solid var(--border-soft); margin: 4px 0;"></div>
        <div class="attach-dropdown-section">群组</div>
        <button type="button" class="attach-item" id="attach-group" title="创建群聊">
          <span class="attach-item-icon">👥</span>
          <span class="attach-item-text">创建群聊</span>
        </button>
      </div>
    </div>
    <button type="button" class="btn-qr-upload" id="btn-qr-upload" title="扫码上传" aria-label="扫码上传">
      📱
    </button>
  `;

  // Insert before the textarea
  const textarea = composer.querySelector<HTMLElement>("textarea");
  composer.insertBefore(toolbar, textarea);

  // Wire events
  const btn = document.getElementById("btn-attach");
  btn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });

  // Local file sub-menu
  const submenu = document.getElementById("attach-local-ref");
  submenu?.addEventListener("mouseenter", () => {
    const sm = document.getElementById("local-submenu");
    if (sm) sm.style.display = "block";
  });
  const submenuEl = document.getElementById("local-submenu");
  if (submenuEl) {
    submenuEl.style.display = "none";
  }

  document.getElementById("pick-ref")?.addEventListener("click", () => {
    void pickFile("reference");
  });
  document.getElementById("pick-copy")?.addEventListener("click", () => {
    void pickFile("send_copy");
  });

  document.getElementById("attach-cloud")?.addEventListener("click", () => {
    openCloudBrowser();
  });

  document.getElementById("attach-group")?.addEventListener("click", () => {
    closeMenu();
    // Open create dialog with group mode
    import("../components/create-dialog").then(({ openCreateDialog }) => {
      openCreateDialog();
      // After dialog opens, select the group radio button
      setTimeout(() => {
        const groupRadio = document.querySelector<HTMLInputElement>('input[name="agent-type"][value="group"]');
        if (groupRadio) groupRadio.checked = true;
        // Trigger change event to show group members
        groupRadio?.dispatchEvent(new Event("change", { bubbles: true }));
      }, 50);
    });
  });

  // QR Upload button (📱)
  document.getElementById("btn-qr-upload")?.addEventListener("click", () => {
    import("./qr-upload").then(({ openQrUploadDialog }) => {
      openQrUploadDialog();
    });
  });

  // Close menu on outside click
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest(".attach-menu")) {
      closeMenu();
    }
  });
}

// ---- File cards container ----

function buildFileCardsContainer(): void {
  const composer = document.querySelector<HTMLElement>(".composer");
  if (!composer) return;

  const container = document.createElement("div");
  container.id = "file-cards";
  container.className = "file-cards";
  container.style.display = "none";

  // Insert before textarea
  const textarea = composer.querySelector<HTMLElement>("textarea");
  composer.insertBefore(container, textarea);
}

// ---- Utilities ----

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
