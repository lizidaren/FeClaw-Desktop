// src-tauri/src/welcome/welcome.ts
function getTauri() {
  const g = window.__TAURI__;
  if (!g?.core) {
    throw new Error("Tauri global not available");
  }
  return g.core;
}
var invoke = (cmd, args) => getTauri().invoke(cmd, args);
function $(id) {
  return document.getElementById(id);
}
function setStatus(text, kind = "info") {
  const el = $("status");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("success", "error");
  if (kind !== "info") el.classList.add(kind);
}
async function handleLogin() {
  const usernameEl = $("username");
  const passwordEl = $("password");
  const btn = $("btn-login");
  if (!usernameEl || !passwordEl || !btn) return;
  const username = usernameEl.value.trim();
  const password = passwordEl.value;
  if (!username) {
    setStatus("\u8BF7\u8F93\u5165\u90AE\u7BB1\u6216\u7528\u6237\u540D", "error");
    usernameEl.focus();
    return;
  }
  if (!password) {
    setStatus("\u8BF7\u8F93\u5165\u5BC6\u7801", "error");
    passwordEl.focus();
    return;
  }
  btn.disabled = true;
  setStatus("\u6B63\u5728\u767B\u5F55\u2026", "info");
  try {
    const session = await invoke(
      "get_cloud_session"
    );
    if (session.connected) {
      setStatus("\u2713 \u5DF2\u767B\u5F55\uFF0C\u6B63\u5728\u6253\u5F00\u804A\u5929\u2026", "success");
      await openChatWindow();
      return;
    }
    const serverUrl = session.url ?? "https://feclaw.lizidaren.cn";
    // Auto-detect Platform URL when using the official server
    const OFFICIAL_PLATFORM = "https://platform.firstentrance.lizidaren.cn";
    const loginUrl = session.login_url ?? (
      serverUrl === "https://feclaw.lizidaren.cn" ? OFFICIAL_PLATFORM : serverUrl
    );
    const token = await invoke("cloud_login", {
      url: serverUrl,
      loginUrl,
      username,
      password
    });
    setStatus("\u2713 \u767B\u5F55\u6210\u529F\uFF0C\u6B63\u5728\u6253\u5F00\u804A\u5929\u2026", "success");
    await new Promise((r) => setTimeout(r, 400));
    await openChatWindow();
  } catch (e) {
    const msg = typeof e === "string" ? e : e?.message ?? "\u767B\u5F55\u5931\u8D25";
    setStatus(msg, "error");
  } finally {
    btn.disabled = false;
  }
}
async function openChatWindow() {
  try {
    await invoke("open_chat_window");
    window.close();
  } catch (e) {
    console.error("open_chat_window failed:", e);
    setStatus("\u65E0\u6CD5\u6253\u5F00\u804A\u5929\u7A97\u53E3", "error");
  }
}
async function handleSelfhosted() {
  setStatus("\u6B63\u5728\u6253\u5F00\u81EA\u5EFA\u670D\u52A1\u914D\u7F6E\u2026", "info");
  try {
    await invoke("open_local_setup_window");
    setTimeout(() => {
      window.close();
    }, 400);
  } catch (e) {
    console.error("open_local_setup_window failed:", e);
    setStatus("\u65E0\u6CD5\u6253\u5F00\u914D\u7F6E\u5411\u5BFC", "error");
  }
}
function handleRegister() {
  setStatus("\u8BF7\u8BBF\u95EE\u5B98\u65B9\u5E73\u53F0\u6CE8\u518C\u8D26\u53F7", "info");
}
function wire() {
  const btnLogin = $("btn-login");
  const btnSelfhosted = $("btn-selfhosted");
  const btnRegister = $("btn-register");
  const passwordEl = $("password");
  const usernameEl = $("username");
  if (btnLogin) {
    btnLogin.addEventListener("click", () => void handleLogin());
  }
  if (btnSelfhosted) {
    btnSelfhosted.addEventListener("click", (e) => {
      e.preventDefault();
      void handleSelfhosted();
    });
  }
  if (btnRegister) {
    btnRegister.addEventListener("click", (e) => {
      e.preventDefault();
      handleRegister();
    });
  }
  if (passwordEl) {
    passwordEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void handleLogin();
      }
    });
  }
  if (usernameEl) {
    usernameEl.focus();
  }
}
async function checkCloudHealth() {
  const dot = $("cloud-dot");
  const text = $("cloud-status-text");
  if (!dot || !text) return;
  try {
    const result = await invoke("check_cloud_health");
    if (result === "healthy") {
      dot.className = "status-dot connected";
      text.textContent = "已连接";
    } else {
      dot.className = "status-dot error";
      text.textContent = result || "连接失败";
    }
  } catch (e) {
    dot.className = "status-dot error";
    const msg = typeof e === "string" ? e : e?.message ?? "连接失败";
    text.textContent = msg;
  }
}
document.addEventListener("DOMContentLoaded", () => {
  wire();
  void checkCloudHealth();
});
