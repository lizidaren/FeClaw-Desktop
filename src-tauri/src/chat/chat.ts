// =========================================================
// FeClaw Desktop — Chat window
// =========================================================
// Renders the message stream, handles WS-driven events
// emitted by the Rust backend (chat-event), and lets the
// user send messages via send_chat_message.
//
// Compiled to chat.js with esbuild (see project docs).

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
  if (!g?.core) {
    throw new Error("Tauri global not available; did you enable withGlobalTauri?");
  }
  return g.core;
}

const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  getTauri().invoke<T>(cmd, args);

// ---- DOM helpers ------------------------------------------------
function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ---- Types matching Rust chat.rs --------------------------------

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | string;
  content: string;
  timestamp?: string;
  agent?: string | null;
};

// Streaming / non-message events from the server. Mirrors the
// server-side `chat_event` envelope (ws_types.rs::ChatEvent).
type ChatEvent = {
  id: string;
  kind: string;            // "thinking" | "tool" | "tool_result" | "done" | ...
  data?: unknown;
  timestamp?: string;
};

// File operation consent request — server asks the user to allow/deny
// a file operation (P1.2). Mirrors FileOperationRequest in ws_types.rs.
type FileOperationRequest = {
  op_id: string;
  operation: string;       // "read" | "write" | "delete"
  path: string;
  level?: number;
  reason?: string;
  timestamp?: string;
};

// ---- State ------------------------------------------------------

// Track which assistant messages are streaming (so we can replace
// the placeholder body once the server says "done").
const streamingIds = new Set<string>();
// op_id → DOM card so we can show the resolved state.
const pendingConsents = new Map<string, HTMLElement>();
// Message id → DOM element so streaming events can update the right bubble.
const messageElements = new Map<string, HTMLElement>();

// ---- Render helpers ---------------------------------------------

function ensureNotEmpty(): void {
  const empty = $("empty-state");
  if (empty) empty.remove();
}

function formatTime(ts?: string): string {
  if (!ts) return "";
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const d = new Date(n * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function scrollToBottom(): void {
  const list = $("messages");
  if (!list) return;
  list.scrollTop = list.scrollHeight;
}

function renderMessage(msg: ChatMessage, opts?: { streaming?: boolean }): HTMLElement {
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
  const agentLabel = msg.agent ? ` · ${msg.agent}` : "";
  meta.textContent = ts ? `${ts}${agentLabel}` : agentLabel;

  wrap.appendChild(body);
  if (ts || agentLabel) wrap.appendChild(meta);
  list.appendChild(wrap);
  messageElements.set(msg.id, wrap);
  scrollToBottom();
  return wrap;
}

function renderEventPill(kind: string, label: string): void {
  ensureNotEmpty();
  const list = $("messages");
  if (!list) return;
  const pill = document.createElement("div");
  pill.className = `event-pill ${kind}`;
  pill.textContent = label;
  list.appendChild(pill);
  scrollToBottom();
}

function appendToStreaming(id: string, chunk: string): void {
  const el = messageElements.get(id);
  if (!el) return;
  const body = el.querySelector(".bubble-body") as HTMLElement | null;
  if (!body) return;
  body.textContent = (body.textContent ?? "") + chunk;
  scrollToBottom();
}

function finalizeStreaming(id: string, finalText?: string): void {
  streamingIds.delete(id);
  const el = messageElements.get(id);
  if (!el) return;
  el.classList.remove("streaming");
  if (typeof finalText === "string") {
    const body = el.querySelector(".bubble-body") as HTMLElement | null;
    if (body) body.textContent = finalText;
  }
}

function renderConsent(req: FileOperationRequest): void {
  ensureNotEmpty();
  const list = $("messages");
  if (!list) return;

  const card = document.createElement("div");
  card.className = "consent";
  card.dataset.opId = req.op_id;

  const title = document.createElement("div");
  title.className = "consent-title";
  const opLabel =
    req.operation === "read"
      ? "READ"
      : req.operation === "write"
      ? "WRITE"
      : req.operation === "delete"
      ? "DELETE"
      : req.operation.toUpperCase();
  title.textContent = `Agent 想要 ${opLabel} 一个文件`;

  const pathEl = document.createElement("div");
  pathEl.className = "consent-path";
  pathEl.textContent = req.path;

  const reasonEl = document.createElement("div");
  reasonEl.className = "consent-reason";
  reasonEl.textContent = req.reason ?? "请确认是否允许该操作";

  const actions = document.createElement("div");
  actions.className = "consent-actions";
  const allow = document.createElement("button");
  allow.className = "btn btn-primary";
  allow.textContent = "✓ 允许";
  const deny = document.createElement("button");
  deny.className = "btn btn-danger";
  deny.textContent = "✗ 拒绝";
  actions.appendChild(allow);
  actions.appendChild(deny);

  card.appendChild(title);
  card.appendChild(pathEl);
  card.appendChild(reasonEl);
  card.appendChild(actions);
  list.appendChild(card);
  pendingConsents.set(req.op_id, card);
  scrollToBottom();

  const resolve = async (decision: "allow" | "deny"): Promise<void> => {
    allow.disabled = true;
    deny.disabled = true;
    try {
      await invoke("send_consent_response", {
        opId: req.op_id,
        operation: req.operation,
        path: req.path,
        decision,
      });
      title.textContent = decision === "allow" ? "✓ 已允许" : "✗ 已拒绝";
    } catch (e) {
      title.textContent = "响应失败：" + (typeof e === "string" ? e : "未知错误");
    }
    pendingConsents.delete(req.op_id);
  };
  allow.addEventListener("click", () => void resolve("allow"));
  deny.addEventListener("click", () => void resolve("deny"));
}

// ---- History load ------------------------------------------------

async function loadHistory(): Promise<void> {
  try {
    const result = await invoke<{ messages: ChatMessage[]; path: string }>(
      "get_chat_history",
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

// ---- Connection status -------------------------------------------

async function refreshConnectionStatus(): Promise<void> {
  try {
    const status = await invoke<string>("get_connection_status");
    applyStatus(status);
  } catch (e) {
    applyStatus("Disconnected");
  }
}

function applyStatus(status: string): void {
  const pill = $("connection-indicator");
  const label = $("connection-label");
  if (!pill || !label) return;
  const lower = status.toLowerCase();
  let state = "disconnected";
  let text = "未连接";
  if (lower.includes("connected")) {
    state = "connected";
    text = "已连接";
  } else if (lower.includes("connecting")) {
    state = "connecting";
    text = "连接中…";
  } else if (lower.includes("reconnecting")) {
    state = "reconnecting";
    text = "重连中…";
  } else if (lower.includes("failed")) {
    state = "failed";
    text = "连接失败";
  }
  pill.dataset.state = state;
  label.textContent = text;
}

// ---- Send message ------------------------------------------------

async function sendMessage(): Promise<void> {
  const input = $<HTMLTextAreaElement>("input");
  const btn = $<HTMLButtonElement>("btn-send");
  if (!input || !btn) return;
  const text = input.value.trim();
  if (!text) return;

  btn.disabled = true;
  input.value = "";
  autoResize();
  try {
    await invoke<string>("send_chat_message", { text });
  } catch (e) {
    const msg = typeof e === "string" ? e : "发送失败";
    // Render an error bubble so the user sees something.
    renderMessage({
      id: `err-${Date.now()}`,
      role: "assistant",
      content: `⚠ ${msg}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

// ---- Event subscriptions -----------------------------------------

async function subscribeEvents(): Promise<void> {
  try {
    await getTauri().listen<ChatMessage>("chat-event", (e) => {
      const msg = e.payload;
      if (!msg || !msg.id) return;
      const existing = messageElements.get(msg.id);
      if (existing) {
        // Update body text in-place (e.g. server corrected the content).
        const body = existing.querySelector(".bubble-body") as HTMLElement | null;
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
    await getTauri().listen<ChatEvent>("chat-stream", (e) => {
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
          streamingIds.add(id);
          renderMessage(
            {
              id,
              role: "assistant",
              content: "",
              timestamp: ev.timestamp,
            },
            { streaming: true },
          );
          break;
        }
        case "message_chunk": {
          const id = (ev.data as { id?: string } | undefined)?.id ?? ev.id;
          const text = (ev.data as { text?: string } | undefined)?.text ?? "";
          appendToStreaming(id, text);
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
        default:
          // ignore unknown kinds
          break;
      }
    });
  } catch (e) {
    console.error("listen chat-stream:", e);
  }

  try {
    await getTauri().listen<FileOperationRequest>("file-operation-request", (e) => {
      if (e.payload) renderConsent(e.payload);
    });
  } catch (e) {
    console.error("listen file-operation-request:", e);
  }

  try {
    await getTauri().listen<string>("connection-status", (e) => {
      applyStatus(e.payload ?? "Disconnected");
    });
  } catch (e) {
    console.error("listen connection-status:", e);
  }
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

// ---- Composer behaviour ------------------------------------------

function autoResize(): void {
  const input = $<HTMLTextAreaElement>("input");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}

function wireComposer(): void {
  const input = $<HTMLTextAreaElement>("input");
  const send = $<HTMLButtonElement>("btn-send");
  const clear = $<HTMLButtonElement>("btn-clear");
  const settings = $<HTMLButtonElement>("btn-settings");
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
      if (!window.confirm("确认清空所有对话历史？此操作不可撤销。")) return;
      try {
        await invoke("clear_chat_history");
        const list = $("messages");
        if (list) {
          list.innerHTML = "";
          // Re-add empty state.
          const empty = document.createElement("div");
          empty.className = "empty-state";
          empty.id = "empty-state";
          empty.innerHTML =
            '<div class="empty-icon" aria-hidden="true">F</div>' +
            "<h2>开始一次对话</h2>" +
            "<p>向 AI 助理发送消息，它会在这里回复你。</p>";
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

// ---- Init --------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  wireComposer();
  void loadHistory();
  void subscribeEvents();
  void refreshConnectionStatus();
  // Periodically poll the connection status as a fallback in case
  // the WS pump forgets to emit.
  window.setInterval(refreshConnectionStatus, 5000);
});