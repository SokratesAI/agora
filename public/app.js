function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// Everything sent from this device is attributed to "Edvard" server-side —
// used here purely for rendering sides, not as any kind of auth.
const MY_SENDER = "Edvard";
const POLL_INTERVAL_MS = 3000;
// The sidebar changes far more slowly than an open conversation's messages,
// and re-rendering it is a full innerHTML rebuild, so it gets its own timer.
const LIST_POLL_INTERVAL_MS = 15000;
// How long a message sits unanswered before the thread stops saying
// "Waiting for a reply…" and starts explaining what it does and does not
// know. This is the only inference left in the waiting notice — see
// `describeWait` for why the rest of it is now observation.
const WAIT_NOTICE_MS = 45000;

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const messagesEl = $("messages");
const headerTitle = $("header-title");
const headerSubtitle = $("header-subtitle");
const drawerOpenBtn = $("drawer-open");
const drawerCloseBtn = $("drawer-close");
const drawerScrim = $("drawer-scrim");
const drawer = $("drawer");
const drawerSearchInput = $("drawer-search-input");
const drawerSearchResults = $("drawer-search-results");
const drawerListWrap = $("drawer-list-wrap");
const drawerList = $("drawer-list");
const drawerNewChat = $("drawer-new-chat");
const drawerNewFolder = $("drawer-new-folder");
const folderSheetScrim = $("folder-sheet-scrim");
const folderSheetTitle = $("folder-sheet-title");
const folderSheetList = $("folder-sheet-list");
const themeToggle = $("theme-toggle");
const headerNewChatBtn = $("header-new-chat");
const headerOverflowBtn = $("header-overflow");
const navPersonas = $("nav-personas");
const navHeartbeats = $("nav-heartbeats");
const navWorkflows = $("nav-workflows");
const navAudit = $("nav-audit");

const actionSheetScrim = $("action-sheet-scrim");
const actionSheetTitle = $("action-sheet-title");
const sheetEdit = $("sheet-edit");
const sheetAsk = $("sheet-ask");
const sheetPause = $("sheet-pause");
const sheetPauseLabel = $("sheet-pause-label");
const sheetArchive = $("sheet-archive");
const sheetArchiveLabel = $("sheet-archive-label");
const sheetDelete = $("sheet-delete");
const sheetMove = $("sheet-move");

const msgActionSheetScrim = $("msg-action-sheet-scrim");
const msgActionSheet = $("msg-action-sheet");
const msgSheetCopy = $("msg-sheet-copy");
const msgSheetSpeak = $("msg-sheet-speak");
const msgSheetEdit = $("msg-sheet-edit");
const msgSheetRegen = $("msg-sheet-regen");
const msgSheetFork = $("msg-sheet-fork");
const msgSheetForget = $("msg-sheet-forget");
const msgSheetForgetLabel = $("msg-sheet-forget-label");
const msgSheetDelete = $("msg-sheet-delete");

const editModalScrim = $("edit-modal-scrim");
const editModal = $("edit-modal");
const editName = $("edit-name");
const editPersonality = $("edit-personality");
const editModel = $("edit-model");
const editBadge = $("edit-badge");
const editThinkingRow = $("edit-thinking-row");
const editThinking = $("edit-thinking");
const editStickyFallbackRow = $("edit-sticky-fallback-row");
const editStickyFallback = $("edit-sticky-fallback");
const editMemory = $("edit-memory");
const editParticipants = $("edit-participants");
const editAddPersona = $("edit-add-persona");
const editAddPersonaBtn = $("edit-add-persona-btn");
const editStatus = $("edit-status");
const editCancel = $("edit-cancel");
const editOpenPersonaEditorBtn = $("edit-open-persona-editor");

const newChatModalScrim = $("new-chat-modal-scrim");
const newChatModal = $("new-chat-modal");
const newChatName = $("new-chat-name");
const newChatPersonaSource = $("new-chat-persona-source");
const newChatInlineFields = $("new-chat-inline-fields");
const newChatTemplateRow = $("new-chat-template-row");
const newChatPersonality = $("new-chat-personality");
const newChatModel = $("new-chat-model");
const newChatBadge = $("new-chat-badge");
const newChatThinkingRow = $("new-chat-thinking-row");
const newChatThinking = $("new-chat-thinking");
const newChatCapWebSearch = $("new-chat-cap-webSearch");
const newChatCapVaultRead = $("new-chat-cap-vaultRead");
const newChatCapVaultWrite = $("new-chat-cap-vaultWrite");
const newChatCapCodeExecution = $("new-chat-cap-codeExecution");
const newChatCapKubectlRead = $("new-chat-cap-kubectlRead");
const newChatCapGithubRead = $("new-chat-cap-githubRead");
const newChatCapManageAgora = $("new-chat-cap-manageAgora");
const newChatCapGithubWrite = $("new-chat-cap-githubWrite");
const newChatCapGithubMerge = $("new-chat-cap-githubMerge");
const newChatCapTerminalExec = $("new-chat-cap-terminalExec");
const newChatStatus = $("new-chat-status");
const newChatCancel = $("new-chat-cancel");

const askModalScrim = $("ask-modal-scrim");
const askModal = $("ask-modal");
const askText = $("ask-text");
const askAnswer = $("ask-answer");
const askStatus = $("ask-status");
const askCancel = $("ask-cancel");

const personaStudioScrim = $("persona-studio-scrim");
const personaStudioList = $("persona-studio-list");
const personaStudioAdd = $("persona-studio-add");
const personaStudioClose = $("persona-studio-close");

const personaFormScrim = $("persona-form-scrim");
const personaForm = $("persona-form");
const personaFormTitle = $("persona-form-title");
const personaFormName = $("persona-form-name");
const personaFormTemplateRow = $("persona-form-template-row");
const personaFormPersonality = $("persona-form-personality");
const personaFormModel = $("persona-form-model");
const personaFormBadge = $("persona-form-badge");
const personaFormThinkingRow = $("persona-form-thinking-row");
const personaFormThinking = $("persona-form-thinking");
const personaFormClaudeCliRestrictedRow = $("persona-form-claude-cli-restricted-row");
const personaFormClaudeCliRestricted = $("persona-form-claude-cli-restricted");
const personaFormClaudeCliStatelessRow = $("persona-form-claude-cli-stateless-row");
const personaFormClaudeCliStateless = $("persona-form-claude-cli-stateless");
const personaFormMemory = $("persona-form-memory");
const personaFormTemplate = $("persona-form-template");
const personaFormPreviewText = $("persona-form-preview-text");
const personaFormPreviewBtn = $("persona-form-preview-btn");
const personaFormPreviewOut = $("persona-form-preview-out");
const personaFormStatus = $("persona-form-status");
const personaFormCancel = $("persona-form-cancel");
const capWebSearch = $("cap-webSearch");
const capVaultRead = $("cap-vaultRead");
const capVaultWrite = $("cap-vaultWrite");
const capCodeExecution = $("cap-codeExecution");
const capKubectlRead = $("cap-kubectlRead");
const capGithubRead = $("cap-githubRead");
const capManageAgora = $("cap-manageAgora");
const capGithubWrite = $("cap-githubWrite");
const capGithubMerge = $("cap-githubMerge");
const capTerminalExec = $("cap-terminalExec");

const heartbeatStudioScrim = $("heartbeat-studio-scrim");
const heartbeatStudioList = $("heartbeat-studio-list");
const heartbeatStudioAdd = $("heartbeat-studio-add");
const heartbeatStudioClose = $("heartbeat-studio-close");

const NEW_CHANNEL_SENTINEL = "__new__";
const heartbeatFormScrim = $("heartbeat-form-scrim");
const heartbeatForm = $("heartbeat-form");
const heartbeatFormTitle = $("heartbeat-form-title");
const heartbeatFormName = $("heartbeat-form-name");
const heartbeatFormPersona = $("heartbeat-form-persona");
const heartbeatFormConversation = $("heartbeat-form-conversation");
const heartbeatFormNewConversationName = $("heartbeat-form-new-conversation-name");
const heartbeatFormWorkflow = $("heartbeat-form-workflow");
const heartbeatFormScheduleType = $("heartbeat-form-schedule-type");
const heartbeatFormTime = $("heartbeat-form-time");
const heartbeatFormInterval = $("heartbeat-form-interval");
const heartbeatFormUnit = $("heartbeat-form-unit");
const heartbeatFormAnchorRow = $("heartbeat-form-anchor-row");
const heartbeatFormAnchorEnabled = $("heartbeat-form-anchor-enabled");
const heartbeatFormAnchor = $("heartbeat-form-anchor");
const heartbeatFormCron = $("heartbeat-form-cron");
const heartbeatFormDays = $("heartbeat-form-days");
const heartbeatFormTimes = $("heartbeat-form-times");
const heartbeatFormTimesRows = $("heartbeat-form-times-rows");
const heartbeatFormAddTime = $("heartbeat-form-add-time");
const heartbeatFormSchedulePreview = $("heartbeat-form-schedule-preview");
const heartbeatFormTask = $("heartbeat-form-task");
const heartbeatFormVaultPaths = $("heartbeat-form-vault-paths");
const heartbeatFormEnabled = $("heartbeat-form-enabled");
const heartbeatFormPush = $("heartbeat-form-push");
const heartbeatFormStatus = $("heartbeat-form-status");
const heartbeatFormCancel = $("heartbeat-form-cancel");

const workflowStudioScrim = $("workflow-studio-scrim");
const workflowStudioList = $("workflow-studio-list");
const workflowStudioAdd = $("workflow-studio-add");
const workflowStudioClose = $("workflow-studio-close");

const workflowFormScrim = $("workflow-form-scrim");
const workflowForm = $("workflow-form");
const workflowFormTitle = $("workflow-form-title");
const workflowFormName = $("workflow-form-name");
const workflowFormDescription = $("workflow-form-description");
const workflowFormSteps = $("workflow-form-steps");
const workflowFormAddStep = $("workflow-form-add-step");
const workflowFormStatus = $("workflow-form-status");
const workflowFormCancel = $("workflow-form-cancel");

const auditScrim = $("audit-scrim");
const auditList = $("audit-list");
const auditClose = $("audit-close");
const auditDetailScrim = $("audit-detail-scrim");
const auditDetailTitle = $("audit-detail-title");
const auditDetailFields = $("audit-detail-fields");
const auditDetailDiff = $("audit-detail-diff");
const auditDetailClose = $("audit-detail-close");

const pausedBanner = $("paused-banner");
const pausedResume = $("paused-resume");
const mentionBar = $("mention-bar");
const replyForm = $("reply-form");
const replyInput = $("reply-text");
const plusButton = $("plus-button");
const micButton = $("mic-button");
const attachFileInput = $("attach-file-input");
const attachChipRow = $("attach-chip-row");
const attachMenu = $("attach-menu");
const attachMenuCamera = $("attach-menu-camera");
const attachMenuPhotos = $("attach-menu-photos");
const attachMenuFiles = $("attach-menu-files");

// --- State -----------------------------------------------------------------
// Since ADR 0008 (Main is a real conversation) there is no null special
// case: null just means "nothing selected yet" (fresh install / all
// archived) and renders a hint instead of a thread.
let currentConversationId = new URLSearchParams(location.search).get("conversation") || null;
let currentDetail = null;
let renderedKey = "";
let modelCatalogById = new Map();
let latestModels = [];
let defaultModelId = "";
let allConversations = [];
let allFolders = [];
// Which folders are collapsed, persisted so a folder Edvard closed on his
// phone stays closed across a reload — the switcher is the one list he
// opens every time, and re-collapsing 30 heartbeat conversations by hand
// on every visit would undo the point of having folders at all.
const collapsedFolders = new Set(readCollapsedFolders());
let allPersonas = [];
let sheetTargetId = null;
let editLinks = [];
let editingMessageId = null;
let lastRenderedMessages = [];
// The thread as accumulated so far, plus the server's fingerprint of it. The
// poll asks only for what arrived after `heldMessages`' last entry; the
// server decides whether that is still a safe thing to answer and says so.
// Held state is scoped to one conversation, so switching threads drops it.
let heldMessages = [];
let heldRev = "";
let heldConversationId = null;
// Which narration drawers the reader has opened, keyed by the group's anchor
// (see groupNarration). Survives the 3s re-render; deliberately not
// persisted across reloads — "hidden by default" is the whole point.
const expandedNarrationGroups = new Set();
// Highest step count ever seen for a narration group, by anchor. Only
// consulted for a group the server truncated, where the window's own length
// is a lower bound that jitters rather than a fact (issues.md #48).
const narrationStepHighWater = new Map();
let messageActionTarget = null;
let personaFormEditId = null;
let heartbeatFormEditId = null;
let allWorkflows = [];
let workflowFormEditId = null;
let workflowFormStepsState = [];

// --- Theme -----------------------------------------------------------------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("agora-theme", theme);
}
applyTheme(localStorage.getItem("agora-theme") || "dark");
themeToggle.addEventListener("click", () => {
  applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
});

// --- Unread badge ----------------------------------------------------------
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
  // This is the one that matters for a PWA you background rather than close:
  // the timers may have been throttled or stopped for hours.
  refreshConversationList();
  fetchMessages();
});

// --- Minimal, safe markdown -------------------------------------------------
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// \0-delimited placeholder — can never collide with real prose the way a
// bare number token could (a bug an earlier version actually had).
const CODE_BLOCK_PLACEHOLDER = (i) => `\0CODEBLOCK${i}\0`;
const CODE_BLOCK_PLACEHOLDER_RE = /\0CODEBLOCK(\d+)\0/g;

function renderInline(text) {
  return text
    .replace(/`([^`\n]+?)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "<em>$1</em>")
    .replace(/\[([^\]\n]+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

// LLM replies routinely use headers and lists (we produce exactly this
// style ourselves -- "1. ... 2. ..." / "- ... - ..." summaries) -- the old
// renderer had no block-level structure at all beyond paragraphs, so these
// rendered as raw literal "#"/"-"/"1." text (Issues.md: "does not display
// markdown correctly").
function renderBlock(block) {
  const lines = block.split("\n");
  const headerMatch = lines.length === 1 && lines[0].match(/^(#{1,6})\s+(.*)$/);
  if (headerMatch) {
    const level = headerMatch[1].length;
    return `<h${level}>${renderInline(headerMatch[2])}</h${level}>`;
  }
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length > 0 && nonEmpty.every((l) => /^[-*+]\s+/.test(l.trim()))) {
    const items = nonEmpty.map((l) => `<li>${renderInline(l.trim().replace(/^[-*+]\s+/, ""))}</li>`).join("");
    return `<ul>${items}</ul>`;
  }
  if (nonEmpty.length > 0 && nonEmpty.every((l) => /^\d+\.\s+/.test(l.trim()))) {
    const items = nonEmpty.map((l) => `<li>${renderInline(l.trim().replace(/^\d+\.\s+/, ""))}</li>`).join("");
    return `<ol>${items}</ol>`;
  }
  return `<p>${renderInline(block).replace(/\n/g, "<br>")}</p>`;
}

function renderMarkdown(text) {
  const escaped = escapeHtml(text);
  const codeBlocks = [];
  const withPlaceholders = escaped.replace(/```([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(`<pre><code>${code}</code></pre>`);
    return CODE_BLOCK_PLACEHOLDER(codeBlocks.length - 1);
  });
  // Code blocks restored LAST so their real newlines survive the <br> pass.
  const blocks = withPlaceholders.split(/\n{2,}/).map(renderBlock).join("");
  return blocks.replace(CODE_BLOCK_PLACEHOLDER_RE, (_m, i) => codeBlocks[Number(i)]) || "<p></p>";
}

function setStatus(text, ms = 2500) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("visible", Boolean(text));
  if (text && ms) setTimeout(() => statusEl.classList.remove("visible"), ms);
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// --- API helpers ------------------------------------------------------------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    // non-JSON error body — leave data empty
  }
  return { ok: res.ok, status: res.status, data };
}

// --- Data loading -----------------------------------------------------------
async function loadConversationList() {
  await loadFolders();
  const { ok, data } = await api("GET", "/conversations");
  if (!ok) return;
  allConversations = data.conversations;
  renderDrawerList();
}

async function loadFolders() {
  const { ok, data } = await api("GET", "/folders");
  if (!ok) return;
  allFolders = data.folders || [];
}

function readCollapsedFolders() {
  try {
    const raw = localStorage.getItem("agora-collapsed-folders");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCollapsedFolders() {
  try {
    localStorage.setItem("agora-collapsed-folders", JSON.stringify([...collapsedFolders]));
  } catch {
    // Private-mode / quota — the folds just stop persisting, which is the
    // behaviour before this existed. Never worth failing a render over.
  }
}

// What the drawer actually draws from. Anything not in here can change on the
// server without the sidebar looking any different, so it must not force a
// rebuild — the drawer is rebuilt with innerHTML and a rebuild drops focus and
// scroll position.
function conversationListSignature(conversations) {
  return (conversations || [])
    .map((c) => [c.id, c.rootId, c.name, c.archived ? 1 : 0, c.status, c.lastMessageAt, c.createdAt, c.folderId || ""].join("\u0000"))
    .join("\u0001");
}

// Poll variant of loadConversationList: a conversation created on the server
// (every cycle creates one) could otherwise never appear until a reload.
async function refreshConversationList() {
  const { ok, data } = await api("GET", "/conversations");
  if (!ok) return false;
  const next = data.conversations || [];
  if (conversationListSignature(next) === conversationListSignature(allConversations)) return false;
  // The conversation list moved, so re-read the folders before drawing it:
  // a folder created, renamed or deleted from another tab is invisible to
  // this list's own signature, and a stale name or an orphaned header would
  // otherwise sit there until the page was reloaded.
  await loadFolders();
  allConversations = next;
  renderDrawerList();
  return true;
}

async function loadPersonas() {
  const { ok, data } = await api("GET", "/personas");
  if (!ok) return;
  allPersonas = data.personas;
}

async function loadWorkflows() {
  const { ok, data } = await api("GET", "/workflows");
  if (!ok) return;
  allWorkflows = data.workflows;
}

async function loadModelCatalog() {
  const { ok, data } = await api("GET", "/models");
  if (!ok) return;
  latestModels = data.models;
  defaultModelId = data.defaultModel || "";
  modelCatalogById = new Map(data.models.map((m) => [m.id, m]));
  for (const select of [newChatModel, editModel, personaFormModel]) populateModelSelect(select);
  updateThinkingVisibility(newChatModel, newChatThinkingRow, newChatThinking, newChatBadge);
  updateThinkingVisibility(editModel, editThinkingRow, editThinking, editBadge);
  updateThinkingVisibility(personaFormModel, personaFormThinkingRow, personaFormThinking, personaFormBadge);
  updateClaudeCliRestrictedVisibility(personaFormModel, personaFormClaudeCliRestrictedRow, personaFormClaudeCliRestricted);
  updateClaudeCliStatelessVisibility(personaFormModel, personaFormClaudeCliStatelessRow, personaFormClaudeCliStateless);
}

// A two-way ternary written before claude-cli existed (2026-08-01) filed
// every claude-cli model under the heading "Gemini" — so the five free
// subscription Claude models were hidden under the wrong provider while the
// five that spend the prepaid balance sat under "Anthropic" with the clean
// names. Named per provider now, and the metered ones say so (2026-08-10,
// Edvard's hard rule in issues.md).
const PROVIDER_GROUP_LABELS = {
  anthropic: "Anthropic API (metered — costs money)",
  gemini: "Gemini",
  "claude-cli": "Claude (subscription)",
};

// A <select> with no value set displays its FIRST option, and the catalog's
// first entry is a metered Anthropic model — so opening New Chat and tapping
// Create without touching the dropdown silently billed the prepaid balance.
// Array position is not a default: fall back to the server's own
// DEFAULT_MODEL, which /models now reports alongside the catalog so the two
// cannot drift. `known` is passed in rather than read from module state so
// this stays a pure decision.
function chosenModelValue(previous, defaultId, known) {
  if (previous && known.has(previous)) return previous;
  if (defaultId && known.has(defaultId)) return defaultId;
  return "";
}

function modelGroupLabel(provider) {
  return PROVIDER_GROUP_LABELS[provider] || provider;
}

// Marked per option too, not just per group: a <select> collapsed to its
// chosen value shows the option text alone, so the group heading is
// invisible exactly when you most want to know what you picked.
function modelOptionLabel(model) {
  return model.metered ? `${model.label} — metered` : model.label;
}

function populateModelSelect(select) {
  const previous = select.value;
  select.innerHTML = "";
  const groups = new Map();
  for (const model of latestModels) {
    if (!groups.has(model.provider)) {
      const group = document.createElement("optgroup");
      group.label = modelGroupLabel(model.provider);
      groups.set(model.provider, group);
      select.appendChild(group);
    }
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = modelOptionLabel(model);
    groups.get(model.provider).appendChild(option);
  }
  const chosen = chosenModelValue(previous, defaultModelId, modelCatalogById);
  if (chosen) select.value = chosen;
}

function capabilityBadgeText(model) {
  if (!model) return "";
  const parts = [];
  if (model.contextWindow) parts.push(model.contextWindow);
  parts.push(model.supportsThinking ? "thinking-capable" : "no thinking");
  return parts.join(" · ");
}

function updateThinkingVisibility(select, row, checkbox, badgeEl) {
  const model = modelCatalogById.get(select.value);
  const supportsThinking = Boolean(model && model.supportsThinking);
  row.hidden = !supportsThinking;
  if (!supportsThinking) checkbox.checked = false;
  if (badgeEl) badgeEl.textContent = capabilityBadgeText(model);
}
// Sticky Gemini fallback only means anything for a Gemini model -- hide (and
// force off) whenever an Anthropic model is selected, same pattern as the
// Thinking checkbox above.
function updateStickyFallbackVisibility(select, row, checkbox) {
  const model = modelCatalogById.get(select.value);
  const isGemini = Boolean(model && model.provider === "gemini");
  row.hidden = !isGemini;
  if (!isGemini) checkbox.checked = false;
}
// claudeCliRestricted only means anything for a claude-cli persona -- same
// hide-and-force-off pattern. Persona-level only (not per-conversation
// model overrides), since it lives on the Persona record itself.
function updateClaudeCliRestrictedVisibility(select, row, checkbox) {
  const model = modelCatalogById.get(select.value);
  const isClaudeCli = Boolean(model && model.provider === "claude-cli");
  row.hidden = !isClaudeCli;
  if (!isClaudeCli) checkbox.checked = false;
}
// claudeCliStateless, same hide-and-force-off pattern as claudeCliRestricted above.
function updateClaudeCliStatelessVisibility(select, row, checkbox) {
  const model = modelCatalogById.get(select.value);
  const isClaudeCli = Boolean(model && model.provider === "claude-cli");
  row.hidden = !isClaudeCli;
  if (!isClaudeCli) checkbox.checked = false;
}
newChatModel.addEventListener("change", () => updateThinkingVisibility(newChatModel, newChatThinkingRow, newChatThinking, newChatBadge));
editModel.addEventListener("change", () => {
  updateThinkingVisibility(editModel, editThinkingRow, editThinking, editBadge);
  updateStickyFallbackVisibility(editModel, editStickyFallbackRow, editStickyFallback);
});
personaFormModel.addEventListener("change", () => {
  updateThinkingVisibility(personaFormModel, personaFormThinkingRow, personaFormThinking, personaFormBadge);
  updateClaudeCliRestrictedVisibility(personaFormModel, personaFormClaudeCliRestrictedRow, personaFormClaudeCliRestricted);
  updateClaudeCliStatelessVisibility(personaFormModel, personaFormClaudeCliStatelessRow, personaFormClaudeCliStateless);
});

// --- Drawer ------------------------------------------------------------------
function openDrawer() {
  drawer.hidden = false;
  drawerScrim.hidden = false;
  loadConversationList();
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

function renderDrawerRow(conversation, forked, inFolder) {
  const row = document.createElement("div");
  row.className =
    `drawer-row ${conversation.id === currentConversationId ? "active" : ""} ${forked ? "forked" : ""} ${inFolder ? "in-folder" : ""}`;
  const nameEl = document.createElement("span");
  nameEl.className = "drawer-row-name";
  nameEl.textContent = (forked ? "↳ " : "") + conversation.name + (conversation.archived ? " · Archived" : "");
  row.appendChild(nameEl);
  if (conversation.status === "paused") {
    const badge = document.createElement("span");
    badge.className = "drawer-row-badge";
    badge.textContent = "⏸";
    row.appendChild(badge);
  }
  const more = document.createElement("button");
  more.type = "button";
  more.className = "drawer-row-more";
  more.textContent = "⋮";
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    openActionSheet(conversation.id, conversation.name);
  });
  row.appendChild(more);
  row.addEventListener("click", () => switchConversation(conversation.id));
  return row;
}

// Lineage grouping (rootId, Decisions/0004): root first, its forks indented
// under it; groups ordered by their most recent activity. Folders sit above
// this, not instead of it — a fork stays under its root wherever it is filed.
function appendLineageGroups(target, conversations, inFolder) {
  const groups = new Map();
  for (const conversation of conversations) {
    const key = conversation.rootId || conversation.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(conversation);
  }
  const ordered = [...groups.values()].sort((a, b) => {
    const latest = (g) => Math.max(...g.map((c) => Date.parse(c.lastMessageAt || c.createdAt || 0)));
    return latest(b) - latest(a);
  });
  for (const group of ordered) {
    group.sort((a, b) => {
      if (a.id === (a.rootId || a.id) && a.rootId === a.id) return -1;
      return Date.parse(b.lastMessageAt || 0) - Date.parse(a.lastMessageAt || 0);
    });
    const root = group.find((c) => c.id === c.rootId);
    if (root) target.appendChild(renderDrawerRow(root, false, inFolder));
    for (const conversation of group) {
      if (root && conversation.id === root.id) continue;
      target.appendChild(renderDrawerRow(conversation, Boolean(root), inFolder));
    }
  }
}

function renderFolderHeader(folder, count) {
  const collapsed = collapsedFolders.has(folder.id);
  const header = document.createElement("div");
  header.className = "drawer-folder";
  const twisty = document.createElement("span");
  twisty.className = "drawer-folder-twisty";
  twisty.textContent = collapsed ? "▸" : "▾";
  header.appendChild(twisty);
  const nameEl = document.createElement("span");
  nameEl.className = "drawer-folder-name";
  nameEl.textContent = folder.name;
  header.appendChild(nameEl);
  const countEl = document.createElement("span");
  countEl.className = "drawer-folder-count";
  countEl.textContent = String(count);
  header.appendChild(countEl);
  const more = document.createElement("button");
  more.type = "button";
  more.className = "drawer-row-more";
  more.textContent = "⋮";
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    openFolderMenu(folder);
  });
  header.appendChild(more);
  header.addEventListener("click", () => {
    if (collapsed) collapsedFolders.delete(folder.id);
    else collapsedFolders.add(folder.id);
    saveCollapsedFolders();
    renderDrawerList();
  });
  return header;
}

function renderDrawerList() {
  drawerList.innerHTML = "";
  const visible = allConversations.filter((c) => !c.archived);
  const known = new Set(allFolders.map((f) => f.id));
  // A conversation whose folder is gone shows at the top level rather than
  // disappearing — losing a folder must never lose a conversation.
  const byFolder = new Map();
  const topLevel = [];
  for (const conversation of visible) {
    if (conversation.folderId && known.has(conversation.folderId)) {
      if (!byFolder.has(conversation.folderId)) byFolder.set(conversation.folderId, []);
      byFolder.get(conversation.folderId).push(conversation);
    } else {
      topLevel.push(conversation);
    }
  }
  // Folders first, alphabetically (the server already sorts them), then
  // everything unfiled — so the fixed part of the list stays put while the
  // activity-ordered part moves around underneath it.
  for (const folder of allFolders) {
    const members = byFolder.get(folder.id) || [];
    drawerList.appendChild(renderFolderHeader(folder, members.length));
    if (!collapsedFolders.has(folder.id)) appendLineageGroups(drawerList, members, true);
  }
  appendLineageGroups(drawerList, topLevel, false);
  if (!drawerList.children.length) {
    const hint = document.createElement("div");
    hint.className = "studio-empty";
    hint.textContent = "No conversations yet — create one!";
    drawerList.appendChild(hint);
  }
}

async function switchConversation(id) {
  currentConversationId = id;
  currentDetail = null;
  editingMessageId = null;
  renderedKey = "";
  closeDrawer();
  await fetchMessages();
  renderDrawerList();
}

// --- Drawer search -----------------------------------------------------------
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
  // Name matches include archived conversations — search is the only way
  // back to one, excluding them would make archiving a one-way trip.
  const nameMatches = allConversations.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  if (nameMatches.length > 0) {
    const label = document.createElement("div");
    label.className = "drawer-section-label";
    label.textContent = "Conversations";
    drawerSearchResults.appendChild(label);
    for (const match of nameMatches) drawerSearchResults.appendChild(renderDrawerRow(match, false));
  }
  const { ok, data } = await api("GET", `/search?q=${encodeURIComponent(q)}`);
  if (!ok || !data.results.length) return;
  const label = document.createElement("div");
  label.className = "drawer-section-label";
  label.textContent = "Messages";
  drawerSearchResults.appendChild(label);
  for (const result of data.results.slice(0, 30)) {
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
}

// --- Conversation action sheet ------------------------------------------------
function openActionSheet(id, name) {
  sheetTargetId = id;
  actionSheetTitle.textContent = name;
  const conversation = allConversations.find((c) => c.id === id);
  sheetArchiveLabel.textContent = conversation?.archived ? "Unarchive" : "Archive";
  sheetPauseLabel.textContent = conversation?.status === "paused" ? "Resume replies" : "Pause replies";
  actionSheetScrim.hidden = false;
}
function closeActionSheet() {
  actionSheetScrim.hidden = true;
}
actionSheetScrim.addEventListener("click", (e) => {
  if (e.target === actionSheetScrim) closeActionSheet();
});
headerOverflowBtn.addEventListener("click", () => {
  if (!currentConversationId) return;
  openActionSheet(currentConversationId, currentDetail?.name || "Conversation");
});

sheetPause.addEventListener("click", async () => {
  const id = sheetTargetId;
  closeActionSheet();
  const conversation = allConversations.find((c) => c.id === id);
  const status = conversation?.status === "paused" ? "active" : "paused";
  await api("PATCH", `/conversations/${id}`, { status });
  await loadConversationList();
  if (id === currentConversationId) {
    renderedKey = "";
    await fetchMessages();
  }
});

sheetArchive.addEventListener("click", async () => {
  const id = sheetTargetId;
  closeActionSheet();
  const conversation = allConversations.find((c) => c.id === id);
  await api("PATCH", `/conversations/${id}`, { archived: !conversation?.archived });
  if (!conversation?.archived && id === currentConversationId) {
    currentConversationId = null;
    currentDetail = null;
    renderedKey = "";
  }
  await loadConversationList();
  autoSelectConversation();
  fetchMessages();
});

sheetDelete.addEventListener("click", async () => {
  const id = sheetTargetId;
  closeActionSheet();
  if (!confirm("Delete this conversation? This can't be undone.")) return;
  const { ok, status, data } = await api("DELETE", `/conversations/${id}`);
  if (!ok && status === 409) {
    setStatus(`Has heartbeats (${(data.heartbeats || []).join(", ")}) — delete those first.`, 5000);
    return;
  }
  if (id === currentConversationId) {
    currentConversationId = null;
    currentDetail = null;
    renderedKey = "";
  }
  await loadConversationList();
  autoSelectConversation();
  fetchMessages();
});

// --- Folders (ideas.md #5) ----------------------------------------------------
function closeFolderSheet() {
  folderSheetScrim.hidden = true;
}
folderSheetScrim.addEventListener("click", (e) => {
  if (e.target === folderSheetScrim) closeFolderSheet();
});

function folderSheetRow(label, onClick, danger) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `sheet-row ${danger ? "danger" : ""}`;
  row.textContent = label;
  row.addEventListener("click", onClick);
  return row;
}

async function createFolder() {
  const name = prompt("Folder name");
  if (!name || !name.trim()) return null;
  const { ok, data } = await api("POST", "/folders", { name: name.trim() });
  if (!ok) {
    setStatus("Could not create that folder.", 4000);
    return null;
  }
  await loadFolders();
  renderDrawerList();
  return data.folder;
}

drawerNewFolder.addEventListener("click", () => {
  createFolder();
});

/** Move picker for one conversation: every folder, plus the top level, plus
 * a way to make a folder without leaving the sheet. */
function openMoveSheet(conversationId) {
  const conversation = allConversations.find((c) => c.id === conversationId);
  folderSheetTitle.textContent = `Move “${conversation?.name || "conversation"}” to`;
  folderSheetList.innerHTML = "";
  const move = async (folderId) => {
    closeFolderSheet();
    const { ok } = await api("PATCH", `/conversations/${conversationId}`, { folderId });
    if (!ok) {
      setStatus("Could not move that conversation.", 4000);
      return;
    }
    await loadConversationList();
  };
  if (conversation?.folderId) {
    folderSheetList.appendChild(folderSheetRow("↑ Top level", () => move(null)));
  }
  for (const folder of allFolders) {
    if (folder.id === conversation?.folderId) continue;
    folderSheetList.appendChild(folderSheetRow(folder.name, () => move(folder.id)));
  }
  folderSheetList.appendChild(
    folderSheetRow("＋ New folder…", async () => {
      const folder = await createFolder();
      if (folder) await move(folder.id);
      else closeFolderSheet();
    }),
  );
  folderSheetScrim.hidden = false;
}

function openFolderMenu(folder) {
  folderSheetTitle.textContent = folder.name;
  folderSheetList.innerHTML = "";
  folderSheetList.appendChild(
    folderSheetRow("Rename folder", async () => {
      closeFolderSheet();
      const name = prompt("Folder name", folder.name);
      if (!name || !name.trim()) return;
      const { ok } = await api("PATCH", `/folders/${folder.id}`, { name: name.trim() });
      if (!ok) {
        setStatus("Could not rename that folder.", 4000);
        return;
      }
      await loadConversationList();
    }),
  );
  folderSheetList.appendChild(
    folderSheetRow(
      "Delete folder",
      async () => {
        closeFolderSheet();
        if (!confirm("Delete this folder? The conversations in it move back to the top level.")) return;
        const { ok } = await api("DELETE", `/folders/${folder.id}`);
        if (!ok) {
          setStatus("Could not delete that folder.", 4000);
          return;
        }
        collapsedFolders.delete(folder.id);
        saveCollapsedFolders();
        await loadConversationList();
      },
      true,
    ),
  );
  folderSheetScrim.hidden = false;
}

sheetMove.addEventListener("click", () => {
  const id = sheetTargetId;
  closeActionSheet();
  openMoveSheet(id);
});

sheetAsk.addEventListener("click", () => {
  const id = sheetTargetId;
  closeActionSheet();
  if (id !== currentConversationId) switchConversation(id);
  askText.value = "";
  askAnswer.hidden = true;
  askStatus.textContent = "";
  askModalScrim.hidden = false;
  askText.focus();
});

// --- Ask modal ---------------------------------------------------------------
askModalScrim.addEventListener("click", (e) => {
  if (e.target === askModalScrim) askModalScrim.hidden = true;
});
askCancel.addEventListener("click", () => {
  askModalScrim.hidden = true;
});
askModal.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = askText.value.trim();
  if (!text || !currentConversationId) return;
  askStatus.textContent = "Thinking… (this can take a while)";
  askAnswer.hidden = true;
  const { ok, status, data } = await api("POST", `/conversations/${currentConversationId}/ask`, { text });
  if (!ok) {
    askStatus.textContent = status === 503 ? "Runner not configured." : "Failed — try again.";
    return;
  }
  askStatus.textContent = "";
  askAnswer.textContent = data.reply;
  askAnswer.hidden = false;
});

// --- Edit conversation modal ---------------------------------------------------
function renderEditParticipants() {
  editParticipants.innerHTML = "";
  for (const link of editLinks) {
    const row = document.createElement("div");
    row.className = "participant-row";
    const name = document.createElement("span");
    name.className = "p-name";
    name.textContent = link.name;
    const role = document.createElement("span");
    role.className = "p-role";
    role.textContent = link.role;
    row.append(name, role);
    if (link.role !== "curator") {
      const promote = document.createElement("button");
      promote.type = "button";
      promote.textContent = "Make curator";
      promote.title = "Handoff — this persona becomes the default responder";
      promote.addEventListener("click", () => {
        for (const l of editLinks) l.role = l === link ? "curator" : "listener";
        renderEditParticipants();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        editLinks = editLinks.filter((l) => l !== link);
        renderEditParticipants();
      });
      row.append(promote, remove);
    }
    editParticipants.appendChild(row);
  }
  editAddPersona.innerHTML = "";
  const inUse = new Set(editLinks.map((l) => l.personaId));
  for (const persona of allPersonas) {
    if (persona.isTemplate || inUse.has(persona.id)) continue;
    const option = document.createElement("option");
    option.value = persona.id;
    option.textContent = persona.name;
    editAddPersona.appendChild(option);
  }
  editAddPersonaBtn.disabled = !editAddPersona.children.length;
}

editAddPersonaBtn.addEventListener("click", () => {
  const personaId = editAddPersona.value;
  const persona = allPersonas.find((p) => p.id === personaId);
  if (!persona) return;
  editLinks.push({ personaId, role: editLinks.length ? "listener" : "curator", name: persona.name });
  renderEditParticipants();
});

sheetEdit.addEventListener("click", async () => {
  const id = sheetTargetId;
  closeActionSheet();
  await loadPersonas();
  const { ok, data } = await api("GET", `/conversations/${id}/messages?limit=1`);
  if (!ok) return;
  editModal.dataset.targetId = id;
  editName.value = data.name;
  editPersonality.value = data.personality || "";
  editModel.value = data.model;
  editThinking.checked = Boolean(data.thinking);
  editStickyFallback.checked = Boolean(data.stickyFallback);
  editMemory.value = data.memory || "";
  editLinks = (data.personas || []).map((p) => ({ ...p }));
  renderEditParticipants();
  updateThinkingVisibility(editModel, editThinkingRow, editThinking, editBadge);
  updateStickyFallbackVisibility(editModel, editStickyFallbackRow, editStickyFallback);
  editStatus.textContent = "";
  editModalScrim.hidden = false;
});

editModalScrim.addEventListener("click", (e) => {
  if (e.target === editModalScrim) editModalScrim.hidden = true;
});
editCancel.addEventListener("click", () => {
  editModalScrim.hidden = true;
});
editOpenPersonaEditorBtn.addEventListener("click", () => {
  const curator = editLinks.find((l) => l.role === "curator");
  const persona = curator ? allPersonas.find((p) => p.id === curator.personaId) : null;
  if (!persona) {
    editStatus.textContent = "Curator persona not found.";
    return;
  }
  editModalScrim.hidden = true;
  openPersonaForm(persona);
});
editModal.addEventListener("submit", async (event) => {
  event.preventDefault();
  const targetId = editModal.dataset.targetId;
  if (!targetId) return;
  // Shared-entity warning (Architecture §4a): personality/model edits go to
  // the curator persona, which may serve several conversations.
  const curator = editLinks.find((l) => l.role === "curator");
  if (curator) {
    const usedBy = allConversations.filter((c) =>
      (c.personas || []).some((p) => p.personaId === curator.personaId),
    );
    if (usedBy.length > 1) {
      const names = usedBy.map((c) => c.name).join(", ");
      if (!confirm(`"${curator.name}" is used by ${usedBy.length} conversations (${names}). Personality/model edits apply to all of them. Continue?`)) {
        return;
      }
    }
  }
  editStatus.textContent = "Saving...";
  const { ok, data } = await api("PATCH", `/conversations/${targetId}`, {
    name: editName.value.trim(),
    personality: editPersonality.value,
    model: editModel.value,
    thinking: editThinkingRow.hidden ? false : editThinking.checked,
    stickyFallback: editStickyFallback.checked,
    memory: editMemory.value,
    personas: editLinks.map(({ personaId, role }) => ({ personaId, role })),
  });
  if (!ok) {
    editStatus.textContent = data.error || "Failed to save.";
    return;
  }
  editModalScrim.hidden = true;
  await loadConversationList();
  renderedKey = "";
  fetchMessages();
});

// --- New conversation ----------------------------------------------------------
function renderNewChatPersonaSource() {
  newChatPersonaSource.innerHTML = "";
  const fresh = document.createElement("option");
  fresh.value = "";
  fresh.textContent = "New persona (define below)";
  newChatPersonaSource.appendChild(fresh);
  for (const persona of allPersonas) {
    if (persona.isTemplate) continue;
    const option = document.createElement("option");
    option.value = persona.id;
    option.textContent = `Existing: ${persona.name}`;
    newChatPersonaSource.appendChild(option);
  }
  newChatInlineFields.style.display = "flex";
}
newChatPersonaSource.addEventListener("change", () => {
  newChatInlineFields.style.display = newChatPersonaSource.value ? "none" : "flex";
});

function renderTemplateChips(container, applyTemplate) {
  container.innerHTML = "";
  for (const template of allPersonas.filter((p) => p.isTemplate)) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "template-chip";
    chip.textContent = template.name;
    chip.addEventListener("click", () => applyTemplate(template));
    container.appendChild(chip);
  }
}

async function openNewChatModal() {
  closeDrawer();
  await loadPersonas();
  renderNewChatPersonaSource();
  renderTemplateChips(newChatTemplateRow, (template) => {
    newChatPersonality.value = template.personality;
    newChatModel.value = template.model;
    updateThinkingVisibility(newChatModel, newChatThinkingRow, newChatThinking, newChatBadge);
  });
  newChatName.value = "";
  newChatPersonality.value = "";
  newChatThinking.checked = false;
  // Same defaults as a brand-new persona in the Persona Studio.
  newChatCapWebSearch.checked = true;
  newChatCapVaultRead.checked = true;
  newChatCapVaultWrite.checked = false;
  newChatCapCodeExecution.checked = false;
  newChatCapKubectlRead.checked = false;
  newChatCapGithubRead.checked = false;
  newChatStatus.textContent = "";
  newChatModalScrim.hidden = false;
  newChatName.focus();
}
drawerNewChat.addEventListener("click", openNewChatModal);
headerNewChatBtn.addEventListener("click", openNewChatModal);
newChatModalScrim.addEventListener("click", (e) => {
  if (e.target === newChatModalScrim) newChatModalScrim.hidden = true;
});
newChatCancel.addEventListener("click", () => {
  newChatModalScrim.hidden = true;
});
newChatModal.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = newChatName.value.trim();
  if (!name) return;
  newChatStatus.textContent = "Creating...";
  const body = newChatPersonaSource.value
    ? { name, personaId: newChatPersonaSource.value }
    : {
        name,
        personality: newChatPersonality.value.trim(),
        model: newChatModel.value,
        thinking: newChatThinkingRow.hidden ? false : newChatThinking.checked,
        capabilities: {
          webSearch: newChatCapWebSearch.checked,
          vaultRead: newChatCapVaultRead.checked,
          vaultWrite: newChatCapVaultWrite.checked,
          codeExecution: newChatCapCodeExecution.checked,
          kubectlRead: newChatCapKubectlRead.checked,
          githubRead: newChatCapGithubRead.checked,
          manageAgora: newChatCapManageAgora.checked,
          githubWrite: newChatCapGithubWrite.checked,
          githubMerge: newChatCapGithubMerge.checked,
          terminalExec: newChatCapTerminalExec.checked,
        },
      };
  const { ok, data } = await api("POST", "/conversations", body);
  if (!ok) {
    newChatStatus.textContent = data.error || "Failed to create.";
    return;
  }
  newChatModalScrim.hidden = true;
  await loadConversationList();
  await switchConversation(data.conversation.id);
});

// --- Persona Creator Studio ------------------------------------------------
function personaMeta(persona) {
  const model = modelCatalogById.get(persona.model);
  const caps = persona.capabilities || {};
  const enabled = [
    "webSearch", "vaultRead", "vaultWrite", "codeExecution", "kubectlRead", "githubRead",
    "manageAgora", "githubWrite", "githubMerge", "terminalExec",
  ]
    .filter((c) => caps[c])
    .map((c) => ({
      webSearch: "web", vaultRead: "vault", vaultWrite: "vault✎", codeExecution: "code",
      kubectlRead: "k8s", githubRead: "gh", manageAgora: "manage",
      githubWrite: "pr", githubMerge: "merge", terminalExec: "shell",
    }[c]));
  return `${model ? model.label : persona.model}${enabled.length ? " · " + enabled.join(", ") : ""}`;
}

async function openPersonaStudio() {
  closeDrawer();
  await Promise.all([loadPersonas(), loadConversationList()]);
  renderPersonaStudio();
  personaStudioScrim.hidden = false;
}
navPersonas.addEventListener("click", openPersonaStudio);
personaStudioClose.addEventListener("click", () => {
  personaStudioScrim.hidden = true;
});
personaStudioScrim.addEventListener("click", (e) => {
  if (e.target === personaStudioScrim) personaStudioScrim.hidden = true;
});

function renderPersonaStudio() {
  personaStudioList.innerHTML = "";
  const sections = [
    ["Your personas", allPersonas.filter((p) => !p.isTemplate)],
    ["Templates", allPersonas.filter((p) => p.isTemplate)],
  ];
  for (const [label, list] of sections) {
    if (!list.length) continue;
    const header = document.createElement("div");
    header.className = "drawer-section-label";
    header.textContent = label;
    personaStudioList.appendChild(header);
    for (const persona of list) {
      personaStudioList.appendChild(renderPersonaRow(persona));
    }
  }
  if (!allPersonas.length) {
    const empty = document.createElement("div");
    empty.className = "studio-empty";
    empty.textContent = "No personas yet.";
    personaStudioList.appendChild(empty);
  }
}

function renderPersonaRow(persona) {
  const row = document.createElement("div");
  row.className = "studio-item";
  const main = document.createElement("div");
  main.className = "studio-item-main";
  const name = document.createElement("span");
  name.className = "studio-item-name";
  name.textContent = persona.name;
  const meta = document.createElement("span");
  meta.className = "studio-item-meta";
  meta.textContent = personaMeta(persona);
  main.append(name, meta);
  row.appendChild(main);

  const actions = document.createElement("div");
  actions.className = "studio-item-actions";
  const clone = document.createElement("button");
  clone.type = "button";
  clone.textContent = "Clone";
  clone.addEventListener("click", async (e) => {
    e.stopPropagation();
    await api("POST", `/personas/${persona.id}/clone`, {});
    await loadPersonas();
    renderPersonaStudio();
  });
  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "Delete";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete persona "${persona.name}"?`)) return;
    const { ok, status, data } = await api("DELETE", `/personas/${persona.id}`);
    if (!ok && status === 409) {
      const refs = [...(data.conversations || []), ...(data.heartbeats || [])].join(", ");
      setStatus(`In use by: ${refs}. Detach it first.`, 5000);
      return;
    }
    await loadPersonas();
    renderPersonaStudio();
  });
  actions.append(clone, del);
  row.appendChild(actions);
  row.addEventListener("click", () => openPersonaForm(persona));
  return row;
}

personaStudioAdd.addEventListener("click", () => openPersonaForm(null));

function openPersonaForm(persona) {
  personaFormEditId = persona ? persona.id : null;
  personaFormTitle.textContent = persona ? `Edit ${persona.name}` : "New persona";
  personaFormName.value = persona?.name || "";
  personaFormPersonality.value = persona?.personality || "";
  if (persona?.model && modelCatalogById.has(persona.model)) personaFormModel.value = persona.model;
  personaFormThinking.checked = Boolean(persona?.thinking);
  personaFormClaudeCliRestricted.checked = Boolean(persona?.claudeCliRestricted);
  personaFormClaudeCliStateless.checked = Boolean(persona?.claudeCliStateless);
  const caps = persona?.capabilities || {
    webSearch: true, vaultRead: true, vaultWrite: false, codeExecution: false,
    kubectlRead: false, githubRead: false, manageAgora: false, githubWrite: false, githubMerge: false,
    terminalExec: false,
  };
  capWebSearch.checked = Boolean(caps.webSearch);
  capVaultRead.checked = Boolean(caps.vaultRead);
  capVaultWrite.checked = Boolean(caps.vaultWrite);
  capCodeExecution.checked = Boolean(caps.codeExecution);
  capKubectlRead.checked = Boolean(caps.kubectlRead);
  capGithubRead.checked = Boolean(caps.githubRead);
  capManageAgora.checked = Boolean(caps.manageAgora);
  capGithubWrite.checked = Boolean(caps.githubWrite);
  capGithubMerge.checked = Boolean(caps.githubMerge);
  capTerminalExec.checked = Boolean(caps.terminalExec);
  personaFormMemory.value = persona?.sharedMemory || "";
  personaFormTemplate.checked = Boolean(persona?.isTemplate);
  personaFormPreviewText.value = "";
  personaFormPreviewOut.hidden = true;
  personaFormStatus.textContent = "";
  renderTemplateChips(personaFormTemplateRow, (template) => {
    personaFormPersonality.value = template.personality;
    personaFormModel.value = template.model;
    updateThinkingVisibility(personaFormModel, personaFormThinkingRow, personaFormThinking, personaFormBadge);
    updateClaudeCliRestrictedVisibility(personaFormModel, personaFormClaudeCliRestrictedRow, personaFormClaudeCliRestricted);
    updateClaudeCliStatelessVisibility(personaFormModel, personaFormClaudeCliStatelessRow, personaFormClaudeCliStateless);
  });
  updateThinkingVisibility(personaFormModel, personaFormThinkingRow, personaFormThinking, personaFormBadge);
  updateClaudeCliRestrictedVisibility(personaFormModel, personaFormClaudeCliRestrictedRow, personaFormClaudeCliRestricted);
  updateClaudeCliStatelessVisibility(personaFormModel, personaFormClaudeCliStatelessRow, personaFormClaudeCliStateless);
  personaFormScrim.hidden = false;
}

personaFormScrim.addEventListener("click", (e) => {
  if (e.target === personaFormScrim) personaFormScrim.hidden = true;
});
personaFormCancel.addEventListener("click", () => {
  personaFormScrim.hidden = true;
});

personaFormPreviewBtn.addEventListener("click", async () => {
  const text = personaFormPreviewText.value.trim();
  if (!text) return;
  personaFormStatus.textContent = "Previewing… (nothing is saved)";
  personaFormPreviewOut.hidden = true;
  const { ok, status, data } = await api("POST", "/personas/preview", {
    personality: personaFormPersonality.value,
    model: personaFormModel.value,
    thinking: personaFormThinkingRow.hidden ? false : personaFormThinking.checked,
    claudeCliRestricted: personaFormClaudeCliRestrictedRow.hidden ? false : personaFormClaudeCliRestricted.checked,
    claudeCliStateless: personaFormClaudeCliStatelessRow.hidden ? false : personaFormClaudeCliStateless.checked,
    text,
  });
  personaFormStatus.textContent = ok ? "" : status === 503 ? "Runner not configured." : "Preview failed.";
  if (ok) {
    personaFormPreviewOut.textContent = data.reply;
    personaFormPreviewOut.hidden = false;
  }
});

personaForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = personaFormName.value.trim();
  if (!name) return;
  if (personaFormEditId) {
    const usedBy = allConversations.filter((c) =>
      (c.personas || []).some((p) => p.personaId === personaFormEditId),
    );
    if (usedBy.length > 1) {
      if (!confirm(`This persona is used by ${usedBy.length} conversations — edits apply to all of them. (Clone instead for a divergent copy.) Continue?`)) {
        return;
      }
    }
  }
  const body = {
    name,
    personality: personaFormPersonality.value,
    model: personaFormModel.value,
    thinking: personaFormThinkingRow.hidden ? false : personaFormThinking.checked,
    claudeCliRestricted: personaFormClaudeCliRestrictedRow.hidden ? false : personaFormClaudeCliRestricted.checked,
    claudeCliStateless: personaFormClaudeCliStatelessRow.hidden ? false : personaFormClaudeCliStateless.checked,
    capabilities: {
      webSearch: capWebSearch.checked,
      vaultRead: capVaultRead.checked,
      vaultWrite: capVaultWrite.checked,
      codeExecution: capCodeExecution.checked,
      kubectlRead: capKubectlRead.checked,
      githubRead: capGithubRead.checked,
      manageAgora: capManageAgora.checked,
      githubWrite: capGithubWrite.checked,
      githubMerge: capGithubMerge.checked,
      terminalExec: capTerminalExec.checked,
    },
    sharedMemory: personaFormMemory.value,
    isTemplate: personaFormTemplate.checked,
  };
  personaFormStatus.textContent = "Saving...";
  const { ok, data } = personaFormEditId
    ? await api("PATCH", `/personas/${personaFormEditId}`, body)
    : await api("POST", "/personas", body);
  if (!ok) {
    personaFormStatus.textContent = data.error || "Failed to save.";
    return;
  }
  personaFormScrim.hidden = true;
  await loadPersonas();
  renderPersonaStudio();
});

// --- Heartbeat Creator Studio ------------------------------------------------
async function openHeartbeatStudio() {
  closeDrawer();
  await Promise.all([loadPersonas(), loadConversationList(), loadWorkflows()]);
  await renderHeartbeatStudio();
  heartbeatStudioScrim.hidden = false;
}
navHeartbeats.addEventListener("click", openHeartbeatStudio);
heartbeatStudioClose.addEventListener("click", () => {
  heartbeatStudioScrim.hidden = true;
});
heartbeatStudioScrim.addEventListener("click", (e) => {
  if (e.target === heartbeatStudioScrim) heartbeatStudioScrim.hidden = true;
});

async function renderHeartbeatStudio() {
  const { ok, data } = await api("GET", "/heartbeats");
  heartbeatStudioList.innerHTML = "";
  if (!ok) return;
  if (!data.heartbeats.length) {
    const empty = document.createElement("div");
    empty.className = "studio-empty";
    empty.textContent = "No heartbeats yet. A heartbeat is a scheduled persona turn in a conversation — with its own task prompt and vault context.";
    heartbeatStudioList.appendChild(empty);
    return;
  }
  for (const heartbeat of data.heartbeats) {
    heartbeatStudioList.appendChild(renderHeartbeatRow(heartbeat));
  }
}

// " for 38m" — how long the in-flight run has been going, so the answer to
// "is one already going?" carries its own evidence. Empty when the server
// sent no timestamp, rather than guessing at a duration.
function formatRunningFor(runningSince) {
  if (!runningSince) return "";
  const minutes = Math.floor((Date.now() - new Date(runningSince).getTime()) / 60000);
  if (!Number.isFinite(minutes) || minutes < 0) return "";
  return minutes < 60 ? ` for ${minutes}m` : ` for ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function renderHeartbeatRow(heartbeat) {
  const persona = allPersonas.find((p) => p.id === heartbeat.personaId);
  const conversation = allConversations.find((c) => c.id === heartbeat.conversationId);
  const row = document.createElement("div");
  row.className = "studio-item";
  const main = document.createElement("div");
  main.className = "studio-item-main";
  const name = document.createElement("span");
  name.className = "studio-item-name";
  const muted = heartbeat.pushNotifications === false ? "🔕 " : "";
  name.textContent = `${heartbeat.enabled ? "" : "⏸ "}${muted}${heartbeat.name}`;
  const meta = document.createElement("span");
  meta.className = "studio-item-meta";
  const last = heartbeat.lastRunAt
    ? `last: ${new Date(heartbeat.lastRunAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}${heartbeat.lastResult ? ` (${heartbeat.lastResult})` : ""}`
    : "never run";
  const workflow = heartbeat.workflowId ? allWorkflows.find((w) => w.id === heartbeat.workflowId) : null;
  const target = workflow ? `workflow: ${workflow.name}` : `${persona?.name || "?"} → ${conversation?.name || "?"}`;
  // A cron schedule reads as "08:00, Mon–Fri" in the list rather than as the
  // raw expression -- the expression is still there in the form for anyone
  // who wants it, but this line is a glance, not a spec.
  const scheduleLabel = String(heartbeat.schedule || "").startsWith("cron@")
    ? AgoraCron.describeCron(heartbeat.schedule.slice("cron@".length)) || heartbeat.schedule
    : heartbeat.schedule;
  meta.textContent = `${scheduleLabel} · ${target} · ${last}`;
  main.append(name, meta);
  row.appendChild(main);

  const actions = document.createElement("div");
  actions.className = "studio-item-actions";
  const run = document.createElement("button");
  run.type = "button";
  run.textContent = "Run now";
  run.addEventListener("click", async (e) => {
    e.stopPropagation();
    // Edvard, issues.md #6: "my butter fingers might easily press that
    // button twice very fast triggering two heartbeats in paralell. We need
    // to gate the start of heartbeats."
    //
    // Two gates, because the accidental press and the doubled press are
    // different accidents and neither gate catches the other. `confirm` is
    // the one that catches a button hit on the way past -- a heartbeat run
    // is a whole Nova cycle, the same weight as the Delete two buttons
    // over, which has asked since it existed. `disabled` is the one that
    // catches the second half of a double-tap: it holds from the moment the
    // run is confirmed until the POST has answered, which is the window
    // where a second press would reach the server as a genuinely separate
    // request.
    //
    // What neither gate is doing is preventing two runs -- two presses
    // cannot start two concurrent runs of the same heartbeat, for two
    // reasons that are worth naming exactly, because the obvious one is
    // out of date. `forceRun` is a boolean set by an idempotent PATCH, so
    // pressing twice sets it once. And the runner refuses to spawn a run
    // for a heartbeat whose previous run is still alive
    // (`agora_runner/heartbeats.py`, the `_heartbeat_threads[...].is_alive()`
    // check). It is NOT because the poll loop is single-threaded -- it has
    // run each heartbeat on its own thread since 2026-08-08, and a comment
    // in `src/server.ts` predating that still says otherwise. This is
    // about him knowing what he pressed, not about a race.
    //
    // There is no `if (run.disabled) return;` here on purpose: a disabled
    // button dispatches no click at all, so that line was unreachable. The
    // mutation check is what showed it -- removing it failed nothing, which
    // for a guard means it was guarding nothing.
    if (!confirm(`Run "${heartbeat.name}" now? This starts a full cycle.`)) return;
    run.disabled = true;
    try {
      // `ok`, not just `data`. `api()` resolves on an HTTP error rather than
      // throwing, so reading only `data` sent every failure down the else
      // branch and told Edvard "Queued — runs within ~5s." for a run that was
      // never queued. The reachable cases are a 404 -- the route's own answer
      // for a heartbeat deleted in another tab -- and whatever the ingress
      // returns while the pod is restarting, typically a 502 or 503. A 500
      // from this route specifically is NOT one of them: it has no try/catch
      // and Express 4 does not turn a rejected async handler into a response,
      // so a store failure kills the process and reaches the phone as a
      // rejected fetch, which is the branch below.
      //
      // The other half, and the worse one: `fetch` rejects outright when the
      // phone has no route to Agora, so this handler threw before it said
      // anything at all. The press left no status message and no re-render --
      // silence, which reads as "nothing happened" when in fact the request
      // never left the device.
      //
      // The `.catch` is on the call rather than around the block on purpose.
      // A `try`/`catch` wide enough to hold the branches below would report a
      // throw from `setStatus` or `formatRunningFor` as "could not reach
      // Agora" -- naming the wrong cause, which is the exact failure this
      // whole change exists to stop doing.
      const sent = await api("POST", `/heartbeats/${heartbeat.id}/run`).catch(() => null);
      if (!sent) {
        setStatus("Not started — could not reach Agora.", 5000);
      } else if (!sent.ok) {
        setStatus(`Not started — ${sent.data?.error || `the server answered ${sent.status}`}.`, 5000);
      } else if (sent.data?.status === "already-running") {
        setStatus(`Already running${formatRunningFor(sent.data.runningSince)} — queued, starts when the current run finishes.`);
      } else {
        setStatus("Queued — runs within ~5s.");
      }
    } finally {
      // Re-enabled rather than left dead: the row is replaced by the
      // re-render below anyway, and a failed POST that permanently disabled
      // the only way to trigger a heartbeat would be worse than the double
      // press this is guarding.
      run.disabled = false;
    }
    // The `.catch` is new alongside the one above, and it exists because of
    // it. `renderHeartbeatStudio` awaits `api()` with no catch of its own, so
    // with Agora unreachable this refresh rejects too -- and before this
    // change it was never scheduled on that path at all, because the press
    // threw first. Reporting it again 1.5s later would just repeat the line
    // the press already put on screen, so this one is deliberately silent.
    setTimeout(() => renderHeartbeatStudio().catch(() => {}), 1500);
  });
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.textContent = heartbeat.enabled ? "Disable" : "Enable";
  toggle.addEventListener("click", async (e) => {
    e.stopPropagation();
    await api("PATCH", `/heartbeats/${heartbeat.id}`, { enabled: !heartbeat.enabled });
    renderHeartbeatStudio();
  });
  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "Delete";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete heartbeat "${heartbeat.name}"?`)) return;
    await api("DELETE", `/heartbeats/${heartbeat.id}`);
    renderHeartbeatStudio();
  });
  actions.append(run, toggle, del);
  row.appendChild(actions);
  row.addEventListener("click", () => openHeartbeatForm(heartbeat));
  return row;
}

heartbeatStudioAdd.addEventListener("click", () => openHeartbeatForm(null));

heartbeatFormConversation.addEventListener("change", () => {
  heartbeatFormNewConversationName.hidden = heartbeatFormConversation.value !== NEW_CHANNEL_SENTINEL;
});
// --- Schedule picker (cron) -------------------------------------------------
// "days" and "cron" are two views of one value: both save a cron@ schedule,
// and the chips compile to exactly what the raw box would take. The preview
// under both is read back OUT of the compiled expression, never off what was
// clicked -- cron is a cross product of minutes and hours, so asking for 08:00
// and 20:30 really does fire four times, and the form has to say so.
// Monday first: Edvard reads a week that way, cron numbers it Sunday-first.
const DAY_CHIPS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
let pickedDays = new Set([1, 2, 3, 4, 5, 6, 0]);
let pickedTimes = ["08:00"];

function renderDayChips() {
  heartbeatFormDays.innerHTML = "";
  for (const [value, label] of DAY_CHIPS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "day-chip";
    chip.textContent = label;
    chip.setAttribute("aria-pressed", String(pickedDays.has(value)));
    chip.addEventListener("click", () => {
      if (pickedDays.has(value)) pickedDays.delete(value);
      else pickedDays.add(value);
      // Every day off would compile to a schedule that never fires, so the
      // last chip refuses to turn itself off rather than saving a dead one.
      if (!pickedDays.size) pickedDays.add(value);
      chip.setAttribute("aria-pressed", String(pickedDays.has(value)));
      refreshSchedulePreview();
    });
    heartbeatFormDays.appendChild(chip);
  }
}

function renderTimeRows() {
  heartbeatFormTimesRows.innerHTML = "";
  pickedTimes.forEach((time, index) => {
    const row = document.createElement("div");
    row.className = "time-row";
    const input = document.createElement("input");
    input.type = "time";
    input.value = time;
    input.addEventListener("change", () => {
      pickedTimes[index] = input.value;
      refreshSchedulePreview();
    });
    row.appendChild(input);
    if (pickedTimes.length > 1) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "✕";
      remove.setAttribute("aria-label", `Remove ${time}`);
      remove.addEventListener("click", () => {
        pickedTimes.splice(index, 1);
        renderTimeRows();
        refreshSchedulePreview();
      });
      row.appendChild(remove);
    }
    heartbeatFormTimesRows.appendChild(row);
  });
}

/** The cron expression the form would save right now, whichever view is open. */
function currentCronExpr() {
  return heartbeatFormScheduleType.value === "cron"
    ? heartbeatFormCron.value.trim()
    : AgoraCron.compileCron([...pickedDays], pickedTimes);
}

function refreshSchedulePreview() {
  const cronMode = heartbeatFormScheduleType.value === "cron";
  const daysMode = heartbeatFormScheduleType.value === "days";
  heartbeatFormSchedulePreview.hidden = !(cronMode || daysMode);
  if (heartbeatFormSchedulePreview.hidden) return;
  const expr = currentCronExpr();
  const description = AgoraCron.describeCron(expr);
  heartbeatFormSchedulePreview.classList.toggle("schedule-preview-bad", !description);
  heartbeatFormSchedulePreview.textContent = description
    ? `Runs ${description} — ${expr}`
    : "Not a schedule yet: five fields, minute hour day-of-month month day-of-week.";
}

heartbeatFormAddTime.addEventListener("click", () => {
  pickedTimes.push("12:00");
  renderTimeRows();
  refreshSchedulePreview();
});
heartbeatFormCron.addEventListener("input", refreshSchedulePreview);

heartbeatFormScheduleType.addEventListener("change", () => {
  const type = heartbeatFormScheduleType.value;
  heartbeatFormTime.hidden = type !== "daily";
  heartbeatFormInterval.hidden = type !== "every";
  heartbeatFormUnit.hidden = type !== "every";
  heartbeatFormAnchorRow.hidden = type !== "every";
  heartbeatFormCron.hidden = type !== "cron";
  heartbeatFormDays.hidden = type !== "days";
  heartbeatFormTimes.hidden = type !== "days";
  // Switching between the two cron views carries the schedule across instead
  // of resetting it, so trying the raw box and coming back is free.
  if (type === "cron" && !heartbeatFormCron.value.trim()) {
    heartbeatFormCron.value = AgoraCron.compileCron([...pickedDays], pickedTimes);
  }
  if (type === "days") {
    const decoded = AgoraCron.decodeCron(heartbeatFormCron.value.trim());
    if (decoded) {
      pickedDays = new Set(decoded.days);
      pickedTimes = decoded.times;
    }
    renderDayChips();
    renderTimeRows();
  }
  refreshSchedulePreview();
});
heartbeatFormAnchorEnabled.addEventListener("change", () => {
  heartbeatFormAnchor.disabled = !heartbeatFormAnchorEnabled.checked;
});

function openHeartbeatForm(heartbeat) {
  heartbeatFormEditId = heartbeat ? heartbeat.id : null;
  heartbeatFormTitle.textContent = heartbeat ? `Edit ${heartbeat.name}` : "New heartbeat";
  heartbeatFormName.value = heartbeat?.name || "";
  heartbeatFormPersona.innerHTML = "";
  for (const persona of allPersonas.filter((p) => !p.isTemplate)) {
    const option = document.createElement("option");
    option.value = persona.id;
    option.textContent = persona.name;
    heartbeatFormPersona.appendChild(option);
  }
  heartbeatFormConversation.innerHTML = "";
  const newChannelOption = document.createElement("option");
  newChannelOption.value = NEW_CHANNEL_SENTINEL;
  newChannelOption.textContent = "+ New empty channel...";
  heartbeatFormConversation.appendChild(newChannelOption);
  for (const conversation of allConversations) {
    const option = document.createElement("option");
    option.value = conversation.id;
    option.textContent = conversation.name + (conversation.archived ? " (archived)" : "");
    heartbeatFormConversation.appendChild(option);
  }
  heartbeatFormNewConversationName.value = "";
  heartbeatFormNewConversationName.hidden = true;
  heartbeatFormWorkflow.innerHTML = '<option value="">None — a single curator turn (default)</option>';
  for (const workflow of allWorkflows) {
    const option = document.createElement("option");
    option.value = workflow.id;
    option.textContent = workflow.name;
    heartbeatFormWorkflow.appendChild(option);
  }
  if (heartbeat) {
    heartbeatFormPersona.value = heartbeat.personaId;
    heartbeatFormConversation.value = heartbeat.conversationId;
    heartbeatFormWorkflow.value = heartbeat.workflowId || "";
    const schedule = heartbeat.schedule || "daily@08:00";
    if (schedule.startsWith("daily@")) {
      heartbeatFormScheduleType.value = "daily";
      const time = schedule.slice("daily@".length);
      heartbeatFormTime.value = time.length === 4 ? `0${time}` : time;
    } else if (schedule.startsWith("cron@")) {
      const expr = schedule.slice("cron@".length);
      heartbeatFormCron.value = expr;
      // Only open the picker on a schedule it can express without losing
      // anything -- decodeCron says no to a day-of-month or month restriction,
      // and those get the raw box so a save can't quietly drop them.
      const decoded = AgoraCron.decodeCron(expr);
      heartbeatFormScheduleType.value = decoded ? "days" : "cron";
      if (decoded) {
        pickedDays = new Set(decoded.days);
        pickedTimes = decoded.times;
      }
    } else {
      heartbeatFormScheduleType.value = "every";
      const [amount, anchor] = schedule.slice("every@".length).split("@");
      heartbeatFormInterval.value = amount.slice(0, -1);
      heartbeatFormUnit.value = amount.slice(-1);
      heartbeatFormAnchorEnabled.checked = Boolean(anchor);
      if (anchor) heartbeatFormAnchor.value = anchor.length === 4 ? `0${anchor}` : anchor;
    }
  } else {
    heartbeatFormScheduleType.value = "daily";
    heartbeatFormTime.value = "08:00";
    heartbeatFormAnchorEnabled.checked = false;
    heartbeatFormCron.value = "";
    pickedDays = new Set([1, 2, 3, 4, 5, 6, 0]);
    pickedTimes = ["08:00"];
  }
  renderDayChips();
  renderTimeRows();
  heartbeatFormAnchor.disabled = !heartbeatFormAnchorEnabled.checked;
  heartbeatFormScheduleType.dispatchEvent(new Event("change"));
  heartbeatFormTask.value = heartbeat?.task || "";
  heartbeatFormVaultPaths.value = (heartbeat?.vaultPaths || []).join("\n");
  heartbeatFormEnabled.checked = heartbeat ? Boolean(heartbeat.enabled) : true;
  // Absent means notify, so an existing heartbeat that predates this field
  // reads as checked rather than as muted.
  heartbeatFormPush.checked = heartbeat ? heartbeat.pushNotifications !== false : true;
  heartbeatFormStatus.textContent = "";
  heartbeatFormScrim.hidden = false;
}

heartbeatFormScrim.addEventListener("click", (e) => {
  if (e.target === heartbeatFormScrim) heartbeatFormScrim.hidden = true;
});
heartbeatFormCancel.addEventListener("click", () => {
  heartbeatFormScrim.hidden = true;
});
heartbeatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = heartbeatFormName.value.trim();
  if (!name) return;
  const creatingNewChannel = heartbeatFormConversation.value === NEW_CHANNEL_SENTINEL;
  if (creatingNewChannel && !heartbeatFormNewConversationName.value.trim()) {
    heartbeatFormStatus.textContent = "New channel name is required.";
    return;
  }
  const anchor = heartbeatFormAnchorEnabled.checked ? `@${heartbeatFormAnchor.value}` : "";
  const scheduleType = heartbeatFormScheduleType.value;
  let schedule;
  if (scheduleType === "daily") {
    schedule = `daily@${heartbeatFormTime.value}`;
  } else if (scheduleType === "days" || scheduleType === "cron") {
    const expr = currentCronExpr();
    if (!AgoraCron.isValidCron(expr)) {
      // The server rejects this too, but with a 400 the form would show as a
      // generic save failure -- say which part is wrong while it's on screen.
      heartbeatFormStatus.textContent =
        "That cron expression needs five fields: minute hour day-of-month month day-of-week.";
      return;
    }
    schedule = `cron@${expr}`;
  } else {
    schedule = `every@${heartbeatFormInterval.value}${heartbeatFormUnit.value}${anchor}`;
  }
  const body = {
    name,
    personaId: heartbeatFormPersona.value,
    ...(creatingNewChannel
      ? { newConversationName: heartbeatFormNewConversationName.value.trim() }
      : { conversationId: heartbeatFormConversation.value }),
    schedule,
    task: heartbeatFormTask.value,
    workflowId: heartbeatFormWorkflow.value || null,
    vaultPaths: heartbeatFormVaultPaths.value
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean),
    enabled: heartbeatFormEnabled.checked,
    pushNotifications: heartbeatFormPush.checked,
  };
  heartbeatFormStatus.textContent = "Saving...";
  const { ok, data } = heartbeatFormEditId
    ? await api("PATCH", `/heartbeats/${heartbeatFormEditId}`, body)
    : await api("POST", "/heartbeats", body);
  if (!ok) {
    heartbeatFormStatus.textContent = data.error || "Failed to save.";
    return;
  }
  heartbeatFormScrim.hidden = true;
  renderHeartbeatStudio();
});

// --- Workflow Creator Studio (Decisions/0009) -------------------------------
// One checkbox per user-facing concept; "Vault read" expands to both
// vault_read and vault_list tool names since the runner gates them
// separately but this Studio always grants/denies them together.
const WORKFLOW_TOOL_OPTIONS = [
  { label: "Web search", tokens: ["web_search"] },
  { label: "Vault read", tokens: ["vault_read", "vault_list"] },
  { label: "Vault write", tokens: ["vault_write"] },
  { label: "Kubectl read", tokens: ["kubectl_read"] },
  { label: "GitHub read", tokens: ["github_read"] },
  { label: "Scoped write (this step's file only)", tokens: ["scoped_write"] },
];

async function openWorkflowStudio() {
  closeDrawer();
  await loadWorkflows();
  renderWorkflowStudio();
  workflowStudioScrim.hidden = false;
}
navWorkflows.addEventListener("click", openWorkflowStudio);
workflowStudioClose.addEventListener("click", () => {
  workflowStudioScrim.hidden = true;
});
workflowStudioScrim.addEventListener("click", (e) => {
  if (e.target === workflowStudioScrim) workflowStudioScrim.hidden = true;
});

function renderWorkflowStudio() {
  workflowStudioList.innerHTML = "";
  if (!allWorkflows.length) {
    const empty = document.createElement("div");
    empty.className = "studio-empty";
    empty.textContent = "No workflows yet. A workflow is a bounded, multi-step, multi-persona turn sequence a heartbeat can run instead of a single curator turn.";
    workflowStudioList.appendChild(empty);
    return;
  }
  for (const workflow of allWorkflows) {
    workflowStudioList.appendChild(renderWorkflowRow(workflow));
  }
}

function renderWorkflowRow(workflow) {
  const row = document.createElement("div");
  row.className = "studio-item";
  const main = document.createElement("div");
  main.className = "studio-item-main";
  const name = document.createElement("span");
  name.className = "studio-item-name";
  name.textContent = workflow.name;
  const meta = document.createElement("span");
  meta.className = "studio-item-meta";
  const totalRounds = workflow.steps.reduce((sum, s) => sum + (s.loopCount || 0), 0);
  meta.textContent = `${workflow.steps.length} step${workflow.steps.length === 1 ? "" : "s"} · ${totalRounds} round${totalRounds === 1 ? "" : "s"} total${workflow.description ? ` · ${workflow.description}` : ""}`;
  main.append(name, meta);
  row.appendChild(main);

  const actions = document.createElement("div");
  actions.className = "studio-item-actions";
  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "Delete";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete workflow "${workflow.name}"?`)) return;
    const { ok, data } = await api("DELETE", `/workflows/${workflow.id}`);
    if (!ok) {
      alert(data.error + (data.heartbeats ? `: ${data.heartbeats.join(", ")}` : ""));
      return;
    }
    await loadWorkflows();
    renderWorkflowStudio();
  });
  actions.append(del);
  row.appendChild(actions);
  row.addEventListener("click", () => openWorkflowForm(workflow));
  return row;
}

workflowStudioAdd.addEventListener("click", () => openWorkflowForm(null));

function renderWorkflowFormStepsUI() {
  workflowFormSteps.innerHTML = "";
  workflowFormStepsState.forEach((step, index) => {
    workflowFormSteps.appendChild(renderStepFieldset(step, index));
  });
}

function renderStepFieldset(step, index) {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "workflow-step";

  const header = document.createElement("div");
  header.className = "workflow-step-header";
  const label = document.createElement("span");
  label.textContent = `Step ${index + 1}`;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn-secondary";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    workflowFormStepsState.splice(index, 1);
    renderWorkflowFormStepsUI();
  });
  header.append(label, remove);
  fieldset.appendChild(header);

  const prompt = document.createElement("textarea");
  prompt.rows = 3;
  prompt.placeholder = "Prompt layered onto each participant for this step (e.g. 'Critique the prior turn constructively.')";
  prompt.value = step.prompt;
  prompt.addEventListener("input", () => {
    step.prompt = prompt.value;
  });
  fieldset.appendChild(prompt);

  const row = document.createElement("div");
  row.className = "modal-row";
  const loopLabel = document.createElement("label");
  loopLabel.textContent = "Rounds";
  const loopInput = document.createElement("input");
  loopInput.type = "number";
  loopInput.min = "1";
  loopInput.value = String(step.loopCount);
  loopInput.style.width = "4.5rem";
  loopInput.addEventListener("input", () => {
    const n = parseInt(loopInput.value, 10);
    step.loopCount = Number.isFinite(n) && n >= 1 ? n : 1;
  });
  loopLabel.appendChild(loopInput);
  row.appendChild(loopLabel);
  fieldset.appendChild(row);

  const filepath = document.createElement("input");
  filepath.type = "text";
  filepath.placeholder = "File scope (optional) — exact file, or a folder ending in / to create+lock the first write";
  filepath.value = step.filepath || "";
  filepath.addEventListener("input", () => {
    step.filepath = filepath.value.trim() || undefined;
  });
  fieldset.appendChild(filepath);

  const toolsLabel = document.createElement("div");
  toolsLabel.className = "modal-hint";
  toolsLabel.textContent = "Tool whitelist (none checked = unrestricted, each participant's own capabilities apply)";
  fieldset.appendChild(toolsLabel);

  const toolsRow = document.createElement("div");
  toolsRow.className = "workflow-step-tools";
  for (const option of WORKFLOW_TOOL_OPTIONS) {
    const checkboxLabel = document.createElement("label");
    checkboxLabel.className = "checkbox-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = option.tokens.every((t) => step.toolWhitelist.includes(t));
    checkbox.addEventListener("change", () => {
      const withoutThisOption = step.toolWhitelist.filter((t) => !option.tokens.includes(t));
      step.toolWhitelist = checkbox.checked ? [...withoutThisOption, ...option.tokens] : withoutThisOption;
    });
    checkboxLabel.append(checkbox, document.createTextNode(` ${option.label}`));
    toolsRow.appendChild(checkboxLabel);
  }
  fieldset.appendChild(toolsRow);

  const workflowRefSelect = document.createElement("select");
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.textContent = "Not a sub-workflow step";
  workflowRefSelect.appendChild(noneOption);
  for (const workflow of allWorkflows.filter((w) => w.id !== workflowFormEditId)) {
    const option = document.createElement("option");
    option.value = workflow.id;
    option.textContent = `Run workflow: ${workflow.name}`;
    workflowRefSelect.appendChild(option);
  }
  workflowRefSelect.value = step.workflowRef || "";
  workflowRefSelect.addEventListener("change", () => {
    step.workflowRef = workflowRefSelect.value || undefined;
  });
  fieldset.appendChild(workflowRefSelect);

  return fieldset;
}

workflowFormAddStep.addEventListener("click", () => {
  workflowFormStepsState.push({ prompt: "", loopCount: 3, toolWhitelist: [] });
  renderWorkflowFormStepsUI();
});

function openWorkflowForm(workflow) {
  workflowFormEditId = workflow ? workflow.id : null;
  workflowFormTitle.textContent = workflow ? `Edit ${workflow.name}` : "New workflow";
  workflowFormName.value = workflow?.name || "";
  workflowFormDescription.value = workflow?.description || "";
  // Deep-ish copy so editing in the form doesn't mutate allWorkflows until Save.
  workflowFormStepsState = (workflow?.steps || []).map((s) => ({ ...s, toolWhitelist: [...s.toolWhitelist] }));
  renderWorkflowFormStepsUI();
  workflowFormStatus.textContent = "";
  workflowFormScrim.hidden = false;
}

workflowFormScrim.addEventListener("click", (e) => {
  if (e.target === workflowFormScrim) workflowFormScrim.hidden = true;
});
workflowFormCancel.addEventListener("click", () => {
  workflowFormScrim.hidden = true;
});
workflowForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = workflowFormName.value.trim();
  if (!name) return;
  const body = {
    name,
    description: workflowFormDescription.value,
    steps: workflowFormStepsState,
  };
  workflowFormStatus.textContent = "Saving...";
  const { ok, data } = workflowFormEditId
    ? await api("PATCH", `/workflows/${workflowFormEditId}`, body)
    : await api("POST", "/workflows", body);
  if (!ok) {
    workflowFormStatus.textContent = data.error || "Failed to save.";
    return;
  }
  workflowFormScrim.hidden = true;
  await loadWorkflows();
  renderWorkflowStudio();
});

// --- Activity (audit) --------------------------------------------------------

// Line-based LCS diff, same idea as `diff`/git — walks the longest common
// subsequence table backwards to emit a run of unchanged/added/removed
// lines. O(n*m) on line counts, which is fine for the vault notes this
// diffs (capped at CONTENT_CHARS_MAX server-side); above LCS_LINE_BUDGET
// cells we skip straight to a whole-file replace instead of hanging the
// tab on some outlier huge file.
const LCS_LINE_BUDGET = 250000;
function diffLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > LCS_LINE_BUDGET) {
    return [
      ...a.map((line) => ({ type: "del", line })),
      ...b.map((line) => ({ type: "add", line })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "del", line: a[i] });
      i++;
    } else {
      out.push({ type: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", line: a[i++] });
  while (j < m) out.push({ type: "add", line: b[j++] });
  return out;
}

function renderDiff(before, after) {
  const container = document.createElement("div");
  if (before === after) {
    container.className = "diff-empty";
    container.textContent = "No content change.";
    return container;
  }
  container.className = "diff-view";
  for (const { type, line } of diffLines(before, after)) {
    const row = document.createElement("div");
    row.className = `diff-line diff-${type}`;
    const marker = document.createElement("span");
    marker.className = "diff-marker";
    marker.textContent = type === "add" ? "+" : type === "del" ? "-" : " ";
    const text = document.createElement("span");
    text.textContent = line;
    row.append(marker, text);
    container.appendChild(row);
  }
  return container;
}

function openAuditDetail(entry) {
  auditDetailTitle.textContent = `${entry.personaName} · ${entry.capability}`;
  auditDetailFields.innerHTML = "";
  const fields = [
    ["Persona", entry.personaName],
    ["Capability", entry.capability],
    ["Target", entry.detail || "—"],
    ["Time", new Date(entry.ts).toLocaleString()],
    ["Conversation", entry.conversationId || "—"],
  ];
  for (const [label, value] of fields) {
    const row = document.createElement("div");
    row.className = "field-row";
    const labelEl = document.createElement("span");
    labelEl.className = "field-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.className = "field-value";
    valueEl.textContent = value;
    row.append(labelEl, valueEl);
    auditDetailFields.appendChild(row);
  }
  auditDetailDiff.innerHTML = "";
  if (entry.before !== undefined && entry.after !== undefined) {
    auditDetailDiff.appendChild(renderDiff(entry.before, entry.after));
  }
  // What the tool returned. Verbatim and unstyled on purpose -- this is the
  // thing Edvard asked for three times, and the whole value of it is that it
  // is the actual bytes that came back, not a rendering of them.
  if (entry.output !== undefined) {
    const heading = document.createElement("div");
    heading.className = "field-label";
    heading.textContent = entry.isError ? "Output (failed)" : "Output";
    const pre = document.createElement("pre");
    pre.className = `audit-output${entry.isError ? " audit-output-error" : ""}`;
    pre.textContent = entry.output || "(no output)";
    auditDetailDiff.append(heading, pre);
  }
  auditDetailScrim.hidden = false;
}

navAudit.addEventListener("click", async () => {
  closeDrawer();
  const { ok, data } = await api("GET", "/audit?limit=100");
  auditList.innerHTML = "";
  if (ok) {
    if (!data.entries.length) {
      const empty = document.createElement("div");
      empty.className = "studio-empty";
      empty.textContent = "No capability activity recorded yet.";
      auditList.appendChild(empty);
    }
    for (const entry of data.entries) {
      const row = document.createElement("div");
      row.className = "studio-item";
      const main = document.createElement("div");
      main.className = "studio-item-main";
      const name = document.createElement("span");
      name.className = "studio-item-name";
      name.textContent = `${entry.personaName} · ${entry.capability}`;
      const meta = document.createElement("span");
      meta.className = "studio-item-meta";
      meta.textContent = `${new Date(entry.ts).toLocaleString()} — ${entry.detail}`;
      main.append(name, meta);
      row.appendChild(main);
      row.addEventListener("click", () => openAuditDetail(entry));
      auditList.appendChild(row);
    }
  }
  auditScrim.hidden = false;
});
auditClose.addEventListener("click", () => {
  auditScrim.hidden = true;
});
auditScrim.addEventListener("click", (e) => {
  if (e.target === auditScrim) auditScrim.hidden = true;
});
auditDetailClose.addEventListener("click", () => {
  auditDetailScrim.hidden = true;
});
auditDetailScrim.addEventListener("click", (e) => {
  if (e.target === auditDetailScrim) auditDetailScrim.hidden = true;
});

// --- Messages ----------------------------------------------------------------
// The first load's width, not the poll's. Polls are incremental (see
// fetchMessages), so this bounds one request when a thread is opened rather
// than one request every 3 seconds — which is why it can now be wide enough
// to hold a whole cycle. Measured across all 81 live conversations on
// 2026-08-10: median 169 messages, p90 338, largest Nova cycle 474, and 32 of
// them over the old 200. At 500 every cycle this loop has ever run fits whole,
// and the count in a collapsed drawer stops going backwards, because nothing
// falls off the front of the client's copy any more.
const MESSAGE_WINDOW = 500;

// Both of these are defaulted rather than reading the accumulator inline, so a
// test can drive them without reaching into lexical state — the same trick
// renderMessages() already uses. The harness evals this file as global code,
// so `function` declarations are reachable from a test and `let` is not.
function messagesQuery(
  conversationId,
  held = heldMessages,
  rev = heldRev,
  heldFor = heldConversationId,
) {
  const params = new URLSearchParams({ limit: String(MESSAGE_WINDOW) });
  const last = held[held.length - 1];
  // Only ask for a delta against a thread we are actually holding. A stale id
  // from a previous conversation would be answered correctly anyway (the
  // server would not find it and would send the window), but asking for it
  // states something untrue about our own state.
  if (heldFor === conversationId && last && rev) {
    params.set("after", last.id);
    params.set("rev", rev);
  }
  return `/conversations/${conversationId}/messages?${params}`;
}

/** `incremental` is the server's answer to "is what you are holding still real
 * history", so it alone decides append-vs-replace. Anything that does not
 * claim to be incremental — an older server, a rev the server no longer
 * recognises, a first load — replaces, which is exactly what this did before. */
function applyMessagePage(held, data) {
  return data.incremental ? held.concat(data.messages) : data.messages;
}

/** A delta is only meaningful against the exact state it was requested for.
 * Two polls overlap easily — the 3s timer plus the direct fetchMessages()
 * after every send, delete, forget and regenerate — and before this change
 * that was harmless, because every response replaced the thread wholesale.
 * An append is not idempotent: both would add the same message and the reader
 * would see it twice. So a delta that raced a delta is dropped, and the next
 * poll 3 seconds later collects whatever it carried. A full page is always
 * safe to apply, because replacing is idempotent no matter what else landed. */
function canApplyPage(data, requestedFromRev, currentRev) {
  return !data.incremental || requestedFromRev === currentRev;
}

function messagesEndpoint() {
  return messagesQuery(currentConversationId);
}
function replyEndpoint() {
  return `/conversations/${currentConversationId}/reply`;
}
function messageEndpoint(messageId) {
  return `/conversations/${currentConversationId}/messages/${messageId}`;
}

function updateHeader() {
  if (!currentDetail) {
    headerTitle.childNodes[0].textContent = "Agora";
    headerSubtitle.hidden = true;
    pausedBanner.hidden = true;
    return;
  }
  headerTitle.childNodes[0].textContent = currentDetail.name;
  const personas = currentDetail.personas || [];
  if (personas.length > 1) {
    headerSubtitle.textContent = personas
      .map((p) => (p.role === "curator" ? `${p.name}★` : p.name))
      .join(" · ");
    headerSubtitle.hidden = false;
  } else {
    const model = modelCatalogById.get(currentDetail.model);
    headerSubtitle.textContent = model ? model.label : "";
    headerSubtitle.hidden = !model;
  }
  pausedBanner.hidden = currentDetail.status !== "paused";
}

pausedResume.addEventListener("click", async () => {
  if (!currentConversationId) return;
  await api("PATCH", `/conversations/${currentConversationId}`, { status: "active" });
  renderedKey = "";
  await fetchMessages();
  loadConversationList();
});

async function fetchMessages() {
  if (!currentConversationId) {
    messagesEl.innerHTML = "";
    const empty = document.createElement("p");
    empty.id = "empty";
    empty.textContent = "Select or create a conversation from the menu.";
    messagesEl.appendChild(empty);
    updateHeader();
    return;
  }
  // What this request is being asked against. A poll is not the only caller —
  // sending, deleting, forgetting and regenerating all call fetchMessages()
  // directly, so two can easily be in flight at once.
  const askedFor = currentConversationId;
  const askedFrom = heldConversationId === currentConversationId ? heldRev : "";

  const { ok, status, data } = await api("GET", messagesEndpoint());
  if (!ok) {
    if (status === 404) {
      currentConversationId = null;
      currentDetail = null;
      heldMessages = [];
      heldRev = "";
      heldConversationId = null;
      fetchMessages();
    }
    return;
  }
  if (askedFor !== currentConversationId) return;
  if (!canApplyPage(data, askedFrom, heldRev)) return;

  heldMessages = applyMessagePage(heldMessages, data);
  heldRev = typeof data.rev === "string" ? data.rev : "";
  heldConversationId = currentConversationId;
  currentDetail = data;
  updateHeader();
  renderMessages(heldMessages);
}

function renderMessages(
  messages,
  // Defaulted rather than read inline so a test can render a windowed view;
  // every production call site keeps the currentDetail-derived answer.
  windowed = (currentDetail?.totalMessages ?? messages.length) > messages.length,
) {
  lastRenderedMessages = messages;
  const key = `${currentConversationId}:${messages
    .map((m) => `${m.id}:${m.text.length}:${m.forgotten ? 1 : 0}`)
    .join(",")}:${editingMessageId}:${currentDetail?.status}`;
  if (key === renderedKey) {
    updateWaitingNotice(messages);
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
    const visible = mergeToolResults(messages);
    const last = visible[visible.length - 1];
    // Only the group at the window's front can be missing anything: everything
    // after it arrived whole.
    const groups = groupNarration(visible);
    groups.forEach((group, i) => {
      messagesEl.appendChild(
        group.narration
          ? renderNarrationGroup(group, windowed && i === 0)
          : renderMessageBlock(group.messages[0], group.messages[0] === last),
      );
    });
  }
  updateWaitingNotice(messages);
  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// A claude-cli persona writes in the gaps between its tool calls -- "let me
// check the deploy first", then a Bash, then "that came back clean, so". The
// bridge used to hold all of that until the session ended and then hand it
// over glued into one block, which is why Edvard saw "a block of tool call
// and then a block of text" and asked for the obvious thing instead
// (2026-08-04): "how would you like to be presented a story? One does not
// describe all actions in the story first, and then the narrative. They are
// in between each other, first a narrative, then an action, then a
// narrative, then an action."
//
// So the bridge now streams each of those passages the moment it is written,
// down the same path as the tool chips, and they land in the conversation in
// the order they actually happened. They are narration, not the reply -- the
// reply is still its own message at the end -- so they belong in the drawer
// with the chips. They just are not chips: a paragraph rendered as a
// one-line clickable label with a chevron would be unreadable.
const NARRATION_TEXT = "assistant_text";

function isNarrationText(message) {
  return message.activity?.capability === NARRATION_TEXT;
}

const ACTIVITY_CHIP_LABELS = {
  vault_read: "Read vault file",
  vault_write: "Wrote vault file",
  vault_list: "Listed vault folder",
  web_search: "Searched the web",
  kubectl_read: "Read cluster state",
  github_read: "Read GitHub",
  save_memory: "Saved memory",
  heartbeat: "Ran heartbeat",
  // One chip for a whole subagent: the bridge posts its launch and its
  // finish under the same task id, so mergeToolResults folds them together
  // and the expanded body is what the subagent reported back, with what it
  // cost. Everything the subagent did in between arrives as ordinary chips,
  // labelled with a "↳" and its brief.
  subagent: "Subagent",
};

// Narration = a persona's tool calls and its own thinking: everything it did
// on the way to the answer, as opposed to the answer. Edvard, 2026-08-04:
// "I want the ability to see all your thoughts, all your tool calls, all its
// inputs and outputs, everything. But I also want the ability to hide those
// things away and just focus on your answering text." So none of it is
// dropped or capped -- it is all still here, one click away, and a cycle that
// makes four hundred calls shows four hundred of them. It just doesn't sit
// between him and the reply by default.
function isNarration(message) {
  return Boolean(message.activity || message.thinking);
}

// A narrated tool call arrives as two messages: the call, sent the moment it
// starts, and its output, sent when it returns -- both tagged with the same
// activity.toolUseId by agora-claude-bridge. Two messages rather than one
// amended message so the chip is live: a `pytest` that runs for four minutes
// has to appear when it is launched, not when it finishes. Edvard, on the
// output half (his issue 1, asked three times): "I need to see the command
// with all metadata and also the output from that command, such as the
// return of a echo command."
//
// Folding them back together is a render-time concern, which is why it lives
// here and not in the store: nothing on the server is mutated, the audit
// trail stays append-only, and a half that never arrives simply never gets
// merged.
function mergeToolResults(messages) {
  const callsById = new Map();
  for (const message of messages) {
    const id = message.activity?.toolUseId;
    if (id && message.activity.output === undefined) callsById.set(id, message);
  }

  const merged = [];
  for (const message of messages) {
    const activity = message.activity;
    if (activity?.output === undefined) {
      merged.push(message);
      continue;
    }
    const call = activity.toolUseId ? callsById.get(activity.toolUseId) : undefined;
    if (!call) {
      // An output whose call we never saw -- a conversation loaded from the
      // middle, or a lost first half. Render it on its own rather than
      // dropping it: a chip nobody can explain beats output nobody can see.
      merged.push(message);
      continue;
    }
    // Replace the call in place, so the merged chip keeps the call's id and
    // position and the drawer's expanded-state key stays stable.
    const index = merged.indexOf(call);
    const withOutput = {
      ...call,
      activity: { ...call.activity, output: activity.output, isError: activity.isError },
    };
    if (index >= 0) merged[index] = withOutput;
    callsById.set(activity.toolUseId, withOutput);
  }
  return merged;
}

// Runs of consecutive narration collapse into one drawer; anything else
// stays exactly as it rendered before. Consecutive is the right unit: it
// keeps the narration attached to the reply it produced, rather than
// hoisting a conversation's worth of tool calls into one lump at the top.
// A group's identity is the message it FOLLOWS, never its own first message.
// The client renders a sliding window (`?limit=` -> `slice(-limit)` server
// side), so once a live run outgrows that window its first message changes on
// almost every poll while the group is plainly still the same drawer. Keying
// on it meant the expanded-state lookup missed on 119 of 120 consecutive
// polls, and the drawer collapsed itself within seconds of being opened —
// Edvard, issues.md #48: "It closes almost immediately when i open it".
// A group at the window's front has no preceding message and anchors to a
// sentinel instead; if the real anchor later falls out of the window the key
// flips to that sentinel exactly once, rather than on every poll.
const NARRATION_HEAD_ANCHOR = "#narration-head";

function groupNarration(messages) {
  const groups = [];
  let anchor = NARRATION_HEAD_ANCHOR;
  for (const message of messages) {
    const narration = isNarration(message);
    const open = groups[groups.length - 1];
    if (narration && open?.narration) open.messages.push(message);
    else groups.push({ narration, messages: [message], anchor });
    if (!narration) anchor = message.id;
  }
  return groups;
}

function narrationStepLabel(message) {
  if (message.thinking) return "Thinking";
  const { capability, detail } = message.activity;
  // A written passage summarises as its own first line -- "assistant_text ·"
  // in front of it would be labelling prose with the name of a wire format.
  if (isNarrationText(message)) return detail.split("\n")[0];
  const verb = ACTIVITY_CHIP_LABELS[capability] || capability;
  return detail ? `${verb} · ${detail}` : verb;
}

// The collapsed label has to carry the liveness the chips used to carry on
// their own: during a cycle this is the only thing moving on screen, and
// "displayed after the process is finished... they serve no purpose other
// than hindsight logging" was the original complaint. So it shows the count
// AND the newest step, both of which change as the run goes.
// `truncated` means the server sent a window, not the whole run, so the group
// really does have more steps than we are holding. The window's own length is
// then a lower bound that jitters DOWNWARDS: each poll drops a message off the
// front and, when the arriving message is a tool result, merges it into a call
// rather than adding a chip — so the count falls by one. Replayed against
// Cycle 68's real 338-message conversation it peaked at 125 and went backwards
// 36 times, which is Edvard's "does not count more steps, it actually goes
// downwards to 117??". The best honest number is the largest count seen so far.
function narrationSummary(messages, { truncated = false, anchor } = {}) {
  let n = messages.length;
  if (truncated && anchor !== undefined) {
    n = Math.max(n, narrationStepHighWater.get(anchor) ?? 0);
    narrationStepHighWater.set(anchor, n);
  }
  const count = truncated ? `${n}+ steps` : `${n} step${n === 1 ? "" : "s"}`;
  return `${count} · ${narrationStepLabel(messages[messages.length - 1])}`;
}

function renderNarrationGroup(group, truncated = false) {
  const { messages, anchor } = group;
  // Scoped to the conversation: unlike a message id, the head sentinel is the
  // same string in every thread, so an unscoped key would carry one thread's
  // open drawer and step count over to the next.
  const key = `${currentConversationId}:${anchor}`;
  const wrap = document.createElement("div");
  wrap.className = "msg-narration";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "msg-narration-toggle";
  const chevron = document.createElement("span");
  chevron.className = "msg-narration-chevron";
  const summary = document.createElement("span");
  summary.className = "msg-narration-summary";
  summary.textContent = narrationSummary(messages, { truncated, anchor: key });
  toggle.append(chevron, summary);

  const body = document.createElement("div");
  body.className = "msg-narration-body";
  if (truncated) {
    // Say where the missing steps went rather than letting them look deleted.
    const note = document.createElement("p");
    note.className = "msg-narration-truncated";
    note.textContent = "Earliest steps of this run are outside the loaded window.";
    body.appendChild(note);
  }
  for (const message of messages) body.appendChild(renderMessageBlock(message, false));

  const apply = (expanded) => {
    toggle.setAttribute("aria-expanded", String(expanded));
    body.hidden = !expanded;
    chevron.textContent = expanded ? "⌄" : "›";
  };
  apply(expandedNarrationGroups.has(key));

  toggle.addEventListener("click", () => {
    const expanded = !expandedNarrationGroups.has(key);
    if (expanded) expandedNarrationGroups.add(key);
    else expandedNarrationGroups.delete(key);
    apply(expanded);
  });

  wrap.append(toggle, body);
  return wrap;
}

function activityEntryFromMessage(message) {
  return {
    personaName: message.sender,
    capability: message.activity.capability,
    detail: message.activity.detail,
    ts: message.ts,
    conversationId: currentConversationId,
    before: message.activity.before,
    after: message.activity.after,
    output: message.activity.output,
    isError: message.activity.isError,
  };
}

function renderActivityChip(message) {
  const { activity } = message;
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "msg-activity-chip";

  const label = document.createElement("span");
  label.className = "msg-activity-label";
  const verb = ACTIVITY_CHIP_LABELS[activity.capability] || activity.capability;
  label.textContent = activity.detail ? `${verb} · ${activity.detail}` : verb;
  chip.appendChild(label);

  if (activity.before !== undefined && activity.after !== undefined) {
    let added = 0;
    let removed = 0;
    for (const { type } of diffLines(activity.before, activity.after)) {
      if (type === "add") added++;
      else if (type === "del") removed++;
    }
    const stats = document.createElement("span");
    stats.className = "msg-activity-stats";
    const addEl = document.createElement("span");
    addEl.className = "stat-add";
    addEl.textContent = `+${added}`;
    const delEl = document.createElement("span");
    delEl.className = "stat-del";
    delEl.textContent = `-${removed}`;
    stats.append(addEl, delEl);
    chip.appendChild(stats);
  }

  // A failed tool call used to be indistinguishable from a successful one:
  // same chip, same label, and the reason lived only in output nobody could
  // see. Now that the output is here, mark the failure on the chip itself so
  // it is visible without opening anything.
  if (activity.isError) {
    chip.classList.add("msg-activity-failed");
    const failed = document.createElement("span");
    failed.className = "msg-activity-failed-mark";
    failed.textContent = "failed";
    chip.appendChild(failed);
  }

  const chevron = document.createElement("span");
  chevron.className = "msg-activity-chevron";
  chevron.textContent = "›";
  chip.appendChild(chevron);

  chip.addEventListener("click", () => openAuditDetail(activityEntryFromMessage(message)));
  return chip;
}

// A passage the persona wrote between two tool calls, rendered as the prose
// it is. Same markdown as a real reply so a bulleted list or a code fence
// reads correctly, but dimmed and without a sender/timestamp line: inside an
// expanded drawer these alternate with chips, and a meta line on every one
// would turn the story back into a list of records.
function renderNarrationText(message) {
  const block = document.createElement("div");
  block.className = "msg-narration-text";
  block.innerHTML = renderMarkdown(message.activity.detail);
  return block;
}

// Extended-thinking chunk (2026-07-31) -- a persona's own thought process,
// not the answer. No long-press menu (nothing to edit/regenerate/forget
// separately from the reply it led to), dimmed/italic so it reads as
// scratch space rather than competing with the real reply that follows.
function renderThinkingBlock(message) {
  const block = document.createElement("div");
  block.className = "msg-block theirs";
  const meta = document.createElement("div");
  meta.className = "msg-meta msg-thinking-meta";
  meta.textContent = `💭 ${message.sender} · ${formatTime(message.ts)}`;
  block.appendChild(meta);
  const body = document.createElement("div");
  body.className = "msg-plain msg-thinking";
  body.innerHTML = renderMarkdown(message.text);
  block.appendChild(body);
  return block;
}

function renderMessageBlock(message, isLast) {
  // Inline Activity chip (2026-07-24) -- a tool-use event, not something
  // anyone "said". No sender/timestamp meta line, no bubble, no long-press
  // menu: just the same clickable-row-opens-detail affordance as the
  // Activity tab, reusing its diff modal via activityEntryFromMessage.
  if (isNarrationText(message)) {
    return renderNarrationText(message);
  }
  if (message.activity) {
    return renderActivityChip(message);
  }
  if (message.thinking) {
    return renderThinkingBlock(message);
  }

  const mine = message.sender === MY_SENDER;
  const block = document.createElement("div");
  block.className = `msg-block ${mine ? "mine" : "theirs"}`;

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const overrideMark = message.modelOverride
    ? ` · ${message.modelOverride.split(":")[1] || message.modelOverride}`
    : "";
  const forgottenMark = message.forgotten ? " · forgotten" : "";
  meta.textContent = `${message.sender} · ${formatTime(message.ts)}${mine ? " · sent" : ""}${overrideMark}${forgottenMark}`;
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
      await api("PATCH", messageEndpoint(message.id), { text });
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
  body.className = (mine ? "msg-bubble mine" : "msg-plain") + (message.forgotten ? " msg-forgotten" : "");
  body.innerHTML = renderMarkdown(message.text);
  renderAttachments(body, message.attachments);
  block.appendChild(body);
  attachLongPress(body, message, mine, isLast);
  return block;
}

// Issues.md: "Sending files, images or voice does not work". Images
// render inline; everything else is a download link — `<a download>`
// rather than opening in a new tab avoids navigating the whole PWA away
// from the chat for, say, a PDF.
function renderAttachments(container, attachments) {
  if (!attachments || attachments.length === 0) return;
  const wrap = document.createElement("div");
  wrap.className = "msg-attachments";
  for (const att of attachments) {
    if (att.mimeType && att.mimeType.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = `/attachments/${att.id}`;
      img.alt = att.filename;
      img.className = "msg-attachment-image";
      wrap.appendChild(img);
    } else {
      const link = document.createElement("a");
      link.href = `/attachments/${att.id}`;
      link.download = att.filename;
      link.className = "msg-attachment-file";
      link.textContent = `📎 ${att.filename}`;
      wrap.appendChild(link);
    }
  }
  container.appendChild(wrap);
}

// --- Long-press message menu (Edvard's 2026-07-20 pattern, kept) -------------
const LONG_PRESS_MS = 2000;
const LONG_PRESS_MOVE_TOLERANCE = 10;
let longPressTimer = null;
let longPressStartPos = null;

function attachLongPress(el, message, mine, isLast) {
  const start = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
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
  el.addEventListener("contextmenu", (event) => event.preventDefault());
}

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
  msgSheetForgetLabel.textContent = message.forgotten
    ? "Unforget (show to persona again)"
    : "Forget (hide from persona)";
  msgActionSheetScrim.hidden = false;
  positionFloatingSheet(msgActionSheet, anchorEl.getBoundingClientRect());
}
function closeMessageActionSheet() {
  msgActionSheetScrim.hidden = true;
  messageActionTarget = null;
}
msgActionSheetScrim.addEventListener("click", (e) => {
  if (e.target === msgActionSheetScrim) closeMessageActionSheet();
});

msgSheetCopy.addEventListener("click", async () => {
  const message = messageActionTarget;
  closeMessageActionSheet();
  if (!message) return;
  try {
    await navigator.clipboard.writeText(message.text);
    setStatus("Copied.");
  } catch {
    // clipboard unavailable — no-op
  }
});

msgSheetSpeak.addEventListener("click", () => {
  const message = messageActionTarget;
  closeMessageActionSheet();
  if (!message || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(message.text));
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
  await api("DELETE", messageEndpoint(message.id));
  renderedKey = "";
  fetchMessages();
});

msgSheetFork.addEventListener("click", async () => {
  const message = messageActionTarget;
  closeMessageActionSheet();
  if (!message || !currentConversationId) return;
  const { ok, data } = await api("POST", `/conversations/${currentConversationId}/fork`, {
    atMessageId: message.id,
  });
  if (!ok) {
    setStatus("Fork failed.");
    return;
  }
  await loadConversationList();
  await switchConversation(data.conversation.id);
  setStatus(`Forked into "${data.conversation.name}".`, 3500);
});

msgSheetForget.addEventListener("click", async () => {
  const message = messageActionTarget;
  closeMessageActionSheet();
  if (!message) return;
  await api("POST", `${messageEndpoint(message.id)}/forget`, { forgotten: !message.forgotten });
  renderedKey = "";
  fetchMessages();
});

msgSheetDelete.addEventListener("click", async () => {
  const message = messageActionTarget;
  closeMessageActionSheet();
  if (!message) return;
  await api("DELETE", messageEndpoint(message.id));
  renderedKey = "";
  fetchMessages();
});

// --- Waiting notice -----------------------------------------------------------
// Replaced the "No reply yet" + model-picker + Retry banner on 2026-08-20.
// Edvard, capture: *"Remove the agora 'no reply yet?' And then gives you an
// option to choose a different model when a message takes a long time to
// respond. I would rather have actual good feedback on why the agents has not
// responded (yet) or if something went wrong."*
//
// Two things were wrong with the old banner, and the second is the one that
// mattered. It inferred a fault from 45 seconds of silence, and then offered a
// *model swap* as the remedy for a cause it had never established. The remedy
// was also destructive: Retry DELETEd his message and re-POSTed it, so a turn
// that was merely slow lost the original and restarted on a different model.
//
// What replaces it is measured off this conversation's own history rather than
// guessed. Note where the guessing actually was: the runner posts `system`
// (the ⚠️ backoff notice, carrying the real exception text), `activity` (tool
// use) and `thinking` messages, and every one of those is a real message that
// lands at the end of the thread -- so it suppresses this notice by simply not
// being Edvard's message. This code therefore only ever runs in the one case
// where *nothing at all* has come back, and the honest thing to say about that
// case is what it does and does not know. It cannot tell a slow model from a
// dead runner, and it now says so instead of blaming the model.
//
// `slowestPriorReply` is what turns "waited 3m" into information: a Nova cycle
// thread's own past turns took tens of minutes, so 3m there is normal and 3m
// in a quick chat is not. Same number, opposite meaning, and only this
// conversation's history can tell them apart.

/** `ms` as a short human duration -- "45s", "3m 20s", "1h 4m". */
function formatWaited(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) {
    const seconds = total % 60;
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** How long the slowest previous turn in this thread took to produce its
 * first sign of life, in ms, or `null` if nothing has ever answered here.
 *
 * "First sign of life" is deliberately the same event that hides this notice
 * -- any non-system message from someone other than Edvard, including a
 * thinking chunk or a tool chip. Measuring the wait against a *final* answer
 * would compare two different quantities and overstate what is normal. */
function slowestPriorReply(messages) {
  let slowest = null;
  let askedAt = null;
  for (const message of messages) {
    if (message.forgotten) continue;
    if (message.sender === MY_SENDER) {
      askedAt = new Date(message.ts).getTime();
      continue;
    }
    // A ⚠️ control-plane notice is not the conversation answering, and
    // counting it would make a failing thread look fast.
    if (askedAt === null || message.system) continue;
    const took = new Date(message.ts).getTime() - askedAt;
    askedAt = null;
    if (Number.isFinite(took) && took >= 0 && (slowest === null || took > slowest)) slowest = took;
  }
  return slowest;
}

/** `{ kind, lines }` describing why nothing has replied, or `null` when the
 * thread is not waiting on anything. Pure, so the copy is testable without
 * touching the DOM. */
function describeWait(messages, nowMs) {
  const visible = messages.filter((m) => !m.forgotten);
  const last = visible[visible.length - 1];
  if (!last || last.sender !== MY_SENDER) return null;

  const waitedMs = nowMs - new Date(last.ts).getTime();
  if (!Number.isFinite(waitedMs)) return null;
  if (waitedMs < WAIT_NOTICE_MS) return { kind: "waiting", lines: ["Waiting for a reply…"] };

  const lines = [`No reply yet — waited ${formatWaited(waitedMs)}.`];

  // The turn before this one failed and said why. Edvard's new message has
  // already cleared the runner's backoff (conversations.py pops it when the
  // last message id changes), so this is context for the silence rather than
  // the current state -- and it is worth having, because a thread that just
  // failed three times is the one case where continued silence is a bad sign.
  const priorSystem = visible.slice(0, -1).reverse().find((m) => m.system);
  const previous = visible[visible.length - 2];
  if (priorSystem && previous && priorSystem.id === previous.id) {
    lines.push(`The previous turn reported: ${priorSystem.text}`);
  }

  const slowest = slowestPriorReply(visible);
  if (slowest === null) {
    lines.push("Nothing has ever replied in this conversation, so there is no normal wait to compare against.");
  } else if (waitedMs <= slowest) {
    lines.push(`That is still within normal for this conversation — the slowest previous reply here took ${formatWaited(slowest)}.`);
  } else {
    lines.push(`That is longer than any previous reply here, the slowest of which took ${formatWaited(slowest)}.`);
  }

  lines.push("Nothing has come back yet: no answer, no thinking, no tool activity and no error. From here that looks the same whether the model is slow or the runner is down.");
  return { kind: "stalled", lines };
}

let trailingStatusEl = null;
function updateWaitingNotice(messages) {
  if (trailingStatusEl) {
    trailingStatusEl.remove();
    trailingStatusEl = null;
  }
  // A paused conversation has its own persistent banner (#paused-banner), so
  // saying it twice would just be noise.
  if (!messages.length || currentDetail?.status === "paused") return;

  const wait = describeWait(messages, Date.now());
  if (!wait) return;

  const el = document.createElement("div");
  if (wait.kind === "waiting") {
    el.className = "typing-indicator";
    el.textContent = wait.lines[0];
  } else {
    el.className = "wait-notice";
    for (const line of wait.lines) {
      const p = document.createElement("p");
      p.textContent = line;
      el.appendChild(p);
    }
  }
  messagesEl.appendChild(el);
  trailingStatusEl = el;
}

// --- @mention autocomplete ----------------------------------------------------
function updateMentionBar() {
  const personas = currentDetail?.personas || [];
  if (personas.length < 2) {
    mentionBar.hidden = true;
    return;
  }
  const caret = replyInput.selectionStart ?? replyInput.value.length;
  const upToCaret = replyInput.value.slice(0, caret);
  const match = upToCaret.match(/@([\w-]*)$/);
  if (!match) {
    mentionBar.hidden = true;
    return;
  }
  const partial = match[1].toLowerCase();
  const candidates = personas.filter((p) => p.name.toLowerCase().startsWith(partial));
  mentionBar.innerHTML = "";
  for (const candidate of candidates) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "mention-chip";
    chip.textContent = `@${candidate.name}`;
    chip.addEventListener("click", () => {
      const before = upToCaret.slice(0, -1 - partial.length);
      replyInput.value = `${before}@${candidate.name} ${replyInput.value.slice(caret)}`;
      mentionBar.hidden = true;
      replyInput.focus();
    });
    mentionBar.appendChild(chip);
  }
  mentionBar.hidden = candidates.length === 0;
}
replyInput.addEventListener("input", updateMentionBar);
replyInput.addEventListener("click", updateMentionBar);

// --- Voice input (Web Speech API — feature-detected, Chrome/Android has it) ---
const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
if (!SpeechRecognitionImpl) {
  micButton.hidden = true;
} else {
  micButton.addEventListener("click", () => {
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new SpeechRecognitionImpl();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;
    micButton.classList.add("recording");
    recognition.addEventListener("result", (event) => {
      const transcript = [...event.results].map((r) => r[0].transcript).join(" ");
      replyInput.value = (replyInput.value ? replyInput.value + " " : "") + transcript;
      autoGrow();
    });
    const done = () => {
      micButton.classList.remove("recording");
      recognition = null;
    };
    recognition.addEventListener("end", done);
    recognition.addEventListener("error", done);
    recognition.start();
  });
}

// --- Attach stub (upload pipeline is explicitly not built yet) ----------------
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
  attachFileInput.value = "";
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
    remove.addEventListener("click", () => {
      stagedFiles.splice(index, 1);
      renderAttachChips();
    });
    chip.append(name, remove);
    attachChipRow.appendChild(chip);
  });
}

// --- Composer ------------------------------------------------------------------
function autoGrow() {
  replyInput.style.height = "auto";
  replyInput.style.height = `${replyInput.scrollHeight}px`;
}
replyInput.addEventListener("input", autoGrow);
// Touch devices have no reliable way to type Shift+Enter, so treating any
// unmodified Enter as "submit" makes multi-line composition impossible —
// the very first Enter press sends whatever's typed so far (Issues.md:
// "impossible to write multiline input"). Re-checked per keystroke (not
// cached) so a hybrid device that gains/loses a physical keyboard/mouse
// mid-session still gets the right behavior. Touch devices always get a
// newline on Enter; sending happens via the visible send button instead.
function isCoarsePointer() {
  return Boolean(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
}
replyInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || isCoarsePointer()) return;
  event.preventDefault();
  replyForm.requestSubmit();
});

async function uploadAttachment(file) {
  const formData = new FormData();
  formData.append("file", file, file.name);
  try {
    const res = await fetch("/attachments", { method: "POST", body: formData });
    if (!res.ok) return null;
    const data = await res.json();
    return data.attachment?.id || null;
  } catch {
    return null;
  }
}

replyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = replyInput.value.trim();
  if ((!text && stagedFiles.length === 0) || !currentConversationId) return;
  const filesToUpload = stagedFiles;
  replyInput.value = "";
  autoGrow();
  mentionBar.hidden = true;
  stagedFiles = [];
  renderAttachChips();
  replyInput.disabled = true;
  try {
    const uploadedIds = (await Promise.all(filesToUpload.map(uploadAttachment))).filter(Boolean);
    if (uploadedIds.length < filesToUpload.length) {
      setStatus("Some attachments failed to upload — the rest of the message still sent.", 4000);
    }
    await api("POST", replyEndpoint(), {
      text,
      ...(uploadedIds.length > 0 ? { attachmentIds: uploadedIds } : {}),
    });
  } finally {
    replyInput.disabled = false;
    replyInput.focus();
  }
  renderedKey = "";
  fetchMessages();
});

// --- Push ----------------------------------------------------------------------
async function subscribeToPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    setStatus("Push not supported here — chat still works.", 4000);
    return;
  }
  const registration = await navigator.serviceWorker.register("/sw.js");
  navigator.serviceWorker.addEventListener("message", async (event) => {
    if (!event.data || event.data.type !== "agora-push") return;
    if (event.data.conversationId && event.data.conversationId !== currentConversationId) {
      currentConversationId = event.data.conversationId;
      renderedKey = "";
      await loadConversationList();
    }
    fetchMessages();
  });
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    setStatus("Notifications off — chat still works here.", 4000);
    return;
  }
  const keyRes = await fetch("/vapid-public-key");
  if (!keyRes.ok) return;
  const { publicKey } = await keyRes.json();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await fetch("/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
}

// --- Boot ----------------------------------------------------------------------
function autoSelectConversation() {
  if (currentConversationId) return;
  const first = allConversations.find((c) => !c.archived);
  if (first) currentConversationId = first.id;
}

async function boot() {
  await Promise.all([loadModelCatalog(), loadConversationList(), loadPersonas()]);
  autoSelectConversation();
  await fetchMessages();
  renderDrawerList();
  setInterval(fetchMessages, POLL_INTERVAL_MS);
  setInterval(refreshConversationList, LIST_POLL_INTERVAL_MS);
  subscribeToPush();
}
boot();
