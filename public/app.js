function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// Everything sent from this device is /reply, always attributed to "Edvard"
// server-side — used here purely to decide which side of the thread a
// bubble renders on, not as any kind of auth.
const MY_SENDER = "Edvard";
const POLL_INTERVAL_MS = 3000;
// Phase 5's "retry with a different provider" (Feature-Ideas.md #31,
// Edvard's own reframing away from silent auto-fallback): the architecture
// has no error signal at all when a reply doesn't show up (fire-and-forget
// /reply, async poll-based runner) — this is a timeout heuristic, not a
// real failure detection. Long enough that ordinary replies never trip it.
const RETRY_OFFER_MS = 45000;

const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");
const replyForm = document.getElementById("reply-form");
const replyInput = document.getElementById("reply-text");
const replyModel = document.getElementById("reply-model");
const conversationSelect = document.getElementById("conversation-select");
const themeToggle = document.getElementById("theme-toggle");
const searchToggle = document.getElementById("search-toggle");
const searchPanel = document.getElementById("search-panel");
const searchInput = document.getElementById("search-input");
const searchResultsEl = document.getElementById("search-results");
const newChatToggle = document.getElementById("new-chat-toggle");
const newChatForm = document.getElementById("new-chat-form");
const newChatName = document.getElementById("new-chat-name");
const newChatPersonality = document.getElementById("new-chat-personality");
const newChatStatus = document.getElementById("new-chat-status");
const newChatCancel = document.getElementById("new-chat-cancel");
const newChatModel = document.getElementById("new-chat-model");
const newChatThinkingRow = document.getElementById("new-chat-thinking-row");
const newChatThinking = document.getElementById("new-chat-thinking");
const newChatBadge = document.getElementById("new-chat-badge");
const templateRow = document.getElementById("template-row");
const settingsToggle = document.getElementById("conversation-settings-toggle");
const settingsForm = document.getElementById("conversation-settings-form");
const settingsName = document.getElementById("settings-name");
const settingsPersonality = document.getElementById("settings-personality");
const settingsModel = document.getElementById("settings-model");
const settingsBadge = document.getElementById("settings-badge");
const settingsThinkingRow = document.getElementById("settings-thinking-row");
const settingsThinking = document.getElementById("settings-thinking");
const settingsArchived = document.getElementById("settings-archived");
const settingsStatus = document.getElementById("settings-status");
const settingsCancel = document.getElementById("settings-cancel");
const settingsDelete = document.getElementById("settings-delete");

// null = the original global thread ("Main" in the switcher). A string id
// means a conversation created via POST /conversations. Seeded from the
// URL so a cold-opened notification (no window was already running) lands
// on the right conversation instead of defaulting to Main — see sw.js's
// notificationclick, which builds this URL.
let currentConversationId = new URLSearchParams(location.search).get("conversation") || null;
let renderedKey = "";
// Keyed by model id ("<provider>:<model>") -> full ModelOption, so the
// thinking checkbox / capability badge can react to a selection without a
// second round trip to the server.
let modelCatalogById = new Map();
let allConversations = [];

// --- Personality templates gallery (Phase 5, Feature-Ideas.md #14) -------
// Static to start, matches this platform's PoC-first bias — a real
// templates *editor* is out of scope for this round.
const PERSONALITY_TEMPLATES = [
  { name: "Trainer", text: "You are a supportive but honest fitness/training coach. Be direct about what's working and what isn't, celebrate real progress, and never sugarcoat a missed session." },
  { name: "Study buddy", text: "You are a patient study partner. Ask questions that check real understanding rather than just confirming what was said, and suggest what to review next." },
  { name: "Devil's advocate", text: "You push back on every claim with the strongest reasonable counterargument, even ones you don't fully believe, to stress-test thinking before a decision is made." },
  { name: "Plain assistant", text: "You are a helpful, concise assistant. Answer directly, ask for clarification only when genuinely needed." },
];

// --- Theme (Feature-Ideas.md #10) -----------------------------------------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("agora-theme", theme);
}
applyTheme(localStorage.getItem("agora-theme") || "dark");
themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  applyTheme(current);
});

// --- Unread badge (Feature-Ideas.md #43) ----------------------------------
// Best-effort — the Badging API isn't universally supported, and this is a
// presence signal ("something happened while you were away"), not a
// precise unread count, since the service worker can be torn down between
// pushes and can't reliably keep a running total.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && navigator.clearAppBadge) {
    navigator.clearAppBadge().catch(() => {});
  }
});

// --- Minimal, safe markdown (Feature-Ideas.md #1) -------------------------
// Escapes first, then layers a small set of markdown substitutions on top
// of the already-escaped text — so even if a substitution's own regex has
// a bug, the worst case is malformed *text*, never an injected tag, since
// raw '<'/'>'/'&' from the source message are gone before any markdown
// pattern runs.
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Placeholder uses \0 so it can never collide with real prose the way a
// plain " 3 " token could (an earlier version of this function used that
// and would have silently corrupted any message containing an ordinary
// number like "3 reps" by splicing in an unrelated stashed code block).
const CODE_BLOCK_PLACEHOLDER = (i) => `\0CODEBLOCK${i}\0`;
const CODE_BLOCK_PLACEHOLDER_RE = /\0CODEBLOCK(\d+)\0/g;

function renderMarkdown(text) {
  const escaped = escapeHtml(text);
  const codeBlocks = [];
  // Fenced code blocks first (so ** or _ inside them isn't touched below),
  // stashed and restored after the rest of the substitutions run.
  let withPlaceholders = escaped.replace(/```([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(`<pre><code>${code}</code></pre>`);
    return CODE_BLOCK_PLACEHOLDER(codeBlocks.length - 1);
  });
  withPlaceholders = withPlaceholders
    .replace(/`([^`\n]+?)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "<em>$1</em>")
    // Only http(s) links — escapeHtml already ran, so the URL text here
    // can't contain a raw quote/angle-bracket to break out of the attribute.
    .replace(/\[([^\]\n]+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // Restore code blocks LAST, after paragraph-splitting and newline-to-<br>
  // conversion — the placeholder token has no newlines of its own, so a
  // multi-line code block's real newlines survive untouched inside <pre>
  // instead of being turned into <br> (an earlier version restored code
  // blocks first and corrupted their formatting this way).
  const paragraphs = withPlaceholders
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  const withCode = paragraphs.replace(CODE_BLOCK_PLACEHOLDER_RE, (_m, i) => codeBlocks[Number(i)]);
  return withCode || "<p></p>";
}

// --- Avatars (Feature-Ideas.md #11) ---------------------------------------
const AVATAR_COLORS = ["#2563eb", "#7c3aed", "#db2777", "#059669", "#d97706", "#0891b2", "#dc2626"];
function avatarFor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return { color: AVATAR_COLORS[hash % AVATAR_COLORS.length], initial: (name[0] || "?").toUpperCase() };
}

function messagesEndpoint() {
  return currentConversationId ? `/conversations/${currentConversationId}/messages` : "/messages";
}

function replyEndpoint() {
  return currentConversationId ? `/conversations/${currentConversationId}/reply` : "/reply";
}

function messageEndpoint(messageId) {
  return currentConversationId
    ? `/conversations/${currentConversationId}/messages/${messageId}`
    : `/messages/${messageId}`;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

let editingMessageId = null;
let lastRenderedMessages = [];

function renderMessages(messages) {
  lastRenderedMessages = messages;
  const key = `${currentConversationId ?? "main"}:${messages.map((m) => `${m.id}:${m.text}`).join(",")}:${editingMessageId}`;
  if (key === renderedKey) {
    updateRetryBanner(messages);
    return;
  }
  renderedKey = key;

  const nearBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;

  messagesEl.innerHTML = "";
  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.id = "empty";
    empty.textContent = "No messages yet.";
    messagesEl.appendChild(empty);
  } else {
    messages.forEach((message, index) => {
      messagesEl.appendChild(renderBubbleRow(message, index === messages.length - 1));
    });
  }
  updateRetryBanner(messages);

  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderBubbleRow(message, isLast) {
  const mine = message.sender === MY_SENDER;
  const row = document.createElement("div");
  row.className = `bubble-row ${mine ? "mine" : "theirs"}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  const { color, initial } = avatarFor(message.sender);
  avatar.style.background = color;
  avatar.textContent = initial;
  row.appendChild(avatar);

  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap";

  const bubble = document.createElement("div");
  bubble.className = `bubble ${mine ? "mine" : "theirs"}`;

  const meta = document.createElement("span");
  meta.className = "meta";
  const deliveredMark = mine ? " · ✓" : "";
  const overrideMark = message.modelOverride ? ` · ${message.modelOverride.split(":")[1] || message.modelOverride}` : "";
  meta.textContent = `${message.sender} · ${formatTime(message.ts)}${deliveredMark}${overrideMark}`;
  bubble.appendChild(meta);

  if (editingMessageId === message.id) {
    const editArea = document.createElement("textarea");
    editArea.value = message.text;
    editArea.rows = Math.min(6, Math.max(2, message.text.split("\n").length));
    editArea.style.width = "100%";
    editArea.style.font = "inherit";
    bubble.appendChild(editArea);
    wrap.appendChild(bubble);

    const actions = document.createElement("div");
    actions.className = "bubble-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save & resend";
    save.addEventListener("click", async () => {
      const text = editArea.value.trim();
      if (!text) return;
      await fetch(messageEndpoint(message.id), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      editingMessageId = null;
      renderedKey = "";
      fetchMessages();
    });
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      editingMessageId = null;
      renderedKey = "";
      renderMessages(lastRenderedMessages);
    });
    actions.append(save, cancel);
    wrap.appendChild(actions);
    row.appendChild(wrap);
    return row;
  }

  const body = document.createElement("div");
  body.innerHTML = renderMarkdown(message.text);
  bubble.appendChild(body);
  wrap.appendChild(bubble);

  const actions = document.createElement("div");
  actions.className = "bubble-actions";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
    } catch {
      // clipboard permission denied or unavailable — no-op, button just
      // doesn't confirm
    }
  });
  actions.appendChild(copyBtn);

  if (mine) {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.title = "Edit and resend — removes any reply that followed";
    editBtn.addEventListener("click", () => {
      editingMessageId = message.id;
      renderedKey = "";
      renderMessages(lastRenderedMessages);
    });
    actions.appendChild(editBtn);
  }

  if (!mine && isLast) {
    const regenBtn = document.createElement("button");
    regenBtn.type = "button";
    regenBtn.textContent = "↻ Regenerate";
    regenBtn.title = "Delete this reply so it gets regenerated";
    regenBtn.addEventListener("click", async () => {
      await fetch(messageEndpoint(message.id), { method: "DELETE" });
      renderedKey = "";
      fetchMessages();
    });
    actions.appendChild(regenBtn);
  }

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", async () => {
    await fetch(messageEndpoint(message.id), { method: "DELETE" });
    renderedKey = "";
    fetchMessages();
  });
  actions.appendChild(deleteBtn);

  wrap.appendChild(actions);
  row.appendChild(wrap);
  return row;
}

// --- "X is typing" + retry-with-a-different-provider (Feature-Ideas.md
// #3, #31) — both are heuristics off the same signal (last message is
// Edvard's, unanswered), not a real typing/error event from the runner,
// which has no way to publish either today. Tracked as a single
// "trailing status" element regardless of which of the two it currently
// is, so every poll replaces it instead of appending a duplicate.
let trailingStatusEl = null;
function updateRetryBanner(messages) {
  if (trailingStatusEl) {
    trailingStatusEl.remove();
    trailingStatusEl = null;
  }
  if (messages.length === 0) return;
  const last = messages[messages.length - 1];
  if (last.sender !== MY_SENDER) return;

  const waitedMs = Date.now() - new Date(last.ts).getTime();
  if (waitedMs < RETRY_OFFER_MS) {
    const indicator = document.createElement("div");
    indicator.className = "typing-indicator";
    indicator.textContent = "Waiting for a reply…";
    messagesEl.appendChild(indicator);
    trailingStatusEl = indicator;
    return;
  }

  const banner = document.createElement("div");
  banner.className = "retry-banner";
  banner.textContent = "No reply yet. ";
  const select = document.createElement("select");
  for (const model of modelCatalogById.values()) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label;
    select.appendChild(option);
  }
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Retry";
  retry.addEventListener("click", async () => {
    await fetch(messageEndpoint(last.id), { method: "DELETE" });
    await fetch(replyEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: last.text, model: select.value || undefined }),
    });
    renderedKey = "";
    fetchMessages();
  });
  banner.append(select, retry);
  messagesEl.appendChild(banner);
  trailingStatusEl = banner;
}

async function fetchMessages() {
  try {
    const res = await fetch(messagesEndpoint());
    if (!res.ok) return;
    const data = await res.json();
    renderMessages(data.messages);
  } catch {
    // transient network hiccup — the next poll retries
  }
}

async function loadConversationList() {
  try {
    const res = await fetch("/conversations");
    if (!res.ok) return;
    const { conversations } = await res.json();
    allConversations = conversations;
    conversationSelect.innerHTML = "";
    const mainOption = document.createElement("option");
    mainOption.value = "";
    mainOption.textContent = "Main";
    conversationSelect.appendChild(mainOption);
    // Archived conversations are hidden from the switcher, not deleted
    // (Feature-Ideas.md #81) — still reachable via search or a direct link.
    for (const conversation of conversations) {
      if (conversation.archived) continue;
      const option = document.createElement("option");
      option.value = conversation.id;
      option.textContent = conversation.name;
      conversationSelect.appendChild(option);
    }
    conversationSelect.value = currentConversationId ?? "";
    settingsToggle.disabled = !currentConversationId;
  } catch {
    // transient network hiccup — leave the switcher as-is
  }
}

function capabilityBadgeText(model) {
  if (!model) return "";
  const parts = [];
  if (model.contextWindow) parts.push(model.contextWindow);
  parts.push(model.supportsThinking ? "thinking-capable" : "no thinking");
  return parts.join(" · ");
}

async function loadModelCatalog() {
  try {
    const res = await fetch("/models");
    if (!res.ok) return;
    const { models } = await res.json();
    modelCatalogById = new Map(models.map((model) => [model.id, model]));

    for (const select of [newChatModel, settingsModel]) {
      select.innerHTML = "";
      const groups = new Map();
      for (const model of models) {
        if (!groups.has(model.provider)) {
          const group = document.createElement("optgroup");
          group.label = model.provider === "anthropic" ? "Anthropic" : "Gemini";
          groups.set(model.provider, group);
          select.appendChild(group);
        }
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.label;
        groups.get(model.provider).appendChild(option);
      }
    }

    replyModel.innerHTML = "";
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "Default model";
    replyModel.appendChild(defaultOption);
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label;
      replyModel.appendChild(option);
    }

    updateThinkingVisibility(newChatModel, newChatThinkingRow, newChatThinking, newChatBadge);
    updateThinkingVisibility(settingsModel, settingsThinkingRow, settingsThinking, settingsBadge);
  } catch {
    // transient network hiccup — forms just won't have model options yet
  }
}

function updateThinkingVisibility(select, row, checkbox, badgeEl) {
  const model = modelCatalogById.get(select.value);
  const supportsThinking = Boolean(model && model.supportsThinking);
  row.hidden = !supportsThinking;
  if (!supportsThinking) checkbox.checked = false;
  if (badgeEl) badgeEl.textContent = capabilityBadgeText(model);
}

newChatModel.addEventListener("change", () =>
  updateThinkingVisibility(newChatModel, newChatThinkingRow, newChatThinking, newChatBadge),
);
settingsModel.addEventListener("change", () =>
  updateThinkingVisibility(settingsModel, settingsThinkingRow, settingsThinking, settingsBadge),
);

// --- Personality templates gallery ----------------------------------------
for (const template of PERSONALITY_TEMPLATES) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "template-chip";
  chip.textContent = template.name;
  chip.addEventListener("click", () => {
    newChatPersonality.value = template.text;
  });
  templateRow.appendChild(chip);
}

// --- Search (Feature-Ideas.md #77/#78) ------------------------------------
let searchDebounce;
searchToggle.addEventListener("click", () => {
  searchPanel.hidden = !searchPanel.hidden;
  if (!searchPanel.hidden) searchInput.focus();
});
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(runSearch, 250);
});
async function runSearch() {
  const q = searchInput.value.trim();
  searchResultsEl.innerHTML = "";
  if (!q) return;
  try {
    const res = await fetch(`/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return;
    const { results } = await res.json();
    for (const result of results.slice(0, 50)) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "search-result";
      const nameEl = document.createElement("div");
      nameEl.className = "conv-name";
      nameEl.textContent = result.conversationName;
      const textEl = document.createElement("div");
      textEl.textContent = result.message.text.slice(0, 140);
      item.append(nameEl, textEl);
      item.addEventListener("click", () => {
        currentConversationId = result.conversationId;
        conversationSelect.value = result.conversationId ?? "";
        renderedKey = "";
        searchPanel.hidden = true;
        fetchMessages();
        settingsToggle.disabled = !currentConversationId;
      });
      searchResultsEl.appendChild(item);
    }
  } catch {
    // transient network hiccup — leave results as they were
  }
}

conversationSelect.addEventListener("change", () => {
  currentConversationId = conversationSelect.value || null;
  editingMessageId = null;
  renderedKey = "";
  settingsToggle.disabled = !currentConversationId;
  settingsForm.hidden = true;
  fetchMessages();
});

// --- New conversation ------------------------------------------------------
newChatToggle.addEventListener("click", () => {
  settingsForm.hidden = true;
  newChatForm.hidden = !newChatForm.hidden;
  newChatStatus.textContent = "";
  if (!newChatForm.hidden) newChatName.focus();
});

newChatCancel.addEventListener("click", () => {
  newChatForm.hidden = true;
  newChatName.value = "";
  newChatPersonality.value = "";
  newChatStatus.textContent = "";
});

newChatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = newChatName.value.trim();
  if (!name) return;
  const personality = newChatPersonality.value.trim();
  const model = newChatModel.value || undefined;
  const thinking = newChatThinkingRow.hidden ? false : newChatThinking.checked;

  newChatStatus.textContent = "Creating...";
  try {
    const res = await fetch("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, personality, model, thinking }),
    });
    if (!res.ok) {
      newChatStatus.textContent = "Failed to create.";
      return;
    }
    const { conversation } = await res.json();
    newChatName.value = "";
    newChatPersonality.value = "";
    newChatThinking.checked = false;
    newChatForm.hidden = true;
    await loadConversationList();
    currentConversationId = conversation.id;
    conversationSelect.value = conversation.id;
    settingsToggle.disabled = false;
    renderedKey = "";
    fetchMessages();
  } catch {
    newChatStatus.textContent = "Failed to create.";
  }
});

// --- Conversation settings (rename/edit personality/archive/delete) -------
settingsToggle.addEventListener("click", async () => {
  if (!currentConversationId) return;
  newChatForm.hidden = true;
  if (!settingsForm.hidden) {
    settingsForm.hidden = true;
    return;
  }
  try {
    const res = await fetch(`/conversations/${currentConversationId}/messages`);
    if (!res.ok) return;
    const conversation = await res.json();
    settingsName.value = conversation.name;
    settingsPersonality.value = conversation.personality || "";
    settingsModel.value = conversation.model;
    settingsThinking.checked = Boolean(conversation.thinking);
    settingsArchived.checked = Boolean(conversation.archived);
    updateThinkingVisibility(settingsModel, settingsThinkingRow, settingsThinking, settingsBadge);
    settingsStatus.textContent = "";
    settingsForm.hidden = false;
  } catch {
    settingsStatus.textContent = "Failed to load conversation.";
  }
});

settingsCancel.addEventListener("click", () => {
  settingsForm.hidden = true;
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentConversationId) return;
  settingsStatus.textContent = "Saving...";
  try {
    const res = await fetch(`/conversations/${currentConversationId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: settingsName.value.trim(),
        personality: settingsPersonality.value.trim(),
        model: settingsModel.value,
        thinking: settingsThinkingRow.hidden ? false : settingsThinking.checked,
        archived: settingsArchived.checked,
      }),
    });
    if (!res.ok) {
      settingsStatus.textContent = "Failed to save.";
      return;
    }
    settingsForm.hidden = true;
    if (settingsArchived.checked) {
      currentConversationId = null;
      renderedKey = "";
    }
    await loadConversationList();
    conversationSelect.value = currentConversationId ?? "";
    fetchMessages();
  } catch {
    settingsStatus.textContent = "Failed to save.";
  }
});

settingsDelete.addEventListener("click", async () => {
  if (!currentConversationId) return;
  if (!confirm("Delete this conversation? This can't be undone.")) return;
  try {
    await fetch(`/conversations/${currentConversationId}`, { method: "DELETE" });
    currentConversationId = null;
    settingsForm.hidden = true;
    renderedKey = "";
    await loadConversationList();
    conversationSelect.value = "";
    fetchMessages();
  } catch {
    settingsStatus.textContent = "Failed to delete.";
  }
});

async function subscribeToPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    setStatus("Push not supported here — chat still works.");
    return;
  }

  const registration = await navigator.serviceWorker.register("/sw.js");

  navigator.serviceWorker.addEventListener("message", async (event) => {
    if (!event.data || event.data.type !== "agora-push") return;
    // conversationId is only present when the message came from an actual
    // notification tap (see sw.js) — a background push while the tab is
    // already open just refreshes the current view, it doesn't steal focus
    // to a different conversation.
    if (event.data.conversationId && event.data.conversationId !== currentConversationId) {
      currentConversationId = event.data.conversationId;
      await loadConversationList();
      renderedKey = "";
    }
    fetchMessages();
  });

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    setStatus("Notifications off — chat still works here.");
    return;
  }

  const keyRes = await fetch("/vapid-public-key");
  if (!keyRes.ok) {
    setStatus("Server isn't configured with VAPID keys yet.");
    return;
  }
  const { publicKey } = await keyRes.json();

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  const res = await fetch("/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });

  setStatus(res.ok ? "" : "Failed to register for notifications.");
}

// --- Auto-growing textarea (Feature-Ideas.md #9) --------------------------
function autoGrow() {
  replyInput.style.height = "auto";
  replyInput.style.height = `${replyInput.scrollHeight}px`;
}
replyInput.addEventListener("input", autoGrow);

replyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    replyForm.requestSubmit();
  }
});

replyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = replyInput.value.trim();
  if (!text) return;
  const model = replyModel.value || undefined;
  replyInput.value = "";
  autoGrow();
  replyModel.value = "";
  replyInput.disabled = true;
  try {
    await fetch(replyEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, model }),
    });
  } finally {
    replyInput.disabled = false;
    replyInput.focus();
  }
  renderedKey = "";
  fetchMessages();
});

fetchMessages();
loadConversationList();
loadModelCatalog();
setInterval(fetchMessages, POLL_INTERVAL_MS);
subscribeToPush();
