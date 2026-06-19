// =========================================================
// FeClaw Desktop — Settings page logic
// =========================================================
//
// Bridges the static HTML form to the Rust commands exposed in
// `src-tauri/src/settings.rs`:
//   • load_settings()      → returns the full HashMap<string, string>
//   • save_settings(map)   → persists the map to ui-settings.json
//   • test_cloud_connection(url, token) → probes /api/health
//
// Errors are surfaced via a transient toast in the footer; transient
// state (button spinners, status pills) is reset in a `finally` block
// so the UI never gets stuck on failure.
//
// The page is loaded without a bundler, so we talk to the Tauri bridge
// through the global `window.__TAURI__` (enabled by
// `app.withGlobalTauri` in tauri.conf.json). This avoids a hard
// dependency on `node_modules`/ESM resolution in the static front-end.

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
  cloudUrl:       "cloud_url",
  cloudToken:     "cloud_token",
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

// ---- Form read / write -------------------------------------------
type FormSnapshot = {
  cloudUrl: string;
  cloudToken: string;
  autoLaunch: boolean;
  startMinimized: boolean;
  theme: Theme;
};

function readForm(): FormSnapshot {
  return {
    cloudUrl:       requireEl<HTMLInputElement>("cloud-url").value.trim(),
    cloudToken:     requireEl<HTMLInputElement>("cloud-token").value,
    autoLaunch:     requireEl<HTMLInputElement>("auto-launch").checked,
    startMinimized: requireEl<HTMLInputElement>("start-minimized").checked,
    theme:          (requireEl<HTMLSelectElement>("theme").value as Theme),
  };
}

function writeForm(snap: Partial<FormSnapshot>): void {
  const cloudUrl = $<HTMLInputElement>("cloud-url");
  if (cloudUrl && snap.cloudUrl !== undefined) cloudUrl.value = snap.cloudUrl;

  const cloudToken = $<HTMLInputElement>("cloud-token");
  if (cloudToken && snap.cloudToken !== undefined) {
    cloudToken.value = snap.cloudToken;
    // Always start masked when we load a token from disk.
    if (snap.cloudToken) cloudToken.type = "password";
  }

  const autoLaunch = $<HTMLInputElement>("auto-launch");
  if (autoLaunch && snap.autoLaunch !== undefined) autoLaunch.checked = snap.autoLaunch;

  const startMinimized = $<HTMLInputElement>("start-minimized");
  if (startMinimized && snap.startMinimized !== undefined) {
    startMinimized.checked = snap.startMinimized;
  }

  const theme = $<HTMLSelectElement>("theme");
  if (theme && snap.theme) theme.value = snap.theme;
}

// ---- Load --------------------------------------------------------
async function load(): Promise<void> {
  let map: Record<string, string> = {};
  try {
    map = await invoke<Record<string, string>>("load_settings");
  } catch (e) {
    console.error("load_settings failed:", e);
    showToast("加载设置失败", "error");
    return;
  }

  writeForm({
    cloudUrl:       map[KEY.cloudUrl] ?? "",
    cloudToken:     map[KEY.cloudToken] ?? "",
    autoLaunch:     map[KEY.autoLaunch] === "true",
    startMinimized: map[KEY.startMinimized] === "true",
    theme:          ((map[KEY.theme] as Theme | undefined) ?? "system"),
  });

  applyTheme(map[KEY.theme]);
}

// ---- Save --------------------------------------------------------
async function save(): Promise<void> {
  const snap = readForm();
  const updates: Record<string, string> = {
    [KEY.cloudUrl]:       snap.cloudUrl,
    [KEY.autoLaunch]:     String(snap.autoLaunch),
    [KEY.startMinimized]: String(snap.startMinimized),
    [KEY.theme]:          snap.theme,
  };
  // Don't overwrite a saved token with an empty string from a re-opened form.
  if (snap.cloudToken) updates[KEY.cloudToken] = snap.cloudToken;

  try {
    await invoke("save_settings", { settings: updates });
    applyTheme(snap.theme);
    showToast("设置已保存", "success");
  } catch (e) {
    console.error("save_settings failed:", e);
    showToast(typeof e === "string" ? e : "保存失败", "error");
  }
}

// ---- Test connection --------------------------------------------
async function testConnection(): Promise<void> {
  const btn = requireEl<HTMLButtonElement>("test-connection");
  const labelEl = btn.querySelector<HTMLSpanElement>(".btn-label");
  const spinner = btn.querySelector<HTMLSpanElement>(".btn-spinner");
  const snap = readForm();

  if (!snap.cloudUrl) {
    setConnectionStatus("请先填写服务器地址", "error");
    return;
  }

  btn.disabled = true;
  if (labelEl) labelEl.textContent = "测试中";
  if (spinner) spinner.hidden = false;
  setConnectionStatus("正在连接…", "info");

  try {
    const ok = await invoke<boolean>("test_cloud_connection", {
      url:   snap.cloudUrl,
      token: snap.cloudToken,
    });
    if (ok) {
      setConnectionStatus("✓ 连接成功", "success");
    } else {
      setConnectionStatus("服务器返回错误状态码", "error");
    }
  } catch (e) {
    setConnectionStatus(
      typeof e === "string" ? e : "连接失败",
      "error",
    );
  } finally {
    btn.disabled = false;
    if (labelEl) labelEl.textContent = "测试连接";
    if (spinner) spinner.hidden = true;
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
  const testBtn   = requireEl<HTMLButtonElement>("test-connection");
  const toggleTok = requireEl<HTMLButtonElement>("toggle-token");
  const tokenIn   = requireEl<HTMLInputElement>("cloud-token");

  saveBtn.addEventListener("click", () => { void save(); });
  cancelBtn.addEventListener("click", () => { window.close(); });
  testBtn.addEventListener("click", () => { void testConnection(); });

  toggleTok.addEventListener("click", () => {
    tokenIn.type = tokenIn.type === "password" ? "text" : "password";
  });

  // Live-apply theme when the user changes the select (preview only; the
  // persisted value still requires an explicit Save).
  const themeSel = requireEl<HTMLSelectElement>("theme");
  themeSel.addEventListener("change", () => {
    applyTheme(themeSel.value);
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
