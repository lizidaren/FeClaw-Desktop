// =========================================================
// FeClaw Desktop — Agent Side Panel (Phase 0c + 2C V3)
// =========================================================
//
// Sliding panel from the right edge of the chat window.
// Shows agent avatar, editable alias, pin/dnd toggles,
// permission mode dropdown, config manager, file manager,
// and app list.
//
// Layout:
//   ┌─── side-overlay (full-screen dim) ────────────────┐
//   │  ┌─── side-panel (300px from right) ──────────┐  │
//   │  │ [✕]  Agent Settings              [header] │  │
//   │  │                                          │  │
//   │  │   ┌─────┐                               │  │
//   │  │   │  A  │  ← avatar (initials circle)  │  │
//   │  │   └─────┘                               │  │
//   │  │                                          │  │
//   │  │   [Editable alias field]                 │  │
//   │  │                                          │  │
//   │  │   📌 置顶聊天            [toggle switch]│  │
//   │  │   🔕 免打扰              [toggle switch]│  │
//   │  │                                          │  │
//   │  │   📂 文件管理器         [打开]           │  │ ← Phase 2C
//   │  │   ⚙️ 配置管理           [打开]           │  │ ← Phase 2C
//   │  │                                          │  │
//   │  │   🛡️ 权限模式                         │  │
//   │  │   [dropdown: 禁止/严格/平衡/宽松/完全]  │  │ ← Phase 2C write-back
//   │  │                                          │  │
//   │  │   🏪 小程序                          │  │ ← Phase 2C
//   │  │   ├── 复习计划生成器                  │  │
//   │  │   └── 错题分析器                     │  │
//   │  │                                          │  │
//   │  └──────────────────────────────────────────┘  │
//   └───────────────────────────────────────────────┘
//
// Public API:
//   openSidePanel(agentHash: string) — open the panel for an agent

import { store } from "../store";

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

// ---- Types -------------------------------------------------------

interface AgentPanelInfo {
  alias: string;
  avatar_url: string | null;
  is_pinned: boolean;
  is_dnd: boolean;
  permission_mode: string;
}

interface AppInfo {
  app_id: string;
  name: string;
  description: string;
  icon_url: string | null;
}

const PERMISSION_LABELS: Record<string, string> = {
  disabled: "禁止 (L0)",
  strict: "严格 (L1)",
  balanced: "平衡 (L2)",
  relaxed: "宽松 (L3)",
  full: "完全授权 (L4)",
};

const PERMISSION_OPTIONS = [
  { value: "disabled", label: "禁止 (L0)" },
  { value: "strict", label: "严格 (L1)" },
  { value: "balanced", label: "平衡 (L2)" },
  { value: "relaxed", label: "宽松 (L3)" },
  { value: "full", label: "完全授权 (L4)" },
];

// ---- DOM IDs -----------------------------------------------------

const OVERLAY_ID = "side-overlay";
const PANEL_ID = "side-panel";

// ---- State -------------------------------------------------------

let currentAgentHash: string | null = null;
let isPanelOpen = false;

// ---- Panel DOM ---------------------------------------------------

function buildPanel(): void {
  if (document.getElementById(PANEL_ID)) return;

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "side-overlay";
  overlay.addEventListener("click", closeSidePanel);

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.className = "side-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Agent 设置");

  panel.innerHTML = `
    <div class="sp-header">
      <span class="sp-title">Agent 设置</span>
      <button type="button" class="sp-close" id="sp-close" aria-label="关闭">✕</button>
    </div>
    <div class="sp-body">
      <div class="sp-avatar-row">
        <div class="sp-avatar" id="sp-avatar">A</div>
      </div>

      <div class="sp-field">
        <label class="sp-label">备注名</label>
        <input type="text" class="sp-input" id="sp-alias-input"
          placeholder="点击编辑备注名" maxlength="40" />
      </div>

      <div class="sp-toggle-row">
        <span class="sp-toggle-label">📌 置顶聊天</span>
        <label class="sp-switch">
          <input type="checkbox" id="sp-toggle-pin" />
          <span class="sp-slider"></span>
        </label>
      </div>

      <div class="sp-toggle-row">
        <span class="sp-toggle-label">🔕 免打扰</span>
        <label class="sp-switch">
          <input type="checkbox" id="sp-toggle-dnd" />
          <span class="sp-slider"></span>
        </label>
      </div>

      <div class="sp-btn-row" id="sp-file-manager-row">
        <span class="sp-btn-label">📂 文件管理器</span>
        <button type="button" class="sp-btn" id="sp-open-file-manager">打开</button>
      </div>

      <div class="sp-btn-row" id="sp-config-row">
        <span class="sp-btn-label">⚙️ 配置管理</span>
        <button type="button" class="sp-btn" id="sp-open-config">打开</button>
      </div>

      <div class="sp-field" style="margin-top:16px;">
        <label class="sp-label">🛡️ 权限模式</label>
        <select class="sp-select" id="sp-permission-select">
          ${PERMISSION_OPTIONS.map(
            (o) => `<option value="${o.value}">${o.label}</option>`,
          ).join("")}
        </select>
      </div>

      <div class="sp-section" id="sp-apps-section">
        <div class="sp-section-header">🏪 小程序</div>
        <div class="sp-apps-loading" id="sp-apps-loading">加载中...</div>
        <div class="sp-apps-list" id="sp-apps-list"></div>
      </div>
    </div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Wire events
  document.getElementById("sp-close")!.addEventListener("click", closeSidePanel);

  // Alias: save on blur
  document.getElementById("sp-alias-input")!.addEventListener("blur", () => {
    if (!currentAgentHash) return;
    const input = document.getElementById("sp-alias-input") as HTMLInputElement;
    void saveAliasAndSync(input.value);
  });

  // Pin toggle
  document.getElementById("sp-toggle-pin")!.addEventListener("change", () => {
    if (!currentAgentHash) return;
    void togglePinAndSync();
  });

  // DND toggle
  document.getElementById("sp-toggle-dnd")!.addEventListener("change", () => {
    if (!currentAgentHash) return;
    void toggleDndAndSync();
  });

  // Permission mode select → Phase 2C write-back
  document.getElementById("sp-permission-select")!.addEventListener("change", () => {
    if (!currentAgentHash) return;
    const select = document.getElementById("sp-permission-select") as HTMLSelectElement;
    void setPermissionModeAndSync(select.value);
  });

  // File manager button → Phase 2C
  document.getElementById("sp-open-file-manager")!.addEventListener("click", () => {
    if (!currentAgentHash) return;
    void openFileManager();
  });

  // Config button → Phase 2C
  document.getElementById("sp-open-config")!.addEventListener("click", () => {
    if (!currentAgentHash) return;
    void openConfig();
  });

  // ESC to close
  document.addEventListener("keydown", handleEscKey);
}

function handleEscKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && isPanelOpen) {
    closeSidePanel();
  }
}

// ---- Open / Close ------------------------------------------------

async function openSidePanelImpl(info: AgentPanelInfo, agentHash: string): Promise<void> {
  buildPanel();

  const overlay = document.getElementById(OVERLAY_ID)!;
  const panel = document.getElementById(PANEL_ID)!;

  // Populate fields
  const avatarEl = document.getElementById("sp-avatar")!;
  const name = info.alias || store.agents.find((a) => a.hash === agentHash)?.name || "A";
  avatarEl.textContent = name.charAt(0).toUpperCase();

  const aliasInput = document.getElementById("sp-alias-input") as HTMLInputElement;
  aliasInput.value = info.alias || "";

  const pinToggle = document.getElementById("sp-toggle-pin") as HTMLInputElement;
  pinToggle.checked = info.is_pinned;

  const dndToggle = document.getElementById("sp-toggle-dnd") as HTMLInputElement;
  dndToggle.checked = info.is_dnd;

  const permSelect = document.getElementById("sp-permission-select") as HTMLSelectElement;
  permSelect.value = PERMISSION_OPTIONS.some((o) => o.value === info.permission_mode)
    ? info.permission_mode
    : "balanced";

  currentAgentHash = agentHash;

  // Show
  overlay.classList.add("open");
  panel.classList.add("open");
  isPanelOpen = true;

  // Focus alias input for quick editing
  aliasInput.focus();

  // Load apps from Engine → Phase 2C
  void loadApps(agentHash);
}

function closeSidePanel(): void {
  const overlay = document.getElementById(OVERLAY_ID);
  const panel = document.getElementById(PANEL_ID);
  if (overlay) overlay.classList.remove("open");
  if (panel) panel.classList.remove("open");
  isPanelOpen = false;
  currentAgentHash = null;
}

// ---- App list (Phase 2C) ----------------------------------------

async function loadApps(agentHash: string): Promise<void> {
  const loadingEl = document.getElementById("sp-apps-loading");
  const listEl = document.getElementById("sp-apps-list");
  if (!loadingEl || !listEl) return;

  try {
    const apps = await invoke<AppInfo[]>("list_agent_apps", { agent_hash: agentHash });
    loadingEl.style.display = "none";

    if (!apps || apps.length === 0) {
      listEl.innerHTML = '<div class="sp-apps-empty">暂无可用小程序</div>';
      return;
    }

    listEl.innerHTML = apps
      .map(
        (app) => `
      <div class="sp-app-card" data-app-id="${app.app_id}" data-name="${app.name}" data-url="${app.icon_url ?? ""}">
        <div class="sp-app-icon">${(app.icon_url ?? "").startsWith("http") ? `<img src="${app.icon_url}" alt="" width="24" height="24" />` : "📦"}</div>
        <div class="sp-app-info">
          <div class="sp-app-name">${app.name}</div>
          <div class="sp-app-desc">${app.description}</div>
        </div>
      </div>`,
      )
      .join("");

    // Wire app card clicks → open in browser/popup
    listEl.querySelectorAll(".sp-app-card").forEach((card) => {
      card.addEventListener("click", () => {
        const appId = card.getAttribute("data-app-id");
        if (appId) void openApp(appId);
      });
    });
  } catch (e) {
    console.error("list_agent_apps failed:", e);
    loadingEl.style.display = "none";
    listEl.innerHTML = '<div class="sp-apps-empty">加载失败</div>';
  }
}

async function openApp(appId: string): Promise<void> {
  // Open app in browser via Tauri
  try {
    await invoke("open_app", { app_id: appId });
  } catch {
    // Fallback: just log
    console.warn("open_app not implemented, app_id:", appId);
  }
}

// ---- API calls (Phase 0c + 2C sync) ----------------------------

async function saveAlias(alias: string): Promise<void> {
  if (!currentAgentHash) return;
  try {
    await invoke("update_agent_alias", { agent_hash: currentAgentHash, alias });
  } catch (e) {
    console.error("update_agent_alias failed:", e);
  }
}

async function syncSettings(): Promise<void> {
  if (!currentAgentHash) return;
  try {
    await invoke("sync_agent_settings", { agent_hash: currentAgentHash });
  } catch (e) {
    // Non-fatal: log warning only
    console.warn("sync_agent_settings failed (non-fatal):", e);
  }
}

async function saveAliasAndSync(alias: string): Promise<void> {
  await saveAlias(alias);
  // Fire-and-forget sync; don't await to keep UI responsive
  void syncSettings();
}

async function togglePin(): Promise<boolean> {
  if (!currentAgentHash) return false;
  try {
    return await invoke<boolean>("toggle_pin", { agent_hash: currentAgentHash });
  } catch (e) {
    console.error("toggle_pin failed:", e);
    return false;
  }
}

async function togglePinAndSync(): Promise<void> {
  const newVal = await togglePin();
  const pinToggle = document.getElementById("sp-toggle-pin") as HTMLInputElement;
  if (pinToggle) pinToggle.checked = newVal;
  void syncSettings();
}

async function toggleDnd(): Promise<boolean> {
  if (!currentAgentHash) return false;
  try {
    return await invoke<boolean>("toggle_dnd", { agent_hash: currentAgentHash });
  } catch (e) {
    console.error("toggle_dnd failed:", e);
    return false;
  }
}

async function toggleDndAndSync(): Promise<void> {
  const newVal = await toggleDnd();
  const dndToggle = document.getElementById("sp-toggle-dnd") as HTMLInputElement;
  if (dndToggle) dndToggle.checked = newVal;
  void syncSettings();
}

// Phase 2C: permission mode write-back
async function setPermissionMode(mode: string): Promise<void> {
  if (!currentAgentHash) return;
  try {
    await invoke("set_agent_permission_mode", { agent_hash: currentAgentHash, mode });
  } catch (e) {
    console.error("set_agent_permission_mode failed:", e);
  }
}

async function setPermissionModeAndSync(mode: string): Promise<void> {
  await setPermissionMode(mode);
  void syncSettings();
}

// Phase 2C: open config window
async function openConfig(): Promise<void> {
  if (!currentAgentHash) return;
  try {
    await invoke("open_config_window", { agent_hash: currentAgentHash });
  } catch (e) {
    console.error("open_config_window failed:", e);
  }
}

// Phase 2C: open file manager window
async function openFileManager(): Promise<void> {
  if (!currentAgentHash) return;
  try {
    await invoke("open_file_manager_window", { agent_hash: currentAgentHash });
  } catch (e) {
    console.error("open_file_manager_window failed:", e);
  }
}

// ---- Public API ---------------------------------------------------

export async function openSidePanel(agentHash: string): Promise<void> {
  try {
    const info = await invoke<AgentPanelInfo>("get_agent_panel_info", {
      agent_hash: agentHash,
    });
    await openSidePanelImpl(info, agentHash);
  } catch (e) {
    console.error("get_agent_panel_info failed:", e);
  }
}

export function closeSidePanelIfOpen(): void {
  if (isPanelOpen) closeSidePanel();
}
