// =========================================================
// FeClaw Desktop — Create Agent Dialog (Phase 0b V3)
// =========================================================
//
// Popup modal for creating a new Agent.
// Shown when the user clicks the ➕ (new chat) button.
//
// Flow:
//   user clicks ➕ → show dialog → pick type + name → confirm
//     → invoke create_agent → add to store → switch to new chat
//
// The dialog is injected as a hidden element into the DOM and
// toggled via CSS classes.

import { store, type AgentInfo } from "../store";

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

function showDialog(): void {
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
  // Default to classic
  const classicRadio = document.querySelector<HTMLInputElement>('input[name="agent-type"][value="classic"]');
  if (classicRadio) classicRadio.checked = true;
}

function hideDialog(): void {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.style.display = "none";
  const dialog = document.getElementById(DIALOG_ID);
  if (dialog) dialog.style.display = "none";
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

export function openCreateDialog(): void {
  showDialog();
}
