function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// Everything sent from this device is /reply, always attributed to "Edvard"
// server-side — used here purely to decide which side a message renders
// on, not as any kind of auth.
const MY_SENDER = "Edvard";
const POLL_INTERVAL_MS = 3000;
// "Retry with a different provider" (Feature-Ideas.md #31, Edvard's own
// reframing away from silent auto-fallback): the architecture has no error
// signal at all when a reply doesn't show up (fire-and-forget /reply,
// async poll-based runner) — this is a timeout heuristic, not real failure
// detection. Long enough that ordinary replies never trip it.
const RETRY_OFFER_MS = 45000;

const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");
const headerTitle = document.getElementById("header-title");
const drawerOpenBtn = document.getElementById("drawer-open");
const drawerCloseBtn = document.getElementById("drawer-close");
const drawerScrim = document.getElementById("drawer-scrim");
const drawer = document.getElementById("drawer");
const drawerSearchInput = document.getElementById("drawer-search-input");
const drawerSearchResults = document.getElementById("drawer-search-results");
const drawerListWrap = document.getElementById("drawer-list-wrap");
const drawerList = document.getElementById("drawer-list");
const drawerNewChat = document.getElementById("drawer-new-chat");
const themeToggle = document.getElementById("theme-toggle");
const headerNewChatBtn = document.getElementById("header-new-chat");
const headerOverflowBtn = document.getElementById("header-overflow");

const actionSheetScrim = document.getElementById("action-sheet-scrim");
const actionSheetTitle = document.getElementById("action-sheet-title");
const sheetEdit = document.getElementById("sheet-edit");
const sheetArchive = document.getElementById("sheet-archive");
const sheetArchiveLabel = document.getElementById("sheet-archive-label");
const sheetDelete = document.getElementById("sheet-delete");
const sheetMainModel = document.getElementById("sheet-main-model");

const mainModelModalScrim = document.getElementById("main-model-modal-scrim");
const mainModelModal = document.getElementById("main-model-modal");
const mainModelSelect = document.getElementById("main-model-select");
const mainModelStatus = document.getElementById("main-model-status");
const mainModelCancel = document.getElementById("main-model-cancel");

const editModalScrim = document.getElementById("edit-modal-scrim");
const editModal = document.getElementById("edit-modal");
const editName = document.getElementById("edit-name");
const editTemplateRow = document.getElementById("edit-template-row");
const editPersonality = document.getElementById("edit-personality");
const editModel = document.getElementById("edit-model");
const editBadge = document.getElementById("edit-badge");
const editThinkingRow = document.getElementById("edit-thinking-row");
const editThinking = document.getElementById("edit-thinking");
const editStatus = document.getElementById("edit-status");
const editCancel = document.getElementById("edit-cancel");

const newChatModalScrim = document.getElementById("new-chat-modal-scrim");
const newChatModal = document.getElementById("new-chat-modal");
const newChatName = document.getElementById("new-chat-name");
const newChatTemplateRow = document.getElementById("new-chat-template-row");
const newChatPersonality = document.getElementById("new-chat-personality");
const newChatModel = document.getElementById("new-chat-model");
const newChatBadge = document.getElementById("new-chat-badge");
const newChatThinkingRow = document.getElementById("new-chat-thinking-row");
const newChatThinking = document.getElementById("new-chat-thinking");
const newChatStatus = document.getElementById("new-chat-status");
const newChatCancel = document.getElementById("new-chat-cancel");

const msgActionSheetScrim = document.getElementById("msg-action-sheet-scrim");
const msgActionSheet = document.getElementById("msg-action-sheet");
const msgSheetCopy = document.getElementById("msg-sheet-copy");
const msgSheetEdit = document.getElementById("msg-sheet-edit");
const msgSheetRegen = document.getElementById("msg-sheet-regen");
const msgSheetFork = document.getElementById("msg-sheet-fork");
const msgSheetDelete = document.getElementById("msg-sheet-delete");

const replyForm = document.getElementById("reply-form");
const replyInput = document.getElementById("reply-text");
const plusButton = document.getElementById("plus-button");
const attachFileInput = document.getElementById("attach-file-input");
const attachChipRow = document.getElementById("attach-chip-row");
const attachMenu = document.getElementById("attach-menu");
const attachMenuCamera = document.getElementById("attach-menu-camera");
const attachMenuPhotos = document.getElementById("attach-menu-photos");
const attachMenuFiles = document.getElementById("attach-menu-files");

// null = the original global thread ("Main" in the drawer). A string id
// means a conversation created via POST /conversations. Seeded from the
// URL so a cold-opened notification (no window was already running) lands
// on the right conversation instead of defaulting to Main — see sw.js's
// notificationclick, which builds this URL.
let currentConversationId = new URLSearchParams(location.search).get("conversation") || null;
let renderedKey = "";
let modelCatalogById = new Map();
let allConversations = [];
// Which conversation the open action sheet/edit modal applies to — usually
// currentConversationId, but a drawer row's own "⋮" can target a
// conversation without switching to it first.
let sheetTargetId = null;

const PERSONALITY_TEMPLATES = [
  { name: "Trainer", text: "You are a supportive but honest fitness/training coach. Be direct about what's working and what isn't, celebrate real progress, and never sugarcoat a missed session." },
  { name: "Study buddy", text: "You are a patient study partner. Ask questions that check real understanding rather than just confirming what was said, and suggest what to review next." },
  { name: "Devil's advocate", text: "You push back on every claim with the strongest reasonable counterargument, even ones you don't fully believe, to stress-test thinking before a decision is made." },
  { name: "Plain assistant", text: "You are a helpful, concise assistant. Answer directly, ask for clarification only when genuinely needed." },
];

// --- Theme ------------------------------------------------------------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("agora-theme", theme);
}
applyTheme(localStorage.getItem("agora-theme") || "dark");
themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  applyTheme(current);
});

// --- Unread badge -------------------------------------------------------
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && navigator.clearAppBadge) {
    navigator.clearAppBadge().catch(() => {});
  }
});

// --- Minimal, safe markdown ---------------------------------------------
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
  // instead of being turned into <br>.
  const paragraphs = withPlaceholders
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  const withCode = paragraphs.replace(CODE_BLOCK_PLACEHOLDER_RE, (_m, i) => codeBlocks[Number(i)]);
  return withCode || "<p></p>";
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
  if (!text) {
    statusEl.classList.remove("visible");
    statusEl.textContent = "";
    return;
  }
  statusEl.textContent = text;
  statusEl.classList.add("visible");
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// --- Drawer -----------------------------------------------------------
function openDrawer() {
  drawer.hidden = false;
  drawerScrim.hidden = false;
}
function closeDrawer() {
  drawer.hidden = true;
  drawerScrim.hidden = true;
  drawerSearchInput.value = "";
  drawerSearchResults.hidden = true;
  drawerListWrap.hidden = false;
}
drawerOpenBtn.addEventListener("click", openDrawer);
drawerCloseBtn.addEventListener("click", closeDrawer);
drawerScrim.addEventListener("click", closeDrawer);

function renderDrawerRow(id, name, archived) {
  const row = document.createElement("div");
  row.className = `drawer-row ${id === currentConversationId ? "active" : ""}`;
  const nameEl = document.createElement("span");
  nameEl.className = "drawer-row-name";
  // Archived conversations only ever appear here via search (Feature-
  // Ideas.md #81 — hidden from the default list, not deleted) — labeled
  // so "how do I find it again to unarchive it" has an actual answer.
  nameEl.textContent = archived ? `${name} · Archived` : name;
  row.appendChild(nameEl);
  row.addEventListener("click", () => switchConversation(id));
  if (id !== null) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "drawer-row-more";
    more.textContent = "⋮";
    more.title = "Conversation actions";
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      openActionSheet(id, name);
    });
    row.appendChild(more);
  }
  return row;
}

async function switchConversation(id) {
  currentConversationId = id;
  editingMessageId = null;
  renderedKey = "";
  closeDrawer();
  updateHeaderControls();
  await fetchMessages();
}

async function loadConversationList() {
  try {
    const res = await fetch("/conversations");
    if (!res.ok) return;
    const { conversations } = await res.json();
    allConversations = conversations;
    renderDrawerList(conversations);
    updateHeaderControls();
  } catch {
    // transient network hiccup — leave the drawer as-is
  }
}

function renderDrawerList(conversations) {
  drawerList.innerHTML = "";
  drawerList.appendChild(renderDrawerRow(null, "Main"));
  // Archived conversations are hidden from the drawer, not deleted
  // (Feature-Ideas.md #81) — still reachable via search.
  for (const conversation of conversations) {
    if (conversation.archived) continue;
    drawerList.appendChild(renderDrawerRow(conversation.id, conversation.name));
  }
}

function updateHeaderControls() {
  if (!currentConversationId) {
    headerTitle.textContent = "Main";
    return;
  }
  const known = allConversations.find((c) => c.id === currentConversationId);
  if (known) headerTitle.textContent = known.name;
}

// --- Drawer search (conversation names client-side + message content via API) --
let searchDebounce;
drawerSearchInput.addEventListener("input", () => {
  const q = drawerSearchInput.value.trim();
  if (!q) {
    drawerSearchResults.hidden = true;
    drawerListWrap.hidden = false;
    return;
  }
  drawerListWrap.hidden = true;
  drawerSearchResults.hidden = false;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(q), 250);
});

async function runSearch(q) {
  drawerSearchResults.innerHTML = "";

  // Archived conversations ARE included here (unlike the default drawer
  // list) — search is the only way back to one once it's archived, so
  // excluding it here would make archiving a one-way trip.
  const nameMatches = allConversations.filter((c) =>
    c.name.toLowerCase().includes(q.toLowerCase()),
  );
  if (nameMatches.length > 0) {
    const label = document.createElement("div");
    label.className = "drawer-section-label";
    label.textContent = "Conversations";
    drawerSearchResults.appendChild(label);
    for (const match of nameMatches) {
      drawerSearchResults.appendChild(renderDrawerRow(match.id, match.name, match.archived));
    }
  }

  try {
    const res = await fetch(`/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return;
    const { results } = await res.json();
    if (results.length === 0) return;
    const label = document.createElement("div");
    label.className = "drawer-section-label";
    label.textContent = "Messages";
    drawerSearchResults.appendChild(label);
    for (const result of results.slice(0, 30)) {
      const item = document.createElement("div");
      item.className = "search-hit";
      const nameEl = document.createElement("span");
      nameEl.className = "hit-name";
      nameEl.textContent = result.conversationName;
      const textEl = document.createElement("span");
      textEl.textContent = result.message.text.slice(0, 140);
      item.append(nameEl, textEl);
      item.addEventListener("click", () => switchConversation(result.conversationId));
      drawerSearchResults.appendChild(item);
    }
  } catch {
    // transient network hiccup — name matches above still work
  }
}

// --- Action sheet -------------------------------------------------------
// id === null means "Main" — the legacy global thread has no backend
// conversation record, so rename/archive/delete don't apply to it; it only
// gets the default-model row instead of the usual three.
function openActionSheet(id, name) {
  sheetTargetId = id;
  actionSheetTitle.textContent = name;
  const isMain = id === null;
  sheetEdit.hidden = isMain;
  sheetArchive.hidden = isMain;
  sheetDelete.hidden = isMain;
  sheetMainModel.hidden = !isMain;
  if (!isMain) {
    const conversation = allConversations.find((c) => c.id === id);
    sheetArchiveLabel.textContent = conversation && conversation.archived ? "Unarchive" : "Archive";
  }
  actionSheetScrim.hidden = false;
}
function closeActionSheet() {
  actionSheetScrim.hidden = true;
}
actionSheetScrim.addEventListener("click", (event) => {
  if (event.target === actionSheetScrim) closeActionSheet();
});
headerOverflowBtn.addEventListener("click", () => {
  openActionSheet(currentConversationId, headerTitle.textContent);
});

sheetArchive.addEventListener("click", async () => {
  if (!sheetTargetId) return;
  const conversation = allConversations.find((c) => c.id === sheetTargetId);
  const archived = !(conversation && conversation.archived);
  await fetch(`/conversations/${sheetTargetId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  closeActionSheet();
  if (archived && sheetTargetId === currentConversationId) {
    currentConversationId = null;
    renderedKey = "";
    updateHeaderControls();
    await fetchMessages();
  }
  await loadConversationList();
});

sheetDelete.addEventListener("click", async () => {
  if (!sheetTargetId) return;
  if (!confirm("Delete this conversation? This can't be undone.")) return;
  await fetch(`/conversations/${sheetTargetId}`, { method: "DELETE" });
  closeActionSheet();
  if (sheetTargetId === currentConversationId) {
    currentConversationId = null;
    renderedKey = "";
    updateHeaderControls();
    await fetchMessages();
  }
  await loadConversationList();
});

sheetEdit.addEventListener("click", async () => {
  if (!sheetTargetId) return;
  closeActionSheet();
  try {
    const res = await fetch(`/conversations/${sheetTargetId}/messages`);
    if (!res.ok) return;
    const conversation = await res.json();
    editModal.dataset.targetId = sheetTargetId;
    editName.value = conversation.name;
    editPersonality.value = conversation.personality || "";
    editModel.value = conversation.model;
    editThinking.checked = Boolean(conversation.thinking);
    updateThinkingVisibility(editModel, editThinkingRow, editThinking, editBadge);
    editStatus.textContent = "";
    editModalScrim.hidden = false;
  } catch {
    setStatus("Failed to load conversation.");
  }
});

editModalScrim.addEventListener("click", (event) => {
  if (event.target === editModalScrim) editModalScrim.hidden = true;
});
editCancel.addEventListener("click", () => {
  editModalScrim.hidden = true;
});
editModal.addEventListener("submit", async (event) => {
  event.preventDefault();
  const targetId = editModal.dataset.targetId;
  if (!targetId) return;
  editStatus.textContent = "Saving...";
  try {
    const res = await fetch(`/conversations/${targetId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: editName.value.trim(),
        personality: editPersonality.value.trim(),
        model: editModel.value,
        thinking: editThinkingRow.hidden ? false : editThinking.checked,
      }),
    });
    if (!res.ok) {
      editStatus.textContent = "Failed to save.";
      return;
    }
    editModalScrim.hidden = true;
    await loadConversationList();
    updateHeaderControls();
  } catch {
    editStatus.textContent = "Failed to save.";
  }
});

// --- Main's default model (localStorage-backed — Main has no backend
// conversation record to store a model field on, unlike named conversations,
// so this is the client-side equivalent of that field for the legacy
// thread). Read by the replyForm submit handler further down. ---------------
const MAIN_DEFAULT_MODEL_KEY = "agora-main-default-model";
function getMainDefaultModel() {
  const stored = localStorage.getItem(MAIN_DEFAULT_MODEL_KEY);
  // Guard against a stale id from a model that's since been removed from
  // MODEL_CATALOG — sending an unknown id would 400 the whole /reply call.
  return stored && modelCatalogById.has(stored) ? stored : undefined;
}

sheetMainModel.addEventListener("click", () => {
  closeActionSheet();
  populateModelSelect(mainModelSelect, latestModelList);
  const current = getMainDefaultModel();
  if (current) mainModelSelect.value = current;
  mainModelStatus.textContent = "";
  mainModelModalScrim.hidden = false;
});
mainModelModalScrim.addEventListener("click", (event) => {
  if (event.target === mainModelModalScrim) mainModelModalScrim.hidden = true;
});
mainModelCancel.addEventListener("click", () => {
  mainModelModalScrim.hidden = true;
});
mainModelModal.addEventListener("submit", (event) => {
  event.preventDefault();
  localStorage.setItem(MAIN_DEFAULT_MODEL_KEY, mainModelSelect.value);
  mainModelModalScrim.hidden = true;
});

// --- New chat modal -------------------------------------------------------
function openNewChatModal() {
  closeDrawer();
  newChatName.value = "";
  newChatPersonality.value = "";
  newChatThinking.checked = false;
  newChatStatus.textContent = "";
  newChatModalScrim.hidden = false;
  newChatName.focus();
}
drawerNewChat.addEventListener("click", openNewChatModal);
headerNewChatBtn.addEventListener("click", openNewChatModal);
newChatModalScrim.addEventListener("click", (event) => {
  if (event.target === newChatModalScrim) newChatModalScrim.hidden = true;
});
newChatCancel.addEventListener("click", () => {
  newChatModalScrim.hidden = true;
});
newChatModal.addEventListener("submit", async (event) => {
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
    newChatModalScrim.hidden = true;
    await loadConversationList();
    await switchConversation(conversation.id);
  } catch {
    newChatStatus.textContent = "Failed to create.";
  }
});

// --- Personality templates (shared by both modals) ------------------------
function renderTemplateRow(container, targetTextarea) {
  container.innerHTML = "";
  for (const template of PERSONALITY_TEMPLATES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "template-chip";
    chip.textContent = template.name;
    chip.addEventListener("click", () => {
      targetTextarea.value = template.text;
    });
    container.appendChild(chip);
  }
}
renderTemplateRow(newChatTemplateRow, newChatPersonality);
renderTemplateRow(editTemplateRow, editPersonality);

// --- Model catalog --------------------------------------------------------
function capabilityBadgeText(model) {
  if (!model) return "";
  const parts = [];
  if (model.contextWindow) parts.push(model.contextWindow);
  parts.push(model.supportsThinking ? "thinking-capable" : "no thinking");
  return parts.join(" · ");
}

function populateModelSelect(select, models) {
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

let latestModelList = [];
async function loadModelCatalog() {
  try {
    const res = await fetch("/models");
    if (!res.ok) return;
    const { models } = await res.json();
    modelCatalogById = new Map(models.map((model) => [model.id, model]));
    latestModelList = models;

    for (const select of [newChatModel, editModel]) {
      populateModelSelect(select, models);
    }

    updateThinkingVisibility(newChatModel, newChatThinkingRow, newChatThinking, newChatBadge);
    updateThinkingVisibility(editModel, editThinkingRow, editThinking, editBadge);
  } catch {
    // transient network hiccup — modals just won't have model options yet
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
editModel.addEventListener("change", () =>
  updateThinkingVisibility(editModel, editThinkingRow, editThinking, editBadge),
);

// --- Attach files (UI-only — no upload endpoint exists yet, see the submit
// handler below) ------------------------------------------------------------
let stagedFiles = [];

plusButton.addEventListener("click", (event) => {
  event.stopPropagation();
  attachMenu.hidden = !attachMenu.hidden;
});
document.addEventListener("click", (event) => {
  if (!attachMenu.hidden && !attachMenu.contains(event.target) && event.target !== plusButton) {
    attachMenu.hidden = true;
  }
});

// One shared file input, reconfigured per row rather than three separate
// inputs — capture/accept only matter at the moment .click() opens the
// native picker, so setting them just before that is enough.
function openFilePicker({ accept = "", capture = "" } = {}) {
  attachFileInput.accept = accept;
  if (capture) attachFileInput.setAttribute("capture", capture);
  else attachFileInput.removeAttribute("capture");
  attachMenu.hidden = true;
  attachFileInput.click();
}
attachMenuCamera.addEventListener("click", () => openFilePicker({ accept: "image/*", capture: "environment" }));
attachMenuPhotos.addEventListener("click", () => openFilePicker({ accept: "image/*" }));
attachMenuFiles.addEventListener("click", () => openFilePicker());

attachFileInput.addEventListener("change", () => {
  stagedFiles.push(...attachFileInput.files);
  attachFileInput.value = ""; // allow re-selecting the same filename later
  renderAttachChips();
});

function renderAttachChips() {
  attachChipRow.innerHTML = "";
  attachChipRow.hidden = stagedFiles.length === 0;
  stagedFiles.forEach((file, index) => {
    const chip = document.createElement("span");
    chip.className = "attach-chip";
    const name = document.createElement("span");
    name.className = "attach-chip-name";
    name.textContent = file.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attach-chip-remove";
    remove.textContent = "✕";
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      stagedFiles.splice(index, 1);
      renderAttachChips();
    });
    chip.append(name, remove);
    attachChipRow.appendChild(chip);
  });
}

// --- Messages rendering -----------------------------------------------------
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
      messagesEl.appendChild(renderMessageBlock(message, index === messages.length - 1));
    });
  }
  updateRetryBanner(messages);

  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessageBlock(message, isLast) {
  const mine = message.sender === MY_SENDER;
  const block = document.createElement("div");
  block.className = `msg-block ${mine ? "mine" : "theirs"}`;

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const deliveredMark = mine ? " · sent" : "";
  const overrideMark = message.modelOverride ? ` · ${message.modelOverride.split(":")[1] || message.modelOverride}` : "";
  meta.textContent = `${message.sender} · ${formatTime(message.ts)}${deliveredMark}${overrideMark}`;
  block.appendChild(meta);

  if (editingMessageId === message.id) {
    const editArea = document.createElement("textarea");
    editArea.className = "msg-edit-area";
    editArea.value = message.text;
    editArea.rows = Math.min(8, Math.max(2, message.text.split("\n").length));
    block.appendChild(editArea);

    const actions = document.createElement("div");
    actions.className = "msg-edit-actions";
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
    block.appendChild(actions);
    return block;
  }

  const body = document.createElement("div");
  body.className = mine ? "msg-bubble mine" : "msg-plain";
  body.innerHTML = renderMarkdown(message.text);
  block.appendChild(body);
  attachLongPress(body, message, mine, isLast);

  return block;
}

// --- Long-press message action sheet ----------------------------------------
// Replaces the old always-visible copy/edit/regenerate/delete icon row —
// hold a message for 2s to get the same actions (plus Fork) as a bottom
// sheet, matching the ChatGPT/Gemini mobile pattern. Pointer Events cover
// touch + mouse + pen uniformly, no separate code paths needed.
const LONG_PRESS_MS = 2000;
const LONG_PRESS_MOVE_TOLERANCE = 10; // px — beyond this, treat it as a scroll/drag, not a hold
let longPressTimer = null;
let longPressStartPos = null;
let messageActionTarget = null; // the message object the open sheet applies to

function attachLongPress(el, message, mine, isLast) {
  const start = (event) => {
    if (event.button !== undefined && event.button !== 0) return; // primary button/touch only
    longPressStartPos = { x: event.clientX, y: event.clientY };
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      openMessageActionSheet(message, mine, isLast, el);
    }, LONG_PRESS_MS);
  };
  const cancel = () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    longPressStartPos = null;
  };
  const move = (event) => {
    if (!longPressStartPos) return;
    const dx = event.clientX - longPressStartPos.x;
    const dy = event.clientY - longPressStartPos.y;
    if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE) cancel();
  };
  el.addEventListener("pointerdown", start);
  el.addEventListener("pointerup", cancel);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("pointerleave", cancel);
  el.addEventListener("pointermove", move);
  // A hold that fired the sheet shouldn't also pop a native context menu.
  el.addEventListener("contextmenu", (event) => event.preventDefault());
}

// Positions a floating menu card near wherever it was triggered from
// (the long-pressed message) rather than a fixed spot — mirrors the
// ChatGPT mobile reference, where these menus appear anchored to their
// trigger. Clamped to the viewport so it can't render off-screen near an
// edge, and flips above the anchor if there's no room below.
function positionFloatingSheet(sheetEl, anchorRect) {
  const margin = 8;
  const sheetRect = sheetEl.getBoundingClientRect();
  let left = anchorRect.left;
  if (left + sheetRect.width + margin > window.innerWidth) left = window.innerWidth - sheetRect.width - margin;
  if (left < margin) left = margin;
  let top = anchorRect.bottom + 8;
  if (top + sheetRect.height + margin > window.innerHeight) top = anchorRect.top - sheetRect.height - 8;
  if (top < margin) top = margin;
  sheetEl.style.top = `${top}px`;
  sheetEl.style.left = `${left}px`;
}

function openMessageActionSheet(message, mine, isLast, anchorEl) {
  messageActionTarget = message;
  msgSheetEdit.hidden = !mine;
  msgSheetRegen.hidden = mine || !isLast;
  msgActionSheetScrim.hidden = false;
  positionFloatingSheet(msgActionSheet, anchorEl.getBoundingClientRect());
}
function closeMessageActionSheet() {
  msgActionSheetScrim.hidden = true;
  messageActionTarget = null;
}
msgActionSheetScrim.addEventListener("click", (event) => {
  if (event.target === msgActionSheetScrim) closeMessageActionSheet();
});

msgSheetCopy.addEventListener("click", async () => {
  const message = messageActionTarget;
  closeMessageActionSheet();
  if (!message) return;
  try {
    await navigator.clipboard.writeText(message.text);
    setStatus("Copied.");
  } catch {
    // clipboard permission denied or unavailable — no-op
  }
});

msgSheetEdit.addEventListener("click", () => {
  const message = messageActionTarget;
  closeMessageActionSheet();
  if (!message) return;
  editingMessageId = message.id;
  renderedKey = "";
  renderMessages(lastRenderedMessages);
});

msgSheetRegen.addEventListener("click", async () => {
  const message = messageActionTarget;
  closeMessageActionSheet();
  if (!message) return;
  await fetch(messageEndpoint(message.id), { method: "DELETE" });
  renderedKey = "";
  fetchMessages();
});

// Not implemented on the backend — no /fork route or branching data model
// exists yet. Surfaced as a real row rather than hidden so it's
// discoverable, but it's a stub until that's built (cf. RETRY_OFFER_MS
// above for the same "stub with a clear comment" convention).
msgSheetFork.addEventListener("click", () => {
  closeMessageActionSheet();
  setStatus("Fork isn't built yet.");
});

msgSheetDelete.addEventListener("click", async () => {
  const message = messageActionTarget;
  closeMessageActionSheet();
  if (!message) return;
  await fetch(messageEndpoint(message.id), { method: "DELETE" });
  renderedKey = "";
  fetchMessages();
});

// --- "Waiting for a reply" + retry-with-a-different-provider ---------------
// Both are heuristics off the same signal (last message is Edvard's,
// unanswered), not a real typing/error event from the runner, which has no
// way to publish either today. Tracked as a single "trailing status"
// element regardless of which of the two it currently is, so every poll
// replaces it instead of appending a duplicate.
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

// --- Auto-growing textarea ------------------------------------------------
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
  const model = currentConversationId ? undefined : getMainDefaultModel();
  const hadStagedFiles = stagedFiles.length > 0;
  replyInput.value = "";
  autoGrow();
  stagedFiles = [];
  renderAttachChips();
  replyInput.disabled = true;
  try {
    await fetch(replyEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, model }),
    });
    // No attachment upload route exists yet — staged files are UI-only for
    // now, so say so explicitly rather than silently dropping what was
    // attached.
    if (hadStagedFiles) setStatus("File attachments aren't wired up yet — sent as text only.");
  } finally {
    replyInput.disabled = false;
    replyInput.focus();
  }
  renderedKey = "";
  fetchMessages();
});

updateHeaderControls();
fetchMessages();
loadConversationList();
loadModelCatalog();
setInterval(fetchMessages, POLL_INTERVAL_MS);
subscribeToPush();
