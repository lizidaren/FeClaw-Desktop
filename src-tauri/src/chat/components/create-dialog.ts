// =========================================================
// FeClaw Desktop — Create Agent Dialog (Phase 0b V3)
// =========================================================
//
// Popup modal for creating a new Agent or Group.
// Shown when the user clicks the ➕ (new chat) button.
//
// Flow:
//   user clicks ➕ → show dialog → pick type + name → confirm
//     → invoke create_agent or create_group → add to store → switch to new chat
//
// The dialog is injected as a hidden element into the DOM and
// toggled via CSS classes.

import { store, type AgentInfo, type GroupInfo } from "../store";

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

// ---- DOM IDs (must match what we inject into index.html) ----

const DIALOG_ID = "create-dialog";
const OVERLAY_ID = "create-dialog-overlay";

// ---- Build the dialog DOM if not yet present ----

function ensureDialog(): HTMLElement {
  let el = document.getElementById(DIALOG_ID);
  if (el) return el;

  // Overlay (full-screen dim)
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "cd-overlay";
  overlay.addEventListener("click", () => hideDialog());

  // Dialog box
  const dialog = document.createElement("div");
  dialog.id = DIALOG_ID;
  dialog.className = "cd-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "cd-title");

  dialog.innerHTML = `
    <div class="cd-header">
      <span class="cd-title" id="cd-title">创建 AI 助理</span>
      <button type="button" class="cd-close" id="cd-close" aria-label="关闭">✕</button>
    </div>
    <div class="cd-body">
      <p class="cd-section-label">选择类型</p>
      <div class="cd-radio-group">
        <label class="cd-radio-card">
          <input type="radio" name="agent-type" value="classic" checked />
          <div class="cd-radio-content">
            <span class="cd-radio-icon">🤖</span>
            <div class="cd-radio-text">
              <span class="cd-radio-title">经典</span>
              <span class="cd-radio-desc">完整工具链，详尽回复</span>
            </div>
          </div>
        </label>
        <label class="cd-radio-card">
          <input type="radio" name="agent-type" value="im" />
          <div class="cd-radio-content">
            <span class="cd-radio-icon">💬</span>
            <div class="cd-radio-text">
              <span class="cd-radio-title">IM</span>
              <span class="cd-radio-desc">短句回复，后台任务，可打断</span>
            </div>
          </div>
        </label>
        <label class="cd-radio-card">
          <input type="radio" name="agent-type" value="group" />
          <div class="cd-radio-content">
            <span class="cd-radio-icon">👥</span>
            <div class="cd-radio-text">
              <span class="cd-radio-title">群聊</span>
              <span class="cd-radio-desc">多 Agent 协作讨论</span>
            </div>
          </div>
        </label>
      </div>
      <p class="cd-section-label" style="margin-top:16px;">名称</p>
      <input
        type="text"
        id="cd-name-input"
        class="cd-input"
        placeholder="给 AI 助理起个名字"
        maxlength="40"
        autocomplete="off"
      />
      <div id="cd-group-members" style="display:none; margin-top:12px;">
        <p class="cd-section-label" style="margin-top:8px;">选择成员</p>
        <div id="cd-agent-checkboxes" class="cd-checkbox-list"></div>
      </div>
      <p class="cd-error" id="cd-error" style="display:none;"></p>
    </div>
    <div class="cd-footer">
      <button type="button" class="btn btn-secondary" id="cd-cancel">取消</button>
      <button type="button" class="btn btn-primary" id="cd-confirm">创建</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Wire button events
  document.getElementById("cd-close")!.addEventListener("click", hideDialog);
  document.getElementById("cd-cancel")!.addEventListener("click", hideDialog);

  // Confirm: read values and invoke create_agent
  document.getElementById("cd-confirm")!.addEventListener("click", handleConfirm);

  // Enter key in name input → confirm
  document.getElementById("cd-name-input")!.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleConfirm();
    }
  });

  // ESC to close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideDialog();
  });

  return dialog;
}

function showDialog(prefillType: "classic" | "im" | "group" = "classic"): void {
  const dialog = ensureDialog();
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.style.display = "flex";
  dialog.style.display = "flex";
  // Reset state
  const nameInput = document.getElementById("cd-name-input") as HTMLInputElement;
  if (nameInput) {
    nameInput.value = "";
    nameInput.focus();
  }
  const errorEl = document.getElementById("cd-error");
  if (errorEl) errorEl.style.display = "none";
  // Apply pre-selected radio (avoids the setTimeout race condition
  // callers used to rely on).
  const radio = document.querySelector<HTMLInputElement>(
    `input[name="agent-type"][value="${prefillType}"]`
  );
  if (radio) radio.checked = true;
  // Reset name placeholder and group members visibility based on selection
  const groupMembers = document.getElementById("cd-group-members");
  if (nameInput) {
    nameInput.placeholder = prefillType === "group" ? "给群聊起个名字" : "给 AI 助理起个名字";
  }
  if (groupMembers) groupMembers.style.display = prefillType === "group" ? "block" : "none";
  // Populate agent checkboxes for group mode
  populateAgentCheckboxes();
  // Wire radio change to show/hide group members
  wireRadioChanges();
}

function hideDialog(): void {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.style.display = "none";
  const dialog = document.getElementById(DIALOG_ID);
  if (dialog) dialog.style.display = "none";
}

function populateAgentCheckboxes(): void {
  const container = document.getElementById("cd-agent-checkboxes");
  if (!container) return;
  container.innerHTML = "";
  for (const agent of store.agents) {
    const item = document.createElement("label");
    item.className = "cd-checkbox-item";
    item.innerHTML = `
      <input type="checkbox" name="cd-group-member" value="${escapeHtml(agent.hash)}" />
      <span class="cd-checkbox-name">${escapeHtml(agent.name)}</span>
    `;
    container.appendChild(item);
  }
  if (store.agents.length === 0) {
    container.innerHTML = '<div class="cd-empty-agents">暂无 Agent，请先创建 Agent</div>';
  }
}

function wireRadioChanges(): void {
  const radios = document.querySelectorAll<HTMLInputElement>('input[name="agent-type"]');
  const nameInput = document.getElementById("cd-name-input") as HTMLInputElement;
  const groupMembers = document.getElementById("cd-group-members");
  for (const radio of radios) {
    radio.addEventListener("change", () => {
      if (radio.value === "group") {
        if (nameInput) nameInput.placeholder = "给群聊起个名字";
        if (groupMembers) groupMembers.style.display = "block";
      } else {
        if (nameInput) nameInput.placeholder = "给 AI 助理起个名字";
        if (groupMembers) groupMembers.style.display = "none";
      }
    });
  }
}

async function handleConfirm(): Promise<void> {
  const nameInput = document.getElementById("cd-name-input") as HTMLInputElement;
  const errorEl = document.getElementById("cd-error");
  if (!nameInput || !errorEl) return;

  const name = nameInput.value.trim();
  if (!name) {
    errorEl.textContent = "请输入名称";
    errorEl.style.display = "block";
    nameInput.focus();
    return;
  }

  const selectedType = document.querySelector<HTMLInputElement>('input[name="agent-type"]:checked');
  const agentType = selectedType?.value ?? "classic";

  const confirmBtn = document.getElementById("cd-confirm") as HTMLButtonElement;
  const cancelBtn = document.getElementById("cd-cancel") as HTMLButtonElement;
  if (confirmBtn) confirmBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  errorEl.style.display = "none";

  try {
    if (agentType === "group") {
      // Collect selected agent hashes
      const checkboxes = document.querySelectorAll<HTMLInputElement>('input[name="cd-group-member"]:checked');
      const memberHashes = Array.from(checkboxes).map((cb) => cb.value);
      if (memberHashes.length < 2) {
        errorEl.textContent = "请至少选择 2 个成员";
        errorEl.style.display = "block";
        return;
      }
      const newGroup = await invoke<GroupInfo>("create_group", {
        name,
        memberHashes,
      });
      // Add to store and switch to the new group
      store.setGroups([...store.groups, {
        id: newGroup.id,
        name: newGroup.name,
        announcement: newGroup.announcement,
        memberCount: newGroup.memberCount,
        createdAt: newGroup.createdAt,
        unreadCount: 0,
      }]);
      // Switch to the new group via custom event
      window.dispatchEvent(
        new CustomEvent("group-selected", { detail: { groupId: newGroup.id } }),
      );
      hideDialog();
    } else {
      const newAgent = await invoke<AgentInfo>("create_agent", {
        name,
        agent_type: agentType,
      });

      // Add to store and switch to the new agent
      const currentAgents = store.agents;
      store.setAgents([...currentAgents, newAgent]);

      // Switch to the new chat
      await selectChat(newAgent.hash);

      hideDialog();
    }
  } catch (err) {
    const msg = typeof err === "string" ? err : (err as Error)?.message ?? "创建失败";
    errorEl.textContent = msg;
    errorEl.style.display = "block";
  } finally {
    if (confirmBtn) confirmBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
  }
}

// ---- Re-export selectChat from chat.ts scope ----
// We import it from store for type only; the actual switch is done via store
// methods + chat.ts's selectChat function which lives in the chat module scope.
// We expose a custom event that chat.ts listens to.

async function selectChat(agentHash: string): Promise<void> {
  // Dispatch a custom event that chat.ts will handle
  window.dispatchEvent(
    new CustomEvent("agent-created", { detail: { agentHash } }),
  );
}

// ---- Public API (called from chat.ts wire) ----

/**
 * Open the create-agent dialog. Pass `prefill` to bias the radio
 * button toward a specific type (e.g. `"group"` when the user clicked
 * "发起群聊" in the plus dropdown). Default is `"classic"`.
 */
export function openCreateDialog(prefill: "classic" | "im" | "group" = "classic"): void {
  showDialog(prefill);
}
