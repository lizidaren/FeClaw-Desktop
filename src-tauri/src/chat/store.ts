// =========================================================
// FeClaw Desktop — Chat state management (Phase 0a V3)
// =========================================================
//
// Central state store for the three-panel IM UI.
// Keeps the current tab, active chat, message list,
// permissions, and agent list.
//
// The compiled bundle is store.js (built with esbuild).

// ---- Types ----------------------------------------------------

export type TabId = "chat" | "moments" | "settings" | "fehub";

export type AgentInfo = {
  hash: string;
  name: string;
  description?: string;
  avatar_url?: string;
  permission_mode?: string;
  is_online: boolean;
};

export type UserPermissions = {
  user_id?: string;
  username?: string;
  is_admin: boolean;
  agent_permissions: Array<{ agent_hash: string; permission_mode: string }>;
};

export type ChatMessage = {
  id: string;
  channel: string;
  agent_hash?: string;
  role: "user" | "assistant" | string;
  content: string;
  message_type?: string;
  created_at: number;
  synced?: boolean;
  /** Last send error, if any. The UI uses this to render a retry button. */
  error?: string;
  is_deleted?: boolean;
  timestamp?: string;
  agent?: string;
  /** Mentioned agent hashes captured at send time. Persisted on the
   *  message so retries can re-submit the same mention list even after
   *  `pendingMentions` has been cleared. */
  mentions?: string[];
  attachments?: Attachment[];
};

export type Attachment =
  | { type: "image"; source: "vfs" | "url" | "data"; path?: string; url?: string; data?: string; width?: number; height?: number }
  | { type: "file"; name: string; size: number; path?: string; url?: string }
  | { type: "miniapp_card"; title: string; app_name: string; preview_url?: string; path?: string };

export type ChatItem = {
  agent_hash: string;
  name: string;
  avatar_letter: string;
  avatar_url?: string | null;
  last_message: string;
  last_time: string;
  unread: boolean;
  active?: boolean;
  // Group chat support
  is_group?: boolean;
  group_id?: string;
  // Per-agent chrome (Phase 5 / 7.2 A — pin / dnd / online icons)
  is_pinned?: boolean;
  is_dnd?: boolean;
  is_online?: boolean;
  status?: "active" | "pending" | "offline" | string;
};

export type GroupInfo = {
  id: string;
  name: string;
  announcement: string;
  memberCount: number;
  createdAt: number;
  // client-only fields
  unreadCount: number;
  lastMessage?: string;
  // Cached group members (for @-mention picker). Populated when
  // the group is opened or when list_group_members returns.
  members?: GroupMember[];
};

export type GroupMember = {
  agent_hash: string;
  agent_name: string;
  role?: string;
};

export type GroupMessage = {
  id: string;
  group_id: string;
  sender_type: "user" | "agent";
  sender_hash?: string;
  sender_name?: string;
  content: string;
  message_type: string;
  attachments?: Attachment[];
  created_at: number;
  timestamp?: string;
};

export type MomentInfo = {
  id: string;
  group_id: string;
  group_name?: string;
  agent_hash?: string;
  agent_name?: string;
  kind: string;
  title: string;
  content: string;
  attachments: Attachment[];
  created_at: number;
};

export type PublishInfo = {
  id: string;
  agent_hash: string;
  app_name: string;
  tag: string;
  is_public: boolean;
  created_at: number;
};

// ---- Store -----------------------------------------------------

class Store {
  // Current tab
  currentTab: TabId = "chat";

  // Agent list (populated from engine API)
  agents: AgentInfo[] = [];

  // Permissions (populated from engine API)
  permissions: UserPermissions | null = null;

  // Chat items for the middle panel (derived from agents)
  chatItems: ChatItem[] = [];

  // Currently active chat agent hash
  activeAgentHash: string | null = null;

  // Messages for the active chat
  messages: ChatMessage[] = [];

  // Draft text for the active chat
  draft: string = "";

  // Group list
  groups: GroupInfo[] = [];

  // Currently active group id
  activeGroupId: string | null = null;

  // Group messages: map from group_id -> messages
  groupMessages: Map<string, GroupMessage[]> = new Map();

  // Moments (群广场)
  moments: MomentInfo[] = [];
  momentsGroupFilter: string | null = null;

  // FeHub publishes
  publishes: PublishInfo[] = [];

  // Callbacks for reactive updates
  private listeners: Set<(store: Store) => void> = new Set();

  setTab(tab: TabId): void {
    this.currentTab = tab;
    this.notify();
  }

  setAgents(agents: AgentInfo[]): void {
    this.agents = agents;
    // Rebuild chat items
    this.chatItems = agents.map((a) => ({
      agent_hash: a.hash,
      name: a.name,
      avatar_letter: a.name.charAt(0).toUpperCase(),
      avatar_url: a.avatar_url ?? null,
      last_message: "",
      last_time: "",
      unread: false,
      active: a.hash === this.activeAgentHash,
      is_pinned: false,
      is_dnd: false,
      is_online: !!a.is_online,
      status: a.status ?? (a.is_online ? "active" : "offline"),
    }));
    this.notify();
  }

  setPermissions(perms: UserPermissions): void {
    this.permissions = perms;
    this.notify();
  }

  setActiveChat(agentHash: string | null): void {
    if (this.activeAgentHash === agentHash) return;
    this.activeAgentHash = agentHash;
    this.messages = [];
    this.activeGroupId = null;
    // Update active state in chat items
    this.chatItems = this.chatItems.map((item) => ({
      ...item,
      active: !item.is_group && item.agent_hash === agentHash,
    }));
    this.notify();
  }

  setActiveGroup(groupId: string | null): void {
    if (this.activeGroupId === groupId) return;
    this.activeGroupId = groupId;
    this.activeAgentHash = null;
    this.messages = [];
    // Update active state in chat items
    this.chatItems = this.chatItems.map((item) => ({
      ...item,
      active: item.is_group && item.group_id === groupId,
    }));
    this.notify();
  }

  setMessages(msgs: ChatMessage[]): void {
    this.messages = msgs;
    this.notify();
  }

  appendMessage(msg: ChatMessage): void {
    this.messages.push(msg);
    this.notify();
  }

  /**
   * Patch a message in place by `id`. Only the supplied keys are updated.
   * Used by the send-failure flow (2.3 A) to mark the original optimistic
   * message as `synced:false` + `error`, and by retry (2.1 B) to clear
   * `error` and re-send without duplicating the bubble.
   */
  updateMessage(id: string, patch: Partial<ChatMessage>): void {
    let changed = false;
    this.messages = this.messages.map((m) => {
      if (m.id !== id) return m;
      changed = true;
      return { ...m, ...patch };
    });
    if (changed) this.notify();
  }

  setDraft(text: string): void {
    this.draft = text;
    this.notify();
  }

  // ---- Group methods ----

  setGroups(groups: GroupInfo[]): void {
    this.groups = groups;
    // Rebuild group chat items
    const groupItems: ChatItem[] = groups.map((g) => ({
      agent_hash: g.id,
      name: g.name,
      avatar_letter: "👥",
      last_message: g.lastMessage ?? "",
      last_time: "",
      unread: g.unreadCount > 0,
      active: g.id === this.activeGroupId,
      is_group: true,
      group_id: g.id,
    }));
    // Merge with agent chat items, keeping all
    this.chatItems = [...this.chatItems, ...groupItems];
    this.notify();
  }

  setGroupMembers(groupId: string, members: GroupMember[]): void {
    const idx = this.groups.findIndex((g) => g.id === groupId);
    if (idx < 0) return;
    this.groups[idx] = { ...this.groups[idx], members };
    this.notify();
  }

  getGroupById(id: string): GroupInfo | undefined {
    return this.groups.find((g) => g.id === id);
  }

  setGroupMessages(groupId: string, msgs: GroupMessage[]): void {
    this.groupMessages.set(groupId, msgs);
    this.notify();
  }

  appendGroupMessage(groupId: string, msg: GroupMessage): void {
    const existing = this.groupMessages.get(groupId) ?? [];
    this.groupMessages.set(groupId, [...existing, msg]);
    // Update last message on group
    this.groups = this.groups.map((g) =>
      g.id === groupId ? { ...g, lastMessage: msg.content } : g
    );
    this.notify();
  }

  // ---- Moments methods ----

  setMoments(moments: MomentInfo[]): void {
    this.moments = moments;
    this.notify();
  }

  addMoment(moment: MomentInfo): void {
    this.moments = [moment, ...this.moments];
    this.notify();
  }

  setMomentsGroupFilter(groupId: string | null): void {
    this.momentsGroupFilter = groupId;
    this.notify();
  }

  getMoments(): MomentInfo[] {
    if (!this.momentsGroupFilter) return this.moments;
    return this.moments.filter((m) => m.group_id === this.momentsGroupFilter);
  }

  setPublishes(publishes: PublishInfo[]): void {
    this.publishes = publishes;
    this.notify();
  }

  subscribe(listener: (store: Store) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this);
    }
  }
}

// Singleton store instance
export const store = new Store();