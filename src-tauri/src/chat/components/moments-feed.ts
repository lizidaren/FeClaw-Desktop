// =========================================================
// FeClaw Desktop — Moments Feed UI (Phase 5 V3)
// =========================================================
//
// Renders the 📱 广场 (Moments) tab content:
//   - Group filter dropdown
//   - List of moment cards from all groups (or filtered)
//   - Real-time updates via WS moments_event
//
// Public API:
//   showMomentsFeed(groupId?: string) — show the feed, optionally filtered
//   hideMomentsFeed() — hide the feed
//   refreshMoments() — reload moments from Rust

import { store, type MomentInfo, type Attachment } from "../store";

// ---- Tauri bridge ------------------------------------------------

type TauriCore = {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
};

function getTauri(): TauriCore {
  const g = (window as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__;
  if (!g?.core) throw new Error("Tauri global not available");
  return g.core;
}

const invoke = <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  getTauri().invoke<T>(cmd, args);

// ---- Kind icons --------------------------------------------------

const KIND_ICONS: Record<string, string> = {
  task_done: "✅",
  file_changed: "📁",
  analysis: "🔍",
  consensus: "🤝",
  manual: "✍️",
  default: "📌",
};

function getKindIcon(kind: string): string {
  return KIND_ICONS[kind] ?? KIND_ICONS["default"];
}

// ---- Time formatting ---------------------------------------------

function formatRelativeTime(ts: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - ts;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}天前`;
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ---- Attachment chip rendering -----------------------------------

function renderAttachmentChip(
  container: HTMLElement,
  att: Attachment
): void {
  if (att.type === "file") {
    const chip = document.createElement("span");
    chip.className = "moment-attachment-chip";
    chip.innerHTML = `<span class="mac-icon">📄</span><span class="mac-name">${escapeHtml(att.name)}</span>`;
    chip.addEventListener("click", () => {
      if (att.url) {
        window.open(att.url, "_blank");
      } else if (att.path && store.activeAgentHash) {
        void invoke("download_vfs_file", {
          agent_hash: store.activeAgentHash,
          path: att.path,
        }).then((localPath) => {
          if (localPath) {
            const a = document.createElement("a");
            a.href = `file://${localPath}`;
            a.download = att.name;
            a.click();
          }
        });
      }
    });
    container.appendChild(chip);
  } else if (att.type === "image") {
    const chip = document.createElement("span");
    chip.className = "moment-attachment-chip";
    // Only pass through to window.open if the src uses a safe scheme.
    // Rejects javascript:, data:image/svg+xml, and anything else that
    // could be interpreted as a navigable URL with side effects.
    let src = "";
    if (att.source === "data" && att.data && isSafeAttachmentSrc(att.data)) {
      src = att.data;
    } else if (att.source === "url" && att.url && isSafeAttachmentSrc(att.url)) {
      src = att.url;
    }
    chip.innerHTML = `<span class="mac-icon">🖼️</span><span class="mac-name">${escapeHtml(att.name ?? "图片")}</span>`;
    chip.addEventListener("click", () => {
      if (src) window.open(src, "_blank");
    });
    container.appendChild(chip);
  }
}

// ---- Safe attachment URL check -----------------------------------

// Only allow schemes that are safe to pass to window.open / <img src>.
// Excludes javascript:, data:image/svg+xml, file:, blob: with mismatched
// types, etc. https/http/data:image(png|jpeg|gif|webp) only.
const SAFE_URL_PREFIX_RE = /^(https:\/\/|http:\/\/|data:image\/(png|jpe?g|gif|webp);base64,)/i;

function isSafeAttachmentSrc(url: string): boolean {
  return SAFE_URL_PREFIX_RE.test(url.trim());
}

// ---- HTML escape --------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- Single moment card -----------------------------------------

function buildMomentCard(moment: MomentInfo): HTMLElement {
  const card = document.createElement("div");
  card.className = "moment-card";
  card.dataset.momentId = moment.id;
  card.dataset.groupId = moment.group_id;

  const kindIcon = getKindIcon(moment.kind);
  const time = formatRelativeTime(moment.created_at);
  const agentLabel = moment.agent_name ?? "Agent";
  const groupLabel = moment.group_name ?? "未知群";
  const contentSnippet =
    moment.content.length > 120
      ? moment.content.slice(0, 120) + "…"
      : moment.content;

  card.innerHTML = `
    <div class="mc-header">
      <span class="mc-kind-icon">${kindIcon}</span>
      <span class="mc-group-name">${escapeHtml(groupLabel)}</span>
    </div>
    <div class="mc-meta">
      <span class="mc-agent">${escapeHtml(agentLabel)}</span>
      <span class="mc-dot">·</span>
      <span class="mc-time">${time}</span>
    </div>
    <div class="mc-title">${escapeHtml(moment.title)}</div>
    <div class="mc-content">${escapeHtml(contentSnippet)}</div>
    <div class="mc-attachments" id="mc-attachments-${moment.id}"></div>
  `;

  // Render attachment chips
  const attContainer = card.querySelector(
    `#mc-attachments-${moment.id}`
  ) as HTMLElement | null;
  if (attContainer && moment.attachments && moment.attachments.length > 0) {
    for (const att of moment.attachments) {
      renderAttachmentChip(attContainer, att as Attachment);
    }
  }

  // Click group name → navigate to group chat
  const groupNameEl = card.querySelector(".mc-group-name") as HTMLElement | null;
  if (groupNameEl) {
    groupNameEl.style.cursor = "pointer";
    groupNameEl.addEventListener("click", () => {
      // Dispatch event to chat.ts to switch to group chat
      window.dispatchEvent(
        new CustomEvent("group-selected", {
          detail: { groupId: moment.group_id },
        })
      );
    });
  }

  return card;
}

// ---- Feed rendering ----------------------------------------------

function renderMomentsFeed(moments: MomentInfo[]): void {
  const list = document.getElementById("moments-list");
  const empty = document.getElementById("moments-empty");
  if (!list || !empty) return;

  if (moments.length === 0) {
    list.innerHTML = "";
    list.appendChild(empty);
    empty.style.display = "";
    return;
  }

  empty.style.display = "none";
  list.innerHTML = "";

  for (const moment of moments) {
    const card = buildMomentCard(moment);
    list.appendChild(card);
  }
}

// ---- Filter dropdown ---------------------------------------------

function populateGroupFilter(): void {
  const select = document.getElementById(
    "moments-group-filter"
  ) as HTMLSelectElement | null;
  if (!select) return;

  const groups = store.groups;
  // Remember current value
  const current = select.value;

  select.innerHTML = `<option value="">全部群</option>`;
  for (const g of groups) {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = g.name;
    select.appendChild(opt);
  }

  // Restore selection if still valid
  if (current && [...select.options].some((o) => o.value === current)) {
    select.value = current;
  }
}

// ---- Load moments from Rust --------------------------------------

export async function refreshMoments(): Promise<void> {
  try {
    const filter = store.momentsGroupFilter;
    const moments = await invoke<MomentInfo[]>("get_moments", {
      groupId: filter,
    });
    store.setMoments(moments);
  } catch (e) {
    console.error("get_moments failed:", e);
  }
}

// ---- Show / hide feed --------------------------------------------

export function showMomentsFeed(groupId?: string): void {
  const chatList = document.getElementById("chat-list-panel");
  const momentsFeed = document.getElementById("moments-feed");
  if (!chatList || !momentsFeed) return;

  // Apply group filter if provided
  if (groupId) {
    store.setMomentsGroupFilter(groupId);
  } else {
    store.setMomentsGroupFilter(null);
  }

  // Populate group filter dropdown
  populateGroupFilter();

  // Show moments, hide chat list
  chatList.style.display = "none";
  momentsFeed.style.display = "flex";
  momentsFeed.style.flexDirection = "column";
  momentsFeed.style.flex = "1";
  momentsFeed.style.overflow = "hidden";

  // Render feed
  renderMomentsFeed(store.getMoments());

  // Load fresh data
  void refreshMoments();
}

export function hideMomentsFeed(): void {
  const chatList = document.getElementById("chat-list-panel");
  const momentsFeed = document.getElementById("moments-feed");
  if (!chatList || !momentsFeed) return;

  chatList.style.display = "";
  momentsFeed.style.display = "none";
}

// ---- Add single moment (from WS push) ---------------------------

export function addMomentCard(moment: MomentInfo): void {
  const list = document.getElementById("moments-list");
  const empty = document.getElementById("moments-empty");
  if (!list || !empty) return;

  // Hide empty state
  empty.style.display = "none";

  // Add card at top
  const card = buildMomentCard(moment);
  if (list.firstChild) {
    list.insertBefore(card, list.firstChild);
  } else {
    list.appendChild(card);
  }

  // Show toast notification if not on moments tab
  if (store.currentTab !== "moments") {
    showMomentToast(moment);
  }
}

// ---- Toast notification ------------------------------------------

let toastTimeout: ReturnType<typeof setTimeout> | null = null;

function showMomentToast(moment: MomentInfo): void {
  const toast = document.getElementById("moments-toast");
  if (toast) {
    toast.textContent = `📱 新动态: ${moment.title}`;
    toast.style.opacity = "1";
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.style.opacity = "0";
    }, 3000);
  }
}

// ---- Wire filter dropdown ---------------------------------------

export function wireMomentsFeed(): void {
  const select = document.getElementById(
    "moments-group-filter"
  ) as HTMLSelectElement | null;
  if (!select) return;

  select.addEventListener("change", () => {
    const value = select.value || null;
    store.setMomentsGroupFilter(value);
    void refreshMoments();
  });
}

// ---- Store subscription: re-render on moments change -------------

store.subscribe((s) => {
  if (s.currentTab !== "moments") return;
  const momentsFeed = document.getElementById("moments-feed");
  if (momentsFeed && momentsFeed.style.display !== "none") {
    renderMomentsFeed(s.getMoments());
  }
});
