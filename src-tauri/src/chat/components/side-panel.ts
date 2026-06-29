// =========================================================
// FeClaw Desktop — Agent Side Panel + Permission Modal
// =========================================================
//
// Redesign of the 3-dot menu: a WeChat-style right-side drawer
// (side panel) with toggle switches for Pin / Do Not Disturb,
// and a SEPARATE centered modal for Permission Level.
//
// Layout (drawer):
//   ┌─── side-overlay (full-screen dim) ────────────────┐
//   │  ┌─── side-panel (300px from right) ──────────┐  │
//   │  │ [✕]  Agent 设置              [header]      │  │
//   │  │                                            │  │
//   │  │   ┌─────┐                                  │  │
//   │  │   │  A  │  ← avatar (initials circle)      │  │
//   │  │   └─────┘                                  │  │
//   │  │                                            │  │
//   │  │   备注名:  [editable input]                │  │
//   │  │                                            │  │
//   │  │   📌 置顶聊天              [toggle switch] │  │
//   │  │   🔕 免打扰                [toggle switch] │  │
//   │  │                                            │  │
//   │  │   📂 文件管理器           [打开]           │  │
//   │  │   ⚙️ 配置管理             [打开]           │  │
//   │  │   🛡️ 安全权限等级  L2 (平衡)  [切换]       │  │  ← opens modal
//   │  │                                            │  │
//   │  │   🏪 小程序                                │  │
//   │  │   ├── 复习计划生成器                       │  │
//   │  │   └── 错题分析器                          │  │
//   │  └────────────────────────────────────────────┘  │
//   └────────────────────────────────────────────────┘
//
// Permission modal (centered, opens on top of the drawer):
//   ┌─── perm-overlay (full-screen dim) ──────────────┐
//   │   ┌─── perm-modal (centered) ───────────────┐  │
//   │   │ 🛡️ 安全权限等级              [✕]       │  │
//   │   │                                         │  │
//   │   │   ( L0 ) 禁止                          │  │
//   │   │   ( L1 ) 严格                          │  │
//   │   │   ( L2 ) 平衡         ← selected        │  │
//   │   │   ( L3 ) 宽松                          │  │
//   │   │   ( L4 ) 完全授权                      │  │
//   │   │                                         │  │
//   │   │   [取消]                  [确定]        │  │
//   │   └─────────────────────────────────────────┘  │
//   └───────────────────────────────────────────────┘
//
// Public API:
//   openSidePanel(agentHash: string) — open the drawer for an agent

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

interface PermissionOption {
  value: string;
  label: string;
  desc: string;
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  { value: "disabled", label: "禁止 (L0)", desc: "完全禁用工具调用" },
  { value: "strict", label: "严格 (L1)", desc: "只读操作，每次需确认" },
  { value: "balanced", label: "平衡 (L2)", desc: "常用操作自动放行" },
  { value: "relaxed", label: "宽松 (L3)", desc: "大多数操作无需确认" },
  { value: "full", label: "完全授权 (L4)", desc: "无限制执行" },
];

const PERMISSION_LABEL: Record<string, string> = Object.fromEntries(
  PERMISSION_OPTIONS.map((o) => [o.value, o.label]),
);

// ---- DOM IDs -----------------------------------------------------

const OVERLAY_ID = "side-overlay";
const PANEL_ID = "side-panel";
const PERM_OVERLAY_ID = "perm-overlay";
const PERM_MODAL_ID = "perm-modal";

// ---- State -------------------------------------------------------

let currentAgentHash: string | null = null;
let isPanelOpen = false;
let isPermModalOpen = false;
let pendingPermissionMode: string | null = null;

// ---- Drawer DOM --------------------------------------------------

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

      <div class="sp-perm-row" id="sp-perm-row" role="button" tabindex="0">
        <div class="sp-perm-label-wrap">
          <span class="sp-btn-label">🛡️ 安全权限等级</span>
          <span class="sp-perm-current" id="sp-perm-current">—</span>
        </div>
        <button type="button" class="sp-btn sp-btn-primary" id="sp-open-perm">切换</button>
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

  // Permission row → open centered modal
  const permRow = document.getElementById("sp-perm-row")!;
  permRow.addEventListener("click", openPermissionModal);
  permRow.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPermissionModal();
    }
  });
  document.getElementById("sp-open-perm")!.addEventListener("click", (e) => {
    e.stopPropagation();
    openPermissionModal();
  });

  // File manager button
  document.getElementById("sp-open-file-manager")!.addEventListener("click", () => {
    if (!currentAgentHash) return;
    void openFileManager();
  });

  // Config button
  document.getElementById("sp-open-config")!.addEventListener("click", () => {
    if (!currentAgentHash) return;
    void openConfig();
  });

  // ESC to close (drawer first, then modal on top of drawer)
  document.addEventListener("keydown", handleEscKey);
}

// ---- Permission modal DOM ---------------------------------------

function buildPermissionModal(): void {
  if (document.getElementById(PERM_MODAL_ID)) return;

  const overlay = document.createElement("div");
  overlay.id = PERM_OVERLAY_ID;
  overlay.className = "perm-overlay";
  // Clicks on overlay (but not on modal itself) close the modal
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePermissionModal();
  });

  const modal = document.createElement("div");
  modal.id = PERM_MODAL_ID;
  modal.className = "perm-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "安全权限等级");

  modal.innerHTML = `
    <div class="perm-header">
      <span class="perm-title">🛡️ 安全权限等级</span>
      <button type="button" class="perm-close" id="perm-close" aria-label="关闭">✕</button>
    </div>
    <div class="perm-body">
      <div class="perm-list" id="perm-list">
        ${PERMISSION_OPTIONS.map(
          (o) => `
          <button type="button" class="perm-option" data-value="${o.value}">
            <div class="perm-option-radio" aria-hidden="true"></div>
            <div class="perm-option-text">
              <div class="perm-option-label">${o.label}</div>
              <div class="perm-option-desc">${o.desc}</div>
            </div>
          </button>`,
        ).join("")}
      </div>
    </div>
    <div class="perm-footer">
      <button type="button" class="perm-btn perm-btn-cancel" id="perm-cancel">取消</button>
      <button type="button" class="perm-btn perm-btn-confirm" id="perm-confirm">确定</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Wire option clicks (radio-style selection)
  modal.querySelectorAll<HTMLButtonElement>(".perm-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.getAttribute("data-value");
      if (value) selectPermissionOption(value);
    });
  });

  // Footer buttons
  document.getElementById("perm-close")!.addEventListener("click", closePermissionModal);
  document.getElementById("perm-cancel")!.addEventListener("click", closePermissionModal);
  document.getElementById("perm-confirm")!.addEventListener("click", () => {
    void confirmPermissionSelection();
  });
}

function selectPermissionOption(value: string): void {
  pendingPermissionMode = value;
  document.querySelectorAll<HTMLButtonElement>(".perm-option").forEach((btn) => {
    btn.classList.toggle("selected", btn.getAttribute("data-value") === value);
  });
}

// ---- Open / Close drawer ----------------------------------------

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

  // Update permission level label in drawer
  updatePermLabel(info.permission_mode);

  currentAgentHash = agentHash;

  // Show drawer
  overlay.classList.add("open");
  panel.classList.add("open");
  isPanelOpen = true;

  // Focus alias input for quick editing
  aliasInput.focus();

  // Load apps from Engine
  void loadApps(agentHash);
}

function updatePermLabel(mode: string): void {
  const el = document.getElementById("sp-perm-current");
  if (el) el.textContent = PERMISSION_LABEL[mode] ?? mode;
}

function closeSidePanel(): void {
  // If the permission modal is open, close that first
  if (isPermModalOpen) {
    closePermissionModal();
    return;
  }
  const overlay = document.getElementById(OVERLAY_ID);
  const panel = document.getElementById(PANEL_ID);
  if (overlay) overlay.classList.remove("open");
  if (panel) panel.classList.remove("open");
  isPanelOpen = false;
  currentAgentHash = null;
}

// ---- Open / Close permission modal ------------------------------

function openPermissionModal(): void {
  if (!currentAgentHash) return;
  buildPermissionModal();

  const overlay = document.getElementById(PERM_OVERLAY_ID)!;
  const modal = document.getElementById(PERM_MODAL_ID)!;

  // Determine current value: read from drawer label, fallback to balanced
  const currentLabelEl = document.getElementById("sp-perm-current");
  let currentValue = "balanced";
  if (currentLabelEl?.textContent) {
    const match = PERMISSION_OPTIONS.find(
      (o) => o.label === currentLabelEl.textContent,
    );
    if (match) currentValue = match.value;
  }
  pendingPermissionMode = currentValue;
  selectPermissionOption(currentValue);

  overlay.classList.add("open");
  // Defer to next frame for transition
  requestAnimationFrame(() => modal.classList.add("open"));
  isPermModalOpen = true;
}

function closePermissionModal(): void {
  const overlay = document.getElementById(PERM_OVERLAY_ID);
  const modal = document.getElementById(PERM_MODAL_ID);
  if (modal) modal.classList.remove("open");
  if (overlay) {
    // Wait for transition before hiding pointer events
    setTimeout(() => {
      if (!isPermModalOpen) overlay.classList.remove("open");
    }, 180);
  }
  isPermModalOpen = false;
  pendingPermissionMode = null;
}

async function confirmPermissionSelection(): Promise<void> {
  if (!currentAgentHash || !pendingPermissionMode) {
    closePermissionModal();
    return;
  }
  const value = pendingPermissionMode;
  closePermissionModal();
  // Update the drawer's label immediately for responsiveness
  updatePermLabel(value);
  await setPermissionModeAndSync(value);
}

function handleEscKey(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  if (isPermModalOpen) {
    e.preventDefault();
    closePermissionModal();
  } else if (isPanelOpen) {
    e.preventDefault();
    closeSidePanel();
  }
}

// ---- App list ----------------------------------------------------

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

// ---- API calls ---------------------------------------------------

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

// ---- Public API --------------------------------------------------

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
