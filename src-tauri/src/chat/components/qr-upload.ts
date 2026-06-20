// =========================================================
// FeClaw Desktop — QR Upload Dialog (Phase 8)
// =========================================================
//
// Flow:
//   1. User clicks 📱 in input box → openQrUploadDialog()
//   2. create_upload_session → gets presigned URL + session_id
//   3. Generate QR code (base64 PNG) for upload.html URL
//   4. Display QR in dialog
//   5. Phone scans → uploads photo → server sends upload_complete WS event
//   6. Desktop downloads image via presigned_get_url
//   7. Image appears in input as image card (reuses existing ImageCard flow)

import type { ImageCard } from "./input-box";

// ---- Tauri bridge -------------------------------------------------

type TauriCore = {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (e: { payload: T }) => void): Promise<() => void>;
};

function getTauri(): TauriCore {
  const g = (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__;
  if (!g?.core) throw new Error("Tauri global not available");
  return g.core;
}

const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  getTauri().invoke<T>(cmd, args);

const listen = <T>(event: string, handler: (e: { payload: T }) => void) =>
  getTauri().listen<T>(event, handler);

// ---- Types ---------------------------------------------------------

type UploadSession = {
  session_id: string;
  presigned_url: string;
  presigned_get_url: string;
  expires_in: number;
};

type UploadCompletePayload = {
  session_id: string;
  presigned_get_url: string;
  file_name?: string;
  mime_type?: string;
};

// ---- State ---------------------------------------------------------

let dialogOpen = false;
let currentSessionId: string | null = null;
let unlistenUploadComplete: (() => void) | null = null;

// ---- Dialog --------------------------------------------------------

export function openQrUploadDialog(): void {
  if (dialogOpen) return;
  dialogOpen = true;
  void showQrDialog();
}

async function showQrDialog(): Promise<void> {
  // Remove any existing dialog
  document.getElementById("qr-upload-overlay")?.remove();

  // Create upload session
  let session: UploadSession;
  try {
    session = await invoke<UploadSession>("create_upload_session");
  } catch (e) {
    console.error("create_upload_session failed:", e);
    showToast("创建上传会话失败：" + String(e));
    dialogOpen = false;
    return;
  }

  currentSessionId = session.session_id;

  // Build upload URL with params
  // Expected format: {engine_url}/static/upload.html?url={presigned_url}&sid={session_id}
  // The phone will POST directly to presigned_url after scanning
  const uploadPageUrl = buildUploadPageUrl(session);

  // Generate QR code
  let qrDataUrl: string;
  try {
    qrDataUrl = await invoke<string>("generate_qr_code", { data: uploadPageUrl });
  } catch (e) {
    console.error("generate_qr_code failed:", e);
    showToast("生成二维码失败：" + String(e));
    dialogOpen = false;
    return;
  }

  // Build dialog HTML
  const overlay = document.createElement("div");
  overlay.id = "qr-upload-overlay";
  overlay.className = "qr-upload-overlay";
  overlay.innerHTML = `
    <div class="qr-upload-dialog">
      <div class="qud-header">
        <span class="qud-title">📱 扫码上传</span>
        <button class="qud-close" id="qud-close-btn" aria-label="关闭">✕</button>
      </div>
      <div class="qud-body">
        <div class="qud-qr-container">
          <img id="qud-qr-img" src="${qrDataUrl}" alt="QR Code" class="qud-qr" />
        </div>
        <p class="qud-hint">打开手机相机扫码上传文件</p>
        <p class="qud-session" id="qud-session-info">会话: ${session.session_id}</p>
      </div>
      <div class="qud-footer">
        <button class="qud-btn qud-btn-cancel" id="qud-cancel-btn">取消</button>
        <button class="qud-btn qud-btn-confirm" id="qud-confirm-btn">我已上传</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Wire close button
  overlay.querySelector("#qud-close-btn")?.addEventListener("click", closeQrDialog);
  overlay.querySelector("#qud-cancel-btn")?.addEventListener("click", closeQrDialog);
  overlay.querySelector("#qud-confirm-btn")?.addEventListener("click", () => {
    void handleManualConfirm();
  });

  // Close on backdrop click
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeQrDialog();
  });

  // Listen for upload_complete WS event
  await subscribeUploadComplete(session.session_id);
}

function buildUploadPageUrl(session: UploadSession): string {
  // The upload page is served at /static/upload.html on the engine
  // We construct the URL with encoded params
  const base = session.presigned_url;
  // If presigned_url already has params, append; otherwise add ?
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}sid=${encodeURIComponent(session.session_id)}`;
}

async function subscribeUploadComplete(sessionId: string): Promise<void> {
  // Close any previous listener
  if (unlistenUploadComplete) {
    unlistenUploadComplete();
    unlistenUploadComplete = null;
  }

  try {
    unlistenUploadComplete = await listen<UploadCompletePayload>("upload-complete", (e) => {
      const payload = e.payload;
      if (!payload || payload.session_id !== sessionId) return;

      // This is our session — process the upload
      void handleUploadComplete(payload);
    });
  } catch (e) {
    console.error("listen upload-complete failed:", e);
  }
}

async function handleUploadComplete(payload: UploadCompletePayload): Promise<void> {
  // Download the uploaded image
  let dataUrl: string;
  try {
    dataUrl = await invoke<string>("download_uploaded_file", { url: payload.presigned_get_url });
  } catch (e) {
    console.error("download_uploaded_file failed:", e);
    showToast("下载图片失败：" + String(e));
    return;
  }

  // Add as image card to input (reuse existing input-box logic)
  await addQrImageCard(dataUrl, payload.file_name);

  // Close dialog
  closeQrDialog();

  showToast("图片已添加，点击发送");
}

async function handleManualConfirm(): Promise<void> {
  // Manual trigger: user claims they've uploaded
  // Try to poll or just show waiting state
  if (!currentSessionId) return;

  showToast("正在检查上传状态…");
  // The WS event will fire when upload completes
  // For manual fallback, close the dialog after a delay
  setTimeout(() => {
    closeQrDialog();
  }, 3000);
}

function closeQrDialog(): void {
  dialogOpen = false;
  currentSessionId = null;
  if (unlistenUploadComplete) {
    unlistenUploadComplete();
    unlistenUploadComplete = null;
  }
  document.getElementById("qr-upload-overlay")?.remove();
}

// ---- Add QR image to input box ------------------------------------

async function addQrImageCard(dataUrl: string, fileName?: string): Promise<void> {
  // Reuse the existing input-box image card injection approach
  // We dynamically call into input-box's addImageCard
  try {
    const { addImageCard } = await import("./input-box");

    const name = fileName ?? `扫码图片_${Date.now()}.jpg`;
    const card: ImageCard = {
      id: `qr-img-${Date.now()}`,
      temp_path: "",
      name,
      size_bytes: 0,
      data_url: dataUrl,
    };

    addImageCard(card);
  } catch (e) {
    console.error("addQrImageCard failed:", e);
  }
}

// ---- Toast helper --------------------------------------------------

function showToast(message: string): void {
  const existing = document.getElementById("qud-toast");
  existing?.remove();

  const toast = document.createElement("div");
  toast.id = "qud-toast";
  toast.className = "qud-toast";
  toast.textContent = message;
  document.body.appendChild(toast);

  // Injected styles if not present
  injectToastStyles();

  setTimeout(() => toast.remove(), 3000);
}

function injectToastStyles(): void {
  if (document.getElementById("qud-toast-styles")) return;
  const style = document.createElement("style");
  style.id = "qud-toast-styles";
  style.textContent = `
    .qud-toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-elev);
      border: 1px solid var(--primary);
      color: var(--text);
      padding: 10px 20px;
      border-radius: 24px;
      font-size: 14px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
      z-index: 99999;
      animation: qudToastIn 0.2s ease-out;
    }
    @keyframes qudToastIn {
      from { opacity: 0; transform: translateX(-50%) translateY(8px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
  `;
  document.head.appendChild(style);
}
