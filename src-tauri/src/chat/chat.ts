// =========================================================
// FeClaw Desktop — Three-panel Chat UI logic (Phase 0a V3)
// =========================================================
//
// Handles:
//   - Agent list loading (from engine API)
//   - Chat switching with draft save/load
//   - Message sending and streaming
//   - Image paste → VFS images/
//   - Three-panel rendering
//
// Compiled to chat.js with esbuild (see project docs).

import { store, type AgentInfo, type ChatMessage, type ChatItem } from "./store";
import { openCreateDialog } from "./components/create-dialog";
import { openSidePanel } from "./components/side-panel";
import { setupInputBox, getFileCards, clearFileCards } from "./components/input-box";

// ---- Tauri bridge ------------------------------------------------

type TauriCore = {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>;
};

type TauriGlobal = {
  core?: TauriCore;
  event?: { listen: TauriCore["listen"] };
};

function getTauri(): TauriCore {
  const g = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!g?.core) throw new Error("Tauri global not available");
  return g.core;
}

const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  getTauri().invoke<T>(cmd, args);

const listen = <T>(event: string, handler: (e: { payload: T }) => void) =>
  getTauri().listen<T>(event, handler);

// ---- DOM helpers ------------------------------------------------

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ---- Rendering ---------------------------------------------------

function renderChatList(items: ChatItem[]): void {
  const list = $<HTMLDivElement>("chat-list");
  const hint = $<HTMLDivElement>("empty-list-hint");
  if (!list) return;

  if (items.length === 0) {
    if (hint) hint.style.display = "";
    list.innerHTML = "";
    if (hint) list.appendChild(hint);
    return;
  }

  if (hint) hint.style.display = "none";
  list.innerHTML = "";

  for (const item of items) {
    const el = document.createElement("div");
    el.className = "chat-item" + (item.active ? " active" : "");
    el.dataset.agentHash = item.agent_hash;
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", String(!!item.active));
    el.innerHTML = `
      <div class="chat-item-avatar">${item.avatar_letter}</div>
      <div class="chat-item-info">
        <div class="chat-item-name">${escapeHtml(item.name)}</div>
        <div class="chat-item-preview">${escapeHtml(item.last_message)}</div>
      </div>
      <div class="chat-item-meta">
        ${item.last_time ? `<span class="chat-item-time">${item.last_time}</span>` : ""}
        ${item.unread ? '<span class="chat-item-badge"></span>' : ""}
      </div>
    `;
    el.addEventListener("click", () => selectChat(item.agent_hash));
    list.appendChild(el);
  }
}

function renderMessages(messages: ChatMessage[]): void {
  const list = $<HTMLDivElement>("messages");
  if (!list) return;

  list.innerHTML = "";

  if (messages.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">F</div>
        <h2>开始一次对话</h2>
        <p>向 AI 助理发送消息，它会在这里回复你。</p>
      </div>`;
    return;
  }

  for (const msg of messages) {
    if (msg.is_deleted) continue;
    renderMessageEl(list, msg);
  }
  scrollToBottom();
}

function renderMessageEl(parent: HTMLElement, msg: ChatMessage): void {
  const wrap = document.createElement("div");
  wrap.className = `bubble ${msg.role === "user" ? "user" : "assistant"}`;
  wrap.dataset.id = msg.id;

  // Image message
  if (msg.message_type === "image" || msg.content.startsWith("data:image/")) {
    const imgWrap = document.createElement("div");
    imgWrap.className = "bubble-image";
    const img = document.createElement("img");
    img.src = msg.content;
    img.alt = "图片";
    imgWrap.appendChild(img);
    wrap.appendChild(imgWrap);
  } else {
    const body = document.createElement("div");
    body.className = "bubble-body";
    body.textContent = msg.content;
    wrap.appendChild(body);
  }

  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  const ts = msg.timestamp || formatTime(msg.created_at);
  const agentLabel = msg.agent ? ` · ${msg.agent}` : "";
  meta.textContent = ts ? `${ts}${agentLabel}` : agentLabel;
  wrap.appendChild(meta);

  parent.appendChild(wrap);
}

function appendStreamingMessage(id: string, chunk: string): void {
  const list = $<HTMLDivElement>("messages");
  if (!list) return;
  let el = list.querySelector(`[data-id="${id}"]`) as HTMLElement | null;
  if (!el) {
    el = document.createElement("div");
    el.className = "bubble assistant streaming";
    el.dataset.id = id;
    const body = document.createElement("div");
    body.className = "bubble-body";
    el.appendChild(body);
    list.appendChild(el);
  }
  const body = el.querySelector(".bubble-body") as HTMLElement | null;
  if (body) body.textContent = (body.textContent ?? "") + chunk;
  scrollToBottom();
}

function finalizeStreaming(id: string, finalText?: string): void {
  const list = $<HTMLDivElement>("messages");
  if (!list) return;
  const el = list.querySelector(`[data-id="${id}"]`) as HTMLElement | null;
  if (!el) return;
  el.classList.remove("streaming");
  if (typeof finalText === "string") {
    const body = el.querySelector(".bubble-body") as HTMLElement | null;
    if (body) body.textContent = finalText;
  }
}

// ---- Actions ----------------------------------------------------

async function selectChat(agentHash: string): Promise<void> {
  // Save current draft before switching
  if (store.activeAgentHash) {
    const input = $<HTMLTextAreaElement>("input");
    if (input && input.value.trim()) {
      try {
        await invoke("save_draft", {
          channel: `im:${store.activeAgentHash}`,
          content: input.value,
        });
      } catch (e) {
        console.error("save_draft failed:", e);
      }
    }
  }

  // Activate new chat
  store.setActiveChat(agentHash);
  renderChatList(store.chatItems);

  // Load draft
  const input = $<HTMLTextAreaElement>("input");
  if (input) input.value = "";
  try {
    const draft = await invoke<string | null>("load_draft", {
      channel: `im:${agentHash}`,
    });
    if (draft && input) {
      input.value = draft;
      autoResize();
    }
  } catch (e) {
    console.error("load_draft failed:", e);
  }

  // Load history
  await loadChatHistory(agentHash);
  showActiveChat();
}

async function loadChatHistory(agentHash: string): Promise<void> {
  try {
    const msgs = await invoke<ChatMessage[]>("get_chat_history_by_agent", {
      agentHash,
    });
    store.setMessages(msgs);
    renderMessages(msgs);
  } catch (e) {
    console.error("load_chat_history failed:", e);
    store.setMessages([]);
    renderMessages([]);
  }
}

async function sendMessage(): Promise<void> {
  const input = $<HTMLTextAreaElement>("input");
  const btn = $<HTMLButtonElement>("btn-send");
  if (!input || !btn) return;
  const text = input.value.trim();
  if (!text && getFileCards().length === 0) return;
  if (!store.activeAgentHash) return;

  btn.disabled = true;

  // Build message text including file card info
  const cards = getFileCards();
  let fullText = text;
  if (cards.length > 0) {
    const cardLines = cards.map((f) => {
      const mode = f.mode === "reference" ? "引用" : "发送副本";
      return `[文件: ${f.name} (${f.size_label}) - ${mode} - ${f.path}]`;
    }).join("\n");
    fullText = (fullText ? text + "\n" : "") + cardLines;
  }

  input.value = "";
  autoResize();
  clearFileCards();

  // Optimistic local echo
  const id = `msg-${Date.now()}`;
  const ts = Math.floor(Date.now() / 1000);
  const msg: ChatMessage = {
    id,
    channel: `im:${store.activeAgentHash}`,
    agent_hash: store.activeAgentHash,
    role: "user",
    content: text,
    message_type: "text",
    created_at: ts,
    synced: false,
    is_deleted: false,
    timestamp: formatTime(ts),
  };

  // Insert into DB
  try {
    await invoke("insert_chat_message", {
      id: msg.id,
      channel: msg.channel,
      agentHash: store.activeAgentHash,
      role: msg.role,
      content: msg.content,
      messageType: msg.message_type ?? "text",
      createdAt: ts * 1000, // ms
    });
  } catch (e) {
    console.error("insert_chat_message failed:", e);
  }

  store.appendMessage(msg);
  const list = $<HTMLDivElement>("messages");
  if (list) renderMessageEl(list, msg);
  scrollToBottom();

  // Send via WS
  try {
    await invoke<string>("send_chat_message", { text: fullText });
  } catch (e) {
    const errMsg = typeof e === "string" ? e : "发送失败";
    store.appendMessage({
      id: `err-${Date.now()}`,
      channel: msg.channel,
      agent_hash: store.activeAgentHash,
      role: "assistant",
      content: `⚠ ${errMsg}`,
      message_type: "text",
      created_at: Math.floor(Date.now() / 1000),
    });
    const list2 = $<HTMLDivElement>("messages");
    if (list2) {
      renderMessageEl(list2, {
        id: `err-${Date.now()}`,
        channel: msg.channel,
        agent_hash: store.activeAgentHash,
        role: "assistant",
        content: `⚠ ${errMsg}`,
        message_type: "text",
        created_at: Math.floor(Date.now() / 1000),
      });
    }
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

// ---- Image paste -------------------------------------------------

async function handlePaste(e: ClipboardEvent): Promise<void> {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      await saveAndInsertImage(file);
      return;
    }
  }
}

async function saveAndInsertImage(file: File): Promise<void> {
  if (!store.activeAgentHash) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const base64 = ev.target?.result as string;
    if (!base64) return;
    // In V3 Phase 0a, images go to Agent VFS images/
    // For now, embed as data URL (Phase 2+ will handle VFS write)
    const input = $<HTMLTextAreaElement>("input");
    if (!input) return;
    // Append image marker to input as placeholder
    const marker = `[image:${file.name}]`;
    input.value = (input.value || "") + marker;
    autoResize();
    // TODO: invoke('save_image_to_vfs', { agent_hash, base64, filename })
    // This is deferred to Phase 2 (VFS file manager)
  };
  reader.readAsDataURL(file);
}

// ---- Tab switching ----------------------------------------------

function switchTab(tabId: "chat" | "profile" | "settings"): void {
  store.setTab(tabId);
  document.querySelectorAll<HTMLElement>(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  if (tabId === "settings") {
    void invoke("open_settings_window").catch((e) => console.error("open_settings:", e));
  }
}

// ---- Show active chat panel -------------------------------------

function showActiveChat(): void {
  const noChat = $<HTMLDivElement>("no-chat-state");
  const activeChat = $<HTMLDivElement>("active-chat");
  if (!noChat || !activeChat) return;
  noChat.style.display = "none";
  activeChat.style.display = "flex";

  // Update header
  const agent = store.agents.find((a) => a.hash === store.activeAgentHash);
  const nameEl = $<HTMLDivElement>("chat-name");
  const avatarEl = $<HTMLDivElement>("chat-avatar");
  if (nameEl) nameEl.textContent = agent?.name ?? "Agent";
  if (avatarEl) avatarEl.textContent = (agent?.name ?? "A").charAt(0).toUpperCase();
}

// ---- Init -------------------------------------------------------

async function initChat(): Promise<void> {
  // Init SQLite DB
  try {
    await invoke("init_db");
  } catch (e) {
    console.error("init_db failed:", e);
  }

  // Check and import legacy V2 history
  try {
    const hasLegacy = await invoke<boolean>("check_legacy_chat_history");
    if (hasLegacy) {
      const count = await invoke<u64>("import_chat_history");
      console.log(`Imported ${count} legacy messages`);
    }
  } catch (e) {
    console.error("import_chat_history failed:", e);
  }

  // Load permissions
  try {
    const perms = await invoke<{ user_id?: string; username?: string; is_admin: boolean; agent_permissions: Array<{ agent_hash: string; permission_mode: string }> }>("get_permissions");
    store.setPermissions(perms);
  } catch (e) {
    console.error("get_permissions failed:", e);
  }

  // Load agents
  try {
    const agents = await invoke<AgentInfo[]>("list_agents");
    store.setAgents(agents);
    renderChatList(store.chatItems);

    // Auto-select first agent if available
    if (agents.length > 0) {
      await selectChat(agents[0].hash);
    }
  } catch (e) {
    console.error("list_agents failed:", e);
  }
}

// ---- Composer helpers -------------------------------------------

function autoResize(): void {
  const input = $<HTMLTextAreaElement>("input");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}

function scrollToBottom(): void {
  const list = $<HTMLDivElement>("messages");
  if (!list) return;
  list.scrollTop = list.scrollHeight;
}

// ---- Utilities --------------------------------------------------

function formatTime(ts: number | string | undefined): string {
  if (!ts) return "";
  const n = typeof ts === "string" ? Number(ts) : ts;
  if (!Number.isFinite(n) || n <= 0) return "";
  // If it looks like seconds (before year 2100 in seconds), convert to ms
  const ms = n < 4102444800 ? n * 1000 : n;
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- Event subscriptions ----------------------------------------

async function subscribeEvents(): Promise<void> {
  // chat-event from WS
  try {
    await listen<ChatMessage>("chat-event", (e) => {
      const msg = e.payload;
      if (!msg || !msg.id) return;
      if (msg.agent_hash !== store.activeAgentHash) return;
      store.appendMessage(msg);
      const list = $<HTMLDivElement>("messages");
      if (list) renderMessageEl(list, msg);
      scrollToBottom();
    });
  } catch (e) {
    console.error("listen chat-event:", e);
  }

  // chat-stream for streaming messages
  try {
    await listen<{ id: string; kind: string; data?: unknown; timestamp?: string }>(
      "chat-stream",
      (e) => {
        const ev = e.payload;
        if (!ev) return;
        switch (ev.kind) {
          case "thinking":
            renderEventPill("thinking", "思考中…");
            break;
          case "tool":
            renderEventPill("tool", `调用工具: ${describeToolCall(ev.data)}`);
            break;
          case "tool_result":
            renderEventPill("tool", "工具返回完成");
            break;
          case "message_start": {
            const id = (ev.data as { id?: string } | undefined)?.id ?? ev.id;
            appendStreamingMessage(id, "");
            break;
          }
          case "message_chunk": {
            const id = (ev.data as { id?: string } | undefined)?.id ?? ev.id;
            const text = (ev.data as { text?: string } | undefined)?.text ?? "";
            appendStreamingMessage(id, text);
            break;
          }
          case "message_end": {
            const id = (ev.data as { id?: string } | undefined)?.id ?? ev.id;
            const final = (ev.data as { text?: string } | undefined)?.text;
            finalizeStreaming(id, final);
            break;
          }
          case "done":
            renderEventPill("done", "✓ 完成");
            break;
        }
      },
    );
  } catch (e) {
    console.error("listen chat-stream:", e);
  }

  // file-operation-request
  try {
    await listen<{ op_id: string; operation: string; path: string; reason?: string }>(
      "file-operation-request",
      (e) => {
        const req = e.payload;
        if (!req) return;
        // Render consent card inline (deferred to Phase 2)
        console.log("file operation request:", req);
      },
    );
  } catch (e) {
    console.error("listen file-operation-request:", e);
  }
}

function renderEventPill(kind: string, label: string): void {
  const list = $<HTMLDivElement>("messages");
  if (!list) return;
  const pill = document.createElement("div");
  pill.className = `event-pill ${kind}`;
  pill.textContent = label;
  list.appendChild(pill);
  scrollToBottom();
}

function describeToolCall(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const obj = data as { name?: string; args?: unknown };
  if (!obj.name) return "";
  try {
    const args = obj.args ? JSON.stringify(obj.args) : "";
    return args ? `${obj.name}(${args})` : obj.name;
  } catch {
    return obj.name;
  }
}

// ---- Wire -------------------------------------------------------

function wire(): void {
  // Set up the extended input box (file cards, attachment button)
  setupInputBox();

  // Listen for agent-created events from create-dialog
  window.addEventListener("agent-created", ((e: CustomEvent<{ agentHash: string }>) => {
    void selectChat(e.detail.agentHash);
  }) as EventListener);

  // Tab bar
  document.querySelectorAll<HTMLElement>(".tab-btn").forEach((btn) => {
    const tab = btn.dataset.tab as "chat" | "profile" | "settings";
    if (tab) {
      btn.addEventListener("click", () => switchTab(tab));
    }
  });

  // Composer
  const input = $<HTMLTextAreaElement>("input");
  const send = $<HTMLButtonElement>("btn-send");

  if (input) {
    input.addEventListener("input", autoResize);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        void sendMessage();
      }
    });
    // Draft autosave on input change
    input.addEventListener("input", () => {
      store.setDraft(input.value);
    });
    // Paste image
    input.addEventListener("paste", handlePaste);
  }

  if (send) {
    send.addEventListener("click", () => void sendMessage());
  }

  // New chat button → open create dialog
  const newChat = $<HTMLButtonElement>("btn-new-chat");
  if (newChat) {
    newChat.addEventListener("click", () => {
      openCreateDialog();
    });
  }

  // ⋮ button → open side panel for the active agent
  const chatMenu = $<HTMLButtonElement>("btn-chat-menu");
  if (chatMenu) {
    chatMenu.addEventListener("click", () => {
      if (store.activeAgentHash) {
        void openSidePanel(store.activeAgentHash);
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  wire();
  void initChat();
  void subscribeEvents();
});