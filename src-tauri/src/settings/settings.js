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
  cloudUrl: "cloud_url",
  cloudToken: "cloud_token",
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
function readForm() {
  return {
    cloudUrl: requireEl("cloud-url").value.trim(),
    cloudToken: requireEl("cloud-token").value,
    autoLaunch: requireEl("auto-launch").checked,
    startMinimized: requireEl("start-minimized").checked,
    theme: requireEl("theme").value
  };
}
function writeForm(snap) {
  const cloudUrl = $("cloud-url");
  if (cloudUrl && snap.cloudUrl !== void 0) cloudUrl.value = snap.cloudUrl;
  const cloudToken = $("cloud-token");
  if (cloudToken && snap.cloudToken !== void 0) {
    cloudToken.value = snap.cloudToken;
    if (snap.cloudToken) cloudToken.type = "password";
  }
  const autoLaunch = $("auto-launch");
  if (autoLaunch && snap.autoLaunch !== void 0) autoLaunch.checked = snap.autoLaunch;
  const startMinimized = $("start-minimized");
  if (startMinimized && snap.startMinimized !== void 0) {
    startMinimized.checked = snap.startMinimized;
  }
  const theme = $("theme");
  if (theme && snap.theme) theme.value = snap.theme;
}
async function load() {
  let map = {};
  try {
    map = await invoke("load_settings");
  } catch (e) {
    console.error("load_settings failed:", e);
    showToast("\u52A0\u8F7D\u8BBE\u7F6E\u5931\u8D25", "error");
    return;
  }
  writeForm({
    cloudUrl: map[KEY.cloudUrl] ?? "",
    cloudToken: map[KEY.cloudToken] ?? "",
    autoLaunch: map[KEY.autoLaunch] === "true",
    startMinimized: map[KEY.startMinimized] === "true",
    theme: map[KEY.theme] ?? "system"
  });
  applyTheme(map[KEY.theme]);
}
async function save() {
  const snap = readForm();
  const updates = {
    [KEY.cloudUrl]: snap.cloudUrl,
    [KEY.autoLaunch]: String(snap.autoLaunch),
    [KEY.startMinimized]: String(snap.startMinimized),
    [KEY.theme]: snap.theme
  };
  if (snap.cloudToken) updates[KEY.cloudToken] = snap.cloudToken;
  try {
    await invoke("save_settings", { settings: updates });
    applyTheme(snap.theme);
    showToast("\u8BBE\u7F6E\u5DF2\u4FDD\u5B58", "success");
  } catch (e) {
    console.error("save_settings failed:", e);
    showToast(typeof e === "string" ? e : "\u4FDD\u5B58\u5931\u8D25", "error");
  }
}
async function testConnection() {
  const btn = requireEl("test-connection");
  const labelEl = btn.querySelector(".btn-label");
  const spinner = btn.querySelector(".btn-spinner");
  const snap = readForm();
  if (!snap.cloudUrl) {
    setConnectionStatus("\u8BF7\u5148\u586B\u5199\u670D\u52A1\u5668\u5730\u5740", "error");
    return;
  }
  btn.disabled = true;
  if (labelEl) labelEl.textContent = "\u6D4B\u8BD5\u4E2D";
  if (spinner) spinner.hidden = false;
  setConnectionStatus("\u6B63\u5728\u8FDE\u63A5\u2026", "info");
  try {
    const ok = await invoke("test_cloud_connection", {
      url: snap.cloudUrl,
      token: snap.cloudToken
    });
    if (ok) {
      setConnectionStatus("\u2713 \u8FDE\u63A5\u6210\u529F", "success");
    } else {
      setConnectionStatus("\u670D\u52A1\u5668\u8FD4\u56DE\u9519\u8BEF\u72B6\u6001\u7801", "error");
    }
  } catch (e) {
    setConnectionStatus(
      typeof e === "string" ? e : "\u8FDE\u63A5\u5931\u8D25",
      "error"
    );
  } finally {
    btn.disabled = false;
    if (labelEl) labelEl.textContent = "\u6D4B\u8BD5\u8FDE\u63A5";
    if (spinner) spinner.hidden = true;
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
  const testBtn = requireEl("test-connection");
  const toggleTok = requireEl("toggle-token");
  const tokenIn = requireEl("cloud-token");
  saveBtn.addEventListener("click", () => {
    void save();
  });
  cancelBtn.addEventListener("click", () => {
    window.close();
  });
  testBtn.addEventListener("click", () => {
    void testConnection();
  });
  toggleTok.addEventListener("click", () => {
    tokenIn.type = tokenIn.type === "password" ? "text" : "password";
  });
  const themeSel = requireEl("theme");
  themeSel.addEventListener("change", () => {
    applyTheme(themeSel.value);
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
