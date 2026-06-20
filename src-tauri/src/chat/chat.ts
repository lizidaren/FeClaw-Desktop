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

import { store, type AgentInfo, type ChatMessage, type ChatItem, type Attachment, type GroupInfo, type GroupMessage, type MomentInfo } from "./store";
import { openCreateDialog } from "./components/create-dialog";
import { openSidePanel } from "./components/side-panel";
import { setupInputBox, setupTemplateBar, getFileCards, clearFileCards, getImageCards, clearImageCards } from "./components/input-box";
import { openSendDialog, type PendingFile } from "./components/send-dialog";
import { showMomentsFeed, hideMomentsFeed, addMomentCard, wireMomentsFeed, refreshMoments } from "./components/moments-feed";

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
    el.className = "chat-item" + (item.active ? " active" : "") + (item.is_group ? " group-item" : "");
    if (item.is_group) {
      el.dataset.groupId = item.group_id;
    } else {
      el.dataset.agentHash = item.agent_hash;
    }
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", String(!!item.active));
    el.innerHTML = `
      <div class="chat-item-avatar">${item.is_group ? "👥" : item.avatar_letter}</div>
      <div class="chat-item-info">
        <div class="chat-item-name">${escapeHtml(item.name)}</div>
        <div class="chat-item-preview">${escapeHtml(item.last_message)}</div>
      </div>
      <div class="chat-item-meta">
        ${item.last_time ? `<span class="chat-item-time">${item.last_time}</span>` : ""}
        ${item.unread ? '<span class="chat-item-badge"></span>' : ""}
      </div>
    `;
    el.addEventListener("click", () => {
      if (item.is_group && item.group_id) {
        void selectGroup(item.group_id);
      } else {
        void selectChat(item.agent_hash);
      }
    });
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

  // Image message (legacy single-image type)
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

  // Render attachments (WS message attachments)
  if (msg.attachments && msg.attachments.length > 0) {
    const attContainer = document.createElement("div");
    attContainer.className = "msg-attachments";
    for (const att of msg.attachments) {
      void renderAttachment(attContainer, att, msg.agent_hash);
    }
    // Insert after body, before meta
    const bodyEl = wrap.querySelector(".bubble-body");
    if (bodyEl) {
      wrap.insertBefore(attContainer, bodyEl.nextSibling);
    } else {
      wrap.appendChild(attContainer);
    }
  }

  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  const ts = msg.timestamp || formatTime(msg.created_at);
  const agentLabel = msg.agent ? ` · ${msg.agent}` : "";
  meta.textContent = ts ? `${ts}${agentLabel}` : agentLabel;
  wrap.appendChild(meta);

  parent.appendChild(wrap);
}

// ---- Attachment rendering ---------------------------------------------------

async function renderAttachment(
  container: HTMLElement,
  att: Attachment,
  agentHash?: string
): Promise<void> {
  if (att.type === "image") {
    const imgDiv = document.createElement("div");
    imgDiv.className = "attachment-image";

    const img = document.createElement("img");
    img.className = "attachment-thumb";
    img.alt = "图片附件";
    img.loading = "lazy";

    // Load image based on source
    if (att.source === "data" && att.data) {
      img.src = att.data;
    } else if (att.source === "url" && att.url) {
      img.src = att.url;
    } else if (att.source === "vfs" && att.path && agentHash) {
      img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'%3E%3Crect fill='%23334155' width='80' height='80' rx='8'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='central' text-anchor='middle' fill='%2394a3b8' font-size='12'%3E加载中…%3C/text%3E%3C/svg%3E";
      try {
        const preview = await invoke<{ url: string }>("get_vfs_preview_url", {
          agent_hash: agentHash,
          path: att.path,
        });
        const resp = await fetch(preview.url);
        if (resp.ok) {
          const blob = await resp.blob();
          img.src = await blobToDataURL(blob);
        }
      } catch (e) {
        console.error("Failed to load VFS image attachment:", e);
        img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'%3E%3Crect fill='%23334155' width='80' height='80' rx='8'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='central' text-anchor='middle' fill='%2394a3b8' font-size='12'%3E加载失败%3C/text%3E%3C/svg%3E";
      }
    } else {
      img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'%3E%3Crect fill='%23334155' width='80' height='80' rx='8'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='central' text-anchor='middle' fill='%2394a3b8' font-size='12'%3E图片%3C/text%3E%3C/svg%3E";
    }

    // Click → full view
    img.style.cursor = "pointer";
    img.addEventListener("click", () => openFullView(img.src));

    imgDiv.appendChild(img);
    container.appendChild(imgDiv);

  } else if (att.type === "file") {
    const fileDiv = document.createElement("div");
    fileDiv.className = "attachment-file";
    const icon = document.createElement("span");
    icon.className = "af-icon";
    icon.textContent = "📄";
    const name = document.createElement("span");
    name.className = "af-name";
    name.textContent = att.name;
    const size = document.createElement("span");
    size.className = "af-size";
    size.textContent = formatBytes(att.size);
    const dlBtn = document.createElement("button");
    dlBtn.className = "af-download";
    dlBtn.textContent = "下载";
    dlBtn.addEventListener("click", () => void downloadAttachment(att, agentHash));
    fileDiv.appendChild(icon);
    fileDiv.appendChild(name);
    fileDiv.appendChild(size);
    fileDiv.appendChild(dlBtn);
    container.appendChild(fileDiv);

  } else if (att.type === "miniapp_card") {
    const card = document.createElement("div");
    card.className = "attachment-miniapp";
    if (att.preview_url) {
      const preview = document.createElement("img");
      preview.className = "am-preview";
      preview.src = att.preview_url;
      preview.alt = att.title;
      card.appendChild(preview);
    }
    const info = document.createElement("div");
    info.className = "am-info";
    const title = document.createElement("span");
    title.className = "am-title";
    title.textContent = att.title;
    const appName = document.createElement("span");
    appName.className = "am-app";
    appName.textContent = att.app_name;
    info.appendChild(title);
    info.appendChild(appName);
    card.appendChild(info);
    const openBtn = document.createElement("button");
    openBtn.className = "am-open";
    openBtn.textContent = "打开";
    openBtn.addEventListener("click", () => void openMiniapp(att.path));
    card.appendChild(openBtn);
    container.appendChild(card);
  }
}

function openFullView(src: string): void {
  const overlay = document.createElement("div");
  overlay.className = "viewer-fullscreen";
  overlay.innerHTML = `<img src="${src}" />`;
  overlay.addEventListener("click", () => overlay.remove());
  const closeBtn = document.createElement("button");
  closeBtn.className = "viewer-fullscreen-close";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => overlay.remove());
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);
}

async function downloadAttachment(
  att: Attachment,
  agentHash?: string
): Promise<void> {
  if (att.type !== "file") return;
  if (att.url) {
    // Direct URL: create anchor download
    const a = document.createElement("a");
    a.href = att.url;
    a.download = att.name;
    a.click();
  } else if (att.path && agentHash) {
    try {
      const localPath = await invoke<string>("download_vfs_file", {
        agent_hash: agentHash,
        path: att.path,
      });
      const a = document.createElement("a");
      a.href = `file://${localPath}`;
      a.download = att.name;
      a.click();
    } catch (e) {
      alert(`下载失败：${e}`);
    }
  }
}

async function openMiniapp(path?: string): Promise<void> {
  if (path) {
    // For now just alert; Phase 6 will implement deep linking
    console.log("open miniapp:", path);
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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

async function selectGroup(groupId: string): Promise<void> {
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

  // If coming from moments tab, switch to chat tab first
  if (store.currentTab === "moments") {
    hideMomentsFeed();
    store.setTab("chat");
    document.querySelectorAll<HTMLElement>(".tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === "chat");
    });
  }

  // Activate group chat
  store.setActiveGroup(groupId);
  renderChatList(store.chatItems);

  // Load draft
  const input = $<HTMLTextAreaElement>("input");
  if (input) input.value = "";
  try {
    const draft = await invoke<string | null>("load_draft", {
      channel: `group:${groupId}`,
    });
    if (draft && input) {
      input.value = draft;
      autoResize();
    }
  } catch (e) {
    console.error("load_draft failed:", e);
  }

  // Load group messages
  await loadGroupMessages(groupId);
  showActiveChat();
}

async function loadGroupMessages(groupId: string): Promise<void> {
  try {
    const msgs = await invoke<GroupMessage[]>("get_group_messages", {
      groupId,
    });
    // Convert to ChatMessage format for rendering
    const chatMsgs: ChatMessage[] = msgs.map((m) => ({
      id: m.id,
      channel: `group:${groupId}`,
      agent_hash: m.sender_hash,
      role: m.sender_type === "user" ? "user" : "assistant",
      content: m.content,
      message_type: m.message_type,
      created_at: m.created_at,
      synced: true,
      is_deleted: false,
      timestamp: formatTime(m.created_at),
      agent: m.sender_name,
      attachments: m.attachments as Attachment[],
    }));
    store.setMessages(chatMsgs);
    renderMessages(chatMsgs);
  } catch (e) {
    console.error("load_group_messages failed:", e);
    store.setMessages([]);
    renderMessages([]);
  }
}

async function sendMessage(): Promise<void> {
  const input = $<HTMLTextAreaElement>("input");
  const btn = $<HTMLButtonElement>("btn-send");
  if (!input || !btn) return;
  const text = input.value.trim();
  const imgCards = getImageCards();
  if (!text && getFileCards().length === 0 && imgCards.length === 0) return;

  btn.disabled = true;

  // Build message text including file card info and image markers
  const cards = getFileCards();
  let fullText = text;
  if (cards.length > 0) {
    const cardLines = cards.map((f) => {
      const mode = f.mode === "reference" ? "引用" : "发送副本";
      return `[文件: ${f.name} (${f.size_label}) - ${mode} - ${f.path}]`;
    }).join("\n");
    fullText = (fullText ? text + "\n" : "") + cardLines;
  }
  // Append image markers
  for (const img of imgCards) {
    fullText += (fullText ? "\n" : "") + `[image:${img.temp_path}]`;
  }

  input.value = "";
  autoResize();
  clearFileCards();

  // Determine if sending to group or agent
  const isGroup = store.activeGroupId !== null;
  const targetId = isGroup ? store.activeGroupId! : store.activeAgentHash;
  const channel = isGroup ? `group:${targetId}` : `im:${targetId}`;

  // Send image messages first (each as its own bubble)
  for (const img of imgCards) {
    const imgId = `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const imgTs = Math.floor(Date.now() / 1000);
    const imgMsg: ChatMessage = {
      id: imgId,
      channel,
      agent_hash: targetId,
      role: "user",
      content: img.data_url,
      message_type: "image",
      created_at: imgTs,
      synced: false,
      is_deleted: false,
      timestamp: formatTime(imgTs),
    };
    try {
      await invoke("insert_chat_message", {
        id: imgMsg.id,
        channel: imgMsg.channel,
        agentHash: targetId,
        role: imgMsg.role,
        content: imgMsg.content,
        messageType: "image",
        createdAt: imgTs * 1000,
      });
    } catch (e) {
      console.error("insert_chat_message (image) failed:", e);
    }
    store.appendMessage(imgMsg);
    const list = $<HTMLDivElement>("messages");
    if (list) renderMessageEl(list, imgMsg);
  }
  clearImageCards();
  scrollToBottom();

  // Optimistic local echo for text message (only if there's text)
  if (text) {
    const id = `msg-${Date.now()}`;
    const ts = Math.floor(Date.now() / 1000);
    const msg: ChatMessage = {
      id,
      channel,
      agent_hash: targetId,
      role: "user",
      content: text,
      message_type: "text",
      created_at: ts,
      synced: false,
      is_deleted: false,
      timestamp: formatTime(ts),
    };

    // Insert into DB (only for agent messages; group history handled differently)
    if (!isGroup) {
      try {
        await invoke("insert_chat_message", {
          id: msg.id,
          channel: msg.channel,
          agentHash: targetId,
          role: msg.role,
          content: msg.content,
          messageType: msg.message_type ?? "text",
          createdAt: ts * 1000,
        });
      } catch (e) {
        console.error("insert_chat_message failed:", e);
      }
    }

    store.appendMessage(msg);
    const list = $<HTMLDivElement>("messages");
    if (list) renderMessageEl(list, msg);
    scrollToBottom();
  }

  // Send via WS
  try {
    if (isGroup) {
      await invoke<string>("send_group_message", {
        group_id: targetId,
        content: fullText,
        mentions: null,
        attachments: null,
      });
    } else {
      await invoke<string>("send_chat_message", { text: fullText });
    }
  } catch (e) {
    const errMsg = typeof e === "string" ? e : "发送失败";
    store.appendMessage({
      id: `err-${Date.now()}`,
      channel,
      agent_hash: targetId,
      role: "assistant",
      content: `⚠ ${errMsg}`,
      message_type: "text",
      created_at: Math.floor(Date.now() / 1000),
    });
    const list2 = $<HTMLDivElement>("messages");
    if (list2) {
      renderMessageEl(list2, {
        id: `err-${Date.now()}`,
        channel,
        agent_hash: targetId,
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

// ---- Tab switching ----------------------------------------------

function switchTab(tabId: "chat" | "moments" | "profile" | "settings"): void {
  store.setTab(tabId);
  document.querySelectorAll<HTMLElement>(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  if (tabId === "settings") {
    void invoke("open_settings_window").catch((e) => console.error("open_settings:", e));
  } else if (tabId === "moments") {
    hideActiveChat();
    showMomentsFeed();
  } else if (tabId === "chat") {
    hideMomentsFeed();
    if (store.activeAgentHash || store.activeGroupId) {
      showActiveChat();
    }
  }
}

// ---- Show active chat panel -------------------------------------

function showActiveChat(): void {
  const noChat = $<HTMLDivElement>("no-chat-state");
  const activeChat = $<HTMLDivElement>("active-chat");
  if (!noChat || !activeChat) return;
  noChat.style.display = "none";
  activeChat.style.display = "flex";
}

function hideActiveChat(): void {
  const noChat = $<HTMLDivElement>("no-chat-state");
  const activeChat = $<HTMLDivElement>("active-chat");
  if (!noChat || !activeChat) return;
  noChat.style.display = "";
  activeChat.style.display = "none";
}

  // Update header
  if (store.activeGroupId) {
    const group = store.getGroupById(store.activeGroupId);
    const nameEl = $<HTMLDivElement>("chat-name");
    const avatarEl = $<HTMLDivElement>("chat-avatar");
    const statusEl = $<HTMLDivElement>("chat-status");
    if (nameEl) nameEl.textContent = group?.name ?? "群聊";
    if (avatarEl) avatarEl.textContent = "👥";
    if (statusEl) statusEl.textContent = `成员：${group?.memberCount ?? 0}`;
  } else {
    const agent = store.agents.find((a) => a.hash === store.activeAgentHash);
    const nameEl = $<HTMLDivElement>("chat-name");
    const avatarEl = $<HTMLDivElement>("chat-avatar");
    const statusEl = $<HTMLDivElement>("chat-status");
    if (nameEl) nameEl.textContent = agent?.name ?? "Agent";
    if (avatarEl) avatarEl.textContent = (agent?.name ?? "A").charAt(0).toUpperCase();
    if (statusEl) statusEl.textContent = "在线";
  }
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

  // Load groups
  try {
    const groups = await invoke<GroupInfo[]>("list_groups");
    // Transform API fields to client fields (snake_case → camelCase handled by invoke)
    const clientGroups: GroupInfo[] = groups.map((g) => ({
      id: g.id,
      name: g.name,
      announcement: g.announcement,
      memberCount: g.memberCount,
      createdAt: g.createdAt,
      unreadCount: 0,
      lastMessage: g.lastMessage,
    }));
    store.setGroups(clientGroups);
    renderChatList(store.chatItems);
  } catch (e) {
    console.error("list_groups failed:", e);
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

  // right-click-pending — emitted by lib.rs setup when the app was launched
  // via a Windows shell right-click with "--right-click <mode> <path>"
  try {
    await listen<PendingFile>("right-click-pending", (e) => {
      const pending = e.payload;
      if (!pending) return;
      console.log("right-click-pending:", pending);
      void openSendDialog(pending);
    });
  } catch (e) {
    console.error("listen right-click-pending:", e);
  }

  // group-message from WS (engine → desktop)
  try {
    await listen<{ group_id: string; message: GroupMessage }>("group-message", (e) => {
      const { group_id, message } = e.payload;
      if (!group_id || !message) return;
      // Only show if this group is active
      if (store.activeGroupId !== group_id) return;
      const chatMsg: ChatMessage = {
        id: message.id,
        channel: `group:${group_id}`,
        agent_hash: message.sender_hash,
        role: message.sender_type === "user" ? "user" : "assistant",
        content: message.content,
        message_type: message.message_type,
        created_at: message.created_at,
        synced: true,
        is_deleted: false,
        timestamp: formatTime(message.created_at),
        agent: message.sender_name,
        attachments: message.attachments as Attachment[],
      };
      store.appendMessage(chatMsg);
      const list = $<HTMLDivElement>("messages");
      if (list) renderMessageEl(list, chatMsg);
      scrollToBottom();
    });
  } catch (e) {
    console.error("listen group-message:", e);
  }

  // group-event from WS (member joined/left/renamed)
  try {
    await listen<{ group_id: string; event: string; data?: Record<string, unknown> }>("group-event", (e) => {
      const { group_id, event, data } = e.payload;
      if (!group_id || !event) return;
      const group = store.getGroupById(group_id);
      const name = (data?.name as string) ?? group?.name ?? "未知群";
      let text = "";
      if (event === "member_joined") {
        text = `${data?.member_name ?? "某人"} 加入了群聊`;
      } else if (event === "member_left") {
        text = `${data?.member_name ?? "某人"} 退出了群聊`;
      } else if (event === "group_renamed") {
        text = `群名称已更改为：${name}`;
      }
      if (!text) return;
      // Show system event pill in messages
      const list = $<HTMLDivElement>("messages");
      if (list) {
        const pill = document.createElement("div");
        pill.className = "event-pill system";
        pill.textContent = text;
        list.appendChild(pill);
        scrollToBottom();
      }
      // Reload group info
      if (store.activeGroupId === group_id) {
        void loadGroupMessages(group_id);
      }
    });
  } catch (e) {
    console.error("listen group-event:", e);
  }

  // group-updated from WS
  try {
    await listen<{ group_id: string; data?: { name?: string; announcement?: string; member_count?: number } }>("group-updated", (e) => {
      const { group_id, data } = e.payload;
      if (!group_id) return;
      // Update group info in store
      const idx = store.groups.findIndex((g) => g.id === group_id);
      if (idx >= 0 && data) {
        const updated = { ...store.groups[idx] };
        if (data.name) updated.name = data.name;
        if (data.announcement) updated.announcement = data.announcement;
        if (data.member_count !== undefined) updated.memberCount = data.member_count;
        store.groups[idx] = updated;
        // Re-render chat list
        renderChatList(store.chatItems);
        // Update header if this is active
        if (store.activeGroupId === group_id) {
          showActiveChat();
        }
      }
    });
  } catch (e) {
    console.error("listen group-updated:", e);
  }

  // moments-event from WS (new moment pushed by engine)
  try {
    await listen<{ group_id: string; data?: { id: string; group_id: string; group_name?: string; agent_hash?: string; agent_name?: string; kind: string; title: string; content: string; attachments: unknown[]; created_at: number } }>("moments-event", (e) => {
      const { group_id: _group_id, data } = e.payload;
      if (!data) return;
      // Convert to MomentInfo
      const moment: MomentInfo = {
        id: data.id,
        group_id: data.group_id,
        group_name: data.group_name,
        agent_hash: data.agent_hash,
        agent_name: data.agent_name,
        kind: data.kind,
        title: data.title,
        content: data.content,
        attachments: (data.attachments as Attachment[]) ?? [],
        created_at: data.created_at,
      };
      // Add to store
      store.addMoment(moment);
      // If on moments tab, render immediately (store subscription handles it)
      // Otherwise show toast
      if (store.currentTab !== "moments") {
        addMomentCard(moment);
      }
    });
  } catch (e) {
    console.error("listen moments-event:", e);
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
  // Set up the extended input box (file cards, attachment button, image paste)
  setupInputBox();
  // Load and render template bar after init
  void setupTemplateBar();

  // Listen for agent-created events from create-dialog
  window.addEventListener("agent-created", ((e: CustomEvent<{ agentHash: string }>) => {
    void selectChat(e.detail.agentHash);
  }) as EventListener);

  // Listen for group-selected events from create-dialog
  window.addEventListener("group-selected", ((e: CustomEvent<{ groupId: string }>) => {
    void selectGroup(e.detail.groupId);
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

  // ⋮ button → open side panel for the active agent, or group moments
  const chatMenu = $<HTMLButtonElement>("btn-chat-menu");
  if (chatMenu) {
    chatMenu.addEventListener("click", () => {
      if (store.activeGroupId) {
        // Group chat: navigate to group moments
        store.setTab("moments");
        document.querySelectorAll<HTMLElement>(".tab-btn").forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.tab === "moments");
        });
        hideActiveChat();
        showMomentsFeed(store.activeGroupId);
      } else if (store.activeAgentHash) {
        void openSidePanel(store.activeAgentHash);
      }
    });
  }

  // Wire moments feed
  wireMomentsFeed();
}

document.addEventListener("DOMContentLoaded", () => {
  wire();
  void initChat();
  void subscribeEvents();
});