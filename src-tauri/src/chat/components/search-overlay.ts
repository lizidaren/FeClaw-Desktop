// =========================================================
// FeClaw Desktop — Search Overlay (Phase 7)
// =========================================================
//
// Listens for "toggle-search-overlay" from the Alt+Space
// global shortcut (via Tauri event). Renders a floating
// search panel with cloud results grouped by source.
//
// Navigation: clicking a result fires a CustomEvent so
// chat.ts can switch to the appropriate component.

import { type ChatMessage } from "../store";

// ---- Types --------------------------------------------------------

export interface SearchItem {
  id: string;
  agentHash?: string;
  agentName?: string;
  snippet: string;
  score: number;
  timestamp: number;
  source: string;
  reference?: string;
}

export interface SourceResults {
  status: string;
  items: SearchItem[];
}

export interface SearchResult {
  query: string;
  results: Record<string, SourceResults>;
  elapsed_ms: number;
}

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

// ---- DOM helpers -------------------------------------------------

function $<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ---- State -------------------------------------------------------

let isOpen = false;
let currentQuery = "";
let activeSource = "all";
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// ---- Show / Hide -------------------------------------------------

function showOverlay(): void {
  const overlay = $<HTMLDivElement>("search-overlay");
  const input = $<HTMLInputElement>("search-input");
  if (!overlay) return;
  overlay.style.display = "";
  overlay.style.opacity = "0";
  requestAnimationFrame(() => {
    overlay.style.transition = "opacity 0.15s ease";
    overlay.style.opacity = "1";
  });
  isOpen = true;
  input?.focus();
}

function hideOverlay(): void {
  const overlay = $<HTMLDivElement>("search-overlay");
  if (!overlay) return;
  overlay.style.opacity = "0";
  setTimeout(() => {
    overlay.style.display = "none";
    overlay.style.transition = "";
  }, 150);
  isOpen = false;
  // Clear input
  const input = $<HTMLInputElement>("search-input");
  if (input) input.value = "";
  clearResults();
  currentQuery = "";
}

function toggleOverlay(): void {
  if (isOpen) hideOverlay();
  else showOverlay();
}

// ---- Results rendering -------------------------------------------

function clearResults(): void {
  const results = $<HTMLDivElement>("search-results");
  const footer = $<HTMLDivElement>("search-footer");
  const empty = $<HTMLDivElement>("search-empty");
  if (!results) return;
  results.innerHTML = "";
  if (empty) {
    results.appendChild(empty);
    empty.style.display = "";
  }
  if (footer) footer.style.display = "none";
}

function formatTime(ts: number): string {
  if (!ts) return "";
  const ms = ts < 4102444800 ? ts * 1000 : ts;
  const d = new Date(ms);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}天前`;
  return d.toLocaleDateString("zh-CN");
}

function sourceIcon(source: string): string {
  switch (source) {
    case "chat": return "💬";
    case "vfs": return "📁";
    case "moments": return "📱";
    case "textbook": return "📖";
    case "miniapps": return "🚀";
    default: return "📄";
  }
}

function renderResults(result: SearchResult): void {
  const resultsEl = $<HTMLDivElement>("search-results");
  const footer = $<HTMLDivElement>("search-footer");
  const stats = $<HTMLSpanElement>("search-stats");
  if (!resultsEl) return;

  resultsEl.innerHTML = "";

  // Count items by source
  const allItems: SearchItem[] = [];
  const bySource: Record<string, SearchItem[]> = {};

  for (const [src, srcResults] of Object.entries(result.results)) {
    if (srcResults.status !== "ok") continue;
    bySource[src] = srcResults.items;
    allItems.push(...srcResults.items);
  }

  const items = activeSource === "all" ? allItems : (bySource[activeSource] ?? []);

  if (items.length === 0) {
    resultsEl.innerHTML = `<div class="search-empty"><span>未找到相关结果</span></div>`;
    if (footer) footer.style.display = "none";
    return;
  }

  // Sort by score descending
  items.sort((a, b) => b.score - a.score);

  // Render each item
  for (const item of items) {
    const el = document.createElement("div");
    el.className = "search-result-item";

    const icon = sourceIcon(item.source);
    const time = formatTime(item.timestamp);
    const agentLabel = item.agentName ? `${item.agentName} · ` : (item.agentHash ? "未知 · " : "");
    const scoreStr = item.score > 0 ? `<span class="sr-score">匹配度: ${(item.score * 100).toFixed(0)}%</span>` : "";

    el.innerHTML = `
      <div class="sr-icon">${icon}</div>
      <div class="sr-body">
        <div class="sr-meta">${agentLabel}${time}</div>
        <div class="sr-snippet">${escapeHtml(item.snippet)}</div>
        ${scoreStr}
      </div>
    `;

    el.addEventListener("click", () => {
      navigateToResult(item);
      hideOverlay();
    });

    resultsEl.appendChild(el);
  }

  // Update tab counts
  updateTabCounts(bySource);

  // Footer stats
  if (footer && stats) {
    const totalCount = allItems.length;
    footer.style.display = "";
    stats.textContent = `共 ${totalCount} 个结果 · ${(result.elapsed_ms / 1000).toFixed(2)}s`;
  }
}

function renderOfflineResults(items: SearchItem[]): void {
  const resultsEl = $<HTMLDivElement>("search-results");
  const footer = $<HTMLDivElement>("search-footer");
  const stats = $<HTMLSpanElement>("search-stats");
  if (!resultsEl) return;

  resultsEl.innerHTML = "";

  const filtered = activeSource === "all" || activeSource === "chat"
    ? items
    : items.filter(i => i.source === activeSource);

  if (filtered.length === 0) {
    resultsEl.innerHTML = `<div class="search-empty"><span>本地未找到相关结果</span></div>`;
    if (footer) footer.style.display = "none";
    return;
  }

  for (const item of filtered) {
    const el = document.createElement("div");
    el.className = "search-result-item";
    const time = formatTime(item.timestamp);
    const scoreStr = item.score > 0 ? `<span class="sr-score">匹配度: ${(item.score * 100).toFixed(0)}%</span>` : "";
    el.innerHTML = `
      <div class="sr-icon">💬</div>
      <div class="sr-body">
        <div class="sr-meta">${item.agentName ?? "聊天"} · ${time}</div>
        <div class="sr-snippet">${escapeHtml(item.snippet)}</div>
        ${scoreStr}
      </div>
    `;
    el.addEventListener("click", () => {
      navigateToResult(item);
      hideOverlay();
    });
    resultsEl.appendChild(el);
  }

  if (footer && stats) {
    footer.style.display = "";
    stats.textContent = `本地搜索: ${filtered.length} 个结果 · 离线模式`;
  }
}

function updateTabCounts(bySource: Record<string, SearchItem[]>): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".search-tab");
  tabs.forEach(tab => {
    const src = tab.dataset.source ?? "all";
    let count = 0;
    if (src === "all") {
      count = Object.values(bySource).reduce((s, arr) => s + arr.length, 0);
    } else {
      count = bySource[src]?.length ?? 0;
    }
    // Show count in the tab if > 0
    const label = tab.textContent?.replace(/ \(\d+\)/, "") ?? "";
    tab.textContent = count > 0 ? `${label} (${count})` : label;
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- Navigation --------------------------------------------------

function navigateToResult(item: SearchItem): void {
  if (item.source === "chat" || item.source === "vfs" || item.source === "moments") {
    const detail: NavigateChatDetail = {
      agentHash: item.agentHash ?? "",
      messageId: item.id,
    };
    window.dispatchEvent(new CustomEvent("navigate-to-chat", { detail }));
  } else if (item.reference) {
    // Generic reference navigation
    const detail = { reference: item.reference };
    window.dispatchEvent(new CustomEvent("navigate-to-reference", { detail }));
  }
}

interface NavigateChatDetail {
  agentHash: string;
  messageId?: string;
}

// ---- Search logic -------------------------------------------------

async function doSearch(query: string): Promise<void> {
  if (!query.trim()) {
    clearResults();
    return;
  }

  try {
    const result = await invoke<SearchResult>("search_all", { query });
    renderResults(result);
  } catch (e) {
    console.warn("search_all failed (offline?):", e);
    // Fallback to local search
    try {
      const localItems = await invoke<SearchItem[]>("search_local_chat", { query });
      renderOfflineResults(localItems);
    } catch (e2) {
      console.error("search_local_chat also failed:", e2);
    }
  }
}

// ---- Event handlers ----------------------------------------------

function onInput(e: Event): void {
  const input = e.target as HTMLInputElement;
  currentQuery = input.value;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void doSearch(currentQuery);
  }, 300);
}

function onTabClick(e: Event): void {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".search-tab");
  if (!btn) return;
  const src = btn.dataset.source ?? "all";
  activeSource = src;
  document.querySelectorAll<HTMLElement>(".search-tab").forEach(t => t.classList.remove("active"));
  btn.classList.add("active");
  if (currentQuery) {
    void doSearch(currentQuery);
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    hideOverlay();
  } else if (e.key === "Enter" && currentQuery) {
    if (debounceTimer) clearTimeout(debounceTimer);
    void doSearch(currentQuery);
  }
}

function onBackdropClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) {
    hideOverlay();
  }
}

// ---- Init ---------------------------------------------------------

export async function setupSearchOverlay(): Promise<void> {
  // Listen for Alt+Space toggle event from Tauri
  try {
    await listen<void>("toggle-search-overlay", () => {
      toggleOverlay();
    });
  } catch (e) {
    console.error("listen toggle-search-overlay:", e);
  }

  // Input handler
  const input = $<HTMLInputElement>("search-input");
  if (input) {
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKeyDown);
  }

  // Tab handlers
  const tabsEl = $<HTMLDivElement>("search-tabs");
  if (tabsEl) {
    tabsEl.addEventListener("click", onTabClick);
  }

  // Close button
  const closeBtn = $<HTMLButtonElement>("search-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", hideOverlay);
  }

  // Backdrop click
  const backdrop = $<HTMLDivElement>("search-backdrop");
  if (backdrop) {
    backdrop.addEventListener("click", onBackdropClick);
  }

  // ESC key on document (when overlay is open)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) {
      hideOverlay();
    }
    // Alt+Space again closes
    if (e.key === " " && e.altKey && isOpen) {
      e.preventDefault();
      hideOverlay();
    }
  });
}
