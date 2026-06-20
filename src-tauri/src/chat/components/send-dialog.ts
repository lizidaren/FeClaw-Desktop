// =========================================================
// FeClaw Desktop — Send Dialog (Phase 3 V3)
// =========================================================
//
// Modal dialog that appears when the user right-clicks a file
// in Windows Explorer and selects "📤 FeClaw 发送" or "📎 FeClaw 引用".
//
// Flow:
//   1. User right-clicks file → shell invokes FeClaw Desktop --right-click <mode> <path>
//   2. main.rs saves pending file to ~/.feclaw/pending-right-click.json
//   3. lib.rs emits "right-click-pending" event on startup
//   4. chat.ts listens for the event → openSendDialog(pending)
//   5. User picks agent, optional message, mode → Send
//   6. File card + message inserted into the selected agent's chat

import { store, type AgentInfo, type ChatMessage } from "../store";
import { addCard, type PickedFile } from "./input-box";

// ---- Tauri bridge ------------------------------------------------

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

// ---- Types -------------------------------------------------------

export type PendingFile = {
  mode: string;   // "reference" | "send"
  path: string;    // absolute local path
};

// ---- State -------------------------------------------------------

let dialogVisible = false;

// ---- Styles ------------------------------------------------------

function injectStyles(): void {
  if (document.getElementById("sd-styles")) return;
  const style = document.createElement("style");
  style.id = "sd-styles";
  style.textContent = `
/* Send Dialog */
.send-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.send-dialog {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 16px;
  width: 460px;
  max-width: 95vw;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: sdIn 0.2s ease-out;
}
@keyframes sdIn {
  from { opacity: 0; transform: scale(0.94) translateY(8px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
.send-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border-soft);
  flex-shrink: 0;
}
.send-dialog-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.send-dialog-close {
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
.send-dialog-close:hover { background: var(--bg-hover); color: var(--text); }

.send-dialog-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
}

/* File preview row */
.sd-file-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--bg);
  border: 1px solid var(--border-soft);
}
.sd-file-icon { font-size: 28px; flex-shrink: 0; }
.sd-file-info { flex: 1; min-width: 0; }
.sd-file-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sd-file-size { font-size: 12px; color: var(--text-muted); margin-top: 2px; }

/* Mode selection */
.sd-section-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}
.sd-mode-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sd-mode-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-soft);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
  font-size: 14px;
  color: var(--text);
}
.sd-mode-option:hover { background: var(--bg-hover); }
.sd-mode-option.selected {
  border-color: var(--primary);
  background: rgba(56, 189, 248, 0.08);
}
.sd-mode-option input[type="radio"] { display: none; }
.sd-mode-radio {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid var(--border);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.12s;
}
.sd-mode-option.selected .sd-mode-radio {
  border-color: var(--primary);
}
.sd-mode-radio::after {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--primary);
  opacity: 0;
  transition: opacity 0.12s;
}
.sd-mode-option.selected .sd-mode-radio::after { opacity: 1; }
.sd-mode-label { flex: 1; }
.sd-mode-desc { font-size: 11px; color: var(--text-muted); margin-top: 1px; }

/* Agent dropdown */
.sd-agent-select {
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 14px;
  outline: none;
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  padding-right: 36px;
}
.sd-agent-select:focus { border-color: var(--primary); }

/* Message textarea */
.sd-message-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}
.sd-message-textarea {
  width: 100%;
  min-height: 80px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 14px;
  outline: none;
  resize: vertical;
  box-sizing: border-box;
}
.sd-message-textarea:focus { border-color: var(--primary); }

/* Footer */
.send-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px 18px;
  border-top: 1px solid var(--border-soft);
  flex-shrink: 0;
}
.sd-btn-cancel {
  padding: 8px 18px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  font-family: inherit;
  transition: background 0.12s, color 0.12s;
}
.sd-btn-cancel:hover { background: var(--bg-hover); color: var(--text); }
.sd-btn-send {
  padding: 8px 20px;
  border-radius: 8px;
  border: none;
  background: var(--primary);
  color: white;
  cursor: pointer;
  font-size: 14px;
  font-family: inherit;
  font-weight: 500;
  transition: background 0.12s;
}
.sd-btn-send:hover { background: var(--primary-dark); }
.sd-btn-send:disabled { opacity: 0.5; cursor: not-allowed; }
`;
  document.head.appendChild(style);
}

// ---- Helpers -----------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getFileNameFromPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? path;
}

function getFileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.substring(i + 1).toLowerCase() : "";
}

function getFileEmoji(name: string): string {
  const ext = getFileExt(name);
  const map: Record<string, string> = {
    pdf: "📄", doc: "📝", docx: "📝", txt: "📃", md: "📋",
    xls: "📊", xlsx: "📊", csv: "📊",
    ppt: "📽️", pptx: "📽️",
    zip: "🗜️", rar: "🗜️", "7z": "🗜️", tar: "🗜️", gz: "🗜️",
    jpg: "🖼️", jpeg: "🖼️", png: "🖼️", gif: "🖼️", bmp: "🖼️", webp: "🖼️", svg: "🖼️",
    mp3: "🎵", wav: "🎵", flac: "🎵", aac: "🎵", ogg: "🎵",
    mp4: "🎬", mkv: "🎬", avi: "🎬", mov: "🎬", wmv: "🎬",
    js: "📜", ts: "📜", py: "🐍", rs: "🦀", go: "🔵", java: "☕",
    html: "🌐", css: "🎨", json: "📋", xml: "📋", yaml: "📋", yml: "📋",
    exe: "⚙️", dll: "⚙️",
  };
  return map[ext] ?? "📄";
}

// ---- Dialog rendering --------------------------------------------

let currentPending: PendingFile | null = null;
let currentFileSize: number = 0;

export async function openSendDialog(pending: PendingFile): Promise<void> {
  if (dialogVisible) return;
  dialogVisible = true;
  currentPending = pending;
  currentFileSize = 0;

  injectStyles();

  // Get file size
  try {
    // Try to get size via VFS read (will fail for large files but gives us size)
    // Use a direct stat approach via invoke
    const fileInfo = await invoke<{ size: number } | null>("file_read", { path: pending.path });
    void fileInfo; // not needed, we use fallback below
  } catch {
    // Ignore — file may be large or inaccessible; size stays 0
  }

  // Try file size via fetch (works for local files)
  try {
    const resp = await fetch(`file://${pending.path}`);
    if (resp.ok && resp.headers.has("content-length")) {
      currentFileSize = parseInt(resp.headers.get("content-length") ?? "0", 10);
    }
  } catch {
    // Ignore — cross-origin or inaccessible
  }

  const fileName = getFileNameFromPath(pending.path);
  const emoji = getFileEmoji(fileName);
  const sizeLabel = currentFileSize > 0 ? formatBytes(currentFileSize) : "未知大小";
  const mode = pending.mode === "reference" ? "reference" : "send_copy";

  const agents: AgentInfo[] = store.agents;

  renderDialog(fileName, sizeLabel, emoji, mode, agents);
}

function renderDialog(
  fileName: string,
  sizeLabel: string,
  emoji: string,
  defaultMode: string,
  agents: AgentInfo[]
): void {
  // Remove any existing dialog
  document.getElementById("send-dialog-overlay")?.remove();

  const selectedAgentHash = store.activeAgentHash ?? (agents.length > 0 ? agents[0].hash : null);

  const overlay = document.createElement("div");
  overlay.className = "send-dialog-overlay";
  overlay.id = "send-dialog-overlay";
  overlay.innerHTML = `
    <div class="send-dialog" role="dialog" aria-modal="true" aria-labelledby="sd-title">
      <div class="send-dialog-header">
        <span class="send-dialog-title" id="sd-title">发送文件</span>
        <button class="send-dialog-close" id="sd-close" aria-label="关闭">✕</button>
      </div>
      <div class="send-dialog-body">
        <!-- File preview -->
        <div class="sd-file-row">
          <span class="sd-file-icon">${emoji}</span>
          <div class="sd-file-info">
            <div class="sd-file-name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
            <div class="sd-file-size">${sizeLabel}</div>
          </div>
        </div>

        <!-- Mode selection -->
        <div>
          <div class="sd-section-label">发送方式</div>
          <div class="sd-mode-options">
            <label class="sd-mode-option ${defaultMode === "reference" ? "selected" : ""}" data-mode="reference">
              <input type="radio" name="sd-mode" value="reference" ${defaultMode === "reference" ? "checked" : ""} />
              <span class="sd-mode-radio"></span>
              <span class="sd-mode-label">
                <div>📎 引用（Agent 可读写）</div>
                <div class="sd-mode-desc">直接引用文件，Agent 可以读取和修改</div>
              </span>
            </label>
            <label class="sd-mode-option ${defaultMode === "send_copy" ? "selected" : ""}" data-mode="send_copy">
              <input type="radio" name="sd-mode" value="send_copy" ${defaultMode === "send_copy" ? "checked" : ""} />
              <span class="sd-mode-radio"></span>
              <span class="sd-mode-label">
                <div>📤 发送（只读副本）</div>
                <div class="sd-mode-desc">发送文件副本，Agent 只能读取</div>
              </span>
            </label>
          </div>
        </div>

        <!-- Agent selection -->
        <div>
          <div class="sd-section-label">发送到</div>
          <select class="sd-agent-select" id="sd-agent-select">
            ${agents.map((a) => {
              const sel = a.hash === selectedAgentHash ? "selected" : "";
              return `<option value="${escapeHtml(a.hash)}" ${sel}>${escapeHtml(a.name)}</option>`;
            }).join("")}
          </select>
        </div>

        <!-- Message -->
        <div>
          <div class="sd-message-label">附加消息（可选）</div>
          <textarea class="sd-message-textarea" id="sd-message"
            placeholder="输入附言给 Agent（支持 Ctrl+V 粘贴图片）"
            rows="3"></textarea>
        </div>
      </div>
      <div class="send-dialog-footer">
        <button class="sd-btn-cancel" id="sd-cancel">取消</button>
        <button class="sd-btn-send" id="sd-send">发送</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Wire mode radio buttons
  overlay.querySelectorAll<HTMLElement>(".sd-mode-option").forEach((el) => {
    el.addEventListener("click", () => {
      overlay.querySelectorAll(".sd-mode-option").forEach((o) => o.classList.remove("selected"));
      el.classList.add("selected");
      const radio = el.querySelector<HTMLInputElement>('input[type="radio"]');
      if (radio) radio.checked = true;
    });
  });

  // Close button
  overlay.querySelector("#sd-close")?.addEventListener("click", closeDialog);
  overlay.querySelector("#sd-cancel")?.addEventListener("click", closeDialog);

  // Click outside → close
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDialog();
  });

  // Escape → close
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      closeDialog();
      document.removeEventListener("keydown", escHandler);
    }
  };
  document.addEventListener("keydown", escHandler);

  // Paste handler for textarea
  const textarea = overlay.querySelector<HTMLTextAreaElement>("#sd-message");
  if (textarea) {
    textarea.addEventListener("paste", (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) return;
          void pasteImageIntoTextarea(textarea, file);
          return;
        }
      }
    });
  }

  // Send button
  overlay.querySelector("#sd-send")?.addEventListener("click", () => {
    void handleSend(overlay, fileName, sizeLabel);
  });

  // Focus textarea
  textarea?.focus();
}

async function pasteImageIntoTextarea(textarea: HTMLTextAreaElement, file: File): Promise<void> {
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const base64 = ev.target?.result as string;
    if (!base64) return;
    try {
      const info = await invoke<{ temp_path: string }>("save_temp_image", { base64Data: base64 });
      // Append image marker to textarea
      const marker = `\n[image:${info.temp_path}]`;
      textarea.value += marker;
      textarea.focus();
    } catch (err) {
      console.error("save_temp_image failed:", err);
    }
  };
  reader.readAsDataURL(file);
}

async function handleSend(overlay: HTMLElement, fileName: string, sizeLabel: string): Promise<void> {
  if (!currentPending) return;

  const selectedMode = overlay.querySelector<HTMLInputElement>('input[name="sd-mode"]:checked');
  const mode = (selectedMode?.value ?? "send_copy") as "reference" | "send_copy";

  const agentSelect = overlay.querySelector<HTMLSelectElement>("#sd-agent-select");
  const agentHash = agentSelect?.value ?? store.activeAgentHash;
  if (!agentHash) {
    alert("请选择一个 Agent");
    return;
  }

  const messageEl = overlay.querySelector<HTMLTextAreaElement>("#sd-message");
  const message = messageEl?.value.trim() ?? "";

  // Build a PickedFile from the pending path
  const pickedFile: PickedFile = {
    id: `right-click-${Date.now()}`,
    name: fileName,
    path: currentPending.path,
    size_label: sizeLabel,
    mode: mode,
    size_bytes: currentFileSize,
  };

  // Add the file card (internally handled by input-box)
  addCard(pickedFile);

  // Switch to the target agent
  const { selectChat } = await import("../chat");
  await selectChat(agentHash);

  // Set the message text
  const input = document.querySelector<HTMLTextAreaElement>("#input");
  if (input) {
    input.value = message;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
    input.focus();
  }

  closeDialog();
}

function closeDialog(): void {
  dialogVisible = false;
  currentPending = null;
  document.getElementById("send-dialog-overlay")?.remove();
}
