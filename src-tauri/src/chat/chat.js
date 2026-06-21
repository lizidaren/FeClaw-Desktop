// src-tauri/src/chat/store.ts
var Store = class {
  // Current tab
  currentTab = "chat";
  // Agent list (populated from engine API)
  agents = [];
  // Permissions (populated from engine API)
  permissions = null;
  // Chat items for the middle panel (derived from agents)
  chatItems = [];
  // Currently active chat agent hash
  activeAgentHash = null;
  // Messages for the active chat
  messages = [];
  // Draft text for the active chat
  draft = "";
  // Callbacks for reactive updates
  listeners = /* @__PURE__ */ new Set();
  setTab(tab) {
    this.currentTab = tab;
    this.notify();
  }
  setAgents(agents) {
    this.agents = agents;
    this.chatItems = agents.map((a) => ({
      agent_hash: a.hash,
      name: a.name,
      avatar_letter: a.name.charAt(0).toUpperCase(),
      last_message: "",
      last_time: "",
      unread: false,
      active: a.hash === this.activeAgentHash
    }));
    this.notify();
  }
  setPermissions(perms) {
    this.permissions = perms;
    this.notify();
  }
  setActiveChat(agentHash) {
    if (this.activeAgentHash === agentHash) return;
    this.activeAgentHash = agentHash;
    this.messages = [];
    this.chatItems = this.chatItems.map((item) => ({
      ...item,
      active: item.agent_hash === agentHash
    }));
    this.notify();
  }
  setMessages(msgs) {
    this.messages = msgs;
    this.notify();
  }
  appendMessage(msg) {
    this.messages.push(msg);
    this.notify();
  }
  setDraft(text) {
    this.draft = text;
    this.notify();
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  notify() {
    for (const listener of this.listeners) {
      listener(this);
    }
  }
};
var store = new Store();

// src-tauri/src/chat/chat.ts
function getTauri() {
  const g = window.__TAURI__;
  if (!g?.core) throw new Error("Tauri global not available");
  return g.core;
}
var invoke = (cmd, args) => getTauri().invoke(cmd, args);
var listen = (event, handler) => getTauri().listen(event, handler);
function $(id) {
  return document.getElementById(id);
}
function renderChatList(items) {
  const list = $("chat-list");
  const hint = $("empty-list-hint");
  if (!list) return;
  if (items.length === 0) {
    list.innerHTML = "";
    if (hint) {
      hint.style.display = "";
      // Ensure the create button exists inside the hint
      if (!hint.querySelector(".btn-create-agent")) {
        const btn = document.createElement("button");
        btn.className = "btn btn-secondary btn-create-agent";
        btn.type = "button";
        btn.textContent = "创建新 Agent";
        btn.addEventListener("click", () => void openCreateDialog());
        hint.appendChild(btn);
      }
      list.appendChild(hint);
    }
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
function renderMessages(messages) {
  const list = $("messages");
  if (!list) return;
  list.innerHTML = "";
  if (messages.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">F</div>
        <h2>\u5F00\u59CB\u4E00\u6B21\u5BF9\u8BDD</h2>
        <p>\u5411 AI \u52A9\u7406\u53D1\u9001\u6D88\u606F\uFF0C\u5B83\u4F1A\u5728\u8FD9\u91CC\u56DE\u590D\u4F60\u3002</p>
      </div>`;
    return;
  }
  for (const msg of messages) {
    if (msg.is_deleted) continue;
    renderMessageEl(list, msg);
  }
  scrollToBottom();
}
function renderMessageEl(parent, msg) {
  const wrap = document.createElement("div");
  wrap.className = `bubble ${msg.role === "user" ? "user" : "assistant"}`;
  wrap.dataset.id = msg.id;
  if (msg.message_type === "image" || msg.content.startsWith("data:image/")) {
    const imgWrap = document.createElement("div");
    imgWrap.className = "bubble-image";
    const img = document.createElement("img");
    img.src = msg.content;
    img.alt = "\u56FE\u7247";
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
  const agentLabel = msg.agent ? ` \xB7 ${msg.agent}` : "";
  meta.textContent = ts ? `${ts}${agentLabel}` : agentLabel;
  wrap.appendChild(meta);
  parent.appendChild(wrap);
}
function appendStreamingMessage(id, chunk) {
  const list = $("messages");
  if (!list) return;
  let el = list.querySelector(`[data-id="${id}"]`);
  if (!el) {
    el = document.createElement("div");
    el.className = "bubble assistant streaming";
    el.dataset.id = id;
    const body2 = document.createElement("div");
    body2.className = "bubble-body";
    el.appendChild(body2);
    list.appendChild(el);
  }
  const body = el.querySelector(".bubble-body");
  if (body) body.textContent = (body.textContent ?? "") + chunk;
  scrollToBottom();
}
function finalizeStreaming(id, finalText) {
  const list = $("messages");
  if (!list) return;
  const el = list.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  el.classList.remove("streaming");
  if (typeof finalText === "string") {
    const body = el.querySelector(".bubble-body");
    if (body) body.textContent = finalText;
  }
}
async function selectChat(agentHash) {
  if (store.activeAgentHash) {
    const input2 = $("input");
    if (input2 && input2.value.trim()) {
      try {
        await invoke("save_draft", {
          channel: `im:${store.activeAgentHash}`,
          content: input2.value
        });
      } catch (e) {
        console.error("save_draft failed:", e);
      }
    }
  }
  store.setActiveChat(agentHash);
  renderChatList(store.chatItems);
  const input = $("input");
  if (input) input.value = "";
  try {
    const draft = await invoke("load_draft", {
      channel: `im:${agentHash}`
    });
    if (draft && input) {
      input.value = draft;
      autoResize();
    }
  } catch (e) {
    console.error("load_draft failed:", e);
  }
  await loadChatHistory(agentHash);
  showActiveChat();
}
async function loadChatHistory(agentHash) {
  try {
    const msgs = await invoke("get_chat_history_by_agent", {
      agentHash
    });
    store.setMessages(msgs);
    renderMessages(msgs);
  } catch (e) {
    console.error("load_chat_history failed:", e);
    store.setMessages([]);
    renderMessages([]);
  }
}
async function sendMessage() {
  const input = $("input");
  const btn = $("btn-send");
  if (!input || !btn) return;
  const text = input.value.trim();
  if (!text || !store.activeAgentHash) return;
  btn.disabled = true;
  input.value = "";
  autoResize();
  const id = `msg-${Date.now()}`;
  const ts = Math.floor(Date.now() / 1e3);
  const msg = {
    id,
    channel: `im:${store.activeAgentHash}`,
    agent_hash: store.activeAgentHash,
    role: "user",
    content: text,
    message_type: "text",
    created_at: ts,
    synced: false,
    is_deleted: false,
    timestamp: formatTime(ts)
  };
  try {
    await invoke("insert_chat_message", {
      id: msg.id,
      channel: msg.channel,
      agentHash: store.activeAgentHash,
      role: msg.role,
      content: msg.content,
      messageType: msg.message_type ?? "text",
      createdAt: ts * 1e3
      // ms
    });
  } catch (e) {
    console.error("insert_chat_message failed:", e);
  }
  store.appendMessage(msg);
  const list = $("messages");
  if (list) renderMessageEl(list, msg);
  scrollToBottom();
  try {
    await invoke("send_chat_message", { text });
  } catch (e) {
    const errMsg = typeof e === "string" ? e : "\u53D1\u9001\u5931\u8D25";
    store.appendMessage({
      id: `err-${Date.now()}`,
      channel: msg.channel,
      agent_hash: store.activeAgentHash,
      role: "assistant",
      content: `\u26A0 ${errMsg}`,
      message_type: "text",
      created_at: Math.floor(Date.now() / 1e3)
    });
    const list2 = $("messages");
    if (list2) {
      renderMessageEl(list2, {
        id: `err-${Date.now()}`,
        channel: msg.channel,
        agent_hash: store.activeAgentHash,
        role: "assistant",
        content: `\u26A0 ${errMsg}`,
        message_type: "text",
        created_at: Math.floor(Date.now() / 1e3)
      });
    }
  } finally {
    btn.disabled = false;
    input.focus();
  }
}
function openCreateDialog() {
  const overlay = $("createAgentOverlay");
  const nameInput = $("agentNameInput");
  const errorEl = $("createAgentError");
  if (!overlay || !nameInput || !errorEl) return;
  nameInput.value = "";
  errorEl.style.display = "none";
  errorEl.textContent = "";
  overlay.style.display = "flex";
  nameInput.focus();
}

function closeCreateDialog() {
  const overlay = $("createAgentOverlay");
  if (overlay) overlay.style.display = "none";
}

async function submitCreateAgent() {
  const nameInput = $("agentNameInput");
  const typeSelect = $("agentTypeSelect");
  const errorEl = $("createAgentError");
  if (!nameInput || !typeSelect || !errorEl) return;
  const name = nameInput.value.trim();
  if (!name) {
    errorEl.textContent = "请输入 Agent 名称";
    errorEl.style.display = "";
    return;
  }
  const agentType = typeSelect.value;
  closeCreateDialog();
  try {
    const agent = await invoke("create_agent", { name, agentType });
    const agents = await invoke("list_agents");
    store.setAgents(agents);
    renderChatList(store.chatItems);
    if (agent?.hash) {
      await invoke("open_agent_config", { agentHash: agent.hash });
      await selectChat(agent.hash);
    }
  } catch (e) {
    console.error("create_agent failed:", e);
    const errEl = $("createAgentError");
    if (errEl) {
      errEl.textContent = typeof e === "string" ? e : "创建失败";
      errEl.style.display = "";
    }
  }
}

async function handlePaste(e) {
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
async function saveAndInsertImage(file) {
  if (!store.activeAgentHash) return;
  // Reject images larger than 1MB
  if (file.size > 1 * 1024 * 1024) {
    alert("图片太大，请压缩到 1MB 以内再粘贴");
    return;
  }
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const base64 = ev.target?.result;
    if (!base64) return;
    const input = $("input");
    if (!input) return;
    const marker = `[image:${file.name}]`;
    input.value = (input.value || "") + marker;
    autoResize();
  };
  reader.readAsDataURL(file);
}
function switchTab(tabId) {
  store.setTab(tabId);
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  if (tabId === "settings") {
    void invoke("open_settings_window").catch((e) => console.error("open_settings:", e));
  }
}
function showActiveChat() {
  const noChat = $("no-chat-state");
  const activeChat = $("active-chat");
  if (!noChat || !activeChat) return;
  noChat.style.display = "none";
  activeChat.style.display = "flex";
  const agent = store.agents.find((a) => a.hash === store.activeAgentHash);
  const nameEl = $("chat-name");
  const avatarEl = $("chat-avatar");
  if (nameEl) nameEl.textContent = agent?.name ?? "Agent";
  if (avatarEl) avatarEl.textContent = (agent?.name ?? "A").charAt(0).toUpperCase();
}
async function initChat() {
  try {
    await invoke("init_db");
  } catch (e) {
    console.error("init_db failed:", e);
  }
  try {
    const hasLegacy = await invoke("check_legacy_chat_history");
    if (hasLegacy) {
      const count = await invoke("import_chat_history");
      console.log(`Imported ${count} legacy messages`);
    }
  } catch (e) {
    console.error("import_chat_history failed:", e);
  }
  try {
    const perms = await invoke("get_permissions");
    store.setPermissions(perms);
  } catch (e) {
    console.error("get_permissions failed:", e);
  }
  try {
    const agents = await invoke("list_agents");
    store.setAgents(agents);
    renderChatList(store.chatItems);
    if (agents.length > 0) {
      await selectChat(agents[0].hash);
    }
  } catch (e) {
    console.error("list_agents failed:", e);
  }
}
function autoResize() {
  const input = $("input");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}
function scrollToBottom() {
  const list = $("messages");
  if (!list) return;
  list.scrollTop = list.scrollHeight;
}
function formatTime(ts) {
  if (!ts) return "";
  const n = typeof ts === "string" ? Number(ts) : ts;
  if (!Number.isFinite(n) || n <= 0) return "";
  const ms = n < 4102444800 ? n * 1e3 : n;
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
async function subscribeEvents() {
  try {
    await listen("ws-status", (e) => {
      const dot = $("conn-dot");
      const text = $("conn-text");
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
  try {
    await listen("connection-status", (e) => {
      const dot = $("conn-dot");
      const text = $("conn-text");
      const status = e.payload;
      if (dot) dot.className = "conn-dot";
      if (text) text.className = "conn-text";
      if (status === "Connected") {
        if (dot) dot.classList.add("connected");
        if (text) text.textContent = "已连接";
      } else if (status === "Connecting" || status === "Reconnecting") {
        if (dot) dot.classList.add("connecting");
        if (text) text.textContent = "连接中…";
      } else {
        if (dot) dot.classList.add("disconnected");
        if (text) text.textContent = "未连接";
      }
    });
  } catch (e) {
    console.error("listen connection-status:", e);
  }
  try {
    await listen("chat-event", (e) => {
      const msg = e.payload;
      if (!msg || !msg.id) return;
      if (msg.agent_hash !== store.activeAgentHash) return;
      store.appendMessage(msg);
      const list = $("messages");
      if (list) renderMessageEl(list, msg);
      scrollToBottom();
    });
  } catch (e) {
    console.error("listen chat-event:", e);
  }
  try {
    await listen(
      "chat-stream",
      (e) => {
        const ev = e.payload;
        if (!ev) return;
        switch (ev.kind) {
          case "thinking":
            renderEventPill("thinking", "\u601D\u8003\u4E2D\u2026");
            break;
          case "tool":
            renderEventPill("tool", `\u8C03\u7528\u5DE5\u5177: ${describeToolCall(ev.data)}`);
            break;
          case "tool_result":
            renderEventPill("tool", "\u5DE5\u5177\u8FD4\u56DE\u5B8C\u6210");
            break;
          case "message_start": {
            const id = ev.data?.id ?? ev.id;
            appendStreamingMessage(id, "");
            break;
          }
          case "message_chunk": {
            const id = ev.data?.id ?? ev.id;
            const text = ev.data?.text ?? "";
            appendStreamingMessage(id, text);
            break;
          }
          case "message_end": {
            const id = ev.data?.id ?? ev.id;
            const final = ev.data?.text;
            finalizeStreaming(id, final);
            break;
          }
          case "done":
            renderEventPill("done", "\u2713 \u5B8C\u6210");
            break;
        }
      }
    );
  } catch (e) {
    console.error("listen chat-stream:", e);
  }
  try {
    await listen(
      "file-operation-request",
      (e) => {
        const req = e.payload;
        if (!req) return;
        console.log("file operation request:", req);
      }
    );
  } catch (e) {
    console.error("listen file-operation-request:", e);
  }
}
function renderEventPill(kind, label) {
  const list = $("messages");
  if (!list) return;
  const pill = document.createElement("div");
  pill.className = `event-pill ${kind}`;
  pill.textContent = label;
  list.appendChild(pill);
  scrollToBottom();
}
function describeToolCall(data) {
  if (!data || typeof data !== "object") return "";
  const obj = data;
  if (!obj.name) return "";
  try {
    const args = obj.args ? JSON.stringify(obj.args) : "";
    return args ? `${obj.name}(${args})` : obj.name;
  } catch {
    return obj.name;
  }
}
function wire() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    const tab = btn.dataset.tab;
    if (tab) {
      btn.addEventListener("click", () => switchTab(tab));
    }
  });
  const input = $("input");
  const send = $("btn-send");
  if (input) {
    input.addEventListener("input", autoResize);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        void sendMessage();
      }
    });
    input.addEventListener("input", () => {
      store.setDraft(input.value);
    });
    input.addEventListener("paste", handlePaste);
  }
  if (send) {
    send.addEventListener("click", () => void sendMessage());
  }
  const newChat = $("btn-new-chat");
  if (newChat) {
    newChat.addEventListener("click", () => void openCreateDialog());
  }
}
document.addEventListener("DOMContentLoaded", () => {
  wire();
  void initChat();
  void subscribeEvents();
});
