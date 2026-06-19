function getTauri() {
  const g = window.__TAURI__;
  if (!g?.core) {
    throw new Error("Tauri global not available; did you enable withGlobalTauri?");
  }
  return g.core;
}
const invoke = (cmd, args) => getTauri().invoke(cmd, args);
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
async function saveOfficial() {
  setStatus("\u6B63\u5728\u914D\u7F6E\u5B98\u65B9\u5E73\u53F0\u2026", "info");
  try {
    const result = await invoke("save_welcome_config", {
      args: { mode: "official" }
    });
    if (!result.saved) {
      setStatus("\u914D\u7F6E\u5931\u8D25\uFF1A\u670D\u52A1\u5668\u672A\u786E\u8BA4", "error");
      return;
    }
    setStatus("\u2713 \u5DF2\u9009\u62E9\u5B98\u65B9\u5E73\u53F0\uFF0C\u6B63\u5728\u6253\u5F00\u767B\u5F55\u2026", "success");
    await openCloudLogin();
  } catch (e) {
    const msg = typeof e === "string" ? e : "\u4FDD\u5B58\u5931\u8D25";
    setStatus(msg, "error");
  }
}
async function saveSelfhosted() {
  const urlEl = $("server-url");
  const loginEl = $("login-url");
  if (!urlEl) return;
  const url = urlEl.value.trim();
  if (!url) {
    setStatus("\u8BF7\u586B\u5199\u670D\u52A1\u5668\u5730\u5740", "error");
    urlEl.focus();
    return;
  }
  setStatus("\u6B63\u5728\u4FDD\u5B58\u2026", "info");
  try {
    const result = await invoke("save_welcome_config", {
      args: {
        mode: "selfhosted",
        serverUrl: url,
        loginUrl: loginEl?.value.trim() ?? ""
      }
    });
    if (!result.saved) {
      setStatus("\u914D\u7F6E\u5931\u8D25\uFF1A\u670D\u52A1\u5668\u672A\u786E\u8BA4", "error");
      return;
    }
    setStatus("\u2713 \u5DF2\u4FDD\u5B58\uFF0C\u6B63\u5728\u6253\u5F00\u767B\u5F55\u2026", "success");
    await openCloudLogin();
  } catch (e) {
    const msg = typeof e === "string" ? e : "\u4FDD\u5B58\u5931\u8D25";
    setStatus(msg, "error");
  }
}
async function pickLocal() {
  setStatus("\u6B63\u5728\u5207\u6362\u5230\u672C\u5730\u6A21\u5F0F\u2026", "info");
  try {
    const result = await invoke("save_welcome_config", {
      args: { mode: "local" }
    });
    if (result.redirect_to_local_setup) {
      setStatus("\u2713 \u5DF2\u9009\u62E9\u672C\u5730\u6A21\u5F0F", "success");
      setTimeout(() => {
        window.close();
      }, 600);
    } else {
      setStatus("\u914D\u7F6E\u5931\u8D25\uFF1A\u672A\u89E6\u53D1\u672C\u5730\u6D41\u7A0B", "error");
    }
  } catch (e) {
    const msg = typeof e === "string" ? e : "\u4FDD\u5B58\u5931\u8D25";
    setStatus(msg, "error");
  }
}
async function openCloudLogin() {
  try {
    await invoke("open_settings_window");
  } catch (e) {
    console.error("open_settings_window failed:", e);
    setStatus("\u8BF7\u6253\u5F00 \u8BBE\u7F6E \u2192 \u4E91\u7AEF \u5B8C\u6210\u767B\u5F55", "info");
  }
}
async function tryAutoDiscover() {
  const urlEl = $("server-url");
  const loginEl = $("login-url");
  if (!urlEl) return;
  const url = urlEl.value.trim();
  if (!url) return;
  try {
    const body = await invoke("discover_well_known", { url });
    if (body && loginEl) {
      const parsed = JSON.parse(body);
      const endpoint = parsed.auth?.endpoint;
      if (endpoint && !loginEl.value) {
        loginEl.value = endpoint.replace(/\/api\/auth\/login\/?$/, "");
      }
    }
  } catch {
  }
}
let debounceTimer;
function debounceAutoDiscover() {
  if (debounceTimer) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    void tryAutoDiscover();
  }, 800);
}
function wire() {
  document.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", (ev) => {
      const target = ev.target;
      if (target.closest(".selfhosted-form")) return;
      card.querySelector(".card-foot button")?.click();
    });
    card.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        card.querySelector(".card-foot button")?.click();
      }
    });
  });
  document.querySelectorAll("[data-mode]").forEach((btn) => {
    const mode = btn.dataset.mode;
    btn.addEventListener("click", () => {
      if (mode === "official") void saveOfficial();
      else if (mode === "selfhosted") void saveSelfhosted();
      else if (mode === "local") void pickLocal();
    });
  });
  const urlEl = $("server-url");
  if (urlEl) urlEl.addEventListener("input", debounceAutoDiscover);
}
document.addEventListener("DOMContentLoaded", () => {
  wire();
});
