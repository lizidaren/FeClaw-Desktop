// =========================================================
// FeClaw Desktop — Welcome page (login form)
// =========================================================
//
// Flow:
//   - Login form → cloud_login → JWT stored in config.toml
//   - On success → close welcome, open chat window
//   - "自建服务·本地运行" → open local_setup window
//
// The compiled bundle is welcome.js (built with esbuild).
// The page is loaded inside a Tauri WebviewWindow via
// `welcome::open_welcome_window` on first launch.

type TauriCore = {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
};

function getTauri(): TauriCore {
  const g = (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__;
  if (!g?.core) {
    throw new Error("Tauri global not available");
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

// ---- Login handler ---------------------------------------------
async function handleLogin(): Promise<void> {
  const usernameEl = $<HTMLInputElement>("username");
  const passwordEl = $<HTMLInputElement>("password");
  const btn = $<HTMLButtonElement>("btn-login");
  if (!usernameEl || !passwordEl || !btn) return;

  const username = usernameEl.value.trim();
  const password = passwordEl.value;

  if (!username) {
    setStatus("请输入邮箱或用户名", "error");
    usernameEl.focus();
    return;
  }
  if (!password) {
    setStatus("请输入密码", "error");
    passwordEl.focus();
    return;
  }

  btn.disabled = true;
  setStatus("正在登录…", "info");

  try {
    // Load cloud session to get the URLs
    const session = await invoke<{ connected: boolean; url?: string; login_url?: string }>(
      "get_cloud_session",
    );

    // If already connected, just proceed to chat
    if (session.connected) {
      setStatus("✓ 已登录，正在打开聊天…", "success");
      await openChatWindow();
      return;
    }

    // Otherwise do the login
    // We need server URL - for official mode use feclaw.lizidaren.cn
    const serverUrl = session.url ?? "https://feclaw.lizidaren.cn";
    const loginUrl = session.login_url ?? serverUrl;

    const token = await invoke<string>("cloud_login", {
      url: serverUrl,
      loginUrl: loginUrl,
      username,
      password,
    });

    setStatus("✓ 登录成功，正在打开聊天…", "success");
    // Small delay so user sees success message
    await new Promise((r) => setTimeout(r, 400));
    await openChatWindow();
  } catch (e: unknown) {
    const msg = typeof e === "string" ? e : (e as { message?: string })?.message ?? "登录失败";
    setStatus(msg, "error");
  } finally {
    btn.disabled = false;
  }
}

async function openChatWindow(): Promise<void> {
  try {
    await invoke("open_chat_window");
    // Close welcome window after opening chat
    window.close();
  } catch (e) {
    console.error("open_chat_window failed:", e);
    setStatus("无法打开聊天窗口", "error");
  }
}

// ---- Self-hosted / local ----------------------------------------
async function handleSelfhosted(): Promise<void> {
  setStatus("正在打开自建服务配置…", "info");
  // For now, redirect to local_setup
  try {
    await invoke("open_local_setup_window");
    setTimeout(() => {
      window.close();
    }, 400);
  } catch (e) {
    console.error("open_local_setup_window failed:", e);
    setStatus("无法打开配置向导", "error");
  }
}

function handleRegister(): void {
  // In the future this would open a registration URL
  // For now, show a message pointing to the platform
  setStatus("请访问官方平台注册账号", "info");
}

// ---- Wiring -----------------------------------------------------
function wire(): void {
  const btnLogin = $<HTMLButtonElement>("btn-login");
  const btnSelfhosted = $<HTMLAnchorElement>("btn-selfhosted");
  const btnRegister = $<HTMLAnchorElement>("btn-register");
  const passwordEl = $<HTMLInputElement>("password");
  const usernameEl = $<HTMLInputElement>("username");

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

  // Enter key on password triggers login
  if (passwordEl) {
    passwordEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void handleLogin();
      }
    });
  }

  // Auto-focus username field
  if (usernameEl) {
    usernameEl.focus();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  wire();
});