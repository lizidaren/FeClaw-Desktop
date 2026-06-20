// =========================================================
// FeClaw Desktop — Local Setup wizard
// =========================================================
//
// Step-by-step wizard for cloning, configuring, and starting
// a local FeClaw engine. Talks to the Rust backend through
// `window.__TAURI__.core.invoke()`.
//
// Steps:
//   1. Prerequisites check (git, python)
//   2. Work directory
//   3. Clone & configure
//   4. Install & start
//   5. Connect engine

// ---- Tauri bridge -------------------------------------------------

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

// ---- DOM helpers --------------------------------------------------

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function qs<T extends HTMLElement = HTMLElement>(sel: string): T | null {
  return document.querySelector<T>(sel);
}

// ---- State --------------------------------------------------------

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
  engineRunning: false,
};

// ---- Step navigation -----------------------------------------------

function showStep(n: number): void {
  state.currentStep = n;

  // Hide all panels.
  document.querySelectorAll<HTMLElement>(".panel").forEach((p) => p.classList.add("hidden"));

  // Show target panel.
  const panel = document.getElementById(`step-${n}`);
  if (panel) panel.classList.remove("hidden");

  // Update step indicator.
  document.querySelectorAll<HTMLElement>(".step").forEach((s) => {
    const sn = parseInt(s.dataset.step || "0", 10);
    s.classList.remove("active", "done");
    if (sn < n) s.classList.add("done");
    else if (sn === n) s.classList.add("active");
  });

  // Update arrows.
  document.querySelectorAll<HTMLElement>(".step-arrow").forEach((a) => {
    // The arrow before step N connects step N-1 → N
    const next = a.nextElementSibling as HTMLElement | null;
    const prev = a.previousElementSibling as HTMLElement | null;
    if (prev?.classList.contains("done") || next?.classList.contains("done")) {
      a.classList.add("done");
    } else {
      a.classList.remove("done");
    }
  });

  // Scroll to top.
  $("content")?.scrollTo(0, 0);
}

function setStatus(id: string, text: string, kind: "info" | "ok" | "error" = "info"): void {
  const el = $(`status-${id}`);
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok", "error");
  if (kind !== "info") el.classList.add(kind);
}

// ---- Step 1: Prerequisites -----------------------------------------

async function checkPrerequisites(): Promise<void> {
  const btn = $<HTMLButtonElement>("btn-check-prereqs");
  if (btn) {
    btn.disabled = true;
    btn.classList.add("btn-spinner");
  }
  setStatus("1", "正在检测…", "info");

  // Check git.
  const gitEl = qs<HTMLElement>('[data-check="git"]');
  if (gitEl) { gitEl.textContent = "检测中…"; gitEl.className = "check-status pending"; }

  try {
    state.gitOk = await invoke<boolean>("check_git_installed");
    if (gitEl) {
      gitEl.textContent = state.gitOk ? "✅ 已安装" : "❌ 未安装";
      gitEl.className = state.gitOk ? "check-status ok" : "check-status fail";
    }
  } catch {
    state.gitOk = false;
    if (gitEl) { gitEl.textContent = "❌ 检测失败"; gitEl.className = "check-status fail"; }
  }

  // Check python.
  const pyEl = qs<HTMLElement>('[data-check="python"]');
  if (pyEl) { pyEl.textContent = "检测中…"; pyEl.className = "check-status pending"; }

  try {
    state.pythonVersion = await invoke<string>("check_python_version");
    state.pythonOk = true;
    if (pyEl) {
      pyEl.textContent = `✅ Python ${state.pythonVersion}`;
      pyEl.className = "check-status ok";
    }
  } catch (e) {
    state.pythonOk = false;
    const msg = typeof e === "string" ? e : "版本不符合要求";
    if (pyEl) { pyEl.textContent = `❌ ${msg}`; pyEl.className = "check-status fail"; }
  }

  if (btn) {
    btn.disabled = false;
    btn.classList.remove("btn-spinner");
  }

  if (state.gitOk && state.pythonOk) {
    setStatus("1", "✓ 环境检查通过，可以继续", "ok");
    // Disable check button, show next.
    if (btn) btn.classList.add("hidden");
    const retry = $<HTMLButtonElement>("btn-retry-prereqs");
    if (retry) retry.classList.remove("hidden");

    // Auto-advance after a short delay.
    setTimeout(() => showStep(2), 800);
  } else {
    setStatus("1", "环境不满足要求，请安装后重试", "error");
    if (btn) btn.classList.add("hidden");
    const retry = $<HTMLButtonElement>("btn-retry-prereqs");
    if (retry) retry.classList.remove("hidden");
  }
}

// ---- Step 2: Work Directory ----------------------------------------

async function initStep2(): Promise<void> {
  try {
    state.destPath = await invoke<string>("default_engine_dest");
  } catch {
    state.destPath = "~/feclaw";
  }
  const input = $<HTMLInputElement>("dest-path");
  if (input) input.value = state.destPath;
}

// ---- Step 3: Clone & Configure -------------------------------------

function initStep3(): void {
  const pathEl = $("clone-path");
  if (pathEl) {
    pathEl.textContent = `目标路径：${state.destPath}/FeClaw`;
  }

  if (state.cloneDone) {
    const cloneBtn = $<HTMLButtonElement>("btn-clone");
    if (cloneBtn) {
      cloneBtn.disabled = true;
      cloneBtn.textContent = "✓ 已克隆";
    }
    const configCard = $("config-card");
    if (configCard) configCard.classList.remove("hidden");
    const nextBtn = $<HTMLButtonElement>("btn-next-3");
    if (nextBtn) nextBtn.classList.remove("hidden");
  }
}

async function cloneRepository(): Promise<void> {
  const btn = $<HTMLButtonElement>("btn-clone");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "正在克隆…";
    btn.classList.add("btn-spinner");
  }

  setStatus("3", "正在从 GitHub 克隆 FeClaw 仓库…", "info");
  const progressEl = $("clone-progress");
  if (progressEl) {
    progressEl.classList.remove("hidden");
    progressEl.textContent = "正在克隆 https://github.com/lizidaren/FeClaw.git …\n请耐心等待，这可能需要几分钟。";
  }

  try {
    await invoke("clone_feclaw", { dest: state.destPath });
    state.cloneDone = true;
    setStatus("3", "✓ 仓库克隆成功", "ok");

    if (btn) {
      btn.textContent = "✓ 已克隆";
      btn.classList.remove("btn-spinner");
    }
    if (progressEl) {
      progressEl.textContent += "\n✓ 克隆完成";
    }

    // Show config form.
    const configCard = $("config-card");
    if (configCard) configCard.classList.remove("hidden");
    const nextBtn = $<HTMLButtonElement>("btn-next-3");
    if (nextBtn) nextBtn.classList.remove("hidden");
  } catch (e) {
    const msg = typeof e === "string" ? e : "克隆失败";
    setStatus("3", msg, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "重试克隆";
      btn.classList.remove("btn-spinner");
    }
    if (progressEl) {
      progressEl.textContent += `\n❌ 错误：${msg}`;
    }
  }
}

function generateJwtSecret(): void {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  let secret = "";
  const arr = new Uint8Array(48);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 48; i++) {
    secret += chars[arr[i] % chars.length];
  }
  const input = $<HTMLInputElement>("jwt-secret");
  if (input) input.value = secret;
}

// ---- Step 4: Install & Start ---------------------------------------

async function installDependencies(): Promise<void> {
  const btn = $<HTMLButtonElement>("btn-install");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "正在安装…";
    btn.classList.add("btn-spinner");
  }

  const progressEl = $("install-progress");
  if (progressEl) {
    progressEl.classList.remove("hidden");
    progressEl.textContent = "正在运行 pip install …";
  }

  setStatus("4", "正在安装 Python 依赖…", "info");

  try {
    const output = await invoke<string>("install_dependencies", { dest: state.destPath });
    state.depSuccess = true;
    state.installDone = true;
    setStatus("4", "✓ 依赖安装完成", "ok");

    if (progressEl) progressEl.textContent = output;
    if (btn) {
      btn.textContent = "✓ 已安装";
      btn.classList.remove("btn-spinner");
    }

    // Show start button.
    const startBtn = $<HTMLButtonElement>("btn-start");
    if (startBtn) startBtn.classList.remove("hidden");
  } catch (e) {
    const msg = typeof e === "string" ? e : "安装失败";
    setStatus("4", msg, "error");
    if (progressEl) progressEl.textContent = msg;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "重试安装";
      btn.classList.remove("btn-spinner");
    }
  }
}

async function startEngine(): Promise<void> {
  const btn = $<HTMLButtonElement>("btn-start");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "正在启动…";
    btn.classList.add("btn-spinner");
  }

  // Read config inputs.
  const apiKey = $<HTMLInputElement>("api-key")?.value.trim() || "";
  const jwtSecret = $<HTMLInputElement>("jwt-secret")?.value.trim() || "auto";
  const pw = $<HTMLInputElement>("admin-password")?.value.trim() || "admin";
  state.adminPassword = pw;

  const portEl = $<HTMLInputElement>("engine-port");
  const port = portEl ? parseInt(portEl.value || "8080", 10) : 8080;
  if (isNaN(port) || port < 1024 || port > 65535) {
    setStatus("4", "端口号必须在 1024–65535 之间", "error");
    if (btn) { btn.disabled = false; btn.textContent = "启动引擎"; btn.classList.remove("btn-spinner"); }
    return;
  }
  state.enginePort = port;

  // Generate and write .env first.
  setStatus("4", "正在生成配置文件…", "info");
  try {
    const envContent = await invoke<string>("generate_env_template", {
      dest: state.destPath,
      apiKey,
      jwtSecret,
      adminPassword: pw,
    });
    await invoke("write_env_file", { dest: state.destPath, content: envContent });
  } catch (e) {
    const msg = typeof e === "string" ? e : "配置写入失败";
    setStatus("4", msg, "error");
    if (btn) { btn.disabled = false; btn.textContent = "启动引擎"; btn.classList.remove("btn-spinner"); }
    return;
  }

  // Start the engine.
  setStatus("4", "正在启动引擎…", "info");

  const startProgress = $("start-progress");
  if (startProgress) {
    startProgress.classList.remove("hidden");
    startProgress.textContent = `正在启动 uvicorn (端口 ${port})…`;
  }

  try {
    const password = await invoke<string>("start_feclaw", { dest: state.destPath, port });
    state.adminPassword = password;
    state.startDone = true;

    setStatus("4", "✓ 引擎已启动", "ok");

    // Show admin info.
    const infoEl = $("engine-info");
    if (infoEl) infoEl.classList.remove("hidden");
    const pwDisplay = $("admin-pw-display");
    if (pwDisplay) pwDisplay.textContent = password;
    const urlDisplay = $("engine-url-display");
    if (urlDisplay) urlDisplay.textContent = `http://127.0.0.1:${port}`;

    if (btn) {
      btn.textContent = "✓ 已启动";
      btn.classList.remove("btn-spinner");
    }
    if (startProgress) {
      startProgress.textContent += `\n✓ 引擎进程已启动\n管理员密码：${password}`;
    }

    // Show next button.
    const nextBtn = $<HTMLButtonElement>("btn-next-4");
    if (nextBtn) nextBtn.classList.remove("hidden");

    // Save config for next launch.
    try {
      await invoke("save_local_engine_config", {
        dest: state.destPath,
        port,
        adminPassword: password,
      });
    } catch { /* best-effort */ }
  } catch (e) {
    const msg = typeof e === "string" ? e : "启动失败";
    setStatus("4", msg, "error");
    if (startProgress) startProgress.textContent += `\n❌ 错误：${msg}`;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "重试启动";
      btn.classList.remove("btn-spinner");
    }
  }
}

// ---- Step 5: Connect -----------------------------------------------

function initStep5(): void {
  // Fill connection info.
  const infoEl = $("conn-info");
  if (infoEl) {
    infoEl.innerHTML = `
      <div class="info-row">
        <span class="info-label">引擎地址：</span>
        <code>http://127.0.0.1:${state.enginePort}</code>
      </div>
      <div class="info-row">
        <span class="info-label">管理员密码：</span>
        <code>${state.adminPassword}</code>
      </div>
      <div class="info-row">
        <span class="info-label">引擎目录：</span>
        <code>${state.destPath}/FeClaw</code>
      </div>
    `;
  }
}

async function connectEngine(): Promise<void> {
  const btn = $<HTMLButtonElement>("btn-connect");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "正在检测引擎状态…";
    btn.classList.add("btn-spinner");
  }

  setStatus("5", "正在检测引擎健康状态…", "info");

  try {
    const healthy = await invoke<boolean>("check_engine_health", { port: state.enginePort });
    if (healthy) {
      setStatus("5", "✓ 引擎运行正常，连接成功！", "ok");
      if (btn) {
        btn.textContent = "✓ 已连接";
        btn.classList.remove("btn-spinner");
      }
      // Close wizard after a moment and open chat.
      setTimeout(() => {
        invoke("open_chat_window").catch(() => {});
        window.close();
      }, 1200);
    } else {
      setStatus("5", "引擎似乎未响应，请检查端口和进程", "error");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "重试连接";
        btn.classList.remove("btn-spinner");
      }
    }
  } catch (e) {
    const msg = typeof e === "string" ? e : "检测失败";
    setStatus("5", msg, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "重试连接";
      btn.classList.remove("btn-spinner");
    }
  }
}

// ---- Wiring --------------------------------------------------------

function wire(): void {
  // Step 1 buttons.
  $("btn-check-prereqs")?.addEventListener("click", () => void checkPrerequisites());
  $("btn-retry-prereqs")?.addEventListener("click", () => void checkPrerequisites());

  // Step 2 buttons.
  $("btn-next-2")?.addEventListener("click", () => {
    const input = $<HTMLInputElement>("dest-path");
    state.destPath = input?.value.trim() || "~/feclaw";
    showStep(3);
    initStep3();
  });
  $("btn-back-2")?.addEventListener("click", () => showStep(1));

  // Step 3 buttons.
  $("btn-clone")?.addEventListener("click", () => void cloneRepository());
  $("btn-gen-jwt")?.addEventListener("click", () => generateJwtSecret());
  $("btn-next-3")?.addEventListener("click", () => showStep(4));
  $("btn-back-3")?.addEventListener("click", () => showStep(2));

  // Step 4 buttons.
  $("btn-install")?.addEventListener("click", () => void installDependencies());
  $("btn-start")?.addEventListener("click", () => void startEngine());
  $("btn-next-4")?.addEventListener("click", () => {
    showStep(5);
    initStep5();
  });
  $("btn-back-4")?.addEventListener("click", () => showStep(3));

  // Step 5 buttons.
  $("btn-connect")?.addEventListener("click", () => void connectEngine());
  $("btn-back-5")?.addEventListener("click", () => showStep(4));

  // Auto-run step 1 check on load.
  setTimeout(() => {
    void checkPrerequisites();
  }, 300);
}

document.addEventListener("DOMContentLoaded", () => {
  // Initialize default dest path.
  invoke<string>("default_engine_dest")
    .then((dest) => {
      state.destPath = dest;
      const input = $<HTMLInputElement>("dest-path");
      if (input) input.value = dest;
    })
    .catch(() => {});

  wire();
});
