// =========================================================
// FeClaw Desktop — Agent Side Panel (Phase 0c V3)
// =========================================================
//
// Sliding panel from the right edge of the chat window.
// Shows agent avatar, editable alias, pin/dnd toggles,
// and permission mode dropdown.
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
//   │  │   🛡️ 权限模式                         │  │
//   │  │   [dropdown: 禁止/严格/平衡/宽松/完全]  │  │
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

      <div class="sp-field" style="margin-top:16px;">
        <label class="sp-label">🛡️ 权限模式</label>
        <select class="sp-select" id="sp-permission-select">
          ${PERMISSION_OPTIONS.map(
            (o) => `<option value="${o.value}">${o.label}</option>`,
          ).join("")}
        </select>
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
    void saveAlias(input.value);
  });

  // Pin toggle
  document.getElementById("sp-toggle-pin")!.addEventListener("change", () => {
    if (!currentAgentHash) return;
    void togglePin();
  });

  // DND toggle
  document.getElementById("sp-toggle-dnd")!.addEventListener("change", () => {
    if (!currentAgentHash) return;
    void toggleDnd();
  });

  // Permission mode select
  document.getElementById("sp-permission-select")!.addEventListener("change", () => {
    if (!currentAgentHash) return;
    // TODO: wire to set_permission_mode when that command is added
    console.log("permission mode changed:", (document.getElementById("sp-permission-select") as HTMLSelectElement).value);
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

function openSidePanelImpl(info: AgentPanelInfo, agentHash: string): void {
  buildPanel();

  const overlay = document.getElementById(OVERLAY_ID)!;
  const panel = document.getElementById(PANEL_ID)!;

  // Populate fields
  const avatarEl = document.getElementById("sp-avatar")!;
  // Show first char of alias or name as avatar letter
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
}

function closeSidePanel(): void {
  const overlay = document.getElementById(OVERLAY_ID);
  const panel = document.getElementById(PANEL_ID);
  if (overlay) overlay.classList.remove("open");
  if (panel) panel.classList.remove("open");
  isPanelOpen = false;
  currentAgentHash = null;
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

async function togglePin(): Promise<void> {
  if (!currentAgentHash) return;
  try {
    const newVal = await invoke<boolean>("toggle_pin", { agent_hash: currentAgentHash });
    const pinToggle = document.getElementById("sp-toggle-pin") as HTMLInputElement;
    if (pinToggle) pinToggle.checked = newVal;
  } catch (e) {
    console.error("toggle_pin failed:", e);
  }
}

async function toggleDnd(): Promise<void> {
  if (!currentAgentHash) return;
  try {
    const newVal = await invoke<boolean>("toggle_dnd", { agent_hash: currentAgentHash });
    const dndToggle = document.getElementById("sp-toggle-dnd") as HTMLInputElement;
    if (dndToggle) dndToggle.checked = newVal;
  } catch (e) {
    console.error("toggle_dnd failed:", e);
  }
}

// ---- Public API ---------------------------------------------------

export async function openSidePanel(agentHash: string): Promise<void> {
  try {
    const info = await invoke<AgentPanelInfo>("get_agent_panel_info", {
      agent_hash: agentHash,
    });
    openSidePanelImpl(info, agentHash);
  } catch (e) {
    console.error("get_agent_panel_info failed:", e);
  }
}

export function closeSidePanelIfOpen(): void {
  if (isPanelOpen) closeSidePanel();
}
