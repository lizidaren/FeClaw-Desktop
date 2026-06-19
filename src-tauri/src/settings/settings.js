function getTauri() {
  const g = window.__TAURI__;
  if (!g?.core) {
    throw new Error("Tauri global not available; did you enable withGlobalTauri?");
  }
  return g.core;
}
const invoke = (cmd, args) => getTauri().invoke(cmd, args);
const KEY = {
  autoLaunch: "auto_launch",
  startMinimized: "start_minimized"
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
function readTheme() {
  const checked = document.querySelector(
    'input[name="theme"]:checked'
  );
  return checked?.value ?? "system";
}
function writeTheme(value) {
  const theme = THEME_VALUES.includes(value ?? "") ? value : "system";
  document.querySelectorAll('input[name="theme"]').forEach((el) => {
    el.checked = el.value === theme;
  });
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
    startMinimized: requireEl("start-minimized").checked
  };
}
function writeGeneral(snap) {
  const autoLaunch = $("auto-launch");
  if (autoLaunch && snap.autoLaunch !== void 0) autoLaunch.checked = snap.autoLaunch;
  const startMinimized = $("start-minimized");
  if (startMinimized && snap.startMinimized !== void 0) {
    startMinimized.checked = snap.startMinimized;
  }
}
function showLoginForm() {
  const card = $("cloud-connected-card");
  if (card) card.hidden = true;
  const url = $("cloud-url");
  const platform = $("cloud-platform-url");
  const user = $("cloud-username");
  const pass = $("cloud-password");
  if (url) url.disabled = false;
  if (platform) platform.disabled = false;
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
    if (session.loginUrl) {
      const platformInput = $("cloud-platform-url");
      if (platformInput && !platformInput.value) {
        if (session.loginUrl !== session.url) {
          platformInput.value = session.loginUrl;
        }
      }
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
    startMinimized: map[KEY.startMinimized] === "true"
  });
  try {
    const theme = await invoke("get_theme");
    writeTheme(theme);
    applyTheme(theme);
  } catch (e) {
    console.error("get_theme failed:", e);
    writeTheme("system");
    applyTheme("system");
  }
  try {
    const session = await invoke("get_cloud_session");
    renderCloudSession(session);
  } catch (e) {
    console.error("get_cloud_session failed:", e);
    showLoginForm();
  }
  try {
    const ver = await invoke("get_app_version");
    const el = $("app-version");
    if (el) el.textContent = ver;
  } catch (e) {
    console.error("get_app_version failed:", e);
  }
}
async function saveGeneral() {
  const snap = readGeneral();
  const updates = {
    [KEY.autoLaunch]: String(snap.autoLaunch),
    [KEY.startMinimized]: String(snap.startMinimized)
  };
  try {
    await invoke("save_settings", { settings: updates });
    showToast("\u5E38\u89C4\u8BBE\u7F6E\u5DF2\u4FDD\u5B58", "success");
  } catch (e) {
    console.error("save_settings (general) failed:", e);
    showToast(typeof e === "string" ? e : "\u4FDD\u5B58\u5931\u8D25", "error");
  }
}
async function saveAppearance() {
  const theme = readTheme();
  try {
    await invoke("set_theme", { theme });
    applyTheme(theme);
    showToast("\u5916\u89C2\u8BBE\u7F6E\u5DF2\u4FDD\u5B58", "success");
  } catch (e) {
    console.error("set_theme failed:", e);
    showToast(typeof e === "string" ? e : "\u4FDD\u5B58\u5931\u8D25", "error");
  }
}
async function saveCloudAddresses() {
  const urlEl = requireEl("cloud-url");
  const platformEl = $("cloud-platform-url");
  const url = urlEl.value.trim();
  if (!url) {
    setConnectionStatus("\u8BF7\u586B\u5199\u670D\u52A1\u5668\u5730\u5740", "error");
    urlEl.focus();
    return;
  }
  const platformUrl = (platformEl?.value.trim() ?? "") || url;
  setConnectionStatus(
    "\u670D\u52A1\u5668\u5730\u5740\u5DF2\u6682\u5B58\uFF08\u70B9\u51FB\u300C\u767B\u5F55\u300D\u5199\u5165\u914D\u7F6E\uFF09",
    "info"
  );
  showToast("\u5730\u5740\u5DF2\u6682\u5B58", "info");
  void platformUrl;
}
async function cloudLogin() {
  const urlEl = requireEl("cloud-url");
  const platformEl = $("cloud-platform-url");
  const userEl = requireEl("cloud-username");
  const passEl = requireEl("cloud-password");
  const loginBtn = requireEl("btn-login");
  const labelEl = loginBtn.querySelector(".btn-label");
  const spinner = loginBtn.querySelector(".btn-spinner");
  const url = urlEl.value.trim();
  const platformUrl = (platformEl?.value.trim() ?? "") || url;
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
      loginUrl: platformUrl,
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
    const platformEl = $("cloud-platform-url");
    if (platformEl && session.loginUrl && session.loginUrl !== session.url) {
      platformEl.value = session.loginUrl;
    } else if (platformEl) {
      platformEl.value = "";
    }
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
const OFFICIAL = {
  server: "https://feclaw.lizidaren.cn",
  login: "https://platform.firstentrance.lizidaren.cn"
};
function applyOfficialPreset() {
  const urlEl = requireEl("cloud-url");
  const platformEl = requireEl("cloud-platform-url");
  urlEl.value = OFFICIAL.server;
  platformEl.value = OFFICIAL.login;
}
function clearOfficialPreset() {
  const official = $("is-official");
  if (official) official.checked = false;
}
function wireOfficialCheckbox() {
  const official = requireEl("is-official");
  official.addEventListener("change", () => {
    if (official.checked) {
      applyOfficialPreset();
      setConnectionStatus("\u5DF2\u586B\u5145\u5B98\u65B9\u5E73\u53F0\u5730\u5740", "info");
    } else {
      clearOfficialPreset();
    }
  });
}
function wireForm() {
  const cancelBtn = requireEl("cancel");
  const loginBtn = requireEl("btn-login");
  const discBtn = $("btn-disconnect");
  const saveGeneralBtn = $("save-general");
  const saveAppearanceBtn = $("save-appearance");
  const saveCloudBtn = $("btn-save-cloud");
  cancelBtn.addEventListener("click", () => {
    window.close();
  });
  loginBtn.addEventListener("click", () => {
    void cloudLogin();
  });
  if (discBtn) discBtn.addEventListener("click", () => {
    void cloudDisconnect();
  });
  if (saveGeneralBtn) saveGeneralBtn.addEventListener("click", () => {
    void saveGeneral();
  });
  if (saveAppearanceBtn) saveAppearanceBtn.addEventListener("click", () => {
    void saveAppearance();
  });
  if (saveCloudBtn) saveCloudBtn.addEventListener("click", () => {
    void saveCloudAddresses();
  });
  document.querySelectorAll('input[name="theme"]').forEach((el) => {
    el.addEventListener("change", () => {
      if (!el.checked) return;
      const value = el.value;
      applyTheme(value);
      void invoke("set_theme", { theme: value }).catch((err) => {
        console.error("set_theme failed:", err);
        showToast(typeof err === "string" ? err : "\u4E3B\u9898\u4FDD\u5B58\u5931\u8D25", "error");
      });
    });
  });
  wireOfficialCheckbox();
  ["cloud-url", "cloud-platform-url", "cloud-username", "cloud-password"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void cloudLogin();
      }
    });
  });
}
function wireExternalNavigation() {
  const tauriEvents = window.__TAURI__;
  if (!tauriEvents?.event?.listen) return;
  void tauriEvents.event.listen("navigate-settings", (e) => {
    const target = e.payload;
    if (target) switchTab(target);
  });
}
document.addEventListener("DOMContentLoaded", () => {
  wireTabs();
  wireForm();
  wireExternalNavigation();
  void load();
});
