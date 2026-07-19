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

// null = the original global thread ("Main" in the switcher). A string id
// means a conversation created via POST /conversations.
let currentConversationId = null;
let renderedKey = "";

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

  newChatStatus.textContent = "Creating...";
  try {
    const res = await fetch("/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, personality }),
    });
    if (!res.ok) {
      newChatStatus.textContent = "Failed to create.";
      return;
    }
    const { conversation } = await res.json();
    newChatName.value = "";
    newChatPersonality.value = "";
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

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data && event.data.type === "agora-push") fetchMessages();
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
setInterval(fetchMessages, POLL_INTERVAL_MS);
subscribeToPush();
