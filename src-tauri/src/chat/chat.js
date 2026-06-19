function getTauri() {
  const g = window.__TAURI__;
  if (!g?.core) {
    throw new Error("Tauri global not available; did you enable withGlobalTauri?");
  }
  return g.core;
}
const invoke = (cmd, args) => getTauri().invoke(cmd, args);
function $(id) {
  return document.getElementById(id);
}
const streamingIds = /* @__PURE__ */ new Set();
const pendingConsents = /* @__PURE__ */ new Map();
const messageElements = /* @__PURE__ */ new Map();
function ensureNotEmpty() {
  const empty = $("empty-state");
  if (empty) empty.remove();
}
function formatTime(ts) {
  if (!ts) return "";
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n * 1e3);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
function scrollToBottom() {
  const list = $("messages");
  if (!list) return;
  list.scrollTop = list.scrollHeight;
}
function renderMessage(msg, opts) {
  ensureNotEmpty();
  const list = $("messages");
  if (!list) throw new Error("messages container missing");
  const wrap = document.createElement("div");
  wrap.className = `bubble ${msg.role === "user" ? "user" : "assistant"}`;
  if (opts?.streaming) wrap.classList.add("streaming");
  wrap.dataset.id = msg.id;
  const body = document.createElement("div");
  body.className = "bubble-body";
  body.textContent = msg.content;
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  const ts = formatTime(msg.timestamp);
  const agentLabel = msg.agent ? ` \xB7 ${msg.agent}` : "";
  meta.textContent = ts ? `${ts}${agentLabel}` : agentLabel;
  wrap.appendChild(body);
  if (ts || agentLabel) wrap.appendChild(meta);
  list.appendChild(wrap);
  messageElements.set(msg.id, wrap);
  scrollToBottom();
  return wrap;
}
function renderEventPill(kind, label) {
  ensureNotEmpty();
  const list = $("messages");
  if (!list) return;
  const pill = document.createElement("div");
  pill.className = `event-pill ${kind}`;
  pill.textContent = label;
  list.appendChild(pill);
  scrollToBottom();
}
function appendToStreaming(id, chunk) {
  const el = messageElements.get(id);
  if (!el) return;
  const body = el.querySelector(".bubble-body");
  if (!body) return;
  body.textContent = (body.textContent ?? "") + chunk;
  scrollToBottom();
}
function finalizeStreaming(id, finalText) {
  streamingIds.delete(id);
  const el = messageElements.get(id);
  if (!el) return;
  el.classList.remove("streaming");
  if (typeof finalText === "string") {
    const body = el.querySelector(".bubble-body");
    if (body) body.textContent = finalText;
  }
}
function renderConsent(req) {
  ensureNotEmpty();
  const list = $("messages");
  if (!list) return;
  const card = document.createElement("div");
  card.className = "consent";
  card.dataset.opId = req.op_id;
  const title = document.createElement("div");
  title.className = "consent-title";
  const opLabel = req.operation === "read" ? "READ" : req.operation === "write" ? "WRITE" : req.operation === "delete" ? "DELETE" : req.operation.toUpperCase();
  title.textContent = `Agent \u60F3\u8981 ${opLabel} \u4E00\u4E2A\u6587\u4EF6`;
  const pathEl = document.createElement("div");
  pathEl.className = "consent-path";
  pathEl.textContent = req.path;
  const reasonEl = document.createElement("div");
  reasonEl.className = "consent-reason";
  reasonEl.textContent = req.reason ?? "\u8BF7\u786E\u8BA4\u662F\u5426\u5141\u8BB8\u8BE5\u64CD\u4F5C";
  const actions = document.createElement("div");
  actions.className = "consent-actions";
  const allow = document.createElement("button");
  allow.className = "btn btn-primary";
  allow.textContent = "\u2713 \u5141\u8BB8";
  const deny = document.createElement("button");
  deny.className = "btn btn-danger";
  deny.textContent = "\u2717 \u62D2\u7EDD";
  actions.appendChild(allow);
  actions.appendChild(deny);
  card.appendChild(title);
  card.appendChild(pathEl);
  card.appendChild(reasonEl);
  card.appendChild(actions);
  list.appendChild(card);
  pendingConsents.set(req.op_id, card);
  scrollToBottom();
  const resolve = async (decision) => {
    allow.disabled = true;
    deny.disabled = true;
    try {
      await invoke("send_consent_response", {
        opId: req.op_id,
        operation: req.operation,
        path: req.path,
        decision
      });
      title.textContent = decision === "allow" ? "\u2713 \u5DF2\u5141\u8BB8" : "\u2717 \u5DF2\u62D2\u7EDD";
    } catch (e) {
      title.textContent = "\u54CD\u5E94\u5931\u8D25\uFF1A" + (typeof e === "string" ? e : "\u672A\u77E5\u9519\u8BEF");
    }
    pendingConsents.delete(req.op_id);
  };
  allow.addEventListener("click", () => void resolve("allow"));
  deny.addEventListener("click", () => void resolve("deny"));
}
async function loadHistory() {
  try {
    const result = await invoke(
      "get_chat_history"
    );
    if (!result.messages || result.messages.length === 0) return;
    ensureNotEmpty();
    for (const m of result.messages) {
      renderMessage(m);
    }
  } catch (e) {
    console.error("load chat history:", e);
  }
}
async function refreshConnectionStatus() {
  try {
    const status = await invoke("get_connection_status");
    applyStatus(status);
  } catch (e) {
    applyStatus("Disconnected");
  }
}
function applyStatus(status) {
  const pill = $("connection-indicator");
  const label = $("connection-label");
  if (!pill || !label) return;
  const lower = status.toLowerCase();
  let state = "disconnected";
  let text = "\u672A\u8FDE\u63A5";
  if (lower.includes("connected")) {
    state = "connected";
    text = "\u5DF2\u8FDE\u63A5";
  } else if (lower.includes("connecting")) {
    state = "connecting";
    text = "\u8FDE\u63A5\u4E2D\u2026";
  } else if (lower.includes("reconnecting")) {
    state = "reconnecting";
    text = "\u91CD\u8FDE\u4E2D\u2026";
  } else if (lower.includes("failed")) {
    state = "failed";
    text = "\u8FDE\u63A5\u5931\u8D25";
  }
  pill.dataset.state = state;
  label.textContent = text;
}
async function sendMessage() {
  const input = $("input");
  const btn = $("btn-send");
  if (!input || !btn) return;
  const text = input.value.trim();
  if (!text) return;
  btn.disabled = true;
  input.value = "";
  autoResize();
  try {
    await invoke("send_chat_message", { text });
  } catch (e) {
    const msg = typeof e === "string" ? e : "\u53D1\u9001\u5931\u8D25";
    renderMessage({
      id: `err-${Date.now()}`,
      role: "assistant",
      content: `\u26A0 ${msg}`,
      timestamp: String(Math.floor(Date.now() / 1e3))
    });
  } finally {
    btn.disabled = false;
    input.focus();
  }
}
async function subscribeEvents() {
  try {
    await getTauri().listen("chat-event", (e) => {
      const msg = e.payload;
      if (!msg || !msg.id) return;
      const existing = messageElements.get(msg.id);
      if (existing) {
        const body = existing.querySelector(".bubble-body");
        if (body) body.textContent = msg.content;
        finalizeStreaming(msg.id, msg.content);
      } else {
        renderMessage(msg);
      }
    });
  } catch (e) {
    console.error("listen chat-event:", e);
  }
  try {
    await getTauri().listen("chat-stream", (e) => {
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
          streamingIds.add(id);
          renderMessage(
            {
              id,
              role: "assistant",
              content: "",
              timestamp: ev.timestamp
            },
            { streaming: true }
          );
          break;
        }
        case "message_chunk": {
          const id = ev.data?.id ?? ev.id;
          const text = ev.data?.text ?? "";
          appendToStreaming(id, text);
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
        default:
          break;
      }
    });
  } catch (e) {
    console.error("listen chat-stream:", e);
  }
  try {
    await getTauri().listen("file-operation-request", (e) => {
      if (e.payload) renderConsent(e.payload);
    });
  } catch (e) {
    console.error("listen file-operation-request:", e);
  }
  try {
    await getTauri().listen("connection-status", (e) => {
      applyStatus(e.payload ?? "Disconnected");
    });
  } catch (e) {
    console.error("listen connection-status:", e);
  }
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
function autoResize() {
  const input = $("input");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}
function wireComposer() {
  const input = $("input");
  const send = $("btn-send");
  const clear = $("btn-clear");
  const settings = $("btn-settings");
  if (!input || !send) return;
  input.addEventListener("input", autoResize);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void sendMessage();
    }
  });
  send.addEventListener("click", () => void sendMessage());
  if (clear) {
    clear.addEventListener("click", async () => {
      if (!window.confirm("\u786E\u8BA4\u6E05\u7A7A\u6240\u6709\u5BF9\u8BDD\u5386\u53F2\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500\u3002")) return;
      try {
        await invoke("clear_chat_history");
        const list = $("messages");
        if (list) {
          list.innerHTML = "";
          const empty = document.createElement("div");
          empty.className = "empty-state";
          empty.id = "empty-state";
          empty.innerHTML = '<div class="empty-icon" aria-hidden="true">F</div><h2>\u5F00\u59CB\u4E00\u6B21\u5BF9\u8BDD</h2><p>\u5411 AI \u52A9\u7406\u53D1\u9001\u6D88\u606F\uFF0C\u5B83\u4F1A\u5728\u8FD9\u91CC\u56DE\u590D\u4F60\u3002</p>';
          list.appendChild(empty);
        }
        messageElements.clear();
        streamingIds.clear();
      } catch (e) {
        console.error("clear chat history:", e);
      }
    });
  }
  if (settings) {
    settings.addEventListener("click", () => {
      void invoke("open_settings_window").catch((e) => console.error("open settings:", e));
    });
  }
}
document.addEventListener("DOMContentLoaded", () => {
  wireComposer();
  void loadHistory();
  void subscribeEvents();
  void refreshConnectionStatus();
  window.setInterval(refreshConnectionStatus, 5e3);
});
