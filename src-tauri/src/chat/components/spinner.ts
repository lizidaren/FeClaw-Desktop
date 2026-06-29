// =========================================================
// FeClaw Desktop — Spinner wrapper (Phase 1 / 5.2 B)
// =========================================================
//
// `withSpinner<T>(fn)` shows a small overlay spinner at the centre of
// the viewport while `fn()` is in flight, but only if the operation
// takes longer than `DEBOUNCE_MS` (default 200). Sub-200ms tasks feel
// instant, so flashing a spinner for them would be visual noise.
//
// Public API:
//   - withSpinner<T>(fn: () => Promise<T>, opts?: { debounceMs?: number })
//       Returns the promise from `fn()`. Spinner is shown after debounce.
//   - showSpinner() / hideSpinner()
//       For long-running flows where the wrapping promise isn't handy.
//   - spinnerEl(): HTMLDivElement (lazy-injected singleton, for callers
//       that need to append more UI into the same surface).
//
// Usage:
//   await withSpinner(async () => {
//     const data = await fetchSomeHeavyThing();
//     render(data);
//   });

const DEBOUNCE_MS = 200;

let host: HTMLDivElement | null = null;
let showTimer: number | null = null;

function ensureHost(): HTMLDivElement {
  if (host && document.body.contains(host)) return host;
  const el = document.createElement("div");
  el.id = "app-spinner-host";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `
    <div class="spinner-card">
      <div class="spinner-ring" aria-hidden="true"></div>
      <div class="spinner-text">加载中…</div>
    </div>
  `;
  document.body.appendChild(el);
  host = el;
  return el;
}

function showImmediately(): void {
  const el = ensureHost();
  el.classList.add("spinner-show");
  el.setAttribute("aria-hidden", "false");
}

function hideImmediately(): void {
  if (!host) return;
  host.classList.remove("spinner-show");
  host.setAttribute("aria-hidden", "true");
}

export function showSpinner(): void {
  if (showTimer !== null) {
    window.clearTimeout(showTimer);
    showTimer = null;
  }
  showImmediately();
}

export function hideSpinner(): void {
  if (showTimer !== null) {
    window.clearTimeout(showTimer);
    showTimer = null;
    return;
  }
  hideImmediately();
}

/**
 * Wrap an async operation with a debounced spinner.
 *
 * If `fn()` settles before `debounceMs` elapses, the spinner never
 * appears. If it takes longer, the spinner is shown and removed when
 * the promise resolves or rejects.
 */
export async function withSpinner<T>(
  fn: () => Promise<T>,
  opts: { debounceMs?: number } = {},
): Promise<T> {
  const delay = opts.debounceMs ?? DEBOUNCE_MS;
  showTimer = window.setTimeout(() => {
    showTimer = null;
    showImmediately();
  }, delay);
  try {
    return await fn();
  } finally {
    hideSpinner();
  }
}

export function spinnerEl(): HTMLDivElement {
  return ensureHost();
}
