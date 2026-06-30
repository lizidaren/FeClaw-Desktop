// =========================================================
// FeHub Desktop — FeHub Tab UI (Phase 6)
// =========================================================
//
// Renders the 🏗️ FeHub tab content:
//   - List of published miniapps from the engine API
//   - Each card: app name, version tag, visibility, timestamp
//   - "Open" launches a new WebviewWindow with the miniapp URL
//   - "Publish new version" / "Cancel publish" / "Toggle public" actions
//
// Public API:
//   showFehubTab()   — show the FeHub panel in the middle slot
//   hideFehubTab()   — hide the FeHub panel
//   refreshFehubTab() — reload publishes from Rust

import { store, type PublishInfo } from "../store";

// ---- Tauri bridge ------------------------------------------------

type TauriCore = {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
};

function getTauri(): TauriCore {
  const g = (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__;
  if (!g?.core) throw new Error("Tauri global not available");
  return g.core;
}

const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  getTauri().invoke<T>(cmd, args);

// ---- DOM helpers ------------------------------------------------

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ---- Time formatting ---------------------------------------------

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---- Publish dialog ----------------------------------------------

function openPublishDialog(publish?: PublishInfo): void {
  // Remove any existing dialog
  const existing = $<HTMLDivElement>("fehub-publish-dialog");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "fehub-dialog-overlay";
  overlay.id = "fehub-publish-dialog";

  const title = publish ? "发布新版本" : "从模板创建";

  overlay.innerHTML = `
    <div class="fehub-dialog">
      <div class="fehub-dialog-header">
        <span class="fehub-dialog-title">${title}</span>
        <button class="fehub-dialog-close" id="fehub-dialog-close">✕</button>
      </div>
      <div class="fehub-dialog-body">
        <div class="fehub-dialog-field">
          <label class="fehub-dialog-label">版本标签</label>
          <input
            type="text"
            class="fehub-dialog-input"
            id="fehub-dialog-tag"
            placeholder="如 v1.0.0"
            value="${publish?.tag ?? ""}"
          />
        </div>
        <div class="fehub-dialog-field">
          <label class="fehub-dialog-label">访问权限</label>
          <div class="fehub-dialog-visibility">
            <label class="fehub-visibility-option">
              <input
                type="radio"
                name="fehub-visibility"
                value="public"
                ${publish?.is_public !== false ? "checked" : ""}
              />
              <span>🌐 公有</span>
              <small>所有人都可以访问</small>
            </label>
            <label class="fehub-visibility-option">
              <input
                type="radio"
                name="fehub-visibility"
                value="private"
                ${publish?.is_public === false ? "checked" : ""}
              />
              <span>🔒 私有</span>
              <small>仅自己可访问</small>
            </label>
          </div>
        </div>
      </div>
      <div class="fehub-dialog-footer">
        <button class="btn btn-secondary" id="fehub-dialog-cancel">取消</button>
        <button class="btn btn-primary" id="fehub-dialog-confirm" ${publish ? "" : "disabled"}>确认发布</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const closeDialog = () => overlay.remove();
  $<HTMLButtonElement>("fehub-dialog-close")?.addEventListener("click", closeDialog);
  $<HTMLButtonElement>("fehub-dialog-cancel")?.addEventListener("click", closeDialog);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDialog();
  });

  $<HTMLButtonElement>("fehub-dialog-confirm")?.addEventListener("click", async () => {
    const tagInput = $<HTMLInputElement>("fehub-dialog-tag");
    const visInput = document.querySelector<HTMLInputElement>(
      'input[name="fehub-visibility"]:checked'
    );
    if (!tagInput?.value.trim()) return;
    const tag = tagInput.value.trim();
    const isPublic = visInput?.value === "public";

    try {
      if (publish) {
        // TODO: call publish_new_version Rust command when implemented
        console.log("publish new version:", publish.app_name, tag, isPublic);
      }
      closeDialog();
      void refreshFehubTab();
    } catch (e) {
      alert(`操作失败：${e}`);
    }
  });
}

// ---- Render ------------------------------------------------------

function renderPublishCard(pub: PublishInfo): HTMLElement {
  const card = document.createElement("div");
  card.className = "fehub-card";
  card.dataset.appName = pub.app_name;

  const visibilityClass = pub.is_public ? "public" : "private";
  const visibilityLabel = pub.is_public ? "🌐 公有" : "🔒 私有";

  card.innerHTML = `
    <div class="fehub-card-icon">📱</div>
    <div class="fehub-card-info">
      <div class="fehub-card-name">${escapeHtml(pub.app_name)}</div>
      <div class="fehub-card-meta">
        <span class="fehub-card-tag">${escapeHtml(pub.tag)}</span>
        <span class="fehub-visibility-badge ${visibilityClass}">${visibilityLabel}</span>
      </div>
      <div class="fehub-card-date">${formatDate(pub.created_at)}</div>
    </div>
    <div class="fehub-card-actions">
      <button class="fehub-btn fehub-btn-open" data-app="${escapeHtml(pub.app_name)}">打开</button>
      <button class="fehub-btn fehub-btn-version" data-app="${escapeHtml(pub.app_name)}">发布新版本</button>
      <button class="fehub-btn fehub-btn-toggle" data-app="${escapeHtml(pub.app_name)}" data-public="${pub.is_public}">
        ${pub.is_public ? "转为私有" : "公开"}
      </button>
    </div>
  `;

  // Wire up buttons
  card.querySelector<HTMLButtonElement>(".fehub-btn-open")?.addEventListener("click", () => {
    void openMiniapp(pub.app_name);
  });

  card.querySelector<HTMLButtonElement>(".fehub-btn-version")?.addEventListener("click", () => {
    openPublishDialog(pub);
  });

  card.querySelector<HTMLButtonElement>(".fehub-btn-toggle")?.addEventListener("click", () => {
    void toggleVisibility(pub);
  });

  return card;
}

async function openMiniapp(appName: string): Promise<void> {
  try {
    await invoke("open_miniapp", { appName });
  } catch (e) {
    alert(`打开失败：${e}`);
  }
}

async function toggleVisibility(pub: PublishInfo): Promise<void> {
  try {
    // TODO: call set_publish_visibility Rust command when implemented
    console.log("toggle visibility:", pub.app_name, !pub.is_public);
    void refreshFehubTab();
  } catch (e) {
    alert(`操作失败：${e}`);
  }
}

function renderFehubContent(publishes: PublishInfo[]): void {
  const container = $<HTMLDivElement>("fehub-content");
  if (!container) return;

  if (publishes.length === 0) {
    container.innerHTML = `
      <div class="fehub-empty">
        <div class="fehub-empty-icon">📦</div>
        <h3>暂无已发布的小程序</h3>
        <p>从模板创建一个新的小程序，开始你的 FeHub 之旅</p>
        <button class="btn btn-primary" id="fehub-create-from-template">+ 从模板创建</button>
      </div>
    `;
    $<HTMLButtonElement>("fehub-create-from-template")?.addEventListener("click", () => {
      openPublishDialog();
    });
    return;
  }

  const list = document.createElement("div");
  list.className = "fehub-list";

  for (const pub of publishes) {
    list.appendChild(renderPublishCard(pub));
  }

  const footer = document.createElement("div");
  footer.className = "fehub-footer";
  footer.innerHTML = `<button class="btn btn-secondary" id="fehub-create-from-template">+ 从模板创建</button>`;
  footer.querySelector<HTMLButtonElement>("#fehub-create-from-template")?.addEventListener("click", () => {
    openPublishDialog();
  });

  container.innerHTML = "";
  container.appendChild(list);
  container.appendChild(footer);
}

// ---- Public API --------------------------------------------------

export function showFehubTab(): void {
  const panel = $<HTMLDivElement>("fehub-panel");
  const noChat = $<HTMLDivElement>("no-chat-state");
  const activeChat = $<HTMLDivElement>("active-chat");
  if (panel) panel.style.display = "";
  if (noChat) noChat.style.display = "none";
  if (activeChat) activeChat.style.display = "none";
  void refreshFehubTab();
}

export function hideFehubTab(): void {
  const panel = $<HTMLDivElement>("fehub-panel");
  if (panel) panel.style.display = "none";
}

export async function refreshFehubTab(): Promise<void> {
  const container = $<HTMLDivElement>("fehub-content");
  if (container) {
    container.innerHTML = `<div class="fehub-loading">加载中…</div>`;
  }
  try {
    const publishes = await invoke<PublishInfo[]>("list_my_publishes");
    store.setPublishes(publishes);
    renderFehubContent(publishes);
  } catch (e) {
    console.error("list_my_publishes failed:", e);
    if (container) {
      container.innerHTML = `
        <div class="fehub-empty">
          <div class="fehub-empty-icon">⚠️</div>
          <h3>加载失败</h3>
          <p>${escapeHtml(String(e))}</p>
          <button class="btn btn-secondary" id="fehub-retry">重试</button>
        </div>
      `;
      $<HTMLButtonElement>("fehub-retry")?.addEventListener("click", () => {
        void refreshFehubTab();
      });
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
