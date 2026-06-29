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
      clearPassword(passwordEl);
      await openChatWindow();
      return;
    }

    // Otherwise do the login
    // We need server URL - for official mode use feclaw.lizidaren.cn
    const serverUrl = session.url ?? "https://feclaw.lizidaren.cn";
    const loginUrl = session.login_url ?? serverUrl;

    await invoke<string>("cloud_login", {
      url: serverUrl,
      loginUrl: loginUrl,
      username,
      password,
    });

    setStatus("✓ 登录成功，正在打开聊天…", "success");
    // Wipe the password from the DOM before the chat window opens, so it
    // doesn't linger in this WebView's memory.
    clearPassword(passwordEl);
    // Small delay so user sees success message
    await new Promise((r) => setTimeout(r, 400));
    await openChatWindow();
  } catch (e: unknown) {
    const msg = typeof e === "string" ? e : (e as { message?: string })?.message ?? "登录失败";
    setStatus(msg, "error");
    // On failure, also wipe the password so a typo'd-but-correct value
    // doesn't sit in the DOM waiting for a shoulder-surf.
    clearPassword(passwordEl);
  } finally {
    btn.disabled = false;
  }
}

/** Overwrite the password field value, then null out the buffer. */
function clearPassword(passwordEl: HTMLInputElement): void {
  passwordEl.value = "";
  // Force a `change` so any UA autofill state is reset too.
  passwordEl.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---- Toast (Phase 1 / 4.1) --------------------------------------
// Mirrors `chat/components/toast.ts` for the welcome window's bundle.
// Kept local because welcome and chat are compiled into separate JS
// bundles and there is no shared module layer between them yet.
type ToastKind = "info" | "success" | "error";

interface ToastOptions {
  text: string;
  kind?: ToastKind;
  /** Auto-dismiss after this many ms. Default 3500. Pass 0 to disable. */
  duration?: number;
}

const TOAST_DEFAULT_DURATION = 3500;
const TOAST_MAX_VISIBLE = 5;
let toastContainer: HTMLDivElement | null = null;

function ensureToastContainer(): HTMLDivElement {
  if (toastContainer && document.body.contains(toastContainer)) return toastContainer;
  const el = document.createElement("div");
  el.id = "global-toast-container";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  document.body.appendChild(el);
  toastContainer = el;
  return el;
}

function showToast(opts: ToastOptions): void {
  const text = (opts.text ?? "").trim();
  if (!text) return;
  const kind: ToastKind = opts.kind ?? "info";
  const duration = opts.duration ?? TOAST_DEFAULT_DURATION;

  const root = ensureToastContainer();
  while (root.children.length >= TOAST_MAX_VISIBLE) {
    root.firstElementChild?.remove();
  }

  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = text;
  el.addEventListener("click", () => dismiss());
  root.appendChild(el);

  requestAnimationFrame(() => el.classList.add("toast-show"));

  let timer: number | undefined;
  const dismiss = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    el.classList.remove("toast-show");
    el.classList.add("toast-leave");
    window.setTimeout(() => el.remove(), 200);
  };

  if (duration > 0) {
    timer = window.setTimeout(dismiss, duration);
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
// Phase 1 / 4.1: local mode is not yet implemented. Intercept the
// "自建服务 · 本地运行" entry point and surface a clear notice so the
// user knows what to expect. Once the local engine + setup wizard are
// ready this can be relaxed to invoke("open_local_setup_window") again.
const LOCAL_MODE_DOC_URL = "https://feclaw.lizidaren.cn/docs/local-mode";

async function handleSelfhosted(): Promise<void> {
  showToast({
    text: `本地模式开发中，详情请查看文档：${LOCAL_MODE_DOC_URL}`,
    kind: "info",
    duration: 6000,
  });
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
  // Defensive: if the window is closed/refreshed for any reason, scrub the
  // password from the DOM. This catches the "user closes the welcome window
  // without clicking login" path that the handlers above don't reach.
  window.addEventListener("beforeunload", () => {
    const passwordEl = $<HTMLInputElement>("password");
    if (passwordEl) clearPassword(passwordEl);
  });
});