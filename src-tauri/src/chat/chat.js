var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/chat/store.ts
var Store, store;
var init_store = __esm({
  "src/chat/store.ts"() {
    Store = class {
      constructor() {
        // Current tab
        __publicField(this, "currentTab", "chat");
        // Agent list (populated from engine API)
        __publicField(this, "agents", []);
        // Permissions (populated from engine API)
        __publicField(this, "permissions", null);
        // Chat items for the middle panel (derived from agents)
        __publicField(this, "chatItems", []);
        // Currently active chat agent hash
        __publicField(this, "activeAgentHash", null);
        // Messages for the active chat
        __publicField(this, "messages", []);
        // Draft text for the active chat
        __publicField(this, "draft", "");
        // Group list
        __publicField(this, "groups", []);
        // Currently active group id
        __publicField(this, "activeGroupId", null);
        // Group messages: map from group_id -> messages
        __publicField(this, "groupMessages", /* @__PURE__ */ new Map());
        // Moments (群广场)
        __publicField(this, "moments", []);
        __publicField(this, "momentsGroupFilter", null);
        // FeHub publishes
        __publicField(this, "publishes", []);
        // Callbacks for reactive updates
        __publicField(this, "listeners", /* @__PURE__ */ new Set());
      }
      setTab(tab) {
        this.currentTab = tab;
        this.notify();
      }
      setAgents(agents) {
        this.agents = agents;
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
          status: a.status ?? (a.is_online ? "active" : "offline")
        }));
        this.notify();
      }
      setPermissions(perms) {
        this.permissions = perms;
        this.notify();
      }
      setActiveChat(agentHash) {
        if (this.activeAgentHash === agentHash) return;
        this.activeAgentHash = agentHash;
        this.messages = [];
        this.activeGroupId = null;
        this.chatItems = this.chatItems.map((item) => ({
          ...item,
          active: !item.is_group && item.agent_hash === agentHash
        }));
        this.notify();
      }
      setActiveGroup(groupId) {
        if (this.activeGroupId === groupId) return;
        this.activeGroupId = groupId;
        this.activeAgentHash = null;
        this.messages = [];
        this.chatItems = this.chatItems.map((item) => ({
          ...item,
          active: item.is_group && item.group_id === groupId
        }));
        this.notify();
      }
      setMessages(msgs) {
        this.messages = msgs;
        this.notify();
      }
      appendMessage(msg) {
        this.messages.push(msg);
        this.notify();
      }
      /**
       * Patch a message in place by `id`. Only the supplied keys are updated.
       * Used by the send-failure flow (2.3 A) to mark the original optimistic
       * message as `synced:false` + `error`, and by retry (2.1 B) to clear
       * `error` and re-send without duplicating the bubble.
       */
      updateMessage(id, patch) {
        let changed = false;
        this.messages = this.messages.map((m) => {
          if (m.id !== id) return m;
          changed = true;
          return { ...m, ...patch };
        });
        if (changed) this.notify();
      }
      setDraft(text) {
        this.draft = text;
        this.notify();
      }
      // ---- Group methods ----
      setGroups(groups) {
        this.groups = groups;
        const groupItems = groups.map((g) => ({
          agent_hash: g.id,
          name: g.name,
          avatar_letter: "\u{1F465}",
          last_message: g.lastMessage ?? "",
          last_time: "",
          unread: g.unreadCount > 0,
          active: g.id === this.activeGroupId,
          is_group: true,
          group_id: g.id
        }));
        this.chatItems = [...this.chatItems, ...groupItems];
        this.notify();
      }
      setGroupMembers(groupId, members) {
        const idx = this.groups.findIndex((g) => g.id === groupId);
        if (idx < 0) return;
        this.groups[idx] = { ...this.groups[idx], members };
        this.notify();
      }
      getGroupById(id) {
        return this.groups.find((g) => g.id === id);
      }
      setGroupMessages(groupId, msgs) {
        this.groupMessages.set(groupId, msgs);
        this.notify();
      }
      appendGroupMessage(groupId, msg) {
        const existing = this.groupMessages.get(groupId) ?? [];
        this.groupMessages.set(groupId, [...existing, msg]);
        this.groups = this.groups.map(
          (g) => g.id === groupId ? { ...g, lastMessage: msg.content } : g
        );
        this.notify();
      }
      // ---- Moments methods ----
      setMoments(moments) {
        this.moments = moments;
        this.notify();
      }
      addMoment(moment) {
        this.moments = [moment, ...this.moments];
        this.notify();
      }
      setMomentsGroupFilter(groupId) {
        this.momentsGroupFilter = groupId;
        this.notify();
      }
      getMoments() {
        if (!this.momentsGroupFilter) return this.moments;
        return this.moments.filter((m) => m.group_id === this.momentsGroupFilter);
      }
      setPublishes(publishes) {
        this.publishes = publishes;
        this.notify();
      }
      subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }
      notify() {
        for (const listener of this.listeners) {
          listener(this);
        }
      }
    };
    store = new Store();
  }
});

// src/chat/components/create-dialog.ts
var create_dialog_exports = {};
__export(create_dialog_exports, {
  openCreateDialog: () => openCreateDialog
});
function getTauri() {
  const g = window.__TAURI__;
  if (!g?.core) throw new Error("Tauri global not available");
  return g.core;
}
function ensureDialog() {
  let el = document.getElementById(DIALOG_ID);
  if (el) return el;
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "cd-overlay";
  overlay.addEventListener("click", () => hideDialog());
  const dialog = document.createElement("div");
  dialog.id = DIALOG_ID;
  dialog.className = "cd-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "cd-title");
  dialog.innerHTML = `
    <div class="cd-header">
      <span class="cd-title" id="cd-title">\u521B\u5EFA AI \u52A9\u7406</span>
      <button type="button" class="cd-close" id="cd-close" aria-label="\u5173\u95ED">\u2715</button>
    </div>
    <div class="cd-body">
      <p class="cd-section-label">\u9009\u62E9\u7C7B\u578B</p>
      <div class="cd-radio-group">
        <label class="cd-radio-card">
          <input type="radio" name="agent-type" value="classic" checked />
          <div class="cd-radio-content">
            <span class="cd-radio-icon">\u{1F916}</span>
            <div class="cd-radio-text">
              <span class="cd-radio-title">\u7ECF\u5178</span>
              <span class="cd-radio-desc">\u5B8C\u6574\u5DE5\u5177\u94FE\uFF0C\u8BE6\u5C3D\u56DE\u590D</span>
            </div>
          </div>
        </label>
        <label class="cd-radio-card">
          <input type="radio" name="agent-type" value="im" />
          <div class="cd-radio-content">
            <span class="cd-radio-icon">\u{1F4AC}</span>
            <div class="cd-radio-text">
              <span class="cd-radio-title">IM</span>
              <span class="cd-radio-desc">\u77ED\u53E5\u56DE\u590D\uFF0C\u540E\u53F0\u4EFB\u52A1\uFF0C\u53EF\u6253\u65AD</span>
            </div>
          </div>
        </label>
        <label class="cd-radio-card">
          <input type="radio" name="agent-type" value="group" />
          <div class="cd-radio-content">
            <span class="cd-radio-icon">\u{1F465}</span>
            <div class="cd-radio-text">
              <span class="cd-radio-title">\u7FA4\u804A</span>
              <span class="cd-radio-desc">\u591A Agent \u534F\u4F5C\u8BA8\u8BBA</span>
            </div>
          </div>
        </label>
      </div>
      <p class="cd-section-label" style="margin-top:16px;">\u540D\u79F0</p>
      <input
        type="text"
        id="cd-name-input"
        class="cd-input"
        placeholder="\u7ED9 AI \u52A9\u7406\u8D77\u4E2A\u540D\u5B57"
        maxlength="40"
        autocomplete="off"
      />
      <div id="cd-group-members" style="display:none; margin-top:12px;">
        <p class="cd-section-label" style="margin-top:8px;">\u9009\u62E9\u6210\u5458</p>
        <div id="cd-agent-checkboxes" class="cd-checkbox-list"></div>
      </div>
      <p class="cd-error" id="cd-error" style="display:none;"></p>
    </div>
    <div class="cd-footer">
      <button type="button" class="btn btn-secondary" id="cd-cancel">\u53D6\u6D88</button>
      <button type="button" class="btn btn-primary" id="cd-confirm">\u521B\u5EFA</button>
    </div>
  `;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  document.getElementById("cd-close").addEventListener("click", hideDialog);
  document.getElementById("cd-cancel").addEventListener("click", hideDialog);
  document.getElementById("cd-confirm").addEventListener("click", handleConfirm);
  document.getElementById("cd-name-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleConfirm();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideDialog();
  });
  return dialog;
}
function showDialog(prefillType = "classic") {
  const dialog = ensureDialog();
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.style.display = "flex";
  dialog.style.display = "flex";
  const nameInput = document.getElementById("cd-name-input");
  if (nameInput) {
    nameInput.value = "";
    nameInput.focus();
  }
  const errorEl = document.getElementById("cd-error");
  if (errorEl) errorEl.style.display = "none";
  const radio = document.querySelector(
    `input[name="agent-type"][value="${prefillType}"]`
  );
  if (radio) radio.checked = true;
  const groupMembers = document.getElementById("cd-group-members");
  if (nameInput) {
    nameInput.placeholder = prefillType === "group" ? "\u7ED9\u7FA4\u804A\u8D77\u4E2A\u540D\u5B57" : "\u7ED9 AI \u52A9\u7406\u8D77\u4E2A\u540D\u5B57";
  }
  if (groupMembers) groupMembers.style.display = prefillType === "group" ? "block" : "none";
  populateAgentCheckboxes();
  wireRadioChanges();
}
function hideDialog() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.style.display = "none";
  const dialog = document.getElementById(DIALOG_ID);
  if (dialog) dialog.style.display = "none";
}
function populateAgentCheckboxes() {
  const container = document.getElementById("cd-agent-checkboxes");
  if (!container) return;
  container.innerHTML = "";
  for (const agent of store.agents) {
    const item = document.createElement("label");
    item.className = "cd-checkbox-item";
    item.innerHTML = `
      <input type="checkbox" name="cd-group-member" value="${escapeHtml(agent.hash)}" />
      <span class="cd-checkbox-name">${escapeHtml(agent.name)}</span>
    `;
    container.appendChild(item);
  }
  if (store.agents.length === 0) {
    container.innerHTML = '<div class="cd-empty-agents">\u6682\u65E0 Agent\uFF0C\u8BF7\u5148\u521B\u5EFA Agent</div>';
  }
}
function wireRadioChanges() {
  const radios = document.querySelectorAll('input[name="agent-type"]');
  const nameInput = document.getElementById("cd-name-input");
  const groupMembers = document.getElementById("cd-group-members");
  for (const radio of radios) {
    radio.addEventListener("change", () => {
      if (radio.value === "group") {
        if (nameInput) nameInput.placeholder = "\u7ED9\u7FA4\u804A\u8D77\u4E2A\u540D\u5B57";
        if (groupMembers) groupMembers.style.display = "block";
      } else {
        if (nameInput) nameInput.placeholder = "\u7ED9 AI \u52A9\u7406\u8D77\u4E2A\u540D\u5B57";
        if (groupMembers) groupMembers.style.display = "none";
      }
    });
  }
}
async function handleConfirm() {
  const nameInput = document.getElementById("cd-name-input");
  const errorEl = document.getElementById("cd-error");
  if (!nameInput || !errorEl) return;
  const name = nameInput.value.trim();
  if (!name) {
    errorEl.textContent = "\u8BF7\u8F93\u5165\u540D\u79F0";
    errorEl.style.display = "block";
    nameInput.focus();
    return;
  }
  const selectedType = document.querySelector('input[name="agent-type"]:checked');
  const agentType = selectedType?.value ?? "classic";
  const confirmBtn = document.getElementById("cd-confirm");
  const cancelBtn = document.getElementById("cd-cancel");
  if (confirmBtn) confirmBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  errorEl.style.display = "none";
  try {
    if (agentType === "group") {
      const checkboxes = document.querySelectorAll('input[name="cd-group-member"]:checked');
      const memberHashes = Array.from(checkboxes).map((cb) => cb.value);
      if (memberHashes.length < 2) {
        errorEl.textContent = "\u8BF7\u81F3\u5C11\u9009\u62E9 2 \u4E2A\u6210\u5458";
        errorEl.style.display = "block";
        return;
      }
      const newGroup = await invoke("create_group", {
        name,
        memberHashes
      });
      store.setGroups([...store.groups, {
        id: newGroup.id,
        name: newGroup.name,
        announcement: newGroup.announcement,
        memberCount: newGroup.memberCount,
        createdAt: newGroup.createdAt,
        unreadCount: 0
      }]);
      window.dispatchEvent(
        new CustomEvent("group-selected", { detail: { groupId: newGroup.id } })
      );
      hideDialog();
    } else {
      const newAgent = await invoke("create_agent", {
        name,
        agent_type: agentType
      });
      const currentAgents = store.agents;
      store.setAgents([...currentAgents, newAgent]);
      await selectChat(newAgent.hash);
      hideDialog();
    }
  } catch (err) {
    const msg = typeof err === "string" ? err : err?.message ?? "\u521B\u5EFA\u5931\u8D25";
    errorEl.textContent = msg;
    errorEl.style.display = "block";
  } finally {
    if (confirmBtn) confirmBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
  }
}
async function selectChat(agentHash) {
  window.dispatchEvent(
    new CustomEvent("agent-created", { detail: { agentHash } })
  );
}
function openCreateDialog(prefill = "classic") {
  showDialog(prefill);
}
var invoke, DIALOG_ID, OVERLAY_ID;
var init_create_dialog = __esm({
  "src/chat/components/create-dialog.ts"() {
    init_store();
    invoke = (cmd, args) => getTauri().invoke(cmd, args);
    DIALOG_ID = "create-dialog";
    OVERLAY_ID = "create-dialog-overlay";
  }
});

// src/chat/components/side-panel.ts
function getTauri2() {
  const g = window.__TAURI__;
  if (!g?.core) throw new Error("Tauri global not available");
  return g.core;
}
function buildPanel() {
  if (document.getElementById(PANEL_ID)) return;
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID2;
  overlay.className = "side-overlay";
  overlay.addEventListener("click", closeSidePanel);
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.className = "side-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Agent \u8BBE\u7F6E");
  panel.innerHTML = `
    <div class="sp-header">
      <span class="sp-title">Agent \u8BBE\u7F6E</span>
      <button type="button" class="sp-close" id="sp-close" aria-label="\u5173\u95ED">\u2715</button>
    </div>
    <div class="sp-body">
      <div class="sp-avatar-row">
        <div class="sp-avatar" id="sp-avatar">A</div>
      </div>

      <div class="sp-field">
        <label class="sp-label">\u5907\u6CE8\u540D</label>
        <input type="text" class="sp-input" id="sp-alias-input"
          placeholder="\u70B9\u51FB\u7F16\u8F91\u5907\u6CE8\u540D" maxlength="40" />
      </div>

      <div class="sp-toggle-row">
        <span class="sp-toggle-label">\u{1F4CC} \u7F6E\u9876\u804A\u5929</span>
        <label class="sp-switch">
          <input type="checkbox" id="sp-toggle-pin" />
          <span class="sp-slider"></span>
        </label>
      </div>

      <div class="sp-toggle-row">
        <span class="sp-toggle-label">\u{1F515} \u514D\u6253\u6270</span>
        <label class="sp-switch">
          <input type="checkbox" id="sp-toggle-dnd" />
          <span class="sp-slider"></span>
        </label>
      </div>

      <div class="sp-btn-row" id="sp-file-manager-row">
        <span class="sp-btn-label">\u{1F4C2} \u6587\u4EF6\u7BA1\u7406\u5668</span>
        <button type="button" class="sp-btn" id="sp-open-file-manager">\u6253\u5F00</button>
      </div>

      <div class="sp-btn-row" id="sp-config-row">
        <span class="sp-btn-label">\u2699\uFE0F \u914D\u7F6E\u7BA1\u7406</span>
        <button type="button" class="sp-btn" id="sp-open-config">\u6253\u5F00</button>
      </div>

      <div class="sp-perm-row" id="sp-perm-row" role="button" tabindex="0">
        <div class="sp-perm-label-wrap">
          <span class="sp-btn-label">\u{1F6E1}\uFE0F \u5B89\u5168\u6743\u9650\u7B49\u7EA7</span>
          <span class="sp-perm-current" id="sp-perm-current">\u2014</span>
        </div>
        <button type="button" class="sp-btn sp-btn-primary" id="sp-open-perm">\u5207\u6362</button>
      </div>

      <div class="sp-section" id="sp-apps-section">
        <div class="sp-section-header">\u{1F3EA} \u5C0F\u7A0B\u5E8F</div>
        <div class="sp-apps-loading" id="sp-apps-loading">\u52A0\u8F7D\u4E2D...</div>
        <div class="sp-apps-list" id="sp-apps-list"></div>
      </div>
    </div>
  `;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.getElementById("sp-close").addEventListener("click", closeSidePanel);
  document.getElementById("sp-alias-input").addEventListener("blur", () => {
    if (!currentAgentHash) return;
    const input = document.getElementById("sp-alias-input");
    void saveAliasAndSync(input.value);
  });
  document.getElementById("sp-toggle-pin").addEventListener("change", () => {
    if (!currentAgentHash) return;
    void togglePinAndSync();
  });
  document.getElementById("sp-toggle-dnd").addEventListener("change", () => {
    if (!currentAgentHash) return;
    void toggleDndAndSync();
  });
  const permRow = document.getElementById("sp-perm-row");
  permRow.addEventListener("click", openPermissionModal);
  permRow.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPermissionModal();
    }
  });
  document.getElementById("sp-open-perm").addEventListener("click", (e) => {
    e.stopPropagation();
    openPermissionModal();
  });
  document.getElementById("sp-open-file-manager").addEventListener("click", () => {
    if (!currentAgentHash) return;
    void openFileManager();
  });
  document.getElementById("sp-open-config").addEventListener("click", () => {
    if (!currentAgentHash) return;
    void openConfig();
  });
  document.addEventListener("keydown", handleEscKey);
}
function buildPermissionModal() {
  if (document.getElementById(PERM_MODAL_ID)) return;
  const overlay = document.createElement("div");
  overlay.id = PERM_OVERLAY_ID;
  overlay.className = "perm-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePermissionModal();
  });
  const modal = document.createElement("div");
  modal.id = PERM_MODAL_ID;
  modal.className = "perm-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "\u5B89\u5168\u6743\u9650\u7B49\u7EA7");
  modal.innerHTML = `
    <div class="perm-header">
      <span class="perm-title">\u{1F6E1}\uFE0F \u5B89\u5168\u6743\u9650\u7B49\u7EA7</span>
      <button type="button" class="perm-close" id="perm-close" aria-label="\u5173\u95ED">\u2715</button>
    </div>
    <div class="perm-body">
      <div class="perm-list" id="perm-list">
        ${PERMISSION_OPTIONS.map(
    (o) => `
          <button type="button" class="perm-option" data-value="${o.value}">
            <div class="perm-option-radio" aria-hidden="true"></div>
            <div class="perm-option-text">
              <div class="perm-option-label">${o.label}</div>
              <div class="perm-option-desc">${o.desc}</div>
            </div>
          </button>`
  ).join("")}
      </div>
    </div>
    <div class="perm-footer">
      <button type="button" class="perm-btn perm-btn-cancel" id="perm-cancel">\u53D6\u6D88</button>
      <button type="button" class="perm-btn perm-btn-confirm" id="perm-confirm">\u786E\u5B9A</button>
    </div>
  `;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modal.querySelectorAll(".perm-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.getAttribute("data-value");
      if (value) selectPermissionOption(value);
    });
  });
  document.getElementById("perm-close").addEventListener("click", closePermissionModal);
  document.getElementById("perm-cancel").addEventListener("click", closePermissionModal);
  document.getElementById("perm-confirm").addEventListener("click", () => {
    void confirmPermissionSelection();
  });
}
function selectPermissionOption(value) {
  pendingPermissionMode = value;
  document.querySelectorAll(".perm-option").forEach((btn) => {
    btn.classList.toggle("selected", btn.getAttribute("data-value") === value);
  });
}
async function openSidePanelImpl(info, agentHash) {
  buildPanel();
  const overlay = document.getElementById(OVERLAY_ID2);
  const panel = document.getElementById(PANEL_ID);
  const avatarEl = document.getElementById("sp-avatar");
  const name = info.alias || store.agents.find((a) => a.hash === agentHash)?.name || "A";
  avatarEl.textContent = name.charAt(0).toUpperCase();
  const aliasInput = document.getElementById("sp-alias-input");
  aliasInput.value = info.alias || "";
  const pinToggle = document.getElementById("sp-toggle-pin");
  pinToggle.checked = info.is_pinned;
  const dndToggle = document.getElementById("sp-toggle-dnd");
  dndToggle.checked = info.is_dnd;
  updatePermLabel(info.permission_mode);
  currentAgentHash = agentHash;
  overlay.classList.add("open");
  panel.classList.add("open");
  isPanelOpen = true;
  aliasInput.focus();
  void loadApps(agentHash);
}
function updatePermLabel(mode) {
  const el = document.getElementById("sp-perm-current");
  if (el) el.textContent = PERMISSION_LABEL[mode] ?? mode;
}
function closeSidePanel() {
  if (isPermModalOpen) {
    closePermissionModal();
    return;
  }
  const overlay = document.getElementById(OVERLAY_ID2);
  const panel = document.getElementById(PANEL_ID);
  if (overlay) overlay.classList.remove("open");
  if (panel) panel.classList.remove("open");
  isPanelOpen = false;
  currentAgentHash = null;
}
function openPermissionModal() {
  if (!currentAgentHash) return;
  buildPermissionModal();
  const overlay = document.getElementById(PERM_OVERLAY_ID);
  const modal = document.getElementById(PERM_MODAL_ID);
  const currentLabelEl = document.getElementById("sp-perm-current");
  let currentValue = "balanced";
  if (currentLabelEl?.textContent) {
    const match = PERMISSION_OPTIONS.find(
      (o) => o.label === currentLabelEl.textContent
    );
    if (match) currentValue = match.value;
  }
  pendingPermissionMode = currentValue;
  selectPermissionOption(currentValue);
  overlay.classList.add("open");
  requestAnimationFrame(() => modal.classList.add("open"));
  isPermModalOpen = true;
}
function closePermissionModal() {
  const overlay = document.getElementById(PERM_OVERLAY_ID);
  const modal = document.getElementById(PERM_MODAL_ID);
  if (modal) modal.classList.remove("open");
  if (overlay) {
    setTimeout(() => {
      if (!isPermModalOpen) overlay.classList.remove("open");
    }, 180);
  }
  isPermModalOpen = false;
  pendingPermissionMode = null;
}
async function confirmPermissionSelection() {
  if (!currentAgentHash || !pendingPermissionMode) {
    closePermissionModal();
    return;
  }
  const value = pendingPermissionMode;
  closePermissionModal();
  updatePermLabel(value);
  await setPermissionModeAndSync(value);
}
function handleEscKey(e) {
  if (e.key !== "Escape") return;
  if (isPermModalOpen) {
    e.preventDefault();
    closePermissionModal();
  } else if (isPanelOpen) {
    e.preventDefault();
    closeSidePanel();
  }
}
async function loadApps(agentHash) {
  const loadingEl = document.getElementById("sp-apps-loading");
  const listEl = document.getElementById("sp-apps-list");
  if (!loadingEl || !listEl) return;
  try {
    const apps = await invoke2("list_agent_apps", { agent_hash: agentHash });
    loadingEl.style.display = "none";
    if (!apps || apps.length === 0) {
      listEl.innerHTML = '<div class="sp-apps-empty">\u6682\u65E0\u53EF\u7528\u5C0F\u7A0B\u5E8F</div>';
      return;
    }
    listEl.innerHTML = apps.map(
      (app) => {
        const iconUrl = app.icon_url ?? "";
        const showImg = iconUrl.startsWith("http://") || iconUrl.startsWith("https://");
        const iconHtml = showImg ? `<img src="${escapeHtml2(iconUrl)}" alt="" width="24" height="24" />` : "\u{1F4E6}";
        return `
      <div class="sp-app-card" data-app-id="${escapeHtml2(app.app_id)}" data-name="${escapeHtml2(app.name)}" data-url="${escapeHtml2(iconUrl)}">
        <div class="sp-app-icon">${iconHtml}</div>
        <div class="sp-app-info">
          <div class="sp-app-name">${escapeHtml2(app.name)}</div>
          <div class="sp-app-desc">${escapeHtml2(app.description)}</div>
        </div>
      </div>`;
      }
    ).join("");
    listEl.querySelectorAll(".sp-app-card").forEach((card) => {
      card.addEventListener("click", () => {
        const appId = card.getAttribute("data-app-id");
        if (appId) void openApp(appId);
      });
    });
  } catch (e) {
    console.error("list_agent_apps failed:", e);
    loadingEl.style.display = "none";
    listEl.innerHTML = '<div class="sp-apps-empty">\u52A0\u8F7D\u5931\u8D25</div>';
  }
}
async function openApp(appId) {
  try {
    await invoke2("open_app", { app_id: appId });
  } catch {
    console.warn("open_app not implemented, app_id:", appId);
  }
}
async function saveAlias(alias) {
  if (!currentAgentHash) return;
  try {
    await invoke2("update_agent_alias", { agent_hash: currentAgentHash, alias });
  } catch (e) {
    console.error("update_agent_alias failed:", e);
  }
}
async function syncSettings() {
  if (!currentAgentHash) return;
  try {
    await invoke2("sync_agent_settings", { agent_hash: currentAgentHash });
  } catch (e) {
    console.warn("sync_agent_settings failed (non-fatal):", e);
  }
}
async function saveAliasAndSync(alias) {
  await saveAlias(alias);
  void syncSettings();
}
async function togglePin() {
  if (!currentAgentHash) return false;
  try {
    return await invoke2("toggle_pin", { agent_hash: currentAgentHash });
  } catch (e) {
    console.error("toggle_pin failed:", e);
    return false;
  }
}
async function togglePinAndSync() {
  const newVal = await togglePin();
  const pinToggle = document.getElementById("sp-toggle-pin");
  if (pinToggle) pinToggle.checked = newVal;
  void syncSettings();
}
async function toggleDnd() {
  if (!currentAgentHash) return false;
  try {
    return await invoke2("toggle_dnd", { agent_hash: currentAgentHash });
  } catch (e) {
    console.error("toggle_dnd failed:", e);
    return false;
  }
}
async function toggleDndAndSync() {
  const newVal = await toggleDnd();
  const dndToggle = document.getElementById("sp-toggle-dnd");
  if (dndToggle) dndToggle.checked = newVal;
  void syncSettings();
}
async function setPermissionMode(mode) {
  if (!currentAgentHash) return;
  try {
    await invoke2("set_agent_permission_mode", { agent_hash: currentAgentHash, mode });
  } catch (e) {
    console.error("set_agent_permission_mode failed:", e);
  }
}
async function setPermissionModeAndSync(mode) {
  await setPermissionMode(mode);
  void syncSettings();
}
async function openConfig() {
  if (!currentAgentHash) return;
  try {
    await invoke2("open_config_window", { agent_hash: currentAgentHash });
  } catch (e) {
    console.error("open_config_window failed:", e);
  }
}
async function openFileManager() {
  if (!currentAgentHash) return;
  try {
    await invoke2("open_file_manager_window", { agent_hash: currentAgentHash });
  } catch (e) {
    console.error("open_file_manager_window failed:", e);
  }
}
async function openSidePanel(agentHash) {
  try {
    const info = await invoke2("get_agent_panel_info", {
      agent_hash: agentHash
    });
    await openSidePanelImpl(info, agentHash);
  } catch (e) {
    console.error("get_agent_panel_info failed:", e);
  }
}
function escapeHtml2(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
var invoke2, PERMISSION_OPTIONS, PERMISSION_LABEL, OVERLAY_ID2, PANEL_ID, PERM_OVERLAY_ID, PERM_MODAL_ID, currentAgentHash, isPanelOpen, isPermModalOpen, pendingPermissionMode;
var init_side_panel = __esm({
  "src/chat/components/side-panel.ts"() {
    init_store();
    invoke2 = (cmd, args) => getTauri2().invoke(cmd, args);
    PERMISSION_OPTIONS = [
      { value: "disabled", label: "\u7981\u6B62 (L0)", desc: "\u5B8C\u5168\u7981\u7528\u5DE5\u5177\u8C03\u7528" },
      { value: "strict", label: "\u4E25\u683C (L1)", desc: "\u53EA\u8BFB\u64CD\u4F5C\uFF0C\u6BCF\u6B21\u9700\u786E\u8BA4" },
      { value: "balanced", label: "\u5E73\u8861 (L2)", desc: "\u5E38\u7528\u64CD\u4F5C\u81EA\u52A8\u653E\u884C" },
      { value: "relaxed", label: "\u5BBD\u677E (L3)", desc: "\u5927\u591A\u6570\u64CD\u4F5C\u65E0\u9700\u786E\u8BA4" },
      { value: "full", label: "\u5B8C\u5168\u6388\u6743 (L4)", desc: "\u65E0\u9650\u5236\u6267\u884C" }
    ];
    PERMISSION_LABEL = Object.fromEntries(
      PERMISSION_OPTIONS.map((o) => [o.value, o.label])
    );
    OVERLAY_ID2 = "side-overlay";
    PANEL_ID = "side-panel";
    PERM_OVERLAY_ID = "perm-overlay";
    PERM_MODAL_ID = "perm-modal";
    currentAgentHash = null;
    isPanelOpen = false;
    isPermModalOpen = false;
    pendingPermissionMode = null;
  }
});

// src/chat/components/markdown.ts
function requireMarked() {
  const m = window.marked;
  if (!m) {
    throw new Error(
      "marked is not loaded \u2014 check that vendor/marked.min.js is included in chat/index.html"
    );
  }
  return m;
}
function requireDomPurify() {
  const d = window.DOMPurify;
  if (!d) {
    throw new Error(
      "DOMPurify is not loaded \u2014 check that vendor/purify.min.js is included in chat/index.html"
    );
  }
  return d;
}
function requireHljs() {
  return window.hljs ?? null;
}
function configureMarkdown() {
  if (configured) return;
  const marked = requireMarked();
  const hljs = requireHljs();
  marked.setOptions({
    gfm: true,
    breaks: true
    // Don't run highlight here — we'll call hljs.highlightElement after
    // DOM insertion so the colour scheme picks up the current theme.
  });
  configured = true;
  void hljs;
}
function renderMarkdown(src) {
  configureMarkdown();
  const marked = requireMarked();
  const DOMPurify = requireDomPurify();
  const html = marked.parse(src);
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "rel"],
    ADD_TAGS: [],
    FORBID_TAGS: ["style", "script", "iframe", "form"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "style"]
  });
  return clean;
}
function decorateMarkdownRoot(root) {
  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (!isSafeImageUrl(src)) {
      img.replaceWith(
        Object.assign(document.createElement("span"), {
          className: "image-blocked",
          textContent: "[\u56FE\u7247\u7C7B\u578B\u4E0D\u652F\u6301\u9884\u89C8]"
        })
      );
    } else {
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
    }
  });
  root.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("http://") || href.startsWith("https://")) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }
  });
  const hljs = requireHljs();
  if (hljs) {
    root.querySelectorAll("pre code").forEach((el) => {
      try {
        hljs.highlightElement(el);
      } catch (e) {
        console.warn("hljs.highlightElement failed:", e);
      }
    });
  }
}
function isSafeImageUrl(src) {
  if (!src) return false;
  if (src.startsWith("https://") || src.startsWith("http://")) return true;
  return SAFE_DATA_IMAGE_PREFIX_RE.test(src);
}
var configured, SAFE_DATA_IMAGE_PREFIX_RE;
var init_markdown = __esm({
  "src/chat/components/markdown.ts"() {
    configured = false;
    SAFE_DATA_IMAGE_PREFIX_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
  }
});

// src/chat/components/qr-upload.ts
var qr_upload_exports = {};
__export(qr_upload_exports, {
  openQrUploadDialog: () => openQrUploadDialog
});
function getTauri3() {
  const g = window.__TAURI__;
  if (!g?.core) throw new Error("Tauri global not available");
  return g.core;
}
function openQrUploadDialog() {
  if (dialogOpen) return;
  dialogOpen = true;
  void showQrDialog();
}
async function showQrDialog() {
  document.getElementById("qr-upload-overlay")?.remove();
  let session;
  try {
    session = await invoke3("create_upload_session");
  } catch (e) {
    console.error("create_upload_session failed:", e);
    showToast("\u521B\u5EFA\u4E0A\u4F20\u4F1A\u8BDD\u5931\u8D25\uFF1A" + String(e));
    dialogOpen = false;
    return;
  }
  currentSessionId = session.session_id;
  const uploadPageUrl = buildUploadPageUrl(session);
  let qrDataUrl;
  try {
    qrDataUrl = await invoke3("generate_qr_code", { data: uploadPageUrl });
  } catch (e) {
    console.error("generate_qr_code failed:", e);
    showToast("\u751F\u6210\u4E8C\u7EF4\u7801\u5931\u8D25\uFF1A" + String(e));
    dialogOpen = false;
    return;
  }
  const overlay = document.createElement("div");
  overlay.id = "qr-upload-overlay";
  overlay.className = "qr-upload-overlay";
  overlay.innerHTML = `
    <div class="qr-upload-dialog">
      <div class="qud-header">
        <span class="qud-title">\u{1F4F1} \u626B\u7801\u4E0A\u4F20</span>
        <button class="qud-close" id="qud-close-btn" aria-label="\u5173\u95ED">\u2715</button>
      </div>
      <div class="qud-body">
        <div class="qud-qr-container">
          <img id="qud-qr-img" src="${qrDataUrl}" alt="QR Code" class="qud-qr" />
        </div>
        <p class="qud-hint">\u6253\u5F00\u624B\u673A\u76F8\u673A\u626B\u7801\u4E0A\u4F20\u6587\u4EF6</p>
        <p class="qud-session" id="qud-session-info">\u4F1A\u8BDD: ${session.session_id}</p>
      </div>
      <div class="qud-footer">
        <button class="qud-btn qud-btn-cancel" id="qud-cancel-btn">\u53D6\u6D88</button>
        <button class="qud-btn qud-btn-confirm" id="qud-confirm-btn">\u6211\u5DF2\u4E0A\u4F20</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#qud-close-btn")?.addEventListener("click", closeQrDialog);
  overlay.querySelector("#qud-cancel-btn")?.addEventListener("click", closeQrDialog);
  overlay.querySelector("#qud-confirm-btn")?.addEventListener("click", () => {
    void handleManualConfirm();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeQrDialog();
  });
  await subscribeUploadComplete(session.session_id);
}
function buildUploadPageUrl(session) {
  const base = session.presigned_url;
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}sid=${encodeURIComponent(session.session_id)}`;
}
async function subscribeUploadComplete(sessionId) {
  if (unlistenUploadComplete) {
    unlistenUploadComplete();
    unlistenUploadComplete = null;
  }
  try {
    unlistenUploadComplete = await listen("upload-complete", (e) => {
      const payload = e.payload;
      if (!payload || payload.session_id !== sessionId) return;
      void handleUploadComplete(payload);
    });
  } catch (e) {
    console.error("listen upload-complete failed:", e);
  }
}
async function handleUploadComplete(payload) {
  let dataUrl;
  try {
    dataUrl = await invoke3("download_uploaded_file", { url: payload.presigned_get_url });
  } catch (e) {
    console.error("download_uploaded_file failed:", e);
    showToast("\u4E0B\u8F7D\u56FE\u7247\u5931\u8D25\uFF1A" + String(e));
    return;
  }
  await addQrImageCard(dataUrl, payload.file_name);
  closeQrDialog();
  showToast("\u56FE\u7247\u5DF2\u6DFB\u52A0\uFF0C\u70B9\u51FB\u53D1\u9001");
}
async function handleManualConfirm() {
  if (!currentSessionId) return;
  showToast("\u6B63\u5728\u68C0\u67E5\u4E0A\u4F20\u72B6\u6001\u2026");
  setTimeout(() => {
    closeQrDialog();
  }, 3e3);
}
function closeQrDialog() {
  dialogOpen = false;
  currentSessionId = null;
  if (unlistenUploadComplete) {
    unlistenUploadComplete();
    unlistenUploadComplete = null;
  }
  document.getElementById("qr-upload-overlay")?.remove();
}
async function addQrImageCard(dataUrl, fileName) {
  try {
    const { addImageCard: addImageCard2 } = await Promise.resolve().then(() => (init_input_box(), input_box_exports));
    const name = fileName ?? `\u626B\u7801\u56FE\u7247_${Date.now()}.jpg`;
    const card = {
      id: `qr-img-${Date.now()}`,
      temp_path: "",
      name,
      size_bytes: 0,
      data_url: dataUrl
    };
    addImageCard2(card);
  } catch (e) {
    console.error("addQrImageCard failed:", e);
  }
}
function showToast(message) {
  const existing = document.getElementById("qud-toast");
  existing?.remove();
  const toast = document.createElement("div");
  toast.id = "qud-toast";
  toast.className = "qud-toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  injectToastStyles();
  setTimeout(() => toast.remove(), 3e3);
}
function injectToastStyles() {
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
var invoke3, listen, dialogOpen, currentSessionId, unlistenUploadComplete;
var init_qr_upload = __esm({
  "src/chat/components/qr-upload.ts"() {
    invoke3 = (cmd, args) => getTauri3().invoke(cmd, args);
    listen = (event, handler) => getTauri3().listen(event, handler);
    dialogOpen = false;
    currentSessionId = null;
    unlistenUploadComplete = null;
  }
});

// src/chat/components/input-box.ts
var input_box_exports = {};
__export(input_box_exports, {
  addCard: () => addCard,
  addImageCard: () => addImageCard,
  clearActiveMentions: () => clearActiveMentions,
  clearFileCards: () => clearFileCards,
  clearImageCards: () => clearImageCards,
  getActiveMentions: () => getActiveMentions,
  getFileCards: () => getFileCards,
  getImageCards: () => getImageCards,
  removeCard: () => removeCard,
  removeImageCard: () => removeImageCard,
  setMentionCandidates: () => setMentionCandidates,
  setupInputBox: () => setupInputBox,
  setupMentionPicker: () => setupMentionPicker,
  setupTemplateBar: () => setupTemplateBar
});
function getTauri4() {
  const g = window.__TAURI__;
  if (!g?.core) throw new Error("Tauri global not available");
  return g.core;
}
function injectStyles() {
  if (document.getElementById("ib-styles")) return;
  const style = document.createElement("style");
  style.id = "ib-styles";
  style.textContent = `
/* Input-box component styles */
.composer-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 16px 0;
  background: var(--bg-elev);
}
.btn-attach {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}
.btn-attach:hover { background: var(--bg-hover); color: var(--text); }

/* Attachment menu */
.attach-menu {
  position: relative;
}
.attach-dropdown {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  min-width: 200px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow);
  z-index: 200;
  overflow: hidden;
  display: none;
}
.attach-dropdown.open { display: block; }
.attach-dropdown-section {
  padding: 6px 0 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding-left: 12px;
}
.attach-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 14px;
  color: var(--text);
  transition: background 0.12s;
  border: none;
  background: transparent;
  width: 100%;
  text-align: left;
  font-family: inherit;
}
.attach-item:hover { background: var(--bg-hover); }
.attach-item.disabled {
  opacity: 0.45;
  cursor: not-allowed;
  pointer-events: none;
}
.attach-item-icon { font-size: 15px; }
.attach-item-text { flex: 1; }
.attach-item-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--border);
  color: var(--text-muted);
}
.attach-submenu {
  position: relative;
}
.attach-submenu-items {
  display: none;
  position: absolute;
  left: calc(100% + 2px);
  top: 0;
  min-width: 180px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.attach-submenu:hover .attach-submenu-items { display: block; }
.attach-submenu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text);
  transition: background 0.12s;
  border: none;
  background: transparent;
  width: 100%;
  text-align: left;
  font-family: inherit;
}
.attach-submenu-item:hover { background: var(--bg-hover); }

/* File cards */
.file-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 16px 0;
}
.fc-card {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 10px;
  border-radius: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  font-size: 13px;
  color: var(--text);
  max-width: 220px;
  animation: fcIn 0.15s ease-out;
}
@keyframes fcIn {
  from { opacity: 0; transform: scale(0.92); }
  to   { opacity: 1; transform: scale(1); }
}
.fc-icon { font-size: 14px; flex-shrink: 0; }
.fc-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}
.fc-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.fc-size { font-size: 11px; color: var(--text-muted); }
.fc-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  flex-shrink: 0;
}
.fc-badge.ref {
  background: rgba(56, 189, 248, 0.15);
  color: var(--primary);
}
.fc-badge.copy {
  background: rgba(251, 191, 36, 0.15);
  color: var(--warning);
}
.fc-remove {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  flex-shrink: 0;
  transition: background 0.12s, color 0.12s;
}
.fc-remove:hover { background: var(--bg-hover); color: var(--error); }
.fc-badge.ref { background: rgba(56, 189, 248, 0.15); color: var(--primary); }
.fc-badge.copy { background: rgba(251, 191, 36, 0.15); color: var(--warning); }

/* Image cards (pasted screenshots) */
.image-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 16px 0;
}
.ic-card {
  position: relative;
  display: inline-flex;
  align-items: center;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border);
  animation: fcIn 0.15s ease-out;
  max-width: 120px;
}
.ic-card img {
  display: block;
  width: 100px;
  height: 72px;
  object-fit: cover;
}
.ic-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: rgba(0,0,0,0.5);
  color: white;
  cursor: pointer;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background 0.12s;
}
.ic-remove:hover { background: var(--error); }
.ic-size {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(0,0,0,0.4);
  color: white;
  font-size: 9px;
  padding: 1px 4px;
  text-align: center;
}

/* Template bar */
.template-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px 0;
  flex-wrap: wrap;
}
.tmpl-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
  font-family: inherit;
  white-space: nowrap;
}
.tmpl-pill:hover {
  background: var(--bg-hover);
  border-color: var(--primary);
  color: var(--primary);
}
.tmpl-pill.builtin { border-color: var(--border); }
.tmpl-pill.custom { border-color: var(--primary); color: var(--primary); }
.tmpl-settings {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  transition: background 0.12s, color 0.12s;
  font-family: inherit;
}
.tmpl-settings:hover { background: var(--bg-hover); color: var(--text); }

/* Template editor modal */
.tmpl-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  z-index: 500;
  display: flex;
  align-items: center;
  justify-content: center;
}
.tmpl-modal {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 14px;
  width: 480px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.tmpl-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-soft);
  flex-shrink: 0;
}
.tmpl-modal-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.tmpl-modal-close {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s;
}
.tmpl-modal-close:hover { background: var(--bg-hover); color: var(--text); }
.tmpl-modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}
.tmpl-add-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
  transition: background 0.12s, color 0.12s;
  margin-bottom: 12px;
}
.tmpl-add-btn:hover { background: var(--bg-hover); color: var(--text); }
.tmpl-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-soft);
  margin-bottom: 8px;
  background: var(--bg);
}
.tmpl-item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.tmpl-item-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}
.tmpl-item-actions {
  display: flex;
  gap: 4px;
}
.tmpl-item-btn {
  padding: 2px 8px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  transition: background 0.12s, color 0.12s;
}
.tmpl-item-btn:hover { background: var(--bg-hover); color: var(--text); }
.tmpl-item-btn.delete:hover { background: rgba(248,113,113,0.1); color: var(--error); }
.tmpl-item-preview {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 380px;
}
.tmpl-empty {
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  padding: 20px;
}
.tmpl-editor-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--primary);
  background: rgba(56,189,248,0.05);
  margin-bottom: 8px;
}
.tmpl-form-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tmpl-form-label {
  font-size: 12px;
  color: var(--text-muted);
  min-width: 40px;
}
.tmpl-form-input {
  flex: 1;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  outline: none;
}
.tmpl-form-input:focus { border-color: var(--primary); }
.tmpl-form-textarea {
  width: 100%;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 13px;
  outline: none;
  resize: vertical;
  min-height: 60px;
}
.tmpl-form-textarea:focus { border-color: var(--primary); }
.tmpl-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.tmpl-btn-cancel {
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  transition: background 0.12s;
}
.tmpl-btn-cancel:hover { background: var(--bg-hover); }
.tmpl-btn-save {
  padding: 5px 12px;
  border-radius: 6px;
  border: none;
  background: var(--primary);
  color: white;
  cursor: pointer;
  font-size: 12px;
  font-family: inherit;
  transition: background 0.12s;
}
.tmpl-btn-save:hover { background: var(--primary-dark); }
`;
  document.head.appendChild(style);
}
function toggleMenu() {
  menuVisible = !menuVisible;
  const dropdown = document.getElementById("attach-dropdown");
  if (dropdown) dropdown.classList.toggle("open", menuVisible);
}
function closeMenu() {
  menuVisible = false;
  const dropdown = document.getElementById("attach-dropdown");
  if (dropdown) dropdown.classList.remove("open");
}
async function pickFile(mode) {
  closeMenu();
  const label = mode === "reference" ? "\u5F15\u7528" : "\u53D1\u9001";
  try {
    const file = await invoke4("pick_local_file", { mode });
    if (file) {
      addCard(file);
    }
  } catch (err) {
    console.error("pick_local_file failed:", err);
  }
}
function openCloudBrowser() {
  closeMenu();
  const notice = document.createElement("div");
  notice.style.cssText = `
    position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%);
    background: var(--bg-elev); border: 1px solid var(--border);
    color: var(--text); padding: 10px 18px; border-radius: 10px;
    font-size: 13px; z-index: 9999; box-shadow: var(--shadow);
    animation: fcIn 0.2s ease-out;
  `;
  notice.textContent = "\u2601\uFE0F \u4E91\u6587\u4EF6\u6D4F\u89C8\u5668\uFF08Phase 2 \u5B9E\u73B0\uFF09";
  document.body.appendChild(notice);
  setTimeout(() => notice.remove(), 2500);
}
function addCard(file) {
  fileCards.push(file);
  renderCards();
}
function removeCard(id) {
  fileCards = fileCards.filter((f) => f.id !== id);
  renderCards();
}
function getFileCards() {
  return [...fileCards];
}
function clearFileCards() {
  fileCards = [];
  renderCards();
}
function renderCards() {
  let container = document.getElementById("file-cards");
  if (!container) return;
  if (fileCards.length === 0) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }
  container.style.display = "flex";
  container.innerHTML = "";
  for (const file of fileCards) {
    const card = document.createElement("span");
    card.className = "fc-card";
    card.dataset.id = file.id;
    card.innerHTML = `
      <span class="fc-icon">\u{1F4C4}</span>
      <span class="fc-name" title="${escapeHtml3(file.name)}">${escapeHtml3(file.name)}</span>
      <span class="fc-meta">
        <span class="fc-size">${file.size_label}</span>
        <span class="fc-badge ${file.mode === "reference" ? "ref" : "copy"}">${file.mode === "reference" ? "\u5F15\u7528" : "\u53D1\u9001"}</span>
        <button class="fc-remove" title="\u79FB\u9664" aria-label="\u79FB\u9664\u6587\u4EF6">\u2715</button>
      </span>
    `;
    card.querySelector(".fc-remove").addEventListener("click", (e) => {
      e.stopPropagation();
      removeCard(file.id);
    });
    container.appendChild(card);
  }
}
function addImageCard(card) {
  imageCards.push(card);
  renderImageCards();
}
function removeImageCard(id) {
  imageCards = imageCards.filter((c) => c.id !== id);
  renderImageCards();
}
function getImageCards() {
  return [...imageCards];
}
function clearImageCards() {
  imageCards = [];
  renderImageCards();
}
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
function renderImageCards() {
  let container = document.getElementById("image-cards");
  if (!container) return;
  if (imageCards.length === 0) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }
  container.style.display = "flex";
  container.innerHTML = "";
  for (const img of imageCards) {
    const card = document.createElement("span");
    card.className = "ic-card";
    card.dataset.id = img.id;
    card.innerHTML = `
      <img src="${img.data_url}" alt="${escapeHtml3(img.name)}" />
      <button class="ic-remove" title="\u79FB\u9664\u56FE\u7247" aria-label="\u79FB\u9664\u56FE\u7247">\u2715</button>
      <span class="ic-size">${formatBytes(img.size_bytes)}</span>
    `;
    card.querySelector(".ic-remove").addEventListener("click", (e) => {
      e.stopPropagation();
      removeImageCard(img.id);
    });
    container.appendChild(card);
  }
}
function buildImageCardsContainer() {
  const composer = document.querySelector(".composer");
  if (!composer) return;
  const container = document.createElement("div");
  container.id = "image-cards";
  container.className = "image-cards";
  container.style.display = "none";
  const textarea = composer.querySelector("textarea");
  composer.insertBefore(container, textarea);
}
function handleImagePaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) return;
      void saveAndInsertImage(file);
      return;
    }
  }
}
async function saveAndInsertImage(file) {
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const base64 = ev.target?.result;
    if (!base64) return;
    try {
      const info = await invoke4(
        "save_temp_image",
        { base64Data: base64 }
      );
      addImageCard({
        id: `img-${Date.now()}`,
        temp_path: info.temp_path,
        name: info.name,
        size_bytes: info.size_bytes,
        data_url: base64
      });
    } catch (err) {
      console.error("save_temp_image failed:", err);
    }
  };
  reader.readAsDataURL(file);
}
async function openTemplateEditor() {
  if (editorVisible) return;
  editorVisible = true;
  const templates = await loadTemplates();
  renderTemplateEditorModal(templates);
}
function closeTemplateEditorModal() {
  editorVisible = false;
  const overlay = document.getElementById("tmpl-modal-overlay");
  overlay?.remove();
}
async function loadTemplates() {
  try {
    return await invoke4("get_prompt_templates");
  } catch {
    return [];
  }
}
function applyTemplate(prefix) {
  const input = document.querySelector(".composer textarea");
  if (!input) return;
  const hasContent = input.value.trim().length > 0;
  input.value = hasContent ? input.value + "\n" + prefix : prefix;
  input.focus();
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function renderTemplateEditorModal(templates) {
  document.getElementById("tmpl-modal-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "tmpl-modal-overlay";
  overlay.id = "tmpl-modal-overlay";
  overlay.innerHTML = `
    <div class="tmpl-modal">
      <div class="tmpl-modal-header">
        <span class="tmpl-modal-title">\u81EA\u5B9A\u4E49\u6A21\u677F</span>
        <button class="tmpl-modal-close" id="tmpl-modal-close-btn">\u2715</button>
      </div>
      <div class="tmpl-modal-body" id="tmpl-modal-body">
        <button class="tmpl-add-btn" id="tmpl-add-btn">+ \u6DFB\u52A0\u81EA\u5B9A\u4E49\u6A21\u677F</button>
        <div id="tmpl-list"></div>
        <div id="tmpl-editor-area" style="display:none;"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeTemplateEditorModal();
  });
  document.getElementById("tmpl-modal-close-btn")?.addEventListener("click", closeTemplateEditorModal);
  renderTemplateList(templates);
  document.getElementById("tmpl-add-btn")?.addEventListener("click", () => {
    editingTemplate = null;
    showTemplateForm("");
  });
}
function renderTemplateList(templates) {
  const list = document.getElementById("tmpl-list");
  if (!list) return;
  const customTemplates = templates.filter((t) => t.category === "custom");
  if (customTemplates.length === 0) {
    list.innerHTML = '<div class="tmpl-empty">\u6682\u65E0\u81EA\u5B9A\u4E49\u6A21\u677F\uFF0C\u70B9\u51FB\u4E0A\u65B9\u6309\u94AE\u6DFB\u52A0</div>';
    return;
  }
  list.innerHTML = "";
  for (const tmpl of customTemplates) {
    const item = document.createElement("div");
    item.className = "tmpl-item";
    item.dataset.id = tmpl.id;
    item.innerHTML = `
      <div class="tmpl-item-header">
        <span class="tmpl-item-name">${escapeHtml3(tmpl.name)}</span>
        <div class="tmpl-item-actions">
          <button class="tmpl-item-btn edit-btn" data-id="${tmpl.id}">\u7F16\u8F91</button>
          <button class="tmpl-item-btn delete delete-btn" data-id="${tmpl.id}">\u5220\u9664</button>
        </div>
      </div>
      <div class="tmpl-item-preview">${escapeHtml3(tmpl.prefix)}</div>
    `;
    list.appendChild(item);
  }
  list.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const tmpl = customTemplates.find((t) => t.id === id);
      editingTemplate = tmpl;
      showTemplateForm(tmpl.prefix, tmpl.name);
    });
  });
  list.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (!confirm("\u786E\u5B9A\u5220\u9664\u8BE5\u6A21\u677F\uFF1F")) return;
      try {
        await invoke4("delete_prompt_template", { id });
        const all = await loadTemplates();
        renderTemplateList(all);
      } catch (err) {
        console.error("delete_prompt_template failed:", err);
      }
    });
  });
}
function showTemplateForm(initialPrefix = "", initialName = "") {
  const area = document.getElementById("tmpl-editor-area");
  const list = document.getElementById("tmpl-list");
  if (!area || !list) return;
  list.style.display = "none";
  const addBtn = document.getElementById("tmpl-add-btn");
  if (addBtn) addBtn.style.display = "none";
  area.style.display = "block";
  area.innerHTML = `
    <div class="tmpl-editor-form">
      <div class="tmpl-form-row">
        <label class="tmpl-form-label">\u540D\u79F0</label>
        <input class="tmpl-form-input" id="tmpl-name-input" type="text" placeholder="\u6A21\u677F\u540D\u79F0\uFF0C\u5982\uFF1A\u603B\u7ED3" value="${escapeHtml3(initialName)}" />
      </div>
      <div>
        <label class="tmpl-form-label" style="display:block;margin-bottom:4px;">\u524D\u7F00\u6587\u672C</label>
        <textarea class="tmpl-form-textarea" id="tmpl-prefix-input" placeholder="\u5982\uFF1A\u8BF7\u603B\u7ED3\u4EE5\u4E0B\u5185\u5BB9\uFF1A

">${escapeHtml3(initialPrefix)}</textarea>
      </div>
      <div class="tmpl-form-actions">
        <button class="tmpl-btn-cancel" id="tmpl-form-cancel">\u53D6\u6D88</button>
        <button class="tmpl-btn-save" id="tmpl-form-save">\u4FDD\u5B58</button>
      </div>
    </div>
  `;
  area.querySelector("#tmpl-form-cancel")?.addEventListener("click", () => {
    area.style.display = "none";
    if (list) list.style.display = "";
    if (addBtn) addBtn.style.display = "";
    editingTemplate = null;
  });
  area.querySelector("#tmpl-form-save")?.addEventListener("click", async () => {
    const nameInput = document.getElementById("tmpl-name-input");
    const prefixInput = document.getElementById("tmpl-prefix-input");
    const name = nameInput?.value.trim();
    const prefix = prefixInput?.value ?? "";
    if (!name) {
      nameInput?.focus();
      return;
    }
    const id = editingTemplate?.id ?? `custom_${Date.now()}`;
    try {
      await invoke4("save_prompt_template", {
        input: { id, name, prefix }
      });
      area.style.display = "none";
      if (list) list.style.display = "";
      if (addBtn) addBtn.style.display = "";
      editingTemplate = null;
      const all = await loadTemplates();
      renderTemplateList(all);
    } catch (err) {
      console.error("save_prompt_template failed:", err);
    }
  });
}
function buildTemplateBar(templates) {
  const composer = document.querySelector(".composer");
  if (!composer) return;
  const bar = document.createElement("div");
  bar.className = "template-bar";
  bar.id = "template-bar";
  let html = templates.filter((t) => t.category === "builtin").map(
    (t) => `<button class="tmpl-pill builtin" data-prefix="${escapeHtml3(t.prefix)}" title="${escapeHtml3(t.name)}">${escapeHtml3(t.name)}</button>`
  ).join("");
  const customTemplates = templates.filter((t) => t.category === "custom");
  html += customTemplates.map(
    (t) => `<button class="tmpl-pill custom" data-prefix="${escapeHtml3(t.prefix)}" title="${escapeHtml3(t.name)}">${escapeHtml3(t.name)}</button>`
  ).join("");
  html += `<button class="tmpl-settings" id="tmpl-settings-btn" title="\u7BA1\u7406\u81EA\u5B9A\u4E49\u6A21\u677F">\u2699</button>`;
  bar.innerHTML = html;
  const toolbar = composer.querySelector(".composer-toolbar");
  if (toolbar && toolbar.nextSibling) {
    composer.insertBefore(bar, toolbar.nextSibling);
  } else {
    composer.insertBefore(bar, composer.firstChild);
  }
  bar.querySelectorAll(".tmpl-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      const prefix = pill.dataset.prefix ?? "";
      applyTemplate(prefix);
    });
  });
  document.getElementById("tmpl-settings-btn")?.addEventListener("click", () => {
    void openTemplateEditor();
  });
}
function setupInputBox() {
  injectStyles();
  buildFileCardsContainer();
  buildImageCardsContainer();
  buildComposerToolbar();
  setupMentionPicker();
  const composer = document.querySelector(".composer");
  composer?.addEventListener("paste", handleImagePaste);
}
async function setupTemplateBar() {
  const templates = await loadTemplates();
  buildTemplateBar(templates);
}
function buildComposerToolbar() {
  const composer = document.querySelector(".composer");
  if (!composer) return;
  const toolbar = document.createElement("div");
  toolbar.className = "composer-toolbar";
  toolbar.innerHTML = `
    <div class="attach-menu">
      <button type="button" class="btn-attach" id="btn-attach" title="\u6DFB\u52A0\u9644\u4EF6" aria-haspopup="true" aria-expanded="false">
        \u{1F4CE}
      </button>
      <div class="attach-dropdown" id="attach-dropdown" role="menu">
        <div class="attach-dropdown-section">\u672C\u5730\u6587\u4EF6</div>
        <div class="attach-submenu">
          <button type="button" class="attach-item" id="attach-local-ref">
            <span class="attach-item-icon">\u270F\uFE0F</span>
            <span class="attach-item-text">\u5F15\u7528\uFF08\u53EF\u8BFB\u5199\uFF09</span>
            <span class="attach-item-badge">\u63A8\u8350</span>
          </button>
          <div class="attach-submenu-items" id="local-submenu">
            <button type="button" class="attach-submenu-item" id="pick-ref">
              \u{1F4C4} \u5F15\u7528\uFF08\u53EF\u8BFB\u5199\uFF09
            </button>
            <button type="button" class="attach-submenu-item" id="pick-copy">
              \u{1F4E4} \u53D1\u9001\uFF08\u53EA\u8BFB\u526F\u672C\uFF09
            </button>
          </div>
        </div>
        <div style="border-top: 1px solid var(--border-soft); margin: 4px 0;"></div>
        <div class="attach-dropdown-section">\u4E91\u6587\u4EF6</div>
        <button type="button" class="attach-item disabled" id="attach-cloud" title="Phase 2 \u5B9E\u73B0">
          <span class="attach-item-icon">\u2601\uFE0F</span>
          <span class="attach-item-text">\u4E91\u6587\u4EF6</span>
          <span class="attach-item-badge">\u5F85\u5B9E\u73B0</span>
        </button>
        <div style="border-top: 1px solid var(--border-soft); margin: 4px 0;"></div>
        <div class="attach-dropdown-section">\u7FA4\u7EC4</div>
        <button type="button" class="attach-item" id="attach-group" title="\u521B\u5EFA\u7FA4\u804A">
          <span class="attach-item-icon">\u{1F465}</span>
          <span class="attach-item-text">\u521B\u5EFA\u7FA4\u804A</span>
        </button>
      </div>
    </div>
    <button type="button" class="btn-qr-upload" id="btn-qr-upload" title="\u626B\u7801\u4E0A\u4F20" aria-label="\u626B\u7801\u4E0A\u4F20">
      \u{1F4F1}
    </button>
  `;
  const textarea = composer.querySelector("textarea");
  composer.insertBefore(toolbar, textarea);
  const btn = document.getElementById("btn-attach");
  btn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  const submenu = document.getElementById("attach-local-ref");
  submenu?.addEventListener("mouseenter", () => {
    const sm = document.getElementById("local-submenu");
    if (sm) sm.style.display = "block";
  });
  const submenuEl = document.getElementById("local-submenu");
  if (submenuEl) {
    submenuEl.style.display = "none";
  }
  document.getElementById("pick-ref")?.addEventListener("click", () => {
    void pickFile("reference");
  });
  document.getElementById("pick-copy")?.addEventListener("click", () => {
    void pickFile("send_copy");
  });
  document.getElementById("attach-cloud")?.addEventListener("click", () => {
    openCloudBrowser();
  });
  document.getElementById("attach-group")?.addEventListener("click", () => {
    closeMenu();
    Promise.resolve().then(() => (init_create_dialog(), create_dialog_exports)).then(({ openCreateDialog: openCreateDialog2 }) => {
      openCreateDialog2("group");
    });
  });
  document.getElementById("btn-qr-upload")?.addEventListener("click", () => {
    Promise.resolve().then(() => (init_qr_upload(), qr_upload_exports)).then(({ openQrUploadDialog: openQrUploadDialog2 }) => {
      openQrUploadDialog2();
    });
  });
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!target.closest(".attach-menu")) {
      closeMenu();
    }
  });
}
function buildFileCardsContainer() {
  const composer = document.querySelector(".composer");
  if (!composer) return;
  const container = document.createElement("div");
  container.id = "file-cards";
  container.className = "file-cards";
  container.style.display = "none";
  const textarea = composer.querySelector("textarea");
  composer.insertBefore(container, textarea);
}
function escapeHtml3(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function getActiveMentionInput() {
  return document.querySelector("#input");
}
function injectMentionStyles() {
  if (document.getElementById("mention-picker-styles")) return;
  const style = document.createElement("style");
  style.id = "mention-picker-styles";
  style.textContent = `
.mention-picker {
  position: absolute;
  z-index: 1100;
  min-width: 200px;
  max-width: 320px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.25);
  padding: 4px;
  display: none;
}
.mention-picker.visible { display: block; }
.mention-picker-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  color: var(--text);
  transition: background 0.1s;
}
.mention-picker-item:hover,
.mention-picker-item.active {
  background: var(--bg-hover);
}
.mention-picker-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: white;
  background: #6366f1;
  flex-shrink: 0;
}
.mention-picker-name {
  font-weight: 500;
}
.mention-picker-hash {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: 6px;
}
.mention-picker-empty {
  padding: 12px;
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
}
`;
  document.head.appendChild(style);
}
function ensureMentionPicker() {
  if (mentionPickerEl) return mentionPickerEl;
  const el = document.createElement("div");
  el.id = "mention-picker";
  el.className = "mention-picker";
  el.setAttribute("role", "listbox");
  document.body.appendChild(el);
  mentionPickerEl = el;
  return el;
}
function positionMentionPicker() {
  if (!mentionPickerEl || !mentionPickerInput) return;
  const rect = mentionPickerInput.getBoundingClientRect();
  mentionPickerEl.style.left = `${rect.left + 14}px`;
  mentionPickerEl.style.top = `${rect.top - 4}px`;
  mentionPickerEl.style.transform = "translateY(-100%)";
}
function renderMentionPicker(filtered) {
  if (!mentionPickerEl) return;
  if (filtered.length === 0) {
    mentionPickerEl.innerHTML = `<div class="mention-picker-empty">\u6CA1\u6709\u5339\u914D\u7684\u6210\u5458</div>`;
    return;
  }
  mentionPickerEl.innerHTML = filtered.map((c, i) => {
    const color = pickAvatarColor(c.agent_hash);
    const letter = (c.agent_name || c.agent_hash || "?").charAt(0).toUpperCase();
    return `<div class="mention-picker-item${i === mentionPickerIndex ? " active" : ""}"
        data-hash="${escapeHtml3(c.agent_hash)}"
        data-name="${escapeHtml3(c.agent_name)}"
        role="option"
        aria-selected="${i === mentionPickerIndex}">
        <span class="mention-picker-avatar" style="background:${color};">${escapeHtml3(letter)}</span>
        <span class="mention-picker-name">${escapeHtml3(c.agent_name)}</span>
        <span class="mention-picker-hash">${escapeHtml3(c.agent_hash.slice(0, 6))}</span>
      </div>`;
  }).join("");
  mentionPickerEl.querySelectorAll(".mention-picker-item").forEach((el) => {
    el.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      const hash = el.dataset.hash ?? "";
      const name = el.dataset.name ?? "";
      if (hash && name) commitMention(name, hash);
    });
    el.addEventListener("mouseenter", () => {
      const items = mentionPickerEl?.querySelectorAll(".mention-picker-item") ?? [];
      items.forEach((it, idx) => {
        if (it === el) {
          mentionPickerIndex = idx;
          it.classList.add("active");
          it.setAttribute("aria-selected", "true");
        } else {
          it.classList.remove("active");
          it.setAttribute("aria-selected", "false");
        }
      });
    });
  });
}
function pickAvatarColor(seed) {
  const palette = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#a855f7", "#ec4899", "#14b8a6"];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = h * 31 + seed.charCodeAt(i) >>> 0;
  return palette[h % palette.length];
}
function showMentionPicker(query) {
  injectMentionStyles();
  const el = ensureMentionPicker();
  mentionPickerInput = getActiveMentionInput();
  if (!mentionPickerInput) return;
  mentionPickerQuery = query;
  mentionPickerIndex = 0;
  const lc = query.toLowerCase();
  mentionPickerCandidates = mentionCandidatesForActiveGroup().filter(
    (c) => !lc || c.agent_name.toLowerCase().includes(lc)
  );
  renderMentionPicker(mentionPickerCandidates);
  el.classList.add("visible");
  mentionPickerVisible = true;
  positionMentionPicker();
}
function hideMentionPicker() {
  if (!mentionPickerEl) return;
  mentionPickerEl.classList.remove("visible");
  mentionPickerVisible = false;
}
function currentMentionQuery() {
  const input = mentionPickerInput ?? getActiveMentionInput();
  if (!input) return null;
  const value = input.value;
  const caret = input.selectionStart ?? 0;
  let i = caret;
  while (i > 0) {
    const ch = value.charAt(i - 1);
    if (ch === "@") {
      const after = value.substring(caret, value.length);
      if (after && !/^\s/.test(after)) {
      }
      return { query: value.substring(i, caret), start: i - 1 };
    }
    if (/\s/.test(ch)) {
      return null;
    }
    i--;
  }
  return null;
}
function commitMention(name, hash) {
  const input = getActiveMentionInput();
  if (!input) return;
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.substring(0, caret);
  const afterQuery = currentMentionQuery();
  const insertStart = afterQuery ? afterQuery.start : caret;
  const after = input.value.substring(caret);
  const inserted = `@${name} `;
  input.value = before.substring(0, insertStart) + inserted + after;
  const newCaret = insertStart + inserted.length;
  input.selectionStart = input.selectionEnd = newCaret;
  input.focus();
  if (!pendingMentions.some((m) => m.hash === hash && m.name === name)) {
    pendingMentions.push({ name, hash });
  }
  hideMentionPicker();
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function mentionCandidatesForActiveGroup() {
  const g = window;
  if (g.__FECLAW_MENTION_CANDIDATES__ && g.__FECLAW_MENTION_CANDIDATES__.length > 0) {
    return g.__FECLAW_MENTION_CANDIDATES__;
  }
  return [];
}
function setupMentionPicker() {
  injectMentionStyles();
  const input = getActiveMentionInput();
  if (!input) return;
  input.addEventListener("keydown", (e) => {
    if (mentionPickerVisible) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (mentionPickerCandidates.length === 0) return;
        mentionPickerIndex = (mentionPickerIndex + 1) % mentionPickerCandidates.length;
        renderMentionPicker(mentionPickerCandidates);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (mentionPickerCandidates.length === 0) return;
        mentionPickerIndex = (mentionPickerIndex - 1 + mentionPickerCandidates.length) % mentionPickerCandidates.length;
        renderMentionPicker(mentionPickerCandidates);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (mentionPickerCandidates.length > 0) {
          e.preventDefault();
          const chosen = mentionPickerCandidates[mentionPickerIndex];
          if (chosen) commitMention(chosen.agent_name, chosen.agent_hash);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideMentionPicker();
        return;
      }
    }
    if (e.key === "@") {
      setTimeout(() => {
        if (!mentionPickerVisible) {
          showMentionPicker("");
        }
      }, 0);
    }
  });
  input.addEventListener("input", () => {
    if (!mentionPickerVisible) return;
    const m = currentMentionQuery();
    if (m === null) {
      hideMentionPicker();
      return;
    }
    if (m.query !== mentionPickerQuery) {
      showMentionPicker(m.query);
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(() => hideMentionPicker(), 150);
  });
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (mentionPickerEl && !mentionPickerEl.contains(t) && t !== input) {
      hideMentionPicker();
    }
  });
}
function setMentionCandidates(candidates) {
  window.__FECLAW_MENTION_CANDIDATES__ = candidates;
  if (mentionPickerVisible) {
    showMentionPicker(mentionPickerQuery);
  }
}
function getActiveMentions() {
  if (pendingMentions.length === 0) return [];
  const input = getActiveMentionInput();
  const text = (input?.value ?? "").trim();
  if (!text) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const m of pendingMentions) {
    if (seen.has(m.hash)) continue;
    if (text.includes(`@${m.name}`)) {
      out.push(m.hash);
      seen.add(m.hash);
    }
  }
  return out;
}
function clearActiveMentions() {
  pendingMentions.length = 0;
}
var invoke4, fileCards, imageCards, menuVisible, editorVisible, editingTemplate, pendingMentions, mentionPickerVisible, mentionPickerEl, mentionPickerCandidates, mentionPickerIndex, mentionPickerQuery, mentionPickerInput;
var init_input_box = __esm({
  "src/chat/components/input-box.ts"() {
    invoke4 = (cmd, args) => getTauri4().invoke(cmd, args);
    fileCards = [];
    imageCards = [];
    menuVisible = false;
    editorVisible = false;
    editingTemplate = null;
    pendingMentions = [];
    mentionPickerVisible = false;
    mentionPickerEl = null;
    mentionPickerCandidates = [];
    mentionPickerIndex = 0;
    mentionPickerQuery = "";
    mentionPickerInput = null;
  }
});

// src/chat/components/send-dialog.ts
function getTauri5() {
  const g = window.__TAURI__;
  if (!g?.core) throw new Error("Tauri global not available");
  return g.core;
}
function injectStyles2() {
  if (document.getElementById("sd-styles")) return;
  const style = document.createElement("style");
  style.id = "sd-styles";
  style.textContent = `
/* Send Dialog */
.send-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.send-dialog {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 16px;
  width: 460px;
  max-width: 95vw;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: sdIn 0.2s ease-out;
}
@keyframes sdIn {
  from { opacity: 0; transform: scale(0.94) translateY(8px); }
  to   { opacity: 1; transform: scale(1) translateY(0); }
}
.send-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border-soft);
  flex-shrink: 0;
}
.send-dialog-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.send-dialog-close {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s;
}
.send-dialog-close:hover { background: var(--bg-hover); color: var(--text); }

.send-dialog-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
}

/* File preview row */
.sd-file-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--bg);
  border: 1px solid var(--border-soft);
}
.sd-file-icon { font-size: 28px; flex-shrink: 0; }
.sd-file-info { flex: 1; min-width: 0; }
.sd-file-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sd-file-size { font-size: 12px; color: var(--text-muted); margin-top: 2px; }

/* Mode selection */
.sd-section-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}
.sd-mode-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sd-mode-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-soft);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
  font-size: 14px;
  color: var(--text);
}
.sd-mode-option:hover { background: var(--bg-hover); }
.sd-mode-option.selected {
  border-color: var(--primary);
  background: rgba(56, 189, 248, 0.08);
}
.sd-mode-option input[type="radio"] { display: none; }
.sd-mode-radio {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid var(--border);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.12s;
}
.sd-mode-option.selected .sd-mode-radio {
  border-color: var(--primary);
}
.sd-mode-radio::after {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--primary);
  opacity: 0;
  transition: opacity 0.12s;
}
.sd-mode-option.selected .sd-mode-radio::after { opacity: 1; }
.sd-mode-label { flex: 1; }
.sd-mode-desc { font-size: 11px; color: var(--text-muted); margin-top: 1px; }

/* Agent dropdown */
.sd-agent-select {
  width: 100%;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 14px;
  outline: none;
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  padding-right: 36px;
}
.sd-agent-select:focus { border-color: var(--primary); }

/* Message textarea */
.sd-message-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
}
.sd-message-textarea {
  width: 100%;
  min-height: 80px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 14px;
  outline: none;
  resize: vertical;
  box-sizing: border-box;
}
.sd-message-textarea:focus { border-color: var(--primary); }

/* Footer */
.send-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px 18px;
  border-top: 1px solid var(--border-soft);
  flex-shrink: 0;
}
.sd-btn-cancel {
  padding: 8px 18px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  font-family: inherit;
  transition: background 0.12s, color 0.12s;
}
.sd-btn-cancel:hover { background: var(--bg-hover); color: var(--text); }
.sd-btn-send {
  padding: 8px 20px;
  border-radius: 8px;
  border: none;
  background: var(--primary);
  color: white;
  cursor: pointer;
  font-size: 14px;
  font-family: inherit;
  font-weight: 500;
  transition: background 0.12s;
}
.sd-btn-send:hover { background: var(--primary-dark); }
.sd-btn-send:disabled { opacity: 0.5; cursor: not-allowed; }
`;
  document.head.appendChild(style);
}
function formatBytes2(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
function escapeHtml4(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function getFileNameFromPath(path) {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? path;
}
function getFileExt(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.substring(i + 1).toLowerCase() : "";
}
function getFileEmoji(name) {
  const ext = getFileExt(name);
  const map = {
    pdf: "\u{1F4C4}",
    doc: "\u{1F4DD}",
    docx: "\u{1F4DD}",
    txt: "\u{1F4C3}",
    md: "\u{1F4CB}",
    xls: "\u{1F4CA}",
    xlsx: "\u{1F4CA}",
    csv: "\u{1F4CA}",
    ppt: "\u{1F4FD}\uFE0F",
    pptx: "\u{1F4FD}\uFE0F",
    zip: "\u{1F5DC}\uFE0F",
    rar: "\u{1F5DC}\uFE0F",
    "7z": "\u{1F5DC}\uFE0F",
    tar: "\u{1F5DC}\uFE0F",
    gz: "\u{1F5DC}\uFE0F",
    jpg: "\u{1F5BC}\uFE0F",
    jpeg: "\u{1F5BC}\uFE0F",
    png: "\u{1F5BC}\uFE0F",
    gif: "\u{1F5BC}\uFE0F",
    bmp: "\u{1F5BC}\uFE0F",
    webp: "\u{1F5BC}\uFE0F",
    svg: "\u{1F5BC}\uFE0F",
    mp3: "\u{1F3B5}",
    wav: "\u{1F3B5}",
    flac: "\u{1F3B5}",
    aac: "\u{1F3B5}",
    ogg: "\u{1F3B5}",
    mp4: "\u{1F3AC}",
    mkv: "\u{1F3AC}",
    avi: "\u{1F3AC}",
    mov: "\u{1F3AC}",
    wmv: "\u{1F3AC}",
    js: "\u{1F4DC}",
    ts: "\u{1F4DC}",
    py: "\u{1F40D}",
    rs: "\u{1F980}",
    go: "\u{1F535}",
    java: "\u2615",
    html: "\u{1F310}",
    css: "\u{1F3A8}",
    json: "\u{1F4CB}",
    xml: "\u{1F4CB}",
    yaml: "\u{1F4CB}",
    yml: "\u{1F4CB}",
    exe: "\u2699\uFE0F",
    dll: "\u2699\uFE0F"
  };
  return map[ext] ?? "\u{1F4C4}";
}
async function openSendDialog(pending) {
  if (dialogVisible) return;
  dialogVisible = true;
  currentPending = pending;
  currentFileSize = 0;
  injectStyles2();
  try {
    const fileInfo = await invoke5("file_read", { path: pending.path });
    void fileInfo;
  } catch {
  }
  try {
    const resp = await fetch(`file://${pending.path}`);
    if (resp.ok && resp.headers.has("content-length")) {
      currentFileSize = parseInt(resp.headers.get("content-length") ?? "0", 10);
    }
  } catch {
  }
  const fileName = getFileNameFromPath(pending.path);
  const emoji = getFileEmoji(fileName);
  const sizeLabel = currentFileSize > 0 ? formatBytes2(currentFileSize) : "\u672A\u77E5\u5927\u5C0F";
  const mode = pending.mode === "reference" ? "reference" : "send_copy";
  const agents = store.agents;
  renderDialog(fileName, sizeLabel, emoji, mode, agents);
}
function renderDialog(fileName, sizeLabel, emoji, defaultMode, agents) {
  document.getElementById("send-dialog-overlay")?.remove();
  const selectedAgentHash = store.activeAgentHash ?? (agents.length > 0 ? agents[0].hash : null);
  const overlay = document.createElement("div");
  overlay.className = "send-dialog-overlay";
  overlay.id = "send-dialog-overlay";
  overlay.innerHTML = `
    <div class="send-dialog" role="dialog" aria-modal="true" aria-labelledby="sd-title">
      <div class="send-dialog-header">
        <span class="send-dialog-title" id="sd-title">\u53D1\u9001\u6587\u4EF6</span>
        <button class="send-dialog-close" id="sd-close" aria-label="\u5173\u95ED">\u2715</button>
      </div>
      <div class="send-dialog-body">
        <!-- File preview -->
        <div class="sd-file-row">
          <span class="sd-file-icon">${emoji}</span>
          <div class="sd-file-info">
            <div class="sd-file-name" title="${escapeHtml4(fileName)}">${escapeHtml4(fileName)}</div>
            <div class="sd-file-size">${sizeLabel}</div>
          </div>
        </div>

        <!-- Mode selection -->
        <div>
          <div class="sd-section-label">\u53D1\u9001\u65B9\u5F0F</div>
          <div class="sd-mode-options">
            <label class="sd-mode-option ${defaultMode === "reference" ? "selected" : ""}" data-mode="reference">
              <input type="radio" name="sd-mode" value="reference" ${defaultMode === "reference" ? "checked" : ""} />
              <span class="sd-mode-radio"></span>
              <span class="sd-mode-label">
                <div>\u{1F4CE} \u5F15\u7528\uFF08Agent \u53EF\u8BFB\u5199\uFF09</div>
                <div class="sd-mode-desc">\u76F4\u63A5\u5F15\u7528\u6587\u4EF6\uFF0CAgent \u53EF\u4EE5\u8BFB\u53D6\u548C\u4FEE\u6539</div>
              </span>
            </label>
            <label class="sd-mode-option ${defaultMode === "send_copy" ? "selected" : ""}" data-mode="send_copy">
              <input type="radio" name="sd-mode" value="send_copy" ${defaultMode === "send_copy" ? "checked" : ""} />
              <span class="sd-mode-radio"></span>
              <span class="sd-mode-label">
                <div>\u{1F4E4} \u53D1\u9001\uFF08\u53EA\u8BFB\u526F\u672C\uFF09</div>
                <div class="sd-mode-desc">\u53D1\u9001\u6587\u4EF6\u526F\u672C\uFF0CAgent \u53EA\u80FD\u8BFB\u53D6</div>
              </span>
            </label>
          </div>
        </div>

        <!-- Agent selection -->
        <div>
          <div class="sd-section-label">\u53D1\u9001\u5230</div>
          <select class="sd-agent-select" id="sd-agent-select">
            ${agents.map((a) => {
    const sel = a.hash === selectedAgentHash ? "selected" : "";
    return `<option value="${escapeHtml4(a.hash)}" ${sel}>${escapeHtml4(a.name)}</option>`;
  }).join("")}
          </select>
        </div>

        <!-- Message -->
        <div>
          <div class="sd-message-label">\u9644\u52A0\u6D88\u606F\uFF08\u53EF\u9009\uFF09</div>
          <textarea class="sd-message-textarea" id="sd-message"
            placeholder="\u8F93\u5165\u9644\u8A00\u7ED9 Agent\uFF08\u652F\u6301 Ctrl+V \u7C98\u8D34\u56FE\u7247\uFF09"
            rows="3"></textarea>
        </div>
      </div>
      <div class="send-dialog-footer">
        <button class="sd-btn-cancel" id="sd-cancel">\u53D6\u6D88</button>
        <button class="sd-btn-send" id="sd-send">\u53D1\u9001</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelectorAll(".sd-mode-option").forEach((el) => {
    el.addEventListener("click", () => {
      overlay.querySelectorAll(".sd-mode-option").forEach((o) => o.classList.remove("selected"));
      el.classList.add("selected");
      const radio = el.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
    });
  });
  overlay.querySelector("#sd-close")?.addEventListener("click", closeDialog);
  overlay.querySelector("#sd-cancel")?.addEventListener("click", closeDialog);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDialog();
  });
  const escHandler = (e) => {
    if (e.key === "Escape") {
      closeDialog();
      document.removeEventListener("keydown", escHandler);
    }
  };
  document.addEventListener("keydown", escHandler);
  const textarea = overlay.querySelector("#sd-message");
  if (textarea) {
    textarea.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) return;
          void pasteImageIntoTextarea(textarea, file);
          return;
        }
      }
    });
  }
  overlay.querySelector("#sd-send")?.addEventListener("click", () => {
    void handleSend(overlay, fileName, sizeLabel);
  });
  textarea?.focus();
}
async function pasteImageIntoTextarea(textarea, file) {
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const base64 = ev.target?.result;
    if (!base64) return;
    try {
      const info = await invoke5("save_temp_image", { base64Data: base64 });
      const marker = `
[image:${info.temp_path}]`;
      textarea.value += marker;
      textarea.focus();
    } catch (err) {
      console.error("save_temp_image failed:", err);
    }
  };
  reader.readAsDataURL(file);
}
async function handleSend(overlay, fileName, sizeLabel) {
  if (!currentPending) return;
  const selectedMode = overlay.querySelector('input[name="sd-mode"]:checked');
  const mode = selectedMode?.value ?? "send_copy";
  const agentSelect = overlay.querySelector("#sd-agent-select");
  const agentHash = agentSelect?.value ?? store.activeAgentHash;
  if (!agentHash) {
    alert("\u8BF7\u9009\u62E9\u4E00\u4E2A Agent");
    return;
  }
  const messageEl = overlay.querySelector("#sd-message");
  const message = messageEl?.value.trim() ?? "";
  const pickedFile = {
    id: `right-click-${Date.now()}`,
    name: fileName,
    path: currentPending.path,
    size_label: sizeLabel,
    mode,
    size_bytes: currentFileSize
  };
  addCard(pickedFile);
  const { selectChat: selectChat3 } = await Promise.resolve().then(() => (init_chat(), chat_exports));
  await selectChat3(agentHash);
  const input = document.querySelector("#input");
  if (input) {
    input.value = message;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
    input.focus();
  }
  closeDialog();
}
function closeDialog() {
  dialogVisible = false;
  currentPending = null;
  document.getElementById("send-dialog-overlay")?.remove();
}
var invoke5, dialogVisible, currentPending, currentFileSize;
var init_send_dialog = __esm({
  "src/chat/components/send-dialog.ts"() {
    init_store();
    init_input_box();
    invoke5 = (cmd, args) => getTauri5().invoke(cmd, args);
    dialogVisible = false;
    currentPending = null;
    currentFileSize = 0;
  }
});

// src/chat/components/moments-feed.ts
function getTauri6() {
  const g = window.__TAURI__;
  if (!g?.core) throw new Error("Tauri global not available");
  return g.core;
}
function getKindIcon(kind) {
  return KIND_ICONS[kind] ?? KIND_ICONS["default"];
}
function formatRelativeTime(ts) {
  const now = Math.floor(Date.now() / 1e3);
  const diff = now - ts;
  if (diff < 60) return "\u521A\u521A";
  if (diff < 3600) return `${Math.floor(diff / 60)}\u5206\u949F\u524D`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}\u5C0F\u65F6\u524D`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}\u5929\u524D`;
  const d = new Date(ts * 1e3);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function renderAttachmentChip(container, att) {
  if (att.type === "file") {
    const chip = document.createElement("span");
    chip.className = "moment-attachment-chip";
    chip.innerHTML = `<span class="mac-icon">\u{1F4C4}</span><span class="mac-name">${escapeHtml5(att.name)}</span>`;
    chip.addEventListener("click", () => {
      if (att.url) {
        window.open(att.url, "_blank");
      } else if (att.path && store.activeAgentHash) {
        void invoke6("download_vfs_file", {
          agent_hash: store.activeAgentHash,
          path: att.path
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
    let src = "";
    if (att.source === "data" && att.data && isSafeAttachmentSrc(att.data)) {
      src = att.data;
    } else if (att.source === "url" && att.url && isSafeAttachmentSrc(att.url)) {
      src = att.url;
    }
    chip.innerHTML = `<span class="mac-icon">\u{1F5BC}\uFE0F</span><span class="mac-name">${escapeHtml5(att.name ?? "\u56FE\u7247")}</span>`;
    chip.addEventListener("click", () => {
      if (src) window.open(src, "_blank");
    });
    container.appendChild(chip);
  }
}
function isSafeAttachmentSrc(url) {
  return SAFE_URL_PREFIX_RE.test(url.trim());
}
function escapeHtml5(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function buildMomentCard(moment) {
  const card = document.createElement("div");
  card.className = "moment-card";
  card.dataset.momentId = moment.id;
  card.dataset.groupId = moment.group_id;
  const kindIcon = getKindIcon(moment.kind);
  const time = formatRelativeTime(moment.created_at);
  const agentLabel = moment.agent_name ?? "Agent";
  const groupLabel = moment.group_name ?? "\u672A\u77E5\u7FA4";
  const contentSnippet = moment.content.length > 120 ? moment.content.slice(0, 120) + "\u2026" : moment.content;
  card.innerHTML = `
    <div class="mc-header">
      <span class="mc-kind-icon">${kindIcon}</span>
      <span class="mc-group-name">${escapeHtml5(groupLabel)}</span>
    </div>
    <div class="mc-meta">
      <span class="mc-agent">${escapeHtml5(agentLabel)}</span>
      <span class="mc-dot">\xB7</span>
      <span class="mc-time">${time}</span>
    </div>
    <div class="mc-title">${escapeHtml5(moment.title)}</div>
    <div class="mc-content">${escapeHtml5(contentSnippet)}</div>
    <div class="mc-attachments" id="mc-attachments-${moment.id}"></div>
  `;
  const attContainer = card.querySelector(
    `#mc-attachments-${moment.id}`
  );
  if (attContainer && moment.attachments && moment.attachments.length > 0) {
    for (const att of moment.attachments) {
      renderAttachmentChip(attContainer, att);
    }
  }
  const groupNameEl = card.querySelector(".mc-group-name");
  if (groupNameEl) {
    groupNameEl.style.cursor = "pointer";
    groupNameEl.addEventListener("click", () => {
      window.dispatchEvent(
        new CustomEvent("group-selected", {
          detail: { groupId: moment.group_id }
        })
      );
    });
  }
  return card;
}
function renderMomentsFeed(moments) {
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
function populateGroupFilter() {
  const select = document.getElementById(
    "moments-group-filter"
  );
  if (!select) return;
  const groups = store.groups;
  const current = select.value;
  select.innerHTML = `<option value="">\u5168\u90E8\u7FA4</option>`;
  for (const g of groups) {
    const opt = document.createElement("option");
    opt.value = g.id;
    opt.textContent = g.name;
    select.appendChild(opt);
  }
  if (current && [...select.options].some((o) => o.value === current)) {
    select.value = current;
  }
}
async function refreshMoments() {
  try {
    const filter = store.momentsGroupFilter;
    const moments = await invoke6("get_moments", {
      groupId: filter
    });
    store.setMoments(moments);
  } catch (e) {
    console.error("get_moments failed:", e);
  }
}
function showMomentsFeed(groupId) {
  const chatList = document.getElementById("chat-list-panel");
  const momentsFeed = document.getElementById("moments-feed");
  if (!chatList || !momentsFeed) return;
  if (groupId) {
    store.setMomentsGroupFilter(groupId);
  } else {
    store.setMomentsGroupFilter(null);
  }
  populateGroupFilter();
  chatList.style.display = "none";
  momentsFeed.style.display = "flex";
  momentsFeed.style.flexDirection = "column";
  momentsFeed.style.flex = "1";
  momentsFeed.style.overflow = "hidden";
  renderMomentsFeed(store.getMoments());
  void refreshMoments();
}
function hideMomentsFeed() {
  const chatList = document.getElementById("chat-list-panel");
  const momentsFeed = document.getElementById("moments-feed");
  if (!chatList || !momentsFeed) return;
  chatList.style.display = "";
  momentsFeed.style.display = "none";
}
function addMomentCard(moment) {
  const list = document.getElementById("moments-list");
  const empty = document.getElementById("moments-empty");
  if (!list || !empty) return;
  empty.style.display = "none";
  const card = buildMomentCard(moment);
  if (list.firstChild) {
    list.insertBefore(card, list.firstChild);
  } else {
    list.appendChild(card);
  }
  if (store.currentTab !== "moments") {
    showMomentToast(moment);
  }
}
function showMomentToast(moment) {
  const toast = document.getElementById("moments-toast");
  if (toast) {
    toast.textContent = `\u{1F4F1} \u65B0\u52A8\u6001: ${moment.title}`;
    toast.style.opacity = "1";
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.style.opacity = "0";
    }, 3e3);
  }
}
function wireMomentsFeed() {
  const select = document.getElementById(
    "moments-group-filter"
  );
  if (!select) return;
  select.addEventListener("change", () => {
    const value = select.value || null;
    store.setMomentsGroupFilter(value);
    void refreshMoments();
  });
}
var invoke6, KIND_ICONS, SAFE_URL_PREFIX_RE, toastTimeout;
var init_moments_feed = __esm({
  "src/chat/components/moments-feed.ts"() {
    init_store();
    invoke6 = (cmd, args) => getTauri6().invoke(cmd, args);
    KIND_ICONS = {
      task_done: "\u2705",
      file_changed: "\u{1F4C1}",
      analysis: "\u{1F50D}",
      consensus: "\u{1F91D}",
      manual: "\u270D\uFE0F",
      default: "\u{1F4CC}"
    };
    SAFE_URL_PREFIX_RE = /^(https:\/\/|http:\/\/|data:image\/(png|jpe?g|gif|webp);base64,)/i;
    toastTimeout = null;
    store.subscribe((s) => {
      if (s.currentTab !== "moments") return;
      const momentsFeed = document.getElementById("moments-feed");
      if (momentsFeed && momentsFeed.style.display !== "none") {
        renderMomentsFeed(s.getMoments());
      }
    });
  }
});

// src/chat/components/search-overlay.ts
function getTauri7() {
  const g = window.__TAURI__;
  if (!g?.core) throw new Error("Tauri global not available");
  return g.core;
}
function $(id) {
  return document.getElementById(id);
}
function showOverlay() {
  const overlay = $("search-overlay");
  const input = $("search-input");
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
function hideOverlay() {
  const overlay = $("search-overlay");
  if (!overlay) return;
  overlay.style.opacity = "0";
  setTimeout(() => {
    overlay.style.display = "none";
    overlay.style.transition = "";
  }, 150);
  isOpen = false;
  const input = $("search-input");
  if (input) input.value = "";
  clearResults();
  currentQuery = "";
}
function toggleOverlay() {
  if (isOpen) hideOverlay();
  else showOverlay();
}
function clearResults() {
  const results = $("search-results");
  const footer = $("search-footer");
  const empty = $("search-empty");
  if (!results) return;
  results.innerHTML = "";
  if (empty) {
    results.appendChild(empty);
    empty.style.display = "";
  }
  if (footer) footer.style.display = "none";
}
function formatTime(ts) {
  if (!ts) return "";
  const ms = ts < 4102444800 ? ts * 1e3 : ts;
  const d = new Date(ms);
  const now = /* @__PURE__ */ new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 6e4);
  if (diffMin < 1) return "\u521A\u521A";
  if (diffMin < 60) return `${diffMin}\u5206\u949F\u524D`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}\u5C0F\u65F6\u524D`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}\u5929\u524D`;
  return d.toLocaleDateString("zh-CN");
}
function sourceIcon(source) {
  switch (source) {
    case "chat":
      return "\u{1F4AC}";
    case "vfs":
      return "\u{1F4C1}";
    case "moments":
      return "\u{1F4F1}";
    case "textbook":
      return "\u{1F4D6}";
    case "miniapps":
      return "\u{1F680}";
    case "local":
      return "\u{1F5A5}\uFE0F";
    default:
      return "\u{1F4C4}";
  }
}
function renderResults(result) {
  const resultsEl = $("search-results");
  const footer = $("search-footer");
  const stats = $("search-stats");
  if (!resultsEl) return;
  resultsEl.innerHTML = "";
  const allItems = [];
  const bySource = {};
  for (const [src, srcResults] of Object.entries(result.results)) {
    if (srcResults.status !== "ok") continue;
    bySource[src] = srcResults.items;
    allItems.push(...srcResults.items);
  }
  const items = activeSource === "all" ? allItems : bySource[activeSource] ?? [];
  if (items.length === 0) {
    resultsEl.innerHTML = `<div class="search-empty"><span>\u672A\u627E\u5230\u76F8\u5173\u7ED3\u679C</span></div>`;
    if (footer) footer.style.display = "none";
    return;
  }
  items.sort((a, b) => b.score - a.score);
  for (const item of items) {
    const el = document.createElement("div");
    el.className = "search-result-item";
    const icon = sourceIcon(item.source);
    const time = formatTime(item.timestamp);
    const agentLabel = item.agentName ? `${item.agentName} \xB7 ` : item.agentHash ? "\u672A\u77E5 \xB7 " : "";
    const scoreStr = item.score > 0 ? `<span class="sr-score">\u5339\u914D\u5EA6: ${(item.score * 100).toFixed(0)}%</span>` : "";
    el.innerHTML = `
      <div class="sr-icon">${icon}</div>
      <div class="sr-body">
        <div class="sr-meta">${agentLabel}${time}</div>
        <div class="sr-snippet">${escapeHtml6(item.snippet)}</div>
        ${scoreStr}
      </div>
    `;
    el.addEventListener("click", () => {
      navigateToResult(item);
      hideOverlay();
    });
    resultsEl.appendChild(el);
  }
  updateTabCounts(bySource);
  if (footer && stats) {
    const totalCount = allItems.length;
    footer.style.display = "";
    stats.textContent = `\u5171 ${totalCount} \u4E2A\u7ED3\u679C \xB7 ${(result.elapsed_ms / 1e3).toFixed(2)}s`;
  }
}
function updateTabCounts(bySource) {
  const tabs = document.querySelectorAll(".search-tab");
  tabs.forEach((tab) => {
    const src = tab.dataset.source ?? "all";
    let count = 0;
    if (src === "all") {
      count = Object.values(bySource).reduce((s, arr) => s + arr.length, 0);
    } else {
      count = bySource[src]?.length ?? 0;
    }
    const label = tab.textContent?.replace(/ \(\d+\)/, "") ?? "";
    tab.textContent = count > 0 ? `${label} (${count})` : label;
  });
}
function escapeHtml6(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function navigateToResult(item) {
  if (item.source === "chat" || item.source === "vfs" || item.source === "moments") {
    const detail = {
      agentHash: item.agentHash ?? "",
      messageId: item.id
    };
    window.dispatchEvent(new CustomEvent("navigate-to-chat", { detail }));
  } else if (item.reference) {
    const detail = { reference: item.reference };
    window.dispatchEvent(new CustomEvent("navigate-to-reference", { detail }));
  }
}
async function doSearch(query) {
  if (!query.trim()) {
    clearResults();
    return;
  }
  const [cloudResult, localFileItems] = await Promise.allSettled([
    invoke7("search_all", { query }),
    invoke7("search_local_files", { query })
  ]);
  let result;
  if (cloudResult.status === "fulfilled") {
    result = cloudResult.value;
  } else {
    console.warn("search_all failed (offline?):", cloudResult.reason);
    result = {
      query,
      results: {},
      elapsed_ms: 0
    };
  }
  if (localFileItems.status === "fulfilled" && localFileItems.value.length > 0) {
    const items = localFileItems.value.map((f) => ({
      id: String(f.id),
      snippet: `${f.file_name} \u2014 ${f.snippet}`,
      score: 0.9,
      timestamp: f.modified_at,
      source: "local",
      reference: f.file_path
    }));
    result.results["local"] = { status: "ok", items };
  }
  renderResults(result);
}
function onInput(e) {
  const input = e.target;
  currentQuery = input.value;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void doSearch(currentQuery);
  }, 300);
}
function onTabClick(e) {
  const btn = e.target.closest(".search-tab");
  if (!btn) return;
  const src = btn.dataset.source ?? "all";
  activeSource = src;
  document.querySelectorAll(".search-tab").forEach((t) => t.classList.remove("active"));
  btn.classList.add("active");
  if (currentQuery) {
    void doSearch(currentQuery);
  }
}
function onKeyDown(e) {
  if (e.key === "Escape") {
    hideOverlay();
  } else if (e.key === "Enter" && currentQuery) {
    if (debounceTimer) clearTimeout(debounceTimer);
    void doSearch(currentQuery);
  }
}
function onBackdropClick(e) {
  if (e.target === e.currentTarget) {
    hideOverlay();
  }
}
async function setupSearchOverlay() {
  try {
    await listen2("toggle-search-overlay", () => {
      toggleOverlay();
    });
  } catch (e) {
    console.error("listen toggle-search-overlay:", e);
  }
  const input = $("search-input");
  if (input) {
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", onKeyDown);
  }
  const tabsEl = $("search-tabs");
  if (tabsEl) {
    tabsEl.addEventListener("click", onTabClick);
  }
  const closeBtn = $("search-close");
  if (closeBtn) {
    closeBtn.addEventListener("click", hideOverlay);
  }
  const backdrop = $("search-backdrop");
  if (backdrop) {
    backdrop.addEventListener("click", onBackdropClick);
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) {
      hideOverlay();
    }
    if (e.key === " " && e.altKey && isOpen) {
      e.preventDefault();
      hideOverlay();
    }
  });
}
var invoke7, listen2, isOpen, currentQuery, activeSource, debounceTimer;
var init_search_overlay = __esm({
  "src/chat/components/search-overlay.ts"() {
    invoke7 = (cmd, args) => getTauri7().invoke(cmd, args);
    listen2 = (event, handler) => getTauri7().listen(event, handler);
    isOpen = false;
    currentQuery = "";
    activeSource = "all";
    debounceTimer = null;
  }
});

// src/chat/components/fehub-tab.ts
function getTauri8() {
  const g = window.__TAURI__;
  if (!g?.core) throw new Error("Tauri global not available");
  return g.core;
}
function $2(id) {
  return document.getElementById(id);
}
function formatDate(ts) {
  const d = new Date(ts * 1e3);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function openPublishDialog(publish) {
  const existing = $2("fehub-publish-dialog");
  if (existing) existing.remove();
  const overlay = document.createElement("div");
  overlay.className = "fehub-dialog-overlay";
  overlay.id = "fehub-publish-dialog";
  const title = publish ? "\u53D1\u5E03\u65B0\u7248\u672C" : "\u4ECE\u6A21\u677F\u521B\u5EFA";
  overlay.innerHTML = `
    <div class="fehub-dialog">
      <div class="fehub-dialog-header">
        <span class="fehub-dialog-title">${title}</span>
        <button class="fehub-dialog-close" id="fehub-dialog-close">\u2715</button>
      </div>
      <div class="fehub-dialog-body">
        <div class="fehub-dialog-field">
          <label class="fehub-dialog-label">\u7248\u672C\u6807\u7B7E</label>
          <input
            type="text"
            class="fehub-dialog-input"
            id="fehub-dialog-tag"
            placeholder="\u5982 v1.0.0"
            value="${publish?.tag ?? ""}"
          />
        </div>
        <div class="fehub-dialog-field">
          <label class="fehub-dialog-label">\u8BBF\u95EE\u6743\u9650</label>
          <div class="fehub-dialog-visibility">
            <label class="fehub-visibility-option">
              <input
                type="radio"
                name="fehub-visibility"
                value="public"
                ${publish?.is_public !== false ? "checked" : ""}
              />
              <span>\u{1F310} \u516C\u6709</span>
              <small>\u6240\u6709\u4EBA\u90FD\u53EF\u4EE5\u8BBF\u95EE</small>
            </label>
            <label class="fehub-visibility-option">
              <input
                type="radio"
                name="fehub-visibility"
                value="private"
                ${publish?.is_public === false ? "checked" : ""}
              />
              <span>\u{1F512} \u79C1\u6709</span>
              <small>\u4EC5\u81EA\u5DF1\u53EF\u8BBF\u95EE</small>
            </label>
          </div>
        </div>
      </div>
      <div class="fehub-dialog-footer">
        <button class="btn btn-secondary" id="fehub-dialog-cancel">\u53D6\u6D88</button>
        <button class="btn btn-primary" id="fehub-dialog-confirm" ${publish ? "" : "disabled"}>\u786E\u8BA4\u53D1\u5E03</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const closeDialog2 = () => overlay.remove();
  $2("fehub-dialog-close")?.addEventListener("click", closeDialog2);
  $2("fehub-dialog-cancel")?.addEventListener("click", closeDialog2);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDialog2();
  });
  $2("fehub-dialog-confirm")?.addEventListener("click", async () => {
    const tagInput = $2("fehub-dialog-tag");
    const visInput = document.querySelector(
      'input[name="fehub-visibility"]:checked'
    );
    if (!tagInput?.value.trim()) return;
    const tag = tagInput.value.trim();
    const isPublic = visInput?.value === "public";
    try {
      if (publish) {
        console.log("publish new version:", publish.app_name, tag, isPublic);
      }
      closeDialog2();
      void refreshFehubTab();
    } catch (e) {
      alert(`\u64CD\u4F5C\u5931\u8D25\uFF1A${e}`);
    }
  });
}
function renderPublishCard(pub) {
  const card = document.createElement("div");
  card.className = "fehub-card";
  card.dataset.appName = pub.app_name;
  const visibilityClass = pub.is_public ? "public" : "private";
  const visibilityLabel = pub.is_public ? "\u{1F310} \u516C\u6709" : "\u{1F512} \u79C1\u6709";
  card.innerHTML = `
    <div class="fehub-card-icon">\u{1F4F1}</div>
    <div class="fehub-card-info">
      <div class="fehub-card-name">${escapeHtml7(pub.app_name)}</div>
      <div class="fehub-card-meta">
        <span class="fehub-card-tag">${escapeHtml7(pub.tag)}</span>
        <span class="fehub-visibility-badge ${visibilityClass}">${visibilityLabel}</span>
      </div>
      <div class="fehub-card-date">${formatDate(pub.created_at)}</div>
    </div>
    <div class="fehub-card-actions">
      <button class="fehub-btn fehub-btn-open" data-app="${escapeHtml7(pub.app_name)}">\u6253\u5F00</button>
      <button class="fehub-btn fehub-btn-version" data-app="${escapeHtml7(pub.app_name)}">\u53D1\u5E03\u65B0\u7248\u672C</button>
      <button class="fehub-btn fehub-btn-toggle" data-app="${escapeHtml7(pub.app_name)}" data-public="${pub.is_public}">
        ${pub.is_public ? "\u8F6C\u4E3A\u79C1\u6709" : "\u516C\u5F00"}
      </button>
    </div>
  `;
  card.querySelector(".fehub-btn-open")?.addEventListener("click", () => {
    void openMiniapp(pub.app_name);
  });
  card.querySelector(".fehub-btn-version")?.addEventListener("click", () => {
    openPublishDialog(pub);
  });
  card.querySelector(".fehub-btn-toggle")?.addEventListener("click", () => {
    void toggleVisibility(pub);
  });
  return card;
}
async function openMiniapp(appName) {
  try {
    await invoke8("open_miniapp", { appName });
  } catch (e) {
    alert(`\u6253\u5F00\u5931\u8D25\uFF1A${e}`);
  }
}
async function toggleVisibility(pub) {
  try {
    console.log("toggle visibility:", pub.app_name, !pub.is_public);
    void refreshFehubTab();
  } catch (e) {
    alert(`\u64CD\u4F5C\u5931\u8D25\uFF1A${e}`);
  }
}
function renderFehubContent(publishes) {
  const container = $2("fehub-content");
  if (!container) return;
  if (publishes.length === 0) {
    container.innerHTML = `
      <div class="fehub-empty">
        <div class="fehub-empty-icon">\u{1F4E6}</div>
        <h3>\u6682\u65E0\u5DF2\u53D1\u5E03\u7684\u5C0F\u7A0B\u5E8F</h3>
        <p>\u4ECE\u6A21\u677F\u521B\u5EFA\u4E00\u4E2A\u65B0\u7684\u5C0F\u7A0B\u5E8F\uFF0C\u5F00\u59CB\u4F60\u7684 FeHub \u4E4B\u65C5</p>
        <button class="btn btn-primary" id="fehub-create-from-template">+ \u4ECE\u6A21\u677F\u521B\u5EFA</button>
      </div>
    `;
    $2("fehub-create-from-template")?.addEventListener("click", () => {
      openPublishDialog();
    });
    return;
  }
  const list = document.createElement("div");
  list.className = "fehub-list";
  for (const pub of publishes) {
    list.appendChild(renderPublishCard(pub));
  }
  const footer = document.createElement("div");
  footer.className = "fehub-footer";
  footer.innerHTML = `<button class="btn btn-secondary" id="fehub-create-from-template">+ \u4ECE\u6A21\u677F\u521B\u5EFA</button>`;
  footer.querySelector("#fehub-create-from-template")?.addEventListener("click", () => {
    openPublishDialog();
  });
  container.innerHTML = "";
  container.appendChild(list);
  container.appendChild(footer);
}
function showFehubTab() {
  const panel = $2("fehub-panel");
  const noChat = $2("no-chat-state");
  const activeChat = $2("active-chat");
  if (panel) panel.style.display = "";
  if (noChat) noChat.style.display = "none";
  if (activeChat) activeChat.style.display = "none";
  void refreshFehubTab();
}
function hideFehubTab() {
  const panel = $2("fehub-panel");
  if (panel) panel.style.display = "none";
}
async function refreshFehubTab() {
  const container = $2("fehub-content");
  if (container) {
    container.innerHTML = `<div class="fehub-loading">\u52A0\u8F7D\u4E2D\u2026</div>`;
  }
  try {
    const publishes = await invoke8("list_my_publishes");
    store.setPublishes(publishes);
    renderFehubContent(publishes);
  } catch (e) {
    console.error("list_my_publishes failed:", e);
    if (container) {
      container.innerHTML = `
        <div class="fehub-empty">
          <div class="fehub-empty-icon">\u26A0\uFE0F</div>
          <h3>\u52A0\u8F7D\u5931\u8D25</h3>
          <p>${escapeHtml7(String(e))}</p>
          <button class="btn btn-secondary" id="fehub-retry">\u91CD\u8BD5</button>
        </div>
      `;
      $2("fehub-retry")?.addEventListener("click", () => {
        void refreshFehubTab();
      });
    }
  }
}
function escapeHtml7(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
var invoke8;
var init_fehub_tab = __esm({
  "src/chat/components/fehub-tab.ts"() {
    init_store();
    invoke8 = (cmd, args) => getTauri8().invoke(cmd, args);
  }
});

// src/chat/chat.ts
var chat_exports = {};
__export(chat_exports, {
  showToast: () => showToast2
});
function getTauri9() {
  const g = window.__TAURI__;
  if (!g?.core) throw new Error("Tauri global not available");
  return g.core;
}
function $3(id) {
  return document.getElementById(id);
}
function renderChatList(items) {
  const list = $3("chat-list");
  const hint = $3("empty-list-hint");
  if (!list) return;
  if (items.length === 0) {
    if (hint) hint.style.display = "";
    list.innerHTML = "";
    if (hint) list.appendChild(hint);
    return;
  }
  if (hint) hint.style.display = "none";
  list.innerHTML = "";
  for (const item of items) {
    const el = document.createElement("div");
    el.className = "chat-item" + (item.active ? " active" : "") + (item.is_group ? " group-item" : "") + (item.is_pinned ? " pinned" : "") + (item.is_dnd ? " dnd" : "");
    if (item.is_group) {
      el.dataset.groupId = item.group_id;
    } else {
      el.dataset.agentHash = item.agent_hash;
    }
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", String(!!item.active));
    const avatarContent = item.avatar_url ? `<img class="avatar-img" src="${item.avatar_url}" alt="">` : item.is_group ? "\u{1F465}" : item.avatar_letter;
    const onlineDot = !item.is_group && item.is_online ? `<span class="chat-item-online-dot" aria-hidden="true"></span>` : "";
    const pinIcon = item.is_pinned ? '<span class="chat-item-pin-icon" title="\u7F6E\u9876" aria-hidden="true">\u{1F4CC}</span>' : "";
    const dndIcon = item.is_dnd ? '<span class="chat-item-dnd-icon" title="\u514D\u6253\u6270" aria-hidden="true">\u{1F515}</span>' : "";
    el.innerHTML = `
      <div class="chat-item-avatar">${avatarContent}${onlineDot}</div>
      <div class="chat-item-info">
        <div class="chat-item-name">${escapeHtml8(item.name)}${item.status === "pending" ? ' <span class="agent-pending-badge">\u7EE7\u7EED\u914D\u7F6E \u2192</span>' : ""}</div>
        <div class="chat-item-preview">${escapeHtml8(item.last_message)}</div>
      </div>
      <div class="chat-item-meta">
        ${item.last_time ? `<span class="chat-item-time">${item.last_time}</span>` : ""}
        <span class="chat-item-icons">${pinIcon}${dndIcon}</span>
        ${item.unread ? '<span class="chat-item-badge"></span>' : ""}
      </div>
    `;
    el.addEventListener("click", () => {
      if (item.is_group && item.group_id) {
        void selectGroup(item.group_id);
      } else {
        void selectChat2(item.agent_hash);
      }
    });
    list.appendChild(el);
  }
}
function renderMessages(messages) {
  const list = $3("messages");
  if (!list) return;
  list.innerHTML = "";
  if (messages.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">F</div>
        <h2>\u5F00\u59CB\u4E00\u6B21\u5BF9\u8BDD</h2>
        <p>\u5411 AI \u52A9\u7406\u53D1\u9001\u6D88\u606F\uFF0C\u5B83\u4F1A\u5728\u8FD9\u91CC\u56DE\u590D\u4F60\u3002</p>
      </div>`;
    return;
  }
  const ordered = [...messages].sort((a, b) => {
    const ta = typeof a.created_at === "number" ? a.created_at : 0;
    const tb = typeof b.created_at === "number" ? b.created_at : 0;
    return ta - tb;
  });
  let lastDayKey = null;
  for (const msg of ordered) {
    if (msg.is_deleted) continue;
    const dayKey = dayKeyOf(msg.created_at);
    if (dayKey && dayKey !== lastDayKey) {
      const sep = document.createElement("div");
      sep.className = "day-separator";
      sep.textContent = formatDayLabel(msg.created_at);
      list.appendChild(sep);
      lastDayKey = dayKey;
    }
    renderMessageEl(list, msg);
  }
  scrollToBottom();
}
function dayKeyOf(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  const d = new Date(ts * 1e3);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function formatDayLabel(ts) {
  const d = new Date(ts * 1e3);
  const today = /* @__PURE__ */ new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const diffDays = Math.round((startOfDay(today).getTime() - startOfDay(d).getTime()) / 864e5);
  if (diffDays === 0) return "\u4ECA\u5929";
  if (diffDays === 1) return "\u6628\u5929";
  if (diffDays === 2) return "\u524D\u5929";
  if (diffDays > 2 && diffDays < 7) return `${diffDays} \u5929\u524D`;
  if (d.getFullYear() === today.getFullYear()) {
    return `${d.getMonth() + 1}\u6708${d.getDate()}\u65E5`;
  }
  return `${d.getFullYear()}\u5E74${d.getMonth() + 1}\u6708${d.getDate()}\u65E5`;
}
function renderMessageEl(parent, msg) {
  const isGroup = typeof msg.channel === "string" && msg.channel.startsWith("group:");
  if (isGroup) {
    renderGroupMessageEl(parent, msg);
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = `bubble ${msg.role === "user" ? "user" : "assistant"}`;
  wrap.dataset.id = msg.id;
  const safeImageSrc = pickSafeImageSrc(msg.content);
  if ((msg.message_type === "image" || msg.content.startsWith("data:image/")) && safeImageSrc) {
    const imgWrap = document.createElement("div");
    imgWrap.className = "bubble-image";
    const img = document.createElement("img");
    img.src = safeImageSrc;
    img.alt = "\u56FE\u7247";
    imgWrap.appendChild(img);
    wrap.appendChild(imgWrap);
  } else if (msg.message_type === "image") {
    const body = document.createElement("div");
    body.className = "bubble-body";
    body.textContent = "[\u56FE\u7247\u7C7B\u578B\u4E0D\u652F\u6301\u9884\u89C8]";
    wrap.appendChild(body);
  } else if (msg.role === "assistant") {
    const body = document.createElement("div");
    body.className = "bubble-body bubble-markdown";
    try {
      body.innerHTML = renderMarkdown(msg.content);
      decorateMarkdownRoot(body);
    } catch (e) {
      console.warn("markdown render failed, falling back to plain text:", e);
      body.textContent = msg.content;
    }
    wrap.appendChild(body);
  } else {
    const body = document.createElement("div");
    body.className = "bubble-body";
    body.textContent = msg.content;
    wrap.appendChild(body);
  }
  if (msg.attachments && msg.attachments.length > 0) {
    const attContainer = document.createElement("div");
    attContainer.className = "msg-attachments";
    for (const att of msg.attachments) {
      void renderAttachment(attContainer, att, msg.agent_hash);
    }
    const bodyEl = wrap.querySelector(".bubble-body");
    if (bodyEl) {
      wrap.insertBefore(attContainer, bodyEl.nextSibling);
    } else {
      wrap.appendChild(attContainer);
    }
  }
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  const ts = msg.timestamp || formatTime2(msg.created_at);
  const agentLabel = msg.agent ? ` \xB7 ${msg.agent}` : "";
  meta.textContent = ts ? `${ts}${agentLabel}` : agentLabel;
  wrap.appendChild(meta);
  if (msg.error) {
    wrap.classList.add("bubble-failed");
    const actions = document.createElement("div");
    actions.className = "bubble-actions";
    const errorLabel = document.createElement("span");
    errorLabel.className = "bubble-error";
    errorLabel.textContent = `\u53D1\u9001\u5931\u8D25\uFF1A${msg.error}`;
    actions.appendChild(errorLabel);
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "bubble-retry";
    retryBtn.textContent = "\u91CD\u8BD5";
    retryBtn.addEventListener("click", () => {
      void retryMessage(msg.id);
    });
    actions.appendChild(retryBtn);
    wrap.appendChild(actions);
  }
  parent.appendChild(wrap);
}
function renderGroupMessageEl(parent, msg) {
  const isUser = msg.role === "user";
  const senderName = msg.agent && msg.agent.trim() || msg.agent_hash || "?";
  const seed = msg.agent_hash ?? senderName;
  const row = document.createElement("div");
  row.className = `bubble-row ${isUser ? "user" : "assistant"}${isUser ? "" : " group-agent-" + agentColorIndex(seed)}`;
  row.dataset.id = msg.id;
  const avatar = document.createElement("div");
  avatar.className = "bubble-avatar";
  avatar.textContent = senderName.charAt(0).toUpperCase();
  avatar.style.background = pickAvatarColor2(seed);
  avatar.title = senderName;
  const content = document.createElement("div");
  content.className = "bubble-content";
  const name = document.createElement("div");
  name.className = "bubble-sender-name";
  name.textContent = senderName;
  const wrap = document.createElement("div");
  wrap.className = `bubble ${isUser ? "user" : "assistant"}`;
  wrap.dataset.id = msg.id;
  const safeImageSrc = pickSafeImageSrc(msg.content);
  if ((msg.message_type === "image" || msg.content.startsWith("data:image/")) && safeImageSrc) {
    const imgWrap = document.createElement("div");
    imgWrap.className = "bubble-image";
    const img = document.createElement("img");
    img.src = safeImageSrc;
    img.alt = "\u56FE\u7247";
    imgWrap.appendChild(img);
    wrap.appendChild(imgWrap);
  } else if (msg.message_type === "image") {
    const body = document.createElement("div");
    body.className = "bubble-body";
    body.textContent = "[\u56FE\u7247\u7C7B\u578B\u4E0D\u652F\u6301\u9884\u89C8]";
    wrap.appendChild(body);
  } else if (!isUser) {
    const body = document.createElement("div");
    body.className = "bubble-body bubble-markdown";
    try {
      body.innerHTML = renderMarkdown(msg.content);
      decorateMarkdownRoot(body);
    } catch (e) {
      console.warn("markdown render failed, falling back to plain text:", e);
      body.textContent = msg.content;
    }
    wrap.appendChild(body);
  } else {
    const body = document.createElement("div");
    body.className = "bubble-body";
    body.textContent = msg.content;
    wrap.appendChild(body);
  }
  if (msg.attachments && msg.attachments.length > 0) {
    const attContainer = document.createElement("div");
    attContainer.className = "msg-attachments";
    for (const att of msg.attachments) {
      void renderAttachment(attContainer, att, msg.agent_hash);
    }
    const bodyEl = wrap.querySelector(".bubble-body");
    if (bodyEl) {
      wrap.insertBefore(attContainer, bodyEl.nextSibling);
    } else {
      wrap.appendChild(attContainer);
    }
  }
  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  const ts = msg.timestamp || formatTime2(msg.created_at);
  meta.textContent = ts;
  wrap.appendChild(meta);
  if (msg.error) {
    wrap.classList.add("bubble-failed");
    const actions = document.createElement("div");
    actions.className = "bubble-actions";
    const errorLabel = document.createElement("span");
    errorLabel.className = "bubble-error";
    errorLabel.textContent = `\u53D1\u9001\u5931\u8D25\uFF1A${msg.error}`;
    actions.appendChild(errorLabel);
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "bubble-retry";
    retryBtn.textContent = "\u91CD\u8BD5";
    retryBtn.addEventListener("click", () => {
      void retryMessage(msg.id);
    });
    actions.appendChild(retryBtn);
    wrap.appendChild(actions);
  }
  content.appendChild(name);
  content.appendChild(wrap);
  if (isUser) {
    row.appendChild(content);
    row.appendChild(avatar);
  } else {
    row.appendChild(avatar);
    row.appendChild(content);
  }
  parent.appendChild(row);
}
function agentColorIndex(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = h * 31 + seed.charCodeAt(i) >>> 0;
  return h % 4;
}
function pickAvatarColor2(seed) {
  const palette = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#a855f7", "#ec4899", "#14b8a6"];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = h * 31 + seed.charCodeAt(i) >>> 0;
  return palette[h % palette.length];
}
async function retryMessage(msgId) {
  const list = $3("messages");
  if (!list) return;
  const target = store.messages.find((m) => m.id === msgId);
  if (!target) return;
  const isGroup = target.channel.startsWith("group:");
  const targetId = target.agent_hash;
  if (!targetId) return;
  store.updateMessage(msgId, { error: void 0, synced: false });
  renderMessages(store.messages);
  try {
    if (isGroup) {
      let mentionHashes = [];
      if (target.mentions && target.mentions.length > 0) {
        mentionHashes = target.mentions;
      } else {
        mentionHashes = parseMentionsFromText(target.content);
        if (mentionHashes.length > 0) {
          store.updateMessage(msgId, { mentions: mentionHashes });
        }
      }
      await invoke9("send_group_message", {
        group_id: targetId,
        content: target.content,
        mentions: mentionHashes.length > 0 ? mentionHashes : null,
        attachments: null
      });
    } else {
      await invoke9("send_chat_message", { text: target.content });
    }
    store.updateMessage(msgId, { synced: true });
  } catch (e) {
    const errMsg = typeof e === "string" ? e : "\u91CD\u8BD5\u5931\u8D25";
    store.updateMessage(msgId, { error: errMsg, synced: false });
  }
  renderMessages(store.messages);
}
function parseMentionsFromText(text) {
  if (!text) return [];
  const candidates = window.__FECLAW_MENTION_CANDIDATES__ ?? [];
  if (candidates.length === 0) return [];
  const byName = /* @__PURE__ */ new Map();
  for (const c of candidates) {
    if (c.agent_name) byName.set(c.agent_name.toLowerCase(), c.agent_hash);
  }
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const re = /@([\p{L}\p{N}_\- ]{1,40})/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    const rawName = m[1].trim();
    if (!rawName) continue;
    const hash = byName.get(rawName.toLowerCase());
    if (hash && !seen.has(hash)) {
      seen.add(hash);
      out.push(hash);
    }
  }
  return out;
}
async function renderAttachment(container, att, agentHash) {
  if (att.type === "image") {
    const imgDiv = document.createElement("div");
    imgDiv.className = "attachment-image";
    const img = document.createElement("img");
    img.className = "attachment-thumb";
    img.alt = "\u56FE\u7247\u9644\u4EF6";
    img.loading = "lazy";
    if (att.source === "data" && att.data) {
      const safe = pickSafeImageSrc(att.data);
      if (safe) img.src = safe;
    } else if (att.source === "url" && att.url) {
      const safe = pickSafeImageSrc(att.url);
      if (safe) img.src = safe;
    } else if (att.source === "vfs" && att.path && agentHash) {
      img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'%3E%3Crect fill='%23334155' width='80' height='80' rx='8'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='central' text-anchor='middle' fill='%2394a3b8' font-size='12'%3E\u52A0\u8F7D\u4E2D\u2026%3C/text%3E%3C/svg%3E";
      try {
        const preview = await invoke9("get_vfs_preview_url", {
          agent_hash: agentHash,
          path: att.path
        });
        const resp = await fetch(preview.url);
        if (resp.ok) {
          const blob = await resp.blob();
          img.src = await blobToDataURL(blob);
        }
      } catch (e) {
        console.error("Failed to load VFS image attachment:", e);
        img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'%3E%3Crect fill='%23334155' width='80' height='80' rx='8'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='central' text-anchor='middle' fill='%2394a3b8' font-size='12'%3E\u52A0\u8F7D\u5931\u8D25%3C/text%3E%3C/svg%3E";
      }
    } else {
      img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'%3E%3Crect fill='%23334155' width='80' height='80' rx='8'/%3E%3Ctext x='50%25' y='50%25' dominant-baseline='central' text-anchor='middle' fill='%2394a3b8' font-size='12'%3E\u56FE\u7247%3C/text%3E%3C/svg%3E";
    }
    img.style.cursor = "pointer";
    img.addEventListener("click", () => openFullView(img.src));
    imgDiv.appendChild(img);
    container.appendChild(imgDiv);
  } else if (att.type === "file") {
    const fileDiv = document.createElement("div");
    fileDiv.className = "attachment-file";
    const icon = document.createElement("span");
    icon.className = "af-icon";
    icon.textContent = "\u{1F4C4}";
    const name = document.createElement("span");
    name.className = "af-name";
    name.textContent = att.name;
    const size = document.createElement("span");
    size.className = "af-size";
    size.textContent = formatBytes3(att.size);
    const dlBtn = document.createElement("button");
    dlBtn.className = "af-download";
    dlBtn.textContent = "\u4E0B\u8F7D";
    dlBtn.addEventListener("click", () => void downloadAttachment(att, agentHash));
    fileDiv.appendChild(icon);
    fileDiv.appendChild(name);
    fileDiv.appendChild(size);
    fileDiv.appendChild(dlBtn);
    container.appendChild(fileDiv);
  } else if (att.type === "miniapp_card") {
    const card = document.createElement("div");
    card.className = "attachment-miniapp";
    if (att.preview_url) {
      const preview = document.createElement("img");
      preview.className = "am-preview";
      preview.src = att.preview_url;
      preview.alt = att.title;
      card.appendChild(preview);
    }
    const info = document.createElement("div");
    info.className = "am-info";
    const title = document.createElement("span");
    title.className = "am-title";
    title.textContent = att.title;
    const appName = document.createElement("span");
    appName.className = "am-app";
    appName.textContent = att.app_name;
    info.appendChild(title);
    info.appendChild(appName);
    card.appendChild(info);
    const openBtn = document.createElement("button");
    openBtn.className = "am-open";
    openBtn.textContent = "\u6253\u5F00";
    openBtn.addEventListener("click", () => void openMiniapp2(att.path));
    card.appendChild(openBtn);
    container.appendChild(card);
  }
}
function openFullView(src) {
  const overlay = document.createElement("div");
  overlay.className = "viewer-fullscreen";
  overlay.innerHTML = `<img src="${src}" />`;
  overlay.addEventListener("click", () => overlay.remove());
  const closeBtn = document.createElement("button");
  closeBtn.className = "viewer-fullscreen-close";
  closeBtn.textContent = "\u2715";
  closeBtn.addEventListener("click", () => overlay.remove());
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);
}
async function downloadAttachment(att, agentHash) {
  if (att.type !== "file") return;
  if (att.url) {
    const a = document.createElement("a");
    a.href = att.url;
    a.download = att.name;
    a.click();
  } else if (att.path && agentHash) {
    try {
      const localPath = await invoke9("download_vfs_file", {
        agent_hash: agentHash,
        path: att.path
      });
      const a = document.createElement("a");
      a.href = `file://${localPath}`;
      a.download = att.name;
      a.click();
    } catch (e) {
      alert(`\u4E0B\u8F7D\u5931\u8D25\uFF1A${e}`);
    }
  }
}
async function openMiniapp2(path) {
  if (path) {
    console.log("open miniapp:", path);
  }
}
function formatBytes3(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
function appendStreamingMessage(id, chunk) {
  const list = $3("messages");
  if (!list) return;
  let el = list.querySelector(`[data-id="${id}"]`);
  if (!el) {
    el = document.createElement("div");
    el.className = "bubble assistant streaming";
    el.dataset.id = id;
    const body2 = document.createElement("div");
    body2.className = "bubble-body";
    el.appendChild(body2);
    list.appendChild(el);
  }
  const body = el.querySelector(".bubble-body");
  if (body) body.textContent = (body.textContent ?? "") + chunk;
  scrollToBottom();
}
function finalizeStreaming(id, finalText) {
  const list = $3("messages");
  if (!list) return;
  const el = list.querySelector(`[data-id="${id}"]`);
  if (!el) return;
  el.classList.remove("streaming");
  if (typeof finalText === "string") {
    const body = el.querySelector(".bubble-body");
    if (body) body.textContent = finalText;
  }
}
async function selectChat2(agentHash) {
  if (store.currentTab !== "chat") {
    switchTab("chat");
  }
  try {
    const input2 = $3("input");
    const draftText = input2?.value ?? "";
    if (input2 && draftText.trim()) {
      if (store.activeGroupId) {
        await invoke9("save_draft", {
          channel: `group:${store.activeGroupId}`,
          content: draftText
        });
      } else if (store.activeAgentHash) {
        await invoke9("save_draft", {
          channel: `im:${store.activeAgentHash}`,
          content: draftText
        });
      }
    }
  } catch (e) {
    console.error("save_draft failed:", e);
  }
  stopGroupPolling();
  setMentionCandidates([]);
  store.setActiveChat(agentHash);
  renderChatList(store.chatItems);
  const input = $3("input");
  if (input) input.value = "";
  try {
    const draft = await invoke9("load_draft", {
      channel: `im:${agentHash}`
    });
    if (draft && input) {
      input.value = draft;
      autoResize();
    }
  } catch (e) {
    console.error("load_draft failed:", e);
  }
  await loadChatHistory(agentHash);
  showActiveChat();
}
async function loadChatHistory(agentHash) {
  try {
    const msgs = await invoke9("get_chat_history_by_agent", {
      agentHash
    });
    store.setMessages(msgs);
    renderMessages(msgs);
  } catch (e) {
    console.error("load_chat_history failed:", e);
    store.setMessages([]);
    renderMessages([]);
    showToast2(
      `\u52A0\u8F7D\u5386\u53F2\u6D88\u606F\u5931\u8D25\uFF1A${typeof e === "string" ? e : "\u7F51\u7EDC\u9519\u8BEF"}`,
      "error"
    );
  }
}
async function selectGroup(groupId) {
  if (store.currentTab !== "chat") {
    switchTab("chat");
  }
  try {
    const input2 = $3("input");
    const draftText = input2?.value ?? "";
    if (input2 && draftText.trim()) {
      if (store.activeGroupId) {
        await invoke9("save_draft", {
          channel: `group:${store.activeGroupId}`,
          content: draftText
        });
      } else if (store.activeAgentHash) {
        await invoke9("save_draft", {
          channel: `im:${store.activeAgentHash}`,
          content: draftText
        });
      }
    }
  } catch (e) {
    console.error("save_draft failed:", e);
  }
  if (store.currentTab === "moments") {
    hideMomentsFeed();
    store.setTab("chat");
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === "chat");
    });
  }
  store.setActiveGroup(groupId);
  renderChatList(store.chatItems);
  const input = $3("input");
  if (input) input.value = "";
  try {
    const draft = await invoke9("load_draft", {
      channel: `group:${groupId}`
    });
    if (draft && input) {
      input.value = draft;
      autoResize();
    }
  } catch (e) {
    console.error("load_draft failed:", e);
  }
  await loadGroupMessages(groupId);
  showActiveChat();
  await refreshMentionCandidatesForGroup(groupId);
  startGroupPolling(groupId);
}
function startGroupPolling(groupId) {
  stopGroupPolling();
  groupPollTimer = window.setInterval(() => {
    if (store.activeGroupId !== groupId) {
      stopGroupPolling();
      return;
    }
    void loadGroupMessages(groupId);
  }, GROUP_POLL_INTERVAL_MS);
}
function stopGroupPolling() {
  if (groupPollTimer !== null) {
    window.clearInterval(groupPollTimer);
    groupPollTimer = null;
  }
}
async function refreshMentionCandidatesForGroup(groupId) {
  const cached = store.getGroupById(groupId)?.members;
  if (cached && cached.length > 0) {
    setMentionCandidates(
      cached.map((m) => ({
        agent_hash: m.agent_hash,
        agent_name: m.agent_name
      }))
    );
  }
  try {
    const members = await invoke9(
      "list_group_members",
      { groupId }
    );
    if (Array.isArray(members) && members.length > 0) {
      store.setGroupMembers(groupId, members);
      setMentionCandidates(
        members.map((m) => ({
          agent_hash: m.agent_hash,
          agent_name: m.agent_name
        }))
      );
    }
  } catch (e) {
    if (!cached || cached.length === 0) {
      const fallback = store.agents.map((a) => ({ agent_hash: a.hash, agent_name: a.name }));
      setMentionCandidates(fallback);
    }
    void e;
  }
}
async function loadGroupMessages(groupId) {
  try {
    const cached = await invoke9("get_chat_history_by_group", {
      groupId
    });
    if (Array.isArray(cached) && cached.length > 0) {
      const cachedAsGroup = cached.map((m) => ({
        ...m,
        channel: `group:${groupId}`
      }));
      store.setMessages(cachedAsGroup);
      renderMessages(cachedAsGroup);
    }
  } catch (e) {
    console.error("get_chat_history_by_group failed:", e);
  }
  try {
    const msgs = await invoke9("get_group_messages", {
      groupId
    });
    const chatMsgs = msgs.map((m) => ({
      id: m.id,
      channel: `group:${groupId}`,
      agent_hash: m.sender_hash,
      role: m.sender_type === "user" ? "user" : "assistant",
      content: m.content,
      message_type: m.message_type,
      created_at: m.created_at,
      synced: true,
      is_deleted: false,
      timestamp: formatTime2(m.created_at),
      agent: m.sender_name,
      attachments: m.attachments
    }));
    store.setMessages(chatMsgs);
    renderMessages(chatMsgs);
    for (const m of chatMsgs) {
      try {
        await invoke9("insert_chat_message", {
          id: m.id,
          channel: m.channel,
          agentHash: m.agent_hash ?? null,
          role: m.role,
          content: m.content,
          messageType: m.message_type ?? "text",
          createdAt: m.created_at * 1e3
        });
      } catch (e) {
        console.error("insert_chat_message (group) failed:", e);
      }
    }
  } catch (e) {
    console.error("load_group_messages failed:", e);
    showToast2(
      `\u52A0\u8F7D\u7FA4\u6D88\u606F\u5931\u8D25\uFF1A${typeof e === "string" ? e : "\u7F51\u7EDC\u9519\u8BEF"}`,
      "error"
    );
  }
}
async function sendMessage() {
  const input = $3("input");
  const btn = $3("btn-send");
  if (!input || !btn) return;
  const text = input.value.trim();
  const imgCards = getImageCards();
  if (!text && getFileCards().length === 0 && imgCards.length === 0) return;
  btn.disabled = true;
  const cards = getFileCards();
  let fullText = text;
  if (cards.length > 0) {
    const cardLines = cards.map((f) => {
      const mode = f.mode === "reference" ? "\u5F15\u7528" : "\u53D1\u9001\u526F\u672C";
      return `[\u6587\u4EF6: ${f.name} (${f.size_label}) - ${mode} - ${f.path}]`;
    }).join("\n");
    fullText = (fullText ? text + "\n" : "") + cardLines;
  }
  for (const img of imgCards) {
    fullText += (fullText ? "\n" : "") + `[image:${img.temp_path}]`;
  }
  input.value = "";
  autoResize();
  clearFileCards();
  const isGroup = store.activeGroupId !== null;
  const targetId = isGroup ? store.activeGroupId : store.activeAgentHash;
  const channel = isGroup ? `group:${targetId}` : `im:${targetId}`;
  const sentImageIds = [];
  let textMsgId = "";
  for (const img of imgCards) {
    const imgId = `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const imgTs = Math.floor(Date.now() / 1e3);
    const imgMsg = {
      id: imgId,
      channel,
      agent_hash: targetId,
      role: "user",
      content: img.data_url,
      message_type: "image",
      created_at: imgTs,
      synced: false,
      is_deleted: false,
      timestamp: formatTime2(imgTs)
    };
    try {
      await invoke9("insert_chat_message", {
        id: imgMsg.id,
        channel: imgMsg.channel,
        agentHash: targetId,
        role: imgMsg.role,
        content: imgMsg.content,
        messageType: "image",
        createdAt: imgTs * 1e3
      });
    } catch (e) {
      console.error("insert_chat_message (image) failed:", e);
    }
    store.appendMessage(imgMsg);
    sentImageIds.push(imgId);
    const list = $3("messages");
    if (list) renderMessageEl(list, imgMsg);
  }
  clearImageCards();
  scrollToBottom();
  if (text) {
    const id = `msg-${Date.now()}`;
    textMsgId = id;
    const ts = Math.floor(Date.now() / 1e3);
    const msg = {
      id,
      channel,
      agent_hash: targetId,
      role: "user",
      content: text,
      message_type: "text",
      created_at: ts,
      synced: false,
      is_deleted: false,
      timestamp: formatTime2(ts)
    };
    if (!isGroup) {
      try {
        await invoke9("insert_chat_message", {
          id: msg.id,
          channel: msg.channel,
          agentHash: targetId,
          role: msg.role,
          content: msg.content,
          messageType: msg.message_type ?? "text",
          createdAt: ts * 1e3
        });
      } catch (e) {
        console.error("insert_chat_message failed:", e);
      }
    }
    store.appendMessage(msg);
    const list = $3("messages");
    if (list) renderMessageEl(list, msg);
    scrollToBottom();
  }
  try {
    if (isGroup) {
      const mentionHashes = getActiveMentions();
      await invoke9("send_group_message", {
        group_id: targetId,
        content: fullText,
        mentions: mentionHashes.length > 0 ? mentionHashes : null,
        attachments: null
      });
      if (text && mentionHashes.length > 0) {
        store.updateMessage(textMsgId, { mentions: mentionHashes });
      }
    } else {
      await invoke9("send_chat_message", { text: fullText });
    }
    if (text) {
      store.updateMessage(textMsgId, { synced: true, error: void 0 });
    }
    for (const imgId of sentImageIds) {
      store.updateMessage(imgId, { synced: true, error: void 0 });
    }
    clearActiveMentions();
  } catch (e) {
    const errMsg = typeof e === "string" ? e : "\u53D1\u9001\u5931\u8D25";
    if (text) {
      store.updateMessage(textMsgId, { synced: false, error: errMsg });
    }
    for (const imgId of sentImageIds) {
      store.updateMessage(imgId, { synced: false, error: errMsg });
    }
    renderMessages(store.messages);
  } finally {
    btn.disabled = false;
    input.focus();
  }
}
function switchTab(tabId) {
  if (tabId !== "chat") {
    stopGroupPolling();
  }
  store.setTab(tabId);
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  const settingsTab = $3("settingsTab");
  if (settingsTab) {
    settingsTab.style.display = tabId === "settings" ? "flex" : "none";
  }
  const chatList = $3("chat-list-panel");
  if (chatList) {
    chatList.style.display = tabId === "chat" ? "" : "none";
  }
  if (tabId === "settings") {
    const noChat = $3("no-chat-state");
    const activeChat = $3("active-chat");
    if (noChat) noChat.style.display = "none";
    if (activeChat) activeChat.style.display = "none";
  } else if (tabId === "moments") {
    if (typeof hideFehubTab === "function") hideFehubTab();
    if (typeof hidePlaceholder === "function") hidePlaceholder();
    if (typeof showMomentsFeed === "function") showMomentsFeed();
  } else if (tabId === "fehub") {
    if (typeof hideMomentsFeed === "function") hideMomentsFeed();
    if (typeof hidePlaceholder === "function") hidePlaceholder();
    if (typeof showFehubTab === "function") showFehubTab();
  } else if (tabId === "chat") {
    if (typeof hideMomentsFeed === "function") hideMomentsFeed();
    if (typeof hideFehubTab === "function") hideFehubTab();
    if (typeof hidePlaceholder === "function") hidePlaceholder();
    if (store.activeAgentHash || store.activeGroupId) {
      showActiveChat();
    } else {
      const noChat = $3("no-chat-state");
      const activeChat = $3("active-chat");
      if (noChat) noChat.style.display = "";
      if (activeChat) activeChat.style.display = "none";
    }
  }
}
function hidePlaceholder() {
  const page = $3("placeholder-page");
  if (page) page.style.display = "none";
  const noChat = $3("no-chat-state");
  if (noChat) noChat.style.display = "";
}
function showActiveChat() {
  const noChat = $3("no-chat-state");
  const activeChat = $3("active-chat");
  if (!noChat || !activeChat) return;
  noChat.style.display = "none";
  activeChat.style.display = "flex";
}
function hideActiveChat() {
  const noChat = $3("no-chat-state");
  const activeChat = $3("active-chat");
  if (!noChat || !activeChat) return;
  noChat.style.display = "";
  activeChat.style.display = "none";
}
async function initChat() {
  try {
    await invoke9("init_db");
  } catch (e) {
    console.error("init_db failed:", e);
  }
  try {
    const hasLegacy = await invoke9("check_legacy_chat_history");
    if (hasLegacy) {
      const count = await invoke9("import_chat_history");
      console.log(`Imported ${count} legacy messages`);
    }
  } catch (e) {
    console.error("import_chat_history failed:", e);
  }
  try {
    const perms = await invoke9("get_permissions");
    store.setPermissions(perms);
  } catch (e) {
    console.error("get_permissions failed:", e);
  }
  try {
    const agents = await invoke9("list_agents");
    store.setAgents(agents);
    renderChatList(store.chatItems);
    if (agents.length > 0) {
      await selectChat2(agents[0].hash);
    }
  } catch (e) {
    console.error("list_agents failed:", e);
    showToast2(
      `\u52A0\u8F7D Agent \u5217\u8868\u5931\u8D25\uFF1A${typeof e === "string" ? e : "\u7F51\u7EDC\u9519\u8BEF"}`,
      "error"
    );
  }
  try {
    const groups = await invoke9("list_groups");
    const clientGroups = groups.map((g) => ({
      id: g.id,
      name: g.name,
      announcement: g.announcement,
      memberCount: g.memberCount,
      createdAt: g.createdAt,
      unreadCount: 0,
      lastMessage: g.lastMessage
    }));
    store.setGroups(clientGroups);
    renderChatList(store.chatItems);
  } catch (e) {
    console.error("list_groups failed:", e);
    showToast2(
      `\u52A0\u8F7D\u7FA4\u5217\u8868\u5931\u8D25\uFF1A${typeof e === "string" ? e : "\u7F51\u7EDC\u9519\u8BEF"}`,
      "error"
    );
  }
}
function autoResize() {
  const input = $3("input");
  if (!input) return;
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}
function scrollToBottom() {
  const list = $3("messages");
  if (!list) return;
  list.scrollTop = list.scrollHeight;
}
function formatTime2(ts) {
  if (!ts) return "";
  const n = typeof ts === "string" ? Number(ts) : ts;
  if (!Number.isFinite(n) || n <= 0) return "";
  const ms = n < 4102444800 ? n * 1e3 : n;
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
function escapeHtml8(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function pickSafeImageSrc(content) {
  const trimmed = content.trim();
  if (trimmed.startsWith("data:")) {
    const match = /^data:([^;,]+)(?:;base64)?,/i.exec(trimmed);
    if (!match) return null;
    const mime = match[1].toLowerCase();
    if (!SAFE_IMAGE_MIMES.has(mime)) return null;
    return trimmed;
  }
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null;
}
function ensureToastContainer() {
  if (toastContainer && document.body.contains(toastContainer)) {
    return toastContainer;
  }
  const el = document.createElement("div");
  el.id = "feclaw-toast-container";
  el.className = "feclaw-toast-container";
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-atomic", "false");
  document.body.appendChild(el);
  toastContainer = el;
  return el;
}
function showToast2(message, kind = "info", durationMs = 4e3) {
  if (!message) return;
  const container = ensureToastContainer();
  const toast = document.createElement("div");
  toast.className = `feclaw-toast feclaw-toast-${kind}`;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");
  toast.textContent = message;
  toast.addEventListener("click", () => dismissToast(toast));
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("feclaw-toast-show"));
  if (durationMs > 0) {
    window.setTimeout(() => dismissToast(toast), durationMs);
  }
}
function dismissToast(toast) {
  if (!toast.parentNode) return;
  toast.classList.remove("feclaw-toast-show");
  toast.classList.add("feclaw-toast-leave");
  window.setTimeout(() => {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  }, 220);
}
async function subscribeEvents() {
  try {
    await listen3("theme-changed", (e) => {
      const theme = e.payload?.theme;
      if (!theme) return;
      document.documentElement.setAttribute("data-theme", theme);
      document.body.setAttribute("data-theme", theme);
    });
  } catch (e) {
    console.error("listen theme-changed:", e);
  }
  try {
    await listen3("ws-status", (e) => {
      const dot = $3("conn-dot");
      const text = $3("conn-text");
      if (!dot || !text) return;
      const s = e.payload.status;
      dot.className = "conn-dot";
      text.className = "conn-text";
      if (s === "Connected") {
        dot.classList.add("connected");
        text.textContent = "\u5728\u7EBF";
      } else if (s === "Connecting" || s === "Reconnecting") {
        dot.classList.add("connecting");
        text.textContent = "\u8FDE\u63A5\u4E2D\u2026";
      } else {
        dot.classList.add("disconnected");
        text.textContent = "\u79BB\u7EBF";
      }
    });
  } catch (e) {
    console.error("listen ws-status:", e);
  }
  try {
    await listen3("chat-event", (e) => {
      const msg = e.payload;
      if (!msg || !msg.id) return;
      if (msg.agent_hash !== store.activeAgentHash) return;
      store.appendMessage(msg);
      const list = $3("messages");
      if (list) renderMessageEl(list, msg);
      scrollToBottom();
    });
  } catch (e) {
    console.error("listen chat-event:", e);
  }
  try {
    await listen3(
      "chat-stream",
      (e) => {
        const ev = e.payload;
        if (!ev) return;
        switch (ev.kind) {
          case "thinking":
            renderEventPill("thinking", "\u601D\u8003\u4E2D\u2026");
            break;
          case "tool":
            renderEventPill("tool", `\u8C03\u7528\u5DE5\u5177: ${describeToolCall(ev.data)}`);
            break;
          case "tool_result":
            renderEventPill("tool", "\u5DE5\u5177\u8FD4\u56DE\u5B8C\u6210");
            break;
          case "message_start": {
            const id = ev.data?.id ?? ev.id;
            appendStreamingMessage(id, "");
            break;
          }
          case "message_chunk": {
            const id = ev.data?.id ?? ev.id;
            const text = ev.data?.text ?? "";
            appendStreamingMessage(id, text);
            break;
          }
          case "message_end": {
            const id = ev.data?.id ?? ev.id;
            const final = ev.data?.text;
            finalizeStreaming(id, final);
            break;
          }
          case "done":
            renderEventPill("done", "\u2713 \u5B8C\u6210");
            break;
        }
      }
    );
  } catch (e) {
    console.error("listen chat-stream:", e);
  }
  try {
    await listen3(
      "file-operation-request",
      (e) => {
        const req = e.payload;
        if (!req) return;
        console.log("file operation request:", req);
      }
    );
  } catch (e) {
    console.error("listen file-operation-request:", e);
  }
  try {
    await listen3("right-click-pending", (e) => {
      const pending = e.payload;
      if (!pending) return;
      console.log("right-click-pending:", pending);
      void openSendDialog(pending);
    });
  } catch (e) {
    console.error("listen right-click-pending:", e);
  }
  try {
    await listen3("group-message", (e) => {
      const { group_id, message } = e.payload;
      if (!group_id || !message) return;
      const rawTs = message;
      const tsCandidate = typeof rawTs.created_at === "number" ? rawTs.created_at : typeof rawTs.timestamp === "number" ? rawTs.timestamp : void 0;
      const createdAt = typeof tsCandidate === "number" && tsCandidate > 0 ? tsCandidate : Math.floor(Date.now() / 1e3);
      const chatMsg = {
        id: message.id,
        channel: `group:${group_id}`,
        agent_hash: message.sender_hash,
        role: message.sender_type === "user" ? "user" : "assistant",
        content: message.content,
        message_type: message.message_type,
        created_at: createdAt,
        synced: true,
        is_deleted: false,
        timestamp: formatTime2(createdAt),
        agent: message.sender_name,
        attachments: message.attachments
      };
      store.appendGroupMessage(group_id, {
        id: message.id,
        group_id,
        sender_type: message.sender_type === "user" ? "user" : "agent",
        sender_hash: message.sender_hash,
        sender_name: message.sender_name,
        content: message.content,
        message_type: message.message_type,
        created_at: createdAt,
        timestamp: formatTime2(createdAt),
        attachments: message.attachments
      });
      if (store.activeGroupId === group_id) {
        store.appendMessage(chatMsg);
        const list = $3("messages");
        if (list) renderMessageEl(list, chatMsg);
        scrollToBottom();
      } else {
        const grp = store.getGroupById(group_id);
        if (grp) {
          grp.unreadCount = (grp.unreadCount ?? 0) + 1;
          grp.lastMessage = message.content;
          renderChatList(store.chatItems);
        }
      }
    });
  } catch (e) {
    console.error("listen group-message:", e);
  }
  try {
    await listen3("group-event", (e) => {
      const { group_id, event, data } = e.payload;
      if (!group_id || !event) return;
      const group = store.getGroupById(group_id);
      const name = data?.name ?? group?.name ?? "\u672A\u77E5\u7FA4";
      let text = "";
      if (event === "member_joined") {
        text = `${data?.member_name ?? "\u67D0\u4EBA"} \u52A0\u5165\u4E86\u7FA4\u804A`;
      } else if (event === "member_left") {
        text = `${data?.member_name ?? "\u67D0\u4EBA"} \u9000\u51FA\u4E86\u7FA4\u804A`;
      } else if (event === "group_renamed") {
        text = `\u7FA4\u540D\u79F0\u5DF2\u66F4\u6539\u4E3A\uFF1A${name}`;
      }
      if (!text) return;
      const list = $3("messages");
      if (list) {
        const pill = document.createElement("div");
        pill.className = "event-pill system";
        pill.textContent = text;
        list.appendChild(pill);
        scrollToBottom();
      }
      if (store.activeGroupId === group_id) {
        void loadGroupMessages(group_id);
      }
    });
  } catch (e) {
    console.error("listen group-event:", e);
  }
  try {
    await listen3("group-updated", (e) => {
      const { group_id, data } = e.payload;
      if (!group_id) return;
      const idx = store.groups.findIndex((g) => g.id === group_id);
      if (idx >= 0 && data) {
        const updated = { ...store.groups[idx] };
        if (data.name) updated.name = data.name;
        if (data.announcement) updated.announcement = data.announcement;
        if (data.member_count !== void 0) updated.memberCount = data.member_count;
        store.groups[idx] = updated;
        renderChatList(store.chatItems);
        if (store.activeGroupId === group_id) {
          showActiveChat();
        }
      }
    });
  } catch (e) {
    console.error("listen group-updated:", e);
  }
  try {
    await listen3("moments-event", (e) => {
      const { group_id: _group_id, data } = e.payload;
      if (!data) return;
      const moment = {
        id: data.id,
        group_id: data.group_id,
        group_name: data.group_name,
        agent_hash: data.agent_hash,
        agent_name: data.agent_name,
        kind: data.kind,
        title: data.title,
        content: data.content,
        attachments: data.attachments ?? [],
        created_at: data.created_at
      };
      store.addMoment(moment);
      if (store.currentTab !== "moments") {
        addMomentCard(moment);
      }
    });
  } catch (e) {
    console.error("listen moments-event:", e);
  }
}
function renderEventPill(kind, label) {
  const list = $3("messages");
  if (!list) return;
  const pill = document.createElement("div");
  pill.className = `event-pill ${kind}`;
  pill.textContent = label;
  list.appendChild(pill);
  scrollToBottom();
}
function describeToolCall(data) {
  if (!data || typeof data !== "object") return "";
  const obj = data;
  if (!obj.name) return "";
  try {
    const args = obj.args ? JSON.stringify(obj.args) : "";
    return args ? `${obj.name}(${args})` : obj.name;
  } catch {
    return obj.name;
  }
}
function showPlusDropdown(trigger) {
  if (activePlusDropdown && activePlusTrigger === trigger) {
    hidePlusDropdown();
    return;
  }
  hidePlusDropdown();
  const dropdown = document.createElement("div");
  dropdown.id = PLUS_DROPDOWN_ID;
  dropdown.className = "plus-dropdown open";
  dropdown.setAttribute("role", "menu");
  dropdown.setAttribute("aria-label", "\u65B0\u5EFA\u804A\u5929");
  dropdown.innerHTML = `
    <button type="button" class="plus-dropdown-item" data-action="agent" role="menuitem">
      <span class="plus-dropdown-icon" aria-hidden="true">\u{1F916}</span>
      <span class="plus-dropdown-text">\u521B\u5EFA AI \u52A9\u7406</span>
    </button>
    <button type="button" class="plus-dropdown-item" data-action="group" role="menuitem">
      <span class="plus-dropdown-icon" aria-hidden="true">\u{1F465}</span>
      <span class="plus-dropdown-text">\u53D1\u8D77\u7FA4\u804A</span>
    </button>
  `;
  document.body.appendChild(dropdown);
  const rect = trigger.getBoundingClientRect();
  const ddRect = dropdown.getBoundingClientRect();
  let top = rect.bottom + PLUS_DROPDOWN_GAP;
  let left = rect.right - ddRect.width;
  if (top + ddRect.height > window.innerHeight - PLUS_DROPDOWN_MARGIN) {
    top = rect.top - ddRect.height - PLUS_DROPDOWN_GAP;
  }
  if (top < PLUS_DROPDOWN_MARGIN) {
    top = PLUS_DROPDOWN_MARGIN;
  }
  if (left < PLUS_DROPDOWN_MARGIN) {
    left = PLUS_DROPDOWN_MARGIN;
  }
  if (left + ddRect.width > window.innerWidth - PLUS_DROPDOWN_MARGIN) {
    left = window.innerWidth - ddRect.width - PLUS_DROPDOWN_MARGIN;
  }
  dropdown.style.top = `${top}px`;
  dropdown.style.left = `${left}px`;
  dropdown.querySelectorAll(".plus-dropdown-item").forEach((item) => {
    item.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const action = item.dataset.action;
      hidePlusDropdown();
      if (action === "agent") {
        openCreateDialog("classic");
      } else if (action === "group") {
        openCreateDialog("group");
      }
    });
  });
  activePlusDropdown = dropdown;
  activePlusTrigger = trigger;
  setTimeout(() => {
    document.addEventListener("click", onPlusDocClick, true);
    document.addEventListener("keydown", onPlusDocKey, true);
    window.addEventListener("resize", hidePlusDropdown);
    window.addEventListener("scroll", hidePlusDropdown, true);
  }, 0);
}
function hidePlusDropdown() {
  if (activePlusDropdown && activePlusDropdown.parentNode) {
    activePlusDropdown.parentNode.removeChild(activePlusDropdown);
  }
  activePlusDropdown = null;
  activePlusTrigger = null;
  document.removeEventListener("click", onPlusDocClick, true);
  document.removeEventListener("keydown", onPlusDocKey, true);
  window.removeEventListener("resize", hidePlusDropdown);
  window.removeEventListener("scroll", hidePlusDropdown, true);
}
function onPlusDocClick(ev) {
  if (!activePlusDropdown) return;
  const target = ev.target;
  if (target && !activePlusDropdown.contains(target) && activePlusTrigger !== target && !(activePlusTrigger && activePlusTrigger.contains(target))) {
    hidePlusDropdown();
  }
}
function onPlusDocKey(ev) {
  if (ev.key === "Escape") {
    hidePlusDropdown();
  }
}
function wire() {
  setupInputBox();
  void setupTemplateBar();
  window.addEventListener("agent-created", ((e) => {
    void selectChat2(e.detail.agentHash);
  }));
  window.addEventListener("group-selected", ((e) => {
    void selectGroup(e.detail.groupId);
  }));
  window.addEventListener("navigate-to-chat", ((e) => {
    const { agentHash, messageId } = e.detail;
    if (store.currentTab !== "chat") {
      switchTab("chat");
    }
    void selectChat2(agentHash).then(() => {
      if (messageId) {
        const el = document.querySelector(`[data-id="${messageId}"]`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }));
  window.addEventListener("navigate-to-vfs", ((e) => {
    const { path } = e.detail;
    console.log("navigate-to-vfs:", path);
  }));
  window.addEventListener("navigate-to-moment", ((e) => {
    const { momentId, groupId } = e.detail;
    switchTab("moments");
    if (groupId) {
      store.setMomentsGroupFilter(groupId);
    }
    setTimeout(() => {
      const el = document.querySelector(`[data-moment-id="${momentId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("moment-highlight");
        setTimeout(() => el.classList.remove("moment-highlight"), 2e3);
      }
    }, 100);
  }));
  window.addEventListener("navigate-to-reference", ((e) => {
    console.log("navigate-to-reference:", e.detail.reference);
  }));
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    const tab = btn.dataset.tab;
    if (tab) {
      btn.addEventListener("click", () => switchTab(tab));
    }
  });
  const input = $3("input");
  const send = $3("btn-send");
  if (input) {
    input.addEventListener("input", autoResize);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        void sendMessage();
      }
    });
    input.addEventListener("input", () => {
      store.setDraft(input.value);
    });
  }
  if (send) {
    send.addEventListener("click", () => void sendMessage());
  }
  const newChat = $3("btn-new-chat");
  if (newChat) {
    newChat.addEventListener("click", (ev) => {
      ev.stopPropagation();
      showPlusDropdown(newChat);
    });
  }
  const chatMenu = $3("btn-chat-menu");
  if (chatMenu) {
    chatMenu.addEventListener("click", () => {
      if (store.activeGroupId) {
        store.setTab("moments");
        document.querySelectorAll(".tab-btn").forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.tab === "moments");
        });
        hideActiveChat();
        showMomentsFeed(store.activeGroupId);
      } else if (store.activeAgentHash) {
        void openSidePanel(store.activeAgentHash);
      }
    });
  }
  wireMomentsFeed();
}
var invoke9, listen3, groupPollTimer, GROUP_POLL_INTERVAL_MS, SAFE_IMAGE_MIMES, toastContainer, PLUS_DROPDOWN_ID, PLUS_DROPDOWN_MARGIN, PLUS_DROPDOWN_GAP, activePlusDropdown, activePlusTrigger;
var init_chat = __esm({
  "src/chat/chat.ts"() {
    init_store();
    init_create_dialog();
    init_side_panel();
    init_markdown();
    init_input_box();
    init_send_dialog();
    init_moments_feed();
    init_search_overlay();
    init_fehub_tab();
    invoke9 = (cmd, args) => getTauri9().invoke(cmd, args);
    listen3 = (event, handler) => getTauri9().listen(event, handler);
    groupPollTimer = null;
    GROUP_POLL_INTERVAL_MS = 3e4;
    SAFE_IMAGE_MIMES = /* @__PURE__ */ new Set([
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/gif",
      "image/webp"
    ]);
    toastContainer = null;
    PLUS_DROPDOWN_ID = "plus-dropdown";
    PLUS_DROPDOWN_MARGIN = 8;
    PLUS_DROPDOWN_GAP = 6;
    activePlusDropdown = null;
    activePlusTrigger = null;
    document.addEventListener("DOMContentLoaded", () => {
      wire();
      void initChat();
      void subscribeEvents();
      void setupSearchOverlay();
    });
  }
});
init_chat();
export {
  showToast2 as showToast
};
