// =========================================================
// FeClaw Desktop — Welcome page
// =========================================================
//
// Three-card layout: official / selfhosted / local.
// Persists the selection to `~/.feclaw/config.toml` via the
// `save_welcome_config` Tauri command.
//
// The compiled bundle is `welcome.js` (built with esbuild — see
// project docs). The page is loaded inside a Tauri WebviewWindow
// via `welcome::open_welcome_window` on first launch.

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

// ---- DOM helpers ------------------------------------------------
function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setStatus(text: string, kind: "info" | "success" | "error" = "info"): void {
  const el = $<HTMLSpanElement>("status");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("success", "error");
  if (kind !== "info") el.classList.add(kind);
}

type WelcomeResult = {
  saved: boolean;
  redirect_to_local_setup: boolean;
  mode: string;
};

// ---- Save handlers ---------------------------------------------
async function saveOfficial(): Promise<void> {
  setStatus("正在配置官方平台…", "info");
  try {
    const result = await invoke<WelcomeResult>("save_welcome_config", {
      args: { mode: "official" },
    });
    if (!result.saved) {
      setStatus("配置失败：服务器未确认", "error");
      return;
    }
    setStatus("✓ 已选择官方平台，正在打开登录…", "success");
    await openCloudLogin();
  } catch (e) {
    const msg = typeof e === "string" ? e : "保存失败";
    setStatus(msg, "error");
  }
}

async function saveSelfhosted(): Promise<void> {
  const urlEl = $<HTMLInputElement>("server-url");
  const loginEl = $<HTMLInputElement>("login-url");
  if (!urlEl) return;
  const url = urlEl.value.trim();
  if (!url) {
    setStatus("请填写服务器地址", "error");
    urlEl.focus();
    return;
  }
  setStatus("正在保存…", "info");
  try {
    const result = await invoke<WelcomeResult>("save_welcome_config", {
      args: {
        mode: "selfhosted",
        serverUrl: url,
        loginUrl: loginEl?.value.trim() ?? "",
      },
    });
    if (!result.saved) {
      setStatus("配置失败：服务器未确认", "error");
      return;
    }
    setStatus("✓ 已保存，正在打开登录…", "success");
    await openCloudLogin();
  } catch (e) {
    const msg = typeof e === "string" ? e : "保存失败";
    setStatus(msg, "error");
  }
}

async function pickLocal(): Promise<void> {
  setStatus("正在切换到本地模式…", "info");
  try {
    const result = await invoke<WelcomeResult>("save_welcome_config", {
      args: { mode: "local" },
    });
    if (result.redirect_to_local_setup) {
      setStatus("✓ 已选择本地模式", "success");
      // Local setup page is delivered in P1.1; for now we just close
      // the welcome window — the user can relaunch the local-setup
      // wizard from Settings → 常规 → 本地引擎.
      setTimeout(() => {
        window.close();
      }, 600);
    } else {
      setStatus("配置失败：未触发本地流程", "error");
    }
  } catch (e) {
    const msg = typeof e === "string" ? e : "保存失败";
    setStatus(msg, "error");
  }
}

async function openCloudLogin(): Promise<void> {
  try {
    await invoke("open_settings_window");
  } catch (e) {
    // Fall back to telling the user to open Settings manually.
    console.error("open_settings_window failed:", e);
    setStatus("请打开 设置 → 云端 完成登录", "info");
  }
}

// ---- Optional: auto-discover login URL via /.well-known ---------
async function tryAutoDiscover(): Promise<void> {
  const urlEl = $<HTMLInputElement>("server-url");
  const loginEl = $<HTMLInputElement>("login-url");
  if (!urlEl) return;
  const url = urlEl.value.trim();
  if (!url) return;
  // Only auto-discover when login URL is empty AND user has paused
  // typing for a moment — simple debounce handled by the input event.
  try {
    const body = await invoke<string | null>("discover_well_known", { url });
    if (body && loginEl) {
      const parsed = JSON.parse(body) as { auth?: { endpoint?: string } };
      const endpoint = parsed.auth?.endpoint;
      if (endpoint && !loginEl.value) {
        loginEl.value = endpoint.replace(/\/api\/auth\/login\/?$/, "");
      }
    }
  } catch {
    /* ignore — auto-discover is best-effort */
  }
}

let debounceTimer: number | undefined;
function debounceAutoDiscover(): void {
  if (debounceTimer) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    void tryAutoDiscover();
  }, 800);
}

// ---- Wiring -----------------------------------------------------
function wire(): void {
  // Card click → same as the embedded button.
  document.querySelectorAll<HTMLElement>(".card").forEach((card) => {
    card.addEventListener("click", (ev) => {
      // Don't trigger when clicking inside the self-hosted form.
      const target = ev.target as HTMLElement;
      if (target.closest(".selfhosted-form")) return;
      card.querySelector<HTMLButtonElement>(".card-foot button")?.click();
    });
    card.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        card.querySelector<HTMLButtonElement>(".card-foot button")?.click();
      }
    });
  });

  // Buttons.
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((btn) => {
    const mode = btn.dataset.mode;
    btn.addEventListener("click", () => {
      if (mode === "official") void saveOfficial();
      else if (mode === "selfhosted") void saveSelfhosted();
      else if (mode === "local") void pickLocal();
    });
  });

  // Auto-discover when the user types a server URL.
  const urlEl = $<HTMLInputElement>("server-url");
  if (urlEl) urlEl.addEventListener("input", debounceAutoDiscover);
}

document.addEventListener("DOMContentLoaded", () => {
  wire();
});
