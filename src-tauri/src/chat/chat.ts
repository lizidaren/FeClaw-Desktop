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
import { renderMarkdown, decorateMarkdownRoot } from "./components/markdown";
import { setupInputBox, setupTemplateBar, getFileCards, clearFileCards, getImageCards, clearImageCards } from "./components/input-box";
import { openSendDialog, type PendingFile } from "./components/send-dialog";
import { showMomentsFeed, hideMomentsFeed, addMomentCard, wireMomentsFeed, refreshMoments } from "./components/moments-feed";
import { setupSearchOverlay } from "./components/search-overlay";
import { showFehubTab, hideFehubTab } from "./components/fehub-tab";

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
    el.className = "chat-item" + (item.active ? " active" : "") + (item.is_group ? " group-item" : "") + (item.is_pinned ? " pinned" : "") + (item.is_dnd ? " dnd" : "");
    if (item.is_group) {
      el.dataset.groupId = item.group_id;
    } else {
      el.dataset.agentHash = item.agent_hash;
    }
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", String(!!item.active));
    // Phase 5 / 7.2 A — render avatar (image or initial), optional online dot
    // overlay, and pin/DND icons in the meta column.
    const avatarContent = item.avatar_url
      ? `<img class="avatar-img" src="${item.avatar_url}" alt="">`
      : item.is_group ? "👥" : item.avatar_letter;
    const onlineDot = !item.is_group && item.is_online
      ? `<span class="chat-item-online-dot" aria-hidden="true"></span>`
      : "";
    const pinIcon = item.is_pinned
      ? '<span class="chat-item-pin-icon" title="置顶" aria-hidden="true">📌</span>'
      : "";
    const dndIcon = item.is_dnd
      ? '<span class="chat-item-dnd-icon" title="免打扰" aria-hidden="true">🔕</span>'
      : "";
    el.innerHTML = `
      <div class="chat-item-avatar">${avatarContent}${onlineDot}</div>
      <div class="chat-item-info">
        <div class="chat-item-name">${escapeHtml(item.name)}${item.status === "pending" ? ' <span class="agent-pending-badge">继续配置 →</span>' : ""}</div>
        <div class="chat-item-preview">${escapeHtml(item.last_message)}</div>
      </div>
      <div class="chat-item-meta">
        ${item.last_time ? `<span class="chat-item-time">${item.last_time}</span>` : ""}
        <span class="chat-item-icons">${pinIcon}${dndIcon}</span>
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

  // Phase 5 / 8.1 A — sort by created_at ASC defensively. The DB query
  // already orders, but the JSON fallback (legacy get_chat_history) and
  // optimistic local echoes can arrive out of order. Sorting here keeps
  // the day separator deterministic regardless of caller.
  const ordered = [...messages].sort((a, b) => {
    const ta = typeof a.created_at === "number" ? a.created_at : 0;
    const tb = typeof b.created_at === "number" ? b.created_at : 0;
    return ta - tb;
  });

  // Phase 5 / 8.1 A — drop a date separator bubble when the day changes.
  // Day boundary is local time so it lines up with the timestamp rendered
  // on each bubble.
  let lastDayKey: string | null = null;
  for (const msg of ordered) {
    if (msg.is_deleted) continue;
    const dayKey = dayKeyOf(msg.created_at);
    if (dayKey && dayKey !== lastDayKey) {
      const sep = document.createElement("div");
      sep.className = "day-separator";
      sep.textContent = formatDayLabel(msg.created_at);
      list.appendChild(sep);
      lastDayKey = dayKey;
    }
    renderMessageEl(list, msg);
  }
  scrollToBottom();
}

// YYYY-MM-DD key for the LOCAL timezone — used to compare consecutive
// messages and decide when to drop a separator. Returns null if the
// timestamp is missing / NaN so we never render a bogus separator.
function dayKeyOf(ts: number | undefined): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Render a friendly label for the date. Phase 5 / 8.1 A.
// Today / Yesterday / Day-before-yesterday are self-explanatory; anything
// within a week shows "N 天前"; older entries show the date itself.
function formatDayLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date();
  const startOfDay = (x: Date): Date => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diffDays = Math.round((startOfDay(today).getTime() - startOfDay(d).getTime()) / 86400000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays === 2) return "前天";
  if (diffDays > 2 && diffDays < 7) return `${diffDays} 天前`;
  if (d.getFullYear() === today.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function renderMessageEl(parent: HTMLElement, msg: ChatMessage): void {
  const wrap = document.createElement("div");
  wrap.className = `bubble ${msg.role === "user" ? "user" : "assistant"}`;
  wrap.dataset.id = msg.id;

  // Image message (legacy single-image type)
  // Block SVG explicitly: even when loaded via <img src>, defense-in-depth
  // matters because the same string can be reused elsewhere (fullscreen,
  // new window) where SVG scripts would execute.
  const safeImageSrc = pickSafeImageSrc(msg.content);
  if ((msg.message_type === "image" || msg.content.startsWith("data:image/")) && safeImageSrc) {
    const imgWrap = document.createElement("div");
    imgWrap.className = "bubble-image";
    const img = document.createElement("img");
    img.src = safeImageSrc;
    img.alt = "图片";
    imgWrap.appendChild(img);
    wrap.appendChild(imgWrap);
  } else if (msg.message_type === "image") {
    // Image was claimed but payload was unsafe (e.g. SVG). Fall back to
    // a text body so the user still sees something.
    const body = document.createElement("div");
    body.className = "bubble-body";
    body.textContent = "[图片类型不支持预览]";
    wrap.appendChild(body);
  } else if (msg.role === "assistant") {
    // Phase 2 / 2.2 B: render assistant messages as sanitised markdown
    // so code blocks, lists, tables, links and inline formatting all
    // survive. User messages stay as plain text — we never trust the
    // local input as markdown source.
    const body = document.createElement("div");
    body.className = "bubble-body bubble-markdown";
    try {
      body.innerHTML = renderMarkdown(msg.content);
      decorateMarkdownRoot(body);
    } catch (e) {
      // Vendor scripts missing — fall back to textContent so the
      // bubble still renders something legible.
      console.warn("markdown render failed, falling back to plain text:", e);
      body.textContent = msg.content;
    }
    wrap.appendChild(body);
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

  // Phase 2 / 2.1 B + 2.3 A: failed sends (synced:false + error) get a
  // retry affordance directly on the bubble. Click re-issues the WS
  // call without re-typing; no intermediate "sending…" state.
  if (msg.error) {
    wrap.classList.add("bubble-failed");
    const actions = document.createElement("div");
    actions.className = "bubble-actions";

    const errorLabel = document.createElement("span");
    errorLabel.className = "bubble-error";
    errorLabel.textContent = `发送失败：${msg.error}`;
    actions.appendChild(errorLabel);

    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "bubble-retry";
    retryBtn.textContent = "重试";
    retryBtn.addEventListener("click", () => {
      void retryMessage(msg.id);
    });
    actions.appendChild(retryBtn);

    wrap.appendChild(actions);
  }

  parent.appendChild(wrap);
}

/**
 * Re-issue a previously failed send.
 *
 * Phase 2 / 2.1 B: no transient "sending" indicator — we just clear the
 * `error` patch optimistically, fire the WS call, then mark the bubble
 * either back to clean (synced:true) or back to failed (synced:false)
 * depending on the result.
 */
async function retryMessage(msgId: string): Promise<void> {
  const list = $<HTMLDivElement>("messages");
  if (!list) return;
  const target = store.messages.find((m) => m.id === msgId);
  if (!target) return;
  const isGroup = target.channel.startsWith("group:");
  const targetId = target.agent_hash;
  if (!targetId) return;

  // Optimistically clear the error so the button disappears right away.
  store.updateMessage(msgId, { error: undefined, synced: false });
  renderMessages(store.messages);

  try {
    if (isGroup) {
      await invoke<string>("send_group_message", {
        group_id: targetId,
        content: target.content,
        mentions: null,
        attachments: null,
      });
    } else {
      await invoke<string>("send_chat_message", { text: target.content });
    }
    store.updateMessage(msgId, { synced: true });
  } catch (e) {
    const errMsg = typeof e === "string" ? e : "重试失败";
    store.updateMessage(msgId, { error: errMsg, synced: false });
  }
  renderMessages(store.messages);
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
      const safe = pickSafeImageSrc(att.data);
      if (safe) img.src = safe;
    } else if (att.source === "url" && att.url) {
      const safe = pickSafeImageSrc(att.url);
      if (safe) img.src = safe;
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
  // If we're on Moments/FE Hub tab, switch back to chat tab first
  if (store.currentTab !== "chat") {
    switchTab("chat");
  }

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
  // If we're on Moments/FE Hub tab, switch back to chat tab first
  if (store.currentTab !== "chat") {
    switchTab("chat");
  }

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

  // Track the optimistic messages so we can update them once the WS
  // send either succeeds (clear error) or fails (set error). Keeps the
  // retry button bound to the actual bubble the user typed into.
  const sentImageIds: string[] = [];
  let textMsgId = "";

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
    sentImageIds.push(imgId);
    const list = $<HTMLDivElement>("messages");
    if (list) renderMessageEl(list, imgMsg);
  }
  clearImageCards();
  scrollToBottom();

  // Optimistic local echo for text message (only if there's text)
  if (text) {
    const id = `msg-${Date.now()}`;
    textMsgId = id;
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
    // Success — clear any pending error state on the optimistic echo.
    if (text) {
      store.updateMessage(textMsgId, { synced: true, error: undefined });
    }
    // Also walk the just-sent image echoes and mark them as synced.
    for (const imgId of sentImageIds) {
      store.updateMessage(imgId, { synced: true, error: undefined });
    }
  } catch (e) {
    const errMsg = typeof e === "string" ? e : "发送失败";
    // Phase 2 / 2.3 A: mark the original optimistic message as failed
    // rather than appending a separate error bubble. The retry button is
    // rendered off this state in renderMessageEl.
    if (text) {
      store.updateMessage(textMsgId, { synced: false, error: errMsg });
    }
    for (const imgId of sentImageIds) {
      store.updateMessage(imgId, { synced: false, error: errMsg });
    }
    // Re-render the message list so the failure state (retry button)
    // reflects the patch made above.
    renderMessages(store.messages);
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

// ---- Tab switching ----------------------------------------------

function switchTab(tabId: "chat" | "moments" | "settings" | "fehub"): void {
  store.setTab(tabId);
  document.querySelectorAll<HTMLElement>(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  // Show/hide settings embedded panel (Phase 5 / 1.2 B — settings lives in
  // an iframe inside chat/index.html, NOT a separate WebviewWindow).
  const settingsTab = $<HTMLDivElement>("settingsTab");
  if (settingsTab) {
    settingsTab.style.display = tabId === "settings" ? "flex" : "none";
  }
  // Sidebar — hide completely in settings/moments/fehub modes
  const chatList = $<HTMLElement>("chat-list-panel");
  if (chatList) {
    chatList.style.display = tabId === "chat" ? "" : "none";
  }
  if (tabId === "settings") {
    // Settings is embedded as an iframe in chat/index.html (Phase 5 / 1.2 B).
    // The settingsTab div display is already toggled above; here we just
    // ensure chat panels are hidden so the iframe fills the workspace.
    const noChat = $<HTMLDivElement>("no-chat-state");
    const activeChat = $<HTMLDivElement>("active-chat");
    if (noChat) noChat.style.display = "none";
    if (activeChat) activeChat.style.display = "none";
  } else if (tabId === "moments") {
    // Plaza: render the moments feed (Phase 5 / 1.1 B — no longer a placeholder).
    // Defensive typeof checks mirror chat.js — these functions live in
    // separate lazy-loaded bundles that may not be loaded yet.
    if (typeof hideFehubTab === "function") hideFehubTab();
    if (typeof hidePlaceholder === "function") hidePlaceholder();
    if (typeof showMomentsFeed === "function") showMomentsFeed();
  } else if (tabId === "fehub") {
    // FeHub: render the FeHub panel (Phase 5 / 1.1 B — no longer a placeholder).
    if (typeof hideMomentsFeed === "function") hideMomentsFeed();
    if (typeof hidePlaceholder === "function") hidePlaceholder();
    if (typeof showFehubTab === "function") showFehubTab();
  } else if (tabId === "chat") {
    if (typeof hideMomentsFeed === "function") hideMomentsFeed();
    if (typeof hideFehubTab === "function") hideFehubTab();
    if (typeof hidePlaceholder === "function") hidePlaceholder();
    if (store.activeAgentHash || store.activeGroupId) {
      showActiveChat();
    } else {
      // No active chat — show default empty state
      const noChat = $<HTMLDivElement>("no-chat-state");
      const activeChat = $<HTMLDivElement>("active-chat");
      if (noChat) noChat.style.display = "";
      if (activeChat) activeChat.style.display = "none";
    }
  }
}

// ---- Placeholder page (FE Hub / Plaza) ---------------------------

function showPlaceholder(icon: string, title: string, subtitle: string): void {
  const page = $<HTMLDivElement>("placeholder-page");
  const iconEl = $<HTMLDivElement>("placeholder-icon");
  const titleEl = $<HTMLDivElement>("placeholder-title");
  const subtitleEl = $<HTMLDivElement>("placeholder-subtitle");
  if (!page || !iconEl || !titleEl || !subtitleEl) return;

  iconEl.textContent = icon;
  titleEl.textContent = title;
  subtitleEl.textContent = subtitle;

  // Hide the chat window content; placeholder takes over
  const noChat = $<HTMLDivElement>("no-chat-state");
  const activeChat = $<HTMLDivElement>("active-chat");
  if (noChat) noChat.style.display = "none";
  if (activeChat) activeChat.style.display = "none";
  page.style.display = "flex";
}

function hidePlaceholder(): void {
  const page = $<HTMLDivElement>("placeholder-page");
  if (page) page.style.display = "none";
  // Restore no-chat-state so the chat panel isn't empty when no chat is selected
  const noChat = $<HTMLDivElement>("no-chat-state");
  if (noChat) noChat.style.display = "";
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
      const count = await invoke<number>("import_chat_history");
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

// Whitelist of image MIME types that are safe to render as <img src>.
// SVG is excluded: even inside an <img> tag it can carry script-like
// features, and the same string may end up reused in a context that
// executes it (e.g. new window, fullscreen <object>).
const SAFE_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

/**
 * Inspect an image payload and return a src string that is safe to put
 * into `<img src=...>`, or `null` if the payload is not acceptable.
 *
 * Accepts:
 *   - data URLs whose MIME is in SAFE_IMAGE_MIMES
 *   - http(s) URLs (caller trusts the source)
 *
 * Rejects:
 *   - data URLs of any other type (notably image/svg+xml)
 *   - other schemes (javascript:, blob:, file:, ...)
 */
function pickSafeImageSrc(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith("data:")) {
    const match = /^data:([^;,]+)(?:;base64)?,/i.exec(trimmed);
    if (!match) return null;
    const mime = match[1].toLowerCase();
    if (!SAFE_IMAGE_MIMES.has(mime)) return null;
    return trimmed;
  }
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null;
}

// ---- Event subscriptions ----------------------------------------

async function subscribeEvents(): Promise<void> {
  // theme-changed — emitted by the embedded settings iframe (Phase 5 / 7.1 A).
  // Without this listener the parent chat window stays on the old theme
  // until the user reloads the page.
  try {
    await listen<{ theme: string }>("theme-changed", (e) => {
      const theme = e.payload?.theme;
      if (!theme) return;
      document.documentElement.setAttribute("data-theme", theme);
      document.body.setAttribute("data-theme", theme);
    });
  } catch (e) {
    console.error("listen theme-changed:", e);
  }

  // ws-status from the status pump in lib.rs
  try {
    await listen<{ status: string }>("ws-status", (e) => {
      const dot = $<HTMLSpanElement>("conn-dot");
      const text = $<HTMLSpanElement>("conn-text");
      if (!dot || !text) return;
      const s = e.payload.status;
      dot.className = "conn-dot";
      text.className = "conn-text";
      if (s === "Connected") {
        dot.classList.add("connected");
        text.textContent = "在线";
      } else if (s === "Connecting" || s === "Reconnecting") {
        dot.classList.add("connecting");
        text.textContent = "连接中…";
      } else {
        dot.classList.add("disconnected");
        text.textContent = "离线";
      }
    });
  } catch (e) {
    console.error("listen ws-status:", e);
  }

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

// ---- Plus button dropdown (WeChat-style) -----------------------
//
// Clicking the "+" button in the chat list panel shows a small
// dropdown menu with two options:
//   🤖 创建 AI 助理  → openCreateDialog() (default: classic agent)
//   👥 发起群聊      → openCreateDialog() (group mode pre-selected
//                     in the dialog if a pre-select API exists;
//                     otherwise just opens the dialog)
//
// The dropdown is positioned just below the trigger button (flipped
// above if there's no room below) and is appended to <body> to escape
// any overflow:hidden containers. Clicking outside or pressing ESC
// closes it.

const PLUS_DROPDOWN_ID = "plus-dropdown";
const PLUS_DROPDOWN_MARGIN = 8;
const PLUS_DROPDOWN_GAP = 6;

let activePlusDropdown: HTMLElement | null = null;
let activePlusTrigger: HTMLElement | null = null;

function showPlusDropdown(trigger: HTMLElement): void {
  // Toggle behavior: if already open for this trigger, close it.
  if (activePlusDropdown && activePlusTrigger === trigger) {
    hidePlusDropdown();
    return;
  }
  hidePlusDropdown();

  const dropdown = document.createElement("div");
  dropdown.id = PLUS_DROPDOWN_ID;
  dropdown.className = "plus-dropdown open";
  dropdown.setAttribute("role", "menu");
  dropdown.setAttribute("aria-label", "新建聊天");

  dropdown.innerHTML = `
    <button type="button" class="plus-dropdown-item" data-action="agent" role="menuitem">
      <span class="plus-dropdown-icon" aria-hidden="true">🤖</span>
      <span class="plus-dropdown-text">创建 AI 助理</span>
    </button>
    <button type="button" class="plus-dropdown-item" data-action="group" role="menuitem">
      <span class="plus-dropdown-icon" aria-hidden="true">👥</span>
      <span class="plus-dropdown-text">发起群聊</span>
    </button>
  `;

  document.body.appendChild(dropdown);

  // Measure after insertion to know dropdown size.
  const rect = trigger.getBoundingClientRect();
  const ddRect = dropdown.getBoundingClientRect();

  // Default: place below trigger, right edge aligned with trigger.
  let top = rect.bottom + PLUS_DROPDOWN_GAP;
  let left = rect.right - ddRect.width;

  // Flip above if not enough room below.
  if (top + ddRect.height > window.innerHeight - PLUS_DROPDOWN_MARGIN) {
    top = rect.top - ddRect.height - PLUS_DROPDOWN_GAP;
  }
  // If flipping above also doesn't fit (very small viewport), clamp
  // to the top edge so the dropdown remains visible.
  if (top < PLUS_DROPDOWN_MARGIN) {
    top = PLUS_DROPDOWN_MARGIN;
  }

  // Clamp horizontal position to viewport.
  if (left < PLUS_DROPDOWN_MARGIN) {
    left = PLUS_DROPDOWN_MARGIN;
  }
  if (left + ddRect.width > window.innerWidth - PLUS_DROPDOWN_MARGIN) {
    left = window.innerWidth - ddRect.width - PLUS_DROPDOWN_MARGIN;
  }

  dropdown.style.top = `${top}px`;
  dropdown.style.left = `${left}px`;

  // Wire item clicks.
  dropdown.querySelectorAll<HTMLElement>(".plus-dropdown-item").forEach((item) => {
    item.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const action = item.dataset.action;
      hidePlusDropdown();
      // Both options open the create dialog. The dialog already
      // supports radio-button type selection (classic / im / group).
      if (action === "agent" || action === "group") {
        openCreateDialog();
      }
    });
  });

  activePlusDropdown = dropdown;
  activePlusTrigger = trigger;

  // Defer attaching document-level listeners so the click that opened
  // the dropdown doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener("click", onPlusDocClick, true);
    document.addEventListener("keydown", onPlusDocKey, true);
    window.addEventListener("resize", hidePlusDropdown);
    window.addEventListener("scroll", hidePlusDropdown, true);
  }, 0);
}

function hidePlusDropdown(): void {
  if (activePlusDropdown && activePlusDropdown.parentNode) {
    activePlusDropdown.parentNode.removeChild(activePlusDropdown);
  }
  activePlusDropdown = null;
  activePlusTrigger = null;
  document.removeEventListener("click", onPlusDocClick, true);
  document.removeEventListener("keydown", onPlusDocKey, true);
  window.removeEventListener("resize", hidePlusDropdown);
  window.removeEventListener("scroll", hidePlusDropdown, true);
}

function onPlusDocClick(ev: MouseEvent): void {
  if (!activePlusDropdown) return;
  const target = ev.target as Node | null;
  // Close if click is outside both the dropdown and the trigger.
  if (
    target &&
    !activePlusDropdown.contains(target) &&
    activePlusTrigger !== target &&
    !(activePlusTrigger && activePlusTrigger.contains(target))
  ) {
    hidePlusDropdown();
  }
}

function onPlusDocKey(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    hidePlusDropdown();
  }
}

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

  // ---- Phase 7: Search overlay navigation ----
  // navigate-to-chat: { agentHash: string, messageId?: string }
  window.addEventListener("navigate-to-chat", ((e: CustomEvent<{ agentHash: string; messageId?: string }>) => {
    const { agentHash, messageId } = e.detail;
    if (store.currentTab !== "chat") {
      switchTab("chat");
    }
    void selectChat(agentHash).then(() => {
      if (messageId) {
        // Scroll to message
        const el = document.querySelector(`[data-id="${messageId}"]`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }) as EventListener);

  // navigate-to-vfs: { path: string, agentHash?: string }
  window.addEventListener("navigate-to-vfs", ((e: CustomEvent<{ path: string; agentHash?: string }>) => {
    const { path } = e.detail;
    // Open file manager at that path — Phase 2A file manager is in side-panel
    console.log("navigate-to-vfs:", path);
    // TODO: Phase 8 file manager integration
  }) as EventListener);

  // navigate-to-moment: { momentId: string, groupId?: string }
  window.addEventListener("navigate-to-moment", ((e: CustomEvent<{ momentId: string; groupId?: string }>) => {
    const { momentId, groupId } = e.detail;
    switchTab("moments");
    if (groupId) {
      store.setMomentsGroupFilter(groupId);
    }
    // Highlight the moment
    setTimeout(() => {
      const el = document.querySelector(`[data-moment-id="${momentId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("moment-highlight");
        setTimeout(() => el.classList.remove("moment-highlight"), 2000);
      }
    }, 100);
  }) as EventListener);

  // navigate-to-reference: generic reference navigation
  window.addEventListener("navigate-to-reference", ((e: CustomEvent<{ reference: string }>) => {
    console.log("navigate-to-reference:", e.detail.reference);
  }) as EventListener);

  // Tab bar
  document.querySelectorAll<HTMLElement>(".tab-btn").forEach((btn) => {
    const tab = btn.dataset.tab as "chat" | "settings" | "moments" | "fehub";
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

  // New chat button → show dropdown with create options
  const newChat = $<HTMLButtonElement>("btn-new-chat");
  if (newChat) {
    newChat.addEventListener("click", (ev) => {
      ev.stopPropagation();
      showPlusDropdown(newChat);
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
  void setupSearchOverlay();
});