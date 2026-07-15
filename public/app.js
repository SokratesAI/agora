function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

const statusEl = document.getElementById("status");
const replyForm = document.getElementById("reply-form");
const replyInput = document.getElementById("reply-text");
const replyStatus = document.getElementById("reply-status");

function setStatus(text) {
  statusEl.textContent = text;
}

async function subscribeToPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    setStatus("This browser doesn't support push notifications.");
    return;
  }

  const registration = await navigator.serviceWorker.register("/sw.js");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    setStatus("Notification permission not granted — nothing else will work until this is allowed.");
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

  setStatus(res.ok ? "Subscribed. You'll get notifications here." : "Failed to register subscription with the server.");
}

replyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = replyInput.value.trim();
  if (!text) return;
  const res = await fetch("/reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  replyStatus.textContent = res.ok ? "Sent." : "Failed to send.";
  if (res.ok) replyInput.value = "";
});

setStatus("Setting up...");
subscribeToPush();
