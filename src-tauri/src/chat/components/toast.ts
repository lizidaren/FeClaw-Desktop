// =========================================================
// FeClaw Desktop — Global toast (Phase 1 / 5.1 A)
// =========================================================
//
// Lightweight, dependency-free snackbar:
//   - A single container is injected into <body> on first call.
//   - Toasts stack vertically; multiple in quick succession queue up.
//   - Each toast auto-dismisses after `duration` ms (default 3500).
//   - `kind` toggles a class for colour (info / success / error).
//
// Public API:
//   showToast({ text, kind?, duration? })
//
// Use this anywhere you'd previously log to console; the user will
// actually see it. Settings page has its own toast (DOM element #toast)
// because it has different layout; this is the chat / app shell one.

type ToastKind = "info" | "success" | "error";

interface ToastOptions {
  text: string;
  kind?: ToastKind;
  /** Auto-dismiss after this many ms. Default 3500. Pass 0 to disable. */
  duration?: number;
}

const DEFAULT_DURATION = 3500;
const MAX_VISIBLE = 5;

let container: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (container && document.body.contains(container)) return container;
  const el = document.createElement("div");
  el.id = "global-toast-container";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  document.body.appendChild(el);
  container = el;
  return el;
}

export function showToast(opts: ToastOptions): void {
  const text = (opts.text ?? "").trim();
  if (!text) return;
  const kind: ToastKind = opts.kind ?? "info";
  const duration = opts.duration ?? DEFAULT_DURATION;

  const root = ensureContainer();

  // Trim oldest toasts if too many pile up.
  while (root.children.length >= MAX_VISIBLE) {
    root.firstElementChild?.remove();
  }

  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = text;
  // Click to dismiss early.
  el.addEventListener("click", () => dismiss());
  root.appendChild(el);

  // Animate in next frame.
  requestAnimationFrame(() => el.classList.add("toast-show"));

  let timer: number | undefined;
  const dismiss = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    el.classList.remove("toast-show");
    el.classList.add("toast-leave");
    // Remove from DOM after the leave transition.
    window.setTimeout(() => el.remove(), 200);
  };

  if (duration > 0) {
    timer = window.setTimeout(dismiss, duration);
  }
}
