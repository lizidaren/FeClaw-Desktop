// =========================================================
// FeClaw Desktop — Extended Input Box (Phase 0b V3)
// =========================================================
//
// Adds:
//   - 📎 attachment button in the composer toolbar
//   - Popup menu: 本地文件 / 云文件
//   - File reference cards embedded in the composer
//   - Cards can be removed; user continues typing below them
//
// Cards are rendered above the textarea. The textarea retains
// its original behaviour. On send, file cards are serialised
// alongside the text into the message payload.
//
// Architecture:
//   setupInputBox() is called once from chat.ts wire().
//   The component owns the attachment menu state and the file-card list.
//   chat.ts's sendMessage() reads the current cards via getFileCards().

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

// ---- State ----

let fileCards: PickedFile[] = [];
let menuVisible = false;

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
        <button type="button" class="attach-item disabled" id="attach-group" title="Phase 4 实现">
          <span class="attach-item-icon">👥</span>
          <span class="attach-item-text">创建群聊</span>
          <span class="attach-item-badge">待实现</span>
        </button>
      </div>
    </div>
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

// ---- Setup (called from chat.ts wire) ----

export function setupInputBox(): void {
  injectStyles();
  buildFileCardsContainer();
  buildComposerToolbar();
}

// ---- Utilities ----

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
