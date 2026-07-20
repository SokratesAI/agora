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

const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");
const replyForm = document.getElementById("reply-form");
const replyInput = document.getElementById("reply-text");
const conversationSelect = document.getElementById("conversation-select");
const newChatToggle = document.getElementById("new-chat-toggle");
const newChatForm = document.getElementById("new-chat-form");
const newChatName = document.getElementById("new-chat-name");
const newChatPersonality = document.getElementById("new-chat-personality");
const newChatStatus = document.getElementById("new-chat-status");
const newChatCancel = document.getElementById("new-chat-cancel");
const newChatModel = document.getElementById("new-chat-model");
const newChatThinkingRow = document.getElementById("new-chat-thinking-row");
const newChatThinking = document.getElementById("new-chat-thinking");

// null = the original global thread ("Main" in the switcher). A string id
// means a conversation created via POST /conversations. Seeded from the
// URL so a cold-opened notification (no window was already running) lands
// on the right conversation instead of defaulting to Main — see sw.js's
// notificationclick, which builds this URL.
let currentConversationId = new URLSearchParams(location.search).get("conversation") || null;
let renderedKey = "";
// Keyed by model id ("<provider>:<model>") -> full ModelOption, so the
// thinking checkbox can be shown/hidden based on the selected model
// without a second round trip to the server.
let modelCatalogById = new Map();

function messagesEndpoint() {
  return currentConversationId ? `/conversations/${currentConversationId}/messages` : "/messages";
}

function replyEndpoint() {
  return currentConversationId ? `/conversations/${currentConversationId}/reply` : "/reply";
}

function setStatus(text) {
  statusEl.textContent = text;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderMessages(messages) {
  const key = `${currentConversationId ?? "main"}:${messages.map((m) => m.id).join(",")}`;
  if (key === renderedKey) return;
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
    for (const message of messages) {
      const bubble = document.createElement("div");
      bubble.className = `bubble ${message.sender === MY_SENDER ? "mine" : "theirs"}`;

      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `${message.sender} · ${formatTime(message.ts)}`;

      const body = document.createElement("span");
      body.textContent = message.text;

      bubble.append(meta, body);
      messagesEl.appendChild(bubble);
    }
  }

  if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function fetchMessages() {
  try {
    const res = await fetch(messagesEndpoint());
    if (!res.ok) return;
    const { messages } = await res.json();
    renderMessages(messages);
  } catch {
    // transient network hiccup — the next poll retries
  }
}

async function loadConversationList() {
  try {
    const res = await fetch("/conversations");
    if (!res.ok) return;
    const { conversations } = await res.json();
    conversationSelect.innerHTML = "";
    const mainOption = document.createElement("option");
    mainOption.value = "";
    mainOption.textContent = "Main";
    conversationSelect.appendChild(mainOption);
    for (const conversation of conversations) {
      const option = document.createElement("option");
      option.value = conversation.id;
      option.textContent = conversation.name;
      conversationSelect.appendChild(option);
    }
    conversationSelect.value = currentConversationId ?? "";
  } catch {
    // transient network hiccup — leave the switcher as-is
  }
}

async function loadModelCatalog() {
  try {
    const res = await fetch("/models");
    if (!res.ok) return;
    const { models } = await res.json();
    modelCatalogById = new Map(models.map((model) => [model.id, model]));

    newChatModel.innerHTML = "";
    const groups = new Map();
    for (const model of models) {
      if (!groups.has(model.provider)) {
        const group = document.createElement("optgroup");
        group.label = model.provider === "anthropic" ? "Anthropic" : "Gemini";
        groups.set(model.provider, group);
        newChatModel.appendChild(group);
      }
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label;
      groups.get(model.provider).appendChild(option);
    }
    updateThinkingVisibility();
  } catch {
    // transient network hiccup — new-chat form just won't have model options yet
  }
}

function updateThinkingVisibility() {
  const model = modelCatalogById.get(newChatModel.value);
  const supportsThinking = Boolean(model && model.supportsThinking);
  newChatThinkingRow.hidden = !supportsThinking;
  if (!supportsThinking) newChatThinking.checked = false;
}

newChatModel.addEventListener("change", updateThinkingVisibility);

conversationSelect.addEventListener("change", () => {
  currentConversationId = conversationSelect.value || null;
  renderedKey = "";
  fetchMessages();
});

newChatToggle.addEventListener("click", () => {
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
    renderedKey = "";
    fetchMessages();
  } catch {
    newChatStatus.textContent = "Failed to create.";
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
  replyInput.value = "";
  replyInput.disabled = true;
  try {
    await fetch(replyEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } finally {
    replyInput.disabled = false;
    replyInput.focus();
  }
  fetchMessages();
});

fetchMessages();
loadConversationList();
loadModelCatalog();
setInterval(fetchMessages, POLL_INTERVAL_MS);
subscribeToPush();
