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

export type TabId = "chat" | "profile" | "settings";

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
  is_deleted?: boolean;
  timestamp?: string;
  agent?: string;
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
  last_message: string;
  last_time: string;
  unread: boolean;
  active?: boolean;
  // Group chat support
  is_group?: boolean;
  group_id?: string;
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
      last_message: "",
      last_time: "",
      unread: false,
      active: a.hash === this.activeAgentHash,
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