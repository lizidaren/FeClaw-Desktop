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
function qs(sel) {
  return document.querySelector(sel);
}
const state = {
  currentStep: 1,
  destPath: "",
  enginePort: 8080,
  adminPassword: "admin",
  gitOk: false,
  pythonOk: false,
  pythonVersion: "",
  cloneDone: false,
  installDone: false,
  startDone: false,
  depSuccess: false,
  engineRunning: false
};
function showStep(n) {
  state.currentStep = n;
  document.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
  const panel = document.getElementById(`step-${n}`);
  if (panel) panel.classList.remove("hidden");
  document.querySelectorAll(".step").forEach((s) => {
    const sn = parseInt(s.dataset.step || "0", 10);
    s.classList.remove("active", "done");
    if (sn < n) s.classList.add("done");
    else if (sn === n) s.classList.add("active");
  });
  document.querySelectorAll(".step-arrow").forEach((a) => {
    const next = a.nextElementSibling;
    const prev = a.previousElementSibling;
    if (prev?.classList.contains("done") || next?.classList.contains("done")) {
      a.classList.add("done");
    } else {
      a.classList.remove("done");
    }
  });
  $("content")?.scrollTo(0, 0);
}
function setStatus(id, text, kind = "info") {
  const el = $(`status-${id}`);
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok", "error");
  if (kind !== "info") el.classList.add(kind);
}
async function checkPrerequisites() {
  const btn = $("btn-check-prereqs");
  if (btn) {
    btn.disabled = true;
    btn.classList.add("btn-spinner");
  }
  setStatus("1", "\u6B63\u5728\u68C0\u6D4B\u2026", "info");
  const gitEl = qs('[data-check="git"]');
  if (gitEl) {
    gitEl.textContent = "\u68C0\u6D4B\u4E2D\u2026";
    gitEl.className = "check-status pending";
  }
  try {
    state.gitOk = await invoke("check_git_installed");
    if (gitEl) {
      gitEl.textContent = state.gitOk ? "\u2705 \u5DF2\u5B89\u88C5" : "\u274C \u672A\u5B89\u88C5";
      gitEl.className = state.gitOk ? "check-status ok" : "check-status fail";
    }
  } catch {
    state.gitOk = false;
    if (gitEl) {
      gitEl.textContent = "\u274C \u68C0\u6D4B\u5931\u8D25";
      gitEl.className = "check-status fail";
    }
  }
  const pyEl = qs('[data-check="python"]');
  if (pyEl) {
    pyEl.textContent = "\u68C0\u6D4B\u4E2D\u2026";
    pyEl.className = "check-status pending";
  }
  try {
    state.pythonVersion = await invoke("check_python_version");
    state.pythonOk = true;
    if (pyEl) {
      pyEl.textContent = `\u2705 Python ${state.pythonVersion}`;
      pyEl.className = "check-status ok";
    }
  } catch (e) {
    state.pythonOk = false;
    const msg = typeof e === "string" ? e : "\u7248\u672C\u4E0D\u7B26\u5408\u8981\u6C42";
    if (pyEl) {
      pyEl.textContent = `\u274C ${msg}`;
      pyEl.className = "check-status fail";
    }
  }
  if (btn) {
    btn.disabled = false;
    btn.classList.remove("btn-spinner");
  }
  if (state.gitOk && state.pythonOk) {
    setStatus("1", "\u2713 \u73AF\u5883\u68C0\u67E5\u901A\u8FC7\uFF0C\u53EF\u4EE5\u7EE7\u7EED", "ok");
    if (btn) btn.classList.add("hidden");
    const retry = $("btn-retry-prereqs");
    if (retry) retry.classList.remove("hidden");
    setTimeout(() => showStep(2), 800);
  } else {
    setStatus("1", "\u73AF\u5883\u4E0D\u6EE1\u8DB3\u8981\u6C42\uFF0C\u8BF7\u5B89\u88C5\u540E\u91CD\u8BD5", "error");
    if (btn) btn.classList.add("hidden");
    const retry = $("btn-retry-prereqs");
    if (retry) retry.classList.remove("hidden");
  }
}
async function initStep2() {
  try {
    state.destPath = await invoke("default_engine_dest");
  } catch {
    state.destPath = "~/feclaw";
  }
  const input = $("dest-path");
  if (input) input.value = state.destPath;
}
function initStep3() {
  const pathEl = $("clone-path");
  if (pathEl) {
    pathEl.textContent = `\u76EE\u6807\u8DEF\u5F84\uFF1A${state.destPath}/FeClaw`;
  }
  if (state.cloneDone) {
    const cloneBtn = $("btn-clone");
    if (cloneBtn) {
      cloneBtn.disabled = true;
      cloneBtn.textContent = "\u2713 \u5DF2\u514B\u9686";
    }
    const configCard = $("config-card");
    if (configCard) configCard.classList.remove("hidden");
    const nextBtn = $("btn-next-3");
    if (nextBtn) nextBtn.classList.remove("hidden");
  }
}
async function cloneRepository() {
  const btn = $("btn-clone");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "\u6B63\u5728\u514B\u9686\u2026";
    btn.classList.add("btn-spinner");
  }
  setStatus("3", "\u6B63\u5728\u4ECE GitHub \u514B\u9686 FeClaw \u4ED3\u5E93\u2026", "info");
  const progressEl = $("clone-progress");
  if (progressEl) {
    progressEl.classList.remove("hidden");
    progressEl.textContent = "\u6B63\u5728\u514B\u9686 https://github.com/lizidaren/FeClaw.git \u2026\n\u8BF7\u8010\u5FC3\u7B49\u5F85\uFF0C\u8FD9\u53EF\u80FD\u9700\u8981\u51E0\u5206\u949F\u3002";
  }
  try {
    await invoke("clone_feclaw", { dest: state.destPath });
    state.cloneDone = true;
    setStatus("3", "\u2713 \u4ED3\u5E93\u514B\u9686\u6210\u529F", "ok");
    if (btn) {
      btn.textContent = "\u2713 \u5DF2\u514B\u9686";
      btn.classList.remove("btn-spinner");
    }
    if (progressEl) {
      progressEl.textContent += "\n\u2713 \u514B\u9686\u5B8C\u6210";
    }
    const configCard = $("config-card");
    if (configCard) configCard.classList.remove("hidden");
    const nextBtn = $("btn-next-3");
    if (nextBtn) nextBtn.classList.remove("hidden");
  } catch (e) {
    const msg = typeof e === "string" ? e : "\u514B\u9686\u5931\u8D25";
    setStatus("3", msg, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "\u91CD\u8BD5\u514B\u9686";
      btn.classList.remove("btn-spinner");
    }
    if (progressEl) {
      progressEl.textContent += `
\u274C \u9519\u8BEF\uFF1A${msg}`;
    }
  }
}
function generateJwtSecret() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  let secret = "";
  const arr = new Uint8Array(48);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 48; i++) {
    secret += chars[arr[i] % chars.length];
  }
  const input = $("jwt-secret");
  if (input) input.value = secret;
}
async function installDependencies() {
  const btn = $("btn-install");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "\u6B63\u5728\u5B89\u88C5\u2026";
    btn.classList.add("btn-spinner");
  }
  const progressEl = $("install-progress");
  if (progressEl) {
    progressEl.classList.remove("hidden");
    progressEl.textContent = "\u6B63\u5728\u8FD0\u884C pip install \u2026";
  }
  setStatus("4", "\u6B63\u5728\u5B89\u88C5 Python \u4F9D\u8D56\u2026", "info");
  try {
    const output = await invoke("install_dependencies", { dest: state.destPath });
    state.depSuccess = true;
    state.installDone = true;
    setStatus("4", "\u2713 \u4F9D\u8D56\u5B89\u88C5\u5B8C\u6210", "ok");
    if (progressEl) progressEl.textContent = output;
    if (btn) {
      btn.textContent = "\u2713 \u5DF2\u5B89\u88C5";
      btn.classList.remove("btn-spinner");
    }
    const startBtn = $("btn-start");
    if (startBtn) startBtn.classList.remove("hidden");
  } catch (e) {
    const msg = typeof e === "string" ? e : "\u5B89\u88C5\u5931\u8D25";
    setStatus("4", msg, "error");
    if (progressEl) progressEl.textContent = msg;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "\u91CD\u8BD5\u5B89\u88C5";
      btn.classList.remove("btn-spinner");
    }
  }
}
async function startEngine() {
  const btn = $("btn-start");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "\u6B63\u5728\u542F\u52A8\u2026";
    btn.classList.add("btn-spinner");
  }
  const apiKey = $("api-key")?.value.trim() || "";
  const jwtSecret = $("jwt-secret")?.value.trim() || "auto";
  const pw = $("admin-password")?.value.trim() || "admin";
  state.adminPassword = pw;
  const portEl = $("engine-port");
  const port = portEl ? parseInt(portEl.value || "8080", 10) : 8080;
  if (isNaN(port) || port < 1024 || port > 65535) {
    setStatus("4", "\u7AEF\u53E3\u53F7\u5FC5\u987B\u5728 1024\u201365535 \u4E4B\u95F4", "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "\u542F\u52A8\u5F15\u64CE";
      btn.classList.remove("btn-spinner");
    }
    return;
  }
  state.enginePort = port;
  setStatus("4", "\u6B63\u5728\u751F\u6210\u914D\u7F6E\u6587\u4EF6\u2026", "info");
  try {
    const envContent = await invoke("generate_env_template", {
      dest: state.destPath,
      apiKey,
      jwtSecret,
      adminPassword: pw
    });
    await invoke("write_env_file", { dest: state.destPath, content: envContent });
  } catch (e) {
    const msg = typeof e === "string" ? e : "\u914D\u7F6E\u5199\u5165\u5931\u8D25";
    setStatus("4", msg, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "\u542F\u52A8\u5F15\u64CE";
      btn.classList.remove("btn-spinner");
    }
    return;
  }
  setStatus("4", "\u6B63\u5728\u542F\u52A8\u5F15\u64CE\u2026", "info");
  const startProgress = $("start-progress");
  if (startProgress) {
    startProgress.classList.remove("hidden");
    startProgress.textContent = `\u6B63\u5728\u542F\u52A8 uvicorn (\u7AEF\u53E3 ${port})\u2026`;
  }
  try {
    const password = await invoke("start_feclaw", { dest: state.destPath, port });
    state.adminPassword = password;
    state.startDone = true;
    setStatus("4", "\u2713 \u5F15\u64CE\u5DF2\u542F\u52A8", "ok");
    const infoEl = $("engine-info");
    if (infoEl) infoEl.classList.remove("hidden");
    const pwDisplay = $("admin-pw-display");
    if (pwDisplay) pwDisplay.textContent = password;
    const urlDisplay = $("engine-url-display");
    if (urlDisplay) urlDisplay.textContent = `http://127.0.0.1:${port}`;
    if (btn) {
      btn.textContent = "\u2713 \u5DF2\u542F\u52A8";
      btn.classList.remove("btn-spinner");
    }
    if (startProgress) {
      startProgress.textContent += `
\u2713 \u5F15\u64CE\u8FDB\u7A0B\u5DF2\u542F\u52A8
\u7BA1\u7406\u5458\u5BC6\u7801\uFF1A${password}`;
    }
    const nextBtn = $("btn-next-4");
    if (nextBtn) nextBtn.classList.remove("hidden");
    try {
      await invoke("save_local_engine_config", {
        dest: state.destPath,
        port,
        adminPassword: password
      });
    } catch {
    }
  } catch (e) {
    const msg = typeof e === "string" ? e : "\u542F\u52A8\u5931\u8D25";
    setStatus("4", msg, "error");
    if (startProgress) startProgress.textContent += `
\u274C \u9519\u8BEF\uFF1A${msg}`;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "\u91CD\u8BD5\u542F\u52A8";
      btn.classList.remove("btn-spinner");
    }
  }
}
function initStep5() {
  const infoEl = $("conn-info");
  if (infoEl) {
    infoEl.innerHTML = `
      <div class="info-row">
        <span class="info-label">\u5F15\u64CE\u5730\u5740\uFF1A</span>
        <code>http://127.0.0.1:${state.enginePort}</code>
      </div>
      <div class="info-row">
        <span class="info-label">\u7BA1\u7406\u5458\u5BC6\u7801\uFF1A</span>
        <code>${state.adminPassword}</code>
      </div>
      <div class="info-row">
        <span class="info-label">\u5F15\u64CE\u76EE\u5F55\uFF1A</span>
        <code>${state.destPath}/FeClaw</code>
      </div>
    `;
  }
}
async function connectEngine() {
  const btn = $("btn-connect");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "\u6B63\u5728\u68C0\u6D4B\u5F15\u64CE\u72B6\u6001\u2026";
    btn.classList.add("btn-spinner");
  }
  setStatus("5", "\u6B63\u5728\u68C0\u6D4B\u5F15\u64CE\u5065\u5EB7\u72B6\u6001\u2026", "info");
  try {
    const healthy = await invoke("check_engine_health", { port: state.enginePort });
    if (healthy) {
      setStatus("5", "\u2713 \u5F15\u64CE\u8FD0\u884C\u6B63\u5E38\uFF0C\u8FDE\u63A5\u6210\u529F\uFF01", "ok");
      if (btn) {
        btn.textContent = "\u2713 \u5DF2\u8FDE\u63A5";
        btn.classList.remove("btn-spinner");
      }
      setTimeout(() => {
        invoke("open_chat_window").catch(() => {
        });
        window.close();
      }, 1200);
    } else {
      setStatus("5", "\u5F15\u64CE\u4F3C\u4E4E\u672A\u54CD\u5E94\uFF0C\u8BF7\u68C0\u67E5\u7AEF\u53E3\u548C\u8FDB\u7A0B", "error");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "\u91CD\u8BD5\u8FDE\u63A5";
        btn.classList.remove("btn-spinner");
      }
    }
  } catch (e) {
    const msg = typeof e === "string" ? e : "\u68C0\u6D4B\u5931\u8D25";
    setStatus("5", msg, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "\u91CD\u8BD5\u8FDE\u63A5";
      btn.classList.remove("btn-spinner");
    }
  }
}
function wire() {
  $("btn-check-prereqs")?.addEventListener("click", () => void checkPrerequisites());
  $("btn-retry-prereqs")?.addEventListener("click", () => void checkPrerequisites());
  $("btn-next-2")?.addEventListener("click", () => {
    const input = $("dest-path");
    state.destPath = input?.value.trim() || "~/feclaw";
    showStep(3);
    initStep3();
  });
  $("btn-back-2")?.addEventListener("click", () => showStep(1));
  $("btn-clone")?.addEventListener("click", () => void cloneRepository());
  $("btn-gen-jwt")?.addEventListener("click", () => generateJwtSecret());
  $("btn-next-3")?.addEventListener("click", () => showStep(4));
  $("btn-back-3")?.addEventListener("click", () => showStep(2));
  $("btn-install")?.addEventListener("click", () => void installDependencies());
  $("btn-start")?.addEventListener("click", () => void startEngine());
  $("btn-next-4")?.addEventListener("click", () => {
    showStep(5);
    initStep5();
  });
  $("btn-back-4")?.addEventListener("click", () => showStep(3));
  $("btn-connect")?.addEventListener("click", () => void connectEngine());
  $("btn-back-5")?.addEventListener("click", () => showStep(4));
  setTimeout(() => {
    void checkPrerequisites();
  }, 300);
}
document.addEventListener("DOMContentLoaded", () => {
  invoke("default_engine_dest").then((dest) => {
    state.destPath = dest;
    const input = $("dest-path");
    if (input) input.value = dest;
  }).catch(() => {
  });
  wire();
});
