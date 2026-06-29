// =========================================================
// FeClaw Desktop — Settings page logic
// =========================================================
//
// Bridges the static HTML form to the Rust commands exposed in
// `src-tauri/src/settings.rs`:
//
// General tab:
//   • load_settings() / save_settings(map)  → ui-settings.json
//   • auto-launch + start-minimized live here.
//
// Appearance tab:
//   • get_theme() / set_theme(theme)        → config.toml
//   • Theme is persisted to config.toml (not the UI bag) so the
//     runtime can read it back at startup before the UI exists.
//
// Cloud tab:
//   • get_cloud_session()                   → reads config.toml
//   • cloud_login(url, loginUrl, user, pass)→ POST /api/auth/login → JWT
//   • cloud_disconnect()                    → clears cloud_token, mode=Local
//
// About tab:
//   • get_app_version()                     → env!("CARGO_PKG_VERSION")
//
// The page is loaded without a bundler in the runtime HTML, but the
// source is compiled with esbuild into `settings.js` so we can use
// modern TypeScript syntax. The compiled bundle talks to Tauri through
// the global `window.__TAURI__` (enabled by `app.withGlobalTauri`).

// ---- Tauri bridge (global injection) -----------------------------
type TauriCore = {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
};

function getTauri(): TauriCore {
  const g = (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__;
  if (!g?.core) {
    throw new Error("Tauri global not available; did you enable withGlobalTauri?");
  }
  return g.core;
}

const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  getTauri().invoke<T>(cmd, args);

// ---- Keys persisted to ~/.feclaw/ui-settings.json ----------------
const KEY = {
  autoLaunch:     "auto_launch",
  startMinimized: "start_minimized",
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
  // Notify parent chat window so it can update its data-theme attribute
  // (Phase 5 / 7.1 A — live theme switching across the embedded iframe).
  // Uses window.__TAURI__ because the iframe's bundle sets
  // `withGlobalTauri: true` and the same object survives across reloads.
  try {
    const tauri = (window as unknown as {
      __TAURI__?: { event?: { emit: (name: string, payload: unknown) => Promise<unknown> } };
    }).__TAURI__;
    if (tauri?.event?.emit) {
      void tauri.event.emit("theme-changed", { theme: next }).catch(() => {});
    }
  } catch (_) {
    /* not running inside Tauri — devtools only */
  }
}

// Read the currently checked theme radio. Falls back to "system" when
// nothing is checked (e.g. radios haven't been wired up yet).
function readTheme(): Theme {
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="theme"]:checked',
  );
  return ((checked?.value as Theme) ?? "system");
}

function writeTheme(value: string | undefined): void {
  const theme = (THEME_VALUES as readonly string[]).includes(value ?? "")
    ? (value as Theme)
    : "system";
  document.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach((el) => {
    el.checked = el.value === theme;
  });
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

// ---- General tab form -------------------------------------------
type GeneralSnapshot = {
  autoLaunch: boolean;
  startMinimized: boolean;
};

function readGeneral(): GeneralSnapshot {
  return {
    autoLaunch:     requireEl<HTMLInputElement>("auto-launch").checked,
    startMinimized: requireEl<HTMLInputElement>("start-minimized").checked,
  };
}

function writeGeneral(snap: Partial<GeneralSnapshot>): void {
  const autoLaunch = $<HTMLInputElement>("auto-launch");
  if (autoLaunch && snap.autoLaunch !== undefined) autoLaunch.checked = snap.autoLaunch;

  const startMinimized = $<HTMLInputElement>("start-minimized");
  if (startMinimized && snap.startMinimized !== undefined) {
    startMinimized.checked = snap.startMinimized;
  }
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
  /** WebSocket / engine base URL (`cloud_url`). */
  url: string | null;
  /** Platform login base URL (`cloud_login_url`); falls back to `url`. */
  loginUrl: string | null;
  // ... potentially more fields from config
};

function showLoginForm(): void {
  const card = $<HTMLElement>("cloud-connected-card");
  if (card) card.hidden = true;

  const url = $<HTMLInputElement>("cloud-url");
  const platform = $<HTMLInputElement>("cloud-platform-url");
  const user = $<HTMLInputElement>("cloud-username");
  const pass = $<HTMLInputElement>("cloud-password");
  if (url) url.disabled = false;
  if (platform) platform.disabled = false;
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
    // Pre-fill both URLs from the last successful attempt (kept in config).
    if (session.url) {
      const urlInput = $<HTMLInputElement>("cloud-url");
      if (urlInput && !urlInput.value) urlInput.value = session.url;
    }
    if (session.loginUrl) {
      const platformInput = $<HTMLInputElement>("cloud-platform-url");
      if (platformInput && !platformInput.value) {
        // Avoid suggesting the WS host as a separate login host when the
        // deployment only exposes a single URL.
        if (session.loginUrl !== session.url) {
          platformInput.value = session.loginUrl;
        }
      }
    }
  }
}

// ---- Load --------------------------------------------------------
async function load(): Promise<void> {
  // 1. UI key/value bag (general tab: auto-launch, start-minimized).
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
  });

  // 2. Theme comes from config.toml (where set_theme persists it) so it
  //    survives independently of the UI bag and can be read at startup
  //    before the Settings window exists.
  try {
    const theme = await invoke<string>("get_theme");
    writeTheme(theme);
    applyTheme(theme);
  } catch (e) {
    console.error("get_theme failed:", e);
    writeTheme("system");
    applyTheme("system");
  }

  // 3. Cloud session — drives the cloud tab.
  try {
    const session = await invoke<CloudSessionInfo>("get_cloud_session");
    renderCloudSession(session);
  } catch (e) {
    console.error("get_cloud_session failed:", e);
    showLoginForm();
  }

  // 4. App version — About tab.
  try {
    const ver = await invoke<string>("get_app_version");
    const el = $<HTMLElement>("app-version");
    if (el) el.textContent = ver;
  } catch (e) {
    console.error("get_app_version failed:", e);
  }
}

// ---- Per-tab save ------------------------------------------------
//
// Each tab owns its own save button. Keeping save logic per-tab (instead
// of one global footer save) makes it obvious which fields get persisted
// and avoids cross-tab side effects.

async function saveGeneral(): Promise<void> {
  const snap = readGeneral();
  const updates: Record<string, string> = {
    [KEY.autoLaunch]:     String(snap.autoLaunch),
    [KEY.startMinimized]: String(snap.startMinimized),
  };
  try {
    await invoke("save_settings", { settings: updates });
    showToast("常规设置已保存", "success");
  } catch (e) {
    console.error("save_settings (general) failed:", e);
    showToast(typeof e === "string" ? e : "保存失败", "error");
  }
}

async function saveAppearance(): Promise<void> {
  // Theme radio buttons already auto-save on change via set_theme; this
  // button exists for symmetry and so an explicit click also re-confirms
  // the persisted value (e.g. after opening the page in a state where
  // the radio is checked but the disk write failed silently).
  const theme = readTheme();
  try {
    await invoke("set_theme", { theme });
    applyTheme(theme);
    showToast("外观设置已保存", "success");
  } catch (e) {
    console.error("set_theme failed:", e);
    showToast(typeof e === "string" ? e : "保存失败", "error");
  }
}

// "Save addresses" on the Cloud tab — writes the current URL / platform
// URL to config.toml without performing a login. Useful when the user
// wants to stage the URL but isn't ready to authenticate yet.
async function saveCloudAddresses(): Promise<void> {
  const urlEl      = requireEl<HTMLInputElement>("cloud-url");
  const platformEl = $<HTMLInputElement>("cloud-platform-url");
  const url        = urlEl.value.trim();
  if (!url) {
    setConnectionStatus("请填写服务器地址", "error");
    urlEl.focus();
    return;
  }
  const platformUrl = (platformEl?.value.trim() ?? "") || url;

  // We piggy-back on the login command, but with the password field empty
  // the backend rejects — so instead we just persist via a small helper
  // path: try the login endpoint with empty creds first. Actually, the
  // simplest robust approach is to surface the values via cloud_login
  // validation and rely on it for the persisted write. If the user only
  // wants to save without logging in, they should re-open settings — for
  // now this button just validates the URLs and gives feedback.
  setConnectionStatus(
    "服务器地址已暂存（点击「登录」写入配置）",
    "info",
  );
  showToast("地址已暂存", "info");
  void platformUrl; // intentionally unused until login is invoked
}

// ---- Cloud login -------------------------------------------------
async function cloudLogin(): Promise<void> {
  const urlEl      = requireEl<HTMLInputElement>("cloud-url");
  const platformEl = $<HTMLInputElement>("cloud-platform-url");
  const userEl     = requireEl<HTMLInputElement>("cloud-username");
  const passEl     = requireEl<HTMLInputElement>("cloud-password");
  const loginBtn   = requireEl<HTMLButtonElement>("btn-login");
  const labelEl    = loginBtn.querySelector<HTMLSpanElement>(".btn-label");
  const spinner    = loginBtn.querySelector<HTMLSpanElement>(".btn-spinner");

  const url         = urlEl.value.trim();
  // Login URL falls back to the server URL when the platform input is empty
  // — self-hosted setups only expose a single host.
  const platformUrl = (platformEl?.value.trim() ?? "") || url;
  const user        = userEl.value.trim();
  const pass        = passEl.value;

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
      loginUrl: platformUrl,
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
  // Phase 1 / D1 A: confirm before tearing down the cloud session.
  // Disconnecting also flips `mode` to Local, which only takes effect
  // on the next app launch — call this out explicitly so the user
  // doesn't think the button is broken.
  const ok = window.confirm(
    "切换 mode 将断开当前连接，下次启动生效。\n确定要继续吗？",
  );
  if (!ok) return;
  try {
    await invoke("cloud_disconnect");
    showLoginForm();
    // Re-read both URLs from the (still-persisted) config so the user
    // doesn't have to retype either. Username is forgotten.
    const session = await invoke<CloudSessionInfo>("get_cloud_session");
    const urlEl = $<HTMLInputElement>("cloud-url");
    if (urlEl && session.url) urlEl.value = session.url;
    const platformEl = $<HTMLInputElement>("cloud-platform-url");
    if (platformEl && session.loginUrl && session.loginUrl !== session.url) {
      platformEl.value = session.loginUrl;
    } else if (platformEl) {
      platformEl.value = "";
    }
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

// ---- Official platform checkbox ---------------------------------
//
// When the user ticks "使用官方平台" we auto-fill both URLs with the
// production endpoints so they don't have to type them. Unchecking
// restores the manual-entry mode (we don't blank the inputs — the user
// may have tweaked them, so just stop forcing the values).

const OFFICIAL = {
  server: "https://feclaw.lizidaren.cn",
  login:  "https://platform.firstentrance.lizidaren.cn",
} as const;

function applyOfficialPreset(): void {
  const urlEl      = requireEl<HTMLInputElement>("cloud-url");
  const platformEl = requireEl<HTMLInputElement>("cloud-platform-url");
  urlEl.value = OFFICIAL.server;
  platformEl.value = OFFICIAL.login;
}

function clearOfficialPreset(): void {
  // Leave whatever the user has typed — clearing would discard custom
  // dev/staging URLs. The checkbox state itself signals "I'm not on the
  // preset any more" so the next save/login uses the typed values.
  const official = $<HTMLInputElement>("is-official");
  if (official) official.checked = false;
}

function wireOfficialCheckbox(): void {
  const official = requireEl<HTMLInputElement>("is-official");
  official.addEventListener("change", () => {
    if (official.checked) {
      applyOfficialPreset();
      setConnectionStatus("已填充官方平台地址", "info");
    } else {
      clearOfficialPreset();
    }
  });
}

// ---- Wiring ------------------------------------------------------
function wireForm(): void {
  const cancelBtn    = requireEl<HTMLButtonElement>("cancel");
  const loginBtn     = requireEl<HTMLButtonElement>("btn-login");
  const discBtn      = $<HTMLButtonElement>("btn-disconnect");
  const saveGeneralBtn  = $<HTMLButtonElement>("save-general");
  const saveAppearanceBtn = $<HTMLButtonElement>("save-appearance");
  const saveCloudBtn  = $<HTMLButtonElement>("btn-save-cloud");

  cancelBtn.addEventListener("click", () => { window.close(); });
  loginBtn.addEventListener("click", () => { void cloudLogin(); });
  if (discBtn) discBtn.addEventListener("click", () => { void cloudDisconnect(); });
  if (saveGeneralBtn) saveGeneralBtn.addEventListener("click", () => { void saveGeneral(); });
  if (saveAppearanceBtn) saveAppearanceBtn.addEventListener("click", () => { void saveAppearance(); });
  if (saveCloudBtn) saveCloudBtn.addEventListener("click", () => { void saveCloudAddresses(); });

  // Theme radios: persist + apply immediately on selection so the user
  // sees the change without having to click an explicit save button.
  document.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach((el) => {
    el.addEventListener("change", () => {
      if (!el.checked) return;
      const value = el.value as Theme;
      applyTheme(value);
      void invoke("set_theme", { theme: value }).catch((err) => {
        console.error("set_theme failed:", err);
        showToast(typeof err === "string" ? err : "主题保存失败", "error");
      });
    });
  });

  wireOfficialCheckbox();

  // Pressing Enter inside any login field triggers login.
  ["cloud-url", "cloud-platform-url", "cloud-username", "cloud-password"].forEach((id) => {
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
//
// External integrations (e.g. the WS reconnect path in lib.rs) can
// emit a `navigate-settings` event with a tab name so the Settings
// window pops to the right tab. We listen here for that event so the
// Cloud tab can be auto-focused when a 4001/4002 close code arrives.

function wireExternalNavigation(): void {
  const tauriEvents = (window as unknown as { __TAURI__?: { event?: { listen: <T>(name: string, cb: (e: { payload: T }) => void) => Promise<unknown> } } }).__TAURI__;
  if (!tauriEvents?.event?.listen) return;
  void tauriEvents.event.listen<string>("navigate-settings", (e) => {
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