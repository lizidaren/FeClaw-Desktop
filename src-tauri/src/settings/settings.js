function getTauri() {
  const g = window.__TAURI__;
  if (!g?.core) {
    throw new Error("Tauri global not available; did you enable withGlobalTauri?");
  }
  return g.core;
}
function getAppVersion() {
  const g = window.__TAURI__;
  return g?.metadata?.version;
}
const invoke = (cmd, args) => getTauri().invoke(cmd, args);
const KEY = {
  autoLaunch: "auto_launch",
  startMinimized: "start_minimized",
  theme: "theme"
};
const THEME_VALUES = ["light", "dark", "system"];
function $(id) {
  return document.getElementById(id);
}
function requireEl(id) {
  const el = $(id);
  if (!el) throw new Error(`missing element: #${id}`);
  return el;
}
function applyTheme(value) {
  const next = THEME_VALUES.includes(value ?? "") ? value : "system";
  document.body.dataset.theme = next;
}
let toastTimer;
function showToast(text, kind = "info") {
  const toast = $("toast");
  if (!toast) return;
  toast.textContent = text;
  toast.classList.remove("success", "error");
  if (kind !== "info") toast.classList.add(kind);
  toast.classList.add("show");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("show");
  }, 2400);
}
function setConnectionStatus(text, kind) {
  const el = $("connection-status");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("success", "error");
  if (kind !== "info") el.classList.add(kind);
}
function readGeneral() {
  return {
    autoLaunch: requireEl("auto-launch").checked,
    startMinimized: requireEl("start-minimized").checked,
    theme: requireEl("theme").value
  };
}
function writeGeneral(snap) {
  const autoLaunch = $("auto-launch");
  if (autoLaunch && snap.autoLaunch !== void 0) autoLaunch.checked = snap.autoLaunch;
  const startMinimized = $("start-minimized");
  if (startMinimized && snap.startMinimized !== void 0) {
    startMinimized.checked = snap.startMinimized;
  }
  const theme = $("theme");
  if (theme && snap.theme) theme.value = snap.theme;
}
function showLoginForm() {
  const card = $("cloud-connected-card");
  if (card) card.hidden = true;
  const url = $("cloud-url");
  const user = $("cloud-username");
  const pass = $("cloud-password");
  if (url) url.disabled = false;
  if (user) user.disabled = false;
  if (pass) pass.disabled = false;
  const loginBtn = $("btn-login");
  if (loginBtn) {
    loginBtn.disabled = false;
    const label = loginBtn.querySelector(".btn-label");
    if (label) label.textContent = "\u767B\u5F55";
  }
}
function showConnectedCard(username) {
  const card = $("cloud-connected-card");
  if (card) card.hidden = false;
  const who = $("logged-in-as");
  if (who) who.textContent = username;
}
function renderCloudSession(session) {
  if (session.connected) {
    showConnectedCard(session.username ?? "\u672A\u77E5\u7528\u6237");
    setConnectionStatus("", "info");
  } else {
    showLoginForm();
    if (session.url) {
      const urlInput = $("cloud-url");
      if (urlInput && !urlInput.value) urlInput.value = session.url;
    }
  }
}
async function load() {
  let map = {};
  try {
    map = await invoke("load_settings");
  } catch (e) {
    console.error("load_settings failed:", e);
    showToast("\u52A0\u8F7D\u8BBE\u7F6E\u5931\u8D25", "error");
  }
  writeGeneral({
    autoLaunch: map[KEY.autoLaunch] === "true",
    startMinimized: map[KEY.startMinimized] === "true",
    theme: map[KEY.theme] ?? "system"
  });
  applyTheme(map[KEY.theme]);
  try {
    const session = await invoke("get_cloud_session");
    renderCloudSession(session);
  } catch (e) {
    console.error("get_cloud_session failed:", e);
    showLoginForm();
  }
}
async function save() {
  const snap = readGeneral();
  const updates = {
    [KEY.autoLaunch]: String(snap.autoLaunch),
    [KEY.startMinimized]: String(snap.startMinimized),
    [KEY.theme]: snap.theme
  };
  try {
    await invoke("save_settings", { settings: updates });
    applyTheme(snap.theme);
    showToast("\u8BBE\u7F6E\u5DF2\u4FDD\u5B58", "success");
  } catch (e) {
    console.error("save_settings failed:", e);
    showToast(typeof e === "string" ? e : "\u4FDD\u5B58\u5931\u8D25", "error");
  }
}
async function cloudLogin() {
  const urlEl = requireEl("cloud-url");
  const userEl = requireEl("cloud-username");
  const passEl = requireEl("cloud-password");
  const loginBtn = requireEl("btn-login");
  const labelEl = loginBtn.querySelector(".btn-label");
  const spinner = loginBtn.querySelector(".btn-spinner");
  const url = urlEl.value.trim();
  const user = userEl.value.trim();
  const pass = passEl.value;
  if (!url) {
    setConnectionStatus("\u8BF7\u586B\u5199\u670D\u52A1\u5668\u5730\u5740", "error");
    urlEl.focus();
    return;
  }
  if (!user) {
    setConnectionStatus("\u8BF7\u586B\u5199\u7528\u6237\u540D", "error");
    userEl.focus();
    return;
  }
  if (!pass) {
    setConnectionStatus("\u8BF7\u586B\u5199\u5BC6\u7801", "error");
    passEl.focus();
    return;
  }
  loginBtn.disabled = true;
  if (labelEl) labelEl.textContent = "\u767B\u5F55\u4E2D";
  if (spinner) spinner.hidden = false;
  setConnectionStatus("\u6B63\u5728\u767B\u5F55\u2026", "info");
  try {
    await invoke("cloud_login", {
      url,
      username: user,
      password: pass
    });
    passEl.value = "";
    setConnectionStatus("\u2713 \u767B\u5F55\u6210\u529F", "success");
    showConnectedCard(user);
    showToast("\u4E91\u7AEF\u767B\u5F55\u6210\u529F", "success");
  } catch (e) {
    const msg = typeof e === "string" ? e : "\u767B\u5F55\u5931\u8D25";
    setConnectionStatus(msg, "error");
  } finally {
    loginBtn.disabled = false;
    if (labelEl) labelEl.textContent = "\u767B\u5F55";
    if (spinner) spinner.hidden = true;
  }
}
async function cloudDisconnect() {
  try {
    await invoke("cloud_disconnect");
    showLoginForm();
    const session = await invoke("get_cloud_session");
    const urlEl = $("cloud-url");
    if (urlEl && session.url) urlEl.value = session.url;
    setConnectionStatus("\u5DF2\u65AD\u5F00\u8FDE\u63A5", "info");
    showToast("\u5DF2\u65AD\u5F00\u4E91\u7AEF\u8FDE\u63A5", "info");
  } catch (e) {
    console.error("cloud_disconnect failed:", e);
    showToast(typeof e === "string" ? e : "\u65AD\u5F00\u5931\u8D25", "error");
  }
}
function switchTab(name) {
  const tabs = document.querySelectorAll(".nav-item");
  tabs.forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.hidden = p.id !== `tab-${name}`;
  });
}
function wireTabs() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.tab;
      if (name) switchTab(name);
    });
  });
}
function wireForm() {
  const saveBtn = requireEl("save");
  const cancelBtn = requireEl("cancel");
  const loginBtn = requireEl("btn-login");
  const discBtn = $("btn-disconnect");
  saveBtn.addEventListener("click", () => {
    void save();
  });
  cancelBtn.addEventListener("click", () => {
    window.close();
  });
  loginBtn.addEventListener("click", () => {
    void cloudLogin();
  });
  if (discBtn) discBtn.addEventListener("click", () => {
    void cloudDisconnect();
  });
  const themeSel = requireEl("theme");
  themeSel.addEventListener("change", () => {
    applyTheme(themeSel.value);
  });
  ["cloud-url", "cloud-username", "cloud-password"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void cloudLogin();
      }
    });
  });
}
function applyAppVersion() {
  const v = $("app-version");
  if (!v) return;
  const ver = getAppVersion();
  if (ver) v.textContent = ver;
}
document.addEventListener("DOMContentLoaded", () => {
  wireTabs();
  wireForm();
  applyAppVersion();
  void load();
});
