// =========================================================
// FeClaw Desktop — Settings page logic
// =========================================================
//
// Bridges the static HTML form to the Rust commands exposed in
// `src-tauri/src/settings.rs`:
//   • load_settings() / save_settings(map)  → ui-settings.json
//   • get_cloud_session()                  → reads config.toml
//   • cloud_login(url, user, pass)         → POST /api/login → save JWT
//   • cloud_disconnect()                   → clears cloud_token, mode=Local
//
// Cloud password is NEVER written to disk; only the JWT returned by the
// server is persisted (via `cloud_login` → Config).
//
// The page is loaded without a bundler in the runtime HTML, but the
// source is compiled with esbuild into `settings.js` so we can use
// modern TypeScript syntax. The compiled bundle talks to Tauri through
// the global `window.__TAURI__` (enabled by `app.withGlobalTauri`).

// ---- Tauri bridge (global injection) -----------------------------
type TauriCore = {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
};

type TauriMetadata = {
  metadata?: { version?: string };
};

function getTauri(): TauriCore {
  const g = (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__;
  if (!g?.core) {
    throw new Error("Tauri global not available; did you enable withGlobalTauri?");
  }
  return g.core;
}

function getAppVersion(): string | undefined {
  const g = (window as unknown as { __TAURI__?: TauriMetadata }).__TAURI__;
  return g?.metadata?.version;
}

const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  getTauri().invoke<T>(cmd, args);

// ---- Keys persisted to ~/.feclaw/ui-settings.json ----------------
const KEY = {
  autoLaunch:     "auto_launch",
  startMinimized: "start_minimized",
  theme:          "theme",
} as const;

const THEME_VALUES = ["light", "dark", "system"] as const;
type Theme = (typeof THEME_VALUES)[number];

// ---- DOM helpers -------------------------------------------------
// Returns `T | null`; callers MUST null-check (N-14 fix from v2-plan).
function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function requireEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = $<T>(id);
  if (!el) throw new Error(`missing element: #${id}`);
  return el;
}

// ---- Theme handling ---------------------------------------------
function applyTheme(value: string | undefined): void {
  const next: Theme = (THEME_VALUES as readonly string[]).includes(value ?? "")
    ? (value as Theme)
    : "system";
  document.body.dataset.theme = next;
}

// ---- Toast / status messaging ------------------------------------
let toastTimer: number | undefined;

function showToast(text: string, kind: "info" | "success" | "error" = "info"): void {
  const toast = $<HTMLSpanElement>("toast");
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

function setConnectionStatus(text: string, kind: "info" | "success" | "error"): void {
  const el = $<HTMLSpanElement>("connection-status");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("success", "error");
  if (kind !== "info") el.classList.add(kind);
}

// ---- General / appearance form ----------------------------------
type GeneralSnapshot = {
  autoLaunch: boolean;
  startMinimized: boolean;
  theme: Theme;
};

function readGeneral(): GeneralSnapshot {
  return {
    autoLaunch:     requireEl<HTMLInputElement>("auto-launch").checked,
    startMinimized: requireEl<HTMLInputElement>("start-minimized").checked,
    theme:          (requireEl<HTMLSelectElement>("theme").value as Theme),
  };
}

function writeGeneral(snap: Partial<GeneralSnapshot>): void {
  const autoLaunch = $<HTMLInputElement>("auto-launch");
  if (autoLaunch && snap.autoLaunch !== undefined) autoLaunch.checked = snap.autoLaunch;

  const startMinimized = $<HTMLInputElement>("start-minimized");
  if (startMinimized && snap.startMinimized !== undefined) {
    startMinimized.checked = snap.startMinimized;
  }

  const theme = $<HTMLSelectElement>("theme");
  if (theme && snap.theme) theme.value = snap.theme;
}

// ---- Cloud session rendering ------------------------------------
//
// The cloud form has two states:
//   • "login"     — show the URL/username/password inputs + 登录 button.
//   • "connected" — show the green card with "logged in as <name>" + 断开连接.
//
// The current state is mirrored in DOM visibility (we never keep a duplicate
// boolean — the DOM is the source of truth). This avoids drift between the
// state and the visible UI.

type CloudSessionInfo = {
  connected: boolean;
  username: string | null;
  url: string | null;
};

function showLoginForm(): void {
  const card = $<HTMLElement>("cloud-connected-card");
  if (card) card.hidden = true;

  const url = $<HTMLInputElement>("cloud-url");
  const user = $<HTMLInputElement>("cloud-username");
  const pass = $<HTMLInputElement>("cloud-password");
  if (url) url.disabled = false;
  if (user) user.disabled = false;
  if (pass) pass.disabled = false;

  const loginBtn = $<HTMLButtonElement>("btn-login");
  if (loginBtn) {
    loginBtn.disabled = false;
    const label = loginBtn.querySelector<HTMLSpanElement>(".btn-label");
    if (label) label.textContent = "登录";
  }
}

function showConnectedCard(username: string): void {
  const card = $<HTMLElement>("cloud-connected-card");
  if (card) card.hidden = false;

  const who = $<HTMLElement>("logged-in-as");
  if (who) who.textContent = username;
}

function renderCloudSession(session: CloudSessionInfo): void {
  if (session.connected) {
    showConnectedCard(session.username ?? "未知用户");
    setConnectionStatus("", "info");
  } else {
    showLoginForm();
    // Pre-fill the URL from the last successful attempt (kept in config).
    if (session.url) {
      const urlInput = $<HTMLInputElement>("cloud-url");
      if (urlInput && !urlInput.value) urlInput.value = session.url;
    }
  }
}

// ---- Load --------------------------------------------------------
async function load(): Promise<void> {
  // 1. UI key/value bag (general, appearance).
  let map: Record<string, string> = {};
  try {
    map = await invoke<Record<string, string>>("load_settings");
  } catch (e) {
    console.error("load_settings failed:", e);
    showToast("加载设置失败", "error");
  }
  writeGeneral({
    autoLaunch:     map[KEY.autoLaunch] === "true",
    startMinimized: map[KEY.startMinimized] === "true",
    theme:          ((map[KEY.theme] as Theme | undefined) ?? "system"),
  });
  applyTheme(map[KEY.theme]);

  // 2. Cloud session — drives the cloud tab.
  try {
    const session = await invoke<CloudSessionInfo>("get_cloud_session");
    renderCloudSession(session);
  } catch (e) {
    console.error("get_cloud_session failed:", e);
    showLoginForm();
  }
}

// ---- Save (general + appearance only) ----------------------------
async function save(): Promise<void> {
  const snap = readGeneral();
  const updates: Record<string, string> = {
    [KEY.autoLaunch]:     String(snap.autoLaunch),
    [KEY.startMinimized]: String(snap.startMinimized),
    [KEY.theme]:          snap.theme,
  };

  try {
    await invoke("save_settings", { settings: updates });
    applyTheme(snap.theme);
    showToast("设置已保存", "success");
  } catch (e) {
    console.error("save_settings failed:", e);
    showToast(typeof e === "string" ? e : "保存失败", "error");
  }
}

// ---- Cloud login -------------------------------------------------
async function cloudLogin(): Promise<void> {
  const urlEl   = requireEl<HTMLInputElement>("cloud-url");
  const userEl  = requireEl<HTMLInputElement>("cloud-username");
  const passEl  = requireEl<HTMLInputElement>("cloud-password");
  const loginBtn = requireEl<HTMLButtonElement>("btn-login");
  const labelEl = loginBtn.querySelector<HTMLSpanElement>(".btn-label");
  const spinner = loginBtn.querySelector<HTMLSpanElement>(".btn-spinner");

  const url  = urlEl.value.trim();
  const user = userEl.value.trim();
  const pass = passEl.value;

  if (!url)  { setConnectionStatus("请填写服务器地址", "error"); urlEl.focus();   return; }
  if (!user) { setConnectionStatus("请填写用户名",     "error"); userEl.focus();  return; }
  if (!pass) { setConnectionStatus("请填写密码",       "error"); passEl.focus();  return; }

  loginBtn.disabled = true;
  if (labelEl) labelEl.textContent = "登录中";
  if (spinner) spinner.hidden = false;
  setConnectionStatus("正在登录…", "info");

  try {
    await invoke<string>("cloud_login", {
      url,
      username: user,
      password: pass,
    });
    // Clear the password field — it has served its purpose.
    passEl.value = "";
    setConnectionStatus("✓ 登录成功", "success");
    showConnectedCard(user);
    showToast("云端登录成功", "success");
  } catch (e) {
    const msg = typeof e === "string" ? e : "登录失败";
    setConnectionStatus(msg, "error");
  } finally {
    loginBtn.disabled = false;
    if (labelEl) labelEl.textContent = "登录";
    if (spinner) spinner.hidden = true;
  }
}

// ---- Cloud disconnect --------------------------------------------
async function cloudDisconnect(): Promise<void> {
  try {
    await invoke("cloud_disconnect");
    showLoginForm();
    // Re-read the URL from the (still-persisted) cloud_url so the user
    // doesn't have to retype it. Username is forgotten.
    const session = await invoke<CloudSessionInfo>("get_cloud_session");
    const urlEl = $<HTMLInputElement>("cloud-url");
    if (urlEl && session.url) urlEl.value = session.url;
    setConnectionStatus("已断开连接", "info");
    showToast("已断开云端连接", "info");
  } catch (e) {
    console.error("cloud_disconnect failed:", e);
    showToast(typeof e === "string" ? e : "断开失败", "error");
  }
}

// ---- Tabs --------------------------------------------------------
function switchTab(name: string): void {
  const tabs = document.querySelectorAll<HTMLElement>(".nav-item");
  tabs.forEach((t) => {
    const active = t.dataset.tab === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
  });

  document.querySelectorAll<HTMLElement>(".tab-panel").forEach((p) => {
    p.hidden = p.id !== `tab-${name}`;
  });
}

function wireTabs(): void {
  document.querySelectorAll<HTMLElement>(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.tab;
      if (name) switchTab(name);
    });
  });
}

// ---- Wiring ------------------------------------------------------
function wireForm(): void {
  const saveBtn   = requireEl<HTMLButtonElement>("save");
  const cancelBtn = requireEl<HTMLButtonElement>("cancel");
  const loginBtn  = requireEl<HTMLButtonElement>("btn-login");
  const discBtn   = $<HTMLButtonElement>("btn-disconnect");

  saveBtn.addEventListener("click", () => { void save(); });
  cancelBtn.addEventListener("click", () => { window.close(); });
  loginBtn.addEventListener("click", () => { void cloudLogin(); });
  if (discBtn) discBtn.addEventListener("click", () => { void cloudDisconnect(); });

  // Live-apply theme when the user changes the select (preview only; the
  // persisted value still requires an explicit Save).
  const themeSel = requireEl<HTMLSelectElement>("theme");
  themeSel.addEventListener("change", () => {
    applyTheme(themeSel.value);
  });

  // Pressing Enter inside any login field triggers login.
  ["cloud-url", "cloud-username", "cloud-password"].forEach((id) => {
    const el = $<HTMLInputElement>(id);
    if (el) el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void cloudLogin();
      }
    });
  });
}

// ---- Boot --------------------------------------------------------
function applyAppVersion(): void {
  const v = $<HTMLElement>("app-version");
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
